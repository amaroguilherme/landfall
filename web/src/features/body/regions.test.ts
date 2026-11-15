// Body map: pure mapping logic (region -> rules / indicators / cases / HRP / OSDR) and the status
// fold. Runs against the real engine/rules/*.json and web/public/data snapshots when present.
import { describe, expect, it } from 'vitest'
import type { Finding, Rule } from '../../app/engine'
import { caseSchedule, computeCases } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import { evaluateMission } from '../../app/evaluate'
import type { CrewEvaluation } from '../../app/evaluate'
import { buildScenarioIndex } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import { CREW_IDS } from '../../app/vocab'
import type { EnvId } from '../../app/vocab'
import { SYMPTOMS } from '../noon-sight/record'
import { capsule } from './Figure'
import { bandFor, outsideRange } from './RefChart'
import type { OsdrAnalyte, OsdrData, OsdrTimepoint } from './RefChart'
import {
  FITNESS_VARIABLES,
  OSDR_PANEL_NAME,
  REGIONS,
  REGION_IDS,
  casesForRegion,
  fieldNamesIn,
  isFitnessRule,
  isRegionId,
  opWords,
  plainWords,
  regionDef,
  regionsForCase,
  ruleApplies,
  rulesForRegion,
  sentencesMatching,
  windowWords,
} from './regions'
import type { RegionId } from './regions'
import { BODY_REGION_RULE, CASES, HAZARDS_META, META_BODY_REGIONS, PACKET_STATES, PERSONAL_INDICATORS, THRESHOLD_RULES, packetStateLabel } from './rules'
import type { CaseDef } from './rules'
import {
  FOOTPRINT_STATUSES,
  caseViewFor,
  defaultRegion,
  fitnessTag,
  footprintFor,
  regionIndicatorRows,
  regionRuleRows,
  summarizeRegion,
  summaryInputs,
} from './status'
import type { RegionState } from './status'

// Frozen snapshots the body map reads (a missing file skips its checks instead of failing).
const SNAPSHOTS = import.meta.glob<unknown>(
  [
    '../../../public/data/hrp_risks.json',
    '../../../public/data/hrp_hazards.json',
    '../../../public/data/sim_crew.json',
    '../../../public/data/swpc_spe_replay.json',
    '../../../public/data/osdr_cbc.json',
    '../../../public/data/osdr_cmp.json',
    '../../../public/data/osdr_cytokines.json',
  ],
  { eager: true, import: 'default' },
)
function snapshot<T>(id: string): T | null {
  const hit = Object.entries(SNAPSHOTS).find(([path]) => path.endsWith(`/${id}.json`))
  return hit ? (hit[1] as T) : null
}

const RULES: Rule[] = (THRESHOLD_RULES ?? []) as Rule[]
const regionsOfRule = (id: string): RegionId[] => {
  const rule = RULES.find((r) => r.id === id)
  if (!rule) return []
  return REGIONS.filter((reg) => rulesForRegion(reg, [rule]).length > 0).map((r) => r.id)
}

describe('region ids', () => {
  it.skipIf(!META_BODY_REGIONS)('are exactly the SPEC 3.4 body regions, in meta.json', () => {
    expect([...REGION_IDS].sort()).toEqual([...(META_BODY_REGIONS ?? [])].sort())
    expect(REGIONS.map((r) => r.id)).toEqual([...REGION_IDS])
  })
  it('isRegionId guards query strings', () => {
    expect(isRegionId('kidneys')).toBe(true)
    expect(isRegionId('liver')).toBe(false)
    expect(isRegionId(undefined)).toBe(false)
    expect(regionDef('heart').label).toMatch(/Heart/)
  })
  it('hazard tags use SPEC hazard ids known to meta.json', () => {
    const known = new Set((HAZARDS_META ?? []).map((h) => h.id))
    for (const r of REGIONS) for (const h of r.hazards) expect(known.has(h), `${r.id}:${h}`).toBe(true)
  })
})

