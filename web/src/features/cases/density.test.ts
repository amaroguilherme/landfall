// Case-page density: what moved into closed expanders is still in the page, inside a <details>, nothing deleted.
// Static markup of the real panels on the real frozen scenario at "now" (Mars). (A .ts file: vitest collects
// src/**/*.test.ts only, so a .test.tsx would never run.)
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RULES } from '../../app/engine'
import type { Indicator } from '../../app/engine'
import { caseSchedule, computeCases } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import type { Snapshot } from '../../app/data'
import { chanceDiffers, chanceRateOf } from '../../app/evaluate'
import { buildScenarioIndex } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import { BoundaryPanel, CaseLogPanel, CountermeasurePanel, InterpretPanel } from './index'
import { basisSummary } from './model'
import { ChanceLine } from './parts'
import type { CaseDefFull } from './types'

const snaps = import.meta.glob<Snapshot>('../../../public/data/{sim_crew,swpc_spe_replay}.json', { eager: true, import: 'default' })
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))![1]
const INDEX = buildScenarioIndex(snap('sim_crew').data as SimCrewData, snap('swpc_spe_replay').data as SpeReplayData)
const ENV = 'mars_surface'
const VIEWS = computeCases({ index: INDEX, runtime: [], envId: ENV, t: INDEX.nowMet, userEvents: [] }, caseSchedule(INDEX, [], ENV))
const view = (caseId: string, crewId: string): CaseView => VIEWS.find((v) => v.caseId === caseId && v.crewId === crewId)!
const defOf = (v: CaseView) => v.def as unknown as CaseDefFull

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

/** A string as React escapes it in markup. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

interface Block {
  start: number
  end: number
  open: boolean
  summary: string
  depth: number
}

/** Every <details> of the markup with its span, open state and summary text (nesting kept). */
function detailsBlocks(html: string): Block[] {
  const stack: Array<{ start: number; open: boolean }> = []
  const out: Block[] = []
  for (const m of html.matchAll(/<details\b([^>]*)>|<\/details>/g)) {
    if (m[0].startsWith('</')) {
      const top = stack.pop()!
      const end = m.index! + m[0].length
      const summary = text(/<summary>([\s\S]*?)<\/summary>/.exec(html.slice(top.start, end))?.[1] ?? '')
      out.push({ start: top.start, end, open: top.open, summary, depth: stack.length })
    } else stack.push({ start: m.index!, open: /\bopen\b/.test(m[1]) })
  }
  expect(stack, 'balanced <details>').toEqual([])
  return out
}

/** The outermost <details> around a position of the markup, or null when it is in plain view. */
const outerAt = (blocks: Block[], i: number) => blocks.filter((b) => b.start <= i && i < b.end).sort((a, b) => a.depth - b.depth)[0] ?? null

/** Where a piece of text sits: inside which outermost <details> (null: in view), for every occurrence. */
function placesOf(html: string, snippet: string): Array<Block | null> {
  const blocks = detailsBlocks(html)
  const out: Array<Block | null> = []
  for (let i = html.indexOf(snippet); i >= 0; i = html.indexOf(snippet, i + 1)) out.push(outerAt(blocks, i))
  return out
}

describe('3. Countermeasure: the basis is in a closed expander, the action stays in view', () => {
  for (const [caseId, crewId] of [
    ['spe_shelter', 'CM-1'],
    ['sleep_circadian', 'CM-1'],
    ['renal_stone', 'CM-3'],
  ] as const) {
    it(`${caseId} (${crewId}): the primary's rationale, chip and sources sit inside "Why this countermeasure"`, () => {
      const v = view(caseId, crewId)
      const def = defOf(v)
      const cm = def.countermeasure!.primary
      const html = renderToStaticMarkup(createElement(CountermeasurePanel, { def, state: v.state, onSelect: () => {}, sharedNote: 4 }))
      const places = placesOf(html, esc(cm.rationale!.slice(0, 60)))
      expect(places.length, 'the rationale is still rendered').toBeGreaterThanOrEqual(1)
      const why = places[0]!
      expect(why, 'the rationale is inside a <details>').not.toBeNull()
      expect(why.open, 'closed on load').toBe(false)
      expect(why.summary).toBe(basisSummary(cm))
      expect(why.summary).toMatch(/^Why this countermeasure: /)
      // its chip and its citations ride with it
      const inner = html.slice(why.start, why.end)
      expect(inner).toContain(`data-chip="${cm.chip}"`)
      for (const c of cm.citations ?? []) if (typeof c.doc === 'string') expect(text(inner)).toContain(text(esc(c.doc)))
      // the kicker and the title stay in view
      expect(outerAt(detailsBlocks(html), html.indexOf('Primary countermeasure'))).toBeNull()
      expect(outerAt(detailsBlocks(html), html.indexOf(esc(cm.title!)))).toBeNull()
    })
  }

  it('the Start button of a detected case is in view, not in an expander', () => {
    const v = view('spe_shelter', 'CM-1')
    expect(v.state.status).toBe('detected')
    const html = renderToStaticMarkup(createElement(CountermeasurePanel, { def: defOf(v), state: v.state, onSelect: () => {}, sharedNote: 4 }))
    const i = html.indexOf('<button')
    expect(i).toBeGreaterThan(0)
    expect(outerAt(detailsBlocks(html), i)).toBeNull()
    expect(text(html)).toContain('(all 4 crewmembers)')
  })

  it('names only the kinds of basis a countermeasure carries', () => {
    const cm = (caseId: string) => defOf(view(caseId, 'CM-1')).countermeasure!.primary
    expect(basisSummary(cm('spe_shelter'))).toBe('Why this countermeasure: the NASA and NOAA text, and our design choice')
    expect(basisSummary(cm('sleep_circadian'))).toBe('Why this countermeasure: the NASA text')
    expect(basisSummary(cm('renal_stone'))).toBe('Why this countermeasure: the NASA text')
  })
})

