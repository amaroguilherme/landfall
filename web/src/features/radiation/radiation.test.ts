// Radiation model: replay time mapping (sim_crew's own mapping), S-level transitions, the NEXT
// predicted SAA passes (wall clock inside the window vs expired), and daily dose gaps.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CareerToDate, ENV_PICKER_CAPTION, OnThisPage, RAD_IDS, RAD_TITLES, SaaStrip, crossingsUpToS3, rationaleSentence, reachOnClock } from './index'
import {
  dailySeries,
  dateRuns,
  detectorDays,
  donkiCrossCheck,
  findRequirement,
  firstReach,
  isModelEntry,
  lcFirst,
  monthYear,
  nextPasses,
  organVerdict,
  recordCoverage,
  replayMapping,
  speRank,
  transitions,
  unitText,
  utcToMet,
  windowSeconds,
} from './model'
import type { DonkiData, HapiDoseData, IssTrackData, ReplayData, SpeListData } from './model'

const snap = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8'))

describe('replay mapping', () => {
  const sim = snap('sim_crew').data
  const m = replayMapping(sim)!
  it('puts the first S3 sample of 1989 where sim_crew says (MET day 412, 14:15:00)', () => {
    const iso = sim.spe_day.shape.mapping.replay_utc_of_first_s3_sample
    expect(utcToMet(Date.parse(iso), m)).toBe(412 * 86_400 + 14 * 3600 + 15 * 60)
  })
  it('lists S1..S4 first-reach times in order, S3 at the shelter-case time', () => {
    const r = snap('swpc_spe_replay').data as ReplayData
    const reach = firstReach(transitions(r, m))
    expect(reach.map((x) => x.level)).toEqual([1, 2, 3, 4])
    expect(reach[2].met).toBe(412 * 86_400 + 14 * 3600 + 15 * 60)
  })
  it('calls a level reached only up to the clock: at 412/14:20 S1 to S3 are reached and S4 is still ahead', () => {
    const r = snap('swpc_spe_replay').data as ReplayData
    const reach = firstReach(transitions(r, m))
    const now = 412 * 86_400 + 14 * 3600 + 20 * 60
    const { reached, ahead } = reachOnClock(reach, now)
    expect(reached.map((x) => x.level)).toEqual([1, 2, 3])
    expect(ahead.map((x) => x.level)).toEqual([4])
    expect(ahead[0].utc).toBe('1989-10-20T13:35:00Z')
    expect(ahead[0].met).toBe(413 * 86_400 + 8 * 3600 + 55 * 60)
    // the S3 sample itself counts as reached at its own minute, not a minute before
    expect(reachOnClock(reach, 412 * 86_400 + 14 * 3600 + 15 * 60).reached.map((x) => x.level)).toEqual([1, 2, 3])
    expect(reachOnClock(reach, 412 * 86_400 + 14 * 3600 + 14 * 60).reached.map((x) => x.level)).toEqual([1, 2])
    // without a mapping nothing is claimed on the clock either way
    expect(reachOnClock(firstReach(transitions(r, null)), now)).toEqual({ reached: [], ahead: [] })
  })
})

describe('habitat dose rate: sim_crew crossings of the linear mapping', () => {
  it('passes 2x at 412/10:25, 5x at 412/11:45 and 10x at 412/14:15 (the S3 trigger), hours after S1', () => {
    const sim = snap('sim_crew').data
    const c = crossingsUpToS3(sim.spe_day)
    expect(c).toEqual([
      [2, 412 * 86_400 + 10 * 3600 + 25 * 60],
      [5, 412 * 86_400 + 11 * 3600 + 45 * 60],
      [10, 412 * 86_400 + 14 * 3600 + 15 * 60],
    ])
    expect(c[c.length - 1][0]).toBe(sim.spe_day.scaling.dose_multiple_at_s3)
    const m = replayMapping(sim)!
    const s1 = firstReach(transitions(snap('swpc_spe_replay').data as ReplayData, m))[0]
    expect(s1.level).toBe(1)
    expect(s1.met!).toBeLessThan(c[0][1])
  })
})

describe('[V2 6165] rationale', () => {
  it('quotes the early-warning sentence verbatim from the frozen requirement', () => {
    const req = findRequirement(snap('std_vol2_requirements').data.requirements, 'V2 6165')
    const s = rationaleSentence(req, /early warning/)!
    expect(s.startsWith('External radiation monitors can provide early warning to crew and ground personnel')).toBe(true)
    expect(req!.rationale).toContain(s)
    expect(rationaleSentence(req, /no such words/)).toBeNull()
  })
})

