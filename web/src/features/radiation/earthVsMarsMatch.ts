// Earth's proton lists against the storms measured at Gale (#/radiation, Mars surface only). A pure cross-match of
// three shipped snapshots: the RAD team's Table 1 and the whole-record replay of its rule (hapi_msl_rad_sep_events),
// NOAA's list of solar proton events (swpc_spe_list) and DONKI's SEP entries (swpc_sep_events). Dates are matched,
// never events: a match says only that a storm at Gale and an entry in an Earth list fall within a few UTC days of
// each other. Nothing here feeds the engine, the rules, the hero or the scenario. The stdlib twin that recomputes
// every number is ingest/tests/test_earth_vs_mars.py.
import { STORM_MATCH_DAYS, s3StormsOnTable, stormTime, utcDay } from './marsSep'
import type { ScanTrigger, SepEventsData, SpeListLike, Table1Row } from './marsSep'

/** DONKI's instrument string for the GOES ≥10 MeV channel: its entries are the Earth proton list after 2024. */
export const GOES_P_10MEV = 'GOES-P: SEISS >10 MeV'

/** The windows of the sensitivity table, in whole UTC days (STORM_MATCH_DAYS is the one the page leads with). */
export const SENSITIVITY_DAYS = [1, 2, 3, 5] as const

/** An Earth event is left out of the Earth-side count when its window touches a RAD gap longer than this (days). */
export const RAD_GAP_DAYS = 2

/** The fields of the DONKI SEP snapshot (swpc_sep_events) the match reads: its entries and its coverage. */
export interface DonkiLike {
  events: Array<{ event_time: string; instruments: string[] }>
  coverage: { start: string; stop: string }
}

export type Catalogue = 'noaa' | 'donki'

export interface EarthEvent {
  catalogue: Catalogue
  /** Where the event is placed: NOAA's maximum (else its start), DONKI's event time. */
  t: string
  /** NOAA rows only: the list's start, its printed peak at ≥10 MeV and its S-level. */
  start?: string
  peak_pfu?: number | null
  s_level?: number
}

export interface StormMatch {
  row: Table1Row
  /** The paper's total SEP dose for this row (µGy, Table 1). */
  dose_uGy: number
  /** The Earth events of the span's list within the window of the row's date, in time order. */
  earth: EarthEvent[]
}

export interface SpanResult {
  catalogue: Catalogue
  from: string
  to: string
  /** Earth events of the list inside the span. */
  earthCount: number
  /** Those left out of the Earth-side count: their ±window touches a RAD gap longer than RAD_GAP_DAYS. */
  earthExcluded: EarthEvent[]
  /** The other Earth events that fall within the window of a trigger of the whole-record replay. */
  earthNearTrigger: number
  /** Rows of Table 1 inside the span where the paper's rule triggered (the storms listed at Gale). */
  table1Triggered: number
  withEarth: StormMatch[]
  withoutEarth: StormMatch[]
  /** Triggers of the whole-record replay inside the span (onset date), and those with an Earth event in the window. */
  replayTriggers: number
  replayWithEarth: number
  /** The paper's total SEP dose over the span's storms, and over those with no Earth event in the window (µGy). */
  dose_uGy: number
  doseNoEarth_uGy: number
}

export interface Totals {
  n: number
  withEarth: number
  dose_uGy: number
  doseNoEarth_uGy: number
  /** doseNoEarth_uGy as a percentage of dose_uGy (null when there is no dose). */
  share: number | null
}

export interface SensitivityRow extends Totals {
  days: number
  /** Earth events counted on the Earth side at this window, and those within the window of a replay trigger. */
  earthCounted: number
  earthNearTrigger: number
  /** The Earth events this window leaves out of the Earth side (their window touches a RAD gap). */
  excluded: EarthEvent[]
}

export interface Nearest {
  t: string
  days: number
}

export interface CrossMatch {
  windowDays: number
  /** NOAA's list first, then DONKI's GOES-P entries; a span is absent when its list is not in this build. */
  spans: SpanResult[]
  /** The two spans added (two different lists, each matched on its own). */
  combined: Totals
  earthCounted: number
  earthNearTrigger: number
  replayTriggers: number
  replayWithEarth: number
  /** The combined figures without the storm of largest listed dose. */
  withoutLargest: (Totals & { row: Table1Row }) | null
  /** Rows of Table 1 where the rule triggered but this build ships no Earth list for the date: never counted. */
  outsideSpans: Table1Row[]
  sensitivity: SensitivityRow[]
  /** The storm with no Earth event that carries the largest listed dose, and the nearest entries of its list. */
  spotlight: {
    match: StormMatch
    catalogue: Catalogue
    before: Nearest | null
    after: Nearest | null
    /** Its dose as a share of the combined dose with no Earth event (%). */
    shareOfNoEarth: number | null
    /**
     * True when no surface row of Table 1 (triggered or not, in a span or not) lists a larger dose. The snapshot ships
     * only the paper's 16 Martian-surface rows; its deep-space (cruise) rows are not compared, and one is larger.
     */
    largestAtGale: boolean
  } | null
  /** NOAA's S3-or-above storms at Earth during the RAD record that fall on a row of Table 1 (marsSep.ts). */
  s3: ReturnType<typeof s3StormsOnTable>
}

