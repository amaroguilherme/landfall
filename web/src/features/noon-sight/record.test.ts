import { describe, expect, it } from 'vitest'
import { RULES, getIndicator } from '../../app/engine'
import type { Observation } from '../../app/vocab'
import { scorePvt } from './pvt'
import {
  EMPTY_ANSWERS,
  EMPTY_KIT,
  KIT_SPECS,
  RENAL_SYMPTOMS,
  SYMPTOMS,
  URGENT_SYMPTOMS,
  baselineMean,
  bpPairError,
  buildObservations,
  checkKit,
  collectFixes,
  computeStreak,
  kitSchedule,
  kitSkipText,
  lastNight,
  logbookText,
  parseKit,
  parseMl,
  seriesPoints,
  weekCompleteness,
} from './record'
import type { SimCrewMember, SymptomId } from './record'

const NONE = Object.fromEntries(SYMPTOMS.map((x) => [x.id, false])) as Record<SymptomId, boolean>

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
        bpSystolic: 118,
        bpDiastolic: 76,
        glucoseMgDl: 92,
        kitSkip: null,
        symptoms: { ...NONE, headache: true, blood_in_urine: true },
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
    expect(by.symptom_nausea_vomiting.value).toBe(0)
    expect(by.renal_symptoms).toMatchObject({ value: 1, unit: 'yes/no' })
    expect(by.bp_systolic).toEqual({ crew_id: 'CM-3', variable: 'bp_systolic', value: 118, unit: 'mmHg', t, source: 'manual', provenance: 'manual' })
    expect(by.bp_diastolic).toMatchObject({ value: 76, unit: 'mmHg', source: 'manual' })
    expect(by.glucose).toMatchObject({ value: 92, unit: 'mg/dL', source: 'manual' })
    expect(list.every((o) => o.provenance !== 'simulated')).toBe(true)
  })

  it('records a cuff reading only as a pair, and units match personal.json', () => {
    const half = buildObservations({ ...EMPTY_ANSWERS, bpSystolic: 118, bpDiastolic: null }, 'CM-1', t)
    expect(half).toEqual([])
    for (const spec of Object.values(KIT_SPECS)) {
      const ind = getIndicator(RULES, spec.variable)
      expect(ind.unit, spec.variable).toBe(spec.unit)
      expect(ind.variable, spec.variable).toBe(spec.variable)
    }
  })

  it('a renal red flag sets renal_symptoms; a chest pain alone does not', () => {
    const chest = buildObservations({ ...EMPTY_ANSWERS, symptoms: { ...NONE, chest_pain: true } }, 'CM-1', t)
    expect(chest.find((o) => o.variable === 'renal_symptoms')?.value).toBe(0)
    for (const id of RENAL_SYMPTOMS) {
      const obs = buildObservations({ ...EMPTY_ANSWERS, symptoms: { ...NONE, [id]: true } }, 'CM-1', t)
      expect(obs.find((o) => o.variable === 'renal_symptoms')?.value, id).toBe(1)
    }
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

describe('symptoms follow the renal case red flags (D5)', () => {
  it('lists the six red flags of cases.json renal_stone r4, in order and in the same words', () => {
    const renal = (RULES.cases?.cases ?? []).find((c) => c.id === 'renal_stone')
    const r4 = (renal?.procedure ?? []).find((p) => p.id === 'r4') as { red_flags?: string[]; red_flag?: boolean } | undefined
    expect(r4?.red_flag).toBe(true)
    const labels = RENAL_SYMPTOMS.map((id) => SYMPTOMS.find((x) => x.id === id)!.label)
    expect(labels.map((l) => l[0].toLowerCase() + l.slice(1))).toEqual(r4?.red_flags)
  })
  it('keeps the urgent symptoms that no case covers apart from the renal ones', () => {
    expect(URGENT_SYMPTOMS).toEqual(['chest_pain', 'short_of_breath', 'vision_change'])
    for (const id of URGENT_SYMPTOMS) expect(RENAL_SYMPTOMS).not.toContain(id)
  })
})

describe('medical kit entries (D8)', () => {
  it('parses whole numbers inside the entry range; empty means not taken, never zero', () => {
    expect(parseKit('', KIT_SPECS.bp_systolic)).toEqual({ value: null, error: null })
    expect(parseKit(' 118 ', KIT_SPECS.bp_systolic)).toEqual({ value: 118, error: null })
    expect(parseKit('1180', KIT_SPECS.bp_systolic).error).toMatch(/entry range/)
    expect(parseKit('12a', KIT_SPECS.bp_diastolic).error).toMatch(/digits only/)
    expect(parseKit('5.4', KIT_SPECS.glucose).error).toMatch(/mmol\/L/)
    expect(parseKit('92', KIT_SPECS.glucose)).toEqual({ value: 92, error: null })
  })
  it('refuses a pair whose top number is not the larger one', () => {
    expect(bpPairError(76, 118)).toMatch(/larger/)
    expect(bpPairError(118, null)).toMatch(/both/)
    expect(bpPairError(118, 76)).toBeNull()
    expect(bpPairError(null, null)).toBeNull()
  })
  it('asks for a re-measure and a confirmation outside the own band, and a reason for anything not taken', () => {
    const bands = { bp_systolic: { lo: 96, hi: 144 }, bp_diastolic: { lo: 49, hi: 103 }, glucose: { lo: 75, hi: 108 } }
    const ok = checkKit({ ...EMPTY_KIT, sysRaw: '120', diaRaw: '76', gluRaw: '92' }, bands)
    expect(ok).toMatchObject({ ok: true, missing: false, bpOutside: false, glucoseOutside: false, systolic: 120, diastolic: 76, glucose: 92 })
    const high = checkKit({ ...EMPTY_KIT, sysRaw: '158', diaRaw: '96', gluRaw: '92' }, bands)
    expect(high).toMatchObject({ ok: false, bpOutside: true, needsConfirm: true })
    expect(checkKit({ ...EMPTY_KIT, sysRaw: '158', diaRaw: '96', gluRaw: '92', confirmBp: true }, bands).ok).toBe(true)
    const none = checkKit(EMPTY_KIT, bands)
    expect(none).toMatchObject({ ok: false, missing: true, skipText: '' })
    expect(checkKit({ ...EMPTY_KIT, skipId: 'not_due' }, bands)).toMatchObject({ ok: true, skipText: 'Not due today: it is twice a week' })
    expect(checkKit({ ...EMPTY_KIT, skipId: 'other', skipOther: '  ' }, bands).ok).toBe(false)
    expect(kitSkipText('other', ' cuff battery flat ')).toBe('other: cuff battery flat')
    expect(checkKit({ ...EMPTY_KIT, sysRaw: '76', diaRaw: '118' }, bands).ok).toBe(false)
  })
  it('is due twice a week: from 3 MET days after the last reading', () => {
    expect(kitSchedule([at(406, 7), at(410, 7)], 412, at(412, 14))).toEqual({ lastDay: 410, daysSince: 2, due: false, nextDay: 413 })
    expect(kitSchedule([at(410, 7)], 413, at(413, 14)).due).toBe(true)
    expect(kitSchedule([], 412, at(412, 14))).toMatchObject({ lastDay: null, due: true })
    expect(kitSchedule([at(413, 7)], 412, at(412, 14)).lastDay).toBeNull()
  })
  it('writes the kit into the logbook line, or why it was not taken', () => {
    expect(logbookText({ ...EMPTY_ANSWERS, bpSystolic: 118, bpDiastolic: 76, glucoseMgDl: 92 })).toContain('blood pressure 118/76 mmHg, glucose 92 mg/dL')
    expect(logbookText({ ...EMPTY_ANSWERS, kitSkip: 'Not due today: it is twice a week' })).toContain('medical kit not taken (not due today: it is twice a week)')
  })
})
