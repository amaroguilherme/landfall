#!/usr/bin/env node
// Offline-reload QA over the Chrome DevTools Protocol, no dependencies (Node >= 22: global WebSocket).
// ConOps check: after ONE online visit to the hero, does every route reload with the network OFF?
//   1. Online, fresh profile: open <base>/#/ and wait until the service worker controls the page (its
//      install precached the build), <html data-offline-ready> is set, and the app's idle prefetch has
//      requested every snapshot in /data/manifest.json. No other route is visited online.
//   2. Network OFF: Network.emulateNetworkConditions offline=true on the page AND on every service
//      worker target (auto-attached; a worker attached later gets it on attach). LANDFALL's worker is
//      stopped so it cold-starts under the cut, and two probes prove the cut, before and after the run:
//      a URL the worker does not handle (page network) and an uncached /data URL (worker network).
//   3. Each route is reloaded cold, offline: #/ must set html[data-hero-ready-ms]; every route must
//      render its main heading, stay controlled by the worker, show no error boundary, no stuck
//      "Opening view", no failed same-origin request (chunks, fonts and data alike), and no more
//      missing/unknown/loading data states than the same route online.
//   4. Network back ON: the same reloads give the online reference for step 3.
//
//   node scripts/qa-offline.mjs http://localhost:4401
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = (process.argv[2] ?? 'http://localhost:4401').replace(/\/+$/, '')
const ROUTES = ['#/', '#/body', '#/cases', '#/case', '#/case/spe_shelter', '#/case/renal_stone', '#/case/sleep_circadian',
  '#/radiation', '#/noon-sight', '#/trends', '#/downlink', '#/band', '#/provenance', '#/method', '#/data']
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OFF = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
const ON = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
const BAD_EMPTY = ['error', 'missing', 'unavailable', 'loading'] // .lf-empty[data-kind]
const BAD_FRESH = ['missing', 'unknown', 'unavailable', 'loading'] // .lf-fresh[data-state]

const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lf-qa-offline-'))}`, 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const watchdog = setTimeout(() => { console.error('FAIL: qa-offline timed out after 6 min'); chrome.kill(); process.exit(2) }, 360_000)

async function browserEndpoint() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    } catch { /* chrome still starting */ }
    await sleep(200)
  }
  throw new Error('Chrome did not expose its DevTools endpoint')
}

const version = await browserEndpoint()
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
const listeners = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } else if (msg.method) for (const l of listeners) l(msg)
})
/** Flat-session CDP call; resolves to `result`, throws on a protocol error. */
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

// ---- targets: the page, plus every service worker (emulation is per DevTools session) ----
let offline = false
const workers = new Map() // sessionId -> url
listeners.push(async (m) => {
  if (m.method === 'Target.detachedFromTarget') workers.delete(m.params.sessionId)
  if (m.method !== 'Target.attachedToTarget') return
  const { sessionId, targetInfo, waitingForDebugger } = m.params
  try {
    if (targetInfo.type === 'service_worker') {
      workers.set(sessionId, targetInfo.url)
      await send('Network.enable', {}, sessionId)
      if (offline) await send('Network.emulateNetworkConditions', OFF, sessionId)
    }
  } finally {
    if (waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
  }
})
// Not paused on start: a restarted worker keeps its session (no new attach event) and would wait forever.
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
const pageTarget = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'page')
const page = (await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })).sessionId
await send('Page.enable', {}, page)
await send('Runtime.enable', {}, page)
await send('Network.enable', {}, page)
await send('ServiceWorker.enable', {}, page)

// LANDFALL's own worker versions (to stop just that worker: stopAllWorkers can hang on Chrome's built-in ones).
const versions = new Map() // versionId -> runningStatus
listeners.push((m) => {
  if (m.method !== 'ServiceWorker.workerVersionUpdated') return
  for (const v of m.params.versions) if (v.scriptURL.startsWith(base + '/')) versions.set(v.versionId, v.runningStatus)
})

// Failed page requests and uncaught exceptions, collected per route load.
const urls = new Map()
let failed = []
let exceptions = []
listeners.push((m) => {
  if (m.sessionId !== page) return
  if (m.method === 'Network.requestWillBeSent') urls.set(m.params.requestId, m.params.request.url)
  if (m.method === 'Network.loadingFailed' && !m.params.canceled) failed.push(`${urls.get(m.params.requestId) ?? '?'} (${m.params.errorText})`)
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? m.params.exceptionDetails?.text ?? 'exception')
})

