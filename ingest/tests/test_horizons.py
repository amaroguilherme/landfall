"""Tests for the JPL Horizons comms adapter: parser pitfalls, arithmetic, and the frozen data."""

from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta

import pytest

from ingest._horizons_core import (HorizonsFormatError, calibrate_threshold, check_api_payload,
                                   column_unit, find_windows, interpolate, light_time_per_au_s,
                                   normalise_text, parse_horizons_time, parse_observer_csv,
                                   quote_in_page, to_float)
from ingest._horizons_published import PUBLISHED_MORATORIA
from ingest.common import DEFAULT_OUT_DIR, validate_snapshot
from ingest.horizons import access_url, horizons_params, table_series

# Trimmed copy of a real Horizons API "result" (Mars from 500@399, QUANTITIES='20,21,23',
# CSV_FORMAT='YES'); the two unnamed columns after the date are the solar/lunar presence flags.
FIXTURE = """
*******************************************************************************
Ephemeris / API_USER Sat Nov 14 05:15:02 2026 Pasadena, USA      / Horizons
*******************************************************************************
Target body name: Mars (499)                      {source: mar099}
Center body name: Earth (399)                     {source: DE441}
Center-site name: GEOCENTRIC
*******************************************************************************
Start time      : A.D. 2026-Jan-01 00:00:00.0000 UT
Stop  time      : A.D. 2026-Jan-03 00:00:00.0000 UT
Step-size       : 1440 minutes
*******************************************************************************
Units conversion: 1 au= 149597870.700 km, c= 299792.458 km/s, 1 day= 86400.0 s
Table format    : Comma Separated Values (spreadsheet)
***********************************************************************************
 Date__(UT)__HR:MN, , ,            delta,     deldot,  1-way_down_LT,     S-O-T,/r,
***********************************************************************************
$$SOE
 2026-Jan-01 00:00, , , 2.41069876736921, -1.3609865,    20.04917029,    2.2993,/T,
 2026-Jan-02 00:00, , , 2.40990378540528, -1.3917862,    20.04255863,    2.0718,/T,
 2026-Jan-03 00:00, , , 2.40909127253229, -1.4217276,    20.03580116,    1.8514,/T,
$$EOE
***********************************************************************************
Column meaning:
 'delta,     deldot,' =
   Apparent range ("delta", light-time aberrated) and range-rate ("delta-dot")
of the target center relative to the observer.  Units: AU and KM/S

 '1-way_down_LT,' =
   1-way down-leg light-time from target center to observer. Units: MINUTES

 'S-O-T,/r,' =
   Sun-Observer-Target apparent SOLAR ELONGATION ANGLE seen from the observers'
location at print-time.
   Units: DEGREES
"""

MARS = DEFAULT_OUT_DIR / "horizons_mars_comms.json"
MOON = DEFAULT_OUT_DIR / "horizons_moon_comms.json"


def _load(path):
    if not path.exists():
        pytest.skip(f"{path.name} not built yet (uv run python -m ingest horizons)")
    return json.loads(path.read_text())


# ------------------------------------------------------------------ parsing pitfalls
def test_parse_horizons_dates():
    assert parse_horizons_time("2026-Nov-14 00:00") == datetime(2026, 11, 14)
    assert parse_horizons_time(" 2026-Feb-20 13:45 ") == datetime(2026, 2, 20, 13, 45)
    assert parse_horizons_time("2026-Nov-14 00:00:30.500") == datetime(2026, 11, 14, 0, 0, 30, 500000)
    assert parse_horizons_time("2026-Nov-14") == datetime(2026, 11, 14)
    for bad in ("b2026-Nov-14 00:00", "2026-Foo-14 00:00", "2026-11-14 00:00", ""):
        with pytest.raises(HorizonsFormatError):
            parse_horizons_time(bad)


def test_parse_table_by_column_name():
    t = parse_observer_csv(FIXTURE)
    assert t.columns[:3] == ["Date__(UT)__HR:MN", "", ""]          # unnamed flag columns kept
    assert t.col("delta") == 3 and t.col("S-O-T") == 6 and t.date_col() == 0
    assert t.header["target_name"] == "Mars (499)" and t.header["target_ephemeris"] == "mar099"
    assert t.header["center_ephemeris"] == "DE441"
    assert (t.header["au_km"], t.header["c_km_s"]) == (149597870.7, 299792.458)
    assert column_unit(t.column_notes, "'1-way_down_LT,'") == "MINUTES"
    assert column_unit(t.column_notes, "'S-O-T,/r,'") == "DEGREES"
    rows = table_series(t, need_elongation=True)
    assert [r["t"].day for r in rows] == [1, 2, 3]
    assert rows[0]["range_au"] == 2.41069876736921 and rows[2]["elong_deg"] == 1.8514
    assert rows[0]["hz_lt_s"] == pytest.approx(20.04917029 * 60)
    with pytest.raises(HorizonsFormatError, match="QUANTITIES"):
        t.col("r")                                                  # not requested


