// #/ - NOW, the hero. Mars surface, MET 412/14:20, inside a solar conjunction window MODELLED from JPL
// Horizons geometry (edges fitted to NASA/JPL's published command moratoria). A replay of the real
// October 1989 GOES-7 proton event, read as an external space-weather monitor in Mars orbit (D3), crosses
// the S3 level. The vehicle's radiation monitoring system raises the alarm ([V2 6164]); LANDFALL opens the
// shelter health case that follows and puts ONE action on screen first, then shows how long Houston would
// take. Nothing here is precomputed or typed: comms come from useComms(), cases from useCases() (the
// engine's caseReduce fold), crew findings from useEvaluation(), the flux from the scenario index, the
// quote from cases.json (checked against the frozen standard). The "guidance on screen" figure is this
// browser's measured latency, measured on every visit (and on demand), so a deep link never shows a dash.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatCommsLightTime, useComms } from '../../app/comms'
import { useSnapshot } from '../../app/data'
import { formatMet, sLevel } from '../../app/engine'
import { useMission } from '../../app/mission'
import { useCases, useEvaluation, useHeroTiming, useMarkHeroReady, useScenario } from '../../app/model'
import { autonomyText, packetState } from '../../app/packet'
import type { FeatureProps } from '../../app/router'
import { environment } from '../../app/scenario'
import { observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex } from '../../app/scenarioData'
import { CREW_IDS } from '../../app/vocab'
import type { CrewId, EnvId, Observation, Severity } from '../../app/vocab'
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
  runOnboard,
  sLevelDescriptor,
  sLevelLines,
  speDef,
  unscriptedOpenings,
} from './model'
import type { OnboardRun } from './model'
import { RationaleQuote } from './Quote'
import { CrewStrip, EnvBlock, OtherCases } from './Secondary'
import { SpeCaseCard } from './SpeCaseCard'
import './now.css'

/** Sparkline window: the last 8 h of monitor readings that exist at the clock (design choice). */
const SPARK_WINDOW_S = 8 * 3600

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0)

/** Whether the first hero mount of this page load waited for the scenario (a cold load). */
let firstMountCold: boolean | null = null

interface MeasureInput {
  index: ScenarioIndex | null
  runtime: readonly Observation[]
  envId: EnvId
  t: number
  crewId: CrewId
}

/**
 * The hero's latency, measured on this visit and again on demand: run the onboard path on the engine
 * (runOnboard), paint the action it yields, and read the clock after the browser painted (double rAF).
 * Re-runs when the environment or the crewmember changes, and when `remeasure()` is called; never on the
 * minute tick (the number would churn).
 */
