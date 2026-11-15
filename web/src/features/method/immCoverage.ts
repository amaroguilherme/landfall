// LANDFALL's coverage of NASA's sample IMM output: NASA-STD-3001 Vol 1 Rev C, Appendix E, Table E.2-1
// ("Sample IMM Output"), frozen in std_vol1_requirements (data.tables, id "Table E.2-1", and data.appendix_e).
//
// Each of the table's 48 conditions sits in exactly one category below. The mapping is LANDFALL's design
// choice (chip "design choice"), keyed by the condition names exactly as the PDF prints them. Every number
// (each likelihood, their sum, the shares) is read or computed from the snapshot, never typed here.
// coverage.test.ts checks the mapping against the snapshot, cases.json and the Noon Sight symptom list.
import { CASE_DEFS } from '../../app/caseTimeline'
import { fmtNum } from '../../app/engine'
import { RENAL_SYMPTOMS, SYMPTOMS } from '../noon-sight/record'
import type { SymptomId } from '../noon-sight/record'

// ---- snapshot shapes (only what this section reads) -----------------------------------------------

export interface ImmRow {
  rank: number
  condition: string
  likelihood: { text: string; value: number; unit: string }
  pdf_page_number: number
  printed_page: number | null
}

export interface ImmTable {
  id: string
  caption: string
  header_verbatim: string[]
  pdf_page_number: number
  pages: { pdf_page_number: number; first_rank: number; last_rank: number }[]
  rows: ImmRow[]
  verified: boolean
  checks: { check: string; ok: boolean }[]
  cited_by?: string[]
}

export interface PagedText {
  section?: string
  text: string
  pdf_page_number: number
}

export interface E22Row {
  condition: string
  text_verbatim: string
  asterisk: boolean
  pdf_page_number: number
}

export interface AppendixE {
  e_2_2_inputs: PagedText | null
  e_2_3_limitation: PagedText | null
  table_e_2_2: {
    caption: string | null
    /** PDF page of the caption (the table runs from here to its footnote). */
    pdf_page_number?: number
    intro_note: PagedText | null
    footnote: PagedText | null
    rows: E22Row[]
    scope: string
  }
  verified: boolean
}

/** The frozen Table E.2-1, or null when this snapshot predates it. */
export function immTable(data: { tables?: unknown } | null | undefined): ImmTable | null {
  const list = Array.isArray(data?.tables) ? (data!.tables as ImmTable[]) : []
  const t = list.find((x) => x && x.id === 'Table E.2-1')
  return t && Array.isArray(t.rows) && t.rows.length ? t : null
}

export function appendixE(data: { appendix_e?: unknown } | null | undefined): AppendixE | null {
  const e = data?.appendix_e as AppendixE | undefined
  return e && e.table_e_2_2 ? e : null
}

// ---- the categories ---------------------------------------------------------------------------------

export type CoverageCategory = 'case' | 'asked_daily' | 'asked_symptom' | 'not_measurable'

/** Ordered from what LANDFALL does most with a condition to what it does not do at all. */
export const CATEGORY_ORDER: readonly CoverageCategory[] = ['case', 'asked_daily', 'asked_symptom', 'not_measurable']

/** Labels and definitions (design choice). Their fills are an ordinal grey ramp in coverage.css. */
export const CATEGORY_DEFS: Record<CoverageCategory, { label: string; short: string; definition: string }> = {
  case: {
    label: 'Watched by a case',
    short: 'case',
    definition: 'A guided case watches it: every day it tests the condition’s indicators against the crewmember’s own baseline, and it opens on a reliable change in the worse direction.',
  },
  asked_daily: {
    label: 'Asked daily',
    short: 'asked daily',
    definition: 'The daily Noon Sight check asks about it by name, or by its main symptom.',
  },
  asked_symptom: {
    label: 'Asked, symptom only',
    short: 'asked, symptom only',
    definition: 'The daily check asks about one symptom it can cause, but that symptom does not single it out.',
  },
  not_measurable: {
    label: 'NOT MEASURABLE HERE',
    short: 'not measurable here',
    // Not "never asked": a general daily question (nausea, fever, rash, back pain) can still get a yes from some of
    // these rows (gastroenteritis, influenza, shingles); this score just does not count it for them.
    definition:
      'LANDFALL does not measure it, and this score counts no daily question for it (a general one, such as nausea, fever or rash, may still get a yes from it). Each row names where that information comes from instead.',
  },
}

