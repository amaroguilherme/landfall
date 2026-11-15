// The closest NASA comes, as the app renders it: on #/band beside each searched negative, and on
// #/method?s=gap after the delegation quotes. The ranking is frozen in nearest.json by tools/nearest/rank.py;
// these tests check what reaches the screen against that file, the review, the notes and the keyword counts.
import { readFileSync, readdirSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import Band from '../band'
import { SENSOR_MAP } from '../band/map'
import { GapSection } from '../method/GapSection'
import { META } from '../method/rules'
import {
  CHECKED_LABEL,
  CHECKED_ON,
  COVERAGE,
  NAMED_LABEL,
  NEAREST,
  NEAREST_NOTES,
  NearestList,
  nearestClaim,
  summaryFor,
} from './NearestList'

// The gap section reads the two standards' snapshots through useSnapshot, which server rendering leaves
// 'loading'. Serve the frozen files instead, so the delegation quotes render as they do in the browser.
vi.mock('../../app/data', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../app/data')>()
  const fs = await import('node:fs')
  const read = (id: string) =>
    JSON.parse(fs.readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8')) as { data: unknown }
  const snaps: Record<string, { data: unknown }> = {
    std_vol1_requirements: read('std_vol1_requirements'),
    std_vol2_requirements: read('std_vol2_requirements'),
  }
  return {
    ...mod,
    useSnapshot: (id: string | null) => {
      const s = id ? snaps[id] : undefined
      return s
        ? { status: 'ready', snapshot: s, data: s.data, error: null }
        : { status: 'loading', snapshot: null, data: null, error: null }
    },
  }
})

// node:fs is typed by web/src/engine/node-fs.d.ts (readdirSync and readFileSync only), so paths are URLs.
const ROOT = new URL('../../../../', import.meta.url)
const readJson = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, ROOT), 'utf8')) as T

const CLAIMS = ['emc', 'biocompat', 'sensor_set', 'battery', 'storage', 'alert_number']
// As measured on 15 Nov 2026 (tools/nearest/README.md); review.json rejected none, so nothing moved up.
const SHOWN: Record<string, string[]> = {
  emc: ['V2 6102', 'V2 9022', 'V1 4032', 'V2 9128', 'V2 9018'],
  biocompat: ['V2 11125', 'V1 3002', 'V1 5003', 'V2 7045', 'V2 11024'],
  sensor_set: ['V2 7038', 'V2 6088', 'V1 3003', 'V2 7040', 'V1 4005'],
  battery: ['V2 10123', 'V2 9043', 'V2 9017', 'V2 9039', 'V2 9018'],
  storage: ['V2 9120', 'V2 7071', 'V2 6014', 'V2 7060', 'V2 6020'],
  alert_number: ['V2 6088', 'V2 6153', 'V2 6023', 'V1 3006', 'V1 4005'],
}

