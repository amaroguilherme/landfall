// The LANDFALL 30-second demo, shot by shot. Edit words and timings here; make-video.mjs only
// executes this file. Rules this storyboard keeps:
//   - every claim on screen is either READ from the live app at capture time (facts) or CHECKED
//     against it (ctx.assert) before a single frame of it is written; a failed check aborts the run;
//   - no number is typed here: the only figures on screen are the app's own pixels and facts read
//     from the app or its frozen snapshots (the one-way light time, the replayed event's name, the
//     roadmap gap id);
//   - English only, no audio, no logos, no generated imagery: app screen capture + typographic cards;
//   - text that is not final is a visible placeholder (PLACEHOLDERS), never a guess.
//
// Shot fields
//   kind 'card'  card(facts) -> { layout, blocks: [{ cls, text, in }] }   (scripts/video/card.html)
//   kind 'app'   route, kicker + caption (overlay), ready (page predicate), check / prepare (real
//                time, before the clock is frozen), onPaused, preroll (virtual ms before frame 0),
//                events [{ at, run(page, state, ctx) }], frame(t, state) -> overlay spec, after
//                (checks the end state), clear [{ sel, text?, what }] (elements that must be on screen
//                and clear of the caption box on the last frame; make-video checks them)
//   overlay spec { caption: opacity, words: opacity of the caption's words alone (the band stays up),
//                scrollY, anchor: { sel, text?, y }, ring: { sel, text?, o, pad } }
//                (text = case-insensitive regex the element's text must match)
//   stills       [{ at, name, overlay? }]: PNG frames saved for review, `at` in seconds into the shot;
//                overlay: false saves the same frame without the caption and the ring (not a video frame)
// Functions passed to page.call() run IN THE PAGE: they must be self-contained (no closures).
// App-shot geometry (scroll positions, anchors) is in CSS px of the VIEW viewport.

export const FPS = 30
/** The output frame, in pixels. */
export const WIDTH = 1920
export const HEIGHT = 1080
/**
 * App shots: a 1440 x 810 CSS px viewport rendered at 4/3 device pixels per CSS pixel, which fills the
 * 1920 x 1080 frame. At 1440 px the app's own layout spans most of the frame, so its text is a third larger
 * on screen than in a 1920 px layout and stays legible in a small player (1440 is also the width the judges'
 * reviews used). The title cards are laid out at 1920 x 1080 and rendered at 1.
 */
export const VIEW = { width: 1440, height: 810, dsf: 4 / 3 }
/** The judge-facing URL printed on the last card (independent of the capture base URL). */
export const PUBLIC_URL = 'https://landfall.landfall-web.workers.dev'
/** Hard limit for global judging is 30.0 s; the storyboard must stay at or under this. */
export const MAX_SECONDS = 29.5
// The app footer's own words (factsPass checks them word for word). No offline claim here: the app shows
// "Works offline after first load" only once its service worker holds the build.
const FOOTER = 'Not endorsed by NASA. Not a medical device: no diagnosis, no dosing. Crew data is simulated. NASA and NOAA data are real, frozen at build. No backend: everything runs in this browser.'
/** The event, as the app's own footer names it (factsPass checks it). */
const EVENT = 'NASA Space Apps Challenge 2026'

// ---- placeholders: on screen, marked, and listed so a render cannot pass for the final cut --------
/**
 * TEAM-CARD-TBC: who the title card credits waits for the user (the team is not final), so the card prints
 * this marker in place of any name. make-video.mjs logs every entry of PLACEHOLDERS, prints "NOT FOR UPLOAD
 * YET" at the end and writes them to facts.json. When the credit is confirmed: put it in TEAM_LINE, delete
 * the entry below, re-render.
 */
const TEAM_MARKER = 'TEAM-CARD-TBC'
const TEAM_LINE = 'Team Isaac Clarke: Guilherme Amaro, Ayra Castilho'
export const PLACEHOLDERS = [] // team confirmed by the user on 2026-11-15: Isaac Clarke (Guilherme Amaro, Ayra Castilho)

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
/**
 * The words the NEXT line quotes from EIHSO-301 (hrp_roadmap.json gap 724), which factsPass() requires to be in the
 * gap's title verbatim. The gap reads "We need to determine the on-board, intelligent systems that will support crew
 * health and performance, and we need to establish the thresholds that will define how these systems should be
 * implemented": the line keeps its own verb (determine) and quotes what is to be determined, not "the thresholds",
 * which are the thresholds for implementing such systems, not alert thresholds.
 */
export const FUTURE_QUOTE = 'the on-board, intelligent systems that will support crew health and performance'
/** The future line of the final card (gap id and status from hrp_roadmap.json gap 724, the quote checked in it). */
export const futureLine = (facts) =>
  `Next: NASA's open gap ${facts.eihso301.id} asks to determine\n“${FUTURE_QUOTE}”.\nLANDFALL proposes one; its thresholds are data a program can replace.`

function setCaption(kicker, text) {
  window.__lfv.caption(kicker, text)
  return true
}

/** The overlay's caption box top in viewport CSS px (null when no overlay is installed, e.g. make-figures). */
function captionTop() {
  return window.__lfv ? window.__lfv.box().top : null
}

/** The top of the caption's feathered edge in viewport CSS px (null when no overlay is installed). */
function captionFeatherTop() {
  return window.__lfv ? window.__lfv.box().featherTop : null
}

// ---- the hero's measured latency under the capture clock -----------------------------------------
// Replay restarts the dual counter AND re-measures the onboard answer. Under the frozen capture clock that
// re-measure would read whole capture steps (exactly 1/30 s), not the browser's real time. So the shot reads
// the latency the app measured on the real clock when this page loaded, clicks Replay, lets React render the
// click (the engine run reads the frozen clock), and steps the clock by exactly that latency before the
// browser paints: the frames show the measurement of this visit, and a check compares the two.

/** Virtual ms for the replayed measurement plus the realignment step: 6 frames at 30 fps (see onPaused). */
const HERO_ALIGN_MS = 200
/**
 * Where frame 0 starts in the dual-counter sequence (SEQUENCE in web/src/features/now/model.ts): the round
 * trip is most of the way counted up, and the link countdown replaces it while the first caption is still on
 * screen, so "Houston's reply is days away" is on screen with the countdown that shows it.
 */
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

