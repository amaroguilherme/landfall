"""Seeded crew physiology for the LANDFALL demo scenario (engine/SPEC.md section 7).

Pure functions only: no I/O, no network, no clock. Every random draw comes from a
`random.Random` seeded with a string built from SEED, so the output is identical on every
run and platform (string seeds are hashed with SHA-512 by CPython, independent of
PYTHONHASHSEED). Only `Random.random()` and `Random.gauss()` are used, whose algorithms
have been stable across CPython releases.

Design (all of it a scenario design choice, stated in the snapshot):
- Day-to-day noise is a plain draw from the noise model in NOISE on every baseline and
  non-episode day. Nothing is rejection-sampled or trimmed to keep the personal bands narrow.
  The SDs follow published within-person (day-to-day) values where they exist; sim_crew.py
  prints the source of each one, and the rest are labelled design choices.
- Episode days carry scripted physical values (EPISODES), chosen to be physiologically
  plausible, not to clear Tier B. `tier_b_report` then runs Tier B's single-case test
  (SPEC section 5: t = (x - mean) / (sd * sqrt(1 + 1/n)), df = n - 1, two-tailed alpha 0.001)
  on every crewmember, indicator and day, exactly as the engine does, and reports without
  raising which scripted days it flags, which it misses, every unscripted (chance) flag, the
  smallest change each personal band can flag, and a seeded Monte Carlo detection probability
  for every scripted day under the same noise model.
- `sleep_midpoint_shift` is the ABSOLUTE shift, in hours, of the night's sleep midpoint from the
  median midpoint of the fixed baseline nights (engine/rules/personal.json; lead decision D9).
"""

from __future__ import annotations

import math
import random
import statistics

SEED = 20261114
DAY_S = 86400
FIRST_DAY, LAST_DAY = 368, 412
BASELINE_FIRST, BASELINE_LAST = 368, 381
N_BASELINE_DAYS = BASELINE_LAST - BASELINE_FIRST + 1
NOW_MET_S = 412 * DAY_S + 14 * 3600 + 20 * 60  # MET 412/14:20:00
ALPHA_TWO_TAILED = 0.001
# Tier B's critical value for the 14-day baseline: two-tailed alpha 0.001, df 13, as the engine computes
# it (engine.t_critical(0.001, 13); published t tables print 4.221). ingest/tests/test_sim.py checks it.
CRITICAL_T = 4.2208317280747
SCHEDULE_REF_MIDPOINT_H = 2.0   # 02:00 MET: midpoint of the pre-shift sleep period 22:00-06:00
FITNESS_TEST_DAYS = (369, 383, 397, 411)
NOON_SIGHT_H = 12.0             # daily check-in (mood) at 12:00 MET
MANUAL_CHECK_AFTER_WAKE_S = 1800  # cuff and fingerstick: 30 min after wake, before breakfast
PVT_AFTER_WAKE_S = 3600
# Manual vitals (cuff blood pressure, fingerstick glucose): daily on the 14 baseline days so the
# personal baseline has n = 14, then twice a week (MET days 382, 385, 389, 392, ...).
MANUAL_VITALS_BASELINE_DAILY = True
MANUAL_VITALS_WEEKDAYS = (0, 3)   # (day - 382) % 7 in this set after the baseline
# Habitat ppCO2 is kept clearly below the 2.4 mmHg approach level of rule pel_cabin_ppco2_1h
# (engine/rules/thresholds.json; [V2 6004] limit 3 mmHg), so it never competes with the cases.
PPCO2_CAP_MMHG = 2.3
# Hard floor for an unintended renal case: no non-episode 24-h urine value may fall below it.
RENAL_OUTSIDE_ML = 1500
MC_REPS = 2000                  # Monte Carlo baselines per scripted day (seeded)

# variable -> (unit, observation source, rounding decimals; None = integer, -1 = tens)
VARIABLES: dict[str, tuple[str, str, int | None]] = {
    "sleep_duration": ("h", "band", 2),
    "sleep_midpoint_shift": ("h", "band", 2),
    "pvt_lapses": ("count", "app", None),
    "pvt_median_rt": ("ms", "app", None),
    "light_exposure_daytime": ("lux", "band", None),
    "resting_hr": ("bpm", "band", 1),
    "hrv_sdnn": ("ms", "band", 1),
    "skin_temp": ("°C", "band", 2),
    "urine_volume_24h": ("mL", "manual", -1),
    "fluid_intake_24h": ("mL", "manual", -1),
    "mood": ("score_1_5", "app", None),
    "bp_systolic": ("mmHg", "manual", None),
    "bp_diastolic": ("mmHg", "manual", None),
    "glucose": ("mg/dL", "manual", None),
}
PERSONAL_VARIABLES = tuple(VARIABLES)
MANUAL_VITALS = ("bp_systolic", "bp_diastolic", "glucose")
DAILY_VARIABLES = tuple(v for v in VARIABLES if v not in MANUAL_VITALS)

