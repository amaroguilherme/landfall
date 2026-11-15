// Pure helpers for the case views (no React). Every number shown by the cases feature comes from
// the rules JSON, a frozen snapshot or the engine; these helpers only look things up, format, and
// pick. Nothing here re-implements an engine statistic or a case transition: required steps,
// declines, red flags and escalation are decided by the engine's caseReduce; these helpers read its state.
import { NOAA_S_THRESHOLDS_PFU, RULES, compare, formatMet, getIndicator, sLevel, thresholdRules } from '../../app/engine'
import type { CaseState, CaseStatus, Indicator, Op, Rule, Source } from '../../app/engine'
import { tierOneFor } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import { CHIP_DEFS, CREW, CREW_IDS, SEVERITY_RANK, isCrewId } from '../../app/vocab'
import type { CrewId, Observation, Severity } from '../../app/vocab'
import type { CaseDefFull, EscalationMeta, HrrRisk, PacketStateDef, SimSelfCheck, StepDef, UnscriptedOpening } from './types'

const DAY_S = 86_400

/** Display symbols for a rule op (presentation only; the engine's own text uses ASCII). */
export const OP_TEXT: Record<Op, string> = { lt: '<', le: '≤', gt: '>', ge: '≥' }

/** Plain-English compliant condition for an op (the engine exports the same words as OP_WORDS). */
export const OP_WORDS: Record<Op, string> = {
  lt: 'below',
  le: 'at or below',
  gt: 'above',
  ge: 'at or above',
}

