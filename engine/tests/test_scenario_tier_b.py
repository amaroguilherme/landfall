"""The demo scenario under Tier B's single-case test, on the shipped data (SPEC section 7).

Reads web/public/data/sim_crew.json and engine/rules/personal.json, and evaluates every personal
indicator of every crewmember on every day after the baseline, the way the app does
(web/src/app/evaluate.ts): the baseline is the fixed scenario window, MET days 368-381, and the
measurement day of an observation is floor((t - 1) / 86400), so a 24-h urine collection stamped at the
end of its day counts for that day.

What Tier B detects depends on the simulated noise, which the generator calibrates (D10). The generator
publishes its own run of the same test in data.self_check.tier_b; these tests cross-check the engine
against it (baseline n, mean, minimum detectable change, flagged episode days, chance flags) and hold
the engine invariants on every finding. The day-by-day expectations of the earlier scenario run only on
a sim_crew.json that predates that report.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from engine import evaluate_personal, load_rules, min_detectable_change, t_critical

ROOT = Path(__file__).resolve().parents[2]
SIM = ROOT / "web" / "public" / "data" / "sim_crew.json"
DAY = 86400
BASELINE = (368, 381)


def measurement_day(t: int) -> int:
    return (t - 1) // DAY


@pytest.fixture(scope="module")
def sim():
    if not SIM.exists():
        pytest.skip("web/public/data/sim_crew.json not built yet")
    return json.loads(SIM.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def scenario(sim):
    personal = load_rules()["personal"]
    cfg = personal["rci"]
    out, missing = {}, set()
    for crew in sim["data"]["crew"]:
        for ind in personal["indicators"]:
            ser = crew["series"].get(ind["variable"])
            if ser is None:
                missing.add(ind["id"])
                continue
            obs = [{"variable": ind["variable"], "value": v, "unit": ser["unit"], "t": t}
                   for t, v in zip(ser["t"], ser["v"]) if v is not None]
            base = [o for o in obs if BASELINE[0] <= measurement_day(o["t"]) <= BASELINE[1]]
            for o in obs:
                day = measurement_day(o["t"])
                if day > BASELINE[1]:
                    out[(crew["crew_id"], ind["id"], day)] = evaluate_personal(ind, base, o, cfg, o["t"])
    return {"findings": out, "missing": missing, "personal": personal}


def tier_b_report(sim):
    return (sim["data"].get("self_check") or {}).get("tier_b")


def test_baselines_are_full_14_day_windows(scenario):
    findings = scenario["findings"]
    assert findings
    assert {f["rci"]["n"] for f in findings.values()} == {14}
    assert {f["rci"]["df"] for f in findings.values()} == {13}
    assert {round(f["rci"]["critical"], 3) for f in findings.values()} == {4.221}
    assert all(f["rci"]["critical"] == t_critical(0.001, 13) for f in findings.values())


def test_every_finding_reports_its_minimum_detectable_change(scenario):
    """D10: rci.mdc is the band half-width, and a value is a reliable change exactly when it is further than mdc
    from the baseline mean."""
    for key, f in scenario["findings"].items():
        r = f["rci"]
        if r["sd"] == 0:
            assert r["mdc"] is None, key
            continue
        assert r["mdc"] == r["critical"] * r["s_diff"], key
        assert r["mdc"] == min_detectable_change(r["sd"], r["n"], r["alpha"])["mdc"], key
        assert (abs(f["value"] - r["mean"]) > r["mdc"]) == r["reliable"] or \
            math.isclose(abs(f["value"] - r["mean"]), r["mdc"], rel_tol=1e-12), key


def test_tier_b_severity_invariants(scenario):
    """Caution only for a reliable change in the worse direction of an alerting indicator; never a warning."""
    inds = {i["id"]: i for i in scenario["personal"]["indicators"]}
    for (crew, iid, day), f in scenario["findings"].items():
        ind = inds[iid]
        assert f["severity"] in ("nominal", "caution"), (crew, iid, day)
        worse = ind["worse"] == "either" or f["direction"] == ind["worse"]
        expect = "caution" if (f["status"] == "reliable_change" and worse and ind["alerting"]) else "nominal"
        assert f["severity"] == expect, (crew, iid, day, f["why"])


def test_mood_never_alerts(scenario):
    mood = [f for (c, i, d), f in scenario["findings"].items() if i == "mood"]
    assert mood and all(f["severity"] == "nominal" and f["private"] is True for f in mood)


def test_every_indicator_has_a_series(sim, scenario):
    if tier_b_report(sim) is None:
        pytest.skip("sim_crew.json predates the D8 manual vitals and the generator's Tier B report "
                    "(ingest/sim_crew.py regenerates it)")
    assert scenario["missing"] == set()


def test_engine_agrees_with_the_generators_own_tier_b_report(sim, scenario):
    """The generator runs the same single-case test on the shipped points (data.self_check.tier_b). The engine
    must find the same baselines, the same minimum detectable changes, the same flagged episode days and the
    same chance flags, and nothing else at caution."""
    rep = tier_b_report(sim)
    if rep is None:
        pytest.skip("sim_crew.json predates the generator's Tier B report")
    findings = scenario["findings"]
    for cid, block in rep["per_crew"].items():
        for row in block["indicators"]:
            mine = [f for (c, i, d), f in findings.items() if c == cid and i == row["indicator_id"]]
            if not mine:
                continue
            r = mine[0]["rci"]
            assert r["n"] == row["baseline_n"], (cid, row["indicator_id"])
            if row.get("baseline_mean") is not None:
                assert math.isclose(r["mean"], row["baseline_mean"], abs_tol=1e-4), (cid, row["indicator_id"])
            if row.get("mdc") is not None:
                assert math.isclose(r["mdc"], row["mdc"], abs_tol=1e-4), (cid, row["indicator_id"])
    expected_cautions = set()
    for ep in rep["episodes"]:
        d0, d1 = ep["scripted_days"]
        got = sorted(d for (c, i, d), f in findings.items()
                     if c == ep["crew_id"] and i == ep["indicator_id"] and d0 <= d <= d1 and f["severity"] == "caution")
        assert got == sorted(ep["tier_b_flagged_days"]), (ep["crew_id"], ep["indicator_id"])
        expected_cautions |= {(ep["crew_id"], ep["indicator_id"], d) for d in got}
    for cf in rep["chance_flags"]:
        if cf["severity"] == "caution":
            assert findings[(cf["crew_id"], cf["indicator_id"], cf["day"])]["severity"] == "caution", cf
            expected_cautions.add((cf["crew_id"], cf["indicator_id"], cf["day"]))
    scripted = {(ep["crew_id"], ep["indicator_id"], d) for ep in rep["episodes"]
                for d in range(ep["scripted_days"][0], ep["scripted_days"][1] + 1)}
    extra = {k for k, f in findings.items() if f["severity"] == "caution"} - expected_cautions
    assert not (extra - scripted), sorted(extra - scripted)   # every caution is a reported one


# ---------------------------------------------------------------- the earlier scenario's day-by-day expectations


@pytest.fixture(scope="module")
def legacy(sim, scenario):
    if tier_b_report(sim) is not None:
        pytest.skip("superseded by the generator's Tier B report (test_engine_agrees_with_the_generators_own_tier_b_report)")
    return scenario["findings"]


def test_cm1_pvt_lapses_reliable_change_by_day_407(legacy):
    days = sorted(d for (c, i, d), f in legacy.items() if c == "CM-1" and i == "pvt_lapses"
                  and f["severity"] == "caution")
    assert days and days[0] <= 407, days
    assert days == list(range(406, 413)), days
    f407 = legacy[("CM-1", "pvt_lapses", 407)]
    assert f407["status"] == "reliable_change" and f407["rci"]["rc"] > 1.5 * f407["rci"]["critical"]
    assert f407["value"] == 7 and f407["case_id"] == "sleep_circadian"


def test_cm3_urine_output_reliable_drop_on_days_398_to_401(legacy):
    days = sorted(d for (c, i, d), f in legacy.items() if c == "CM-3" and i == "urine_volume_24h"
                  and f["severity"] == "caution")
    assert days == [398, 399, 400, 401], days
    for d in days:
        f = legacy[("CM-3", "urine_volume_24h", d)]
        assert f["direction"] == "decrease" and f["rci"]["rc"] < -2 * f["rci"]["critical"]
        assert f["value"] < 1500 and f["case_id"] == "renal_stone"
    fluid = sorted(d for (c, i, d), f in legacy.items() if c == "CM-3" and i == "fluid_intake_24h"
                   and f["severity"] == "caution")
    assert fluid == [398, 399, 400, 401]


def test_only_the_scripted_episodes_change_reliably(legacy):
    scripted = {("CM-3", "urine_volume_24h"): range(398, 402), ("CM-3", "fluid_intake_24h"): range(398, 402),
                ("CM-1", "sleep_duration"): range(404, 413), ("CM-1", "sleep_midpoint_shift"): range(404, 413),
                ("CM-1", "pvt_lapses"): range(406, 413), ("CM-1", "pvt_median_rt"): range(406, 413)}
    for (crew, ind, day), f in legacy.items():
        if day in scripted.get((crew, ind), ()):
            assert f["status"] == "reliable_change" and f["severity"] == "caution", (crew, ind, day)
        else:
            assert f["status"] == "within" and f["severity"] == "nominal", (crew, ind, day, f["why"])