describe('next SAA passes', () => {
  const s = snap('hapi_iss_track')
  const track = s.data as IssTrackData
  it('counts from the wall clock while the prediction window is open', () => {
    const now = Date.parse(track.saa_rule.window.start) + 6 * 3_600_000
    const plan = nextPasses(track, s.retrieved_at, now)
    expect(plan.refKind).toBe('wall_clock')
    expect(plan.passes.every((p) => p.stopMs > now)).toBe(true)
    expect(plan.passes.length).toBeGreaterThan(0)
  })
  it('falls back to the retrieval time once the window has ended (shown as expired)', () => {
    const plan = nextPasses(track, s.retrieved_at, Date.parse('2026-12-20T00:00:00Z'))
    expect(plan.refKind).toBe('retrieval')
    expect(plan.refMs).toBe(Date.parse(s.retrieved_at))
    expect(plan.passes.length).toBeGreaterThan(0)
  })
  describe('the table lists every pass in the 24 h shown, not the first 8', () => {
    afterEach(() => {
      vi.useRealTimers()
    })
    for (const [label, at] of [
      ['expired window (from retrieval)', '2026-12-20T00:00:00Z'],
      ['open window (from the wall clock)', '2026-11-15T06:00:00Z'],
    ] as const) {
      it(label, () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(at))
        const plan = nextPasses(track, s.retrieved_at, Date.parse(at))
        expect(plan.passes.length).toBeGreaterThan(8)
        const html = renderToStaticMarkup(createElement(SaaStrip, { track, snap: s, status: 'ready' }))
        const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'))
        expect((body.match(/<tr>/g) ?? []).length).toBe(plan.passes.length)
        expect(html).toContain(`All ${plan.passes.length} predicted passes in these 24 h`)
        expect((html.match(/class="lf-rad-pass"/g) ?? []).length).toBe(plan.passes.length)
      })
    }
  })
})

describe('daily dose series', () => {
  it('keeps CRaTER days without samples as null gaps', () => {
    const raw = snap('hapi_crater_dose').data
    const s = dailySeries(raw as HapiDoseData)
    expect(s.gaps).toEqual(raw.days_without_samples as string[])
    expect(s.v.filter((v) => v === null).length).toBe(s.gaps.length)
  })
})

describe('display units and windows', () => {
  it('prints micro as µ, never ASCII u, and leaves other units alone', () => {
    expect(unitText('uGy/day')).toBe('µGy/day')
    expect(unitText('uGy/min')).toBe('µGy/min')
    expect(unitText('uSv/min')).toBe('µSv/min')
    expect(unitText('cGy/day')).toBe('cGy/day')
    expect(unitText('mGy-Eq')).toBe('mGy-Eq')
  })
  it('reads the rule window durations (365-day year, as the app aggregation)', () => {
    expect(windowSeconds('P30D')).toBe(30 * 86_400)
    expect(windowSeconds('P1Y')).toBe(365 * 86_400)
    expect(windowSeconds('PT1H')).toBe(3600)
    expect(windowSeconds(null)).toBeNull()
    expect(windowSeconds('P')).toBeNull()
  })
})

describe('partial dose records', () => {
  const t = 412 * 86_400
  const obs = [{ t: t - 60, value: 14, unit: 'mGy-Eq' }]
  it('a record that starts inside the window is partial: its sum is only a lower bound', () => {
    expect(recordCoverage(obs, 'mGy-Eq', t, 30 * 86_400)).toEqual({ firstT: t - 60, n: 1, partial: true })
    expect(recordCoverage(obs, 'mGy-Eq', t, null).partial).toBe(true) // career sums open at MET 0
  })
  it('a report at or before the window start covers the window', () => {
    const covered = [{ t: t - 31 * 86_400, value: 2, unit: 'mGy-Eq' }, ...obs]
    expect(recordCoverage(covered, 'mGy-Eq', t, 30 * 86_400).partial).toBe(false)
  })
  it('no usable report is no record (not partial); other units and future reports do not count', () => {
    const other = [{ t: t - 60, value: 14, unit: 'mSv' }, { t: t + 60, value: 1, unit: 'mGy-Eq' }]
    expect(recordCoverage(other, 'mGy-Eq', t, 30 * 86_400)).toEqual({ firstT: null, n: 0, partial: false })
  })
  it('a partial record never reads "within limit"; a lower bound already approaching or outside is conclusive', () => {
    // The review case: 14 mGy-Eq BFO logged on the SPE day, a 30-day window that began before any report.
    expect(organVerdict('within', true, 14)).toEqual({ badge: false, partialTag: true, logged: true })
    expect(organVerdict('approaching', true, 210)).toEqual({ badge: true, partialTag: true, logged: true })
    expect(organVerdict('outside', true, 300)).toEqual({ badge: true, partialTag: true, logged: true })
    expect(organVerdict('within', false, 14)).toEqual({ badge: true, partialTag: false, logged: true })
    expect(organVerdict('insufficient_data', false, null)).toEqual({ badge: true, partialTag: false, logged: false })
  })
})

