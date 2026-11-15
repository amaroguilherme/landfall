// Conformance: replay EVERY vector in engine/tests/vectors/*.json (SPEC section 6) through the
// TypeScript port and require the Python reference engine's answer: deep equality, numbers within
// 1e-9 (relative above magnitude 1), strings exact, and `raises` matching the error code. A second
// check requires bit-for-bit equality everywhere except t_cdf (see TOLERANCE_ONLY). The harness (API map, decoding,
// call, comparator) lives in conformance.ts, which the in-browser page #/verify runs too.

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EngineError } from './index'
import { API, TOLERANCE_ONLY, call, decodedArgs, diff, show } from './conformance'
import type { Vector } from './conformance'

const VECTORS_DIR = new URL('../../../engine/tests/vectors/', import.meta.url)
// Seeded randomized vectors (random_<fn>.json), also produced by the Python reference engine during
// the adversarial verification of this port. They live outside vectors/ because
// `python -m engine.vectors --check` reports any extra file there as "not generated". Optional:
// when the directory is absent only the generated vectors run.
const RANDOM_DIR = new URL('../../../engine/tests/vectors_random/', import.meta.url)
const RANDOM_PREFIX = 'random/'

function jsonFiles(dir: URL, optional: boolean): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (optional) return []
    throw error
  }
  return names.filter((f) => f.endsWith('.json')).sort()
}

function loadVectors(dir: URL, file: string): Vector[] {
  return JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Vector[]
}

/** The generated files, named <fn>.json. */
const FILES = jsonFiles(VECTORS_DIR, false)
/** The randomized files, named random_<fn>.json. */
const RANDOM_FILES = jsonFiles(RANDOM_DIR, true)
const VECTORS: Record<string, Vector[]> = Object.fromEntries([
  ...FILES.map((f) => [f, loadVectors(VECTORS_DIR, f)] as const),
  ...RANDOM_FILES.map((f) => [RANDOM_PREFIX + f, loadVectors(RANDOM_DIR, f)] as const),
])
/** Every vector file, generated first; randomized ones carry the 'random/' prefix. */
const ALL_FILES = Object.keys(VECTORS)

/** Function name a vector file is for: '<fn>.json' or 'random/random_<fn>.json'. */
function fnOfFile(file: string): string {
  const base = file.startsWith(RANDOM_PREFIX) ? file.slice(RANDOM_PREFIX.length).replace(/^random_/, '') : file
  return base.replace(/\.json$/, '')
}

describe('conformance vector files', () => {
  it('finds the vector files, each named after a mapped function', () => {
    expect(FILES.length).toBeGreaterThan(0)
    for (const f of ALL_FILES) {
      const fn = fnOfFile(f)
      expect(API, `no TS mapping for ${f}`).toHaveProperty(fn)
      expect(VECTORS[f].length, `${f} is empty`).toBeGreaterThan(0)
      for (const v of VECTORS[f]) {
        expect(v.fn, `${f}:${v.name}`).toBe(fn)
        expect(Object.keys(v.args).filter((k) => !API[fn].params.includes(k)), `${f}:${v.name} unknown args`).toEqual([])
        expect('expect' in v !== 'raises' in v, `${f}:${v.name} needs exactly one of expect / raises`).toBe(true)
      }
    }
  })

  it('covers every function of SPEC section 5', () => {
    expect(FILES.map(fnOfFile).sort()).toEqual(Object.keys(API).sort())
  })

  it('has randomized vectors for every function when vectors_random/ is present', () => {
    if (RANDOM_FILES.length === 0) return
    expect(RANDOM_FILES.map((f) => fnOfFile(RANDOM_PREFIX + f)).sort()).toEqual(Object.keys(API).sort())
  })
})

for (const file of ALL_FILES) {
  describe(file.startsWith(RANDOM_PREFIX) ? `vectors_${file}` : `vectors/${file}`, () => {
    it.each(VECTORS[file].map((v) => [v.name, v] as const))('%s', (_name, vec) => {
      const { result, error, args } = call(vec)
      if (vec.raises !== undefined) {
        expect(error, `expected EngineError ${vec.raises}, got ${show(result)}`).toBeInstanceOf(EngineError)
        expect((error as EngineError).code).toBe(vec.raises)
      } else {
        if (error !== undefined) throw error
        expect(diff(result, vec.expect, '$', [], false)).toEqual([])
      }
      // pure functions: the (decoded) arguments are not mutated
      expect(args).toEqual(decodedArgs(vec))
    })
  })
}

describe('bit-for-bit parity (stronger than the 1e-9 tolerance)', () => {
  it('every number in every expected result is identical to the Python double (t_cdf: tolerance only)', () => {
    const mismatches: string[] = []
    for (const file of ALL_FILES) {
      for (const vec of VECTORS[file]) {
        if (vec.raises !== undefined || TOLERANCE_ONLY.has(vec.fn)) continue
        const { result } = call(vec)
        for (const d of diff(result, vec.expect, `${file}:${vec.name}`, [], true)) mismatches.push(d)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('is deterministic: a second run gives the same answer', () => {
    for (const file of ALL_FILES) {
      for (const vec of VECTORS[file]) {
        const a = call(vec)
        const b = call(vec)
        expect(JSON.stringify(b.result), `${file}:${vec.name}`).toBe(JSON.stringify(a.result))
      }
    }
  })
})
