// Tier B: reliable change against the crewmember's own baseline, port of engine/rci.py (SPEC
// sections 1.3, 3.3 and 5).
//
// The question is Jacobson & Truax's (1991): is today's value further from this person's usual value
// than day-to-day noise explains? The arithmetic is the single-case test for one new observation
// against the mean of n baseline observations from the same person, the modified t-test of
// Crawford & Howell (1998):
//
//   s_diff   = sd * sqrt(1 + 1/n)        sd: sample SD (n - 1) of the n baseline values
//   rc       = (current - mean) / s_diff  (the t statistic of the single-case test)
//   df       = n - 1
//   critical = tCritical(alpha, df)       two-tailed, alpha from personal.json (0.001)
//   reliable when |rc| > critical
//   mdc      = critical * s_diff           the minimum detectable change: the band's half-width
//
// Under normal, independent day-to-day noise the chance of a reliable change is exactly alpha per
// indicator-day (alpha / 2 in a given direction); autocorrelated or skewed data raise it
// (personal.json rci.caveat). No test-retest reliability is involved: the earlier arithmetic,
// S_diff = sd * sqrt(2) * sqrt(1 - r) on the crewmember's own baseline SD, shrank the denominator
// and flagged far more often than the alpha it printed (engine/rci.py explains the audit).
//
// Counts (SPEC 3.3, indicator "transform"): an indicator may declare a variance-stabilizing transform that
// evaluatePersonal applies to every baseline value and to the current value before the test. The only one is
// "anscombe", y = 2 * sqrt(x + 3/8) for a count x >= 0 (Anscombe 1948). The band is computed on that scale and
// mapped back with the algebraic inverse x = (y / 2)^2 - 3/8; the transform is monotone, so a raw value is
// outside the mapped band exactly when its transform is outside the band of the test.
//
// Chance rates (chanceRate): nominal alpha per indicator-day for a flag in either direction, alpha / 2 for a
// caution (alpha for worse "either"), or the multiples an indicator declares in personal.json when a seeded
// Monte Carlo under the scenario's noise model measured something else (engine/tests/test_chance_rates.py).
//
// Crawford JR, Howell DC. Comparing an individual's test score against norms derived from small
// samples. Clin Neuropsychol 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241
// Anscombe FJ. The transformation of Poisson, binomial and negative-binomial data. Biometrika
// 1948;35(3-4):246-254. doi:10.1093/biomet/35.3-4.246

import { EngineError } from './errors'
import { fmtNum, isNumber, requireNumber, sumLR } from './fmt'
import { has, isInt, isObj, pyGet, pyOr, pyRepr, pyStr } from './py'
import { tCritical } from './tdist'
import { basisText, coerceValue } from './thresholds'
import type {
  ChanceRate,
  Direction,
  FalseAlarms,
  Indicator,
  MinDetectableChange,
  PersonalFinding,
  RciConfig,
  RciReason,
  RciResult,
  RuleValue,
  Severity,
  Status,
  Transform,
} from './types'

export const WORSE_VALUES = ['increase', 'decrease', 'either'] as const
export const RCI_METHOD = 'crawford_howell_1998' as const
export const TRANSFORMS = ['anscombe'] as const
/** 3/8 (Anscombe 1948): y = 2 * sqrt(x + 3/8). */
export const ANSCOMBE_OFFSET = 0.375
export const ANSCOMBE_SCALE_TEXT = '2√(x + 3/8)'
/** "about 1 in N days" is printed below this; above it, "fewer than 1 in 10^12". */
export const CHANCE_TEXT_MAX_DAYS = 1e12
/** Chance-rate multipliers print with up to 3 decimals (0.45, 0.495; SPEC 5). */
export const MULTIPLIER_DP = 3
/** At or above it the multiplier text is "10^9 or more". */
export const MULTIPLIER_TEXT_MAX = 1e9

// tCritical is pure; memoized because every Tier B evaluation asks for the same few values
// (Python: functools.lru_cache on rci._critical).
const CRITICAL_CACHE = new Map<number, Map<number, number>>()

function critical(alpha: number, df: number): number {
  let byDf = CRITICAL_CACHE.get(alpha)
  if (byDf === undefined) {
    if (CRITICAL_CACHE.size >= 256) CRITICAL_CACHE.clear()
    byDf = new Map()
    CRITICAL_CACHE.set(alpha, byDf)
  }
  let c = byDf.get(df)
  if (c === undefined) {
    c = tCritical(alpha, df)
    byDf.set(df, c)
  }
  return c
}