describe('prose helpers', () => {
  it('names months in English and keeps acronyms', () => {
    expect(monthYear('1991-03-23T08:20:00Z')).toBe('March 1991')
    expect(monthYear('2017-09-10T16:45:00Z')).toBe('September 2017')
    expect(lcFirst('Radiation dose rate in Si detector B (raw)')).toBe('radiation dose rate in Si detector B (raw)')
    expect(lcFirst('CRaTER dose')).toBe('CRaTER dose')
  })
})

describe('CRaTER detector pairs on the enhanced days, and the DONKI cross-check', () => {
  const crater = snap('hapi_crater_dose').data as HapiDoseData & { enhanced_days: { days: { date: string }[] } }
  const donki = snap('swpc_sep_events').data as DonkiData
  const days = crater.enhanced_days.days.map((d) => d.date)
  const rows = detectorDays(crater, days, ['d1_2_dose_rate', 'd3_4_dose_rate'])
  const byDate = new Map(rows.map((r) => [r.date, r]))
  it('on the three peak days D1&2 read 14 to 17 times its median while D3&4 read 1.2 to 2.4 times its own', () => {
    for (const date of ['2026-07-31', '2026-08-22', '2026-09-05']) {
      const [d12, d34] = byDate.get(date)!.pairs
      expect(d12.ratio!, date).toBeGreaterThan(14)
      expect(d12.ratio!, date).toBeLessThan(17.2)
      expect(d34.ratio!, date).toBeGreaterThan(1.15)
      expect(d34.ratio!, date).toBeLessThan(2.4)
    }
  })
  it('the two pairs have nearly the same quiet median (0.0139 vs 0.0138 cGy/day)', () => {
    const m12 = crater.series.d1_2_dose_rate.summary!.median
    const m34 = crater.series.d3_4_dose_rate.summary!.median
    expect(Math.abs(m12 / m34 - 1)).toBeLessThan(0.02)
  })
  it('groups the enhanced days into four runs', () => {
    expect(dateRuns(days).map((r) => [r[0], r[r.length - 1]])).toEqual([
      ['2026-07-30', '2026-08-01'],
      ['2026-08-21', '2026-08-26'],
      ['2026-09-05', '2026-09-06'],
      ['2026-09-14', '2026-09-14'],
    ])
  })
  it('finds observed DONKI SEP entries for the July, August and September runs, none for 2026-09-14, and never counts a MODEL entry', () => {
    const checks = donkiCrossCheck(dateRuns(days), donki.events)
    const firstDays = checks.map((c) => [...new Set(c.observed.map((e) => e.event_time.slice(0, 10)))])
    expect(firstDays).toEqual([['2026-07-30'], ['2026-08-20', '2026-08-21', '2026-08-22'], ['2026-09-05'], []])
    expect(checks.every((c) => c.observed.every((e) => !isModelEntry(e)))).toBe(true)
    expect(checks[0].modelled).toBeGreaterThan(0) // REleASE forecasts exist on 2026-07-30 and are set aside
    expect(checks[0].observed.some((e) => e.instruments.some((i) => /GOES/.test(i)))).toBe(true)
  })
})

describe("NOAA's solar proton event list", () => {
  it('ranks October 1989 second by peak >=10 MeV flux, after March 1991', () => {
    const list = snap('swpc_spe_list').data as SpeListData
    const replay = snap('swpc_spe_replay').data as ReplayData
    const r = speRank(list, replay.noaa_spe_list_entry!.start!)!
    expect(r.rank).toBe(2)
    expect(r.event.peak_pfu).toBe(40000)
    expect(r.above.map((e) => [e.start.slice(0, 7), e.peak_pfu])).toEqual([['1991-03', 43000]])
    expect(r.of).toBe(list.events.filter((e) => typeof e.peak_pfu === 'number').length)
  })
})

