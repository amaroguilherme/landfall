// Tier A (NASA- or NOAA-published limits) and context rules, port of engine/thresholds.py
// (SPEC sections 2, 3.2 and 5). evaluateRule never invents a limit: it only compares a value with
// the `limit` the rule carries, and the rule carries its own chip and source.

import { EngineError } from './errors'
import { fmtNum, isNumber, requireNumber } from './fmt'
import { has, isInt, isObj, pyGet, pyIn, pyOr, pyStr, sortedStrings, truthy } from './py'
import type { JsonObject } from './py'
import type { Finding, Op, Rule, RuleContext, RuleValue, Severity, Status } from './types'

export const SEVERITIES = ['nominal', 'advisory', 'caution', 'warning', 'emergency'] as const // emergency: never emitted
export const STATUSES = [
  'within',
  'approaching',
  'outside',
  'reliable_change',
  'insufficient_data',
  'stale',
  'not_applicable',
] as const
export const CEILING_OPS = ['lt', 'le'] as const
export const FLOOR_OPS = ['gt', 'ge'] as const
export const OP_SYMBOL: Readonly<Record<Op, string>> = { lt: '<', le: '<=', gt: '>', ge: '>=' }

/** NOAA S-scale, >=10 MeV integral proton flux in pfu (snapshot swpc_s_scale). Level = highest met. */
export const NOAA_S_THRESHOLDS_PFU = [10, 100, 1000, 10000, 100000] as const

export function isOp(x: unknown): x is Op {
  return x === 'lt' || x === 'le' || x === 'gt' || x === 'ge'
}

export function isSeverity(x: unknown): x is Severity {
  return typeof x === 'string' && (SEVERITIES as readonly string[]).includes(x)
}

export function isCeiling(op: Op): boolean {
  return op === 'lt' || op === 'le'
}

export function severityRank(severity: Severity): number {
  const i = SEVERITIES.indexOf(severity)
  if (i < 0) throw new EngineError('invalid_rule', `unknown severity ${pyStr(severity)}`)
  return i
}

export function capSeverity(severity: Severity, cap: Severity): Severity {
  return severityRank(severity) <= severityRank(cap) ? severity : cap
}

/** True when `value op limit` holds (the compliant condition for a rule). */
export function compare(value: number, op: Op, limit: number): boolean {
  switch (op) {
    case 'lt':
      return value < limit
    case 'le':
      return value <= limit
    case 'gt':
      return value > limit
    case 'ge':
      return value >= limit
    default:
      throw new EngineError('invalid_rule', `op must be one of lt, le, gt, ge; got ${pyStr(op)}`)
  }
}

/** NOAA solar radiation storm level 0..5 from >=10 MeV proton flux (pfu); below 10 pfu -> 0. */
export function sLevel(fluxPfu: number): number {
  requireNumber(fluxPfu, 'flux_pfu')
  let level = 0
  NOAA_S_THRESHOLDS_PFU.forEach((threshold, i) => {
    if (fluxPfu >= threshold) level = i + 1
  })
  return level
}

/**
 * Accept a number, null (missing) or an observation {value, unit, t?, variable?}. Returns
 * [number | null, observation t | null]. A different or missing unit raises unit_mismatch (units
 * are never converted, SPEC section 4); a present, different variable raises variable_mismatch.
 */
export function coerceValue(value: unknown, unit: unknown, variable: unknown, what: string): [number | null, number | null] {
  if (value === null || value === undefined) return [null, null]
  if (isObj(value)) {
    const u = pyGet(value, 'unit')
    if (!pyEqUnit(u, unit)) {
      throw new EngineError('unit_mismatch', `${what}: observation unit ${pyStr(u)} != expected unit ${pyStr(unit)}`)
    }
    if (variable !== null && variable !== undefined && has(value, 'variable') && !pyEqUnit(value.variable, variable)) {
      throw new EngineError('variable_mismatch', `${what}: observation variable ${pyStr(value.variable)} != ${pyStr(variable)}`)
    }
    const obsT = pyGet(value, 't')
    if (obsT !== null) requireNumber(obsT, `${what}: observation t`)
    const v = pyGet(value, 'value')
    if (v === null) return [null, obsT as number | null]
    requireNumber(v, `${what}: observation value`)
    return [v as number, obsT as number | null]
  }
  return [requireNumber(value, what), null]
}