function validateAlpha(alpha: unknown): number {
  requireNumber(alpha, 'alpha')
  const a = alpha as number
  if (!(0.0 < a && a < 1.0)) throw new EngineError('invalid_argument', `alpha must be in (0, 1), got ${pyStr(alpha)}`)
  return a
}

/**
 * Single-case test of `current` against `baseline` (numbers; null entries are skipped).
 * status "ok" or "insufficient_data" (reason baseline_too_short, no_current or zero_sd, checked in
 * that order). Fields are reported when computable: mean needs n >= 1; sd, df and s_diff need
 * n >= 2; critical needs n >= minBaselineN; rc needs status "ok"; mdc (critical * s_diff, the
 * smallest change from the mean that is a reliable change) needs critical and an SD above 0, so it
 * is reported even without a current value. zero_sd is an exact constancy test, so float noise
 * cannot fake a reliable change. A baseline mean or SD, the minimum detectable change or the
 * statistic that is not finite raises invalid_argument: the engine never returns NaN or infinity.
 */
export function rci(
  baseline: ReadonlyArray<number | null>,
  current: number | null,
  alpha: number = 0.001,
  minBaselineN: number = 7,
): RciResult {
  if (!Array.isArray(baseline)) throw new EngineError('invalid_argument', 'baseline must be a list')
  validateAlpha(alpha)
  if (!isInt(minBaselineN) || minBaselineN < 2) {
    throw new EngineError('invalid_argument', 'min_baseline_n must be an integer >= 2')
  }
  const xs: number[] = []
  for (const x of baseline as readonly unknown[]) {
    if (x === null || x === undefined) continue
    xs.push(requireNumber(x, 'baseline value'))
  }
  const cur = current === undefined ? null : current
  if (cur !== null) requireNumber(cur, 'current')
  const n = xs.length
  const mean = n >= 1 ? sumLR(xs) / n : null
  let sd: number | null = null
  if (n >= 2 && mean !== null) {
    let constant = true
    for (const x of xs) if (x !== xs[0]) constant = false
    if (constant) {
      // exact test: [7.3]*7 has true SD 0, but the float mean is off by 1 ulp and the computed SD
      // would be ~1e-15, turning any change into an astronomically "reliable" one
      sd = 0.0
    } else {
      let ss = 0.0
      for (const x of xs) {
        const d = x - mean
        ss = ss + d * d
      }
      sd = Math.sqrt(ss / (n - 1))
    }
  }
  if ((mean !== null && !Number.isFinite(mean)) || (sd !== null && !Number.isFinite(sd))) {
    throw new EngineError('invalid_argument', 'baseline mean or SD is not finite (values too large)')
  }
  const df = n >= 2 ? n - 1 : null
  const sDiff = sd !== null ? sd * Math.sqrt(1.0 + 1.0 / n) : null
  const crit = n >= minBaselineN && df !== null ? critical(alpha, df) : null
  let mdc: number | null = null
  if (crit !== null && sDiff !== null && sd !== null && sd > 0) {
    mdc = crit * sDiff
    if (!Number.isFinite(mdc)) {
      throw new EngineError('invalid_argument', 'the minimum detectable change is not finite (values too large)')
    }
  }
  let direction: Direction | null = null
  if (mean !== null && cur !== null) direction = cur > mean ? 'increase' : cur < mean ? 'decrease' : 'none'
  const out: RciResult = {
    method: RCI_METHOD,
    status: 'insufficient_data',
    reason: null,
    n,
    df,
    mean,
    sd,
    s_diff: sDiff,
    rc: null,
    critical: crit,
    alpha,
    reliable: false,
    direction,
    mdc,
  }
  if (n < minBaselineN) return { ...out, reason: 'baseline_too_short' }
  if (cur === null) return { ...out, reason: 'no_current' }
  if (sd === 0 || mean === null || sDiff === null || crit === null) return { ...out, reason: 'zero_sd' }
  const rc = (cur - mean) / sDiff
  if (!Number.isFinite(rc)) throw new EngineError('invalid_argument', 'the t statistic is not finite (values too large)')
  return { ...out, status: 'ok', rc, reliable: Math.abs(rc) > crit }
}

