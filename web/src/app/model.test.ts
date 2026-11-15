// Mission model on the REAL frozen snapshots (web/public/data) and the REAL rules (engine/rules).
import { describe, expect, it } from 'vitest'
import { RULES, consentAllows, formatMet, getEnvironment, getRule, buildGroundPacket } from './engine'
import { aggregateForRule, chanceRateOf, durationSeconds, evaluateMission, evaluateRuleAt, partialRecord, percentOfPreMission, TRIGGER_CASE } from './evaluate'
import { caseKey, caseSchedule, computeCases, tierOneFor } from './caseTimeline'
import type { CaseEventRecord } from './caseTimeline'
import { buildScenarioIndex, observationsFor, replayAfterNow, seriesKey, visibleObservations } from './scenarioData'
import type { SimCrewData, SpeReplayData } from './scenarioData'
import { computeComms, windowModelNote } from './comms'
import { defaultConsent, initialMissionState, missionReducer, selectAlertGroups, selectAnnunciator } from './mission'
import { CMO_ID, escalationTiers, packetDelivery, packetState, packetStateLabel } from './packet'
import { ENVIRONMENTS, MET_NOW_S, environment } from './scenario'
import { CATEGORIES, CHIPS, ENV_IDS } from './vocab'
import type { CrewId, EnvId, Observation } from './vocab'
import type { Snapshot } from './data'

const snaps = import.meta.glob<Snapshot>('../../public/data/{sim_crew,swpc_spe_replay,horizons_mars_comms,horizons_moon_comms}.json', {
  eager: true,
  import: 'default',
})
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))?.[1]
const SIM = snap('sim_crew')!
const REPLAY = snap('swpc_spe_replay')!
const sim = SIM.data as SimCrewData
const replay = REPLAY.data as SpeReplayData
const INDEX = buildScenarioIndex(sim, replay)
const NOW = INDEX.nowMet
const DAY = 86_400

/** The simulator's own Tier B report (sim_crew data.self_check.tier_b): the tests follow the data, never a hand-typed day. */
interface TierBReport {
  per_crew: Record<string, { indicators: Array<{ indicator_id: string; baseline_n: number; baseline_mean: number; baseline_sd: number; mdc: number }> }>
  episodes: Array<{ crew_id: string; indicator_id: string; case_id: string; tier_b_flagged_days: number[] }>
}
const TIER_B = (sim as unknown as { self_check: { tier_b: TierBReport } }).self_check.tier_b

function cases(envId: EnvId, t: number, userEvents: CaseEventRecord[] = [], runtime: Observation[] = []) {
  return computeCases({ index: INDEX, runtime, envId, t, userEvents }, caseSchedule(INDEX, runtime, envId))
}
const view = (list: ReturnType<typeof cases>, crew: CrewId, id: string) => list.find((v) => v.key === caseKey(crew, id))!

describe('scenario index', () => {
  it('matches SPEC 7 and the vocabulary files', () => {
    expect(NOW).toBe(MET_NOW_S)
    expect(INDEX.epochIso).toBe('2027-01-31T02:40:00Z')
    expect(INDEX.baselineDays).toEqual([368, 381])
    expect(ENVIRONMENTS.map((e) => e.id)).toEqual([...ENV_IDS])
    expect((RULES.environments!.environments as Array<{ id: string }>).map((e) => e.id).sort()).toEqual([...ENV_IDS].sort())
    expect(() => getEnvironment(RULES, 'mars')).toThrow()
    expect(CHIPS.length).toBeGreaterThanOrEqual(6)
    expect(CATEGORIES).toContain('TARGET')
  })
  it('stamps cabin ppCO2 hourly means at their window END (t_meaning), so none is used early', () => {
    const co2 = INDEX.series.get(seriesKey(null, 'cabin_ppco2'))!
    const s = sim.vehicle.series.cabin_ppco2
    expect(co2[0].t).toBe(s.start_t! + s.step_s!)
    expect(co2[co2.length - 1].t).toBeLessThanOrEqual(NOW)
  })
  it('keeps each series\' own provenance: the proton flux is a replay before now too (sim_crew observation_format.expand)', () => {
    const flux = INDEX.series.get(seriesKey(null, 'proton_flux_10mev'))!
    const before = flux.filter((o) => o.t <= NOW)
    expect(before.length).toBeGreaterThan(0)
    expect(sim.vehicle.series.proton_flux_10mev.provenance).toBe('replay')
    expect(before.every((o) => o.provenance === 'replay')).toBe(true)
    const dose = INDEX.series.get(seriesKey(null, 'onboard_dose_rate'))!
    expect(dose.every((o) => o.provenance === (sim.vehicle.series.onboard_dose_rate.provenance ?? 'simulated'))).toBe(true)
  })
  it('continues the onboard monitor after now with the REAL Oct 1989 replay, time-shifted as sim_crew documents', () => {
    const after = replayAfterNow(sim, replay)
    expect(INDEX.replay.snapshot).toBe('swpc_spe_replay')
    expect(after[0].t).toBe(NOW + 300)
    // identical to sim_crew's own copy of the continuation wherever both exist
    const copy = sim.vehicle.series.proton_flux_10mev.after_now!
    for (let i = 0; i < copy.v.length; i++) {
      const v = copy.v[i]
      if (v === null) continue
      const o = after.find((x) => x.t === copy.start_t + i * copy.step_s)
      expect(o?.value).toBe(v)
    }
    expect(INDEX.replay.last_t!).toBeGreaterThan(copy.start_t + copy.v.length * copy.step_s)
  })
})

