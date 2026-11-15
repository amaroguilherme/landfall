// Sol 242 (April 2013): pure selectors over the sep_conjunction_2013 snapshot (MSL RAD on iSWA, STEREO-B HET on
// CDAWeb, JPL's 2013 windows, NOAA's entry, the RAD team's Table 1 row, Hassler et al. 2014) and NOAA's list
// (swpc_spe_list). One UTC axis for both charts, in days from 2013-04-10T00:00Z. Nothing here feeds the engine,
// the rules, the scenario or the hero, and no absorbed dose is converted to Sv.

export const SOL242_SNAPSHOT_ID = 'sep_conjunction_2013'
export const SPE_LIST_SNAPSHOT_ID = 'swpc_spe_list'
/** Phrases the panel never uses (a grep test reads Sol242.tsx and the rendered text). */
export const BANNED_PHRASES = ['near miss', 'near-miss', 'big storm', 'no one could warn'] as const

const DAY_MS = 86_400_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// ---- snapshot shape ---------------------------------------------------------------------------------------------

export interface RadPoint {
  t: string
  uGy_per_day: number
  ratio_to_background: number
}

export interface HetChannel {
  centre_MeV: number
  index: number
  mean: Array<number | null>
  n: number[]
  quiet_median: number | null
  quiet_n_hours: number
  peak: { t: string; mean: number; multiple_of_quiet: number | null }
  first_hour_above_10x_quiet: string | null
}

export interface JplWindow {
  id: string
  conjunction?: string
  scope: string
  quote: string
  doc: string
  publisher: string
  published: string
  url: string
  start_date: string
  end_date: string
  quote_verified_this_build: boolean
  quote_verification_note?: string | null
}

export interface Fragment {
  id: string
  text: string
}

export interface SpeEntry {
  start: string
  max: string
  peak_pfu: number
  s_level: number
  start_as_printed?: string
  max_as_printed?: string
}

export interface Sol242Data {
  explainer: string
  axis: { start: string; stop: string; inside_curiosity_window: boolean }
  rad: {
    units: string
    background: { start: string; stop: string; uGy_per_day: number; n_samples: number; max_excursion_pct: number }
    threshold_factor: number
    threshold_uGy_per_day: number
    rise_factor: number
    t0: string
    t_s: number[]
    uGy_per_day: number[]
    n_samples: number
    median_spacing_min: number
    samples_above_threshold: number
    peak: RadPoint
    first_rise: RadPoint | null
    last_before_rise: RadPoint | null
    back_below_background: RadPoint | null
    highest_after_back: RadPoint | null
  }
  stereo_b: {
    units: string
    bin_centres_MeV: number[]
    t0: string
    hour_s: number
    n_hours: number
    quiet: { start: string; stop: string; statistic: string }
    first_above_factor: number
    channels: HetChannel[]
    n_rows: number
  }
  noaa: { snapshot: string; energy?: string; unit?: string; event: SpeEntry; scenario_event: SpeEntry }
  jpl: { snapshot: string; windows: JplWindow[] }
  table1: { paper_row: string; paper: { triggered: boolean; total_uGy?: number }; status: string; paper_ref: string; replay: { max_ratio_to_background?: number | null } }
  literature: {
    authors_short: string
    title: string
    journal: string
    volume: string
    article_number: string
    year: number
    doi: string
    doi_url: string
    pdf_url: string
    pdf_sha256: string
    fragments: Fragment[]
    fragments_verified_this_build: boolean
    dates: { table1: string; fig5: string; fig1: string }
  }
  moratoria: { method: string; windows: Array<{ id: string; start_date: string; end_date: string; scope: string; applies_to_curiosity: boolean; n_samples: number }> }
}

export interface SpeListLike {
  events: SpeEntry[]
}

// ---- the axis ------------------------------------------------------------------------------------------------------

/** Days from the axis start of an ISO time (the x of both charts). */
export function axisDays(d: Sol242Data, iso: string): number {
  return (Date.parse(iso) - Date.parse(d.axis.start)) / DAY_MS
}

/** Axis length in days (3: 10 April 00:00 to 13 April 00:00 UTC). */
export function axisSpan(d: Sol242Data): number {
  return (Date.parse(d.axis.stop) - Date.parse(d.axis.start)) / DAY_MS
}

