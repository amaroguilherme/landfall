// Region status: pure functions that turn simulated crew series + runtime observations into
// engine calls (through an injected evaluator, normally the app/engine facade), and fold the
// findings into one worst-severity state per region. Data-quality states (insufficient_data,
// stale) never look like "nominal": a region with nothing evaluable is `no_data`, not green.
import type { Finding, PersonalIndicator, RciConfig, Rule } from '../../app/engine'
import type { AlertItem } from '../../app/mission'
import { SEVERITY_RANK } from '../../app/vocab'
import type { Observation, Severity, Status } from '../../app/vocab'
import type { CaseDef, PersonalIndicatorDef } from './rules'
import { ruleApplies } from './regions'
import type { RegionId } from './regions'

// ---------------------------------------------------------------------------------------------
// Simulated crew series (web/public/data/sim_crew.json, data.observation_format)
// ---------------------------------------------------------------------------------------------

export interface SimSeries {
  unit: string
  source: string
  /** Per-sample MET seconds, or start_t + i * step_s. */
  t?: number[]
  start_t?: number
  step_s?: number
  v: Array<number | null>
}

export interface SimCrewData {
  crew: Array<{ crew_id: string; role?: string; series: Record<string, SimSeries> }>
  vehicle?: { series: Record<string, SimSeries> }
}

export interface Point {
  t: number
  value: number
  unit: string
  source: string
}

const DAY_S = 86_400

/** Expand one series into points (null samples are gaps and are skipped). */
export function seriesPoints(s: SimSeries): Point[] {
  const out: Point[] = []
  for (let i = 0; i < s.v.length; i++) {
    const v = s.v[i]
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    const t = s.t ? s.t[i] : (s.start_t ?? 0) + i * (s.step_s ?? 0)
    if (t === undefined) continue
    out.push({ t, value: v, unit: s.unit, source: s.source })
  }
  return out
}

function crewSeries(sim: SimCrewData | null, crewId: string, variable: string): SimSeries | null {
  if (!sim) return null
  const member = sim.crew.find((c) => c.crew_id === crewId)
  return member?.series[variable] ?? sim.vehicle?.series[variable] ?? null
}

/**
 * Latest value of `variable` for the crewmember at or before MET `t`: crew series first, then
 * vehicle series (cabin CO2, proton monitor), then runtime observations added in the app.
 */
export function latestPoint(
  sim: SimCrewData | null,
  crewId: string,
  variable: string,
  t: number,
  extra: readonly Observation[] = [],
): Point | null {
  let best: Point | null = null
  const s = crewSeries(sim, crewId, variable)
  if (s) {
    for (const p of seriesPoints(s)) if (p.t <= t && (!best || p.t >= best.t)) best = p
  }
  for (const o of extra) {
    if (o.crew_id !== crewId || o.variable !== variable || o.t > t || !Number.isFinite(o.value)) continue
    if (!best || o.t >= best.t) best = { t: o.t, value: o.value, unit: o.unit, source: o.source }
  }
  return best
}

/** Baseline sample for Tier B: values whose MET day is within [firstDay, lastDay]. */
export function baselineValues(sim: SimCrewData | null, crewId: string, variable: string, firstDay: number, lastDay: number): number[] {
  const s = crewSeries(sim, crewId, variable)
  if (!s) return []
  return seriesPoints(s)
    .filter((p) => {
      const d = Math.floor(p.t / DAY_S)
      return d >= firstDay && d <= lastDay
    })
    .map((p) => p.value)
}

// ---------------------------------------------------------------------------------------------
// Evaluation through an injected engine
// ---------------------------------------------------------------------------------------------

export interface Evaluator {
  evaluateRule: (rule: Rule, value: number | null, envId: string, t: number) => Finding
  evaluatePersonal: (indicator: PersonalIndicator, baseline: number[], current: number | null, cfg: RciConfig) => Finding
}

