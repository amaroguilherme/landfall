import json

import pytest

from engine import vectors


def _load_committed():
    files = sorted(vectors.VECTORS_DIR.glob("*.json"))
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in files}


def test_committed_vectors_equal_fresh_regeneration():
    stale = vectors.check_vectors()
    assert stale == [], f"run `uv run python -m engine.vectors`; out of date: {stale}"


def test_vector_count_and_coverage():
    committed = _load_committed()
    total = sum(len(v) for v in committed.values())
    assert total >= 60
    for fn in ("evaluate_rule", "rci", "evaluate_personal", "expected_false_alarms", "s_level",
               "case_reduce", "build_ground_packet", "comms_eta", "format_met"):
        assert committed.get(fn), f"no vectors for {fn}"


@pytest.mark.parametrize("vec", [v for vs in _load_committed().values() for v in vs],
                         ids=lambda v: f"{v['fn']}:{v['name']}")
def test_each_vector_replays(vec):
    assert set(vec) in ({"name", "fn", "args", "expect"}, {"name", "fn", "args", "raises"})
    got = vectors.run(vec["fn"], vec["args"])
    if "raises" in vec:
        assert got == {"raises": vec["raises"]}
    else:
        assert json.loads(json.dumps(got["expect"])) == vec["expect"]
