// Python-semantics helpers. The reference engine is Python; these reproduce the handful of Python
// behaviours the engine relies on, so that the TypeScript port gives the same answer for the same
// JSON input (SPEC section 5, "Determinism rules for the port").
//
//   dict.get(k)        -> pyGet (absent or undefined -> null, i.e. Python None)
//   `k in dict`        -> has
//   truthiness, `or`   -> truthy, pyOr ([] and {} are falsy in Python, truthy in JS)
//   ==, `in` on lists  -> pyEq, pyIn (structural; True == 1 like Python)
//   str(x), repr(x)    -> pyStr, pyRepr (used inside `why` / `detail` strings, which must match)
//   sorted(strs)       -> cmpCodePoints (Python orders str by code point, JS by UTF-16 unit)
//   copy.deepcopy      -> clone (JSON values only)

export type JsonObject = { [key: string]: unknown }

/** isinstance(x, dict) for JSON values: a non-null, non-array object. */
export function isObj(x: unknown): x is JsonObject {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** `key in d`. A key whose value is undefined counts as absent (JSON never has undefined). */
export function has(d: JsonObject, key: string): boolean {
  return Object.hasOwn(d, key) && d[key] !== undefined
}

/** d.get(key): the value, or null (Python None) when the key is absent. */
export function pyGet(d: JsonObject, key: string): unknown {
  return has(d, key) ? d[key] : null
}

/** isinstance(x, int) and not bool, for a JSON number (JS cannot tell 3 from 3.0). */
export function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x)
}

/** Python truthiness of a JSON value. */
export function truthy(x: unknown): boolean {
  if (x === null || x === undefined) return false
  if (typeof x === 'boolean') return x
  if (typeof x === 'number') return x !== 0 // NaN is truthy in Python too
  if (typeof x === 'string') return x.length > 0
  if (Array.isArray(x)) return x.length > 0
  if (typeof x === 'object') return Object.keys(x).length > 0
  return true
}

/** Python `a or b or c`: the first truthy operand, else the last one. */
export function pyOr(...xs: unknown[]): unknown {
  for (let i = 0; i < xs.length - 1; i++) if (truthy(xs[i])) return xs[i]
  return xs.length ? (xs[xs.length - 1] ?? null) : null
}

/** Python `a == b` for JSON values (structural; bool compares as 0/1 with numbers). */
export function pyEq(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a
  const y = b === undefined ? null : b
  if (typeof x === 'boolean' && typeof y === 'number') return (x ? 1 : 0) === y
  if (typeof x === 'number' && typeof y === 'boolean') return x === (y ? 1 : 0)
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!pyEq(x[i], y[i])) return false
    return true
  }
  if (isObj(x) || isObj(y)) {
    if (!isObj(x) || !isObj(y)) return false
    const kx = Object.keys(x).filter((k) => has(x, k))
    const ky = Object.keys(y).filter((k) => has(y, k))
    if (kx.length !== ky.length) return false
    for (const k of kx) if (!has(y, k) || !pyEq(x[k], y[k])) return false
    return true
  }
  return x === y
}

/** Python `x in seq` for a list/tuple of JSON values. */
export function pyIn(x: unknown, seq: readonly unknown[]): boolean {
  for (const y of seq) if (pyEq(x, y)) return true
  return false
}

/** Compare strings by code point, like Python's str ordering. */
export function cmpCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ca = a.codePointAt(i) as number
    const cb = b.codePointAt(i) as number
    if (ca !== cb) return ca < cb ? -1 : 1
    if (ca > 0xffff) i++ // same astral code point in both: skip its low surrogate
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/** sorted(strs) by code point. Does not mutate its input. */
export function sortedStrings(xs: Iterable<string>): string[] {
  return [...xs].sort(cmpCodePoints)
}

