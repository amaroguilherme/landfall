// Case lifecycle (pure; no React). Every case state is a FOLD of engine caseReduce over a
// time-ordered event list, up to the current MET:
//   1. auto OPEN  - LANDFALL opens a case when one of its triggers first reports a finding at
//                   caution or above (SPEC 3.4), found by evaluating each trigger at each of its
//                   observation times (scenario + runtime + the post-"now" replay);
//   2. scenario   - the seeded crew actions of the simulated scenario (labelled SIMULATED);
//   3. user       - events dispatched from the UI (in-memory, cleared by "reset scenario");
//   4. TICK       - synthesized while a case is in watch, carrying the tripwire variable's
//                   observations (crew + vehicle sensors), and one exactly at reassess_at.
// Because the fold is a pure function of (data, events, env, t), moving the clock back shows each
// case as it was then, and "reset scenario" is just dropping the user events.
import { RULES, caseReduce, getIndicator, getRule, newCase, triggerLookup } from './engine'
import type { CaseDef, CaseEvent, CaseState, Finding } from './engine'
import { evaluatePersonalAt, evaluateRuleAt, opensCase } from './evaluate'
import { observationDay, observationsFor, seriesKey } from './scenarioData'
import type { ScenarioIndex } from './scenarioData'
import { CREW_IDS } from './vocab'
import type { CrewId, EnvId, Observation } from './vocab'

const DAY_S = 86_400
const LOOKUP = triggerLookup(RULES)

/** Case definitions from engine/rules/cases.json, in file order. */
export const CASE_DEFS: readonly CaseDef[] = Array.isArray(RULES.cases?.cases) ? (RULES.cases!.cases as CaseDef[]) : []
export const CASE_IDS: readonly string[] = CASE_DEFS.map((c) => c.id)

export type CaseOrigin = 'auto' | 'scenario' | 'user' | 'tick'

/** One event in a case's timeline. `key` is `${crew_id}:${case_id}`. */
export interface CaseEventRecord {
  key: string
  event: CaseEvent
  origin: Exclude<CaseOrigin, 'tick'>
  /** Insertion order, for stable ties at the same t. */
  seq: number
}

export const caseKey = (crewId: CrewId, caseId: string): string => `${crewId}:${caseId}`

export function parseCaseKey(key: string): { crewId: CrewId; caseId: string } | null {
  const i = key.indexOf(':')
  if (i < 0) return null
  const crewId = key.slice(0, i) as CrewId
  const caseId = key.slice(i + 1)
  return (CREW_IDS as readonly string[]).includes(crewId) && CASE_IDS.includes(caseId) ? { crewId, caseId } : null
}

// ---- detection ---------------------------------------------------------------------------------

export interface Opening {
  /** MET of the observation whose finding opened the case. */
  t: number
  finding: Finding
  /** The trigger that fired: {kind, rule_id?, indicator_id?}. */
  trigger: { kind: string; rule_id?: string; indicator_id?: string }
}

function applies(rule: { applies_to?: string[] }, envId: EnvId): boolean {
  const a = rule.applies_to ?? []
  return a.includes('*') || a.includes(envId)
}

/**
 * First time any trigger of a case reports a finding at caution or above for this crewmember
 * (scanning each trigger's own observation times, earliest first). null when it never does.
 */
export function firstOpening(
  def: CaseDef,
  crewId: CrewId,
  index: ScenarioIndex,
  runtime: readonly Observation[],
  envId: EnvId,
  eva = false,
): Opening | null {
  let best: Opening | null = null
  for (const trig of def.triggers ?? []) {
    if ((trig.kind === 'rule' || trig.kind === 'ops') && trig.rule_id) {
      const rule = getRule(RULES, trig.rule_id)
      if (!applies(rule, envId)) continue // not_applicable here: it can never open the case
      for (const o of observationsFor(index, runtime, crewId, rule.variable)) {
        if (best && o.t >= best.t) break
        const f = evaluateRuleAt(rule, index, runtime, crewId, envId, o.t, eva).finding
        if (opensCase(f)) {
          best = { t: o.t, finding: f, trigger: { kind: trig.kind, rule_id: trig.rule_id } }
          break
        }
      }
    } else if (trig.kind === 'personal' && trig.indicator_id) {
      const ind = getIndicator(RULES, trig.indicator_id)
      for (const o of observationsFor(index, runtime, crewId, ind.variable)) {
        if (o.crew_id !== crewId || observationDay(o.t) <= index.baselineDays[1]) continue
        if (best && o.t >= best.t) break
        const f = evaluatePersonalAt(ind, index, runtime, crewId, o.t).finding
        if (opensCase(f)) {
          best = { t: o.t, finding: f, trigger: { kind: 'personal', indicator_id: trig.indicator_id } }
          break
        }
      }
    }
  }
  return best
}

