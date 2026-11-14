"""Private PDF helpers for the std_vol2 adapter (leading underscore: not an adapter).

Text is extracted with pdfminer.six, which decodes the embedded /ToUnicode CMaps, so
symbols such as the em dash survive. Everything here is pure functions over the
per-page text so the tests can exercise them without the 6.9 MB PDF.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass

# Running header printed on every page of the document.
HEADER_RE = re.compile(r"^\s*NASA-STD-3001,\s*VOLUME 2,\s*REVISION F\s*\n")
# Running footer "<page> of <page+1>" (the document's own page field, as printed).
FOOTER_RE = re.compile(r"\n\s*(\d{1,3}) of (\d{1,3})\s*(?:\n\s*)*$")
HEADING_NUM_RE = re.compile(r"^\d{1,2}(?:\.\d{1,2}){1,4}$")


def pdf_to_pages(pdf: bytes) -> list[str]:
    """One string per PDF page, text containers in pdfminer's layout order."""
    from pdfminer.high_level import extract_pages  # lazy: tests do not need pdfminer
    from pdfminer.layout import LAParams, LTTextContainer

    pages = []
    for layout in extract_pages(io.BytesIO(pdf), laparams=LAParams()):
        pages.append("".join(el.get_text() for el in layout if isinstance(el, LTTextContainer)))
    return pages


def clean_page(text: str) -> tuple[str, int | None]:
    """Strip the running header and footer; return (body text, printed page number)."""
    printed = None
    m = FOOTER_RE.search(text)
    if m:
        printed = int(m.group(1))
        text = text[: m.start()] + "\n"
    text = HEADER_RE.sub("", text, count=1)
    return text, printed


def norm(s: str) -> str:
    """Collapse PDF line breaks into verbatim running text.

    A line that ends in '-' is joined without a space (keeps 'non-physician',
    'Table 6.8-5'); every other line break becomes one space.
    """
    s = s.replace(" ", " ")
    s = re.sub(r"-[ \t]*\n[ \t]*", "-", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


@dataclass
class Body:
    """All pages concatenated, with offsets back to PDF page numbers."""
    text: str
    starts: list[tuple[int, int, int | None]]  # (offset, pdf_page 1-based, printed page)

    @classmethod
    def from_pages(cls, pages: list[str], first: int = 1, last: int | None = None) -> "Body":
        parts, starts, off = [], [], 0
        last = last or len(pages)
        for i in range(first - 1, last):
            t, printed = clean_page(pages[i])
            starts.append((off, i + 1, printed))
            parts.append(t)
            off += len(t)
        return cls("".join(parts), starts)

    def page_at(self, offset: int) -> tuple[int, int | None]:
        cur = self.starts[0]
        for st in self.starts:
            if st[0] > offset:
                break
            cur = st
        return cur[1], cur[2]


def match_bracket(text: str, open_idx: int) -> int:
    """Index of the ']' closing the '[' at open_idx (nested brackets allowed), or -1."""
    depth = 0
    for i in range(open_idx, len(text)):
        c = text[i]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _heading_before(text: str, idx: int) -> tuple[str | None, str | None]:
    """Section number + title printed immediately above a requirement."""
    window = text[max(0, idx - 700): idx]
    lines = [ln.strip() for ln in window.split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    # Walk upward: title lines, then a line that is just the section number
    # (or a line "6.2.1.3 Title").
    title_lines: list[str] = []
    for ln in reversed(lines):
        if not ln:
            continue
        if HEADING_NUM_RE.match(ln):
            return ln, " ".join(reversed(title_lines)) or None
        m = re.match(r"^(\d{1,2}(?:\.\d{1,2}){1,4})\s+([A-Z].*)$", ln)
        if m and not ln.endswith("."):
            return m.group(1), " ".join([m.group(2), *reversed(title_lines)]).strip()
        if ln.endswith((".", ";", ":")) or ln.endswith("]") or len(title_lines) >= 3:
            break
        title_lines.append(ln)
    return None, None


@dataclass
class Requirement:
    id: str
    section: str | None
    title: str | None
    pdf_page: int
    printed_page: int | None
    text: str
    rationale: str | None


def find_requirement(body: Body, num: int) -> Requirement | None:
    """Locate the body occurrence of '[V2 num] ... shall ...' and its '[Rationale: ...]'."""
    tag = f"[V2 {num}]"
    for m in re.finditer(re.escape(tag), body.text):
        after = body.text[m.end(): m.end() + 4000]
        k = after.find("[Rationale:")
        nxt = re.search(r"\[V2 \d{4,5}\]", after)
        stop = k if k >= 0 else (nxt.start() if nxt else -1)
        if nxt and (k < 0 or nxt.start() < k):
            stop = nxt.start()
        if stop < 0:
            continue
        seg = after[:stop]
        # The requirement statement itself starts right after the tag.
        if not re.match(r"\s*[A-Z]", seg) or not re.search(r"\bshall\b", seg[:1500]):
            continue
        section, title = _heading_before(body.text, m.start())
        if section is None:
            continue
        rationale = None
        if k >= 0 and stop == k:
            open_idx = m.end() + k
            close_idx = match_bracket(body.text, open_idx)
            if close_idx > 0:
                rationale = norm(body.text[open_idx + 1: close_idx])
                rationale = re.sub(r"^Rationale:\s*", "", rationale)
        pdf_page, printed = body.page_at(m.start())
        return Requirement(id=tag, section=section, title=title, pdf_page=pdf_page,
                           printed_page=printed, text=norm(seg), rationale=rationale)
    return None
