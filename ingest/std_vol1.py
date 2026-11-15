"""NASA-STD-3001 Volume 1 Revision C (Crew Health): verbatim requirements, glossary,
Table 4.8-1, Appendix E Table E.2-1 (Sample IMM Output) with its verbatim context, and
document history, frozen as one reference snapshot.

Pipeline (all at build time, never in the judged page):
  1. Fetch the OCHMO "Human Spaceflight Standards" page, find the Vol 1 PDF link there.
  2. Fetch the PDF (cached in .cache/ingest; *.pdf is never committed), record sha256 + pages.
  3. Rebuild text lines from glyph coordinates (see _std_vol1_pdf.py) and run a KNOWN-ANSWER
     SELF-TEST before anything else: the statement of [V1 4030] must contain "600 mSv".
     Subsetted CID fonts decoded without /ToUnicode yield garbage ("ooo u^A" for "600 mSv"),
     so if the self-test fails the adapter raises instead of shipping numbers.
  4. Extract each requirement's statement, note and rationale verbatim, with its section
     number/title (read from the headings, not typed here) and its page.
  5. A value is marked verified=true only when its verbatim snippet is found in the statement
     AND the number inside the snippet equals the expected number. Unverified values are
     dropped from `values`, never shipped.

FFD / PEL / POL category: taken from the title of the enclosing level-2 section
(e.g. "4.7 Permissible Outcome Limit for ...") so the classification is NASA's, not ours.

Appendix E: Table E.2-1 is read with the same glyph-position cells as Table 4.8-1, across its
page break, and checked against known answers (row 1, the last row, ranks without gaps). Its
verbatim context (the E.2.2 input sentence, the E.2.3 limitation, the Table E.2-2 note and
footnote, and four named Table E.2-2 rows) is frozen in data.appendix_e. The rest of the
four-page Table E.2-2 is deliberately not parsed.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urljoin, urlsplit, urlunsplit

from ingest._std_vol1_pdf import (PARAGRAPH_GAP_EM, Line, Page, join_lines, page_count, paragraph_breaks,
                                  read_pages)
from ingest.common import RunContext, make_snapshot, sha256_hex

ADAPTER_ID = "std_vol1"

LANDING_URL = "https://www.nasa.gov/ochmo/human-spaceflight-and-aviation-standards/"
# Link found on LANDING_URL on 2026-11-14 (its ?emrc= cache-buster query is stripped).
PINNED_PDF_URL = "https://www.nasa.gov/wp-content/uploads/2023/11/nasa-std-3001-vol-1-rev-c-with-signature.pdf"
# sha256 of the PDF as first retrieved on 2026-11-14 (1,660,855 bytes, 86 pages).
PINNED_SHA256 = "e65882af9c9a9861b520268f739baadba08f6225feb14489ff7c46442de26ce9"

HEADER_RE = re.compile(r"^NASA-STD-3001, VOLUME 1, REVISION C$")
FOOTER_RE = re.compile(r"^(\d{1,3}) of (\d{1,3})$")
HEADING_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+([A-Z(][^\[]*?)\s*$")
REQ_RE = re.compile(r"^\[V1 (\d{4})\]\s*(.*)$")
ITEM_RE = re.compile(r"^([a-z])\.\s+(.*)$")
NUM_RE = re.compile(r"\d+(?:,\d{3})*(?:\.\d+)?")

# What the plan (Appendix A / Appendix B / section 1.2) says, as checkable expectations.
# `values`: each `verbatim` snippet must occur in the statement and contain `value`.
TARGETS: dict[str, dict] = {
    "3003": {"in_plan": True, "items": {"a": "Periodic monitoring of general health status."}},
    "3004": {"in_plan": True, "items": {"h": "Assessing, recording, monitoring, and trending vital signs "
                                              "and additional physiological and behavioral health signs."}},
    "4001": {"in_plan": True, "expect": ["microgravity EVAs"], "values": [
        {"quantity": "in-mission VO2max (missions with microgravity EVAs)", "op": ">=", "value": 32.9,
         "unit": "ml/min/kg", "verbatim": "at or above 32.9 ml⁄min/kg"}]},
    "4002": {"in_plan": True, "expect": ["extraterrestrial surface EVAs"], "values": [
        {"quantity": "in-mission VO2max (missions with extraterrestrial surface EVAs)", "op": ">=", "value": 36.5,
         "unit": "ml/min/kg", "verbatim": "at or above 36.5 ml⁄min/kg"}]},
    "4003": {"in_plan": False, "values": [
        {"quantity": "in-mission aerobic capacity relative to pre-mission capacity", "op": ">=", "value": 80,
         "unit": "% of pre-mission", "verbatim": "at or above 80% of the pre-mission capacity"}]},
    "4006": {"in_plan": True, "expect": ["shall be guided by the nature of mission-associated critical operations"]},
    "4008": {"in_plan": True, "expect": ["shall be operationally defined"]},
    # Cited by the sleep case (steps s5 and s4): cognitive status is a behavioral-health determination,
    # and planned sleep periods must have established limits. Anchors read from the cached PDF, p. 34-35.
    "4011": {"in_plan": False, "expect": ["crewmember cognitive status shall be within clinically accepted values",
                                          "as determined by behavioral health evaluations"]},
    "4014": {"in_plan": False, "expect": ["planned sleep period shall have established limits",
                                          "to assure continued crew health and safety"]},
    "4024": {"in_plan": False, "values": [
        {"quantity": "in-mission skeletal muscle strength relative to baseline", "op": ">=", "value": 80,
         "unit": "% of baseline", "verbatim": "at or above 80% of baseline values"}]},
    "4026": {"in_plan": True, "expect": ["T-scores"], "no_numeric_t_score": True},
    "4027": {"in_plan": True, "values": [
        {"quantity": "bone mineral density, hip and spine, relative to pre-mission", "op": ">=", "value": 95,
         "unit": "% of pre-mission", "verbatim": "hip and spine at or above 95% of pre-mission values"},
        {"quantity": "bone mineral density, femoral neck, relative to pre-mission", "op": ">=", "value": 90,
         "unit": "% of pre-mission", "verbatim": "at or above 90% for the femoral neck"}]},
    "4028": {"in_plan": False, "expect": ["returning bone mineral density to pre-mission baseline values"]},
    "4029": {"in_plan": False, "expect": ["ALARA principle"]},
    "4030": {"in_plan": True, "expect": ["This limit is universal for all ages and sexes."], "values": [
        {"quantity": "career effective dose from spaceflight radiation", "op": "<", "value": 600,
         "unit": "mSv", "verbatim": "shall be less than 600 mSv"}]},
    "4031": {"in_plan": True, "expect": ["(sum of the October 1989 events)"], "values": [
        {"quantity": "effective dose from the design reference SPE (sum of the October 1989 events)", "op": "<",
         "value": 250, "unit": "mSv", "verbatim": "less than an effective dose of 250 mSv"}]},
    "4032": {"in_plan": True, "values": [
        {"quantity": "effective dose from nuclear technologies", "op": "<", "value": 20,
         "unit": "mSv per mission year", "verbatim": "less than an effective dose of 20 mSv per mission year"}]},
    "4033": {"in_plan": True, "expect": ["designed to support crew for > 60 days"], "values": [
        {"quantity": "GCR NASA effective dose rate, systems in free space", "op": "<", "value": 1.3,
         "unit": "mSv/day", "verbatim": "rate of 1.3 mSv/day for systems in free space"},
        {"quantity": "GCR NASA effective dose rate, systems on planetary surfaces", "op": "<", "value": 0.9,
         "unit": "mSv/day", "verbatim": "less than 0.9 mSv/day for systems on planetary surfaces"}]},
    # Appended after the 18 above (so their entries keep their place). Two Crew Medical Officers per vehicle
    # (5.2.1.1; section 3.5 prints "Requirement [V1 3006] moved to section 5.2.") and ground clearance before
    # each EVA (6.4). Anchors read from the cached PDF, p. 47 and p. 52; each rationale is checked too.
    "3006": {"in_plan": False, "expect": ["a minimum of two crewmembers per vehicle/platform"],
             "expect_rationale": ["a backup is available for medical treatment"]},
    "6006": {"in_plan": False,
             "expect": ["medically cleared to perform an EVA by ground medical support personnel prior to each EVA"],
             "expect_rationale": ["recent medical evaluations, fitness sessions"]},
}
# Extra sub-items of 3003/3004 that back the three LANDFALL deep cases (not in the plan list).
EXTRA_ITEMS = {"3003": ["d", "f"], "3004": ["p", "s", "t"]}

# Glossary (Appendix C) entries to ship; `plan_quote` = fragment the plan quotes (section 1.2).
GLOSSARY_TERMS = {
    "Fitness for Duty (FFD)": {"category": "FFD", "plan_quote": ["Minimum measurable capability",
                                                                 "that allows successful performance of all required duties."]},
    "Space Permissible Exposure Limits (SPEL)": {"category": "PEL", "plan_quote": [
        "Quantifiable limit of exposure to a spaceflight factor over a given length of time"]},
    "Permissible Outcome Limits (POL)": {"category": "POL", "plan_quote": [
        "Acceptable maximum decrement or change in a physiological or behavioral parameter",
        "as the result of exposure to the space environment."]},
    "Effective Dose": {}, "Sievert": {}, "Solar Particle Event (SPE)": {}, "Galactic Cosmic Rays (GCR)": {},
    "Free-space": {}, "In-Mission": {}, "Crew Medical Officer": {}, "Insomnia": {}, "Circadian Rhythm": {},
}
ACRONYMS = ["FFD", "PEL", "POL", "SPEL", "REID", "SPE", "GCR", "ALARA"]

T_SCORE_NUMERIC_RE = re.compile(r"T-score[^.]{0,80}?(?:[-−–]\s?\d|\d\.\d)|(?:[-−–]\s?\d\.\d)")


# ----------------------------------------------------------------------------- helpers
def _strip_query(url: str) -> str:
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, p.path, "", ""))


def discover_pdf_url(html: str, base: str = LANDING_URL) -> str | None:
    """The Vol 1 PDF link on the OCHMO standards page, without its cache-buster query."""
    from bs4 import BeautifulSoup

    for a in BeautifulSoup(html, "html.parser").find_all("a", href=True):
        href = urljoin(base, a["href"])
        path = urlsplit(href).path.lower()
        if path.endswith(".pdf") and "nasa-std-3001-vol-1" in path:
            return _strip_query(href)
    return None


def number_in(snippet: str) -> float | None:
    m = NUM_RE.search(snippet)
    return float(m.group(0).replace(",", "")) if m else None


def parse_cell(text: str) -> dict:
    """'1,000 mGy-Eq' -> {value: 1000, unit: 'mGy-Eq'}; 'Not applicable' / '-' -> value None."""
    t = text.strip()
    m = re.fullmatch(r"(\d+(?:,\d{3})*(?:\.\d+)?)\s*(mGy-Eq|mGy|mSv)", t)
    if m:
        return {"text": t, "value": float(m.group(1).replace(",", "")), "unit": m.group(2)}
    return {"text": t, "value": None, "unit": None}


def balanced_prefix(text: str) -> str:
    """Text up to and including the ']' that closes the first '[' (rationale blocks contain
    nested cross-references like '[V1 4029]')."""
    depth = 0
    for i, ch in enumerate(text):
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return text[: i + 1]
    return text


def _category_from_title(title: str) -> str | None:
    t = title.lower().replace("-", " ")
    if "fitness for duty" in t:
        return "FFD"
    if "permissible exposure limit" in t:
        return "PEL"
    if "permissible outcome limit" in t:
        return "POL"
    return None


# ----------------------------------------------------------------------------- document model
class Doc:
    """Body text of the PDF as a flat list of (page_index, printed_page, text, para_break, line)."""

    def __init__(self, pages: list[Page]):
        self.pages = pages
        self.rows: list[tuple[int, int | None, str, bool, Line]] = []
        self.printed: dict[int, int | None] = {}
        for pg in pages:
            printed = None
            body = []
            for ln in pg.lines:
                t = ln.text
                if HEADER_RE.match(t):
                    continue
                m = FOOTER_RE.match(t)
                if m:
                    printed = int(m.group(1))
                    continue
                body.append(ln)
            self.printed[pg.index] = printed
            breaks = paragraph_breaks(body)
            for ln, br in zip(body, breaks):
                self.rows.append((pg.index, printed, ln.text, br, ln))

    def find_page(self, needle: str, start: int = 0) -> int | None:
        for pg in self.pages[start:]:
            if any(needle in ln.text for ln in pg.lines):
                return pg.index
        return None


def body_range(doc: Doc) -> tuple[int, int]:
    """Row index range of the normative body: after the table of contents, before Appendix A."""
    # The table of contents also lists "1. SCOPE" (with dot leaders); the body heading has none.
    starts = [i for i, r in enumerate(doc.rows) if re.match(r"^1\.?\s+SCOPE\s*$", r[2])]
    if not starts:
        raise RuntimeError("std_vol1: body heading '1. SCOPE' not found; layout changed")
    start = starts[0]
    end = next((i for i, r in enumerate(doc.rows) if i > start and re.match(r"^APPENDIX A\b", r[2])), len(doc.rows))
    return start, end


def parse_requirements(doc: Doc) -> dict[str, dict]:
    start, end = body_range(doc)
    rows = doc.rows[start:end]
    sections: dict[int, tuple[str, str]] = {}
    reqs: dict[str, dict] = {}
    i = 0
    while i < len(rows):
        pidx, printed, text, br, _ = rows[i]
        mh = HEADING_RE.match(text)
        mr = REQ_RE.match(text)
        is_heading = bool(mh and not mr and not text.endswith(".") and len(text) < 120)
        if is_heading:
            num = mh.group(1)
            top = sections.get(1, (None,))[0]
            if "." not in num:   # level-1 headings are "4. HUMAN PERFORMANCE" (all caps)
                is_heading = mh.group(2).isupper()
            elif top is not None:  # sub-headings must belong to the current chapter
                is_heading = num.split(".")[0] in {top, str(int(top) + 1)}
        if is_heading:
            num, title = mh.group(1), mh.group(2).strip()
            # Wrapped heading: "4.7 Permissible Outcome Limit ... Density" + "(BMD) Loss".
            if i + 1 < len(rows) and not rows[i + 1][3] and len(rows[i + 1][2]) < 40 \
                    and not REQ_RE.match(rows[i + 1][2]) and not HEADING_RE.match(rows[i + 1][2]):
                title = f"{title} {rows[i + 1][2].strip()}"
                i += 1
            level = num.count(".") + 1
            sections = {k: v for k, v in sections.items() if k < level}
            sections[level] = (num, title)
            i += 1
            continue
        if mr and mr.group(1) not in reqs and "shall" in " ".join(r[2] for r in rows[i:i + 4]):
            rid = mr.group(1)
            stmt_lines, j = [mr.group(2)], i + 1
            while j < len(rows):
                t = rows[j][2]
                if (t.startswith("[Rationale:") or t.startswith("Note:") or REQ_RE.match(t)
                        or (HEADING_RE.match(t) and not t.endswith(".") and rows[j][3])
                        or t.startswith("Table ") or t.startswith("Figure ") or t == "Deleted."):
                    break
                stmt_lines.append(t)
                j += 1
            end_page = rows[j - 1][0]
            note = None
            if j < len(rows) and rows[j][2].startswith("Note:"):
                note_lines = [rows[j][2]]
                j += 1
                while j < len(rows) and not rows[j][3] and not rows[j][2].startswith("[Rationale:"):
                    note_lines.append(rows[j][2])
                    j += 1
                note = join_lines(note_lines)
            rationale = None
            if j < len(rows) and rows[j][2].startswith("[Rationale:"):
                buf, k = [], j
                while k < len(rows) and k < j + 200:
                    buf.append(rows[k][2])
                    closed = balanced_prefix(join_lines(buf))
                    k += 1
                    if closed.endswith("]") and closed.count("[") == closed.count("]"):
                        break
                rationale = balanced_prefix(join_lines(buf))
                j = k  # resume AFTER the rationale: its cross-references are not statements
            level_secs = [sections[k] for k in sorted(sections)]
            sec_num, sec_title = level_secs[-1] if level_secs else (None, None)
            parent = sections.get(2)
            items = {}
            cur = None
            for t in stmt_lines[1:] if len(stmt_lines) > 1 else []:
                mi = ITEM_RE.match(t)
                if mi:
                    cur = mi.group(1)
                    items[cur] = [mi.group(2)]
                elif cur:
                    items[cur].append(t)
            reqs[rid] = {
                "id": f"V1 {rid}",
                "label": f"[V1 {rid}]",
                "section": sec_num,
                "section_title": sec_title,
                "section_path": [{"number": n, "title": t} for n, t in level_secs],
                "category_from_section_title": _category_from_title(parent[1]) if parent else None,
                "category_basis": f"{parent[0]} {parent[1]}" if parent else None,
                "pdf_page_index": pidx,
                "pdf_page_number": pidx + 1,
                "printed_page": printed,
                "end_pdf_page_index": end_page,
                "text": join_lines(stmt_lines),
                "items": {k: join_lines(v) for k, v in items.items()},
                "note": note,
                "rationale": rationale,
            }
            i = j
            continue
        i += 1
    return reqs


def verify_requirement(rid: str, req: dict | None, spec: dict) -> dict:
    """Attach verified values / checks. verified=True only if every expectation holds."""
    out = {"checks": [], "values": []}
    if req is None:
        out["verified"] = False
        out["checks"].append({"check": f"[V1 {rid}] statement found", "ok": False})
        return out
    text = req["text"]
    ok_all = True
    for frag in spec.get("expect", []):
        ok = frag in text
        ok_all &= ok
        out["checks"].append({"check": f"statement contains {frag!r}", "ok": ok})
    for frag in spec.get("expect_rationale", []):
        ok = frag in (req.get("rationale") or "")
        ok_all &= ok
        out["checks"].append({"check": f"rationale contains {frag!r}", "ok": ok})
    for v in spec.get("values", []):
        ok = v["verbatim"] in text and number_in(v["verbatim"]) == float(v["value"])
        ok_all &= ok
        out["checks"].append({"check": f"statement contains {v['verbatim']!r} with value {v['value']}", "ok": ok})
        if ok:
            out["values"].append({**v, "verified": True})
    for letter, expected in spec.get("items", {}).items():
        got = req["items"].get(letter)
        ok = got == expected
        ok_all &= ok
        out["checks"].append({"check": f"item ({letter}) equals {expected!r}", "ok": ok})
    if spec.get("no_numeric_t_score"):
        bad = T_SCORE_NUMERIC_RE.search(text)
        ok = bad is None
        ok_all &= ok
        out["checks"].append({"check": "statement contains NO numeric T-score cutoff", "ok": ok})
    # No expectation at all -> nothing was checked: never claim verified=True vacuously.
    out["verified"] = bool(ok_all) if out["checks"] else None
    return out


def parse_table_481(doc: Doc) -> dict | None:
    # The caption also appears in the List of Tables; the real table has an "Organ" header row.
    found = None
    for pg in doc.pages:
        for i, ln in enumerate(pg.lines):
            if ln.text.startswith("Table 4.8-1—Dose Limits"):
                head = next((k for k in range(i + 1, min(i + 4, len(pg.lines)))
                             if pg.lines[k].segments[0].text == "Organ"), None)
                if head is not None:
                    found = (pg.index, i, head)
                    break
        if found:
            break
    if found is None:
        return None
    pidx, cap_i, head_i = found
    lines = doc.pages[pidx].lines
    head = lines[head_i].segments
    col_names = ["organ", "30_day", "1_year", "career"]
    centers = [(s.x0 + s.x1) / 2 for s in head]
    rows, foot_lines = [], []
    k = head_i + 1
    while k < len(lines) and not lines[k].text.startswith("*"):
        segs = lines[k].segments
        if len(segs) >= 2:
            cells = {"organ": segs[0].text}
            for s in segs[1:]:
                c = (s.x0 + s.x1) / 2
                col = min(range(1, len(centers)), key=lambda n: abs(centers[n] - c))
                cells[col_names[col]] = parse_cell(s.text)
            label = cells["organ"]
            rows.append({"organ_label_verbatim": label,
                         "organ": re.sub(r"[*#]+", "", label).replace("  ", " ").strip(),
                         "footnote_marks": re.findall(r"\*+|#+", label),
                         **{n: cells.get(n) for n in col_names[1:]}})
        k += 1
    # Footnotes: '*...' '**...' '#...' paragraphs until the next caption/large gap.
    while k < len(lines) and lines[k].size < 10.5 and not lines[k].text.startswith("Table"):
        foot_lines.append(lines[k].text)
        k += 1
    footnotes, cur = [], []
    for t in foot_lines:
        if re.match(r"^[*#]+", t) and cur:
            footnotes.append(join_lines(cur))
            cur = []
        cur.append(t)
    if cur:
        footnotes.append(join_lines(cur))
    units = sorted({r[c]["unit"] for r in rows for c in col_names[1:] if r.get(c) and r[c]["unit"]})
    return {
        "id": "Table 4.8-1",
        "caption": lines[cap_i].text,
        "note": lines[cap_i + 1].text if lines[cap_i + 1].text.startswith("Note:") else None,
        "header_verbatim": [s.text for s in head],
        "columns": col_names,
        "pdf_page_index": pidx, "pdf_page_number": pidx + 1, "printed_page": doc.printed.get(pidx),
        "rows": rows,
        "footnotes": footnotes,
        "units_found": units,
        "extraction_method": "cells assigned to columns by glyph x-position (nearest header centre)",
    }


# ----------------------------------------------------------------------------- Appendix E
E21_CAPTION = "Table E.2-1—Sample IMM Output"
E21_LIKELIHOOD_RE = re.compile(r"^(\d+(?:\.\d+)?) (per mission)$")
# Known answers read from the cached PDF (p. 81 and p. 82): the first and the last printed row.
E21_FIRST = (1, "Late Insomnia", "13.85 per mission")
E21_LAST = (48, "Dental Abscess", "0.068 per mission")

E22_CAPTION_START = "Table E.2-2—"
# The only Table E.2-2 rows frozen (scope cut: the four-page table is not parsed). Names as printed, without
# the trailing asterisk; whether a row carries one is read from the PDF.
E22_ROWS = ["Insomnia/sleep disturbances/circadian misalignment", "Headache (CO2 related)",
            "Urinary retention (space-adaptation related)", "Nephrolithiasis"]

# Verbatim context: (key, section, words that open the sentence, how many sentences to keep from there).
E_CONTEXT = [
    ("e_2_2_inputs", "E.2.2", "The IMM requires the user to provide", 1),
    ("e_2_3_limitation", "E.2.3", "One limitation is that IMM was developed for application to ISS missions", 1),
]


def _page_ref(doc: Doc, pidx: int) -> dict:
    return {"pdf_page_index": pidx, "pdf_page_number": pidx + 1, "printed_page": doc.printed.get(pidx)}


def _is_running_line(text: str) -> bool:
    return bool(HEADER_RE.match(text) or FOOTER_RE.match(text))


def _line_block(lines: list[Line], i: int) -> list[Line]:
    """The run of lines around line i that share its font size with no paragraph-sized gap between them
    (a paragraph, or a table note set in a smaller size than the rows around it)."""
    def joined(a: Line, b: Line) -> bool:
        return abs(a.size - b.size) < 0.2 and (a.y0 - b.y0) <= PARAGRAPH_GAP_EM * max(a.size, b.size)

    lo, hi = i, i
    while lo > 0 and joined(lines[lo - 1], lines[lo]):
        lo -= 1
    while hi + 1 < len(lines) and joined(lines[hi], lines[hi + 1]):
        hi += 1
    return lines[lo:hi + 1]


def _sentences(text: str) -> list[str]:
    return re.split(r"(?<=\.)\s+(?=[A-Z])", text)


def _find_caption(doc: Doc, start: str, header_first_cell: str, first_page: int = 0) -> tuple[int, int, int] | None:
    """(page, caption line, header line) of a table: the caption is also printed in the List of Tables and in
    sentences that cite it, but only the real table has its column header within three lines below it."""
    for pg in doc.pages[first_page:]:
        for i, ln in enumerate(pg.lines):
            if ln.text.startswith(start):
                head = next((k for k in range(i + 1, min(i + 4, len(pg.lines)))
                             if pg.lines[k].segments[0].text == header_first_cell), None)
                if head is not None:
                    return pg.index, i, head
    return None


def parse_table_e21(doc: Doc) -> dict | None:
    """Table E.2-1 (Sample IMM Output): every row's rank, condition and likelihood, across the page break.

    The rank column has no header; its cells sit left of the 'Medical Condition' header. The other cells go to
    the nearest header centre, as in Table 4.8-1. The table ends at the first line that is not a row; it goes
    on to the next page only when that page repeats the column header."""
    found = _find_caption(doc, E21_CAPTION, "Medical Condition")
    if found is None:
        return None
    pidx, cap_i, head_i = found
    head = doc.pages[pidx].lines[head_i].segments
    header = [s.text for s in head]
    cols = ["condition", "likelihood"]
    if len(header) != len(cols):
        return None
    centers = [(s.x0 + s.x1) / 2 for s in head]
    rank_right_edge = head[0].x0

    def row_of(ln: Line, page: int) -> dict | None:
        cells: dict[str, list[str]] = {}
        for s in ln.segments:
            if s.x1 <= rank_right_edge:
                cells.setdefault("rank", []).append(s.text)
            else:
                c = (s.x0 + s.x1) / 2
                cells.setdefault(cols[min(range(len(cols)), key=lambda n: abs(centers[n] - c))], []).append(s.text)
        if sorted(cells) != ["condition", "likelihood", "rank"] or any(len(v) != 1 for v in cells.values()):
            return None
        rank, cond, like = cells["rank"][0], cells["condition"][0], cells["likelihood"][0]
        m = E21_LIKELIHOOD_RE.match(like)
        if not re.fullmatch(r"\d{1,3}", rank) or m is None:
            return None
        return {"rank": int(rank), "condition": cond,
                "likelihood": {"text": like, "value": float(m.group(1)), "unit": m.group(2)},
                **_page_ref(doc, page)}

    rows: list[dict] = []
    page, k = pidx, head_i + 1
    while True:
        lines = doc.pages[page].lines
        ended = False
        while k < len(lines):
            if _is_running_line(lines[k].text):
                k += 1
                continue
            row = row_of(lines[k], page)
            if row is None:
                ended = True
                break
            rows.append(row)
            k += 1
        if ended or page + 1 >= len(doc.pages):
            break
        nxt = doc.pages[page + 1].lines
        first = next((n for n, ln in enumerate(nxt) if not _is_running_line(ln.text)), None)
        if first is None or [s.text for s in nxt[first].segments] != header:
            break
        page, k = page + 1, first + 1

    pages = []
    for r in rows:
        if not pages or pages[-1]["pdf_page_index"] != r["pdf_page_index"]:
            pages.append({**_page_ref(doc, r["pdf_page_index"]), "first_rank": r["rank"], "last_rank": r["rank"]})
        pages[-1]["last_rank"] = r["rank"]
    values = [r["likelihood"]["value"] for r in rows]
    first, last = rows[0] if rows else None, rows[-1] if rows else None
    checks = [
        {"check": f"row 1 is {E21_FIRST[1]!r}, {E21_FIRST[2]!r}",
         "ok": bool(first) and (first["rank"], first["condition"], first["likelihood"]["text"]) == E21_FIRST},
        {"check": f"the last row is {E21_LAST[0]} {E21_LAST[1]!r}, {E21_LAST[2]!r}",
         "ok": bool(last) and (last["rank"], last["condition"], last["likelihood"]["text"]) == E21_LAST},
        {"check": "ranks run 1, 2, 3, ... with no gap or repeat",
         "ok": bool(rows) and [r["rank"] for r in rows] == list(range(1, len(rows) + 1))},
        {"check": "no likelihood is larger than the one in the row above it",
         "ok": all(a >= b for a, b in zip(values, values[1:]))},
        {"check": "every likelihood unit is 'per mission'", "ok": all(r["likelihood"]["unit"] == "per mission" for r in rows)},
    ]
    return {
        "id": "Table E.2-1",
        "caption": doc.pages[pidx].lines[cap_i].text,
        "note": None,
        "header_verbatim": header,
        "columns": cols,
        "rank_column": "rank: the unlabelled left column (no header cell in the PDF)",
        **_page_ref(doc, pidx),
        "pages": pages,
        "rows": rows,
        "row_count": len(rows),
        "footnotes": [],
        "extraction_method": "cells assigned to columns by glyph x-position: left of the first header cell = rank, "
                             "otherwise the nearest header centre; continued across the page break where the next "
                             "page repeats the column header",
        "checks": checks,
        "verified": all(c["ok"] for c in checks),
    }


def parse_appendix_e(doc: Doc, imm_page: int | None) -> dict:
    """Verbatim context for Table E.2-1: E.2.2 (what IMM needs as input), E.2.3 (its ISS limitation), and from
    Table E.2-2 its note, its asterisk footnote and the four rows in E22_ROWS. Each text is the run of lines
    (same font size, no paragraph gap) that holds it, cut to the sentence(s) asked for."""
    start = imm_page if imm_page is not None else 0
    out: dict = {"appendix": "E", "section": "E.2"}
    checks = []
    for key, section, opening, n in E_CONTEXT:
        hits = [(pg.index, i) for pg in doc.pages[start:] for i, ln in enumerate(pg.lines) if opening in ln.text]
        entry = None
        if len(hits) == 1:
            pidx, i = hits[0]
            text = join_lines([ln.text for ln in _line_block(doc.pages[pidx].lines, i)])
            at = text.find(opening)
            sents = _sentences(text[at:])
            entry = {"section": section, "text": " ".join(sents[:n]), **_page_ref(doc, pidx)}
        out[key] = entry
        checks.append({"check": f"{section}: exactly one sentence opens {opening!r}", "ok": entry is not None})

    e22 = _find_caption(doc, E22_CAPTION_START, "Category", start)
    table: dict = {"id": "Table E.2-2", "caption": None, "intro_note": None, "footnote": None, "rows": [],
                   "scope": f"only the {len(E22_ROWS)} rows named here are frozen; the rest of the table is not parsed"}
    if e22 is not None:
        pidx, cap_i, head_i = e22
        lines = doc.pages[pidx].lines
        table["caption"] = join_lines([ln.text for ln in lines[cap_i:head_i]])
        table.update(_page_ref(doc, pidx))
        # The note printed between Table E.2-1 and the Table E.2-2 caption, in a smaller size (it names the table).
        note_i = next((i for i in range(cap_i) if lines[i].text.startswith(E22_CAPTION_START) and lines[i].size < 10.5), None)
        if note_i is not None:
            table["intro_note"] = {"text": join_lines([ln.text for ln in _line_block(lines, note_i)]), **_page_ref(doc, pidx)}
        end_page = next((pg.index for pg in doc.pages[pidx:] if any(ln.text.startswith("E.2.3") for ln in pg.lines)),
                        len(doc.pages) - 1)
        for pg in doc.pages[pidx:end_page + 1]:
            for i, ln in enumerate(pg.lines):
                if ln.text.startswith("Conditions noted with an asterisk") and table["footnote"] is None:
                    table["footnote"] = {"text": join_lines([x.text for x in _line_block(pg.lines, i)]),
                                         **_page_ref(doc, pg.index)}
                for s in ln.segments:
                    name = re.sub(r"\s*\*$", "", s.text)
                    if name in E22_ROWS:
                        table["rows"].append({"condition": name, "text_verbatim": s.text, "asterisk": s.text.endswith("*"),
                                              **_page_ref(doc, pg.index)})
    table["rows"].sort(key=lambda r: E22_ROWS.index(r["condition"]))
    found = [r["condition"] for r in table["rows"]]
    checks += [
        {"check": "Table E.2-2 found (caption with its 'Category' header)", "ok": e22 is not None},
        {"check": "Table E.2-2 asterisk footnote found", "ok": table["footnote"] is not None},
        {"check": f"each of the {len(E22_ROWS)} named Table E.2-2 rows found exactly once", "ok": found == E22_ROWS},
    ]
    out["table_e_2_2"] = table
    out["checks"] = checks
    out["verified"] = all(c["ok"] for c in checks)
    return out


def parse_history(doc: Doc) -> dict:
    cover = doc.pages[0]
    # The cover is two columns; the document identity block is the right-hand one (x0 > 400 pt).
    right = " ".join(s.text for ln in cover.lines for s in ln.segments if s.x0 > 400)
    approved = re.search(r"Approved:\s*(\d{4}-\d{2}-\d{2})", right)
    supersedes = re.search(r"Superseding\s+(NASA-STD-3001,\s*Volume 1,\s*Revision [A-Z])", right)
    number = re.search(r"(NASA-STD-3001,\s*Volume 1,\s*Revision ([A-Z]))\s+Approved", right)
    centre = [ln.text for ln in cover.lines if ln.size >= 15]   # the two 15.9 pt title lines
    entries = []
    for pg in doc.pages[1:4]:
        if not any("DOCUMENT HISTORY LOG" in ln.text for ln in pg.lines) and pg.index != 2:
            continue
        cur = None
        for ln in pg.lines:
            t = ln.text
            if HEADER_RE.match(t) or FOOTER_RE.match(t):
                continue
            date_seg = next((s for s in ln.segments if re.match(r"^\d{4}-\d{2}-\d{2}", s.text)), None)
            if date_seg:
                left = [s.text for s in ln.segments if s.x1 <= date_seg.x0 + 1]
                date = date_seg.text[:10]
                desc = [date_seg.text[10:].strip()] + [s.text for s in ln.segments if s.x0 > date_seg.x1 - 1]
                cur = {"status_and_revision": " ".join(left).strip(), "approval_date": date,
                       "pdf_page_index": pg.index, "description_lines": [d for d in desc if d]}
                entries.append(cur)
            elif cur and ln.segments and ln.segments[-1].x0 > 300:
                cur["description_lines"].append(" ".join(s.text for s in ln.segments if s.x0 > 300))
    for e in entries:
        e["description"] = join_lines(e.pop("description_lines"))
    rev_b = next((e for e in entries if e["status_and_revision"].replace(" ", "").endswith("RevisionB")), None)
    return {
        "cover_number": number.group(1) if number else None,
        "cover_revision": number.group(2) if number else None,
        "cover_title_lines": centre,
        "cover_approved": approved.group(1) if approved else None,
        "cover_supersedes": supersedes.group(1) if supersedes else None,
        "entries": entries,
        "rev_b_approval_date": rev_b["approval_date"] if rev_b else None,
        "rev_b_description_mentions_600_msv": bool(rev_b and "600" in rev_b["description"]),
        "rev_b_description_mentions_reid": bool(rev_b and "REID" in rev_b["description"]),
    }


def _row_after(doc: Doc, heading: str, after: int | None = None) -> int:
    """Row index of an appendix heading in the body (the table of contents lists them too)."""
    if after is None:
        after = body_range(doc)[0]
    for i in range(after + 1, len(doc.rows)):
        if doc.rows[i][2] == heading:
            return i
    raise RuntimeError(f"std_vol1: heading {heading!r} not found after row {after}; layout changed")


def parse_glossary(doc: Doc) -> list[dict]:
    start = _row_after(doc, "APPENDIX C")
    end = _row_after(doc, "APPENDIX D", start)
    paras, cur = [], []
    for pidx, printed, text, br, _ in doc.rows[start:end]:
        if br and cur:
            paras.append(cur)
            cur = []
        cur.append((pidx, printed, text))
    if cur:
        paras.append(cur)
    out = []
    for para in paras:
        joined = join_lines([t for _, _, t in para])
        for term, meta in GLOSSARY_TERMS.items():
            if joined.startswith(term + ":"):
                definition = joined[len(term) + 1:].strip()
                quotes = meta.get("plan_quote", [])
                out.append({
                    "term": term, "definition": definition, "category": meta.get("category"),
                    "appendix": "C.2 Definitions", "pdf_page_index": para[0][0],
                    "pdf_page_number": para[0][0] + 1, "printed_page": para[0][1],
                    "plan_quote_fragments": quotes,
                    "verified": all(q in definition for q in quotes) if quotes else None,
                })
    return out


def parse_acronyms(doc: Doc) -> dict:
    start = _row_after(doc, "APPENDIX B")
    end = _row_after(doc, "APPENDIX C", start)
    out = {}
    for _, _, _, _, ln in doc.rows[start:end]:
        if len(ln.segments) == 2 and ln.segments[0].text in ACRONYMS:
            out[ln.segments[0].text] = ln.segments[1].text
    return out


def appendix_d_texts(doc: Doc) -> dict[str, dict]:
    """Requirement text as printed in Appendix D (Requirements Compliance Matrix), per ID, rebuilt
    from the column that starts right after each '[V1 NNNN]' marker segment (same page only)."""
    start = _row_after(doc, "APPENDIX D")
    end = _row_after(doc, "APPENDIX E", start)
    rows = doc.rows[start:end]
    marker = re.compile(r"\[?V1 (\d{4})\]")
    out: dict[str, dict] = {}
    for i, row in enumerate(rows):
        segs = row[4].segments
        k = next((n for n, sg in enumerate(segs) if marker.fullmatch(sg.text)), None)
        if k is None or k + 1 >= len(segs):
            continue
        rid = marker.fullmatch(segs[k].text).group(1)
        col_x, page = segs[k + 1].x0, row[0]
        parts = [segs[k + 1].text]
        for nxt in rows[i + 1:]:
            nsegs = nxt[4].segments
            # Stop at the next ID cell (a segment that IS a marker; inline cross-references such as
            # "Volume 1 [V1 4030] Career ..." inside the text column do not count) or a new section cell.
            if any(marker.fullmatch(sg.text) for sg in nsegs) or (nsegs and nsegs[0].x0 < col_x - 3.0
                                                                   and re.fullmatch(r"\d+(\.\d+)+", nsegs[0].text)):
                break
            if nxt[0] != page and nsegs and nsegs[0].text == "Section":
                continue          # repeated table header on the next page
            col = [sg.text for sg in nsegs if abs(sg.x0 - col_x) <= 3.0 and sg.text not in
                   {"Requirement Text", "Comments", "Applicable"}]
            if col:
                parts.append(col[0])
        out.setdefault(rid, {"text": join_lines(parts), "pdf_page_index": page})
    return out


def context_quote(doc: Doc, needle: str, section: str) -> dict | None:
    """The paragraph containing `needle`, verbatim, with its page."""
    para, hit = [], None
    for pidx, printed, text, br, _ in doc.rows:
        if br:
            if hit is not None:
                break
            para = []
        para.append((pidx, printed, text))
        if needle in text and hit is None:
            hit = (pidx, printed)
    if hit is None:
        return None
    txt = join_lines([t for _, _, t in para])
    sentences = [s for s in re.split(r"(?<=\.)\s+", txt) if needle in s or "renal stones may" in s]
    return {"section": section, "pdf_page_index": hit[0], "pdf_page_number": hit[0] + 1,
            "printed_page": hit[1], "text": " ".join(sentences)}


# ----------------------------------------------------------------------------- adapter
def build(pdf: bytes, *, pdf_url: str, landing_url: str, retrieved_at: str,
          extra_caveats: list[str] | None = None) -> dict:
    pages = read_pages(pdf)
    n_pages = page_count(pdf)
    doc = Doc(pages)
    reqs = parse_requirements(doc)

    # ---- KNOWN-ANSWER SELF-TEST FIRST: fail loudly on garbled extraction ----
    r4030 = reqs.get("4030")
    if not r4030 or "600 mSv" not in r4030["text"]:
        raise RuntimeError("std_vol1 self-test FAILED: [V1 4030] statement does not contain '600 mSv' "
                           f"(got {r4030['text'][:120] if r4030 else None!r}). Text extraction is not "
                           "trustworthy (CID font / ToUnicode problem?); refusing to ship numbers.")

    appx_d = appendix_d_texts(doc)
    requirements = []
    for rid, spec in TARGETS.items():
        req = reqs.get(rid)
        ver = verify_requirement(rid, req, spec)
        entry = dict(req) if req else {"id": f"V1 {rid}", "label": f"[V1 {rid}]"}
        if req:
            keep = set(spec.get("items", {})) | set(EXTRA_ITEMS.get(rid, []))
            entry["items"] = {k: v for k, v in req["items"].items() if k in keep} if req["items"] else {}
            entry["items_total"] = len(req["items"])
        entry.update({"in_plan_appendix": spec.get("in_plan", False), **ver})
        d = appx_d.get(rid)
        entry["appendix_d"] = None if d is None else {
            "text": d["text"], "pdf_page_index": d["pdf_page_index"],
            "same_as_body": bool(req) and d["text"] == req["text"],
            # the bare number of every expected value also appears in the matrix text
            "expected_numbers_present": all(NUM_RE.search(v["verbatim"]).group(0) in d["text"]
                                            for v in spec.get("values", [])),
        }
        requirements.append(entry)
    differs = [r["label"] for r in requirements if r.get("appendix_d") and not r["appendix_d"]["same_as_body"]]

    table = parse_table_481(doc)
    tables = []
    if table:
        labels = " ".join(r["organ"] for r in table["rows"]).lower()
        table["checks"] = [
            {"check": "units are mGy-Eq / mGy only (no mSv)", "ok": set(table["units_found"]) <= {"mGy-Eq", "mGy"}},
            {"check": "no 'heart' row (the row is 'Circulatory System')",
             "ok": "heart" not in labels and "circulatory system" in labels},
            {"check": "Blood-forming Organs career limit is 'Not applicable'",
             "ok": any(r["organ"] == "Blood-forming Organs" and r["career"] and r["career"]["text"] == "Not applicable"
                       for r in table["rows"])},
        ]
        table["verified"] = all(c["ok"] for c in table["checks"])
        tables.append(table)
    imm = parse_table_e21(doc)
    if imm:
        # Which shipped requirements point to this table (their rationale names it by its caption).
        imm["cited_by"] = [r["label"] for r in requirements if imm["caption"] in (r.get("rationale") or "")]
        tables.append(imm)
    appendix_e = parse_appendix_e(doc, imm["pdf_page_index"] if imm else None)

    history = parse_history(doc)
    if history["cover_revision"] != "C":
        extra_caveats = (extra_caveats or []) + [
            f"The PDF cover reads revision {history['cover_revision']!r}, not 'C': the expectations in this adapter "
            "were written for Rev C, so any check marked ok=false must be re-read by a human."]
    glossary = parse_glossary(doc)
    acronyms = parse_acronyms(doc)
    quotes = [q for q in [context_quote(doc, "hypercalciuria", "4.7")] if q]

    caveats = [
        "Reference document, not live data: this is the text of NASA-STD-3001 Vol 1 Rev C as published; "
        "programs tailor applicability, so a requirement here is not automatically binding on a given mission.",
        "No requirement in this volume is an in-flight alert threshold. [V1 4006] and [V1 4008] explicitly delegate "
        "in-mission fitness-for-duty metrics and sensorimotor limits to mission operations.",
        "Text is rebuilt from glyph coordinates with pdfminer.six (/ToUnicode honoured); whitespace is collapsed and "
        "wrapped lines are re-joined (a line ending in '-' is joined without a space, which is correct for this "
        "document's compound words such as 'pre-mission'). Glyphs are otherwise unchanged.",
        "The VO2max unit is typeset as an equation; the PDF's glyph order gives 'ml⁄min/kg' (U+2044 fraction "
        "slash). The normalized unit 'ml/min/kg' in `values` is ours; the verbatim snippet keeps the slash glyph.",
        "Appendix D (Requirements Compliance Matrix) repeats each requirement; its extracted text differs from the "
        f"body for {', '.join(differs) if differs else 'none'} (see data.requirements[].appendix_d). Some "
        "differences are wording (e.g. [V1 4002] there says 'maximum aerobic capacity (VO2max)' and 'celestial "
        "extraterrestrial surface EVAs'), some are glyphs (the VO2max unit there extracts as 'mlÚ(min/kg)', a "
        "glyph without a usable /ToUnicode mapping), some are typos of the matrix. The body text (sections 3-7) "
        "is used as normative.",
        "The cover page says 'Approved: 2023-09-15' while the Document History Log lists Revision C with approval "
        "date 2023-09-13; both are shipped as found.",
        "The Rev B entry of the Document History Log (approved 2022-01-05) does not mention 600 mSv or REID; the "
        "claim that 600 mSv replaced a '3% REID at 95% confidence' limit in Rev B cannot be verified from this "
        "document. The [V1 4030] rationale states the limit keeps each crewmember 'below 3% mean risk' of REID.",
        "Table 4.8-1 caption reads 'Career/Non-Cancer Effects' but the [V1 4030] rationale calls it "
        "'Career/Non-Career Effects'; the 30-day column header is printed '30-DayLlimit' in the source.",
        "Category (FFD/PEL/POL) is read from the title of the enclosing level-2 section; [V1 4003] sits under "
        "'4.1 Fitness-for-Duty Aerobic Capacity' although its form (>= 80% of pre-mission) is baseline-relative.",
        "Glossary headwords are plural in the source ('Space Permissible Exposure Limits (SPEL)', 'Permissible "
        "Outcome Limits (POL)'); the abbreviation list expands PEL as 'permissible exposure limit'.",
        "Table E.2-1 is NASA's 'Sample IMM Output': it prints a likelihood 'per mission' for each condition but not "
        "the mission duration, location, number of EVAs or crew attributes that E.2.2 says IMM takes as input, and "
        "E.2.3 says IMM was developed for application to ISS missions. LANDFALL reads its numbers as a sample, never "
        "as a forecast for a given mission. Of Table E.2-2 only four named rows, its note and its asterisk footnote "
        "are frozen (data.appendix_e).",
    ] + (extra_caveats or [])

    data = {
        "document": {
            "title": "NASA Spaceflight Human-System Standard, Volume 1: Crew Health",
            "number": "NASA-STD-3001, Volume 1",
            "revision": history["cover_revision"],
            "cover_number_verbatim": history["cover_number"],
            "cover_title_verbatim": " ".join(history["cover_title_lines"]),
            "date": history["cover_approved"],
            "history_log_rev_c_date": next((e["approval_date"] for e in history["entries"]
                                            if e["status_and_revision"].replace(" ", "").endswith("RevisionC")), None),
            "supersedes": history["cover_supersedes"],
            "publisher": "NASA Office of the Chief Health and Medical Officer (OCHMO)",
            "url": pdf_url,
            "landing_url": landing_url,
            "sha256": sha256_hex(pdf),
            "bytes": len(pdf),
            "pages": n_pages,
            "page_numbering": "printed footer 'N of 86'; printed N equals pdf_page_number (= pdf_page_index + 1)",
        },
        "self_test": {"check": "[V1 4030] statement contains '600 mSv'", "ok": True,
                      "pdf_page_index": r4030["pdf_page_index"]},
        "glossary": glossary,
        "acronyms": acronyms,
        "requirements": requirements,
        "tables": tables,
        "context_quotes": quotes,
        "change_history": history,
        "appendix_e": appendix_e,
    }
    return make_snapshot(
        id=f"{ADAPTER_ID}_requirements",
        adapter=ADAPTER_ID,
        title="NASA-STD-3001 Vol 1 Rev C: verbatim requirements, FFD/PEL/POL glossary, Table 4.8-1",
        source={
            "publisher": "NASA Office of the Chief Health and Medical Officer (OCHMO)",
            "name": "NASA-STD-3001, Volume 1, Revision C - NASA Spaceflight Human-System Standard, "
                    "Volume 1: Crew Health",
            "url": landing_url,
            "access_urls": [landing_url, pdf_url],
            "license": "NASA technical standard published by NASA OCHMO (U.S. Government work); the document "
                       "carries no license or distribution statement. NASA does not endorse LANDFALL.",
            "citation": citation(pdf_url, sha256_hex(pdf), retrieved_at, history["cover_approved"]),
        },
        retrieved_at=retrieved_at,
        coverage={"start": None, "stop": None, "cadence": None},
        freshness={"kind": "reference", "stale_after": None},
        provenance="reference",
        caveats=caveats,
        data=data,
    )


def citation(pdf_url: str, sha: str, retrieved_at: str, approved: str | None) -> str:
    return ("National Aeronautics and Space Administration, Office of the Chief Health and Medical Officer. "
            "NASA-STD-3001, Volume 1, Revision C: NASA Spaceflight Human-System Standard, Volume 1: Crew Health. "
            f"Approved {approved or '2023-09-15'}. {pdf_url} "
            f"(retrieved {retrieved_at[:10]}; SHA-256 {sha}).")


def shipped_retrieved_at(ctx: RunContext, sha: str) -> str | None:
    """retrieved_at of the snapshot already in out_dir, when it was built from these same PDF bytes."""
    try:
        shipped = json.loads((ctx.out_dir / f"{ADAPTER_ID}_requirements.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if ((shipped.get("data") or {}).get("document") or {}).get("sha256") != sha:
        return None
    return shipped.get("retrieved_at")


def run(ctx: RunContext) -> list[dict]:
    extra = []
    landing_url, pdf_url = LANDING_URL, PINNED_PDF_URL
    try:
        found = discover_pdf_url(ctx.fetch_text(LANDING_URL))
        if found is None:
            extra.append(f"The Vol 1 PDF link was not found on {LANDING_URL} at retrieval; used the pinned URL.")
        elif found != PINNED_PDF_URL:
            extra.append(f"The OCHMO page now links a different Vol 1 PDF ({found}); it was used instead of "
                         f"the pinned {PINNED_PDF_URL}. Re-check the revision and every value.")
            pdf_url = found
    except Exception as exc:  # noqa: BLE001 - landing page is a convenience, the PDF is the source
        extra.append(f"Landing page {LANDING_URL} could not be fetched ({type(exc).__name__}); used pinned PDF URL.")
    pdf = ctx.fetch_bytes(pdf_url)
    if not pdf.startswith(b"%PDF"):
        raise RuntimeError(f"{pdf_url} did not return a PDF")
    sha = sha256_hex(pdf)
    if sha != PINNED_SHA256:
        extra.append(f"PDF sha256 {sha} differs from the one first verified ({PINNED_SHA256}); the document "
                     "changed since 2026-11-14 and every verbatim check below was re-run against the new bytes.")
    # An --offline run replays the cached bytes and retrieves nothing, so when they are the bytes the shipped
    # snapshot was built from it keeps that snapshot's retrieval time (and its citation date).
    retrieved_at = (shipped_retrieved_at(ctx, sha) if ctx.offline else None) or ctx.retrieved_at
    snap = build(pdf, pdf_url=pdf_url, landing_url=landing_url, retrieved_at=retrieved_at, extra_caveats=extra)
    return [snap]
