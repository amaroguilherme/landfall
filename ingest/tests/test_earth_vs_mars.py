"""Earth's proton lists against the storms measured at Gale: the stdlib twin of
web/src/features/radiation/earthVsMarsMatch.ts (#/radiation, Mars surface).

Recomputes from the shipped snapshots in web/public/data, with the standard library only, every number the
Mars table prints: the RAD team's Table 1 storms (hapi_msl_rad_sep_events) against NOAA's list of solar proton
events (swpc_spe_list, 2013 to September 2017) and DONKI's GOES-P >=10 MeV SEP entries (swpc_sep_events, 2024 on).
Conventions, as in the TypeScript: whole UTC days; NOAA rows placed at their maximum (else their start), DONKI
entries at their event time; a storm "has an Earth event" when one is at most STORM_MATCH_DAYS days away (a design
choice, read from marsSep.ts); an Earth event whose window touches a RAD gap longer than 2 days is left out of the
Earth-side count. Dates are matched, never events.
"""

import json
import re
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "web" / "public" / "data"
MARS_SEP_TS = ROOT / "web" / "src" / "features" / "radiation" / "marsSep.ts"
EVM_TS = ROOT / "web" / "src" / "features" / "radiation" / "earthVsMarsMatch.ts"
GOES_P = "GOES-P: SEISS >10 MeV"
RAD_GAP_DAYS = 2
SENSITIVITY_DAYS = (1, 2, 3, 5)


def _snap(snapshot_id: str) -> dict:
    p = DATA / f"{snapshot_id}.json"
    if not p.exists():
        pytest.skip(f"{p.name} is not in this build")
    return json.loads(p.read_text(encoding="utf-8"))


def _window_days() -> int:
    m = re.search(r"export const STORM_MATCH_DAYS = (\d+)", MARS_SEP_TS.read_text(encoding="utf-8"))
    assert m, "STORM_MATCH_DAYS not found in marsSep.ts"
    return int(m.group(1))


def day(iso: str) -> int:
    return date.fromisoformat(iso[:10]).toordinal()


def ts(iso: str) -> str:
    """ISO times in these files share one format (YYYY-MM-DDTHH:MM:SSZ), so they compare as strings."""
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", iso), iso
    return iso


def spans(sep: dict, spe: dict, donki: dict) -> dict:
    rec = sep["record"]
    lead = max(rec["gaps_over_2_days"], key=lambda g: g["days"])
    a_to = spe["list_last_start"]
    a_from = lead["to"] if ts(lead["to"]) < ts(a_to) else rec["first_sample"]
    noaa = [
        {"t": e["max"] or e["start"], "s_level": e.get("s_level"), "peak_pfu": e.get("peak_pfu")}
        for e in spe["events"]
        if ts(e["max"] or e["start"]) >= ts(a_from) and ts(e["start"]) <= ts(a_to)
    ]
    cov = donki["coverage"]
    b_from = cov["start"]
    b_to = cov["stop"] if ts(cov["stop"]) <= ts(rec["last_sample"]) else rec["last_sample"]
    goes = [
        {"t": e["event_time"]}
        for e in donki["data"]["events"]
        if GOES_P in e["instruments"] and ts(b_from) <= ts(e["event_time"]) <= ts(b_to)
    ]
    return {"noaa": (a_from, a_to, noaa), "donki": (b_from, b_to, goes)}


def match(sep: dict, spe: dict, donki: dict, w: int) -> dict:
    gaps = [g for g in sep["record"]["gaps_over_2_days"] if g["days"] > RAD_GAP_DAYS]
    triggers = sep["scan"]["triggers"]
    out = {}
    for name, (lo, hi, events) in spans(sep, spe, donki).items():
        inside = lambda iso: day(lo) <= day(iso) <= day(hi)  # noqa: E731
        near = lambda iso: [e for e in events if abs(day(e["t"]) - day(iso)) <= w]  # noqa: E731
        storms = [
            {"date": r["paper_date"], "uGy": r["paper"]["total_uGy"], "earth": sorted(e["t"] for e in near(r["paper_date"]))}
            for r in sep["table1"]
            if r["paper"].get("triggered") and isinstance(r["paper"].get("total_uGy"), (int, float)) and inside(r["paper_date"])
        ]
        touches = lambda e: any(day(g["from"]) <= day(e["t"]) + w and day(g["to"]) >= day(e["t"]) - w for g in gaps)  # noqa: E731
        counted = [e for e in events if not touches(e)]
        span_triggers = [t for t in triggers if inside(t["onset"])]
        out[name] = {
            "from": lo,
            "to": hi,
            "events": events,
            "excluded": [e["t"] for e in events if touches(e)],
            "counted": len(counted),
            "near_trigger": sum(1 for e in counted if any(abs(day(e["t"]) - day(t["onset"])) <= w for t in triggers)),
            "storms": storms,
            "triggers": [t["onset"][:10] for t in span_triggers],
            "triggers_with_earth": [t["onset"][:10] for t in span_triggers if near(t["onset"])],
        }
    return out


