// Build-time, typed imports of the canonical rules (engine/rules/*.json) and the minimal shapes
// of the frozen snapshots this page reads. Every number on the Method page comes from these
// objects; the TSX only arranges and formats them.
//
// import.meta.glob (eager) is the shell's pattern: it tolerates a missing file (the value is
// then null and the page reports it) and needs no resolveJsonModule.

// ---- rules files ---------------------------------------------------------------------------

// A type alias (not an interface) so it is assignable to the shell's Citation prop.
export type RuleSource = {
  kind: string
  doc?: string
  requirement_id?: string | null
  section?: string
  page?: number
  url?: string
  snapshot?: string
  verbatim?: string
  table?: string
  rationale?: string
  citation?: string
  note?: string
  from?: string[]
  arithmetic?: string
  term?: string
}

export interface ThresholdRule {
  id: string
  label: string
  variable: string
  unit: string
  op: 'lt' | 'le' | 'gt' | 'ge'
  limit: number
  category: string
  tier: 'A' | 'B'
  role: 'alert' | 'context'
  applies_to: string[]
  window: { kind: string; duration?: string | null; value_definition?: string; basis?: string }
  approach_at?: { value: number; chip: string; source: RuleSource }
  chip: string
  source: RuleSource
  notes?: string[]
}

export interface ThresholdsFile {
  schema: string
  rules: ThresholdRule[]
}

export interface Provenanced {
  chip: string
  source: RuleSource
}

export interface PersonalIndicatorDef {
  id: string
  label: string
  variable: string
  unit: string
  worse: string
  alerting: boolean
  private: boolean
  /** Non-computational context only (value null, used_by_engine false): the engine ignores it. */
  reliability_r?: { value: number | null; used_by_engine?: boolean; chip: string; source: RuleSource }
  case_id: string | null
}

/** A sentence with its basis (personal.json rci.lineage, rci.caveat_basis). */
export interface SourcedText {
  text: string
  chip: string
  source: RuleSource
}

/** personal.json `rci`: the engine reads alpha_two_tailed and min_baseline_n; the critical value is computed. */
export interface RciBlock {
  alpha_two_tailed: number
  min_baseline_n: number
  baseline_window_days: number
  chip: string
  source: RuleSource
  method: string
  lineage?: SourcedText
  provenance: Record<string, Provenanced>
  caveat: string
  caveat_basis?: SourcedText
  change_note?: string
}

export interface PersonalFile {
  schema: string
  rci: RciBlock
  indicators: PersonalIndicatorDef[]
}

export interface MetaCategory {
  id: string
  name: string
  shape: string
  glossary: string | null
  source: RuleSource | null
}

export interface MetaFile {
  schema: string
  categories: MetaCategory[]
  tiers: { id: string; definition: string }[]
  severity_mapping: {
    chip: string
    source: RuleSource
    rows: { id: string; when: Record<string, unknown>; severity?: string; severity_max?: string; note?: string }[]
  }
  principles: { id: string; text: string; requirement_ids: string[] }[]
  refusals: { id: string; text: string }[]
}

const metaGlob = import.meta.glob<MetaFile>('../../../../engine/rules/meta.json', { eager: true, import: 'default' })
const personalGlob = import.meta.glob<PersonalFile>('../../../../engine/rules/personal.json', { eager: true, import: 'default' })
const thresholdsGlob = import.meta.glob<ThresholdsFile>('../../../../engine/rules/thresholds.json', {
  eager: true,
  import: 'default',
})

export const META: MetaFile | null = Object.values(metaGlob)[0] ?? null
export const PERSONAL: PersonalFile | null = Object.values(personalGlob)[0] ?? null
export const THRESHOLDS: ThresholdsFile | null = Object.values(thresholdsGlob)[0] ?? null

// ---- snapshot shapes (only the fields this page reads) ----------------------------------------

export interface V1Requirement {
  id: string
  label: string
  section: string
  section_title: string
  pdf_page_number: number
  printed_page: number
  text: string
  note: string | null
  rationale: string | null
  checks: { check: string; ok: boolean }[]
  verified: boolean
}

export interface V1Glossary {
  term: string
  definition: string
  category: string | null
  appendix: string
  pdf_page_number: number
  printed_page: number
  verified: boolean | null
}

export interface Vol1Data {
  document: { number: string; revision: string; date: string; url: string; landing_url: string; sha256: string }
  glossary: V1Glossary[]
  requirements: V1Requirement[]
}

export interface V2Requirement {
  id: string
  number: number
  section: string
  title: string
  pdf_page: number
  printed_page: number
  text: string
  rationale: string | null
  verified: boolean
  checks: { in: string; expect: string; ok: boolean }[]
}

export interface Vol2Table {
  caption: string
  page?: number | number[]
  columns: string[]
  rows: string[][]
  verified?: boolean
}

export interface Vol2Data {
  document: { revision: string; approved: string; title: string; pdf_url: string; sha256: string }
  requirements: V2Requirement[]
  tables?: Record<string, Vol2Table>
}

/** The frozen Table 10.3-1 (Alert Type and Annunciation Table), found by its caption. */
export function alertTable(v2: Vol2Data | null | undefined): Vol2Table | null {
  return (v2?.tables ? Object.values(v2.tables).find((x) => /^Table 10\.3-1\b/.test(x.caption)) : undefined) ?? null
}

