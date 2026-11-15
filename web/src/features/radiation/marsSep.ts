// Pure helpers for the Mars-surface SEP record (snapshot hapi_msl_rad_sep_events): the MSL RAD team's
// published nowcast rule (Loewe et al. 2025) replayed on Curiosity's whole public dose record, the
// 20 May 2024 timeline, the replay-vs-paper table and the context line under the habitat dose panel.
// Every number shown comes from the snapshot; nothing here is wired into the engine or the hero.

export interface SepMetrics {
  onset: string
  confirmation: { t: string; after_onset_min: number; above_threshold: boolean }
  peak: { t: string; uGy_per_day: number; after_onset_min: number; ratio_to_background: number }
  end: string
  shelter_min: number
  time_to_peak_min: number
  lead_time_min: number | null
  total_uGy: number
  n_samples: number
  max_gap_min: number
}

export interface LightTime {
  one_way_min: number | null
  note?: string
}

/**
 * A sample above 1.25 x background that the next sample did not confirm (the paper's cross-check), so it is not
 * an onset: the next one was below the threshold, or came 3 h or more later (the scan's pair-gap limit).
 */
export interface UnconfirmedSample {
  t: string
  ratio_to_background: number
  next: { t: string; ratio_to_background: number; after_min: number; above_threshold: boolean } | null
}

export interface ReplayTriggered extends SepMetrics {
  triggered: true
  background_uGy_per_day: number
  threshold_uGy_per_day: number
  background_n_samples: number
  onset_after_listed_date_h: number
  light_time?: LightTime
  /** Unconfirmed samples in the 48-h search before the onset (absent in snapshots built before the cross-check). */
  unconfirmed?: UnconfirmedSample[]
}

export interface ReplayNotTriggered {
  triggered: false
  background_uGy_per_day: number
  threshold_uGy_per_day: number
  background_n_samples: number
  max_ratio_to_background: number | null
  max_at: string | null
  search_window_samples: number
  samples_per_day: Record<string, number>
  median_spacing_min: number | null
  /** Samples above the threshold in the 48-h search that the next sample did not confirm. */
  unconfirmed?: UnconfirmedSample[]
}

export type Replay = ReplayTriggered | ReplayNotTriggered

export interface PaperValues {
  triggered: boolean
  shelter_min?: number
  time_to_peak_min?: number
  lead_time_min?: number
  total_uGy?: number
}

export type RowStatus = 'reproduced' | 'deviates' | 'not_reproduced' | 'agrees_not_triggered' | 'replay_triggered_paper_not'

export interface Comparison {
  status: RowStatus
  total_pct?: number
  time_to_peak_diff_min?: number
  shelter_diff_min?: number
  lead_time_diff_min?: number | null
}

export interface Table1Row {
  paper_date: string
  paper_row: string
  paper: PaperValues
  replay: Replay
  comparison: Comparison
  scan_trigger: number | null
}

export type TriggerFlag = 'in_paper_table' | 'not_in_paper_table' | 'after_paper_table'

export interface DonkiNear {
  in_window: boolean
  note?: string
  observed?: Array<{ t: string; instruments: string[] }>
  n_model_entries?: number
  last_before_onset?: string | null
  first_after_onset?: string | null
}

export interface ScanTrigger extends SepMetrics {
  n: number
  flag: TriggerFlag
  paper_date: string | null
  background_uGy_per_day: number
  background_n_samples: number
  threshold_uGy_per_day: number
  light_time: LightTime
  donki: DonkiNear
}

export interface PaperQuote {
  id: string
  rule: boolean
  text: string
}

export interface SepEventsData {
  explainer: string
  dataset: { server: string; id: string; parameter: string; description: string; units: string; title?: string }
  record: {
    first_sample: string
    last_sample: string
    n_samples: number
    median_spacing_min: number | null
    gaps_over_2_days: Array<{ from: string; to: string; days: number }>
    pre_record_probe: { start: string; stop: string; all_empty: boolean; hapi_code: number }
  }
  rule: {
    threshold_factor: number
    background_days: number
    lead_fraction: number
    search_days: number
    method: string[]
    scan: { min_background_samples: number; max_pair_gap_s: number; method: string; chip: string; source: Record<string, unknown> }
    reproduce: { dose_tol_pct: number; time_to_peak_tol_min: number; chip: string; source: Record<string, unknown> }
    donki_neighbour_days: number
    chip: string
  }
  literature: {
    title: string
    authors: string[]
    arxiv_id: string
    arxiv_html: string
    arxiv_abs: string
    doi: string
    doi_url: string
    journal: { journal: string; volume: string; issue?: string; article_number: string; publisher?: string; published?: string; authors_crossref?: string[] }
    numbers_from: string
    quotes: PaperQuote[]
    quotes_verified_this_build: boolean
    table1_surface_rows: string[]
  }
  paper_record_end: string
  table1: Table1Row[]
  table1_counts: Partial<Record<RowStatus, number>>
  scan: { n_triggers: number; triggers: ScanTrigger[]; peak_ratio_range: { min: number; max: number } | null; flag_counts: Record<TriggerFlag, number> }
  may_2024: { paper_date: string; window: { start: string; stop: string }; t0: string; t_s: number[]; uGy_per_day: number[]; donki_gap: { start: string | null; stop: string | null } }
  donki: { snapshot: string; coverage: { start: string; stop: string }; retrieved_at: string; instrument_prefixes: string[]; note: string }
  light_time: { source: string; url: string; label: string }
}

