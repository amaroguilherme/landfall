"""`hapi` adapter: radiation environment for three crew environments via HAPI servers.

Snapshots (each built independently; one failing source does not block the others):
  hapi_iss_track     SSCWeb `iss` ephemeris PREDICTION: next 24 h track + SAA passes (48 h)
  hapi_iss_tepc      CDAWeb ISS_DOSANL_TEPC: measured ISS dose, 24 h native + daily series
  hapi_crater_dose   CCMC iSWA `CRaTER`: measured dose rate in lunar orbit (LRO), ~90 days
  hapi_msl_rad_dose  CCMC iSWA `msl_rad_dosimetry`: measured dose rate on Mars (MSL RAD), ~90 days

Every unit is copied from the dataset's /info; every conversion is explicit (CONVERSIONS)
and tested. Fill values declared in /info become null.
"""

from __future__ import annotations

import math
import statistics
import sys
import traceback
from collections import OrderedDict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from ingest._hapi_client import (HapiClient, Param, hapi_time_to_iso, info_window,
                                 parse_hapi_time)
from ingest.common import RunContext, make_snapshot, to_iso_z

ADAPTER_ID = "hapi"

SSCWEB_HAPI = "https://hapi-server.org/servers/SSCWeb/hapi"
CDAWEB_HAPI = "https://cdaweb.gsfc.nasa.gov/hapi"
ISWA_HAPI = "https://iswa.gsfc.nasa.gov/IswaSystemWebApp/hapi"

# ---- explicit, tested conversions ------------------------------------------------------
# SSCWeb serves positions in Earth radii. Its km-per-R_E factor was derived (not assumed):
# SSCWeb REST /WS/sscr/2/locations/iss/20261114T130000Z,20261114T130500Z/geo/ returned
# X = -80.70192712525755 km, Y = -4553.31907054573 km, RadialLength = 6804.601086960333 km
# for 2026-11-14T13:00Z, while the SSCWeb HAPI server returned X_GEO = -0.0126528540,
# Y_GEO = -0.7138922621, Radius = 1.0668595781 R_E for the same instant. Every ratio is
# 6378.16 km to 6 significant figures (see test_hapi.py::test_sscweb_re_km_matches_rest).
SSCWEB_RE_KM = 6378.16
WGS84_A_KM = 6378.137
WGS84_F = 1 / 298.257223563

DOSE_RATE_TO_UGY_PER_DAY = {  # factor so that value[unit] * factor = value[uGy/day]
    "uGy/day": 1.0,
    "cGy/day": 1.0e4,    # 1 cGy = 1e-2 Gy = 1e4 uGy
    "uGy/min": 1440.0,   # 1440 min per day
}

# SAA rule: design choice, no published basis (see saa_rule in the snapshot).
SAA_B_THRESHOLD_NT = 23000.0

TEPC_WINDOW = (datetime(2015, 6, 1, tzinfo=timezone.utc), datetime(2015, 6, 2, tzinfo=timezone.utc))
TEPC_DAILY_DAYS = 60
TEPC_COMPLETE_DAY_MIN = 0.9 * 1440  # design choice: a day is 'complete' at >= 90 % coverage

DEEP_SPACE_WINDOW_DAYS = 90
ISWA_MAX_SPAN = timedelta(days=30)  # server refuses > 31 days per request (HAPI 1408)
# MSL RAD and the rover's RTG: two consecutive sentences, verbatim, of the RAD team's paper (arXiv:2502.02469v1,
# "6 Appendix: Nowcasting SEP Events with Dose Rate B"). The rad_events adapter re-finds them in the arXiv HTML
# on every build, and fails if they are missing.
MSL_RTG_PAPER = "Löwe et al. 2025, arXiv:2502.02469v1, appendix"
MSL_RTG_QUOTE = ("Dose rate E is not affected by the additional radiation from radioactive decay, as its "
                 "detection threshold is sufficiently high to exclude the RTG background. In contrast, the "
                 "measurements of dose rate B include the RTG background.")


def to_ugy_per_day(value: float | None, unit: str) -> float | None:
    if value is None:
        return None
    if unit not in DOSE_RATE_TO_UGY_PER_DAY:
        raise ValueError(f"no explicit conversion from {unit!r} to uGy/day")
    return value * DOSE_RATE_TO_UGY_PER_DAY[unit]


def lon_to_pm180(lon: float | None) -> float | None:
    """0..360 deg east -> -180..180 deg east (SSCWeb serves 0..360)."""
    if lon is None:
        return None
    x = ((lon + 180.0) % 360.0) - 180.0
    return round(x, 6)