describe.skipIf(!THRESHOLD_RULES)('region -> thresholds.json rules', () => {
  it('maps every Table 4.8-1 organ limit to exactly its organ', () => {
    const t481 = RULES.filter((r) => typeof r.body_region === 'string')
    expect(t481.length).toBeGreaterThan(0)
    for (const r of t481) expect(regionsOfRule(r.id), r.id).toEqual([r.body_region])
    const want: Record<string, RegionId> = { dose_lens: 'eyes', dose_skin: 'skin', dose_bfo: 'blood_forming_organs', dose_circulatory: 'heart', dose_cns: 'brain', dose_cns_z10: 'brain' }
    for (const [variable, region] of Object.entries(want)) {
      const rules = RULES.filter((r) => r.variable === variable)
      expect(rules.length, variable).toBeGreaterThan(0)
      for (const r of rules) expect(regionsOfRule(r.id)).toEqual([region])
    }
  })
  it('lists the VO2max FFD floors on heart, lungs and muscles as the fitness tag (caution at most)', () => {
    for (const id of ['ffd_vo2max_microgravity_eva', 'ffd_vo2max_surface_eva']) {
      expect(regionsOfRule(id).sort()).toEqual(['heart', 'lungs', 'muscles'])
      const rule = RULES.find((r) => r.id === id)!
      expect(rule.category).toBe('FFD')
      expect(isFitnessRule(rule)).toBe(true)
      expect(rule.max_severity).toBe('caution')
      expect(rule.action?.label).toBe('EVA assignment not cleared')
    }
    expect(RULES.filter(isFitnessRule).every((r) => r.variable === 'vo2max')).toBe(true)
  })
  it('puts the [V1 4027] BMD POL rules on the skeleton only', () => {
    const bmd = RULES.filter((r) => r.variable.startsWith('bmd_'))
    expect(bmd.map((r) => r.source && (r.source as { requirement_id?: string }).requirement_id)).toEqual(['V1 4027', 'V1 4027', 'V1 4027'])
    for (const r of bmd) expect(regionsOfRule(r.id)).toEqual(['skeleton'])
  })
  it('puts cabin CO2 on lungs and brain (headache note), suit CO2 on lungs, urine target on kidneys', () => {
    expect(regionsOfRule('pel_cabin_ppco2_1h').sort()).toEqual(['brain', 'lungs'])
    expect(regionDef('brain').ruleNotes?.cabin_ppco2).toMatch(/headache/i)
    expect(regionDef('brain').ruleNotes?.cabin_ppco2).toMatch(/no claim/i)
    expect(regionsOfRule('pel_suit_pico2_contingency')).toEqual(['lungs'])
    expect(regionsOfRule('target_urine_output_24h')).toEqual(['kidneys'])
  })
  it('never attaches OPS scale rules or context (design) rules to an organ', () => {
    for (const r of RULES.filter((x) => x.category === 'OPS' || x.role === 'context')) expect(regionsOfRule(r.id), r.id).toEqual([])
  })
  it('respects applies_to (environment selector flips the VO2max verdict)', () => {
    const micro = RULES.find((r) => r.id === 'ffd_vo2max_microgravity_eva')!
    const surface = RULES.find((r) => r.id === 'ffd_vo2max_surface_eva')!
    expect(ruleApplies(micro, 'iss')).toBe(true)
    expect(ruleApplies(micro, 'mars_surface')).toBe(false)
    expect(ruleApplies(surface, 'mars_surface')).toBe(true)
    expect(ruleApplies({ applies_to: ['*'] }, 'cislunar')).toBe(true)
  })
})

