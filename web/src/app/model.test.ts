// Mission model on the REAL frozen snapshots (web/public/data) and the REAL rules (engine/rules).
import { describe, expect, it } from 'vitest'
import { RULES, consentAllows, formatMet, getEnvironment, buildGroundPacket } from './engine'
import { aggregateForRule, durationSeconds, evaluateMission, percentOfPreMission } from './evaluate'
import { caseKey, caseSchedule, computeCases } from './caseTimeline'
import type { CaseEventRecord } from './caseTimeline'
import { buildScenarioIndex, observationsFor, replayAfterNow, seriesKey, visibleObservations } from './scenarioData'
import type { SimCrewData, SpeReplayData } from './scenarioData'
import { computeComms } from './comms'
import { defaultConsent } from './mission'
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
      const e = evaluateMission(INDEX, [], env, NOW).crew['CM-2'].tierA
      const surf = e.find((x) => x.rule.id === 'ffd_vo2max_surface_eva')!.finding
      expect(surf.value).toBe(35.1)
      expect(surf.status).toBe('outside')
      expect(surf.severity).toBe('warning')
      expect(e.find((x) => x.rule.id === 'ffd_vo2max_microgravity_eva')!.finding.status).toBe('not_applicable')
    }
  })
  it('uses the FIXED baseline (MET days 368-381) for Tier B', () => {
    const e = evaluateMission(INDEX, [], 'mars_surface', NOW)
    const urine = e.crew['CM-3'].tierB.find((x) => x.indicator.id === 'urine_volume_24h')!
    expect(urine.baseline).toHaveLength(14)
    expect(urine.finding.rci.mean).toBeCloseTo(2852.8571, 3)
    const pvt = e.crew['CM-1'].tierB.find((x) => x.indicator.id === 'pvt_lapses')!
    expect(pvt.finding.status).toBe('reliable_change')
    expect(pvt.finding.severity).toBe('caution')
  })
  it('OPS: onboard monitor at Mars, NOAA S-scale elsewhere; S3 at now; organ doses honestly insufficient', () => {
    const mars = evaluateMission(INDEX, [], 'mars_surface', NOW)
    expect(mars.ops.kind).toBe('onboard_monitor')
    expect(mars.ops.s_level).toBe(3)
    expect(mars.ops.active?.rule.id).toBe('ops_onboard_proton_s3')
    expect(mars.ops.active?.finding.severity).toBe('caution')
    const iss = evaluateMission(INDEX, [], 'iss', NOW)
    expect(iss.ops.kind).toBe('noaa')
    expect(iss.ops.active?.rule.id).toBe('ops_noaa_s3')
    const bfo = mars.crew['CM-1'].tierA.find((x) => x.rule.id === 'pel_t481_bfo_30d')!.finding
    expect(bfo.status).toBe('insufficient_data')
    const career = mars.crew['CM-3'].tierA.find((x) => x.rule.id === 'pel_career_effective_dose')!.finding
    expect(career.status).toBe('within')
  })
  it('annunciator at Mars, now: W = CM-2 FFD; C = S3 + CM-1 sleep findings; no data-quality, context or mood entries', () => {
    const e = evaluateMission(INDEX, [], 'mars_surface', NOW)
    const ids = e.alerts.map((a) => `${a.id}=${a.severity}`).sort()
    expect(ids).toContain('CM-2:ffd_vo2max_surface_eva=warning')
    expect(ids).toContain('ALL:ops_onboard_proton_s3=caution')
    expect(ids.filter((x) => x.startsWith('CM-1:')).every((x) => x.endsWith('=caution'))).toBe(true)
    expect(e.alerts.some((a) => a.id.endsWith(':mood'))).toBe(false)
    expect(e.alerts.some((a) => a.id.includes('ctx_'))).toBe(false)
    expect(e.alerts.filter((a) => a.severity === 'warning')).toHaveLength(1)
    const iss = evaluateMission(INDEX, [], 'iss', NOW)
    expect(iss.alerts.filter((a) => a.severity === 'warning')).toHaveLength(0)
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
  it('renal (CM-3) opened ~MET day 399 and is in watch with its tripwire armed', () => {
    const v = view(list, 'CM-3', 'renal_stone')
    expect(Math.floor(v.state.opened_at! / DAY)).toBe(399)
    expect(v.state.finding?.rule_id).toBe('target_urine_output_24h')
    expect(v.state.status).toBe('watch')
    expect(v.state.reassess_at!).toBeGreaterThan(NOW)
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
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
      expect(formatMet(v.state.opened_at!)).toBe('0412/14:15:00')
      expect(v.state.finding?.rule_id).toBe('ops_onboard_proton_s3')
    }
    expect(view(cases('iss', NOW), 'CM-1', 'spe_shelter').state.finding?.rule_id).toBe('ops_noaa_s3')
    expect(view(cases('mars_surface', NOW - 3600), 'CM-1', 'spe_shelter').state.status).toBe('idle')
  })
  it('SPE tripwire (T+6 h) is judged on the post-now replay: still at S3 -> escalated (stay sheltered)', () => {
    const key = caseKey('CM-1', 'spe_shelter')
    const user: CaseEventRecord[] = [
      { key, origin: 'user', seq: 1, event: { type: 'SELECT', t: NOW + 30, countermeasure_id: 'cm_shelter' } },
      { key, origin: 'user', seq: 2, event: { type: 'OUTCOME', t: NOW + 600, text: 'All four crew in the shelter.' } },
    ]
    const watching = view(cases('mars_surface', NOW + 3600, user), 'CM-1', 'spe_shelter')
    expect(watching.state.status).toBe('watch')
    expect(watching.state.tripwire_obs.length).toBeGreaterThan(5)
    const judged = view(cases('mars_surface', NOW + 600 + 6 * 3600 + 60, user), 'CM-1', 'spe_shelter')
    expect(judged.state.status).toBe('escalated')
    expect(judged.state.closed_at).toBe(NOW + 600 + 6 * 3600)
    expect(judged.logOrigins).toContain('tick')
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
  it('Mars at now: LOS (real conjunction), earliest reply after the link is back', () => {
    const mars = computeComms(environment('mars_surface'), NOW, { status: 'ready', snapshot: snap('horizons_mars_comms')! }, { status: 'ready', snapshot: SIM })
    expect(mars.blocked).toBe(true)
    expect(mars.resumes_at).toBe(sim.calendar.window_met!.stop_met_s)
    expect(mars.earliest_reply_s!).toBeGreaterThan(mars.resumes_at! - NOW)
  })
})
