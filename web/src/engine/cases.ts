// Case state machine, port of engine/cases.py (SPEC section 5):
//   idle -> detected -> acting -> watch -> resolved | escalated, plus dismissed.
//
// caseReduce is a pure reducer: it never mutates its inputs and never throws for a bad event. An
// invalid event returns the same status plus a log entry whose `error` is set. A malformed *state*
// (not produced by newCase / caseReduce) is a contract violation and throws invalid_argument.
//
// Tripwire timing: observations are collected throughout watch, but the tripwire is only judged at
// t >= reassess_at, matching the case texts ("Reassess at T+72 h; if ... still ..., reclassify").
// Observations with crew_id null or absent (vehicle / habitat sensors, e.g. the onboard proton
// monitor) describe the shared environment and count for every crewmember's case.

import { EngineError } from './errors'
import { fmtNum, isNumber } from './fmt'
import { clone, has, isInt, isNonemptyStr, isObj, pyEq, pyGet, pyIn, pyOr, pyRepr, pyStr, sortedStrings, truthy } from './py'
import type { JsonObject } from './py'
import { OP_SYMBOL, compare, isOp } from './thresholds'
import type { CaseDef, CaseEvent, CaseLogEntry, CaseSpec, CaseState, CaseStatus, TriggerLookup, TripwireResult } from './types'

export const STATES = ['idle', 'detected', 'acting', 'watch', 'resolved', 'escalated', 'dismissed'] as const
export const OPEN_STATES = ['detected', 'acting', 'watch'] as const
export const TERMINAL_STATES = ['resolved', 'escalated', 'dismissed'] as const
export const EVENTS = ['OPEN', 'SELECT', 'STEP', 'OUTCOME', 'TICK', 'DISMISS'] as const
export const OPENING_SEVERITIES = ['caution', 'warning', 'emergency'] as const

function list(x: unknown, what: string): unknown[] {
  // Python iterates `x or []`; a truthy non-list would crash it (or iterate dict keys / chars)
  const v = pyOr(x, [])
  if (!Array.isArray(v)) throw new EngineError('invalid_case', `${what} must be a list`)
  return v
}

function idOf(x: unknown, what: string): unknown {
  // Python: x["id"] (KeyError if absent, TypeError if x is not a dict). Any present value is kept.
  if (!isObj(x) || !has(x, 'id')) throw new EngineError('invalid_case', `${what} needs an id`)
  return x.id
}

/**
 * Build the pre-OPEN ("idle") state for one case and one crewmember. `lookup` maps a rule or
 * indicator id to {variable, unit} (triggerLookup(rules)); it resolves the tripwire variable when the
 * condition names a rule_id, and the tripwire unit when the condition has none. An explicit
 * condition variable / unit wins. An unresolvable variable or unit raises invalid_case.
 */
