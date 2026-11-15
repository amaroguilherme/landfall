// Pure helpers for "This storm had witnesses": the STS-34 flight (snapshot history_sts34) and the
// moments of the replayed October 1989 event (swpc_spe_replay), computed here, never typed. The card
// juxtaposes facts: it computes no ratio and attributes no dose to STS-34.
import type { ReplayData, RequirementRec } from './model'
import { firstReach, transitions } from './model'

export const HISTORY_SNAPSHOT_ID = 'history_sts34'

export interface QuoteRec {
  id: string
  text: string
  verified_this_build: boolean
}

export interface HistoryData {
  mission: string
  use_note: string
  flight: {
    orbiter: string
    payload: string
    launch_local: string
    landing_local: string
    launch_utc: string
    landing_utc: string
    duration_s: number
    duration_printed: string
    orbit_altitude_nmi: number | null
    orbit_inclination_deg: number | null
    crew: string[]
    crew_count: number
  }
  nasa_page: { url: string; quotes: QuoteRec[] }
  golightly_1992: {
    pmid: string
    title: string
    journal: string
    volume: string
    issue: string
    year: string
    pages: string
    authors: string[]
    doi: string
    pubmed_url: string
    citation: string
    quotes: QuoteRec[]
  }
}

export interface GlossaryRec {
  term: string
  definition: string
  appendix?: string
}

export type ReplayWithEvent = ReplayData & {
  sesc_event_computed?: ReplayData['sesc_event_computed'] & { unbroken_ge_10pfu_until?: string; end_last_ge_10pfu?: string }
}

export interface ReplayMoments {
  onset: string
  firstS3: string | null
  peak: string
  peakPfu: number
  unbrokenUntil: string | null
}

/** Onset and peak from the SESC event computed by the swpc adapter; first S3 from the S-level transitions. */
export function replayMoments(r: ReplayWithEvent | null | undefined): ReplayMoments | null {
  const ev = r?.sesc_event_computed
  if (!r || !ev?.start || !ev.max_time || typeof ev.max_pfu !== 'number') return null
  const s3 = firstReach(transitions(r, null)).find((t) => t.level === 3)
  return { onset: ev.start, firstS3: s3?.utc ?? null, peak: ev.max_time, peakPfu: ev.max_pfu, unbrokenUntil: ev.unbroken_ge_10pfu_until ?? null }
}

export function inWindow(iso: string | null | undefined, start: string, stop: string): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && Date.parse(start) <= t && t <= Date.parse(stop)
}

/** "19 Oct 13:10 UTC", or "18 Oct 1989 16:53:40 UTC" with the year; seconds only when they are not zero. */
export function dayTimeUtc(iso: string, withYear = false): string {
  const d = new Date(Date.parse(iso))
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const two = (n: number) => String(n).padStart(2, '0')
  const sec = d.getUTCSeconds() ? `:${two(d.getUTCSeconds())}` : ''
  return `${d.getUTCDate()} ${mon}${withYear ? ` ${d.getUTCFullYear()}` : ''} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}${sec} UTC`
}

/** The sentence of the Vol 1 SPE glossary entry that names low altitudes (the magnetosphere's protection). */
export function speGlossarySentence(glossary: readonly GlossaryRec[] | undefined): { sentence: string; appendix: string | null } | null {
  const g = glossary?.find((x) => /^Solar Particle Event/.test(x.term))
  if (!g) return null
  const sentence = g.definition
    .split(/(?<=\.)\s+/)
    .find((s) => s.includes('polar regions'))
  return sentence ? { sentence, appendix: g.appendix ?? null } : null
}

export function quoteText(list: readonly QuoteRec[] | undefined, id: string): string | null {
  const q = list?.find((x) => x.id === id)
  return q && q.verified_this_build ? q.text : null
}

/** [V1 4031], verbatim from the frozen Vol 1 snapshot. */
export function v1_4031(reqs: readonly RequirementRec[] | undefined): RequirementRec | null {
  return reqs?.find((r) => r.id.replace(/^\[|\]$/g, '') === 'V1 4031') ?? null
}
