// Provenance rows come from the rules files the engine reads: every Tier B indicator has a row keyed by
// its own id (old ".reliability_r" deep links still resolve), the family is "Tier B indicators" (the
// single-case test uses no test-retest reliability), and the derived critical values are shown.
import { describe, expect, it } from 'vitest'
import { tCritical } from '../../app/engine'
import { isBuildNote, splitBuildNotes } from '../data/buildNotes'
import { KIND_FAMILY, PERSONAL, ROWS, designChoiceFamilies, findRow } from './model'

const r3 = (x: number) => Math.round(x * 1000) / 1000

describe('Tier B rows', () => {
  it('lists every indicator of personal.json under its own id, as a personal band', () => {
    for (const ind of PERSONAL!.indicators) {
      const row = ROWS.find((r) => r.id === ind.id)
      expect(row, ind.id).toBeTruthy()
      expect(row!.label).toContain(ind.label)
      expect(findRow(`${ind.id}.reliability_r`)?.row.id, 'old deep link').toBe(ind.id)
      if (!ind.reliability_r || ind.reliability_r.used_by_engine === false) expect(row!.value.kind).toBe('band')
    }
  })
  it('never calls the indicator family a test-retest reliability', () => {
    expect(KIND_FAMILY.reliability).toBe('Tier B indicators')
    for (const f of designChoiceFamilies(ROWS)) expect(f.family).not.toMatch(/reliability/i)
  })
  it('shows the derived critical values and the smallest flaggable change, computed by the engine', () => {
    const rci = PERSONAL!.rci
    const full = r3(tCritical(rci.alpha_two_tailed, rci.baseline_window_days - 1))
    const fewest = r3(tCritical(rci.alpha_two_tailed, rci.min_baseline_n - 1))
    const at = (id: string) => {
      const v = findRow(id)?.row.value
      return v?.kind === 'number' ? v.value : null
    }
    expect(at('rci.critical')).toBe(full)
    expect(at('rci.critical_min_baseline')).toBe(fewest)
    expect(at('rci.min_detectable_change_sd')).toBe(r3(full * Math.sqrt(1 + 1 / rci.baseline_window_days)))
    expect(full).toBe(4.221)
  })
})

describe('build notes', () => {
  it('recognises notes that cite the internal plan or the build process, and nothing else', () => {
    expect(isBuildNote("the plan's 'Rev F (May 2025)' is wrong")).toBe(true)
    expect(isBuildNote('Not in the plan: the numeric circadian lighting specification')).toBe(true)
    expect(isBuildNote('The LANDFALL plan cites NASA-STD-3001 Vol 1 Rev C')).toBe(true)
    expect(isBuildNote('as recorded in the project plan from the datatype registry')).toBe(true)
    expect(isBuildNote('analog.com did not answer automated requests from the build machine')).toBe(true)
    expect(isBuildNote('The crew must be able to follow sheltering procedures planned in the event')).toBe(false)
    expect(isBuildNote('the planetary surface')).toBe(false)
    expect(splitBuildNotes(['a', 'the plan is wrong', 'b'])).toEqual({ shown: ['a', 'b'], build: ['the plan is wrong'] })
  })
})
