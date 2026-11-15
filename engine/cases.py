"""Case state machine (SPEC section 5): detect -> act -> watch -> resolved | escalated (+ dismissed).

case_reduce is a pure reducer: it never mutates its inputs and never raises for a bad event.
An invalid event is atomic: it returns the input state unchanged plus exactly one log entry whose
`error` is set (a TICK rejected for a unit mismatch keeps none of the observations that came
before the bad one). A malformed *state* (not produced by new_case / case_reduce) is a contract
violation and raises invalid_argument.

Required steps: a procedure step marked "required" (a red-flag question, a shelter confirmation)
must be done or explicitly declined with a reason (event DECLINE) before OUTCOME is accepted;
otherwise OUTCOME is rejected with required_steps_pending. A required step that takes an input
needs its value. A "red_flag" step is a required yes/no question: a "yes" escalates the case at
once.

Escalation has two tiers (state.escalation.tiers): tier 1, the onboard Crew Medical Officer, now;
tier 2, the flight surgeon on the ground, through the ground packet. new_case(..., escalation) reads
the tiers from rules/meta.json `escalation`: when the patient holds tier 1's role (the Crew Medical
Officer is the crewmember of the case), tier 1 is that tier's backup (the Commander), recorded in
spec.escalation_tiers. The reducer does not know the
link: the packet is Queued at escalation (state.packet_queued_at) and leaves with the next link,
at once when the link is up (AOS), when it resumes during loss of signal or conjunction
(comms_eta). A step marked "releases_packet" queues the packet too (crew release); before that the
packet of an open case is Prepared (held on board).

Tripwire timing: observations are collected throughout watch, but the tripwire is only judged at
t >= reassess_at, matching the case texts ("Reassess at T+72 h; if ... still ..., escalate").
Observations with crew_id null (vehicle / habitat sensors, e.g. the proton monitor) describe the
shared environment and count for every crewmember's case.

Environment: a tripwire condition may carry "by_env": {env_id: {overrides}}. new_case(..., env_id)
applies the override for that environment, so a case watches the rule that applies there (the
SPE case watches the Mars-orbit monitor rule at Mars and the NOAA rule near Earth).

Instances: one state follows one case for one crewmember through every episode. OPEN from idle
opens instance 1. Once an instance is closed (resolved, escalated or dismissed), a new OPEN opens
the next instance: the closed one is summarized in previous_instances, every per-instance field
is reset, and instance counts up. An open instance (detected, acting, watch) is never opened twice.
Re-open hysteresis: that OPEN carries clear_since, the MET from which every trigger of the case has
been below caution, and opens the next instance only when the triggers have been clear for at least
the case's reassess_after_s (trigger_not_clear otherwise). A condition that persists through an
escalation therefore keeps the escalated instance as the case's current one, and a flapping reading
does not open a new episode. When the timeline sends that OPEN, and how it measures clear_since, is
SPEC section 7's rule.

State (JSON):
    {"schema": "landfall.case_state/1", "case_id", "crew_id", "status",
     "spec": {..., "escalation_tiers": [{tier, id, crew_id, instead_of, text}]},
     "instance": 1.., "previous_instances": [{instance, status, opened_at, closed_at, finding,
     outcome, escalation, packet_queued_at, dismiss_reason}],
     "opened_at", "finding", "countermeasure_id", "steps_done": [{step_id, t, input}],
     "steps_declined": [{step_id, t, reason}], "outcome": {text, t} | null, "watch_started_at",
     "reassess_at", "tripwire_obs": [{t, value}] (sorted by t), "tripwire_result": {...} | null,
     "escalation": {t, reason, step_id, tiers} | null, "packet_queued_at": MET | null,
     "closed_at", "dismiss_reason", "updated_at", "log": [{t, event, from, to, detail, error}]}
"""

from __future__ import annotations

import copy

from .errors import EngineError
from .fmt import fmt_num, format_met, is_number
from .thresholds import OP_SYMBOL, compare

