"""Seeded crew physiology for the LANDFALL demo scenario (engine/SPEC.md section 7).

Pure functions only: no I/O, no network, no clock. Every random draw comes from a
`random.Random` seeded with a string built from SEED, so the output is identical on every
run and platform (string seeds are hashed with SHA-512 by CPython, independent of
PYTHONHASHSEED). Only `Random.random()` and `Random.gauss()` are used, whose algorithms
have been stable across CPython releases.

Design (all of it a scenario design choice, stated in the snapshot):
- Baseline days 368-381 are drawn until every value sits within QUIET_Q baseline SDs of
  the baseline mean; non-episode days after the baseline obey the same bound. With the
  SPEC RCI (sem = sd*sqrt(1-r), s_diff = sqrt(2)*sem) that keeps |rc| < 3.29 for any
  r <= 0.9, so no case opens by accident.
- Episode days carry scripted physical values; `check_robust` proves |x - mean| >= 6 SD,
  which is |rc| >= 6 at r = 0.5 and therefore at every r in [0.5, 0.9] (rc grows with r).
"""

from __future__ import annotations

import math
import random
import statistics

SEED = 20261114
DAY_S = 86400
FIRST_DAY, LAST_DAY = 368, 412
BASELINE_FIRST, BASELINE_LAST = 368, 381
NOW_MET_S = 412 * DAY_S + 14 * 3600 + 20 * 60  # MET 0412/14:20:00
CRITICAL_Z = 3.29
QUIET_Q = 1.4          # non-episode bound, in baseline SDs: 1.4 / sqrt(2*(1-0.9)) = 3.13 < 3.29
ROBUST_Z = 6.0         # episode floor, in baseline SDs (= |rc| at r = 0.5)
SCHEDULE_REF_MIDPOINT_H = 2.0   # 02:00 MET: midpoint of the pre-shift sleep period 22:00-06:00
FITNESS_TEST_DAYS = (369, 383, 397, 411)
NOON_SIGHT_H = 12.0    # daily check-in (mood) at 12:00 MET
# Habitat ppCO2 is kept clearly below the 2.4 mmHg approach level of rule pel_cabin_ppco2_1h
# (engine/rules/thresholds.json; [V2 6004] limit 3 mmHg), so it never competes with the cases.
PPCO2_CAP_MMHG = 2.3

# variable -> (unit, observation source, rounding decimals; None = integer)
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
}
PERSONAL_VARIABLES = tuple(VARIABLES)
NON_ALERTING = ("mood",)

# Individual (fictional) baselines: (mean, day-to-day SD). Categorical variables give the
# probability of each value (pvt_lapses: 0,1,2 ; mood: 1..5).
CREW: list[dict] = [
    {"id": "CM-1", "role": "Commander",
     "sleep_duration": (6.10, 0.18), "sleep_midpoint_shift": (-0.10, 0.12), "waso_h": 0.35,
     "pvt_lapses": (0.30, 0.45, 0.25), "pvt_median_rt": (252, 6), "light_exposure_daytime": (238, 14),
     "resting_hr": (55.0, 1.5), "hrv_sdnn": (61.0, 3.5), "skin_temp": (34.30, 0.12),
     "urine_volume_24h": (2780, 100), "fluid_intake_24h": (3320, 105), "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "vo2max": (43.9, 43.5, 43.2, 42.9), "career_effective_dose": 412,
     "hr_wake": 71, "hr_exercise": 141, "exercise_h": (16.0, 17.0)},
    {"id": "CM-2", "role": "Flight Engineer",
     "sleep_duration": (6.30, 0.20), "sleep_midpoint_shift": (0.05, 0.13), "waso_h": 0.30,
     "pvt_lapses": (0.35, 0.40, 0.25), "pvt_median_rt": (246, 6), "light_exposure_daytime": (251, 15),
     "resting_hr": (58.0, 1.6), "hrv_sdnn": (54.0, 3.2), "skin_temp": (34.10, 0.13),
     "urine_volume_24h": (2840, 105), "fluid_intake_24h": (3390, 110), "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "vo2max": (37.2, 36.4, 35.7, 35.1), "career_effective_dose": 371,
     "hr_wake": 74, "hr_exercise": 138, "exercise_h": (8.0, 9.0)},
    {"id": "CM-3", "role": "Mission Specialist",
     "sleep_duration": (5.95, 0.19), "sleep_midpoint_shift": (-0.20, 0.12), "waso_h": 0.40,
     "pvt_lapses": (0.30, 0.45, 0.25), "pvt_median_rt": (259, 7), "light_exposure_daytime": (229, 13),
     "resting_hr": (52.0, 1.4), "hrv_sdnn": (67.0, 3.8), "skin_temp": (34.40, 0.12),
     "urine_volume_24h": (2900, 105), "fluid_intake_24h": (3430, 110), "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "vo2max": (41.8, 41.5, 41.4, 41.1), "career_effective_dose": 356,
     "hr_wake": 68, "hr_exercise": 136, "exercise_h": (10.0, 11.0)},
    {"id": "CM-4", "role": "Crew Medical Officer",
     "sleep_duration": (6.20, 0.18), "sleep_midpoint_shift": (0.10, 0.12), "waso_h": 0.35,
     "pvt_lapses": (0.35, 0.40, 0.25), "pvt_median_rt": (249, 6), "light_exposure_daytime": (244, 14),
     "resting_hr": (54.0, 1.5), "hrv_sdnn": (63.0, 3.6), "skin_temp": (34.20, 0.12),
     "urine_volume_24h": (2810, 100), "fluid_intake_24h": (3360, 105), "mood": (0, 0.03, 0.30, 0.55, 0.12),
     "vo2max": (45.6, 45.3, 45.0, 44.8), "career_effective_dose": 389,
     "hr_wake": 69, "hr_exercise": 144, "exercise_h": (13.0, 14.0)},
]
CREW_BY_ID = {c["id"]: c for c in CREW}

