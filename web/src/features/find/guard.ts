// The symptom check of the search: a fixed word list, run on the typed words before any search and whether or not
// the model is on this device. A port of Stabilis' crisis detector (webapp/app/lib/safety/crisis.ts: normalise,
// split into segments, keep the longest phrase where matches overlap) in its patient mode, with no negation, so
// "no blood in my urine" still fires. It reads only the text in the box: no observation, no case, no event.
//
// Its words: the renal-stone case's six red flags (engine/rules/cases.json renal_stone r4, verbatim), the three
// urgent symptoms of the Noon Sight (record.ts URGENT_SYMPTOMS, labelled as record.ts SYMPTOMS labels them), and
// the phrases in guard.lexicon.json (a design
// choice). What it says comes from the rules too: the escalation clause of that same r4 step, and the refusals of
// engine/rules/meta.json, verbatim.
import { RULES } from '../../app/engine'
import { SYMPTOMS } from '../noon-sight/record'
import { normalizeWords } from './bm25'
import lexicon from './guard.lexicon.json'

export type GuardKind = 'symptom' | 'no_dosing' | 'no_diagnosis' | 'no_reid'
const KINDS: readonly GuardKind[] = ['symptom', 'no_dosing', 'no_diagnosis', 'no_reid']

interface StepLike {
  id?: string
  text?: string
  red_flags?: string[]
}

/** The renal-stone case's red-flag step (cases.json renal_stone, procedure r4). */
export const RED_FLAG_STEP: StepLike | null = (() => {
  const c = RULES.cases?.cases.find((x) => x.id === 'renal_stone') as { procedure?: StepLike[] } | undefined
  return c?.procedure?.find((s) => s.id === 'r4') ?? null
})()

/** The six red flags, verbatim and in file order. */
export const RED_FLAGS: readonly string[] = RED_FLAG_STEP?.red_flags ?? []

/**
 * The Noon Sight's urgent symptoms (record.ts URGENT_SYMPTOMS: no LANDFALL case, "tell your Crew Medical Officer
 * now"), labelled from its SYMPTOMS list. The IDs are listed here so the shared record chunk needs no new export;
 * guard.test.ts checks they are exactly URGENT_SYMPTOMS.
 */
export const URGENT_IDS = ['chest_pain', 'short_of_breath', 'vision_change'] as const
export const URGENT_LABELS: readonly string[] = URGENT_IDS.map((id) => SYMPTOMS.find((x) => x.id === id)?.label ?? id)

/**
 * Whom to tell, in the rules' own words: the clause of r4's text that starts "tell your Crew Medical Officer now" and
 * runs to its closing parenthesis, "(if that is you, the Commander)". Null if the rules no longer carry it.
 */
export const TELL_CMO: string | null = (() => {
  const text = RED_FLAG_STEP?.text ?? ''
  const at = text.indexOf('tell your Crew Medical Officer now')
  const end = at >= 0 ? text.indexOf(')', at) : -1
  return end > at ? text.slice(at, end + 1) : null
})()

interface Refusal {
  id: string
  text: string
}
const REFUSALS: readonly Refusal[] = ((RULES.meta as { refusals?: Refusal[] } | null)?.refusals ?? []).filter(
  (r) => typeof r?.id === 'string' && typeof r?.text === 'string',
)

/** A meta.json refusal, verbatim ("no_dosing", "no_diagnosis", "no_reid"). */
export const refusalText = (id: string): string | null => REFUSALS.find((r) => r.id === id)?.text ?? null

// ---- matching (Stabilis' algorithm) ------------------------------------------------------------------------------

const SEGMENT_SPLIT = /[.!?;:\n]+/

const tokens = (text: string): string[] => {
  const n = normalizeWords(text)
  return n ? n.split(' ') : []
}

interface Term {
  kind: GuardKind
  /** The phrase as listed (what the banner quotes). */
  text: string
  phrase: string[]
}

/** Every phrase of the check, by kind, as printed on the page (imported lists first). */
export const GUARD_PHRASES: Readonly<Record<GuardKind, readonly string[]>> = (() => {
  const own = (id: GuardKind): string[] => lexicon.terms.find((t) => t.id === id)?.phrases ?? []
  return {
    symptom: [...RED_FLAGS, ...URGENT_LABELS, ...own('symptom')],
    no_dosing: own('no_dosing'),
    no_diagnosis: own('no_diagnosis'),
    no_reid: own('no_reid'),
  }
})()

const TERMS: readonly Term[] = KINDS.flatMap((kind) =>
  GUARD_PHRASES[kind].map((p) => ({ kind, text: p, phrase: tokens(p) })).filter((t) => t.phrase.length > 0),
)

export interface GuardHit {
  kind: GuardKind
  /** The listed phrase that matched: the typed words up to case and punctuation ("can't catch my breath"). */
  words: string
}

const matchesAt = (ws: readonly string[], start: number, phrase: readonly string[]): boolean =>
  start + phrase.length <= ws.length && phrase.every((t, i) => ws[start + i] === t)

/** Every match, segment by segment; overlapping matches keep the longest phrase (then the earliest, then list order). */
export function guardHits(text: string): GuardHit[] {
  const hits: GuardHit[] = []
  for (const segment of (text ?? '').split(SEGMENT_SPLIT)) {
    const ws = tokens(segment)
    if (!ws.length) continue
    const found: [number, number, number][] = [] // [start, end, term index]
    TERMS.forEach((t, ti) => {
      for (let s = 0; s + t.phrase.length <= ws.length; s++) if (matchesAt(ws, s, t.phrase)) found.push([s, s + t.phrase.length, ti])
    })
    found.sort((a, b) => b[1] - b[0] - (a[1] - a[0]) || a[0] - b[0] || a[2] - b[2])
    const kept: [number, number, number][] = []
    for (const m of found) if (kept.every((k) => m[1] <= k[0] || m[0] >= k[1])) kept.push(m)
    kept.sort((a, b) => a[0] - b[0])
    for (const [, , ti] of kept) hits.push({ kind: TERMS[ti].kind, words: TERMS[ti].text })
  }
  return hits
}

export interface GuardBanner {
  kind: GuardKind
  /** Distinct matched words, in the order typed. */
  words: string[]
}

/** One banner per kind that fired, symptoms first. */
export function guardBanners(text: string): GuardBanner[] {
  const hits = guardHits(text)
  return KINDS.flatMap((kind) => {
    const words = [...new Set(hits.filter((h) => h.kind === kind).map((h) => h.words))]
    return words.length ? [{ kind, words }] : []
  })
}