// Python `!=` on the unit / variable fields (strings in practice; structural for anything else).
function pyEqUnit(a: unknown, b: unknown): boolean {
  return pyIn(a, [b])
}

function validateRule(rule: unknown): asserts rule is Rule & JsonObject {
  if (!isObj(rule)) throw new EngineError('invalid_rule', 'rule must be an object')
  for (const key of ['id', 'variable', 'unit', 'op', 'category', 'tier', 'role', 'applies_to', 'chip', 'source']) {
    if (!has(rule, key)) throw new EngineError('invalid_rule', `rule ${pyStr(pyGet(rule, 'id'))} lacks '${key}'`)
  }
  const id = pyStr(rule.id)
  if (!isOp(rule.op)) throw new EngineError('invalid_rule', `rule ${id}: op must be lt, le, gt or ge`)
  if (!isNumber(pyGet(rule, 'limit'))) throw new EngineError('invalid_rule', `rule ${id}: limit must be a finite number`)
  if (rule.role !== 'alert' && rule.role !== 'context') {
    throw new EngineError('invalid_rule', `rule ${id}: role must be 'alert' or 'context'`)
  }
  const applies = rule.applies_to
  if (!Array.isArray(applies) || !applies.every((e) => typeof e === 'string')) {
    throw new EngineError('invalid_rule', `rule ${id}: applies_to must be a list of strings`)
  }
  const approach = pyGet(rule, 'approach_at')
  if (approach !== null && !(isObj(approach) && isNumber(pyGet(approach, 'value')))) {
    throw new EngineError('invalid_rule', `rule ${id}: approach_at.value must be a number`)
  }
  const stale = pyGet(rule, 'stale_after')
  if (stale !== null && !(isObj(stale) && isNumber(pyGet(stale, 'seconds')))) {
    throw new EngineError('invalid_rule', `rule ${id}: stale_after.seconds must be a number`)
  }
  const maxSev = pyGet(rule, 'max_severity')
  if (maxSev !== null && !isSeverity(maxSev)) {
    throw new EngineError('invalid_rule', `rule ${id}: max_severity must be a severity`)
  }
}

/** "NASA-published [V1 4030]" etc. Only a requirement ID that is in the source is printed. */
export function basisText(chip: unknown, source: unknown): string {
  const rid = isObj(source) ? pyGet(source, 'requirement_id') : null
  return truthy(rid) ? `${pyStr(chip)} [${pyStr(rid)}]` : pyStr(chip)
}

/** S level of an OPS rule: its explicit integer `s_level`, else sLevel(limit) for a ceiling. */
function opsLevel(rule: Rule): number {
  const lv = pyGet(rule, 's_level')
  if (isInt(lv)) return lv
  return isCeiling(rule.op) ? sLevel(rule.limit) : 0
}

/** SPEC section 2 default mapping (design choice, mirrored in rules/meta.json). */
function severityTierA(rule: Rule, status: Status, ctx: JsonObject): Severity {
  if (status === 'insufficient_data' || status === 'stale') return 'advisory'
  if (status === 'within' || status === 'not_applicable') return 'nominal'
  let sev: Severity
  if (rule.category === 'OPS') {
    if (status === 'approaching') {
      sev = 'advisory' // SPEC is silent on approaching an OPS level: we never exceed advisory
    } else {
      sev = opsLevel(rule) >= 3 ? (pyGet(ctx, 'eva') === true ? 'warning' : 'caution') : 'advisory'
    }
  } else if (rule.category === 'TARGET') {
    // literature targets are not NASA limits (meta.json rows target_outside / target_approaching)
    sev = status === 'outside' ? 'caution' : 'advisory'
  } else {
    sev = status === 'outside' ? 'warning' : 'caution'
  }
  if (rule.role === 'context') sev = capSeverity(sev, 'advisory')
  const maxSev = pyGet(rule, 'max_severity')
  if (maxSev !== null) sev = capSeverity(sev, maxSev as Severity)
  return sev
}

