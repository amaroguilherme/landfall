// The LANDFALL 30-second demo, shot by shot. Edit words and timings here; make-video.mjs only
// executes this file. Rules this storyboard keeps:
//   - every claim on screen is either READ from the live app at capture time (facts) or CHECKED
//     against it (ctx.assert) before a single frame of it is written; a failed check aborts the run;
//   - no number is typed here: the only figures on screen are the app's own pixels and facts read
//     from the app or its frozen snapshots (the one-way light time, the replayed event's name, the
//     roadmap gap id);
//   - English only, no audio, no logos, no generated imagery: app screen capture + typographic cards.
//
// Shot fields
//   kind 'card'  card(facts) -> { layout, blocks: [{ cls, text, in }] }   (scripts/video/card.html)
//   kind 'app'   route, kicker + caption (overlay), ready (page predicate), check / prepare (real
//                time, before the clock is frozen), onPaused, preroll (virtual ms before frame 0),
//                events [{ at, run(page, state, ctx) }], frame(t, state) -> overlay spec, after
//                (checks the end state)
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

// ---- the two lines the Submission Guide's timed script asks for ---------------------------------
// [0:10] "share how using NASA's free and open data ... made your proposed solution possible": the hero's
// second caption names the data on screen. [0:20-0:30] "Look into the future": the final card's NEXT line.
// Both are built from facts that factsPass() reads and checks, so no year, satellite or gap id is typed here.

/** Seconds into the hero shot when its caption changes from what the counter shows to which data it runs on. */
const HERO_SWAP_S = 2.9
const HERO_KICKER = '#/ · Now'
/** "Real data: JPL Horizons light time and the / <replay_of>." (replay_of from swpc_spe_replay.json). */
export const heroDataCaption = (facts) => `Real data: JPL Horizons light time and the\n${facts.heroData.replayOf}.`
/** The future line of the final card (gap id and status from hrp_roadmap.json gap 724). */
export const futureLine = (facts) =>
  `Next: NASA's open gap ${facts.eihso301.id} asks to “establish the thresholds”.\nHere every threshold is data a program can replace.`

function setCaption(kicker, text) {
  window.__lfv.caption(kicker, text)
  return true
}

// ---- the hero's measured latency under the capture clock -----------------------------------------
// Replay restarts the dual counter AND re-measures the onboard answer. Under the frozen capture clock that
// re-measure would read whole capture steps (exactly 1/30 s), not the browser's real time. So the shot reads
// the latency the app measured on the real clock when this page loaded, clicks Replay, lets React render the
// click (the engine run reads the frozen clock), and steps the clock by exactly that latency before the
// browser paints: the frames show the measurement of this visit, and a check compares the two.

/** Virtual ms for the replayed measurement plus the realignment step: 6 frames at 30 fps (see onPaused). */
const HERO_ALIGN_MS = 200
/** Where frame 0 starts in the 7 s dual-counter sequence: the round trip is almost counted up. */
const HERO_PREROLL_MS = 1500

/** The LANDFALL card's latency as printed ("0.039 s"), or null while it is measuring. */
function guidanceText() {
  const t = document.querySelector('.now-landfall .now-big')?.textContent.replace(/\s+/g, ' ').trim() ?? ''
  return /^\d+\.\d+\s*s$/.test(t) ? t : null
}