export interface EvalContext {
  sim: SimCrewData | null
  crewId: string
  envId: string
  t: number
  extra: readonly Observation[]
  evaluator: Evaluator
  rci: RciConfig | null
  baselineDays: [number, number]
}

export interface RuleRow {
  rule: Rule
  applicable: boolean
  point: Point | null
  /** The observation's unit differs from the rule's: never compared (SPEC 4, no silent conversion). */
  unitMismatch: boolean
  /** null when not applicable in this environment (shown grey, not evaluated). */
  finding: Finding | null
}

export function evaluateRuleRow(rule: Rule, ctx: EvalContext): RuleRow {
  const applicable = ruleApplies(rule, ctx.envId)
  const point = latestPoint(ctx.sim, ctx.crewId, rule.variable, ctx.t, ctx.extra)
  const unitMismatch = point !== null && point.unit !== rule.unit
  if (!applicable) return { rule, applicable, point, unitMismatch, finding: null }
  const value = point && !unitMismatch ? point.value : null
  return { rule, applicable, point, unitMismatch, finding: ctx.evaluator.evaluateRule(rule, value, ctx.envId, ctx.t) }
}

export interface IndicatorRow {
  indicator: PersonalIndicatorDef
  point: Point | null
  baselineN: number
  finding: Finding | null
}

export function evaluateIndicatorRow(indicator: PersonalIndicatorDef, ctx: EvalContext): IndicatorRow {
  const point = latestPoint(ctx.sim, ctx.crewId, indicator.variable, ctx.t, ctx.extra)
  const baseline = baselineValues(ctx.sim, ctx.crewId, indicator.variable, ctx.baselineDays[0], ctx.baselineDays[1])
  if (!ctx.rci) return { indicator, point, baselineN: baseline.length, finding: null }
  const current = point && point.unit === indicator.unit ? point.value : null
  return {
    indicator,
    point,
    baselineN: baseline.length,
    finding: ctx.evaluator.evaluatePersonal(indicator, baseline, current, ctx.rci),
  }
}

// ---------------------------------------------------------------------------------------------
// Cases: open when any trigger reports severity >= caution (SPEC 3.4)
// ---------------------------------------------------------------------------------------------

export interface Signal {
  severity: Severity
  reason: string
  caseId?: string
}

const OPEN_PHASES = new Set(['detected', 'acting', 'watch', 'escalated'])

export interface CaseLookups {
  rule: (id: string) => Rule | undefined
  indicator: (id: string) => PersonalIndicatorDef | undefined
}

export interface CaseStatus {
  caseId: string
  open: boolean
  severity: Severity | null
  reasons: string[]
}

export function caseStatus(
  caseDef: CaseDef,
  ctx: EvalContext,
  lookups: CaseLookups,
  storeState?: { phase?: unknown; status?: unknown } | null,
): CaseStatus {
  let severity: Severity | null = null
  const reasons: string[] = []
  for (const trig of caseDef.triggers) {
    let finding: Finding | null = null
    let label = ''
    if ((trig.kind === 'rule' || trig.kind === 'ops') && trig.rule_id) {
      const rule = lookups.rule(trig.rule_id)
      if (!rule) continue
      label = rule.label
      finding = evaluateRuleRow(rule, ctx).finding
    } else if (trig.kind === 'personal' && trig.indicator_id) {
      const ind = lookups.indicator(trig.indicator_id)
      if (!ind) continue
      label = ind.label
      finding = evaluateIndicatorRow(ind, ctx).finding
    }
    if (!finding || finding.status === 'insufficient_data' || finding.status === 'stale' || finding.status === 'not_applicable') continue
    if (SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.caution) {
      if (severity === null || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[severity]) severity = finding.severity
      reasons.push(`${label}: ${finding.status.replace(/_/g, ' ')}`)
    }
  }
  const phase = storeState ? String(storeState.phase ?? storeState.status ?? '') : ''
  if (OPEN_PHASES.has(phase)) {
    if (severity === null) severity = 'caution'
    reasons.push(`case is ${phase}`)
  }
  return { caseId: caseDef.id, open: severity !== null, severity, reasons }
}