describe.skipIf(!PERSONAL_INDICATORS)('region -> personal.json indicators and measurements', () => {
  const byId = new Map((PERSONAL_INDICATORS ?? []).map((i) => [i.id, i]))
  it('every region indicator exists, and mood is never evaluated on the body map', () => {
    for (const r of REGIONS) {
      for (const id of r.indicators) expect(byId.has(id), `${r.id}:${id}`).toBe(true)
      expect(r.indicators).not.toContain('mood')
    }
  })
  it('measurement routes agree with personal.json devices (band / app / manual)', () => {
    for (const r of REGIONS) {
      for (const m of r.measures) {
        const ind = m.variable ? byId.get(m.variable) : undefined
        if (ind?.device) expect(m.how, `${r.id}:${m.variable}`).toBe(ind.device)
      }
    }
  })
  it('measurement variables are real ids (rules, indicators, simulated series, Noon Sight symptoms or case steps)', () => {
    const sim = snapshot<{ data: { variables: Record<string, unknown> } }>('sim_crew')
    const steps = (CASES ?? []).flatMap((c) => ((c as unknown as { procedure?: Array<{ input?: { variable?: string } }> }).procedure ?? []).map((p) => p.input?.variable))
    const known = new Set<string>([
      ...RULES.map((r) => r.variable),
      ...byId.keys(),
      ...Object.keys(sim?.data.variables ?? {}),
      ...SYMPTOMS.map((x) => `symptom_${x.id}`),
      ...steps.filter((v): v is string => typeof v === 'string'),
    ])
    for (const r of REGIONS) for (const m of r.measures) if (m.variable) expect(known.has(m.variable), `${r.id}:${m.variable}`).toBe(true)
  })
  it('claims manual entry only where LANDFALL has an entry for it', () => {
    // A manual hand-off either reaches a real variable (typed in: Noon Sight or a case step) or says it is not entered.
    for (const r of REGIONS) {
      for (const m of r.measures.filter((x) => x.how === 'manual')) {
        if (m.variable === null) expect(m.via, `${r.id}:${m.label}`).toMatch(/not entered in LANDFALL/)
        else expect(m.via, `${r.id}:${m.label}`).toMatch(/typed in/)
      }
    }
  })
  it('places the blood-forming organs in the spine, pelvis and ribs, and the proton reading on an external monitor', () => {
    const bfo = regionDef('blood_forming_organs')
    expect(bfo.aka).toMatch(/spine, pelvis and ribs/)
    expect(bfo.does).not.toMatch(/breastbone/)
    const p = bfo.measures.find((m) => m.variable === 'proton_flux_10mev')!
    expect(p.via).toMatch(/external space-weather monitor/)
    expect(p.requirement_ids).toContain('V2 6165')
  })
  it('radiation dose is a vehicle hand-off citing [V2 6164], and BMD comes from ground DXA', () => {
    for (const r of REGIONS) {
      for (const m of r.measures.filter((x) => x.variable?.startsWith('dose_'))) {
        expect(m.how).toBe('vehicle')
        expect(m.requirement_ids).toContain('V2 6164')
      }
    }
    for (const m of regionDef('skeleton').measures.filter((x) => x.variable?.startsWith('bmd_'))) expect(m.how).toBe('ground')
    expect(regionDef('kidneys').measures.find((m) => m.variable === 'urine_volume_24h')?.how).toBe('manual')
  })
})

describe.skipIf(!CASES)('region -> cases.json', () => {
  const cases = (CASES ?? []) as CaseDef[]
  it('renal_stone reaches kidneys + skeleton; sleep_circadian the brain; spe_shelter marrow, skin and eyes', () => {
    const c = (id: string) => cases.find((x) => x.id === id)!
    expect(regionsForCase(c('renal_stone'))).toEqual(['kidneys', 'skeleton'])
    expect(regionsForCase(c('sleep_circadian'))).toEqual(['brain'])
    expect(regionsForCase(c('spe_shelter'))).toEqual(expect.arrayContaining(['blood_forming_organs', 'skin', 'eyes']))
    expect(casesForRegion('kidneys', cases).map((x) => x.id)).toEqual(['renal_stone'])
    expect(casesForRegion('lungs', cases)).toEqual([])
  })
  it('every case a region links to has a tripwire text to show', () => {
    for (const r of REGIONS) for (const c of casesForRegion(r.id, cases)) expect(c.tripwire?.text, c.id).toBeTruthy()
  })
  it('reads the ground-packet state labels from meta.json (Prepared, then Queued)', () => {
    expect(PACKET_STATES.map((p) => p.id)).toEqual(['prepared', 'queued'])
    expect(packetStateLabel(null)).toBe('Prepared (held on board)')
    expect(packetStateLabel(35_600_000)).toBe('Queued')
    expect([...FOOTPRINT_STATUSES].sort()).toEqual(['acting', 'detected', 'escalated', 'watch'])
  })
})

