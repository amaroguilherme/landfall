// Downlink: pure helpers (no React). What LANDFALL holds for one crewmember, what the engine's
// FHIR R4 ground packet carries, and verbatim requirement text read from the Vol 2 snapshot.
// Nothing here builds a packet or applies consent rules of its own: the bundle comes from the
// engine (useGroundPacket -> buildGroundPacket) and sharing decisions use the engine's
// consentAllows, so this view can never disagree with what would actually be transmitted.
import { LOCAL_CS, LOCAL_DISPLAY, PRIVATE_VARIABLES, RULES, VITAL_SIGNS, consentAllows } from '../../app/engine'
import type { CaseDef, Consent, FhirBundle, FhirObservation } from '../../app/engine'
import { SHAREABLE_VARIABLES } from '../../app/mission'
import type { CrewId, Observation } from '../../app/vocab'

// ---- labels ------------------------------------------------------------------------------------

type VariableMeta = Record<string, { label?: string; cadence?: string; definition?: string } | undefined>

interface IndicatorLike {
  id?: string
  variable?: string
  label?: string
}

const INDICATORS: readonly IndicatorLike[] = Array.isArray((RULES.personal as { indicators?: unknown } | undefined)?.indicators)
  ? ((RULES.personal as { indicators: IndicatorLike[] }).indicators)
  : []

/** Plain-English label: the scenario's own label, then the rules, then the engine's FHIR display. */
export function variableLabel(variable: string, meta?: VariableMeta | null): string {
  return (
    meta?.[variable]?.label ??
    INDICATORS.find((i) => i.variable === variable || i.id === variable)?.label ??
    LOCAL_DISPLAY.get(variable) ??
    VITAL_SIGNS.get(variable)?.display ??
    variable
  )
}

export const isPrivateVariable = (variable: string): boolean => PRIVATE_VARIABLES.includes(variable)

// ---- What LANDFALL knows ------------------------------------------------------------------------

export interface KnownRow {
  variable: string
  label: string
  /** 'vehicle' = habitat / vehicle sensor (crew_id null), shared by every crewmember. */
  scope: 'crew' | 'vehicle'
  count: number
  firstT: number
  last: Observation
  /** Distinct sources (band, app, manual, vehicle, replay, ...), in first-seen order. */
  sources: string[]
  /** Distinct provenances (simulated, replay, measured, ...), in first-seen order. */
  provenances: string[]
  private: boolean
}

const ORDER = SHAREABLE_VARIABLES as readonly string[]

function orderOf(v: string): number {
  const i = ORDER.indexOf(v)
  return i < 0 ? ORDER.length : i
}

/**
 * Every variable LANDFALL holds for one crewmember at the packet time: their own observations
 * plus vehicle / habitat sensors (crew_id null), scenario and runtime entries alike.
 * `observations` must already be limited to t <= packet time (visibleObservations).
 */
export function knownRows(observations: readonly Observation[], crewId: CrewId, meta?: VariableMeta | null): KnownRow[] {
  const rows = new Map<string, KnownRow>()
  for (const o of observations) {
    const own = o.crew_id === crewId
    const vehicle = o.crew_id === null || o.crew_id === undefined
    if (!own && !vehicle) continue
    const key = `${vehicle ? 'vehicle' : 'crew'}|${o.variable}`
    const r = rows.get(key)
    if (!r) {
      rows.set(key, {
        variable: o.variable,
        label: variableLabel(o.variable, meta),
        scope: vehicle ? 'vehicle' : 'crew',
        count: 1,
        firstT: o.t,
        last: o,
        sources: [o.source],
        provenances: [o.provenance],
        private: isPrivateVariable(o.variable),
      })
      continue
    }
    r.count += 1
    if (o.t < r.firstT) r.firstT = o.t
    if (o.t >= r.last.t) r.last = o
    if (!r.sources.includes(o.source)) r.sources.push(o.source)
    if (!r.provenances.includes(o.provenance)) r.provenances.push(o.provenance)
  }
  return [...rows.values()].sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === 'crew' ? -1 : 1) ||
      Number(a.private) - Number(b.private) ||
      orderOf(a.variable) - orderOf(b.variable) ||
      (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0),
  )
}

// ---- the packet (engine output) -----------------------------------------------------------------

