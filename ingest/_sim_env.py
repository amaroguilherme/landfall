"""Environment inputs of the simulated scenario: SPE replay, MSL RAD baseline, Mars conjunction.

Reads (never edits) frozen snapshots written by other adapters:
  swpc_spe_replay      REAL GOES-7 >10 MeV proton flux, October 1989 (NOAA NCEI)  -> event SHAPE, used as the
                       reading of an external space-weather monitor above the Martian atmosphere (relayed
                       locally), with no radial-distance or atmospheric correction (scenario assumption)
  hapi_msl_rad_dose    REAL MSL RAD dose rate on the Mars surface (NASA CCMC iSWA) -> quiet BASELINE of the
                       SIMULATED habitat dose rate (a confirmation signal under an assumed scaling)
  horizons_mars_comms  Mars solar-conjunction windows MODELLED from JPL Horizons geometry (edges fitted to
                       NASA's published command moratoria)                         -> calendar mapping
Each input degrades independently to a documented fallback; the caller turns every
fallback into a caveat. Re-running `python -m ingest --all` picks the real files up.
"""

from __future__ import annotations

import hashlib
import json
import math
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ingest._sim_model import DAY_S, NOW_MET_S, format_met, met_s, rng_for
from ingest.common import to_iso_z, validate_snapshot

S3_PFU = 1000.0                      # NOAA S3 threshold, >=10 MeV (swpc_s_scale)
S1_PFU = 10.0
SPE_ANCHOR_MET_S = met_s(412, 14.25)  # first S3-level replay sample lands at MET 0412/14:15:00
DOSE_MULTIPLE_AT_S3 = 10.0           # design choice (assumed 10x scaling): S3-level flux <-> 10x the RAD quiet rate
CONTINUATION_S = 36 * 3600           # replay continuation after "now", for a scenario player
STEP_S = 300
FALLBACK_BASELINE_UGY_DAY = 200.0    # design-choice placeholder, used only without hapi_msl_rad_dose
FALLBACK_BASELINE_SD = 5.0
CONJ_REFERENCE_DATE = datetime(2026, 11, 14)   # hackathon date: take the first modelled window after it
TARGET_REMAINING_S = 11 * DAY_S + 6 * 3600     # blackout left at "now" (the hero's 11 d 06 h countdown)
MIN_REMAINING_S = 10 * DAY_S


# ------------------------------------------------------------------ helpers
def load_snapshot(out_dir: Path, sid: str) -> tuple[dict | None, str | None]:
    p = Path(out_dir) / f"{sid}.json"
    if not p.exists():
        return None, f"{sid}.json was not present when this file was generated"
    try:
        snap = json.loads(p.read_text())
        validate_snapshot(snap)
    except Exception as exc:  # noqa: BLE001 - any unreadable input becomes a fallback + caveat
        return None, f"{sid}.json could not be used ({type(exc).__name__}: {exc})"
    return snap, None


