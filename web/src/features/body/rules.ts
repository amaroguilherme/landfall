// The engine's rules files, read at build time. import.meta.glob tolerates a missing file, so the
// body map builds before and after the rules land; a missing file renders an honest
// "rules loading from engine" state and no number is ever hard-coded in its place.
import type { PersonalIndicator, RciConfig, Rule } from '../../app/engine'
import type { ChipKind, Source } from '../../app/vocab'

interface ThresholdsFile {
  schema: string
  rules: Rule[]
}

export interface PersonalIndicatorDef extends PersonalIndicator {
  label: string
  device?: string
  definition?: { text: string; chip: ChipKind | string; source: Source }
}

/** meta.json escalation (D4): the two tiers, and how autonomy scales with the link. */
export interface EscalationMeta {
  tiers: Array<{ tier: number; id: string; label: string; when: string }>
  autonomy: { AOS: string; LOS: string }
  chip: string
  source: Source
}

/** meta.json packet_states: the one wording of the ground packet's state, used everywhere. */
export interface PacketStateMeta {
  id: 'prepared' | 'queued' | string
  label: string
  when: string
}

interface PersonalFile {
  schema: string
  rci: RciConfig & {
    chip?: ChipKind | string
    source?: Source
    provenance?: Record<string, { chip: ChipKind | string; source: Source }>
  }
  indicators: PersonalIndicatorDef[]
}

export interface CaseTrigger {
  kind: 'rule' | 'personal' | 'ops'
  rule_id?: string
  indicator_id?: string
}

export interface CaseDef {
  id: string
  title: string
  one_line: string
  hrp_risk?: { title: string; url: string; snapshot?: string; formal_description?: string; why_here?: string }
  hazards: string[]
  body_regions: string[]
  triggers: CaseTrigger[]
  tripwire?: {
    reassess_after_s: number
    condition: Record<string, unknown>
    text: string
    chip: ChipKind | string
    source: Source
  }
  escalation?: { ground_packet: boolean; observations?: string[] }
  not_measurable_here?: Array<{ what: string; via: string; requirement_id?: string }>
  refusals?: unknown[]
}

interface CasesFile {
  schema: string
  cases: CaseDef[]
}

export interface HazardMeta {
  id: string
  label: string
  hrp_snapshot_id: string
}

interface MetaFile {
  schema: string
  hazards?: HazardMeta[]
  body_regions?: string[]
  body_region_rule?: string
  escalation?: EscalationMeta
  packet_states?: PacketStateMeta[]
}

const glob = import.meta.glob<unknown>(
  [
    '../../../../engine/rules/thresholds.json',
    '../../../../engine/rules/personal.json',
    '../../../../engine/rules/cases.json',
    '../../../../engine/rules/meta.json',
  ],
  { eager: true, import: 'default' },
)

function pick<T>(name: string): T | null {
  const hit = Object.entries(glob).find(([path]) => path.endsWith(`/${name}`))
  return hit ? (hit[1] as T) : null
}

const thresholds = pick<ThresholdsFile>('thresholds.json')
const personal = pick<PersonalFile>('personal.json')
const cases = pick<CasesFile>('cases.json')
const meta = pick<MetaFile>('meta.json')

/** null when engine/rules/thresholds.json is not in this build. */
export const THRESHOLD_RULES: readonly Rule[] | null = Array.isArray(thresholds?.rules) ? thresholds.rules : null
export const PERSONAL_INDICATORS: readonly PersonalIndicatorDef[] | null = Array.isArray(personal?.indicators)
  ? personal.indicators
  : null
export const RCI_CONFIG: PersonalFile['rci'] | null = personal?.rci ?? null
/** Chip of the Tier B single-case test: its critical value is derived from alpha and the baseline length. */
export const RCI_Z_CHIP: string | null = RCI_CONFIG ? 'derived' : null
export const CASES: readonly CaseDef[] | null = Array.isArray(cases?.cases) ? cases.cases : null
export const HAZARDS_META: readonly HazardMeta[] | null = Array.isArray(meta?.hazards) ? meta.hazards : null
export const META_BODY_REGIONS: readonly string[] | null = Array.isArray(meta?.body_regions) ? meta.body_regions : null
/** meta.json body_region_rule: the footprint / fill / fitness-tag rule, quoted on the page. */
export const BODY_REGION_RULE: string | null = typeof meta?.body_region_rule === 'string' ? meta.body_region_rule : null
export const ESCALATION_META: EscalationMeta | null = meta?.escalation && Array.isArray(meta.escalation.tiers) ? meta.escalation : null
export const PACKET_STATES: readonly PacketStateMeta[] = Array.isArray(meta?.packet_states) ? meta.packet_states : []

/** The packet-state label for a case state (meta.json packet_states): Queued once packet_queued_at is set. */
export function packetStateLabel(packetQueuedAt: number | null | undefined): string | null {
  const id = typeof packetQueuedAt === 'number' ? 'queued' : 'prepared'
  return PACKET_STATES.find((p) => p.id === id)?.label ?? null
}

export function ruleById(id: string): Rule | undefined {
  return THRESHOLD_RULES?.find((r) => r.id === id)
}

export function indicatorById(id: string): PersonalIndicatorDef | undefined {
  return PERSONAL_INDICATORS?.find((i) => i.id === id)
}
