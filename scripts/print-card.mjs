#!/usr/bin/env node
// Print LANDFALL's paper cue cards ([V2 10130]) to PDF over the Chrome DevTools Protocol (Page.printToPDF), no
// dependencies (Node >= 22: global WebSocket), the same pattern as scripts/qa-mobile.mjs.
//
//   node scripts/print-card.mjs <base-url> [--tmp=DIR] [--docs=DIR] [--margin=0.4] [--query=basis=inline]
//
//   1. Every case's card, #/card/<id>, at US Letter and at A4  -> <tmp>/landfall-cue-card-<id>-<letter|a4>.pdf
//   2. The binder, #/cards, at Letter and at A4                 -> <tmp>/landfall-cue-card-binder-<letter|a4>.pdf
//      and the Letter binder to <docs>/landfall-cue-card.pdf, with a PNG of its first page, <docs>/landfall-cue-card.png.
//   Defaults: --tmp=/tmp/landfall-cue-cards, --docs=<repo>/docs, --margin=0.4 (inches, every side; Chrome's default).
//
// Checks (exit 1 on any failure), with pdfinfo and pdftotext (poppler):
//   - each card is exactly 1 page at Letter and at A4, and the binder one page per case, each page one card;
//   - each PDF's text holds every procedure step of its case(s), verbatim, read from this checkout's
//     engine/rules/cases.json (whitespace ignored, so line breaks do not matter). The text is read with
//     `pdftotext -raw` (content-stream order, which is Chrome's paint order): the default mode's reading-order
//     heuristics can split a line into one word per line next to a step number, and drop a line-end hyphen;
//   - no nav, mission-bar, app-footer or on-screen intro text is printed;
//   - the rules digest printed is the digest of this checkout's rules (a stale deploy fails);
//   - under print media every text element of the paper computes to at least 10 pt.
// Run it against the deployed URL after the final deploy.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const opt = (name, dflt) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const base = (args.find((a) => !a.startsWith('--')) ?? 'http://localhost:4812').replace(/\/+$/, '')
const TMP = opt('tmp', join(tmpdir(), 'landfall-cue-cards'))
const DOCS = opt('docs', join(REPO, 'docs'))
const MARGIN = Number(opt('margin', '0.4'))
/** Extra query for every card route, e.g. --query=basis=inline (where the trigger bases print). */
const QUERY = opt('query', '')
const SIZES = [
  { id: 'letter', label: 'US Letter', width: 8.5, height: 11 },
  { id: 'a4', label: 'A4', width: 210 / 25.4, height: 297 / 25.4 },
]
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- ground truth from this checkout ---------------------------------------------------------------------
const rulesFile = (name) => JSON.parse(readFileSync(join(REPO, 'engine', 'rules', `${name}.json`), 'utf8'))
const RULE_FILE_ORDER = ['environments', 'thresholds', 'personal', 'cases', 'meta'] // web/src/features/cuecard/model.ts
const canon = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canon).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
const DIGEST = createHash('sha256').update(canon(RULE_FILE_ORDER.map(rulesFile)), 'utf8').digest('hex')
const CASES = rulesFile('cases').cases
const squash = (s) => s.replace(/\s+/g, '')

// ---- poppler ---------------------------------------------------------------------------------------------
const have = (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0
for (const bin of ['pdfinfo', 'pdftotext']) {
  if (!have(bin)) {
    console.error(`FAIL: ${bin} not found (poppler: brew install poppler)`)
    process.exit(2)
  }
}
const pdfPages = (file) => Number(/^Pages:\s+(\d+)/m.exec(spawnSync('pdfinfo', [file], { encoding: 'utf8' }).stdout)?.[1] ?? NaN)
const pdfText = (file, page) =>
  spawnSync('pdftotext', ['-raw', '-enc', 'UTF-8', ...(page ? ['-f', String(page), '-l', String(page)] : []), file, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout

// ---- Chrome ----------------------------------------------------------------------------------------------
const port = 9300 + Math.floor(Math.random() * 500)
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lf-print-'))}`, 'about:blank'], { stdio: 'ignore' })
const watchdog = setTimeout(() => { console.error('FAIL: print-card timed out after 5 min'); chrome.kill(); process.exit(2) }, 300_000)

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* chrome still starting */ }
    await sleep(200)
  }
  throw new Error('Chrome did not expose a page target')
}
const ws = new WebSocket(await target())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(expression, ms, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(expression).catch(() => false)) return
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

