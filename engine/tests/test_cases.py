import copy
import json
from pathlib import Path

import pytest

from engine import EngineError, case_reduce, new_case

FIX = json.loads((Path(__file__).parent / "fixtures" / "engine_fixtures.json").read_text(encoding="utf-8"))
CASE = FIX["case"]
T0 = 412 * 86400 + 14 * 3600 + 20 * 60
DAY = 86400
FINDING = {"rule_id": "pvt_lapses", "tier": "B", "category": "PERSONAL", "status": "reliable_change",
           "severity": "caution", "value": 8, "unit": "count"}


def obs(v, t, crew="CM-1", unit="count"):
    return {"crew_id": crew, "variable": "pvt_lapses", "value": v, "unit": unit, "t": t}


def drive(state, events):
    for e in events:
        state = case_reduce(state, e)
    return state


def to_watch():
    s = new_case(CASE, "CM-1")
    return drive(s, [
        {"type": "OPEN", "finding": FINDING, "t": T0},
        {"type": "SELECT", "countermeasure_id": "cm_primary", "t": T0 + 60},
        {"type": "STEP", "step_id": "step_1", "t": T0 + 120},
        {"type": "OUTCOME", "text": "Light schedule shifted.", "t": T0 + 300},
    ])


def test_happy_path_detected_acting_watch_resolved():
    s = new_case(CASE, "CM-1")
    assert s["status"] == "idle"
    s = case_reduce(s, {"type": "OPEN", "finding": FINDING, "t": T0})
    assert s["status"] == "detected" and s["opened_at"] == T0
    s = case_reduce(s, {"type": "SELECT", "countermeasure_id": "cm_primary", "t": T0 + 60})
    assert s["status"] == "acting"
    s = case_reduce(s, {"type": "STEP", "step_id": "step_1", "t": T0 + 120})
    s = case_reduce(s, {"type": "STEP", "step_id": "step_2", "t": T0 + 180})
    assert [d["step_id"] for d in s["steps_done"]] == ["step_1", "step_2"]
    s = case_reduce(s, {"type": "OUTCOME", "text": "Light schedule shifted.", "t": T0 + 300})
    assert s["status"] == "watch" and s["reassess_at"] == T0 + 300 + 259200  # T+72 h
    good = [obs(2, T0 + 300 + DAY), obs(5, T0 + 300 + 2 * DAY), obs(1, T0 + 300 + 3 * DAY)]
    s = case_reduce(s, {"type": "TICK", "t": T0 + 300 + 2 * DAY, "observations": good[:2]})
    assert s["status"] == "watch"  # 1 of 2 >= 4, not yet reassessment time
    s = case_reduce(s, {"type": "TICK", "t": T0 + 300 + 3 * DAY, "observations": good})
    assert s["status"] == "resolved" and s["tripwire_result"]["hits"] == 1
    # every transition logged, in order, none with an error
    assert [(e["event"], e["to"]) for e in s["log"]] == [
        ("OPEN", "detected"), ("SELECT", "acting"), ("STEP", "acting"), ("STEP", "acting"),
        ("OUTCOME", "watch"), ("TICK", "watch"), ("TICK", "resolved")]
    assert all(e["error"] is None for e in s["log"])
    assert all({"t", "event", "detail"} <= set(e) for e in s["log"])


