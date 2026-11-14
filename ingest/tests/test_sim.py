"""Known-answer tests for the simulated scenario (engine/SPEC.md section 7).

Tier B's single-case t (Crawford & Howell 1998) is recomputed here from the SPEC section 5 formula,
independently of the generator and of the engine: sd = sample SD (n-1),
t = (x - mean) / (sd * sqrt(1 + 1/n)), df = n - 1, reliable when |t| > 4.221, the two-tailed
alpha 0.001 critical value at df 13 in published t tables (e.g. Purdue STAT 503, MedCalc).
"""

from __future__ import annotations

import json
import math
import shutil
import statistics

import pytest

from ingest import sim_crew
from ingest.common import DEFAULT_OUT_DIR, REPO_ROOT, validate_snapshot

T_CRIT_DF13 = 4.221                          # published t tables, two-tailed alpha 0.001, df 13
T_ROBUST = 6.0 / math.sqrt(1 + 1 / 14)       # 6 baseline SDs on a 14-day baseline: |t| >= 5.797
NOW = 412 * 86400 + 14 * 3600 + 20 * 60
DAY = 86400
SPEC_UNITS = {  # SPEC 3.3 plus the four extra variables named in the brief
    "pvt_lapses": "count", "pvt_median_rt": "ms", "sleep_duration": "h", "sleep_midpoint_shift": "h",
    "light_exposure_daytime": "lux", "resting_hr": "bpm", "hrv_sdnn": "ms", "skin_temp": "°C",
    "urine_volume_24h": "mL", "fluid_intake_24h": "mL", "mood": "score_1_5",
    "vo2max": "ml/min/kg", "career_effective_dose": "mSv",
}
ALERTING = [v for v in SPEC_UNITS if v not in ("mood", "vo2max", "career_effective_dose")]


def spec_t(baseline: list[float], x: float) -> float:
    m, sd = statistics.fmean(baseline), statistics.stdev(baseline)
    return (x - m) / (sd * math.sqrt(1 + 1 / len(baseline)))


@pytest.fixture(scope="module")
def snap():
    return sim_crew.build_snapshot(DEFAULT_OUT_DIR, "2026-11-14T13:00:00Z")


@pytest.fixture(scope="module")
def snap_fallback(tmp_path_factory):
    return sim_crew.build_snapshot(tmp_path_factory.mktemp("empty"), "2026-11-14T13:00:00Z")


def crew(snap, cid):
    return next(c for c in snap["data"]["crew"] if c["crew_id"] == cid)


