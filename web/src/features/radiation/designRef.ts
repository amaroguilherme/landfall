// NASA's design reference SPE, re-derived. NASA-STD-3001 Vol 1 Table 4.8-3 prints the summed October 1989 proton
// spectrum as 100 energy/fluence pairs (frozen in std_vol1_requirements, data.tables). Integrated above 10 and
// 100 MeV, it is set against the fluence of the replayed GOES-7 record (swpc_spe_replay) over the event as the
// swpc adapter computes it with NOAA's SESC rule. In hindsight, the same record says how much had arrived before
// LANDFALL's S3 trigger, scored with the MSL RAD team's lead-time measure (the time left to avoid 90 % of the
// total). Fluence only: no dose is computed here, and nothing here feeds the case, the rules, the annunciator or
// the hero. ingest/tests/test_design_reference.py recomputes every number in stdlib Python.
import { NOAA_S_THRESHOLDS_PFU } from '../../app/engine'
import { firstReach, transitions } from './model'
import { dayTimeUtc } from './witnesses'
import type { ReplayWithEvent } from './witnesses'

export const TABLE_ID = 'Table 4.8-3'
/** The replay's two integral channels, by the lower energy each counts protons above (MeV). */
export const CHANNELS = [
  { key: 'series_ge10mev', e0: 10 },
  { key: 'series_ge100mev', e0: 100 },
] as const
export type ChannelKey = (typeof CHANNELS)[number]['key']
/** Design choice: the earliest window end the sensitivity line tries (the record's last sample is the latest). */
export const WINDOW_END_FROM = '1989-10-26T00:00:00Z'
/** The RAD team's lead-time measure: the time left until 10 % of the total has been received (90 % still avoidable). */
export const LEAD_FRACTION = 0.1
/** NOAA S3, the level at which LANDFALL's shelter case fires (the replay's first S3 transition). */
export const TRIGGER_LEVEL = 3
/** Its >=10 MeV flux threshold, pfu (the engine's NOAA table). */
export const TRIGGER_PFU: number = NOAA_S_THRESHOLDS_PFU[TRIGGER_LEVEL - 1]

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

// ---- the frozen table ----------------------------------------------------------------------------------------

export interface SpectrumRow {
  energy: string
  energy_mev: number
  fluence: { text: string; value: number; unit: string | null }
}

export interface SpectrumTable {
  id: string
  caption: string
  header_verbatim: string[]
  units?: { energy: string | null; fluence: string | null }
  pdf_page_number: number
  printed_page?: number | null
  rows: SpectrumRow[]
  row_count?: number
  checks?: Array<{ check: string; ok: boolean }>
  verified: boolean
  cited_by?: string[]
}

/** Table 4.8-3 from the Vol 1 snapshot's data, or null when this snapshot predates it or its checks failed. */
export function spectrumTable(vol1: { tables?: unknown } | null | undefined): SpectrumTable | null {
  const list = Array.isArray(vol1?.tables) ? (vol1!.tables as Array<Partial<SpectrumTable> | null>) : []
  const t = list.find((x) => x && x.id === TABLE_ID) as SpectrumTable | undefined
  if (!t || t.verified !== true || !Array.isArray(t.rows) || t.rows.length < 2) return null
  return t
}

export type Pair = readonly [number, number]

export function pairsOf(t: SpectrumTable): Pair[] {
  return t.rows.map((r) => [r.energy_mev, r.fluence.value] as const)
}

/**
 * ∫ F(E) dE from e0 to the last printed energy, F taken as a power law between consecutive pairs (a straight line
 * on log-log axes): protons/cm² from a spectrum in protons/(cm² MeV). Nothing is extrapolated past the last pair.
 */
export function integralAbove(pairs: readonly Pair[], e0: number): number {
  let total = 0
  for (let i = 0; i + 1 < pairs.length; i++) {
    const [e1, f1] = pairs[i]
    const [e2, f2] = pairs[i + 1]
    if (e2 <= e0) continue
    const a = Math.max(e1, e0)
    const g = Math.log(f2 / f1) / Math.log(e2 / e1)
    if (Math.abs(g + 1) < 1e-12) total += f1 * e1 * Math.log(e2 / a)
    else total += (f1 * e1 * (Math.pow(e2 / e1, g + 1) - Math.pow(a / e1, g + 1))) / (g + 1)
  }
  return total
}

/** The figure's energy range, MeV: the decades around the replay's two channels (design choice). */
export const CURVE_E_MIN = 1
export const CURVE_E_MAX = 1000

export interface CurvePoint {
  /** A printed energy, MeV. */
  e: number
  /** The table integrated above it, protons/cm² (0 at the last printed energy). */
  above: number
}

