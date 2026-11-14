"""NOAA SWPC adapter: solar proton flux -> the operational NOAA S-scale.

LANDFALL never projects its own mSv for a solar particle event (SPE); the SPE
shelter case triggers on the real, operational NOAA S-scale (>=10 MeV integral
proton flux, 5-minute averages, in pfu = particles cm^-2 s^-1 sr^-1).

Snapshots produced (each degrades independently: a dead source means one
fewer snapshot, never invented data):

  swpc_s_scale      reference  S1-S5 thresholds + verbatim effect text, parsed
                               from the NOAA scales page and the official PDF.
  swpc_protons_live measured   GOES primary >=10 MeV (+ >=100 MeV) flux, current
                               S level, NOAA's own reported S level as a cross-check.
  swpc_spe_replay   measured   REAL historical replay: GOES-7 5-minute >10 MeV flux
                               for 18-31 October 1989 (peak S4), from NOAA NCEI.
  swpc_spe_list     reference  NOAA "Solar Proton Events Affecting the Earth
                               Environment" (1976 - Sept 2017 on the NASA SDAC mirror).
  swpc_sep_events   measured   NASA CCMC DONKI SEP events 2024-01-01 -> today
                               (only when kauai.ccmc.gsfc.nasa.gov answers).
"""

from __future__ import annotations

import csv
import dataclasses
import html as html_lib
import io
import math
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from ingest.common import RunContext, make_snapshot, to_iso_z

ADAPTER_ID = "swpc"

# ---------------------------------------------------------------- endpoints
SWPC_JSON = "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-{window}.json"
SWPC_INSTRUMENT_SOURCES = "https://services.swpc.noaa.gov/json/goes/instrument-sources.json"
SWPC_NOAA_SCALES_JSON = "https://services.swpc.noaa.gov/products/noaa-scales.json"
SCALES_PAGE = "https://www.swpc.noaa.gov/noaa-scales-explanation"  # 301 -> www.spaceweather.gov
SCALES_PDF = "https://www.swpc.noaa.gov/sites/default/files/images/NOAAscales.pdf"
SPE_LIST = "https://umbra.nascom.nasa.gov/SEP/"
GOES7_OCT1989 = ("https://www.ncei.noaa.gov/data/goes-space-environment-monitor/access/avg/"
                 "1989/10/goes07/csv/g07_eps_5m_19891001_19891031.csv")
DONKI_SEP = "https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/SEP"

US_GOV_LICENSE = ("U.S. Government work ({who}); not subject to copyright in the United States "
                  "(17 U.S.C. 105). No separate license text was fetched by this adapter.")

# NOAA S-scale (>=10 MeV integral proton flux, pfu), exactly as printed on the NOAA
# scales page (10, 10^2, 10^3, 10^4, 10^5). The build re-parses the live page and
# FAILS if it disagrees with these numbers, so this constant cannot drift silently.
NOAA_S_THRESHOLDS_PFU: tuple[tuple[int, float], ...] = (
    (5, 1e5), (4, 1e4), (3, 1e3), (2, 1e2), (1, 10.0))

ENERGY_10 = ">=10 MeV"
ENERGY_100 = ">=100 MeV"


# ---------------------------------------------------------------- pure helpers
def s_level(flux: float | None,
            thresholds: Iterable[tuple[int, float]] = NOAA_S_THRESHOLDS_PFU) -> int | None:
    """NOAA S level for a >=10 MeV 5-minute-average flux in pfu.

    Highest level whose threshold is MET (flux >= threshold): NOAA's scale counts
    "events when flux level was met", and SESC defines an event as flux "greater
    than or equal to 10 pfu". Returns 0 below S1 and None for missing/invalid data
    (missing must never render as "S0 - all clear", per [V2 10020]).
    """
    if flux is None or isinstance(flux, bool):
        return None
    try:
        f = float(flux)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f) or f < 0:
        return None
    for level, th in sorted(thresholds, key=lambda x: -x[0]):
        if f >= th:
            return level
    return 0


def parse_time_z(s: str) -> datetime:
    """Parse SWPC/NCEI/DONKI UTC time strings into naive-UTC datetimes.

    Accepts '2026-11-14T07:05:00Z', '2024-01-03T21:00Z' (DONKI, no seconds),
    '1989-10-01 00:00:00.000' (NCEI CSV, documented as UTC).
    """
    s = s.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%MZ", "%Y-%m-%d %H:%M:%S.%f",
                "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    if s.endswith("Z") or re.search(r"[+-]\d{2}:?\d{2}$", s[10:]):
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    raise ValueError(f"unrecognised UTC time string: {s!r}")


def sig(x: float | None, n: int = 4) -> float | None:
    """Round to n significant figures (documented size reduction, not smoothing)."""
    if x is None:
        return None
    if x == 0:
        return 0.0
    return float(f"{x:.{n}g}")


def select_channel(records: list[dict], energy: str,
                   primary_satellite: int | None = None) -> tuple[list[tuple[datetime, float, int]], list[dict]]:
    """Exact-match one energy channel out of a multi-channel SWPC GOES file.

    Pitfalls handled: several channels share one file (exact string match, so
    '>=10 MeV' never swallows '>=100 MeV'); the 'primary' file can switch
    satellites mid-window (per-point satellite kept, switches reported, duplicate
    time tags resolved in favour of the declared primary, else the last record).
    Returns (sorted [(time, flux, satellite)], switches).
    """
    by_time: dict[datetime, dict] = {}
    for r in records:
        if r.get("energy") != energy:
            continue
        flux = r.get("flux")
        if flux is None or not isinstance(flux, (int, float)) or isinstance(flux, bool):
            continue
        if math.isnan(flux) or flux < 0:
            continue
        t = parse_time_z(r["time_tag"])
        prev = by_time.get(t)
        if prev is not None and primary_satellite is not None and prev.get("satellite") == primary_satellite \
                and r.get("satellite") != primary_satellite:
            continue
        by_time[t] = r
    pts = [(t, float(by_time[t]["flux"]), by_time[t].get("satellite")) for t in sorted(by_time)]
    switches = []
    for (t0, _, s0), (t1, _, s1) in zip(pts, pts[1:]):
        if s0 != s1:
            switches.append({"time_tag": to_iso_z(t1), "from_satellite": s0, "to_satellite": s1})
    return pts, switches


