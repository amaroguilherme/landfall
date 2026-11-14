// Persistent mission bar: the "common dedicated area for key information visible at all times"
// of NASA-STD-3001 Vol 2 Appendix F F.4.2 f (time, alerts, communication status AOS / LOS),
// topped by a hatched mode strip because sim mode must be visually distinct (F.4.2 j).
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { AntennaIcon, FreshnessChip, MetTime, PauseIcon, PlayIcon, ResetIcon, SunIcon } from '../ui'
import { formatCommsLightTime, formatCountdown, formatEarliestReply, useComms } from './comms'
import type { CommsStatus } from './comms'
import { formatUtc } from './data'
import { ENVIRONMENTS, ENVIRONMENTS_SOURCE, MET_NOW_S } from './scenario'
import { formatMet } from './engine'
import { useMetClock, useMission } from './mission'
import { Annunciator } from './Annunciator'
import { useDismissableDetails } from './useDismissableDetails'
import { CREW, CREW_IDS, ENV_IDS } from './vocab'
import type { CrewId, EnvId } from './vocab'

function MetClock() {
  const { metNow, running, pause, resume } = useMetClock()
  const { resetScenario } = useMission()
  const resetLabel = `Reset the scenario to MET ${formatMet(MET_NOW_S)} (drops your entries and case actions)`
  return (
    <div className="lf-mb-met">
      <span className="lf-mb-label" aria-hidden="true">
        MET
      </span>
      <span className="sr-only">Mission elapsed time</span>
      <MetTime t={metNow} />
      <button
        type="button"
        className="lf-iconbtn"
        onClick={running ? pause : resume}
        aria-label={running ? 'Pause mission clock' : 'Resume mission clock'}
        title={running ? 'Pause mission clock' : 'Resume mission clock'}
      >
        {running ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
      </button>
      <button type="button" className="lf-iconbtn lf-mb-reset" onClick={resetScenario} aria-label={resetLabel} title={resetLabel}>
        <ResetIcon size={12} />
      </button>
      {!running ? <span className="lf-mb-paused">PAUSED</span> : null}
    </div>
  )
}

function EnvSelector() {
  const { state, setEnv } = useMission()
  return (
    <label className="lf-mb-field lf-mb-env">
      <span className="lf-mb-label">ENV</span>
      <select
        value={state.envId}
        onChange={(e) => setEnv(e.target.value as EnvId)}
        title={ENVIRONMENTS_SOURCE === 'rules' ? 'From engine/rules/environments.json' : 'From engine/SPEC.md 3.1 (rules file not in this build)'}
      >
        {ENV_IDS.map((id) => (
          <option key={id} value={id}>
            {ENVIRONMENTS.find((e) => e.id === id)?.label ?? id}
          </option>
        ))}
      </select>
    </label>
  )
}

function CrewSelector() {
  const { state, setCrew } = useMission()
  return (
    <label className="lf-mb-field lf-mb-crew">
      <span className="lf-mb-label">CREW</span>
      <select value={state.crewId} onChange={(e) => setCrew(e.target.value as CrewId)}>
        {CREW_IDS.map((id) => {
          const c = CREW.find((m) => m.id === id)!
          return (
            <option key={id} value={id}>
              {id} · {c.role}
            </option>
          )
        })}
      </select>
    </label>
  )
}

function commsSourceNote(c: CommsStatus): string {
  if (c.basis === 'snapshot') {
    return c.env.comms.conjunction
      ? 'Light time: Earth-Mars range from the frozen JPL Horizons ephemeris divided by c. Conjunction window: the same snapshot. The mission calendar is fictional; the window is real.'
      : 'Light time: Earth-Moon range from the frozen JPL Horizons ephemeris divided by c (daily samples, interpolated). The Moon is never behind the Sun, so there is no conjunction.'
  }
  if (c.basis === 'static') return 'Light time is a constant of this environment (see its chip in Provenance).'
  return c.snapshotStatus === 'ready'
    ? 'Ephemeris present but the scenario calendar (sim_crew) is not: conjunction from the SPEC scenario; light time unknown.'
    : 'Ephemeris snapshot not in this build: conjunction from the SPEC scenario; light time unknown.'
}

function CommsStatusCell() {
  const { metNow } = useMetClock()
  const c = useComms()
  const ref = useRef<HTMLDetailsElement>(null)
  useDismissableDetails(ref)
  const unknownOwlt = c.one_way_s === null
  return (
    <details className="lf-comms lf-pop" ref={ref} data-link={c.link}>
      <summary>
        <span className="sr-only">Communications status: </span>
        <AntennaIcon blocked={c.blocked} size={14} />
        <span className="lf-comms-link">{c.link}</span>
        {c.blocked && c.reason === 'solar_conjunction' ? (
          <span className="lf-comms-conj">
            <SunIcon size={12} />
            SOLAR CONJUNCTION
          </span>
        ) : null}
        <span className="lf-comms-owlt">
          <span className="lf-mb-label">OWLT</span>
          <span className="lf-num" data-missing={unknownOwlt || undefined}>
            {formatCommsLightTime(c)}
          </span>
          {unknownOwlt ? <span className="sr-only">one-way light time unknown</span> : null}
        </span>
      </summary>
      <div className="lf-pop-body" role="region" aria-label="Communications detail">
        <p className="lf-pop-note">
          <strong>{c.link === 'LOS' ? 'Loss of signal.' : 'Acquisition of signal.'}</strong>{' '}
          {c.blocked
            ? 'Houston cannot be reached. LANDFALL evaluates onboard and queues the ground packet.'
            : 'Ground link available; every LANDFALL evaluation still runs onboard.'}
        </p>
        <dl className="lf-dl">
          <dt>One-way light time</dt>
          <dd>
            <span className="lf-num" data-missing={unknownOwlt || undefined}>
              {formatCommsLightTime(c)}
            </span>
          </dd>
          <dt>Round trip</dt>
          <dd>
            <span className="lf-num" data-missing={unknownOwlt || undefined}>
              {formatCommsLightTime(c, true)}
            </span>
          </dd>
          {c.window ? (
            <>
              <dt>Conjunction</dt>
              <dd>
                <span className="lf-num">{formatUtc(c.window.startUtc)}</span> to{' '}
                <span className="lf-num">{formatUtc(c.window.stopUtc)}</span>
              </dd>
              <dt>Link resumes</dt>
              <dd>
                <MetTime t={c.resumes_at ?? c.window.stop} label /> (in{' '}
                <span className="lf-num">{formatCountdown((c.resumes_at ?? c.window.stop) - metNow)}</span>)
              </dd>
            </>
          ) : null}
          <dt>Earliest reply</dt>
          <dd>
            <span className="lf-num" data-missing={c.earliest_reply_s === null || undefined}>
              {formatEarliestReply(c)}
            </span>{' '}
            (zero ground time)
          </dd>
          <dt>Environment</dt>
          <dd>{c.env.label}</dd>
          {c.metEpochUtc ? (
            <>
              <dt>MET epoch</dt>
              <dd>
                <span className="lf-num">{formatUtc(c.metEpochUtc)}</span> (scenario)
              </dd>
            </>
          ) : null}
        </dl>
        <p className="lf-pop-note">{commsSourceNote(c)}</p>
        {c.snapshotId ? (
          <FreshnessChip meta={c.snapshot} status={c.snapshotStatus ?? 'loading'} id={c.snapshotId} source={c.snapshot?.source} />
        ) : null}
      </div>
    </details>
  )
}

/** Publish the bar's real height as --lf-missionbar-offset so scroll-padding-top tracks it on every viewport. */
function useBarHeightVar(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const set = () => root.style.setProperty('--lf-missionbar-offset', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    set()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', set)
      return () => window.removeEventListener('resize', set)
    }
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
}

export function MissionBar() {
  const ref = useRef<HTMLElement>(null)
  useBarHeightVar(ref)
  return (
    <header className="lf-missionbar" ref={ref}>
      <div className="lf-modestrip" role="note">
        <span className="lf-modestrip-tag">SIMULATED CREW DATA</span>
        <span className="lf-modestrip-text">Crew physiology is simulated (seeded, labeled). NASA and NOAA data are real, frozen at build.</span>
      </div>
      <div className="lf-mb-inner">
        <div className="lf-mb-id">
          <a className="lf-wordmark" href="#/" aria-label="LANDFALL, go to Now">
            LANDFALL
          </a>
          <MetClock />
        </div>
        <div className="lf-mb-ctx">
          <EnvSelector />
          <CrewSelector />
        </div>
        <CommsStatusCell />
        <div className="lf-mb-ann">
          <Annunciator />
        </div>
      </div>
    </header>
  )
}
