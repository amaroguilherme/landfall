// Case timeline (SPEC 7) on the REAL frozen snapshots: re-open hysteresis on the real GOES-7 replay, a dismissed
// case during a continuing episode, and tier 1 of an escalation when the patient is the Crew Medical Officer.
import { describe, expect, it } from 'vitest'
import { RULES, formatMet, getCase } from './engine'
import type { Finding } from './engine'
import { caseKey, caseSchedule, computeCases, nextReopening, stateTierOne, tierOneFor, tierOneQuotes } from './caseTimeline'
import type { CaseEventRecord, TriggerStream } from './caseTimeline'
import { buildScenarioIndex, observationsFor } from './scenarioData'
import type { SimCrewData, SpeReplayData } from './scenarioData'
import { CREW_IDS } from './vocab'
import type { CrewId, EnvId, Observation } from './vocab'
import type { Snapshot } from './data'

const snaps = import.meta.glob<Snapshot>('../../public/data/{sim_crew,swpc_spe_replay,std_vol1_requirements,std_vol2_requirements}.json', {
  eager: true,
  import: 'default',
})
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))?.[1]
const INDEX = buildScenarioIndex(snap('sim_crew')!.data as SimCrewData, snap('swpc_spe_replay')!.data as SpeReplayData)
const NOW = INDEX.nowMet
const DAY = 86_400
const S3 = 1000

function cases(envId: EnvId, t: number, userEvents: CaseEventRecord[] = [], runtime: Observation[] = []) {
  return computeCases({ index: INDEX, runtime, envId, t, userEvents }, caseSchedule(INDEX, runtime, envId))
}
const view = (list: ReturnType<typeof cases>, crew: CrewId, id: string) => list.find((v) => v.key === caseKey(crew, id))!

/** The crew shelters, declines the confirmations with a reason and records an outcome: the T+6 h tripwire then judges the replay. */
function shelterActions(crew: CrewId): CaseEventRecord[] {
  const key = caseKey(crew, 'spe_shelter')
  const spec = view(cases('mars_surface', NOW), crew, 'spe_shelter').state.spec
  const ev = (seq: number, event: CaseEventRecord['event']): CaseEventRecord => ({ key, origin: 'user', seq, event })
  return [
    ev(1, { type: 'SELECT', t: NOW + 30, countermeasure_id: 'cm_shelter' }),
    ...spec.required_step_ids.map((id, i) => ev(2 + i, { type: 'DECLINE', t: NOW + 60 + i, step_id: id, reason: 'Confirmed by voice.' })),
    ev(30, { type: 'OUTCOME', t: NOW + 600, text: 'All four crew in the shelter.' }),
  ]
}

/**
 * The SPEC 7 rule recomputed from the flux alone (one trigger at Mars: the Mars-orbit monitor's S3 rule): each reading
 * holds until the next; after the escalation, the first reading at or above S3 that ends at least `clearS` of
 * readings below it.
 */
function expectedReopening(flux: readonly Observation[], escalatedAt: number, clearS: number): { t: number; clearSince: number } | null {
  let held = true // the flux was at S3 when the case escalated
  let since: number | null = null
  for (const o of flux) {
    if (o.t <= escalatedAt) {
      held = o.value >= S3
      since = held ? null : (since ?? o.t)
      continue
    }
    if (o.value >= S3) {
      if (!held && since !== null && o.t - since >= clearS) return { t: o.t, clearSince: since }
      held = true
      since = null
    } else if (held) {
      held = false
      since = o.t
    }
  }
  return null
}