/**
 * What the hero frames show that the last video got wrong (it was captured from an older build): the onboard
 * card's S3 badge class, the MET format, the conjunction window's basis, the monitor that read S3, who raises
 * the alarm, and the ground packet state. Read from the DOM; the shot asserts each one.
 */
function heroNow() {
  const norm = (x) => (x ?? '').replace(/\s+/g, ' ').trim()
  const sev = document.querySelector('.now-landfall .lf-sev')
  const paras = [...document.querySelectorAll('main p')].map((p) => norm(p.textContent))
  // the Houston card cross-fades two layers (round trip, then the link countdown): read the one on screen
  const shown = [...document.querySelectorAll('.now-houston .now-layer')].find((l) => getComputedStyle(l).visibility !== 'hidden' && Number(getComputedStyle(l).opacity) >= 0.99)
  return {
    badge: sev ? { severity: sev.dataset.severity ?? null, text: norm(sev.querySelector('.lf-sev-text')?.textContent ?? sev.textContent) } : null,
    met: norm(document.querySelector('.lf-mb-met time')?.textContent) || null,
    houstonCap: norm(shown?.querySelector('.now-counter-cap')?.textContent) || null,
    houstonCounter: norm(shown?.querySelector('.now-big')?.textContent) || null,
    conjunction: [...document.querySelectorAll('.now-houston *')].map((e) => norm(e.textContent)).find((x) => /^Conjunction window/.test(x)) ?? null,
    intro: paras.find((x) => /reached the S3 level/.test(x)) ?? null,
    houston: [...document.querySelectorAll('.now-houston .now-counter-sub')].map((e) => norm(e.textContent)).join(' | '),
  }
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
/** Gap (CSS px) between the mission bar and the eyebrow of the "Limits that apply" section above the card. */
const LIMITS_EYEBROW_GAP = 12

/**
 * Where the VO2max card's top goes (viewport CSS px): the "Limits that apply" section, eyebrow included, starts
 * LIMITS_EYEBROW_GAP below the mission bar, so no line of it is cut by the bar's edge. shot.clear then checks
 * that the taller (Mars) card still ends above the caption box.
 */
function vo2Anchor(gapBelowBar) {
  const li = [...document.querySelectorAll('li.lf-limit[data-applicable]')].find((x) => /VO2max/i.test(x.querySelector('.lf-limit-label')?.textContent ?? ''))
  const h = [...document.querySelectorAll('main h2, main h3')].find((x) => /^Limits that apply$/.test(x.textContent.trim()))
  if (!li || !h) return null
  const prev = h.previousElementSibling
  const top = prev && /eyebrow|kicker/i.test(prev.className) ? prev : h
  const bar = document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0
  return { y: Math.round(bar + gapBelowBar + (li.getBoundingClientRect().top - top.getBoundingClientRect().top)), sectionTop: top.textContent.replace(/\s+/g, ' ').trim() }
}

/** Scroll so the VO2max limit card's top sits at viewport y = `y`. */
function anchorVo2(y) {
  const li = [...document.querySelectorAll('li.lf-limit[data-applicable]')].find((x) => /VO2max/i.test(x.querySelector('.lf-limit-label')?.textContent ?? ''))
  if (!li) return null
  window.scrollTo({ top: Math.round(li.getBoundingClientRect().top + window.scrollY - y), left: 0, behavior: 'instant' })
  return Math.round(li.getBoundingClientRect().top)
}

/**
 * The shelter case's own "Why this fired" panel (in section 1, Detect; the trigger list below has one per
 * rule), opened for a moment to read it and measure it, then closed again. It tags the summary, the grid and
 * the [V2 6164] basis with data-lfv for the ring and the caption-clearance check. Document CSS px.
 */
export function readWhy() {
  const norm = (x) => (x ?? '').replace(/[\s​  ]+/g, ' ').replace(/\s+\)/g, ')').trim()
  const scope = document.querySelector('#case-detect') ?? document.querySelector('main')
  const d = [...(scope?.querySelectorAll('details.lf-expander') ?? [])].find((x) => norm(x.querySelector('summary')?.textContent) === 'Why this fired')
  if (!d) return null
  const wasOpen = d.open
  d.querySelector('summary').setAttribute('data-lfv', 'why')
  d.open = true
  const grid = d.querySelector('dl.lfc-why-grid')
  grid?.setAttribute('data-lfv', 'why-grid')
  // dt label, dd number(s) and unit; the arrow, screen-reader words and chips are read separately
  const rows = [...(grid?.querySelectorAll(':scope > div') ?? [])].map((row) => {
    const dd = row.querySelector('dd')?.cloneNode(true)
    dd?.querySelectorAll('.lf-num-arrow, .sr-only, [data-chip]').forEach((x) => x.remove())
    return { label: norm(row.querySelector('dt')?.textContent), value: norm(dd?.textContent), chips: [...row.querySelectorAll('[data-chip]')].map((c) => c.dataset.chip) }
  })
  // the rule's basis (div.lfc-source > cite in this build), found by the requirement it quotes
  const basis = [...d.querySelectorAll('.lfc-source, cite, p')].find((p) => /\[V2 6164\]/.test(p.textContent))
  basis?.setAttribute('data-lfv', 'why-basis')
  const sev = [...d.querySelectorAll('.lf-sev')].map((b) => ({ severity: b.dataset.severity ?? null, text: norm(b.querySelector('.lf-sev-text')?.textContent ?? b.textContent) }))
  const chips = [...d.querySelectorAll('[data-chip]')].map((c) => c.dataset.chip)
  const box = d.getBoundingClientRect()
  const out = {
    rows,
    sev,
    chips,
    basis: basis ? norm(basis.textContent) : null,
    text: norm(d.innerText),
    top: Math.round(box.top + window.scrollY),
    bottom: Math.round(box.bottom + window.scrollY),
    basisBottom: basis ? Math.round(basis.getBoundingClientRect().bottom + window.scrollY) : null,
    detectTop: Math.round((document.querySelector('#case-detect')?.getBoundingClientRect().top ?? box.top) + window.scrollY),
    bar: Math.round(document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0),
    viewH: window.innerHeight,
  }
  d.open = wasOpen
  return out
}

