"""Tier B: the single-case test of Crawford & Howell (1998) against the crewmember's own baseline."""

import json
import math
import random
from pathlib import Path

import pytest

from engine import EngineError, evaluate_personal, expected_false_alarms, rci, t_cdf, t_critical

FIX = json.loads((Path(__file__).parent / "fixtures" / "engine_fixtures.json").read_text(encoding="utf-8"))
CFG = FIX["personal"]["rci"]
IND = {i["id"]: i for i in FIX["personal"]["indicators"]}
BASE = [10, 12, 11, 13, 9, 12, 11]


def close(a, b):
    return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)


def test_single_case_t_known_answer():
    # n = 7, sum = 78 -> mean = 78/7 = 11.142857...; SS = 880 - 78^2/7 = 76/7; sd = sqrt((76/7)/6) = sqrt(38/21)
    # s_diff = sd * sqrt(1 + 1/7) = sqrt(38/21) * sqrt(8/7) = 1.4380637...; df = 6
    # rc = (18 - 78/7) / s_diff = (48/7) / 1.4380637 = 4.7683165 < t_critical(0.001, 6) = 5.9588 -> not reliable
    r = rci(BASE, 18)
    assert (r["status"], r["method"], r["n"], r["df"], r["alpha"]) == ("ok", "crawford_howell_1998", 7, 6, 0.001)
    assert close(r["mean"], 78 / 7) and close(r["sd"], math.sqrt(38 / 21))
    assert close(r["s_diff"], math.sqrt(38 / 21) * math.sqrt(8 / 7))
    assert close(r["rc"], (48 / 7) / (math.sqrt(38 / 21) * math.sqrt(8 / 7)))
    assert round(r["rc"], 4) == 4.7683 and round(r["critical"], 3) == 5.959
    assert r["reliable"] is False and r["direction"] == "increase"
    # the same day against a 14-day baseline of the same spread is reliable: the critical value falls with n
    r14 = rci(BASE * 2, 18)
    assert r14["df"] == 13 and round(r14["critical"], 3) == 4.221 and r14["reliable"] is True


def test_decrease_alpha_and_boundary():
    r = rci(BASE, 2)
    assert r["rc"] < -r["critical"] and r["reliable"] and r["direction"] == "decrease"
    assert rci(BASE, 13)["reliable"] is False
    # a looser alpha lowers the critical value: 15 is reliable at 0.05 (critical 2.447), not at 0.001
    assert rci(BASE, 15, alpha=0.05)["reliable"] is True and rci(BASE, 15)["reliable"] is False
    # the band edge mean + critical * s_diff is where |rc| reaches the critical value
    r = rci(BASE, None)
    edge = r["mean"] + r["critical"] * r["s_diff"]
    assert rci(BASE, edge)["rc"] == pytest.approx(r["critical"], rel=1e-15)
    assert rci(BASE, edge * (1 + 1e-9))["reliable"] is True


def test_insufficient_data_and_reported_fields():
    r = rci(BASE[:6], 18)  # n = 6 < min_baseline_n = 7
    assert (r["status"], r["reason"], r["rc"], r["critical"], r["reliable"]) == \
        ("insufficient_data", "baseline_too_short", None, None, False)
    assert r["df"] == 5 and r["s_diff"] is not None  # computable, so reported
    r = rci([7] * 7, 9)  # sd == 0: no division by zero
    assert (r["status"], r["reason"], r["sd"], r["s_diff"], r["rc"]) == ("insufficient_data", "zero_sd", 0.0, 0.0, None)
    r = rci([10, None, 12, 11, 13, 9, 12], 18)  # None skipped -> n = 6
    assert (r["n"], r["reason"]) == (6, "baseline_too_short")
    r = rci(BASE, None)
    assert r["reason"] == "no_current" and r["critical"] == t_critical(0.001, 6) and r["rc"] is None
    r = rci([10], 12)
    assert (r["mean"], r["sd"], r["df"], r["s_diff"]) == (10.0, None, None, None)
    r = rci([], 12)
    assert (r["n"], r["mean"], r["direction"]) == (0, None, None)
    assert rci(BASE[:3], 18, min_baseline_n=3)["status"] == "ok"


