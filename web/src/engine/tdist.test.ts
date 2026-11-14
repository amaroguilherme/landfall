// Student's t in the TypeScript port (tdist.ts) against published tables, the paper the Tier B
// test comes from, and exact arithmetic. conformance.test.ts separately replays every Python
// vector of t_cdf / t_quantile / t_critical.
//
// Published tables, fetched and read on 2026-11-14:
// - NIST/SEMATECH e-Handbook of Statistical Methods, section 1.3.6.7.2 "Critical Values of the
//   Student's t Distribution", https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm
//   Columns are "Probability less than the critical value (t_1-alpha,nu)": 0.90 ... 0.999. It has no
//   0.9995 column, so it checks the quantile function in general, not alpha 0.001 itself.
// - Purdue University, STAT 503, "Critical Values for Student's t-Distribution", upper tail
//   probability Pr(T > t), https://www.stat.purdue.edu/~lfindsen/stat503/t-Dist.pdf. Its 0.0005
//   column (99.9% two-sided confidence) is exactly LANDFALL's two-tailed alpha 0.001.
// - Crawford JR, Howell DC. Comparing an individual's test score against norms derived from small
//   samples. Clin Neuropsychol 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241 (checked on
//   Crossref; not indexed in PubMed). Worked example pp. 483-484.

import { describe, expect, it } from 'vitest'
import { EngineError, rci, tCdf, tCritical, tQuantile } from './index'
import { BRACKET_MAX, BRACKET_MIN, LANCZOS_DEN, LANCZOS_G, LANCZOS_NUM, fma, lgamma } from './tdist'