STATES = ("idle", "detected", "acting", "watch", "resolved", "escalated", "dismissed")
OPEN_STATES = ("detected", "acting", "watch")
TERMINAL_STATES = ("resolved", "escalated", "dismissed")
EVENTS = ("OPEN", "SELECT", "STEP", "DECLINE", "OUTCOME", "TICK", "DISMISS")
OPENING_SEVERITIES = ("caution", "warning", "emergency")
# tier 1 is told now, onboard; tier 2 gets the ground packet with the next link
ESCALATION_TIERS = ("crew_medical_officer", "flight_surgeon")
# what the escalation detail calls each default tier (new_case without the meta.json escalation block)
DEFAULT_TIER_TEXT = {"crew_medical_officer": "the Crew Medical Officer", "flight_surgeon": "the flight surgeon"}
STEP_FLAGS = ("required", "red_flag", "releases_packet")
YES_NO_UNIT = "yes/no"
OP_WORDS = {"lt": "below", "le": "at or below", "gt": "above", "ge": "at or above"}
ESCALATED_TEXT = ("escalated: tier 1, the Crew Medical Officer, now; tier 2, the flight surgeon, "
                  "through the ground packet, queued and sent when a link exists")

REF_KEYS = ("rule_id", "indicator_id")
# the fields of one instance (episode); a new OPEN after a closed instance resets them to these values
INSTANCE_FIELDS = (("opened_at", None), ("finding", None), ("countermeasure_id", None), ("steps_done", []),
                   ("steps_declined", []), ("outcome", None), ("watch_started_at", None), ("reassess_at", None),
                   ("tripwire_obs", []), ("tripwire_result", None), ("escalation", None),
                   ("packet_queued_at", None), ("closed_at", None), ("dismiss_reason", None))
PREVIOUS_INSTANCE_KEYS = ("opened_at", "closed_at", "finding", "outcome", "escalation", "packet_queued_at",
                          "dismiss_reason")


def _effective_condition(cid: str, cond: dict, env_id: str | None) -> dict:
    """The tripwire condition for env_id: the base condition with its by_env[env_id] override applied.

    An override replaces the keys it names. When it names a rule_id or indicator_id, the base
    reference, variable and unit are dropped first, so they are resolved again for the new reference.
    """
    by_env = cond.get("by_env")
    if by_env is not None and not isinstance(by_env, dict):
        raise EngineError("invalid_case", f"case {cid}: tripwire condition by_env must be an object")
    base = {k: v for k, v in cond.items() if k != "by_env"}
    if env_id is None or not isinstance(by_env, dict) or env_id not in by_env:
        return base
    override = by_env[env_id]
    if not isinstance(override, dict) or "by_env" in override:
        raise EngineError("invalid_case", f"case {cid}: tripwire by_env[{env_id!r}] must be an object without by_env")
    if any(k in override for k in REF_KEYS):
        for k in REF_KEYS + ("variable", "unit"):
            base.pop(k, None)
    base.update(override)
    return base


def _procedure_spec(cid: str, procedure: list) -> dict:
    """step_ids plus the step metadata the reducer enforces (required, red flag, packet release, inputs)."""
    step_ids, required, red_flags, packet_steps, inputs = [], [], [], [], []
    for st in procedure:
        sid = st["id"]
        step_ids.append(sid)
        for flag in STEP_FLAGS:
            if flag in st and not isinstance(st[flag], bool):
                raise EngineError("invalid_case", f"case {cid}: step {sid!r} {flag} must be true or false")
        inp = st.get("input")
        if inp is not None:
            if not (isinstance(inp, dict) and isinstance(inp.get("variable"), str)
                    and isinstance(inp.get("unit"), str) and inp["unit"]):
                raise EngineError("invalid_case", f"case {cid}: step {sid!r} input needs a variable and a unit")
            inputs.append({"step_id": sid, "variable": inp["variable"], "unit": inp["unit"]})
        if st.get("red_flag") is True:
            if st.get("required") is not True or inp is None or inp["unit"] != YES_NO_UNIT:
                raise EngineError("invalid_case", f"case {cid}: red-flag step {sid!r} must be required "
                                                  "and take a yes/no input")
            red_flags.append(sid)
        if st.get("required") is True:
            required.append(sid)
        if st.get("releases_packet") is True:
            packet_steps.append(sid)
    return {"step_ids": step_ids, "required_step_ids": required, "red_flag_step_ids": red_flags,
            "packet_step_ids": packet_steps, "step_inputs": inputs}


