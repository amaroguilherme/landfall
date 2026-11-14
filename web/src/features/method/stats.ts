// Statistics used to explain Tier B honestly. Pure functions, no NASA numbers: every input is
// passed in from engine/rules/personal.json. The constants below are mathematical (coefficients
// of a published erfc approximation and the two-sided 95% normal quantile).
import { expectedFalseAlarms } from '../../app/engine'

/** Complementary error function, Abramowitz & Stegun 7.1.26 (absolute error below 1.5e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * z)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const r = poly * Math.exp(-z * z)
  return x >= 0 ? r : 2 - r
}

/** P(|Z| >= z) for a standard normal Z. */
export function twoTailP(z: number): number {
  return erfc(Math.abs(z) / Math.SQRT2)
}

/**
 * Where the Tier B flag sits in units of the crewmember's own baseline SD:
 * |RC| >= z_c with RC = (x - mean) / (SD x sqrt(2) x sqrt(1 - r)) means |x - mean| >= z_c x sqrt(2(1 - r)) SD.
 */
export function flagAtSd(criticalZ: number, r: number): number {
  return criticalZ * Math.SQRT2 * Math.sqrt(1 - r)
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

/**
 * The engine's expected_false_alarms (SPEC 5), read defensively: the shell shim returns
 * {expected, one_every_days}; the SPEC port returns {expected, per_day, every_n_days, ...}.
 */
export function falseAlarms(k: number, days: number, alpha: number): { expected: number; everyNDays: number | null } {
  const res = expectedFalseAlarms(k, days, alpha) as unknown as Record<string, unknown>
  const expected = typeof res.expected === 'number' ? res.expected : k * days * alpha
  const every =
    typeof res.every_n_days === 'number' ? res.every_n_days : typeof res.one_every_days === 'number' ? res.one_every_days : null
  return { expected, everyNDays: every !== null && Number.isFinite(every) ? every : null }
}

/** Round for display ("about one every N days"), keeping one decimal. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10
}
