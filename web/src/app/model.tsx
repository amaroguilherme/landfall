// Mission model hooks: the real engine wired to the scenario. Pure logic lives in
// scenarioData.ts (observations), evaluate.ts (findings, alerts) and caseTimeline.ts (cases);
// this file caches it per input and exposes React hooks. Documented in app/README.md.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { buildGroundPacket, consentAllows } from './engine'
import type { CaseEvent, CaseState, Consent, FhirBundle } from './engine'
import { caseKey, caseSchedule, computeCases, tierOneFor } from './caseTimeline'
import type { CaseEventRecord, CaseView } from './caseTimeline'
import { procedureAlerts } from './procedureAlerts'
import { useSnapshot } from './data'
import type { LoadStatus, SnapshotState } from './data'
import { evaluateMission } from './evaluate'
import type { CrewEvaluation, MissionEvaluation } from './evaluate'
import { caseClockOf, metClock, useMetMinute, useMission } from './mission'
import { buildScenarioIndex, visibleObservations } from './scenarioData'
import type { ScenarioIndex, SimCrewData, SpeReplayData } from './scenarioData'
import type { CrewId, EnvId, Observation } from './vocab'

// =============================================================================================
// Scenario (sim_crew + the October 1989 replay), built once per loaded payload
// =============================================================================================

export interface ScenarioState {
  /** 'ready' once sim_crew is ready and the replay has settled (ready, missing or error). */
  status: LoadStatus
  index: ScenarioIndex | null
  sim: SnapshotState<SimCrewData>
  replay: SnapshotState<SpeReplayData>
  error: string | null
}

let indexCache: { sim: unknown; replay: unknown; index: ScenarioIndex } | null = null

function indexFor(sim: SimCrewData, replay: SpeReplayData | null): ScenarioIndex {
  if (indexCache && indexCache.sim === sim && indexCache.replay === replay) return indexCache.index
  const index = buildScenarioIndex(sim, replay)
  indexCache = { sim, replay, index }
  return index
}

/** `const { status, index } = useScenario()`: the simulated scenario as SPEC 4 observations. */
export function useScenario(): ScenarioState {
  const sim = useSnapshot<SimCrewData>('sim_crew')
  const replay = useSnapshot<SpeReplayData>('swpc_spe_replay')
  const settled = replay.status !== 'loading'
  return useMemo(() => {
    if (sim.status !== 'ready' || !sim.data) {
      return { status: sim.status, index: null, sim, replay, error: sim.error }
    }
    if (!settled) return { status: 'loading', index: null, sim, replay, error: null }
    try {
      const index = indexFor(sim.data, replay.status === 'ready' ? replay.data : null)
      return { status: 'ready', index, sim, replay, error: null }
    } catch (e) {
      return { status: 'error', index: null, sim, replay, error: (e as Error).message }
    }
  }, [sim, replay, settled])
}

// =============================================================================================
// Evaluation (cached: one computation per (scenario, runtime observations, env, MET minute))
// =============================================================================================

let evalCache: { index: ScenarioIndex; runtime: readonly Observation[]; envId: EnvId; t: number; result: MissionEvaluation } | null = null

export function cachedEvaluation(index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, t: number): MissionEvaluation {
  const c = evalCache
  if (c && c.index === index && c.runtime === runtime && c.envId === envId && c.t === t) return c.result
  const result = evaluateMission(index, runtime, envId, t)
  evalCache = { index, runtime, envId, t, result }
  return result
}

export interface EvaluationState {
  status: LoadStatus
  /** null until the scenario is ready. */
  evaluation: MissionEvaluation | null
  envId: EnvId
  /** Evaluation MET (the scenario clock floored to the minute). */
  t: number
  error: string | null
}

/**
 * `const { status, evaluation } = useEvaluation()`: every crewmember's Tier A / Tier B findings,
 * the OPS feed and the annunciator alerts, for the store's environment at the scenario clock.
 * Store observations (Noon Sight, manual entries) are included; switching environment re-evaluates.
 */