def ecef_to_geodetic_km(x: float, y: float, z: float) -> tuple[float, float, float]:
    """ECEF (km) -> WGS84 geodetic (lat_deg, lon_deg, height_km). Iterative (Bowring start),
    converges to < 1 mm in a few iterations at LEO."""
    a, f = WGS84_A_KM, WGS84_F
    e2 = f * (2 - f)
    lon = math.degrees(math.atan2(y, x))
    p = math.hypot(x, y)
    if p < 1e-9:  # on the polar axis
        b = a * (1 - f)
        return (90.0 if z >= 0 else -90.0), lon, abs(z) - b
    lat = math.atan2(z, p * (1 - e2))
    h = 0.0
    for _ in range(10):
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        new = math.atan2(z, p * (1 - e2 * n / (n + h)))
        if abs(new - lat) < 1e-13:
            lat = new
            break
        lat = new
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    h = p / math.cos(lat) - n
    return math.degrees(lat), lon, h


def find_saa_passes(times: list[str], b_nt: list[float | None], threshold_nt: float,
                    extra: dict[str, list] | None = None) -> list[dict]:
    """Maximal runs of consecutive samples with B < threshold. A null B ends a run.
    start/stop are the first/last sample inside; duration_s = stop - start (sample spacing
    limits precision to +/- one cadence). truncated=True when the run touches the first or
    last sample of the window or a null sample, i.e. its true extent is unknown and
    duration_s is a lower bound."""
    passes: list[dict] = []
    run: list[int] = []
    last_i = len(b_nt) - 1

    def close() -> None:
        if not run:
            return
        i0, i1 = run[0], run[-1]
        imin = min(run, key=lambda i: b_nt[i])
        t0, t1 = parse_hapi_time(times[i0]), parse_hapi_time(times[i1])
        truncated = (i0 == 0 or b_nt[i0 - 1] is None or i1 == last_i or b_nt[i1 + 1] is None)
        p = {"start": times[i0], "stop": times[i1],
             "duration_s": int((t1 - t0).total_seconds()), "n_samples": len(run),
             "truncated": truncated,
             "min_B_nT": b_nt[imin], "time_of_min_B": times[imin]}
        for k, col in (extra or {}).items():
            p[f"{k}_at_min_B"] = col[imin]
        passes.append(p)

    for i, b in enumerate(b_nt):
        if b is not None and b < threshold_nt:
            run.append(i)
        else:
            close()
            run = []
    close()
    return passes


def daily_aggregate(times: list[str], values: list[float | None]) -> list[dict]:
    """Per-UTC-day n / mean / min / max of the non-null samples (unweighted).

    Every calendar day from the first to the last sample is listed. A day with no sample at
    all gets n=0 and nulls, so a data gap stays visible to the front end ([V2 10020]
    'missing' indication) instead of silently shortening the series."""
    days: "OrderedDict[str, list[float]]" = OrderedDict()
    for t, v in zip(times, values):
        d = t[:10]
        days.setdefault(d, [])
        if v is not None:
            days[d].append(v)
    if not days:
        return []
    first, last = date.fromisoformat(min(days)), date.fromisoformat(max(days))
    out = []
    for k in range((last - first).days + 1):
        d = (first + timedelta(days=k)).isoformat()
        vs = days.get(d, [])
        if vs:
            out.append({"date": d, "n": len(vs), "mean": round(statistics.fmean(vs), 6),
                        "min": round(min(vs), 6), "max": round(max(vs), 6)})
        else:
            out.append({"date": d, "n": 0, "mean": None, "min": None, "max": None})
    return out


ENHANCED_DAY_FACTOR = 2.0  # design choice: flag days whose mean is > 2x the window median


def enhanced_days(daily: list[dict], median: float | None, factor: float) -> list[dict]:
    """Days whose mean exceeds factor x median (both in the series' own units)."""
    if median is None:
        return []
    return [{"date": e["date"], "mean": e["mean"], "max": e["max"],
             "ratio_to_median": round(e["mean"] / median, 2)}
            for e in daily if e["mean"] is not None and e["mean"] > factor * median]


def median_spacing_s(times: list[str]) -> float | None:
    ts = [parse_hapi_time(t) for t in times]
    gaps = [(b - a).total_seconds() for a, b in zip(ts, ts[1:])]
    return round(statistics.median(gaps), 1) if gaps else None


STATS_METHOD = ("Over the non-null native samples, not time-weighted: mean = arithmetic mean, "
                "median = middle value (mean of the two middle values for even n), p05/p95 = "
                "nearest-rank percentiles (sorted value at rank ceil(q*n)).")


def summary_stats(values: list[float | None]) -> dict:
    vs = sorted(v for v in values if v is not None)
    if not vs:
        return {"n": 0}

    def pct(q: float) -> float:  # nearest-rank percentile
        return vs[min(len(vs) - 1, max(0, math.ceil(q * len(vs)) - 1))]

    return {"n": len(vs), "mean": round(statistics.fmean(vs), 6),
            "median": round(statistics.median(vs), 6), "min": vs[0], "max": vs[-1],
            "p05": pct(0.05), "p95": pct(0.95)}


