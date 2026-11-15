#!/usr/bin/env node
// Mobile layout QA over the Chrome DevTools Protocol, no dependencies (Node >= 22: global WebSocket).
// Emulates a real phone viewport (mobile: true) and reports, per route, whether the page overflows
// horizontally and which elements stick out past the viewport's right edge. A route that renders the
// not-found view fails too (a route list entry must be a real view).
//
//   node scripts/qa-mobile.mjs http://localhost:4301 [width=390] [height=844]
import { spawn } from 'node:child_process'
import { tempProfile } from './chrome-profile.mjs'

const base = process.argv[2] ?? 'http://localhost:4301'
const width = Number(process.argv[3] ?? 390)
const height = Number(process.argv[4] ?? 844)
const ROUTES = ['#/', '#/body', '#/cases', '#/case/spe_shelter', '#/case/renal_stone', '#/case/sleep_circadian',
  '#/radiation', '#/noon-sight', '#/trends', '#/downlink', '#/band', '#/provenance', '#/method', '#/data', '#/card/renal_stone']
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const port = 9300 + Math.floor(Math.random() * 500)
const profile = tempProfile('lf-qa-') // deleted on exit
const chrome = profile.own(spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
  ...profile.flags, 'about:blank'], { stdio: 'ignore' }))
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* chrome still starting */ }
    await sleep(200)
  }
  throw new Error('Chrome did not expose a page target')
}

const ws = new WebSocket(await target())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })

await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true })
await send('Runtime.enable')

const PROBE = `(() => {
  const vw = document.documentElement.clientWidth
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.position === 'fixed' && r.right <= vw + 1) continue
    if (r.right > vw + 1) {
      let p = el.parentElement, clipped = false
      while (p && p !== document.body) {
        const ps = getComputedStyle(p)
        if (/(auto|scroll|hidden|clip)/.test(ps.overflowX) && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break }
        p = p.parentElement
      }
      if (!clipped) out.push({ tag: el.tagName.toLowerCase(), cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 60), right: Math.round(r.right), text: (el.textContent || '').trim().slice(0, 40) })
    }
  }
  // A route that renders the not-found view ("No such view") is a failure even when nothing overflows.
  const main = document.querySelector('main')?.innerText || ''
  const notFound = /is not a LANDFALL route/.test(main)
  // keep only the outermost offenders
  return JSON.stringify({ vw, scrollWidth: document.documentElement.scrollWidth, offenders: out.slice(0, 12), notFound })
})()`

let failures = 0
for (const route of ROUTES) {
  await send('Page.navigate', { url: `${base}/${route}` })
  await sleep(2500)
  const res = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
  const v = JSON.parse(res.result.result.value)
  const ok = v.scrollWidth <= v.vw + 1 && v.offenders.length === 0 && !v.notFound
  if (!ok) failures++
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${route.padEnd(24)} viewport=${v.vw} scrollWidth=${v.scrollWidth}${v.notFound ? ' NOT-FOUND VIEW (not a LANDFALL route)' : ''}`)
  for (const o of v.offenders.slice(0, 6)) console.log(`       ${o.tag}.${o.cls} right=${o.right} "${o.text}"`)
}
ws.close()
chrome.kill()
process.exit(failures ? 1 : 0)
