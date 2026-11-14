"""Tier A (NASA- or NOAA-published limits) and context rules. SPEC sections 2, 3.2 and 5.

evaluate_rule never invents a limit: it only compares a value with the `limit` carried by the
rule object, which carries its own chip and source.
"""

from __future__ import annotations

from .errors import EngineError
from .fmt import fmt_num, is_number, require_number

SEVERITIES = ("nominal", "advisory", "caution", "warning", "emergency")  # emergency: never emitted
STATUSES = ("within", "approaching", "outside", "reliable_change",
            "insufficient_data", "stale", "not_applicable")
CEILING_OPS = ("lt", "le")
FLOOR_OPS = ("gt", "ge")
OP_SYMBOL = {"lt": "<", "le": "<=", "gt": ">", "ge": ">="}

# NOAA S-scale, >=10 MeV integral proton flux in pfu (SPEC 5; snapshot swpc_s_scale).
# S level = highest level whose threshold is met (flux >= threshold).
NOAA_S_THRESHOLDS_PFU = (10.0, 100.0, 1000.0, 10000.0, 100000.0)


def severity_rank(severity: str) -> int:
    return SEVERITIES.index(severity)


def cap_severity(severity: str, cap: str) -> str:
    return severity if severity_rank(severity) <= severity_rank(cap) else cap


def compare(value: float, op: str, limit: float) -> bool:
    """True when `value op limit` holds (the compliant condition for a rule)."""
    if op == "lt":
        return value < limit
    if op == "le":
        return value <= limit
    if op == "gt":
        return value > limit
    if op == "ge":
        return value >= limit
    raise EngineError("invalid_rule", f"op must be one of lt, le, gt, ge; got {op!r}")


def s_level(flux_pfu: float) -> int:
    """NOAA solar radiation storm level 0..5 from >=10 MeV proton flux (pfu).

    >=10 -> S1, >=100 -> S2, >=1e3 -> S3, >=1e4 -> S4, >=1e5 -> S5; below 10 pfu (or negative) -> 0.
    """
    require_number(flux_pfu, "flux_pfu")
    level = 0
    for i, threshold in enumerate(NOAA_S_THRESHOLDS_PFU):
        if flux_pfu >= threshold:
            level = i + 1
    return level


def coerce_value(value: object, unit: str, variable: str | None, what: str) -> tuple[float | None, float | None]:
    """Accept a number, None (missing) or an observation dict {value, unit, t?, variable?}.

    Returns (number or None, observation t or None). A dict whose unit differs from `unit`
    raises unit_mismatch (units are never converted, SPEC section 4); a dict without a unit is
    a mismatch too. A dict whose variable is present and differs raises variable_mismatch.
    """
    if value is None:
        return None, None
    if isinstance(value, dict):
        if value.get("unit") != unit:
            raise EngineError("unit_mismatch",
                              f"{what}: observation unit {value.get('unit')!r} != expected unit {unit!r}")
        if variable is not None and "variable" in value and value["variable"] != variable:
            raise EngineError("variable_mismatch",
                              f"{what}: observation variable {value['variable']!r} != {variable!r}")
        obs_t = value.get("t")
        if obs_t is not None:
            require_number(obs_t, f"{what}: observation t")
        v = value.get("value")
        if v is None:
            return None, obs_t
        require_number(v, f"{what}: observation value")
        return v, obs_t
    require_number(value, what)
    return value, None  # type: ignore[return-value]


def _validate_rule(rule: dict) -> None:
    if not isinstance(rule, dict):
        raise EngineError("invalid_rule", "rule must be an object")
    for key in ("id", "variable", "unit", "op", "category", "tier", "role", "applies_to", "chip", "source"):
        if key not in rule:
            raise EngineError("invalid_rule", f"rule {rule.get('id')!r} lacks {key!r}")
    if rule["op"] not in OP_SYMBOL:
        raise EngineError("invalid_rule", f"rule {rule['id']!r}: op must be lt, le, gt or ge")
    if not is_number(rule.get("limit")):
        raise EngineError("invalid_rule", f"rule {rule['id']!r}: limit must be a finite number")
    if rule["role"] not in ("alert", "context"):
        raise EngineError("invalid_rule", f"rule {rule['id']!r}: role must be 'alert' or 'context'")
    if not isinstance(rule["applies_to"], list) or not all(isinstance(e, str) for e in rule["applies_to"]):
        raise EngineError("invalid_rule", f"rule {rule['id']!r}: applies_to must be a list of strings")
    approach = rule.get("approach_at")
    if approach is not None and not (isinstance(approach, dict) and is_number(approach.get("value"))):
        raise EngineError("invalid_rule", f"rule {rule['id']!r}: approach_at.value must be a number")
    stale = rule.get("stale_after")
    if stale is not None and not (isinstance(stale, dict) and is_number(stale.get("seconds"))):
        raise EngineError("invalid_rule", f"rule {rule['id']!r}: stale_after.seconds must be a number")
    if rule.get("max_severity") is not None and rule["max_severity"] not in SEVERITIES:
        raise EngineError("invalid_rule", f"rule {rule['id']!r}: max_severity must be a severity")


