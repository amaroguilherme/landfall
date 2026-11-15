#!/usr/bin/env node
// LANDFALL project-page figures, captured from the live app with the claim checks of the video:
//
//   node scripts/video/make-figures.mjs [base-url] [--out=DIR] [--chrome=PATH] [--only=F1,F3]
//
// base-url defaults to the public deployment; --out defaults to .cache/video/figures (gitignored).
//
//   F1  the dual counter on #/: a GIF of the video's hero shot (make-video.mjs --only=hero, then ffmpeg
//       fps=12, scale=960, palettegen/paletteuse; under 4 MB) and the shot's last still as a PNG fallback.
//       Also og.png, the 1200x630 link-preview crop of that still (copy it to web/public/og.png).
//   F2  the opened "Why this fired" panel of the shelter case, element-clipped.
//   F3  CM-2's VO2max card at the Mars surface base and at ISS, each opened from its own ?env= deep link,
//       joined side by side with ffmpeg hstack.
//   F4  the provenance summary (intro and the per-chip counts), element-clipped.
//
// Every figure runs the ctx.assert checks of its shot in storyboard.mjs (and factsPass) before it is
// written; a failed check aborts the run. The run also fails when the GIF is 4 MB or more, any file is
// 10 MB or more (the project page's image limit), or figures.md prints a number that facts-figures.json
// does not hold. Captions and alt text are built from the facts read in this run, never typed.
//
// No npm dependencies: Node >= 22, system Chrome over the DevTools protocol (cdp.mjs), ffmpeg on PATH.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CHROME, launchChrome } from './cdp.mjs'
import { PUBLIC_URL, SHOTS, factsPass } from './storyboard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const WIDTH = 1920
const HEIGHT = 1080
/** Element figures are captured at 2 device pixels per CSS pixel, so text stays sharp when the page scales them. */
const FIGURE_DSF = 2
const MB = 1024 * 1024
const LIMITS = { gifMaxMB: 4, fileMaxMB: 10, gifFps: 12, gifWidth: 960, ogWidth: 1200, ogHeight: 630 }
/**
 * og.png: this rectangle of the 1920x1080 hero still (CSS px), scaled to 1200x630. It keeps the SIMULATED CREW
 * DATA strip, the mission bar, the headline, both counters and the [V2 6164] quote, and stops above the case
 * card and the video caption box in the lower left.
 */
const OG_CROP = { x: 240, y: 0, w: 1440, h: 756 }
const FIGURES = ['F1', 'F2', 'F3', 'F4']

// ---- arguments ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { base: PUBLIC_URL, out: join(REPO, '.cache/video/figures'), chrome: process.env.CHROME || DEFAULT_CHROME, only: null }
  for (const a of argv) {
    const [k, v] = a.startsWith('--') ? a.slice(2).split(/=(.*)/s) : [null, a]
    if (k === null || k === 'base') opts.base = v
    else if (k === 'out') opts.out = resolve(v)
    else if (k === 'chrome') opts.chrome = v
    else if (k === 'only') opts.only = v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
    else if (k === 'help' || k === 'h') {
      console.log('usage: node scripts/video/make-figures.mjs [base-url] [--out=DIR] [--chrome=PATH] [--only=F1,F2,F3,F4]')
      process.exit(0)
    } else throw new Error(`unknown option --${k}`)
  }
  opts.base = opts.base.replace(/#.*$/, '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(opts.base)) throw new Error(`base URL must be http(s): ${opts.base}`)
  const bad = (opts.only ?? []).filter((f) => !FIGURES.includes(f))
  if (bad.length) throw new Error(`--only: no figure ${bad.join(', ')} (have ${FIGURES.join(', ')})`)
  return opts
}

// ---- helpers --------------------------------------------------------------------------------------

