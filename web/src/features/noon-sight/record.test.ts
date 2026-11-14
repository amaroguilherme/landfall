import { describe, expect, it } from 'vitest'
import type { Observation } from '../../app/vocab'
import { scorePvt } from './pvt'
import {
  EMPTY_ANSWERS,
  baselineMean,
  buildObservations,
  collectFixes,
  computeStreak,
  lastNight,
  logbookText,
  parseMl,
  seriesPoints,
  weekCompleteness,
} from './record'
import type { SimCrewMember } from './record'

const D = 86_400
const at = (day: number, h = 12) => day * D + h * 3600
const pts = (...ts: number[]) => ts.map((t) => ({ t, v: 3 }))

describe('seriesPoints', () => {
  it('expands t/v and start_t/step_s series and skips nulls', () => {
    expect(seriesPoints({ unit: 'h', source: 'band', t: [10, 20, 30], v: [1, null, 3] })).toEqual([
      { t: 10, v: 1 },
      { t: 30, v: 3 },
    ])
    expect(seriesPoints({ unit: 'bpm', source: 'band', start_t: 100, step_s: 60, v: [50, 51] })).toEqual([
      { t: 100, v: 50 },
      { t: 160, v: 51 },
    ])
    expect(seriesPoints(undefined)).toEqual([])
  })
})

describe('streak', () => {
  it('counts consecutive MET days ending today', () => {
    const fixes = collectFixes(pts(at(408), at(409), at(410), at(411), at(412)), [], at(412, 14))
    const s = computeStreak(fixes, 412)
    expect(s).toMatchObject({ length: 5, firstDay: 408, lastDay: 412, todayDone: true })
  })

  it('keeps the streak alive (ending yesterday) while today is still open', () => {
    const s = computeStreak(collectFixes(pts(at(410), at(411)), [], at(412, 9)), 412)
    expect(s).toMatchObject({ length: 2, lastDay: 411, todayDone: false })
  })

  it('breaks on a missed day and counts a day once however many fixes it has', () => {
    const fixes = collectFixes(pts(at(405), at(407), at(408)), [at(408, 15)], at(408, 16))
    const s = computeStreak(fixes, 408)
    expect(s.length).toBe(2)
    expect(s.today.map((f) => f.origin)).toEqual(['simulated', 'session'])
  })

  it('ignores fixes later than now', () => {
    const s = computeStreak(collectFixes(pts(at(411), at(412)), [], at(412, 11)), 412)
    expect(s).toMatchObject({ length: 1, todayDone: false })
  })

  it('is zero with no fixes', () => {
    expect(computeStreak([], 412)).toMatchObject({ length: 0, firstDay: null, lastDay: null, todayDone: false })
  })
})

describe('weekCompleteness', () => {
  const obs = (variable: string, t: number, crew_id: Observation['crew_id'] = 'CM-1'): Observation => ({
    crew_id,
    variable,
    value: 1,
    unit: 'x',
    t,
    source: 'app',
    provenance: 'simulated',
  })
  it('counts the four daily entries per day over the last 7 days; mood never counts', () => {
    const list = [
      obs('pvt_lapses', at(412, 8)),
      obs('sleep_duration', at(412, 7)),
      obs('mood', at(412, 12)),
      obs('fluid_intake_24h', at(411, 0)),
      obs('urine_volume_24h', at(405, 0)), // outside the 406-412 window
      obs('pvt_lapses', at(410, 8), 'CM-2'), // another crewmember
      obs('sleep_duration', at(412, 20)), // after now
    ]
    const w = weekCompleteness(list, 'CM-1', 412, at(412, 14))
    expect(w.expected).toBe(28)
    expect(w.days.map((d) => d.day)).toEqual([406, 407, 408, 409, 410, 411, 412])
    expect(w.days[6]).toMatchObject({ logged: 2, entries: { pvt: true, sleep: true, fluid: false, urine: false } })
    expect(w.days[5].entries.fluid).toBe(true)
    expect(w.logged).toBe(3)
  })
})

