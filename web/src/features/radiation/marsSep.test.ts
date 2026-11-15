// The Mars-surface SEP record (hapi_msl_rad_sep_events): the 20 May 2024 timeline, the replay-vs-paper table,
// the context line under the habitat dose panel, and what the section renders (never a Sv value, never "false
// alarm", never "Earth never recorded"), all read from the shipped snapshot.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarsSepContextView, MarsSepRecordView } from './MarsSepRecord'
import { STORM_MATCH_DAYS, donkiGap, fmtDhm, isoMinute, mayTimeline, oneDecimal, peakRatioRange, ruleQuotes, s3StormsOnTable, tableRows, tableSummary, triggersWith, unconfirmedOf, unconfirmedText } from './marsSep'
import type { SepEventsData, SpeListLike } from './marsSep'

const raw = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8'))
const snap = raw('hapi_msl_rad_sep_events')
const data = snap.data as SepEventsData
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')

describe('20 May 2024 timeline', () => {
  const tl = mayTimeline(data)!
  it('places onset, confirmation and peak where the snapshot says', () => {
    expect(tl.replay.onset).toBe('2024-05-20T05:21:50Z')
    expect(tl.replay.confirmation.t).toBe('2024-05-20T05:38:56Z')
    expect(Math.round(tl.confirmationMin)).toBe(17)
    expect(Math.round(tl.peakMin)).toBe(53)
    expect(tl.peakValue).toBeCloseTo(8378, -1)
    expect(oneDecimal(tl.peakRatio)).toBe('59.7')
    expect(tl.background).toBeCloseTo(140.4, 0)
    expect(tl.threshold).toBeCloseTo(1.25 * tl.background, 1)
  })
  it('has the two lower-bound Earth ticks from the one-way light time', () => {
    expect(oneDecimal(tl.earthSeesMin!)).toBe('15.8')
    expect(oneDecimal(tl.earliestReplyMin!)).toBe('31.7')
    expect(tl.confirmationMin).toBeLessThan(tl.earliestReplyMin!)
    expect(data.light_time.label).toBe('lower bound: light time only, 00:00 UTC that day')
  })
  it('draws native samples only, onset sample at x = 0', () => {
    expect(tl.x.length).toBe(tl.e.length)
    expect(tl.x.includes(0)).toBe(true)
    expect(tl.x.every((x) => x >= tl.xMin && x <= tl.xMax)).toBe(true)
  })
})

describe('replay against the paper', () => {
  const rows = tableRows(data)
  it('keeps all 16 rows, largest paper dose first, paper-not-triggered rows last', () => {
    expect(rows).toHaveLength(16)
    expect(rows.slice(0, 3).map((r) => r.paper_date)).toEqual(['2024-05-20', '2022-02-15', '2017-09-10'])
    expect(rows.slice(-4).every((r) => !r.paper.triggered)).toBe(true)
    expect(rows.filter((r) => r.paper.triggered && r.replay.triggered).length).toBeGreaterThanOrEqual(8)
  })
  it('counts every status and prints the deviations, never hides them', () => {
    const s = tableSummary(data)
    expect(s.counts).toEqual({ reproduced: 7, deviates: 1, not_reproduced: 4, agrees_not_triggered: 4, replay_triggered_paper_not: 0 })
    expect(data.table1_counts).toEqual(s.counts)
    const dev = data.table1.find((r) => r.paper_date === '2014-09-02')!
    expect(Math.round(dev.comparison.total_pct!)).toBe(-33)
  })
  it('2014-01-05: one sample crossed 1.25 × and the next did not confirm it, so the replay agrees with the paper', () => {
    const r = data.table1.find((x) => x.paper_date === '2014-01-05')!
    expect(r.comparison.status).toBe('agrees_not_triggered')
    expect(r.replay.triggered).toBe(false)
    const [u, ...rest] = unconfirmedOf(r)
    expect(rest).toEqual([])
    expect(unconfirmedText(u, data.rule.scan.max_pair_gap_s)).toBe('one sample at 2014-01-06T12:45:21Z reached 1.251 × background and the next did not confirm it')
    // every onset the replay keeps is confirmed by the next sample
    for (const x of data.table1) if (x.replay.triggered) expect(x.replay.confirmation.above_threshold, x.paper_date).toBe(true)
  })
  it('formats durations exactly like the paper and the adapter', () => {
    expect(fmtDhm(2515)).toBe('01d 17h:55m')
    const may = data.table1.find((r) => r.paper_date === '2024-05-20')!
    expect(fmtDhm(may.paper.shelter_min!)).toBe('01d 17h:55m')
    expect(may.replay.triggered && fmtDhm(may.replay.shelter_min)).toBe('02d 00h:23m')
    for (const r of data.table1) if (r.paper.triggered) expect(r.paper_row).toContain(fmtDhm(r.paper.time_to_peak_min!))
  })
})

