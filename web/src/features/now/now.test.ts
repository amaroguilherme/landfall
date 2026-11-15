// Now (hero) helpers, on the REAL rules (engine/rules) and the REAL frozen snapshots (public/data).
// None of these depends on Tier B, so they hold while the personal statistic changes.
import { describe, expect, it } from 'vitest'
import { RULES, getCase, getRule, sLevel, thresholdRules } from '../../app/engine'
import type { CaseView } from '../../app/caseTimeline'
import { computeCases } from '../../app/caseTimeline'
import type { Snapshot } from '../../app/data'
import { chanceRateOf, evaluateOps } from '../../app/evaluate'
import type { AlertItem } from '../../app/mission'
import { buildScenarioIndex, observationsFor } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import {
  SEQUENCE,
  SPE_CASE_ID,
  caseQuote,
  crewStatuses,
  findRequirement,
  fluxWindow,
  opsRule,
  otherOpenCases,
  phaseAt,
  pickView,
  primaryOf,
  rollValue,
  runOnboard,
  sLevelDescriptor,
  sLevelLines,
  sourceRuleOf,
  speDef,
  triggerLabel,
  unscriptedOpenings,
  verbatimCheck,
  logRange,
} from './model'

const snaps = import.meta.glob<Snapshot>('../../../public/data/{sim_crew,swpc_spe_replay,std_vol2_requirements}.json', {
  eager: true,
  import: 'default',
})
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))?.[1]
const SIM = snap('sim_crew')!
const REPLAY = snap('swpc_spe_replay')!
const VOL2 = snap('std_vol2_requirements')!
const INDEX = buildScenarioIndex(SIM.data as SimCrewData, REPLAY.data as SpeReplayData)
const NOW = INDEX.nowMet

// The TSX sources of this feature, as text (honesty guard below).
const sources = import.meta.glob<string>('./*.tsx', { eager: true, query: '?raw', import: 'default' })

describe('autoplay sequence', () => {
  it('lights LANDFALL first (action and latency within 0.3 s), then runs Houston, then ends', () => {
    expect(phaseAt(0)).toBe('landfall')
    expect(phaseAt(SEQUENCE.rollStart - 1)).toBe('landfall')
    expect(phaseAt(SEQUENCE.rollStart)).toBe('eta')
    expect(phaseAt(SEQUENCE.queuedAt - 1)).toBe('eta')
    expect(phaseAt(SEQUENCE.queuedAt)).toBe('link')
    expect(phaseAt(SEQUENCE.doneAt)).toBe('done')
    expect(phaseAt(Number.POSITIVE_INFINITY)).toBe('done')
    // the onboard answer is on screen before Houston's counter starts, and within 0.3 s
    expect(SEQUENCE.landfallAt).toBeLessThan(SEQUENCE.rollStart)
    expect(SEQUENCE.actionAt + 200).toBeLessThanOrEqual(300)
    expect(SEQUENCE.rollStart).toBeLessThan(SEQUENCE.rollEnd)
    expect(SEQUENCE.rollEnd).toBeLessThan(SEQUENCE.queuedAt)
    expect(SEQUENCE.queuedAt).toBeLessThan(SEQUENCE.doneAt)
  })
  it('counts 0 -> target, monotonic, exactly the target at the end', () => {
    const target = 2381.0049
    expect(rollValue(0, target)).toBe(0)
    let prev = -1
    for (let ms = SEQUENCE.rollStart; ms <= SEQUENCE.rollEnd; ms += 50) {
      const v = rollValue(ms, target)
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(v).toBeLessThanOrEqual(target)
      prev = v
    }
    expect(rollValue(SEQUENCE.rollEnd, target)).toBe(target)
    expect(rollValue(Number.POSITIVE_INFINITY, target)).toBe(target)
  })
})

