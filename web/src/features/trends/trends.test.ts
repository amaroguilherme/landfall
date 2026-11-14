// Trends: the per-pixel-column envelope, the personal band read from engine findings (current and
// Crawford & Howell-style shapes), runs of flagged days, and a real-scenario smoke test on the frozen
// sim_crew snapshot (Tier A per point; Tier B verdicts only when the engine accepts the rules).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { envelope } from './chart'
import { minDetectableChange } from '../../app/engine'
import {
  alertingEitherCount,
  alertingIndicatorCount,
  buildIndicatorTrend,
  buildRuleSeries,
  cadenceOf,
  chartedIndicators,
  displayBand,
  personalBand,
  runsOf,
  scenarioNote,
} from './model'
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

describe('displayBand (drawn band) and cadence', () => {
  const band = (mean: number, half: number) => ({ mean, lo: mean - half, hi: mean + half, critical: 4.221, scale: half / 4.221, n: 14, mdc: half })
  it('clamps a lower edge below zero at 0 for counts and other non-negative quantities, and says why', () => {
    expect(displayBand(band(0.79, 4.26), 'count')).toEqual({ lo: 0, hi: 0.79 + 4.26, clamped: true, note: 'lower edge drawn at 0: counts, approximate' })
    const mid = displayBand(band(0.31, 1.39), 'h')
    expect(mid.lo).toBe(0)
    expect(mid.note).toMatch(/never negative/)
    expect(displayBand(band(6.19, 5.89), 'h')).toMatchObject({ clamped: false, note: null })
    expect(displayBand(band(0.2, 1), '°C')).toMatchObject({ clamped: false })
  })
  it('reads the cadence after the baseline from the points themselves', () => {
    const pt = (day: number, baseline = false) => ({ t: day * 86_400, day, value: 1, provenance: 'simulated', baseline, finding: null, flag: null, tierA: [] })
    expect(cadenceOf([pt(380, true), pt(382), pt(383), pt(384)])).toBe('daily')
    expect(cadenceOf([pt(381, true), pt(382), pt(385), pt(389), pt(392)])).toBe('twice a week')
    expect(cadenceOf([pt(382)])).toBeNull()
  })
})

interface SelfCheck {
  tier_b: {
    per_crew: Record<string, { indicators: Array<{ indicator_id: string; baseline_n: number; mdc: number; model_sd: number | null; mdc_at_model_sd: number | null }> }>
    episodes: Array<{ crew_id: string; indicator_id: string; tier_b_flagged_days: number[] }>
    chance_flags: Array<{ crew_id: string; indicator_id: string; day: number; worse_direction: boolean }>
  }
  tier_a_urine: { below_outside: Array<{ crew_id: string; day: number }>; below_approach: Array<{ crew_id: string; day: number }> }
}

