"""Earth link ETA: one-way light time, round trip, and solar-conjunction blocking (SPEC section 5).

comms_table (MET-based; the runtime converts snapshot UTC times to MET with the mission epoch):
    {"samples": [{"t": <MET s>, "one_way_s": <s>}, ...],
     "conjunction_windows": [{"start": <MET s>, "end": <MET s>, "reason": "..."}]}
Windows are half-open [start, end). Overlapping or touching windows chain: resumes_at is the end
of the chain. Light time is linearly interpolated between samples and clamped at the ends.
"""

from __future__ import annotations

from .errors import EngineError
from .fmt import is_number, require_number


def _one_way_from_table(samples: list, t: float) -> float:
    pts = []
    for p in samples:
        if not (isinstance(p, dict) and is_number(p.get("t")) and is_number(p.get("one_way_s"))):
            raise EngineError("invalid_argument", "comms_table.samples entries need numeric t and one_way_s")
        pts.append((p["t"], p["one_way_s"]))
    if not pts:
        raise EngineError("missing_comms_table", "comms_table.samples is empty")
    pts.sort(key=lambda p: p[0])
    if t <= pts[0][0]:
        return pts[0][1]
    if t >= pts[-1][0]:
        return pts[-1][1]
    for i in range(len(pts) - 1):
        t0, a = pts[i]
        t1, b = pts[i + 1]
        if t0 <= t < t1:
            return a + (b - a) * (t - t0) / (t1 - t0)
    return pts[-1][1]  # pragma: no cover - unreachable with sorted samples


def comms_eta(env: dict, t: float, comms_table: dict | None = None) -> dict:
    """{one_way_s, round_trip_s, blocked, reason, resumes_at, earliest_reply_s, light_time_source}.

    env is an environment object from environments.json (needs "comms").
    One-way light time: from comms_table when the environment says {"from_snapshot": ...},
    otherwise the environment's "max" (the conservative end of its min..max range).
    blocked: environment has conjunction: true and t falls inside a conjunction window.
    earliest_reply_s: seconds from t until a reply could arrive, assuming zero time on the
    ground: round trip now, or (resumes_at - t) + round trip at resumes_at when blocked.
    """
    if not isinstance(env, dict) or not isinstance(env.get("comms"), dict):
        raise EngineError("invalid_argument", "env must be an environment object with comms")
    require_number(t, "t")
    comms = env["comms"]
    olt = comms.get("one_way_light_time_s")
    if not isinstance(olt, dict):
        raise EngineError("invalid_argument", "env.comms.one_way_light_time_s must be an object")
    if comms_table is not None and not isinstance(comms_table, dict):
        raise EngineError("invalid_argument", "comms_table must be an object or null")
    uses_table = "from_snapshot" in olt
    if uses_table:
        if comms_table is None:
            raise EngineError("missing_comms_table",
                              f"environment {env.get('id')!r} needs light-time table {olt['from_snapshot']!r}")

        def one_way_at(x: float) -> float:
            return _one_way_from_table(comms_table.get("samples") or [], x)
    else:
        if not is_number(olt.get("max")):
            raise EngineError("invalid_argument", "env.comms.one_way_light_time_s.max must be a number")
        fixed = olt["max"]

        def one_way_at(x: float) -> float:
            return fixed

    one_way = one_way_at(t)
    blocked = False
    reason = None
    resumes_at = None
    if comms.get("conjunction") is True and comms_table is not None:
        wins = []
        for w in comms_table.get("conjunction_windows") or []:
            if not (isinstance(w, dict) and is_number(w.get("start")) and is_number(w.get("end"))):
                raise EngineError("invalid_argument", "conjunction windows need numeric start and end")
            if w["end"] > w["start"]:
                wins.append(w)
        wins.sort(key=lambda w: (w["start"], w["end"]))
        hit = None
        for w in wins:
            if w["start"] <= t < w["end"]:
                hit = w
                break
        if hit is not None:
            blocked = True
            reason = "solar_conjunction"
            resumes_at = hit["end"]
            for w in wins:  # chain overlapping / touching windows (sorted by start)
                if w["start"] <= resumes_at < w["end"]:
                    resumes_at = w["end"]
    round_trip = 2 * one_way
    if blocked:
        earliest = (resumes_at - t) + 2 * one_way_at(resumes_at)
    else:
        earliest = round_trip
    return {"one_way_s": one_way, "round_trip_s": round_trip, "blocked": blocked, "reason": reason,
            "resumes_at": resumes_at, "earliest_reply_s": earliest,
            "light_time_source": "table" if uses_table else "environment_max"}
