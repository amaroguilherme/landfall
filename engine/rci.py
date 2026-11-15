"""Tier B: reliable change against the crewmember's own baseline. SPEC sections 1.3, 3.3 and 5.

The question is Jacobson & Truax's (1991): is today's value further from this person's usual
value than day-to-day noise explains? The arithmetic is the single-case test for "one new
observation against the mean of n baseline observations from the same person": the modified
t-test of Crawford & Howell (1998), after Sokal & Rohlf.

    s_diff   = sd * sqrt(1 + 1/n)       sd: sample SD (n - 1) of the n baseline values
    rc       = (current - mean) / s_diff  (the t statistic of the single-case test)
    df       = n - 1
    critical = t_critical(alpha, df)      two-tailed, alpha from personal.json (0.001)
    reliable when |rc| > critical
    mdc      = critical * s_diff          the minimum detectable change: the band's half-width

s_diff is the standard deviation of the difference between one new value and the mean of n
values from the same distribution (variance sigma^2 + sigma^2/n). Under normal, independent day-to-day
noise the probability of a reliable change is exactly alpha per indicator-day, and of one in a
given direction alpha/2. Positive autocorrelation between days, or skewed or coarse count data,
make the realized rate higher (personal.json rci.caveat).

Why not Jacobson & Truax's arithmetic: their S_diff = sd * sqrt(2) * sqrt(1 - r) takes sd from a
reference population and r from a reliability study. With the crewmember's own baseline SD,
which already contains the day-to-day error, multiplying by sqrt(1 - r) shrinks the denominator:
at r = 0.8 the realized two-sided rate was about 6.6% per indicator-day instead of the 0.1% printed
(engine/tests/test_rci.py, test_old_jacobson_truax_arithmetic_overstated_reliability). The engine
no longer uses any test-retest reliability.

Counts (SPEC section 3.3, indicator "transform"): an indicator may declare a variance-stabilizing
transform that evaluate_personal applies to every baseline value and to the current value before the
test. The only one is "anscombe", y = 2 * sqrt(x + 3/8) for a count x >= 0 (Anscombe 1948), which
turns a Poisson count into a variable with roughly constant variance. Raw PVT-B lapse counts, whose
small means make the day-to-day noise skewed, raised a chance caution about 10 times as often as the
printed alpha/2; on the Anscombe scale the realized rate is close to or below it. The personal band is
computed on the transformed scale and mapped back to the raw scale with the algebraic inverse,
x = (y / 2)^2 - 3/8. The transform is monotone, so a raw value is outside the mapped band exactly when
its transform is outside the band on the test scale: the inverse is exact for band edges (its known
bias concerns estimating a mean, which this never does).

Chance rates (chance_rate): the nominal rate of the test is alpha per indicator-day for a flag in
either direction and alpha/2 for a caution (alpha for an indicator whose worse is "either"). An
indicator whose realized rate is far from that (a seeded Monte Carlo under the scenario's noise
model, engine/tests/test_chance_rates.py) declares the measured multipliers in personal.json, and
chance_rate prints those instead of the nominal rate.

Crawford JR, Howell DC. Comparing an individual's test score against norms derived from small
samples. Clin Neuropsychol 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241
Anscombe FJ. The transformation of Poisson, binomial and negative-binomial data. Biometrika
1948;35(3-4):246-254. doi:10.1093/biomet/35.3-4.246
"""

from __future__ import annotations

import functools
import math

from .errors import EngineError
from .fmt import fmt_num, is_number, require_number, sum_lr
from .tdist import t_critical
from .thresholds import basis_text, coerce_value

WORSE_VALUES = ("increase", "decrease", "either")
METHOD = "crawford_howell_1998"
TRANSFORMS = ("anscombe",)
ANSCOMBE_OFFSET = 0.375          # 3/8 (Anscombe 1948): y = 2 * sqrt(x + 3/8)
ANSCOMBE_SCALE_TEXT = "2√(x + 3/8)"
CHANCE_TEXT_MAX_DAYS = 1e12      # "about 1 in N days" is printed below this; above it, "fewer than 1 in 10^12"


@functools.lru_cache(maxsize=4096)
def _critical(alpha: float, df: int) -> float:
    # t_critical is pure; memoized because every Tier B evaluation asks for the same few values
    return t_critical(alpha, df)


def _validate_alpha(alpha: object) -> float:
    require_number(alpha, "alpha")
    if not (0.0 < alpha < 1.0):  # type: ignore[operator]
        raise EngineError("invalid_argument", f"alpha must be in (0, 1), got {alpha!r}")
    return alpha  # type: ignore[return-value]


