// Return-to-procedure alerts (pure; no React): annunciator entries for a case that needs the crew back in its
// procedure. They are derived in the UI from each case's own state and its own reassessment interval; the engine
// and the conformance vectors are untouched. The engine arms a case's tripwire only at OUTCOME and ignores a TICK
// outside watch (engine/cases.py, SPEC 5), so a case left in detected or acting is never reassessed by the engine
// itself: without these entries such a case would sit open and silent (CM-1's sleep case has been acting since
// its SELECT at MET 404/08:07:30), and an escalation would show only on the case page.
//
// Basis, for the reader of this code only (it is not in the frozen excerpt, so no crew-facing text cites it):
// NASA-STD-3001 Vol 2 Rev F Appendix F F.6.3 e, "The system must notify the crew whenever crew attention is
// required to initiate or return to an electronic crew procedure." WHEN that attention is required is LANDFALL's
// design choice, written out below.
//
//   (a) Overdue (caution). The case is detected or acting and t >= t_ref + spec.tripwire.reassess_after_s, the
//       case's own reassessment interval (6 h shelter, 72 h renal and sleep). t_ref is this instance's SELECT time
//       from state.log, or its opened_at before a countermeasure is selected. Design choice: the interval the
//       tripwire would wait after an outcome, counted from the crew action that started the clock.
//   (b) Escalated (the case's opening severity). The current instance is escalated and escalation.t >= the
//       scenario's "now" (nowMet). An earlier escalation belongs to the simulated crew's history: it raises nothing.
//
// Ids, groups and acknowledgement (mission.tsx AlertItem): a crewmember's entry is
// `${crew}:overdue:${case}:${instance}:${phase}` (phase: detected or acting, so a second overdue period of the same
// instance is a new event) or `${crew}:escalated:${case}:${instance}`, in group `${crew}:case:${case}`, the line of
// that case's findings (D16), with the case title as group_title. A crew-wide case (any 'ops' trigger) publishes ONE
// entry per kind in `ALL:case:${case}` that names the crewmembers; its `ack_ids` are their own entry ids, so one
// acknowledgement covers them, a crewmember who drops out leaves it acknowledged, and one newly overdue or escalated
// makes the line new again.
import { formatMet } from './engine'
import type { CaseState } from './engine'
import type { CaseView, TierOne } from './caseTimeline'
import type { AlertItem } from './mission'
import { CREW_IDS, SEVERITY_RANK } from './vocab'
import type { CrewId, Severity } from './vocab'

export interface ProcedureAlertInput {
  /** Every crewmember x case view, folded at `t` (useCases().cases). */
  cases: readonly CaseView[]
  /** The fold MET of those views (useCases().t). */
  t: number
  /** The scenario's "now" (ScenarioIndex.nowMet): escalations before it are the simulated crew's. */
  nowMet: number
  /** Who takes tier 1 for a patient (caseTimeline tierOneFor): the Crew Medical Officer, or the backup on CM-4's cases. */
  tierOneFor: (crewId: CrewId) => Pick<TierOne, 'name' | 'crewId'>
}

type Phase = 'detected' | 'acting'

interface Overdue {
  view: CaseView
  phase: Phase
  /** MET from which the reassessment is overdue: t_ref + reassess_after_s. */
  since: number
  id: string
}

interface Escalated {
  view: CaseView
  at: number
  id: string
}

/**
 * The case's opening severity: the same expression as features/cases/model.ts openingSeverity (read-only there),
 * mirrored so the eager bundle does not pull in the cases feature; procedureAlerts.test.ts pins the two together.
 */
export function openingSeverityOf(v: Pick<CaseView, 'state' | 'opening'>): Severity {
  return ((v.state.finding?.severity ?? v.opening?.finding.severity ?? 'caution') as Severity) || 'caution'
}

/** This instance's accepted SELECT (MET) from state.log: the first one after the instance's own OPEN, else null. */
export function instanceSelectAt(s: Pick<CaseState, 'log' | 'opened_at'>): number | null {
  const log = s.log
  let open = -1
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].event === 'OPEN' && log[i].error === null) {
      open = i
      break
    }
  }
  for (let i = open + 1; i < log.length; i++) {
    const e = log[i]
    if (e.event === 'SELECT' && e.error === null && typeof e.t === 'number' && (s.opened_at === null || e.t >= s.opened_at)) return e.t
  }
  return null
}