/**
 * Evaluate one Tier A / context / OPS rule (SPEC section 5).
 * value: number, null (no data) or an observation {value, unit, t?, variable?}.
 * envId: current environment id. t: evaluation MET seconds or null.
 * ctx: optional {eva: true} when an EVA is planned or in progress (OPS severity).
 */
export function evaluateRule(
  rule: Rule,
  value: RuleValue,
  envId: string,
  t: number | null,
  ctx: RuleContext | null = null,
): Finding {
  validateRule(rule)
  if (typeof envId !== 'string') throw new EngineError('invalid_argument', `env_id must be a string, got ${pyStr(envId)}`)
  const tt = t === undefined ? null : t
  if (tt !== null) requireNumber(tt, 't')
  const c = ctx === undefined ? null : ctx
  if (c !== null && !isObj(c)) throw new EngineError('invalid_argument', 'ctx must be an object or null')
  const context: JsonObject = c ?? {}
  const unit = rule.unit
  const [v, obsT] = coerceValue(value, unit, rule.variable, `rule ${pyStr(rule.id)}`)
  const op = rule.op
  const limit = rule.limit
  const ceiling = isCeiling(op)
  const label = pyStr(pyOr(pyGet(rule, 'label'), rule.id))
  const unitS = pyStr(unit)
  const basis = basisText(rule.chip, rule.source)
  const approach = pyGet(rule, 'approach_at') as { value: number } | null
  const applies = rule.applies_to

  let status: Status
  let margin: number | null = null
  let why: string
  if (!applies.includes('*') && !applies.includes(envId)) {
    status = 'not_applicable'
    why = `${label}: not applicable in ${envId} (applies to ${sortedStrings(applies).join(', ')}). Basis: ${basis}.`
  } else if (v === null) {
    status = 'insufficient_data'
    why = `${label}: no value. Basis: ${basis}.`
  } else {
    const stale = pyGet(rule, 'stale_after') as { seconds: number } | null
    const age = stale !== null && obsT !== null && tt !== null ? tt - obsT : null
    if (stale !== null && age !== null && age > stale.seconds) {
      status = 'stale' // nothing is compared, so margin stays null (SPEC section 5)
      why =
        `${label}: last value ${fmtNum(v)} ${unitS} is ${fmtNum(age)} s old ` +
        `(stale after ${fmtNum(stale.seconds)} s). Basis: ${basis}.`
    } else {
      margin = ceiling ? limit - v : v - limit
      const compliant = compare(v, op, limit)
      let approaching = false
      if (approach !== null) {
        const a = approach.value
        approaching = ceiling ? v >= a : v <= a
      }
      let stateTxt: string
      if (!compliant) {
        status = 'outside'
        stateTxt = 'outside'
      } else if (approaching) {
        status = 'approaching'
        stateTxt = `approaching (watch level ${fmtNum((approach as { value: number }).value)} ${unitS})`
      } else {
        status = 'within'
        stateTxt = 'within'
      }
      why =
        `${label}: ${fmtNum(v)} ${unitS}; compliant when ${OP_SYMBOL[op]} ${fmtNum(limit)} ${unitS}; ` +
        `${stateTxt}. Basis: ${basis}.`
    }
  }

  return {
    rule_id: rule.id,
    tier: rule.tier,
    category: rule.category,
    role: rule.role,
    status,
    severity: severityTierA(rule, status, context),
    value: v,
    unit,
    op,
    limit,
    approach_at: approach !== null ? approach.value : null,
    margin,
    chip: rule.chip,
    source: rule.source,
    why,
    env_id: envId,
    t: tt,
    case_id: pyGet(rule, 'case_id') as string | null,
    action_id: pyGet(rule, 'action_id') as string | null,
  }
}
