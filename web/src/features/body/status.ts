// Region status: pure functions over the mission evaluation (app/model useEvaluation, the same engine
// findings the annunciator, Trends and the cases read) and the case views (useCases). The rule is
// meta.json `body_region_rule` (D6):
//   - an organ's FILL comes only from measured findings of the selected crewmember on that region:
//     the Tier A rules joined to it and the Tier B indicators listed for it. Data-quality states never
//     look nominal: a region whose findings all lack data is `no_data`, not green;
//   - a case's body_regions are its HAZARD FOOTPRINT: an open case outlines those regions (hatched,
//     the procedure colour), it never fills them with a severity;
//   - VO2max is a whole-body FITNESS TAG ("EVA fitness floor not met"), never an organ finding.
import type { Finding, PersonalFinding, Rule } from '../../app/engine'
import type { CaseView } from '../../app/caseTimeline'
import { partialRecord } from '../../app/evaluate'
import type { Aggregate, CrewEvaluation } from '../../app/evaluate'
import { SEVERITY_RANK } from '../../app/vocab'
import type { Observation, Severity, Status } from '../../app/vocab'
import { isFitnessRule, ruleApplies, rulesForRegion } from './regions'
import type { RegionDef, RegionId } from './regions'
import type { PersonalIndicatorDef } from './rules'

// ---------------------------------------------------------------------------------------------
// Rows of one region, read from the crewmember's evaluation
// ---------------------------------------------------------------------------------------------

export interface RuleRow {
  rule: Rule
  /** applies_to includes this environment (else the rule is listed under "other environments"). */
  applicable: boolean
  finding: Finding
  /** The window aggregate the engine was given (value, unit, t, basis, unit mismatches). */
  input: Aggregate
  /** A fitness-tag rule (VO2max): shown, never folded into the organ's fill. */
  fitness: boolean
}

export interface IndicatorRow {
  indicator: PersonalIndicatorDef
  finding: PersonalFinding
  /** Number of baseline values the engine used (fixed scenario baseline). */
  baselineN: number
  /** The observation the engine tested (latest after the baseline, at or before t), or null. */
  current: Observation | null
}

/** Tier A rules of a region (Table 4.8-1 organ limits by body_region, others by variable), as evaluated. */
export function regionRuleRows(region: RegionDef, crew: CrewEvaluation | null, envId: string): RuleRow[] {
  if (!crew) return []
  const wanted = new Set(rulesForRegion(region, crew.tierA.map((e) => e.rule)).map((r) => r.id))
  return crew.tierA
    .filter((e) => wanted.has(e.rule.id))
    .map((e) => ({ rule: e.rule, applicable: ruleApplies(e.rule, envId), finding: e.finding, input: e.input, fitness: isFitnessRule(e.rule) }))
}

