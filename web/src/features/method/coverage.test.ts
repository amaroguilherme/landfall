// Coverage of NASA's sample IMM output (Vol 1 Rev C Table E.2-1): the mapping of its 48 conditions is checked
// against the frozen snapshot, cases.json and the Noon Sight symptom list, and the shares the section shows
// are recomputed here from the snapshot with plain arithmetic.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CASE_DEFS } from '../../app/caseTimeline'
import { SYMPTOMS } from '../noon-sight/record'
import { CoverageBody } from './CoverageSection'
import {
  CATEGORY_DEFS,
  CATEGORY_ORDER,
  E22_TO_IMM,
  IMM_COVERAGE,
  VIA_DEFS,
  abstractOf,
  appendixE,
  casesWithoutRows,
  coverageRows,
  coverageSummary,
  fmtShare,
  headline,
  hrrOfRenalRedFlags,
  immTable,
} from './immCoverage'
import type { CoverageCategory } from './immCoverage'
import { META, PERSONAL, THRESHOLDS } from './rules'
import type { Vol1Data } from './rules'
import { SECTIONS, SECTION_IDS, secNum } from './sections'

interface RawRow {
  rank: number
  condition: string
  likelihood: { text: string; value: number; unit: string }
  pdf_page_number: number
}
type Snap = { data: Vol1Data & { tables: Array<{ id: string; rows: RawRow[] }>; appendix_e: unknown } }

const glob = import.meta.glob<Snap>('../../../public/data/std_vol1_requirements.json', { eager: true, import: 'default' })
const snap = Object.values(glob)[0]
const raw = snap.data.tables.find((t) => t.id === 'Table E.2-1')!.rows
const table = immTable(snap.data)!
const rows = coverageRows(table)
const summary = coverageSummary(rows)

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

describe('Table E.2-1 in the snapshot', () => {
  it('has the 48 ranked rows the section reads', () => {
    expect(table.verified).toBe(true)
    expect(raw.map((r) => r.rank)).toEqual(Array.from({ length: 48 }, (_, i) => i + 1))
    expect([raw[0].condition, raw[0].likelihood.text]).toEqual(['Late Insomnia', '13.85 per mission'])
    expect([raw[47].condition, raw[47].likelihood.text]).toEqual(['Dental Abscess', '0.068 per mission'])
  })
})

describe('the mapping of the 48 conditions (design choice)', () => {
  it('maps each of the 48 conditions exactly once, and nothing else', () => {
    const names = raw.map((r) => r.condition)
    expect(new Set(names).size).toBe(48)
    expect(Object.keys(IMM_COVERAGE).sort()).toEqual([...names].sort())
    expect(summary.unmapped).toEqual([])
    expect(CATEGORY_ORDER.reduce((n, c) => n + summary.byCategory[c].count, 0)).toBe(48)
  })
  it('names only cases that exist in cases.json, symptoms in SYMPTOMS and rules in thresholds.json', () => {
    const caseIds = new Set(CASE_DEFS.map((c) => c.id))
    const symptomIds = new Set<string>(SYMPTOMS.map((s) => s.id))
    const ruleIds = new Set(THRESHOLDS!.rules.map((r) => r.id))
    for (const [name, e] of Object.entries(IMM_COVERAGE)) {
      expect(CATEGORY_ORDER, name).toContain(e.category)
      if (e.caseId !== undefined) expect(caseIds.has(e.caseId), `${name}: case ${e.caseId}`).toBe(true)
      for (const s of e.symptoms ?? []) expect(symptomIds.has(s), `${name}: symptom ${s}`).toBe(true)
      if (e.ruleId !== undefined) expect(ruleIds.has(e.ruleId), `${name}: rule ${e.ruleId}`).toBe(true)
      // each category carries what it needs, and only that
      if (e.category === 'case') expect(e.caseId, name).toBeTruthy()
      else expect(e.caseId, name).toBeUndefined()
      if (e.category === 'asked_daily' || e.category === 'asked_symptom') expect(e.symptoms?.length, name).toBeGreaterThan(0)
      if (e.category === 'not_measurable') {
        expect(Object.keys(VIA_DEFS), name).toContain(e.via)
        expect(e.symptoms, name).toBeUndefined()
      } else expect(e.via, name).toBeUndefined()
    }
  })
  it("keeps 'Back Pain (SAS)' apart from the renal case's flank-pain question", () => {
    const back = IMM_COVERAGE['Back Pain (SAS)']
    expect(back.category).toBe('not_measurable')
    expect(back.symptoms ?? []).not.toContain('flank_pain')
    // no condition of the sample is asked through the flank-pain red flag at all
    expect(Object.values(IMM_COVERAGE).some((e) => (e.symptoms ?? []).includes('flank_pain'))).toBe(false)
  })
  it('follows the brief: the case, asked-daily and symptom-only rows', () => {
    const of = (c: CoverageCategory) => summary.byCategory[c].conditions
    expect(of('case')).toEqual(['Late Insomnia', 'Insomnia (SAS)'])
    expect(of('asked_daily').sort()).toEqual(
      ['CO2 Headache', 'Headache (SAS)', 'Late Headache', 'Skin Rash', 'Urinary Retention', 'Urinary Tract Infection'].sort(),
    )
    expect(of('asked_symptom').sort()).toEqual(['Space Motion Sickness (SAS)', 'Spaceflight Associated Neuro-ocular Syndrome (SANS)'])
    expect(IMM_COVERAGE['Urinary Tract Infection'].symptoms).toEqual(['painful_urination', 'fever_chills'])
    expect(IMM_COVERAGE['Urinary Retention'].symptoms).toEqual(['cannot_pass_urine'])
    expect(IMM_COVERAGE['Skin Rash'].symptoms).toEqual(['rash'])
    for (const h of ['Late Headache', 'CO2 Headache', 'Headache (SAS)']) expect(IMM_COVERAGE[h].symptoms).toEqual(['headache'])
    expect(IMM_COVERAGE['Space Motion Sickness (SAS)'].symptoms).toEqual(['nausea_vomiting'])
    const sans = IMM_COVERAGE['Spaceflight Associated Neuro-ocular Syndrome (SANS)']
    expect([sans.symptoms, sans.note]).toEqual([['vision_change'], 'SANS is usually found by eye imaging, not symptoms.'])
    expect(of('not_measurable')).toHaveLength(38)
  })
  it('ties every frozen Table E.2-2 row to existing Table E.2-1 rows (Nephrolithiasis to none)', () => {
    const e22 = appendixE(snap.data)!.table_e_2_2.rows
    expect(Object.keys(E22_TO_IMM)).toEqual(e22.map((r) => r.condition))
    for (const names of Object.values(E22_TO_IMM)) for (const n of names) expect(IMM_COVERAGE[n], n).toBeDefined()
    expect(E22_TO_IMM['Nephrolithiasis']).toEqual([])
    // the renal and shelter cases have no row in the sample; only the sleep case does
    expect(casesWithoutRows(rows, CASE_DEFS.map((c) => c.id)).sort()).toEqual(['renal_stone', 'spe_shelter'])
  })
})

