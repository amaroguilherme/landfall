// Case lifecycle (pure; no React). Every case state is a FOLD of engine caseReduce over a
// time-ordered event list, up to the current MET:
//   1. auto OPEN  - LANDFALL opens a case when one of its triggers reports a finding at caution or
//                   above (SPEC 3.4), found by evaluating each trigger at each of its observation
//                   times (scenario + runtime + the post-"now" replay). Instances (SPEC 7): while an
//                   instance is open, later trigger findings open nothing. Re-open hysteresis: after it
//                   closes (resolved, escalated or dismissed, at closed_at), the next instance opens only
//                   at a trigger finding at caution or above, observed after closed_at, that ends a period
//                   of at least the case's reassess_after_s with every trigger below caution (each reading
//                   holds until the next one, so a gap after a caution is not clear). Its OPEN carries
//                   clear_since, the start of that period, and
//                   the engine checks it. So a condition that persists through an escalation (or a
//                   dismissal) keeps that instance, and a reading that flaps around the level opens nothing;
//   2. scenario   - the seeded crew actions of the simulated scenario (labelled SIMULATED), generated for
//                   each instance the fold opens before the scenario's "now": a scripted episode's actions
//                   for the instance its data opens, and a re-measure for a single Tier B flag;
//   3. user       - events dispatched from the UI (in-memory, cleared by "reset scenario");
//   4. TICK       - synthesized while a case is in watch, carrying the tripwire variable's
//                   observations (crew + vehicle sensors), and one exactly at reassess_at.
// Because the fold is a pure function of (data, events, env, t), moving the clock back shows each
// case as it was then, and "reset scenario" is just dropping the user events.
import { RULES, TERMINAL_STATES, caseReduce, getIndicator, getRule, newCase, triggerLookup } from './engine'
import type { CaseDef, CaseEvent, CaseState, CaseStatus, ChanceRate, EscalationTier, Finding } from './engine'
import { chanceRateOf, evaluatePersonalAt, evaluateRuleOn, opensCase } from './evaluate'
import { episodeDays, observationDay, observationsFor, seriesKey } from './scenarioData'
import type { ScenarioIndex } from './scenarioData'
import { CREW_IDS } from './vocab'
import type { CrewId, EnvId, Observation } from './vocab'

const DAY_S = 86_400
const LOOKUP = triggerLookup(RULES)
const CLOSED: ReadonlySet<string> = new Set(TERMINAL_STATES)
/** rules/meta.json escalation: newCase names tier 1 for each crewmember from it (the backup for the CMO's own case). */
const ESCALATION: unknown = (RULES.meta as { escalation?: unknown } | null | undefined)?.escalation ?? null

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
  /** Scripted crew actions only: the case instance they belong to (skipped for any other instance). */
  instance?: number
}

export const caseKey = (crewId: CrewId, caseId: string): string => `${crewId}:${caseId}`

export function parseCaseKey(key: string): { crewId: CrewId; caseId: string } | null {
  const i = key.indexOf(':')
  if (i < 0) return null
  const crewId = key.slice(0, i) as CrewId
  const caseId = key.slice(i + 1)
  return (CREW_IDS as readonly string[]).includes(crewId) && CASE_IDS.includes(caseId) ? { crewId, caseId } : null
}

// ---- detection: every finding of every trigger, evaluated lazily and memoized -------------------

export interface Opening {
  /** MET of the observation whose finding opened the case. */
  t: number
  finding: Finding
  /** The trigger that fired: {kind, rule_id?, indicator_id?}. */
  trigger: { kind: string; rule_id?: string; indicator_id?: string }
}

/** One trigger of one case for one crewmember: its observation times, and its finding at each (memoized). */
export interface TriggerStream {
  trigger: Opening['trigger']
  /** The rule or indicator id. */
  ref: string
  /** A personal (Tier B) trigger. */
  tierB: boolean
  /** Observation times, ascending (personal triggers: the crewmember's own values after the baseline). */
  times: number[]
  /** The engine's finding at times[i] (evaluated on first use). */
  at: (i: number) => Finding
}

