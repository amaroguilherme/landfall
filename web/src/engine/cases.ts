// Case state machine, port of engine/cases.py (SPEC section 5):
//   idle -> detected -> acting -> watch -> resolved | escalated, plus dismissed.
//
// caseReduce is a pure reducer: it never mutates its inputs and never throws for a bad event. An
// invalid event is atomic: it returns the input state unchanged plus exactly one log entry whose
// `error` is set (a TICK rejected for a unit mismatch keeps none of the observations listed before
// the bad one). A malformed *state* (not produced by newCase / caseReduce) is a contract violation
// and throws invalid_argument.
//
// Required steps: a step marked "required" must be done or declined with a reason (DECLINE) before
// OUTCOME is accepted (else required_steps_pending); a required step with an input needs its value. A
// "red_flag" step is a required yes/no question whose "yes" escalates the case at once.
//
// Escalation has two tiers (state.escalation.tiers): the onboard Crew Medical Officer now, and the
// flight surgeon through the ground packet, which is Queued at escalation (state.packet_queued_at)
// and leaves with the next link. A "releases_packet" step queues it too (crew release); before that
// the packet of an open case is Prepared (held on board). The reducer does not know the link.
//
// Tripwire timing: observations are collected throughout watch, but the tripwire is only judged at
// t >= reassess_at, matching the case texts ("Reassess at T+72 h; if ... still ..., escalate").
// Observations with crew_id null or absent (vehicle / habitat sensors, e.g. the proton monitor)
// describe the shared environment and count for every crewmember's case.
//
// Environment: a tripwire condition may carry "by_env": {env_id: {overrides}}. newCase(..., envId)
// applies the override for that environment, so a case watches the rule that applies there (the SPE
// case watches the Mars-orbit monitor rule at Mars and the NOAA rule near Earth).

import { EngineError } from './errors'
import { fmtNum, formatMet, isNumber } from './fmt'
import { clone, has, isInt, isNonemptyStr, isObj, pyEq, pyGet, pyIn, pyOr, pyRepr, pyStr, setOwn, sortedStrings, truthy } from './py'
import type { JsonObject } from './py'
import { compare, isOp } from './thresholds'
import type {
  CaseDef,
  CaseEvent,
  CaseLogEntry,
  CaseSpec,
  CaseState,
  CaseStatus,
  Op,
  TriggerLookup,
  TripwireResult,
} from './types'

export const STATES = ['idle', 'detected', 'acting', 'watch', 'resolved', 'escalated', 'dismissed'] as const
export const OPEN_STATES = ['detected', 'acting', 'watch'] as const
export const TERMINAL_STATES = ['resolved', 'escalated', 'dismissed'] as const
export const EVENTS = ['OPEN', 'SELECT', 'STEP', 'DECLINE', 'OUTCOME', 'TICK', 'DISMISS'] as const
export const OPENING_SEVERITIES = ['caution', 'warning', 'emergency'] as const
/** Tier 1 is told now, onboard; tier 2 gets the ground packet with the next link. */
export const ESCALATION_TIERS = ['crew_medical_officer', 'flight_surgeon'] as const
export const STEP_FLAGS = ['required', 'red_flag', 'releases_packet'] as const
const YES_NO_UNIT = 'yes/no'
export const OP_WORDS: Readonly<Record<Op, string>> = { lt: 'below', le: 'at or below', gt: 'above', ge: 'at or above' }
const ESCALATED_TEXT =
  'escalated: tier 1, the Crew Medical Officer, now; tier 2, the flight surgeon, ' +
  'through the ground packet, queued and sent when a link exists'

function list(x: unknown, what: string): unknown[] {
  // Python iterates `x or []`; a truthy non-list would crash it (or iterate dict keys / chars)
  const v = pyOr(x, [])
  if (!Array.isArray(v)) throw new EngineError('invalid_case', `${what} must be a list`)
  return v
}

const REF_KEYS = ['rule_id', 'indicator_id'] as const

