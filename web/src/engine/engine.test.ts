// The port on the REAL rules (engine/rules/*.json, imported as the browser imports them) and a sync
// check of the constants the port copies from the Python engine. Behaviour itself is proven by the
// shared vectors in conformance.test.ts; these tests guard the parts the vectors do not cover.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BOOLEAN_UNITS,
  ERROR_CODES,
  EngineError,
  LOCAL_DISPLAY,
  MET_UNITS,
  NOAA_S_THRESHOLDS_PFU,
  PRIVATE_VARIABLES,
  RULES,
  UCUM_CODES,
  VITAL_SIGNS,
  buildGroundPacket,
  caseReduce,
  chanceRate,
  commsEta,
  evaluatePersonal,
  evaluateRule,
  getCase,
  getEnvironment,
  getIndicator,
  getRule,
  newCase,
  tCritical,
  thresholdRules,
  triggerLookup,
} from './index'
import type { CaseState, Observation, Rule } from './index'

const NOW = 412 * 86400 + 14 * 3600 + 20 * 60 // MET 0412/14:20:00 (SPEC section 7)
const SIM_EPOCH = '2027-01-31T02:40:00Z' // sim_crew.json data.calendar.met_epoch_utc

function codeOf(f: () => unknown): string | null {
  try {
    f()
    return null
  } catch (e) {
    return e instanceof EngineError ? e.code : `not an EngineError: ${String(e)}`
  }
}

