// Badge and "Why this fired" words (SPEC 1.2: limits are never merged into one "threshold exceeded" state, and an
// OPS level is not a limit). FFD, PEL and POL findings read against a limit, a TARGET against its target, and an OPS
// finding names the NOAA S level its rule carries (engine/rules/thresholds.json, never typed in the badge code).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RULES, evaluateRule, getRule, sLevel, thresholdRules } from '../app/engine'
import type { Finding, Rule } from '../app/engine'
import { RuleWhy } from '../features/cases/parts'
import { FindingBadge, findingStatusLabel, opsLevelOf, opsStatusLabel } from './badges'

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

const badge = (finding: Finding) => text(renderToStaticMarkup(createElement(FindingBadge, { finding })))

/** The rows of the "Why this fired" grid as [dt text, dd text, dd html]. */
function grid(rule: Rule, finding: Finding): Array<[string, string, string]> {
  const html = renderToStaticMarkup(createElement(RuleWhy, { rule, finding, open: true }))
  const rows: Array<[string, string, string]> = []
  for (const m of html.matchAll(/<div><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g)) rows.push([text(m[1]), text(m[2]), m[2]])
  return rows
}

const whyText = (rule: Rule, finding: Finding) => text(renderToStaticMarkup(createElement(RuleWhy, { rule, finding, open: true })))

const OPS = thresholdRules(RULES).filter((r) => r.category === 'OPS')
/** The level as the engine grades an OPS rule: its integer s_level, else sLevel(limit) for a ceiling. */
const levelOf = (r: Rule) => (Number.isInteger(r.s_level) ? (r.s_level as number) : sLevel(r.limit))
const envFor = (r: Rule) => (r.applies_to.includes('*') ? 'iss' : r.applies_to[0])

describe('OPS badges name the S level, never a limit', () => {
  it('the rules have OPS levels to test (S1-S5 near Earth, the Mars-orbit monitor rule at Mars)', () => {
    expect(OPS.length).toBeGreaterThanOrEqual(6)
    for (const r of OPS) expect(levelOf(r)).toBeGreaterThanOrEqual(1)
  })

  it('outside reads "At or above S<n>", within "Below S<n>", approaching "Approaching S<n>", with n from the rule', () => {
    for (const r of OPS) {
      const n = levelOf(r)
      const env = envFor(r)
      const above = evaluateRule(r, r.limit * 1.05, env, null)
      const below = evaluateRule(r, r.limit * 0.5, env, null)
      expect(above.status, r.id).toBe('outside')
      expect(below.status, r.id).toBe('within')
      expect(opsLevelOf(above), r.id).toBe(n)
      expect(findingStatusLabel(above), r.id).toBe(`At or above S${n}`)
      expect(findingStatusLabel(below), r.id).toBe(`Below S${n}`)
      expect(findingStatusLabel({ ...above, status: 'approaching', severity: 'advisory' }), r.id).toBe(`Approaching S${n}`)
      for (const f of [above, below]) expect(badge(f), r.id).not.toMatch(/limit/i)
    }
  })

  it('at exactly the threshold the level is reached ("compliant below 1000 pfu" is outside at 1000)', () => {
    const r = getRule(RULES, 'ops_noaa_s3')
    const f = evaluateRule(r, r.limit, 'iss', null)
    expect(f.status).toBe('outside')
    expect(findingStatusLabel(f)).toBe(`At or above S${levelOf(r)}`)
  })

  it('the hero rule at Mars: 1050 pfu reads "At or above S3", a Warning', () => {
    const r = getRule(RULES, 'ops_onboard_proton_s3')
    const f = evaluateRule(r, 1050, 'mars_surface', null)
    expect(f.severity).toBe('warning')
    const t = badge(f)
    expect(t).toContain('At or above S3')
    expect(t).toContain('(Warning)')
    expect(t).not.toMatch(/limit/i)
  })

  it("the level comes from the finding's s_level, else the rule's, else the engine's sLevel of a ceiling's limit", () => {
    const base = { status: 'outside' as const, severity: 'warning' as const, category: 'OPS' }
    expect(opsLevelOf({ ...base, rule_id: 'ops_noaa_s3', s_level: 4 })).toBe(4)
    expect(opsLevelOf({ ...base, rule_id: 'ops_noaa_s3' })).toBe(getRule(RULES, 'ops_noaa_s3').s_level)
    expect(opsLevelOf({ ...base, rule_id: 'not_a_rule', op: 'lt', limit: 100 })).toBe(sLevel(100))
    // no level: the words fall back to "the threshold"
    expect(opsLevelOf({ ...base, rule_id: 'not_a_rule', op: 'lt', limit: 5 })).toBeNull()
    expect(opsStatusLabel({ ...base, rule_id: 'not_a_rule', op: 'lt', limit: 5 })).toBe('At or above the threshold')
    expect(opsStatusLabel({ ...base, status: 'within', severity: 'nominal' })).toBe('Below the threshold')
    expect(opsStatusLabel({ ...base, status: 'approaching', severity: 'advisory' })).toBe('Approaching the threshold')
  })

  it('a data-quality state still wins over the OPS words', () => {
    const r = getRule(RULES, 'ops_noaa_s3')
    const f = evaluateRule(r, 1050, 'mars_surface', null)
    expect(f.status).toBe('not_applicable')
    expect(badge(f)).toBe('Not applicable here')
  })
})