/** copy.deepcopy for JSON values. Keys are copied as own properties (safe for "__proto__"). */
export function clone<T>(x: T): T {
  if (Array.isArray(x)) return x.map((e) => clone(e)) as T
  if (isObj(x)) {
    const out: JsonObject = {}
    for (const k of Object.keys(x)) setOwn(out, k, clone(x[k]))
    return out as T
  }
  return x
}

/** out[key] = value as an own data property, even for "__proto__". */
export function setOwn(out: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true })
}

/** str(int(x)) for a finite number: truncates toward zero, prints every digit (no exponent). */
export function pyIntStr(x: number): string {
  return BigInt(Math.trunc(x)).toString()
}

/** str(x) of a JSON value, as an f-string `{x}` would print it. */
export function pyStr(x: unknown): string {
  return typeof x === 'string' ? x : pyRepr(x)
}

/** repr(x) of a JSON value, as an f-string `{x!r}` would print it. */
export function pyRepr(x: unknown): string {
  if (x === null || x === undefined) return 'None'
  if (x === true) return 'True'
  if (x === false) return 'False'
  if (typeof x === 'number') return pyNumRepr(x)
  if (typeof x === 'string') return pyStrRepr(x)
  if (Array.isArray(x)) return '[' + x.map(pyRepr).join(', ') + ']'
  if (isObj(x)) {
    return '{' + Object.keys(x).filter((k) => has(x, k)).map((k) => `${pyStrRepr(k)}: ${pyRepr(x[k])}`).join(', ') + '}'
  }
  return String(x)
}

// Integral numbers print as Python ints (a JSON 5.0 parses to the same JS number as 5, so a Python
// float that happens to be integral prints "5.0" in Python and "5" here; see README). Negative zero
// is the exception: no Python int is -0, and Python's json writes float -0.0 as "-0.0", so a JS -0
// can only have been a Python float, whose repr is "-0.0".
function pyNumRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  if (Object.is(x, -0)) return '-0.0'
  if (Number.isInteger(x) && Math.abs(x) < 2 ** 53) return String(x)
  return pyFloatRepr(x)
}

// Python float repr: the shortest round-trip digits (same digits as JS toExponential()), printed in
// scientific notation when the decimal exponent is < -4 or >= 16, with at least 2 exponent digits.
function pyFloatRepr(x: number): string {
  const [mant, expStr] = x.toExponential().split('e')
  const exp = Number(expStr)
  const neg = mant.startsWith('-')
  const digits = mant.replace('-', '').replace('.', '')
  let body: string
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    body = `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  } else if (exp >= 0) {
    const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, '0')
    const frac = digits.slice(exp + 1)
    body = `${intPart}.${frac || '0'}`
  } else {
    body = `0.${'0'.repeat(-exp - 1)}${digits}`
  }
  return (neg ? '-' : '') + body
}

// Python str.isprintable(): "Other" (Cc Cf Cs Co Cn) and "Separator" (Zl Zp Zs) are not printable,
// except the ASCII space.
const NON_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u

function hex(cp: number, width: number): string {
  return cp.toString(16).padStart(width, '0')
}

function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = quote
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (ch === quote || ch === '\\') out += '\\' + ch
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + hex(cp, 2)
    else if (cp < 0x7f) out += ch
    else if (NON_PRINTABLE.test(ch)) {
      out += cp <= 0xff ? '\\x' + hex(cp, 2) : cp <= 0xffff ? '\\u' + hex(cp, 4) : '\\U' + hex(cp, 8)
    } else out += ch
  }
  return out + quote
}

// Python str.strip() whitespace (str.isspace): differs from JS trim() on U+001C..U+001F and U+0085
// (Python strips them) and U+FEFF (JS strips it).
// eslint-disable-next-line no-control-regex -- Python's whitespace set includes U+001C..U+001F
const PY_BLANK = /^[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/

/** isinstance(x, str) and x.strip() != "" */
export function isNonemptyStr(x: unknown): x is string {
  return typeof x === 'string' && !PY_BLANK.test(x)
}
