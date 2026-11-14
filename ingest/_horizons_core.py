"""Pure helpers for the JPL Horizons comms adapter (stdlib only, no network).

Kept apart from ingest/horizons.py so the parsing, light-time and conjunction
arithmetic can be unit-tested against fixtures without touching the API.

Pitfalls handled (each has a test in ingest/tests/test_horizons.py):
  * the API wraps a plain-text ephemeris inside the JSON "result" string; the
    table sits between the $$SOE and $$EOE markers, and an error comes back as
    prose with no markers (or as a JSON "error" key);
  * CSV columns depend on QUANTITIES and CSV_FORMAT and include unnamed
    columns (solar/lunar presence flags), so columns are located by NAME;
  * dates look like "2026-Nov-14 00:00" (month abbreviations are parsed with
    a fixed table, never with the locale-dependent strptime %b);
  * "n.a." cells and units other than the ones we assume fail loudly.
"""

from __future__ import annotations

import html as html_lib
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta

_MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}
_TIME_RE = re.compile(
    r"^(?P<bc>b)?(?P<y>\d{4})-(?P<mon>[A-Z][a-z]{2})-(?P<d>\d{2})"
    r"(?: (?P<H>\d{2}):(?P<M>\d{2})(?::(?P<S>\d{2})(?:\.(?P<f>\d+))?)?)?$")


class HorizonsFormatError(ValueError):
    """The Horizons response does not have the shape this adapter was written for."""


def parse_horizons_time(s: str) -> datetime:
    """'2026-Nov-14 00:00' (also ':SS' and ':SS.fff') -> naive UTC datetime."""
    m = _TIME_RE.match(s.strip())
    if not m:
        raise HorizonsFormatError(f"unrecognised Horizons calendar date: {s!r}")
    if m.group("bc"):
        raise HorizonsFormatError(f"B.C. dates are not supported: {s!r}")
    mon = _MONTHS.get(m.group("mon"))
    if mon is None:
        raise HorizonsFormatError(f"unknown month abbreviation in {s!r}")
    frac = m.group("f") or "0"
    micro = int(round(float("0." + frac) * 1e6))
    return datetime(int(m.group("y")), mon, int(m.group("d")), int(m.group("H") or 0),
                    int(m.group("M") or 0), int(m.group("S") or 0)) + timedelta(microseconds=micro)


@dataclass(frozen=True)
class ObserverTable:
    header: dict            # facts parsed from the preamble (target, center, au, c, ...)
    columns: list[str]      # column names exactly as printed (blank names kept)
    records: list[list[str]]
    column_notes: str       # the "Column meaning" text after $$EOE (units live there)

    def col(self, name: str) -> int:
        try:
            return self.columns.index(name)
        except ValueError:
            raise HorizonsFormatError(
                f"column {name!r} not in Horizons table; got {self.columns!r} "
                "(columns depend on QUANTITIES and CSV_FORMAT)") from None

    def date_col(self) -> int:
        for i, c in enumerate(self.columns):
            if c.startswith("Date_"):
                return i
        raise HorizonsFormatError(f"no calendar-date column in {self.columns!r}")


def check_api_payload(payload: object) -> str:
    """Return the 'result' text of a Horizons API JSON payload, or raise with its error."""
    if not isinstance(payload, dict):
        raise HorizonsFormatError("Horizons API payload is not a JSON object")
    if payload.get("error"):
        raise HorizonsFormatError(f"Horizons API error: {payload['error']}")
    res = payload.get("result")
    if not isinstance(res, str) or not res.strip():
        raise HorizonsFormatError("Horizons API payload has no 'result' text")
    return res


def parse_observer_csv(result: str) -> ObserverTable:
    """Parse an OBSERVER table produced with CSV_FORMAT='YES'."""
    if "$$SOE" not in result or "$$EOE" not in result:
        said = " | ".join(ln.strip() for ln in result.strip().splitlines()[:6] if ln.strip())
        raise HorizonsFormatError(f"no $$SOE/$$EOE markers in Horizons result; it said: {said[:400]}")
    pre, rest = result.split("$$SOE", 1)
    body, post = rest.split("$$EOE", 1)
    head_lines = [ln for ln in pre.splitlines() if ln.strip() and set(ln.strip()) - {"*"}]
    if not head_lines:
        raise HorizonsFormatError("no column header line before $$SOE")
    columns = [c.strip() for c in head_lines[-1].split(",")]
    records = []
    for ln in body.splitlines():
        if not ln.strip():
            continue
        cells = [c.strip() for c in ln.split(",")]
        if len(cells) != len(columns):
            raise HorizonsFormatError(
                f"row has {len(cells)} cells but header has {len(columns)}: {ln.strip()!r}")
        records.append(cells)
    if not records:
        raise HorizonsFormatError("empty table between $$SOE and $$EOE")
    return ObserverTable(header=parse_header(pre), columns=columns, records=records,
                         column_notes=post)


