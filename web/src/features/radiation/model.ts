// Radiation model (pure; no React): reshapes the frozen NASA / NOAA snapshots for charting. No
// value is converted between quantities: absorbed dose (Gy) stays absorbed dose, flux stays flux.
// The only arithmetic is time mapping (replay UTC -> scenario MET, with sim_crew's own mapping)
// and picking which predicted SAA passes come next.

const DAY_S = 86_400

// ---- snapshot shapes (only the fields read here) ------------------------------------------------

export interface TepcData {
  explainer?: string
  native: { time: string[]; dose_uGy_per_min: Array<number | null> }
  native_window: { start: string; stop: string; n: number; dose_uGy?: number; dose_rate_stats_uGy_per_min?: { median?: number; max?: number; p95?: number } }
  daily?: { series: Array<{ date: string; dose_uGy: number | null; complete: boolean }> }
}

export interface SaaPass {
  start: string
  stop: string
  duration_s: number
  truncated: boolean
  min_B_nT: number
  lat_deg_at_min_B?: number
  lon_deg_at_min_B?: number
}

export interface IssTrackData {
  explainer?: string
  saa_rule: { definition: string; threshold_nT: number; basis: string; window: { start: string; stop: string } }
  saa_passes: SaaPass[]
  saa_summary?: { n_passes_48h?: number; n_passes_first_24h?: number }
}

export interface DailyStat {
  date: string
  n: number
  mean: number | null
  min?: number | null
  max?: number | null
}

export interface HapiDoseData {
  explainer?: string
  headline_parameter: string
  series: Record<string, { units: string; summary?: Record<string, number>; daily: DailyStat[] }>
  enhanced_days?: { rule: string; basis: string; days: Array<{ date: string; mean: number; ratio_to_median: number }> }
  conversions?: Record<string, number>
}

export interface SScaleLevel {
  level: string
  n: number
  descriptor: string
  threshold_pfu: number
  threshold_as_printed?: string
  effects?: Record<string, string>
}

export interface SScaleData {
  levels: SScaleLevel[]
  unit?: string
}

export interface ReplayData {
  unit: string
  series_ge10mev: { start: string; step_s: number; n: number; values: Array<number | null> }
  s_transitions: Array<[string, number | null]>
  sesc_event_computed?: { start: string; max_time: string; max_pfu: number; max_s_level: number }
  noaa_spe_list_entry?: { start_as_printed?: string; max_as_printed?: string; peak_pfu?: number; s_level?: number }
}

export interface ProtonsLiveData {
  current: { time_tag: string; flux_pfu: number | null; s_level: number | null; satellite?: number }
  series_7d?: { start: string; step_s: number; n: number; method?: string; values: Array<number | null> }
}

export interface RequirementRec {
  id: string
  text: string
  rationale?: string
  title?: string
}

// ---- time mapping ------------------------------------------------------------------------------------

/** sim_crew's replay mapping: replay UTC of MET day `metDay` 00:00 (time shift only). */
export interface ReplayMapping {
  mapUtcMs: number
  mapMet: number
}

export function replayMapping(sim: unknown): ReplayMapping | null {
  const d = (sim ?? {}) as { spe_day?: { met_day?: number; shape?: { mapping?: { replay_utc_at_met_0412_000000?: string } } } }
  const iso = d.spe_day?.shape?.mapping?.replay_utc_at_met_0412_000000
  const day = d.spe_day?.met_day
  if (!iso || typeof day !== 'number') return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? { mapUtcMs: ms, mapMet: day * DAY_S } : null
}

/** Replay UTC (ms) -> scenario MET (s). */
export function utcToMet(ms: number, m: ReplayMapping): number {
  return m.mapMet + (ms - m.mapUtcMs) / 1000
}

/** A regular series {start, step_s, values} as (t, v) arrays; t in ms UTC. */
export function regularSeries(s: { start: string; step_s: number; values: Array<number | null> }): { t: number[]; v: Array<number | null> } {
  const t0 = Date.parse(s.start)
  const t: number[] = []
  for (let i = 0; i < s.values.length; i++) t.push(t0 + i * s.step_s * 1000)
  return { t, v: s.values.slice() }
}

export interface Transition {
  utc: string
  met: number | null
  level: number
}

