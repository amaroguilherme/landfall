// LANDFALL service worker: offline reloads. ConOps: a spacecraft in solar conjunction has no cloud,
// so after ONE online visit the whole app (shell, every route chunk, every frozen NASA/NOAA snapshot,
// the font faces it renders) reloads from Cache Storage with the network off. No dependencies.
//
//   navigations to / or /index.html   network-first (NAV_TIMEOUT_MS), else the shell precached by THIS
//                                      version (never re-written from the network, so it always matches
//                                      the cached /assets of the same build)
//   /assets/* (hashed chunks, fonts)  cache-first
//   /data/*.json                      stale-while-revalidate. A file that is not cached stays a 404 or a
//                                      network failure, never an HTML fallback, so the app's [V2 10020]
//                                      "missing / unavailable" states keep working. Exception: a page whose
//                                      network shell differs from the precached one runs a NEWER build than
//                                      this worker holds (a redeploy it has not picked up yet), so its /data
//                                      reads go network-first: new code never renders the old snapshots.
//   other precached files (favicon)   stale-while-revalidate
//   anything else                     not intercepted
// Same-origin GET only. Only 200 same-origin, non-redirected responses are ever cached.
//
// The build (web/vite.config.ts, plugin "landfall:sw-precache") replaces the BUILD placeholder below
// with { version, bytes, files }: the precache list and a content hash of those files plus this script.
// A redeploy changes the hash, so the browser installs the new worker, which precaches the new build,
// takes over at once (skipWaiting + clients.claim) and deletes the old version's cache.
'use strict'

const BUILD = /*__LANDFALL_PRECACHE__*/ null

const SCOPE = new URL(self.registration.scope).pathname // "/"
const SHELL = SCOPE // cache key of index.html
const CACHE_PREFIX = 'landfall-'
const CACHE = CACHE_PREFIX + (BUILD ? BUILD.version : 'dev')
const PRECACHED = new Set(BUILD ? BUILD.files : [])
const NAV_TIMEOUT_MS = 3000
const PRECACHE_CONCURRENCY = 6
// Keys are plain URLs: a static host's content never varies by request headers (e.g. the app's
// Accept: application/json on snapshot requests).
const MATCH = { ignoreVary: true }
const DATA_FILE = /^data\/[^/]+\.json$/
// Pages (client ids) running a newer build than this worker's cache; see /data above.
const newerBuildClients = new Set()

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)))
      try {
        // The network-first navigation starts while the worker boots.
        await self.registration.navigationPreload?.enable()
      } catch {
        // Not supported here: navigations simply fetch after the worker starts.
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || req.headers.has('range')) return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return
  const path = url.pathname.slice(SCOPE.length)
  let strategy
  if (path === '' || path === 'index.html') strategy = shellNetworkFirst
  else if (path.startsWith('assets/')) strategy = cacheFirst
  else if (DATA_FILE.test(path) || PRECACHED.has(url.pathname)) strategy = staleWhileRevalidate
  else return
  // Safety net: if a strategy itself breaks (Cache Storage error), behave as if there were no worker.
  event.respondWith(strategy(event).catch(() => network(event)))
})

// ---- install: precache this build ----------------------------------------------------------------

async function precache() {
  if (!BUILD) return // unprocessed copy (dev server): runtime caching only
  const cache = await caches.open(CACHE)
  const queue = BUILD.files.slice()
  async function worker() {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (await cache.match(url, MATCH)) continue // stored by an earlier, interrupted install of this version
      const hashed = url.startsWith(SCOPE + 'assets/')
      if (hashed) {
        // Content-hashed names never change meaning: reuse the previous version's copy.
        const previous = await caches.match(url, MATCH)
        if (previous) {
          await cache.put(url, previous)
          continue
        }
      }
      const res = await fetch(url, { cache: hashed ? 'default' : 'no-cache', credentials: 'same-origin' })
      if (!cacheable(res, url === SHELL)) {
        // All or nothing: a half-filled cache must never claim to work offline.
        throw new Error(`LANDFALL precache: ${url} answered ${res.status} ${res.headers.get('content-type') ?? ''}`)
      }
      await cache.put(url, res)
    }
  }
  await Promise.all(Array.from({ length: PRECACHE_CONCURRENCY }, worker))
}

// ---- strategies ------------------------------------------------------------------------------------

/** Navigation preload when the browser started one, else a normal fetch. */
function network(event) {
  const preload = event.request.mode === 'navigate' ? event.preloadResponse : undefined
  return Promise.resolve(preload).then(
    (res) => res || fetch(event.request),
    () => fetch(event.request),
  )
}

/** 200, same-origin, not redirected, and HTML only where HTML is expected. */
function cacheable(res, html = false) {
  if (!res || res.status !== 200 || res.type !== 'basic' || res.redirected) return false
  return /text\/html/i.test(res.headers.get('content-type') ?? '') === html
}

async function shellNetworkFirst(event) {
  const fromNetwork = network(event)
  fromNetwork.catch(() => undefined) // a late failure after the timeout is not an error
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, NAV_TIMEOUT_MS, null)
  })
  const res = await Promise.race([fromNetwork, timeout]).catch(() => null)
  clearTimeout(timer)
  // A redirect (/index.html -> / on Cloudflare) is a valid network answer too.
  if (res && (res.ok || res.type === 'opaqueredirect')) {
    if (res.ok && event.resultingClientId) event.waitUntil(noteNewerBuild(event.resultingClientId, res.clone()))
    return res
  }
  const cache = await caches.open(CACHE)
  const shell = await cache.match(SHELL, MATCH)
  if (shell) return shell
  return res ?? fromNetwork
}

/** Remember the page if the network served a different index.html than the one this version precached. */
async function noteNewerBuild(clientId, fresh) {
  const cached = await (await caches.open(CACHE)).match(SHELL, MATCH)
  if (cached && (await cached.text()) !== (await fresh.text())) newerBuildClients.add(clientId)
}

async function cacheFirst(event) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(event.request, MATCH)
  if (cached) return cached
  const res = await network(event)
  if (cacheable(res)) event.waitUntil(cache.put(event.request, res.clone()))
  return res
}

async function staleWhileRevalidate(event) {
  const req = event.request
  const cache = await caches.open(CACHE)
  if (newerBuildClients.has(event.clientId)) {
    // Newer code than this cache: the host's current file, the cached copy only if the network is gone.
    try {
      return await network(event)
    } catch (e) {
      const fallback = await cache.match(req, MATCH)
      if (fallback) return fallback
      throw e
    }
  }
  const cached = await cache.match(req, MATCH)
  const refresh = network(event).then((res) => {
    if (cacheable(res)) event.waitUntil(cache.put(req, res.clone()))
    else if (res.status === 404 || res.status === 410) event.waitUntil(cache.delete(req, MATCH)) // gone from the host
    return res
  })
  if (!cached) return refresh // not cached: the host's answer as-is (404 stays 404; offline stays a failure)
  event.waitUntil(refresh.catch(() => undefined))
  return cached
}