describe('window aggregation', () => {
  it('parses durations (a year is 365 d)', () => {
    expect(durationSeconds('PT1H')).toBe(3600)
    expect(durationSeconds('P30D')).toBe(30 * DAY)
    expect(durationSeconds('P1Y')).toBe(365 * DAY)
    expect(durationSeconds('P')).toBeNull()
  })
  it('1-hour rolling mean of cabin ppCO2 [V2 6004] uses only values available in the last hour', () => {
    const rule = RULES.thresholds!.rules.find((r) => r.id === 'pel_cabin_ppco2_1h')!
    const obs = observationsFor(INDEX, [], 'CM-1', 'cabin_ppco2')
    const agg = aggregateForRule(rule, obs, NOW)
    expect(agg.n).toBe(1)
    expect(agg.t).toBe(412 * DAY + 14 * 3600)
    const manual: Observation = { crew_id: null, variable: 'cabin_ppco2', value: 3.6, unit: 'mmHg', t: NOW, source: 'manual', provenance: 'manual' }
    const agg2 = aggregateForRule(rule, [...obs, manual], NOW)
    expect(agg2.n).toBe(2)
    expect(agg2.value).toBeCloseTo((obs[obs.length - 1].value + 3.6) / 2, 9)
  })
  it('never sums a 24-h total twice, sums dose reports, and never converts units', () => {
    const target = RULES.thresholds!.rules.find((r) => r.id === 'target_urine_output_24h')!
    const urine = observationsFor(INDEX, [], 'CM-3', 'urine_volume_24h')
    expect(aggregateForRule(target, urine, NOW).value).toBe(urine[urine.length - 1].value)
    const bfo = RULES.thresholds!.rules.find((r) => r.id === 'pel_t481_bfo_30d')!
    const reports: Observation[] = [
      { crew_id: 'CM-1', variable: 'dose_bfo', value: 2, unit: 'mGy-Eq', t: NOW - 3600, source: 'vehicle', provenance: 'manual' },
      { crew_id: 'CM-1', variable: 'dose_bfo', value: 3, unit: 'mGy-Eq', t: NOW, source: 'vehicle', provenance: 'manual' },
      { crew_id: 'CM-1', variable: 'dose_bfo', value: 9, unit: 'mSv', t: NOW, source: 'vehicle', provenance: 'manual' },
    ]
    const a = aggregateForRule(bfo, reports, NOW)
    expect(a.value).toBe(5)
    expect(a.unit_mismatch).toBe(1)
    expect(percentOfPreMission(93, 100)).toBe(93)
    expect(percentOfPreMission(93, 0)).toBeNull()
  })
  it('D15: a summed dose window whose record starts after it opens is a partial record, never "within limit"', () => {
    const bfo = getRule(RULES, 'pel_t481_bfo_30d')
    const one = (value: number, t = NOW): Observation => ({ crew_id: 'CM-1', variable: 'dose_bfo', value, unit: 'mGy-Eq', t, source: 'vehicle', provenance: 'manual' })
    // one report today: the 30 days before it are not in the record
    const low = evaluateRuleAt(bfo, INDEX, [one(14)], 'CM-1', 'mars_surface', NOW)
    expect(low.input.partial).toBe(true)
    expect(low.input.record_start).toBe(NOW)
    expect(low.input.window_start).toBe(NOW - 30 * DAY)
    expect(low.finding.status).toBe('within')
    expect(partialRecord(low)).toBe(true)
    expect(low.input.basis).toMatch(/partial record/)
    // a partial record over the limit is conclusive: the full sum can only be higher
    const high = evaluateRuleAt(bfo, INDEX, [one(bfo.limit + 1)], 'CM-1', 'mars_surface', NOW)
    expect(high.finding.status).toBe('outside')
    expect(partialRecord(high)).toBe(false)
    // a record that starts before the window opens covers it
    const covered = evaluateRuleAt(bfo, INDEX, [one(1, NOW - 40 * DAY), one(14)], 'CM-1', 'mars_surface', NOW)
    expect(covered.input.partial).toBe(false)
    expect(covered.input.value).toBe(14) // only the report inside the window is summed
    expect(partialRecord(covered)).toBe(false)
    // not a summed window: never partial
    const urine = evaluateRuleAt(getRule(RULES, 'target_urine_output_24h'), INDEX, [], 'CM-3', 'mars_surface', NOW)
    expect(urine.input.partial).toBe(false)
    expect(urine.input.window_start).toBeNull()
    // no record at all stays insufficient data (cyan), not partial
    const none = evaluateRuleAt(bfo, INDEX, [], 'CM-1', 'mars_surface', NOW)
    expect(none.finding.status).toBe('insufficient_data')
    expect(none.input.partial).toBe(false)
  })
})

