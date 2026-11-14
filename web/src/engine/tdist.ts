// Student's t distribution for Tier B (SPEC section 5): CDF, quantile, two-tailed critical value.
// Step-for-step port of engine/tdist.py: same constants, same branches, same evaluation order.
//
//   P(T > t) = 0.5 * I_x(df/2, 1/2),  x = df / (df + t^2),  for t >= 0
//              (exactly 0.5 below t = 1e-17; above t = 1e150, ln x = ln df - 2 ln t)
//   I_x(a, b)  regularized incomplete beta: front factor exp(lgamma(a+b) - lgamma(a) - lgamma(b)
//              + a ln x + b ln(1-x)), continued fraction by the modified Lentz method when
//              x < (a+1)/(a+b+2), else the symmetry I_x(a, b) = 1 - I_(1-x)(b, a)
//              (Numerical Recipes, 3rd ed., section 6.4).
//   inverse    bracket the root between consecutive powers of two, then exactly BISECTION_STEPS
//              bisection steps; the midpoint is returned (relative error < 2^-33).
//
// lgamma. JavaScript has none, so this file carries a port of the one Python's math.lgamma runs:
// CPython's m_lgamma (Modules/mathmodule.c), a 13-term Lanczos approximation, g = 6.0246800407767296.
// The reference build that generated the vectors (python-build-standalone, clang, arm64) fuses two
// multiply-adds in that C code into single-rounding fma instructions (the x < 5 Horner steps and the
// final `r += (x - 0.5) * (...)`). fma() below performs those steps exactly, so this lgamma
// returns the reference's bits whenever Math.log returns the platform log's bits. Math.log and
// Math.exp are not guaranteed to match the C library in the last bit, which is why SPEC section 5
// holds t_cdf to the 1e-9 tolerance rather than bit equality. The fixed 32 bisection steps keep
// t_quantile / t_critical identical despite that noise for every df the engine uses and in every
// vector (conformance.test.ts measures it). At large df lgamma(df/2) is about (df/2) ln(df/2), so one
// ulp of it is no longer negligible and a late halving can differ: measured up to ~3e-10 relative
// below df 1e5 and ~3e-9 above it, which is why SPEC section 6 allows 1e-8 there.

import { EngineError } from './errors'
import { requireNumber } from './fmt'
import { pyRepr } from './py'

export const CF_EPS = 1e-15 // continued fraction stops when |delta - 1| < CF_EPS
export const CF_TINY = 1e-300 // Lentz: replaces a zero denominator
export const CF_MAX_ITER = 10000 // never reached for DF_MIN <= df <= DF_MAX
export const BISECTION_STEPS = 32
export const DF_MIN = 1.0 // keeps x = df / (df + t^2) a normal double for every t <= T_HUGE
export const DF_MAX = 1e6 // beyond this the log-beta cancellation costs more than 1e-9 relative
export const T_TINY = 1e-17 // below this P(T > t) rounds to 0.5 for every df: returned exactly
export const T_HUGE = 1e150 // above this t^2 nears overflow: x = df / t^2 is formed from logarithms

/** 2^k exactly, built from the bit pattern (never through Math.pow), for -1074 <= k <= 1023. */
function pow2(k: number): number {
  if (k > 1023) return Infinity
  if (k < -1074) return 0
  const view = new DataView(new ArrayBuffer(8))
  if (k >= -1022) view.setBigUint64(0, BigInt(k + 1023) << 52n)
  else view.setBigUint64(0, 1n << BigInt(k + 1074))
  return view.getFloat64(0)
}

export const BRACKET_MAX = pow2(1000)
export const BRACKET_MIN = pow2(-1000)

// ---------------------------------------------------------------------------------- exact fma

const F64 = new DataView(new ArrayBuffer(8))

/** Finite x as m * 2^e exactly, m a signed BigInt (0n for +-0). */
function decompose(x: number): [bigint, number] {
  F64.setFloat64(0, x)
  const bits = F64.getBigUint64(0)
  const expField = Number((bits >> 52n) & 0x7ffn)
  const frac = bits & 0xfffffffffffffn
  const m = expField === 0 ? frac : frac | (1n << 52n)
  const e = expField === 0 ? -1074 : expField - 1075
  return [bits >> 63n === 1n ? -m : m, e]
}

function bitLength(a: bigint): number {
  const hex = a.toString(16)
  return (hex.length - 1) * 4 + (32 - Math.clz32(parseInt(hex[0], 16)))
}

