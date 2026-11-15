// Return-to-procedure alerts on the REAL frozen scenario (web/public/data) and the REAL rules (engine/rules):
// an overdue reassessment and a new escalation join their case's annunciator line (procedureAlerts.ts).
import { describe, expect, it } from 'vitest'
import { formatMet } from './engine'
import type { CaseState } from './engine'
import { caseKey, caseSchedule, computeCases, tierOneFor } from './caseTimeline'
import type { CaseEventRecord, CaseView } from './caseTimeline'
import { evaluateMission } from './evaluate'
import { initialMissionState, isAcknowledged, missionReducer, selectAlertGroups, selectAnnunciator } from './mission'
import type { AlertItem, MissionState } from './mission'
import { crewList, escalatedOf, instanceSelectAt, isOverdueAlert, openingSeverityOf, overdueOf, procedureAlerts, tellClause } from './procedureAlerts'
import { buildScenarioIndex } from './scenarioData'
import type { SimCrewData, SpeReplayData } from './scenarioData'
import { CREW_IDS } from './vocab'
import type { CrewId, Observation } from './vocab'
import type { Snapshot } from './data'
import { openingSeverity } from '../features/cases/model'
import { announce } from './Annunciator'
import type { AnnounceMemory } from './Annunciator'

const snaps = import.meta.glob<Snapshot>('../../public/data/{sim_crew,swpc_spe_replay}.json', { eager: true, import: 'default' })
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))?.[1]
const INDEX = buildScenarioIndex(snap('sim_crew')!.data as SimCrewData, snap('swpc_spe_replay')!.data as SpeReplayData)
const NOW = INDEX.nowMet
const HOUR = 3600
const ENV = 'mars_surface' as const

function cases(t: number, userEvents: CaseEventRecord[] = [], runtime: Observation[] = []): CaseView[] {
  return computeCases({ index: INDEX, runtime, envId: ENV, t, userEvents }, caseSchedule(INDEX, runtime, ENV))
}
const view = (list: readonly CaseView[], crew: CrewId, id: string) => list.find((v) => v.key === caseKey(crew, id))!
const alertsAt = (list: readonly CaseView[], t: number, nowMet = NOW) => procedureAlerts({ cases: list, t, nowMet, tierOneFor })
const tier = (c: CrewId) => `${tierOneFor(c).name} (${tierOneFor(c).crewId})`

/** The demo's shelter run for every crewmember: start, the two required confirmations, an outcome at NOW + 10 min. */
function shelterRun(crews: readonly CrewId[] = CREW_IDS): CaseEventRecord[] {
  const spec = view(cases(NOW), 'CM-1', 'spe_shelter').state.spec
  const out: CaseEventRecord[] = []
  let seq = 0
  for (const crew of crews) {
    const key = caseKey(crew, 'spe_shelter')
    const ev = (event: CaseEventRecord['event']): CaseEventRecord => ({ key, origin: 'user', seq: seq++, event })
    out.push(ev({ type: 'SELECT', t: NOW + 30, countermeasure_id: 'cm_shelter' }))
    spec.required_step_ids.forEach((id, i) => {
      const input = spec.step_inputs.find((x) => x.step_id === id)
      out.push(ev({ type: 'STEP', t: NOW + 60 + i * 30, step_id: id, input: input ? { variable: input.variable, value: NOW + 45, unit: input.unit } : undefined }))
    })
    out.push(ev({ type: 'OUTCOME', t: NOW + 600, text: 'All four crew in the shelter.' }))
  }
  return out
}
const TRIPWIRE_AT = NOW + 600 + 6 * HOUR // the outcome + the shelter case's reassess_after_s

/** A store holding the engine's own alerts at t plus the procedure entries. */
function store(list: readonly CaseView[], t: number, base: MissionState = initialMissionState()): MissionState {
  let s = missionReducer(base, { type: 'publishAlerts', source: 'mission', alerts: evaluateMission(INDEX, [], ENV, Math.floor(t / 60) * 60).alerts })
  s = missionReducer(s, { type: 'publishAlerts', source: 'procedures', alerts: alertsAt(list, t) })
  return s
}

