// Mission evaluation (pure; no React): for the CURRENT environment and MET, every crewmember's
// Tier A findings (thresholds.json, through evaluateRule with the rule's own window), Tier B
// findings (personal.json, through evaluatePersonal against the FIXED scenario baseline, MET days
// 368-381, SPEC 7), the OPS S-level feed, and the annunciator alerts.
//
// The engine expects ALREADY-AGGREGATED values; aggregateForRule() is the window helper:
//   instant            -> the latest observation at or before t
//   rolling_mean PT1H  -> mean of the observations available in (t - 1 h, t]   ([V2 6004] cabin ppCO2)
//   cumulative P30D/P1Y-> sum of the dose reports in (t - D, t] (each report = dose since the previous one)
//                         a variable that is itself a window total of the same length (24-h urine
//                         for P1D) is taken as is, never summed twice
//   career             -> a running "to date" record (career_effective_dose) is taken as is;
//                         otherwise the sum of every report so far
// A summed window (cumulative, or a career sum) whose record starts AFTER the window opens is a
// PARTIAL RECORD (input.partial, D15): unlogged time is not zero dose, so the sum is a lower bound.
// "outside" / "approaching" on it are conclusive; "within" is not (partialRecord() below): it is
// drawn cyan ("missing or stale data", Table F.5-1) with the logged sum against the limit.
//   ratio_to_baseline  -> a value already in "% of pre-mission" is taken as is (percentOfPreMission()
//                         converts raw values); no BMD exists in this scenario
// A rule whose variable has no observation is honestly insufficient_data (cyan); a rule that does
// not apply here is not_applicable (gray). No unit is converted: an observation whose unit differs
// from the rule's is set aside and reported, never coerced.
import {
  OPENING_SEVERITIES,
  RULES,
  evaluatePersonal,
  evaluateRule,
  getEnvironment,
  sLevel,
  sumLR,
  thresholdRules,
} from './engine'
import type { Finding, Indicator, PersonalFinding, RciConfig, Rule } from './engine'
import type { AlertItem } from './mission'
import { lastIndexAtOrBefore, observationDay, observationsFor } from './scenarioData'
import type { ScenarioIndex } from './scenarioData'
import { CREW_IDS, SEVERITY_RANK } from './vocab'
import type { CrewId, EnvId, Observation, Severity } from './vocab'

const DAY_S = 86_400

// ---- durations ----------------------------------------------------------------------------------

/** ISO-8601 duration -> seconds (PnYnDTnHnMnS). A year is 365 days (design choice: Table 4.8-1 says "1 year"). */
export function durationSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null
  const m = /^P(?:(\d+)Y)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso)
  if (!m || iso === 'P' || iso.endsWith('T')) return null
  const [, y, d, h, min, s] = m.map((x) => (x === undefined ? 0 : Number(x)))
  return y * 365 * DAY_S + d * DAY_S + h * 3600 + min * 60 + s
}

// ---- aggregation --------------------------------------------------------------------------------

/** Variables that are already totals over a window of this many seconds (sim_crew cadences: 24-h collections). */
export function ownWindowSeconds(variable: string): number | null {
  return /_24h$/.test(variable) ? DAY_S : null
}

/** Variables recorded as a running career total (sim_crew: "Career effective dose to date"). */
export const TO_DATE_VARIABLES: ReadonlySet<string> = new Set(['career_effective_dose'])

/** 100 x current / pre-mission, the [V1 4027] form ("% of pre-mission"); null when it cannot be computed. */
export function percentOfPreMission(current: number | null, preMission: number | null): number | null {
  if (current === null || preMission === null || !Number.isFinite(current) || !Number.isFinite(preMission) || preMission <= 0) return null
  return (100 * current) / preMission
}