describe('whole record and context', () => {
  it('13 triggers: in, not in and after the paper table', () => {
    expect(data.scan.triggers).toHaveLength(13)
    expect(triggersWith(data, 'not_in_paper_table').map((t) => t.onset.slice(0, 10))).toEqual(['2015-06-11', '2016-11-13'])
    expect(triggersWith(data, 'after_paper_table').map((t) => t.onset.slice(0, 10))).toEqual(['2024-11-21', '2025-05-31', '2025-11-11'])
  })
  it('the context range is computed from the triggers: 1.3x to 59.7x over 13', () => {
    const r = peakRatioRange(data)!
    expect(r.n).toBe(13)
    expect(oneDecimal(r.min)).toBe('1.3')
    expect(oneDecimal(r.max)).toBe('59.7')
  })
  it('the DONKI gap around 20 May 2024 is read from the snapshot', () => {
    expect(donkiGap(data)).toEqual({ start: '2024-05-13T18:07Z', stop: '2024-06-08T02:25Z' })
    expect(isoMinute('2024-05-13T18:07:00Z')).toBe('2024-05-13T18:07Z')
  })
  it('prints the rule sentences, including the 30-minute shelter sentence', () => {
    const q = ruleQuotes(data).map((x) => x.text)
    expect(q.some((x) => x.includes('1.25 times the background dose rate'))).toBe(true)
    expect(q.some((x) => x.includes('should not move more than 30 minutes away from a shelter'))).toBe(true)
  })
})

describe('what the section renders', () => {
  const html = renderToStaticMarkup(createElement(MarsSepRecordView, { data, snap, status: 'ready' }))
  const t = text(html)
  it('shows the timeline moments, the DONKI sentence and the table', () => {
    expect(t).toContain('05:21:50')
    expect(t).toContain('+17.1 min')
    expect(t).toContain('+53.5 min')
    expect(t).toContain('≥ +15.8 min')
    expect(t).toContain('≥ +31.7 min')
    expect(t).toContain("DONKI’s SEP list (near-Earth and STEREO-A instruments) has no entry between 2024-05-13T18:07Z and 2024-06-08T02:25Z")
    expect(t).toContain('02d 00h:23m')
    expect(t).toContain('01d 17h:55m')
    expect((html.match(/<tr data-status=/g) ?? []).length).toBe(16)
    expect(t).toContain('not reproduced (max 1.02 × within 48 h, iSWA gap)')
    expect(t).toContain('“the astronaut will receive an official alert”')
  })
  it('summarises the table with no replay-only clause, and says why 2014-01-05 agrees', () => {
    expect(t).toContain('Of the paper’s 16 rows, 7 reproduce (total SEP dose within ±')
    expect(t).toMatch(/1 deviates \(2014-09-02, −33\.\d %\), 4 do not trigger in this replay \(2013-04-10, 2013-10-10, 2014-09-10, 2023-03-12\) and 4 are not triggered in either/)
    expect(t).toContain('(for 2014-01-05, one sample at 2014-01-06T12:45:21Z reached 1.251 × background and the next did not confirm it)')
    expect(t).not.toMatch(/here only|replay only/)
    expect(t).toContain('not triggered in either (one sample at 1.251 ×, not confirmed by the next)')
    expect((html.match(/<tr data-status="agrees_not_triggered"/g) ?? []).length).toBe(4)
    expect(html).not.toContain('data-status="replay_triggered_paper_not"')
    expect(t).toContain('An onset counts only when the next sample, less than 3 h later, is above the threshold too')
  })
  it('cites the journal with the publisher’s author list (Crossref), not the preprint’s spelling', () => {
    const cr = data.literature.journal.authors_crossref!
    const journal = cr.map((a) => a.replace(/\u2010/g, '-')).join(', ')
    const arxiv = data.literature.authors.join(', ')
    expect(cr).toHaveLength(data.literature.authors.length)
    expect(t).toContain(`${journal}. ${data.literature.title}. Space Weather 23, e2025SW004372 (2025).`)
    if (arxiv !== journal) expect(t).not.toContain(arxiv)
  })
  it('never prints a Sv value, a false alarm or an Earth-never-recorded claim', () => {
    expect(t).not.toMatch(/\d\s*(m|µ|micro)?Sv\b/)
    // the only Sv is the snapshot caveat that says it is never used
    expect(t.split('Absorbed dose in plastic: never converted to Sv, never compared with Table 4.8-1.').join(' ')).not.toMatch(/Sv\b/)
    expect(t.toLowerCase()).not.toContain('false alarm')
    expect(t).not.toMatch(/Earth never recorded/i)
    expect(t).not.toContain('8,100')
  })
})

