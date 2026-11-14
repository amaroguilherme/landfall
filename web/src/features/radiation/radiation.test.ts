// Radiation model: replay time mapping (sim_crew's own mapping), S-level transitions, the NEXT
// predicted SAA passes (wall clock inside the window vs expired), and daily dose gaps.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dailySeries, findRequirement, firstReach, nextPasses, replayMapping, transitions, utcToMet } from './model'
import type { HapiDoseData, IssTrackData, ReplayData } from './model'

const snap = (id: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${id}.json`, import.meta.url), 'utf8'))

describe('replay mapping', () => {
  const sim = snap('sim_crew').data
  const m = replayMapping(sim)!
  it("puts the first S3 sample of 1989 where sim_crew says (MET 0412/14:15:00)", () => {
    const iso = sim.spe_day.shape.mapping.replay_utc_of_first_s3_sample
    expect(utcToMet(Date.parse(iso), m)).toBe(412 * 86_400 + 14 * 3600 + 15 * 60)
  })
  it('lists S1..S4 first-reach times in order, S3 at the shelter-case time', () => {
    const r = snap('swpc_spe_replay').data as ReplayData
    const reach = firstReach(transitions(r, m))
    expect(reach.map((x) => x.level)).toEqual([1, 2, 3, 4])
    expect(reach[2].met).toBe(412 * 86_400 + 14 * 3600 + 15 * 60)
  })
})

describe('next SAA passes', () => {
  const s = snap('hapi_iss_track')
  const track = s.data as IssTrackData
  it('counts from the wall clock while the prediction window is open', () => {
    const now = Date.parse(track.saa_rule.window.start) + 6 * 3_600_000
    const plan = nextPasses(track, s.retrieved_at, now)
    expect(plan.refKind).toBe('wall_clock')
    expect(plan.passes.every((p) => p.stopMs > now)).toBe(true)
    expect(plan.passes.length).toBeGreaterThan(0)
  })
  it('falls back to the retrieval time once the window has ended (shown as expired)', () => {
    const plan = nextPasses(track, s.retrieved_at, Date.parse('2026-12-20T00:00:00Z'))
    expect(plan.refKind).toBe('retrieval')
    expect(plan.refMs).toBe(Date.parse(s.retrieved_at))
    expect(plan.passes.length).toBeGreaterThan(0)
  })
})

describe('daily dose series', () => {
  it('keeps CRaTER days without samples as null gaps', () => {
    const raw = snap('hapi_crater_dose').data
    const s = dailySeries(raw as HapiDoseData)
    expect(s.gaps).toEqual(raw.days_without_samples as string[])
    expect(s.v.filter((v) => v === null).length).toBe(s.gaps.length)
  })
})

describe('requirement lookup', () => {
  it('finds [V2 6165] and V1 4031 whatever the bracket style', () => {
    expect(findRequirement(snap('std_vol2_requirements').data.requirements, 'V2 6165')?.text).toMatch(/space weather/)
    expect(findRequirement(snap('std_vol1_requirements').data.requirements, '[V1 4031]')?.text).toMatch(/October 1989/)
  })
})
