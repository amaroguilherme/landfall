"""Case state machine (SPEC section 5): detect -> act -> watch -> resolved | escalated (+ dismissed).

case_reduce is a pure reducer: it never mutates its inputs and never raises for a bad event.
An invalid event returns the same status plus a log entry whose `error` is set. A malformed
*state* (not produced by new_case / case_reduce) is a contract violation and raises
invalid_argument.

Tripwire timing: observations are collected throughout watch, but the tripwire is only judged at
t >= reassess_at, matching the case texts ("Reassess at T+72 h; if ... still ..., reclassify").
Observations with crew_id null (vehicle / habitat sensors, e.g. the onboard proton monitor)
describe the shared environment and count for every crewmember's case.

State (JSON):
    {"schema": "landfall.case_state/1", "case_id", "crew_id", "status", "spec": {...},
     "opened_at", "finding", "countermeasure_id", "steps_done": [{step_id, t, input}],
     "outcome": {text, t} | null, "watch_started_at", "reassess_at",
     "tripwire_obs": [{t, value}] (sorted by t), "tripwire_result": {...} | null,
     "closed_at", "dismiss_reason", "updated_at", "log": [{t, event, from, to, detail, error}]}
"""

from __future__ import annotations

import copy

from .errors import EngineError
from .fmt import fmt_num, is_number
from .thresholds import OP_SYMBOL, compare

STATES = ("idle", "detected", "acting", "watch", "resolved", "escalated", "dismissed")
OPEN_STATES = ("detected", "acting", "watch")
TERMINAL_STATES = ("resolved", "escalated", "dismissed")
EVENTS = ("OPEN", "SELECT", "STEP", "OUTCOME", "TICK", "DISMISS")
OPENING_SEVERITIES = ("caution", "warning", "emergency")


def new_case(case_def: dict, crew_id: str, lookup: dict | None = None) -> dict:
    """Build the pre-OPEN ("idle") state for one case and one crewmember.

    lookup maps a rule or indicator id -> {"variable", "unit"} (see loader.trigger_lookup). It
    resolves the tripwire variable when the condition names a rule_id, and the tripwire unit
    when the condition has none. An explicit condition "variable" / "unit" wins.
    """
    if not isinstance(case_def, dict) or not isinstance(case_def.get("id"), str):
        raise EngineError("invalid_case", "case definition must be an object with a string id")
    if not isinstance(crew_id, str) or not crew_id:
        raise EngineError("invalid_argument", "crew_id must be a non-empty string")
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
    step_ids = [s["id"] for s in (case_def.get("procedure") or [])]
    tw = case_def.get("tripwire")
    if not isinstance(tw, dict) or not is_number(tw.get("reassess_after_s")) or \
            not isinstance(tw.get("condition"), dict):
        raise EngineError("invalid_case", f"case {cid}: tripwire.reassess_after_s and condition required")
    cond = tw["condition"]
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
    spec = {
        "case_id": cid,
        "trigger_ids": sorted(trigger_ids),
        "countermeasure_ids": cm_ids,
        "step_ids": step_ids,
        "tripwire": {"reassess_after_s": tw["reassess_after_s"],
                     "condition": {"variable": var, "op": cond["op"], "value": cond["value"],
                                   "unit": unit, "of_last_n": n, "at_least": k}},
        "escalation": copy.deepcopy(esc) if isinstance(esc, dict) else None,
    }
    return {
        "schema": "landfall.case_state/1", "case_id": cid, "crew_id": crew_id, "status": "idle",
        "spec": spec, "opened_at": None, "finding": None, "countermeasure_id": None,
        "steps_done": [], "outcome": None, "watch_started_at": None, "reassess_at": None,
        "tripwire_obs": [], "tripwire_result": None, "closed_at": None, "dismiss_reason": None,
        "updated_at": None, "log": [],
    }


def _nonempty_str(x: object) -> bool:
    return isinstance(x, str) and x.strip() != ""


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
    if not (isinstance(state, dict) and state.get("status") in STATES and isinstance(state.get("spec"), dict)
            and isinstance(state.get("log"), list) and isinstance(state.get("crew_id"), str)
            and isinstance(state.get("tripwire_obs"), list) and isinstance(state.get("steps_done"), list)):
        raise EngineError("invalid_argument", "state must be a case state built by new_case / case_reduce")


