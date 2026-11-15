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
  /** Baseline mean in the indicator's own unit (the engine's finding.baseline_mean). */
  mean: number
  /** Band edges in the indicator's own unit (the engine's finding.band: the test's band mapped back). */
  lo: number
  hi: number
  /** Critical value and scale (s_diff) the engine reported, on the test scale (else null). */
  critical: number | null
  scale: number | null
  n: number | null
  /** The engine's minimum detectable change (rci.mdc = critical x s_diff): the band's half-width ON THE TEST SCALE (D10). */
  mdc: number | null
  /** The test scale: null for the raw value, "anscombe" for a count tested as 2 * sqrt(x + 3/8) (S2). */
  transform: 'anscombe' | null
  /** The baseline mean on the test scale (rci.mean; equal to `mean` without a transform). */
  testMean: number | null
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
 * The personal band, read from the engine's finding: `band` {low, high} and `baseline_mean` are in the indicator's
 * own unit (for a count tested on the Anscombe scale the band is mapped back, so it is not symmetric about the
 * mean), while critical, s_diff and mdc are on the test scale. A finding without `band` (an older engine) falls
 * back to a band symmetric about rci.mean through the worse-side `limit`, or critical x scale. null when the
 * engine could not test (insufficient data).
 */
export function personalBand(f: PersonalFinding | null | undefined): PersonalBand | null {
  const s = statsBlock(f)
  if (!f || !s) return null
  const critical = num(s.critical_t) ?? num(s.critical_z) ?? num(s.critical) ?? null
  const scale = num(s.s_diff) ?? num(s.se) ?? num(s.s) ?? num(s.scale) ?? null
  const n = num(s.n)
  const transform = s.transform === 'anscombe' ? 'anscombe' : null
  const testMean = num(s.mean)
  const band = (f as Partial<PersonalFinding>).band
  if (band && num(band.low) !== null && num(band.high) !== null) {
    const mean = num((f as Partial<PersonalFinding>).baseline_mean) ?? testMean
    if (mean === null) return null
    return { mean, lo: band.low, hi: band.high, critical, scale, n, mdc: num(s.mdc), transform, testMean }
  }
  if (testMean === null) return null
  let half: number | null = null
  const limit = num(f.limit)
  if (limit !== null) half = Math.abs(limit - testMean)
  else if (critical !== null && scale !== null) half = critical * scale
  if (half === null) return null
  return { mean: testMean, lo: testMean - half, hi: testMean + half, critical, scale, n, mdc: num(s.mdc), transform, testMean }
}

/** Units of quantities that can be negative (a temperature); every other charted indicator cannot, unless it is signed. */
const SIGNED_UNITS: ReadonlySet<string> = new Set(['°C', 'degC', 'Cel'])

/**
 * Whether an indicator's values can be negative: a temperature, an indicator personal.json defines as signed
 * (the sleep midpoint shift, S1: "signed shift ... positive is later, negative is earlier"), or one with a
 * negative value in its series.
 */
export function isSigned(ind: Pick<Indicator, 'unit' | 'definition'>, values: readonly number[] = []): boolean {
  if (SIGNED_UNITS.has(ind.unit)) return true
  if (/^signed\b/i.test(ind.definition?.text ?? '')) return true
  return values.some((v) => v < 0)
}

export interface DisplayBand {
  lo: number
  hi: number
  /** The engine's lower edge was below zero for a quantity that cannot be negative: drawn at 0. */
  clamped: boolean
  /** Why the edge is clamped (shown next to the band), else null. */
  note: string | null
}

/**
 * The band as drawn: the engine's band, with a lower edge below zero clamped at 0 for a quantity that cannot be
 * negative. For a count tested on the Anscombe scale the mapped-back edge is exact and below zero means no fall
 * can be flagged; for a raw normal-theory band it is only an approximation for such data, and the page says so.
 * The verdicts are the engine's, unchanged. A signed indicator (a temperature, the signed midpoint shift) keeps
 * its negative edge.
 */
export function displayBand(band: PersonalBand, unit: string, signed = SIGNED_UNITS.has(unit)): DisplayBand {
  if (band.lo >= 0 || signed) return { lo: band.lo, hi: band.hi, clamped: false, note: null }
  if (band.transform) return { lo: 0, hi: band.hi, clamped: true, note: 'lower edge below zero: no fall can be flagged' }
  return {
    lo: 0,
    hi: band.hi,
    clamped: true,
    note: unit === 'count' ? 'lower edge drawn at 0: counts, approximate' : 'lower edge drawn at 0: the value is never negative, so the band is approximate',
  }
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
  /** Observation provenance: 'simulated' for the scenario, 'manual' / 'measured' for entries this session. */
  provenance: string
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
    points.push({ t: o.t, day, value: o.value, provenance: o.provenance, baseline, finding, flag: flagOf(finding, indicator), tierA: hits[i] })
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
    return { t: o.t, day, value: o.value, provenance: o.provenance, baseline: day >= b0 && day <= b1, finding: null, flag: null, tierA: hits[i] }
  })
  return { variable, unit, points, rules, ruleNow, ruleError }
}

