"""Conformance vectors shared by the Python engine and the TypeScript port (SPEC section 6).

    uv run python -m engine.vectors            # regenerate engine/tests/vectors/*.json
    uv run python -m engine.vectors --random   # recompute engine/tests/vectors_random/*.json
    uv run python -m engine.vectors --check    # exit 1 if either set is out of date

Each file is a JSON array of {"name", "fn", "args", "expect"} or, for a call that must fail,
{"name", "fn", "args", "raises": "<EngineError code>"}. `args` are keyword arguments named
exactly as in SPEC section 5. Fixtures come from engine/tests/fixtures/engine_fixtures.json.
JSON has no NaN or infinity: an argument written {"$float": "NaN" | "Infinity" | "-Infinity"} is
decoded to that float before the call (decode_args), at any depth.

The randomized vectors (engine/tests/vectors_random/random_<fn>.json) keep their seeded inputs
frozen; --random recomputes their expectations with the current engine, migrates the arguments of
a function whose signature changed (rci and evaluate_personal lost the reliability r and the fixed
critical z), and draws seeded inputs for a function that has no random file yet.
"""

from __future__ import annotations

import copy
import json
import math
import random
import sys
from pathlib import Path
from statistics import NormalDist

from .cases import case_reduce, new_case
from .comms import comms_eta
from .errors import EngineError
from .fmt import fmt_num, format_met, met_to_iso
from .packet import build_ground_packet
from .rci import evaluate_personal, expected_false_alarms, rci
from .tdist import t_cdf, t_critical, t_quantile
from .thresholds import evaluate_rule, s_level

ENGINE_DIR = Path(__file__).resolve().parent
VECTORS_DIR = ENGINE_DIR / "tests" / "vectors"
RANDOM_DIR = ENGINE_DIR / "tests" / "vectors_random"
FIXTURES_PATH = ENGINE_DIR / "tests" / "fixtures" / "engine_fixtures.json"
RANDOM_SEED = 20261114

FUNCTIONS = {
    "evaluate_rule": evaluate_rule,
    "rci": rci,
    "evaluate_personal": evaluate_personal,
    "expected_false_alarms": expected_false_alarms,
    "t_cdf": t_cdf,
    "t_quantile": t_quantile,
    "t_critical": t_critical,
    "s_level": s_level,
    "new_case": new_case,
    "case_reduce": case_reduce,
    "build_ground_packet": build_ground_packet,
    "comms_eta": comms_eta,
    "format_met": format_met,
    "fmt_num": fmt_num,
    "met_to_iso": met_to_iso,
}

DAY = 86400
NOW = 412 * DAY + 14 * 3600 + 20 * 60  # MET 0412/14:20:00, the demo "now" (SPEC section 7)
NONFINITE = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}
NAN = {"$float": "NaN"}
INF = {"$float": "Infinity"}
NEG_INF = {"$float": "-Infinity"}


def load_fixtures() -> dict:
    return json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))


def decode_args(x: object) -> object:
    """Replace every {"$float": "NaN" | "Infinity" | "-Infinity"} by that float (SPEC section 6)."""
    if isinstance(x, dict):
        if len(x) == 1 and isinstance(x.get("$float"), str) and x["$float"] in NONFINITE:
            return NONFINITE[x["$float"]]
        return {k: decode_args(v) for k, v in x.items()}
    if isinstance(x, list):
        return [decode_args(v) for v in x]
    return x


def run(fn: str, args: dict) -> dict:
    """Execute one call; returns {"expect": result} or {"raises": code}."""
    try:
        res = {"expect": FUNCTIONS[fn](**decode_args(copy.deepcopy(args)))}
    except EngineError as exc:
        return {"raises": exc.code}
    json.dumps(res, allow_nan=False)  # the engine never returns NaN or infinity
    return res


def _rule(fx: dict, rule_id: str) -> dict:
    return next(r for r in fx["thresholds"] if r["id"] == rule_id)


def _ind(fx: dict, ind_id: str) -> dict:
    return next(i for i in fx["personal"]["indicators"] if i["id"] == ind_id)


def _env(fx: dict, env_id: str) -> dict:
    return next(e for e in fx["environments"] if e["id"] == env_id)