describe('re-open hysteresis on the real replay (SPEC 7)', () => {
  const flux = observationsFor(INDEX, [], 'CM-1', 'proton_flux_10mev')
  const user = shelterActions('CM-1')
  const end = INDEX.replay.last_t!
  const atEnd = view(cases('mars_surface', end, user), 'CM-1', 'spe_shelter')
  const first = atEnd.state.previous_instances[0] ?? atEnd.state
  const escalatedAt = first.closed_at!
  const clearS = atEnd.state.spec.tripwire.reassess_after_s

  it('the shelter case escalates at T+6 h on the replay, while the flux is still at S3', () => {
    expect(first.status).toBe('escalated')
    expect(escalatedAt).toBe(NOW + 600 + clearS)
    const last = flux.filter((o) => o.t <= escalatedAt).at(-1)!
    expect(last.value).toBeGreaterThanOrEqual(S3)
  })

  it('a short dip below S3 does not reopen it: the escalated case stays instance 1 while the event continues', () => {
    // the first reading back at S3 after the escalation's first dip (414/05:55 in this replay)
    const dip = flux.find((o) => o.t > escalatedAt && o.value < S3)!
    const back = flux.find((o) => o.t > dip.t && o.value >= S3)!
    expect(back.t - dip.t).toBeLessThan(clearS)
    expect(formatMet(back.t)).toBe('414/05:55:00')
    for (const t of [back.t, back.t + 300, back.t + 3600]) {
      const v = view(cases('mars_surface', t, user), 'CM-1', 'spe_shelter')
      expect([v.state.instance, v.state.status], formatMet(t)).toEqual([1, 'escalated'])
    }
  })

  it('it opens instance 2 only when the flux returns to S3 after at least the reassessment time below it', () => {
    const want = expectedReopening(flux, escalatedAt, clearS)!
    expect(want).not.toBeNull()
    expect(want.t - want.clearSince).toBeGreaterThanOrEqual(clearS)
    expect(atEnd.instances.map((i) => [i.instance, i.status])).toEqual([
      [1, 'escalated'],
      [2, 'detected'],
    ])
    expect(atEnd.state.opened_at).toBe(want.t)
    const open = atEnd.state.log.filter((l) => l.event === 'OPEN' && l.error === null).at(-1)!
    expect(open.detail).toBe(
      `opened again by ops_onboard_proton_s3 (outside, warning): instance 2; instance 1 was escalated at MET ${formatMet(escalatedAt)}; ` +
        `triggers below caution from MET ${formatMet(want.clearSince)}`,
    )
    // in this replay: below S3 from 414/07:10 for 31 h 45 min, back at S3 at 415/14:55 (the replay's second S3 period)
    expect([formatMet(want.clearSince), formatMet(want.t), formatMet(want.t - want.clearSince)]).toEqual(['414/07:10:00', '415/14:55:00', '1/07:45:00'])
    // one minute before, the case is still the escalated instance 1
    expect(view(cases('mars_surface', want.t - 60, user), 'CM-1', 'spe_shelter').state.instance).toBe(1)
    // no OPEN was refused on the way: the timeline sends the reopen only when the engine accepts it
    expect(atEnd.state.log.filter((l) => l.event === 'OPEN' && l.error !== null)).toEqual([])
  })
})

describe('a dismissed case during a continuing episode (SPEC 7)', () => {
  const key = caseKey('CM-1', 'sleep_circadian')
  const opened = view(cases('mars_surface', NOW), 'CM-1', 'sleep_circadian').state.opened_at!
  const dismiss: CaseEventRecord = { key, origin: 'user', seq: 1, event: { type: 'DISMISS', t: opened + 600, reason: 'Known schedule change.' } }

  it('stays dismissed while the flags of the same episode continue (no 72 h clear period)', () => {
    const v = view(cases('mars_surface', NOW, [dismiss]), 'CM-1', 'sleep_circadian')
    expect([v.state.status, v.state.instance, v.state.dismiss_reason]).toEqual(['dismissed', 1, 'Known schedule change.'])
    // the condition persists: the triggers keep reaching caution on later days of the episode
    const streams = caseSchedule(INDEX, [], 'mars_surface').streams.get(key)!
    const laterDays = new Set<number>()
    for (const st of streams) {
      st.times.forEach((t, i) => {
        if (t > opened + 600 && t <= NOW && ['caution', 'warning'].includes(st.at(i).severity)) laterDays.add(Math.floor((t - 1) / DAY))
      })
    }
    expect(laterDays.size).toBeGreaterThanOrEqual(3)
    expect(v.state.log.filter((l) => l.event === 'OPEN').length).toBe(1)
  })

  it('a dismissed chance flag reopens for a later episode once its triggers were clear for 72 h', () => {
    // a runtime chance flag on day 390, far outside the band, dismissed; the scripted episode (day 404) is a new one
    const flag: Observation = { crew_id: 'CM-1', variable: 'sleep_midpoint_shift', value: 5, unit: 'h', t: 390 * DAY + 5 * 3600, source: 'band', provenance: 'manual' }
    const d: CaseEventRecord = { key, origin: 'user', seq: 1, event: { type: 'DISMISS', t: flag.t + 600, reason: 'Band off-wrist.' } }
    const v = view(cases('mars_surface', NOW, [d], [flag]), 'CM-1', 'sleep_circadian')
    expect(v.state.previous_instances.map((p) => [p.instance, p.status])).toEqual([[1, 'dismissed']])
    expect(v.state.instance).toBe(2)
    expect(Math.floor((v.state.opened_at! - 1) / DAY)).toBe(Math.floor((opened - 1) / DAY))
    expect(v.state.log.every((l) => l.error === null)).toBe(true)
  })
})