/** Alerting, non-private Tier B indicators (the k of expected_false_alarms; same filter as app/evaluate.ts). */
export function alertingIndicatorCount(): number {
  return personalIndicators().filter((i) => i.alerting && !i.private).length
}

/** Of those, the ones whose worse direction is "either" (glucose): both tails raise a caution (k_either). */
export function alertingEitherCount(): number {
  return personalIndicators().filter((i) => i.alerting && !i.private && i.worse === 'either').length
}

/** Plain-language cadence of the points after the baseline: the median gap between them, in MET days. */
export function cadenceOf(points: readonly TrendPoint[]): 'daily' | 'twice a week' | 'periodic' | null {
  const days = points.filter((p) => !p.baseline).map((p) => p.day)
  if (days.length < 2) return null
  const gaps = days.slice(1).map((d, i) => d - days[i]).sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  if (median <= 1) return 'daily'
  if (median <= 4) return 'twice a week'
  return 'periodic'
}

// ---- the generator's own report (sim_crew data.self_check, data.variables, data.episodes) -----------

interface SelfCheckIndicator {
  indicator_id: string
  baseline_n: number
  baseline_sd: number
  mdc: number
  model_sd: number | null
  mdc_at_model_sd: number | null
}
interface SelfCheckEpisode {
  crew_id: string
  indicator_id: string
  scripted_days: [number, number]
  tier_b_flagged_days: number[]
  tier_b_detection_probability: Record<string, number>
  tier_a?: { rule_id: string; outside_days: number[] }
}
interface Calibration {
  item: string
  value: string
  chip: string
}

/** What the generator says about one crewmember's indicator, for the band line and the episode note. */
export interface ScenarioNote {
  /** The noise model's day-to-day SD for this crewmember (data.self_check per_crew model_sd), or null. */
  modelSd: number | null
  /** Its basis: the calibration entry of that SD (literature, derived or design choice). */
  modelSdChip: string | null
  modelSdItem: string | null
  /** Scripted episodes on this indicator for this crewmember. */
  episodes: Array<{ from: number; to: number; flaggedDays: number[]; pMin: number | null; pMax: number | null; tierAOutsideDays: number[]; tierARule: string | null }>
  /** MET days the scenario scripts a change on this variable for this crewmember (for "chance flag" labels). */
  scriptedDays: ReadonlySet<number>
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null
}

/** Read the generator's self-check for one crewmember and indicator (defensive: null fields when absent). */
export function scenarioNote(simData: unknown, crewId: string, indicatorId: string, variable: string): ScenarioNote {
  const data = asRecord(simData)
  const sc = asRecord(data?.self_check)
  const tb = asRecord(sc?.tier_b)
  const perCrew = asRecord(asRecord(tb?.per_crew)?.[crewId])
  const inds = Array.isArray(perCrew?.indicators) ? (perCrew!.indicators as SelfCheckIndicator[]) : []
  const mine = inds.find((i) => i.indicator_id === indicatorId) ?? null
  const cal = asRecord(asRecord(data?.variables)?.[variable])?.calibration
  // The calibration entry that sets the day-to-day noise: by its item ("day-to-day SD", "night-to-night
  // SD", "day-to-day CV used"), else by its value (a mean "with day-to-day SD 20%", "Poisson counts").
  const cals = Array.isArray(cal) ? (cal as Calibration[]).filter((c) => !/comparison/i.test(c.item)) : []
  const sdEntry =
    cals.find((c) => /(day-to-day|night-to-night) (SD|CV)/i.test(c.item)) ??
    cals.find((c) => /\b(SD|CV)\b|Poisson/.test(c.value)) ??
    null
  const eps = Array.isArray(tb?.episodes) ? (tb!.episodes as SelfCheckEpisode[]) : []
  const episodes = eps
    .filter((e) => e.crew_id === crewId && e.indicator_id === indicatorId)
    .map((e) => {
      const ps = Object.values(e.tier_b_detection_probability ?? {}).filter((v) => typeof v === 'number')
      return {
        from: e.scripted_days[0],
        to: e.scripted_days[1],
        flaggedDays: e.tier_b_flagged_days ?? [],
        pMin: ps.length ? Math.min(...ps) : null,
        pMax: ps.length ? Math.max(...ps) : null,
        tierAOutsideDays: e.tier_a?.outside_days ?? [],
        tierARule: e.tier_a?.rule_id ?? null,
      }
    })
  const scripted = new Set<number>()
  const simEps = Array.isArray(data?.episodes) ? (data!.episodes as Array<{ crew_id?: string; scripted_values?: Record<string, Record<string, number>> }>) : []
  for (const e of simEps) {
    if (e.crew_id !== crewId) continue
    for (const d of Object.keys(e.scripted_values?.[variable] ?? {})) scripted.add(Number(d))
  }
  return {
    modelSd: mine && typeof mine.model_sd === 'number' ? mine.model_sd : null,
    modelSdChip: sdEntry?.chip ?? null,
    modelSdItem: sdEntry ? `${sdEntry.item}: ${sdEntry.value}` : null,
    episodes,
    scriptedDays: scripted,
  }
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
