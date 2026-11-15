// Sol 242 (April 2013): the selectors give the values ingest/tests/test_sep_conjunction.py pins (to 1e-9), the
// panel renders the JPL quote, the Fig. 5 caption and the peak from the shipped snapshots, the hero sentence reads
// NOAA's list and the scenario's modelled window, and the panel never uses a banned phrase or the word "same"
// outside the quoted caption.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { computeComms } from '../../app/comms'
import type { Snapshot } from '../../app/data'
import { MET_NOW_S, environment } from '../../app/scenario'
import type { TimeChartProps } from '../trends/chart'
import Sol242Panel, { RadChart, SOL242_ID, SOL242_TITLE, Sol242View } from './Sol242'
import {
  BANNED_PHRASES,
  axisDays,
  axisInside,
  axisSpan,
  axisText,
  axisTick,
  dayHmUtc,
  dayMonth,
  decadeLabel,
  fragment,
  hetPeaks,
  hetSeries,
  heroYear,
  jplWindow,
  monthYearLong,
  moratoriumRange,
  noaaEntry,
  quietText,
  radMoments,
  radSeries,
  readByHandOn,
  sci3,
  solNumber,
  toSigFigs,
  windowDays,
  MULTIPLE_SIG_FIGS,
} from './conjunction2013'
import type { Sol242Data, SpeListLike } from './conjunction2013'

// TimeChart draws on a canvas in the browser. Here it renders the same empty host (role="img") and records its
// props, so the tests can read the marks and canvas labels each chart is given.
const charts = vi.hoisted(() => [] as TimeChartProps[])
vi.mock('../trends/chart', async (importOriginal) => {
  const { createElement: h } = await import('react')
  return {
    ...(await importOriginal<typeof import('../trends/chart')>()),
    TimeChart: (p: TimeChartProps) => {
      charts.push(p)
      return h('div', { className: 'lf-chart', role: 'img', 'aria-label': p.ariaLabel })
    },
  }
})

const raw =(id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8'))
const snap = raw('sep_conjunction_2013') as Snapshot<Sol242Data>
const data = snap.data
const list = raw('swpc_spe_list').data as SpeListLike
const ephem = raw('horizons_mars_comms') as Snapshot
const sim = raw('sim_crew') as Snapshot
const SRC = readFileSync(new URL('./Sol242.tsx', import.meta.url), 'utf8')
const INDEX = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9)

const heroWindow = computeComms(environment('mars_surface'), MET_NOW_S, { status: 'ready', snapshot: ephem }, { status: 'ready', snapshot: sim }).window
const render = (props: Partial<Parameters<typeof Sol242View>[0]> = {}) =>
  renderToStaticMarkup(createElement(Sol242View, { data, snap, status: 'ready', list, heroWindowStartUtc: heroWindow?.startUtc ?? null, ...props }))

describe('one UTC axis, 10 to 13 April 2013', () => {
  it('spans three days from 2013-04-10T00:00Z and lies inside the Curiosity window', () => {
    expect(data.axis.start).toBe('2013-04-10T00:00:00Z')
    near(axisSpan(data), 3)
    near(axisDays(data, '2013-04-11T14:19:27Z'), 1 + (14 * 3600 + 19 * 60 + 27) / 86_400)
    expect(axisText(data)).toBe('10 to 13 April 2013')
    const cur = jplWindow(data, '2013_curiosity')!
    expect(axisInside(data, cur)).toBe(true)
    expect(windowDays(cur)).toBe('4 April to 1 May')
    expect(axisInside(data, { start_date: '2013-04-11', end_date: '2013-05-01' })).toBe(false)
  })
  it('derives the sol, the quiet window and the title month from the data', () => {
    expect(solNumber(data)).toBe('242')
    expect(quietText(data)).toBe('8–9 April')
    expect(dayMonth('2013-04-11T09:00:00Z')).toBe('11 April')
    expect(SOL242_TITLE).toContain(`(${monthYearLong(data.axis.start)})`)
  })
  it('labels whole days and noon, and only days on a narrow plot', () => {
    expect([0, 0.5, 1, 1.5, 2, 2.5, 3].map((v) => axisTick(data, v))).toEqual(['10 Apr', '12:00', '11 Apr', '12:00', '12 Apr', '12:00', '13 Apr'])
    expect(axisTick(data, 0.5, true)).toBe('')
    expect(axisTick(data, 0.25)).toBe('')
    expect(axisTick(data, 1.0000000000001)).toBe('11 Apr')
    expect(dayHmUtc('2013-04-11T14:19:27Z')).toBe('11 Apr 14:19 UTC')
  })
})

