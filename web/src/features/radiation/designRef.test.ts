// NASA's design reference SPE, re-derived (designRef.ts), against the shipped snapshots std_vol1_requirements
// (Table 4.8-3) and swpc_spe_replay (the GOES-7 record). Every number is pinned to 1e-9 relative; the values are
// the ones ingest/tests/test_design_reference.py computes in stdlib Python from the same two files.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DesignReferenceView, energyLabel, exponentLabel, leadQuote } from './DesignRefCheck'
import { replayMapping, utcToMet } from './model'
import {
  CHANNELS,
  CURVE_E_MAX,
  CURVE_E_MIN,
  LEAD_FRACTION,
  WINDOW_END_FROM,
  backgroundDay,
  dayLabel,
  dayMedian,
  dayTime,
  decadeRange,
  designReference,
  filledValues,
  fractionMark,
  integralAbove,
  integralCurve,
  pairsOf,
  replayFluence,
  sci,
  shareBefore,
  signedPct,
  spectrumTable,
  windowEndSensitivity,
} from './designRef'
import type { Pair, RegularSeries } from './designRef'
import type { ReplayWithEvent } from './witnesses'

const raw = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8'))
const vol1 = raw('std_vol1_requirements').data
const replay = raw('swpc_spe_replay').data as ReplayWithEvent
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b)
const near = (a: number, b: number, tol = 1e-9) => expect(rel(a, b), `${a} vs ${b}`).toBeLessThan(tol)
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

describe('the integrator (power-law segments)', () => {
  it('integrates a pure power law exactly', () => {
    const energies = Array.from({ length: 55 }, (_, k) => 10 ** ((k - 20) / 10))
    const A = 3e9
    for (const gamma of [2.5, 1, 3.7, 0.4]) {
      const pairs: Pair[] = energies.map((e) => [e, A * e ** -gamma] as const)
      const top = energies[energies.length - 1]
      for (const e0 of [10, 100, 0.05, 1234.5]) {
        const exact = gamma === 1 ? A * Math.log(top / e0) : (A * (top ** (1 - gamma) - e0 ** (1 - gamma))) / (1 - gamma)
        near(integralAbove(pairs, e0), exact, 1e-10)
      }
    }
  })
  it('stops at the last pair and starts at the first', () => {
    const pairs: Pair[] = [
      [1, 100],
      [10, 1],
      [100, 0.01],
    ]
    expect(integralAbove(pairs, 100)).toBe(0)
    expect(integralAbove(pairs, 1000)).toBe(0)
    near(integralAbove(pairs, 0.1), integralAbove(pairs, 1), 1e-15)
    near(integralAbove(pairs, 1), 99, 1e-12)
  })
})

describe('Table 4.8-3 as frozen', () => {
  const t = spectrumTable(vol1)!
  it('is the verified 100-pair table, first and last pairs as printed', () => {
    expect(t.caption).toBe('Table 4.8-3—Design Reference SPE Environment Proton Energy Spectrum (Sum of the October 1989 Events)')
    expect(t.header_verbatim).toEqual(['Energy (MeV)', 'Proton Fluence (#/cm2-MeV)'])
    expect(t.rows).toHaveLength(100)
    expect([t.rows[0].energy, t.rows[0].fluence.text]).toEqual(['1.000E-02', '7.761E+14'])
    expect([t.rows[99].energy, t.rows[99].fluence.text]).toEqual(['2.500E+03', '3.891E+01'])
    expect(t.pdf_page_number).toBe(42)
  })
  it('integrates to the reference values above 10, 30, 50, 60 and 100 MeV', () => {
    const p = pairsOf(t)
    near(integralAbove(p, 10), 19203449053.92634)
    near(integralAbove(p, 30), 4166005136.0745673)
    near(integralAbove(p, 50), 1714700997.8043563)
    near(integralAbove(p, 60), 1221645438.9286852)
    near(integralAbove(p, 100), 447578889.7388005)
    // the brief's five-digit values
    expect(rel(integralAbove(p, 10), 1.92034e10)).toBeLessThan(1e-4)
    expect(rel(integralAbove(p, 100), 4.47579e8)).toBeLessThan(1e-4)
  })
  it('is refused when absent or not verified', () => {
    expect(spectrumTable(null)).toBeNull()
    expect(spectrumTable({ tables: vol1.tables.slice(0, 2) })).toBeNull()
    expect(spectrumTable({ tables: [{ ...t, verified: false }] })).toBeNull()
    expect(designReference({ tables: vol1.tables.slice(0, 2) }, replay)).toBeNull()
  })
})