describe('HRP and OSDR picks resolve against the frozen snapshots', () => {
  const risks = snapshot<{ data: { risks: Array<{ slug: string; summary: string; detail?: { top_risks_sentences?: string[] } }> } }>('hrp_risks')
  const hazards = snapshot<{ data: { hazards: Array<{ id: string; page?: { lede?: string; key_sentences?: Array<{ sentence: string }> } }> } }>('hrp_hazards')
  it.skipIf(!risks)('every risk slug exists and every anchor finds a verbatim sentence', () => {
    for (const r of REGIONS) {
      for (const pick of r.risks) {
        const risk = risks!.data.risks.find((x) => x.slug === pick.slug)
        expect(risk, `${r.id}:${pick.slug}`).toBeTruthy()
        const pool = [risk!.summary, ...(risk!.detail?.top_risks_sentences ?? [])]
        for (const a of pick.anchors) expect(sentencesMatching(pool, [a]).length, `${r.id}:${pick.slug}:${a}`).toBeGreaterThan(0)
      }
    }
  })
  it.skipIf(!hazards)('every hazard anchor finds a verbatim sentence', () => {
    const snapIds: Record<string, string> = { isolation_confinement: 'isolation_and_confinement', hostile_closed_environment: 'hostile_closed_environments' }
    for (const r of REGIONS) {
      for (const hq of r.hazardQuotes) {
        const hz = hazards!.data.hazards.find((x) => x.id === (snapIds[hq.hazard] ?? hq.hazard))
        expect(hz, `${r.id}:${hq.hazard}`).toBeTruthy()
        const pool = [hz!.page?.lede ?? '', ...(hz!.page?.key_sentences ?? []).map((k) => k.sentence)]
        expect(sentencesMatching(pool, [hq.anchor]).length, `${r.id}:${hq.anchor}`).toBe(1)
      }
    }
  })
  it('every OSDR analyte key exists in its snapshot', () => {
    for (const r of REGIONS) {
      for (const p of r.osdr) {
        const snap = snapshot<{ data: { analytes: Array<{ key: string }> } }>(p.snapshot)
        if (!snap) continue
        expect(snap.data.analytes.some((a) => a.key === p.key), `${r.id}:${p.snapshot}:${p.key}`).toBe(true)
      }
    }
  })
  it('sentencesMatching is case-insensitive and empty anchors match nothing', () => {
    expect(sentencesMatching(['Bones lose mineral.', 'Other.'], ['BONES'])).toEqual(['Bones lose mineral.'])
    expect(sentencesMatching(['a'], [])).toEqual([])
  })
})

// ---- status fold (the organ's fill) ------------------------------------------------------------

const f = (status: Finding['status'], severity: Finding['severity'], label = 'x') => ({ label, finding: { status, severity } })

describe('summarizeRegion', () => {
  it('reports no_data (never nominal) when every finding is insufficient or stale', () => {
    const s = summarizeRegion([f('insufficient_data', 'advisory'), f('stale', 'advisory')])
    expect(s).toMatchObject({ state: 'no_data', severity: null, evaluated: 0, missing: 2, total: 2 })
  })
  it('reports unmonitored when the region has nothing to evaluate', () => {
    expect(summarizeRegion([]).state).toBe('unmonitored')
    expect(summarizeRegion([f('not_applicable', 'nominal'), { label: 'y', finding: null }]).state).toBe('unmonitored')
  })
  it('takes the worst evaluated severity, lists what set it, and counts missing data alongside', () => {
    const s = summarizeRegion([f('within', 'nominal', 'a'), f('insufficient_data', 'advisory', 'b'), f('approaching', 'caution', 'c')])
    expect(s).toMatchObject({ state: 'caution', evaluated: 2, missing: 1, total: 3 })
    expect(s.drivers).toEqual([{ label: 'c', severity: 'caution', status: 'approaching' }])
    expect(summarizeRegion([f('within', 'nominal'), f('insufficient_data', 'advisory')]).state).toBe('nominal')
    expect(summarizeRegion([f('outside', 'warning'), f('approaching', 'caution')]).state).toBe('warning')
  })
  it('never shows an emergency state (LANDFALL never raises Emergency-class alarms)', () => {
    expect(summarizeRegion([f('outside', 'emergency')]).state).toBe('warning')
  })
})

