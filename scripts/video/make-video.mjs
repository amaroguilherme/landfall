#!/usr/bin/env node
// LANDFALL 30-second demo video, rebuilt from the live app with one command:
//
//   node scripts/video/make-video.mjs [base-url] [--out=DIR] [--crf=14] [--chrome=PATH] [--keep-master]
//
// base-url defaults to the public deployment. No npm dependencies: Node >= 22 (global WebSocket,
// fetch), system Chrome over the DevTools protocol, and ffmpeg/ffprobe on PATH.
//
// How it stays reproducible: every shot gets a fresh page that loads in REAL time (so the app's
// own in-browser latency measurement is genuine), then the app's clock is frozen (an in-page shim
// over performance.now, Date.now and timers, see cdp.mjs) and stepped exactly 1/30 s per frame, so
// animations, the MET clock and scrolls land on the same frames on every run. App shots are laid out
// at VIEW (1440x810 CSS px) and rendered at 4/3 device pixels per CSS pixel, so every frame is 1920x1080
// with the app's text a third larger than a 1920 px layout; title cards render at 1920x1080. Frames are
// lossless PNGs piped into a lossless master, then encoded once to H.264 (yuv420p, BT.709, faststart,
// no audio). Every on-screen claim is checked against the app before its frames are written
// (storyboard.mjs); the run aborts if one fails. Text that is still a placeholder (PLACEHOLDERS in
// storyboard.mjs) is logged, listed in facts.json and flagged NOT FOR UPLOAD YET.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_CHROME, StallError, launchChrome } from './cdp.mjs'
import { FPS, HEIGHT, MAX_SECONDS, PLACEHOLDERS, PUBLIC_URL, SHOTS, VIEW, WIDTH, factsPass } from './storyboard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const MAX_BYTES = 15 * 1024 * 1024
/** Page age before the clock may be frozen: past App.tsx's warmup (1.5 s timer + idle callback, 4 s timeout). */
const SETTLE_AFTER_LOAD_MS = 6500
/** Attempts per shot when Chrome stalls under the frozen clock (each attempt is a fresh page). */
const MAX_ATTEMPTS = 5
const TARGET_BYTES = 14 * 1024 * 1024 // re-encode at a higher CRF above this, to keep a margin

// ---- arguments -----------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { base: PUBLIC_URL, out: join(REPO, '.cache/video'), crf: 14, chrome: process.env.CHROME || DEFAULT_CHROME, keepMaster: false, only: null }
  for (const a of argv) {
    const [k, v] = a.startsWith('--') ? a.slice(2).split(/=(.*)/s) : [null, a]
    if (k === null) opts.base = v
    else if (k === 'base') opts.base = v
    else if (k === 'out') opts.out = resolve(v)
    else if (k === 'crf') opts.crf = Number(v)
    else if (k === 'chrome') opts.chrome = v
    else if (k === 'keep-master') opts.keepMaster = true
    else if (k === 'only') opts.only = v.split(',').map((x) => x.trim()).filter(Boolean)
    else if (k === 'help' || k === 'h') {
      console.log('usage: node scripts/video/make-video.mjs [base-url] [--out=DIR] [--crf=14] [--chrome=PATH] [--keep-master] [--only=shot,shot (preview, no hard-limit checks)]')
      process.exit(0)
    } else throw new Error(`unknown option --${k}`)
  }
  opts.base = opts.base.replace(/#.*$/, '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(opts.base)) throw new Error(`base URL must be http(s): ${opts.base}`)
  if (!Number.isFinite(opts.crf) || opts.crf < 0 || opts.crf > 40) throw new Error(`bad --crf ${opts.crf}`)
  return opts
}

// ---- small helpers -------------------------------------------------------------------------------

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a)
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const VERBOSE = !!process.env.LF_VIDEO_VERBOSE
const step = (id, what) => VERBOSE && log(`  ${id}: ${what}`)

function need(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${bin} is required on PATH`)
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}\n${r.stderr}`)
  return r.stdout
}

/** dddd/hh:mm:ss(.s) for a MET in seconds, as the app prints it. */
function formatMet(s) {
  const whole = Math.floor(s)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const frac = s - whole > 1e-6 ? `.${Math.round((s - whole) * 10)}` : ''
  // F.6.1 f (D2): no leading zeros in the day field, as the app prints MET (412/14:20:09).
  return `${Math.floor(whole / 86400)}/${p(Math.floor((whole % 86400) / 3600))}:${p(Math.floor((whole % 3600) / 60))}:${p(whole % 60)}${frac}`
}

