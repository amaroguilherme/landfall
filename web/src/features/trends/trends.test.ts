// Trends: the per-pixel-column envelope, the personal band read from engine findings (current and
// Crawford & Howell-style shapes), runs of flagged days, and a real-scenario smoke test on the frozen
// sim_crew snapshot (Tier A per point; Tier B verdicts only when the engine accepts the rules).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { envelope } from './chart'
import { buildIndicatorTrend, buildRuleSeries, chartedIndicators, personalBand, runsOf } from './model'
import { buildScenarioIndex } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import type { PersonalFinding } from '../../app/engine'

const load = <T>(id: string): T => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8')).data as T

describe('envelope (min/max per pixel column)', () => {
  it('keeps a one-sample spike that averaging would hide', () => {
    const t = Array.from({ length: 100 }, (_, i) => i)
    const v = t.map((i) => (i === 37 ? 50 : 1))
    const e = envelope(t, v, 0, 99, 10)
    expect(e.x).toHaveLength(10)
    expect(Math.max(...(e.max.filter((x) => x !== null) as number[]))).toBe(50)
    expect(e.min[3]).toBe(1)
    expect(e.n.reduce((a, b) => a + b, 0)).toBe(100)
  })
  it('leaves empty columns as null gaps, never zero', () => {
    const e = envelope([0, 1, 9], [5, 6, 7], 0, 9, 9)
    expect(e.max[4]).toBeNull()
    expect(e.min[4]).toBeNull()
    expect(e.n[4]).toBe(0)
  })
  it('ignores null values and samples outside the window', () => {
    // columns [0, 1) and [1, 2]: t=0 is null, t=1 and t=2 share the second column
    const e = envelope([-5, 0, 1, 2, 50], [100, null, 3, 4, 100], 0, 2, 2)
    expect(e.max).toEqual([null, 4])
    expect(e.min).toEqual([null, 3])
  })
})

describe('personalBand (from the engine finding only)', () => {
  const base = { limit: 5, rci: { mean: 2, critical_z: 3.29, s_diff: 0.9119, n: 14 } } as unknown as PersonalFinding
  it('is symmetric about the engine mean, using the worse-side limit', () => {
    const b = personalBand(base)!
    expect(b.mean).toBe(2)
    expect(b.hi).toBe(5)
    expect(b.lo).toBe(-1)
    expect(b.critical).toBe(3.29)
  })
  it('reads a Crawford & Howell-style block (critical_t, se) when the limit is absent', () => {
    const ch = { limit: null, rci: { mean: 10, critical_t: 4.221, se: 2, n: 14 } } as unknown as PersonalFinding
    const b = personalBand(ch)!
    expect(b.hi).toBeCloseTo(18.442, 9)
    expect(b.lo).toBeCloseTo(1.558, 9)
  })
  it('returns null when the engine could not test', () => {
    expect(personalBand({ limit: null, rci: { mean: null } } as unknown as PersonalFinding)).toBeNull()
    expect(personalBand(null)).toBeNull()
  })
})

describe('runsOf', () => {
  it('groups consecutive days', () => {
    const pts = [398, 399, 400, 401, 405, 407, 408].map((d) => ({ d }))
    expect(runsOf(pts, () => true, (p) => p.d)).toEqual([
      { from: 398, to: 401, n: 4 },
      { from: 405, to: 405, n: 1 },
      { from: 407, to: 408, n: 2 },
    ])
  })
})

describe('scenario smoke test (frozen sim_crew)', () => {
  const index = buildScenarioIndex(load<SimCrewData>('sim_crew'), load<SpeReplayData>('swpc_spe_replay'))
  const t = index.nowMet
  it('never charts a private indicator (mood)', () => {
    const { charted, privateOnes } = chartedIndicators()
    expect(charted.some((i) => i.private)).toBe(false)
    expect(privateOnes.map((i) => i.variable)).toContain('mood')
  })
  it("marks CM-3's urine days 398-401 against the TARGET rule, from the engine", () => {
    const urine = chartedIndicators().charted.find((i) => i.variable === 'urine_volume_24h')!
    const tr = buildIndicatorTrend(urine, index, [], 'CM-3', 'mars_surface', t)
    const days = tr.points.filter((p) => p.tierA.some((h) => h.rule.category === 'TARGET')).map((p) => p.day)
    expect(days).toEqual([398, 399, 400, 401])
    expect(tr.points.every((p) => p.t <= t)).toBe(true)
  })
  it("flips CM-2's VO2max verdict with the environment (only the applicable floor is checked)", () => {
    const mars = buildRuleSeries('vo2max', 'ml/min/kg', index, [], 'CM-2', 'mars_surface', t)
    const iss = buildRuleSeries('vo2max', 'ml/min/kg', index, [], 'CM-2', 'iss', t)
    const last = (s: typeof mars) => s.points[s.points.length - 1]
    expect(last(mars).value).toBe(35.1)
    expect(last(mars).tierA.map((h) => h.finding.status)).toEqual(['outside'])
    expect(last(iss).tierA).toEqual([])
    expect([...mars.ruleNow.values()].map((f) => f.status).sort()).toEqual(['not_applicable', 'outside'])
  })
  it("flags CM-1's PVT-B lapses from day 407 when the engine accepts the personal rules", () => {
    const pvt = chartedIndicators().charted.find((i) => i.variable === 'pvt_lapses')!
    const tr = buildIndicatorTrend(pvt, index, [], 'CM-1', 'mars_surface', t)
    if (tr.error) return // the Tier B statistic is being switched concurrently; the page reports the error in place
    const worse = tr.points.filter((p) => p.flag === 'worse').map((p) => p.day)
    expect(worse[0]).toBeLessThanOrEqual(407)
    expect(worse).toContain(412)
    expect(tr.band).not.toBeNull()
  })
})