const ms = (iso: string) => Date.parse(iso)
const gapDays = (a: string, b: string) => Math.abs(utcDay(a) - utcDay(b))
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const totals = (storms: StormMatch[]): Totals => {
  const dose = sum(storms.map((s) => s.dose_uGy))
  const none = sum(storms.filter((s) => !s.earth.length).map((s) => s.dose_uGy))
  return { n: storms.length, withEarth: storms.filter((s) => s.earth.length).length, dose_uGy: dose, doseNoEarth_uGy: none, share: dose > 0 ? (100 * none) / dose : null }
}

/** The RAD record's longest gap (the 215.7 days before March 2013, when iSWA's record really starts). */
export function longestRadGap(sep: SepEventsData): { from: string; to: string; days: number } | null {
  return sep.record.gaps_over_2_days.reduce<{ from: string; to: string; days: number } | null>((a, g) => (a && a.days >= g.days ? a : g), null)
}

export interface Span {
  from: string
  to: string
  events: EarthEvent[]
}

/** The two spans where an Earth proton list ships, each with its own events (null when its list is missing). */
export function spans(sep: SepEventsData, list: SpeListLike | null, donki: DonkiLike | null): { noaa: Span | null; donki: Span | null } {
  let noaa: Span | null = null
  if (list?.list_last_start) {
    const lead = longestRadGap(sep)
    const from = lead && ms(lead.to) < ms(list.list_last_start) ? lead.to : sep.record.first_sample
    const to = list.list_last_start
    // Placed at its maximum; every row of the list starts on or before the list's last start.
    const events = list.events
      .filter((e) => ms(stormTime(e)) >= ms(from) && ms(e.start) <= ms(to))
      .map((e): EarthEvent => ({ catalogue: 'noaa', t: stormTime(e), start: e.start, peak_pfu: e.peak_pfu, s_level: e.s_level }))
    noaa = { from, to, events }
  }
  let goes: Span | null = null
  if (donki) {
    const from = donki.coverage.start
    const to = ms(donki.coverage.stop) <= ms(sep.record.last_sample) ? donki.coverage.stop : sep.record.last_sample
    const events = donki.events
      .filter((e) => e.instruments.includes(GOES_P_10MEV) && ms(e.event_time) >= ms(from) && ms(e.event_time) <= ms(to))
      .map((e): EarthEvent => ({ catalogue: 'donki', t: e.event_time }))
    goes = { from, to, events }
  }
  return { noaa, donki: goes }
}

function matchSpan(sep: SepEventsData, catalogue: Catalogue, span: Span, w: number): SpanResult {
  const inSpan = (iso: string) => utcDay(iso) >= utcDay(span.from) && utcDay(iso) <= utcDay(span.to)
  const events = [...span.events].sort((a, b) => ms(a.t) - ms(b.t))
  const near = (iso: string) => events.filter((e) => gapDays(e.t, iso) <= w)
  const storms = sep.table1
    .filter((r) => r.paper.triggered && typeof r.paper.total_uGy === 'number' && inSpan(r.paper_date))
    .map((row): StormMatch => ({ row, dose_uGy: row.paper.total_uGy as number, earth: near(row.paper_date) }))
  const gaps = sep.record.gaps_over_2_days.filter((g) => g.days > RAD_GAP_DAYS)
  const touchesGap = (e: EarthEvent) => gaps.some((g) => utcDay(g.from) <= utcDay(e.t) + w && utcDay(g.to) >= utcDay(e.t) - w)
  const excluded = events.filter(touchesGap)
  const counted = events.filter((e) => !touchesGap(e))
  const all: ScanTrigger[] = sep.scan.triggers
  const triggers = all.filter((t) => inSpan(t.onset))
  const t = totals(storms)
  return {
    catalogue,
    from: span.from,
    to: span.to,
    earthCount: events.length,
    earthExcluded: excluded,
    earthNearTrigger: counted.filter((e) => all.some((x) => gapDays(e.t, x.onset) <= w)).length,
    table1Triggered: storms.length,
    withEarth: storms.filter((s) => s.earth.length),
    withoutEarth: storms.filter((s) => !s.earth.length),
    replayTriggers: triggers.length,
    replayWithEarth: triggers.filter((x) => near(x.onset).length).length,
    dose_uGy: t.dose_uGy,
    doseNoEarth_uGy: t.doseNoEarth_uGy,
  }
}