/** The op that breaks a compliant condition: a ceiling "below 1000" is outside "at or above 1000". */
export const OUTSIDE_OP: Record<Op, Op> = { lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' }

// ---- crew selection ----------------------------------------------------------------------------

/**
 * Which crewmember a case view shows: the ?crew= query when valid; else the store's crewmember when
 * that crewmember's case is open (not idle); else the first crewmember whose case is not idle; else
 * the store's crewmember. So #/case/renal_stone (from the annunciator) lands on CM-3's open case.
 */
export function pickCrew(caseId: string, views: readonly CaseView[], queryCrew: string | undefined, storeCrew: CrewId): CrewId {
  if (isCrewId(queryCrew)) return queryCrew
  const of = (c: CrewId) => views.find((v) => v.caseId === caseId && v.crewId === c)
  if (of(storeCrew) && of(storeCrew)!.state.status !== 'idle') return storeCrew
  for (const c of CREW_IDS) {
    const v = of(c)
    if (v && v.state.status !== 'idle') return c
  }
  return storeCrew
}

// ---- status words ------------------------------------------------------------------------------

export const STATUS_WORD: Record<CaseStatus, string> = {
  idle: 'Not open',
  detected: 'Detected',
  acting: 'Acting',
  watch: 'Watch: tripwire armed',
  resolved: 'Resolved',
  escalated: 'Escalated',
  dismissed: 'Dismissed',
}

export const OPEN: readonly CaseStatus[] = ['detected', 'acting', 'watch']

export function isOpen(s: CaseStatus): boolean {
  return OPEN.includes(s)
}

/** Seconds as "72 h", "6 h", "90 min", "2 h 30 min" (used for reassess_after_s). */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s % 3600 === 0) return `${s / 3600} h`
  if (s % 60 === 0 && s < 3600) return `${s / 60} min`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h} h ${String(m).padStart(2, '0')} min`
}

/**
 * A countdown in the mission's duration format, d/hh:mm:ss with no leading zeros in the day field
 * (NASA-STD-3001 Vol 2 Appendix F F.6.1 f, via the engine's formatMet): "0/17:39:52", "11/05:59:51".
 * Negative input counts as 0.
 */
export function formatTMinus(seconds: number): string {
  return formatMet(Math.max(0, Math.floor(seconds)))
}

/** Chip label (from meta.json) for a SPEC source kind, e.g. literature -> "literature". */
export function chipForKind(kind: unknown): string | null {
  return CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? null
}

// ---- steps: done, declined, open (the engine decides; this only reads its state) ---------------------

export type StepState = 'done' | 'declined' | 'open'

export function stepState(s: CaseState, stepId: string): StepState {
  if (s.steps_done.some((d) => d.step_id === stepId)) return 'done'
  if (s.steps_declined.some((d) => d.step_id === stepId)) return 'declined'
  return 'open'
}

/** Required steps that are neither done nor declined: while any is left the engine refuses OUTCOME. */
export function pendingRequired(s: CaseState): string[] {
  return s.spec.required_step_ids.filter((id) => stepState(s, id) === 'open')
}

/** The first step, in procedure order, that is neither done nor declined (null when every step is settled). */
export function nextOpenStep(s: CaseState): string | null {
  return s.spec.step_ids.find((id) => stepState(s, id) === 'open') ?? null
}

/** 1-based position of a step in the procedure (0 when unknown). */
export function stepNumber(def: CaseDefFull, stepId: string): number {
  return (def.procedure ?? []).findIndex((x) => x.id === stepId) + 1
}

export function stepDef(def: CaseDefFull, stepId: string | null): StepDef | null {
  return stepId ? ((def.procedure ?? []).find((x) => x.id === stepId) ?? null) : null
}

/** "step 2", "steps 2 and 3", "steps 1, 2 and 4". */
export function stepList(def: CaseDefFull, ids: readonly string[]): string {
  const n = ids.map((id) => String(stepNumber(def, id) || id))
  if (n.length <= 1) return `step ${n[0] ?? ''}`.trim()
  return `steps ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`
}

/** The yes/no answer stored with a done step's input (true / false / 1 / 0), or null. */
export function answerOf(input: unknown): boolean | null {
  const v = input && typeof input === 'object' ? (input as { value?: unknown }).value : undefined
  if (v === true || v === 1) return true
  if (v === false || v === 0) return false
  return null
}

// ---- loop stages ---------------------------------------------------------------------------------

export type StageId = 'detect' | 'interpret' | 'act' | 'procedure' | 'outcome' | 'tripwire' | 'close'
export type StageState = 'done' | 'current' | 'todo' | 'skipped'

export interface Stage {
  id: StageId
  label: string
  state: StageState
  /** MET when the stage was completed, when known. */
  t: number | null
  /** Short status text ("3 of 5", "armed"). */
  note: string | null
}

/** Where a case state sits in detect -> interpret -> act -> procedure -> outcome -> tripwire -> close. */
export function stagesOf(s: CaseState): Stage[] {
  const st = s.status
  const nSteps = s.spec.step_ids.length
  const selectT = s.log.find((e) => e.event === 'SELECT' && e.error === null)?.t ?? null
  const opened = st !== 'idle'
  const selected = s.countermeasure_id !== null
  const outcome = s.outcome !== null
  const closed = st === 'resolved' || st === 'escalated' || st === 'dismissed'
  const judged = s.tripwire_result !== null
  const redFlag = s.escalation?.reason === 'red_flag'
  const cur = (cond: boolean, done: boolean): StageState => (done ? 'done' : cond ? 'current' : 'todo')
  const dismissed = st === 'dismissed'
  const declined = s.steps_declined.length
  const pending = pendingRequired(s).length
  const procNote = selected ? `${s.steps_done.length} of ${nSteps}${declined ? ` · ${declined} declined` : ''}` : null
  const stages: Stage[] = [
    { id: 'detect', label: 'Detect', state: opened ? 'done' : 'todo', t: s.opened_at, note: opened ? null : 'watching' },
    { id: 'interpret', label: 'Interpret', state: opened ? 'done' : 'todo', t: s.opened_at, note: null },
    // soft hyphen: the stepper label may break on a phone (Counter-measure) instead of being cut
    { id: 'act', label: 'Counter\u00admeasure', state: cur(st === 'detected', selected), t: selectT, note: null },
    {
      id: 'procedure',
      label: 'Procedure',
      state: redFlag ? 'done' : cur(st === 'acting', outcome || (selected && closed)),
      t: s.steps_done.length ? s.steps_done[s.steps_done.length - 1].t : null,
      note: redFlag ? 'red flag' : procNote,
    },
    {
      id: 'outcome',
      label: 'Outcome',
      state: redFlag ? 'skipped' : cur(false, outcome),
      t: s.outcome?.t ?? null,
      note: redFlag ? 'not needed' : st === 'acting' && pending ? `${pending} required left` : null,
    },
    {
      id: 'tripwire',
      label: 'Tripwire',
      state: redFlag ? 'skipped' : cur(st === 'watch', judged),
      t: judged ? s.closed_at : s.reassess_at,
      note: redFlag ? 'not needed' : st === 'watch' ? 'armed' : judged ? (s.tripwire_result!.tripped ? 'tripped' : 'clear') : null,
    },
    {
      id: 'close',
      label: st === 'escalated' ? 'Escalated' : st === 'resolved' ? 'Resolved' : dismissed ? 'Dismissed' : 'Resolve or escalate',
      state: closed ? 'done' : 'todo',
      t: s.closed_at,
      note: null,
    },
  ]
  if (dismissed) for (const x of stages) if (x.state !== 'done' && x.id !== 'close') x.state = 'skipped'
  return stages
}

// ---- urgency: the order of the case list -----------------------------------------------------------

const STATUS_WEIGHT: Partial<Record<CaseStatus, number>> = { detected: 4, acting: 3, escalated: 2, watch: 1 }

/** Opening severity of a case view (the finding that opened it), caution when unknown. */
export function openingSeverity(v: Pick<CaseView, 'state' | 'opening'>): Severity {
  return ((v.state.finding?.severity ?? v.opening?.finding.severity ?? 'caution') as Severity) || 'caution'
}

/**
 * Urgency of one crewmember's case: 0 when nothing is open; otherwise the opening severity first
 * (warning before caution), then the status (detected, acting, escalated, watch). Escalated counts as
 * urgent: the Crew Medical Officer has it now.
 */
export function urgencyOf(v: Pick<CaseView, 'state' | 'opening'>): number {
  const w = STATUS_WEIGHT[v.state.status]
  if (!w) return 0
  return SEVERITY_RANK[openingSeverity(v)] * 10 + w
}

const isCrewWide = (def: { triggers?: Array<{ kind: string }> }) => (def.triggers ?? []).some((x) => x.kind === 'ops')

/** Case definitions, most urgent first: highest urgency of any crewmember, then crew-wide cases, then file order. */
export function sortByUrgency<D extends { id: string; triggers?: Array<{ kind: string }> }>(defs: readonly D[], views: readonly CaseView[]): D[] {
  const score = (d: D) => Math.max(0, ...views.filter((v) => v.caseId === d.id).map((v) => urgencyOf(v)))
  const openCount = (d: D) => views.filter((v) => v.caseId === d.id && urgencyOf(v) > 0).length
  return defs
    .map((d, i) => ({ d, i, u: score(d), wide: isCrewWide(d) && openCount(d) > 0 ? 1 : 0 }))
    .sort((a, b) => b.u - a.u || b.wide - a.wide || a.i - b.i)
    .map((x) => x.d)
}

// ---- plain labels (no rule IDs in crew-facing text, D7) -----------------------------------------------

const VARIABLE_WORDS: Record<string, string> = {
  shelter_entry: 'shelter entry time',
  renal_symptoms: 'symptom answer',
  dose_bfo: 'blood-forming-organ dose',
  dose_skin: 'skin dose',
  dose_lens: 'lens dose',
  proton_flux_10mev: '≥10 MeV proton flux',
  career_effective_dose: 'career effective dose',
}

function personalIndicatorList(): Indicator[] {
  const list = RULES.personal?.indicators
  return Array.isArray(list) ? (list as Indicator[]) : []
}

/** A plain label for an observation variable: the indicator's label, else a short name. */
export function variableLabel(variable: string): string {
  const ind = personalIndicatorList().find((i) => i.variable === variable)
  if (ind?.label) return ind.label
  return VARIABLE_WORDS[variable] ?? humanize(variable).toLowerCase()
}

/** Label of a rule or indicator id (the id itself only as a last resort). */
export function refLabel(id: string | null | undefined): string {
  if (!id) return ''
  const rule = thresholdRules(RULES).find((r) => r.id === id)
  if (rule) return rule.label ?? id
  try {
    return getIndicator(RULES, id).label ?? id
  } catch {
    return id
  }
}

/**
 * The engine's log detail in plain words for the crew: rule and indicator ids become their labels,
 * step ids become "step N", countermeasure ids their titles. The engine's own text is otherwise kept,
 * and the ids stay on Provenance and in "Why this fired".
 */
export function plainDetail(detail: string, def: CaseDefFull): string {
  const steps = def.procedure ?? []
  const num = (id: string) => {
    const i = steps.findIndex((x) => x.id === id)
    return i >= 0 ? String(i + 1) : id
  }
  const ids = new Set(steps.map((x) => x.id))
  let out = detail.replace(/\bstep (\w+)/g, (m, id: string) => (ids.has(id) ? `step ${num(id)}` : m))
  // the engine's required_steps_pending list: "...with a reason: p2, p3"
  out = out.replace(/(with a reason: )([\w, ]+)$/, (_m, head: string, list: string) =>
    head + list.split(/,\s*/).map((id) => (ids.has(id) ? `step ${num(id)}` : id)).join(', '),
  )
  const cms = [def.countermeasure?.primary, ...(def.countermeasure?.alternatives ?? [])].filter(Boolean)
  for (const cm of cms) if (cm!.title) out = out.split(cm!.id).join(`“${cm!.title}”`)
  return out.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (m) => {
    const label = refLabel(m)
    return label && label !== m ? label : m
  })
}

/** "kidneys" -> "Kidneys", "blood_forming_organs" -> "Blood forming organs". */
export function humanize(id: string): string {
  const s = id.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---- manual entry: a typing check (design choice), never a clinical limit ------------------------------

export interface PlausibleRange {
  min: number
  max: number
  unit: string
  /** Why a value outside the range is asked about, in plain words. */
  why: string
  chip: string
  source: Source
}

const TYPING_CHECK = 'A typing check, not a clinical limit: a value outside it can be real, so it is confirmed, not refused.'

/** The 30-day Table 4.8-1 rule on a dose variable, if any (its limit bounds the typing check). */
function thirtyDayLimit(variable: string, unit: string): Rule | null {
  return thresholdRules(RULES).find((r) => r.variable === variable && r.unit === unit && r.category === 'PEL' && r.window?.duration === 'P30D') ?? null
}

/**
 * The range a typed value is expected in, by variable (null: no check beyond "a number of zero or more").
 * Bounds are design choices, labelled as such; the dose bound is the rule's own 30-day limit and the
 * proton bound the top of NOAA's scale, both read from the rules, never typed here.
 */
export function plausibleRange(variable: string, unit: string): PlausibleRange | null {
  const dc = (rationale: string): Source => ({ kind: 'design_choice', rationale })
  if ((variable === 'urine_volume_24h' || variable === 'fluid_intake_24h') && unit === 'mL') {
    const max = variable === 'urine_volume_24h' ? 6000 : 8000
    const why =
      'Below 100 mL is more often litres typed as millilitres (1.5 instead of 1500); above ' +
      `${max.toLocaleString('en-US')} mL is more often an extra zero.`
    return { min: 100, max, unit, why, chip: 'design choice', source: dc(`${TYPING_CHECK} ${why}`) }
  }
  const pel = thirtyDayLimit(variable, unit)
  if (pel) {
    const why = `Above ${pel.limit} ${unit}, the 30-day limit itself (NASA-STD-3001 Vol 1 Table 4.8-1), check the number against the vehicle's dose report.`
    return { min: 0, max: pel.limit, unit, why, chip: 'design choice', source: dc(`${TYPING_CHECK} ${why}`) }
  }
  if (variable === 'proton_flux_10mev' && unit === 'pfu') {
    const top = NOAA_S_THRESHOLDS_PFU[NOAA_S_THRESHOLDS_PFU.length - 1]
    const why = `Above ${top.toLocaleString('en-US')} pfu, the S5 level at the top of NOAA's scale, check the number against the monitor.`
    return { min: 0, max: top, unit, why, chip: 'design choice', source: dc(`${TYPING_CHECK} ${why}`) }
  }
  return null
}