/** "10 Apr" at whole days, "12:00" at noon (unless `daysOnly`), "" between: the tick labels of both charts. */
export function axisTick(d: Sol242Data, v: number, daysOnly = false): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  const ms = Date.parse(d.axis.start) + v * DAY_MS
  if (near(v, Math.round(v))) {
    const t = new Date(Date.parse(d.axis.start) + Math.round(v) * DAY_MS)
    return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`
  }
  if (!daysOnly && near(v * 2, Math.round(v * 2))) return `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:00`
  return ''
}

/** "11 Apr 14:19 UTC" (minutes; the seconds stay in the data and the aria label). */
export function dayHmUtc(iso: string): string {
  const t = new Date(Date.parse(iso))
  const two = (n: number) => String(n).padStart(2, '0')
  return `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())} UTC`
}

/** "October 1989". */
export function monthYearLong(iso: string): string {
  const t = new Date(Date.parse(iso))
  return `${MONTHS_LONG[t.getUTCMonth()]} ${t.getUTCFullYear()}`
}

// ---- MSL RAD -------------------------------------------------------------------------------------------------------

export interface RadSeries {
  x: number[]
  e: number[]
  background: number
  threshold: number
  minSpacingMin: number
  maxSpacingMin: number
}

/** The native RAD samples on the axis, with the 5-day background and the 1.25 x line as the adapter computed them. */
export function radSeries(d: Sol242Data): RadSeries {
  const r = d.rad
  const off = (Date.parse(r.t0) - Date.parse(d.axis.start)) / 1000
  const x = r.t_s.map((s) => (s + off) / 86_400)
  const gaps = r.t_s.slice(1).map((s, i) => (s - r.t_s[i]) / 60)
  return {
    x,
    e: [...r.uGy_per_day],
    background: r.background.uGy_per_day,
    threshold: r.threshold_uGy_per_day,
    minSpacingMin: gaps.length ? Math.min(...gaps) : 0,
    maxSpacingMin: gaps.length ? Math.max(...gaps) : 0,
  }
}

export interface RadMoments {
  peak: RadPoint
  rise: RadPoint | null
  back: RadPoint | null
  beforeRise: RadPoint | null
  highestAfter: RadPoint | null
  /** Peak / background, to 3 decimals as the adapter stored it, and the trigger it stays below. */
  peakRatio: number
  belowTrigger: boolean
}

export function radMoments(d: Sol242Data): RadMoments {
  const r = d.rad
  return {
    peak: r.peak,
    rise: r.first_rise,
    back: r.back_below_background,
    beforeRise: r.last_before_rise,
    highestAfter: r.highest_after_back,
    peakRatio: r.peak.ratio_to_background,
    belowTrigger: r.samples_above_threshold === 0 && r.peak.uGy_per_day <= r.threshold_uGy_per_day,
  }
}

// ---- STEREO-B HET --------------------------------------------------------------------------------------------------

export function hetChannel(d: Sol242Data, mev: number): HetChannel | null {
  return d.stereo_b.channels.find((c) => Math.abs(c.centre_MeV - mev) < 1e-6) ?? null
}

/** Hour centres on the axis (days) and each channel's hourly means there; 0 or no data -> null (a gap on a log axis). */
export function hetSeries(d: Sol242Data, mevs: readonly number[]): { x: number[]; values: Array<Array<number | null>>; hours: number[] } {
  const sb = d.stereo_b
  const t0 = Date.parse(sb.t0)
  const a = Date.parse(d.axis.start)
  const b = Date.parse(d.axis.stop)
  const hours: number[] = []
  for (let k = 0; k < sb.n_hours; k++) {
    const start = t0 + k * sb.hour_s * 1000
    if (start >= a && start + sb.hour_s * 1000 <= b) hours.push(k)
  }
  const x = hours.map((k) => (t0 + (k + 0.5) * sb.hour_s * 1000 - a) / DAY_MS)
  const values = mevs.map((m) => {
    const ch = hetChannel(d, m)
    return hours.map((k) => {
      const v = ch?.mean[k]
      return typeof v === 'number' && v > 0 ? v : null
    })
  })
  return { x, values, hours }
}

export interface HetPeak {
  mev: number
  /** Start of the UTC hour of the peak hourly mean. */
  hour: string
  /** Days on the axis of that hour's centre. */
  x: number
  mean: number
  quiet: number
  multiple: number
  firstAbove: string | null
}

/** Peak hourly mean and its multiple of the 8-9 April median, only for channels whose quiet median is above 0. */
export function hetPeaks(d: Sol242Data, mevs: readonly number[] = [80, 50]): HetPeak[] {
  const out: HetPeak[] = []
  for (const m of mevs) {
    const c = hetChannel(d, m)
    if (!c || !c.quiet_median || c.quiet_median <= 0 || c.peak.multiple_of_quiet === null) continue
    out.push({
      mev: c.centre_MeV,
      hour: c.peak.t,
      x: axisDays(d, c.peak.t) + d.stereo_b.hour_s / 2 / 86_400,
      mean: c.peak.mean,
      quiet: c.quiet_median,
      multiple: c.peak.multiple_of_quiet,
      firstAbove: c.first_hour_above_10x_quiet,
    })
  }
  return out
}

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' }

/** "10⁻⁴" at a decade of a log axis, "" between decades. */
export function decadeLabel(v: number): string {
  const e = Math.log10(v)
  if (!(Math.abs(e - Math.round(e)) < 1e-9)) return ''
  const n = Math.round(e)
  if (n === 0) return '1'
  if (n === 1) return '10'
  return `10${String(n).replace(/./g, (c) => SUP[c] ?? c)}`
}

/** Three significant figures; below 0.01 as "3.67×10⁻⁴". */
export function sci3(v: number): string {
  if (v === 0 || !Number.isFinite(v)) return String(v)
  if (Math.abs(v) >= 0.01) return String(Number(v.toPrecision(3)))
  const [m, e] = v.toExponential(2).split('e')
  return `${m}×10${String(Number(e)).replace(/./g, (c) => SUP[c] ?? c)}`
}

/** "HH:00" UTC of an hour start. */
export function hourUtc(iso: string): string {
  return `${iso.slice(11, 13)}:00`
}

// ---- JPL, NOAA, the paper ------------------------------------------------------------------------------------------

export function jplWindow(d: Sol242Data, id: string): JplWindow | null {
  return d.jpl.windows.find((w) => w.id === id) ?? null
}

/** True when the whole axis lies inside a published window (start date 00:00Z to the day after the end date). */
export function axisInside(d: Sol242Data, w: Pick<JplWindow, 'start_date' | 'end_date'>): boolean {
  const lo = Date.parse(`${w.start_date}T00:00:00Z`)
  const hi = Date.parse(`${w.end_date}T00:00:00Z`) + DAY_MS
  return lo <= Date.parse(d.axis.start) && Date.parse(d.axis.stop) <= hi
}

/** "4 April to 1 May" of a window (UTC calendar days). */
export function windowDays(w: Pick<JplWindow, 'start_date' | 'end_date'>): string {
  const f = (s: string) => {
    const t = new Date(`${s}T00:00:00Z`)
    return `${t.getUTCDate()} ${MONTHS_LONG[t.getUTCMonth()]}`
  }
  return `${f(w.start_date)} to ${f(w.end_date)}`
}

/** "10 to 13 April 2013": the axis as calendar days (the charts run from the first day's 00:00 to the last day's 00:00 UTC). */
export function axisText(d: Sol242Data): string {
  const a = new Date(Date.parse(d.axis.start))
  const b = new Date(Date.parse(d.axis.stop))
  const oneMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear()
  return oneMonth
    ? `${a.getUTCDate()} to ${b.getUTCDate()} ${MONTHS_LONG[b.getUTCMonth()]} ${b.getUTCFullYear()}`
    : `${a.getUTCDate()} ${MONTHS_LONG[a.getUTCMonth()]} to ${b.getUTCDate()} ${MONTHS_LONG[b.getUTCMonth()]} ${b.getUTCFullYear()}`
}

/** The day a quote was read by hand, from the snapshot's verification note ("... read by hand ... on 2026-11-14."). */
export function readByHandOn(w: Pick<JplWindow, 'quote_verification_note'>): string | null {
  return /read by hand[^.]*? on (\d{4}-\d{2}-\d{2})/.exec(w.quote_verification_note ?? '')?.[1] ?? null
}

/** "11 April" of an ISO time (UTC). */
export function dayMonth(iso: string): string {
  const t = new Date(Date.parse(iso))
  return `${t.getUTCDate()} ${MONTHS_LONG[t.getUTCMonth()]}`
}

/** "8–9 April": the quiet window of the HET medians (its stop is exclusive, so the last day is the day before). */
export function quietText(d: Sol242Data): string {
  const a = new Date(Date.parse(d.stereo_b.quiet.start))
  const b = new Date(Date.parse(d.stereo_b.quiet.stop) - DAY_MS)
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${dayMonth(a.toISOString())} to ${dayMonth(b.toISOString())}`
  return a.getUTCDate() === b.getUTCDate() ? dayMonth(a.toISOString()) : `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_LONG[b.getUTCMonth()]}`
}

