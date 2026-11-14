// Number and time formatting, port of engine/fmt.py. Every string the engine emits is built with
// integer arithmetic on IEEE-754 doubles (or BigInt, which is exact like Python ints), never with
// toFixed / String(x) on a fraction / Date, which round or print differently from Python.

import { EngineError } from './errors'
import { pyRepr } from './py'

export const FMT_MAX_ABS = 1e15 // beyond this, integer digits are no longer exact in a double
/** k = floor(|x| * 10^dp + 0.5) must stay below 2^53 so that `k % s` and `(k - fp) / s` are exact. */
export const FMT_MAX_SCALED = 9007199254740992 // 2^53
const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000] as const
const EPOCH_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/
const DAY_S = 86400
// |MET| beyond this cannot land in years 0001-9999 from any valid epoch; rejecting it up front
// keeps every later step exact in a double.
const MAX_ABS_MET = 1e14

/** True for a finite number. Booleans are not numbers (SPEC section 5). */
export function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

export function requireNumber(x: unknown, what: string): number {
  if (!isNumber(x)) throw new EngineError('invalid_argument', `${what} must be a finite number, got ${pyRepr(x)}`)
  return x
}

/** Plain left-to-right summation (Python's sum() of floats is compensated since 3.12; not used). */
export function sumLR(xs: readonly number[]): number {
  let acc = 0
  for (const x of xs) acc = acc + x
  return acc
}

/**
 * At most `dp` decimals, round half away from zero, no trailing zeros (port of fmt.fmt_num):
 *   k = floor(|x| * 10^dp + 0.5); fp = k mod 10^dp; ip = (k - fp) / 10^dp
 * e.g. 3 -> "3", 0.1 + 0.2 -> "0.3", -0.0004 -> "0", 600.0 -> "600".
 */
export function fmtNum(x: number, dp: number = 3): string {
  requireNumber(x, 'fmt_num value')
  if (Math.abs(x) >= FMT_MAX_ABS) throw new EngineError('invalid_argument', `fmt_num magnitude too large: ${pyRepr(x)}`)
  if (typeof dp !== 'number' || !Number.isInteger(dp) || dp < 0 || dp > 6) {
    throw new EngineError('invalid_argument', `fmt_num dp must be an int in 0..6, got ${pyRepr(dp)}`)
  }
  const scale = POW10[dp]
  if (Math.abs(x) * scale + 0.5 >= FMT_MAX_SCALED) {
    throw new EngineError('invalid_argument', `fmt_num: |x| * 10^dp must be < 2^53, got ${pyRepr(x)} at dp ${dp}`)
  }
  const k = Math.floor(Math.abs(x) * scale + 0.5)
  const fp = k % scale
  const ip = (k - fp) / scale
  let s = String(ip)
  if (fp !== 0) s += '.' + String(fp).padStart(dp, '0').replace(/0+$/, '')
  if (x < 0 && k !== 0) s = '-' + s
  return s
}

function pad(n: bigint | number, width: number): string {
  return n.toString().padStart(width, '0')
}

/**
 * MET as "d/hh:mm:ss", NASA-STD-3001 Vol 2 Appendix F F.6.1 f: "leading zeros are suppressed in day
 * field" (e.g. MET 57/14:08:33, MET 1089/13:03:01). Day 0 starts at MET 0; input is floored; the day
 * field is never truncated (10000/...); negative MET prints as "-d/...". The same format serves
 * day-count durations (a countdown prints "11/05:59:51"). BigInt keeps it exact for any finite input.
 */
export function formatMet(seconds: number): string {
  requireNumber(seconds, 'format_met seconds')
  const s = BigInt(Math.floor(seconds))
  const sign = s < 0n ? '-' : ''
  const a = s < 0n ? -s : s
  const days = a / 86400n
  let rem = a % 86400n
  const hh = rem / 3600n
  rem = rem % 3600n
  const mm = rem / 60n
  const ss = rem % 60n
  return `${sign}${days.toString()}/${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}`
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
}

// Proleptic Gregorian <-> days since 1970-01-01 (H. Hinnant's civil-date algorithms), integers only.
function daysFromCivil(year: number, m: number, d: number): number {
  const y = m <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = (m + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0)
  return [y, m, d]
}

/**
 * Parse a mission epoch; only "YYYY-MM-DDTHH:MM:SSZ" (no offsets, no fractions) is accepted, and it
 * must be a real date in years 0001-9999 (Python datetime's range). Returns POSIX seconds.
 */
export function parseEpoch(epoch: unknown): number {
  const m = typeof epoch === 'string' ? EPOCH_RE.exec(epoch) : null
  if (m === null) {
    throw new EngineError('invalid_argument', `mission_epoch must be 'YYYY-MM-DDTHH:MM:SSZ', got ${pyRepr(epoch)}`)
  }
  const [y, mo, d, hh, mi, ss] = m.slice(1).map(Number)
  const real = y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) && hh <= 23 && mi <= 59 && ss <= 59
  if (!real) throw new EngineError('invalid_argument', `mission_epoch is not a real date: ${pyRepr(epoch)}`)
  return daysFromCivil(y, mo, d) * DAY_S + hh * 3600 + mi * 60 + ss
}

/**
 * MET seconds -> UTC "YYYY-MM-DDTHH:MM:SSZ" (POSIX seconds, no leap seconds). MET must be integral.
 * Results outside years 0001-9999 raise invalid_argument (JS Date would print "+010000-...").
 */
export function metToIso(t: number, missionEpoch: string): string {
  requireNumber(t, 'MET')
  if (Math.floor(t) !== t) throw new EngineError('invalid_argument', `MET must be integer seconds, got ${pyRepr(t)}`)
  const base = parseEpoch(missionEpoch)
  const outOfRange = () => new EngineError('invalid_argument', `MET ${pyRepr(t)} is outside years 0001-9999 UTC`)
  if (Math.abs(t) > MAX_ABS_MET) throw outOfRange()
  const total = base + t
  const sod = ((total % DAY_S) + DAY_S) % DAY_S
  const [y, mo, d] = civilFromDays((total - sod) / DAY_S)
  if (y < 1 || y > 9999) throw outOfRange()
  const hh = Math.floor(sod / 3600)
  const mi = Math.floor((sod % 3600) / 60)
  const ss = sod % 60
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mi, 2)}:${pad(ss, 2)}Z`
}