def test_markers_missing_reports_horizons_text():
    with pytest.raises(HorizonsFormatError, match="Cannot interpret date"):
        parse_observer_csv("\n Cannot interpret date. Type \"?!\" or try YYYY-MMM-DD {HH:MN}\n")


def test_api_error_key_and_bad_cells():
    with pytest.raises(HorizonsFormatError, match="no ephemeris"):
        check_api_payload({"error": "no ephemeris for target", "signature": {"version": "1.2"}})
    with pytest.raises(HorizonsFormatError, match="n.a."):
        to_float("n.a.", "S-O-T")
    ragged = FIXTURE.replace("2.0718,/T,", "2.0718,/T")
    with pytest.raises(HorizonsFormatError, match="cells"):
        parse_observer_csv(ragged)


def test_wrong_units_fail_loudly():
    t = parse_observer_csv(FIXTURE.replace("Units: MINUTES", "Units: SECONDS"))
    with pytest.raises(HorizonsFormatError, match="MINUTES"):
        table_series(t, need_elongation=True)


def test_non_daily_rows_rejected():
    t = parse_observer_csv(FIXTURE.replace("2026-Jan-03 00:00", "2026-Jan-05 00:00"))
    with pytest.raises(HorizonsFormatError, match="non-daily"):
        table_series(t, need_elongation=True)


def test_request_url_is_reproducible():
    p = horizons_params("499", "2026-01-01", "2029-12-31", "20,21,23")
    url = access_url(p)
    assert url.startswith("https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND=%27499%27")
    assert "CENTER=%27500%40399%27" in url and "STEP_SIZE=%271%20d%27" in url


# ------------------------------------------------------------------ arithmetic
def test_light_time_per_au_from_header_constants():
    tau = light_time_per_au_s(149597870.700, 299792.458)
    assert round(tau, 6) == 499.004784                              # the brief's figure
    assert tau == pytest.approx(499.0047838361564, abs=1e-12)


def _v_series(t0: datetime, centre_day: float, slope: float, floor: float, n: int):
    return [(t0 + timedelta(days=i), floor + slope * abs(i - centre_day)) for i in range(n)]


def test_windows_interpolate_edges():
    s = _v_series(datetime(2030, 1, 1), 10, 0.5, 0.5, 21)          # min 0.5 deg on day 10
    (w,) = find_windows(s, 1.75)                                    # |d-10| = 2.5
    assert w.start == datetime(2030, 1, 8, 12) and w.end == datetime(2030, 1, 13, 12)
    assert (w.min_value, w.min_at) == (0.5, datetime(2030, 1, 11))
    assert find_windows(s, 0.4) == []
    assert interpolate(s, datetime(2030, 1, 1, 12)) == pytest.approx(5.25)


def test_windows_truncated_at_series_edges():
    s = _v_series(datetime(2030, 1, 1), 0, 0.5, 0.5, 10)
    (w,) = find_windows(s, 2.0)
    assert w.start is None and w.end == datetime(2030, 1, 4)
    s2 = _v_series(datetime(2030, 1, 1), 9, 0.5, 0.5, 10)
    (w2,) = find_windows(s2, 2.0)
    assert w2.end is None and w2.start == datetime(2030, 1, 7)


def test_calibration_recovers_a_known_threshold():
    a = _v_series(datetime(2030, 1, 1), 10, 0.5, 0.5, 21)
    b = _v_series(datetime(2031, 1, 1), 10, 0.4, 0.75, 21)          # different slope and floor
    # Published days chosen so both series cross 1.75 deg exactly at 12:00 UTC of those days.
    pub = [{"id": "a", "start": date(2030, 1, 8), "end": date(2030, 1, 13)},
           {"id": "b", "start": date(2031, 1, 8), "end": date(2031, 1, 13)}]
    best = calibrate_threshold(a + b, pub)
    assert best["threshold"] == pytest.approx(1.75, abs=1e-9)
    assert best["rms_days"] < 1e-6 and best["n_edges"] == 4
    # Move one published end by a day: the fit cannot absorb it and the residual shows it.
    pub[1]["end"] = date(2031, 1, 14)
    worse = calibrate_threshold(a + b, pub)
    assert worse["rms_days"] > 0.1 and worse["max_abs_days"] > 0.3


def test_quote_matching_normalises_html():
    page = ("<p>NASA will hold off sending commands to its Mars fleet for two weeks, from "
            "<a href='#'>Nov.&nbsp;11</a> to 25, while Earth and the Red Planet are on "
            "opposite sides of the Sun.</p><script>var x = 'Nov. 12';</script>")
    q = ("NASA will hold off sending commands to its Mars fleet for two weeks, from Nov. 11 "
         "to 25, while Earth and the Red Planet are on opposite sides of the Sun.")
    assert quote_in_page(q, page)
    assert not quote_in_page(q.replace("25", "26"), page)
    assert normalise_text("it’s “x” — a ,b") == "it's \"x\" - a,b"