/** m * 2^e (m a nonzero BigInt) rounded once to the nearest double, ties to even. */
function roundScaled(m: bigint, e: number): number {
  const neg = m < 0n
  let a = neg ? -m : m
  const lead = bitLength(a) - 1 + e // exponent of the leading bit
  const ulpExp = Math.max(lead - 52, -1074) // last place of the result (normal or subnormal)
  if (ulpExp > e) {
    const s = BigInt(ulpExp - e)
    const q = a >> s
    const rem = a - (q << s)
    const half = 1n << (s - 1n)
    a = rem > half || (rem === half && (q & 1n) === 1n) ? q + 1n : q
    e = ulpExp
  }
  // a has at most 54 bits (2^53 after a carry) and e >= -1074: the product is exact or overflows
  const r = Number(a) * pow2(e)
  return neg ? -r : r
}

/**
 * x * y + z with a single rounding (C99 fma, round to nearest even), computed exactly with BigInt.
 * Used only for the two multiply-adds that the reference build of CPython's lgamma fuses.
 */
export function fma(x: number, y: number, z: number): number {
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return x * y + z
  const [mx, ex] = decompose(x)
  const [my, ey] = decompose(y)
  const [mz, ez] = decompose(z)
  const p = mx * my
  if (p === 0n) return x * y + z // the exact product is +-0: one rounding, IEEE signed zeros
  if (mz === 0n) return x * y // round(x * y + 0) = round(x * y)
  const ep = ex + ey
  const e = Math.min(ep, ez)
  const s = (p << BigInt(ep - e)) + (mz << BigInt(ez - e))
  if (s === 0n) return 0 // exact cancellation is +0 in round-to-nearest
  return roundScaled(s, e)
}

// ---------------------------------------------------------------------------------- lgamma

// CPython Modules/mathmodule.c: lanczos_g and the numerator / denominator coefficients, written as
// the shortest decimal that round-trips to the same double (the C source has 50 digits; JS parsers
// only have to honour the first 20).
export const LANCZOS_G = 6.02468004077673
export const LANCZOS_NUM = [
  23531376880.41076, 42919803642.6491, 35711959237.35567, 17921034426.03721, 6039542586.352028,
  1439720407.3117216, 248874557.86205417, 31426415.585400194, 2876370.6289353725, 186056.26539522348,
  8071.672002365816, 210.82427775157936, 2.5066282746310002,
] as const
export const LANCZOS_DEN = [
  0.0, 39916800.0, 120543840.0, 150917976.0, 105258076.0, 45995730.0, 13339535.0, 2637558.0, 357423.0,
  32670.0, 1925.0, 66.0, 1.0,
] as const

function lanczosSum(x: number): number {
  let num = 0.0
  let den = 0.0
  if (x < 5.0) {
    for (let i = 12; i >= 0; i--) {
      num = fma(num, x, LANCZOS_NUM[i]) // C: num = num * x + c, fused by the reference build
      den = fma(den, x, LANCZOS_DEN[i])
    }
  } else {
    for (let i = 0; i < 13; i++) {
      num = num / x + LANCZOS_NUM[i]
      den = den / x + LANCZOS_DEN[i]
    }
  }
  return num / den
}

const LGAMMA_CACHE = new Map<number, number>()

/** log|Gamma(x)| for finite x > 0: CPython's m_lgamma (see the header). Pure, so memoized. */
export function lgamma(x: number): number {
  const hit = LGAMMA_CACHE.get(x)
  if (hit !== undefined) return hit
  let r: number
  if (x === Math.floor(x) && x <= 2.0) {
    r = 0.0 // lgamma(1) = lgamma(2) = 0 (the engine never passes x <= 0)
  } else if (x < 1e-20) {
    r = -Math.log(x)
  } else {
    r = Math.log(lanczosSum(x)) - LANCZOS_G
    r = fma(x - 0.5, Math.log(x + LANCZOS_G - 0.5) - 1, r) // C: r += (x - 0.5) * (log(x + g - 0.5) - 1)
  }
  if (LGAMMA_CACHE.size >= 4096) LGAMMA_CACHE.clear()
  LGAMMA_CACHE.set(x, r)
  return r
}

// ---------------------------------------------------------------------------------- incomplete beta

/** Continued fraction of I_x(a, b) (modified Lentz). Evaluation order is part of the contract. */
function betacf(a: number, b: number, x: number): number {
  const qab = a + b
  const qap = a + 1.0
  const qam = a - 1.0
  let c = 1.0
  let d = 1.0 - (qab * x) / qap
  if (Math.abs(d) < CF_TINY) d = CF_TINY
  d = 1.0 / d
  let h = d
  for (let i = 1; i <= CF_MAX_ITER; i++) {
    const m = i
    const m2 = 2.0 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1.0 + aa * d
    if (Math.abs(d) < CF_TINY) d = CF_TINY
    c = 1.0 + aa / c
    if (Math.abs(c) < CF_TINY) c = CF_TINY
    d = 1.0 / d
    h = h * (d * c)
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1.0 + aa * d
    if (Math.abs(d) < CF_TINY) d = CF_TINY
    c = 1.0 + aa / c
    if (Math.abs(c) < CF_TINY) c = CF_TINY
    d = 1.0 / d
    const delta = d * c
    h = h * delta
    if (Math.abs(delta - 1.0) < CF_EPS) return h
  }
  throw new EngineError('invalid_argument', 't distribution: continued fraction did not converge')
}

