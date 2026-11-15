// Badge and "Why this fired" words (SPEC 1.2: limits are never merged into one "threshold exceeded" state, and an
// OPS level is not a limit). FFD, PEL and POL findings read against a limit, a TARGET against its target, and an OPS
// finding names the NOAA S level its rule carries (engine/rules/thresholds.json, never typed in the badge code).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RULES, evaluateRule, getRule, sLevel, thresholdRules } from '../app/engine'
import type { Finding, Rule } from '../app/engine'
import { targetDistance } from '../features/cases/model'
import { RuleWhy, TargetReached } from '../features/cases/parts'
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

  it('the renal TARGET reads "Below case floor", "Below target" and "Meets target"', () => {
    const r = getRule(RULES, 'target_urine_output_24h')
    expect(r.category).toBe('TARGET')
    const env = envFor(r)
    const target = r.approach_at!.value
    const out = evaluateRule(r, r.limit - 100, env, null)
    const short = evaluateRule(r, (r.limit + target) / 2, env, null)
    const ok = evaluateRule(r, target + 500, env, null)
    expect([out.status, short.status, ok.status]).toEqual(['outside', 'approaching', 'within'])
    expect(findingStatusLabel(out)).toBe('Below case floor')
    expect(findingStatusLabel(short)).toBe('Below target')
    expect(findingStatusLabel(ok)).toBe('Meets target')
    expect(badge(out)).toBe('Below case floor (Caution)')
    expect(badge(short)).toBe('Below target (Advisory)')
    // the old words read the HRP sentence backwards (1500 mL is where stone risk rises, not a target that is met)
    for (const f of [out, short, ok]) expect(badge(f)).not.toMatch(/limit|Outside target|Approaching target/i)
  })
})

describe('the renal TARGET in its source’s words: a case floor and a countermeasure target', () => {
  const r = getRule(RULES, 'target_urine_output_24h')
  const env = envFor(r)
  const floor = r.limit
  const target = r.approach_at!.value

  it('every TARGET rule is a floor with a countermeasure target above it, from the HRP evidence report (the words assume it)', () => {
    const targets = thresholdRules(RULES).filter((x) => x.category === 'TARGET')
    expect(targets.map((x) => x.id)).toEqual(['target_urine_output_24h'])
    expect(r.op).toBe('ge')
    expect(target).toBeGreaterThan(floor)
    // both numbers are in the one sentence the rule quotes: "below 1.5 liters/day ... 2.5-3 liters/day"
    const verbatim = String((r.source as { verbatim?: string }).verbatim)
    expect(verbatim).toContain(`below ${floor / 1000} liters/day`)
    expect(verbatim).toContain(`${target / 1000}-3 liters/day`)
  })

  it('below the floor is a Caution, between the floor and the target an Advisory, never a Warning (the Noon Sight sentence)', () => {
    expect(evaluateRule(r, floor - 1, env, null).severity).toBe('caution')
    expect(evaluateRule(r, floor, env, null).severity).toBe('advisory')
    expect(evaluateRule(r, target - 1, env, null).severity).toBe('advisory')
    expect(evaluateRule(r, target + 1, env, null).severity).toBe('nominal')
    expect(evaluateRule(r, 0, env, null).severity).not.toBe('warning')
  })

  it('"Why this fired" shows the case floor, the countermeasure target and the distance to the nearer one', () => {
    const at = (v: number) => grid(r, evaluateRule(r, v, env, null))
    const head = (v: number) => at(v).map(([dt, dd]) => [dt, dd])
    expect(head(1100)).toEqual([
      ['Value', '1100 mL below threshold'],
      ['Case floor (the HRP report: stone risk rises below it)', `${floor} mL`],
      ['Countermeasure target (the HRP report)', `≥ ${target} mL ${r.approach_at!.chip}`],
      ['Below the case floor by', `${floor - 1100} mL`],
    ])
    expect(at(2110)[3]).toEqual(['Below the target by', `${target - 2110} mL`, expect.any(String)])
    expect(at(floor)[3].slice(0, 2)).toEqual(['Below the target by', `${target - floor} mL`])
    expect(at(3310)[3].slice(0, 2)).toEqual(['Above the target by', `${3310 - target} mL`])
    // the engine compared nothing (no value): no distance is computed
    const none = grid(r, evaluateRule(r, null, env, null))
    expect(none[3].slice(0, 2)).toEqual(['Distance from the target', '— no data'])
    // its approach_at is the countermeasure target row, not a second "Approaching at" row
    for (const v of [1100, 2110, 3310]) expect(at(v).map(([dt]) => dt).join(' | ')).not.toMatch(/Approaching at|Target \(met when|Limit|Margin/)
  })

  it('targetDistance names the nearer line, also without a countermeasure target', () => {
    expect(targetDistance(1100, -400, 1500, 2500)).toEqual({ label: 'Below the case floor by', by: 400 })
    expect(targetDistance(2500, 1000, 1500, 2500)).toEqual({ label: 'At the target', by: 0 })
    expect(targetDistance(1100, -400, 1500, null)).toEqual({ label: 'Below the case floor by', by: 400 })
    expect(targetDistance(1700, 200, 1500, null)).toEqual({ label: 'Above the case floor by', by: 200 })
    expect(targetDistance(null, null, 1500, null)).toEqual({ label: 'Distance from the case floor', by: null })
  })

  it('the Detect sentence: the case floor (where the report says stone risk rises) and the countermeasure target, from the rule', () => {
    const say = (rule: Parameters<typeof TargetReached>[0]['rule']) => text(renderToStaticMarkup(createElement(TargetReached, { rule, unit: r.unit })))
    expect(say(r)).toBe(`; the case floor is ${floor} mL (the HRP report: stone risk rises below it), and its countermeasure target is ${target} mL or more.`)
    expect(say({ limit: floor, approach_at: null })).toBe(`; the case floor is ${floor} mL (the HRP report: stone risk rises below it).`)
    expect(say(r)).not.toMatch(/the target is met only/)
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
    expect(t).toContain('at or above the NOAA S3 threshold of ≥ 1000 pfu') // the engine's own audit line is kept verbatim
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
