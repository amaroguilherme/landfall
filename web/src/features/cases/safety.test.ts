// Procedure safety on the case page, on the REAL rules and frozen snapshots: a red-flag question is answered, never
// declined; a dismiss asks it first; after a red-flag "yes" the rest of the procedure waits for tier 1; the status
// badge is filled only where immediate action is needed; the overdue note sits above the next step and counts the
// readings in hand; a typed dose names its crewmember and says it adds to the dose record.
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RULES, caseReduce, getCase, newCase, triggerLookup } from '../../app/engine'
import type { CaseEvent, CaseState, Finding } from '../../app/engine'
import { caseSchedule, computeCases, tierOneFor } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import type { CommsStatus } from '../../app/comms'
import type { Snapshot } from '../../app/data'
import { buildScenarioIndex, observationsFor } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import type { CrewId } from '../../app/vocab'
import { DismissRedFlagNote, EscalatedLine } from './closing'
import { PendingEntries } from './entry'
import { lastN } from './model'
import { OutcomeForm, ProcedurePanel, StepAction, canDecline, heldByRedFlag, openRedFlagSteps, releaseQuestion, tierOneWho, vehicleEntryLabel } from './procedure'
import type { ActCtx, OutcomeDraft } from './procedure'
import { CaseStatusBadge, OverdueNote, RedFlagHold, readingsSinceOpened, statusBadgeSolid } from './status'
import type { CaseDefFull } from './types'

const LOOKUP = triggerLookup(RULES)
const ESCALATION: unknown = (RULES.meta as { escalation?: unknown } | null | undefined)?.escalation ?? null

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' })[e]!)
const text = (el: ReactElement) => decode(renderToStaticMarkup(el).replace(/<[^>]+>/g, ''))
const markup = (el: ReactElement) => renderToStaticMarkup(createElement(PendingEntries, null, el))

const renal = getCase(RULES, 'renal_stone')
const renalDef = renal as unknown as CaseDefFull
const spe = getCase(RULES, 'spe_shelter')
const speDef = spe as unknown as CaseDefFull
const sleepDef = getCase(RULES, 'sleep_circadian') as unknown as CaseDefFull

const finding = (rule_id: string, severity: string) => ({ rule_id, severity, status: 'outside' }) as unknown as Finding
const renalOpen = finding('target_urine_output_24h', 'caution')
const speOpen = finding('ops_onboard_proton_s3', 'warning')

const fold = (def: typeof renal, crewId: CrewId, events: CaseEvent[]) =>
  events.reduce<CaseState>((s, e) => caseReduce(s, e), newCase(def, crewId, LOOKUP, 'mars_surface', ESCALATION))

const redFlagId = renal.procedure!.find((x) => x.red_flag)!.id
const answer = (value: boolean, t = 300): CaseEvent => ({ type: 'STEP', t, step_id: redFlagId, input: { variable: 'renal_symptoms', value, unit: 'yes/no' } })
const renalDetected = (crewId: CrewId = 'CM-1') => fold(renal, crewId, [{ type: 'OPEN', t: 100, finding: renalOpen }])
const renalActing = (crewId: CrewId = 'CM-1') =>
  fold(renal, crewId, [
    { type: 'OPEN', t: 100, finding: renalOpen },
    { type: 'SELECT', t: 200, countermeasure_id: renal.countermeasure!.primary.id },
  ])
const renalEscalated = (crewId: CrewId = 'CM-1') => caseReduce(renalActing(crewId), answer(true))
const speActing = () =>
  fold(spe, 'CM-1', [
    { type: 'OPEN', t: 100, finding: speOpen },
    { type: 'SELECT', t: 200, countermeasure_id: spe.countermeasure!.primary.id },
  ])

