// The section as a whole: the ID jump and the keyword column work with no model, every passage renders byte-equal
// to its snapshot field, no score / % / reply wording / "nothing close" appears, nothing outside imports the search,
// and the footnote's numbers are recomputed here from the frozen gold questions with the shipped code and files.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SECTIONS, SECTION_IDS, secNum } from '../method/sections'
import accuracy from './accuracy.json'
import { buildIndex, keywordSearch } from './bm25'
import { embed, embedIds, makeModel, rankByMeaning, strongestPieces, tokenIds } from './embed'
import { EXAMPLES, Footnote, Lists, PassageCard, Results } from './FindSection'
import type { Meaning } from './FindSection'
import { buildPassages, idJump, onlyIds } from './passages'

const MODEL_DIR = new URL('../../../public/assets/models/potion-base-8M-bf8b0566/', import.meta.url)
const file = (name: string): Uint8Array => readFileSync(new URL(name, MODEL_DIR))
const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
const model = makeModel(ab(file('embeddings.i8')), ab(file('scales.f32')), readFileSync(new URL('vocab.txt', MODEL_DIR), 'utf8'))
const snap = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8')).data
const v1 = snap('std_vol1_requirements')
const v2 = snap('std_vol2_requirements')
const passages = buildPassages(v1, v2)
const index = buildIndex(passages.map((p) => p.text))
const vectors = passages.map((p) => embed(p.text, model))
const goldBytes = readFileSync(new URL('./gold.json', import.meta.url))
const gold = JSON.parse(readFileSync(new URL('./gold.json', import.meta.url), 'utf8')) as {
  written_by: string
  corpus_count: number
  queries: { id: string; q: string; expected: string[]; origin: string }[]
}
const norm = (id: string) => id.replace(/^\[|\]$/g, '')

