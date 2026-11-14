import json
from pathlib import Path

import pytest

from engine import EngineError, comms_eta, format_met

FIX = json.loads((Path(__file__).parent / "fixtures" / "engine_fixtures.json").read_text(encoding="utf-8"))
ENV = {e["id"]: e for e in FIX["environments"]}
TABLE = FIX["comms_table"]
NOW = 412 * 86400 + 14 * 3600 + 20 * 60


def test_blocked_inside_conjunction_window_with_resumes_at():
    r = comms_eta(ENV["mars_surface"], NOW, TABLE)
    assert r["blocked"] is True and r["reason"] == "solar_conjunction"
    # the fixture has two touching windows [35596800, 36000000) and [36000000, 36620400): chained
    assert r["resumes_at"] == 36620400
    assert format_met(r["resumes_at"] - NOW) == "11/06:00:00"  # F.6.1 f: no leading zeros in the day field
    assert r["round_trip_s"] == 2 * r["one_way_s"]


def test_window_edges_are_half_open():
    assert comms_eta(ENV["mars_surface"], 35596800, TABLE)["blocked"] is True      # start included
    assert comms_eta(ENV["mars_surface"], 35596799, TABLE)["blocked"] is False
    assert comms_eta(ENV["mars_surface"], 36620400, TABLE)["blocked"] is False     # end excluded


def test_light_time_interpolated_and_round_trip_is_double():
    # samples (35510400, 1330.0) -> (35683200, 1334.0); a quarter of the way is 1331.0
    r = comms_eta(ENV["mars_surface"], 35510400 + 43200, TABLE)
    assert r["one_way_s"] == 1331.0 and r["round_trip_s"] == 2662.0 and not r["blocked"]
    assert r["earliest_reply_s"] == 2662.0
    assert comms_eta(ENV["mars_surface"], 0, TABLE)["one_way_s"] == 1330.0         # clamped
    assert comms_eta(ENV["mars_surface"], 10 ** 9, TABLE)["one_way_s"] == 1300.0   # clamped


def test_earliest_reply_when_blocked():
    r = comms_eta(ENV["mars_surface"], NOW, TABLE)
    after = comms_eta(ENV["mars_surface"], r["resumes_at"], TABLE)
    assert r["earliest_reply_s"] == (r["resumes_at"] - NOW) + after["round_trip_s"]


def test_iss_never_blocked_and_uses_max():
    r = comms_eta(ENV["iss"], NOW, TABLE)
    assert (r["one_way_s"], r["round_trip_s"], r["blocked"], r["resumes_at"]) == (1.0, 2.0, False, None)


def test_missing_table_raises():
    with pytest.raises(EngineError) as e:
        comms_eta(ENV["mars_surface"], NOW)
    assert e.value.code == "missing_comms_table"
