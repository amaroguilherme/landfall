import json
import math
from pathlib import Path

import pytest

from engine import EngineError, evaluate_personal, expected_false_alarms, rci

FIX = json.loads((Path(__file__).parent / "fixtures" / "engine_fixtures.json").read_text(encoding="utf-8"))
CFG = FIX["personal"]["rci"]
IND = {i["id"]: i for i in FIX["personal"]["indicators"]}
BASE = [10, 12, 11, 13, 9, 12, 11]


def close(a, b):
    return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)


def test_rci_known_answer():
    # n = 7, sum = 78 -> mean = 78/7 = 11.142857142857...
    # sum of squares: sum(x^2) = 100+144+121+169+81+144+121 = 880; n*mean^2 = 78^2/7 = 6084/7
    #   SS = 880 - 6084/7 = 76/7 = 10.857142857...
    # sample variance = SS/(n-1) = (76/7)/6 = 38/21 = 1.8095238...; sd = sqrt(38/21) = 1.3451854...
    # sem = sd * sqrt(1 - 0.8) = 1.3451854 * 0.4472136 = 0.6015852...
    # s_diff = sqrt(2) * sem = 0.8507700... (= sd * sqrt(0.4))
    # rc = (18 - 11.142857) / 0.8507700 = 6.857143 / 0.8507700 = 8.0599...  -> |rc| >= 3.29: reliable
    r = rci(BASE, 18, 0.8)
    assert r["status"] == "ok" and r["n"] == 7
    assert close(r["mean"], 78 / 7)
    assert close(r["sd"], math.sqrt(38 / 21))
    assert close(r["sem"], math.sqrt(38 / 21) * math.sqrt(0.2))
    assert close(r["s_diff"], math.sqrt(2) * math.sqrt(38 / 21) * math.sqrt(0.2))
    assert close(r["rc"], (18 - 78 / 7) / (math.sqrt(38 / 21) * math.sqrt(0.4)))
    assert round(r["rc"], 4) == 8.0599
    assert r["reliable"] is True and r["direction"] == "increase"


def test_rci_decrease_and_not_reliable():
    # current 5: rc = (5 - 11.142857) / 0.8507700 = -7.2204 -> reliable, decrease
    r = rci(BASE, 5, 0.8)
    assert round(r["rc"], 4) == -7.2204 and r["reliable"] and r["direction"] == "decrease"
    # current 13: rc = (13 - 11.142857) / 0.8507700 = 2.1829 < 3.29 -> not reliable
    r = rci(BASE, 13, 0.8)
    assert round(r["rc"], 4) == 2.1829 and not r["reliable"] and r["direction"] == "increase"
    # same data at critical_z 1.96 (p < .05) would call it reliable
    assert rci(BASE, 13, 0.8, critical_z=1.96)["reliable"] is True


def test_rci_insufficient_data():
    r = rci(BASE[:6], 18, 0.8)  # n = 6 < min_baseline_n = 7
    assert (r["status"], r["reason"], r["rc"], r["reliable"]) == ("insufficient_data", "baseline_too_short", None, False)
    r = rci([7] * 7, 9, 0.8)  # sd == 0: no division by zero
    assert (r["status"], r["reason"], r["sd"]) == ("insufficient_data", "zero_sd", 0.0)
    r = rci([10, None, 12, 11, 13, 9, 12], 18, 0.8)  # None skipped -> n = 6
    assert (r["n"], r["reason"]) == (6, "baseline_too_short")
    assert rci(BASE, None, 0.8)["reason"] == "no_current"
    for bad_r in (1.0, -0.1, 1.5):
        with pytest.raises(EngineError):
            rci(BASE, 18, bad_r)


def test_personal_direction_handling():
    pvt_base = [1, 2, 1, 3, 2, 1, 2, 2, 1, 2, 3, 1, 2, 2]
    # worse = increase: a reliable rise is caution, a reliable fall is a reliable change but nominal
    f = evaluate_personal(IND["pvt_lapses"], pvt_base, 8, CFG)
    assert (f["tier"], f["category"], f["status"], f["severity"]) == ("B", "PERSONAL", "reliable_change", "caution")
    assert f["limit"] > f["rci"]["mean"] and f["margin"] < 0
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
    # within the reliable-change band
    assert evaluate_personal(IND["pvt_lapses"], pvt_base, 3, CFG)["status"] == "within"


def test_personal_never_warning_and_non_alerting_capped():
    f = evaluate_personal(IND["mood"], [4, 4, 5, 4, 3, 4, 4], 1, CFG)
    assert f["status"] == "reliable_change" and f["severity"] == "advisory"  # not caution
    assert f["private"] is True
    for v in (-100, 0, 1, 100):
        for ind in IND.values():
            sev = evaluate_personal(ind, [1, 2, 3, 2, 1, 2, 3], v, CFG)["severity"]
            assert sev in ("nominal", "advisory", "caution")
            if not ind["alerting"]:
                assert sev in ("nominal", "advisory")


def test_personal_insufficient_and_units():
    f = evaluate_personal(IND["pvt_lapses"], [1, 2, 3], 8, CFG)
    assert (f["status"], f["severity"]) == ("insufficient_data", "advisory")
    with pytest.raises(EngineError) as e:
        evaluate_personal(IND["sleep_duration"], [7.0] * 7, {"value": 270, "unit": "min"}, CFG)
    assert e.value.code == "unit_mismatch"


def test_expected_false_alarms_known_answer():
    # 10 indicators x 30 days x alpha 0.001 = 0.3 expected; per day 10 x 0.001 = 0.01 -> every 100 days
    r = expected_false_alarms(10, 30, 0.001)
    assert close(r["expected"], 0.3) and close(r["per_day"], 0.01)
    assert r["every_n_days"] == 100.0
    assert r["text"] == "one false alarm every 100 days"
    assert expected_false_alarms(10, 30) == r  # default alpha is 0.001
    # 3 indicators: 1 / 0.003 = 333.33 days
    assert expected_false_alarms(3, 45)["text"] == "one false alarm every 333.3 days"
    z = expected_false_alarms(0, 30)
    assert (z["expected"], z["every_n_days"], z["text"]) == (0, None, "no false alarms expected")


def test_constant_float_baseline_is_zero_sd_not_a_huge_reliable_change():
    # [7.3]*7: true SD is 0, but the float mean is 1 ulp off, so a computed SD would be ~1e-15
    # and any change would come out "reliable" with rc ~ 1e14. The engine tests constancy exactly.
    for c in (7.3, 0.1, 1430.7, 33.1, 7):
        r = rci([c] * 7, c + 0.1, 0.7)
        assert (r["status"], r["reason"], r["sd"], r["rc"]) == ("insufficient_data", "zero_sd", 0.0, None), c