export function useEvaluation(): EvaluationState {
  const { state } = useMission()
  const scenario = useScenario()
  const t = useMetMinute()
  const envId = state.envId
  const runtime = state.observations
  return useMemo(() => {
    if (!scenario.index) return { status: scenario.status, evaluation: null, envId, t, error: scenario.error }
    try {
      return { status: 'ready', evaluation: cachedEvaluation(scenario.index, runtime, envId, t), envId, t, error: null }
    } catch (e) {
      return { status: 'error', evaluation: null, envId, t, error: (e as Error).message }
    }
  }, [scenario, runtime, envId, t])
}

/** One crewmember's findings (default: the store's selected crewmember), or null while loading. */
export function useCrewEvaluation(crewId?: CrewId): CrewEvaluation | null {
  const { state } = useMission()
  const { evaluation } = useEvaluation()
  return evaluation ? evaluation.crew[crewId ?? state.crewId] : null
}

// =============================================================================================
// Hero timing: SPE OPEN processed -> hero painted (measured in this browser, never simulated)
// =============================================================================================

export interface HeroTiming {
  /** performance.now() when the first spe_shelter OPEN was processed by caseReduce in this page. */
  speOpenProcessedAtMs: number | null
  /** performance.now() when markHeroReady() was first called (the hero painted its countermeasure). */
  heroReadyAtMs: number | null
  /** heroReadyAtMs - speOpenProcessedAtMs, in ms (null until both exist). */
  answerMs: number | null
}

let heroTiming: HeroTiming = { speOpenProcessedAtMs: null, heroReadyAtMs: null, answerMs: null }
const heroListeners = new Set<() => void>()

function setHeroTiming(next: HeroTiming): void {
  heroTiming = next
  for (const l of heroListeners) l()
}

function recordSpeOpen(): void {
  if (heroTiming.speOpenProcessedAtMs !== null || typeof performance === 'undefined') return
  // Recorded during the fold (render phase): plain module state, listeners are told after paint.
  heroTiming = { ...heroTiming, speOpenProcessedAtMs: performance.now() }
}

/**
 * Call once the Now route has PAINTED its hero (the primary countermeasure is on screen).
 * Sets <html data-hero-ready-ms> (rounded performance.now()), plus data-spe-open-ms and
 * data-hero-answer-ms when the SPE OPEN was processed in this page. First call wins.
 */
export function markHeroReady(): void {
  if (heroTiming.heroReadyAtMs !== null || typeof performance === 'undefined') return
  const now = performance.now()
  const open = heroTiming.speOpenProcessedAtMs
  const root = typeof document !== 'undefined' ? document.documentElement : null
  if (root) {
    root.dataset.heroReadyMs = String(Math.round(now))
    if (open !== null) {
      root.dataset.speOpenMs = String(Math.round(open))
      root.dataset.heroAnswerMs = String(Math.round(now - open))
    }
  }
  setHeroTiming({ speOpenProcessedAtMs: open, heroReadyAtMs: now, answerMs: open !== null ? now - open : null })
}

/** Calls markHeroReady() after the browser paints, the first time `ready` is true. */
export function useMarkHeroReady(ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => markHeroReady())
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [ready])
}

/** `{ speOpenProcessedAtMs, heroReadyAtMs, answerMs }`, re-rendering when the measurement lands. */
export function useHeroTiming(): HeroTiming {
  return useSyncExternalStore(
    (l) => {
      heroListeners.add(l)
      return () => heroListeners.delete(l)
    },
    () => heroTiming,
    () => heroTiming,
  )
}

// =============================================================================================
// Cases
// =============================================================================================

let scheduleCache: { index: ScenarioIndex; runtime: readonly Observation[]; envId: EnvId; result: ReturnType<typeof caseSchedule> } | null = null

function cachedSchedule(index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId) {
  const c = scheduleCache
  if (c && c.index === index && c.runtime === runtime && c.envId === envId) return c.result
  const result = caseSchedule(index, runtime, envId)
  scheduleCache = { index, runtime, envId, result }
  return result
}

const onOpen = (v: { caseId: string }) => {
  if (v.caseId === 'spe_shelter') recordSpeOpen()
}

// One fold per (scenario, runtime observations, env, fold MET, user events): every useCases() caller in a render
// (the App-level ProcedureAlerts publisher, the hero, a case page) shares it instead of folding again.
let casesCache: {
  index: ScenarioIndex
  runtime: readonly Observation[]
  envId: EnvId
  t: number
  userEvents: readonly CaseEventRecord[]
  result: CaseView[]
} | null = null

