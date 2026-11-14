// JSON shapes of the engine API (SPEC sections 2-5). Field names are snake_case exactly as in the
// rules files and the Python engine, so a value can cross languages unchanged. Every function still
// validates its input at run time (the types describe valid input; they are not trusted).

export type Op = 'lt' | 'le' | 'gt' | 'ge'
export type Severity = 'nominal' | 'advisory' | 'caution' | 'warning' | 'emergency'
export type Status =
  | 'within'
  | 'approaching'
  | 'outside'
  | 'reliable_change'
  | 'insufficient_data'
  | 'stale'
  | 'not_applicable'
/** FFD floor, PEL ceiling, POL change, OPS scale, TARGET countermeasure target, PERSONAL baseline. */
export type Category = 'FFD' | 'PEL' | 'POL' | 'OPS' | 'PERSONAL' | 'TARGET' | (string & {})
export type Chip =
  | 'NASA-published'
  | 'NASA report'
  | 'NOAA-published'
  | 'literature'
  | 'derived'
  | 'design choice'
  | (string & {})
export type Direction = 'increase' | 'decrease' | 'none'
export type Worse = 'increase' | 'decrease' | 'either'

/** SPEC section 3 `source` object (nasa_standard, nasa_brief, noaa, literature, derived, design_choice). */
export interface Source {
  kind?: string
  [key: string]: unknown
}

export interface Basis {
  chip?: Chip
  source?: Source
  [key: string]: unknown
}

/** SPEC section 4. crew_id null or absent = a vehicle / habitat sensor shared by every crewmember. */
export interface Observation {
  crew_id?: string | null
  variable?: string
  value: number | boolean | null
  unit?: string
  t?: number
  source?: string
  provenance?: string
  [key: string]: unknown
}

/** An observation passed as a rule / indicator value: {value, unit, t?, variable?}. */
export type ObservationValue = Pick<Observation, 'value' | 'unit' | 't' | 'variable'> & Record<string, unknown>
export type RuleValue = number | null | ObservationValue

/** thresholds.json rule (SPEC 3.2). */
export interface Rule {
  id: string
  label?: string
  variable: string
  unit: string
  op: Op
  limit: number
  category: Category
  tier: string
  role: 'alert' | 'context'
  applies_to: string[]
  window?: { kind: string; duration?: string; [key: string]: unknown }
  approach_at?: (Basis & { value: number }) | null
  stale_after?: (Basis & { seconds: number }) | null
  max_severity?: Severity | null
  s_level?: number
  chip: Chip
  source: Source
  action_id?: string | null
  case_id?: string | null
  notes?: string[]
  [key: string]: unknown
}

/** ctx of evaluate_rule: eva true = an EVA is planned or in progress (OPS severity). */
export interface RuleContext {
  eva?: boolean
  [key: string]: unknown
}

export interface Finding {
  rule_id: string
  tier: string
  category: Category
  role: 'alert' | 'context'
  status: Status
  severity: Severity
  value: number | null
  unit: string
  op: Op | null
  limit: number | null
  approach_at: number | null
  margin: number | null
  chip: Chip
  source: Source
  /** One plain-English sentence chain ending in "Basis: <chip> [<requirement id>]." */
  why: string
  env_id: string | null
  t: number | null
  case_id: string | null
  action_id: string | null
}

/** personal.json indicator (SPEC 3.3). */
export interface Indicator {
  id: string
  label?: string
  variable: string
  unit: string
  worse: Worse
  alerting: boolean
  private?: boolean
  /** Non-computational context only (SPEC 3.3): the engine ignores it, and value is null in the real rules. */
  reliability_r?: Basis & { value: number | null; used_by_engine?: boolean }
  definition?: Basis & { text?: string }
  case_id?: string | null
  action_id?: string | null
  [key: string]: unknown
}

/**
 * The `rci` block of personal.json (SPEC 3.3). The engine reads alpha_two_tailed and min_baseline_n;
 * the critical value is not stored (it depends on the baseline length: tCritical(alpha, n - 1)).
 */