describe('the figure: Table 4.8-3 integrated above each printed energy', () => {
  const t = spectrumTable(vol1)!
  const curve = integralCurve(pairsOf(t))
  it('has one point per printed energy, from the whole table down to nothing above the last energy', () => {
    expect(curve).toHaveLength(100)
    expect(curve.map((p) => p.e)).toEqual(t.rows.map((r) => r.energy_mev))
    near(curve[0].above, 8155655891987.764)
    near(curve[98].above, 18921.841385475687)
    expect(curve[99].above).toBe(0)
    const shown = curve.filter((p) => p.e >= CURVE_E_MIN && p.e <= CURVE_E_MAX && p.above > 0)
    expect(shown).toHaveLength(68)
    expect(shown[0].e).toBe(1.014)
    near(shown[0].above, 171572128567.5877)
    expect(shown[67].e).toBe(958.8)
    near(shown[67].above, 776852.67569204)
    expect(designReference(vol1, replay)!.curve).toEqual(curve)
  })
  it('spans whole decades on both axes and labels only the decades', () => {
    expect(decadeRange([...curve.filter((p) => p.e >= 1 && p.e <= 1000).map((p) => p.above), 19296594161.24258])).toEqual([1e5, 1e12])
    expect(decadeRange([0, -1])).toBeNull()
    expect([exponentLabel(8), exponentLabel(12), exponentLabel(-3), exponentLabel(8.5)]).toEqual(['10⁸', '10¹²', '10⁻³', ''])
    expect([energyLabel(0), energyLabel(1), energyLabel(2), energyLabel(3), energyLabel(0.5)]).toEqual(['1', '10', '100', '1000', ''])
  })
})

describe('the replayed GOES-7 record', () => {
  const ev = replay.sesc_event_computed!
  it('fills missing samples linearly, zero at an open end', () => {
    expect(filledValues([1, null, null, 4])).toEqual([1, 2, 3, 4])
    expect(filledValues([null, 2, null])).toEqual([0, 2, 0])
    expect(replay.series_ge10mev.values.filter((v) => v === null)).toHaveLength(17)
    expect(replay.series_ge100mev!.values.filter((v) => v === null)).toHaveLength(16)
  })
  it('takes the background from the day before the onset day', () => {
    expect(backgroundDay(ev.start)).toBe('1989-10-18')
    expect(dayMedian(replay.series_ge10mev, '1989-10-18')).toBe(0.254)
    expect(dayMedian(replay.series_ge100mev as RegularSeries, '1989-10-18')).toBe(0.0118)
    expect(dayMedian(replay.series_ge10mev, '1990-01-01')).toBeNull()
  })
  it('sums 4π × (F − bg) × 300 s over the SESC event window', () => {
    expect([ev.start, ev.end_last_ge_10pfu]).toEqual(['1989-10-19T13:10:00Z', '1989-10-29T22:20:00Z'])
    const f10 = replayFluence(replay.series_ge10mev, Date.parse(ev.start), Date.parse(ev.end_last_ge_10pfu!), 0.254)
    const f100 = replayFluence(replay.series_ge100mev as RegularSeries, Date.parse(ev.start), Date.parse(ev.end_last_ge_10pfu!), 0.0118)
    near(f10.total, 19296594161.24258)
    near(f100.total, 459053705.1545731)
    expect(iso(f10.times[0])).toBe(ev.start)
    expect(iso(f10.times[f10.times.length - 1])).toBe(ev.end_last_ge_10pfu)
    expect(f10.times).toHaveLength(2991) // 19 Oct 13:10 to 29 Oct 22:20 inclusive, every 5 min
  })
})

