import { describe, expect, it } from 'vitest'
import { ENGINE_IS_SHIM, expectedFalseAlarms, formatMet, sLevel } from './engine'
import { NAV_ROUTES, ROUTES, matchRoute, hrefFor } from './routes'
import { freshnessOf, parseIsoDuration } from './data'
import type { SnapshotMeta } from './data'
import { MET_NOW_S, ENVIRONMENTS, environment } from './scenario'
import {
  caseClockOf,
  initialMissionState,
  isShared,
  missionReducer,
  selectAlerts,
  selectAnnunciator,
  defaultConsent,
} from './mission'
import { computeComms, formatCommsLightTime, formatCountdown, formatLightTime } from './comms'
import type { Snapshot } from './data'
import type { CaseEventRecord } from './caseTimeline'
import { escalationTiers, packetDelivery, packetStateLabel } from './packet'
import type { PacketState } from './packet'

describe('formatMet (SPEC 5; Vol 2 Appendix F F.6.1 f: no leading zeros in the day field)', () => {
  it('formats the scenario now', () => {
    expect(MET_NOW_S).toBe(35_648_400)
    expect(formatMet(MET_NOW_S)).toBe('412/14:20:00')
    expect(formatMet(MET_NOW_S + 7)).toBe('412/14:20:07')
  })
  it('suppresses day-field zeros, keeps two digits for h:m:s, and floors', () => {
    expect(formatMet(0)).toBe('0/00:00:00')
    expect(formatMet(86_399.9)).toBe('0/23:59:59')
    expect(formatMet(86_400)).toBe('1/00:00:00')
    // the same format serves day-count durations (a countdown)
    expect(formatMet(11 * 86_400 + 5 * 3600 + 59 * 60 + 51)).toBe('11/05:59:51')
  })
  it('rejects non-finite input', () => {
    expect(() => formatMet(Number.NaN)).toThrow()
  })
})

describe('sLevel (SPEC 5, NOAA thresholds inclusive)', () => {
  it.each([
    [0, 0],
    [9.99, 0],
    [10, 1],
    [99.9, 1],
    [100, 2],
    [1e3, 3],
    [9999, 3],
    [1e4, 4],
    [1e5, 5],
    [4e5, 5],
  ])('flux %s pfu -> S%s', (flux, level) => {
    expect(sLevel(flux)).toBe(level)
  })
})

describe('expectedFalseAlarms', () => {
  it('is k * days * alpha (real engine, positional call shape)', () => {
    expect(ENGINE_IS_SHIM).toBe(false)
    const r = expectedFalseAlarms(10, 30)
    expect(r.expected).toBeCloseTo(0.3, 12)
    expect(r.every_n_days).toBeCloseTo(100, 9)
  })
})