def test_tripwire_two_of_three_escalates():
    s = to_watch()
    w = s["watch_started_at"]
    # observations from another crewmember and from before the watch started are ignored
    s = case_reduce(s, {"type": "TICK", "t": w + 43200,
                        "observations": [obs(9, w + 100, crew="CM-2"), obs(9, w - 50), obs(6, w + 43200)]})
    assert s["status"] == "watch" and len(s["tripwire_obs"]) == 1
    s = case_reduce(s, {"type": "TICK", "t": w + 2 * 43200, "observations": [obs(3, w + 2 * 43200)]})
    assert s["status"] == "watch"  # 1 of last 2 >= 4
    s = case_reduce(s, {"type": "TICK", "t": w + 3 * 43200, "observations": [obs(5, w + 3 * 43200)]})
    # 6 and 5 >= 4 is 2 of the last 3, but the case texts say "Reassess at T+72 h; if ... still ...":
    # the tripwire is judged at reassessment, not as soon as the hits arrive
    assert s["status"] == "watch" and len(s["tripwire_obs"]) == 3
    s = case_reduce(s, {"type": "TICK", "t": s["reassess_at"] - 1, "observations": []})
    assert s["status"] == "watch"
    s = case_reduce(s, {"type": "TICK", "t": s["reassess_at"], "observations": []})
    assert s["status"] == "escalated"
    assert s["tripwire_result"] == {"hits": 2, "considered": 3, "of_last_n": 3, "at_least": 2, "tripped": True}
    assert s["log"][-1]["to"] == "escalated" and "flight-surgeon" in s["log"][-1]["detail"]


def test_vehicle_observations_with_null_crew_id_count_for_the_tripwire():
    # sim_crew.json vehicle series (onboard proton monitor) carry crew_id null; the SPE tripwire
    # must see them, or the case can never be reassessed
    s = to_watch()
    w = s["watch_started_at"]
    s = case_reduce(s, {"type": "TICK", "t": w + 100, "observations": [obs(7, w + 50, crew=None), obs(8, w + 60, crew="CM-2")]})
    assert [o["value"] for o in s["tripwire_obs"]] == [7]
    s = case_reduce(s, {"type": "TICK", "t": s["reassess_at"], "observations": [obs(6, w + 70, crew=None)]})
    assert s["status"] == "escalated"


def test_tripwire_unit_must_resolve_and_malformed_state_raises():
    tw = copy.deepcopy(CASE["tripwire"])
    del tw["condition"]["unit"]
    with pytest.raises(EngineError) as e:
        new_case(dict(CASE, tripwire=tw), "CM-1")   # units are never assumed
    assert e.value.code == "invalid_case"
    s = new_case(dict(CASE, tripwire=tw), "CM-1", lookup={"pvt_lapses": {"variable": "pvt_lapses", "unit": "count"}})
    assert s["spec"]["tripwire"]["condition"]["unit"] == "count"
    for bad in (None, {}, {"status": "watch"}, dict(s, status="bogus")):
        with pytest.raises(EngineError) as e:
            case_reduce(bad, {"type": "TICK", "t": T0, "observations": []})
        assert e.value.code == "invalid_argument"


def test_reassessment_waits_for_enough_data_unless_decided():
    s = to_watch()
    w, ra = s["watch_started_at"], s["reassess_at"]
    s = case_reduce(s, {"type": "TICK", "t": ra, "observations": [obs(5, w + 10)]})
    assert s["status"] == "watch"  # 1 hit, 2 unknown: could still trip
    s = case_reduce(s, {"type": "TICK", "t": ra + 1, "observations": [obs(1, ra + 1)]})
    assert s["status"] == "watch"  # 1 hit + 1 unknown can still reach 2
    s = case_reduce(s, {"type": "TICK", "t": ra + 2, "observations": [obs(1, ra + 2)]})
    assert s["status"] == "resolved"


