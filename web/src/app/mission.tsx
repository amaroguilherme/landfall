// Mission store: React context + reducer for mission-wide state, plus a separate MET clock
// store (useSyncExternalStore) so the once-per-second tick re-renders only clock readers.
import { createContext, useContext, useMemo, useReducer, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_CREW, DEFAULT_ENV, MET_NOW_S, environment } from './scenario'
import type { Environment } from './scenario'
import type { CaseState, Consent, Finding } from './engine'
import type { CaseEventRecord } from './caseTimeline'
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
  /** Back to the scenario "now" (MET 412/14:20:00), running. */
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

/** Current MET floored to the minute; re-renders the caller only when the minute changes. */
export function useMetMinute(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(clock.metNow / 60) * 60,
    () => Math.floor(MET_NOW_S / 60) * 60,
  )
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

/**
 * The case clock, `useCases().t` (app/model.tsx): the clock minute, or the latest user case event up to the clock when
 * that is later, so a crew action is applied at once, not at the next minute. Pure.
 */
export function caseClockOf(minute: number, events: readonly CaseEventRecord[], now: number): number {
  let t = minute
  for (const e of events) if (e.event.t > t && e.event.t <= now) t = e.event.t
  return t
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
  'bp_systolic',
  'bp_diastolic',
  'glucose',
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
  /** Secondary line: the rule or indicator and its status, when the title is an action label. */
  detail?: string
  /** One-line action of a finding without a deep case (rules `action.text`, D11). */
  action_text?: string
  crew_id?: CrewId | 'ALL'
  category?: Category
  /** Hash route for "open", e.g. "#/case/spe_shelter". */
  href?: string
  /** MET seconds when it was raised. */
  t?: number
  /** The case this finding is a trigger of (cases.json), or null. */
  case_id?: string | null
  /**
   * Annunciator group (D16): `${crew_id}:case:${case_id}` for case triggers of one crewmember; otherwise the
   * entry's own id. The mission bar counts and acknowledges groups. Absent = its own group.
   */
  group?: string
  /** Title of the group (the case title) when the group gathers a case's findings. */
  group_title?: string
  /**
   * 'finding' (absent = a finding: the engine's evaluation, evaluate.ts alertsFor) or 'procedure': a
   * return-to-procedure entry (procedureAlerts.ts: a reassessment overdue, a new escalation) in its case's group.
   * While a procedure entry is unacknowledged, its line reads "<group_title> · <its title>".
   */
  kind?: 'finding' | 'procedure'
  /**
   * The ids this entry stands for, when it is not its own (a crew-wide procedure entry stands for each
   * crewmember's): it counts as acknowledged when every one of them is, and acknowledging it records each one.
   * Absent = [id].
   */
  ack_ids?: string[]
}

/** The ids an acknowledgement of this entry records (its ack_ids, else its own id). */
export const ackIdsOf = (a: Pick<AlertItem, 'id' | 'ack_ids'>): string[] => (a.ack_ids && a.ack_ids.length ? a.ack_ids : [a.id])

/** True when every id the entry stands for has been acknowledged. */
export const isAcknowledged = (a: Pick<AlertItem, 'id' | 'ack_ids'>, acknowledged: Record<string, number>): boolean =>
  ackIdsOf(a).every((id) => id in acknowledged)

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
  /**
   * DEPRECATED (kept so older feature code compiles): nothing in the shell writes it any more.
   * Case states come from useCases() (app/model.tsx), a fold of caseReduce over caseEvents.
   */
  cases: Record<string, CaseState>
  /** Case events dispatched from the UI (useCases().dispatch), in-memory only. */
  caseEvents: CaseEventRecord[]
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
  | { type: 'addCaseEvent'; record: CaseEventRecord }
  | { type: 'resetScenario' }
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
    caseEvents: [],
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
    case 'addCaseEvent':
      return { ...state, caseEvents: [...state.caseEvents, action.record] }
    case 'resetScenario': {
      // Back to the seeded scenario: drop everything the user added; keep the view (env, crew) and consent.
      const fresh = initialMissionState()
      return { ...fresh, envId: state.envId, crewId: state.crewId, consent: state.consent, alerts: state.alerts }
    }
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