export function checkPlausible(variable: string, unit: string, value: number): { ok: boolean; side: 'low' | 'high' | null; range: PlausibleRange | null } {
  const range = plausibleRange(variable, unit)
  if (!range) return { ok: true, side: null, range }
  if (value < range.min) return { ok: false, side: 'low', range }
  if (value > range.max) return { ok: false, side: 'high', range }
  return { ok: true, side: null, range }
}

// ---- the ground packet: Prepared (held on board) or Queued (meta.json packet_states) ------------------

export type PacketStateId = 'none' | 'prepared' | 'queued'

export function packetStateOf(s: CaseState): PacketStateId {
  if (s.status === 'idle') return 'none'
  return s.packet_queued_at !== null ? 'queued' : 'prepared'
}

function metaList<T>(key: string): T[] {
  const v = (RULES.meta as Record<string, unknown> | null)?.[key]
  return Array.isArray(v) ? (v as T[]) : []
}

/** The label of a packet state, read from meta.json ("Prepared (held on board)", "Queued"). */
export function packetLabel(id: 'prepared' | 'queued'): string {
  return metaList<PacketStateDef>('packet_states').find((p) => p.id === id)?.label ?? (id === 'queued' ? 'Queued' : 'Prepared (held on board)')
}

// ---- escalation tiers (meta.json escalation, D4) ---------------------------------------------------------