function validateIndicator(ind: unknown): asserts ind is Indicator {
  if (!isObj(ind)) throw new EngineError('invalid_rule', 'indicator must be an object')
  for (const key of ['id', 'variable', 'unit', 'worse', 'alerting']) {
    if (!has(ind, key)) throw new EngineError('invalid_rule', `indicator ${pyStr(pyGet(ind, 'id'))} lacks '${key}'`)
  }
  const id = pyStr(ind.id)
  if (!(WORSE_VALUES as readonly unknown[]).includes(ind.worse)) {
    throw new EngineError('invalid_rule', `indicator ${id}: worse must be one of increase, decrease, either`)
  }
  if (typeof ind.alerting !== 'boolean') throw new EngineError('invalid_rule', `indicator ${id}: alerting must be true or false`)
  const tf = pyGet(ind, 'transform')
  if (tf !== null && !(TRANSFORMS as readonly unknown[]).includes(tf)) {
    throw new EngineError('invalid_rule', `indicator ${id}: transform must be one of ('anscombe',) or null`)
  }
}

/** The declared transform of one raw value (null passes through; no transform is the identity). */
function transformValue(tf: Transform | null, x: number | null, what: string): number | null {
  if (x === null || tf === null) return x
  if (x < 0) throw new EngineError('invalid_argument', `${what}: the anscombe transform needs a count >= 0, got ${pyRepr(x)}`)
  return 2.0 * Math.sqrt(x + ANSCOMBE_OFFSET)
}

/**
 * A band edge on the test scale mapped back to the raw scale (identity without a transform). anscombe:
 * (y / 2)^2 - 3/8, the algebraic inverse, for y >= 0; an edge below 0 maps to -3/8, the bottom of the domain.
 */
function untransform(tf: Transform | null, y: number): number {
  if (tf === null) return y
  const h = (y > 0.0 ? y : 0.0) / 2.0
  return h * h - ANSCOMBE_OFFSET
}

/** '4.5 h', or a bare '4' for a count. */
function qty(x: number, unit: string): string {
  return unit === 'count' ? fmtNum(x) : `${fmtNum(x)} ${pyStr(unit)}`
}

function validateCfg(cfg: unknown): asserts cfg is RciConfig {
  if (!isObj(cfg)) throw new EngineError('invalid_rule', 'rci config must be an object')
  for (const key of ['alpha_two_tailed', 'min_baseline_n', 'chip', 'source']) {
    if (!has(cfg, key)) throw new EngineError('invalid_rule', `rci config lacks '${key}'`)
  }
}

/**
 * Tier B finding for one personal indicator. baseline: numbers / null / observations (same unit as
 * the indicator); current: number, null or an observation; cfg: the `rci` block of personal.json.
 * An indicator that declares a transform ("anscombe" for counts) is tested on that scale and its band mapped
 * back: every top-level number (value, limit, margin, baseline_mean, band) is on the raw scale of the
 * indicator's unit, and the rci block holds the test's statistics on the scale named by rci.transform (null =
 * raw), with rci.current the tested current value.
 * Severity: reliable change in the worse direction -> caution (never warning), but nominal for a
 * non-alerting indicator, which never alerts; reliable change in the other direction -> nominal
 * (shown, no alert; LANDFALL does not call it better); insufficient data -> advisory; within ->
 * nominal. Any reliability_r on the indicator is ignored.
 */
