// Cases feature helpers on the REAL frozen snapshots and rules (no Tier B statistic involved).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NOAA_S_THRESHOLDS_PFU, RULES, caseReduce, getCase, getRule, newCase, thresholdRules, triggerLookup } from '../../app/engine'
import type { CaseEvent, CaseState, Finding } from '../../app/engine'
import { CASE_DEFS, caseKey, caseSchedule, computeCases, tierOneFor } from '../../app/caseTimeline'
import type { CaseEventRecord, CaseView, TierOne } from '../../app/caseTimeline'
import type { Snapshot } from '../../app/data'
import { buildScenarioIndex, observationsFor } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import type { Observation } from '../../app/vocab'
import {
  alertingEitherCount,
  chanceOpening,
  checkPlausible,
  doseCoverage,
  findRequirement,
  findTableCell,
  formatSpan,
  formatTMinus,
  hrrIdsOf,
  nextOpenStep,
  packetLabel,
  packetStateOf,
  pendingRequired,
  pickCrew,
  plainDetail,
  replayUtcOf,
  sLevelTransitions,
  sortByUrgency,
  stagesOf,
  stepState,
  tierOneLine,
  tripwireJumpTarget,
  variableLabel,
  windowSecondsOf,
} from './model'
import type { StdData } from './model'
import { detectedCopy } from './helpers'
import { OverdueNote, TierOneBasis } from './status'
import type { CaseDefFull } from './types'

const snaps = import.meta.glob<Snapshot>('../../../public/data/{sim_crew,swpc_spe_replay,std_vol1_requirements,std_vol2_requirements}.json', {
  eager: true,
  import: 'default',
})
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))![1]
const sim = snap('sim_crew').data as SimCrewData
const replay = snap('swpc_spe_replay').data as SpeReplayData & { s_transitions: Array<[string, number | null]> }
const vol1 = snap('std_vol1_requirements').data as StdData
const vol2 = snap('std_vol2_requirements').data as StdData
const INDEX = buildScenarioIndex(sim, replay)
const DAY = 86_400
const LOOKUP = triggerLookup(RULES)

describe('S-level transitions of the proton monitor', () => {
  it('match the replay snapshot’s own transitions, mapped to MET with sim_crew’s time shift', () => {
    const mapIso = sim.spe_day!.shape!.mapping!.replay_utc_at_met_0412_000000!
    const mapMet = sim.spe_day!.met_day! * DAY
    const series = observationsFor(INDEX, [], null, 'proton_flux_10mev')
    const seen = sLevelTransitions(series, INDEX.nowMet).filter((x) => x.t >= mapMet)
    // the snapshot's non-null level changes inside the same span (nulls are archive gaps)
    const expected: Array<{ utc: string; level: number }> = []
    let last: number | null = null
    for (const [utc, level] of replay.s_transitions) {
      if (level === null || level === last) continue
      const t = mapMet + (Date.parse(utc) - Date.parse(mapIso)) / 1000
      if (t < mapMet || t > INDEX.nowMet) {
        last = level
        continue
      }
      expected.push({ utc: `${utc.slice(0, 16).replace('T', ' ')} UTC`, level })
      last = level
    }
    const changes = seen.filter((x) => x.from !== null)
    expect(changes.map((x) => x.to)).toEqual(expected.map((e) => e.level))
    expect(changes.map((x) => replayUtcOf(x.t, mapIso, mapMet))).toEqual(expected.map((e) => e.utc))
    // the shelter level is reached 5 min before "now", as sim_crew documents
    const s3 = changes.find((x) => x.to === getRule(RULES, 'ops_onboard_proton_s3').s_level)!
    expect(INDEX.nowMet - s3.t).toBe(300)
  })
  it('never shows a sample after the clock (no forecast)', () => {
    const series = observationsFor(INDEX, [], null, 'proton_flux_10mev')
    expect(sLevelTransitions(series, INDEX.nowMet).every((x) => x.t <= INDEX.nowMet)).toBe(true)
    expect(sLevelTransitions(series, INDEX.nowMet + 2 * DAY).length).toBeGreaterThan(sLevelTransitions(series, INDEX.nowMet).length)
  })
})

