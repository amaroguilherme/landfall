"""Contract test: every frozen snapshot shipped to the front end obeys one schema."""

import json

import pytest

from ingest.common import DEFAULT_OUT_DIR, SCHEMA, validate_snapshot

FILES = sorted(p for p in DEFAULT_OUT_DIR.glob("*.json") if p.name != "manifest.json")


@pytest.mark.parametrize("path", FILES, ids=[p.stem for p in FILES])
def test_snapshot_obeys_contract(path):
    snap = json.loads(path.read_text())
    assert snap["schema"] == SCHEMA
    validate_snapshot(snap)
    assert snap["id"] == path.stem, "file stem must equal snapshot id"


def test_validator_rejects_broken_snapshot():
    with pytest.raises(ValueError):
        validate_snapshot({"schema": SCHEMA, "id": "BAD ID"})