describe('2. Interpret: closed for every status', () => {
  it('the plain-words interpretation is inside a closed expander; "act first" only while detected', () => {
    for (const v of [view('spe_shelter', 'CM-1'), view('sleep_circadian', 'CM-1')]) {
      const def = defOf(v)
      const detected = v.state.status === 'detected'
      const html = renderToStaticMarkup(createElement(InterpretPanel, { def, envId: ENV, actFirst: detected }))
      const [where] = placesOf(html, esc(def.interpretation!.text!.slice(0, 60)))
      expect(where, v.key).not.toBeNull()
      expect(where!.open).toBe(false)
      expect(where!.summary).toBe(detected ? 'What this means, in plain words (act first: start the countermeasure above, read this after)' : 'What this means, in plain words')
    }
    expect(view('sleep_circadian', 'CM-1').state.status).toBe('acting')
  })
})

describe('Boundary: both lists are in closed expanders that carry their counts', () => {
  for (const caseId of ['spe_shelter', 'renal_stone', 'sleep_circadian']) {
    it(caseId, () => {
      const def = defOf(view(caseId, 'CM-1'))
      const html = renderToStaticMarkup(createElement(BoundaryPanel, { def }))
      const handOffs = def.not_measurable_here ?? []
      const refusals = def.refusals ?? []
      expect(handOffs.length).toBeGreaterThan(0)
      expect(refusals.length).toBeGreaterThan(0)
      for (const x of handOffs) {
        const [where] = placesOf(html, esc(x.what))
        expect(where, x.what).not.toBeNull()
        expect(where!.open).toBe(false)
        expect(where!.summary).toBe(`Not measurable here: hand-offs (${handOffs.length})`)
      }
      for (const r of refusals) {
        const [where] = placesOf(html, esc(r))
        expect(where, r).not.toBeNull()
        expect(where!.open).toBe(false)
        expect(where!.summary).toBe(`Refusals (${refusals.length})`)
      }
    })
  }
})

describe('Event log: the latest entries in view, the earlier ones in a closed expander', () => {
  const rows = (html: string) => [...html.matchAll(/<tr data-origin="([^"]*)"|<tr data-rejected="true" data-origin="([^"]*)"/g)].map((m) => m.index!)

  it('a long log keeps every entry, in order: the earlier ones closed above, the latest five in view', () => {
    const long = VIEWS.filter((v) => v.state.log.length > 5).sort((a, b) => b.state.log.length - a.state.log.length)[0]
    expect(long, 'a view with more than five log entries').toBeTruthy()
    const n = long.state.log.length
    const html = renderToStaticMarkup(createElement(CaseLogPanel, { view: long }))
    const blocks = detailsBlocks(html)
    const at = rows(html)
    expect(at.length, 'every entry is still a row').toBe(n)
    const places = at.map((i) => outerAt(blocks, i))
    const hidden = places.filter((p) => p !== null)
    expect(hidden.length).toBe(n - 5)
    for (const p of hidden) {
      expect(p!.open).toBe(false)
      expect(p!.summary).toBe(`Earlier entries (${n - 5})`)
    }
    // the earlier rows come first (above the table), the latest five after them, in view
    expect(places.slice(0, n - 5).every((p) => p !== null)).toBe(true)
    expect(places.slice(n - 5).every((p) => p === null)).toBe(true)
    // each row keeps its own "By" (log and origins are sliced together)
    const by = [...html.matchAll(/data-origin="([^"]*)"/g)].map((m) => m[1])
    expect(by).toEqual(long.logOrigins)
  })

  it('a log of five entries or fewer has no expander', () => {
    const short = VIEWS.find((v) => v.state.log.length > 0 && v.state.log.length <= 5)
    if (!short) return
    const html = renderToStaticMarkup(createElement(CaseLogPanel, { view: short }))
    expect(detailsBlocks(html)).toEqual([])
    expect(rows(html).length).toBe(short.state.log.length)
  })
})

describe('The chance line in view keeps its rate and its basis; the multipliers and the test scale wait in the expander', () => {
  const inds = (RULES.personal?.indicators ?? []) as Indicator[]
  const line = (indicator: Indicator, brief: boolean) => text(renderToStaticMarkup(createElement(ChanceLine, { indicator, brief })))
  const rated = inds.filter((i) => chanceRateOf(i) !== null)
  const measured = rated.filter((i) => chanceDiffers(chanceRateOf(i)!))
  const nominal = rated.filter((i) => !chanceDiffers(chanceRateOf(i)!))

  it('a measured rate says "measured", a nominal one "the test’s nominal rate": a nominal rate never reads as a measured one', () => {
    expect(measured.map((i) => i.id)).toContain('pvt_lapses')
    expect(nominal.length).toBeGreaterThan(0)
    for (const i of measured) expect(line(i, true), i.id).toBe(`Chance alone: ${chanceRateOf(i)!.text} (measured).`)
    for (const i of nominal) expect(line(i, true), i.id).toBe(`Chance alone: ${chanceRateOf(i)!.text} (the test’s nominal rate).`)
  })

  it('the brief line carries no multiplier, no α and no test scale; the full line (the expander’s) still does', () => {
    for (const i of rated) expect(line(i, true), i.id).not.toMatch(/α|×|Anscombe/)
    for (const i of measured) expect(line(i, false), i.id).toMatch(/measured, not assumed: .*× .*α/)
  })
})
