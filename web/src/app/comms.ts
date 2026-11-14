// Comms status for the mission bar and any feature: AOS/LOS, one-way light time, conjunction,
// earliest reply, all from the engine's commsEta (SPEC 5 comms_eta).
//   - Mars: JPL Horizons snapshot horizons_mars_comms (light time per day + conjunction windows
//     MODELLED from the Horizons Sun-Earth-Mars elongation, edges fitted to NASA/JPL's published
//     command moratoria: `windowModel` carries the fit, D13; never "the real window"), mapped to MET
//     through the scenario epoch sim_crew data.calendar.met_epoch_utc.
//   - Moon (lunar_surface): JPL Horizons snapshot horizons_moon_comms (environments.json
//     comms_snapshot), real daily light time; no conjunction (the Moon is never behind the Sun).
//   - ISS / cislunar: the environments.json envelope (commsEta uses its max).
// If a snapshot is missing, the SPEC 3.1 fallback applies and the source is reported as missing
// ([V2 10020]): light time unknown (null), and on Mars LOS by the SPEC 7 scenario.
import { useMemo } from 'react'
import { commsEta } from './engine'
import type { CommsEta, CommsTable } from './engine'
import { useSnapshot } from './data'
import type { LoadStatus, Snapshot } from './data'
import { useMetNow, useMission } from './mission'
import type { Environment } from './scenario'
import { environment } from './scenario'
import type { EnvId } from './vocab'

export interface ConjunctionWindow {
  id: string | null
  /** MET seconds, half-open [start, stop). */
  start: number
  stop: number
  startUtc: string
  stopUtc: string
  /** RMS edge uncertainty of this modelled window, days (snapshot edge_uncertainty_days_rms), when given. */
  edgeRmsDays: number | null
}

/**
 * How the conjunction windows are modelled (horizons_mars_comms data.calendar fit, D13): the days the
 * Sun-Earth-Mars elongation is below one threshold, fitted to NASA/JPL published command moratoria.
 */
export interface WindowModel {
  thresholdDeg: number | null
  rmsDays: number | null
  maxAbsDays: number | null
  /** Published moratoria the fit used (n_edges / 2: each has a start and an end). */
  moratoria: number | null
}

export interface CommsStatus {
  /** AOS = acquisition of signal (link up); LOS = loss of signal. */
  link: 'AOS' | 'LOS'
  /** One-way light time in seconds; null when the ephemeris needed for it is not in this build. */
  one_way_s: number | null
  round_trip_s: number | null
  blocked: boolean
  reason: 'solar_conjunction' | null
  /** MET seconds when the link is back (end of the chained conjunction windows), else null. */
  resumes_at: number | null
  /** Seconds from t until a reply could arrive (zero ground time): round trip, or wait + round trip. */
  earliest_reply_s: number | null
  /** 'table' = ephemeris; 'environment_max' = environments.json envelope; null = unknown. */
  light_time_source: CommsEta['light_time_source'] | null
  env: Environment
  /** Snapshot backing the light time, when the environment uses one. */
  snapshotId: string | null
  snapshotStatus: LoadStatus | null
  snapshot: Snapshot | null
  /** 'snapshot' = ephemeris used; 'static' = environment constant; 'fallback' = SPEC values, source unavailable. */
  basis: 'snapshot' | 'static' | 'fallback'
  /** Static light-time envelope from the environment, when it has one. */
  range: { min: number; max: number; mean?: number } | null
  /** The conjunction window containing t (or null). It is modelled, not announced (see windowModel). */
  window: ConjunctionWindow | null
  /** The fit behind the modelled conjunction windows, when the ephemeris snapshot carries it. */
  windowModel: WindowModel | null
  /** Scenario MET epoch (UTC ISO) used to map the ephemeris, when known. */
  metEpochUtc: string | null
}