def _default_tiers() -> list:
    return [{"tier": i + 1, "id": tid, "crew_id": None, "instead_of": None, "text": DEFAULT_TIER_TEXT[tid]}
            for i, tid in enumerate(ESCALATION_TIERS)]


def _escalation_tiers(cid: str, escalation: object, crew_id: str) -> list:
    """The two escalation tiers for this crewmember's case (SPEC section 5 new_case).

    escalation is rules/meta.json `escalation` (or None: the default tiers). Its `tiers` are tier 1 and
    tier 2, each {tier, id, name, crew_id?, backup?}; `crew_id` names the crewmember who holds the role
    (tier 1: the Crew Medical Officer). When the patient holds it and the tier has a `backup`
    ({id, name, crew_id}, another crewmember), that tier is the backup instead.
    """
    if escalation is None:
        return _default_tiers()

    def bad(why: str) -> EngineError:
        return EngineError("invalid_case", f"case {cid}: escalation {why}")

    tiers = escalation.get("tiers") if isinstance(escalation, dict) else None
    if not isinstance(tiers, list) or not all(isinstance(t, dict) for t in tiers):
        raise bad("must be an object whose tiers are a list of objects")
    nums = []
    for t in tiers:
        n = t.get("tier")
        if not (isinstance(n, int) and not isinstance(n, bool)):
            raise bad("tier numbers must be integers")
        nums.append(n)
    if sorted(nums) != [1, 2]:
        raise bad("needs exactly tier 1 and tier 2")
    out = []
    for t in sorted(tiers, key=lambda x: x["tier"]):
        if not (_nonempty_str(t.get("id")) and _nonempty_str(t.get("name"))):
            raise bad(f"tier {t['tier']} needs a non-empty id and name")
        holder = t.get("crew_id")
        if holder is not None and not _nonempty_str(holder):
            raise bad(f"tier {t['tier']} crew_id must be a non-empty string or null")
        backup = t.get("backup")
        if backup is not None:
            if not (isinstance(backup, dict) and _nonempty_str(backup.get("id"))
                    and _nonempty_str(backup.get("name")) and _nonempty_str(backup.get("crew_id"))):
                raise bad(f"tier {t['tier']} backup needs a non-empty id, name and crew_id")
            if holder is None or backup["crew_id"] == holder:
                raise bad(f"tier {t['tier']} backup needs a holder (crew_id) and must be another crewmember")
        if backup is not None and holder == crew_id:
            # the patient holds this role: the backup takes it (rules/meta.json escalation, design choice)
            out.append({"tier": t["tier"], "id": backup["id"], "crew_id": backup["crew_id"], "instead_of": t["id"],
                        "text": f"{backup['name']} (backup for {t['name']}, who is the patient)"})
        else:
            out.append({"tier": t["tier"], "id": t["id"], "crew_id": holder, "instead_of": None, "text": t["name"]})
    return out