/** Table 4.8-3 integrated above each of its printed energies: the figure's line and its table view. */
export function integralCurve(pairs: readonly Pair[]): CurvePoint[] {
  return pairs.map(([e]) => ({ e, above: integralAbove(pairs, e) }))
}

/** The whole decades that bound positive values: [10^floor(log10 min), 10^ceil(log10 max)], or null. */
export function decadeRange(values: readonly number[]): [number, number] | null {
  const v = values.filter((x) => Number.isFinite(x) && x > 0)
  if (!v.length) return null
  return [10 ** Math.floor(Math.log10(Math.min(...v))), 10 ** Math.ceil(Math.log10(Math.max(...v)))]
}

// ---- the replayed record -------------------------------------------------------------------------------------

export interface RegularSeries {
  start: string
  step_s: number
  values: ReadonlyArray<number | null>
}

export function sampleTimes(s: RegularSeries): number[] {
  const t0 = Date.parse(s.start)
  return s.values.map((_, i) => t0 + i * s.step_s * 1000)
}

/** Missing samples filled linearly between the nearest samples on either side; 0 at an open end (none here). */
export function filledValues(values: ReadonlyArray<number | null>): number[] {
  const out = new Array<number>(values.length).fill(0)
  let left: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v !== null && v !== undefined) {
      out[i] = v
      left = i
      continue
    }
    let right: number | null = null
    for (let k = i + 1; k < values.length; k++) {
      if (values[k] !== null && values[k] !== undefined) {
        right = k
        break
      }
    }
    if (left === null || right === null) out[i] = 0
    else {
      const l = values[left] as number
      const r = values[right] as number
      out[i] = l + ((r - l) * (i - left)) / (right - left)
    }
  }
  return out
}

/** "1989-10-18" for a UTC instant (ms). */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Design choice: the background is the median of the day before the onset day (18 Oct for this event). */
export function backgroundDay(onsetIso: string): string {
  return utcDay(Date.parse(onsetIso) - DAY_MS)
}

/** Median of the non-missing samples whose UTC date is `day`, or null when that day has none. */
export function dayMedian(s: RegularSeries, day: string): number | null {
  const t = sampleTimes(s)
  const vals = s.values.filter((v, i): v is number => v !== null && v !== undefined && utcDay(t[i]) === day).sort((a, b) => a - b)
  const n = vals.length
  if (!n) return null
  return n % 2 ? vals[(n - 1) / 2] : 0.5 * (vals[n / 2 - 1] + vals[n / 2])
}

export interface Fluence {
  /** Sample times (ms) inside the window. */
  times: number[]
  /** Running fluence (protons/cm²) after each of those samples. */
  cumulative: number[]
  total: number
}

/**
 * Fluence of an integral channel over the samples with start <= t <= end: 4π × Σ max(F − bg, 0) × step, with F in
 * pfu (protons cm⁻² s⁻¹ sr⁻¹) taken as isotropic (design choice: × 4π sr) and missing samples filled linearly.
 */
export function replayFluence(s: RegularSeries, startMs: number, endMs: number, bg: number): Fluence {
  const t = sampleTimes(s)
  const v = filledValues(s.values)
  const times: number[] = []
  const cumulative: number[] = []
  let run = 0
  for (let i = 0; i < t.length; i++) {
    if (t[i] < startMs || t[i] > endMs) continue
    run += 4 * Math.PI * Math.max(v[i] - bg, 0) * s.step_s
    times.push(t[i])
    cumulative.push(run)
  }
  return { times, cumulative, total: run }
}

/** Fraction of the total carried by the samples strictly before t (ms). */
export function shareBefore(f: Fluence, tMs: number): number {
  let before = 0
  for (let i = 0; i < f.times.length && f.times[i] < tMs; i++) before = f.cumulative[i]
  return f.total > 0 ? before / f.total : 0
}

/** The first sample (ms) at which the running fluence reaches `fraction` of the total. */
export function fractionMark(f: Fluence, fraction: number = LEAD_FRACTION): number | null {
  const i = f.cumulative.findIndex((c) => c >= fraction * f.total)
  return i >= 0 ? f.times[i] : null
}

export interface WindowEndRange {
  fromMs: number
  toMs: number
  minPct: number
  maxPct: number
}

/**
 * How the agreement moves with the window's end: (replay − reference) / reference in %, for every window end from
 * `fromMs` to the record's last sample, the start held. Min and max over those ends.
 */