def parse_iso(s: Any) -> datetime | None:
    """Naive-UTC datetime from an ISO string ('...Z', offset, or date only); None if not ISO."""
    if not isinstance(s, str) or len(s) < 10:
        return None
    try:
        dt = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def digest(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def input_ref(snap: dict) -> dict:
    return {"snapshot": snap["id"], "title": snap["title"], "publisher": snap["source"]["publisher"],
            "url": snap["source"]["url"], "provenance": snap["provenance"]}


# ------------------------------------------------------------------ MSL RAD baseline
def rad_baseline(snap: dict | None) -> dict:
    if snap is not None:
        try:
            d = snap["data"]
            param = d.get("headline_parameter") or "dose_e_total"
            ser = d["series"][param]
            unit = ser["units"]
            summ = ser["summary"]
            if unit != "uGy/day":
                raise ValueError(f"unexpected unit {unit!r}")
            median = float(summ["median"])
            sd = (float(summ["p95"]) - float(summ["p05"])) / (2 * 1.6449)
            win = d.get("window") or {}
            return {"mode": "real", "value": round(median, 2), "unit": "uGy/day", "noise_sd": round(sd, 2),
                    "parameter": param, "n_samples": summ.get("n"),
                    "window": {"start": win.get("start"), "stop": win.get("stop")},
                    "chip": "derived",
                    "source": {"kind": "derived", "from": ["hapi_msl_rad_dose"],
                               "arithmetic": f"median of MSL RAD '{param}' over the snapshot window; "
                                             "noise SD = (p95 - p05) / (2 x 1.6449)"},
                    "input": input_ref(snap),
                    "input_digest": digest([median, summ["p05"], summ["p95"]])}
        except Exception as exc:  # noqa: BLE001
            err = f"hapi_msl_rad_dose.json had an unexpected shape ({type(exc).__name__}: {exc})"
            return _rad_fallback(err)
    return _rad_fallback(None)


def _rad_fallback(err: str | None) -> dict:
    return {"mode": "fallback", "value": FALLBACK_BASELINE_UGY_DAY, "unit": "uGy/day",
            "noise_sd": FALLBACK_BASELINE_SD, "error": err, "chip": "design choice",
            "source": {"kind": "design_choice",
                       "rationale": "Placeholder used only because the real MSL RAD snapshot was absent; "
                                    "re-run `python -m ingest --all` to anchor on the measured value."}}


# ------------------------------------------------------------------ proton event shape
def replay_shape(snap: dict | None) -> dict:
    """Return a flux(met_s) sampler built from the REAL replay, or a documented synthetic fallback.

    The flux is used as the reading of an external space-weather monitor above the Martian atmosphere,
    unchanged: no radial-distance or atmospheric correction (a labelled scenario assumption).
    """
    if snap is not None:
        try:
            d = snap["data"]
            if d.get("unit") != "pfu":
                raise ValueError(f"unexpected unit {d.get('unit')!r}")
            ser = d["series_ge10mev"]
            t0 = parse_iso(ser["start"])
            step = int(ser["step_s"])
            vals = ser["values"]
            if t0 is None or step != STEP_S:
                raise ValueError("series must start at an ISO time with 300-s steps")
            i_s3 = next(i for i, v in enumerate(vals) if v is not None and v >= S3_PFU)
            ev = d.get("sesc_event_computed") or {}
            onset = parse_iso(ev.get("start"))
            if onset is None:
                i_on = next(i for i in range(len(vals) - 2)
                            if all(vals[j] is not None and vals[j] >= S1_PFU for j in range(i, i + 3)))
                onset = t0 + timedelta(seconds=i_on * step)
            i_on = int((onset - t0).total_seconds() // step)
            pre = [v for v in vals[max(0, i_on - 12 * 3600 // step):i_on] if v is not None]
            f_pre = statistics.median(pre) if pre else 0.0
            t_s3 = t0 + timedelta(seconds=i_s3 * step)
            shift_s = SPE_ANCHOR_MET_S - int((t_s3 - t0).total_seconds())  # met = shift_s + (t - t0)

            def flux(m: int) -> float | None:
                k, rem = divmod(m - shift_s, step)
                if rem or k < 0 or k >= len(vals):
                    return None
                return vals[k]

            peak_v = max(v for v in vals if v is not None)
            i_peak = vals.index(peak_v)
            return {"mode": "real", "flux": flux, "f_pre": f_pre, "input": input_ref(snap),
                    "mapping": {
                        "rule": "time shift only: the first replay sample >= 1,000 pfu (NOAA S3 level) is placed at "
                                "MET 0412/14:15:00, 5 min before 'now'; sample order and spacing are untouched",
                        "replay_utc_at_met_0412_000000": to_iso_z(t0 + timedelta(seconds=met_s(412) - shift_s)),
                        "replay_utc_of_first_s3_sample": to_iso_z(t_s3),
                        "replay_utc_of_sesc_onset": to_iso_z(onset),
                        "met_of_sesc_onset": format_met(shift_s + int((onset - t0).total_seconds())),
                        "replay_peak_pfu": peak_v,
                        "replay_utc_of_peak": to_iso_z(t0 + timedelta(seconds=i_peak * step)),
                        "met_of_peak": format_met(shift_s + i_peak * step),
                        "pre_event_flux_pfu": f_pre,
                        "pre_event_flux_method": "median of the 12 h of replay samples before the SESC onset"},
                    "input_digest": digest(vals)}
        except Exception as exc:  # noqa: BLE001
            return _synthetic_shape(f"swpc_spe_replay.json had an unexpected shape ({type(exc).__name__}: {exc})")
    return _synthetic_shape(None)


def _synthetic_shape(err: str | None) -> dict:
    onset = SPE_ANCHOR_MET_S - int(5.75 * 3600)
    peak_t = SPE_ANCHOR_MET_S + 21 * 3600

    def flux(m: int) -> float | None:
        if m < onset:
            return 0.08
        if m <= SPE_ANCHOR_MET_S:   # log-linear 10 -> 1,000 pfu over 5 h 45 min
            return 10.0 * 100.0 ** ((m - onset) / (SPE_ANCHOR_MET_S - onset))
        if m <= peak_t:             # log-linear 1,000 -> 40,000 pfu over 21 h
            return 1000.0 * 40.0 ** ((m - SPE_ANCHOR_MET_S) / (peak_t - SPE_ANCHOR_MET_S))
        return 40000.0 * math.exp(-(m - peak_t) / (18 * 3600))

    return {"mode": "fallback", "flux": flux, "f_pre": 0.08, "error": err,
            "mapping": {"rule": "SYNTHETIC placeholder shape (log-linear rise to 1,000 pfu at MET 0412/14:15:00, "
                                "40,000 pfu peak 21 h later, 18-h e-folding decay); not a measurement",
                        "met_of_sesc_onset": format_met(onset)}}


def build_spe_day(replay: dict | None, rad: dict | None) -> dict:
    base = rad_baseline(rad)
    shape = replay_shape(replay)
    b, sd = base["value"], base["noise_sd"]
    f_pre = shape["f_pre"]
    k = (DOSE_MULTIPLE_AT_S3 - 1.0) * b / (S3_PFU - f_pre)  # uGy/day per pfu above pre-event
    rng = rng_for("habitat", "onboard_dose_rate", 412)
    start = met_s(412)
    times = list(range(start, NOW_MET_S + CONTINUATION_S + 1, STEP_S))
    dose: list[float | None] = []
    src: list[float | None] = []
    for t in times:
        noise = rng.gauss(0.0, sd)  # always drawn: keeps the stream aligned with gaps
        f = shape["flux"](t)
        src.append(None if f is None else float(f"{f:.4g}"))
        dose.append(None if f is None else round(b + noise + k * max(f - f_pre, 0.0), 1))
    n_obs = (NOW_MET_S - start) // STEP_S + 1
    crossings = {}
    for mult in (2, 5, 10, 50, 100):
        hit = next((t for t, v in zip(times, dose) if v is not None and v >= mult * b), None)
        crossings[f"{mult}x_baseline"] = None if hit is None else {
            "met_s": hit, "met": format_met(hit), "relative_to_now_s": hit - NOW_MET_S}
    return {
        "baseline": base, "shape": {kk: vv for kk, vv in shape.items() if kk != "flux"},
        "scaling": {"k_ugy_day_per_pfu": round(k, 6), "dose_multiple_at_s3": DOSE_MULTIPLE_AT_S3,
                    "formula": "dose_rate(t) = RAD_baseline + noise + k * max(F(t) - F_pre, 0), "
                               "k = (10 - 1) * RAD_baseline / (1000 pfu - F_pre)",
                    "chip": "design choice",
                    "source": {"kind": "design_choice",
                               "rationale": "Assumed 10x scaling: the simulated habitat dose rate (a confirmation "
                                            "signal, not the alarm) maps the NOAA S3 flux level to 10x the measured "
                                            "Mars-surface quiet rate. It stands in for shielding, heliocentric distance "
                                            "and atmospheric transport, which LANDFALL does not model. Not a "
                                            "radiation-transport calculation and not a measurement; no effective dose "
                                            "(mSv) is derived from it."}},
        "series": {"start_t": start, "step_s": STEP_S, "v": dose[:n_obs], "n": n_obs,
                   "source_flux_pfu": src[:n_obs]},
        "after_now": {"start_t": times[n_obs], "step_s": STEP_S, "v": dose[n_obs:], "n": len(times) - n_obs,
                      "source_flux_pfu": src[n_obs:],
                      "note": "Replay continuation AFTER 'now' for a scenario player (provenance 'replay' for the "
                              "flux, 'simulated' for the dose rate). At the scenario clock these samples have not "
                              "happened; never feed them to the engine as observations at 'now'."},
        "crossings": crossings,
        "value_at_now": dose[n_obs - 1],
        "multiple_of_baseline_at_now": None if dose[n_obs - 1] is None else round(dose[n_obs - 1] / b, 2),
    }


# ------------------------------------------------------------------ conjunction calendar
_START_KEYS = ("start", "start_utc", "begin", "from", "start_time")
_STOP_KEYS = ("stop", "end", "stop_utc", "end_utc", "to", "stop_time", "end_time")


def _first(d: dict, keys: tuple[str, ...]) -> Any:
    for k in keys:
        if k in d:
            return d[k]
    return None


def find_windows(obj: Any, path: tuple[str, ...] = ()) -> list[dict]:
    """Every list of {start, stop|end} ISO records under a key path that names a conjunction/blackout."""
    out: list[dict] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out += find_windows(v, path + (str(k),))
    elif isinstance(obj, list):
        joined = "/".join(path).lower()
        if "conjunction" in joined or "blackout" in joined:
            for item in obj:
                if isinstance(item, dict):
                    s, e = parse_iso(_first(item, _START_KEYS)), parse_iso(_first(item, _STOP_KEYS))
                    if s and e and e > s:
                        out.append({"start": s, "stop": e, "record": item, "path": "/".join(path)})
        for i, item in enumerate(obj):
            if isinstance(item, (dict, list)):
                out += find_windows(item, path + (str(i),))
    uniq = {(w["start"], w["stop"]): w for w in out}
    return sorted(uniq.values(), key=lambda w: w["start"])


def choose_window(windows: list[dict]) -> dict | None:
    if not windows:
        return None
    need = MIN_REMAINING_S + 6 * 3600
    long_enough = [w for w in windows if (w["stop"] - w["start"]).total_seconds() >= need]
    after_ref = [w for w in long_enough if w["start"] >= CONJ_REFERENCE_DATE]
    if after_ref:
        return after_ref[0]
    if long_enough:
        return long_enough[-1]
    return max(windows, key=lambda w: w["stop"] - w["start"])


def comms_at(data: dict, when: datetime) -> dict | None:
    """Linear interpolation of the daily Horizons rows (as that snapshot's caveats instruct)."""
    try:
        cols = data["columns"]
        i_date, i_owlt = cols.index("date"), cols.index("one_way_light_time_s")
        i_el = cols.index("elongation_deg") if "elongation_deg" in cols else None
        rows = {r[i_date]: r for r in data["rows"]}
        d0 = when.replace(hour=0, minute=0, second=0, microsecond=0)
        r0, r1 = rows[d0.date().isoformat()], rows[(d0 + timedelta(days=1)).date().isoformat()]
    except (KeyError, ValueError, TypeError, IndexError):
        return None
    f = (when - d0).total_seconds() / DAY_S
    owlt = r0[i_owlt] + f * (r1[i_owlt] - r0[i_owlt])
    out = {"one_way_light_time_s": round(owlt, 1), "round_trip_s": round(2 * owlt, 1),
           "chip": "derived",
           "source": {"kind": "derived", "from": ["horizons_mars_comms"],
                      "arithmetic": "linear interpolation between the daily 00:00 UTC rows around now_utc"}}
    if i_el is not None:
        out["elongation_deg"] = round(r0[i_el] + f * (r1[i_el] - r0[i_el]), 4)
    return out


def build_calendar(hz: dict | None) -> dict:
    windows = find_windows(hz.get("data")) if hz is not None else []
    w = choose_window(windows)
    if w is None:
        err = None if hz is None else "horizons_mars_comms.json has no recognisable conjunction window list"
        return {"mode": "placeholder", "error": err, "met_epoch_utc": None, "now_utc": None,
                "window_utc": None,
                "window_met": {"start_met_s": NOW_MET_S - 3 * DAY_S, "stop_met_s": NOW_MET_S + TARGET_REMAINING_S,
                               "start": format_met(NOW_MET_S - 3 * DAY_S),
                               "stop": format_met(NOW_MET_S + TARGET_REMAINING_S)},
                "blackout_elapsed_at_now_s": 3 * DAY_S, "blackout_remaining_at_now_s": TARGET_REMAINING_S,
                "chip": "design choice",
                "source": {"kind": "design_choice",
                           "rationale": "PLACEHOLDER: no modelled conjunction window was available; MET-only window, "
                                        "no calendar date is claimed."}}
    dur = int((w["stop"] - w["start"]).total_seconds())
    if dur >= TARGET_REMAINING_S + DAY_S:
        now_utc = w["stop"] - timedelta(seconds=TARGET_REMAINING_S)
        rule = "now = window stop - 11 d 06 h (window long enough)"
    elif dur >= MIN_REMAINING_S + 6 * 3600:
        now_utc = w["start"] + timedelta(hours=6)
        rule = "now = window start + 6 h (window shorter than 12 d 06 h)"
    else:
        now_utc = w["start"] + timedelta(hours=1)
        rule = "now = window start + 1 h (WINDOW SHORTER THAN 10 d: blackout remaining < 10 d)"
    epoch = now_utc - timedelta(seconds=NOW_MET_S)
    comms = comms_at(hz.get("data") or {}, now_utc)
    s_met = int((w["start"] - epoch).total_seconds())
    e_met = int((w["stop"] - epoch).total_seconds())
    return {"mode": "horizons", "error": None,
            "met_epoch_utc": to_iso_z(epoch), "now_utc": to_iso_z(now_utc),
            "window_utc": {"start": to_iso_z(w["start"]), "stop": to_iso_z(w["stop"]), "duration_s": dur,
                           "found_at": w["path"], "record": w["record"]},
            "window_met": {"start_met_s": s_met, "stop_met_s": e_met,
                           "start": format_met(s_met), "stop": format_met(e_met)},
            "blackout_elapsed_at_now_s": NOW_MET_S - s_met, "blackout_remaining_at_now_s": e_met - NOW_MET_S,
            "selection": f"first modelled window starting on/after {CONJ_REFERENCE_DATE.date()} that is >= 10 d 06 h "
                         f"long (else the latest long-enough one, else the longest); {rule}",
            "window_basis": "modelled from JPL Horizons geometry (Sun-Earth-Mars elongation below a threshold whose "
                            "edges are fitted to NASA's published command moratoria); not an operational window",
            "windows_available": len(windows),
            "comms_at_now": comms,
            "chip": "derived",
            "source": {"kind": "derived", "from": ["horizons_mars_comms"],
                       "arithmetic": "MET epoch = now_utc - 35,648,400 s (MET 0412/14:20:00)"},
            "input": input_ref(hz)}