/** Where a NOT MEASURABLE HERE condition is known from instead (design choice, not a NASA statement). */
export type Via = 'CMO exam' | 'crew report' | 'medical kit'

export const VIA_DEFS: Record<Via, string> = {
  'CMO exam': 'the Crew Medical Officer finds it by examining the crewmember',
  'crew report': 'the crewmember reports it to the Crew Medical Officer; no daily question is counted for it',
  'medical kit': 'it takes a test with the vehicle’s medical equipment, such as a hearing test or imaging',
}

export interface CoverageEntry {
  category: CoverageCategory
  /** 'case': the cases.json id of the case that watches it. */
  caseId?: string
  /** Noon Sight symptom ids the daily check asks about (a case row may also be asked). */
  symptoms?: readonly SymptomId[]
  /** 'not_measurable': where the information comes from instead. */
  via?: Via
  /** A Tier A rule that measures the exposure behind it (thresholds.json id). */
  ruleId?: string
  note?: string
}

/** Table E.2-1, condition (verbatim) -> category. Exactly the 48 printed rows; the test checks both ways. */
export const IMM_COVERAGE: Readonly<Record<string, CoverageEntry>> = {
  'Late Insomnia': { category: 'case', caseId: 'sleep_circadian', symptoms: ['trouble_sleeping'] },
  'Skin Abrasion': { category: 'not_measurable', via: 'CMO exam' },
  'Skin Rash': { category: 'asked_daily', symptoms: ['rash'] },
  'Eye Abrasion': { category: 'not_measurable', via: 'CMO exam' },
  'Late Headache': { category: 'asked_daily', symptoms: ['headache'] },
  'Space Motion Sickness (SAS)': { category: 'asked_symptom', symptoms: ['nausea_vomiting'] },
  Diarrhea: { category: 'not_measurable', via: 'crew report' },
  'Nasal Congestion': { category: 'not_measurable', via: 'crew report' },
  'Respiratory Infection': { category: 'not_measurable', via: 'CMO exam' },
  'Back Injury': { category: 'not_measurable', via: 'CMO exam' },
  'Barotrauma (Ear/Sinus Block)': { category: 'not_measurable', via: 'CMO exam' },
  'Back Pain (SAS)': {
    category: 'not_measurable',
    via: 'crew report',
    note: 'Not counted under the flank-pain question: that question is a renal-stone red flag, and space-adaptation back pain is kept apart from it.',
  },
  'Insomnia (SAS)': { category: 'case', caseId: 'sleep_circadian', symptoms: ['trouble_sleeping'] },
  'Shoulder Sprain/Strain': { category: 'not_measurable', via: 'CMO exam' },
  'CO2 Headache': { category: 'asked_daily', symptoms: ['headache'], ruleId: 'pel_cabin_ppco2_1h' },
  'Headache (SAS)': { category: 'asked_daily', symptoms: ['headache'] },
  'Spaceflight Associated Neuro-ocular Syndrome (SANS)': {
    category: 'asked_symptom',
    symptoms: ['vision_change'],
    note: 'SANS is usually found by eye imaging, not symptoms.',
  },
  'Urinary Tract Infection': { category: 'asked_daily', symptoms: ['painful_urination', 'fever_chills'] },
  'Skin Infection': { category: 'not_measurable', via: 'CMO exam' },
  'Elbow Sprain/Strain': { category: 'not_measurable', via: 'CMO exam' },
  'Ankle Sprain/Strain': { category: 'not_measurable', via: 'CMO exam' },
  'Allergic Reaction': { category: 'not_measurable', via: 'CMO exam' },
  Pharyngitis: { category: 'not_measurable', via: 'CMO exam' },
  Constipation: { category: 'not_measurable', via: 'crew report' },
  'Neck Injury': { category: 'not_measurable', via: 'CMO exam' },
  'Mouth Ulcer': { category: 'not_measurable', via: 'crew report' },
  'Dental Caries': { category: 'not_measurable', via: 'CMO exam' },
  'Knee Sprain/Strain': { category: 'not_measurable', via: 'CMO exam' },
  'Paresthesia [Extravehicular Activity (EVA)]': { category: 'not_measurable', via: 'crew report' },
  Indigestion: { category: 'not_measurable', via: 'crew report' },
  'Eye Chemical Burn': { category: 'not_measurable', via: 'CMO exam' },
  Sinusitis: { category: 'not_measurable', via: 'CMO exam' },
  'Hearing Loss': { category: 'not_measurable', via: 'medical kit' },
  'Wrist Sprain/Strain': { category: 'not_measurable', via: 'CMO exam' },
  'Eye Infection': { category: 'not_measurable', via: 'CMO exam' },
  'Hip Sprain/Strain': { category: 'not_measurable', via: 'CMO exam' },
  Gastroenteritis: { category: 'not_measurable', via: 'crew report' },
  'Fingernail Delamination [Extravehicular Activity (EVA)]': { category: 'not_measurable', via: 'CMO exam' },
  'Otitis Externa': { category: 'not_measurable', via: 'CMO exam' },
  'Otitis Media': { category: 'not_measurable', via: 'CMO exam' },
  Hemorrhoids: { category: 'not_measurable', via: 'crew report' },
  'Lower Extremity Stress Fracture': { category: 'not_measurable', via: 'medical kit' },
  'Urinary Retention': { category: 'asked_daily', symptoms: ['cannot_pass_urine'] },
  'Skin Laceration': { category: 'not_measurable', via: 'CMO exam' },
  Influenza: { category: 'not_measurable', via: 'CMO exam' },
  'Finger Dislocation': { category: 'not_measurable', via: 'CMO exam' },
  Shingles: { category: 'not_measurable', via: 'CMO exam' },
  'Dental Abscess': { category: 'not_measurable', via: 'CMO exam' },
}

