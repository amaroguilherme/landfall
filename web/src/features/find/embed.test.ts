// The meaning column's vectors against the frozen reference (tools/find/make_vectors.py): the shipped 8-bit files
// match SOURCE.md, the TypeScript vectors equal the int8 reference, every frozen query's top 5 is the same, and the
// int8 copy stays within the recorded distance of fp32 model2vec.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_WAIT_MS,
  DIM,
  MAX_TOKENS,
  MODEL,
  MODEL_BYTES,
  embed,
  loadModel,
  loadModelKept,
  makeModel,
  medianTokenLength,
  rankByMeaning,
  refetchWhenControlled,
  strongestPieces,
  tokenIds,
  whenControlled,
} from './embed'
import type { WorkerContainer } from './embed'
import { buildPassages } from './passages'
import { encode } from './wordpiece'

const MODEL_DIR = new URL('../../../public/assets/models/potion-base-8M-bf8b0566/', import.meta.url)
const file = (name: string): Uint8Array => readFileSync(new URL(name, MODEL_DIR))
const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const snap = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8')).data
const model = makeModel(ab(file('embeddings.i8')), ab(file('scales.f32')), readFileSync(new URL('vocab.txt', MODEL_DIR), 'utf8'))
const passages = buildPassages(snap('std_vol1_requirements'), snap('std_vol2_requirements'))
const ref = JSON.parse(readFileSync(new URL('./fixtures/vectors.json', import.meta.url), 'utf8')) as {
  dim: number
  max_tokens: number
  unk_id: number
  median_token_length: number
  char_cap: number
  passage_ids: string[]
  passage_tokens: number[]
  passages: string[]
  queries: { q: string; v: string; top5: string[] }[]
  fp32: { tokens_agree: boolean; cosine: number[]; min_cosine: number }
}
const vec = (b64: string): Float64Array => new Float64Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer)
const maxDiff = (a: Float64Array, b: Float64Array): number => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0)

describe('the shipped 8-bit files', () => {
  const source = readFileSync(new URL('SOURCE.md', MODEL_DIR), 'utf8')
  it.each(Object.values(MODEL.files))('$name matches its size and SHA-256 in SOURCE.md and embed.ts', (f) => {
    const body = file(f.name)
    const sha = createHash('sha256').update(body).digest('hex')
    expect(body.length).toBe(f.bytes)
    expect(sha).toBe(f.sha256)
    expect(source).toContain(`| \`${f.name}\` | ${f.bytes.toLocaleString('en-US')} | \`${sha}\` |`)
  })
  it('come from the pinned source: model.safetensors f65d0f32..., revision bf8b0566', () => {
    expect(source).toContain('f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2')
    expect(source).toContain(MODEL.revision)
  })
  it('total 7,896,970 bytes (7.9 MB), each far under the 25 MiB per-file limit', () => {
    expect(MODEL_BYTES).toBe(7_896_970)
    expect((MODEL_BYTES / 1e6).toFixed(1)).toBe('7.9')
    for (const f of Object.values(MODEL.files)) expect(f.bytes).toBeLessThan(25 * 1024 * 1024)
  })
})

describe('encode contract', () => {
  it('512 tokens, [UNK] = 1, median token length 6, so a 3,072 code-point cap (as the reference)', () => {
    expect([DIM, MAX_TOKENS, model.vocab.unk, medianTokenLength(model.vocab.tokens), model.charCap]).toEqual([
      ref.dim,
      ref.max_tokens,
      ref.unk_id,
      ref.median_token_length,
      ref.char_cap,
    ])
    expect(ref.char_cap).toBe(3072)
  })
  it('the 57 passages, in the reference order and token counts (5 run past 512 tokens and are cut)', () => {
    expect(passages.map((p) => p.id)).toEqual(ref.passage_ids)
    expect(passages.length).toBe(57)
    const capped = (t: string) => Array.from(t).slice(0, model.charCap).join('')
    expect(passages.map((p) => encode(capped(p.text), model.vocab).length)).toEqual(ref.passage_tokens)
    expect(ref.passage_tokens.filter((n) => n > MAX_TOKENS).length).toBe(5)
  })
})

