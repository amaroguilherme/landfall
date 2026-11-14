"""Student's t distribution for Tier B (SPEC section 5): CDF, quantile, two-tailed critical value.

Stdlib only. The TypeScript port follows the same steps in the same order, with the same
constants, so the two languages agree within the SPEC tolerance (1e-9):

    P(T > t) = 0.5 * I_x(df/2, 1/2),  x = df / (df + t^2),  for t >= 0
               (exactly 0.5 below t = 1e-17; above t = 1e150, ln x = ln df - 2 ln t)
    I_x(a, b)  regularized incomplete beta. Front factor
               exp(lgamma(a+b) - lgamma(a) - lgamma(b) + a*log(x) + b*log(1-x)); continued
               fraction by the modified Lentz method when x < (a+1)/(a+b+2), otherwise the
               symmetry I_x(a, b) = 1 - I_(1-x)(b, a) (Numerical Recipes, 3rd ed., section 6.4).
    inverse    bracket the root between consecutive powers of two, then exactly
               BISECTION_STEPS bisection steps; the midpoint is returned (relative error < 2^-33).

Why a fixed, modest number of bisection steps: Python's math.lgamma (CPython's own Lanczos m_lgamma,
whose last bits depend on the platform log and on the multiply-adds the compiler fuses) and the
TypeScript lgamma can differ in the last bit, so the two CDFs can differ by ~1e-13 relative. A
bisection run to full precision would let that noise decide the last few halvings, and the two
critical values would differ in their last bits. With 32 steps every halving is decided far above
the noise for moderate df, which covers every df the engine uses (engine/tests/test_tdist.py swaps
in an independent Lanczos lgamma and requires identical critical values), and the result is still
accurate to ~1e-10 relative, far below anything printed (critical values print with 3 decimals).
At large df the lgamma terms are about (df/2) ln(df/2), so one ulp of them moves the CDF by up to
~1e-9 relative near df 1e6: there a late halving can differ between the languages (measured up to
~3e-10 relative below df 1e5 and ~3e-9 above it; SPEC section 6 allows 1e-8 above df 1e5).
"""

from __future__ import annotations

import math

from .errors import EngineError
from .fmt import require_number

