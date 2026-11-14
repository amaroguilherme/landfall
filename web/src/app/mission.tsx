// Mission store: React context + reducer for mission-wide state, plus a separate MET clock
// store (useSyncExternalStore) so the once-per-second tick re-renders only clock readers.
import { createContext, useContext, useMemo, useReducer, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_CREW, DEFAULT_ENV, MET_NOW_S, environment } from './scenario'
import type { Environment } from './scenario'
import type { CaseState, Consent, Finding } from './engine'
import { CREW_IDS, SEVERITY_RANK, crewMember } from './vocab'
import type { Category, CrewId, CrewMember, EnvId, Observation, Severity } from './vocab'

// =============================================================================================
// MET clock (ticks once per second from the scenario "now"; can be paused, set, re-anchored)
// =============================================================================================

interface ClockSnapshot {
  /** Current MET in integer seconds. */
  metNow: number
  running: boolean
}

let anchorMet = MET_NOW_S
let anchorWall = Date.now()
let clock: ClockSnapshot = { metNow: MET_NOW_S, running: true }
const clockListeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

function computeMet(): number {
  return clock.running ? anchorMet + Math.floor((Date.now() - anchorWall) / 1000) : anchorMet
}

function publishClock(next: ClockSnapshot): void {
  if (next.metNow === clock.metNow && next.running === clock.running) return
  clock = next
  for (const l of clockListeners) l()
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (!clock.running || clockListeners.size === 0) return
  const elapsedMs = Date.now() - anchorWall
  const wait = 1000 - (elapsedMs % 1000) + 5
  timer = setTimeout(() => {
    publishClock({ metNow: computeMet(), running: clock.running })
    schedule()
  }, wait)
}

