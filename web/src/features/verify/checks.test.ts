// #/verify's checks, run in node over the same files the page downloads: the vectors from engine/tests, the snapshots
// and manifest.json from web/public/data. The page must agree with the suite, and its "see it fail" copies must fail.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tCritical } from '../../app/engine'
import { API } from '../../engine/conformance'
import type { Vector } from '../../engine/conformance'
import { checkSnapshot, checkSnapshots, checkVector, flipOneByte, otherOrigins, parseManifest, recordedDocument, reportText, runVectors, sameValue, scaledApi } from './checks'
import type { Bytes, VectorFile } from './checks'
import { VECTOR_SOURCES } from './vectors'

const REPO = new URL('../../../../', import.meta.url)
const DIRS = ['engine/tests/vectors/', 'engine/tests/vectors_random/']
const DATA = new URL('web/public/data/', REPO)

// UTF-8 text re-encoded: the same bytes for these UTF-8 JSON files (a lossy round trip would fail the hash test).
const bytesOf = (url: URL): Bytes => new TextEncoder().encode(readFileSync(url, 'utf8'))
const FILES: VectorFile[] = DIRS.flatMap((dir) =>
  readdirSync(new URL(dir, REPO))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ path: dir + f, vectors: JSON.parse(readFileSync(new URL(dir + f, REPO), 'utf8')) as Vector[] })),
)
const COUNT = FILES.reduce((n, f) => n + f.vectors.length, 0)

describe('engine check (the conformance vectors, judged as the suite judges them)', () => {
  it('lists every vector file of engine/tests, in the suite order, as a URL', () => {
    expect(VECTOR_SOURCES.map((s) => s.path)).toEqual(FILES.map((f) => f.path))
    for (const s of VECTOR_SOURCES) expect(typeof s.url).toBe('string')
  })

  it('every vector agrees with the Python reference within 1e-9, and bit-for-bit outside t_cdf', async () => {
    let pauses = 0
    const r = await runVectors(FILES, { slice: 500, pause: async () => void pauses++ })
    expect(r.disagreements).toEqual([])
    expect(r.total).toBe(COUNT)
    expect(r.agree).toBe(COUNT)
    expect(r.files).toBe(FILES.length)
    expect(r.errors.total).toBeGreaterThan(0)
    expect(r.errors.same).toBe(r.errors.total)
    expect(r.bitExact.same).toBe(r.bitExact.total)
    expect(r.errors.total + r.bitExact.total + r.bitExactToleranceOnly.total).toBe(COUNT)
    expect(pauses).toBe(Math.ceil(COUNT / 500) - 1)
  })

  it('fails a vector whose answer, error code or arguments differ', () => {
    const ok: Vector = { name: 'n', fn: 's_level', args: { flux_pfu: 10 }, expect: 1 }
    expect(checkVector(ok).agrees).toBe(true)
    expect(checkVector({ ...ok, expect: 2 }).lines).toEqual(['$: expected 2, got 1'])
    expect(checkVector({ ...ok, raises: 'not_finite', expect: undefined }).agrees).toBe(false)
    expect(checkVector({ ...ok, fn: 'no_such_fn' }).agrees).toBe(false)
    // a malformed vector is a disagreement with its reason, never an aborted run
    expect(checkVector({ ...ok, args: null as unknown as Record<string, unknown> }).lines[0]).toMatch(/^the vector could not be replayed: TypeError/)
    const mutating = { ...API, s_level: { params: ['flux_pfu'], fn: (...a: unknown[]) => ((a[0] as { x?: number }).x = 1) } }
    expect(checkVector({ name: 'm', fn: 's_level', args: { flux_pfu: {} }, expect: 1 }, mutating).lines).toContain('the call changed its arguments (the engine functions are pure)')
  })

  it('compares arguments as vitest toEqual does', () => {
    expect(sameValue({ a: [1, Number.NaN], b: undefined }, { a: [1, Number.NaN] })).toBe(true)
    expect(sameValue({ a: 0 }, { a: -0 })).toBe(false)
    expect(sameValue([1], { 0: 1 })).toBe(false)
  })

  it('a copy of t_critical off by one part in a million fails, and the real engine is untouched', async () => {
    const file = FILES.find((f) => f.path === 'engine/tests/vectors/t_critical.json')!
    const r = await runVectors([file], { api: scaledApi('t_critical', 1e-6) })
    const expectations = file.vectors.filter((v) => v.raises === undefined).length
    expect(expectations).toBeGreaterThan(0)
    expect(r.total - r.agree).toBe(expectations)
    expect(r.errors.same).toBe(r.errors.total)
    expect(r.disagreements[0].lines[0]).toMatch(/^\$: expected \S+, got \S+$/)
    expect(API.t_critical.fn).toBe(tCritical)
    expect((await runVectors([file])).agree).toBe(file.vectors.length)
  })
})