export function newCase(caseDef: CaseDef, crewId: string, lookup: TriggerLookup | null = null): CaseState {
  if (!isObj(caseDef) || typeof pyGet(caseDef, 'id') !== 'string') {
    throw new EngineError('invalid_case', 'case definition must be an object with a string id')
  }
  if (typeof crewId !== 'string' || crewId === '') throw new EngineError('invalid_argument', 'crew_id must be a non-empty string')
  const def = caseDef as JsonObject
  const cid = def.id as string
  const triggerIds = new Set<string>()
  for (const trg of list(pyGet(def, 'triggers'), `case ${cid}: triggers`)) {
    if (!isObj(trg)) throw new EngineError('invalid_case', `case ${cid}: trigger must be an object`)
    const tid = pyOr(pyGet(trg, 'rule_id'), pyGet(trg, 'indicator_id'))
    if (typeof tid !== 'string') throw new EngineError('invalid_case', `case ${cid}: trigger without rule_id/indicator_id`)
    triggerIds.add(tid)
  }
  const cm = pyOr(pyGet(def, 'countermeasure'), {})
  if (!isObj(cm)) throw new EngineError('invalid_case', `case ${cid}: countermeasure must be an object`)
  const primary = pyGet(cm, 'primary')
  if (!isObj(primary) || typeof pyGet(primary, 'id') !== 'string') {
    throw new EngineError('invalid_case', `case ${cid}: countermeasure.primary.id required`)
  }
  const cmIds = [primary.id, ...list(pyGet(cm, 'alternatives'), `case ${cid}: alternatives`).map((a) => idOf(a, 'alternative'))]
  const stepIds = list(pyGet(def, 'procedure'), `case ${cid}: procedure`).map((s) => idOf(s, 'procedure step'))
  const tw = pyGet(def, 'tripwire')
  if (!isObj(tw) || !isNumber(pyGet(tw, 'reassess_after_s')) || !isObj(pyGet(tw, 'condition'))) {
    throw new EngineError('invalid_case', `case ${cid}: tripwire.reassess_after_s and condition required`)
  }
  const cond = tw.condition as JsonObject
  const refId = pyOr(pyGet(cond, 'indicator_id'), pyGet(cond, 'rule_id'))
  // Python: `(lookup or {}).get(ref_id) if isinstance(ref_id, str) else None`. The lookup is read
  // only for a string id, and a falsy lookup (null, false, 0, "", [], {}) acts as {}. A truthy
  // non-object lookup crashes Python (AttributeError); here it is a coded contract violation.
  let found: unknown = null
  if (typeof refId === 'string') {
    const lk = pyOr(lookup, {})
    if (!isObj(lk)) throw new EngineError('invalid_argument', 'lookup must be an object or null')
    found = pyGet(lk, refId)
  }
  const ref: JsonObject = isObj(found) ? found : {}
  const variable = pyOr(pyGet(cond, 'variable'), pyGet(ref, 'variable'), pyGet(cond, 'indicator_id'))
  const unit = pyOr(pyGet(cond, 'unit'), pyGet(ref, 'unit'))
  if (typeof variable !== 'string') throw new EngineError('invalid_case', `case ${cid}: cannot resolve the tripwire variable`)
  if (typeof unit !== 'string' || unit === '') {
    // units are never assumed (SPEC section 4): without a unit the TICK unit check would be off
    throw new EngineError(
      'invalid_case',
      `case ${cid}: cannot resolve the tripwire unit (set condition.unit or pass lookup = triggerLookup(rules))`,
    )
  }
  const op = pyGet(cond, 'op')
  const value = pyGet(cond, 'value')
  if (!isOp(op) || !isNumber(value)) throw new EngineError('invalid_case', `case ${cid}: tripwire op/value invalid`)
  const n = pyGet(cond, 'of_last_n')
  const k = pyGet(cond, 'at_least')
  if (!(isInt(n) && isInt(k) && k >= 1 && k <= n)) {
    throw new EngineError('invalid_case', `case ${cid}: need integers 1 <= at_least <= of_last_n`)
  }
  const esc = pyGet(def, 'escalation')
  const spec: CaseSpec = {
    case_id: cid,
    trigger_ids: sortedStrings(triggerIds),
    countermeasure_ids: cmIds as string[],
    step_ids: stepIds as string[],
    tripwire: {
      reassess_after_s: tw.reassess_after_s as number,
      condition: { variable, op, value, unit, of_last_n: n, at_least: k },
    },
    escalation: isObj(esc) ? clone(esc) : null,
  }
  return {
    schema: 'landfall.case_state/1',
    case_id: cid,
    crew_id: crewId,
    status: 'idle',
    spec,
    opened_at: null,
    finding: null,
    countermeasure_id: null,
    steps_done: [],
    outcome: null,
    watch_started_at: null,
    reassess_at: null,
    tripwire_obs: [],
    tripwire_result: null,
    closed_at: null,
    dismiss_reason: null,
    updated_at: null,
    log: [],
  }
}

function tripwireEval(s: CaseState): TripwireResult {
  const cond = s.spec.tripwire.condition
  const last = s.tripwire_obs.slice(-cond.of_last_n)
  let hits = 0
  for (const o of last) if (compare(o.value, cond.op, cond.value)) hits += 1
  return {
    hits,
    considered: last.length,
    of_last_n: cond.of_last_n,
    at_least: cond.at_least,
    tripped: hits >= cond.at_least,
  }
}

function malformed(why: string): EngineError {
  return new EngineError('invalid_argument', `state must be a case state built by new_case / case_reduce (${why})`)
}