export interface RciConfig {
  alpha_two_tailed: number
  min_baseline_n: number
  baseline_window_days?: number
  chip: Chip
  source: Source
  /** Plain-English statement of the test (its quoted critical values are checked against the engine). */
  method?: string
  /** Jacobson & Truax's "reliable change": the conceptual lineage, not the arithmetic. */
  lineage?: Basis & { text?: string }
  provenance?: Record<string, Basis>
  /** Why the printed chance rate is a lower bound (autocorrelation, skew). */
  caveat?: string
  caveat_basis?: Basis & { text?: string }
  /** What changed from the earlier arithmetic, and why. */
  change_note?: string
  [key: string]: unknown
}

export type RciReason = 'baseline_too_short' | 'no_current' | 'zero_sd'

/** The single-case test of Crawford & Howell (1998). rc is its t statistic. */
export interface RciResult {
  method: 'crawford_howell_1998'
  status: 'ok' | 'insufficient_data'
  reason: RciReason | null
  n: number
  /** n - 1 (null below 2 values). */
  df: number | null
  mean: number | null
  sd: number | null
  /** sd * sqrt(1 + 1/n): the SD of the difference between one new value and the mean of n values. */
  s_diff: number | null
  /** The t statistic of the single-case test, (current - mean) / s_diff. */
  rc: number | null
  /** tCritical(alpha, df), two-tailed (null below min_baseline_n). */
  critical: number | null
  alpha: number
  reliable: boolean
  direction: Direction | null
}

export interface PersonalRci {
  method: 'crawford_howell_1998'
  /** The t statistic of the single-case test. */
  rc: number | null
  df: number | null
  critical: number | null
  alpha: number
  s_diff: number | null
  mean: number | null
  sd: number | null
  n: number
  reliable: boolean
  reason: RciReason | null
}

export interface PersonalFinding extends Finding {
  tier: 'B'
  category: 'PERSONAL'
  direction: Direction | null
  worse: Worse
  private: boolean
  rci: PersonalRci
}

/** expectedFalseAlarms: chance flags (either direction) and chance cautions (worse direction only). */
export interface FalseAlarms {
  /** (k * days) * alpha chance flags. */
  expected: number
  per_day: number
  every_n_days: number | null
  /** "one false flag every N days on average, counting chance changes in either direction". */
  text: string
  /** expected / 2: only a chance change in the worse direction raises a caution. */
  expected_cautions: number
  cautions_per_day: number
  caution_every_n_days: number | null
  /** "one false caution every M days on average: only a chance change in the worse direction raises a caution". */
  caution_text: string
  /** The independence / normality assumption, as one sentence. */
  assumes: string
  k_indicators: number
  days: number
  alpha: number
}

// ---- cases (SPEC 3.4 and 5) ----

export interface CaseTrigger {
  kind: 'rule' | 'personal' | 'ops' | (string & {})
  rule_id?: string
  indicator_id?: string
  [key: string]: unknown
}

export interface TripwireCondition {
  indicator_id?: string
  rule_id?: string
  variable?: string
  unit?: string
  op: Op
  value: number
  of_last_n: number
  at_least: number
  /** env_id -> overrides; one that names a rule_id / indicator_id replaces the reference, variable and unit. */
  by_env?: Record<string, Partial<Omit<TripwireCondition, 'by_env'>>>
  [key: string]: unknown
}

export interface CaseDef {
  id: string
  title?: string
  one_line?: string
  triggers?: CaseTrigger[]
  countermeasure?: {
    primary: { id: string; [key: string]: unknown }
    alternatives?: Array<{ id: string; [key: string]: unknown }>
    [key: string]: unknown
  }
  procedure?: Array<{ id: string; text?: string; input?: Record<string, unknown>; [key: string]: unknown }>
  tripwire?: { reassess_after_s: number; condition: TripwireCondition; text?: string; [key: string]: unknown }
  escalation?: { ground_packet?: boolean; observations?: string[]; [key: string]: unknown } | null
  [key: string]: unknown
}

/** rule or indicator id -> {variable, unit} (triggerLookup). */
export type TriggerLookup = Record<string, { variable: unknown; unit: unknown }>

