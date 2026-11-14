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
 * (SPEC 5 expected_false_alarms): flags in either direction, and cautions (worse direction only).
 */
export function chanceRates(k: number, days: number, alpha: number): FalseAlarms {
  return expectedFalseAlarms(k, days, alpha)
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
