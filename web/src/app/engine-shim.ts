// ENGINE SHIM - temporary stand-in for web/src/engine (the TypeScript engine port, written by
// another workflow). src/app/engine.ts re-exports from here until the lead switches the facade.
//
//   EXACT per engine/SPEC.md section 5: formatMet, sLevel, expectedFalseAlarms.
//   FALLBACK (shell logic, not the engine's): commsEta.
//   STUBS (clearly marked, SPEC-shaped, always 'insufficient_data'): evaluateRule,
//   evaluatePersonal, rci, caseReduce, buildGroundPacket.
//
// Nothing here invents a threshold. Stubs never claim a status other than insufficient_data.
import type { Category, ChipKind, CrewId, Observation, Severity, Source, Status } from './vocab'
import type { Environment } from './scenario'

/** True while the facade points at this shim (the UI can show a "engine not wired" note). */
export const ENGINE_IS_SHIM = true

// ---------------------------------------------------------------------------------------------
// Types (SPEC sections 3 and 5)
// ---------------------------------------------------------------------------------------------

export interface Rule {
  id: string
  label: string
  variable: string
  unit: string
  op: 'lt' | 'le' | 'gt' | 'ge'
  limit: number
  category: Category
  tier: 'A' | 'B'
  role: 'alert' | 'context'
  applies_to: string[]
  window: { kind: string; duration?: string }
  approach_at?: { value: number; chip: ChipKind | string; source: Source }
  chip: ChipKind | string
  source: Source
  action_id?: string
  case_id?: string | null
  notes?: string[]
  [extra: string]: unknown
}

export interface Finding {
  rule_id: string
  tier: 'A' | 'B'
  category: Category
  status: Status
  severity: Severity
  value: number | null
  unit: string
  limit: number | null
  margin: number | null
  chip: ChipKind | string
  source: Source | Record<string, unknown>
  /** Plain-language reasons, rendered in the "Why this fired" expander. */
  why: string[]
}

export interface PersonalIndicator {
  id: string
  label?: string
  variable: string
  unit: string
  worse: 'increase' | 'decrease'
  alerting: boolean
  private: boolean
  reliability_r?: { value: number; chip: ChipKind | string; source: Source | Record<string, unknown> }
  case_id?: string | null
  [extra: string]: unknown
}

export interface RciConfig {
  critical_z: number
  alpha_two_tailed: number
  min_baseline_n: number
  baseline_window_days: number
}

export interface RciResult {
  rc: number | null
  s_diff: number | null
  sem: number | null
  mean: number | null
  sd: number | null
  n: number
  reliable: boolean
  direction: 'increase' | 'decrease' | 'none'
  status?: 'insufficient_data'
}

export type CasePhase = 'detected' | 'acting' | 'watch' | 'resolved' | 'escalated' | 'dismissed'

export type CaseEvent =
  | { type: 'OPEN'; finding: Finding; t: number }
  | { type: 'SELECT'; countermeasure_id: string; t: number }
  | { type: 'STEP'; step_id: string; t: number }
  | { type: 'OUTCOME'; text: string; t: number }
  | { type: 'TICK'; t: number; observations: Observation[] }
  | { type: 'DISMISS'; reason: string; t: number }

export interface CaseLogEntry {
  t: number
  event: CaseEvent['type'] | string
  detail: string
}

export interface CaseState {
  case_id: string
  phase: CasePhase | null
  log: CaseLogEntry[]
  [extra: string]: unknown
}

export interface CommsEta {
  one_way_s: number | null
  round_trip_s: number | null
  blocked: boolean
  reason: string | null
  /** MET seconds when the link is expected back, if known. */
  resumes_at: number | null
}

/** Minimal FHIR R4 Bundle shape (type "collection"). */
export interface FhirBundle {
  resourceType: 'Bundle'
  type: 'collection'
  timestamp?: string
  entry: Array<{ fullUrl?: string; resource: Record<string, unknown> }>
}

export type Consent = Record<string, boolean>

