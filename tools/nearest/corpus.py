"""Rebuild the NASA-STD-3001 requirement corpus that tools/nearest/rank.py ranks.

Build time only; nothing here ships. Adapted from the 15 Nov 2026 probe (/tmp/lf-probe/build_corpus.py).

  uv run python tools/nearest/corpus.py            # writes .cache/nearest/corpus.json (gitignored)

The PDFs come from the gitignored ingest cache (.cache/ingest), located by the URL the frozen
snapshot records, and are refused unless their SHA-256 equals the one that snapshot records. The
statements are cut by LANDFALL's own parsers, the ones that freeze the 57 verified requirements:

  Vol 1 Rev C   ingest.std_vol1.parse_requirements                   76 requirements
  Vol 2 Rev F   ingest._std_vol2_pdf.find_requirement over every
                [V2 n] tag on PDF pages std_vol2.BODY_FIRST..BODY_LAST  467 requirements

The volumes define 77 and 468: these parsers miss [V1 5002] and [V2 10157], so the ranking covers 543 of
545 (tools/nearest/README.md, "What the corpus misses"; web/src/features/nearest/coverage.json).

Each entry also records `page_check`: whether the statement, with all whitespace removed, occurs in
the text of its PDF page (or of that page and the next, for a statement that runs over a page
break) as the same parser read it. rank.py only shows entries that pass it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:  # run as a script: make `ingest` importable from the repo root
    sys.path.insert(0, str(ROOT))

from ingest import _std_vol2_pdf as v2p  # noqa: E402
from ingest import std_vol1 as v1  # noqa: E402
from ingest import std_vol2 as s2  # noqa: E402
from ingest._std_vol1_pdf import read_pages  # noqa: E402
from ingest.common import DEFAULT_CACHE_DIR, DEFAULT_OUT_DIR, RunContext, sha256_hex  # noqa: E402

SCHEMA = "landfall.nearest_corpus/1"
DEFAULT_OUT = ROOT / ".cache" / "nearest" / "corpus.json"
EXPECTED = {"V1": 76, "V2": 467}
TAG_RE = re.compile(r"\[V2 (\d{4,5})\]")


def squeeze(s: str) -> str:
    """Remove every whitespace character: the comparison key of the page check."""
    return re.sub(r"\s+", "", s)


def _snapshot_doc(name: str) -> dict:
    snap = json.loads((DEFAULT_OUT_DIR / f"{name}.json").read_text(encoding="utf-8"))
    return snap["data"]["document"]


def _cached_pdf(url: str, sha: str, cache_dir: Path) -> bytes:
    pdf = RunContext(offline=True, cache_dir=cache_dir).fetch_bytes(url)
    got = sha256_hex(pdf)
    if got != sha:
        raise RuntimeError(f"cached PDF for {url} has SHA-256 {got}, not the {sha} its snapshot records")
    return pdf


def _page_check(statement: str, page_texts: dict[int, str], first: int) -> dict:
    key = squeeze(statement)
    if key and key in squeeze(page_texts.get(first, "")):
        return {"pages": [first], "ok": True}
    if key and key in squeeze(page_texts.get(first, "") + page_texts.get(first + 1, "")):
        return {"pages": [first, first + 1], "ok": True}
    return {"pages": [first], "ok": False}


def vol1_entries(pdf: bytes, url: str, label: str) -> list[dict]:
    doc = v1.Doc(read_pages(pdf))
    page_texts: dict[int, str] = {}
    for pidx, _printed, text, _br, _ln in doc.rows:  # running header and footer already removed
        page_texts[pidx + 1] = page_texts.get(pidx + 1, "") + text + "\n"
    out = []
    for r in v1.parse_requirements(doc).values():
        page = r["pdf_page_number"]
        out.append({"id": r["id"], "doc": label, "section": r["section"], "title": r["section_title"],
                    "statement": r["text"], "rationale": r.get("rationale"), "pdf_page": page,
                    "pdf_url": f"{url}#page={page}", "page_check": _page_check(r["text"], page_texts, page)})
    return out


def vol2_entries(pdf: bytes, url: str, label: str) -> list[dict]:
    pages = v2p.pdf_to_pages(pdf)
    body = v2p.Body.from_pages(pages, s2.BODY_FIRST, s2.BODY_LAST)
    page_texts = {i + 1: v2p.clean_page(pages[i])[0] for i in range(s2.BODY_FIRST - 1, s2.BODY_LAST)}
    out = []
    for n in sorted({int(m.group(1)) for m in TAG_RE.finditer(body.text)}):
        r = v2p.find_requirement(body, n)
        if r is None:  # a tag that is only a cross-reference, or a deleted number
            continue
        out.append({"id": r.id.strip("[]"), "doc": label, "section": r.section, "title": r.title,
                    "statement": r.text, "rationale": r.rationale, "pdf_page": r.pdf_page,
                    "pdf_url": f"{url}#page={r.pdf_page}", "page_check": _page_check(r.text, page_texts, r.pdf_page)})
    return out


def build(cache_dir: Path = DEFAULT_CACHE_DIR) -> dict:
    d1, d2 = _snapshot_doc("std_vol1_requirements"), _snapshot_doc("std_vol2_requirements")
    label1 = f"NASA-STD-3001 Vol 1 Rev {d1['revision']}"
    label2 = f"NASA-STD-3001 Vol 2 Rev {d2['revision']}"
    e1 = vol1_entries(_cached_pdf(d1["url"], d1["sha256"], cache_dir), d1["url"], label1)
    e2 = vol2_entries(_cached_pdf(d2["pdf_url"], d2["sha256"], cache_dir), d2["pdf_url"], label2)
    for prefix, entries in (("V1", e1), ("V2", e2)):
        if len(entries) != EXPECTED[prefix]:
            raise RuntimeError(f"{prefix}: {len(entries)} requirements, expected {EXPECTED[prefix]}; a parser changed")
    reqs = e1 + e2
    if len({r["id"] for r in reqs}) != len(reqs):
        raise RuntimeError("duplicate requirement IDs in the corpus")
    return {
        "schema": SCHEMA,
        "note": "Build-time corpus for tools/nearest/rank.py. NASA's text, cut by LANDFALL's parsers; not shipped.",
        "sources": [
            {"doc": label1, "snapshot": "std_vol1_requirements", "pdf_url": d1["url"], "sha256": d1["sha256"],
             "parser": "ingest.std_vol1.parse_requirements", "count": len(e1)},
            {"doc": label2, "snapshot": "std_vol2_requirements", "pdf_url": d2["pdf_url"], "sha256": d2["sha256"],
             "parser": f"ingest._std_vol2_pdf.find_requirement, PDF pages {s2.BODY_FIRST}-{s2.BODY_LAST}",
             "count": len(e2)},
        ],
        "requirements": reqs,
    }


def dumps(corpus: dict) -> bytes:
    """Canonical bytes: the SHA-256 that rank.py records is taken over exactly these."""
    return (json.dumps(corpus, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    corpus = build()
    raw = dumps(corpus)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(raw)
    reqs = corpus["requirements"]
    failed = [r["id"] for r in reqs if not r["page_check"]["ok"]]
    counts = ", ".join("{}: {}".format(s["doc"], s["count"]) for s in corpus["sources"])
    print(f"{len(reqs)} requirements ({counts})")
    print(f"page check: {len(reqs) - len(failed)} pass, {len(failed)} fail {failed[:12]}")
    print(f"wrote {args.out} sha256 {hashlib.sha256(raw).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
