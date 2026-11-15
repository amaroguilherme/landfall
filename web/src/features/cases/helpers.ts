// Plain helpers shared by the case components (no JSX, so the component files export only components):
// the status card's copy for a detected case, the ground-packet delivery and autonomy sentences (D4), one
// verbatim sentence of a requirement's rationale, the note for an opening not shown yet, the plain words for the
// engine's rejection codes, value formatting for confirmations, and in-page jumps.
import { formatCountdown, formatEarliestReply } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import { metClock } from '../../app/mission'
import { escalationMeta } from './model'
import type { CaseDefFull } from './types'

/** What the status card says while a case is `detected` (before Start), chosen in one place. */
export interface DetectedCopy {
  /** The procedure opens with its required red-flag question, so the card leads with it. */
  redFlagFirst: boolean
  /** The kicker beside the status badge. */
  kicker: string
  /** The card's heading. */
  title: string
  /** The label above the step-1 preview ("Then step 1 of 5"); null when step 1 is the card's main content. */
  stepHeading: string | null
  /** The line after step 1 when it leads: "Then: <primary countermeasure title>". */
  thenLine: string | null
  /** The Start button (it selects the primary countermeasure, which unlocks step 1). */
  button: string
}

/**
 * The status card's copy for a detected case. When step 1 is a red-flag question (renal r4: flank pain, fever, being
 * unable to pass urine), the card asks it before the countermeasure: "drink more" is the wrong first act if the urine
 * cannot pass. Every other case leads with its primary countermeasure, and step 1 is a preview (the SPE shelter's p1
 * is not a red flag). `startCount` is how many crewmembers a Start goes to (a shared case).
 */
export function detectedCopy(def: Pick<CaseDefFull, 'procedure' | 'countermeasure'>, startCount = 1): DetectedCopy {
  const steps = def.procedure ?? []
  const primary = def.countermeasure?.primary.title ?? null
  const all = startCount > 1 ? ` (all ${startCount} crewmembers)` : ''
  if (steps[0]?.red_flag === true) {
    return {
      redFlagFirst: true,
      kicker: 'Start now: the required red-flag question, then one primary countermeasure',
      title: 'Red-flag question first',
      stepHeading: null,
      thenLine: primary ? `Then: ${primary}` : null,
      button: `Start: answer the red-flag question first${all}`,
    }
  }
  return {
    redFlagFirst: false,
    kicker: 'Start now: one primary countermeasure',
    title: primary ?? 'Start the countermeasure',
    stepHeading: steps.length ? `Then step 1 of ${steps.length}` : null,
    thenLine: null,
    button: `Start the countermeasure${all}`,
  }
}

/** What a Prepared packet (meta.json packet_states: "Prepared (held on board)") waits for: the crew's release, or an escalation. */
const HELD = 'is held on board until the crew releases it or the case escalates'

/**
 * Where the ground packet goes and when, for the current link: queued until the link resumes (LOS, solar
 * conjunction) or sent at once (AOS). `subject` names the packet ("the ground packet", or "it").
 * `packet` is the packet's state (cases/model.ts packetStateOf): a 'prepared' packet is held on board, so the
 * sentence says what releases it before when it goes; 'queued', or no state, is the queued sentence.
 */
export function deliveryText(comms: CommsStatus, t: number, subject = 'the ground packet', packet?: 'prepared' | 'queued'): string {
  const held = packet === 'prepared'
  if (comms.blocked) {
    const when = comms.resumes_at !== null ? `, in ${formatCountdown(comms.resumes_at - t)}` : ''
    const why = comms.reason === 'solar_conjunction' ? 'solar conjunction; the window is modelled from JPL Horizons geometry' : 'loss of signal'
    if (held) return `No link now (${why}): ${subject} ${HELD}; then it goes out when the link resumes${when}, and the earliest reply is ${formatEarliestReply(comms)} away.`
    return `No link now (${why}): ${subject} goes out when the link resumes${when}, and the earliest reply is ${formatEarliestReply(comms)} away.`
  }
  if (held) return `Link up: ${subject} ${HELD}; then it goes out at once, and the ground has it within the round-trip light time (${formatEarliestReply(comms)}).`
  return `Link up: ${subject} goes out now, and the ground has it within the round-trip light time (${formatEarliestReply(comms)}).`
}

/**
 * The sentence of a requirement's frozen rationale that contains `words`, verbatim (the "[Rationale: ...]" wrapper
 * dropped), or null when the record or the sentence is not there. Sentences end at a period followed by a space, so
 * "e.g., smoking" stays inside its sentence. [V1 4030] + "projected exposure" ->
 * "Individual crewmember career dose includes all past spaceflight radiation exposures, plus the projected exposure for an upcoming mission."
 */
export function rationaleSentence(req: { rationale?: string | null } | null | undefined, words: string): string | null {
  const body = (req?.rationale ?? '').replace(/^\s*\[Rationale:\s*/, '').replace(/\]\s*$/, '')
  const hit = body.split(/\.\s+/).find((s) => s.includes(words))
  if (!hit) return null
  const s = hit.trim()
  return s.endsWith('.') ? s : `${s}.`
}

/** The autonomy sentence for the current link, read from meta.json escalation.autonomy (D4). */
export function autonomyText(comms: CommsStatus): string | null {
  const a = escalationMeta()?.autonomy
  return (comms.blocked ? a?.LOS : a?.AOS) ?? null
}

/** Why an opening in the data is not shown yet: later than the clock, or waiting for the next whole minute. */
export function openingNote(t: number): string {
  return t > metClock.get().metNow
    ? ', after the mission clock.'
    : ': cases are evaluated on the whole minute of the mission clock, so it opens at the next minute.'
}

/** Plain words for the engine's rejection codes (the code itself stays in the row's title). */
const REJECTION: Record<string, string> = {
  required_steps_pending: 'required steps still open',
  invalid_transition: 'not possible in this state',
  invalid_event: 'incomplete entry',
  duplicate_step: 'step already done',
  unknown_step: 'unknown step',
  unknown_countermeasure: 'unknown countermeasure',
  below_threshold: 'finding below caution',
  not_a_trigger: 'not a trigger of this case',
  time_reversed: 'earlier than the last action',
  unit_mismatch: 'unit does not match',
}

export const rejectionWords = (code: string): string => REJECTION[code] ?? code.replace(/_/g, ' ')

/** "1480 mL", "1,000,000,000 mGy-Eq" for the confirmation texts (the digits <Num> prints). */
export function fmtValue(value: number, unit: string): string {
  const body = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3, useGrouping: Math.abs(value) >= 10_000 }).format(value)
  return unit ? `${body} ${unit}` : body
}

export const stepAnchor = (id: string) => `lfc-step-${id}`

/** Scroll to an element by id and move focus to it (or to its first heading). */
export function jumpTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  const target = (el.querySelector('h2, h3, .lfc-step-text') as HTMLElement | null) ?? el
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1
  target.focus({ preventScroll: true })
}