def rci(baseline: list, current: float | None, alpha: float = 0.001, min_baseline_n: int = 7) -> dict:
    """Single-case test of `current` against `baseline` (numbers; None entries are skipped).

    Returns {method, status, reason, n, df, mean, sd, s_diff, rc, critical, alpha, reliable,
    direction, mdc}. status is "ok" or "insufficient_data" (reason "baseline_too_short",
    "no_current" or "zero_sd", checked in that order). Fields are reported when computable: mean
    needs n >= 1; sd, df and s_diff need n >= 2; critical needs n >= min_baseline_n; rc needs status
    "ok"; mdc (= critical * s_diff, the smallest change from the mean that is a reliable change)
    needs critical and an SD above 0, so it is reported even without a current value.
    direction is "increase" | "decrease" | "none" (sign of current - mean) or None.
    Raises invalid_argument when a baseline statistic, the minimum detectable change or the
    statistic itself is not finite (inputs near the float range): the engine never returns NaN or
    infinity.
    """
    if not isinstance(baseline, list):
        raise EngineError("invalid_argument", "baseline must be a list")
    _validate_alpha(alpha)
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
    if (mean is not None and not math.isfinite(mean)) or (sd is not None and not math.isfinite(sd)):
        raise EngineError("invalid_argument", "baseline mean or SD is not finite (values too large)")
    df = n - 1 if n >= 2 else None
    s_diff = sd * math.sqrt(1.0 + 1.0 / n) if sd is not None else None
    critical = _critical(alpha, df) if n >= min_baseline_n else None
    mdc = None
    if critical is not None and s_diff is not None and sd > 0:
        mdc = critical * s_diff
        if not math.isfinite(mdc):
            raise EngineError("invalid_argument", "the minimum detectable change is not finite (values too large)")
    direction = None
    if mean is not None and current is not None:
        direction = "increase" if current > mean else ("decrease" if current < mean else "none")
    out = {"method": METHOD, "status": "insufficient_data", "reason": None, "n": n, "df": df,
           "mean": mean, "sd": sd, "s_diff": s_diff, "rc": None, "critical": critical, "alpha": alpha,
           "reliable": False, "direction": direction, "mdc": mdc}
    if n < min_baseline_n:
        out["reason"] = "baseline_too_short"
        return out
    if current is None:
        out["reason"] = "no_current"
        return out
    if sd == 0:
        out["reason"] = "zero_sd"
        return out
    rc = (current - mean) / s_diff
    if not math.isfinite(rc):
        raise EngineError("invalid_argument", "the t statistic is not finite (values too large)")
    out.update({"status": "ok", "rc": rc, "reliable": abs(rc) > critical})
    return out


def _validate_indicator(ind: dict) -> None:
    if not isinstance(ind, dict):
        raise EngineError("invalid_rule", "indicator must be an object")
    for key in ("id", "variable", "unit", "worse", "alerting"):
        if key not in ind:
            raise EngineError("invalid_rule", f"indicator {ind.get('id')!r} lacks {key!r}")
    if ind["worse"] not in WORSE_VALUES:
        raise EngineError("invalid_rule", f"indicator {ind['id']!r}: worse must be one of {WORSE_VALUES}")
    if not isinstance(ind["alerting"], bool):
        raise EngineError("invalid_rule", f"indicator {ind['id']!r}: alerting must be true or false")
    tf = ind.get("transform")
    if tf is not None and tf not in TRANSFORMS:
        raise EngineError("invalid_rule", f"indicator {ind['id']!r}: transform must be one of {TRANSFORMS} or null")


def _transform(tf: str | None, x: float | None, what: str) -> float | None:
    """The declared transform of one raw value (None passes through; no transform is the identity).

    anscombe: 2 * sqrt(x + 3/8) for a count x >= 0; a negative value raises invalid_argument.
    """
    if x is None or tf is None:
        return x
    if x < 0:
        raise EngineError("invalid_argument", f"{what}: the anscombe transform needs a count >= 0, got {x!r}")
    return 2.0 * math.sqrt(x + ANSCOMBE_OFFSET)


def _untransform(tf: str | None, y: float) -> float:
    """A band edge on the test scale mapped back to the raw scale (identity without a transform).

    anscombe: (y / 2)^2 - 3/8, the algebraic inverse, for y >= 0. An edge below 0 has no preimage: it
    maps to -3/8, the bottom of the transform's domain, so no count can fall below it.
    """
    if tf is None:
        return y
    h = (y if y > 0.0 else 0.0) / 2.0
    return h * h - ANSCOMBE_OFFSET