describe('nextReopening (SPEC 7): each reading holds until the next', () => {
  const caution = { severity: 'caution' } as Finding
  const fine = { severity: 'nominal' } as Finding
  const stream = (ref: string, pts: Array<[number, boolean]>): TriggerStream => ({
    trigger: { kind: 'rule', rule_id: ref },
    ref,
    tierB: false,
    times: pts.map((p) => p[0]),
    at: (i) => (pts[i][1] ? { ...caution, rule_id: ref } : { ...fine, rule_id: ref }),
  })
  it('a flapping reading opens nothing; a long enough clear period does', () => {
    const s = stream('a', [[0, true], [10, true], [20, false], [25, true], [30, false], [100, true]])
    expect(nextReopening([s], 0, 15, 1000, 50)).toMatchObject({ t: 100, clear_since: 30 })
    expect(nextReopening([s], 0, 15, 99, 50)).toBeNull() // not yet at the clock
    expect(nextReopening([s], 0, 15, 1000, 71)).toBeNull() // 70 s of clear readings is not 71
  })
  it('a data gap after a caution is not a clear period: the caution holds until a reading below it', () => {
    const s = stream('a', [[0, true], [10, true], [500, true]])
    expect(nextReopening([s], 0, 5, 1000, 60)).toBeNull()
    // and a gap after a reading below caution holds that reading: the clear period runs through the gap
    const t = stream('a', [[0, true], [10, false], [500, true]])
    expect(nextReopening([t], 0, 5, 1000, 60)).toMatchObject({ t: 500, clear_since: 10 })
  })
  it('the clear period may start before the close (a resolved case whose readings were back in range)', () => {
    const s = stream('a', [[0, true], [10, false], [20, false], [200, true]])
    expect(nextReopening([s], 0, 150, 1000, 100)).toMatchObject({ t: 200, clear_since: 10 })
  })
  it('every trigger must be clear: one still at caution keeps the case from a new episode', () => {
    const a = stream('a', [[0, true], [10, false], [300, true]])
    const b = stream('b', [[5, true], [250, false]])
    expect(nextReopening([a, b], 0, 20, 1000, 100)).toBeNull() // b cleared at 250: 50 s before a's caution at 300
    expect(nextReopening([a, b], 0, 20, 1000, 40)).toMatchObject({ t: 300, clear_since: 250, trigger: { rule_id: 'a' } })
  })
})