export function escalationMeta(): EscalationMeta | null {
  const v = (RULES.meta as Record<string, unknown> | null)?.escalation
  return v && typeof v === 'object' && Array.isArray((v as EscalationMeta).tiers) ? (v as EscalationMeta) : null
}

/** The crewmember who holds the Crew Medical Officer role (CM-4 in this fictional crew). */
export function cmoCrewId(): CrewId | null {
  return CREW.find((c) => /crew medical officer/i.test(c.role))?.id ?? null
}

/**
 * Tier 1, in words true for the crewmember's role: the CMO is not told to tell the CMO. On the Crew Medical
 * Officer's own cases tier 1 is the backup, the Commander (meta.json escalation, as the engine records it).
 */
export function tierOneLine(crewId: CrewId): string {
  return tierOneFor(crewId).line
}

// ---- tripwire ----------------------------------------------------------------------------------------

/**
 * Where the demo jump puts the mission clock: the first whole minute at or after reassess_at. Cases
 * fold on the minute clock, so a jump to reassess_at itself (with seconds) is judged only a minute later.
 */
export function tripwireJumpTarget(reassessAt: number): number {
  return Math.ceil(reassessAt / 60) * 60
}

/** Does a reading meet the tripwire condition (the engine's own compare, value op limit)? */
export function meetsCondition(value: number, op: Op, limit: number): boolean {
  return compare(value, op, limit)
}

