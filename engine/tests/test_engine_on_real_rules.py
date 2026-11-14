"""Run the engine over the real rules in engine/rules/*.json (written by another agent).

Skips, with a reason, while a file does not exist yet. Shape/provenance checks of the rules files
themselves live in test_rules.py; this file checks that the engine can evaluate every rule.
"""

import pytest

from engine import (PRIVATE_VARIABLES, case_reduce, comms_eta, evaluate_personal, evaluate_rule,
                    load_rules, new_case, trigger_lookup)
from engine.thresholds import CEILING_OPS

RULES = load_rules()
NOW = 412 * 86400 + 14 * 3600 + 20 * 60


def _need(name):
    if RULES.get(name) is None:
        pytest.skip(f"engine/rules/{name}.json does not exist yet")
    return RULES[name]


def _threshold_rules():
    doc = RULES.get("thresholds")
    return list((doc or {}).get("rules") or [])


def _env_ids():
    doc = RULES.get("environments") or {}
    return [e["id"] for e in doc.get("environments") or []]


def _applicable_env(rule):
    if "*" in rule["applies_to"]:
        return (_env_ids() or ["iss"])[0]
    return rule["applies_to"][0]


SEV = ("nominal", "advisory", "caution", "warning", "emergency")


def _meta_rows():
    meta = RULES.get("meta") or {}
    return (meta.get("severity_mapping") or {}).get("rows") or []


def _meta_severity(rows, rule, status, eva):
    """Independent oracle: apply rules/meta.json severity_mapping rows to a Tier A finding.

    The first row with "severity" whose "when" matches sets the base; every matching
    "severity_max" row (and the rule's own max_severity) caps it.
    """
    facts = {"tier": rule["tier"], "role": rule["role"], "category": rule["category"],
             "status": status, "s_level": rule.get("s_level"), "eva": eva}

    def match(when):
        for k, v in when.items():
            if k == "category_in":
                ok = facts["category"] in v
            elif k == "status_in":
                ok = facts["status"] in v
            elif k == "s_level_in":
                ok = facts["s_level"] in v
            elif k == "s_level_min":
                ok = (facts["s_level"] or 0) >= v
            elif k == "eva":
                ok = facts["eva"] is True
            else:
                ok = facts.get(k) == v
            if not ok:
                return False
        return True

    base, caps = None, []
    for row in rows:
        if not match(row["when"]):
            continue
        if "severity" in row and base is None:
            base = row["severity"]
        if "severity_max" in row:
            caps.append(row["severity_max"])
    if base is None and facts["role"] == "context":
        # meta.json has no base row for a context rule that is outside/approaching. SPEC section 2
        # says "advisory at most", i.e. a cap: take the alert-role base, then cap it below.
        facts["role"] = "alert"
        base = next((row["severity"] for row in rows if "severity" in row and match(row["when"])), None)
        facts["role"] = "context"
    if rule.get("max_severity"):
        caps.append(rule["max_severity"])
    sev = base or "nominal"
    for c in caps:
        if SEV.index(sev) > SEV.index(c):
            sev = c
    return sev


def _obs(rule, value):
    return {"crew_id": "CM-1", "variable": rule["variable"], "value": value, "unit": rule["unit"], "t": NOW}


@pytest.mark.parametrize("rule", _threshold_rules() or [None], ids=lambda r: r["id"] if r else "no-rules")
def test_every_threshold_rule_on_both_sides_of_its_limit(rule):
    _need("thresholds")
    if rule is None:
        pytest.skip("thresholds.json has no rules")
    limit = rule["limit"]
    delta = abs(limit) * 0.05 if limit != 0 else 1.0
    ceiling = rule["op"] in CEILING_OPS
    ok_value = limit - delta if ceiling else limit + delta
    bad_value = limit + delta if ceiling else limit - delta
    approach = rule.get("approach_at")
    if approach is not None:
        a = approach["value"]
        assert (a < limit) if ceiling else (a > limit), f"{rule['id']}: approach_at on the wrong side of limit"
        # a value past the watch level is still compliant but "approaching"
        ok_value = a - abs(a) * 0.05 - 1e-9 if ceiling else a + abs(a) * 0.05 + 1e-9
    env = _applicable_env(rule)
    ok = evaluate_rule(rule, _obs(rule, ok_value), env, NOW)
    bad = evaluate_rule(rule, _obs(rule, bad_value), env, NOW)
    assert ok["status"] == "within", ok["why"]
    assert bad["status"] == "outside", bad["why"]
    assert ok["severity"] == "nominal"
    rows = _meta_rows()
    for eva in (False, True):
        got = evaluate_rule(rule, bad_value, env, NOW, ctx={"eva": eva})["severity"]
        assert got != "emergency"
        if rows:
            assert got == _meta_severity(rows, rule, "outside", eva), f"{rule['id']} outside eva={eva}"
    if approach is not None:
        mid = (approach["value"] + limit) / 2
        f = evaluate_rule(rule, mid, env, NOW)
        assert f["status"] == "approaching"
        if rows:
            assert f["severity"] == _meta_severity(rows, rule, "approaching", False), rule["id"]
    for other in _env_ids():
        if "*" not in rule["applies_to"] and other not in rule["applies_to"]:
            assert evaluate_rule(rule, bad_value, other, NOW)["status"] == "not_applicable"


def test_rules_apply_only_to_known_environments():
    _need("thresholds")
    envs = set(_env_ids())
    if not envs:
        pytest.skip("environments.json does not exist yet")
    for rule in _threshold_rules():
        unknown = set(rule["applies_to"]) - envs - {"*"}
        assert not unknown, f"{rule['id']} applies_to unknown environments {sorted(unknown)}"