describe('matchRoute', () => {
  it('matches every route', () => {
    expect(matchRoute('').route?.id).toBe('now')
    expect(matchRoute('#/').route?.id).toBe('now')
    expect(matchRoute('#/body').route?.id).toBe('body')
    expect(matchRoute('#/noon-sight').route?.feature).toBe('noon-sight')
    expect(matchRoute('#/data/').route?.id).toBe('data')
  })
  it('extracts params and query', () => {
    const m = matchRoute('#/case/spe_shelter?step=2')
    expect(m.route?.feature).toBe('cases')
    expect(m.params).toEqual({ id: 'spe_shelter' })
    expect(m.query).toEqual({ step: '2' })
    expect(matchRoute('#/case').params).toEqual({})
  })
  it('returns null for unknown routes', () => {
    expect(matchRoute('#/nope').route).toBeNull()
    expect(matchRoute('#/case/a/b').route).toBeNull()
  })
  it('aliases #/cases to the case views (the natural URL is never a not-found page)', () => {
    expect(matchRoute('#/cases').route?.id).toBe('case')
    expect(matchRoute('#/cases').params).toEqual({})
    const m = matchRoute('#/cases/renal_stone?crew=CM-3')
    expect(m.route?.feature).toBe('cases')
    expect(m.params).toEqual({ id: 'renal_stone' })
    expect(m.query).toEqual({ crew: 'CM-3' })
    expect(m.path).toBe('/case/renal_stone')
  })
  it('builds hrefs', () => {
    expect(hrefFor('/case/renal_stone')).toBe('#/case/renal_stone')
    expect(hrefFor('trends')).toBe('#/trends')
  })
  it('opens the printable cue cards: #/card/<case_id> one card, #/card and #/cards all of them', () => {
    const one = matchRoute('#/card/spe_shelter')
    expect(one.route?.id).toBe('card')
    expect(one.route?.feature).toBe('cuecard')
    expect(one.params).toEqual({ id: 'spe_shelter' })
    expect(one.path).toBe('/card/spe_shelter')
    const all = matchRoute('#/cards')
    expect(all.route?.id).toBe('card')
    expect(all.params).toEqual({})
    expect(all.path).toBe('/card')
    expect(matchRoute('#/card').params).toEqual({})
    expect(matchRoute('#/cards/renal_stone').params).toEqual({ id: 'renal_stone' })
    expect(matchRoute('#/card/spe_shelter?basis=inline').query).toEqual({ basis: 'inline' })
    expect(matchRoute('#/card/a/b').route).toBeNull()
  })
  it('keeps the cue cards out of the nav: still the same 11 nav items', () => {
    expect(ROUTES.find((r) => r.id === 'card')?.nav).toBe(false)
    expect(matchRoute('#/eva?crew=CM-2').route?.id).toBe('eva')
    expect(NAV_ROUTES.map((r) => r.id)).toEqual(['now', 'body', 'case', 'radiation', 'noon-sight', 'trends', 'downlink', 'band', 'provenance', 'method', 'data'])
    expect(NAV_ROUTES).toHaveLength(11)
  })
})

describe('freshness ([V2 10020])', () => {
  const meta = (kind: SnapshotMeta['freshness']['kind'], stale_after: string | null, stop: string | null = null): SnapshotMeta => ({
    id: 'x',
    retrieved_at: '2026-11-14T13:00:00Z',
    freshness: { kind, stale_after },
    coverage: { start: null, stop, cadence: null },
  })
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT15M')).toBe(900)
    expect(parseIsoDuration('PT6H')).toBe(21_600)
    expect(parseIsoDuration('P1DT1H')).toBe(90_000)
    expect(parseIsoDuration('P2W')).toBe(1_209_600)
    expect(parseIsoDuration('P')).toBeNaN()
    expect(parseIsoDuration('garbage')).toBeNaN()
  })
  it('reports a live feed as stale weeks later', () => {
    const f = freshnessOf(meta('live', 'PT15M'), 'ready', new Date('2026-12-01T00:00:00Z'))
    expect(f.state).toBe('stale')
    expect(f.label).toBe('STALE')
  })
  it('keeps historical data frozen, not stale', () => {
    const f = freshnessOf(meta('historical', null), 'ready', new Date('2027-06-01T00:00:00Z'))
    expect(f.state).toBe('frozen')
    expect(f.label).toBe('HISTORICAL')
  })
  it('expires predictions after their window', () => {
    const f = freshnessOf(meta('prediction', null, '2026-11-16T12:59:00Z'), 'ready', new Date('2026-11-20T00:00:00Z'))
    expect(f.state).toBe('stale')
  })
  it('maps load states', () => {
    expect(freshnessOf(null, 'missing').state).toBe('missing')
    expect(freshnessOf(null, 'error').state).toBe('unknown')
    expect(freshnessOf(null, 'loading').state).toBe('loading')
  })
})

