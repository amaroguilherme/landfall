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
/** A declared test-scale transform of a Tier B indicator (SPEC 3.3): "anscombe" = 2 * sqrt(x + 3/8), for counts. */
export type Transform = 'anscombe'

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

/**
 * A one-line action for a finding without a deep case (SPEC 3.2 / 3.3, D11): the crew-facing label
 * (e.g. "EVA assignment not cleared") and text. Present on every alerting rule or indicator that no
 * case lists as a trigger.
 */
export interface FindingAction extends Basis {
  label: string
  text: string
}

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
  /** One-line action when no case lists this rule as a trigger (D11). */
  action?: FindingAction
  case_id?: string | null
  notes?: string[]
  [key: string]: unknown
}

/** ctx of evaluate_rule: accepted for compatibility; no field of it changes the result (D1). */
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
  /** Context only, never a limit (e.g. glucose: the Inspiration4 lab range, with `range`). */
  context?: Basis & { text?: string; range?: { min: number; max: number; unit: string } }
  /** Why there is no Tier A rule for this indicator (D8: "No NASA numeric limit ..."). */
  limit_note?: Basis & { text?: string }
  /** One-line action when no case lists this indicator as a trigger (D11). */
  action?: FindingAction
  case_id?: string | null
  action_id?: string | null
  /** The test-scale transform (S2): PVT-B lapses are tested as 2 * sqrt(x + 3/8). Absent or null: the raw value. */
  transform?: Transform | null
  /** Why the indicator has a transform, with its literature chip and source (Anscombe 1948). */
  transform_basis?: Basis & { text?: string }
  /**
   * The chance rate measured under the scenario's noise model (S3), declared only where it is not within 0.5-2
   * times nominal; chanceRate() then prints it instead of the nominal rate.
   */
  chance_rate?: Basis & { caution_multiplier: number; flag_multiplier: number; text?: string }
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
  /** critical * s_diff: the smallest change from the mean that is a reliable change (null without critical or SD). */
  mdc: number | null
}

/** minDetectableChange(sd, n, alpha): the band half-width at a given SD (D10). */
export interface MinDetectableChange {
  mdc: number
  critical: number
  s_diff: number
  sd: number
  n: number
  df: number
  alpha: number
}

export interface PersonalRci {
  method: 'crawford_howell_1998'
  /** The scale the test ran on: the declared transform, or null for the raw value. Every rci number is on it. */
  transform: Transform | null
  /** The current value on the test scale (the value itself without a transform), or null. */
  current: number | null
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
  /** The minimum detectable change of this band, critical * s_diff (D10). */
  mdc: number | null
}

export interface PersonalFinding extends Finding {
  tier: 'B'
  category: 'PERSONAL'
  direction: Direction | null
  worse: Worse
  private: boolean
  /** Arithmetic mean of the baseline values on the raw scale (the indicator's unit), or null without one. */
  baseline_mean: number | null
  /**
   * The personal band on the raw scale (the indicator's unit): mean -/+ critical * s_diff on the test scale, its
   * edges mapped back through the transform. Reported whenever rci.mdc is (also without a current value); null
   * otherwise. Draw THIS band, not rci.mean +/- rci.mdc, which is on the test scale.
   */
  band: { low: number; high: number } | null
  rci: PersonalRci
}

/** chanceRate(indicator, cfg): how often an indicator flags by chance alone, per crewmember and day (S3, S4). */
export interface ChanceRate {
  indicator_id: string
  worse: Worse
  alerting: boolean
  alpha: number
  /** "nominal": the test's own rate under normal, independent noise; "measured": the indicator's declared multipliers. */
  basis: 'nominal' | 'measured'
  /** alpha / 2 (alpha for worse "either"): the nominal chance rate of a reliable change in the worse direction. */
  nominal_caution_per_day: number
  nominal_flag_per_day: number
  caution_multiplier: number
  flag_multiplier: number
  /** Chance cautions per crewmember-day (0 for a non-alerting indicator, which never cautions). */
  caution_per_day: number
  /** Chance reliable changes in either direction per crewmember-day. */
  flag_per_day: number
  caution_every_n_days: number | null
  flag_every_n_days: number | null
  /** "about 1 in N days per crewmember would flag like this with no real change" (N to two significant figures). */
  text: string
  /** The declaration's own text (how it was measured), or null. */
  note: string | null
  chip: Chip
  source: Source
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
  /** How many of the k indicators alert in either direction (worse "either"): both tails raise a caution. */
  k_either: number
}

