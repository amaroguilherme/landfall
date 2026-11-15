// The checks #/verify runs, as pure functions (no DOM, no fetch): the browser page feeds them what it downloads and
// checks.test.ts feeds them the same files from disk.
//   runVectors       every conformance vector through the TypeScript engine, judged exactly as the vitest suite
//                    judges it (src/engine/conformance.ts: the call, the comparator, the 1e-9 tolerance)
//   checkSnapshots   the SHA-256 and size of every /data snapshot against manifest.json
//   otherOrigins     resource-timing entries whose origin is not this page's
//   tampered*        the same checks on deliberately altered copies, so a judge can see them fail
import { API, REL_TOL, TOLERANCE_ONLY, call, decodedArgs, diff, show } from '../../engine/conformance'
import type { ApiEntry, Vector } from '../../engine/conformance'
import { EngineError } from '../../app/engine'

export type Api = Readonly<Record<string, ApiEntry>>
/** File contents as fetch or the File API hands them over. */
export type Bytes = Uint8Array<ArrayBuffer>

export interface VectorFile {
  /** Repo path, e.g. engine/tests/vectors/rci.json. */
  path: string
  vectors: Vector[]
}

// ---- engine: the conformance vectors ------------------------------------------------------------------------------

/** vitest's toEqual for the "arguments are not mutated" check: Object.is on scalars, keys holding undefined ignored. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(rb, k) && sameValue(ra[k], rb[k]))
}

function describeError(e: unknown): string {
  if (e instanceof EngineError) return `EngineError ${e.code}`
  return e instanceof Error ? `${e.name}: ${e.message}` : show(e)
}

export interface VectorVerdict {
  /** The suite's criterion: the Python answer within 1e-9, or the same error code, and the arguments left intact. */
  agrees: boolean
  /** Why not, one line per difference (both values in each line). */
  lines: string[]
  /** Every number identical to the Python double; null for an expected error. */
  bitExact: boolean | null
}

/** One vector, judged as conformance.test.ts judges it. A vector that cannot be replayed at all is a disagreement too. */
export function checkVector(vec: Vector, api: Api = API): VectorVerdict {
  try {
    return judge(vec, api)
  } catch (e) {
    return { agrees: false, lines: [`the vector could not be replayed: ${describeError(e)}`], bitExact: null }
  }
}

function judge(vec: Vector, api: Api): VectorVerdict {
  if (!Object.hasOwn(api, vec.fn)) return { agrees: false, lines: [`no TypeScript function for ${show(vec.fn)}`], bitExact: null }
  const { result, error, args } = call(vec, api)
  const lines: string[] = []
  let bitExact: boolean | null = null
  if (vec.raises !== undefined) {
    if (!(error instanceof EngineError) || error.code !== vec.raises) {
      lines.push(`expected EngineError ${vec.raises}, got ${error !== undefined ? describeError(error) : show(result)}`)
    }
  } else if (error !== undefined) {
    lines.push(`expected ${show(vec.expect)}, got ${describeError(error)}`)
  } else {
    lines.push(...diff(result, vec.expect, '$', [], false))
    bitExact = diff(result, vec.expect, '$', [], true).length === 0
  }
  if (!sameValue(args, decodedArgs(vec))) lines.push('the call changed its arguments (the engine functions are pure)')
  return { agrees: lines.length === 0, lines, bitExact }
}

export interface Disagreement {
  path: string
  /** 0-based position in the file. */
  index: number
  name: string
  lines: string[]
}

export interface Tally {
  total: number
  same: number
}

export interface VectorReport {
  files: number
  total: number
  agree: number
  /** Every vector that does not agree. */
  disagreements: Disagreement[]
  /** Vectors whose expected answer is an error. */
  errors: Tally
  /** Bit-for-bit, as the suite's second block counts it (every result except t_cdf). */
  bitExact: Tally
  /** Bit-for-bit for the tolerance-only functions (t_cdf), shown as information. */
  bitExactToleranceOnly: Tally
  /** Time spent in the engine and the comparison, without the pauses between slices. */
  ms: number
}