// ---- fonts: the app's own Inter / Public Sans Web / DM Mono, inlined for the title cards ---------

const CARD_FACES = [
  ['Inter', 400],
  ['Inter', 500],
  ['Inter', 600],
  ['Public Sans Web', 700],
  ['DM Mono', 500],
]

async function fontCss(origins) {
  for (const origin of origins) {
    try {
      const html = await (await fetch(`${origin}/`)).text()
      const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => new URL(m[1], `${origin}/`).href)
      const faces = []
      for (const href of sheets) {
        const css = await (await fetch(href)).text()
        for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
          const body = m[1]
          const family = /font-family:\s*["']?([^;"']+)["']?/.exec(body)?.[1].trim()
          const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1])
          const style = /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal'
          const url = /url\(\s*["']?([^)"']+)["']?\s*\)/.exec(body)?.[1]
          if (family && url && style === 'normal') faces.push({ family, weight, url: new URL(url, href).href })
        }
      }
      const rules = []
      for (const [family, weight] of CARD_FACES) {
        const f = faces.find((x) => x.family === family && x.weight === weight)
        if (!f) throw new Error(`no @font-face for ${family} ${weight} at ${origin}`)
        const res = await fetch(f.url)
        if (!res.ok) throw new Error(`font ${f.url}: HTTP ${res.status}`)
        const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
        rules.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2')}`)
      }
      return { css: `/* the app's fonts, from ${origin} */\n${rules.join('\n')}\n`, origin }
    } catch (e) {
      log(`fonts: ${origin} failed (${e.message}); trying the next origin`)
    }
  }
  throw new Error('could not read the app fonts from any origin')
}

// ---- page-side overlay: caption (a lower third) and a focus ring for what is being clicked ------

/**
 * `k` = CSS px per output pixel (1 / the page's device scale factor). Every size below is written in output
 * pixels of the 1920x1080 frame and multiplied by k, so the caption is the same size on screen whatever the
 * page's CSS viewport is (the app shots are laid out at 1440 CSS px and rendered at 4/3, see VIEW).
 * The caption is a full-width lower third: it hides the bottom of the page whole instead of covering the
 * left half of a line of app text and leaving the rest of the line beside it.
 */
