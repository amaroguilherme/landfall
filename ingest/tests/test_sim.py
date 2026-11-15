"""Known-answer tests for the simulated scenario (engine/SPEC.md section 7).

Tier B's single-case t (Crawford & Howell 1998) is recomputed here from the SPEC section 5 formula,
independently of the generator: sd = sample SD (n-1), t = (x - mean) / (sd * sqrt(1 + 1/n)),
df = n - 1, reliable when |t| > the two-tailed alpha 0.001 critical value at df 13 (published t tables
print 4.221; one test cross-checks the generator's constant against the engine's own t_critical).

The noise is realistic, so these tests do NOT assume that Tier B detects the scripted episodes. They
check what must hold whatever the noise does (the Tier A renal crossing, the SPE hero, D9's absolute
midpoint, the manual vitals, the labels) and that data.self_check reports Tier B's verdicts truthfully.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import statistics

import pytest

from ingest import _sim_model as model
from ingest import sim_crew
from ingest.common import DEFAULT_OUT_DIR, REPO_ROOT, validate_snapshot

T_CRIT_DF13 = 4.221                          # published t tables, two-tailed alpha 0.001, df 13
NOW = 412 * 86400 + 14 * 3600 + 20 * 60
DAY = 86400
SPEC_UNITS = {  # SPEC 3.3, the extra scenario variables, and lead decision D8 (manual vitals)
    "pvt_lapses": "count", "pvt_median_rt": "ms", "sleep_duration": "h", "sleep_midpoint_shift": "h",
    "light_exposure_daytime": "lux", "resting_hr": "bpm", "hrv_sdnn": "ms", "skin_temp": "°C",
    "urine_volume_24h": "mL", "fluid_intake_24h": "mL", "mood": "score_1_5",
    "vo2max": "ml/min/kg", "career_effective_dose": "mSv",
    "bp_systolic": "mmHg", "bp_diastolic": "mmHg", "glucose": "mg/dL",
}
TIER_B = [v for v in SPEC_UNITS if v not in ("mood", "vo2max", "career_effective_dose")]
VITALS = ("bp_systolic", "bp_diastolic", "glucose")


def spec_t(baseline: list[float], x: float) -> float | None:
    m, sd = statistics.fmean(baseline), statistics.stdev(baseline)
    return None if sd == 0 else (x - m) / (sd * math.sqrt(1 + 1 / len(baseline)))


def mday(t: int) -> int:  # the day an observation belongs to: the day its window ENDED
    return (t - 1) // DAY


@pytest.fixture(scope="module")
def snap():
    return sim_crew.build_snapshot(DEFAULT_OUT_DIR, "2026-11-14T13:00:00Z")


@pytest.fixture(scope="module")
def snap_fallback(tmp_path_factory):
    return sim_crew.build_snapshot(tmp_path_factory.mktemp("empty"), "2026-11-14T13:00:00Z")


def crew(snap, cid):
    return next(c for c in snap["data"]["crew"] if c["crew_id"] == cid)


def by_mday(series: dict) -> dict[int, float]:
    return {mday(t): v for t, v in zip(series["t"], series["v"])}


def baseline_values(series: dict) -> list[float]:
    d = by_mday(series)
    return [d[k] for k in range(368, 382) if k in d]


def all_text(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def test_contract_and_labels(snap, snap_fallback):
    for s in (snap, snap_fallback):
        validate_snapshot(s)
        assert s["id"] == "sim_crew" and s["adapter"] == "sim" and s["provenance"] == "simulated"
        text = " ".join(s["caveats"])
        assert "no public time series of real crew wearable data exists" in text
        for name in ("Barger", "Basner", "Flynn-Evans", "Quer", "Nayan", "Selvin"):
            assert name in text, name
        assert "nothing trimmed or rejection-sampled" in text


def test_judge_facing_text_is_clean(snap):
    text = all_text(snap)
    for banned in ("project plan", "PLANO", "build machine", "from memory", "REAL Mars solar-conjunction",
                   "first real window", "NASA publishes no", "deliberately low", "QUIET"):
        assert banned not in text, banned


def test_units_and_sources_exact(snap):
    for c in snap["data"]["crew"]:
        assert set(c["series"]) == set(SPEC_UNITS)
        for var, ser in c["series"].items():
            assert ser["unit"] == SPEC_UNITS[var], var
            assert ser["source"] in {"band", "manual", "vehicle", "lab", "app", "replay"}
        for var in VITALS:
            assert c["series"][var]["source"] == "manual"
        assert c["intraday"]["heart_rate"]["unit"] == "bpm"
    veh = snap["data"]["vehicle"]["series"]
    assert veh["cabin_ppco2"]["unit"] == "mmHg"
    assert veh["onboard_dose_rate"]["unit"] == "uGy/day"
    assert veh["proton_flux_10mev"]["unit"] == "pfu"
    assert veh["proton_flux_10mev"]["source"] in {"replay", "vehicle"}
    variables = snap["data"]["variables"]
    assert variables["bp_systolic"]["device"] == variables["bp_diastolic"]["device"] == "vehicle medical kit cuff"
    assert "glucometer" in variables["glucose"]["device"]
    for var, meta in variables.items():
        assert meta["calibration"], f"{var} has no calibration entry"
        for cal in meta["calibration"]:
            assert cal["chip"] in {"literature", "derived", "design choice", "NASA-published"}, (var, cal["item"])
            assert cal["source"]["kind"] in {"literature", "derived", "design_choice", "nasa_standard"}
            if cal["chip"] == "literature":
                assert re.match(r"https://pubmed\.ncbi\.nlm\.nih\.gov/\d+/$", cal["source"]["url"]), cal["source"]
                assert "PMID " in cal["source"]["citation"]


def test_crew_window_and_now(snap):
    assert [c["crew_id"] for c in snap["data"]["crew"]] == ["CM-1", "CM-2", "CM-3", "CM-4"]
    assert snap["data"]["met"]["now"] == "412/14:20:00" and snap["data"]["met"]["now_met_s"] == NOW  # F.6.1 f
    assert model.format_met(5 * DAY + 61) == "5/00:01:01" and model.format_met(0) == "0/00:00:00"
    for c in snap["data"]["crew"]:
        for var, ser in c["series"].items():
            assert ser["t"] == sorted(ser["t"])
            assert all(368 * DAY <= t <= NOW for t in ser["t"]), var
        assert by_mday(c["series"]["sleep_duration"]).keys() == set(range(368, 413))
        # day 412 is incomplete at 'now': no 24-h urine/fluid for it
        assert max(mday(t) for t in c["series"]["urine_volume_24h"]["t"]) == 411


def test_noise_is_calibrated_not_trimmed(snap):
    """Baseline SDs scatter around the cited values (no rejection sampling), and some ordinary days sit
    well outside the old 1.4-SD trimming bound."""
    cited = {"sleep_duration": 1.2, "resting_hr": 3.0, "urine_volume_24h": model.URINE_MEAN_ABS_DIFF_ML
             * math.sqrt(math.pi) / 2, "pvt_median_rt": 14.0, "bp_systolic": 6.0, "bp_diastolic": 5.0}
    assert abs(cited["urine_volume_24h"] - 341.6) < 0.05           # Nayan 2012: 385.4 mL mean |difference|
    assert abs(100 * model.GLUCOSE_CV - math.sqrt(5.7 ** 2 + 3.0 ** 2)) < 1e-9   # Selvin 2007 5.7% + meter 3%
    beyond = 0
    for c in snap["data"]["crew"]:
        for var, sigma in cited.items():
            base = baseline_values(c["series"][var])
            ratio = statistics.stdev(base) / sigma
            assert 0.45 < ratio < 1.75, (c["crew_id"], var, ratio)     # chi distribution, df 13: very wide margin
        for var in ("sleep_duration", "resting_hr", "hrv_sdnn", "pvt_median_rt"):
            base = baseline_values(c["series"][var])
            m, s = statistics.fmean(base), statistics.stdev(base)
            beyond += sum(abs(v - m) > 1.4 * s for v in base)
    assert beyond >= 5, beyond


def test_renal_tier_a_crossing_cm3(snap):
    urine = {c["crew_id"]: by_mday(c["series"]["urine_volume_24h"]) for c in snap["data"]["crew"]}
    assert all(urine["CM-3"][d] < 1500 for d in range(398, 402))              # the scripted Tier A crossing
    for cid, u in urine.items():                                               # nobody else, no other day
        assert all(v >= 1500 for d, v in u.items() if not (cid == "CM-3" and 398 <= d <= 401)), cid
    fluid = by_mday(crew(snap, "CM-3")["series"]["fluid_intake_24h"])
    base = baseline_values(crew(snap, "CM-3")["series"]["fluid_intake_24h"])
    assert all(fluid[d] < statistics.fmean(base) - 1000 for d in range(398, 402))  # intake falls with output


def test_sleep_episode_cm1_values(snap):
    s = crew(snap, "CM-1")["series"]
    dur, mid, lapses = by_mday(s["sleep_duration"]), by_mday(s["sleep_midpoint_shift"]), by_mday(s["pvt_lapses"])
    assert all(dur[d] < 5.0 for d in range(404, 413))
    assert all(mid[d] >= 2.0 for d in range(404, 413))
    assert [lapses[d] for d in range(404, 413)] == [2, 3, 3, 4, 5, 4, 5, 6, 5]
    ep = next(e for e in snap["data"]["episodes"] if e["id"] == "sleep_shift")
    for var, vals in ep["scripted_values"].items():
        emitted = by_mday(s[var])
        for d, x in vals.items():
            assert emitted[int(d)] == x, (var, d)


def test_sleep_midpoint_shift_is_signed_from_baseline_median(snap):
    """S1: midpoint - median of the baseline nights' midpoints, wrapped to [-12, 12) h (positive = later),
    recomputed from the sleep episodes. Baseline values sit on both sides of zero."""
    for c in snap["data"]["crew"]:
        eps = c["sleep_episodes"]["v"]
        days = range(c["sleep_episodes"]["days"][0], c["sleep_episodes"]["days"][1] + 1)
        mids = {d: ((on + off) / 2 - d * DAY) / 3600 - 2.0 for d, (on, off) in zip(days, eps)}
        med = statistics.median(mids[d] for d in range(368, 382))
        emitted = by_mday(c["series"]["sleep_midpoint_shift"])
        assert all(-12 <= v < 12 for v in emitted.values())
        base = [emitted[d] for d in range(368, 382)]
        assert min(base) < 0 < max(base), c["crew_id"]
        for d, v in emitted.items():
            assert abs(v - ((mids[d] - med + 12) % 24 - 12)) < 0.011, (c["crew_id"], d, v)
    assert snap["data"]["variables"]["sleep_midpoint_shift"]["definition"].startswith("Signed difference")
    assert model.wrap_hours(12.0) == -12.0 and model.wrap_hours(-12.0) == -12.0 and model.wrap_hours(23.5) == -0.5
    assert snap["data"]["noise_model"]["per_variable"]["sleep_midpoint_shift"]["model"] == "signed_shift"


def test_manual_vitals_cadence_and_values(snap):
    days = model.manual_vitals_days()
    assert days[:14] == list(range(368, 382))                                  # daily baseline fortnight
    later = [d for d in days if d > 381]
    assert later == [382, 385, 389, 392, 396, 399, 403, 406, 410]              # then twice a week
    for c in snap["data"]["crew"]:
        eps = dict(zip(range(368, 413), c["sleep_episodes"]["v"]))
        for var, lo, hi in (("bp_systolic", 85, 150), ("bp_diastolic", 50, 100), ("glucose", 60, 130)):
            ser = c["series"][var]
            assert sorted(by_mday(ser)) == days, (c["crew_id"], var)
            assert all(lo <= v <= hi and isinstance(v, int) for v in ser["v"]), (c["crew_id"], var)
            assert all(t == eps[mday(t)][1] + 1800 for t in ser["t"])          # 30 min after wake
            assert len(baseline_values(ser)) == 14
    for var in VITALS:
        meta = snap["data"]["variables"][var]
        assert meta["nasa_limit"].startswith("NASA-STD-3001 publishes no numeric in-flight alert thresholds")
    gl = all_text(snap["data"]["variables"]["glucose"]["calibration"])
    if (DEFAULT_OUT_DIR / "osdr_cmp.json").exists():
        assert "Inspiration4 lab reference range" in gl and "Context only" in gl


def test_self_check_matches_an_independent_recomputation(snap):
    sc = snap["data"]["self_check"]
    assert sc["critical_t"] == round(model.CRITICAL_T, 4) and sc["df"] == 13 and round(model.CRITICAL_T, 3) == T_CRIT_DF13
    try:
        from engine import t_critical
    except ImportError:  # pragma: no cover - the engine ships in the same repo
        pytest.skip("engine not importable")
    assert abs(t_critical(0.001, 13) - model.CRITICAL_T) < 1e-9
    worse = {i["variable"]: i["worse"] for i in sc["indicators"]}
    transform = {i["variable"]: i["transform"] for i in sc["indicators"]}
    assert transform["pvt_lapses"] == "anscombe" and worse["sleep_midpoint_shift"] == "either"
    scripted = {(e["crew_id"], var): {int(d) for d in vals} for e in snap["data"]["episodes"]
                for var, vals in e["scripted_values"].items()}

    def scale(var, x):  # the declared test scale: Anscombe (1948) for counts
        return 2 * math.sqrt(x + 3 / 8) if transform[var] == "anscombe" else x

    expect_hits, expect_chance, expect_all = set(), set(), set()
    for c in snap["data"]["crew"]:
        for var in TIER_B:
            ser = c["series"][var]
            base = [scale(var, x) for x in baseline_values(ser)]
            for t, v in zip(ser["t"], ser["v"]):
                d = mday(t)
                if d <= 381:
                    continue
                tt = spec_t(base, scale(var, v))
                if tt is None or abs(tt) <= model.CRITICAL_T:
                    continue
                key = (c["crew_id"], var, d)
                expect_all.add(key)
                if d in scripted.get((c["crew_id"], var), set()):
                    w = worse[var]
                    if w == "either" or (tt > 0) == (w == "increase"):
                        expect_hits.add(key)
                else:
                    expect_chance.add(key)
    got_hits = {(e["crew_id"], e["variable"], d) for e in sc["tier_b"]["episodes"] for d in e["tier_b_flagged_days"]}
    got_chance = {(c["crew_id"], c["variable"], c["day"]) for c in sc["tier_b"]["chance_flags"]}
    got_all = {(f["crew_id"], f["variable"], f["day"]) for f in sc["tier_b"]["flags"]}
    assert got_hits == expect_hits
    assert got_chance == expect_chance
    assert got_all == expect_all
    for f in sc["tier_b"]["flags"]:
        assert f["critical"] == round(model.CRITICAL_T, 3) and abs(f["t"]) > f["critical"]
        assert f["scripted"] == (f["day"] in scripted.get((f["crew_id"], f["variable"]), set())), f


def test_detection_report_is_complete_and_honest(snap):
    sc = snap["data"]["self_check"]
    eps = {(e["episode_id"], e["variable"]): e for e in sc["tier_b"]["episodes"]}
    for key in (("renal_hydration", "urine_volume_24h"), ("renal_hydration", "fluid_intake_24h"),
                ("sleep_shift", "sleep_duration"), ("sleep_shift", "sleep_midpoint_shift"),
                ("sleep_shift", "pvt_lapses"), ("sleep_shift", "pvt_median_rt")):
        e = eps[key]
        assert all(0.0 <= p <= 1.0 for p in e["tier_b_detection_probability"].values())
        assert set(e["tier_b_flagged_days"]) <= {int(d) for d in e["values"]}
    assert eps[("renal_hydration", "urine_volume_24h")]["tier_a"]["outside_days"] == [398, 399, 400, 401]
    assert "tier_b_detection_probability_at_alt_sd" in eps[("sleep_shift", "sleep_midpoint_shift")]
    # Under real-size noise a 1-2 h shorter night cannot be a reliable change on its own.
    assert max(eps[("sleep_shift", "sleep_duration")]["tier_b_detection_probability"].values()) < 0.05
    text = " ".join(snap["caveats"])
    assert "What Tier B finds in this data" in text and "Tier A target_urine_output_24h is outside" in text
    assert "only if day-to-day noise were normal and" in text and "data.self_check.chance_rates" in text
    for o in sc["unscripted_case_openings"]:
        assert (o["crew_id"], o["indicator_id"], o["day"]) in {(c["crew_id"], c["indicator_id"], c["day"])
                                                              for c in sc["tier_b"]["chance_flags"]}
        assert o["single_flag"] is True and o["instance"] >= 1


def test_chance_rates_cover_every_indicator_and_flag_the_ones_outside_the_band(snap):
    """S3: every Tier B indicator (mood included) has a measured chance rate under this noise model; the ones
    outside 0.5-2 times nominal are exactly the ones engine/rules/personal.json declares."""
    cr = snap["data"]["self_check"]["chance_rates"]
    rates = cr["per_indicator"]
    personal = json.loads((REPO_ROOT / "engine" / "rules" / "personal.json").read_text(encoding="utf-8"))
    assert set(rates) == {i["id"] for i in personal["indicators"]}
    assert cr["band"] == [0.5, 2.0]
    for iid, r in rates.items():
        assert r["tests"] == 4 * model.CHANCE_REPS_PER_CREW * 31, iid
        assert r["nominal_flag_rate"] == 0.001
        assert r["nominal_caution_rate"] == (0.001 if r["worse"] == "either" else 0.0005), iid
        assert r["caution_multiplier"] == round(r["worse_direction_flags"] / r["tests"] / r["nominal_caution_rate"], 2)
        assert r["flag_multiplier"] == round(r["flags"] / r["tests"] / 0.001, 2)
        assert set(r["per_crew"]) == {"CM-1", "CM-2", "CM-3", "CM-4"}
    declared = {i["id"] for i in personal["indicators"] if "chance_rate" in i}
    assert {k for k, r in rates.items() if not r["within_band"]} == declared
    # the audit's offenders: the signed two-sided midpoint is at the printed rate; raw lapse counts no longer
    # flag 10x too often (on the Anscombe scale, fewer than printed)
    assert 0.8 < rates["sleep_midpoint_shift"]["caution_multiplier"] < 1.25
    assert rates["pvt_lapses"]["transform"] == "anscombe" and rates["pvt_lapses"]["caution_multiplier"] < 1


def test_case_openings_report(snap):
    """Every case opening the data causes, with its instance and whether only chance flags caused it."""
    sc = snap["data"]["self_check"]
    ops = sc["case_openings"]
    assert {(o["crew_id"], o["case_id"]) for o in ops if o["scripted"]} >= {("CM-3", "renal_stone")}
    renal = next(o for o in ops if o["case_id"] == "renal_stone")
    assert (renal["day"], renal["tier"], renal["opened_by"], renal["instance"]) == \
        (398, "A", "target_urine_output_24h", 1)
    chance = [o for o in ops if not o["scripted"]]
    assert [(o["crew_id"], o["case_id"], o["day"]) for o in sc["unscripted_case_openings"]] == \
        [(o["crew_id"], o["case_id"], o["day"]) for o in chance]
    for o in ops:
        assert o["run_days"][0] == o["day"] <= o["run_days"][1]
        first = [f for f in sc["tier_b"]["flags"] if f["severity"] == "caution" and f["case_id"] == o["case_id"]
                 and f["crew_id"] == o["crew_id"] and f["day"] == o["day"]]
        assert o["single_flag"] == (o["tier"] == "B" and len(first) == 1), o


def test_mdc_is_critical_times_sd(snap):
    for cid, pc in snap["data"]["self_check"]["tier_b"]["per_crew"].items():
        for r in pc["indicators"]:
            if r.get("mdc") is None:
                continue
            assert abs(r["mdc"] - model.CRITICAL_T * r["baseline_sd"] * math.sqrt(1 + 1 / r["baseline_n"])) < 1e-3
            assert abs(r["mdc_at_model_sd"] - model.CRITICAL_T * r["model_sd"] * math.sqrt(1 + 1 / 14)) < 1e-3


def test_ffd_demo_cm2(snap):
    latest = {c["crew_id"]: c["series"]["vo2max"]["v"][-1] for c in snap["data"]["crew"]}
    assert latest["CM-2"] == 35.1 and 32.9 <= latest["CM-2"] < 36.5
    assert all(v >= 40.0 for cid, v in latest.items() if cid != "CM-2")
    assert snap["data"]["ffd_demo"]["value"] == 35.1
    for c in snap["data"]["crew"]:
        assert c["series"]["career_effective_dose"]["v"][0] < 480


def test_mood_private_non_alerting(snap):
    meta = snap["data"]["variables"]["mood"]
    assert meta["private"] is True and meta["alerting"] is False
    for c in snap["data"]["crew"]:
        assert set(c["series"]["mood"]["v"]) <= {1, 2, 3, 4, 5}


def test_intraday_heart_rate_only_now_day(snap):
    for c in snap["data"]["crew"]:
        hr = c["intraday"]["heart_rate"]
        assert hr["start_t"] == 412 * DAY and hr["step_s"] == 60
        assert hr["start_t"] + (hr["n"] - 1) * 60 == NOW and len(hr["v"]) == hr["n"]
        assert all(35 <= v <= 190 for v in hr["v"])


def test_cabin_ppco2_hourly_within_limit(snap):
    p = snap["data"]["vehicle"]["series"]["cabin_ppco2"]
    assert p["step_s"] == 3600 and p["start_t"] == 368 * DAY
    assert p["start_t"] + p["n"] * 3600 <= NOW
    assert max(p["v"]) < 2.4                                         # below the rule's approach level


def test_spe_day_real_inputs(snap):
    replay = (DEFAULT_OUT_DIR / "swpc_spe_replay.json").exists()
    rad = (DEFAULT_OUT_DIR / "hapi_msl_rad_dose.json").exists()
    spe = snap["data"]["spe_day"]
    dose = snap["data"]["vehicle"]["series"]["onboard_dose_rate"]
    assert dose["step_s"] == 300 and dose["start_t"] == 412 * DAY
    assert dose["start_t"] + (dose["n"] - 1) * 300 == NOW
    assert dose["after_now"]["start_t"] == NOW + 300
    assert dose["provenance"] == "simulated" and "simulated confirmation" in dose["label"]
    b = spe["baseline"]["value"]
    pre = [v for v in dose["v"][: 8 * 12] if v is not None]          # 00:00-08:00, before the onset
    assert all(abs(v - b) < 0.2 * b for v in pre)
    assert spe["value_at_now"] >= 10 * b                              # clearly elevated at 'now'
    assert spe["crossings"]["10x_baseline"]["relative_to_now_s"] == -300
    assert spe["shape"]["mode"] == ("real" if replay else "fallback")
    assert spe["baseline"]["mode"] == ("real" if rad else "fallback")
    text = " ".join(snap["caveats"])
    assert "LANDFALL is not the radiation alarm" in text and "[V2 6164]" in text
    if replay:
        assert spe["shape"]["mapping"]["replay_utc_of_first_s3_sample"] == "1989-10-19T18:55:00Z"
        for phrase in ("TIME PROFILE is REAL", "EXTERNAL space-weather monitor", "NO radial-distance",
                       "NO atmospheric correction", "[V2 6165]"):
            assert phrase in text, phrase
    if rad:
        rad_snap = json.loads((DEFAULT_OUT_DIR / "hapi_msl_rad_dose.json").read_text())
        param = rad_snap["data"]["headline_parameter"]
        assert b == round(rad_snap["data"]["series"][param]["summary"]["median"], 2)


def test_proton_flux_series(snap, snap_fallback):
    veh = snap["data"]["vehicle"]["series"]
    pf, dose = veh["proton_flux_10mev"], veh["onboard_dose_rate"]
    assert (pf["start_t"], pf["step_s"], pf["n"]) == (dose["start_t"], dose["step_s"], dose["n"])
    assert pf["v"] == dose["source_flux_pfu"] and pf["after_now"]["v"] == dose["after_now"]["source_flux_pfu"]
    first = next(i for i, v in enumerate(pf["v"]) if v is not None and v >= 1000)
    assert pf["start_t"] + first * 300 == NOW - 300                   # first S3-level sample at 412/14:15:00
    assert pf["v"][-1] >= 1000                                        # still at S3 level at 'now'
    meta = snap["data"]["variables"]["proton_flux_10mev"]
    assert meta["label"].startswith("External space-weather monitor") and "above the atmosphere" in meta["label"]
    v2 = next(c for c in meta["calibration"] if c["chip"] == "NASA-published")
    std = json.loads((DEFAULT_OUT_DIR / "std_vol2_requirements.json").read_text()) \
        if (DEFAULT_OUT_DIR / "std_vol2_requirements.json").exists() else None
    if std:                                                           # [V2 6165] quoted verbatim
        req = next(r for r in std["data"]["requirements"] if r["id"] == "[V2 6165]")
        assert v2["source"]["verbatim"] == req["text"]
    if (DEFAULT_OUT_DIR / "swpc_spe_replay.json").exists():
        assert pf["source"] == "replay" and pf["provenance"] == "replay" and pf["after_now"]["provenance"] == "replay"
        assert meta["provenance"] == "replay"
        replay = json.loads((DEFAULT_OUT_DIR / "swpc_spe_replay.json").read_text())["data"]["series_ge10mev"]
        vals = replay["values"]
        i_s3 = next(i for i, v in enumerate(vals) if v is not None and v >= 1000)
        for j, v in enumerate(pf["v"] + pf["after_now"]["v"]):           # time shift only, values untouched
            k = i_s3 + j - first
            assert v == (vals[k] if 0 <= k < len(vals) else None), j
    fb = snap_fallback["data"]["vehicle"]["series"]["proton_flux_10mev"]
    assert fb["source"] == "vehicle" and fb["provenance"] == "simulated"


def _compliant(op: str, value: float, limit: float) -> bool:
    return {"lt": value < limit, "le": value <= limit, "gt": value > limit, "ge": value >= limit}[op]


def _approaching(rule: dict, value: float) -> bool:
    a = (rule.get("approach_at") or {}).get("value")
    if a is None:
        return False
    return value >= a if rule["op"] in ("lt", "le") else value <= a


def test_scenario_matches_rules_file(snap):
    """Cross-check against engine/rules/thresholds.json (owned by the rules author) when present."""
    path = REPO_ROOT / "engine" / "rules" / "thresholds.json"
    if not path.exists():
        pytest.skip("engine/rules/thresholds.json not written yet")
    rules = [r for r in json.loads(path.read_text())["rules"] if r.get("role") == "alert"]
    by_var = {}
    for r in rules:
        by_var.setdefault(r["variable"], []).append(r)
    data = snap["data"]
    for r in by_var.get("urine_volume_24h", []):                     # renal: only CM-3 days 398-401 are outside
        for c in data["crew"]:
            ser = c["series"]["urine_volume_24h"]
            assert ser["unit"] == r["unit"]
            for day, v in by_mday(ser).items():
                episode = c["crew_id"] == "CM-3" and 398 <= day <= 401
                assert _compliant(r["op"], v, r["limit"]) != episode, (r["id"], c["crew_id"], day, v)
    for r in by_var.get("cabin_ppco2", []):                          # habitat CO2 never competes
        p = data["vehicle"]["series"]["cabin_ppco2"]
        assert p["unit"] == r["unit"]
        assert all(_compliant(r["op"], v, r["limit"]) and not _approaching(r, v) for v in p["v"]), r["id"]
    for r in by_var.get("career_effective_dose", []):                # SPE case is driven by the event, not the career
        for c in data["crew"]:
            v = c["series"]["career_effective_dose"]["v"][0]
            assert _compliant(r["op"], v, r["limit"]) and not _approaching(r, v), (r["id"], c["crew_id"])
    floors = {r["id"]: r for r in by_var.get("vo2max", [])}
    for r in floors.values():                                        # only CM-2, only on the surface floor
        for c in data["crew"]:
            v = c["series"]["vo2max"]["v"][-1]
            ok = _compliant(r["op"], v, r["limit"])
            surface = any(e in r["applies_to"] for e in ("mars_surface", "lunar_surface"))
            if c["crew_id"] == "CM-2":
                assert ok != surface and not (ok and _approaching(r, v)), (r["id"], v)
            else:
                assert ok and not _approaching(r, v), (r["id"], c["crew_id"], v)
    pf = data["vehicle"]["series"]["proton_flux_10mev"]
    for r in by_var.get("proton_flux_10mev", []):
        if "mars_surface" not in r["applies_to"]:
            continue
        assert pf["unit"] == r["unit"]
        hits = [pf["start_t"] + i * pf["step_s"] for i, v in enumerate(pf["v"])
                if v is not None and not _compliant(r["op"], v, r["limit"])]
        if r.get("case_id") == "spe_shelter":                        # the hero opens 5 min before 'now'
            assert hits and hits[0] == NOW - 300, (r["id"], hits[:1])


def test_conjunction_mapping(snap):
    cal = snap["data"]["calendar"]
    text = " ".join(snap["caveats"])
    if (DEFAULT_OUT_DIR / "horizons_mars_comms.json").exists():
        assert cal["mode"] == "horizons"
        w = cal["window_met"]
        assert w["start_met_s"] <= NOW < w["stop_met_s"]
        assert cal["blackout_remaining_at_now_s"] >= 10 * DAY
        assert snap["coverage"]["stop"] == cal["now_utc"]
        assert "MODELLED from JPL Horizons geometry" in text and "command moratoria" in text
        assert cal["selection"].startswith("first modelled window")
    else:
        assert cal["mode"] == "placeholder" and cal["met_epoch_utc"] is None


def test_fallbacks_are_flagged(snap_fallback):
    text = " ".join(snap_fallback["caveats"])
    assert "FALLBACK" in text and "SYNTHETIC" in text and "PLACEHOLDER" in text
    d = snap_fallback["data"]
    assert d["spe_day"]["shape"]["mode"] == "fallback" and d["calendar"]["mode"] == "placeholder"
    assert d["spe_day"]["value_at_now"] >= 10 * d["spe_day"]["baseline"]["value"]


def test_inputs_picked_up_automatically(tmp_path):
    for sid in ("swpc_spe_replay", "hapi_msl_rad_dose", "horizons_mars_comms"):
        src = DEFAULT_OUT_DIR / f"{sid}.json"
        if not src.exists():
            pytest.skip(f"{sid} not built yet")
        shutil.copy(src, tmp_path / src.name)
    s = sim_crew.build_snapshot(tmp_path, "2026-11-14T13:00:00Z")
    assert s["data"]["spe_day"]["shape"]["mode"] == "real"
    assert s["data"]["calendar"]["mode"] == "horizons"


def test_deterministic_and_small(snap):
    again = sim_crew.build_snapshot(DEFAULT_OUT_DIR, "2030-01-01T00:00:00Z")
    a, b = dict(snap), dict(again)
    a.pop("retrieved_at"), b.pop("retrieved_at")
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    size = len(json.dumps(snap, ensure_ascii=False, separators=(",", ":")).encode())
    assert size < 450_000, size


def test_shipped_file_is_the_current_build(snap):
    """web/public/data/sim_crew.json must equal a fresh build (re-run `uv run python -m ingest sim`)."""
    path = DEFAULT_OUT_DIR / "sim_crew.json"
    if not path.exists():
        pytest.skip("sim_crew.json not built yet")
    shipped = json.loads(path.read_text(encoding="utf-8"))
    fresh = json.loads(json.dumps(snap, ensure_ascii=False))
    shipped.pop("retrieved_at"), fresh.pop("retrieved_at")
    assert shipped == fresh
