// ONE ground-packet state and ONE escalation wording for every view (hero, case page, Downlink), so the
// same packet is never "prepared" on one screen and "queued" on another (pure; no React).
//   - packet state: rules/meta.json `packet_states` (labels "Prepared (held on board)" and "Queued"),
//     decided by the engine's case state `packet_queued_at` (set by a crew release step or by escalation);
//   - escalation tiers (D4): rules/meta.json `escalation`: tier 1, the onboard Crew Medical Officer, now;
//     tier 2, the flight surgeon on the ground, through the ground packet: at once when the link is up
//     (AOS), when it resumes during loss of signal or solar conjunction. The link timing is the engine's
//     commsEta (useComms); the reducer does not know the link.
import { RULES } from './engine'
import type { CaseState } from './engine'
import type { CommsStatus } from './comms'
import { formatCommsLightTime, formatCountdown } from './comms'
import { CREW } from './vocab'

interface PacketStateDef {
  id: string
  label: string
  when?: string
}

interface TierDef {
  tier: number
  id: string
  label: string
  when?: string
}

interface EscalationMeta {
  tiers?: TierDef[]
  autonomy?: { AOS?: string; LOS?: string }
  chip?: string
  source?: Record<string, unknown>
}

const META = (RULES.meta ?? {}) as unknown as { packet_states?: PacketStateDef[]; escalation?: EscalationMeta }

const STATE_DEFS: readonly PacketStateDef[] = Array.isArray(META.packet_states) ? META.packet_states : []

/** meta.json label of a packet state id ("prepared" -> "Prepared (held on board)"), with a safe fallback. */
export function packetStateLabel(id: 'prepared' | 'queued'): string {
  return STATE_DEFS.find((d) => d.id === id)?.label ?? (id === 'prepared' ? 'Prepared (held on board)' : 'Queued')
}

export type PacketStateId = 'not_open' | 'no_packet' | 'prepared' | 'queued'

export interface PacketState {
  id: PacketStateId
  /** "Prepared (held on board)" / "Queued" from meta.json; a plain phrase for not_open / no_packet. */
  label: string
  /** meta.json `when` sentence of the state, when it has one. */
  when: string | null
  /** MET the packet was queued (crew release or escalation), else null. */
  queuedAt: number | null
  /** Why it is queued: the crew released it, or the case escalated; null while not queued. */
  reason: 'released' | 'escalated' | null
}

/** The packet state of a case, from the engine's case state alone (identical on every screen). */
export function packetState(state: Pick<CaseState, 'status' | 'packet_queued_at' | 'escalation' | 'spec'> | null): PacketState {
  if (!state || state.status === 'idle') {
    return { id: 'not_open', label: 'Not open', when: 'the case is not open, so no packet is prepared', queuedAt: null, reason: null }
  }
  if (state.spec?.escalation?.ground_packet === false) {
    return { id: 'no_packet', label: 'No ground packet', when: 'this case sends no ground packet', queuedAt: null, reason: null }
  }
  if (state.packet_queued_at !== null && state.packet_queued_at !== undefined) {
    const def = STATE_DEFS.find((d) => d.id === 'queued')
    const escalated = !!state.escalation && state.escalation.t === state.packet_queued_at
    return { id: 'queued', label: packetStateLabel('queued'), when: def?.when ?? null, queuedAt: state.packet_queued_at, reason: escalated ? 'escalated' : 'released' }
  }
  const def = STATE_DEFS.find((d) => d.id === 'prepared')
  return { id: 'prepared', label: packetStateLabel('prepared'), when: def?.when ?? null, queuedAt: null, reason: null }
}

/**
 * One sentence (no final period) on when the packet reaches the ground, from the link state at MET t: a
 * QUEUED packet is "Sent when the link resumes, in 11 d 06 h" (LOS) or "Sent at once: the link is up
 * (one-way light time 1.28 s)" (AOS); a PREPARED packet is not sent, and the sentence says what queues it.
 * Every view writes "Ground packet: <label>. <this>." so the wording is identical everywhere.
 */
export function packetDelivery(p: PacketState, comms: Pick<CommsStatus, 'blocked' | 'resumes_at' | 'one_way_s' | 'range' | 'basis'>, t: number): string {
  if (p.id === 'prepared') return 'Not sent yet: it is queued when the crew releases it or the case escalates, and a queued packet is sent when a link exists'
  if (p.id !== 'queued') return ''
  if (comms.blocked) {
    return comms.resumes_at !== null
      ? `Sent when the link resumes, in ${formatCountdown(comms.resumes_at - t)}`
      : 'Sent when the link resumes (the resume time is not in this build)'
  }
  return `Sent at once: the link is up (one-way light time ${formatCommsLightTime(comms)})`
}

// ---- escalation tiers (D4) ----------------------------------------------------------------------------

/** The onboard Crew Medical Officer of the fictional crew (vocab.ts), e.g. "CM-4". */
export const CMO_ID: string | null = CREW.find((c) => c.role === 'Crew Medical Officer')?.id ?? null

export interface TierLine {
  tier: number
  id: 'crew_medical_officer' | 'flight_surgeon' | string
  /** "Crew Medical Officer (onboard)" / "Flight surgeon (ground)" (meta.json). */
  label: string
  /** The crewmember who holds the role, when the crew has one (tier 1: the CMO, "CM-4"), else null. */
  crew: string | null
  /** When this tier has the case, for the link state now. */
  when: string
}

/**
 * The two tiers with their timing for this link: tier 1 now; tier 2 within the round trip at AOS, or when the
 * link resumes (countdown) during LOS. Labels and order come from meta.json escalation.tiers.
 * `tier1` is the patient's own tier 1 (`CaseView.tier1`, `tierOneFor(crewId)`): on the Crew Medical Officer's own
 * cases it is the backup, the Commander (CM-1), as the engine records it. Without it, tier 1 is the Crew Medical Officer.
 */
export function escalationTiers(
  comms: Pick<CommsStatus, 'blocked' | 'resumes_at' | 'one_way_s' | 'range' | 'basis'>,
  t: number,
  tier1: { id: string; label: string; crewId: string | null } | null = null,
): TierLine[] {
  const defs = Array.isArray(META.escalation?.tiers) ? [...META.escalation!.tiers!].sort((a, b) => a.tier - b.tier) : []
  return defs.map((d) => {
    if (d.id === 'crew_medical_officer') {
      return tier1
        ? { tier: d.tier, id: tier1.id, label: tier1.label, crew: tier1.crewId, when: 'now' }
        : { tier: d.tier, id: d.id, label: d.label, crew: CMO_ID, when: 'now' }
    }
    const when = !comms.blocked
      ? `through the ground packet, at once: the link is up, so the ground has it within the round trip (${formatCommsLightTime(comms, true)})`
      : comms.resumes_at !== null
        ? `through the ground packet, queued until the link resumes in ${formatCountdown(comms.resumes_at - t)}`
        : 'through the ground packet, queued until the link resumes'
    return { tier: d.tier, id: d.id, label: d.label, crew: null, when }
  })
}

/** meta.json escalation.autonomy for this link: who directs the response with the link up, and without it. */
export function autonomyText(comms: Pick<CommsStatus, 'blocked'>): string | null {
  const a = META.escalation?.autonomy
  return (comms.blocked ? a?.LOS : a?.AOS) ?? null
}

/** The chip and source of the escalation design (meta.json escalation). */
export const ESCALATION_BASIS: { chip: string | null; source: Record<string, unknown> | null } = {
  chip: META.escalation?.chip ?? null,
  source: META.escalation?.source ?? null,
}