/** (a) When this view's reassessment is overdue at t, or null (only detected and acting cases are ever overdue). */
export function overdueOf(v: CaseView, t: number): Omit<Overdue, 'view'> | null {
  const s = v.state
  if ((s.status !== 'detected' && s.status !== 'acting') || s.opened_at === null) return null
  const interval = s.spec.tripwire.reassess_after_s
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) return null
  const ref = s.status === 'acting' ? (instanceSelectAt(s) ?? s.opened_at) : s.opened_at
  const since = ref + interval
  if (t < since) return null
  return { phase: s.status, since, id: `${v.crewId}:overdue:${v.caseId}:${s.instance}:${s.status}` }
}

/** (b) This view's escalation when it is the current instance's and at or after the scenario's "now", else null. */
export function escalatedOf(v: CaseView, nowMet: number): Omit<Escalated, 'view'> | null {
  const s = v.state
  if (s.status !== 'escalated' || !s.escalation || typeof s.escalation.t !== 'number' || s.escalation.t < nowMet) return null
  return { at: s.escalation.t, id: `${v.crewId}:escalated:${v.caseId}:${s.instance}` }
}

/** True for an overdue-reassessment entry (`${crew}:overdue:...`, `ALL:overdue:...`): the queue labels its rule. */
export const isOverdueAlert = (a: Pick<AlertItem, 'id' | 'kind'>): boolean => a.kind === 'procedure' && a.id.split(':')[1] === 'overdue'

const crewWide = (v: CaseView): boolean => (v.def.triggers ?? []).some((x) => x.kind === 'ops')

const byCrew = (a: CrewId, b: CrewId) => CREW_IDS.indexOf(a) - CREW_IDS.indexOf(b)