def to_grid(points: list[tuple[datetime, float | None]], step_s: int,
            start: datetime | None = None, stop: datetime | None = None) -> dict:
    """Place points on a uniform UTC grid; empty slots are null (gaps stay visible)."""
    if not points and (start is None or stop is None):
        raise ValueError("no points")
    start = start or points[0][0]
    stop = stop or points[-1][0]
    n = int((stop - start).total_seconds() // step_s) + 1
    vals: list[float | None] = [None] * n
    for t, v in points:
        k = (t - start).total_seconds() / step_s
        if k < 0 or k >= n or k != int(k):
            continue
        vals[int(k)] = v
    return {"start": to_iso_z(start), "step_s": step_s, "n": n,
            "missing": sum(v is None for v in vals), "values": vals}


def hourly_max(points: list[tuple[datetime, float]]) -> dict:
    """Downsample 5-min points to hourly MAXIMUM (+ sample count per hour).

    Max (not mean) is used because the S-scale is a threshold on 5-minute
    averages: an hourly max preserves every threshold crossing and the peak.
    """
    buckets: dict[datetime, list[float]] = {}
    for t, v in points:
        buckets.setdefault(t.replace(minute=0, second=0, microsecond=0), []).append(v)
    hours = sorted(buckets)
    start, stop = hours[0], hours[-1]
    n = int((stop - start).total_seconds() // 3600) + 1
    mx: list[float | None] = [None] * n
    cnt = [0] * n
    for h in hours:
        k = int((h - start).total_seconds() // 3600)
        mx[k] = sig(max(buckets[h]))
        cnt[k] = len(buckets[h])
    return {"start": to_iso_z(start), "step_s": 3600, "n": n, "method": "hourly maximum of 5-minute values",
            "values": mx, "samples_per_hour": cnt}


def sesc_event(points: list[tuple[datetime, float | None]], threshold: float = 10.0) -> dict | None:
    """SESC event rule applied to a series: start = first of 3 consecutive valid
    points >= 10 pfu; end = last point >= 10 pfu; max = peak flux. Missing points
    are skipped (they neither break nor extend a run)."""
    valid = [(t, v) for t, v in points if v is not None]
    start_i = None
    for i in range(len(valid) - 2):
        if all(valid[j][1] >= threshold for j in range(i, i + 3)):
            start_i = i
            break
    if start_i is None:
        return None
    after = valid[start_i:]
    end_t = max(t for t, v in after if v >= threshold)
    peak_t, peak_v = max(after, key=lambda x: x[1])
    # Last point of the first UNBROKEN run >= threshold (the flux may then hover around
    # 10 pfu, so 'end_last_ge_10pfu' - the literal SESC end - can be later).
    run_end = after[0][0]
    for t, v in after:
        if v < threshold:
            break
        run_end = t
    return {"start": to_iso_z(valid[start_i][0]), "end_last_ge_10pfu": to_iso_z(end_t),
            "unbroken_ge_10pfu_until": to_iso_z(run_end),
            "max_time": to_iso_z(peak_t), "max_pfu": peak_v, "max_s_level": s_level(peak_v)}


def s_transitions(points: list[tuple[datetime, float | None]]) -> list[list]:
    """[[time, S level]] each time the S level changes (missing -> None)."""
    out: list[list] = []
    prev: Any = object()
    for t, v in points:
        lv = s_level(v)
        if lv != prev:
            out.append([to_iso_z(t), lv])
            prev = lv
    return out


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", html_lib.unescape(s)).strip()


# ---------------------------------------------------------------- S-scale parsing
def parse_s_scale_html(page: str) -> list[dict]:
    """Parse the 'Solar Radiation Storms' table of the NOAA scales page."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(page, "html.parser")
    table = None
    for t in soup.find_all("table"):
        head = _clean(t.get_text(" "))
        if "Flux level of >= 10 MeV particles" in head and re.search(r"\bS\s*5\b", head):
            table = t
            break
    if table is None:
        raise ValueError("S-scale table not found on NOAA scales page")
    levels = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) != 5:
            continue
        m = re.fullmatch(r"S\s*([1-5])", _clean(tds[0].get_text(" ")))
        if not m:
            continue
        effects = {}
        for p in tds[2].find_all("p"):
            b = p.find("b")
            if b is None:
                continue
            label = _clean(b.get_text()).rstrip(":")
            full = _clean(p.get_text(" "))
            effects[label] = _clean(full[len(_clean(b.get_text())):])
        sup = tds[3].find("sup")
        if sup is not None:
            exp = int(_clean(sup.get_text()))
            sup.extract()
            base = float(_clean(tds[3].get_text()))
            thr = base ** exp
            thr_text = f"{_clean(tds[3].get_text())}^{exp}"
        else:
            thr = float(_clean(tds[3].get_text()))
            thr_text = _clean(tds[3].get_text())
        levels.append({"level": f"S{m.group(1)}", "n": int(m.group(1)),
                       "descriptor": _clean(tds[1].get_text(" ")),
                       "threshold_pfu": thr, "threshold_as_printed": thr_text,
                       "effects": effects,
                       "average_frequency": _clean(tds[4].get_text(" "))})
    levels.sort(key=lambda x: x["n"])
    if [lv["n"] for lv in levels] != [1, 2, 3, 4, 5]:
        raise ValueError(f"expected S1..S5, got {[lv['level'] for lv in levels]}")
    return levels


def parse_s_scale_pdf_text(text: str) -> dict:
    """Pull the S-section biological texts + footnotes from the official PDF text."""
    i = text.find("Solar Radiation Storms")
    j = text.find("Radio Blackouts", i)
    if i < 0 or j < 0:
        raise ValueError("Solar Radiation Storms section not found in scales PDF")
    sec = text[i:j]
    bios = [_clean(b) for b in re.findall(r"Biological:\s*(.*?)\s*Satellite operations:", sec, flags=re.S)]
    if len(bios) != 5:
        raise ValueError(f"expected 5 Biological entries in PDF S section, got {len(bios)}")
    by_level = {f"S{5 - k}": bios[k] for k in range(5)}  # PDF order is S5 .. S1
    notes = []
    for pat in (r"Flux levels are 5 minute averages\..*?also considered\.",
                r"These events can last more than one day\.",
                r"High energy particle \(>100 MeV\).*?susceptible\."):
        m = re.search(pat, sec, flags=re.S)
        if not m:
            raise ValueError(f"PDF footnote not found: {pat}")
        notes.append(_clean(m.group(0)))
    # The S column header and the printed date live outside the S section in the
    # extracted text (column order), so they are searched in the whole document.
    hdr = re.search(r"Flux level of\s*(?:>=|≥|>)\s*10 MeV\s*particles\s*\(ions\)", text)
    date = re.search(r"\b(?:January|February|March|April|May|June|July|August|September|October|November|"
                     r"December)\s+\d{1,2},\s+\d{4}\b", text)
    return {"biological_by_level": by_level, "footnotes": notes,
            "column_header": _clean(hdr.group(0)) if hdr else None,
            "printed_date": date.group(0) if date else None}


def _pdf_title(pdf_bytes: bytes) -> str | None:
    """Document-information Title of a PDF (None if absent/unreadable)."""
    try:
        from pdfminer.pdfdocument import PDFDocument
        from pdfminer.pdfparser import PDFParser
        from pdfminer.pdftypes import resolve1
        from pdfminer.utils import decode_text

        for info in PDFDocument(PDFParser(io.BytesIO(pdf_bytes))).info:
            t = resolve1(info.get("Title"))
            if isinstance(t, bytes):
                return decode_text(t).strip() or None
            if isinstance(t, str):
                return t.strip() or None
    except Exception:  # noqa: BLE001 - metadata is optional
        return None
    return None


def _norm_text(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower().replace("***", "")).strip()


# ---------------------------------------------------------------- NCEI GOES CSV
def parse_ncei_goes_csv(text: str, columns: list[str]) -> tuple[dict, list[dict]]:
    """Parse an NCEI GOES SEM 'avg' CSV: metadata header, 'data:' line, then CSV.

    Returns ({global attrs + per-column units/description/missing}, rows) where
    each row is {"t": datetime, col: float|None}. The documented missing value
    (-99999) becomes None.
    """
    lines = text.splitlines()
    try:
        k = next(i for i, ln in enumerate(lines) if ln.strip() == "data:")
    except StopIteration as exc:
        raise ValueError("no 'data:' marker in NCEI CSV") from exc
    head = lines[:k]
    meta: dict[str, Any] = {"columns": {}}
    for ln in head:
        g = re.match(r'^:(\S+)\s*=\s*"(.*)"\s*$', ln.strip())
        if g:
            meta[g.group(1)] = g.group(2)
    for col in columns:
        info = {}
        for attr in ("description", "units", "missing_value"):
            pat = re.compile(rf'^{re.escape(col)}:{attr}\s*=\s*"(.*)"\s*;?\s*$')
            for ln in head:
                m = pat.match(ln.strip())
                if m:
                    info[attr] = m.group(1).strip()
                    break
        if "units" not in info:
            raise ValueError(f"column {col} not described in NCEI header")
        meta["columns"][col] = info
    rows = []
    for r in csv.DictReader(lines[k + 1:]):
        row: dict[str, Any] = {"t": parse_time_z(r["time_tag"])}
        for col in columns:
            v = float(r[col])
            miss = float(meta["columns"][col].get("missing_value", "-99999"))
            row[col] = None if (v == miss or v < 0) else v
        rows.append(row)
    return meta, rows


# ---------------------------------------------------------------- NOAA SPE list
_MON = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
_DAYTIME = re.compile(r"([A-Z][a-z]{2})[a-z]*\W*(\d{1,2})\W+(\d{2})(\d{2})\b")  # "Jun"/"June", "Aug/10 0435"


def _spe_time(raw: str, year: int) -> datetime | None:
    m = _DAYTIME.search(raw)
    if not m or m.group(1) not in _MON:
        return None
    try:
        return datetime(year, _MON[m.group(1)], int(m.group(2)), int(m.group(3)), int(m.group(4)))
    except ValueError:
        return None


def parse_spe_list_html(page: str) -> list[dict]:
    """Parse NOAA's 'Solar Proton Events Affecting the Earth Environment' table.

    The HTML leaves <tr>/<td> unclosed, so a DOM parser nests every row inside the
    previous one; rows are split on '<tr' and cells on '<td' instead.
    """
    events = []
    year = None
    for chunk in re.split(r"<tr\b[^>]*>", page, flags=re.I)[1:]:
        # The last row runs to the end of the document: cut at </tr> / </table> so page
        # footers (contact names, notes) never leak into an event's fields.
        chunk = re.split(r"</tr>|</table>", chunk, flags=re.I)[0]
        cells = [_clean(re.sub(r"<[^>]+>", " ", c)) for c in re.split(r"<td\b[^>]*>", chunk, flags=re.I)[1:]]
        ym = re.search(r"<strong>\s*((?:19|20)\d{2})\s*</strong>", chunk, flags=re.I)
        if ym and not (cells and _DAYTIME.match(cells[0] or "")):
            year = int(ym.group(1))
            continue
        if year is None or len(cells) < 3 or not _DAYTIME.match(cells[0]):
            continue
        start = _spe_time(cells[0], year)
        mx = _spe_time(cells[1], year)
        if start and mx and mx < start - timedelta(days=1):  # max falls in the next year
            mx = _spe_time(cells[1], year + 1)
        pfu_txt = cells[2].replace(",", "")
        try:
            pfu = float(pfu_txt)
        except ValueError:
            pfu = None
        tail = [c for c in cells[3:] if c]
        events.append({
            "start": to_iso_z(start) if start else None, "max": to_iso_z(mx) if mx else None,
            "start_as_printed": cells[0], "max_as_printed": cells[1],
            "peak_pfu": pfu, "s_level": s_level(pfu),
            "associated": " | ".join(tail) if tail else None,
        })
    if not events:
        raise ValueError("no events parsed from SPE list")
    return events


def parse_spe_list_notes(page: str) -> dict:
    """Verbatim numbered footnotes + the units note of the SPE list page.

    Each footnote is cut at the next <hr> / anchor, and the units note at its closing
    's^-1.', so the page's contact block (after the last <hr>) can never be captured.
    """
    foot = {}
    for m in re.finditer(r'<a\s+name\s*=\s*"NOTE_(\d+)"\s*>\s*</a>(.*?)(?=<hr|<a\s+name\s*=\s*"NOTE_|</body)',
                         page, flags=re.S | re.I):
        txt = _clean(re.sub(r"<[^>]+>", " ", m.group(2)))
        foot[f"[{m.group(1)}]"] = re.sub(r"^\[\d+\]\s*", "", txt)
    units = None
    u = re.search(r"Proton fluxes are integral 5-minute averages.*?s\s*<sup>\s*-1\s*</sup>\s*\.", page,
                  flags=re.S | re.I)
    if u:
        units = _clean(re.sub(r"<[^>]+>", "", re.sub(r"<sup>\s*(.*?)\s*</sup>", r"^\1", u.group(0), flags=re.I)))
    ge100_1989 = None
    o = re.search(r"since 1989 October\s*\(([\d,]+)\s*pfu\)", " ".join(foot.values()))
    if o:
        ge100_1989 = float(o.group(1).replace(",", ""))
    return {"footnotes_verbatim": foot, "units_note_verbatim": units,
            "oct1989_ge100mev_peak_pfu_per_note": ge100_1989}


# ---------------------------------------------------------------- DONKI
def parse_donki_sep(records: list[dict]) -> list[dict]:
    out = []
    for r in records or []:
        et = r.get("eventTime")
        try:
            t = to_iso_z(parse_time_z(et)) if et else None
        except ValueError:
            t = None
        out.append({
            "sep_id": r.get("sepID"), "event_time": t,
            "instruments": [i.get("displayName") for i in (r.get("instruments") or []) if isinstance(i, dict)],
            "linked_events": [e.get("activityID") for e in (r.get("linkedEvents") or []) if isinstance(e, dict)],
            "link": r.get("link"),
        })
    out.sort(key=lambda e: e["event_time"] or "")
    return out


# ---------------------------------------------------------------- snapshot builders
def _fetch(ctx: RunContext, url: str, *, live: bool = False, **kw: Any) -> bytes:
    # Live products are re-fetched every online run (the 6 h cache would otherwise
    # make a "live" snapshot hours old); --offline still replays from the cache.
    return ctx.fetch_bytes(url, use_cache=(ctx.offline or not live), **kw)


def build_s_scale(ctx: RunContext) -> tuple[dict, list[dict]]:
    page = _fetch(ctx, SCALES_PAGE).decode("utf-8", errors="replace")
    levels = parse_s_scale_html(page)
    parsed = tuple((lv["n"], lv["threshold_pfu"]) for lv in levels)
    if sorted(parsed) != sorted(NOAA_S_THRESHOLDS_PFU):
        raise ValueError(f"NOAA S thresholds changed on the page: {parsed} != {NOAA_S_THRESHOLDS_PFU}")
    caveats = [
        "Thresholds are NOAA's operational definition: >=10 MeV integral proton flux, 5-minute averages, "
        "pfu = particles cm^-2 s^-1 sr^-1. LANDFALL triggers on this scale and does not project its own mSv.",
        "NOAA's 'Biological' text is written for astronauts on EVA and for high-latitude aircraft crews; it is "
        "not a NASA crew-health limit and carries no NASA requirement ID. S1 reads 'None.' and S2 mentions only "
        "aircraft; the first astronaut-specific text is at S3.",
        "The PDF footnote says the scale is 'Based on this measure, but other physical measures are also "
        "considered', and that >100 MeV particles are a better indicator of radiation risk to passengers and crews.",
    ]
    pdf_info = None
    pdf_title = pdf_sha = None
    access = [SCALES_PAGE]
    try:
        from pdfminer.high_level import extract_text

        from ingest.common import sha256_hex

        pdf_bytes = _fetch(ctx, SCALES_PDF)
        pdf_info = parse_s_scale_pdf_text(extract_text(io.BytesIO(pdf_bytes)))
        pdf_title, pdf_sha = _pdf_title(pdf_bytes), sha256_hex(pdf_bytes)
        access.append(SCALES_PDF)
        for lv in levels:
            pb = pdf_info["biological_by_level"].get(lv["level"], "")
            lv["biological_pdf"] = pb
            if _norm_text(pb) != _norm_text(lv["effects"].get("Biological", "")):
                caveats.append(f"{lv['level']} Biological text differs between the HTML page and the PDF; both kept.")
        caveats.append("The HTML page and the PDF differ in capitalisation and in a few non-biological words "
                       "(e.g. S2 'Other systems'); 'effects' is the HTML text, 'biological_pdf' the PDF text "
                       "(whitespace-normalised, footnote marks kept).")
        hdr = pdf_info.get("column_header")
        if hdr and ">=" not in hdr and "≥" not in hdr:
            caveats.append(f"Operator wording differs: the PDF column header reads '{hdr}', the HTML page reads "
                           "'Flux level of >= 10 MeV particles', and SWPC's GOES proton data use '>=10 MeV'. "
                           "LANDFALL applies each threshold as met-or-exceeded (>=), consistent with the SESC "
                           "event rule ('greater than or equal to 10 pfu').")
    except Exception as exc:  # noqa: BLE001 - the HTML alone still carries thresholds + texts
        caveats.append(f"Official scales PDF could not be parsed this run ({type(exc).__name__}); "
                       "the PDF units/averaging footnotes are absent from this snapshot.")
    printed_date = (pdf_info or {}).get("printed_date")
    data = {
        "energy": ENERGY_10, "unit": "pfu",
        "unit_definition": "particles cm^-2 s^-1 sr^-1",
        "rule": "S level = highest level whose threshold is met (flux >= threshold); below 10 pfu = no S storm",
        "levels": levels,
        "pdf_footnotes": pdf_info["footnotes"] if pdf_info else None,
        "pdf_column_header": (pdf_info or {}).get("column_header"),
        "pdf_version": ({"file": "NOAAscales.pdf", "title_metadata": pdf_title, "printed_date": printed_date,
                         "sha256": pdf_sha} if pdf_info else None),
    }
    pdf_cite = (f"PDF 'NOAA Space Weather Scales', dated {printed_date}, " if printed_date
                else "PDF 'NOAA Space Weather Scales' (no printed date found), ")
    snap = make_snapshot(
        id="swpc_s_scale", adapter=ADAPTER_ID,
        title="NOAA Space Weather Scale for Solar Radiation Storms (S1-S5)",
        source={"publisher": "NOAA Space Weather Prediction Center (SWPC)",
                "name": "NOAA Space Weather Scales - Solar Radiation Storms",
                "url": SCALES_PAGE, "access_urls": access,
                "license": US_GOV_LICENSE.format(who="NOAA"),
                "citation": ("NOAA Space Weather Prediction Center. NOAA Space Weather Scales (Solar Radiation "
                             "Storms, S1-S5). Web page https://www.swpc.noaa.gov/noaa-scales-explanation "
                             "(served from www.spaceweather.gov) and " + pdf_cite +
                             "https://www.swpc.noaa.gov/sites/default/files/images/NOAAscales.pdf. "
                             f"Accessed {ctx.retrieved_at[:10]}.")},
        retrieved_at=ctx.retrieved_at,
        coverage={"start": None, "stop": None, "cadence": None},
        freshness={"kind": "reference", "stale_after": None},
        provenance="reference", caveats=caveats, data=data)
    return snap, levels


def build_live(ctx: RunContext) -> dict:
    import json

    prim = None
    prim_since = None
    inst_ok = False
    try:  # optional: the primary/secondary mapping must not take the flux snapshot down with it
        inst = json.loads(_fetch(ctx, SWPC_INSTRUMENT_SOURCES, live=True))
        inst_ok = True
        if isinstance(inst, list) and inst:
            last = sorted(inst, key=lambda r: r.get("time_tag", ""))[-1]
            prim = (last.get("protons") or {}).get("primary")
            prim_since = last.get("time_tag")
    except Exception:  # noqa: BLE001
        pass
    six = json.loads(_fetch(ctx, SWPC_JSON.format(window="6-hour"), live=True))
    week = json.loads(_fetch(ctx, SWPC_JSON.format(window="7-day"), live=True))
    p6, sw6 = select_channel(six, ENERGY_10, prim)
    p7, sw7 = select_channel(week, ENERGY_10, prim)
    p7_100, _ = select_channel(week, ENERGY_100, prim)
    if not p6:
        raise ValueError("no >=10 MeV points in the 6-hour file")
    t_last, f_last, sat_last = p6[-1]
    cur_level = s_level(f_last)
    pk = max(p7, key=lambda x: x[1]) if p7 else None
    ev = sesc_event([(t, f) for t, f, _ in p7])

    scales = None
    caveats = [
        "This file is a build-time freeze of a live product (5-minute cadence). On the static judged site it "
        "will normally be shown as STALE ([V2 10020]); only a fresh build or the optional API makes it current.",
        "Current S level = NOAA S-scale applied to the latest single 5-minute >=10 MeV average. NOAA's own "
        "reported S level (noaa-scales.json) is kept alongside as an independent cross-check.",
        ("GOES 'primary' is a role, not a satellite: SWPC reassigns it (per instrument-sources.json the proton "
         f"primary is GOES-{prim} since {prim_since}). Every point carries its satellite; switches are listed."
         if prim is not None else
         "GOES 'primary' is a role, not a satellite: SWPC reassigns it. instrument-sources.json was unavailable "
         "or unreadable this run, so duplicate time tags resolve to the last record. Every point carries its "
         "satellite; switches are listed."),
        "Values rounded to 4 significant figures; the 7-day context series is an hourly MAXIMUM of 5-minute "
        "values (max preserves every S-threshold crossing), with the sample count per hour (12 = complete).",
        "GOES flux is measured at geostationary orbit; it is the operational proxy for the interplanetary "
        "proton environment, not a dose at any crew location.",
    ]
    access = [SWPC_JSON.format(window="6-hour"), SWPC_JSON.format(window="7-day")]
    if inst_ok:
        access.append(SWPC_INSTRUMENT_SOURCES)
    try:
        raw = json.loads(_fetch(ctx, SWPC_NOAA_SCALES_JSON, live=True))
        scales = []
        for k in sorted(raw, key=lambda x: int(x)):
            S = raw[k].get("S") or {}
            scales.append({"key": int(k), "date": raw[k].get("DateStamp"), "time": raw[k].get("TimeStamp"),
                           "s_scale": S.get("Scale"), "s_text": S.get("Text"), "s_prob_pct": S.get("Prob")})
        access.append(SWPC_NOAA_SCALES_JSON)
        now = next((s for s in scales if s["key"] == 0), None)
        if now and now["s_scale"] is not None and cur_level is not None and str(cur_level) != str(now["s_scale"]):
            caveats.append(f"Computed S{cur_level} differs from NOAA-reported S{now['s_scale']} at build time; "
                           "NOAA may use a different window or additional measures - trust NOAA's value.")
        caveats.append("noaa-scales.json is undocumented: keys -1/0 carry an observed S value, keys 1-3 a "
                       "'Prob' (percent) that the SWPC page presents as the chance of 'S1 or greater'.")
    except Exception as exc:  # noqa: BLE001
        caveats.append(f"NOAA-reported scales cross-check unavailable this run ({type(exc).__name__}).")
    if sw6 or sw7:
        caveats.append(f"Primary-satellite switch inside the window: {sw7 or sw6}.")

    data = {
        "energy": ENERGY_10, "unit": "pfu", "unit_definition": "particles cm^-2 s^-1 sr^-1",
        "current": {"time_tag": to_iso_z(t_last), "flux_pfu": sig(f_last), "s_level": cur_level,
                    "satellite": sat_last},
        "noaa_reported_scales": scales,
        "primary_satellite": {"protons": prim, "assigned_at": prim_since},
        "satellites_in_window": sorted({s for _, _, s in p7} | {s for _, _, s in p6}),
        "satellite_switches": sw7 or sw6,
        "series_6h": {**to_grid([(t, sig(f)) for t, f, _ in p6], 300), "method": "native 5-minute values"},
        "series_7d": hourly_max([(t, f) for t, f, _ in p7]),
        "series_7d_ge100mev": hourly_max([(t, f) for t, f, _ in p7_100]) if p7_100 else None,
        "max_7d": ({"time_tag": to_iso_z(pk[0]), "flux_pfu": sig(pk[1]), "s_level": s_level(pk[1])}
                   if pk else None),
        "sesc_event_7d": ev,
    }
    return make_snapshot(
        id="swpc_protons_live", adapter=ADAPTER_ID,
        title="GOES >=10 MeV proton flux and current NOAA S level (build-time freeze)",
        source={"publisher": "NOAA Space Weather Prediction Center (SWPC)",
                "name": "GOES primary integral proton flux (integral-protons-6-hour.json, -7-day.json)",
                "url": "https://www.swpc.noaa.gov/products/goes-proton-flux",
                "access_urls": access, "license": US_GOV_LICENSE.format(who="NOAA"),
                "citation": ("NOAA Space Weather Prediction Center. GOES primary integral proton flux, 5-minute "
                             "averages (integral-protons-6-hour.json and integral-protons-7-day.json), SWPC data "
                             "service, https://services.swpc.noaa.gov/json/goes/primary/. "
                             f"Accessed {ctx.retrieved_at}.")},
        retrieved_at=ctx.retrieved_at,
        coverage={"start": to_iso_z(p7[0][0] if p7 else p6[0][0]), "stop": to_iso_z(t_last), "cadence": "PT5M"},
        freshness={"kind": "live", "stale_after": "PT15M"},
        provenance="measured", caveats=caveats, data=data)


def build_replay(ctx: RunContext, spe_events: list[dict] | None, spe_notes: dict | None = None) -> dict:
    text = _fetch(ctx, GOES7_OCT1989).decode("utf-8", errors="replace")
    cols = ["p3_flux_ic", "p7_flux_ic"]
    meta, rows = parse_ncei_goes_csv(text, cols)
    if meta.get("satellite_id") != "GOES-07" or meta.get("sample-time") != "5":
        raise ValueError(f"unexpected NCEI file metadata: {meta.get('satellite_id')} {meta.get('sample-time')}")
    for c in cols:
        if meta["columns"][c]["units"] != "p/(cm^2 s sr)":
            raise ValueError(f"{c} units are {meta['columns'][c]['units']}, expected p/(cm^2 s sr) (= pfu)")
    w0, w1 = datetime(1989, 10, 18), datetime(1989, 10, 31, 23, 55)
    win = [r for r in rows if w0 <= r["t"] <= w1]
    p10 = [(r["t"], r["p3_flux_ic"]) for r in win]
    p100 = [(r["t"], r["p7_flux_ic"]) for r in win]
    ev = sesc_event(p10)
    if ev is None or (ev["max_s_level"] or 0) < 3:
        raise ValueError("replay window does not contain an S3+ event - refusing to ship it as the SPE demo")
    daily = {}
    for t, v in p10:
        if v is not None:
            d = t.date().isoformat()
            daily[d] = max(daily.get(d, 0.0), v)
    noaa = None
    if spe_events:
        noaa = next((e for e in spe_events if (e.get("start") or "").startswith("1989-10-19")), None)
    desc10 = meta["columns"]["p3_flux_ic"].get("description", "")
    desc100 = meta["columns"]["p7_flux_ic"].get("description", "")
    created = (meta.get("creation_date") or "")[:10] or "creation date not stated"
    pk100 = max(((t, v) for t, v in p100 if v is not None), key=lambda x: x[1], default=None)
    noaa_txt = (f"NOAA's published list gives start {noaa['start_as_printed']} and max {noaa['max_as_printed']} "
                f"at {noaa['peak_pfu']:,.0f} pfu" if noaa and noaa.get("peak_pfu") is not None
                else "NOAA's list entry was unavailable this run")
    caveats = [
        "HISTORICAL REPLAY - NOT CURRENT CONDITIONS. Real GOES-7 measurements from October 1989, replayed so the "
        "SPE shelter case can be demonstrated while the Sun is quiet.",
        f"Flux = NCEI column p3_flux_ic, described verbatim in the file header as '{desc10}' (source spelling kept), "
        "5-minute averages, units p/(cm^2 s sr) (= pfu). The column is labelled 'corrected'; this NCEI archive file "
        f"was created {created} (originating agency {meta.get('originating_agency')}) and may differ from the "
        "values behind NOAA's 1989 list. GOES-7's 'GOES Energetic Particle Sensor' is not the GOES-R series SEISS "
        "that produces today's data; NOAA states no cross-normalisation has been attempted across GOES detectors.",
        "Values are the archive's own numbers, unrounded, at native 5-minute cadence (no downsampling); the "
        f"documented missing value -99999 is null ({sum(v is None for _, v in p10)} of {len(p10)} points in the window).",
        "Event onset/peak/end are computed here with the SESC rule (first of 3 consecutive points >= 10 pfu; end = "
        f"last point >= 10 pfu; missing points skipped). {noaa_txt}; this file gives onset {ev['start']} and peak "
        f"{ev['max_pfu']:,.0f} pfu at {ev['max_time']}. Whether NCEI time tags mark the start or the end of each "
        "5-minute average is not stated in the file header.",
        "NOAA's list has a single SESC event for this period (start and maximum only, no end time). In this file the "
        f">10 MeV flux stays >= 10 pfu without a break from {ev['start']} to {ev['unbroken_ge_10pfu_until']}, so the "
        "later re-intensifications (see daily maxima) fall inside that one event, as the SESC definition allows; it "
        f"then hovers near 10 pfu until the last >= 10 pfu sample at {ev['end_last_ge_10pfu']}.",
        "The LANDFALL plan cites NASA-STD-3001 Vol 1 Rev C [V1 4031], which uses the sum of the October 1989 events "
        "as the reference SPE (< 250 mSv). That requirement text was not re-read by this adapter, and this file is "
        "a flux time series, not a dose: no mSv is derived from it.",
    ]
    ref100 = (spe_notes or {}).get("oct1989_ge100mev_peak_pfu_per_note")
    if ref100 and pk100:
        caveats.append(
            f"The >=100 MeV series (p7_flux_ic) peaks at {pk100[1]:g} pfu at {to_iso_z(pk100[0])} in this file, "
            f"while a footnote on NOAA's SPE-list page gives {ref100:g} pfu as the >100 MeV level of 1989 October "
            f"(NOAA's figure is {100 * (ref100 - pk100[1]) / pk100[1]:.0f}% above this file's peak). Neither source "
            "explains the difference; both numbers are kept and no correction is applied.")
    data = {
        "replay_of": "October 1989 solar proton event (GOES-7)",
        "energy": ">10 MeV (p3_flux_ic)", "unit": "pfu", "unit_definition": "particles cm^-2 s^-1 sr^-1",
        "satellite": meta.get("satellite_id"),
        "file_attributes": {k: meta.get(k) for k in ("title", "process-type", "process-level", "sample-time",
                                                     "sample-unit", "creation_date", "originating_agency",
                                                     "archiving_agency")},
        "series_ge10mev": {**to_grid(p10, 300, w0, w1), "method": "native 5-minute values, missing = null"},
        "series_ge100mev": {**to_grid(p100, 300, w0, w1),
                            "column": f"p7_flux_ic ('{desc100}')",
                            "method": "native 5-minute values, missing = null"},
        "max_ge100mev": ({"time_tag": to_iso_z(pk100[0]), "flux_pfu": pk100[1]} if pk100 else None),
        "noaa_note_oct1989_ge100mev_pfu": ref100,
        "sesc_event_computed": ev,
        "noaa_spe_list_entry": noaa,
        "s_transitions": s_transitions(p10),
        "daily_max_pfu": daily,
    }
    return make_snapshot(
        id="swpc_spe_replay", adapter=ADAPTER_ID,
        title="Historical replay: October 1989 solar proton event, GOES-7 >10 MeV flux (peak S4)",
        source={"publisher": "NOAA National Centers for Environmental Information (NCEI)",
                "name": "GOES-07 Energetic Particle Sensor, 5-minute averages, October 1989 "
                        "(g07_eps_5m_19891001_19891031.csv)",
                "url": "https://www.ncei.noaa.gov/data/goes-space-environment-monitor/access/avg/1989/10/goes07/csv/",
                "access_urls": [GOES7_OCT1989], "license": US_GOV_LICENSE.format(who="NOAA"),
                "citation": ("NOAA National Centers for Environmental Information (originating agency "
                             "DOC/NOAA/NCEP/NWS/SWPC). GOES-07 Energetic Particle Sensor (EPS), 5-minute averages, "
                             f"1989-10-01 to 1989-10-31, file g07_eps_5m_19891001_19891031.csv (created {created}), "
                             "GOES Space Environment Monitor archive, " + GOES7_OCT1989 +
                             f". Accessed {ctx.retrieved_at[:10]}.")},
        retrieved_at=ctx.retrieved_at,
        coverage={"start": to_iso_z(w0), "stop": to_iso_z(w1), "cadence": "PT5M"},
        freshness={"kind": "historical", "stale_after": None},
        provenance="measured", caveats=caveats, data=data)


def spe_list_quirks(events: list[dict]) -> list[str]:
    """Honest notes on source rows a reader could misread (duplicates, ambiguous times)."""
    out = []
    by_start: dict[str, list[dict]] = {}
    for e in events:
        if e["start"]:
            by_start.setdefault(e["start"], []).append(e)
    for st, rows in sorted(by_start.items()):
        if len(rows) > 1:
            out.append(f"The source lists start {st} {len(rows)} times, as different rows: " + "; ".join(
                f"max {r['max_as_printed']}, "
                f"{'unparsed' if r['peak_pfu'] is None else format(r['peak_pfu'], 'g')} pfu "
                f"({r['associated'] or 'no association'})"
                for r in rows) + ". All rows are kept as printed and counted separately.")
    odd = [e for e in events if not re.fullmatch(r"[A-Z][a-z]{2} \d{2}/\d{4}", e["start_as_printed"])]
    if odd:
        out.append("Start times not printed in the usual 'Mon DD/HHMM' form, parsed as shown (raw string kept): "
                   + "; ".join(f"'{e['start_as_printed']}' -> {e['start']}" for e in odd) + ".")
    off = [e for e in odd if e["start"] and int(e["start"][14:16]) % 5]
    for e in off:
        out.append(f"'{e['start_as_printed']}' has no '/' and reads as {e['start'][11:16]} UT, which is off the "
                   "5-minute data grid; the printed digits may not be a time, so that start time is uncertain.")
    return out


def build_spe_list(ctx: RunContext) -> tuple[dict, list[dict], dict]:
    page = _fetch(ctx, SPE_LIST).decode("utf-8", errors="replace")
    events = parse_spe_list_html(page)
    notes = parse_spe_list_notes(page)
    note = re.search(r"SESC\s+defines\s+the\s+start.*?individual proton event\.", page, flags=re.S)
    xnorm = re.search(r"Different detectors.*?cross-normalize the resulting proton\s+fluxes\.", page, flags=re.S)
    counts: dict[str, int] = {}
    for e in events:
        key = f"S{e['s_level']}" if e["s_level"] else ("unknown" if e["s_level"] is None else "below_S1")
        counts[key] = counts.get(key, 0) + 1
    starts = [e["start"] for e in events if e["start"]]
    first, last = min(starts), max(starts)
    last_label = f"{[m for m, i in _MON.items() if i == int(last[5:7])][0]} {last[:4]}"  # locale-independent
    data = {
        "energy": ">10 MeV", "unit": "pfu",
        "units_note_verbatim": notes["units_note_verbatim"],
        "event_definition_verbatim": _clean(note.group(0)) if note else None,
        "cross_normalisation_note_verbatim": _clean(xnorm.group(0)) if xnorm else None,
        "footnotes_verbatim": notes["footnotes_verbatim"] or None,
        "events": events,
        "counts_by_peak_s_level": counts,
        "list_first_start": first, "list_last_start": last,
    }
    snap = make_snapshot(
        id="swpc_spe_list", adapter=ADAPTER_ID,
        title=f"NOAA list: Solar Proton Events Affecting the Earth Environment ({first[:4]} - {last_label})",
        source={"publisher": "NOAA Space Weather Prediction Center (formerly SESC); mirrored by NASA GSFC "
                             "Solar Data Analysis Center",
                "name": "Solar Proton Events Affecting the Earth Environment, 1976 - present (Preliminary Listing)",
                "url": SPE_LIST, "access_urls": [SPE_LIST],
                "license": US_GOV_LICENSE.format(who="NOAA / NASA"),
                "citation": ("NOAA Space Environment Services Center (now NOAA SWPC). Solar Proton Events "
                             "Affecting the Earth Environment, 1976 - present, Preliminary Listing. NASA GSFC Solar "
                             f"Data Analysis Center mirror, https://umbra.nascom.nasa.gov/SEP/. Accessed "
                             f"{ctx.retrieved_at[:10]}.")},
        retrieved_at=ctx.retrieved_at,
        coverage={"start": first, "stop": last, "cadence": None},
        freshness={"kind": "historical", "stale_after": None},
        provenance="reference",
        caveats=[
            f"This mirror's last listed event starts {last}; the page points to "
            "ftp://ftp.swpc.noaa.gov/pub/indices/SPE.txt for the current listing (FTP, not fetched by this "
            "adapter). Later events are NOT in this snapshot.",
            "'Preliminary Listing' per NOAA. Peak flux is the value printed in NOAA's 'Proton Flux (pfu @ >10 MeV)' "
            "column (the page: 'Proton fluxes are integral 5-minute averages for energies >10 MeV'); s_level is "
            "LANDFALL's mapping of that peak onto the NOAA S thresholds.",
            "Times are UT as printed ('Mon DD/HHMM'); the year comes from the table's year rows. Raw strings kept.",
            "Numbered footnotes on the page (e.g. [1], on the January 2005 event's separate injections) are kept "
            "verbatim in data.footnotes_verbatim; the 'associated' flare of a row is NOAA's, even where a footnote "
            "says the listed maximum came from a later injection.",
            *spe_list_quirks(events),
        ],
        data=data)
    return snap, events, notes


DONKI_SEP_API = "https://api.nasa.gov/DONKI/SEP"   # same CCMC data via NASA's API gateway
DONKI_API_MAX_DAYS = 60                              # the gateway rejects longer ranges


def donki_chunks(start: str, end: str, days: int = DONKI_API_MAX_DAYS) -> list[tuple[str, str]]:
    """Split [start, end] (inclusive ISO dates) into ranges the api.nasa.gov gateway accepts."""
    from datetime import date, timedelta

    cur, stop, out = date.fromisoformat(start), date.fromisoformat(end), []
    while cur <= stop:
        nxt = min(cur + timedelta(days=days - 1), stop)
        out.append((cur.isoformat(), nxt.isoformat()))
        cur = nxt + timedelta(days=1)
    return out


def build_donki(ctx: RunContext) -> dict:
    import json
    import os

    end = ctx.retrieved_at[:10]
    params = {"startDate": "2024-01-01", "endDate": end}
    quick = dataclasses.replace(ctx, timeout=20.0)
    caveat_route = None
    try:
        raw = quick.fetch_bytes(DONKI_SEP, params, retries=1, use_cache=True)
        records = json.loads(raw) if raw.strip() else []
        access = [f"{DONKI_SEP}?startDate=2024-01-01&endDate={end}"]
    except Exception as exc:  # noqa: BLE001 - CCMC's host was unreachable on 2026-11-14
        # Fallback: NASA's API gateway serves the same DONKI records. A personal key may be
        # supplied via NASA_API_KEY; otherwise NASA's public DEMO_KEY (fine for one build run).
        # The key never enters the snapshot.
        key_file = os.path.expanduser("~/.config/landfall/nasa_api_key")  # outside the repo, never committed
        key = os.environ.get("NASA_API_KEY") or (
            open(key_file).read().strip() if os.path.exists(key_file) else "") or "DEMO_KEY"
        shown = "DEMO_KEY" if key == "DEMO_KEY" else "<NASA_API_KEY>"
        records, access = [], []
        for a, b in donki_chunks("2024-01-01", end):
            raw = ctx.fetch_bytes(DONKI_SEP_API, {"startDate": a, "endDate": b, "api_key": key}, retries=2)
            records.extend(json.loads(raw) if raw.strip() else [])
            access.append(f"{DONKI_SEP_API}?startDate={a}&endDate={b}&api_key={shown}")
        caveat_route = (f"Served through NASA's API gateway (api.nasa.gov, {len(access)} requests of <= "
                        f"{DONKI_API_MAX_DAYS} days) because the CCMC host was unreachable at build time "
                        f"({type(exc).__name__}). Same DONKI records.")
    seen, unique = set(), []
    for r in records:
        if r.get("sepID") not in seen:
            seen.add(r.get("sepID"))
            unique.append(r)
    events = parse_donki_sep(unique)
    url = access[0]
    return make_snapshot(
        id="swpc_sep_events", adapter=ADAPTER_ID,
        title="DONKI solar energetic particle (SEP) events since 2024-01-01",
        source={"publisher": "NASA Community Coordinated Modeling Center (CCMC)",
                "name": "DONKI - Space Weather Database Of Notifications, Knowledge, Information: SEP",
                "url": "https://kauai.ccmc.gsfc.nasa.gov/DONKI/", "access_urls": access,
                "license": US_GOV_LICENSE.format(who="NASA"),
                "citation": ("NASA Community Coordinated Modeling Center. DONKI (Space Weather Database Of "
                             "Notifications, Knowledge, Information), SEP web service, " + url +
                             f". Accessed {ctx.retrieved_at[:10]}.")},
        retrieved_at=ctx.retrieved_at,
        coverage={"start": "2024-01-01T00:00:00Z", "stop": to_iso_z(parse_time_z(ctx.retrieved_at)),
                  "cadence": None},
        freshness={"kind": "historical", "stale_after": "P1D"},
        provenance="measured",
        caveats=["DONKI SEP entries are analyst-logged events (CCMC M2M office), not a flux series; "
                 "an empty list means none were logged in the window."] + ([caveat_route] if caveat_route else []),
        data={"events": events, "count": len(events)} if events else {"events": [], "count": 0,
                                                                       "note": "no SEP events in window"})


def run(ctx: RunContext) -> list[dict]:
    snaps: list[dict] = []
    failures: list[str] = []
    # The S-scale is the reference every other snapshot is read against: if it cannot
    # be fetched or its thresholds moved, fail loudly rather than ship stale levels.
    s_snap, _ = build_s_scale(ctx)
    snaps.append(s_snap)
    for name, fn in (("live", lambda: build_live(ctx)),):
        try:
            snaps.append(fn())
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name}: {exc}")
    spe_events = spe_notes = None
    try:
        spe_snap, spe_events, spe_notes = build_spe_list(ctx)
        snaps.append(spe_snap)
    except Exception as exc:  # noqa: BLE001
        failures.append(f"spe_list: {exc}")
    try:
        snaps.append(build_replay(ctx, spe_events, spe_notes))
    except Exception as exc:  # noqa: BLE001
        failures.append(f"replay: {exc}")
    try:
        snaps.append(build_donki(ctx))
    except Exception as exc:  # noqa: BLE001
        failures.append(f"donki: {exc}")
    for f in failures:
        print(f"[warn] swpc degraded -> {f}", file=sys.stderr)
    return snaps