/** Open a cue card route and wait until its cards, digest, quote and fonts are in. */
async function open(route, caseIds) {
  await send('Page.navigate', { url: `${base}/${route}${QUERY ? `?${QUERY}` : ''}` })
  const want = JSON.stringify([...caseIds].sort())
  await waitFor(`location.hash.split('?')[0] === ${JSON.stringify(route)} && !!document.querySelector('.lf-cue[data-cuecard-ready]') && JSON.stringify([...document.querySelectorAll('.lf-cue-paper')].map((e) => e.dataset.case).sort()) === ${JSON.stringify(want)}`, 30_000, `${route} to render ${caseIds.join(', ')}`)
  await evaluate('document.fonts.ready.then(() => document.fonts.status)')
  await sleep(300)
  return evaluate(`(() => {
    const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.innerText)
    return {
      cases: [...document.querySelectorAll('.lf-cue-paper')].map((e) => e.dataset.case),
      paper: text('.lf-cue-paper').join('\\n'),
      quote: !!document.querySelector('.lf-cue-band q'),
      nav: text('.lf-nav a'),
      bar: text('.lf-missionbar').join('\\n').split(/\\n+/),
      footer: text('.lf-footer').join('\\n').split(/\\n+|(?<=\\.)\\s+/),
      intro: text('.lf-cue-screen').join('\\n').split(/\\n+/),
    }
  })()`)
}

/** Smallest computed font size (px) of any element of the paper with its own text, under print media. */
async function minPrintFontPx() {
  await send('Emulation.setEmulatedMedia', { media: 'print' })
  try {
    return await evaluate(`(() => {
      let min = Infinity, at = ''
      for (const el of document.querySelectorAll('.lf-cue-paper, .lf-cue-paper *')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
        const pseudo = ['::before', '::after'].some((p) => { const c = getComputedStyle(el, p).content; return c && c !== 'none' && c !== 'normal' && c !== '""' })
        if (!own && !pseudo) continue
        const px = parseFloat(getComputedStyle(el).fontSize)
        if (px < min) { min = px; at = el.className || el.tagName }
      }
      return { min, at: String(at) }
    })()`)
  } finally {
    await send('Emulation.setEmulatedMedia', { media: '' })
  }
}

/**
 * Room left on the page (inches): the paper's height laid out under print media at the page's content width,
 * against the page's content height. Negative = the card would spill onto a second page.
 */
async function slackIn(size) {
  const w = Math.round((size.width - 2 * MARGIN) * 96)
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setEmulatedMedia', { media: 'print' })
  try {
    await sleep(150)
    const heights = await evaluate(`[...document.querySelectorAll('.lf-cue-paper')].map((e) => e.getBoundingClientRect().height)`)
    return Math.min(...heights.map((h) => size.height - 2 * MARGIN - h / 96))
  } finally {
    await send('Emulation.setEmulatedMedia', { media: '' })
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  }
}

async function printPdf(file, size) {
  const r = await send('Page.printToPDF', {
    paperWidth: size.width, paperHeight: size.height,
    marginTop: MARGIN, marginBottom: MARGIN, marginLeft: MARGIN, marginRight: MARGIN,
    printBackground: false, displayHeaderFooter: false, preferCSSPageSize: false, scale: 1,
  })
  writeFileSync(file, Buffer.from(r.data, 'base64'))
}