# ---------------------------------------------------------------------------------------------
# Day-to-day (within-person) noise. Numbers only; sim_crew.py prints the basis of each.
# ---------------------------------------------------------------------------------------------
# Nayan et al. 2012, Table 1: mean absolute difference between two consecutive-day 24-h urine
# collections, 385.4 mL. For two independent normal draws E|X1 - X2| = 2 sd / sqrt(pi), so
# sd = 385.4 * sqrt(pi) / 2 = 341.6 mL.
URINE_MEAN_ABS_DIFF_ML = 385.4
URINE_SD_ML = URINE_MEAN_ABS_DIFF_ML * math.sqrt(math.pi) / 2.0
FLUID_MINUS_URINE_ML = 550.0      # intake - output: food water, sweat and insensible losses (design)
FLUID_EXTRA_SD_ML = 150.0         # day-to-day spread of that difference (design)
GLUCOSE_CV_BIOLOGICAL = 0.057     # Selvin et al. 2007: within-person CV of fasting glucose
GLUCOSE_CV_METER = 0.03           # fingerstick meter imprecision (design)
GLUCOSE_CV = math.sqrt(GLUCOSE_CV_BIOLOGICAL ** 2 + GLUCOSE_CV_METER ** 2)
MIDPOINT_SD_ALT_H = 58.0 / 60.0   # Huang & Redline 2019 (MESA): weekday sleep-onset SD, 58 min

NOISE: dict[str, dict] = {
    "sleep_duration": {"model": "normal", "sd": 1.2, "clip": (2.5, 9.0)},
    "sleep_midpoint": {"model": "normal", "sd": 0.6},          # signed clock offset; internal only
    "pvt_lapses": {"model": "poisson"},                         # mean per crewmember
    "pvt_median_rt": {"model": "normal", "sd": 14.0},
    "light_exposure_daytime": {"model": "normal_cv", "cv": 0.20, "clip": (20.0, None)},
    "resting_hr": {"model": "normal", "sd": 3.0},
    "hrv_sdnn": {"model": "normal_cv", "cv": 0.15, "clip": (10.0, None)},
    "skin_temp": {"model": "normal", "sd": 0.30},
    "urine_volume_24h": {"model": "normal", "sd": URINE_SD_ML, "clip": (300.0, None)},
    "fluid_intake_24h": {"model": "urine_plus", "offset": FLUID_MINUS_URINE_ML, "extra_sd": FLUID_EXTRA_SD_ML,
                         "sd": math.sqrt(URINE_SD_ML ** 2 + FLUID_EXTRA_SD_ML ** 2)},
    "mood": {"model": "categorical"},
    "bp_systolic": {"model": "normal", "sd": 6.0},
    "bp_diastolic": {"model": "normal", "sd": 5.0, "rho_with_systolic": 0.6},
    "glucose": {"model": "normal_cv", "cv": GLUCOSE_CV},
}

# Individual (fictional) baselines: the crewmember's own mean of each variable. pvt_lapses is the
# Poisson mean of a rested test; mood gives the probability of each score 1..5.
CREW: list[dict] = [
    {"id": "CM-1", "role": "Commander",
     "sleep_duration": 6.10, "sleep_midpoint": -0.10, "waso_h": 0.35,
     "pvt_lapses": 1.0, "pvt_median_rt": 252, "light_exposure_daytime": 238,
     "resting_hr": 55.0, "hrv_sdnn": 61.0, "skin_temp": 34.30,
     "urine_volume_24h": 2950, "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "bp_systolic": 118, "bp_diastolic": 75, "glucose": 90,
     "vo2max": (43.9, 43.5, 43.2, 42.9), "career_effective_dose": 412,
     "hr_wake": 71, "hr_exercise": 141, "exercise_h": (16.0, 17.0)},
    {"id": "CM-2", "role": "Flight Engineer",
     "sleep_duration": 6.30, "sleep_midpoint": 0.05, "waso_h": 0.30,
     "pvt_lapses": 1.2, "pvt_median_rt": 246, "light_exposure_daytime": 251,
     "resting_hr": 58.0, "hrv_sdnn": 54.0, "skin_temp": 34.10,
     "urine_volume_24h": 3000, "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "bp_systolic": 112, "bp_diastolic": 71, "glucose": 94,
     "vo2max": (37.2, 36.4, 35.7, 35.1), "career_effective_dose": 371,
     "hr_wake": 74, "hr_exercise": 138, "exercise_h": (8.0, 9.0)},
    {"id": "CM-3", "role": "Mission Specialist",
     "sleep_duration": 5.95, "sleep_midpoint": -0.20, "waso_h": 0.40,
     "pvt_lapses": 0.9, "pvt_median_rt": 259, "light_exposure_daytime": 229,
     "resting_hr": 52.0, "hrv_sdnn": 67.0, "skin_temp": 34.40,
     "urine_volume_24h": 2900, "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "bp_systolic": 109, "bp_diastolic": 68, "glucose": 86,
     "vo2max": (41.8, 41.5, 41.4, 41.1), "career_effective_dose": 356,
     "hr_wake": 68, "hr_exercise": 136, "exercise_h": (10.0, 11.0)},
    {"id": "CM-4", "role": "Crew Medical Officer",
     "sleep_duration": 6.20, "sleep_midpoint": 0.10, "waso_h": 0.35,
     "pvt_lapses": 1.1, "pvt_median_rt": 249, "light_exposure_daytime": 244,
     "resting_hr": 54.0, "hrv_sdnn": 63.0, "skin_temp": 34.20,
     "urine_volume_24h": 2980, "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "bp_systolic": 115, "bp_diastolic": 73, "glucose": 89,
     "vo2max": (45.6, 45.3, 45.0, 44.8), "career_effective_dose": 389,
     "hr_wake": 69, "hr_exercise": 144, "exercise_h": (13.0, 14.0)},
]
CREW_BY_ID = {c["id"]: c for c in CREW}

