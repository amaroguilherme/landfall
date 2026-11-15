// Statistics used to explain Tier B honestly. Pure functions, no NASA numbers: every input is
// passed in from engine/rules/personal.json, and the t distribution and the chance rates are the
// engine's own (tCritical and expectedFalseAlarms, through the facade), so the page prints exactly
// what the engine computes. The constants below are mathematical (the two-sided 95% normal quantile
// for the SD interval).
import { T_DF_MAX, expectedFalseAlarms, tCritical } from '../../app/engine'
import type { FalseAlarms } from '../../app/engine'

/** One row of the critical-value table: the engine's two-tailed critical t for a baseline of n days. */
export interface CriticalRow {
  /** Baseline days (null: an unlimited baseline, where t becomes the normal distribution). */
  n: number | null
  df: number
  critical: number
  /** The flag line in baseline SDs from the mean: critical x sqrt(1 + 1/n) (critical itself when n is unlimited). */
  bandSd: number
}

/** Critical value and band width for an n-day baseline (Crawford & Howell 1998: df = n - 1). */
export function criticalRow(alpha: number, n: number): CriticalRow {
  const df = n - 1
  const critical = tCritical(alpha, df)
  return { n, df, critical, bandSd: critical * Math.sqrt(1 + 1 / n) }
}

/** The limit of a very long baseline: the engine's t at its largest df, i.e. the normal value. */
export function unlimitedRow(alpha: number): CriticalRow {
  const critical = tCritical(alpha, T_DF_MAX)
  return { n: null, df: T_DF_MAX, critical, bandSd: critical }
}

/**
 * Chance findings for k alerting indicators over `days` days, straight from the engine
 * (SPEC 5 expected_false_alarms): flags in either direction, and cautions. `kEither` of the k alert
 * in both directions (every chance flag of theirs is a caution); it is passed to an engine that takes
 * it, and the result then carries `k_either`. An engine without it counts every indicator as one-sided,
 * and the page says its caution figure is then too low.
 */
export function chanceRates(k: number, days: number, alpha: number, kEither = 0): FalseAlarms & { k_either?: number } {
  const fn = expectedFalseAlarms as unknown as (k: number, d: number, a: number, e?: number) => FalseAlarms & { k_either?: number }
  return kEither > 0 ? fn(k, days, alpha, kEither) : fn(k, days, alpha)
}

/** True when an engine result already counts the both-direction indicators. */
export function countsEither(r: { k_either?: unknown } | null | undefined): boolean {
  return !!r && typeof r.k_either === 'number'
}

/** Confidence level of sdInterval95, and its two-sided standard-normal quantile (they go together). */
export const SD_INTERVAL_LEVEL = 0.95
const Z_975 = 1.959963984540054

/** Chi-square quantile for k degrees of freedom at normal quantile zp (Wilson-Hilferty approximation). */
export function chiSquareQuantile(zp: number, k: number): number {
  const a = 2 / (9 * k)
  const c = 1 - a + zp * Math.sqrt(a)
  return k * c * c * c
}

/** 95% confidence interval for the true SD, as multiples of a sample SD from n values (df = n - 1). */
export function sdInterval95(n: number): { lo: number; hi: number } {
  const k = n - 1
  return { lo: Math.sqrt(k / chiSquareQuantile(Z_975, k)), hi: Math.sqrt(k / chiSquareQuantile(-Z_975, k)) }
}

/** Round for display ("about one every N days"), keeping one decimal. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/**
 * A measured multiplier from the study's own counts (hits / tests / nominal rate), falling back to its stored
 * 2-decimal value, with the digits personal.json uses for a declaration (SPEC 3.3): 2 decimals, or 3 for a borderline
 * value whose 2-decimal rounding would land on a band edge it is not on. So mood's 0.495 never prints 0.50, inside
 * the band it is outside of.
 */
export function measuredMultiplier(
  hits: number | undefined,
  tests: number | undefined,
  nominal: number | undefined,
  stored: number | undefined,
  band: readonly [number, number] | null,
): { value: number | null; digits: number } {
  const x = typeof hits === 'number' && typeof tests === 'number' && tests > 0 && typeof nominal === 'number' && nominal > 0 ? hits / tests / nominal : (stored ?? null)
  if (x === null || !Number.isFinite(x)) return { value: null, digits: 2 }
  const r2 = Math.round(x * 100) / 100
  const borderline = band !== null && (r2 === band[0] || r2 === band[1]) && x !== r2
  return { value: x, digits: borderline ? 3 : 2 }
}