function applies(rule: { applies_to?: string[] }, envId: EnvId): boolean {
  const a = rule.applies_to ?? []
  return a.includes('*') || a.includes(envId)
}

/** Index of the first time > after (or >= after with `inclusive`), times ascending. */
function firstAfter(times: readonly number[], after: number, inclusive = false): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (inclusive ? times[mid] >= after : times[mid] > after) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** The trigger streams of a case for a crewmember (a rule that does not apply here can never open it: no stream). */
export function triggerStreams(def: CaseDef, crewId: CrewId, index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, eva = false): TriggerStream[] {
  const out: TriggerStream[] = []
  for (const trig of def.triggers ?? []) {
    if ((trig.kind === 'rule' || trig.kind === 'ops') && trig.rule_id) {
      const rule = getRule(RULES, trig.rule_id)
      if (!applies(rule, envId)) continue
      const obs = observationsFor(index, runtime, crewId, rule.variable)
      const times = obs.map((o) => o.t)
      const memo = new Map<number, Finding>()
      out.push({
        trigger: { kind: trig.kind, rule_id: trig.rule_id },
        ref: trig.rule_id,
        tierB: false,
        times,
        at: (i) => {
          let f = memo.get(i)
          if (!f) {
            f = evaluateRuleOn(rule, obs, envId, times[i], eva).finding
            memo.set(i, f)
          }
          return f
        },
      })
    } else if (trig.kind === 'personal' && trig.indicator_id) {
      const ind = getIndicator(RULES, trig.indicator_id)
      const times = observationsFor(index, runtime, crewId, ind.variable)
        .filter((o) => o.crew_id === crewId && observationDay(o.t) > index.baselineDays[1])
        .map((o) => o.t)
      const memo = new Map<number, Finding>()
      out.push({
        trigger: { kind: 'personal', indicator_id: trig.indicator_id },
        ref: trig.indicator_id,
        tierB: true,
        times,
        at: (i) => {
          let f = memo.get(i)
          if (!f) {
            f = evaluatePersonalAt(ind, index, runtime, crewId, times[i]).finding
            memo.set(i, f)
          }
          return f
        },
      })
    }
  }
  return out
}

/**
 * The first instance's opening: the next trigger finding at caution or above observed after `after` (null: from
 * the start) and at or before `until`, earliest first (ties: trigger order). Later instances: nextReopening.
 */
export function nextOpening(streams: readonly TriggerStream[], after: number | null, until: number): Opening | null {
  let best: Opening | null = null
  for (const s of streams) {
    for (let i = after === null ? 0 : firstAfter(s.times, after); i < s.times.length; i++) {
      const t = s.times[i]
      if (t > until || (best && t >= best.t)) break
      const f = s.at(i)
      if (!opensCase(f)) continue
      best = { t, finding: f, trigger: s.trigger }
      break
    }
  }
  return best
}

/** A re-opening (SPEC 7): the opening finding, and when every trigger of the case went below caution before it. */
export interface Reopening extends Opening {
  /** MET from which every trigger has been below caution (the OPEN's clear_since). */
  clear_since: number
}

/**
 * Re-open hysteresis (SPEC 7): the opening of the instance after a closed one. Each trigger is followed through its
 * own readings, each holding until the next one (so a data gap after a caution is not a clear period: the caution
 * holds until a reading below it); the case is clear while no trigger's latest finding is at caution or above. The next instance opens at the first trigger finding at caution or
 * above observed after `closedAt` (and at or before `until`) that ends a clear period of at least `clearS` seconds
 * (the case's reassess_after_s); `clear_since` is when that period began: the first reading below caution of the last
 * trigger to clear, which may lie before `closedAt`. The walk starts at the closed instance's opening, `openedAt`,
 * when its trigger was at caution. A reading at caution that ends a shorter clear period opens nothing and starts the
 * wait again. Ties at one time: trigger order.
 */