function validateState(state: unknown): asserts state is CaseState {
  // the same top-level check as Python's _validate_state
  if (
    !(
      isObj(state) &&
      (STATES as readonly unknown[]).includes(pyGet(state, 'status')) &&
      isObj(pyGet(state, 'spec')) &&
      Array.isArray(pyGet(state, 'log')) &&
      typeof pyGet(state, 'crew_id') === 'string' &&
      Array.isArray(pyGet(state, 'tripwire_obs')) &&
      Array.isArray(pyGet(state, 'steps_done'))
    )
  ) {
    throw malformed('top-level fields')
  }
  // TS only: the fields the reducer reads further down. Python has no such check and fails later
  // with KeyError / TypeError on these states; here they are the same contract violation.
  const spec = state.spec as unknown as JsonObject
  const tw = pyGet(spec, 'tripwire')
  const cond = isObj(tw) ? pyGet(tw, 'condition') : null
  const tripwireObs = state.tripwire_obs as unknown[]
  const stepsDone = state.steps_done as unknown[]
  const ok =
    Array.isArray(pyGet(spec, 'trigger_ids')) &&
    Array.isArray(pyGet(spec, 'countermeasure_ids')) &&
    Array.isArray(pyGet(spec, 'step_ids')) &&
    isObj(tw) &&
    isNumber(pyGet(tw, 'reassess_after_s')) &&
    isObj(cond) &&
    typeof pyGet(cond, 'variable') === 'string' &&
    isOp(pyGet(cond, 'op')) &&
    isNumber(pyGet(cond, 'value')) &&
    isInt(pyGet(cond, 'of_last_n')) &&
    isInt(pyGet(cond, 'at_least')) &&
    (pyGet(state, 'updated_at') === null || isNumber(pyGet(state, 'updated_at'))) &&
    (state.status !== 'watch' || (isNumber(pyGet(state, 'watch_started_at')) && isNumber(pyGet(state, 'reassess_at')))) &&
    tripwireObs.every((o) => isObj(o) && isNumber(pyGet(o, 't')) && isNumber(pyGet(o, 'value'))) &&
    stepsDone.every((d) => isObj(d))
  if (!ok) throw malformed('spec / watch fields')
}