describe('evaluation', () => {
  it('CM-2 VO2max 35.1 is within the microgravity-EVA floor and outside the surface-EVA floor', () => {
    for (const env of ['iss', 'cislunar'] as EnvId[]) {
      const e = evaluateMission(INDEX, [], env, NOW).crew['CM-2'].tierA
      const micro = e.find((x) => x.rule.id === 'ffd_vo2max_microgravity_eva')!.finding
      expect(micro.value).toBe(35.1)
      expect(micro.status).toBe('within')
      expect(e.find((x) => x.rule.id === 'ffd_vo2max_surface_eva')!.finding.status).toBe('not_applicable')
    }
    for (const env of ['lunar_surface', 'mars_surface'] as EnvId[]) {
      const ev = evaluateMission(INDEX, [], env, NOW)
      const e = ev.crew['CM-2'].tierA
      const surf = e.find((x) => x.rule.id === 'ffd_vo2max_surface_eva')!.finding
      expect(surf.value).toBe(35.1)
      expect(surf.status).toBe('outside')
      expect(surf.severity).toBe('caution') // D1: a fitness floor needs attention, not immediate action
      expect(e.find((x) => x.rule.id === 'ffd_vo2max_microgravity_eva')!.finding.status).toBe('not_applicable')
      // D11: a finding without a deep case is annunciated with its one-line action label, not a rule name
      const a = ev.alerts.find((x) => x.id === 'CM-2:ffd_vo2max_surface_eva')!
      const action = getRule(RULES, 'ffd_vo2max_surface_eva').action as { label: string; text: string }
      expect(a.title).toBe(action.label)
      expect(a.action_text).toBe(action.text)
      expect(a.href).toBe('#/body')
      expect(a.case_id).toBeNull()
    }
  })
  it('uses the FIXED baseline (MET days 368-381) for Tier B, and agrees with the simulator\'s own report', () => {
    const e = evaluateMission(INDEX, [], 'mars_surface', NOW)
    const urine = e.crew['CM-3'].tierB.find((x) => x.indicator.id === 'urine_volume_24h')!
    const rep = TIER_B.per_crew['CM-3'].indicators.find((x) => x.indicator_id === 'urine_volume_24h')!
    expect(urine.baseline).toHaveLength(rep.baseline_n)
    // the report rounds to 4 decimals
    expect(urine.finding.rci.mean).toBeCloseTo(rep.baseline_mean, 3)
    expect(urine.finding.rci.mdc!).toBeCloseTo(rep.mdc, 3)
    // every episode indicator the simulator reports as flagged today is a reliable change (caution) at now
    const today = Math.floor(NOW / DAY)
    for (const ep of TIER_B.episodes.filter((x) => x.tier_b_flagged_days.includes(today))) {
      const f = e.crew[ep.crew_id as CrewId].tierB.find((x) => x.indicator.id === ep.indicator_id)!.finding
      expect(f.status).toBe('reliable_change')
      expect(f.severity).toBe('caution')
    }
  })
  it('OPS: the Mars-orbit monitor at Mars, NOAA S-scale elsewhere; S3 at now is a Warning; organ doses honestly insufficient', () => {
    const mars = evaluateMission(INDEX, [], 'mars_surface', NOW)
    expect(mars.ops.kind).toBe('onboard_monitor')
    expect(mars.ops.label).toContain(sim.variables.proton_flux_10mev.label!)
    expect(mars.ops.label).not.toMatch(/onboard proton monitor/i)
    expect(mars.ops.s_level).toBe(3)
    expect(mars.ops.active?.rule.id).toBe('ops_onboard_proton_s3')
    expect(mars.ops.active?.finding.severity).toBe('warning') // D1: Table 10.3-1, shelter is immediate action
    const iss = evaluateMission(INDEX, [], 'iss', NOW)
    expect(iss.ops.kind).toBe('noaa')
    expect(iss.ops.active?.rule.id).toBe('ops_noaa_s3')
    expect(iss.ops.active?.finding.severity).toBe('warning')
    const bfo = mars.crew['CM-1'].tierA.find((x) => x.rule.id === 'pel_t481_bfo_30d')!.finding
    expect(bfo.status).toBe('insufficient_data')
    const career = mars.crew['CM-3'].tierA.find((x) => x.rule.id === 'pel_career_effective_dose')!.finding
    expect(career.status).toBe('within')
  })
  it('annunciator at Mars, now: the only Warning is the crew-wide S3 shelter case; no data-quality, context or mood entries', () => {
    const e = evaluateMission(INDEX, [], 'mars_surface', NOW)
    const ids = e.alerts.map((a) => `${a.id}=${a.severity}`).sort()
    expect(ids).toContain('ALL:ops_onboard_proton_s3=warning')
    expect(ids).toContain('CM-2:ffd_vo2max_surface_eva=caution')
    expect(ids.filter((x) => x.startsWith('CM-1:')).every((x) => x.endsWith('=caution'))).toBe(true)
    expect(e.alerts.some((a) => a.id.endsWith(':mood'))).toBe(false)
    expect(e.alerts.some((a) => a.id.includes('ctx_'))).toBe(false)
    expect(e.alerts.filter((a) => a.severity === 'warning').map((a) => a.id)).toEqual(['ALL:ops_onboard_proton_s3'])
    // crew text carries no rule ids (D7)
    for (const a of e.alerts) expect(a.title).not.toMatch(/\b(ops|ffd|pel|pol|target|ctx)_[a-z0-9_]+/)
    // case triggers are grouped per crewmember and case (D16)
    const spe = e.alerts.find((a) => a.id === 'ALL:ops_onboard_proton_s3')!
    expect(spe.title).toBe(getRule(RULES, 'ops_onboard_proton_s3').label!.replace(/>=/g, '≥'))
    expect(spe.detail).toMatch(/^Case open: /)
    expect(spe.group).toBe('ALL:case:spe_shelter')
    expect(spe.case_id).toBe('spe_shelter')
    for (const a of e.alerts.filter((x) => x.crew_id === 'CM-1' && x.case_id === 'sleep_circadian')) expect(a.group).toBe('CM-1:case:sleep_circadian')
    const iss = evaluateMission(INDEX, [], 'iss', NOW)
    expect(iss.alerts.filter((a) => a.severity === 'warning').map((a) => a.id)).toEqual(['ALL:ops_noaa_s3'])
  })
  it('the trigger map follows cases.json, and case-trigger findings never show a rules action label', () => {
    expect(TRIGGER_CASE.get('ops_onboard_proton_s3')?.id).toBe('spe_shelter')
    expect(TRIGGER_CASE.get('urine_volume_24h')?.id).toBe('renal_stone')
    expect(TRIGGER_CASE.has('ffd_vo2max_surface_eva')).toBe(false)
  })
  it('D16: the mission bar counts one line per case and crewmember; acknowledging a line acknowledges its findings', () => {
    let s = initialMissionState()
    s = missionReducer(s, {
      type: 'publishAlerts',
      source: 'mission',
      alerts: [
        { id: 'ALL:ops', severity: 'warning', title: 'S3', group: 'ALL:case:spe', group_title: 'Shelter', case_id: 'spe', crew_id: 'ALL' },
        { id: 'CM-1:a', severity: 'caution', title: 'A', group: 'CM-1:case:sleep', group_title: 'Sleep', case_id: 'sleep', crew_id: 'CM-1' },
        { id: 'CM-1:b', severity: 'caution', title: 'B', group: 'CM-1:case:sleep', group_title: 'Sleep', case_id: 'sleep', crew_id: 'CM-1' },
        { id: 'CM-1:c', severity: 'advisory', title: 'C', group: 'CM-1:case:sleep', group_title: 'Sleep', case_id: 'sleep', crew_id: 'CM-1' },
        { id: 'CM-2:vo2', severity: 'caution', title: 'EVA assignment not cleared', crew_id: 'CM-2' },
      ],
    })
    const g = selectAlertGroups(s)
    expect(g.map((x) => [x.id, x.severity, x.alerts.length])).toEqual([
      ['ALL:case:spe', 'warning', 1],
      ['CM-2:vo2', 'caution', 1],
      ['CM-1:case:sleep', 'caution', 3],
    ])
    expect(g[2].title).toBe('Sleep')
    expect(g[1].title).toBe('EVA assignment not cleared')
    expect(selectAnnunciator(s)).toMatchObject({ warning: 1, caution: 2, advisory: 0, unacknowledged: 3 })
    s = missionReducer(s, { type: 'acknowledge', ids: g[2].alerts.map((a) => a.id), t: NOW })
    expect(selectAnnunciator(s).unacknowledged).toBe(2)
    // a new finding joins the group: the line is new again
    s = missionReducer(s, {
      type: 'publishAlerts',
      source: 'mission',
      alerts: [{ id: 'CM-1:d', severity: 'caution', title: 'D', group: 'CM-1:case:sleep', group_title: 'Sleep', case_id: 'sleep', crew_id: 'CM-1' }],
    })
    expect(selectAlertGroups(s).find((x) => x.id === 'CM-1:case:sleep')?.acknowledged).toBe(false)
  })
  it('a manually entered low 24-h urine output updates the renal findings', () => {
    const low: Observation = { crew_id: 'CM-3', variable: 'urine_volume_24h', value: 1200, unit: 'mL', t: NOW - 60, source: 'manual', provenance: 'manual' }
    const before = evaluateMission(INDEX, [], 'mars_surface', NOW).crew['CM-3']
    const after = evaluateMission(INDEX, [low], 'mars_surface', NOW).crew['CM-3']
    expect(before.tierA.find((x) => x.rule.id === 'target_urine_output_24h')!.finding.status).toBe('within')
    const tgt = after.tierA.find((x) => x.rule.id === 'target_urine_output_24h')!.finding
    expect(tgt.status).toBe('outside')
    expect(tgt.severity).toBe('caution') // literature target: capped at caution, never warning
    expect(after.tierB.find((x) => x.indicator.id === 'urine_volume_24h')!.finding.severity).toBe('caution')
    // ... and it reaches the renal case tripwire (the case is in watch)
    const v = view(cases('mars_surface', NOW, [], [low]), 'CM-3', 'renal_stone')
    expect(v.state.tripwire_obs.some((o) => o.t === low.t && o.value === 1200)).toBe(true)
  })
})