// ---- cases (SPEC 3.4 and 5) ----

/** A guided procedure step (SPEC 3.4). */
export interface CaseStep {
  id: string
  text?: string
  input?: { variable: string; unit: string; source?: string; [key: string]: unknown }
  /** OUTCOME waits until this step is done or declined with a reason (D5). */
  required?: boolean
  /** A required yes/no question: "yes" escalates the case at once (D4, D5). */
  red_flag?: boolean
  /** Doing this step releases the ground packet: Prepared (held on board) -> Queued. */
  releases_packet?: boolean
  /** The symptoms a red-flag question asks about, in plain language. */
  red_flags?: string[]
  /** Citation of the step (kept out of the crew-facing text). */
  basis?: Basis & { note?: string }
  [key: string]: unknown
}

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
  procedure?: CaseStep[]
  tripwire?: { reassess_after_s: number; condition: TripwireCondition; text?: string; [key: string]: unknown }
  escalation?: { ground_packet?: boolean; observations?: string[]; [key: string]: unknown } | null
  [key: string]: unknown
}

/** rule or indicator id -> {variable, unit} (triggerLookup). */
export type TriggerLookup = Record<string, { variable: unknown; unit: unknown }>

export type CaseStatus = 'idle' | 'detected' | 'acting' | 'watch' | 'resolved' | 'escalated' | 'dismissed'
export type CaseEventType = 'OPEN' | 'SELECT' | 'STEP' | 'DECLINE' | 'OUTCOME' | 'TICK' | 'DISMISS'

export interface CaseSpec {
  case_id: string
  /** The environment newCase resolved the tripwire for (null: the base condition). */
  env_id?: string | null
  trigger_ids: string[]
  countermeasure_ids: string[]
  step_ids: string[]
  /** Steps marked required, in procedure order. */
  required_step_ids: string[]
  /** Required yes/no steps whose "yes" escalates at once. */
  red_flag_step_ids: string[]
  /** Steps whose completion queues the ground packet (crew release). */
  packet_step_ids: string[]
  /** The declared input of each step that has one. */
  step_inputs: Array<{ step_id: string; variable: string; unit: string }>
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

/** Why and when a case escalated; tier 1 is told now, tier 2 gets the ground packet with the next link (D4). */
export interface CaseEscalation {
  t: number
  reason: 'tripwire' | 'red_flag'
  /** The red-flag step answered "yes", or null for the tripwire. */
  step_id: string | null
  tiers: Array<'crew_medical_officer' | 'flight_surgeon'>
}

/** A closed instance of a case, kept when the case opens again (case_reduce OPEN from a closed state). */
export interface PreviousInstance {
  instance: number
  status: 'resolved' | 'escalated' | 'dismissed'
  opened_at: number | null
  closed_at: number | null
  finding: Finding | null
  outcome: { text: string; t: number } | null
  escalation: CaseEscalation | null
  packet_queued_at: number | null
  dismiss_reason: string | null
}

export interface CaseState {
  schema: 'landfall.case_state/1'
  case_id: string
  crew_id: string
  status: CaseStatus
  spec: CaseSpec
  /** 1 for the first episode; +1 each time OPEN arrives after the instance closed (resolved, escalated, dismissed). */
  instance: number
  /** The closed instances, oldest first. */
  previous_instances: PreviousInstance[]
  opened_at: number | null
  finding: Finding | null
  countermeasure_id: string | null
  steps_done: Array<{ step_id: string; t: number; input: unknown }>
  /** Steps declined with a reason (event DECLINE). */
  steps_declined: Array<{ step_id: string; t: number; reason: string }>
  outcome: { text: string; t: number } | null
  watch_started_at: number | null
  reassess_at: number | null
  tripwire_obs: Array<{ t: number; value: number }>
  tripwire_result: TripwireResult | null
  escalation: CaseEscalation | null
  /** MET when the ground packet went from Prepared (held on board) to Queued: crew release or escalation. */
  packet_queued_at: number | null
  closed_at: number | null
  dismiss_reason: string | null
  updated_at: number | null
  log: CaseLogEntry[]
}

export type CaseEvent =
  | { type: 'OPEN'; t: number; finding: Finding }
  | { type: 'SELECT'; t: number; countermeasure_id: string }
  | { type: 'STEP'; t: number; step_id: string; input?: unknown }
  | { type: 'DECLINE'; t: number; step_id: string; reason: string }
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