CF_EPS = 1e-15          # continued fraction stops when |delta - 1| < CF_EPS
CF_TINY = 1e-300        # Lentz: replaces a zero denominator
CF_MAX_ITER = 10000     # never reached for DF_MIN <= df <= DF_MAX (a few dozen iterations in practice)
BISECTION_STEPS = 32
BRACKET_MAX = 2.0 ** 1000
BRACKET_MIN = 2.0 ** -1000
DF_MIN = 1.0            # keeps x = df / (df + t^2) a normal double for every t <= T_HUGE
DF_MAX = 1e6            # beyond this the log-beta cancellation costs more than 1e-9 relative
T_TINY = 1e-17          # below this P(T > t) rounds to 0.5 for every df: returned exactly
T_HUGE = 1e150          # above this t^2 nears overflow: x = df / t^2 is formed from logarithms


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction of I_x(a, b) (modified Lentz). Evaluation order is part of the contract."""
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < CF_TINY:
        d = CF_TINY
    d = 1.0 / d
    h = d
    for i in range(1, CF_MAX_ITER + 1):
        m = float(i)
        m2 = 2.0 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < CF_TINY:
            d = CF_TINY
        c = 1.0 + aa / c
        if abs(c) < CF_TINY:
            c = CF_TINY
        d = 1.0 / d
        h = h * (d * c)
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < CF_TINY:
            d = CF_TINY
        c = 1.0 + aa / c
        if abs(c) < CF_TINY:
            c = CF_TINY
        d = 1.0 / d
        delta = d * c
        h = h * delta
        if abs(delta - 1.0) < CF_EPS:
            return h
    raise EngineError("invalid_argument", "t distribution: continued fraction did not converge")  # pragma: no cover


def _betai(a: float, b: float, x: float, y: float, ln_x: float, ln_y: float) -> float:
    """Regularized incomplete beta I_x(a, b) for 0 < x < 1.

    y = 1 - x and both logarithms are passed in, so 1 - x is never formed by subtraction and x may
    underflow to 0 (the continued fraction tends to 1 there) while ln_x stays exact.
    """
    ln_front = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * ln_x + b * ln_y
    front = math.exp(ln_front)
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, y) / b


def _upper_tail(t: float, df: float) -> float:
    """P(T > t) for t >= 0 (df already validated): 0.5 * I_x(df/2, 1/2), x = df / (df + t^2)."""
    if t < T_TINY:
        return 0.5
    a = 0.5 * df
    if t > T_HUGE:              # x = df / t^2 to within 1e-294 relative; 1 - x = 1 likewise
        ln_x = math.log(df) - 2.0 * math.log(t)
        return 0.5 * _betai(a, 0.5, math.exp(ln_x), 1.0, ln_x, 0.0)
    t2 = t * t
    s = df + t2
    x = df / s
    y = t2 / s
    return 0.5 * _betai(a, 0.5, x, y, math.log(x), math.log(y))


def _upper_tail_inverse(q: float, df: float) -> float:
    """t > 0 with P(T > t) = q, for 0 < q < 0.5 (both already validated)."""
    if _upper_tail(1.0, df) > q:            # root above 1: double until the tail is at or below q
        lo, hi = 1.0, 2.0
        while _upper_tail(hi, df) > q:
            lo, hi = hi, hi * 2.0
            if hi > BRACKET_MAX:
                raise EngineError("invalid_argument", f"t quantile beyond 2^1000 (tail {q!r}, df {df!r})")
    else:                                   # root at or below 1: halve until the tail exceeds q
        lo, hi = 0.5, 1.0
        while not (_upper_tail(lo, df) > q):
            lo, hi = lo * 0.5, lo
            if lo < BRACKET_MIN:            # pragma: no cover - unreachable for q < 0.5
                raise EngineError("invalid_argument", f"t quantile below 2^-1000 (tail {q!r}, df {df!r})")
    for _ in range(BISECTION_STEPS):        # invariant: P(T > lo) > q >= P(T > hi)
        mid = 0.5 * (lo + hi)
        if _upper_tail(mid, df) > q:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def _require_df(df: object) -> float:
    require_number(df, "df")
    if not (DF_MIN <= df <= DF_MAX):  # type: ignore[operator]
        raise EngineError("invalid_argument", f"df must be in [1, 1e6], got {df!r}")
    return df  # type: ignore[return-value]


def _require_open_unit(x: object, what: str) -> float:
    require_number(x, what)
    if not (0.0 < x < 1.0):  # type: ignore[operator]
        raise EngineError("invalid_argument", f"{what} must be in (0, 1), got {x!r}")
    return x  # type: ignore[return-value]


def t_cdf(t: float, df: float) -> float:
    """P(T <= t) for Student's t with df degrees of freedom (1 <= df <= 1e6, need not be an integer)."""
    require_number(t, "t")
    _require_df(df)
    if t >= 0.0:
        return 1.0 - _upper_tail(t, df)
    return _upper_tail(-t, df)


def t_quantile(p: float, df: float) -> float:
    """The t with P(T <= t) = p, for 0 < p < 1 (inverse of t_cdf; 0.0 exactly at p = 0.5)."""
    _require_open_unit(p, "p")
    _require_df(df)
    if p == 0.5:
        return 0.0
    if p > 0.5:
        return _upper_tail_inverse(1.0 - p, df)
    return -_upper_tail_inverse(p, df)


def t_critical(alpha: float, df: float) -> float:
    """Two-tailed critical value c with P(|T| > c) = alpha, for 0 < alpha < 1.

    Computed on the upper tail directly (root of P(T > c) = alpha / 2), so it equals
    -t_quantile(alpha / 2, df) exactly.
    """
    _require_open_unit(alpha, "alpha")
    _require_df(df)
    return _upper_tail_inverse(alpha / 2.0, df)
