"""Glyph-level line assembly for the NASA-STD-3001 Vol 1 PDF (private helper of std_vol1).

Why not plain `pdfminer.high_level.extract_text`: pdfminer decodes the subsetted CID
fonts correctly (it honours /ToUnicode), but its layout analysis emits some equation
glyphs as separate text lines. Example, [V1 4001]: the fraction slash of the unit sits
between "ml" and "min" on the page (x = 469.3 pt, between "l" at 466.1 and "m" at 475.9)
yet extract_text prints "32.9 ml min/kg" and the slash on a line of its own. Grouping
every LTChar by baseline and ordering by x restores the printed order: "32.9 ml⁄min/kg".

Each line also keeps `segments`: runs of glyphs separated by a wide horizontal gap, so
table cells can be assigned to columns by x-position instead of by reading order.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

# A gap wider than this many font sizes splits a line into separate segments (cells).
SEGMENT_GAP_EM = 1.2
# A gap wider than this many font sizes (but narrower than a segment gap) is a space.
SPACE_GAP_EM = 0.15
# Glyphs whose baselines differ by at most this many font sizes share a line
# (covers sub/superscripts such as the "2max" of "VO2max").
BASELINE_TOL_EM = 0.5
# A vertical step larger than this many font sizes between two lines = paragraph break.
PARAGRAPH_GAP_EM = 1.6


@dataclass
class Segment:
    x0: float
    x1: float
    text: str


@dataclass
class Line:
    y0: float
    x0: float
    x1: float
    size: float
    segments: list[Segment] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(s.text for s in self.segments).strip()


@dataclass
class Page:
    index: int                 # 0-based PDF page index
    lines: list[Line]
    width: float
    height: float


def _iter_chars(obj):
    from pdfminer.layout import LTChar

    if isinstance(obj, LTChar):
        yield obj
        return
    try:
        children = iter(obj)
    except TypeError:
        return
    for child in children:
        yield from _iter_chars(child)


def _assemble_lines(chars) -> list[Line]:
    # Sort top-to-bottom by baseline, then left-to-right.
    chars = sorted(chars, key=lambda c: (-round(c.y0, 1), c.x0))
    rows: list[list] = []
    for c in chars:
        size = max(c.size, 1.0)
        placed = False
        # Compare with the few most recent rows only (they are the closest in y).
        for row in reversed(rows[-3:]):
            ref = row[0]
            tol = BASELINE_TOL_EM * max(size, ref.size)
            if abs(c.y0 - row_baseline(row)) <= tol:
                row.append(c)
                placed = True
                break
        if not placed:
            rows.append([c])
    lines = []
    for row in rows:
        row.sort(key=lambda c: c.x0)
        size = max(c.size for c in row)
        segments: list[Segment] = []
        buf: list[str] = []
        seg_x0 = row[0].x0
        prev_x1 = None
        for c in row:
            t = c.get_text()
            if prev_x1 is not None:
                gap = c.x0 - prev_x1
                if gap > SEGMENT_GAP_EM * size:
                    segments.append(Segment(seg_x0, prev_x1, _squash("".join(buf))))
                    buf, seg_x0 = [], c.x0
                elif gap > SPACE_GAP_EM * size:
                    buf.append(" ")
            buf.append(t)
            if t.strip():
                prev_x1 = c.x1
            elif prev_x1 is None:
                prev_x1 = c.x1
        segments.append(Segment(seg_x0, prev_x1 if prev_x1 is not None else row[-1].x1, _squash("".join(buf))))
        segments = [s for s in segments if s.text]
        if not segments:
            continue
        lines.append(Line(y0=row_baseline(row), x0=segments[0].x0, x1=segments[-1].x1,
                          size=size, segments=segments))
    lines.sort(key=lambda ln: (-ln.y0, ln.x0))
    return lines


def row_baseline(row) -> float:
    """Baseline of a row = the most common glyph y0 (robust to sub/superscripts)."""
    counts: dict[float, int] = {}
    for c in row:
        k = round(c.y0, 1)
        counts[k] = counts.get(k, 0) + 1
    return max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]


def _squash(s: str) -> str:
    return " ".join(s.split())


def read_pages(pdf: bytes) -> list[Page]:
    """Every page of the PDF as glyph-assembled lines (top to bottom)."""
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LAParams

    pages = []
    for i, lt_page in enumerate(extract_pages(io.BytesIO(pdf), laparams=LAParams())):
        x0, y0, x1, y1 = lt_page.bbox
        pages.append(Page(index=i, lines=_assemble_lines(_iter_chars(lt_page)),
                          width=x1 - x0, height=y1 - y0))
    return pages


def page_count(pdf: bytes) -> int:
    from pdfminer.pdfpage import PDFPage

    return sum(1 for _ in PDFPage.get_pages(io.BytesIO(pdf)))


def paragraph_breaks(lines: list[Line]) -> list[bool]:
    """breaks[i] is True when line i starts a new paragraph (large vertical gap above it)."""
    out = []
    for i, ln in enumerate(lines):
        if i == 0:
            out.append(True)
            continue
        prev = lines[i - 1]
        out.append((prev.y0 - ln.y0) > PARAGRAPH_GAP_EM * max(prev.size, ln.size))
    return out


def join_lines(texts: list[str]) -> str:
    """Join wrapped lines. A line ending in '-' is a real hyphen in this document
    (compound words such as 'pre-mission'), so the next line is appended without a space."""
    out = ""
    for t in texts:
        t = t.strip()
        if not t:
            continue
        if not out:
            out = t
        elif out.endswith("-") and not out.endswith(" -"):
            out += t
        else:
            out += " " + t
    return _squash(out)