describe('requirement lookup', () => {
  it('finds [V2 6165] and V1 4031 whatever the bracket style', () => {
    expect(findRequirement(snap('std_vol2_requirements').data.requirements, 'V2 6165')?.text).toMatch(/space weather/)
    expect(findRequirement(snap('std_vol1_requirements').data.requirements, '[V1 4031]')?.text).toMatch(/October 1989/)
  })
})

describe('career dose: "to date", and what [V1 4030] counts that LANDFALL does not', () => {
  const req = findRequirement(snap('std_vol1_requirements').data.requirements, 'V1 4030')
  it('quotes the projected-exposure sentence verbatim from the frozen rationale, then scopes "within limit" to the dose to date', () => {
    const s = rationaleSentence(req, /projected exposure/)!
    expect(s).toBe('Individual crewmember career dose includes all past spaceflight radiation exposures, plus the projected exposure for an upcoming mission.')
    expect(req!.rationale).toContain(s)
    const html = renderToStaticMarkup(createElement(CareerToDate, { req, doc: 'NASA-STD-3001 Vol 1' }))
    expect(html).toContain(`“${s}”`)
    expect(html).toContain('[V1 4030]</span> rationale')
    expect(html).toContain('LANDFALL makes no projection, so “within limit” here covers the dose to date only.')
    // without the snapshot the scope line still prints, and no sentence is made up
    const bare = renderToStaticMarkup(createElement(CareerToDate, { req: null, doc: 'NASA-STD-3001 Vol 1' }))
    expect(bare).not.toContain('<blockquote')
    expect(bare).toContain('covers the dose to date only')
  })
  it('prints the bar as "<v> mSv to date, of < 600 mSv" (the limit from the rules, never typed here)', () => {
    const src = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')
    expect(src).toContain('digits={0} /> to date, of {OPS_SYMBOL[career.op] ?? career.op} <Num value={career.limit} unit={career.unit} />')
  })
})

describe('the environment picker says it switches the whole app', () => {
  it('has a visible caption that is also the group name', () => {
    expect(ENV_PICKER_CAPTION).toBe('Mission environment: these buttons switch the whole app, the same as ENV in the mission bar.')
    const flat = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ')
    expect(flat).toContain('role="group" aria-label={ENV_PICKER_CAPTION}')
    expect(flat).toContain('data-env-caption=""> {ENV_PICKER_CAPTION} </p>')
  })
})

describe('On this page', () => {
  const src = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')
  const sections = ['protons', 'witnesses', 'measured', 'limits', 'goes'] as const
  it('one button per panel, in page order, labelled with the panel titles, and no href (the router owns the hash)', () => {
    const html = renderToStaticMarkup(createElement(OnThisPage, { sections }))
    expect((html.match(/<button/g) ?? []).length).toBe(5)
    expect(html).not.toMatch(/href=/)
    const labels = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])
    expect(labels).toEqual(sections.map((k) => RAD_TITLES[k]))
    for (const k of sections) expect(html).toContain(`data-jump="${RAD_IDS[k]}"`)
  })
  it('each panel carries its id and uses the same title constant; the witnesses title is StormWitnesses’ own', () => {
    const flat = src.replace(/\s+/g, ' ')
    for (const k of ['protons', 'limits', 'goes'] as const) expect(flat).toContain(`id={RAD_IDS.${k}} title={RAD_TITLES.${k}}`)
    expect(flat).toContain('const title = RAD_TITLES.measured')
    expect((flat.match(/<Panel id=\{RAD_IDS\.measured\} title=\{title\}/g) ?? []).length).toBe(2)
    expect(src).toContain('<div id={RAD_IDS.witnesses}>')
    const witnesses = readFileSync(new URL('./StormWitnesses.tsx', import.meta.url), 'utf8')
    expect(witnesses).toContain(`title="${RAD_TITLES.witnesses}"`)
    expect(src).not.toMatch(/href=["'{`]+#rad-/)
  })
  it('keeps MeV in mixed case inside the uppercased kickers', () => {
    expect(src).toContain("<span style={{ textTransform: 'none' }}>MeV</span>")
    expect(src).not.toMatch(/lf-rad-label">[^<]*MeV/)
  })
})