describe('overdue reassessment (a): a case left in detected or acting is lost to follow-up without it', () => {
  const list = cases(NOW)
  it("CM-1's sleep case at now gives exactly one entry: overdue since its SELECT plus 72 h, in that case's line", () => {
    const items = alertsAt(list, NOW)
    expect(items).toHaveLength(1)
    const [a] = items
    const v = view(list, 'CM-1', 'sleep_circadian')
    expect(v.state.status).toBe('acting')
    const select = instanceSelectAt(v.state)!
    expect(formatMet(select)).toBe('404/08:07:30')
    expect(a.t).toBe(select + v.state.spec.tripwire.reassess_after_s)
    expect(a).toMatchObject({
      id: 'CM-1:overdue:sleep_circadian:1:acting',
      kind: 'procedure',
      severity: 'caution',
      crew_id: 'CM-1',
      case_id: 'sleep_circadian',
      group: 'CM-1:case:sleep_circadian',
      group_title: 'Sleep and circadian drift',
      title: 'Reassessment overdue since MET 407/08:07:30',
      detail: `Log the outcome so the tripwire can judge, or tell ${tier('CM-1')} now`,
    })
    expect(a.detail).toBe('Log the outcome so the tripwire can judge, or tell the Crew Medical Officer (CM-4) now')
  })
  it('is due exactly at t_ref + reassess_after_s (a design choice), never before', () => {
    const v = view(list, 'CM-1', 'sleep_circadian')
    const due = instanceSelectAt(v.state)! + v.state.spec.tripwire.reassess_after_s
    expect(overdueOf(v, due - 1)).toBeNull()
    expect(overdueOf(v, due)?.since).toBe(due)
  })
  it('a detected case counts from its opening; a crew-wide case is ONE entry naming its crewmembers', () => {
    const due = view(list, 'CM-1', 'spe_shelter').state.opened_at! + 6 * HOUR
    expect(formatMet(due)).toBe('412/20:15:00')
    const before = alertsAt(cases(due - 60), due - 60).filter((a) => a.case_id === 'spe_shelter')
    expect(before).toEqual([])
    const at = cases(due)
    for (const c of CREW_IDS) expect(view(at, c, 'spe_shelter').state.status).toBe('detected')
    const spe = alertsAt(at, due).filter((a) => a.case_id === 'spe_shelter')
    expect(spe).toHaveLength(1)
    expect(spe[0]).toMatchObject({
      id: 'ALL:overdue:spe_shelter',
      crew_id: 'ALL',
      group: 'ALL:case:spe_shelter',
      group_title: 'Solar particle event: shelter',
      severity: 'caution',
      ack_ids: CREW_IDS.map((c) => `${c}:overdue:spe_shelter:1:detected`),
      title: 'Reassessment overdue since MET 412/20:15:00 for CM-1, CM-2, CM-3 and CM-4',
    })
    expect(spe[0].detail).toBe(
      `Start the countermeasure and log the outcome so the tripwire can judge, or CM-1, CM-2 and CM-3 tell ${tier('CM-1')} now; CM-4 tells ${tier('CM-4')} now`,
    )
  })
  it('a late start is a new overdue period of the same instance (a new id), from the SELECT', () => {
    const late = 412 * 86_400 + 20 * HOUR + 30 * 60 // 412/20:30, after the detected period went overdue
    const user: CaseEventRecord[] = [{ key: caseKey('CM-1', 'spe_shelter'), origin: 'user', seq: 1, event: { type: 'SELECT', t: late, countermeasure_id: 'cm_shelter' } }]
    const after = alertsAt(cases(late + 60, user), late + 60).find((a) => a.case_id === 'spe_shelter')!
    expect(after.ack_ids).toEqual(['CM-2', 'CM-3', 'CM-4'].map((c) => `${c}:overdue:spe_shelter:1:detected`))
    expect(after.title).toBe('Reassessment overdue since MET 412/20:15:00 for CM-2, CM-3 and CM-4')
    const again = late + 6 * HOUR
    const both = alertsAt(cases(again, user), again).find((a) => a.case_id === 'spe_shelter')!
    expect(both.ack_ids).toEqual(['CM-1:overdue:spe_shelter:1:acting', ...['CM-2', 'CM-3', 'CM-4'].map((c) => `${c}:overdue:spe_shelter:1:detected`)])
    expect(both.title).toBe(
      `Reassessment overdue for CM-1 (since MET ${formatMet(again)}), CM-2 (since MET 412/20:15:00), CM-3 (since MET 412/20:15:00), CM-4 (since MET 412/20:15:00)`,
    )
    expect(both.detail).toMatch(/^Start the countermeasure and log the outcome/)
  })
  it('watch, resolved and dismissed give none, however long ago the reassessment interval ran out', () => {
    // at now: CM-3's renal case and CM-3's sleep case are in watch (tripwire armed), both long past SELECT + 72 h
    for (const id of ['renal_stone', 'sleep_circadian']) {
      const v = view(list, 'CM-3', id)
      expect(v.state.status).toBe('watch')
      expect(NOW).toBeGreaterThan(instanceSelectAt(v.state)! + v.state.spec.tripwire.reassess_after_s)
      expect(overdueOf(v, NOW)).toBeNull()
    }
    const later = cases(414 * 86_400 + HOUR)
    expect(view(later, 'CM-3', 'renal_stone').state.status).toBe('resolved')
    expect(alertsAt(later, 414 * 86_400 + HOUR).filter((a) => a.crew_id === 'CM-3')).toEqual([])
    const dismiss: CaseEventRecord[] = [
      { key: caseKey('CM-1', 'sleep_circadian'), origin: 'user', seq: 1, event: { type: 'DISMISS', t: NOW + 30, reason: 'Schedule shift ended; reviewed with the Crew Medical Officer.' } },
    ]
    const dismissed = cases(NOW + 60, dismiss)
    expect(view(dismissed, 'CM-1', 'sleep_circadian').state.status).toBe('dismissed')
    expect(alertsAt(dismissed, NOW + 60)).toEqual([])
    // idle cases never raise anything
    for (const v of list.filter((x) => x.state.status === 'idle')) expect(overdueOf(v, NOW + 365 * 86_400)).toBeNull()
  })
})

