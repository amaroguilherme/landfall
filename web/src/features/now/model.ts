// Pure helpers for the Now (hero) view. No React, no NASA numbers typed here: every limit,
// quote and label is read from the rules (RULES), a frozen snapshot, or the engine's output.
import { RULES, getCase, thresholdRules } from '../../app/engine'
import type { CaseDef, Rule } from '../../app/engine'
import type { CaseView } from '../../app/caseTimeline'
import type { AlertItem } from '../../app/mission'
import { CREW_IDS, SEVERITY_RANK } from '../../app/vocab'
import type { CrewId, Observation, Severity } from '../../app/vocab'

/** The hero case (engine/rules/cases.json id). */
export const SPE_CASE_ID = 'spe_shelter'

// ---- the autoplay sequence (presentation timing, ms after the hero is ready) ------------------

/**
 * One ~7-second sequence, played once per page load: the ASK HOUSTON counter runs, fades to
 * QUEUED (when the link is blocked), then the LANDFALL card lights with the countermeasure.
 * These are animation timings (design), not data.
 */
export const SEQUENCE = {
  rollStart: 300,
  rollEnd: 2100,
  queuedAt: 2700,
  landfallAt: 4100,
  doneAt: 7000,
} as const

export type Phase = 'eta' | 'link' | 'landfall' | 'done'

export function phaseAt(elapsedMs: number): Phase {
  if (elapsedMs < SEQUENCE.queuedAt) return 'eta'
  if (elapsedMs < SEQUENCE.landfallAt) return 'link'
  if (elapsedMs < SEQUENCE.doneAt) return 'landfall'
  return 'done'
}

/** The counter value while it runs: 0 -> target with an ease-out, clamped to the target. */
export function rollValue(elapsedMs: number, target: number): number {
  const span = SEQUENCE.rollEnd - SEQUENCE.rollStart
  const p = Math.min(1, Math.max(0, (elapsedMs - SEQUENCE.rollStart) / span))
  const eased = 1 - (1 - p) * (1 - p) * (1 - p)
  return p >= 1 ? target : target * eased
}

// ---- the [V2 6164] rationale quote --------------------------------------------------------------

export interface QuoteCitation {
  /** Verbatim sentence, as copied into cases.json (checked against the frozen standard). */
  text: string
  requirementId: string
  doc: string | null
  section: string | null
  page: number | null
  url: string | null
  snapshot: string | null
}

interface CitationLike {
  kind?: string
  requirement_id?: string
  doc?: string
  section?: string
  page?: number
  url?: string
  snapshot?: string
  verbatim?: string
}

/**
 * The NASA-standard citation of a case's interpretation that carries a verbatim quote (for the
 * SPE case: the [V2 6164] rationale sentence). Optionally pinned to one requirement id.
 */
export function caseQuote(def: CaseDef | null, requirementId?: string): QuoteCitation | null {
  const interp = def?.interpretation as { citations?: CitationLike[] } | undefined
  const c = interp?.citations?.find(
    (x) =>
      x.kind === 'nasa_standard' &&
      typeof x.verbatim === 'string' &&
      typeof x.requirement_id === 'string' &&
      (requirementId === undefined || x.requirement_id === requirementId),
  )
  if (!c || !c.verbatim || !c.requirement_id) return null
  return {
    text: c.verbatim,
    requirementId: c.requirement_id,
    doc: c.doc ?? null,
    section: c.section ?? null,
    page: typeof c.page === 'number' ? c.page : null,
    url: c.url ?? null,
    snapshot: c.snapshot ?? null,
  }
}

export interface StandardRequirement {
  id: string
  title?: string
  section?: string
  text?: string
  rationale?: string
  pdf_page?: number
}

interface StandardData {
  requirements?: StandardRequirement[]
  document?: { revision?: string; approved?: string }
}

/** "[V2 6164]" or "V2 6164" -> the requirement record of a std_vol*_requirements snapshot. */
export function findRequirement(data: unknown, requirementId: string): StandardRequirement | null {
  const want = requirementId.replace(/^\[|\]$/g, '').trim()
  const reqs = (data as StandardData | null)?.requirements
  if (!Array.isArray(reqs)) return null
  return reqs.find((r) => typeof r.id === 'string' && r.id.replace(/^\[|\]$/g, '').trim() === want) ?? null
}

