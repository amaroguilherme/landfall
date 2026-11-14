// The LANDFALL 30-second demo, shot by shot. Edit words and timings here; make-video.mjs only
// executes this file. Rules this storyboard keeps:
//   - every claim on screen is either READ from the live app at capture time (facts) or CHECKED
//     against it (ctx.assert) before a single frame of it is written; a failed check aborts the run;
//   - no number is typed here: the only figures on screen are the app's own pixels and facts.owlt;
//   - English only, no audio, no logos, no generated imagery: app screen capture + typographic cards.
//
// Shot fields
//   kind 'card'  card(facts) -> { layout, blocks: [{ cls, text, in }] }   (scripts/video/card.html)
//   kind 'app'   route, kicker + caption (overlay), ready (page predicate), check / prepare (real
//                time, before the clock is frozen), onPaused, preroll (virtual ms before frame 0),
//                events [{ at, run }], frame(t, state) -> overlay spec, after (checks the end state)
//   overlay spec { caption: opacity, scrollY, anchor: { sel, text?, y }, ring: { sel, text?, o, pad } }
//                (text = case-insensitive regex the element's text must match)
//   stills       [{ at, name }]: PNG frames saved for review, `at` in seconds into the shot
// Functions passed to page.call() run IN THE PAGE: they must be self-contained (no closures).

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080
/** The judge-facing URL printed on the last card (independent of the capture base URL). */
export const PUBLIC_URL = 'https://landfall.landfall-web.workers.dev'
/** Hard limit for global judging is 30.0 s; the storyboard must stay at or under this. */
export const MAX_SECONDS = 29.5
/** The app's own footer, word for word (factsPass checks it against footer.lf-footer). */
// The app footer's own words (factsPass checks them word for word). No offline claim here: the app shows
// "Works offline after first load" only once its service worker holds the build.
const FOOTER = 'Not endorsed by NASA. Not a medical device: no diagnosis, no dosing. Crew data is simulated. NASA and NOAA data are real, frozen at build. No backend: everything runs in this browser.'

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const fadeIn = (t, start, dur) => clamp01((t - start) / dur)
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
/** Eased 0 -> 1 between t0 and t1. */
const ramp = (t, t0, t1) => easeInOut(clamp01((t - t0) / (t1 - t0)))
/** Highlight-ring opacity: in at `a`, out by `b`. */
const pulse = (t, a, b, f = 0.15) => Math.min(fadeIn(t, a, f), 1 - fadeIn(t, b - f, f))

// ---- page-side helpers (run in the page) -------------------------------------------------------

function clickButton(label) {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === label)
  if (!b) return false
  b.click()
  return true
}

function setSelect(selector, value) {
  const s = document.querySelector(selector)
  if (!s) return false
  s.value = value
  s.dispatchEvent(new Event('change', { bubbles: true }))
  return s.value === value
}

function missionBar() {
  const q = (s) => document.querySelector(s)
  return {
    env: q('.lf-mb-env select')?.value ?? null,
    crew: q('.lf-mb-crew select')?.value ?? null,
    link: q('.lf-comms-link')?.textContent.trim() ?? null,
    conjunction: !!q('.lf-comms-conj'),
    owlt: q('.lf-comms-owlt .lf-num')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
    annunciator: q('.lf-mb-ann')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
  }
}

/** The body map's applicable VO2max limit card (li.lf-limit[data-applicable]) and the mission bar, as text. */
function readVo2() {
  const li = [...document.querySelectorAll('li.lf-limit[data-applicable]')].find((x) => /VO2max/i.test(x.querySelector('.lf-limit-label')?.textContent ?? ''))
  const q = (s) => document.querySelector(s)
  if (!li) return null
  const txt = (s) => li.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() ?? null
  return {
    label: txt('.lf-limit-label'),
    status: txt('.lf-limit-status'),
    rule: txt('.lf-limit-rule'),
    source: txt('.lf-limit-src'),
    latest: txt('.lf-limit-now'),
    top: Math.round(li.getBoundingClientRect().top),
    env: q('.lf-mb-env select')?.value ?? null,
    link: q('.lf-comms-link')?.textContent.trim() ?? null,
    owlt: q('.lf-comms-owlt .lf-num')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  }
}

