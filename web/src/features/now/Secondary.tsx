// Section 3 of the hero: the other open cases (renal in WATCH with its tripwire countdown, sleep
// ACTING, and under it the alert bar's own "Reassessment overdue since MET ..." when the case is past its
// reassessment interval; an instance opened by a single Tier B flag carries the engine's "Possibly chance: about 1 in N
// days ..." note (CaseView.chance, SPEC 7), and an opening the simulator did not script is also labelled
// as a chance flag, from sim_crew's own self_check), a 4-crew status strip (worst annunciated severity per crewmember, icon + text) and the
// environment. Everything is read from useCases / useEvaluation / useComms output.
import { stateTierOne } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import type { CommsStatus } from '../../app/comms'
import { formatCountdown, windowModelNote } from '../../app/comms'
import { useMetMinute, useMission } from '../../app/mission'
import { packetState } from '../../app/packet'
import { overdueOf } from '../../app/procedureAlerts'
import type { Environment } from '../../app/scenario'
import { crewMember } from '../../app/vocab'
import { EmptyState, FreshnessChip, MetTime, SeverityBadge, SeverityIcon, SimulatedMarker } from '../../ui'
import { countermeasureTitle, triggerLabel } from './model'
import type { CrewStatus, UnscriptedOpening } from './model'
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
    const pending = (s.spec.required_step_ids ?? []).filter(
      (id) => !s.steps_done.some((d) => d.step_id === id) && !(s.steps_declined ?? []).some((d) => d.step_id === id),
    ).length
    return (
      <>
        {cm ?? 'Countermeasure selected'} · <span className="lf-num">{s.steps_done.length}</span> of <span className="lf-num">{steps}</span> steps
        logged{pending > 0 ? (
          <>
            {' '}
            · <span className="lf-num">{pending}</span> required still open
          </>
        ) : null}
      </>
    )
  }
  if (s.status === 'escalated') {
    return (
      <>
        Escalated: tier 1, {stateTierOne(s)?.text ?? v.tier1.name}, now; tier 2, the flight surgeon, through the ground packet ({packetState(s).label})
      </>
    )
  }
  return <>Opened {s.opened_at !== null ? <MetTime t={s.opened_at} label /> : null}; no action logged yet</>
}

/**
 * A detected or acting case past its own reassessment interval: the alert bar's "Reassessment overdue since MET ..."
 * line, by the same rule (app/procedureAlerts overdueOf, a design choice), so the row and the bar never disagree.
 */
function OverdueLine({ v }: { v: CaseView }) {
  const t = useMetMinute()
  const o = overdueOf(v, t)
  if (!o) return null
  return (
    <p className="now-open-line" data-overdue="">
      <SeverityBadge severity="caution" label="Reassessment overdue" size="sm" />{' '}
      {/* "since MET ..." stays one unit: on a phone it wraps under the badge whole, never as a lone "since" */}
      <span style={{ whiteSpace: 'nowrap' }}>
        since <MetTime t={o.since} label />
      </span>
    </p>
  )
}

/** The simulator's own note on an opening it did not script (a chance flag of the simulator's noise), or null. */
function unscriptedNote(v: CaseView, list: readonly UnscriptedOpening[]) {
  const u = list.find((x) => x.crew_id === v.crewId && x.case_id === v.caseId)
  if (!u || v.state.opened_at === null || Math.floor(v.state.opened_at / 86_400) !== u.day) return null
  const what = triggerLabel(u.indicator_id) ?? 'one indicator'
  return (
    <p className="now-open-chance">
      Chance flag, not a scripted episode: {what} crossed its personal band on MET day <span className="lf-num">{u.day}</span>
      {u.scripted_opening_day !== null ? (
        <>
          , before the scripted episode (day <span className="lf-num">{u.scripted_opening_day}</span>)
        </>
      ) : (
        <>; no episode is scripted for {v.crewId}</>
      )}
      . The simulator's noise model makes flags like this (its own self-check).
    </p>
  )
}

export function OtherCases({
  views,
  status,
  error,
  unscripted = [],
}: {
  views: CaseView[]
  status: string
  error: string | null
  /** sim_crew self_check.unscripted_case_openings: openings the simulator did not script. */
  unscripted?: readonly UnscriptedOpening[]
}) {
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
              <OverdueLine v={v} />
              {v.chance ? (
                // SPEC 7 / S4: the engine's own label for an instance opened by a single Tier B flag (N from chanceRate)
                <p className="now-open-chance now-open-possibly">
                  <strong>{v.chance.text}.</strong> A single flag: a re-measure checks it.
                </p>
              ) : null}
              {unscriptedNote(v, unscripted)}
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
            const more = c.count - c.items.length
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
                <span className="now-crew-why">
                  {c.items.length === 0 ? (status === 'ready' ? 'No annunciated finding' : '') : null}
                  {c.items.map((a) => (
                    <span key={a.id} className="now-crew-item" data-severity={a.severity} title={a.detail ?? a.title}>
                      <SeverityIcon severity={a.severity} size={11} />
                      <span className="sr-only">{a.severity}: </span>
                      {a.crew_id === 'ALL' ? `Crew-wide: ${sharedLabel ?? a.title}` : a.title}
                    </span>
                  ))}
                  {more > 0 ? (
                    <span className="now-crew-more">
                      + <span className="lf-num">{more}</span> more
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
          : 'No NOAA alert reaches this crew: the case reads an external space-weather monitor in Mars orbit, relayed to the habitat with no Earth link.'}{' '}
        {comms.basis === 'snapshot'
          ? comms.env.comms.conjunction
            ? `Light time from the JPL Horizons ephemeris; the conjunction window is ${windowModelNote(comms.windowModel)}. The mission calendar is fictional.`
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
