// Annunciator: active Emergency / Warning / Caution / Advisory counts, the unacknowledged count
// and the queue (NASA-STD-3001 Vol 2 Appendix F F.6.4 a-d), with aria-live announcements.
// D16: the queue is grouped by case and crewmember (one sleep episode is one line, not four), the
// counts count those lines, and a Warning is acknowledged on its own line, never by "acknowledge all".
// The E and NEW counts stay visible on every viewport (F.4.2 f; shell.css keeps them on phones).
// Return-to-procedure entries (procedureAlerts.ts: a reassessment overdue, a new escalation) join their case's
// line: the counts stay, the line is new again and names the entry, and it is announced like a new line.
import { useEffect, useId, useRef, useState } from 'react'
import { Chip, SeverityBadge, SeverityIcon } from '../ui'
import { ackIdsOf, selectAlertGroups, selectAnnunciator, useMission } from './mission'
import type { AlertGroup, AlertItem, AnnunciatorCounts } from './mission'
import { isOverdueAlert } from './procedureAlerts'
import type { Severity } from './vocab'
import { useDismissableDetails } from './useDismissableDetails'

const E_NOTE = "LANDFALL never raises Emergency-class alarms; that is the vehicle caution and warning system's job."

function Cell({
  letter,
  severity,
  count,
  evaluated,
  noun,
  title,
}: {
  letter: string
  severity: Severity
  count: number
  evaluated: boolean
  noun: string
  title?: string
}) {
  const lit = evaluated && count > 0
  return (
    <span className="lf-ann-cell" data-severity={severity} data-lit={lit || undefined} title={title}>
      {lit ? <SeverityIcon severity={severity} size={12} /> : null}
      <span className="lf-ann-letter" aria-hidden="true">
        {letter}
      </span>
      <span className="lf-num lf-ann-count" aria-hidden="true">
        {evaluated ? count : '–'}
      </span>
      <span className="sr-only">
        {evaluated ? `${count} ${plural(noun, count)}` : `${plural(noun, 2)} not evaluated`},
      </span>
    </span>
  )
}