describe('case lifecycle (seeded scenario timeline)', () => {
  const list = cases('mars_surface', NOW)
  it('renal (CM-3) opened ~MET day 399 and is in watch with its tripwire armed; the red-flag question was answered first', () => {
    const v = view(list, 'CM-3', 'renal_stone')
    expect(Math.floor(v.state.opened_at! / DAY)).toBe(399)
    expect(v.state.finding?.rule_id).toBe('target_urine_output_24h')
    expect(v.state.status).toBe('watch')
    expect(v.state.reassess_at!).toBeGreaterThan(NOW)
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
    // SPEC 7: the scripted crew answers r4 "no" before the outcome (else required_steps_pending)
    const rf = v.state.spec.red_flag_step_ids
    expect(rf.length).toBeGreaterThan(0)
    for (const id of rf) {
      const done = v.state.steps_done.find((d) => d.step_id === id)!
      expect((done.input as { value: unknown }).value).toBe(false)
    }
    expect(v.state.escalation).toBeNull()
    expect(packetState(v.state).id).toBe('prepared')
  })
  it('renal resolves when the clock passes reassessment (output recovered)', () => {
    const v = view(cases('mars_surface', 414 * DAY + 3600), 'CM-3', 'renal_stone')
    expect(v.state.status).toBe('resolved')
  })
  it('sleep (CM-1) opened by MET day 407 and is acting', () => {
    const v = view(list, 'CM-1', 'sleep_circadian')
    expect(Math.floor(v.state.opened_at! / DAY)).toBeLessThanOrEqual(407)
    expect(v.state.status).toBe('acting')
    expect(v.state.countermeasure_id).toBe('cm_light_schedule')
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
  })
  it('spe_shelter opens for every crewmember when the onboard monitor crosses S3 (Mars)', () => {
    for (const crew of ['CM-1', 'CM-2', 'CM-3', 'CM-4'] as CrewId[]) {
      const v = view(list, crew, 'spe_shelter')
      expect(v.state.status).toBe('detected')
      expect(formatMet(v.state.opened_at!)).toBe('412/14:15:00') // F.6.1 f: no leading zeros in the day field
      expect(v.state.finding?.severity).toBe('warning')
      expect(v.state.finding?.rule_id).toBe('ops_onboard_proton_s3')
    }
    expect(view(cases('iss', NOW), 'CM-1', 'spe_shelter').state.finding?.rule_id).toBe('ops_noaa_s3')
    expect(view(cases('mars_surface', NOW - 3600), 'CM-1', 'spe_shelter').state.status).toBe('idle')
  })
  it('SPE: no outcome until the shelter confirmations are done or declined; the tripwire (T+6 h) escalates to both tiers', () => {
    const key = caseKey('CM-1', 'spe_shelter')
    const ev = (seq: number, event: CaseEventRecord['event']): CaseEventRecord => ({ key, origin: 'user', seq, event })
    const select = ev(1, { type: 'SELECT', t: NOW + 30, countermeasure_id: 'cm_shelter' })
    const early = ev(2, { type: 'OUTCOME', t: NOW + 60, text: 'All four crew in the shelter.' })
    const refused = view(cases('mars_surface', NOW + 120, [select, early]), 'CM-1', 'spe_shelter')
    expect(refused.state.status).toBe('acting')
    expect(refused.state.log[refused.state.log.length - 1].error).toBe('required_steps_pending')

    const spec = refused.state.spec
    const steps = spec.required_step_ids.map((id, i) => {
      const input = spec.step_inputs.find((x) => x.step_id === id)
      return ev(10 + i, { type: 'STEP', t: NOW + 200 + i * 30, step_id: id, input: input ? { variable: input.variable, value: NOW + 180, unit: input.unit } : undefined })
    })
    const outcome = ev(30, { type: 'OUTCOME', t: NOW + 600, text: 'All four crew in the shelter.' })
    const user = [select, ...steps, outcome]
    const watching = view(cases('mars_surface', NOW + 3600, user), 'CM-1', 'spe_shelter')
    expect(watching.state.status).toBe('watch')
    expect(watching.state.tripwire_obs.length).toBeGreaterThan(5)
    expect(packetState(watching.state).id).toBe('prepared') // not released, not escalated
    const judged = view(cases('mars_surface', NOW + 600 + 6 * 3600 + 60, user), 'CM-1', 'spe_shelter')
    expect(judged.state.status).toBe('escalated')
    expect(judged.state.closed_at).toBe(NOW + 600 + 6 * 3600)
    expect(judged.logOrigins).toContain('tick')
    expect(judged.state.escalation?.tiers).toEqual(['crew_medical_officer', 'flight_surgeon'])
    const p = packetState(judged.state)
    expect(p).toMatchObject({ id: 'queued', label: packetStateLabel('queued'), reason: 'escalated', queuedAt: NOW + 600 + 6 * 3600 })
  })
  it('SPE: a declined confirmation (with a reason) settles it, and the release step queues the packet', () => {
    const key = caseKey('CM-2', 'spe_shelter')
    const ev = (seq: number, event: CaseEventRecord['event']): CaseEventRecord => ({ key, origin: 'user', seq, event })
    const base = view(cases('mars_surface', NOW), 'CM-2', 'spe_shelter').state.spec
    const user: CaseEventRecord[] = [
      ev(1, { type: 'SELECT', t: NOW + 30, countermeasure_id: 'cm_shelter' }),
      ...base.required_step_ids.map((id, i) => ev(2 + i, { type: 'DECLINE', t: NOW + 60 + i, step_id: id, reason: 'Crewmember on the other module; confirmed by voice.' })),
      ...base.packet_step_ids.map((id, i) => ev(20 + i, { type: 'STEP', t: NOW + 120 + i, step_id: id })),
    ]
    const v = view(cases('mars_surface', NOW + 300, user), 'CM-2', 'spe_shelter')
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
    expect(v.state.steps_declined.map((d) => d.step_id)).toEqual(base.required_step_ids)
    expect(packetState(v.state)).toMatchObject({ id: 'queued', reason: 'released', queuedAt: NOW + 120 })
  })
})