// ---- the seeded scenario script (SIMULATED crew actions) ---------------------------------------

function obsAfter(list: readonly Observation[], t: number, crewId: CrewId): Observation | null {
  return list.find((o) => o.t > t && o.crew_id === crewId) ?? null
}

const stepInput = (o: Observation | null) => (o ? { variable: o.variable, value: o.value, unit: o.unit, t: o.t } : undefined)

/**
 * Crew actions of the simulated scenario (sim_crew episodes), relative to each auto OPEN:
 *   renal_stone (CM-3): hydration selected the morning after it opened (~MET day 399), steps logged,
 *     the required red-flag question r4 answered "no" (SPEC 7: the engine refuses the outcome until it
 *     is answered or declined), outcome recorded at 08:00 two days before "now", so at "now" it is in
 *     WATCH with its 72-h tripwire armed (reassess after "now");
 *   sleep_circadian (CM-1): light countermeasure selected after the PVT-B of the day it opened
 *     (by MET day 407), first steps logged, no outcome yet: ACTING at "now";
 *   spe_shelter: nothing scripted - the crew acts in the demo.
 * Step inputs only reference values that exist in sim_crew; nothing clinical is invented.
 */
export function scenarioScript(
  openings: ReadonlyMap<string, Opening>,
  index: ScenarioIndex,
  runtime: readonly Observation[],
): Array<Omit<CaseEventRecord, 'seq'>> {
  const out: Array<Omit<CaseEventRecord, 'seq'>> = []
  const nowDay = Math.floor(index.nowMet / DAY_S)
  for (const ep of index.episodes) {
    const crewId = ep.crew_id as CrewId
    const key = caseKey(crewId, ep.case_id)
    const open = openings.get(key)
    const def = CASE_DEFS.find((c) => c.id === ep.case_id)
    if (!open || !def || !(CREW_IDS as readonly string[]).includes(crewId)) continue
    const primary = def.countermeasure?.primary.id
    if (!primary) continue
    const push = (event: CaseEvent) => out.push({ key, event, origin: 'scenario' })
    if (ep.case_id === 'renal_stone') {
      const urine = observationsFor(index, runtime, crewId, 'urine_volume_24h')
      const morning = Math.floor(open.t / DAY_S) * DAY_S + 7.5 * 3600
      const tSelect = Math.max(morning, open.t + 60)
      push({ type: 'SELECT', t: tSelect, countermeasure_id: primary })
      const opened = urine.find((o) => o.t === open.t && o.crew_id === crewId) ?? null
      push({ type: 'STEP', t: tSelect + 300, step_id: 'r1', input: stepInput(opened) })
      push({ type: 'STEP', t: tSelect + 600, step_id: 'r3' })
      // The red-flag question (required): the simulated crewmember reports none of the listed symptoms.
      // Its variable and unit are the step's own declared input (cases.json r4), never typed here.
      const redFlag = (def.procedure ?? []).find((p) => p.red_flag === true && p.input)
      const rf = redFlag?.input as { variable?: unknown; unit?: unknown } | undefined
      if (redFlag && typeof rf?.variable === 'string' && typeof rf.unit === 'string') {
        push({ type: 'STEP', t: tSelect + 720, step_id: redFlag.id, input: { variable: rf.variable, value: false, unit: rf.unit } })
      }
      const next = obsAfter(urine, open.t, crewId)
      if (next) push({ type: 'STEP', t: Math.max(next.t + 7.5 * 3600, tSelect + 900), step_id: 'r5', input: stepInput(next) })
      const tOutcome = (nowDay - 2) * DAY_S + 8 * 3600
      const rule = getRule(RULES, 'target_urine_output_24h')
      const target = rule.approach_at?.value ?? rule.limit
      const before = urine.filter((o) => o.crew_id === crewId && o.t > open.t && o.t <= tOutcome)
      let back: Observation | null = null
      for (const o of before) back = o.value >= target ? (back ?? o) : null
      const text = back
        ? `Hydration plan followed. 24-h urine output back at or above ${target} mL on every day since MET day ${observationDay(back.t)}.`
        : 'Hydration plan followed; 24-h urine output logged every day.'
      if (tOutcome > tSelect) push({ type: 'OUTCOME', t: tOutcome, text })
    } else if (ep.case_id === 'sleep_circadian') {
      const pvt = observationsFor(index, runtime, crewId, 'pvt_lapses')
      const firstPvt = pvt.find((o) => o.t >= open.t && o.crew_id === crewId) ?? null
      const tSelect = (firstPvt ? firstPvt.t : open.t) + 900
      push({ type: 'SELECT', t: tSelect, countermeasure_id: primary })
      push({ type: 'STEP', t: tSelect + 120, step_id: 's1', input: stepInput(firstPvt) })
      const sleep = observationsFor(index, runtime, crewId, 'sleep_duration')
      const lastSleep = [...sleep].reverse().find((o) => o.t <= tSelect && o.crew_id === crewId) ?? null
      push({ type: 'STEP', t: tSelect + 240, step_id: 's2', input: stepInput(lastSleep) })
      push({ type: 'STEP', t: tSelect + 360, step_id: 's3' })
    }
  }
  return out
}