/** A number from a grid cell ("1050 pfu", "≥ 1000 pfu", "50 pfu"), or NaN. */
const cellNumber = (s) => Number(/(-?\d+(?:\.\d+)?)/.exec((s ?? '').replace(/[,−]/g, (c) => (c === ',' ? '' : '-')))?.[1] ?? NaN)

/**
 * The Sol 242 panel of #/radiation (Mars surface only), as text: its title, JPL's planned Curiosity moratorium
 * (the quote and the window line under it), the sentence that names the sol, the RAD peak line and Hassler et
 * al.'s Fig. 5 caption, with the geometry of each part (document CSS px) for the framing. It tags the sol sentence
 * with data-lfv for the caption-clearance check.
 */
export function readSol242() {
  const norm = (x) => (x ?? '').replace(/[\s​  ]+/g, ' ').trim()
  const el = document.getElementById('rad-sol242')
  if (!el) return null
  const title = el.querySelector('.lf-panel-head .lf-panel-title')
  const jpl = el.querySelector('[data-sol242-jpl]')
  const sol = [...el.querySelectorAll('p')].find((p) => /^On sol \d+,/.test(norm(p.textContent)))
  sol?.setAttribute('data-lfv', 'sol242-sol')
  const peak = el.querySelector('[data-sol242-peak]')
  const doc = (e) => (e ? { top: Math.round(e.getBoundingClientRect().top + window.scrollY), bottom: Math.round(e.getBoundingClientRect().bottom + window.scrollY) } : null)
  return {
    eyebrow: norm(el.querySelector('.lf-panel-head .lf-eyebrow')?.textContent) || null,
    title: norm(title?.textContent) || null,
    jpl: norm(jpl?.querySelector('blockquote')?.textContent) || null,
    jplSource: norm(jpl?.querySelector('figcaption')?.textContent) || null,
    window: norm(jpl?.querySelector('.lf-s242-jpl-span')?.textContent) || null,
    sol: norm(sol?.textContent) || null,
    peak: norm(peak?.textContent) || null,
    fig5: norm(el.querySelector('[data-sol242-caption] blockquote')?.textContent) || null,
    canvases: el.querySelectorAll('canvas').length,
    geo: { panel: doc(el), title: doc(title), jpl: doc(jpl), sol: doc(sol), het: doc(el.querySelector('canvas')), peak: doc(peak) },
    bar: Math.round(document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0),
    env: document.querySelector('.lf-mb-env select')?.value ?? null,
    viewH: window.innerHeight,
  }
}

/**
 * The head of the #/eva evidence board, as text: the eyebrow (crew, role, environment), NASA's [V1 6006] requirement
 * and its citation, the ground link (its state, the earliest review, the "from now" line), LANDFALL's own "never
 * clears" sentences, and every rendered sentence outside NASA's verbatim quotes, for the no-clearance check. Geometry
 * in document CSS px.
 */
export function readEva() {
  const norm = (x) => (x ?? '').replace(/[\s​  ]+/g, ' ').trim()
  const main = document.querySelector('main')
  const req = document.querySelector('[data-eva-v16006]')
  const ground = document.querySelector('[data-eva-ground]')
  const review = document.querySelector('[data-eva-earliest-review]')
  const reqPanel = req?.closest('section')
  // LANDFALL's own words: the page without NASA's verbatim text (the requirement, its rationale, quoted phrases)
  const own = main?.cloneNode(true)
  own?.querySelectorAll('[data-eva-v16006], blockquote, q, .lf-eva-rationale, [data-eva-req]').forEach((x) => x.remove())
  const doc = (e) => (e ? { top: Math.round(e.getBoundingClientRect().top + window.scrollY), bottom: Math.round(e.getBoundingClientRect().bottom + window.scrollY) } : null)
  return {
    eyebrow: norm(document.querySelector('.lf-eva-head .lf-eyebrow')?.textContent) || null,
    h1: norm(document.querySelector('.lf-eva-head h1')?.textContent) || null,
    never: [...document.querySelectorAll('.lf-eva-never')].map((x) => norm(x.textContent)),
    requirement: norm(req?.querySelector('blockquote')?.textContent) || null,
    citation: norm(req?.querySelector('figcaption')?.textContent) || null,
    ground: ground?.dataset.ground ?? null,
    groundHead: norm(ground?.querySelector('.lf-eva-ground-head')?.textContent) || null,
    review: norm(review?.querySelector('dd')?.textContent) || null,
    roundTrip: norm(document.querySelector('[data-eva-round-trip-los] dd')?.textContent) || null,
    reviewFrom: norm([...(ground?.querySelectorAll('.lf-eva-fine') ?? [])].map((x) => x.textContent).find((x) => /earliest review is/i.test(x))) || null,
    ownText: norm(own?.textContent),
    geo: { reqPanel: doc(reqPanel), requirement: doc(req?.querySelector('blockquote')), review: doc(review), ground: doc(ground) },
    bar: Math.round(document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0),
    env: document.querySelector('.lf-mb-env select')?.value ?? null,
    crew: document.querySelector('.lf-mb-crew select')?.value ?? null,
    link: document.querySelector('.lf-comms-link')?.textContent.trim() ?? null,
    viewH: window.innerHeight,
  }
}

/** "It has happened: <month year>, Mars behind the Sun. / …" (the month and year from the panel's own title). */
export const sol242Caption = (facts) => `It has happened: ${facts.sol242.when}, Mars behind the Sun.\nCuriosity measured a solar storm at Gale crater.`
/** Gap (CSS px) between the mission bar and the top of the panel a shot frames. */
const PANEL_GAP = 12

// ---- the storyboard ----------------------------------------------------------------------------