describe('FFD, PEL and POL keep their limit words; TARGET keeps its target words', () => {
  it('CM-2 VO2max 35.1: outside the surface-EVA floor at Mars, within the microgravity-EVA floor at ISS', () => {
    const surface = evaluateRule(getRule(RULES, 'ffd_vo2max_surface_eva'), 35.1, 'mars_surface', null)
    const micro = evaluateRule(getRule(RULES, 'ffd_vo2max_microgravity_eva'), 35.1, 'iss', null)
    expect([surface.category, surface.status, surface.severity]).toEqual(['FFD', 'outside', 'caution'])
    expect([micro.category, micro.status]).toEqual(['FFD', 'within'])
    expect(findingStatusLabel(surface)).toBe('Outside limit')
    expect(findingStatusLabel(micro)).toBe('Within limit')
    expect(badge(surface)).toBe('Outside limit (Caution)')
    expect(badge(micro)).toBe('Within limit (Nominal)')
  })

  it('PEL and POL findings read "Outside limit" / "Within limit" too', () => {
    for (const category of ['PEL', 'POL']) {
      expect(findingStatusLabel({ status: 'outside', severity: 'caution', category })).toBe('Outside limit')
      expect(findingStatusLabel({ status: 'within', severity: 'nominal', category })).toBe('Within limit')
      expect(findingStatusLabel({ status: 'approaching', severity: 'caution', category })).toBe('Approaching limit')
    }
  })

  it('the renal TARGET reads "Outside target", "Approaching target" and "Meets target"', () => {
    const r = getRule(RULES, 'target_urine_output_24h')
    expect(r.category).toBe('TARGET')
    const env = envFor(r)
    const out = evaluateRule(r, r.limit - 100, env, null)
    const ok = evaluateRule(r, (r.approach_at?.value ?? r.limit) + 500, env, null)
    expect(out.status).toBe('outside')
    expect(ok.status).toBe('within')
    expect(findingStatusLabel(out)).toBe('Outside target')
    expect(findingStatusLabel(ok)).toBe('Meets target')
    expect(findingStatusLabel({ ...out, status: 'approaching', severity: 'advisory' })).toBe('Approaching target')
    expect(badge(out)).not.toMatch(/limit/i)
  })
})

describe('"Why this fired" of an OPS rule shows the threshold, not a limit and a margin', () => {
  it('at Mars: the NOAA S3 threshold with the design-choice chip, the distance above it, and the engine audit text', () => {
    const r = getRule(RULES, 'ops_onboard_proton_s3')
    const f = evaluateRule(r, 1050, 'mars_surface', null)
    const rows = grid(r, f)
    expect(rows.map(([dt]) => dt)).toEqual(['Value', `Threshold (NOAA S${levelOf(r)}, reached at or above)`, 'Above the threshold by'])
    expect(rows[1][1]).toBe(`≥ ${r.limit} pfu ${r.chip}`)
    expect(rows[1][2]).toContain(`data-chip="${r.chip}"`)
    expect(r.chip).toBe('design choice')
    expect(rows[2][1]).toBe('50 pfu')
    const t = whyText(r, f)
    expect(t).toContain('Engine audit text')
    expect(t).toContain('compliant when < 1000 pfu') // the engine's own audit line is kept verbatim
    expect(t).toContain('Provenance of this rule')
    expect(t).not.toMatch(/Limit \(compliant|Margin|Provenance of ops_|Outside limit/)
  })

  it('near Earth: the same threshold carries the NOAA-published chip', () => {
    const r = getRule(RULES, 'ops_noaa_s3')
    const f = evaluateRule(r, 1050, 'iss', null)
    const rows = grid(r, f)
    expect(rows[1][0]).toBe(`Threshold (NOAA S${levelOf(r)}, reached at or above)`)
    expect(rows[1][2]).toContain('data-chip="NOAA-published"')
    expect(r.chip).toBe('NOAA-published')
  })

  it('below and at the threshold, and when the engine compared nothing (not applicable here)', () => {
    const r = getRule(RULES, 'ops_noaa_s3')
    const below = grid(r, evaluateRule(r, 940, 'iss', null))
    expect(below[2][0]).toBe('Below the threshold by')
    expect(below[2][1]).toBe('60 pfu')
    const at = grid(r, evaluateRule(r, r.limit, 'iss', null))
    expect(at[2][0]).toBe('At the threshold')
    expect(at[2][1]).toBe('0 pfu')
    const na = grid(r, evaluateRule(r, 1050, 'mars_surface', null))
    expect(na[2][0]).toBe('Distance from the threshold')
    expect(na[2][1]).toBe('— no data')
  })

  it('an FFD rule keeps "Limit (compliant when ...)" and "Margin"', () => {
    const r = getRule(RULES, 'ffd_vo2max_surface_eva')
    const f = evaluateRule(r, 35.1, 'mars_surface', null)
    const rows = grid(r, f)
    expect(rows[1][0]).toBe('Limit (compliant when at or above)')
    expect(rows[2][0]).toBe('Margin')
    const t = whyText(r, f)
    expect(t).toContain('Outside limit')
    expect(t).toContain('Provenance of this rule')
    expect(t).not.toContain('Engine audit text')
  })
})