/** Table 10.3-1 rows as {type, definition, priority, visual}. */
export function alertClasses(v2: Vol2Data | null | undefined): { type: string; definition: string; priority: string; visual: string }[] {
  const t = alertTable(v2)
  if (!t) return []
  const col = (re: RegExp) => t.columns.findIndex((c) => re.test(c))
  const [d, p, v] = [col(/^Definition/i), col(/^Priority/i), col(/^Visual/i)]
  return t.rows.map((r) => ({ type: r[0] ?? '', definition: d >= 0 ? r[d] ?? '' : '', priority: p >= 0 ? r[p] ?? '' : '', visual: v >= 0 ? r[v] ?? '' : '' }))
}

/** The Table 10.3-1 row for a LANDFALL severity ("warning" -> the "Warning" row; emergency rows share a prefix). */
export function alertClassFor(classes: ReturnType<typeof alertClasses>, severity: string): ReturnType<typeof alertClasses>[number] | null {
  return classes.find((c) => c.type.toLowerCase() === severity.toLowerCase()) ?? classes.find((c) => c.type.toLowerCase().startsWith(severity.toLowerCase())) ?? null
}

/** Plain-language reading of a meta.json severity_mapping `when` clause (unknown keys are shown as written). */
export function describeWhen(when: Record<string, unknown>): string {
  const STATUS: Record<string, string> = {
    outside: 'outside',
    approaching: 'approaching',
    within: 'within',
    reliable_change: 'reliable change',
    insufficient_data: 'insufficient data',
    stale: 'stale data',
    not_applicable: 'not applicable here',
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : [String(v)])
  const parts: string[] = []
  for (const [k, v] of Object.entries(when)) {
    switch (k) {
      case 'tier':
        parts.push(`Tier ${String(v)}`)
        break
      case 'role':
        parts.push(v === 'alert' ? 'alert rule' : v === 'context' ? 'context rule' : `role ${String(v)}`)
        break
      case 'category':
        parts.push(String(v))
        break
      case 'category_in':
        parts.push(list(v).join(' / '))
        break
      case 'status':
        parts.push(STATUS[String(v)] ?? String(v).replace(/_/g, ' '))
        break
      case 'status_in':
        parts.push(list(v).map((s) => STATUS[s] ?? s.replace(/_/g, ' ')).join(' or '))
        break
      case 'direction':
        parts.push(`${String(v)} direction`)
        break
      case 'alerting':
        parts.push(v ? 'alerting indicator' : 'non-alerting indicator')
        break
      case 's_level_in': {
        const l = list(v)
        parts.push(l.length > 1 ? `NOAA S${l[0]} to S${l[l.length - 1]}` : `NOAA S${l[0]}`)
        break
      }
      case 's_level_min':
        parts.push(`NOAA S${String(v)} or above`)
        break
      case 'eva':
        parts.push(v === 'planned_or_in_progress' ? 'EVA planned or in progress' : `EVA ${String(v).replace(/_/g, ' ')}`)
        break
      default:
        parts.push(`${k.replace(/_/g, ' ')} ${Array.isArray(v) ? v.join(' / ') : String(v).replace(/_/g, ' ')}`)
    }
  }
  return parts.join(' · ')
}

export interface OsdrCmpData {
  study: { id: string; title: string; landing_url: string; mission: { name: string; start: string; end: string } }
  subjects: string[]
  timepoints: { label: string; day_offset: number; anchor: string; nominal_date: string }[]
}

export interface SimCrewData {
  generator: { seed: number; deterministic: boolean }
  met: { first_day: number; last_day: number; baseline_days: [number, number] }
  ffd_demo?: { crew_id: string; variable: string; value: number; unit: string }
}

// ---- small pure helpers -------------------------------------------------------------------------

/** "[V2 6022]" and "V2 6022" both normalise to "V2 6022". */
export function normReqId(id: string): string {
  return id.replace(/^\s*\[|\]\s*$/g, '').trim()
}

export const OP_SYMBOL: Record<ThresholdRule['op'], string> = { lt: '<', le: '≤', gt: '>', ge: '≥' }

/** SPEC 3.2: `op` describes the compliant condition. */
export function compliant(op: ThresholdRule['op'], value: number, limit: number): boolean {
  switch (op) {
    case 'lt':
      return value < limit
    case 'le':
      return value <= limit
    case 'gt':
      return value > limit
    case 'ge':
      return value >= limit
  }
}

/** "P30D" -> "30-day", "P1Y" -> "1-year", "PT1H" -> "1-hour"; career windows -> "career". */
export function windowLabel(w: ThresholdRule['window']): string {
  if (w.kind === 'career') return 'career'
  const m = /^P(?:T)?(\d+(?:\.\d+)?)([YMWDHS])$/.exec(w.duration ?? '')
  if (!m) return w.kind.replace(/_/g, ' ')
  const isTime = (w.duration ?? '').startsWith('PT')
  const unit: Record<string, string> = isTime
    ? { H: 'hour', M: 'minute', S: 'second' }
    : { Y: 'year', M: 'month', W: 'week', D: 'day' }
  return `${m[1]}-${unit[m[2]] ?? m[2]}`
}

/** Sentences of `text` that contain any of `fragments` (verbatim, in order, deduplicated). */
export function sentencesContaining(text: string | null, fragments: string[]): string[] {
  if (!text || fragments.length === 0) return []
  const sentences = text
    .replace(/^\[Rationale:\s*/, '')
    .replace(/\]$/, '')
    .split(/(?<=[.!?])\s+(?=[A-Z[])/)
  const out: string[] = []
  for (const s of sentences) {
    if (fragments.some((f) => s.includes(f)) && !out.includes(s)) out.push(s)
  }
  return out
}

/** Phrase inside the first pair of single quotes of a Vol 1 check string. */
export function quotedPhrase(check: string): string | null {
  const m = /'(.+)'/.exec(check)
  return m ? m[1] : null
}