export interface PacketVariableRow {
  variable: string
  /** FHIR code.text (the engine's display). */
  display: string
  /** 'LOINC' for the FHIR R4 vital-signs profile codes, 'local' for the LANDFALL CodeSystem. */
  system: 'LOINC' | 'local' | 'other'
  systemUrl: string
  code: string
  vitalSign: boolean
  /** UCUM code of valueQuantity, or 'valueBoolean' / 'valueDateTime'. */
  valueKind: string
  unitDisplay: string | null
  count: number
  vehicle: number
  firstIso: string
  lastIso: string
}

export interface PacketSummary {
  entries: number
  loinc: number
  local: number
  vehicle: number
  /** provenance-* tag -> count (simulated, replay, measured, ...). */
  provenance: Array<[string, number]>
  byVariable: PacketVariableRow[]
  /** UTF-8 bytes of the compact JSON. */
  compactBytes: number
  /** UTF-8 bytes of the pretty-printed JSON (what "Copy packet" puts on the clipboard). */
  prettyBytes: number
  pretty: string
}

const isLoinc = (system: string) => /(^|\/\/)loinc\.org\/?$/.test(system)

function tagCode(r: FhirObservation, prefix: string): string | null {
  const tag = r.meta?.tag?.find((t) => t.system === LOCAL_CS && t.code.startsWith(prefix))
  return tag ? tag.code.slice(prefix.length) : null
}

/**
 * Which LANDFALL variable produced an entry. Local codes ARE the variable id; a LOINC code is
 * mapped back through the engine's VITAL_SIGNS table, and the SPEC resource id
 * `{crew}-{variable}-{t}` breaks a tie when two variables share a LOINC code.
 */
export function entryVariable(r: FhirObservation, scope: readonly string[], crewId: string): string {
  const c = r.code.coding[0]
  if (!c) return r.id
  if (c.system === LOCAL_CS) return c.code
  const pool = scope.length ? scope : [...VITAL_SIGNS.keys()]
  const candidates = pool.filter((v) => VITAL_SIGNS.get(v)?.code === c.code)
  if (candidates.length === 1) return candidates[0]
  const byId = [...candidates].sort((a, b) => b.length - a.length).find((v) => r.id.startsWith(`${crewId}-${v.replace(/_/g, '-')}-`))
  return byId ?? candidates[0] ?? `${c.system}|${c.code}`
}

