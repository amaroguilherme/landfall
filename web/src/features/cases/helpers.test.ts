// The ground-packet delivery sentence (helpers.ts deliveryText) on the REAL comms snapshots: a Prepared packet is held
// on board until the crew releases it or the case escalates, so its sentence never says it "goes out now"; the queued
// sentence (and every caller that passes no packet state) is the one it always was, byte for byte.
import { describe, expect, it } from 'vitest'
import { computeComms, formatCountdown, formatEarliestReply } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import type { Snapshot } from '../../app/data'
import { buildScenarioIndex } from '../../app/scenarioData'
import type { SimCrewData, SpeReplayData } from '../../app/scenarioData'
import { environment } from '../../app/scenario'
import { deliveryText, rationaleSentence } from './helpers'
import { findRequirement } from './model'
import type { StdData } from './model'

const snaps = import.meta.glob<Snapshot>('../../../public/data/{sim_crew,swpc_spe_replay,horizons_mars_comms,std_vol1_requirements}.json', {
  eager: true,
  import: 'default',
})
const snap = (id: string) => Object.entries(snaps).find(([k]) => k.endsWith(`/${id}.json`))?.[1]
const SIM = snap('sim_crew')!
const INDEX = buildScenarioIndex(SIM.data as SimCrewData, snap('swpc_spe_replay')!.data as SpeReplayData)
const NOW = INDEX.nowMet

const MARS = computeComms(environment('mars_surface'), NOW, { status: 'ready', snapshot: snap('horizons_mars_comms')! }, { status: 'ready', snapshot: SIM })
const ISS = computeComms(environment('iss'), NOW, null)
/** A loss of signal that is not a conjunction, with no known resume time (the other branches of the sentence). */
const LOS_UNKNOWN: CommsStatus = { ...MARS, reason: null, resumes_at: null }

/** deliveryText as it was before the packet state was passed (a verbatim copy): the queued sentence must not move. */
function before(comms: CommsStatus, t: number, subject = 'the ground packet'): string {
  if (comms.blocked) {
    const when = comms.resumes_at !== null ? `, in ${formatCountdown(comms.resumes_at - t)}` : ''
    const why = comms.reason === 'solar_conjunction' ? 'solar conjunction; the window is modelled from JPL Horizons geometry' : 'loss of signal'
    return `No link now (${why}): ${subject} goes out when the link resumes${when}, and the earliest reply is ${formatEarliestReply(comms)} away.`
  }
  return `Link up: ${subject} goes out now, and the ground has it within the round-trip light time (${formatEarliestReply(comms)}).`
}

describe('deliveryText', () => {
  it('reads the snapshots as expected: Mars is in solar conjunction at now, ISS has the link', () => {
    expect(MARS.blocked).toBe(true)
    expect(MARS.reason).toBe('solar_conjunction')
    expect(MARS.resumes_at).not.toBeNull()
    expect(ISS.blocked).toBe(false)
  })

  it('a Prepared packet at AOS is held on board, never "goes out now"', () => {
    const s = deliveryText(ISS, NOW, 'the ground packet', 'prepared')
    expect(s).toContain('held on board')
    expect(s).not.toContain('goes out now')
    expect(s).toBe(
      `Link up: the ground packet is held on board until the crew releases it or the case escalates; then it goes out at once, and the ground has it within the round-trip light time (${formatEarliestReply(ISS)}).`,
    )
  })

  it('a Prepared packet with no link is held on board, then goes out when the link resumes, with the countdown', () => {
    const s = deliveryText(MARS, NOW, 'the ground packet', 'prepared')
    const countdown = formatCountdown(MARS.resumes_at! - NOW)
    expect(countdown).toMatch(/^11 d 0\d h$/)
    expect(s).toBe(
      `No link now (solar conjunction; the window is modelled from JPL Horizons geometry): the ground packet is held on board until the crew releases it or the case escalates; then it goes out when the link resumes, in ${countdown}, and the earliest reply is ${formatEarliestReply(MARS)} away.`,
    )
    expect(deliveryText(LOS_UNKNOWN, NOW, 'it', 'prepared')).toBe(
      `No link now (loss of signal): it is held on board until the crew releases it or the case escalates; then it goes out when the link resumes, and the earliest reply is ${formatEarliestReply(LOS_UNKNOWN)} away.`,
    )
  })

  it("keeps the queued sentence, and the sentence with no packet state, byte-identical to today's", () => {
    for (const comms of [MARS, ISS, LOS_UNKNOWN]) {
      for (const subject of [undefined, 'it']) {
        expect(deliveryText(comms, NOW, subject)).toBe(before(comms, NOW, subject))
        expect(deliveryText(comms, NOW, subject, 'queued')).toBe(before(comms, NOW, subject))
        expect(deliveryText(comms, NOW, subject, 'queued')).not.toContain('held on board')
      }
    }
    expect(deliveryText(ISS, NOW)).toBe(`Link up: the ground packet goes out now, and the ground has it within the round-trip light time (${formatEarliestReply(ISS)}).`)
    expect(deliveryText(MARS, NOW, 'it', 'queued')).toBe(
      `No link now (solar conjunction; the window is modelled from JPL Horizons geometry): it goes out when the link resumes, in ${formatCountdown(MARS.resumes_at! - NOW)}, and the earliest reply is ${formatEarliestReply(MARS)} away.`,
    )
  })
})

describe('rationaleSentence', () => {
  const vol1 = snap('std_vol1_requirements')!.data as StdData
  it("quotes [V1 4030]'s own sentence on the projected exposure, verbatim from the frozen standard", () => {
    const req = findRequirement('V1 4030', vol1)!
    const s = rationaleSentence(req, 'projected exposure')
    expect(s).toBe('Individual crewmember career dose includes all past spaceflight radiation exposures, plus the projected exposure for an upcoming mission.')
    expect(req.rationale).toContain(s!)
  })
  it('keeps an abbreviation inside its sentence and returns null when there is nothing to quote', () => {
    const req = findRequirement('V1 4030', vol1)!
    expect(rationaleSentence(req, 'lack of exercise')).toMatch(/^3% was chosen .*\(e\.g\., smoking, lack of exercise\)\.$/)
    expect(rationaleSentence(req, 'no such words')).toBeNull()
    expect(rationaleSentence(null, 'projected exposure')).toBeNull()
    expect(rationaleSentence({ rationale: '[Rationale: Only one sentence here]' }, 'one sentence')).toBe('Only one sentence here.')
  })
})