export function nextReopening(
  streams: readonly TriggerStream[],
  openedAt: number,
  closedAt: number,
  until: number,
  clearS: number,
): Reopening | null {
  const n = streams.length
  const idx = streams.map((s) => firstAfter(s.times, openedAt))
  // each trigger's state at the opening: the finding of its latest reading at or before openedAt
  const held = streams.map((s, k) => idx[k] > 0 && opensCase(s.at(idx[k] - 1)))
  let clearSince: number | null = held.some(Boolean) ? null : openedAt
  for (;;) {
    let t = Infinity
    for (let k = 0; k < n; k++) if (idx[k] < streams[k].times.length && streams[k].times[idx[k]] < t) t = streams[k].times[idx[k]]
    if (t === Infinity || t > until) return null
    // clear just before t, and long enough: the first reading at caution at t (trigger order) opens the next instance
    const ready = clearSince !== null && t > closedAt && t - clearSince >= clearS
    let open: Reopening | null = null
    for (let k = 0; k < n; k++) {
      const s = streams[k]
      while (idx[k] < s.times.length && s.times[idx[k]] === t) {
        const f = s.at(idx[k])
        const atCaution = opensCase(f)
        if (atCaution && ready && !open) open = { t, finding: f, trigger: s.trigger, clear_since: clearSince as number }
        held[k] = atCaution
        idx[k]++
      }
    }
    if (open) return open
    if (held.some(Boolean)) clearSince = null
    else if (clearSince === null) clearSince = t
  }
}

/**
 * First time any trigger of a case reports a finding at caution or above for this crewmember
 * (scanning each trigger's own observation times, earliest first). null when it never does.
 */
export function firstOpening(def: CaseDef, crewId: CrewId, index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, eva = false): Opening | null {
  return nextOpening(triggerStreams(def, crewId, index, runtime, envId, eva), null, Infinity)
}

// ---- "possibly chance": a single Tier B flag (SPEC 7) ----------------------------------------------

export interface ChanceNote {
  /** The indicator whose single flag opened the instance. */
  indicatorId: string
  label: string
  /** MET day of that flag. */
  day: number
  /** The engine's chance rate of that indicator (measured where personal.json declares it). */
  rate: ChanceRate
  /** "Possibly chance: about 1 in 1000 days per crewmember would flag like this with no real change". */
  text: string
}

/**
 * SPEC 7: an instance opened by a Tier B finding that, from its opening up to `until` (the clock, or its close),
 * has had no caution of any of the case's triggers on another day or from another indicator is a single Tier B
 * flag. Its note carries the engine's chance_rate text of the opening indicator; null otherwise.
 */
export function singleFlagNote(streams: readonly TriggerStream[], opening: Opening | null, until: number): ChanceNote | null {
  const id = opening?.trigger.kind === 'personal' ? opening.trigger.indicator_id : undefined
  if (!opening || !id || opening.finding.tier !== 'B') return null
  const day = observationDay(opening.t)
  for (const s of streams) {
    for (let i = firstAfter(s.times, opening.t, true); i < s.times.length && s.times[i] <= until; i++) {
      if (s.ref === id && observationDay(s.times[i]) === day) continue
      if (opensCase(s.at(i))) return null
    }
  }
  const rate = chanceRateOf(id)
  if (!rate) return null
  let label = id
  try {
    label = getIndicator(RULES, id).label ?? id
  } catch {
    label = id
  }
  return { indicatorId: id, label, day, rate, text: `Possibly chance: ${rate.text}` }
}

// ---- the seeded scenario script (SIMULATED crew actions), per instance -------------------------------

type Scripted = Omit<CaseEventRecord, 'seq'>

/** Re-measure days before the simulated crew records the outcome of a single flag (design choice). */
export const REMEASURE_DAYS = 3

function obsAfter(list: readonly Observation[], t: number, crewId: CrewId): Observation | null {
  return list.find((o) => o.t > t && o.crew_id === crewId) ?? null
}