/** The frozen Table E.2-2 rows -> the Table E.2-1 rows whose category is their LANDFALL status. */
export const E22_TO_IMM: Readonly<Record<string, readonly string[]>> = {
  'Insomnia/sleep disturbances/circadian misalignment': ['Late Insomnia', 'Insomnia (SAS)'],
  'Headache (CO2 related)': ['CO2 Headache'],
  'Urinary retention (space-adaptation related)': ['Urinary Retention'],
  Nephrolithiasis: [],
}

/** Short case names for the running text (cases.json ids). */
export const CASE_SHORT: Readonly<Record<string, string>> = { sleep_circadian: 'sleep', renal_stone: 'renal', spe_shelter: 'shelter' }

// ---- computing from the snapshot -----------------------------------------------------------------------

export interface CoverageRow extends ImmRow {
  entry: CoverageEntry | null
}

export function coverageRows(table: ImmTable): CoverageRow[] {
  return table.rows.map((r) => ({ ...r, entry: IMM_COVERAGE[r.condition] ?? null }))
}

export interface CategoryTotal {
  category: CoverageCategory
  count: number
  /** Sum of the likelihoods of its rows (expected events per mission in the sample), left to right. */
  sum: number
  /** sum / total. */
  share: number
  conditions: string[]
}

export interface CoverageSummary {
  /** Sum of all likelihoods, left to right (derived). */
  total: number
  rows: number
  unmapped: string[]
  byCategory: Record<CoverageCategory, CategoryTotal>
  ordered: CategoryTotal[]
}

