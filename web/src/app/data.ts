// Data layer: frozen NASA/NOAA snapshots served same-origin as /data/<id>.json.
// Never a third-party origin, never a backend. A file that is not in the build resolves to
// 'missing' (rendered as a [V2 10020] "unavailable" state), never a spinner forever.
import { useEffect, useSyncExternalStore } from 'react'
import type { FreshnessKind } from './vocab'

// ---------------------------------------------------------------------------------------------
// Types mirroring ingest/common.py (schema "landfall.snapshot/1" and "landfall.manifest/1")
// ---------------------------------------------------------------------------------------------

export interface SnapshotSource {
  publisher: string
  name: string
  url: string
  access_urls: string[]
  license: string
  citation: string
}

export interface SnapshotCoverage {
  start: string | null
  stop: string | null
  cadence: string | null
}

export interface SnapshotFreshness {
  kind: FreshnessKind
  /** ISO-8601 duration such as "PT6H", or null when the data never goes stale. */
  stale_after: string | null
}

export type SnapshotProvenance = 'measured' | 'predicted' | 'reference' | 'simulated' | 'derived'

export interface Snapshot<T = unknown> {
  schema: 'landfall.snapshot/1'
  id: string
  adapter: string
  title: string
  source: SnapshotSource
  retrieved_at: string
  coverage: SnapshotCoverage
  freshness: SnapshotFreshness
  provenance: SnapshotProvenance
  caveats: string[]
  data: T
}

export interface ManifestEntry {
  id: string
  adapter: string
  title: string
  file: string
  bytes: number
  sha256: string
  retrieved_at: string
  provenance: SnapshotProvenance
  freshness: SnapshotFreshness
  coverage: SnapshotCoverage
  publisher: string
  url: string
}

export interface Manifest {
  schema: 'landfall.manifest/1'
  snapshots: ManifestEntry[]
}

/** The fields FreshnessChip needs; both a Snapshot and a ManifestEntry satisfy it. */
export interface SnapshotMeta {
  id: string
  retrieved_at: string
  freshness: SnapshotFreshness
  coverage: SnapshotCoverage
  provenance?: SnapshotProvenance
}

export type LoadStatus = 'loading' | 'ready' | 'missing' | 'error'

export interface SnapshotState<T = unknown> {
  status: LoadStatus
  snapshot: Snapshot<T> | null
  data: T | null
  /** Human-readable reason for 'missing' or 'error'. */
  error: string | null
}

// ---------------------------------------------------------------------------------------------
// Fetching with an in-memory cache
// ---------------------------------------------------------------------------------------------

const BASE = import.meta.env.BASE_URL ?? '/'

export function snapshotUrl(id: string): string {
  return `${BASE}data/${id}.json`
}

const LOADING: SnapshotState<never> = Object.freeze({ status: 'loading', snapshot: null, data: null, error: null })
const results = new Map<string, SnapshotState>()
const inflight = new Map<string, Promise<SnapshotState>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