export interface Aggregate {
  /** The aggregated value handed to the engine, or null (-> insufficient_data). */
  value: number | null
  /** The unit of the contributing observations (equal to the rule's unit). */
  unit: string
  /** t of the latest contributing observation. */
  t: number | null
  /** How many observations were combined. */
  n: number
  /** Plain-English description of the aggregation, e.g. "mean of 1 value in the last 1 h". */
  basis: string
  /** Observations set aside because their unit differs from the rule's (never converted). */
  unit_mismatch: number
  /**
   * Summed windows only (cumulative, career sums): true when the record starts after the window opens, so
   * the sum is a lower bound of the window's dose (D15). Always false for other windows.
   */
  partial: boolean
  /** Summed windows: t of the earliest usable report at or before t (any age), else null. */
  record_start: number | null
  /** Summed windows: MET the window opens (t - duration; 0 for a career sum), else null. */
  window_start: number | null
}

function windowLabel(seconds: number): string {
  if (seconds % (365 * DAY_S) === 0) return `${seconds / (365 * DAY_S)} y`
  if (seconds % DAY_S === 0) return `${seconds / DAY_S} d`
  if (seconds % 3600 === 0) return `${seconds / 3600} h`
  return `${seconds} s`
}

/** Aggregate a t-sorted observation list onto a rule's window at MET t (see the header). */
export function aggregateForRule(rule: Pick<Rule, 'variable' | 'unit' | 'window'>, observations: readonly Observation[], t: number): Aggregate {
  const last = lastIndexAtOrBefore(observations, t)
  const kind = rule.window?.kind ?? 'instant'
  const d = kind === 'rolling_mean' || kind === 'cumulative' ? durationSeconds(rule.window?.duration) : null
  // Walk back from t: every usable value (rule unit) until the window start; count unit mismatches.
  const usable: Observation[] = [] // newest first
  let unitMismatch = 0
  const onlyLatest = kind === 'instant' || kind === 'ratio_to_baseline' || (kind === 'career' && TO_DATE_VARIABLES.has(rule.variable))
  for (let i = last; i >= 0; i--) {
    const o = observations[i]
    if (d !== null && o.t <= t - d) break
    if (typeof o.value !== 'number' || !Number.isFinite(o.value)) continue
    if (o.unit !== rule.unit) {
      unitMismatch += 1
      continue
    }
    usable.push(o)
    if (onlyLatest) break
  }
  // Coverage of a summed window (D15): the earliest usable report at or before t, of any age.
  const summed = (kind === 'cumulative' && !(ownWindowSeconds(rule.variable) !== null && ownWindowSeconds(rule.variable) === d)) ||
    (kind === 'career' && !TO_DATE_VARIABLES.has(rule.variable))
  let recordStart: number | null = null
  if (summed) {
    for (let i = 0; i <= last; i++) {
      const o = observations[i]
      if (o.unit === rule.unit && typeof o.value === 'number' && Number.isFinite(o.value)) {
        recordStart = o.t
        break
      }
    }
  }
  const windowStart = !summed ? null : kind === 'career' ? 0 : d === null ? null : t - d
  const coverage = {
    partial: recordStart !== null && windowStart !== null && recordStart > windowStart,
    record_start: recordStart,
    window_start: windowStart,
  }
  const none = (basis: string): Aggregate => ({ value: null, unit: rule.unit, t: null, n: 0, basis, unit_mismatch: unitMismatch, ...coverage })
  const newest = usable[0]
  const one = (basis: string): Aggregate =>
    newest ? { value: newest.value, unit: newest.unit, t: newest.t, n: 1, basis, unit_mismatch: unitMismatch, ...coverage } : none(`no ${rule.variable} value yet`)
  const sum = () => sumLR(usable.slice().reverse().map((o) => o.value))
  const partialNote = coverage.partial ? '; a partial record: the dose before the first report is not logged, so this sum is a lower bound' : ''
  switch (kind) {
    case 'instant':
      return one('latest value')
    case 'ratio_to_baseline':
      return one('latest value, already in % of pre-mission')
    case 'rolling_mean': {
      if (d === null) return none('rolling window without a duration')
      if (!usable.length) return none(`no ${rule.variable} value in the last ${windowLabel(d)}`)
      return { value: sum() / usable.length, unit: rule.unit, t: newest.t, n: usable.length, basis: `mean of ${usable.length} value(s) available in the last ${windowLabel(d)}`, unit_mismatch: unitMismatch, ...coverage }
    }
    case 'cumulative': {
      if (d === null) return none('cumulative window without a duration')
      if (!usable.length) return none(`no ${rule.variable} record in the last ${windowLabel(d)}`)
      const own = ownWindowSeconds(rule.variable)
      if (own !== null && own === d) return one(`latest ${windowLabel(d)} total`)
      return {
        value: sum(),
        unit: rule.unit,
        t: newest.t,
        n: usable.length,
        basis: `sum of ${usable.length} report(s) in the last ${windowLabel(d)}${partialNote || '; doses before the first report are not in this record'}`,
        unit_mismatch: unitMismatch,
        ...coverage,
      }
    }
    case 'career': {
      if (TO_DATE_VARIABLES.has(rule.variable)) return one('latest career-to-date record')
      if (!usable.length) return none(`no ${rule.variable} record`)
      return {
        value: sum(),
        unit: rule.unit,
        t: newest.t,
        n: usable.length,
        basis: `sum of ${usable.length} report(s)${partialNote || '; doses before the first report are not in this record'}`,
        unit_mismatch: unitMismatch,
        ...coverage,
      }
    }
    default:
      return none(`unknown window kind ${kind}`)
  }
}