def _grab(pattern: str, text: str) -> re.Match | None:
    return re.search(pattern, text, flags=re.M)


def parse_header(pre: str) -> dict:
    h: dict = {}
    if m := _grab(r"^Target body name:\s*(.+?)\s*\{source:\s*([^}]+)\}", pre):
        h["target_name"], h["target_ephemeris"] = m.group(1).strip(), m.group(2).strip()
    if m := _grab(r"^Center body name:\s*(.+?)\s*\{source:\s*([^}]+)\}", pre):
        h["center_name"], h["center_ephemeris"] = m.group(1).strip(), m.group(2).strip()
    if m := _grab(r"^Center-site name:\s*(.+?)\s*$", pre):
        h["center_site"] = m.group(1).strip()
    if m := _grab(r"^Start time\s*:\s*(.+?)\s*$", pre):
        h["start_time"] = m.group(1).strip()
    if m := _grab(r"^Stop\s+time\s*:\s*(.+?)\s*$", pre):
        h["stop_time"] = m.group(1).strip()
    if m := _grab(r"^Step-size\s*:\s*(.+?)\s*$", pre):
        h["step_size"] = m.group(1).strip()
    if m := _grab(r"^Ephemeris\s*/\s*(\S+)\s+(.+?)\s+Pasadena", pre):
        h["generated"] = m.group(2).strip()
    if m := _grab(r"Units conversion:\s*1 au=\s*([\d.]+)\s*km,\s*c=\s*([\d.]+)\s*km/s", pre):
        h["au_km"], h["c_km_s"] = float(m.group(1)), float(m.group(2))
        h["units_conversion_text"] = m.group(0).strip()
    return h


def column_unit(notes: str, quoted_name: str) -> str | None:
    """Unit text printed in the 'Column meaning' block, e.g. for "'1-way_down_LT,'"."""
    i = notes.find(quoted_name)
    if i < 0:
        return None
    m = re.search(r"Units:\s*([^\n]+)", notes[i:])
    return m.group(1).strip() if m else None


def to_float(cell: str, what: str) -> float:
    try:
        v = float(cell)
    except ValueError:
        raise HorizonsFormatError(f"{what}: not a number: {cell!r} (Horizons prints n.a. "
                                  "when a quantity is unavailable)") from None
    if math.isnan(v) or math.isinf(v):
        raise HorizonsFormatError(f"{what}: non-finite value {cell!r}")
    return v


def light_time_per_au_s(au_km: float, c_km_s: float) -> float:
    """Seconds light takes to travel 1 au: au / c (IAU 2012 au, SI c, as Horizons prints them)."""
    return au_km / c_km_s


# ------------------------------------------------------------------ conjunction windows
@dataclass(frozen=True)
class Window:
    start: datetime | None      # None: series already below threshold at its first sample
    end: datetime | None        # None: still below threshold at its last sample
    min_value: float            # smallest SAMPLED value inside the window
    min_at: datetime


def _cross(t0: datetime, v0: float, t1: datetime, v1: float, level: float) -> datetime:
    frac = (v0 - level) / (v0 - v1)
    return t0 + (t1 - t0) * frac


def find_windows(samples: list[tuple[datetime, float]], threshold: float) -> list[Window]:
    """Intervals where value < threshold, edges by linear interpolation between samples."""
    out: list[Window] = []
    start: datetime | None = None
    inside = False
    best: tuple[float, datetime] | None = None
    for i, (t, v) in enumerate(samples):
        if i == 0:
            inside = v < threshold
            start = None
            best = (v, t) if inside else None
            continue
        t0, v0 = samples[i - 1]
        if not inside and v < threshold:
            inside, start, best = True, _cross(t0, v0, t, v, threshold), (v, t)
        elif inside and v >= threshold:
            out.append(Window(start, _cross(t0, v0, t, v, threshold), best[0], best[1]))
            inside, start, best = False, None, None
        elif inside and v < best[0]:
            best = (v, t)
    if inside and best is not None:
        out.append(Window(start, None, best[0], best[1]))
    return out


