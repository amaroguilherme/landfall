"""Student's t distribution (engine/tdist.py) against published tables and an exact reference.

Published tables used as known answers (all fetched and read on 2026-11-14):
- NIST/SEMATECH e-Handbook of Statistical Methods, section 1.3.6.7.2 "Critical Values of the
  Student's t Distribution", https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm
  (columns 0.90 ... 0.999 of P(T < t); it has no 0.9995 column).
- Purdue University, STAT 503, "Critical Values for Student's t-Distribution. Upper Tail
  Probability: Pr(T > t)", https://www.stat.purdue.edu/~lfindsen/stat503/t-Dist.pdf, column 0.0005
  (= two-tailed alpha 0.001), rows 6 ... 120 and infinity.
- MedCalc Software, "Student's t-Distribution (t-table)", https://www.medcalc.org/en/book/t-table.php,
  column two-tailed P = 0.001: the same values as Purdue, including df 120.
- Saylor Academy (CC BY 3.0, from the Wikibooks Engineering Tables), "Table of Critical Values,
  t(alpha, nu), in a Student T-Distribution", https://resources.saylor.org/wwwresources/archived/site/
  wp-content/uploads/2015/07/BUS204-FinalExamAid-TandZDistributionTables-CCBY.pdf, column 0.0005 to
  5 decimals.
- Crawford JR, Howell DC. Comparing an individual's test score against norms derived from small
  samples. Clin Neuropsychol 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241 (worked example on
  pp. 483-484 and Table 1, which test the whole single-case formula, not only the quantile).

The exact reference is the classical closed form of the t CDF for integer df (Abramowitz & Stegun,
Handbook of Mathematical Functions, section 26.7: a finite sum for even df, arctan plus a sum for odd df),
evaluated with 150-digit decimal arithmetic (enough for tails near 1e-60): a different algorithm from the
engine's continued fraction.
"""

from __future__ import annotations

import math
import random
from decimal import Decimal, getcontext
from statistics import NormalDist

import pytest

from engine import EngineError, rci, t_cdf, t_critical, t_quantile
from engine import tdist

# ------------------------------------------------------------------ exact reference (integer df)

getcontext().prec = 150


def _d_atan(x: Decimal) -> Decimal:
    """arctan by argument halving (atan x = 2 atan(x / (1 + sqrt(1 + x^2)))) and the Taylor series."""
    k = 0
    while abs(x) > Decimal("0.01"):
        x = x / (1 + (1 + x * x).sqrt())
        k += 1
    s, term, n, x2 = Decimal(0), x, 1, x * x
    while abs(term) > Decimal(10) ** -148:
        s += term / n
        term = -term * x2
        n += 2
    return s * (2 ** k)


D_PI = 4 * _d_atan(Decimal(1))


