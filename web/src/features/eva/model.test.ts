// #/eva on the REAL frozen snapshots (web/public/data) and the REAL rules (engine/rules): the [V1 6006] evidence
// board for the scenario's crewmember CM-2 at Mars (behind the Sun) and at the ISS. Every number below is read
// from the data or computed by the engine; the measured values are pinned where the brief asked for them.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { caseSchedule, computeCases } from '../../app/caseTimeline'
import { commsSnapshotId, computeComms, formatCommsLightTime, formatCountdown, formatEarliestReply, formatLightTime } from '../../app/comms'
import type { Snapshot, SnapshotState } from '../../app/data'
import { RULES, formatMet } from '../../app/engine'
import { evaluateMission } from '../../app/evaluate'
import { MET_NOW_S, environment } from '../../app/scenario'
import { buildScenarioIndex, observationsFor, seriesKey } from '../../app/scenarioData'
import type { ScenarioIndex, SimCrewData, SpeReplayData } from '../../app/scenarioData'
import type { CrewId, EnvId, Observation } from '../../app/vocab'
import { EvaView } from './index'
import type { EvaSnapshots } from './index'
import {
  EVIDENCE_PHRASES,
  METRIC_INDICATORS,
  NEVER_CLEARS,
  evaBoard,
  findRequirement,
  groundOf,
  rationaleText,
} from './model'
import type { EvaBoard, EvaSources, SScaleData, SepEventsData, StdData } from './model'

const snaps = import.meta.glob<Snapshot>(
  '../../../public/data/{sim_crew,swpc_spe_replay,horizons_mars_comms,horizons_moon_comms,std_vol1_requirements,std_vol2_requirements,swpc_s_scale,hapi_msl_rad_sep_events}.json',
  { eager: true, import: 'default' },
)
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))![1]
const SIM = snap('sim_crew')
const REPLAY = snap('swpc_spe_replay')
const VOL1 = snap('std_vol1_requirements')
const VOL2 = snap('std_vol2_requirements')
const SSCALE = snap('swpc_s_scale')
const SEP = snap('hapi_msl_rad_sep_events')
const INDEX = buildScenarioIndex(SIM.data as SimCrewData, REPLAY.data as SpeReplayData)
const NOW = INDEX.nowMet
const ready = <T,>(s: Snapshot): SnapshotState<T> => ({ status: 'ready', snapshot: s, data: s.data as T, error: null }) as unknown as SnapshotState<T>
const SOURCES: EvaSources = {
  vol1: VOL1.data as StdData,
  vol2: VOL2.data as StdData,
  sScale: SSCALE.data as SScaleData,
  sep: SEP.data as SepEventsData,
}
const met = (d: number, h: number, m = 0, s = 0) => d * 86_400 + h * 3600 + m * 60 + s

/** computeComms with the environment's own ephemeris (Mars: horizons_mars_comms; the Moon: horizons_moon_comms; none elsewhere). */
function commsAt(envId: EnvId, t: number) {
  const env = environment(envId)
  const id = commsSnapshotId(env)
  const ephem = id === null ? null : { status: 'ready' as const, snapshot: snap(id) }
  return computeComms(env, t, ephem, { status: 'ready', snapshot: SIM })
}

function boardFor(envId: EnvId, crewId: CrewId = 'CM-2', index: ScenarioIndex = INDEX, t = NOW, runtime: Observation[] = []): { board: EvaBoard; evaluation: ReturnType<typeof evaluateMission> } {
  const evaluation = evaluateMission(index, runtime, envId, t)
  const caseViews = computeCases({ index, runtime, envId, t, userEvents: [] }, caseSchedule(index, runtime, envId))
  const comms = commsAt(envId, t)
  const commsAtResume = comms.resumes_at !== null ? commsAt(envId, comms.resumes_at) : null
  const checkins = (index.series.get(seriesKey(crewId, 'mood')) ?? []).map((o) => o.t)
  const board = evaBoard({
    crewId,
    env: environment(envId),
    comms,
    commsAtResume,
    evaluation,
    caseViews,
    observations: observationsFor(index, runtime, crewId, 'vo2max'),
    checkins,
    sources: SOURCES,
    t,
  })
  return { board, evaluation }
}

const MARS = boardFor('mars_surface')
const ISS = boardFor('iss')
const row = (b: EvaBoard, key: string) => b.groups.flatMap((g) => g.rows).find((r) => r.key === key)!

