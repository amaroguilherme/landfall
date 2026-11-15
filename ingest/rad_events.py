"""`rad_events` adapter: the RAD team's published SEP nowcast rule, replayed on Curiosity's whole
public dose record and compared row by row with the paper's Table 1.

    uv run python -m ingest rad_events             # online once: ~183 iSWA requests, ~4 min
    uv run python -m ingest rad_events --offline   # replays .cache/ingest/rad_events/ exactly

Snapshot hapi_msl_rad_sep_events, provenance "derived": arithmetic on a measured series.

Sources (each fetched here, or read from a snapshot this build already ships):
  * NASA GSFC CCMC iSWA HAPI dataset 'msl_rad_dosimetry', parameter dose_e_total, described by
    the server as "Radiation dose rate in tissue-equivalent plastic detector E", in uGy/day.
  * Loewe et al. 2025, Space Weather 23, e2025SW004372 (doi:10.1029/2025SW004372). Every rule
    sentence and all 16 Martian-surface rows of Table 1 are quote-checked in the arXiv:2502.02469v1
    HTML at build; the journal metadata is checked at Crossref. The journal text was not compared.
  * JPL Horizons one-way light time: the calibration query ingest/horizons.py already cached, read
    with offline=True only (never re-fetched by this adapter).
  * DONKI SEP entries as shipped in web/public/data/swpc_sep_events.json (2024-01-01 onward).

Cache isolation. hapi.py's 90-day MSL window, and with it the scenario's quiet rate, sim_crew and
the conformance vectors, is keyed on the shared cached iSWA /info?id=msl_rad_dosimetry. Every
iSWA request here runs on a sub-context whose cache is .cache/ingest/rad_events/, so an online run
of this adapter can never refresh hapi.py's entry.

The record window is pinned (RECORD_START, RECORD_STOP), never derived from the clock or from the
dataset's stopDate, so the replay cannot drift between builds. iSWA answers a window without data
with HAPI 1406, which the HAPI client raises and does not cache; the windows seen empty on the first
online run are frozen in KNOWN_EMPTY, so --offline never requests them and an online run fails if
the set changes. The rule is applied in stdlib Python; nothing here is wired into the engine, the
rules, the scenario or the conformance vectors.
"""

from __future__ import annotations

import bisect
import html as html_lib
import json
import math
import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from ingest._hapi_client import HapiClient, HapiError, build_url, fmt_hapi_time, hapi_time_to_iso
from ingest._horizons_core import html_to_text, normalise_text, parse_horizons_time, quote_in_page
from ingest.common import RunContext, make_snapshot, sha256_hex, to_iso_z
from ingest.hapi import ISWA_HAPI, ISWA_MAX_SPAN
from ingest.horizons import CALIBRATION_SPAN, MARS, access_url, fetch_table, horizons_params

ADAPTER_ID = "rad_events"
DEPENDS_ON = ["swpc", "horizons"]
SNAPSHOT_ID = "hapi_msl_rad_sep_events"

UTC = timezone.utc
DAY_S = 86_400

# ---- the measured record -----------------------------------------------------------------------
DATASET = "msl_rad_dosimetry"
PARAMETER = "dose_e_total"
EXPECTED_UNITS = "uGy/day"
EXPECTED_DESCRIPTION = "Radiation dose rate in tissue-equivalent plastic detector E"
CACHE_SUBDIR = "rad_events"
RECORD_START = datetime(2012, 8, 17, tzinfo=UTC)
RECORD_STOP = datetime(2026, 11, 13, tzinfo=UTC)
# Pre-record probe: from the dataset's /info startDate (2011-11-20T18:29:59Z), floored to the day,
# up to RECORD_START. Every window must come back empty: that is the evidence that nothing
# precedes the first sample (the series holds no cruise data).
PROBE_START = datetime(2011, 11, 20, tzinfo=UTC)
# Windows (time.min) that iSWA answered with HAPI 1406 on the first online run (2026-11-14): the 10
# pre-record probe windows, then six windows inside the record (iSWA serves 24 samples on 17-18 August
# 2012 and nothing more until March 2013).
KNOWN_EMPTY: tuple[str, ...] = (
    "2011-11-20T00:00:00Z", "2011-12-20T00:00:00Z", "2012-01-19T00:00:00Z", "2012-02-18T00:00:00Z",
    "2012-03-19T00:00:00Z", "2012-04-18T00:00:00Z", "2012-05-18T00:00:00Z", "2012-06-17T00:00:00Z",
    "2012-07-17T00:00:00Z", "2012-08-16T00:00:00Z",
    "2012-09-16T00:00:00Z", "2012-10-16T00:00:00Z", "2012-11-15T00:00:00Z", "2012-12-15T00:00:00Z",
    "2013-01-14T00:00:00Z", "2013-02-13T00:00:00Z",
)

# ---- the rule (Loewe et al. 2025; quotes below) ------------------------------------------------
THRESHOLD_FACTOR = 1.25          # "a threshold of 1.25 times the background dose rate"
BACKGROUND_DAYS = 5              # "over the five days preceding the SEP event"
LEAD_FRACTION = 0.10             # lead time: onset until 10% of the total SEP dose has accumulated
SEARCH_S = 2 * DAY_S             # mode (a): onset searched within 2 days of 00:00 UTC on the date
# Mode (b), the whole-record scan: LANDFALL's own parameters (design choices, labelled as such).
SCAN_MIN_BACKGROUND_SAMPLES = 100
SCAN_MAX_PAIR_GAP_S = 3 * 3600
# What "reproduces" means in the comparison table (design choice; stated next to the table).
REPRODUCE_DOSE_TOL = 0.15
REPRODUCE_TTP_TOL_MIN = 40.0
# DONKI entries listed beside a trigger: those logged within this span of its onset (design choice).
DONKI_NEIGHBOUR_S = 2 * DAY_S
# Native samples shipped for the 20 May 2024 timeline.
MAY_2024_WINDOW = (datetime(2024, 5, 19, tzinfo=UTC), datetime(2024, 5, 22, 12, tzinfo=UTC))
MAY_2024_DATE = "2024-05-20"

