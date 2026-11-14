// #/ - NOW, the hero. Mars surface, MET 0412/14:20, inside a REAL solar conjunction window (JPL
// Horizons). A replay of the REAL October 1989 GOES-7 proton event crosses the S3 level on the
// onboard monitor; Houston cannot be reached; LANDFALL opens the shelter case on onboard data
// alone and puts ONE action on screen. Nothing here is precomputed or typed: comms come from
// useComms(), cases from useCases() (the engine's caseReduce fold), crew findings from
// useEvaluation(), the flux from the scenario index, the quote from cases.json, checked against
// the frozen standard. The "answered in" figure is this browser's measured latency.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatCommsLightTime, useComms } from '../../app/comms'
import { useSnapshot } from '../../app/data'
import { formatMet, sLevel } from '../../app/engine'
import { useMission } from '../../app/mission'
import { useCases, useEvaluation, useHeroTiming, useMarkHeroReady, useScenario } from '../../app/model'
import type { FeatureProps } from '../../app/router'
import { environment } from '../../app/scenario'
import { observationsFor } from '../../app/scenarioData'
import { CREW_IDS } from '../../app/vocab'
import type { Severity } from '../../app/vocab'
import { EmptyState, MetTime, SimulatedMarker, SEVERITY_LABEL } from '../../ui'
import { DualCounter } from './DualCounter'
import type { AnswerState, LandfallAnswer } from './DualCounter'
import {
  SPE_CASE_ID,
  crewStatuses,
  fluxWindow,
  openViewsOf,
  opsRule,
  otherOpenCases,
  pickView,
  primaryOf,
  sLevelDescriptor,
  sLevelLines,
  speDef,
} from './model'
import { RationaleQuote } from './Quote'
import { CrewStrip, EnvBlock, OtherCases } from './Secondary'
import { SpeCaseCard } from './SpeCaseCard'
import './now.css'

/** Sparkline window: the last 8 h of monitor readings that exist at the clock (design choice). */
const SPARK_WINDOW_S = 8 * 3600

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0)

/** Whether the first hero mount of this page load waited for the scenario (a cold load). */
let firstMountCold: boolean | null = null

