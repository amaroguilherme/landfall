// The corpus of the search: the 57 NASA-STD-3001 requirements LANDFALL froze, read from the two snapshots the app
// already precaches (std_vol1_requirements, std_vol2_requirements). No new data file. Every field is the snapshot's
// own, verbatim; [V2 6109] is listed twice in Vol 2's snapshot and appears here once.
import type { Vol1Data, Vol2Data } from '../method/rules'
import { normReqId } from '../method/rules'

export interface Passage {
  /** "V1 4030", "V2 6109". */
  id: string
  vol: 1 | 2
  /** e.g. "NASA-STD-3001 Vol 2 Rev F". */
  docLabel: string
  section: string
  title: string
  /** The requirement's statement: the snapshot's `text`, verbatim. */
  statement: string
  /** The snapshot's `rationale`, verbatim, or null. */
  rationale: string | null
  printedPage: number
  /** The NASA PDF, opened at the requirement's page. */
  pdfHref: string
  snapshot: 'std_vol1_requirements' | 'std_vol2_requirements'
  verified: boolean
  /** Title, statement and rationale joined by single spaces: what both rankings read. */
  text: string
}

const join = (...parts: Array<string | null | undefined>): string => parts.filter((p): p is string => !!p).join(' ')

/** Vol 1 then Vol 2, in snapshot order, first occurrence of each ID. Empty until both snapshots are loaded. */
export function buildPassages(v1: Vol1Data | null | undefined, v2: Vol2Data | null | undefined): Passage[] {
  if (!v1 || !v2) return []
  const out: Passage[] = []
  const seen = new Set<string>()
  for (const r of v1.requirements) {
    const id = normReqId(r.id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      vol: 1,
      docLabel: `NASA-STD-3001 Vol 1 Rev ${v1.document.revision}`,
      section: r.section,
      title: r.section_title,
      statement: r.text,
      rationale: r.rationale,
      printedPage: r.printed_page,
      pdfHref: `${v1.document.url}#page=${r.pdf_page_number}`,
      snapshot: 'std_vol1_requirements',
      verified: r.verified,
      text: join(r.section_title, r.text, r.rationale),
    })
  }
  for (const r of v2.requirements) {
    const id = normReqId(r.id)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      vol: 2,
      docLabel: `NASA-STD-3001 Vol 2 Rev ${v2.document.revision}`,
      section: r.section,
      title: r.title,
      statement: r.text,
      rationale: r.rationale,
      printedPage: r.printed_page,
      pdfHref: `${v2.document.pdf_url}#page=${r.pdf_page}`,
      snapshot: 'std_vol2_requirements',
      verified: r.verified,
      text: join(r.title, r.text, r.rationale),
    })
  }
  return out
}

/** A requirement ID as typed: an optional "V1" / "V2" (any case, then spaces or a hyphen) and its 4- or 5-digit number. */
const ID = /(?:\b(V[12])[\s-]*)?\b(\d{4,5})\b/gi

/**
 * Requirement IDs typed in the words ("6164", "V1 4030", "[V2 10130]", "v2-6109"): the frozen requirements they
 * name, in the order typed. A bare number matches either volume. No model is involved.
 */
export function idJump(query: string, passages: readonly Passage[]): Passage[] {
  const out: Passage[] = []
  for (const m of query.matchAll(ID)) {
    const vol = m[1]?.toUpperCase()
    for (const p of passages) {
      const [pv, pn] = p.id.split(' ')
      if (pn === m[2] && (!vol || vol === pv) && !out.includes(p)) out.push(p)
    }
  }
  return out
}

/** True when the words name frozen requirements and nothing else ("6164", "[V2 10130]"): there is nothing to rank. */
export function onlyIds(query: string, passages: readonly Passage[]): boolean {
  return idJump(query, passages).length > 0 && !/[\p{L}\p{N}]/u.test(query.replace(ID, ' ').replace(/\b(?:V[12])\b/gi, ' '))
}
