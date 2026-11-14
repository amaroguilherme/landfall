"""The demo scenario under Tier B's single-case test, on the shipped data (SPEC section 7).

Reads web/public/data/sim_crew.json and engine/rules/personal.json, and evaluates every personal
indicator of every crewmember on every day after the baseline, the way the app does
(web/src/app/evaluate.ts): the baseline is the fixed scenario window, MET days 368-381, and the
measurement day of an observation is floor((t - 1) / 86400), so a 24-h urine collection stamped at the
end of its day counts for that day.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine import evaluate_personal, load_rules, t_critical

ROOT = Path(__file__).resolve().parents[2]
SIM = ROOT / "web" / "public" / "data" / "sim_crew.json"
DAY = 86400
BASELINE = (368, 381)


def measurement_day(t: int) -> int:
    return (t - 1) // DAY


@pytest.fixture(scope="module")
def findings():
    if not SIM.exists():
        pytest.skip("web/public/data/sim_crew.json not built yet")
    sim = json.loads(SIM.read_text(encoding="utf-8"))
    personal = load_rules()["personal"]
    cfg = personal["rci"]
    out = {}
    for crew in sim["data"]["crew"]:
        for ind in personal["indicators"]:
            ser = crew["series"][ind["variable"]]
            obs = [{"variable": ind["variable"], "value": v, "unit": ser["unit"], "t": t}
                   for t, v in zip(ser["t"], ser["v"]) if v is not None]
            base = [o for o in obs if BASELINE[0] <= measurement_day(o["t"]) <= BASELINE[1]]
            for o in obs:
                day = measurement_day(o["t"])
                if day > BASELINE[1]:
                    out[(crew["crew_id"], ind["id"], day)] = evaluate_personal(ind, base, o, cfg, o["t"])
    return out


def test_baselines_are_full_14_day_windows(findings):
    assert {f["rci"]["n"] for f in findings.values()} == {14}
    assert {f["rci"]["df"] for f in findings.values()} == {13}
    assert {round(f["rci"]["critical"], 3) for f in findings.values()} == {4.221}
    assert all(f["rci"]["critical"] == t_critical(0.001, 13) for f in findings.values())


def test_cm1_pvt_lapses_reliable_change_by_day_407(findings):
    days = sorted(d for (c, i, d), f in findings.items() if c == "CM-1" and i == "pvt_lapses"
                  and f["severity"] == "caution")
    assert days and days[0] <= 407, days                  # SPEC 7: a reliable change by MET day 407
    assert days == list(range(406, 413)), days            # first on day 406 (t = 4.75), then every day
    f407 = findings[("CM-1", "pvt_lapses", 407)]
    assert f407["status"] == "reliable_change" and f407["rci"]["rc"] > 1.5 * f407["rci"]["critical"]
    assert f407["value"] == 7 and f407["case_id"] == "sleep_circadian"


def test_cm3_urine_output_reliable_drop_on_days_398_to_401(findings):
    days = sorted(d for (c, i, d), f in findings.items() if c == "CM-3" and i == "urine_volume_24h"
                  and f["severity"] == "caution")
    assert days == [398, 399, 400, 401], days
    for d in days:
        f = findings[("CM-3", "urine_volume_24h", d)]
        assert f["direction"] == "decrease" and f["rci"]["rc"] < -2 * f["rci"]["critical"]
        assert f["value"] < 1500 and f["case_id"] == "renal_stone"
    fluid = sorted(d for (c, i, d), f in findings.items() if c == "CM-3" and i == "fluid_intake_24h"
                   and f["severity"] == "caution")
    assert fluid == [398, 399, 400, 401]


def test_only_the_scripted_episodes_change_reliably(findings):
    scripted = {("CM-3", "urine_volume_24h"): range(398, 402), ("CM-3", "fluid_intake_24h"): range(398, 402),
                ("CM-1", "sleep_duration"): range(404, 413), ("CM-1", "sleep_midpoint_shift"): range(404, 413),
                ("CM-1", "pvt_lapses"): range(406, 413), ("CM-1", "pvt_median_rt"): range(406, 413)}
    for (crew, ind, day), f in findings.items():
        if day in scripted.get((crew, ind), ()):
            assert f["status"] == "reliable_change" and f["severity"] == "caution", (crew, ind, day)
        else:
            assert f["status"] == "within" and f["severity"] == "nominal", (crew, ind, day, f["why"])


def test_mood_never_alerts(findings):
    mood = [f for (c, i, d), f in findings.items() if i == "mood"]
    assert mood and all(f["severity"] == "nominal" and f["private"] is True for f in mood)