describe('verbatim lookups', () => {
  it('finds requirement text in either volume, with or without brackets', () => {
    expect(findRequirement('V1 4027', vol1, vol2)?.text).toContain(String(getRule(RULES, 'pol_bmd_hip').limit))
    expect(findRequirement('[V2 6164]', vol1, vol2)?.text).toMatch(/radiation monitoring system shall alert/)
    expect(findRequirement('V2 6164', vol1, vol2)?.rationale).toMatch(/ground communication is disrupted/)
    expect(findRequirement('V9 0000', vol1, vol2)).toBeNull()
  })
  it('reads a Table 4.8-1 cell for a rule whose source is the table', () => {
    const r = getRule(RULES, 'pel_t481_bfo_30d')
    const cell = findTableCell(r.source, vol1)
    expect(cell?.text).toContain(String(r.limit))
    expect(cell?.text).toContain(r.unit)
  })
})

// ---- the renal case through the engine: required red-flag step (D5), decline, escalation (D4) ----------

const renal = getCase(RULES, 'renal_stone')
const renalDef = renal as unknown as CaseDefFull
const renalRule = getRule(RULES, 'target_urine_output_24h')
const renalFinding = { rule_id: renalRule.id, severity: 'caution', status: 'outside' } as unknown as Finding
const fold = (events: CaseEvent[]) => events.reduce<CaseState>((s, e) => caseReduce(s, e), newCase(renal, 'CM-3', LOOKUP))
const redFlagId = renal.procedure!.find((x) => x.red_flag)!.id
const opened: CaseEvent[] = [
  { type: 'OPEN', t: 100, finding: renalFinding },
  { type: 'SELECT', t: 200, countermeasure_id: renal.countermeasure!.primary.id },
]
const answer = (value: boolean, t = 300): CaseEvent => ({ type: 'STEP', t, step_id: redFlagId, input: { variable: 'renal_symptoms', value, unit: 'yes/no' } })