def basis_text(chip: str, source: dict) -> str:
    """'NASA-published [V1 4030]' etc. Only a requirement ID that is in the source is printed."""
    rid = source.get("requirement_id") if isinstance(source, dict) else None
    return f"{chip} [{rid}]" if rid else str(chip)


def _severity_tier_a(rule: dict, status: str, ctx: dict) -> str:
    """SPEC section 2 default mapping (design choice, mirrored in rules/meta.json)."""
    if status in ("insufficient_data", "stale"):
        return "advisory"
    if status in ("within", "not_applicable"):
        return "nominal"
    category = rule["category"]
    if category == "OPS":
        if status == "approaching":
            sev = "advisory"  # SPEC is silent on approaching an OPS level: we never exceed advisory
        else:
            level = _ops_level(rule)
            if level >= 3:
                sev = "warning" if ctx.get("eva") is True else "caution"
            else:
                sev = "advisory"
    elif category == "TARGET":
        # literature targets are not NASA limits (meta.json rows target_outside / target_approaching)
        sev = "caution" if status == "outside" else "advisory"
    else:
        sev = "warning" if status == "outside" else "caution"
    if rule["role"] == "context":
        sev = cap_severity(sev, "advisory")
    if rule.get("max_severity") is not None:
        sev = cap_severity(sev, rule["max_severity"])
    return sev


def _ops_level(rule: dict) -> int:
    """S level of an OPS rule: its explicit integer `s_level`, else s_level(limit) for a ceiling."""
    lv = rule.get("s_level")
    if isinstance(lv, int) and not isinstance(lv, bool):
        return lv
    return s_level(rule["limit"]) if rule["op"] in CEILING_OPS else 0


def evaluate_rule(rule: dict, value: object, env_id: str, t: float | None, ctx: dict | None = None) -> dict:
    """Evaluate one Tier A / context / OPS rule.

    value: number, None (no data) or an observation {value, unit, t?, variable?}.
    env_id: current environment id (string). t: evaluation MET seconds (or None).
    ctx: optional {"eva": bool}; true when an EVA is planned or in progress (OPS severity).
    """
    _validate_rule(rule)
    if not isinstance(env_id, str):
        raise EngineError("invalid_argument", f"env_id must be a string, got {env_id!r}")
    if t is not None:
        require_number(t, "t")
    if ctx is not None and not isinstance(ctx, dict):
        raise EngineError("invalid_argument", "ctx must be an object or null")
    ctx = ctx or {}
    unit = rule["unit"]
    v, obs_t = coerce_value(value, unit, rule["variable"], f"rule {rule['id']}")
    op = rule["op"]
    limit = rule["limit"]
    is_ceiling = op in CEILING_OPS
    label = rule.get("label") or rule["id"]
    basis = basis_text(rule["chip"], rule["source"])
    approach = rule.get("approach_at")
    applies = rule["applies_to"]

    status: str
    margin = None
    if "*" not in applies and env_id not in applies:
        status = "not_applicable"
        why = (f"{label}: not applicable in {env_id} (applies to {', '.join(sorted(applies))}). "
               f"Basis: {basis}.")
    elif v is None:
        status = "insufficient_data"
        why = f"{label}: no value. Basis: {basis}."
    else:
        stale = rule.get("stale_after")
        age = (t - obs_t) if (stale is not None and obs_t is not None and t is not None) else None
        if age is not None and age > stale["seconds"]:
            status = "stale"  # nothing is compared, so margin stays null (SPEC section 5)
            why = (f"{label}: last value {fmt_num(v)} {unit} is {fmt_num(age)} s old "
                   f"(stale after {fmt_num(stale['seconds'])} s). Basis: {basis}.")
        else:
            margin = (limit - v) if is_ceiling else (v - limit)
            compliant = compare(v, op, limit)
            approaching = False
            if approach is not None:
                a = approach["value"]
                approaching = (v >= a) if is_ceiling else (v <= a)
            if not compliant:
                status = "outside"
                state_txt = "outside"
            elif approaching:
                status = "approaching"
                state_txt = f"approaching (watch level {fmt_num(approach['value'])} {unit})"
            else:
                status = "within"
                state_txt = "within"
            why = (f"{label}: {fmt_num(v)} {unit}; compliant when {OP_SYMBOL[op]} {fmt_num(limit)} {unit}; "
                   f"{state_txt}. Basis: {basis}.")

    return {
        "rule_id": rule["id"],
        "tier": rule["tier"],
        "category": rule["category"],
        "role": rule["role"],
        "status": status,
        "severity": _severity_tier_a(rule, status, ctx),
        "value": v,
        "unit": unit,
        "op": op,
        "limit": limit,
        "approach_at": approach["value"] if approach is not None else None,
        "margin": margin,
        "chip": rule["chip"],
        "source": rule["source"],
        "why": why,
        "env_id": env_id,
        "t": t,
        "case_id": rule.get("case_id"),
        "action_id": rule.get("action_id"),
    }