describe('mission store', () => {
  it('defaults: Mars surface, CM-1, mood private', () => {
    const s = initialMissionState()
    expect(s.envId).toBe('mars_surface')
    expect(s.crewId).toBe('CM-1')
    expect(s.consent['CM-4'].mood).toBe(false)
    expect(isShared(defaultConsent(), 'mood')).toBe(false)
    expect(isShared(defaultConsent(), 'urine_volume_24h')).toBe(true)
    expect(isShared({}, 'mood')).toBe(false)
  })
  it('counts published alerts, dedupes by id, tracks acknowledgement', () => {
    let s = initialMissionState()
    expect(selectAnnunciator(s).evaluated).toBe(false)
    s = missionReducer(s, {
      type: 'publishAlerts',
      source: 'now',
      alerts: [
        { id: 'ALL:spe', severity: 'warning', title: 'S3' },
        { id: 'CM-1:pvt', severity: 'caution', title: 'PVT' },
        { id: 'CM-2:ok', severity: 'nominal', title: 'fine' },
      ],
    })
    s = missionReducer(s, { type: 'publishAlerts', source: 'cases', alerts: [{ id: 'CM-1:pvt', severity: 'caution', title: 'PVT' }] })
    const c = selectAnnunciator(s)
    expect(c).toMatchObject({ emergency: 0, warning: 1, caution: 1, advisory: 0, unacknowledged: 2, evaluated: true })
    expect(selectAlerts(s).map((a) => a.id)).toEqual(['ALL:spe', 'CM-1:pvt'])
    s = missionReducer(s, { type: 'acknowledge', ids: ['ALL:spe'], t: MET_NOW_S })
    expect(selectAnnunciator(s).unacknowledged).toBe(1)
  })
  it('adds the manually measured vitals (D8) to the shareable variables, shared by default', () => {
    const c = defaultConsent()
    for (const v of ['bp_systolic', 'bp_diastolic', 'glucose']) expect(c[v]).toBe(true)
  })
  it('adds Noon Sight observations to the observation list', () => {
    const s = missionReducer(initialMissionState(), {
      type: 'addNoonSight',
      result: {
        id: 'n1',
        crew_id: 'CM-1',
        t: MET_NOW_S,
        observations: [{ crew_id: 'CM-1', variable: 'pvt_lapses', value: 3, unit: 'count', t: MET_NOW_S, source: 'app', provenance: 'manual' }],
      },
    })
    expect(s.noonSights).toHaveLength(1)
    expect(s.observations).toHaveLength(1)
  })
})

describe('environments and comms fallback', () => {
  it('has the four SPEC environments', () => {
    expect(ENVIRONMENTS.map((e) => e.id)).toEqual(['iss', 'cislunar', 'lunar_surface', 'mars_surface'])
  })
  it('ISS is AOS with sub-second light time', () => {
    const c = computeComms(environment('iss'), MET_NOW_S, null)
    expect(c.link).toBe('AOS')
    expect(c.basis).toBe('static')
    expect(formatLightTime(c.one_way_s)).toBe('≤1 s')
  })
  it('Mars without the ephemeris snapshot: LOS by scenario, light time unknown, source missing', () => {
    const c = computeComms(environment('mars_surface'), MET_NOW_S, { status: 'missing', snapshot: null })
    expect(c.link).toBe('LOS')
    expect(c.reason).toBe('solar_conjunction')
    expect(c.one_way_s).toBeNull()
    expect(c.basis).toBe('fallback')
    expect(c.snapshotStatus).toBe('missing')
    expect(formatLightTime(null)).toBe('—')
  })
})

