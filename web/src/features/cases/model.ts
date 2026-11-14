// Pure helpers for the case views (no React). Every number shown by the cases feature comes from
// the rules JSON, a frozen snapshot or the engine; these helpers only look things up, format, and
// pick. Nothing here re-implements an engine statistic.
import { formatMet, sLevel } from '../../app/engine'
import type { CaseState, CaseStatus, Op } from '../../app/engine'
import type { CaseView } from '../../app/caseTimeline'
import { CHIP_DEFS, CREW_IDS, isCrewId } from '../../app/vocab'
import type { CrewId, Observation } from '../../app/vocab'

const DAY_S = 86_400

/** Display symbols for a rule op (presentation only; the engine's own text uses ASCII). */
export const OP_TEXT: Record<Op, string> = { lt: '<', le: '≤', gt: '>', ge: '≥' }

/** Plain-English compliant condition for an op. */
export const OP_WORDS: Record<Op, string> = {
  lt: 'below',
  le: 'at or below',
  gt: 'above',
  ge: 'at or above',
}

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

/** Seconds as "72 h", "6 h", "90 min", "2 d 06 h" (used for reassess_after_s). */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s % 3600 === 0) return `${s / 3600} h`
  if (s % 60 === 0 && s < 3600) return `${s / 60} min`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h} h ${String(m).padStart(2, '0')} min`
}

/** T-minus clock for a countdown: "17:39:52", or "1 d 17:39:52" past a day. Negative input -> 0. */
export function formatTMinus(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / DAY_S)
  const hh = String(Math.floor((s % DAY_S) / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return d > 0 ? `${d} d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`
}

/**
 * The engine's log details print MET as raw seconds ("reassess at 35712000"). For a non-physician
 * reader, rewrite those two known patterns to MET dddd/hh:mm:ss; the rest is the engine's text.
 */
export function prettyDetail(detail: string): string {
  return detail
    .replace(/reassess at (\d{4,})(?![\d.])/g, (_m, n: string) => `reassess at MET ${formatMet(Number(n))}`)
    .replace(/judged at reassessment \((\d{4,})\)/g, (_m, n: string) => `judged at reassessment (MET ${formatMet(Number(n))})`)
}

/** Chip label (from meta.json) for a SPEC source kind, e.g. literature -> "literature". */
export function chipForKind(kind: unknown): string | null {
  return CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? null
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
  const cur = (cond: boolean, done: boolean): StageState => (done ? 'done' : cond ? 'current' : 'todo')
  const dismissed = st === 'dismissed'
  const stages: Stage[] = [
    { id: 'detect', label: 'Detect', state: opened ? 'done' : 'todo', t: s.opened_at, note: opened ? null : 'watching' },
    { id: 'interpret', label: 'Interpret', state: opened ? 'done' : 'todo', t: s.opened_at, note: null },
    { id: 'act', label: 'Countermeasure', state: cur(st === 'detected', selected), t: selectT, note: null },
    {
      id: 'procedure',
      label: 'Procedure',
      state: cur(st === 'acting', outcome || (selected && closed)),
      t: s.steps_done.length ? s.steps_done[s.steps_done.length - 1].t : null,
      note: selected ? `${s.steps_done.length} of ${nSteps}` : null,
    },
    { id: 'outcome', label: 'Outcome', state: cur(false, outcome), t: s.outcome?.t ?? null, note: null },
    {
      id: 'tripwire',
      label: 'Tripwire',
      state: cur(st === 'watch', judged),
      t: judged ? s.closed_at : s.reassess_at,
      note: st === 'watch' ? 'armed' : judged ? (s.tripwire_result!.tripped ? 'tripped' : 'clear') : null,
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

// ---- S-level transitions of the onboard / NOAA proton series ------------------------------------

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
 * nothing after `at` (LANDFALL does not forecast).
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

/** "kidneys" -> "Kidneys", "blood_forming_organs" -> "Blood forming organs". */
export function humanize(id: string): string {
  const s = id.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** HRR mission_type row matching an environment (labels as printed in the Human Research Roadmap). */
export const HRR_MISSION_TYPE: Record<string, string> = {
  iss: 'Low Earth Orbit',
  cislunar: 'Lunar Orbital',
  lunar_surface: 'Lunar Orbital + Surface',
  mars_surface: 'Mars',
}