def case_reduce(state: dict, event: dict) -> dict:
    _validate_state(state)
    s = copy.deepcopy(state)
    ev = event if isinstance(event, dict) else {}
    etype = ev.get("type")
    t = ev.get("t")
    frm = s.get("status")

    def log(to: str, detail: str, error: str | None) -> dict:
        s["log"].append({"t": t, "event": etype, "from": frm, "to": to, "detail": detail, "error": error})
        return s

    def reject(error: str, detail: str) -> dict:
        return log(frm, detail, error)

    def accept(to: str, detail: str) -> dict:
        s["status"] = to
        s["updated_at"] = t
        return log(to, detail, None)

    if etype not in EVENTS:
        return reject("invalid_event", f"unknown event type {etype!r}")
    if not is_number(t):
        return reject("invalid_event", "event t must be a finite number")
    if etype == "TICK" and frm != "watch":
        return s  # clock ticks outside watch are expected and change nothing: no log entry
    if s.get("updated_at") is not None and t < s["updated_at"]:
        return reject("time_reversed", f"t {fmt_num(t)} is before the last transition at {fmt_num(s['updated_at'])}")

    if etype == "OPEN":
        if frm != "idle":
            return reject("invalid_transition", f"OPEN is only valid from idle, case is {frm}")
        f = ev.get("finding")
        if not isinstance(f, dict):
            return reject("invalid_event", "OPEN needs a finding object")
        if f.get("severity") not in OPENING_SEVERITIES:
            return reject("below_threshold", f"finding severity {f.get('severity')!r} is below caution")
        if s["spec"]["trigger_ids"] and f.get("rule_id") not in s["spec"]["trigger_ids"]:
            return reject("not_a_trigger", f"{f.get('rule_id')!r} is not a trigger of {s['case_id']}")
        s["opened_at"] = t
        s["finding"] = copy.deepcopy(f)
        return accept("detected", f"opened by {f.get('rule_id')} ({f.get('status')}, {f.get('severity')})")

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
        if cm_id not in s["spec"]["countermeasure_ids"]:
            return reject("unknown_countermeasure", f"{cm_id!r} is not a countermeasure of {s['case_id']}")
        s["countermeasure_id"] = cm_id
        primary = cm_id == s["spec"]["countermeasure_ids"][0]
        return accept("acting", f"selected {cm_id} ({'primary' if primary else 'alternative'})")

    if etype == "STEP":
        if frm != "acting":
            return reject("invalid_transition", f"STEP is only valid from acting, case is {frm}")
        step_id = ev.get("step_id")
        if step_id not in s["spec"]["step_ids"]:
            return reject("unknown_step", f"{step_id!r} is not a step of {s['case_id']}")
        if any(d["step_id"] == step_id for d in s["steps_done"]):
            return reject("duplicate_step", f"step {step_id} already done")
        s["steps_done"].append({"step_id": step_id, "t": t, "input": copy.deepcopy(ev.get("input"))})
        return accept("acting", f"step {step_id} done ({len(s['steps_done'])} of {len(s['spec']['step_ids'])})")

    if etype == "OUTCOME":
        if frm != "acting":
            return reject("invalid_transition", f"OUTCOME is only valid from acting, case is {frm}")
        text = ev.get("text")
        if not _nonempty_str(text):
            return reject("invalid_event", "OUTCOME needs a non-empty text")
        s["outcome"] = {"text": text, "t": t}
        s["watch_started_at"] = t
        s["reassess_at"] = t + s["spec"]["tripwire"]["reassess_after_s"]
        return accept("watch", f"outcome recorded; reassess at {fmt_num(s['reassess_at'])} "
                               f"({len(s['steps_done'])} of {len(s['spec']['step_ids'])} steps done)")

    # TICK in watch
    cond = s["spec"]["tripwire"]["condition"]
    obs_list = ev.get("observations") or []
    if not isinstance(obs_list, list):
        return reject("invalid_event", "TICK observations must be a list")
    known_t = {o["t"] for o in s["tripwire_obs"]}
    added = 0
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
        s["tripwire_obs"].append({"t": ot, "value": ov})
        added += 1
    s["tripwire_obs"].sort(key=lambda o: o["t"])
    ev_res = _tripwire_eval(s)
    desc = (f"{ev_res['hits']} of last {ev_res['considered']} {cond['variable']} "
            f"{OP_SYMBOL[cond['op']]} {fmt_num(cond['value'])} (escalate at {cond['at_least']} of {cond['of_last_n']})")
    if t >= s["reassess_at"]:
        if ev_res["tripped"]:
            s["tripwire_result"] = ev_res
            s["closed_at"] = t
            return accept("escalated", f"reassessed: tripwire {desc}; queued for flight-surgeon review")
        remaining = cond["of_last_n"] - ev_res["considered"]
        if ev_res["hits"] + remaining < cond["at_least"]:
            s["tripwire_result"] = ev_res
            s["closed_at"] = t
            return accept("resolved", f"reassessed: {desc}")
        if added:
            return accept("watch", f"reassessment due, need more observations: {desc}")
        return s
    if added:
        return accept("watch", f"{added} new observation(s): {desc}; "
                               f"judged at reassessment ({fmt_num(s['reassess_at'])})")
    return s