// ---- the real scenario: fills, footprint and the fitness tag (meta.json body_region_rule, D6) -------

const SIM_DATA = snapshot<{ data: SimCrewData }>('sim_crew')?.data ?? null
const REPLAY = snapshot<{ data: SpeReplayData }>('swpc_spe_replay')?.data ?? null

describe.skipIf(!SIM_DATA)('the body map on the frozen scenario (D6)', () => {
  const index = buildScenarioIndex(SIM_DATA!, REPLAY)
  const t = index.nowMet
  const ENVS: EnvId[] = ['iss', 'cislunar', 'lunar_surface', 'mars_surface']
  const evalAt = (envId: EnvId) => evaluateMission(index, [], envId, t)
  const casesAt = (envId: EnvId) => computeCases({ index, runtime: [], envId, t, userEvents: [] }, caseSchedule(index, [], envId))
  const fill = (crew: CrewEvaluation, envId: EnvId, id: RegionId) => {
    const region = regionDef(id)
    return summarizeRegion(summaryInputs(regionRuleRows(region, crew, envId), regionIndicatorRows(region, crew)))
  }

  it('meta.json states the rule the figure follows', () => {
    expect(BODY_REGION_RULE).toMatch(/hatched outline/)
    expect(BODY_REGION_RULE).toMatch(/Only a measured finding for the selected crewmember fills an organ/)
    expect(BODY_REGION_RULE).toMatch(/VO2max is a fitness tag/)
    for (const v of FITNESS_VARIABLES) expect(RULES.some((r) => r.variable === v), v).toBe(true)
  })

  it('fills an organ only from its own measured findings: no organ is ever red, in any environment', () => {
    for (const envId of ENVS) {
      const ev = evalAt(envId)
      for (const crewId of CREW_IDS) {
        for (const region of REGIONS) {
          const ruleRows = regionRuleRows(region, ev.crew[crewId], envId)
          const s = fill(ev.crew[crewId], envId, region.id)
          // The only Warning LANDFALL emits is the S3 storm (OPS), which never joins an organ.
          expect(s.state, `${envId} ${crewId} ${region.id}`).not.toBe('warning')
          for (const r of ruleRows) expect(r.rule.category, r.rule.id).not.toBe('OPS')
        }
      }
    }
  })

  it("keeps CM-2's VO2max off the heart, lungs and muscles: it is the fitness tag, and it flips with the environment", () => {
    const mars = evalAt('mars_surface').crew['CM-2']
    const tag = fitnessTag(mars, 'mars_surface')!
    expect(tag.state).toBe('not_cleared')
    expect(tag.label).toBe('EVA assignment not cleared')
    expect(tag.rule.id).toBe('ffd_vo2max_surface_eva')
    expect(tag.finding.severity).toBe('caution')
    expect(tag.input.value).toBe(35.1)
    expect(tag.action).toMatch(/Crew Medical Officer/)
    for (const id of ['heart', 'lungs', 'muscles'] as RegionId[]) {
      const rows = regionRuleRows(regionDef(id), mars, 'mars_surface')
      expect(rows.some((r) => r.fitness && r.applicable && r.finding.status === 'outside'), id).toBe(true)
      // The organ's fill ignores the fitness row: it is the same as without it.
      const s = fill(mars, 'mars_surface', id)
      expect(s.drivers.some((d) => /VO2max/i.test(d.label)), id).toBe(false)
    }
    const iss = fitnessTag(evalAt('iss').crew['CM-2'], 'iss')!
    expect(iss.rule.id).toBe('ffd_vo2max_microgravity_eva')
    expect(iss.state).toBe('cleared')
    expect(iss.action).toBeNull()
  })

  it('draws the open SPE case as a footprint on its regions for every crewmember, never as a fill', () => {
    const views = casesAt('mars_surface')
    const ev = evalAt('mars_surface')
    const spe = (CASES ?? []).find((c) => c.id === 'spe_shelter')!
    for (const crewId of CREW_IDS) {
      for (const region of REGIONS) {
        const foot = footprintFor(region.id, views, crewId)
        const inSpe = spe.body_regions.includes(region.id)
        expect(foot.some((c) => c.caseId === 'spe_shelter'), `${crewId} ${region.id}`).toBe(inSpe)
      }
      // No organ dose is in the record: the marrow is in the footprint and reads insufficient data.
      expect(fill(ev.crew[crewId], 'mars_surface', 'blood_forming_organs').state).toBe('no_data')
      expect(fill(ev.crew[crewId], 'mars_surface', 'eyes').state).toBe('no_data')
    }
  })

  it("outlines a crewmember's own open cases only", () => {
    const views = casesAt('mars_surface')
    const renalOpen = views.filter((v) => v.caseId === 'renal_stone' && FOOTPRINT_STATUSES.has(v.state.status)).map((v) => v.crewId)
    for (const crewId of CREW_IDS) {
      expect(footprintFor('kidneys', views, crewId).length > 0, crewId).toBe(renalOpen.includes(crewId))
    }
    expect(footprintFor('kidneys', views, 'CM-3').map((c) => c.caseId)).toEqual(renalOpen.includes('CM-3') ? ['renal_stone'] : [])
  })

  it('shows the cuff blood pressure on the heart and the fingerstick glucose on the muscles, as Tier B indicators', () => {
    const ev = evalAt('mars_surface').crew['CM-1']
    expect(regionIndicatorRows(regionDef('heart'), ev).map((r) => r.indicator.id)).toEqual(['resting_hr', 'hrv_sdnn', 'bp_systolic', 'bp_diastolic'])
    const glucose = regionIndicatorRows(regionDef('muscles'), ev)
    expect(glucose.map((r) => r.indicator.id)).toEqual(['glucose'])
    const g = glucose[0]
    expect(g.baselineN).toBe(14)
    expect(g.finding.rci.mdc).toBeGreaterThan(0)
    expect(g.indicator.limit_note?.text).toMatch(/No NASA numeric limit/)
    expect(g.indicator.context?.range).toEqual({ min: 65, max: 99, unit: 'mg/dL' })
    for (const id of ['bp_systolic', 'bp_diastolic', 'glucose']) {
      const ind = (PERSONAL_INDICATORS ?? []).find((i) => i.id === id)!
      expect(ind.device, id).toBe('manual')
      const m = REGIONS.flatMap((r) => r.measures).find((x) => x.variable === id)
      expect(m?.how, id).toBe('manual')
      expect(m?.via, id).toMatch(/vehicle medical kit/)
      expect(m?.via, id).toMatch(/Noon Sight medical-kit step/)
    }
  })
})

