// The demo scenario under Tier B's single-case test, run through the TypeScript engine on the data
// the judged app ships (web/public/data/sim_crew.json) and the real engine/rules/personal.json.
// It mirrors engine/tests/test_scenario_tier_b.py and the way src/app/evaluate.ts evaluates Tier B:
// the baseline is the fixed scenario window, MET days 368-381 (SPEC section 7), and the measurement
// day of an observation is floor((t - 1) / 86400), so a 24-h total stamped at the end of its day
// counts for that day.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RULES, evaluatePersonal, expectedFalseAlarms, tCritical } from './index'
import type { ObservationValue, PersonalFinding } from './index'

interface Series {
  unit: string
  t: number[]
  v: Array<number | null>
}
interface SimCrew {
  data: { met: { baseline_days: [number, number] }; crew: Array<{ crew_id: string; series: Record<string, Series> }> }
}

const SIM = JSON.parse(readFileSync(new URL('../../public/data/sim_crew.json', import.meta.url), 'utf8')) as SimCrew
const DAY = 86400
const BASELINE: [number, number] = [368, 381]
const measurementDay = (t: number): number => Math.floor((t - 1) / DAY)

/** (crew, indicator, day) -> finding, for every day after the baseline. */
function evaluateScenario(): Map<string, PersonalFinding> {
  const personal = RULES.personal!
  const out = new Map<string, PersonalFinding>()
  for (const crew of SIM.data.crew) {
    for (const ind of personal.indicators) {
      const ser = crew.series[ind.variable]
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
        if (day > BASELINE[1]) out.set(`${crew.crew_id}|${ind.id}|${day}`, evaluatePersonal(ind, base, o, personal.rci, o.t as number))
      }
    }
  }
  return out
}

const FINDINGS = evaluateScenario()

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

  it('CM-1 PVT-B lapses: a reliable change by MET day 407 (from day 406, then every day)', () => {
    const days = cautionDays('CM-1', 'pvt_lapses')
    expect(days[0]).toBeLessThanOrEqual(407) // SPEC section 7
    expect(days).toEqual([406, 407, 408, 409, 410, 411, 412])
    const f407 = FINDINGS.get('CM-1|pvt_lapses|407')!
    expect(f407).toMatchObject({ status: 'reliable_change', value: 7, case_id: 'sleep_circadian', direction: 'increase' })
    expect(f407.rci.rc as number).toBeGreaterThan(1.5 * (f407.rci.critical as number))
  })

  it('CM-3 24-h urine output: a reliable drop on MET days 398-401, with fluid intake', () => {
    expect(cautionDays('CM-3', 'urine_volume_24h')).toEqual([398, 399, 400, 401])
    for (const d of [398, 399, 400, 401]) {
      const f = FINDINGS.get(`CM-3|urine_volume_24h|${d}`)!
      expect(f.direction).toBe('decrease')
      expect(f.rci.rc as number).toBeLessThan(-2 * (f.rci.critical as number))
      expect(f.case_id).toBe('renal_stone')
    }
    expect(cautionDays('CM-3', 'fluid_intake_24h')).toEqual([398, 399, 400, 401])
  })

  it('only the scripted episodes change reliably; mood is private and never alerts', () => {
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
      if (i === 'mood') expect([f.severity, f.private], key).toEqual(['nominal', true])
    }
  })

  it('prints the expected chance rate for the alerting indicators the app counts', () => {
    const k = RULES.personal!.indicators.filter((i) => i.alerting && i.private !== true).length
    expect(k).toBe(8)
    const fa = expectedFalseAlarms(k, 1, RULES.personal!.rci.alpha_two_tailed)
    expect(fa.text).toBe('one false flag every 125 days on average, counting chance changes in either direction')
    expect(fa.caution_text).toBe(
      'one false caution every 250 days on average: only a chance change in the worse direction raises a caution',
    )
  })
})