/**
 * The tripwire condition for envId: the base condition with its by_env[envId] override applied.
 * An override replaces the keys it names; when it names a rule_id or indicator_id, the base
 * reference, variable and unit are dropped first, so they are resolved again for the new reference.
 */
function effectiveCondition(cid: string, cond: JsonObject, envId: string | null): JsonObject {
  const byEnv = pyGet(cond, 'by_env')
  if (byEnv !== null && !isObj(byEnv)) throw new EngineError('invalid_case', `case ${cid}: tripwire condition by_env must be an object`)
  const base: JsonObject = {}
  for (const k of Object.keys(cond)) if (k !== 'by_env' && has(cond, k)) setOwn(base, k, cond[k])
  if (envId === null || !isObj(byEnv) || !has(byEnv, envId)) return base
  const override = byEnv[envId]
  if (!isObj(override) || has(override, 'by_env')) {
    throw new EngineError('invalid_case', `case ${cid}: tripwire by_env[${pyRepr(envId)}] must be an object without by_env`)
  }
  if (REF_KEYS.some((k) => has(override, k))) {
    for (const k of [...REF_KEYS, 'variable', 'unit']) delete base[k]
  }
  for (const k of Object.keys(override)) if (has(override, k)) setOwn(base, k, override[k])
  return base
}

function idOf(x: unknown, what: string): unknown {
  // Python: x["id"] (KeyError if absent, TypeError if x is not a dict). Any present value is kept.
  if (!isObj(x) || !has(x, 'id')) throw new EngineError('invalid_case', `${what} needs an id`)
  return x.id
}

interface ProcedureSpec {
  step_ids: unknown[]
  required_step_ids: unknown[]
  red_flag_step_ids: unknown[]
  packet_step_ids: unknown[]
  step_inputs: Array<{ step_id: unknown; variable: string; unit: string }>
}

/** step_ids plus the step metadata the reducer enforces (required, red flag, packet release, inputs). */
function procedureSpec(cid: string, procedure: unknown[]): ProcedureSpec {
  const out: ProcedureSpec = { step_ids: [], required_step_ids: [], red_flag_step_ids: [], packet_step_ids: [], step_inputs: [] }
  for (const st of procedure) {
    const sid = idOf(st, 'procedure step')
    const step = st as JsonObject
    out.step_ids.push(sid)
    for (const flag of STEP_FLAGS) {
      if (has(step, flag) && typeof step[flag] !== 'boolean') {
        throw new EngineError('invalid_case', `case ${cid}: step ${pyRepr(sid)} ${flag} must be true or false`)
      }
    }
    const inp = pyGet(step, 'input')
    if (inp !== null) {
      if (!(isObj(inp) && typeof pyGet(inp, 'variable') === 'string' && typeof pyGet(inp, 'unit') === 'string' && inp.unit !== '')) {
        throw new EngineError('invalid_case', `case ${cid}: step ${pyRepr(sid)} input needs a variable and a unit`)
      }
      out.step_inputs.push({ step_id: sid, variable: inp.variable as string, unit: inp.unit as string })
    }
    if (pyGet(step, 'red_flag') === true) {
      if (pyGet(step, 'required') !== true || inp === null || (inp as JsonObject).unit !== YES_NO_UNIT) {
        throw new EngineError('invalid_case', `case ${cid}: red-flag step ${pyRepr(sid)} must be required and take a yes/no input`)
      }
      out.red_flag_step_ids.push(sid)
    }
    if (pyGet(step, 'required') === true) out.required_step_ids.push(sid)
    if (pyGet(step, 'releases_packet') === true) out.packet_step_ids.push(sid)
  }
  return out
}

/**
 * Build the pre-OPEN ("idle") state for one case and one crewmember. `lookup` maps a rule or
 * indicator id to {variable, unit} (triggerLookup(rules)); it resolves the tripwire variable when the
 * condition names a rule_id, and the tripwire unit when the condition has none. An explicit
 * condition variable / unit wins. An unresolvable variable or unit raises invalid_case.
 * `envId` (a non-empty string or null) selects the condition's by_env override for that environment;
 * the state records it as spec.env_id and the effective reference as spec.tripwire.condition.ref_id.
 * Procedure steps may carry required, red_flag and releases_packet (booleans); a red-flag step must be
 * required and take a yes/no input (SPEC 3.4).
 */