# Scripted episodes (physical values per MET day). They are written to be plausible, then tested:
# nothing here is tuned so that Tier B flags it.
EPISODES: list[dict] = [
    {"id": "renal_hydration", "case_id": "renal_stone", "crew_id": "CM-3",
     "summary": "24-h urine output falls below 1,500 mL/day (the outside level of rule target_urine_output_24h "
                "in engine/rules/thresholds.json) on MET days 398-401 while fluid intake falls as well; both "
                "recover from day 402. The Tier A target crossing is scripted; whether Tier B also flags the "
                "drop is tested, not assumed (data.self_check).",
     "values": {
         "urine_volume_24h": {398: 1430, 399: 1380, 400: 1340, 401: 1450},
         "fluid_intake_24h": {398: 2010, 399: 1890, 400: 1840, 401: 1960}},
     "tier_a": {"rule_id": "target_urine_output_24h", "variable": "urine_volume_24h", "days": (398, 399, 400, 401)}},
    {"id": "sleep_shift", "case_id": "sleep_circadian", "crew_id": "CM-1",
     "summary": "On MET day 403 CM-1's work schedule shifts 3 h later and the sleep opportunity is shortened "
                "to about 5 h (vehicle-operations support). From the night ending on day 404 sleep is about "
                "4.3-4.6 h, its midpoint sits about 2.3-2.6 h later than the baseline nights, and PVT-B "
                "lapses and median reaction time rise moderately. The episode is still running at 'now' "
                "(no countermeasure is applied in the data, so the case can be acted on in the demo). There "
                "is no Tier A rule for any of these indicators: if Tier B does not flag them, nothing does "
                "(data.self_check).",
     "values": {
         "sleep_duration": dict(zip(range(404, 413), (4.55, 4.40, 4.35, 4.50, 4.30, 4.45, 4.40, 4.50, 4.35))),
         "sleep_midpoint": dict(zip(range(404, 413), (2.30, 2.45, 2.40, 2.55, 2.35, 2.50, 2.45, 2.40, 2.50))),
         "pvt_lapses": dict(zip(range(404, 413), (2, 3, 3, 4, 5, 4, 5, 6, 5))),
         "pvt_median_rt": dict(zip(range(404, 413), (259, 263, 268, 272, 277, 275, 281, 284, 280))),
         "mood": dict(zip(range(405, 413), (3, 3, 2, 2, 3, 2, 2, 3)))},
     "waso_h_from_day": (404, 0.60)},
]


def rng_for(*parts: object) -> random.Random:
    return random.Random(":".join(str(p) for p in (SEED, *parts)))


def met_s(day: int, hour: float = 0.0) -> int:
    return int(round(day * DAY_S + hour * 3600))


def format_met(seconds: int) -> str:
    """MET as 'ddd/hh:mm:ss' with no leading zeros in the day field (NASA-STD-3001 Vol 2 F.6.1 f)."""
    sign = "-" if seconds < 0 else ""
    d, rem = divmod(abs(int(seconds)), DAY_S)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    return f"{sign}{d}/{h:02d}:{m:02d}:{s:02d}"


def measurement_day(t: int) -> int:
    """MET day an observation belongs to: the day its window ENDED (as the engine and app read it)."""
    return (int(t) - 1) // DAY_S


def _round(x: float, nd: int | None) -> float | int:
    if nd is None:
        return int(round(x))
    if nd < 0:
        return int(round(x, nd))
    return round(x, nd) + 0.0  # + 0.0 turns -0.0 into 0.0


def _clip(x: float, bounds: tuple | None) -> float:
    if not bounds:
        return x
    lo, hi = bounds
    if lo is not None and x < lo:
        return lo
    if hi is not None and x > hi:
        return hi
    return x


def _categorical(rng: random.Random, probs: tuple[float, ...], offset: int) -> int:
    u, acc = rng.random(), 0.0
    for i, p in enumerate(probs):
        acc += p
        if u < acc:
            return i + offset
    return len(probs) - 1 + offset


def _poisson(rng: random.Random, lam: float) -> int:
    """Knuth's multiplication method (fine for the small means used here); random() only."""
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


