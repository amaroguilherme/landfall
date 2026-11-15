import json
import math

import pytest

from engine import vectors


def _load(directory):
    files = sorted(directory.glob("*.json"))
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in files}


def _load_committed():
    return _load(vectors.VECTORS_DIR)


def test_committed_vectors_equal_fresh_regeneration():
    stale = vectors.check_vectors()
    assert stale == [], f"run `uv run python -m engine.vectors`; out of date: {stale}"


def test_random_vectors_equal_fresh_recomputation():
    stale = vectors.check_random_vectors()
    assert stale == [], f"run `uv run python -m engine.vectors --random`; out of date: {stale}"


def test_vector_count_and_coverage():
    committed = _load_committed()
    total = sum(len(v) for v in committed.values())
    assert total >= 60
    assert set(committed) == set(vectors.FUNCTIONS)
    for fn in vectors.FUNCTIONS:
        assert committed.get(fn), f"no vectors for {fn}"
    # the brief: t quantile/CDF vectors, rci across df 6..60 and the edge cases
    rci_names = {v["name"] for v in committed["rci"]}
    assert {f"df_{df}_{'just_past' if df % 2 == 0 else 'just_short_of'}_critical" for df in range(6, 61)} <= rci_names
    assert {"n_below_min", "zero_sd", "nan_current_rejected", "nan_in_baseline_rejected"} <= rci_names
    sweep = [v for v in committed["rci"] if v["name"].startswith("df_")]
    assert all(v["expect"]["reliable"] is (v["expect"]["df"] % 2 == 0) for v in sweep)
    assert len(committed["t_cdf"]) >= 100 and len(committed["t_quantile"]) >= 100 and len(committed["t_critical"]) >= 60
    randomized = _load(vectors.RANDOM_DIR)
    assert set(randomized) == {f"random_{fn}" for fn in vectors.FUNCTIONS}


def test_non_finite_arguments_are_encoded_and_decoded():
    assert math.isnan(vectors.decode_args({"$float": "NaN"}))
    assert vectors.decode_args([{"$float": "Infinity"}, {"x": {"$float": "-Infinity"}}]) == [math.inf, {"x": -math.inf}]
    assert vectors.decode_args({"$float": "nan"}) == {"$float": "nan"}           # only the exact spellings
    assert vectors.decode_args({"$float": "NaN", "other": 1}) == {"$float": "NaN", "other": 1}
    encoded = [v for vs in _load_committed().values() for v in vs if '"$float"' in json.dumps(v["args"])]
    assert len(encoded) >= 10

    def in_rules_data(v):  # a non-finite number inside a rules object (an indicator's chance_rate) is a bad rule
        return any('"$float"' in json.dumps(v["args"].get(k)) for k in ("indicator", "rule"))

    def in_case_event(v):  # case_reduce never raises for a bad event: it logs an atomic invalid_event rejection
        return v["fn"] == "case_reduce" and '"$float"' in json.dumps(v["args"].get("event"))

    for v in encoded:
        if in_case_event(v):
            assert v["expect"]["log"][-1]["error"] == "invalid_event", v["name"]
        else:
            assert v.get("raises") == ("invalid_rule" if in_rules_data(v) else "invalid_argument"), v["name"]


@pytest.mark.parametrize("vec", [v for vs in _load_committed().values() for v in vs],
                         ids=lambda v: f"{v['fn']}:{v['name']}")
def test_each_vector_replays(vec):
    assert set(vec) in ({"name", "fn", "args", "expect"}, {"name", "fn", "args", "raises"})
    got = vectors.run(vec["fn"], vec["args"])
    if "raises" in vec:
        assert got == {"raises": vec["raises"]}
    else:
        assert json.loads(json.dumps(got["expect"], allow_nan=False)) == vec["expect"]