# ---- the literature ------------------------------------------------------------------------------
ARXIV_ID = "2502.02469v1"
ARXIV_HTML = "https://arxiv.org/html/2502.02469v1"
ARXIV_ABS = "https://arxiv.org/abs/2502.02469v1"
DOI = "10.1029/2025SW004372"
DOI_URL = "https://doi.org/10.1029/2025SW004372"
CROSSREF_URL = "https://api.crossref.org/works/10.1029/2025SW004372"
PAPER_TITLE = "Nowcasting Solar Energetic Particle Events for Mars Missions"
_MIN_PAGE_CHARS = 50_000          # the arXiv HTML is ~337 kB; a short body is an error stub

# Verbatim sentences (after whitespace and quote-mark normalisation), re-found in the page on
# every build. "rule" marks the ones the page prints in its rule expander.
PAPER_QUOTES: list[dict] = [
    {"id": "background", "rule": True,
     "text": "We apply a constant linear fit to the dose rate E measured in 15-minute cadences over "
             "the five days preceding the SEP event."},
    {"id": "trigger", "rule": True,
     "text": "An SEP event is considered triggered when the dose rate exceeds the background level "
             "by more than 25%, corresponding to a threshold of 1.25 times the background dose rate."},
    {"id": "confirmation", "rule": True,
     "text": "A consecutive measurement is then used as a cross-check to verify or falsify the SEP "
             "event."},
    {"id": "case_2", "rule": False,
     "text": "In the second case, two consecutive measurements must exceed the threshold."},
    {"id": "official_alert", "rule": False,
     "text": "the astronaut will receive an official alert"},
    {"id": "end", "rule": True,
     "text": "The end of an SEP event is defined when the dose rate E drops below the 25% trigger "
             "threshold."},
    {"id": "shelter_duration", "rule": False,
     "text": "Therefore, the 'shelter duration' is the time calculated from onset to end of the SEP "
             "event."},
    {"id": "total_dose", "rule": False,
     "text": "For this time period, we calculate the background-removed accumulated SEP dose, "
             "referred to as the 'total SEP dose' (see Figure 3, right)."},
    {"id": "time_to_peak", "rule": False,
     "text": "The shelter duration is the time from onset to end of the SEP event, and the time to "
             "peak is the time from onset to the maximum of dose rate E."},
    {"id": "lead_time", "rule": True,
     "text": "The lead time is defined as the period in which an astronaut can avoid at least 90% of "
             "the total SEP dose (time region marked in red) and would receive only 10% of the total "
             "SEP dose (time region marked in orange)."},
    {"id": "shelter_30_min", "rule": True,
     "text": "Our study suggests that, using our nowcasting system, an astronaut should not move more "
             "than 30 minutes away from a shelter in order to still avoid not only more than 90% of "
             "the total SEP dose but also the peak dose rate in the case of an SEP event."},
    {"id": "not_triggered", "rule": False,
     "text": "Four SEP events on the surface of Mars do not exceed the 25% trigger threshold and "
             "therefore cannot be identified using our methodology."},
    {"id": "record_end", "rule": False,
     "text": "on the Martian surface from landing on August 6, 2012, to September 9, 2024"},
    {"id": "product", "rule": False,
     "text": "Alongside the 15-minute dose rate data products, RAD also provides high-resolution dose rate "
             "measurements as one-minute data products."},
    {"id": "archive", "rule": False,
     "text": "The data used in this study are archived in the NASA Planetary Data System's Planetary Plasma "
             "Interactions Node at the University of California, Los Angeles."},
]
# Table 1, MARTIAN SURFACE, verbatim and in the page's order (a date alone = no values printed).
PAPER_TABLE1_SURFACE: list[str] = [
    "2013-04-10 00d 05h:33m 00d 01h:28m 00d 01h:28m 9.22",
    "2013-10-10 00d 11h:15m 00d 02h:07m 00d 01h:07m 32.32",
    "2014-01-05",
    "2014-09-02 01d 14h:17m 00d 09h:01m 00d 02h:47m 125.93",
    "2014-09-10 00d 01h:41m 00d 01h:02m 00d 00h:02m 2.09",
    "2017-09-10 01d 08h:01m 00d 06h:49m 00d 03h:44m 261.79",
    "2021-10-28 00d 17h:47m 00d 05h:12m 00d 02h:01m 161.44",
    "2022-02-15 00d 20h:31m 00d 03h:55m 00d 01h:50m 323.75",
    "2022-03-14",
    "2023-03-12 00d 01h:23m 00d 01h:08m 00d 00h:05m 1.22",
    "2024-05-20 01d 17h:55m 00d 00h:53m 00d 00h:57m 1730.55",
    "2024-07-22 00d 13h:16m 00d 02h:16m 00d 01h:20m 57.98",
    "2024-07-26",
    "2024-08-04",
    "2024-09-02 00d 01h:25m 00d 00h:34m 00d 00h:08m 2.89",
    "2024-09-05 00d 08h:35m 00d 00h:33m 00d 00h:33m 25.52",
]
_TABLE_BLOCK_START = "MARTIAN SURFACE"
_TABLE_BLOCK_END = "Four SEP events on the surface of Mars"
# The appendix threshold study (Table 4) has its own MARTIAN SURFACE block, ended by "Open Research".
_TABLE4_START = "Table 4:"
_TABLE4_END = "Open Research"
_ROW_RE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})"
    r"(?: (?P<sd>\d{2})d (?P<sh>\d{2})h:(?P<sm>\d{2})m"
    r" (?P<pd>\d{2})d (?P<ph>\d{2})h:(?P<pm>\d{2})m"
    r" (?P<ld>\d{2})d (?P<lh>\d{2})h:(?P<lm>\d{2})m"
    r" (?P<dose>\d+\.\d+))?$")
_MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August", "September",
     "October", "November", "December"], start=1)}

LIGHT_TIME_LABEL = "lower bound: light time only, 00:00 UTC that day"
ABSORBED_DOSE_CAVEAT = "Absorbed dose in plastic: never converted to Sv, never compared with Table 4.8-1."


