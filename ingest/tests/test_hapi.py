"""Known-answer tests for the `hapi` adapter and its HAPI client (no network needed)."""

import json
import math
from datetime import datetime, timezone

import pytest

from ingest import hapi
from ingest._hapi_client import (HapiClient, HapiError, Param, check_hapi_status, convert_cell,
                                 fetch_bytes_ipv4, hapi_time_to_iso, info_window, is_fill,
                                 parse_csv, parse_hapi_time)
from ingest.common import DEFAULT_OUT_DIR, RunContext, validate_snapshot

UTC = timezone.utc


# ---- pitfall 1: day-of-year timestamps ------------------------------------------------
def test_doy_known_answer():
    assert parse_hapi_time("2026-261T00:00:00Z") == parse_hapi_time("2026-09-18T00:00:00Z")
    assert hapi_time_to_iso("2026-261T00:00:00Z") == "2026-09-18T00:00:00Z"


@pytest.mark.parametrize("raw,iso", [
    ("2026-318T13:00:00Z", "2026-11-14T13:00:00Z"),          # SSCWeb row format
    ("2026-261T00:00:00.000Z", "2026-09-18T00:00:00Z"),
    ("2026-261T00:00:00.999Z", "2026-09-18T00:00:00Z"),      # fraction truncated, not rounded
    ("2026-261", "2026-09-18T00:00:00Z"),                    # truncated forms
    ("2026-261Z", "2026-09-18T00:00:00Z"),
    ("2026-261T05", "2026-09-18T05:00:00Z"),
    ("2026-261T05:06Z", "2026-09-18T05:06:00Z"),
    ("2026-09-18", "2026-09-18T00:00:00Z"),
    ("2026-09-18T05Z", "2026-09-18T05:00:00Z"),
    ("2010-04-29T03:27:36Z", "2010-04-29T03:27:36Z"),        # CDAWeb startDate
    ("1998-11-21T00:00:00.000Z", "1998-11-21T00:00:00Z"),    # SSCWeb startDate
    ("2015-06-01T00:00:10.000Z", "2015-06-01T00:00:10Z"),    # CDAWeb row format
    ("2026-001T00:00:00Z", "2026-01-01T00:00:00Z"),
    ("2024-366T12:00:00Z", "2024-12-31T12:00:00Z"),          # leap year day 366
    ("2026-365T23:59:59Z", "2026-12-31T23:59:59Z"),
    ("2016-12-31T23:59:60Z", "2017-01-01T00:00:00Z"),        # leap second
])
def test_parse_hapi_time_forms(raw, iso):
    assert hapi_time_to_iso(raw) == iso


def test_parse_keeps_microseconds():
    assert parse_hapi_time("2026-09-18T05:06:07.123456789Z").microsecond == 123456
    assert parse_hapi_time("2026-09-18T05:06:07.5Z").microsecond == 500000
    assert parse_hapi_time("2026-261T00:00:00Z").tzinfo is not None


@pytest.mark.parametrize("bad", ["2026-366T00:00:00Z", "2026-000T00:00:00Z", "2026-02-30",
                                 "2026/09/18", "2026-261T24:00:00Z", "2026-261T00:61:00Z",
                                 "26-261", "", "2026-261T00:00:00+03:00"])
def test_parse_hapi_time_rejects(bad):
    with pytest.raises(ValueError):
        parse_hapi_time(bad)


# ---- pitfall 2: freshness from /info ---------------------------------------------------
def test_info_window_reads_start_and_stop():
    a, b = info_window({"startDate": "2011-06-27T23:57:50Z", "stopDate": "2012-318T07:39:28Z"})
    assert a == datetime(2011, 6, 27, 23, 57, 50, tzinfo=UTC)
    assert b == datetime(2012, 11, 13, 7, 39, 28, tzinfo=UTC)  # ALTEA_P5M stopped in 2012


# ---- pitfalls 3/4: units copied, fills -> None -----------------------------------------
def test_fill_values():
    assert is_fill("-1e+31", "-1.0E31")              # CDAWeb, numeric re-formatting
    assert is_fill("1e31", "1e31") and is_fill("1.0E31", "1e31")
    assert is_fill("null", "null")                   # iSWA declares the *string* "null"
    assert not is_fill("0.0137", "null")
    assert not is_fill("-1.0E30", "-1.0E31")
    assert not is_fill("123", None)