describe('[V2 6164] quote', () => {
  it('comes from cases.json and is verbatim in the frozen Vol 2 rationale', () => {
    const q = caseQuote(speDef())!
    expect(q).not.toBeNull()
    expect(q.snapshot).toBe('std_vol2_requirements')
    const req = findRequirement(VOL2.data, q.requirementId)
    expect(req).not.toBeNull()
    expect(req!.rationale).toContain(q.text)
    expect(verbatimCheck(req, q.text)).toBe('verified')
    expect(verbatimCheck(req, q.text.replace('unviable', 'unavailable'))).toBe('mismatch')
    expect(verbatimCheck(null, q.text)).toBe('unchecked')
  })
})

describe('OPS rules', () => {
  it('reads the S-levels and descriptors from the NOAA-published rules', () => {
    const noaa = thresholdRules(RULES).filter((r) => r.category === 'OPS' && !r.derived_from_rule)
    const lines = sLevelLines()
    expect(lines.map((l) => l.level)).toEqual(noaa.map((r) => r.s_level).sort((a, b) => (a ?? 0) - (b ?? 0)))
    for (const l of lines) expect(sLevel(l.limit)).toBe(l.level)
    const s3 = noaa.find((r) => r.s_level === 3)!
    expect(sLevelDescriptor(3)).toBe(s3.descriptor)
    expect(sLevelDescriptor(null)).toBeNull()
  })
  it('the onboard (Mars) rule reuses the NOAA S3 rule and its number', () => {
    const onboard = opsRule('ops_onboard_proton_s3')!
    const src = sourceRuleOf(onboard)!
    expect(src.id).toBe(onboard.derived_from_rule)
    expect(src.limit).toBe(onboard.limit)
    expect(src.chip).not.toBe(onboard.chip) // NOAA-published vs design choice
    expect(sourceRuleOf(getRule(RULES, 'ops_noaa_s3'))).toBeNull()
  })
})

describe('onboard monitor window', () => {
  const rule = getRule(RULES, 'ops_onboard_proton_s3')
  const obs = observationsFor(INDEX, [], null, rule.variable)
  it('shows only readings that exist at the clock, ending at the latest one', () => {
    const w = fluxWindow(obs, NOW, 8 * 3600, rule.limit)
    expect(w.xs.length).toBeGreaterThan(0)
    expect(Math.max(...w.xs)).toBeLessThanOrEqual(NOW)
    expect(Math.min(...w.xs)).toBeGreaterThanOrEqual(NOW - 8 * 3600)
    const ops = evaluateOps(INDEX, [], 'mars_surface', NOW)
    expect(w.last?.value).toBe(ops.flux)
    expect(w.last?.t).toBe(ops.t)
    // the post-"now" replay is not visible at now, and appears as the clock passes it
    expect(fluxWindow(obs, NOW, 8 * 3600, rule.limit, NOW).replayAfterNow).toBe(0)
    expect(fluxWindow(obs, NOW + 3600, 8 * 3600, rule.limit, NOW).replayAfterNow).toBeGreaterThan(0)
  })
  it('colours only samples at or above the threshold (plus the joining sample)', () => {
    const w = fluxWindow(obs, NOW, 8 * 3600, rule.limit)
    let over = 0
    for (let i = 0; i < w.ys.length; i++) {
      const o = w.over[i]
      if (o === null) continue
      over++
      const joins = i + 1 < w.over.length && w.over[i + 1] !== null && (w.ys[i] ?? 0) < rule.limit
      expect((w.ys[i] ?? 0) >= rule.limit || joins).toBe(true)
    }
    expect(over).toBeGreaterThan(0) // the event crossed S3 before now (case opened)
  })
  it('log range covers the data and a decade above the threshold', () => {
    const w = fluxWindow(obs, NOW, 8 * 3600, rule.limit)
    const [lo, hi] = logRange(w.ys, rule.limit)
    for (const v of w.ys) if (v !== null) expect(v >= lo && v <= hi).toBe(true)
    expect(hi).toBeGreaterThanOrEqual(rule.limit * 10)
    expect(logRange([], null)).toEqual([0.1, 10])
  })
})