# ================================================================================================
# Pure helpers (known-answer tests in ingest/tests/test_rad_events.py)
# ================================================================================================
def iso(t: int) -> str:
    """POSIX seconds -> 'YYYY-MM-DDTHH:MM:SSZ'."""
    return to_iso_z(datetime.fromtimestamp(t, UTC))


def epoch(s: str) -> int:
    """'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ' -> POSIX seconds (UTC)."""
    if len(s) == 10:
        s += "T00:00:00Z"
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def windows(start: datetime, stop: datetime, span: timedelta = ISWA_MAX_SPAN) -> list[tuple[datetime, datetime]]:
    """Consecutive [a, b) request windows of at most `span` covering [start, stop)."""
    out, t = [], start
    while t < stop:
        u = min(t + span, stop)
        out.append((t, u))
        t = u
    return out


def parse_paper_row(row: str) -> dict:
    """One verbatim Table 1 row -> {date, triggered, durations in minutes, total dose}."""
    m = _ROW_RE.match(normalise_text(row))
    if not m:
        raise ValueError(f"not a Table 1 row: {row!r}")
    if m["dose"] is None:
        return {"date": m["date"], "triggered": False}

    def mins(d: str, h: str, mi: str) -> int:
        return int(d) * 1440 + int(h) * 60 + int(mi)

    return {"date": m["date"], "triggered": True,
            "shelter_min": mins(m["sd"], m["sh"], m["sm"]),
            "time_to_peak_min": mins(m["pd"], m["ph"], m["pm"]),
            "lead_time_min": mins(m["ld"], m["lh"], m["lm"]),
            "total_uGy": float(m["dose"])}


def fmt_dhm(minutes: float) -> str:
    """Minutes -> the paper's own duration format, '01d 17h:55m' (rounded to the minute)."""
    total = int(math.floor(minutes + 0.5))
    d, r = divmod(total, 1440)
    h, mi = divmod(r, 60)
    return f"{d:02d}d {h:02d}h:{mi:02d}m"


def mean_between(T: list[int], E: list[float], lo: int, hi: int) -> tuple[float | None, int]:
    """Arithmetic mean of the samples with lo <= t < hi, and their count."""
    i0, i1 = bisect.bisect_left(T, lo), bisect.bisect_left(T, hi)
    if i1 <= i0:
        return None, 0
    return math.fsum(E[i0:i1]) / (i1 - i0), i1 - i0


def event_metrics(T: list[int], E: list[float], on: int, end: int, bg: float) -> dict:
    """The paper's per-event quantities for onset index `on` and end index `end` (the first sample
    below the threshold). Total SEP dose = trapezoid of (E - background) from onset to end, in uGy
    (uGy/day x days); time to peak and lead time are measured from the onset sample."""
    if not 0 <= on < end < len(T):
        raise ValueError(f"bad event indices {on}..{end}")
    thr = THRESHOLD_FACTOR * bg
    pk = on
    for k in range(on, end + 1):
        if E[k] > E[pk]:
            pk = k
    cum = [0.0]
    max_gap = 0
    for a in range(on, end):
        b = a + 1
        dt = T[b] - T[a]
        max_gap = max(max_gap, dt)
        cum.append(cum[-1] + 0.5 * ((E[a] - bg) + (E[b] - bg)) * (dt / DAY_S))
    total = cum[-1]
    lead_idx = next((on + i for i, c in enumerate(cum) if c >= LEAD_FRACTION * total), None) if total > 0 else None
    conf = on + 1

    def after(i: int) -> float:
        return round((T[i] - T[on]) / 60.0, 2)

    return {
        "onset": iso(T[on]),
        "confirmation": {"t": iso(T[conf]), "after_onset_min": after(conf), "above_threshold": E[conf] > thr},
        "peak": {"t": iso(T[pk]), "uGy_per_day": E[pk], "after_onset_min": after(pk),
                 "ratio_to_background": round(E[pk] / bg, 3)},
        "end": iso(T[end]),
        "shelter_min": after(end),
        "time_to_peak_min": after(pk),
        "lead_time_min": after(lead_idx) if lead_idx is not None else None,
        "total_uGy": round(total, 2),
        "n_samples": end - on + 1,
        "max_gap_min": round(max_gap / 60.0, 1),
    }


def samples_per_day(T: list[int], first_day: int, n_days: int) -> dict[str, int]:
    out = {}
    for k in range(n_days):
        lo = (first_day + k) * DAY_S
        out[iso(lo)[:10]] = bisect.bisect_left(T, lo + DAY_S) - bisect.bisect_left(T, lo)
    return out


def long_gaps(T: list[int], min_s: int = 2 * DAY_S) -> list[dict]:
    """Every gap between consecutive samples longer than min_s: a storm inside one cannot be seen."""
    return [{"from": iso(a), "to": iso(b), "days": round((b - a) / DAY_S, 2)}
            for a, b in zip(T, T[1:]) if b - a > min_s]


def median_spacing_min(T: list[int], lo: int, hi: int) -> float | None:
    i0, i1 = bisect.bisect_left(T, lo), bisect.bisect_left(T, hi)
    gaps = sorted(T[k + 1] - T[k] for k in range(i0, i1 - 1))
    if not gaps:
        return None
    mid = len(gaps) // 2
    g = gaps[mid] if len(gaps) % 2 else 0.5 * (gaps[mid - 1] + gaps[mid])
    return round(g / 60.0, 1)


