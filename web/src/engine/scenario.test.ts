// The demo scenario under Tier B's single-case test, run through the TypeScript engine on the data
// the judged app ships (web/public/data/sim_crew.json) and the real engine/rules/personal.json.
// It mirrors engine/tests/test_scenario_tier_b.py and the way src/app/evaluate.ts evaluates Tier B:
// the baseline is the fixed scenario window, MET days 368-381 (SPEC section 7), and the measurement
// day of an observation is floor((t - 1) / 86400), so a 24-h total stamped at the end of its day
// counts for that day.
//
// What Tier B detects depends on the simulated noise, which the generator calibrates. The generator
// publishes its own run of the same test in data.self_check.tier_b; when it is present these tests
// cross-check the engine against it. The earlier scenario's day-by-day expectations run only on a
// sim_crew.json that predates that report.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RULES, evaluatePersonal, expectedFalseAlarms, minDetectableChange, tCritical } from './index'
import type { ObservationValue, PersonalFinding } from './index'

interface Series {
  unit: string
  t: number[]
  v: Array<number | null>
}
interface TierBRow {
  indicator_id: string
  baseline_n: number
  baseline_mean?: number
  mdc?: number | null
}
interface TierBReport {
  per_crew: Record<string, { indicators: TierBRow[] }>
  episodes: Array<{ crew_id: string; indicator_id: string; scripted_days: [number, number]; tier_b_flagged_days: number[] }>
  chance_flags: Array<{ crew_id: string; indicator_id: string; day: number; severity: string }>
}
interface SimCrew {
  data: {
    met: { baseline_days: [number, number] }
    crew: Array<{ crew_id: string; series: Record<string, Series | undefined> }>
    self_check?: { tier_b?: TierBReport }
  }
}

const SIM = JSON.parse(readFileSync(new URL('../../public/data/sim_crew.json', import.meta.url), 'utf8')) as SimCrew
const REPORT: TierBReport | null = SIM.data.self_check?.tier_b ?? null
const DAY = 86400
const BASELINE: [number, number] = [368, 381]
const measurementDay = (t: number): number => Math.floor((t - 1) / DAY)
const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

/** (crew, indicator, day) -> finding, for every day after the baseline; plus the indicators without a series. */
function evaluateScenario(): { findings: Map<string, PersonalFinding>; missing: Set<string> } {
  const personal = RULES.personal!
  const findings = new Map<string, PersonalFinding>()
  const missing = new Set<string>()
  for (const crew of SIM.data.crew) {
    for (const ind of personal.indicators) {
      const ser = crew.series[ind.variable]
      if (ser === undefined) {
        missing.add(ind.id)
        continue
      }
      const obs: ObservationValue[] = []
      ser.t.forEach((t, i) => {
        const v = ser.v[i]
        if (v !== null) obs.push({ variable: ind.variable, value: v, unit: ser.unit, t })
      })
      const base = obs.filter((o) => {
        const d = measurementDay(o.t as number)
        return d >= BASELINE[0] && d <= BASELINE[1]
      })
      for (const o of obs) {
        const day = measurementDay(o.t as number)
        if (day > BASELINE[1]) findings.set(`${crew.crew_id}|${ind.id}|${day}`, evaluatePersonal(ind, base, o, personal.rci, o.t as number))
      }
    }
  }
  return { findings, missing }
}

const { findings: FINDINGS, missing: MISSING } = evaluateScenario()

function cautionDays(crew: string, indicator: string): number[] {
  const days: number[] = []
  for (const [key, f] of FINDINGS) {
    const [c, i, d] = key.split('|')
    if (c === crew && i === indicator && f.severity === 'caution') days.push(Number(d))
  }
  return days.sort((a, b) => a - b)
}