const comms = { blocked: true, resumes_at: null, env: { id: 'mars_surface' } } as unknown as CommsStatus
const ctx = (def: CaseDefFull, state: CaseState, crewId: CrewId = 'CM-1'): ActCtx => ({
  def,
  state,
  crewId,
  sharedAll: false,
  sharedCount: 1,
  comms,
  t: 1000,
  latest: () => null,
  recent: () => [],
  onStep: () => {},
  onDecline: () => {},
})
const procedure = (def: CaseDefFull, state: CaseState, crewId: CrewId = 'CM-1') =>
  decode(markup(createElement(ProcedurePanel, { c: ctx(def, state, crewId), sharedNote: null, current: null })).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ')
const view = (state: CaseState, crewId: CrewId = 'CM-1') => ({ state, opening: null, tier1: tierOneFor(crewId), crewId }) as unknown as CaseView

// ---- 1. a red-flag question is answered, never declined -------------------------------------------------

describe('a red-flag question cannot be declined (canDecline)', () => {
  it('renal step 1 (r4, required and a red flag) offers no decline; SPE steps 2 and 3 (required) keep theirs', () => {
    const acting = renalActing()
    expect(redFlagId).toBe('r4')
    expect(canDecline(renal.procedure![0], acting)).toBe(false)
    const s = speActing()
    expect(spe.procedure!.filter((p) => canDecline(p, s)).map((p) => p.id)).toEqual(['p2', 'p3'])
    // a step not required (p1) or already settled offers none either
    const p2 = spe.procedure!.find((p) => p.id === 'p2')!
    expect(canDecline(spe.procedure![0], s)).toBe(false)
    expect(canDecline(p2, caseReduce(s, { type: 'STEP', t: 300, step_id: 'p2' }))).toBe(false)
    expect(canDecline(p2, caseReduce(s, { type: 'DECLINE', t: 300, step_id: 'p2', reason: 'blocked hatch' }))).toBe(false)
    // the engine's own spec marks r4 as the red flag too, so the rule holds with either source
    expect(canDecline({ id: 'r4', required: true }, acting)).toBe(false)
  })
  it('the renal procedure shows no decline control and says why; the shelter shows two', () => {
    const renalText = procedure(renalDef, renalActing())
    expect(renalText).toContain('A red-flag question cannot be declined: answer it yes or no.')
    expect(renalText).not.toContain('Decline it with a reason')
    const speText = procedure(speDef, speActing())
    expect(speText.match(/Cannot do this step\? Decline it with a reason/g)?.length).toBe(2)
    expect(speText).not.toContain('A red-flag question cannot be declined')
    expect(procedure(sleepDef, fold(getCase(RULES, 'sleep_circadian'), 'CM-1', []))).not.toContain('red-flag question cannot')
  })
  it('the outcome gate asks for a yes or no on a red flag, and keeps the decline wording for other steps', () => {
    const draft: OutcomeDraft = { text: '', setText: () => {}, submit: () => {}, readyPeers: [], blockedPeers: [] }
    const gate = (def: CaseDefFull, state: CaseState) => text(createElement(OutcomeForm, { c: ctx(def, state), draft, where: 'panel' }))
    const r = gate(renalDef, renalActing())
    expect(r).toContain('Not yet: step 1 is required and still open. Answer it yes or no (a red-flag question cannot be declined): until then an outcome is not accepted.')
    expect(r).not.toContain('decline it with a reason')
    expect(gate(speDef, speActing())).toContain('Not yet: steps 2 and 3 are required and still open. Do each, or decline it with a reason: until then an outcome is not accepted.')
  })
})

// ---- 2. a dismiss asks the red-flag question first ---------------------------------------------------------

describe('dismissing a case with its red-flag question unanswered', () => {
  it('says so above the reason field, as a design choice, on a detected or acting renal case', () => {
    for (const s of [renalDetected(), renalActing()]) {
      expect(openRedFlagSteps(renalDef, s)).toEqual(['r4'])
      const html = renderToStaticMarkup(createElement(DismissRedFlagNote, { def: renalDef, state: s }))
      expect(decode(html.replace(/<[^>]+>/g, ''))).toContain(
        'The red-flag question (step 1) is not answered yet. Ask it before you dismiss: a “yes” escalates this case instead.',
      )
      expect(html).toContain('data-chip="design choice"')
    }
  })
  it('is silent once the question is answered, and on a case with no red flag', () => {
    const answered = caseReduce(renalActing(), answer(false))
    expect(openRedFlagSteps(renalDef, answered)).toEqual([])
    expect(renderToStaticMarkup(createElement(DismissRedFlagNote, { def: renalDef, state: answered }))).toBe('')
    expect(renderToStaticMarkup(createElement(DismissRedFlagNote, { def: speDef, state: speActing() }))).toBe('')
  })
})

// ---- 3. after a red-flag "yes": hold the rest of the procedure for tier 1 ---------------------------------

describe('the hold after a red-flag escalation', () => {
  it('names tier 1 in words true for the patient', () => {
    expect(tierOneWho(tierOneFor('CM-1'))).toBe('the Crew Medical Officer (CM-4)')
    expect(tierOneWho(tierOneFor('CM-4'))).toBe("the crew's second Crew Medical Officer, the Commander (CM-1)")
  })
  it('the status card holds the procedure until tier 1 has seen the crewmember, with a design-choice chip', () => {
    const esc = renalEscalated()
    expect(heldByRedFlag(esc)).toBe(true)
    const html = renderToStaticMarkup(createElement(RedFlagHold, { view: view(esc) }))
    expect(decode(html.replace(/<[^>]+>/g, ''))).toContain('Hold the rest of this procedure until the Crew Medical Officer (CM-4) has seen you.')
    expect(html).toContain('data-chip="design choice"')
    const own = renderToStaticMarkup(createElement(RedFlagHold, { view: view(renalEscalated('CM-4'), 'CM-4') }))
    expect(decode(own.replace(/<[^>]+>/g, ''))).toContain(
      "Hold the rest of this procedure until the crew's second Crew Medical Officer, the Commander (CM-1), has seen you.",
    )
    // no hold for an open case or a "no"
    expect(renderToStaticMarkup(createElement(RedFlagHold, { view: view(renalActing()) }))).toBe('')
    expect(renderToStaticMarkup(createElement(RedFlagHold, { view: view(caseReduce(renalActing(), answer(false))) }))).toBe('')
  })
  it('the procedure panel starts with the red-flag escalation and who the remaining steps wait for', () => {
    const p = procedure(renalDef, renalEscalated()).trim()
    const body = p.slice(p.indexOf('4. Guided procedure') + '4. Guided procedure'.length).trim()
    expect(body.startsWith('Escalated by a red-flag answer at step 1: the remaining steps wait for the Crew Medical Officer (CM-4).')).toBe(true)
    expect(procedure(renalDef, renalEscalated('CM-4'), 'CM-4')).toContain(
      "Escalated by a red-flag answer at step 1: the remaining steps wait for the crew's second Crew Medical Officer, the Commander (CM-1).",
    )
    expect(procedure(renalDef, renalActing())).not.toContain('Escalated by a red-flag answer')
  })
  it('the close panel says the remaining steps wait for tier 1, not "keep following", while the hold is on', () => {
    const line = (s: CaseState, crewId: CrewId = 'CM-1') => renderToStaticMarkup(createElement(EscalatedLine, { view: view(s, crewId), t: 1000 }))
    const esc = renalEscalated()
    const held = line(esc)
    expect(decode(held.replace(/<[^>]+>/g, ''))).toMatch(
      /^Escalated MET \d+\/\d\d:\d\d:\d\d by a red-flag answer\. You do not need to wait for an answer from the ground; the remaining steps wait for the Crew Medical Officer \(CM-4\)\. design choice$/,
    )
    expect(held).toContain('data-chip="design choice"')
    expect(decode(line(renalEscalated('CM-4'), 'CM-4').replace(/<[^>]+>/g, ''))).toContain(
      "the remaining steps wait for the crew's second Crew Medical Officer, the Commander (CM-1).",
    )
    // nothing left to hold, or a tripwire escalation: the line as before, with no design-choice chip
    const settled = { ...esc, steps_done: esc.spec.step_ids.map((step_id) => ({ step_id, t: 300, input: null })) } as unknown as CaseState
    const tripped = { ...esc, escalation: { ...esc.escalation!, reason: 'tripwire', step_id: null } } as CaseState
    for (const [s, how] of [[settled, 'by a red-flag answer'], [tripped, 'by the tripwire']] as const) {
      const html = line(s)
      expect(decode(html.replace(/<[^>]+>/g, ''))).toContain(`${how}. You do not need to wait for an answer from the ground to keep following the case’s instructions.`)
      expect(html).not.toContain('data-chip')
    }
  })
})

// ---- 4. reverse video only where immediate action is needed ------------------------------------------------

describe('the status badge is filled for a Warning case and for every escalation, an outline for an open Caution case', () => {
  const withStatus = (s: CaseState, status: CaseState['status']): CaseState => ({ ...s, status })
  const speState = speActing()
  const renalState = renalActing()
  const sleepState = fold(getCase(RULES, 'sleep_circadian'), 'CM-1', [{ type: 'OPEN', t: 100, finding: finding('pvt_lapses', 'caution') }])
  it('applies the rule to every open status', () => {
    for (const st of ['detected', 'acting', 'watch', 'escalated'] as const) expect(statusBadgeSolid(view(withStatus(speState, st))), `spe ${st}`).toBe(true)
    for (const st of ['detected', 'acting', 'watch'] as const) {
      expect(statusBadgeSolid(view(withStatus(renalState, st))), `renal ${st}`).toBe(false)
      expect(statusBadgeSolid(view(withStatus(sleepState, st))), `sleep ${st}`).toBe(false)
    }
    expect(statusBadgeSolid(view(renalEscalated()))).toBe(true)
    expect(statusBadgeSolid(view(withStatus(sleepState, 'escalated')))).toBe(true)
    for (const st of ['idle', 'resolved', 'dismissed'] as const) {
      expect(statusBadgeSolid(view(withStatus(speState, st))), `spe ${st}`).toBe(false)
      expect(statusBadgeSolid(view(withStatus(renalState, st))), `renal ${st}`).toBe(false)
    }
  })
  it('renders data-solid on the badge accordingly', () => {
    const badge = (s: CaseState) => renderToStaticMarkup(createElement(CaseStatusBadge, { view: view(s), size: 'sm' }))
    expect(badge(renalEscalated())).toContain('data-solid="true"')
    expect(badge(renalEscalated())).toContain('Escalated')
    expect(badge(renalState)).not.toContain('data-solid')
    expect(badge(speState)).toContain('data-solid="true"')
    expect(badge(renalDetected())).not.toContain('data-solid')
  })
})

// ---- 5 and 6. the overdue note, with the readings in hand (real scenario, Mars, "now") -----------------------

describe('the overdue note counts the readings in hand since the case opened', () => {
  const snaps = import.meta.glob<Snapshot>('../../../public/data/{sim_crew,swpc_spe_replay}.json', { eager: true, import: 'default' })
  const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))![1]
  const INDEX = buildScenarioIndex(snap('sim_crew').data as SimCrewData, snap('swpc_spe_replay').data as SpeReplayData)
  const t = INDEX.nowMet
  const views = computeCases({ index: INDEX, runtime: [], envId: 'mars_surface', t, userEvents: [] }, caseSchedule(INDEX, [], 'mars_surface'))
  const recentOf = (crewId: CrewId) => (variable: string, n: number) => lastN(observationsFor(INDEX, [], crewId, variable), t, n, crewId)
  it("CM-1's sleep case at 412/14:20: 3 of the last 3 PVT-B results meet the tripwire's own condition", () => {
    const sleep = views.find((v) => v.crewId === 'CM-1' && v.caseId === 'sleep_circadian')!
    expect(sleep.state.status).toBe('acting')
    const readings = readingsSinceOpened(recentOf('CM-1'), sleep.state)
    expect(readings.length).toBe(3)
    expect(readings.every((o) => o.t >= sleep.state.opened_at!)).toBe(true)
    const s = text(createElement(OverdueNote, { view: sleep, t, readings }))
    expect(s).toContain('Since MET 407/08:07:30')
    expect(s).toContain(
      'Readings in hand since the case opened: 3 of the last 3 readings of PVT-B lapses meet its escalation condition (at or above 4; it escalates at 2 of 3). The tripwire itself judges only readings after the outcome.',
    )
    // no readings passed: the note as before; not overdue: nothing
    expect(text(createElement(OverdueNote, { view: sleep, t }))).not.toContain('Readings in hand')
    const renal = views.find((v) => v.crewId === 'CM-3' && v.caseId === 'renal_stone')!
    expect(text(createElement(OverdueNote, { view: renal, t, readings: readingsSinceOpened(recentOf('CM-3'), renal.state) }))).toBe('')
  })
  it('keeps readings from before the opening out', () => {
    const sleep = views.find((v) => v.crewId === 'CM-1' && v.caseId === 'sleep_circadian')!
    const late = { ...sleep.state, opened_at: t + 1 }
    expect(readingsSinceOpened(recentOf('CM-1'), late)).toEqual([])
    expect(readingsSinceOpened(recentOf('CM-1'), { ...sleep.state, opened_at: null })).toEqual([])
  })
})