function code(f: () => unknown): string | null {
  try {
    f()
    return null
  } catch (e) {
    return e instanceof EngineError ? e.code : `not an EngineError: ${String(e)}`
  }
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000

// Purdue STAT 503, column "0.0005" (upper tail), every row the table prints.
const PURDUE_0_0005: Record<number, number> = {
  1: 636.619, 2: 31.599, 3: 12.924, 4: 8.61, 5: 6.869, 6: 5.959, 7: 5.408, 8: 5.041, 9: 4.781, 10: 4.587,
  11: 4.437, 12: 4.318, 13: 4.221, 14: 4.14, 15: 4.073, 16: 4.015, 17: 3.965, 18: 3.922, 19: 3.883, 20: 3.85,
  21: 3.819, 22: 3.792, 23: 3.768, 24: 3.745, 25: 3.725, 26: 3.707, 27: 3.69, 28: 3.674, 29: 3.659, 30: 3.646,
  31: 3.633, 32: 3.622, 33: 3.611, 34: 3.601, 35: 3.591, 36: 3.582, 37: 3.574, 38: 3.566, 39: 3.558, 40: 3.551,
  41: 3.544, 42: 3.538, 43: 3.532, 44: 3.526, 45: 3.52, 46: 3.515, 47: 3.51, 48: 3.505, 49: 3.5, 50: 3.496,
  60: 3.46, 70: 3.435, 80: 3.416, 90: 3.402, 100: 3.39, 120: 3.373, 140: 3.361, 180: 3.345, 200: 3.34,
  500: 3.31, 1000: 3.3,
}
const PURDUE_INFINITY_0_0005 = 3.291

// NIST e-Handbook 1.3.6.7.2: P(T < t) columns and rows as printed.
const NIST_P = [0.9, 0.95, 0.975, 0.99, 0.995, 0.999] as const
const NIST_ROWS: Record<number, readonly number[]> = {
  6: [1.44, 1.943, 2.447, 3.143, 3.707, 5.208],
  10: [1.372, 1.812, 2.228, 2.764, 3.169, 4.144],
  13: [1.35, 1.771, 2.16, 2.65, 3.012, 3.852],
  20: [1.325, 1.725, 2.086, 2.528, 2.845, 3.552],
  30: [1.31, 1.697, 2.042, 2.457, 2.75, 3.385],
  60: [1.296, 1.671, 2.0, 2.39, 2.66, 3.232],
  100: [1.29, 1.66, 1.984, 2.364, 2.626, 3.174],
}
const NIST_INFINITY = [1.282, 1.645, 1.96, 2.326, 2.576, 3.09] as const

describe('critical values against published tables', () => {
  it("the lead's known answers: two-tailed alpha 0.001 (one-tailed 0.0005)", () => {
    const known: Record<number, number> = { 6: 5.959, 10: 4.587, 13: 4.221, 20: 3.85, 30: 3.646, 60: 3.46, 120: 3.373 }
    for (const [df, want] of Object.entries(known)) {
      expect(round3(tCritical(0.001, Number(df))), `df ${df}`).toBe(want)
      expect(PURDUE_0_0005[Number(df)], `df ${df} in the Purdue table`).toBe(want)
    }
    // df -> infinity tends to 3.291 from above (the normal quantile z_0.9995 = 3.2905...)
    const big = tCritical(0.001, 1e6)
    expect(round3(big)).toBe(PURDUE_INFINITY_0_0005)
    expect(big).toBeGreaterThan(3.2905267)
    expect(big - 3.2905267314918945).toBeLessThan(2e-5)
  })

  it('matches every row of the Purdue 0.0005 column to the 3 printed decimals', () => {
    for (const [df, want] of Object.entries(PURDUE_0_0005)) {
      expect(Math.abs(tCritical(0.001, Number(df)) - want), `df ${df}`).toBeLessThanOrEqual(0.0005 + 1e-9)
    }
  })

  it('matches every cell of the NIST e-Handbook table (quantiles 0.90 ... 0.999)', () => {
    for (const [df, row] of Object.entries(NIST_ROWS)) {
      NIST_P.forEach((p, i) => {
        expect(Math.abs(tQuantile(p, Number(df)) - row[i]), `df ${df}, p ${p}`).toBeLessThanOrEqual(0.0005 + 1e-9)
      })
    }
    NIST_P.forEach((p, i) => expect(Math.abs(tQuantile(p, 1e6) - NIST_INFINITY[i]), `infinity, p ${p}`).toBeLessThanOrEqual(0.0005 + 1e-9))
  })

  it('the 14-day baseline of the demo: df 13 gives 4.2208 (5.959 at the 7-day minimum, df 6)', () => {
    expect(tCritical(0.001, 13)).toBeCloseTo(4.22083, 5)
    expect(tCritical(0.001, 6)).toBeCloseTo(5.95882, 5)
  })
})

describe('Crawford & Howell (1998) worked example, pp. 483-484', () => {
  // N = 15 controls with mean 50 and SD 10, patient scores 33: t = -17 / (10 * sqrt(16/15)), df 14
  const base = [60, 60, 60, 60, 60, 60, 60, 40, 40, 40, 40, 40, 40, 40, 50]

  it('reproduces the statistic, the one-tailed .05 and .10 decisions and the p value', () => {
    const r = rci(base, 33, 0.1) // two-tailed 0.10 = one-tailed .05
    expect([r.n, r.df, r.mean, r.sd]).toEqual([15, 14, 50, 10])
    expect(r.rc).toBeCloseTo(-17 / (10 * Math.sqrt(16 / 15)), 14)
    expect(r.critical !== null && Math.round(r.critical * 100) / 100).toBe(1.76) // "1.76": not significant
    expect(r.reliable).toBe(false)
    const r10 = rci(base, 33, 0.2) // one-tailed .10: critical 1.35, significant
    expect(r10.critical !== null && Math.round(r10.critical * 100) / 100).toBe(1.35)
    expect(r10.reliable).toBe(true)
    const p = tCdf(r.rc as number, 14) // the paper rounds along the way and prints .062; exactly 0.0610
    expect(Math.round(p * 10000) / 10000).toBe(0.061)
  })
})

describe('inverse and symmetry', () => {
  it('tQuantile inverts tCdf, and the two tails sum to one', () => {
    for (const df of [1, 2, 3, 6, 13, 30, 200, 5000, 2.5, 34.391]) {
      for (const p of [1e-12, 1e-6, 0.0005, 0.025, 0.3, 0.5, 0.7, 0.9995]) {
        const t = tQuantile(p, df)
        expect(Math.abs(tCdf(t, df) - p), `df ${df}, p ${p}`).toBeLessThanOrEqual(2e-9 * Math.min(p, 1 - p) + 1e-16)
        expect(Math.abs(tCdf(-t, df) + tCdf(t, df) - 1), `df ${df}, p ${p}`).toBeLessThanOrEqual(1e-15)
      }
    }
    for (const df of [1, 13, 60]) {
      for (const alpha of [0.001, 0.05, 0.3]) expect(tCritical(alpha, df)).toBe(-tQuantile(alpha / 2, df)) // same bits
    }
    expect(tQuantile(0.5, 7)).toBe(0)
    expect(tCdf(0, 7)).toBe(0.5)
    expect(tCdf(-0, 7)).toBe(0.5)
  })

  it('handles the far tails without NaN, as the Python engine does', () => {
    expect(tCdf(9e-18, 13)).toBe(0.5) // P(T > t) rounds to 0.5 below 1e-17
    expect(tCdf(-1e200, 1) * Math.PI * 1e200).toBeCloseTo(1, 12) // Cauchy tail ~ 1/(pi t)
    expect(tCdf(1e200, 1)).toBe(1)
    expect(tCdf(-1e200, 13)).toBe(0)
    expect(tQuantile(1e-290, 1) * Math.PI * -1e-290).toBeCloseTo(1, 9)
    expect(code(() => tQuantile(1e-305, 1))).toBe('invalid_argument') // root beyond 2^1000
  })

  it('rejects arguments outside the SPEC domain', () => {
    for (const df of [0, 0.5, 0.999, -1, 1000001, NaN, Infinity, true, null, '13']) {
      expect(code(() => tCdf(1, df as number)), String(df)).toBe('invalid_argument')
      expect(code(() => tQuantile(0.9, df as number)), String(df)).toBe('invalid_argument')
      expect(code(() => tCritical(0.05, df as number)), String(df)).toBe('invalid_argument')
    }
    for (const bad of [0, 1, -0.1, 1.5, NaN, true, '0.5']) {
      expect(code(() => tQuantile(bad as number, 5)), String(bad)).toBe('invalid_argument')
      expect(code(() => tCritical(bad as number, 5)), String(bad)).toBe('invalid_argument')
    }
    for (const bad of [NaN, Infinity, -Infinity, true, null, '1']) expect(code(() => tCdf(bad as number, 5)), String(bad)).toBe('invalid_argument')
  })

  it('brackets are exact powers of two', () => {
    expect(BRACKET_MAX).toBe(2 ** 1000)
    expect(BRACKET_MIN).toBe(2 ** -1000)
    expect(BRACKET_MAX * BRACKET_MIN).toBe(1)
  })
})

describe('the lgamma port (CPython m_lgamma, with the reference build fused multiply-adds)', () => {
  it('uses the CPython Lanczos constants (Modules/mathmodule.c, 50-digit literals)', () => {
    // The port writes them as the shortest round-trip decimal; V8 parses the C literals correctly.
    // Copied from https://github.com/python/cpython/blob/3.12/Modules/mathmodule.c (lanczos_g,
    // lanczos_num_coeffs, lanczos_den_coeffs), read on 2026-11-14.
    expect(LANCZOS_G).toBe(6.024680040776729583740234375)
    const cNum = [
      '23531376880.410759688572007674451636754734846804940',
      '42919803642.649098768957899047001988850926355848959',
      '35711959237.355668049440185451547166705960488635843',
      '17921034426.037209699919755754458931112671403265390',
      '6039542586.3520280050642916443072979210699388420708',
      '1439720407.3117216736632230727949123939715485786772',
      '248874557.86205415651146038641322942321632125127801',
      '31426415.585400194380614231628318205362874684987640',
      '2876370.6289353724412254090516208496135991145378768',
      '186056.26539522349504029498971604569928220784236328',
      '8071.6720023658162106380029022722506138218516325024',
      '210.82427775157934587250973392071336271166969580291',
      '2.5066282746310002701649081771338373386264310793408',
    ]
    expect([...LANCZOS_NUM]).toEqual(cNum.map(Number))
    expect([...LANCZOS_DEN]).toEqual([0, 39916800, 120543840, 150917976, 105258076, 45995730, 13339535, 2637558, 357423, 32670, 1925, 66, 1])
  })

  it('is accurate to a few ulps against exact values', () => {
    // log of exact factorials and of sqrt(pi) (correctly rounded doubles)
    const exact: Array<[number, number]> = [
      [0.5, 0.5723649429247001], // ln(sqrt(pi))
      [3, Math.LN2],
      [4, 1.791759469228055], // ln 6
      [10, 12.801827480081469], // ln 9!
      [20, 39.339884187199495], // ln 19!
      [101, 363.73937555556347], // ln 100!
    ]
    for (const [x, want] of exact) {
      const ulp = 2 ** (Math.floor(Math.log2(Math.abs(want))) - 52)
      expect(Math.abs(lgamma(x) - want) / ulp, `lgamma(${x})`).toBeLessThanOrEqual(8)
    }
    expect(lgamma(1)).toBe(0)
    expect(lgamma(2)).toBe(0)
  })

  it("returns the reference build's math.lgamma bits where only the fused multiply-adds tell them apart", () => {
    // Python 3.12.12 (python-build-standalone, clang, macOS arm64) math.lgamma(x), repr. Each value
    // differs from an unfused evaluation of the same C code (shown second), which is why lgamma()
    // performs those two steps with fma(). x < 5 exercises the fused Horner loop, x >= 5 the fused
    // final step; 17.1955 is df 34.391 / 2 from the random vectors, 500000.5 is df 1e6 / 2 + 1/2.
    const reference: Array<[number, number, number]> = [
      [1.25, -0.09827183642181264, -0.0982718364218127],
      [2.535707990794184, 0.31010202188106567, 0.3101020218810655],
      [4.0, 1.791759469228055, 1.7917594692280554],
      [4.5, 2.4537365708424432, 2.453736570842443],
      [4.999, 3.176547823349123, 3.1765478233491224],
      [6.5, 5.662562059857141, 5.662562059857139],
      [7.0, 6.579251212010101, 6.579251212010102],
      [9.0, 10.60460290274525, 10.604602902745249],
      [12.5, 18.734347511936445, 18.73434751193645],
      [17.1955, 31.221100253892644, 31.22110025389264],
      [26.0, 58.00360522298051, 58.00360522298052],
      [500000.5, 6061182.607640615, 6061182.607640614],
    ]
    for (const [x, fused, unfused] of reference) {
      expect(lgamma(x), `lgamma(${x})`).toBe(fused)
      expect(fused).not.toBe(unfused)
    }
  })

  it('fma rounds once: exact known answers (computed with exact rational arithmetic)', () => {
    // 0.1 * 10 - 1 is 2^-54 exactly (0.1 is slightly above 1/10); the unfused expression gives 0
    expect(fma(0.1, 10, -1)).toBe(2 ** -54)
    expect(0.1 * 10 - 1).toBe(0)
    // (1 + 2^-30)^2 - 1 = 2^-29 + 2^-60: the fused result keeps the 2^-60 term, the unfused one loses it
    const a = 1 + 2 ** -30
    expect(fma(a, a, -1)).toBe(2 ** -29 + 2 ** -60)
    expect(a * a - 1).toBe(2 ** -29)
    // a tie in the final rounding goes to even: 1 + 2^-53 rounds to 1, 1 + 3 * 2^-53 to 1 + 2^-51
    expect(fma(2 ** -27, 2 ** -26, 1)).toBe(1)
    expect(fma(3 * 2 ** -27, 2 ** -26, 1)).toBe(1 + 2 ** -51)
    // exact cancellation is +0; zeros, signs and plain products behave like IEEE
    expect(Object.is(fma(2, 3, -6), 0)).toBe(true)
    expect(fma(2, 3, 4)).toBe(10)
    expect(fma(-1.5, 2, 0)).toBe(-3)
    expect(fma(1e308, 10, -1e308)).toBe(Infinity) // 9e308 overflows
    // subnormal results are rounded once, at the subnormal precision, ties to even
    expect(fma(2 ** -1074, 0.5, 2 ** -1074)).toBe(2 ** -1073) // 1.5 * 2^-1074 (unfused: 2^-1074)
    expect(fma(2 ** -1074, -0.5, 2 ** -1074)).toBe(0) // 0.5 * 2^-1074 (unfused: 2^-1074)
  })
})
