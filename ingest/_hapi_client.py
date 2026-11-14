"""Minimal HAPI (Heliophysics Application Programmer's Interface) client for the `hapi` adapter.

Spec: https://github.com/hapi-server/data-specification (HAPI 2.0 / 3.x). Endpoints used:
/catalog, /info?id=, /data?id=&time.min=&time.max=&parameters=&format=csv.

Pitfalls handled here (each one has a known-answer test in ingest/tests/test_hapi.py):
  1. Day-of-year timestamps (SSCWeb: '2026-261T00:00:00Z') -> parse_hapi_time().
  2. Freshness: callers read startDate/stopDate from /info before requesting data.
  3. Units are copied from /info, never assumed (Param.units).
  4. Fill values declared in /info become None (is_fill / parse_csv). iSWA declares the
     *string* "null" as its fill; CDAWeb declares "-1.0E31"; SSCWeb "1e31".
  5. A server error arrives as a HAPI JSON body (often with HTTP 400) instead of CSV; it is
     surfaced as HapiError with the HAPI status code and message, never parsed as data.
  6. /data returns columns in /info order regardless of request order, so requested
     parameters are sorted into /info order before the request.
  7. Some servers cap one request's time span (iSWA: 31 days) -> data_chunked().

Network note: from the build machine used on 2026-11-14, every *.gsfc.nasa.gov host
accepts a TCP connection over IPv6 and then hangs in the TLS handshake, while IPv4 works
(verified with curl and httpx). RunContext.fetch_bytes() uses a default httpx client, so
it times out there. fetch_bytes_ipv4() below forces IPv4 and *reuses RunContext's own
on-disk cache layout*, so `python -m ingest hapi --offline` replays these fetches exactly.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from ingest.common import USER_AGENT, RunContext, to_iso_z

try:  # private helper of the shared contract; degrade gracefully if it is renamed
    from ingest.common import _cache_is_fresh  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover
    def _cache_is_fresh(path, max_age_s: float = 6 * 3600) -> bool:  # type: ignore[no-redef]
        return (time.time() - path.stat().st_mtime) < max_age_s


class HapiError(RuntimeError):
    """A HAPI server answered with a HAPI status other than 1200 OK."""

    def __init__(self, code: int | None, message: str, url: str = "") -> None:
        super().__init__(f"HAPI {code}: {message} ({url})")
        self.code = code
        self.message = message
        self.url = url


# --------------------------------------------------------------------------------------
# Pitfall 1: HAPI time strings
# --------------------------------------------------------------------------------------
_TIME_RE = re.compile(
    r"^(?P<y>\d{4})-(?:(?P<doy>\d{3})|(?P<mo>\d{2})-(?P<d>\d{2}))"
    r"(?:T(?P<H>\d{2})(?::(?P<M>\d{2})(?::(?P<S>\d{2})(?:\.(?P<f>\d+))?)?)?)?Z?$"
)


def parse_hapi_time(s: str) -> datetime:
    """Parse any HAPI restricted-ISO-8601 time into an aware UTC datetime.

    Accepts YYYY-DDDTHH:MM:SS(.f*)Z (day-of-year) and YYYY-MM-DDTHH:MM:SS(.f*)Z, plus the
    truncated forms the spec allows (YYYY-DDD, YYYY-MM-DDTHH, YYYY-DDDTHH:MM, ... with or
    without the trailing Z). Fractions beyond microseconds are truncated. A leap second
    (SS == 60) is mapped to the first instant of the next minute (datetime cannot hold it).
    Raises ValueError on anything else (never silently misparses).
    """
    if not isinstance(s, str):
        raise ValueError(f"HAPI time must be a string, got {type(s).__name__}")
    m = _TIME_RE.match(s.strip())
    if not m:
        raise ValueError(f"not a HAPI time: {s!r}")
    year = int(m["y"])
    if m["doy"] is not None:
        doy = int(m["doy"])
        leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
        if not 1 <= doy <= (366 if leap else 365):
            raise ValueError(f"day-of-year out of range in {s!r}")
        base = datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1)
    else:
        base = datetime(year, int(m["mo"]), int(m["d"]), tzinfo=timezone.utc)  # validates
    hh = int(m["H"] or 0)
    mm = int(m["M"] or 0)
    ss = int(m["S"] or 0)
    frac = m["f"] or ""
    if hh > 23 or mm > 59 or ss > 60:
        raise ValueError(f"time-of-day out of range in {s!r}")
    us = int((frac + "000000")[:6]) if frac else 0
    leap_second = ss == 60
    dt = base.replace(hour=hh, minute=mm, second=59 if leap_second else ss, microsecond=us)
    if leap_second:
        dt = dt.replace(microsecond=0) + timedelta(seconds=1)
    return dt


def hapi_time_to_iso(s: str) -> str:
    """'2026-261T00:00:00Z' -> '2026-09-18T00:00:00Z' (fraction truncated to whole seconds)."""
    return to_iso_z(parse_hapi_time(s))


def fmt_hapi_time(dt: datetime) -> str:
    """Render a datetime for time.min/time.max (YYYY-MM-DDTHH:MM:SSZ)."""
    return to_iso_z(dt)


# --------------------------------------------------------------------------------------
# Pitfalls 3/4: units and fills from /info
# --------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Param:
    name: str
    type: str
    units: Any
    fill: str | None
    description: str
    size: Any = None

    @classmethod
    def from_info(cls, p: dict) -> "Param":
        return cls(name=p["name"], type=p.get("type", "double"), units=p.get("units"),
                   fill=normalise_fill(p.get("fill")), description=p.get("description") or "",
                   size=p.get("size"))


def normalise_fill(fill: Any) -> str | None:
    """/info 'fill' is a string or JSON null. Keep the string exactly (iSWA uses "null")."""
    if fill is None:
        return None
    return str(fill).strip()


def is_fill(cell: str, fill: str | None) -> bool:
    """True if a CSV cell equals the declared fill. Numeric fills compare numerically, so
    '-1e+31' matches a declared '-1.0E31'. Comparison is relative (1e-9) to survive the
    server re-formatting the number."""
    if fill is None:
        return False
    c = cell.strip()
    if c == fill:
        return True
    try:
        a, b = float(c), float(fill)
    except ValueError:
        return False
    if math.isnan(b):
        return math.isnan(a)
    return a == b or abs(a - b) <= 1e-9 * max(abs(a), abs(b))


def convert_cell(cell: str, param: Param) -> Any:
    """CSV cell -> Python value, with declared fill (and empty cells) -> None."""
    c = cell.strip()
    if c == "" or is_fill(c, param.fill):
        return None
    t = param.type
    if t in ("double", "float"):
        v = float(c)
        return None if math.isnan(v) else v
    if t == "integer":
        return int(c)
    if t == "isotime":
        return to_iso_z(parse_hapi_time(c))
    return c


def check_hapi_status(body: bytes | str, url: str = "") -> None:
    """Raise HapiError if a response body is a HAPI JSON status other than 1200."""
    text = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else body
    head = text.lstrip()[:1]
    if head != "{":
        return
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        return
    st = obj.get("status") if isinstance(obj, dict) else None
    if isinstance(st, dict) and st.get("code") not in (1200, 1201):
        raise HapiError(st.get("code"), str(st.get("message")), url)


def parse_csv(text: str, params: list[Param]) -> list[list[Any]]:
    """Parse HAPI CSV for exactly these params (Time first, /info order). Rejects a JSON
    error body and any row whose width does not match."""
    check_hapi_status(text)
    for p in params:
        if p.size not in (None, [1], 1):
            raise ValueError(f"array parameter {p.name} (size={p.size}) not supported")
    rows: list[list[Any]] = []
    for i, rec in enumerate(csv.reader(io.StringIO(text))):
        if not rec or (len(rec) == 1 and rec[0].strip() == ""):
            continue
        if rec[0].startswith("#"):
            continue  # header lines when include=header
        if len(rec) != len(params):
            raise ValueError(f"CSV row {i} has {len(rec)} columns, expected {len(params)}: {rec[:4]}")
        rows.append([convert_cell(c, p) for c, p in zip(rec, params)])
    return rows


# --------------------------------------------------------------------------------------
# HTTP: IPv4-forced fetch sharing RunContext's cache (see module docstring)
# --------------------------------------------------------------------------------------
def fetch_bytes_ipv4(ctx: RunContext, url: str, params: dict | None = None, *,
                     retries: int = 2, timeout: float | None = None) -> bytes:
    cache_path_fn = getattr(ctx, "_cache_path", None)
    if cache_path_fn is None:  # pragma: no cover - contract changed; use the shared fetch
        return ctx.fetch_bytes(url, params)
    path = cache_path_fn(url, params)
    if path.exists() and (ctx.offline or (path.stat().st_size > 0 and _cache_is_fresh(path))):
        return path.read_bytes()
    if ctx.offline:
        raise RuntimeError(f"offline and not cached: {url} {params or ''}")
    import httpx

    last: Exception | None = None
    for attempt in range(retries):
        try:
            transport = httpx.HTTPTransport(local_address="0.0.0.0")  # force IPv4
            with httpx.Client(transport=transport, timeout=timeout or ctx.timeout,
                              follow_redirects=True, headers={"User-Agent": USER_AGENT}) as c:
                r = c.get(url, params=params)
            if r.status_code >= 400:
                check_hapi_status(r.content, str(r.url))  # raises HapiError if it is one
                r.raise_for_status()
            check_hapi_status(r.content, str(r.url))
            ctx.cache_dir.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            path.with_suffix(".url").write_text(str(r.url))
            return r.content
        except HapiError:
            raise  # a HAPI-level refusal will not change on retry
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"fetch failed after {retries} attempts: {url} ({last})")


def build_url(base: str, endpoint: str, params: dict) -> str:
    """Exact URL string for source.access_urls (same encoding httpx uses)."""
    import httpx

    return str(httpx.URL(f"{base}/{endpoint}", params=params))


class HapiClient:
    def __init__(self, ctx: RunContext, base: str) -> None:
        self.ctx = ctx
        self.base = base.rstrip("/")
        self.access_urls: list[str] = []

    def _get(self, endpoint: str, params: dict) -> bytes:
        self.access_urls.append(build_url(self.base, endpoint, params))
        return fetch_bytes_ipv4(self.ctx, f"{self.base}/{endpoint}", params)

    def catalog(self) -> list[dict]:
        obj = json.loads(self._get("catalog", {}))
        return obj.get("catalog", [])

    def info(self, dataset: str) -> dict:
        raw = self._get("info", {"id": dataset})
        obj = json.loads(raw)
        check_hapi_status(raw)
        return obj

    @staticmethod
    def params_for(info: dict, wanted: Iterable[str]) -> list[Param]:
        """Time + wanted params, in /info order (pitfall 6). Unknown names raise."""
        allp = [Param.from_info(p) for p in info["parameters"]]
        names = [p.name for p in allp]
        wanted = list(wanted)
        missing = [w for w in wanted if w not in names]
        if missing:
            raise KeyError(f"parameters not in /info: {missing}")
        return [allp[0]] + [p for p in allp[1:] if p.name in wanted]

    def data(self, dataset: str, info: dict, start: datetime, stop: datetime,
             wanted: Iterable[str]) -> tuple[list[Param], list[list[Any]]]:
        params = self.params_for(info, wanted)
        q = {"id": dataset, "time.min": fmt_hapi_time(start), "time.max": fmt_hapi_time(stop),
             "parameters": ",".join(p.name for p in params[1:]), "format": "csv"}
        text = self._get("data", q).decode("utf-8", errors="replace")
        return params, parse_csv(text, params)

    def data_chunked(self, dataset: str, info: dict, start: datetime, stop: datetime,
                     wanted: Iterable[str], max_span: timedelta = timedelta(days=30)
                     ) -> tuple[list[Param], list[list[Any]]]:
        wanted = list(wanted)
        rows: list[list[Any]] = []
        params: list[Param] = []
        t = start
        while t < stop:
            u = min(t + max_span, stop)
            params, chunk = self.data(dataset, info, t, u, wanted)
            rows.extend(r for r in chunk if not rows or r[0] > rows[-1][0])  # no dup at edges
            t = u
        return params, rows


def info_window(info: dict) -> tuple[datetime, datetime]:
    """(startDate, stopDate) from /info, parsed with parse_hapi_time (pitfall 2)."""
    return parse_hapi_time(info["startDate"]), parse_hapi_time(info["stopDate"])


def units_map(params: list[Param]) -> dict[str, Any]:
    return {p.name: p.units for p in params}