export const SEP_SNAPSHOT_ID = 'hapi_msl_rad_sep_events'
const MIN_MS = 60_000
const DAY_MS = 86_400_000
/** A NOAA storm at Earth and a Table 1 row "fall together" when their UTC dates are at most this many days apart (design choice). */
export const STORM_MATCH_DAYS = 2

/** Minutes -> the paper's own duration format, "01d 17h:55m" (rounded to the minute, as the adapter does). */
export function fmtDhm(minutes: number): string {
  const total = Math.floor(minutes + 0.5)
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d)}d ${two(h)}h:${two(m)}m`
}

/** "2024-05-13T18:07:00Z" -> "2024-05-13T18:07Z" (the minute precision DONKI logs). */
export function isoMinute(iso: string): string {
  return iso.replace(/:\d{2}(\.\d+)?Z$/, 'Z')
}

/** "HH:MM:SS" UTC of an ISO time. */
export function hmsUtc(iso: string): string {
  return iso.slice(11, 19)
}

export function minutesBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / MIN_MS
}

// ---- the 20 May 2024 timeline ------------------------------------------------------------------------------

export interface MayTimeline {
  row: Table1Row
  replay: ReplayTriggered
  /** Minutes from the onset sample, one per native sample inside [xMin, xMax]. */
  x: number[]
  e: number[]
  background: number
  threshold: number
  confirmationMin: number
  peakMin: number
  peakValue: number
  peakRatio: number
  /** One-way light time (minutes) that day, and the two lower-bound Earth ticks. */
  oneWayMin: number | null
  earthSeesMin: number | null
  earliestReplyMin: number | null
  xMin: number
  xMax: number
}

/** The zoomed timeline around the 20 May 2024 onset (default 90 min before to 180 min after). */
export function mayTimeline(d: SepEventsData, before = 90, after = 180): MayTimeline | null {
  const row = d.table1.find((r) => r.paper_date === d.may_2024.paper_date)
  if (!row || !row.replay.triggered) return null
  const rp = row.replay
  const t0 = Date.parse(d.may_2024.t0)
  const onset = Date.parse(rp.onset)
  const x: number[] = []
  const e: number[] = []
  d.may_2024.t_s.forEach((s, i) => {
    const m = (t0 + s * 1000 - onset) / MIN_MS
    if (m >= -before && m <= after) {
      x.push(m)
      e.push(d.may_2024.uGy_per_day[i])
    }
  })
  const ow = rp.light_time?.one_way_min ?? null
  return {
    row,
    replay: rp,
    x,
    e,
    background: rp.background_uGy_per_day,
    threshold: rp.threshold_uGy_per_day,
    confirmationMin: minutesBetween(rp.onset, rp.confirmation.t),
    peakMin: minutesBetween(rp.onset, rp.peak.t),
    peakValue: rp.peak.uGy_per_day,
    peakRatio: rp.peak.ratio_to_background,
    oneWayMin: ow,
    earthSeesMin: ow,
    earliestReplyMin: ow === null ? null : 2 * ow,
    xMin: -before,
    xMax: after,
  }
}

// ---- the replay-vs-paper table -----------------------------------------------------------------------------

export const STATUS_TEXT: Record<RowStatus, string> = {
  reproduced: 'reproduces',
  deviates: 'deviates',
  not_reproduced: 'not reproduced',
  agrees_not_triggered: 'not triggered in either',
  replay_triggered_paper_not: 'replay only',
}

/**
 * Display order: the paper's triggered rows by its total SEP dose (largest first), then the rows it lists
 * as not triggered, by date. The order is stated next to the table; every row is shown (the first three
 * open, the rest in an expander).
 */
export function tableRows(d: SepEventsData): Table1Row[] {
  const trig = d.table1.filter((r) => r.paper.triggered).sort((a, b) => (b.paper.total_uGy ?? 0) - (a.paper.total_uGy ?? 0))
  const not = d.table1.filter((r) => !r.paper.triggered).sort((a, b) => a.paper_date.localeCompare(b.paper_date))
  return [...trig, ...not]
}

export interface TableSummary {
  rows: number
  bothTriggered: number
  counts: Record<RowStatus, number>
}

export function tableSummary(d: SepEventsData): TableSummary {
  const counts: Record<RowStatus, number> = { reproduced: 0, deviates: 0, not_reproduced: 0, agrees_not_triggered: 0, replay_triggered_paper_not: 0 }
  for (const r of d.table1) counts[r.comparison.status] += 1
  return { rows: d.table1.length, bothTriggered: d.table1.filter((r) => r.paper.triggered && r.replay.triggered).length, counts }
}

/** Rows by status, in date order (for the one-line summary under the table). */
export function rowsWithStatus(d: SepEventsData, status: RowStatus): Table1Row[] {
  return d.table1.filter((r) => r.comparison.status === status).sort((a, b) => a.paper_date.localeCompare(b.paper_date))
}

/** The samples of a row that crossed 1.25 x background without the next sample confirming them. */
export function unconfirmedOf(r: Table1Row): UnconfirmedSample[] {
  return r.replay.unconfirmed ?? []
}

/** "one sample at 2014-01-06T12:45:21Z reached 1.251 × background and the next did not confirm it" (or why it could not). */
export function unconfirmedText(u: UnconfirmedSample, maxPairGapS: number): string {
  const head = `one sample at ${u.t} reached ${u.ratio_to_background.toFixed(3)} × background and the next`
  if (!u.next) return `${head} is past the end of the record`
  if (u.next.above_threshold) return `${head}, ${(u.next.after_min / 60).toFixed(1)} h later, came after the ${maxPairGapS / 3600} h confirmation limit`
  return `${head} did not confirm it`
}

// ---- whole-record scan, DONKI and the context line ---------------------------------------------------------

export function triggersWith(d: SepEventsData, flag: TriggerFlag): ScanTrigger[] {
  return d.scan.triggers.filter((t) => t.flag === flag)
}

/** Peak-to-own-background multiples over every scan trigger, recomputed from the triggers themselves. */
export function peakRatioRange(d: SepEventsData): { n: number; min: number; max: number } | null {
  const r = d.scan.triggers.map((t) => t.peak.ratio_to_background).filter((v) => Number.isFinite(v))
  if (!r.length) return null
  return { n: r.length, min: Math.min(...r), max: Math.max(...r) }
}

/** The DONKI gap around the 20 May 2024 storm: last logged SEP entry before its onset, first after it. */
export function donkiGap(d: SepEventsData): { start: string; stop: string } | null {
  const g = d.may_2024.donki_gap
  return g.start && g.stop ? { start: isoMinute(g.start), stop: isoMinute(g.stop) } : null
}

/** "1.3" for 1.309: multiples are printed to one decimal everywhere on this block. */
export function oneDecimal(x: number): string {
  return (Math.round(x * 10) / 10).toFixed(1)
}

/** One verified quote of the paper by id (null when the snapshot does not carry it). */
export function quoteById(d: SepEventsData, id: string): string | null {
  return d.literature.quotes.find((q) => q.id === id)?.text ?? null
}

/** The rule's verbatim sentences that the page prints in the rule expander, in the paper's order. */
export function ruleQuotes(d: SepEventsData): PaperQuote[] {
  return d.literature.quotes.filter((q) => q.rule)
}

/** The first author's family name, as the paper's page prints it (never typed here). */
export function firstAuthorFamily(d: SepEventsData): string {
  const first = d.literature.authors[0] ?? ''
  return first.split(' ').slice(-1)[0] ?? first
}

// ---- NOAA's S3 storms at Earth on rows of the RAD team's table ----------------------------------------------

/** The fields of NOAA's solar proton event list (snapshot swpc_spe_list) that the join reads. */
export interface SpeListLike {
  events: Array<{ start: string; peak_pfu: number | null; s_level?: number }>
  list_last_start?: string
}

export interface StormOnRow {
  /** NOAA's event start (UTC) and printed peak at >=10 MeV. */
  start: string
  peak_pfu: number
  /** The nearest Table 1 surface row within STORM_MATCH_DAYS of it, and the gap in whole UTC days. */
  row: Table1Row
  gapDays: number
}

const utcDay = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS)

/**
 * NOAA's S3-or-above storms at Earth that start inside Curiosity's RAD record, and those that fall within `windowDays`
 * of a row of the paper's Table 1 (nearest row; UTC dates). A date match is not the same event: it says only that a
 * storm at Earth and a row at Gale share a few days.
 */
export function s3StormsOnTable(d: SepEventsData, list: SpeListLike, windowDays = STORM_MATCH_DAYS): { inRecord: number; listEnd: string | null; matches: StormOnRow[] } {
  const inRecord = list.events.filter(
    (e) => (e.s_level ?? 0) >= 3 && typeof e.peak_pfu === 'number' && e.start >= d.record.first_sample && e.start <= d.record.last_sample,
  )
  const matches: StormOnRow[] = []
  for (const e of inRecord) {
    let best: StormOnRow | null = null
    for (const row of d.table1) {
      const gap = Math.abs(utcDay(row.paper_date) - utcDay(e.start))
      if (gap <= windowDays && (!best || gap < best.gapDays)) best = { start: e.start, peak_pfu: e.peak_pfu as number, row, gapDays: gap }
    }
    if (best) matches.push(best)
  }
  return { inRecord: inRecord.length, listEnd: list.list_last_start ?? null, matches }
}