// ---- findings -----------------------------------------------------------------------------------

export interface RuleEvaluation {
  rule: Rule
  finding: Finding
  input: Aggregate
}

export interface PersonalEvaluation {
  indicator: Indicator
  finding: PersonalFinding
  /** Baseline values used (fixed scenario baseline days). */
  baseline: number[]
  /** The current observation evaluated (latest at or before t), or null. */
  current: Observation | null
}

/** OPS feed: where the >=10 MeV proton flux comes from in this environment. */
export interface OpsFeed {
  /** 'onboard_monitor' where noaa_scale_available is false (Mars), else 'noaa' (GOES, NOAA S-scale). */
  kind: 'onboard_monitor' | 'noaa'
  label: string
  /** Latest flux at or before t (pfu), its t, and the engine's S-level 0..5. */
  flux: number | null
  t: number | null
  s_level: number | null
  /** 'simulated' (sim_crew, up to scenario now) or 'replay' (swpc_spe_replay, after it). */
  provenance: string | null
  /** Every OPS rule evaluated here (the inapplicable ones are not_applicable). */
  findings: RuleEvaluation[]
  /** The applicable OPS rule at the current level (highest S-level rule that is outside), or null. */
  active: RuleEvaluation | null
}

export interface CrewEvaluation {
  crewId: CrewId
  /** Tier A alert rules except OPS (FFD, PEL, POL, TARGET). */
  tierA: RuleEvaluation[]
  /** role: "context" rules: shown, never fire. */
  context: RuleEvaluation[]
  tierB: PersonalEvaluation[]
}

export interface MissionEvaluation {
  envId: EnvId
  t: number
  eva: boolean
  ops: OpsFeed
  crew: Record<CrewId, CrewEvaluation>
  /** Annunciator entries (see alertsFor). */
  alerts: AlertItem[]
  /** Expected false alarms basis: alerting, non-private Tier B indicators. */
  tierBAlertingIndicators: number
}

export function personalIndicators(): Indicator[] {
  const p = RULES.personal
  return Array.isArray(p?.indicators) ? (p!.indicators as Indicator[]) : []
}

export function personalConfig(): RciConfig {
  return RULES.personal!.rci as RciConfig
}

