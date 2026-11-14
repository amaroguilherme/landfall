// Annunciator: active Emergency / Warning / Caution / Advisory counts, the unacknowledged count
// and the queue (NASA-STD-3001 Vol 2 Appendix F F.6.4 a-d), with aria-live announcements.
import { useEffect, useId, useRef, useState } from 'react'
import { SeverityIcon } from '../ui'
import { SeverityBadge } from '../ui'
import { selectAlerts, selectAnnunciator, useMission } from './mission'
import type { AnnunciatorCounts } from './mission'
import type { Severity } from './vocab'
import { useDismissableDetails } from './useDismissableDetails'

const E_NOTE = "LANDFALL never raises Emergency-class alarms; that is the vehicle C&W system's job."

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

export function Annunciator() {
  const { state, acknowledge } = useMission()
  const counts = selectAnnunciator(state)
  const alerts = selectAlerts(state)
  const ref = useRef<HTMLDetailsElement>(null)
  useDismissableDetails(ref)
  const descId = useId()

  // aria-live: polite summary on change, assertive when the warning count rises.
  const [polite, setPolite] = useState('')
  const [assertive, setAssertive] = useState('')
  const prev = useRef<AnnunciatorCounts | null>(null)
  useEffect(() => {
    const p = prev.current
    prev.current = counts
    if (!counts.evaluated) return
    if (p && p.evaluated && p.warning === counts.warning && p.caution === counts.caution && p.advisory === counts.advisory) return
    setPolite(summarise(counts))
    if (p && counts.warning > p.warning) {
      const newest = alerts.find((a) => a.severity === 'warning')
      setAssertive(`New warning${newest ? `: ${newest.title}` : ''}.`)
    }
  }, [counts, alerts])

  const unacked = alerts.filter((a) => !(a.id in state.acknowledged))

  return (
    <>
      <details className="lf-ann lf-pop" ref={ref}>
        <summary aria-describedby={descId}>
          <span className="sr-only">Alert annunciator: </span>
          <Cell letter="E" severity="emergency" count={0} evaluated noun="emergency" title={E_NOTE} />
          <Cell letter="W" severity="warning" count={counts.warning} evaluated={counts.evaluated} noun="warning" />
          <Cell letter="C" severity="caution" count={counts.caution} evaluated={counts.evaluated} noun="caution" />
          <Cell letter="A" severity="advisory" count={counts.advisory} evaluated={counts.evaluated} noun="advisory" />
          {counts.unacknowledged > 0 ? (
            <span className="lf-ann-new">
              <span className="lf-num">{counts.unacknowledged}</span> NEW
            </span>
          ) : null}
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
          ) : alerts.length === 0 ? (
            <p className="lf-pop-note">No active alerts.</p>
          ) : (
            <ul className="lf-ann-list">
              {alerts.map((a) => {
                const acked = a.id in state.acknowledged
                return (
                  <li key={a.id} data-acked={acked || undefined}>
                    <SeverityBadge severity={a.severity} size="sm" />
                    <span className="lf-ann-item">
                      {a.href ? <a href={a.href}>{a.title}</a> : a.title}
                      {a.crew_id ? <span className="lf-ann-crew"> · {a.crew_id === 'ALL' ? 'All crew' : a.crew_id}</span> : null}
                    </span>
                    {acked ? (
                      <span className="lf-ann-acked">Acknowledged</span>
                    ) : (
                      <button type="button" className="lf-linkbtn" onClick={() => acknowledge([a.id])}>
                        Acknowledge
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {unacked.length > 1 ? (
            <button type="button" className="lf-btn" data-variant="secondary" onClick={() => acknowledge(unacked.map((a) => a.id))}>
              Acknowledge all ({unacked.length})
            </button>
          ) : null}
        </div>
      </details>
      <div className="sr-only" role="status" aria-live="polite">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {assertive}
      </div>
    </>
  )
}