describe('MSL RAD at Gale crater', () => {
  const s = radSeries(data)
  const m = radMoments(data)
  it('background, 1.25 x line, peak, first clear rise and return, as ingest pins them', () => {
    near(s.background, 210.0)
    near(s.threshold, 262.5)
    expect(data.rad.background.n_samples).toBe(112)
    expect(s.x).toHaveLength(63)
    expect(m.peak.t).toBe('2013-04-11T14:19:27Z')
    near(m.peak.uGy_per_day, 260.9941)
    near(m.peakRatio, 1.243)
    expect(m.belowTrigger).toBe(true)
    expect(m.rise?.t).toBe('2013-04-11T10:14:17Z')
    near(m.rise!.uGy_per_day, 252.75111)
    near(m.rise!.ratio_to_background, 1.204)
    expect(m.beforeRise?.t).toBe('2013-04-11T08:11:42Z')
    expect(m.back?.t).toBe('2013-04-12T08:46:30Z')
    near(m.back!.ratio_to_background, 0.994)
    near(data.rad.rise_factor, 1.1)
  })
  it('samples sit on the axis, 61.6 to 122.6 min apart', () => {
    near(s.minSpacingMin, 61.6)
    near(s.maxSpacingMin, 122.6)
    expect(Math.min(...s.x)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...s.x)).toBeLessThan(3)
    near(s.x[s.e.indexOf(m.peak.uGy_per_day)], axisDays(data, m.peak.t))
  })
})

describe('STEREO-B HET', () => {
  const h = hetSeries(data, [80, 50])
  const peaks = hetPeaks(data, [80, 50])
  it('72 hourly means on the axis at hour centres', () => {
    expect(h.x).toHaveLength(72)
    near(h.x[0], 0.5 / 24)
    near(h.x[71], 3 - 0.5 / 24)
    expect(h.values.every((v) => v.every((x) => x === null || x > 0))).toBe(true)
  })
  it('peaks, quiet medians and multiples for 80 and 50 MeV only', () => {
    expect(peaks.map((p) => p.mev)).toEqual([80, 50])
    const [p80, p50] = peaks
    expect(p80.hour).toBe('2013-04-11T09:00:00Z')
    near(p80.mean, 0.5782)
    near(p80.quiet, 0.0003665)
    expect(p80.multiple).toBe(1577)
    expect(p80.multipleShown).toBe(1600)
    expect(p80.firstAbove).toBe('2013-04-11T07:00:00Z')
    expect(p50.hour).toBe('2013-04-11T10:00:00Z')
    near(p50.mean, 1.275)
    near(p50.quiet, 0.0001143)
    expect(p50.multiple).toBe(11148)
    expect(p50.multipleShown).toBe(11000)
    // the ingest's multiple is the peak over the quiet median, to the 4 figures the snapshot stores them to
    for (const p of [p80, p50]) expect(Math.abs(p.mean / p.quiet - p.multiple) / p.multiple).toBeLessThan(1e-3)
    expect(p50.firstAbove).toBe('2013-04-11T08:00:00Z')
    near(p80.x, 1 + 9.5 / 24)
    // 14.3 MeV reads 0 when quiet: no multiple
    expect(hetPeaks(data, [14.3])).toEqual([])
  })
  it('formats flux in three significant figures and decades in powers of ten', () => {
    expect(sci3(0.5782)).toBe('0.578')
    expect(sci3(1.275)).toBe('1.27')
    expect(sci3(0.0003665)).toBe('3.67×10⁻⁴')
    expect(sci3(0.0001143)).toBe('1.14×10⁻⁴')
    expect(decadeLabel(1e-4)).toBe('10⁻⁴')
    expect(decadeLabel(1)).toBe('1')
    expect(decadeLabel(10)).toBe('10')
    expect(decadeLabel(3e-4)).toBe('')
  })
})