/** Baseline values of a crewmember's indicator: observations whose measurement day is in [first, last]. */
export function baselineValues(observations: readonly Observation[], days: [number, number], unit: string): number[] {
  const out: number[] = []
  for (const o of observations) {
    const d = observationDay(o.t)
    if (d < days[0] || d > days[1]) continue
    if (o.unit !== unit || typeof o.value !== 'number' || !Number.isFinite(o.value)) continue
    out.push(o.value)
  }
  return out
}

function ruleValue(agg: Aggregate, variable: string): { value: number; unit: string; t?: number; variable: string } | null {
  if (agg.value === null) return null
  return agg.t === null ? { value: agg.value, unit: agg.unit, variable } : { value: agg.value, unit: agg.unit, t: agg.t, variable }
}

/** Evaluate one threshold rule for a crewmember at t (window-aggregated). */
export function evaluateRuleAt(
  rule: Rule,
  index: ScenarioIndex,
  runtime: readonly Observation[],
  crewId: CrewId | null,
  envId: EnvId,
  t: number,
  eva = false,
): RuleEvaluation {
  const obs = observationsFor(index, runtime, crewId, rule.variable)
  const input = aggregateForRule(rule, obs, t)
  const finding = evaluateRule(rule, ruleValue(input, rule.variable), envId, t, { eva })
  return { rule, finding, input }
}

/** Evaluate one personal indicator for a crewmember at t against the fixed scenario baseline. */
export function evaluatePersonalAt(
  indicator: Indicator,
  index: ScenarioIndex,
  runtime: readonly Observation[],
  crewId: CrewId,
  t: number,
): PersonalEvaluation {
  const obs = observationsFor(index, runtime, crewId, indicator.variable).filter((o) => o.crew_id === crewId)
  const baseline = baselineValues(obs, index.baselineDays, indicator.unit)
  // Current = the latest value after the baseline period, at or before t.
  let current: Observation | null = null
  for (let i = lastIndexAtOrBefore(obs, t); i >= 0; i--) {
    const o = obs[i]
    if (o.unit === indicator.unit && typeof o.value === 'number' && Number.isFinite(o.value)) {
      current = observationDay(o.t) > index.baselineDays[1] ? o : null
      break
    }
  }
  const cur = current ? { value: current.value, unit: current.unit, t: current.t, variable: indicator.variable } : null
  const finding = evaluatePersonal(indicator, baseline, cur, personalConfig(), t)
  return { indicator, finding, baseline, current }
}

const OPS_VARIABLE = 'proton_flux_10mev'

/** OPS S-level feed for an environment at t. */
export function evaluateOps(index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, t: number, eva = false): OpsFeed {
  const env = getEnvironment(RULES, envId) as { noaa_scale_available?: boolean }
  const onboard = env.noaa_scale_available === false
  const rules = thresholdRules(RULES).filter((r) => r.category === 'OPS')
  const obs = observationsFor(index, runtime, null, OPS_VARIABLE)
  const findings = rules.map((r) => evaluateRuleAt(r, index, runtime, null, envId, t, eva))
  const last = lastIndexAtOrBefore(obs, t)
  const latest = last >= 0 ? obs[last] : null
  let active: RuleEvaluation | null = null
  for (const f of findings) {
    if (f.finding.status !== 'outside') continue
    const lvl = typeof f.rule.s_level === 'number' ? f.rule.s_level : sLevel(f.rule.limit)
    const best = active ? (typeof active.rule.s_level === 'number' ? active.rule.s_level : sLevel(active.rule.limit)) : -1
    if (lvl > best) active = f
  }
  // D3: at Mars the reading comes from an external space-weather monitor above the atmosphere, in Mars orbit,
  // relayed locally ([V2 6165]); sim_crew's own label says so. The vehicle's radiation monitoring system raises
  // the alarm ([V2 6164]); LANDFALL opens the health case.
  const monitor = index.variables[OPS_VARIABLE]?.label ?? 'External space-weather monitor in Mars orbit: >=10 MeV proton flux'
  return {
    kind: onboard ? 'onboard_monitor' : 'noaa',
    label: onboard
      ? `${monitor} (scenario: the GOES-7 October 1989 replay, time-shifted, with no distance or atmosphere correction)`
      : 'NOAA GOES >=10 MeV proton flux (scenario: time-shifted replay of the GOES-7 October 1989 event)',
    flux: latest ? latest.value : null,
    t: latest ? latest.t : null,
    s_level: latest ? sLevel(latest.value) : null,
    provenance: latest ? latest.provenance : null,
    findings,
    active,
  }
}