/** The sol number the paper's Fig. 5 caption gives ("sol 242"), or null. */
export function solNumber(d: Sol242Data): string | null {
  return /\bsol (\d+)\b/.exec(fragment(d, 'fig5_caption') ?? '')?.[1] ?? null
}

/** "20 March 2013". */
export function dayLong(isoDate: string): string {
  const t = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`)
  return `${t.getUTCDate()} ${MONTHS_LONG[t.getUTCMonth()]} ${t.getUTCFullYear()}`
}

export function fragment(d: Sol242Data, id: string): string | null {
  if (!d.literature.fragments_verified_this_build) return null
  return d.literature.fragments.find((f) => f.id === id)?.text ?? null
}

/** NOAA's list entry with the start of `copy`, read from swpc_spe_list; the snapshot's build-time copy when the list is absent. */
export function noaaEntry(list: SpeListLike | null, copy: SpeEntry): SpeEntry | null {
  if (!list) return copy
  return list.events.find((e) => e.start === copy.start) ?? null
}

/** The scenario's conjunction year, from the modelled window that holds the scenario's "now" (useComms). */
export function heroYear(windowStartUtc: string | null | undefined): string | null {
  return windowStartUtc && /^\d{4}-/.test(windowStartUtc) ? windowStartUtc.slice(0, 4) : null
}

/** Every published window that applies to Curiosity: how many RAD samples each holds (min and max). */
export function moratoriumRange(d: Sol242Data): { n: number; min: number; max: number; since: string } | null {
  const ws = d.moratoria.windows.filter((w) => w.applies_to_curiosity)
  if (!ws.length) return null
  const counts = ws.map((w) => w.n_samples)
  const since = ws.map((w) => w.start_date).sort()[0]
  return { n: ws.length, min: Math.min(...counts), max: Math.max(...counts), since: since.slice(0, 4) }
}
