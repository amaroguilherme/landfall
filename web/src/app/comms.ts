// Comms status for the mission bar and any feature: AOS/LOS, one-way light time, conjunction.
// Mars uses the JPL Horizons snapshot (/data/horizons_mars_comms.json: UTC-dated rows and
// conjunction windows) mapped to MET through the scenario epoch in /data/sim_crew.json
// (data.calendar.met_epoch_utc). If either file is missing, the SPEC 3.1 fallback applies and
// the source is reported as missing ([V2 10020]).
import { useMemo } from 'react'
import { commsEta } from './engine'
import type { CommsEta, CommsTable } from './engine'
import { useSnapshot } from './data'
import type { LoadStatus, Snapshot } from './data'
import type { Environment } from './scenario'
import { environment } from './scenario'
import type { EnvId } from './vocab'

export interface ConjunctionWindow {
  id: string | null
  /** MET seconds. */
  start: number
  stop: number
  startUtc: string
  stopUtc: string
}

export interface CommsStatus extends CommsEta {
  /** AOS = acquisition of signal (link up); LOS = loss of signal. */
  link: 'AOS' | 'LOS'
  env: Environment
  /** Snapshot backing the light time, when the environment uses one. */
  snapshotId: string | null
  snapshotStatus: LoadStatus | null
  snapshot: Snapshot | null
  /** 'snapshot' = ephemeris used; 'static' = environment constant; 'fallback' = SPEC values, source unavailable. */
  basis: 'snapshot' | 'static' | 'fallback'
  /** Static light-time envelope from the environment, when it has one. */
  range: { min: number; max: number; mean?: number } | null
  /** The conjunction window containing t (or null). */
  window: ConjunctionWindow | null
  /** Scenario MET epoch (UTC ISO) used to map the ephemeris, when known. */
  metEpochUtc: string | null
}

interface HorizonsData {
  columns?: string[]
  rows?: unknown[][]
  conjunctions?: Array<{ id?: string; start?: string; end?: string; stop?: string }>
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
 * Convert the horizons_mars_comms payload into the engine's comms table (MET-indexed):
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
      windows.push({ id: c.id ?? null, start: (s - epochMs) / 1000, stop: (e - epochMs) / 1000, startUtc, stopUtc })
    }
  }
  if (!samples.length) return null
  return {
    samples,
    blackouts: windows.map((w) => ({ start: w.start, stop: w.stop, reason: 'solar_conjunction' })),
    // SPEC 5 comms_eta shape, read by the real engine port (web/src/engine/comms.ts) once the
    // facade in app/engine.ts switches to it; `blackouts` above is what the shim reads.
    conjunction_windows: windows.map((w) => ({ start: w.start, end: w.stop, reason: 'solar_conjunction' })),
    windows,
  }
}

type SnapLike = { status: LoadStatus; snapshot: Snapshot | null }

/** Pure: comms status for an environment at MET t, given the ephemeris and scenario snapshots. */
export function computeComms(env: Environment, t: number, ephem: SnapLike | null, sim: SnapLike | null = null): CommsStatus {
  const owlt = env.comms?.one_way_light_time_s
  const snapshotId = owlt && 'from_snapshot' in owlt ? owlt.from_snapshot : null
  const epoch = sim?.status === 'ready' ? metEpochFromSim(sim.snapshot?.data) : null
  let basis: CommsStatus['basis'] = snapshotId ? 'fallback' : 'static'
  let eta: CommsEta
  let window: ConjunctionWindow | null = null
  const table = snapshotId && ephem?.status === 'ready' && epoch ? toCommsTable(ephem.snapshot?.data, epoch.ms) : null
  if (table) {
    eta = commsEta(env, t, table)
    window = table.windows.find((w) => t >= w.start && t < w.stop) ?? null
    basis = 'snapshot'
  } else {
    eta = commsEta(env, t, null)
  }
  return {
    ...eta,
    link: eta.blocked ? 'LOS' : 'AOS',
    env,
    snapshotId,
    snapshotStatus: snapshotId ? (ephem?.status ?? 'loading') : null,
    snapshot: ephem?.snapshot ?? null,
    basis,
    range: owlt && 'max' in owlt ? owlt : null,
    window,
    metEpochUtc: epoch?.iso ?? null,
  }
}

/** React hook: comms status for an environment at MET t (recomputed once per MET minute). */
export function useComms(envId: EnvId, t: number): CommsStatus {
  const env = environment(envId)
  const owlt = env.comms?.one_way_light_time_s
  const snapshotId = owlt && 'from_snapshot' in owlt ? owlt.from_snapshot : null
  const ephem = useSnapshot(snapshotId)
  const sim = useSnapshot(snapshotId ? 'sim_crew' : null)
  const minute = Math.floor(t / 60)
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
export function formatCommsLightTime(c: Pick<CommsStatus, 'one_way_s' | 'range'>, roundTrip = false): string {
  const k = roundTrip ? 2 : 1
  if (c.range && c.range.mean === undefined && c.range.min === 0) {
    return c.range.max * k <= 1 ? '≤1 s' : `≤${formatLightTime(c.range.max * k)}`
  }
  return formatLightTime(c.one_way_s === null ? null : c.one_way_s * k)
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
