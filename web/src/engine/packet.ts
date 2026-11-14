// Delay-tolerant ground packet: a FHIR R4 Bundle (type "collection") of Observations. Port of
// engine/packet.py.
//
// Vital signs use the LOINC codes and UCUM units of the FHIR R4 vital-signs profile
// (https://hl7.org/fhir/R4/observation-vitalsigns.html, checked by the Python module on 2026-11-14).
// Everything else uses the local CodeSystem https://landfall.dev/fhir/CodeSystem/landfall with our
// variable id as the code. No LOINC code is assigned to anything outside that table. Skin
// temperature is deliberately NOT coded as LOINC 8310-5 "Body temperature" (a skin probe is not a
// core temperature).

import { EngineError } from './errors'
import { isNumber, metToIso, parseEpoch, requireNumber } from './fmt'
import { cmpCodePoints, isObj, pyEq, pyGet, pyIn, pyIntStr, pyOr, pyStr } from './py'
import type { JsonObject } from './py'
import type { CaseState, Consent, FhirBundle, FhirCoding, FhirObservation, Observation } from './types'

export const LOCAL_CS = 'https://landfall.dev/fhir/CodeSystem/landfall'
export const CREW_ID_SYSTEM = 'https://landfall.dev/fhir/NamingSystem/crew-id'
export const LOINC = 'http://loinc.org'
export const UCUM = 'http://unitsofmeasure.org'
export const OBS_CATEGORY_CS = 'http://terminology.hl7.org/CodeSystem/observation-category'
export const VITALSIGNS_PROFILE = 'http://hl7.org/fhir/StructureDefinition/vitalsigns'

interface VitalSign {
  code: string
  display: string
  /** the LANDFALL unit the observation must carry */
  unit: string
  ucum: string
  unitDisplay: string
}

/** variable -> LOINC code of the FHIR R4 vital-signs profile. */
export const VITAL_SIGNS: ReadonlyMap<string, VitalSign> = new Map([
  ['resting_hr', { code: '8867-4', display: 'Heart rate', unit: 'bpm', ucum: '/min', unitDisplay: 'beats/minute' }],
  ['heart_rate', { code: '8867-4', display: 'Heart rate', unit: 'bpm', ucum: '/min', unitDisplay: 'beats/minute' }],
  [
    'respiratory_rate',
    { code: '9279-1', display: 'Respiratory rate', unit: 'breaths/min', ucum: '/min', unitDisplay: 'breaths/minute' },
  ],
  ['spo2', { code: '2708-6', display: 'Oxygen saturation in Arterial blood', unit: '%', ucum: '%', unitDisplay: '%' }],
  ['body_temperature', { code: '8310-5', display: 'Body temperature', unit: '°C', ucum: 'Cel', unitDisplay: '°C' }],
  ['body_weight', { code: '29463-7', display: 'Body weight', unit: 'kg', ucum: 'kg', unitDisplay: 'kg' }],
])

/** LANDFALL unit string -> UCUM code. Annotations ({...}) are valid UCUM for unitless counts/scores. */
export const UCUM_CODES: ReadonlyMap<string, string> = new Map([
  ['count', '{count}'],
  ['ms', 'ms'],
  ['h', 'h'],
  ['min', 'min'],
  ['s', 's'],
  ['lux', 'lx'],
  ['bpm', '/min'],
  ['°C', 'Cel'],
  ['mL', 'mL'],
  ['L', 'L'],
  ['mL/day', 'mL/d'],
  ['score_1_5', '{score}'],
  ['mSv', 'mSv'],
  ['mGy', 'mGy'],
  // UCUM has no "Gy-Eq": the {Eq} annotation keeps the unit valid UCUM (= mGy) while the display
  // unit keeps NASA's mGy-Eq (Table 4.8-1). This is our representation, not NASA's.
  ['mGy-Eq', 'mGy{Eq}'],
  ['mSv/day', 'mSv/d'],
  ['mGy/day', 'mGy/d'],
  ['µGy/day', 'uGy/d'],
  ['mmHg', 'mm[Hg]'],
  ['mg/dL', 'mg/dL'],
  ['ml/min/kg', 'mL/min/kg'],
  ['%', '%'],
  ['% of pre-mission', '%'],
  ['kg', 'kg'],
  ['ratio', '1'],
  ['pfu', 'cm-2.s-1.sr-1'],
])

