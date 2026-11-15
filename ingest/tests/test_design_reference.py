"""NASA's design reference SPE, re-derived (web/src/features/radiation/designRef.ts), recomputed here in stdlib Python
from the two shipped snapshots:

  * NASA-STD-3001 Vol 1 Table 4.8-3 (std_vol1_requirements, data.tables): the summed October 1989 proton spectrum,
    integrated above 10 and 100 MeV by power-law segments between its printed pairs, up to its last energy;
  * the replayed GOES-7 record (swpc_spe_replay): 4π × Σ max(F − bg, 0) × 300 s over the event as the swpc adapter
    computes it with NOAA's SESC rule (onset to the last sample ≥ 10 pfu), bg = the median of the day before the
    onset day, missing samples filled linearly;
  * in hindsight, the shares that had arrived before LANDFALL's S3 trigger (the first replay sample ≥ 1,000 pfu) and
    the moment 10 % had arrived (the RAD team's lead-time measure), and how far the agreement moves when the event
    window ends anywhere from 26 Oct 00:00 UTC to the record's last sample.

designRef.test.ts pins the same numbers. Nothing here feeds the case, the rules or the hero.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone

import pytest

from ingest.common import DEFAULT_OUT_DIR

ISO = "%Y-%m-%dT%H:%M:%SZ"
S3_PFU = 1000.0                      # NOAA S3, >=10 MeV (engine/rules/thresholds.json, snapshot swpc_s_scale)
WINDOW_END_FROM = "1989-10-26T00:00:00Z"


# ----------------------------------------------------------------------------- the arithmetic
def integral_above(pairs: list[tuple[float, float]], e0: float) -> float:
    """∫ F(E) dE from e0 to the last energy, F a power law between consecutive (E, F) pairs (straight on log-log)."""
    total = 0.0
    for (e1, f1), (e2, f2) in zip(pairs, pairs[1:]):
        if e2 <= e0:
            continue
        a = max(e1, e0)
        g = math.log(f2 / f1) / math.log(e2 / e1)
        if abs(g + 1.0) < 1e-12:
            total += f1 * e1 * math.log(e2 / a)
        else:
            total += f1 * e1 * ((e2 / e1) ** (g + 1.0) - (a / e1) ** (g + 1.0)) / (g + 1.0)
    return total


def parse_iso(s: str) -> datetime:
    return datetime.strptime(s, ISO).replace(tzinfo=timezone.utc)


def sample_times(series: dict) -> list[datetime]:
    t0 = parse_iso(series["start"])
    return [t0 + timedelta(seconds=i * series["step_s"]) for i in range(len(series["values"]))]


def filled(values: list[float | None]) -> list[float]:
    """Missing samples filled linearly between the nearest samples on either side; 0 at an open end."""
    out = [0.0] * len(values)
    left = None
    for i, v in enumerate(values):
        if v is not None:
            out[i] = float(v)
            left = i
            continue
        right = next((k for k in range(i + 1, len(values)) if values[k] is not None), None)
        if left is None or right is None:
            out[i] = 0.0
        else:
            out[i] = values[left] + (values[right] - values[left]) * (i - left) / (right - left)
    return out


def day_median(series: dict, day: str) -> float:
    """Median of the non-missing samples whose UTC date is `day`."""
    vals = sorted(v for t, v in zip(sample_times(series), series["values"]) if v is not None and t.strftime("%Y-%m-%d") == day)
    n = len(vals)
    return vals[n // 2] if n % 2 else 0.5 * (vals[n // 2 - 1] + vals[n // 2])


def replay_fluence(series: dict, start: str, end: str, bg: float) -> tuple[list[datetime], list[float]]:
    """(times, running fluence after each sample), protons/cm², over the samples with start <= t <= end."""
    a, b = parse_iso(start), parse_iso(end)
    times, cum, run = [], [], 0.0
    for t, v in zip(sample_times(series), filled(series["values"])):
        if a <= t <= b:
            run += 4.0 * math.pi * max(v - bg, 0.0) * series["step_s"]
            times.append(t)
            cum.append(run)
    return times, cum


def share_before(times: list[datetime], cum: list[float], t: datetime) -> float:
    """Fraction of the total fluence carried by the samples strictly before t."""
    before = 0.0
    for ti, c in zip(times, cum):
        if ti < t:
            before = c
    return before / cum[-1]


def mark(times: list[datetime], cum: list[float], fraction: float = 0.1) -> datetime:
    """The first sample at which the running fluence reaches `fraction` of the total."""
    return next(t for t, c in zip(times, cum) if c >= fraction * cum[-1])


def window_end_range(series: dict, start: str, end_from: str, bg: float, reference: float) -> tuple[float, float]:
    """Min and max of (replay - reference) / reference, %, as the window end moves over every sample from end_from
    to the record's last sample."""
    times, cum = replay_fluence(series, start, series_end(series), bg)
    lo = parse_iso(end_from)
    pcts = [100.0 * (c - reference) / reference for t, c in zip(times, cum) if t >= lo]
    return min(pcts), max(pcts)