describe('vectors equal the int8 reference', () => {
  it('every passage vector within 1e-9 per component', () => {
    const worst = passages.reduce((m, p, i) => Math.max(m, maxDiff(embed(p.text, model), vec(ref.passages[i]))), 0)
    expect(worst).toBeLessThanOrEqual(1e-9)
  })
  it('every frozen query: vector within 1e-9, and the same top 5', () => {
    const pv = passages.map((p) => embed(p.text, model))
    expect(ref.queries.length).toBeGreaterThanOrEqual(40)
    for (const q of ref.queries) {
      const v = embed(q.q, model)
      expect(maxDiff(v, vec(q.v))).toBeLessThanOrEqual(1e-9)
      expect(rankByMeaning(v, pv).slice(0, 5).map((i) => passages[i].id)).toEqual(q.top5)
    }
  })
  it('the 57 passage vectors take a few milliseconds', () => {
    const t0 = performance.now()
    passages.map((p) => embed(p.text, model))
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe('int8 against fp32 model2vec (recorded by the reference)', () => {
  it('cosine of at least 0.999 on all 57 passages (measured minimum 0.99997), same token IDs', () => {
    expect(ref.fp32.tokens_agree).toBe(true)
    expect(ref.fp32.cosine.length).toBe(57)
    expect(ref.fp32.min_cosine).toBeGreaterThanOrEqual(0.999)
    expect(ref.fp32.min_cosine.toFixed(5)).toBe('0.99997')
  })
})

describe('why it ranked here', () => {
  it('lists query word pieces that pull toward the passage, strongest first', () => {
    const pv = passages.map((p) => embed(p.text, model))
    const ids = tokenIds('how much drinking water per day', model)
    const top = rankByMeaning(embed('how much drinking water per day', model), pv)[0]
    const why = strongestPieces(ids, pv[top], model)
    expect(why.length).toBeGreaterThan(0)
    for (const w of why) expect(model.vocab.ids.has(w)).toBe(true)
  })
})

describe('loading', () => {
  it('fetches the three files from this origin, checks them and builds the same model', async () => {
    const seen: string[] = []
    const fake = (async (url: string) => {
      seen.push(url)
      const name = url.split('/').pop()!
      return new Response(ab(file(name)), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }) as unknown as typeof fetch
    const m = await loadModel('/', fake)
    expect(seen.sort()).toEqual(Object.values(MODEL.files).map((f) => `/${MODEL.dir}${f.name}`).sort())
    expect(m.vocab.tokens.length).toBe(model.vocab.tokens.length)
    expect(maxDiff(embed('water', m), embed('water', model))).toBe(0)
  })
  it('refuses an HTML fallback or a wrong file', async () => {
    const html = (async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    await expect(loadModel('/', html)).rejects.toThrow(/not in this build/)
    const short = (async () => new Response(new Uint8Array(10), { status: 200 })) as unknown as typeof fetch
    await expect(loadModel('/', short)).rejects.toThrow(/bytes, expected/)
  })
})

// A stand-in for navigator.serviceWorker: no worker controls the page until takeControl().
function fakeWorker(controlled = false) {
  const listeners = new Set<() => void>()
  let settle!: () => void
  const sw = {
    controller: controlled ? ({} as unknown) : null,
    ready: new Promise<void>((r) => (settle = r)),
    addEventListener: (_type: 'controllerchange', l: () => void) => void listeners.add(l),
    removeEventListener: (_type: 'controllerchange', l: () => void) => void listeners.delete(l),
  }
  return {
    sw: sw as WorkerContainer,
    listeners,
    /** The worker activates: navigator.serviceWorker.ready settles, then clients.claim() fires controllerchange. */
    takeControl() {
      settle()
      sw.controller = {}
      for (const l of [...listeners]) l()
    },
  }
}

function fakeFetch() {
  const seen: string[] = []
  const impl = (async (url: string) => {
    seen.push(url)
    return new Response(ab(file(url.split('/').pop()!)), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  }) as unknown as typeof fetch
  return { seen, impl }
}
const FILES = Object.values(MODEL.files).map((f) => `/${MODEL.dir}${f.name}`).sort()

describe('the first search keeps the files for offline use, whichever comes first: the search or the worker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('waits at most about 3 s for a worker to control the page', () => {
    expect(CONTROL_WAIT_MS).toBe(3000)
  })
  it('does not wait where there is no worker, or where one already controls the page', async () => {
    await expect(whenControlled(null)).resolves.toBe(false)
    const w = fakeWorker(true)
    await expect(whenControlled(w.sw)).resolves.toBe(true)
    expect(w.listeners.size).toBe(0)
  })
  it('resolves true when the worker takes control within the wait, and stops listening', async () => {
    vi.useFakeTimers()
    const w = fakeWorker()
    const p = whenControlled(w.sw, 3000)
    await vi.advanceTimersByTimeAsync(1000)
    w.takeControl()
    await expect(p).resolves.toBe(true)
    expect(w.listeners.size).toBe(0)
  })
  it('resolves false after the wait if no worker took control, and stops listening', async () => {
    vi.useFakeTimers()
    const w = fakeWorker()
    let result: boolean | null = null
    void whenControlled(w.sw, 3000).then((v) => (result = v))
    await vi.advanceTimersByTimeAsync(2999)
    expect(result).toBe(null)
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe(false)
    expect(w.listeners.size).toBe(0)
  })
  it('worker first: the three files are fetched once, through the worker, and nothing more', async () => {
    const w = fakeWorker(true)
    const f = fakeFetch()
    const m = await loadModelKept(w.sw, '/', f.impl)
    expect(f.seen.sort()).toEqual(FILES)
    expect(w.listeners.size).toBe(0)
    expect(m.vocab.tokens.length).toBe(model.vocab.tokens.length)
  })
  it('worker during the wait: the fetch waits for it, so the files pass through it once', async () => {
    vi.useFakeTimers()
    const w = fakeWorker()
    const f = fakeFetch()
    const p = loadModelKept(w.sw, '/', f.impl, 3000)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.seen).toEqual([])
    w.takeControl()
    vi.useRealTimers()
    await p
    expect(f.seen.sort()).toEqual(FILES)
    expect(w.listeners.size).toBe(0)
  })
  it('search first: fetched anyway after the wait, then once more when the worker takes control, and only once', async () => {
    vi.useFakeTimers()
    const w = fakeWorker()
    const f = fakeFetch()
    const p = loadModelKept(w.sw, '/', f.impl, 3000)
    await vi.advanceTimersByTimeAsync(3000)
    vi.useRealTimers()
    await p
    expect(f.seen.sort()).toEqual(FILES)
    expect(w.listeners.size).toBe(1)
    w.takeControl()
    await vi.waitFor(() => expect(f.seen).toHaveLength(6))
    expect(f.seen.slice(3).sort()).toEqual(FILES)
    expect(w.listeners.size).toBe(0)
    w.takeControl()
    await new Promise((r) => setTimeout(r, 10))
    expect(f.seen).toHaveLength(6)
  })
  it('arms one refetch per worker, however many searches fail and retry before it takes control', async () => {
    const w = fakeWorker()
    const calls: number[] = []
    for (let i = 0; i < 3; i++) refetchWhenControlled(w.sw, async () => calls.push(i))
    expect(w.listeners.size).toBe(1)
    w.takeControl()
    await Promise.resolve()
    expect(calls).toEqual([0])
  })
})
