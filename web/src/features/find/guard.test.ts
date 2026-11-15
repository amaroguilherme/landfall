// The symptom check: 100% on its vectors. Every renal red flag and urgent symptom, verbatim, raises the Crew Medical
// Officer banner, as do the colloquial forms and a negated mention; medication, diagnosis and cancer-risk words show
// the rules' refusal verbatim; "dose" alone (radiation dose) does not. The banner needs no model and comes first.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SYMPTOMS, URGENT_SYMPTOMS, symptomLabel } from '../noon-sight/record'
import { buildIndex } from './bm25'
import { GuardNote, Results, SearchStatus, bannerLead, searchStatus } from './FindSection'
import { GUARD_PHRASES, RED_FLAGS, TELL_CMO, URGENT_IDS, URGENT_LABELS, guardBanners, guardHits, refusalText } from './guard'
import type { GuardKind } from './guard'
import { buildPassages } from './passages'

const rules = (f: string) => JSON.parse(readFileSync(new URL(`../../../../engine/rules/${f}`, import.meta.url), 'utf8'))
const r4 = (rules('cases.json').cases as { id: string; procedure: { id: string; text: string; red_flags?: string[] }[] }[])
  .find((c) => c.id === 'renal_stone')!
  .procedure.find((s) => s.id === 'r4')!