describe('the check, as the section shows it', () => {
  const r = designReference(vol1, replay)!
  const [c10, c100] = r.channels
  it('compares the two shipped channels only', () => {
    expect(r.channels.map((c) => [c.key, c.e0])).toEqual(CHANNELS.map((c) => [c.key, c.e0]))
    expect([r.windowStart, r.windowEnd, r.bgDay]).toEqual(['1989-10-19T13:10:00Z', '1989-10-29T22:20:00Z', '1989-10-18'])
  })
  it('agrees with Table 4.8-3 within +0.49 % above 10 MeV and +2.56 % above 100 MeV', () => {
    near(c10.table, 19203449053.92634)
    near(c10.replay, 19296594161.24258)
    near(c10.diffPct, 0.4850436348943221)
    near(c100.table, 447578889.7388005)
    near(c100.replay, 459053705.1545731)
    near(c100.diffPct, 2.563752598445612)
    expect([c10.bg, c100.bg]).toEqual([0.254, 0.0118])
    expect([signedPct(c10.diffPct, 2), signedPct(c100.diffPct, 2)]).toEqual(['+0.49', '+2.56'])
  })
  it('in hindsight: 0.56 % and 3.60 % had arrived before the S3 sample, 10 % came 18.4 h and 4.0 h after it', () => {
    expect(r.trigger).toBe('1989-10-19T18:55:00Z')
    near(c10.beforePct, 0.5558957913726188)
    near(c100.beforePct, 3.596301008933924)
    expect([c10.beforePct.toFixed(2), c100.beforePct.toFixed(2)]).toEqual(['0.56', '3.60'])
    expect([iso(c10.markMs), iso(c100.markMs)]).toEqual(['1989-10-20T13:20:00Z', '1989-10-19T22:55:00Z'])
    near(c10.markHoursAfter, 18.416666666666668)
    expect(c100.markHoursAfter).toBe(4)
    expect(LEAD_FRACTION).toBe(0.1)
    // the same sample the scenario places at MET 412/14:15 (sim_crew's replay mapping)
    expect(raw('sim_crew').data.spe_day.shape.mapping.replay_utc_of_first_s3_sample).toBe(r.trigger)
    // and the first sample at or above 1,000 pfu
    const s = replay.series_ge10mev
    const first = s.values.findIndex((v) => v !== null && v >= 1000)
    expect(iso(Date.parse(s.start) + first * s.step_s * 1000)).toBe(r.trigger)
  })
  it('moves −1.86 … +0.53 % and −0.02 … +2.72 % when the window ends anywhere from 26 Oct 00:00 to the last sample', () => {
    const w10 = c10.windowEnd!
    const w100 = c100.windowEnd!
    expect([iso(w10.fromMs), iso(w10.toMs)]).toEqual([WINDOW_END_FROM, '1989-10-31T23:55:00Z'])
    near(w10.minPct, -1.8587576413609537)
    near(w10.maxPct, 0.5295241896579344)
    near(w100.minPct, -0.01919921682378602)
    near(w100.maxPct, 2.7189934249185277)
    expect([signedPct(w10.minPct, 1), signedPct(w10.maxPct, 1), signedPct(w100.minPct, 1), signedPct(w100.maxPct, 1)]).toEqual(['−1.9', '+0.5', '0.0', '+2.7'])
    // the computation is direct: recomputing it by hand at the two ends gives the same numbers
    const s = replay.series_ge10mev
    const start = Date.parse(r.windowStart)
    const at = (end: string) => (100 * (replayFluence(s, start, Date.parse(end), 0.254).total - c10.table)) / c10.table
    near(at(WINDOW_END_FROM), w10.minPct)
    near(at('1989-10-31T23:55:00Z'), w10.maxPct)
    expect(windowEndSensitivity(s, start, Date.parse('1990-01-01T00:00:00Z'), 0.254, c10.table)).toBeNull()
  })
  it('helpers: share, mark, scientific notation and dates', () => {
    const f = { times: [0, 1, 2, 3], cumulative: [1, 2, 6, 10], total: 10 }
    expect(shareBefore(f, 2)).toBe(0.2)
    expect(fractionMark(f, 0.5)).toBe(2)
    expect(sci(19296594161.24258)).toEqual({ mantissa: '1.930', exponent: 10 })
    expect(sci(447578889.7388005)).toEqual({ mantissa: '4.476', exponent: 8 })
    expect(dayTime(Date.parse('1989-10-19T18:55:00Z'))).toBe('19 Oct 18:55 UTC')
    expect(dayLabel('1989-10-18')).toBe('18 Oct')
    expect(signedPct(-0.004, 2)).toBe('0.00')
  })
})