/** Apply one event {type, t, ...} to a case state; returns the new state (inputs are not mutated). */
export function caseReduce(state: CaseState, event: CaseEvent): CaseState {
  validateState(state)
  const s = clone(state)
  const ev: JsonObject = isObj(event) ? event : {}
  const etype = pyGet(ev, 'type')
  const t = pyGet(ev, 't')
  const frm: CaseStatus = s.status

  const log = (to: CaseStatus, detail: string, error: string | null): CaseState => {
    const entry: CaseLogEntry = {
      t: t as number | null,
      event: etype as CaseLogEntry['event'],
      from: frm,
      to,
      detail,
      error,
    }
    s.log.push(entry)
    return s
  }
  const reject = (error: string, detail: string): CaseState => log(frm, detail, error)
  const accept = (to: CaseStatus, detail: string): CaseState => {
    s.status = to
    s.updated_at = t as number
    return log(to, detail, null)
  }

  if (!(EVENTS as readonly unknown[]).includes(etype)) return reject('invalid_event', `unknown event type ${pyRepr(etype)}`)
  if (!isNumber(t)) return reject('invalid_event', 'event t must be a finite number')
  if (etype === 'TICK' && frm !== 'watch') return s // clock ticks outside watch change nothing: no log entry
  if (s.updated_at !== null && t < s.updated_at) {
    return reject('time_reversed', `t ${fmtNum(t)} is before the last transition at ${fmtNum(s.updated_at)}`)
  }
  const caseId = pyStr(pyGet(s as unknown as JsonObject, 'case_id'))
  const nSteps = s.spec.step_ids.length

  if (etype === 'OPEN') {
    if (frm !== 'idle') return reject('invalid_transition', `OPEN is only valid from idle, case is ${frm}`)
    const f = pyGet(ev, 'finding')
    if (!isObj(f)) return reject('invalid_event', 'OPEN needs a finding object')
    const sev = pyGet(f, 'severity')
    if (!(OPENING_SEVERITIES as readonly unknown[]).includes(sev)) {
      return reject('below_threshold', `finding severity ${pyRepr(sev)} is below caution`)
    }
    const ruleId = pyGet(f, 'rule_id')
    if (truthy(s.spec.trigger_ids) && !pyIn(ruleId, s.spec.trigger_ids)) {
      return reject('not_a_trigger', `${pyRepr(ruleId)} is not a trigger of ${caseId}`)
    }
    s.opened_at = t
    s.finding = clone(f) as unknown as CaseState['finding']
    return accept('detected', `opened by ${pyStr(ruleId)} (${pyStr(pyGet(f, 'status'))}, ${pyStr(sev)})`)
  }

  if (etype === 'DISMISS') {
    if (!(OPEN_STATES as readonly string[]).includes(frm)) {
      return reject('invalid_transition', `DISMISS is only valid from an open case, case is ${frm}`)
    }
    const reason = pyGet(ev, 'reason')
    if (!isNonemptyStr(reason)) return reject('invalid_event', 'DISMISS needs a non-empty reason')
    s.dismiss_reason = reason
    s.closed_at = t
    return accept('dismissed', `dismissed: ${reason}`)
  }

  if (etype === 'SELECT') {
    if (frm !== 'detected') return reject('invalid_transition', `SELECT is only valid from detected, case is ${frm}`)
    const cmId = pyGet(ev, 'countermeasure_id')
    if (!pyIn(cmId, s.spec.countermeasure_ids)) {
      return reject('unknown_countermeasure', `${pyRepr(cmId)} is not a countermeasure of ${caseId}`)
    }
    s.countermeasure_id = cmId as string
    const primary = pyEq(cmId, s.spec.countermeasure_ids[0])
    return accept('acting', `selected ${pyStr(cmId)} (${primary ? 'primary' : 'alternative'})`)
  }

  if (etype === 'STEP') {
    if (frm !== 'acting') return reject('invalid_transition', `STEP is only valid from acting, case is ${frm}`)
    const stepId = pyGet(ev, 'step_id')
    if (!pyIn(stepId, s.spec.step_ids)) return reject('unknown_step', `${pyRepr(stepId)} is not a step of ${caseId}`)
    if (s.steps_done.some((d) => pyEq(pyGet(d as unknown as JsonObject, 'step_id'), stepId))) {
      return reject('duplicate_step', `step ${pyStr(stepId)} already done`)
    }
    s.steps_done.push({ step_id: stepId as string, t, input: clone(pyGet(ev, 'input')) })
    return accept('acting', `step ${pyStr(stepId)} done (${s.steps_done.length} of ${nSteps})`)
  }

  if (etype === 'OUTCOME') {
    if (frm !== 'acting') return reject('invalid_transition', `OUTCOME is only valid from acting, case is ${frm}`)
    const text = pyGet(ev, 'text')
    if (!isNonemptyStr(text)) return reject('invalid_event', 'OUTCOME needs a non-empty text')
    s.outcome = { text, t }
    s.watch_started_at = t
    s.reassess_at = t + s.spec.tripwire.reassess_after_s
    return accept(
      'watch',
      `outcome recorded; reassess at ${fmtNum(s.reassess_at)} (${s.steps_done.length} of ${nSteps} steps done)`,
    )
  }

  // TICK in watch
  const cond = s.spec.tripwire.condition
  const watchStart = s.watch_started_at as number
  const reassessAt = s.reassess_at as number
  const obsList = pyOr(pyGet(ev, 'observations'), [])
  if (!Array.isArray(obsList)) return reject('invalid_event', 'TICK observations must be a list')
  const knownT = new Set<number>(s.tripwire_obs.map((o) => o.t))
  let added = 0
  for (const o of obsList as unknown[]) {
    if (!isObj(o) || !pyEq(pyGet(o, 'variable'), cond.variable)) continue
    const oc = pyGet(o, 'crew_id')
    if (oc !== null && !pyEq(oc, s.crew_id)) continue // another crewmember; crew_id null = vehicle sensor
    const ot = pyGet(o, 't')
    const ov = pyGet(o, 'value')
    if (!(isNumber(ot) && isNumber(ov))) continue
    if (!(watchStart < ot && ot <= t)) continue
    const ou = pyGet(o, 'unit')
    if (cond.unit !== null && !pyEq(ou, cond.unit)) {
      return reject('unit_mismatch', `tripwire expects ${pyRepr(cond.unit)}, observation has ${pyRepr(ou)}`)
    }
    if (knownT.has(ot)) continue
    knownT.add(ot)
    s.tripwire_obs.push({ t: ot, value: ov })
    added += 1
  }
  s.tripwire_obs.sort((a, b) => a.t - b.t)
  const res = tripwireEval(s)
  const desc =
    `${res.hits} of last ${res.considered} ${cond.variable} ${OP_SYMBOL[cond.op]} ${fmtNum(cond.value)} ` +
    `(escalate at ${pyStr(cond.at_least)} of ${pyStr(cond.of_last_n)})`
  if (t >= reassessAt) {
    if (res.tripped) {
      s.tripwire_result = res
      s.closed_at = t
      return accept('escalated', `reassessed: tripwire ${desc}; queued for flight-surgeon review`)
    }
    const remaining = cond.of_last_n - res.considered
    if (res.hits + remaining < cond.at_least) {
      s.tripwire_result = res
      s.closed_at = t
      return accept('resolved', `reassessed: ${desc}`)
    }
    if (added) return accept('watch', `reassessment due, need more observations: ${desc}`)
    return s
  }
  if (added) return accept('watch', `${added} new observation(s): ${desc}; judged at reassessment (${fmtNum(reassessAt)})`)
  return s
}