/** Visible text of server-rendered HTML: tags dropped, entities decoded. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

function meaningFor(q: string): Meaning {
  const ids = tokenIds(q, model)
  const order = rankByMeaning(embedIds(ids, model), vectors).slice(0, 3)
  return { status: 'ready', error: null, top: order.map((i) => ({ passage: passages[i], why: strongestPieces(ids, vectors[i], model) })) }
}
const render = (query: string, meaning: Meaning) => renderToStaticMarkup(createElement(Results, { query, passages, index, meaning }))
const OFF: Meaning = { status: 'offline', error: null, top: null }

describe('the corpus', () => {
  it('is the 57 frozen requirements (20 Vol 1, 37 Vol 2), [V2 6109] once', () => {
    expect(passages.length).toBe(57)
    expect(passages.filter((p) => p.vol === 1).length).toBe(20)
    expect(new Set(passages.map((p) => p.id)).size).toBe(57)
    expect(v2.requirements.filter((r: { id: string }) => r.id === '[V2 6109]').length).toBe(2)
    expect(gold.corpus_count).toBe(57)
  })
  it('each field is the snapshot’s own; the passage text is title, statement and rationale joined by spaces', () => {
    for (const p of passages) {
      const r = p.vol === 1 ? v1.requirements.find((x: { id: string }) => x.id === p.id) : v2.requirements.find((x: { id: string }) => norm(x.id) === p.id)
      expect(p.statement).toBe(r.text)
      expect(p.rationale).toBe(r.rationale)
      expect(p.title).toBe(p.vol === 1 ? r.section_title : r.title)
      expect(p.text).toBe([p.title, r.text, r.rationale].filter(Boolean).join(' '))
    }
  })
})

describe('verbatim gate: every rendered passage equals its snapshot fields byte for byte', () => {
  it.each(passages.map((p) => [p.id, p]))('%s', (_id, p) => {
    const html = renderToStaticMarkup(createElement(PassageCard, { p }))
    const quote = /<blockquote><p>([\s\S]*?)<\/p><\/blockquote>/.exec(html)![1]
    expect(textOf(quote)).toBe(`“${p.statement}”`)
    if (p.rationale) expect(textOf(/<p class="lf-find-rationale">([\s\S]*?)<\/p>/.exec(html)![1])).toBe(p.rationale)
    expect(textOf(html)).toContain(p.title)
    expect(html).toContain(`href="${p.pdfHref.replace(/&/g, '&amp;')}"`)
    expect(html).toContain(`href="#/data?id=${p.snapshot}"`)
  })
})

describe('no model needed', () => {
  it('the ID jump: “6164”, “V1 4030”, “[V2 10130]”, “v2-6109”, with the model offline', () => {
    expect(idJump('6164', passages).map((p) => p.id)).toEqual(['V2 6164'])
    expect(idJump('V1 4030', passages).map((p) => p.id)).toEqual(['V1 4030'])
    expect(idJump('[V2 10130]', passages).map((p) => p.id)).toEqual(['V2 10130'])
    expect(idJump('what does v2-6109 say', passages).map((p) => p.id)).toEqual(['V2 6109'])
    expect(idJump('V1 6164', passages)).toEqual([]) // no such Vol 1 requirement
    expect(idJump('1500 mL and 2026', passages)).toEqual([])
    const html = render('6164', OFF)
    expect(html).toContain('The requirement you named')
    expect(html).toContain('data-req="V2 6164"')
  })
  it('words that are only IDs show those requirements and rank nothing; IDs with words show both', () => {
    for (const q of ['6164', 'V1 4030', '[V2 10130]', 'v2-6109, V1 4030']) expect(onlyIds(q, passages)).toBe(true)
    for (const q of ['what does v2-6109 say', 'requirement 9023', '9999', 'V1 6164']) expect(onlyIds(q, passages)).toBe(false)
    const ids = render('[V2 10130]', OFF)
    expect(ids).toContain('data-req="V2 10130"')
    expect(ids).not.toContain('data-col=')
    expect(textOf(render('v2-6109, V1 4030', OFF))).toContain('The requirements you named')
    const both = render('what does v2-6109 say', OFF)
    expect(both).toContain('The requirement you named')
    expect(both).toContain('data-col="keywords"')
  })
  it('the keyword column renders while the model loads, when it is offline, and when it fails', () => {
    const q = 'how much drinking water per day'
    for (const meaning of [{ status: 'loading', error: null, top: null }, OFF, { status: 'error', error: 'HTTP 404 for scales.f32', top: null }] as Meaning[]) {
      const html = render(q, meaning)
      const kw = html.slice(html.indexOf('data-col="keywords"'), html.indexOf('data-col="meaning"'))
      expect(kw).toContain('data-req="V2 6109"')
      expect(textOf(html)).toContain('Your words appear in')
    }
    expect(textOf(render(q, OFF))).toContain(
      'The meaning ranking is not on this device yet (7.9 MB, downloaded once when online); the keyword column and the symptom check work without it.',
    )
  })
  it('the only “no result” wording is the keyword column’s', () => {
    expect(textOf(render('zebra pizza', OFF))).toContain('None of your words appear in them.')
    expect(textOf(render('how much drinking water per day', OFF))).not.toContain('None of your words appear in them.')
  })
  it('“Only common words” shows only when every typed word is a skipped common word', () => {
    // words outside a-z and 0-9 (Cyrillic, Greek, CJK, emoji) are not skipped as common: the keyword search cannot read them
    for (const q of ['радиация на Марсе', 'ακτινοβολία', '水の量', '🚀', '🚀🚀🚀', 'what is радиация']) {
      const t = textOf(render(q, OFF))
      expect(t).toContain('None of your words appear in them.')
      expect(t).not.toContain('Only common words')
    }
    const common = textOf(render('what is it', OFF))
    expect(common).toContain('Skipped as common: what, is, it.')
    expect(common).toContain('Only common words, which the keyword search skips.')
    expect(common).not.toContain('None of your words appear in them.')
  })
})

describe('search, not ask', () => {
  // Everything the section prints apart from NASA's own words (which may contain any of these).
  const pages = [
    ...EXAMPLES,
    'how much drinking water per day',
    'A chatbot told me the career radiation limit is 1 sievert.',
    'pain in my side and blood in my urine',
    'what dose of ibuprofen should I take',
    'zebra pizza',
    '6164',
  ].map((q) => render(q, meaningFor(q)))
  const own = [...pages, renderToStaticMarkup(createElement(Lists)), renderToStaticMarkup(createElement(Footnote))]
    .map((h) => h.replace(/<blockquote>[\s\S]*?<\/blockquote>/g, '').replace(/<p class="lf-find-rationale">[\s\S]*?<\/p>/g, ''))
    .map(textOf)
    .join('\n')
  it('no similarity score, no %, no reply wording, no “nothing close”', () => {
    expect(own).not.toMatch(/%/)
    expect(own).not.toMatch(/answer/i)
    expect(own).not.toMatch(/nothing close/i)
    expect(own).not.toMatch(/\bscore/i)
    expect(own).not.toMatch(/(?<![\d.])0\.\d{2,}/) // no cosine-like decimals
  })
  it('the meaning column shows NASA’s text closest first, three of them', () => {
    const html = render('paper backup if the computers fail', meaningFor('paper backup if the computers fail'))
    const mm = html.slice(html.indexOf('data-col="meaning"'))
    expect(mm.match(/data-req="/g)?.length).toBe(3)
    expect(mm).toContain('data-req="V2 10130"')
  })
})

describe('isolation', () => {
  const walk = (dir: URL): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules') return []
      const u = new URL(name, dir)
      if (/\.(ts|tsx)$/.test(name)) return [u.pathname]
      if (!name.includes('.')) {
        try {
          return walk(new URL(`${name}/`, dir))
        } catch {
          return []
        }
      }
      return []
    })
  it('nothing in engine/, app/ or another feature imports features/find (method/index.tsx renders the panel)', () => {
    const offenders = walk(new URL('../../', import.meta.url))
      .filter((f) => !f.includes('/features/find/'))
      .filter((f) => /from '[^']*\/find\/|from '\.\.\/find'|import\('[^']*\/find\//.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(f.indexOf('/src/')))
    expect(offenders).toEqual(['/src/features/method/index.tsx'])
    expect(readFileSync(new URL('../method/index.tsx', import.meta.url), 'utf8')).toMatch(/import \{ FindPanel \} from '\.\.\/find\/FindPanel'/)
  })
  it('the search reads no observation, no case and dispatches no event', () => {
    const src = walk(new URL('./', import.meta.url))
      .filter((f) => !/\.test\.ts$/.test(f) && !f.endsWith('.d.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    expect(src).not.toMatch(/app\/model'|app\/mission'|app\/evaluate'|app\/caseTimeline'|useCases|dispatch\(|Observation\b/)
  })
})

describe('styles', () => {
  const css = readFileSync(new URL('./find.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  it('tokens only, and only the font faces the service worker precaches (Inter 400/600)', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
    for (const m of css.matchAll(/font-weight:\s*(\w+)/g)) expect(['400', '600', 'normal']).toContain(m[1])
    expect(css).not.toMatch(/--lf-sev-(warning|caution|advisory|emergency)/) // nothing here is an alert
  })
})

describe('the method page', () => {
  it('appends the section last, so sections 1-9 keep their numbers', () => {
    expect(SECTIONS.at(-1)).toEqual({ s: 'find', label: "Find it in NASA's words" })
    expect(secNum('find')).toBe(10)
    expect(SECTION_IDS.slice(0, 9)).toEqual(['gap', 'limits', 'tiers', 'severity', 'refusals', 'data', 'architecture', 'coverage', 'limitations'])
  })
})

describe('accuracy on the frozen gold questions (the footnote’s numbers)', () => {
  it('gold.json is the blind agent’s file, unedited: its SHA-256, size and origin', () => {
    const sha = createHash('sha256').update(goldBytes).digest('hex')
    expect(sha).toBe(accuracy.gold_sha256)
    expect(sha).toBe('319bc3c95e286cd66ebb85f39842b617ed6e1a1448cecc0a8451ad8c19fa44cd')
    expect(readFileSync(new URL('../../../../tools/find/README.md', import.meta.url), 'utf8')).toContain(sha)
    expect(gold.queries.length).toBe(accuracy.queries)
    expect(gold.written_by).toBe(accuracy.written_by)
    expect(gold.queries.every((g) => g.origin === 'agent-written')).toBe(true)
    for (const g of gold.queries) for (const e of g.expected) expect(passages.map((p) => p.id)).toContain(norm(e))
  })
  it('recomputes every number with the shipped code and model files', () => {
    const c = { keywords: { top1: 0, top3: 0 }, meaning: { top1: 0, top3: 0 }, either: { top1: 0, top3: 0 } }
    for (const g of gold.queries) {
      const want = g.expected.map(norm)
      const kw = keywordSearch(index, g.q).map((h) => passages[h.index].id)
      const mm = rankByMeaning(embed(g.q, model), vectors).map((i) => passages[i].id)
      const hit = (list: string[], k: number) => list.slice(0, k).some((x) => want.includes(x))
      for (const k of [1, 3] as const) {
        const key = k === 1 ? 'top1' : 'top3'
        if (hit(kw, k)) c.keywords[key] += 1
        if (hit(mm, k)) c.meaning[key] += 1
        if (hit(kw, k) || hit(mm, k)) c.either[key] += 1
      }
    }
    expect(c).toEqual({ keywords: accuracy.keywords, meaning: accuracy.meaning, either: accuracy.either })
    expect(c).toEqual({ keywords: { top1: 14, top3: 16 }, meaning: { top1: 15, top3: 20 }, either: { top1: 19, top3: 22 } })
  })
  it('passes the gate: the meaning column’s top 3 holds an expected requirement for at least 70% of the questions', () => {
    expect(accuracy.meaning.top3).toBeGreaterThanOrEqual(Math.ceil(0.7 * accuracy.queries))
  })
  it('the footnote prints them, and who wrote the questions', () => {
    const t = textOf(renderToStaticMarkup(createElement(Footnote)))
    expect(t).toContain('Tested on 24 questions written by an AI agent (Claude Code), blind to the search tool, before its first run')
    expect(t).toContain('Your words appear in (keywords)14 of 2416 of 24')
    expect(t).toContain('Closest in meaning (model)15 of 2420 of 24')
    expect(t).toContain('Either column19 of 2422 of 24')
    expect(t).toContain('7.9 MB')
    expect(t).toContain('bf8b0566')
  })
})