describe('new escalation (b): the line turns NEW again, classed as the case opened', () => {
  it('a crew-wide escalation at or after now is ONE entry in the shelter line, naming each crewmember\'s tier 1', () => {
    const run = shelterRun()
    const list = cases(TRIPWIRE_AT + 60, run)
    for (const c of CREW_IDS) {
      const v = view(list, c, 'spe_shelter')
      expect(v.state.status).toBe('escalated')
      expect(v.state.escalation?.t).toBe(TRIPWIRE_AT)
    }
    const spe = alertsAt(list, TRIPWIRE_AT + 60).filter((a) => a.case_id === 'spe_shelter')
    expect(spe).toHaveLength(1)
    const a = spe[0]
    expect(a.severity).toBe(openingSeverityOf(view(list, 'CM-1', 'spe_shelter')))
    expect(a.severity).toBe('warning')
    expect(a).toMatchObject({ id: 'ALL:escalated:spe_shelter', kind: 'procedure', crew_id: 'ALL', group: 'ALL:case:spe_shelter', t: TRIPWIRE_AT })
    expect(a.ack_ids).toEqual(CREW_IDS.map((c) => `${c}:escalated:spe_shelter:1`))
    expect(a.title).toBe(`Escalated MET ${formatMet(TRIPWIRE_AT)}: CM-1, CM-2 and CM-3 tell ${tier('CM-1')} now; CM-4 tells ${tier('CM-4')} now`)
    expect(a.title).toContain('the Crew Medical Officer (CM-4)')
    expect(a.title).toContain('CM-4 tells the Commander (CM-1)')
    expect(a.detail).toBe('The tripwire tripped at the reassessment; the ground packet is queued for the flight surgeon and sent when a link exists')
  })
  it("a crewmember's own synthetic escalation at or after now gives one entry of the case's own class", () => {
    const list = cases(NOW)
    const base = view(list, 'CM-1', 'sleep_circadian')
    const esc = (v: CaseView, t: number, reason: 'tripwire' | 'red_flag' = 'tripwire'): CaseView => ({
      ...v,
      state: { ...v.state, status: 'escalated', escalation: { t, reason, step_id: null, tiers: [] }, packet_queued_at: t, closed_at: t } as CaseState,
    })
    const items = alertsAt([esc(base, NOW + 60)], NOW + 60)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'CM-1:escalated:sleep_circadian:1',
      severity: openingSeverity(base),
      group: 'CM-1:case:sleep_circadian',
      title: 'Escalated MET 412/14:21:00: tell the Crew Medical Officer (CM-4) now',
    })
    expect(items[0].severity).toBe('caution')
    // the Crew Medical Officer's own case: tier 1 is the backup, the Commander
    const cmo = esc({ ...view(list, 'CM-4', 'sleep_circadian'), state: { ...base.state, crew_id: 'CM-4' } }, NOW + 60, 'red_flag')
    const [own] = alertsAt([{ ...cmo, crewId: 'CM-4' }], NOW + 60)
    expect(own.title).toBe(`Escalated MET 412/14:21:00: tell ${tier('CM-4')} now`)
    expect(own.title).toBe('Escalated MET 412/14:21:00: tell the Commander (CM-1) now')
    expect(own.detail).toMatch(/^A red-flag question was answered yes; the ground packet is queued/)
    // an escalation before now belongs to the simulated crew's history: nothing
    expect(escalatedOf(esc(base, NOW - 60), NOW)).toBeNull()
    expect(alertsAt([esc(base, NOW - 60)], NOW)).toEqual([])
  })
  it('the same shelter escalation, read with a "now" after it (a scripted escalation), raises nothing', () => {
    const list = cases(TRIPWIRE_AT + 60, shelterRun())
    expect(alertsAt(list, TRIPWIRE_AT + 60, TRIPWIRE_AT + 1).filter((a) => a.case_id === 'spe_shelter')).toEqual([])
    expect(alertsAt(list, TRIPWIRE_AT + 60, TRIPWIRE_AT).filter((a) => a.case_id === 'spe_shelter')).toHaveLength(1)
  })
  it('mirrors the case views\' own opening severity (features/cases/model.ts openingSeverity) on every view', () => {
    for (const list of [cases(NOW), cases(TRIPWIRE_AT + 60, shelterRun())]) {
      for (const v of list) expect(openingSeverityOf(v)).toBe(openingSeverity(v))
    }
  })
})