describe('case loop stages and gating', () => {
  it('walks detect -> act -> procedure -> tripwire once the red-flag question is answered "no"', () => {
    const idle = stagesOf(newCase(renal, 'CM-3', LOOKUP))
    expect(idle.every((s) => s.state === 'todo')).toBe(true)
    expect(stagesOf(fold([opened[0]])).find((s) => s.id === 'act')!.state).toBe('current')
    const plain = renal.procedure!.find((p) => !p.red_flag)!
    const watch = fold([...opened, { type: 'STEP', t: 250, step_id: plain.id }, answer(false), { type: 'OUTCOME', t: 400, text: 'done' }])
    expect(watch.status).toBe('watch')
    const st = stagesOf(watch)
    expect(st.find((s) => s.id === 'tripwire')).toMatchObject({ state: 'current', t: 400 + renal.tripwire!.reassess_after_s })
    expect(st.find((s) => s.id === 'procedure')!.note).toBe(`2 of ${renal.procedure!.length}`)
    expect(plainDetail(watch.log[watch.log.length - 1].detail, renalDef)).toMatch(/^outcome recorded; reassess at MET \d+\/\d{2}:\d{2}:\d{2} \(2 of 5 steps done\)$/)
  })
  it('the engine refuses the outcome while a required step is open, and the stages say so', () => {
    const acting = fold([...opened, { type: 'OUTCOME', t: 400, text: 'done' }])
    expect(acting.status).toBe('acting')
    expect(acting.log[acting.log.length - 1].error).toBe('required_steps_pending')
    expect(pendingRequired(acting)).toEqual(renal.procedure!.filter((x) => x.required).map((x) => x.id))
    expect(stagesOf(acting).find((s) => s.id === 'outcome')!.note).toBe(`${pendingRequired(acting).length} required left`)
    // the rejection, in plain words: step numbers instead of ids
    expect(plainDetail(acting.log[acting.log.length - 1].detail, renalDef)).toMatch(/with a reason: step 1$/)
  })
  it('a decline with a reason settles a required step; it can still be done later', () => {
    const declined = fold([...opened, { type: 'DECLINE', t: 300, step_id: redFlagId, reason: 'crewmember asleep; ask at wake' }])
    expect(stepState(declined, redFlagId)).toBe('declined')
    expect(pendingRequired(declined)).toEqual([])
    expect(nextOpenStep(declined)).toBe(renal.procedure![1].id)
    expect(stagesOf(declined).find((s) => s.id === 'procedure')!.note).toBe(`0 of ${renal.procedure!.length} · 1 declined`)
    const later = caseReduce(declined, answer(false, 350))
    expect(stepState(later, redFlagId)).toBe('done')
    expect(caseReduce(later, { type: 'OUTCOME', t: 400, text: 'ok' }).status).toBe('watch')
  })
  it('a red-flag "yes" escalates at once to both tiers and queues the packet', () => {
    const acting = fold(opened)
    expect(packetStateOf(acting)).toBe('prepared')
    const esc = caseReduce(acting, answer(true))
    expect(esc.status).toBe('escalated')
    expect(esc.escalation).toMatchObject({ reason: 'red_flag', step_id: redFlagId, tiers: ['crew_medical_officer', 'flight_surgeon'] })
    expect(packetStateOf(esc)).toBe('queued')
    const st = stagesOf(esc)
    expect(st.find((s) => s.id === 'outcome')!.state).toBe('skipped')
    expect(st.find((s) => s.id === 'tripwire')!.state).toBe('skipped')
    expect(st.find((s) => s.id === 'close')).toMatchObject({ state: 'done', label: 'Escalated' })
    expect(plainDetail(esc.log[esc.log.length - 1].detail, renalDef)).toMatch(/^step 1 answered yes, a red flag; escalated: tier 1, the Crew Medical Officer, now/)
  })
  it('packet states read their labels from meta.json', () => {
    const labels = ((RULES.meta as Record<string, unknown>).packet_states as Array<{ id: string; label: string }>).map((p) => [p.id, p.label])
    expect(labels).toContainEqual(['prepared', packetLabel('prepared')])
    expect(labels).toContainEqual(['queued', packetLabel('queued')])
    expect(packetStateOf(newCase(renal, 'CM-3', LOOKUP))).toBe('none')
  })
  it('tier 1 is true for the crewmember’s role (the CMO is not told to tell the CMO)', () => {
    expect(tierOneLine('CM-1')).toBe('Tell the Crew Medical Officer (CM-4) now.')
    expect(tierOneLine('CM-4')).toMatch(/^You are the Crew Medical Officer/)
  })
  it('formats spans and countdowns (F.6.1 f: no leading zeros in the day field)', () => {
    expect(formatSpan(renal.tripwire!.reassess_after_s)).toBe(`${renal.tripwire!.reassess_after_s / 3600} h`)
    expect(formatTMinus(63_592)).toBe('0/17:39:52')
    expect(formatTMinus(-5)).toBe('0/00:00:00')
    expect(formatTMinus(11 * DAY + 5 * 3600 + 59 * 60 + 51)).toBe('11/05:59:51')
  })
})

// ---- renal: the red-flag question before "drink more" (low output can itself be retention) ----------

