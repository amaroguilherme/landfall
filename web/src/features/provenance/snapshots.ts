// Lookups into the frozen NASA-STD-3001 and NOAA snapshots (/data/std_vol1_requirements.json,
// /data/std_vol2_requirements.json, /data/swpc_s_scale.json). The shell's useSnapshot() fetches
// and parses each file once per session; the indexes below are built once per parsed object
// (WeakMap), so re-renders never re-scan the big files.
import type { RuleSource } from './model'

export const VOL_SNAPSHOT = { 1: 'std_vol1_requirements', 2: 'std_vol2_requirements' } as const
export type Vol = 1 | 2

/** "[V2 6004]" or "V2 6004" -> "V2 6004". */
export function normReqId(id: string): string {
  return id.replace(/^\[|\]$/g, '').trim()
}

export function volOf(source: RuleSource | null | undefined, reqId?: string | null): Vol | null {
  if (source?.snapshot === VOL_SNAPSHOT[1]) return 1
  if (source?.snapshot === VOL_SNAPSHOT[2]) return 2
  const id = reqId ?? source?.requirement_id
  if (id && /^\[?V1 /.test(id)) return 1
  if (id && /^\[?V2 /.test(id)) return 2
  if (source?.doc && /Vol\.? ?1\b/.test(source.doc)) return 1
  if (source?.doc && /Vol\.? ?2\b/.test(source.doc)) return 2
  return null
}

// ---- normalised shapes -----------------------------------------------------------------------

export interface DocInfo {
  vol: Vol
  revision: string | null
  date: string | null
  pdfUrl: string | null
  landingUrl: string | null
  sha256: string | null
  pages: number | null
  title: string | null
}

export interface ReqRecord {
  id: string
  vol: Vol
  section: string | null
  title: string | null
  text: string
  rationale: string | null
  note: string | null
  page: number | null
  verified: boolean | null
  /** The phrase(s) the ingest self-check verified in the statement text. */
  checkedPhrases: string[]
  /** Parsed numbers the ingest found in the statement (Vol 1 only). */
  values: { value: number; unit: string; verbatim: string; op?: string }[]
  /** LANDFALL's own commentary stored in the snapshot (not NASA text). */
  landfallNote: string | null
}

export interface TableRecord {
  id: string
  caption: string
  page: number | number[] | null
  columns: string[]
  /** Each row as label + cells (text exactly as transcribed). */
  rows: { label: string; cells: Record<string, { text: string; value: number | null; unit: string | null }>; marks: string[] }[]
  notes: string[]
  landfallNote: string | null
}

export interface VolIndex {
  doc: DocInfo
  reqs: Map<string, ReqRecord>
  tables: Map<string, TableRecord>
  glossary: { term: string; definition: string; page: number | null }[]
}

interface RawVol1 {
  document?: { revision?: string; date?: string; url?: string; landing_url?: string; sha256?: string; pages?: number; title?: string }
  requirements?: {
    id: string
    section?: string
    section_title?: string
    text: string
    rationale?: string | null
    note?: string | null
    pdf_page_number?: number
    pdf_page_index?: number
    printed_page?: number
    verified?: boolean
    checks?: { check: string; ok: boolean }[]
    values?: { value: number; unit: string; verbatim: string; op?: string }[]
  }[]
  tables?: {
    id: string
    caption: string
    pdf_page_number?: number
    columns: string[]
    rows: Record<string, unknown>[]
    footnotes?: string[]
    note?: string
  }[]
  glossary?: { term: string; definition: string; pdf_page_number?: number }[]
}

interface RawVol2 {
  document?: { revision?: string; approved?: string; pdf_url?: string; sha256?: string; pdf_pages?: number; title?: string }
  requirements?: {
    id: string
    section?: string
    title?: string
    text: string
    rationale?: string | null
    pdf_page?: number
    found?: boolean
    verified?: boolean
    checks?: { in: string; expect: string; ok: boolean }[]
    landfall_note?: string
  }[]
  tables?: Record<
    string,
    { caption: string; page?: number | number[]; columns: string[]; rows: string[][]; notes_verbatim?: string[]; footnote?: string; landfall_note?: string }
  >
}

const cache = new WeakMap<object, VolIndex>()

function strip(s: string | null | undefined): string | null {
  if (!s) return null
  return s.replace(/^\[Rationale:\s*/, '').replace(/\]$/, '')
}

function buildVol1(d: RawVol1, landing: string | null): VolIndex {
  const reqs = new Map<string, ReqRecord>()
  for (const r of d.requirements ?? []) {
    const id = normReqId(r.id)
    reqs.set(id, {
      id,
      vol: 1,
      section: r.section ?? null,
      title: r.section_title ?? null,
      text: r.text,
      rationale: strip(r.rationale),
      note: r.note ?? null,
      page: r.pdf_page_number ?? (r.pdf_page_index !== undefined ? r.pdf_page_index + 1 : null),
      verified: r.verified ?? null,
      checkedPhrases: (r.checks ?? [])
        .map((c) => /statement contains '(.+?)'/.exec(c.check)?.[1])
        .filter((x): x is string => !!x),
      values: r.values ?? [],
      landfallNote: null,
    })
  }
  const tables = new Map<string, TableRecord>()
  for (const t of d.tables ?? []) {
    const cols = t.columns.slice(1)
    tables.set(t.id, {
      id: t.id,
      caption: t.caption,
      page: t.pdf_page_number ?? null,
      columns: cols,
      rows: t.rows.map((row) => {
        const cells: TableRecord['rows'][number]['cells'] = {}
        for (const c of cols) {
          const cell = row[c] as { text?: string; value?: number | null; unit?: string | null } | undefined
          if (cell) cells[c] = { text: cell.text ?? '', value: cell.value ?? null, unit: cell.unit ?? null }
        }
        return { label: String(row.organ ?? row[t.columns[0]] ?? ''), cells, marks: (row.footnote_marks as string[] | undefined) ?? [] }
      }),
      notes: [...(t.note ? [t.note] : []), ...(t.footnotes ?? [])],
      landfallNote: null,
    })
  }
  return {
    doc: {
      vol: 1,
      revision: d.document?.revision ?? null,
      date: d.document?.date ?? null,
      pdfUrl: d.document?.url ?? null,
      landingUrl: d.document?.landing_url ?? landing,
      sha256: d.document?.sha256 ?? null,
      pages: d.document?.pages ?? null,
      title: d.document?.title ?? null,
    },
    reqs,
    tables,
    glossary: (d.glossary ?? []).map((g) => ({ term: g.term, definition: g.definition, page: g.pdf_page_number ?? null })),
  }
}

function buildVol2(d: RawVol2, landing: string | null): VolIndex {
  const reqs = new Map<string, ReqRecord>()
  for (const r of d.requirements ?? []) {
    if (r.found === false) continue
    const id = normReqId(r.id)
    reqs.set(id, {
      id,
      vol: 2,
      section: r.section ?? null,
      title: r.title ?? null,
      text: r.text,
      rationale: strip(r.rationale),
      note: null,
      page: r.pdf_page ?? null,
      verified: r.verified ?? null,
      checkedPhrases: (r.checks ?? []).filter((c) => c.in === 'text').map((c) => c.expect),
      values: [],
      landfallNote: r.landfall_note || null,
    })
  }
  const tables = new Map<string, TableRecord>()
  for (const t of Object.values(d.tables ?? {})) {
    const id = t.caption.split('—')[0].trim()
    const cols = t.columns.slice(1)
    tables.set(id, {
      id,
      caption: t.caption,
      page: t.page ?? null,
      columns: cols,
      rows: t.rows.map((row) => {
        const cells: TableRecord['rows'][number]['cells'] = {}
        cols.forEach((c, i) => {
          cells[c] = { text: row[i + 1] ?? '', value: null, unit: null }
        })
        const mark = /([*#†]+)$/.exec(row[0] ?? '')?.[1]
        return { label: row[0] ?? '', cells, marks: mark ? [mark] : [] }
      }),
      notes: [...(t.notes_verbatim ?? []), ...(t.footnote ? [t.footnote] : [])],
      landfallNote: t.landfall_note ?? null,
    })
  }
  return {
    doc: {
      vol: 2,
      revision: d.document?.revision ?? null,
      date: d.document?.approved ?? null,
      pdfUrl: d.document?.pdf_url ?? null,
      landingUrl: landing,
      sha256: d.document?.sha256 ?? null,
      pages: d.document?.pdf_pages ?? null,
      title: d.document?.title ?? null,
    },
    reqs,
    tables,
    glossary: [],
  }
}

/** Index a parsed std_vol snapshot's `data` (memoised by object identity). */
export function volIndex(vol: Vol, data: unknown, landingUrl: string | null = null): VolIndex | null {
  if (!data || typeof data !== 'object') return null
  const hit = cache.get(data)
  if (hit) return hit
  const idx = vol === 1 ? buildVol1(data as RawVol1, landingUrl) : buildVol2(data as RawVol2, landingUrl)
  cache.set(data, idx)
  return idx
}

// ---- NOAA S-scale ------------------------------------------------------------------------------

export interface NoaaLevel {
  level: string
  n: number
  descriptor: string
  threshold_pfu: number
  threshold_as_printed: string
  biological: string
}

export interface NoaaIndex {
  energy: string | null
  unit: string | null
  unitDefinition: string | null
  rule: string | null
  levels: Map<string, NoaaLevel>
}

const noaaCache = new WeakMap<object, NoaaIndex>()

export function noaaIndex(data: unknown): NoaaIndex | null {
  if (!data || typeof data !== 'object') return null
  const hit = noaaCache.get(data)
  if (hit) return hit
  const d = data as {
    energy?: string
    unit?: string
    unit_definition?: string
    rule?: string
    levels?: { level: string; n: number; descriptor: string; threshold_pfu: number; threshold_as_printed: string; effects?: Record<string, string> }[]
  }
  const idx: NoaaIndex = {
    energy: d.energy ?? null,
    unit: d.unit ?? null,
    unitDefinition: d.unit_definition ?? null,
    rule: d.rule ?? null,
    levels: new Map(
      (d.levels ?? []).map((l) => [
        l.level,
        { level: l.level, n: l.n, descriptor: l.descriptor, threshold_pfu: l.threshold_pfu, threshold_as_printed: l.threshold_as_printed, biological: l.effects?.Biological ?? '' },
      ]),
    ),
  }
  noaaCache.set(data, idx)
  return idx
}

// ---- verbatim matching -----------------------------------------------------------------------

export type MatchResult = 'exact' | 'normalised' | 'absent'

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Does `fragment` occur in any of `haystacks`? Exact first, then whitespace/case-normalised. */
export function matchVerbatim(fragment: string | undefined | null, haystacks: (string | null | undefined)[]): MatchResult | null {
  if (!fragment) return null
  const hs = haystacks.filter((h): h is string => !!h)
  if (hs.some((h) => h.includes(fragment))) return 'exact'
  const f = squash(fragment)
  if (hs.some((h) => squash(h).includes(f))) return 'normalised'
  return 'absent'
}

/** PDF link that opens at a page (#page=N is honoured by browser PDF viewers). */
export function pdfAt(url: string | null | undefined, page: number | number[] | null | undefined): string | null {
  if (!url) return null
  const p = Array.isArray(page) ? page[0] : page
  return p ? `${url}#page=${p}` : url
}
