// Body regions: the pure mapping from each clickable region of the figure to the rules,
// personal indicators, measurements, HRP pages and Inspiration4 (OSDR) analytes that belong to it.
// No numbers live here: every limit comes from engine/rules/*.json, every quote from the HRP
// snapshots, every lab value from the OSDR snapshots. Region ids are SPEC section 3.4 / meta.json.
import type { Rule } from '../../app/engine'

export const REGION_IDS = [
  'brain',
  'eyes',
  'skin',
  'heart',
  'lungs',
  'blood_forming_organs',
  'kidneys',
  'skeleton',
  'muscles',
  'immune',
] as const
export type RegionId = (typeof REGION_IDS)[number]

export function isRegionId(x: unknown): x is RegionId {
  return typeof x === 'string' && (REGION_IDS as readonly string[]).includes(x)
}

/** SPEC 3.4 hazard ids (meta.json). */
export type HazardId =
  | 'space_radiation'
  | 'isolation_confinement'
  | 'distance_from_earth'
  | 'gravity_fields'
  | 'hostile_closed_environment'

/** meta.json hazards[].hrp_snapshot_id: SPEC hazard id -> id inside hrp_hazards.json. */
export const HAZARD_SNAPSHOT_ID: Record<HazardId, string> = {
  space_radiation: 'space_radiation',
  isolation_confinement: 'isolation_and_confinement',
  distance_from_earth: 'distance_from_earth',
  gravity_fields: 'gravity_fields',
  hostile_closed_environment: 'hostile_closed_environments',
}

/**
 * How a value reaches LANDFALL. `band` and `app` are measured here (LANDFALL BAND, LANDFALL app);
 * everything else is NOT MEASURABLE HERE and arrives through a documented hand-off.
 */
export type MeasureHow = 'band' | 'app' | 'manual' | 'vehicle' | 'lab' | 'ground'

export const MEASURED_HERE: readonly MeasureHow[] = ['band', 'app']

export const HOW_LABEL: Record<MeasureHow, string> = {
  band: 'LANDFALL BAND',
  app: 'LANDFALL app',
  manual: 'Manual entry',
  vehicle: 'Vehicle system',
  lab: 'Laboratory',
  ground: 'Ground',
}

export interface Measure {
  /** Variable id (SPEC 3.3 / thresholds.json) when LANDFALL has one; null for a hand-off-only item. */
  variable: string | null
  label: string
  how: MeasureHow
  /** Plain-English route by which the value reaches LANDFALL, or where it is measured instead. */
  via: string
  requirement_ids?: string[]
}

/** A verbatim pick from hrp_risks.json: the risk (by slug) and sentence anchors (substring match). */
export interface RiskPick {
  slug: string
  /** Sentences of the summary / risk page that contain one of these (case-insensitive). Empty = summary. */
  anchors: string[]
}

/** A verbatim pick from hrp_hazards.json (lede or key sentence containing the anchor). */
export interface HazardPick {
  hazard: HazardId
  anchor: string
}

export interface OsdrPick {
  snapshot: 'osdr_cbc' | 'osdr_cmp' | 'osdr_cytokines'
  key: string
  /** Plain-English reason this analyte belongs to the region. */
  why: string
}

export interface RegionDef {
  id: RegionId
  /** Plain-English name. */
  label: string
  /** Technical name, shown under the label. */
  aka?: string
  /** Short name for tight layouts. */
  short: string
  /** What it does, in plain language for a non-physician CMO ([V2 7045]). LANDFALL's wording. */
  does: string
  /** Hazard tags (LANDFALL's mapping; HRP publishes no organ-to-hazard table). */
  hazards: HazardId[]
  risks: RiskPick[]
  hazardQuotes: HazardPick[]
  /** thresholds.json rules join a region by `body_region` (Table 4.8-1) or by variable. */
  ruleVariables: string[]
  /** Region-specific caveat shown next to a rule, keyed by rule variable. */
  ruleNotes?: Record<string, string>
  /** personal.json indicator ids (Tier B) evaluated for this region. */
  indicators: string[]
  measures: Measure[]
  osdr: OsdrPick[]
  /** Shown when the region has no OSDR analyte, or to qualify the ones it has. */
  osdrNote?: string
}