# Scripted episodes (physical values, per MET day). "robust_days" must clear ROBUST_Z;
# other scripted days are a transition ramp and are excluded from both checks.
EPISODES: list[dict] = [
    {"id": "renal_hydration", "case_id": "renal_stone", "crew_id": "CM-3",
     "summary": "24-h urine output falls below 1,500 mL/day (the limit of rule target_urine_output_24h in "
                "engine/rules/thresholds.json) on MET days 398-401 while fluid intake falls as well; both "
                "recover from day 402. Every other urine value of every crewmember stays above the rule's "
                "2,500 mL/day approach level.",
     "values": {
         "urine_volume_24h": {398: 1430, 399: 1380, 400: 1340, 401: 1450},
         "fluid_intake_24h": {398: 2010, 399: 1890, 400: 1840, 401: 1960}},
     "robust_days": {"urine_volume_24h": (398, 399, 400, 401), "fluid_intake_24h": (398, 399, 400, 401)}},
    {"id": "sleep_shift", "case_id": "sleep_circadian", "crew_id": "CM-1",
     "summary": "On MET day 403 CM-1's work schedule shifts 3 h later and the sleep opportunity is "
                "shortened (vehicle-operations support). From the night ending on day 404 sleep shortens "
                "and its midpoint moves later; PVT-B lapses and median RT climb and reach |RCI| >= 6 by "
                "day 407 for any r in [0.5, 0.9]. The episode is still running at 'now' (no countermeasure "
                "is applied in the data, so the case can be acted on in the demo).",
     "values": {
         "sleep_duration": dict(zip(range(404, 413), (4.55, 4.40, 4.35, 4.50, 4.30, 4.45, 4.40, 4.50, 4.35))),
         "sleep_midpoint_shift": dict(zip(range(404, 413), (2.30, 2.45, 2.40, 2.55, 2.35, 2.50, 2.45, 2.40, 2.50))),
         "pvt_lapses": dict(zip(range(404, 413), (3, 4, 5, 7, 8, 8, 7, 8, 7))),
         "pvt_median_rt": dict(zip(range(404, 413), (262, 271, 281, 296, 301, 304, 299, 303, 298))),
         "mood": dict(zip(range(405, 413), (3, 3, 2, 2, 3, 2, 2, 3)))},
     "robust_days": {"sleep_duration": tuple(range(404, 413)),
                     "sleep_midpoint_shift": tuple(range(404, 413)),
                     "pvt_lapses": tuple(range(407, 413)),
                     "pvt_median_rt": tuple(range(407, 413))},
     "waso_h_from_day": (404, 0.60)},
]