/** Text content of server-rendered markup: tags dropped, the entities React writes decoded. */
function textOf(html: string): string {
  return html
    .replace(/<span class="sr-only">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const listHtml = (claim: string) => renderToStaticMarkup(createElement(NearestList, { claim }))
/** Each card's markup, in order. */
const cardsOf = (html: string) => html.split('<li class="lf-near-item"').slice(1)
const quoteOf = (card: string) => textOf(/<blockquote><p>(.*?)<\/p><\/blockquote>/s.exec(card)![1])

describe('nearest.json, frozen at build time', () => {
  it('has six claims of five passages each, ranked 1 to 5, as measured', () => {
    expect(NEAREST.claims.map((c) => c.claim_id)).toEqual(CLAIMS)
    for (const c of NEAREST.claims) {
      expect(c.items.map((it) => it.rank), c.claim_id).toEqual([1, 2, 3, 4, 5])
      expect(c.items.map((it) => it.id), c.claim_id).toEqual(SHOWN[c.claim_id])
      expect(c.corpus_size).toBe(543)
      expect(c.revision.startsWith('bf8b0566')).toBe(true)
    }
  })
  it('stores no score: every number in it is an integer', () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'number') expect(Number.isInteger(node), path).toBe(true)
      else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`))
      else if (node && typeof node === 'object')
        for (const [k, v] of Object.entries(node)) {
          expect(k, path).not.toMatch(/score|cosine|similar|distance|prob|confidence/i)
          walk(v, `${path}.${k}`)
        }
    }
    walk(NEAREST, '$')
  })
})

describe('the list for each claim', () => {
  it('is a closed Expander labelled as a ranking, not proof', () => {
    for (const claim of CLAIMS) {
      const html = listHtml(claim)
      expect(html.startsWith(`<div class="lf-near" data-claim="${claim}"><details class="lf-expander"><summary>`), claim).toBe(true)
      expect(/<details[^>]*\bopen\b/.test(html), claim).toBe(false)
      expect(textOf(html), claim).toContain('The five requirements closest in meaning (ranked by a model: a ranking, not proof)')
      expect(summaryFor(nearestClaim(claim)!)).toContain('a ranking, not proof')
    }
  })
  it('links to Find it in NASA’s words (#/method?s=find), after the list and before the footnotes', () => {
    for (const claim of CLAIMS) {
      const html = listHtml(claim)
      const link = '<a href="#/method?s=find">Try your own words: Find it in NASA’s words →</a>'
      expect(html.split(link), claim).toHaveLength(2)
      expect(html.indexOf('</ol>'), claim).toBeLessThan(html.indexOf(link))
      expect(html.indexOf(link), claim).toBeLessThan(html.indexOf('Ranked at build time by'))
    }
  })
  it('shows no cosine, score or percentage anywhere, only the rank', () => {
    for (const claim of CLAIMS) {
      const html = listHtml(claim)
      expect(html, claim).not.toMatch(/cosine|score|similarit|%/i)
      expect(html.match(/<ol class="lf-near-list">/g), claim).toHaveLength(1)
    }
  })
  it('prints each statement byte-equal to nearest.json, closest first, with its PDF page', () => {
    for (const c of NEAREST.claims) {
      const cards = cardsOf(listHtml(c.claim_id))
      expect(cards).toHaveLength(c.items.length)
      c.items.forEach((it, i) => {
        expect(cards[i].startsWith(` data-req="${it.id}">`), it.id).toBe(true)
        expect(quoteOf(cards[i]), it.id).toBe(`“${it.statement}”`)
        expect(textOf(cards[i]), it.id).toContain(`[${it.id}]§${it.section} ${it.title}`)
        expect(cards[i], it.id).toContain(`href="${escapeHtml(it.pdf_url)}"`)
        expect(it.pdf_url.endsWith(`#page=${it.pdf_page}`), it.id).toBe(true)
        expect(textOf(cards[i]), it.id).toContain(`PDF p. ${it.pdf_page}`)
      })
    }
  })
  it("badges the 57 frozen requirements 'verified' and the others with the review date", () => {
    for (const c of NEAREST.claims) {
      cardsOf(listHtml(c.claim_id)).forEach((card, i) => {
        const it = c.items[i]
        const t = textOf(card)
        if (it.frozen) {
          expect(t, it.id).toContain('· verified')
          expect(t, it.id).not.toContain(CHECKED_LABEL)
        } else expect(t, it.id).toContain(`· ${CHECKED_LABEL}`)
        expect(t, it.id).not.toMatch(/by us/)
      })
    }
  })
  it("marks exactly the requirements the page already names beside the claim: 'also named above'", () => {
    const flagged: string[] = []
    for (const c of NEAREST.claims) {
      cardsOf(listHtml(c.claim_id)).forEach((card, i) => {
        const it = c.items[i]
        expect(textOf(card).includes(NAMED_LABEL), it.id).toBe(it.also_named_by_us)
        if (it.also_named_by_us) flagged.push(`${c.claim_id} ${it.id}`)
      })
    }
    expect(flagged).toEqual(['emc V2 6102', 'alert_number V2 6153'])
    // The band: sensor-map.json negatives[].nearest, named in the claim's detail line above the list.
    for (const n of SENSOR_MAP.negatives) {
      for (const id of n.nearest) expect(n.detail, n.id).toContain(`[${id}]`)
    }
  })
  it('gives the query, the model, its revision, the corpus and the labelled check in the footnote', () => {
    const lc = NEAREST.labelled_check
    expect([lc.in_top_five, lc.of]).toEqual([1, 6])
    for (const c of NEAREST.claims) {
      const t = textOf(listHtml(c.claim_id))
      expect(t).toContain(`one sentence we wrote before the run: “${c.query}”`)
      expect(t).toContain(
        'Ranked at build time by potion-base-8M (MinishLab, revision bf8b0566) over 543 of the 545 requirements of ' +
          'NASA-STD-3001 (76 of 77 in Vol 1 Rev C, 467 of 468 in Vol 2 Rev F), by closeness in meaning',
      )
      expect(t).toContain('Only the rank is kept. Not ranked: [V1 5002] and [V2 10157], which LANDFALL’s PDF parsers miss.')
      expect(t).toContain("Labelled check: of the 6 requirements we had named by hand beside these claims, 1 is in the model’s top five.")
    }
    expect(textOf(listHtml('biocompat'))).toContain('Named by hand for this claim and ranked lower: [V2 7076] at rank 151, [V2 7081] at rank 14.')
    expect(textOf(listHtml('alert_number'))).toContain(
      'Named by hand for this claim and ranked lower: [V2 6164] at rank 7, [V2 6022] at rank 165, [V2 11036] at rank 18.',
    )
    expect(textOf(listHtml('emc'))).not.toContain('ranked lower')
  })
  it('says what the ranking covers: each volume’s count, less the requirements the parsers miss', () => {
    // coverage.json is recounted in the cached PDFs by ingest/tests/test_nearest.py.
    expect(COVERAGE.map((v) => [v.doc, v.requirements, v.not_ranked])).toEqual([
      ['NASA-STD-3001 Vol 1 Rev C', 77, ['V1 5002']],
      ['NASA-STD-3001 Vol 2 Rev F', 468, ['V2 10157']],
    ])
    expect(NEAREST.corpus.map((s) => s.doc)).toEqual(COVERAGE.map((v) => v.doc))
    NEAREST.corpus.forEach((s, i) => expect(s.count, s.doc).toBe(COVERAGE[i].requirements - COVERAGE[i].not_ranked.length))
    const ranked = new Set(NEAREST.claims.flatMap((c) => c.items.map((it) => it.id)))
    for (const v of COVERAGE) for (const id of v.not_ranked) expect(ranked.has(id), id).toBe(false)
  })
  it('renders nothing for a claim that has no ranking', () => {
    expect(listHtml('no_such_claim')).toBe('')
  })
})