/** How far the tripwire is from a decision, from the readings the engine collected (presentation only). */
export function tripwireProgress(s: CaseState): { considered: number; hits: number; needed: number } {
  const c = s.spec.tripwire.condition
  const last = s.tripwire_obs.slice(-c.of_last_n)
  const hits = last.filter((o) => meetsCondition(o.value, c.op, c.value)).length
  return { considered: last.length, hits, needed: Math.max(0, c.of_last_n - last.length) }
}

// ---- dose records: a window with incomplete coverage is a partial record (D15) ------------------------

/**
 * Coverage of a cumulative dose window (t - seconds, t] by dose reports (each report the dose since the
 * previous one; career windows open at MET 0). Partial when the record starts after the window opens: the
 * logged sum is then a lower bound, so "within limit" cannot be said (unlogged time is not zero dose).
 */
export function doseCoverage(obs: readonly Observation[], unit: string, t: number, seconds: number | null): { firstT: number | null; n: number; partial: boolean } {
  let firstT: number | null = null
  let n = 0
  for (const o of obs) {
    if (o.t > t || o.unit !== unit || typeof o.value !== 'number' || !Number.isFinite(o.value)) continue
    n += 1
    if (firstT === null || o.t < firstT) firstT = o.t
  }
  const opens = seconds === null ? 0 : t - seconds
  return { firstT, n, partial: firstT !== null && firstT > opens }
}

