// Earth link ETA: one-way light time, round trip and solar-conjunction blocking. Port of
// engine/comms.py (SPEC section 5).
//
// comms_table is MET-based (the runtime converts snapshot UTC times to MET with the mission epoch):
//   {samples: [{t, one_way_s}], conjunction_windows: [{start, end, reason}]}
// Windows are half-open [start, end). Overlapping or touching windows chain: resumes_at is the end
// of the chain. Light time is linearly interpolated between samples and clamped at the ends.

import { EngineError } from './errors'
import { isNumber, requireNumber } from './fmt'
import { has, isObj, pyGet, pyOr } from './py'
import type { JsonObject } from './py'
import type { CommsEta, CommsTable, Environment } from './types'

function asList(x: unknown, what: string): unknown[] {
  // Python iterates `x or []`: a falsy value is an empty list; a truthy non-list is not a table
  const v = pyOr(x, [])
  if (!Array.isArray(v)) throw new EngineError('invalid_argument', `${what} must be a list`)
  return v
}

function oneWayFromTable(samples: unknown[], t: number): number {
  const pts: Array<[number, number]> = []
  for (const p of samples) {
    if (!(isObj(p) && isNumber(pyGet(p, 't')) && isNumber(pyGet(p, 'one_way_s')))) {
      throw new EngineError('invalid_argument', 'comms_table.samples entries need numeric t and one_way_s')
    }
    pts.push([p.t as number, p.one_way_s as number])
  }
  if (pts.length === 0) throw new EngineError('missing_comms_table', 'comms_table.samples is empty')
  pts.sort((a, b) => a[0] - b[0])
  if (t <= pts[0][0]) return pts[0][1]
  if (t >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, a] = pts[i]
    const [t1, b] = pts[i + 1]
    if (t0 <= t && t < t1) return a + ((b - a) * (t - t0)) / (t1 - t0)
  }
  return pts[pts.length - 1][1] // unreachable with sorted samples
}

/**
 * {one_way_s, round_trip_s, blocked, reason, resumes_at, earliest_reply_s, light_time_source}.
 * One-way light time comes from commsTable when the environment says {from_snapshot: ...}, else it
 * is the environment's max (the conservative end of its min..max range). blocked: the environment
 * has conjunction true and t is inside a conjunction window. earliest_reply_s assumes zero ground
 * time: the round trip now, or (resumes_at - t) + the round trip at resumes_at when blocked.
 */
export function commsEta(env: Environment, t: number, commsTable: CommsTable | null = null): CommsEta {
  if (!isObj(env) || !isObj(pyGet(env, 'comms'))) {
    throw new EngineError('invalid_argument', 'env must be an environment object with comms')
  }
  requireNumber(t, 't')
  const comms = env.comms as JsonObject
  const olt = pyGet(comms, 'one_way_light_time_s')
  if (!isObj(olt)) throw new EngineError('invalid_argument', 'env.comms.one_way_light_time_s must be an object')
  const table = commsTable === undefined ? null : commsTable
  if (table !== null && !isObj(table)) throw new EngineError('invalid_argument', 'comms_table must be an object or null')
  const usesTable = has(olt, 'from_snapshot')
  let oneWayAt: (x: number) => number
  if (usesTable) {
    if (table === null) {
      throw new EngineError('missing_comms_table', `environment ${String(pyGet(env, 'id'))} needs a light-time table`)
    }
    oneWayAt = (x) => oneWayFromTable(asList(pyGet(table, 'samples'), 'comms_table.samples'), x)
  } else {
    const fixed = pyGet(olt, 'max')
    if (!isNumber(fixed)) throw new EngineError('invalid_argument', 'env.comms.one_way_light_time_s.max must be a number')
    oneWayAt = () => fixed
  }

  const oneWay = oneWayAt(t)
  let blocked = false
  let reason: CommsEta['reason'] = null
  let resumesAt: number | null = null
  if (pyGet(comms, 'conjunction') === true && table !== null) {
    const wins: Array<{ start: number; end: number }> = []
    for (const w of asList(pyGet(table, 'conjunction_windows'), 'comms_table.conjunction_windows')) {
      if (!(isObj(w) && isNumber(pyGet(w, 'start')) && isNumber(pyGet(w, 'end')))) {
        throw new EngineError('invalid_argument', 'conjunction windows need numeric start and end')
      }
      const start = w.start as number
      const end = w.end as number
      if (end > start) wins.push({ start, end })
    }
    wins.sort((a, b) => a.start - b.start || a.end - b.end)
    const hit = wins.find((w) => w.start <= t && t < w.end)
    if (hit !== undefined) {
      blocked = true
      reason = 'solar_conjunction'
      let end = hit.end
      for (const w of wins) {
        // chain overlapping / touching windows (one pass in start order, as in Python)
        if (w.start <= end && end < w.end) end = w.end
      }
      resumesAt = end
    }
  }
  const roundTrip = 2 * oneWay
  const earliest = blocked && resumesAt !== null ? resumesAt - t + 2 * oneWayAt(resumesAt) : roundTrip
  return {
    one_way_s: oneWay,
    round_trip_s: roundTrip,
    blocked,
    reason,
    resumes_at: resumesAt,
    earliest_reply_s: earliest,
    light_time_source: usesTable ? 'table' : 'environment_max',
  }
}