def replay_date(T: list[int], E: list[float], day: str) -> dict:
    """Mode (a): the rule anchored on one listed date. Background = mean of E over the 5 UTC days
    before that day; onset = first sample above 1.25 x background within 2 days of 00:00 UTC on it;
    end = first later sample below the threshold."""
    d0 = epoch(day)
    bg, n_bg = mean_between(T, E, d0 - BACKGROUND_DAYS * DAY_S, d0)
    if bg is None:
        raise ValueError(f"no background samples before {day}")
    thr = THRESHOLD_FACTOR * bg
    out = {"background_uGy_per_day": round(bg, 2), "threshold_uGy_per_day": round(thr, 2),
           "background_n_samples": n_bg}
    i1, jend = bisect.bisect_left(T, d0), bisect.bisect_left(T, d0 + SEARCH_S)
    j = i1
    while j < jend and E[j] <= thr:
        j += 1
    if j >= jend:
        pk = max(range(i1, jend), key=E.__getitem__) if jend > i1 else None
        out.update({"triggered": False,
                    "max_ratio_to_background": round(E[pk] / bg, 3) if pk is not None else None,
                    "max_at": iso(T[pk]) if pk is not None else None,
                    "search_window_samples": jend - i1,
                    "samples_per_day": samples_per_day(T, d0 // DAY_S - 1, 4),
                    "median_spacing_min": median_spacing_min(T, d0 - BACKGROUND_DAYS * DAY_S, d0 + SEARCH_S)})
        return out
    k = j
    while k < len(E) and E[k] >= thr:
        k += 1
    if k >= len(E):
        raise ValueError(f"event of {day} still running at the end of the record")
    out.update({"triggered": True, **event_metrics(T, E, j, k, bg),
                "onset_after_listed_date_h": round((T[j] - d0) / 3600.0, 2)})
    return out


def scan_record(T: list[int], E: list[float]) -> list[tuple[int, int, float, int]]:
    """Mode (b): the rule run over the whole record as an onboard system would run it. The background
    is refit each UTC day from the 5 UTC days before it (at least SCAN_MIN_BACKGROUND_SAMPLES samples)
    and frozen during an event; a trigger needs two consecutive samples above 1.25 x background less
    than SCAN_MAX_PAIR_GAP_S apart; the event ends at the first sample below the threshold.
    Returns (onset index, end index, background, background sample count) per trigger."""
    by_day: dict[int, list[float]] = defaultdict(list)
    for t, e in zip(T, E):
        by_day[t // DAY_S].append(e)
    cache: dict[int, tuple[float | None, int]] = {}

    def background(day: int) -> tuple[float | None, int]:
        if day not in cache:
            vals: list[float] = []
            for k in range(1, BACKGROUND_DAYS + 1):
                vals.extend(by_day.get(day - k, ()))
            n = len(vals)
            cache[day] = (math.fsum(vals) / n if n >= SCAN_MIN_BACKGROUND_SAMPLES else None, n)
        return cache[day]

    events, i, n = [], 0, len(T)
    while i < n - 1:
        bg, n_bg = background(T[i] // DAY_S)
        if bg is None:
            i += 1
            continue
        thr = THRESHOLD_FACTOR * bg
        if E[i] > thr and E[i + 1] > thr and T[i + 1] - T[i] < SCAN_MAX_PAIR_GAP_S:
            j = i
            while j < n and E[j] >= thr:
                j += 1
            if j >= n:
                raise ValueError(f"trigger at {iso(T[i])} still running at the end of the record")
            events.append((i, j, bg, n_bg))
            i = max(j, i + 2)
        else:
            i += 1
    return events


def compare(paper: dict, replay: dict) -> dict:
    """Row status and the deviations, replay minus paper."""
    if not paper["triggered"]:
        return {"status": "replay_triggered_paper_not" if replay["triggered"] else "agrees_not_triggered"}
    if not replay["triggered"]:
        return {"status": "not_reproduced"}
    dose_pct = (replay["total_uGy"] - paper["total_uGy"]) / paper["total_uGy"] * 100.0
    ttp = replay["time_to_peak_min"] - paper["time_to_peak_min"]
    ok = abs(dose_pct) <= REPRODUCE_DOSE_TOL * 100.0 and abs(ttp) <= REPRODUCE_TTP_TOL_MIN
    lead = replay["lead_time_min"]
    return {"status": "reproduced" if ok else "deviates",
            "total_pct": round(dose_pct, 1),
            "time_to_peak_diff_min": round(ttp, 1),
            "shelter_diff_min": round(replay["shelter_min"] - paper["shelter_min"], 1),
            "lead_time_diff_min": round(lead - paper["lead_time_min"], 1) if lead is not None else None}


def paper_record_end(quote: str) -> date:
    """'... to September 9, 2024' -> date(2024, 9, 9): the end of the paper's surface record."""
    m = re.search(r"to (\w+) (\d{1,2}), (\d{4})$", normalise_text(quote))
    if not m or m[1] not in _MONTHS:
        raise ValueError(f"no end date in {quote!r}")
    return date(int(m[3]), _MONTHS[m[1]], int(m[2]))


def table_block(page_text: str) -> str:
    """The normalised text between 'MARTIAN SURFACE' and the paragraph after Table 1."""
    i = page_text.find(_TABLE_BLOCK_START)
    j = page_text.find(_TABLE_BLOCK_END, i + 1)
    if i < 0 or j < 0:
        raise ValueError("Table 1 Martian-surface block not found in the page")
    return page_text[i + len(_TABLE_BLOCK_START):j].strip()


def table4_surface_dates(page_text: str) -> list[str]:
    """Dates printed in the Martian-surface block of the appendix's Table 4, in page order."""
    i = page_text.find(_TABLE4_START)
    j = page_text.find(_TABLE_BLOCK_START, i + 1) if i >= 0 else -1
    k = page_text.find(_TABLE4_END, j + 1) if j >= 0 else -1
    if min(i, j, k) < 0:
        raise ValueError("appendix Table 4 Martian-surface block not found in the page")
    return re.findall(r"\b\d{4}-\d{2}-\d{2}\b", page_text[j:k])


def short_author(full_name: str) -> str:
    """'Jan Leo Löwe' -> 'Löwe JL' (family name, then initials), from the page's own spelling."""
    words = full_name.split()
    if not words:
        return full_name
    return f"{words[-1]} {''.join(w[0] for w in words[:-1] if w[0].isalpha())}".strip()


def page_authors(raw_html: str) -> list[str]:
    """Author names as the arXiv HTML prints them (LaTeXML ltx_personname spans), in page order."""
    names = [normalise_text(html_lib.unescape(m.group(1)))
             for m in re.finditer(r'<span class="ltx_personname">(.*?)</span>', raw_html, re.S)]
    return [n for n in names if n]


# ================================================================================================
# Fetching (all iSWA and literature requests on the isolated sub-context)
# ================================================================================================
def sub_context(ctx: RunContext) -> RunContext:
    return RunContext(offline=ctx.offline, cache_dir=ctx.cache_dir / CACHE_SUBDIR, out_dir=ctx.out_dir,
                      retrieved_at=ctx.retrieved_at, timeout=ctx.timeout)


def _data_query(a: datetime, b: datetime) -> dict:
    return {"id": DATASET, "time.min": fmt_hapi_time(a), "time.max": fmt_hapi_time(b),
            "parameters": PARAMETER, "format": "csv"}


def fetch_record(sub: RunContext, *, strict: bool = True) -> dict:
    """The pinned record (pre-record probe + 30-day windows), E > 0 kept, sorted, deduplicated."""
    client = HapiClient(sub, ISWA_HAPI)
    info = client.info(DATASET)
    params = HapiClient.params_for(info, [PARAMETER])
    p = params[1]
    if p.units != EXPECTED_UNITS or p.description != EXPECTED_DESCRIPTION:
        raise RuntimeError(f"{PARAMETER} /info changed: units {p.units!r}, description {p.description!r}")
    if hapi_time_to_iso(info["startDate"]) < to_iso_z(PROBE_START):
        raise RuntimeError(f"dataset startDate {info['startDate']} precedes the pre-record probe")
    probe, record = windows(PROBE_START, RECORD_START), windows(RECORD_START, RECORD_STOP)
    urls, empty, rows = [], [], []
    for a, b in probe + record:
        key = fmt_hapi_time(a)
        urls.append(build_url(ISWA_HAPI, "data", _data_query(a, b)))
        if sub.offline and key in KNOWN_EMPTY:
            empty.append(key)
            continue
        try:
            _, chunk = client.data(DATASET, info, a, b, [PARAMETER])
        except HapiError as exc:
            if exc.code != 1406:
                raise
            empty.append(key)
            continue
        rows.extend(chunk)
    probe_keys = [fmt_hapi_time(a) for a, _ in probe]
    if strict:
        if sorted(empty) != sorted(KNOWN_EMPTY):
            raise RuntimeError(f"iSWA empty windows changed: seen {sorted(empty)}, frozen "
                               f"{sorted(KNOWN_EMPTY)}; check them, then update KNOWN_EMPTY")
        if not set(probe_keys) <= set(empty):
            raise RuntimeError("a pre-record window returned data: the record does not start at "
                               "the first sample this adapter reports")
    seen: dict[int, float | None] = {}
    for t_iso, e in rows:
        seen.setdefault(epoch(t_iso), e)
    keep = sorted((t, e) for t, e in seen.items() if e is not None and e > 0)
    return {
        "info": info, "info_url": build_url(ISWA_HAPI, "info", {"id": DATASET}), "data_urls": urls,
        "description": p.description,
        "n_windows": len(record), "probe_keys": probe_keys, "empty": sorted(empty),
        "n_rows": len(seen), "n_dropped": len(seen) - len(keep),
        "T": [t for t, _ in keep], "E": [e for _, e in keep],
    }


def verify_literature(sub: RunContext) -> dict:
    """Re-fetch the arXiv HTML and fail unless every quote and every Table 1 row is in it."""
    raw = sub.fetch_text(ARXIV_HTML)
    if len(raw) < _MIN_PAGE_CHARS:
        raise RuntimeError(f"arXiv HTML only {len(raw)} chars: not the paper")
    text = html_to_text(raw)
    missing = [q["id"] for q in PAPER_QUOTES if not quote_in_page(q["text"], raw)]
    missing += [r for r in PAPER_TABLE1_SURFACE if not quote_in_page(r, raw)]
    if PAPER_TITLE not in text:
        missing.append("title")
    block = table_block(text)
    if block != normalise_text(" ".join(PAPER_TABLE1_SURFACE)):
        missing.append(f"Table 1 surface block (page has: {block[:200]!r})")
    if missing:
        raise RuntimeError(f"arXiv:{ARXIV_ID}: not found in {ARXIV_HTML}: {missing}; re-read the page")
    t1_dates = [r[:10] for r in PAPER_TABLE1_SURFACE]
    t4_dates = table4_surface_dates(text)
    authors = page_authors(raw)
    if len(authors) < 2:
        raise RuntimeError("author list not found in the arXiv HTML")
    cr = json.loads(sub.fetch_text(CROSSREF_URL)).get("message", {})
    got = {"title": (cr.get("title") or [None])[0], "journal": (cr.get("container-title") or [None])[0],
           "volume": cr.get("volume"), "issue": cr.get("issue"), "article_number": cr.get("article-number"),
           "doi": (cr.get("DOI") or "").upper(), "publisher": cr.get("publisher"),
           "published": "-".join(f"{x:02d}" for x in (cr.get("published") or {}).get("date-parts", [[]])[0]),
           "authors": [" ".join(x for x in (a.get("given"), a.get("family")) if x) for a in cr.get("author", [])]}
    want = {"title": PAPER_TITLE, "journal": "Space Weather", "volume": "23", "article_number": "e2025SW004372",
            "doi": DOI.upper()}
    bad = {k: got[k] for k, v in want.items() if got[k] != v}
    if bad:
        raise RuntimeError(f"Crossref record of {DOI} differs from the citation: {bad}")
    return {
        "title": PAPER_TITLE, "authors": authors, "arxiv_id": ARXIV_ID, "arxiv_html": ARXIV_HTML,
        "arxiv_abs": ARXIV_ABS, "page_sha256": sha256_hex(raw.encode("utf-8")), "page_chars": len(raw),
        "doi": DOI, "doi_url": DOI_URL,
        "journal": {**{k: got[k] for k in ("journal", "volume", "issue", "article_number", "publisher", "published")},
                    "authors_crossref": got["authors"], "checked_at": CROSSREF_URL},
        "numbers_from": f"arXiv:{ARXIV_ID} Table 1 (Martian surface); the journal version was not compared",
        "quotes": [dict(q) for q in PAPER_QUOTES],
        "quotes_verified_this_build": True,
        "table1_surface_rows": list(PAPER_TABLE1_SURFACE),
        "table1_block_verified": True,
        "table4_surface_dates": t4_dates,
        "table4_only_dates": [d for d in t4_dates if d not in t1_dates],
        "table1_only_dates": [d for d in t1_dates if d not in t4_dates],
        "quote_check": "every quote and every Table 1 row is re-found in the page text after whitespace "
                       "and quote-mark normalisation; the 16 rows are also found as one contiguous block, "
                       "so a date printed without values has none",
    }


def light_times(ctx: RunContext) -> dict[str, dict]:
    """Daily one-way light time (Horizons 1-way_down_LT, minutes as printed), read from the query
    ingest/horizons.py cached, through an offline context: this adapter never fetches it."""
    h = RunContext(offline=True, cache_dir=ctx.cache_dir, out_dir=ctx.out_dir, retrieved_at=ctx.retrieved_at)
    params = horizons_params(MARS, *CALIBRATION_SPAN, "20,21,23")
    table, _sig = fetch_table(h, params)
    i_t, i_lt = table.date_col(), table.col("1-way_down_LT")
    out = {}
    for rec in table.records:
        d = parse_horizons_time(rec[i_t]).date().isoformat()
        out[d] = {"one_way_min": float(rec[i_lt]), "printed": rec[i_lt].strip()}
    out["_url"] = {"url": access_url(params)}
    return out


def light_time_for(lt: dict[str, dict], onset: str) -> dict:
    day = onset[:10]
    hit = lt.get(day)
    if hit is None:
        return {"one_way_min": None, "note": f"outside the cached Horizons span "
                f"{CALIBRATION_SPAN[0]}..{CALIBRATION_SPAN[1]}"}
    return {"one_way_min": hit["one_way_min"]}


def load_donki(ctx: RunContext) -> dict:
    snap = json.loads((ctx.out_dir / "swpc_sep_events.json").read_text())
    evs = sorted(snap["data"]["events"], key=lambda e: e["event_time"])
    return {"start": snap["coverage"]["start"], "stop": snap["coverage"]["stop"],
            "retrieved_at": snap["retrieved_at"], "events": evs}


def donki_for(donki: dict, onset: str) -> dict:
    if not donki["start"] <= onset <= donki["stop"]:
        return {"in_window": False, "note": "outside the shipped DONKI window"}
    t0 = epoch(onset)
    lo, hi = iso(t0 - DONKI_NEIGHBOUR_S), iso(t0 + DONKI_NEIGHBOUR_S)

    near = [e for e in donki["events"] if lo <= e["event_time"] <= hi]
    observed = [e for e in near if not is_model_entry(e)]
    before = [e for e in donki["events"] if e["event_time"] < onset]
    after = [e for e in donki["events"] if e["event_time"] > onset]
    return {"in_window": True,
            "observed": [{"t": e["event_time"], "instruments": e["instruments"]} for e in observed],
            "n_model_entries": len(near) - len(observed),
            "last_before_onset": before[-1]["event_time"] if before else None,
            "first_after_onset": after[0]["event_time"] if after else None}


def is_model_entry(e: dict) -> bool:
    """DONKI marks a forecast-model entry with an instrument that starts 'MODEL:'."""
    return bool(e["instruments"]) and all(i.strip().upper().startswith("MODEL") for i in e["instruments"])


# ================================================================================================
# Snapshot
# ================================================================================================
def build(ctx: RunContext) -> dict:
    sub = sub_context(ctx)
    rec = fetch_record(sub)
    T, E = rec["T"], rec["E"]
    if not T:
        raise RuntimeError("no MSL RAD samples in the pinned record")
    lit = verify_literature(sub)
    first_author = short_author(lit["authors"][0])
    quote_text = {q["id"]: q["text"] for q in PAPER_QUOTES}
    record_end = paper_record_end(quote_text["record_end"])
    lt = light_times(ctx)
    donki = load_donki(ctx)

    # ---- mode (a): the 16 Table 1 surface dates -------------------------------------------------
    table = []
    for row in PAPER_TABLE1_SURFACE:
        paper = parse_paper_row(row)
        day = paper.pop("date")
        replay = replay_date(T, E, day)
        if replay["triggered"]:
            replay["light_time"] = light_time_for(lt, replay["onset"])
        table.append({"paper_date": day, "paper_row": row, "paper": paper, "replay": replay,
                      "comparison": compare(paper, replay), "scan_trigger": None})

    # ---- mode (b): the whole record ------------------------------------------------------------
    triggers = []
    for n, (on, end, bg, n_bg) in enumerate(scan_record(T, E)):
        m = event_metrics(T, E, on, end, bg)
        match = next((r for r in table if r["replay"]["triggered"]
                      and epoch(r["replay"]["onset"]) <= T[end] and T[on] <= epoch(r["replay"]["end"])), None)
        if match is not None:
            flag = "in_paper_table"
            if match["scan_trigger"] is None:
                match["scan_trigger"] = n
        elif datetime.fromtimestamp(T[on], UTC).date() > record_end:
            flag = "after_paper_table"
        else:
            flag = "not_in_paper_table"
        triggers.append({"n": n, "flag": flag, "paper_date": match["paper_date"] if match else None,
                         "background_uGy_per_day": round(bg, 2), "background_n_samples": n_bg,
                         "threshold_uGy_per_day": round(THRESHOLD_FACTOR * bg, 2), **m,
                         "light_time": light_time_for(lt, m["onset"]), "donki": donki_for(donki, m["onset"])})
    ratios = [t["peak"]["ratio_to_background"] for t in triggers]

    # ---- 20 May 2024: native samples for the timeline ------------------------------------------
    may = next(r for r in table if r["paper_date"] == MAY_2024_DATE)
    w0, w1 = (int(x.timestamp()) for x in MAY_2024_WINDOW)
    i0, i1 = bisect.bisect_left(T, w0), bisect.bisect_left(T, w1)
    may_d = triggers[may["scan_trigger"]]["donki"] if may["scan_trigger"] is not None else donki_for(donki, may["replay"]["onset"])
    instruments = sorted({i.split(":")[0].strip() for e in donki["events"] for i in e["instruments"]})

    status_of = {r["paper_date"]: r["comparison"]["status"] for r in table}
    counts: dict[str, int] = defaultdict(int)
    for s in status_of.values():
        counts[s] += 1

    data = {
        "explainer": f"The SEP nowcast rule the MSL RAD team published ({first_author.split()[0]} et al. 2025), run "
                     "on the whole public record of Curiosity's dose rate on the surface of Mars and compared "
                     "row by row with the paper's own Table 1. A replay of a measured record: nothing "
                     "here feeds LANDFALL's engine, rules or scenario.",
        "provenance_note": "derived from measured: rule arithmetic on NASA's measured MSL RAD series",
        "dataset": {"server": ISWA_HAPI, "id": DATASET, "parameter": PARAMETER,
                    "description": rec["description"], "units": EXPECTED_UNITS, "title": rec["info"].get("title"),
                    "info_startDate": hapi_time_to_iso(rec["info"]["startDate"]),
                    "info_stopDate": hapi_time_to_iso(rec["info"]["stopDate"])},
        "record": {
            "pinned_start": to_iso_z(RECORD_START), "pinned_stop": to_iso_z(RECORD_STOP),
            "first_sample": iso(T[0]), "last_sample": iso(T[-1]),
            "n_samples": len(T), "n_rows_served": rec["n_rows"],
            "n_dropped_not_positive_or_fill": rec["n_dropped"],
            "median_spacing_min": median_spacing_min(T, T[0], T[-1] + 1),
            "gaps_over_2_days": long_gaps(T),
            "chunk_days": ISWA_MAX_SPAN.days, "n_windows": rec["n_windows"],
            "empty_windows": [k for k in rec["empty"] if k not in rec["probe_keys"]],
            "pre_record_probe": {"start": to_iso_z(PROBE_START), "stop": to_iso_z(RECORD_START),
                                 "windows": rec["probe_keys"], "all_empty": set(rec["probe_keys"]) <= set(rec["empty"]),
                                 "hapi_code": 1406,
                                 "basis": "every window from the dataset's startDate (floored to the day) "
                                          "to the pinned start returned HAPI 1406 'No data available'"},
        },
        "rule": {
            "threshold_factor": THRESHOLD_FACTOR, "background_days": BACKGROUND_DAYS,
            "lead_fraction": LEAD_FRACTION, "search_days": SEARCH_S // DAY_S,
            "method": [
                "Samples with E > 0 are kept.",
                "Background = arithmetic mean of E over the 5 UTC days before the event day (a "
                "least-squares constant fit equals the mean of the points).",
                "Onset = first sample above 1.25 x background within 2 days of 00:00 UTC on the date; "
                "confirmation = the next sample, also above (the paper's case 2); end = first later "
                "sample below the threshold.",
                "Total SEP dose = trapezoid of (E - background) from onset to end, in uGy; time to peak "
                "and lead time are measured from the onset sample; lead time ends at the first sample "
                "at which 10% of the total has accumulated (sample resolution).",
            ],
            "scan": {"min_background_samples": SCAN_MIN_BACKGROUND_SAMPLES,
                     "max_pair_gap_s": SCAN_MAX_PAIR_GAP_S,
                     "method": "Background refit each UTC day from the 5 UTC days before it (at least "
                               f"{SCAN_MIN_BACKGROUND_SAMPLES} samples) and frozen during an event; a "
                               "trigger needs two consecutive samples above the threshold less than 3 h "
                               "apart.",
                     "chip": "design choice",
                     "source": {"kind": "design_choice",
                                "rationale": "LANDFALL's own limits for running the rule on iSWA's uneven "
                                             f"cadence: at least {SCAN_MIN_BACKGROUND_SAMPLES} samples in the "
                                             "5-day background, and a confirming sample less than 3 h after "
                                             "the first."}},
            "reproduce": {"dose_tol_pct": REPRODUCE_DOSE_TOL * 100, "time_to_peak_tol_min": REPRODUCE_TTP_TOL_MIN,
                          "chip": "design choice",
                          "source": {"kind": "design_choice",
                                     "rationale": "What counts as reproducing a row: total SEP dose within "
                                                  "15% and time to peak within 40 min of the paper."}},
            "donki_neighbour_days": DONKI_NEIGHBOUR_S // DAY_S,
            "chip": "literature",
        },
        "literature": lit,
        "paper_record_end": record_end.isoformat(),
        "table1": table,
        "table1_counts": dict(sorted(counts.items())),
        "scan": {"n_triggers": len(triggers), "triggers": triggers,
                 "peak_ratio_range": {"min": min(ratios), "max": max(ratios)} if ratios else None,
                 "flag_counts": {f: sum(1 for t in triggers if t["flag"] == f)
                                 for f in ("in_paper_table", "not_in_paper_table", "after_paper_table")}},
        "may_2024": {
            "paper_date": MAY_2024_DATE,
            "window": {"start": iso(w0), "stop": iso(w1)},
            "t0": iso(w0),
            "t_s": [t - w0 for t in T[i0:i1]],
            "uGy_per_day": E[i0:i1],
            "donki_gap": {"start": may_d.get("last_before_onset"), "stop": may_d.get("first_after_onset")},
        },
        "donki": {"snapshot": "swpc_sep_events", "coverage": {"start": donki["start"], "stop": donki["stop"]},
                  "retrieved_at": donki["retrieved_at"], "instrument_prefixes": instruments,
                  "note": "DONKI entries near a RAD trigger are listed for context only; LANDFALL does not "
                          "claim they are the same event."},
        "light_time": {"source": "JPL Horizons API, 1-way_down_LT, Earth geocenter to Mars, daily at 00:00 UTC "
                                 f"({CALIBRATION_SPAN[0]}..{CALIBRATION_SPAN[1]}, the query ingest/horizons.py "
                                 "cached)", "url": lt["_url"]["url"], "label": LIGHT_TIME_LABEL},
    }

    bad = [r for r in table if r["comparison"]["status"] == "not_reproduced"]
    dev = [r for r in table if r["comparison"]["status"] == "deviates"]
    extra = [r for r in table if r["comparison"]["status"] == "replay_triggered_paper_not"]
    may_r = may["replay"]
    late = [r for r in table if r["replay"]["triggered"] and r["replay"]["onset_after_listed_date_h"] >= 24]
    gaps = data["record"]["gaps_over_2_days"]
    longest = max(gaps, key=lambda g: g["days"]) if gaps else {"from": None, "to": None, "days": 0}
    caveats = [
        "Not reproduced (no sample above 1.25 x background within 48 h of the listed date): "
        + "; ".join(_miss_text(r) for r in bad) + ".",
        *(f"Deviation: {r['paper_date']} reproduces at {r['comparison']['total_pct']:+.0f}% total SEP dose "
          f"({r['replay']['total_uGy']:.2f} uGy against the paper's {r['paper']['total_uGy']:.2f} uGy)." for r in dev),
        *(f"{r['paper_date']}: the paper lists this event as not triggered; this replay's onset rule fires on one "
          f"sample at {r['replay']['onset']} ({r['replay']['peak']['ratio_to_background']:.3f} x background), "
          f"{'confirmed' if r['replay']['confirmation']['above_threshold'] else 'not confirmed'} by the next sample "
          f"({r['replay']['total_uGy']:.1f} uGy, {fmt_dhm(r['replay']['shelter_min'])} shelter)." for r in extra),
        *([f"For {', '.join(r['paper_date'] for r in late)} the replay's onset falls on a later UTC day ("
           + ", ".join(f"{r['replay']['onset_after_listed_date_h']:.1f} h" for r in late)
           + " after 00:00 UTC of the listed date); Table 1 prints dates only."] if late else []),
        f"The iSWA record has {len(gaps)} gaps longer than 2 days (data.record.gaps_over_2_days); the longest runs "
        f"from {longest['from']} to {longest['to']} ({longest['days']:g} days). A storm inside a gap cannot be seen "
        "by this replay.",
        f"Shelter time of {MAY_2024_DATE}: {fmt_dhm(may_r['shelter_min'])} in this replay against the paper's "
        f"{fmt_dhm(may['paper']['shelter_min'])}; total SEP dose {may_r['total_uGy']:.2f} against {may['paper']['total_uGy']:.2f} uGy.",
        f"The {MAY_2024_DATE} peak ratio ({may_r['peak']['ratio_to_background']:.1f} x) is measured against that "
        f"event's own 5-day background ({may_r['background_uGy_per_day']:.1f} uGy/day); a lower background "
        "raises the ratio as much as a higher peak does.",
        f"iSWA's cadence (median spacing {data['record']['median_spacing_min']:g} min over the record) differs from "
        "the paper's 15-minute PDS product (RAD's 15-minute dose rate data products, archived in NASA's Planetary "
        "Data System), so onsets, peaks and ends fall on different samples.",
        *([f"The paper's appendix Table 4 prints a partly different list of surface dates "
           f"({', '.join(lit['table4_only_dates'])} appear there and not in Table 1; "
           f"{', '.join(lit['table1_only_dates'])} appear in Table 1 and not there). This replay uses Table 1 only."]
          if lit["table4_only_dates"] or lit["table1_only_dates"] else []),
        "Detector E may include the rover's RTG background: the publisher's description does not say whether "
        "dose_e_total is RTG-corrected. The rule's ratios are taken as served.",
        ABSORBED_DOSE_CAVEAT,
        f"Numbers from arXiv:{ARXIV_ID} Table 1 (Martian surface); the journal version (doi:{DOI}) was not compared.",
        f"Whole-record scan: {len(triggers)} triggers. Those that match no row of the paper's table are listed as "
        "triggers not in the paper's table: this replay does not decide whether they were SEP events. Triggers "
        f"after the paper's surface record ends ({record_end.isoformat()}) are listed with any DONKI entries logged "
        "near them, which are not claimed to be the same event.",
        "Earth timings are lower bounds from light time only (JPL Horizons one-way light time at 00:00 UTC that day): "
        "no ground processing, relay or link schedule is added.",
    ]
    return make_snapshot(
        id=SNAPSHOT_ID, adapter=ADAPTER_ID,
        title="Mars-surface solar particle events: the RAD team's nowcast rule replayed on MSL RAD (CCMC iSWA)",
        source={
            "publisher": "NASA GSFC Community Coordinated Modeling Center (CCMC), iSWA HAPI server",
            "name": f"MSL RAD Dosimetry {PARAMETER}, whole surface record (iSWA HAPI id '{DATASET}'), replayed "
                    f"through the nowcast rule of {first_author.split()[0]} et al. 2025",
            "url": f"{ISWA_HAPI}/info?id={DATASET}",
            "access_urls": [rec["info_url"], *rec["data_urls"], ARXIV_HTML, CROSSREF_URL],
            "license": "No license or data-use terms stated in the HAPI /info response (checked 2026-11-14).",
            "citation": f"NASA GSFC Community Coordinated Modeling Center (CCMC), Integrated Space Weather "
                        f"Analysis system (iSWA), HAPI dataset '{DATASET}' ('{rec['info'].get('title')}'), "
                        f"parameter {PARAMETER}, {to_iso_z(RECORD_START)} to {to_iso_z(RECORD_STOP)} (pinned), "
                        f"HAPI server {ISWA_HAPI}, retrieved {ctx.retrieved_at}. Event rule: {first_author} et al., "
                        f"{PAPER_TITLE}, Space Weather 23, e2025SW004372 (2025), doi:{DOI}; numbers from "
                        f"arXiv:{ARXIV_ID}.",
        },
        retrieved_at=ctx.retrieved_at,
        coverage={"start": iso(T[0]), "stop": iso(T[-1]), "cadence": None},
        freshness={"kind": "historical", "stale_after": None},
        provenance="derived", caveats=caveats, data=data)


def _miss_text(r: dict) -> str:
    rp = r["replay"]
    s = f"{r['paper_date']} (max {rp['max_ratio_to_background']:.2f} x"
    spd = rp.get("samples_per_day") or {}
    typical = sorted(spd.values())[len(spd) // 2] if spd else 0
    thin = [f"{n} samples on {d}" for d, n in spd.items() if typical and n < 0.5 * typical]
    if thin:
        s += "; iSWA gap: " + ", ".join(thin)
    if rp.get("median_spacing_min") and rp["median_spacing_min"] > 30:
        s += f"; median spacing {rp['median_spacing_min']:g} min"
    return s + ")"


def run(ctx: RunContext) -> list[dict]:
    return [build(ctx)]
