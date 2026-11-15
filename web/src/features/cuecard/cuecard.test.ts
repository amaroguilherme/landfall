// Cue cards ([V2 10130]): the card is the shipped rules, verbatim, and nothing else.
// The rules and the std_vol2 snapshot are read from disk here (node:fs), independently of the bundled imports
// the card is built from, and the rendered paper is checked as HTML (react-dom/server).
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RULES, formatMet } from '../../app/engine'
import type { CaseDef, Rules } from '../../app/engine'
import { MET_NOW_S } from '../../app/scenario'
import { CREW } from '../../app/vocab'
import { CueCardView } from './index'
import {
  NEVER_PRINT_DOSE,
  NEVER_PRINT_DRUGS,
  RULE_FILE_ORDER,
  TEMPLATE,
  binderOrder,
  collectAtoms,
  cueCard,
  fill,
  formatValue,
  isRefusalAtom,
  neverPrintList,
  notBuiltReason,
  resolvePath,
  rulesCanonical,
  rulesDigest,
  shortDigest,
  srcKey,
  templateText,
} from './model'
import type { Atom, CueCard, Vol2Snapshot } from './model'

type Json = Record<string, unknown>
const readJson = (rel: string): Json => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as Json
const DISK = Object.fromEntries(RULE_FILE_ORDER.map((k) => [k, readJson(`../../../../engine/rules/${k}.json`)])) as Record<(typeof RULE_FILE_ORDER)[number], Json>
const VOL2 = readJson('../../../public/data/std_vol2_requirements.json') as Vol2Snapshot & Json
const diskCases = (DISK.cases.cases as Array<Json & { id: string }>)
const diskMeta = DISK.meta as { escalation: { tiers: Array<{ label: string; when: string; tier: number; backup?: unknown }> }; refusals: Array<{ id: string; text: string }> }

const OPTS = { digest: 'ab'.repeat(32), date: '2026-11-15', metExample: formatMet(MET_NOW_S) }
const build = (def: CaseDef, rules: Rules = RULES, opts = OPTS) => cueCard(def, rules, { std_vol2_requirements: VOL2 }, opts)
const CARDS: CueCard[] = (RULES.cases!.cases as CaseDef[]).map((d) => build(d))
const cardOf = (id: string) => CARDS.find((c) => c.caseId === id)!

// ---- the rendered paper, as text ----------------------------------------------------------------

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' })[e]!)

interface Rendered {
  html: string
  /** Every text node, decoded, in order. */
  texts: string[]
  /** Text nodes that are not inside an element carrying data-src (must be whitespace only). */
  stray: string[]
  /** All text, whitespace collapsed. */
  flat: string
}