def test_never_returns_nan_or_infinity():
    for bad in ([10, 12, math.nan, 13, 9, 12, 11], BASE + [math.inf], BASE + [-math.inf]):
        with pytest.raises(EngineError) as e:
            rci(bad, 12)
        assert e.value.code == "invalid_argument"
    for cur in (math.nan, math.inf, True, "12"):
        with pytest.raises(EngineError):
            rci(BASE, cur)
    for overflow in ([1e308, -1e308] * 4, [1e308] * 6 + [1.5e308]):
        with pytest.raises(EngineError):
            rci(overflow, 0)
    with pytest.raises(EngineError):
        rci([0, 1e-150] * 4, 1e300)  # finite inputs and SD, infinite statistic
    for alpha in (0, 1, -0.5, 2, math.nan, True, "0.001"):
        with pytest.raises(EngineError):
            rci(BASE, 12, alpha=alpha)
    for n in (1, True, 7.5, "7"):
        with pytest.raises(EngineError):
            rci(BASE, 12, min_baseline_n=n)


def test_constant_float_baseline_is_zero_sd_not_a_huge_reliable_change():
    # [7.3]*7: true SD is 0, but the float mean is 1 ulp off, so a computed SD would be ~1e-15
    # and any change would come out "reliable" with rc ~ 1e14. The engine tests constancy exactly.
    for c in (7.3, 0.1, 1430.7, 33.1, 7):
        r = rci([c] * 7, c + 0.1)
        assert (r["status"], r["reason"], r["sd"], r["rc"]) == ("insufficient_data", "zero_sd", 0.0, None), c


def test_personal_direction_handling():
    pvt_base = [1, 2, 1, 3, 2, 1, 2, 2, 1, 2, 3, 1, 2, 2]
    # worse = increase: a reliable rise is caution, a reliable fall is a reliable change but nominal
    f = evaluate_personal(IND["pvt_lapses"], pvt_base, 8, CFG)
    assert (f["tier"], f["category"], f["status"], f["severity"]) == ("B", "PERSONAL", "reliable_change", "caution")
    assert f["limit"] > f["rci"]["mean"] and f["margin"] < 0
    assert f["rci"]["method"] == "crawford_howell_1998" and f["rci"]["df"] == 13
    assert f["limit"] == pytest.approx(f["rci"]["mean"] + f["rci"]["critical"] * f["rci"]["s_diff"], rel=1e-15)
    assert "t = " in f["why"] and "critical 4.221 (df 13, two-tailed alpha 0.001)" in f["why"]
    f = evaluate_personal(IND["pvt_lapses"], [6, 7, 6, 8, 7, 6, 7], 0, CFG)
    assert (f["status"], f["severity"], f["direction"]) == ("reliable_change", "nominal", "decrease")
    # worse = decrease: a reliable fall in sleep is caution, a reliable rise is nominal
    sleep_base = [7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3, 7.0]
    f = evaluate_personal(IND["sleep_duration"], sleep_base, 4.5, CFG)
    assert (f["status"], f["severity"]) == ("reliable_change", "caution")
    assert f["limit"] < f["rci"]["mean"] and f["margin"] < 0
    f = evaluate_personal(IND["sleep_duration"], sleep_base, 10.0, CFG)
    assert (f["status"], f["severity"]) == ("reliable_change", "nominal")
    # worse = either: both directions are worse
    skin_base = [33.1, 33.4, 33.0, 33.2, 33.3, 33.1, 33.2]
    assert evaluate_personal(IND["skin_temp"], skin_base, 31.0, CFG)["severity"] == "caution"
    assert evaluate_personal(IND["skin_temp"], skin_base, 35.5, CFG)["severity"] == "caution"
    # within the band
    assert evaluate_personal(IND["pvt_lapses"], pvt_base, 3, CFG)["status"] == "within"


def test_non_alerting_reliable_change_is_nominal_and_never_warning():
    mood_base = [4, 4, 5, 4, 3, 4, 4, 5, 4, 4, 3, 4, 4, 5]
    f = evaluate_personal(IND["mood"], mood_base, 1, CFG)
    assert f["status"] == "reliable_change" and f["severity"] == "nominal"  # shown, never an alert
    assert f["private"] is True and f["role"] == "context" and "never alerts" in f["why"]
    assert evaluate_personal(IND["mood"], mood_base[:3], 1, CFG)["severity"] == "advisory"  # missing data stays
    for v in (-100, 0, 1, 100):
        for ind in IND.values():
            sev = evaluate_personal(ind, [1, 2, 3, 2, 1, 2, 3], v, CFG)["severity"]
            assert sev in ("nominal", "advisory", "caution")
            if not ind["alerting"]:
                assert sev == "nominal"