describe('the annunciator line: counts unchanged, NEW again, the entry in the title, acknowledgement', () => {
  it('at now the bar still reads W1 C2 A1 with 4 NEW, and CM-1\'s line names the overdue reassessment', () => {
    const list = cases(NOW)
    const s = store(list, NOW)
    expect(selectAnnunciator(s)).toMatchObject({ emergency: 0, warning: 1, caution: 2, advisory: 1, unacknowledged: 4 })
    const g = selectAlertGroups(s).find((x) => x.id === 'CM-1:case:sleep_circadian')!
    expect(g.severity).toBe('caution')
    expect(g.title).toBe('Sleep and circadian drift · Reassessment overdue since MET 407/08:07:30')
    expect(g.alerts.map((a) => a.kind ?? 'finding').sort()).toEqual(['finding', 'procedure'])
    // acknowledging the line clears NEW; the title is the case title again (two members)
    const acked = missionReducer(s, { type: 'acknowledge', ids: g.alerts.flatMap((a) => a.ack_ids ?? [a.id]), t: NOW })
    expect(selectAnnunciator(acked).unacknowledged).toBe(3)
    expect(selectAlertGroups(acked).find((x) => x.id === g.id)!.title).toBe('Sleep and circadian drift')
  })
  it('without an unacknowledged procedure entry the line title follows D16 as before', () => {
    let s = initialMissionState()
    s = missionReducer(s, {
      type: 'publishAlerts',
      source: 'mission',
      alerts: [{ id: 'CM-1:a', severity: 'caution', title: 'A', group: 'CM-1:case:sleep', group_title: 'Sleep', crew_id: 'CM-1' }],
    })
    expect(selectAlertGroups(s)[0].title).toBe('A')
    s = missionReducer(s, {
      type: 'publishAlerts',
      source: 'procedures',
      alerts: [{ id: 'CM-1:p', kind: 'procedure', severity: 'caution', title: 'P', group: 'CM-1:case:sleep', group_title: 'Sleep', crew_id: 'CM-1' }],
    })
    expect(selectAlertGroups(s)[0].title).toBe('Sleep · P')
    s = missionReducer(s, { type: 'acknowledge', ids: ['CM-1:a', 'CM-1:p'], t: NOW })
    expect(selectAlertGroups(s)[0].title).toBe('Sleep')
    // a line of procedure entries only always names its case and the entry
    s = missionReducer(s, { type: 'publishAlerts', source: 'mission', alerts: [] })
    expect(selectAlertGroups(s)[0].title).toBe('Sleep · P')
  })
  it('the demo: acknowledge everything, run the shelter procedure, cross the tripwire: the W line is NEW again and says Escalated', () => {
    const run = shelterRun()
    // everything acknowledged at now
    let s = store(cases(NOW), NOW)
    s = missionReducer(s, { type: 'acknowledge', ids: selectAlertGroups(s).flatMap((g) => g.alerts.flatMap((a) => a.ack_ids ?? [a.id])), t: NOW })
    expect(selectAnnunciator(s).unacknowledged).toBe(0)
    // the procedure under way: nothing new (the shelter case is in watch, CM-1's sleep entry stays acknowledged)
    const watching = cases(NOW + 3600, run)
    s = store(watching, NOW + 3600, s)
    expect(selectAnnunciator(s)).toMatchObject({ warning: 1, unacknowledged: 0 })
    // the demo jump past T+6 h: the escalation joins the shelter line
    const t = Math.ceil(TRIPWIRE_AT / 60) * 60
    s = store(cases(t, run), t, s)
    const counts = selectAnnunciator(s)
    expect(counts.warning).toBe(1)
    expect(counts.unacknowledged).toBeGreaterThanOrEqual(1)
    const w = selectAlertGroups(s).find((g) => g.severity === 'warning')!
    expect(w.id).toBe('ALL:case:spe_shelter')
    expect(w.acknowledged).toBe(false)
    expect(w.title).toBe(`Solar particle event: shelter · Escalated MET ${formatMet(TRIPWIRE_AT)}: CM-1, CM-2 and CM-3 tell ${tier('CM-1')} now; CM-4 tells ${tier('CM-4')} now`)
    // acknowledging the line (its members' ack ids) clears NEW
    s = missionReducer(s, { type: 'acknowledge', ids: w.alerts.flatMap((a) => a.ack_ids ?? [a.id]), t })
    expect(selectAlertGroups(s).find((g) => g.id === w.id)!.acknowledged).toBe(true)
    expect(selectAnnunciator(s).unacknowledged).toBe(counts.unacknowledged - 1)
  })
  it('a crew-wide entry is acknowledged per crewmember: one who drops out keeps it acknowledged, one who joins makes it new', () => {
    const entry = (ids: string[]): AlertItem => ({ id: 'ALL:overdue:x', kind: 'procedure', severity: 'caution', title: 'T', ack_ids: ids })
    const acked = { 'CM-1:o': NOW, 'CM-2:o': NOW }
    expect(isAcknowledged(entry(['CM-1:o', 'CM-2:o']), acked)).toBe(true)
    expect(isAcknowledged(entry(['CM-2:o']), acked)).toBe(true)
    expect(isAcknowledged(entry(['CM-2:o', 'CM-3:o']), acked)).toBe(false)
    expect(isAcknowledged({ id: 'CM-1:o' }, acked)).toBe(true)
    expect(isAcknowledged({ id: 'ALL:overdue:x' }, acked)).toBe(false)
  })
})