describe('the shares, recomputed from the snapshot', () => {
  // Independent arithmetic: a plain left-to-right loop over the raw snapshot rows.
  let total = 0
  const sums: Record<string, number> = {}
  for (const r of raw) {
    total = total + r.likelihood.value
    const c = IMM_COVERAGE[r.condition].category
    sums[c] = (sums[c] ?? 0) + r.likelihood.value
  }
  const shares = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, (sums[c] ?? 0) / total])) as Record<CoverageCategory, number>

  it('sums the 48 likelihoods to 101.808 (derived)', () => {
    expect(Math.abs(total - 101.808)).toBeLessThan(0.001)
    expect(summary.total).toBe(total)
  })
  it('case 16.3%, asked daily 20.5%, and the four shares add up to the whole', () => {
    for (const c of CATEGORY_ORDER) expect(summary.byCategory[c].share, c).toBeCloseTo(shares[c], 12)
    expect(fmtShare(shares.case)).toBe('16.3%')
    expect(fmtShare(shares.asked_daily)).toBe('20.5%')
    expect(fmtShare(shares.asked_symptom)).toBe('6.3%')
    expect(fmtShare(shares.not_measurable)).toBe('56.9%')
    expect(CATEGORY_ORDER.reduce((s, c) => s + shares[c], 0)).toBeCloseTo(1, 12)
  })
  it('the section shows exactly those shares: table, bar and abstract', () => {
    const html = renderToStaticMarkup(
      createElement(CoverageBody, { table, rows, summary, v1: snap.data, ctx: { meta: META!, personal: PERSONAL!, thresholds: THRESHOLDS! } }),
    )
    for (const c of CATEGORY_ORDER) {
      const shown = new RegExp(`data-share="${c}">([^<]+)<`).exec(html)?.[1]
      expect(shown, c).toBe(fmtShare(shares[c]))
      // the bar part carries the same share in its accessible name, and prints it
      const block = new RegExp(`data-cat="${c}"[^>]*aria-label="([^"]+)"`).exec(html)?.[1]
      expect(block, c).toContain(`${CATEGORY_DEFS[c].label}: ${summary.byCategory[c].count} `)
      expect(block, c).toMatch(new RegExp(`, ${fmtShare(shares[c]).replace('.', '\\.')}$`))
    }
    const shares4 = [...html.matchAll(/class="lf-cov-share" data-len="(\d+)"[^>]*>([^<]+)</g)].map((m) => {
      expect(Number(m[1])).toBe(m[2].length) // the CSS hides a label by its length when its part is too narrow
      return m[2]
    })
    expect(shares4).toEqual(CATEGORY_ORDER.map((c) => fmtShare(shares[c])))
    const abs = abstractOf(summary)
    expect(abs).toContain(`${fmtShare(shares.case)} of NASA’s sample IMM output is watched by a case`)
    expect(abs).toContain(`${fmtShare(shares.asked_daily)} is asked about daily`)
  })
})