def draw(rng: random.Random, var: str, mean, nd_var: str | None = None) -> float | int:
    """One day-to-day draw of `var` around this crewmember's own mean (urine/fluid/BP are joint: see below)."""
    spec = NOISE[var]
    nd = VARIABLES[nd_var or var][2] if (nd_var or var) in VARIABLES else 2
    model = spec["model"]
    if model == "categorical":
        return _categorical(rng, mean, 1)
    if model == "poisson":
        return _poisson(rng, mean)
    if model == "normal":
        x = rng.gauss(mean, spec["sd"])
    elif model == "normal_cv":
        x = rng.gauss(mean, spec["cv"] * mean)
    else:
        raise ValueError(f"{var}: model {model!r} is drawn jointly, not here")
    return _round(_clip(x, spec.get("clip")), nd)


def baseline_stats(values: list[float]) -> tuple[float, float]:
    return statistics.fmean(values), statistics.stdev(values)


def single_case_t(baseline: list[float], current: float) -> float | None:
    """SPEC section 5 (Crawford & Howell 1998): t = (x - mean) / (sd * sqrt(1 + 1/n)), sd = sample SD (n-1)."""
    m, sd = baseline_stats(baseline)
    if sd == 0:
        return None
    return (current - m) / (sd * math.sqrt(1.0 + 1.0 / len(baseline)))


def wrap_hours(dh: float) -> float:
    """Clock difference in hours wrapped to (-12, 12] (midnight arithmetic)."""
    x = math.fmod(dh + 12.0, 24.0)
    if x <= 0:
        x += 24.0
    return x - 12.0


def episode_for(crew_id: str) -> list[dict]:
    return [e for e in EPISODES if e["crew_id"] == crew_id]


def _scripted(crew_id: str) -> dict[str, dict[int, float | int]]:
    out: dict[str, dict[int, float | int]] = {}
    for ep in episode_for(crew_id):
        for var, by_day in ep["values"].items():
            out.setdefault(var, {}).update(by_day)
    return out


def manual_vitals_days() -> list[int]:
    days = []
    for d in range(FIRST_DAY, LAST_DAY + 1):
        if d <= BASELINE_LAST:
            if MANUAL_VITALS_BASELINE_DAILY or (d - BASELINE_FIRST) % 7 in MANUAL_VITALS_WEEKDAYS:
                days.append(d)
        elif (d - (BASELINE_LAST + 1)) % 7 in MANUAL_VITALS_WEEKDAYS:
            days.append(d)
    return days


def absolute_midpoint_shift(mid: dict[int, float]) -> tuple[dict[int, float], float]:
    """|midpoint - median baseline midpoint| per day (h), and that median (signed offset from 02:00 MET)."""
    med = statistics.median(mid[d] for d in range(BASELINE_FIRST, BASELINE_LAST + 1))
    return {d: _round(abs(wrap_hours(v - med)), 2) for d, v in mid.items()}, med


def daily_values(crew: dict) -> dict[str, dict[int, float | int]]:
    """{variable: {day: value}} for MET days FIRST_DAY..LAST_DAY (before timestamp filtering).

    Every day is drawn (episode days too, so the random streams stay aligned) and the scripted
    episode value then replaces the draw. Plus the internal signed midpoint, 'sleep_midpoint'.
    """
    cid = crew["id"]
    scripted = _scripted(cid)
    days = range(FIRST_DAY, LAST_DAY + 1)
    out: dict[str, dict[int, float | int]] = {}
    independent = ("sleep_duration", "pvt_lapses", "pvt_median_rt", "light_exposure_daytime",
                   "resting_hr", "hrv_sdnn", "skin_temp", "mood")
    for var in independent:
        rng = rng_for(cid, var)
        out[var] = {}
        for d in days:
            x = draw(rng, var, crew[var])
            out[var][d] = scripted.get(var, {}).get(d, x)
    # Signed sleep midpoint (h from 02:00 MET), then the emitted absolute shift (D9).
    rng = rng_for(cid, "sleep_midpoint")
    mid: dict[int, float] = {}
    for d in days:
        x = _round(rng.gauss(crew["sleep_midpoint"], NOISE["sleep_midpoint"]["sd"]), 2)
        mid[d] = scripted.get("sleep_midpoint", {}).get(d, x)
    out["sleep_midpoint"] = mid
    out["sleep_midpoint_shift"], _ = absolute_midpoint_shift(mid)
    # Hydration: intake and output share the day's drinking noise (output = intake - stable losses).
    rng = rng_for(cid, "hydration")
    u_mean = crew["urine_volume_24h"]
    out["urine_volume_24h"], out["fluid_intake_24h"] = {}, {}
    for d in days:
        e_u = rng.gauss(0.0, URINE_SD_ML)
        e_x = rng.gauss(0.0, FLUID_EXTRA_SD_ML)
        u = _round(_clip(u_mean + e_u, NOISE["urine_volume_24h"]["clip"]), -1)
        f = _round(u_mean + FLUID_MINUS_URINE_ML + e_u + e_x, -1)
        out["urine_volume_24h"][d] = scripted.get("urine_volume_24h", {}).get(d, u)
        out["fluid_intake_24h"][d] = scripted.get("fluid_intake_24h", {}).get(d, f)
    # Manual vitals on their measurement days only: cuff BP (correlated SBP/DBP noise), glucose.
    rng_bp, rng_g = rng_for(cid, "blood_pressure"), rng_for(cid, "glucose")
    rho = NOISE["bp_diastolic"]["rho_with_systolic"]
    out["bp_systolic"], out["bp_diastolic"], out["glucose"] = {}, {}, {}
    measured = set(manual_vitals_days())
    for d in days:
        z1, z2 = rng_bp.gauss(0.0, 1.0), rng_bp.gauss(0.0, 1.0)
        g = draw(rng_g, "glucose", crew["glucose"])
        if d not in measured:
            continue
        out["bp_systolic"][d] = _round(crew["bp_systolic"] + NOISE["bp_systolic"]["sd"] * z1, None)
        out["bp_diastolic"][d] = _round(crew["bp_diastolic"] + NOISE["bp_diastolic"]["sd"]
                                        * (rho * z1 + math.sqrt(1.0 - rho * rho) * z2), None)
        out["glucose"][d] = g
    return out


