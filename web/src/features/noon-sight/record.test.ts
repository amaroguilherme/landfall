import { describe, expect, it } from 'vitest'
import { RULES, getIndicator } from '../../app/engine'
import type { CaseStatus } from '../../app/engine'
import { tierOneFor } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import { packetStateLabel } from '../../app/packet'
import { matchRoute } from '../../app/routes'
import { ENVIRONMENTS } from '../../app/scenario'
import { CREW_IDS } from '../../app/vocab'
import type { CrewId, Observation } from '../../app/vocab'
import { pickCrew } from '../cases/model'
import { scorePvt } from './pvt'
import {
  EMPTY_ANSWERS,
  EMPTY_KIT,
  KIT_SPECS,
  PROMPT_OPEN_STATUSES,
  RENAL_SYMPTOMS,
  SECOND_CMO,
  SYMPTOMS,
  URGENT_SYMPTOMS,
  baselineMean,
  bpPairError,
  buildObservations,
  catchAllLine,
  checkKit,
  collectFixes,
  computeStreak,
  cuffPosture,
  kitSchedule,
  kitSkipText,
  lastNight,
  logbookText,
  noteText,
  parseKit,
  parseMl,
  routeSymptoms,
  seriesPoints,
  tellTierOne,
  tierOnePhrase,
  weekCompleteness,
} from './record'
import type { SimCrewMember, SymptomId, SymptomNote, SymptomRoutingInput } from './record'

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