export interface RunOptions {
  api?: Api
  /** Vectors per slice; the page yields to the browser between slices. */
  slice?: number
  onProgress?: (done: number, total: number) => void
  now?: () => number
  pause?: () => Promise<void>
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Replays every vector of every file, in slices, and counts what agrees. */
export async function runVectors(files: readonly VectorFile[], opts: RunOptions = {}): Promise<VectorReport> {
  const { api = API, slice = 250, onProgress, now = () => performance.now(), pause = nextTask } = opts
  const total = files.reduce((n, f) => n + f.vectors.length, 0)
  const report: VectorReport = {
    files: files.length,
    total,
    agree: 0,
    disagreements: [],
    errors: { total: 0, same: 0 },
    bitExact: { total: 0, same: 0 },
    bitExactToleranceOnly: { total: 0, same: 0 },
    ms: 0,
  }
  let done = 0
  let t0 = now()
  for (const file of files) {
    for (let index = 0; index < file.vectors.length; index++) {
      const vec = file.vectors[index] ?? ({} as Vector)
      const v = checkVector(vec, api)
      if (v.agrees) report.agree++
      else report.disagreements.push({ path: file.path, index, name: String(vec.name), lines: v.lines })
      if (vec.raises !== undefined) {
        report.errors.total++
        if (v.agrees) report.errors.same++
      } else {
        const tally = TOLERANCE_ONLY.has(String(vec.fn)) ? report.bitExactToleranceOnly : report.bitExact
        tally.total++
        if (v.bitExact) tally.same++
      }
      done++
      if (done % slice === 0 && done < total) {
        report.ms += now() - t0
        onProgress?.(done, total)
        await pause()
        t0 = now()
      }
    }
  }
  report.ms += now() - t0
  onProgress?.(done, total)
  return report
}

/** A copy of the engine map in which one function's answer is multiplied by (1 + factor): the "see it fail" demo. */
export function scaledApi(fn: string, factor: number, api: Api = API): Api {
  const real = api[fn]
  if (!real) throw new Error(`no engine function ${fn}`)
  return { ...api, [fn]: { params: real.params, fn: (...args: unknown[]) => (real.fn(...args) as number) * (1 + factor) } }
}

// ---- snapshots: SHA-256 against manifest.json ---------------------------------------------------------------------

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle
  if (!subtle) throw new Error('this browser has no Web Crypto here (it needs a secure context: https or localhost)')
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes))
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ManifestRow {
  id: string
  file: string
  bytes: number
  sha256: string
}

/** The snapshot list of a landfall.manifest/1 file (its raw bytes). */
export function parseManifest(bytes: Bytes): ManifestRow[] {
  const m = JSON.parse(new TextDecoder().decode(bytes)) as { schema?: unknown; snapshots?: unknown }
  if (m.schema !== 'landfall.manifest/1' || !Array.isArray(m.snapshots)) throw new Error('manifest.json is not a landfall.manifest/1 file')
  return (m.snapshots as ManifestRow[]).map((s) => ({ id: s.id, file: s.file || `${s.id}.json`, bytes: s.bytes, sha256: s.sha256 }))
}

export interface SnapshotResult {
  id: string
  file: string
  expectedSha256: string
  sha256: string | null
  expectedBytes: number
  bytes: number | null
  match: boolean
  /** Why the file could not be read. */
  error: string | null
}

export interface SnapshotReport {
  manifestSha256: string
  total: number
  match: number
  results: SnapshotResult[]
}

/** Hashes one file and compares it with its manifest row. */
export async function checkSnapshot(row: ManifestRow, bytes: Bytes): Promise<SnapshotResult> {
  const sha256 = await sha256Hex(bytes)
  return {
    id: row.id,
    file: row.file,
    expectedSha256: row.sha256,
    sha256,
    expectedBytes: row.bytes,
    bytes: bytes.byteLength,
    match: sha256 === row.sha256 && bytes.byteLength === row.bytes,
    error: null,
  }
}

/** Every snapshot manifest.json lists, read through `read` (the page: fetch /data/<file>), against its row. */
export async function checkSnapshots(
  manifestBytes: Bytes,
  read: (file: string) => Promise<Bytes>,
  onProgress?: (done: number, total: number) => void,
): Promise<SnapshotReport> {
  const rows = parseManifest(manifestBytes)
  const results: SnapshotResult[] = []
  for (const row of rows) {
    try {
      results.push(await checkSnapshot(row, await read(row.file)))
    } catch (e) {
      results.push({
        id: row.id,
        file: row.file,
        expectedSha256: row.sha256,
        sha256: null,
        expectedBytes: row.bytes,
        bytes: null,
        match: false,
        error: (e as Error).message,
      })
    }
    onProgress?.(results.length, rows.length)
  }
  return {
    manifestSha256: await sha256Hex(manifestBytes),
    total: rows.length,
    match: results.filter((r) => r.match).length,
    results,
  }
}

