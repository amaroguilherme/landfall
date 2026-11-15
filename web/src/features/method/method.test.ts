import { describe, expect, it } from 'vitest'
import { tCdf, tCritical } from '../../app/engine'
import { META, THRESHOLDS, PERSONAL, compliant, normReqId, quotedPhrase, sentencesContaining, windowLabel } from './rules'
import { chanceRates, countsEither, criticalRow, measuredMultiplier, sdInterval95, unlimitedRow } from './stats'

const round3 = (x: number): number => Math.round(x * 1000) / 1000

describe('method stats helpers', () => {
  it('critical values come from the engine: 4.221 for a 14-day baseline, 5.959 for 7, 3.291 unlimited', () => {
    const full = criticalRow(0.001, 14)
    expect([full.n, full.df, round3(full.critical)]).toEqual([14, 13, 4.221])
    expect(full.critical).toBe(tCritical(0.001, 13))
    expect(full.bandSd).toBeCloseTo(full.critical * Math.sqrt(15 / 14), 12)
    expect(round3(full.bandSd)).toBe(4.369)
    expect(round3(criticalRow(0.001, 7).critical)).toBe(5.959)
    const inf = unlimitedRow(0.001)
    expect([inf.n, round3(inf.critical)]).toEqual([null, 3.291])
  })
  it('chance rates come from the engine: flags k x days x alpha, cautions half of that', () => {
    const r = chanceRates(8, 31, 0.001)
    expect(r.expected).toBeCloseTo(0.248, 12)
    expect(r.every_n_days).toBeCloseTo(125, 9)
    expect(r.expected_cautions).toBeCloseTo(0.124, 12)
    expect(r.caution_every_n_days).toBeCloseTo(250, 9)
    expect(r.text).toBe('one false flag every 125 days on average, counting chance changes in either direction')
    expect(r.caution_text).toMatch(/^one false caution every 250 days on average: only a chance change in the worse direction/)
  })
  it('SD 95% interval (Wilson-Hilferty) is close to the exact chi-square interval', () => {
    const n14 = sdInterval95(14) // exact: 0.725 .. 1.611
    expect(n14.lo).toBeCloseTo(0.725, 2)
    expect(n14.hi).toBeGreaterThan(1.6)
    expect(n14.hi).toBeLessThan(1.62)
    const n7 = sdInterval95(7) // exact: 0.644 .. 2.202
    expect(n7.lo).toBeCloseTo(0.644, 2)
    expect(n7.hi).toBeGreaterThan(2.19)
    expect(n7.hi).toBeLessThan(2.24)
  })
})

describe('the Tier B text the page prints from the rules files', () => {
  const rci = PERSONAL!.rci
  it('reads alpha and the baseline lengths, with no stored critical value or reliability', () => {
    expect(rci.alpha_two_tailed).toBe(0.001)
    expect(Object.hasOwn(rci, 'critical_z')).toBe(false)
    expect(Object.keys(rci.provenance).sort()).toEqual(['alpha_two_tailed', 'baseline_window_days', 'min_baseline_n'])
    for (const ind of PERSONAL!.indicators) {
      if (ind.reliability_r) expect([ind.reliability_r.value, ind.reliability_r.used_by_engine], ind.id).toEqual([null, false])
    }
  })
  it("quotes the engine's critical values (personal.json rci.method, meta.json Tier B)", () => {
    const full = String(round3(tCritical(rci.alpha_two_tailed, rci.baseline_window_days - 1)))
    const fewest = String(round3(tCritical(rci.alpha_two_tailed, rci.min_baseline_n - 1)))
    expect(rci.method).toContain(full)
    expect(rci.method).toContain(fewest)
    expect(META!.tiers.find((t) => t.id === 'B')?.definition).toContain(full)
  })
  it('an indicator that alerts in both directions is passed to the engine, and the caution count follows', () => {
    const e = PERSONAL!.indicators.filter((i) => i.alerting && i.worse === 'either').length
    const k = PERSONAL!.indicators.filter((i) => i.alerting).length
    const r = chanceRates(k, 31, 0.001, e)
    expect(r.expected).toBeCloseTo(k * 31 * 0.001, 12)
    if (countsEither(r)) expect(r.expected_cautions).toBeCloseTo(((k - e) * 31 * 0.001) / 2 + e * 31 * 0.001, 12)
    else expect(r.expected_cautions).toBeCloseTo((k * 31 * 0.001) / 2, 12) // the page then says the caution figure is too low
  })
  it("the change note's figure is what the earlier arithmetic gives (Student's t, 14-day baseline)", () => {
    // The earlier rule flagged |x - mean| >= 3.29 x sqrt(2 (1 - r)) x SD with r = 0.8. For a new day from the same
    // normal noise, (x - mean) / (SD sqrt(1 + 1/n)) follows t with n - 1 df, so its realized two-sided rate is:
    const n = 14
    const rate = 2 * tCdf((-3.29 * Math.sqrt(2 * (1 - 0.8))) / Math.sqrt(1 + 1 / n), n - 1)
    expect(rate).toBeGreaterThan(0.065)
    expect(rate).toBeLessThan(0.066)
    expect(rci.change_note).toContain(`about ${(Math.round(rate * 1000) / 10).toFixed(1)}%`)
    expect(rci.change_note).toContain('r = 0.8')
    // ... while the single-case test's own critical value gives alpha (to the bisection's 2^-33 in t)
    const own = 2 * tCdf(-tCritical(rci.alpha_two_tailed, n - 1), n - 1)
    expect(Math.abs(own / rci.alpha_two_tailed - 1)).toBeLessThan(1e-8)
  })
})

