import pytest

from engine import EngineError, fmt_num, format_met, met_to_iso


def test_format_met_zero():
    assert format_met(0) == "0/00:00:00"


def test_format_met_demo_known_answer():
    # Day 412 starts at 412 * 86400 = 35,596,800 s (day 0 starts at MET 0).
    # 14:20:07 = 14*3600 + 20*60 + 7 = 50,400 + 1,200 + 7 = 51,607 s.
    assert format_met(412 * 86400 + 51607) == "412/14:20:07"
    assert 412 * 86400 + 51607 == 35648407


def test_format_met_brief_literal_input_is_day_413():
    # The task brief wrote 35644800 + 51607. 35,644,800 is NOT 412 * 86400 (that is 35,596,800):
    # 35,644,800 + 51,607 = 35,696,407 = 413 * 86400 (35,683,200) + 13,207 s -> 03:40:07.
    assert format_met(35644800 + 51607) == "413/03:40:07"


def test_format_met_edges():
    assert format_met(86399) == "0/23:59:59"
    assert format_met(86400) == "1/00:00:00"
    assert format_met(10000 * 86400) == "10000/00:00:00"  # never truncated
    assert format_met(59.9) == "0/00:00:59"  # floored
    assert format_met(-5) == "-0/00:00:05"
    assert format_met(-0.0) == "0/00:00:00"


def test_format_met_follows_appendix_f_f_6_1_f():
    # NASA-STD-3001 Vol 2 Appendix F F.6.1 f: "leading zeros are suppressed in day field ...
    # (e.g., MET 57/14:08:33, or MET 1089/13:03:01)". The same format serves day-count durations.
    assert format_met(57 * 86400 + 14 * 3600 + 8 * 60 + 33) == "57/14:08:33"
    assert format_met(1089 * 86400 + 13 * 3600 + 3 * 60 + 1) == "1089/13:03:01"
    assert format_met(11 * 86400 + 5 * 3600 + 59 * 60 + 51) == "11/05:59:51"   # a countdown
    assert format_met(39 * 60 + 41) == "0/00:39:41"
    with pytest.raises(EngineError) as e:
        format_met(None)
    assert e.value.code == "invalid_argument"
    with pytest.raises(EngineError):
        format_met(True)  # booleans are not numbers (JS parity)


def test_fmt_num_is_half_away_from_zero_not_bankers():
    assert fmt_num(2.5, 0) == "3"      # Python f"{2.5:.0f}" gives "2"
    assert fmt_num(-2.5, 0) == "-3"
    assert fmt_num(0.125, 2) == "0.13"  # exactly representable tie; f-string gives "0.12"
    assert fmt_num(0.1 + 0.2) == "0.3"
    assert fmt_num(600.0) == "600"      # repr would give "600.0"
    assert fmt_num(-0.0004) == "0"      # no "-0"
    assert fmt_num(1e-7) == "0"         # repr would give "1e-07"
    assert fmt_num(1234.5678) == "1234.568"
    with pytest.raises(EngineError):
        fmt_num(1e16)


def test_met_to_iso():
    assert met_to_iso(0, "2035-01-01T00:00:00Z") == "2035-01-01T00:00:00Z"
    # 412 days after 2035-01-01: 365 days -> 2036-01-01, +47 days -> 2036-02-17 (2036 is a leap
    # year but February 29 is not crossed). 14:20:00 of that day.
    assert met_to_iso(412 * 86400 + 14 * 3600 + 20 * 60, "2035-01-01T00:00:00Z") == "2036-02-17T14:20:00Z"
    for bad in ("2035-01-01", "2035-01-01T00:00:00+00:00", "2035-01-01T00:00:00.000Z", "2035-02-30T00:00:00Z"):
        with pytest.raises(EngineError):
            met_to_iso(0, bad)
    with pytest.raises(EngineError):
        met_to_iso(1.5, "2035-01-01T00:00:00Z")


def test_fmt_num_rejects_scaled_values_at_2_53_and_met_to_iso_range():
    # k = floor(|x| * 10^dp + 0.5) must stay < 2^53 so the JS port's double arithmetic is exact
    assert fmt_num(9e12, 3) == "9000000000000"
    for x, dp in ((1e13, 3), (1e10, 6), (1e16, 0)):
        with pytest.raises(EngineError) as e:
            fmt_num(x, dp)
        assert e.value.code == "invalid_argument"
    for t in (1e12, -1e11):  # outside years 0001-9999: an EngineError, never OverflowError
        with pytest.raises(EngineError) as e:
            met_to_iso(t, "2035-01-01T00:00:00Z")
        assert e.value.code == "invalid_argument"
