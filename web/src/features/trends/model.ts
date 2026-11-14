// Trends model (pure; no React). Builds, for one crewmember, every personal indicator's daily series
// with the engine's Tier B verdict at EACH post-baseline point (evaluatePersonalAt, the same call the
// mission model uses at "now"), the personal band read from the engine's finding, and the Tier A
// rules that sit on the same variable, evaluated per point through the engine's window helper.
// Nothing here computes a statistic or holds a NASA number: limits come from the rules JSON, bands
// and verdicts from the engine.
import { RULES, thresholdRules } from '../../app/engine'
import type { Finding, Indicator, PersonalFinding, Rule } from '../../app/engine'
import { evaluatePersonalAt, evaluateRuleAt, personalIndicators } from '../../app/evaluate'
import { observationDay, observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex } from '../../app/scenarioData'
import { SEVERITY_RANK } from '../../app/vocab'
import type { CrewId, EnvId, Observation, Severity } from '../../app/vocab'

const DAY_S = 86_400

export interface PersonalBand {
  mean: number
  lo: number
  hi: number
  /** Critical value and scale the engine reported, when its finding names them (else null). */
  critical: number | null
  scale: number | null
  n: number | null
}

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

/** The statistics block of a Tier B finding (`rci` today; read defensively across engine revisions). */
export function statsBlock(f: PersonalFinding | Finding | null | undefined): Record<string, unknown> | null {
  if (!f) return null
  const rec = f as unknown as Record<string, unknown>
  for (const k of ['rci', 'test', 'stat', 'stats', 'single_case']) {
    const v = rec[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  }
  return null
}

/**
 * Personal band = baseline mean +/- critical x scale, read from the engine's finding: `limit` is the
 * band edge on the worse side (SPEC 5), so the band is symmetric about the mean the engine used.
 * Falls back to critical x scale when the finding has no limit. null when the engine could not
 * test (insufficient data).
 */
export function personalBand(f: PersonalFinding | null | undefined): PersonalBand | null {
  const s = statsBlock(f)
  if (!f || !s) return null
  const mean = num(s.mean)
  if (mean === null) return null
  const critical = num(s.critical_t) ?? num(s.critical_z) ?? num(s.critical) ?? null
  const scale = num(s.s_diff) ?? num(s.se) ?? num(s.s) ?? num(s.scale) ?? null
  const n = num(s.n)
  let half: number | null = null
  const limit = num(f.limit)
  if (limit !== null) half = Math.abs(limit - mean)
  else if (critical !== null && scale !== null) half = critical * scale
  if (half === null) return null
  return { mean, lo: mean - half, hi: mean + half, critical, scale, n }
}

export interface RuleHit {
  rule: Rule
  finding: Finding
}

export interface TrendPoint {
  t: number
  /** MET day the value belongs to (its window END, so a midnight stamp closes the previous day). */
  day: number
  value: number
  baseline: boolean
  /** Engine Tier B verdict at this point (null inside the baseline window). */
  finding: PersonalFinding | null
  /** 'worse' / 'better' when the engine reports a reliable change. */
  flag: 'worse' | 'better' | null
  /** Tier A rules on the same variable at this point, when not within / not applicable. */
  tierA: RuleHit[]
}

export interface SeriesTrend {
  variable: string
  unit: string
  points: TrendPoint[]
  /** Tier A alert rules on this variable (OPS and context rules excluded). */
  rules: Rule[]
  /** Each rule's engine finding at t (status not_applicable = another environment's limit). */
  ruleNow: Map<string, Finding>
  /** Engine error while evaluating Tier A on this series (shown in place, cyan), else null. */
  ruleError: string | null
}

export interface IndicatorTrend extends SeriesTrend {
  indicator: Indicator
  band: PersonalBand | null
  /** Latest Tier B verdict among the points (the "now" one is in useCrewEvaluation()). */
  latest: PersonalFinding | null
  /** Engine error while evaluating Tier B (the values are still drawn, without verdicts). */
  error: string | null
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Tier A findings per point + each rule's finding at t, never throwing (an engine error is reported). */
function tierAFor(
  rules: Rule[],
  obs: readonly Observation[],
  index: ScenarioIndex,
  runtime: readonly Observation[],
  crewId: CrewId | null,
  envId: EnvId,
  t: number,
): { hits: RuleHit[][]; ruleNow: Map<string, Finding>; ruleError: string | null } {
  const hits: RuleHit[][] = obs.map(() => [])
  const ruleNow = new Map<string, Finding>()
  try {
    for (const rule of rules) {
      ruleNow.set(rule.id, evaluateRuleAt(rule, index, runtime, crewId, envId, t).finding)
      obs.forEach((o, i) => {
        const ev = evaluateRuleAt(rule, index, runtime, crewId, envId, o.t)
        if (isMarked(ev.finding)) hits[i].push({ rule, finding: ev.finding })
      })
    }
    return { hits, ruleNow, ruleError: null }
  } catch (e) {
    return { hits: obs.map(() => []), ruleNow, ruleError: message(e) }
  }
}

/** Tier A alert rules on a variable (no OPS, no context). */
export function tierARulesFor(variable: string): Rule[] {
  return thresholdRules(RULES).filter((r) => r.variable === variable && r.role !== 'context' && r.category !== 'OPS')
}

/** A rule hit worth marking: any status other than within / not_applicable, at advisory or above. */
export function isMarked(f: Finding): boolean {
  if (f.status === 'within' || f.status === 'not_applicable') return false
  return SEVERITY_RANK[f.severity as Severity] >= SEVERITY_RANK.advisory
}

function flagOf(f: PersonalFinding | null, ind: Indicator): TrendPoint['flag'] {
  if (!f || f.status !== 'reliable_change') return null
  const dir = f.direction
  if (ind.worse === 'either') return 'worse'
  return dir === ind.worse ? 'worse' : 'better'
}

function ownObservations(index: ScenarioIndex, runtime: readonly Observation[], crewId: CrewId | null, variable: string, unit: string, t: number): Observation[] {
  return observationsFor(index, runtime, crewId, variable).filter(
    (o) => (crewId === null ? true : o.crew_id === crewId) && o.t <= t && o.unit === unit && Number.isFinite(o.value),
  )
}

/** One indicator's daily series for a crewmember up to MET t, with per-point engine verdicts. */
export function buildIndicatorTrend(
  indicator: Indicator,
  index: ScenarioIndex,
  runtime: readonly Observation[],
  crewId: CrewId,
  envId: EnvId,
  t: number,
): IndicatorTrend {
  const obs = ownObservations(index, runtime, crewId, indicator.variable, indicator.unit, t)
  const rules = tierARulesFor(indicator.variable)
  const { hits, ruleNow, ruleError } = tierAFor(rules, obs, index, runtime, crewId, envId, t)
  const [b0, b1] = index.baselineDays
  const points: TrendPoint[] = []
  let latest: PersonalFinding | null = null
  let bandSource: PersonalFinding | null = null
  let error: string | null = null
  obs.forEach((o, i) => {
    const day = observationDay(o.t)
    const baseline = day >= b0 && day <= b1
    let finding: PersonalFinding | null = null
    if (!baseline && error === null) {
      try {
        finding = evaluatePersonalAt(indicator, index, runtime, crewId, o.t).finding
      } catch (e) {
        error = message(e)
      }
    }
    if (finding) {
      latest = finding
      if (finding.status !== 'insufficient_data') bandSource = finding
    }
    points.push({ t: o.t, day, value: o.value, baseline, finding, flag: flagOf(finding, indicator), tierA: hits[i] })
  })
  return { indicator, variable: indicator.variable, unit: indicator.unit, points, rules, ruleNow, ruleError, band: personalBand(bandSource), latest, error }
}

/** A Tier A-only series (no personal indicator), e.g. VO2max or cabin ppCO2 (crewId null = vehicle). */
export function buildRuleSeries(
  variable: string,
  unit: string,
  index: ScenarioIndex,
  runtime: readonly Observation[],
  crewId: CrewId | null,
  envId: EnvId,
  t: number,
): SeriesTrend {
  const obs = ownObservations(index, runtime, crewId, variable, unit, t)
  const rules = tierARulesFor(variable)
  const { hits, ruleNow, ruleError } = tierAFor(rules, obs, index, runtime, crewId, envId, t)
  const [b0, b1] = index.baselineDays
  const points: TrendPoint[] = obs.map((o, i) => {
    const day = observationDay(o.t)
    return { t: o.t, day, value: o.value, baseline: day >= b0 && day <= b1, finding: null, flag: null, tierA: hits[i] }
  })
  return { variable, unit, points, rules, ruleNow, ruleError }
}

/** Alerting, non-private Tier B indicators (the k of expected_false_alarms; same filter as app/evaluate.ts). */
export function alertingIndicatorCount(): number {
  return personalIndicators().filter((i) => i.alerting && !i.private).length
}

/** Indicators charted on #/trends: every non-private indicator (mood is private and never charted here). */
export function chartedIndicators(): { charted: Indicator[]; privateOnes: Indicator[] } {
  const all = personalIndicators()
  return { charted: all.filter((i) => !i.private), privateOnes: all.filter((i) => i.private) }
}

/** Consecutive runs of flagged points, for plain-language summaries ("days 407-412"). */
export function runsOf<T>(points: readonly T[], pick: (p: T) => boolean, dayOf: (p: T) => number): Array<{ from: number; to: number; n: number }> {
  const out: Array<{ from: number; to: number; n: number }> = []
  let cur: { from: number; to: number; n: number } | null = null
  for (const p of points) {
    if (!pick(p)) {
      cur = null
      continue
    }
    const d = dayOf(p)
    if (cur && d <= cur.to + 1) {
      cur.to = d
      cur.n += 1
    } else {
      cur = { from: d, to: d, n: 1 }
      out.push(cur)
    }
  }
  return out
}

export function dayRangeText(r: { from: number; to: number }): string {
  return r.from === r.to ? `day ${r.from}` : `days ${r.from}–${r.to}`
}

/** MET seconds -> fractional MET day (chart x). */
export const toDay = (t: number): number => t / DAY_S
