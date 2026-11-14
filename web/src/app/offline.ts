// Offline reloads. ConOps: a spacecraft in solar conjunction has no cloud, so production builds register
// /sw.js (web/public/sw.js; its precache list is injected by web/vite.config.ts) once the page has loaded
// and gone idle. The worker's install precaches the whole build (shell, every route chunk, every frozen
// snapshot, the font faces in use), so after ONE online visit a reload with the network off still works.
// main.tsx calls registerOfflineWorker() only when import.meta.env.PROD, and removeOfflineWorker() otherwise:
// the dev server never registers a worker and drops one a production build left on its origin.
import { useSyncExternalStore } from 'react'

const BASE = import.meta.env.BASE_URL ?? '/'

let ready = false
const listeners = new Set<() => void>()

function markReady(): void {
  if (ready) return
  ready = true
  // For CSS and QA (scripts/qa-offline.mjs): <html data-offline-ready="true">.
  document.documentElement.dataset.offlineReady = 'true'
  for (const l of listeners) l()
}

/** Register the service worker after window load, on idle, with scope = the app base ("/"). */
export function registerOfflineWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  const register = () => {
    navigator.serviceWorker
      .register(`${BASE}sw.js`, { scope: BASE })
      // An active worker exists only after its install precached the build completely.
      .then(() => navigator.serviceWorker.ready)
      .then(markReady)
      .catch((e: unknown) => console.warn('LANDFALL: offline reloads unavailable', e))
  }
  // Idle after load: the hero and its first snapshots go first; the precache never competes with them.
  const whenIdle = () =>
    typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(register, { timeout: 3000 })
      : window.setTimeout(register, 1000)
  if (document.readyState === 'complete') whenIdle()
  else window.addEventListener('load', whenIdle, { once: true })
}

/**
 * Dev server only: remove a LANDFALL worker that an earlier production build left on this origin (e.g. `vite
 * preview` once ran on this port). Left alone it keeps controlling the dev page and answers /data/*.json from
 * Cache Storage, one reload behind the files on disk. Takes effect from the next load.
 */
export function removeOfflineWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  const script = new URL(`${BASE}sw.js`, location.href).href
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.filter((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL === script).map((r) => r.unregister())))
    .catch(() => undefined)
  if ('caches' in window) {
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('landfall-')).map((k) => caches.delete(k))))
      .catch(() => undefined)
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * True once an active service worker holds a complete precache of a build: from then on, reloading this
 * page with the network off works. Always false in dev and where service workers are unavailable.
 */
export function useOfflineReady(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => ready,
    () => false,
  )
}