def ref_upper_tail(t: float, df: int) -> Decimal:
    """P(T > t) = (1 - A(t|df)) / 2 for t > 0 and integer df, A from the closed forms of A&S section 26.7."""
    tt, nu = Decimal(t), Decimal(df)
    sin = tt / (nu + tt * tt).sqrt()
    cos2 = nu / (nu + tt * tt)
    if df % 2 == 1:
        theta = _d_atan(tt / nu.sqrt())
        a = theta
        if df > 1:
            cos = cos2.sqrt()
            term, s = cos, cos
            for k in range(1, (df - 3) // 2 + 1):  # (2*4*...*2k)/(3*5*...*(2k+1)) cos^(2k+1)
                term = term * cos2 * (2 * k) / (2 * k + 1)
                s += term
            a = theta + sin * s
        a = 2 * a / D_PI
    else:
        term, s = Decimal(1), Decimal(1)
        for k in range(1, (df - 2) // 2 + 1):  # (1*3*...*(2k-1))/(2*4*...*2k) cos^(2k)
            term = term * cos2 * (2 * k - 1) / (2 * k)
            s += term
        a = sin * s
    return (1 - a) / 2


# ------------------------------------------------------------------ published tables

PURDUE_MEDCALC_TWO_TAILED_001 = {6: 5.959, 10: 4.587, 13: 4.221, 20: 3.850, 30: 3.646, 40: 3.551, 60: 3.460,
                                 120: 3.373, 1000: 3.300}
SAYLOR_0_0005 = {6: 5.95882, 10: 4.58689, 13: 4.22083, 20: 3.84952, 30: 3.64596, 40: 3.55097, 50: 3.49601,
                 60: 3.46020, 100: 3.39049, 500: 3.31009, 1000: 3.30028}
NIST_COLUMNS = (0.90, 0.95, 0.975, 0.99, 0.995, 0.999)
NIST_ROWS = {
    6: (1.440, 1.943, 2.447, 3.143, 3.707, 5.208),
    10: (1.372, 1.812, 2.228, 2.764, 3.169, 4.144),
    13: (1.350, 1.771, 2.160, 2.650, 3.012, 3.852),
    20: (1.325, 1.725, 2.086, 2.528, 2.845, 3.552),
    30: (1.310, 1.697, 2.042, 2.457, 2.750, 3.385),
    60: (1.296, 1.671, 2.000, 2.390, 2.660, 3.232),
    100: (1.290, 1.660, 1.984, 2.364, 2.626, 3.174),
}
NIST_INFINITY = (1.282, 1.645, 1.960, 2.326, 2.576, 3.090)


def test_lead_known_answers_two_tailed_0_001():
    # df=6 5.959, df=10 4.587, df=13 4.221, df=20 3.850, df=30 3.646, df=60 3.460, df=120 3.373 (Purdue, MedCalc)
    for df in (6, 10, 13, 20, 30, 60, 120):
        assert round(t_critical(0.001, df), 3) == PURDUE_MEDCALC_TWO_TAILED_001[df], df
    # df -> infinity tends to 3.291 (the tables' infinity row), from above
    z = NormalDist().inv_cdf(1 - 0.0005)
    big = t_critical(0.001, 1000000)
    assert round(big, 3) == 3.291 and 0 < big - z < 2e-5


def test_purdue_medcalc_column_two_tailed_0_001():
    for df, want in PURDUE_MEDCALC_TWO_TAILED_001.items():
        assert abs(t_critical(0.001, df) - want) <= 0.0005 + 1e-9, df


def test_saylor_five_decimals():
    for df, want in SAYLOR_0_0005.items():
        assert abs(t_quantile(0.9995, df) - want) <= 5e-6 + 1e-12, df
        assert abs(t_critical(0.001, df) - want) <= 5e-6 + 1e-12, df


def test_nist_handbook_table_every_column():
    for df, row in NIST_ROWS.items():
        for p, want in zip(NIST_COLUMNS, row):
            assert abs(t_quantile(p, df) - want) <= 0.0005 + 1e-9, (df, p)
    for p, want in zip(NIST_COLUMNS, NIST_INFINITY):  # the infinity row is the normal quantile
        assert abs(NormalDist().inv_cdf(p) - want) <= 0.0005 + 1e-9
        assert abs(t_quantile(p, 1000000) - want) <= 0.0005 + 1e-9, p


def test_crawford_howell_1998_worked_example_and_table_1():
    # p. 483: N = 15, mean 50, SD 10, score 33 -> t = -17 / (10 sqrt(16/15)); the paper prints 17/10.32 = 1.647
    base = [60] * 7 + [40] * 7 + [50]
    r = rci(base, 33, alpha=0.1)
    assert (r["n"], r["df"], r["mean"], r["sd"]) == (15, 14, 50.0, 10.0)
    assert math.isclose(r["rc"], -17 / (10 * math.sqrt(16 / 15)), rel_tol=1e-15) and round(-17 / 10.32, 3) == -1.647
    # p. 484: one-tailed .05 critical value with 14 df is 1.76 (two-tailed alpha 0.10): not significant ...
    assert round(t_quantile(0.95, 14), 2) == 1.76 and round(r["critical"], 2) == 1.76 and r["reliable"] is False
    # ... but significant at the more liberal one-tailed .10 level (critical value 1.35)
    r10 = rci(base, 33, alpha=0.2)
    assert round(r10["critical"], 2) == 1.35 and r10["reliable"] is True
    # "The exact p in this example is .062": the exact one-tailed p is 0.0610 (the paper rounds along the way)
    p = t_cdf(r["rc"], 14)
    assert abs(p - 0.062) < 0.0015 and round(p, 4) == 0.0610
    # Table 1, z-score column: the value below which a score is significant (.05, one-tailed) for norms of size N
    # (the paper's rounding varies by row: N = 5 is -2.3353, printed -2.33; N = 7 is -2.0773, printed -2.08)
    table_1 = {5: -2.33, 7: -2.08, 10: -1.92, 15: -1.82, 20: -1.77, 25: -1.74, 30: -1.73, 50: -1.69, 70: -1.68,
               120: -1.66}
    for n, want in table_1.items():
        assert abs(-t_quantile(0.95, n - 1) * math.sqrt((n + 1) / n) - want) < 0.01, n


# ------------------------------------------------------------------ exact reference


def test_cdf_matches_exact_closed_form():
    for df in (1, 2, 3, 5, 6, 7, 13, 14, 30, 61, 120):
        for t in (0.05, 0.5, 1.0, 2.0, 4.221, 7.0, 15.0, 60.0):
            q = ref_upper_tail(t, df)
            upper = t_cdf(-t, df)                       # P(T <= -t) = P(T > t)
            assert abs(Decimal(upper) - q) <= q * Decimal("2e-13"), (df, t, upper, q)
            assert abs(Decimal(t_cdf(t, df)) - (1 - q)) <= q * Decimal("2e-13") + Decimal("2.3e-16"), (df, t)


def test_critical_value_within_2_pow_minus_32_of_the_exact_root():
    eps = 2.0 ** -32
    for df in (1, 2, 6, 13, 14, 29, 60, 120):
        for alpha in (0.001, 0.01, 0.05, 1e-6):
            c = t_critical(alpha, df)
            target = Decimal(alpha) / 2
            assert ref_upper_tail(c * (1 - eps), df) > target > ref_upper_tail(c * (1 + eps), df), (df, alpha)


def test_quantile_inverts_cdf_and_symmetry():
    rng = random.Random(20261114)
    for _ in range(400):
        df = rng.choice([1, 2, 3, 6, 13, 30, 200, 5000]) if rng.random() < 0.7 else rng.uniform(1, 80)
        p = rng.random() if rng.random() < 0.6 else 10 ** -rng.uniform(1, 12)
        t = t_quantile(p, df)
        back = t_cdf(t, df)
        assert abs(back - p) <= 2e-9 * min(p, 1 - p) + 1e-16, (p, df, t, back)
        assert t_cdf(-t, df) + t_cdf(t, df) == pytest.approx(1.0, abs=1e-15)
    for df in (1, 13, 60):
        for alpha in (0.001, 0.05, 0.3):
            assert t_critical(alpha, df) == -t_quantile(alpha / 2, df)   # same tail, same bits
    assert t_quantile(0.5, 7) == 0.0 and t_cdf(0, 7) == 0.5 and t_cdf(-0.0, 7) == 0.5


def test_cdf_is_monotone_on_a_fine_grid():
    for df in (1, 6, 13, 1000):
        prev = -1.0
        for i in range(-4000, 4001):
            v = t_cdf(i / 400.0, df)
            assert v >= prev, (df, i)
            prev = v


def test_extreme_arguments():
    assert t_cdf(9e-18, 13) == 0.5 and t_cdf(-9e-18, 13) == 0.5           # P(T > t) rounds to 0.5 there
    # Cauchy (df 1): P(T <= -t) = atan(1/t) / pi ~ 1/(pi t)
    assert t_cdf(-1e200, 1) == pytest.approx(1 / (math.pi * 1e200), rel=1e-12)
    assert t_cdf(-1.7976931348623157e308, 1) == pytest.approx(1 / (math.pi * 1.7976931348623157e308), rel=1e-12)
    assert t_cdf(1e200, 1) == 1.0 and t_cdf(-1e200, 13) == 0.0                # underflow, never NaN
    # continuity across the log-space switch at t = 1e150
    lo, hi = t_cdf(-9.999999e149, 2), t_cdf(-1.000001e150, 2)
    assert lo > hi and lo == pytest.approx(hi, rel=1e-5)
    assert t_quantile(1e-290, 1) == pytest.approx(-1 / (math.pi * 1e-290), rel=1e-9)
    with pytest.raises(EngineError) as e:
        t_quantile(1e-305, 1)                                                   # root beyond 2^1000
    assert e.value.code == "invalid_argument"


def test_validation():
    for bad_df in (0, 0.5, 0.999, -1, 1000001, math.nan, math.inf, True, None, "13"):
        for call in (lambda: t_cdf(1.0, bad_df), lambda: t_quantile(0.9, bad_df), lambda: t_critical(0.05, bad_df)):
            with pytest.raises(EngineError) as e:
                call()
            assert e.value.code == "invalid_argument", bad_df
    for bad in (math.nan, math.inf, -math.inf, True, None, "1"):
        with pytest.raises(EngineError):
            t_cdf(bad, 5)
    for bad in (0, 1, -0.1, 1.5, math.nan, True, "0.5"):
        with pytest.raises(EngineError):
            t_quantile(bad, 5)
        with pytest.raises(EngineError):
            t_critical(bad, 5)


# ------------------------------------------------------------------ cross-language robustness

# CPython's m_lgamma (Modules/mathmodule.c, Lanczos g = 6.024680040776729583740234375, 13 terms), the
# function behind math.lgamma, transliterated to Python: only arithmetic and log, the kind of lgamma a
# TypeScript port has to bring along. It differs from math.lgamma in the last bits only because the C
# build fuses two of its multiply-adds into fma instructions and this transliteration does not.
_LANCZOS_G = 6.024680040776729583740234375
_LANCZOS_NUM = (23531376880.410759688572007674451636754734846804940,
                42919803642.649098768957899047001988850926355848959,
                35711959237.355668049440185451547166705960488635843,
                17921034426.037209699919755754458931112671403265390,
                6039542586.3520280050642916443072979210699388420708,
                1439720407.3117216736632230727949123939715485786772,
                248874557.86205415651146038641322942321632125127801,
                31426415.585400194380614231628318205362874684987640,
                2876370.6289353724412254090516208496135991145378768,
                186056.26539522349504029498971604569928220784236328,
                8071.6720023658162106380029022722506138218516325024,
                210.82427775157934587250973392071336271166969580291,
                2.5066282746310002701649081771338373386264310793408)
_LANCZOS_DEN = (0.0, 39916800.0, 120543840.0, 150917976.0, 105258076.0, 45995730.0, 13339535.0, 2637558.0,
                357423.0, 32670.0, 1925.0, 66.0, 1.0)
_REAL_LGAMMA = math.lgamma


def lanczos_lgamma(x: float) -> float:
    if x == math.floor(x) and x <= 2.0:
        return 0.0
    num = den = 0.0
    if x < 5.0:
        for i in range(12, -1, -1):
            num = num * x + _LANCZOS_NUM[i]
            den = den * x + _LANCZOS_DEN[i]
    else:
        for i in range(13):
            num = num / x + _LANCZOS_NUM[i]
            den = den / x + _LANCZOS_DEN[i]
    return math.log(num / den) - _LANCZOS_G + (x - 0.5) * (math.log(x + _LANCZOS_G - 0.5) - 1)


def test_critical_values_do_not_depend_on_the_last_bits_of_lgamma(monkeypatch):
    grid = [(alpha, df) for df in range(1, 121) for alpha in (0.001, 0.0005, 0.002, 0.01, 0.05, 0.1, 1e-4, 1e-6)]
    halves = [k / 2 for k in range(1, 401)]
    differ = sum(_REAL_LGAMMA(a) != lanczos_lgamma(a) for a in halves)
    assert differ > 0 and all(abs(_REAL_LGAMMA(a) - lanczos_lgamma(a)) <= 4 * math.ulp(_REAL_LGAMMA(a)) for a in halves)
    reference = [t_critical(alpha, df) for alpha, df in grid]
    monkeypatch.setattr(tdist.math, "lgamma", lanczos_lgamma)
    swapped = [t_critical(alpha, df) for alpha, df in grid]
    same = sum(a == b for a, b in zip(reference, swapped))
    assert same == len(grid), f"{len(grid) - same} of {len(grid)} critical values changed with another lgamma"
    # the CDF itself is not bit-identical across lgammas, only within the SPEC tolerance
    diffs = [abs(t_cdf(-x, df) - _cdf_with_real(x, df)) / _cdf_with_real(x, df)
             for df in (3, 13, 60) for x in (1.0, 4.2, 9.0)]
    assert max(diffs) < 1e-9


def _cdf_with_real(x: float, df: int) -> float:
    saved = tdist.math.lgamma
    tdist.math.lgamma = _REAL_LGAMMA
    try:
        return t_cdf(-x, df)
    finally:
        tdist.math.lgamma = saved