export function evaluatePersonal(
  indicator: Indicator,
  baseline: ReadonlyArray<RuleValue>,
  current: RuleValue,
  cfg: RciConfig,
  t: number | null = null,
): PersonalFinding {
  validateIndicator(indicator)
  validateCfg(cfg)
  const tt = t === undefined ? null : t
  if (tt !== null) requireNumber(tt, 't')
  const unit = indicator.unit
  const what = `indicator ${pyStr(indicator.id)}`
  const tf = pyGet(indicator, 'transform') as Transform | null
  const [cur] = coerceValue(current, unit, indicator.variable, what)
  if (!Array.isArray(baseline)) throw new EngineError('invalid_argument', 'baseline must be a list')
  const base: Array<number | null> = []
  for (const b of baseline as readonly unknown[]) {
    const [bv] = coerceValue(b, unit, indicator.variable, what + ' baseline')
    base.push(bv)
  }
  const alpha = cfg.alpha_two_tailed
  const curT = transformValue(tf, cur, what)
  const baseT = base.map((b) => transformValue(tf, b, what + ' baseline'))
  const res = rci(baseT, curT, alpha, cfg.min_baseline_n)
  const raw = base.filter((b): b is number => b !== null)
  const baselineMean = raw.length ? sumLR(raw) / raw.length : null
  if (baselineMean !== null && !Number.isFinite(baselineMean)) {
    throw new EngineError('invalid_argument', `${what}: baseline mean is not finite (values too large)`)
  }
  const worse = indicator.worse
  const label = pyStr(pyOr(pyGet(indicator, 'label'), indicator.id))

  let band: { low: number; high: number } | null = null
  if (res.mdc !== null && res.mean !== null && res.s_diff !== null && res.critical !== null) {
    // the band on the test scale is mean +/- critical * s_diff; its edges are mapped back to the raw scale
    const high = untransform(tf, res.mean + res.critical * res.s_diff)
    const low = untransform(tf, res.mean - res.critical * res.s_diff)
    if (!(Number.isFinite(high) && Number.isFinite(low))) {
      throw new EngineError('invalid_argument', `${what}: personal band edge is not finite (values too large)`)
    }
    band = { low, high }
  }
  let limit: number | null = null
  let margin: number | null = null
  let status: Status
  let severity: Severity
  let why: string
  if (res.status !== 'ok' || res.mean === null || res.rc === null || res.critical === null || cur === null || band === null) {
    status = 'insufficient_data'
    severity = 'advisory'
    if (res.reason === 'baseline_too_short') {
      why = `${label}: baseline has ${res.n} values; at least ${pyStr(cfg.min_baseline_n)} needed.`
    } else if (res.reason === 'no_current') {
      why = `${label}: no current value.`
    } else {
      why = `${label}: baseline SD is 0, so the single-case test is undefined.`
    }
  } else {
    const { direction, critical: crit } = res
    if (worse === 'increase' || (worse === 'either' && direction !== 'decrease')) {
      limit = band.high
      margin = band.high - cur
    } else {
      limit = band.low
      margin = cur - band.low
    }
    if (!(Number.isFinite(limit) && Number.isFinite(margin))) {
      throw new EngineError('invalid_argument', `${what}: personal band edge is not finite (values too large)`)
    }
    let txt: string
    if (res.reliable) {
      status = 'reliable_change'
      const isWorse = worse === 'either' || direction === worse
      severity = isWorse ? 'caution' : 'nominal'
      txt = isWorse ? 'reliable change in the worse direction' : 'reliable change in the other direction (no alert)'
    } else {
      status = 'within'
      severity = 'nominal'
      txt = 'no reliable change'
    }
    const scale =
      tf === null ? '' : ` tested on the Anscombe scale ${ANSCOMBE_SCALE_TEXT}: ${fmtNum(curT as number)} vs mean ${fmtNum(res.mean)};`
    why =
      `${label}: ${qty(cur, unit)} vs own baseline mean ${qty(baselineMean as number, unit)} ` +
      `(n=${res.n});${scale} t = ${fmtNum(res.rc)}, critical ${fmtNum(crit)} ` +
      `(df ${pyStr(res.df)}, two-tailed alpha ${fmtNum(alpha, 6)}); ${txt}.`
  }
  if (!indicator.alerting) {
    if (status === 'reliable_change') severity = 'nominal' // shown, never alerts: advisory blue would read as an alert
    why += ' Non-alerting indicator: never alerts.'
  }
  const reason: RciReason | null = res.reason
  return {
    rule_id: indicator.id,
    tier: 'B',
    category: 'PERSONAL',
    role: indicator.alerting ? 'alert' : 'context',
    status,
    severity,
    value: cur,
    unit,
    op: null,
    limit,
    approach_at: null,
    margin,
    chip: cfg.chip,
    source: cfg.source,
    why: why + ` Basis: ${basisText(cfg.chip, cfg.source)}.`,
    env_id: null,
    t: tt,
    case_id: pyGet(indicator, 'case_id') as string | null,
    action_id: pyGet(indicator, 'action_id') as string | null,
    direction: res.direction,
    worse,
    private: pyGet(indicator, 'private') === true,
    baseline_mean: baselineMean,
    band,
    rci: {
      method: res.method,
      transform: tf,
      current: curT,
      rc: res.rc,
      df: res.df,
      critical: res.critical,
      alpha: res.alpha,
      s_diff: res.s_diff,
      mean: res.mean,
      sd: res.sd,
      n: res.n,
      reliable: res.reliable,
      reason,
      mdc: res.mdc,
    },
  }
}

/**
 * The smallest one-day change from the baseline mean that the single-case test flags:
 * mdc = critical * s_diff, s_diff = sd * sqrt(1 + 1/n), critical = tCritical(alpha, n - 1), the
 * half-width of the personal band. Use it to state Tier B's sensitivity at the crewmember's own SD
 * (rci().mdc is the same number) or at a literature SD. sd must be > 0, n an integer >= 2, alpha in
 * (0, 1); anything else, or a result that is not finite, raises invalid_argument.
 */
