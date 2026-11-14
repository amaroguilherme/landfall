// Local reading of engine/rules/cases.json (SPEC 3.4) and of the HRP snapshots the case views quote.
// The engine's CaseDef keeps unknown fields open; these interfaces name the ones the UI renders.
import type { Source, TripwireCondition } from '../../app/engine'

export interface Cite {
  kind?: string
  citation?: string
  doc?: string
  url?: string
  verbatim?: string
  requirement_id?: string | null
  section?: string
  page?: number
  note?: string
  snapshot?: string
  level?: string
  context_quote?: boolean
  [key: string]: unknown
}

export interface CmDef {
  id: string
  title?: string
  rationale?: string
  chip?: string
  source?: Source
}

export interface StepInputDef {
  variable: string
  unit: string
  source: 'manual' | 'band' | 'vehicle' | 'app' | string
}

export interface StepDef {
  id: string
  text?: string
  input?: StepInputDef
}

export interface Projection {
  id: string
  label: string
  value: number | { min: number; max: number }
  unit: string
  chip?: string
  source?: Source
  caveat?: { text: string; chip?: string; source?: Source }
}

export interface CaseDefFull {
  id: string
  title?: string
  one_line?: string
  hrp_risk?: { title: string; url: string; snapshot?: string; formal_description?: string; why_here?: string; page_heading?: string }
  hazards?: string[]
  body_regions?: string[]
  triggers?: Array<{ kind: string; rule_id?: string; indicator_id?: string }>
  interpretation?: { text: string; citations?: Cite[] }
  countermeasure?: { primary: CmDef; alternatives?: CmDef[] }
  procedure?: StepDef[]
  tripwire?: { reassess_after_s: number; condition: TripwireCondition; text?: string; chip?: string; source?: Source }
  escalation?: { ground_packet?: boolean; observations?: string[] } | null
  projections?: Projection[]
  not_measurable_here?: Array<{ what: string; via: string; requirement_id?: string }>
  refusals?: string[]
}

export interface HrpRisk {
  name: string
  url: string
  summary?: string
  detail?: {
    canonical_url?: string
    top_risks_sentences?: string[]
    what_can_be_done_sentences?: string[]
    formal_risk_description?: string
    hrr_risk_id?: number
    hrr_url?: string
  }
}

export interface HrrRisk {
  hrr_id: number
  title: string
  element?: string
  url?: string
  detail?: {
    hrp_risk_status?: string
    last_published?: string
    risk_statement?: string | null
    ratings?: Array<{
      mission_type: string
      duration: string
      operations?: { lxc: string; disposition: string }
      long_term_health?: { lxc: string; disposition: string }
    }>
    ratings_note?: string
  }
}

export interface HrpHazard {
  id: string
  name: string
  summary?: string
  url?: string
}

export interface MetaHazard {
  id: string
  label: string
  hrp_snapshot_id?: string
}
