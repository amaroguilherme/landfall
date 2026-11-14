import json
from pathlib import Path

import pytest

from engine import NOAA_S_THRESHOLDS_PFU, EngineError, evaluate_rule, load_snapshot, s_level

FIX = json.loads((Path(__file__).parent / "fixtures" / "engine_fixtures.json").read_text(encoding="utf-8"))
RULES = {r["id"]: r for r in FIX["thresholds"]}
NOW = 412 * 86400 + 14 * 3600 + 20 * 60


def ev(rule_id, value, env="iss", **kw):
    return evaluate_rule(RULES[rule_id], value, env, NOW, **kw)


@pytest.mark.parametrize("flux,level", [
    (9.99, 0), (10, 1), (99.9, 1), (100, 2), (999.999, 2), (1e3, 3), (1e4, 4), (99999.9, 4),
    (1e5, 5), (1e7, 5), (0, 0), (-1, 0),
])
def test_s_level_boundaries(flux, level):
    assert s_level(flux) == level


def test_s_level_thresholds_match_noaa_snapshot():
    snap = load_snapshot("swpc_s_scale")
    if snap is None:
        pytest.skip("web/public/data/swpc_s_scale.json not present")
    levels = sorted(snap["data"]["levels"], key=lambda lv: lv["n"])
    assert tuple(lv["threshold_pfu"] for lv in levels) == NOAA_S_THRESHOLDS_PFU
    assert [lv["n"] for lv in levels] == [1, 2, 3, 4, 5]


def test_ceiling_lt_with_approach():
    # pel_career_effective_dose: compliant when value < 600 mSv; approaching when value >= 480.
    assert ev("pel_career_effective_dose", 479.9)["status"] == "within"
    f = ev("pel_career_effective_dose", 480)
    assert (f["status"], f["severity"], f["margin"]) == ("approaching", "caution", 120)  # 600 - 480
    f = ev("pel_career_effective_dose", 600)  # lt: 600 is NOT < 600
    assert (f["status"], f["severity"], f["margin"]) == ("outside", "warning", 0)
    assert ev("pel_career_effective_dose", 750)["margin"] == -150  # 600 - 750


def test_ceiling_le_boundary_is_compliant():
    # [V2 6004] "no more than 3 mmHg": 3.0 is compliant (but past the 2.7 fixture watch level).
    assert ev("pel_cabin_ppco2_1h", 3.0)["status"] == "approaching"
    assert ev("pel_cabin_ppco2_1h", 3.01)["status"] == "outside"
    assert ev("pel_cabin_ppco2_1h", 2.69)["status"] == "within"


def test_floor_ge_with_approach():
    # [V1 4001] "at or above 32.9": 32.9 compliant; approaching when value <= 34.0 (fixture).
    assert ev("ffd_vo2max_microgravity_eva", 34.01)["status"] == "within"
    assert ev("ffd_vo2max_microgravity_eva", 34.0)["status"] == "approaching"
    f = ev("ffd_vo2max_microgravity_eva", 32.9)
    assert (f["status"], f["margin"]) == ("approaching", 0.0)  # 32.9 - 32.9
    f = ev("ffd_vo2max_microgravity_eva", 32.8)
    assert f["status"] == "outside" and f["margin"] < 0       # 32.8 - 32.9


def test_ffd_demo_environment_flips_verdict():
    # CM-2 VO2max 35.1: within the microgravity EVA floor, outside the surface EVA floor.
    assert ev("ffd_vo2max_microgravity_eva", 35.1, "iss")["status"] == "within"
    assert ev("ffd_vo2max_surface_eva", 35.1, "mars_surface")["status"] == "outside"
    f = ev("ffd_vo2max_surface_eva", 35.1, "iss")
    assert (f["status"], f["severity"], f["margin"]) == ("not_applicable", "nominal", None)
    assert ev("ffd_vo2max_microgravity_eva", 35.1, "lunar_surface")["status"] == "not_applicable"