describe('case instances and single flags (SPEC 7, S4)', () => {
  interface Opening { crew_id: string; case_id: string; day: number; instance: number; opened_by: string; scripted: boolean; single_flag: boolean }
  const OPENINGS = (sim as unknown as { self_check: { case_openings: Opening[] } }).self_check.case_openings
  it('opens every case on the day the generator reports, by the trigger it reports (no hand-typed day)', () => {
    const list = cases('mars_surface', NOW)
    for (const o of OPENINGS) {
      const v = view(list, o.crew_id as CrewId, o.case_id)
      const first = v.instances.find((i) => i.instance === o.instance)
      expect(first, `${o.crew_id} ${o.case_id}`).toBeTruthy()
      expect(Math.floor(((first!.opened_at ?? 0) - 1) / DAY), `${o.crew_id} ${o.case_id}`).toBe(o.day)
      expect(first!.opening?.finding.rule_id).toBe(o.opened_by)
    }
  })
  it("CM-1's sleep case is the scripted episode's own case: possibly chance on its first day only, then a run of flags", () => {
    const ep = OPENINGS.find((o) => o.crew_id === 'CM-1' && o.case_id === 'sleep_circadian')!
    expect(ep.scripted).toBe(true)
    const day1 = view(cases('mars_surface', (ep.day + 1) * DAY - 60), 'CM-1', 'sleep_circadian')
    expect(day1.state.instance).toBe(1)
    expect(day1.chance?.text).toBe(`Possibly chance: ${chanceRateOf('sleep_midpoint_shift')!.text}`)
    const now = view(cases('mars_surface', NOW), 'CM-1', 'sleep_circadian')
    expect(now.state.status).toBe('acting')
    expect(now.chance).toBeNull() // cautions on later days: not a single flag any more
  })
  it("CM-3's chance flag: labelled possibly chance (N from the engine), re-measured, and resolved by its tripwire", () => {
    const o = OPENINGS.find((x) => x.crew_id === 'CM-3' && x.case_id === 'sleep_circadian')!
    expect([o.scripted, o.single_flag]).toEqual([false, true])
    const v = view(cases('mars_surface', NOW), 'CM-3', 'sleep_circadian')
    expect(v.chance?.indicatorId).toBe(o.opened_by)
    expect(v.chance?.text).toMatch(/^Possibly chance: about 1 in \d+ days per crewmember would flag like this with no real change$/)
    expect(v.chance?.rate).toEqual(chanceRateOf(o.opened_by))
    // the simulated crew re-measured and logged an outcome before now; the tripwire is armed
    expect(v.state.status).toBe('watch')
    expect(v.state.outcome?.text).toMatch(/^Re-measured on MET days/)
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
    expect(v.logOrigins.filter((x) => x === 'scenario').length).toBeGreaterThan(0)
    // at the reassessment the readings after the outcome keep it clear: resolved, still recorded as a single flag
    const judged = view(cases('mars_surface', v.state.reassess_at!), 'CM-3', 'sleep_circadian')
    expect(judged.state.status).toBe('resolved')
    expect(judged.state.tripwire_result?.tripped).toBe(false)
    expect(judged.instances.map((i) => [i.instance, i.status, !!i.chance])).toEqual([[1, 'resolved', true]])
  })
  it('a resolved chance case opens again as a new instance, and the scripted episode then gets its own case', () => {
    // a chance flag for CM-1 long before the scripted schedule shift (a runtime value, far outside the band)
    const flag: Observation = { crew_id: 'CM-1', variable: 'sleep_midpoint_shift', value: 5, unit: 'h', t: 390 * DAY + 5 * 3600, source: 'band', provenance: 'manual' }
    const v = view(cases('mars_surface', NOW, [], [flag]), 'CM-1', 'sleep_circadian')
    expect(v.state.previous_instances.map((p) => [p.instance, p.status])).toEqual([[1, 'resolved']])
    expect(v.instances[0].chance).not.toBeNull()
    expect(v.state.instance).toBe(2)
    expect(Math.floor(v.state.opened_at! / DAY)).toBe(OPENINGS.find((o) => o.crew_id === 'CM-1' && o.case_id === 'sleep_circadian')!.day)
    expect(v.state.status).toBe('acting')
    expect(v.state.countermeasure_id).toBe('cm_light_schedule')
    expect(v.state.log.filter((l) => l.event === 'OPEN').length).toBe(2)
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
  })
  it('a dismissed case stays dismissed while its episode continues (SPEC 7 re-open hysteresis)', () => {
    const key = caseKey('CM-1', 'sleep_circadian')
    const dismiss: CaseEventRecord = { key, origin: 'user', seq: 1, event: { type: 'DISMISS', t: 404 * DAY + 7 * 3600, reason: 'Known schedule change.' } }
    const v = view(cases('mars_surface', NOW, [dismiss]), 'CM-1', 'sleep_circadian')
    // the midpoint shift flags on every later day of the scripted episode: never 72 h below caution, so no new instance
    expect([v.state.status, v.state.instance, v.state.dismiss_reason]).toEqual(['dismissed', 1, 'Known schedule change.'])
    expect(v.state.previous_instances).toEqual([])
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
  })
  it('an escalation does not reopen its own case while the condition persists (a new episode must start)', () => {
    const key = caseKey('CM-1', 'spe_shelter')
    const ev = (seq: number, event: CaseEventRecord['event']): CaseEventRecord => ({ key, origin: 'user', seq, event })
    const base = view(cases('mars_surface', NOW), 'CM-1', 'spe_shelter').state.spec
    const user = [
      ev(1, { type: 'SELECT', t: NOW + 30, countermeasure_id: 'cm_shelter' }),
      ...base.required_step_ids.map((id, i) => ev(2 + i, { type: 'DECLINE', t: NOW + 60 + i, step_id: id, reason: 'Confirmed by voice.' })),
      ev(30, { type: 'OUTCOME', t: NOW + 600, text: 'All four crew in the shelter.' }),
    ]
    const end = INDEX.replay.last_t!
    const v = view(cases('mars_surface', end, user), 'CM-1', 'spe_shelter')
    const first = v.state.previous_instances[0] ?? (v.state.instance === 1 ? null : undefined)
    const escalatedAt = (first ?? v.state).closed_at!
    expect((first ?? v.state).status).toBe('escalated')
    if (v.state.instance > 1) {
      // reopened: the flux fell below the S3 level after the escalation, and rose again
      const flux = observationsFor(INDEX, [], 'CM-1', 'proton_flux_10mev').filter((o) => o.t > escalatedAt && o.t < v.state.opened_at!)
      expect(flux.some((o) => o.value < 1000)).toBe(true)
      expect(v.state.finding?.value).toBeGreaterThanOrEqual(1000)
    }
    // never while the flux stays at or above S3 right after the escalation
    const soon = view(cases('mars_surface', escalatedAt + 3600, user), 'CM-1', 'spe_shelter')
    const stayed = observationsFor(INDEX, [], 'CM-1', 'proton_flux_10mev').filter((o) => o.t > escalatedAt && o.t <= escalatedAt + 3600)
    if (stayed.every((o) => o.value >= 1000)) expect(soon.state.instance).toBe(1)
  })
})

