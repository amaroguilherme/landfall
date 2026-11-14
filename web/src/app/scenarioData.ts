// Scenario data -> SPEC section 4 observations (pure; no React). Reads the frozen simulated
// scenario /data/sim_crew.json and, after scenario "now", the REAL October 1989 GOES-7 proton
// event /data/swpc_spe_replay.json, time-shifted exactly as sim_crew documents it
// (data.spe_day.shape.mapping.replay_utc_at_met_0412_000000).
//
// Timestamps follow sim_crew data.observation_format.t_meaning: an observation's t is the MET
// second the value became AVAILABLE (end of its measurement window). A series that documents a
// different t_meaning (vehicle cabin_ppco2: "value k is the mean over [start_t + k*step,
// start_t + (k+1)*step)") is shifted to its window end, so nothing is used before it existed.
import type { CrewId, Observation, ObservationSource } from './vocab'
import { CREW_IDS } from './vocab'

const DAY_S = 86_400

// ---- snapshot shapes (only the fields read here) ----------------------------------------------

export interface SimSeries {
  unit: string
  source: string
  crew_id?: string | null
  /** Per-sample MET seconds, or start_t + i * step_s. */
  t?: number[]
  start_t?: number
  step_s?: number
  n?: number
  /** Documented per series when it differs from observation_format.t_meaning. */
  t_meaning?: string
  v: Array<number | null>
  /** Replay continuation after "now" (never an observation at "now"). */
  after_now?: { start_t: number; step_s: number; n?: number; v: Array<number | null> }
}

export interface SimCrewData {
  met: { day_s: number; first_day: number; last_day: number; baseline_days: [number, number]; now_met_s: number; now: string }
  calendar: { met_epoch_utc: string; now_utc?: string; window_met?: { start_met_s: number; stop_met_s: number } }
  variables: Record<string, { unit: string; source: string; label?: string; cadence?: string; definition?: string; private?: boolean }>
  crew: Array<{ crew_id: string; role?: string; series: Record<string, SimSeries>; intraday?: Record<string, SimSeries> }>
  vehicle: { series: Record<string, SimSeries> }
  spe_day?: { met_day?: number; shape?: { mapping?: { replay_utc_at_met_0412_000000?: string; replay_utc_of_first_s3_sample?: string } } }
  episodes?: Array<{ id: string; case_id: string; crew_id: string; summary?: string }>
  ffd_demo?: { crew_id: string; variable: string; value: number; unit: string; t: number }
}

export interface SpeReplayData {
  unit: string
  series_ge10mev: { start: string; step_s: number; n: number; values: Array<number | null> }
}

// ---- index -------------------------------------------------------------------------------------

/** Key of one observation series: `${crew_id}|${variable}`, crew_id '' for a vehicle sensor. */
export type SeriesKey = string
export const seriesKey = (crewId: string | null | undefined, variable: string): SeriesKey => `${crewId ?? ''}|${variable}`

export interface ScenarioIndex {
  /** sim_crew data.calendar.met_epoch_utc (UTC of MET 0). */
  epochIso: string
  /** sim_crew data.met.now_met_s (MET 0412/14:20:00). */
  nowMet: number
  /** Fixed Tier B baseline, MET days [first, last] inclusive (SPEC 7: 368-381). */
  baselineDays: [number, number]
  firstDay: number
  lastDay: number
  /** Observations by series key, sorted by t (scenario + replay; runtime entries are merged later). */
  series: Map<SeriesKey, Observation[]>
  /** Where the post-"now" proton flux comes from. */
  replay: { snapshot: 'swpc_spe_replay' | 'sim_crew' | null; first_t: number | null; last_t: number | null; n: number }
  /** sim_crew variables block (labels, cadences, definitions). */
  variables: SimCrewData['variables']
  /** Scenario episodes (renal_hydration, sleep_shift) as documented by sim_crew. */
  episodes: NonNullable<SimCrewData['episodes']>
}

const SOURCES: readonly ObservationSource[] = ['band', 'manual', 'vehicle', 'lab', 'app', 'replay']
const asSource = (s: string): ObservationSource => ((SOURCES as readonly string[]).includes(s) ? (s as ObservationSource) : 'vehicle')

