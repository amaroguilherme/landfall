"""Load the rules files (engine/rules/*.json) and frozen data snapshots (web/public/data/*.json)."""

from __future__ import annotations

import json
from pathlib import Path

from .errors import EngineError

ENGINE_DIR = Path(__file__).resolve().parent
RULES_DIR = ENGINE_DIR / "rules"
DATA_DIR = ENGINE_DIR.parent / "web" / "public" / "data"
RULE_FILES = ("environments", "thresholds", "personal", "cases", "meta")


def load_json(path: Path) -> object:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_rules(rules_dir: Path = RULES_DIR) -> dict:
    """{"environments", "thresholds", "personal", "cases", "meta"} -> parsed file or None if absent."""
    rules_dir = Path(rules_dir)
    out: dict = {}
    for name in RULE_FILES:
        p = rules_dir / f"{name}.json"
        out[name] = load_json(p) if p.exists() else None
    return out


def load_snapshot(snapshot_id: str, data_dir: Path = DATA_DIR) -> dict | None:
    p = Path(data_dir) / f"{snapshot_id}.json"
    return load_json(p) if p.exists() else None  # type: ignore[return-value]


def _by_id(items: list, item_id: str, what: str) -> dict:
    for it in items or []:
        if isinstance(it, dict) and it.get("id") == item_id:
            return it
    raise EngineError("invalid_argument", f"no {what} with id {item_id!r}")


def threshold_rules(rules: dict) -> list:
    doc = rules.get("thresholds") or {}
    return list(doc.get("rules") or [])


def get_rule(rules: dict, rule_id: str) -> dict:
    return _by_id(threshold_rules(rules), rule_id, "rule")


def get_indicator(rules: dict, indicator_id: str) -> dict:
    return _by_id((rules.get("personal") or {}).get("indicators") or [], indicator_id, "indicator")


def get_environment(rules: dict, env_id: str) -> dict:
    return _by_id((rules.get("environments") or {}).get("environments") or [], env_id, "environment")


def get_case(rules: dict, case_id: str) -> dict:
    doc = rules.get("cases") or {}
    return _by_id(doc.get("cases") or [], case_id, "case")


def trigger_lookup(rules: dict) -> dict:
    """rule or indicator id -> {"variable", "unit"}, for new_case() tripwire resolution."""
    out: dict = {}
    items = threshold_rules(rules) + list((rules.get("personal") or {}).get("indicators") or [])
    for it in items:
        if isinstance(it, dict) and isinstance(it.get("id"), str):
            out[it["id"]] = {"variable": it.get("variable"), "unit": it.get("unit")}
    return out