def _qty(x: float, unit: str) -> str:
    """'4.5 h', or a bare '4' for a count."""
    return fmt_num(x) if unit == "count" else f"{fmt_num(x)} {unit}"


def _validate_cfg(cfg: dict) -> None:
    if not isinstance(cfg, dict):
        raise EngineError("invalid_rule", "rci config must be an object")
    for key in ("alpha_two_tailed", "min_baseline_n", "chip", "source"):
        if key not in cfg:
            raise EngineError("invalid_rule", f"rci config lacks {key!r}")


def evaluate_personal(indicator: dict, baseline: list, current: object, cfg: dict,
                      t: float | None = None) -> dict:
    """Tier B finding for one personal indicator.

    baseline: list of numbers / None / observations (same unit as the indicator).
    current: number, None or an observation. cfg: the `rci` block of personal.json.
    An indicator that declares a transform (SPEC 3.3; "anscombe" for counts) is tested on that scale:
    the transform is applied to every baseline value and to the current value, and the band is mapped
    back. Every top-level number of the finding is on the raw scale of the indicator's unit (value,
    limit, margin, baseline_mean, band); the rci block holds the test's statistics on the scale named by
    rci.transform (null = raw), with rci.current the tested current value on that scale.
    Severity: reliable change in the worse direction -> caution (never warning), but nominal for a
    non-alerting indicator, which never alerts; reliable change in the other direction -> nominal
    (shown, no alert; LANDFALL does not call it better); insufficient data -> advisory; within ->
    nominal.
    """
    _validate_indicator(indicator)
    _validate_cfg(cfg)
    if t is not None:
        require_number(t, "t")
    unit = indicator["unit"]
    what = f"indicator {indicator['id']}"
    tf = indicator.get("transform")
    cur, _ = coerce_value(current, unit, indicator["variable"], what)
    base = []
    if not isinstance(baseline, list):
        raise EngineError("invalid_argument", "baseline must be a list")
    for b in baseline:
        bv, _ = coerce_value(b, unit, indicator["variable"], what + " baseline")
        base.append(bv)
    alpha = cfg["alpha_two_tailed"]
    cur_t = _transform(tf, cur, what)
    base_t = [_transform(tf, b, what + " baseline") for b in base]
    res = rci(base_t, cur_t, alpha=alpha, min_baseline_n=cfg["min_baseline_n"])
    raw = [b for b in base if b is not None]
    baseline_mean = sum_lr(raw) / len(raw) if raw else None
    if baseline_mean is not None and not math.isfinite(baseline_mean):
        raise EngineError("invalid_argument", f"{what}: baseline mean is not finite (values too large)")
    worse = indicator["worse"]
    label = indicator.get("label") or indicator["id"]

    band = None
    if res["mdc"] is not None:
        # the band on the test scale is mean +/- critical * s_diff; its edges are mapped back to the raw scale
        mean, s_diff, critical = res["mean"], res["s_diff"], res["critical"]
        high = _untransform(tf, mean + critical * s_diff)
        low = _untransform(tf, mean - critical * s_diff)
        if not (math.isfinite(high) and math.isfinite(low)):
            raise EngineError("invalid_argument", f"{what}: personal band edge is not finite (values too large)")
        band = {"low": low, "high": high}
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
            why = f"{label}: baseline SD is 0, so the single-case test is undefined."
    else:
        direction, critical = res["direction"], res["critical"]
        if worse == "increase" or (worse == "either" and direction != "decrease"):
            limit = band["high"]
            margin = band["high"] - cur
        else:
            limit = band["low"]
            margin = cur - band["low"]
        if not (math.isfinite(limit) and math.isfinite(margin)):
            raise EngineError("invalid_argument", f"{what}: personal band edge is not finite (values too large)")
        if res["reliable"]:
            status = "reliable_change"
            is_worse = worse == "either" or direction == worse
            severity = "caution" if is_worse else "nominal"
            txt = "reliable change in the worse direction" if is_worse else \
                "reliable change in the other direction (no alert)"
        else:
            status = "within"
            severity = "nominal"
            txt = "no reliable change"
        scale = "" if tf is None else \
            (f" tested on the Anscombe scale {ANSCOMBE_SCALE_TEXT}: {fmt_num(cur_t)} vs mean "
             f"{fmt_num(res['mean'])};")
        why = (f"{label}: {_qty(cur, unit)} vs own baseline mean {_qty(baseline_mean, unit)} "
               f"(n={res['n']});{scale} t = {fmt_num(res['rc'])}, critical {fmt_num(critical)} "
               f"(df {res['df']}, two-tailed alpha {fmt_num(alpha, 6)}); {txt}.")
    if not indicator["alerting"]:
        if status == "reliable_change":
            severity = "nominal"  # shown, never alerts: advisory blue would read as an alert
        why += " Non-alerting indicator: never alerts."
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
        "baseline_mean": baseline_mean,
        "band": band,
        "rci": {
            "method": res["method"], "transform": tf, "current": cur_t,
            "rc": res["rc"], "df": res["df"], "critical": res["critical"],
            "alpha": res["alpha"], "s_diff": res["s_diff"], "mean": res["mean"], "sd": res["sd"],
            "n": res["n"], "reliable": res["reliable"], "reason": res["reason"], "mdc": res["mdc"],
        },
    }