def test_reliability_r_is_not_used():
    sleep_base = [7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3, 7.0]
    plain = evaluate_personal(IND["sleep_duration"], sleep_base, 4.5, CFG)
    for rr in ({"value": 0.99}, {"value": 0.0}, {"value": None}, "junk"):
        assert evaluate_personal(dict(IND["sleep_duration"], reliability_r=rr), sleep_base, 4.5, CFG) == plain
    assert "r" not in plain["rci"] and "critical_z" not in plain["rci"] and "sem" not in plain["rci"]
    with pytest.raises(EngineError) as e:
        evaluate_personal(IND["sleep_duration"], sleep_base, 4.5, {k: v for k, v in CFG.items() if k != "alpha_two_tailed"})
    assert e.value.code == "invalid_rule"


def test_personal_insufficient_and_units():
    f = evaluate_personal(IND["pvt_lapses"], [1, 2, 3], 8, CFG)
    assert (f["status"], f["severity"]) == ("insufficient_data", "advisory")
    with pytest.raises(EngineError) as e:
        evaluate_personal(IND["sleep_duration"], [7.0] * 7, {"value": 270, "unit": "min"}, CFG)
    assert e.value.code == "unit_mismatch"
    with pytest.raises(EngineError) as e:
        evaluate_personal(IND["sleep_duration"], [7.0, 7.1] * 4, math.nan, CFG)
    assert e.value.code == "invalid_argument"


def test_expected_false_alarms_known_answer():
    # 8 alerting indicators x 30 days x alpha 0.001 = 0.24 chance flags; per day 0.008 -> one every 125 days.
    # Only changes in the worse direction raise a caution: half, one every 250 days.
    r = expected_false_alarms(8, 30, 0.001)
    assert close(r["expected"], 0.24) and close(r["per_day"], 0.008) and r["every_n_days"] == 125.0
    assert close(r["expected_cautions"], 0.12) and close(r["cautions_per_day"], 0.004)
    assert r["caution_every_n_days"] == 250.0
    assert r["text"] == "one false flag every 125 days on average, counting chance changes in either direction"
    assert r["caution_text"] == ("one false caution every 250 days on average: only a chance change in the "
                                 "worse direction raises a caution")
    assert "independent" in r["assumes"]
    assert expected_false_alarms(8, 30) == r  # default alpha is 0.001
    assert expected_false_alarms(3, 45)["text"].startswith("one false flag every 333.3 days")
    z = expected_false_alarms(0, 30)
    assert (z["expected"], z["every_n_days"], z["caution_every_n_days"], z["text"], z["caution_text"]) == \
        (0, None, None, "no false flags expected", "no false cautions expected")
    with pytest.raises(EngineError):
        expected_false_alarms(-1, 30)


# ------------------------------------------------------------------ the audit finding, and its fix


def test_old_jacobson_truax_arithmetic_overstated_reliability():
    """The audit's claim, computed exactly: RC = (x - mean) / (SD sqrt(2) sqrt(1 - r)) with SD from the
    crewmember's own 14-day baseline flagged |RC| >= 3.29, i.e. |x - mean| >= 3.29 sqrt(2 (1 - r)) SD.
    For a new day from the same normal distribution, (x - mean) / (SD sqrt(1 + 1/n)) ~ t(n - 1), so the
    realized two-sided rate is P(|T_13| >= 3.29 sqrt(2 (1 - r)) / sqrt(15/14)): far above the 0.1% printed."""
    n = 14
    rate = {r: 2 * t_cdf(-3.29 * math.sqrt(2 * (1 - r)) / math.sqrt(1 + 1 / n), n - 1) for r in (0.5, 0.7, 0.8)}
    assert rate[0.8] == pytest.approx(0.0656, abs=5e-4)   # 66x the nominal 0.001 (the two PVT indicators)
    assert rate[0.7] == pytest.approx(0.0286, abs=5e-4)   # 29x (every other alerting indicator)
    assert rate[0.5] == pytest.approx(0.0073, abs=5e-4)   # even r = 0.5 was 7x: 3.29 ignores the SD's own noise
    per_day = 2 * rate[0.8] + 6 * rate[0.7]               # the 8 alerting indicators of personal.json
    assert 3.2 < 1 / per_day < 3.4                        # one chance flag every ~3.3 days, printed as every 125
    # the single-case test's critical value makes the same rate exactly alpha
    c = t_critical(0.001, n - 1)
    assert 2 * t_cdf(-c, n - 1) == pytest.approx(0.001, rel=1e-8)


def _normal_trials(n_trials: int, n: int, seed: str, rho: float = 0.0):
    """Yield (baseline, current) with day-to-day noise N(0, 1); rho > 0 makes it AR(1) (stationary)."""
    rng = random.Random(seed)
    scale = math.sqrt(1 - rho * rho)
    for _ in range(n_trials):
        x = rng.gauss(0.0, 1.0)
        days = [x]
        for _ in range(n):
            x = rho * x + scale * rng.gauss(0.0, 1.0)
            days.append(x)
        yield days[:n], days[n]