def test_invalid_transition_returns_same_state_plus_error_entry():
    s = new_case(CASE, "CM-1")
    out = case_reduce(s, {"type": "SELECT", "countermeasure_id": "cm_primary", "t": T0})
    assert out["status"] == "idle"
    assert out["log"][-1]["error"] == "invalid_transition"
    assert {k: v for k, v in out.items() if k != "log"} == {k: v for k, v in s.items() if k != "log"}
    assert len(out["log"]) == len(s["log"]) + 1
    for event, code in [
        ({"type": "OPEN", "finding": dict(FINDING, severity="advisory"), "t": T0}, "below_threshold"),
        ({"type": "OPEN", "finding": dict(FINDING, rule_id="mood"), "t": T0}, "not_a_trigger"),
        ({"type": "LAUNCH", "t": T0}, "invalid_event"),
        ({"type": "OPEN", "finding": FINDING}, "invalid_event"),  # no t
    ]:
        r = case_reduce(s, event)
        assert r["status"] == "idle" and r["log"][-1]["error"] == code
    opened = case_reduce(s, {"type": "OPEN", "finding": FINDING, "t": T0})
    for event, code in [
        ({"type": "SELECT", "countermeasure_id": "nope", "t": T0 + 1}, "unknown_countermeasure"),
        ({"type": "SELECT", "countermeasure_id": "cm_primary", "t": T0 - 1}, "time_reversed"),
        ({"type": "STEP", "step_id": "step_1", "t": T0 + 1}, "invalid_transition"),
        ({"type": "DISMISS", "reason": "", "t": T0 + 1}, "invalid_event"),
        ({"type": "OPEN", "finding": FINDING, "t": T0 + 1}, "invalid_transition"),
    ]:
        r = case_reduce(opened, event)
        assert r["status"] == "detected" and r["log"][-1]["error"] == code
    acting = case_reduce(opened, {"type": "SELECT", "countermeasure_id": "cm_alt_1", "t": T0 + 1})
    r = case_reduce(case_reduce(acting, {"type": "STEP", "step_id": "step_1", "t": T0 + 2}),
                    {"type": "STEP", "step_id": "step_1", "t": T0 + 3})
    assert r["log"][-1]["error"] == "duplicate_step"
    assert case_reduce(acting, {"type": "STEP", "step_id": "step_9", "t": T0 + 2})["log"][-1]["error"] == "unknown_step"


def test_dismiss_and_terminal_states():
    s = case_reduce(new_case(CASE, "CM-1"), {"type": "OPEN", "finding": FINDING, "t": T0})
    d = case_reduce(s, {"type": "DISMISS", "reason": "Band off-wrist; repeat PVT normal.", "t": T0 + 5})
    assert d["status"] == "dismissed" and d["dismiss_reason"].startswith("Band")
    r = case_reduce(d, {"type": "OPEN", "finding": FINDING, "t": T0 + 6})
    assert r["status"] == "dismissed" and r["log"][-1]["error"] == "invalid_transition"
    w = to_watch()
    assert case_reduce(w, {"type": "DISMISS", "reason": "Crew decision.", "t": w["updated_at"] + 1})["status"] == "dismissed"


def test_ticks_outside_watch_and_noop_ticks_are_silent():
    s = case_reduce(new_case(CASE, "CM-1"), {"type": "OPEN", "finding": FINDING, "t": T0})
    assert case_reduce(s, {"type": "TICK", "t": T0 + 9, "observations": [obs(9, T0 + 9)]}) == s
    w = to_watch()
    assert case_reduce(w, {"type": "TICK", "t": w["updated_at"] + 10, "observations": []}) == w


def test_tick_unit_mismatch_rejected():
    w = to_watch()
    r = case_reduce(w, {"type": "TICK", "t": w["updated_at"] + 10,
                        "observations": [obs(5, w["updated_at"] + 5, unit="lapses")]})
    assert r["status"] == "watch" and r["log"][-1]["error"] == "unit_mismatch" and r["tripwire_obs"] == []


def test_rejected_tick_is_atomic():
    # a valid observation listed before the bad one must not survive the rejection
    w = to_watch()
    u = w["updated_at"]
    good, bad = obs(5, u + 5), obs(6, u + 6, unit="lapses")
    r = case_reduce(w, {"type": "TICK", "t": u + 10, "observations": [good, bad]})
    assert r["log"][-1]["error"] == "unit_mismatch" and len(r["log"]) == len(w["log"]) + 1
    assert {k: v for k, v in r.items() if k != "log"} == {k: v for k, v in w.items() if k != "log"}
    assert r["log"][:-1] == w["log"]
    # every rejection, whatever the event, returns the input state plus exactly one log entry
    o = case_reduce(new_case(CASE, "CM-1"), {"type": "OPEN", "finding": FINDING, "t": T0})
    for state, event in [(w, {"type": "TICK", "t": u + 10, "observations": "not a list"}),
                         (w, {"type": "OUTCOME", "text": "again", "t": u + 10}),
                         (o, {"type": "SELECT", "countermeasure_id": "cm_x", "t": T0 + 1}),
                         (o, {"type": "SELECT", "countermeasure_id": "cm_primary", "t": T0 - 1})]:
        r = case_reduce(state, event)
        assert r["log"][-1]["error"] is not None and r["log"][:-1] == state["log"]
        assert {k: v for k, v in r.items() if k != "log"} == {k: v for k, v in state.items() if k != "log"}