const V2_6164 = ['V2 6164']

export const REGIONS: readonly RegionDef[] = [
  {
    id: 'brain',
    label: 'Brain and nerves',
    aka: 'Central nervous system (CNS)',
    short: 'Brain',
    does:
      'Your brain and nerves run attention, reaction time, memory and the body clock that sets when you sleep. Sleep loss shows up as slower, less reliable reactions, which the PVT-B reaction test measures.',
    hazards: ['isolation_confinement', 'space_radiation', 'gravity_fields', 'hostile_closed_environment'],
    risks: [
      { slug: 'risk-from-inadequate-sleep-and-irregular-schedules', anchors: ['work overload', 'take a toll'] },
      { slug: 'risk-of-radiation-induced-cancers', anchors: ['central nervous system'] },
      { slug: 'risk-of-spaceflight-associated-neuro-ocular-syndrome-sans', anchors: ['swelling in the brain'] },
    ],
    hazardQuotes: [
      { hazard: 'isolation_confinement', anchor: 'Sleep loss, circadian desynchronization' },
      { hazard: 'space_radiation', anchor: 'damages the central nervous system' },
    ],
    ruleVariables: ['cabin_ppco2'],
    ruleNotes: {
      cabin_ppco2:
        'For the brain this is about headache risk only. LANDFALL makes no claim that CO₂ causes a cognitive deficit.',
    },
    indicators: ['pvt_lapses', 'pvt_median_rt', 'sleep_duration', 'sleep_midpoint_shift', 'light_exposure_daytime'],
    measures: [
      { variable: 'pvt_lapses', label: 'Reaction-time lapses (PVT-B)', how: 'app', via: '3-minute reaction test in the LANDFALL app, at the daily Noon Sight check' },
      { variable: 'pvt_median_rt', label: 'Median reaction time (PVT-B)', how: 'app', via: 'same 3-minute test' },
      { variable: 'sleep_duration', label: 'Sleep duration', how: 'band', via: 'wrist actigraphy (movement), main sleep period' },
      { variable: 'sleep_midpoint_shift', label: 'Sleep timing (midpoint shift)', how: 'band', via: 'wrist actigraphy, compared with your own baseline nights' },
      { variable: 'light_exposure_daytime', label: 'Daytime light at the wrist', how: 'band', via: 'light sensor on the band (not light at the eye)' },
      { variable: 'mood', label: 'Mood (self-rated)', how: 'app', via: 'one-tap private check-in: never alerts, never leaves the device without your consent' },
      { variable: 'cabin_ppco2', label: 'Cabin CO₂ (1-hour mean)', how: 'vehicle', via: 'cabin CO₂ sensor of the vehicle life-support system; the vehicle caution and warning system owns the alarm', requirement_ids: ['V2 6022'] },
      { variable: 'dose_cns', label: 'Brain (CNS) radiation dose', how: 'vehicle', via: 'vehicle radiation monitoring system and ground radiation analysts', requirement_ids: V2_6164 },
      { variable: null, label: 'Circadian phase (melatonin, core temperature)', how: 'ground', via: 'research protocol with ground analysis' },
    ],
    osdr: [],
    osdrNote: 'No Inspiration4 (OSDR) panel in this build measures the brain directly.',
  },
  {
    id: 'eyes',
    label: 'Eyes',
    aka: 'Lens and retina',
    short: 'Eyes',
    does:
      'Your eyes focus light through a clear lens onto the retina. Radiation can cloud the lens (cataract), which is why NASA sets separate lens dose limits; fluid shifting toward the head can change the back of the eye.',
    hazards: ['gravity_fields', 'space_radiation'],
    risks: [
      { slug: 'risk-of-spaceflight-associated-neuro-ocular-syndrome-sans', anchors: ['optic nerve swelling', 'called “spaceflight associated'] },
      { slug: 'risk-of-radiation-induced-cancers', anchors: ['blood vessels and eyes'] },
    ],
    hazardQuotes: [{ hazard: 'gravity_fields', anchor: 'vision issues' }],
    ruleVariables: [],
    indicators: [],
    measures: [
      { variable: 'dose_lens', label: 'Lens radiation dose', how: 'vehicle', via: 'vehicle radiation monitoring system and ground radiation analysts', requirement_ids: V2_6164 },
      { variable: null, label: 'Eye imaging for SANS (optic nerve, retina)', how: 'vehicle', via: 'vehicle medical kit imaging, read with ground guidance' },
    ],
    osdr: [],
    osdrNote: 'No Inspiration4 (OSDR) panel in this build measures the eyes.',
  },
  {
    id: 'skin',
    label: 'Skin',
    short: 'Skin',
    does:
      'Your skin is the outer barrier against germs, heat and cold. NASA sets skin radiation dose limits for it.',
    hazards: ['space_radiation', 'hostile_closed_environment'],
    risks: [
      { slug: 'risk-of-host-microorganism-interactions', anchors: ['skin and in their guts'] },
      { slug: 'risk-of-altered-immune-system-responses', anchors: ['rashes'] },
    ],
    hazardQuotes: [],
    ruleVariables: [],
    indicators: ['skin_temp'],
    measures: [
      { variable: 'skin_temp', label: 'Skin temperature', how: 'band', via: 'temperature sensor on the band, during sleep' },
      { variable: 'dose_skin', label: 'Skin radiation dose', how: 'vehicle', via: 'vehicle radiation monitoring system and ground radiation analysts', requirement_ids: V2_6164 },
      { variable: null, label: 'Rash or irritation', how: 'manual', via: 'what you see, written in the logbook' },
    ],
    osdr: [],
    osdrNote: 'No Inspiration4 (OSDR) panel in this build measures the skin.',
  },
  {
    id: 'heart',
    label: 'Heart and blood vessels',
    aka: 'Circulatory system',
    short: 'Heart',
    does:
      'Your heart and blood vessels carry blood, oxygen and heat around the body and keep your blood pressure up when you stand.',
    hazards: ['gravity_fields', 'space_radiation'],
    risks: [
      { slug: 'risk-of-cardiovascular-adaptations', anchors: ['Low-gravity conditions'] },
      { slug: 'risk-of-radiation-induced-cancers', anchors: ['blood vessels and eyes'] },
      { slug: 'risk-of-reduced-cardiorespiratory-and-musculoskeletal-fitness', anchors: ['cardiopulmonary systems'] },
    ],
    hazardQuotes: [],
    ruleVariables: ['vo2max'],
    indicators: ['resting_hr', 'hrv_sdnn'],
    measures: [
      { variable: 'resting_hr', label: 'Resting heart rate', how: 'band', via: 'band heart sensor, lowest stable 5 minutes of sleep' },
      { variable: 'hrv_sdnn', label: 'Heart rate variability (SDNN)', how: 'band', via: 'band heart sensor, 5-minute windows during sleep' },
      { variable: 'heart_rate', label: 'Heart rate (1-minute)', how: 'band', via: 'band heart sensor, continuous' },
      { variable: null, label: 'Blood pressure', how: 'manual', via: 'cuff from the vehicle medical kit, typed in by the crewmember' },
      { variable: 'vo2max', label: 'Aerobic capacity (VO₂max)', how: 'vehicle', via: 'periodic fitness test on the exercise / metabolic system', requirement_ids: ['V1 4001', 'V1 4002'] },
      { variable: 'dose_circulatory', label: 'Circulatory system radiation dose', how: 'vehicle', via: 'vehicle radiation monitoring system and ground radiation analysts', requirement_ids: V2_6164 },
    ],
    osdr: [],
    osdrNote:
      'The Inspiration4 cardiovascular serum panel (Eve HDCVD9) is not plotted here: it has no reference ranges, and the snapshot flags repeated values in it (haptoglobin) as not plausible independent measurements.',
  },
  {
    id: 'lungs',
    label: 'Lungs',
    short: 'Lungs',
    does:
      'Your lungs bring oxygen into the blood and breathe out carbon dioxide (CO₂), so the air in the cabin or the suit matters directly.',
    hazards: ['hostile_closed_environment', 'gravity_fields'],
    risks: [
      { slug: 'risk-of-injury-and-compromised-performance-from-extravehicular-activity-eva', anchors: ['carbon dioxide'] },
      { slug: 'risk-of-reduced-cardiorespiratory-and-musculoskeletal-fitness', anchors: ['cardiopulmonary systems'] },
    ],
    hazardQuotes: [],
    ruleVariables: ['vo2max', 'cabin_ppco2', 'suit_pico2'],
    indicators: [],
    measures: [
      { variable: 'cabin_ppco2', label: 'Cabin CO₂ (1-hour mean)', how: 'vehicle', via: 'cabin CO₂ sensor of the vehicle life-support system', requirement_ids: ['V2 6022'] },
      { variable: 'suit_pico2', label: 'Suit inspired CO₂', how: 'vehicle', via: 'spacesuit CO₂ monitor', requirement_ids: ['V2 11036'] },
      { variable: 'vo2max', label: 'Aerobic capacity (VO₂max)', how: 'vehicle', via: 'periodic fitness test on the exercise / metabolic system', requirement_ids: ['V1 4001', 'V1 4002'] },
    ],
    osdr: [],
    osdrNote: 'No Inspiration4 (OSDR) panel in this build measures the lungs.',
  },
  {
    id: 'blood_forming_organs',
    label: 'Blood-forming organs',
    aka: 'Bone marrow: breastbone (sternum) and pelvis',
    short: 'Marrow',
    does:
      'The marrow inside your breastbone and pelvis makes red cells (carry oxygen), white cells (fight infection) and platelets (stop bleeding). NASA sets 30-day and 1-year radiation dose limits for it.',
    hazards: ['space_radiation', 'distance_from_earth'],
    risks: [{ slug: 'risk-of-radiation-induced-cancers', anchors: ['certain cancers'] }],
    hazardQuotes: [{ hazard: 'space_radiation', anchor: 'Radiation exposure increases cancer risk' }],
    ruleVariables: [],
    indicators: [],
    measures: [
      { variable: 'proton_flux_10mev', label: 'Solar protons ≥10 MeV', how: 'vehicle', via: 'onboard proton monitor (in this scenario, a time-shifted replay of a real 1989 event)', requirement_ids: V2_6164 },
      { variable: 'dose_bfo', label: 'Blood-forming organ dose', how: 'vehicle', via: 'vehicle radiation monitoring system and ground radiation analysts', requirement_ids: V2_6164 },
      { variable: null, label: 'Blood counts (CBC)', how: 'lab', via: 'blood draw analysed by a laboratory, usually on samples returned to the ground' },
    ],
    osdr: [
      { snapshot: 'osdr_cbc', key: 'white_blood_cell_count', why: 'white cells, made in the marrow' },
      { snapshot: 'osdr_cbc', key: 'hemoglobin', why: 'carried by red cells, made in the marrow' },
      { snapshot: 'osdr_cbc', key: 'platelet_count', why: 'platelets, made in the marrow' },
    ],
  },
  {
    id: 'kidneys',
    label: 'Kidneys',
    short: 'Kidneys',
    does:
      'Your kidneys filter the blood and make urine, which carries away salt, waste and the extra calcium that bone loss releases. When urine output drops, stone-forming minerals concentrate.',
    hazards: ['gravity_fields', 'distance_from_earth'],
    risks: [{ slug: 'risk-of-spaceflight-induced-bone-changes', anchors: [] }],
    hazardQuotes: [{ hazard: 'gravity_fields', anchor: 'kidney stones' }],
    ruleVariables: ['urine_volume_24h'],
    indicators: ['urine_volume_24h', 'fluid_intake_24h'],
    measures: [
      { variable: 'urine_volume_24h', label: '24-h urine output', how: 'manual', via: 'measured by the crewmember and typed in once a day' },
      { variable: 'fluid_intake_24h', label: '24-h fluid intake', how: 'manual', via: 'water dispenser and drink pouches, typed in once a day' },
      { variable: null, label: 'Urine chemistry (calcium, oxalate, citrate, pH)', how: 'ground', via: 'ground laboratory on returned 24-h urine samples' },
      { variable: null, label: 'Kidney stone imaging', how: 'vehicle', via: "the vehicle's in-mission imaging (ultrasound, if one is carried), with ground guidance; [V1 3004](i) requires in-mission imaging but names neither the kidney nor ultrasound", requirement_ids: ['V1 3004'] },
      { variable: null, label: 'Blood kidney markers (creatinine, BUN)', how: 'lab', via: 'blood chemistry panel' },
    ],
    osdr: [
      { snapshot: 'osdr_cmp', key: 'creatinine', why: 'cleared from the blood by the kidneys' },
      { snapshot: 'osdr_cmp', key: 'urea_nitrogen_bun', why: 'cleared from the blood by the kidneys' },
    ],
    osdrNote:
      'The Inspiration4 urine study (OSD-656) is a urine inflammation proteomics panel (NULISA-seq, NPQ units), not urine chemistry, so it is not plotted here and cannot feed the hydration case. That case uses crew-entered 24-h urine output instead.',
  },
  {
    id: 'skeleton',
    label: 'Bones',
    aka: 'Skeleton: hip, lumbar spine, femoral neck',
    short: 'Bones',
    does:
      'Your bones carry your weight and store calcium. Without gravity loading them, weight-bearing bones such as the hips and spine lose mineral, and the calcium released ends up in the urine.',
    hazards: ['gravity_fields'],
    risks: [{ slug: 'risk-of-spaceflight-induced-bone-changes', anchors: ['weight-bearing bones', 'lose between'] }],
    hazardQuotes: [{ hazard: 'gravity_fields', anchor: 'mineral density per month' }],
    ruleVariables: ['bmd_hip_pct_preflight', 'bmd_spine_pct_preflight', 'bmd_femoral_neck_pct_preflight'],
    indicators: [],
    measures: [
      { variable: 'bmd_hip_pct_preflight', label: 'Hip bone density', how: 'ground', via: 'DXA scan before and after flight: there is no DXA on board', requirement_ids: ['V1 4026'] },
      { variable: 'bmd_spine_pct_preflight', label: 'Lumbar spine (L1–L4) bone density', how: 'ground', via: 'DXA scan before and after flight', requirement_ids: ['V1 4026'] },
      { variable: 'bmd_femoral_neck_pct_preflight', label: 'Femoral neck bone density', how: 'ground', via: 'DXA scan before and after flight' },
      { variable: null, label: 'Blood calcium', how: 'lab', via: 'blood chemistry panel' },
    ],
    osdr: [{ snapshot: 'osdr_cmp', key: 'calcium', why: 'bone is the body’s calcium store' }],
  },
  {
    id: 'muscles',
    label: 'Muscles',
    short: 'Muscles',
    does:
      'Your muscles move you and burn blood sugar (glucose) for fuel. With no gravity to work against they lose strength and endurance unless you exercise.',
    hazards: ['gravity_fields'],
    risks: [
      { slug: 'risk-of-reduced-cardiorespiratory-and-musculoskeletal-fitness', anchors: ['weaken the bones, muscles'] },
      { slug: 'risk-of-inadequate-food-and-nutrition', anchors: ['requires adequate nutrition'] },
    ],
    hazardQuotes: [],
    ruleVariables: ['vo2max'],
    indicators: [],
    measures: [
      { variable: 'vo2max', label: 'Aerobic capacity (VO₂max)', how: 'vehicle', via: 'periodic fitness test on the exercise / metabolic system', requirement_ids: ['V1 4001', 'V1 4002'] },
      { variable: null, label: 'Muscle strength', how: 'vehicle', via: 'strength test on the exercise device', requirement_ids: ['V1 4024'] },
      { variable: null, label: 'Blood sugar (glucose), mg/dL', how: 'lab', via: 'blood chemistry panel' },
    ],
    osdr: [{ snapshot: 'osdr_cmp', key: 'glucose', why: 'blood sugar: the fuel muscles burn' }],
  },
  {
    id: 'immune',
    label: 'Immune system',
    aka: 'Lymph nodes and spleen',
    short: 'Immune',
    does:
      'Your immune system (white blood cells, lymph nodes and the spleen) finds and fights infections and keeps dormant viruses in check.',
    hazards: ['space_radiation', 'gravity_fields', 'hostile_closed_environment'],
    risks: [
      { slug: 'risk-of-altered-immune-system-responses', anchors: ['Radiation, microgravity, poor sleep', 'awaken dormant viruses'] },
    ],
    hazardQuotes: [{ hazard: 'hostile_closed_environment', anchor: 'Stress hormone levels can elevate' }],
    ruleVariables: [],
    indicators: [],
    measures: [
      { variable: null, label: 'Body (core) temperature', how: 'manual', via: 'clinical thermometer from the vehicle medical kit; the band’s skin temperature is not core temperature' },
      { variable: null, label: 'White cell counts (CBC)', how: 'lab', via: 'blood draw analysed by a laboratory' },
      { variable: null, label: 'Cytokines and virus reactivation', how: 'ground', via: 'blood, saliva and urine samples returned to the ground' },
    ],
    osdr: [
      { snapshot: 'osdr_cbc', key: 'absolute_lymphocytes', why: 'lymphocytes: the immune system’s targeted responders' },
      { snapshot: 'osdr_cbc', key: 'absolute_neutrophils', why: 'neutrophils: first responders to infection' },
      { snapshot: 'osdr_cytokines', key: 'eve_hd71_il_6', why: 'IL-6: an inflammation signal (research assay, no reference range)' },
    ],
  },
]

