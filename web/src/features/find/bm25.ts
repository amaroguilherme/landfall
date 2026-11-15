// The keyword column ("Your words appear in"): Okapi BM25 over the frozen requirements, no model. Words are
// normalised as Stabilis' crisis detector does (NFKD, marks dropped, lower case, anything but a-z and 0-9 is a
// space), the stopwords below are skipped, and nothing is stemmed: a passage scores only for words you typed.

export const K1 = 1.2
export const B = 0.75

/** Common words the keyword search skips (a design choice, printed on the page). */
export const STOPWORDS: readonly string[] = [
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'can',
  'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'per', 's', 'she', 'should', 'so',
  'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too',
  'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you',
  'your',
]
const STOP = new Set(STOPWORDS)

/** Stabilis normalize(): NFKD, drop marks, lower case, every run of characters outside 0-9 a-z becomes a space. */
export function normalizeWords(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^0-9a-z]+/g, ' ')
    .trim()
}

/** Whether the text has letters or digits that normalizeWords turns into spaces (Cyrillic, Greek, CJK): words this search cannot read. */
export function hasUnreadable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[0-9a-z]+/g, ''))
}

export const words = (text: string): string[] => {
  const n = normalizeWords(text)
  return n ? n.split(' ') : []
}

export interface Bm25Index {
  n: number
  avgdl: number
  lengths: number[]
  tf: Map<string, number>[]
  df: Map<string, number>
}

export function buildIndex(texts: readonly string[]): Bm25Index {
  const tf: Map<string, number>[] = []
  const df = new Map<string, number>()
  const lengths: number[] = []
  for (const t of texts) {
    const m = new Map<string, number>()
    const ws = words(t)
    for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1)
    for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1)
    tf.push(m)
    lengths.push(ws.length)
  }
  const n = texts.length
  return { n, avgdl: n ? lengths.reduce((s, x) => s + x, 0) / n : 0, lengths, tf, df }
}

export interface KeywordQuery {
  /** Distinct searched words, in the order typed. */
  terms: string[]
  /** Distinct typed words skipped as stopwords. */
  skipped: string[]
}

export function queryTerms(query: string): KeywordQuery {
  const terms: string[] = []
  const skipped: string[] = []
  for (const w of words(query)) {
    const list = STOP.has(w) ? skipped : terms
    if (!list.includes(w)) list.push(w)
  }
  return { terms, skipped }
}

export interface KeywordHit {
  index: number
  /** The searched words this passage contains. */
  matched: string[]
}

/** BM25 of passage i for these terms: the sum over its terms of idf x tf (k1 + 1) / (tf + k1 (1 - b + b dl / avgdl)). */
export function bm25Score(index: Bm25Index, i: number, terms: readonly string[]): number {
  let score = 0
  for (const t of terms) {
    const f = index.tf[i].get(t)
    if (!f) continue
    const df = index.df.get(t) ?? 0
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5))
    score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * index.lengths[i]) / index.avgdl))
  }
  return score
}

/** Passages containing at least one searched word, highest BM25 first (ties: passage order). Scores stay inside. */
export function keywordSearch(index: Bm25Index, query: string): KeywordHit[] {
  const { terms } = queryTerms(query)
  const scored: { index: number; score: number; matched: string[] }[] = []
  for (let i = 0; i < index.n; i++) {
    const matched = terms.filter((t) => index.tf[i].has(t))
    if (matched.length) scored.push({ index: i, score: bm25Score(index, i, matched), matched })
  }
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(({ index: i, matched }) => ({ index: i, matched }))
}