/**
 * Observations implied by the seeded crew's ANSWERS: a scripted step input whose variable is not a recorded
 * series of the scenario (the renal red-flag answer, unit yes/no). The cases page logs the same kind of entry
 * for a user's answer (yes/no as 1/0), so the ground packet and the on-board record also see the simulated
 * crew's answer. Inputs that point at a recorded series (urine totals, PVT-B) add nothing: they are already there.
 */
export function scriptedAnswers(events: readonly CaseEventRecord[], index: ScenarioIndex): Observation[] {
  const out: Observation[] = []
  for (const r of events) {
    if (r.origin !== 'scenario' || r.event.type !== 'STEP') continue
    const inp = r.event.input as { variable?: unknown; value?: unknown; unit?: unknown } | undefined
    if (!inp || typeof inp.variable !== 'string' || typeof inp.unit !== 'string') continue
    const key = parseCaseKey(r.key)
    if (!key || index.series.has(seriesKey(key.crewId, inp.variable)) || index.series.has(seriesKey(null, inp.variable))) continue
    const value = inp.value === true ? 1 : inp.value === false ? 0 : typeof inp.value === 'number' && Number.isFinite(inp.value) ? inp.value : null
    if (value === null) continue
    out.push({ crew_id: key.crewId, variable: inp.variable, value, unit: inp.unit, t: r.event.t, source: 'manual', provenance: 'simulated' })
  }
  return out.sort((a, b) => a.t - b.t)
}

// ---- the fold ------------------------------------------------------------------------------------

export interface CaseView {
  key: string
  crewId: CrewId
  caseId: string
  def: CaseDef
  /** Engine state at the evaluation MET (status 'idle' until OPEN). */
  state: CaseState
  /** Origin of each state.log entry (same index): auto / scenario / user / tick. */
  logOrigins: CaseOrigin[]
  /** When LANDFALL detects (or detected) this case from the data, even if later than the clock. */
  opening: Opening | null
}

const ORIGIN_RANK: Record<CaseEventRecord['origin'], number> = { auto: 0, scenario: 1, user: 2 }

export function sortEvents(events: readonly CaseEventRecord[]): CaseEventRecord[] {
  return [...events].sort((a, b) => a.event.t - b.event.t || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || a.seq - b.seq)
}

type OpenHook = (view: { key: string; caseId: string; crewId: CrewId; t: number }) => void