describe('the live regions: a line that turns NEW again is announced like a new line', () => {
  /** Run announce() over a sequence of stores, as the Annunciator's effect does. */
  function speak(states: MissionState[]) {
    let memory: AnnounceMemory | null = null
    return states.map((s) => {
      const a = announce(memory, selectAlertGroups(s), selectAnnunciator(s))
      memory = a.memory
      return { assertive: a.assertive?.text ?? null, polite: a.polite }
    })
  }
  const ackAll = (s: MissionState, t: number) =>
    missionReducer(s, { type: 'acknowledge', ids: selectAlertGroups(s).flatMap((g) => g.alerts.flatMap((a) => a.ack_ids ?? [a.id])), t })
  it('the first evaluation names the new warning and the counts; acknowledging says nothing', () => {
    const empty = initialMissionState()
    const s = store(cases(NOW), NOW)
    const [none, first, acked] = speak([empty, s, ackAll(s, NOW)])
    expect(none).toEqual({ assertive: null, polite: null })
    expect(first.assertive).toMatch(/^New warning: .*S3.*, All crew\.$/)
    expect(first.polite).toBe('Alerts: 1 warning, 2 cautions, 1 advisory.')
    expect(acked).toEqual({ assertive: null, polite: null })
  })
  it('the escalation turns the acknowledged warning line NEW again: assertive, naming the escalation', () => {
    const run = shelterRun()
    const s0 = ackAll(store(cases(NOW), NOW), NOW)
    const s1 = store(cases(NOW + 3600, run), NOW + 3600, s0)
    const t = Math.ceil(TRIPWIRE_AT / 60) * 60
    const s2 = store(cases(t, run), t, s1)
    const [, watching, escalated] = speak([s0, s1, s2])
    expect(watching).toEqual({ assertive: null, polite: null })
    expect(escalated.assertive).toBe(
      `New warning: Solar particle event: shelter · Escalated MET ${formatMet(TRIPWIRE_AT)}: CM-1, CM-2 and CM-3 tell ${tier('CM-1')} now; CM-4 tells ${tier('CM-4')} now, All crew.`,
    )
    expect(escalated.polite).toBeNull() // the counts did not change
  })
  it('a caution line NEW again goes to the polite region; a member that leaves announces nothing', () => {
    const line = (alerts: AlertItem[]) => missionReducer(initialMissionState(), { type: 'publishAlerts', source: 'mission', alerts })
    const finding: AlertItem = { id: 'CM-1:f', severity: 'caution', title: 'Sleep midpoint shift', group: 'CM-1:case:sleep', group_title: 'Sleep and circadian drift', crew_id: 'CM-1' }
    const overdue: AlertItem = { ...finding, id: 'CM-1:o', kind: 'procedure', title: 'Reassessment overdue since MET 407/08:07:30' }
    const s0 = missionReducer(line([finding]), { type: 'acknowledge', ids: ['CM-1:f'], t: NOW })
    const s1 = missionReducer(s0, { type: 'publishAlerts', source: 'procedures', alerts: [overdue] })
    const s2 = missionReducer(s1, { type: 'publishAlerts', source: 'procedures', alerts: [] })
    const [, renewed, left] = speak([s0, s1, s2])
    expect(renewed).toEqual({ assertive: null, polite: 'New caution: Sleep and circadian drift · Reassessment overdue since MET 407/08:07:30, CM-1.' })
    expect(left).toEqual({ assertive: null, polite: null })
  })
  it('a warning line that swaps the rule behind it (an environment switch) is named again; one losing a member is not', () => {
    const w = (ids: string[]) =>
      missionReducer(initialMissionState(), {
        type: 'publishAlerts',
        source: 'mission',
        alerts: ids.map((id) => ({ id, severity: 'warning' as const, title: id, group: 'ALL:case:spe', group_title: 'Shelter', crew_id: 'ALL' as const })),
      })
    // from the empty store, as in the app (the Annunciator mounts before the first evaluation)
    const [, first, swapped, same, more, less] = speak([initialMissionState(), w(['ALL:a']), w(['ALL:b']), w(['ALL:b']), w(['ALL:b', 'ALL:c']), w(['ALL:b'])])
    expect(first.assertive).toBe('New warning: ALL:a, All crew.')
    expect(swapped.assertive).toBe('New warning: ALL:b, All crew.')
    expect(same.assertive).toBeNull()
    expect(more.assertive).toBe('New warning: Shelter, All crew.') // two members: the line reads its group title
    expect(less.assertive).toBeNull()
  })
})