/** Click Replay; after React has rendered the click (a microtask), step the frozen clock by `ms`, same task. */
async function replayAndStep(ms) {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Replay')
  if (!b) return false
  delete document.documentElement.dataset.onboardAnswerMs
  b.click()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  window.__lfvClock.advance(ms)
  return true
}

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
    dur: 2.0,
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
    dur: 5.5,
    route: '#/',
    kicker: HERO_KICKER,
    // two captions: what the counter shows, then (from HERO_SWAP_S, about 0:10 into the video) which
    // real data it runs on; factsPass() checks that the hero names both and reads replay_of
    caption: "Houston's reply is days away.\nLANDFALL's guidance is already on screen.",
    // the in-browser latency must be measured (in real time) before the clock is frozen: wait for the number
    // itself, since the card renders "measuring" in the same element first and check() reads it right after this
    ready: () => /^\d+\.\d+\s*s$/.test(document.querySelector('.now-landfall .now-big')?.textContent.replace(/\s+/g, ' ').trim() ?? '') && !!document.querySelector('.now-dual-head button'),
    check: async (page, ctx) => {
      const v = await page.call(() => ({
        queued: document.querySelector('.now-houston .now-queued')?.textContent.trim() ?? null,
        houston: [...document.querySelectorAll('.now-houston .now-counter-sub')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
        guidance: document.querySelector('.now-landfall .now-big')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
        action: document.querySelector('.now-landfall .now-action')?.textContent.trim() ?? null,
      }))
      ctx.fact('hero', v)
      ctx.assert(/no link/i.test(v.queued ?? '') && /solar conjunction/i.test(v.queued ?? ''), 'hero: Ask Houston has no link during the solar conjunction', v.queued)
      const d = /Earliest reply (\d+)\s*d\b/.exec(v.houston)
      ctx.assert(!!d && Number(d[1]) >= 2, "hero caption: Houston's reply is days away", v.houston)
      ctx.assert(/^\d+\.\d+\s*s$/.test(v.guidance ?? ''), "hero caption: LANDFALL's guidance is on screen (latency measured in this browser)", v.guidance)
      ctx.assert(!!v.action, 'hero: the primary action is painted', v.action)
    },
    onPaused: async (page, _state, ctx) => {
      // Restart the dual-counter sequence under the frozen clock (Skip first if the autoplay runs), keeping
      // the latency the app measured on the real clock (see replayAndStep above).
      let advanced = 0
      const before = await page.call(guidanceText)
      if (!before) throw new Error('hero: the LANDFALL card shows no measured latency before Replay')
      const ms = Math.round(parseFloat(before) * 1000)
      if (await page.call(clickButton, 'Skip')) {
        await page.tick(100)
        advanced += 100
      }
      if (!(await page.call(replayAndStep, ms))) throw new Error('hero: no Replay button on the dual counter')
      await page.waitUntil(() => document.documentElement.dataset.onboardAnswerMs !== undefined && /^\d+\.\d+\s*s$/.test(document.querySelector('.now-landfall .now-big')?.textContent.replace(/\s+/g, ' ').trim() ?? ''), [], { what: 'hero: the replayed measurement' })
      const after = await page.call(guidanceText)
      ctx.fact('hero.frames', { measuredMs: ms, before, after })
      ctx.assert(after === before, 'hero: the frames show the latency LANDFALL measured on the real clock on this visit, not a capture-clock step', { before, after })
      // One step to a fixed 200 ms, so the sequence's 16 ms timer re-arms frame-aligned whatever `ms` was,
      // then the preroll proper: frame 0 lands 1.5 s into the sequence, on the same frames every run.
      let stepped = ms
      if (ms + 16 <= HERO_ALIGN_MS) {
        await page.tick(HERO_ALIGN_MS - ms, HERO_ALIGN_MS - ms)
        stepped = HERO_ALIGN_MS
      } else ctx.warn(`hero: measured ${ms} ms, above the ${HERO_ALIGN_MS - 16} ms realignment window; the sequence may land a frame off`)
      await page.tick(Math.max(0, HERO_PREROLL_MS - stepped))
      return advanced + Math.max(HERO_PREROLL_MS, stepped)
    },
    preroll: 0, // the 1.5 s preroll runs in onPaused (above), around the replayed measurement
    events: [{ at: HERO_SWAP_S, run: (page, _state, ctx) => page.call(setCaption, HERO_KICKER, heroDataCaption(ctx.facts)) }],
    frame: (t) => ({ caption: t < HERO_SWAP_S ? Math.min(fadeIn(t, 0.1, 0.2), 1 - fadeIn(t, HERO_SWAP_S - 0.2, 0.2)) : fadeIn(t, HERO_SWAP_S, 0.2) }),
    after: async (page, ctx) => {
      const end = await page.call(guidanceText)
      ctx.fact('hero.end', { guidance: end })
      ctx.assert(end !== null && end === ctx.facts.hero?.guidance, "hero: the last frame's latency is the one measured on the real clock on this visit", { end, measured: ctx.facts.hero?.guidance })
    },
    stills: [
      { at: 2.6, name: 'still-2a-hero-caption' },
      { at: 5.4, name: 'still-2-hero-dual-counter' },
    ],
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
    // Claims checked in factsPass() against the provenance page, the app footer and the frozen roadmap
    // (the NEXT line quotes an open NASA gap; it never says LANDFALL closes it).
    card: (facts) => ({
      layout: 'final',
      blocks: [
        { cls: 'wordmark', text: 'LANDFALL', in: 0 },
        { cls: 'claim', text: 'Every NASA limit links to the standard it came from.', in: 0.1 },
        { cls: 'claim', text: 'Every number with no published basis is labelled as ours.', in: 0.8 },
        { cls: 'next', text: futureLine(facts), in: 1.6 },
        { cls: 'url', text: PUBLIC_URL, in: 2.6 },
        { cls: 'foot', text: FOOTER, in: 3.1 },
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

    // [0:10] data caption: the hero names JPL Horizons as its light-time source and labels the flux a
    // replay of the real event that the frozen snapshot names (replay_of)
    await hero.waitUntil(() => /Replay of a real event: /.test(document.querySelector('main')?.textContent ?? ''), [], { what: 'the hero replay note' })
    const data = await hero.call(async () => {
      const text = (document.querySelector('main')?.textContent ?? '').replace(/\s+/g, ' ')
      const snap = await (await fetch('/data/swpc_spe_replay.json')).json()
      return {
        horizons: /[^.]*JPL Horizons[^.]*/.exec(text)?.[0].trim() ?? null,
        replayNote: /Replay of a real event[^.]*/.exec(text)?.[0] ?? null,
        replayOf: snap?.data?.replay_of ?? null,
        replaySnapshot: snap?.id ?? null,
        replayPublisher: snap?.source?.publisher ?? null,
      }
    })
    ctx.fact('heroData', data)
    ctx.assert(!!data.horizons, "hero caption: 'Real data: JPL Horizons light time' (the hero names the JPL Horizons ephemeris as its light-time source)", data.horizons)
    ctx.assert(typeof data.replayOf === 'string' && data.replayOf.length > 0, 'hero caption: the replayed event is named by the frozen snapshot (swpc_spe_replay.json data.replay_of)', data.replayOf)
    ctx.assert((data.replayNote ?? '').includes(`Replay of a real event: ${data.replayOf}`), "hero caption: the hero itself labels the flux 'Replay of a real event: <replay_of>'", data.replayNote)

    // [0:20-0:30] future line: EIHSO-301 is open and asks to "establish the thresholds" (frozen roadmap)
    const gap = await hero.call(async () => {
      const j = await (await fetch('/data/hrp_roadmap.json')).json()
      for (const r of j?.data?.risks ?? []) for (const g of r.gaps ?? []) if (g.gap_id === 724) return { risk: r.hrr_id, riskTitle: r.title, gapId: g.gap_id, title: g.title, status: g.status, retrievedAt: j.retrieved_at ?? null }
      return null
    })
    ctx.fact('eihso301', gap && { ...gap, id: /^([A-Z]+-\d+):/.exec(gap.title)?.[1] ?? null })
    ctx.assert(!!gap && gap.title.startsWith('EIHSO-301:') && gap.title.includes('establish the thresholds'), "final card: NASA's gap EIHSO-301 asks to “establish the thresholds” (hrp_roadmap.json gap 724, verbatim)", gap)
    ctx.assert(gap?.status === 'Open', "final card: EIHSO-301 is an 'open' gap (hrp_roadmap.json gap 724 status)", gap?.status)
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
        rulesData: /Every number LANDFALL uses, generated from the same rules files the engine reads\./.exec(main)?.[0] ?? null,
        summary: /Summary\n([\s\S]*?)\n\n/.exec(main)?.[1]?.replace(/\s+/g, ' ') ?? null,
      }
    })
    ctx.fact('provenanceClaims', v)
    ctx.assert(!!v.nasa, "final card: 'Every NASA limit links to the standard it came from' (provenance: NASA-published numbers open to the verbatim requirement text)", v.nasa)
    ctx.assert(!!v.ours, "final card: 'Every number with no published basis is labelled as ours' (provenance: listed here as ours)", v.ours)
    ctx.assert(!!v.rulesData, "final card: 'every threshold is data' (provenance: every number is generated from the rules files the engine reads)", v.rulesData)
  } finally {
    await prov.close()
  }
}
