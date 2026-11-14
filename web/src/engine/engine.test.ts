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
  commsEta,
  evaluatePersonal,
  evaluateRule,
  getCase,
  getEnvironment,
  getIndicator,
  newCase,
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

  it('PRIVATE_VARIABLES is exactly the private indicators of personal.json', () => {
    const priv = RULES.personal!.indicators.filter((i) => i.private === true).map((i) => i.variable)
    expect([...PRIVATE_VARIABLES].sort()).toEqual(priv.sort())
  })

  it('a non-alerting indicator (mood) never exceeds advisory', () => {
    const mood = getIndicator(RULES, 'mood')
    const f = evaluatePersonal(mood, [4, 4, 5, 4, 3, 4, 4, 4], 1, RULES.personal!.rci, NOW)
    expect(f.status).toBe('reliable_change')
    expect(f.severity).toBe('advisory')
  })

  it('CM-2 VO2max 35.1 flips with the environment ([V1 4001] vs [V1 4002])', () => {
    const vo2 = thresholdRules(RULES).filter((r) => r.variable === 'vo2max' && r.category === 'FFD')
    const byReq = (id: string): Rule => vo2.find((r) => r.source.requirement_id === id) as Rule
    const micro = byReq('V1 4001')
    const surface = byReq('V1 4002')
    expect(evaluateRule(micro, 35.1, 'iss', NOW)).toMatchObject({ status: 'within', severity: 'nominal' })
    expect(evaluateRule(surface, 35.1, 'iss', NOW).status).toBe('not_applicable')
    expect(evaluateRule(surface, 35.1, 'mars_surface', NOW)).toMatchObject({ status: 'outside', severity: 'warning' })
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

  it('runs the SPE case at Mars on the onboard monitor and escalates at T+6 h on vehicle data', () => {
    const def = getCase(RULES, 'spe_shelter')
    const lookup = triggerLookup(RULES)
    const onboard = thresholdRules(RULES).find((r) => r.id === 'ops_onboard_proton_s3') as Rule
    const finding = evaluateRule(onboard, { variable: 'proton_flux_10mev', value: 1100, unit: 'pfu', t: NOW }, 'mars_surface', NOW)
    expect(finding.severity).toBe('caution')
    let s: CaseState = newCase(def, 'CM-1', lookup)
    s = caseReduce(s, { type: 'OPEN', t: NOW, finding })
    s = caseReduce(s, { type: 'SELECT', t: NOW + 60, countermeasure_id: def.countermeasure!.primary.id })
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
    s = caseReduce(s, { type: 'TICK', t: NOW + 600 + 10800, observations: obs })
    expect(s.status).toBe('watch') // two of three are >= 1000 pfu, but it is judged only at T+6 h
    s = caseReduce(s, { type: 'TICK', t: reassess, observations: obs })
    expect(s.status).toBe('escalated')
    const packet = buildGroundPacket(s, obs, {}, 'mars_surface', reassess, SIM_EPOCH)
    expect(packet.entry).toHaveLength(3)
    expect(packet.entry[0].resource.meta?.tag?.map((t) => t.code)).toContain('scope-vehicle')
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