def _param_meta(params: list[Param]) -> dict:
    return {p.name: {"units": p.units, "fill": p.fill, "type": p.type,
                     "description": p.description} for p in params}


def _dataset_meta(base: str, dataset: str, info: dict) -> dict:
    return {"server": base, "id": dataset, "HAPI": info.get("HAPI"),
            "startDate": hapi_time_to_iso(info["startDate"]),
            "stopDate": hapi_time_to_iso(info["stopDate"]),
            "cadence": info.get("cadence"), "title": info.get("title"),
            "description": info.get("description"), "resourceURL": info.get("resourceURL"),
            "contact": info.get("contact")}


# ======================================================================================
# A) SSCWeb ISS ephemeris prediction -> track + SAA passes
# ======================================================================================
def build_iss_track(ctx: RunContext) -> dict:
    c = HapiClient(ctx, SSCWEB_HAPI)
    info = c.info("iss")
    start_date, stop_date = info_window(info)
    # Window starts at retrieved_at floored to the UTC hour, so the request URL (and thus the
    # RunContext cache key) is stable within the hour and `--offline` can replay it.
    now = parse_hapi_time(ctx.retrieved_at).replace(minute=0, second=0, microsecond=0)
    caveats: list[str] = []
    horizon = now + timedelta(hours=48)
    if stop_date < horizon:
        caveats.append(f"SSCWeb prediction ends at {to_iso_z(stop_date)}, before the 48 h SAA "
                       "window; passes are listed only up to that time.")
        horizon = stop_date
    if horizon <= now:
        raise RuntimeError(f"SSCWeb iss stopDate {info['stopDate']} is not in the future")
    wanted = ["X_GEO", "Y_GEO", "Z_GEO", "Lat_GEO", "Lon_GEO", "MagneticFldStrth", "DipL-V"]
    params, rows = c.data("iss", info, now, horizon, wanted)
    units = {p.name: p.units for p in params}
    assert units["X_GEO"] == "R_E" and units["MagneticFldStrth"] == "nT", units

    col = {p.name: [r[i] for r in rows] for i, p in enumerate(params)}
    times = col["Time"]
    alt_km: list[float | None] = []
    for x, y, z in zip(col["X_GEO"], col["Y_GEO"], col["Z_GEO"]):
        if None in (x, y, z):
            alt_km.append(None)
            continue
        _, _, h = ecef_to_geodetic_km(x * SSCWEB_RE_KM, y * SSCWEB_RE_KM, z * SSCWEB_RE_KM)
        alt_km.append(round(h, 2))
    lon = [lon_to_pm180(v) for v in col["Lon_GEO"]]

    t24 = to_iso_z(now + timedelta(hours=24))
    n24 = sum(1 for t in times if t < t24)
    track = {"time": times[:n24], "lat_deg": col["Lat_GEO"][:n24], "lon_deg": lon[:n24],
             "alt_km": alt_km[:n24], "B_nT": col["MagneticFldStrth"][:n24],
             "L": col["DipL-V"][:n24]}
    passes = find_saa_passes(times, col["MagneticFldStrth"], SAA_B_THRESHOLD_NT,
                             extra={"lat_deg": col["Lat_GEO"], "lon_deg": lon, "alt_km": alt_km})
    in_24 = [p for p in passes if p["start"] < t24]

    caveats += [
        "PREDICTION, not measurement: SSCWeb propagates the ISS orbit forward; reboosts and "
        "debris-avoidance manoeuvres after retrieval are not in it.",
        "MagneticFldStrth is a MODEL value (publisher: 'IGRF + T89C with Kp: 3-, 3, 3+'), i.e. a "
        "fixed moderate geomagnetic activity level, not a forecast of actual conditions.",
        f"SAA rule (B < {SAA_B_THRESHOLD_NT:.0f} nT at the ISS position) is a LANDFALL design "
        "choice with no published basis; it was picked because it yields roughly six passes per "
        "12 h, matching the pattern seen in SSCWeb data during planning. Low field strength is a "
        "proxy for the SAA, not a measurement of trapped-particle flux or dose.",
        "Pass start/stop come from 60 s samples: each time is uncertain by up to one minute.",
        "The 24 h track and 48 h pass window start at retrieved_at floored to the UTC hour "
        "(so up to 59 min of the track may already be past at retrieval). freshness.stale_after "
        "is therefore PT23H, so the snapshot turns stale before the track runs out.",
        "lat_deg is SSCWeb's Lat_GEO, which is geocentric latitude (checked: atan2(Z, "
        "hypot(X, Y)) reproduces it); it differs from map (geodetic) latitude by < 0.2 deg.",
        "alt_km is derived by LANDFALL (WGS84 geodetic height from X/Y/Z_GEO); SSCWeb serves no "
        "altitude. The km-per-Earth-radius factor 6378.16 was derived by comparing SSCWeb REST "
        "(km) with SSCWeb HAPI (R_E) for the same instants.",
        "Served by hapi-server.org (the HAPI project's SSCWeb server), which wraps NASA SSCWeb; "
        "it is not a NASA host. No NASA-hosted SSCWeb HAPI endpoint is listed in the HAPI "
        "server registry (hapi-server/servers all.txt).",
    ]
    src = {
        "publisher": "NASA Goddard Space Flight Center, Space Physics Data Facility (SSCWeb), "
                     "served via hapi-server.org",
        "name": "SSCWeb ISS ephemeris, HAPI dataset 'iss' (positions, IGRF+T89C field, dipole L)",
        "url": "https://sscweb.gsfc.nasa.gov/",
        "access_urls": c.access_urls,
        "license": "No license or data-use terms are stated in the HAPI /info response or on the "
                   "SSCWeb home page (checked 2026-11-14). SSCWeb is a U.S. Government (NASA) "
                   "service.",
        "citation": "NASA GSFC Space Physics Data Facility, Satellite Situation Center Web "
                    "(SSCWeb), ISS ephemeris (dataset 'iss', cadence PT60S, startDate "
                    f"{hapi_time_to_iso(info['startDate'])}, stopDate "
                    f"{hapi_time_to_iso(info['stopDate'])}), accessed through the SSCWeb HAPI "
                    "server https://hapi-server.org/servers/SSCWeb/hapi (HAPI 2.0), retrieved "
                    f"{ctx.retrieved_at}. https://sscweb.gsfc.nasa.gov/",
    }
    data = {
        "environment": "leo_iss",
        "explainer": "Where the ISS is predicted to be over the next day and when it should cross "
                     "the South Atlantic Anomaly, where Earth's inner radiation belt dips closest "
                     "to the surface and the dose rate aboard rises for a few minutes.",
        "dataset": _dataset_meta(SSCWEB_HAPI, "iss", info),
        "parameters": _param_meta(params),
        "fields": {
            "time": "UTC, ISO 8601 (converted from SSCWeb day-of-year format)",
            "lat_deg": "deg, geocentric latitude (Lat_GEO as served)",
            "lon_deg": "deg east, Lon_GEO converted from 0..360 to -180..180",
            "alt_km": "km, WGS84 geodetic height derived from X/Y/Z_GEO (rounded to 0.01 km)",
            "B_nT": "nT, MagneticFldStrth as served (IGRF + T89C model)",
            "L": "dimensionless, DipL-V as served (dipole L-value, IGRF + T89C)",
        },
        "track": track,
        "track_window": {"start": times[0] if times else None,
                         "stop": times[n24 - 1] if n24 else None, "n": n24},
        "saa_rule": {
            "definition": f"An SAA pass is a maximal run of consecutive 60 s samples with "
                          f"MagneticFldStrth < {SAA_B_THRESHOLD_NT:.0f} nT at the ISS position.",
            "threshold_nT": SAA_B_THRESHOLD_NT,
            "basis": "design choice - no published basis",
            "duration_definition": "duration_s = stop - start, where start/stop are the first and "
                                   "last samples inside the run (+/- 60 s).",
            "truncated_definition": "truncated = true when the run touches the first or last "
                                    "sample of the window or a null sample; its true extent "
                                    "is unknown and duration_s is a lower bound.",
            "window": {"start": times[0] if times else None,
                       "stop": times[-1] if times else None},
        },
        "saa_passes": passes,
        "saa_summary": {"n_passes_48h": len(passes), "n_passes_first_24h": len(in_24),
                        "total_minutes_48h": round(sum(p["duration_s"] for p in passes) / 60, 1),
                        "global_min_B_nT": min((p["min_B_nT"] for p in passes), default=None)},
        "conversions": {"sscweb_re_km": SSCWEB_RE_KM,
                        "sscweb_re_km_basis": "derived: SSCWeb REST km / SSCWeb HAPI R_E for "
                                              "2026-11-14T13:00Z..13:05Z (all ratios 6378.16)",
                        "geodetic_model": "WGS84 a=6378.137 km, f=1/298.257223563"},
    }
    return make_snapshot(
        id="hapi_iss_track", adapter=ADAPTER_ID,
        title="ISS predicted track and South Atlantic Anomaly passes (SSCWeb)",
        source=src, retrieved_at=ctx.retrieved_at,
        coverage={"start": times[0], "stop": times[-1], "cadence": "PT60S"},
        # The track spans [floor_hour(retrieved_at), +24 h); the floor can be up to 59 min
        # before retrieved_at, so PT23H after retrieved_at is always still inside the track.
        freshness={"kind": "prediction", "stale_after": "PT23H"},
        provenance="predicted", caveats=caveats, data=data)