def test_monte_carlo_false_alarm_rate_equals_alpha():
    """Seeded stdlib Monte Carlo through the engine itself: 400,000 normal baselines of n = 14 plus one new
    day. The two-sided flag rate must be alpha = 0.001 (expected 400, sd ~20) and the worse-direction
    (caution) rate alpha / 2."""
    trials = 400_000
    flags = ups = 0
    for base, cur in _normal_trials(trials, 14, "landfall-tierb-mc-20261114"):
        r = rci(base, cur)
        if r["reliable"]:
            flags += 1
            ups += r["direction"] == "increase"
    assert 0.0008 <= flags / trials <= 0.0012, flags
    assert 0.00035 <= ups / trials <= 0.00065, ups
    assert 0.0006 <= flags / trials <= 0.0014  # the band asked for in the brief


def _fixed_baseline_ar1(trials: int, rho: float, seed: str, n: int = 14, days_after: int = 31) -> list:
    """Chance-flag rate by day after the baseline, laid out like the app (web/src/app/evaluate.ts): a fixed
    n-day baseline (the scenario's MET days 368-381), then each of the next `days_after` days (382-412)
    tested against it, with stationary AR(1) day-to-day noise and no real change. rates[g] is the rate g
    days after the last baseline day (rates[0] is unused). The baseline mean, s_diff and critical value come
    from the engine's rci(); a day is flagged when |x - mean| > critical * s_diff, i.e. |rc| > critical."""
    rng = random.Random(seed)
    scale = math.sqrt(1 - rho * rho)
    hits = [0] * (days_after + 1)
    for _ in range(trials):
        x = rng.gauss(0.0, 1.0)
        days = [x]
        for _ in range(n - 1 + days_after):
            x = rho * x + scale * rng.gauss(0.0, 1.0)
            days.append(x)
        r = rci(days[:n], None)
        mean, edge = r["mean"], r["critical"] * r["s_diff"]
        for gap in range(1, days_after + 1):
            if abs(days[n - 1 + gap] - mean) > edge:
                hits[gap] += 1
    return [h / trials for h in hits]


def test_monte_carlo_autocorrelation_and_skew_raise_the_rate():
    """The caveat in personal.json, quantified (no real change anywhere), laid out like the scenario: a fixed
    14-day baseline, then each of the 31 days after it. Lag-1 autocorrelation 0.5 gives about 1.4x alpha on
    the first day after the baseline (the only day an earlier version of this test simulated), about 4x from
    a week on and about 3.7x averaged over the 31 days; 0.9 gives about 2.5x on the first day and about 67x on
    average. Skewed counts (Poisson with mean 1) give about 5x alpha, and every chance flag is a rise: about
    10x the printed caution rate (alpha / 2) for an indicator whose worse direction is a rise. This is why
    the printed rate is a lower bound."""
    alpha = 0.001
    r5 = _fixed_baseline_ar1(100_000, 0.5, "landfall-ar1-fixed-0.5-20261114")
    assert 1.05 < r5[1] / alpha < 1.9, r5[1]                  # about 1.4x on the first day after the baseline
    week_on = sum(r5[7:]) / len(r5[7:])
    assert 3.3 < week_on / alpha < 4.6, week_on               # about 4x from a week on
    assert 3.2 < sum(r5[1:]) / 31 / alpha < 4.3, r5           # about 3.7x averaged over the 31 days
    r9 = _fixed_baseline_ar1(100_000, 0.9, "landfall-ar1-fixed-0.9-20261114")
    assert 1.8 < r9[1] / alpha < 3.4, r9[1]                   # about 2.5x on the first day
    assert 55 < sum(r9[1:]) / 31 / alpha < 80, r9             # about 67x averaged over the 31 days
    rng = random.Random("landfall-poisson-20261114")
    limit = math.exp(-1.0)

    def poisson_1() -> int:
        k, prod = 0, rng.random()
        while prod >= limit:
            k += 1
            prod *= rng.random()
        return k

    trials = 200_000
    flags = ups = 0
    for _ in range(trials):
        base = [poisson_1() for _ in range(14)]
        r = rci(base, poisson_1())
        if r["reliable"]:
            flags += 1
            ups += r["direction"] == "increase"
    assert 4.0 < flags / trials / alpha < 6.5, flags          # about 5x alpha
    assert ups >= 0.99 * flags, (ups, flags)                  # a count near 0 cannot fall 4.2 s_diff below a mean near 1
    assert 8.0 < ups / trials / (alpha / 2) < 13.0, ups       # about 10x the printed caution rate