/** True when a series documents t as its window START (shift each sample to its window end). */
export function stampsWindowStart(s: SimSeries): boolean {
  return typeof s.t_meaning === 'string' && /\[start_t \+ k\s*\*\s*\d+/.test(s.t_meaning)
}

/** Expand one sim series into observations (null = a gap, skipped; never zero). */
export function expandSeries(s: SimSeries, crewId: string | null, variable: string, provenance = 'simulated'): Observation[] {
  const out: Observation[] = []
  const step = s.step_s ?? 0
  const shift = stampsWindowStart(s) ? step : 0
  for (let i = 0; i < s.v.length; i++) {
    const v = s.v[i]
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    const t = s.t ? s.t[i] : (s.start_t ?? 0) + i * step + shift
    if (t === undefined || !Number.isFinite(t)) continue
    out.push({
      crew_id: crewId as CrewId | null,
      variable,
      value: v,
      unit: s.unit,
      t,
      source: asSource(s.source),
      provenance,
    })
  }
  return out
}

/** MET of replay sample i, given sim_crew's mapping (UTC of MET day 412 00:00 in the replay). */
export function replaySampleMet(replayStartMs: number, stepS: number, i: number, mapUtcMs: number, mapMet: number): number {
  return mapMet + (replayStartMs + i * stepS * 1000 - mapUtcMs) / 1000
}

/**
 * Post-"now" onboard proton flux: the REAL GOES-7 October 1989 >=10 MeV series, time-shifted with
 * sim_crew's mapping (MET day `spe_day.met_day` 00:00 <-> replay_utc_at_met_0412_000000). Only
 * samples strictly after `nowMet` are returned: before it, sim_crew already carries the same flux.
 */
export function replayAfterNow(sim: SimCrewData, replay: SpeReplayData | null): Observation[] {
  const mapIso = sim.spe_day?.shape?.mapping?.replay_utc_at_met_0412_000000
  const day = sim.spe_day?.met_day
  const series = replay?.series_ge10mev
  if (!mapIso || typeof day !== 'number' || !series) return []
  const mapUtcMs = Date.parse(mapIso)
  const startMs = Date.parse(series.start)
  if (!Number.isFinite(mapUtcMs) || !Number.isFinite(startMs)) return []
  const out: Observation[] = []
  for (let i = 0; i < series.values.length; i++) {
    const v = series.values[i]
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    const t = replaySampleMet(startMs, series.step_s, i, mapUtcMs, day * DAY_S)
    if (t <= sim.met.now_met_s) continue
    out.push({ crew_id: null, variable: 'proton_flux_10mev', value: v, unit: replay!.unit, t, source: 'replay', provenance: 'replay' })
  }
  return out
}

function push(map: Map<SeriesKey, Observation[]>, obs: Observation[]): void {
  for (const o of obs) {
    const k = seriesKey(o.crew_id, o.variable)
    const list = map.get(k)
    if (list) list.push(o)
    else map.set(k, [o])
  }
}

/** Build the scenario index from the sim_crew payload (and the replay payload when it loaded). */
export function buildScenarioIndex(sim: SimCrewData, replay: SpeReplayData | null = null): ScenarioIndex {
  const series = new Map<SeriesKey, Observation[]>()
  for (const member of sim.crew) {
    if (!(CREW_IDS as readonly string[]).includes(member.crew_id)) continue
    for (const [variable, s] of Object.entries(member.series)) push(series, expandSeries(s, member.crew_id, variable))
    for (const [variable, s] of Object.entries(member.intraday ?? {})) push(series, expandSeries(s, member.crew_id, variable))
  }
  for (const [variable, s] of Object.entries(sim.vehicle?.series ?? {})) {
    push(series, expandSeries(s, null, variable))
  }
  // After "now": the real replay snapshot; if it is not in this build, sim_crew's own copy of it.
  let after = replayAfterNow(sim, replay)
  let replaySnap: ScenarioIndex['replay']['snapshot'] = after.length ? 'swpc_spe_replay' : null
  if (!after.length) {
    const s = sim.vehicle?.series?.proton_flux_10mev
    if (s?.after_now) {
      after = expandSeries({ unit: s.unit, source: 'replay', start_t: s.after_now.start_t, step_s: s.after_now.step_s, v: s.after_now.v }, null, 'proton_flux_10mev', 'replay')
      replaySnap = after.length ? 'sim_crew' : null
    }
  }
  push(series, after)
  for (const list of series.values()) list.sort((a, b) => a.t - b.t)
  return {
    epochIso: sim.calendar.met_epoch_utc,
    nowMet: sim.met.now_met_s,
    baselineDays: [sim.met.baseline_days[0], sim.met.baseline_days[1]],
    firstDay: sim.met.first_day,
    lastDay: sim.met.last_day,
    series,
    replay: { snapshot: replaySnap, first_t: after[0]?.t ?? null, last_t: after[after.length - 1]?.t ?? null, n: after.length },
    variables: sim.variables ?? {},
    episodes: sim.episodes ?? [],
  }
}

// ---- lookups -----------------------------------------------------------------------------------

/** Index of the last element with t <= at (binary search on a t-sorted list), or -1. */
export function lastIndexAtOrBefore(list: readonly Observation[], at: number): number {
  let lo = 0
  let hi = list.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].t <= at) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/**
 * Observations of one variable visible to a crewmember: their own plus vehicle / habitat sensors
 * (crew_id null), scenario plus runtime entries, sorted by t. `runtime` is the store's list.
 */
export function observationsFor(
  index: ScenarioIndex,
  runtime: readonly Observation[],
  crewId: CrewId | null,
  variable: string,
): Observation[] {
  const own = crewId ? (index.series.get(seriesKey(crewId, variable)) ?? []) : []
  const vehicle = index.series.get(seriesKey(null, variable)) ?? []
  const extra = runtime.filter((o) => o.variable === variable && (o.crew_id === null || o.crew_id === undefined || o.crew_id === crewId))
  if (!extra.length && (!own.length || !vehicle.length)) return own.length ? own : vehicle
  return [...own, ...vehicle, ...extra].sort((a, b) => a.t - b.t)
}

/** MET day an observation belongs to: the day its measurement window ENDED (a midnight stamp closes the previous day). */
export function observationDay(t: number): number {
  return Math.floor((t - 1) / DAY_S)
}

/** Every scenario + runtime observation with t <= at (for the ground packet), unsorted. */
export function visibleObservations(index: ScenarioIndex, runtime: readonly Observation[], at: number): Observation[] {
  const out: Observation[] = []
  for (const list of index.series.values()) {
    const last = lastIndexAtOrBefore(list, at)
    for (let i = 0; i <= last; i++) out.push(list[i])
  }
  for (const o of runtime) if (o.t <= at) out.push(o)
  return out
}
