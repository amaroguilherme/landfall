// Body map: pure mapping logic (region -> rules / indicators / cases / HRP / OSDR) and the status
// fold. Runs against the real engine/rules/*.json and web/public/data snapshots when present.
import { describe, expect, it } from 'vitest'
import type { Finding, Rule } from '../../app/engine'
import { capsule } from './Figure'
import { bandFor, outsideRange } from './RefChart'
import type { OsdrAnalyte, OsdrTimepoint } from './RefChart'
import {
  REGIONS,
  REGION_IDS,
  casesForRegion,
  isRegionId,
  opWords,
  regionDef,
  regionsForCase,
  ruleApplies,
  rulesForRegion,
  sentencesMatching,
  windowWords,
} from './regions'
import type { RegionId } from './regions'
import { CASES, HAZARDS_META, META_BODY_REGIONS, PERSONAL_INDICATORS, THRESHOLD_RULES } from './rules'
import type { CaseDef } from './rules'
import { alertSignals, baselineValues, caseStatus, defaultRegion, latestPoint, summarizeRegion } from './status'
import type { RegionState } from './status'
import type { EvalContext, Evaluator, SimCrewData } from './status'

// Frozen snapshots the body map reads (a missing file skips its checks instead of failing).
const SNAPSHOTS = import.meta.glob<unknown>(
  [
    '../../../public/data/hrp_risks.json',
    '../../../public/data/hrp_hazards.json',
    '../../../public/data/sim_crew.json',
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
  it('puts the VO2max FFD floors on heart, lungs and muscles', () => {
    for (const id of ['ffd_vo2max_microgravity_eva', 'ffd_vo2max_surface_eva']) {
      expect(regionsOfRule(id).sort()).toEqual(['heart', 'lungs', 'muscles'])
      expect(RULES.find((r) => r.id === id)?.category).toBe('FFD')
    }
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
  it('measurement variables are real ids (rules, personal indicators or simulated series)', () => {
    const sim = snapshot<{ data: { variables: Record<string, unknown> } }>('sim_crew')
    const known = new Set<string>([...RULES.map((r) => r.variable), ...byId.keys(), ...Object.keys(sim?.data.variables ?? {})])
    for (const r of REGIONS) for (const m of r.measures) if (m.variable) expect(known.has(m.variable), `${r.id}:${m.variable}`).toBe(true)
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

// ---- status fold -------------------------------------------------------------------------------

const f = (status: Finding['status'], severity: Finding['severity']) => ({ status, severity })

describe('summarizeRegion', () => {
  it('reports no_data (never nominal) when every finding is insufficient or stale', () => {
    const s = summarizeRegion([f('insufficient_data', 'advisory'), f('stale', 'advisory')])
    expect(s).toMatchObject({ state: 'no_data', severity: null, evaluated: 0, missing: 2, total: 2 })
  })
  it('reports unmonitored when the region has nothing to evaluate', () => {
    expect(summarizeRegion([]).state).toBe('unmonitored')
    expect(summarizeRegion([f('not_applicable', 'nominal'), null]).state).toBe('unmonitored')
  })
  it('takes the worst evaluated severity and counts missing data alongside', () => {
    const s = summarizeRegion([f('within', 'nominal'), f('insufficient_data', 'advisory'), f('approaching', 'caution')])
    expect(s).toMatchObject({ state: 'caution', evaluated: 2, missing: 1, total: 3 })
    expect(summarizeRegion([f('within', 'nominal'), f('insufficient_data', 'advisory')]).state).toBe('nominal')
    expect(summarizeRegion([f('outside', 'warning'), f('approaching', 'caution')]).state).toBe('warning')
  })
  it('lets an open case or a published alert raise the region, with its reason', () => {
    const s = summarizeRegion([f('insufficient_data', 'advisory')], [{ severity: 'caution', reason: 'Case open: SPE' }])
    expect(s.state).toBe('caution')
    expect(s.reasons).toEqual(['Case open: SPE'])
  })
  it('never shows an emergency state (LANDFALL never raises Emergency-class alarms)', () => {
    expect(summarizeRegion([f('outside', 'emergency')]).state).toBe('warning')
  })
})

// ---- simulated series ----------------------------------------------------------------------------

const SIM: SimCrewData = {
  crew: [
    {
      crew_id: 'CM-2',
      series: {
        vo2max: { unit: 'ml/min/kg', source: 'vehicle', t: [100, 200, 300], v: [40, null, 35.1] },
        resting_hr: { unit: 'bpm', source: 'band', t: [86_400 * 368, 86_400 * 370, 86_400 * 382], v: [50, 52, 60] },
      },
    },
  ],
  vehicle: { series: { proton_flux_10mev: { unit: 'pfu', source: 'replay', start_t: 1000, step_s: 300, v: [0.1, 5, 1200, null] } } },
}

describe('latestPoint / baselineValues', () => {
  it('returns the latest non-null sample at or before t', () => {
    expect(latestPoint(SIM, 'CM-2', 'vo2max', 250)).toMatchObject({ t: 100, value: 40 })
    expect(latestPoint(SIM, 'CM-2', 'vo2max', 400)).toMatchObject({ t: 300, value: 35.1, unit: 'ml/min/kg' })
    expect(latestPoint(SIM, 'CM-2', 'vo2max', 50)).toBeNull()
    expect(latestPoint(SIM, 'CM-1', 'vo2max', 400)).toBeNull()
    expect(latestPoint(null, 'CM-2', 'vo2max', 400)).toBeNull()
  })
  it('expands vehicle series from start_t + i * step_s and skips gaps', () => {
    expect(latestPoint(SIM, 'CM-2', 'proton_flux_10mev', 1000 + 2 * 300)).toMatchObject({ value: 1200, source: 'replay' })
    expect(latestPoint(SIM, 'CM-2', 'proton_flux_10mev', 99_999)).toMatchObject({ value: 1200 })
  })
  it('lets a newer runtime observation win', () => {
    const extra = [{ crew_id: 'CM-2' as const, variable: 'vo2max', value: 37, unit: 'ml/min/kg', t: 350, source: 'manual' as const, provenance: 'manual' }]
    expect(latestPoint(SIM, 'CM-2', 'vo2max', 400, extra)).toMatchObject({ value: 37, source: 'manual' })
  })
  it('takes the baseline from MET days in the window only', () => {
    expect(baselineValues(SIM, 'CM-2', 'resting_hr', 368, 381)).toEqual([50, 52])
  })
})

// ---- cases and alerts -----------------------------------------------------------------------------

const SPE_CASE: CaseDef = {
  id: 'spe_shelter',
  title: 'Solar particle event: shelter',
  one_line: '',
  hazards: [],
  body_regions: ['blood_forming_organs', 'skin', 'eyes'],
  triggers: [{ kind: 'ops', rule_id: 'ops_onboard_proton_s3' }],
}
const OPS_RULE = {
  id: 'ops_onboard_proton_s3',
  label: 'Onboard monitor at S3',
  variable: 'proton_flux_10mev',
  unit: 'pfu',
  op: 'lt',
  limit: 1000,
  category: 'OPS',
  tier: 'A',
  role: 'alert',
  applies_to: ['mars_surface'],
  window: { kind: 'instant' },
  chip: 'design choice',
  source: { kind: 'design_choice', rationale: 'test' },
} as Rule

function ctxWith(evaluator: Evaluator, envId = 'mars_surface'): EvalContext {
  return { sim: SIM, crewId: 'CM-2', envId, t: 99_999, extra: [], evaluator, rci: null, baselineDays: [368, 381] }
}
const stub: Evaluator = {
  evaluateRule: (rule, value) => ({ rule_id: rule.id, tier: 'A', category: rule.category, status: 'insufficient_data', severity: 'advisory', value, unit: rule.unit, limit: rule.limit, margin: null, chip: rule.chip, source: rule.source, why: [] }),
  evaluatePersonal: () => {
    throw new Error('not used')
  },
}
const fakeEngine: Evaluator = {
  ...stub,
  evaluateRule: (rule, value) => {
    const outside = value !== null && rule.op === 'lt' && !(value < rule.limit)
    return { ...stub.evaluateRule(rule, value, '', 0), status: value === null ? 'insufficient_data' : outside ? 'outside' : 'within', severity: outside ? 'caution' : 'nominal' }
  },
}
const lookups = { rule: (id: string) => (id === OPS_RULE.id ? OPS_RULE : undefined), indicator: () => undefined }

describe('caseStatus', () => {
  it('stays closed while the engine only reports insufficient data (the shim)', () => {
    expect(caseStatus(SPE_CASE, ctxWith(stub), lookups)).toMatchObject({ open: false, severity: null })
  })
  it('opens when a trigger reaches caution, and says why', () => {
    const s = caseStatus(SPE_CASE, ctxWith(fakeEngine), lookups)
    expect(s.open).toBe(true)
    expect(s.severity).toBe('caution')
    expect(s.reasons[0]).toMatch(/Onboard monitor/)
  })
  it('does not evaluate a trigger outside its environment', () => {
    expect(caseStatus(SPE_CASE, ctxWith(fakeEngine, 'iss'), lookups).open).toBe(false)
  })
  it('treats a case the store holds in watch as open', () => {
    expect(caseStatus(SPE_CASE, ctxWith(stub), lookups, { phase: 'watch' })).toMatchObject({ open: true, severity: 'caution' })
    expect(caseStatus(SPE_CASE, ctxWith(stub), lookups, { status: 'resolved' }).open).toBe(false)
  })
})

describe('alertSignals', () => {
  const alerts = [
    { id: 'ALL:ops_onboard_proton_s3', severity: 'caution' as const, title: 'S3 protons: shelter', crew_id: 'ALL' as const, href: '#/case/spe_shelter' },
    { id: 'CM-3:target_urine_output_24h', severity: 'caution' as const, title: 'Low urine', crew_id: 'CM-3' as const },
    { id: 'CM-2:x', severity: 'nominal' as const, title: 'fine', crew_id: 'CM-2' as const, href: '#/case/spe_shelter' },
  ]
  it('matches alerts by case link or rule id, for this crewmember or ALL, ignoring nominal', () => {
    expect(alertSignals(alerts, 'CM-2', new Set(['spe_shelter']), new Set())).toEqual([
      { severity: 'caution', reason: 'Annunciator: S3 protons: shelter', caseId: 'spe_shelter' },
    ])
    expect(alertSignals(alerts, 'CM-3', new Set(), new Set(['target_urine_output_24h']))).toHaveLength(1)
    expect(alertSignals(alerts, 'CM-1', new Set(), new Set(['target_urine_output_24h']))).toHaveLength(0)
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