def interpolate(samples: list[tuple[datetime, float]], t: datetime) -> float:
    """Linear interpolation inside the sampled span (raises outside it)."""
    if not samples or t < samples[0][0] or t > samples[-1][0]:
        raise ValueError(f"{t.isoformat()} outside sampled span")
    lo, hi = 0, len(samples) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if samples[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (t0, v0), (t1, v1) = samples[lo], samples[hi]
    if t1 == t0:
        return v0
    return v0 + (v1 - v0) * ((t - t0) / (t1 - t0))


def day_noon(d: date) -> datetime:
    """Published moratorium dates carry no time; compare edges with the middle of that UTC day."""
    return datetime(d.year, d.month, d.day, 12)


def days_between(a: datetime, b: datetime) -> float:
    return (a - b).total_seconds() / 86400.0


def match_window(windows: list[Window], start: date, end: date) -> Window | None:
    """The computed window that overlaps the published one (closest midpoint wins)."""
    lo, hi = day_noon(start), day_noon(end)
    mid = lo + (hi - lo) / 2
    best, best_gap = None, None
    for w in windows:
        if w.start is None or w.end is None:
            continue
        if w.end < lo - timedelta(days=20) or w.start > hi + timedelta(days=20):
            continue
        gap = abs(days_between(w.start + (w.end - w.start) / 2, mid))
        if best_gap is None or gap < best_gap:
            best, best_gap = w, gap
    return best


def edge_residuals(samples: list[tuple[datetime, float]], threshold: float,
                   published: list[dict]) -> list[dict] | None:
    """Per published window: computed edge minus published day (days). None if any is missing."""
    windows = find_windows(samples, threshold)
    out = []
    for p in published:
        w = match_window(windows, p["start"], p["end"])
        if w is None:
            return None
        out.append({"id": p["id"], "window": w,
                    "start_residual_days": days_between(w.start, day_noon(p["start"])),
                    "end_residual_days": days_between(w.end, day_noon(p["end"]))})
    return out


def calibrate_threshold(samples: list[tuple[datetime, float]], published: list[dict],
                        lo: float = 1.0, hi: float = 4.0, step: float = 0.01) -> dict:
    """Grid search for the elongation threshold that best reproduces published window edges.

    Objective: sum over every published start and end of (computed edge - published
    day at 12:00 UTC)^2, in days^2. Thresholds that lose any window are skipped. Ties
    keep the smallest threshold, so the result is deterministic.
    """
    n = int(round((hi - lo) / step))
    best = None
    for k in range(n + 1):
        th = round(lo + k * step, 6)
        res = edge_residuals(samples, th, published)
        if res is None:
            continue
        sse = sum(r["start_residual_days"] ** 2 + r["end_residual_days"] ** 2 for r in res)
        if best is None or sse < best["sse"] - 1e-12:
            best = {"threshold": th, "sse": sse, "residuals": res}
    if best is None:
        raise ValueError("no threshold in the grid reproduces every published window")
    edges = [x for r in best["residuals"] for x in (r["start_residual_days"], r["end_residual_days"])]
    best["n_edges"] = len(edges)
    best["rms_days"] = math.sqrt(best["sse"] / len(edges))
    best["max_abs_days"] = max(abs(x) for x in edges)
    best["mean_days"] = sum(edges) / len(edges)
    best["grid"] = {"lo": lo, "hi": hi, "step": step}
    return best


# ------------------------------------------------------------------ quote verification
_QUOTE_MAP = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                            "–": "-", "—": "-", " ": " "})


def normalise_text(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).translate(_QUOTE_MAP)
    s = re.sub(r"\s+", " ", s)
    return re.sub(r"\s+([,.;:!?])", r"\1", s).strip()


def html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    return normalise_text(html_lib.unescape(re.sub(r"(?s)<[^>]+>", " ", raw)))


def quote_in_page(quote: str, page_html: str) -> bool:
    return normalise_text(quote) in html_to_text(page_html)
