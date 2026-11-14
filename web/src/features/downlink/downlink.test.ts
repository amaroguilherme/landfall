// Downlink helpers on the REAL frozen snapshots and the REAL engine. Case states are built here
// with newCase/caseReduce (test only; the app reads them from useCases), so these tests do not
// depend on the Tier B statistic.
import { describe, expect, it } from 'vitest'
import { RULES, buildGroundPacket, caseReduce, consentAllows, evaluateRule, getCase, getRule, newCase, triggerLookup } from '../../app/engine'
import type { CaseState, Consent } from '../../app/engine'
import { CASE_DEFS } from '../../app/caseTimeline'
import { defaultConsent } from '../../app/mission'
import { buildScenarioIndex, visibleObservations } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import type { Snapshot } from '../../app/data'
import type { CrewId } from '../../app/vocab'
import {
  casesRequesting,
  entryVariable,
  findRequirement,
  houstonRows,
  knownRows,
  previewBundle,
  sentenceContaining,
  summarizePacket,
  utf8Bytes,
} from './model'

const snaps = import.meta.glob<Snapshot>('../../../public/data/{sim_crew,swpc_spe_replay,std_vol2_requirements}.json', {
  eager: true,
  import: 'default',
})
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))?.[1]
const SIM = snap('sim_crew')!.data as SimCrewData
const REPLAY = snap('swpc_spe_replay')!.data as SpeReplayData
const VOL2 = snap('std_vol2_requirements')!.data
const INDEX = buildScenarioIndex(SIM, REPLAY)
const NOW = INDEX.nowMet
const OBS = visibleObservations(INDEX, [], NOW)
const LOOKUP = triggerLookup(RULES)

function opened(caseId: string, crewId: CrewId, ruleId: string, value: number, unit: string, envId = 'mars_surface'): CaseState {
  const finding = evaluateRule(getRule(RULES, ruleId), { value, unit }, envId, NOW - 600)
  const s = caseReduce(newCase(getCase(RULES, caseId), crewId, LOOKUP), { type: 'OPEN', t: NOW - 600, finding })
  expect(s.status).toBe('detected')
  return s
}

const packet = (s: CaseState, consent: Consent = defaultConsent()) => buildGroundPacket(s, OBS, consent, 'mars_surface', NOW, INDEX.epochIso)

describe('verbatim requirement text from the Vol 2 snapshot', () => {
  it('[V2 6164]: the clause about alerting operations teams is one whole sentence of the rationale', () => {
    const r = findRequirement(VOL2, 'V2 6164')!
    expect(r.id).toBe('[V2 6164]')
    const clause = sentenceContaining(r.rationale, 'upon being restored')!
    expect(r.rationale).toContain(clause)
    expect(clause).toMatch(/^The systems must alert operations teams if communication is available or upon being restored\.$/)
  })
  it('[V2 10125] is found by either id form and is the protection-of-private-data requirement', () => {
    const r = findRequirement(VOL2, '[V2 10125]')!
    expect(r).toBe(findRequirement(VOL2, 'V2 10125'))
    expect(r.text).toContain('sensitive and private data')
    expect(findRequirement(VOL2, 'V2 99999')).toBeNull()
    expect(findRequirement(null, 'V2 6164')).toBeNull()
    expect(sentenceContaining(null, 'x')).toBeNull()
  })
})

describe('What LANDFALL knows', () => {
  const rows = knownRows(OBS, 'CM-1', INDEX.variables)
  it('holds every own and habitat-sensor observation of the crewmember, and nobody else', () => {
    const mine = OBS.filter((o) => o.crew_id === 'CM-1' || o.crew_id === null)
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(mine.length)
    expect(rows.some((r) => r.last.crew_id !== null && r.last.crew_id !== 'CM-1')).toBe(false)
    for (const r of rows) expect(r.last.t).toBeLessThanOrEqual(NOW)
  })
  it('marks mood private, puts own records before habitat sensors, and labels the proton monitor a replay', () => {
    const mood = rows.find((r) => r.variable === 'mood')!
    expect(mood.private).toBe(true)
    expect(mood.scope).toBe('crew')
    const firstVehicle = rows.findIndex((r) => r.scope === 'vehicle')
    expect(rows.slice(firstVehicle).every((r) => r.scope === 'vehicle')).toBe(true)
    const p = rows.find((r) => r.variable === 'proton_flux_10mev')!
    expect(p.scope).toBe('vehicle')
    expect(p.sources).toContain('replay')
    expect(p.label).toBe(SIM.variables.proton_flux_10mev.label)
  })
})

