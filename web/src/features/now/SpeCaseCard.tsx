// Section 2 of the hero: the SPE shelter case as LANDFALL opened it. The ONE primary
// countermeasure (cases.json), the trigger's category and chips, the next guided step (magenta),
// and the onboard-monitor sparkline with the replay label (F.5.8 b: historical, not live).
import { Suspense, lazy } from 'react'
import type { CaseView } from '../../app/caseTimeline'
import type { SnapshotState } from '../../app/data'
import { fmtNum, formatMet } from '../../app/engine'
import type { Finding, Rule } from '../../app/engine'
import { CREW_IDS } from '../../app/vocab'
import type { Severity } from '../../app/vocab'
import { ButtonLink, CategoryBadge, Chip, FreshnessChip, MetTime, Num, ReqId, SeverityBadge, SimulatedMarker, SEVERITY_LABEL, formatNumber } from '../../ui'
import { CASE_STATUS_LABEL, primaryOf, sourceRuleOf } from './model'
import type { FluxSeries } from './model'
import { CaseStatusTag } from './parts'

const FluxSpark = lazy(() => import('./FluxSpark'))
const SPARK_H = 150

export interface SpeCardProps {
  view: CaseView
  /** How many crewmembers have this case open. */
  openFor: number
  finding: Finding | null
  rule: Rule | null
  level: number | null
  levelWord: string | null
  series: FluxSeries
  window: { from: number; to: number }
  levels: Array<{ level: number; limit: number }>
  replay: SnapshotState
  /** Label of the proton feed (the OPS feed's, else sim_crew's variable label). */
  seriesLabel: string | null
  /** True at Mars: the habitat monitor, not NOAA, is the source of the reading. */
  onboard: boolean
  t: number
}

/** ">=" as the mathematical sign, for display. */
function prettyOps(s: string): string {
  return s.replace(/>=/g, '≥').replace(/<=/g, '≤')
}

interface ReplayData {
  replay_of?: string
  satellite?: string
}