function installOverlay(kicker, caption, k = 1) {
  if (!window.__lfv) {
    const px = (n) => `${+(n * k).toFixed(3)}px`
    const FEATHER = 64
    const style = document.createElement('style')
    style.textContent = `
      #lfv-caption { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483646;
        box-sizing: border-box; padding: ${px(26)} ${px(56)} ${px(44)}; background: #08080a;
        box-shadow: 0 0 0 ${px(1)} rgba(255, 255, 255, 0.1); pointer-events: none; opacity: 0; }
      #lfv-caption .lfv-in { max-width: ${px(1500)}; border-left: ${px(6)} solid #ffffff; padding: ${px(2)} 0 ${px(2)} ${px(28)}; }
      #lfv-caption p { margin: 0; }
      /* a feathered top edge, so the page behind fades into the caption instead of being sliced */
      #lfv-caption::before { content: ''; position: absolute; left: 0; right: 0; bottom: 100%; height: ${px(FEATHER)};
        background: linear-gradient(to bottom, rgba(8, 8, 10, 0), rgba(8, 8, 10, 0.92)); }
      #lfv-caption .lfv-k { font: 500 ${px(19)}/1.2 'DM Mono', ui-monospace, monospace; letter-spacing: 0.04em; color: #b9b9bb; margin-bottom: ${px(12)}; }
      #lfv-caption .lfv-t { font: 600 ${px(40)}/1.22 'Inter', 'Helvetica Neue', Arial, sans-serif; letter-spacing: -0.012em; color: #ffffff; }
      #lfv-ring { position: fixed; z-index: 2147483647; box-sizing: border-box; pointer-events: none; border: ${px(3)} solid #5cff7a;
        border-radius: ${px(6)}; box-shadow: 0 0 0 ${px(6)} rgba(92, 255, 122, 0.22); opacity: 0; }
      /* overlay-free review stills (stills with overlay: false): the frame without the caption and the ring */
      html[data-lfv-hidden] #lfv-caption, html[data-lfv-hidden] #lfv-ring { visibility: hidden !important; }
      /* Capture only. CSS transitions run on Chrome's real clock, not on the frozen app clock, so they
         would land on different frames each run: they are off. The app's only CSS motion is 120 ms
         transitions (chevrons, body-figure fills), which become cuts (4 frames at 30 fps); the hero's
         sequence is JS-driven and untouched. Scroll anchoring is off too: a shot that changes content
         above the viewport re-anchors explicitly (frame spec "anchor"), the same way on every run. */
      *, *::before, *::after { transition: none !important; animation: none !important; overflow-anchor: none !important; }`
    document.head.appendChild(style)
    const cap = document.createElement('div')
    cap.id = 'lfv-caption'
    cap.setAttribute('aria-hidden', 'true')
    const inner = document.createElement('div')
    inner.className = 'lfv-in'
    const kick = document.createElement('p')
    kick.className = 'lfv-k'
    const t = document.createElement('p')
    t.className = 'lfv-t'
    inner.append(kick, t)
    cap.append(inner)
    const ring = document.createElement('div')
    ring.id = 'lfv-ring'
    document.body.append(cap, ring)
    window.__lfv = {
      /** CSS px per output pixel (the storyboard's geometry checks convert with it). */
      k,
      caption(kickerText, text) {
        kick.textContent = kickerText ?? ''
        kick.style.display = kickerText ? '' : 'none'
        t.replaceChildren()
        String(text).split('\n').forEach((line, i) => {
          if (i) t.appendChild(document.createElement('br'))
          t.appendChild(document.createTextNode(line))
        })
      },
      /** The caption box in viewport CSS px, and the top of its feathered edge (whatever its opacity). */
      box() {
        const r = cap.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, featherTop: r.top - FEATHER * k }
      },
      /** Hide (true) or show (false) the caption and the ring, for an overlay-free review still. */
      hide(on) {
        if (on) document.documentElement.setAttribute('data-lfv-hidden', '')
        else document.documentElement.removeAttribute('data-lfv-hidden')
        return true
      },
      frame(spec) {
        const pick = (sel, text) => [...document.querySelectorAll(sel)].filter((el) => !text || new RegExp(text, 'i').test(el.textContent))
        if (typeof spec.scrollY === 'number') window.scrollTo({ top: spec.scrollY, left: 0, behavior: 'instant' })
        // anchor: keep one element at viewport y (a re-render above it would otherwise move it)
        if (spec.anchor) {
          const el = pick(spec.anchor.sel, spec.anchor.text)[0]
          const dy = el ? Math.round(el.getBoundingClientRect().top - spec.anchor.y) : 0
          if (dy) window.scrollBy({ top: dy, left: 0, behavior: 'instant' })
        }
        const o = typeof spec.caption === 'number' ? spec.caption : 1
        cap.style.opacity = String(o)
        cap.style.transform = o < 1 ? `translateY(${((1 - o) * 14 * k).toFixed(2)}px)` : 'none'
        // the caption's words alone (`t`, the .lfv-t line; the band and its kicker stay): a caption that changes
        // cross-fades its words, because dipping the whole band would flash the page bottom it hides
        t.style.opacity = String(typeof spec.words === 'number' ? spec.words : 1)
        const r = spec.ring
        let shown = false
        if (r && r.o > 0) {
          let L = Infinity
          let T = Infinity
          let R = -Infinity
          let B = -Infinity
          for (const el of pick(r.sel, r.text)) {
            const b = el.getBoundingClientRect()
            if (!b.width && !b.height) continue
            L = Math.min(L, b.left)
            T = Math.min(T, b.top)
            R = Math.max(R, b.right)
            B = Math.max(B, b.bottom)
          }
          if (L < R) {
            const p = r.pad ?? 6
            Object.assign(ring.style, { left: `${L - p}px`, top: `${T - p}px`, width: `${R - L + 2 * p}px`, height: `${B - T + 2 * p}px`, opacity: String(r.o) })
            shown = true
          }
        }
        if (!shown) ring.style.opacity = '0'
        return true
      },
    }
  }
  window.__lfv.caption(kicker, caption)
  return true
}

function applyFrame(spec) {
  return window.__lfv.frame(spec)
}

/**
 * Where each element of a shot's `clear` list sits on the last frame: inside the viewport, below the sticky
 * mission bar, and not under the caption box (viewport CSS px). `under` also reports the caption's feathered
 * edge, which darkens but does not hide what is behind it.
 */