# ======================================================================================
# B) CDAWeb ISS TEPC: measured dose on the ISS (historical, 2010-2018)
# ======================================================================================
def build_iss_tepc(ctx: RunContext) -> dict:
    c = HapiClient(ctx, CDAWEB_HAPI)
    ds = "ISS_DOSANL_TEPC"
    info = c.info(ds)
    start_date, stop_date = info_window(info)
    w0, w1 = TEPC_WINDOW
    if not (start_date <= w0 and w1 <= stop_date):
        raise RuntimeError(f"TEPC window {w0}..{w1} outside {start_date}..{stop_date}")
    wanted = ["DOSE", "DOSE_EQ60", "TIME_INTERVAL", "LONGITUDE", "LATITUDE", "ALTITUDE"]
    params, rows = c.data(ds, info, w0, w1, wanted)
    units = {p.name: p.units for p in params}
    assert units["DOSE"] == "uGy/min" and units["DOSE_EQ60"] == "uSv/min", units
    assert units["TIME_INTERVAL"] == "min" and units["ALTITUDE"] == "km", units
    col = {p.name: [r[i] for r in rows] for i, p in enumerate(params)}

    native = {"time": col["Time"], "dose_uGy_per_min": col["DOSE"],
              "dose_eq_uSv_per_min": col["DOSE_EQ60"], "interval_min": col["TIME_INTERVAL"],
              "lat_deg": col["LATITUDE"], "lon_deg": col["LONGITUDE"], "alt_km": col["ALTITUDE"]}
    window_dose = sum((d or 0) * (dt or 0) for d, dt in zip(col["DOSE"], col["TIME_INTERVAL"])
                      if d is not None and dt is not None)
    window_cov = sum(dt for d, dt in zip(col["DOSE"], col["TIME_INTERVAL"])
                     if d is not None and dt is not None)

    # daily dose series over the TEPC_DAILY_DAYS before the native window
    d0 = w0 - timedelta(days=TEPC_DAILY_DAYS)
    _, drows = c.data_chunked(ds, info, d0, w0, ["DOSE", "DOSE_EQ60", "TIME_INTERVAL"],
                              max_span=timedelta(days=30))
    daily: "OrderedDict[str, dict]" = OrderedDict()
    for t, dose, heq, dt in drows:
        if dose is None or dt is None:
            continue
        e = daily.setdefault(t[:10], {"date": t[:10], "dose_uGy": 0.0, "dose_eq_uSv": 0.0,
                                      "covered_min": 0.0, "n": 0})
        e["dose_uGy"] += dose * dt
        if heq is not None:
            e["dose_eq_uSv"] += heq * dt
        e["covered_min"] += dt
        e["n"] += 1
    series = []
    for e in daily.values():
        e["complete"] = e["covered_min"] >= TEPC_COMPLETE_DAY_MIN
        e["dose_uGy"] = round(e["dose_uGy"], 3)
        e["dose_eq_uSv"] = round(e["dose_eq_uSv"], 3)
        e["covered_min"] = round(e["covered_min"], 1)
        series.append(e)
    complete = [e for e in series if e["complete"]]

    caveats = [
        f"HISTORICAL: the dataset stops at {hapi_time_to_iso(info['stopDate'])}; this is not "
        "current ISS dose.",
        "The 24 h native window (2015-06-01) is an arbitrary LANDFALL choice of an ordinary "
        "period showing routine SAA modulation; it is not claimed to be typical of other years "
        "or of solar-particle-event conditions.",
        "DOSE is absorbed dose (µGy) in the detector; DOSE_EQ60 is the publisher's dose "
        "equivalent (ICRP-60 quality factors). Neither is the effective dose (mSv) used by NASA "
        "crew exposure limits, so these values must not be compared with those limits directly.",
        "The CDF file also holds LOCATION (where the TEPC was inside the ISS) and FLAG (dominant "
        "radiation source); the HAPI server does not expose them, so the detector's location "
        "and shielding for this window are unknown here.",
        "Daily dose = sum over the UTC day of DOSE x TIME_INTERVAL; days with < 90 % coverage "
        "(design choice) are marked complete=false and excluded from the mean.",
        "CDAWeb lists doi:10.48322/0ba1-1764 for ISS_DOSANL_TEPC, but DataCite's record for that "
        "DOI describes 'ISS Tissue-Equivalent Proportional Counter (TEPC), Dose Analyzer, 10 s "
        "Data' with coverage 2000-11-09/2010-04-29, while this HAPI dataset spans 2010-2018 at "
        "1 min intervals. The DOI is cited as listed by the publisher; the mismatch is the "
        "publisher's metadata, reported here rather than resolved.",
    ]
    src = {
        "publisher": "NASA Space Radiation Analysis Group (JSC), via NASA GSFC Space Physics "
                     "Data Facility CDAWeb",
        "name": "ISS_DOSANL_TEPC - Experiment Data, ISS TEPC (from ASCII DOS.TXT file)",
        "url": "https://cdaweb.gsfc.nasa.gov/misc/NotesI.html#ISS_DOSANL_TEPC",
        "access_urls": c.access_urls,
        "license": "Not stated in the HAPI /info response. The DataCite record of the DOI "
                   "CDAWeb lists for this dataset (10.48322/0ba1-1764) states Creative Commons "
                   "Zero v1.0 Universal (see caveats about that DOI).",
        "citation": "Semones, E. (contact), NASA Space Radiation Analysis Group / Johnson Space "
                    "Center. ISS_DOSANL_TEPC: Experiment Data, ISS TEPC (TEPC serial number 1003, "
                    "analysis software version 3.1), 2010-04-29 to 2018-04-11. NASA GSFC Space "
                    "Physics Data Facility, CDAWeb HAPI server https://cdaweb.gsfc.nasa.gov/hapi, "
                    f"retrieved {ctx.retrieved_at}. DOI listed by CDAWeb: "
                    "https://doi.org/10.48322/0ba1-1764 (see caveat on its metadata). "
                    "https://cdaweb.gsfc.nasa.gov/misc/NotesI.html#ISS_DOSANL_TEPC",
    }
    data = {
        "environment": "leo_iss",
        "explainer": "What a radiation detector inside the ISS actually measured, minute by "
                     "minute: a background that rises and falls with latitude on every orbit, "
                     "and sharp spikes on the orbits that cut through the South Atlantic "
                     "Anomaly.",
        "dataset": _dataset_meta(CDAWEB_HAPI, ds, info),
        "parameters": _param_meta(params),
        "fields": {"time": "UTC", "dose_uGy_per_min": "uGy/min (DOSE as served)",
                   "dose_eq_uSv_per_min": "uSv/min (DOSE_EQ60 as served)",
                   "interval_min": "min (TIME_INTERVAL as served)",
                   "lat_deg": "deg (LATITUDE as served)", "lon_deg": "deg (LONGITUDE as served)",
                   "alt_km": "km (ALTITUDE as served)"},
        "native_window": {"start": to_iso_z(w0), "stop": to_iso_z(w1), "n": len(rows),
                          "expected_n_at_1min": int((w1 - w0).total_seconds() // 60),
                          "dose_uGy": round(window_dose, 3), "covered_min": window_cov,
                          "dose_rate_stats_uGy_per_min": summary_stats(col["DOSE"]),
                          "stats_method": STATS_METHOD},
        "native": native,
        "daily": {"window": {"start": to_iso_z(d0), "stop": to_iso_z(w0)},
                  "method": "dose_uGy = sum(DOSE[uGy/min] * TIME_INTERVAL[min]) per UTC day",
                  "series": series,
                  "mean_complete_day_dose_uGy": round(statistics.fmean(
                      e["dose_uGy"] for e in complete), 3) if complete else None,
                  "mean_complete_day_dose_eq_uSv": round(statistics.fmean(
                      e["dose_eq_uSv"] for e in complete), 3) if complete else None,
                  "n_complete_days": len(complete)},
        "conversions": {"uGy_per_min_to_uGy_per_day": DOSE_RATE_TO_UGY_PER_DAY["uGy/min"]},
    }
    return make_snapshot(
        id="hapi_iss_tepc", adapter=ADAPTER_ID,
        title="ISS measured dose rate, TEPC (NASA SRAG/JSC via CDAWeb)",
        source=src, retrieved_at=ctx.retrieved_at,
        coverage={"start": to_iso_z(d0), "stop": to_iso_z(w1), "cadence": "PT1M"},
        freshness={"kind": "historical", "stale_after": None},
        provenance="measured", caveats=caveats, data=data)


# ======================================================================================
# C/D) CCMC iSWA deep-space dose: CRaTER (lunar orbit) and MSL RAD (Mars surface)
# ======================================================================================
def _deep_space(ctx: RunContext, *, dataset: str, sid: str, wanted: list[str], headline: str,
                environment: str, title: str, name: str, explainer: str,
                extra_caveats: list[str],
                derived_caveats: Callable[[dict], list[str]] | None = None) -> dict:
    c = HapiClient(ctx, ISWA_HAPI)
    info = c.info(dataset)
    start_date, stop_date = info_window(info)
    w1 = stop_date + timedelta(seconds=1)  # time.max is exclusive; include the last sample
    w0 = max(start_date, stop_date - timedelta(days=DEEP_SPACE_WINDOW_DAYS))
    params, rows = c.data_chunked(dataset, info, w0, w1, wanted, max_span=ISWA_MAX_SPAN)
    units = {p.name: p.units for p in params}
    col = {p.name: [r[i] for r in rows] for i, p in enumerate(params)}
    times = col["Time"]
    age_days = (parse_hapi_time(ctx.retrieved_at) - stop_date).total_seconds() / 86400

    per_param = {}
    for name_ in wanted:
        u = units[name_]
        st = summary_stats(col[name_])
        if u in DOSE_RATE_TO_UGY_PER_DAY and st.get("n"):
            st["mean_uGy_per_day"] = round(to_ugy_per_day(st["mean"], u), 3)
            st["median_uGy_per_day"] = round(to_ugy_per_day(st["median"], u), 3)
        per_param[name_] = {"units": u, "summary": st,
                            "daily": daily_aggregate(times, col[name_])}
    head_daily = per_param[headline]["daily"]
    head_median = per_param[headline]["summary"].get("median")
    enhanced = enhanced_days(head_daily, head_median, ENHANCED_DAY_FACTOR)
    spacing = median_spacing_s(times)
    sampled_days = {t[:10] for t in times}
    days_without_samples = [e["date"] for e in head_daily if e["date"] not in sampled_days]
    caveats = [
        f"Latest data in the dataset ends {hapi_time_to_iso(info['stopDate'])} "
        f"({age_days:.1f} days before retrieval); the window is the {DEEP_SPACE_WINDOW_DAYS} days "
        "up to that stopDate, not up to today.",
        "Absorbed dose rate (Gy) is not effective dose (Sv); NASA crew exposure limits are "
        "expressed in Sv or organ mGy-Eq, so these values must not be compared with them "
        "directly.",
        "Daily values are unweighted means of the native samples in each UTC day (n given); "
        "gaps in the native series are not interpolated. Calendar days with no sample at all "
        "are still listed, with n = 0 and null values"
        + (f" ({', '.join(days_without_samples)})" if days_without_samples else "") + ".",
        "Values are reported as served; LANDFALL applies no correction factor of its own. "
        "µGy/day equivalents are unit conversions only (explicit factor in data.conversions).",
        "Served by NASA GSFC CCMC iSWA; no license or data-use terms are stated in the HAPI "
        "/info response.",
        f"enhanced_days uses a LANDFALL rule (daily mean of {headline} > "
        f"{ENHANCED_DAY_FACTOR:g} x the window median) - design choice, no published basis. It "
        "flags days for a human to look at; it does NOT identify them as solar particle events.",
        f"Native sample spacing in this window: median {spacing} s"
        + ("" if info.get("cadence") else " (the dataset /info declares no cadence)") + ".",
    ] + extra_caveats + (derived_caveats(per_param) if derived_caveats else [])
    src = {
        "publisher": "NASA GSFC Community Coordinated Modeling Center (CCMC), iSWA HAPI server",
        "name": name,
        "url": f"{ISWA_HAPI}/info?id={dataset}",
        "access_urls": c.access_urls,
        "license": "No license or data-use terms stated in the HAPI /info response (checked "
                   "2026-11-14).",
        "citation": f"NASA GSFC Community Coordinated Modeling Center (CCMC), Integrated Space "
                    f"Weather Analysis system (iSWA), HAPI dataset '{dataset}' "
                    f"('{info.get('title') or info.get('description')}', startDate "
                    f"{hapi_time_to_iso(info['startDate'])}, stopDate "
                    f"{hapi_time_to_iso(info['stopDate'])}), HAPI server {ISWA_HAPI}, retrieved "
                    f"{ctx.retrieved_at}.",
    }
    data = {
        "environment": environment,
        "explainer": explainer,
        "dataset": _dataset_meta(ISWA_HAPI, dataset, info),
        "parameters": _param_meta(params),
        "headline_parameter": headline,
        "window": {"start": times[0] if times else None, "stop": times[-1] if times else None,
                   "n_samples": len(rows), "days_requested": DEEP_SPACE_WINDOW_DAYS},
        "data_age_days_at_retrieval": round(age_days, 2),
        "native_median_spacing_s": spacing,
        "days_without_samples": days_without_samples,
        "stats_method": STATS_METHOD,
        "enhanced_days": {"rule": f"daily mean of {headline} > {ENHANCED_DAY_FACTOR:g} x window "
                                  f"median ({head_median} {units[headline]})",
                          "basis": "design choice - no published basis",
                          "days": enhanced},
        "series": per_param,
        "conversions": {k: v for k, v in DOSE_RATE_TO_UGY_PER_DAY.items()
                        if k in set(units.values())},
    }
    return make_snapshot(
        id=sid, adapter=ADAPTER_ID, title=title, source=src, retrieved_at=ctx.retrieved_at,
        coverage={"start": times[0] if times else None, "stop": times[-1] if times else None,
                  "cadence": info.get("cadence")},
        freshness={"kind": "historical", "stale_after": None},
        provenance="measured", caveats=caveats, data=data)


def build_crater(ctx: RunContext) -> dict:
    return _deep_space(
        ctx, dataset="CRaTER", sid="hapi_crater_dose",
        wanted=["d1_2_dose_rate", "d3_4_dose_rate", "d5_6_dose_rate"],
        headline="d1_2_dose_rate", environment="cislunar_lunar_orbit",
        title="Lunar-orbit dose rate, LRO CRaTER (CCMC iSWA)",
        name="CRaTER Dose Rates (iSWA HAPI id 'CRaTER')",
        explainer="Radiation dose rate measured in orbit around the Moon by LRO, outside Earth's "
                  "magnetic shield: the environment a crew near the Moon would face, before "
                  "their own spacecraft's shielding is counted.",
        extra_caveats=[
            "Measured in lunar orbit aboard the Lunar Reconnaissance Orbiter, not in free "
            "cislunar space or on the lunar surface; the Moon blocks part of the sky. The "
            "dataset's 'alt' factor ('Altitude correction to lunar surface') is NOT applied.",
            "Publisher description: 'CRaTER (GCR+SEP) dose rates for individual and combined "
            "detectors with silicon to water correction'. The three detector pairs sit behind "
            "different shielding inside the telescope; LANDFALL does not interpret which pair "
            "best represents a crewmember. headline_parameter (d1_2) is the first pair listed, "
            "a display choice only.",
        ])


def build_msl(ctx: RunContext) -> dict:
    return _deep_space(
        ctx, dataset="msl_rad_dosimetry", sid="hapi_msl_rad_dose",
        wanted=["dose_b_raw", "dose_b_rtg", "dose_e_total"],
        headline="dose_e_total", environment="mars_surface",
        title="Mars-surface dose rate, MSL RAD (CCMC iSWA)",
        name="MSL RAD Dosimetry (iSWA HAPI id 'msl_rad_dosimetry')",
        explainer="Radiation dose rate measured on the surface of Mars by the Curiosity rover's "
                  "RAD instrument: the environment a crew working outdoors on Mars would face, "
                  "before any habitat shielding.",
        extra_caveats=[
            "Publisher descriptions: dose_b_* = 'Radiation dose rate in Si detector B' (raw, and "
            "RTG-corrected), dose_e_total = 'Radiation dose rate in tissue-equivalent plastic "
            "detector E'. The description does not say whether dose_e_total is RTG-corrected. "
            "headline_parameter (dose_e_total) is chosen because tissue-equivalent plastic is "
            "closer to tissue than silicon - a display choice, not a publisher recommendation.",
            "The dataset's /info startDate (2011-11-20) precedes landing, but the served series "
            "starts at 2012-08-17T10:20:37Z: every earlier window returns HAPI 1406 'No data "
            "available' (probed by the rad_events adapter), so it holds no cruise data. This "
            "snapshot uses the latest 90 days.",
        ],
        derived_caveats=_msl_rtg_caveat)


def _msl_rtg_caveat(per_param: dict) -> list[str]:
    """Scale of the RTG question, computed from this window's own data (no external number)."""
    med = {k: per_param[k]["summary"].get("median") for k in
           ("dose_b_raw", "dose_b_rtg", "dose_e_total")}
    if None in med.values():
        return []
    raw, rtg, e = med["dose_b_raw"], med["dose_b_rtg"], med["dose_e_total"]
    return [f"For scale, from this window's own data: the publisher's RTG correction lowers "
            f"detector B's median from {raw:.1f} to {rtg:.1f} µGy/day ({raw - rtg:.1f} µGy/day). "
            f"dose_e_total's median is {e:.1f} µGy/day. On the rover's RTG background, the RAD team's "
            f"paper ({MSL_RTG_PAPER}) writes: \"{MSL_RTG_QUOTE}\" LANDFALL applies no RTG correction to "
            "dose_e_total."]


BUILDERS = [build_iss_track, build_iss_tepc, build_crater, build_msl]


def run(ctx: RunContext) -> list[dict]:
    snaps, errors = [], []
    for b in BUILDERS:
        try:
            snaps.append(b(ctx))
        except Exception as exc:  # noqa: BLE001 - one dead source must not block the others
            errors.append(f"{b.__name__}: {exc}")
            print(f"[hapi] {b.__name__} FAILED: {exc}", file=sys.stderr)
            traceback.print_exc()
    if not snaps:
        raise RuntimeError("hapi: every source failed: " + "; ".join(errors))
    return snaps