/** English plural for the screen-reader text: emergency -> emergencies, advisory -> advisories. */
function plural(noun: string, n: number): string {
  if (n === 1) return noun
  return /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`
}

function summarise(c: AnnunciatorCounts): string {
  const part = (n: number, w: string) => `${n} ${plural(w, n)}`
  return `Alerts: ${part(c.warning, 'warning')}, ${part(c.caution, 'caution')}, ${part(c.advisory, 'advisory')}.`
}

const crewText = (c: AlertGroup['crew_id']) => (c === 'ALL' ? 'All crew' : (c ?? ''))

const isProcedure = (a: AlertItem) => a.kind === 'procedure'
const isWarningLine = (g: AlertGroup) => g.severity === 'warning' || g.severity === 'emergency'

/** The acknowledgement ids of a line: each member's own, or the crewmembers' a crew-wide entry stands for. */
const lineAckIds = (g: AlertGroup): string[] => g.alerts.flatMap(ackIdsOf)

/** "2 findings", "1 finding · 1 procedure alert": a return-to-procedure entry is not a finding. */
function memberCount(g: AlertGroup) {
  const procedures = g.alerts.filter(isProcedure).length
  const findings = g.alerts.length - procedures
  const part = (n: number, w: string) => (
    <>
      <span className="lf-num">{n}</span> {n === 1 ? w : `${w}s`}
    </>
  )
  return (
    <>
      {findings ? part(findings, 'finding') : null}
      {findings && procedures ? ' · ' : null}
      {procedures ? part(procedures, 'procedure alert') : null}
    </>
  )
}

/** The words a live region reads for a line: "Sleep and circadian drift · Reassessment overdue ..., CM-1". */
const lineWords = (g: AlertGroup) => `${g.title}${g.crew_id ? `, ${crewText(g.crew_id)}` : ''}`

/** What the live regions remember from the last change of the queue. */
export interface AnnounceMemory {
  counts: AnnunciatorCounts
  /** Each warning line and its member ids. */
  warnings: Map<string, Set<string>>
  /** The lines that were acknowledged. */
  acked: Set<string>
}

export interface Announcement {
  /** Remember this for the next change. */
  memory: AnnounceMemory
  /** The warning lines now: an assertive text naming any other line is stale and is cleared. */
  warningIds: Set<string>
  /** A new assertive text, else null (keep the current one unless it is stale). */
  assertive: { key: string; text: string } | null
  /** A new polite text, else null (keep the current one). */
  polite: string | null
}

/**
 * What the live regions say after a change of the queue (pure). Polite: the counts summary when the counts
 * change. Assertive: a warning line that appears, or gains a member it did not have (an environment switch
 * swaps the rule behind the same line: Mars-orbit monitor -> NOAA S3), so the text names the current warning;
 * a member that goes announces nothing. A line that turns NEW again (acknowledged at the last change, then a
 * new member joined it: a reassessment overdue, an escalation) is announced like a new line: assertive for a
 * warning, polite ("New caution: ...") for a caution or an advisory. Nothing is said before the first evaluation.
 */
export function announce(prev: AnnounceMemory | null, groups: readonly AlertGroup[], counts: AnnunciatorCounts): Announcement {
  const warnings = new Map(groups.filter(isWarningLine).map((g) => [g.id, new Set(g.alerts.map((a) => a.id))]))
  const memory: AnnounceMemory = { counts, warnings, acked: new Set(groups.filter((g) => g.acknowledged).map((g) => g.id)) }
  const warningIds = new Set(warnings.keys())
  if (!counts.evaluated) return { memory, warningIds, assertive: null, polite: null }
  const p = prev
  const same = !!p && p.counts.evaluated && p.counts.warning === counts.warning && p.counts.caution === counts.caution && p.counts.advisory === counts.advisory
  const renewed = p ? groups.filter((g) => !g.acknowledged && p.acked.has(g.id)) : []
  const fresh = p ? groups.find((g) => isWarningLine(g) && (!p.warnings.has(g.id) || g.alerts.some((a) => !p.warnings.get(g.id)!.has(a.id)))) : undefined
  const warn = renewed.find(isWarningLine) ?? fresh
  const notes = renewed.filter((g) => !isWarningLine(g)).map((g) => `New ${g.severity}: ${lineWords(g)}.`)
  return {
    memory,
    warningIds,
    assertive: warn ? { key: warn.id, text: `New warning: ${lineWords(warn)}.` } : null,
    polite: !same || notes.length ? [...(same ? [] : [summarise(counts)]), ...notes].join(' ') : null,
  }
}

/** An action text that starts with its own label ("EVA fitness floor not met: this ...") shown under that label. */
function actionLine(text: string, title: string): string {
  if (!text.startsWith(`${title}: `)) return text
  const rest = text.slice(title.length + 2)
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

function GroupItem({ g, onAck }: { g: AlertGroup; onAck: (ids: string[]) => void }) {
  const many = g.alerts.length > 1
  const single = g.alerts[0]
  // a line with a procedure entry's detail puts every member's icon at its first text line (the members wrap on a phone)
  const top = g.alerts.some((a) => isProcedure(a) && !!a.detail)
  return (
    <li data-acked={g.acknowledged || undefined} data-severity={g.severity}>
      <SeverityBadge severity={g.severity} size="sm" />
      <span className="lf-ann-item">
        {g.href ? <a href={g.href}>{g.title}</a> : g.title}
        {g.crew_id ? <span className="lf-ann-crew"> · {crewText(g.crew_id)}</span> : null}
        {many ? (
          <>
            <span className="lf-ann-crew"> · {memberCount(g)}</span>
            <ul className="lf-ann-members">
              {g.alerts.map((a) => {
                // a procedure entry's detail goes under its title (the icon stays on the first line); when the line
                // title already names the entry, the member shows only its detail, so the title is not printed twice
                const detail = isProcedure(a) && a.detail ? a.detail : null
                const named = !!detail && g.title.endsWith(` · ${a.title}`)
                return (
                  <li key={a.id} data-kind={a.kind ?? 'finding'} style={top ? { alignItems: 'flex-start' } : undefined}>
                    <SeverityIcon severity={a.severity} size={10} style={top ? { flex: 'none', marginTop: '0.3em' } : undefined} />
                    {named ? (
                      <span>{detail}</span>
                    ) : (
                      <span>
                        {a.title}
                        {detail ? <span className="lf-ann-detail">{detail}</span> : null}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <>
            {single.detail ? <span className="lf-ann-detail">{single.detail}</span> : null}
            {single.action_text ? <span className="lf-ann-detail lf-ann-action">{actionLine(single.action_text, single.title)}</span> : null}
          </>
        )}
      </span>
      {g.acknowledged ? (
        <span className="lf-ann-acked">Acknowledged</span>
      ) : (
        <button
          type="button"
          className="lf-linkbtn"
          onClick={() => onAck(lineAckIds(g))}
          aria-label={`Acknowledge ${g.severity}: ${g.title}${g.crew_id ? `, ${crewText(g.crew_id)}` : ''}`}
        >
          Acknowledge
        </button>
      )}
    </li>
  )
}

export function Annunciator() {
  const { state, acknowledge } = useMission()
  const counts = selectAnnunciator(state)
  const groups = selectAlertGroups(state)
  const ref = useRef<HTMLDetailsElement>(null)
  useDismissableDetails(ref)
  const descId = useId()

  // aria-live (announce() above): polite summary when the counts change; assertive for a new warning line, one
  // that gained a member, or one NEW again; a caution or advisory line NEW again in the polite region.
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState<{ key: string; text: string } | null>(null)
  const prev = useRef<AnnounceMemory | null>(null)
  const warningSig = groups
    .filter(isWarningLine)
    .map((g) => `${g.id}=${g.alerts.map((a) => a.id).join(',')}`)
    .join('|')
  const ackSig = groups.map((g) => `${g.id}=${g.acknowledged ? 1 : 0}`).join('|')
  useEffect(() => {
    const a = announce(prev.current, groups, counts)
    prev.current = a.memory
    if (!counts.evaluated) return
    // a new text replaces the old; otherwise a text naming a warning line that is gone is cleared
    setAssertive((x) => a.assertive ?? (x && !a.warningIds.has(x.key) ? null : x))
    if (a.polite !== null) setPolite(a.polite)
    // groups is read only to name the lines; warningSig and ackSig cover what is announced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts.evaluated, counts.warning, counts.caution, counts.advisory, warningSig, ackSig])

  // "Acknowledge all" covers cautions and advisories only: each warning is acknowledged on its own line.
  const bulk = groups.filter((g) => !g.acknowledged && !isWarningLine(g))
  const procedures = groups.reduce((n, g) => n + g.alerts.filter(isProcedure).length, 0)
  const findings = groups.reduce((n, g) => n + g.alerts.length, 0) - procedures
  const overdue = groups.some((g) => g.alerts.some(isOverdueAlert))

  return (
    <>
      <details className="lf-ann lf-pop" ref={ref}>
        <summary aria-describedby={descId}>
          <span className="sr-only">Alert annunciator: </span>
          <Cell letter="E" severity="emergency" count={0} evaluated noun="emergency" title={E_NOTE} />
          <Cell letter="W" severity="warning" count={counts.warning} evaluated={counts.evaluated} noun="warning" />
          <Cell letter="C" severity="caution" count={counts.caution} evaluated={counts.evaluated} noun="caution" />
          <Cell letter="A" severity="advisory" count={counts.advisory} evaluated={counts.evaluated} noun="advisory" />
          <span className="lf-ann-new" data-zero={counts.unacknowledged === 0 || undefined}>
            <span className="lf-num">{counts.evaluated ? counts.unacknowledged : '–'}</span> NEW
            <span className="sr-only"> (unacknowledged)</span>
          </span>
        </summary>
        <span id={descId} className="sr-only">
          {E_NOTE} Open for the alert queue.
        </span>
        <div className="lf-pop-body" role="region" aria-label="Alert queue">
          <p className="lf-pop-note">
            <strong>E</strong> stays at <span className="lf-num">0</span>: {E_NOTE}
          </p>
          {!counts.evaluated ? (
            <p className="lf-pop-note">
              No view has evaluated the crew yet. Open <a href="#/">Now</a> to run the onboard evaluation.
            </p>
          ) : groups.length === 0 ? (
            <p className="lf-pop-note">No active alerts.</p>
          ) : (
            <>
              <p className="lf-pop-note">
                One line per case and crewmember: <span className="lf-num">{groups.length}</span> {groups.length === 1 ? 'line' : 'lines'} for{' '}
                <span className="lf-num">{findings}</span> {findings === 1 ? 'finding' : 'findings'}
                {procedures ? (
                  <>
                    {' '}
                    and <span className="lf-num">{procedures}</span> {procedures === 1 ? 'procedure alert' : 'procedure alerts'} (a reassessment overdue
                    or an escalation)
                  </>
                ) : null}
                . Each warning is acknowledged on its own line.
              </p>
              {overdue ? (
                <p className="lf-pop-note" data-overdue-rule="">
                  <Chip kind="design choice" /> A reassessment is overdue when no outcome is logged within the case&apos;s own reassessment
                  interval of its start, or of its opening if it has not started.
                </p>
              ) : null}
              <ul className="lf-ann-list">
                {groups.map((g) => (
                  <GroupItem key={g.id} g={g} onAck={acknowledge} />
                ))}
              </ul>
            </>
          )}
          {bulk.length > 1 ? (
            <button type="button" className="lf-btn" data-variant="secondary" onClick={() => acknowledge(bulk.flatMap(lineAckIds))}>
              {`Acknowledge cautions and advisories (${bulk.length})`}
            </button>
          ) : null}
        </div>
      </details>
      <div className="sr-only" role="status" aria-live="polite">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {assertive?.text ?? ''}
      </div>
    </>
  )
}