interface HorizonsData {
  columns?: string[]
  rows?: unknown[][]
  conjunctions?: Array<{ id?: string; start?: string; end?: string; stop?: string; edge_uncertainty_days_rms?: number }>
  calibration?: {
    threshold_deg?: { value?: number }
    residual_rms_days?: number
    residual_max_abs_days?: number
    n_edges?: number
  }
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

/** The conjunction-window fit of a horizons_*_comms payload (D13), or null when it has none. */
export function windowModelOf(data: unknown): WindowModel | null {
  const c = (data as HorizonsData | null)?.calibration
  if (!c) return null
  const edges = num(c.n_edges)
  return {
    thresholdDeg: num(c.threshold_deg?.value),
    rmsDays: num(c.residual_rms_days),
    maxAbsDays: num(c.residual_max_abs_days),
    moratoria: edges !== null && edges % 2 === 0 ? edges / 2 : null,
  }
}

interface SimCalendar {
  calendar?: { met_epoch_utc?: string }
}

/** Scenario epoch from sim_crew (data.calendar.met_epoch_utc), in ms since 1970, or null. */
export function metEpochFromSim(simData: unknown): { ms: number; iso: string } | null {
  const iso = (simData as SimCalendar | null)?.calendar?.met_epoch_utc
  if (typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? { ms, iso } : null
}

/** MET seconds -> UTC ISO, given the epoch in ms. */
export function metToUtc(t: number, epochMs: number): string {
  return new Date(epochMs + t * 1000).toISOString().replace('.000Z', 'Z')
}

/**
 * Convert a horizons_*_comms payload into the engine's comms table (MET-indexed, SPEC 5):
 * rows [date, ..., one_way_light_time_s, ...] by column name, conjunction windows start/end.
 */
export function toCommsTable(
  data: unknown,
  epochMs: number,
): (CommsTable & { windows: ConjunctionWindow[]; conjunction_windows: Array<{ start: number; end: number; reason: string }> }) | null {
  const d = data as HorizonsData | null
  if (!d || !Array.isArray(d.rows) || !Array.isArray(d.columns)) return null
  const iDate = d.columns.indexOf('date')
  const iOwlt = d.columns.indexOf('one_way_light_time_s')
  if (iDate < 0 || iOwlt < 0) return null
  const samples: CommsTable['samples'] = []
  for (const r of d.rows) {
    const date = r[iDate]
    const ow = r[iOwlt]
    if (typeof date !== 'string' || typeof ow !== 'number') continue
    const ms = Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date)
    if (Number.isFinite(ms)) samples.push({ t: (ms - epochMs) / 1000, one_way_s: ow })
  }
  samples.sort((a, b) => a.t - b.t)
  const windows: ConjunctionWindow[] = []
  for (const c of d.conjunctions ?? []) {
    const startUtc = c.start
    const stopUtc = c.end ?? c.stop
    if (!startUtc || !stopUtc) continue
    const s = Date.parse(startUtc)
    const e = Date.parse(stopUtc)
    if (Number.isFinite(s) && Number.isFinite(e)) {
      windows.push({ id: c.id ?? null, start: (s - epochMs) / 1000, stop: (e - epochMs) / 1000, startUtc, stopUtc, edgeRmsDays: num(c.edge_uncertainty_days_rms) })
    }
  }
  if (!samples.length) return null
  return {
    samples,
    conjunction_windows: windows.map((w) => ({ start: w.start, end: w.stop, reason: 'solar_conjunction' })),
    windows,
  }
}

type SnapLike = { status: LoadStatus; snapshot: Snapshot | null }

/** Snapshot id that backs an environment's light time: Mars from_snapshot, Moon comms_snapshot. */
export function commsSnapshotId(env: Environment): string | null {
  const owlt = env.comms.one_way_light_time_s
  if (typeof owlt.from_snapshot === 'string') return owlt.from_snapshot
  return typeof env.comms_snapshot === 'string' ? env.comms_snapshot : null
}

function staticRange(env: Environment): CommsStatus['range'] {
  const o = env.comms.one_way_light_time_s
  return typeof o.min === 'number' && typeof o.max === 'number' ? { min: o.min, max: o.max, mean: o.mean } : null
}

/** Pure: comms status for an environment at MET t, given the ephemeris and scenario snapshots. */
export function computeComms(env: Environment, t: number, ephem: SnapLike | null, sim: SnapLike | null = null): CommsStatus {
  const snapshotId = commsSnapshotId(env)
  const needsTable = typeof env.comms.one_way_light_time_s.from_snapshot === 'string'
  const epoch = sim?.status === 'ready' ? metEpochFromSim(sim.snapshot?.data) : null
  const table = snapshotId && ephem?.status === 'ready' && epoch ? toCommsTable(ephem.snapshot?.data, epoch.ms) : null
  const base = {
    env,
    snapshotId,
    snapshotStatus: snapshotId ? (ephem?.status ?? 'loading') : null,
    snapshot: ephem?.snapshot ?? null,
    range: staticRange(env),
    metEpochUtc: epoch?.iso ?? null,
    windowModel: env.comms.conjunction === true && ephem?.status === 'ready' ? windowModelOf(ephem.snapshot?.data) : null,
  }
  if (table) {
    // An environment with a static range and a comms_snapshot (the Moon) reads its light time
    // from the ephemeris: a copy of the environment that points at the snapshot.
    const envForEngine: Environment = needsTable
      ? env
      : { ...env, comms: { ...env.comms, one_way_light_time_s: { ...env.comms.one_way_light_time_s, from_snapshot: snapshotId! } } }
    const eta = commsEta(envForEngine, t, table)
    return {
      ...base,
      ...eta,
      link: eta.blocked ? 'LOS' : 'AOS',
      basis: 'snapshot',
      window: table.windows.find((w) => t >= w.start && t < w.stop) ?? null,
    }
  }
  if (!needsTable) {
    const eta = commsEta(env, t, null)
    return { ...base, ...eta, link: eta.blocked ? 'LOS' : 'AOS', basis: 'static', window: null }
  }
  // Ephemeris (or the scenario calendar) not available: commsEta would throw missing_comms_table.
  // SPEC 3.1 says this environment has conjunctions and SPEC 7 places the scenario "now" inside
  // one, so the link is reported LOS; the light time is unknown and shown as missing.
  const blocked = env.comms.conjunction === true
  return {
    ...base,
    link: blocked ? 'LOS' : 'AOS',
    one_way_s: null,
    round_trip_s: null,
    blocked,
    reason: blocked ? 'solar_conjunction' : null,
    resumes_at: null,
    earliest_reply_s: null,
    light_time_source: null,
    basis: 'fallback',
    window: null,
  }
}

/**
 * React hook: comms status (recomputed once per MET minute).
 * `useComms()` uses the store's environment and the scenario clock; both can be overridden.
 */
export function useComms(envId?: EnvId, t?: number): CommsStatus {
  const { state } = useMission()
  const clockT = useMetNow()
  const id = envId ?? state.envId
  const env = environment(id)
  const snapshotId = commsSnapshotId(env)
  const ephem = useSnapshot(snapshotId)
  const sim = useSnapshot(snapshotId ? 'sim_crew' : null)
  const minute = Math.floor((t ?? clockT) / 60)
  return useMemo(
    () => computeComms(env, minute * 60, snapshotId ? ephem : null, snapshotId ? sim : null),
    [env, minute, snapshotId, ephem, sim],
  )
}

/** "1.28 s", "21 min 40 s", "—" for unknown. */
export function formatLightTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds <= 1) return '≤1 s'
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds - m * 60)
  return s === 60 ? `${m + 1} min 00 s` : `${m} min ${String(s).padStart(2, '0')} s`
}