/**
 * Regularized incomplete beta I_x(a, b) for 0 < x < 1. y = 1 - x and both logarithms are passed in,
 * so 1 - x is never formed by subtraction and x may underflow to 0 while lnX stays exact.
 */
function betai(a: number, b: number, x: number, y: number, lnX: number, lnY: number): number {
  const lnFront = lgamma(a + b) - lgamma(a) - lgamma(b) + a * lnX + b * lnY
  const front = Math.exp(lnFront)
  if (x < (a + 1.0) / (a + b + 2.0)) return (front * betacf(a, b, x)) / a
  return 1.0 - (front * betacf(b, a, y)) / b
}

/** P(T > t) for t >= 0 (df already validated): 0.5 * I_x(df/2, 1/2), x = df / (df + t^2). */
function upperTail(t: number, df: number): number {
  if (t < T_TINY) return 0.5
  const a = 0.5 * df
  if (t > T_HUGE) {
    // x = df / t^2 to within 1e-294 relative; 1 - x = 1 likewise
    const lnX = Math.log(df) - 2.0 * Math.log(t)
    return 0.5 * betai(a, 0.5, Math.exp(lnX), 1.0, lnX, 0.0)
  }
  const t2 = t * t
  const s = df + t2
  const x = df / s
  const y = t2 / s
  return 0.5 * betai(a, 0.5, x, y, Math.log(x), Math.log(y))
}

/** t > 0 with P(T > t) = q, for 0 < q < 0.5 (both already validated). */
function upperTailInverse(q: number, df: number): number {
  let lo: number
  let hi: number
  if (upperTail(1.0, df) > q) {
    // root above 1: double until the tail is at or below q
    lo = 1.0
    hi = 2.0
    while (upperTail(hi, df) > q) {
      lo = hi
      hi = hi * 2.0
      if (hi > BRACKET_MAX) {
        throw new EngineError('invalid_argument', `t quantile beyond 2^1000 (tail ${pyRepr(q)}, df ${pyRepr(df)})`)
      }
    }
  } else {
    // root at or below 1: halve until the tail exceeds q
    lo = 0.5
    hi = 1.0
    while (!(upperTail(lo, df) > q)) {
      hi = lo
      lo = lo * 0.5
      if (lo < BRACKET_MIN) {
        throw new EngineError('invalid_argument', `t quantile below 2^-1000 (tail ${pyRepr(q)}, df ${pyRepr(df)})`)
      }
    }
  }
  for (let i = 0; i < BISECTION_STEPS; i++) {
    // invariant: P(T > lo) > q >= P(T > hi)
    const mid = 0.5 * (lo + hi)
    if (upperTail(mid, df) > q) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

function requireDf(df: unknown): number {
  requireNumber(df, 'df')
  const v = df as number
  if (!(DF_MIN <= v && v <= DF_MAX)) throw new EngineError('invalid_argument', `df must be in [1, 1e6], got ${pyRepr(df)}`)
  return v
}

function requireOpenUnit(x: unknown, what: string): number {
  requireNumber(x, what)
  const v = x as number
  if (!(0.0 < v && v < 1.0)) throw new EngineError('invalid_argument', `${what} must be in (0, 1), got ${pyRepr(x)}`)
  return v
}

/** P(T <= t) for Student's t with df degrees of freedom (1 <= df <= 1e6, need not be an integer). */
export function tCdf(t: number, df: number): number {
  requireNumber(t, 't')
  requireDf(df)
  if (t >= 0.0) return 1.0 - upperTail(t, df)
  return upperTail(-t, df)
}

/** The t with P(T <= t) = p, for 0 < p < 1 (inverse of tCdf; 0 exactly at p = 0.5). */
export function tQuantile(p: number, df: number): number {
  requireOpenUnit(p, 'p')
  requireDf(df)
  if (p === 0.5) return 0.0
  if (p > 0.5) return upperTailInverse(1.0 - p, df)
  return -upperTailInverse(p, df)
}

/**
 * Two-tailed critical value c with P(|T| > c) = alpha, for 0 < alpha < 1. Computed on the upper
 * tail directly (root of P(T > c) = alpha / 2), so it equals -tQuantile(alpha / 2, df) exactly.
 */
export function tCritical(alpha: number, df: number): number {
  requireOpenUnit(alpha, 'alpha')
  requireDf(df)
  return upperTailInverse(alpha / 2.0, df)
}