describe('scenario (frozen sim_crew): Trends agrees with the generator’s own report', () => {
  const sim = load<SimCrewData & { self_check: SelfCheck }>('sim_crew')
  const index = buildScenarioIndex(sim, load<SpeReplayData>('swpc_spe_replay'))
  const t = index.nowMet
  const sc = sim.self_check
  const CREW = ['CM-1', 'CM-2', 'CM-3', 'CM-4'] as const
  it('never charts a private indicator (mood), and charts the new manual indicators', () => {
    const { charted, privateOnes } = chartedIndicators()
    expect(charted.some((i) => i.private)).toBe(false)
    expect(privateOnes.map((i) => i.variable)).toContain('mood')
    for (const v of ['bp_systolic', 'bp_diastolic', 'glucose']) expect(charted.map((i) => i.variable)).toContain(v)
  })
  it('flags exactly the days the generator reports, for every crewmember and indicator (episodes and chance flags)', () => {
    let checked = 0
    for (const crewId of CREW) {
      for (const ind of chartedIndicators().charted) {
        const tr = buildIndicatorTrend(ind, index, [], crewId, 'mars_surface', t)
        expect(tr.error, `${crewId} ${ind.id}`).toBeNull()
        const worse = tr.points.filter((p) => p.flag === 'worse').map((p) => p.day)
        const other = tr.points.filter((p) => p.flag === 'better').map((p) => p.day)
        const ep = sc.tier_b.episodes.filter((e) => e.crew_id === crewId && e.indicator_id === ind.id).flatMap((e) => e.tier_b_flagged_days)
        const chance = sc.tier_b.chance_flags.filter((c) => c.crew_id === crewId && c.indicator_id === ind.id)
        expect(worse, `${crewId} ${ind.id} worse`).toEqual([...ep, ...chance.filter((c) => c.worse_direction).map((c) => c.day)].sort((a, b) => a - b))
        expect(other, `${crewId} ${ind.id} other`).toEqual(chance.filter((c) => !c.worse_direction).map((c) => c.day).sort((a, b) => a - b))
        checked += 1
      }
    }
    expect(checked).toBe(4 * chartedIndicators().charted.length)
  })
  it('prints the engine’s minimum detectable change, equal to the generator’s, and the same at the noise SD', () => {
    for (const crewId of CREW) {
      for (const row of sc.tier_b.per_crew[crewId].indicators) {
        const ind = chartedIndicators().charted.find((i) => i.id === row.indicator_id)
        if (!ind) continue
        const tr = buildIndicatorTrend(ind, index, [], crewId, 'mars_surface', t)
        expect(tr.band?.mdc, `${crewId} ${ind.id}`).toBeCloseTo(row.mdc, 3)
        expect(tr.band?.n).toBe(row.baseline_n)
        const note = scenarioNote(sim, crewId, ind.id, ind.variable)
        expect(note.modelSd).toBe(row.model_sd)
        if (row.model_sd !== null && row.mdc_at_model_sd !== null) expect(minDetectableChange(row.model_sd, row.baseline_n).mdc).toBeCloseTo(row.mdc_at_model_sd, 3)
      }
    }
  })
  it('names the basis of the simulator’s noise SD from its calibration entry', () => {
    expect(scenarioNote(sim, 'CM-1', 'sleep_duration', 'sleep_duration').modelSdChip).toBe('literature')
    expect(scenarioNote(sim, 'CM-1', 'resting_hr', 'resting_hr').modelSdChip).toBe('literature')
    expect(scenarioNote(sim, 'CM-1', 'glucose', 'glucose').modelSdChip).toBe('derived')
    expect(scenarioNote(sim, 'CM-1', 'bp_systolic', 'bp_systolic').modelSdChip).toBe('design choice')
    expect(scenarioNote(sim, 'CM-1', 'sleep_midpoint_shift', 'sleep_midpoint_shift').modelSdChip).toBe('design choice')
  })
  it('knows which days the scenario scripted, so other flags read as chance flags', () => {
    const note = scenarioNote(sim, 'CM-1', 'sleep_midpoint_shift', 'sleep_midpoint_shift')
    expect([...note.scriptedDays].sort((a, b) => a - b)).toEqual([404, 405, 406, 407, 408, 409, 410, 411, 412])
    expect(note.scriptedDays.has(383)).toBe(false)
    expect(scenarioNote(sim, 'CM-3', 'sleep_midpoint_shift', 'sleep_midpoint_shift').scriptedDays.size).toBe(0)
    const urine = scenarioNote(sim, 'CM-3', 'urine_volume_24h', 'urine_volume_24h')
    expect(urine.episodes).toHaveLength(1)
    expect(urine.episodes[0]).toMatchObject({ from: 398, to: 401, flaggedDays: [], tierAOutsideDays: [398, 399, 400, 401] })
  })
  it("marks CM-3's urine against the TARGET rule exactly as the generator reports: outside 398-401, approaching elsewhere", () => {
    const urine = chartedIndicators().charted.find((i) => i.variable === 'urine_volume_24h')!
    for (const crewId of CREW) {
      const tr = buildIndicatorTrend(urine, index, [], crewId, 'mars_surface', t)
      const days = (status: string) => tr.points.filter((p) => p.tierA.some((h) => h.rule.category === 'TARGET' && h.finding.status === status)).map((p) => p.day)
      const outside = sc.tier_a_urine.below_outside.filter((x) => x.crew_id === crewId).map((x) => x.day)
      expect(days('outside'), crewId).toEqual(outside)
      // The generator lists every day below the approach level; the outside ones are marked outside.
      expect(days('approaching'), crewId).toEqual(sc.tier_a_urine.below_approach.filter((x) => x.crew_id === crewId && !outside.includes(x.day)).map((x) => x.day))
      expect(tr.points.every((p) => p.t <= t)).toBe(true)
    }
  })
  it("flips CM-2's VO2max verdict with the environment (only the applicable floor is checked)", () => {
    const mars = buildRuleSeries('vo2max', 'ml/min/kg', index, [], 'CM-2', 'mars_surface', t)
    const iss = buildRuleSeries('vo2max', 'ml/min/kg', index, [], 'CM-2', 'iss', t)
    const last = (s: typeof mars) => s.points[s.points.length - 1]
    expect(last(mars).value).toBe(35.1)
    expect(last(mars).tierA.map((h) => [h.finding.status, h.finding.severity])).toEqual([['outside', 'caution']])
    expect(last(iss).tierA).toEqual([])
    expect([...mars.ruleNow.values()].map((f) => f.status).sort()).toEqual(['not_applicable', 'outside'])
  })
  it('counts glucose as the one indicator that alerts both ways (k_either)', () => {
    expect(alertingIndicatorCount()).toBe(11)
    expect(alertingEitherCount()).toBe(1)
  })
  it('reads the twice-a-week cadence of the manual readings', () => {
    const bp = chartedIndicators().charted.find((i) => i.variable === 'bp_systolic')!
    expect(cadenceOf(buildIndicatorTrend(bp, index, [], 'CM-1', 'mars_surface', t).points)).toBe('twice a week')
    const sleep = chartedIndicators().charted.find((i) => i.variable === 'sleep_duration')!
    expect(cadenceOf(buildIndicatorTrend(sleep, index, [], 'CM-1', 'mars_surface', t).points)).toBe('daily')
  })
})