function clearOfCaption(specs) {
  const cap = window.__lfv.box()
  const bar = document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0
  return specs.map(({ sel, text, what }) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => !text || new RegExp(text, 'i').test(e.textContent))
    const el = els.find((e) => {
      const b = e.getBoundingClientRect()
      return b.width > 0 && b.height > 0
    })
    if (!el) return { what, found: false }
    const r = el.getBoundingClientRect()
    const xOverlap = r.right > cap.left && r.left < cap.right
    const rect = { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }
    return {
      what,
      found: true,
      rect,
      caption: { top: Math.round(cap.top), featherTop: Math.round(cap.featherTop), left: Math.round(cap.left), right: Math.round(cap.right) },
      bar: Math.round(bar),
      inView: r.top >= bar - 1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1,
      underCaption: xOverlap && r.bottom > cap.top + 1,
      underFeather: xOverlap && r.bottom > cap.featherTop + 1,
    }
  })
}

/** Width and height of a PNG from its IHDR chunk. */
function pngDims(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function appReady() {
  const owlt = document.querySelector('.lf-comms-owlt .lf-num')?.textContent ?? ''
  return document.readyState === 'complete' && !!document.querySelector('main') && /\d/.test(owlt)
}

function readMet() {
  const m = /(\d+)\/(\d{2}):(\d{2}):(\d{2})/.exec(document.querySelector('.lf-mb-met')?.textContent ?? '')
  return m ? ((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4]) : null
}

/** Resolve when the page's MET reaches `target` seconds (whole-second tick + the fraction). */
async function waitMet(target) {
  const box = document.querySelector('.lf-mb-met')
  const read = () => {
    const m = /(\d+)\/(\d{2}):(\d{2}):(\d{2})/.exec(box?.textContent ?? '')
    return m ? ((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4]) : NaN
  }
  const whole = Math.floor(target)
  const now = read()
  if (!(now < whole)) return { late: true, met: now }
  const ok = await new Promise((done) => {
    const mo = new MutationObserver(() => {
      if (read() >= whole) {
        mo.disconnect()
        done(true)
      }
    })
    mo.observe(box, { subtree: true, childList: true, characterData: true })
    setTimeout(() => (mo.disconnect(), done(false)), (whole - now + 15) * 1000)
  })
  if (!ok) return { late: true, stuck: true, met: read() }
  await new Promise((r) => setTimeout(r, Math.round((target - whole) * 1000)))
  return { late: false, met: read() }
}

// ---- ffmpeg ----------------------------------------------------------------------------------------

/** Lossless RGB master fed with PNG frames on stdin. */
function startMaster(file) {
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', 'pipe:0', '-c:v', 'libx264rgb', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'rgb24', file], {
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  let stderr = ''
  let exitCode = null
  ff.stderr.on('data', (d) => (stderr += d))
  const exited = new Promise((res) => ff.on('exit', (code) => res((exitCode = code))))
  ff.stdin.on('error', () => {}) // surfaced through the exit code below
  let frames = 0
  return {
    async write(buf) {
      if (exitCode !== null) throw new Error(`ffmpeg master stopped (exit ${exitCode}): ${stderr.slice(-1500)}`)
      frames++
      if (!ff.stdin.write(buf)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), exited])
    },
    async end() {
      ff.stdin.end()
      const code = await exited
      if (code !== 0) throw new Error(`ffmpeg master exited ${code}: ${stderr.slice(-1500)}`)
      return frames
    },
    get frames() {
      return frames
    },
  }
}

function encodeFinal(master, file, crf) {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', master,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-profile:v', 'high', '-level:v', '4.1',
    '-g', String(FPS * 2), '-keyint_min', String(FPS),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-r', String(FPS), '-movflags', '+faststart',
    '-metadata', 'title=LANDFALL: Earth-independent health navigation for exploration crews (30-second demo)',
    file,
  ])
}

function probe(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames,color_space,color_transfer,color_primaries', '-of', 'json', file]))
  const v = j.streams.filter((s) => s.codec_type === 'video')
  return {
    duration: Number(j.format.duration),
    durationText: j.format.duration,
    bytes: Number(j.format.size),
    bitRate: Number(j.format.bit_rate),
    streams: j.streams.map((s) => s.codec_type),
    video: v[0] ?? null,
    videoStreams: v.length,
    audioStreams: j.streams.filter((s) => s.codec_type === 'audio').length,
  }
}