describe('baselineMean and lastNight', () => {
  const member: SimCrewMember = {
    crew_id: 'CM-1',
    role: 'Commander',
    series: {
      sleep_duration: { unit: 'h', source: 'band', t: [at(368, 6), at(369, 6), at(412, 7)], v: [6, 7, 4.35] },
      sleep_midpoint_shift: { unit: 'h', source: 'band', t: [at(368, 6), at(369, 6), at(412, 7)], v: [0, 0.2, 2.5] },
    },
    sleep_episodes: { days: [368, 412], v: [[at(368, 0), at(368, 6)], null, [at(412, 2), at(412, 7)]] },
  }
  it('averages only the baseline days', () => {
    expect(baselineMean(seriesPoints(member.series.sleep_duration), 368, 381)).toEqual({ mean: 6.5, n: 2 })
    expect(baselineMean([], 368, 381)).toEqual({ mean: null, n: 0 })
  })
  it('finds last night with its episode and midpoint shift', () => {
    expect(lastNight(member, at(412, 14))).toEqual({
      durationH: 4.35,
      t: at(412, 7),
      onset: at(412, 2),
      offset: at(412, 7),
      midpointShiftH: 2.5,
    })
    expect(lastNight(member, at(368, 1))).toBeNull()
    expect(lastNight(undefined, at(412, 14))).toBeNull()
  })
})

describe('buildObservations', () => {
  const t = at(412, 14)
  it('records a full PVT-B as app-measured and entered values as manual, never simulated', () => {
    const score = scorePvt([
      { kind: 'response', rt_ms: 250 },
      { kind: 'response', rt_ms: 400 },
      { kind: 'response', rt_ms: 301 },
    ])
    const list = buildObservations(
      {
        pvt: { mode: 'full', score },
        sleepQuality: 4,
        mood: 2,
        fluidIntakeMl: 2400,
        urineOutputMl: 1800,
        symptoms: { headache: true, nausea: false, trouble_sleeping: false, flank_pain: false, urinary: true },
      },
      'CM-3',
      t,
    )
    const by = Object.fromEntries(list.map((o) => [o.variable, o]))
    expect(by.pvt_lapses).toEqual({ crew_id: 'CM-3', variable: 'pvt_lapses', value: 1, unit: 'count', t, source: 'app', provenance: 'measured' })
    expect(by.pvt_median_rt).toMatchObject({ value: 301, unit: 'ms' })
    expect(by.mood).toMatchObject({ value: 2, unit: 'score_1_5', source: 'app', provenance: 'manual' })
    expect(by.fluid_intake_24h).toMatchObject({ value: 2400, unit: 'mL', source: 'manual' })
    expect(by.urine_volume_24h).toMatchObject({ value: 1800, unit: 'mL', source: 'manual' })
    expect(by.symptom_headache.value).toBe(1)
    expect(by.symptom_nausea.value).toBe(0)
    expect(by.renal_symptoms).toMatchObject({ value: 1, unit: 'yes/no' })
    expect(list.every((o) => o.provenance !== 'simulated')).toBe(true)
  })

  it('never records a demo run, and records nothing for skipped steps', () => {
    const demo = buildObservations({ ...EMPTY_ANSWERS, pvt: { mode: 'demo', score: scorePvt([{ kind: 'response', rt_ms: 250 }]) } }, 'CM-1', t)
    expect(demo).toEqual([])
    expect(buildObservations(EMPTY_ANSWERS, 'CM-1', t)).toEqual([])
  })
})

describe('parseMl and logbookText', () => {
  it('parses millilitres; empty means not measured, never zero', () => {
    expect(parseMl('')).toEqual({ value: null, error: null })
    expect(parseMl(' 2,400 ')).toEqual({ value: 2400, error: null })
    expect(parseMl('0')).toEqual({ value: 0, error: null })
    expect(parseMl('2.5').error).not.toBeNull()
    expect(parseMl('25000').error).not.toBeNull()
  })
  it('never writes the mood value into the logbook', () => {
    const text = logbookText({ ...EMPTY_ANSWERS, mood: 1 })
    expect(text).toContain('mood logged (private)')
    expect(text).not.toMatch(/mood[^·]*1/)
  })
})
