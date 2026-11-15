"""Freeze the reference token IDs and vectors that the TypeScript search must reproduce (#/method?s=find).

Writes, in <fixtures_dir> (test-only, never shipped):

    tokens.json    every parity string with its Hugging Face tokenizers IDs (add_special_tokens=False, no truncation)
    vectors.json   the int8 reference vectors of the 57 passages and of sample queries, each query's top 5, and the
                   cosine of every int8 passage vector against fp32 model2vec

The encode contract is written in tools/find/README.md. The reference here takes its IDs from Hugging Face
tokenizers 0.23.3 (the ground truth the hand-written TypeScript WordPiece is tested against) and its rows from the
8-bit files quantize.py wrote, and sums in float64 in the same order as web/src/features/find/embed.ts.

Run in an isolated environment, never in the project's (nothing here is a project dependency):

    uv run --isolated --no-project --with tokenizers==0.23.3 --with numpy --with safetensors --with model2vec==0.10.0 \\
      python -I tools/find/make_vectors.py /tmp/lf-models/potion8m web/public/assets/models/potion-base-8M-bf8b0566 \\
      web/public/data web/src/features/find/fixtures [web/src/features/find/gold.json]
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import random
import struct
import sys
from pathlib import Path

DIM = 256
MAX_TOKENS = 512
MODEL_SHA = "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2"
TOKENIZER_SHA = "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50"
HERE = Path(__file__).resolve().parent
# Queries whose vectors and top 5 are frozen as well as their IDs (the example chips first).
VECTOR_QUERIES = 40


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def passages(data_dir: Path) -> list[dict]:
    """The frozen requirements, Vol 1 then Vol 2 in file order, first occurrence of each ID (as passages.ts)."""
    out: list[dict] = []
    seen: set[str] = set()
    v1 = json.loads((data_dir / "std_vol1_requirements.json").read_text(encoding="utf-8"))["data"]["requirements"]
    v2 = json.loads((data_dir / "std_vol2_requirements.json").read_text(encoding="utf-8"))["data"]["requirements"]
    for r in v1:
        rid = r["id"].strip("[]")
        if rid not in seen:
            seen.add(rid)
            out.append({"id": rid, "title": r["section_title"], "text": r["text"], "rationale": r.get("rationale")})
    for r in v2:
        rid = r["id"].strip("[]")
        if rid not in seen:
            seen.add(rid)
            out.append({"id": rid, "title": r["title"], "text": r["text"], "rationale": r.get("rationale")})
    for p in out:
        p["passage"] = " ".join(x for x in (p["title"], p["text"], p["rationale"]) if x)
    return out


def typo(rng: random.Random, s: str) -> str:
    """One deterministic keyboard slip: swap, drop, double, replace or split."""
    letters = [i for i, c in enumerate(s) if c.isalpha()]
    if len(letters) < 2:
        return s + "s"
    i = rng.choice(letters[:-1])
    op = rng.randrange(5)
    if op == 0:
        return s[:i] + s[i + 1] + s[i] + s[i + 2 :]
    if op == 1:
        return s[:i] + s[i + 1 :]
    if op == 2:
        return s[:i] + s[i] + s[i:]
    if op == 3:
        return s[:i] + rng.choice("qwertyuiopasdfghjklzxcvbnm") + s[i + 1 :]
    return s[:i] + " " + s[i:]


class Int8Model:
    """The shipped 8-bit files, read with the standard library."""

    def __init__(self, assets: Path) -> None:
        self.q = (assets / "embeddings.i8").read_bytes()
        raw = (assets / "scales.f32").read_bytes()
        self.scales = struct.unpack(f"<{len(raw) // 4}f", raw)
        self.tokens = (assets / "vocab.txt").read_text(encoding="utf-8").split("\n")[:-1]
        self.unk = self.tokens.index("[UNK]")
        lengths = sorted(len(t) for t in self.tokens)
        n = len(lengths)
        # model2vec: int(np.median([len(token) for token in tokens])), the per-token character budget of its cap.
        self.median_token_length = int((lengths[n // 2 - 1] + lengths[n // 2]) / 2 if n % 2 == 0 else lengths[n // 2])
        self.char_cap = MAX_TOKENS * self.median_token_length

    def row(self, i: int) -> list[float]:
        s = self.scales[i]
        base = i * DIM
        return [(b - 256 if b > 127 else b) * s for b in self.q[base : base + DIM]]

    def embed_ids(self, ids: list[int]) -> list[float]:
        ids = [i for i in ids[:MAX_TOKENS] if i != self.unk]
        acc = [0.0] * DIM
        for i in ids:
            r = self.row(i)
            for d in range(DIM):
                acc[d] += r[d]
        if not ids:
            return acc
        n = len(ids)
        v = [x / n for x in acc]
        ss = 0.0
        for x in v:
            ss += x * x
        norm = math.sqrt(ss)
        return [x / norm for x in v] if norm > 0 else v


def b64(v: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(v)}d", *v)).decode("ascii")


def dot(a: list[float], b: list[float]) -> float:
    s = 0.0
    for x, y in zip(a, b):
        s += x * y
    return s


def top(qv: list[float], pv: list[list[float]], ids: list[str], k: int = 5) -> list[str]:
    scored = [(dot(qv, p), -i) for i, p in enumerate(pv)]
    scored.sort(reverse=True)  # score descending, then passage order
    return [ids[-j] for _, j in scored[:k]]


def main(argv: list[str]) -> int:
    if len(argv) not in (5, 6):
        print(__doc__, file=sys.stderr)
        return 2
    model_dir, assets, data_dir, fixtures = (Path(a) for a in argv[1:5])
    gold_path = Path(argv[5]) if len(argv) == 6 else None
    if sha256(model_dir / "model.safetensors") != MODEL_SHA or sha256(model_dir / "tokenizer.json") != TOKENIZER_SHA:
        raise SystemExit("model files do not match the pinned revision; refusing to read them")

    from tokenizers import Tokenizer  # build-time only (Apache-2.0)

    tok = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
    tok.no_truncation()
    tok.no_padding()
    m8 = Int8Model(assets)

    corpus = passages(data_dir)
    strings = json.loads((HERE / "strings.json").read_text(encoding="utf-8"))
    queries: list[str] = strings["queries"]
    rng = random.Random(20261115)
    noisy = [typo(rng, q) for q in queries if q.strip()][:150]
    gold_queries: list[str] = []
    if gold_path is not None:
        gold = json.loads(gold_path.read_text(encoding="utf-8"))
        items = gold["queries"] if isinstance(gold, dict) else gold
        gold_queries = [g["q"] if "q" in g else g["query"] for g in items]

    groups = {
        "passage": [p["passage"] for p in corpus],
        "query": queries,
        "typo": noisy,
        "unicode": strings["unicode"],
        "gold": gold_queries,
    }
    token_rows = []
    for kind, items in groups.items():
        for s in items:
            token_rows.append({"kind": kind, "s": s, "ids": tok.encode(s, add_special_tokens=False).ids})

    def ids_for(s: str) -> list[int]:
        return tok.encode(s[: m8.char_cap], add_special_tokens=False).ids

    pv = [m8.embed_ids(ids_for(p["passage"])) for p in corpus]
    pids = [p["id"] for p in corpus]
    vec_queries = list(dict.fromkeys([q for q in queries if q.strip()][:VECTOR_QUERIES] + gold_queries))
    qrows = []
    for q in vec_queries:
        qv = m8.embed_ids(ids_for(q))
        qrows.append({"q": q, "v": b64(qv), "top5": top(qv, pv, pids)})

    # fp32 cross-check: the same passages through model2vec 0.10.0 itself.
    import numpy as np
    from model2vec import StaticModel

    m32 = StaticModel.from_pretrained(str(model_dir))
    e32 = m32.encode([p["passage"] for p in corpus])
    cos = []
    for i, p in enumerate(corpus):
        a = np.asarray(pv[i], dtype=np.float64)
        b = e32[i].astype(np.float64)
        cos.append(float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b))))
    tokens_agree = all(
        m32.tokenize([p["passage"][: m8.char_cap]])[0][:MAX_TOKENS] == [i for i in ids_for(p["passage"])[:MAX_TOKENS] if i != m8.unk]
        for p in corpus
    )

    fixtures.mkdir(parents=True, exist_ok=True)
    (fixtures / "tokens.json").write_text(
        json.dumps(
            {
                "tokenizer": "Hugging Face tokenizers 0.23.3, encode(s, add_special_tokens=False), no truncation",
                "tokenizer_sha256": TOKENIZER_SHA,
                "counts": {k: len(v) for k, v in groups.items()},
                "strings": token_rows,
            },
            ensure_ascii=False,
            indent=0,
        )
        + "\n",
        encoding="utf-8",
    )
    (fixtures / "vectors.json").write_text(
        json.dumps(
            {
                "contract": "tools/find/README.md",
                "dim": DIM,
                "max_tokens": MAX_TOKENS,
                "unk_id": m8.unk,
                "median_token_length": m8.median_token_length,
                "char_cap": m8.char_cap,
                "passage_ids": pids,
                "passage_tokens": [len(ids_for(p["passage"])) for p in corpus],
                "passages": [b64(v) for v in pv],
                "queries": qrows,
                "fp32": {
                    "reference": "model2vec 0.10.0 StaticModel.encode, fp32, same model files",
                    "tokens_agree": tokens_agree,
                    "cosine": cos,
                    "min_cosine": min(cos),
                },
            },
            ensure_ascii=False,
            indent=0,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"strings {len(token_rows)} {dict((k, len(v)) for k, v in groups.items())}")
    print(f"unk_id {m8.unk} median_token_length {m8.median_token_length} char_cap {m8.char_cap}")
    print(f"passage tokens max {max(len(ids_for(p['passage'])) for p in corpus)}; over {MAX_TOKENS}: "
          f"{sum(len(ids_for(p['passage'])) > MAX_TOKENS for p in corpus)}")
    print(f"fp32 cosine min {min(cos):.6f} mean {sum(cos) / len(cos):.6f}; model2vec tokens agree: {tokens_agree}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