// ---- main ------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  need('ffmpeg')
  need('ffprobe')
  if (!existsSync(opts.chrome)) throw new Error(`Chrome not found at ${opts.chrome} (set --chrome=PATH or CHROME)`)

  const total = SHOTS.reduce((s, x) => s + x.dur, 0)
  if (total > MAX_SECONDS + 1e-9) throw new Error(`storyboard is ${total} s, over the ${MAX_SECONDS} s budget`)
  // the app viewport, scaled by its device scale factor, must fill the output frame exactly
  if (Math.round(VIEW.width * VIEW.dsf) !== WIDTH || Math.round(VIEW.height * VIEW.dsf) !== HEIGHT) {
    throw new Error(`VIEW ${VIEW.width}x${VIEW.height} at DSF ${VIEW.dsf} does not render to ${WIDTH}x${HEIGHT}`)
  }
  const unknown = (opts.only ?? []).filter((id) => !SHOTS.some((x) => x.id === id))
  if (unknown.length) throw new Error(`--only: no shot ${unknown.join(', ')} (have ${SHOTS.map((x) => x.id).join(', ')})`)
  const shots = opts.only ? SHOTS.filter((x) => opts.only.includes(x.id)) : SHOTS
  const preview = !!opts.only
  const totalFrames = shots.reduce((s, x) => s + Math.round(x.dur * FPS), 0)

  const out = opts.out
  const work = join(out, 'work')
  mkdirSync(work, { recursive: true })
  // A full run writes its stills, facts.json and the mp4 to work/stage, and moves them into `out` only once every
  // claim and every hard limit has passed. A run that fails (a claim the app no longer supports, a full disk, an
  // encode over the limits) leaves the last good deliverables in `out` as they were, all from one run.
  const stage = preview ? work : join(work, 'stage')
  if (!preview) {
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    failedRunNote = `the deliverables in ${relative(REPO, out) || out} were not replaced; this run's partial output is in ${relative(REPO, stage)}`
  }
  const mp4Name = preview ? `preview-${opts.only.join('-')}.mp4` : 'landfall-30s.mp4'
  const factsName = preview ? 'preview-facts.json' : 'facts.json'
  const mp4 = join(stage, mp4Name) // encoded and probed here
  const mp4Out = join(preview ? work : out, mp4Name) // delivered here
  const master = join(work, preview ? 'preview-master.mkv' : 'master.mkv')
  const stillDir = stage
  const stillOut = preview ? work : out
  if (preview) for (const s of shots) for (const st of s.stills ?? []) rmSync(join(work, `${st.name}.png`), { force: true })

  log(`base ${opts.base} · ${shots.length} shots · ${(totalFrames / FPS).toFixed(2)} s · ${totalFrames} frames at ${FPS} fps · ${WIDTH}x${HEIGHT} (app at ${VIEW.width}x${VIEW.height} CSS px, DSF ${+VIEW.dsf.toFixed(4)}; cards at ${WIDTH}x${HEIGHT}, DSF 1)${preview ? ' · PREVIEW (--only)' : ''}`)
  if (opts.base !== PUBLIC_URL) log(`note: capturing ${opts.base}; the last card still prints the public URL ${PUBLIC_URL}`)
  const placeholders = PLACEHOLDERS.filter((p) => shots.some((s) => s.id === p.shot))
  for (const p of placeholders) log(`PLACEHOLDER ${p.marker} on ${p.shot}: ${p.why}. This render is not for upload until it is resolved.`)

  const fonts = await fontCss([...new Set([opts.base, PUBLIC_URL])])
  writeFileSync(join(work, 'card-fonts.css'), fonts.css)
  copyFileSync(join(HERE, 'card.html'), join(work, 'card.html'))
  log(`fonts: ${CARD_FACES.map((f) => f.join(' ')).join(', ')} from ${fonts.origin}`)

  const facts = {}
  const checkMap = new Map() // claim -> latest result (a recaptured shot re-checks its claims)
  const warnings = []
  const ctx = {
    facts,
    fact: (k, v) => (facts[k] = v),
    assert: (ok, claim, evidence) => {
      const seen = checkMap.has(claim)
      checkMap.set(claim, { ok: !!ok, claim, evidence })
      if (!ok) throw new Error(`claim not supported by the app: ${claim}\n  saw: ${JSON.stringify(evidence)}`)
      if (!seen) log(`  ok  ${claim}`)
    },
    warn: (w) => (warnings.push(w), log(`  WARN ${w}`)),
  }

  const { browser, close } = await launchChrome({ chromePath: opts.chrome, width: WIDTH, height: HEIGHT })
  const stop = async () => {
    await close()
    process.exit(130)
  }
  process.once('SIGINT', stop)
  const chromeVersion = (await browser.send('Browser.getVersion')).product
  log(`chrome ${chromeVersion}`)

  const openApp = async (route) => {
    const page = await browser.newPage({ width: VIEW.width, height: VIEW.height, dsf: VIEW.dsf })
    await page.installClock()
    await page.goto(`${opts.base}/${route}`)
    await page.waitUntil(appReady, [], { what: `${route}: app shell and comms`, timeoutMs: 45000 })
    return page
  }

  /** Capture one shot on a fresh page; returns its frames (buffered, so a stalled attempt leaves no trace). */
  const captureShot = async (shot, plan) => {
    const n = Math.round(shot.dur * FPS)
    // frame index -> the stills taken on it (a frame can give a still with and one without the overlay)
    const stillAt = new Map()
    for (const s of shot.stills ?? []) {
      const f = Math.min(n - 1, Math.round(s.at * FPS))
      stillAt.set(f, [...(stillAt.get(f) ?? []), s])
    }
    const frames = []
    const stills = new Map()
    let page = null
    let state = {}
    let metStart = null
    try {
      if (shot.kind === 'card') {
        page = await browser.newPage({ width: WIDTH, height: HEIGHT, dsf: 1 })
        await page.goto(pathToFileURL(join(work, 'card.html')).href)
        const text = await page.call((s) => window.renderCard(s), shot.card(facts))
        if (!(await page.call(() => window.fontsReady()))) throw new Error(`${shot.id}: card fonts did not load`)
        ctx.fact(`${shot.id}.text`, text.replace(/\n+/g, ' / '))
      } else {
        step(shot.id, `open ${shot.route}`)
        page = await openApp(shot.route)
        step(shot.id, 'wait for the page')
        await page.waitUntil(shot.ready, [], { what: `${shot.id}: page ready`, timeoutMs: 45000 })
        await page.eval('document.fonts.ready.then(() => true)')
        await page.call(installOverlay, shot.kicker, shot.caption, 1 / VIEW.dsf)
        step(shot.id, 'check / prepare')
        if (shot.check) await shot.check(page, ctx)
        if (shot.prepare) state = (await shot.prepare(page, ctx)) ?? {}
        await page.call(applyFrame, shot.frame ? shot.frame(0, state) : {})

        // Settle before freezing the clock: the shell warms every route chunk and snapshot on idle
        // (1.5 s timer, then requestIdleCallback, up to 4 s). Let that finish so nothing loads or
        // re-renders in the background while frames are captured.
        step(shot.id, 'settle: app warmup window and network idle')
        await page.waitUntil((ms) => performance.now() > ms, [SETTLE_AFTER_LOAD_MS], { what: `${shot.id}: the app warmup window`, timeoutMs: 30000, pollMs: 200 })
        await page.networkIdle(1000, 60000)

        const preroll = shot.preroll ?? 0
        if (plan.pauseAt[shot.id] === undefined) plan.pauseAt[shot.id] = plan.metCursor === null ? (await page.call(readMet)) + 1.5 : plan.metCursor - preroll / 1000
        const pauseAt = plan.pauseAt[shot.id]
        step(shot.id, `wait for MET ${formatMet(pauseAt)} (page at ${formatMet(await page.call(readMet))})`)
        const sync = await page.call(waitMet, pauseAt)
        if (sync.stuck) throw new Error(`${shot.id}: the page's MET clock stopped at ${formatMet(sync.met)}`)
        if (sync.late) ctx.warn(`${shot.id}: page was ready after MET ${formatMet(pauseAt)} (at ${formatMet(sync.met)}); the clock jumps at this cut`)
        step(shot.id, 'freeze the clock')
        if (page.inflight.size) ctx.warn(`${shot.id}: ${page.inflight.size} request(s) still in flight when the clock froze`)
        await page.freeze()
        let advanced = 0
        if (shot.onPaused) advanced += (await shot.onPaused(page, state, ctx)) || 0
        if (preroll) {
          await page.tick(preroll)
          advanced += preroll
        }
        metStart = (sync.late ? sync.met + 0.5 : pauseAt) + advanced / 1000
      }

      const events = (shot.events ?? []).map((e) => ({ ...e, done: false }))
      step(shot.id, `capture ${n} frames`)
      for (let f = 0; f < n; f++) {
        const t = f / FPS
        try {
          if (shot.kind === 'card') {
            await page.call((x) => (window.setTime(x), true), t)
            await page.painted()
          } else {
            for (const e of events) {
              if (!e.done && t >= e.at) {
                await e.run(page, state, ctx)
                e.done = true
              }
            }
            await page.call(applyFrame, shot.frame ? shot.frame(t, state) : {})
            await page.tick(1000 / FPS) // the app clock lands exactly on (f + 1) / FPS after the freeze
          }
          const png = await page.screenshotPng()
          const dims = pngDims(png)
          if (dims.width !== WIDTH || dims.height !== HEIGHT) throw new Error(`frame is ${dims.width}x${dims.height}, not ${WIDTH}x${HEIGHT}`)
          frames.push(png)
          for (const s of stillAt.get(f) ?? []) {
            if (s.overlay !== false || shot.kind === 'card') {
              stills.set(s.name, png)
              continue
            }
            // the same frame without the caption and the ring (the app clock is frozen between the two captures)
            await page.call((on) => window.__lfv.hide(on), true)
            await page.painted()
            stills.set(s.name, await page.screenshotPng())
            await page.call((on) => window.__lfv.hide(on), false)
            await page.painted()
          }
        } catch (e) {
          const msg = `${shot.id}, frame ${f} (t=${t.toFixed(3)} s): ${e.message}`
          throw e instanceof StallError ? new StallError(msg) : new Error(msg)
        }
      }
      // what the caption must not cover: checked on the last frame, where every app shot takes its still
      if (shot.clear?.length) {
        const geo = await page.call(clearOfCaption, shot.clear)
        ctx.fact(`${shot.id}.clear`, geo)
        for (const g of geo) {
          ctx.assert(g.found && g.inView && !g.underCaption, `${shot.id}: ${g.what} is on screen on the last frame, below the mission bar and clear of the caption box`, g)
          if (g.underFeather) ctx.warn(`${shot.id}: the caption's feathered edge reaches ${g.what} (bottom ${g.rect.bottom}, feather from ${g.caption.featherTop} CSS px)`)
        }
      }
      if (shot.after) await shot.after(page, ctx)
      return { frames, stills, metStart }
    } finally {
      if (page) await page.close()
    }
  }

  const timeline = []
  let retries = 0
  let sink = null
  try {
    log('facts: reading the live app before any frame is written')
    await factsPass(openApp, ctx)

    sink = startMaster(master)
    // The mission clock carries across the cuts: each app shot's first frame shows the MET where the
    // previous one ended (a declared `preroll` is taken off pauseAt). What a shot steps in onPaused is not,
    // so the hero's 1.5 s moves the clock on 1.5 s at the cut into it. pauseAt is fixed on the first
    // attempt so a recapture lands identically.
    const plan = { metCursor: null, pauseAt: {} }
    let at = 0
    for (const shot of shots) {
      const started = Date.now()
      let r
      for (let attempt = 1; ; attempt++) {
        try {
          r = await captureShot(shot, plan)
          break
        } catch (e) {
          if (!(e instanceof StallError) || attempt >= MAX_ATTEMPTS) throw e
          retries++
          ctx.warn(`${e.message}; recapturing ${shot.id} on a fresh page (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`)
        }
      }
      for (const png of r.frames) await sink.write(png)
      for (const [name, png] of r.stills) writeFileSync(join(stillDir, `${name}.png`), png)
      if (r.metStart !== null) plan.metCursor = r.metStart + shot.dur
      timeline.push({ id: shot.id, kind: shot.kind, start: +at.toFixed(3), end: +(at + shot.dur).toFixed(3), frames: r.frames.length, route: shot.route ?? null, caption: facts[`${shot.id}.caption`] ?? shot.caption ?? null, metStart: r.metStart === null ? null : formatMet(r.metStart) })
      log(`${shot.id.padEnd(12)} ${at.toFixed(1).padStart(4)}-${(at + shot.dur).toFixed(1).padStart(4)} s  ${String(r.frames.length).padStart(3)} frames in ${((Date.now() - started) / 1000).toFixed(1)} s${r.metStart === null ? '' : `  (MET ${formatMet(r.metStart)})`}`)
      at += shot.dur
    }

    const written = await sink.end()
    sink = null
    if (written !== totalFrames) throw new Error(`wrote ${written} frames, expected ${totalFrames}`)
  } finally {
    if (sink) await sink.end().catch(() => {})
    await close() // never throws, so the real error (if any) reaches the user
    process.removeListener('SIGINT', stop)
  }

  // ---- encode, then verify the hard limits with ffprobe ----
  let crf = opts.crf
  let p
  for (;;) {
    encodeFinal(master, mp4, crf)
    p = probe(mp4)
    log(`encode crf ${crf}: ${mb(p.bytes)}, ${p.durationText} s`)
    if (p.bytes <= TARGET_BYTES || crf >= 30) break
    crf += 2
  }
  const v = p.video
  const problems = []
  if (!(p.duration <= 30.0)) problems.push(`duration ${p.duration} s > 30.0 s`)
  if (!(p.bytes < MAX_BYTES)) problems.push(`size ${mb(p.bytes)} >= 15 MB`)
  if (p.videoStreams !== 1 || p.streams.length !== 1) problems.push(`streams ${p.streams.join(',')} (want exactly one video stream)`)
  if (p.audioStreams !== 0) problems.push('has an audio track')
  if (v?.codec_name !== 'h264' || v?.pix_fmt !== 'yuv420p') problems.push(`codec ${v?.codec_name} ${v?.pix_fmt}`)
  if (v?.width !== WIDTH || v?.height !== HEIGHT) problems.push(`size ${v?.width}x${v?.height}`)
  if (v?.r_frame_rate !== `${FPS}/1`) problems.push(`frame rate ${v?.r_frame_rate}`)
  if (!opts.keepMaster) rmSync(master, { force: true })

  const checks = [...checkMap.values()]
  const report = {
    generatedAt: new Date().toISOString(),
    base: opts.base,
    publicUrl: PUBLIC_URL,
    chrome: chromeVersion,
    /** App shots: CSS viewport and device scale factor; title cards render at the output size, DSF 1. */
    view: { app: { width: VIEW.width, height: VIEW.height, dsf: VIEW.dsf }, cards: { width: WIDTH, height: HEIGHT, dsf: 1 } },
    /** Text on screen that is a placeholder: the render is not for upload while this list is not empty. */
    placeholders,
    output: { file: relative(REPO, mp4Out), bytes: p.bytes, duration: p.durationText, crf, video: v },
    timeline,
    retries,
    checks,
    warnings,
    facts,
  }
  writeFileSync(join(stage, factsName), `${JSON.stringify(report, null, 2)}\n`)

  log(`checks: ${checks.filter((c) => c.ok).length}/${checks.length} claims confirmed against the app`)
  if (preview) {
    for (const s of shots) for (const st of s.stills ?? []) log(`still ${relative(REPO, join(stillOut, `${st.name}.png`))}`)
    log(`video ${relative(REPO, mp4Out)}: ${p.durationText} s, ${p.bytes} bytes (${mb(p.bytes)}), ${v?.codec_name} ${v?.profile} ${v?.width}x${v?.height} ${v?.pix_fmt} ${v?.r_frame_rate} fps, streams: ${p.streams.join(',')}`)
    log(`preview only (--only): not the deliverable, hard limits not enforced: ${relative(REPO, mp4Out)}`)
    return
  }
  if (problems.length) throw new Error(`output fails the hard limits: ${problems.join('; ')}`)
  // every claim and every hard limit passed: publish the run (renames within one volume), all of it or none
  const publish = [...shots.flatMap((s) => (s.stills ?? []).map((st) => [join(stage, `${st.name}.png`), join(stillOut, `${st.name}.png`)])), [join(stage, factsName), join(out, factsName)], [mp4, mp4Out]]
  const unstaged = publish.filter(([from]) => !existsSync(from)).map(([from]) => relative(REPO, from))
  if (unstaged.length) throw new Error(`nothing published: this run did not stage ${unstaged.join(', ')}`)
  for (const [from, to] of publish) renameSync(from, to)
  rmSync(stage, { recursive: true, force: true })
  failedRunNote = null
  for (const s of shots) for (const st of s.stills ?? []) log(`still ${relative(REPO, join(stillOut, `${st.name}.png`))}`)
  log(`video ${relative(REPO, mp4Out)}: ${p.durationText} s, ${p.bytes} bytes (${mb(p.bytes)}), ${v?.codec_name} ${v?.profile} ${v?.width}x${v?.height} ${v?.pix_fmt} ${v?.r_frame_rate} fps, streams: ${p.streams.join(',')}`)
  for (const p of placeholders) log(`NOT FOR UPLOAD YET: ${p.shot} shows the placeholder ${p.marker} (${p.why})`)
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s; facts and claim checks in ${relative(REPO, join(out, factsName))}`)
}

/** Set while a full run is in progress: what a failure leaves where (printed with the error). */
let failedRunNote = null

main().catch((e) => {
  console.error(`\nmake-video failed: ${e.message}${failedRunNote ? `\n(${failedRunNote})` : ''}`)
  process.exit(1)
})