def build_vectors() -> dict[str, list[dict]]:
    fx = load_fixtures()
    out: dict[str, list[dict]] = {name: [] for name in FUNCTIONS}

    def add(fn: str, name: str, **args: object) -> dict:
        res = run(fn, args)
        vec = {"name": name, "fn": fn, "args": args, **res}
        out[fn].append(vec)
        return vec

    # ---- format_met / fmt_num / met_to_iso ----
    add("format_met", "zero", seconds=0)
    add("format_met", "demo_now_plus_7s", seconds=412 * DAY + 51607)
    add("format_met", "brief_literal_35644800_plus_51607", seconds=35644800 + 51607)
    add("format_met", "one_second_before_day_1", seconds=DAY - 1)
    add("format_met", "day_10000_not_truncated", seconds=10000 * DAY + 1)
    add("format_met", "fraction_floored", seconds=59.9)
    add("format_met", "negative_prelaunch", seconds=-5)
    add("format_met", "rejects_string", seconds="12")
    for x, dp in ((0.1 + 0.2, 3), (600.0, 3), (-0.0004, 3), (2.5, 0), (-2.5, 0), (0.125, 2),
                  (1234.5678, 3), (35.1, 3), (1e-7, 3), (99999999.9996, 3), (100.0, 1)):
        add("fmt_num", f"fmt_{x!r}_dp{dp}", x=x, dp=dp)
    add("fmt_num", "rejects_huge", x=1e16, dp=3)
    add("fmt_num", "rejects_scaled_at_2_53", x=1e13, dp=3)
    add("fmt_num", "accepts_scaled_below_2_53", x=9e12, dp=3)
    add("met_to_iso", "rejects_year_above_9999", t=1e12, mission_epoch=fx["mission_epoch"])
    add("met_to_iso", "epoch", t=0, mission_epoch=fx["mission_epoch"])
    add("met_to_iso", "demo_now", t=NOW, mission_epoch=fx["mission_epoch"])
    add("met_to_iso", "rejects_fractional_met", t=1.5, mission_epoch=fx["mission_epoch"])
    add("met_to_iso", "rejects_offset_epoch", t=0, mission_epoch="2035-01-01T00:00:00+00:00")

    # ---- s_level: NOAA boundaries ----
    for flux in (0, 9.99, 10, 99.9, 100, 999.999, 1e3, 1e4, 99999.9, 1e5, 1e7, -1):
        add("s_level", f"flux_{flux!r}", flux_pfu=flux)
    add("s_level", "rejects_null", flux_pfu=None)

    # ---- evaluate_rule ----
    dose = _rule(fx, "pel_career_effective_dose")
    for v in (100, 479.9, 480, 599.9, 600, 750):
        add("evaluate_rule", f"ceiling_lt_600_value_{v}", rule=dose, value=v, env_id="iss", t=NOW)
    co2 = _rule(fx, "pel_cabin_ppco2_1h")
    for v in (2.0, 2.7, 3.0, 3.01):
        add("evaluate_rule", f"ceiling_le_3_value_{v}", rule=co2, value=v, env_id="iss", t=NOW)
    vo2_mu = _rule(fx, "ffd_vo2max_microgravity_eva")
    vo2_sf = _rule(fx, "ffd_vo2max_surface_eva")
    for v in (40.0, 34.0, 32.9, 32.8):
        add("evaluate_rule", f"floor_ge_32_9_value_{v}", rule=vo2_mu, value=v, env_id="iss", t=NOW)
    add("evaluate_rule", "ffd_demo_cm2_microgravity_within", rule=vo2_mu, value=35.1, env_id="iss", t=NOW)
    add("evaluate_rule", "ffd_demo_cm2_surface_outside", rule=vo2_sf, value=35.1, env_id="mars_surface", t=NOW)
    add("evaluate_rule", "ffd_surface_not_applicable_on_iss", rule=vo2_sf, value=35.1, env_id="iss", t=NOW)
    add("evaluate_rule", "observation_dict_matching_unit", rule=vo2_sf,
        value={"crew_id": "CM-2", "variable": "vo2max", "value": 35.1, "unit": "ml/min/kg", "t": NOW - 3600},
        env_id="mars_surface", t=NOW)
    add("evaluate_rule", "unit_mismatch_raises", rule=dose, value={"value": 0.6, "unit": "Sv"}, env_id="iss", t=NOW)
    add("evaluate_rule", "missing_unit_raises", rule=dose, value={"value": 100}, env_id="iss", t=NOW)
    add("evaluate_rule", "variable_mismatch_raises", rule=dose,
        value={"variable": "vo2max", "value": 1, "unit": "mSv"}, env_id="iss", t=NOW)
    add("evaluate_rule", "null_value_insufficient", rule=dose, value=None, env_id="iss", t=NOW)
    add("evaluate_rule", "stale_observation", rule=co2,
        value={"variable": "cabin_ppco2_1h_mean", "value": 2.0, "unit": "mmHg", "t": NOW - 7201},
        env_id="iss", t=NOW)
    add("evaluate_rule", "fresh_at_exact_stale_limit", rule=co2,
        value={"variable": "cabin_ppco2_1h_mean", "value": 2.0, "unit": "mmHg", "t": NOW - 7200},
        env_id="iss", t=NOW)
    bmd = _rule(fx, "pol_bmd_hip")
    for v in (97, 95, 94.9):
        add("evaluate_rule", f"pol_percent_value_{v}", rule=bmd, value=v, env_id="mars_surface", t=NOW)
    ctx_rule = _rule(fx, "ctx_reference_spe_design")
    add("evaluate_rule", "context_outside_capped_advisory", rule=ctx_rule, value=300, env_id="iss", t=NOW)
    add("evaluate_rule", "context_approaching_capped_advisory", rule=ctx_rule, value=220, env_id="iss", t=NOW)
    s1, s3 = _rule(fx, "ops_noaa_s1"), _rule(fx, "ops_noaa_s3")
    add("evaluate_rule", "ops_s1_outside_advisory", rule=s1, value=50, env_id="iss", t=NOW)
    add("evaluate_rule", "ops_s3_approaching_advisory", rule=s3, value=600, env_id="iss", t=NOW)
    add("evaluate_rule", "ops_s3_outside_no_eva_caution", rule=s3, value=2500, env_id="cislunar", t=NOW)
    add("evaluate_rule", "ops_s3_outside_eva_warning", rule=s3, value=2500, env_id="lunar_surface", t=NOW,
        ctx={"eva": True})
    add("evaluate_rule", "ops_not_applicable_at_mars", rule=s3, value=2500, env_id="mars_surface", t=NOW)
    target = dict(dose, id="fixture_target", category="TARGET", max_severity="caution")
    add("evaluate_rule", "target_outside_caution_not_warning", rule=target, value=700, env_id="iss", t=NOW)
    add("evaluate_rule", "target_approaching_advisory", rule=target, value=500, env_id="iss", t=NOW)
    add("evaluate_rule", "max_severity_caps_tier_a", rule=dict(dose, max_severity="advisory"), value=700,
        env_id="iss", t=NOW)
    add("evaluate_rule", "ops_explicit_s_level_field", rule=dict(s1, s_level=3), value=50, env_id="iss", t=NOW)
    bad = dict(dose, op="eq")
    add("evaluate_rule", "invalid_op_raises", rule=bad, value=1, env_id="iss", t=NOW)
    add("evaluate_rule", "boolean_value_raises", rule=dose, value=True, env_id="iss", t=NOW)

    # ---- t distribution: CDF, quantile, two-tailed critical value ----
    for df in (1, 2, 5, 6, 13, 30, 60, 120, 1000, 1000000, 1.5, 2.5):
        for t in (0, 0.5, -0.5, 1, -1, 2.0, 4.221, -4.221, 10, -10, 1000.0):
            add("t_cdf", f"df_{df!r}_t_{t!r}", t=t, df=df)
    add("t_cdf", "t_above_1e150_log_space_df1", t=1e200, df=1)
    add("t_cdf", "t_above_1e150_log_space_negative_df1", t=-1e200, df=1)
    add("t_cdf", "t_above_1e150_df13_underflows_to_zero", t=-1e200, df=13)
    add("t_cdf", "t_largest_double_df1", t=-1.7976931348623157e308, df=1)
    add("t_cdf", "t_just_below_1e150", t=9.99e149, df=2)
    add("t_cdf", "t_below_1e_17_is_exactly_one_half", t=9e-18, df=13)
    add("t_cdf", "t_at_1e_17", t=1e-17, df=13)
    add("t_cdf", "negative_zero_is_one_half", t=-0.0, df=5)
    add("t_cdf", "crawford_howell_1998_worked_example_p_one_tailed", t=-17 / (10 * math.sqrt(16 / 15)), df=14)
    add("t_cdf", "df_zero_rejected", t=1.0, df=0)
    add("t_cdf", "df_below_one_rejected", t=1.0, df=0.5)
    add("t_cdf", "df_negative_rejected", t=1.0, df=-3)
    add("t_cdf", "df_above_1e6_rejected", t=1.0, df=1000001)
    add("t_cdf", "t_nan_rejected", t=NAN, df=5)
    add("t_cdf", "t_infinity_rejected", t=INF, df=5)
    add("t_cdf", "df_nan_rejected", t=1.0, df=NAN)
    add("t_cdf", "t_string_rejected", t="1", df=5)
    add("t_cdf", "df_boolean_rejected", t=1.0, df=True)
    add("t_cdf", "t_null_rejected", t=None, df=5)
    for df in (1, 6, 10, 13, 20, 30, 60, 120, 1000000):
        for p in (0.5, 0.75, 0.9, 0.95, 0.975, 0.99, 0.995, 0.999, 0.9995, 0.0005, 0.025, 1e-10):
            add("t_quantile", f"df_{df!r}_p_{p!r}", p=p, df=df)
    add("t_quantile", "p_just_above_one_half", p=0.5000001, df=13)
    add("t_quantile", "non_integer_df", p=0.9995, df=2.5)
    add("t_quantile", "beyond_2_pow_1000_rejected", p=1e-305, df=1)
    add("t_quantile", "tiny_p_df1_far_tail", p=1e-290, df=1)
    for p in (0, 1, -0.1, 1.5):
        add("t_quantile", f"p_{p!r}_rejected", p=p, df=13)
    add("t_quantile", "p_nan_rejected", p=NAN, df=13)
    add("t_quantile", "p_boolean_rejected", p=True, df=13)
    add("t_quantile", "df_zero_rejected", p=0.9, df=0)
    for df in list(range(1, 61)) + [100, 120, 1000, 1000000]:
        add("t_critical", f"alpha_0.001_df_{df}", alpha=0.001, df=df)
    for a in (0.2, 0.1, 0.05, 0.01, 0.002, 0.0005, 1e-6):
        add("t_critical", f"alpha_{a!r}_df_13", alpha=a, df=13)
    for a in (0, 1, -0.001, 1.5):
        add("t_critical", f"alpha_{a!r}_rejected", alpha=a, df=13)
    add("t_critical", "alpha_nan_rejected", alpha=NAN, df=13)
    add("t_critical", "alpha_string_rejected", alpha="0.001", df=13)
    add("t_critical", "df_nan_rejected", alpha=0.001, df=NAN)

    # ---- rci: the single-case test (Crawford & Howell 1998) ----
    base = [10, 12, 11, 13, 9, 12, 11]
    add("rci", "known_answer_increase", baseline=base, current=18)
    add("rci", "known_answer_decrease", baseline=base, current=5)
    add("rci", "not_reliable", baseline=base, current=13)
    add("rci", "n_below_min", baseline=base[:6], current=18)
    add("rci", "zero_sd", baseline=[7, 7, 7, 7, 7, 7, 7], current=9)
    add("rci", "nulls_skipped_then_too_short", baseline=[10, None, 12, 11, 13, 9, 12], current=18)
    add("rci", "no_current_reports_baseline_fields", baseline=base, current=None)
    add("rci", "one_value_mean_only", baseline=[10], current=12)
    add("rci", "empty_baseline", baseline=[], current=12)
    add("rci", "custom_alpha_0_05", baseline=base, current=15, alpha=0.05)
    add("rci", "min_baseline_n_override", baseline=base[:3], current=18, min_baseline_n=3)
    add("rci", "constant_float_baseline_is_zero_sd", baseline=[7.3] * 7, current=7.4)
    add("rci", "current_equals_mean_direction_none", baseline=[1, 3, 1, 3, 1, 3, 1, 3], current=2)
    ch_base = [60] * 7 + [40] * 7 + [50]  # n = 15, mean 50, SD 10: Crawford & Howell 1998, p. 483-484
    add("rci", "crawford_howell_1998_example_one_tailed_05_not_significant", baseline=ch_base, current=33, alpha=0.1)
    add("rci", "crawford_howell_1998_example_one_tailed_10_significant", baseline=ch_base, current=33, alpha=0.2)
    for df in range(6, 61):  # every df 6..60: a value just past the critical value, or just short of it
        b = [10 + 0.1 * ((7 * i) % 13) for i in range(df + 1)]
        probe = rci(b, None)
        k = probe["critical"] + (0.05 if df % 2 == 0 else -0.05)
        add("rci", f"df_{df}_{'just_past' if df % 2 == 0 else 'just_short_of'}_critical",
            baseline=b, current=probe["mean"] + k * probe["s_diff"])
    add("rci", "nan_current_rejected", baseline=base, current=NAN)
    add("rci", "nan_in_baseline_rejected", baseline=[10, 12, NAN, 13, 9, 12, 11, 10], current=12)
    add("rci", "infinite_current_rejected", baseline=base, current=INF)
    add("rci", "negative_infinite_in_baseline_rejected", baseline=base + [NEG_INF], current=12)
    add("rci", "sd_overflow_rejected", baseline=[1e308, -1e308] * 4, current=0)
    add("rci", "mean_overflow_rejected", baseline=[1e308] * 6 + [1.5e308], current=0)
    add("rci", "statistic_overflow_rejected", baseline=[0, 1e-150] * 4, current=1e300)
    add("rci", "squares_underflow_is_zero_sd", baseline=[0, 1e-300] * 4, current=1e300)
    for a in (0, 1, -0.5, 2):
        add("rci", f"alpha_{a!r}_rejected", baseline=base, current=12, alpha=a)
    add("rci", "alpha_nan_rejected", baseline=base, current=12, alpha=NAN)
    add("rci", "alpha_boolean_rejected", baseline=base, current=12, alpha=True)
    add("rci", "min_baseline_n_one_rejected", baseline=base, current=12, min_baseline_n=1)
    add("rci", "min_baseline_n_boolean_rejected", baseline=base, current=12, min_baseline_n=True)
    add("rci", "min_baseline_n_float_rejected", baseline=base, current=12, min_baseline_n=7.5)
    add("rci", "baseline_not_a_list_rejected", baseline="10,12,11", current=12)
    add("rci", "baseline_string_entry_rejected", baseline=[10, "12", 11, 13, 9, 12, 11], current=12)
    add("rci", "current_boolean_rejected", baseline=base, current=True)

    # ---- evaluate_personal ----
    cfg = fx["personal"]["rci"]
    pvt, sleep, skin, mood = (_ind(fx, i) for i in ("pvt_lapses", "sleep_duration", "skin_temp", "mood"))
    pvt_base = [1, 2, 1, 3, 2, 1, 2, 2, 1, 2, 3, 1, 2, 2]
    mood_base = [4, 4, 5, 4, 3, 4, 4, 5, 4, 4, 3, 4, 4, 5]
    add("evaluate_personal", "pvt_reliable_worse_caution", indicator=pvt, baseline=pvt_base, current=8, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_reliable_better_nominal", indicator=pvt,
        baseline=[6, 7, 6, 8, 7, 6, 7], current=0, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_within", indicator=pvt, baseline=pvt_base, current=3, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_within_where_old_rci_flagged", indicator=pvt, baseline=pvt_base, current=4, cfg=cfg,
        t=NOW)
    add("evaluate_personal", "pvt_insufficient_advisory", indicator=pvt, baseline=pvt_base[:5], current=8, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_no_current_advisory", indicator=pvt, baseline=pvt_base, current=None, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_zero_sd_advisory", indicator=pvt, baseline=[2] * 14, current=8, cfg=cfg, t=NOW)
    add("evaluate_personal", "sleep_decrease_worse", indicator=sleep,
        baseline=[7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3, 7.0], current=4.5, cfg=cfg, t=NOW)
    add("evaluate_personal", "sleep_increase_better_nominal", indicator=sleep,
        baseline=[7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3, 7.0], current=10.0, cfg=cfg, t=NOW)
    add("evaluate_personal", "sleep_observation_unit_mismatch", indicator=sleep,
        baseline=[7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3], current={"value": 270, "unit": "min"}, cfg=cfg, t=NOW)
    add("evaluate_personal", "skin_either_decrease_worse", indicator=skin,
        baseline=[33.1, 33.4, 33.0, 33.2, 33.3, 33.1, 33.2], current=31.0, cfg=cfg, t=NOW)
    add("evaluate_personal", "skin_either_increase_worse", indicator=skin,
        baseline=[33.1, 33.4, 33.0, 33.2, 33.3, 33.1, 33.2], current=35.5, cfg=cfg, t=NOW)
    add("evaluate_personal", "mood_non_alerting_worse_stays_nominal", indicator=mood,
        baseline=mood_base, current=1, cfg=cfg, t=NOW)
    add("evaluate_personal", "mood_non_alerting_better_nominal", indicator=mood,
        baseline=[2, 2, 3, 2, 1, 2, 2, 3, 2, 2, 1, 2, 2, 3], current=5, cfg=cfg, t=NOW)
    add("evaluate_personal", "mood_non_alerting_insufficient_stays_advisory", indicator=mood,
        baseline=mood_base[:4], current=1, cfg=cfg, t=NOW)
    add("evaluate_personal", "mood_non_alerting_within", indicator=mood, baseline=mood_base, current=4, cfg=cfg, t=NOW)
    add("evaluate_personal", "observations_as_inputs", indicator=pvt,
        baseline=[{"variable": "pvt_lapses", "value": v, "unit": "count", "t": i * DAY} for i, v in enumerate(pvt_base)],
        current={"variable": "pvt_lapses", "value": 8, "unit": "count", "t": NOW}, cfg=cfg, t=NOW)
    add("evaluate_personal", "reliability_r_ignored", indicator=dict(sleep, reliability_r={"value": 0.99}),
        baseline=[7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3, 7.0], current=4.5, cfg=cfg, t=NOW)
    add("evaluate_personal", "cfg_alpha_0_05", indicator=pvt, baseline=pvt_base, current=4,
        cfg=dict(cfg, alpha_two_tailed=0.05), t=NOW)
    add("evaluate_personal", "cfg_without_alpha_rejected", indicator=pvt, baseline=pvt_base, current=8,
        cfg={k: v for k, v in cfg.items() if k != "alpha_two_tailed"}, t=NOW)
    add("evaluate_personal", "cfg_alpha_out_of_range_rejected", indicator=pvt, baseline=pvt_base, current=8,
        cfg=dict(cfg, alpha_two_tailed=1.5), t=NOW)
    add("evaluate_personal", "nan_current_rejected", indicator=pvt, baseline=pvt_base, current=NAN, cfg=cfg, t=NOW)
    add("evaluate_personal", "nan_observation_value_rejected", indicator=pvt, baseline=pvt_base,
        current={"variable": "pvt_lapses", "value": NAN, "unit": "count", "t": NOW}, cfg=cfg, t=NOW)
    add("evaluate_personal", "baseline_sd_overflow_rejected", indicator=sleep,
        baseline=[1e307, -1e307, 1e307, -1e307, 1e307, -1e307, 1e307], current=0, cfg=cfg, t=NOW)
    # finite statistic (t = -0.577) but critical 6.4e279 x s_diff 8.7e99 overflows the band edge
    add("evaluate_personal", "band_edge_overflow_rejected", indicator=sleep, baseline=[0, 1e100], current=0,
        cfg=dict(cfg, alpha_two_tailed=1e-280, min_baseline_n=2), t=NOW)

    # ---- expected_false_alarms ----
    add("expected_false_alarms", "k10_30d", k_indicators=10, days=30, alpha=0.001)
    add("expected_false_alarms", "k10_30d_default_alpha", k_indicators=10, days=30)
    add("expected_false_alarms", "k8_alerting_indicators_one_day", k_indicators=8, days=1, alpha=0.001)
    add("expected_false_alarms", "k3_45d", k_indicators=3, days=45, alpha=0.001)
    add("expected_false_alarms", "k0", k_indicators=0, days=30, alpha=0.001)
    add("expected_false_alarms", "alpha_zero", k_indicators=8, days=30, alpha=0)
    add("expected_false_alarms", "negative_rejected", k_indicators=-1, days=30, alpha=0.001)
    add("expected_false_alarms", "alpha_above_one_rejected", k_indicators=8, days=30, alpha=1.5)
    add("expected_false_alarms", "alpha_nan_rejected", k_indicators=8, days=30, alpha=NAN)

    # ---- new_case ----
    case_def = fx["case"]
    st = add("new_case", "sleep_fixture_cm1", case_def=case_def, crew_id="CM-1")["expect"]
    add("new_case", "missing_tripwire_rejected", case_def={k: v for k, v in case_def.items() if k != "tripwire"},
        crew_id="CM-1")
    add("new_case", "rule_tripwire_needs_lookup",
        case_def=dict(case_def, tripwire={"reassess_after_s": 3600,
                                          "condition": {"rule_id": "pel_cabin_ppco2_1h", "op": "gt", "value": 3,
                                                        "of_last_n": 3, "at_least": 2}}),
        crew_id="CM-1")
    add("new_case", "rule_tripwire_with_lookup",
        case_def=dict(case_def, tripwire={"reassess_after_s": 3600,
                                          "condition": {"rule_id": "pel_cabin_ppco2_1h", "op": "gt", "value": 3,
                                                        "of_last_n": 3, "at_least": 2}}),
        crew_id="CM-1", lookup={"pel_cabin_ppco2_1h": {"variable": "cabin_ppco2_1h_mean", "unit": "mmHg"}})
    no_unit_tw = copy.deepcopy(case_def["tripwire"])
    del no_unit_tw["condition"]["unit"]
    add("new_case", "tripwire_unit_unresolved_rejected", case_def=dict(case_def, tripwire=no_unit_tw), crew_id="CM-1")
    add("new_case", "tripwire_unit_from_lookup", case_def=dict(case_def, tripwire=no_unit_tw), crew_id="CM-1",
        lookup={"pvt_lapses": {"variable": "pvt_lapses", "unit": "count"}})
    # environment-aware tripwire (SPEC 3.4 by_env): onboard rule at Mars, NOAA rule near Earth
    spe_like = dict(case_def, id="spe_fixture", triggers=[{"kind": "ops", "rule_id": "ops_noaa_s3"},
                                                          {"kind": "ops", "rule_id": "ops_onboard_proton_s3"}],
                    tripwire={"reassess_after_s": 21600,
                              "condition": {"rule_id": "ops_noaa_s3", "op": "ge", "value": 1000, "of_last_n": 3,
                                            "at_least": 2,
                                            "by_env": {"mars_surface": {"rule_id": "ops_onboard_proton_s3"}}}})
    ops_lookup = {r: {"variable": "proton_flux_10mev", "unit": "pfu"} for r in ("ops_noaa_s3", "ops_onboard_proton_s3")}
    add("new_case", "by_env_mars_watches_onboard_rule", case_def=spe_like, crew_id="CM-1", lookup=ops_lookup,
        env_id="mars_surface")
    add("new_case", "by_env_iss_keeps_base_rule", case_def=spe_like, crew_id="CM-1", lookup=ops_lookup, env_id="iss")
    add("new_case", "by_env_without_env_id_keeps_base_rule", case_def=spe_like, crew_id="CM-1", lookup=ops_lookup)
    swap = copy.deepcopy(case_def)
    swap["tripwire"]["condition"]["by_env"] = {"mars_surface": {"indicator_id": "sleep_duration", "op": "lt",
                                                                "value": 5}}
    add("new_case", "by_env_override_replaces_reference_variable_and_unit", case_def=swap, crew_id="CM-1",
        lookup={"sleep_duration": {"variable": "sleep_duration", "unit": "h"}}, env_id="mars_surface")
    add("new_case", "by_env_new_reference_unit_unresolved_rejected", case_def=swap, crew_id="CM-1",
        env_id="mars_surface")
    bad_by_env = copy.deepcopy(case_def)
    bad_by_env["tripwire"]["condition"]["by_env"] = ["mars_surface"]
    add("new_case", "by_env_not_an_object_rejected", case_def=bad_by_env, crew_id="CM-1", env_id="iss")
    bad_override = copy.deepcopy(case_def)
    bad_override["tripwire"]["condition"]["by_env"] = {"mars_surface": "ops_onboard_proton_s3"}
    add("new_case", "by_env_override_not_an_object_rejected", case_def=bad_override, crew_id="CM-1",
        env_id="mars_surface")
    add("new_case", "env_id_empty_rejected", case_def=case_def, crew_id="CM-1", env_id="")
    add("new_case", "env_id_number_rejected", case_def=case_def, crew_id="CM-1", env_id=5)

    # ---- case_reduce: happy path detected -> acting -> watch -> resolved ----
    finding = run("evaluate_personal", {"indicator": pvt, "baseline": pvt_base, "current": 8, "cfg": cfg,
                                        "t": NOW})["expect"]

    def step(name: str, state: dict, event: dict) -> dict | None:
        return add("case_reduce", name, state=state, event=event).get("expect")

    t0 = NOW
    s_ = step("open", st, {"type": "OPEN", "finding": finding, "t": t0})
    s_ = step("select_primary", s_, {"type": "SELECT", "countermeasure_id": "cm_primary", "t": t0 + 60})
    s_ = step("step_1", s_, {"type": "STEP", "step_id": "step_1", "t": t0 + 120})
    s_ = step("step_2_with_input", s_, {"type": "STEP", "step_id": "step_2", "t": t0 + 180,
                                        "input": {"variable": "sleep_duration", "value": 6.5, "unit": "h"}})
    s_ = step("duplicate_step_rejected", s_, {"type": "STEP", "step_id": "step_2", "t": t0 + 200})
    s_ = step("outcome_to_watch", s_, {"type": "OUTCOME", "text": "Shifted light schedule; nap taken.", "t": t0 + 300})
    watch_state = s_
    obs_ok = [{"crew_id": "CM-1", "variable": "pvt_lapses", "value": v, "unit": "count", "t": t0 + 300 + d * DAY}
              for d, v in ((1, 2), (2, 5), (3, 1))]
    s_ = step("tick_noop_no_obs", s_, {"type": "TICK", "t": t0 + 3600, "observations": []})
    s_ = step("tick_obs_day1", s_, {"type": "TICK", "t": t0 + 300 + DAY, "observations": obs_ok[:1]})
    s_ = step("tick_obs_day2_full_history", s_, {"type": "TICK", "t": t0 + 300 + 2 * DAY, "observations": obs_ok[:2]})
    s_ = step("tick_reassess_resolved", s_, {"type": "TICK", "t": t0 + 300 + 3 * DAY, "observations": obs_ok})
    step("tick_after_resolved_ignored", s_, {"type": "TICK", "t": t0 + 300 + 4 * DAY, "observations": []})
    step("dismiss_after_resolved_rejected", s_, {"type": "DISMISS", "reason": "late", "t": t0 + 300 + 4 * DAY})

    # ---- case_reduce: tripwire 2-of-3 -> escalated, judged only at reassess time (T+72 h) ----
    obs_bad = [{"crew_id": "CM-1", "variable": "pvt_lapses", "value": v, "unit": "count", "t": t0 + 300 + d * 43200}
               for d, v in ((1, 6), (2, 3), (3, 5))]
    other_crew = {"crew_id": "CM-2", "variable": "pvt_lapses", "value": 9, "unit": "count", "t": t0 + 400}
    pre_watch = {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 9, "unit": "count", "t": t0 + 250}
    s_ = step("tripwire_one_hit_stays_watch", watch_state,
              {"type": "TICK", "t": t0 + 300 + 43200, "observations": [other_crew, pre_watch] + obs_bad[:1]})
    s_ = step("tripwire_two_of_three_waits_for_reassess", s_,
              {"type": "TICK", "t": t0 + 300 + 3 * 43200, "observations": obs_bad})
    s_ = step("tripwire_two_of_three_escalated_at_reassess", s_,
              {"type": "TICK", "t": t0 + 300 + 3 * DAY, "observations": obs_bad})
    step("open_after_escalated_rejected", s_, {"type": "OPEN", "finding": finding, "t": t0 + 300 + 4 * DAY})
    vehicle_obs = {"crew_id": None, "variable": "pvt_lapses", "value": 7, "unit": "count", "t": t0 + 400}
    step("tick_vehicle_obs_crew_id_null_counts", watch_state,
         {"type": "TICK", "t": t0 + 500, "observations": [vehicle_obs]})
    step("malformed_state_raises", {"status": "watch"}, {"type": "TICK", "t": t0, "observations": []})

    # ---- case_reduce: invalid transitions / events ----
    step("select_from_idle_rejected", st, {"type": "SELECT", "countermeasure_id": "cm_primary", "t": t0})
    step("outcome_from_idle_rejected", st, {"type": "OUTCOME", "text": "x", "t": t0})
    step("unknown_event_rejected", st, {"type": "LAUNCH", "t": t0})
    nominal = dict(finding, severity="nominal")
    step("open_below_threshold_rejected", st, {"type": "OPEN", "finding": nominal, "t": t0})
    step("open_not_a_trigger_rejected", st, {"type": "OPEN", "finding": dict(finding, rule_id="mood"), "t": t0})
    opened = run("case_reduce", {"state": st, "event": {"type": "OPEN", "finding": finding, "t": t0}})["expect"]
    step("unknown_countermeasure_rejected", opened, {"type": "SELECT", "countermeasure_id": "cm_x", "t": t0 + 1})
    step("select_alternative", opened, {"type": "SELECT", "countermeasure_id": "cm_alt_1", "t": t0 + 1})
    step("time_reversed_rejected", opened, {"type": "SELECT", "countermeasure_id": "cm_primary", "t": t0 - 1})
    step("dismiss_without_reason_rejected", opened, {"type": "DISMISS", "reason": " ", "t": t0 + 2})
    step("dismiss_from_detected", opened, {"type": "DISMISS", "reason": "Sensor off-wrist; repeat test normal.",
                                           "t": t0 + 2})
    step("tick_outside_watch_ignored", opened, {"type": "TICK", "t": t0 + 5, "observations": obs_bad})
    step("tick_unit_mismatch_rejected", watch_state,
         {"type": "TICK", "t": t0 + 300 + DAY,
          "observations": [dict(obs_ok[0], unit="lapses")]})
    # atomic: the valid observation listed before the bad one must not survive the rejection
    step("tick_unit_mismatch_after_valid_obs_is_atomic", watch_state,
         {"type": "TICK", "t": t0 + 300 + 2 * DAY,
          "observations": [obs_ok[0], dict(obs_ok[1], unit="lapses")]})
    step("tick_valid_obs_then_mismatch_outside_window_accepted", watch_state,
         {"type": "TICK", "t": t0 + 300 + DAY,
          "observations": [obs_ok[0], dict(obs_ok[1], unit="lapses")]})

    # ---- build_ground_packet ----
    esc_state = s_
    obs_all = [
        {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 6, "unit": "count", "t": t0 + 43500,
         "source": "app", "provenance": "simulated"},
        {"crew_id": "CM-1", "variable": "resting_hr", "value": 58, "unit": "bpm", "t": t0 + 43000,
         "source": "band", "provenance": "simulated"},
        {"crew_id": "CM-1", "variable": "mood", "value": 2, "unit": "score_1_5", "t": t0 + 43000,
         "source": "app", "provenance": "simulated"},
        {"crew_id": "CM-1", "variable": "skin_temp", "value": 33.2, "unit": "°C", "t": t0 + 43000,
         "source": "band", "provenance": "simulated"},
        {"crew_id": "CM-2", "variable": "resting_hr", "value": 61, "unit": "bpm", "t": t0 + 43000},
        {"crew_id": "CM-1", "variable": "urine_volume_24h", "value": 1480, "unit": "mL", "t": t0 + 43000},
        {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 7, "unit": "count", "t": t0 + 10 * DAY},
    ]
    pk = dict(case_state=esc_state, observations=obs_all, env_id="mars_surface", t=t0 + 2 * DAY,
              mission_epoch=fx["mission_epoch"])
    add("build_ground_packet", "default_consent_mood_excluded", consent={}, **pk)
    add("build_ground_packet", "mood_false_excluded", consent={"mood": False}, **pk)
    add("build_ground_packet", "mood_true_included", consent={"mood": True}, **pk)
    add("build_ground_packet", "variable_withheld", consent={"resting_hr": False}, **pk)
    add("build_ground_packet", "mood_truthy_string_not_consent", consent={"mood": "yes"}, **pk)
    add("build_ground_packet", "bad_vital_unit_raises", consent={},
        **dict(pk, observations=[dict(obs_all[1], unit="beats")]))
    add("build_ground_packet", "unknown_unit_raises", consent={},
        **dict(pk, observations=[dict(obs_all[0], unit="lapses")]))
    add("build_ground_packet", "bad_epoch_raises", consent={}, **dict(pk, mission_epoch="2035-01-01"))
    typed_state = dict(esc_state, spec=dict(esc_state["spec"], escalation={
        "ground_packet": True, "observations": ["renal_symptoms", "shelter_entry", "dose_bfo"]}))
    typed_obs = [
        {"crew_id": "CM-1", "variable": "renal_symptoms", "value": False, "unit": "yes/no", "t": t0 + 100},
        {"crew_id": "CM-1", "variable": "renal_symptoms", "value": 1, "unit": "yes/no", "t": t0 + 200},
        {"crew_id": "CM-1", "variable": "shelter_entry", "value": t0 + 150, "unit": "MET", "t": t0 + 160},
        {"crew_id": "CM-1", "variable": "dose_bfo", "value": 12.5, "unit": "mGy-Eq", "t": t0 + 170},
    ]
    add("build_ground_packet", "boolean_met_and_mgy_eq_values", consent={},
        **dict(pk, case_state=typed_state, observations=typed_obs))
    add("build_ground_packet", "yes_no_rejects_other_numbers", consent={},
        **dict(pk, case_state=typed_state, observations=[dict(typed_obs[0], value=2)]))
    flux_state = dict(esc_state, spec=dict(esc_state["spec"], escalation={
        "ground_packet": True, "observations": ["proton_flux_10mev", "pvt_lapses"]}))
    flux_obs = [
        {"crew_id": None, "variable": "proton_flux_10mev", "value": 1100.0, "unit": "pfu", "t": t0 + 100,
         "source": "replay", "provenance": "simulated"},
        {"crew_id": "CM-2", "variable": "pvt_lapses", "value": 9, "unit": "count", "t": t0 + 100},
        {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 6, "unit": "count", "t": t0 + 100},
        {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 5, "unit": "count", "t": t0 + 100},
    ]
    add("build_ground_packet", "vehicle_obs_included_and_ids_unique", consent={},
        **dict(pk, case_state=flux_state, observations=flux_obs))

    # ---- comms_eta ----
    iss, mars = _env(fx, "iss"), _env(fx, "mars_surface")
    table = fx["comms_table"]
    add("comms_eta", "iss_fixed_max", env=iss, t=NOW)
    add("comms_eta", "mars_before_window_interpolated", env=mars, t=35510400 + 43200, comms_table=table)
    add("comms_eta", "mars_window_start_blocked", env=mars, t=35596800, comms_table=table)
    add("comms_eta", "mars_demo_now_blocked_chained", env=mars, t=NOW, comms_table=table)
    add("comms_eta", "mars_second_window_blocked", env=mars, t=36000000, comms_table=table)
    add("comms_eta", "mars_window_end_unblocked", env=mars, t=36620400, comms_table=table)
    add("comms_eta", "mars_after_last_sample_clamped", env=mars, t=36720000 + DAY, comms_table=table)
    add("comms_eta", "mars_without_table_raises", env=mars, t=NOW)
    add("comms_eta", "iss_ignores_windows", env=iss, t=NOW, comms_table=table)
    return out