describe('the review and the notes', () => {
  type Verdict = { claim_id?: string; id: string; verdict: string; date: string }
  const review = readJson<{ passages: Verdict[] }>('tools/nearest/review.json').passages
  it(`has an 'ok' verdict dated ${CHECKED_ON} for every shown passage that is not frozen`, () => {
    let n = 0
    for (const c of NEAREST.claims) {
      for (const it of c.items) {
        if (it.frozen) continue
        const v = review.filter((x) => x.id === it.id && (x.claim_id ?? c.claim_id) === c.claim_id)
        expect(v.length, `${c.claim_id} ${it.id}`).toBeGreaterThan(0)
        for (const x of v) expect([x.verdict, x.date], `${c.claim_id} ${it.id}`).toEqual(['ok', '2026-11-15'])
        n++
      }
    }
    expect(n).toBe(20)
    expect(CHECKED_ON).toBe('15 Nov 2026')
  })
  it('attaches each note to a shown passage of its claim, under that card', () => {
    expect(NEAREST_NOTES.map((n) => `${n.claim_id} ${n.about}`)).toEqual(['sensor_set V2 6088', 'storage V2 6020'])
    for (const n of NEAREST_NOTES) {
      const c = nearestClaim(n.claim_id)!
      const i = c.items.findIndex((it) => it.id === n.about)
      expect(i, n.about).toBeGreaterThanOrEqual(0)
      const cards = cardsOf(listHtml(n.claim_id))
      cards.forEach((card, j) => expect(textOf(card).includes(`LANDFALL’s note: ${n.text}`), `${n.claim_id} ${j}`).toBe(i === j))
    }
  })
  it('quotes NASA only verbatim: every quoted phrase is listed, and the shown statements contain theirs', () => {
    for (const n of NEAREST_NOTES) {
      const quoted = [...n.text.matchAll(/“([^”]+)”/g)].map((m) => m[1])
      expect(quoted.length, n.about).toBeGreaterThan(0)
      expect(quoted.sort(), n.about).toEqual(n.quotes.map((q) => q.text).sort())
      for (const q of n.quotes) {
        const shown = NEAREST.claims.flatMap((c) => c.items).find((it) => it.id === q.id)
        if (q.in === 'statement' && shown) expect(shown.statement, q.text).toContain(q.text)
      }
      // The rest (rationales, requirements not shown) is checked against the PDF in ingest/tests/test_nearest.py.
    }
  })
  it("words the storage note as the lead decided, beside the narrowed claim", () => {
    const n = NEAREST_NOTES.find((x) => x.claim_id === 'storage')!
    expect(n.text).toMatch(/^\[V2 6020\] requires “[^”]+” to be recorded automatically for “[^”]+”; it sets no capacity, retention or duration\. The ranking surfaced it, and we narrowed this claim\.$/)
    const neg = SENSOR_MAP.negatives.find((x) => x.id === 'storage')!
    expect(neg.claim).toBe('No storage-capacity, retention or log-duration requirement in Vol 2 Rev F.')
  })
})

