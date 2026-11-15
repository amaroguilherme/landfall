// Minimal Chrome DevTools Protocol client: no dependencies (Node >= 22 has a global WebSocket).
// One browser-level connection; each page is a flattened session (Target.attachToTarget).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Chrome stopped answering a frame-loop call (screenshot or paint); recapture the shot on a fresh page. */
export class StallError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StallError'
  }
}

/** Launch headless Chrome on a free port (read back from DevToolsActivePort) and connect to it. */
export async function launchChrome({ chromePath = DEFAULT_CHROME, width, height }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lf-video-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    `--window-size=${width},${height}`,
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]
  const proc = spawn(chromePath, args, { stdio: 'ignore' })
  let exited = false
  proc.on('exit', () => (exited = true))
  const portFile = join(userDataDir, 'DevToolsActivePort')
  let lines = []
  for (let i = 0; i < 150 && lines.length < 2; i++) {
    if (exited) throw new Error(`Chrome exited before opening DevTools (${chromePath})`)
    if (existsSync(portFile)) lines = readFileSync(portFile, 'utf8').trim().split('\n')
    if (lines.length < 2) await sleep(100)
  }
  if (lines.length < 2) throw new Error('Chrome did not write DevToolsActivePort in 15 s')
  const browser = await Connection.open(`ws://127.0.0.1:${lines[0]}${lines[1]}`)
  /** Never throws: a failed cleanup must not mask the error that ended the run. */
  const close = async () => {
    try {
      await Promise.race([browser.send('Browser.close', {}, undefined, 3000), sleep(3000)])
    } catch {
      /* already gone */
    }
    if (!exited) {
      const gone = new Promise((r) => proc.once('exit', r))
      proc.kill('SIGKILL')
      await Promise.race([gone, sleep(3000)])
    }
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        return
      } catch {
        await sleep(300) // Chrome helpers may still be flushing the profile
      }
    }
  }
  return { browser, close }
}

export class Connection {
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
    })
    return new Connection(ws)
  }

  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Set()
    ws.addEventListener('message', (ev) => this.onMessage(ev))
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`CDP connection closed during ${p.method}`))
      this.pending.clear()
    })
  }

  onMessage(ev) {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    for (const l of this.listeners) l(msg)
  }

  /** Every command times out (default 90 s) with its method name, so a stuck page cannot hang the run. */
  send(method, params = {}, sessionId, timeoutMs = 90000) {
    const id = ++this.seq
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: no answer from Chrome in ${timeoutMs} ms`))
      }, timeoutMs)
      const done = (fn) => (v) => {
        clearTimeout(timer)
        fn(v)
      }
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method })
      this.ws.send(JSON.stringify(msg))
    })
  }

  /** Subscribe to every event; returns the unsubscribe function. */
  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Resolve with the params of the next `method` event (optionally of one session). */
  waitFor(method, sessionId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l)
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${method}`))
      }, timeoutMs)
      const l = (msg) => {
        if (msg.method !== method || (sessionId && msg.sessionId !== sessionId)) return
        clearTimeout(timer)
        this.listeners.delete(l)
        resolve(msg.params)
      }
      this.listeners.add(l)
    })
  }

  /** A page with a `width` x `height` CSS px viewport, rendered at `dsf` device pixels per CSS pixel. */
  async newPage({ width, height, dsf = 1 }) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this, targetId, sessionId)
    await page.init({ width, height, dsf })
    return page
  }
}

export class Page {
  constructor(conn, targetId, sessionId) {
    this.conn = conn
    this.targetId = targetId
    this.sessionId = sessionId
    this.frozen = false
    // in-flight requests, for networkIdle()
    this.inflight = new Set()
    this.lastNetwork = Date.now()
    this.off = conn.on((m) => {
      if (m.sessionId !== sessionId) return
      if (m.method === 'Network.requestWillBeSent') this.inflight.add(m.params.requestId)
      else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') this.inflight.delete(m.params.requestId)
      else return
      this.lastNetwork = Date.now()
    })
  }

  send(method, params = {}, timeoutMs) {
    return this.conn.send(method, params, this.sessionId, timeoutMs)
  }

  waitFor(method, timeoutMs) {
    return this.conn.waitFor(method, this.sessionId, timeoutMs)
  }