export function utf8Bytes(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

export function prettyPacket(bundle: FhirBundle): string {
  return JSON.stringify(bundle, null, 2)
}

export function summarizePacket(bundle: FhirBundle, scope: readonly string[], crewId: string): PacketSummary {
  const rows = new Map<string, PacketVariableRow>()
  const prov = new Map<string, number>()
  let loinc = 0
  let local = 0
  let vehicle = 0
  for (const { resource: r } of bundle.entry) {
    const c = r.code.coding[0]
    const system: PacketVariableRow['system'] = !c ? 'other' : c.system === LOCAL_CS ? 'local' : isLoinc(c.system) ? 'LOINC' : 'other'
    if (system === 'LOINC') loinc += 1
    else if (system === 'local') local += 1
    const isVehicle = r.meta?.tag?.some((t) => t.system === LOCAL_CS && t.code === 'scope-vehicle') ?? false
    if (isVehicle) vehicle += 1
    const p = tagCode(r, 'provenance-')
    if (p) prov.set(p, (prov.get(p) ?? 0) + 1)
    const variable = entryVariable(r, scope, crewId)
    const valueKind = r.valueQuantity ? r.valueQuantity.code : r.valueBoolean !== undefined ? 'valueBoolean' : r.valueDateTime !== undefined ? 'valueDateTime' : '—'
    const row = rows.get(variable)
    if (!row) {
      rows.set(variable, {
        variable,
        display: r.code.text,
        system,
        systemUrl: c?.system ?? '',
        code: c?.code ?? '',
        vitalSign: r.category?.some((k) => k.coding.some((x) => x.code === 'vital-signs')) ?? false,
        valueKind,
        unitDisplay: r.valueQuantity?.unit ?? null,
        count: 1,
        vehicle: isVehicle ? 1 : 0,
        firstIso: r.effectiveDateTime,
        lastIso: r.effectiveDateTime,
      })
    } else {
      row.count += 1
      if (isVehicle) row.vehicle += 1
      if (r.effectiveDateTime < row.firstIso) row.firstIso = r.effectiveDateTime
      if (r.effectiveDateTime > row.lastIso) row.lastIso = r.effectiveDateTime
    }
  }
  const pretty = prettyPacket(bundle)
  const order = (v: string) => {
    const i = scope.indexOf(v)
    return i < 0 ? scope.length : i
  }
  return {
    entries: bundle.entry.length,
    loinc,
    local,
    vehicle,
    provenance: [...prov.entries()].sort((a, b) => b[1] - a[1]),
    byVariable: [...rows.values()].sort((a, b) => order(a.variable) - order(b.variable)),
    compactBytes: utf8Bytes(JSON.stringify(bundle)),
    prettyBytes: utf8Bytes(pretty),
    pretty,
  }
}

/** The bundle with only its first `n` entries (a valid Bundle, for the on-screen preview). */
export function previewBundle(bundle: FhirBundle, n: number): FhirBundle {
  return bundle.entry.length <= n ? bundle : { ...bundle, entry: bundle.entry.slice(0, n) }
}

// ---- What Houston sees ----------------------------------------------------------------------------

export type HoustonState = 'in_packet' | 'withheld' | 'no_record'

export interface HoustonRow {
  variable: string
  label: string
  state: HoustonState
  /** Entries in the packet (in_packet), or records held on board (withheld). */
  count: number
  private: boolean
}

/**
 * One row per variable the case asks for (escalation.observations): in the packet, withheld by
 * the crewmember's consent (engine consentAllows), or requested but not in the record yet.
 */
export function houstonRows(
  scope: readonly string[],
  consent: Consent,
  packet: PacketSummary | null,
  known: readonly KnownRow[],
  meta?: VariableMeta | null,
): HoustonRow[] {
  return scope.map((variable) => {
    const held = known.filter((k) => k.variable === variable).reduce((n, k) => n + k.count, 0)
    const sent = packet?.byVariable.find((r) => r.variable === variable)?.count ?? 0
    const state: HoustonState = !consentAllows(variable, consent) ? 'withheld' : sent > 0 ? 'in_packet' : 'no_record'
    return { variable, label: variableLabel(variable, meta), state, count: state === 'withheld' ? held : sent, private: isPrivateVariable(variable) }
  })
}

// ---- the flight surgeon's note (D12) -----------------------------------------------------------------

/** A case's note for the flight surgeon (cases.json escalation.flight_surgeon_note). */
export interface SurgeonNote {
  text: string
  chip?: string
  source?: Record<string, unknown>
}

/**
 * The case's note addressed to the flight surgeon (audience "flight_surgeon"), or null. D12: this is the
 * only place a medication may be named, and only the ground-packet view shows it.
 */
export function surgeonNoteOf(def: { escalation?: unknown } | null): SurgeonNote | null {
  const n = (def?.escalation as { flight_surgeon_note?: { audience?: unknown; text?: unknown; chip?: unknown; source?: unknown } } | null | undefined)
    ?.flight_surgeon_note
  if (!n || n.audience !== 'flight_surgeon' || typeof n.text !== 'string') return null
  return { text: n.text, chip: typeof n.chip === 'string' ? n.chip : undefined, source: (n.source as Record<string, unknown> | undefined) ?? undefined }
}

/** Cases whose packet asks for a variable (e.g. which packets mood could ever join). */
export function casesRequesting(variable: string, defs: readonly CaseDef[]): CaseDef[] {
  return defs.filter((d) => {
    const obs = (d as { escalation?: { observations?: unknown } }).escalation?.observations
    return Array.isArray(obs) && obs.includes(variable)
  })
}

// ---- verbatim requirement text (std_vol2_requirements snapshot) ------------------------------------

export interface Vol2Requirement {
  id: string
  section?: string
  title?: string
  text: string
  rationale?: string
  pdf_page?: number
  verified?: boolean
}

/** A requirement from the std_vol2_requirements payload by id ("V2 6164" or "[V2 6164]"). */
export function findRequirement(data: unknown, id: string): Vol2Requirement | null {
  const reqs = (data as { requirements?: unknown } | null)?.requirements
  if (!Array.isArray(reqs)) return null
  const want = id.replace(/^\[|\]$/g, '')
  const r = reqs.find((x) => typeof x?.id === 'string' && x.id.replace(/^\[|\]$/g, '') === want)
  return r && typeof r.text === 'string' ? (r as Vol2Requirement) : null
}

/** The whole sentence of `text` that contains `needle` (verbatim, trimmed), or null. */
export function sentenceContaining(text: string | null | undefined, needle: string): string | null {
  if (!text) return null
  const sentences = text.split(/(?<=[.!?])\s+/)
  return sentences.find((s) => s.includes(needle))?.trim() ?? null
}