def _dump(vectors: list[dict]) -> str:
    return json.dumps(vectors, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def write_vectors(vectors_dir: Path = VECTORS_DIR) -> list[Path]:
    vectors_dir = Path(vectors_dir)
    vectors_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for fn, vecs in build_vectors().items():
        p = vectors_dir / f"{fn}.json"
        p.write_text(_dump(vecs), encoding="utf-8")
        paths.append(p)
    return paths


def check_vectors(vectors_dir: Path = VECTORS_DIR) -> list[str]:
    """Names of vector files that differ from a fresh regeneration (empty list = up to date)."""
    stale = []
    fresh = build_vectors()
    for fn, vecs in fresh.items():
        p = Path(vectors_dir) / f"{fn}.json"
        if not p.exists() or json.loads(p.read_text(encoding="utf-8")) != json.loads(_dump(vecs)):
            stale.append(p.name)
    extra = {p.stem for p in Path(vectors_dir).glob("*.json")} - set(fresh)
    stale.extend(sorted(f"{e}.json (not generated)" for e in extra))
    return stale


# ---------------------------------------------------------------------------- randomized vectors


def _alpha_from_z(z: object) -> object:
    """An old vector's fixed critical z -> the two-tailed alpha it stood for; invalid values stay invalid."""
    if isinstance(z, bool) or not isinstance(z, (int, float)) or not math.isfinite(z) or z <= 0:
        return z
    return float(f"{2.0 * (1.0 - NormalDist().cdf(z)):.6g}")


def _upgrade_state(state: object) -> None:
    """Give an old case state the spec fields new_case now writes (env_id, condition.ref_id), as null."""
    spec = state.get("spec") if isinstance(state, dict) else None
    if not isinstance(spec, dict):
        return
    spec.setdefault("env_id", None)
    tw = spec.get("tripwire")
    if isinstance(tw, dict) and isinstance(tw.get("condition"), dict):
        tw["condition"].setdefault("ref_id", None)


def migrate_args(fn: str, args: dict) -> dict:
    """Bring a frozen random input to the current signatures (idempotent)."""
    a = copy.deepcopy(args)
    if fn == "rci":
        a.pop("r", None)
        if "critical_z" in a:
            a["alpha"] = _alpha_from_z(a.pop("critical_z"))
    elif fn == "evaluate_personal":
        cfg = a.get("cfg")
        if isinstance(cfg, dict) and "critical_z" in cfg:
            cfg = dict(cfg)
            z = cfg.pop("critical_z")
            cfg.setdefault("alpha_two_tailed", _alpha_from_z(z))
            a["cfg"] = cfg
    elif fn == "case_reduce":
        _upgrade_state(a.get("state"))
    elif fn == "build_ground_packet":
        _upgrade_state(a.get("case_state"))
    return a


def _random_df(rng: random.Random) -> object:
    u = rng.random()
    if u < 0.45:
        return rng.randint(1, 120)
    if u < 0.7:
        return round(rng.uniform(1.0, 50.0), 3)
    if u < 0.8:
        return rng.choice([1, 2, 1000, 1000000, 999999.5])
    if u < 0.9:
        return rng.randint(121, 100000)
    return rng.choice([0, -1, 0.5, 0.999, 1000001, True, None, "13", NAN, INF])


def _random_unit_interval(rng: random.Random, invalid: list) -> object:
    u = rng.random()
    if u < 0.4:
        return rng.random() or 0.5
    if u < 0.6:
        return 10.0 ** -rng.uniform(1.0, 300.0)
    if u < 0.8:
        return 1.0 - 10.0 ** -rng.uniform(1.0, 15.0)
    if u < 0.9:
        return rng.choice([0.5, 0.001, 0.0005, 0.05, 0.9995, 0.999999])
    return rng.choice(invalid)


def random_inputs(fn: str, n: int = 160) -> list[dict]:
    """Seeded inputs for a function that has no random file yet (only the t distribution so far)."""
    rng = random.Random(f"{RANDOM_SEED}:{fn}")
    out = []
    for _ in range(n):
        df = _random_df(rng)
        if fn == "t_cdf":
            u = rng.random()
            if u < 0.5:
                t = rng.uniform(-8.0, 8.0)
            elif u < 0.8:
                t = rng.choice([-1.0, 1.0]) * 10.0 ** rng.uniform(-20.0, 300.0)
            elif u < 0.9:
                t = rng.choice([0, -0.0, 1e-17, 9e-18, 1e150, 1.0000001e150, 1.7976931348623157e308,
                                -1.7976931348623157e308])
            else:
                t = rng.choice([NAN, INF, NEG_INF, "1", True, None])
            out.append({"t": t, "df": df})
        elif fn == "t_quantile":
            out.append({"p": _random_unit_interval(rng, [0, 1, -0.1, 1.5, NAN, True, "0.5"]), "df": df})
        elif fn == "t_critical":
            out.append({"alpha": _random_unit_interval(rng, [0, 1, -1, NAN, INF, False, "0.001"]), "df": df})
        else:  # pragma: no cover - every other function has frozen inputs
            raise ValueError(f"no random input generator for {fn}")
    return out


def build_random_vectors(random_dir: Path = RANDOM_DIR) -> dict[str, list[dict]]:
    """Frozen inputs (migrated) with fresh expectations, plus seeded inputs for new functions."""
    out: dict[str, list[dict]] = {}
    for fn in FUNCTIONS:
        p = Path(random_dir) / f"random_{fn}.json"
        if p.exists():
            frozen = json.loads(p.read_text(encoding="utf-8"))
            items = [(v["name"], migrate_args(fn, v["args"])) for v in frozen]
        else:
            items = [(f"rand_{i}", a) for i, a in enumerate(random_inputs(fn))]
        out[fn] = [{"name": name, "fn": fn, "args": args, **run(fn, args)} for name, args in items]
    return out


def _dump_random(vectors: list[dict]) -> str:
    # one vector per line, as the frozen files were written
    return "[\n" + ",\n".join(json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                               for v in vectors) + "\n]\n"


def write_random_vectors(random_dir: Path = RANDOM_DIR) -> list[Path]:
    random_dir = Path(random_dir)
    random_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for fn, vecs in build_random_vectors(random_dir).items():
        p = random_dir / f"random_{fn}.json"
        p.write_text(_dump_random(vecs), encoding="utf-8")
        paths.append(p)
    return paths


def check_random_vectors(random_dir: Path = RANDOM_DIR) -> list[str]:
    """Random files whose expectations (or migrated inputs) differ from the current engine."""
    if not Path(random_dir).is_dir():
        return []
    stale = []
    for fn, vecs in build_random_vectors(random_dir).items():
        p = Path(random_dir) / f"random_{fn}.json"
        if not p.exists() or json.loads(p.read_text(encoding="utf-8")) != json.loads(_dump_random(vecs)):
            stale.append(p.name)
    extra = {p.stem for p in Path(random_dir).glob("*.json")} - {f"random_{fn}" for fn in FUNCTIONS}
    stale.extend(sorted(f"{e}.json (no such function)" for e in extra))
    return stale


def main(argv: list[str]) -> int:
    if "--check" in argv:
        stale = check_vectors() + check_random_vectors()
        if stale:
            print("out of date: " + ", ".join(stale))
            return 1
        print("vectors up to date")
        return 0
    paths = write_random_vectors() if "--random" in argv else write_vectors()
    total = sum(len(json.loads(p.read_text(encoding="utf-8"))) for p in paths)
    where = RANDOM_DIR if "--random" in argv else VECTORS_DIR
    print(f"wrote {total} vectors to {len(paths)} files in {where}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