def check_scenario(crew_id: str, daily: dict[str, dict[int, float | int]]) -> None:
    """Raise only if the scenario's case set would change: an unscripted 24-h urine value below the
    renal outside level would open a renal case nobody scripted, and the scripted crossing must hold."""
    scripted = _scripted(crew_id).get("urine_volume_24h", {})
    for d, v in daily["urine_volume_24h"].items():
        if d in scripted:
            if v >= RENAL_OUTSIDE_ML:
                raise AssertionError(f"{crew_id} day {d}: scripted renal value {v} is not below {RENAL_OUTSIDE_ML}")
        elif v < RENAL_OUTSIDE_ML:
            raise AssertionError(f"{crew_id} day {d}: unscripted urine {v} mL < {RENAL_OUTSIDE_ML} would open a case")


def sleep_episode(crew: dict, day: int, daily: dict) -> tuple[int, int]:
    """(onset, offset) MET seconds of the main sleep episode that ends on `day`."""
    waso = crew["waso_h"]
    for ep in episode_for(crew["id"]):
        if "waso_h_from_day" in ep and day >= ep["waso_h_from_day"][0]:
            waso = ep["waso_h_from_day"][1]
    tst = daily["sleep_duration"][day]
    mid = SCHEDULE_REF_MIDPOINT_H + daily["sleep_midpoint"][day]
    period = tst + waso
    return met_s(day, mid - period / 2), met_s(day, mid + period / 2)


def crew_timeline(crew: dict) -> dict:
    """Timestamped series (only values whose measurement window has closed by NOW)."""
    daily = daily_values(crew)
    check_scenario(crew["id"], daily)
    episodes = {d: sleep_episode(crew, d, daily) for d in range(FIRST_DAY, LAST_DAY + 1)}
    pts: dict[str, list[tuple[int, float | int]]] = {v: [] for v in PERSONAL_VARIABLES}
    for d in range(FIRST_DAY, LAST_DAY + 1):
        onset, offset = episodes[d]
        next_onset = episodes[d + 1][0] if d + 1 in episodes else None
        stamp = {
            "sleep_duration": offset, "sleep_midpoint_shift": offset,
            "resting_hr": offset, "hrv_sdnn": offset, "skin_temp": offset,
            "pvt_lapses": offset + PVT_AFTER_WAKE_S, "pvt_median_rt": offset + PVT_AFTER_WAKE_S,
            "light_exposure_daytime": next_onset,          # wake period closes at the next sleep onset
            "urine_volume_24h": met_s(d + 1), "fluid_intake_24h": met_s(d + 1),  # MET-midnight collection
            "mood": met_s(d, NOON_SIGHT_H),
            "bp_systolic": offset + MANUAL_CHECK_AFTER_WAKE_S, "bp_diastolic": offset + MANUAL_CHECK_AFTER_WAKE_S,
            "glucose": offset + MANUAL_CHECK_AFTER_WAKE_S,
        }
        for var in PERSONAL_VARIABLES:
            if d not in daily[var]:
                continue
            t = stamp[var]
            if t is not None and t <= NOW_MET_S:
                pts[var].append((t, daily[var][d]))
    vo2 = [(met_s(d, 10.0), v) for d, v in zip(FITNESS_TEST_DAYS, crew["vo2max"])]
    sleep_eps = [[episodes[d][0], episodes[d][1]] for d in range(FIRST_DAY, LAST_DAY + 1)]
    return {"points": pts, "vo2max": vo2, "sleep_episodes": sleep_eps, "daily": daily,
            "episodes_by_day": episodes}


