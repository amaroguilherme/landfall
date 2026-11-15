"""Lead decision S3: the realized chance rate of every Tier B indicator, measured through the engine itself.

For each indicator of engine/rules/personal.json, the simulator's own noise model (ingest/_sim_model.py) draws
seeded 45-day records with NO real change, laid out like the scenario: a fixed 14-day baseline, then each of the
31 later days tested against it, 5,000 records per crewmember and indicator (620,000 tests). Every record goes
through the engine: the indicator's declared transform (engine.rci._transform), the baseline mean, s_diff and
critical value from rci(), and evaluate_personal's own decision (|rc| > critical; the worse direction from the
sign of the change). Every flagged test is then re-evaluated with evaluate_personal itself.

It counts cautions (a reliable change in the worse direction; both directions for worse = "either"; for a
non-alerting indicator, the worse-direction change that would be a caution) and flags (a reliable change in either
direction), and divides each rate by the nominal one: alpha / 2 (alpha for "either") and alpha. It requires:
  - the counts equal the generator's own study, published in sim_crew data.self_check.chance_rates;
  - an indicator that declares no chance_rate is within CHANCE_BAND (0.5-2 times) of nominal on both rates;
  - an indicator outside that band declares its measured multipliers in personal.json (2 decimals, or 3 for a
    borderline value whose 2-decimal rounding would sit on a band edge it is not on: mood's 0.495), so
    chance_rate() prints the measured rate next to its band instead of a nominal one that is false for it.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from engine import chance_rate, evaluate_personal, load_rules, rci
from engine.rci import _transform
from ingest import _sim_model as model

ROOT = Path(__file__).resolve().parents[2]
SIM = ROOT / "web" / "public" / "data" / "sim_crew.json"
PERSONAL = load_rules()["personal"]
CFG = PERSONAL["rci"]
INDICATORS = PERSONAL["indicators"]
N_BASE = model.N_BASELINE_DAYS
N_DAYS = N_BASE + (model.LAST_DAY - model.BASELINE_LAST)
LO, HI = model.CHANCE_BAND


def declared(x: float) -> float:
    """How personal.json declares a measured multiplier: 2 decimals, or 3 when 2 would round a value off a band
    edge onto it (0.49516 -> 0.495, never 0.5, which would read as inside the 0.5-2 band)."""
    two = round(x, 2)
    return round(x, 3) if two in (LO, HI) and round(x, 3) != two else two


def _engine_study(ind: dict) -> dict:
    """Replay the generator's seeded records (same streams) through the engine's transform and rci()."""
    tf, worse, alpha = ind.get("transform"), ind["worse"], CFG["alpha_two_tailed"]
    tests = worse_flags = flags = zero_sd = 0
    flagged: list[tuple[list, float, bool]] = []
    for crew in model.CREW:
        rng = model.rng_for("chance", crew["id"], ind["variable"])
        for _ in range(model.CHANCE_REPS_PER_CREW):
            raw = model._simulate_days(rng, crew, ind["variable"], N_DAYS)
            vals = [_transform(tf, v, ind["id"]) for v in raw]
            r = rci(vals[:N_BASE], None, alpha, CFG["min_baseline_n"])
            tests += N_DAYS - N_BASE
            if r["sd"] == 0:          # insufficient_data (zero_sd): nothing can flag
                zero_sd += 1
                continue
            mean, s_diff, critical = r["mean"], r["s_diff"], r["critical"]
            for i in range(N_BASE, N_DAYS):
                rc = (vals[i] - mean) / s_diff
                if abs(rc) > critical:
                    flags += 1
                    w = worse == "either" or (vals[i] > mean) == (worse == "increase")
                    worse_flags += w
                    flagged.append((raw[:N_BASE], raw[i], w))
    nominal_c = alpha if worse == "either" else alpha / 2.0
    return {"tests": tests, "worse_direction_flags": worse_flags, "flags": flags, "zero_sd_baselines": zero_sd,
            "caution_multiplier": worse_flags / tests / nominal_c, "flag_multiplier": flags / tests / alpha,
            "flagged": flagged}


@pytest.fixture(scope="module")
def study() -> dict:
    return {ind["id"]: _engine_study(ind) for ind in INDICATORS}


@pytest.fixture(scope="module")
def published() -> dict | None:
    if not SIM.exists():
        return None
    sc = json.loads(SIM.read_text(encoding="utf-8"))["data"].get("self_check") or {}
    return (sc.get("chance_rates") or {}).get("per_indicator")


def test_every_flag_of_the_study_is_a_reliable_change_of_evaluate_personal(study):
    """The shortcut above is the engine's decision: each flagged test, re-run through evaluate_personal with the
    raw values, is a reliable change, a caution exactly when it is in the worse direction of an alerting
    indicator."""
    checked = 0
    for ind in INDICATORS:
        for base, x, worse_dir in study[ind["id"]]["flagged"]:
            f = evaluate_personal(ind, base, x, CFG)
            assert f["status"] == "reliable_change", (ind["id"], base, x, f["why"])
            assert f["severity"] == ("caution" if worse_dir and ind["alerting"] else "nominal"), (ind["id"], f["why"])
            # the raw-scale band (mapped back from the test scale for a transform) agrees with the test
            assert (f["margin"] < 0) == worse_dir, (ind["id"], base, x, f["band"], f["limit"])
            lo, hi = f["band"]["low"], f["band"]["high"]
            assert x > hi or x < lo, (ind["id"], base, x, f["band"])
            checked += 1
    assert checked > 1000


def test_counts_equal_the_generators_published_study(study, published):
    if published is None:
        pytest.skip("web/public/data/sim_crew.json not built yet")
    for ind in INDICATORS:
        pub, mine = published[ind["id"]], study[ind["id"]]
        for key in ("tests", "worse_direction_flags", "flags", "zero_sd_baselines"):
            assert pub[key] == mine[key], (ind["id"], key, pub[key], mine[key])
        assert pub["transform"] == ind.get("transform") and pub["worse"] == ind["worse"], ind["id"]
        assert pub["caution_multiplier"] == round(mine["caution_multiplier"], 2), ind["id"]
        assert pub["flag_multiplier"] == round(mine["flag_multiplier"], 2), ind["id"]
        assert pub["within_band"] == (LO <= mine["caution_multiplier"] <= HI and LO <= mine["flag_multiplier"] <= HI)


def test_nominal_rate_holds_or_the_measured_one_is_declared(study):
    """S3: within 0.5-2 times nominal, the printed rate is the nominal one; outside, personal.json says how far."""
    report = []
    for ind in INDICATORS:
        mine = study[ind["id"]]
        cm, fm = mine["caution_multiplier"], mine["flag_multiplier"]
        within = LO <= cm <= HI and LO <= fm <= HI
        decl = ind.get("chance_rate")
        report.append(f"{ind['id']}: caution {cm:.2f}x, flag {fm:.2f}x, {mine['tests']:,} tests")
        if decl is None:
            assert within, f"{ind['id']}: measured {cm:.2f}x / {fm:.2f}x nominal; declare chance_rate in personal.json"
        else:
            assert not within, f"{ind['id']}: measured within the band; drop its chance_rate declaration"
            assert (decl["caution_multiplier"], decl["flag_multiplier"]) == (declared(cm), declared(fm)), \
                (ind["id"], decl, declared(cm), declared(fm))
            assert decl["chip"] == "derived" and "Monte Carlo" in decl["source"]["arithmetic"], ind["id"]
            tests = f"{mine['tests']:,} tests"
            assert tests in decl["text"] and tests in decl["source"]["arithmetic"], ind["id"]
            assert f"{mine['worse_direction_flags']} " in decl["source"]["arithmetic"], ind["id"]
            assert f"= {decl['caution_multiplier']};" in decl["source"]["arithmetic"], ind["id"]
    print("\n".join(report))  # pytest -s prints every measured multiplier


def test_the_audited_indicators_now_meet_the_printed_rate_or_say_so(study):
    """The audit's two offenders: the signed, two-sided midpoint shift sits at the printed rate; PVT-B lapses on the
    Anscombe scale flag LESS often than printed (a count near zero cannot fall reliably), and personal.json says
    so instead of printing alpha/2."""
    mid = study["sleep_midpoint_shift"]
    assert 0.8 < mid["caution_multiplier"] < 1.25 and mid["caution_multiplier"] == mid["flag_multiplier"]
    lap = study["pvt_lapses"]
    assert lap["caution_multiplier"] < 1.0 and lap["flag_multiplier"] < LO
    assert lap["flags"] - lap["worse_direction_flags"] < 0.1 * lap["flags"]  # nearly every chance flag is a rise


def test_chance_rate_prints_the_declared_or_the_nominal_rate():
    alpha = CFG["alpha_two_tailed"]
    for ind in INDICATORS:
        r = chance_rate(ind, CFG)
        decl = ind.get("chance_rate")
        nominal_c = alpha if ind["worse"] == "either" else alpha / 2
        cm = decl["caution_multiplier"] if decl else 1.0
        fm = decl["flag_multiplier"] if decl else 1.0
        assert r["basis"] == ("measured" if decl else "nominal"), ind["id"]
        assert math.isclose(r["flag_per_day"], alpha * fm, rel_tol=1e-15), ind["id"]
        assert math.isclose(r["caution_per_day"], nominal_c * cm if ind["alerting"] else 0.0, rel_tol=1e-15), ind["id"]
        if ind["alerting"]:
            assert r["text"].startswith("about 1 in ") and r["text"].endswith(
                " days per crewmember would flag like this with no real change"), ind["id"]
        else:
            assert r["text"].startswith("never alerts; about 1 in "), ind["id"]
    # the CM-3 chance opening of the demo (sleep midpoint shift, both directions alert): about 1 in 1000 days
    mid = chance_rate(next(i for i in INDICATORS if i["id"] == "sleep_midpoint_shift"), CFG)
    assert mid["text"] == "about 1 in 1000 days per crewmember would flag like this with no real change"


def test_borderline_multipliers_print_three_decimals(study):
    """Lead item 5: mood's flag multiplier is 0.4952 measured; 2 decimals would print 0.50, inside the band it is
    outside of. It is declared as 0.495 and chance_rate() prints it as "0.495"; the others print as declared."""
    assert declared(0.49516) == 0.495 and declared(0.4548) == 0.45 and declared(2.004) == 2.004 and declared(1.0) == 1.0
    mood = next(i for i in INDICATORS if i["id"] == "mood")
    fm = study["mood"]["flag_multiplier"]
    assert fm < LO and round(fm, 2) == LO                       # the borderline case itself
    assert mood["chance_rate"]["flag_multiplier"] == 0.495
    r = chance_rate(mood, CFG)
    assert (r["caution_multiplier_text"], r["flag_multiplier_text"]) == ("0.99", "0.495")
    lap = chance_rate(next(i for i in INDICATORS if i["id"] == "pvt_lapses"), CFG)
    assert (lap["caution_multiplier_text"], lap["flag_multiplier_text"]) == ("0.45", "0.24")
    nominal = chance_rate(next(i for i in INDICATORS if i["id"] == "glucose"), CFG)
    assert (nominal["caution_multiplier_text"], nominal["flag_multiplier_text"]) == ("1", "1")
    assert "0.495 times as often as alpha" in mood["chance_rate"]["text"]
    assert "= 0.495 (" in mood["chance_rate"]["source"]["arithmetic"]
