// Hand-written BERT WordPiece encoder: the encode path of potion-base-8M's tokenizer.json (Hugging Face tokenizers
// 0.23.3: added special tokens, BertNormalizer, BertPreTokenizer, WordPiece), with no dependency. Its token IDs are
// tested equal to the real tokenizer's on every string of fixtures/tokens.json, and its character classes on every
// code point (fixtures/codepoints.json). The contract is written in tools/find/README.md.
import { NONSPACING, NO_NFD, PUNCTUATION, REMOVED, SPLIT_WHITESPACE, WHITESPACE } from './unicode'

/** A WordPiece vocabulary: token -> ID, the [UNK] ID and the longest token in code points. */
export interface Vocab {
  ids: ReadonlyMap<string, number>
  tokens: readonly string[]
  unk: number
  maxChars: number
}

/** tokenizer.json added_tokens: all special, matched in the raw text before normalisation (normalized: false). */
const SPECIAL = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]'] as const
/** tokenizer.json model.max_input_chars_per_word: a longer word is [UNK]. */
export const MAX_WORD_CHARS = 100
const PREFIX = '##'

/** vocab.txt: the tokens in ID order, one per line (tools/find/quantize.py). */
export function parseVocab(text: string): Vocab {
  const tokens = text.split('\n')
  if (tokens[tokens.length - 1] === '') tokens.pop()
  const ids = new Map<string, number>()
  let maxChars = 0
  tokens.forEach((t, i) => {
    if (!ids.has(t)) ids.set(t, i)
    maxChars = Math.max(maxChars, Array.from(t).length)
  })
  const unk = ids.get('[UNK]')
  if (unk === undefined) throw new Error('vocab.txt has no [UNK] token')
  return { ids, tokens, unk, maxChars }
}

// ---- character classes (unicode.ts, read off the Rust tokenizer) ------------------------------------------------

type Ranges = Uint32Array // [start0, end0, start1, end1, ...], sorted

function parseRanges(s: string): Ranges {
  const parts = s ? s.split(',') : []
  const out = new Uint32Array(parts.length * 2)
  parts.forEach((p, i) => {
    const [a, b] = p.split('-')
    out[2 * i] = parseInt(a, 36)
    out[2 * i + 1] = parseInt(b ?? a, 36)
  })
  return out
}

function inRanges(r: Ranges, cp: number): boolean {
  let lo = 0
  let hi = r.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cp < r[2 * mid]) hi = mid - 1
    else if (cp > r[2 * mid + 1]) lo = mid + 1
    else return true
  }
  return false
}

const R_REMOVED = parseRanges(REMOVED)
const R_WHITESPACE = parseRanges(WHITESPACE)
const R_SPLIT = parseRanges(SPLIT_WHITESPACE)
const R_PUNCT = parseRanges(PUNCTUATION)
const R_NONSPACING = parseRanges(NONSPACING)
const R_NO_NFD = parseRanges(NO_NFD)

/** BertNormalizer's "Chinese character" blocks (the CJK Unified Ideographs blocks it pads with spaces). */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b920 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

/** The pre-tokenizer's class of a code point: whitespace (split, removed), punctuation (isolated) or other. */
export function charClass(cp: number): 'w' | 'p' | 'o' {
  return inRanges(R_SPLIT, cp) ? 'w' : inRanges(R_PUNCT, cp) ? 'p' : 'o'
}

// ---- BertNormalizer: clean_text, handle_chinese_chars, strip_accents (NFD, drop Mn), lowercase -------------------

export function normalize(text: string): string {
  let cleaned = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (inRanges(R_REMOVED, cp)) continue
    if (inRanges(R_WHITESPACE, cp)) cleaned += ' '
    else if (isCjk(cp)) cleaned += ` ${ch} `
    else cleaned += ch
  }
  // NFD, except the few code points the tokenizer's older Unicode tables leave whole.
  let nfd = ''
  let run = ''
  for (const ch of cleaned) {
    if (!inRanges(R_NO_NFD, ch.codePointAt(0)!)) run += ch
    else {
      nfd += run.normalize('NFD') + ch
      run = ''
    }
  }
  nfd += run.normalize('NFD')
  let out = ''
  for (const ch of nfd) {
    if (inRanges(R_NONSPACING, ch.codePointAt(0)!)) continue
    // Rust's char::to_lowercase, one code point at a time (so no final-sigma rule).
    out += ch.toLowerCase()
  }
  return out
}

// ---- BertPreTokenizer: split on whitespace, isolate every punctuation character -----------------------------------

export function preTokenize(normalized: string): string[] {
  const words: string[] = []
  let cur = ''
  for (const ch of normalized) {
    const c = charClass(ch.codePointAt(0)!)
    if (c === 'o') {
      cur += ch
      continue
    }
    if (cur) words.push(cur)
    cur = ''
    if (c === 'p') words.push(ch)
  }
  if (cur) words.push(cur)
  return words
}

// ---- WordPiece: greedy longest match, "##" continuation, [UNK] for a word over 100 code points or with no match ----

export function wordPiece(word: string, vocab: Vocab): number[] {
  const chars = Array.from(word)
  if (chars.length > MAX_WORD_CHARS) return [vocab.unk]
  const out: number[] = []
  let start = 0
  while (start < chars.length) {
    // No token is longer than maxChars code points, so longer candidates cannot match (a shortcut, same result).
    let end = Math.min(chars.length, start + vocab.maxChars)
    let id: number | undefined
    while (start < end) {
      const piece = chars.slice(start, end).join('')
      id = vocab.ids.get(start > 0 ? PREFIX + piece : piece)
      if (id !== undefined) break
      end -= 1
    }
    if (id === undefined) return [vocab.unk]
    out.push(id)
    start = end
  }
  return out
}

/** Split the raw text on the special tokens (leftmost match), as the tokenizer's added vocabulary does. */
function splitSpecial(text: string): Array<string | number> {
  const out: Array<string | number> = []
  let rest = text
  for (;;) {
    let at = -1
    let which = -1
    SPECIAL.forEach((s, i) => {
      const j = rest.indexOf(s)
      if (j >= 0 && (at < 0 || j < at)) {
        at = j
        which = i
      }
    })
    if (at < 0) break
    if (at > 0) out.push(rest.slice(0, at))
    out.push(which)
    rest = rest.slice(at + SPECIAL[which].length)
  }
  if (rest) out.push(rest)
  return out
}

/** Token IDs of a text, as tokenizer.encode(text, add_special_tokens=False).ids. */
export function encode(text: string, vocab: Vocab): number[] {
  const ids: number[] = []
  for (const part of splitSpecial(text)) {
    if (typeof part === 'number') {
      ids.push(vocab.ids.get(SPECIAL[part]) ?? vocab.unk)
      continue
    }
    for (const w of preTokenize(normalize(part))) ids.push(...wordPiece(w, vocab))
  }
  return ids
}

/** The word pieces of a text, as strings (for "why it ranked here"). */
export function pieces(text: string, vocab: Vocab): string[] {
  return encode(text, vocab).map((id) => vocab.tokens[id] ?? '')
}