export function regionDef(id: RegionId): RegionDef {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[0]
}

// ---------------------------------------------------------------------------------------------
// Rule mapping
// ---------------------------------------------------------------------------------------------

/**
 * Tier A rules that apply to a region: `role: "alert"` rules whose `body_region` is the region
 * (Table 4.8-1 organ limits) or whose variable is listed for it. Context rules (vehicle design
 * requirements) and OPS scale rules are not organ limits and never join a region.
 */
export function rulesForRegion(region: RegionDef, rules: readonly Rule[]): Rule[] {
  return rules.filter((r) => {
    if (r.role !== 'alert' || r.category === 'OPS') return false
    if (r.body_region === region.id) return true
    return region.ruleVariables.includes(r.variable)
  })
}

/** SPEC 3.2: `applies_to` lists environment ids or ["*"]. */
export function ruleApplies(rule: Pick<Rule, 'applies_to'>, envId: string): boolean {
  return rule.applies_to.includes('*') || rule.applies_to.includes(envId)
}

/** Case ids whose `body_regions` include the region (cases.json, SPEC 3.4). */
export function casesForRegion<C extends { id: string; body_regions: string[] }>(regionId: RegionId, cases: readonly C[]): C[] {
  return cases.filter((c) => c.body_regions.includes(regionId))
}