/**
 * Alerts other views published to the annunciator that concern this region: an alert linking to
 * one of the region's cases (#/case/<id>) or carrying one of its rule ids (`${crew}:${rule_id}`).
 */
export function alertSignals(
  alerts: readonly AlertItem[],
  crewId: string,
  caseIds: ReadonlySet<string>,
  ruleIds: ReadonlySet<string>,
): Signal[] {
  const out: Signal[] = []
  for (const a of alerts) {
    if (a.crew_id && a.crew_id !== 'ALL' && a.crew_id !== crewId) continue
    if (a.severity === 'nominal') continue
    const caseId = a.href?.match(/#\/case\/([\w-]+)/)?.[1]
    const ruleId = a.id.includes(':') ? a.id.slice(a.id.indexOf(':') + 1) : a.id
    if ((caseId && caseIds.has(caseId)) || ruleIds.has(ruleId)) {
      out.push({ severity: a.severity, reason: `Annunciator: ${a.title}`, caseId })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Region summary
// ---------------------------------------------------------------------------------------------

export type RegionState = 'warning' | 'caution' | 'advisory' | 'nominal' | 'no_data' | 'unmonitored'

export interface RegionSummary {
  state: RegionState
  severity: Severity | null
  /** Findings with a real status (not insufficient_data / stale / not_applicable). */
  evaluated: number
  /** Findings reporting insufficient_data or stale ([V2 10020]). */
  missing: number
  total: number
  reasons: string[]
}

const DATA_STATUSES: ReadonlySet<Status> = new Set<Status>(['insufficient_data', 'stale'])

export function summarizeRegion(
  findings: ReadonlyArray<Pick<Finding, 'status' | 'severity'> | null>,
  signals: readonly Signal[] = [],
): RegionSummary {
  let severity: Severity | null = null
  let evaluated = 0
  let missing = 0
  const bump = (s: Severity) => {
    if (severity === null || SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s
  }
  for (const f of findings) {
    if (!f || f.status === 'not_applicable') continue
    if (DATA_STATUSES.has(f.status)) {
      missing += 1
      continue
    }
    evaluated += 1
    bump(f.severity)
  }
  const reasons: string[] = []
  for (const s of signals) {
    bump(s.severity)
    reasons.push(s.reason)
  }
  const total = evaluated + missing
  let state: RegionState
  if (severity !== null) state = severity === 'emergency' ? 'warning' : severity
  else state = total === 0 ? 'unmonitored' : 'no_data'
  return { state, severity, evaluated, missing, total, reasons }
}

export const STATE_LABEL: Record<RegionState, string> = {
  warning: 'Warning',
  caution: 'Caution',
  advisory: 'Advisory',
  nominal: 'Nominal',
  no_data: 'Insufficient data',
  unmonitored: 'Observed only',
}

/** Order used to pick the default region: worst state first. */
export const STATE_RANK: Record<RegionState, number> = {
  warning: 5,
  caution: 4,
  advisory: 3,
  no_data: 2,
  nominal: 1,
  unmonitored: 0,
}

/** Tie-break for the default region when several share the worst state (the hero is the SPE). */
const DEFAULT_PREFERENCE: RegionId[] = ['blood_forming_organs', 'kidneys', 'brain', 'heart', 'skeleton', 'eyes', 'skin', 'lungs', 'muscles', 'immune']

/** Region shown when the URL names none: the worst state, ties broken by DEFAULT_PREFERENCE. */
export function defaultRegion(states: Record<RegionId, RegionState>): RegionId {
  let best: RegionId = DEFAULT_PREFERENCE[0]
  for (const id of DEFAULT_PREFERENCE) if (STATE_RANK[states[id]] > STATE_RANK[states[best]]) best = id
  return best
}