def totals(storms: list[dict]) -> tuple[int, int, float, float, float]:
    dose = sum(s["uGy"] for s in storms)
    none = sum(s["uGy"] for s in storms if not s["earth"])
    return len(storms), sum(1 for s in storms if s["earth"]), dose, none, 100 * none / dose


@pytest.fixture(scope="module")
def snaps():
    return _snap("hapi_msl_rad_sep_events")["data"], _snap("swpc_spe_list")["data"], _snap("swpc_sep_events")


@pytest.fixture(scope="module")
def at2(snaps):
    sep, spe, donki = snaps
    return match(sep, spe, donki, _window_days())


def test_window_is_the_design_choice_shared_with_the_page():
    assert _window_days() == 2
    src = EVM_TS.read_text(encoding="utf-8")
    assert f"export const GOES_P_10MEV = '{GOES_P}'" in src
    assert f"export const RAD_GAP_DAYS = {RAD_GAP_DAYS}" in src
    assert "export const SENSITIVITY_DAYS = [1, 2, 3, 5] as const" in src


def test_spans_are_read_from_the_snapshots(snaps, at2):
    sep, spe, donki = snaps
    lead = max(sep["record"]["gaps_over_2_days"], key=lambda g: g["days"])
    assert (lead["to"], lead["days"]) == ("2013-03-22T04:34:39Z", 215.7)
    assert (at2["noaa"]["from"], at2["noaa"]["to"]) == ("2013-03-22T04:34:39Z", "2017-09-10T16:45:00Z")
    assert (at2["donki"]["from"], at2["donki"]["to"]) == ("2024-01-01T00:00:00Z", "2026-11-12T23:49:21Z")
    assert at2["donki"]["to"] == sep["record"]["last_sample"]
    # the RAD adapter recorded the DONKI copy it used: the same coverage as the shipped DONKI snapshot
    assert sep["donki"]["coverage"] == {"start": donki["coverage"]["start"], "stop": donki["coverage"]["stop"]}
    assert sep["paper_record_end"] == "2024-09-09"
    assert len(donki["data"]["events"]) == 214


def test_span_a_noaa_list(at2):
    a = at2["noaa"]
    assert len(a["events"]) == 20
    assert sum(1 for e in a["events"] if (e["s_level"] or 0) >= 3) == 4
    assert [(s["date"], s["earth"]) for s in a["storms"]] == [
        ("2013-04-10", ["2013-04-11T16:45:00Z"]),
        ("2013-10-10", []),
        ("2014-09-02", []),
        ("2014-09-10", ["2014-09-12T15:55:00Z"]),
        ("2017-09-10", ["2017-09-08T00:35:00Z", "2017-09-11T11:45:00Z"]),
    ]
    n, with_earth, dose, none, share = totals(a["storms"])
    assert (n, with_earth) == (5, 3)
    assert round(none, 2) == 158.25 and round(dose, 2) == 431.35
    assert round(share, 1) == 36.7
    assert a["triggers"] == ["2014-09-01", "2015-06-11", "2016-11-13", "2017-09-10"]
    assert a["triggers_with_earth"] == ["2017-09-10"]


def test_span_b_donki_goes_p(at2):
    b = at2["donki"]
    assert len(b["events"]) == 28
    assert [(s["date"], s["earth"]) for s in b["storms"]] == [
        ("2024-05-20", []),
        ("2024-07-22", ["2024-07-23T03:00:00Z"]),
        ("2024-09-02", []),
        ("2024-09-05", []),
    ]
    n, with_earth, dose, none, share = totals(b["storms"])
    assert (n, with_earth) == (4, 1)
    assert round(none, 2) == 1758.96 and round(dose, 2) == 1816.94
    assert round(share, 1) == 96.8
    assert b["triggers"] == ["2024-05-20", "2024-07-23", "2024-09-03", "2024-09-05", "2024-11-21", "2025-05-31", "2025-11-11"]
    assert b["triggers_with_earth"] == ["2024-07-23", "2024-11-21", "2025-05-31", "2025-11-11"]


def test_combined_and_without_the_largest_storm(at2):
    storms = at2["noaa"]["storms"] + at2["donki"]["storms"]
    n, with_earth, dose, none, share = totals(storms)
    assert (n, with_earth) == (9, 4)
    assert round(none, 2) == 1917.21 and round(dose, 2) == 2248.29
    assert round(share, 1) == 85.3
    largest = max(storms, key=lambda s: s["uGy"])
    assert (largest["date"], largest["uGy"]) == ("2024-05-20", 1730.55)
    assert round(100 * largest["uGy"] / none, 1) == 90.3  # "most of that dose is one storm"
    n, with_earth, dose, none, share = totals([s for s in storms if s is not largest])
    assert (n, with_earth) == (8, 4)
    assert round(none, 2) == 186.66 and round(dose, 2) == 517.74
    assert round(share, 1) == 36.1