describe('comms from the real frozen snapshots (when present in the build)', () => {
  const snaps = import.meta.glob<Snapshot>('../../public/data/{horizons_mars_comms,sim_crew}.json', { eager: true, import: 'default' })
  const ephem = Object.entries(snaps).find(([k]) => k.endsWith('horizons_mars_comms.json'))?.[1]
  const sim = Object.entries(snaps).find(([k]) => k.endsWith('sim_crew.json'))?.[1]
  it.skipIf(!ephem || !sim)('MET 412/14:20:00 on Mars is inside the modelled 2028-03 conjunction window, link back in 11 d 06 h', () => {
    const c = computeComms(environment('mars_surface'), MET_NOW_S, { status: 'ready', snapshot: ephem! }, { status: 'ready', snapshot: sim! })
    expect(c.basis).toBe('snapshot')
    expect(c.link).toBe('LOS')
    expect(c.reason).toBe('solar_conjunction')
    expect(c.window?.startUtc).toBe('2028-03-12T12:00:00Z')
    expect(c.window?.stopUtc).toBe('2028-03-29T23:00:00Z')
    expect(c.one_way_s).toBeGreaterThan(1000)
    expect(c.one_way_s).toBeLessThan(1260)
    expect(formatCountdown(c.window!.stop - MET_NOW_S)).toBe('11 d 06 h')
    expect(c.resumes_at).toBe(c.window!.stop)
  })
  it.skipIf(!ephem || !sim)('one link-resume clock: the words count from the case clock, like the tier-2 and packet strings, also after a crew action', () => {
    const c = computeComms(environment('mars_surface'), MET_NOW_S, { status: 'ready', snapshot: ephem! }, { status: 'ready', snapshot: sim! })
    const at = c.resumes_at!
    const words = (t: number) => formatCountdown(at - t) // DualCounter ResumeWords and the mission bar, at the case clock
    const queued: PacketState = { id: 'queued', label: packetStateLabel('queued'), when: null, queuedAt: MET_NOW_S, reason: 'released' }
    const agree = (t: number) => {
      expect(escalationTiers(c, t)[1].when).toContain(`queued until the link resumes in ${words(t)}`)
      expect(packetDelivery(queued, c, t)).toBe(`Sent when the link resumes, in ${words(t)}`)
    }
    // the live second clock alone printed the other value during the minute (the R3 #5 disagreement)
    expect(formatCountdown(at - (MET_NOW_S + 8))).toBe('11 d 05 h')
    // no crew action: the case clock is the minute, so every phrase reads 11 d 06 h for all of MET 412/14:20
    for (const s of [0, 8, 30, 59]) {
      const t = caseClockOf(MET_NOW_S, [], MET_NOW_S + s)
      expect(t).toBe(MET_NOW_S)
      expect(words(t)).toBe('11 d 06 h')
      agree(t)
    }
    // a crew action at 412/14:20:20: the case views (so tier 2 and the packet line) are folded at it, and so are the
    // words; flooring the live clock to the minute instead would print 11 d 06 h beside their 11 d 05 h
    const act: CaseEventRecord[] = [{ key: 'CM-1:spe_shelter', origin: 'user', seq: 0, event: { type: 'SELECT', t: MET_NOW_S + 20, countermeasure_id: 'cm_shelter' } }]
    const t = caseClockOf(MET_NOW_S, act, MET_NOW_S + 30)
    expect(t).toBe(MET_NOW_S + 20)
    expect(words(t)).toBe('11 d 05 h')
    expect(formatCountdown(at - MET_NOW_S)).toBe('11 d 06 h')
    agree(t)
    // from the next minute, the minute again
    const next = caseClockOf(MET_NOW_S + 60, act, MET_NOW_S + 61)
    expect(next).toBe(MET_NOW_S + 60)
    expect(words(next)).toBe('11 d 05 h')
    agree(next)
  })
  it('caseClockOf: the minute, or the latest user event up to the clock when later (never one after the clock)', () => {
    const ev = (t: number): CaseEventRecord => ({ key: 'CM-1:sleep_circadian', origin: 'user', seq: 0, event: { type: 'OUTCOME', t, text: 'x' } })
    expect(caseClockOf(600, [], 630)).toBe(600)
    expect(caseClockOf(600, [ev(590)], 630)).toBe(600)
    expect(caseClockOf(600, [ev(620), ev(615)], 630)).toBe(620)
    expect(caseClockOf(600, [ev(640)], 630)).toBe(600)
    expect(caseClockOf(600, [ev(630)], 630)).toBe(630)
  })
  it('formats static envelopes honestly', () => {
    expect(formatCommsLightTime({ one_way_s: 1.5, range: { min: 0, max: 1.5 } })).toBe('≤1.50 s')
    expect(formatCommsLightTime({ one_way_s: 1.282, range: { min: 1.212, mean: 1.282, max: 1.353 } })).toBe('1.28 s')
    expect(formatLightTime(1203.6)).toBe('20 min 04 s')
  })
})