export function minDetectableChange(sd: number, n: number, alpha: number = 0.001): MinDetectableChange {
  requireNumber(sd, 'sd')
  if (!(sd > 0)) throw new EngineError('invalid_argument', `sd must be > 0 (the test is undefined at SD 0), got ${pyStr(sd)}`)
  if (!isInt(n) || n < 2) throw new EngineError('invalid_argument', 'n must be an integer >= 2')
  validateAlpha(alpha)
  const sDiff = sd * Math.sqrt(1.0 + 1.0 / n)
  const crit = critical(alpha, n - 1)
  const mdc = crit * sDiff
  if (!(Number.isFinite(sDiff) && Number.isFinite(mdc))) {
    throw new EngineError('invalid_argument', 'the minimum detectable change is not finite (values too large)')
  }
  return { mdc, critical: crit, s_diff: sDiff, sd, n, df: n - 1, alpha }
}

export const FALSE_ALARM_ASSUMES =
  'one test per indicator per day, with normal day-to-day noise that is independent ' +
  'from one day to the next; autocorrelated or skewed data give more, while correlation ' +
  'between indicators leaves the average unchanged and only bunches chance flags together'

/**
 * Chance flags and chance cautions for k indicators tested once a day for `days` days.
 * Flags (a reliable change in either direction): (k * days) * alpha, i.e. per_day = k * alpha.
 * Cautions: an indicator with one worse direction raises a caution on half of its chance flags (the
 * test is two-tailed); one whose worse is "either" (kEither of the k) on all of them:
 * cautions_per_day = ((k - kEither) * alpha) / 2 + kEither * alpha; with kEither = 0 that is
 * per_day / 2. N = 1 / per_day and M = 1 / cautions_per_day, formatted with fmtNum(dp = 1).
 */
export function expectedFalseAlarms(kIndicators: number, days: number, alpha: number = 0.001, kEither: number = 0): FalseAlarms {
  for (const [name, x] of [
    ['k_indicators', kIndicators],
    ['days', days],
    ['alpha', alpha],
    ['k_either', kEither],
  ] as const) {
    requireNumber(x, name)
    if (x < 0) throw new EngineError('invalid_argument', `${name} must be >= 0`)
  }
  if (alpha > 1) throw new EngineError('invalid_argument', 'alpha must be <= 1')
  if (kEither > kIndicators) throw new EngineError('invalid_argument', 'k_either must be <= k_indicators')
  const perDay = kIndicators * alpha
  const expected = kIndicators * days * alpha
  const every = perDay > 0 ? 1.0 / perDay : null
  const oneSided = kIndicators - kEither
  const cautionsPerDay = (oneSided * alpha) / 2.0 + kEither * alpha
  const expectedCautions = (oneSided * days * alpha) / 2.0 + kEither * days * alpha
  const cautionEvery = cautionsPerDay > 0 ? 1.0 / cautionsPerDay : null
  const text =
    every === null
      ? 'no false flags expected'
      : `one false flag every ${fmtNum(every, 1)} days on average, counting chance changes in either direction`
  let cautionText: string
  if (cautionEvery === null) cautionText = 'no false cautions expected'
  else if (kEither > 0) {
    cautionText =
      `one false caution every ${fmtNum(cautionEvery, 1)} days on average: a chance change in the worse direction ` +
      `raises a caution, and in either direction for the ${fmtNum(kEither)} indicator(s) that alert both ways`
  } else {
    cautionText =
      `one false caution every ${fmtNum(cautionEvery, 1)} days on average: ` +
      'only a chance change in the worse direction raises a caution'
  }
  return {
    expected,
    per_day: perDay,
    every_n_days: every,
    text,
    expected_cautions: expectedCautions,
    cautions_per_day: cautionsPerDay,
    caution_every_n_days: cautionEvery,
    caution_text: cautionText,
    assumes: FALSE_ALARM_ASSUMES,
    k_indicators: kIndicators,
    days,
    alpha,
    k_either: kEither,
  }
}

/** N for "about 1 in N days": two significant figures (2000, 1000, 3800), a whole number below 100. */
function about(n: number): string {
  let m = 1.0
  while (n >= 100.0 * m) m = m * 10.0
  return fmtNum(Math.floor(n / m + 0.5) * m, 0)
}