def rng_for(*parts: object) -> random.Random:
    return random.Random(":".join(str(p) for p in (SEED, *parts)))


def met_s(day: int, hour: float = 0.0) -> int:
    return int(round(day * DAY_S + hour * 3600))


def format_met(seconds: int) -> str:
    d, rem = divmod(int(seconds), DAY_S)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    return f"{d:04d}/{h:02d}:{m:02d}:{s:02d}"


def _round(x: float, nd: int | None) -> float | int:
    if nd is None:
        return int(round(x))
    if nd < 0:
        return int(round(x, nd))
    return round(x, nd) + 0.0  # + 0.0 turns -0.0 into 0.0


def _categorical(rng: random.Random, probs: tuple[float, ...], offset: int) -> int:
    u, acc = rng.random(), 0.0
    for i, p in enumerate(probs):
        acc += p
        if u < acc:
            return i + offset
    return len(probs) - 1 + offset


def _draw(rng: random.Random, var: str, spec: tuple) -> float | int:
    nd = VARIABLES[var][2]
    if var == "pvt_lapses":
        return _categorical(rng, spec, 0)
    if var == "mood":
        return _categorical(rng, spec, 1)
    mean, sd = spec
    return _round(rng.gauss(mean, sd), nd)


def baseline_stats(values: list[float]) -> tuple[float, float]:
    return statistics.fmean(values), statistics.stdev(values)


def rci(baseline: list[float], current: float, r: float) -> float:
    """SPEC section 5: sd = sample SD (n-1), sem = sd*sqrt(1-r), s_diff = sqrt(2)*sem."""
    m, sd = baseline_stats(baseline)
    return (current - m) / (math.sqrt(2.0) * sd * math.sqrt(1.0 - r))


def _quiet_baseline(rng: random.Random, var: str, spec: tuple, n: int) -> list:
    for _ in range(10000):
        vals = [_draw(rng, var, spec) for _ in range(n)]
        if len(set(vals)) < 2:
            continue
        m, s = baseline_stats(vals)
        if all(abs(v - m) <= QUIET_Q * s for v in vals):
            return vals
    raise RuntimeError(f"could not draw a quiet baseline for {var}")


def _quiet_value(rng: random.Random, var: str, spec: tuple, m: float, s: float) -> float | int:
    for _ in range(10000):
        v = _draw(rng, var, spec)
        if abs(v - m) <= QUIET_Q * s:
            return v
    raise RuntimeError(f"could not draw a quiet value for {var}")


def episode_for(crew_id: str) -> list[dict]:
    return [e for e in EPISODES if e["crew_id"] == crew_id]


def daily_values(crew: dict) -> dict[str, dict[int, float | int]]:
    """{variable: {day: value}} for MET days FIRST_DAY..LAST_DAY (before timestamp filtering)."""
    out: dict[str, dict[int, float | int]] = {}
    n_base = BASELINE_LAST - BASELINE_FIRST + 1
    scripted: dict[str, dict[int, float | int]] = {}
    for ep in episode_for(crew["id"]):
        for var, by_day in ep["values"].items():
            scripted.setdefault(var, {}).update(by_day)
    for var in PERSONAL_VARIABLES:
        rng = rng_for(crew["id"], var)
        base = _quiet_baseline(rng, var, crew[var], n_base)
        m, s = baseline_stats(base)
        series = dict(zip(range(BASELINE_FIRST, BASELINE_LAST + 1), base))
        for d in range(BASELINE_LAST + 1, LAST_DAY + 1):
            q = _quiet_value(rng, var, crew[var], m, s)  # always drawn: keeps streams aligned
            series[d] = scripted.get(var, {}).get(d, q)
        out[var] = series
    return out


