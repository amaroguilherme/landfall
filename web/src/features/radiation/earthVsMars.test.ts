// Earth's proton lists against the storms measured at Gale (#/radiation, Mars): every number the table prints,
// recomputed from the REAL shipped snapshots (never regenerated here) and pinned (µGy to 0.01, shares to 0.1 pp,
// counts exact). The stdlib twin ingest/tests/test_earth_vs_mars.py recomputes the same numbers in Python. Also
// a wording guard on the rendered block: no "same event", no "missed", no cause, and n beside every share.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../../app/data'
import { EarthVsMarsView } from './EarthVsMars'
import { GOES_P_10MEV, RAD_GAP_DAYS, SENSITIVITY_DAYS, crossMatch, longestRadGap } from './earthVsMarsMatch'
import type { CrossMatch, DonkiLike, StormMatch } from './earthVsMarsMatch'
import { STORM_MATCH_DAYS, donkiGap } from './marsSep'
import type { SepEventsData, SpeListLike } from './marsSep'
import type { DonkiData } from './model'

const files = import.meta.glob<unknown>('../../../public/data/{hapi_msl_rad_sep_events,swpc_spe_list,swpc_sep_events}.json', {
  eager: true,
  import: 'default',
})
const sepSnap = files['../../../public/data/hapi_msl_rad_sep_events.json'] as Snapshot<SepEventsData>
const speSnap = files['../../../public/data/swpc_spe_list.json'] as Snapshot<SpeListLike>
const donkiSnap = files['../../../public/data/swpc_sep_events.json'] as Snapshot<DonkiData>
const sep = sepSnap.data
const list = speSnap.data
const donki: DonkiLike = { events: donkiSnap.data.events, coverage: donkiSnap.coverage as { start: string; stop: string } }
const x = crossMatch(sep, list, donki)
const [a, b] = x.spans

const r2 = (v: number) => Math.round(v * 100) / 100
const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)
const dates = (ms: StormMatch[]) => ms.map((m) => m.row.paper_date)