def min_detectable_change(sd: float, n: int, alpha: float = 0.001) -> dict:
    """The smallest one-day change from the baseline mean that the single-case test flags.

    mdc = critical * s_diff, with s_diff = sd * sqrt(1 + 1/n) and critical = t_critical(alpha, n - 1):
    the half-width of the personal band. A value further than mdc from the baseline mean is a
    reliable change; a smaller change never is, however real. Use it to state Tier B's sensitivity,
    at the crewmember's own SD (rci()["mdc"] is the same number) or at a literature SD.
    Returns {mdc, critical, s_diff, sd, n, df, alpha}. sd must be > 0 (the test is undefined at SD
    0), n an integer >= 2, alpha in (0, 1); anything else, or a result that is not finite, raises
    invalid_argument.
    """
    require_number(sd, "sd")
    if not sd > 0:  # type: ignore[operator]
        raise EngineError("invalid_argument", f"sd must be > 0 (the test is undefined at SD 0), got {sd!r}")
    if isinstance(n, bool) or not isinstance(n, int) or n < 2:
        raise EngineError("invalid_argument", "n must be an integer >= 2")
    _validate_alpha(alpha)
    s_diff = sd * math.sqrt(1.0 + 1.0 / n)
    critical = _critical(alpha, n - 1)
    mdc = critical * s_diff
    if not (math.isfinite(s_diff) and math.isfinite(mdc)):
        raise EngineError("invalid_argument", "the minimum detectable change is not finite (values too large)")
    return {"mdc": mdc, "critical": critical, "s_diff": s_diff, "sd": sd, "n": n, "df": n - 1, "alpha": alpha}


FALSE_ALARM_ASSUMES = ("one test per indicator per day, with normal day-to-day noise that is independent "
                       "from one day to the next; autocorrelated or skewed data give more, while correlation "
                       "between indicators leaves the average unchanged and only bunches chance flags together")


def expected_false_alarms(k_indicators: float, days: float, alpha: float = 0.001, k_either: float = 0) -> dict:
    """Chance flags and chance cautions for k indicators tested once a day for `days` days.

    Flags (a reliable change in either direction): (k * days) * alpha, i.e. per_day = k * alpha.
    Cautions: an indicator with one worse direction raises a caution on half of its chance flags
    (the test is two-tailed); one whose worse is "either" (k_either of the k) on all of them:
    cautions_per_day = ((k - k_either) * alpha) / 2 + k_either * alpha. With k_either = 0 that is
    per_day / 2. N = 1 / per_day and M = 1 / cautions_per_day, formatted with fmt_num(dp=1).
    """
    for name, x in (("k_indicators", k_indicators), ("days", days), ("alpha", alpha), ("k_either", k_either)):
        require_number(x, name)
        if x < 0:
            raise EngineError("invalid_argument", f"{name} must be >= 0")
    if alpha > 1:
        raise EngineError("invalid_argument", "alpha must be <= 1")
    if k_either > k_indicators:
        raise EngineError("invalid_argument", "k_either must be <= k_indicators")
    per_day = k_indicators * alpha
    expected = (k_indicators * days) * alpha
    every = (1.0 / per_day) if per_day > 0 else None
    one_sided = k_indicators - k_either
    cautions_per_day = (one_sided * alpha) / 2.0 + k_either * alpha
    expected_cautions = ((one_sided * days) * alpha) / 2.0 + (k_either * days) * alpha
    caution_every = (1.0 / cautions_per_day) if cautions_per_day > 0 else None
    text = "no false flags expected" if every is None else \
        f"one false flag every {fmt_num(every, 1)} days on average, counting chance changes in either direction"
    if caution_every is None:
        caution_text = "no false cautions expected"
    elif k_either > 0:
        caution_text = (f"one false caution every {fmt_num(caution_every, 1)} days on average: a chance change "
                        f"in the worse direction raises a caution, and in either direction for the "
                        f"{fmt_num(k_either)} indicator(s) that alert both ways")
    else:
        caution_text = (f"one false caution every {fmt_num(caution_every, 1)} days on average: "
                        "only a chance change in the worse direction raises a caution")
    return {"expected": expected, "per_day": per_day, "every_n_days": every, "text": text,
            "expected_cautions": expected_cautions, "cautions_per_day": cautions_per_day,
            "caution_every_n_days": caution_every, "caution_text": caution_text,
            "assumes": FALSE_ALARM_ASSUMES,
            "k_indicators": k_indicators, "days": days, "alpha": alpha, "k_either": k_either}