function cachedCases(index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, t: number, userEvents: readonly CaseEventRecord[]): CaseView[] {
  const c = casesCache
  if (c && c.index === index && c.runtime === runtime && c.envId === envId && c.t === t && c.userEvents === userEvents) return c.result
  const result = computeCases({ index, runtime, envId, t, userEvents }, cachedSchedule(index, runtime, envId), onOpen)
  casesCache = { index, runtime, envId, t, userEvents, result }
  return result
}

/** A case event as features dispatch it: t defaults to the scenario clock. */
export type CaseEventInput = CaseEvent extends infer E ? (E extends { t: number } ? Omit<E, 't'> & { t?: number } : never) : never

export interface CasesState {
  status: LoadStatus
  /** Every crewmember x case (12 views), folded at `t`; idle ones included. */
  cases: CaseView[]
  /**
   * The seeded crew's answers as observations (caseTimeline scriptedAnswers: e.g. the renal red-flag answer
   * "no" as 0, unit yes/no), all times; filter by t. The ground packet includes them like a user's logged answer.
   */
  scripted: Observation[]
  /** The view for one crewmember's case (default crewmember: the store's). */
  get: (caseId: string, crewId?: CrewId) => CaseView | null
  /** Append a user event for one crewmember's case; t defaults to the scenario clock. */
  dispatch: (caseId: string, event: CaseEventInput, crewId?: CrewId) => void
  /** Drop every user event, runtime observation, Noon Sight and log entry; clock back to "now". */
  resetScenario: () => void
  /** Fold MET: the clock minute, or the latest user event when that is later. */
  t: number
  error: string | null
}

let seq = 0

/**
 * `const { cases, get, dispatch, resetScenario } = useCases()`.
 * States are caseReduce folds of: auto OPEN (from the engine's findings), the seeded simulated
 * crew actions, user events and synthesized tripwire TICKs. Rejected user events stay in
 * state.log with `error` set (engine behaviour), so the UI can show why.
 */
export function useCases(): CasesState {
  const { state, addCaseEvent, resetScenario } = useMission()
  const scenario = useScenario()
  const minute = useMetMinute()
  const userEvents = state.caseEvents
  const runtime = state.observations
  const envId = state.envId
  const crewId = state.crewId
  // the case clock (mission.tsx caseClockOf, also read alone by useCaseClock): the minute, or a later user event
  const tFold = caseClockOf(minute, userEvents, metClock.get().metNow)
  const result = useMemo(() => {
    if (!scenario.index) return { status: scenario.status, cases: [] as CaseView[], scripted: [] as Observation[], error: scenario.error }
    try {
      const schedule = cachedSchedule(scenario.index, runtime, envId)
      const cases = cachedCases(scenario.index, runtime, envId, tFold, userEvents)
      return { status: 'ready' as LoadStatus, cases, scripted: schedule.answers, error: null }
    } catch (e) {
      return { status: 'error' as LoadStatus, cases: [] as CaseView[], scripted: [] as Observation[], error: (e as Error).message }
    }
  }, [scenario, runtime, envId, tFold, userEvents])
  return useMemo(
    () => ({
      ...result,
      t: tFold,
      get: (caseId: string, c?: CrewId) => result.cases.find((v) => v.caseId === caseId && v.crewId === (c ?? crewId)) ?? null,
      dispatch: (caseId: string, event: CaseEventInput, c?: CrewId) => {
        const t = event.t ?? metClock.get().metNow
        const record: CaseEventRecord = { key: caseKey(c ?? crewId, caseId), event: { ...event, t } as CaseEvent, origin: 'user', seq: seq++ }
        addCaseEvent(record)
      },
      resetScenario,
    }),
    [result, tFold, crewId, addCaseEvent, resetScenario],
  )
}

// =============================================================================================
// Ground packet
// =============================================================================================

export interface GroundPacketState {
  status: LoadStatus
  /** FHIR R4 Bundle (collection) from the engine's buildGroundPacket, or null. */
  bundle: FhirBundle | null
  caseView: CaseView | null
  caseState: CaseState | null
  /** True once the case has been opened (status other than idle). */
  caseOpen: boolean
  /** The consent map used (store consent of that crewmember). */
  consent: Consent
  /** Escalation variables the consent keeps off the ground (e.g. mood unless shared). */
  withheld: string[]
  /** sim_crew data.calendar.met_epoch_utc, turned into effectiveDateTime by the engine. */
  missionEpoch: string | null
  t: number
  error: string | null
}

