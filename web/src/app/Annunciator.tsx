// Annunciator: active Emergency / Warning / Caution / Advisory counts, the unacknowledged count
// and the queue (NASA-STD-3001 Vol 2 Appendix F F.6.4 a-d), with aria-live announcements.
// D16: the queue is grouped by case and crewmember (one sleep episode is one line, not four), the
// counts count those lines, and a Warning is acknowledged on its own line, never by "acknowledge all".
// The E and NEW counts stay visible on every viewport (F.4.2 f; shell.css keeps them on phones).
import { useEffect, useId, useRef, useState } from 'react'
import { SeverityBadge, SeverityIcon } from '../ui'
import { selectAlertGroups, selectAnnunciator, useMission } from './mission'
import type { AlertGroup, AnnunciatorCounts } from './mission'
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

/** An action text that starts with its own label ("EVA assignment not cleared: this ...") shown under that label. */
function actionLine(text: string, title: string): string {
  if (!text.startsWith(`${title}: `)) return text
  const rest = text.slice(title.length + 2)
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

function GroupItem({ g, onAck }: { g: AlertGroup; onAck: (ids: string[]) => void }) {
  const many = g.alerts.length > 1
  const single = g.alerts[0]
  return (
    <li data-acked={g.acknowledged || undefined} data-severity={g.severity}>
      <SeverityBadge severity={g.severity} size="sm" />
      <span className="lf-ann-item">
        {g.href ? <a href={g.href}>{g.title}</a> : g.title}
        {g.crew_id ? <span className="lf-ann-crew"> · {crewText(g.crew_id)}</span> : null}
        {many ? (
          <>
            <span className="lf-ann-crew">
              {' '}
              · <span className="lf-num">{g.alerts.length}</span> findings
            </span>
            <ul className="lf-ann-members">
              {g.alerts.map((a) => (
                <li key={a.id}>
                  <SeverityIcon severity={a.severity} size={10} />
                  <span>{a.title}</span>
                </li>
              ))}
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
          onClick={() => onAck(g.alerts.map((a) => a.id))}
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

  // aria-live: polite summary when the counts change; assertive when a warning line appears. A warning is
  // keyed by its line AND its findings, so an environment switch that swaps the rule behind the same line
  // (Mars-orbit monitor -> NOAA S3) clears the stale text and names the current warning; when the warning
  // is gone the assertive text is cleared, so a screen reader never finds a stale "New warning".
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState<{ key: string; text: string } | null>(null)
  const prev = useRef<{ counts: AnnunciatorCounts; warnings: Set<string> } | null>(null)
  const warningKeys = groups
    .filter((g) => g.severity === 'warning' || g.severity === 'emergency')
    .map((g) => `${g.id}=${g.alerts.map((a) => a.id).join(',')}`)
  const warningSig = warningKeys.join('|')
  useEffect(() => {
    const p = prev.current
    const now = new Set(warningSig ? warningSig.split('|') : [])
    prev.current = { counts, warnings: now }
    if (!counts.evaluated) return
    setAssertive((a) => (a && !now.has(a.key) ? null : a))
    const same = p && p.counts.evaluated && p.counts.warning === counts.warning && p.counts.caution === counts.caution && p.counts.advisory === counts.advisory
    if (!same) setPolite(summarise(counts))
    const fresh = p ? [...now].find((k) => !p.warnings.has(k)) : undefined
    if (fresh) {
      const g = groups.find((x) => x.id === fresh.slice(0, fresh.indexOf('=')))
      setAssertive({ key: fresh, text: `New warning${g ? `: ${g.title}${g.crew_id ? `, ${crewText(g.crew_id)}` : ''}` : ''}.` })
    }
    // groups is read only to name the fresh warning; warningSig covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts.evaluated, counts.warning, counts.caution, counts.advisory, warningSig])

  // "Acknowledge all" covers cautions and advisories only: each warning is acknowledged on its own line.
  const bulk = groups.filter((g) => !g.acknowledged && g.severity !== 'warning' && g.severity !== 'emergency')
  const findings = groups.reduce((n, g) => n + g.alerts.length, 0)

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
                <span className="lf-num">{findings}</span> {findings === 1 ? 'finding' : 'findings'}. Each warning is acknowledged on its own line.
              </p>
              <ul className="lf-ann-list">
                {groups.map((g) => (
                  <GroupItem key={g.id} g={g} onAck={acknowledge} />
                ))}
              </ul>
            </>
          )}
          {bulk.length > 1 ? (
            <button type="button" className="lf-btn" data-variant="secondary" onClick={() => acknowledge(bulk.flatMap((g) => g.alerts.map((a) => a.id)))}>
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