// ---- 7. a typed dose names its crewmember and adds to the dose record ------------------------------------

describe('the vehicle entry label', () => {
  it('a dose names the crewmember and says each entry is added; the proton flux keeps the plain label', () => {
    const dose = vehicleEntryLabel('dose_bfo', 'CM-1')
    expect(dose).toBe('Type CM-1’s blood-forming-organ dose since the previous entry, as the vehicle reports it (each entry is added to the dose record)')
    const flux = vehicleEntryLabel('proton_flux_10mev', 'CM-1')
    expect(flux).toBe('Type the value the vehicle reports (≥10 MeV proton flux)')
    expect(flux).not.toContain('since the previous entry')
    expect(flux).not.toContain('CM-1')
  })
  it('the shelter procedure shows it on step 5 when no dose is reported yet', () => {
    const p = procedure(speDef, speActing())
    expect(p).toContain('Type CM-1’s blood-forming-organ dose since the previous entry, as the vehicle reports it (each entry is added to the dose record)')
    expect(p).toContain('Type the value the vehicle reports (≥10 MeV proton flux)')
  })
})

// ---- 8. releasing the ground packet asks first --------------------------------------------------------

describe('a packet-release step asks before it releases', () => {
  it('names whose packets go and the state change, read from meta.json', () => {
    expect(releaseQuestion(['CM-1', 'CM-2', 'CM-3', 'CM-4'])).toBe(
      'Release the ground packet of CM-1, CM-2, CM-3 and CM-4? Each changes from Prepared (held on board) to Queued and is sent when a link exists.',
    )
    expect(releaseQuestion(['CM-2'])).toBe('Release CM-2’s ground packet? It changes from Prepared (held on board) to Queued and is sent when a link exists.')
  })
  it('starts as the step button (the question opens on click, inline, with no disclosure element)', () => {
    const release = speDef.procedure!.find((p) => p.releases_packet)!
    const html = markup(createElement(StepAction, { c: ctx(speDef, speActing()), step: release, where: 'list' }))
    expect(decode(html.replace(/<[^>]+>/g, ''))).toBe('Release the ground packet (step done)')
    expect(html).not.toContain('<details')
    // a plain step keeps its button
    expect(text(createElement(StepAction, { c: ctx(speDef, speActing()), step: speDef.procedure![0], where: 'list' }))).toBe('Mark step done')
  })
})