const stepInput = (o: Observation | null) => (o ? { variable: o.variable, value: o.value, unit: o.unit, t: o.t } : undefined)

/** "Sleep midpoint shift" -> "sleep midpoint shift" inside a sentence (acronyms such as PVT-B kept). */
const midSentence = (label: string) => (/^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label)

interface ScriptCtx {
  def: CaseDef
  crewId: CrewId
  key: string
  instance: number
  open: Opening
  index: ScenarioIndex
  runtime: readonly Observation[]
  streams: readonly TriggerStream[]
}

/**
 * A scripted episode's crew actions for the instance its data opens (sim_crew episodes):
 *   renal_stone (CM-3): hydration selected the morning after it opened (~MET day 399), steps logged,
 *     the required red-flag question r4 answered "no" (SPEC 7: the engine refuses the outcome until it
 *     is answered or declined), outcome recorded at 08:00 two days before "now", so at "now" it is in
 *     WATCH with its 72-h tripwire armed (reassess after "now");
 *   sleep_circadian (CM-1): light countermeasure selected after the PVT-B of the day it opened, first
 *     steps logged, no outcome yet: ACTING at "now";
 *   spe_shelter: nothing scripted - the crew acts in the demo.
 * Step inputs only reference values that exist in sim_crew; nothing clinical is invented.
 */