export function windowEndSensitivity(s: RegularSeries, startMs: number, fromMs: number, bg: number, reference: number): WindowEndRange | null {
  const t = sampleTimes(s)
  const f = replayFluence(s, startMs, t[t.length - 1], bg)
  let minPct = Infinity
  let maxPct = -Infinity
  for (let i = 0; i < f.times.length; i++) {
    if (f.times[i] < fromMs) continue
    const pct = (100 * (f.cumulative[i] - reference)) / reference
    minPct = Math.min(minPct, pct)
    maxPct = Math.max(maxPct, pct)
  }
  return Number.isFinite(minPct) ? { fromMs, toMs: t[t.length - 1], minPct, maxPct } : null
}

// ---- the check -----------------------------------------------------------------------------------------------

export interface ChannelCheck {
  key: ChannelKey
  e0: number
  /** Background, pfu (median of the background day). */
  bg: number
  /** Table 4.8-3 integrated above e0, protons/cm². */
  table: number
  /** The replay's fluence over the event window, protons/cm². */
  replay: number
  /** (replay − table) / table, %. */
  diffPct: number
  /** Hindsight: % of the replay's fluence that arrived before the S3 trigger sample. */
  beforePct: number
  /** Hindsight: when LEAD_FRACTION of it had arrived (ms), and how long after the trigger (h). */
  markMs: number
  markHoursAfter: number
  windowEnd: WindowEndRange | null
}

export interface DesignReference {
  table: SpectrumTable
  windowStart: string
  windowEnd: string
  bgDay: string
  /** The replay's first S3 sample: LANDFALL's shelter trigger. */
  trigger: string
  /** The replay's sample spacing, s. */
  stepS: number
  channels: ChannelCheck[]
  /** Table 4.8-3 integrated above each printed energy. */
  curve: CurvePoint[]
}

/** Everything the section shows, or null when Table 4.8-3 or the replay's event window is missing. */
export function designReference(vol1: { tables?: unknown } | null | undefined, replay: ReplayWithEvent | null | undefined): DesignReference | null {
  const table = spectrumTable(vol1)
  const ev = replay?.sesc_event_computed
  if (!table || !replay || !ev?.start || !ev.end_last_ge_10pfu) return null
  const trigger = firstReach(transitions(replay, null)).find((x) => x.level === TRIGGER_LEVEL)?.utc ?? null
  if (!trigger) return null
  const pairs = pairsOf(table)
  const startMs = Date.parse(ev.start)
  const endMs = Date.parse(ev.end_last_ge_10pfu)
  const trigMs = Date.parse(trigger)
  const bgDay = backgroundDay(ev.start)
  const channels: ChannelCheck[] = []
  for (const c of CHANNELS) {
    const s = replay[c.key] as RegularSeries | undefined
    const bg = s ? dayMedian(s, bgDay) : null
    if (!s || bg === null) return null
    const f = replayFluence(s, startMs, endMs, bg)
    const markMs = fractionMark(f)
    if (markMs === null || f.total <= 0) return null
    const ref = integralAbove(pairs, c.e0)
    channels.push({
      key: c.key,
      e0: c.e0,
      bg,
      table: ref,
      replay: f.total,
      diffPct: (100 * (f.total - ref)) / ref,
      beforePct: 100 * shareBefore(f, trigMs),
      markMs,
      markHoursAfter: (markMs - trigMs) / HOUR_MS,
      windowEnd: windowEndSensitivity(s, startMs, Date.parse(WINDOW_END_FROM), bg, ref),
    })
  }
  return { table, windowStart: ev.start, windowEnd: ev.end_last_ge_10pfu, bgDay, trigger, stepS: replay.series_ge10mev.step_s, channels, curve: integralCurve(pairs) }
}

// ---- display -------------------------------------------------------------------------------------------------

/** 1.9296e10 -> { mantissa: "1.930", exponent: 10 } (four significant digits by default). */
export function sci(value: number, digits = 3): { mantissa: string; exponent: number } {
  const [m, e] = value.toExponential(digits).split('e')
  return { mantissa: m, exponent: Number(e) }
}

/** A percentage rounded to `digits`, signed, with a true minus; a value that rounds to zero prints as "0.0". */
export function signedPct(v: number, digits: number): string {
  const r = Number(v.toFixed(digits))
  if (r === 0) return (0).toFixed(digits)
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)}`
}

/** "19 Oct 18:55 UTC" for an instant in ms (the witnesses card's format). */
export const dayTime = (ms: number) => dayTimeUtc(new Date(ms).toISOString())

/** "18 Oct" for "1989-10-18". */
export function dayLabel(day: string): string {
  return dayTimeUtc(`${day}T00:00:00Z`).split(' ').slice(0, 2).join(' ')
}