/** "CM-1", "CM-1 and CM-2", "CM-1, CM-2 and CM-3". */
export function crewList(ids: readonly CrewId[]): string {
  const l = [...ids].sort(byCrew)
  return l.length <= 1 ? (l[0] ?? '') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`
}

/** "the Crew Medical Officer (CM-4)": tier 1's name and the crewmember who holds it. */
const tierText = (t: Pick<TierOne, 'name' | 'crewId'>) => `${t.name}${t.crewId ? ` (${t.crewId})` : ''}`

/**
 * Who tells whom, now: "tell the Crew Medical Officer (CM-4) now" when every patient has the same tier 1, else one
 * clause per tier 1, "CM-1, CM-2 and CM-3 tell the Crew Medical Officer (CM-4) now; CM-4 tells the Commander (CM-1) now".
 */
export function tellClause(crews: readonly CrewId[], tierOneFor: ProcedureAlertInput['tierOneFor']): string {
  const groups = new Map<string, { text: string; crews: CrewId[] }>()
  for (const c of [...crews].sort(byCrew)) {
    const text = tierText(tierOneFor(c))
    const g = groups.get(text)
    if (g) g.crews.push(c)
    else groups.set(text, { text, crews: [c] })
  }
  const list = [...groups.values()]
  if (list.length <= 1) return `tell ${list[0]?.text ?? 'the Crew Medical Officer'} now`
  return list.map((g) => `${crewList(g.crews)} ${g.crews.length > 1 ? 'tell' : 'tells'} ${g.text} now`).join('; ')
}

const caseTitle = (v: CaseView): string => v.def.title ?? v.caseId

function overdueDetail(phases: readonly Phase[], tell: string): string {
  const act = phases.every((p) => p === 'acting') ? 'Log the outcome' : 'Start the countermeasure and log the outcome'
  return `${act} so the tripwire can judge, or ${tell}`
}

function escalationDetail(views: readonly CaseView[]): string {
  const why = new Set(views.map((v) => (v.state.escalation?.reason === 'red_flag' ? 'A red-flag question was answered yes' : 'The tripwire tripped at the reassessment')))
  const queued = views.every((v) => v.state.packet_queued_at !== null)
  const tier2 = views[0]?.state.spec.escalation_tiers?.[1]?.text ?? 'the flight surgeon'
  return `${[...why].join('; ')}${queued ? `; the ground packet is queued for ${tier2} and sent when a link exists` : ''}`
}

const maxSeverity = (list: readonly Severity[]): Severity =>
  list.reduce<Severity>((m, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[m] ? s : m), list[0] ?? 'caution')

/**
 * The return-to-procedure entries at the fold MET `t` (see the header): an overdue reassessment (caution) and a
 * new escalation (the case's opening severity), each in its case's annunciator line, `kind: 'procedure'`.
 */
export function procedureAlerts(input: ProcedureAlertInput): AlertItem[] {
  const { cases, t, nowMet, tierOneFor } = input
  const out: AlertItem[] = []
  // crew-wide cases collect their crewmembers first, in case order
  const wide = new Map<string, { overdue: Overdue[]; escalated: Escalated[]; title: string }>()
  for (const v of cases) {
    const o = overdueOf(v, t)
    const e = o ? null : escalatedOf(v, nowMet)
    if (!o && !e) continue
    if (crewWide(v)) {
      const w = wide.get(v.caseId) ?? { overdue: [], escalated: [], title: caseTitle(v) }
      if (o) w.overdue.push({ view: v, ...o })
      if (e) w.escalated.push({ view: v, ...e })
      wide.set(v.caseId, w)
      continue
    }
    const base = {
      kind: 'procedure' as const,
      crew_id: v.crewId,
      href: `#/case/${v.caseId}?crew=${v.crewId}`,
      case_id: v.caseId,
      group: `${v.crewId}:case:${v.caseId}`,
      group_title: caseTitle(v),
    }
    if (o) {
      out.push({
        ...base,
        id: o.id,
        severity: 'caution',
        title: `Reassessment overdue since MET ${formatMet(o.since)}`,
        detail: overdueDetail([o.phase], tellClause([v.crewId], tierOneFor)),
        t: o.since,
      })
    } else if (e) {
      out.push({
        ...base,
        id: e.id,
        severity: openingSeverityOf(v),
        title: `Escalated MET ${formatMet(e.at)}: ${tellClause([v.crewId], tierOneFor)}`,
        detail: escalationDetail([v]),
        t: e.at,
      })
    }
  }
  for (const [caseId, w] of wide) {
    const base = {
      kind: 'procedure' as const,
      crew_id: 'ALL' as const,
      href: `#/case/${caseId}`,
      case_id: caseId,
      group: `ALL:case:${caseId}`,
      group_title: w.title,
    }
    if (w.overdue.length) {
      const crews = w.overdue.map((x) => x.view.crewId)
      const since = Math.min(...w.overdue.map((x) => x.since))
      const same = w.overdue.every((x) => x.since === since)
      out.push({
        ...base,
        id: `ALL:overdue:${caseId}`,
        ack_ids: w.overdue.map((x) => x.id),
        severity: 'caution',
        title: same
          ? `Reassessment overdue since MET ${formatMet(since)} for ${crewList(crews)}`
          : `Reassessment overdue for ${w.overdue.map((x) => `${x.view.crewId} (since MET ${formatMet(x.since)})`).join(', ')}`,
        detail: overdueDetail(
          w.overdue.map((x) => x.phase),
          tellClause(crews, tierOneFor),
        ),
        t: since,
      })
    }
    if (w.escalated.length) {
      const crews = w.escalated.map((x) => x.view.crewId)
      const at = Math.min(...w.escalated.map((x) => x.at))
      const same = w.escalated.every((x) => x.at === at)
      out.push({
        ...base,
        id: `ALL:escalated:${caseId}`,
        ack_ids: w.escalated.map((x) => x.id),
        severity: maxSeverity(w.escalated.map((x) => openingSeverityOf(x.view))),
        title: `Escalated ${same ? '' : 'from '}MET ${formatMet(at)}: ${tellClause(crews, tierOneFor)}`,
        detail: escalationDetail(w.escalated.map((x) => x.view)),
        t: at,
      })
    }
  }
  return out
}