export type CaseStatus = 'idle' | 'detected' | 'acting' | 'watch' | 'resolved' | 'escalated' | 'dismissed'
export type CaseEventType = 'OPEN' | 'SELECT' | 'STEP' | 'OUTCOME' | 'TICK' | 'DISMISS'

export interface CaseSpec {
  case_id: string
  /** The environment newCase resolved the tripwire for (null: the base condition). */
  env_id?: string | null
  trigger_ids: string[]
  countermeasure_ids: string[]
  step_ids: string[]
  tripwire: {
    reassess_after_s: number
    condition: {
      /** The rule or indicator the effective condition watches (after by_env), or null. */
      ref_id?: string | null
      variable: string
      op: Op
      value: number
      unit: string
      of_last_n: number
      at_least: number
    }
  }
  escalation: { ground_packet?: boolean; observations?: string[]; [key: string]: unknown } | null
}

/** A log entry. `t` and `event` are the event's own fields (raw values for a rejected event). */
export interface CaseLogEntry {
  t: number | null
  event: CaseEventType | null
  from: CaseStatus
  to: CaseStatus
  detail: string
  /** null for an accepted transition, else the rejection code (invalid_transition, ...). */
  error: string | null
}

export interface TripwireResult {
  hits: number
  considered: number
  of_last_n: number
  at_least: number
  tripped: boolean
}

export interface CaseState {
  schema: 'landfall.case_state/1'
  case_id: string
  crew_id: string
  status: CaseStatus
  spec: CaseSpec
  opened_at: number | null
  finding: Finding | null
  countermeasure_id: string | null
  steps_done: Array<{ step_id: string; t: number; input: unknown }>
  outcome: { text: string; t: number } | null
  watch_started_at: number | null
  reassess_at: number | null
  tripwire_obs: Array<{ t: number; value: number }>
  tripwire_result: TripwireResult | null
  closed_at: number | null
  dismiss_reason: string | null
  updated_at: number | null
  log: CaseLogEntry[]
}

export type CaseEvent =
  | { type: 'OPEN'; t: number; finding: Finding }
  | { type: 'SELECT'; t: number; countermeasure_id: string }
  | { type: 'STEP'; t: number; step_id: string; input?: unknown }
  | { type: 'OUTCOME'; t: number; text: string }
  | { type: 'TICK'; t: number; observations: Observation[] }
  | { type: 'DISMISS'; t: number; reason: string }

// ---- ground packet (FHIR R4) ----

/** consent[variable]: mood (private) needs true; anything else is shared unless false. */
export type Consent = Record<string, boolean>

export interface FhirCoding {
  system: string
  code: string
  display?: string
}

export interface FhirObservation {
  resourceType: 'Observation'
  id: string
  meta?: { profile?: string[]; tag?: FhirCoding[] }
  status: 'final'
  category?: Array<{ coding: FhirCoding[]; text: string }>
  code: { coding: FhirCoding[]; text: string }
  subject: { type: 'Patient'; identifier: { system: string; value: string }; display: string }
  effectiveDateTime: string
  valueQuantity?: { value: number; unit: string; system: string; code: string }
  valueBoolean?: boolean
  valueDateTime?: string
}

export interface FhirBundle {
  resourceType: 'Bundle'
  id: string
  meta: { tag: FhirCoding[] }
  type: 'collection'
  timestamp: string
  entry: Array<{ resource: FhirObservation }>
}

// ---- comms (SPEC 3.1 and 5) ----

export interface Environment {
  id: string
  label?: string
  kind?: string
  comms?: {
    one_way_light_time_s: { min?: number; mean?: number; max?: number; from_snapshot?: string }
    conjunction?: boolean
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** MET-based light-time table (the runtime converts snapshot UTC times with the mission epoch). */
export interface CommsTable {
  samples: Array<{ t: number; one_way_s: number }>
  /** Half-open [start, end) in MET seconds. Touching or overlapping windows chain. */
  conjunction_windows?: Array<{ start: number; end: number; reason?: string }>
  [key: string]: unknown
}

export interface CommsEta {
  one_way_s: number
  round_trip_s: number
  blocked: boolean
  reason: 'solar_conjunction' | null
  resumes_at: number | null
  earliest_reply_s: number
  light_time_source: 'table' | 'environment_max'
}