def test_convert_cell():
    dbl = Param("DOSE", "double", "uGy/min", "-1.0E31", "")
    assert convert_cell("-1.0E31", dbl) is None
    assert convert_cell("", dbl) is None
    assert convert_cell("0.090", dbl) == pytest.approx(0.09)
    nul = Param("dose_rate", "double", "cGy/day", "null", "")
    assert convert_cell("null", nul) is None
    t = Param("Time", "isotime", "UTC", None, "")
    assert convert_cell("2026-261T00:00:00Z", t) == "2026-09-18T00:00:00Z"
    s = Param("LT_GEO", "string", "$H:$M:$S", "99:99:99", "")
    assert convert_cell("99:99:99", s) is None and convert_cell("07:12:00", s) == "07:12:00"


def test_parse_csv_doy_and_fill():
    params = [Param("Time", "isotime", "UTC", None, ""),
              Param("MagneticFldStrth", "double", "nT", "1e31", ""),
              Param("DipL-V", "double", "dimensionless", "1e31", "")]
    rows = parse_csv("2026-318T13:00:00Z,28122.59,1.8\n2026-318T13:01:00Z,1e31,1.8\n", params)
    assert rows == [["2026-11-14T13:00:00Z", 28122.59, 1.8], ["2026-11-14T13:01:00Z", None, 1.8]]
    with pytest.raises(ValueError):
        parse_csv("2026-318T13:00:00Z,1.0\n", params)  # wrong width is an error, not data


def test_hapi_json_error_body_is_not_data():
    body = ('{"HAPI":"2.0","status":{"code":1408,"message":"Bad request: time range of '
            '1032h0m0s exceeds maximum allowed duration of 31 days."},"data":[]}')
    with pytest.raises(HapiError) as ei:
        parse_csv(body, [Param("Time", "isotime", "UTC", None, "")])
    assert ei.value.code == 1408
    check_hapi_status('{"HAPI":"2.0","status":{"code":1200,"message":"OK"}}')  # no raise


def test_params_sorted_into_info_order():
    info = {"parameters": [{"name": "Time", "type": "isotime", "units": "UTC", "fill": None},
                           {"name": "Lat_GEO", "type": "double", "units": "deg", "fill": "1e31"},
                           {"name": "Lon_GEO", "type": "double", "units": "deg", "fill": "1e31"}]}
    ps = HapiClient.params_for(info, ["Lon_GEO", "Lat_GEO"])
    assert [p.name for p in ps] == ["Time", "Lat_GEO", "Lon_GEO"]
    assert ps[1].units == "deg" and ps[1].fill == "1e31"
    with pytest.raises(KeyError):
        HapiClient.params_for(info, ["Altitude"])


def test_dose_rate_conversions():
    assert hapi.to_ugy_per_day(0.0137, "cGy/day") == pytest.approx(137.0)
    assert hapi.to_ugy_per_day(0.185, "uGy/min") == pytest.approx(266.4)
    assert hapi.to_ugy_per_day(184.5, "uGy/day") == 184.5
    assert hapi.to_ugy_per_day(None, "cGy/day") is None
    with pytest.raises(ValueError):
        hapi.to_ugy_per_day(1.0, "mSv/day")  # dose equivalent is never silently converted


# ---- geometry --------------------------------------------------------------------------
def test_sscweb_re_km_matches_rest():
    # Same instant (2026-11-14T13:00Z) from SSCWeb REST (km) and SSCWeb HAPI (R_E).
    pairs = [(-80.70192712525755, -0.0126528540), (-4553.31907054573, -0.7138922621),
             (-5056.023001670837, -0.7927087125), (6804.601086960333, 1.0668595781)]
    for km, re_ in pairs:
        assert km / re_ == pytest.approx(hapi.SSCWEB_RE_KM, rel=2e-6)


def _geodetic_to_ecef(lat_deg, lon_deg, h):
    a, f = hapi.WGS84_A_KM, hapi.WGS84_F
    e2 = f * (2 - f)
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return ((n + h) * math.cos(lat) * math.cos(lon), (n + h) * math.cos(lat) * math.sin(lon),
            (n * (1 - e2) + h) * math.sin(lat))


@pytest.mark.parametrize("lat,lon,h", [(0, 0, 400), (51.6, -62.7, 420), (-23.4, 297.3 - 360, 415),
                                       (89.9, 10, 410)])
def test_ecef_to_geodetic_round_trip(lat, lon, h):
    la, lo, hh = hapi.ecef_to_geodetic_km(*_geodetic_to_ecef(lat, lon, h))
    assert la == pytest.approx(lat, abs=1e-9) and hh == pytest.approx(h, abs=1e-6)
    assert lo == pytest.approx(lon, abs=1e-9)