describe('the renal red-flag question comes before "drink more"', () => {
  it('is step 1 of the procedure and says so; the one-liner asks the symptom questions first', () => {
    const steps = renal.procedure!
    expect(steps.map((p) => p.id)).toEqual(['r4', 'r1', 'r2', 'r3', 'r5'])
    expect(steps[0]).toMatchObject({ id: redFlagId, red_flag: true, required: true })
    expect(steps.filter((p) => p.red_flag).map((p) => p.id)).toEqual([redFlagId])
    expect(steps[0].text!.startsWith('Answer this before you drink more. Ask now: ')).toBe(true)
    expect(steps[0].text).toContain('being unable to pass urine')
    expect(steps[0].text).toContain('(if that is you, the Commander)')
    expect(renal.one_line!.endsWith('Answer the symptom questions first, then drink more and log it.')).toBe(true)
  })
  it('the detected status card leads with the red-flag question for renal; the shelter and sleep cases keep their copy', () => {
    expect(detectedCopy(renalDef)).toEqual({
      redFlagFirst: true,
      kicker: 'Start now: the required red-flag question, then one primary countermeasure',
      title: 'Red-flag question first',
      stepHeading: null,
      thenLine: 'Then: Drink more, spread through the waking day',
      button: 'Start: answer the red-flag question first',
    })
    expect(renal.countermeasure!.primary.title).toBe('Drink more, spread through the waking day')
    const today: Record<string, string> = {
      spe_shelter: 'Stop or postpone EVA and move to the most shielded area',
      sleep_circadian: 'Use light to re-anchor the day',
    }
    for (const [id, title] of Object.entries(today)) {
      const def = getCase(RULES, id) as unknown as CaseDefFull
      expect(def.procedure![0].red_flag, id).not.toBe(true) // the shelter's p1 (stop or postpone EVA) is not a red flag
      expect(detectedCopy(def), id).toEqual({
        redFlagFirst: false,
        kicker: 'Start now: one primary countermeasure',
        title,
        stepHeading: `Then step 1 of ${def.procedure!.length}`,
        thenLine: null,
        button: 'Start the countermeasure',
      })
    }
    // a Start that goes to several crewmembers (the crew-wide shelter) says so
    expect(detectedCopy(getCase(RULES, 'spe_shelter') as unknown as CaseDefFull, 4).button).toBe('Start the countermeasure (all 4 crewmembers)')
    expect(detectedCopy(renalDef, 2).button).toBe('Start: answer the red-flag question first (all 2 crewmembers)')
    expect(detectedCopy({ procedure: [], countermeasure: undefined })).toMatchObject({ redFlagFirst: false, title: 'Start the countermeasure', stepHeading: null })
  })
})

// ---- tier 1 on the Crew Medical Officer's own cases: the crew's second Crew Medical Officer ([V1 3006]) --

describe('tier 1 basis when the patient is the Crew Medical Officer', () => {
  const decode = (s: string) =>
    s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' })[e]!)
  const text = (tier1: TierOne) => decode(renderToStaticMarkup(createElement(TierOneBasis, { view: { tier1 } as unknown as CaseView })).replace(/<[^>]+>/g, ''))
  const t1 = tierOneFor('CM-4')
  const req = findRequirement('V1 3006', vol1, vol2)!
  const statement = req.text!
  const fragment = 'to ensure that a backup is available for medical treatment'
  const cite = (verbatim: string) => ({ kind: 'nasa_standard', snapshot: 'std_vol1_requirements', requirement_id: 'V1 3006', verbatim })
  const v2Only: TierOne = { ...t1, citations: t1.citations.filter((c) => c.requirement_id === 'V2 7045') }
  const with3006: TierOne = { ...t1, citations: [...v2Only.citations, cite(statement), cite(fragment)] }

  it('reads cleanly with or without the [V1 3006] citation, and always quotes [V2 7045]', () => {
    expect(req.rationale).toContain(fragment)
    for (const tier1 of [t1, v2Only, with3006]) {
      const s = text(tier1)
      expect(s).toContain("The Crew Medical Officer is the patient here, so tier 1 is the crew's second Crew Medical Officer, the Commander (CM-1).")
      expect(s).toContain('Which crewmember holds the second assignment is a design choice')
      expect(s).toContain('[V2 7045] asks for medical equipment usable by non-physician crewmembers')
      expect(s).toContain('“in the event that a physician crewmember is not present or is the one who requires medical treatment”.')
      expect(s).not.toMatch(/backup medical officer|undefined|null|NaN|\s[.,]|\s{2}/i)
    }
    expect(text(v2Only)).not.toContain('3006')
    expect(text(v2Only)).toContain('NASA-STD-3001 plans for this with a physician crewmember')
    expect(statement).toBe('The program(s) shall train a minimum of two crewmembers per vehicle/platform as Crew Medical Officers (CMOs).')
    expect(text(with3006)).toContain(`NASA-STD-3001 requires at least two Crew Medical Officers: [V1 3006] “${statement}” and “${fragment}”.`)
    expect(text(with3006)).toContain('NASA-STD-3001 also plans for this with a physician crewmember')
    // whatever meta.json carries, each [V1 3006] quote is the frozen requirement's own words (statement or rationale)
    for (const c of t1.citations.filter((x) => x.requirement_id === 'V1 3006')) expect(`${statement} ${req.rationale}`).toContain(c.verbatim as string)
    // nobody else's case shows it
    expect(renderToStaticMarkup(createElement(TierOneBasis, { view: { tier1: tierOneFor('CM-2') } as unknown as CaseView }))).toBe('')
  })
})

