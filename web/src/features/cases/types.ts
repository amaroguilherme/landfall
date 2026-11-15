// Local reading of engine/rules/cases.json (SPEC 3.4), meta.json and the HRP snapshots the case views quote.
// The engine's CaseDef keeps unknown fields open; these interfaces name the ones the UI renders.
// Deliberately absent: escalation.flight_surgeon_note. It is written for the flight surgeon and is shown
// only with the ground packet (#/downlink), never in crew-facing case text (D12).
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
  /** Further sources of the countermeasure (quoted verbatim, kept out of the title and rationale). */
  citations?: Cite[]
}

export interface StepInputDef {
  variable: string
  unit: string
  source: 'manual' | 'band' | 'vehicle' | 'app' | string
}

/** The citation of a step, kept out of the crew-facing step text (D7). */
export interface StepBasis {
  note?: string
  chip?: string
  source?: Source
}

export interface StepDef {
  id: string
  text?: string
  input?: StepInputDef
  /** OUTCOME waits until this step is done or declined with a reason (D5). */
  required?: boolean
  /** A required yes/no question; "yes" escalates the case at once (D4, D5). */
  red_flag?: boolean
  /** Doing the step queues the ground packet (crew release). */
  releases_packet?: boolean
  /** The symptoms a red-flag question asks about, in plain language. */
  red_flags?: string[]
  basis?: StepBasis
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
  not_measurable_here?: Array<{ what: string; via: string; requirement_id?: string; note?: string }>
  refusals?: string[]
}

// ---- meta.json: escalation tiers (D4) and packet states ------------------------------------------------

export interface EscalationTierDef {
  tier: number
  id: 'crew_medical_officer' | 'flight_surgeon' | string
  label: string
  when: string
}

export interface EscalationMeta {
  tiers: EscalationTierDef[]
  autonomy: { AOS?: string; LOS?: string }
  chip?: string
  source?: Source
  citations?: Cite[]
}

export interface PacketStateDef {
  id: 'prepared' | 'queued' | string
  label: string
  when?: string
}

// ---- snapshots ----------------------------------------------------------------------------------------

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

export interface HrrRating {
  mission_type: string
  duration: string
  operations?: { lxc: string; disposition: string }
  long_term_health?: { lxc: string; disposition: string }
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
    ratings?: HrrRating[]
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

/** sim_crew data.self_check: what the generator's own Tier B check says about chance flags. */
export interface UnscriptedOpening {
  crew_id: string
  case_id: string
  /** MET day of the chance flag that opens the case. */
  day: number
  indicator_id: string
  /** The single-case t statistic of that flag. */
  t: number
  /** MET day the scripted episode starts, or null when nothing is scripted for this crewmember. */
  scripted_opening_day: number | null
  /** The critical value the flag crossed, the case instance it opened, and whether it was a single flag (one indicator, one day). */
  critical?: number
  instance?: number
  single_flag?: boolean
  run_days?: [number, number]
}

export interface SimSelfCheck {
  unscripted_case_openings?: UnscriptedOpening[]
}