const refusals = rules('meta.json').refusals as { id: string; text: string }[]
const kinds = (text: string): GuardKind[] => guardBanners(text).map((b) => b.kind)
/** Visible text of server-rendered HTML: tags dropped, entities decoded. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
const snap = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8')).data
const passages = buildPassages(snap('std_vol1_requirements'), snap('std_vol2_requirements'))

// [typed words, the banners that must show, in order]
const VECTORS: [string, GuardKind[]][] = [
  ['pain in my side and blood in my urine', ['symptom']],
  ['blood in my pee', ['symptom']],
  ['it burns when I pee', ['symptom']],
  ['my side hurts', ['symptom']],
  ['I threw up twice', ['symptom']],
  ['tight chest', ['symptom']],
  ["I can't catch my breath", ['symptom']],
  ['can’t catch my breath', ['symptom']],
  ['blurry vision since this morning', ['symptom']],
  ['no blood in my urine', ['symptom']],
  ['NO FEVER OR CHILLS.', ['symptom']],
  // each half of a red flag that reads "A or B", and common forms of them
  ['pain when passing urine', ['symptom']],
  ['burning when passing urine', ['symptom']],
  ['pain when urinating', ['symptom']],
  ['burning when urinating', ['symptom']],
  ['pain in the side', ['symptom']],
  ['pain in the back', ['symptom']],
  ['nauseated', ['symptom']],
  ['I feel nauseated', ['symptom']],
  ['red urine', ['symptom']],
  ['urine is red', ['symptom']],
  ['my urine is red', ['symptom']],
  ['what dose of ibuprofen should I take', ['no_dosing']],
  ['can I take aspirin for a headache', ['no_dosing']],
  ['what is my cancer risk', ['no_reid']],
  ['REID model for my exposure', ['no_reid']],
  ['do I have a kidney stone', ['no_diagnosis']],
  ['do I have an infection', ['no_diagnosis']],
  ['chest pain, do I have a heart problem? what medicine', ['symptom', 'no_dosing', 'no_diagnosis']],
  // an ordinary question: "do I have to" is not "do I have a"
  ['Do I have to wear a dosimeter', []],
  ['Do I have to wear a dosimeter during EVA?', []],
  ['radiation dose limit', []],
  ['blood pressure cuff', []],
  ['how much drinking water per day', []],
  ['skin temperature that causes pain', []],
  ['an outdated reading on a display', []],
  ['electric shock from a medical sensor', []],
  ['paper backup if the computers fail', []],
  ['career dose of 600 mSv', []],
  ['', []],
]

describe('imported words, verbatim', () => {
  it('the six renal red flags are cases.json renal_stone r4 red_flags, in file order', () => {
    expect(RED_FLAGS).toEqual(r4.red_flags)
    expect(RED_FLAGS.length).toBe(6)
  })
  it('the urgent symptoms are record.ts URGENT_SYMPTOMS, labelled as the Noon Sight labels them', () => {
    expect([...URGENT_IDS]).toEqual([...URGENT_SYMPTOMS])
    expect(URGENT_LABELS).toEqual(URGENT_SYMPTOMS.map((id) => symptomLabel(id)))
    expect(URGENT_LABELS).toEqual(URGENT_SYMPTOMS.map((id) => SYMPTOMS.find((s) => s.id === id)!.label))
  })
  it('whom to tell is r4’s own clause: “tell your Crew Medical Officer now (if that is you, the Commander)”', () => {
    expect(TELL_CMO).toBe('tell your Crew Medical Officer now (if that is you, the Commander)')
    expect(r4.text).toContain(TELL_CMO!)
  })
  it('the refusals are meta.json’s, verbatim', () => {
    for (const id of ['no_dosing', 'no_diagnosis', 'no_reid']) expect(refusalText(id)).toBe(refusals.find((r) => r.id === id)!.text)
  })
  it('the printed list is the imported words, then guard.lexicon.json', () => {
    expect(GUARD_PHRASES.symptom.slice(0, 9)).toEqual([...RED_FLAGS, ...URGENT_LABELS])
    expect(GUARD_PHRASES.no_dosing).not.toContain('dose')
  })
})

describe('the guard vectors (100%)', () => {
  it.each([...RED_FLAGS, ...URGENT_LABELS])('“%s”, verbatim, raises the Crew Medical Officer banner', (label) => {
    expect(kinds(label)).toEqual(['symptom'])
  })
  it.each(VECTORS)('“%s” -> %j', (text, expected) => {
    expect(kinds(text)).toEqual(expected)
  })
  it('keeps the longest phrase where matches overlap, segment by segment', () => {
    expect(guardHits('fever or chills')).toEqual([{ kind: 'symptom', words: 'fever or chills' }])
    expect(guardHits('fever. chills')).toEqual([
      { kind: 'symptom', words: 'fever' },
      { kind: 'symptom', words: 'chills' },
    ])
    expect(guardBanners('pain in my side and blood in my urine')[0].words).toEqual(['pain in my side', 'blood in my urine'])
    // the banner quotes the phrase as listed: the typed words up to case and punctuation
    expect(guardBanners('I CAN’T catch my breath!')[0].words).toEqual(["can't catch my breath"])
    expect(guardBanners('No fever or chills.')[0].words).toEqual(['fever or chills'])
    // a whole red flag still beats its halves
    expect(guardBanners('pain or burning when passing urine')[0].words).toEqual(['pain or burning when passing urine'])
    expect(guardBanners('pain in the side or back (flank)')[0].words).toEqual(['pain in the side or back (flank)'])
    expect(guardBanners('my urine is red')[0].words).toEqual(['urine is red'])
  })
})

describe('the banners', () => {
  const html = (text: string) => guardBanners(text).map((b) => renderToStaticMarkup(createElement(GuardNote, { banner: b }))).join('')
  it('symptom words: the words, what the search is not, and whom to tell', () => {
    const h = textOf(html('pain in my side and blood in my urine'))
    expect(h).toContain('Your words include “pain in my side”, “blood in my urine”.')
    expect(h).toContain('This search reads NASA’s standard; it does not assess symptoms. If you have it now, tell your Crew Medical Officer now (if that is you, the Commander).')
  })
  it('what dose of ibuprofen should I take: the no_dosing refusal, verbatim', () => {
    const text = textOf(html('what dose of ibuprofen should I take'))
    expect(text).toContain('Your words include “ibuprofen”.')
    expect(text).toContain(refusals.find((r) => r.id === 'no_dosing')!.text)
  })
  it('what is my cancer risk: no_reid; do I have a kidney stone: no_diagnosis', () => {
    expect(textOf(html('what is my cancer risk'))).toContain(refusals.find((r) => r.id === 'no_reid')!.text)
    expect(textOf(html('do I have a kidney stone'))).toContain(refusals.find((r) => r.id === 'no_diagnosis')!.text)
  })
  it('render with the model off and before both columns', () => {
    for (const status of ['offline', 'error', 'loading'] as const) {
      const h = renderToStaticMarkup(
        createElement(Results, {
          query: 'pain in my side and blood in my urine',
          passages,
          index: buildIndex(passages.map((p) => p.text)),
          meaning: { status, error: status === 'error' ? 'HTTP 404' : null, top: null },
        }),
      )
      const banner = h.indexOf('lf-find-guard')
      expect(banner).toBeGreaterThanOrEqual(0)
      expect(banner).toBeLessThan(h.indexOf('data-col="keywords"'))
      expect(h.indexOf('data-col="keywords"')).toBeLessThan(h.indexOf('data-col="meaning"'))
    }
  })
})

describe('the search status, a live region always in the page', () => {
  const status = (query: string | null) => renderToStaticMarkup(createElement(SearchStatus, { query }))
  it('is in the page, empty, before the first search', () => {
    expect(status(null)).toBe('<p class="sr-only" role="status" data-find-status=""></p>')
  })
  it('announces the first sentence of every banner the words raise, then the query', () => {
    const q = 'chest pain, do I have a heart problem? what medicine'
    const leads = guardBanners(q).map(bannerLead)
    expect(leads).toEqual([
      'Your words include “Chest pain”.', // the Noon Sight's label, as listed
      'Your words include “medicine”.',
      'Your words include “do I have a”.',
    ])
    expect(searchStatus(q)).toBe(`${leads.join(' ')} Results for ${q}.`)
    expect(textOf(status(q))).toBe(searchStatus(q))
    // the banner itself opens with the same sentence
    for (const b of guardBanners(q)) {
      const h = textOf(renderToStaticMarkup(createElement(GuardNote, { banner: b })))
      expect(h.startsWith(bannerLead(b)), b.kind).toBe(true)
    }
  })
  it('says only the query when no banner fires', () => {
    expect(searchStatus('Do I have to wear a dosimeter')).toBe('Results for Do I have to wear a dosimeter.')
  })
})