/** Like send(), but gives up after `ms` (resolves to null) instead of hanging the run. */
const sendWithin = (ms, method, params, sessionId) => Promise.race([send(method, params, sessionId).catch(() => null), sleep(ms).then(() => null)])

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(expression, timeoutMs, stepMs = 250) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await evaluate(expression).catch(() => null)
    if (v) return v
    await sleep(stepMs)
  }
  return null
}
async function setNetwork(conditions) {
  offline = conditions.offline
  await send('Network.emulateNetworkConditions', conditions, page)
  for (const s of workers.keys()) await send('Network.emulateNetworkConditions', conditions, s).catch(() => {})
}

const PROBE = `(() => {
  const q = (s) => [...document.querySelectorAll(s)]
  const tally = (els, key) => els.reduce((m, e) => ((m[e.dataset[key]] = (m[e.dataset[key]] ?? 0) + 1), m), {})
  const main = document.getElementById('main')
  const h = main && (main.querySelector('h1') ?? main.querySelector('.lf-empty-title, h2'))
  const empties = q('#main .lf-empty')
  const nav = performance.getEntriesByType('navigation')[0]
  return {
    old: !!window.__lfQaOld,
    href: location.href,
    ready: document.readyState,
    shellMs: nav ? Math.round(nav.responseEnd) : null,
    heading: h ? h.textContent.trim().replace(/\\s+/g, ' ') : '',
    controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    hero: document.documentElement.dataset.heroReadyMs ?? null,
    empty: tally(empties, 'kind'),
    fresh: tally(q('.lf-fresh'), 'state'),
    boundary: empties.some((e) => e.dataset.kind === 'error' && /could not be shown/i.test(e.textContent)),
    errors: empties.filter((e) => e.dataset.kind === 'error').map((e) => e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 140)),
  }
})()`

/** Reload `route` cold (hash set in place, then Page.reload) and wait until the NEW document settles. */
async function loadRoute(route) {
  const url = `${base}/${route}`
  // Synchronous hash change, and a marker that only the old document carries.
  const at = await evaluate(`(() => { location.hash = ${JSON.stringify(route.slice(1))}; window.__lfQaOld = true; return location.href })()`)
  if (at !== url) throw new Error(`could not move to ${url} (at ${at})`)
  failed = []
  exceptions = []
  await send('Page.reload', {}, page)
  const t0 = Date.now()
  let last = null
  let stable = 0
  while (Date.now() - t0 < 20_000) {
    await sleep(300)
    const s = await evaluate(PROBE).catch(() => null)
    if (!s) continue
    const settled = !s.old && s.href === url && s.ready === 'complete' && s.heading && !s.empty.loading && (route !== '#/' || s.hero)
    const key = JSON.stringify([s.heading.slice(0, 60), s.empty, s.fresh, s.hero])
    stable = settled && key === last ? stable + 1 : 0
    last = key
    if (stable >= 3) return { ...s, failed: [...failed], exceptions: [...exceptions] }
  }
  const s = (await evaluate(PROBE).catch(() => null)) ?? { heading: '', empty: {}, fresh: {}, errors: [], controlled: false, hero: null, boundary: false }
  return { ...s, timedOut: true, failed: [...failed], exceptions: [...exceptions] }
}

const pathOf = (u) => { try { return new URL(u).pathname } catch { return u } }
const bad = (s) => [...BAD_EMPTY.map((k) => [`empty:${k}`, s.empty?.[k] ?? 0]), ...BAD_FRESH.map((k) => [`fresh:${k}`, s.fresh?.[k] ?? 0])]
const log = (s = '') => console.log(s)
const problems = [] // run-level failures, named on the last line
let exitCode = 0