def new_case(case_def: dict, crew_id: str, lookup: dict | None = None, env_id: str | None = None,
             escalation: dict | None = None) -> dict:
    """Build the pre-OPEN ("idle") state for one case and one crewmember.

    lookup maps a rule or indicator id -> {"variable", "unit"} (see loader.trigger_lookup). It
    resolves the tripwire variable when the condition names a rule_id, and the tripwire unit
    when the condition has none. An explicit condition "variable" / "unit" wins.
    env_id (optional) selects the tripwire condition's by_env override for that environment; the
    effective reference is recorded as spec.tripwire.condition.ref_id and the environment as
    spec.env_id. Procedure steps may carry "required", "red_flag" and "releases_packet" (booleans);
    a red-flag step must be required and take a yes/no input (SPEC 3.4). The state starts at instance 1
    with no previous_instances (a closed case opens again as the next instance: case_reduce OPEN).
    escalation (optional) is rules/meta.json `escalation`: spec.escalation_tiers then names tier 1 for
    this crewmember (the backup when the patient is the Crew Medical Officer); without it, the default
    tiers.
    """
    if not isinstance(case_def, dict) or not isinstance(case_def.get("id"), str):
        raise EngineError("invalid_case", "case definition must be an object with a string id")
    if not isinstance(crew_id, str) or not crew_id:
        raise EngineError("invalid_argument", "crew_id must be a non-empty string")
    if env_id is not None and (not isinstance(env_id, str) or not env_id):
        raise EngineError("invalid_argument", "env_id must be a non-empty string or null")
    cid = case_def["id"]
    trigger_ids = set()
    for trg in case_def.get("triggers") or []:
        tid = trg.get("rule_id") or trg.get("indicator_id")
        if not isinstance(tid, str):
            raise EngineError("invalid_case", f"case {cid}: trigger without rule_id/indicator_id")
        trigger_ids.add(tid)
    cm = case_def.get("countermeasure") or {}
    primary = cm.get("primary")
    if not isinstance(primary, dict) or not isinstance(primary.get("id"), str):
        raise EngineError("invalid_case", f"case {cid}: countermeasure.primary.id required")
    cm_ids = [primary["id"]] + [a["id"] for a in (cm.get("alternatives") or [])]
    proc = _procedure_spec(cid, case_def.get("procedure") or [])
    tw = case_def.get("tripwire")
    if not isinstance(tw, dict) or not is_number(tw.get("reassess_after_s")) or \
            not isinstance(tw.get("condition"), dict):
        raise EngineError("invalid_case", f"case {cid}: tripwire.reassess_after_s and condition required")
    cond = _effective_condition(cid, tw["condition"], env_id)
    ref_id = cond.get("indicator_id") or cond.get("rule_id")
    ref = (lookup or {}).get(ref_id) if isinstance(ref_id, str) else None
    ref = ref if isinstance(ref, dict) else {}
    var = cond.get("variable") or ref.get("variable") or cond.get("indicator_id")
    unit = cond.get("unit") or ref.get("unit")
    if not isinstance(var, str):
        raise EngineError("invalid_case", f"case {cid}: cannot resolve the tripwire variable")
    if not isinstance(unit, str) or not unit:
        # units are never assumed (SPEC section 4): without a unit the TICK unit check would be off
        raise EngineError("invalid_case", f"case {cid}: cannot resolve the tripwire unit "
                                          "(set condition.unit or pass lookup = trigger_lookup(rules))")
    if cond.get("op") not in OP_SYMBOL or not is_number(cond.get("value")):
        raise EngineError("invalid_case", f"case {cid}: tripwire op/value invalid")
    n, k = cond.get("of_last_n"), cond.get("at_least")
    if not (isinstance(n, int) and isinstance(k, int) and not isinstance(n, bool)
            and not isinstance(k, bool) and 1 <= k <= n):
        raise EngineError("invalid_case", f"case {cid}: need integers 1 <= at_least <= of_last_n")
    esc = case_def.get("escalation")
    tiers = _escalation_tiers(cid, escalation, crew_id)
    spec = {
        "case_id": cid,
        "env_id": env_id,
        "trigger_ids": sorted(trigger_ids),
        "countermeasure_ids": cm_ids,
        "step_ids": proc["step_ids"],
        "required_step_ids": proc["required_step_ids"],
        "red_flag_step_ids": proc["red_flag_step_ids"],
        "packet_step_ids": proc["packet_step_ids"],
        "step_inputs": proc["step_inputs"],
        "tripwire": {"reassess_after_s": tw["reassess_after_s"],
                     "condition": {"ref_id": ref_id if isinstance(ref_id, str) else None,
                                   "variable": var, "op": cond["op"], "value": cond["value"],
                                   "unit": unit, "of_last_n": n, "at_least": k}},
        "escalation": copy.deepcopy(esc) if isinstance(esc, dict) else None,
        "escalation_tiers": tiers,
    }
    return {
        "schema": "landfall.case_state/1", "case_id": cid, "crew_id": crew_id, "status": "idle",
        "spec": spec, "instance": 1, "previous_instances": [],
        "opened_at": None, "finding": None, "countermeasure_id": None,
        "steps_done": [], "steps_declined": [], "outcome": None, "watch_started_at": None,
        "reassess_at": None, "tripwire_obs": [], "tripwire_result": None, "escalation": None,
        "packet_queued_at": None, "closed_at": None, "dismiss_reason": None, "updated_at": None,
        "log": [],
    }