/** Display text for local codes (fallback: the variable id itself). */
export const LOCAL_DISPLAY: ReadonlyMap<string, string> = new Map([
  ['pvt_lapses', 'PVT-B lapses'],
  ['pvt_median_rt', 'PVT-B median reaction time'],
  ['sleep_duration', 'Sleep duration (actigraphy)'],
  ['sleep_midpoint_shift', 'Sleep midpoint shift'],
  ['light_exposure_daytime', 'Daytime light exposure'],
  ['hrv_sdnn', 'Heart rate variability, SDNN'],
  ['skin_temp', 'Skin temperature'],
  ['urine_volume_24h', 'Urine volume, 24 h'],
  ['fluid_intake_24h', 'Fluid intake, 24 h'],
  ['mood', 'Mood self-rating (1-5)'],
  ['proton_flux_10mev', 'Proton flux >=10 MeV'],
  ['career_effective_dose', 'Career effective dose'],
  ['vo2max', 'VO2max'],
  ['cabin_ppco2', 'Cabin ppCO2'],
  ['renal_symptoms', 'Renal symptoms reported (yes/no)'],
  ['shelter_entry', 'Storm shelter entry time'],
  ['dose_bfo', 'Blood-forming organs dose'],
  ['dose_skin', 'Skin dose'],
  ['dose_lens', 'Lens dose'],
  // cuff and glucometer readings are local codes: the FHIR R4 blood-pressure vital sign is a panel
  // (systolic and diastolic as components), not two single-value Observations
  ['bp_systolic', 'Systolic blood pressure (cuff, manual entry)'],
  ['bp_diastolic', 'Diastolic blood pressure (cuff, manual entry)'],
  ['glucose', 'Blood glucose (fingerstick, manual entry)'],
])

/** Variables that need an explicit consent[var] === true (mirrors private: true in personal.json). */
export const PRIVATE_VARIABLES: readonly string[] = ['mood']

// A yes/no answer becomes valueBoolean (value true/false or 1/0); a MET time stamp (e.g. shelter
// entry) becomes valueDateTime via the mission epoch.
export const BOOLEAN_UNITS: readonly string[] = ['yes/no']
export const MET_UNITS: readonly string[] = ['MET']

/** FHIR id [A-Za-z0-9-.]{1,64}; other characters become '-'; the base is cut so `suffix` survives. */
function fhirId(parts: unknown[], suffix = ''): string {
  const raw = parts.map(pyStr).join('-')
  let out = ''
  for (const c of raw) out += /^[A-Za-z0-9.-]$/.test(c) ? c : '-'
  return out.slice(0, 64 - suffix.length) + suffix
}

/** Private variables need consent[var] === true; others are shared unless consent[var] === false. */
export function consentAllows(variable: string, consent: Consent): boolean {
  const c = consent as unknown as JsonObject
  if (PRIVATE_VARIABLES.includes(variable)) return pyGet(c, variable) === true
  return pyGet(c, variable) !== false
}

function observationResource(o: JsonObject, crewId: string, missionEpoch: string, rid: string): FhirObservation {
  const variable = o.variable as string
  const unit = pyGet(o, 'unit')
  const value = o.value
  const vs = VITAL_SIGNS.get(variable)
  const res: JsonObject = { resourceType: 'Observation', id: rid }
  const tags: FhirCoding[] = []
  const provenance = pyGet(o, 'provenance')
  const source = pyGet(o, 'source')
  if (typeof provenance === 'string') tags.push({ system: LOCAL_CS, code: 'provenance-' + provenance })
  if (typeof source === 'string') tags.push({ system: LOCAL_CS, code: 'source-' + source })
  if (pyGet(o, 'crew_id') === null) {
    // vehicle / habitat sensor (crew_id null): placed in this crewmember's packet as exposure
    // context, but it is a reading of the shared environment, not of the crewmember
    tags.push({ system: LOCAL_CS, code: 'scope-vehicle' })
  }
  const meta: JsonObject = {}
  let qty: JsonObject | null
  if (vs !== undefined) {
    if (!pyEq(unit, vs.unit)) {
      throw new EngineError('unit_mismatch', `${variable}: vital-sign unit must be '${vs.unit}', got ${pyStr(unit)}`)
    }
    meta.profile = [VITALSIGNS_PROFILE]
    res.status = 'final'
    res.category = [
      { coding: [{ system: OBS_CATEGORY_CS, code: 'vital-signs', display: 'Vital Signs' }], text: 'Vital Signs' },
    ]
    res.code = { coding: [{ system: LOINC, code: vs.code, display: vs.display }], text: vs.display }
    qty = { value, unit: vs.unitDisplay, system: UCUM, code: vs.ucum }
  } else {
    const display = LOCAL_DISPLAY.get(variable) ?? variable
    res.status = 'final'
    res.code = { coding: [{ system: LOCAL_CS, code: variable, display }], text: display }
    const ucum = typeof unit === 'string' ? UCUM_CODES.get(unit) : undefined
    if (pyIn(unit, BOOLEAN_UNITS) || pyIn(unit, MET_UNITS)) {
      qty = null
    } else if (ucum !== undefined) {
      qty = { value, unit, system: UCUM, code: ucum }
    } else {
      throw new EngineError('unknown_unit', `${variable}: no UCUM mapping for unit ${pyStr(unit)}`)
    }
  }
  if (tags.length) meta.tag = tags
  if (Object.keys(meta).length) res.meta = meta
  // logical reference (no Patient resource: the crew have no PII); the vital-signs profile
  // requires subject 1..1 Reference(Patient), so the target type is stated explicitly
  res.subject = { type: 'Patient', identifier: { system: CREW_ID_SYSTEM, value: crewId }, display: crewId }
  res.effectiveDateTime = metToIso(o.t as number, missionEpoch)
  if (qty !== null) res.valueQuantity = qty
  else if (pyIn(unit, BOOLEAN_UNITS)) res.valueBoolean = value === true || value === 1
  else res.valueDateTime = metToIso(value as number, missionEpoch)
  return res as unknown as FhirObservation
}