def by_day(series: dict, day_of=lambda t: t // DAY) -> dict[int, float]:
    return {day_of(t): v for t, v in zip(series["t"], series["v"])}


def collection_day(t: int) -> int:  # 24-h urine / fluid are stamped at the END of their MET day
    return t // DAY - 1


def baseline_values(series: dict, day_of=lambda t: t // DAY) -> list[float]:
    d = by_day(series, day_of)
    return [d[k] for k in range(368, 382)]


def test_contract_and_labels(snap, snap_fallback):
    for s in (snap, snap_fallback):
        validate_snapshot(s)
        assert s["id"] == "sim_crew" and s["adapter"] == "sim" and s["provenance"] == "simulated"
        text = " ".join(s["caveats"])
        assert "no public time series of real crew wearable data exists" in text
        assert "Barger" in text and "Basner" in text and "Bio-Monitor" in text


def test_units_and_sources_exact(snap):
    for c in snap["data"]["crew"]:
        assert set(c["series"]) == set(SPEC_UNITS)
        for var, ser in c["series"].items():
            assert ser["unit"] == SPEC_UNITS[var], var
            assert ser["source"] in {"band", "manual", "vehicle", "lab", "app", "replay"}
        assert c["intraday"]["heart_rate"]["unit"] == "bpm"
    veh = snap["data"]["vehicle"]["series"]
    assert veh["cabin_ppco2"]["unit"] == "mmHg"
    assert veh["onboard_dose_rate"]["unit"] == "uGy/day"
    assert veh["proton_flux_10mev"]["unit"] == "pfu"
    assert veh["proton_flux_10mev"]["source"] in {"replay", "vehicle"}
    for var, meta in snap["data"]["variables"].items():
        assert meta["calibration"], f"{var} has no calibration entry"
        for cal in meta["calibration"]:
            assert cal["chip"] in {"literature", "derived", "design choice", "NASA-published"}
            assert cal["source"]["kind"] in {"literature", "derived", "design_choice", "nasa_standard"}


def test_crew_window_and_now(snap):
    assert [c["crew_id"] for c in snap["data"]["crew"]] == ["CM-1", "CM-2", "CM-3", "CM-4"]
    assert snap["data"]["met"]["now"] == "0412/14:20:00" and snap["data"]["met"]["now_met_s"] == NOW
    for c in snap["data"]["crew"]:
        for var, ser in c["series"].items():
            assert ser["t"] == sorted(ser["t"])
            assert all(368 * DAY <= t <= NOW for t in ser["t"]), var
        assert by_day(c["series"]["sleep_duration"]).keys() == set(range(368, 413))
        # day 412 is incomplete at 'now': no 24-h urine/fluid, no daytime light for it
        assert max(collection_day(t) for t in c["series"]["urine_volume_24h"]["t"]) == 411


def test_renal_episode_cm3(snap):
    for var in ("urine_volume_24h", "fluid_intake_24h"):
        ser = crew(snap, "CM-3")["series"][var]
        d = by_day(ser, collection_day)
        base = baseline_values(ser, collection_day)
        assert len(base) == 14
        for day in range(398, 402):
            assert spec_t(base, d[day]) <= -T_ROBUST, (var, day)
    urine = {cid: by_day(crew(snap, cid)["series"]["urine_volume_24h"], collection_day)
             for cid in ("CM-1", "CM-2", "CM-3", "CM-4")}
    assert all(urine["CM-3"][d] < 1500 for d in range(398, 402))               # below the 1,500 mL/day level
    assert all(urine["CM-3"][d] > 2500 for d in range(368, 382))               # baseline above the 2,500 approach
    for cid, u in urine.items():                                                # nobody else, no other day
        assert all(v > 2500 for day, v in u.items() if not (cid == "CM-3" and 398 <= day <= 401)), cid


def test_sleep_episode_cm1(snap):
    s = crew(snap, "CM-1")["series"]
    lapses, base = by_day(s["pvt_lapses"]), baseline_values(s["pvt_lapses"])
    for day in range(407, 413):
        assert spec_t(base, lapses[day]) >= T_ROBUST, day
    first = next(d for d in range(382, 413) if spec_t(base, lapses[d]) > T_CRIT_DF13)
    assert 404 <= first <= 407, first                            # reliable change BY day 407, not before 404
    for var, sign in (("sleep_duration", -1), ("sleep_midpoint_shift", 1), ("pvt_median_rt", 1)):
        d, b = by_day(s[var]), baseline_values(s[var])
        days = range(404, 413) if var != "pvt_median_rt" else range(407, 413)
        for day in days:
            assert sign * spec_t(b, d[day]) >= T_ROBUST, (var, day)
    assert all(by_day(s["sleep_duration"])[d] < 5.0 for d in range(404, 413))


def test_no_unintended_reliable_change(snap):
    scripted = {("CM-3", "urine_volume_24h"): range(398, 402), ("CM-3", "fluid_intake_24h"): range(398, 402),
                ("CM-1", "sleep_duration"): range(404, 413), ("CM-1", "sleep_midpoint_shift"): range(404, 413),
                ("CM-1", "pvt_lapses"): range(404, 413), ("CM-1", "pvt_median_rt"): range(404, 413)}
    for c in snap["data"]["crew"]:
        for var in ALERTING:
            day_of = collection_day if var in ("urine_volume_24h", "fluid_intake_24h") else (lambda t: t // DAY)
            if var == "light_exposure_daytime":
                day_of = None
            ser = c["series"][var]
            vals = ser["v"] if day_of is None else None
            if day_of is None:  # stamped at the next sleep onset: index i is MET day 368 + i
                d = dict(zip(range(368, 368 + len(vals)), vals))
            else:
                d = by_day(ser, day_of)
            base = [d[k] for k in range(368, 382)]
            skip = scripted.get((c["crew_id"], var), ())
            for day, v in d.items():
                if day in skip:
                    continue
                t = spec_t(base, v)
                assert abs(t) < T_CRIT_DF13 and abs(t) <= 1.36, (c["crew_id"], var, day, t)


def test_self_check_reports_the_single_case_t(snap):
    sc = snap["data"]["self_check"]
    assert sc["method"].startswith("SPEC section 5 single-case t (Crawford & Howell 1998)")
    assert sc["non_episode_max_abs_t"] == 1.35 and sc["non_episode_bound_sd"] == 1.4
    for ev in sc["episodes"]:
        assert ev["df"] == 13 and ev["critical_t"] == T_CRIT_DF13 and ev["min_abs_t"] > T_CRIT_DF13
        assert abs(ev["min_abs_t"] - ev["min_abs_z"] / math.sqrt(1 + 1 / 14)) < 0.01   # both rounded to 2 dp
    text = " ".join(snap["caveats"])
    assert "at the printed false-alarm rate" not in text and "for any r in" not in text
    assert "only if day-to-day noise were normal and independent" in text


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
    b = spe["baseline"]["value"]
    pre = [v for v in dose["v"][: 8 * 12] if v is not None]          # 00:00-08:00, before the onset
    assert all(abs(v - b) < 0.2 * b for v in pre)
    assert spe["value_at_now"] >= 10 * b                              # clearly elevated at 'now'
    assert spe["crossings"]["10x_baseline"]["relative_to_now_s"] == -300
    assert spe["shape"]["mode"] == ("real" if replay else "fallback")
    assert spe["baseline"]["mode"] == ("real" if rad else "fallback")
    if replay:
        assert spe["shape"]["mapping"]["replay_utc_of_first_s3_sample"] == "1989-10-19T18:55:00Z"
        text = " ".join(snap["caveats"])
        assert "TIME PROFILE is REAL" in text and "assumed flux-to-dose scaling" in text
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
    assert pf["start_t"] + first * 300 == NOW - 300                   # first S3-level sample at 0412/14:15:00
    assert pf["v"][-1] >= 1000                                        # still at S3 level at 'now'
    if (DEFAULT_OUT_DIR / "swpc_spe_replay.json").exists():
        assert pf["source"] == "replay"
        replay = json.loads((DEFAULT_OUT_DIR / "swpc_spe_replay.json").read_text())["data"]["series_ge10mev"]
        vals = replay["values"]
        i_s3 = next(i for i, v in enumerate(vals) if v is not None and v >= 1000)
        for j, v in enumerate(pf["v"] + pf["after_now"]["v"]):           # time shift only, values untouched
            k = i_s3 + j - first
            assert v == (vals[k] if 0 <= k < len(vals) else None), j
    assert snap_fallback["data"]["vehicle"]["series"]["proton_flux_10mev"]["source"] == "vehicle"


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
    for r in by_var.get("urine_volume_24h", []):                     # renal: only CM-3 days 398-401 fire
        for c in data["crew"]:
            ser = c["series"]["urine_volume_24h"]
            assert ser["unit"] == r["unit"]
            for day, v in by_day(ser, collection_day).items():
                episode = c["crew_id"] == "CM-3" and 398 <= day <= 401
                if episode:
                    assert not _compliant(r["op"], v, r["limit"]), (r["id"], day, v)
                else:
                    assert _compliant(r["op"], v, r["limit"]) and not _approaching(r, v), (r["id"], c["crew_id"], day, v)
    for r in by_var.get("cabin_ppco2", []):                          # habitat CO2 never competes
        p = data["vehicle"]["series"]["cabin_ppco2"]
        assert p["unit"] == r["unit"]
        assert all(_compliant(r["op"], v, r["limit"]) and not _approaching(r, v) for v in p["v"]), r["id"]
    for r in by_var.get("career_effective_dose", []):                # SPE case is driven by the rate, not the career
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
    if (DEFAULT_OUT_DIR / "horizons_mars_comms.json").exists():
        assert cal["mode"] == "horizons"
        w = cal["window_met"]
        assert w["start_met_s"] <= NOW < w["stop_met_s"]
        assert cal["blackout_remaining_at_now_s"] >= 10 * DAY
        assert snap["coverage"]["stop"] == cal["now_utc"]
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
    assert size < 400_000, size
