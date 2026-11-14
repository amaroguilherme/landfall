"""`python -m ingest --all` reproduces web/public/data/*.json from scratch.

    uv run python -m ingest --all              # every adapter
    uv run python -m ingest osdr swpc          # just these adapters
    uv run python -m ingest --all --offline    # replay from .cache/ingest, no network
"""

from __future__ import annotations

import argparse
import importlib
import pkgutil
import sys
import traceback

import ingest
from ingest.common import RunContext, write_manifest, write_snapshot


def discover() -> dict:
    found = {}
    for mod in pkgutil.iter_modules(ingest.__path__):
        if mod.name.startswith("_") or mod.name in {"common", "tests"}:
            continue
        m = importlib.import_module(f"ingest.{mod.name}")
        if hasattr(m, "ADAPTER_ID") and callable(getattr(m, "run", None)):
            found[m.ADAPTER_ID] = m
    return found


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ingest")
    ap.add_argument("adapters", nargs="*", help="adapter ids to run")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--offline", action="store_true", help="serve only from the on-disk cache")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args(argv)

    registry = discover()
    if args.list:
        print("\n".join(sorted(registry)))
        return 0
    wanted = sorted(registry) if args.all else args.adapters
    unknown = [a for a in wanted if a not in registry]
    if unknown or not wanted:
        ap.error(f"unknown or missing adapters: {unknown or '(none given)'}; known: {sorted(registry)}")

    ctx = RunContext(offline=args.offline)
    failures = 0
    for aid in wanted:
        try:
            snaps = registry[aid].run(ctx)
            for s in snaps:
                p = write_snapshot(s, ctx.out_dir)
                print(f"[ok] {aid:>12} -> {p.relative_to(ctx.out_dir.parent.parent.parent)}"
                      f" ({p.stat().st_size:,} B)")
        except Exception:  # noqa: BLE001 - one failing source must not block the others
            failures += 1
            print(f"[FAIL] {aid}", file=sys.stderr)
            traceback.print_exc()
    write_manifest(ctx.out_dir)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