describe('the [V1 6006] text and its three phrases are the frozen standard’s', () => {
  it('quotes the requirement and its rationale verbatim (Vol 1 Rev C, p. 52)', () => {
    const raw = findRequirement(VOL1.data as StdData, 'V1 6006')!
    expect(raw.text).toBe('All crewmembers shall be medically cleared to perform an EVA by ground medical support personnel prior to each EVA.')
    expect(MARS.board.requirement?.text).toBe(raw.text)
    expect(MARS.board.requirement?.page).toBe(raw.printed_page)
    expect(MARS.board.requirement?.page).toBe(52)
    expect(MARS.board.requirement?.section).toBe(raw.section)
    expect(MARS.board.requirement?.section).toBe('6.4')
    expect(MARS.board.requirement?.verified).toBe(true)
    // the rationale without its "[Rationale: ...]" wrapper is a substring of the frozen string
    expect(raw.rationale).toContain(MARS.board.requirement!.rationale!)
    expect(rationaleText(raw)).toBe(
      'EVA crewmembers are evaluated for their health status and fitness levels prior to EVAs. Flight Surgeon on ground evaluates available data from recent medical evaluations, fitness sessions, and other metrics of health and performance to determine readiness for EVA.',
    )
    expect(VOL1.source.citation).toContain('e65882af9c9a9861b520268f739baadba08f6225feb14489ff7c46442de26ce9')
  })
  it('groups the evidence under the rationale’s own three phrases, in its order, each found verbatim', () => {
    expect(MARS.board.groups.map((g) => g.phrase)).toEqual(EVIDENCE_PHRASES.map((p) => p.phrase))
    expect(MARS.board.groups.every((g) => g.phraseFound)).toBe(true)
    const r = MARS.board.requirement!.rationale!
    const at = EVIDENCE_PHRASES.map((p) => r.indexOf(p.phrase))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
  it('reports a missing snapshot as not found, never a typed fallback', () => {
    const comms = commsAt('mars_surface', NOW)
    const b = evaBoard({ crewId: 'CM-2', env: environment('mars_surface'), comms, evaluation: null, caseViews: [], observations: [], sources: { vol1: null, vol2: null, sScale: null, sep: null }, t: NOW })
    expect(b.requirement).toBeNull()
    expect(b.groups.every((g) => !g.phraseFound)).toBe(true)
    expect(b.monitoring.requirements).toEqual([])
    expect(b.constraints.rad).toBeNull()
  })
})

describe('the ground link at Mars, MET 412/14:20:00 (behind the Sun)', () => {
  const b = MARS.board
  const comms = commsAt('mars_surface', NOW)
  it('is unreachable, from loss of signal to the link resuming (horizons_mars_comms, mars_conjunction_2028_03)', () => {
    expect(NOW).toBe(MET_NOW_S)
    expect(b.ground).toBe('unreachable')
    expect(comms.window?.id).toBe('mars_conjunction_2028_03')
    expect(comms.window?.startUtc).toBe('2028-03-12T12:00:00Z')
    expect(b.losT).toBe(met(406, 9, 20))
    expect(formatMet(b.losT!)).toBe('406/09:20:00')
    expect(b.resumeT).toBe(met(423, 20, 20))
    expect(formatMet(b.resumeT!)).toBe('423/20:20:00')
  })
  it('dates the earliest review as t + comms.earliest_reply_s: light time only, MET 423/20:59:49 (±1 s)', () => {
    expect(b.earliestReviewT).toBe(NOW + comms.earliest_reply_s!)
    expect(Math.abs(b.earliestReviewT! - met(423, 20, 59, 49))).toBeLessThanOrEqual(1)
    expect(formatMet(b.earliestReviewT!).startsWith('423/20:59:')).toBe(true)
    expect(b.earliestReviewLabel).toBe('light time only, before any review time')
    // the hero's "Earliest reply 11 d 06 h"
    expect(formatCountdown(comms.earliest_reply_s!)).toBe('11 d 06 h')
  })
  it('takes the round trip at resume from computeComms at resumes_at (no light-time arithmetic here)', () => {
    const atResume = commsAt('mars_surface', b.resumeT!)
    expect(atResume.blocked).toBe(false)
    expect(b.roundTripAtResumeS).toBe(atResume.round_trip_s)
    // the engine's earliest reply is the resume time plus that round trip
    expect(b.earliestReviewT! - b.resumeT!).toBeCloseTo(atResume.round_trip_s!, 6)
    // measured: about 1,195 s each way at resume
    expect(Math.abs(atResume.one_way_s! - 1195)).toBeLessThan(1)
  })
})

describe('the fitness sessions: CM-2’s VO2max tests', () => {
  it('reads the latest test from the FFD finding: 35.1 at MET 411/10:00, after loss of signal, against 36.5 [V1 4002] at Mars', () => {
    const r = row(MARS.board, 'vo2max:latest')
    expect(r.value).toBe(35.1)
    expect(r.met).toBe(met(411, 10))
    expect(r.side).toBe('after')
    expect(r.floor).toEqual({ value: 36.5, unit: 'ml/min/kg', requirementId: 'V1 4002' })
    expect(r.chip).toBe('NASA-published')
    const ffd = MARS.evaluation.crew['CM-2'].tierA.find((x) => x.rule.id === 'ffd_vo2max_surface_eva')!
    expect(r.finding).toBe(ffd.finding)
    expect(r.finding?.status).toBe('outside')
    expect(r.finding?.severity).toBe('caution')
  })
  it('computes its age at the earliest review: 12 d 10 h (measured; the brief said about 12 d 11 h)', () => {
    const r = row(MARS.board, 'vo2max:latest')
    expect(r.ageAtReview).toBe(MARS.board.earliestReviewT! - met(411, 10))
    expect(formatCountdown(r.ageAtReview!)).toBe('12 d 10 h')
    expect(r.ageAtReview! / 86_400).toBeGreaterThan(12 + 10 / 24)
    expect(r.ageAtReview! / 86_400).toBeLessThan(12 + 11 / 24)
    expect(r.ageNow).toBe(NOW - met(411, 10))
  })
  it('lists the earlier tests as values only, newest first: 35.7 and 36.4 came before loss of signal', () => {
    const fitness = MARS.board.groups.find((g) => g.id === 'fitness')!
    const earlier = fitness.rows.filter((r) => r.key !== 'vo2max:latest')
    expect(earlier.map((r) => r.value)).toEqual([35.7, 36.4, 37.2])
    expect(earlier.map((r) => formatMet(r.met!))).toEqual(['397/10:00:00', '383/10:00:00', '369/10:00:00'])
    expect(earlier.every((r) => r.side === 'before' && r.finding === null)).toBe(true)
  })
  it('compares the same reading with 32.9 [V1 4001] at the ISS, where the engine finds it within', () => {
    const r = row(ISS.board, 'vo2max:latest')
    expect(r.value).toBe(35.1)
    expect(r.floor).toEqual({ value: 32.9, unit: 'ml/min/kg', requirementId: 'V1 4001' })
    expect(r.finding?.status).toBe('within')
    expect(r.side).toBeNull()
  })
})

describe('recent medical evaluations: the open cases and the latest Noon Sight', () => {
  it('lists CM-2’s open shelter case with its status and opening MET, and the latest check-in', () => {
    const medical = MARS.board.groups.find((g) => g.id === 'medical')!
    const shelter = medical.rows.find((r) => r.key === 'case:spe_shelter')!
    expect(shelter.text).toBe('Open · detected')
    expect(formatMet(shelter.met!)).toBe('412/14:15:00')
    expect(shelter.side).toBe('after')
    const noon = medical.rows.find((r) => r.key === 'noon-sight')!
    expect(noon.missing).toBe(false)
    expect(noon.met).toBeLessThanOrEqual(NOW)
    const times = (INDEX.series.get(seriesKey('CM-2', 'mood')) ?? []).map((o) => o.t).filter((x) => x <= NOW)
    expect(noon.met).toBe(Math.max(...times))
    // the board carries check-in times only: no mood value ever reaches it
    expect(JSON.stringify(medical)).not.toMatch(/mood/i)
  })
})

describe('other metrics of health and performance: today’s Tier B verdicts, never recomputed', () => {
  it('reads every verdict from the evaluation, as it is', () => {
    const metrics = MARS.board.groups.find((g) => g.id === 'metrics')!
    expect(metrics.rows.map((r) => r.key)).toEqual(METRIC_INDICATORS.map((id) => `tierb:${id}`))
    const tierB = MARS.evaluation.crew['CM-2'].tierB
    for (const id of METRIC_INDICATORS) {
      const ev = tierB.find((e) => e.indicator.id === id)!
      const r = metrics.rows.find((x) => x.key === `tierb:${id}`)!
      expect(r.finding, id).toBe(ev.finding)
      expect(r.value, id).toBe(ev.current?.value ?? null)
      expect(r.met, id).toBe(ev.current?.t ?? null)
      expect(r.missing, id).toBe(ev.current === null)
    }
  })
  it('reads a removed BP series as missing, never within', () => {
    const series = new Map(INDEX.series)
    series.delete(seriesKey('CM-2', 'bp_systolic'))
    series.delete(seriesKey('CM-2', 'bp_diastolic'))
    const { board } = boardFor('mars_surface', 'CM-2', { ...INDEX, series })
    for (const id of ['bp_systolic', 'bp_diastolic']) {
      const r = row(board, `tierb:${id}`)
      expect(r.missing, id).toBe(true)
      expect(r.value, id).toBeNull()
      expect(r.finding?.status, id).not.toBe('within')
      expect(r.finding?.status, id).toBe('insufficient_data')
    }
    // with the series in place the same rows have a value
    expect(row(MARS.board, 'tierb:bp_systolic').missing).toBe(false)
  })
  it('keeps a stale value on screen with the engine’s stale verdict: stale is not missing', () => {
    const ev = MARS.evaluation
    const crew = ev.crew['CM-2']
    const tierB = crew.tierB.map((e) => (e.indicator.id === 'bp_systolic' ? { ...e, finding: { ...e.finding, status: 'stale' as const, severity: 'advisory' as const } } : e))
    const evaluation = { ...ev, crew: { ...ev.crew, 'CM-2': { ...crew, tierB } } }
    const comms = commsAt('mars_surface', NOW)
    const b = evaBoard({ crewId: 'CM-2', env: environment('mars_surface'), comms, evaluation, caseViews: [], observations: [], sources: SOURCES, t: NOW })
    const r = row(b, 'tierb:bp_systolic')
    expect(r.missing).toBe(false)
    expect(r.value).toBe(116)
    expect(r.finding?.status).toBe('stale')
  })
})

describe('the ground at the ISS is reachable within computeComms’ round trip', () => {
  it('reads reachable, with no loss of signal and the engine’s round trip', () => {
    const c = commsAt('iss', NOW)
    expect(ISS.board.ground).toBe('reachable')
    expect(groundOf(c)).toBe('reachable')
    expect(ISS.board.roundTripS).toBe(c.round_trip_s)
    expect(ISS.board.losT).toBeNull()
    expect(ISS.board.resumeT).toBeNull()
    expect(ISS.board.earliestReviewT).toBe(NOW + c.round_trip_s!)
    expect(ISS.board.groups.flatMap((g) => g.rows).every((r) => r.side === null)).toBe(true)
  })
  it('calls a link of a minute or more each way delayed (design choice), and a conjunction unreachable', () => {
    expect(groundOf({ blocked: false, link: 'AOS', one_way_s: 59.9 })).toBe('reachable')
    expect(groundOf({ blocked: false, link: 'AOS', one_way_s: 60 })).toBe('delayed')
    expect(groundOf({ blocked: true, link: 'LOS', one_way_s: 1191 })).toBe('unreachable')
    expect(groundOf({ blocked: false, link: 'LOS', one_way_s: null })).toBe('unreachable')
  })
})

describe('constraints and monitoring quote the frozen snapshots byte for byte', () => {
  it('quotes NOAA’s S3 Biological text at S3, with the Mars rule’s design-choice chip', () => {
    const s = MARS.board.constraints.sLevel
    expect(s.level).toBe(3)
    const S3 = (SSCALE.data as SScaleData).levels!.find((l) => l.level === 'S3')!
    expect(s.quote?.text).toBe(S3.effects!.Biological)
    expect(s.quote?.text).toBe('Radiation hazard avoidance recommended for astronauts on EVA; passengers and crew in high-flying aircraft at high latitudes may be exposed to radiation risk.')
    expect(s.atMars).toBe(true)
    expect(s.ruleChip).toBe('design choice')
    expect(s.finding?.severity).toBe('warning')
    // the reading: the OPS feed's latest ≥10 MeV proton flux at or before now, 1100 pfu at MET 412/14:20:00
    expect(s.flux).toBe(MARS.evaluation.ops.flux)
    expect(s.fluxT).toBe(MARS.evaluation.ops.t)
    expect(s.flux).toBe(1100)
    expect(s.fluxT).toBe(NOW)
    // ... the last sample of sim_crew's vehicle series up to now (start_t + (n - 1) * step_s), read raw
    const raw = (SIM.data as { vehicle: { series: Record<string, { start_t: number; step_s: number; n: number; v: Array<number | null> }> } }).vehicle.series.proton_flux_10mev
    expect(raw.start_t + (raw.n - 1) * raw.step_s).toBe(NOW)
    expect(raw.v[raw.n - 1]).toBe(1100)
    // the reading is the time-shifted October 1989 replay (the page says so only for a replay reading)
    expect(s.provenance).toBe('replay')
    expect(ISS.board.constraints.sLevel.ruleChip).toBe('NOAA-published')
  })
  it('quotes the shelter case’s step p1 (cases.json) and the RAD team’s 30-minute sentence (literature quote shelter_30_min)', () => {
    const p1 = (RULES.cases!.cases as Array<{ id: string; procedure: Array<{ id: string; text: string }> }>).find((c) => c.id === 'spe_shelter')!.procedure.find((p) => p.id === 'p1')!.text
    expect(MARS.board.constraints.shelter?.p1).toBe(p1)
    expect(MARS.board.constraints.shelter?.title).toBe('Solar particle event: shelter')
    expect(p1).toBe('Stop or postpone any EVA. If crew are outside, start ingress per the EVA plan.')
    const lit = (SEP.data as SepEventsData).literature!
    const q = lit.quotes!.find((x) => x.id === 'shelter_30_min')!.text
    expect(MARS.board.constraints.rad?.text).toBe(q)
    expect(q.startsWith('Our study suggests that, using our nowcasting system, an astronaut should not move more than 30 minutes away from a shelter')).toBe(true)
    // the RAD figure is for Gale crater: not shown at the ISS
    expect(ISS.board.constraints.rad).toBeNull()
  })
  it('quotes [V2 11037] and [V2 11038] verbatim, with the one-way light time now', () => {
    const v2 = VOL2.data as StdData
    expect(MARS.board.monitoring.requirements.map((q) => q.id)).toEqual(['V2 11037', 'V2 11038'])
    for (const q of MARS.board.monitoring.requirements) {
      const raw = findRequirement(v2, q.id)!
      expect(q.text).toBe(raw.text)
      expect(q.rationale).toBe(raw.rationale)
      expect(q.page).toBe(raw.printed_page)
      expect(q.section).toBe(raw.section)
    }
    // the locators the page prints: Vol 2 §11.4.1 and §11.4.2, both on p. 241
    expect(MARS.board.monitoring.requirements.map((q) => q.page)).toEqual([241, 241])
    expect(MARS.board.monitoring.requirements.map((q) => q.section)).toEqual(['11.4.1', '11.4.2'])
    expect(MARS.board.monitoring.requirements[0].rationale!.startsWith('Real-time monitoring during EVA is a current medical requirement')).toBe(true)
    expect(MARS.board.monitoring.oneWayS).toBe(commsAt('mars_surface', NOW).one_way_s)
    expect(MARS.board.monitoring.blocked).toBe(true)
  })
})

describe('the options are the program’s; their numbers are computed', () => {
  it('postpone: until the earliest review; before loss of signal: evidence at least 17 d 11 h old by the next review', () => {
    const [postpone, before, delegate] = MARS.board.options
    expect(postpone.id).toBe('postpone')
    expect(postpone.earliestReviewT).toBe(MARS.board.earliestReviewT)
    expect(before.id).toBe('before_los')
    expect(before.staleAtNextReviewS).toBe(MARS.board.earliestReviewT! - MARS.board.losT!)
    expect(formatCountdown(before.staleAtNextReviewS!)).toBe('17 d 11 h')
    expect(delegate.id).toBe('delegate')
    expect(ISS.board.options.find((o) => o.id === 'before_los')?.staleAtNextReviewS).toBeNull()
  })
})

// ---- the rendered page ---------------------------------------------------------------------------------

const SNAPS: EvaSnapshots = {
  vol1: ready(VOL1),
  vol2: ready(VOL2),
  sScale: ready(SSCALE),
  sep: ready(SEP),
}
const html = (b: EvaBoard, envId: EnvId) => renderToStaticMarkup(createElement(EvaView, { board: b, env: environment(envId), comms: commsAt(envId, NOW), snapshots: SNAPS }))
/** Visible text of an HTML fragment (tags dropped, entities decoded for the few React writes). */
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
/** The same with inline tags dropped in place, for whole sentences that run across <span>s. */
const inline = (h: string) => text(h.replace(/<\/?(span|strong|q|time|data|a|cite)\b[^>]*>/g, ''))

describe('the page', () => {
  const marsHtml = html(MARS.board, 'mars_surface')
  const issHtml = html(ISS.board, 'iss')
  const quoteBlock = (h: string) => /<figure class="lf-eva-req" data-eva-v16006="">[\s\S]*?<\/figure>/.exec(h)?.[0] ?? ''
  it('shows the verbatim [V1 6006] quote, the earliest review, the 35.1 row after loss of signal and the fixed sentence', () => {
    expect(text(quoteBlock(marsHtml))).toContain('by ground medical support personnel prior to each EVA')
    const review = /data-eva-earliest-review="">([\s\S]*?)<\/div>/.exec(marsHtml)?.[1] ?? ''
    expect(text(review)).toContain('MET 423/20:59')
    const vo2 = /<tr data-eva-row="vo2max:latest"[\s\S]*?<\/tr>/.exec(marsHtml)?.[0] ?? ''
    expect(text(vo2)).toContain('35.1')
    expect(text(vo2)).toContain('After loss of signal')
    expect(text(vo2)).toContain('12 d 10 h')
    expect(text(marsHtml)).toContain(NEVER_CLEARS)
    expect(marsHtml).toContain('SIMULATED CREW DATA')
  })
  it('prints the S3, p1 and RAD sentences exactly as frozen', () => {
    const t = text(marsHtml)
    expect(t).toContain(MARS.board.constraints.sLevel.quote!.text)
    expect(t).toContain(MARS.board.constraints.shelter!.p1!)
    expect(t).toContain(MARS.board.constraints.rad!.text)
    expect(t).toContain('The RAD team’s figure for its own nowcast at Gale')
    expect(inline(marsHtml)).toContain('The ground sees each suit reading at least one-way light time late (19 min 51 s now); during the conjunction, not at all.')
    expect(t).toContain('17 d 11 h')
    // the reading and the locators, as printed
    expect(inline(marsHtml)).toContain('Space weather now: S3, ≥10 MeV proton flux 1100 pfu at MET 412/14:20:00 (Mars-orbit monitor, relayed')
    const req = (id: string) => inline(new RegExp(`data-eva-req="${id}">([\\s\\S]*?)</div>`).exec(marsHtml)?.[1] ?? '')
    expect(req('V2 11037')).toContain('[V2 11037] EVA Suited Metabolic Rate Measurement · Vol 2 §11.4.1, p. 241')
    expect(req('V2 11038')).toContain('[V2 11038] EVA Suited Metabolic Data Display · Vol 2 §11.4.2, p. 241')
    expect(text(quoteBlock(marsHtml))).toContain('[V1 6006] NASA-STD-3001 Vol 1 Rev C §6.4 Extravehicular Activities (EVAs), p. 52')
    // the round trip now (the hero's figure, the same formatter) and the one the engine adds when the link resumes
    const rt = /data-eva-round-trip-los="">([\s\S]*?)<\/div>/.exec(marsHtml)?.[1] ?? ''
    expect(inline(rt)).toContain(`${formatCommsLightTime(commsAt('mars_surface', NOW), true)} now; ${formatLightTime(MARS.board.roundTripAtResumeS!)} when the link resumes`)
    expect(inline(rt)).toContain('39 min 41 s now; 39 min 50 s when the link resumes')
  })
  it('at the ISS reads "Ground reachable within the round trip" with computeComms’ round trip', () => {
    const t = text(issHtml)
    const rt = commsAt('iss', NOW).round_trip_s!
    const printed = /data-eva-round-trip="">([^<]*)</.exec(issHtml)?.[1] ?? ''
    expect(t).toContain('Ground reachable within the round trip')
    expect(Number(printed.replace(/[^\d.]/g, ''))).toBe(rt)
    expect(t).toContain(NEVER_CLEARS)
  })
  it('prints the postpone wait as the Now page’s “Earliest reply”: days behind the Sun, the round trip while the link is up, never “0 min”', () => {
    const postpone = (h: string) => inline(/<li data-eva-option="postpone">([\s\S]*?)<\/li>/.exec(h)?.[1] ?? '')
    expect(postpone(marsHtml)).toContain('The earliest is MET 423/20:59:49, 11 d 06 h from now (light time only, before any review time).')
    expect(postpone(issHtml)).toContain('The earliest is MET 412/14:20:02, ≤2.00 s from now (light time only, before any review time).')
    // the ground line's round trip and the hero's "Earliest reply" (formatEarliestReply) print the same
    expect(formatEarliestReply(commsAt('iss', NOW))).toBe('≤2.00 s')
    expect(/data-eva-round-trip="">([^<]*)</.exec(issHtml)?.[1]).toBe('≤2.00 s')
    const pages: string[] = [marsHtml, issHtml]
    for (const [envId, wait] of [
      ['lunar_surface', '2.65 s'],
      ['cislunar', '≤3.00 s'],
    ] as const) {
      const h = html(boardFor(envId).board, envId)
      pages.push(h)
      expect(formatEarliestReply(commsAt(envId, NOW)), envId).toBe(wait)
      expect(postpone(h), envId).toContain(`, ${wait} from now (light time only, before any review time).`)
    }
    for (const h of pages) expect(inline(h)).not.toContain('0 min from now')
  })
  it('never says cleared, go or no-go outside the [V1 6006] quote (visible text and tooltips)', () => {
    for (const h of [marsHtml, issHtml]) {
      expect(quoteBlock(h)).not.toBe('')
      const rest = h.replace(quoteBlock(h), ' ')
      const attrs = [...rest.matchAll(/\s(?:title|aria-label)="([^"]*)"/g)].map((m) => m[1]).join(' ')
      expect(attrs.length).toBeGreaterThan(100) // the chips' and markers' tooltips are there to check
      for (const words of [text(rest), attrs]) {
        expect(words).not.toMatch(/cleared for|go for EVA|no-go|clear(ed)? to EVA/i)
        expect(words).not.toMatch(/\bcleared\b/i)
        expect(words).not.toMatch(/\bgo\b/i)
        expect(words).not.toMatch(/or their designees/i)
      }
    }
  })
})

describe('without the ephemeris, nothing is guessed', () => {
  const build = (status: 'missing' | 'loading') => {
    const comms = computeComms(environment('mars_surface'), NOW, { status, snapshot: null }, { status: 'ready', snapshot: SIM })
    const evaluation = MARS.evaluation
    const board = evaBoard({ crewId: 'CM-2', env: environment('mars_surface'), comms, evaluation, caseViews: [], observations: [], sources: SOURCES, t: NOW })
    return { comms, board, h: inline(renderToStaticMarkup(createElement(EvaView, { board, env: environment('mars_surface'), comms, snapshots: SNAPS }))) }
  }
  it('a missing ephemeris: the link is still down (SPEC 3.1), times unknown, shown missing; never "the link is up"', () => {
    const { comms, board, h } = build('missing')
    expect(comms.basis).toBe('fallback')
    expect(board.ground).toBe('unreachable')
    expect(board.losT).toBeNull()
    expect(board.earliestReviewT).toBeNull()
    expect(h).toContain('No ground link')
    expect(h).toContain('Loss of signal time unknown')
    expect(h).not.toContain('the link is up')
    expect(h).not.toMatch(/MET 423\//)
  })
  it('a loading ephemeris reads as loading, not missing', () => {
    const { h } = build('loading')
    expect(h).toContain('Reading the light time and the conjunction window from the frozen ephemeris.')
  })
})

describe('the body map links here from the VO2max card', () => {
  const panel = Object.values(import.meta.glob<string>('../body/RegionPanel.tsx', { query: '?raw', import: 'default', eager: true }))[0]
  it('adds one inline link, for the crewmember shown, at the end of the [V1 6006] fitness sentence', () => {
    const link = "<Link to={'/eva?crew=' + crewId}>EVA in a blackout: what NASA requires →</Link>"
    expect(panel.split(link).length - 1).toBe(1)
    expect(panel.replace(/\s+/g, ' ')).toContain(`decision before each EVA ( <ReqId id="V1 6006" /> ). ${link}`)
  })
})