describe("NOAA's S3 storms at Earth on rows of the RAD team's table", () => {
  const list = raw('swpc_spe_list').data as SpeListLike
  const storms = s3StormsOnTable(data, list)
  it('joins on UTC dates within the design-choice window: 2 of the 4 storms in the record fall on rows', () => {
    expect(STORM_MATCH_DAYS).toBe(2)
    expect(storms.inRecord).toBe(4)
    expect(storms.listEnd).toBe('2017-09-10T16:45:00Z')
    expect(storms.matches.map((m) => [m.start.slice(0, 10), m.peak_pfu, m.row.paper_date, m.gapDays])).toEqual([
      ['2014-01-06', 1033, '2014-01-05', 1],
      ['2017-09-10', 1490, '2017-09-10', 0],
    ])
    const [jan, sep] = storms.matches
    expect(jan.row.replay.triggered).toBe(false)
    expect(sep.row.replay.triggered && sep.row.replay.peak.ratio_to_background).toBe(2.235)
    // a narrower window keeps only the same-day storm
    expect(s3StormsOnTable(data, list, 0).matches.map((m) => m.row.paper_date)).toEqual(['2017-09-10'])
  })
  it('prints the two storms, no dose in µGy, and says a date match is not identity', () => {
    const html = renderToStaticMarkup(createElement(MarsSepContextView, { data, storms, multiple: 10 }))
    const t = text(html)
    expect(t).toContain('NOAA’s list of solar proton events has 4 storms at S3 or above during Curiosity’s record (this copy of the list ends on 2017-09-10). Of these, 2 fall within 2 days of a row of the RAD team’s surface table')
    expect(t).toMatch(/2014-01-06 \(\s?1033\s?pfu at Earth; Table 1 row 2014-01-05, not triggered at Gale\) and 2017-09-10 \(\s?1490\s?pfu at Earth; peak 2\.235\s?× background at Gale\)/)
    expect(t).toContain('Matching dates is not identity.')
    expect(t).toContain('The 10× above stays a design choice')
    expect(t).not.toMatch(/µGy|uGy/)
    // without the NOAA list the measured range still renders, with the design-choice sentence
    const alone = text(renderToStaticMarkup(createElement(MarsSepContextView, { data, storms: null, multiple: 10 })))
    expect(alone).toContain('For context, not a calibration')
    expect(alone).toContain('The 10× above stays a design choice')
    expect(alone).not.toContain('NOAA’s list')
  })
})
