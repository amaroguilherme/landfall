import { describe, expect, it } from 'vitest'
import { THRESHOLDS, PERSONAL, compliant, normReqId, quotedPhrase, sentencesContaining, windowLabel } from './rules'
import { erfc, falseAlarms, flagAtSd, sdInterval95, twoTailP } from './stats'

describe('method stats helpers', () => {
  it('erfc / two-tailed normal tail match known values', () => {
    expect(erfc(0)).toBeCloseTo(1, 6)
    expect(twoTailP(1.959963984540054)).toBeCloseTo(0.05, 6)
    expect(twoTailP(3.2905)).toBeCloseTo(0.001, 5)
  })
  it('the Tier B flag sits at critical_z baseline SDs only when r = 0.5', () => {
    expect(flagAtSd(3.29, 0.5)).toBeCloseTo(3.29, 12)
    expect(flagAtSd(3.29, 0.7)).toBeCloseTo(2.5484, 4)
    expect(flagAtSd(3.29, 0.8)).toBeCloseTo(2.0808, 4)
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
  it('falseAlarms reads the engine result (k x days x alpha; one every 1/(k alpha) days)', () => {
    const r = falseAlarms(8, 31, 0.001)
    expect(r.expected).toBeCloseTo(0.248, 12)
    expect(r.everyNDays).toBeCloseTo(125, 9)
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