def _about(n: float) -> str:
    """N for "about 1 in N days": two significant figures (2000, 1000, 3800), a whole number below 100."""
    m = 1.0
    while n >= 100.0 * m:
        m = m * 10.0
    return fmt_num(math.floor(n / m + 0.5) * m, 0)


def _declared_multiplier(decl: dict, key: str, iid: object) -> float:
    x = decl.get(key)
    if not is_number(x) or x < 0:
        raise EngineError("invalid_rule", f"indicator {iid!r}: chance_rate.{key} must be a finite number >= 0")
    return x


def chance_rate(indicator: dict, cfg: dict) -> dict:
    """How often this indicator flags by chance alone, per crewmember and day (SPEC section 5).

    Nominal (no declaration): the single-case test's own rate under normal, independent day-to-day noise:
    a flag (reliable change in either direction) on alpha of days, a caution (worse direction) on alpha/2,
    or alpha for an indicator whose worse is "either". An indicator that declares `chance_rate` in
    personal.json ({caution_multiplier, flag_multiplier, text, chip, source}: measured by seeded Monte
    Carlo under the scenario's noise model) gets those multiples of the nominal rates instead, with basis
    "measured". A non-alerting indicator never raises a caution: its caution rate is 0 and its text
    names the flag rate.
    """
    _validate_indicator(indicator)
    _validate_cfg(cfg)
    alpha = _validate_alpha(cfg["alpha_two_tailed"])
    iid = indicator["id"]
    worse, alerting = indicator["worse"], indicator["alerting"]
    nominal_caution = alpha if worse == "either" else alpha / 2.0
    nominal_flag = alpha
    decl = indicator.get("chance_rate")
    if decl is None:
        basis, cm, fm, note, chip, source = "nominal", 1.0, 1.0, None, cfg["chip"], cfg["source"]
    else:
        if not isinstance(decl, dict):
            raise EngineError("invalid_rule", f"indicator {iid!r}: chance_rate must be an object")
        for key in ("chip", "source"):
            if key not in decl:
                raise EngineError("invalid_rule", f"indicator {iid!r}: chance_rate lacks {key!r}")
        cm = _declared_multiplier(decl, "caution_multiplier", iid)
        fm = _declared_multiplier(decl, "flag_multiplier", iid)
        note = decl.get("text") if isinstance(decl.get("text"), str) else None
        basis, chip, source = "measured", decl["chip"], decl["source"]
    caution = nominal_caution * cm if alerting else 0.0
    flag = nominal_flag * fm
    if not (math.isfinite(caution) and math.isfinite(flag)) or caution > 1.0 or flag > 1.0:
        raise EngineError("invalid_rule", f"indicator {iid!r}: a chance rate above 1 per day is impossible")
    caution_every = 1.0 / caution if caution > 0 else None
    flag_every = 1.0 / flag if flag > 0 else None
    if alerting:
        every, lead, what = caution_every, "", "would flag like this"
    else:
        every, lead, what = flag_every, "never alerts; ", "would show a reliable change like this"
    if every is None:
        text = lead + ("no chance cautions expected" if alerting else "no chance flags expected")
    elif every >= CHANCE_TEXT_MAX_DAYS:
        text = f"{lead}fewer than 1 in 10^12 days per crewmember {what} with no real change"
    else:
        text = f"{lead}about 1 in {_about(every)} days per crewmember {what} with no real change"
    return {"indicator_id": iid, "worse": worse, "alerting": alerting, "alpha": alpha, "basis": basis,
            "nominal_caution_per_day": nominal_caution, "nominal_flag_per_day": nominal_flag,
            "caution_multiplier": cm, "flag_multiplier": fm,
            "caution_per_day": caution, "flag_per_day": flag,
            "caution_every_n_days": caution_every, "flag_every_n_days": flag_every,
            "text": text, "note": note, "chip": chip, "source": source}