export function SpeCaseCard(p: SpeCardProps) {
  const { view, finding, rule } = p
  const def = view.def
  const primary = primaryOf(def)
  const severity: Severity = (finding?.severity as Severity) ?? 'caution'
  const source = sourceRuleOf(rule)
  const steps = def.procedure ?? []
  const done = new Set(view.state.steps_done.map((s) => s.step_id))
  const nextIndex = steps.findIndex((s) => !done.has(s.id))
  const next = nextIndex >= 0 ? steps[nextIndex] : null
  const openedAt = view.state.opened_at
  const primarySource = primary?.source as { requirement_id?: string; verbatim?: string } | null
  const ruleId = view.opening?.trigger.rule_id ?? finding?.rule_id ?? null
  const last = p.series.last
  const rd = (p.replay.data ?? null) as ReplayData | null
  const threshold = typeof rule?.limit === 'number' ? rule.limit : null

  return (
    <article className="now-case lf-card" data-severity={severity} aria-labelledby="now-case-h">
      <header className="now-case-head">
        <div className="now-case-id">
          <p className="lf-eyebrow">
            Case · {p.openFor === CREW_IDS.length ? 'every crewmember' : `${p.openFor} crew`} ·{' '}
            {openedAt !== null ? (
              <>
                opened <MetTime t={openedAt} label />
              </>
            ) : (
              'open'
            )}
          </p>
          <h2 id="now-case-h" className="now-case-title">
            {def.title ?? def.id}
          </h2>
        </div>
        <div className="now-case-badges">
          <SeverityBadge severity={severity} label={p.level !== null ? `S${p.level} · ${SEVERITY_LABEL[severity]}` : undefined} />
          <CaseStatusTag status={view.state.status} />
          <SimulatedMarker variant="inline" />
        </div>
      </header>

      <div className="now-case-body">
        <div className="now-case-main">
          {primary ? (
            <div className="now-primary">
              <p className="now-primary-label">Primary action</p>
              <p className="now-primary-title" data-hero-action="">
                {primary.title}
              </p>
              {primarySource?.verbatim ? (
                <p className="now-primary-why">
                  <Chip kind={primary.chip} /> {primarySource.requirement_id ? <ReqId id={primarySource.requirement_id} /> : null}{' '}
                  <q>{primarySource.verbatim}</q>
                </p>
              ) : null}
            </div>
          ) : null}

          {next ? (
            <p className="now-step">
              <span className="now-step-tag">
                Step <span className="lf-num">{nextIndex + 1}</span> of <span className="lf-num">{steps.length}</span>
              </span>
              <span>{next.text}</span>
            </p>
          ) : null}

          {/* Why it opened: category, the threshold's basis and the reading, in plain English. */}
          <p className="now-case-basis">
            <CategoryBadge category={finding?.category ?? 'OPS'} long />{' '}
            {finding && finding.value !== null ? (
              <>
                {p.onboard ? 'The onboard monitor read' : 'The flux read'} <Num value={finding.value} unit={finding.unit} /> at{' '}
                <MetTime t={finding.t ?? openedAt ?? p.t} />, at or above{' '}
                <Num value={threshold} unit={finding.unit} />
                {p.levelWord ? ` (S${source?.s_level ?? p.level ?? ''} ${p.levelWord})` : null}.
              </>
            ) : null}{' '}
            {source ? (
              <>
                Threshold <Chip kind={source.chip} />, applied to the onboard monitor <Chip kind={rule?.chip} />.
              </>
            ) : (
              <Chip kind={rule?.chip ?? finding?.chip} />
            )}
          </p>

          <div className="now-case-actions">
            <ButtonLink href={`#/case/${def.id}`}>Open case</ButtonLink>
            {ruleId ? (
              <ButtonLink variant="secondary" href={`#/provenance?id=${encodeURIComponent(ruleId)}`}>
                Why this fired
              </ButtonLink>
            ) : null}
            <span className="now-case-status-note">
              {CASE_STATUS_LABEL[view.state.status]}: {view.state.status === 'detected' ? 'no crew action logged yet' : 'see the case log'}
            </span>
          </div>
        </div>

        <figure className="now-spark">
          <figcaption className="now-spark-head">
            <span className="now-spark-title">
              {prettyOps(p.seriesLabel ?? rule?.label ?? 'Onboard monitor')} · last <span className="lf-num">{Math.round((p.window.to - p.window.from) / 3600)}</span> h
            </span>
            <span className="now-replay-tag">Historical replay · not live</span>
          </figcaption>
          <Suspense fallback={<div className="now-spark-canvas now-spark-wait" style={{ height: SPARK_H }} />}>
            <FluxSpark
              series={p.series}
              from={p.window.from}
              to={p.window.to}
              threshold={threshold}
              thresholdLabel={threshold !== null ? `S${rule?.s_level ?? source?.s_level ?? ''} · ${formatNumber(threshold)} ${finding?.unit ?? rule?.unit ?? ''}` : null}
              levels={p.levels}
              openedAt={openedAt}
              severity={severity}
              height={SPARK_H}
            />
          </Suspense>
          <p className="sr-only">
            Chart: onboard proton flux from MET {formatMet(p.window.from)} to {formatMet(p.window.to)} on a log scale
            {last ? `, latest ${fmtNum(last.value, 1)} ${last.unit} at MET ${formatMet(last.t)}` : ''}
            {threshold !== null ? `; the case threshold is ${formatNumber(threshold)} ${rule?.unit ?? ''}` : ''}
            {openedAt !== null ? `; LANDFALL opened the case at MET ${formatMet(openedAt)}` : ''}.
          </p>
          <p className="now-spark-note">
            Replay of a real event{rd?.replay_of ? `: ${rd.replay_of}` : ''}
            {p.replay.snapshot?.source.publisher ? `, from ${p.replay.snapshot.source.publisher}` : ''}. Time-shifted onto the scenario clock
            {p.onboard ? ' and read as the habitat monitor (a scenario assumption).' : ' and used as the GOES reading of the scenario.'}
            {last ? (
              <>
                {' '}
                Latest <Num value={last.value} unit={last.unit} /> at <MetTime t={last.t} />.
              </>
            ) : null}
          </p>
          <div className="now-spark-fresh">
            <FreshnessChip meta={p.replay.snapshot} status={p.replay.status} id="swpc_spe_replay" compact />
          </div>
        </figure>
      </div>
    </article>
  )
}