function matchAll(sep: SepEventsData, list: SpeListLike | null, donki: DonkiLike | null, w: number) {
  const sp = spans(sep, list, donki)
  const results: SpanResult[] = []
  if (sp.noaa) results.push(matchSpan(sep, 'noaa', sp.noaa, w))
  if (sp.donki) results.push(matchSpan(sep, 'donki', sp.donki, w))
  const storms = results.flatMap((s) => [...s.withEarth, ...s.withoutEarth])
  return { sp, results, storms }
}

/**
 * Each storm the RAD team lists at Gale (a Table 1 row where its rule triggered) against the Earth proton list that
 * covers its date: NOAA's list (2013 to its last event, September 2017) or DONKI's GOES-P ≥10 MeV entries (2024 on).
 * A storm "has an Earth event" when an event of that list is at most `windowDays` UTC days from the row's date (the
 * window is a design choice). Rows outside both spans are listed, never counted; the two lists are never pooled
 * without saying so.
 */
export function crossMatch(sep: SepEventsData, speList: SpeListLike | null, donki: DonkiLike | null, windowDays: number = STORM_MATCH_DAYS): CrossMatch {
  const { sp, results, storms } = matchAll(sep, speList, donki, windowDays)
  const combined = totals(storms)
  const largest = storms.reduce<StormMatch | null>((a, s) => (a && a.dose_uGy >= s.dose_uGy ? a : s), null)
  const withoutLargest = largest ? { ...totals(storms.filter((s) => s !== largest)), row: largest.row } : null
  const inSomeSpan = (d: string) => results.some((s) => utcDay(d) >= utcDay(s.from) && utcDay(d) <= utcDay(s.to))
  const outsideSpans = sep.table1.filter((r) => r.paper.triggered && !inSomeSpan(r.paper_date))
  const sensitivity = SENSITIVITY_DAYS.map((days): SensitivityRow => {
    const at = matchAll(sep, speList, donki, days)
    return {
      days,
      ...totals(at.storms),
      earthCounted: sum(at.results.map((s) => s.earthCount - s.earthExcluded.length)),
      earthNearTrigger: sum(at.results.map((s) => s.earthNearTrigger)),
      excluded: at.results.flatMap((s) => s.earthExcluded),
    }
  })
  const top = results
    .flatMap((s) => s.withoutEarth.map((m) => ({ m, catalogue: s.catalogue })))
    .reduce<{ m: StormMatch; catalogue: Catalogue } | null>((a, x) => (a && a.m.dose_uGy >= x.m.dose_uGy ? a : x), null)
  let spotlight: CrossMatch['spotlight'] = null
  if (top) {
    const events = (top.catalogue === 'noaa' ? sp.noaa : sp.donki)?.events ?? []
    const d = top.m.row.paper_date
    const before = events.filter((e) => utcDay(e.t) < utcDay(d)).sort((a, b) => ms(b.t) - ms(a.t))[0]
    const after = events.filter((e) => utcDay(e.t) > utcDay(d)).sort((a, b) => ms(a.t) - ms(b.t))[0]
    spotlight = {
      match: top.m,
      catalogue: top.catalogue,
      before: before ? { t: before.t, days: gapDays(before.t, d) } : null,
      after: after ? { t: after.t, days: gapDays(after.t, d) } : null,
      shareOfNoEarth: combined.doseNoEarth_uGy > 0 ? (100 * top.m.dose_uGy) / combined.doseNoEarth_uGy : null,
      largestAtGale: sep.table1.every((r) => (r.paper.total_uGy ?? 0) <= top.m.dose_uGy),
    }
  }
  return {
    windowDays,
    spans: results,
    combined,
    earthCounted: sum(results.map((s) => s.earthCount - s.earthExcluded.length)),
    earthNearTrigger: sum(results.map((s) => s.earthNearTrigger)),
    replayTriggers: sum(results.map((s) => s.replayTriggers)),
    replayWithEarth: sum(results.map((s) => s.replayWithEarth)),
    withoutLargest,
    outsideSpans,
    sensitivity,
    spotlight,
    s3: s3StormsOnTable(sep, speList ?? { events: [] }, windowDays),
  }
}