def test_new_case_by_env_switches_the_watched_reference():
    tw = copy.deepcopy(CASE["tripwire"])
    tw["condition"]["by_env"] = {"mars_surface": {"indicator_id": "sleep_duration", "op": "lt", "value": 5}}
    case = dict(CASE, tripwire=tw)
    lookup = {"sleep_duration": {"variable": "sleep_duration", "unit": "h"}}
    base = new_case(case, "CM-1", lookup, env_id="iss")["spec"]
    mars = new_case(case, "CM-1", lookup, env_id="mars_surface")["spec"]
    assert base["env_id"] == "iss" and mars["env_id"] == "mars_surface"
    assert base["tripwire"]["condition"] == {"ref_id": "pvt_lapses", "variable": "pvt_lapses", "op": "ge", "value": 4,
                                             "unit": "count", "of_last_n": 3, "at_least": 2}
    # the override names a new reference, so the base's explicit unit "count" is dropped and re-resolved
    assert mars["tripwire"]["condition"] == {"ref_id": "sleep_duration", "variable": "sleep_duration", "op": "lt",
                                             "value": 5, "unit": "h", "of_last_n": 3, "at_least": 2}
    assert new_case(case, "CM-1", lookup)["spec"]["tripwire"]["condition"]["ref_id"] == "pvt_lapses"
    with pytest.raises(EngineError) as e:
        new_case(case, "CM-1", None, env_id="mars_surface")   # new reference, unit unresolvable
    assert e.value.code == "invalid_case"
    for bad_by_env in (["mars_surface"], {"mars_surface": "x"}, {"mars_surface": {"by_env": {}}}):
        tw2 = copy.deepcopy(CASE["tripwire"])
        tw2["condition"]["by_env"] = bad_by_env
        with pytest.raises(EngineError) as e:
            new_case(dict(CASE, tripwire=tw2), "CM-1", env_id="mars_surface")
        assert e.value.code == "invalid_case"
    for bad_env in ("", 5, True):
        with pytest.raises(EngineError) as e:
            new_case(CASE, "CM-1", env_id=bad_env)
        assert e.value.code == "invalid_argument"


def test_reducer_is_pure():
    s = to_watch()
    before = copy.deepcopy(s)
    ev = {"type": "TICK", "t": s["updated_at"] + 10, "observations": [obs(5, s["updated_at"] + 5)]}
    ev_before = copy.deepcopy(ev)
    case_reduce(s, ev)
    assert s == before and ev == ev_before


def test_new_case_validation():
    with pytest.raises(EngineError) as e:
        new_case({k: v for k, v in CASE.items() if k != "tripwire"}, "CM-1")
    assert e.value.code == "invalid_case"
    rule_tw = dict(CASE, tripwire={"reassess_after_s": 3600, "condition": {
        "rule_id": "pel_cabin_ppco2_1h", "op": "gt", "value": 3, "of_last_n": 3, "at_least": 2}})
    with pytest.raises(EngineError):
        new_case(rule_tw, "CM-1")
    s = new_case(rule_tw, "CM-1", lookup={"pel_cabin_ppco2_1h": {"variable": "cabin_ppco2_1h_mean", "unit": "mmHg"}})
    assert s["spec"]["tripwire"]["condition"]["variable"] == "cabin_ppco2_1h_mean"
    assert s["spec"]["tripwire"]["condition"]["unit"] == "mmHg"
