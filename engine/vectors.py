"""Conformance vectors shared by the Python engine and the TypeScript port (SPEC section 6).

    uv run python -m engine.vectors            # regenerate engine/tests/vectors/*.json
    uv run python -m engine.vectors --check    # exit 1 if the committed files are out of date

Each file is a JSON array of {"name", "fn", "args", "expect"} or, for a call that must fail,
{"name", "fn", "args", "raises": "<EngineError code>"}. `args` are keyword arguments named
exactly as in SPEC section 5. Fixtures come from engine/tests/fixtures/engine_fixtures.json.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

from .cases import case_reduce, new_case
from .comms import comms_eta
from .errors import EngineError
from .fmt import fmt_num, format_met, met_to_iso
from .packet import build_ground_packet
from .rci import evaluate_personal, expected_false_alarms, rci
from .thresholds import evaluate_rule, s_level

ENGINE_DIR = Path(__file__).resolve().parent
VECTORS_DIR = ENGINE_DIR / "tests" / "vectors"
FIXTURES_PATH = ENGINE_DIR / "tests" / "fixtures" / "engine_fixtures.json"

FUNCTIONS = {
    "evaluate_rule": evaluate_rule,
    "rci": rci,
    "evaluate_personal": evaluate_personal,
    "expected_false_alarms": expected_false_alarms,
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


def load_fixtures() -> dict:
    return json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))


def run(fn: str, args: dict) -> dict:
    """Execute one call; returns {"expect": result} or {"raises": code}."""
    try:
        return {"expect": FUNCTIONS[fn](**copy.deepcopy(args))}
    except EngineError as exc:
        return {"raises": exc.code}


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

    # ---- rci ----
    base = [10, 12, 11, 13, 9, 12, 11]
    add("rci", "known_answer_increase", baseline=base, current=18, r=0.8)
    add("rci", "known_answer_decrease", baseline=base, current=5, r=0.8)
    add("rci", "not_reliable", baseline=base, current=13, r=0.8)
    add("rci", "n_below_min", baseline=base[:6], current=18, r=0.8)
    add("rci", "zero_sd", baseline=[7, 7, 7, 7, 7, 7, 7], current=9, r=0.8)
    add("rci", "nulls_skipped_then_too_short", baseline=[10, None, 12, 11, 13, 9, 12], current=18, r=0.8)
    add("rci", "no_current", baseline=base, current=None, r=0.8)
    add("rci", "r_zero", baseline=base, current=18, r=0.0)
    add("rci", "r_one_rejected", baseline=base, current=18, r=1.0)
    add("rci", "custom_critical_z", baseline=base, current=13, r=0.8, critical_z=1.96)
    add("rci", "min_baseline_n_override", baseline=base[:3], current=18, r=0.8, min_baseline_n=3)
    add("rci", "constant_float_baseline_is_zero_sd", baseline=[7.3] * 7, current=7.4, r=0.7)

    # ---- evaluate_personal ----
    cfg = fx["personal"]["rci"]
    pvt, sleep, skin, mood = (_ind(fx, i) for i in ("pvt_lapses", "sleep_duration", "skin_temp", "mood"))
    pvt_base = [1, 2, 1, 3, 2, 1, 2, 2, 1, 2, 3, 1, 2, 2]
    add("evaluate_personal", "pvt_reliable_worse_caution", indicator=pvt, baseline=pvt_base, current=8, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_reliable_better_nominal", indicator=pvt,
        baseline=[6, 7, 6, 8, 7, 6, 7], current=0, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_within", indicator=pvt, baseline=pvt_base, current=3, cfg=cfg, t=NOW)
    add("evaluate_personal", "pvt_insufficient_advisory", indicator=pvt, baseline=pvt_base[:5], current=8, cfg=cfg, t=NOW)
    add("evaluate_personal", "sleep_decrease_worse", indicator=sleep,
        baseline=[7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3, 7.0], current=4.5, cfg=cfg, t=NOW)
    add("evaluate_personal", "sleep_observation_unit_mismatch", indicator=sleep,
        baseline=[7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3], current={"value": 270, "unit": "min"}, cfg=cfg, t=NOW)
    add("evaluate_personal", "skin_either_decrease_worse", indicator=skin,
        baseline=[33.1, 33.4, 33.0, 33.2, 33.3, 33.1, 33.2], current=31.0, cfg=cfg, t=NOW)
    add("evaluate_personal", "mood_non_alerting_capped_advisory", indicator=mood,
        baseline=[4, 4, 5, 4, 3, 4, 4], current=1, cfg=cfg, t=NOW)
    add("evaluate_personal", "observations_as_inputs", indicator=pvt,
        baseline=[{"variable": "pvt_lapses", "value": v, "unit": "count", "t": i * DAY} for i, v in enumerate(pvt_base)],
        current={"variable": "pvt_lapses", "value": 8, "unit": "count", "t": NOW}, cfg=cfg, t=NOW)

    # ---- expected_false_alarms ----
    add("expected_false_alarms", "k10_30d", k_indicators=10, days=30, alpha=0.001)
    add("expected_false_alarms", "k10_30d_default_alpha", k_indicators=10, days=30)
    add("expected_false_alarms", "k3_45d", k_indicators=3, days=45, alpha=0.001)
    add("expected_false_alarms", "k0", k_indicators=0, days=30, alpha=0.001)
    add("expected_false_alarms", "negative_rejected", k_indicators=-1, days=30, alpha=0.001)

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


def main(argv: list[str]) -> int:
    if "--check" in argv:
        stale = check_vectors()
        if stale:
            print("out of date: " + ", ".join(stale))
            return 1
        print("vectors up to date")
        return 0
    paths = write_vectors()
    total = sum(len(json.loads(p.read_text(encoding="utf-8"))) for p in paths)
    print(f"wrote {total} vectors to {len(paths)} files in {VECTORS_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