function render(card: CueCard): Rendered {
  const html = renderToStaticMarkup(createElement(CueCardView, { card }))
  const stack: boolean[] = []
  const texts: string[] = []
  const stray: string[] = []
  for (const m of html.matchAll(/<[^>]+>|[^<]+/g)) {
    const tok = m[0]
    if (tok.startsWith('</')) {
      stack.pop()
    } else if (tok.startsWith('<')) {
      if (tok.endsWith('/>')) continue
      stack.push((stack.length ? stack[stack.length - 1] : false) || /\sdata-src="/.test(tok))
    } else {
      const text = decode(tok)
      texts.push(text)
      if (text.trim() && !(stack.length && stack[stack.length - 1])) stray.push(text)
    }
  }
  return { html, texts, stray, flat: texts.join('').replace(/\s+/g, ' ') }
}

const RENDERED = new Map(CARDS.map((c) => [c.caseId, render(c)]))
const flatOf = (id: string) => RENDERED.get(id)!.flat
const norm = (s: string) => s.replace(/\s+/g, ' ')

// =============================================================================================

describe('cue cards: one per case, the rules verbatim', () => {
  it('builds a card for every case in cases.json', () => {
    expect(CARDS.map((c) => c.caseId)).toEqual(diskCases.map((c) => c.id))
    expect(diskCases.length).toBeGreaterThan(0)
  })

  describe.each(diskCases.map((c) => [c.id, c] as const))('%s', (id, diskCase) => {
    const card = cardOf(id)
    const flat = flatOf(id)
    const steps = diskCase.procedure as Array<{ id: string; text: string; required?: boolean; red_flag?: boolean; red_flags?: string[]; input?: { unit: string } }>

    it('prints every procedure step verbatim, in order', () => {
      expect(card.steps.map((s) => s.text.text)).toEqual(steps.map((s) => s.text))
      let at = -1
      for (const s of steps) {
        const i = flat.indexOf(norm(s.text))
        expect(i, s.id).toBeGreaterThan(at)
        at = i
      }
    })

    it('tags required and red-flag steps in words (F.5.10 e: an additional cue), and only those', () => {
      for (const s of steps) {
        const item = card.steps.find((x) => x.id === s.id)!
        expect(item.tags.some((t) => t.kind === 'required' && t.text.text === TEMPLATE.required), s.id).toBe(s.required === true)
        expect(item.tags.some((t) => t.kind === 'red_flag' && t.text.text === TEMPLATE.redFlag), s.id).toBe(s.red_flag === true)
      }
      const html = RENDERED.get(id)!.html
      const nRequired = steps.filter((s) => s.required === true).length
      const nRed = steps.filter((s) => s.red_flag === true).length
      expect(html.split(`data-src="template:required">${TEMPLATE.required}<`).length - 1).toBe(nRequired)
      expect(html.split(`data-src="template:redFlag">`).length - 1).toBe(nRed)
      // each tag has its icon
      expect(html.split('class="lf-cue-tag"').length - 1).toBe(nRequired + nRed)
      expect(html.split('<svg class="lf-cue-icon"').length - 1).toBe(nRequired + nRed)
    })

    it('prints every red_flags item verbatim', () => {
      const items = steps.flatMap((s) => s.red_flags ?? [])
      for (const r of items) expect(flat).toContain(norm(r))
      expect(card.steps.flatMap((s) => s.redFlags.map((a) => a.text))).toEqual(items)
    })

    it('has a write-in box only where a step has an input, with the unit from the rule', () => {
      for (const s of steps) {
        const item = card.steps.find((x) => x.id === s.id)!
        expect(!!item.input, s.id).toBe(!!s.input)
        if (s.input) expect(item.input!.unit.text).toBe(s.input.unit)
        if (s.input?.unit === 'MET') expect(item.input!.kind === 'met' && item.input!.cue.text).toBe(fill(TEMPLATE.metCue, { example: formatMet(MET_NOW_S) }))
      }
      // Boxes: one per input (two ticks for yes/no), a tick per red-flag item (on its yes/no step), and one cell per
      // crewmember and per-crewmember input in the crew table. Nothing else on the card has a box.
      const per = (k: string | undefined) => (k === 'yesno' ? 2 : 1)
      let expected = 0
      for (const item of card.steps) {
        if (item.redFlags.length) expect(item.input, item.id).not.toBeNull()
        expected += item.redFlags.length
        if (item.input && !item.input.perCrew) expected += per(item.input.kind)
      }
      if (card.crewTable) for (const c of card.crewTable.columns) expected += card.crewTable.rows.length * per(c.input.kind)
      const boxes = RENDERED.get(id)!.html.split('class="lf-cue-box"').length - 1
      expect(boxes).toBe(expected)
      expect(boxes > 0).toBe(steps.some((s) => s.input))
    })

    it('prints the tripwire text verbatim', () => {
      const text = (diskCase.tripwire as { text: string }).text
      expect(card.tripwire.text).toBe(text)
      expect(flat).toContain(norm(text))
    })

    it('prints the escalation tier labels of meta.json (and any backup a tier names)', () => {
      expect(card.tiers.map((t) => t.label.text)).toEqual(diskMeta.escalation.tiers.map((t) => t.label))
      expect(card.tiers.map((t) => t.when?.text)).toEqual(diskMeta.escalation.tiers.map((t) => t.when))
      for (const t of diskMeta.escalation.tiers) expect(flat).toContain(t.label)
      const backups = (t: { backup?: unknown }) => (Array.isArray(t.backup) ? t.backup : t.backup ? [t.backup] : []) as Array<{ label: string; when?: string; applies?: string }>
      expect(card.tiers.map((t) => t.backups.map((b) => b.label.text))).toEqual(diskMeta.escalation.tiers.map((t) => backups(t).map((b) => b.label)))
      for (const t of diskMeta.escalation.tiers) for (const b of backups(t)) for (const s of [b.label, b.when, b.applies]) if (s) expect(flat).toContain(s)
    })

    it("prints the case refusals verbatim, plus meta's no_diagnosis and no_dosing", () => {
      const own = diskCase.refusals as string[]
      const meta = ['no_diagnosis', 'no_dosing'].map((r) => diskMeta.refusals.find((x) => x.id === r)!.text)
      expect(card.refusals.map((r) => r.text)).toEqual([...own, ...meta])
      for (const r of [...own, ...meta]) expect(flat).toContain(norm(r))
    })

    it('heads the primary countermeasure "after the red-flag question" exactly when step 1 is a red flag (renal r4)', () => {
      const first = (diskCase.procedure as Array<{ red_flag?: boolean }>)[0]
      expect(card.headings.doNow.text).toBe(first?.red_flag === true ? TEMPLATE.doNowAfterRedFlag : TEMPLATE.doNow)
      expect(flat).toContain(card.headings.doNow.text)
    })

    it('prints the title, one_line, primary countermeasure, header, footer and the rules digest line', () => {
      expect(flat).toContain(diskCase.title as string)
      expect(flat).toContain(norm(diskCase.one_line as string))
      expect(flat).toContain(((diskCase.countermeasure as Json).primary as Json).title as string)
      expect(flat).toContain(TEMPLATE.header)
      expect(flat).toContain(TEMPLATE.footer)
      expect(flat).toContain(fill(TEMPLATE.digest, { digest: shortDigest(OPTS.digest), date: OPTS.date }))
    })

    it('lists every trigger: rule label, operator, value, unit and chip from thresholds.json, or the Tier B wording', () => {
      const triggers = diskCase.triggers as Array<{ kind: string; rule_id?: string; indicator_id?: string }>
      expect(card.triggers.map((t) => t.ref)).toEqual(triggers.map((t) => t.rule_id ?? t.indicator_id))
      for (const t of card.triggers) {
        if (t.kind === 'rule') {
          const rule = (DISK.thresholds.rules as Array<Json & { id: string }>).find((r) => r.id === t.ref)!
          const outside = { lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' }[rule.op as string]!
          expect(t.parts.map((p) => p.text)).toEqual([rule.label, templateText(`op.${outside}`), formatValue(rule.limit, 'num'), rule.unit])
          expect(t.chip?.text).toBe(rule.chip)
          const req = (rule.source as Json).requirement_id
          if (typeof req === 'string' && req) expect(t.basis.map((b) => b.text)).toContain(`[${req}]`)
        } else {
          const ind = (DISK.personal.indicators as Array<Json & { id: string }>).find((i) => i.id === t.ref)!
          expect(t.parts.map((p) => p.text)).toEqual([ind.label, TEMPLATE.personalTrigger])
        }
        expect(flat).toContain(t.parts.map((p) => p.text).join(' '))
        expect(Object.values(TEMPLATE.severity)).toContain(t.sevWord.text)
      }
    })
  })

  it('states severity in words: the S3 trigger is a WARNING, every other opening condition a CAUTION', () => {
    const spe = cardOf('spe_shelter')
    const s3 = spe.triggers.filter((t) => t.ref === 'ops_noaa_s3' || t.ref === 'ops_onboard_proton_s3')
    expect(s3.map((t) => t.sevWord.text)).toEqual([TEMPLATE.severity.warning, TEMPLATE.severity.warning])
    const others = CARDS.flatMap((c) => c.triggers).filter((t) => !s3.includes(t))
    for (const t of others) expect(t.sevWord.text, t.ref).toBe(TEMPLATE.severity.caution)
    // The 30-day BFO limit also opens the case at its watch level (PEL approaching is a caution); the renal
    // TARGET watch level is advisory and opens nothing, so it is not printed as an opening condition.
    expect(spe.triggers.find((t) => t.ref === 'pel_t481_bfo_30d')!.approach?.sevWord.text).toBe(TEMPLATE.severity.caution)
    expect(cardOf('renal_stone').triggers.find((t) => t.ref === 'target_urine_output_24h')!.approach).toBeNull()
  })

  it('gives the crew-wide SPE card one row per crewmember (vocab CREW) for the per-crewmember inputs', () => {
    const spe = cardOf('spe_shelter')
    expect(spe.crewWide).toBe(true)
    expect(spe.crewTable!.rows.map((r) => [r.id.text, r.role.text])).toEqual(CREW.map((c) => [c.id, c.role]))
    // Shelter entry time and organ dose are per crewmember; the proton flux is one vehicle reading.
    expect(spe.crewTable!.columns.map((c) => c.stepId)).toEqual(['p3', 'p5'])
    expect(spe.steps.find((s) => s.id === 'p4')!.input).toMatchObject({ kind: 'value', perCrew: false })
    for (const c of CARDS.filter((x) => x.caseId !== 'spe_shelter')) expect(c.crewTable).toBeNull()
  })

  it('prints each trigger basis inline by default, or as numbered notes when asked (the overflow fallback)', () => {
    for (const card of CARDS) expect(card.basisPlacement).toBe('inline')
    const flat = flatOf('spe_shelter')
    for (const t of cardOf('spe_shelter').triggers) expect(flat).toContain(norm(t.basis.map((b) => b.text).join('')))
    const noted = build(RULES.cases!.cases.find((c) => c.id === 'spe_shelter')!, RULES, { ...OPTS, basisPlacement: 'footnote' } as typeof OPTS)
    const withBasis = noted.triggers.filter((t) => t.basis.length)
    expect(withBasis.map((t) => t.note?.text)).toEqual(withBasis.map((_, i) => String(i + 1)))
    const r = render(noted)
    expect(r.stray).toEqual([])
    expect(r.flat).toContain(TEMPLATE.basis)
    for (const t of withBasis) expect(r.flat).toContain(`${t.note!.text} ${t.basis.map((b) => b.text).join('')}`)
  })

  it('orders the binder Warning first, then the rules order', () => {
    expect(binderOrder(CARDS).map((c) => c.caseId)).toEqual(['spe_shelter', 'renal_stone', 'sleep_circadian'])
  })

  it('words the red-flag tag for every role, in the rules own escalation words (SPEC 2: a CMO is never told to tell the CMO)', () => {
    const tier1 = diskMeta.escalation.tiers.find((t) => t.tier === 1) as { backup?: { role?: string } } | undefined
    const role = tier1?.backup?.role
    expect(role, 'meta.json escalation tier 1 names a backup role').toBeTruthy()
    const phrase = TEMPLATE.redFlag.replace(/^RED FLAG: yes = /, '')
    expect(phrase).not.toBe(TEMPLATE.redFlag)
    expect(phrase).toContain(`(if that is you, the ${role})`)
    const caseTexts = diskCases.flatMap((c) => [(c.tripwire as Json).text as string, ...(c.procedure as Json[]).map((s) => s.text as string)])
    expect(caseTexts.some((t) => t.includes(phrase)), phrase).toBe(true)
  })

  it('prints a trigger basis right under the limit it backs, before a LANDFALL watch level (never under the design choice)', () => {
    const html = RENDERED.get('spe_shelter')!.html
    const label = (DISK.thresholds.rules as Array<Json & { id: string }>).find((r) => r.id === 'pel_t481_bfo_30d')!.label as string
    const from = html.indexOf(label)
    expect(from).toBeGreaterThan(-1)
    const basis = html.indexOf('class="lf-cue-basis"', from)
    const approach = html.indexOf('class="lf-cue-approach"', from)
    expect(basis).toBeGreaterThan(from)
    expect(approach).toBeGreaterThan(from)
    expect(basis).toBeLessThan(approach)
  })
})

// =============================================================================================

describe('never-print', () => {
  const list = neverPrintList(RULES)
  const allFlat = CARDS.map((c) => flatOf(c.caseId)).join(' \n ')

  it('finds the flight-surgeon note and the private indicator in the rules (the list is not empty)', () => {
    expect(list.audienceText.some((s) => /potassium citrate/i.test(s))).toBe(true)
    expect(list.privateVariables).toContain('mood')
    expect(list.privateTerms).toContain('Mood (self-rated)')
  })

  it('prints no potassium citrate and no text addressed to the flight surgeon', () => {
    expect(allFlat).not.toMatch(/potassium citrate/i)
    expect(allFlat).not.toMatch(/citrate/i)
    const audience: string[] = []
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk)
      else if (n && typeof n === 'object') {
        const o = n as Json
        if (o.audience === 'flight_surgeon') audience.push(o.text as string)
        Object.values(o).forEach(walk)
      }
    }
    walk(DISK.cases)
    expect(audience.length).toBeGreaterThan(0)
    for (const t of audience) expect(allFlat).not.toContain(norm(t))
  })

  it('prints no private variable: mood appears only inside a verbatim refusal saying it stays private', () => {
    expect(allFlat).not.toContain('Mood (self-rated)')
    for (const card of CARDS) {
      for (const a of collectAtoms(card)) if (/\bmood\b/i.test(a.text)) expect(isRefusalAtom(a), a.text).toBe(true)
      expect(card.triggers.map((t) => t.ref)).not.toContain('mood')
      expect(card.steps.map((s) => s.input?.variable)).not.toContain('mood')
    }
  })

  it('prints no drug name and no dose', () => {
    for (const d of NEVER_PRINT_DRUGS) expect(allFlat.toLowerCase(), d).not.toContain(d.toLowerCase())
    for (const re of NEVER_PRINT_DOSE) expect(allFlat).not.toMatch(re)
  })

  it('refuses a card that would print a drug, flight-surgeon text or a private variable', () => {
    const variant = (edit: (cases: Array<Json>) => void): { rules: Rules; def: CaseDef } => {
      const copy = JSON.parse(JSON.stringify(RULES)) as Rules
      edit(copy.cases!.cases as unknown as Array<Json>)
      return { rules: copy, def: copy.cases!.cases[0] }
    }
    const drug = variant((cs) => ((cs[0].procedure as Json[])[2].text = 'Take potassium citrate with water.'))
    expect(() => build(drug.def, drug.rules)).toThrow(/never-print/)
    const dose = variant((cs) => ((cs[0].procedure as Json[])[2].text = 'Drink, then take 20 mg with food.'))
    expect(() => build(dose.def, dose.rules)).toThrow(/never-print/)
    const note = variant((cs) => {
      const text = ((cs[0].escalation as Json).flight_surgeon_note as Json).text as string
      ;(cs[0].refusals as string[]).push(text)
    })
    expect(() => build(note.def, note.rules)).toThrow(/never-print/)
    const mood = variant((cs) => ((cs[0].procedure as Json[])[2].input = { variable: 'mood', unit: 'score_1_5', source: 'manual' }))
    expect(() => build(mood.def, mood.rules)).toThrow(/never-print/)
  })

  it('shows a refused card as "not built" naming only the check, never the text it refused (the guard holds on its failure path)', () => {
    const note = ((diskCases[0].escalation as Json).flight_surgeon_note as Json).text as string
    const variants: Array<[string, (cases: Array<Json>) => void]> = [
      ['potassium citrate', (cs) => ((cs[0].procedure as Json[])[2].text = 'Take potassium citrate with water.')],
      ['20 mg', (cs) => ((cs[0].procedure as Json[])[2].text = 'Drink, then take 20 mg with food.')],
      [note, (cs) => (cs[0].refusals as string[]).push(note)],
      ['mood', (cs) => ((cs[0].procedure as Json[])[2].input = { variable: 'mood', unit: 'score_1_5', source: 'manual' })],
    ]
    for (const [secret, edit] of variants) {
      const rules = JSON.parse(JSON.stringify(RULES)) as Rules
      edit(rules.cases!.cases as unknown as Array<Json>)
      let message = ''
      try {
        build(rules.cases!.cases[0], rules)
      } catch (e) {
        message = (e as Error).message
      }
      // the thrown message keeps the detail for maintainers (it names what was refused) ...
      expect(message, secret).toMatch(/never-print/)
      expect(message.toLowerCase(), secret).toContain(secret.toLowerCase())
      // ... the block a crewmember sees and prints does not
      const reason = notBuiltReason(message)
      expect(reason, secret).toMatch(/never-print/)
      expect(reason.toLowerCase(), secret).not.toContain(secret.toLowerCase())
      for (const d of NEVER_PRINT_DRUGS) expect(reason.toLowerCase(), d).not.toContain(d)
      for (const re of NEVER_PRINT_DOSE) expect(reason).not.toMatch(re)
      for (const p of list.privateTerms) expect(reason.toLowerCase(), p).not.toContain(p.toLowerCase())
    }
    // any other failure (a rules id that does not resolve) is shown as is: it names ids, not crew text
    expect(notBuiltReason('cue card: no rule "x" in the rules')).toBe('cue card: no rule "x" in the rules')
  })

  it('every rendered sentence is a rules string or a TEMPLATE string (plus CREW, the std_vol2 quote, step numbers)', () => {
    for (const card of CARDS) {
      const r = RENDERED.get(card.caseId)!
      // nothing on the paper is outside an atom
      expect(r.stray, card.caseId).toEqual([])
      // every rendered atom is one of the card's atoms, unchanged (the view adds no text and edits none)
      const atoms = collectAtoms(card)
      const known = new Set(atoms.map((a) => `${srcKey(a.src)}\u0000${a.text}`))
      const spans = [...r.html.matchAll(/<span data-src="([^"]*)">([^<]*)<\/span>/g)].map((m) => [decode(m[1]), decode(m[2])] as const)
      expect(spans.length).toBeGreaterThan(20)
      for (const [key, text] of spans) expect(known.has(`${key}\u0000${text}`), `${key}: ${text}`).toBe(true)
      // and every atom resolves to its source
      for (const a of atoms) checkAtom(a)
      // the text content is exactly the spans' texts plus separating whitespace
      expect(r.texts.filter((t) => t.trim()).join('|')).toBe(spans.map(([, t]) => t).filter((t) => t.trim()).join('|'))
    }
  })
})