// ---- the real scenario at "now" (Mars) -------------------------------------------------------------

const ENV = 'mars_surface'
const scheduleNow = caseSchedule(INDEX, [], ENV)
const viewsAt = (t: number, userEvents: CaseEventRecord[] = []) => computeCases({ index: INDEX, runtime: [], envId: ENV, t, userEvents }, scheduleNow)

describe('a reassessment overdue, on the case page (the alert bar rule: app/procedureAlerts overdueOf)', () => {
  const html = (v: CaseView, t: number) => renderToStaticMarkup(createElement(OverdueNote, { view: v, t })).replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'")
  it("CM-1's acting sleep case reads overdue since its start plus 72 h, with what to do; an armed or idle case reads nothing", () => {
    const views = viewsAt(INDEX.nowMet)
    const sleep = views.find((v) => v.crewId === 'CM-1' && v.caseId === 'sleep_circadian')!
    expect(sleep.state.status).toBe('acting')
    const text = html(sleep, INDEX.nowMet)
    expect(text).toContain('Reassessment overdue')
    expect(text).toContain('Since MET 407/08:07:30')
    expect(text).toContain('reassessment interval (72 h) of its start')
    expect(text).toContain('Log the outcome, or tell the Crew Medical Officer (CM-4) now.')
    const renal = views.find((v) => v.crewId === 'CM-3' && v.caseId === 'renal_stone')!
    expect(renal.state.status).toBe('watch')
    expect(html(renal, INDEX.nowMet)).toBe('')
    expect(html(views.find((v) => v.crewId === 'CM-2' && v.caseId === 'renal_stone')!, INDEX.nowMet)).toBe('')
  })
  it('names the shelter packet variables in words (no "dose cns")', () => {
    expect(variableLabel('dose_cns')).toBe('central nervous system dose')
    expect(variableLabel('dose_circulatory')).toBe('circulatory system dose')
    for (const v of getCase(RULES, 'spe_shelter').escalation!.observations ?? []) expect(variableLabel(v), v).not.toMatch(/_|^dose (cns|circulatory)$/)
  })
})