function useOnboardMeasure(input: MeasureInput): { run: OnboardRun | null; answerMs: number | null; remeasure: () => void } {
  const [nonce, setNonce] = useState(0)
  const latest = useRef(input)
  latest.current = input
  const key = `${input.index ? 'ready' : 'none'}|${input.envId}|${input.crewId}|${nonce}`
  const run = useMemo(() => {
    const x = latest.current
    return x.index ? runOnboard(x.index, x.runtime, x.envId, x.t, x.crewId) : null
    // Keyed on `key` only: the clock and runtime entries are read at run time, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const [painted, setPainted] = useState<{ key: string; ms: number } | null>(null)
  useEffect(() => {
    if (!run?.opened) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const ms = nowMs() - run.startedAt
        if (typeof document !== 'undefined') document.documentElement.dataset.onboardAnswerMs = String(Math.round(ms))
        setPainted({ key, ms })
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [run, key])
  return { run, answerMs: painted && painted.key === key ? painted.ms : null, remeasure: () => setNonce((n) => n + 1) }
}

export default function Now(_props: FeatureProps) {
  const { state } = useMission()
  const scenario = useScenario()
  // useCases() runs here so the fold opens the SPE case when the hero mounts (page-level timing below).
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
  /** Mars: no NOAA alert reaches the crew; the case reads the Mars-orbit space-weather monitor (environments.json). */
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

  // ---- the measured onboard answer (on this visit, and on demand) ----
  const measure = useOnboardMeasure({ index: scenario.index, runtime: state.observations, envId: state.envId, t, crewId: spe?.crewId ?? state.crewId })
  const runPrimary = measure.run?.opened ? primaryOf(speDef()) : null
  useMarkHeroReady(measure.answerMs !== null)

  // ---- monitor readings that exist at the clock ----
  const fluxObs = useMemo(
    () => (scenario.index && variable ? observationsFor(scenario.index, state.observations, null, variable) : []),
    [scenario.index, state.observations, variable],
  )
  const nowMet = scenario.index?.nowMet ?? null
  const series = useMemo(() => fluxWindow(fluxObs, t, SPARK_WINDOW_S, threshold, nowMet), [fluxObs, t, threshold, nowMet])
  const level = series.last ? sLevel(series.last.value) : null
  const levelWord = sLevelDescriptor(level)
  const levels = useMemo(() => sLevelLines(), [])

  // The card shows the measured answer only while the shelter case is open at the clock (the fold agrees).
  const nothingOpen = cases.status === 'ready' && (!spe || (measure.run !== null && !measure.run.opened))
  const answer: AnswerState =
    cases.status === 'error'
      ? { kind: 'unavailable', reason: `The case engine could not run in this build (${cases.error ?? 'unknown error'}).` }
      : nothingOpen
        ? { kind: 'unavailable', reason: 'No shelter case is open at this clock, so there is nothing to time.' }
        : measure.answerMs !== null
          ? { kind: 'measured', answerMs: measure.answerMs, pageMs: pageCold ? timing.heroReadyAtMs : null }
          : { kind: 'pending' }

  const severity = nothingOpen ? null : ((opening?.severity as Severity | undefined) ?? (measure.run?.finding?.severity as Severity | undefined) ?? null)
  const landfall: LandfallAnswer = {
    action: nothingOpen ? null : (runPrimary?.title ?? null),
    severity,
    badge: severity ? `${level !== null ? `S${level} · ` : ''}${SEVERITY_LABEL[severity]}` : null,
    answer,
    onRemeasure: measure.run ? measure.remeasure : null,
  }
  const commsSettled = comms.snapshotId === null || (comms.snapshotStatus !== 'loading' && (comms.basis !== 'fallback' || scenario.status !== 'loading'))
  const ready = cases.status !== 'loading' && commsSettled
  const packet = packetState(spe?.state ?? null)

  // ---- secondary row ----
  const others = useMemo(() => otherOpenCases(cases.cases, SPE_CASE_ID), [cases.cases])
  const crew = useMemo(() => crewStatuses(evaluation.evaluation?.alerts ?? []), [evaluation.evaluation])
  const unscripted = useMemo(() => unscriptedOpenings(scenario.sim.data), [scenario.sim.data])

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
  const openedLevel = opening?.value != null ? sLevel(opening.value) : level

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
              {onboard ? 'The Mars-orbit space-weather monitor' : "NOAA's GOES proton feed"} reached the <span className="lf-num">S{openedLevel}</span> level at{' '}
              <MetTime t={spe.state.opened_at} label />. The {onboard ? "habitat's" : "vehicle's"} radiation monitoring system raises the alarm; LANDFALL opened the
              shelter health case for {speViews.length === CREW_IDS.length ? 'every crewmember' : `${speViews.length} crew`} and guides the crew.{' '}
              {comms.blocked ? (
                <>
                  With no link, the crew acts onboard with the Crew Medical Officer. Ground packet: <strong>{packet.label}</strong>.
                </>
              ) : (
                (autonomyText(comms) ?? 'With the link up, the crew follows Mission Control and flight-surgeon direction.')
              )}
            </p>
          ) : (
            <p className="now-lede">
              {cases.status === 'loading'
                ? 'Reading the frozen scenario and the space-weather monitor.'
                : cases.status === 'error'
                  ? 'The comms figures below are real; the case and crew findings need the engine (each panel says why).'
                  : 'The proton flux is below every case threshold.'}
            </p>
          )}
          <SimulatedMarker variant="inline">crew and clock · the flux is a replay of a real event</SimulatedMarker>
        </div>
      </header>

      <DualCounter comms={comms} ready={ready} landfall={landfall} packetLabel={spe ? packet.label : null} />
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
          comms={comms}
          t={t}
        />
      ) : cases.status === 'error' ? (
        <EmptyState kind="error" title="The shelter case could not be evaluated">
          <p>{cases.error}</p>
        </EmptyState>
      ) : cases.status === 'loading' ? (
        <EmptyState kind="loading" title={speDefinition?.title ?? 'Solar particle event: shelter'}>
          <p>Reading the space-weather monitor and the frozen scenario.</p>
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
        <OtherCases views={others} status={cases.status} error={cases.error} unscripted={unscripted} />
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