/** Tier B indicators of a region, in the region's own order (mood is never one of them). */
export function regionIndicatorRows(region: RegionDef, crew: CrewEvaluation | null): IndicatorRow[] {
  if (!crew) return []
  const out: IndicatorRow[] = []
  for (const id of region.indicators) {
    const ev = crew.tierB.find((e) => e.indicator.id === id)
    if (!ev || ev.indicator.private) continue
    out.push({ indicator: ev.indicator as PersonalIndicatorDef, finding: ev.finding, baselineN: ev.baseline.length, current: ev.current })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Region summary (the organ's fill)
// ---------------------------------------------------------------------------------------------

export type RegionState = 'warning' | 'caution' | 'advisory' | 'nominal' | 'no_data' | 'unmonitored'

export interface Driver {
  label: string
  severity: Severity
  status: Status
}

export interface RegionSummary {
  state: RegionState
  severity: Severity | null
  /** Findings with a real status (not insufficient_data / stale / not_applicable). */
  evaluated: number
  /** Findings reporting insufficient_data or stale ([V2 10020]). */
  missing: number
  total: number
  /** The measured findings above nominal that set the fill, worst first. */
  drivers: Driver[]
}

const DATA_STATUSES: ReadonlySet<Status> = new Set<Status>(['insufficient_data', 'stale'])

export interface SummaryInput {
  label: string
  finding: Pick<Finding, 'status' | 'severity'> | null
}

/** Fold measured findings into one state: the worst evaluated severity; no evaluable finding = no_data. */
export function summarizeRegion(items: readonly SummaryInput[]): RegionSummary {
  let severity: Severity | null = null
  let evaluated = 0
  let missing = 0
  const drivers: Driver[] = []
  for (const { label, finding: f } of items) {
    if (!f || f.status === 'not_applicable') continue
    if (DATA_STATUSES.has(f.status)) {
      missing += 1
      continue
    }
    evaluated += 1
    if (severity === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[severity]) severity = f.severity
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK.nominal) drivers.push({ label, severity: f.severity, status: f.status })
  }
  drivers.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const total = evaluated + missing
  let state: RegionState
  if (severity !== null) state = severity === 'emergency' ? 'warning' : severity
  else state = total === 0 ? 'unmonitored' : 'no_data'
  return { state, severity, evaluated, missing, total, drivers }
}

/** The organ's measured findings: every rule and indicator row except the fitness tag. */
export function summaryInputs(ruleRows: readonly RuleRow[], indicatorRows: readonly IndicatorRow[]): SummaryInput[] {
  return [
    // A partial dose record that reads "within" is not evidence of compliance (D15): it counts as missing data
    // (cyan), never as a nominal fill. "outside" / "approaching" on it are conclusive and fill as usual.
    ...ruleRows
      .filter((r) => !r.fitness)
      .map((r) => ({
        label: r.rule.label ?? r.rule.id,
        finding: partialRecord(r) ? { status: 'insufficient_data' as Status, severity: 'advisory' as Severity } : r.finding,
      })),
    ...indicatorRows.map((r) => ({ label: r.indicator.label ?? r.indicator.id, finding: r.finding })),
  ]
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

// ---------------------------------------------------------------------------------------------
// Hazard footprint (open cases) and the fitness tag
// ---------------------------------------------------------------------------------------------

/** Case states whose hazard footprint is drawn: open (detected, acting, watch) or escalated. */
export const FOOTPRINT_STATUSES: ReadonlySet<string> = new Set(['detected', 'acting', 'watch', 'escalated'])

export interface FootprintCase {
  caseId: string
  title: string
  status: string
}

function bodyRegionsOf(def: unknown): string[] {
  const r = (def as { body_regions?: unknown } | null)?.body_regions
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []
}

const openedAt = (v: CaseView): number => v.state.opened_at ?? v.opening?.t ?? Number.NEGATIVE_INFINITY

/**
 * The view to show for one case among a crewmember's views: an open (or escalated) instance first,
 * then the most recently opened one. A case can open again after it resolves (a new episode is a new
 * instance), so one crewmember can have several views of the same case; the page shows one line each.
 */
export function caseViewFor(views: readonly CaseView[], caseId: string): CaseView | null {
  let best: CaseView | null = null
  for (const v of views) {
    if (v.caseId !== caseId) continue
    if (best === null) {
      best = v
      continue
    }
    const open = FOOTPRINT_STATUSES.has(v.state.status)
    const bestOpen = FOOTPRINT_STATUSES.has(best.state.status)
    if (open !== bestOpen ? open : openedAt(v) >= openedAt(best)) best = v
  }
  return best
}

/** The open cases of one crewmember whose hazard footprint covers a region (one entry per case). */
export function footprintFor(regionId: RegionId, views: readonly CaseView[], crewId: string): FootprintCase[] {
  const own = views.filter((v) => v.crewId === crewId)
  const out: FootprintCase[] = []
  for (const caseId of new Set(own.map((v) => v.caseId))) {
    const v = caseViewFor(own, caseId)
    if (!v || !FOOTPRINT_STATUSES.has(v.state.status) || !bodyRegionsOf(v.def).includes(regionId)) continue
    out.push({ caseId: v.caseId, title: typeof v.def.title === 'string' ? v.def.title : v.caseId, status: v.state.status })
  }
  return out
}

export type FitnessState = 'not_cleared' | 'cleared' | 'no_data'

export interface FitnessTag {
  state: FitnessState
  /** The floor that applies in this environment. */
  rule: Rule
  finding: Finding
  input: Aggregate
  /** Crew-facing label: the rule's action label when the floor is not met ("EVA fitness floor not met"). */
  label: string
  /** The one-line action (thresholds.json action.text) when not cleared, else null. */
  action: string | null
}

/**
 * The whole-body fitness tag for the crewmember: the VO2max floor that applies in this environment
 * (ffd_vo2max_surface_eva on the surface, ffd_vo2max_microgravity_eva in microgravity). null when no
 * fitness rule applies here.
 */
export function fitnessTag(crew: CrewEvaluation | null, envId: string): FitnessTag | null {
  if (!crew) return null
  const rows = crew.tierA.filter((e) => isFitnessRule(e.rule) && ruleApplies(e.rule, envId))
  if (!rows.length) return null
  const worst = rows.reduce((a, b) => (SEVERITY_RANK[b.finding.severity] > SEVERITY_RANK[a.finding.severity] ? b : a))
  const f = worst.finding
  const state: FitnessState = DATA_STATUSES.has(f.status) ? 'no_data' : f.status === 'outside' || f.status === 'approaching' ? 'not_cleared' : 'cleared'
  const action = worst.rule.action
  const label =
    state === 'not_cleared' ? (action?.label ?? 'EVA fitness floor not met') : state === 'cleared' ? 'EVA fitness floor met' : 'No VO₂max test on record'
  return { state, rule: worst.rule, finding: f, input: worst.input, label, action: state === 'not_cleared' && action ? actionSentence(action) : null }
}

/** An action's text without its own label in front ("EVA fitness floor not met: this ..." -> "This ..."). */
export function actionSentence(action: { label: string; text: string }): string {
  const rest = action.text.replace(new RegExp(`^${escapeRe(action.label)}:\\s*`), '')
  return rest ? rest[0].toUpperCase() + rest.slice(1) : action.text
}

function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