const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a)
const mb = (bytes) => (bytes / MB).toFixed(2)

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * MB })
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}\n${r.stderr}`)
  return r.stdout
}

function pngSize(file) {
  const b = readFileSync(file)
  if (b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function gifInfo(file) {
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate:format=duration', '-of', 'json', file]))
  const s = j.streams[0]
  return { width: s.width, height: s.height, frames: Number(s.nb_read_frames), duration: Number(j.format.duration) }
}

function shot(id) {
  const s = SHOTS.find((x) => x.id === id)
  if (!s) throw new Error(`storyboard.mjs has no shot ${id}`)
  return s
}

/** The page is the app, with its shell and comms rendered (same predicate as make-video.mjs). */
function appReady() {
  const owlt = document.querySelector('.lf-comms-owlt .lf-num')?.textContent ?? ''
  return document.readyState === 'complete' && !!document.querySelector('main') && /\d/.test(owlt)
}

/** Text of the mission bar's environment and link cells (for the F3 labels and captions). */
function readBar() {
  const q = (s) => document.querySelector(s)
  const sel = q('.lf-mb-env select')
  return {
    env: sel?.value ?? null,
    envLabel: sel?.selectedOptions?.[0]?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    crew: q('.lf-mb-crew select')?.value ?? null,
    link: q('.lf-comms-link')?.textContent.trim() ?? null,
    owlt: q('.lf-comms-owlt .lf-num')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    href: location.href,
  }
}

/** Bounding box (document CSS px) of the union of the elements a selector list matches; null if none. */
function unionRect(selectors, textRe) {
  let L = Infinity
  let T = Infinity
  let R = -Infinity
  let B = -Infinity
  for (const sel of selectors) {
    const els = [...document.querySelectorAll(sel)].filter((e) => !textRe || new RegExp(textRe, 'i').test(e.textContent))
    const el = els[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    L = Math.min(L, r.left + window.scrollX)
    T = Math.min(T, r.top + window.scrollY)
    R = Math.max(R, r.right + window.scrollX)
    B = Math.max(B, r.bottom + window.scrollY)
  }
  return L < R ? { x: L, y: T, w: R - L, h: B - T } : null
}

/**
 * Element screenshot at FIGURE_DSF: scroll the region just below the sticky mission bar, grow the viewport
 * if the region is taller than what is left of it, and clip (document coordinates, padded).
 */
async function shootRegion(page, selectors, file, { textRe = null, pad = 16, padTop = pad, padBottom = pad } = {}) {
  const rect0 = await page.call(unionRect, selectors, textRe)
  if (!rect0) throw new Error(`${relative(REPO, file)}: nothing matches ${selectors.join(' + ')}`)
  const bar = await page.call(() => Math.ceil(document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0))
  const height = Math.max(HEIGHT, Math.ceil(rect0.h + bar + padTop + padBottom + 48))
  await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height, deviceScaleFactor: FIGURE_DSF, mobile: false })
  await page.painted(3)
  await page.call((top) => (window.scrollTo({ top, left: 0, behavior: 'instant' }), true), Math.max(0, Math.floor((await page.call(unionRect, selectors, textRe)).y - bar - padTop - 24)))
  await page.painted(3)
  const r = await page.call(unionRect, selectors, textRe)
  const clip = { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - padTop)), width: Math.ceil(r.w + 2 * pad), height: Math.ceil(r.h + padTop + padBottom), scale: 1 }
  const res = await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })
  writeFileSync(file, Buffer.from(res.data, 'base64'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  return { file, clipCss: clip, ...pngSize(file) }
}

/**
 * Put a label strip right above an element, for F3: the app's own eyebrow style, on the background behind the
 * element, as wide as the element plus `side` px each way (the figure's side padding). `words` print in the
 * eyebrow's capitals; `value` keeps the app's own case (19 min 51 s).
 */
function labelAbove(sel, textRe, words, value, side) {
  const el = [...document.querySelectorAll(sel)].find((e) => new RegExp(textRe, 'i').test(e.textContent))
  if (!el) return null
  document.querySelector('[data-lf-figure-label]')?.remove()
  let bg = 'rgba(0, 0, 0, 0)'
  for (let p = el.parentElement; p && /rgba\(0, 0, 0, 0\)|transparent/.test(bg); p = p.parentElement) bg = getComputedStyle(p).backgroundColor
  const r = el.getBoundingClientRect()
  const tag = document.createElement('p')
  tag.className = 'lf-eyebrow'
  tag.dataset.lfFigureLabel = ''
  const w = document.createElement('span')
  w.textContent = words
  const v = document.createElement('span')
  v.textContent = value
  v.style.textTransform = 'none'
  tag.append(w, v)
  const fill = /rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? getComputedStyle(document.body).backgroundColor : bg
  // 8 px taller than it looks: the figure's clip starts 4 px inside it (no sliver of what is above)
  Object.assign(tag.style, {
    position: 'absolute', margin: '0', maxWidth: 'none', boxSizing: 'border-box', left: `${r.left + window.scrollX - side}px`, width: `${r.width + 2 * side}px`,
    top: `${r.top + window.scrollY - 52}px`, height: '52px', display: 'flex', alignItems: 'center', gap: '0.6em', padding: `4px ${side}px 4px`,
    background: fill, color: 'var(--lf-text, #fff)', zIndex: '5',
  })
  document.body.appendChild(tag)
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(fill)
  return { text: tag.textContent, background: m ? `0x${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : '0x17171b' }
}