describe('symptom routing (routeSymptoms)', () => {
  const cm1 = tierOnePhrase(tierOneFor('CM-1'))
  const cm4 = tierOnePhrase(tierOneFor('CM-4'))
  const tick = (...ids: SymptomId[]): Partial<Record<SymptomId, boolean>> => Object.fromEntries(ids.map((id) => [id, true]))
  const route = (input: Partial<SymptomRoutingInput> & Pick<SymptomRoutingInput, 'symptoms'>): SymptomNote[] =>
    routeSymptoms({ crewId: 'CM-1', cases: {}, link: 'LOS', tier1: cm1, ...input })
  const ALL_STATUSES: CaseStatus[] = ['idle', 'detected', 'acting', 'watch', 'resolved', 'escalated', 'dismissed']
  // Written so a grep of this folder for the old wording finds only the code that no longer has it.
  const OLD_BACKUP = /backup\smedical\sofficer/i
  const GETS_THE_CASE = /flight surgeon gets\sthe case/
  const CAUSAL = /radiation (causes|caused|explains|made)|because of (the )?radiation|from (the )?radiation|radiation sickness|exposure (causes|caused)/i

  it('names tier 1: your Crew Medical Officer, or for CM-4 the Commander (CM-1), the crew\'s second Crew Medical Officer', () => {
    expect(SECOND_CMO).toBe("the crew's second Crew Medical Officer")
    expect(cm4.tell).toBe("the Commander (CM-1), the crew's second Crew Medical Officer")
    expect(cm4).toMatchObject({ who: 'the Commander', appositive: true })
    expect(tellTierOne(cm4, 'now')).toBe("the Commander (CM-1), the crew's second Crew Medical Officer, now")
    for (const id of ['CM-1', 'CM-2', 'CM-3'] as const) {
      expect(tierOnePhrase(tierOneFor(id)), id).toEqual({ tell: 'your Crew Medical Officer', who: 'the Crew Medical Officer', appositive: false })
    }
    expect(tellTierOne(cm1, 'now')).toBe('your Crew Medical Officer now')
  })

  it('nausea with the shelter case open: the shelter-case note (linked) and the renal red-flag list wording', () => {
    const notes = route({ symptoms: tick('nausea_vomiting'), cases: { spe_shelter: 'detected', renal_stone: 'idle' } })
    expect(notes.map((n) => n.kind)).toEqual(['shelter', 'renal'])
    expect(noteText(notes[0])).toBe('Your radiation-shelter case is open: tell your Crew Medical Officer about this now; LANDFALL does not judge what causes it.')
    expect(notes[0]).toMatchObject({ href: '#/case/spe_shelter', linkLabel: 'Open the radiation-shelter case' })
    expect(noteText(notes[1])).toBe(
      'Tell your Crew Medical Officer now. Nausea or vomiting is on the renal-stone red-flag list. Your renal-stone case is not open now, so the Crew Medical Officer decides what follows. LANDFALL has no open case for this, so it makes no ground packet: the Crew Medical Officer decides what goes to the flight surgeon when the link resumes.',
    )
    expect(notes[1].href).toBe('#/case/renal_stone?crew=CM-1')
    for (const n of notes) {
      expect(noteText(n)).not.toMatch(/red flags? of the renal-stone procedure/)
      expect(noteText(n)).not.toMatch(CAUSAL)
    }
  })

  it('shows the shelter note for any ticked symptom while that case is open or escalated, and never otherwise', () => {
    for (const status of ALL_STATUSES) {
      const notes = route({ symptoms: tick('headache'), cases: { spe_shelter: status } })
      const open = PROMPT_OPEN_STATUSES.includes(status)
      expect(notes.map((n) => n.kind), status).toEqual(open ? ['shelter'] : [])
      if (open) expect(notes[0].lead, status).toBe(`Your radiation-shelter case is ${status === 'escalated' ? 'escalated' : 'open'}: tell your Crew Medical Officer about this now;`)
    }
    expect(PROMPT_OPEN_STATUSES).toEqual(['detected', 'acting', 'watch', 'escalated'])
    // Nothing ticked: no note, even with the shelter case open.
    expect(route({ symptoms: {}, cases: { spe_shelter: 'detected' } })).toEqual([])
    expect(route({ symptoms: { ...NONE }, cases: { spe_shelter: 'detected' } })).toEqual([])
  })

  it('chest pain at LOS with no case: no ground packet, and never the claim that the flight surgeon gets a case', () => {
    const notes = route({ symptoms: tick('chest_pain') })
    expect(notes.map((n) => n.kind)).toEqual(['urgent'])
    const text = noteText(notes[0])
    expect(text).toBe(
      'Tell your Crew Medical Officer now. LANDFALL has no guided case for chest pain: the Crew Medical Officer uses the vehicle medical procedures. LANDFALL has no case for this, so it makes no ground packet: the Crew Medical Officer decides what goes to the flight surgeon when the link resumes.',
    )
    expect(text).toContain('makes no ground packet')
    expect(text).not.toMatch(GETS_THE_CASE)
    expect(notes[0].href).toBeNull()
    // With the shelter case open, the urgent note keeps the same words after the shelter note.
    const withShelter = route({ symptoms: tick('chest_pain', 'short_of_breath'), cases: { spe_shelter: 'acting' } })
    expect(withShelter.map((n) => n.kind)).toEqual(['shelter', 'urgent'])
    expect(noteText(withShelter[1])).toContain('LANDFALL has no guided case for chest pain and shortness of breath:')
    expect(noteText(withShelter[1])).toContain('makes no ground packet')
  })

  it('keeps the AOS sentence with the link up', () => {
    const aos = 'With the link up, Mission Control and the flight surgeon can join within the round trip.'
    const urgent = route({ symptoms: tick('vision_change'), link: 'AOS' })
    expect(noteText(urgent[0]).endsWith(aos)).toBe(true)
    expect(noteText(urgent[0])).not.toContain('ground packet')
    const renal = route({ symptoms: tick('flank_pain'), link: 'AOS', cases: { renal_stone: 'watch' } })
    expect(noteText(renal[0]).endsWith(aos)).toBe(true)
  })

  it('renal symptoms at LOS: the open case keeps its per-status sentence and says when its packet reaches the flight surgeon', () => {
    const prepared = packetStateLabel('prepared')
    const queued = packetStateLabel('queued')
    const say = (status: CaseStatus) => noteText(route({ symptoms: tick('fever_chills'), cases: { renal_stone: status } })[0])
    expect(say('acting')).toContain('Your renal-stone case is open: answer its red-flag question there now. A “yes” escalates the case at once, to the Crew Medical Officer now and to the flight surgeon through the ground packet.')
    expect(say('detected')).toContain('Your renal-stone case is open: start it and answer its red-flag question.')
    expect(say('watch')).toContain('Your renal-stone case is in watch (its tripwire is armed), so the Crew Medical Officer decides what follows.')
    expect(say('escalated')).toContain('Your renal-stone case is already escalated: the Crew Medical Officer has it.')
    for (const status of ['detected', 'acting', 'watch'] as const) {
      expect(say(status), status).toContain(
        `With no link now, the Crew Medical Officer acts onboard; the case's ground packet stays ${prepared} until the case escalates, then it is ${queued} and goes to the flight surgeon when the link resumes.`,
      )
    }
    expect(say('escalated')).toContain(`With no link now, the Crew Medical Officer acts onboard; the case's ground packet is ${queued} and goes to the flight surgeon when the link resumes.`)
    for (const status of ['idle', 'resolved', 'dismissed'] as const) {
      expect(say(status), status).toContain('Your renal-stone case is not open now, so the Crew Medical Officer decides what follows.')
      expect(say(status), status).toContain('so it makes no ground packet')
    }
    // Plural wording.
    const two = noteText(route({ symptoms: tick('flank_pain', 'blood_in_urine') })[0])
    expect(two).toContain('Pain in the side or back (flank) and blood in the urine are on the renal-stone red-flag list.')
  })

  it("the renal packet is queued only by escalation: its procedure has no crew-release step (the wording above relies on it)", () => {
    const renal = (RULES.cases?.cases ?? []).find((c) => c.id === 'renal_stone')
    expect(renal?.escalation?.ground_packet).toBe(true)
    expect(renal?.escalation?.observations).toContain('renal_symptoms')
    for (const step of renal?.procedure ?? []) expect((step as { releases_packet?: boolean }).releases_packet, step.id).not.toBe(true)
  })

  it('for CM-4, every prompt names the Commander (CM-1), the crew\'s second Crew Medical Officer', () => {
    const notes = route({ crewId: 'CM-4', symptoms: tick('nausea_vomiting', 'chest_pain'), cases: { spe_shelter: 'detected', renal_stone: 'acting' }, tier1: cm4 })
    expect(notes.map((n) => n.kind)).toEqual(['shelter', 'renal', 'urgent'])
    expect(notes[0].lead).toBe("Your radiation-shelter case is open: tell the Commander (CM-1), the crew's second Crew Medical Officer, about this now;")
    expect(notes[1].lead).toBe("Tell the Commander (CM-1), the crew's second Crew Medical Officer, now.")
    expect(notes[1].href).toBe('#/case/renal_stone?crew=CM-4')
    expect(notes[1].text).toContain('A “yes” escalates the case at once, to the Commander now')
    expect(notes[2].text).toContain('the Commander uses the vehicle medical procedures')
    expect(notes[2].text).toContain('the Commander decides what goes to the flight surgeon when the link resumes')
  })

  it('never uses the old backup wording, never says the flight surgeon gets a case, never names a cause, in any combination', () => {
    const symptomSets: SymptomId[][] = [['headache'], ['nausea_vomiting'], ['chest_pain'], ['cannot_pass_urine', 'vision_change', 'rash']]
    for (const crew of CREW_IDS) {
      const tier1 = tierOnePhrase(tierOneFor(crew))
      expect(catchAllLine(tier1)).not.toMatch(OLD_BACKUP)
      for (const ids of symptomSets)
        for (const renal of ALL_STATUSES)
          for (const shelter of ALL_STATUSES)
            for (const link of ['AOS', 'LOS'] as const) {
              for (const n of routeSymptoms({ crewId: crew, symptoms: tick(...ids), cases: { renal_stone: renal, spe_shelter: shelter }, link, tier1 })) {
                const text = noteText(n)
                expect(text).not.toMatch(OLD_BACKUP)
                expect(text).not.toMatch(GETS_THE_CASE)
                expect(text).not.toMatch(CAUSAL)
                expect(n.href).toBe(n.kind === 'renal' ? `#/case/renal_stone?crew=${crew}` : n.kind === 'shelter' ? '#/case/spe_shelter' : null)
              }
            }
    }
  })

  it("each case link opens the reporting crewmember's own case on the case page (pickCrew)", () => {
    // The demo at MET 412/14:20: only CM-3's renal case is open (watch); every crewmember's shelter case is detected.
    const views = CREW_IDS.flatMap((c) => [
      { caseId: 'renal_stone', crewId: c, state: { status: c === 'CM-3' ? 'watch' : 'idle' } },
      { caseId: 'spe_shelter', crewId: c, state: { status: 'detected' } },
    ]) as unknown as CaseView[]
    const shownFor = (href: string, store: CrewId) => {
      const m = matchRoute(href)
      return pickCrew(m.params.id ?? '', views, m.query.crew, store)
    }
    // Why the renal link names the crewmember: without ?crew the case page opens the first case that is not idle.
    expect(shownFor('#/case/renal_stone', 'CM-1')).toBe('CM-3')
    for (const crew of CREW_IDS) {
      const status = (id: string) => (views.find((v) => v.caseId === id && v.crewId === crew)?.state.status ?? null) as CaseStatus | null
      const notes = routeSymptoms({
        crewId: crew,
        symptoms: tick('nausea_vomiting'),
        cases: { renal_stone: status('renal_stone'), spe_shelter: status('spe_shelter') },
        link: 'LOS',
        tier1: tierOnePhrase(tierOneFor(crew)),
      })
      expect(notes.map((n) => n.kind), crew).toEqual(['shelter', 'renal'])
      for (const n of notes) {
        expect(matchRoute(n.href!).route?.id, `${crew} ${n.kind}`).toBe('case')
        expect(matchRoute(n.href!).params.id, `${crew} ${n.kind}`).toBe(n.kind === 'renal' ? 'renal_stone' : 'spe_shelter')
        expect(shownFor(n.href!, crew), `${crew} ${n.kind}`).toBe(crew)
      }
    }
  })

  it('has a catch-all line that is not a symptom and is never recorded', () => {
    expect(catchAllLine(cm1)).toBe('Something else worries you? Tell your Crew Medical Officer now; LANDFALL has no question for it.')
    expect(catchAllLine(cm4)).toBe("Something else worries you? Tell the Commander (CM-1), the crew's second Crew Medical Officer, now; LANDFALL has no question for it.")
    // The symptom list, and so the IMM coverage map and the packet schema, are unchanged: 12 questions plus renal_symptoms.
    expect(SYMPTOMS).toHaveLength(12)
    const obs = buildObservations({ ...EMPTY_ANSWERS, symptoms: { ...NONE } }, 'CM-1', at(412, 14))
    expect(obs.map((o) => o.variable)).toEqual([...SYMPTOMS.map((s) => `symptom_${s.id}`), 'renal_symptoms'])
  })
})

describe('cuff posture by gravity', () => {
  it('says weightlessness only where environments.json gives microgravity', () => {
    const byEnv = Object.fromEntries(ENVIRONMENTS.map((e) => [e.id, cuffPosture(e.gravity)]))
    expect(byEnv).toEqual({
      iss: 'restrained, in weightlessness',
      cislunar: 'restrained, in weightlessness',
      lunar_surface: 'seated, feet flat on the floor',
      mars_surface: 'seated, feet flat on the floor',
    })
    for (const e of ENVIRONMENTS) expect(cuffPosture(e.gravity).includes('weightlessness'), e.id).toBe(e.gravity === 'microgravity')
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