/** P30D / P1Y / PT1H -> seconds (a year is 365 d, as in the app's windows); null for a career window. */
export function windowSecondsOf(rule: Pick<Rule, 'window'>): number | null {
  const kind = rule.window?.kind
  if (kind === 'career') return null
  const m = /^P(?:(\d+)Y)?(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/.exec(String(rule.window?.duration ?? ''))
  if (!m || !(m[1] || m[2] || m[3])) return null
  return Number(m[1] ?? 0) * 365 * DAY_S + Number(m[2] ?? 0) * DAY_S + Number(m[3] ?? 0) * 3600
}

// ---- HRP / HRR -----------------------------------------------------------------------------------------

/** HRR risk ids a case cites: its HRP risk page's own HRR id, plus every humanresearchroadmap URL in the case. */
export function hrrIdsOf(def: CaseDefFull, riskHrrId: number | null | undefined): number[] {
  const ids: number[] = []
  if (typeof riskHrrId === 'number') ids.push(riskHrrId)
  for (const m of JSON.stringify(def).matchAll(/humanresearchroadmap\.nasa\.gov\/risks\/\?i=(\d+)/g)) {
    const n = Number(m[1])
    if (!ids.includes(n)) ids.push(n)
  }
  return ids
}

/** HRR mission_type row matching an environment (labels as printed in the Human Research Roadmap). */
export const HRR_MISSION_TYPE: Record<string, string> = {
  iss: 'Low Earth Orbit',
  cislunar: 'Lunar Orbital',
  lunar_surface: 'Lunar Orbital + Surface',
  mars_surface: 'Mars',
}

export function hrrRows(r: HrrRisk, missionType: string | undefined) {
  return (r.detail?.ratings ?? []).filter((x) => x.mission_type === missionType)
}

// ---- simulator self-check: openings that are chance flags of realistic noise ---------------------------

/** The simulator's own record that this case opened on a chance flag (sim_crew data.self_check), or null. */
export function chanceOpening(check: SimSelfCheck | null | undefined, crewId: CrewId, caseId: string, openedAt: number | null): UnscriptedOpening | null {
  if (openedAt === null) return null
  const list = Array.isArray(check?.unscripted_case_openings) ? check!.unscripted_case_openings! : []
  return list.find((x) => x.crew_id === crewId && x.case_id === caseId && x.day === metDayOf(openedAt)) ?? null
}

// ---- Tier B: indicators that alert in both directions (expectedFalseAlarms kEither) -------------------

/** Alerting, non-private indicators whose worse direction is "either" (glucose): both tails raise a caution. */
export function alertingEitherCount(): number {
  return personalIndicatorList().filter((i) => i.alerting && !i.private && i.worse === 'either').length
}

// ---- verbatim text from the standards snapshots ---------------------------------------------------

export interface StdRequirement {
  id: string
  text?: string
  rationale?: string | null
  note?: string | null
  section?: string
  section_title?: string
  title?: string
  printed_page?: number
  pdf_page?: number
}

interface StdTable {
  id?: string
  caption?: string
  columns?: string[]
  rows?: unknown[]
  [key: string]: unknown
}

export interface StdData {
  document?: { title?: string; revision?: string; url?: string; pdf_url?: string; approved?: string; date?: string }
  requirements?: StdRequirement[]
  tables?: StdTable[] | Record<string, StdTable>
}

/** "[V2 6164]" / "V2 6164" -> "V2 6164". */
export function normReqId(id: string): string {
  return id.replace(/^\[|\]$/g, '').trim()
}

/** The verbatim requirement record for an id ("V1 4027", "[V2 6164]") from either volume. */
export function findRequirement(id: string | null | undefined, ...vols: Array<StdData | null | undefined>): StdRequirement | null {
  if (!id) return null
  const want = normReqId(id)
  for (const v of vols) {
    const hit = v?.requirements?.find((r) => normReqId(r.id) === want)
    if (hit) return hit
  }
  return null
}

/** A Table 4.8-1 cell (source.table / row / column) as printed, with the table caption. */
export function findTableCell(
  source: Record<string, unknown> | null | undefined,
  vol: StdData | null | undefined,
): { caption: string; text: string } | null {
  if (!source || typeof source.table !== 'string' || typeof source.row !== 'string' || typeof source.column !== 'string') return null
  const tables = Array.isArray(vol?.tables) ? vol!.tables : []
  const tbl = tables.find((t) => t.id === source.table)
  if (!tbl || !Array.isArray(tbl.rows)) return null
  for (const r of tbl.rows as Array<Record<string, unknown>>) {
    if (r.organ !== source.row) continue
    const cell = r[source.column] as { text?: string } | undefined
    if (cell && typeof cell.text === 'string') return { caption: String(tbl.caption ?? source.table), text: cell.text }
  }
  return null
}

/** A Vol 2 table by its printed name ("Table 8.7-2"), matched on the caption prefix. */
export function findNamedTable(name: string | null | undefined, vol: StdData | null | undefined): StdTable | null {
  if (!name || !vol?.tables) return null
  const list = Array.isArray(vol.tables) ? vol.tables : Object.values(vol.tables)
  return list.find((t) => typeof t.caption === 'string' && (t.caption === name || t.caption.startsWith(`${name}—`) || t.caption.startsWith(`${name} `))) ?? null
}

// ---- S-level transitions of the proton series ------------------------------------------------------

export interface SLevelTransition {
  t: number
  from: number | null
  to: number
  /** The flux sample (pfu) at the transition. */
  value: number
  provenance: string
}

/**
 * S-level changes in a t-sorted proton flux series up to MET `at`, using the engine's sLevel (NOAA
 * thresholds). The first sample is the starting level (from: null). Only what the monitor has seen:
 * nothing after `at` (no forecast).
 */
export function sLevelTransitions(series: readonly Observation[], at: number): SLevelTransition[] {
  const out: SLevelTransition[] = []
  let level: number | null = null
  for (const o of series) {
    if (o.t > at) break
    if (typeof o.value !== 'number' || !Number.isFinite(o.value)) continue
    const l = sLevel(o.value)
    if (l === level) continue
    out.push({ t: o.t, from: level, to: l, value: o.value, provenance: o.provenance })
    level = l
  }
  return out
}

/** UTC of the original 1989 sample behind a replayed MET (sim_crew's time shift), as "1989-10-19 18:55 UTC". */
export function replayUtcOf(t: number, mapUtcIso: string | null | undefined, mapMet: number | null | undefined): string | null {
  if (!mapUtcIso || typeof mapMet !== 'number') return null
  const base = Date.parse(mapUtcIso)
  if (!Number.isFinite(base)) return null
  const d = new Date(base + (t - mapMet) * 1000)
  if (Number.isNaN(d.getTime())) return null
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// ---- observations --------------------------------------------------------------------------------

/** Latest observation at or before t (list t-sorted), optionally of one crewmember (+ vehicle sensors). */
export function latestAtOrBefore(list: readonly Observation[], t: number, crewId?: CrewId): Observation | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i]
    if (o.t > t) continue
    if (crewId && o.crew_id !== null && o.crew_id !== crewId) continue
    return o
  }
  return null
}

/** The last n observations at or before t (oldest first). */
export function lastN(list: readonly Observation[], t: number, n: number, crewId?: CrewId): Observation[] {
  const out: Observation[] = []
  for (let i = list.length - 1; i >= 0 && out.length < n; i--) {
    const o = list[i]
    if (o.t > t) continue
    if (crewId && o.crew_id !== null && o.crew_id !== crewId) continue
    out.unshift(o)
  }
  return out
}

/** MET day number of a MET (floor(t / 1 day)). */
export function metDayOf(t: number): number {
  return Math.floor(t / DAY_S)
}