def test_equator_and_pole_known_answers():
    assert hapi.ecef_to_geodetic_km(6378.137 + 400, 0, 0)[2] == pytest.approx(400)
    b = 6378.137 * (1 - hapi.WGS84_F)
    lat, _, h = hapi.ecef_to_geodetic_km(0, 0, b + 400)
    assert lat == 90.0 and h == pytest.approx(400)


def test_lon_to_pm180():
    assert hapi.lon_to_pm180(297.3244) == pytest.approx(-62.6756)
    assert hapi.lon_to_pm180(268.9846) == pytest.approx(-91.0154)
    assert hapi.lon_to_pm180(0.0) == 0.0 and hapi.lon_to_pm180(180.0) == -180.0
    assert hapi.lon_to_pm180(359.9) == pytest.approx(-0.1) and hapi.lon_to_pm180(None) is None


# ---- SAA rule and aggregation ----------------------------------------------------------
def test_find_saa_passes():
    times = [f"2026-11-14T13:{m:02d}:00Z" for m in range(10)]
    b = [30000, 22000, 21000, 22999, 23000, 25000, 22000, None, 21000, 30000]
    passes = hapi.find_saa_passes(times, b, 23000, extra={"lat": list(range(10))})
    assert [(p["start"], p["stop"], p["duration_s"], p["n_samples"]) for p in passes] == [
        ("2026-11-14T13:01:00Z", "2026-11-14T13:03:00Z", 120, 3),   # 23000 is NOT < 23000
        ("2026-11-14T13:06:00Z", "2026-11-14T13:06:00Z", 0, 1),     # null ends the run
        ("2026-11-14T13:08:00Z", "2026-11-14T13:08:00Z", 0, 1)]
    assert passes[0]["min_B_nT"] == 21000 and passes[0]["time_of_min_B"] == times[2]
    assert passes[0]["lat_at_min_B"] == 2


def test_daily_aggregate_and_stats():
    t = ["2026-10-01T00:30:00Z", "2026-10-01T01:30:00Z", "2026-10-02T00:30:00Z"]
    d = hapi.daily_aggregate(t, [1.0, 3.0, None])
    assert d == [{"date": "2026-10-01", "n": 2, "mean": 2.0, "min": 1.0, "max": 3.0},
                 {"date": "2026-10-02", "n": 0, "mean": None, "min": None, "max": None}]
    s = hapi.summary_stats([4.0, None, 1.0, 3.0, 2.0])
    assert s["n"] == 4 and s["mean"] == 2.5 and s["median"] == 2.5 and s["min"] == 1.0
    assert s["max"] == 4.0 and s["p95"] == 4.0 and s["p05"] == 1.0


def test_daily_aggregate_lists_days_without_samples():
    # CRaTER 2026-08-29/30 had no sample at all; such days must stay visible as n=0, not vanish.
    t = ["2026-08-28T23:36:18Z", "2026-08-31T00:30:00Z"]
    d = hapi.daily_aggregate(t, [0.014, 0.013])
    assert [e["date"] for e in d] == ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"]
    assert d[1] == {"date": "2026-08-29", "n": 0, "mean": None, "min": None, "max": None}
    assert d[0]["n"] == 1 and d[3]["mean"] == 0.013
    assert hapi.daily_aggregate([], []) == []


def test_saa_pass_truncation_flag():
    times = [f"2026-11-14T13:{m:02d}:00Z" for m in range(8)]
    #        in-at-start  out    interior      out    null   in    in-at-end
    b = [22000, 30000, 21000, 21500, 30000, None, 22000, 22500]
    passes = hapi.find_saa_passes(times, b, 23000)
    assert [(p["start"], p["truncated"]) for p in passes] == [
        ("2026-11-14T13:00:00Z", True),    # touches the first sample of the window
        ("2026-11-14T13:02:00Z", False),   # bounded by samples >= threshold on both sides
        ("2026-11-14T13:06:00Z", True)]    # follows a null and touches the last sample


def test_msl_rtg_caveat_uses_window_medians():
    pp = {k: {"summary": {"median": v}} for k, v in
          (("dose_b_raw", 185.0), ("dose_b_rtg", 128.0), ("dose_e_total", 184.7))}
    (c,) = hapi._msl_rtg_caveat(pp)
    assert "185.0 to 128.0 µGy/day (57.0 µGy/day)" in c and "184.7 µGy/day" in c and "uGy" not in c
    pp["dose_e_total"]["summary"]["median"] = None
    assert hapi._msl_rtg_caveat(pp) == []


