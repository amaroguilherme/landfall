// Shape of hardware/sensor-map.json (schema "landfall.sensor_map/1"), the single source of truth
// for the LANDFALL BAND: the #/band view, hardware/sensor-map.md and hardware/BOM.csv all come
// from it. Type-only module: Node can import render.ts (which imports these types) with type
// stripping, so keep this file free of runtime code.

/** A chip id from engine/rules/meta.json (the rules own the list; the band test checks it). */
export type ChipName = string

export type Relation = 'direct' | 'constraint' | 'analogy' | 'delegates' | 'reference'

export type BlockGroup = 'sensor' | 'core' | 'storage' | 'power'

export type BandSource =
  | { kind: 'derived'; from: string[]; arithmetic: string }
  | { kind: 'design_choice'; rationale: string }

export interface Limit {
  what: string
  value: number
  unit: string
  chip: ChipName
  table?: string
  rationale?: string
}

export interface ReqRef {
  /** "V1 3004", "V2 9023", "JSC-20793 Rev D", "Standard Measures", "ARCHeR (Artemis II)". */
  id: string
  item?: string
  doc?: string
  section?: string
  url?: string
  relation: Relation
  quote: string
  why?: string
  note?: string
  /** Frozen snapshot in web/public/data whose text contains `quote`; absent = not frozen in this build. */
  snapshot?: string | null
  limits?: Limit[]
}

export interface Rate {
  what: string
  value: number
  unit: string
  chip: ChipName
  /** Qualifier shown next to the chip, e.g. "flown hardware". */
  basis?: string
  source: BandSource
}

export interface Produced {
  variable: string
  label: string
  unit: string
  how: string
  /** True when the variable is not one of the SPEC 3.3 personal indicators. */
  not_in_spec?: boolean
}

export interface FeedRef {
  kind: 'personal' | 'rule' | 'case' | 'app' | 'none'
  id: string
  as?: string
}

/**
 * Where a part's manufacturer claims come from. `read`: the manufacturer's own page or datasheet was
 * read for this build and `verified` quotes it; `not_retrieved`: it could not be fetched, so the block
 * claims nothing about the part (mfr_spec is empty) and the URL is listed for a reviewer.
 */
export interface Datasheet {
  url: string
  product_page?: string
  status: 'read' | 'not_retrieved'
  /** ISO date of the check. */
  checked: string
  verified?: string[]
  note: string
}

export interface Block {
  id: string
  group: BlockGroup
  part: string
  qty: number
  manufacturer: string
  name: string
  function: string
  /** Bus id from `buses`, or "power" for the power domain. */
  interface: string
  interface_extra?: string
  mfr_spec: string[]
  /** null when no part is selected (the generic LiPo cell). */
  datasheet: Datasheet | null
  rates: Rate[]
  produces: Produced[]
  produces_note?: string
  feeds: FeedRef[]
  justified_by: ReqRef[]
  design: string[]
}

export interface Bus {
  id: string
  label: string
  detail: string
  members: string[]
}

export interface Step {
  id: string
  label: string
  value: number
  unit: string
  chip: ChipName
  arithmetic?: string
  rationale?: string
}

export interface BudgetLine {
  block: string
  label: string
  ua: number
}

export interface HandOff {
  id: string
  what: string
  why: string
  via: string
  source: 'manual' | 'vehicle' | 'lab'
  requirement?: ReqRef
  /** Further requirements beside the primary one (e.g. [V2 6165] next to [V2 6164]). */
  also?: ReqRef[]
  examples?: { name: string; snapshot: string; text: string }[]
  feeds: FeedRef[]
}

export interface Negative {
  id: string
  claim: string
  detail: string
  nearest: string[]
  snapshot: string
  pattern: string
  hits: number
}

export interface Pitfall {
  id: string
  title: string
  text: string
  consequence: string
  arithmetic?: { label: string; value: number; unit: string; chip: ChipName; arithmetic: string }[]
}

export interface SafetyItem {
  id: string
  topic: string
  refs: string[]
  text: string
  chip: ChipName
  snapshot: string | null
}

export interface FlownChannel {
  id: string
  channel: string
  rate_hz: number
  rate_text?: string
  resolution: string
}

export interface SensorMap {
  schema: 'landfall.sensor_map/1' | string
  id: string
  title: string
  subtitle: string
  status: { level: string; text: string; why_no_schematic: string }
  principle: string
  label_rule: string
  /** How manufacturer specs were checked for this build. */
  mfr_basis: string
  relations: Record<Relation, string>
  gap: { claim: string; detail: string; quote: string; doc: string; ntrs: string; url: string; verified_in: string }
  flown_reference: { name: string; facts: string[]; basis: string; channels: FlownChannel[] }
  anchors: ReqRef[]
  buses: Bus[]
  blocks: Block[]
  power: {
    summary: string
    budget: BudgetLine[]
    budget_chip: ChipName
    budget_source: BandSource
    steps: Step[]
    comparison: string
    no_requirement: string
  }
  log: { summary: string; steps: Step[] }
  not_measurable_here: HandOff[]
  negatives: Negative[]
  pitfalls: Pitfall[]
  pitfalls_basis: string
  safety: SafetyItem[]
  safety_basis: string
  open_items: string[]
}