function episodeScript(c: ScriptCtx, caseId: string): Scripted[] {
  const { def, crewId, key, instance, open, index, runtime } = c
  const out: Scripted[] = []
  const primary = def.countermeasure?.primary.id
  if (!primary) return out
  const nowDay = Math.floor(index.nowMet / DAY_S)
  const push = (event: CaseEvent) => out.push({ key, event, origin: 'scenario', instance })
  if (caseId === 'renal_stone') {
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
  } else if (caseId === 'sleep_circadian') {
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
  return out
}

/**
 * A single Tier B flag of the sleep case with no scripted episode behind it (a chance flag of real-size noise,
 * sim_crew data.self_check): the simulated crewmember re-measures (step 1, the PVT-B after the flag; step 2,
 * the night's sleep), watches the next REMEASURE_DAYS days, and records the outcome at 08:00 on the last of
 * them, only if the flagged indicator was measured on each of those days and no trigger of the case reached
 * caution meanwhile. The tripwire then judges the following readings: clear, the case resolves.
 */
function remeasureScript(c: ScriptCtx): Scripted[] {
  const { def, crewId, key, instance, open, index, runtime, streams } = c
  const out: Scripted[] = []
  const primary = def.countermeasure?.primary.id
  const id = open.trigger.indicator_id
  if (!primary || !id) return out
  const push = (event: CaseEvent) => out.push({ key, event, origin: 'scenario', instance })
  const pvt = observationsFor(index, runtime, crewId, 'pvt_lapses')
  const firstPvt = pvt.find((o) => o.t >= open.t && o.crew_id === crewId) ?? null
  const tSelect = (firstPvt ? firstPvt.t : open.t) + 900
  push({ type: 'SELECT', t: tSelect, countermeasure_id: primary })
  push({ type: 'STEP', t: tSelect + 120, step_id: 's1', input: stepInput(firstPvt) })
  const sleep = observationsFor(index, runtime, crewId, 'sleep_duration')
  const lastSleep = [...sleep].reverse().find((o) => o.t <= tSelect && o.crew_id === crewId) ?? null
  push({ type: 'STEP', t: tSelect + 240, step_id: 's2', input: stepInput(lastSleep) })
  const day = observationDay(open.t)
  const tOutcome = (day + REMEASURE_DAYS) * DAY_S + 8 * 3600
  if (tOutcome >= index.nowMet || tOutcome <= tSelect + 240) return out
  // Back in range: no trigger at caution after the flag (the flag's own day aside), up to the outcome ...
  if (!singleFlagNote(streams, open, tOutcome)) return out
  // ... and the flagged indicator re-measured on each of the next REMEASURE_DAYS days.
  const flagged = streams.find((s) => s.ref === id)
  const measured = new Set((flagged?.times ?? []).filter((t) => t > open.t && t <= tOutcome).map(observationDay))
  for (let d = day + 1; d <= day + REMEASURE_DAYS; d++) if (!measured.has(d)) return out
  let label = id
  try {
    label = getIndicator(RULES, id).label ?? id
  } catch {
    label = id
  }
  push({
    type: 'OUTCOME',
    t: tOutcome,
    text: `Re-measured on MET days ${day + 1}–${day + REMEASURE_DAYS}: ${midSentence(label)} back inside my personal band each day, and no other trigger of this case flagged.`,
  })
  return out
}

/**
 * The seeded crew actions for one instance the fold opens: the scripted episode whose days include the opening
 * day (each episode once: an instance reopened within an episode the crew already acted on gets nothing), else,
 * on a day no episode covers, the re-measure of a Tier B flag of the sleep case. Nothing for an opening at or
 * after the scenario's "now" (from "now" on the user is the crew), and only actions before "now".
 */
export function instanceScript(c: ScriptCtx, usedEpisodes: Set<string>): Scripted[] {
  if (c.open.t >= c.index.nowMet) return []
  const day = observationDay(c.open.t)
  const covering = c.index.episodes.filter((e) => e.crew_id === c.crewId && e.case_id === c.def.id && episodeDays(e).includes(day))
  const ep = covering.find((e) => !usedEpisodes.has(e.id))
  let out: Scripted[] = []
  if (ep) {
    usedEpisodes.add(ep.id)
    out = episodeScript(c, ep.case_id)
  } else if (!covering.length && c.def.id === 'sleep_circadian' && c.open.trigger.kind === 'personal') {
    // no scripted episode on this day: a chance flag of real-size noise, which the simulated crew re-measures
    out = remeasureScript(c)
  }
  return out.filter((e) => e.event.t < c.index.nowMet)
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

// ---- escalation tier 1 for the patient (rules/meta.json escalation; SPEC 2) -------------------------------

interface TierDefMeta {
  tier?: number
  id?: string
  label?: string
  name?: string
  crew_id?: string | null
  backup?: { id?: string; label?: string; name?: string; crew_id?: string; chip?: string; source?: Record<string, unknown>; citations?: Array<Record<string, unknown>> }
}

/** Who takes tier 1 of an escalation for this patient: the Crew Medical Officer, or the backup on the CMO's own cases. */
export interface TierOne {
  /** 'crew_medical_officer', or 'backup_medical_officer' when the patient is the Crew Medical Officer. */
  id: string
  /** meta.json label: "Crew Medical Officer (onboard)" / "Backup medical officer: the Commander (onboard)". */
  label: string
  /** "the Crew Medical Officer" / "the Commander". */
  name: string
  /** The crewmember who takes tier 1: 'CM-4', or 'CM-1' for CM-4's own cases. */
  crewId: string | null
  /** True when the patient holds tier 1's role, so the backup takes it. */
  backup: boolean
  /** One crew-facing sentence for the escalation, true for this patient. */
  line: string
  /** The basis of a backup (design choice, quoting [V2 7045]); null for the Crew Medical Officer. */
  chip: string | null
  source: Record<string, unknown> | null
  citations: Array<Record<string, unknown>>
}

const TIER_DEFS: readonly TierDefMeta[] = (() => {
  const tiers = (ESCALATION as { tiers?: unknown } | null)?.tiers
  return Array.isArray(tiers) ? (tiers as TierDefMeta[]) : []
})()

/**
 * Tier 1 for a patient, from meta.json escalation, as newCase resolves it (spec.escalation_tiers[0]): when the patient
 * holds tier 1's role (the Crew Medical Officer, CM-4) and the tier has a backup, the backup (the Commander, CM-1).
 */
export function tierOneFor(crewId: CrewId): TierOne {
  const t1 = TIER_DEFS.find((t) => t.tier === 1)
  const holder = t1?.crew_id ?? null
  const b = t1?.backup
  const name = t1?.name ?? 'the Crew Medical Officer'
  if (b && b.id && b.crew_id && holder === crewId) {
    const bName = b.name ?? 'the backup medical officer'
    return {
      id: b.id,
      label: b.label ?? 'Backup medical officer (onboard)',
      name: bName,
      crewId: b.crew_id,
      backup: true,
      line: `You are ${name} and the patient: tell ${bName} (${b.crew_id}), the backup medical officer, now.`,
      chip: b.chip ?? null,
      source: b.source ?? null,
      citations: Array.isArray(b.citations) ? b.citations : [],
    }
  }
  return {
    id: t1?.id ?? 'crew_medical_officer',
    label: t1?.label ?? 'Crew Medical Officer (onboard)',
    name,
    crewId: holder,
    backup: false,
    line: `Tell ${name}${holder ? ` (${holder})` : ''} now.`,
    chip: null,
    source: null,
    citations: [],
  }
}

/** The engine's resolved tier 1 of a case state (spec.escalation_tiers[0]), or null for an older state. */
export function stateTierOne(state: Pick<CaseState, 'spec'>): EscalationTier | null {
  return state.spec.escalation_tiers?.[0] ?? null
}

// ---- the fold ------------------------------------------------------------------------------------

/** One instance (episode) of a case for a crewmember, as the fold saw it. */
export interface InstanceView {
  instance: number
  status: CaseStatus
  opened_at: number | null
  closed_at: number | null
  /** The auto OPEN that opened it (null when the OPEN came from outside the fold's detection). */
  opening: Opening | null
  /** A single Tier B flag up to its close (or the clock, while open): possibly chance (SPEC 7). */
  chance: ChanceNote | null
}

export interface CaseView {
  key: string
  crewId: CrewId
  caseId: string
  def: CaseDef
  /** Engine state at the evaluation MET (status 'idle' until OPEN; instance counts episodes). */
  state: CaseState
  /** Origin of each state.log entry (same index): auto / scenario / user / tick. */
  logOrigins: CaseOrigin[]
  /** When LANDFALL first detects (or detected) this case from the data, even if later than the clock (instance 1). */
  opening: Opening | null
  /** Every instance up to the clock, oldest first; the last one is the current state's (empty while idle). */
  instances: InstanceView[]
  /** The current instance's "Possibly chance" note when it is a single Tier B flag, else null. */
  chance: ChanceNote | null
  /** Who takes tier 1 if this case escalates: the Crew Medical Officer, or the backup (the Commander) on CM-4's cases. */
  tier1: TierOne
}

const ORIGIN_RANK: Record<CaseEventRecord['origin'], number> = { auto: 0, scenario: 1, user: 2 }

export function sortEvents(events: readonly CaseEventRecord[]): CaseEventRecord[] {
  return [...events].sort((a, b) => a.event.t - b.event.t || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || a.seq - b.seq)
}

type OpenHook = (view: { key: string; caseId: string; crewId: CrewId; t: number; instance: number }) => void

export interface FoldInput {
  def: CaseDef
  crewId: CrewId
  /** Events from outside the detection: user events (and explicit OPENs or scripted events in tests), any order. */
  events: readonly CaseEventRecord[]
  tripwireObs: readonly Observation[]
  tNow: number
  /** The case's trigger streams: the fold sends OPEN itself (SPEC 7). Empty: no automatic OPEN. */
  streams?: readonly TriggerStream[]
  /** Seeded crew actions for an instance the fold opens (none when absent). */
  script?: (open: Opening, instance: number, usedEpisodes: Set<string>) => Scripted[]
  onOpen?: OpenHook
  /** Selects the tripwire's by_env override (SPEC 3.4): at Mars spe_shelter watches ops_onboard_proton_s3. */
  envId?: EnvId | null
}

export interface FoldResult {
  state: CaseState
  logOrigins: CaseOrigin[]
  instances: InstanceView[]
  /** The scripted crew actions the fold applied (for the seeded answers). */
  applied: CaseEventRecord[]
}

/** Fold one case's events up to MET tNow: automatic OPENs per instance, scripted actions, user events, tripwire TICKs. */
export function foldCase(input: FoldInput): FoldResult {
  const { def, crewId, tripwireObs, tNow, onOpen } = input
  const streams = input.streams ?? []
  let s = newCase(def, crewId, LOOKUP, input.envId ?? null, ESCALATION)
  const origins: CaseOrigin[] = []
  const applied: CaseEventRecord[] = []
  const openings = new Map<number, Opening>()
  const usedEpisodes = new Set<string>()
  const queue = sortEvents(input.events)
  let qi = 0
  let seq = 1_000_000
  let blockedUntil = -Infinity // an OPEN the engine refused is not offered again
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
  const closedOrIdle = () => s.status === 'idle' || CLOSED.has(s.status)
  for (;;) {
    const next = qi < queue.length && queue[qi].event.t <= tNow ? queue[qi] : null
    const horizon = next ? next.event.t : tNow
    tickUntil(horizon)
    if (closedOrIdle() && streams.length) {
      let o: Opening | Reopening | null
      if (s.status === 'idle') {
        o = nextOpening(streams, blockedUntil === -Infinity ? null : blockedUntil, horizon)
      } else {
        // re-open hysteresis (SPEC 7): a new episode after the triggers stayed clear for the reassessment time
        const after = Math.max(s.closed_at ?? s.updated_at ?? -Infinity, blockedUntil)
        o = nextReopening(streams, s.opened_at ?? after, after, horizon, s.spec.tripwire.reassess_after_s)
      }
      if (o) {
        const clear = 'clear_since' in o ? { clear_since: o.clear_since } : {}
        apply({ type: 'OPEN', t: o.t, finding: o.finding, ...clear }, 'auto')
        if (s.status !== 'detected') {
          blockedUntil = o.t
          continue
        }
        openings.set(s.instance, o)
        onOpen?.({ key: caseKey(crewId, def.id), caseId: def.id, crewId, t: o.t, instance: s.instance })
        const scripted = input.script?.(o, s.instance, usedEpisodes) ?? []
        if (scripted.length) {
          const rest = queue.splice(qi)
          for (const e of scripted) rest.push({ ...e, seq: seq++ })
          queue.push(...sortEvents(rest))
        }
        continue
      }
    }
    if (!next) break
    qi++
    // The simulated crew acts only on the instance its actions were written for, and never on a closed case.
    if (next.origin === 'scenario' && ((next.instance !== undefined && next.instance !== s.instance) || closedOrIdle())) continue
    apply(next.event, next.origin)
    if (next.origin === 'scenario') applied.push(next)
  }
  // Instances, oldest first: the closed ones from the engine's previous_instances, then the current one.
  const instances: InstanceView[] = []
  for (const p of s.previous_instances) {
    const o = openings.get(p.instance) ?? null
    instances.push({ instance: p.instance, status: p.status, opened_at: p.opened_at, closed_at: p.closed_at, opening: o, chance: singleFlagNote(streams, o, p.closed_at ?? tNow) })
  }
  if (s.status !== 'idle') {
    const o = openings.get(s.instance) ?? null
    instances.push({ instance: s.instance, status: s.status, opened_at: s.opened_at, closed_at: s.closed_at, opening: o, chance: singleFlagNote(streams, o, s.closed_at ?? tNow) })
  }
  return { state: s, logOrigins: origins, instances, applied }
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

export interface CaseSchedule {
  /** First opening per case and crewmember over all the data (instance 1), independent of the clock. */
  openings: Map<string, Opening>
  /** Trigger streams per case and crewmember (findings memoized across folds). */
  streams: Map<string, TriggerStream[]>
  /** Seeded crew actions per instance opening (memoized). */
  script: (key: string, open: Opening, instance: number, usedEpisodes: Set<string>) => Scripted[]
  /** The seeded crew actions the scenario alone applies up to its "now" (no user events). */
  events: CaseEventRecord[]
  /** The seeded crew's answers as observations (scriptedAnswers of `events`). */
  answers: Observation[]
}

function tripwireFor(def: CaseDef, crewId: CrewId, index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId): Observation[] {
  const cond = newCase(def, crewId, LOOKUP, envId, ESCALATION).spec.tripwire.condition
  return observationsFor(index, runtime, crewId, cond.variable).filter((o) => (o.crew_id === null || o.crew_id === crewId) && o.unit === cond.unit)
}

/** Detection + script for one (data, env): independent of the clock, so it can be cached. */
export function caseSchedule(index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, eva = false): CaseSchedule {
  const streams = new Map<string, TriggerStream[]>()
  const openings = new Map<string, Opening>()
  for (const crewId of CREW_IDS) {
    for (const def of CASE_DEFS) {
      const key = caseKey(crewId, def.id)
      const st = triggerStreams(def, crewId, index, runtime, envId, eva)
      streams.set(key, st)
      const o = nextOpening(st, null, Infinity)
      if (o) openings.set(key, o)
    }
  }
  const memo = new Map<string, { events: Scripted[]; episode: string | null }>()
  const script = (key: string, open: Opening, instance: number, usedEpisodes: Set<string>): Scripted[] => {
    const parsed = parseCaseKey(key)
    const def = parsed ? CASE_DEFS.find((c) => c.id === parsed.caseId) : undefined
    if (!parsed || !def) return []
    const m = `${key}|${open.t}|${instance}|${[...usedEpisodes].sort().join(',')}`
    let hit = memo.get(m)
    if (!hit) {
      const before = new Set(usedEpisodes)
      const events = instanceScript({ def, crewId: parsed.crewId, key, instance, open, index, runtime, streams: streams.get(key) ?? [] }, usedEpisodes)
      hit = { events, episode: [...usedEpisodes].find((e) => !before.has(e)) ?? null }
      memo.set(m, hit)
    } else if (hit.episode) usedEpisodes.add(hit.episode)
    return hit.events
  }
  // The scenario alone, up to its "now": which seeded actions apply (their answers reach the ground packet).
  const events: CaseEventRecord[] = []
  for (const crewId of CREW_IDS) {
    for (const def of CASE_DEFS) {
      const key = caseKey(crewId, def.id)
      const st = streams.get(key) ?? []
      if (!openings.has(key)) continue
      const r = foldCase({
        def,
        crewId,
        events: [],
        tripwireObs: tripwireFor(def, crewId, index, runtime, envId),
        tNow: index.nowMet,
        streams: st,
        script: (o, k, used) => script(key, o, k, used),
        envId,
      })
      events.push(...r.applied)
    }
  }
  return { openings, streams, script, events, answers: scriptedAnswers(events, index) }
}

/** Every crewmember x case, folded at input.t. */
export function computeCases(input: CaseTimelineInput, schedule = caseSchedule(input.index, input.runtime, input.envId, input.eva), onOpen?: OpenHook): CaseView[] {
  const out: CaseView[] = []
  for (const crewId of CREW_IDS) {
    for (const def of CASE_DEFS) {
      const key = caseKey(crewId, def.id)
      const r = foldCase({
        def,
        crewId,
        events: input.userEvents.filter((e) => e.key === key),
        tripwireObs: tripwireFor(def, crewId, input.index, input.runtime, input.envId),
        tNow: input.t,
        streams: schedule.streams.get(key) ?? [],
        script: (o, k, used) => schedule.script(key, o, k, used),
        onOpen,
        envId: input.envId,
      })
      const current = r.instances.length && r.state.status !== 'idle' ? r.instances[r.instances.length - 1] : null
      out.push({
        key,
        crewId,
        caseId: def.id,
        def,
        state: r.state,
        logOrigins: r.logOrigins,
        opening: schedule.openings.get(key) ?? null,
        instances: r.instances,
        chance: current?.chance ?? null,
        tier1: tierOneFor(crewId),
      })
    }
  }
  return out
}
