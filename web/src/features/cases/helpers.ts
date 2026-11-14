// Plain helpers shared by the case components (no JSX, so the component files export only components):
// the ground-packet delivery and autonomy sentences (D4), the note for an opening not shown yet, the
// plain words for the engine's rejection codes, value formatting for confirmations, and in-page jumps.
import { formatCountdown, formatEarliestReply } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import { metClock } from '../../app/mission'
import { escalationMeta } from './model'

/**
 * Where the ground packet goes and when, for the current link: queued until the link resumes (LOS, solar
 * conjunction) or sent at once (AOS). `subject` names the packet ("the ground packet", or "it").
 */
export function deliveryText(comms: CommsStatus, t: number, subject = 'the ground packet'): string {
  if (comms.blocked) {
    const when = comms.resumes_at !== null ? `, in ${formatCountdown(comms.resumes_at - t)}` : ''
    const why = comms.reason === 'solar_conjunction' ? 'solar conjunction; the window is modelled from JPL Horizons geometry' : 'loss of signal'
    return `No link now (${why}): ${subject} goes out when the link resumes${when}, and the earliest reply is ${formatEarliestReply(comms)} away.`
  }
  return `Link up: ${subject} goes out now, and the ground has it within the round-trip light time (${formatEarliestReply(comms)}).`
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