describe('the rendered section', () => {
  const html = renderToStaticMarkup(
    createElement(CoverageBody, { table, rows, summary, v1: snap.data, ctx: { meta: META!, personal: PERSONAL!, thresholds: THRESHOLDS! } }),
  )
  const text = textOf(html)
  const e = appendixE(snap.data)!

  it('leads with the sentence lane P quotes', () => {
    expect(headline(rows)?.replace('’', "'")).toBe(
      "Late insomnia is the most likely in-mission condition in NASA's sample IMM output (13.85 per mission): the sleep case watches it.",
    )
    expect(text).toContain('Late insomnia is the most likely in-mission condition in NASA’s sample IMM output (13.85 per mission): the sleep case watches it.')
  })
  it('quotes E.2.3, the E.2-2 footnote and the [V1 3003] pointer verbatim', () => {
    expect(text).toContain(`“${e.e_2_3_limitation!.text}”`)
    expect(e.e_2_3_limitation!.text).toBe(
      'One limitation is that IMM was developed for application to ISS missions, but it may be applied to other design reference missions if the appropriate limitations are considered during interpretation of results.',
    )
    expect(text).toContain(`“${e.table_e_2_2.footnote!.text}”`)
    expect(e.table_e_2_2.footnote!.text).toBe(
      'Conditions noted with an asterisk (*) should be addressed on every mission regardless of the DRM parameters.',
    )
    expect(text).toContain('please see Appendix E, Table E.2-1—Sample IMM Output.')
    expect(text).toContain('based on epidemiological evidence-based probabilistic risk assessment (PRA)')
  })
  it('gives the status of the three asterisked rows and the Nephrolithiasis line', () => {
    for (const r of ['Insomnia/sleep disturbances/circadian misalignment *', 'Headache (CO2 related) *', 'Urinary retention (space-adaptation related) *']) {
      expect(text, r).toContain(r)
    }
    expect(hrrOfRenalRedFlags()?.id).toBe('HRR risk 81')
    expect(text).toContain('‘Nephrolithiasis’ carries no asterisk; the renal case’s basis is HRR risk 81, not the IMM table.')
    expect(text).not.toContain('Nephrolithiasis *')
  })
  it('says what the score is not: a sample, ISS-derived; asked is not detected; no diagnosis', () => {
    expect(text).toContain('Sample, ISS-derived output: never read it as per-Mars-mission')
    expect(text).toContain('Asked is not detected')
    const refusal = META!.refusals.find((r) => r.id === 'no_diagnosis')!.text
    expect(text).toContain(refusal)
    expect(text).toContain('SANS is usually found by eye imaging, not symptoms.')
  })
  it('never says a NOT MEASURABLE row is not asked: a general daily question can still get a yes from it', () => {
    // e.g. gastroenteritis and "Nausea or vomiting", influenza and "Fever or chills", shingles and "Rash or skin irritation"
    expect(CATEGORY_DEFS.not_measurable.definition).not.toMatch(/asks about it/)
    expect(text).not.toContain('the daily check does not ask about it')
    expect(text).toContain('this score counts no daily question for it')
    expect(VIA_DEFS['crew report']).toContain('no daily question is counted for it')
  })
  it('reads the [V1 3003] section from the snapshot, and words two daily questions in the plural', () => {
    const r3003 = snap.data.requirements.find((r) => r.id === 'V1 3003')!
    expect(text).toContain(`NASA-STD-3001 Vol 1 Rev C, [V1 3003], section ${r3003.section}`)
    expect(text).toContain('Daily questions: “Pain or burning when passing urine”, “Fever or chills”. Also red-flag questions of the renal case.')
    expect(text).toContain('Daily question: “Being unable to pass urine”. Also a red-flag question of the renal case.')
    expect(text).toContain('Table E.2-1 prints a rank and the columns “Medical Condition” and “Likelihood”')
  })
  it('lists all 48 rows in the collapsed table, each with its verbatim likelihood', () => {
    expect(html).toContain('<details class="lf-expander">')
    expect(html).not.toContain('<details class="lf-expander" open')
    const body = html.slice(html.indexOf('lf-cov-rows'))
    expect([...body.matchAll(/<span class="lf-mono lf-cov-rank">(\d+)<\/span>/g)].map((m) => Number(m[1]))).toEqual(raw.map((r) => r.rank))
    for (const r of raw) expect(text, r.condition).toContain(r.likelihood.text)
  })
})

describe('the section list', () => {
  it("registers 'coverage' just before 'limitations', so every number after it is computed", () => {
    const i = SECTION_IDS.indexOf('coverage')
    expect(SECTIONS[i]).toEqual({ s: 'coverage', label: "Coverage of NASA's sample IMM output" })
    expect(SECTION_IDS[i + 1]).toBe('limitations')
    expect(secNum('limitations')).toBe(secNum('coverage') + 1)
    expect(new Set(SECTION_IDS).size).toBe(SECTION_IDS.length)
    expect(SECTION_IDS.map((s) => secNum(s as (typeof SECTIONS)[number]['s']))).toEqual(SECTION_IDS.map((_, k) => k + 1))
  })
})
