// PVT-B: the brief 3-minute Psychomotor Vigilance Test. Protocol constants and the pure scoring
// function. No React, no DOM, no clock: tested on fixed reaction-time arrays (pvt.test.ts).
//
// Source, read in full text (PMC3197786), not from a summary:
//   Basner M, Mollicone D, Dinges DF. Validity and sensitivity of a brief psychomotor vigilance
//   test (PVT-B) to total and partial sleep deprivation. Acta Astronaut 2011;69(11-12):949-959.
//   doi:10.1016/j.actaastro.2011.07.015. PMID 22025811.
//
// What the paper says, verbatim:
//   Abstract  "we developed a modified brief 3-min version of the PVT (PVT-B)"
//   §2.2      "The inter-stimulus intervals varied randomly from 1–4 s (including a 1 s RT
//             feedback interval)."
//   §2.2      "Both versions gave a signal after a 30 s period without response, which was counted
//             as a lapse (see below) with 30 s response time."
//   §2.3      "A response was regarded valid if RT was ≥ 100 ms. Responses without a stimulus or
//             RTs < 100 ms were counted as false starts (errors of commission)."
//   §2.3      "For calculating mean 1/RT ... each RT was divided by 1,000 and then reciprocally
//             transformed. The transformed values were then averaged."
//   §2.3      "Lapses (errors of omission) were defined as RTs ≥ 500 ms." ... "a 6th variable was
//             generated for the PVT-B comprising the number of lapses based on a lapse definition
//             of ≥ 355 ms."
//   §2.3      "The performance score is calculated as 100% minus the number of lapses and false
//             starts relative to the number of valid stimuli and false starts." ... "the PVT-B
//             performance score was always calculated based on the 355 ms lapse threshold."
//   §4.1      "the 355 ms lapse threshold for the PVT-B was found post-hoc in the TSD experiment,
//             and may depend on PVT hardware."
//
// The 355 ms lapse is LITERATURE (this paper), never a NASA requirement: no NASA-STD-3001
// requirement or OCHMO brief adopts it (engine/rules/personal.json, pvt_lapses definition note).

import type { ChipKind } from '../../app/vocab'

export const PVT_B_CITATION =
  'Basner M, Mollicone D, Dinges DF. Validity and sensitivity of a brief psychomotor vigilance test (PVT-B) to total and partial sleep deprivation. Acta Astronaut 2011;69(11-12):949-959. doi:10.1016/j.actaastro.2011.07.015. PMID 22025811'
export const PVT_B_URL = 'https://pubmed.ncbi.nlm.nih.gov/22025811/'
export const PVT_B_FULLTEXT_URL = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3197786/'

/** Protocol constants. Each one names its basis (SPEC section 1.4 chips). */
export const PVT_B = {
  /** Validated test length: 3 min (abstract). */
  durationMs: 180_000,
  /** Inter-stimulus interval, response to next stimulus, 1-4 s including the 1 s feedback (§2.2). */
  isiMinMs: 1_000,
  isiMaxMs: 4_000,
  /** Reaction time shown after each response, inside the ISI (§2.2). */
  feedbackMs: 1_000,
  /** No response for 30 s = a lapse with a 30 s RT (§2.2). */
  timeoutMs: 30_000,
  /** Valid response: RT >= 100 ms; below that (or no stimulus) = false start (§2.3). */
  minValidRtMs: 100,
  /** PVT-B lapse: RT >= 355 ms (§2.3, the paper's 6th variable). LANDFALL's pvt_lapses. */
  lapseMs: 355,
  /** Standard 10-min PVT lapse: RT >= 500 ms (§2.3). Reported for transparency only. */
  standardLapseMs: 500,
} as const

/** The judge-facing demo: same procedure, 30 s. NOT the validated protocol; never recorded. */
export const PVT_DEMO_DURATION_MS = 30_000

export interface PvtConstantRow {
  label: string
  value: string
  chip: ChipKind
  basis: string
}

/** Rows for the "where these numbers come from" table. */
export const PVT_CONSTANTS: PvtConstantRow[] = [
  { label: 'Test length', value: '3 min', chip: 'literature', basis: 'Basner 2011, abstract: the brief 3-min version of the PVT.' },
  {
    label: 'Wait between stimuli',
    value: '1–4 s',
    chip: 'literature',
    basis: 'Basner 2011 §2.2: random 1–4 s, including the 1 s reaction-time feedback.',
  },
  {
    label: 'Lapse (PVT-B)',
    value: '≥ 355 ms',
    chip: 'literature',
    basis:
      'Basner 2011 §2.3, the paper’s 6th outcome variable. Not a NASA requirement: no NASA standard adopts it. The authors note it was found post hoc and may depend on the PVT hardware.',
  },
  {
    label: 'Lapse (standard 10-min PVT)',
    value: '≥ 500 ms',
    chip: 'literature',
    basis: 'Basner 2011 §2.3. Shown for comparison; LANDFALL’s indicator uses 355 ms.',
  },
  {
    label: 'False start',
    value: '< 100 ms',
    chip: 'literature',
    basis: 'Basner 2011 §2.3: a press with no stimulus, or a reaction time under 100 ms.',
  },
  {
    label: 'No response',
    value: '30 s',
    chip: 'literature',
    basis: 'Basner 2011 §2.2: counted as a lapse with a 30 s reaction time.',
  },
  {
    label: 'Summary reaction time',
    value: 'median',
    chip: 'design choice',
    basis: 'engine/rules/personal.json: the median resists the long lapse tail. Basner 2011 reports mean 1/RT, also shown.',
  },
  {
    label: 'Interval distribution',
    value: 'uniform',
    chip: 'design choice',
    basis: 'The paper says “varied randomly”. A false start restarts the wait with a new interval.',
  },
  {
    label: 'Demo run',
    value: '30 s',
    chip: 'design choice',
    basis: 'For a quick look only. Not the validated protocol, so it is never recorded as a PVT-B result.',
  },
  {
    label: 'Browser timing error',
    value: '≈ 17 ms',
    chip: 'derived',
    basis:
      'One display frame: 1,000 ms / 60 Hz = 16.7 ms. The stimulus time is the animation frame that draws it and the response time is the input event, so add keyboard or touchscreen latency too. The paper used the PVT-192 handheld device, not a web browser.',
  },
]