describe('one packet state and one escalation wording for every view', () => {
  it('reads the packet labels from meta.json and the tiers in order, with the link timing', () => {
    const meta = RULES.meta as unknown as { packet_states: Array<{ id: string; label: string }>; escalation: { tiers: Array<{ id: string; label: string }> } }
    expect(packetStateLabel('prepared')).toBe(meta.packet_states.find((x) => x.id === 'prepared')!.label)
    expect(packetStateLabel('queued')).toBe(meta.packet_states.find((x) => x.id === 'queued')!.label)
    expect(packetState(null).id).toBe('not_open')
    const mars = computeComms(environment('mars_surface'), NOW, { status: 'ready', snapshot: snap('horizons_mars_comms')! }, { status: 'ready', snapshot: SIM })
    const tiers = escalationTiers(mars, NOW)
    expect(tiers.map((x) => x.id)).toEqual(meta.escalation.tiers.map((x) => x.id))
    expect(tiers[0].when).toBe('now')
    expect(tiers[0].crew).toBe(CMO_ID)
    expect(tiers[0].label).toBe(meta.escalation.tiers[0].label)
    expect(tiers[1].when).toMatch(/queued until the link resumes in 11 d 0\d h/)
    const iss = computeComms(environment('iss'), NOW, null)
    expect(escalationTiers(iss, NOW)[1].when).toMatch(/at once: the link is up/)
    const queued = { id: 'queued' as const, label: packetStateLabel('queued'), when: null, queuedAt: NOW, reason: 'released' as const }
    expect(packetDelivery(queued, mars, NOW)).toMatch(/^Sent when the link resumes, in 11 d/)
    expect(packetDelivery(queued, iss, NOW)).toMatch(/^Sent at once/)
    expect(packetDelivery(packetState({ status: 'acting', packet_queued_at: null, escalation: null, spec: { escalation: { ground_packet: true } } } as never), mars, NOW)).toMatch(
      /^Not sent yet: it is queued when the crew releases it or the case escalates/,
    )
  })
  it('names the patient\'s own tier 1: the Commander on the Crew Medical Officer\'s cases, as the engine records it (SPEC 2)', () => {
    const mars = computeComms(environment('mars_surface'), NOW, { status: 'ready', snapshot: snap('horizons_mars_comms')! }, { status: 'ready', snapshot: SIM })
    const cmo = CMO_ID as CrewId
    for (const crew of ['CM-1', 'CM-2', 'CM-3', cmo] as CrewId[]) {
      const t1 = tierOneFor(crew)
      const tiers = escalationTiers(mars, NOW, t1)
      expect(tiers.map((x) => x.tier)).toEqual([1, 2])
      expect([tiers[0].id, tiers[0].crew, tiers[0].label, tiers[0].when]).toEqual([t1.id, t1.crewId, t1.label, 'now'])
      expect(tiers[1]).toEqual(escalationTiers(mars, NOW)[1])
      // the engine's own state for one of this crewmember's cases names the same tier 1
      const v = view(cases('mars_surface', NOW), crew, 'spe_shelter')
      expect([v.state.spec.escalation_tiers?.[0]?.id, v.state.spec.escalation_tiers?.[0]?.crew_id]).toEqual([t1.id, t1.crewId])
    }
    expect([tierOneFor(cmo).backup, tierOneFor(cmo).crewId, tierOneFor('CM-2').crewId]).toEqual([true, 'CM-1', cmo])
  })
})