/** Regions reached by a case, in figure order. */
export function regionsForCase(caseDef: { body_regions: string[] }): RegionId[] {
  return REGION_IDS.filter((id) => caseDef.body_regions.includes(id))
}

// ---------------------------------------------------------------------------------------------
// Plain-language rendering helpers for rule fields
// ---------------------------------------------------------------------------------------------

const OP_WORDS: Record<string, string> = {
  ge: 'at or above',
  gt: 'above',
  le: 'at or below',
  lt: 'below',
}

/** "at or above" for op "ge" (the compliant condition, SPEC 3.2). */
export function opWords(op: string): string {
  return OP_WORDS[op] ?? op
}

const UNIT_SPELL: Record<string, string> = { P1D: '24-hour', P30D: '30-day', P1Y: '1-year', PT1H: '1-hour' }

/** Plain-language window: "30-day total", "1-hour average", "career total", "single reading". */
export function windowWords(window: { kind: string; duration?: string | null } | undefined): string {
  if (!window) return ''
  const span = window.duration ? (UNIT_SPELL[window.duration] ?? window.duration) : ''
  switch (window.kind) {
    case 'instant':
      return 'single reading'
    case 'rolling_mean':
      return span ? `${span} average` : 'rolling average'
    case 'cumulative':
      return span ? `${span} total` : 'cumulative'
    case 'career':
      return 'career total'
    case 'ratio_to_baseline':
      return 'compared with your pre-mission value'
    default:
      return window.kind
  }
}

/** Sentences of `text` (split on ". ") that contain any anchor, case-insensitive; [] when none. */
export function sentencesMatching(sentences: readonly string[], anchors: readonly string[]): string[] {
  if (anchors.length === 0) return []
  const lower = anchors.map((a) => a.toLowerCase())
  return sentences.filter((s) => lower.some((a) => s.toLowerCase().includes(a)))
}