describe('the case list order and the plain-language log on the real scenario', () => {
  it('puts the crew-wide solar particle event (a warning) first', () => {
    const views = viewsAt(INDEX.nowMet)
    const order = sortByUrgency(CASE_DEFS as unknown as CaseDefFull[], views).map((d) => d.id)
    expect(order[0]).toBe('spe_shelter')
    expect(new Set(order)).toEqual(new Set(CASE_DEFS.map((d) => d.id)))
  })
  it('leaves no rule, indicator, step or countermeasure id in the plain log text', () => {
    const ids = new Set<string>([
      ...thresholdRules(RULES).map((r) => r.id),
      ...((RULES.personal?.indicators ?? []) as Array<{ id: string }>).map((i) => i.id),
      ...CASE_DEFS.flatMap((d) => [...(d.procedure ?? []).map((p) => p.id), d.countermeasure!.primary.id, ...(d.countermeasure!.alternatives ?? []).map((a) => a.id)]),
    ])
    let n = 0
    for (const v of viewsAt(INDEX.nowMet + 3 * DAY)) {
      for (const e of v.state.log) {
        const text = plainDetail(e.detail, v.def as unknown as CaseDefFull)
        for (const tok of text.split(/[^A-Za-z0-9_]+/)) expect(ids.has(tok), `${tok} in "${text}"`).toBe(false)
        // the engine's status words read plainly too ("opened by Sleep midpoint shift (reliable change, caution)")
        expect(text).not.toMatch(/\b(reliable_change|insufficient_data|not_applicable)\b/)
        n += 1
      }
    }
    expect(n).toBeGreaterThan(0)
  })
  it('the tripwire demo jump lands on a whole minute at or after reassessment, where the fold judges it', () => {
    expect(tripwireJumpTarget(35_670_021)).toBe(35_670_060)
    expect(tripwireJumpTarget(35_670_060)).toBe(35_670_060)
    // CM-1 shelters and logs an outcome at a time with seconds, as a user would
    const key = caseKey('CM-1', 'spe_shelter')
    const t0 = INDEX.nowMet + 21
    const ev = (event: CaseEvent, seq: number): CaseEventRecord => ({ key, event, origin: 'user', seq })
    const spe = getCase(RULES, 'spe_shelter')
    const shelter = spe.procedure!.find((p) => p.input?.unit === 'MET')!
    const required = spe.procedure!.filter((p) => p.required)
    const user = [
      ev({ type: 'SELECT', t: t0, countermeasure_id: spe.countermeasure!.primary.id }, 1),
      ...required.map((p, i) =>
        ev({ type: 'STEP', t: t0 + 1 + i, step_id: p.id, ...(p.id === shelter.id ? { input: { variable: shelter.input!.variable, value: t0, unit: 'MET' } } : {}) }, 2 + i),
      ),
      ev({ type: 'OUTCOME', t: t0 + 10, text: 'all four in the shelter' }, 9),
    ]
    const armed = viewsAt(t0 + 10, user).find((v) => v.key === key)!.state
    expect(armed.status).toBe('watch')
    expect(armed.reassess_at! % 60).not.toBe(0)
    const target = tripwireJumpTarget(armed.reassess_at!)
    expect(target % 60).toBe(0)
    expect(target).toBeGreaterThanOrEqual(armed.reassess_at!)
    expect(target - armed.reassess_at!).toBeLessThan(60)
    // useCases folds at the minute clock: at the target minute the verdict is already in
    const judged = viewsAt(target, user).find((v) => v.key === key)!.state
    expect(judged.status).not.toBe('watch')
    expect(judged.tripwire_result).not.toBeNull()
  })
})

// ---- manual entry, dose records, HRR, chance flags --------------------------------------------------

describe('manual entry typing check (design choice, never a clinical limit)', () => {
  it('bounds a dose by the rule’s own 30-day limit, and the flux by the top of NOAA’s scale', () => {
    const bfo = getRule(RULES, 'pel_t481_bfo_30d')
    const huge = checkPlausible(bfo.variable, bfo.unit, 1e9)
    expect(huge).toMatchObject({ ok: false, side: 'high' })
    expect(huge.range!.max).toBe(bfo.limit)
    expect(huge.range!.chip).toBe('design choice')
    expect(checkPlausible(bfo.variable, bfo.unit, 14).ok).toBe(true)
    expect(checkPlausible('proton_flux_10mev', 'pfu', 1100).ok).toBe(true)
    expect(checkPlausible('proton_flux_10mev', 'pfu', 2e6).range!.max).toBe(NOAA_S_THRESHOLDS_PFU[NOAA_S_THRESHOLDS_PFU.length - 1])
  })
  it('asks about litres typed as millilitres and an extra zero; other variables have no range', () => {
    expect(checkPlausible('urine_volume_24h', 'mL', 1.5)).toMatchObject({ ok: false, side: 'low' })
    expect(checkPlausible('urine_volume_24h', 'mL', 14800)).toMatchObject({ ok: false, side: 'high' })
    expect(checkPlausible('urine_volume_24h', 'mL', 1480).ok).toBe(true)
    expect(checkPlausible('fluid_intake_24h', 'L', 1.5)).toMatchObject({ ok: true, range: null })
    expect(checkPlausible('pvt_lapses', 'count', 40)).toMatchObject({ ok: true, range: null })
  })
})