/**
 * `const { bundle, withheld } = useGroundPacket('spe_shelter')` for the store's crewmember
 * (or pass crewId). Observations: scenario + runtime, up to the clock; consent from the store
 * (mood is private unless shared).
 */
export function useGroundPacket(caseId: string, crewId?: CrewId): GroundPacketState {
  const { state } = useMission()
  const cases = useCases()
  const scenario = useScenario()
  const who = crewId ?? state.crewId
  const consent = state.consent[who]
  const view = cases.get(caseId, who)
  const t = cases.t
  const runtime = state.observations
  const scripted = cases.scripted
  const envId = state.envId
  return useMemo(() => {
    const base = { caseView: view, caseState: view?.state ?? null, caseOpen: !!view && view.state.status !== 'idle', consent, t }
    const wanted = view?.state.spec.escalation?.observations ?? []
    const withheld = wanted.filter((v) => !consentAllows(v, consent))
    if (!scenario.index || !view) {
      return { ...base, status: scenario.status === 'ready' ? 'error' : scenario.status, bundle: null, withheld, missionEpoch: null, error: view ? scenario.error : `no case ${caseId}` }
    }
    try {
      // Runtime entries plus the seeded crew's answers (caseTimeline scriptedAnswers), up to the clock.
      const obs = visibleObservations(scenario.index, scripted.length ? [...runtime, ...scripted] : runtime, t)
      const bundle = buildGroundPacket(view.state, obs, consent, envId, t, scenario.index.epochIso)
      return { ...base, status: 'ready' as LoadStatus, bundle, withheld, missionEpoch: scenario.index.epochIso, error: null }
    } catch (e) {
      return { ...base, status: 'error' as LoadStatus, bundle: null, withheld, missionEpoch: scenario.index.epochIso, error: (e as Error).message }
    }
  }, [view, consent, t, scenario, runtime, scripted, envId, caseId])
}

// =============================================================================================
// Publishers: the engine's alerts and the return-to-procedure entries drive the mission-bar annunciator
// =============================================================================================

/** Mount once inside <MissionProvider>: publishes the evaluation's alerts under source 'mission'. */
export function MissionEngine() {
  const { publishAlerts } = useMission()
  const { evaluation } = useEvaluation()
  const last = useRef<string>('')
  useEffect(() => {
    if (!evaluation) return
    const sig = JSON.stringify(evaluation.alerts.map((a) => [a.id, a.severity, a.title]))
    if (sig === last.current) return
    last.current = sig
    publishAlerts('mission', evaluation.alerts)
  }, [evaluation, publishAlerts])
  return null
}

/** Signature of an empty list: an empty procedure list is never published first, so it cannot mark the bar "evaluated". */
const NO_PROCEDURE_ALERTS = '[]'

/**
 * Mount once inside <MissionProvider>, next to <MissionEngine/>: publishes the return-to-procedure entries
 * (procedureAlerts.ts: a reassessment overdue, a new escalation) under source 'procedures', from the same case
 * fold every view reads. The same signature guard as MissionEngine: it publishes only when the list changes,
 * so publishing (which re-renders it) cannot loop.
 */
export function ProcedureAlerts() {
  const { publishAlerts } = useMission()
  const scenario = useScenario()
  const cases = useCases()
  const nowMet = scenario.index?.nowMet ?? null
  const alerts = useMemo(() => {
    if (cases.status !== 'ready' || nowMet === null) return null
    try {
      return procedureAlerts({ cases: cases.cases, t: cases.t, nowMet, tierOneFor })
    } catch (e) {
      // Mounted beside the routes, outside any of them: a failure here must never blank the app (the hero). The
      // last published list stays; the error is logged so the QA console sweep catches it.
      console.error('procedure alerts:', e)
      return null
    }
  }, [cases.status, cases.cases, cases.t, nowMet])
  const last = useRef<string>(NO_PROCEDURE_ALERTS)
  useEffect(() => {
    if (!alerts) return
    const sig = JSON.stringify(alerts)
    if (sig === last.current) return
    last.current = sig
    publishAlerts('procedures', alerts)
  }, [alerts, publishAlerts])
  return null
}