def intraday_heart_rate(crew: dict, sleep_412: tuple[int, int], resting_hr_412: float) -> list[int]:
    """1-min heart rate for MET day 412 from 00:00 to NOW inclusive (band PPG summaries)."""
    rng = rng_for(crew["id"], "heart_rate", 412)
    start = met_s(412)
    onset, offset = sleep_412
    ex0, ex1 = (met_s(412, h) for h in crew["exercise_h"])
    out, ar = [], 0.0
    for t in range(start, NOW_MET_S + 1, 60):
        ar = 0.85 * ar + rng.gauss(0.0, 1.2)
        if onset <= t < offset:
            # resting_hr is the lowest stable 5-min rate of the night, so the night's mean sits a little above it
            hr = resting_hr_412 + 2.5 + 0.6 * ar
        elif ex0 <= t < ex1:
            ramp = min(1.0, (t - ex0) / 600.0, (ex1 - t) / 300.0)
            hr = crew["hr_wake"] + ramp * (crew["hr_exercise"] - crew["hr_wake"]) + 1.5 * ar
        else:
            since_wake = (t - offset) / 3600.0 if t >= offset else 99.0
            settle = -6.0 if 0 <= since_wake < 0.5 else 0.0
            hr = crew["hr_wake"] + settle + 3.0 * math.sin(2 * math.pi * (t - start) / (6 * 3600)) + 2.0 * ar
        out.append(int(round(hr)))
    return out


def cabin_ppco2() -> list[float]:
    """Hourly 1-h mean cabin ppCO2 (mmHg); value k covers [k h, k+1 h) from MET day FIRST_DAY."""
    rng = rng_for("habitat", "cabin_ppco2")
    out, ar = [], 0.0
    t0 = met_s(FIRST_DAY)
    k = 0
    while t0 + (k + 1) * 3600 <= NOW_MET_S:
        hour = k % 24
        day = FIRST_DAY + k // 24
        awake = 7 <= hour < 22
        ar = 0.7 * ar + rng.gauss(0.0, 0.04)
        v = 1.85 + (0.20 if awake else 0.05) + 0.05 * math.sin(2 * math.pi * day / 7.0) + ar
        out.append(round(min(max(v, 1.5), PPCO2_CAP_MMHG), 2))
        k += 1
    return out


# ---------------------------------------------------------------------------------------------
# Tier B honesty report (D10): what the engine's single-case test sees in this exact data
# ---------------------------------------------------------------------------------------------
def model_sd(crew: dict, var: str) -> float | None:
    """SD of the EMITTED variable under the noise model (None for categorical mood)."""
    spec = NOISE.get(var)
    if var == "sleep_midpoint_shift":
        # |X - median| of normal noise: a half-normal with sd = sigma * sqrt(1 - 2/pi)
        return NOISE["sleep_midpoint"]["sd"] * math.sqrt(1.0 - 2.0 / math.pi)
    if spec is None or spec["model"] == "categorical":
        return None
    if spec["model"] == "poisson":
        return math.sqrt(crew[var])
    if spec["model"] == "normal_cv":
        return spec["cv"] * crew[var]
    return spec["sd"]


def mdc(sd: float | None, n: int = N_BASELINE_DAYS) -> float | None:
    """Smallest one-day change a personal band can flag: critical x SD x sqrt(1 + 1/n)."""
    if sd is None:
        return None
    return CRITICAL_T * sd * math.sqrt(1.0 + 1.0 / n)


def _flag(t: float | None, worse: str) -> tuple[bool, bool]:
    """(reliable change, in the worse direction)."""
    if t is None or abs(t) <= CRITICAL_T:
        return False, False
    if worse == "either":
        return True, True
    return True, (t > 0) == (worse == "increase")


def _simulate_baseline(rng: random.Random, crew: dict, var: str) -> tuple[list[float], float | None]:
    """14 baseline values of `var` from the generator's own noise model (and, for the midpoint, the median)."""
    n = N_BASELINE_DAYS
    if var == "sleep_midpoint_shift":
        mids = [_round(rng.gauss(crew["sleep_midpoint"], NOISE["sleep_midpoint"]["sd"]), 2) for _ in range(n)]
        med = statistics.median(mids)
        return [_round(abs(wrap_hours(m - med)), 2) for m in mids], med
    if var in ("urine_volume_24h", "fluid_intake_24h"):
        vals = []
        for _ in range(n):
            e_u, e_x = rng.gauss(0.0, URINE_SD_ML), rng.gauss(0.0, FLUID_EXTRA_SD_ML)
            u = crew["urine_volume_24h"]
            vals.append(_round(_clip(u + e_u, NOISE["urine_volume_24h"]["clip"]), -1) if var == "urine_volume_24h"
                        else _round(u + FLUID_MINUS_URINE_ML + e_u + e_x, -1))
        return vals, None
    return [draw(rng, var, crew[var]) for _ in range(n)], None


def detection_probability(crew: dict, var: str, value: float, worse: str, reps: int = MC_REPS,
                          signed_midpoint: float | None = None, midpoint_sd: float | None = None) -> float:
    """P(Tier B flags `value` in the worse direction | a fresh 14-day baseline from the noise model)."""
    key = ("power", crew["id"], var, value, worse, reps, signed_midpoint, midpoint_sd, SEED)
    if key in _MEMO:
        return _MEMO[key]
    rng = rng_for("power", crew["id"], var, value, midpoint_sd or "")
    hits = 0
    for _ in range(reps):
        if var == "sleep_midpoint_shift":
            sd = midpoint_sd or NOISE["sleep_midpoint"]["sd"]
            mids = [_round(rng.gauss(crew["sleep_midpoint"], sd), 2) for _ in range(N_BASELINE_DAYS)]
            med = statistics.median(mids)
            base = [_round(abs(wrap_hours(m - med)), 2) for m in mids]
            x = _round(abs(wrap_hours(signed_midpoint - med)), 2)
        else:
            base, _ = _simulate_baseline(rng, crew, var)
            x = value
        if len(set(base)) < 2:
            continue
        _, worse_hit = _flag(single_case_t(base, x), worse)
        hits += worse_hit
    _MEMO[key] = hits / reps
    return _MEMO[key]


