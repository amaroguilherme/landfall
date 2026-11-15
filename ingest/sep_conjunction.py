"""`sep_conjunction` adapter: sol 242. Curiosity's RAD measured a solar particle event at Gale crater on
11 April 2013, while Mars was in solar conjunction and JPL had planned to suspend commanding to Curiosity
(4 April to 1 May). This adapter rebuilds that observation from NASA's public archives, beside NOAA's
list and the RAD team's paper.

    uv run python -m ingest sep_conjunction             # online: one CDAWeb /info, one /data, the PDF
    uv run python -m ingest sep_conjunction --offline   # replays .cache/ingest/sep_conjunction/ exactly
    uv run python -m ingest.sep_conjunction --seed-pdf FILE   # only if the PDF host refuses this client

Snapshot sep_conjunction_2013, provenance "derived": the hourly means, backgrounds and multiples are
arithmetic on measured records, as in hapi_msl_rad_sep_events. Nothing here feeds the engine, the
rules, the scenario or the hero.

Sources (each fetched here, or read from a snapshot or cache this build already has):
  * MSL RAD dose_e_total (CCMC iSWA HAPI 'msl_rad_dosimetry'): the record ingest/rad_events.py cached,
    always read through an OFFLINE context, so even an online run of this adapter never re-fetches
    iSWA (an online context would refresh every 30-day window older than 6 h).
  * STEREO-B HET Proton_Flux (NASA GSFC SPDF CDAWeb HAPI id 'STB_L1_HET'): one /info and one /data
    request, cached under .cache/ingest/sep_conjunction/. The parameter is an 11-bin array, which
    _hapi_client.parse_csv rejects, so the 12-column CSV is parsed here with the fill from /info.
  * Hassler et al. 2014, Science 343:1244797 (doi:10.1126/science.1244797): the PDF served by Science
    in the Classroom, SHA-256 pinned; every quoted fragment is re-found in its pdfminer text at build.
  * NOAA's SPE list (swpc_spe_list), JPL's 2013 windows (horizons_mars_comms) and the RAD team's
    Table 1 row (hapi_msl_rad_sep_events), read from the snapshots this build ships, never re-fetched.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import io
import json
import math
import re
import statistics
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ingest import rad_events
from ingest._hapi_client import build_url, check_hapi_status, hapi_time_to_iso, is_fill, parse_hapi_time
from ingest.common import DEFAULT_CACHE_DIR, RunContext, make_snapshot, sha256_hex, to_iso_z
from ingest.hapi import CDAWEB_HAPI, ISWA_HAPI

ADAPTER_ID = "sep_conjunction"
DEPENDS_ON = ["swpc", "horizons", "rad_events"]
SNAPSHOT_ID = "sep_conjunction_2013"
CACHE_SUBDIR = "sep_conjunction"

UTC = timezone.utc
DAY_S = 86_400
HOUR_S = 3_600

# ---- the axis the page draws (both charts share it) ---------------------------------------------
AXIS_START = datetime(2013, 4, 10, tzinfo=UTC)
AXIS_STOP = datetime(2013, 4, 13, tzinfo=UTC)

# ---- MSL RAD (the record rad_events.py cached) --------------------------------------------------
TABLE1_DATE = "2013-04-10"     # the RAD team's Table 1 row; the background is the 5 UTC days before it
# "First clear rise": the first sample on the axis more than 10 % above the 5-day background. LANDFALL's
# own threshold (design choice), about three times the largest excursion inside the background window.
RISE_FACTOR = 1.10

# ---- STEREO-B HET (CDAWeb HAPI) -------------------------------------------------------------------
HET_DATASET = "STB_L1_HET"
HET_PARAMETER = "Proton_Flux"
HET_START = datetime(2013, 4, 8, tzinfo=UTC)
HET_STOP = datetime(2013, 4, 15, tzinfo=UTC)
QUIET_START = datetime(2013, 4, 8, tzinfo=UTC)   # 8 and 9 April: the quiet medians
QUIET_STOP = datetime(2013, 4, 10, tzinfo=UTC)
HET_CENTRES_MEV = (14.3, 15.9, 18.15, 22.2, 25.1, 28.05, 31.75, 34.85, 38.05, 50.0, 80.0)
HET_KEEP_MEV = (14.3, 50.0, 80.0)
MULTIPLE_MEV = (50.0, 80.0)      # the 14.3 MeV channel reads 0 when quiet: no multiple is defined
FIRST_ABOVE_FACTOR = 10.0
EXPECTED_HET_UNITS = "#/(cm2-sr-s-MeV/n)"

# ---- Hassler et al. 2014 ---------------------------------------------------------------------------
PDF_URL = "https://www.scienceintheclassroom.org/sites/default/files/research-papers/1244797.full_.pdf"
PDF_SHA256 = "1cd81ff354e883bff449fcffad39448baf8bed0a34799572a1639ec15631145d"
PDF_BYTES = 1_444_324
DOI = "10.1126/science.1244797"
DOI_URL = "https://doi.org/10.1126/science.1244797"
PAPER_TITLE = "Mars’ Surface Radiation Environment Measured with the Mars Science Laboratory’s Curiosity Rover"
PAPER_CITATION = (f"Hassler DM, Zeitlin C, Wimmer-Schweingruber RF, et al. {PAPER_TITLE.replace(chr(0x2019), chr(39))}. "
                  f"Science 343(6169):1244797 (2014). doi:{DOI}")
# Verbatim after pdfminer extraction, whitespace normalisation and joining line-break hyphens (a letter,
# "- ", then a letter becomes the two letters): see normalise_pdf_text(). Checked on every build.
FRAGMENTS: list[dict] = [
    {"id": "fig5_caption",
     "text": "(A) Dose rate enhancement observed on the martian surface by RAD on sol 242 (11 to 12 April 2013), "
             "while Mars was in solar conjunction. (B) The same SEP event seen from the STEREO-B spacecraft, "
             "almost magnetically aligned with Mars. (C) The same SEP event seen by the GOES-13 satellite in "
             "earth orbit, almost 180° away in heliospheric longitude."},
    {"id": "stereo_b_leading",
     "text": "STEREO-B was leading Mars (in longitude) at the time of the event and had similar, but not "
             "identical, magnetic connection to the Sun."},
    {"id": "goes_180",
     "text": "Because Mars was in solar conjunction at this time, GOES-13 was nearly 180° in heliospheric "
             "longitude away"},
    {"id": "enhancement_30",
     "text": "its energy spectrum was hard enough to produce an enhancement of ~30% over the GCR dose rate on "
             "the martian surface"},
    {"id": "four_orders_subject", "text": "The 40- to 100-MeV proton flux seen by STEREO-B"},
    {"id": "four_orders", "text": "increased almost four orders of magnitude at the peak of this event"},
    {"id": "min_energy", "text": "The minimum proton energy required to reach the surface in Gale crater is ~150 MeV."},
    {"id": "fig1_date", "text": "sol 242 (12 to 13 April 2013)"},
    {"id": "title", "text": PAPER_TITLE},
    {"id": "doi", "text": DOI},
]
FIG5_DATE = "11 to 12 April 2013"
FIG1_DATE = "12 to 13 April 2013"
PDF_GLYPH_CAVEAT = ("pdfminer renders this PDF's µ as 'm' and its ± as 'T', so no µGy or "
                    "± figure is quoted from it.")
BY_HAND_SUFFIX = ".by_hand.json"

# ---- the snapshots this build ships (read, never re-fetched) -------------------------------------
NOAA_EVENT_START = "2013-04-11T10:55:00Z"
NOAA_SCENARIO_START = "1989-10-19T13:05:00Z"   # the October 1989 storm the scenario replays (swpc_spe_replay)
JPL_IDS = ("2013_curiosity", "2013_orbiters")


# ================================================================================================
# Pure helpers (known-answer tests in ingest/tests/test_sep_conjunction.py)
# ================================================================================================
def epoch(dt: datetime) -> int:
    return int(dt.timestamp())


def iso(t: int) -> str:
    return to_iso_z(datetime.fromtimestamp(t, UTC))


def sig(v: float | None, digits: int = 4) -> float | None:
    """Round to `digits` significant figures (the HET CSV prints three)."""
    if v is None or v == 0 or not math.isfinite(v):
        return v
    return float(f"{v:.{digits}g}")


def normalise_pdf_text(text: str) -> str:
    """Whitespace runs -> one space, then a line-break hyphen between two letters is joined
    ('near- ly' -> 'nearly'). Digits are not letters: '40- to 100-MeV' stays as printed."""
    n = re.sub(r"\s+", " ", text)
    return re.sub(r"([^\W\d_])- ([^\W\d_])", r"\1\2", n)


def fragments_missing(text: str, fragments: list[dict] = FRAGMENTS) -> list[str]:
    """Ids of the fragments not found verbatim in the normalised text."""
    norm = normalise_pdf_text(text)
    return [f["id"] for f in fragments if re.sub(r"\s+", " ", f["text"]) not in norm]


def parse_het_csv(text: str, n_values: int, fill: str | None) -> tuple[list[int], list[list[float | None]]]:
    """HAPI CSV of one array parameter: time + n_values columns per row; the declared fill -> None."""
    check_hapi_status(text)
    T: list[int] = []
    rows: list[list[float | None]] = []
    for i, rec in enumerate(csv.reader(io.StringIO(text))):
        if not rec or (len(rec) == 1 and not rec[0].strip()) or rec[0].startswith("#"):
            continue
        if len(rec) != n_values + 1:
            raise ValueError(f"CSV row {i} has {len(rec)} columns, expected {n_values + 1}: {rec[:3]}")
        vals: list[float | None] = []
        for c in rec[1:]:
            c = c.strip()
            v = None if (c == "" or is_fill(c, fill)) else float(c)
            vals.append(None if v is not None and math.isnan(v) else v)
        T.append(epoch(parse_hapi_time(rec[0])))
        rows.append(vals)
    return T, rows


def hourly_means(T: list[int], values: list[float | None], t0: int, n_hours: int) -> tuple[list[float | None], list[int]]:
    """Arithmetic mean of the non-fill values in each UTC hour [t0 + k h, t0 + (k + 1) h), and the count."""
    sums = [0.0] * n_hours
    counts = [0] * n_hours
    parts: list[list[float]] = [[] for _ in range(n_hours)]
    for t, v in zip(T, values):
        k = (t - t0) // HOUR_S
        if v is None or not 0 <= k < n_hours:
            continue
        parts[k].append(v)
        counts[k] += 1
    for k in range(n_hours):
        sums[k] = math.fsum(parts[k])
    return [sums[k] / counts[k] if counts[k] else None for k in range(n_hours)], counts


def first_index(values: list[float | None], start: int, above: float) -> int | None:
    return next((k for k in range(start, len(values)) if values[k] is not None and values[k] > above), None)


def count_in_window(T: list[int], start_date: str, end_date: str) -> int:
    """Samples from start_date 00:00Z up to (not including) the day after end_date, 00:00Z."""
    lo = epoch(datetime.fromisoformat(start_date).replace(tzinfo=UTC))
    hi = epoch(datetime.fromisoformat(end_date).replace(tzinfo=UTC) + timedelta(days=1))
    return bisect.bisect_left(T, hi) - bisect.bisect_left(T, lo)


def rad_moments(T: list[int], E: list[float], bg: float, lo: int, hi: int) -> dict:
    """On the axis [lo, hi): the peak; the first clear rise (the first sample above RISE_FACTOR x the
    background, up to the peak) and the sample before it; the first sample after the peak below the
    background; and the highest sample after that one (the record's level once the event is over)."""
    i0, i1 = bisect.bisect_left(T, lo), bisect.bisect_left(T, hi)
    if i1 <= i0:
        raise ValueError("no RAD samples on the axis")
    pk = max(range(i0, i1), key=E.__getitem__)
    rise = next((k for k in range(i0, pk + 1) if E[k] > RISE_FACTOR * bg), None)
    back = next((k for k in range(pk + 1, i1) if E[k] < bg), None)
    after = max(range(back + 1, i1), key=E.__getitem__) if back is not None and back + 1 < i1 else None

    def point(k: int | None) -> dict | None:
        if k is None:
            return None
        return {"t": iso(T[k]), "uGy_per_day": E[k], "ratio_to_background": round(E[k] / bg, 3)}

    return {"i0": i0, "i1": i1, "peak": point(pk), "first_rise": point(rise), "back_below_background": point(back),
            "last_before_rise": point(rise - 1) if rise is not None and rise > i0 else None,
            "highest_after_back": point(after)}


# ================================================================================================
# Fetching
# ================================================================================================
def sub_context(ctx: RunContext) -> RunContext:
    return RunContext(offline=ctx.offline, cache_dir=ctx.cache_dir / CACHE_SUBDIR, out_dir=ctx.out_dir,
                      retrieved_at=ctx.retrieved_at, timeout=ctx.timeout)


def rad_record(ctx: RunContext) -> dict:
    """The record rad_events.py cached, through an offline context even on an online run."""
    off = RunContext(offline=True, cache_dir=ctx.cache_dir / rad_events.CACHE_SUBDIR, retrieved_at=ctx.retrieved_at)
    return rad_events.fetch_record(off)


def het_query() -> dict:
    return {"id": HET_DATASET, "time.min": to_iso_z(HET_START), "time.max": to_iso_z(HET_STOP),
            "parameters": HET_PARAMETER, "format": "csv"}


def fetch_het(sub: RunContext) -> dict:
    info_q = {"id": HET_DATASET}
    raw_info = sub.fetch_bytes(f"{CDAWEB_HAPI}/info", info_q)
    check_hapi_status(raw_info)
    info = json.loads(raw_info)
    p = next((x for x in info.get("parameters", []) if x.get("name") == HET_PARAMETER), None)
    if p is None:
        raise RuntimeError(f"{HET_PARAMETER} not in the /info of {HET_DATASET}")
    size = p.get("size")
    centres = [float(c) for c in (p.get("bins") or [{}])[0].get("centers", [])]
    if size != [len(HET_CENTRES_MEV)] or len(centres) != len(HET_CENTRES_MEV) or any(
            abs(a - b) > 1e-4 for a, b in zip(centres, HET_CENTRES_MEV)):
        raise RuntimeError(f"{HET_DATASET} {HET_PARAMETER} bins changed: size {size}, centres {centres}")
    units = str(p.get("units") or "").strip()
    if units != EXPECTED_HET_UNITS:
        raise RuntimeError(f"{HET_PARAMETER} units changed: {units!r}")
    start, stop = hapi_time_to_iso(info["startDate"]), hapi_time_to_iso(info["stopDate"])
    if not (start <= to_iso_z(HET_START) and to_iso_z(HET_STOP) <= stop):
        raise RuntimeError(f"{HET_DATASET} coverage {start}..{stop} does not hold the request")
    text = sub.fetch_text(f"{CDAWEB_HAPI}/data", het_query())
    T, rows = parse_het_csv(text, len(centres), p.get("fill"))
    return {"info": info, "param": p, "centres": centres, "units": units, "T": T, "rows": rows,
            "info_url": build_url(CDAWEB_HAPI, "info", info_q), "data_url": build_url(CDAWEB_HAPI, "data", het_query()),
            "coverage": {"start": start, "stop": stop}}


def _by_hand_marker(sub: RunContext) -> Path:
    path = sub._cache_path(PDF_URL, None)
    return path.with_name(path.name + BY_HAND_SUFFIX)


def fetch_pdf(sub: RunContext) -> tuple[bytes, dict | None]:
    """The PDF and, when it was saved by hand (seed_pdf), the marker that says so."""
    marker = _by_hand_marker(sub)
    if marker.exists():
        raw = sub._cache_path(PDF_URL, None).read_bytes()
        by_hand = json.loads(marker.read_text())
    else:
        try:
            raw = sub.fetch_bytes(PDF_URL)
        except RuntimeError as exc:
            raise RuntimeError(f"{exc}. If the host refuses this client, save the PDF by hand from {PDF_URL} and "
                               "run `uv run python -m ingest.sep_conjunction --seed-pdf FILE`") from exc
        by_hand = None
    if sha256_hex(raw) != PDF_SHA256 or len(raw) != PDF_BYTES:
        raise RuntimeError(f"PDF at {PDF_URL} changed: {len(raw)} B, SHA-256 {sha256_hex(raw)}; re-read the paper")
    return raw, by_hand


def seed_pdf(file: Path, cache_dir: Path = DEFAULT_CACHE_DIR, saved_on: str | None = None) -> Path:
    """Seed the cache with a copy saved by hand from PDF_URL, after checking its SHA-256."""
    raw = Path(file).read_bytes()
    if sha256_hex(raw) != PDF_SHA256 or len(raw) != PDF_BYTES:
        raise SystemExit(f"{file}: {len(raw)} B, SHA-256 {sha256_hex(raw)} is not the pinned PDF")
    sub = RunContext(offline=True, cache_dir=Path(cache_dir) / CACHE_SUBDIR)
    path = sub._cache_path(PDF_URL, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.with_suffix(".url").write_text(PDF_URL)
    day = saved_on or datetime.now(UTC).date().isoformat()
    _by_hand_marker(sub).write_text(json.dumps({"url": PDF_URL, "sha256": PDF_SHA256, "bytes": len(raw),
                                                "saved_on": day}, indent=1) + "\n")
    return path


def pdf_text(raw: bytes) -> str:
    from pdfminer.high_level import extract_text  # lazily: only the ingest extra needs pdfminer

    return extract_text(io.BytesIO(raw))


def verify_paper(sub: RunContext) -> dict:
    raw, by_hand = fetch_pdf(sub)
    missing = fragments_missing(pdf_text(raw))
    if missing:
        raise RuntimeError(f"Hassler et al. 2014: fragments not found verbatim in {PDF_URL}: {missing}")
    return {
        "citation": PAPER_CITATION, "authors_short": "Hassler DM et al.", "title": PAPER_TITLE,
        "journal": "Science", "volume": "343", "issue": "6169", "article_number": "1244797", "year": 2014,
        "doi": DOI, "doi_url": DOI_URL, "pdf_url": PDF_URL, "pdf_bytes": len(raw), "pdf_sha256": sha256_hex(raw),
        "pdf_saved_by_hand_on": by_hand["saved_on"] if by_hand else None,
        "fragments": [dict(f) for f in FRAGMENTS], "fragments_verified_this_build": True,
        "quote_check": "every fragment is re-found in the pdfminer text of the pinned PDF after whitespace "
                       "normalisation and joining line-break hyphens between two letters",
        "dates": {"table1": TABLE1_DATE, "fig5": FIG5_DATE, "fig1": FIG1_DATE},
        "figure_note": "The paper's figures are not reproduced (AAAS copyright): the page rebuilds the event "
                       "from the public records and quotes short, attributed fragments.",
    }


# ================================================================================================
# The shipped snapshots
# ================================================================================================
def _shipped(ctx: RunContext, sid: str) -> dict:
    return json.loads((ctx.out_dir / f"{sid}.json").read_text())


def noaa_entries(ctx: RunContext) -> dict:
    snap = _shipped(ctx, "swpc_spe_list")
    evs = snap["data"]["events"]

    def one(start: str) -> dict:
        hits = [e for e in evs if e["start"] == start]
        if len(hits) != 1:
            raise RuntimeError(f"swpc_spe_list has {len(hits)} entries starting {start}")
        return dict(hits[0])

    return {"snapshot": "swpc_spe_list", "retrieved_at": snap["retrieved_at"], "unit": snap["data"].get("unit"),
            "energy": snap["data"].get("energy"), "event": one(NOAA_EVENT_START),
            "scenario_event": one(NOAA_SCENARIO_START), "publisher": snap["source"]["publisher"],
            "url": snap["source"]["url"]}


_JPL_KEYS = ("id", "conjunction", "scope", "quote", "doc", "publisher", "published", "url", "start_date",
             "end_date", "quote_verified_this_build", "quote_verification_note")


def jpl_windows(ctx: RunContext) -> list[dict]:
    snap = _shipped(ctx, "horizons_mars_comms")
    return [{k: w.get(k) for k in _JPL_KEYS} for w in snap["data"]["calibration"]["published"]]


def table1_row(ctx: RunContext) -> dict:
    snap = _shipped(ctx, "hapi_msl_rad_sep_events")
    row = next(r for r in snap["data"]["table1"] if r["paper_date"] == TABLE1_DATE)
    return {"snapshot": "hapi_msl_rad_sep_events", "retrieved_at": snap["retrieved_at"],
            "paper_row": row["paper_row"], "paper": row["paper"], "replay": row["replay"],
            "status": row["comparison"]["status"],
            "paper_ref": f"{snap['data']['literature']['authors'][0].split()[-1]} et al. 2025, Table 1 (Martian surface)"}


# ================================================================================================
# Snapshot
# ================================================================================================
def build(ctx: RunContext) -> dict:
    sub = sub_context(ctx)
    rec = rad_record(ctx)
    T, E = rec["T"], rec["E"]
    het = fetch_het(sub)
    lit = verify_paper(sub)
    noaa = noaa_entries(ctx)
    jpl = jpl_windows(ctx)
    t1 = table1_row(ctx)

    # ---- RAD: background and the 1.25 x line exactly as rad_events.replay_date computes them --------
    rp = rad_events.replay_date(T, E, TABLE1_DATE)
    for k in ("background_uGy_per_day", "threshold_uGy_per_day", "background_n_samples", "triggered",
              "max_ratio_to_background", "max_at"):
        if rp.get(k) != t1["replay"].get(k):
            raise RuntimeError(f"replay of {TABLE1_DATE} differs from hapi_msl_rad_sep_events on {k}: "
                               f"{rp.get(k)!r} vs {t1['replay'].get(k)!r}")
    d0 = rad_events.epoch(TABLE1_DATE)
    bg_lo = d0 - rad_events.BACKGROUND_DAYS * DAY_S
    bg, n_bg = rad_events.mean_between(T, E, bg_lo, d0)
    j0, j1 = bisect.bisect_left(T, bg_lo), bisect.bisect_left(T, d0)
    excursion = max(abs(e / bg - 1.0) for e in E[j0:j1])
    lo, hi = epoch(AXIS_START), epoch(AXIS_STOP)
    m = rad_moments(T, E, bg, lo, hi)
    i0, i1 = m.pop("i0"), m.pop("i1")
    thr = rad_events.THRESHOLD_FACTOR * bg
    above = sum(1 for e in E[i0:i1] if e > thr)

    # ---- STEREO-B: hourly means of three channels, quiet medians, multiples ------------------------
    h0 = epoch(HET_START)
    n_hours = (epoch(HET_STOP) - h0) // HOUR_S
    q0, q1 = (epoch(QUIET_START) - h0) // HOUR_S, (epoch(QUIET_STOP) - h0) // HOUR_S
    channels = []
    n_fill = sum(1 for r in het["rows"] for v in r if v is None)
    for mev in HET_KEEP_MEV:
        idx = min(range(len(het["centres"])), key=lambda i: abs(het["centres"][i] - mev))
        means, counts = hourly_means(het["T"], [r[idx] for r in het["rows"]], h0, n_hours)
        quiet_vals = [v for v in means[q0:q1] if v is not None]
        quiet = statistics.median(quiet_vals) if quiet_vals else None
        pk = max((k for k in range(q1, n_hours) if means[k] is not None), key=lambda k: means[k])  # type: ignore[arg-type,return-value]
        ch = {"centre_MeV": mev, "index": idx, "mean": [sig(v) for v in means], "n": counts,
              "quiet_median": sig(quiet), "quiet_n_hours": len(quiet_vals),
              "peak": {"t": iso(h0 + pk * HOUR_S), "mean": sig(means[pk])}}
        if mev in MULTIPLE_MEV and quiet:
            first = first_index(means, q1, FIRST_ABOVE_FACTOR * quiet)
            ch["peak"]["multiple_of_quiet"] = round(means[pk] / quiet)  # type: ignore[operator]
            ch["first_hour_above_10x_quiet"] = iso(h0 + first * HOUR_S) if first is not None else None
        else:
            ch["peak"]["multiple_of_quiet"] = None
            ch["first_hour_above_10x_quiet"] = None
            ch["no_multiple_reason"] = "quiet median is 0: the channel reads 0 when quiet" if quiet == 0 else None
        channels.append(ch)

    # ---- the moratorium windows: RAD samples inside each -------------------------------------------
    # Every published window holds Curiosity except the 2013 orbiter window (Odyssey and MRO; Curiosity had its own).
    moratoria = []
    for w in jpl:
        moratoria.append({"id": w["id"], "start_date": w["start_date"], "end_date": w["end_date"], "scope": w["scope"],
                          "applies_to_curiosity": w["id"] != "2013_orbiters",
                          "n_samples": count_in_window(T, w["start_date"], w["end_date"])})
    cur = next(w for w in jpl if w["id"] == "2013_curiosity")
    cur_lo = epoch(datetime.fromisoformat(cur["start_date"]).replace(tzinfo=UTC))
    cur_hi = epoch(datetime.fromisoformat(cur["end_date"]).replace(tzinfo=UTC) + timedelta(days=1))

    # ---- access URLs: only the iSWA windows this snapshot reads ------------------------------------
    used = [(bg_lo, hi)] + [(epoch(datetime.fromisoformat(w["start_date"]).replace(tzinfo=UTC)),
                             epoch(datetime.fromisoformat(w["end_date"]).replace(tzinfo=UTC) + timedelta(days=1))) for w in jpl]
    wins = (rad_events.windows(rad_events.PROBE_START, rad_events.RECORD_START)
            + rad_events.windows(rad_events.RECORD_START, rad_events.RECORD_STOP))
    rad_urls = [u for (a, b), u in zip(wins, rec["data_urls"]) if any(epoch(a) < y and x < epoch(b) for x, y in used)]

    data = {
        "explainer": "Sol 242: Curiosity's RAD measured a solar particle event at Gale crater on 11 April 2013, "
                     "while Mars was in solar conjunction and JPL had planned to suspend commanding to Curiosity. "
                     "Rebuilt from NASA's public records (MSL RAD on CCMC iSWA, STEREO-B HET on CDAWeb), beside "
                     "NOAA's list and the RAD team's paper. Nothing here feeds LANDFALL's engine, rules or scenario.",
        "provenance_note": "derived from measured: hourly means, backgrounds and multiples computed from NASA's "
                           "measured MSL RAD and STEREO-B HET records",
        "axis": {"start": to_iso_z(AXIS_START), "stop": to_iso_z(AXIS_STOP),
                 "inside_curiosity_window": cur_lo <= lo and hi <= cur_hi},
        "rad": {
            "server": ISWA_HAPI, "dataset": rad_events.DATASET, "parameter": rad_events.PARAMETER,
            "units": rad_events.EXPECTED_UNITS, "description": rec["description"],
            "background": {"start": iso(bg_lo), "stop": iso(d0), "uGy_per_day": rp["background_uGy_per_day"],
                           "n_samples": n_bg, "max_excursion_pct": round(100.0 * excursion, 1),
                           "basis": f"mean of dose_e_total over the {rad_events.BACKGROUND_DAYS} UTC days before "
                                    f"Table 1's date {TABLE1_DATE}, as ingest/rad_events.py computes it"},
            "threshold_factor": rad_events.THRESHOLD_FACTOR, "threshold_uGy_per_day": rp["threshold_uGy_per_day"],
            "rise_factor": RISE_FACTOR,
            "rise": {"chip": "design choice",
                     "source": {"kind": "design_choice",
                                "rationale": f"First clear rise = first sample above {RISE_FACTOR:g} x the 5-day "
                                             "background: LANDFALL's own threshold, about three times the largest "
                                             f"excursion of the background window ({100.0 * excursion:.1f} %)."}},
            "t0": iso(lo), "t_s": [t - lo for t in T[i0:i1]], "uGy_per_day": E[i0:i1],
            "n_samples": i1 - i0,
            "median_spacing_min": rad_events.median_spacing_min(T, lo, hi),
            "samples_above_threshold": above,
            **m,
        },
        "stereo_b": {
            "server": CDAWEB_HAPI, "dataset": HET_DATASET, "parameter": HET_PARAMETER, "units": het["units"],
            "description": het["param"].get("description"), "resource_url": het["info"].get("resourceURL"),
            "bin_centres_MeV": het["centres"], "dataset_coverage": het["coverage"],
            "request": {"start": to_iso_z(HET_START), "stop": to_iso_z(HET_STOP)},
            "n_rows": len(het["T"]), "n_fill_values": n_fill,
            "first_row": iso(het["T"][0]), "last_row": iso(het["T"][-1]),
            "t0": to_iso_z(HET_START), "hour_s": HOUR_S, "n_hours": n_hours,
            "quiet": {"start": to_iso_z(QUIET_START), "stop": to_iso_z(QUIET_STOP),
                      "statistic": "median of the hourly means"},
            "first_above_factor": FIRST_ABOVE_FACTOR,
            "channels": channels,
            "reduction": {"chip": "design choice",
                          "source": {"kind": "design_choice",
                                     "rationale": "Hourly means of the one-minute rows, the median of 8-9 April's "
                                                  "hourly means as the quiet level, and the first hour above 10 x it: "
                                                  "LANDFALL's own reduction of the measured series."}},
        },
        "noaa": noaa,
        "jpl": {"snapshot": "horizons_mars_comms", "windows": [w for w in jpl if w["id"] in JPL_IDS]},
        "table1": t1,
        "literature": lit,
        "moratoria": {"method": "RAD samples (dose_e_total > 0) in the iSWA record inside each window NASA or "
                                "JPL published (horizons_mars_comms), counted in whole UTC days from the start date "
                                "00:00 to the day after the end date 00:00",
                      "windows": moratoria},
    }

    ch = {c["centre_MeV"]: c for c in channels}
    frag = {f["id"]: f["text"] for f in FRAGMENTS}
    last, after = m["last_before_rise"], m["highest_after_back"]
    by_hand = [w["id"] for w in data["jpl"]["windows"] if not w["quote_verified_this_build"]]
    coverage = {"start": to_iso_z(datetime.fromtimestamp(bg_lo, UTC)), "stop": to_iso_z(HET_STOP), "cadence": None}
    caveats = [
        f"Small at the surface: in iSWA's samples the dose rate peaks at {m['peak']['ratio_to_background']:.3f} x the "
        f"5-day background, below the RAD team's {rad_events.THRESHOLD_FACTOR:g} x trigger, at a median spacing of "
        f"{data['rad']['median_spacing_min']:g} min. Hassler et al. 2014 write that \"{frag['enhancement_30']}\"; the "
        f"RAD team's Table 1 ({t1['paper_ref'].split(',')[0]}) lists {TABLE1_DATE} as triggered with "
        f"{t1['paper']['total_uGy']:.2f} uGy, a row hapi_msl_rad_sep_events does not reproduce.",
        f"Three dates for one event: Table 1 prints '{TABLE1_DATE}', the paper's Fig. 5 caption 'sol 242 ({FIG5_DATE})' "
        f"and its Fig. 1 'sol 242 ({FIG1_DATE})'. In iSWA's samples the dose rate peaks at {m['peak']['t']}.",
        "Different instruments, places and quantities: RAD's dose rate in plastic at Gale crater (uGy/day), STEREO-B "
        f"HET's proton flux per energy bin in interplanetary space ({het['units']}) and NOAA's {noaa['energy']} "
        f"integral flux at Earth ({noaa['unit']}). No absorbed dose is converted to Sv, and no arrival times are compared.",
        "'The same SEP event' is the paper's claim (its Fig. 5 caption), quoted, not LANDFALL's.",
        *([f"JPL's 2013 windows and quotes are read from horizons_mars_comms, which did not re-fetch the JPL page this "
           f"build ({', '.join(by_hand)}: quote read by hand in the raw page HTML)."] if by_hand else []),
        f"STEREO-B HET hourly means are LANDFALL's reduction of {len(het['T'])} one-minute rows; the "
        f"{HET_KEEP_MEV[0]:g} MeV channel reads 0 when quiet, so multiples are given only for "
        f"{MULTIPLE_MEV[0]:g} and {MULTIPLE_MEV[1]:g} MeV ({ch[50.0]['peak']['multiple_of_quiet']:,} x and "
        f"{ch[80.0]['peak']['multiple_of_quiet']:,} x their 8-9 April medians).",
        f"The first clear rise is the first sample above {RISE_FACTOR:g} x the background (a design choice)."
        + (f" The sample before it ({last['t']}, {last['ratio_to_background']:.3f} x) is not taken as the rise: the "
           f"record reaches {after['ratio_to_background']:.3f} x again after the event ({after['t']})."
           if last and after and after["ratio_to_background"] >= last["ratio_to_background"] else ""),
        PDF_GLYPH_CAVEAT,
        "Moratorium counts are samples in iSWA's record inside each published window, not a statement about what "
        "was downlinked when.",
        f"The coverage ({coverage['start'][:10]} to {coverage['stop'][:10]}) is the April 2013 event only; "
        f"data.moratoria also counts RAD samples in all {len(moratoria)} published windows, "
        f"{min(w['start_date'] for w in moratoria)} to {max(w['end_date'] for w in moratoria)}, read from the "
        "iSWA requests listed in source.access_urls.",
    ]
    if lit["pdf_saved_by_hand_on"]:
        caveats.append(f"PDF saved by hand from the URL on {lit['pdf_saved_by_hand_on']} (the host refused this "
                       "build's client); its SHA-256 is pinned and every fragment is re-found in it at build.")
    return make_snapshot(
        id=SNAPSHOT_ID, adapter=ADAPTER_ID,
        title="Sol 242: a solar particle event at Gale crater during the April 2013 Mars solar conjunction "
              "(MSL RAD, STEREO-B HET)",
        source={
            "publisher": "NASA GSFC Space Physics Data Facility (CDAWeb HAPI) and CCMC (iSWA HAPI)",
            "name": f"STEREO-B HET {HET_PARAMETER} (CDAWeb HAPI id '{HET_DATASET}') and MSL RAD "
                    f"{rad_events.PARAMETER} (iSWA HAPI id '{rad_events.DATASET}'), April 2013, with "
                    "Hassler et al. 2014 (Science)",
            "url": het["info"].get("resourceURL") or f"{CDAWEB_HAPI}/info?id={HET_DATASET}",
            "access_urls": [het["info_url"], het["data_url"], rec["info_url"], *rad_urls, PDF_URL],
            "license": "No license or data-use terms stated in either HAPI /info response (checked 2026-11-15). "
                       "The paper is quoted in short attributed fragments; its figures are not reproduced.",
            "citation": f"NASA GSFC Space Physics Data Facility, CDAWeb HAPI dataset '{HET_DATASET}' "
                        f"(STEREO-B HET), parameter {HET_PARAMETER}, {to_iso_z(HET_START)} to "
                        f"{to_iso_z(HET_STOP)}, HAPI server {CDAWEB_HAPI}; NASA GSFC CCMC iSWA HAPI dataset "
                        f"'{rad_events.DATASET}', parameter {rad_events.PARAMETER}; retrieved {ctx.retrieved_at}. "
                        f"Event and quotations: {PAPER_CITATION}.",
        },
        retrieved_at=ctx.retrieved_at,
        coverage=coverage,
        freshness={"kind": "historical", "stale_after": None},
        provenance="derived", caveats=caveats, data=data)


def run(ctx: RunContext) -> list[dict]:
    return [build(ctx)]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ingest.sep_conjunction")
    ap.add_argument("--seed-pdf", type=Path, required=True, help="a copy of the PDF saved by hand from PDF_URL")
    ap.add_argument("--saved-on", default=None, help="UTC date the copy was saved (default: today)")
    args = ap.parse_args(argv)
    print(seed_pdf(args.seed_pdf, saved_on=args.saved_on))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