def check_robust(crew_id: str, daily: dict[str, dict[int, float | int]]) -> list[dict]:
    """Raise if an episode is not robust or a non-episode day could fire; return the evidence."""
    evidence = []
    base_days = range(BASELINE_FIRST, BASELINE_LAST + 1)
    scripted_days: dict[str, set[int]] = {}
    for ep in episode_for(crew_id):
        for var, by_day in ep["values"].items():
            scripted_days.setdefault(var, set()).update(by_day)
        for var, days in ep["robust_days"].items():
            base = [daily[var][d] for d in base_days]
            m, s = baseline_stats(base)
            zs = [(daily[var][d] - m) / s for d in days]
            zmin = min(abs(z) for z in zs)
            if zmin < ROBUST_Z:
                raise AssertionError(f"{crew_id} {var}: episode |z| {zmin:.2f} < {ROBUST_Z}")
            evidence.append({"episode_id": ep["id"], "crew_id": crew_id, "variable": var,
                             "days": [days[0], days[-1]], "baseline_mean": round(m, 4), "baseline_sd": round(s, 4),
                             "min_abs_rc_at_r_0_5": round(zmin, 2),
                             "min_abs_rc_at_r_0_9": round(zmin / math.sqrt(2 * 0.1), 2)})
    for var in PERSONAL_VARIABLES:
        if var in NON_ALERTING:
            continue
        base = [daily[var][d] for d in base_days]
        m, s = baseline_stats(base)
        for d, v in daily[var].items():
            if d in scripted_days.get(var, set()):
                continue
            if abs(v - m) > QUIET_Q * s + 1e-9:
                raise AssertionError(f"{crew_id} {var} day {d}: quiet bound violated")
    return evidence


def sleep_episode(crew: dict, day: int, daily: dict) -> tuple[int, int]:
    """(onset, offset) MET seconds of the main sleep episode that ends on `day`."""
    waso = crew["waso_h"]
    for ep in episode_for(crew["id"]):
        if "waso_h_from_day" in ep and day >= ep["waso_h_from_day"][0]:
            waso = ep["waso_h_from_day"][1]
    tst = daily["sleep_duration"][day]
    mid = SCHEDULE_REF_MIDPOINT_H + daily["sleep_midpoint_shift"][day]
    period = tst + waso
    return met_s(day, mid - period / 2), met_s(day, mid + period / 2)


def crew_timeline(crew: dict) -> dict:
    """Timestamped daily series (only values whose measurement window has closed by NOW)."""
    daily = daily_values(crew)
    evidence = check_robust(crew["id"], daily)
    episodes = {d: sleep_episode(crew, d, daily) for d in range(FIRST_DAY, LAST_DAY + 1)}
    pts: dict[str, list[tuple[int, float | int]]] = {v: [] for v in PERSONAL_VARIABLES}
    for d in range(FIRST_DAY, LAST_DAY + 1):
        onset, offset = episodes[d]
        next_onset = episodes[d + 1][0] if d + 1 in episodes else None
        stamp = {
            "sleep_duration": offset, "sleep_midpoint_shift": offset,
            "resting_hr": offset, "hrv_sdnn": offset, "skin_temp": offset,
            "pvt_lapses": offset + 3600, "pvt_median_rt": offset + 3600,
            "light_exposure_daytime": next_onset,          # wake period closes at the next sleep onset
            "urine_volume_24h": met_s(d + 1), "fluid_intake_24h": met_s(d + 1),  # MET-midnight collection
            "mood": met_s(d, NOON_SIGHT_H),
        }
        for var in PERSONAL_VARIABLES:
            t = stamp[var]
            if t is not None and t <= NOW_MET_S:
                pts[var].append((t, daily[var][d]))
    vo2 = [(met_s(d, 10.0), v) for d, v in zip(FITNESS_TEST_DAYS, crew["vo2max"])]
    sleep_eps = [[episodes[d][0], episodes[d][1]] for d in range(FIRST_DAY, LAST_DAY + 1)]
    return {"points": pts, "vo2max": vo2, "sleep_episodes": sleep_eps, "evidence": evidence,
            "daily": daily, "episodes_by_day": episodes}


def intraday_heart_rate(crew: dict, sleep_412: tuple[int, int], resting_hr_412: float) -> list[int]:
    """1-min heart rate for MET day 412 from 00:00 to NOW inclusive (band ECG summaries)."""
    rng = rng_for(crew["id"], "heart_rate", 412)
    start = met_s(412)
    onset, offset = sleep_412
    ex0, ex1 = (met_s(412, h) for h in crew["exercise_h"])
    out, ar = [], 0.0
    for t in range(start, NOW_MET_S + 1, 60):
        ar = 0.85 * ar + rng.gauss(0.0, 1.2)
        if onset <= t < offset:
            hr = resting_hr_412 + 0.6 * ar
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