describe('#/band: under each searched negative, after its keyword line', () => {
  const html = renderToStaticMarkup(createElement(Band, { params: {}, query: {} }))
  it('renders the keyword line first, then the closed list, for all five negatives', () => {
    expect(SENSOR_MAP.negatives.map((n) => n.id)).toEqual(CLAIMS.slice(0, 5))
    const start = html.indexOf('id="band-neg-h"')
    expect(start).toBeGreaterThan(0)
    const section = html.slice(start, html.indexOf('</section>', start))
    const parts = section.split('<p class="band-neg-claim">').slice(1)
    expect(parts).toHaveLength(5)
    parts.forEach((part, i) => {
      const n = SENSOR_MAP.negatives[i]
      expect(textOf(part.slice(0, part.indexOf('</p>'))), n.id).toBe(n.claim)
      const searchAt = part.indexOf(`Search <code>${escapeHtml(n.pattern)}</code> over all 398 pages`)
      const listAt = part.indexOf(`<div class="lf-near" data-claim="${n.id}">`)
      expect(searchAt, n.id).toBeGreaterThan(0)
      expect(listAt, n.id).toBeGreaterThan(searchAt)
      expect(part.slice(listAt).startsWith(`<div class="lf-near" data-claim="${n.id}"><details class="lf-expander"><summary>`), n.id).toBe(true)
      expect(part.match(/<div class="lf-near" data-claim=/g), n.id).toHaveLength(1)
    })
    expect(html.match(/<div class="lf-near" data-claim=/g)).toHaveLength(5)
  })
  it('keeps the keyword counts as they were: the ranking adds passages, never a count', () => {
    const vol2 = readJson<{ data: { negatives: { claim: string; pattern: string; hit_count: number }[] } }>(
      'web/public/data/std_vol2_requirements.json',
    ).data.negatives
    for (const n of SENSOR_MAP.negatives) {
      const s = vol2.find((x) => x.pattern === n.pattern)!
      expect(s.hit_count, n.id).toBe(n.hits)
      expect(html, n.id).toContain(`over all 398 pages: <span class="lf-num"`)
    }
    expect(vol2.find((x) => x.pattern.startsWith('data storage'))!.claim).toBe('No storage capacity / log duration / retention requirement')
  })
})

describe('#/method?s=gap: after the delegation quotes', () => {
  const html = renderToStaticMarkup(createElement(GapSection, { meta: META! }))
  it('follows the quoted alert requirements and the volume reading', () => {
    const listAt = html.indexOf('<div class="lf-near" data-claim="alert_number">')
    const quotesAt = html.indexOf('<ol class="lf-m-reqs">')
    const readingAt = html.indexOf('The snapshot builder’s reading of each whole volume')
    expect(quotesAt).toBeGreaterThan(0)
    expect(readingAt).toBeGreaterThan(quotesAt)
    expect(listAt).toBeGreaterThan(readingAt)
    const principle = META!.principles.find((p) => p.id === 'no_nasa_alert_thresholds')!
    for (const id of principle.requirement_ids) {
      const at = html.indexOf(`<li class="lf-m-req"><p class="lf-m-req-head"><span class="lf-req">[${id}]</span>`)
      expect(at, id).toBeGreaterThan(quotesAt)
      expect(at, id).toBeLessThan(listAt)
    }
    expect(html.match(/<div class="lf-near" data-claim=/g)).toHaveLength(1)
    // [V2 6153] is 'also named above' because the volume reading names it.
    expect(textOf(html.slice(readingAt, listAt))).toContain('[V2 6153]')
  })
  it('adds no note of its own under the list, so the volume reading above stays the one reading of [V2 6153]', () => {
    expect(NEAREST_NOTES.some((n) => n.claim_id === 'alert_number')).toBe(false)
    const listAt = html.indexOf('<div class="lf-near" data-claim="alert_number">')
    expect(listAt).toBeGreaterThan(0)
    expect(html.slice(listAt)).not.toContain('lf-near-note')
  })
})

describe('the ranking stays out of the decision path and out of the snapshots', () => {
  const sources = import.meta.glob<string>(['../../engine/**/*.{ts,tsx}', '../../app/**/*.{ts,tsx}'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })
  it('nothing under web/src/engine or web/src/app imports features/nearest', () => {
    const files = Object.keys(sources)
    expect(files.some((f) => f.startsWith('../../engine/'))).toBe(true)
    expect(files.some((f) => f.startsWith('../../app/'))).toBe(true)
    for (const f of files) expect(sources[f], f).not.toMatch(/features\/nearest|from '\.\.?\/nearest/)
  })
  it('#/data lists 27 snapshots (26 plus sol 242’s), and no ranking is among them', () => {
    const m = readJson<{ snapshots: { id: string; file: string }[] }>('web/public/data/manifest.json')
    expect(m.snapshots).toHaveLength(27)
    expect(m.snapshots.map((s) => s.id)).toContain('sep_conjunction_2013')
    expect(m.snapshots.some((s) => /nearest/.test(s.id + s.file))).toBe(false)
    expect(readdirSync(new URL('web/public/data/', ROOT)).some((f) => /nearest/.test(f))).toBe(false)
  })
})
