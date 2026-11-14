"""Shared contract for every LANDFALL ingest adapter.

Every adapter is one module in this package that exposes:

    ADAPTER_ID: str                          # e.g. "osdr"; unique
    def run(ctx: RunContext) -> list[dict]   # fetch + normalise -> list of snapshots

`python -m ingest --all` discovers adapters automatically (any module in this
package with both ADAPTER_ID and run), so adapters never edit a shared registry.

Every snapshot an adapter returns has the SAME top-level shape, checked by
`validate_snapshot`. The front end reads one schema regardless of the source;
only `data` is source-specific. Snapshots are frozen at build time into
web/public/data/<snapshot id>.json and committed: the judged URL never needs
a backend or a third-party API to be awake.

Snapshot shape (schema "landfall.snapshot/1"):

    {
      "schema": "landfall.snapshot/1",
      "id": "osdr_cmp",                 # [a-z0-9_]+ ; also the output file stem
      "adapter": "osdr",                # ADAPTER_ID that produced it
      "title": "Human-readable title",
      "source": {
        "publisher": "NASA OSDR",       # who publishes the data
        "name": "OSD-575 ...",          # dataset / page / document name
        "url": "https://...",           # human landing page a judge can open
        "access_urls": ["https://..."], # exact URLs fetched
        "license": "...",               # license / terms as stated by the publisher
        "citation": "Full citation string for CITATIONS.md"
      },
      "retrieved_at": "2026-11-14T13:00:00Z",
      "coverage": {"start": iso|None, "stop": iso|None, "cadence": "PT60S"|None},
      "freshness": {"kind": "live"|"historical"|"prediction"|"reference",
                    "stale_after": "PT6H"|None},   # drives the [V2 10020] stale chip
      "provenance": "measured"|"predicted"|"reference"|"simulated"|"derived",
      "caveats": ["Honest limits a judge would otherwise discover"],
      "data": {...}                     # source-specific payload
    }
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = "landfall.snapshot/1"
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "web" / "public" / "data"
DEFAULT_CACHE_DIR = REPO_ROOT / ".cache" / "ingest"

# Generic client identity. Never put personal data (names, emails) here.
USER_AGENT = "landfall-ingest/0.1 (NASA Space Apps 2026 hackathon project)"

FRESHNESS_KINDS = {"live", "historical", "prediction", "reference"}
PROVENANCE_KINDS = {"measured", "predicted", "reference", "simulated", "derived"}
_ID_RE = re.compile(r"^[a-z0-9_]+$")
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_iso_z(dt: datetime) -> str:
    """Render an aware or naive-UTC datetime as 'YYYY-MM-DDTHH:MM:SSZ'."""
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.replace(microsecond=0).isoformat() + "Z"


@dataclass
class RunContext:
    out_dir: Path = DEFAULT_OUT_DIR
    cache_dir: Path = DEFAULT_CACHE_DIR
    offline: bool = False          # True: serve only from cache, never touch the network
    retrieved_at: str = field(default_factory=utc_now_iso)
    timeout: float = 60.0

    def __post_init__(self) -> None:
        self.out_dir = Path(self.out_dir)
        self.cache_dir = Path(self.cache_dir)

    # ---- HTTP with an on-disk cache, so `--offline` reproduces a run exactly ----
    def _cache_path(self, url: str, params: dict | None) -> Path:
        key = url + ("?" + json.dumps(params, sort_keys=True) if params else "")
        digest = hashlib.sha256(key.encode()).hexdigest()[:24]
        return self.cache_dir / digest

    def fetch_bytes(self, url: str, params: dict | None = None, *, retries: int = 3,
                    use_cache: bool = True, headers: dict | None = None) -> bytes:
        path = self._cache_path(url, params)
        if use_cache and path.exists() and (self.offline or path.stat().st_size > 0):
            if self.offline or _cache_is_fresh(path):
                return path.read_bytes()
        if self.offline:
            raise RuntimeError(f"offline and not cached: {url}")
        import httpx  # imported lazily so engine/tests never need it

        last: Exception | None = None
        for attempt in range(retries):
            try:
                # Force IPv4: on this build machine some GSFC hosts accept TCP over IPv6 and
                # then hang in the TLS handshake (found by the hapi adapter's verifier).
                transport = httpx.HTTPTransport(local_address="0.0.0.0")
                with httpx.Client(transport=transport, timeout=self.timeout, follow_redirects=True,
                                  headers={"User-Agent": USER_AGENT, **(headers or {})}) as client:
                    r = client.get(url, params=params)
                r.raise_for_status()
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                path.write_bytes(r.content)
                (path.with_suffix(".url")).write_text(str(r.url))
                return r.content
            except Exception as exc:  # noqa: BLE001 - surface the last error after retries
                last = exc
                time.sleep(1.5 * (attempt + 1))
        raise RuntimeError(f"fetch failed after {retries} attempts: {url} ({last})")

    def fetch_text(self, url: str, params: dict | None = None, **kw: Any) -> str:
        return self.fetch_bytes(url, params, **kw).decode("utf-8", errors="replace")

    def fetch_json(self, url: str, params: dict | None = None, **kw: Any) -> Any:
        return json.loads(self.fetch_bytes(url, params, **kw))


def _cache_is_fresh(path: Path, max_age_s: float = 6 * 3600) -> bool:
    return (time.time() - path.stat().st_mtime) < max_age_s


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def make_snapshot(*, id: str, adapter: str, title: str, source: dict, retrieved_at: str,
                  coverage: dict, freshness: dict, provenance: str, caveats: list[str],
                  data: Any) -> dict:
    snap = {
        "schema": SCHEMA, "id": id, "adapter": adapter, "title": title, "source": source,
        "retrieved_at": retrieved_at, "coverage": coverage, "freshness": freshness,
        "provenance": provenance, "caveats": caveats, "data": data,
    }
    validate_snapshot(snap)
    return snap


def validate_snapshot(s: dict) -> None:
    """Raise ValueError listing every contract violation (not just the first)."""
    errs: list[str] = []

    def need(cond: bool, msg: str) -> None:
        if not cond:
            errs.append(msg)

    need(isinstance(s, dict), "snapshot must be an object")
    if not isinstance(s, dict):
        raise ValueError("; ".join(errs))
    need(s.get("schema") == SCHEMA, f"schema must be {SCHEMA!r}")
    need(isinstance(s.get("id"), str) and bool(_ID_RE.match(s.get("id", ""))), "id must match [a-z0-9_]+")
    need(isinstance(s.get("adapter"), str) and bool(s.get("adapter")), "adapter required")
    need(isinstance(s.get("title"), str) and bool(s.get("title")), "title required")
    src = s.get("source") or {}
    for k in ("publisher", "name", "url", "license", "citation"):
        need(isinstance(src.get(k), str) and bool(src.get(k)), f"source.{k} required (non-empty string)")
    need(isinstance(src.get("access_urls"), list) and len(src.get("access_urls", [])) > 0,
         "source.access_urls must be a non-empty list")
    need(isinstance(s.get("retrieved_at"), str) and bool(_ISO_RE.match(s.get("retrieved_at", ""))),
         "retrieved_at must be ISO-8601 UTC ending in Z")
    cov = s.get("coverage")
    need(isinstance(cov, dict) and {"start", "stop", "cadence"} <= set(cov or {}),
         "coverage must have start, stop, cadence (null allowed)")
    for k in ("start", "stop"):
        v = (cov or {}).get(k)
        need(v is None or (isinstance(v, str) and bool(_ISO_RE.match(v))), f"coverage.{k} must be ISO Z or null")
    fr = s.get("freshness") or {}
    need(fr.get("kind") in FRESHNESS_KINDS, f"freshness.kind must be one of {sorted(FRESHNESS_KINDS)}")
    need("stale_after" in fr, "freshness.stale_after required (null allowed)")
    need(s.get("provenance") in PROVENANCE_KINDS, f"provenance must be one of {sorted(PROVENANCE_KINDS)}")
    need(isinstance(s.get("caveats"), list) and all(isinstance(c, str) for c in s.get("caveats", [])),
         "caveats must be a list of strings")
    need("data" in s and s["data"] not in (None, {}, []), "data must be present and non-empty")
    if errs:
        raise ValueError(f"snapshot {s.get('id')!r} violates contract: " + "; ".join(errs))


def write_snapshot(snap: dict, out_dir: Path = DEFAULT_OUT_DIR) -> Path:
    validate_snapshot(snap)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{snap['id']}.json"
    # Compact separators: these files ship inside the judged static build.
    path.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")) + "\n")
    return path


def write_manifest(out_dir: Path = DEFAULT_OUT_DIR) -> Path:
    """Rebuild manifest.json by scanning out_dir, so it is always consistent with the files."""
    out_dir = Path(out_dir)
    entries = []
    for p in sorted(out_dir.glob("*.json")):
        if p.name == "manifest.json":
            continue
        raw = p.read_bytes()
        try:
            s = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(s, dict) or s.get("schema") != SCHEMA:
            continue
        entries.append({
            "id": s["id"], "adapter": s["adapter"], "title": s["title"], "file": p.name,
            "bytes": len(raw), "sha256": sha256_hex(raw), "retrieved_at": s["retrieved_at"],
            "provenance": s["provenance"], "freshness": s["freshness"], "coverage": s["coverage"],
            "publisher": s["source"]["publisher"], "url": s["source"]["url"],
        })
    path = out_dir / "manifest.json"
    path.write_text(json.dumps({"schema": "landfall.manifest/1", "snapshots": entries},
                               ensure_ascii=False, indent=1) + "\n")
    return path