/** Approval date of the frozen standard revision, when the snapshot records it. */
export function standardApproved(data: unknown): string | null {
  const d = (data as StandardData | null)?.document
  return typeof d?.approved === 'string' ? d.approved : null
}

export type VerbatimCheck = 'verified' | 'mismatch' | 'unchecked'

/** Is the quoted sentence present, character for character, in the frozen requirement text? */
export function verbatimCheck(req: StandardRequirement | null, text: string): VerbatimCheck {
  if (!req) return 'unchecked'
  const hay = `${req.text ?? ''}\n${req.rationale ?? ''}`
  return hay.includes(text) ? 'verified' : 'mismatch'
}

// ---- OPS rules and S-levels (from engine/rules/thresholds.json) ------------------------------

const OPS_RULES: readonly Rule[] = thresholdRules(RULES).filter((r) => r.category === 'OPS')

function ruleLevel(r: Rule): number | null {
  return typeof r.s_level === 'number' ? r.s_level : null
}

/** NOAA's own descriptor for an S-level ("Strong" for S3), from the NOAA-published OPS rules. */
export function sLevelDescriptor(level: number | null): string | null {
  if (level === null) return null
  const r = OPS_RULES.find((x) => ruleLevel(x) === level && !x.derived_from_rule)
  return typeof r?.descriptor === 'string' ? r.descriptor : null
}

/** NOAA S1..S5 reference lines for the chart: {level, limit} from the NOAA-published rules. */
export function sLevelLines(): Array<{ level: number; limit: number }> {
  const out: Array<{ level: number; limit: number }> = []
  for (const r of OPS_RULES) {
    const level = ruleLevel(r)
    if (level === null || r.derived_from_rule || typeof r.limit !== 'number') continue
    if (!out.some((x) => x.level === level)) out.push({ level, limit: r.limit })
  }
  return out.sort((a, b) => a.level - b.level)
}

/** The rule an onboard OPS rule reuses (ops_onboard_proton_s3 -> ops_noaa_s3), or null. */
export function sourceRuleOf(rule: Rule | null): Rule | null {
  const from = rule?.derived_from_rule
  if (typeof from !== 'string') return null
  return OPS_RULES.find((r) => r.id === from) ?? null
}

export function opsRule(id: string | null | undefined): Rule | null {
  return id ? (OPS_RULES.find((r) => r.id === id) ?? null) : null
}

// ---- cases ----------------------------------------------------------------------------------------

const OPEN_STATUSES = new Set(['detected', 'acting', 'watch', 'escalated'])

export function isOpen(v: CaseView): boolean {
  return OPEN_STATUSES.has(v.state.status)
}

/** Open views of one case id (every crewmember that has it open). */
export function openViewsOf(cases: readonly CaseView[], caseId: string): CaseView[] {
  return cases.filter((v) => v.caseId === caseId && isOpen(v))
}

/** The one view to show for a case: the selected crewmember's when open, else the first open one. */
export function pickView(views: readonly CaseView[], crewId: CrewId): CaseView | null {
  return views.find((v) => v.crewId === crewId) ?? views[0] ?? null
}

const STATUS_ORDER: Record<string, number> = { escalated: 0, detected: 1, acting: 2, watch: 3 }

/** Every other open case (not `exceptCaseId`), most urgent status first, then crew order. */
export function otherOpenCases(cases: readonly CaseView[], exceptCaseId: string): CaseView[] {
  return cases
    .filter((v) => v.caseId !== exceptCaseId && isOpen(v))
    .sort(
      (a, b) =>
        (STATUS_ORDER[a.state.status] ?? 9) - (STATUS_ORDER[b.state.status] ?? 9) ||
        CREW_IDS.indexOf(a.crewId) - CREW_IDS.indexOf(b.crewId) ||
        (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0),
    )
}

/** Primary countermeasure of a case def (cases.json countermeasure.primary). */
export function primaryOf(def: CaseDef | null): { id: string; title: string; rationale: string | null; chip: string | null; source: Record<string, unknown> | null } | null {
  const p = def?.countermeasure?.primary as
    | { id: string; title?: string; rationale?: string; chip?: string; source?: Record<string, unknown> }
    | undefined
  if (!p || typeof p.title !== 'string') return null
  return { id: p.id, title: p.title, rationale: p.rationale ?? null, chip: p.chip ?? null, source: p.source ?? null }
}

