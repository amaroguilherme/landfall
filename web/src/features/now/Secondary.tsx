// Section 3 of the hero: the other open cases (renal in WATCH with its tripwire countdown, sleep
// ACTING), a 4-crew status strip (worst annunciated severity per crewmember, icon + text) and the
// environment. Everything is read from useCases / useEvaluation / useComms output.
import type { CaseView } from '../../app/caseTimeline'
import type { CommsStatus } from '../../app/comms'
import { formatCountdown } from '../../app/comms'
import { useMetMinute, useMission } from '../../app/mission'
import type { Environment } from '../../app/scenario'
import { crewMember } from '../../app/vocab'
import { EmptyState, FreshnessChip, MetTime, SeverityBadge, SimulatedMarker } from '../../ui'
import { countermeasureTitle } from './model'
import type { CrewStatus } from './model'
import { CaseStatusTag } from './parts'

function Reassess({ at }: { at: number }) {
  const t = useMetMinute()
  const left = at - t
  return left > 0 ? (
    <>
      reassess in <span className="lf-num">{formatCountdown(left)}</span> (<MetTime t={at} label />)
    </>
  ) : (
    <>
      reassessment due since <MetTime t={at} label />
    </>
  )
}

function caseLine(v: CaseView) {
  const s = v.state
  const cm = countermeasureTitle(v.def, s.countermeasure_id)
  const steps = v.def.procedure?.length ?? 0
  if (s.status === 'watch' && s.reassess_at !== null) {
    return (
      <>
        Tripwire armed · <Reassess at={s.reassess_at} />
      </>
    )
  }
  if (s.status === 'acting') {
    return (
      <>
        {cm ?? 'Countermeasure selected'} · <span className="lf-num">{s.steps_done.length}</span> of <span className="lf-num">{steps}</span> steps
        logged
      </>
    )
  }
  if (s.status === 'escalated') return <>Tripwire met: queued for flight-surgeon review</>
  return <>Opened {s.opened_at !== null ? <MetTime t={s.opened_at} label /> : null}; no action logged yet</>
}

export function OtherCases({ views, status, error }: { views: CaseView[]; status: string; error: string | null }) {
  return (
    <section className="now-side-block" aria-labelledby="now-other-h">
      <h3 id="now-other-h" className="now-side-h">
        Other open cases <SimulatedMarker variant="inline" />
      </h3>
      {status === 'error' ? (
        <p className="now-missing">Cases unavailable: {error}</p>
      ) : views.length === 0 ? (
        <p className="now-side-empty">{status === 'loading' ? 'Reading the scenario.' : 'None.'}</p>
      ) : (
        <ul className="now-open-list">
          {views.map((v) => (
            <li key={v.key}>
              <div className="now-open-row">
                <a href={`#/case/${v.caseId}?crew=${v.crewId}`} className="now-open-title">
                  <span className="now-open-crew">{v.crewId}</span> {v.def.title ?? v.caseId}
                </a>
                <CaseStatusTag status={v.state.status} />
              </div>
              <p className="now-open-line">{caseLine(v)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function CrewStrip({ crew, status, error, sharedLabel }: { crew: CrewStatus[]; status: string; error: string | null; sharedLabel: string | null }) {
  const { setCrew } = useMission()
  return (
    <section className="now-side-block" aria-labelledby="now-crew-h">
      <h3 id="now-crew-h" className="now-side-h">
        Crew <SimulatedMarker variant="inline" />
      </h3>
      {status === 'error' ? (
        <EmptyState kind="error" title="Crew findings unavailable" headingLevel={3}>
          <p>{error}</p>
        </EmptyState>
      ) : (
        <ul className="now-crew">
          {crew.map((c) => {
            const m = crewMember(c.crewId)
            const own = c.top && c.top.crew_id !== 'ALL'
            const why = c.top ? (own ? c.top.title : `Crew-wide: ${sharedLabel ?? c.top.title}`) : status === 'ready' ? 'No annunciated finding' : ''
            return (
              <li key={c.crewId}>
                <a href="#/body" className="now-crew-id" onClick={() => setCrew(c.crewId)} title={`${c.crewId} · ${m.role}: open the body map`}>
                  <span className="lf-num">{c.crewId}</span> <span className="now-crew-role">{m.short}</span>
                  <span className="sr-only"> ({m.role})</span>
                </a>
                {status === 'ready' ? (
                  <SeverityBadge severity={c.severity} size="sm" label={c.top ? undefined : 'Nominal'} />
                ) : (
                  <span className="now-side-empty">…</span>
                )}
                <span className="now-crew-why" title={c.top?.title}>
                  {why}
                  {c.count > 1 ? (
                    <span className="now-crew-more">
                      {' '}
                      · <span className="lf-num">{c.count - 1}</span> more
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function EnvBlock({ env, comms }: { env: Environment; comms: CommsStatus }) {
  return (
    <section className="now-side-block" aria-labelledby="now-env-h">
      <h3 id="now-env-h" className="now-side-h">
        Environment
      </h3>
      <p className="now-env">
        <span className="now-env-chip">{env.label}</span>
      </p>
      <p className="now-env-line">
        {env.noaa_scale_available
          ? 'Proton flux judged on the NOAA S-scale (GOES, near Earth).'
          : 'No NOAA alert reaches this crew: the case runs on the onboard monitor.'}{' '}
        {comms.basis === 'snapshot'
          ? comms.env.comms.conjunction
            ? 'Light time and conjunction windows from the JPL Horizons ephemeris; the mission calendar is fictional, the window is real.'
            : 'Light time from the JPL Horizons ephemeris.'
          : comms.basis === 'static'
            ? 'Light time from the environment envelope.'
            : null}
      </p>
      {comms.snapshotId ? (
        <FreshnessChip meta={comms.snapshot} status={comms.snapshotStatus ?? 'loading'} id={comms.snapshotId} source={comms.snapshot?.source} compact />
      ) : null}
      <p className="now-side-empty">Change it in the mission bar (ENV).</p>
    </section>
  )
}