/** One-way light time for display: the mean when known, "≤1.50 s" for a 0-to-max envelope. */
export function formatCommsLightTime(c: Pick<CommsStatus, 'one_way_s' | 'range'> & { basis?: CommsStatus['basis'] }, roundTrip = false): string {
  const k = roundTrip ? 2 : 1
  if (c.basis !== 'snapshot' && c.range && c.range.mean === undefined && c.range.min === 0) {
    return c.range.max * k <= 1 ? '≤1 s' : `≤${formatLightTime(c.range.max * k)}`
  }
  return formatLightTime(c.one_way_s === null ? null : c.one_way_s * k)
}

/** Earliest possible reply from Earth (zero ground time): "11 d 06 h" when blocked, else the round trip. */
export function formatEarliestReply(c: Pick<CommsStatus, 'earliest_reply_s' | 'blocked' | 'range' | 'basis'>): string {
  if (c.earliest_reply_s === null) return '—'
  if (c.blocked) return formatCountdown(c.earliest_reply_s)
  return formatCommsLightTime({ one_way_s: c.earliest_reply_s / 2, range: c.range, basis: c.basis }, true)
}

/** "11 d 06 h", "3 h 20 min", "45 min" for a duration in seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} d ${String(h).padStart(2, '0')} h`
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`
  return `${m} min`
}

/** Days for prose: "0.79 d" (two decimals at most, no trailing zeros). */
function days(x: number): string {
  return `${Number(x.toFixed(2))} d`
}

/**
 * D13 wording of a modelled conjunction window, from its fit: "modelled from JPL Horizons geometry, edges
 * fitted to 6 NASA/JPL published command moratoria (RMS 0.79 d)". Never "real".
 */
export function windowModelNote(m: WindowModel | null): string {
  if (!m) return 'modelled from JPL Horizons geometry'
  const fit =
    m.moratoria !== null
      ? `edges fitted to ${m.moratoria} NASA/JPL published command moratoria`
      : 'edges fitted to NASA/JPL published command moratoria'
  return `modelled from JPL Horizons geometry, ${fit}${m.rmsDays !== null ? ` (RMS ${days(m.rmsDays)})` : ''}`
}