describe('the packet (engine output) as the Downlink view summarizes it', () => {
  it('SPE shelter: counts, habitat-sensor tags and byte sizes match the bundle exactly', () => {
    const s = opened('spe_shelter', 'CM-1', 'ops_onboard_proton_s3', 1050, 'pfu')
    const b = packet(s)
    const scope = s.spec.escalation!.observations!
    const sum = summarizePacket(b, scope, 'CM-1')
    expect(sum.entries).toBe(b.entry.length)
    expect(sum.byVariable.reduce((n, r) => n + r.count, 0)).toBe(b.entry.length)
    expect(sum.loinc + sum.local).toBe(b.entry.length)
    const proton = sum.byVariable.find((r) => r.variable === 'proton_flux_10mev')!
    expect(proton.vehicle).toBe(proton.count)
    expect(sum.vehicle).toBe(proton.count)
    expect(sum.compactBytes).toBe(new TextEncoder().encode(JSON.stringify(b)).length)
    expect(JSON.parse(sum.pretty)).toEqual(b)
    expect(sum.prettyBytes).toBe(utf8Bytes(sum.pretty))
    // requested but never recorded in the scenario: shown as "no record yet", never invented
    const rows = houstonRows(scope, defaultConsent(), sum, knownRows(OBS, 'CM-1', INDEX.variables))
    expect(rows.find((r) => r.variable === 'dose_bfo')!.state).toBe('no_record')
    expect(rows.find((r) => r.variable === 'proton_flux_10mev')!.state).toBe('in_packet')
  })

  it('renal: the LOINC vital sign maps back to its variable, and a withheld variable leaves the packet', () => {
    const s = opened('renal_stone', 'CM-3', 'target_urine_output_24h', 1200, 'mL')
    const scope = s.spec.escalation!.observations!
    const full = summarizePacket(packet(s), scope, 'CM-3')
    const hr = full.byVariable.find((r) => r.variable === 'resting_hr')!
    expect(hr.system).toBe('LOINC')
    expect(hr.vitalSign).toBe(true)
    expect(full.byVariable.find((r) => r.variable === 'urine_volume_24h')!.system).toBe('local')
    for (const { resource } of packet(s).entry) expect(scope).toContain(entryVariable(resource, scope, 'CM-3'))

    const consent = { ...defaultConsent(), resting_hr: false }
    const less = summarizePacket(packet(s, consent), scope, 'CM-3')
    expect(less.byVariable.some((r) => r.variable === 'resting_hr')).toBe(false)
    expect(less.entries).toBe(full.entries - hr.count)
    const rows = houstonRows(scope, consent, less, knownRows(OBS, 'CM-3', INDEX.variables))
    const w = rows.find((r) => r.variable === 'resting_hr')!
    expect(w.state).toBe('withheld')
    expect(w.count).toBe(hr.count) // records held on board, none sent
  })

  it('mood: private by default (engine consentAllows), and no case packet asks for it', () => {
    expect(consentAllows('mood', defaultConsent())).toBe(false)
    expect(consentAllows('mood', { ...defaultConsent(), mood: true })).toBe(true)
    expect(casesRequesting('mood', CASE_DEFS)).toEqual(CASE_DEFS.filter((d) => d.escalation?.observations?.includes('mood')))
    expect(casesRequesting('proton_flux_10mev', CASE_DEFS).map((d) => d.id)).toContain('spe_shelter')
  })

  it('previewBundle keeps a valid Bundle with the first n entries', () => {
    const b = packet(opened('spe_shelter', 'CM-2', 'ops_onboard_proton_s3', 1050, 'pfu'))
    const p = previewBundle(b, 3)
    expect(p.entry).toEqual(b.entry.slice(0, 3))
    expect({ ...p, entry: b.entry }).toEqual(b)
    expect(previewBundle(b, b.entry.length + 1)).toBe(b)
  })
})