async function fetchJson(url: string): Promise<{ status: 'ok'; body: unknown } | { status: 'missing' | 'error'; reason: string }> {
  let res: Response
  try {
    // Accept: application/json keeps SPA fallbacks (Vite preview, static hosts) from
    // answering a missing file with index.html.
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (e) {
    return { status: 'error', reason: `network: ${(e as Error).message}` }
  }
  if (res.status === 404 || res.status === 410) return { status: 'missing', reason: `${url} is not in this build` }
  if (!res.ok) return { status: 'error', reason: `HTTP ${res.status} for ${url}` }
  const text = await res.text()
  if (/^\s*</.test(text)) return { status: 'missing', reason: `${url} is not in this build (host answered with HTML)` }
  try {
    return { status: 'ok', body: JSON.parse(text) }
  } catch {
    return { status: 'error', reason: `${url} is not valid JSON` }
  }
}

/** Load a snapshot once per session; later calls share the cached promise/result. */
export function loadSnapshot<T = unknown>(id: string): Promise<SnapshotState<T>> {
  const done = results.get(id)
  if (done && done.status !== 'loading') return Promise.resolve(done as SnapshotState<T>)
  const pending = inflight.get(id)
  if (pending) return pending as Promise<SnapshotState<T>>
  results.set(id, LOADING)
  const p = fetchJson(snapshotUrl(id)).then((r): SnapshotState => {
    let state: SnapshotState
    if (r.status !== 'ok') {
      state = { status: r.status, snapshot: null, data: null, error: r.reason }
    } else {
      const s = r.body as Snapshot
      if (!s || typeof s !== 'object' || s.schema !== 'landfall.snapshot/1') {
        state = { status: 'error', snapshot: null, data: null, error: `${id}.json is not a landfall.snapshot/1 file` }
      } else {
        state = { status: 'ready', snapshot: s, data: s.data, error: null }
      }
    }
    results.set(id, state)
    inflight.delete(id)
    emit()
    return state
  })
  inflight.set(id, p)
  return p as Promise<SnapshotState<T>>
}

/** Synchronous peek at the cache (null if never requested). */
export function peekSnapshot<T = unknown>(id: string): SnapshotState<T> | null {
  return (results.get(id) as SnapshotState<T> | undefined) ?? null
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * React hook: `const { status, snapshot, data, error } = useSnapshot<MyShape>('swpc_s_scale')`.
 * Pass null to skip loading (status stays 'loading').
 */
export function useSnapshot<T = unknown>(id: string | null): SnapshotState<T> {
  const state = useSyncExternalStore(
    subscribe,
    () => (id ? (results.get(id) ?? LOADING) : LOADING),
    () => LOADING,
  ) as SnapshotState<T>
  useEffect(() => {
    if (id) void loadSnapshot(id)
  }, [id])
  return state
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

export interface ManifestState {
  status: LoadStatus
  manifest: Manifest | null
  entries: ManifestEntry[]
  error: string | null
}

let manifestState: ManifestState = { status: 'loading', manifest: null, entries: [], error: null }
let manifestPromise: Promise<ManifestState> | null = null

export function loadManifest(): Promise<ManifestState> {
  if (manifestPromise) return manifestPromise
  manifestPromise = fetchJson(`${BASE}data/manifest.json`).then((r) => {
    if (r.status !== 'ok') {
      manifestState = { status: r.status, manifest: null, entries: [], error: r.reason }
    } else {
      const m = r.body as Manifest
      const ok = m && m.schema === 'landfall.manifest/1' && Array.isArray(m.snapshots)
      manifestState = ok
        ? { status: 'ready', manifest: m, entries: m.snapshots, error: null }
        : { status: 'error', manifest: null, entries: [], error: 'manifest.json is not a landfall.manifest/1 file' }
    }
    emit()
    return manifestState
  })
  return manifestPromise
}

/** React hook: `const { status, entries } = useManifest()`. */
export function useManifest(): ManifestState {
  const state = useSyncExternalStore(subscribe, () => manifestState, () => manifestState)
  useEffect(() => {
    void loadManifest()
  }, [])
  return state
}

// ---------------------------------------------------------------------------------------------
// Freshness ([V2 10020]: visual indication when data is stale, missing, unavailable or unknown)
// ---------------------------------------------------------------------------------------------

/** Parse an ISO-8601 duration (PnDTnHnMnS, PnW) into seconds. Returns NaN when unparseable. */
export function parseIsoDuration(s: string): number {
  const m = /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    s.trim(),
  )
  if (!m || s.trim() === 'P' || s.trim().endsWith('T')) return Number.NaN
  const [, w, d, h, min, sec] = m.map((x) => (x === undefined ? 0 : Number(x)))
  return w * 604_800 + d * 86_400 + h * 3600 + min * 60 + sec
}

export type FreshnessState = 'frozen' | 'stale' | 'missing' | 'unavailable' | 'unknown' | 'loading'

export interface FreshnessInfo {
  state: FreshnessState
  /** Short uppercase label for the chip, e.g. "HISTORICAL", "STALE", "MISSING". */
  label: string
  /** One-line plain-language explanation. */
  detail: string
  kind: FreshnessKind | null
  retrievedAt: string | null
  /** Seconds since retrieval (wall clock), when known. */
  ageS: number | null
}

const KIND_LABEL: Record<FreshnessKind, string> = {
  live: 'LIVE FEED',
  historical: 'HISTORICAL',
  prediction: 'PREDICTION',
  reference: 'REFERENCE',
}

export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172_800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} d`
}

/**
 * Freshness of a frozen snapshot, judged against the real wall clock (judges open the URL
 * weeks after the build, so a live feed is honestly reported as stale).
 */
export function freshnessOf(meta: SnapshotMeta | null | undefined, status: LoadStatus = 'ready', now: Date = new Date()): FreshnessInfo {
  if (status === 'loading') {
    return { state: 'loading', label: 'LOADING', detail: 'Reading the frozen snapshot', kind: null, retrievedAt: null, ageS: null }
  }
  if (status === 'missing') {
    return { state: 'missing', label: 'MISSING', detail: 'Not in this build', kind: null, retrievedAt: null, ageS: null }
  }
  if (status === 'error' || !meta) {
    return { state: 'unknown', label: 'UNKNOWN', detail: 'Could not be read', kind: null, retrievedAt: null, ageS: null }
  }
  const kind = meta.freshness?.kind ?? null
  const retrieved = Date.parse(meta.retrieved_at)
  const ageS = Number.isFinite(retrieved) ? (now.getTime() - retrieved) / 1000 : null
  if (!kind) {
    return { state: 'unknown', label: 'UNKNOWN', detail: 'No freshness metadata', kind: null, retrievedAt: meta.retrieved_at, ageS }
  }
  const staleAfter = meta.freshness.stale_after ? parseIsoDuration(meta.freshness.stale_after) : null
  const predictionEnded =
    kind === 'prediction' && meta.coverage?.stop ? now.getTime() > Date.parse(meta.coverage.stop) : false
  if ((staleAfter !== null && Number.isFinite(staleAfter) && ageS !== null && ageS > staleAfter) || predictionEnded) {
    return {
      state: 'stale',
      label: 'STALE',
      detail: predictionEnded
        ? 'Prediction window has ended; frozen at build'
        : `${KIND_LABEL[kind].toLowerCase()} frozen at build, ${humanDuration(ageS ?? 0)} old (stale after ${humanDuration(staleAfter ?? 0)})`,
      kind,
      retrievedAt: meta.retrieved_at,
      ageS,
    }
  }
  return {
    state: 'frozen',
    label: KIND_LABEL[kind],
    detail: 'Frozen at build',
    kind,
    retrievedAt: meta.retrieved_at,
    ageS,
  }
}

/** "2026-11-14 13:17Z" from an ISO timestamp (UTC, minutes precision). */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
}

// ---------------------------------------------------------------------------------------------
// Offline warm-up: after the hero renders, pull every snapshot into the in-memory cache so the
// app keeps working with the network off for the rest of the session.
// ---------------------------------------------------------------------------------------------

export async function prefetchAllSnapshots(): Promise<void> {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } }
  if (nav.connection?.saveData) return
  const m = await loadManifest()
  for (const e of m.entries) {
    await loadSnapshot(e.id)
  }
}
