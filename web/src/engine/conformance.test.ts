// Conformance: replay EVERY vector in engine/tests/vectors/*.json (SPEC section 6) through the
// TypeScript port and require the Python reference engine's answer: deep equality, numbers within
// 1e-9 (relative above magnitude 1), strings exact, and `raises` matching the error code.

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EngineError,
  buildGroundPacket,
  caseReduce,
  commsEta,
  evaluatePersonal,
  evaluateRule,
  expectedFalseAlarms,
  fmtNum,
  formatMet,
  metToIso,
  newCase,
  rci,
  sLevel,
} from './index'
import { clone } from './py'

type AnyFn = (...args: unknown[]) => unknown

// Python function name -> TS function and the SPEC section 5 parameter names, in positional order.
// A parameter absent from a vector's args is passed as undefined, so the TS default applies (the
// Python default is the same value).
const API: Record<string, { fn: AnyFn; params: readonly string[] }> = {
  evaluate_rule: { fn: evaluateRule as AnyFn, params: ['rule', 'value', 'env_id', 't', 'ctx'] },
  rci: { fn: rci as AnyFn, params: ['baseline', 'current', 'r', 'critical_z', 'min_baseline_n'] },
  evaluate_personal: { fn: evaluatePersonal as AnyFn, params: ['indicator', 'baseline', 'current', 'cfg', 't'] },
  expected_false_alarms: { fn: expectedFalseAlarms as AnyFn, params: ['k_indicators', 'days', 'alpha'] },
  s_level: { fn: sLevel as AnyFn, params: ['flux_pfu'] },
  new_case: { fn: newCase as AnyFn, params: ['case_def', 'crew_id', 'lookup'] },
  case_reduce: { fn: caseReduce as AnyFn, params: ['state', 'event'] },
  build_ground_packet: {
    fn: buildGroundPacket as AnyFn,
    params: ['case_state', 'observations', 'consent', 'env_id', 't', 'mission_epoch'],
  },
  comms_eta: { fn: commsEta as AnyFn, params: ['env', 't', 'comms_table'] },
  format_met: { fn: formatMet as AnyFn, params: ['seconds'] },
  fmt_num: { fn: fmtNum as AnyFn, params: ['x', 'dp'] },
  met_to_iso: { fn: metToIso as AnyFn, params: ['t', 'mission_epoch'] },
}

interface Vector {
  name: string
  fn: string
  args: Record<string, unknown>
  expect?: unknown
  raises?: string
}

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

const REL_TOL = 1e-9

function close(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= REL_TOL * Math.max(1, Math.abs(a), Math.abs(b))
}

function show(x: unknown): string {
  return x === undefined ? 'undefined' : JSON.stringify(x)
}

/** Differences between a TS result and the Python expectation (empty = equal). */
function diff(actual: unknown, expected: unknown, path: string, out: string[], exact: boolean): string[] {
  if (typeof expected === 'number') {
    const ok = typeof actual === 'number' && (exact ? actual === expected : close(actual, expected))
    if (!ok) out.push(`${path}: expected ${expected}, got ${show(actual)}`)
  } else if (expected === null || typeof expected !== 'object') {
    if (actual !== expected) out.push(`${path}: expected ${show(expected)}, got ${show(actual)}`)
  } else if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) out.push(`${path}: expected an array, got ${show(actual)}`)
    else if (actual.length !== expected.length) out.push(`${path}: expected length ${expected.length}, got ${actual.length}`)
    else expected.forEach((e, i) => diff(actual[i], e, `${path}[${i}]`, out, exact))
  } else if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    out.push(`${path}: expected an object, got ${show(actual)}`)
  } else {
    const exp = expected as Record<string, unknown>
    const act = actual as Record<string, unknown>
    for (const k of Object.keys(act)) {
      if (act[k] === undefined) out.push(`${path}.${k}: undefined (not JSON)`)
      else if (!Object.hasOwn(exp, k)) out.push(`${path}.${k}: unexpected key`)
    }
    for (const k of Object.keys(exp)) {
      if (!Object.hasOwn(act, k)) out.push(`${path}.${k}: missing`)
      else diff(act[k], exp[k], `${path}.${k}`, out, exact)
    }
  }
  return out
}

function call(vec: Vector): { result?: unknown; error?: unknown; args: Record<string, unknown> } {
  const api = API[vec.fn]
  const args = clone(vec.args)
  const positional = api.params.map((p) => (Object.hasOwn(args, p) ? args[p] : undefined))
  try {
    return { result: api.fn(...positional), args }
  } catch (error) {
    return { error, args }
  }
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
      // pure functions: the arguments are not mutated
      expect(args).toEqual(vec.args)
    })
  })
}

describe('bit-for-bit parity (stronger than the 1e-9 tolerance)', () => {
  it('every number in every expected result is identical to the Python double', () => {
    const mismatches: string[] = []
    for (const file of ALL_FILES) {
      for (const vec of VECTORS[file]) {
        if (vec.raises !== undefined) continue
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