describe('real rules (engine/rules/*.json)', () => {
  const envIds = (RULES.environments?.environments ?? []).map((e) => e.id)

  it('imports all five rules files', () => {
    expect(RULES.environments?.schema).toBe('landfall.environments/1')
    expect(RULES.thresholds?.schema).toBe('landfall.thresholds/1')
    expect(RULES.personal?.schema).toBe('landfall.personal/1')
    expect(RULES.cases?.schema).toMatch(/^landfall\.cases\//)
    expect(RULES.meta?.schema).toMatch(/^landfall\.meta\//)
  })

  it('evaluates every threshold rule in an environment it applies to', () => {
    const rules = thresholdRules(RULES)
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      const env = rule.applies_to.includes('*') ? envIds[0] : rule.applies_to[0]
      const f = evaluateRule(rule, null, env, NOW)
      expect(f.status, rule.id).toBe('insufficient_data')
      expect(f.severity, rule.id).toBe('advisory')
      expect(f.why, rule.id).toMatch(/Basis: /)
    }
  })

  it('validates every personal indicator against the real rci config', () => {
    const cfg = RULES.personal!.rci
    for (const ind of RULES.personal!.indicators) {
      const f = evaluatePersonal(ind, [], null, cfg, NOW)
      expect(f.status, ind.id).toBe('insufficient_data')
      expect(f.private, ind.id).toBe(ind.private === true)
    }
  })

  it('Tier B reads only alpha and the minimum baseline; the critical values quoted in rci.method are the engine\'s', () => {
    const cfg = RULES.personal!.rci
    expect(cfg.alpha_two_tailed).toBe(0.001)
    expect(Object.hasOwn(cfg, 'critical_z')).toBe(false)
    const window = cfg.baseline_window_days as number
    const quoted = [tCritical(cfg.alpha_two_tailed, window - 1), tCritical(cfg.alpha_two_tailed, cfg.min_baseline_n - 1)]
    for (const c of quoted) expect(cfg.method).toContain(String(Math.round(c * 1000) / 1000))
    // reliability_r is non-computational context: a value there changes nothing
    const sleep = getIndicator(RULES, 'sleep_duration')
    const base = [7.1, 6.8, 7.4, 7.0, 6.9, 7.2, 7.3, 7.0]
    const a = evaluatePersonal(sleep, base, 4.5, cfg, NOW)
    const b = evaluatePersonal({ ...sleep, reliability_r: { value: 0.99 } }, base, 4.5, cfg, NOW)
    expect(b).toEqual(a)
    expect(a.rci).toMatchObject({ method: 'crawford_howell_1998', n: 8, df: 7, reliable: true })
  })

  it('PRIVATE_VARIABLES is exactly the private indicators of personal.json', () => {
    const priv = RULES.personal!.indicators.filter((i) => i.private === true).map((i) => i.variable)
    expect([...PRIVATE_VARIABLES].sort()).toEqual(priv.sort())
  })

  it('a non-alerting indicator (mood) shows a reliable change but stays nominal; missing data stays advisory', () => {
    const mood = getIndicator(RULES, 'mood')
    const cfg = RULES.personal!.rci
    const high = [4, 4, 5, 4, 3, 4, 4, 5, 4, 4, 3, 4, 4, 5]
    const low = [2, 2, 3, 2, 1, 2, 2, 3, 2, 2, 1, 2, 2, 3]
    for (const [base, current, direction] of [[high, 1, 'decrease'], [low, 5, 'increase']] as const) {
      const f = evaluatePersonal(mood, base, current, cfg, NOW)
      expect(f.status, direction).toBe('reliable_change')
      expect(f.direction, direction).toBe(direction)
      expect(f.severity, direction).toBe('nominal') // advisory blue would read as an alert
      expect(f.why).toContain('Non-alerting indicator: never alerts.')
    }
    expect(evaluatePersonal(mood, high.slice(0, 4), 1, cfg, NOW)).toMatchObject({ status: 'insufficient_data', severity: 'advisory' })
  })

  it('CM-2 VO2max 35.1 flips with the environment ([V1 4001] vs [V1 4002])', () => {
    const vo2 = thresholdRules(RULES).filter((r) => r.variable === 'vo2max' && r.category === 'FFD')
    const byReq = (id: string): Rule => vo2.find((r) => r.source.requirement_id === id) as Rule
    const micro = byReq('V1 4001')
    const surface = byReq('V1 4002')
    expect(evaluateRule(micro, 35.1, 'iss', NOW)).toMatchObject({ status: 'within', severity: 'nominal' })
    expect(evaluateRule(surface, 35.1, 'iss', NOW).status).toBe('not_applicable')
    // D1: a fitness floor not met is a Caution ("EVA assignment not cleared"), never a Warning
    expect(evaluateRule(surface, 35.1, 'mars_surface', NOW)).toMatchObject({ status: 'outside', severity: 'caution' })
    expect(surface.max_severity).toBe('caution')
    expect(surface.action?.label).toBe('EVA assignment not cleared')
    expect(evaluateRule(micro, 35.1, 'mars_surface', NOW).status).toBe('not_applicable')
  })

  it('opens each real case; the tripwire unit needs triggerLookup(rules)', () => {
    const lookup = triggerLookup(RULES)
    for (const def of RULES.cases!.cases) {
      const st = newCase(def, 'CM-1', lookup)
      expect(st.status, def.id).toBe('idle')
      expect(st.spec.tripwire.condition.unit, def.id).toMatch(/\S/)
    }
    expect(codeOf(() => newCase(getCase(RULES, 'sleep_circadian'), 'CM-1'))).toBe('invalid_case')
  })

  it('every case watches, in every environment, a tripwire rule that applies there (by_env)', () => {
    const lookup = triggerLookup(RULES)
    const rules = new Map(thresholdRules(RULES).map((r) => [r.id, r]))
    for (const def of RULES.cases!.cases) {
      for (const env of envIds) {
        const st = newCase(def, 'CM-1', lookup, env)
        expect(st.spec.env_id, `${def.id} @ ${env}`).toBe(env)
        const ref = st.spec.tripwire.condition.ref_id
        expect(typeof ref, `${def.id} @ ${env}`).toBe('string')
        const rule = rules.get(ref as string)
        if (rule) expect(rule.applies_to.includes('*') || rule.applies_to.includes(env), `${def.id} @ ${env}: ${ref}`).toBe(true)
      }
    }
    const spe = getCase(RULES, 'spe_shelter')
    expect(newCase(spe, 'CM-1', lookup, 'mars_surface').spec.tripwire.condition.ref_id).toBe('ops_onboard_proton_s3')
    expect(newCase(spe, 'CM-1', lookup, 'iss').spec.tripwire.condition.ref_id).toBe('ops_noaa_s3')
    expect(newCase(spe, 'CM-1', lookup).spec.tripwire.condition.ref_id).toBe('ops_noaa_s3') // no env: the base condition
  })

  it('runs the SPE case at Mars on the onboard monitor and escalates at T+6 h on vehicle data', () => {
    const def = getCase(RULES, 'spe_shelter')
    const lookup = triggerLookup(RULES)
    const onboard = thresholdRules(RULES).find((r) => r.id === 'ops_onboard_proton_s3') as Rule
    const finding = evaluateRule(onboard, { variable: 'proton_flux_10mev', value: 1100, unit: 'pfu', t: NOW }, 'mars_surface', NOW)
    expect(finding.severity).toBe('warning') // D1: S3+ with the shelter action is the only Warning
    let s: CaseState = newCase(def, 'CM-1', lookup, 'mars_surface')
    expect(s.spec.tripwire.condition).toMatchObject({ ref_id: 'ops_onboard_proton_s3', variable: 'proton_flux_10mev', unit: 'pfu' })
    expect(s.spec.required_step_ids).toEqual(['p2', 'p3'])
    s = caseReduce(s, { type: 'OPEN', t: NOW, finding })
    s = caseReduce(s, { type: 'SELECT', t: NOW + 60, countermeasure_id: def.countermeasure!.primary.id })
    // D5: the shelter confirmations are required before an outcome arms the tripwire
    const blocked = caseReduce(s, { type: 'OUTCOME', t: NOW + 600, text: 'Crew in the storm shelter.' })
    expect(blocked.log[blocked.log.length - 1]).toMatchObject({ error: 'required_steps_pending', to: 'acting' })
    s = caseReduce(s, { type: 'STEP', t: NOW + 120, step_id: 'p2' })
    s = caseReduce(s, { type: 'STEP', t: NOW + 180, step_id: 'p3', input: { variable: 'shelter_entry', value: NOW + 170, unit: 'MET', t: NOW + 180 } })
    expect(s.packet_queued_at).toBeNull() // Prepared (held on board)
    s = caseReduce(s, { type: 'STEP', t: NOW + 240, step_id: 'p6' })
    expect(s.packet_queued_at).toBe(NOW + 240) // Queued (crew release)
    s = caseReduce(s, { type: 'OUTCOME', t: NOW + 600, text: 'Crew in the storm shelter.' })
    expect(s.status).toBe('watch')
    const reassess = s.reassess_at as number
    const flux = (dt: number, value: number): Observation => ({
      crew_id: null, // the onboard monitor is a vehicle sensor, shared by every crewmember
      variable: 'proton_flux_10mev',
      value,
      unit: 'pfu',
      t: NOW + 600 + dt,
      source: 'replay',
      provenance: 'simulated',
    })
    const obs = [flux(3600, 1500), flux(7200, 900), flux(10800, 1200)]
    // atomic rejection: a unit mismatch rejects the whole TICK, keeping none of the valid ones before it
    const bad = caseReduce(s, { type: 'TICK', t: NOW + 600 + 10800, observations: [obs[0], { ...obs[1], unit: 'cm-2 s-1 sr-1' }] })
    expect(bad.log).toHaveLength(s.log.length + 1)
    expect(bad.log[bad.log.length - 1]).toMatchObject({ error: 'unit_mismatch', from: 'watch', to: 'watch' })
    expect({ ...bad, log: s.log }).toEqual(s)
    s = caseReduce(s, { type: 'TICK', t: NOW + 600 + 10800, observations: obs })
    expect(s.status).toBe('watch') // two of three are >= 1000 pfu, but it is judged only at T+6 h
    s = caseReduce(s, { type: 'TICK', t: reassess, observations: obs })
    expect(s.status).toBe('escalated')
    expect(s.escalation).toEqual({ t: reassess, reason: 'tripwire', step_id: null, tiers: ['crew_medical_officer', 'flight_surgeon'] })
    expect(s.packet_queued_at).toBe(NOW + 240) // the first queueing time is kept
    const packet = buildGroundPacket(s, obs, {}, 'mars_surface', reassess, SIM_EPOCH)
    expect(packet.entry).toHaveLength(3)
    expect(packet.entry[0].resource.meta?.tag?.map((t) => t.code)).toContain('scope-vehicle')
  })

  it('renal red flag: a "yes" escalates at once to the Crew Medical Officer and queues the packet (D4, D5)', () => {
    const def = getCase(RULES, 'renal_stone')
    const lookup = triggerLookup(RULES)
    const target = thresholdRules(RULES).find((r) => r.id === 'target_urine_output_24h') as Rule
    const finding = evaluateRule(target, { variable: 'urine_volume_24h', value: 1200, unit: 'mL', t: NOW }, 'mars_surface', NOW)
    let s: CaseState = newCase(def, 'CM-3', lookup, 'mars_surface')
    expect([s.spec.required_step_ids, s.spec.red_flag_step_ids]).toEqual([['r4'], ['r4']])
    s = caseReduce(s, { type: 'OPEN', t: NOW, finding })
    s = caseReduce(s, { type: 'SELECT', t: NOW + 60, countermeasure_id: 'cm_hydration' })
    const unanswered = caseReduce(s, { type: 'STEP', t: NOW + 90, step_id: 'r4' })
    expect(unanswered.log[unanswered.log.length - 1].error).toBe('invalid_event')
    const no = caseReduce(s, { type: 'STEP', t: NOW + 90, step_id: 'r4', input: { variable: 'renal_symptoms', value: 0, unit: 'yes/no' } })
    expect(no.status).toBe('acting')
    const declined = caseReduce(s, { type: 'DECLINE', t: NOW + 90, step_id: 'r4', reason: 'CM-3 asleep; ask at wake.' })
    expect(caseReduce(declined, { type: 'OUTCOME', t: NOW + 99, text: 'Hydration plan started.' }).status).toBe('watch')
    const yes = caseReduce(s, { type: 'STEP', t: NOW + 90, step_id: 'r4', input: { variable: 'renal_symptoms', value: 1, unit: 'yes/no' } })
    expect(yes).toMatchObject({ status: 'escalated', closed_at: NOW + 90, packet_queued_at: NOW + 90 })
    expect(yes.escalation).toEqual({ t: NOW + 90, reason: 'red_flag', step_id: 'r4', tiers: ['crew_medical_officer', 'flight_surgeon'] })
    expect(yes.log[yes.log.length - 1].detail).toContain('the Crew Medical Officer, now')
  })

  it('S2/S3: counts are tested on the Anscombe scale; every indicator prints its chance rate (measured where declared)', () => {
    const cfg = RULES.personal!.rci
    for (const ind of RULES.personal!.indicators) {
      expect(ind.transform ?? null, ind.id).toBe(ind.unit === 'count' ? 'anscombe' : null)
      const r = chanceRate(ind, cfg)
      expect(r.basis, ind.id).toBe(ind.chance_rate ? 'measured' : 'nominal')
      expect(r.text, ind.id).toMatch(ind.alerting ? /^about 1 in \d+ days per crewmember would flag like this/ : /^never alerts; /)
    }
    const lapses = getIndicator(RULES, 'pvt_lapses')
    const base = [1, 0, 2, 1, 1, 0, 3, 1, 0, 1, 2, 1, 0, 1]
    const f = evaluatePersonal(lapses, base, 6, cfg, NOW)
    expect([f.value, f.rci.transform, f.rci.current]).toEqual([6, 'anscombe', 2 * Math.sqrt(6.375)])
    expect(f.band!.high).toBeGreaterThan(f.baseline_mean as number) // the band is printed in lapses
    expect(f.limit).toBe(f.band!.high)
  })

  it('S4: a resolved sleep case opens again as instance 2 on a new episode (real rules)', () => {
    const def = getCase(RULES, 'sleep_circadian')
    const cfg = RULES.personal!.rci
    const mid = getIndicator(RULES, 'sleep_midpoint_shift')
    const base = [0.12, -0.35, 0.4, -0.08, 0.0, 0.27, -0.5, 0.15, -0.22, 0.31, -0.1, 0.05, -0.4, 0.2]
    const chance = evaluatePersonal(mid, base, 2.4, cfg, NOW)
    expect(chance.severity).toBe('caution')
    let s: CaseState = newCase(def, 'CM-3', triggerLookup(RULES), 'mars_surface')
    expect([s.instance, s.previous_instances]).toEqual([1, []])
    s = caseReduce(s, { type: 'OPEN', t: NOW, finding: chance })
    s = caseReduce(s, { type: 'SELECT', t: NOW + 60, countermeasure_id: def.countermeasure!.primary.id })
    s = caseReduce(s, { type: 'OUTCOME', t: NOW + 120, text: 'Re-measured: PVT-B and sleep timing back to usual.' })
    const lapses = (dt: number, value: number): Observation => ({ crew_id: 'CM-3', variable: 'pvt_lapses', value, unit: 'count', t: NOW + 120 + dt })
    s = caseReduce(s, { type: 'TICK', t: s.reassess_at as number, observations: [lapses(86400, 1), lapses(2 * 86400, 0)] })
    expect(s.status).toBe('resolved')
    const resolved = s
    // re-open hysteresis (SPEC 7): a new episode needs the triggers below caution for the case's reassessment time
    const again = { type: 'OPEN' as const, t: NOW + 10 * 86400, finding: { ...chance, t: NOW + 10 * 86400 } }
    expect(caseReduce(resolved, again).log.at(-1)!.error).toBe('invalid_event') // no clear_since
    const flap = caseReduce(resolved, { ...again, clear_since: again.t - 3600 })
    expect([flap.status, flap.instance, flap.log.at(-1)!.error]).toEqual(['resolved', 1, 'trigger_not_clear'])
    s = caseReduce(resolved, { ...again, clear_since: NOW + 86400 })
    expect([s.status, s.instance, s.previous_instances.map((p) => p.status)]).toEqual(['detected', 2, ['resolved']])
    expect(s.log[s.log.length - 1].detail).toMatch(/^opened again by sleep_midpoint_shift \(reliable_change, caution\): instance 2; instance 1 was resolved at MET .*; triggers below caution from MET 413\/14:20:00$/)
  })

  it('the patient is the Crew Medical Officer: tier 1 is the backup, the Commander (meta.json escalation)', () => {
    const meta = (RULES.meta as unknown as { escalation: unknown }).escalation
    const def = getCase(RULES, 'renal_stone')
    const tiers = (crew: string) => newCase(def, crew, triggerLookup(RULES), 'mars_surface', meta).spec.escalation_tiers!
    expect(tiers('CM-4').map((t) => [t.id, t.crew_id, t.instead_of])).toEqual([
      ['backup_medical_officer', 'CM-1', 'crew_medical_officer'],
      ['flight_surgeon', null, null],
    ])
    expect(tiers('CM-2').map((t) => [t.id, t.crew_id])).toEqual([
      ['crew_medical_officer', 'CM-4'],
      ['flight_surgeon', null],
    ])
    const rf = def.procedure!.find((p) => p.red_flag)!
    const finding = evaluateRule(getRule(RULES, 'target_urine_output_24h'), 1300, 'mars_surface', NOW)
    for (const [crew, ids, words] of [
      ['CM-4', ['backup_medical_officer', 'flight_surgeon'], 'tier 1, the Commander (backup for the Crew Medical Officer, who is the patient), now'],
      ['CM-1', ['crew_medical_officer', 'flight_surgeon'], 'tier 1, the Crew Medical Officer, now'],
    ] as const) {
      let s = newCase(def, crew, triggerLookup(RULES), 'mars_surface', meta)
      s = caseReduce(s, { type: 'OPEN', t: NOW, finding })
      s = caseReduce(s, { type: 'SELECT', t: NOW + 60, countermeasure_id: def.countermeasure!.primary.id })
      s = caseReduce(s, { type: 'STEP', t: NOW + 120, step_id: rf.id, input: { variable: 'renal_symptoms', value: true, unit: 'yes/no' } })
      expect([s.status, s.escalation?.tiers]).toEqual(['escalated', ids])
      expect(s.log.at(-1)!.detail).toContain(words)
    }
  })

  it('comms: fixed light time at the ISS; Mars needs the Horizons table', () => {
    expect(commsEta(getEnvironment(RULES, 'iss'), NOW)).toMatchObject({ blocked: false, light_time_source: 'environment_max' })
    expect(codeOf(() => commsEta(getEnvironment(RULES, 'mars_surface'), NOW))).toBe('missing_comms_table')
  })
})

// The port copies these tables from the Python engine; fail loudly if either side changes alone.
describe('constants match the Python engine', () => {
  const py = (file: string): string => readFileSync(new URL(`../../../engine/${file}`, import.meta.url), 'utf8')
  const block = (src: string, name: string): string => {
    const m = new RegExp(`^${name}\\s*=\\s*([({])([\\s\\S]*?)^[)}]`, 'm').exec(src)
    if (m === null) throw new Error(`${name} not found in the Python source`)
    return m[2]
  }
  const strings = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1])

  it('packet.py tables', () => {
    const src = py('packet.py')
    const ucum = [...block(src, 'UCUM_CODES').matchAll(/^\s*"([^"]+)":\s*"([^"]*)",/gm)].map((m) => [m[1], m[2]])
    expect(ucum.length).toBeGreaterThan(10)
    expect(Object.fromEntries(UCUM_CODES)).toEqual(Object.fromEntries(ucum))
    const local = [...block(src, 'LOCAL_DISPLAY').matchAll(/^\s*"([^"]+)":\s*"([^"]*)",/gm)].map((m) => [m[1], m[2]])
    expect(Object.fromEntries(LOCAL_DISPLAY)).toEqual(Object.fromEntries(local))
    const vital = [...block(src, 'VITAL_SIGNS').matchAll(/^\s*"([^"]+)":\s*\(([^)]*)\),/gm)].map((m) => [m[1], strings(m[2])])
    const vs = [...VITAL_SIGNS].map(([k, v]) => [k, [v.code, v.display, v.unit, v.ucum, v.unitDisplay]])
    expect(Object.fromEntries(vs)).toEqual(Object.fromEntries(vital))
    expect(PRIVATE_VARIABLES).toEqual(strings(/^PRIVATE_VARIABLES = \(([^)]*)\)/m.exec(src)![1]))
    expect(BOOLEAN_UNITS).toEqual(strings(/^BOOLEAN_UNITS = \(([^)]*)\)/m.exec(src)![1]))
    expect(MET_UNITS).toEqual(strings(/^MET_UNITS = \(([^)]*)\)/m.exec(src)![1]))
  })

  it('error codes and NOAA thresholds', () => {
    expect([...ERROR_CODES]).toEqual(strings(block(py('errors.py'), 'ERROR_CODES')))
    const noaa = /^NOAA_S_THRESHOLDS_PFU = \(([^)]*)\)/m.exec(py('thresholds.py'))![1]
    expect([...NOAA_S_THRESHOLDS_PFU]).toEqual(noaa.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x) && x > 0))
  })
})