describe('snapshot check (SHA-256 against manifest.json)', () => {
  const manifest = bytesOf(new URL('manifest.json', DATA))
  const read = async (f: string) => bytesOf(new URL(f, DATA))

  it('every snapshot in web/public/data matches its manifest row', async () => {
    const rows = parseManifest(manifest)
    const r = await checkSnapshots(manifest, read)
    expect(r.results.filter((x) => !x.match)).toEqual([])
    expect(r.total).toBe(rows.length)
    expect(r.match).toBe(rows.length)
    expect(r.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('one flipped bit in a copy is a mismatch, and the original bytes are unchanged', async () => {
    const row = parseManifest(manifest)[0]
    const bytes = await read(row.file)
    const before = bytes.slice()
    const { copy, offset } = flipOneByte(bytes)
    expect(copy[offset]).toBe(bytes[offset] ^ 1)
    expect((await checkSnapshot(row, copy)).match).toBe(false)
    expect(bytes).toEqual(before)
    expect((await checkSnapshot(row, bytes)).match).toBe(true)
  })

  it('reports a file that cannot be read as a mismatch, with the reason', async () => {
    const r = await checkSnapshots(manifest, async () => {
      throw new Error('offline')
    })
    expect(r.match).toBe(0)
    expect(r.results[0].error).toBe('offline')
  })
})

describe('other checks', () => {
  it('counts only requests to another origin', () => {
    const entries = [{ name: 'https://a.example/x.js' }, { name: 'https://b.example/y' }, { name: 'https://a.example/data/z.json' }]
    expect(otherOrigins(entries, 'https://a.example')).toEqual(['https://b.example/y'])
  })

  it("reads the SHA-256 of NASA's PDF that the standards snapshots record", () => {
    for (const id of ['std_vol1_requirements', 'std_vol2_requirements']) {
      const snap = JSON.parse(readFileSync(new URL(`${id}.json`, DATA), 'utf8')) as { data: { document: { sha256: string; bytes: number } } }
      const doc = recordedDocument(id, snap.data)
      expect(doc?.sha256).toBe(snap.data.document.sha256)
      expect(doc?.bytes).toBe(snap.data.document.bytes)
    }
    expect(recordedDocument('x', { document: {} })).toBeNull()
  })

  it('words the report and the page as agreement, never as correctness or validation', async () => {
    const r = await runVectors(FILES.slice(0, 1))
    const text = reportText({ when: 't', page: 'p', userAgent: 'ua', caches: ['landfall-x'], vectors: r, snapshots: null, digest: null, origins: { other: 0, recorded: 3 } })
    expect(text).toContain(`${r.agree} of ${r.total} vectors agree with the Python reference within 1e-9`)
    const page = readFileSync(new URL('index.tsx', import.meta.url), 'utf8')
    for (const s of [text, page]) expect(s).not.toMatch(/\b(correct|correctly|validated|validation|verified)\b/i)
    expect(page).toContain('#/method?s=limitations')
  })
})
