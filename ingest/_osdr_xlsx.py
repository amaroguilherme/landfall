"""Minimal stdlib .xlsx reader for the OSDR adapter (no new dependency).

An .xlsx file is a zip of XML parts. This reads ONE worksheet into rows of cell text:
shared strings and inline strings are resolved, and numbers keep their exact XML text
(no float round-trip here). It does not evaluate formulas and ignores styles, which is
enough for the OSDR 'Original Submitted' laboratory sheets (plain values only).
"""

from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET

_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_REL_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
_REF_RE = re.compile(r"^([A-Z]+)(\d+)$")


def _col_index(ref: str | None) -> int:
    m = _REF_RE.match(ref or "")
    if not m:
        raise ValueError(f"unexpected cell reference {ref!r}")
    n = 0
    for ch in m.group(1):
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_sheet(data: bytes, sheet: str | None = None) -> list[list[str | None]]:
    """-> rows (list of cell strings, None for empty cells). `sheet=None` requires exactly one sheet."""
    z = zipfile.ZipFile(io.BytesIO(data))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    sheets = [(s.get("name"), s.get(_REL_ID)) for s in wb.iter(_NS + "sheet")]
    if sheet is None:
        if len(sheets) != 1:
            raise ValueError(f"expected exactly one worksheet, found {[n for n, _ in sheets]}")
        rid = sheets[0][1]
    else:
        rid = next((r for n, r in sheets if n == sheet), None)
        if rid is None:
            raise ValueError(f"worksheet {sheet!r} not found in {[n for n, _ in sheets]}")
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = next((r.get("Target") for r in rels if r.get("Id") == rid), None)
    if not target:
        raise ValueError(f"no relationship target for worksheet id {rid!r}")
    path = target.lstrip("/") if target.startswith("/") else "xl/" + target
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(_NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(_NS + "t")))
    rows: list[list[str | None]] = []
    for row in ET.fromstring(z.read(path)).iter(_NS + "row"):
        cells: dict[int, str | None] = {}
        for c in row.iter(_NS + "c"):
            kind, v = c.get("t"), c.find(_NS + "v")
            if kind == "s":
                val = shared[int(v.text)] if v is not None and v.text is not None else None
            elif kind == "inlineStr":
                val = "".join(t.text or "" for t in c.iter(_NS + "t"))
            else:
                val = v.text if v is not None else None
            cells[_col_index(c.get("r"))] = val
        if cells:
            rows.append([cells.get(i) for i in range(max(cells) + 1)])
    return rows