const failures = []
const log = (s = '') => console.log(s)
const check = (ok, what, detail = '') => {
  if (!ok) failures.push(`${what}${detail ? `: ${detail}` : ''}`)
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`)
}

/** The checks shared by single cards and the binder. */
function checkPdf(file, label, caseIds, page) {
  const text = pdfText(file)
  const flat = squash(text)
  const steps = CASES.filter((c) => caseIds.includes(c.id)).flatMap((c) => c.procedure.map((s) => ({ id: `${c.id}/${s.id}`, text: s.text })))
  const missing = steps.filter((s) => !flat.includes(squash(s.text))).map((s) => s.id)
  check(missing.length === 0, `${label}: all ${steps.length} procedure steps printed verbatim`, missing.length ? `missing ${missing.join(', ')}` : '')
  // App chrome: a string from the nav, mission bar, footer or intro that is not itself card text must not print.
  const onPaper = squash(page.paper)
  for (const [group, list] of [['nav', page.nav], ['mission bar', page.bar], ['app footer', page.footer], ['screen intro', page.intro]]) {
    const candidates = [...new Set(list.map((s) => s.trim()).filter((s) => s.length >= 4 && !onPaper.includes(squash(s))))]
    const printed = candidates.filter((s) => flat.includes(squash(s)))
    check(candidates.length > 0 && printed.length === 0, `${label}: no ${group} text`, printed.length ? `printed: ${printed.slice(0, 4).join(' | ')}` : `${candidates.length} strings checked`)
  }
  check(flat.includes(squash(`rules ${DIGEST.slice(0, 12)}`)), `${label}: rules digest ${DIGEST.slice(0, 12)} (this checkout) printed`, flat.includes('rules') ? '' : 'no digest line')
  return text
}

let exitCode = 0
try {
  mkdirSync(TMP, { recursive: true })
  log(`LANDFALL cue cards  base=${base}  margins ${MARGIN} in  rules digest ${DIGEST.slice(0, 12)}`)
  // ---- 1. one card per case ----
  for (const c of CASES) {
    const route = `#/card/${c.id}`
    const page = await open(route, [c.id])
    check(page.quote, `${route}: [V2 10130] quote loaded from the std_vol2 snapshot`)
    const font = await minPrintFontPx()
    check(font.min >= 13.33, `${route}: smallest printed text ${(font.min * 0.75).toFixed(2)} pt (>= 10 pt)`, font.min >= 13.33 ? '' : `at ${font.at}`)
    for (const size of SIZES) {
      const file = join(TMP, `landfall-cue-card-${c.id}-${size.id}.pdf`)
      await printPdf(file, size)
      const pages = pdfPages(file)
      const slack = await slackIn(size)
      check(pages === 1, `${route} at ${size.label}: Pages ${pages} (want 1); ${slack.toFixed(2)} in left on the page`, file)
      checkPdf(file, `${route} at ${size.label}`, [c.id], page)
    }
  }
  // ---- 2. the binder ----
  const page = await open('#/cards', CASES.map((c) => c.id))
  const files = {}
  for (const size of SIZES) {
    const file = join(TMP, `landfall-cue-card-binder-${size.id}.pdf`)
    await printPdf(file, size)
    files[size.id] = file
    const pages = pdfPages(file)
    check(pages === CASES.length, `#/cards at ${size.label}: Pages ${pages} (want ${CASES.length}, one per case)`, file)
    checkPdf(file, `#/cards at ${size.label}`, CASES.map((c) => c.id), page)
    // each page holds exactly one card, in the app's binder order
    const perPage = page.cases.map((id, i) => {
      const t = squash(pdfText(file, i + 1))
      return CASES.filter((c) => t.includes(squash(c.title))).map((c) => c.id).join('+') === id
    })
    check(perPage.every(Boolean), `#/cards at ${size.label}: one card per page, in order ${page.cases.join(', ')}`)
  }
  // ---- 3. deliverables ----
  mkdirSync(DOCS, { recursive: true })
  const pdf = join(DOCS, 'landfall-cue-card.pdf')
  copyFileSync(files.letter, pdf)
  const png = join(DOCS, 'landfall-cue-card.png')
  if (have('pdftoppm')) {
    spawnSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', '-singlefile', files.letter, png.replace(/\.png$/, '')])
  } else {
    // fallback: a print-media screenshot of the first card
    await send('Emulation.setEmulatedMedia', { media: 'print' })
    await send('Emulation.setDeviceMetricsOverride', { width: 816, height: 1056, deviceScaleFactor: 2, mobile: false })
    await sleep(300)
    const r = await evaluate(`(() => { const b = document.querySelector('.lf-cue-paper').getBoundingClientRect(); return { x: 0, y: Math.max(0, b.top + scrollY - 38), width: 816, height: b.height + 76 } })()`)
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 }, captureBeyondViewport: true })
    writeFileSync(png, Buffer.from(shot.data, 'base64'))
    await send('Emulation.setEmulatedMedia', { media: '' })
  }
  log('')
  log(`binder (US Letter): ${pdf}`)
  log(`preview of page 1 (${page.cases[0]}): ${png}`)
  log(`per-size PDFs: ${TMP}`)
} catch (e) {
  failures.push(e.message)
  log(`FAIL: ${e.message}`)
} finally {
  clearTimeout(watchdog)
  ws.close()
  chrome.kill()
}
if (failures.length) exitCode = 1
log('')
log(`${exitCode ? 'FAIL' : 'PASS'}: ${failures.length ? failures.length + ' check(s) failed' : 'every card is one page at Letter and A4, the binder one page per case, every step printed, no app chrome, digest current, nothing under 10 pt'}`)
process.exit(exitCode)
