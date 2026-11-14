"""Simulated crew scenario (engine/SPEC.md section 7): build-time, seeded, labelled.

    uv run python -m ingest sim

Writes web/public/data/sim_crew.json (provenance "simulated"). Four fictional
crewmembers CM-1..CM-4, MET days 368-412, baseline days 368-381, "now" = MET 0412/14:20:00.
No public time series of real crew wearable data exists, so continuous crew vitals are
simulated; the real inputs are the SPE shape (NOAA GOES-7, October 1989), the Mars-surface
dose baseline (MSL RAD) and the conjunction calendar (JPL Horizons), read from their own
snapshots when present. Generator: ingest/_sim_model.py (crew), ingest/_sim_env.py (environment).
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from ingest import _sim_env as env
from ingest import _sim_model as model
from ingest.common import RunContext, make_snapshot, to_iso_z

ADAPTER_ID = "sim"
DEPENDS_ON = ["swpc", "hapi", "horizons"]
SNAPSHOT_ID = "sim_crew"
REPO_URL = "https://github.com/amaroguilherme/landfall"
GENERATOR_URL = f"{REPO_URL}/blob/main/ingest/sim_crew.py"

BARGER_2014 = {"kind": "literature",
               "citation": "Barger LK, Flynn-Evans EE, Kubey A, Walsh L, Ronda JM, Wang W, Wright KP Jr, Czeisler CA. "
                           "Prevalence of sleep deficiency and use of hypnotic drugs in astronauts before, during, and "
                           "after spaceflight: an observational study. Lancet Neurol 2014;13(9):904-912. "
                           "doi:10.1016/S1474-4422(14)70122-X. PMID 25127232",
               "url": "https://pubmed.ncbi.nlm.nih.gov/25127232/"}
BASNER_2011 = {"kind": "literature",
               "citation": "Basner M, Mollicone D, Dinges DF. Validity and sensitivity of a brief psychomotor vigilance "
                           "test (PVT-B) to total and partial sleep deprivation. Acta Astronaut 2011;69(11-12):949-959. "
                           "doi:10.1016/j.actaastro.2011.07.015. PMID 22025811",
               "url": "https://pubmed.ncbi.nlm.nih.gov/22025811/"}


def _dc(rationale: str) -> dict:
    return {"kind": "design_choice", "rationale": rationale}


def _cal(item: str, value: str, chip: str, source: dict) -> dict:
    return {"item": item, "value": value, "chip": chip, "source": source}


SCHEDULE_NOTE = ("Pre-shift schedule: sleep period 22:00-06:00 MET clock (midpoint 02:00). Day-to-day SDs are "
                 "set deliberately low so the scripted episodes are unambiguous for any r in [0.5, 0.9]; real "
                 "within-person variability is larger, which is why Tier B prints its false-alarm rate.")

VARIABLE_META: dict[str, dict] = {
    "sleep_duration": {
        "label": "Sleep duration (actigraphy)", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "Total sleep time of the main sleep episode ending on that MET day, from band actigraphy.",
        "calibration": [
            _cal("crew mean nightly sleep", "5.95-6.30 h", "literature",
                 {**BARGER_2014, "note": "ISS crew obtained 6.09 h (SD 0.67) of actigraphic sleep per night in flight."}),
            _cal("night-to-night SD", "0.18-0.20 h", "design choice", _dc(SCHEDULE_NOTE)),
            _cal("CM-1 after the day-403 schedule shift", "4.30-4.55 h", "design choice",
                 _dc("Scripted short sleep opportunity; same order as the 4-h time-in-bed partial sleep "
                     "deprivation protocol used to validate the PVT-B (Basner 2011)."))]},
    "sleep_midpoint_shift": {
        "label": "Sleep midpoint shift", "cadence": "daily (stamped at wake)",
        "definition": "Midpoint of the main sleep episode minus 02:00 MET, the midpoint of the pre-shift scheduled "
                      "sleep period (22:00-06:00). Positive = later.",
        "calibration": [
            _cal("reference midpoint", "02:00 MET", "design choice", _dc(SCHEDULE_NOTE)),
            _cal("night-to-night SD", "0.12-0.13 h", "design choice", _dc(SCHEDULE_NOTE)),
            _cal("CM-1 after the 3-h schedule shift", "+2.30 to +2.55 h", "design choice",
                 _dc("Partial adaptation to a 3-h later schedule (the circadian system lags the schedule)."))]},
    "pvt_lapses": {
        "label": "PVT-B lapses", "cadence": "daily, 1 h after wake (3-min PVT-B)",
        "definition": "Number of responses with reaction time >= 355 ms on the 3-min PVT-B.",
        "calibration": [
            _cal("lapse definition", "RT >= 355 ms on the 3-min PVT-B", "literature",
                 {**BASNER_2011, "note": "The paper lowers the PVT-B lapse threshold from 500 ms to 355 ms. No NASA "
                                         "standard adopts 355 ms; it is attributed to the paper only."}),
            _cal("rested baseline", "0-2 lapses per test", "design choice", _dc("Plausible rested values; not fitted.")),
            _cal("CM-1 episode", "3-5 lapses on days 404-406, 7-8 from day 407", "design choice",
                 _dc("Scripted to reach |RCI| >= 6 by day 407 for any r in [0.5, 0.9]."))]},
    "pvt_median_rt": {
        "label": "PVT-B median reaction time", "cadence": "daily, with the PVT-B",
        "definition": "Median reaction time of the 3-min PVT-B, in ms.",
        "calibration": [
            _cal("rested baseline", "246-259 ms (SD 6-7 ms)", "design choice", _dc("Plausible values; not fitted.")),
            _cal("CM-1 episode", "262-281 ms on days 404-406, 296-304 ms from day 407", "design choice",
                 _dc("Scripted slowing that accompanies the lapse increase."))]},
    "light_exposure_daytime": {
        "label": "Daytime light exposure", "cadence": "daily (wake period, stamped at the next sleep onset)",
        "definition": "Mean photopic illuminance over the wake period, from the band light sensor.",
        "calibration": [_cal("habitat daytime mean", "229-251 lux (SD 13-15)", "design choice",
                             _dc("No verified habitat illuminance value was used; kept unchanged through the "
                                 "episodes so it never fires on its own."))]},
    "resting_hr": {
        "label": "Resting heart rate", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "Mean heart rate over the main sleep episode, from band ECG R-R intervals.",
        "calibration": [_cal("crew values", "52-58 bpm (SD 1.4-1.6)", "design choice", _dc("Plausible values; not fitted."))]},
    "hrv_sdnn": {
        "label": "HRV (SDNN)", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "Median of the 300-s SDNN windows during the main sleep episode.",
        "calibration": [
            _cal("window length", "300 s", "design choice",
                 _dc("Mirrors the 300-s HRV cadence of the CSA Bio-Monitor (Hexoskin Astroskin) noted in the project "
                     "plan; that datatype registry was not re-read by this generator.")),
            _cal("crew values", "54-67 ms (SD 3.2-3.8)", "design choice", _dc("Plausible values; not fitted."))]},
    "skin_temp": {
        "label": "Skin temperature", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "Mean skin temperature over the main sleep episode, from the band (1 Hz channel).",
        "calibration": [_cal("crew values", "34.1-34.4 °C (SD 0.12-0.13)", "design choice",
                             _dc("Plausible values; not fitted. 1 Hz mirrors the Bio-Monitor skin-temperature "
                                 "channel noted in the project plan (not re-read here)."))]},
    "urine_volume_24h": {
        "label": "24-h urine output", "cadence": "daily (MET-midnight to MET-midnight collection, stamped at its end)",
        "definition": "Volume of the 24-h urine collection for that MET day, entered manually.",
        "calibration": [
            _cal("case levels", "outside below 1,500 mL/day; approaching below 2,500 mL/day", "design choice",
                 _dc("The levels are owned and sourced by rule target_urine_output_24h in engine/rules/thresholds.json "
                     "(NASA HRP Evidence Report, Risk of Renal Stone Formation); the generator only places values "
                     "clearly on either side of them.")),
            _cal("baseline", "2,780-2,900 mL (SD 100-105); every non-episode day of every crewmember stays above "
                             "2,500 mL", "design choice",
                 _dc("Crew meeting the 2.5-3 L/day hydration countermeasure target, so the rule's approach level never "
                     "fires outside the episode; day-to-day SD deliberately low (about 4%).")),
            _cal("CM-3 episode, days 398-401", "1,340-1,450 mL", "design choice",
                 _dc("Below the 1,500 mL/day level on every episode day and |RCI| >= 6 for any r in [0.5, 0.9]."))]},
    "fluid_intake_24h": {
        "label": "24-h fluid intake", "cadence": "daily (same window as the urine collection)",
        "definition": "Logged fluid intake for that MET day.",
        "calibration": [
            _cal("baseline", "3,320-3,430 mL (SD 105-110)", "design choice",
                 _dc("Plausible values, about 0.55 L above urine output; not fitted.")),
            _cal("CM-3 episode, days 398-401", "1,840-2,010 mL", "design choice",
                 _dc("Intake falls with output, as SPEC section 7 describes."))]},
    "mood": {
        "label": "Mood (self-report)", "cadence": "daily at the 12:00 MET check-in (Noon Sight)",
        "definition": "Self-rated mood, integer 1-5. PRIVATE by default and NON-ALERTING (SPEC 3.3, 7).",
        "private": True, "alerting": False,
        "calibration": [_cal("all crew", "mostly 3-4; CM-1 dips to 2-3 during the sleep episode", "design choice",
                             _dc("Never alerts; excluded from the ground packet unless the crewmember consents."))]},
    "vo2max": {
        "label": "VO2max (periodic fitness test)", "cadence": f"MET days {', '.join(map(str, model.FITNESS_TEST_DAYS))} at 10:00",
        "definition": "Aerobic capacity from the periodic in-flight fitness test.",
        "calibration": [
            _cal("CM-2 latest test (day 411)", "35.1 ml/min/kg", "design choice",
                 _dc("Set by SPEC section 7 for the FFD demo: within the [V1 4001] microgravity-EVA floor (32.9) and "
                     "outside the [V1 4002] surface-EVA floor (36.5). The floors themselves live in thresholds.json.")),
            _cal("CM-1, CM-3, CM-4", "41.1-45.6 ml/min/kg, slowly declining", "design choice",
                 _dc("Comfortably above both floors so only CM-2 flips with the environment selector."))]},
    "career_effective_dose": {
        "label": "Career effective dose to date (prior)", "cadence": "one value per crewmember, at MET 0412/00:00",
        "definition": "Career effective dose to date before the SPE day, as it would come from the dosimetry record.",
        "calibration": [_cal("CM-1..CM-4", "356-412 mSv", "design choice",
                             _dc("Not computed from any transport model. Chosen below 480 mSv (80% of the "
                                 "[V1 4030] 600 mSv limit) so the SPE case is driven by the onboard dose RATE "
                                 "([V2 6164]), not by the career limit. The SPE day's absorbed dose is NOT added: "
                                 "LANDFALL does not convert uGy to mSv."))]},
    "heart_rate": {
        "label": "Heart rate (1-min)", "cadence": "PT1M, MET day 412 only, 00:00 to now",
        "definition": "1-min mean heart rate from the band ECG.",
        "calibration": [_cal("sleep / wake / exercise levels", "resting value / ~70 bpm / ~136-144 bpm", "design choice",
                             _dc("Plausible values; the sleep segment is centred on that night's resting_hr."))]},
    "cabin_ppco2": {
        "label": "Cabin ppCO2 (1-h mean)", "cadence": "PT1H from the vehicle ECLSS",
        "definition": "1-hour mean cabin CO2 partial pressure; value k covers [start + k h, start + (k+1) h).",
        "calibration": [_cal("habitat level", f"about 1.8-2.2 mmHg, never above {model.PPCO2_CAP_MMHG}", "design choice",
                             _dc("Kept below the 2.4 mmHg approach level of rule pel_cabin_ppco2_1h in engine/rules/"
                                 "thresholds.json (and the [V2 6004] 1-h mean limit of 3 mmHg) so it never competes "
                                 "with the scripted cases."))]},
    "onboard_dose_rate": {
        "label": "Onboard radiation monitor dose rate", "cadence": "PT5M, MET day 412 only",
        "definition": "Absorbed dose rate reported by the habitat radiation monitor ([V2 6164] system), in the same "
                      "unit as MSL RAD. Absorbed dose (Gy) is not effective dose (Sv).",
        "calibration": []},  # filled from the SPE build (real vs fallback)
    "proton_flux_10mev": {
        "label": "Onboard proton monitor, >=10 MeV integral flux", "cadence": "PT5M, MET day 412 only",
        "definition": "Integral proton flux above 10 MeV in pfu (particles cm^-2 s^-1 sr^-1), the quantity the NOAA "
                      "S-scale is defined on, as read by the scenario's habitat proton monitor. The rules apply NOAA's "
                      "S3 level to it at Mars as a design choice (engine/rules/thresholds.json).",
        "calibration": []},  # filled from the SPE build (real vs fallback)
}

UNITS = {v: u for v, (u, _s, _n) in model.VARIABLES.items()}
UNITS.update({"vo2max": "ml/min/kg", "career_effective_dose": "mSv", "heart_rate": "bpm",
              "cabin_ppco2": "mmHg", "onboard_dose_rate": "uGy/day", "proton_flux_10mev": "pfu"})
SOURCES = {v: s for v, (_u, s, _n) in model.VARIABLES.items()}
SOURCES.update({"vo2max": "vehicle", "career_effective_dose": "app", "heart_rate": "band",
                "cabin_ppco2": "vehicle", "onboard_dose_rate": "vehicle",
                "proton_flux_10mev": "replay"})  # "vehicle" when the event shape is the synthetic fallback


def _series(var: str, pts: list[tuple[int, float | int]]) -> dict:
    return {"unit": UNITS[var], "source": SOURCES[var], "t": [t for t, _ in pts], "v": [v for _, v in pts]}


def build_crew() -> tuple[list[dict], list[dict]]:
    crew_out, evidence = [], []
    for c in model.CREW:
        tl = model.crew_timeline(c)
        evidence += tl["evidence"]
        series = {var: _series(var, tl["points"][var]) for var in model.PERSONAL_VARIABLES}
        series["vo2max"] = _series("vo2max", tl["vo2max"])
        series["career_effective_dose"] = _series("career_effective_dose",
                                                  [(model.met_s(412), c["career_effective_dose"])])
        hr = model.intraday_heart_rate(c, tl["episodes_by_day"][412], tl["daily"]["resting_hr"][412])
        crew_out.append({
            "crew_id": c["id"], "role": c["role"], "fictional": True,
            "series": series,
            "intraday": {"heart_rate": {"unit": "bpm", "source": "band", "start_t": model.met_s(412), "step_s": 60,
                                        "n": len(hr), "v": hr}},
            "sleep_episodes": {"note": "[onset_t, offset_t] MET seconds of the main sleep episode ending on each "
                                       f"MET day {model.FIRST_DAY}-{model.LAST_DAY}",
                               "days": [model.FIRST_DAY, model.LAST_DAY], "v": tl["sleep_episodes"]},
        })
    return crew_out, evidence


def _spe_calibration(spe: dict) -> list[dict]:
    base, shape = spe["baseline"], spe["shape"]
    out = [_cal("quiet-time baseline", f"{base['value']} uGy/day (noise SD {base['noise_sd']})", base["chip"],
                base["source"])]
    if shape["mode"] == "real":
        out.append(_cal("event shape", "NOAA NCEI GOES-7 >10 MeV flux, 19-21 Oct 1989, native 5-min samples",
                        "derived", {"kind": "derived", "from": ["swpc_spe_replay"],
                                    "arithmetic": shape["mapping"]["rule"]}))
    else:
        out.append(_cal("event shape", "synthetic placeholder", "design choice", _dc(shape["mapping"]["rule"])))
    out.append(_cal("flux-to-dose scaling", "NOAA S3 flux (1,000 pfu) = 10x baseline", spe["scaling"]["chip"],
                    spe["scaling"]["source"]))
    return out


def _proton_calibration(spe: dict) -> list[dict]:
    shape = spe["shape"]
    if shape["mode"] == "real":
        out = [_cal("flux values", "NOAA NCEI GOES-7 >10 MeV integral flux, 19-21 Oct 1989, native 5-min samples, "
                                   "time-shifted only", "derived",
                    {"kind": "derived", "from": ["swpc_spe_replay"], "arithmetic": shape["mapping"]["rule"]})]
    else:
        out = [_cal("flux values", "synthetic placeholder", "design choice", _dc(shape["mapping"]["rule"]))]
    out.append(_cal("reading at a Mars habitat", "Earth-orbit flux used as the habitat monitor reading", "design choice",
                    _dc("Scenario assumption: no heliocentric-distance, shielding or atmospheric correction is applied. "
                        "A real monitor at Mars would read a different (for a surface habitat, attenuated) flux.")))
    return out


def _caveats(spe: dict, cal: dict) -> list[str]:
    base, shape = spe["baseline"], spe["shape"]
    cav = [
        "SIMULATED SCENARIO - NOT CREW DATA. Continuous crew vitals are simulated because no public time series of "
        "real crew wearable data exists. Every crew value is produced by a seeded generator "
        f"(seed {model.SEED}; ingest/_sim_model.py) and is identical on every re-run.",
        "Calibration sources: Barger et al. 2014, Lancet Neurol (ISS actigraphic sleep 6.09 h per night; 12 of 16 "
        "ISS crew used sleep-promoting drugs) for sleep duration; Basner, Mollicone & Dinges 2011, Acta Astronaut "
        "(PVT-B lapse = RT >= 355 ms) for the lapse definition; the CSA Bio-Monitor / Hexoskin Astroskin channel "
        "cadences (300-s HRV windows, 1-Hz skin temperature) for the band summaries, as recorded in the project plan "
        "from the product's datatype registry (not re-verified by this generator); SPEC section 7 for the episode "
        "script. Everything else is a design choice, listed per variable in data.variables[*].calibration.",
        "CM-1..CM-4 are fictional: no names, no real PII. Mood is simulated for everyone, private by default and "
        "never alerts.",
        "Episodes are scripted, not discovered: magnitudes are set so the RCI reaches |rc| >= 6 for any r in "
        "[0.5, 0.9]; non-episode days are drawn within 1.4 baseline SDs so no unintended reliable change appears "
        "for r <= 0.9. Real data would contain such changes at the printed false-alarm rate, and real day-to-day "
        "variability is larger than the deliberately low SDs used here.",
        "Daily values are stamped when their measurement window closes, so 'now' (MET 0412/14:20:00) has no 24-h "
        "urine, fluid or daytime-light value for day 412 yet: that day is incomplete.",
        "career_effective_dose is a design-choice prior (mSv), not a calculation. The SPE day's absorbed dose rate "
        "(uGy/day) is never converted to effective dose: LANDFALL makes no personal dose projection.",
    ]
    if shape["mode"] == "real":
        cav.append("SPE day: the event TIME PROFILE is REAL (NOAA NCEI GOES-7 >10 MeV proton flux, October 1989, read "
                   "from swpc_spe_replay) and only time-shifted, so its first S3-level sample lands at MET "
                   "0412/14:15:00. vehicle.series.proton_flux_10mev carries that replayed flux unchanged as the "
                   "habitat proton-monitor reading; vehicle.series.onboard_dose_rate is the same profile under an "
                   "assumed flux-to-dose scaling. GOES measured in Earth orbit: using its flux as the reading at a Mars "
                   "habitat (no distance, shielding or atmospheric correction) is a scenario assumption.")
    else:
        cav.append("SPE day FALLBACK: swpc_spe_replay was not usable (" + str(shape.get("error") or
                   "file absent") + "), so the event shape is SYNTHETIC. Re-run `python -m ingest --all` after the "
                   "swpc adapter to replay the real October 1989 event.")
    if base["mode"] == "real":
        cav.append(f"SPE day: the quiet-time baseline is REAL: the median MSL RAD '{base['parameter']}' dose rate, "
                   f"{base['value']} uGy/day, read from hapi_msl_rad_dose. The flux-to-dose scaling (S3 flux = 10x "
                   "baseline) is an ASSUMPTION standing in for shielding, distance and atmospheric transport, not a "
                   "radiation-transport calculation.")
    else:
        cav.append("SPE day FALLBACK: hapi_msl_rad_dose was not usable, so the baseline is a design-choice "
                   f"placeholder of {base['value']} uGy/day. The flux-to-dose scaling is an assumption in any case.")
    if cal["mode"] == "horizons":
        cav.append("Calendar: MET day 412 is mapped into a REAL Mars solar-conjunction window taken from "
                   f"horizons_mars_comms ({cal['window_utc']['start']} to {cal['window_utc']['stop']}); the mission, "
                   "its launch date (MET epoch) and the pairing with the 1989 event are fictional.")
        if cal["blackout_remaining_at_now_s"] < env.MIN_REMAINING_S:
            cav.append("WARNING: the selected conjunction window is shorter than 10 days, so less than 10 days of "
                       "blackout remain at 'now'.")
    else:
        cav.append("Calendar PLACEHOLDER: horizons_mars_comms was not usable (" + str(cal.get("error") or
                   "file absent") + "). The conjunction blackout is a MET-only placeholder (3 days before to "
                   "11 d 06 h after 'now') and no calendar date is claimed. Re-run `python -m ingest --all` after "
                   "the horizons adapter.")
    return cav


def _episode_json(ep: dict) -> dict:
    return {"id": ep["id"], "case_id": ep["case_id"], "crew_id": ep["crew_id"], "summary": ep["summary"],
            "scripted_values": {var: {str(d): x for d, x in by.items()} for var, by in ep["values"].items()},
            "robust_days": {var: [ds[0], ds[-1]] for var, ds in ep["robust_days"].items()}}


def build_snapshot(out_dir: Path, retrieved_at: str) -> dict:
    replay, replay_err = env.load_snapshot(out_dir, "swpc_spe_replay")
    rad, rad_err = env.load_snapshot(out_dir, "hapi_msl_rad_dose")
    hz, hz_err = env.load_snapshot(out_dir, "horizons_mars_comms")
    crew, evidence = build_crew()
    spe = env.build_spe_day(replay, rad)
    if spe["shape"]["mode"] == "fallback" and not spe["shape"].get("error"):
        spe["shape"]["error"] = replay_err
    if spe["baseline"]["mode"] == "fallback" and not spe["baseline"].get("error"):
        spe["baseline"]["error"] = rad_err
    cal = env.build_calendar(hz)
    if cal["mode"] == "placeholder" and not cal.get("error"):
        cal["error"] = hz_err
    ppco2 = model.cabin_ppco2()
    proton_source = "replay" if spe["shape"]["mode"] == "real" else "vehicle"

    variables = {}
    for var, meta in VARIABLE_META.items():
        m = {"unit": UNITS[var], "source": SOURCES[var], **meta}
        if var == "onboard_dose_rate":
            m["calibration"] = _spe_calibration(spe)
        if var == "proton_flux_10mev":
            m["calibration"] = _proton_calibration(spe)
            m["source"] = proton_source
        variables[var] = m

    inputs = [x for x in (spe["baseline"].get("input"), spe["shape"].get("input"), cal.get("input")) if x]
    access = [GENERATOR_URL] + [f"web/public/data/{x['snapshot']}.json" for x in inputs] + [x["url"] for x in inputs]

    now = model.NOW_MET_S
    data = {
        "scenario": "LANDFALL demo scenario (engine/SPEC.md section 7)",
        "generator": {"module": "ingest/sim_crew.py (+ ingest/_sim_model.py, ingest/_sim_env.py)", "seed": model.SEED,
                      "rng": "random.Random(f'{seed}:{stream}') per crewmember x variable; random() and gauss() only",
                      "deterministic": True},
        "met": {"day_s": model.DAY_S, "first_day": model.FIRST_DAY, "last_day": model.LAST_DAY,
                "baseline_days": [model.BASELINE_FIRST, model.BASELINE_LAST],
                "now_met_s": now, "now": model.format_met(now),
                "convention": "MET = integer seconds since MET epoch; day = floor(MET / 86400), so MET day 412 "
                              "starts at 35,596,800 s"},
        "calendar": cal,
        "observation_format": {
            "expand": "for each series: observation = {crew_id, variable, value: v[i], unit, t: t[i] (or "
                      "start_t + i*step_s), source, provenance: 'simulated'}; vehicle series have crew_id null",
            "t_meaning": "MET seconds when the value became available (end of its measurement window)",
            "missing": "null = no sample (a gap to show as stale/missing per [V2 10020]); never zero"},
        "variables": variables,
        "crew": crew,
        "vehicle": {
            "series": {
                "cabin_ppco2": {"unit": "mmHg", "source": "vehicle", "crew_id": None,
                                "start_t": model.met_s(model.FIRST_DAY), "step_s": 3600, "n": len(ppco2),
                                "t_meaning": "value k is the mean over [start_t + k*3600, start_t + (k+1)*3600)",
                                "v": ppco2},
                "onboard_dose_rate": {"unit": "uGy/day", "source": "vehicle", "crew_id": None,
                                      **spe["series"], "after_now": spe["after_now"]},
                "proton_flux_10mev": {
                    "unit": "pfu", "source": proton_source, "crew_id": None,
                    "start_t": spe["series"]["start_t"], "step_s": spe["series"]["step_s"], "n": spe["series"]["n"],
                    "v": spe["series"]["source_flux_pfu"],
                    "after_now": {"start_t": spe["after_now"]["start_t"], "step_s": spe["after_now"]["step_s"],
                                  "n": spe["after_now"]["n"], "v": spe["after_now"]["source_flux_pfu"],
                                  "note": spe["after_now"]["note"]}}}},
        "spe_day": {
            "met_day": 412, "environment": "mars_surface",
            "baseline": {k: v for k, v in spe["baseline"].items() if k != "input"},
            "shape": {k: v for k, v in spe["shape"].items() if k != "input"},
            "scaling": spe["scaling"], "crossings": spe["crossings"],
            "value_at_now": spe["value_at_now"], "multiple_of_baseline_at_now": spe["multiple_of_baseline_at_now"],
            "noaa_scale_available": False,
            "note": "At Mars no NOAA alert reaches the crew (noaa_scale_available false). The habitat proton monitor "
                    "reading (vehicle.series.proton_flux_10mev) is the time-shifted Earth-orbit replay with no "
                    "distance, shielding or atmospheric correction (a scenario assumption); applying NOAA's S3 level "
                    "to it is a design choice of engine/rules/thresholds.json. onboard_dose_rate is the same profile "
                    "under the assumed flux-to-dose scaling; source_flux_pfu repeats the flux beside each dose sample "
                    "for auditing."},
        "episodes": [_episode_json(ep) for ep in model.EPISODES],
        "ffd_demo": {"crew_id": "CM-2", "variable": "vo2max", "value": model.CREW_BY_ID["CM-2"]["vo2max"][-1],
                     "unit": "ml/min/kg", "t": model.met_s(model.FITNESS_TEST_DAYS[-1], 10.0),
                     "expect": "within the microgravity-EVA floor (32.9, [V1 4001]); outside the surface-EVA floor "
                               "(36.5, [V1 4002])"},
        "self_check": {
            "method": "SPEC section 5 RCI: rc = (x - mean) / (sqrt(2) * sd * sqrt(1 - r)), sd = sample SD (n-1); "
                      "at r = 0.5 |rc| = |x - mean| / sd, and |rc| grows with r",
            "episodes": evidence,
            "non_episode_bound_sd": model.QUIET_Q,
            "non_episode_max_abs_rc_at_r_0_9": round(model.QUIET_Q / (2 * 0.1) ** 0.5, 2)},
        "inputs": inputs,
    }
    if cal["mode"] == "horizons":
        epoch = env.parse_iso(cal["met_epoch_utc"])
        coverage = {"start": to_iso_z(epoch + timedelta(seconds=model.met_s(model.FIRST_DAY))),
                    "stop": cal["now_utc"], "cadence": None}
    else:
        coverage = {"start": None, "stop": None, "cadence": None}
    return make_snapshot(
        id=SNAPSHOT_ID, adapter=ADAPTER_ID,
        title="Simulated crew scenario: 4 fictional crewmembers, MET days 368-412 (seeded, labelled)",
        source={"publisher": "LANDFALL project (simulated scenario generator)",
                "name": f"LANDFALL seeded crew scenario, seed {model.SEED} (ingest/sim_crew.py)",
                "url": GENERATOR_URL, "access_urls": access,
                "license": "Apache-2.0 (LANDFALL). Replayed inputs keep their publishers' terms; see their snapshots.",
                "citation": (f"LANDFALL simulated crew scenario (seed {model.SEED}), ingest/sim_crew.py, {REPO_URL}. "
                             "Calibrated against Barger et al. 2014 (PMID 25127232) and Basner et al. 2011 "
                             "(PMID 22025811); SPE shape from NOAA NCEI GOES-07 EPS (October 1989); Mars-surface "
                             "baseline from NASA CCMC iSWA MSL RAD; conjunction window from JPL Horizons when present.")},
        retrieved_at=retrieved_at,
        coverage=coverage,
        freshness={"kind": "historical", "stale_after": None},
        provenance="simulated",
        caveats=_caveats(spe, cal),
        data=data)


def run(ctx: RunContext) -> list[dict]:
    return [build_snapshot(ctx.out_dir, ctx.retrieved_at)]
