// The keyword column: Stabilis' normalisation, the printed stopwords, and Okapi BM25 (k1 1.2, b 0.75) checked by
// hand on a toy corpus and on the frozen requirements.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { B, K1, STOPWORDS, bm25Score, buildIndex, hasUnreadable, keywordSearch, normalizeWords, queryTerms, words } from './bm25'
import { buildPassages } from './passages'

const snap = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8')).data
const passages = buildPassages(snap('std_vol1_requirements'), snap('std_vol2_requirements'))
const index = buildIndex(passages.map((p) => p.text))
const top3 = (q: string) => keywordSearch(index, q).slice(0, 3).map((h) => passages[h.index].id)

describe('normalisation (Stabilis normalize)', () => {
  it('NFKD, marks dropped, lower case, everything outside a-z 0-9 a space', () => {
    expect(normalizeWords('Crème BRÛLÉE — 2,5 L!')).toBe('creme brulee 2 5 l')
    expect(normalizeWords('ﬁre ½ “quotes” can’t')).toBe('fire 1 2 quotes can t')
    expect(words('  ')).toEqual([])
  })
  it('tells when the text has letters or digits it cannot read (none left in a-z 0-9 after normalising)', () => {
    for (const t of ['радиация на Марсе', 'ακτινοβολία', '水の量', 'what is радиация', 'Straße', '٣']) expect(hasUnreadable(t)).toBe(true)
    for (const t of ['Crème BRÛLÉE — 2,5 L!', 'ﬁre ½ “quotes” can’t', '３ Ⅻ', '🚀🚀🚀', 'what is it', '???', '']) expect(hasUnreadable(t)).toBe(false)
  })
  it('stopwords are skipped and reported; nothing is stemmed', () => {
    expect(queryTerms('How much water per day for the crew?')).toEqual({ terms: ['much', 'water', 'day', 'crew'], skipped: ['how', 'per', 'for', 'the'] })
    expect(STOPWORDS).toContain('the')
    expect(STOPWORDS).not.toContain('dose')
    expect(STOPWORDS).not.toContain('shall')
    expect([...STOPWORDS].sort()).toEqual(STOPWORDS)
  })
})

describe('Okapi BM25', () => {
  it('k1 = 1.2, b = 0.75, idf = ln(1 + (N - df + 0.5) / (df + 0.5)): one toy case by hand', () => {
    expect([K1, B]).toEqual([1.2, 0.75])
    const toy = buildIndex(['water water crew', 'crew sleep', 'light'])
    // avgdl = 2; "water": df 1, tf 2, dl 3 -> idf ln(1 + 2.5 / 1.5)
    const idf = Math.log(1 + 2.5 / 1.5)
    const expected = (idf * 2 * (K1 + 1)) / (2 + K1 * (1 - B + (B * 3) / 2))
    const hits = keywordSearch(toy, 'water')
    expect(hits).toEqual([{ index: 0, matched: ['water'] }])
    expect(bm25Score(toy, 0, ['water'])).toBeCloseTo(expected, 12)
    expect(bm25Score(toy, 1, ['water'])).toBe(0)
    // the only passage with the word wins; a word in no passage finds nothing
    expect(keywordSearch(toy, 'zebra')).toEqual([])
    expect(keywordSearch(toy, 'crew').map((h) => h.index)).toEqual([1, 0]) // shorter passage first at equal tf
  })
  it('on the frozen requirements: drinking water first, electric current, stale data', () => {
    expect(top3('how much drinking water per day')[0]).toBe('V2 6109')
    expect(top3('leakage current from bioinstrumentation')[0]).toBe('V2 9023')
    expect(top3('stale missing or unavailable data')).toContain('V2 10020')
    expect(keywordSearch(index, 'zebra pizza')).toEqual([])
    expect(keywordSearch(index, 'the of and')).toEqual([])
  })
})