try {
  log(`LANDFALL offline QA  base=${base}  ${version.Browser}`)

  // ---- 1. one online visit -------------------------------------------------------------------------
  const tStart = Date.now()
  await send('Page.navigate', { url: `${base}/#/` }, page)
  const heroOnline = await waitFor(`document.documentElement.dataset.heroReadyMs ?? null`, 30_000)
  const controlled = await waitFor(`!!(navigator.serviceWorker && navigator.serviceWorker.controller)`, 60_000)
  const tControlled = (Date.now() - tStart) / 1000
  const offlineReady = await waitFor(`document.documentElement.dataset.offlineReady ?? null`, 30_000)
  const prefetch = await waitFor(`(async () => {
    const m = await (await fetch('/data/manifest.json', { headers: { Accept: 'application/json' } })).json()
    const seen = new Set(performance.getEntriesByType('resource').filter((e) => e.responseEnd > 0).map((e) => new URL(e.name).pathname))
    const want = m.snapshots.map((s) => '/data/' + (s.file || s.id + '.json'))
    const got = want.filter((p) => seen.has(p)).length
    return got === want.length ? got + '/' + want.length : null
  })()`, 60_000, 500)
  // Network quiet: no new resource entries for 1.5 s.
  for (let n = -1, quiet = 0; quiet < 3;) {
    const c = await evaluate(`performance.getEntriesByType('resource').length`)
    quiet = c === n ? quiet + 1 : 0
    n = c
    await sleep(500)
  }
  const tPrefetch = (Date.now() - tStart) / 1000
  log(`online visit (#/ only): hero ready ${heroOnline ?? 'NEVER'} ms; worker controls the page after ${controlled ? tControlled.toFixed(1) + ' s' : 'NEVER'}; ` +
    `html[data-offline-ready]=${offlineReady ?? 'absent'}; app prefetch (route chunks, then ${prefetch ?? 'INCOMPLETE'} snapshots) quiet after ${tPrefetch.toFixed(1)} s`)
  if (!heroOnline || !controlled || !prefetch) throw new Error('the online visit did not complete; nothing to test offline')
  if (!offlineReady) problems.push('html[data-offline-ready] never set')

  const pre = await evaluate(`(async () => {
    const src = await (await fetch('/sw.js', { cache: 'no-store' })).text()
    const m = /const BUILD = (\\{[^\\n]*\\})/.exec(src)
    const build = m ? JSON.parse(m[1]) : null
    const name = build ? 'landfall-' + build.version : null
    if (!name || !(await caches.has(name))) return { build: !!build, name, all: await caches.keys() }
    const cache = await caches.open(name)
    const keys = await cache.keys()
    let bytes = 0
    for (const k of keys) bytes += (await (await cache.match(k)).blob()).size
    const have = new Set(keys.map((k) => new URL(k.url).pathname))
    // Cached at runtime during the visit but not in the build list: the precache list has a gap (e.g. SW_FONTS).
    const extra = keys.map((k) => new URL(k.url)).map((u) => u.pathname + u.search).filter((p) => !build.files.includes(p))
    return { build: true, name, all: await caches.keys(), entries: keys.length, bytes, expected: build.files.length, expectedBytes: build.bytes,
      missing: build.files.filter((f) => !have.has(f)), extra, fonts: build.files.filter((f) => f.endsWith('.woff2')).length }
  })()`)
  if (!pre.entries) throw new Error(`no precache found (build list ${pre.build ? 'present' : 'absent'} in /sw.js; caches: ${pre.all?.join(', ') || 'none'})`)
  log(`precache: ${pre.name}: ${pre.entries} entries, ${(pre.bytes / 1e6).toFixed(2)} MB in Cache Storage; build list ${pre.expected} files ` +
    `(${(pre.expectedBytes / 1e6).toFixed(2)} MB, ${pre.fonts} font faces); missing ${pre.missing.length ? pre.missing.join(' ') : 'none'}; ` +
    `cached at runtime outside the list ${pre.extra.length ? pre.extra.join(' ') : 'none'}; caches: ${pre.all.join(', ')}`)
  if (pre.missing.length) problems.push(`${pre.missing.length} precache entries missing`)
  const extraAssets = pre.extra.filter((p) => p.startsWith('/assets/'))
  if (extraAssets.length) problems.push(`the precache list misses ${extraAssets.join(' ')} (used online, cached only at runtime)`)

  // ---- 2. network OFF, proven ------------------------------------------------------------------------
  await setNetwork(OFF)
  // Cold-start the worker under the cut (the browser stops idle workers anyway); the probes below run on
  // the restarted worker, so they also prove its DevTools session kept the emulation.
  let stopped = 0
  for (const [versionId, status] of versions) {
    if (status === 'running' && (await sendWithin(5000, 'ServiceWorker.stopWorker', { versionId }, page))) stopped++
  }
  const probes = async () => evaluate(`(async () => {
    const out = {}
    for (const [k, u] of [['page', '/__landfall_offline_probe__?' + Date.now()], ['worker', '/data/manifest.json?offline-probe=' + Date.now()]]) {
      try { out[k] = 'HTTP ' + (await fetch(u, { cache: 'no-store' })).status } catch { out[k] = 'failed' }
    }
    return out
  })()`)
  const p1 = await probes()
  log(`network off: page-network probe ${p1.page}, worker-network probe ${p1.worker} (both must fail); worker stopped first: ${stopped ? 'yes' : 'no'}`)
  if (p1.page !== 'failed' || p1.worker !== 'failed') throw new Error('offline emulation did not cut the network; the test would prove nothing')

  // ---- 3. offline: reload every route cold -------------------------------------------------------------
  const off = {}
  for (const r of ROUTES) off[r] = await loadRoute(r)
  const p2 = await probes()
  log(`still off after the run (worker restarted): page-network probe ${p2.page}, worker-network probe ${p2.worker}`)
  if (p2.page !== 'failed' || p2.worker !== 'failed') problems.push('the network came back during the offline run')

  // ---- 4. online reference -------------------------------------------------------------------------------
  await setNetwork(ON)
  const on = {}
  for (const r of ROUTES) on[r] = await loadRoute(r)

  // ---- verdicts ----------------------------------------------------------------------------------------------
  log('')
  log(`${'route'.padEnd(24)} ${'offline'.padEnd(7)}  ${'heading after an offline reload'.padEnd(46)} notes`)
  let passed = 0
  for (const r of ROUTES) {
    const o = off[r]
    const n = on[r]
    const why = []
    const notes = []
    if (o.timedOut) why.push('did not settle in 20 s')
    if (!o.heading) why.push('no heading')
    if (!o.controlled) why.push('not served by the worker')
    if (o.boundary) why.push('error boundary')
    if (o.errors?.length && !o.boundary) why.push(`error state: ${o.errors[0]}`)
    if (r === '#/' && !o.hero) why.push('no html[data-hero-ready-ms]')
    // Offline, every same-origin request must come from the precache: a font or image that fails is a gap in the
    // list as much as a chunk is. The browser's own update check of /sw.js failing offline is expected.
    const hardFails = o.failed.filter((f) => f.startsWith(base + '/') && pathOf(f.split(' ')[0]) !== '/sw.js')
    if (hardFails.length) why.push(`failed: ${hardFails.map((f) => pathOf(f.split(' ')[0])).join(', ')}`)
    const softFails = o.failed.filter((f) => !hardFails.includes(f))
    if (softFails.length) notes.push(`failed, other origin: ${softFails.map((f) => f.split(' ')[0]).join(', ')}`)
    if (o.exceptions.length) why.push(`exception: ${o.exceptions[0]}`)
    const onBad = Object.fromEntries(bad(n))
    const worse = bad(o).filter(([k, v]) => v > (onBad[k] ?? 0)).map(([k, v]) => `${k} ${v} vs ${onBad[k] ?? 0} online`)
    if (worse.length) why.push(`worse than online: ${worse.join('; ')}`)
    if (o.heading && n.heading && o.heading.slice(0, 40) !== n.heading.slice(0, 40)) notes.push(`online heading: "${n.heading.slice(0, 40)}"`)
    if (r === '#/') notes.push(`hero ready ${o.hero ?? '-'} ms offline (${n.hero ?? '-'} ms online)`)
    notes.push(`shell ${o.shellMs ?? '-'} ms`)
    if (/^no such view$/i.test(o.heading) && /^no such view$/i.test(n.heading)) notes.push('not a route: "No such view" online too')
    const shownBad = bad(o).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`)
    if (shownBad.length && !worse.length) notes.push(`same as online: ${shownBad.join(' ')}`)
    const ok = why.length === 0
    if (ok) passed++
    const heading = o.heading.length > 46 ? o.heading.slice(0, 45) + '…' : o.heading || '-'
    log(`${r.padEnd(24)} ${(ok ? 'PASS' : 'FAIL').padEnd(7)}  ${heading.padEnd(46)} ${[...why, ...notes].join('; ')}`)
  }
  if (passed !== ROUTES.length || problems.length) exitCode = 1
  log('')
  log(`${exitCode ? 'FAIL' : 'PASS'}: ${passed}/${ROUTES.length} routes reload offline after one online visit${problems.length ? ` (also: ${problems.join('; ')})` : ''}`)
} catch (e) {
  log(`FAIL: ${e.message}`)
  exitCode = 1
} finally {
  clearTimeout(watchdog)
  ws.close()
  chrome.kill()
}
process.exit(exitCode)