/** A copy of `bytes` with the lowest bit of one byte flipped at `offset` (the middle by default); the original is untouched. */
export function flipOneByte(bytes: Bytes, offset = Math.floor(bytes.byteLength / 2)): { copy: Bytes; offset: number } {
  const copy = new Uint8Array(bytes)
  copy[offset] ^= 0x01
  return { copy, offset }
}

// ---- requests to other origins --------------------------------------------------------------------------------------

/** URLs of resource-timing entries from an origin other than `origin`. */
export function otherOrigins(entries: readonly { name: string }[], origin: string): string[] {
  return entries
    .map((e) => e.name)
    .filter((name) => {
      try {
        return new URL(name).origin !== origin
      } catch {
        return true
      }
    })
}

// ---- NASA's PDF, dropped by the judge ----------------------------------------------------------------------------

export interface RecordedDocument {
  /** Snapshot id, e.g. std_vol2_requirements. */
  snapshot: string
  title: string
  revision: string | null
  sha256: string
  bytes: number | null
  url: string | null
}

/** The document a standards snapshot records: data.document {title, revision, sha256, bytes, url}. */
export function recordedDocument(snapshot: string, data: unknown): RecordedDocument | null {
  const doc = (data as { document?: Record<string, unknown> } | null)?.document
  if (!doc || typeof doc.sha256 !== 'string') return null
  return {
    snapshot,
    title: typeof doc.title === 'string' ? doc.title : snapshot,
    revision: typeof doc.revision === 'string' ? doc.revision : null,
    sha256: doc.sha256.toLowerCase(),
    bytes: typeof doc.bytes === 'number' ? doc.bytes : null,
    url: typeof doc.url === 'string' ? doc.url : null,
  }
}

// ---- the copyable report ---------------------------------------------------------------------------------------------

export interface ReportInput {
  when: string
  page: string
  userAgent: string
  caches: readonly string[]
  /** Whether the offline worker served the page during the Run (null: unknown). */
  worker?: boolean | null
  vectors: VectorReport | null
  snapshots: SnapshotReport | null
  digest: { hex: string | null; cards: string | null } | null
  origins: { other: number; recorded: number } | null
}

/** Plain-text summary of a Run, every figure as measured. */
export function reportText(r: ReportInput): string {
  const lines = [`LANDFALL in-browser checks (${r.page}), ${r.when}`]
  lines.push(
    `Build (service-worker cache): ${r.caches.length ? r.caches.join(', ') : 'none'}` +
      (r.worker == null ? '' : `; offline worker serving the page: ${r.worker ? 'yes' : 'no'}`),
  )
  lines.push(`Browser: ${r.userAgent}`)
  const v = r.vectors
  if (v) {
    lines.push(
      `Engine: ${v.agree} of ${v.total} vectors agree with the Python reference within ${REL_TOL.toExponential()} (${v.files} files; ` +
        `${v.errors.same} of ${v.errors.total} expected errors); replay ${v.ms.toFixed(0)} ms`,
    )
    lines.push(
      `  bit-for-bit (information): ${v.bitExact.same} of ${v.bitExact.total} results; tolerance-only t_cdf ${v.bitExactToleranceOnly.same} of ${v.bitExactToleranceOnly.total}`,
    )
    for (const d of v.disagreements) lines.push(`  disagrees: ${d.path} #${d.index} ${d.name}: ${d.lines.join('; ')}`)
  } else lines.push('Engine: not run')
  const s = r.snapshots
  if (s) {
    lines.push(`Snapshots: ${s.match} of ${s.total} match manifest.json; manifest.json SHA-256 ${s.manifestSha256}`)
    for (const x of s.results.filter((x) => !x.match)) lines.push(`  mismatch: ${x.file} ${x.error ?? `${x.sha256} (${x.bytes} B)`}`)
  } else lines.push('Snapshots: not run')
  if (r.digest) {
    lines.push(`Rules digest: ${r.digest.hex ?? 'unavailable'}; the cue cards print ${r.digest.cards ? r.digest.cards.slice(0, 12) : 'unavailable'}`)
  } else lines.push('Rules digest: not run')
  if (r.origins) lines.push(`Requests to other origins since the page loaded: ${r.origins.other} (of ${r.origins.recorded} recorded)`)
  else lines.push('Requests to other origins: not run')
  return lines.join('\n')
}