def test_unit_mismatch_raises_and_is_never_converted():
    with pytest.raises(EngineError) as e:
        ev("pel_career_effective_dose", {"value": 0.6, "unit": "Sv"})
    assert e.value.code == "unit_mismatch"
    with pytest.raises(EngineError) as e:
        ev("pel_career_effective_dose", {"value": 100})  # no unit at all
    assert e.value.code == "unit_mismatch"
    with pytest.raises(EngineError) as e:  # raised even where the rule is not applicable
        ev("ffd_vo2max_surface_eva", {"value": 35.1, "unit": "mL/kg/min"}, "iss")
    assert e.value.code == "unit_mismatch"
    ok = ev("ffd_vo2max_surface_eva", {"value": 35.1, "unit": "ml/min/kg", "variable": "vo2max"}, "mars_surface")
    assert ok["value"] == 35.1


def test_missing_and_stale():
    f = ev("pel_career_effective_dose", None)
    assert (f["status"], f["severity"]) == ("insufficient_data", "advisory")
    obs = {"variable": "cabin_ppco2_1h_mean", "value": 2.0, "unit": "mmHg"}
    assert ev("pel_cabin_ppco2_1h", dict(obs, t=NOW - 7201))["status"] == "stale"   # age 7201 > 7200
    assert ev("pel_cabin_ppco2_1h", dict(obs, t=NOW - 7200))["status"] == "within"  # age 7200 is fresh


def test_context_rule_never_above_advisory():
    for v in (300, 220):
        f = ev("ctx_reference_spe_design", v)
        assert f["severity"] == "advisory" and f["role"] == "context"


def test_ops_severity_by_level_and_eva():
    assert ev("ops_noaa_s1", 50)["severity"] == "advisory"               # S1 outside
    assert ev("ops_noaa_s3", 600)["severity"] == "advisory"              # approaching S3
    assert ev("ops_noaa_s3", 2500, "cislunar")["severity"] == "caution"   # S3, no EVA
    assert ev("ops_noaa_s3", 2500, "lunar_surface", ctx={"eva": True})["severity"] == "warning"
    assert ev("ops_noaa_s3", 2500, "mars_surface")["status"] == "not_applicable"


def test_engine_never_emits_emergency():
    for rule in RULES.values():
        for v in (-1e6, 0, 1e6):
            assert evaluate_rule(rule, v, "iss", NOW, ctx={"eva": True})["severity"] != "emergency"


def test_finding_shape_and_invalid_rules():
    f = ev("pel_career_effective_dose", 100)
    for key in ("rule_id", "tier", "category", "status", "severity", "value", "unit", "limit", "margin",
                "chip", "source", "why"):
        assert key in f
    assert "[V1 4030]" in f["why"] and f["chip"] == "NASA-published"
    with pytest.raises(EngineError) as e:
        evaluate_rule(dict(RULES["pel_career_effective_dose"], op="eq"), 1, "iss", NOW)
    assert e.value.code == "invalid_rule"
    with pytest.raises(EngineError):
        evaluate_rule(dict(RULES["pel_career_effective_dose"], limit="600"), 1, "iss", NOW)
    with pytest.raises(EngineError):
        ev("pel_career_effective_dose", True)


def test_target_category_and_max_severity_cap():
    dose = RULES["pel_career_effective_dose"]
    target = dict(dose, category="TARGET", max_severity="caution")
    assert evaluate_rule(target, 700, "iss", NOW)["severity"] == "caution"   # never warning
    assert evaluate_rule(target, 500, "iss", NOW)["severity"] == "advisory"  # approaching
    assert evaluate_rule(dict(dose, max_severity="advisory"), 700, "iss", NOW)["severity"] == "advisory"
    with pytest.raises(EngineError):
        evaluate_rule(dict(dose, max_severity="red"), 700, "iss", NOW)


def test_ops_level_prefers_explicit_s_level_field():
    s1 = RULES["ops_noaa_s1"]
    assert evaluate_rule(dict(s1, s_level=3), 50, "iss", NOW)["severity"] == "caution"


def test_stale_has_null_margin_because_nothing_was_compared():
    obs = {"variable": "cabin_ppco2_1h_mean", "value": 2.0, "unit": "mmHg"}
    f = ev("pel_cabin_ppco2_1h", dict(obs, t=NOW - 7201))
    assert (f["status"], f["severity"], f["margin"]) == ("stale", "advisory", None)
    assert ev("pel_cabin_ppco2_1h", dict(obs, t=NOW - 7200))["margin"] == 1.0