describe('wording helpers', () => {
  it('tells an overdue entry (whose rule the queue labels a design choice) from an escalation and a finding', () => {
    const [overdue] = alertsAt(cases(NOW), NOW)
    expect(isOverdueAlert(overdue)).toBe(true)
    const [escalated] = alertsAt(cases(TRIPWIRE_AT + 60, shelterRun()), TRIPWIRE_AT + 60).filter((a) => a.case_id === 'spe_shelter')
    expect(escalated.id).toBe('ALL:escalated:spe_shelter')
    expect(isOverdueAlert(escalated)).toBe(false)
    expect(isOverdueAlert({ id: 'ALL:overdue:spe_shelter', kind: 'procedure' })).toBe(true)
    expect(isOverdueAlert({ id: 'CM-1:overdue', kind: undefined })).toBe(false) // a finding never is
  })
  it('lists crewmembers in crew order and names each tier 1 once', () => {
    expect(crewList(['CM-3', 'CM-1'])).toBe('CM-1 and CM-3')
    expect(crewList(['CM-4', 'CM-2', 'CM-1'])).toBe('CM-1, CM-2 and CM-4')
    expect(tellClause(['CM-2'], tierOneFor)).toBe(`tell ${tier('CM-2')} now`)
    expect(tellClause(['CM-4', 'CM-1'], tierOneFor)).toBe(`CM-1 tells ${tier('CM-1')} now; CM-4 tells ${tier('CM-4')} now`)
  })
})