/**
 * FHIR R4 Bundle of the crewmember's observations that consent allows (SPEC section 5): this crew's
 * observations plus vehicle observations (crew_id null or absent, tagged scope-vehicle), with
 * obs.t <= t, whose variable is in case_state.spec.escalation.observations (when that list exists).
 * missionEpoch: UTC "YYYY-MM-DDTHH:MM:SSZ" of MET 0. Entries sorted by (t, variable, input order).
 */
export function buildGroundPacket(
  caseState: CaseState,
  observations: readonly Observation[],
  consent: Consent,
  envId: string,
  t: number,
  missionEpoch: string,
): FhirBundle {
  if (!isObj(caseState) || typeof pyGet(caseState, 'crew_id') !== 'string') {
    throw new EngineError('invalid_argument', 'case_state with a crew_id is required')
  }
  if (!Array.isArray(observations)) throw new EngineError('invalid_argument', 'observations must be a list')
  if (!isObj(consent)) throw new EngineError('invalid_argument', 'consent must be an object')
  if (typeof envId !== 'string') throw new EngineError('invalid_argument', 'env_id must be a string')
  requireNumber(t, 't')
  parseEpoch(missionEpoch)
  const cs = caseState as unknown as JsonObject
  const crewId = cs.crew_id as string
  const caseId = pyStr(pyOr(pyGet(cs, 'case_id'), 'none'))
  const spec = pyOr(pyGet(cs, 'spec'), {})
  if (!isObj(spec)) throw new EngineError('invalid_argument', 'case_state.spec must be an object')
  const esc = pyOr(pyGet(spec, 'escalation'), {})
  if (!isObj(esc)) throw new EngineError('invalid_argument', 'case_state.spec.escalation must be an object')
  const scopeRaw = pyGet(esc, 'observations')
  const scope: unknown[] | null = Array.isArray(scopeRaw) ? scopeRaw : null

  const picked: Array<{ t: number; variable: string; idx: number; o: JsonObject }> = []
  ;(observations as readonly unknown[]).forEach((o, idx) => {
    if (!isObj(o)) return
    const oc = pyGet(o, 'crew_id')
    if (oc !== null && !pyEq(oc, crewId)) return // another crewmember; crew_id null = vehicle sensor
    const variable = pyGet(o, 'variable')
    const value = pyGet(o, 'value')
    if (typeof variable !== 'string' || value === null) return
    if (pyIn(pyGet(o, 'unit'), BOOLEAN_UNITS)) {
      if (!(typeof value === 'boolean' || (isNumber(value) && (value === 0 || value === 1)))) {
        throw new EngineError('invalid_argument', `observation ${variable}: yes/no value must be a boolean or 0/1`)
      }
    } else {
      requireNumber(value, `observation ${variable} value`)
    }
    const ot = requireNumber(pyGet(o, 't'), `observation ${variable} t`)
    if (ot > t) return
    if (scope !== null && !pyIn(variable, scope)) return
    if (!consentAllows(variable, consent)) return
    picked.push({ t: ot, variable, idx, o })
  })
  picked.sort((a, b) => a.t - b.t || cmpCodePoints(a.variable, b.variable) || a.idx - b.idx)

  const entries: Array<{ resource: FhirObservation }> = []
  const used = new Set<string>()
  for (const p of picked) {
    const base = [crewId, p.variable, pyIntStr(p.t)]
    let rid = fhirId(base)
    let n = 1
    while (used.has(rid)) {
      // e.g. two readings in the same second, or ids colliding after '_' -> '-'
      n += 1
      rid = fhirId(base, `-${n}`)
    }
    used.add(rid)
    entries.push({ resource: observationResource(p.o, crewId, missionEpoch, rid) })
  }

  const status = pyStr(pyOr(pyGet(cs, 'status'), 'none'))
  return {
    resourceType: 'Bundle',
    id: fhirId(['landfall', caseId, crewId, pyIntStr(t)]),
    meta: {
      tag: [
        { system: LOCAL_CS, code: 'ground-packet' },
        { system: LOCAL_CS, code: 'case-' + caseId },
        { system: LOCAL_CS, code: 'case-status-' + status },
        { system: LOCAL_CS, code: 'environment-' + envId },
      ],
    },
    type: 'collection',
    timestamp: metToIso(t, missionEpoch),
    entry: entries,
  }
}