export default function Now(_props: FeatureProps) {
  const [mountAt] = useState(nowMs)
  const { state } = useMission()
  const scenario = useScenario()
  // useCases() must run here: the fold processes the SPE OPEN when the hero mounts (hero timing).
  const cases = useCases()
  const [coldMount] = useState(() => cases.status === 'loading')
  useEffect(() => {
    if (firstMountCold === null) firstMountCold = coldMount
  }, [coldMount])
  const pageCold = firstMountCold ?? coldMount
  const timing = useHeroTiming()
  const evaluation = useEvaluation()
  const comms = useComms()
  const replay = useSnapshot('swpc_spe_replay')
  const env = environment(state.envId)
  /** Mars: no NOAA alert reaches the crew, so the case runs on the onboard monitor (environments.json). */
  const onboard = env.noaa_scale_available === false
  const t = cases.t

  // ---- the SPE case, as the engine opened it ----
  const speViews = useMemo(() => openViewsOf(cases.cases, SPE_CASE_ID), [cases.cases])
  const spe = pickView(speViews, state.crewId)
  const opening = spe?.state.finding ?? null
  const rule = opsRule(opening?.rule_id ?? spe?.opening?.trigger.rule_id)
  const primary = spe ? primaryOf(spe.def) : null
  const threshold = typeof rule?.limit === 'number' ? rule.limit : null
  const variable = rule?.variable ?? null

  // ---- onboard monitor readings that exist at the clock ----
  const fluxObs = useMemo(
    () => (scenario.index && variable ? observationsFor(scenario.index, state.observations, null, variable) : []),
    [scenario.index, state.observations, variable],
  )
  const series = useMemo(() => fluxWindow(fluxObs, t, SPARK_WINDOW_S, threshold), [fluxObs, t, threshold])
  const level = series.last ? sLevel(series.last.value) : null
  const levelWord = sLevelDescriptor(level)
  const levels = useMemo(() => sLevelLines(), [])

  // ---- hero timing: mark once the primary countermeasure is painted ----
  const painted = !!spe && !!primary
  const openedHere = timing.speOpenProcessedAtMs !== null && timing.speOpenProcessedAtMs >= mountAt
  useMarkHeroReady(painted && openedHere)
  const answer: AnswerState =
    cases.status === 'error'
      ? { kind: 'unavailable', reason: `The case engine could not run in this build (${cases.error ?? 'unknown error'}).` }
      : timing.answerMs !== null
        ? {
            kind: 'measured',
            answerMs: timing.answerMs,
            pageMs: pageCold ? timing.heroReadyAtMs : null,
            firstLoad: timing.heroReadyAtMs !== null && timing.heroReadyAtMs >= mountAt,
          }
        : painted && !openedHere && timing.heroReadyAtMs === null
          ? { kind: 'not_measured', reason: 'Not measured on this visit: another view opened the case first. Reload this page to measure.' }
          : cases.status === 'ready' && !spe
            ? { kind: 'unavailable', reason: 'No shelter case is open, so there is nothing to time.' }
            : { kind: 'pending' }

  const severity = (opening?.severity as Severity | undefined) ?? null
  const landfall: LandfallAnswer = {
    action: primary?.title ?? null,
    severity,
    badge: severity ? `${level !== null ? `S${level} · ` : ''}${SEVERITY_LABEL[severity]}` : null,
    answer,
  }
  const commsSettled = comms.snapshotId === null || (comms.snapshotStatus !== 'loading' && (comms.basis !== 'fallback' || scenario.status !== 'loading'))
  const ready = cases.status !== 'loading' && commsSettled

  // ---- secondary row ----
  const others = useMemo(() => otherOpenCases(cases.cases, SPE_CASE_ID), [cases.cases])
  const crew = useMemo(() => crewStatuses(evaluation.evaluation?.alerts ?? []), [evaluation.evaluation])

  // ---- announcements (aria-live): each case that opens or changes status, once ----
  const announce = useAnnouncer(cases.status, speViews, others, primary?.title ?? null)

  const conj = comms.blocked && comms.reason === 'solar_conjunction'
  const houston = conj ? 'Houston is behind the Sun.' : comms.blocked ? 'Houston cannot be reached.' : `Houston is ${formatCommsLightTime(comms)} away.`
  const titleParts: ReactNode[] = spe
    ? [
        level !== null && level >= 1 ? (
          <>
            Solar radiation storm at the <span className="lf-num">S{level}</span> level.
          </>
        ) : (
          'Shelter case open.'
        ),
        houston,
      ]
    : [cases.status === 'loading' ? 'Now' : cases.status === 'error' ? 'Case engine unavailable on this build' : 'No case needs action right now']
  const speDefinition = spe?.def ?? speDef()

  return (
    <div className="now">
      <header className="now-head">
        <div className="now-head-title">
          <p className="lf-eyebrow">Now · {env.label}</p>
          <h1 className="now-h1">
            {titleParts.map((part, i) => (
              <span key={i} className="now-h1-part">
                {part}{' '}
              </span>
            ))}
          </h1>
        </div>
        <div className="now-head-side">
          {spe && spe.state.opened_at !== null ? (
            <p className="now-lede">
              {onboard ? 'The onboard monitor' : "NOAA's proton feed"} reached the{' '}
              <span className="lf-num">S{opening?.value != null ? sLevel(opening.value) : level}</span> level at{' '}
              <MetTime t={spe.state.opened_at} label />. LANDFALL opened the shelter case for{' '}
              {speViews.length === CREW_IDS.length ? 'every crewmember' : `${speViews.length} crew`}
              {onboard ? ' from onboard data alone' : ' on its own'}
              {comms.blocked ? '. Houston sees it when the link resumes.' : '. Houston is told too; nobody waits for the reply.'}
            </p>
          ) : (
            <p className="now-lede">
              {cases.status === 'loading'
                ? 'Reading the frozen scenario and the onboard monitor.'
                : cases.status === 'error'
                  ? 'The comms figures below are real; the case and crew findings need the engine (each panel says why).'
                  : 'The onboard monitor is below every case threshold.'}
            </p>
          )}
          <SimulatedMarker variant="inline">crew and clock · the flux is a replay of a real event</SimulatedMarker>
        </div>
      </header>

      <DualCounter comms={comms} ready={ready} landfall={landfall} />
      <RationaleQuote />

      {spe ? (
        <SpeCaseCard
          view={spe}
          openFor={speViews.length}
          finding={opening}
          rule={rule}
          level={level}
          levelWord={levelWord}
          series={series}
          window={{ from: t - SPARK_WINDOW_S, to: t }}
          levels={levels}
          replay={replay}
          seriesLabel={feedLabel(evaluation.evaluation?.ops.label ?? null) ?? (variable ? (scenario.index?.variables[variable]?.label ?? null) : null)}
          onboard={onboard}
          t={t}
        />
      ) : cases.status === 'error' ? (
        <EmptyState kind="error" title="The shelter case could not be evaluated">
          <p>{cases.error}</p>
        </EmptyState>
      ) : cases.status === 'loading' ? (
        <EmptyState kind="loading" title={speDefinition?.title ?? 'Solar particle event: shelter'}>
          <p>Reading the onboard monitor and the frozen scenario.</p>
        </EmptyState>
      ) : (
        <EmptyState kind="placeholder" title={speDefinition?.title ?? 'Solar particle event: shelter'}>
          <p>No trigger of this case is at caution or above at the scenario clock, so the case is not open.</p>
        </EmptyState>
      )}

      <section className="now-row" aria-labelledby="now-row-h">
        <h2 id="now-row-h" className="sr-only">
          Mission status
        </h2>
        <OtherCases views={others} status={cases.status} error={cases.error} />
        <CrewStrip
          crew={crew}
          status={evaluation.status}
          error={evaluation.error}
          sharedLabel={spe ? `${level !== null && level >= 1 ? `S${level} protons` : 'protons'}, shelter case` : null}
        />
        <EnvBlock env={env} comms={comms} />
      </section>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
    </div>
  )
}

