// The meaning column's model: an 8-bit copy of potion-base-8M (MinishLab, MIT), a table of 29,528 word-piece
// vectors that cannot write text. Nothing is fetched until the first search; then three same-origin files are read
// (the service worker's /assets/* cache-first rule keeps them for offline use) and checked against their SHA-256.
// A text's vector is the mean of its word pieces' rows, L2-normalised; closeness is the dot product. The encode
// contract (tools/find/README.md) is the same as the Python reference (tools/find/make_vectors.py), tested equal.
import { encode, parseVocab } from './wordpiece'
import type { Vocab } from './wordpiece'

export const DIM = 256
/** model2vec's default max_length: only the first 512 token IDs count. */
export const MAX_TOKENS = 512

export const MODEL = {
  name: 'potion-base-8M',
  publisher: 'MinishLab',
  repo: 'minishlab/potion-base-8M',
  url: 'https://huggingface.co/minishlab/potion-base-8M',
  revision: 'bf8b056651a2c21b8d2565580b8569da283cab23',
  licence: 'MIT',
  base: 'BAAI/bge-base-en-v1.5',
  dir: 'assets/models/potion-base-8M-bf8b0566/',
  files: {
    embeddings: { name: 'embeddings.i8', bytes: 7_559_168, sha256: 'e79c31afbaf7b4a876449aa10856e6621d9ffea7cd4d5ce6e64dd6f6ca4a4b29' },
    scales: { name: 'scales.f32', bytes: 118_112, sha256: '9a42e12a15278a8fcf9b41745fb7747b929725e01b5f401f5517713b7369666f' },
    vocab: { name: 'vocab.txt', bytes: 219_690, sha256: '1394523a67ddd404a825428018c0582a6998bcfa044ecbcbf1f4d71adb94c61c' },
  },
} as const

/** Bytes downloaded on the first search (the three files). */
export const MODEL_BYTES = Object.values(MODEL.files).reduce((s, f) => s + f.bytes, 0)

export interface Model {
  vocab: Vocab
  q: Int8Array
  scales: Float32Array
  /** model2vec's character cap before tokenising: max_length x int(median token length). */
  charCap: number
}

/** int(np.median(len(token) for token in vocab)), as model2vec computes it. */
export function medianTokenLength(tokens: readonly string[]): number {
  const L = tokens.map((t) => Array.from(t).length).sort((a, b) => a - b)
  const n = L.length
  return Math.trunc(n % 2 ? L[(n - 1) / 2] : (L[n / 2 - 1] + L[n / 2]) / 2)
}

export function makeModel(embeddings: ArrayBuffer, scales: ArrayBuffer, vocabText: string): Model {
  const vocab = parseVocab(vocabText)
  const rows = vocab.tokens.length
  if (embeddings.byteLength !== rows * DIM || scales.byteLength !== rows * 4) {
    throw new Error(`model files do not fit the vocabulary (${rows} tokens)`)
  }
  return {
    vocab,
    q: new Int8Array(embeddings),
    scales: new Float32Array(scales),
    charCap: MAX_TOKENS * medianTokenLength(vocab.tokens),
  }
}

/** The IDs that count: the text cut to charCap code points, tokenised, the first 512 IDs, [UNK] dropped. */
export function tokenIds(text: string, model: Model): number[] {
  const chars = Array.from(text)
  const capped = chars.length > model.charCap ? chars.slice(0, model.charCap).join('') : text
  return encode(capped, model.vocab)
    .slice(0, MAX_TOKENS)
    .filter((id) => id !== model.vocab.unk)
}

/** Mean of the dequantised rows (q x scale), summed left to right in float64, then L2-normalised. */
export function embedIds(ids: readonly number[], model: Model): Float64Array {
  const acc = new Float64Array(DIM)
  for (const id of ids) {
    const s = model.scales[id]
    const base = id * DIM
    for (let d = 0; d < DIM; d++) acc[d] += model.q[base + d] * s
  }
  if (!ids.length) return acc
  const n = ids.length
  let ss = 0
  for (let d = 0; d < DIM; d++) {
    acc[d] = acc[d] / n
    ss += acc[d] * acc[d]
  }
  const norm = Math.sqrt(ss)
  if (norm > 0) for (let d = 0; d < DIM; d++) acc[d] = acc[d] / norm
  return acc
}