export function coverageSummary(rows: CoverageRow[]): CoverageSummary {
  const byCategory = Object.fromEntries(
    CATEGORY_ORDER.map((c) => [c, { category: c, count: 0, sum: 0, share: 0, conditions: [] as string[] }]),
  ) as Record<CoverageCategory, CategoryTotal>
  let total = 0
  const unmapped: string[] = []
  for (const r of rows) {
    total = total + r.likelihood.value
    if (!r.entry) {
      unmapped.push(r.condition)
      continue
    }
    const c = byCategory[r.entry.category]
    c.count = c.count + 1
    c.sum = c.sum + r.likelihood.value
    c.conditions.push(r.condition)
  }
  for (const c of CATEGORY_ORDER) byCategory[c].share = total > 0 ? byCategory[c].sum / total : 0
  return { total, rows: rows.length, unmapped, byCategory, ordered: CATEGORY_ORDER.map((c) => byCategory[c]) }
}

/** A share as a percentage with one decimal, by the engine's fmt_num (half away from zero): "16.3%". */
export function fmtShare(share: number): string {
  return `${fmtNum(share * 100, 1)}%`
}

/** "Late Insomnia" -> "Late insomnia"; acronyms (SAS, EVA, SANS, CO2) keep their capitals. */
export function sentenceCase(name: string): string {
  return name
    .split(' ')
    .map((w, i) => (i === 0 || /^[[(]?[A-Z0-9]{2,}[\])]*$/.test(w) ? w : w.toLowerCase()))
    .join(' ')
}

/** The most likely condition of the sample (highest likelihood; the first printed on a tie). */
export function mostLikely(rows: CoverageRow[]): CoverageRow | null {
  let best: CoverageRow | null = null
  for (const r of rows) if (!best || r.likelihood.value > best.likelihood.value) best = r
  return best
}

/**
 * The one-line headline, from the data: "Late insomnia is the most likely in-mission condition in NASA’s
 * sample IMM output (13.85 per mission): the sleep case watches it." Null unless a case watches that row.
 */
export function headline(rows: CoverageRow[]): string | null {
  const top = mostLikely(rows)
  const caseId = top?.entry?.category === 'case' ? top.entry.caseId : undefined
  if (!top || !caseId || !CASE_SHORT[caseId]) return null
  return `${sentenceCase(top.condition)} is the most likely in-mission condition in NASA’s sample IMM output (${top.likelihood.text}): the ${CASE_SHORT[caseId]} case watches it.`
}

export function symptomLabels(ids: readonly SymptomId[] | undefined): string[] {
  return (ids ?? []).map((id) => SYMPTOMS.find((s) => s.id === id)?.label ?? id)
}

/** Whether a daily-check symptom is also one of the renal case's red-flag questions. */
export function isRenalRedFlag(id: SymptomId): boolean {
  return RENAL_SYMPTOMS.includes(id)
}

/** Case ids with no Table E.2-1 row mapped to them (they rest on other sources). */
export function casesWithoutRows(rows: CoverageRow[], caseIds: readonly string[]): string[] {
  const used = new Set(rows.map((r) => r.entry?.caseId).filter((x): x is string => !!x))
  return caseIds.filter((id) => !used.has(id))
}

/** The one line under the section heading, visible while the section is closed. */
export function abstractOf(s: CoverageSummary | null): string {
  if (!s) return 'NASA’s sample IMM output (Vol 1 Appendix E), scored condition by condition: what a case watches, what the daily check asks, what is not measurable here.'
  const b = s.byCategory
  return `Weighted by likelihood, ${fmtShare(b.case.share)} of NASA’s sample IMM output is watched by a case and ${fmtShare(b.asked_daily.share)} is asked about daily (${fmtShare(b.asked_symptom.share)} more by a symptom only); ${fmtShare(b.not_measurable.share)} is not measurable here.`
}

/** "HRR risk 81" and its link, from the basis of the renal case's red-flag step (cases.json r4). */
export function hrrOfRenalRedFlags(): { id: string; url: string } | null {
  const renal = CASE_DEFS.find((c) => c.id === 'renal_stone')
  for (const step of renal?.procedure ?? []) {
    if (!step.red_flag) continue
    const src = step.basis?.source as { citation?: string; url?: string } | undefined
    const m = src?.citation ? /HRR risk \d+/.exec(src.citation) : null
    if (m && src?.url) return { id: m[0], url: src.url }
  }
  return null
}
