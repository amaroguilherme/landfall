// The Fluids step's renal / hydration context comes from engine/rules, never from typed numbers.
import { describe, expect, it } from 'vitest'
import { RULES } from '../../app/engine'
import { POTABLE_WATER_CONSTANT_ID, minBaseline, ruleConstant, urineTarget } from './renal'

const tsx = import.meta.glob<string>('./*.tsx', { query: '?raw', import: 'default', eager: true })

describe('Noon Sight hydration context', () => {
  it('reads the renal target from target_urine_output_24h (HRP evidence report, literature)', () => {
    const t = urineTarget()
    expect(t).not.toBeNull()
    expect(t?.rule.category).toBe('TARGET')
    // An HRP evidence report: never a NASA standard. The chip name itself comes from meta.json.
    const chips = ((RULES.meta as { chips?: { id: string }[] } | null)?.chips ?? []).map((c) => c.id)
    expect(chips).toContain(t?.rule.chip)
    expect(t?.rule.chip).not.toBe('NASA-published')
    expect(t?.rule.source.kind).not.toBe('nasa_standard')
    expect(t?.unit).toBe('mL')
    expect(t?.limit).toBe(t?.rule.limit)
    expect(t?.approach).toBe((t?.rule.approach_at as { value: number }).value)
    // The quoted sentence carries both report numbers, so the view never has to type them.
    expect(t?.verbatim).toMatch(/1\.5 liters\/day/)
    expect(t?.verbatim).toMatch(/2\.5-3 liters\/day/)
  })

  it('reads the [V2 6109] potable-water constant (a provision requirement, Table 6.3-1)', () => {
    const c = ruleConstant(POTABLE_WATER_CONSTANT_ID)
    expect(c?.chip).toBe('NASA-published')
    expect(c?.source.requirement_id).toBe('V2 6109')
    expect(c?.source.table).toBe('Table 6.3-1')
    expect(typeof c?.value).toBe('number')
  })

  it('reads the minimum baseline length from personal.json', () => {
    expect(minBaseline()?.n).toBe(RULES.personal?.rci.min_baseline_n)
  })

  it('degrades to null, never to a typed number, when the rules are absent', () => {
    const empty = { environments: null, thresholds: null, personal: null, cases: null, meta: null }
    expect(urineTarget(empty)).toBeNull()
    expect(ruleConstant(POTABLE_WATER_CONSTANT_ID, empty)).toBeNull()
    expect(minBaseline(empty)).toBeNull()
  })

  it('types none of the renal or hydration numbers into the Noon Sight TSX', () => {
    for (const [file, src] of Object.entries(tsx)) {
      expect(src, file).not.toMatch(/<Num value=\{(1\.5|2\.5|3|1500|2500|7)\}/)
      expect(src, file).not.toMatch(/NTRS 20240012429/)
    }
  })
})
