// Shared vocabulary, verbatim from engine/SPEC.md sections 2 and 3. These strings are the
// contract between the rules JSON, the engine and the UI: never rename them here alone.
// Chips and categories are READ from engine/rules/meta.json (bundled by the engine as RULES.meta),
// so a rename there (e.g. a chip label) reaches every badge without a code change.
import { RULES } from './engine'
import type { Category as EngineCategory } from './engine'

export const SEVERITIES = ['nominal', 'advisory', 'caution', 'warning', 'emergency'] as const
export type Severity = (typeof SEVERITIES)[number]

/** Ordering used for sorting and for "at least caution" comparisons. */
export const SEVERITY_RANK: Record<Severity, number> = {
  nominal: 0,
  advisory: 1,
  caution: 2,
  warning: 3,
  emergency: 4,
}

export const STATUSES = [
  'within',
  'approaching',
  'outside',
  'reliable_change',
  'insufficient_data',
  'stale',
  'not_applicable',
] as const
export type Status = (typeof STATUSES)[number]

// ---- meta.json: chips and categories --------------------------------------------------------

/** meta.json chips[]: the label shown on the chip, the SPEC source kind behind it, its definition. */
export interface ChipDef {
  id: string
  source_kind: string
  definition: string
}

/** meta.json categories[]: FFD, PEL, POL, OPS, PERSONAL, TARGET (and whatever the rules add). */
export interface CategoryDef {
  id: string
  name: string
  shape: string
  glossary: string | null
  source: Record<string, unknown> | null
}

interface MetaShape {
  chips?: ChipDef[]
  categories?: CategoryDef[]
}

const META = (RULES.meta ?? {}) as unknown as MetaShape

/** Every provenance chip, in meta.json order. */
export const CHIP_DEFS: readonly ChipDef[] = Array.isArray(META.chips) ? META.chips : []
/** Chip labels, e.g. "NASA-published" (read from meta.json; never a hard-coded list). */
export const CHIPS: readonly string[] = CHIP_DEFS.map((c) => c.id)
/** A chip label from meta.json. Typed as string because the rules own the list. */
export type ChipKind = string

/** Every limit category, in meta.json order. */
export const CATEGORY_DEFS: readonly CategoryDef[] = Array.isArray(META.categories) ? META.categories : []
/** Category ids, e.g. "FFD", "TARGET" (read from meta.json). */
export const CATEGORIES: readonly string[] = CATEGORY_DEFS.map((c) => c.id)
/** FFD | PEL | POL | OPS | PERSONAL | TARGET (open to new ids from the rules). */
export type Category = EngineCategory

export function chipDef(label: string | null | undefined): ChipDef | null {
  return CHIP_DEFS.find((c) => c.id === label) ?? null
}

/** SPEC 3 source kind behind a chip label (nasa_standard, nasa_brief, noaa, literature, derived, design_choice). */
export function chipSourceKind(label: string | null | undefined): string | null {
  return chipDef(label)?.source_kind ?? null
}

export function categoryDef(id: string | null | undefined): CategoryDef | null {
  return CATEGORY_DEFS.find((c) => c.id === id) ?? null
}

// ---- other vocabularies ----------------------------------------------------------------------

export const FRESHNESS_KINDS = ['live', 'historical', 'prediction', 'reference'] as const
export type FreshnessKind = (typeof FRESHNESS_KINDS)[number]

/** Must match engine/rules/environments.json (a test checks it). */
export const ENV_IDS = ['iss', 'cislunar', 'lunar_surface', 'mars_surface'] as const
export type EnvId = (typeof ENV_IDS)[number]

export function isEnvId(x: unknown): x is EnvId {
  return typeof x === 'string' && (ENV_IDS as readonly string[]).includes(x)
}

export const CREW_IDS = ['CM-1', 'CM-2', 'CM-3', 'CM-4'] as const
export type CrewId = (typeof CREW_IDS)[number]

export function isCrewId(x: unknown): x is CrewId {
  return typeof x === 'string' && (CREW_IDS as readonly string[]).includes(x)
}

export interface CrewMember {
  id: CrewId
  role: string
  /** Short role code for tight layouts. */
  short: string
}

/** SPEC section 2: fictional crew, no names, no PII. */
export const CREW: readonly CrewMember[] = [
  { id: 'CM-1', role: 'Commander', short: 'CDR' },
  { id: 'CM-2', role: 'Flight Engineer', short: 'FE' },
  { id: 'CM-3', role: 'Mission Specialist', short: 'MS' },
  { id: 'CM-4', role: 'Crew Medical Officer', short: 'CMO' },
]

export function crewMember(id: CrewId): CrewMember {
  return CREW.find((c) => c.id === id) ?? CREW[0]
}

/** SPEC section 4. */
export type ObservationSource = 'band' | 'manual' | 'vehicle' | 'lab' | 'app' | 'replay'
/** A type alias (not an interface) so it is assignable to the engine's Observation (index signature). */
export type Observation = {
  /** null = a vehicle / habitat sensor shared by every crewmember (SPEC 5 case_reduce). */
  crew_id: CrewId | null
  variable: string
  value: number
  unit: string
  /** MET seconds when the value became available (end of its measurement window). */
  t: number
  source: ObservationSource
  provenance: 'simulated' | 'replay' | 'measured' | 'manual' | string
}

/** SPEC section 3: every number carries a chip and a source of one of these shapes. */
export type Source =
  | {
      kind: 'nasa_standard'
      doc: string
      requirement_id?: string
      section?: string
      url?: string
      snapshot?: string
    }
  | { kind: 'nasa_brief'; doc: string; url?: string; snapshot?: string }
  | { kind: 'noaa'; doc: string; url?: string; snapshot?: string }
  | { kind: 'literature'; citation: string; url?: string }
  | { kind: 'derived'; from: string[]; arithmetic: string }
  | { kind: 'design_choice'; rationale: string }