export function newCase(
  caseDef: CaseDef,
  crewId: string,
  lookup: TriggerLookup | null = null,
  envId: string | null = null,
): CaseState {
  if (!isObj(caseDef) || typeof pyGet(caseDef, 'id') !== 'string') {
    throw new EngineError('invalid_case', 'case definition must be an object with a string id')
  }
  if (typeof crewId !== 'string' || crewId === '') throw new EngineError('invalid_argument', 'crew_id must be a non-empty string')
  const env = envId === undefined ? null : (envId as unknown)
  if (env !== null && (typeof env !== 'string' || env === '')) {
    throw new EngineError('invalid_argument', 'env_id must be a non-empty string or null')
  }
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
  const proc = procedureSpec(cid, list(pyGet(def, 'procedure'), `case ${cid}: procedure`))
  const tw = pyGet(def, 'tripwire')
  if (!isObj(tw) || !isNumber(pyGet(tw, 'reassess_after_s')) || !isObj(pyGet(tw, 'condition'))) {
    throw new EngineError('invalid_case', `case ${cid}: tripwire.reassess_after_s and condition required`)
  }
  const cond = effectiveCondition(cid, tw.condition as JsonObject, env as string | null)
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
    env_id: env as string | null,
    trigger_ids: sortedStrings(triggerIds),
    countermeasure_ids: cmIds as string[],
    step_ids: proc.step_ids as string[],
    required_step_ids: proc.required_step_ids as string[],
    red_flag_step_ids: proc.red_flag_step_ids as string[],
    packet_step_ids: proc.packet_step_ids as string[],
    step_inputs: proc.step_inputs as CaseSpec['step_inputs'],
    tripwire: {
      reassess_after_s: tw.reassess_after_s as number,
      condition: {
        ref_id: typeof refId === 'string' ? refId : null,
        variable,
        op,
        value,
        unit,
        of_last_n: n,
        at_least: k,
      },
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
    steps_declined: [],
    outcome: null,
    watch_started_at: null,
    reassess_at: null,
    tripwire_obs: [],
    tripwire_result: null,
    escalation: null,
    packet_queued_at: null,
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

/** '1000 pfu', or a bare '4' for a count. */
function quantity(value: number, unit: string): string {
  return unit === 'count' ? fmtNum(value) : `${fmtNum(value)} ${unit}`
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
  // the required-step, escalation and packet fields (checked in Python too)
  const st = state as unknown as JsonObject
  const sp = st.spec as JsonObject
  const esc = pyGet(st, 'escalation')
  const pq = pyGet(st, 'packet_queued_at')
  const declinedList = pyGet(st, 'steps_declined')
  const inputs = pyGet(sp, 'step_inputs')
  if (
    !(
      Array.isArray(declinedList) &&
      has(st, 'escalation') &&
      (esc === null || isObj(esc)) &&
      has(st, 'packet_queued_at') &&
      (pq === null || isNumber(pq)) &&
      Array.isArray(pyGet(sp, 'required_step_ids')) &&
      Array.isArray(pyGet(sp, 'red_flag_step_ids')) &&
      Array.isArray(pyGet(sp, 'packet_step_ids')) &&
      Array.isArray(inputs) &&
      inputs.every((x) => isObj(x)) &&
      declinedList.every((d) => isObj(d))
    )
  ) {
    throw malformed('required-step, escalation or packet fields')
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

  const entry = (to: CaseStatus, detail: string, error: string | null): CaseLogEntry => ({
    t: t as number | null,
    event: etype as CaseLogEntry['event'],
    from: frm,
    to,
    detail,
    error,
  })
  const reject = (error: string, detail: string): CaseState => {
    // atomic: start again from the untouched input, so nothing this event did survives
    const out = clone(state)
    out.log.push(entry(frm, detail, error))
    return out
  }
  const accept = (to: CaseStatus, detail: string): CaseState => {
    s.status = to
    s.updated_at = t as number
    s.log.push(entry(to, detail, null))
    return s
  }

  if (!(EVENTS as readonly unknown[]).includes(etype)) return reject('invalid_event', `unknown event type ${pyRepr(etype)}`)
  if (!isNumber(t)) return reject('invalid_event', 'event t must be a finite number')
  if (etype === 'TICK' && frm !== 'watch') return s // clock ticks outside watch change nothing: no log entry
  if (s.updated_at !== null && t < s.updated_at) {
    return reject('time_reversed', `t ${fmtNum(t)} is before the last transition at ${fmtNum(s.updated_at)}`)
  }
  const caseId = pyStr(pyGet(s as unknown as JsonObject, 'case_id'))
  const spec = s.spec
  const nSteps = spec.step_ids.length
  const escalate = (reason: 'tripwire' | 'red_flag', stepId: unknown): void => {
    s.escalation = { t: t as number, reason, step_id: stepId as string | null, tiers: [...ESCALATION_TIERS] }
    if (s.packet_queued_at === null) s.packet_queued_at = t as number
    s.closed_at = t as number
  }
  const isDone = (stepId: unknown): boolean => s.steps_done.some((d) => pyEq(pyGet(d as unknown as JsonObject, 'step_id'), stepId))
  const isDeclined = (stepId: unknown): boolean =>
    s.steps_declined.some((d) => pyEq(pyGet(d as unknown as JsonObject, 'step_id'), stepId))

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
    if (!pyIn(stepId, spec.step_ids)) return reject('unknown_step', `${pyRepr(stepId)} is not a step of ${caseId}`)
    if (isDone(stepId)) return reject('duplicate_step', `step ${pyStr(stepId)} already done`)
    const inp = pyGet(ev, 'input')
    const decl = stepInput(spec, stepId)
    if (decl !== null && isObj(inp) && has(inp, 'unit') && !pyEq(inp.unit, decl.unit)) {
      return reject('unit_mismatch', `step ${pyStr(stepId)} expects ${pyRepr(decl.unit)}, input has ${pyRepr(inp.unit)}`)
    }
    const red = pyIn(stepId, spec.red_flag_step_ids)
    let answer: unknown = null
    if (red) {
      const [ok, a] = answerOf(YES_NO_UNIT, inp)
      if (!ok) return reject('invalid_event', `step ${pyStr(stepId)} is a red-flag question: answer yes or no`)
      answer = a
    } else if (decl !== null && pyIn(stepId, spec.required_step_ids)) {
      const [ok] = answerOf(decl.unit, inp)
      if (!ok) {
        return reject('invalid_event', `step ${pyStr(stepId)} is required and needs its value: ${decl.variable} (${decl.unit})`)
      }
    }
    s.steps_done.push({ step_id: stepId as string, t, input: clone(inp) })
    if (red && answer === true) {
      escalate('red_flag', stepId)
      return accept('escalated', `step ${pyStr(stepId)} answered yes, a red flag; ${ESCALATED_TEXT}`)
    }
    let note = red ? ', answered no' : ''
    if (pyIn(stepId, spec.packet_step_ids) && s.packet_queued_at === null) {
      s.packet_queued_at = t
      note += '; ground packet queued, sent when a link exists'
    }
    return accept('acting', `step ${pyStr(stepId)} done${note} (${s.steps_done.length} of ${nSteps})`)
  }

  if (etype === 'DECLINE') {
    if (frm !== 'acting') return reject('invalid_transition', `DECLINE is only valid from acting, case is ${frm}`)
    const stepId = pyGet(ev, 'step_id')
    if (!pyIn(stepId, spec.step_ids)) return reject('unknown_step', `${pyRepr(stepId)} is not a step of ${caseId}`)
    if (isDone(stepId) || isDeclined(stepId)) return reject('duplicate_step', `step ${pyStr(stepId)} already done or declined`)
    const reason = pyGet(ev, 'reason')
    if (!isNonemptyStr(reason)) return reject('invalid_event', 'DECLINE needs a non-empty reason')
    s.steps_declined.push({ step_id: stepId as string, t, reason })
    const req = pyIn(stepId, spec.required_step_ids) ? ' (required)' : ''
    return accept('acting', `step ${pyStr(stepId)}${req} declined: ${reason}`)
  }

  if (etype === 'OUTCOME') {
    if (frm !== 'acting') return reject('invalid_transition', `OUTCOME is only valid from acting, case is ${frm}`)
    const pending = spec.required_step_ids.filter((sid) => !isDone(sid) && !isDeclined(sid))
    if (pending.length) {
      return reject(
        'required_steps_pending',
        'required step(s) neither done nor declined with a reason: ' + pending.map((p) => pyStr(p)).join(', '),
      )
    }
    const text = pyGet(ev, 'text')
    if (!isNonemptyStr(text)) return reject('invalid_event', 'OUTCOME needs a non-empty text')
    s.outcome = { text, t }
    s.watch_started_at = t
    s.reassess_at = t + spec.tripwire.reassess_after_s
    const nDeclined = s.steps_declined.length
    const dec = nDeclined ? `, ${nDeclined} declined` : ''
    return accept(
      'watch',
      `outcome recorded; reassess at MET ${formatMet(s.reassess_at)} (${s.steps_done.length} of ${nSteps} steps done${dec})`,
    )
  }

  // TICK in watch
  const cond = s.spec.tripwire.condition
  const watchStart = s.watch_started_at as number
  const reassessAt = s.reassess_at as number
  const obsList = pyOr(pyGet(ev, 'observations'), [])
  if (!Array.isArray(obsList)) return reject('invalid_event', 'TICK observations must be a list')
  const knownT = new Set<number>(s.tripwire_obs.map((o) => o.t))
  const newObs: Array<{ t: number; value: number }> = []
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
    newObs.push({ t: ot, value: ov })
  }
  const added = newObs.length // committed only now that every observation of this TICK passed the unit check
  s.tripwire_obs.push(...newObs)
  s.tripwire_obs.sort((a, b) => a.t - b.t)
  const res = tripwireEval(s)
  const desc =
    `${res.hits} of the last ${res.considered} readings ${OP_WORDS[cond.op]} ${quantity(cond.value, cond.unit)} ` +
    `(escalates at ${pyStr(cond.at_least)} of ${pyStr(cond.of_last_n)})`
  if (t >= reassessAt) {
    if (res.tripped) {
      s.tripwire_result = res
      escalate('tripwire', null)
      return accept('escalated', `reassessed: ${desc}; ${ESCALATED_TEXT}`)
    }
    const remaining = cond.of_last_n - res.considered
    if (res.hits + remaining < cond.at_least) {
      s.tripwire_result = res
      s.closed_at = t
      return accept('resolved', `reassessed: ${desc}`)
    }
    if (added) return accept('watch', `reassessment due, need more readings: ${desc}`)
    return s
  }
  if (added) return accept('watch', `${added} new reading(s): ${desc}; judged at reassessment (MET ${formatMet(reassessAt)})`)
  return s
}

function stepInput(spec: CaseSpec, stepId: unknown): { variable: string; unit: string } | null {
  for (const x of spec.step_inputs) if (pyEq(pyGet(x as unknown as JsonObject, 'step_id'), stepId)) return x
  return null
}

/** [ok, answer] for a step input's value: a number, or a yes/no (boolean or 0/1) for unit yes/no. */
function answerOf(unit: string, inp: unknown): [boolean, unknown] {
  const v = isObj(inp) ? pyGet(inp, 'value') : null
  if (unit === YES_NO_UNIT) {
    if (v === true || v === false) return [true, v]
    if (isNumber(v) && (v === 0 || v === 1)) return [true, v === 1]
    return [false, null]
  }
  return [isNumber(v), v]
}