/** Every crewmember's findings, the OPS feed and the annunciator alerts, for env at MET t. */
export function evaluateMission(index: ScenarioIndex, runtime: readonly Observation[], envId: EnvId, t: number, eva = false): MissionEvaluation {
  getEnvironment(RULES, envId) // throws on an unknown id (the engine is silent on typos)
  const rules = thresholdRules(RULES)
  const indicators = personalIndicators()
  const crew = {} as Record<CrewId, CrewEvaluation>
  for (const crewId of CREW_IDS) {
    const tierA: RuleEvaluation[] = []
    const context: RuleEvaluation[] = []
    for (const rule of rules) {
      if (rule.category === 'OPS') continue
      const ev = evaluateRuleAt(rule, index, runtime, crewId, envId, t, eva)
      ;(rule.role === 'context' ? context : tierA).push(ev)
    }
    const tierB = indicators.map((ind) => evaluatePersonalAt(ind, index, runtime, crewId, t))
    crew[crewId] = { crewId, tierA, context, tierB }
  }
  const ops = evaluateOps(index, runtime, envId, t, eva)
  const tierBAlertingIndicators = indicators.filter((i) => i.alerting && !i.private).length
  const evaluation: MissionEvaluation = { envId, t, eva, ops, crew, alerts: [], tierBAlertingIndicators }
  evaluation.alerts = alertsFor(evaluation)
  return evaluation
}

// ---- partial records (D15) -------------------------------------------------------------------------

/**
 * D15: a summed dose window with incomplete coverage may not claim "within limit". True when the finding
 * is "within" on a partial record: show it cyan as a partial record, with the logged sum against the limit.
 * "outside" and "approaching" on a partial record stay as they are (the full sum can only be higher).
 */
export function partialRecord(ev: { finding: Pick<Finding, 'status'>; input: Pick<Aggregate, 'partial'> }): boolean {
  return ev.input.partial === true && ev.finding.status === 'within'
}

// ---- annunciator ----------------------------------------------------------------------------------

const DATA_QUALITY = new Set(['insufficient_data', 'stale', 'not_applicable'])

function statusWords(f: Finding): string {
  switch (f.status) {
    case 'outside':
      return f.category === 'TARGET' ? 'outside the target' : 'outside'
    case 'approaching':
      return 'approaching'
    case 'reliable_change':
      return 'reliable change against own baseline'
    default:
      return f.status.replace('_', ' ')
  }
}

interface CaseRef {
  id: string
  title: string
}

/** Rule / indicator id -> the case that lists it as a trigger (cases.json triggers), in file order. */
export const TRIGGER_CASE: ReadonlyMap<string, CaseRef> = (() => {
  const m = new Map<string, CaseRef>()
  const defs = (RULES.cases?.cases ?? []) as Array<{ id: string; title?: string; triggers?: Array<{ rule_id?: string; indicator_id?: string }> }>
  for (const c of defs) {
    for (const tr of c.triggers ?? []) {
      const id = tr.rule_id ?? tr.indicator_id
      if (id && !m.has(id)) m.set(id, { id: c.id, title: c.title ?? c.id })
    }
  }
  return m
})()

