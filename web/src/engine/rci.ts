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
//
// Under normal, independent day-to-day noise the chance of a reliable change is exactly alpha per
// indicator-day (alpha / 2 in a given direction); autocorrelated or skewed data raise it
// (personal.json rci.caveat). No test-retest reliability is involved: the earlier arithmetic,
// S_diff = sd * sqrt(2) * sqrt(1 - r) on the crewmember's own baseline SD, shrank the denominator
// and flagged far more often than the alpha it printed (engine/rci.py explains the audit).
//
// Crawford JR, Howell DC. Comparing an individual's test score against norms derived from small
// samples. Clin Neuropsychol 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241

import { EngineError } from './errors'
import { fmtNum, requireNumber, sumLR } from './fmt'
import { has, isInt, isObj, pyGet, pyOr, pyStr } from './py'
import { tCritical } from './tdist'
import { basisText, coerceValue } from './thresholds'
import type {
  Direction,
  FalseAlarms,
  Indicator,
  PersonalFinding,
  RciConfig,
  RciReason,
  RciResult,
  RuleValue,
  Severity,
  Status,
} from './types'

export const WORSE_VALUES = ['increase', 'decrease', 'either'] as const
export const RCI_METHOD = 'crawford_howell_1998' as const

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
 * n >= 2; critical needs n >= minBaselineN; rc needs status "ok". zero_sd is an exact constancy
 * test, so float noise cannot fake a reliable change. A baseline mean or SD, or a statistic, that
 * is not finite raises invalid_argument: the engine never returns NaN or infinity.
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
 * Severity: reliable change in the worse direction -> caution (never warning), but nominal for a
 * non-alerting indicator, which never alerts; reliable change in the better direction -> nominal;
 * insufficient data -> advisory; within -> nominal. Any reliability_r on the indicator is ignored.
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
  const [cur] = coerceValue(current, unit, indicator.variable, what)
  if (!Array.isArray(baseline)) throw new EngineError('invalid_argument', 'baseline must be a list')
  const base: Array<number | null> = []
  for (const b of baseline as readonly unknown[]) {
    const [bv] = coerceValue(b, unit, indicator.variable, what + ' baseline')
    base.push(bv)
  }
  const alpha = cfg.alpha_two_tailed
  const res = rci(base, cur, alpha, cfg.min_baseline_n)
  const worse = indicator.worse
  const label = pyStr(pyOr(pyGet(indicator, 'label'), indicator.id))
  const unitS = pyStr(unit)

  let limit: number | null = null
  let margin: number | null = null
  let status: Status
  let severity: Severity
  let why: string
  if (res.status !== 'ok' || res.mean === null || res.s_diff === null || res.rc === null || res.critical === null || cur === null) {
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
    const { mean, s_diff: sDiff, direction, critical: crit } = res
    const high = mean + crit * sDiff
    const low = mean - crit * sDiff
    if (worse === 'increase' || (worse === 'either' && direction !== 'decrease')) {
      limit = high
      margin = high - cur
    } else {
      limit = low
      margin = cur - low
    }
    if (!(Number.isFinite(limit) && Number.isFinite(margin))) {
      throw new EngineError('invalid_argument', `${what}: personal band edge is not finite (values too large)`)
    }
    let txt: string
    if (res.reliable) {
      status = 'reliable_change'
      const isWorse = worse === 'either' || direction === worse
      severity = isWorse ? 'caution' : 'nominal'
      txt = isWorse ? 'reliable change in the worse direction' : 'reliable change in the better direction'
    } else {
      status = 'within'
      severity = 'nominal'
      txt = 'no reliable change'
    }
    why =
      `${label}: ${fmtNum(cur)} ${unitS} vs own baseline mean ${fmtNum(mean)} ${unitS} ` +
      `(n=${res.n}); t = ${fmtNum(res.rc)}, critical ${fmtNum(crit)} ` +
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
    rci: {
      method: res.method,
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
    },
  }
}

export const FALSE_ALARM_ASSUMES =
  'one test per indicator per day, with normal day-to-day noise that is independent ' +
  'from one day to the next; autocorrelated or skewed data give more, while correlation ' +
  'between indicators leaves the average unchanged and only bunches chance flags together'

/**
 * Chance flags and chance cautions for k indicators tested once a day for `days` days.
 * Flags (a reliable change in either direction): (k * days) * alpha, i.e. per_day = k * alpha.
 * Cautions (only a change in the worse direction raises one): half of that, because the test is
 * two-tailed and each indicator has one worse direction. N = 1 / per_day and
 * M = 1 / (per_day / 2), formatted with fmtNum(dp = 1).
 */
export function expectedFalseAlarms(kIndicators: number, days: number, alpha: number = 0.001): FalseAlarms {
  for (const [name, x] of [
    ['k_indicators', kIndicators],
    ['days', days],
    ['alpha', alpha],
  ] as const) {
    requireNumber(x, name)
    if (x < 0) throw new EngineError('invalid_argument', `${name} must be >= 0`)
  }
  if (alpha > 1) throw new EngineError('invalid_argument', 'alpha must be <= 1')
  const perDay = kIndicators * alpha
  const expected = kIndicators * days * alpha
  const every = perDay > 0 ? 1.0 / perDay : null
  const cautionsPerDay = perDay / 2.0
  const expectedCautions = expected / 2.0
  const cautionEvery = cautionsPerDay > 0 ? 1.0 / cautionsPerDay : null
  const text =
    every === null
      ? 'no false flags expected'
      : `one false flag every ${fmtNum(every, 1)} days on average, counting chance changes in either direction`
  const cautionText =
    cautionEvery === null
      ? 'no false cautions expected'
      : `one false caution every ${fmtNum(cautionEvery, 1)} days on average: ` +
        'only a chance change in the worse direction raises a caution'
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
  }
}