describe('dose records: a window with incomplete coverage is a partial record (D15)', () => {
  const o = (t: number, value = 5): Observation => ({ crew_id: 'CM-1', variable: 'dose_bfo', value, unit: 'mGy-Eq', t, source: 'manual', provenance: 'manual' })
  const now = 412.5 * DAY
  const d30 = windowSecondsOf(getRule(RULES, 'pel_t481_bfo_30d'))
  it('reads the window from the rule', () => {
    expect(d30).toBe(30 * DAY)
    expect(windowSecondsOf(getRule(RULES, 'pel_t481_lens_career'))).toBeNull()
  })
  it('a first report inside the window is partial; reports from before it cover it; career opens at MET 0', () => {
    expect(doseCoverage([o(412 * DAY)], 'mGy-Eq', now, d30)).toMatchObject({ partial: true, n: 1, firstT: 412 * DAY })
    expect(doseCoverage([o(370 * DAY), o(412 * DAY)], 'mGy-Eq', now, d30).partial).toBe(false)
    expect(doseCoverage([o(412 * DAY)], 'mGy-Eq', now, null).partial).toBe(true)
    expect(doseCoverage([], 'mGy-Eq', now, d30)).toMatchObject({ partial: false, n: 0, firstT: null })
    expect(doseCoverage([o(412 * DAY)], 'mGy', now, d30).n).toBe(0)
  })
})

describe('HRR ratings, chance flags and the Tier B false-alarm basis', () => {
  it('finds every HRR risk a case cites (its HRP page’s id, plus the roadmap URLs in the case)', () => {
    const urls = JSON.stringify(renalDef).match(/humanresearchroadmap\.nasa\.gov\/risks\/\?i=(\d+)/g) ?? []
    expect(urls.length).toBeGreaterThan(0)
    const ids = hrrIdsOf(renalDef, 77)
    expect(ids[0]).toBe(77)
    for (const u of urls) expect(ids).toContain(Number(u.split('=')[1]))
    expect(hrrIdsOf(getCase(RULES, 'spe_shelter') as unknown as CaseDefFull, 96)).toContain(96)
  })
  it('labels an opening the simulator records as a chance flag, matching crewmember, case and day', () => {
    const check = { unscripted_case_openings: [{ crew_id: 'CM-3', case_id: 'sleep_circadian', day: 405, indicator_id: 'sleep_midpoint_shift', t: 4.7, scripted_opening_day: null }] }
    expect(chanceOpening(check, 'CM-3', 'sleep_circadian', 405 * DAY + 3600)?.day).toBe(405)
    expect(chanceOpening(check, 'CM-3', 'sleep_circadian', 406 * DAY)).toBeNull()
    expect(chanceOpening(check, 'CM-1', 'sleep_circadian', 405 * DAY)).toBeNull()
    expect(chanceOpening(null, 'CM-3', 'sleep_circadian', 405 * DAY)).toBeNull()
    // the shipped self-check, whatever it lists, refers only to real cases and crew
    for (const x of (sim as unknown as { self_check?: { unscripted_case_openings?: Array<{ case_id: string; crew_id: string }> } }).self_check?.unscripted_case_openings ?? []) {
      expect(CASE_DEFS.map((d) => d.id)).toContain(x.case_id)
      expect(['CM-1', 'CM-2', 'CM-3', 'CM-4']).toContain(x.crew_id)
    }
  })
  it('counts the alerting indicators that alert both ways, from the rules', () => {
    const inds = (RULES.personal?.indicators ?? []) as Array<{ id: string; alerting: boolean; private?: boolean; worse: string }>
    expect(alertingEitherCount()).toBe(inds.filter((i) => i.alerting && !i.private && i.worse === 'either').length)
    expect(inds.find((i) => i.id === 'glucose')?.worse).toBe('either')
  })
})

describe('crew selection', () => {
  const v = (crewId: string, status: string) => ({ caseId: 'renal_stone', crewId, state: { status } }) as unknown as CaseView
  const views = [v('CM-1', 'idle'), v('CM-2', 'idle'), v('CM-3', 'watch'), v('CM-4', 'idle')]
  it('lands on the crewmember whose case is open unless the query names one', () => {
    expect(pickCrew('renal_stone', views, undefined, 'CM-1')).toBe('CM-3')
    expect(pickCrew('renal_stone', views, 'CM-2', 'CM-1')).toBe('CM-2')
    expect(pickCrew('renal_stone', views, 'CM-9', 'CM-1')).toBe('CM-3')
    expect(pickCrew('renal_stone', views.map((x) => ({ ...x, state: { status: 'idle' } }) as unknown as CaseView), undefined, 'CM-4')).toBe('CM-4')
  })
})