def _nonempty_str(x: object) -> bool:
    return isinstance(x, str) and x.strip() != ""


def _quantity(value: float, unit: str) -> str:
    """'1000 pfu', or a bare '4' for a count."""
    return fmt_num(value) if unit == "count" else f"{fmt_num(value)} {unit}"


def _tripwire_eval(s: dict) -> dict:
    cond = s["spec"]["tripwire"]["condition"]
    last = s["tripwire_obs"][-cond["of_last_n"]:]
    hits = 0
    for o in last:
        if compare(o["value"], cond["op"], cond["value"]):
            hits += 1
    return {"hits": hits, "considered": len(last), "of_last_n": cond["of_last_n"],
            "at_least": cond["at_least"], "tripped": hits >= cond["at_least"]}


def _validate_state(state: object) -> None:
    ok = (isinstance(state, dict) and state.get("status") in STATES and isinstance(state.get("spec"), dict)
          and isinstance(state.get("log"), list) and isinstance(state.get("crew_id"), str)
          and isinstance(state.get("tripwire_obs"), list) and isinstance(state.get("steps_done"), list))
    if ok:
        spec = state["spec"]
        inst = state.get("instance")
        ok = (isinstance(inst, int) and not isinstance(inst, bool) and inst >= 1
              and isinstance(state.get("previous_instances"), list)
              and isinstance(state.get("steps_declined"), list)
              and "escalation" in state and (state["escalation"] is None or isinstance(state["escalation"], dict))
              and "packet_queued_at" in state
              and (state["packet_queued_at"] is None or is_number(state["packet_queued_at"]))
              and isinstance(spec.get("required_step_ids"), list) and isinstance(spec.get("red_flag_step_ids"), list)
              and isinstance(spec.get("packet_step_ids"), list) and isinstance(spec.get("step_inputs"), list)
              and all(isinstance(x, dict) for x in spec["step_inputs"])
              and all(isinstance(d, dict) for d in state["steps_declined"]))
    if ok and "escalation_tiers" in spec:
        # absent in a state built before the tiers were recorded: the default tiers apply
        tiers = spec["escalation_tiers"]
        ok = (isinstance(tiers, list) and len(tiers) == 2
              and all(isinstance(t, dict) and _nonempty_str(t.get("id")) and _nonempty_str(t.get("text"))
                      for t in tiers))
    if not ok:
        raise EngineError("invalid_argument", "state must be a case state built by new_case / case_reduce")


def _tiers_of(spec: dict) -> list:
    """The escalation tiers of a state (spec.escalation_tiers, or the default tiers for an older state)."""
    return spec["escalation_tiers"] if "escalation_tiers" in spec else _default_tiers()


def _escalated_text(spec: dict) -> str:
    t1, t2 = _tiers_of(spec)
    return (f"escalated: tier 1, {t1['text']}, now; tier 2, {t2['text']}, "
            "through the ground packet, queued and sent when a link exists")


def _step_input(spec: dict, step_id: object) -> dict | None:
    for x in spec["step_inputs"]:
        if x.get("step_id") == step_id:
            return x
    return None