def _indicators():
    return list((RULES.get("personal") or {}).get("indicators") or [])


@pytest.mark.parametrize("ind", _indicators() or [None], ids=lambda i: i["id"] if i else "no-indicators")
def test_every_personal_indicator_evaluates(ind):
    personal = _need("personal")
    if ind is None:
        pytest.skip("personal.json has no indicators")
    cfg = personal["rci"]
    base = [10 + (i % 3 - 1) for i in range(max(cfg["min_baseline_n"], 14))]
    worse_sign = -1 if ind["worse"] == "decrease" else 1
    far = evaluate_personal(ind, base, 10 + worse_sign * 100, cfg)
    assert far["status"] == "reliable_change"
    # a non-alerting indicator shows its change and never alerts (SPEC section 2)
    assert far["severity"] == ("caution" if ind["alerting"] else "nominal")
    assert far["rci"]["method"] == "crawford_howell_1998" and far["rci"]["df"] == len(base) - 1
    assert evaluate_personal(ind, base, 10, cfg)["status"] == "within"
    assert evaluate_personal(ind, base[: cfg["min_baseline_n"] - 1], 10, cfg)["status"] == "insufficient_data"
    if ind.get("private") is True:
        assert ind["variable"] in PRIVATE_VARIABLES, "private indicator not gated in the ground packet"


def test_mood_is_private_and_non_alerting():
    _need("personal")
    mood = [i for i in _indicators() if i["id"] == "mood"]
    if not mood:
        pytest.skip("no mood indicator yet")
    assert mood[0]["private"] is True and mood[0]["alerting"] is False


def _cases():
    return list((RULES.get("cases") or {}).get("cases") or [])


@pytest.mark.parametrize("case_def", _cases() or [None], ids=lambda c: c["id"] if c else "no-cases")
def test_every_case_runs_through_the_state_machine(case_def):
    _need("cases")
    if case_def is None:
        pytest.skip("cases.json has no cases")
    s = new_case(case_def, "CM-1", trigger_lookup(RULES))
    cond = s["spec"]["tripwire"]["condition"]
    assert cond["unit"], f"{case_def['id']}: tripwire unit unresolved (units are never assumed)"
    known = {r["id"] for r in _threshold_rules()} | {i["id"] for i in _indicators()}
    if known:
        missing = set(s["spec"]["trigger_ids"]) - known
        assert not missing, f"{case_def['id']} triggers on unknown ids {sorted(missing)}"
    trigger = s["spec"]["trigger_ids"][0]
    s = case_reduce(s, {"type": "OPEN", "finding": {"rule_id": trigger, "severity": "caution"}, "t": NOW})
    assert s["status"] == "detected", s["log"][-1]
    s = case_reduce(s, {"type": "SELECT", "countermeasure_id": s["spec"]["countermeasure_ids"][0], "t": NOW + 1})
    assert s["status"] == "acting", s["log"][-1]
    for i, step_id in enumerate(s["spec"]["step_ids"]):
        s = case_reduce(s, {"type": "STEP", "step_id": step_id, "t": NOW + 2 + i})
        assert s["log"][-1]["error"] is None
    s = case_reduce(s, {"type": "OUTCOME", "text": "test outcome", "t": NOW + 100})
    assert s["status"] == "watch"


@pytest.mark.parametrize("case_def", _cases() or [None], ids=lambda c: c["id"] if c else "no-cases")
def test_every_case_watches_a_rule_that_applies_in_every_environment(case_def):
    """The tripwire must watch a rule that is evaluated where the crew is (SPEC 3.4 by_env).

    Before by_env, spe_shelter watched ops_noaa_s3 everywhere, a rule that is not_applicable at
    mars_surface, the hero setting."""
    _need("cases")
    if case_def is None:
        pytest.skip("cases.json has no cases")
    rules = {r["id"]: r for r in _threshold_rules()}
    inds = {i["id"] for i in _indicators()}
    for env in _env_ids():
        s = new_case(case_def, "CM-1", trigger_lookup(RULES), env)
        ref = s["spec"]["tripwire"]["condition"]["ref_id"]
        assert s["spec"]["env_id"] == env
        if ref in inds:
            continue
        rule = rules[ref]
        assert "*" in rule["applies_to"] or env in rule["applies_to"], (case_def["id"], env, ref)
        assert evaluate_rule(rule, 2000, env, NOW)["status"] != "not_applicable"


def test_spe_tripwire_follows_the_environment():
    _need("cases")
    spe = next((c for c in _cases() if c["id"] == "spe_shelter"), None)
    if spe is None:
        pytest.skip("no spe_shelter case")
    lk = trigger_lookup(RULES)
    at = {env: new_case(spe, "CM-1", lk, env)["spec"]["tripwire"]["condition"] for env in _env_ids()}
    assert at["mars_surface"]["ref_id"] == "ops_onboard_proton_s3"
    assert {at[e]["ref_id"] for e in ("iss", "cislunar", "lunar_surface")} == {"ops_noaa_s3"}
    # same physical quantity everywhere: the switch changes the rule, never the unit or the level
    assert {(c["variable"], c["unit"], c["op"], c["value"]) for c in at.values()} == {("proton_flux_10mev", "pfu", "ge", 1000)}


def test_environment_comms_without_tables():
    envs = (_need("environments").get("environments") or [])
    for env in envs:
        olt = (env.get("comms") or {}).get("one_way_light_time_s") or {}
        if "from_snapshot" in olt:
            continue  # needs the light-time table, converted to MET by the runtime
        r = comms_eta(env, NOW)
        assert r["round_trip_s"] == 2 * r["one_way_s"] and r["blocked"] is False
