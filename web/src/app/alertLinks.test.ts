// The annunciator's finding lines link the crewmember they are about (evaluate.ts alertsFor): CM-2's line opens CM-2's
// case or body map, never the mission bar's crewmember or the first open case. Crew-wide lines (ALL) are unchanged.
// On the REAL frozen snapshots and the REAL rules.
import { describe, expect, it } from 'vitest'
import { RULES, getRule } from './engine'
import { evaluateMission } from './evaluate'
import { buildScenarioIndex } from './scenarioData'
import type { SimCrewData, SpeReplayData } from './scenarioData'
import { ENV_IDS } from './vocab'
import type { Snapshot } from './data'

const snaps = import.meta.glob<Snapshot>('../../public/data/{sim_crew,swpc_spe_replay}.json', { eager: true, import: 'default' })
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))?.[1]
const INDEX = buildScenarioIndex(snap('sim_crew')!.data as SimCrewData, snap('swpc_spe_replay')!.data as SpeReplayData)
const NOW = INDEX.nowMet
const DAY = 86_400
const CASE_IDS = new Set(((RULES.cases?.cases ?? []) as Array<{ id: string }>).map((c) => c.id))

describe('annunciator links (alertsFor)', () => {
  it("at Mars at the scenario's now: every crewmember's line opens that crewmember", () => {
    const { alerts } = evaluateMission(INDEX, [], 'mars_surface', NOW)
    const crewLines = alerts.filter((a) => a.crew_id !== 'ALL')
    expect(crewLines.length).toBeGreaterThan(0)
    for (const a of crewLines) {
      expect(a.href, a.id).toContain(`crew=${a.crew_id}`)
      expect(a.href, a.id).toMatch(new RegExp(`^#/(body|case/[a-z_]+)\\?crew=${a.crew_id}$`))
    }
    expect(alerts.find((a) => a.id === 'CM-2:ffd_vo2max_surface_eva')!.href).toBe('#/body?crew=CM-2')
    expect(alerts.find((a) => a.id === 'CM-2:target_urine_output_24h')!.href).toBe('#/case/renal_stone?crew=CM-2')
    expect(alerts.find((a) => a.id === 'CM-1:sleep_midpoint_shift')!.href).toBe('#/case/sleep_circadian?crew=CM-1')
  })

  it('leaves the crew-wide S3 line, and every id, title and detail, as they were', () => {
    const { alerts } = evaluateMission(INDEX, [], 'mars_surface', NOW)
    const s3 = alerts.find((a) => a.crew_id === 'ALL')!
    expect(s3).toMatchObject({
      id: 'ALL:ops_onboard_proton_s3',
      severity: 'warning',
      title: getRule(RULES, 'ops_onboard_proton_s3').label,
      detail: 'Case open: Solar particle event: shelter',
      href: '#/case/spe_shelter',
      group: 'ALL:case:spe_shelter',
      case_id: 'spe_shelter',
    })
    // the hero's annunciator popup reads these words: only the links changed
    expect(alerts.map((a) => [a.id, a.severity, a.title, a.detail ?? null, a.group])).toEqual([
      ['ALL:ops_onboard_proton_s3', 'warning', 'Mars-orbit space-weather monitor: ≥10 MeV protons at the NOAA S3 level', 'Case open: Solar particle event: shelter', 'ALL:case:spe_shelter'],
      ['CM-1:sleep_midpoint_shift', 'caution', 'Sleep midpoint shift: reliable change against own baseline', null, 'CM-1:case:sleep_circadian'],
      ['CM-2:ffd_vo2max_surface_eva', 'caution', 'EVA fitness floor not met', 'VO2max floor, missions with extraterrestrial surface EVAs: outside', 'CM-2:ffd_vo2max_surface_eva'],
      ['CM-2:target_urine_output_24h', 'advisory', '24-h urine output (renal stone case): approaching', null, 'CM-2:case:renal_stone'],
    ])
  })

  it('holds in every environment and on other days of the record', () => {
    let crewLines = 0
    for (const env of ENV_IDS) {
      for (let k = 0; k <= 12; k++) {
        for (const a of evaluateMission(INDEX, [], env, NOW - k * DAY).alerts) {
          const [path, query] = (a.href ?? '').split('?')
          if (a.crew_id === 'ALL') {
            expect(query, a.id).toBeUndefined()
            continue
          }
          crewLines += 1
          expect(query, `${env} ${a.id}`).toBe(`crew=${a.crew_id}`)
          // the route is the one it always was: the case it opens (or its rule's case), else the body map
          const caseId = a.case_id ?? null
          if (path === '#/body') expect(caseId, a.id).toBeNull()
          else {
            const id = path.replace(/^#\/case\//, '')
            expect(CASE_IDS.has(id), `${a.id} -> ${path}`).toBe(true)
            if (caseId) expect(id).toBe(caseId)
          }
          expect(a.id.startsWith(`${a.crew_id}:`), a.id).toBe(true)
        }
      }
    }
    expect(crewLines).toBeGreaterThan(10)
  })
})
