"""Tier B: Reliable Change Index against the crewmember's own baseline. SPEC sections 1.3, 3.3, 5.

Jacobson NS, Truax P. Clinical significance: a statistical approach to defining meaningful
change in psychotherapy research. J Consult Clin Psychol 1991;59(1):12-19.

    sem    = sd * sqrt(1 - r)        sd: sample SD (n - 1) of the baseline
    s_diff = sqrt(2) * sem
    rc     = (current - mean) / s_diff
    reliable when |rc| >= critical_z (3.29, two-tailed p < .001)

Adaptation (design choice, stated): Jacobson & Truax use the SD of a pre-treatment population
and a single pre-test score; LANDFALL uses the mean and SD of the crewmember's own baseline
window. See plan notes: with a within-person SD the realised false-alarm rate is only alpha
when r = 0.5.
"""

from __future__ import annotations

import math

from .errors import EngineError
from .fmt import fmt_num, is_number, require_number, sum_lr
from .thresholds import basis_text, cap_severity, coerce_value

WORSE_VALUES = ("increase", "decrease", "either")


def _validate_r(r: object) -> float:
    require_number(r, "reliability r")
    if not (0.0 <= r < 1.0):  # type: ignore[operator]
        raise EngineError("invalid_argument", f"reliability r must be in [0, 1), got {r!r}")
    return r  # type: ignore[return-value]


def rci(baseline: list, current: float | None, r: float, critical_z: float = 3.29,
        min_baseline_n: int = 7) -> dict:
    """Reliable Change Index of `current` against `baseline` (numbers; None entries are skipped).

    Returns {status, reason, n, mean, sd, sem, s_diff, rc, reliable, direction, critical_z, r}.
    status is "ok" or "insufficient_data" (reason "baseline_too_short", "no_current" or "zero_sd",
    checked in that order). mean needs n >= 1, sd needs n >= 2; they are reported when computable.
    direction is "increase" | "decrease" | "none" (sign of current - mean) or None.
    """
    if not isinstance(baseline, list):
        raise EngineError("invalid_argument", "baseline must be a list")
    _validate_r(r)
    require_number(critical_z, "critical_z")
    if critical_z <= 0:
        raise EngineError("invalid_argument", "critical_z must be > 0")
    if isinstance(min_baseline_n, bool) or not isinstance(min_baseline_n, int) or min_baseline_n < 2:
        raise EngineError("invalid_argument", "min_baseline_n must be an integer >= 2")
    xs = []
    for x in baseline:
        if x is None:
            continue
        xs.append(require_number(x, "baseline value"))
    if current is not None:
        require_number(current, "current")
    n = len(xs)
    mean = sum_lr(xs) / n if n >= 1 else None
    sd = None
    if n >= 2:
        constant = True
        for x in xs:
            if x != xs[0]:
                constant = False
        if constant:
            # exact test: [7.3]*7 has true SD 0, but the float mean is off by 1 ulp and the computed
            # SD would be ~1e-15, turning any change into an astronomically "reliable" one
            sd = 0.0
        else:
            ss = 0.0
            for x in xs:
                d = x - mean
                ss = ss + d * d
            sd = math.sqrt(ss / (n - 1))
    direction = None
    if mean is not None and current is not None:
        direction = "increase" if current > mean else ("decrease" if current < mean else "none")
    out = {"status": "insufficient_data", "reason": None, "n": n, "mean": mean, "sd": sd,
           "sem": None, "s_diff": None, "rc": None, "reliable": False, "direction": direction,
           "critical_z": critical_z, "r": r}
    if n < min_baseline_n:
        out["reason"] = "baseline_too_short"
        return out
    if current is None:
        out["reason"] = "no_current"
        return out
    if sd == 0:
        out["reason"] = "zero_sd"
        return out
    sem = sd * math.sqrt(1.0 - r)
    s_diff = math.sqrt(2.0) * sem
    rc = (current - mean) / s_diff
    out.update({"status": "ok", "sem": sem, "s_diff": s_diff, "rc": rc,
                "reliable": abs(rc) >= critical_z})
    return out


def _validate_indicator(ind: dict) -> None:
    if not isinstance(ind, dict):
        raise EngineError("invalid_rule", "indicator must be an object")
    for key in ("id", "variable", "unit", "worse", "alerting", "reliability_r"):
        if key not in ind:
            raise EngineError("invalid_rule", f"indicator {ind.get('id')!r} lacks {key!r}")
    if ind["worse"] not in WORSE_VALUES:
        raise EngineError("invalid_rule", f"indicator {ind['id']!r}: worse must be one of {WORSE_VALUES}")
    if not isinstance(ind["alerting"], bool):
        raise EngineError("invalid_rule", f"indicator {ind['id']!r}: alerting must be true or false")
    rr = ind["reliability_r"]
    if not (isinstance(rr, dict) and is_number(rr.get("value"))):
        raise EngineError("invalid_rule", f"indicator {ind['id']!r}: reliability_r.value must be a number")