export const embed = (text: string, model: Model): Float64Array => embedIds(tokenIds(text, model), model)

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let d = 0; d < a.length; d++) s += a[d] * b[d]
  return s
}

/** Passage indices, closest first (ties: passage order). The scores stay inside: the page shows rank only. */
export function rankByMeaning(query: Float64Array, passages: readonly Float64Array[]): number[] {
  return passages
    .map((p, i) => ({ i, s: dot(query, p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.i)
}

/**
 * "Why it ranked here": the query's word pieces whose rows point most toward the passage (row . passage vector),
 * strongest first, each piece once, only those that pull it closer.
 */
export function strongestPieces(ids: readonly number[], passage: Float64Array, model: Model, k = 3): string[] {
  const seen = new Map<number, number>()
  for (const id of ids) {
    if (seen.has(id)) continue
    const s = model.scales[id]
    const base = id * DIM
    let v = 0
    for (let d = 0; d < DIM; d++) v += model.q[base + d] * s * passage[d]
    seen.set(id, v)
  }
  return [...seen.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, k)
    .map(([id]) => model.vocab.tokens[id])
}

// ---- loading (first search only) ----------------------------------------------------------------------------------

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'error'

export interface ModelState {
  status: ModelStatus
  model: Model | null
  error: string | null
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null // not a secure context: the size checks still apply
  const d = new Uint8Array(await subtle.digest('SHA-256', buf))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

class OfflineError extends Error {}

async function fetchChecked(base: string, f: { name: string; bytes: number; sha256: string }, fetchImpl: typeof fetch): Promise<ArrayBuffer> {
  let res: Response
  try {
    res = await fetchImpl(`${base}${MODEL.dir}${f.name}`)
  } catch (e) {
    throw new OfflineError((e as Error).message)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${f.name}`)
  if (/text\/html/i.test(res.headers.get('content-type') ?? '')) throw new Error(`${f.name} is not in this build`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength !== f.bytes) throw new Error(`${f.name}: ${buf.byteLength} bytes, expected ${f.bytes}`)
  const h = await sha256Hex(buf)
  if (h !== null && h !== f.sha256) throw new Error(`${f.name}: SHA-256 does not match`)
  return buf
}

/** Fetch and check the three files (same origin), then build the model. */
export async function loadModel(base = import.meta.env.BASE_URL ?? '/', fetchImpl: typeof fetch = fetch): Promise<Model> {
  const [e, s, v] = await Promise.all([
    fetchChecked(base, MODEL.files.embeddings, fetchImpl),
    fetchChecked(base, MODEL.files.scales, fetchImpl),
    fetchChecked(base, MODEL.files.vocab, fetchImpl),
  ])
  return makeModel(e, s, new TextDecoder('utf-8', { fatal: true }).decode(v))
}

let state: ModelState = { status: 'idle', model: null, error: null }
let pending: Promise<ModelState> | null = null
const listeners = new Set<() => void>()

export const modelState = (): ModelState => state
export function subscribeModel(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
function set(next: ModelState): void {
  state = next
  for (const l of listeners) l()
}

/** Start loading once; a failed load (offline, error) is retried by the next search. */
export function ensureModel(): Promise<ModelState> {
  if (state.status === 'ready') return Promise.resolve(state)
  if (pending) return pending
  set({ status: 'loading', model: null, error: null })
  pending = loadModel().then(
    (model) => {
      pending = null
      set({ status: 'ready', model, error: null })
      return state
    },
    (e: unknown) => {
      pending = null
      const offline = e instanceof OfflineError || (typeof navigator !== 'undefined' && navigator.onLine === false)
      set({ status: offline ? 'offline' : 'error', model: null, error: (e as Error).message })
      return state
    },
  )
  return pending
}