// ---- wording and chart helpers -----------------------------------------------------------------------

describe('plain-language helpers', () => {
  it('words the compliant condition and the window', () => {
    expect(opWords('ge')).toBe('at or above')
    expect(opWords('lt')).toBe('below')
    expect(windowWords({ kind: 'cumulative', duration: 'P30D' })).toBe('30-day total')
    expect(windowWords({ kind: 'rolling_mean', duration: 'PT1H' })).toBe('1-hour average')
    expect(windowWords({ kind: 'career' })).toBe('career total')
    expect(windowWords({ kind: 'ratio_to_baseline' })).toMatch(/pre-mission/)
  })
  it('turns a data field name inside running text into plain words, and leaves plain text alone', () => {
    expect(fieldNamesIn("A case's body_regions are its hazard footprint.")).toEqual(['body_regions'])
    expect(plainWords("A case's body_regions are its hazard footprint.")).toBe("A case's body regions are its hazard footprint.")
    expect(plainWords('VO2max is a fitness tag (EVA assignment), not a heart or lung finding.')).toBe(
      'VO2max is a fitness tag (EVA assignment), not a heart or lung finding.',
    )
    expect(fieldNamesIn('Table 4.8-1 (Lens, 30-day), MET 412/14:20:00, ≥10 MeV')).toEqual([])
  })
})