describe('tier 1 when the patient is the Crew Medical Officer: the crew\'s second Crew Medical Officer (meta.json escalation)', () => {
  const meta = (RULES.meta as unknown as { escalation: { tiers: Array<{ id: string; crew_id?: string; backup?: { crew_id: string; citations: Array<{ requirement_id: string; verbatim: string }> } }> } }).escalation
  it('names the Commander for CM-4, the Crew Medical Officer for everyone else, as the engine resolves it', () => {
    const list = cases('mars_surface', NOW)
    for (const crew of CREW_IDS) {
      const t1 = tierOneFor(crew)
      for (const def of RULES.cases!.cases as Array<{ id: string }>) {
        const v = view(list, crew, def.id)
        expect(v.tier1).toEqual(t1)
        expect([stateTierOne(v.state)?.id, stateTierOne(v.state)?.crew_id], `${crew} ${def.id}`).toEqual([t1.id, t1.crewId])
      }
      if (crew === 'CM-4') {
        expect([t1.id, t1.crewId, t1.backup, t1.chip]).toEqual(['backup_medical_officer', 'CM-1', true, 'design choice'])
        expect(t1.line).toBe("You are the Crew Medical Officer and the patient: tell the Commander (CM-1), the crew's second Crew Medical Officer, now.")
        expect(t1.roleText).toBe("the crew's second Crew Medical Officer")
      } else {
        expect([t1.id, t1.crewId, t1.backup]).toEqual(['crew_medical_officer', 'CM-4', false])
        expect(t1.line).toBe('Tell the Crew Medical Officer (CM-4) now.')
      }
    }
  })
  it('quotes [V2 7045] verbatim from the frozen Vol 2 snapshot, wherever it sits in the citations', () => {
    const t1 = tierOneFor('CM-4')
    expect(t1.citations).toEqual(meta.tiers[0].backup!.citations)
    const c = tierOneQuotes(t1).usability!
    expect(c.requirementId).toBe('V2 7045')
    const vol2 = snap('std_vol2_requirements')!.data as { requirements: Array<{ id: string; text: string }> }
    const req = vol2.requirements.find((r) => r.id === '[V2 7045]')!
    expect(req.text).toContain(c.verbatim)
    expect(c.verbatim).toBe('in the event that a physician crewmember is not present or is the one who requires medical treatment')
  })
  it('every [V1 3006] quote (two Crew Medical Officers per vehicle) is the frozen Vol 1 requirement\'s own words, in file order', () => {
    const vol1 = snap('std_vol1_requirements')!.data as { requirements: Array<{ id: string; text: string; rationale: string }> }
    const req = vol1.requirements.find((r) => r.id === 'V1 3006')!
    expect(req.text).toBe('The program(s) shall train a minimum of two crewmembers per vehicle/platform as Crew Medical Officers (CMOs).')
    expect(req.rationale).toContain('to ensure that a backup is available for medical treatment')
    const { secondCmo } = tierOneQuotes(tierOneFor('CM-4'))
    expect(secondCmo.map((q) => q.verbatim)).toEqual(
      tierOneFor('CM-4').citations.filter((c) => c.requirement_id === 'V1 3006').map((c) => c.verbatim),
    )
    for (const q of secondCmo) expect(`${req.text} ${req.rationale}`).toContain(q.verbatim)
    // the views print what is there: no [V1 3006] citation, no [V1 3006] quote; nobody else's tier 1 has a basis
    expect(tierOneQuotes({ citations: [] })).toEqual({ secondCmo: [], usability: null })
    expect(tierOneQuotes({ citations: [{ requirement_id: 'V2 7045' }, { verbatim: 'x' }, { requirement_id: 'V1 3006', verbatim: '' }] })).toEqual({ secondCmo: [], usability: null })
    expect(tierOneFor('CM-2').citations).toEqual([])
  })
  it("CM-4's shelter case escalates on the replay to the Commander, not to the patient", () => {
    const at = NOW + 600 + getCase(RULES, 'spe_shelter').tripwire!.reassess_after_s + 60
    const v = view(cases('mars_surface', at, shelterActions('CM-4')), 'CM-4', 'spe_shelter')
    expect(v.state.status).toBe('escalated')
    expect(v.state.escalation?.tiers).toEqual(['backup_medical_officer', 'flight_surgeon'])
    expect(v.state.log.at(-1)!.detail).toContain(
      'escalated: tier 1, the Commander (backup for the Crew Medical Officer, who is the patient), now; tier 2, the flight surgeon',
    )
    const cm2 = view(cases('mars_surface', at, shelterActions('CM-2')), 'CM-2', 'spe_shelter')
    expect(cm2.state.escalation?.tiers).toEqual(['crew_medical_officer', 'flight_surgeon'])
    expect(cm2.state.log.at(-1)!.detail).toContain('escalated: tier 1, the Crew Medical Officer, now')
  })
})
