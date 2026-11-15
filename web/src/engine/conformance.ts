// The conformance harness, shared by the vitest suite (conformance.test.ts) and the browser page #/verify, so both
// replay the vectors with one comparator: every engine function of SPEC section 5 by its Python name, the decoding
// of {"$float": ...} arguments, the call, and the comparison (deep equality, numbers within 1e-9, relative above
// magnitude 1, strings exact). Pure: no file system, no DOM.

import {
  buildGroundPacket,
  caseReduce,
  chanceRate,
  commsEta,
  evaluatePersonal,
  evaluateRule,
  expectedFalseAlarms,
  fmtNum,
  formatMet,
  metToIso,
  minDetectableChange,
  newCase,
  rci,
  sLevel,
  tCdf,
  tCritical,
  tQuantile,
} from './index'
import { clone, isObj, setOwn } from './py'

export type AnyFn = (...args: unknown[]) => unknown

export interface ApiEntry {
  fn: AnyFn
  params: readonly string[]
}

// Python function name -> TS function and the SPEC section 5 parameter names, in positional order.
// A parameter absent from a vector's args is passed as undefined, so the TS default applies (the
// Python default is the same value).
export const API: Readonly<Record<string, ApiEntry>> = {
  evaluate_rule: { fn: evaluateRule as AnyFn, params: ['rule', 'value', 'env_id', 't', 'ctx'] },
  rci: { fn: rci as AnyFn, params: ['baseline', 'current', 'alpha', 'min_baseline_n'] },
  evaluate_personal: { fn: evaluatePersonal as AnyFn, params: ['indicator', 'baseline', 'current', 'cfg', 't'] },
  expected_false_alarms: { fn: expectedFalseAlarms as AnyFn, params: ['k_indicators', 'days', 'alpha', 'k_either'] },
  min_detectable_change: { fn: minDetectableChange as AnyFn, params: ['sd', 'n', 'alpha'] },
  chance_rate: { fn: chanceRate as AnyFn, params: ['indicator', 'cfg'] },
  t_cdf: { fn: tCdf as AnyFn, params: ['t', 'df'] },
  t_quantile: { fn: tQuantile as AnyFn, params: ['p', 'df'] },
  t_critical: { fn: tCritical as AnyFn, params: ['alpha', 'df'] },
  s_level: { fn: sLevel as AnyFn, params: ['flux_pfu'] },
  new_case: { fn: newCase as AnyFn, params: ['case_def', 'crew_id', 'lookup', 'env_id', 'escalation'] },
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

export interface Vector {
  name: string
  fn: string
  args: Record<string, unknown>
  expect?: unknown
  raises?: string
}

export const REL_TOL = 1e-9

export function close(a: number, b: number): boolean {
  return a === b || Math.abs(a - b) <= REL_TOL * Math.max(1, Math.abs(a), Math.abs(b))
}

export function show(x: unknown): string {
  return x === undefined ? 'undefined' : JSON.stringify(x)
}

/** Differences between a TS result and the Python expectation (empty = equal). */
export function diff(actual: unknown, expected: unknown, path: string, out: string[], exact: boolean): string[] {
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

// JSON has no NaN or infinity: an argument that must be non-finite is written {"$float": "NaN" |
// "Infinity" | "-Infinity"} and decoded, at any depth of args, before the call (SPEC section 6).
const NONFINITE: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity }

export function decodeArgs(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(decodeArgs)
  if (isObj(x)) {
    const keys = Object.keys(x)
    const tag = x.$float
    if (keys.length === 1 && typeof tag === 'string' && Object.hasOwn(NONFINITE, tag)) return NONFINITE[tag]
    const out: Record<string, unknown> = {}
    for (const k of keys) setOwn(out, k, decodeArgs(x[k]))
    return out
  }
  return x
}

/** A fresh decoded copy of a vector's args (what the call receives, and what it must leave intact). */
export function decodedArgs(vec: Vector): Record<string, unknown> {
  return decodeArgs(clone(vec.args)) as Record<string, unknown>
}

/** Calls the function a vector names (from `api`, the real engine by default) with the vector's decoded args. */
export function call(
  vec: Vector,
  api: Readonly<Record<string, ApiEntry>> = API,
): { result?: unknown; error?: unknown; args: Record<string, unknown> } {
  const entry = api[vec.fn]
  const args = decodedArgs(vec)
  const positional = entry.params.map((p) => (Object.hasOwn(args, p) ? args[p] : undefined))
  try {
    return { result: entry.fn(...positional), args }
  } catch (error) {
    return { error, args }
  }
}

// t_cdf goes through Math.log and Math.exp (also inside lgamma), which can differ from the C
// library's log and exp in the last bit, so SPEC section 5 holds it to the 1e-9 tolerance only
// (on this machine about 1 t_cdf vector in 20 differs in its last digits). The bisection behind
// t_quantile and t_critical takes exactly 32 halvings, each decided far above that noise for the
// df of these frozen vectors, so they, and every rci / evaluate_personal value built on the
// critical value, are identical to the Python double here. That is a property of these inputs,
// not a guarantee at very large df (README "Student's t"; SPEC section 6 allows 1e-8 above df 1e5).
export const TOLERANCE_ONLY: ReadonlySet<string> = new Set(['t_cdf'])