  async init({ width, height, dsf = 1 }) {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false })
    await this.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-reduced-motion', value: 'no-preference' },
        { name: 'prefers-color-scheme', value: 'dark' },
      ],
    })
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }

  async goto(url, timeoutMs = 45000) {
    const loaded = this.waitFor('Page.loadEventFired', timeoutMs)
    const r = await this.send('Page.navigate', { url })
    if (r.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`)
    await loaded
  }

  /** Evaluate an expression in the page; returns its JSON value, throws on a page exception. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`in page: ${d.exception?.description ?? d.text}`)
    }
    return r.result.value
  }

  /** Run a self-contained function in the page with JSON-serialisable arguments. */
  call(fn, ...args) {
    return this.eval(`(${fn.toString()})(...${JSON.stringify(args)})`)
  }

  /** Poll `fn(...args)` in the page until it returns a truthy value. */
  async waitUntil(fn, args = [], { timeoutMs = 30000, pollMs = 100, what = 'condition' } = {}) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const v = await this.call(fn, ...args)
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
      await sleep(pollMs)
    }
  }

  /** Resolve once no request has been in flight for `quietMs` (real time). */
  async networkIdle(quietMs = 1000, timeoutMs = 45000) {
    const end = Date.now() + timeoutMs
    while (!(this.inflight.size === 0 && Date.now() - this.lastNetwork >= quietMs)) {
      if (Date.now() > end) throw new Error(`network not idle after ${timeoutMs} ms (${this.inflight.size} requests in flight)`)
      await sleep(100)
    }
  }

  /**
   * Install the app clock (CLOCK_SHIM) for every document this page loads. Call before goto().
   * Until freeze() the shim passes straight through to the real clock.
   */
  async installClock() {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SHIM })
  }

  /** Freeze the app's clock: performance.now, Date.now and timers only move with tick(). */
  async freeze() {
    const v = await this.eval('window.__lfvClock ? window.__lfvClock.freeze() : null')
    if (v === null) throw new Error('freeze(): the clock shim is not installed in this page')
    this.frozen = true
  }

  /**
   * Move the frozen app clock forward by `ms`, in steps of at most `stepMs`, letting the page render
   * after each step (React commits, effects re-arm their timers), then wait until it has painted.
   */
  async tick(ms, stepMs = 1000 / 30) {
    let left = ms
    while (left > 1e-9) {
      const d = Math.min(stepMs, left)
      await this.eval(`window.__lfvClock.advance(${d})`)
      left -= d
      await this.painted(left > 1e-9 ? 1 : 2)
    }
  }

  /** Resolve after `frames` real animation frames: whatever the page changed is now on screen. */
  async painted(frames = 2) {
    const v = await Promise.race([
      this.eval(`new Promise((r) => { let n = ${frames}; const f = () => (--n > 0 ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f) })`),
      sleep(5000).then(() => null),
    ])
    if (v === null) throw new StallError('the page did not paint within 5 s')
  }

  /**
   * Lossless screenshot. A capture that has not answered after `stallMs` throws StallError so the
   * caller can recapture the shot on a fresh page. A safety net: with the in-page clock Chrome keeps
   * rendering in real time and captures have not stalled (under CDP virtual time they did).
   */
  async screenshotPng(stallMs = 4000) {
    const pending = this.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })
    pending.catch(() => {}) // a stalled capture is abandoned together with its page
    let timer
    const r = await Promise.race([pending, new Promise((res) => (timer = setTimeout(() => res(null), stallMs)))])
    clearTimeout(timer)
    if (!r) throw new StallError(`Page.captureScreenshot did not answer in ${stallMs} ms`)
    return Buffer.from(r.data, 'base64')
  }

  async close() {
    this.off()
    try {
      await this.conn.send('Target.closeTarget', { targetId: this.targetId }, undefined, 10000)
    } catch {
      /* already closed, or wedged: the browser is closed at the end anyway */
    }
  }
}

/**
 * The app clock, injected at document start. Chrome's own virtual time (Emulation.setVirtualTimePolicy)
 * stalls screenshots on large pages, so time is controlled in the page instead: performance.now,
 * Date.now, setTimeout and setInterval pass through to the real clock until __lfvClock.freeze(), then
 * only move when __lfvClock.advance(ms) is called, which runs every timer that falls due, in order, at
 * its own virtual time. Rendering, requestAnimationFrame and the network stay on the real clock.
 */
export const CLOCK_SHIM = `(() => {
  if (window.__lfvClock) return
  const P = window.performance
  const realPerf = P.now.bind(P)
  const realDate = Date.now.bind(Date)
  const realST = window.setTimeout.bind(window)
  const realCT = window.clearTimeout.bind(window)
  const realSI = window.setInterval.bind(window)
  const realCI = window.clearInterval.bind(window)
  let frozen = false
  let vPerf = 0
  let dateOffset = 0
  let seq = 0
  const timers = new Map()
  const BASE = 2 ** 30
  const add = (fn, ms, args, repeat) => {
    const delay = Math.max(0, Number(ms) || 0)
    const id = BASE + ++seq
    timers.set(id, { due: vPerf + delay, fn, args, every: repeat ? Math.max(1, delay) : 0, seq })
    return id
  }
  P.now = () => (frozen ? vPerf : realPerf())
  Date.now = () => (frozen ? Math.floor(vPerf + dateOffset) : realDate())
  window.setTimeout = function (fn, ms, ...args) { return frozen ? add(fn, ms, args, false) : realST(fn, ms, ...args) }
  window.setInterval = function (fn, ms, ...args) { return frozen ? add(fn, ms, args, true) : realSI(fn, ms, ...args) }
  window.clearTimeout = function (id) { if (!timers.delete(id)) realCT(id) }
  window.clearInterval = function (id) { if (!timers.delete(id)) realCI(id) }
  window.__lfvClock = {
    freeze() {
      if (!frozen) { vPerf = realPerf(); dateOffset = realDate() - vPerf; frozen = true }
      return vPerf
    },
    advance(ms) {
      const end = vPerf + ms
      for (let guard = 0; guard < 100000; guard++) {
        let id = null
        let t = null
        for (const [k, v] of timers) if (v.due <= end && (!t || v.due < t.due || (v.due === t.due && v.seq < t.seq))) { id = k; t = v }
        if (!t) break
        vPerf = Math.max(vPerf, t.due)
        if (t.every) { t.due += t.every; t.seq = ++seq } else timers.delete(id)
        if (typeof t.fn === 'function') { try { t.fn(...t.args) } catch (e) { realST(() => { throw e }, 0) } }
      }
      vPerf = end
      return timers.size
    },
  }
})()`