describe('the section as rendered', () => {
  const r = designReference(vol1, replay)!
  const sep = raw('hapi_msl_rad_sep_events').data
  const lead = leadQuote(sep)
  const mapping = replayMapping(raw('sim_crew').data)!
  const html = renderToStaticMarkup(createElement(DesignReferenceView, { r, lead, triggerMet: utcToMet(Date.parse(r.trigger), mapping) }))
  const flatten = (h: string) =>
    h
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ') // \s includes the no-break space, so the text reads with plain spaces
  // the text as read (screen-reader copies included), and the visible text only (table cells run together)
  const text = flatten(html)
  const visible = flatten(html.replace(/<span class="sr-only">[^<]*<\/span>/g, ''))
  it('shows the two-row table under [data-design-ref], with its chips', () => {
    expect(html).toContain('data-design-ref=""')
    expect(visible).toContain('≥10 MeV1.930 × 10101.920 × 1010+0.49 %')
    expect(visible).toContain('≥100 MeV4.591 × 1084.476 × 108+2.56 %')
    // the energy and its unit never part across a line break
    expect(html).toMatch(/≥10(\u00a0|&nbsp;)MeV/)
    expect(html.replace(/aria-label="[^"]*"/g, '')).not.toMatch(/≥10 MeV|≥100 MeV|above 10 MeV|above 100 MeV/)
    expect(text).toContain('1.930 times 10 to the 10')
    for (const chip of ['derived', 'NASA-published', 'design choice', 'literature']) expect(html).toContain(`data-chip="${chip}"`)
    expect(text).toContain('The rationale of [V1 4031] refers to Table 4.8-3, which prints that spectrum as 100 energy/fluence pairs (page 42)')
    expect(text).toContain(
      'The replayed GOES-7 record agrees with NASA’s design-reference spectrum; NASA-STD-3001 does not say how its table was derived, so this is a consistency check, not an independent confirmation.',
    )
    expect(text).toContain('Replay: 4π × (flux above background) × 300 s for each sample of the event')
    expect(text).toContain('19 Oct 13:10 UTC to 29 Oct 22:20 UTC')
    expect(text).toContain('Integrated above 10 and 100 MeV, it can be set against')
    expect(text).toContain('up to its last energy, 2500 MeV')
    expect(text).toContain('≥100 MeV is the replay’s highest-energy integral channel')
    for (const label of ['background: median of 18 Oct', 'isotropic: ×4π sr', 'power-law segments']) expect(text).toContain(label)
  })
  it('keeps the hindsight scoring in a closed expander, with the paper’s sentence verbatim', () => {
    expect(html).toContain('<details class="lf-expander"><summary>')
    expect(text).toContain('Scored the way the RAD team scores its rule (hindsight)')
    expect(text).toContain('HINDSIGHT computed from the whole 1989 record; the case never sees the future.')
    expect(sep.literature.quotes_verified_this_build).toBe(true)
    expect(lead?.text).toBe(
      'The lead time is defined as the period in which an astronaut can avoid at least 90% of the total SEP dose (time region marked in red) and would receive only 10% of the total SEP dose (time region marked in orange).',
    )
    expect(text).toContain(`“${lead!.text}”`)
    // credited to the journal, and to the preprint the sentence was re-found in, as the paper's own quotes on this page are
    expect(sep.literature.numbers_from).toMatch(/^arXiv:2502\.02469v1 .*; the journal version was not compared$/)
    expect(lead).toMatchObject({ arxivId: '2502.02469v1', arxivUrl: 'https://arxiv.org/html/2502.02469v1' })
    expect(visible).toContain(
      'Löwe et al., Space Weather (2025), doi:10.1029/2025SW004372. Sentence from arXiv:2502.02469v1, re-checked word for word at every build; the journal version was not compared. literature',
    )
    expect(text).toContain('doi:10.1029/2025SW004372 (opens in a new tab). Sentence from arXiv:2502.02469v1 (opens in a new tab), re-checked')
    expect(html).toContain('<a href="https://doi.org/10.1029/2025SW004372" target="_blank" rel="noopener noreferrer">')
    expect(html).toContain('<a href="https://arxiv.org/html/2502.02469v1" target="_blank" rel="noopener noreferrer">')
    expect(sep.rule.lead_fraction).toBe(LEAD_FRACTION)
    expect(text).toContain('LANDFALL’s S3 trigger is the first replay sample whose ≥10 MeV flux reaches 1000 pfu NOAA-published, 19 Oct 18:55 UTC')
    expect(text).toContain('19 Oct 18:55 UTC (MET 412/14:15:00 in the scenario). Before it, 0.56 % of the ≥10 MeV fluence and 3.60 % of the ≥100 MeV fluence had arrived')
    expect(text).toContain('10 % had arrived at 20 Oct 13:20 UTC above 10 MeV, 18.4 h after the trigger, and at 19 Oct 22:55 UTC above 100 MeV, 4.0 h after it')
    expect(text).toContain('from 26 Oct 00:00 UTC')
    expect(text).toContain('(31 Oct 23:55 UTC) puts the replay between −1.9 % and +0.5 % of Table 4.8-3 above 10 MeV, and between 0.0 % and +2.7 % above 100 MeV')
  })
  it('draws the figure with a text alternative and offers the printed pairs as its table view', () => {
    expect(html).toContain('<figure class="lf-dr-figure">')
    expect(html).toContain('role="img"')
    expect(html).toContain(
      'aria-label="Table 4.8-3 integrated above each printed energy from 1.014 to 958.8 MeV, both axes logarithmic: 1.716 × 10^11 protons/cm² above 1.014 MeV, falling to 7.769 × 10^5 above 958.8 MeV.',
    )
    expect(html).toContain('1.930 × 10^10 above 10 MeV, against 1.920 × 10^10 from the table; 4.591 × 10^8 above 100 MeV, against 4.476 × 10^8 from the table.')
    expect(text).toContain('at this scale they sit on the line, and the table above gives the differences')
    expect(text).toContain('Table 4.8-3 as printed: 100 energy/fluence pairs')
    expect(text).toContain('The extraction passed 8 of its 8 checks')
    expect(visible).toContain('Energy (MeV)Proton Fluence (#/cm2-MeV)Above this energy, protons/cm²')
    expect(visible).toContain('1.000E-027.761E+148.156 × 1012')
    expect(visible).toContain('2.500E+033.891E+010')
    // both expanders start closed
    expect(html.match(/<details class="lf-expander">/g)).toHaveLength(2)
    expect(html).not.toMatch(/<details[^>]*open/)
  })
  it('never prints a dose unit, a dose limit or “validates”', () => {
    expect(html).not.toMatch(/Gy|Sv|validat/)
    expect(text).not.toMatch(/mSv|\b250\b/)
    expect(text).toContain('Fluence only: no dose is computed from either.')
  })
  it('renders the same without the paper or the scenario mapping', () => {
    const bare = renderToStaticMarkup(createElement(DesignReferenceView, { r, lead: null, triggerMet: null }))
    expect(bare).toContain('data-design-ref=""')
    expect(bare).not.toContain('MET ')
    expect(bare).not.toContain('Löwe')
    expect(bare).not.toContain('arXiv')
    expect(leadQuote({ ...sep, literature: { ...sep.literature, quotes_verified_this_build: false } })).toBeNull()
    // never quoted without the version it was checked against
    expect(leadQuote({ ...sep, literature: { ...sep.literature, arxiv_id: '' } })).toBeNull()
    expect(leadQuote({ ...sep, literature: { ...sep.literature, arxiv_html: '' } })).toBeNull()
  })
})