describe('JPL, NOAA, the moratoria and the paper', () => {
  it('reads NOAA entries from swpc_spe_list (the build-time copy only when the list is absent)', () => {
    const e = noaaEntry(list, data.noaa.event)!
    expect([e.start, e.max, e.peak_pfu, e.s_level]).toEqual(['2013-04-11T10:55:00Z', '2013-04-11T16:45:00Z', 114, 2])
    const h = noaaEntry(list, data.noaa.scenario_event)!
    expect([h.start, h.peak_pfu, h.s_level]).toEqual(['1989-10-19T13:05:00Z', 40000, 4])
    expect(monthYearLong(h.start)).toBe('October 1989')
    expect(noaaEntry(null, data.noaa.event)).toEqual(data.noaa.event)
    expect(noaaEntry({ events: [] }, data.noaa.event)).toBeNull()
  })
  it('the scenario conjunction year comes from the modelled window that holds the scenario now', () => {
    expect(heroWindow?.startUtc).toBe('2028-03-12T12:00:00Z')
    expect(heroYear(heroWindow?.startUtc)).toBe('2028')
    expect(heroYear(null)).toBeNull()
  })
  it('moratorium line: 615 to 1569 samples over the 7 windows that apply to Curiosity since 2013', () => {
    expect(moratoriumRange(data)).toEqual({ n: 7, min: 615, max: 1569, since: '2013' })
  })
  it('JPL quote was read by hand (horizons_mars_comms says so) and the paper fragments were verified', () => {
    const cur = jplWindow(data, '2013_curiosity')!
    expect(cur.quote).toBe("Curiosity's controllers plan to suspend commanding from April 4 to May 1.")
    expect(cur.quote_verified_this_build).toBe(false)
    expect(readByHandOn(cur)).toBe('2026-11-14')
    expect(fragment(data, 'fig5_caption')).toMatch(/^\(A\) Dose rate enhancement observed on the martian surface by RAD on sol 242 \(11 to 12 April 2013\)/)
    expect(fragment({ ...data, literature: { ...data.literature, fragments_verified_this_build: false } }, 'fig5_caption')).toBeNull()
  })
})

