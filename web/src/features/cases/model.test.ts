// Cases feature helpers on the REAL frozen snapshots and rules (no Tier B statistic involved).
import { describe, expect, it } from 'vitest'
import { RULES, caseReduce, getCase, getRule, newCase, triggerLookup } from '../../app/engine'
import type { CaseState, Finding } from '../../app/engine'
import type { CaseView } from '../../app/caseTimeline'
import type { Snapshot } from '../../app/data'
import { buildScenarioIndex, observationsFor } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import { findRequirement, findTableCell, formatSpan, formatTMinus, pickCrew, prettyDetail, replayUtcOf, sLevelTransitions, stagesOf } from './model'
import type { StdData } from './model'

const snaps = import.meta.glob<Snapshot>('../../../public/data/{sim_crew,swpc_spe_replay,std_vol1_requirements,std_vol2_requirements}.json', {
  eager: true,
  import: 'default',
})
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))![1]
const sim = snap('sim_crew').data as SimCrewData
const replay = snap('swpc_spe_replay').data as SpeReplayData & { s_transitions: Array<[string, number | null]> }
const vol1 = snap('std_vol1_requirements').data as StdData
const vol2 = snap('std_vol2_requirements').data as StdData
const INDEX = buildScenarioIndex(sim, replay)
const DAY = 86_400

describe('S-level transitions of the onboard monitor', () => {
  it('match the replay snapshot’s own transitions, mapped to MET with sim_crew’s time shift', () => {
    const mapIso = sim.spe_day!.shape!.mapping!.replay_utc_at_met_0412_000000!
    const mapMet = sim.spe_day!.met_day! * DAY
    const series = observationsFor(INDEX, [], null, 'proton_flux_10mev')
    const seen = sLevelTransitions(series, INDEX.nowMet).filter((x) => x.t >= mapMet)
    // the snapshot's non-null level changes inside the same span (nulls are archive gaps)
    const expected: Array<{ utc: string; level: number }> = []
    let last: number | null = null
    for (const [utc, level] of replay.s_transitions) {
      if (level === null || level === last) continue
      const t = mapMet + (Date.parse(utc) - Date.parse(mapIso)) / 1000
      if (t < mapMet || t > INDEX.nowMet) {
        last = level
        continue
      }
      expected.push({ utc: `${utc.slice(0, 16).replace('T', ' ')} UTC`, level })
      last = level
    }
    const changes = seen.filter((x) => x.from !== null)
    expect(changes.map((x) => x.to)).toEqual(expected.map((e) => e.level))
    expect(changes.map((x) => replayUtcOf(x.t, mapIso, mapMet))).toEqual(expected.map((e) => e.utc))
    // the shelter level is reached 5 min before "now", as sim_crew documents
    const s3 = changes.find((x) => x.to === getRule(RULES, 'ops_onboard_proton_s3').s_level)!
    expect(INDEX.nowMet - s3.t).toBe(300)
  })
  it('never shows a sample after the clock (no forecast)', () => {
    const series = observationsFor(INDEX, [], null, 'proton_flux_10mev')
    expect(sLevelTransitions(series, INDEX.nowMet).every((x) => x.t <= INDEX.nowMet)).toBe(true)
    expect(sLevelTransitions(series, INDEX.nowMet + 2 * DAY).length).toBeGreaterThan(sLevelTransitions(series, INDEX.nowMet).length)
  })
})

describe('verbatim lookups', () => {
  it('finds requirement text in either volume, with or without brackets', () => {
    expect(findRequirement('V1 4027', vol1, vol2)?.text).toContain(String(getRule(RULES, 'pol_bmd_hip').limit))
    expect(findRequirement('[V2 6164]', vol1, vol2)?.text).toMatch(/radiation monitoring system shall alert/)
    expect(findRequirement('V2 6164', vol1, vol2)?.rationale).toMatch(/ground communication is disrupted/)
    expect(findRequirement('V9 0000', vol1, vol2)).toBeNull()
  })
  it('reads a Table 4.8-1 cell for a rule whose source is the table', () => {
    const r = getRule(RULES, 'pel_t481_bfo_30d')
    const cell = findTableCell(r.source, vol1)
    expect(cell?.text).toContain(String(r.limit))
    expect(cell?.text).toContain(r.unit)
  })
})

describe('case loop stages and text', () => {
  const def = getCase(RULES, 'renal_stone')
  const rule = getRule(RULES, 'target_urine_output_24h')
  const finding = { rule_id: rule.id, severity: 'caution', status: 'outside' } as unknown as Finding
  const fold = (events: Parameters<typeof caseReduce>[1][]) => events.reduce<CaseState>((s, e) => caseReduce(s, e), newCase(def, 'CM-3', triggerLookup(RULES)))
  it('walks detect -> act -> procedure -> tripwire', () => {
    const idle = stagesOf(newCase(def, 'CM-3', triggerLookup(RULES)))
    expect(idle.every((s) => s.state === 'todo')).toBe(true)
    const opened = fold([{ type: 'OPEN', t: 100, finding }])
    expect(stagesOf(opened).find((s) => s.id === 'act')!.state).toBe('current')
    const watch = fold([
      { type: 'OPEN', t: 100, finding },
      { type: 'SELECT', t: 200, countermeasure_id: def.countermeasure!.primary.id },
      { type: 'STEP', t: 300, step_id: def.procedure![0].id },
      { type: 'OUTCOME', t: 400, text: 'done' },
    ])
    const st = stagesOf(watch)
    expect(st.find((s) => s.id === 'tripwire')).toMatchObject({ state: 'current', t: 400 + def.tripwire!.reassess_after_s })
    expect(st.find((s) => s.id === 'procedure')!.note).toBe(`1 of ${def.procedure!.length}`)
    expect(prettyDetail(watch.log[watch.log.length - 1].detail)).toMatch(/reassess at MET \d{4}\/\d{2}:\d{2}:\d{2}/)
  })
  it('formats spans and countdowns', () => {
    expect(formatSpan(def.tripwire!.reassess_after_s)).toBe(`${def.tripwire!.reassess_after_s / 3600} h`)
    expect(formatTMinus(63_592)).toBe('17:39:52')
    expect(formatTMinus(-5)).toBe('00:00:00')
    expect(formatTMinus(DAY + 61)).toBe('1 d 00:01:01')
  })
})

describe('crew selection', () => {
  const v = (crewId: string, status: string) => ({ caseId: 'renal_stone', crewId, state: { status } }) as unknown as CaseView
  const views = [v('CM-1', 'idle'), v('CM-2', 'idle'), v('CM-3', 'watch'), v('CM-4', 'idle')]
  it('lands on the crewmember whose case is open unless the query names one', () => {
    expect(pickCrew('renal_stone', views, undefined, 'CM-1')).toBe('CM-3')
    expect(pickCrew('renal_stone', views, 'CM-2', 'CM-1')).toBe('CM-2')
    expect(pickCrew('renal_stone', views, 'CM-9', 'CM-1')).toBe('CM-3')
    expect(pickCrew('renal_stone', views.map((x) => ({ ...x, state: { status: 'idle' } }) as unknown as CaseView), undefined, 'CM-4')).toBe('CM-4')
  })
})