/** The OPS feed's own label without its parenthetical scenario note (shown separately). */
function feedLabel(label: string | null): string | null {
  if (!label) return null
  const i = label.indexOf(' (')
  return i > 0 ? label.slice(0, i) : label
}

type View = ReturnType<typeof openViewsOf>[number]

/** Polite announcements: the open cases on first load, then every case that opens or changes status. */
function useAnnouncer(status: string, spe: View[], others: View[], action: string | null): string {
  const [msg, setMsg] = useState('')
  const last = useRef<Map<string, string> | null>(null)
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; status: string; crew: string[]; opened: number | null }>()
    for (const v of [...spe, ...others]) {
      const k = `${v.caseId}:${v.state.status}`
      const g = m.get(k) ?? { title: v.def.title ?? v.caseId, status: v.state.status, crew: [], opened: v.state.opened_at }
      g.crew.push(v.crewId)
      m.set(k, g)
    }
    return m
  }, [spe, others])
  const sig = [...groups.entries()].map(([k, g]) => `${k}=${g.crew.join(',')}`).join('|')
  useEffect(() => {
    if (status !== 'ready') return
    const prev = last.current
    const next = new Map<string, string>()
    for (const [k, g] of groups) next.set(k, g.crew.join(','))
    last.current = next
    const changed = [...groups.entries()].filter(([k, g]) => !prev || prev.get(k) !== g.crew.join(','))
    if (!changed.length) return
    const parts = changed.map(([, g]) => {
      const who = g.crew.length === CREW_IDS.length ? 'every crewmember' : g.crew.join(', ')
      return `${g.title}: ${g.status}, ${who}${g.opened !== null ? `, opened MET ${formatMet(g.opened)}` : ''}.`
    })
    const lead = prev ? 'Case update. ' : 'Open cases. '
    setMsg(lead + parts.join(' ') + (action && changed.some(([k]) => k.startsWith(`${SPE_CASE_ID}:`)) ? ` Primary action: ${action}.` : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, sig])
  return msg
}