function checkAtom(a: Atom): void {
  const src = a.src
  switch (src.kind) {
    case 'rules': {
      const value = resolvePath(DISK, src.path)
      expect(value, src.path.join('.')).not.toBeUndefined()
      expect(a.text, src.path.join('.')).toBe(formatValue(value, src.fmt))
      if (!src.fmt) expect(typeof value).toBe('string')
      return
    }
    case 'template':
      expect(a.text).toBe(fill(templateText(src.key), src.vars ?? {}))
      if (src.key === 'digest') expect(src.vars).toEqual({ digest: shortDigest(OPTS.digest), date: OPTS.date })
      if (src.key === 'metCue') expect(src.vars).toEqual({ example: formatMet(MET_NOW_S) })
      return
    case 'crew': {
      const c = CREW.find((x) => x.id === src.id)!
      expect(a.text).toBe(c[src.field])
      return
    }
    case 'snapshot':
      expect(src.id).toBe('std_vol2_requirements')
      expect(a.text).toBe(formatValue(resolvePath(VOL2, src.path), src.fmt))
      return
    case 'computed':
      expect(a.text).toBe(String(src.value))
      expect(Number.isInteger(src.value) && src.value >= 1).toBe(true)
  }
}

// =============================================================================================

describe('rules digest and the [V2 10130] quote', () => {
  // Independent of model.ts: canonical JSON (sorted keys, no whitespace) of the five files read from disk, in
  // the fixed order, hashed with node:crypto instead of crypto.subtle.
  const canon = (v: unknown): string =>
    v === null || typeof v !== 'object'
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? '[' + v.map(canon).join(',') + ']'
        : '{' + Object.keys(v as Json).sort().map((k) => JSON.stringify(k) + ':' + canon((v as Json)[k])).join(',') + '}'
  const expected = createHash('sha256').update(canon(['environments', 'thresholds', 'personal', 'cases', 'meta'].map((k) => DISK[k as keyof typeof DISK])), 'utf8').digest('hex')

  it('equals the SHA-256 recomputed here', async () => {
    expect(RULE_FILE_ORDER).toEqual(['environments', 'thresholds', 'personal', 'cases', 'meta'])
    expect(rulesCanonical(RULES)).toBe(canon(RULE_FILE_ORDER.map((k) => DISK[k])))
    const hex = await rulesDigest(RULES)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    expect(hex).toBe(expected)
    const card = build(RULES.cases!.cases[0], RULES, { ...OPTS, digest: hex! })
    expect(card.digest.text).toBe(`rules ${expected.slice(0, 12)} · built ${OPTS.date} · if the app shows a different rules digest, this card is out of date`)
  })

  it('changes when any rule changes', async () => {
    const copy = JSON.parse(JSON.stringify(RULES)) as Rules
    copy.cases!.cases[0].title = `${copy.cases!.cases[0].title}.`
    expect(await rulesDigest(copy)).not.toBe(expected)
  })

  it('quotes [V2 10130] from the frozen std_vol2 snapshot, never typed', () => {
    const req = VOL2.data!.requirements!.find((r) => r.id === '[V2 10130]')!
    expect(req).toMatchObject({ section: '10.2.13', pdf_page: 204 })
    expect((req as Json).verified).toBe(true)
    for (const card of CARDS) {
      expect(card.quote!.text.text).toBe(req.text)
      expect(card.quote!.text.src).toMatchObject({ kind: 'snapshot', id: 'std_vol2_requirements' })
      expect(flatOf(card.caseId)).toContain(req.text!)
    }
    // the quote and its rationale are not typed in this feature's source
    for (const f of ['./model.ts', './index.tsx', './PrintLink.tsx', './cuecard.css']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(src, f).not.toContain(req.text!.slice(20, 80))
      expect(src, f).not.toContain('emergency procedures may have')
      expect(src, f).not.toContain('loss of the information management system')
    }
    // without the snapshot the card still builds, with the header and no quote
    const bare = cueCard(RULES.cases!.cases[0], RULES, {}, OPTS)
    expect(bare.quote).toBeNull()
    expect(bare.header.text).toBe(TEMPLATE.header)
  })
})