def series_end(series: dict) -> str:
    return sample_times(series)[-1].strftime(ISO)


# ----------------------------------------------------------------------------- the shipped snapshots
def _load(name: str) -> dict:
    p = DEFAULT_OUT_DIR / f"{name}.json"
    if not p.exists():
        pytest.skip(f"{name}.json not generated")
    return json.loads(p.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def table():
    t = next((t for t in _load("std_vol1_requirements")["data"]["tables"] if t["id"] == "Table 4.8-3"), None)
    if t is None:
        pytest.skip("Table 4.8-3 not in the shipped Vol 1 snapshot")
    return t


@pytest.fixture(scope="module")
def pairs(table):
    return [(r["energy_mev"], r["fluence"]["value"]) for r in table["rows"]]


@pytest.fixture(scope="module")
def replay():
    return _load("swpc_spe_replay")["data"]


def _bg_day(replay: dict) -> str:
    return (parse_iso(replay["sesc_event_computed"]["start"]) - timedelta(days=1)).strftime("%Y-%m-%d")


def _trigger(replay: dict) -> datetime:
    s = replay["series_ge10mev"]
    return next(t for t, v in zip(sample_times(s), s["values"]) if v is not None and v >= S3_PFU)


def _channel(replay: dict, key: str) -> dict:
    s = replay[key]
    ev = replay["sesc_event_computed"]
    bg = day_median(s, _bg_day(replay))
    times, cum = replay_fluence(s, ev["start"], ev["end_last_ge_10pfu"], bg)
    trig = _trigger(replay)
    m = mark(times, cum)
    return {"bg": bg, "total": cum[-1], "before": share_before(times, cum, trig), "mark": m,
            "hours": (m - trig).total_seconds() / 3600.0}


def rel(a: float, b: float) -> float:
    return abs(a - b) / abs(b)


# ----------------------------------------------------------------------------- the integrator
@pytest.mark.parametrize("gamma", [2.5, 1.0, 3.7, 0.4])
def test_power_law_segments_integrate_a_pure_power_law_exactly(gamma):
    # F(E) = A E^-gamma sampled on a log grid: each segment is that same power law, so the sum is the closed form.
    a_const, energies = 3.0e9, [10 ** (k / 10) for k in range(-20, 35)]   # 0.01 .. 2512 MeV
    pairs = [(e, a_const * e ** -gamma) for e in energies]
    for e0 in (10.0, 100.0, 0.05, 1234.5):
        top = energies[-1]
        exact = a_const * math.log(top / e0) if gamma == 1.0 else a_const * (top ** (1 - gamma) - e0 ** (1 - gamma)) / (1 - gamma)
        assert rel(integral_above(pairs, e0), exact) < 1e-10, (gamma, e0)


def test_integrator_edges():
    pairs = [(1.0, 100.0), (10.0, 1.0), (100.0, 0.01)]          # F = 100 E^-2 throughout
    assert integral_above(pairs, 100.0) == 0.0                  # nothing above the last energy
    assert integral_above(pairs, 1000.0) == 0.0
    assert rel(integral_above(pairs, 0.1), integral_above(pairs, 1.0)) < 1e-15   # below the first energy: whole table
    assert rel(integral_above(pairs, 1.0), 100.0 * (1.0 - 0.01)) < 1e-12        # ∫1..100 100 E^-2 dE = 99


def test_filled_is_linear_between_neighbours_and_zero_at_open_ends():
    assert filled([1.0, None, None, 4.0]) == [1.0, 2.0, 3.0, 4.0]
    assert filled([None, 2.0, None]) == [0.0, 2.0, 0.0]


# ----------------------------------------------------------------------------- Table 4.8-3
def test_table_483_integrals(table, pairs):
    assert table["verified"] is True and len(pairs) == 100
    i10, i100 = integral_above(pairs, 10.0), integral_above(pairs, 100.0)
    assert rel(i10, 1.92034e10) < 1e-4 and rel(i100, 4.47579e8) < 1e-4
    # the values designRef.test.ts pins to 1e-9
    assert rel(i10, 19203449053.92634) < 1e-9 and rel(i100, 447578889.7388005) < 1e-9
    for e0, want in ((30.0, 4.16601e9), (50.0, 1.71470e9), (60.0, 1.22165e9)):
        assert rel(integral_above(pairs, e0), want) < 1e-4, e0


def test_a_linear_trapezoid_gives_slightly_more(pairs):
    # The table is convex on linear axes, so straight chords lie above it: 0.57 % (>= 10 MeV) to 1.08 % (>= 100 MeV)
    # more than power-law segments, as measured on 2026-11-15.
    def trapezoid(e0):
        s = 0.0
        for (e1, f1), (e2, f2) in zip(pairs, pairs[1:]):
            if e2 <= e0:
                continue
            a = max(e1, e0)
            fa = f1 + (f2 - f1) * (a - e1) / (e2 - e1)
            s += 0.5 * (fa + f2) * (e2 - a)
        return s
    for e0 in (10.0, 30.0, 50.0, 60.0, 100.0):
        more = trapezoid(e0) / integral_above(pairs, e0) - 1.0
        assert 0.0055 <= more <= 0.011, (e0, more)
    assert round(100 * (trapezoid(10.0) / integral_above(pairs, 10.0) - 1), 2) == 0.57
    assert round(100 * (trapezoid(100.0) / integral_above(pairs, 100.0) - 1), 2) == 1.08


# ----------------------------------------------------------------------------- the replay
def test_event_window_trigger_and_background_day(replay):
    ev = replay["sesc_event_computed"]
    assert (ev["start"], ev["end_last_ge_10pfu"]) == ("1989-10-19T13:10:00Z", "1989-10-29T22:20:00Z")
    assert _bg_day(replay) == "1989-10-18"
    assert _trigger(replay).strftime(ISO) == "1989-10-19T18:55:00Z"
    # the same sample the scenario places at MET 412/14:15 (sim_crew's replay mapping) and the first S3 transition
    mapping = _load("sim_crew")["data"]["spe_day"]["shape"]["mapping"]
    assert mapping["replay_utc_of_first_s3_sample"] == "1989-10-19T18:55:00Z"
    assert next(t for t, lvl in replay["s_transitions"] if lvl == 3) == "1989-10-19T18:55:00Z"
    for key, missing in (("series_ge10mev", 17), ("series_ge100mev", 16)):
        assert sum(v is None for v in replay[key]["values"]) == missing
        assert series_end(replay[key]) == "1989-10-31T23:55:00Z"


def test_replay_agrees_with_table_483(replay, pairs):
    c10, c100 = _channel(replay, "series_ge10mev"), _channel(replay, "series_ge100mev")
    assert (c10["bg"], c100["bg"]) == (0.254, 0.0118)
    assert rel(c10["total"], 1.92966e10) < 1e-4 and rel(c100["total"], 4.59054e8) < 1e-4
    assert rel(c10["total"], 19296594161.24258) < 1e-9 and rel(c100["total"], 459053705.1545731) < 1e-9
    d10 = 100.0 * (c10["total"] / integral_above(pairs, 10.0) - 1.0)
    d100 = 100.0 * (c100["total"] / integral_above(pairs, 100.0) - 1.0)
    assert abs(d10 - 0.49) < 0.01 and abs(d100 - 2.56) < 0.01


def test_hindsight_shares_and_ten_percent_marks(replay):
    c10, c100 = _channel(replay, "series_ge10mev"), _channel(replay, "series_ge100mev")
    assert round(100 * c10["before"], 2) == 0.56 and round(100 * c100["before"], 2) == 3.60
    assert c10["mark"].strftime(ISO) == "1989-10-20T13:20:00Z" and c100["mark"].strftime(ISO) == "1989-10-19T22:55:00Z"
    assert round(c10["hours"], 2) == 18.42 and round(c100["hours"], 2) == 4.00


def test_window_end_range(replay, pairs):
    ev = replay["sesc_event_computed"]
    out = {}
    for key, e0 in (("series_ge10mev", 10.0), ("series_ge100mev", 100.0)):
        s = replay[key]
        out[key] = window_end_range(s, ev["start"], WINDOW_END_FROM, day_median(s, _bg_day(replay)), integral_above(pairs, e0))
    print(f"\nwindow end {WINDOW_END_FROM} .. 1989-10-31T23:55:00Z: "
          + "; ".join(f"{k} {lo:+.2f} % .. {hi:+.2f} %" for k, (lo, hi) in out.items()))
    (lo10, hi10), (lo100, hi100) = out["series_ge10mev"], out["series_ge100mev"]
    # measured on 2026-11-15 (round 2 had reported -1.9 .. +0.5 % and 0.0 .. +2.8 %)
    assert rel(lo10, -1.8587576413609537) < 1e-9 and rel(hi10, 0.5295241896579344) < 1e-9
    assert rel(lo100, -0.01919921682378602) < 1e-9 and rel(hi100, 2.7189934249185277) < 1e-9
    assert lo10 < 0.49 < hi10 and lo100 < 2.56 < hi100