describe('the onboard path the hero times (run on demand)', () => {
  it('opens the shelter case from the latest monitor reading, with the rule of the environment', () => {
    let clock = 1000
    const mars = runOnboard(INDEX, [], 'mars_surface', NOW, 'CM-1', () => clock++)
    expect(mars.startedAt).toBe(1000)
    expect(mars.opened).toBe(true)
    expect(mars.ruleId).toBe('ops_onboard_proton_s3')
    expect(mars.state?.status).toBe('detected')
    expect(mars.finding?.severity).toBe('warning')
    expect(mars.finding?.value).toBe(evaluateOps(INDEX, [], 'mars_surface', NOW).flux)
    expect(runOnboard(INDEX, [], 'iss', NOW, 'CM-2').ruleId).toBe('ops_noaa_s3')
  })
  it('opens nothing before the crossing, so there is nothing to time', () => {
    const before = runOnboard(INDEX, [], 'mars_surface', NOW - 3600, 'CM-1')
    expect(before.opened).toBe(false)
    expect(before.state).toBeNull()
  })
})

describe('the simulator\'s own report on unscripted openings', () => {
  it('reads sim_crew self_check.unscripted_case_openings and names the trigger in plain language', () => {
    const list = unscriptedOpenings(SIM.data)
    const raw = (SIM.data as { self_check?: { unscripted_case_openings?: unknown[] } }).self_check?.unscripted_case_openings ?? []
    expect(list).toHaveLength(raw.length)
    for (const u of list) {
      expect(triggerLabel(u.indicator_id)).toBe(getCase(RULES, u.case_id) ? (RULES.personal!.indicators.find((i) => i.id === u.indicator_id)?.label ?? null) : null)
      expect(triggerLabel(u.indicator_id)).not.toContain('_')
    }
    expect(unscriptedOpenings(null)).toEqual([])
    expect(unscriptedOpenings({ self_check: { unscripted_case_openings: [{ crew_id: 'CM-1' }] } })).toEqual([])
  })
})

// This one reads Tier B at the project seed (never re-drawn, SPEC 7): the generator's own chance openings.
describe('possibly chance on the hero (SPEC 7, lead decision S4)', () => {
  it("labels every other open case opened by a single Tier B flag with the engine's own chance text", () => {
    const views = computeCases({ index: INDEX, runtime: [], envId: 'mars_surface', t: NOW, userEvents: [] })
    const others = otherOpenCases(views, SPE_CASE_ID)
    const single = others.filter((v) => v.chance)
    // at the project seed the generator reports a chance opening that is still a single flag at now (CM-3's sleep case)
    const reported = unscriptedOpenings(SIM.data).filter((u) => others.some((v) => v.crewId === u.crew_id && v.caseId === u.case_id))
    expect(reported.length).toBeGreaterThan(0)
    for (const u of reported) expect(single.some((v) => v.crewId === u.crew_id && v.caseId === u.case_id), `${u.crew_id} ${u.case_id}`).toBe(true)
    for (const v of single) {
      const rate = chanceRateOf(v.chance!.indicatorId)!
      expect(v.chance!.text).toBe(`Possibly chance: ${rate.text}`)
      expect(v.chance!.text).toMatch(/^Possibly chance: about 1 in \d+ days per crewmember would flag like this with no real change$/)
    }
    // the hero's list prints that note (the engine's N), not only the simulator's own answer key
    const secondary = Object.entries(sources).find(([k]) => k.endsWith('/Secondary.tsx'))![1]
    expect(secondary).toContain('{v.chance.text}')
  })
})