def test_published_moratoria_are_self_consistent():
    ids = [p["id"] for p in PUBLISHED_MORATORIA]
    assert len(ids) == len(set(ids))
    used = [p for p in PUBLISHED_MORATORIA if p["used_in_calibration"]]
    assert len(used) >= 5
    for p in PUBLISHED_MORATORIA:
        assert p["start"] < p["end"]
        assert p["url"].startswith(("https://www.jpl.nasa.gov/", "https://www.nasa.gov/",
                                    "https://science.nasa.gov/"))
        q = p["quote"]
        assert str(p["start"].day) in q and str(p["end"].day) in q, p["id"]
        assert p["used_in_calibration"] or p.get("exclusion_reason")


# ------------------------------------------------------------------ the frozen snapshots
def test_mars_snapshot_shape_and_arithmetic():
    s = _load(MARS)
    validate_snapshot(s)
    assert s["provenance"] == "predicted" and s["freshness"]["kind"] == "prediction"
    d = s["data"]
    assert d["columns"] == ["date", "range_au", "range_km", "one_way_light_time_s", "elongation_deg"]
    rows = d["rows"]
    days = [date.fromisoformat(r[0]) for r in rows]
    assert days[0] == date(2026, 1, 1) and days[-1] == date(2029, 12, 31) and len(rows) == 1461
    assert all((b - a).days == 1 for a, b in zip(days, days[1:]))
    tau = d["constants"]["light_time_per_au_s"]["value"]
    au_km = d["constants"]["au_km"]["value"]
    for _, au, km, lt, el in rows:
        assert abs(lt - au * tau) <= 0.0005 + 1e-9
        assert abs(km - au * au_km) <= 0.5 + 1e-6
        assert 0.0 <= el <= 180.0
    assert d["light_time_cross_check"]["max_abs_diff_s"] < 1e-5
    v = d["horizons"]["api_signature"]["version"]
    assert "Horizons On-Line Ephemeris System" in s["source"]["citation"]
    assert f"version {v}" in s["source"]["citation"]


def test_mars_closest_in_feb_2027():
    """Known answer (verified in the data, not forced): Mars opposition early 2027."""
    rows = _load(MARS)["data"]["rows"]
    q1 = [r for r in rows if r[0][:7] in ("2027-01", "2027-02", "2027-03")]
    closest = min(q1, key=lambda r: r[1])
    assert closest[0].startswith("2027-02") and closest[1] < 0.7
    assert closest[4] > 170                                         # near opposition: far from the Sun


def test_conjunction_windows_match_the_rows():
    d = _load(MARS)["data"]
    th = d["calibration"]["threshold_deg"]["value"]
    el = {r[0]: r[4] for r in d["rows"]}
    assert d["conjunctions"], "expected at least one solar conjunction in 2026-2029"
    assert [c["id"] for c in d["conjunctions"]] == ["mars_conjunction_2026_01", "mars_conjunction_2028_03"]
    for c in d["conjunctions"]:
        s, e = datetime.fromisoformat(c["start"][:-1]), datetime.fromisoformat(c["end"][:-1])
        assert c["min_elongation_deg"] < th
        day = s.date() + timedelta(days=1)
        while datetime(day.year, day.month, day.day) < e - timedelta(hours=1):
            if day.isoformat() in el:
                assert el[day.isoformat()] < th + 0.02, (c["id"], day)  # hour rounding slack
            day += timedelta(days=1)
        for outside in (s.date() - timedelta(days=1), e.date() + timedelta(days=1)):
            if outside.isoformat() in el:
                assert el[outside.isoformat()] > th, (c["id"], outside)


def test_calibration_residuals_are_honest_and_reproducible():
    d = _load(MARS)["data"]
    cal = d["calibration"]
    assert cal["threshold_deg"]["chip"] == "derived"
    used = [p for p in cal["published"] if p["used_in_calibration"]]
    edges = [x for p in used for x in (p["start_residual_days"], p["end_residual_days"])]
    assert len(edges) == cal["n_edges"]
    rms = math.sqrt(sum(x * x for x in edges) / len(edges))
    assert rms == pytest.approx(cal["residual_rms_days"], abs=0.02)
    # What the data shows today: every published fleet edge is reproduced within 3 days.
    assert max(abs(x) for x in edges) <= 3.0
    # Out of sample (not fitted): NASA's "no contact ... until Friday, Jan. 16" (2026).
    (jan26,) = [p for p in cal["published"] if p["id"] == "2026_no_contact"]
    assert abs(jan26["end_residual_days"]) <= 1.0
    # A reader can redo the fit from the shipped samples and get the same threshold.
    series = [(datetime.fromisoformat(t), v) for t, v in d["calibration_series"]["rows"]]
    pub = [{"id": p["id"], "start": date.fromisoformat(p["start_date"]),
            "end": date.fromisoformat(p["end_date"])} for p in used]
    assert calibrate_threshold(series, pub)["threshold"] == cal["threshold_deg"]["value"]


def test_moon_snapshot():
    s = _load(MOON)
    validate_snapshot(s)
    d = s["data"]
    assert len(d["rows"]) == 1461 and d["conjunctions"] == []
    for _, au, km, lt in d["rows"]:
        assert 356_000 < km < 407_000                               # perigee..apogee
        assert 1.18 < lt < 1.36
    assert d["light_time_cross_check"]["max_abs_diff_s"] < 1e-5