def _simulate_days(rng: random.Random, crew: dict, var: str, n_days: int) -> list[float]:
    """`n_days` consecutive ordinary days of `var` from the noise model (no episode), baseline first."""
    if var == "sleep_midpoint_shift":
        mids = [_round(rng.gauss(crew["sleep_midpoint"], NOISE["sleep_midpoint"]["sd"]), 2) for _ in range(n_days)]
        med = statistics.median(mids[:N_BASELINE_DAYS])
        return [_round(abs(wrap_hours(m - med)), 2) for m in mids]
    if var in ("urine_volume_24h", "fluid_intake_24h"):
        out = []
        for _ in range(n_days):
            e_u, e_x = rng.gauss(0.0, URINE_SD_ML), rng.gauss(0.0, FLUID_EXTRA_SD_ML)
            u = crew["urine_volume_24h"]
            out.append(_round(_clip(u + e_u, NOISE["urine_volume_24h"]["clip"]), -1) if var == "urine_volume_24h"
                       else _round(u + FLUID_MINUS_URINE_ML + e_u + e_x, -1))
        return out
    if var in ("bp_systolic", "bp_diastolic"):
        rho, out = NOISE["bp_diastolic"]["rho_with_systolic"], []
        for _ in range(n_days):
            z1, z2 = rng.gauss(0.0, 1.0), rng.gauss(0.0, 1.0)
            z = z1 if var == "bp_systolic" else rho * z1 + math.sqrt(1.0 - rho * rho) * z2
            out.append(_round(crew[var] + NOISE[var]["sd"] * z, None))
        return out
    return [draw(rng, var, crew[var]) for _ in range(n_days)]


_MEMO: dict[tuple, object] = {}   # pure, seeded results reused within one process (tests build several times)


def _is_skewed(var: str) -> bool:
    return var == "sleep_midpoint_shift" or NOISE.get(var, {}).get("model") == "poisson"


def chance_rates(indicators: list[dict], reps_per_crew: int = 500) -> dict:
    """Chance-caution rate per indicator-day with NO real change, laid out like the scenario (fixed 14-day
    baseline, then each of the 31 later days tested against it). For normally distributed indicators it is
    alpha / 2 = 0.0005 exactly (alpha for worse = 'either'): Crawford & Howell's test is exact for normal,
    independent noise. For the skewed ones (Poisson lapse counts, the absolute midpoint shift) it is a seeded
    Monte Carlo with the generator's own noise model for every crewmember."""
    later = LAST_DAY - BASELINE_LAST
    out = {}
    for ind in indicators:
        var, worse = ind["variable"], ind["worse"]
        nominal = ALPHA_TWO_TAILED if worse == "either" else ALPHA_TWO_TAILED / 2
        if not _is_skewed(var):
            out[ind["id"]] = {"variable": var, "worse": worse, "method": "exact (normal, independent noise)",
                              "chance_rate_per_indicator_day": nominal, "nominal_rate": nominal,
                              "ratio_to_nominal": 1.0}
            continue
        key = ("chance", var, worse, reps_per_crew, SEED)
        if key not in _MEMO:
            hits = tests = 0
            for crew in CREW:
                rng = rng_for("chance", crew["id"], var)
                for _ in range(reps_per_crew):
                    vals = _simulate_days(rng, crew, var, N_BASELINE_DAYS + later)
                    base = vals[:N_BASELINE_DAYS]
                    if len(set(base)) < 2:
                        continue
                    for x in vals[N_BASELINE_DAYS:]:
                        tests += 1
                        _, w = _flag(single_case_t(base, x), worse)
                        hits += w
            _MEMO[key] = (hits, tests)
        hits, tests = _MEMO[key]
        rate = hits / tests
        out[ind["id"]] = {"variable": var, "worse": worse,
                          "method": f"seeded Monte Carlo, {tests:,} tests with no real change",
                          "chance_rate_per_indicator_day": round(rate, 5), "nominal_rate": nominal,
                          "ratio_to_nominal": round(rate / nominal, 1)}
    return out