def test_20_may_2024_is_the_largest_of_the_surface_rows(snaps):
    sep, _, _ = snaps
    rows = sep["table1"]
    # the snapshot ships only Table 1's 16 Martian-surface rows; its deep-space (cruise) rows are not compared
    assert len(rows) == 16
    assert [r["paper_date"] for r in rows] == [r[:10] for r in sep["literature"]["table1_surface_rows"]]
    top = max(r["paper"].get("total_uGy") or 0 for r in rows)
    assert top == 1730.55
    assert [r["paper_date"] for r in rows if r["paper"].get("total_uGy") == top] == ["2024-05-20"]


def test_table_1_ends_inside_the_donki_span(snaps, at2):
    sep, _, _ = snaps
    end = sep["paper_record_end"]
    assert end == "2024-09-09"
    assert all(r["paper_date"] <= end for r in sep["table1"])
    assert at2["noaa"]["to"][:10] < end  # NOAA's row needs no note
    assert at2["donki"]["from"][:10] <= end < at2["donki"]["to"][:10]  # DONKI's row says "Table 1 runs to 2024-09-09"
    assert [t for t in at2["donki"]["triggers"] if t > end] == ["2024-11-21", "2025-05-31", "2025-11-11"]


def test_rows_outside_both_spans_are_listed_never_counted(snaps, at2):
    sep, _, _ = snaps
    counted = {s["date"] for k in ("noaa", "donki") for s in at2[k]["storms"]}
    outside = [r["paper_date"] for r in sep["table1"] if r["paper"].get("triggered") and r["paper_date"] not in counted]
    assert outside == ["2021-10-28", "2022-02-15", "2023-03-12"]


def test_earth_side_and_sensitivity(snaps, at2):
    sep, spe, donki = snaps
    assert at2["noaa"]["excluded"] == [] and at2["donki"]["excluded"] == []
    assert at2["noaa"]["counted"] + at2["donki"]["counted"] == 48
    assert at2["noaa"]["near_trigger"] + at2["donki"]["near_trigger"] == 7
    rows = {}
    for w in SENSITIVITY_DAYS:
        m = match(sep, spe, donki, w)
        n, with_earth, dose, none, share = totals(m["noaa"]["storms"] + m["donki"]["storms"])
        rows[w] = (with_earth, n, round(none, 2), round(share, 1), m["noaa"]["near_trigger"] + m["donki"]["near_trigger"],
                   m["noaa"]["counted"] + m["donki"]["counted"], m["noaa"]["excluded"] + m["donki"]["excluded"])
    assert rows == {
        1: (3, 9, 1919.30, 85.4, 6, 48, []),
        2: (4, 9, 1917.21, 85.3, 7, 48, []),
        3: (4, 9, 1917.21, 85.3, 8, 48, []),
        # at 5 days the window of NOAA's 2013-06-24 maximum touches the RAD gap of 2013-06-17 to 2013-06-20
        5: (5, 9, 1891.69, 84.1, 9, 47, ["2013-06-24T05:20:00Z"]),
    }


def test_20_may_2024_has_no_goes_p_entry_at_any_window(snaps, at2):
    sep, _, donki = snaps
    goes = [e["t"] for e in at2["donki"]["events"]]
    d = day("2024-05-20")
    assert min(abs(day(t) - d) for t in goes) == 7
    before = max(t for t in goes if day(t) < d)
    after = min(t for t in goes if day(t) > d)
    assert (before, d - day(before)) == ("2024-05-13T14:00:00Z", 7)
    assert (after, day(after) - d) == ("2024-06-08T02:55:00Z", 19)
    # no DONKI SEP entry from any instrument between the two (the snapshot's own gap)
    every = sorted(e["event_time"] for e in donki["data"]["events"])
    inside = [t for t in every if "2024-05-13T18:07:00Z" < t < "2024-06-08T02:25:00Z"]
    assert inside == []
    assert sep["may_2024"]["donki_gap"] == {"start": "2024-05-13T18:07:00Z", "stop": "2024-06-08T02:25:00Z"}


def test_s3_storms_at_earth_on_rows_of_table_1(snaps):
    sep, spe, _ = snaps
    rec = sep["record"]
    w = _window_days()
    s3 = [e for e in spe["events"] if (e.get("s_level") or 0) >= 3 and isinstance(e.get("peak_pfu"), (int, float))
          and rec["first_sample"] <= (e["max"] or e["start"]) <= rec["last_sample"]]
    assert [(e["max"] or e["start"])[:10] for e in s3] == ["2013-05-23", "2014-01-09", "2015-06-22", "2017-09-11"]
    on_rows = [(e["max"] or e["start"])[:10] for e in s3
               if any(abs(day(r["paper_date"]) - day(e["max"] or e["start"])) <= w for r in sep["table1"])]
    assert on_rows == ["2017-09-11"]