/** Visible text of the rendered markup (tags removed without adding spaces, entities decoded, whitespace collapsed). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

describe('the spans where an Earth proton list ships', () => {
  it('uses the shared 2-day design-choice window and DONKI’s GOES-P ≥10 MeV instrument string', () => {
    expect(STORM_MATCH_DAYS).toBe(2)
    expect(x.windowDays).toBe(2)
    expect(RAD_GAP_DAYS).toBe(2)
    expect([...SENSITIVITY_DAYS]).toEqual([1, 2, 3, 5])
    expect(GOES_P_10MEV).toBe('GOES-P: SEISS >10 MeV')
    expect(donki.events.length).toBe(214)
    expect(donki.events.filter((e) => e.instruments.includes(GOES_P_10MEV)).length).toBe(28)
  })
  it('reads both spans from the snapshots: NOAA’s list from the end of RAD’s 215.7-day gap, DONKI to the last RAD sample', () => {
    expect(longestRadGap(sep)).toEqual({ from: '2012-08-18T11:41:51Z', to: '2013-03-22T04:34:39Z', days: 215.7 })
    expect(x.spans.map((s) => [s.catalogue, s.from, s.to])).toEqual([
      ['noaa', '2013-03-22T04:34:39Z', '2017-09-10T16:45:00Z'],
      ['donki', '2024-01-01T00:00:00Z', '2026-11-12T23:49:21Z'],
    ])
    expect(a.to).toBe(list.list_last_start)
    expect(b.to).toBe(sep.record.last_sample)
    // the RAD adapter recorded the DONKI copy it used: the same coverage as the shipped DONKI snapshot
    expect(sep.donki.coverage).toEqual({ start: donkiSnap.coverage.start, stop: donkiSnap.coverage.stop })
    expect(sep.paper_record_end).toBe('2024-09-09')
  })
})

describe('span A: NOAA’s list of solar proton events, 2013 to September 2017', () => {
  it('20 NOAA rows, 4 at S3 or above', () => {
    expect(a.earthCount).toBe(20)
    const s3 = list.events.filter((e) => (e.s_level ?? 0) >= 3 && Date.parse(e.max ?? e.start) >= Date.parse(a.from))
    expect(s3.length).toBe(4)
  })
  it('Table 1 triggered 5: with an Earth row 3, without 2 (2013-10-10, 2014-09-02)', () => {
    expect(a.table1Triggered).toBe(5)
    expect(a.withEarth.map((m) => [m.row.paper_date, m.earth.map((e) => e.t)])).toEqual([
      ['2013-04-10', ['2013-04-11T16:45:00Z']],
      ['2014-09-10', ['2014-09-12T15:55:00Z']],
      ['2017-09-10', ['2017-09-08T00:35:00Z', '2017-09-11T11:45:00Z']],
    ])
    expect(a.withoutEarth.map((m) => [m.row.paper_date, m.dose_uGy])).toEqual([
      ['2013-10-10', 32.32],
      ['2014-09-02', 125.93],
    ])
  })
  it('158.25 of 431.35 µGy (36.7 %) had no Earth row; 4 replay triggers, 1 with an Earth row', () => {
    expect(r2(a.doseNoEarth_uGy)).toBe(158.25)
    expect(r2(a.dose_uGy)).toBe(431.35)
    expect(r1((100 * a.doseNoEarth_uGy) / a.dose_uGy)).toBe(36.7)
    expect(a.replayTriggers).toBe(4)
    expect(a.replayWithEarth).toBe(1)
  })
})

describe('span B: DONKI’s GOES-P ≥10 MeV entries, 2024 to the last RAD sample', () => {
  it('28 GOES-P entries; Table 1 triggered 4, only 2024-07-22 with an entry (2024-07-23T03:00Z)', () => {
    expect(b.earthCount).toBe(28)
    expect(b.table1Triggered).toBe(4)
    expect(b.withEarth.map((m) => [m.row.paper_date, m.earth.map((e) => e.t)])).toEqual([['2024-07-22', ['2024-07-23T03:00:00Z']]])
    expect(dates(b.withoutEarth)).toEqual(['2024-05-20', '2024-09-02', '2024-09-05'])
  })
  it('1,758.96 of 1,816.94 µGy (96.8 %) had none; 7 replay triggers, 4 with an entry', () => {
    expect(r2(b.doseNoEarth_uGy)).toBe(1758.96)
    expect(r2(b.dose_uGy)).toBe(1816.94)
    expect(r1((100 * b.doseNoEarth_uGy) / b.dose_uGy)).toBe(96.8)
    expect(b.replayTriggers).toBe(7)
    expect(b.replayWithEarth).toBe(4)
  })
})

describe('combined, the largest storm, and the rows outside both spans', () => {
  it('n = 9 storms, 4 with an Earth event; 1,917.21 of 2,248.29 µGy (85.3 %) had none', () => {
    expect(x.combined.n).toBe(9)
    expect(x.combined.withEarth).toBe(4)
    expect(r2(x.combined.doseNoEarth_uGy)).toBe(1917.21)
    expect(r2(x.combined.dose_uGy)).toBe(2248.29)
    expect(r1(x.combined.share)).toBe(85.3)
    expect(x.replayTriggers).toBe(11)
    expect(x.replayWithEarth).toBe(5)
  })
  it('without 2024-05-20 (1,730.55 µGy): 186.66 of 517.74 µGy (36.1 %, n = 8)', () => {
    const w = x.withoutLargest!
    expect(w.row.paper_date).toBe('2024-05-20')
    expect(w.row.paper.total_uGy).toBe(1730.55)
    expect(w.n).toBe(8)
    expect(r2(w.doseNoEarth_uGy)).toBe(186.66)
    expect(r2(w.dose_uGy)).toBe(517.74)
    expect(r1(w.share)).toBe(36.1)
  })
  it('2024-05-20 has the largest dose of the 16 Martian-surface rows the snapshot ships (triggered or not, in a span or not)', () => {
    expect(sep.table1.length).toBe(16)
    expect(sep.table1.map((r) => r.paper_date)).toEqual(sep.literature.table1_surface_rows.map((r) => r.slice(0, 10)))
    const top = Math.max(...sep.table1.map((r) => r.paper.total_uGy ?? 0))
    expect(top).toBe(1730.55)
    expect(sep.table1.filter((r) => r.paper.total_uGy === top).map((r) => r.paper_date)).toEqual(['2024-05-20'])
    // a larger dose on any surface row, even one outside both spans, drops the claim from the line
    const bigger: SepEventsData = { ...sep, table1: sep.table1.map((r) => (r.paper_date === '2022-02-15' ? { ...r, paper: { ...r.paper, total_uGy: 2000 } } : r)) }
    const m = crossMatch(bigger, list, donki)
    expect(m.spotlight!.match.row.paper_date).toBe('2024-05-20')
    expect(m.spotlight!.largestAtGale).toBe(false)
    expect(text(renderToStaticMarkup(createElement(EarthVsMarsView, { match: m, sep: bigger })))).toContain('one storm, 20 May 2024 (1730.55 µGy). DONKI’s nearest')
  })
  it('the paper’s surface record, and so its Table 1, ends on 2024-09-09: inside DONKI’s span, after NOAA’s', () => {
    expect(sep.paper_record_end).toBe('2024-09-09')
    for (const r of sep.table1) expect(r.paper_date <= sep.paper_record_end, r.paper_date).toBe(true)
    expect(a.to.slice(0, 10) < sep.paper_record_end).toBe(true)
    expect(b.from.slice(0, 10) <= sep.paper_record_end && sep.paper_record_end < b.to.slice(0, 10)).toBe(true)
    // the triggers of the whole-record run after that date, inside DONKI's span (counted only in the replay line)
    expect(sep.scan.triggers.filter((t) => t.onset.slice(0, 10) > sep.paper_record_end).map((t) => t.onset.slice(0, 10))).toEqual(['2024-11-21', '2025-05-31', '2025-11-11'])
  })
  it('lists 2021-10-28, 2022-02-15 and 2023-03-12 as outside both spans and never counts them', () => {
    expect(x.outsideSpans.map((r) => r.paper_date)).toEqual(['2021-10-28', '2022-02-15', '2023-03-12'])
    const counted = new Set(x.spans.flatMap((s) => [...s.withEarth, ...s.withoutEarth]).map((m) => m.row.paper_date))
    for (const r of x.outsideSpans) expect(counted.has(r.paper_date)).toBe(false)
    expect(sep.table1.filter((r) => r.paper.triggered).length).toBe(x.combined.n + x.outsideSpans.length)
  })
})

describe('the Earth side and the sensitivity to the window', () => {
  it('7 of 48 Earth events lie within 2 days of a replay trigger; no event is left out for a RAD gap at 2 days', () => {
    expect(x.spans.map((s) => s.earthExcluded.length)).toEqual([0, 0])
    expect(x.earthCounted).toBe(48)
    expect(x.earthNearTrigger).toBe(7)
    expect(x.spans.map((s) => s.earthNearTrigger)).toEqual([2, 5])
  })
  it('6/7/8/9 Earth events near a trigger at 1/2/3/5 days, of 48, 48, 48 and 47 (one NOAA maximum touches a RAD gap at 5 days)', () => {
    expect(x.sensitivity.map((s) => [s.days, s.earthNearTrigger, s.earthCounted])).toEqual([
      [1, 6, 48],
      [2, 7, 48],
      [3, 8, 48],
      [5, 9, 47],
    ])
    const at5 = crossMatch(sep, list, donki, 5)
    expect(at5.spans[0].earthExcluded.map((e) => e.t)).toEqual(['2013-06-24T05:20:00Z'])
    expect(at5.spans[1].earthExcluded).toEqual([])
  })
  it('storms with an Earth event and the share with none, per window: 3, 4, 4, 5 of 9', () => {
    expect(x.sensitivity.map((s) => [s.days, s.withEarth, s.n, r2(s.doseNoEarth_uGy), r1(s.share)])).toEqual([
      [1, 3, 9, 1919.3, 85.4],
      [2, 4, 9, 1917.21, 85.3],
      [3, 4, 9, 1917.21, 85.3],
      [5, 5, 9, 1891.69, 84.1],
    ])
    const at2 = x.sensitivity.find((s) => s.days === STORM_MATCH_DAYS)!
    expect([at2.withEarth, at2.n, at2.doseNoEarth_uGy, at2.dose_uGy]).toEqual([x.combined.withEarth, x.combined.n, x.combined.doseNoEarth_uGy, x.combined.dose_uGy])
  })
  it('2024-05-20 has no GOES-P entry within 1, 2, 3 or 5 days: the nearest are 7 days before and 19 after', () => {
    for (const w of SENSITIVITY_DAYS) expect(crossMatch(sep, list, donki, w).spans[1].withoutEarth.some((m) => m.row.paper_date === '2024-05-20'), `${w} d`).toBe(true)
    const s = x.spotlight!
    expect(s.match.row.paper_date).toBe('2024-05-20')
    expect(s.catalogue).toBe('donki')
    expect(s.before).toEqual({ t: '2024-05-13T14:00:00Z', days: 7 })
    expect(s.after).toEqual({ t: '2024-06-08T02:55:00Z', days: 19 })
    // and DONKI logs no SEP entry from any instrument between 2024-05-13T18:07Z and 2024-06-08T02:25Z
    expect(donkiGap(sep)).toEqual({ start: '2024-05-13T18:07Z', stop: '2024-06-08T02:25Z' })
    const inGap = donki.events.filter((e) => Date.parse(e.event_time) > Date.parse('2024-05-13T18:07:00Z') && Date.parse(e.event_time) < Date.parse('2024-06-08T02:25:00Z'))
    expect(inGap).toEqual([])
  })
  it('keeps the S3 spotlight of marsSep.ts: 4 storms at S3 or above at Earth during the record, 1 on a Table 1 row (September 2017)', () => {
    expect(x.s3.inRecord).toBe(4)
    expect(x.s3.matches.map((m) => [m.max.slice(0, 10), m.row.paper_date])).toEqual([['2017-09-11', '2017-09-10']])
  })
  it('without a list, its span is absent and nothing is pooled', () => {
    const noNoaa = crossMatch(sep, null, donki)
    expect(noNoaa.spans.map((s) => s.catalogue)).toEqual(['donki'])
    expect(noNoaa.combined.n).toBe(4)
    expect(noNoaa.outsideSpans.map((r) => r.paper_date)).toEqual(['2013-04-10', '2013-10-10', '2014-09-02', '2014-09-10', '2017-09-10', '2021-10-28', '2022-02-15', '2023-03-12'])
    expect(crossMatch(sep, list, null).spans.map((s) => s.catalogue)).toEqual(['noaa'])
  })
})

describe('what the block renders', () => {
  const render = (m: CrossMatch | null) => renderToStaticMarkup(createElement(EarthVsMarsView, { match: m, sep }))
  const html = render(x)
  const t = text(html)
  it('wraps the block in #rad-earth-vs-mars with the factual heading, a lead sentence with the counts and a scrollable table', () => {
    expect(html).toMatch(/^<section id="rad-earth-vs-mars" data-earth-vs-mars=""/)
    expect(t).toContain('Earth’s proton lists and the storms measured at Gale')
    expect(t).toContain('9 that triggered fall where this build ships an Earth proton list: 4 had an event on that list within 2 days; the other 5 carried 85.3 % (1917.21 of 2248.29 µGy, n = 9) of the total SEP dose the table lists for the 9')
    expect(html).toMatch(/<div class="[^"]*lf-tr-table-wrap[^"]*" tabindex="0" role="region" aria-label="[^"]+, scrollable">/)
    expect((html.match(/<tbody>[\s\S]*?<\/tbody>/)![0].match(/<tr/g) ?? []).length).toBeLessThanOrEqual(6)
  })
  it('prints every share with its µGy and n, never one catalogue pooled silently', () => {
    expect(t).toMatch(/36\.7\s?% \(158\.25 of 431\.35\s?µGy, n = 5\)/)
    expect(t).toMatch(/96\.8\s?% \(1758\.96 of 1816\.94\s?µGy, n = 4\)/)
    expect(t).toMatch(/85\.3\s?% \(1917\.21 of 2248\.29\s?µGy, n = 9\)/)
    expect(t).toMatch(/36\.1\s?% \(186\.66 of 517\.74\s?µGy, n = 8\)/)
    // every percentage on the block is followed by its n within its parentheses
    const shares = [...t.matchAll(/(\d+\.\d)\s?% \(([^)]*)\)/g)]
    expect(shares.length).toBeGreaterThanOrEqual(8)
    for (const m of shares) expect(m[2], m[0]).toMatch(/n = \d+/)
    expect(t.match(/\d\s?%/g)!.length).toBe(shares.length)
    expect(t).toContain('Both lists, added')
  })
  it('prints the spans, the trigger counts and the sensitivity rows from the match', () => {
    expect(t).toContain('NOAA’s list of solar proton events2013-03-22 to 2017-09-10 · 20 events3 of 536.7 % (158.25 of 431.35 µGy, n = 5)')
    // the paper's surface record (its Table 1) ends inside DONKI's span, so that row says, on a line of its own, where its storms stop
    expect(t).toContain('DONKI, GOES-P ≥10 MeV entries2024-01-01 to 2026-11-12 · 28 entriesTable 1 runs to 2024-09-091 of 496.8 % (1758.96 of 1816.94 µGy, n = 4)')
    expect(html).toContain('<span class="lf-rad-evm-span">Table 1 runs to <time class="lf-rad-sep-time" dateTime="2024-09-09">2024-09-09</time></span>')
    expect(t.match(/Table 1 runs to/g)!.length).toBe(1)
    expect(t).toContain('Storms at Gale: the rows of the paper’s Table 1 (Martian surface, to 2024-09-09) where its rule triggered, each with the paper’s total SEP dose.')
    expect(t).toContain('Both lists, addedeach matched on its own4 of 985.3 % (1917.21 of 2248.29 µGy, n = 9)')
    expect(t).toContain('Run over the whole record, the rule triggers 11 times in these spans, 5 of them within 2 days of an Earth event. Of the 48 Earth events, 7 fall within 2 days of a trigger at Gale.')
    expect(t).toContain('NOAA’s span runs from 2013-03-22T04:34:39Z, the end of RAD’s 215.7-day gap at the start of its iSWA record, to the list’s last event start, 2017-09-10T16:45:00Z.')
    expect(t).toContain('DONKI’s span runs from the start of this build’s copy, 2024-01-01T00:00:00Z, to the last RAD sample, 2026-11-12T23:49:21Z.')
    expect(t).toContain('whose instrument is “GOES-P: SEISS >10 MeV”')
    const sens = html.slice(html.indexOf('data-evm-sensitivity'), html.indexOf('</table>', html.indexOf('data-evm-sensitivity')))
    expect(text(sens)).toContain(
      '1 day3 of 985.4 % (1919.30 µGy, n = 9)6 of 482 daysused above4 of 985.3 % (1917.21 µGy, n = 9)7 of 483 days4 of 985.3 % (1917.21 µGy, n = 9)8 of 485 days5 of 984.1 % (1891.69 µGy, n = 9)9 of 47',
    )
    expect(t).toContain('At 5 days, NOAA’s maximum of 2013-06-24T05:20Z is left out of the Earth side: its window touches a RAD gap longer than 2 days.')
    expect(t).toContain('Without 20 May 2024, the share with no Earth event is 36.1 % (186.66 of 517.74 µGy, n = 8).')
    expect(t).toContain('Not counted: 2021-10-28, 2022-02-15 and 2023-03-12, rows where the rule triggered but this build ships no Earth proton list for the date.')
  })
  it('shows the 20 May 2024 line and the S3 line', () => {
    expect(t).toContain(
      'Most of that dose is one storm, 20 May 2024 (1730.55 µGy, the largest at Gale in the paper’s Table 1). DONKI’s nearest GOES-P ≥10 MeV entries are 7 days before it and 19 days after, and DONKI has no SEP entry from any instrument between 2024-05-13T18:07Z and 2024-06-08T02:25Z.',
    )
    // Table 1 also lists 5 deep-space (cruise) events, one of them larger: the claim is scoped to the surface rows
    expect(t).not.toMatch(/largest in the paper’s (table|Table 1)/)
    expect(x.spotlight!.largestAtGale).toBe(true)
    expect(r1(x.spotlight!.shareOfNoEarth)).toBe(90.3)
    expect(t).toContain(
      'NOAA’s list has 4 storms at S3 or above during Curiosity’s record (this copy of the list ends on 2017-09-10); 1 has its maximum within 2 days of a row of the table (September 2017).',
    )
    expect(t).toContain('20 May 2024')
    expect(t).toContain('1730.55')
    expect(t).toContain('2024-05-13T18:07Z')
    expect(t).toContain('2024-06-08T02:25Z')
    expect(t).toMatch(/4 storms at S3 or above/)
    expect(t).toContain('September 2017')
  })
  it('carries the derived, literature and design-choice chips', () => {
    for (const chip of ['derived', 'literature', 'design choice']) expect(html).toContain(`data-chip="${chip}"`)
  })
  it('keeps the method closed, with the sensitivity table, the rows outside the spans and the two closing sentences', () => {
    expect(html).toContain('<details class="lf-expander">')
    expect(html).not.toMatch(/<details[^>]* open/)
    expect(t).toContain('How this was matched')
    expect(t).toContain('2021-10-28, 2022-02-15 and 2023-03-12')
    expect(t).toContain('Matching dates is not identity: this compares Earth’s ≥10 MeV lists with a surface dose rule at Gale and does not say why they differ.')
    expect(t).toContain('The hero borrows a real storm’s shape (GOES-7, October 1989) from an Earth record, not its occurrence at Mars.')
    expect(t.trim().endsWith('The hero borrows a real storm’s shape (GOES-7, October 1989) from an Earth record, not its occurrence at Mars.')).toBe(true)
  })
  it('never says same event, missed or failed to warn, and states no cause', () => {
    expect(t).not.toMatch(/same event|missed|failed to warn/i)
    expect(t).not.toMatch(/heliolongitude|longitude|150 MeV|cut-?off|because/i)
    expect(t).not.toMatch(/Earth (did not|didn’t|never) (see|record)/i)
    expect(t).not.toMatch(/\d\s*(m|µ)?Sv\b/)
  })
  it('renders nothing while the lists load', () => {
    expect(render(null)).toBe('')
  })
})
