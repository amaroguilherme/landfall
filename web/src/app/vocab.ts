// Shared vocabulary, verbatim from engine/SPEC.md section 2 and 3. These strings are the
// contract between the rules JSON, the engine and the UI: never rename them here alone.

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

export const CATEGORIES = ['FFD', 'PEL', 'POL', 'OPS', 'PERSONAL'] as const
export type Category = (typeof CATEGORIES)[number]

export const CHIPS = [
  'NASA-published',
  'NASA brief',
  'NOAA-published',
  'literature',
  'derived',
  'design choice',
] as const
export type ChipKind = (typeof CHIPS)[number]

export const FRESHNESS_KINDS = ['live', 'historical', 'prediction', 'reference'] as const
export type FreshnessKind = (typeof FRESHNESS_KINDS)[number]

export const ENV_IDS = ['iss', 'cislunar', 'lunar_surface', 'mars_surface'] as const
export type EnvId = (typeof ENV_IDS)[number]

export const CREW_IDS = ['CM-1', 'CM-2', 'CM-3', 'CM-4'] as const
export type CrewId = (typeof CREW_IDS)[number]

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
export interface Observation {
  crew_id: CrewId
  variable: string
  value: number
  unit: string
  /** MET seconds. */
  t: number
  source: ObservationSource
  provenance: 'simulated' | 'measured' | 'manual' | string
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
