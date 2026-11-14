// Tier B: Reliable Change Index against the crewmember's own baseline, port of engine/rci.py
// (SPEC sections 1.3, 3.3, 5).
//
// Jacobson NS, Truax P. Clinical significance: a statistical approach to defining meaningful change
// in psychotherapy research. J Consult Clin Psychol 1991;59(1):12-19.
//
//   sem = sd * sqrt(1 - r)   (sd: sample SD, n - 1, of the baseline)
//   s_diff = sqrt(2) * sem;  rc = (current - mean) / s_diff;  reliable when |rc| >= critical_z
//
// Adaptation (design choice, stated in the Python module and in personal.json's caveat): LANDFALL
// uses the mean and SD of the crewmember's own baseline window, not a reference population.

import { EngineError } from './errors'
import { fmtNum, isNumber, requireNumber, sumLR } from './fmt'
import { has, isInt, isObj, pyGet, pyOr, pyStr } from './py'
import { basisText, capSeverity, coerceValue } from './thresholds'
import type {
  Chip,
  Direction,
  FalseAlarms,
  Indicator,
  PersonalFinding,
  RciConfig,
  RciReason,
  RciResult,
  RuleValue,
  Severity,
  Source,
  Status,
} from './types'

export const WORSE_VALUES = ['increase', 'decrease', 'either'] as const

function validateR(r: unknown): number {
  requireNumber(r, 'reliability r')
  const x = r as number
  if (!(x >= 0 && x < 1)) throw new EngineError('invalid_argument', `reliability r must be in [0, 1), got ${pyStr(r)}`)
  return x
}

/**
 * Reliable Change Index of `current` against `baseline` (numbers; null entries are skipped).
 * status "ok" or "insufficient_data" (reason baseline_too_short, no_current or zero_sd, checked in
 * that order). zero_sd is an exact constancy test, so float noise cannot fake a reliable change.
 */
export function rci(
  baseline: ReadonlyArray<number | null>,
  current: number | null,
  r: number,
  criticalZ: number = 3.29,
  minBaselineN: number = 7,
): RciResult {
  if (!Array.isArray(baseline)) throw new EngineError('invalid_argument', 'baseline must be a list')
  validateR(r)
  requireNumber(criticalZ, 'critical_z')
  if (criticalZ <= 0) throw new EngineError('invalid_argument', 'critical_z must be > 0')
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
      sd = 0
    } else {
      let ss = 0
      for (const x of xs) {
        const d = x - mean
        ss = ss + d * d
      }
      sd = Math.sqrt(ss / (n - 1))
    }
  }
  let direction: Direction | null = null
  if (mean !== null && cur !== null) direction = cur > mean ? 'increase' : cur < mean ? 'decrease' : 'none'
  const out: RciResult = {
    status: 'insufficient_data',
    reason: null,
    n,
    mean,
    sd,
    sem: null,
    s_diff: null,
    rc: null,
    reliable: false,
    direction,
    critical_z: criticalZ,
    r,
  }
  if (n < minBaselineN) return { ...out, reason: 'baseline_too_short' }
  if (cur === null) return { ...out, reason: 'no_current' }
  if (sd === 0 || sd === null || mean === null) return { ...out, reason: 'zero_sd' }
  const sem = sd * Math.sqrt(1.0 - r)
  const sDiff = Math.sqrt(2.0) * sem
  const rc = (cur - mean) / sDiff
  return { ...out, status: 'ok', sem, s_diff: sDiff, rc, reliable: Math.abs(rc) >= criticalZ }
}

function validateIndicator(ind: unknown): asserts ind is Indicator {
  if (!isObj(ind)) throw new EngineError('invalid_rule', 'indicator must be an object')
  for (const key of ['id', 'variable', 'unit', 'worse', 'alerting', 'reliability_r']) {
    if (!has(ind, key)) throw new EngineError('invalid_rule', `indicator ${pyStr(pyGet(ind, 'id'))} lacks '${key}'`)
  }
  const id = pyStr(ind.id)
  if (!(WORSE_VALUES as readonly unknown[]).includes(ind.worse)) {
    throw new EngineError('invalid_rule', `indicator ${id}: worse must be one of increase, decrease, either`)
  }
  if (typeof ind.alerting !== 'boolean') throw new EngineError('invalid_rule', `indicator ${id}: alerting must be true or false`)
  const rr = ind.reliability_r
  if (!(isObj(rr) && isNumber(pyGet(rr, 'value')))) {
    throw new EngineError('invalid_rule', `indicator ${id}: reliability_r.value must be a number`)
  }
}

function validateCfg(cfg: unknown): asserts cfg is RciConfig {
  if (!isObj(cfg)) throw new EngineError('invalid_rule', 'rci config must be an object')
  for (const key of ['critical_z', 'min_baseline_n', 'chip', 'source']) {
    if (!has(cfg, key)) throw new EngineError('invalid_rule', `rci config lacks '${key}'`)
  }
}

/**
 * Tier B finding for one personal indicator. baseline: numbers / null / observations (same unit as
 * the indicator); current: number, null or an observation; cfg: the `rci` block of personal.json.
 * Reliable change in the worse direction -> caution (never warning); insufficient data -> advisory;
 * anything else -> nominal; non-alerting indicators are capped at advisory.
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
  const rr = indicator.reliability_r
  const res = rci(base, cur, rr.value, cfg.critical_z, cfg.min_baseline_n)
  const worse = indicator.worse
  const label = pyStr(pyOr(pyGet(indicator, 'label'), indicator.id))
  const unitS = pyStr(unit)
  const z = cfg.critical_z

  let limit: number | null = null
  let margin: number | null = null
  let status: Status
  let severity: Severity
  let why: string
  if (res.status !== 'ok' || res.mean === null || res.s_diff === null || res.rc === null || cur === null) {
    status = 'insufficient_data'
    severity = 'advisory'
    if (res.reason === 'baseline_too_short') {
      why = `${label}: baseline has ${res.n} values; at least ${pyStr(cfg.min_baseline_n)} needed.`
    } else if (res.reason === 'no_current') {
      why = `${label}: no current value.`
    } else {
      why = `${label}: baseline SD is 0, so reliable change is undefined.`
    }
  } else {
    const { mean, s_diff: sDiff, direction } = res
    const high = mean + z * sDiff
    const low = mean - z * sDiff
    if (worse === 'increase' || (worse === 'either' && direction !== 'decrease')) {
      limit = high
      margin = high - cur
    } else {
      limit = low
      margin = cur - low
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
      `(n=${res.n}); RC ${fmtNum(res.rc)}, critical ${fmtNum(z)}; ${txt}.`
  }
  if (!indicator.alerting) {
    severity = capSeverity(severity, 'advisory')
    why += ' Non-alerting indicator.'
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
      rc: res.rc,
      s_diff: res.s_diff,
      sem: res.sem,
      mean: res.mean,
      sd: res.sd,
      n: res.n,
      reliable: res.reliable,
      reason,
      critical_z: z,
      r: rr.value,
      r_chip: pyGet(rr, 'chip') as Chip | null,
      r_source: pyGet(rr, 'source') as Source | null,
    },
  }
}

/**
 * Expected false alarms = (k * days) * alpha, plus "one false alarm every N days" (N from
 * fmtNum(1 / (k * alpha), 1)). Assumes one test per indicator per day and independent tests.
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
  const text = every === null ? 'no false alarms expected' : `one false alarm every ${fmtNum(every, 1)} days`
  return { expected, per_day: perDay, every_n_days: every, k_indicators: kIndicators, days, alpha, text }
}