describe('crew-facing text of the body map prints no data field names', () => {
  it.skipIf(!BODY_REGION_RULE)('quotes the meta.json body-region rule in plain words', () => {
    const shown = plainWords(BODY_REGION_RULE!)
    expect(fieldNamesIn(shown)).toEqual([])
    expect(shown).toMatch(/hatched outline/)
    expect(shown).toMatch(/VO2max is a fitness tag/)
  })
  it("words every region's own texts without a field name or a file name", () => {
    for (const r of REGIONS) {
      const texts = [
        r.label,
        r.aka ?? '',
        r.short,
        r.does,
        r.osdrNote ?? '',
        ...Object.values(r.ruleNotes ?? {}),
        ...r.measures.flatMap((m) => [m.label, m.via]),
        ...r.osdr.map((p) => p.why),
      ]
      for (const t of texts) {
        expect(fieldNamesIn(t), `${r.id}: ${t}`).toEqual([])
        expect(t, `${r.id}: ${t}`).not.toMatch(/\.json\b/)
      }
    }
  })
  it('names every Inspiration4 panel it plots, never by its snapshot id', () => {
    for (const p of REGIONS.flatMap((r) => r.osdr)) {
      const name = OSDR_PANEL_NAME[p.snapshot]
      expect(name, p.snapshot).toMatch(/^Inspiration4 /)
      expect(fieldNamesIn(name), p.snapshot).toEqual([])
    }
  })
})

describe('one line per case, even when a case opens again as a new instance', () => {
  const view = (caseId: string, status: string, openedAt: number | null, crewId = 'CM-1') =>
    ({
      key: `${crewId}:${caseId}`,
      crewId,
      caseId,
      def: { id: caseId, title: `Case ${caseId}`, body_regions: ['brain'] },
      state: { status, opened_at: openedAt },
      logOrigins: [],
      opening: null,
    }) as unknown as CaseView
  it('shows the open instance, else the most recently opened one', () => {
    const first = view('sleep_circadian', 'resolved', 100)
    const again = view('sleep_circadian', 'acting', 500)
    expect(caseViewFor([first, again], 'sleep_circadian')).toBe(again)
    expect(caseViewFor([again, first], 'sleep_circadian')).toBe(again)
    const later = view('sleep_circadian', 'dismissed', 900)
    expect(caseViewFor([first, later], 'sleep_circadian')).toBe(later)
    expect(caseViewFor([first], 'renal_stone')).toBeNull()
    expect(caseViewFor([view('renal_stone', 'idle', null)], 'renal_stone')?.state.status).toBe('idle')
  })
  it('outlines a reopened case once, with the state of its open instance', () => {
    const views = [view('sleep_circadian', 'resolved', 100), view('sleep_circadian', 'watch', 500), view('sleep_circadian', 'watch', 500, 'CM-3')]
    expect(footprintFor('brain', views, 'CM-1')).toEqual([{ caseId: 'sleep_circadian', title: 'Case sleep_circadian', status: 'watch' }])
    expect(footprintFor('brain', [view('sleep_circadian', 'resolved', 100)], 'CM-1')).toEqual([])
    expect(footprintFor('kidneys', views, 'CM-1')).toEqual([])
  })
})

describe('OSDR chart helpers', () => {
  const tps: OsdrTimepoint[] = [
    { label: 'L-92', day_offset: -92, anchor: 'launch' },
    { label: 'L-3', day_offset: -3, anchor: 'launch' },
    { label: 'R+1', day_offset: 1, anchor: 'return' },
  ]
  const withRanges: OsdrAnalyte = {
    key: 'creatinine',
    label: 'Creatinine',
    unit: 'mg/dL',
    values: { C003: { 'L-92': 0.7, 'L-3': 0.8, 'R+1': 1.2 } },
    ranges: { C003: { 'L-92': { min: 0.6, max: 1.35 }, 'L-3': { min: 0.6, max: 1.35 }, 'R+1': { min: 0.5, max: 1.1 } } },
  }
  it('keeps the per-sample lab range (never collapsed per subject)', () => {
    const b = bandFor(withRanges, 'C003', tps)
    expect(b.kind).toBe('lab')
    expect(b.ranges.map((r) => r?.max)).toEqual([1.35, 1.35, 1.1])
    expect(outsideRange(1.2, b.ranges[2])).toBe(true)
    expect(outsideRange(1.2, b.ranges[0])).toBe(false)
  })
  it('falls back to the own pre-flight span when no range is published', () => {
    const b = bandFor({ ...withRanges, ranges: null }, 'C003', tps)
    expect(b.kind).toBe('preflight')
    expect(b.ranges[2]).toEqual({ min: 0.7, max: 0.8 })
  })
  it('compares bounds inclusively and one-sided ranges on one bound', () => {
    expect(outsideRange(0.6, { min: 0.6, max: 1.35 })).toBe(false)
    expect(outsideRange(500, { min: 60, max: null })).toBe(false)
    expect(outsideRange(59, { min: 60, max: null })).toBe(true)
    expect(outsideRange(5, null)).toBe(false)
  })
})

