import { describe, expect, it } from 'vitest'
import type { ManifestEntry } from '../../app/data'
import { classifyAccessUrl, computeStats, durationParts, groupByPublisher, joinAnd, sameUrl } from './model'
import { RULE_CITATIONS, citationCount } from './rulesIndex'

const entry = (over: Partial<ManifestEntry>): ManifestEntry => ({
  id: 'x',
  adapter: 'a',
  title: 't',
  file: 'x.json',
  bytes: 1000,
  sha256: '0'.repeat(64),
  retrieved_at: '2026-11-14T13:00:00Z',
  provenance: 'measured',
  freshness: { kind: 'historical', stale_after: null },
  coverage: { start: null, stop: null, cadence: null },
  publisher: 'NASA Example',
  url: 'https://example.nasa.gov/',
  ...over,
})

describe('data sources model', () => {
  it('groups by exact publisher, NASA first and LANDFALL last, ids sorted', () => {
    const g = groupByPublisher([
      entry({ id: 'sim_crew', publisher: 'LANDFALL project (simulated scenario generator)', provenance: 'simulated' }),
      entry({ id: 'b', publisher: 'NOAA Space Weather Prediction Center (SWPC)' }),
      entry({ id: 'z', publisher: 'NASA Human Research Program' }),
      entry({ id: 'c', publisher: 'Canadian Space Agency' }),
      entry({ id: 'a', publisher: 'NASA Human Research Program' }),
    ])
    expect(g.map((x) => x.publisher)).toEqual([
      'NASA Human Research Program',
      'NOAA Space Weather Prediction Center (SWPC)',
      'Canadian Space Agency',
      'LANDFALL project (simulated scenario generator)',
    ])
    expect(g[0].entries.map((e) => e.id)).toEqual(['a', 'z'])
    expect(new Set(g.map((x) => x.slug)).size).toBe(g.length)
  })

  it('counts provenance, bytes, the frozen window and stale live feeds', () => {
    const now = new Date('2026-11-14T14:00:00Z')
    const s = computeStats(
      [
        entry({ id: 'live', freshness: { kind: 'live', stale_after: 'PT15M' }, retrieved_at: '2026-11-14T13:44:00Z' }),
        entry({ id: 'ref', provenance: 'reference', freshness: { kind: 'reference', stale_after: null }, bytes: 500 }),
        entry({ id: 'sim_crew', provenance: 'simulated', publisher: 'LANDFALL project', retrieved_at: '2026-11-14T13:46:00Z' }),
      ],
      now,
    )
    expect(s.count).toBe(3)
    expect(s.bytes).toBe(2500)
    expect(s.byProvenance.measured.map((e) => e.id)).toEqual(['live'])
    expect(s.byProvenance.derived).toEqual([])
    expect(s.stale.map((e) => e.id)).toEqual(['live'])
    expect(s.firstRetrieved).toBe('2026-11-14T13:00:00Z')
    expect(s.lastRetrieved).toBe('2026-11-14T13:46:00Z')
    expect(s.realAgencies).toEqual(['NASA'])
  })

  it('formats exact durations without rounding', () => {
    expect(durationParts(3600)).toEqual([{ value: 1, unit: 'h' }])
    expect(durationParts(82_800)).toEqual([{ value: 23, unit: 'h' }])
    expect(durationParts(90)).toEqual([
      { value: 1, unit: 'min' },
      { value: 30, unit: 's' },
    ])
    expect(durationParts(0)).toEqual([{ value: 0, unit: 's' }])
  })

  it('classifies access URLs, including repo paths to frozen snapshots', () => {
    expect(classifyAccessUrl('https://ssd.jpl.nasa.gov/horizons/')).toEqual({ kind: 'external', href: 'https://ssd.jpl.nasa.gov/horizons/' })
    expect(classifyAccessUrl('web/public/data/swpc_spe_replay.json')).toMatchObject({ kind: 'snapshot', id: 'swpc_spe_replay' })
    expect(classifyAccessUrl('ftp-ish thing')).toEqual({ kind: 'other', text: 'ftp-ish thing' })
    const keyed = 'https://api.nasa.gov/DONKI/SEP?startDate=2024-01-01&endDate=2024-02-29&api_key=<NASA_API_KEY>'
    expect(classifyAccessUrl(keyed)).toEqual({ kind: 'other', text: keyed })
  })

  it('compares landing URLs ignoring scheme, host case and trailing slash', () => {
    expect(sameUrl('https://www.nasa.gov/hrp/risks/', 'https://WWW.nasa.gov/hrp/risks')).toBe(true)
    expect(sameUrl('https://www.nasa.gov/hrp/risks/', 'https://www.nasa.gov/hrp/hazards/')).toBe(false)
    expect(sameUrl(null, 'https://www.nasa.gov/')).toBe(false)
  })

  it('joins lists in plain English', () => {
    expect(joinAnd(['NASA'])).toBe('NASA')
    expect(joinAnd(['NASA', 'NOAA', 'CSA'])).toBe('NASA, NOAA and CSA')
  })

  it('indexes the rules files that cite each snapshot', () => {
    // The standards snapshot backs the Tier A rules (SPEC section 3: source.snapshot).
    const vol1 = RULE_CITATIONS.get('std_vol1_requirements')
    expect(citationCount(vol1)).toBeGreaterThan(0)
    expect(vol1?.some((c) => c.file === 'thresholds.json' && c.owners.includes('pel_career_effective_dose'))).toBe(true)
    // environments.json points each environment at its dose snapshot.
    expect(RULE_CITATIONS.get('hapi_msl_rad_dose')?.some((c) => c.file === 'environments.json' && c.owners.includes('mars_surface'))).toBe(true)
  })
})
