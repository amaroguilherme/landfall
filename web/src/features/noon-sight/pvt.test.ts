import { describe, expect, it } from 'vitest'
import { PVT_B, drawIsiMs, scorePvt } from './pvt'
import type { PvtEvent } from './pvt'

const rts = (...ms: number[]): PvtEvent[] => ms.map((rt_ms) => ({ kind: 'response', rt_ms }))

describe('PVT-B protocol constants (Basner, Mollicone & Dinges 2011)', () => {
  it('match the paper', () => {
    expect(PVT_B.durationMs).toBe(180_000)
    expect([PVT_B.isiMinMs, PVT_B.isiMaxMs]).toEqual([1_000, 4_000])
    expect(PVT_B.feedbackMs).toBe(1_000)
    expect(PVT_B.timeoutMs).toBe(30_000)
    expect(PVT_B.minValidRtMs).toBe(100)
    expect(PVT_B.lapseMs).toBe(355)
    expect(PVT_B.standardLapseMs).toBe(500)
  })
})

describe('scorePvt', () => {
  it('scores an alert run with no lapses', () => {
    const s = scorePvt(rts(250, 260, 270, 280))
    expect(s.stimuli).toBe(4)
    expect(s.valid).toBe(4)
    expect(s.lapses).toBe(0)
    expect(s.lapses500).toBe(0)
    expect(s.falseStarts).toBe(0)
    expect(s.medianRt).toBe(265)
    const speed = (1000 / 250 + 1000 / 260 + 1000 / 270 + 1000 / 280) / 4
    expect(s.meanSpeed).toBeCloseTo(speed, 12)
    expect(s.performanceScore).toBe(100)
  })

  it('treats 355 ms and 500 ms as inclusive lapse thresholds', () => {
    const s = scorePvt(rts(354, 355, 499, 500))
    expect(s.lapses).toBe(3) // 355, 499, 500
    expect(s.lapses500).toBe(1) // 500
    expect(s.medianRt).toBe(427) // (355 + 499) / 2
  })

  it('counts responses under 100 ms and presses without a stimulus as false starts', () => {
    const events: PvtEvent[] = [...rts(99, 100, 300), { kind: 'no_stimulus' }, { kind: 'no_stimulus' }]
    const s = scorePvt(events)
    expect(s.falseStarts).toBe(3) // 99 ms + two presses with no stimulus
    expect(s.stimuli).toBe(3)
    expect(s.valid).toBe(2) // 100 ms is valid (>= 100)
    expect(s.medianRt).toBe(200)
    expect(s.meanSpeed).toBeCloseTo((10 + 1000 / 300) / 2, 12)
  })

  it('scores a timeout as a lapse with a 30 s reaction time', () => {
    const s = scorePvt([...rts(240, 260), { kind: 'timeout' }])
    expect(s.timeouts).toBe(1)
    expect(s.lapses).toBe(1)
    expect(s.lapses500).toBe(1)
    expect(s.valid).toBe(3)
    expect(s.medianRt).toBe(260)
    expect(s.meanSpeed).toBeCloseTo((1000 / 240 + 1000 / 260 + 1 / 30) / 3, 12)
  })

  it('computes the performance score with the 355 ms lapse (Basner 2011 §2.3)', () => {
    // 8 valid stimuli, 2 of them lapses (>= 355 ms), plus 2 false starts:
    // 100 x (1 - (2 + 2) / (8 + 2)) = 60
    const events: PvtEvent[] = [...rts(250, 260, 270, 280, 290, 300, 360, 600), { kind: 'no_stimulus' }, ...rts(50)]
    const s = scorePvt(events)
    expect(s.valid).toBe(8)
    expect(s.lapses).toBe(2)
    expect(s.falseStarts).toBe(2)
    expect(s.performanceScore).toBeCloseTo(60, 12)
  })

  it('takes the middle value for an odd count and ignores input order', () => {
    expect(scorePvt(rts(400, 210, 330)).medianRt).toBe(330)
  })

  it('returns nulls, not zeros, when there is nothing to score', () => {
    const s = scorePvt([])
    expect(s).toMatchObject({ stimuli: 0, valid: 0, lapses: 0, falseStarts: 0, medianRt: null, meanSpeed: null, performanceScore: null })
    const onlyFalse = scorePvt([{ kind: 'no_stimulus' }])
    expect(onlyFalse.medianRt).toBeNull()
    expect(onlyFalse.performanceScore).toBe(0)
  })

  it('rejects impossible reaction times', () => {
    expect(() => scorePvt(rts(-1))).toThrow(RangeError)
    expect(() => scorePvt(rts(Number.NaN))).toThrow(RangeError)
  })

  it('honours overridden thresholds', () => {
    expect(scorePvt(rts(400, 450), { lapseMs: 500 }).lapses).toBe(0)
  })
})

describe('drawIsiMs', () => {
  it('maps [0, 1) onto the 1-4 s interval', () => {
    expect(drawIsiMs(() => 0)).toBe(1000)
    expect(drawIsiMs(() => 0.5)).toBe(2500)
    expect(drawIsiMs(() => 0.9999)).toBeLessThan(4000)
    expect(drawIsiMs(() => 1)).toBeLessThan(4000)
    expect(drawIsiMs(() => -3)).toBe(1000)
  })
})