def tier_b_report(timelines: dict[str, dict], indicators: list[dict], tier_a: dict | None = None) -> dict:
    """Run Tier B on the shipped points exactly as the engine and app do (fixed baseline days 368-381 by
    measurement day; every later observation tested against it) and say what it finds.

    `indicators`: [{id, variable, worse, alerting}] (from engine/rules/personal.json when present).
    `tier_a`: {"rule_id", "op", "limit"} of the renal target rule, for the Tier A side of the comparison.
    """
    per_crew: dict[str, dict] = {}
    chance: list[dict] = []
    flagged_days: dict[tuple[str, str], list[int]] = {}
    t_by_day: dict[tuple[str, str], dict[int, float | None]] = {}
    for cid, tl in timelines.items():
        crew = CREW_BY_ID[cid]
        scripted = _scripted(cid)
        if "sleep_midpoint" in scripted:
            scripted["sleep_midpoint_shift"] = scripted["sleep_midpoint"]
        rows = []
        for ind in indicators:
            var = ind["variable"]
            pts = tl["points"].get(var)
            if not pts:
                continue
            base = [v for t, v in pts if BASELINE_FIRST <= measurement_day(t) <= BASELINE_LAST]
            later = [(measurement_day(t), v) for t, v in pts if measurement_day(t) > BASELINE_LAST]
            n = len(base)
            row = {"indicator_id": ind["id"], "variable": var, "unit": VARIABLES[var][0], "alerting": ind["alerting"],
                   "worse": ind["worse"], "baseline_n": n}
            if n >= 2:
                m, sd = baseline_stats(base)
                row.update({"baseline_mean": round(m, 4), "baseline_sd": round(sd, 4),
                            "mdc": None if n < 7 else round(mdc(sd, n), 4)})
            msd = model_sd(crew, var)
            row["model_sd"] = None if msd is None else round(msd, 4)
            row["mdc_at_model_sd"] = None if msd is None else round(mdc(msd), 4)
            if n < 7:
                row["note"] = f"baseline has {n} values (< 7): Tier B reports insufficient_data"
                rows.append(row)
                continue
            ts: dict[int, float | None] = {}
            hits = []
            for day, v in later:
                t = single_case_t(base, v)
                ts[day] = None if t is None else round(t, 3)
                reliable, worse_dir = _flag(t, ind["worse"])
                if not reliable:
                    continue
                if day in scripted.get(var, {}):
                    if worse_dir:
                        hits.append(day)
                else:
                    caution = worse_dir and ind["alerting"]
                    chance.append({"crew_id": cid, "indicator_id": ind["id"], "variable": var, "day": day,
                                   "value": v, "t": round(t, 3), "direction": "increase" if t > 0 else "decrease",
                                   "worse_direction": worse_dir, "alerting": ind["alerting"],
                                   "severity": "caution" if caution else "nominal",
                                   "case_id": ind.get("case_id") if caution else None})
            flagged_days[(cid, var)] = hits
            t_by_day[(cid, var)] = ts
            rows.append(row)
        per_crew[cid] = {"indicators": rows}
    detection = []
    worse_of = {ind["variable"]: ind["worse"] for ind in indicators}
    id_of = {ind["variable"]: ind["id"] for ind in indicators}
    for ep in EPISODES:
        cid, crew = ep["crew_id"], CREW_BY_ID[ep["crew_id"]]
        tl = timelines[cid]
        for raw_var, by_day in ep["values"].items():
            var = "sleep_midpoint_shift" if raw_var == "sleep_midpoint" else raw_var
            if var not in worse_of or var == "mood":
                continue
            worse = worse_of[var]
            days = sorted(by_day)
            emitted = {d: tl["daily"][var][d] for d in days}
            power = {}
            for d in days:
                if var == "sleep_midpoint_shift":
                    power[str(d)] = round(detection_probability(crew, var, emitted[d], worse,
                                                                signed_midpoint=by_day[d]), 3)
                else:
                    power[str(d)] = round(detection_probability(crew, var, emitted[d], worse), 3)
            entry = {"episode_id": ep["id"], "case_id": ep["case_id"], "crew_id": cid,
                     "indicator_id": id_of[var], "variable": var, "worse": worse,
                     "scripted_days": [days[0], days[-1]],
                     "values": {str(d): emitted[d] for d in days},
                     "t": {str(d): t_by_day.get((cid, var), {}).get(d) for d in days},
                     "tier_b_flagged_days": flagged_days.get((cid, var), []),
                     "tier_b_detection_probability": power}
            if var == "sleep_midpoint_shift":
                entry["tier_b_detection_probability_at_alt_sd"] = {
                    "midpoint_sd_h": round(MIDPOINT_SD_ALT_H, 3),
                    "basis": "MESA weekday sleep-onset SD, 58 min (Huang & Redline 2019); onset and midpoint SDs "
                             "correlate at r = 0.97",
                    "by_day": {str(d): round(detection_probability(crew, var, emitted[d], worse,
                                                                   signed_midpoint=by_day[d],
                                                                   midpoint_sd=MIDPOINT_SD_ALT_H), 3)
                               for d in days}}
            if tier_a and ep.get("tier_a") and ep["tier_a"]["variable"] == var:
                lim, op = tier_a["limit"], tier_a["op"]
                ok = {"lt": lambda x: x < lim, "le": lambda x: x <= lim, "gt": lambda x: x > lim,
                      "ge": lambda x: x >= lim}[op]
                entry["tier_a"] = {"rule_id": tier_a["rule_id"], "op": op, "limit": lim,
                                   "outside_days": [d for d in days if not ok(emitted[d])]}
            detection.append(entry)
    return {"per_crew": per_crew, "episodes": detection, "chance_flags": chance}