/** The replay's S-level transitions (nulls = data gaps, dropped), mapped to MET when a mapping exists. */
export function transitions(r: ReplayData, m: ReplayMapping | null): Transition[] {
  const out: Transition[] = []
  for (const [utc, level] of r.s_transitions ?? []) {
    if (level === null || level === undefined) continue
    const prev = out[out.length - 1]
    if (prev && prev.level === level) continue
    const ms = Date.parse(utc)
    out.push({ utc, level, met: m && Number.isFinite(ms) ? utcToMet(ms, m) : null })
  }
  return out
}

/** First time each S level (1..max) was reached. */
export function firstReach(ts: readonly Transition[]): Transition[] {
  const seen = new Set<number>()
  const out: Transition[] = []
  let max = 0
  for (const tr of ts) {
    if (tr.level > max) {
      for (let l = max + 1; l <= tr.level; l++) {
        if (!seen.has(l)) {
          seen.add(l)
          out.push({ ...tr, level: l })
        }
      }
      max = tr.level
    }
  }
  return out
}

// ---- SAA passes -------------------------------------------------------------------------------------------

export interface PassView extends SaaPass {
  startMs: number
  stopMs: number
}

export interface SaaPlan {
  /** Reference instant (ms): the wall clock while the prediction window is open, else retrieval time. */
  refMs: number
  refKind: 'wall_clock' | 'retrieval'
  windowStartMs: number
  windowStopMs: number
  /** Passes intersecting [refMs, refMs + spanMs). */
  passes: PassView[]
  spanMs: number
}

/**
 * The NEXT predicted SAA passes. While the wall clock is inside the snapshot's prediction window,
 * "next" means after now; once the window has ended (judges open the site weeks later), it means
 * after the moment the prediction was retrieved, and the caller must label it stale.
 */
export function nextPasses(track: IssTrackData, retrievedAt: string, nowMs: number, spanMs = DAY_S * 1000): SaaPlan {
  const ws = Date.parse(track.saa_rule.window.start)
  const we = Date.parse(track.saa_rule.window.stop)
  const retrieved = Date.parse(retrievedAt)
  const inside = nowMs >= ws && nowMs <= we
  const refMs = inside ? nowMs : Number.isFinite(retrieved) ? Math.max(retrieved, ws) : ws
  const passes = track.saa_passes
    .map((p) => ({ ...p, startMs: Date.parse(p.start), stopMs: Date.parse(p.stop) }))
    .filter((p) => Number.isFinite(p.startMs) && p.stopMs > refMs && p.startMs < refMs + spanMs)
    .sort((a, b) => a.startMs - b.startMs)
  return { refMs, refKind: inside ? 'wall_clock' : 'retrieval', windowStartMs: ws, windowStopMs: we, passes, spanMs }
}

// ---- daily dose series ---------------------------------------------------------------------------------

/** Daily means of a HAPI dose series as (dayMs, mean); days with n = 0 stay null (a gap, never zero). */
export function dailySeries(d: HapiDoseData, parameter = d.headline_parameter): { t: number[]; v: Array<number | null>; units: string; gaps: string[] } {
  const s = d.series[parameter]
  if (!s) return { t: [], v: [], units: '', gaps: [] }
  const t: number[] = []
  const v: Array<number | null> = []
  const gaps: string[] = []
  for (const row of s.daily) {
    const ms = Date.parse(`${row.date}T12:00:00Z`)
    if (!Number.isFinite(ms)) continue
    t.push(ms)
    const ok = row.n > 0 && typeof row.mean === 'number' && Number.isFinite(row.mean)
    v.push(ok ? (row.mean as number) : null)
    if (!ok) gaps.push(row.date)
  }
  return { t, v, units: s.units, gaps }
}

/** TEPC native minutes as (ms, uGy/min). */
export function tepcNative(d: TepcData): { t: number[]; v: Array<number | null> } {
  const t: number[] = []
  const v: Array<number | null> = []
  d.native.time.forEach((iso, i) => {
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return
    t.push(ms)
    const x = d.native.dose_uGy_per_min[i]
    v.push(typeof x === 'number' && Number.isFinite(x) ? x : null)
  })
  return { t, v }
}

/** Requirement record by id, tolerant of "[V2 6165]" vs "V2 6165". */
export function findRequirement(list: readonly RequirementRec[] | undefined, id: string): RequirementRec | null {
  const bare = id.replace(/^\[|\]$/g, '')
  return list?.find((r) => r.id.replace(/^\[|\]$/g, '') === bare) ?? null
}

/** "YYYY-MM-DD HH:MMZ" for ms UTC. */
export function utcLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}

/** "HH:MM" UTC for ms. */
export function hhmmUtc(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16)
}
