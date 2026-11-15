"""Quantise minishlab/potion-base-8M to the 8-bit copy LANDFALL ships for #/method?s=find.

Standard library only. The fp32 table (model.safetensors, 30,236,760 B) is over Cloudflare's 25 MiB per-file
limit, so each row is stored as int8 with one float32 scale:

    scale = max|row| / 127 (rounded to float32)     q = floor(x / scale + 0.5), clipped to -127..127

and the browser reads q * scale. The source files are checked against their SHA-256 first and read as data
(run with python -I). Outputs, in <out_dir>:

    embeddings.i8   rows x 256 int8, row-major
    scales.f32      rows float32, little-endian
    vocab.txt       the tokenizer's tokens in ID order, one per line
    SOURCE.md       revision, source and output SHA-256s, and this command

Usage: python -I tools/find/quantize.py <model_dir> <out_dir>
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
from array import array
from pathlib import Path

REPO = "minishlab/potion-base-8M"
REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"
SOURCES = {
    "model.safetensors": (30_236_760, "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2"),
    "tokenizer.json": (683_666, "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50"),
}
ROWS, DIM = 29_528, 256


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def f32(x: float) -> float:
    """x rounded to the nearest float32, as a Python float."""
    return struct.unpack("<f", struct.pack("<f", x))[0]


def read_embeddings(path: Path) -> array:
    raw = path.read_bytes()
    (n,) = struct.unpack("<Q", raw[:8])
    header = json.loads(raw[8 : 8 + n])
    tensors = {k: v for k, v in header.items() if k != "__metadata__"}
    if list(tensors) != ["embeddings"]:
        raise SystemExit(f"expected one tensor 'embeddings', found {list(tensors)}")
    t = tensors["embeddings"]
    if t["dtype"] != "F32" or t["shape"] != [ROWS, DIM]:
        raise SystemExit(f"unexpected tensor {t['dtype']} {t['shape']}")
    start, end = t["data_offsets"]
    body = raw[8 + n + start : 8 + n + end]
    if len(body) != ROWS * DIM * 4:
        raise SystemExit("truncated tensor data")
    values = array("f")
    values.frombytes(body)
    if sys.byteorder != "little":
        values.byteswap()
    return values


def quantize(values: array) -> tuple[bytes, bytes]:
    q_out = bytearray(ROWS * DIM)
    scales = array("f", [0.0]) * ROWS
    for r in range(ROWS):
        row = values[r * DIM : (r + 1) * DIM]
        peak = max(abs(x) for x in row)
        scale = f32(peak / 127) if peak > 0 else 0.0
        scales[r] = scale
        base = r * DIM
        for d, x in enumerate(row):
            q = 0 if scale == 0 else math.floor(x / scale + 0.5)
            q = max(-127, min(127, q))
            q_out[base + d] = q & 0xFF
    if sys.byteorder != "little":
        scales.byteswap()
    return bytes(q_out), scales.tobytes()


def vocab_lines(tokenizer: Path) -> bytes:
    tok = json.loads(tokenizer.read_text(encoding="utf-8"))
    model = tok["model"]
    if model.get("type") != "WordPiece":
        raise SystemExit(f"expected a WordPiece model, found {model.get('type')}")
    by_id = sorted(model["vocab"].items(), key=lambda kv: kv[1])
    if [i for _, i in by_id] != list(range(ROWS)):
        raise SystemExit("vocabulary IDs are not 0..rows-1")
    for token, _ in by_id:
        if not token or any(c in token for c in "\n\r"):
            raise SystemExit(f"token {token!r} cannot be written one per line")
    return ("\n".join(t for t, _ in by_id) + "\n").encode("utf-8")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    src, out = Path(argv[1]), Path(argv[2])
    for name, (size, digest) in SOURCES.items():
        p = src / name
        if p.stat().st_size != size or sha256(p) != digest:
            raise SystemExit(f"{p}: size or SHA-256 does not match the pinned revision; refusing to read it")
    out.mkdir(parents=True, exist_ok=True)
    q, scales = quantize(read_embeddings(src / "model.safetensors"))
    files = {"embeddings.i8": q, "scales.f32": scales, "vocab.txt": vocab_lines(src / "tokenizer.json")}
    for name, body in files.items():
        (out / name).write_bytes(body)
    rows = [f"| `{n}` | {len(b):,} | `{hashlib.sha256(b).hexdigest()}` |" for n, b in files.items()]
    source_rows = [f"| `{n}` | {s:,} | `{d}` |" for n, (s, d) in SOURCES.items()]
    (out / "SOURCE.md").write_text(
        "\n".join(
            [
                "# potion-base-8M, 8-bit copy",
                "",
                f"Source: [{REPO}](https://huggingface.co/{REPO}), revision `{REVISION}`, MIT licence (model card",
                "metadata `license: mit`; see LICENSE.txt). Base model BAAI/bge-base-en-v1.5 (MIT). Training set",
                "minishlab/tokenlearn-c4-en-bge-base-v1.5: its licence was not verified.",
                "",
                "Source files (checked before reading):",
                "",
                "| file | bytes | SHA-256 |",
                "| --- | ---: | --- |",
                *source_rows,
                "",
                "Outputs:",
                "",
                "| file | bytes | SHA-256 |",
                "| --- | ---: | --- |",
                *rows,
                "",
                "Per row: scale = max|row| / 127 (stored as float32); q = floor(x / scale + 0.5), clipped to -127..127.",
                "The browser reads q * scale. `vocab.txt` holds the tokenizer's WordPiece tokens in ID order, one per line.",
                "",
                "Command (standard library only):",
                "",
                "    python -I tools/find/quantize.py <model_dir> web/public/assets/models/potion-base-8M-bf8b0566",
                "",
            ]
        ),
        encoding="utf-8",
    )
    for r in rows:
        print(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