describe('figure geometry', () => {
  it('draws closed capsules', () => {
    const d = capsule(10, 10, 10, 50, 5)
    expect(d.startsWith('M5 10')).toBe(true)
    expect(d.trim().endsWith('Z')).toBe(true)
  })
})

describe('defaultRegion', () => {
  const all = (st: RegionState) => Object.fromEntries(REGION_IDS.map((id) => [id, st])) as Record<RegionId, RegionState>
  it('opens on the hero region (marrow, SPE) when every region ties', () => {
    expect(defaultRegion(all('no_data'))).toBe('blood_forming_organs')
  })
  it('opens on the worst region otherwise', () => {
    expect(defaultRegion({ ...all('nominal'), kidneys: 'caution' })).toBe('kidneys')
    expect(defaultRegion({ ...all('no_data'), brain: 'caution', skin: 'warning' })).toBe('skin')
  })
})

describe('Inspiration4 data is read per sample and labelled exactly', () => {
  const cmp = snapshot<{ data: OsdrData }>('osdr_cmp')
  it.skipIf(!cmp)('draws, for every subject and timepoint, the range the lab printed for that very sample', () => {
    const data = cmp!.data
    let checked = 0
    for (const a of data.analytes) {
      if (!a.ranges) continue
      for (const s of data.subjects) {
        const band = bandFor(a, s, data.timepoints)
        data.timepoints.forEach((tp, i) => {
          expect(band.ranges[i] ?? null, `${a.key} ${s} ${tp.label}`).toEqual(a.ranges?.[s]?.[tp.label] ?? null)
          checked += 1
        })
      }
    }
    expect(checked).toBeGreaterThan(100)
    // C003: male-pattern creatinine range before flight, female after (recorded as F): never collapsed.
    const creat = data.analytes.find((x) => x.key === 'creatinine')!
    const b = bandFor(creat, 'C003', data.timepoints)
    const at = (label: string) => b.ranges[data.timepoints.findIndex((tp) => tp.label === label)]
    expect(at('L-92')).not.toEqual(at('R+1'))
    expect(at('L-92')).toEqual(creat.ranges?.C003?.['L-92'])
    expect(at('R+1')).toEqual(creat.ranges?.C003?.['R+1'])
  })

  it('labels OSD-656 as a urine inflammation proteomics panel, never as urine chemistry or stone risk', () => {
    const note = regionDef('kidneys').osdrNote ?? ''
    expect(note).toContain('urine inflammation proteomics panel (NULISA-seq, NPQ units), not urine chemistry')
    for (const r of REGIONS) {
      for (const p of r.osdr) expect(p.snapshot, `${r.id} plots no OSD-656 analyte`).not.toBe('osdr_urine' as never)
    }
  })
})

describe('an unavailable evaluation never blanks the body map', () => {
  it('reads every region as insufficient data, never nominal, when there is no evaluation', () => {
    for (const region of REGIONS) {
      const s = summarizeRegion(summaryInputs(regionRuleRows(region, null, 'mars_surface'), regionIndicatorRows(region, null)))
      expect(['unmonitored', 'no_data']).toContain(s.state)
      expect(s.state).not.toBe('nominal')
    }
    expect(fitnessTag(null, 'mars_surface')).toBeNull()
  })
})