def _validate_cfg(cfg: dict) -> None:
    if not isinstance(cfg, dict):
        raise EngineError("invalid_rule", "rci config must be an object")
    for key in ("critical_z", "min_baseline_n", "chip", "source"):
        if key not in cfg:
            raise EngineError("invalid_rule", f"rci config lacks {key!r}")


def evaluate_personal(indicator: dict, baseline: list, current: object, cfg: dict,
                      t: float | None = None) -> dict:
    """Tier B finding for one personal indicator.

    baseline: list of numbers / None / observations (same unit as the indicator).
    current: number, None or an observation. cfg: the `rci` block of personal.json.
    Severity: reliable change in the worse direction -> caution (never warning);
    insufficient data -> advisory; anything else -> nominal; non-alerting indicators are capped
    at advisory.
    """
    _validate_indicator(indicator)
    _validate_cfg(cfg)
    if t is not None:
        require_number(t, "t")
    unit = indicator["unit"]
    what = f"indicator {indicator['id']}"
    cur, _ = coerce_value(current, unit, indicator["variable"], what)
    base = []
    if not isinstance(baseline, list):
        raise EngineError("invalid_argument", "baseline must be a list")
    for b in baseline:
        bv, _ = coerce_value(b, unit, indicator["variable"], what + " baseline")
        base.append(bv)
    rr = indicator["reliability_r"]
    res = rci(base, cur, rr["value"], critical_z=cfg["critical_z"], min_baseline_n=cfg["min_baseline_n"])
    worse = indicator["worse"]
    label = indicator.get("label") or indicator["id"]
    z = cfg["critical_z"]

    limit = None
    margin = None
    if res["status"] != "ok":
        status = "insufficient_data"
        severity = "advisory"
        if res["reason"] == "baseline_too_short":
            why = f"{label}: baseline has {res['n']} values; at least {cfg['min_baseline_n']} needed."
        elif res["reason"] == "no_current":
            why = f"{label}: no current value."
        else:
            why = f"{label}: baseline SD is 0, so reliable change is undefined."
    else:
        mean, s_diff, direction = res["mean"], res["s_diff"], res["direction"]
        high = mean + z * s_diff
        low = mean - z * s_diff
        if worse == "increase" or (worse == "either" and direction != "decrease"):
            limit = high
            margin = high - cur
        else:
            limit = low
            margin = cur - low
        if res["reliable"]:
            status = "reliable_change"
            is_worse = worse == "either" or direction == worse
            severity = "caution" if is_worse else "nominal"
            txt = "reliable change in the worse direction" if is_worse else \
                "reliable change in the better direction"
        else:
            status = "within"
            severity = "nominal"
            txt = "no reliable change"
        why = (f"{label}: {fmt_num(cur)} {unit} vs own baseline mean {fmt_num(mean)} {unit} "
               f"(n={res['n']}); RC {fmt_num(res['rc'])}, critical {fmt_num(z)}; {txt}.")
    if not indicator["alerting"]:
        severity = cap_severity(severity, "advisory")
        why += " Non-alerting indicator."
    return {
        "rule_id": indicator["id"],
        "tier": "B",
        "category": "PERSONAL",
        "role": "alert" if indicator["alerting"] else "context",
        "status": status,
        "severity": severity,
        "value": cur,
        "unit": unit,
        "op": None,
        "limit": limit,
        "approach_at": None,
        "margin": margin,
        "chip": cfg["chip"],
        "source": cfg["source"],
        "why": why + f" Basis: {basis_text(cfg['chip'], cfg['source'])}.",
        "env_id": None,
        "t": t,
        "case_id": indicator.get("case_id"),
        "action_id": indicator.get("action_id"),
        "direction": res["direction"],
        "worse": worse,
        "private": indicator.get("private") is True,
        "rci": {
            "rc": res["rc"], "s_diff": res["s_diff"], "sem": res["sem"], "mean": res["mean"],
            "sd": res["sd"], "n": res["n"], "reliable": res["reliable"], "reason": res["reason"],
            "critical_z": z, "r": rr["value"], "r_chip": rr.get("chip"), "r_source": rr.get("source"),
        },
    }


def expected_false_alarms(k_indicators: float, days: float, alpha: float = 0.001) -> dict:
    """Expected false alarms = (k * days) * alpha, plus 'one false alarm every N days'.

    Assumes one test per indicator per day and independent tests. alpha is the two-tailed
    level, so for one-directional indicators this overstates the count by up to 2x (conservative).
    N = 1 / (k * alpha), formatted with fmt_num(dp=1).
    """
    for name, x in (("k_indicators", k_indicators), ("days", days), ("alpha", alpha)):
        require_number(x, name)
        if x < 0:
            raise EngineError("invalid_argument", f"{name} must be >= 0")
    if alpha > 1:
        raise EngineError("invalid_argument", "alpha must be <= 1")
    per_day = k_indicators * alpha
    expected = (k_indicators * days) * alpha
    every = (1.0 / per_day) if per_day > 0 else None
    text = "no false alarms expected" if every is None else \
        f"one false alarm every {fmt_num(every, 1)} days"
    return {"expected": expected, "per_day": per_day, "every_n_days": every,
            "k_indicators": k_indicators, "days": days, "alpha": alpha, "text": text}