describe('the panel', () => {
  const html = render()
  const t = text(html)
  it('shows the JPL quote, the Fig. 5 caption and the peak, with their hooks', () => {
    expect(html).toContain(`id="${SOL242_ID}"`)
    expect(t).toContain(SOL242_TITLE)
    expect(t).toContain('On sol 242, Curiosity’s RAD measured a solar particle event at Gale crater.')
    expect(t).toContain('the labelled line: 1.25 × background, the RAD team’s trigger.')
    expect(t).toContain('HISTORICAL · MEASURED')
    expect(html).toContain('data-sol242-jpl=""')
    expect(html).toContain('data-sol242-caption=""')
    expect(html).toContain('data-sol242-peak=""')
    expect(t).toContain("“Curiosity's controllers plan to suspend commanding from April 4 to May 1.”")
    expect(t).toContain('The whole span shown, 10 to 13 April 2013, lies inside JPL’s planned Curiosity moratorium (4 April to 1 May).')
    expect(t).toContain(`“${fragment(data, 'fig5_caption')}”`)
    expect(t).toContain('Peak at Gale crater: 260.99 µGy/day at 11 Apr 14:19 UTC, 1.243 × the background')
    expect(t).toContain('first clear rise at 11 Apr 10:14 UTC (1.204 ×, above 1.1 × design choice)')
    expect(t).toContain('back below the background at 12 Apr 08:46 UTC')
  })
  it('the Earth row and the hero sentence read NOAA’s list; no sentence compares arrival times', () => {
    expect(t).toContain('At Earth NOAA lists a solar proton event from 11 Apr 10:55 UTC, maximum 11 Apr 16:45 UTC, 114 pfu (S2) at >10 MeV.')
    expect(t).toMatch(/LANDFALL’s scenario replays a storm NOAA lists at 40,000 pfu \(S4\) at Earth, October 1989, inside the modelled 2028 conjunction; this one is listed at 114 pfu \(S ?2\)\./)
    expect(t).not.toMatch(/\b(earlier|later|sooner) than\b|\bahead of\b|\b(hours?|minutes?) (before|after|earlier|later)\b|\barrived\b|\barrives?\b|\breached \w+ first\b/i)
    const noYear = text(render({ heroWindowStartUtc: null }))
    expect(noYear).toContain('inside the modelled conjunction;')
  })
  it('states the HET peaks, the RAD spacing and the moratorium line from the data', () => {
    // (text() leaves a space where a tag was: on screen "≈1600 ×")
    expect(t).toContain('80 MeV peaks at 0.578 (hour from 09:00 UTC, 11 April), ≈ 1600 × its 8–9 April median of 3.67×10⁻⁴.')
    expect(t).toContain('50 MeV peaks at 1.27 (hour from 10:00 UTC, 11 April), ≈ 11,000 × its 8–9 April median of 1.14×10⁻⁴.')
    expect(html).toContain('≈<span class="lf-num"><data value="1600">1600</data>')
    // two significant figures over medians near zero: the 4-5 figure ratios are never printed
    expect(t).not.toMatch(/1577|11,148|11148/)
    expect(t).toContain('62 to 123 min apart')
    expect(t).toContain('RAD kept recording through every published window since 2013: 615 to 1569 samples each')
  })
  it('the HET peak diamonds carry no canvas label (the 50 MeV peak sits an hour right of the 80 MeV one); the legend names them', () => {
    charts.length = 0
    render()
    const het = charts.filter((c) => c.ariaLabel.startsWith('STEREO-B HET'))
    expect(het).toHaveLength(1)
    const [p80, p50] = hetPeaks(data, [80, 50])
    expect([p80.mev, p50.mev]).toEqual([80, 50])
    expect(het[0].marks?.map((k) => [k.x, k.y, k.hollow, k.label])).toEqual([
      [p80.x, p80.mean, false, undefined],
      [p50.x, p50.mean, true, undefined],
    ])
    expect(t).toContain('Solid: the 80 MeV bin; dashed: the 50 MeV bin. Filled diamond: the 80 MeV peak hour; hollow: the 50 MeV peak hour. 80 MeV peaks at 0.578')
    // the chart's text alternative carries the same rounded multiples
    expect(het[0].ariaLabel).toContain('80 MeV peaks at 0.578 in the hour from 09:00 UTC on 11 April, about 1600 times its 8–9 April median of 3.67×10⁻⁴')
    expect(het[0].ariaLabel).toContain('50 MeV peaks at 1.27 in the hour from 10:00 UTC on 11 April, about 11,000 times its 8–9 April median of 1.14×10⁻⁴')
  })
  it('rounds a multiple to two significant figures (design choice), never its sign or a zero', () => {
    expect(MULTIPLE_SIG_FIGS).toBe(2)
    expect(toSigFigs(11148, 2)).toBe(11000)
    expect(toSigFigs(1577, 2)).toBe(1600)
    expect(toSigFigs(1549, 2)).toBe(1500)
    expect(toSigFigs(99.6, 2)).toBe(100)
    expect(toSigFigs(0.012345, 2)).toBe(0.012)
    expect(toSigFigs(-1577, 2)).toBe(-1600)
    expect(toSigFigs(0, 2)).toBe(0)
  })
  it('the dose chart labels its peak and first clear rise, with a short 1.25 × label below 720 px and no rise label on a narrow plot', () => {
    const specOf = (daysOnly: boolean, shortLimit: boolean) => {
      charts.length = 0
      renderToStaticMarkup(createElement(RadChart, { data, daysOnly, shortLimit }))
      expect(charts).toHaveLength(1)
      return { limit: charts[0].hlines?.map((l) => [l.label, l.short]), marks: charts[0].marks?.map((k) => [k.hollow ?? false, k.label]) }
    }
    const both = [
      [false, 'peak ×1.243'],
      [true, 'first clear rise'],
    ]
    expect(specOf(false, false)).toEqual({ limit: [['1.25 × background = 262.5 µGy/day', '1.25 × background']], marks: both })
    expect(specOf(false, true)).toEqual({ limit: [['1.25 × background', '1.25 × background']], marks: both })
    expect(specOf(true, true)).toEqual({
      limit: [['1.25 × background', '1.25 × background']],
      marks: [
        [false, 'peak'],
        [true, undefined],
      ],
    })
    // The view at its default (wide) plot width draws the full labels.
    charts.length = 0
    render()
    const rad = charts.filter((c) => c.ariaLabel.startsWith('MSL RAD'))
    expect(rad).toHaveLength(1)
    expect(rad[0].hlines?.[0].label).toBe('1.25 × background = 262.5 µGy/day')
    expect(rad[0].marks?.map((k) => k.label)).toEqual(['peak ×1.243', 'first clear rise'])
    expect(t).toContain('the labelled line: 1.25 × background, the RAD team’s trigger. Filled diamond: the peak; hollow: the first clear rise.')
  })
  it('the "does not show" expander is closed and carries the limits', () => {
    expect(html).toMatch(/<details class="lf-expander"><summary>[\s\S]*?What this does and does not show/)
    expect(html).not.toMatch(/<details[^>]*open/)
    expect(t).toContain('Three dates: Löwe et al.’s Table 1 “2013-04-10”, Hassler et al.’s Fig. 5 “11 to 12 April 2013” and Fig. 1 “12 to 13 April 2013”. The data peak on 11 Apr 14:19 UTC.')
    expect(html).toContain('<span class="lf-s242-date">“2013-04-10”</span>')
    expect(t).toContain('“… its energy spectrum was hard enough to produce an enhancement of ~30% over the GCR dose rate on the martian surface”')
    expect(t).toContain('Löwe et al. 2025 list it in Table 1 as triggered, with a total SEP dose of 9.22 µGy')
    expect(t).toContain('No Gy-to-Sv step is taken, and no arrival times are compared.')
    expect(t).toContain('Linking the three records is the paper’s claim (its Fig. 5 caption, quoted above), not LANDFALL’s.')
    expect(t.replace('No Gy-to-Sv step', '')).not.toMatch(/Sv\b/)
  })
  it('never says near miss or no one could warn, and "same" only inside the quoted caption', () => {
    for (const p of BANNED_PHRASES) {
      expect(SRC.toLowerCase()).not.toContain(p)
      expect(t.toLowerCase()).not.toContain(p)
    }
    expect(SRC).not.toMatch(/\bsame\b/i)
    const caption = fragment(data, 'fig5_caption')!
    expect(caption.match(/\bsame\b/gi)).toHaveLength(2)
    expect(t.split(caption).join(' ').match(/\bsame\b/gi)).toBeNull()
  })
  it('never embeds the paper’s figure', () => {
    expect(html).not.toMatch(/<img|<svg[^>]*class="[^"]*fig/i)
    expect(SRC).not.toMatch(/1244797\.full|\.png|\.jpe?g/)
  })
})

describe('mounting', () => {
  it('index.tsx mounts the panel and its "On this page" entry for the Mars surface only', () => {
    expect(INDEX).toContain("import Sol242Panel, { SOL242_ID, SOL242_TITLE } from './Sol242'")
    expect(INDEX).toContain("{envId === 'mars_surface' ? <Sol242Panel /> : null}")
    expect(INDEX).toContain("filter((k) => k !== 'sol242' || envId === 'mars_surface')")
    expect(INDEX).toContain('sol242: SOL242_TITLE')
    expect(INDEX).toContain('sol242: SOL242_ID')
  })
  it('the default export is the self-loading panel', () => {
    expect(typeof Sol242Panel).toBe('function')
  })
})