describe('the seeded crew\'s answers', () => {
  it('become observations (yes/no as 1/0) and reach the renal ground packet as valueBoolean, like a logged answer', () => {
    const schedule = caseSchedule(INDEX, [], 'mars_surface')
    const answers = schedule.answers
    const renal = view(computeCases({ index: INDEX, runtime: [], envId: 'mars_surface', t: NOW, userEvents: [] }, schedule), 'CM-3', 'renal_stone')
    const rf = renal.state.spec.step_inputs.find((x) => renal.state.spec.red_flag_step_ids.includes(x.step_id))!
    const a = answers.find((o) => o.variable === rf.variable)!
    expect(a).toMatchObject({ crew_id: 'CM-3', value: 0, unit: rf.unit, source: 'manual', provenance: 'simulated' })
    expect(a.t).toBe(renal.state.steps_done.find((d) => d.step_id === rf.step_id)!.t)
    // inputs that point at a recorded series add nothing (they are already observations)
    expect(answers.some((o) => o.variable === 'urine_volume_24h' || o.variable === 'pvt_lapses')).toBe(false)
    const b = buildGroundPacket(renal.state, visibleObservations(INDEX, answers, NOW), defaultConsent(), 'mars_surface', NOW, INDEX.epochIso)
    const entry = b.entry.find((e) => e.resource.code.coding[0]?.code === rf.variable)
    expect(entry?.resource.valueBoolean).toBe(false)
  })
})