describe('crew strip', () => {
  const a = (id: string, crew: AlertItem['crew_id'], severity: AlertItem['severity']): AlertItem => ({ id, crew_id: crew, severity, title: id })
  it('takes the worst severity per crewmember, crew-wide alerts included', () => {
    const s = crewStatuses([a('ALL:ops', 'ALL', 'warning'), a('CM-2:ffd', 'CM-2', 'caution'), a('CM-1:pvt', 'CM-1', 'warning')])
    const by = Object.fromEntries(s.map((x) => [x.crewId, x]))
    expect(by['CM-2'].severity).toBe('warning') // the crew-wide S3 warning outranks a fitness caution
    expect(by['CM-2'].top?.id).toBe('ALL:ops')
    expect(by['CM-1'].top?.id).toBe('CM-1:pvt') // own finding preferred over a crew-wide one of equal severity
    expect(by['CM-3'].top?.id).toBe('ALL:ops')
    expect(by['CM-1'].count).toBe(2)
    expect(crewStatuses([])[0]).toMatchObject({ severity: 'nominal', top: null, count: 0, items: [] })
  })
  it('lists the crewmember\'s own finding next to the crew-wide one, so a crew-wide warning never hides it', () => {
    const s = crewStatuses([a('ALL:ops', 'ALL', 'warning'), a('CM-2:ffd', 'CM-2', 'caution'), a('CM-2:bp', 'CM-2', 'advisory')])
    const cm2 = s.find((x) => x.crewId === 'CM-2')!
    expect(cm2.severity).toBe('warning')
    expect(cm2.items.map((x) => x.id)).toEqual(['ALL:ops', 'CM-2:ffd']) // most severe first; the own worst one shown
    expect(cm2.count - cm2.items.length).toBe(1) // "+ 1 more"
    const cm3 = s.find((x) => x.crewId === 'CM-3')!
    expect(cm3.items.map((x) => x.id)).toEqual(['ALL:ops'])
  })
})

describe('cases', () => {
  const view = (crewId: CaseView['crewId'], caseId: string, status: string) =>
    ({ key: `${crewId}:${caseId}`, crewId, caseId, def: getCase(RULES, caseId), state: { status }, logOrigins: [], opening: null }) as unknown as CaseView
  it('lists the other open cases, most urgent first, and picks the selected crewmember', () => {
    const list = [view('CM-3', 'renal_stone', 'watch'), view('CM-1', 'sleep_circadian', 'acting'), view('CM-2', SPE_CASE_ID, 'detected'), view('CM-1', SPE_CASE_ID, 'detected'), view('CM-4', 'renal_stone', 'idle')]
    expect(otherOpenCases(list, SPE_CASE_ID).map((v) => v.key)).toEqual(['CM-1:sleep_circadian', 'CM-3:renal_stone'])
    const spe = list.filter((v) => v.caseId === SPE_CASE_ID)
    expect(pickView(spe, 'CM-1')?.crewId).toBe('CM-1')
    expect(pickView(spe, 'CM-4')?.crewId).toBe('CM-2')
    expect(pickView([], 'CM-1')).toBeNull()
  })
  it('shows exactly one primary countermeasure, from cases.json', () => {
    const def = getCase(RULES, SPE_CASE_ID)
    expect(primaryOf(def)?.id).toBe(def.countermeasure?.primary.id)
  })
})

describe('honesty guard', () => {
  it('types no NASA/NOAA number of the hero case in TSX (they come from rules, snapshots or the engine)', () => {
    const def = getCase(RULES, SPE_CASE_ID)
    const numbers = new Set<string>()
    // OPS limits from S3 up (1e3+). S1/S2 (10, 100) are too common in layout code to guard as text;
    // they reach the chart through the same sLevelLines() path, tested above.
    for (const r of thresholdRules(RULES).filter((x) => x.category === 'OPS' && x.limit >= 1e3)) numbers.add(String(r.limit))
    numbers.add(String(def.tripwire?.reassess_after_s))
    const q = caseQuote(def)!
    numbers.add(q.requirementId.replace(/\D+/g, ' ').trim().split(' ').pop()!)
    if (q.page !== null) numbers.add(String(q.page))
    expect(Object.keys(sources).length).toBeGreaterThan(3)
    for (const [file, raw] of Object.entries(sources)) {
      // Judge the code, not the comments (comments may name the requirement they implement).
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const n of numbers) {
        expect(new RegExp(`(^|[^\\w.])${n.replace('.', '\\.')}(?![\\w.])`).test(text), `${file} types ${n}`).toBe(false)
      }
    }
  })
})