// ---------------------------------------------------------------------------------------------
// Events and scoring
// ---------------------------------------------------------------------------------------------

/**
 * One thing that happened during a test.
 * - `response`: a press while the stimulus was showing; `rt_ms` is stimulus onset to press.
 *   An RT below `minValidRtMs` is scored as a false start (§2.3).
 * - `no_stimulus`: a press with no stimulus on screen (false start, §2.3).
 * - `timeout`: no press within `timeoutMs` (a lapse with a 30 s RT, §2.2).
 * `t_ms` (optional) is the time since the test started, for the record only.
 */
export type PvtEvent =
  | { kind: 'response'; rt_ms: number; t_ms?: number }
  | { kind: 'no_stimulus'; t_ms?: number }
  | { kind: 'timeout'; t_ms?: number }

export interface PvtScore {
  /** Stimuli presented and resolved (responses + timeouts). */
  stimuli: number
  /** Valid stimuli: responses with RT >= 100 ms, plus timeouts (scored at 30 s). */
  valid: number
  /** PVT-B lapses, RT >= 355 ms (timeouts included). LANDFALL's pvt_lapses. */
  lapses: number
  /** Standard-PVT lapses, RT >= 500 ms (timeouts included). Transparency only. */
  lapses500: number
  /** Presses without a stimulus plus responses under 100 ms. */
  falseStarts: number
  timeouts: number
  /** Median RT of valid stimuli, ms (timeouts at 30,000 ms). null with no valid stimulus. */
  medianRt: number | null
  /** Mean of 1/(RT in s) over valid stimuli: response speed, per second. */
  meanSpeed: number | null
  /** 100 x (1 - (lapses + false starts) / (valid + false starts)), with the 355 ms lapse. */
  performanceScore: number | null
}

export interface PvtScoreOptions {
  lapseMs?: number
  standardLapseMs?: number
  minValidRtMs?: number
  timeoutMs?: number
}

function median(sorted: number[]): number | null {
  const n = sorted.length
  if (n === 0) return null
  const mid = Math.floor(n / 2)
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Score a PVT-B run. Pure: the same events always give the same score. */
export function scorePvt(events: readonly PvtEvent[], opts: PvtScoreOptions = {}): PvtScore {
  const lapseMs = opts.lapseMs ?? PVT_B.lapseMs
  const standardLapseMs = opts.standardLapseMs ?? PVT_B.standardLapseMs
  const minValidRtMs = opts.minValidRtMs ?? PVT_B.minValidRtMs
  const timeoutMs = opts.timeoutMs ?? PVT_B.timeoutMs

  const validRts: number[] = []
  let falseStarts = 0
  let timeouts = 0
  let stimuli = 0
  for (const e of events) {
    if (e.kind === 'no_stimulus') {
      falseStarts += 1
    } else if (e.kind === 'timeout') {
      stimuli += 1
      timeouts += 1
      validRts.push(timeoutMs)
    } else if (e.kind === 'response') {
      if (typeof e.rt_ms !== 'number' || !Number.isFinite(e.rt_ms) || e.rt_ms < 0) {
        throw new RangeError(`scorePvt: reaction time must be a finite number of ms >= 0, got ${String(e.rt_ms)}`)
      }
      stimuli += 1
      if (e.rt_ms < minValidRtMs) falseStarts += 1
      else validRts.push(e.rt_ms)
    } else {
      throw new RangeError(`scorePvt: unknown event kind ${String((e as { kind?: unknown }).kind)}`)
    }
  }

  let lapses = 0
  let lapses500 = 0
  let speedSum = 0
  for (const rt of validRts) {
    if (rt >= lapseMs) lapses += 1
    if (rt >= standardLapseMs) lapses500 += 1
    speedSum += 1 / (rt / 1000) // left-to-right loop sum (SPEC 5 determinism rule)
  }
  const valid = validRts.length
  const sorted = [...validRts].sort((a, b) => a - b)
  const denom = valid + falseStarts
  return {
    stimuli,
    valid,
    lapses,
    lapses500,
    falseStarts,
    timeouts,
    medianRt: median(sorted),
    meanSpeed: valid > 0 ? speedSum / valid : null,
    performanceScore: denom > 0 ? 100 * (1 - (lapses + falseStarts) / denom) : null,
  }
}

/** Draw the next inter-stimulus interval in ms, uniform in [1000, 4000). `rng` returns [0, 1). */
export function drawIsiMs(rng: () => number = Math.random): number {
  const u = rng()
  const clamped = u < 0 ? 0 : u >= 1 ? 0.999999 : u
  return PVT_B.isiMinMs + clamped * (PVT_B.isiMaxMs - PVT_B.isiMinMs)
}