/** Countermeasure title by id within a case def (primary or alternative). */
export function countermeasureTitle(def: CaseDef | null, id: string | null): string | null {
  if (!def || !id) return null
  const all = [def.countermeasure?.primary, ...(def.countermeasure?.alternatives ?? [])] as Array<{ id: string; title?: string } | undefined>
  const m = all.find((c) => c?.id === id)
  return typeof m?.title === 'string' ? m.title : null
}

export function speDef(): CaseDef | null {
  try {
    return getCase(RULES, SPE_CASE_ID)
  } catch {
    return null
  }
}

// ---- crew status strip ---------------------------------------------------------------------------

export interface CrewStatus {
  crewId: CrewId
  /** Worst severity among this crewmember's annunciated alerts (crew-wide OPS included). */
  severity: Severity
  /** The alert behind it: the crewmember's own when one ties with a crew-wide one. */
  top: AlertItem | null
  /** How many annunciated alerts apply to this crewmember (own + crew-wide). */
  count: number
}

/** Worst severity per crewmember from the annunciator alerts (MissionEngine's policy). */
export function crewStatuses(alerts: readonly AlertItem[]): CrewStatus[] {
  return CREW_IDS.map((crewId) => {
    const mine = alerts.filter((a) => a.crew_id === crewId || a.crew_id === 'ALL')
    let top: AlertItem | null = null
    for (const a of mine) {
      if (!top) {
        top = a
        continue
      }
      const d = SEVERITY_RANK[a.severity] - SEVERITY_RANK[top.severity]
      if (d > 0 || (d === 0 && top.crew_id === 'ALL' && a.crew_id === crewId)) top = a
    }
    return { crewId, severity: top ? top.severity : 'nominal', top, count: mine.length }
  })
}

// ---- onboard monitor series for the sparkline -----------------------------------------------------

export interface FluxSeries {
  xs: number[]
  ys: Array<number | null>
  /** Values at or above the threshold (null elsewhere), for the out-of-limit overlay. */
  over: Array<number | null>
  first: number | null
  last: Observation | null
  /** How many samples in the window come from the post-"now" replay continuation. */
  replayAfterNow: number
}

/**
 * The monitor readings that EXIST at MET t (t <= clock), over the last `spanS` seconds.
 * Non-positive values are kept as gaps (a log axis cannot draw them).
 */
export function fluxWindow(obs: readonly Observation[], t: number, spanS: number, threshold: number | null): FluxSeries {
  const from = t - spanS
  const xs: number[] = []
  const ys: Array<number | null> = []
  const over: Array<number | null> = []
  let last: Observation | null = null
  let replayAfterNow = 0
  for (const o of obs) {
    if (o.t < from) continue
    if (o.t > t) break
    const v = Number.isFinite(o.value) && o.value > 0 ? o.value : null
    xs.push(o.t)
    ys.push(v)
    over.push(v !== null && threshold !== null && v >= threshold ? v : null)
    if (o.provenance === 'replay') replayAfterNow++
    last = o
  }
  // Join the overlay to the sample just before it crosses, so the coloured segment starts at the line.
  for (let i = 1; i < over.length; i++) if (over[i] !== null && over[i - 1] === null) over[i - 1] = ys[i - 1]
  return { xs, ys, over, first: xs.length ? xs[0] : null, last, replayAfterNow }
}

/** Plain-English label for a case status (the engine's lifecycle word). */
export const CASE_STATUS_LABEL: Record<string, string> = {
  idle: 'Not open',
  detected: 'Detected',
  acting: 'Acting',
  watch: 'Watch',
  resolved: 'Resolved',
  escalated: 'Escalated',
  dismissed: 'Dismissed',
}

// ---- chart scale ---------------------------------------------------------------------------------

/** Powers of ten covering [min, max] of the positive values (at least the threshold decade above). */
export function logRange(values: Array<number | null>, threshold: number | null): [number, number] {
  let lo = Infinity
  let hi = 0
  for (const v of values) {
    if (v === null || !(v > 0)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (threshold !== null && threshold > 0) {
    lo = Math.min(lo, threshold)
    hi = Math.max(hi, threshold * 10)
  }
  if (!Number.isFinite(lo) || hi <= 0) return [0.1, 10]
  return [10 ** Math.floor(Math.log10(lo)), 10 ** Math.ceil(Math.log10(hi))]
}