/**
 * A chance-rate multiplier as printed: up to 3 decimals, trailing zeros dropped (0.45, 0.495, 1). personal.json
 * declares a multiplier to 2 decimals, or to 3 when 2 would round a measured value outside the 0.5-2 band onto its
 * edge (mood: 0.495, not 0.5), so the text shows which side it is on.
 */
function multiplierText(x: number): string {
  return x < MULTIPLIER_TEXT_MAX ? fmtNum(x, MULTIPLIER_DP) : '10^9 or more'
}

function declaredMultiplier(decl: Record<string, unknown>, key: string, iid: string): number {
  const x = pyGet(decl, key)
  if (!isNumber(x) || (x as number) < 0) {
    throw new EngineError('invalid_rule', `indicator ${iid}: chance_rate.${key} must be a finite number >= 0`)
  }
  return x as number
}

/**
 * How often this indicator flags by chance alone, per crewmember and day (SPEC section 5). Nominal (no
 * declaration): a flag (reliable change in either direction) on alpha of days, a caution (worse direction) on
 * alpha / 2, or alpha for worse "either". An indicator that declares `chance_rate` in personal.json
 * ({caution_multiplier, flag_multiplier, text, chip, source}: measured by seeded Monte Carlo under the
 * scenario's noise model) gets those multiples instead, with basis "measured". A non-alerting indicator never
 * raises a caution: its caution rate is 0 and its text names the flag rate.
 */
export function chanceRate(indicator: Indicator, cfg: RciConfig): ChanceRate {
  validateIndicator(indicator)
  validateCfg(cfg)
  const alpha = validateAlpha(cfg.alpha_two_tailed)
  const iid = pyStr(indicator.id)
  const worse = indicator.worse
  const alerting = indicator.alerting
  const nominalCaution = worse === 'either' ? alpha : alpha / 2.0
  const nominalFlag = alpha
  const decl = pyGet(indicator, 'chance_rate')
  let basis: ChanceRate['basis'] = 'nominal'
  let cm = 1.0
  let fm = 1.0
  let note: string | null = null
  let chip = cfg.chip
  let source = cfg.source
  if (decl !== null) {
    if (!isObj(decl)) throw new EngineError('invalid_rule', `indicator ${iid}: chance_rate must be an object`)
    for (const key of ['chip', 'source']) {
      if (!has(decl, key)) throw new EngineError('invalid_rule', `indicator ${iid}: chance_rate lacks '${key}'`)
    }
    cm = declaredMultiplier(decl, 'caution_multiplier', iid)
    fm = declaredMultiplier(decl, 'flag_multiplier', iid)
    const text = pyGet(decl, 'text')
    note = typeof text === 'string' ? text : null
    basis = 'measured'
    chip = decl.chip as RciConfig['chip']
    source = decl.source as RciConfig['source']
  }
  const caution = alerting ? nominalCaution * cm : 0.0
  const flag = nominalFlag * fm
  if (!(Number.isFinite(caution) && Number.isFinite(flag)) || caution > 1.0 || flag > 1.0) {
    throw new EngineError('invalid_rule', `indicator ${iid}: a chance rate above 1 per day is impossible`)
  }
  const cautionEvery = caution > 0 ? 1.0 / caution : null
  const flagEvery = flag > 0 ? 1.0 / flag : null
  const every = alerting ? cautionEvery : flagEvery
  const lead = alerting ? '' : 'never alerts; '
  const what = alerting ? 'would flag like this' : 'would show a reliable change like this'
  let text: string
  if (every === null) text = lead + (alerting ? 'no chance cautions expected' : 'no chance flags expected')
  else if (every >= CHANCE_TEXT_MAX_DAYS) text = `${lead}fewer than 1 in 10^12 days per crewmember ${what} with no real change`
  else text = `${lead}about 1 in ${about(every)} days per crewmember ${what} with no real change`
  return {
    indicator_id: indicator.id,
    worse,
    alerting,
    alpha,
    basis,
    nominal_caution_per_day: nominalCaution,
    nominal_flag_per_day: nominalFlag,
    caution_multiplier: cm,
    flag_multiplier: fm,
    caution_multiplier_text: multiplierText(cm),
    flag_multiplier_text: multiplierText(fm),
    caution_per_day: caution,
    flag_per_day: flag,
    caution_every_n_days: cautionEvery,
    flag_every_n_days: flagEvery,
    text,
    note,
    chip,
    source,
  }
}