describe('ground packet', () => {
  it('SPE packet carries the vehicle monitor as scope-vehicle context; mood withheld by default', () => {
    const v = view(cases('mars_surface', NOW), 'CM-1', 'spe_shelter')
    const consent = defaultConsent()
    expect(consentAllows('mood', consent)).toBe(false)
    const b = buildGroundPacket(v.state, visibleObservations(INDEX, [], NOW), consent, 'mars_surface', NOW, INDEX.epochIso)
    expect(b.type).toBe('collection')
    expect(b.entry.length).toBeGreaterThan(100)
    expect(b.entry.every((e) => e.resource.effectiveDateTime.startsWith('2028-03-'))).toBe(true)
    expect(JSON.stringify(b)).toContain('scope-vehicle')
    expect(JSON.stringify(b)).not.toContain('"mood"')
  })
})

describe('comms', () => {
  it('Moon reads the JPL Horizons table; ISS the environments.json envelope', () => {
    const moon = computeComms(environment('lunar_surface'), NOW, { status: 'ready', snapshot: snap('horizons_moon_comms')! }, { status: 'ready', snapshot: SIM })
    expect(moon.basis).toBe('snapshot')
    expect(moon.light_time_source).toBe('table')
    expect(moon.one_way_s!).toBeGreaterThan(1.18)
    expect(moon.one_way_s!).toBeLessThan(1.37)
    expect(moon.blocked).toBe(false)
    const iss = computeComms(environment('iss'), NOW, null)
    expect(iss.light_time_source).toBe('environment_max')
    expect(iss.round_trip_s).toBe(2 * iss.one_way_s!)
  })
  it('Mars at now: LOS (modelled conjunction window), earliest reply after the link is back', () => {
    const mars = computeComms(environment('mars_surface'), NOW, { status: 'ready', snapshot: snap('horizons_mars_comms')! }, { status: 'ready', snapshot: SIM })
    expect(mars.blocked).toBe(true)
    expect(mars.resumes_at).toBe(sim.calendar.window_met!.stop_met_s)
    expect(mars.earliest_reply_s!).toBeGreaterThan(mars.resumes_at! - NOW)
  })
  it('D13: the window is described as modelled, with the fit read from the snapshot', () => {
    const snapData = snap('horizons_mars_comms')!.data as { calibration: { threshold_deg: { value: number }; residual_rms_days: number; residual_max_abs_days: number; n_edges: number } }
    const mars = computeComms(environment('mars_surface'), NOW, { status: 'ready', snapshot: snap('horizons_mars_comms')! }, { status: 'ready', snapshot: SIM })
    expect(mars.windowModel).toEqual({
      thresholdDeg: snapData.calibration.threshold_deg.value,
      rmsDays: snapData.calibration.residual_rms_days,
      maxAbsDays: snapData.calibration.residual_max_abs_days,
      moratoria: snapData.calibration.n_edges / 2,
    })
    const note = windowModelNote(mars.windowModel)
    expect(note).toMatch(/^modelled from JPL Horizons geometry/)
    expect(note).toContain(`RMS ${snapData.calibration.residual_rms_days} d`)
    expect(note).not.toMatch(/real/i)
    expect(computeComms(environment('iss'), NOW, null).windowModel).toBeNull()
  })
})