def test_enhanced_days_rule():
    daily = [{"date": "a", "mean": 0.0139, "max": 0.02}, {"date": "b", "mean": 0.2166, "max": 1.16},
             {"date": "c", "mean": None, "max": None}, {"date": "d", "mean": 0.0278, "max": 0.03}]
    out = hapi.enhanced_days(daily, 0.0139, 2.0)
    assert [e["date"] for e in out] == ["b"]  # 0.0278 is exactly 2x: not '> 2x'
    assert hapi.enhanced_days(daily, None, 2.0) == []


# ---- offline replay uses the shared RunContext cache -----------------------------------
def test_fetch_ipv4_offline_uses_ctx_cache(tmp_path):
    ctx = RunContext(out_dir=tmp_path / "out", cache_dir=tmp_path / "cache", offline=True)
    url, params = "https://example.invalid/hapi/info", {"id": "iss"}
    with pytest.raises(RuntimeError):
        fetch_bytes_ipv4(ctx, url, params)
    p = ctx._cache_path(url, params)
    p.parent.mkdir(parents=True)
    p.write_bytes(b'{"ok":1}')
    assert fetch_bytes_ipv4(ctx, url, params) == b'{"ok":1}'
    assert ctx.fetch_bytes(url, params) == b'{"ok":1}'  # same cache key as the shared contract


# ---- the frozen outputs ----------------------------------------------------------------
OUT = {p.stem: p for p in DEFAULT_OUT_DIR.glob("hapi_*.json")}
EXPECTED = {"hapi_iss_track": ("predicted", "prediction"), "hapi_iss_tepc": ("measured", "historical"),
            "hapi_crater_dose": ("measured", "historical"),
            "hapi_msl_rad_dose": ("measured", "historical")}


@pytest.mark.parametrize("sid", sorted(EXPECTED))
def test_frozen_snapshot(sid):
    if sid not in OUT:
        pytest.skip(f"{sid}.json not generated yet")
    s = json.loads(OUT[sid].read_text())
    validate_snapshot(s)
    assert s["id"].startswith("hapi_") and s["adapter"] == "hapi"
    assert (s["provenance"], s["freshness"]["kind"]) == EXPECTED[sid]
    d = s["data"]
    assert d["explainer"] and d["dataset"]["startDate"] and d["dataset"]["stopDate"]
    for meta in d["parameters"].values():
        assert "units" in meta  # copied from /info
    assert OUT[sid].stat().st_size < 200_000


def test_track_and_passes_are_consistent():
    if "hapi_iss_track" not in OUT:
        pytest.skip("not generated")
    d = json.loads(OUT["hapi_iss_track"].read_text())["data"]
    tr = d["track"]
    assert len({len(v) for v in tr.values()}) == 1 and d["saa_rule"]["basis"].startswith("design")
    assert all(-180 <= x < 180 for x in tr["lon_deg"] if x is not None)
    assert all(380 < x < 470 for x in tr["alt_km"] if x is not None)
    for p in d["saa_passes"]:
        assert p["min_B_nT"] < d["saa_rule"]["threshold_nT"] and p["start"] <= p["stop"]
        assert isinstance(p["truncated"], bool)
        # every pass minimum must sit over the South Atlantic / South America
        assert -60 < p["lat_deg_at_min_B"] < 5 and -110 < p["lon_deg_at_min_B"] < 30


def test_track_turns_stale_before_it_runs_out():
    if "hapi_iss_track" not in OUT:
        pytest.skip("not generated")
    s = json.loads(OUT["hapi_iss_track"].read_text())
    assert s["freshness"]["stale_after"] == "PT23H"
    stale_at = parse_hapi_time(s["retrieved_at"]).timestamp() + 23 * 3600
    assert stale_at <= parse_hapi_time(s["data"]["track_window"]["stop"]).timestamp() + 60


@pytest.mark.parametrize("sid", ["hapi_crater_dose", "hapi_msl_rad_dose"])
def test_deep_space_daily_series_is_calendar_complete(sid):
    if sid not in OUT:
        pytest.skip("not generated")
    d = json.loads(OUT[sid].read_text())["data"]
    for series in d["series"].values():
        dates = [e["date"] for e in series["daily"]]
        span = (datetime.fromisoformat(dates[-1]) - datetime.fromisoformat(dates[0])).days + 1
        assert len(dates) == span == len(set(dates))  # one entry per calendar day, no gaps
        empty = [e["date"] for e in series["daily"] if e["n"] == 0]
        assert set(d["days_without_samples"]) <= set(empty)
