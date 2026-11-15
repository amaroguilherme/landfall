"""Rank NASA-STD-3001 requirements by closeness in meaning to each claim's query (build time only).

  uv run --isolated --no-project --with model2vec==0.10.0 --with numpy \
      python -I tools/nearest/rank.py <model_dir> <corpus.json> [--check] [--review-out PATH]

<model_dir> holds config.json, model.safetensors and tokenizer.json of minishlab/potion-base-8M at the
revision below. They are untrusted until their SHA-256 match: only the verified bytes are copied to a
fresh directory and loaded from there, with the Hugging Face hub switched off. <corpus.json> is the
output of tools/nearest/corpus.py.

For each query in queries.json (whose SHA-256 was recorded in README.md before the first run) every
requirement is embedded as title + '. ' + statement and ranked by cosine similarity to the query.
Walking down that ranking, an entry is shown only if it passes gate() below, until five pass. Entries
that fail are listed in `skipped` with the reason. No similarity score is written anywhere.

--check re-ranks and fails unless the result is identical to the committed nearest.json.
--review-out also writes the first eight passages that pass the gate per claim, for human review.

The module imports only the standard library at the top, so the tests can import gate() without
numpy or model2vec.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
QUERIES = HERE / "queries.json"
LABELS = HERE / "labels.json"
REVIEW = HERE / "review.json"
OUT = ROOT / "web" / "src" / "features" / "nearest" / "nearest.json"
SENSOR_MAP = ROOT / "hardware" / "sensor-map.json"
META = ROOT / "engine" / "rules" / "meta.json"
SNAPSHOTS = ROOT / "web" / "public" / "data"

MODEL_ID = "minishlab/potion-base-8M"
REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"
MODEL_SHA256 = "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2"
MODEL_FILES = {  # name: (bytes, SHA-256)
    "model.safetensors": (30_236_760, MODEL_SHA256),
    "tokenizer.json": (683_666, "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50"),
    "config.json": (202, "2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553"),
}
# Recorded in README.md, and committed, before the first ranking run.
QUERIES_SHA256 = "3aa9607718954ceb29966471a32829a6b0bea948b11e5c4342ef781cc42bbae2"
LABELS_SHA256 = "909ebc2d2e88d3fe05581e682aca679c1dbd49b8f4c29805aace6323562801f2"

SHOWN = 5          # passages frozen per claim
REVIEW_DEPTH = 8   # passages per claim handed to the reviewer, so replacements are ready
MAX_TOKENS = 512   # model2vec's default truncation, as in the 15 Nov probe that was measured
SCHEMA = "landfall.nearest/1"

# ------------------------------------------------------------------ the clean-text and page gate
TERMINAL_RE = re.compile(r"[.!?][\"'”’)\]]*$")
RUNNING_HEADER = "NASA-STD-3001, VOLUME"   # upper case: the page header, not a citation of 'Volume 1'
HEADING_RE = re.compile(r"(?:^|[.;:\]]\s+)(\d{1,2}(?:\.\d{1,2}){1,4})\s+[A-Z][A-Za-z]")
BAD_GLYPH_RE = re.compile("[-�]")
GATE_RULES = [
    "ends in terminal punctuation (. ! or ?, optionally followed by a closing quote, parenthesis or bracket)",
    "has no running header 'NASA-STD-3001, VOLUME' (upper case)",
    "has no numbered heading inside it, such as '] 7.1.2.3 Food ...'",
    "has no private-use glyph (U+E000 to U+F8FF) and no U+FFFD replacement character",
    "occurs, with all whitespace removed, in the text of its PDF page (or that page and the next)",
]


def gate(entry: dict) -> list[str]:
    """Reasons an entry may not be shown; an empty list means it passes."""
    t = entry["statement"].strip()
    reasons = []
    if not TERMINAL_RE.search(t):
        reasons.append("does not end in terminal punctuation")
    if RUNNING_HEADER in t:
        reasons.append("contains the running header 'NASA-STD-3001, VOLUME'")
    m = HEADING_RE.search(t)
    if m:
        reasons.append(f"contains the numbered heading {m.group(1)}")
    g = BAD_GLYPH_RE.search(t)
    if g:
        reasons.append(f"contains the glyph U+{ord(g.group()):04X}")
    if not (entry.get("page_check") or {}).get("ok"):
        reasons.append("not found on its PDF page")
    return reasons


# ------------------------------------------------------------------ inputs
def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def load_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def frozen_ids() -> set[str]:
    """The 57 requirements the NASA snapshots freeze and verify (20 from Vol 1, 37 from Vol 2)."""
    ids = set()
    for name in ("std_vol1_requirements", "std_vol2_requirements"):
        for r in load_json(SNAPSHOTS / f"{name}.json")["data"]["requirements"]:
            if r.get("found", True):
                ids.add(r["id"].strip("[]"))
    return ids


# web/src/features/data/buildNotes.tsx BUILD_NOTE: caveats the gap section does not show in running text.
BUILD_NOTE_RE = re.compile(r"\bPLANO\b|\b(?:LANDFALL|project) plan\b|\bthe plan(?:'s|’s)?\b|\bbuild machine\b"
                           r"|\bfrom memory\b|\bproject preparation\b", re.I)
REQ_REF_RE = re.compile(r"\[(V[12] \d{4,5})\]")


def named_by_us() -> dict[str, set[str]]:
    """IDs the app already names beside each claim, before any model ran.

    Band negatives: hardware/sensor-map.json negatives[].nearest. The alert-number gap: what
    #/method?s=gap already quotes, i.e. the requirement IDs of the meta.json principle
    no_nasa_alert_thresholds, plus the IDs cited in the volume readings it shows (GapSection.tsx: the
    first caveat of each standard's snapshot that mentions 'alert threshold' and is not a build note).
    """
    out = {n["id"]: set(n.get("nearest") or []) for n in load_json(SENSOR_MAP)["negatives"]}
    principle = next(p for p in load_json(META)["principles"] if p["id"] == "no_nasa_alert_thresholds")
    gap = set(principle["requirement_ids"])
    for name in ("std_vol1_requirements", "std_vol2_requirements"):
        caveats = load_json(SNAPSHOTS / f"{name}.json")["caveats"]
        reading = next((c for c in caveats if re.search("alert threshold", c, re.I) and not BUILD_NOTE_RE.search(c)), "")
        gap |= set(REQ_REF_RE.findall(reading))
    out["alert_number"] = gap
    return out


def reviewed() -> list[dict]:
    """Verdicts from review.json, if the reviewer has written it: [{id, verdict, claim_id?, ...}]."""
    if not REVIEW.exists():
        return []
    data = load_json(REVIEW)
    return data["passages"] if isinstance(data, dict) else data


def review_reason(verdicts: list[dict], claim_id: str, rid: str) -> str | None:
    for v in verdicts:
        if v["id"] == rid and v.get("claim_id") in (None, claim_id) and v["verdict"] != "ok":
            note = f": {v['note']}" if v.get("note") else ""
            return f"review verdict '{v['verdict']}'{note}"
    return None


def copy_verified_model(model_dir: Path, dest: Path) -> None:
    """Copy the three model files to `dest`, refusing any whose size or SHA-256 differs."""
    for name, (size, sha) in MODEL_FILES.items():
        raw = (model_dir / name).read_bytes()
        got = hashlib.sha256(raw).hexdigest()
        if len(raw) != size or got != sha:
            raise SystemExit(f"refusing {model_dir / name}: {len(raw)} B, SHA-256 {got}; expected {size} B, {sha}")
        (dest / name).write_bytes(raw)


# ------------------------------------------------------------------ ranking
def embed(model_dir: Path, texts: list[str]):
    """Unit vectors for `texts`, from the verified copy of the model (the hub is never contacted)."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    import numpy as np
    from model2vec import StaticModel

    model = StaticModel.from_pretrained(str(model_dir))
    v = np.asarray(model.encode(texts, max_length=MAX_TOKENS), dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def order_by_cosine(doc_vecs, q_vec) -> list[int]:
    import numpy as np

    return [int(i) for i in np.argsort(-(doc_vecs @ q_vec), kind="stable")]  # ties keep corpus order


def item(entry: dict, rank: int, claim_id: str, frozen: set[str], named: set[str]) -> dict:
    return {"rank": rank, "id": entry["id"], "doc": entry["doc"], "section": entry["section"],
            "title": entry["title"], "statement": entry["statement"], "pdf_page": entry["pdf_page"],
            "pdf_url": entry["pdf_url"], "frozen": entry["id"] in frozen, "also_named_by_us": entry["id"] in named}


def walk(order: list[int], reqs: list[dict], claim_id: str, depth: int, verdicts: list[dict],
         frozen: set[str], named: set[str]) -> tuple[list[dict], list[dict]]:
    items, skipped = [], []
    for pos, i in enumerate(order, start=1):
        if len(items) == depth:
            break
        e = reqs[i]
        reasons = gate(e)
        rv = review_reason(verdicts, claim_id, e["id"])
        if rv:
            reasons.append(rv)
        if reasons:
            skipped.append({"id": e["id"], "position": pos, "reason": "; ".join(reasons)})
        else:
            items.append(item(e, len(items) + 1, claim_id, frozen, named))
    return items, skipped


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Rank NASA-STD-3001 requirements for each claim (build time only).")
    ap.add_argument("model_dir", type=Path)
    ap.add_argument("corpus", type=Path)
    ap.add_argument("--check", action="store_true", help="compare with nearest.json instead of writing it")
    ap.add_argument("--review-out", type=Path, help="also write the first eight passing passages per claim")
    args = ap.parse_args(argv)

    for p, want in ((QUERIES, QUERIES_SHA256), (LABELS, LABELS_SHA256)):
        if sha256_file(p) != want:
            raise SystemExit(f"{p.name} changed since its SHA-256 was recorded before the first run; log a new run")
    queries = load_json(QUERIES)["queries"]
    labels = load_json(LABELS)
    corpus_raw = args.corpus.read_bytes()
    corpus = json.loads(corpus_raw)
    reqs = corpus["requirements"]
    frozen, named, verdicts = frozen_ids(), named_by_us(), reviewed()
    if len(frozen) != 57:
        raise SystemExit(f"expected 57 frozen requirements in the snapshots, found {len(frozen)}")
    if not frozen <= {r["id"] for r in reqs}:
        raise SystemExit("a frozen requirement is missing from the corpus")

    qs = [q["query"] for q in queries]
    questions = labels["agent_written_questions"]["items"]
    with tempfile.TemporaryDirectory(prefix="lf-potion8m-") as tmp:
        copy_verified_model(args.model_dir, Path(tmp))
        vecs = embed(Path(tmp), [f"{r['title']}. {r['statement']}" for r in reqs] + qs + [x["q"] for x in questions])
    docs, qv = vecs[: len(reqs)], vecs[len(reqs):]
    ids = [r["id"] for r in reqs]

    claims, review = [], []
    position: dict[str, dict[str, int]] = {}
    for q, v in zip(queries, qv[: len(qs)]):
        order = order_by_cosine(docs, v)
        position[q["claim_id"]] = {ids[i]: pos for pos, i in enumerate(order, start=1)}
        named_here = named.get(q["claim_id"], set())
        items, skipped = walk(order, reqs, q["claim_id"], SHOWN, verdicts, frozen, named_here)
        claims.append({"claim_id": q["claim_id"], "query": q["query"], "model": MODEL_ID, "revision": REVISION,
                       "sha256": MODEL_SHA256, "corpus_size": len(reqs), "items": items, "skipped": skipped})
        more, more_skipped = walk(order, reqs, q["claim_id"], REVIEW_DEPTH, verdicts, frozen, named_here)
        review.append({"claim_id": q["claim_id"], "query": q["query"],
                       "passages": [{"claim_id": q["claim_id"], **p} for p in more], "skipped": more_skipped})

    # Labelled check: where is each hand-named requirement in the model's ranking (1 = closest)?
    hand = []
    for c in labels["hand_named"]["claims"]:
        for rid in c["ids"]:
            shown = any(it["id"] == rid for cl in claims if cl["claim_id"] == c["claim_id"] for it in cl["items"])
            hand.append({"claim_id": c["claim_id"], "id": rid, "model_rank": position[c["claim_id"]][rid],
                         "shown": shown})
    context = [{"claim_id": c["claim_id"], "id": rid, "model_rank": position[c["claim_id"]][rid]}
               for c in labels["hand_named"]["context_not_counted"] for rid in c["ids"]]
    hits = {1: 0, 3: 0, 5: 0}
    for x, v in zip(questions, qv[len(qs):]):
        top = [ids[i] for i in order_by_cosine(docs, v)[:5]]
        for k in hits:
            hits[k] += any(t in x["ids"] for t in top[:k])
    in_top5 = sum(1 for h in hand if h["model_rank"] <= 5)

    out = {
        "schema": SCHEMA,
        "note": "LANDFALL-authored build output, not a NASA snapshot. NASA-STD-3001 statements, verbatim, "
                "ranked at build time by a model for closeness in meaning to one sentence we wrote per claim. "
                "A ranking, not proof of absence: the keyword count stays the claim. No similarity score is stored.",
        "generated_by": "tools/nearest/rank.py",
        "queries_sha256": QUERIES_SHA256,
        "labels_sha256": LABELS_SHA256,
        "corpus_sha256": hashlib.sha256(corpus_raw).hexdigest(),
        "corpus": [{k: s[k] for k in ("doc", "pdf_url", "sha256", "count")} for s in corpus["sources"]],
        "input": "title + '. ' + statement, truncated at 512 tokens; ranked by cosine similarity",
        "gate": GATE_RULES,
        "labelled_check": {"in_top_five": in_top5, "of": len(hand), "items": hand, "context_not_counted": context},
        "agent_written_check": {"questions": len(questions), "top_five": hits[5], "top_three": hits[3],
                                "top_one": hits[1],
                                "note": "Questions and expected IDs written by an agent, not by crew: optimistic."},
        "claims": claims,
    }

    if args.check:
        old = load_json(OUT)
        if old == out:
            print("rebuild is identical to nearest.json")
            return 0
        for k in out:
            if old.get(k) != out[k]:
                print(f"REBUILD DIFFERS from nearest.json in {k!r}")
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if args.review_out:
        args.review_out.parent.mkdir(parents=True, exist_ok=True)
        args.review_out.write_text(json.dumps(
            {"note": f"First {REVIEW_DEPTH} passages per claim that pass the gate; nearest.json shows the first "
                     f"{SHOWN}. Read each non-frozen statement against its PDF page.", "claims": review},
            ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    for c in claims:
        print(f"{c['claim_id']}: " + ", ".join(i["id"] for i in c["items"])
              + (f" | skipped {', '.join(s['id'] for s in c['skipped'])}" if c["skipped"] else ""))
    print(f"labelled check: {in_top5} of {len(hand)} in the model's top five: "
          + ", ".join(f"{h['id']} ({h['claim_id']}) {h['model_rank']}" for h in hand))
    print("not counted: " + ", ".join(f"{h['id']} ({h['claim_id']}) {h['model_rank']}" for h in context))
    print(f"agent-written questions: top five {hits[5]}/{len(questions)}, top three {hits[3]}/{len(questions)}, "
          f"top one {hits[1]}/{len(questions)}")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