function subscribeClock(l: () => void): () => void {
  clockListeners.add(l)
  if (clockListeners.size === 1) {
    publishClock({ metNow: computeMet(), running: clock.running })
    schedule()
  }
  return () => {
    clockListeners.delete(l)
    if (clockListeners.size === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

export const metClock = {
  get: (): ClockSnapshot => clock,
  pause(): void {
    anchorMet = computeMet()
    anchorWall = Date.now()
    publishClock({ metNow: anchorMet, running: false })
    schedule()
  },
  resume(): void {
    anchorWall = Date.now()
    publishClock({ metNow: anchorMet, running: true })
    schedule()
  },
  /** Jump the clock to a MET (seconds); keeps the running/paused state. */
  set(t: number): void {
    anchorMet = Math.floor(t)
    anchorWall = Date.now()
    publishClock({ metNow: anchorMet, running: clock.running })
    schedule()
  },
  /** Back to the scenario "now" (MET 0412/14:20:00), running. */
  reset(): void {
    anchorMet = MET_NOW_S
    anchorWall = Date.now()
    publishClock({ metNow: MET_NOW_S, running: true })
    schedule()
  },
}

/** Current MET in seconds; re-renders the caller once per second while running. */
export function useMetNow(): number {
  return useSyncExternalStore(subscribeClock, () => clock.metNow, () => MET_NOW_S)
}

/** Clock state plus controls. */
export function useMetClock(): ClockSnapshot & {
  pause: () => void
  resume: () => void
  set: (t: number) => void
  reset: () => void
} {
  const snap = useSyncExternalStore(subscribeClock, () => clock, () => clock)
  return { ...snap, pause: metClock.pause, resume: metClock.resume, set: metClock.set, reset: metClock.reset }
}

// =============================================================================================
// Mission state
// =============================================================================================

/** Variables a crewmember can share with the ground. Mood is private by default (SPEC 7). */
export const SHAREABLE_VARIABLES = [
  'pvt_lapses',
  'pvt_median_rt',
  'sleep_duration',
  'sleep_midpoint_shift',
  'light_exposure_daytime',
  'resting_hr',
  'hrv_sdnn',
  'skin_temp',
  'urine_volume_24h',
  'fluid_intake_24h',
  'vo2max',
  'proton_flux_10mev',
  'mood',
] as const

export function defaultConsent(): Consent {
  const c: Consent = {}
  for (const v of SHAREABLE_VARIABLES) c[v] = v !== 'mood'
  return c
}

/** Sharing decision for one variable. Unknown variables default to shared, except mood. */
export function isShared(consent: Consent, variable: string): boolean {
  if (variable in consent) return consent[variable] === true
  return variable !== 'mood'
}

export interface LogEntry {
  id: string
  /** MET seconds. */
  t: number
  crew_id: CrewId | 'ALL'
  kind: 'note' | 'measurement' | 'case' | 'countermeasure' | 'outcome' | 'downlink' | 'system' | string
  text: string
  case_id?: string | null
}

export interface NoonSightResult {
  id: string
  crew_id: CrewId
  /** MET seconds when the check was completed. */
  t: number
  /** Measurements produced by the check (PVT-B, mood, ...), SPEC section 4 shape. */
  observations: Observation[]
  /** Feature-specific details (e.g. PVT trial reaction times). */
  details?: Record<string, unknown>
}

/** One entry in the annunciator queue. Features publish these; the mission bar counts them. */
export interface AlertItem {
  /** Stable id, e.g. `${crew_id}:${rule_id}`. Used for acknowledgement. */
  id: string
  severity: Severity
  /** Plain-language title, e.g. "Proton flux at S3: shelter recommended". */
  title: string
  crew_id?: CrewId | 'ALL'
  category?: Category
  /** Hash route for "open", e.g. "#/case/spe_shelter". */
  href?: string
  /** MET seconds when it was raised. */
  t?: number
}

export interface MissionState {
  envId: EnvId
  crewId: CrewId
  /** Per-crewmember, per-variable sharing flags (What Houston sees). */
  consent: Record<CrewId, Consent>
  /** Observations added at runtime (manual entry, Noon Sight, band replay ...). */
  observations: Observation[]
  logbook: LogEntry[]
  noonSights: NoonSightResult[]
  /** Published alert lists, keyed by publisher (e.g. "now", "cases"). */
  alerts: Record<string, AlertItem[]>
  /** Acknowledged alert ids -> MET of acknowledgement. */
  acknowledged: Record<string, number>
  /** Case state machines (engine caseReduce output), keyed by `${crew_id}:${case_id}` or case id. */
  cases: Record<string, CaseState>
}

export type MissionAction =
  | { type: 'setEnv'; envId: EnvId }
  | { type: 'setCrew'; crewId: CrewId }
  | { type: 'setConsent'; crewId: CrewId; variable: string; shared: boolean }
  | { type: 'addObservations'; observations: Observation[] }
  | { type: 'addLog'; entry: LogEntry }
  | { type: 'addNoonSight'; result: NoonSightResult }
  | { type: 'publishAlerts'; source: string; alerts: AlertItem[] }
  | { type: 'acknowledge'; ids: string[]; t: number }
  | { type: 'setCase'; key: string; state: CaseState }
  | { type: 'reset' }

export function initialMissionState(): MissionState {
  const consent = {} as Record<CrewId, Consent>
  for (const id of CREW_IDS) consent[id] = defaultConsent()
  return {
    envId: DEFAULT_ENV,
    crewId: DEFAULT_CREW,
    consent,
    observations: [],
    logbook: [],
    noonSights: [],
    alerts: {},
    acknowledged: {},
    cases: {},
  }
}

export function missionReducer(state: MissionState, action: MissionAction): MissionState {
  switch (action.type) {
    case 'setEnv':
      return state.envId === action.envId ? state : { ...state, envId: action.envId }
    case 'setCrew':
      return state.crewId === action.crewId ? state : { ...state, crewId: action.crewId }
    case 'setConsent':
      return {
        ...state,
        consent: {
          ...state.consent,
          [action.crewId]: { ...state.consent[action.crewId], [action.variable]: action.shared },
        },
      }
    case 'addObservations':
      return action.observations.length ? { ...state, observations: [...state.observations, ...action.observations] } : state
    case 'addLog':
      return { ...state, logbook: [...state.logbook, action.entry] }
    case 'addNoonSight':
      return {
        ...state,
        noonSights: [...state.noonSights, action.result],
        observations: [...state.observations, ...action.result.observations],
      }
    case 'publishAlerts':
      return { ...state, alerts: { ...state.alerts, [action.source]: action.alerts } }
    case 'acknowledge': {
      const acknowledged = { ...state.acknowledged }
      for (const id of action.ids) acknowledged[id] = action.t
      return { ...state, acknowledged }
    }
    case 'setCase':
      return { ...state, cases: { ...state.cases, [action.key]: action.state } }
    case 'reset':
      return initialMissionState()
    default:
      return state
  }
}

// ---------------------------------------------------------------------------------------------
// Selectors (pure; usable outside React and in tests)
// ---------------------------------------------------------------------------------------------

export const selectEnv = (s: MissionState): Environment => environment(s.envId)
export const selectCrew = (s: MissionState): CrewMember => crewMember(s.crewId)
export const selectConsent = (s: MissionState, crewId: CrewId = s.crewId): Consent => s.consent[crewId]

export function selectObservations(
  s: MissionState,
  filter: { crewId?: CrewId; variable?: string } = {},
): Observation[] {
  return s.observations.filter(
    (o) => (!filter.crewId || o.crew_id === filter.crewId) && (!filter.variable || o.variable === filter.variable),
  )
}

export function selectLogbook(s: MissionState, crewId?: CrewId): LogEntry[] {
  return crewId ? s.logbook.filter((e) => e.crew_id === crewId || e.crew_id === 'ALL') : s.logbook
}

/** All published alerts above nominal, de-duplicated by id, most severe first. */
export function selectAlerts(s: MissionState): AlertItem[] {
  const byId = new Map<string, AlertItem>()
  for (const list of Object.values(s.alerts)) {
    for (const a of list) {
      if (a.severity === 'nominal') continue
      const prev = byId.get(a.id)
      if (!prev || SEVERITY_RANK[a.severity] > SEVERITY_RANK[prev.severity]) byId.set(a.id, a)
    }
  }
  return [...byId.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.title.localeCompare(b.title),
  )
}

export interface AnnunciatorCounts {
  emergency: number
  warning: number
  caution: number
  advisory: number
  /** Alerts not yet acknowledged (F.6.4 d "Unacknowledged/New Event Count"). */
  unacknowledged: number
  /** False until at least one publisher has reported (then 0 means "evaluated, none"). */
  evaluated: boolean
}

export function selectAnnunciator(s: MissionState): AnnunciatorCounts {
  const alerts = selectAlerts(s)
  const count = (sev: Severity) => alerts.filter((a) => a.severity === sev).length
  return {
    // LANDFALL never raises Emergency-class alarms (SPEC 1.5); counted anyway for honesty.
    emergency: count('emergency'),
    warning: count('warning'),
    caution: count('caution'),
    advisory: count('advisory'),
    unacknowledged: alerts.filter((a) => !(a.id in s.acknowledged)).length,
    evaluated: Object.keys(s.alerts).length > 0,
  }
}

/** Map an engine Finding to an annunciator entry. */
export function alertFromFinding(
  f: Finding,
  extra: { title: string; crew_id?: CrewId | 'ALL'; href?: string; t?: number; id?: string },
): AlertItem {
  return {
    id: extra.id ?? `${extra.crew_id ?? 'ALL'}:${f.rule_id}`,
    severity: f.severity,
    title: extra.title,
    crew_id: extra.crew_id,
    category: f.category,
    href: extra.href,
    t: extra.t,
  }
}

// ---------------------------------------------------------------------------------------------
// React context
// ---------------------------------------------------------------------------------------------

export interface MissionActions {
  setEnv: (envId: EnvId) => void
  setCrew: (crewId: CrewId) => void
  setConsent: (crewId: CrewId, variable: string, shared: boolean) => void
  addObservations: (observations: Observation[]) => void
  addLog: (entry: Omit<LogEntry, 'id'> & { id?: string }) => void
  addNoonSight: (result: Omit<NoonSightResult, 'id'> & { id?: string }) => void
  /** Replace the alert list of one publisher. Pass [] to clear it. */
  publishAlerts: (source: string, alerts: AlertItem[]) => void
  acknowledge: (ids: string[]) => void
  setCase: (key: string, state: CaseState) => void
  reset: () => void
}

interface MissionContextValue extends MissionActions {
  state: MissionState
  dispatch: (a: MissionAction) => void
}

const MissionContext = createContext<MissionContextValue | null>(null)

let idSeq = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`

export function MissionProvider({ children, initial }: { children: ReactNode; initial?: Partial<MissionState> }) {
  const [state, dispatch] = useReducer(missionReducer, undefined, () => ({ ...initialMissionState(), ...initial }))
  const actions = useMemo<MissionActions>(
    () => ({
      setEnv: (envId) => dispatch({ type: 'setEnv', envId }),
      setCrew: (crewId) => dispatch({ type: 'setCrew', crewId }),
      setConsent: (crewId, variable, shared) => dispatch({ type: 'setConsent', crewId, variable, shared }),
      addObservations: (observations) => dispatch({ type: 'addObservations', observations }),
      addLog: (entry) => dispatch({ type: 'addLog', entry: { ...entry, id: entry.id ?? nextId('log') } }),
      addNoonSight: (result) => dispatch({ type: 'addNoonSight', result: { ...result, id: result.id ?? nextId('noon') } }),
      publishAlerts: (source, alerts) => dispatch({ type: 'publishAlerts', source, alerts }),
      acknowledge: (ids) => dispatch({ type: 'acknowledge', ids, t: metClock.get().metNow }),
      setCase: (key, caseState) => dispatch({ type: 'setCase', key, state: caseState }),
      reset: () => {
        dispatch({ type: 'reset' })
        metClock.reset()
      },
    }),
    [],
  )
  const value = useMemo(() => ({ state, dispatch, ...actions }), [state, actions])
  return <MissionContext.Provider value={value}>{children}</MissionContext.Provider>
}

/** `const { state, setEnv, publishAlerts, ... } = useMission()` */
export function useMission(): MissionContextValue {
  const ctx = useContext(MissionContext)
  if (!ctx) throw new Error('useMission() must be used inside <MissionProvider>')
  return ctx
}