def _answer(unit: str, inp: object) -> tuple[bool, object]:
    """(ok, answer) for the value of a step input: a number, or a yes/no (bool or 0/1) for unit yes/no."""
    v = inp.get("value") if isinstance(inp, dict) else None
    if unit == YES_NO_UNIT:
        if v is True or v is False:
            return True, v
        if is_number(v) and v in (0, 1):
            return True, v == 1
        return False, None
    return is_number(v), v


def case_reduce(state: dict, event: dict) -> dict:
    _validate_state(state)
    s = copy.deepcopy(state)
    ev = event if isinstance(event, dict) else {}
    etype = ev.get("type")
    t = ev.get("t")
    frm = s.get("status")
    spec = s["spec"]

    def entry(to: str, detail: str, error: str | None) -> dict:
        return {"t": t, "event": etype, "from": frm, "to": to, "detail": detail, "error": error}

    def reject(error: str, detail: str) -> dict:
        # atomic: start again from the untouched input, so nothing this event did survives
        out = copy.deepcopy(state)
        out["log"].append(entry(frm, detail, error))
        return out

    def accept(to: str, detail: str) -> dict:
        s["status"] = to
        s["updated_at"] = t
        s["log"].append(entry(to, detail, None))
        return s

    def escalate(reason: str, step_id: object) -> None:
        s["escalation"] = {"t": t, "reason": reason, "step_id": step_id,
                           "tiers": [tier["id"] for tier in _tiers_of(spec)]}
        if s["packet_queued_at"] is None:
            s["packet_queued_at"] = t
        s["closed_at"] = t

    def done(step_id: object) -> bool:
        return any(d.get("step_id") == step_id for d in s["steps_done"])

    def declined(step_id: object) -> bool:
        return any(d.get("step_id") == step_id for d in s["steps_declined"])

    if etype not in EVENTS:
        return reject("invalid_event", f"unknown event type {etype!r}")
    if not is_number(t):
        return reject("invalid_event", "event t must be a finite number")
    if etype == "TICK" and frm != "watch":
        return s  # clock ticks outside watch are expected and change nothing: no log entry
    if s.get("updated_at") is not None and t < s["updated_at"]:
        return reject("time_reversed", f"t {fmt_num(t)} is before the last transition at {fmt_num(s['updated_at'])}")

    if etype == "OPEN":
        if frm != "idle" and frm not in TERMINAL_STATES:
            return reject("invalid_transition", f"OPEN is only valid from idle or a closed case, case is {frm}")
        f = ev.get("finding")
        if not isinstance(f, dict):
            return reject("invalid_event", "OPEN needs a finding object")
        if f.get("severity") not in OPENING_SEVERITIES:
            return reject("below_threshold", f"finding severity {f.get('severity')!r} is below caution")
        if spec["trigger_ids"] and f.get("rule_id") not in spec["trigger_ids"]:
            return reject("not_a_trigger", f"{f.get('rule_id')!r} is not a trigger of {s['case_id']}")
        opened = f"by {f.get('rule_id')} ({f.get('status')}, {f.get('severity')})"
        if frm == "idle":
            detail = f"opened {opened}"
        else:
            # re-open hysteresis (SPEC 7): a new episode needs the triggers below caution for at least
            # the case's reassessment time, from clear_since up to this OPEN
            cs = ev.get("clear_since")
            if not is_number(cs):
                return reject("invalid_event", "OPEN of a new instance needs clear_since, the MET from which "
                                               "every trigger of the case has been below caution")
            if cs > t:
                return reject("invalid_event", f"clear_since MET {format_met(cs)} is after the OPEN at MET "
                                               f"{format_met(t)}")
            if is_number(s.get("opened_at")) and cs < s["opened_at"]:
                return reject("invalid_event", f"clear_since MET {format_met(cs)} is before instance "
                                               f"{s['instance']} opened at MET {format_met(s['opened_at'])}, "
                                               "when its trigger was at caution or above")
            need = spec["tripwire"]["reassess_after_s"]
            if t - cs < need:
                return reject("trigger_not_clear", f"triggers below caution for {format_met(t - cs)} since MET "
                                                   f"{format_met(cs)}; a new instance needs {format_met(need)} "
                                                   f"(the case's reassessment time), so instance "
                                                   f"{s['instance']} stays {frm}")
            # a new instance (episode) of a closed case: summarize the closed one, reset the per-instance fields
            prev = {"instance": s["instance"], "status": frm}
            for key in PREVIOUS_INSTANCE_KEYS:
                prev[key] = copy.deepcopy(s.get(key))
            s["previous_instances"].append(prev)
            for key, empty in INSTANCE_FIELDS:
                s[key] = copy.deepcopy(empty)
            s["instance"] = prev["instance"] + 1
            when = f" at MET {format_met(prev['closed_at'])}" if is_number(prev["closed_at"]) else ""
            detail = (f"opened again {opened}: instance {s['instance']}; instance {prev['instance']} "
                      f"was {frm}{when}; triggers below caution from MET {format_met(cs)}")
        s["opened_at"] = t
        s["finding"] = copy.deepcopy(f)
        return accept("detected", detail)

    if etype == "DISMISS":
        if frm not in OPEN_STATES:
            return reject("invalid_transition", f"DISMISS is only valid from an open case, case is {frm}")
        reason = ev.get("reason")
        if not _nonempty_str(reason):
            return reject("invalid_event", "DISMISS needs a non-empty reason")
        s["dismiss_reason"] = reason
        s["closed_at"] = t
        return accept("dismissed", f"dismissed: {reason}")

    if etype == "SELECT":
        if frm != "detected":
            return reject("invalid_transition", f"SELECT is only valid from detected, case is {frm}")
        cm_id = ev.get("countermeasure_id")
        if cm_id not in spec["countermeasure_ids"]:
            return reject("unknown_countermeasure", f"{cm_id!r} is not a countermeasure of {s['case_id']}")
        s["countermeasure_id"] = cm_id
        primary = cm_id == spec["countermeasure_ids"][0]
        return accept("acting", f"selected {cm_id} ({'primary' if primary else 'alternative'})")

    if etype == "STEP":
        if frm != "acting":
            return reject("invalid_transition", f"STEP is only valid from acting, case is {frm}")
        step_id = ev.get("step_id")
        if step_id not in spec["step_ids"]:
            return reject("unknown_step", f"{step_id!r} is not a step of {s['case_id']}")
        if done(step_id):
            return reject("duplicate_step", f"step {step_id} already done")
        inp = ev.get("input")
        decl = _step_input(spec, step_id)
        if decl is not None and isinstance(inp, dict) and "unit" in inp and inp["unit"] != decl["unit"]:
            return reject("unit_mismatch", f"step {step_id} expects {decl['unit']!r}, input has {inp['unit']!r}")
        red = step_id in spec["red_flag_step_ids"]
        answer = None
        if red:
            ok, answer = _answer(YES_NO_UNIT, inp)
            if not ok:
                return reject("invalid_event", f"step {step_id} is a red-flag question: answer yes or no")
        elif decl is not None and step_id in spec["required_step_ids"]:
            ok, _ = _answer(decl["unit"], inp)
            if not ok:
                return reject("invalid_event", f"step {step_id} is required and needs its value: "
                                               f"{decl['variable']} ({decl['unit']})")
        s["steps_done"].append({"step_id": step_id, "t": t, "input": copy.deepcopy(inp)})
        if red and answer:
            escalate("red_flag", step_id)
            return accept("escalated", f"step {step_id} answered yes, a red flag; {_escalated_text(spec)}")
        note = ", answered no" if red else ""
        if step_id in spec["packet_step_ids"] and s["packet_queued_at"] is None:
            s["packet_queued_at"] = t
            note += "; ground packet queued, sent when a link exists"
        return accept("acting", f"step {step_id} done{note} ({len(s['steps_done'])} of {len(spec['step_ids'])})")

    if etype == "DECLINE":
        if frm != "acting":
            return reject("invalid_transition", f"DECLINE is only valid from acting, case is {frm}")
        step_id = ev.get("step_id")
        if step_id not in spec["step_ids"]:
            return reject("unknown_step", f"{step_id!r} is not a step of {s['case_id']}")
        if done(step_id) or declined(step_id):
            return reject("duplicate_step", f"step {step_id} already done or declined")
        reason = ev.get("reason")
        if not _nonempty_str(reason):
            return reject("invalid_event", "DECLINE needs a non-empty reason")
        s["steps_declined"].append({"step_id": step_id, "t": t, "reason": reason})
        req = " (required)" if step_id in spec["required_step_ids"] else ""
        return accept("acting", f"step {step_id}{req} declined: {reason}")

    if etype == "OUTCOME":
        if frm != "acting":
            return reject("invalid_transition", f"OUTCOME is only valid from acting, case is {frm}")
        pending = [sid for sid in spec["required_step_ids"] if not done(sid) and not declined(sid)]
        if pending:
            return reject("required_steps_pending", "required step(s) neither done nor declined with a reason: "
                                                    + ", ".join(str(p) for p in pending))
        text = ev.get("text")
        if not _nonempty_str(text):
            return reject("invalid_event", "OUTCOME needs a non-empty text")
        s["outcome"] = {"text": text, "t": t}
        s["watch_started_at"] = t
        s["reassess_at"] = t + spec["tripwire"]["reassess_after_s"]
        n_declined = len(s["steps_declined"])
        dec = f", {n_declined} declined" if n_declined else ""
        return accept("watch", f"outcome recorded; reassess at MET {format_met(s['reassess_at'])} "
                               f"({len(s['steps_done'])} of {len(spec['step_ids'])} steps done{dec})")

    # TICK in watch
    cond = spec["tripwire"]["condition"]
    obs_list = ev.get("observations") or []
    if not isinstance(obs_list, list):
        return reject("invalid_event", "TICK observations must be a list")
    known_t = {o["t"] for o in s["tripwire_obs"]}
    new_obs = []
    for o in obs_list:
        if not isinstance(o, dict) or o.get("variable") != cond["variable"]:
            continue
        if o.get("crew_id") is not None and o.get("crew_id") != s["crew_id"]:
            continue  # another crewmember's data; crew_id null = vehicle sensor, shared by all
        ot, ov = o.get("t"), o.get("value")
        if not (is_number(ot) and is_number(ov)):
            continue
        if not (s["watch_started_at"] < ot <= t):
            continue
        if cond["unit"] is not None and o.get("unit") != cond["unit"]:
            return reject("unit_mismatch",
                          f"tripwire expects {cond['unit']!r}, observation has {o.get('unit')!r}")
        if ot in known_t:
            continue
        known_t.add(ot)
        new_obs.append({"t": ot, "value": ov})
    added = len(new_obs)  # committed only now that every observation of this TICK passed the unit check
    s["tripwire_obs"].extend(new_obs)
    s["tripwire_obs"].sort(key=lambda o: o["t"])
    ev_res = _tripwire_eval(s)
    desc = (f"{ev_res['hits']} of the last {ev_res['considered']} readings {OP_WORDS[cond['op']]} "
            f"{_quantity(cond['value'], cond['unit'])} (escalates at {cond['at_least']} of {cond['of_last_n']})")
    if t >= s["reassess_at"]:
        if ev_res["tripped"]:
            s["tripwire_result"] = ev_res
            escalate("tripwire", None)
            return accept("escalated", f"reassessed: {desc}; {_escalated_text(spec)}")
        remaining = cond["of_last_n"] - ev_res["considered"]
        if ev_res["hits"] + remaining < cond["at_least"]:
            s["tripwire_result"] = ev_res
            s["closed_at"] = t
            return accept("resolved", f"reassessed: {desc}")
        if added:
            return accept("watch", f"reassessment due, need more readings: {desc}")
        return s
    if added:
        return accept("watch", f"{added} new reading(s): {desc}; judged at reassessment "
                               f"(MET {format_met(s['reassess_at'])})")
    return s