// ---------------------------------------------------------------------------------------------
// Exact implementations
// ---------------------------------------------------------------------------------------------

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/** SPEC section 5: MET seconds -> "dddd/hh:mm:ss" (e.g. 35648400 -> "0412/14:20:00"). */
export function formatMet(seconds: number): string {
  if (!Number.isFinite(seconds)) throw new RangeError(`formatMet: not a finite number of seconds: ${seconds}`)
  const sign = seconds < 0 ? '-' : ''
  const s = Math.floor(Math.abs(seconds))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${sign}${pad(d, 4)}/${pad(h, 2)}:${pad(m, 2)}:${pad(sec, 2)}`
}

/** NOAA S-scale thresholds, >=10 MeV integral proton flux in pfu (S1..S5). */
export const S_THRESHOLDS_PFU = [10, 100, 1e3, 1e4, 1e5] as const

/** SPEC section 5: flux (pfu at >=10 MeV) -> S level 0..5 (highest threshold met, inclusive). */
export function sLevel(fluxPfu: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (!Number.isFinite(fluxPfu)) throw new RangeError(`sLevel: flux must be a finite number of pfu: ${fluxPfu}`)
  let level = 0
  for (const t of S_THRESHOLDS_PFU) if (fluxPfu >= t) level += 1
  return level as 0 | 1 | 2 | 3 | 4 | 5
}

/** SPEC section 5: k·days·alpha expected false alarms, also as "one every N days". */
export function expectedFalseAlarms(
  kIndicators: number,
  days: number,
  alpha = 0.001,
): { expected: number; one_every_days: number } {
  const expected = kIndicators * days * alpha
  const perDay = kIndicators * alpha
  return { expected, one_every_days: perDay > 0 ? 1 / perDay : Number.POSITIVE_INFINITY }
}

// ---------------------------------------------------------------------------------------------
// STUBS - replaced by the real engine. Each returns the SPEC shape with insufficient_data.
// ---------------------------------------------------------------------------------------------

const STUB_WHY = 'Engine not wired yet: shell stub in src/app/engine-shim.ts returns insufficient_data.'

/** STUB. SPEC: evaluate_rule(rule, value, env_id, t) -> Finding. */
export function evaluateRule(rule: Rule, value: number | null, _envId: string, _t: number): Finding {
  return {
    rule_id: rule.id,
    tier: rule.tier,
    category: rule.category,
    status: 'insufficient_data',
    severity: 'advisory',
    value,
    unit: rule.unit,
    limit: rule.limit ?? null,
    margin: null,
    chip: rule.chip,
    source: rule.source,
    why: [STUB_WHY],
  }
}

/** STUB. SPEC: rci(baseline, current, r, critical_z=3.29). */
export function rci(baseline: number[], _current: number, _r: number, _criticalZ = 3.29): RciResult {
  return {
    rc: null,
    s_diff: null,
    sem: null,
    mean: null,
    sd: null,
    n: baseline.length,
    reliable: false,
    direction: 'none',
    status: 'insufficient_data',
  }
}

/** STUB. SPEC: evaluate_personal(indicator, baseline, current, cfg) -> Finding (tier B, PERSONAL). */
export function evaluatePersonal(
  indicator: PersonalIndicator,
  _baseline: number[],
  current: number | null,
  _cfg: RciConfig,
): Finding {
  return {
    rule_id: indicator.id,
    tier: 'B',
    category: 'PERSONAL',
    status: 'insufficient_data',
    severity: 'advisory',
    value: current,
    unit: indicator.unit,
    limit: null,
    margin: null,
    chip: indicator.reliability_r?.chip ?? 'literature',
    source: indicator.reliability_r?.source ?? {},
    why: [STUB_WHY],
  }
}

/** STUB. SPEC: case_reduce(state, event). Never transitions; logs an error entry. */
export function caseReduce(state: CaseState, event: CaseEvent): CaseState {
  return {
    ...state,
    log: [...state.log, { t: event.t, event: event.type, detail: `error: ${STUB_WHY}` }],
  }
}

/** STUB. SPEC: build_ground_packet(case_state, observations, consent, env_id, t) -> FHIR Bundle. */
export function buildGroundPacket(
  _caseState: CaseState | null,
  _observations: Observation[],
  _consent: Consent,
  _envId: string,
  _t: number,
): FhirBundle {
  return { resourceType: 'Bundle', type: 'collection', entry: [] }
}

// ---------------------------------------------------------------------------------------------
// FALLBACK comms (shell logic until the engine's comms_eta lands)
// ---------------------------------------------------------------------------------------------

/**
 * Assumed comms table (the engine owns the real shape): MET-indexed one-way light time samples
 * and blackout windows. `toCommsTable` in src/app/comms.ts tries to build it from the
 * horizons_mars_comms snapshot.
 */
export interface CommsTable {
  samples: Array<{ t: number; one_way_s: number }>
  blackouts: Array<{ start: number; stop: number; reason: string }>
}

/** FALLBACK. SPEC: comms_eta(env, t, comms_table?). */
export function commsEta(env: Environment, t: number, table?: CommsTable | null): CommsEta {
  const owlt = env.comms?.one_way_light_time_s
  if (owlt && 'max' in owlt) {
    // Static environment: the representative value when given, else the envelope maximum.
    const ow = owlt.mean ?? owlt.max
    return { one_way_s: ow, round_trip_s: ow * 2, blocked: false, reason: null, resumes_at: null }
  }
  if (table && table.samples.length > 0) {
    // Linear interpolation between the bracketing samples (samples sorted by t), clamped at the ends.
    const xs = table.samples
    let ow: number
    if (t <= xs[0].t) ow = xs[0].one_way_s
    else if (t >= xs[xs.length - 1].t) ow = xs[xs.length - 1].one_way_s
    else {
      let lo = 0
      let hi = xs.length - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (xs[mid].t <= t) lo = mid
        else hi = mid
      }
      const f = (t - xs[lo].t) / (xs[hi].t - xs[lo].t)
      ow = xs[lo].one_way_s + f * (xs[hi].one_way_s - xs[lo].one_way_s)
    }
    const window = table.blackouts.find((b) => t >= b.start && t < b.stop)
    return {
      one_way_s: ow,
      round_trip_s: ow * 2,
      blocked: Boolean(window),
      reason: window?.reason ?? null,
      resumes_at: window?.stop ?? null,
    }
  }
  // No ephemeris in this build: SPEC 3.1 says this environment has conjunctions and SPEC 7
  // places the scenario "now" inside one. Light time is unknown, so it is reported as null.
  return {
    one_way_s: null,
    round_trip_s: null,
    blocked: env.comms?.conjunction === true,
    reason: env.comms?.conjunction === true ? 'solar_conjunction' : null,
    resumes_at: null,
  }
}

/** Helper type for callers that need a crew-scoped consent map. */
export type ConsentByCrew = Record<CrewId, Consent>