/** The one-line action of a finding without a deep case (rules `action`, D11), when the rule or indicator has one. */
function actionOf(x: { action?: unknown }): { label: string; text: string } | null {
  const a = x.action as { label?: unknown; text?: unknown } | undefined
  return a && typeof a.label === 'string' && typeof a.text === 'string' ? { label: a.label, text: a.text } : null
}

/**
 * Annunciator policy (documented in app/README.md):
 *   - one entry per crewmember x rule / indicator whose severity is advisory or above;
 *   - never: role "context" rules, private indicators (mood), data-quality states
 *     (insufficient_data / stale / not_applicable are shown in place, cyan / gray, not annunciated);
 *   - OPS: one crew-wide entry for the highest S-level rule that is outside;
 *   - ids `${crew_id}:${rule_id}` (`ALL:<rule_id>` for OPS), so feature publishers merge with these;
 *   - plain-language titles (D7): a finding without a deep case shows its rules `action.label` (D11; the
 *     VO2max floors read "EVA assignment not cleared"), with the rule label and status as `detail`;
 *   - grouping (D16): entries whose rule or indicator triggers the same case, for the same crewmember, share
 *     `group` = `${crew_id}:case:${case_id}`; the mission bar counts and acknowledges groups. Any other
 *     entry is its own group.
 */
/** ">=" and "<=" as the mathematical signs, for crew-facing text. */
const prettyOps = (s: string): string => s.replace(/>=/g, '≥').replace(/<=/g, '≤')

export function alertsFor(e: Pick<MissionEvaluation, 't' | 'ops' | 'crew'>): AlertItem[] {
  const out: AlertItem[] = []
  const add = (crew: CrewId | 'ALL', f: Finding, rawLabel: string, x: { action?: unknown }, refId: string, related: string | null | undefined) => {
    if (SEVERITY_RANK[f.severity as Severity] < SEVERITY_RANK.advisory || DATA_QUALITY.has(f.status)) return
    const label = prettyOps(rawLabel)
    const opens = TRIGGER_CASE.get(refId) ?? null
    const action = opens ? null : actionOf(x)
    const id = `${crew}:${f.rule_id}`
    const caseId = opens?.id ?? related ?? null
    // An OPS rule's label already names the level it reached ("... at the NOAA S3 level"): no status word.
    const ops = f.category === 'OPS' && f.status === 'outside'
    out.push({
      id,
      severity: f.severity as Severity,
      title: action ? action.label : ops ? label : `${label}: ${statusWords(f)}`,
      detail: action ? `${label}: ${statusWords(f)}` : ops && opens ? `Case open: ${opens.title}` : undefined,
      action_text: action?.text,
      crew_id: crew,
      category: f.category,
      href: caseId ? `#/case/${caseId}` : '#/body',
      t: f.t ?? e.t,
      case_id: opens?.id ?? null,
      group: opens ? `${crew}:case:${opens.id}` : id,
      group_title: opens?.title,
    })
  }
  if (e.ops.active) {
    const r = e.ops.active.rule
    add('ALL', e.ops.active.finding, r.label ?? r.id, r, r.id, r.case_id ?? 'spe_shelter')
  }
  for (const crewId of CREW_IDS) {
    const c = e.crew[crewId]
    for (const ev of c.tierA) add(crewId, ev.finding, ev.rule.label ?? ev.rule.id, ev.rule, ev.rule.id, ev.rule.case_id)
    for (const ev of c.tierB) {
      if (ev.indicator.private || ev.finding.status !== 'reliable_change') continue
      add(crewId, ev.finding, ev.indicator.label ?? ev.indicator.id, ev.indicator, ev.indicator.id, ev.indicator.case_id)
    }
  }
  return out
}

/** Severity strong enough to OPEN a case (engine OPENING_SEVERITIES: caution and above). */
export function opensCase(f: Finding): boolean {
  return (OPENING_SEVERITIES as readonly string[]).includes(f.severity)
}