// ---- main ------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const want = (f) => !opts.only || opts.only.includes(f)
  if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('ffmpeg is required on PATH')
  if (!existsSync(opts.chrome)) throw new Error(`Chrome not found at ${opts.chrome} (set --chrome=PATH or CHROME)`)
  const out = opts.out
  const work = join(out, 'work')
  mkdirSync(work, { recursive: true })
  log(`base ${opts.base} · figures ${(opts.only ?? FIGURES).join(', ')} · out ${relative(REPO, out) || out}`)

  const facts = {}
  const checkMap = new Map()
  const ctx = {
    facts,
    fact: (k, v) => (facts[k] = v),
    assert: (ok, claim, evidence) => {
      const seen = checkMap.has(claim)
      checkMap.set(claim, { ok: !!ok, claim, evidence })
      if (!ok) throw new Error(`claim not supported by the app: ${claim}\n  saw: ${JSON.stringify(evidence)}`)
      if (!seen) log(`  ok  ${claim}`)
    },
    warn: (w) => log(`  WARN ${w}`),
  }
  /** Which figure ran which claims (each figure's checks are its video shot's). */
  const checksOf = {}
  const track = async (fig, fn) => {
    const before = new Set(checkMap.keys())
    const r = await fn()
    checksOf[fig] = [...checkMap.keys()].filter((k) => !before.has(k) || (checksOf[fig] ?? []).includes(k))
    return r
  }
  const outputs = {}

  // F1 first: make-video.mjs runs its own Chrome (the hero shot, with factsPass and the hero checks).
  if (want('F1')) {
    const videoOut = join(work, 'video')
    rmSync(videoOut, { recursive: true, force: true })
    log('F1: make-video.mjs --only=hero (the video pipeline, its checks and its frozen clock)')
    const code = await new Promise((res) => {
      const p = spawn(process.execPath, [join(HERE, 'make-video.mjs'), opts.base, '--only=hero', `--out=${videoOut}`, '--keep-master', `--chrome=${opts.chrome}`], { stdio: ['ignore', 'pipe', 'pipe'] })
      const fwd = (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`    | ${l}`))
      p.stdout.on('data', fwd)
      p.stderr.on('data', fwd)
      p.on('exit', res)
    })
    if (code !== 0) throw new Error(`F1: make-video.mjs --only=hero exited ${code}`)
    const pf = JSON.parse(readFileSync(join(videoOut, 'work', 'preview-facts.json'), 'utf8'))
    for (const c of pf.checks) {
      if (!c.ok) throw new Error(`F1: make-video check failed: ${c.claim}`)
      checkMap.set(c.claim, c)
    }
    checksOf.F1 = pf.checks.map((c) => c.claim)
    for (const [k, v] of Object.entries(pf.facts)) facts[k] = v
    facts.F1 = { chrome: pf.chrome, metStart: pf.timeline?.[0]?.metStart ?? null, caption: pf.timeline?.[0]?.caption ?? null }
    const master = join(videoOut, 'work', 'preview-master.mkv')
    const still = join(videoOut, 'work', 'still-2-hero-dual-counter.png')
    if (!existsSync(master) || !existsSync(still)) throw new Error('F1: make-video left no master or no hero still')

    // GIF: fps 12, 960 px wide, one palette for the clip; fewer colours only if it would reach 4 MB
    const gif = join(out, 'F1-dual-counter.gif')
    const ladder = [
      { colors: 256, dither: 'bayer:bayer_scale=5' },
      { colors: 128, dither: 'bayer:bayer_scale=5' },
      { colors: 64, dither: 'none' },
    ]
    let used = null
    for (const step of ladder) {
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', master, '-vf',
        `fps=${LIMITS.gifFps},scale=${LIMITS.gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${step.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${step.dither}:diff_mode=rectangle`,
        '-loop', '0', gif])
      used = step
      if (statSync(gif).size < LIMITS.gifMaxMB * MB) break
    }
    const g = gifInfo(gif)
    outputs.F1 = { gif: { file: 'F1-dual-counter.gif', bytes: statSync(gif).size, MB: mb(statSync(gif).size), ...g, palette: used } }
    copyFileSync(still, join(out, 'F1-dual-counter.png'))
    outputs.F1.png = { file: 'F1-dual-counter.png', bytes: statSync(join(out, 'F1-dual-counter.png')).size, MB: mb(statSync(join(out, 'F1-dual-counter.png')).size), ...pngSize(still) }

    // og.png: the link-preview crop of the same claim-checked still
    const og = join(out, 'og.png')
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', still, '-vf', `crop=${OG_CROP.w}:${OG_CROP.h}:${OG_CROP.x}:${OG_CROP.y},scale=${LIMITS.ogWidth}:${LIMITS.ogHeight}:flags=lanczos`, '-frames:v', '1', og])
    outputs.og = { file: 'og.png', bytes: statSync(og).size, MB: mb(statSync(og).size), ...pngSize(og), crop: OG_CROP }
    log(`F1: GIF ${g.width}x${g.height}, ${g.frames} frames, ${outputs.F1.gif.MB} MB (palette ${used.colors}); PNG ${outputs.F1.png.width}x${outputs.F1.png.height}; og.png ${outputs.og.width}x${outputs.og.height}`)
  }

  const needBrowser = ['F2', 'F3', 'F4'].some(want)
  if (needBrowser || !want('F1')) {
    const { browser, close } = await launchChrome({ chromePath: opts.chrome, width: WIDTH, height: HEIGHT })
    const openApp = async (route) => {
      const page = await browser.newPage({ width: WIDTH, height: HEIGHT })
      await page.goto(`${opts.base}/${route}`)
      await page.waitUntil(appReady, [], { what: `${route}: app shell and comms`, timeoutMs: 45000 })
      await page.eval('document.fonts.ready.then(() => true)')
      return page
    }
    try {
      // the card facts (light time, replayed event, gap) and their checks, as the video reads them
      if (!want('F1')) {
        log('facts: factsPass() of the storyboard')
        await factsPass(openApp, ctx)
      }

      if (want('F2')) {
        await track('F2', async () => {
          const s = shot('case')
          const route = '#/case/spe_shelter?env=mars_surface'
          log(`F2: ${route} (checks of shot "${s.id}")`)
          const page = await openApp(route)
          try {
            await page.waitUntil(s.ready, [], { what: 'F2: the case page', timeoutMs: 45000 })
            if (s.check) await s.check(page, ctx)
            if (s.prepare) await s.prepare(page, ctx)
            await page.call(() => {
              const d = document.querySelector('details.lf-expander')
              if (!d.open) d.querySelector('summary').click()
              return true
            })
            await page.waitUntil(() => document.querySelector('details.lf-expander')?.open === true, [], { what: 'F2: Why this fired is open' })
            await page.painted(3)
            const bar = await page.call(readBar)
            const why = await page.call(() => {
              const d = document.querySelector('details.lf-expander')
              const t = d.innerText.replace(/\s+/g, ' ').trim()
              const norm = (x) => x.replace(/[\s\u200b\u2009\u202f]+/g, ' ').replace(/\s+\)/g, ')').trim()
              // the dl grid: dt label, dd number(s) and unit; the out-of-limit arrow and screen-reader words dropped
              const grid = [...d.querySelectorAll('dl.lfc-why-grid > div')].map((row) => {
                const dd = row.querySelector('dd')?.cloneNode(true)
                dd?.querySelectorAll('.lf-num-arrow, .sr-only').forEach((x) => x.remove())
                return { label: norm(row.querySelector('dt')?.textContent ?? ''), value: norm(dd?.textContent ?? '') }
              })
              const cell = (re) => grid.find((g) => re.test(g.label))?.value ?? null
              return { text: t, grid, value: cell(/^Value/), limit: cell(/^Limit/), limitLabel: grid.find((g) => g.label.startsWith('Limit'))?.label ?? null, margin: cell(/^Margin/), requirement: /\[V2 6164\]/.exec(t)?.[0] ?? null, quote: /when radiation exposure rates exceed predefined thresholds/.exec(t)?.[0] ?? null }
            })
            ctx.fact('F2', { route, bar, why })
            ctx.assert(bar.env === 'mars_surface', 'F2: the deep link opens the shelter case at the Mars surface base', bar)
            ctx.assert(!!why.value && !!why.limit && !!why.margin, 'F2: the panel shows a value, a limit and a margin', why.grid)
            ctx.assert(/\bdesign choice\b/i.test(why.text) && /^Design choice: /m.test(why.text.replace(/^.*?(Design choice: )/s, '$1')), "F2 caption: the threshold applied at Mars is labelled a design choice (the panel's chip and basis)", why.text.slice(0, 240))
            outputs.F2 = { ...(await shootRegion(page, ['details.lf-expander'], join(out, 'F2-why-this-fired.png'), { pad: 16, padTop: 6 })), file: 'F2-why-this-fired.png' }
          } finally {
            await page.close()
          }
        })
        outputs.F2.bytes = statSync(join(out, outputs.F2.file)).size
        outputs.F2.MB = mb(outputs.F2.bytes)
        log(`F2: ${outputs.F2.width}x${outputs.F2.height}, ${outputs.F2.MB} MB`)
      }

      if (want('F3')) {
        await track('F3', async () => {
          const s = shot('flip')
          const VO2 = { sel: 'li.lf-limit[data-applicable]', text: 'VO2max floor' }
          const parts = []
          for (const env of ['mars_surface', 'iss']) {
            const route = `#/body?env=${env}&crew=CM-2&region=heart`
            log(`F3: ${route} (checks of shot "${s.id}": ${env === 'iss' ? 'after' : 'prepare'})`)
            const page = await openApp(route)
            try {
              await page.waitUntil(s.ready, [], { what: `F3 ${env}: the body map`, timeoutMs: 45000 })
              await page.waitUntil(() => [...document.querySelectorAll('li.lf-limit[data-applicable] .lf-limit-label')].some((x) => /VO2max/i.test(x.textContent)), [], { what: `F3 ${env}: CM-2's VO2max card` })
              const bar = await page.call(readBar)
              ctx.assert(bar.env === env && bar.crew === 'CM-2', `F3: the deep link ${route} opens ${env} for CM-2 with no click`, bar)
              // Mars: the shot's own opening checks; ISS: its closing checks (same reading, other floor, link up)
              if (env === 'mars_surface') await s.prepare(page, ctx)
              else await s.after(page, ctx)
              const label = `${bar.envLabel} · link ${bar.link} · one-way light time ${bar.owlt}`
              ctx.fact(`F3.${env}`, { route, bar, label, card: facts[env === 'iss' ? 'flip.iss' : 'flip.mars'] })
              const SIDE = 12
              const tag = await page.call(labelAbove, VO2.sel, VO2.text, `${bar.envLabel} · link ${bar.link} · one-way light time`, bar.owlt, SIDE)
              if (!tag) throw new Error(`F3 ${env}: no VO2max card to label`)
              const file = join(work, `F3-${env}.png`)
              const shotInfo = await shootRegion(page, [VO2.sel, '[data-lf-figure-label]'], file, { textRe: null, pad: SIDE, padTop: -4, padBottom: 6 })
              parts.push({ env, background: tag.background, ...shotInfo })
            } finally {
              await page.close()
            }
          }
          // side by side, tops aligned, a 24 px gap; padding in the panel's own background colour
          const H = Math.max(...parts.map((p) => p.height))
          const gap = 24 * FIGURE_DSF
          const color = parts[0].background
          const f3 = join(out, 'F3-vo2max-mars-iss.png')
          run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', parts[0].file, '-i', parts[1].file, '-filter_complex',
            `[0:v]pad=iw+${gap}:${H}:0:0:color=${color}[a];[1:v]pad=iw:${H}:0:0:color=${parts[1].background}[b];[a][b]hstack=inputs=2`, '-frames:v', '1', f3])
          outputs.F3 = { file: 'F3-vo2max-mars-iss.png', ...pngSize(f3), parts: parts.map((p) => ({ env: p.env, width: p.width, height: p.height })) }
        })
        outputs.F3.bytes = statSync(join(out, outputs.F3.file)).size
        outputs.F3.MB = mb(outputs.F3.bytes)
        log(`F3: ${outputs.F3.width}x${outputs.F3.height}, ${outputs.F3.MB} MB`)
      }

      if (want('F4')) {
        await track('F4', async () => {
          const s = shot('provenance')
          const route = '#/provenance'
          log(`F4: ${route} (checks of shot "${s.id}")`)
          const page = await openApp(route)
          try {
            await page.waitUntil(s.ready, [], { what: 'F4: the provenance page', timeoutMs: 45000 })
            if (s.check) await s.check(page, ctx)
            if (s.prepare) await s.prepare(page, ctx)
            const summary = await page.call(() => {
              const sec = document.querySelector('section.prov-summary')
              const num = (el) => el?.textContent.replace(/[\s,  ]/g, '') ?? null
              const sub = sec?.querySelector('.prov-total .prov-sub')?.textContent.replace(/\s+/g, ' ').trim() ?? ''
              const m = /([\d,]+) numeric constants and ([\d,]+) severity-mapping rows/.exec(sub)
              return {
                total: num(sec?.querySelector('.prov-total-n')),
                constants: m?.[1] ?? null,
                mappings: m?.[2] ?? null,
                chips: [...(sec?.querySelectorAll('button.prov-chipbtn') ?? [])].map((b) => ({ chip: b.dataset.chip, count: num(b.querySelector('.prov-chipbtn-n')) })),
                lead: document.querySelector('.prov-lead')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
              }
            })
            ctx.fact('F4', { route, summary })
            const sum = summary.chips.reduce((n, c) => n + Number(c.count), 0)
            ctx.assert(Number(summary.total) > 0 && sum === Number(summary.total), 'F4: the per-chip counts add up to the entries in the rules', { total: summary.total, sum })
            outputs.F4 = { ...(await shootRegion(page, ['header.prov-head', 'section.prov-summary'], join(out, 'F4-provenance-summary.png'))), file: 'F4-provenance-summary.png' }
          } finally {
            await page.close()
          }
        })
        outputs.F4.bytes = statSync(join(out, outputs.F4.file)).size
        outputs.F4.MB = mb(outputs.F4.bytes)
        log(`F4: ${outputs.F4.width}x${outputs.F4.height}, ${outputs.F4.MB} MB`)
      }
    } finally {
      await close()
    }
  }

  // ---- limits ----
  const problems = []
  for (const [fig, o] of Object.entries(outputs)) {
    for (const f of [o, o.gif, o.png].filter((x) => x?.file)) if (f.bytes >= LIMITS.fileMaxMB * MB) problems.push(`${f.file} is ${mb(f.bytes)} MB (limit ${LIMITS.fileMaxMB} MB)`)
    if (fig === 'F1' && o.gif.bytes >= LIMITS.gifMaxMB * MB) problems.push(`F1 GIF is ${o.gif.MB} MB (limit ${LIMITS.gifMaxMB} MB)`)
    if (fig === 'og' && (o.width !== LIMITS.ogWidth || o.height !== LIMITS.ogHeight)) problems.push(`og.png is ${o.width}x${o.height}`)
  }

  // ---- facts-figures.json, then figures.md built from it ----
  const report = {
    generatedAt: new Date().toISOString(),
    base: opts.base,
    publicUrl: PUBLIC_URL,
    limits: LIMITS,
    figureDsf: FIGURE_DSF,
    outputs,
    checks: [...checkMap.values()],
    checksOf,
    /** How many checks each figure ran (figures.md prints these counts). */
    checkCounts: Object.fromEntries(Object.entries(checksOf).map(([k, v]) => [k, v.length])),
    facts,
  }
  writeFileSync(join(out, 'facts-figures.json'), `${JSON.stringify(report, null, 2)}\n`)
  const { md, prose } = figuresMd(report, (opts.only ?? FIGURES).filter((f) => outputs[f]))
  writeFileSync(join(out, 'figures.md'), md)

  // every number figures.md prints is in facts-figures.json; captions and alt text only use app facts
  const all = JSON.stringify(report)
  const appFacts = JSON.stringify(report.facts)
  const numbers = (s) => [...new Set(s.match(/\d+(?:[.,]\d+)*/g) ?? [])]
  // a whole number, not a piece of a longer one ("30" is not held by "1305" or "0.30")
  const holds = (hay, n) => new RegExp(`(?<![\\d.,])${n.replace(/[.]/g, '\\.')}(?![\\d]|[.,]\\d)`).test(hay)
  const missing = numbers(md).filter((n) => !holds(all, n))
  const notFromApp = numbers(prose).filter((n) => !holds(appFacts, n))
  if (missing.length) problems.push(`figures.md prints numbers that facts-figures.json does not hold: ${missing.join(', ')}`)
  if (notFromApp.length) problems.push(`captions or alt text print numbers that the app did not show: ${notFromApp.join(', ')}`)

  log(`checks: ${report.checks.filter((c) => c.ok).length}/${report.checks.length} claims confirmed against the app`)
  for (const [fig, o] of Object.entries(outputs)) for (const f of [o, o.gif, o.png].filter((x) => x?.file)) log(`${fig.padEnd(3)} ${relative(REPO, join(out, f.file))}  ${f.width}x${f.height}  ${f.MB} MB`)
  log(`figures.md: ${relative(REPO, join(out, 'figures.md'))} (${numbers(md).length} distinct numbers, all in facts-figures.json: ${missing.length === 0})`)
  if (problems.length) throw new Error(problems.join('; '))
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}

