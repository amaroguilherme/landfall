// The hand-written WordPiece encoder against the real tokenizer (Hugging Face tokenizers 0.23.3, frozen by
// tools/find/make_vectors.py and tools/find/unicode_tables.py): the same IDs on every fixture string, and the same
// normalisation and character class on every code point.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_WORD_CHARS, charClass, encode, normalize, parseVocab, preTokenize } from './wordpiece'

const MODEL_DIR = new URL('../../../public/assets/models/potion-base-8M-bf8b0566/', import.meta.url)
const vocab = parseVocab(readFileSync(new URL('vocab.txt', MODEL_DIR), 'utf8'))
const fixture = JSON.parse(readFileSync(new URL('./fixtures/tokens.json', import.meta.url), 'utf8')) as {
  counts: Record<string, number>
  strings: { kind: string; s: string; ids: number[] }[]
}
const codepoints = JSON.parse(readFileSync(new URL('./fixtures/codepoints.json', import.meta.url), 'utf8')) as {
  sha256: string
  code_points: number
}

describe('vocabulary', () => {
  it('has the 29,528 tokens of potion-base-8M, [UNK] at ID 1 (not BERT\'s 100), longest token 18 code points', () => {
    expect(vocab.tokens.length).toBe(29528)
    expect(vocab.ids.size).toBe(29528)
    expect(vocab.unk).toBe(1)
    expect(vocab.tokens.slice(0, 5)).toEqual(['[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]'])
    expect(vocab.maxChars).toBe(18)
  })
})

describe('token IDs equal the Hugging Face tokenizer on every fixture string', () => {
  it('covers at least 500 strings: the 57 passages, 200+ queries, typos and Unicode cases (and the gold questions)', () => {
    expect(fixture.strings.length).toBeGreaterThanOrEqual(500)
    expect(fixture.counts.passage).toBe(57)
    expect(fixture.counts.query).toBeGreaterThanOrEqual(200)
    expect(fixture.counts.typo).toBeGreaterThanOrEqual(100)
    expect(fixture.counts.unicode).toBeGreaterThanOrEqual(80)
    const s = fixture.strings.map((x) => x.s)
    expect(s.some((x) => Array.from(x).length > MAX_WORD_CHARS && !/\s/.test(x))).toBe(true) // a word over 100 code points
    expect(s.some((x) => /[一-鿿]/.test(x))).toBe(true) // CJK
    expect(s.some((x) => /\p{Extended_Pictographic}/u.test(x))).toBe(true) // emoji
    expect(s.some((x) => /[“”‘’]/.test(x))).toBe(true) // curly quotes
    expect(s.some((x) => x.includes('—'))).toBe(true) // em dash
    expect(s.some((x) => /[éèüçãåâ]/.test(x))).toBe(true) // accents
  })
  it.each(['passage', 'query', 'typo', 'unicode', 'gold'])('%s strings', (kind) => {
    const rows = fixture.strings.filter((x) => x.kind === kind)
    const bad = rows.filter((x) => JSON.stringify(encode(x.s, vocab)) !== JSON.stringify(x.ids)).map((x) => x.s)
    expect(bad).toEqual([])
  })
})

describe('normaliser and pre-tokenizer on every code point', () => {
  it('reproduces the tokenizer on all 1,112,064 code points (one SHA-256 over every output)', () => {
    const h = createHash('sha256')
    let n = 0
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      h.update(`${cp.toString(16)}\t${normalize(String.fromCodePoint(cp))}\t${charClass(cp)}\n`, 'utf8')
      n += 1
    }
    expect(n).toBe(codepoints.code_points)
    expect(h.digest('hex')).toBe(codepoints.sha256)
  })
  it('examples: accents stripped after NFD, curly quotes and dashes isolated, CJK split, controls dropped', () => {
    expect(normalize('Crème BRÛLÉE')).toBe('creme brulee')
    expect(normalize('ΟΔΥΣΣΕΥΣ')).toBe('οδυσσευσ') // per code point: no final sigma
    expect(normalize('a​b c\u000bd')).toBe('ab cd')
    expect(normalize('水の')).toBe(' 水 の')
    expect(preTokenize(normalize('it’s “safe”—really'))).toEqual(['it', '’', 's', '“', 'safe', '”', '—', 'really'])
  })
})
