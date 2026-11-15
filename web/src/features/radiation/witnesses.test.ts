// "This storm had witnesses": the replay's onset, first S3 and peak are computed from swpc_spe_replay and must fall
// inside the STS-34 window read from history_sts34; the rendered card never attributes a dose to STS-34, computes
// no ratio, and prints Sv only inside the two verbatim quotes ([V1 4031] and the abstract's "(70 microSv)").
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StormWitnessesView } from './StormWitnesses'
import { dayTimeUtc, inWindow, quoteText, replayMoments, speGlossarySentence, v1_4031 } from './witnesses'
import type { HistoryData, ReplayWithEvent } from './witnesses'

const raw = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8'))
const histSnap = raw('history_sts34')
const history = histSnap.data as HistoryData
const replay = raw('swpc_spe_replay').data as ReplayWithEvent
const vol1 = raw('std_vol1_requirements')
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')

describe('the replay inside the STS-34 window', () => {
  const f = history.flight
  const m = replayMoments(replay)!
  it('reads the window from history_sts34 (UTC from the NASA page)', () => {
    expect(f.launch_utc).toBe('1989-10-18T16:53:40Z')
    expect(f.landing_utc).toBe('1989-10-23T16:33:01Z')
    expect((Date.parse(f.landing_utc) - Date.parse(f.launch_utc)) / 1000).toBe(f.duration_s)
  })
  it('sesc_event_computed start and max_time, and the first S3 transition, fall inside it', () => {
    expect(m.onset).toBe(replay.sesc_event_computed!.start)
    expect(m.peak).toBe(replay.sesc_event_computed!.max_time)
    expect(m.firstS3).toBe(replay.s_transitions.find(([, lvl]) => lvl === 3)![0])
    for (const t of [m.onset, m.firstS3, m.peak]) expect(inWindow(t, f.launch_utc, f.landing_utc)).toBe(true)
    expect([dayTimeUtc(m.onset), dayTimeUtc(m.firstS3!), dayTimeUtc(m.peak)]).toEqual(['19 Oct 13:10 UTC', '19 Oct 18:55 UTC', '20 Oct 16:00 UTC'])
    expect(m.peakPfu).toBe(42200)
  })
  it('the flux was still at or above 10 pfu after the landing (the card says so)', () => {
    expect(Date.parse(m.unbrokenUntil!)).toBeGreaterThan(Date.parse(f.landing_utc))
  })
})

describe('the quotes come from the frozen snapshots', () => {
  it('Vol 1 glossary sentence and [V1 4031] verbatim', () => {
    const g = speGlossarySentence(vol1.data.glossary)!
    expect(g.sentence.endsWith('they may penetrate to low altitudes in the polar regions.')).toBe(true)
    expect(v1_4031(vol1.data.requirements)!.text).toContain('(sum of the October 1989 events)')
  })
  it('abstract sentences are the verified ones', () => {
    expect(quoteText(history.golightly_1992.quotes, 'max_dose')).toBe('The maximum dose to a crew attributed to an SPE was estimated to be 30 microGy (70 microSv).')
    expect(quoteText(history.golightly_1992.quotes, 'factors')).toContain('orbit inclination')
  })
})

describe('never print', () => {
  const html = renderToStaticMarkup(
    createElement(StormWitnessesView, {
      history,
      historySnap: histSnap,
      historyStatus: 'ready',
      replay,
      reqs: vol1.data.requirements,
      glossary: vol1.data.glossary,
      vol1Doc: vol1.data.document.cover_number_verbatim,
    }),
  )
  const t = text(html)
  const r4031 = v1_4031(vol1.data.requirements)!.text
  const maxDose = quoteText(history.golightly_1992.quotes, 'max_dose')!
  it('renders the four lines with the window, the moments and both quotes', () => {
    expect(t).toContain('This storm had witnesses')
    expect(t).toContain('18 Oct 1989 16:53:40 UTC')
    expect(t).toContain('23 Oct 16:33:01 UTC')
    expect(t).toContain('19 Oct 13:10 UTC')
    expect(t).toContain('19 Oct 18:55 UTC')
    expect(t).toContain('42,200')
    expect(t).toContain(r4031)
    expect(t).toContain(maxDose)
    expect(t).toContain('beyond the magnetosphere, this is the design-reference storm'.replace(/^b/, 'B'))
  })
  it('no "STS-34 received", no ratio, and Sv only inside the two verbatim quotes', () => {
    expect(t).not.toMatch(/STS-34 received/i)
    expect(t).not.toMatch(/×|\bratio\b|\btimes (more|less|higher|lower)\b/i)
    const outside = t.split(r4031).join(' ').split(maxDose).join(' ')
    expect(outside).not.toMatch(/Sv\b/)
    expect(t.match(/mSv\b/g)).toHaveLength(1)
    expect(t.match(/microSv\b/g)).toHaveLength(1)
  })
})