/** One annunciator line (D16): a case's findings for one crewmember, or a single finding. */
export interface AlertGroup {
  /** `group` of its members (`${crew_id}:case:${case_id}`), or the single member's id. */
  id: string
  /** The most severe member's severity. */
  severity: Severity
  /**
   * The case title for a case group, else the single member's title. A line with an unacknowledged procedure
   * entry (or only procedure entries) reads "<group_title> · <that entry's title>".
   */
  title: string
  crew_id?: CrewId | 'ALL'
  case_id: string | null
  href?: string
  /** Members, most severe first. */
  alerts: AlertItem[]
  /** True when every member is acknowledged. A new member makes the group new again. */
  acknowledged: boolean
}

/**
 * Alerts grouped for the annunciator (D16), most severe first: members that share `group` form one line
 * (a case's findings for one crewmember); every other alert is its own line. A procedure entry (kind
 * 'procedure') joins its case's line without changing its severity class: the counts stay, the line is new
 * again until it is acknowledged, and its title names the entry ("Sleep and circadian drift · Reassessment
 * overdue since MET 407/08:07:30").
 */
export function selectAlertGroups(s: MissionState): AlertGroup[] {
  const alerts = selectAlerts(s)
  const byKey = new Map<string, AlertItem[]>()
  for (const a of alerts) {
    const k = a.group ?? a.id
    const list = byKey.get(k)
    if (list) list.push(a)
    else byKey.set(k, [a])
  }
  const groups: AlertGroup[] = []
  for (const [id, members] of byKey) {
    const top = members[0] // selectAlerts sorts most severe first
    const many = members.length > 1
    const base = many ? (top.group_title ?? top.title) : top.title
    // the most severe unacknowledged procedure entry names the line; a line of procedure entries only always does
    const procedure =
      members.find((a) => a.kind === 'procedure' && !isAcknowledged(a, s.acknowledged)) ??
      (members.every((a) => a.kind === 'procedure') ? top : undefined)
    groups.push({
      id,
      severity: top.severity,
      title: procedure ? (procedure.group_title ? `${procedure.group_title} · ${procedure.title}` : procedure.title) : base,
      crew_id: top.crew_id,
      case_id: top.case_id ?? null,
      href: top.href,
      alerts: members,
      acknowledged: members.every((a) => isAcknowledged(a, s.acknowledged)),
    })
  }
  return groups.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.title.localeCompare(b.title))
}

export interface AnnunciatorCounts {
  emergency: number
  warning: number
  caution: number
  advisory: number
  /** Alert lines (groups, D16) not yet acknowledged (F.6.4 d "Unacknowledged/New Event Count"). */
  unacknowledged: number
  /** False until at least one publisher has reported (then 0 means "evaluated, none"). */
  evaluated: boolean
}

/** Counts per severity class of the annunciator's lines (alert groups, D16), and how many are new. */
export function selectAnnunciator(s: MissionState): AnnunciatorCounts {
  const groups = selectAlertGroups(s)
  const count = (sev: Severity) => groups.filter((g) => g.severity === sev).length
  return {
    // LANDFALL never raises Emergency-class alarms (SPEC 1.5); counted anyway for honesty.
    emergency: count('emergency'),
    warning: count('warning'),
    caution: count('caution'),
    advisory: count('advisory'),
    unacknowledged: groups.filter((g) => !g.acknowledged).length,
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
  /** DEPRECATED: use useCases().dispatch (app/model.tsx). */
  setCase: (key: string, state: CaseState) => void
  /** Append a case event (use useCases().dispatch, which fills key, t and seq). */
  addCaseEvent: (record: CaseEventRecord) => void
  /** Reset the scenario: user case events, runtime observations, Noon Sights, logbook, acks; clock back to now. */
  resetScenario: () => void
  /** Reset everything, including env, crew and consent. */
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
      addCaseEvent: (record) => dispatch({ type: 'addCaseEvent', record }),
      resetScenario: () => {
        dispatch({ type: 'resetScenario' })
        metClock.reset()
      },
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

/**
 * `useCases().t` without running the case fold: the MET every packet, tier and delivery string counts from (packet.ts
 * on the hero, the case views, Downlink). The "link resumes in ..." words of the hero and the mission bar read it
 * too, so every such phrase prints one value at every instant, also in the minute after a crew action, when the case
 * clock carries that action's seconds. The live hh:mm:ss digits stay on the second clock.
 */
export function useCaseClock(): number {
  const { state } = useMission()
  const minute = useMetMinute()
  return caseClockOf(minute, state.caseEvents, metClock.get().metNow)
}