describe('method rules helpers', () => {
  it('normalises requirement ids from both volumes', () => {
    expect(normReqId('[V2 6022]')).toBe('V2 6022')
    expect(normReqId('V1 4006')).toBe('V1 4006')
  })
  it('labels windows from ISO durations', () => {
    expect(windowLabel({ kind: 'cumulative', duration: 'P30D' })).toBe('30-day')
    expect(windowLabel({ kind: 'cumulative', duration: 'P1Y' })).toBe('1-year')
    expect(windowLabel({ kind: 'rolling_mean', duration: 'PT1H' })).toBe('1-hour')
    expect(windowLabel({ kind: 'career' })).toBe('career')
  })
  it('compliant() follows SPEC 3.2 op semantics', () => {
    expect(compliant('ge', 35.1, 32.9)).toBe(true)
    expect(compliant('ge', 35.1, 36.5)).toBe(false)
    expect(compliant('lt', 600, 600)).toBe(false)
    expect(compliant('le', 3, 3)).toBe(true)
  })
  it('extracts verified phrases and rationale sentences verbatim', () => {
    expect(quotedPhrase("statement contains 'shall be operationally defined'")).toBe('shall be operationally defined')
    const rat = 'First sentence. The crew must be alerted even if ground communication is disrupted or is unviable. Last.'
    expect(sentencesContaining(rat, ['ground communication is disrupted'])).toEqual([
      'The crew must be alerted even if ground communication is disrupted or is unviable.',
    ])
  })
  it('the rules files are bundled', () => {
    expect(THRESHOLDS?.rules.length).toBeGreaterThan(0)
    expect(PERSONAL?.indicators.length).toBeGreaterThan(0)
  })
})

describe('no NASA or NOAA number is typed into the Method TSX', () => {
  const sources = import.meta.glob<string>('./*.tsx', { query: '?raw', import: 'default', eager: true })
  const published = (THRESHOLDS?.rules ?? [])
    .filter((r) => r.chip === 'NASA-published' || r.chip === 'NOAA-published')
    .map((r) => r.limit)
    // Tiny integers and 100 (percent conversion) are too common in code to be evidence.
    .filter((v) => !Number.isInteger(v) || (v >= 10 && v !== 100))
  const values = [...new Set(published)]
  it('found published limits to check', () => {
    expect(values.length).toBeGreaterThan(5)
  })
  for (const [file, raw] of Object.entries(sources)) {
    it(`${file} has no published limit as a literal`, () => {
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const v of values) {
        const lit = String(v).replace('.', '\\.')
        expect(code, `${file} contains ${v}`).not.toMatch(new RegExp(`(?<![\\w.])${lit}(?![\\w.])`))
      }
    })
  }
})

describe('the measured multipliers of the Tier B evidence table (SPEC 3.3: 0.495 never prints 0.50)', () => {
  interface Mc { tests: number; flags: number; worse_direction_flags: number; nominal_caution_rate: number; nominal_flag_rate: number; caution_multiplier: number; flag_multiplier: number; within_band: boolean }
  const sim = Object.values(import.meta.glob<{ data: { self_check: { chance_rates: { band: [number, number]; per_indicator: Record<string, Mc> } } } }>('../../../public/data/sim_crew.json', { eager: true, import: 'default' }))[0]
  const study = sim.data.self_check.chance_rates
  const shown = (m: { value: number | null; digits: number }) => (m.value === null ? null : m.value.toFixed(m.digits))
  it('prints every multiplier as personal.json declares it, and the stored 2-decimal value where that is not borderline', () => {
    for (const [id, mc] of Object.entries(study.per_indicator)) {
      const cm = measuredMultiplier(mc.worse_direction_flags, mc.tests, mc.nominal_caution_rate, mc.caution_multiplier, study.band)
      const fm = measuredMultiplier(mc.flags, mc.tests, mc.nominal_flag_rate, mc.flag_multiplier, study.band)
      const decl = PERSONAL?.indicators.find((i) => i.id === id)?.chance_rate
      if (decl) expect([Number(shown(cm)), Number(shown(fm))], id).toEqual([decl.caution_multiplier, decl.flag_multiplier])
      for (const [m, stored] of [[cm, mc.caution_multiplier], [fm, mc.flag_multiplier]] as const) if (m.digits === 2) expect(Number(shown(m)), id).toBe(stored)
    }
    const mood = study.per_indicator.mood
    expect(shown(measuredMultiplier(mood.flags, mood.tests, mood.nominal_flag_rate, mood.flag_multiplier, study.band))).toBe('0.495')
    expect(mood.within_band).toBe(false)
  })
  it('falls back to the stored value without counts, and reports no value without either', () => {
    expect(measuredMultiplier(undefined, undefined, undefined, 1.07, [0.5, 2])).toEqual({ value: 1.07, digits: 2 })
    expect(measuredMultiplier(undefined, 0, 0.001, undefined, null)).toEqual({ value: null, digits: 2 })
    expect(measuredMultiplier(1999, 1_000_000, 0.001, undefined, [0.5, 2]).digits).toBe(3) // 1.999 would print 2.00, a band edge
    expect(measuredMultiplier(500, 1_000_000, 0.001, undefined, [0.5, 2]).digits).toBe(2) // exactly on the edge: 0.50 is true
  })
})
