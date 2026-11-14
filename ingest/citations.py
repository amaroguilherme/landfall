"""Regenerate the generated part of CITATIONS.md from the frozen snapshots and the rules.

    uv run python -m ingest.citations

Every snapshot carries source.citation, and every rule constant carries a source. This
module collects them, de-duplicates them and rewrites the block between the markers below,
so the citation list can never drift from what the app actually ships.
(Not an adapter: it has no ADAPTER_ID, so `python -m ingest` discovery skips it.)
"""

from __future__ import annotations

import json
from pathlib import Path

from ingest.common import DEFAULT_OUT_DIR, REPO_ROOT, SCHEMA

CITATIONS = REPO_ROOT / "CITATIONS.md"
RULES_DIR = REPO_ROOT / "engine" / "rules"
BEGIN = "<!-- BEGIN GENERATED: do not edit by hand; run `uv run python -m ingest.citations` -->"
END = "<!-- END GENERATED -->"


def snapshot_citations(out_dir: Path = DEFAULT_OUT_DIR) -> dict[str, list[tuple[str, list[str]]]]:
    """publisher -> [(citation, [snapshot ids])], first-seen order within a publisher."""
    by_pub: dict[str, dict[str, list[str]]] = {}
    for p in sorted(out_dir.glob("*.json")):
        try:
            s = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(s, dict) or s.get("schema") != SCHEMA:
            continue
        src = s.get("source", {})
        pub, cit = src.get("publisher", "Unknown publisher"), (src.get("citation") or "").strip()
        if cit:
            by_pub.setdefault(pub, {}).setdefault(cit, []).append(s["id"])
    return {pub: list(cits.items()) for pub, cits in sorted(by_pub.items())}


def _walk(obj, found: set[str]) -> None:
    if isinstance(obj, dict):
        src = obj.get("source")
        if isinstance(src, dict):
            if src.get("kind") == "literature" and src.get("citation"):
                found.add(src["citation"].strip())
            elif src.get("kind") in {"nasa_standard", "nasa_brief", "noaa"} and src.get("doc"):
                found.add(" ".join(x for x in (src["doc"], src.get("url", "")) if x).strip())
        for v in obj.values():
            _walk(v, found)
    elif isinstance(obj, list):
        for v in obj:
            _walk(v, found)


def rules_citations(rules_dir: Path = RULES_DIR) -> list[str]:
    found: set[str] = set()
    for p in sorted(rules_dir.glob("*.json")):
        try:
            _walk(json.loads(p.read_text()), found)
        except (json.JSONDecodeError, OSError):
            continue
    return sorted(found)


def render() -> str:
    lines = [BEGIN, "", "### Frozen data snapshots (`web/public/data/`)", ""]
    for pub, items in snapshot_citations().items():
        lines.append(f"**{pub}**")
        lines.append("")
        for cit, ids in items:
            lines.append(f"- {cit} *(snapshots: {', '.join(f'`{i}`' for i in ids)})*")
        lines.append("")
    rc = rules_citations()
    if rc:
        lines += ["### Sources cited by the rules engine (`engine/rules/`)", ""]
        lines += [f"- {c}" for c in rc]
        lines.append("")
    lines.append(END)
    return "\n".join(lines)


def main() -> int:
    text = CITATIONS.read_text()
    block = render()
    if BEGIN in text and END in text:
        head, rest = text.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        text = head + block + tail
    else:
        text = text.rstrip() + "\n\n## Generated from the shipped data\n\n" + block + "\n"
    CITATIONS.write_text(text)
    print(f"CITATIONS.md regenerated ({len(block):,} chars in generated block)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