export const SHOTS = [
  {
    id: 'card-title',
    kind: 'card',
    dur: 2.0,
    // TEAM-CARD-TBC: the credit is a visible placeholder (see PLACEHOLDERS); the event name is checked
    // against the app's own footer in factsPass()
    card: () => ({
      layout: 'brand',
      blocks: [
        { cls: 'wordmark', text: 'LANDFALL', in: -1 }, // visible on frame 0: the poster frame shows the name
        { cls: 'sub', text: TEAM_LINE, in: 0.3 },
        { cls: 'sub', text: EVENT, in: 0.45 },
      ],
    }),
    stills: [{ at: 1.9, name: 'still-0-title-card' }],
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

  // ---- the product: real app, fresh page per shot, app clock frozen and stepped 1/30 s per frame ----
  {
    // "It has happened": the April 2013 storm Curiosity's RAD measured at Gale crater while Mars was in solar
    // conjunction. The frame holds the panel's head: its title, JPL's planned moratorium (quote and window), the
    // sentence that names the sol, and the STEREO-B chart. The RAD peak line starts about 860 CSS px below the
    // title's top, more than the 576 px between the mission bar and the caption, so it is read and checked but not
    // framed.
    id: 'sol242',
    kind: 'app',
    dur: 2.0,
    route: '#/radiation?env=mars_surface',
    kicker: '#/radiation · Mars surface',
    // set from the panel's own title in prepare (sol242Caption), before the first frame
    caption: 'It has happened: <month year from the panel title>, Mars behind the Sun.\nCuriosity measured a solar storm at Gale crater.',
    ready: () => document.querySelectorAll('#rad-sol242 canvas').length === 2 && !!document.querySelector('#rad-sol242 [data-sol242-jpl]') && !!document.querySelector('#rad-sol242 [data-sol242-peak]'),
    prepare: async (page, ctx) => {
      const v = await page.call(readSol242)
      if (!v) throw new Error('sol242: no #rad-sol242 panel on #/radiation at the Mars surface')
      const when = /\(([A-Z][a-z]+ \d{4})\)$/.exec(v.title ?? '')?.[1] ?? null
      const solN = /^On sol (\d+),/.exec(v.sol ?? '')?.[1] ?? null
      const peak = /^Peak at Gale crater: ([\d.,]+ µGy\/day) at ([^,]+), ([\d.]+) × the background/.exec(v.peak ?? '')
      ctx.fact('sol242', { when, sol: solN, peakValue: peak?.[1] ?? null, peakAt: peak?.[2] ?? null, peakRatio: peak?.[3] ?? null, eyebrow: v.eyebrow, title: v.title, jpl: v.jpl, jplSource: v.jplSource, window: v.window, solSentence: v.sol, peak: v.peak, fig5: v.fig5, geo: v.geo })
      ctx.assert(v.env === 'mars_surface', "sol242 kicker: 'Mars surface' (the mission bar's environment)", v.env)
      ctx.assert(/^It has happened: a solar storm at Gale crater\b/.test(v.title ?? '') && !!when, "sol242 caption: 'It has happened' and its month and year (the panel's own title: 'It has happened: a solar storm at Gale crater … (<month year>)')", v.title)
      ctx.assert(/\bin solar conjunction\b/.test(v.title ?? '') && /while Mars was in solar conjunction/.test(v.fig5 ?? ''), "sol242 caption: 'Mars behind the Sun' (the title: 'in solar conjunction'; Hassler et al.'s Fig. 5 caption: 'while Mars was in solar conjunction')", { title: v.title, fig5: (v.fig5 ?? '').slice(0, 160) })
      ctx.assert(!!solN && /^On sol \d+, Curiosity’s RAD measured a solar particle event at Gale crater\./.test(v.sol ?? '') && new RegExp(`by RAD on sol ${solN}\\b`).test(v.fig5 ?? ''), "sol242 caption: 'Curiosity measured a solar storm at Gale crater' (the panel: 'On sol <n>, Curiosity’s RAD measured a solar particle event at Gale crater'; the same sol in Hassler et al.'s Fig. 5 caption)", { sol: v.sol, fig5: (v.fig5 ?? '').slice(0, 120) })
      ctx.assert(!!peak && Number(peak[3]) > 1, "sol242: RAD measured it (the panel's peak line: the dose-rate peak at Gale crater and its multiple of the background, read here, below the frame)", v.peak)
      ctx.assert(/^“Curiosity's controllers plan to suspend commanding from [A-Z][a-z]+ \d+ to [A-Z][a-z]+ \d+\.”$/.test(v.jpl ?? '') && /^NASA Jet Propulsion Laboratory\b/.test(v.jplSource ?? '') && /lies inside JPL’s planned Curiosity moratorium \(\d+ [A-Z][a-z]+ to \d+ [A-Z][a-z]+\)/.test(v.window ?? ''), "sol242 frame: JPL's planned Curiosity moratorium, quoted from JPL, and the window line that puts the span shown inside it", { jpl: v.jpl, source: (v.jplSource ?? '').slice(0, 80), window: v.window })
      ctx.assert(v.canvases === 2 && /^HISTORICAL · MEASURED$/.test(v.eyebrow ?? ''), "sol242 frame: the panel is labelled HISTORICAL · MEASURED and draws the measured records (2 charts)", { eyebrow: v.eyebrow, canvases: v.canvases })
      await page.call(setCaption, '#/radiation · Mars surface', sol242Caption(ctx.facts))
      ctx.fact('sol242.caption', sol242Caption(ctx.facts))
      // the panel's top PANEL_GAP under the mission bar; shot.clear checks that the title, the JPL quote and window
      // and the sol sentence end above the caption box on the last frame
      return { panelY: v.bar + PANEL_GAP }
    },
    // anchored, not scrolled: the long page above the panel keeps the panel's top at panelY on every frame
    frame: (_t, s) => ({ anchor: { sel: '#rad-sol242', y: s.panelY } }),
    clear: [
      { sel: '#rad-sol242 .lf-panel-title', what: "the panel title 'It has happened: …'" },
      { sel: '#rad-sol242 [data-sol242-jpl] blockquote', what: "JPL's planned Curiosity moratorium, quoted" },
      { sel: '#rad-sol242 .lf-s242-jpl-span', what: 'the moratorium window line' },
      { sel: '[data-lfv=sol242-sol]', what: "the 'On sol …' sentence" },
    ],
    stills: [{ at: 1.9, name: 'still-1a-sol242' }],
  },
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
      // The earliest-reply line as this build prints it, read and never assumed: its parenthetical names the round
      // trip at link-up (the EVA shot checks that the board prints the same round trip for when the link resumes).
      // No check pins its wording; the shot's checks read only the days and the ground packet from it.
      const line = /Earliest reply [^|]*?(?=\s*· ground packet:|\s*\||$)/.exec(v.houston)?.[0]?.trim() ?? null
      ctx.fact('hero.earliestReply', { line, linkUpRoundTrip: /\(the (\d+ min \d+ s) round trip added at link-up\)/.exec(line ?? '')?.[1] ?? null })

      // the current UI, which the frames show (the round-2 video was captured from an older build)
      const now = await page.call(heroNow)
      ctx.fact('hero.now', now)
      ctx.assert(now.badge?.severity === 'warning' && /^S3 · Warning\b/i.test(now.badge?.text ?? ''), "hero frame: the onboard card's badge reads S3 · Warning, in the Warning class", now.badge)
      ctx.assert(/^[1-9]\d*\/\d{2}:\d{2}:\d{2}$/.test(now.met ?? ''), 'hero frame: the mission bar prints MET with no leading zeros in the day field', now.met)
      ctx.assert(/modelled from JPL Horizons geometry/.test(now.conjunction ?? ''), "hero frame: the conjunction window reads 'modelled from JPL Horizons geometry'", now.conjunction)
      ctx.assert(/^The Mars-orbit space-weather monitor reached the S3 level/.test(now.intro ?? ''), 'hero frame: the S3 reading is the Mars-orbit space-weather monitor’s', now.intro)
      ctx.assert(/radiation monitoring system raises the alarm; LANDFALL opened the shelter health case/.test(now.intro ?? ''), "hero frame: the habitat's radiation monitoring system raises the alarm, and LANDFALL opens the health case", now.intro)
      ctx.assert(/ground packet: Prepared \(held on board\)/.test(now.houston), "hero frame: the ground packet reads 'Prepared (held on board)'", now.houston)
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
    // The band is up from frame 0, as in every other app shot, and only its words fade (in at the start, and
    // across the swap): a band that dipped to transparent between the two captions flashed the page bottom it
    // hides (the [V2 6164] quote and the case strip) and laid the new words over that text for about 0.4 s.
    frame: (t) => ({ words: t < HERO_SWAP_S ? Math.min(fadeIn(t, 0.1, 0.2), 1 - fadeIn(t, HERO_SWAP_S - 0.2, 0.2)) : fadeIn(t, HERO_SWAP_S, 0.2) }),
    // both counters, whole, above the caption box (the caption sits over the [V2 6164] quote below them)
    clear: [
      { sel: '.now-houston', what: 'the Ask Houston counter' },
      { sel: '.now-landfall', what: 'the LANDFALL onboard card' },
    ],
    after: async (page, ctx) => {
      const end = await page.call(guidanceText)
      const now = await page.call(heroNow)
      ctx.fact('hero.end', { guidance: end, houstonCap: now.houstonCap, houstonCounter: now.houstonCounter, met: now.met })
      ctx.assert(end !== null && end === ctx.facts.hero?.guidance, "hero: the last frame's latency is the one measured on the real clock on this visit", { end, measured: ctx.facts.hero?.guidance })
      ctx.assert(/^Link resumes in\b/.test(now.houstonCap ?? '') && /^[1-9]\d*\/\d{2}:\d{2}:\d{2}$/.test(now.houstonCounter ?? ''), "hero frame: the last frame shows the link countdown ('Link resumes in'), with no leading zeros in the day field", { cap: now.houstonCap, counter: now.houstonCounter })
    },
    stills: [
      { at: 2.6, name: 'still-2a-hero-caption' },
      { at: 5.4, name: 'still-2-hero-dual-counter' },
      // the same last frame without the caption: og.png (make-figures) is cropped from it
      { at: 5.4, name: 'still-2b-hero-no-caption', overlay: false },
    ],
  },
  {
    id: 'case',
    kind: 'app',
    dur: 3.5,
    route: '#/case/spe_shelter',
    kicker: '#/case/spe_shelter',
    // The panel's own words since the S-level fix: a NOAA S-level is a threshold, not a limit, and the grid
    // names whose number it is (NOAA's S3, applied at Mars as a design choice).
    caption: 'Why this fired: the reading, the threshold,\nwhose number it is, and the NASA requirement.',
    ready: () => [...(document.querySelector('#case-detect') ?? document).querySelectorAll('details.lf-expander > summary')].some((s) => s.textContent.replace(/\s+/g, ' ').trim() === 'Why this fired'),
    prepare: async (page, ctx) => {
      const v = await page.call(readWhy)
      if (!v) throw new Error("case: no 'Why this fired' panel in the Detect section")
      ctx.fact('case', { why: v.text, rows: v.rows, sev: v.sev, chips: v.chips })
      const row = (re) => v.rows.find((r) => re.test(r.label)) ?? null
      const value = row(/^Value$/)
      const threshold = row(/^Threshold\b/)
      const above = row(/^Above the threshold by$/)
      ctx.assert(!!value && /^\d+(?:\.\d+)?\s*pfu$/.test(value.value), "case caption: 'the reading' (the grid's Value row: the monitor's proton flux)", value)
      ctx.assert(!!threshold && /NOAA S3/.test(threshold.label) && /^≥\s*\d+(?:\.\d+)?\s*pfu$/.test(threshold.value), "case caption: 'the threshold' (the grid's Threshold row, NOAA S3, reached at or above)", threshold)
      ctx.assert(!!threshold && threshold.chips.includes('design choice') && /NOAA does not define its scale away from Earth, so applying it at Mars is ours/.test(v.text), "case caption: 'whose number it is' (NOAA's S3 level; applying it at Mars is labelled a design choice)", { threshold, chips: v.chips })
      ctx.assert(/\[V2 6164\]/.test(v.basis ?? '') && /when radiation exposure rates exceed predefined thresholds/.test(v.basis ?? ''), "case caption: 'the NASA requirement' ([V2 6164], quoted in its own words)", (v.basis ?? '').slice(0, 220))
      ctx.assert(!!above && Math.abs(cellNumber(value?.value) - cellNumber(threshold?.value) - cellNumber(above.value)) < 1e-9, 'case: the grid agrees with itself (value minus threshold = above the threshold by)', { value: value?.value, threshold: threshold?.value, above: above?.value })
      ctx.assert(v.rows.every((r) => !/^(Limit|Margin)\b/.test(r.label)) && v.sev.some((s) => s.severity === 'warning' && /^At or above S3\b/i.test(s.text)) && !v.sev.some((s) => /limit/i.test(s.text)), "case: the panel calls the S3 level a threshold ('At or above S3'), not a limit", { labels: v.rows.map((r) => r.label), sev: v.sev })
      // After the click the grid and the [V2 6164] basis end above the caption box (shot.clear checks the
      // last frame); never scroll the Detect heading away. The engine's audit line and the provenance link at
      // the panel's foot may sit under the caption.
      const capTop = (await page.call(captionTop)) ?? v.viewH
      const want = Math.max(0, (v.basisBottom ?? v.bottom) - (capTop - 16))
      return { scrollTo: Math.min(want, Math.max(0, v.detectTop - v.bar - 8)) }
    },
    events: [{ at: 1.7, run: (page) => page.call(() => (document.querySelector('[data-lfv=why]').click(), true)) }],
    frame: (t, s) => ({
      scrollY: Math.round(s.scrollTo * ramp(t, 0.7, 1.4)),
      ring: { sel: '[data-lfv=why] > *', o: pulse(t, 1.3, 2.05), pad: 7 },
    }),
    clear: [
      { sel: '[data-lfv=why]', what: "the 'Why this fired' summary" },
      { sel: '[data-lfv=why-grid]', what: 'the value / threshold / above-the-threshold grid' },
      { sel: '[data-lfv=why-basis]', what: 'the [V2 6164] basis' },
    ],
    stills: [{ at: 3.4, name: 'still-3-why-this-fired' }],
  },
  {
    id: 'flip',
    kind: 'app',
    dur: 3.0,
    route: '#/body?region=heart',
    // no organ in the kicker: the card itself says VO2max is a whole-body fitness tag, not this organ's state
    kicker: '#/body · CM-2 Flight Engineer',
    caption: "Mars → ISS: the link comes back,\nand CM-2's VO2max verdict flips.",
    ready: () => !!document.querySelector('li.lf-limit .lf-limit-label') && !!document.querySelector('.lf-mb-crew select'),
    prepare: async (page, ctx) => {
      if (!(await page.call(setSelect, '.lf-mb-crew select', 'CM-2'))) throw new Error('flip: cannot select CM-2')
      await page.waitUntil(() => /CM-2 · FLIGHT ENGINEER/i.test(document.querySelector('main')?.innerText ?? ''), [], { what: 'the body map to show CM-2' })
      const who = await page.call(() => /^CM-2 · FLIGHT ENGINEER\b[^\n]*/im.exec(document.querySelector('main')?.innerText ?? '')?.[0] ?? null)
      ctx.assert(!!who, "flip kicker: 'CM-2 Flight Engineer' (the body map's own heading line)", who)
      await page.waitUntil(() => [...document.querySelectorAll('li.lf-limit[data-applicable] .lf-limit-label')].some((x) => /VO2max/i.test(x.textContent)), [], { what: "CM-2's VO2max limit card" })
      const anchor = await page.call(vo2Anchor, LIMITS_EYEBROW_GAP)
      if (!anchor) throw new Error("flip: no 'Limits that apply' section above the VO2max card")
      await page.call(anchorVo2, anchor.y)
      const before = await page.call(readVo2)
      ctx.fact('flip.mars', before)
      ctx.assert(before?.env === 'mars_surface' && before?.link === 'LOS', 'flip: starts at Mars with the link down (LOS)', before)
      ctx.assert(/OUTSIDE LIMIT/.test(before?.status ?? '') && /36\.5/.test(before?.rule ?? '') && /V1 4002/.test(before?.source ?? ''), "flip: at Mars CM-2's VO2max is outside NASA's surface-EVA floor [V1 4002]", before)
      return { vo2Y: anchor.y }
    },
    events: [
      {
        at: 1.05,
        run: async (page, state) => {
          if (!(await page.call(setSelect, '.lf-mb-env select', 'iss'))) throw new Error('flip: cannot select ISS')
          await page.call(anchorVo2, state.vo2Y) // keep the card still across the re-render (frame() re-anchors every frame)
        },
      },
    ],
    // the ring shows what is clicked (ENV), then where to look (the VO2max verdict)
    frame: (t, s) => ({
      anchor: { ...VO2_CARD, y: s.vo2Y },
      ring: t < 1.6 ? { sel: '.lf-mb-env select', o: pulse(t, 0.35, 1.6), pad: 5 } : { ...VO2_CARD, o: pulse(t, 1.65, 3.2), pad: 3 },
    }),
    clear: [
      { sel: 'main h2, main h3', text: '^\\s*Limits that apply\\s*$', what: "the 'Limits that apply' heading" },
      { ...VO2_CARD, what: "CM-2's VO2max limit card" },
    ],
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
    // The EVA evidence board's head for CM-2 at the Mars base (a fresh page: the scenario's Mars, not the ISS the
    // flip ended on): NASA's [V1 6006] requirement, verbatim, and the ground link with its earliest review. The
    // page's own "LANDFALL never clears anyone for EVA." sits above the requirement panel; the head from it to the
    // earliest review is taller than the 576 CSS px between the mission bar and the caption, so the caption carries
    // it, checked against the page's sentence and against every other sentence the page prints.
    id: 'eva',
    kind: 'app',
    dur: 2.0,
    route: '#/eva?crew=CM-2',
    kicker: '#/eva · CM-2 Flight Engineer',
    caption: 'NASA: the ground clears the crew before each EVA.\nLANDFALL clears no one.',
    ready: () => !!document.querySelector('[data-eva-v16006] blockquote') && /MET \d+\/\d{2}:\d{2}:\d{2}/.test(document.querySelector('[data-eva-earliest-review]')?.textContent ?? '') && document.querySelector('.lf-mb-crew select')?.value === 'CM-2',
    prepare: async (page, ctx) => {
      const v = await page.call(readEva)
      const { ownText, ...seen } = v
      ctx.fact('eva', seen)
      ctx.assert(v.env === 'mars_surface' && v.crew === 'CM-2' && v.link === 'LOS' && /^CM-2 · Flight Engineer · Mars surface\b/.test(v.eyebrow ?? ''), "eva kicker: 'CM-2 Flight Engineer', at the Mars base with the link down (the board's own eyebrow and the mission bar)", { env: v.env, crew: v.crew, link: v.link, eyebrow: v.eyebrow })
      ctx.assert(/^“All crewmembers shall be medically cleared to perform an EVA by ground medical support personnel prior to each EVA\.”$/.test(v.requirement ?? '') && /^\[V1 6006\] NASA-STD-3001 Vol 1\b/.test(v.citation ?? '') && /verbatim/.test(v.citation ?? ''), "eva caption: 'NASA: the ground clears the crew before each EVA' ([V1 6006], verbatim on the board)", { requirement: v.requirement, citation: v.citation })
      ctx.assert(v.ground === 'unreachable' && /^No ground link: solar conjunction\. No answer from Earth can reach the crew before the link resumes\.$/.test(v.groundHead ?? ''), "eva frame: the ground link is down for the solar conjunction ('No ground link: solar conjunction')", { ground: v.ground, head: v.groundHead })
      const review = /^MET (\d+\/\d{2}:\d{2}:\d{2}) \(light time only, before any review time\)$/.exec(v.review ?? '')
      const from = /^The earliest review is (\d+ d \d+ h) from now: the same “Earliest reply” as the Now page\./.exec(v.reviewFrom ?? '')
      ctx.fact('eva.review', { met: review?.[1] ?? null, fromNow: from?.[1] ?? null })
      ctx.assert(!!review && !!from, "eva frame: the earliest ground review, a MET labelled 'light time only, before any review time', and how far it is from now", { review: v.review, from: v.reviewFrom })
      // the same wait the hero's Ask Houston card prints (facts.hero, from the hero shot earlier in this run)
      const hero = /Earliest reply (\d+ d \d+ h)\b/.exec(ctx.facts.hero?.houston ?? '')?.[1] ?? null
      if (ctx.facts.hero) ctx.assert(hero === from?.[1], "eva frame: the earliest review is the hero's 'Earliest reply'", { eva: from?.[1] ?? null, hero })
      // the round trip the board prints for link-up is the one the hero's earliest-reply line adds at link-up
      const atResume = /(\d+ min \d+ s) when the link resumes/.exec(v.roundTrip ?? '')?.[1] ?? null
      const heroLinkUp = ctx.facts['hero.earliestReply']?.linkUpRoundTrip ?? null
      if (heroLinkUp) ctx.assert(atResume === heroLinkUp, "eva frame: the round trip when the link resumes is the one the hero adds at link-up", { eva: v.roundTrip, hero: heroLinkUp })
      else if (ctx.facts.hero) ctx.warn(`eva: the hero's earliest-reply line names no round trip at link-up (${ctx.facts['hero.earliestReply']?.line ?? 'not read'}); the cross-check was skipped`)
      ctx.assert(v.never.length >= 2 && v.never.every((x) => x.startsWith('LANDFALL never clears anyone for EVA.')) && /The decision belongs to the program and to ground medical support\./.test(v.never[0]), "eva caption: 'LANDFALL clears no one' (the board's own words, at its head and under the program options: 'LANDFALL never clears anyone for EVA.')", v.never)
      const verdicts = (ownText.match(/[^.]*\b(cleared for|go for EVA|no-go|clear(?:ed)? to EVA|is cleared|are cleared)\b[^.]*/gi) ?? []).map((x) => x.trim())
      ctx.assert(verdicts.length === 0, "eva caption: 'LANDFALL clears no one' (outside NASA's quoted text, the board prints no clearance: no 'cleared for', 'go for EVA', 'no-go' or 'cleared to EVA')", verdicts)
      // The requirement panel's top PANEL_GAP under the mission bar, unless the earliest review would then reach the
      // caption's feathered edge: then up just enough that the review (and its ring) ends above the feather, as long
      // as the panel's eyebrow stays below the bar (its top border may pass under the bar). shot.clear checks it.
      const feather = (await page.call(captionFeatherTop)) ?? v.viewH
      const top = v.geo.reqPanel?.top ?? v.geo.requirement.top
      const y = Math.max(v.bar - PANEL_GAP, Math.min(v.bar + PANEL_GAP, feather - 8 - (v.geo.review.bottom - top)))
      return { reqY: Math.round(y) }
    },
    frame: (t, s) => ({
      anchor: { sel: 'section.lf-panel:has([data-eva-v16006])', y: s.reqY },
      // where to look once the requirement is read: the earliest review
      ring: { sel: '[data-eva-earliest-review]', o: pulse(t, 0.85, 2.2), pad: 6 },
    }),
    clear: [
      { sel: '[data-eva-v16006] blockquote', what: 'the [V1 6006] requirement, verbatim' },
      { sel: '[data-eva-v16006] figcaption', what: 'its [V1 6006] citation' },
      { sel: '[data-eva-ground] .lf-eva-ground-head', what: "'No ground link: solar conjunction'" },
      { sel: '[data-eva-earliest-review]', what: 'the earliest ground review' },
    ],
    stills: [{ at: 1.9, name: 'still-4a-eva' }],
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
        const main = (document.querySelector('main')?.innerText ?? '').replace(/\s+/g, ' ')
        return { text: t.textContent.trim(), top: Math.round(r.top), left: Math.round(r.left), eyebrow: /HARDWARE CONCEPT[^\n]*?BENCH-TESTED/i.exec(main)?.[0] ?? null, boundary: /device boundary[^.]*?never built/i.exec(main)?.[0] ?? null }
      })
      ctx.fact('band', v)
      ctx.assert(/hardware concept/i.test(v.eyebrow ?? '') && /never built/i.test(v.eyebrow ?? '') && /concept, never built/i.test(v.boundary ?? ''), "band kicker: 'hardware concept, never built' (the page's own eyebrow and device boundary)", { eyebrow: v.eyebrow, boundary: v.boundary })
    },
    frame: () => ({}),
    clear: [{ sel: 'svg text', text: 'NOT MEASURABLE HERE', what: 'the NOT MEASURABLE HERE boundary' }],
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
        h.setAttribute('data-lfv', 'prov-dc')
        // the design-choice statement under the heading (the "listed here as ours" sentence)
        const st = [...document.querySelectorAll('main p')].find((p) => /NASA-STD-3001 publishes no numeric in-flight alert thresholds/.test(p.textContent))
        st?.setAttribute('data-lfv', 'prov-ours')
        const sum = document.querySelector('section.prov-summary')?.getBoundingClientRect()
        return {
          intro: /Every number LANDFALL uses[^\n]*/.exec(main)?.[0] ?? null,
          oursHeading: h.textContent.trim(),
          ours: /NASA-STD-3001 publishes no numeric in-flight alert thresholds[^\n]*/.exec(main)?.[0] ?? null,
          headingTop: Math.round(h.getBoundingClientRect().top + window.scrollY),
          statementBottom: st ? Math.round(st.getBoundingClientRect().bottom + window.scrollY) : null,
          summaryTop: sum ? Math.round(sum.top + window.scrollY) : null,
          bar: Math.round(document.querySelector('.lf-missionbar')?.getBoundingClientRect().bottom ?? 0),
          viewH: window.innerHeight,
        }
      })
      ctx.fact('provenance', v)
      ctx.assert(/Each one carries a chip that names its basis/.test(v.intro ?? ''), 'provenance caption: every number carries its source', v.intro)
      ctx.assert(/no published basis/.test(v.oursHeading) && /listed here as ours/.test(v.ours ?? ''), 'provenance caption: numbers with no published basis are listed as ours', v)
      // end with the chip counts 16 px under the mission bar (what is above them, the rules-file list, is then
      // wholly under the bar rather than cut by its edge) and the statement under the heading above the caption
      const capTop = (await page.call(captionTop)) ?? v.viewH
      const least = Math.max(0, (v.statementBottom ?? v.headingTop) - (capTop - 24))
      const at = v.summaryTop === null ? v.headingTop - 300 : v.summaryTop - v.bar - 16
      return { to: Math.round(Math.max(least, at, 0)) }
    },
    frame: (t, s) => ({ scrollY: Math.round(s.to * ramp(t, 0.2, 1.75)) }),
    clear: [
      { sel: 'section.prov-summary', what: 'the per-chip counts' },
      { sel: '[data-lfv=prov-dc]', what: "the 'Design choices — no published basis' heading" },
      { sel: '[data-lfv=prov-ours]', what: "the 'listed here as ours' statement" },
    ],
  },
  {
    id: 'card-final',
    kind: 'card',
    dur: 5.0,
    // Claims checked in factsPass() against the provenance page, the app footer and the frozen roadmap
    // (the NEXT line quotes an open NASA gap; it never says LANDFALL closes it).
    // Every block is in within 1.6 s (each fades in over 0.4 s), top to bottom, so each line then stays on
    // screen for the rest of the card: the claims 4.5 and 4.2 s, the NEXT line 4.0 s, the URL 3.6 s, the
    // small print 3.4 s, all of it together for the last 3.4 s.
    card: (facts) => ({
      layout: 'final',
      blocks: [
        { cls: 'wordmark', text: 'LANDFALL', in: 0 },
        { cls: 'claim', text: 'Every NASA limit links to the standard it came from.', in: 0.1 },
        { cls: 'claim', text: 'Every number with no published basis is labelled as ours.', in: 0.4 },
        { cls: 'next', text: futureLine(facts), in: 0.6 },
        { cls: 'url', text: PUBLIC_URL, in: 1.0 },
        { cls: 'foot', text: FOOTER, in: 1.2 },
      ],
    }),
    stills: [{ at: 4.9, name: 'still-6-final-card' }],
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
      description: document.querySelector('meta[name="description"]')?.content ?? null,
      onboard: /With no link, the crew acts onboard[^.]*\./.exec((document.querySelector('main')?.textContent ?? '').replace(/\s+/g, ' '))?.[0] ?? null,
    }))
    ctx.fact('missionBar', bar)
    ctx.fact('heroPage', page)
    const m = /(\d+)\s*min\s*(\d+)\s*s/.exec(bar.owlt ?? '')
    const owltS = m ? Number(m[1]) * 60 + Number(m[2]) : NaN
    ctx.assert(bar.env === 'mars_surface', 'problem card: the scenario starts on the Mars surface', bar.env)
    ctx.assert(owltS >= 19 * 60 && owltS < 20 * 60, "problem card: 'Nearly twenty light-minutes' (one-way light time in the mission bar is 19 to 20 min)", bar.owlt)
    ctx.assert(bar.link === 'LOS' && bar.conjunction && /behind the Sun/.test(page.headline ?? ''), "problem card: 'behind the Sun' (LOS, solar conjunction; the hero reads 'Houston is behind the Sun')", { link: bar.link, conjunction: bar.conjunction, headline: page.headline })
    ctx.assert(!!page.onboard, "problem card: 'the crew has to act on its own' (the hero: 'With no link, the crew acts onboard ...')", page.onboard)
    ctx.assert((page.footer ?? '').includes(FOOTER), "final card: the small print is the app's own footer, word for word", page.footer)
    ctx.assert((page.footer ?? '').includes(`LANDFALL · ${EVENT}`), `title card: '${EVENT}' (the app's own footer names the event)`, page.footer)

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

    // [0:20-0:30] future line: EIHSO-301 is open and asks to determine FUTURE_QUOTE, verbatim (frozen roadmap)
    const gap = await hero.call(async () => {
      const j = await (await fetch('/data/hrp_roadmap.json')).json()
      for (const r of j?.data?.risks ?? []) for (const g of r.gaps ?? []) if (g.gap_id === 724) return { risk: r.hrr_id, riskTitle: r.title, gapId: g.gap_id, title: g.title, status: g.status, retrievedAt: j.retrieved_at ?? null }
      return null
    })
    ctx.fact('eihso301', gap && { ...gap, id: /^([A-Z]+-\d+):/.exec(gap.title)?.[1] ?? null })
    ctx.assert(!!gap && gap.title.startsWith('EIHSO-301:') && gap.title.includes(`We need to determine ${FUTURE_QUOTE}`), `final card: NASA's gap EIHSO-301 asks to determine “${FUTURE_QUOTE}” (hrp_roadmap.json gap 724, the quote verbatim, after its own 'We need to determine')`, gap)
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
    ctx.assert(!!v.rulesData, "final card: 'its thresholds are data a program can replace' (provenance: every number is generated from the rules files the engine reads)", v.rulesData)
  } finally {
    await prov.close()
  }
}