// ---- figures.md ------------------------------------------------------------------------------------

/** Alt text, caption and deep link per figure, every number taken from report.facts. */
function figuresMd(report, figs) {
  const f = report.facts
  const o = report.outputs
  const url = report.publicUrl
  const blocks = []
  const prose = []
  const add = (id, title, files, alt, caption, links, note) => {
    prose.push(alt, caption)
    blocks.push([
      `## ${id}. ${title}`,
      '',
      ...files.map((x) => `- \`${x.file}\`: ${x.width} x ${x.height} px, ${x.MB} MB${x.frames ? `, ${x.frames} frames at ${report.limits.gifFps} fps` : ''}`),
      '',
      `**Alt text.** ${alt}`,
      '',
      `**Caption.** ${caption}`,
      '',
      `**Reproduce.** ${links.map((l) => `<${url}/${l}>`).join(' and ')}${note ? ` (${note})` : ''}`,
      '',
      `**Checks run before it was written** (${report.checkCounts[id] ?? 0}): ${(report.checksOf[id] ?? []).join('; ')}.`,
      '',
    ].join('\n'))
  }
  if (figs.includes('F1')) {
    const h = f.hero ?? {}
    const earliest = /Earliest reply ([^(·|]+?)\s*\(/.exec(h.houston ?? '')?.[1]?.trim() ?? null
    // the number the last frame shows (the storyboard checks it is the real-clock measurement of this visit)
    const latency = (f['hero.end']?.guidance ?? '').replace(/\s*s$/, ' s')
    add('F1', 'Ask Houston, or act onboard', [o.F1.gif, o.F1.png],
      `Animated screen capture of LANDFALL's Now view at a Mars surface base during a solar conjunction. On the left, Ask Houston counts up the round trip, then turns "${h.queued}"; on the right, the LANDFALL onboard card shows "Guidance on screen in ${latency}" and the action "${h.action}". A caption names the real data: JPL Horizons light time and the ${f.heroData?.replayOf}. Crew data is simulated.`,
      `Houston's earliest reply is ${earliest}; LANDFALL's guidance was on screen in ${latency}, measured in the capture browser. The one-way light time, ${f.missionBar?.owlt}, comes from the JPL Horizons ephemeris; the proton flux is a time-shifted replay of the ${f.heroData?.replayOf}. Simulated crew.`,
      ['#/'], 'the counter plays on load; Replay restarts it')
  }
  if (figs.includes('F2')) {
    const w = f.F2?.why ?? {}
    add('F2', 'Why this fired', [o.F2],
      `The opened "Why this fired" panel of LANDFALL's solar particle event shelter case at the Mars surface base: value ${w.value}, limit ${w.limit} (${(w.limitLabel ?? '').replace(/^Limit\s*/, '').replace(/^\((.*)\)$/, '$1')}), margin ${w.margin}, marked outside the limit; then the rule's basis, which quotes ${w.requirement}: "${w.quote}".`,
      `Every finding explains itself: the reading (${w.value}), the limit (${w.limit}), the margin (${w.margin}), and the NASA requirement behind the rule, ${w.requirement}, in its own words. Here the threshold applied at Mars is labelled a design choice.`,
      [f.F2?.route ?? '#/case/spe_shelter'], 'open "Why this fired" under Detect')
  }
  if (figs.includes('F3')) {
    const m = f['F3.mars_surface'] ?? {}
    const i = f['F3.iss'] ?? {}
    const floor = (card) => /(\d+(?:\.\d+)?)\s*ml\/min\/kg/.exec(card?.rule ?? '')?.[1] ?? null
    const req = (card) => /\[(V1 \d+)\]/.exec(card?.source ?? '')?.[1] ?? null
    const reading = /Latest\s+(\d+(?:\.\d+)?)\s*ml\/min\/kg/.exec(m.card?.latest ?? '')?.[1] ?? null
    add('F3', "One reading, two floors: CM-2's VO2max at Mars and at ISS", [o.F3],
      `Two copies of the same body-map card side by side. Left, labelled "${m.label}": VO2max floor for surface EVAs, ${(m.card?.status ?? '').toLowerCase()}, at or above ${floor(m.card)} ml/min/kg [${req(m.card)}]. Right, labelled "${i.label}": VO2max floor for microgravity EVAs, ${(i.card?.status ?? '').toLowerCase()}, at or above ${floor(i.card)} ml/min/kg [${req(i.card)}]. Both show the same latest reading, ${reading} ml/min/kg.`,
      `The same simulated reading, ${reading} ml/min/kg, misses NASA's surface-EVA floor (${floor(m.card)}, [${req(m.card)}]) at the Mars base and meets the microgravity-EVA floor (${floor(i.card)}, [${req(i.card)}]) at ISS. Only the environment changed; each half opens from its own link. The label strip above each card repeats the mission bar's environment and link.`,
      [m.route, i.route].filter(Boolean))
  }
  if (figs.includes('F4')) {
    const s = f.F4?.summary ?? {}
    const chips = (s.chips ?? []).map((c) => `${c.chip} ${c.count}`).join(', ')
    add('F4', 'Provenance: every number and its basis', [o.F4],
      `The top of LANDFALL's Provenance page: "${s.lead}" Below, ${s.total} entries in the rules (${s.constants} numeric constants and ${s.mappings} severity-mapping rows) and a count per chip: ${chips}.`,
      `${s.total} entries in the rules, each with a chip that names its basis: ${chips}. The ones with no published basis are listed as ours.`,
      [f.F4?.route ?? '#/provenance'], 'select a chip to filter the table')
  }
  const files = Object.values(report.outputs).flatMap((x) => [x, x.gif, x.png]).filter((x) => x?.file)
  const md = [
    '# LANDFALL figures for the project page',
    '',
    `Captured from ${report.base} on ${report.generatedAt} by \`scripts/video/make-figures.mjs\` (public URL ${report.publicUrl}). Every number in the alt text and captions was read from the app in this run (\`facts-figures.json\`), and each figure passed the claim checks of its shot in the demo video before it was written. Images are PNG or GIF, each under ${report.limits.fileMaxMB} MB (the project page accepts JPG, PNG and GIF up to that size); the GIF is under ${report.limits.gifMaxMB} MB. Element figures are captured at ${report.figureDsf} device pixels per CSS pixel.`,
    '',
    '| File | Pixels | MB |',
    '|---|---|---|',
    ...files.map((x) => `| \`${x.file}\` | ${x.width} x ${x.height} | ${x.MB} |`),
    '',
    o.og ? `\`og.png\` (${o.og.width} x ${o.og.height}) is the link-preview crop of F1's still: copy it to \`web/public/og.png\` after the final capture.\n` : '',
    ...blocks,
  ].join('\n')
  return { md, prose: prose.join('\n') }
}

main().catch((e) => {
  console.error(`\nmake-figures failed: ${e.message}`)
  process.exit(1)
})