/** Fold one case's events (any order) up to MET tNow, synthesizing tripwire TICKs while in watch. */
export function foldCase(
  def: CaseDef,
  crewId: CrewId,
  events: readonly CaseEventRecord[],
  tripwireObs: readonly Observation[],
  tNow: number,
  onOpen?: OpenHook,
  envId: EnvId | null = null,
): { state: CaseState; logOrigins: CaseOrigin[] } {
  // envId selects the tripwire's by_env override (SPEC 3.4): at Mars spe_shelter watches ops_onboard_proton_s3.
  let s = newCase(def, crewId, LOOKUP, envId)
  const origins: CaseOrigin[] = []
  const apply = (event: CaseEvent, origin: CaseOrigin) => {
    const n = s.log.length
    s = caseReduce(s, event)
    if (s.log.length > n) origins.push(origin)
  }
  const tickUntil = (T: number) => {
    if (s.status !== 'watch' || s.watch_started_at === null || s.reassess_at === null) return
    const ws = s.watch_started_at
    const ra = s.reassess_at
    if (ra <= T) {
      if ((s.updated_at ?? -Infinity) <= ra) apply({ type: 'TICK', t: ra, observations: tripwireObs.filter((o) => o.t > ws && o.t <= ra) }, 'tick')
      for (const o of tripwireObs) {
        if (s.status !== 'watch') break
        if (o.t <= ra || o.t > T || o.t < (s.updated_at ?? -Infinity)) continue
        apply({ type: 'TICK', t: o.t, observations: [o] }, 'tick')
      }
    } else {
      const fresh = tripwireObs.filter((o) => o.t > Math.max(ws, s.updated_at ?? -Infinity) && o.t <= T)
      if (fresh.length) apply({ type: 'TICK', t: T, observations: fresh }, 'tick')
    }
  }
  for (const r of sortEvents(events)) {
    if (r.event.t > tNow) break
    tickUntil(r.event.t)
    const wasIdle = s.status === 'idle'
    apply(r.event, r.origin)
    if (wasIdle && s.status === 'detected' && onOpen) onOpen({ key: caseKey(crewId, def.id), caseId: def.id, crewId, t: r.event.t })
  }
  tickUntil(tNow)
  return { state: s, logOrigins: origins }
}

export interface CaseTimelineInput {
  index: ScenarioIndex
  runtime: readonly Observation[]
  envId: EnvId
  /** Evaluation MET. */
  t: number
  userEvents: readonly CaseEventRecord[]
  eva?: boolean
}

/** Detection + script for one (data, env): independent of the clock, so it can be cached. */
export function caseSchedule(index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, eva = false) {
  const openings = new Map<string, Opening>()
  for (const crewId of CREW_IDS) {
    for (const def of CASE_DEFS) {
      const o = firstOpening(def, crewId, index, runtime, envId, eva)
      if (o) openings.set(caseKey(crewId, def.id), o)
    }
  }
  const events: CaseEventRecord[] = []
  let seq = 0
  for (const [key, o] of openings) events.push({ key, event: { type: 'OPEN', t: o.t, finding: o.finding }, origin: 'auto', seq: seq++ })
  for (const e of scenarioScript(openings, index, runtime)) events.push({ ...e, seq: seq++ })
  return { openings, events, answers: scriptedAnswers(events, index) }
}

/** Every crewmember x case, folded at input.t. */
export function computeCases(input: CaseTimelineInput, schedule = caseSchedule(input.index, input.runtime, input.envId, input.eva), onOpen?: OpenHook): CaseView[] {
  const out: CaseView[] = []
  for (const crewId of CREW_IDS) {
    for (const def of CASE_DEFS) {
      const key = caseKey(crewId, def.id)
      const events = [...schedule.events.filter((e) => e.key === key), ...input.userEvents.filter((e) => e.key === key)]
      const cond = newCase(def, crewId, LOOKUP, input.envId).spec.tripwire.condition
      const trip = observationsFor(input.index, input.runtime, crewId, cond.variable).filter(
        (o) => (o.crew_id === null || o.crew_id === crewId) && o.unit === cond.unit,
      )
      const { state, logOrigins } = foldCase(def, crewId, events, trip, input.t, onOpen, input.envId)
      out.push({ key, crewId, caseId: def.id, def, state, logOrigins, opening: schedule.openings.get(key) ?? null })
    }
  }
  return out
}