describe('demo scenario on the shipped sim_crew.json (TypeScript engine)', () => {
  it('uses the scenario baseline window: n 14, df 13, critical 4.221 for every finding', () => {
    expect(SIM.data.met.baseline_days).toEqual(BASELINE)
    expect(FINDINGS.size).toBeGreaterThan(0)
    for (const f of FINDINGS.values()) {
      expect([f.rci.n, f.rci.df, f.rci.method]).toEqual([14, 13, 'crawford_howell_1998'])
      expect(f.rci.critical).toBe(tCritical(0.001, 13))
    }
    expect(Math.round(tCritical(0.001, 13) * 1000) / 1000).toBe(4.221)
  })

  it('every finding carries its minimum detectable change (critical x s_diff)', () => {
    for (const [key, f] of FINDINGS) {
      const r = f.rci
      if (r.sd === 0) {
        expect(r.mdc, key).toBeNull()
        continue
      }
      expect(r.mdc, key).toBe((r.critical as number) * (r.s_diff as number))
      expect(r.mdc, key).toBe(minDetectableChange(r.sd as number, r.n, r.alpha).mdc)
    }
  })

  it('caution only for a reliable change in the worse direction of an alerting indicator; mood never alerts', () => {
    const inds = new Map(RULES.personal!.indicators.map((i) => [i.id, i]))
    for (const [key, f] of FINDINGS) {
      const ind = inds.get(key.split('|')[1])!
      const worse = ind.worse === 'either' || f.direction === ind.worse
      const expected = f.status === 'reliable_change' && worse && ind.alerting ? 'caution' : 'nominal'
      expect(f.severity, `${key}: ${f.why}`).toBe(expected)
      if (ind.id === 'mood') expect([f.severity, f.private], key).toEqual(['nominal', true])
    }
  })

  it.runIf(REPORT !== null)('every indicator has a series (D8 manual vitals included)', () => {
    expect([...MISSING]).toEqual([])
  })

  it.runIf(REPORT !== null)("agrees with the generator's own Tier B report (data.self_check.tier_b)", () => {
    const rep = REPORT as TierBReport
    for (const [cid, block] of Object.entries(rep.per_crew)) {
      for (const row of block.indicators) {
        const mine = [...FINDINGS].find(([k]) => k.startsWith(`${cid}|${row.indicator_id}|`))
        if (!mine) continue
        const r = mine[1].rci
        expect(r.n, `${cid} ${row.indicator_id}`).toBe(row.baseline_n)
        if (typeof row.baseline_mean === 'number') expect(close(r.mean as number, row.baseline_mean, 1e-4), `${cid} ${row.indicator_id} mean`).toBe(true)
        if (typeof row.mdc === 'number') expect(close(r.mdc as number, row.mdc, 1e-4), `${cid} ${row.indicator_id} mdc`).toBe(true)
      }
    }
    const reported = new Set<string>()
    for (const ep of rep.episodes) {
      const [d0, d1] = ep.scripted_days
      const got = cautionDays(ep.crew_id, ep.indicator_id).filter((d) => d >= d0 && d <= d1)
      expect(got, `${ep.crew_id} ${ep.indicator_id}`).toEqual([...ep.tier_b_flagged_days].sort((a, b) => a - b))
      for (const d of got) reported.add(`${ep.crew_id}|${ep.indicator_id}|${d}`)
    }
    for (const cf of rep.chance_flags) {
      if (cf.severity !== 'caution') continue
      const key = `${cf.crew_id}|${cf.indicator_id}|${cf.day}`
      expect(FINDINGS.get(key)?.severity, key).toBe('caution')
      reported.add(key)
    }
    const extra = [...FINDINGS].filter(([k, f]) => f.severity === 'caution' && !reported.has(k)).map(([k]) => k)
    expect(extra).toEqual([])
  })

  it.runIf(REPORT === null)('earlier scenario: CM-1 PVT-B lapses from day 406, CM-3 urine on days 398-401, nothing else', () => {
    expect(cautionDays('CM-1', 'pvt_lapses')).toEqual([406, 407, 408, 409, 410, 411, 412])
    const f407 = FINDINGS.get('CM-1|pvt_lapses|407')!
    expect(f407).toMatchObject({ status: 'reliable_change', value: 7, case_id: 'sleep_circadian', direction: 'increase' })
    expect(cautionDays('CM-3', 'urine_volume_24h')).toEqual([398, 399, 400, 401])
    expect(cautionDays('CM-3', 'fluid_intake_24h')).toEqual([398, 399, 400, 401])
    const scripted: Record<string, [number, number]> = {
      'CM-3|urine_volume_24h': [398, 401],
      'CM-3|fluid_intake_24h': [398, 401],
      'CM-1|sleep_duration': [404, 412],
      'CM-1|sleep_midpoint_shift': [404, 412],
      'CM-1|pvt_lapses': [406, 412],
      'CM-1|pvt_median_rt': [406, 412],
    }
    for (const [key, f] of FINDINGS) {
      const [c, i, d] = key.split('|')
      const window = scripted[`${c}|${i}`]
      const inEpisode = window !== undefined && Number(d) >= window[0] && Number(d) <= window[1]
      if (inEpisode) expect([f.status, f.severity], key).toEqual(['reliable_change', 'caution'])
      else expect([f.status, f.severity], `${key}: ${f.why}`).toEqual(['within', 'nominal'])
    }
  })

  it('prints the expected chance rate for the alerting indicators the app counts (glucose alerts both ways)', () => {
    const alerting = RULES.personal!.indicators.filter((i) => i.alerting && i.private !== true)
    expect(alerting.length).toBe(11)
    const either = alerting.filter((i) => i.worse === 'either').map((i) => i.id)
    expect(either).toEqual(['glucose'])
    const fa = expectedFalseAlarms(alerting.length, 1, RULES.personal!.rci.alpha_two_tailed, either.length)
    expect(fa.text).toBe('one false flag every 90.9 days on average, counting chance changes in either direction')
    expect(fa.caution_text).toBe(
      'one false caution every 166.7 days on average: a chance change in the worse direction raises a caution, ' +
        'and in either direction for the 1 indicator(s) that alert both ways',
    )
    // without the either-direction indicator the old wording is unchanged
    expect(expectedFalseAlarms(8, 1, 0.001).caution_text).toBe(
      'one false caution every 250 days on average: only a chance change in the worse direction raises a caution',
    )
  })
})