/** The VO2max limit card (verdict, floor, requirement, reading), matched by its label text. */
const VO2_CARD = { sel: 'li.lf-limit[data-applicable]', text: 'VO2max floor' }
const VO2_Y = 470

/** Scroll so the VO2max limit card's top sits at viewport y = `y`. */
function anchorVo2(y) {
  const li = [...document.querySelectorAll('li.lf-limit[data-applicable]')].find((x) => /VO2max/i.test(x.querySelector('.lf-limit-label')?.textContent ?? ''))
  if (!li) return null
  window.scrollTo({ top: Math.round(li.getBoundingClientRect().top + window.scrollY - y), left: 0, behavior: 'instant' })
  return Math.round(li.getBoundingClientRect().top)
}

// ---- the storyboard ----------------------------------------------------------------------------

export const SHOTS = [
  {
    id: 'card-title',
    kind: 'card',
    dur: 2.0,
    card: () => ({
      layout: 'brand',
      blocks: [
        { cls: 'wordmark', text: 'LANDFALL', in: -1 }, // visible on frame 0: the poster frame shows the name
        { cls: 'sub', text: 'Guilherme Amaro · NASA Space Apps Challenge 2026', in: 0.3 },
      ],
    }),
  },
  {
    id: 'card-problem',
    kind: 'card',
    dur: 3.0,
    // "Nearly twenty light-minutes", "behind the Sun" and "on its own" are checked in factsPass();
    // the kicker prints the one-way light time exactly as the app's mission bar shows it.
    card: (facts) => ({
      layout: 'statement',
      blocks: [
        { cls: 'kicker', text: `MARS SURFACE BASE · SOLAR CONJUNCTION · ONE-WAY LIGHT TIME ${facts.missionBar.owlt}`, in: 0 },
        { cls: 'line', text: 'Nearly twenty light-minutes from Earth, behind the Sun, the crew has to act on its own.', in: 0.15 },
      ],
    }),
    stills: [{ at: 2.8, name: 'still-1-problem-card' }],
  },
  {
    id: 'card-name',
    kind: 'card',
    dur: 2.5,
    card: () => ({
      layout: 'brand',
      blocks: [
        { cls: 'wordmark', text: 'LANDFALL', in: 0 },
        { cls: 'sub', text: 'Earth-independent health navigation for exploration crews', in: 0.3 },
      ],
    }),
  },

  // ---- the product: real app, fresh page per shot, app clock frozen and stepped 1/30 s per frame ----
  {
    id: 'hero',
    kind: 'app',
    dur: 5.0,
    route: '#/',
    kicker: '#/ · Now',
    caption: "Houston's reply is days away.\nLANDFALL's guidance is already on screen.",
    // the in-browser latency must be measured (in real time) before the clock is frozen
    ready: () => !!document.querySelector('.now-landfall .now-big:not([data-missing])') && !!document.querySelector('.now-dual-head button'),
    check: async (page, ctx) => {
      const v = await page.call(() => ({
        queued: document.querySelector('.now-houston .now-queued')?.textContent.trim() ?? null,
        houston: [...document.querySelectorAll('.now-houston .now-counter-sub')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
        guidance: document.querySelector('.now-landfall .now-big')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
        action: document.querySelector('.now-landfall .now-action')?.textContent.trim() ?? null,
      }))
      ctx.fact('hero', v)
      ctx.assert(/solar conjunction/i.test(v.queued ?? ''), 'hero: Ask Houston is queued by the solar conjunction', v.queued)
      const d = /Earliest reply (\d+)\s*d\b/.exec(v.houston)
      ctx.assert(!!d && Number(d[1]) >= 2, "hero caption: Houston's reply is days away", v.houston)
      ctx.assert(/^\d+\.\d+\s*s$/.test(v.guidance ?? ''), "hero caption: LANDFALL's guidance is on screen (latency measured in this browser)", v.guidance)
      ctx.assert(!!v.action, 'hero: the primary action is painted', v.action)
    },
    onPaused: async (page) => {
      // Restart the dual-counter sequence under the frozen clock (Skip first if the autoplay runs).
      let advanced = 0
      if (await page.call(clickButton, 'Skip')) {
        await page.tick(100)
        advanced += 100
      }
      if (!(await page.call(clickButton, 'Replay'))) throw new Error('hero: no Replay button on the dual counter')
      return advanced
    },
    preroll: 1500, // start 1.5 s into the 7 s sequence: the round trip is almost counted up
    frame: (t) => ({ caption: fadeIn(t, 0.1, 0.2) }),
    stills: [{ at: 4.9, name: 'still-2-hero-dual-counter' }],
  },
  {
    id: 'case',
    kind: 'app',
    dur: 3.5,
    route: '#/case/spe_shelter',
    kicker: '#/case/spe_shelter',
    caption: 'Why this fired: the reading, the limit,\nand the NASA requirement behind it.',
    ready: () => /Why this fired/.test(document.querySelector('details.lf-expander > summary')?.textContent ?? ''),
    prepare: async (page, ctx) => {
      const v = await page.call(() => {
        const d = document.querySelector('details.lf-expander')
        d.querySelector('summary').setAttribute('data-lfv', 'why')
        d.open = true
        const bottom = d.getBoundingClientRect().bottom + window.scrollY
        const text = d.innerText.replace(/\s+/g, ' ').trim()
        d.open = false
        // the CM-1..CM-4 tab row: scroll it fully under the mission bar rather than half-way
        const tabs = [...document.querySelectorAll('main a, main button')].filter((e) => /^CM-[1-4]\b/.test(e.textContent.trim()) && /DETECTED/i.test(e.textContent))
        const tabsBottom = tabs.length ? Math.max(...tabs.map((e) => e.getBoundingClientRect().bottom + window.scrollY)) : 0
        const bar = document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0
        return { bottom: Math.round(bottom), tabsBelowBar: Math.round(tabsBottom - bar + 8), text }
      })
      ctx.fact('case', { why: v.text })
      ctx.assert(/\[V2 6164\]/.test(v.text), "case caption: 'Why this fired' names the NASA requirement [V2 6164]", v.text.slice(0, 200))
      ctx.assert(/when radiation exposure rates exceed predefined thresholds/.test(v.text), "case: it quotes [V2 6164]'s own words", v.text.slice(0, 300))
      ctx.assert(/Value .*Limit .*Margin/.test(v.text) && /OUTSIDE LIMIT/.test(v.text), 'case caption: it shows the reading and the limit it crossed', v.text.slice(0, 120))
      // after opening, the whole panel clears the caption and the tab row sits under the mission bar
      return { scrollTo: Math.max(0, v.bottom - 815, v.tabsBelowBar) }
    },
    events: [{ at: 1.7, run: (page) => page.call(() => (document.querySelector('[data-lfv=why]').click(), true)) }],
    frame: (t, s) => ({
      scrollY: Math.round(s.scrollTo * ramp(t, 0.7, 1.4)),
      ring: { sel: '[data-lfv=why] > *', o: pulse(t, 1.3, 2.05), pad: 7 },
    }),
    stills: [{ at: 3.4, name: 'still-3-why-this-fired' }],
  },
  {
    id: 'flip',
    kind: 'app',
    dur: 3.0,
    route: '#/body?region=heart',
    kicker: '#/body · CM-2 Flight Engineer · heart',
    caption: "Mars → ISS: the link comes back,\nand CM-2's VO2max verdict flips.",
    ready: () => !!document.querySelector('li.lf-limit .lf-limit-label') && !!document.querySelector('.lf-mb-crew select'),
    prepare: async (page, ctx) => {
      if (!(await page.call(setSelect, '.lf-mb-crew select', 'CM-2'))) throw new Error('flip: cannot select CM-2')
      await page.waitUntil(() => /CM-2 · FLIGHT ENGINEER/i.test(document.querySelector('main')?.innerText ?? ''), [], { what: 'the body map to show CM-2' })
      await page.waitUntil(() => [...document.querySelectorAll('li.lf-limit[data-applicable] .lf-limit-label')].some((x) => /VO2max/i.test(x.textContent)), [], { what: "CM-2's VO2max limit card" })
      await page.call(anchorVo2, VO2_Y)
      const before = await page.call(readVo2)
      ctx.fact('flip.mars', before)
      ctx.assert(before?.env === 'mars_surface' && before?.link === 'LOS', 'flip: starts at Mars with the link down (LOS)', before)
      ctx.assert(/OUTSIDE LIMIT/.test(before?.status ?? '') && /36\.5/.test(before?.rule ?? '') && /V1 4002/.test(before?.source ?? ''), "flip: at Mars CM-2's VO2max is outside NASA's surface-EVA floor [V1 4002]", before)
      return {}
    },
    events: [
      {
        at: 1.05,
        run: async (page) => {
          if (!(await page.call(setSelect, '.lf-mb-env select', 'iss'))) throw new Error('flip: cannot select ISS')
          await page.call(anchorVo2, VO2_Y) // keep the card still across the re-render (frame() re-anchors every frame)
        },
      },
    ],
    // the ring shows what is clicked (ENV), then where to look (the VO2max verdict)
    frame: (t) => ({
      anchor: { ...VO2_CARD, y: VO2_Y },
      ring: t < 1.6 ? { sel: '.lf-mb-env select', o: pulse(t, 0.35, 1.6), pad: 5 } : { ...VO2_CARD, o: pulse(t, 1.65, 3.2), pad: 3 },
    }),
    after: async (page, ctx) => {
      const after = await page.call(readVo2)
      ctx.fact('flip.iss', after)
      ctx.assert(after?.env === 'iss' && after?.link === 'AOS', 'flip caption: at ISS the link comes back (AOS)', after)
      ctx.assert(/WITHIN LIMIT/.test(after?.status ?? '') && /32\.9/.test(after?.rule ?? '') && /V1 4001/.test(after?.source ?? ''), "flip caption: at ISS the same CM-2 VO2max is within NASA's microgravity-EVA floor [V1 4001]", after)
      ctx.assert(after?.latest === ctx.facts['flip.mars']?.latest, 'flip: the reading itself did not change, only the floor', { mars: ctx.facts['flip.mars']?.latest, iss: after?.latest })
    },
    stills: [{ at: 2.9, name: 'still-4-env-flip-iss' }],
  },
  {
    id: 'band',
    kind: 'app',
    dur: 1.5,
    route: '#/band',
    kicker: '#/band · hardware concept, never built',
    caption: 'The band shows what it cannot measure.',
    ready: () => !!document.querySelector('.band-lg-nmh') && [...document.querySelectorAll('svg text')].some((e) => /NOT MEASURABLE HERE/.test(e.textContent)),
    check: async (page, ctx) => {
      const v = await page.call(() => {
        const t = [...document.querySelectorAll('svg text')].find((e) => /NOT MEASURABLE HERE/.test(e.textContent))
        const r = t.getBoundingClientRect()
        return { text: t.textContent.trim(), top: Math.round(r.top), left: Math.round(r.left), concept: document.querySelector('main')?.innerText.slice(0, 80) }
      })
      ctx.fact('band', v)
      ctx.assert(v.top > 80 && v.top < 600 && v.left > 1150, 'band: the NOT MEASURABLE HERE boundary is on screen, clear of the caption', v)
    },
    frame: () => ({}),
    stills: [{ at: 1.4, name: 'still-5-band-not-measurable' }],
  },
  {
    id: 'provenance',
    kind: 'app',
    dur: 2.0,
    route: '#/provenance',
    kicker: '#/provenance',
    caption: 'Every number, its source,\nand which ones are our own choices.',
    ready: () => [...document.querySelectorAll('h2')].some((h) => /Design choices/.test(h.textContent)),
    prepare: async (page, ctx) => {
      const v = await page.call(() => {
        const main = document.querySelector('main')?.innerText ?? ''
        const h = [...document.querySelectorAll('h2')].find((x) => /Design choices/.test(x.textContent))
        return {
          intro: /Every number LANDFALL uses[^\n]*/.exec(main)?.[0] ?? null,
          oursHeading: h.textContent.trim(),
          ours: /NASA-STD-3001 publishes no numeric in-flight alert thresholds[^\n]*/.exec(main)?.[0] ?? null,
          headingTop: Math.round(h.getBoundingClientRect().top + window.scrollY),
        }
      })
      ctx.fact('provenance', v)
      ctx.assert(/Each one carries a chip that names its basis/.test(v.intro ?? ''), 'provenance caption: every number carries its source', v.intro)
      ctx.assert(/no published basis/.test(v.oursHeading) && /listed here as ours/.test(v.ours ?? ''), 'provenance caption: numbers with no published basis are listed as ours', v)
      // end with the "Design choices" heading just under the mission bar's shadow, well above the caption
      return { to: Math.max(0, Math.min(320, v.headingTop - 300)) }
    },
    frame: (t, s) => ({ scrollY: Math.round(s.to * ramp(t, 0.2, 1.75)) }),
  },
  {
    id: 'card-final',
    kind: 'card',
    dur: 7.0,
    // Claims checked in factsPass() against the provenance page and the app footer.
    card: () => ({
      layout: 'final',
      blocks: [
        { cls: 'wordmark', text: 'LANDFALL', in: 0 },
        { cls: 'claim', text: 'Every NASA limit links to the standard it came from.', in: 0.1 },
        { cls: 'claim', text: 'Every number with no published basis is labelled as ours.', in: 0.8 },
        { cls: 'url', text: PUBLIC_URL, in: 1.5 },
        { cls: 'foot', text: FOOTER, in: 2.0 },
      ],
    }),
    stills: [{ at: 6.9, name: 'still-6-final-card' }],
  },
]

// ---- facts read before any frame is written (cards need them) ----------------------------------

/** Reads the hero and the provenance page once, and checks every card claim against them. */
export async function factsPass(newAppPage, ctx) {
  const hero = await newAppPage('#/')
  try {
    await hero.waitUntil(() => !!document.querySelector('.now-landfall .now-big:not([data-missing])') && /\d/.test(document.querySelector('.lf-comms-owlt .lf-num')?.textContent ?? ''), [], { what: 'the hero to load' })
    const bar = await hero.call(missionBar)
    const page = await hero.call(() => ({
      headline: document.querySelector('main h1')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      footer: document.querySelector('footer.lf-footer')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
    }))
    ctx.fact('missionBar', bar)
    ctx.fact('heroPage', page)
    const m = /(\d+)\s*min\s*(\d+)\s*s/.exec(bar.owlt ?? '')
    const owltS = m ? Number(m[1]) * 60 + Number(m[2]) : NaN
    ctx.assert(bar.env === 'mars_surface', 'problem card: the scenario starts on the Mars surface', bar.env)
    ctx.assert(owltS >= 19 * 60 && owltS < 20 * 60, "problem card: 'Nearly twenty light-minutes' (one-way light time in the mission bar is 19 to 20 min)", bar.owlt)
    ctx.assert(bar.link === 'LOS' && bar.conjunction && /behind the Sun/.test(page.headline ?? ''), "problem card: 'behind the Sun' (LOS, solar conjunction; the hero reads 'Houston is behind the Sun')", { link: bar.link, conjunction: bar.conjunction, headline: page.headline })
    ctx.assert((page.footer ?? '').includes(FOOTER), "final card: the small print is the app's own footer, word for word", page.footer)
  } finally {
    await hero.close()
  }
  const prov = await newAppPage('#/provenance')
  try {
    await prov.waitUntil(() => [...document.querySelectorAll('h2')].some((h) => /Design choices/.test(h.textContent)), [], { what: 'the provenance page' })
    const v = await prov.call(() => {
      const main = document.querySelector('main')?.innerText ?? ''
      return {
        nasa: /NASA-published numbers open to the verbatim requirement text[^\n]*/.exec(main)?.[0] ?? null,
        ours: /Where we needed a number NASA does not publish, it is listed here as ours\./.exec(main)?.[0] ?? null,
        summary: /Summary\n([\s\S]*?)\n\n/.exec(main)?.[1]?.replace(/\s+/g, ' ') ?? null,
      }
    })
    ctx.fact('provenanceClaims', v)
    ctx.assert(!!v.nasa, "final card: 'Every NASA limit links to the standard it came from' (provenance: NASA-published numbers open to the verbatim requirement text)", v.nasa)
    ctx.assert(!!v.ours, "final card: 'Every number with no published basis is labelled as ours' (provenance: listed here as ours)", v.ours)
  } finally {
    await prov.close()
  }
}
