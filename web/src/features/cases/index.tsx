// #/case and #/case/:id - the ACT loop, LANDFALL's differentiator:
//   detect -> interpret -> ONE primary countermeasure (alternatives collapsed) -> guided procedure
//   (magenta) -> log outcome -> tripwire armed (countdown on the mission clock) -> resolved | escalated
//   (escalation queues the ground packet for the flight surgeon: #/downlink).
// Every state is the engine's caseReduce fold (useCases); this view only reads it and dispatches
// SELECT / STEP / OUTCOME / DISMISS. Every number is from the rules JSON, a snapshot or the engine.
import { useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { RULES, getIndicator, getRule } from '../../app/engine'
import type { CaseState } from '../../app/engine'
import { CASE_DEFS } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import { formatCountdown, formatEarliestReply, useComms } from '../../app/comms'
import { useSnapshot } from '../../app/data'
import type { CrewEvaluation, MissionEvaluation, PersonalEvaluation, RuleEvaluation } from '../../app/evaluate'
import { metClock, useMetClock, useMission } from '../../app/mission'
import { useCases, useEvaluation, useGroundPacket, useScenario } from '../../app/model'
import type { CaseEventInput } from '../../app/model'
import type { FeatureProps } from '../../app/router'
import { environment } from '../../app/scenario'
import { observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex, SimCrewData } from '../../app/scenarioData'
import { CREW_IDS, crewMember } from '../../app/vocab'
import type { CrewId, EnvId, Observation, Severity } from '../../app/vocab'
import {
  Button,
  ButtonLink,
  CategoryBadge,
  Chip,
  EmptyState,
  Expander,
  FindingBadge,
  FreshnessChip,
  MetTime,
  Num,
  Panel,
  ReqId,
  SeverityBadge,
  SimulatedMarker,
} from '../../ui'
import './cases.css'
import { HRR_MISSION_TYPE, OP_TEXT, STATUS_WORD, findRequirement, formatSpan, humanize, isOpen, lastN, latestAtOrBefore, pickCrew, stagesOf } from './model'
import type { Stage, StdData } from './model'
import { RenalPanel, RuleRow, SleepPanel, SpePanel } from './panels'
import { EventLog, KindChip, PersonalWhy, RefsProvider, RuleWhy, SourceBlock, TMinus } from './parts'
import type { CaseRefs } from './parts'
import type { CaseDefFull, CmDef, HrpHazard, HrpRisk, HrrRisk, MetaHazard, StepDef } from './types'

const defOf = (v: CaseView) => v.def as unknown as CaseDefFull

// =============================================================================================
// Route
// =============================================================================================

export default function Cases({ params, query }: FeatureProps) {
  const cases = useCases()
  const { state } = useMission()
  const vol1 = useSnapshot<StdData>('std_vol1_requirements')
  const vol2 = useSnapshot<StdData>('std_vol2_requirements')
  const sScale = useSnapshot<{ levels?: [] }>('swpc_s_scale')
  const refs = useMemo<CaseRefs>(() => ({ vol1, vol2, sScale }), [vol1, vol2, sScale])

  if (cases.status === 'loading') {
    return (
      <EmptyState kind="loading" title="Opening the cases" headingLevel={1}>
        <p>Reading the frozen scenario and replaying every case through the engine.</p>
      </EmptyState>
    )
  }
  if (cases.status !== 'ready') {
    return (
      <EmptyState kind={cases.status === 'missing' ? 'missing' : 'error'} title="Cases are unavailable" headingLevel={1}>
        <p>The simulated scenario could not be read{cases.error ? `: ${cases.error}` : '.'}</p>
      </EmptyState>
    )
  }
  if (!params.id) return <CaseList views={cases.cases} storeCrew={state.crewId} />
  const def = CASE_DEFS.find((c) => c.id === params.id)
  if (!def) {
    return (
      <EmptyState kind="unavailable" title="No such case" headingLevel={1}>
        <p>
          <code>{params.id}</code> is not one of LANDFALL’s cases. Open{' '}
          {CASE_DEFS.map((c, i) => (
            <span key={c.id}>
              {i ? ', ' : ''}
              <a href={`#/case/${c.id}`}>{(c.title as string) ?? c.id}</a>
            </span>
          ))}
          .
        </p>
      </EmptyState>
    )
  }
  const crewId = pickCrew(def.id, cases.cases, query.crew, state.crewId)
  const view = cases.get(def.id, crewId)
  if (!view) return null
  return (
    <RefsProvider value={refs}>
      <CaseDetail key={view.key} view={view} all={cases.cases} t={cases.t} dispatch={cases.dispatch} />
    </RefsProvider>
  )
}

// =============================================================================================
// Status badge
// =============================================================================================

function openingSeverity(v: CaseView): Severity {
  return ((v.state.finding?.severity ?? v.opening?.finding.severity ?? 'caution') as Severity) || 'caution'
}

function CaseStatusBadge({ view, size = 'md' }: { view: CaseView; size?: 'sm' | 'md' | 'lg' }) {
  const s = view.state.status
  if (s === 'idle' || s === 'resolved' || s === 'dismissed') return <SeverityBadge severity="nominal" label={STATUS_WORD[s]} size={size} />
  return <SeverityBadge severity={openingSeverity(view)} label={STATUS_WORD[s]} size={size} solid={s !== 'escalated'} />
}

// =============================================================================================
// #/case: the three cases x four crewmembers
// =============================================================================================

function CaseList({ views, storeCrew }: { views: CaseView[]; storeCrew: CrewId }) {
  return (
    <div className="lfc">
      <header className="lfc-head">
        <p className="lf-eyebrow">Act</p>
        <h1>Cases</h1>
        <p className="lfc-lede">
          Every finding that reaches caution becomes a case: detect, interpret in plain words, one primary countermeasure, a
          guided procedure, an outcome, then a tripwire that either closes the case or queues it for the flight surgeon. No
          diagnosis, no drug doses.
        </p>
        <SimulatedMarker variant="banner">Crew values and crew actions are simulated. The rules, limits and NASA/NOAA text are real.</SimulatedMarker>
      </header>
      <ul className="lfc-list">
        {CASE_DEFS.map((raw) => {
          const def = raw as unknown as CaseDefFull
          const mine = CREW_IDS.map((c) => views.find((v) => v.caseId === def.id && v.crewId === c)!).filter(Boolean)
          const lead = mine.find((v) => v.crewId === pickCrew(def.id, views, undefined, storeCrew)) ?? mine[0]
          return (
            <li key={def.id} className="lfc-list-item">
              <article className="lf-card" data-severity={lead && isOpen(lead.state.status) ? openingSeverity(lead) : undefined}>
                <header className="lfc-list-head">
                  <h2 className="lfc-list-title">
                    <a href={`#/case/${def.id}?crew=${lead?.crewId ?? storeCrew}`}>{def.title}</a>
                  </h2>
                  {lead ? <CaseStatusBadge view={lead} /> : null}
                </header>
                <p>{def.one_line}</p>
                <p className="lfc-fine">
                  NASA HRP risk: <a href={def.hrp_risk?.url} target="_blank" rel="noopener noreferrer">{def.hrp_risk?.title}</a>
                </p>
                <ul className="lfc-crew-row" aria-label={`${def.title}: status per crewmember`}>
                  {mine.map((v) => (
                    <li key={v.key}>
                      <a href={`#/case/${def.id}?crew=${v.crewId}`} className="lfc-crew-link">
                        <span className="lf-mono">{v.crewId}</span>
                        <CaseStatusBadge view={v} size="sm" />
                        {v.state.opened_at !== null ? (
                          <span className="lfc-fine">
                            opened <MetTime t={v.state.opened_at} />
                          </span>
                        ) : null}
                      </a>
                    </li>
                  ))}
                </ul>
              </article>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// =============================================================================================
// #/case/:id
// =============================================================================================

type Dispatch = ReturnType<typeof useCases>['dispatch']

interface DetailProps {
  view: CaseView
  all: CaseView[]
  t: number
  dispatch: Dispatch
}

function nextAction(view: CaseView, def: CaseDefFull): ReactNode {
  const s = view.state
  switch (s.status) {
    case 'idle':
      return <>Nothing to do for {view.crewId}: no trigger of this case has reached caution.</>
    case 'detected':
      return <>Start the countermeasure: {def.countermeasure?.primary.title}.</>
    case 'acting':
      return (
        <>
          Work through the procedure (<Num value={s.steps_done.length} /> of <Num value={s.spec.step_ids.length} /> steps done),
          then log the outcome.
        </>
      )
    case 'watch':
      return s.reassess_at !== null ? (
        <>
          Tripwire armed. Reassess at <MetTime t={s.reassess_at} label /> (<TMinus target={s.reassess_at} />
          ).
        </>
      ) : (
        <>Tripwire armed.</>
      )
    case 'resolved':
      return <>Resolved at the reassessment. Keep logging as usual.</>
    case 'escalated':
      return <>Escalated: queued for flight-surgeon review. Keep following the procedure.</>
    case 'dismissed':
      return <>Dismissed: {s.dismiss_reason}</>
  }
}

function CaseDetail({ view, all, t, dispatch }: DetailProps) {
  const def = defOf(view)
  const { state: mission, addObservations } = useMission()
  const scenario = useScenario()
  const { evaluation } = useEvaluation()
  const envId = mission.envId
  const env = environment(envId)
  const crew = crewMember(view.crewId)
  const s = view.state
  const crewEval = evaluation?.crew[view.crewId] ?? null
  const index = scenario.index
  const runtime = mission.observations
  const shared = (def.triggers ?? []).some((x) => x.kind === 'ops')
  const [allCrew, setAllCrew] = useState(true)
  const sim = useSnapshot<SimCrewData>('sim_crew')
  const replay = useSnapshot('swpc_spe_replay')
  const vol2 = useSnapshot<StdData>('std_vol2_requirements')

  const peers = all.filter((v) => v.caseId === view.caseId)
  const crews = (status: CaseState['status'], extra?: (v: CaseView) => boolean): CrewId[] =>
    shared && allCrew ? peers.filter((v) => v.state.status === status && (!extra || extra(v))).map((v) => v.crewId) : [view.crewId]

  const send = (event: CaseEventInput, targets: CrewId[]) => {
    const tt = metClock.get().metNow
    for (const c of targets) dispatch(view.caseId, { ...event, t: tt } as CaseEventInput, c)
  }

  const latest = (variable: string): Observation | null => {
    if (!index) return null
    return latestAtOrBefore(observationsFor(index, runtime, view.crewId, variable), t, view.crewId)
  }
  const recent = (variable: string, n: number): Observation[] => (index ? lastN(observationsFor(index, runtime, view.crewId, variable), t, n, view.crewId) : [])

  /** A value typed or confirmed by the crew: stamped at the clock minute so evaluation and tripwire see it at once. */
  const logObservation = (variable: string, value: number, unit: string, crewIds: CrewId[] = [view.crewId], vehicle = false): number => {
    const tt = Math.floor(metClock.get().metNow / 60) * 60
    const obs: Observation[] = (vehicle ? [null] : crewIds).map((c) => ({ crew_id: c, variable, value, unit, t: tt, source: 'manual', provenance: 'manual' }))
    addObservations(obs)
    return tt
  }

  const stages = stagesOf(s)
  const ctxProps = index && crewEval && evaluation ? { def, crewId: view.crewId, envId, t, index, runtime, crew: crewEval, evaluation } : null

  return (
    <article className="lfc" aria-labelledby="lfc-title">
      <header className="lfc-head">
        <p className="lf-eyebrow">
          Case · {crew.id} {crew.role} · {env.label}
        </p>
        <h1 id="lfc-title">{def.title}</h1>
        <p className="lfc-lede">{def.one_line}</p>
        <SimulatedMarker variant="banner">
          {shared
            ? 'Crew actions are simulated. The proton flux is a time-shifted replay of the real GOES-7 October 1989 event.'
            : 'Crew values and the scripted crew actions are simulated. The rules, limits and NASA text are real.'}
        </SimulatedMarker>
        <nav className="lfc-crew-switch" aria-label="Crewmember">
          {peers.map((v) => (
            <a key={v.key} href={`#/case/${view.caseId}?crew=${v.crewId}`} aria-current={v.crewId === view.crewId ? 'page' : undefined}>
              <span className="lf-mono">{v.crewId}</span> <CaseStatusBadge view={v} size="sm" />
            </a>
          ))}
        </nav>
        <div className="lfc-status" data-status={s.status}>
          <CaseStatusBadge view={view} size="lg" />
          <p className="lfc-next">{nextAction(view, def)}</p>
          {s.opened_at !== null ? (
            <p className="lfc-fine">
              Opened <MetTime t={s.opened_at} label /> by <code>{s.finding?.rule_id}</code>. Mission clock <MetTime t={t} label />.
            </p>
          ) : null}
        </div>
        <p className="sr-only" aria-live="polite">
          {`${crew.id} ${def.title}: ${STATUS_WORD[s.status]}.`}
          {s.log.length && s.log[s.log.length - 1].error ? ` Last action rejected: ${s.log[s.log.length - 1].error}.` : ''}
        </p>
        <LoopStepper stages={stages} />
      </header>

      <DetectPanel view={view} crewEval={crewEval} evaluation={evaluation} index={index} />
      <InterpretPanel def={def} envId={envId} />
      <CountermeasurePanel def={def} state={s} onSelect={(id) => send({ type: 'SELECT', countermeasure_id: id }, crews('detected'))} sharedNote={shared && allCrew ? peers.filter((v) => v.state.status === 'detected').length : 0} />
      <ProcedurePanel
        def={def}
        state={s}
        crewId={view.crewId}
        shared={shared}
        allCrew={allCrew}
        setAllCrew={setAllCrew}
        latest={latest}
        recent={recent}
        onStep={(step, input) => {
          const vehicle = !!input && latest(input.variable)?.crew_id === null
          const targets = !input || vehicle || input.unit === 'MET' ? crews('acting', (v) => !v.state.steps_done.some((d) => d.step_id === step.id)) : [view.crewId]
          send({ type: 'STEP', step_id: step.id, ...(input ? { input } : {}) }, targets)
        }}
        logObservation={logObservation}
      />
      <OutcomePanel
        def={def}
        state={s}
        onOutcome={(text) => send({ type: 'OUTCOME', text }, crews('acting'))}
        peersActing={shared && allCrew ? peers.filter((v) => v.state.status === 'acting').length : 0}
      />
      <TripwirePanel def={def} view={view} t={t} latest={latest} logObservation={logObservation} />
      <ClosePanel def={def} view={view} t={t} onDismiss={(reason) => send({ type: 'DISMISS', reason }, [view.crewId])} />

      {ctxProps && def.id === 'renal_stone' ? <RenalPanel {...ctxProps} /> : null}
      {ctxProps && def.id === 'sleep_circadian' ? <SleepPanel {...ctxProps} vol2={vol2} /> : null}
      {ctxProps && def.id === 'spe_shelter' ? <SpePanel {...ctxProps} sim={sim} replay={replay} /> : null}

      <BoundaryPanel def={def} />
      <Panel
        title="Event log"
        eyebrow="Engine record"
        id="case-log"
        footer={<FreshnessChip meta={sim.snapshot} status={sim.status} id="sim_crew" />}
      >
        <p className="lfc-fine">
          Every line is an engine transition (<code>caseReduce</code>), with MET. Rejected actions stay in the record with the reason.
        </p>
        <EventLog log={s.log} origins={view.logOrigins} />
      </Panel>
    </article>
  )
}

// =============================================================================================
// Stepper
// =============================================================================================

const STAGE_TARGET: Record<Stage['id'], string> = {
  detect: 'case-detect',
  interpret: 'case-interpret',
  act: 'case-act',
  procedure: 'case-procedure',
  outcome: 'case-outcome',
  tripwire: 'case-tripwire',
  close: 'case-close',
}

function jump(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  const h = el.querySelector('h2')
  if (h instanceof HTMLElement) {
    h.tabIndex = -1
    h.focus({ preventScroll: true })
  }
}

function LoopStepper({ stages }: { stages: Stage[] }) {
  return (
    <ol className="lfc-stepper" aria-label="Case loop">
      {stages.map((st, i) => (
        <li key={st.id} data-state={st.state}>
          <button type="button" onClick={() => jump(STAGE_TARGET[st.id])} aria-current={st.state === 'current' ? 'step' : undefined}>
            <span className="lfc-stepper-n lf-num">{i + 1}</span>
            <span className="lfc-stepper-label">{st.label}</span>
            <span className="lfc-stepper-note">
              {st.state === 'done' ? '✓ ' : st.state === 'current' ? 'now ' : st.state === 'skipped' ? 'skipped ' : ''}
              {st.note ?? ''}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

// =============================================================================================
// 1. Detect
// =============================================================================================

function DetectPanel({
  view,
  crewEval,
  evaluation,
  index,
}: {
  view: CaseView
  crewEval: CrewEvaluation | null
  evaluation: MissionEvaluation | null
  index: ScenarioIndex | null
}) {
  const def = defOf(view)
  const s = view.state
  const opening = s.finding
  const triggers = (def.triggers ?? []).map((tr) => {
    let rule: RuleEvaluation | null = null
    let personal: PersonalEvaluation | null = null
    if (tr.kind === 'ops' && tr.rule_id) rule = evaluation?.ops.findings.find((f) => f.rule.id === tr.rule_id) ?? null
    else if (tr.kind === 'rule' && tr.rule_id) rule = crewEval?.tierA.find((r) => r.rule.id === tr.rule_id) ?? null
    else if (tr.kind === 'personal' && tr.indicator_id) personal = crewEval?.tierB.find((p) => p.indicator.id === tr.indicator_id) ?? null
    return { tr, rule, personal }
  })
  const openingRule = opening && opening.tier !== 'B' ? (() => { try { return getRule(RULES, opening.rule_id) } catch { return null } })() : null
  const openingInd = opening && opening.tier === 'B' ? (() => { try { return getIndicator(RULES, opening.rule_id) } catch { return null } })() : null
  return (
    <Panel title="1. Detect: what LANDFALL saw" eyebrow="Detect" id="case-detect">
      {opening ? (
        <div className="lfc-opening">
          <p>
            Opened <MetTime t={s.opened_at ?? 0} label /> because{' '}
            <strong>{openingRule?.label ?? openingInd?.label ?? opening.rule_id}</strong> read{' '}
            <Num value={opening.value} unit={opening.unit} arrow={opening.limit !== null && opening.value !== null ? (opening.value > opening.limit ? 'up' : 'down') : undefined} severity={opening.severity as Severity} />{' '}
            against {opening.tier === 'B' ? 'your personal band edge' : opening.category === 'TARGET' ? 'the target' : 'the limit'}{' '}
            {opening.op ? <span className="lf-num">{OP_TEXT[opening.op]}</span> : null} <Num value={opening.limit} unit={opening.unit} />.{' '}
            <CategoryBadge category={opening.category} /> <Chip kind={opening.chip} /> <FindingBadge finding={opening} />
          </p>
          {openingRule ? <RuleWhy rule={openingRule} finding={opening} /> : null}
          {openingInd && index && evaluation ? (
            <PersonalWhy indicator={openingInd} finding={opening as never} baselineDays={index.baselineDays} alertingIndicators={evaluation.tierBAlertingIndicators} />
          ) : null}
        </div>
      ) : (
        <p>
          Not open for {view.crewId}. {view.opening ? <>The data opens it at <MetTime t={view.opening.t} label />, after the mission clock.</> : 'No trigger has reached caution in the data.'}
        </p>
      )}
      <h3 className="lfc-h3">Every trigger of this case, now</h3>
      <ul className="lfc-rows">
        {triggers.map(({ tr, rule, personal }) =>
          rule ? (
            <RuleRow key={tr.rule_id} ev={rule} />
          ) : personal && index && evaluation ? (
            <li key={tr.indicator_id} className="lfc-row">
              <div className="lfc-row-head">
                <span className="lfc-row-label">{personal.indicator.label ?? personal.indicator.id}</span>
                <span className="lfc-row-val">
                  <Num value={personal.finding.value} unit={personal.indicator.unit} /> <span className="lfc-vs">band edge</span>{' '}
                  <Num value={personal.finding.limit} unit={personal.indicator.unit} digits={2} />
                </span>
                <FindingBadge finding={personal.finding} />
              </div>
              <PersonalWhy indicator={personal.indicator} finding={personal.finding} baselineDays={index.baselineDays} alertingIndicators={evaluation.tierBAlertingIndicators} />
            </li>
          ) : (
            <li key={tr.rule_id ?? tr.indicator_id} className="lfc-row">
              <span className="lf-mono">{tr.rule_id ?? tr.indicator_id}</span> <span className="lfc-fine">not evaluated yet</span>
            </li>
          ),
        )}
      </ul>
    </Panel>
  )
}

// =============================================================================================
// 2. Interpret
// =============================================================================================

function useHrp() {
  const risks = useSnapshot<{ risks?: HrpRisk[] }>('hrp_risks')
  const roadmap = useSnapshot<{ risks?: HrrRisk[] }>('hrp_roadmap')
  const hazards = useSnapshot<{ hazards?: HrpHazard[] }>('hrp_hazards')
  return { risks, roadmap, hazards }
}

function InterpretPanel({ def, envId }: { def: CaseDefFull; envId: EnvId }) {
  const { risks, roadmap, hazards } = useHrp()
  const risk = risks.data?.risks?.find((r) => r.url === def.hrp_risk?.url || r.detail?.canonical_url === def.hrp_risk?.url || r.name === def.hrp_risk?.title) ?? null
  const term = def.id.replace(/_/g, ' ').toLowerCase()
  const hrr = (roadmap.data?.risks ?? []).filter((r) => r.hrr_id === risk?.detail?.hrr_risk_id || r.title.toLowerCase().includes(term))
  const metaHazards = ((RULES.meta as { hazards?: MetaHazard[] } | null)?.hazards ?? []) as MetaHazard[]
  const missionType = HRR_MISSION_TYPE[envId]
  return (
    <Panel
      title="2. Interpret: what it means, in plain words"
      eyebrow="Interpret"
      id="case-interpret"
      footer={
        <>
          <FreshnessChip meta={risks.snapshot} status={risks.status} id="hrp_risks" source={risks.snapshot?.source} compact />
          <FreshnessChip meta={roadmap.snapshot} status={roadmap.status} id="hrp_roadmap" source={roadmap.snapshot?.source} compact />
          <FreshnessChip meta={hazards.snapshot} status={hazards.status} id="hrp_hazards" source={hazards.snapshot?.source} compact />
        </>
      }
    >
      <p className="lfc-interp">{def.interpretation?.text}</p>
      {def.interpretation?.citations?.length ? (
        <Expander summary={`Sources quoted above (${def.interpretation.citations.length})`}>
          <ul className="lfc-cites">
            {def.interpretation.citations.map((c, i) => (
              <li key={i}>
                <KindChip kind={c.kind} /> <SourceBlock source={c as never} compact />
              </li>
            ))}
          </ul>
        </Expander>
      ) : null}
      <div className="lfc-grid2">
        <section className="lfc-risk" aria-labelledby="lfc-risk-h">
          <h3 id="lfc-risk-h" className="lfc-h3">
            Official NASA risk
          </h3>
          <p>
            <a href={def.hrp_risk?.url} target="_blank" rel="noopener noreferrer">
              {def.hrp_risk?.title}
            </a>
            {def.hrp_risk?.formal_description ? <span className="lfc-fine"> ({def.hrp_risk.formal_description})</span> : null}
          </p>
          {risk?.detail?.top_risks_sentences?.length ? (
            <figure className="lfc-quote">
              <figcaption className="lfc-quote-label">NASA HRP, verbatim</figcaption>
              <blockquote>{risk.detail.top_risks_sentences.slice(0, 2).join(' ')}</blockquote>
            </figure>
          ) : risks.status === 'missing' ? (
            <FreshnessChip status="missing" id="hrp_risks" />
          ) : null}
          {def.hrp_risk?.why_here ? <p className="lfc-fine">{def.hrp_risk.why_here}</p> : null}
          {hrr.map((r) => {
            const rows = r.detail?.ratings?.filter((x) => x.mission_type === missionType) ?? []
            return (
              <div key={r.hrr_id} className="lfc-hrr">
                <p>
                  Human Research Roadmap: <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a>{' '}
                  <span className="lfc-fine">
                    (HRR risk <Num value={r.hrr_id} />
                    {r.detail?.hrp_risk_status ? `, ${r.detail.hrp_risk_status}` : ''})
                  </span>
                </p>
                {r.detail?.risk_statement ? (
                  <figure className="lfc-quote">
                    <figcaption className="lfc-quote-label">Risk statement, verbatim</figcaption>
                    <blockquote>{r.detail.risk_statement}</blockquote>
                  </figure>
                ) : null}
                {rows.length ? (
                  <p className="lfc-fine">
                    Rated for {missionType}:{' '}
                    {rows.map((x, i) => (
                      <span key={x.duration}>
                        {i ? '; ' : ''}
                        {x.duration}: operations <span className="lf-mono">{x.operations?.lxc}</span> {x.operations?.disposition}
                      </span>
                    ))}
                    . {r.detail?.ratings_note}
                  </p>
                ) : null}
              </div>
            )
          })}
        </section>
        <section aria-labelledby="lfc-haz-h">
          <h3 id="lfc-haz-h" className="lfc-h3">
            Spaceflight hazards behind it
          </h3>
          <ul className="lfc-hazards">
            {(def.hazards ?? []).map((h) => {
              const m = metaHazards.find((x) => x.id === h)
              const snap = hazards.data?.hazards?.find((x) => x.id === (m?.hrp_snapshot_id ?? h))
              return (
                <li key={h}>
                  <strong>{snap ? <a href={snap.url} target="_blank" rel="noopener noreferrer">{m?.label ?? snap.name}</a> : m?.label ?? humanize(h)}</strong>
                  {snap?.summary ? <span className="lfc-fine"> “{snap.summary}”</span> : null}
                </li>
              )
            })}
          </ul>
          <p className="lfc-fine">
            Body:{' '}
            {(def.body_regions ?? []).map((r, i) => (
              <span key={r}>
                {i ? ' · ' : ''}
                <a href={`#/body?region=${r}`}>{humanize(r)}</a>
              </span>
            ))}
          </p>
        </section>
      </div>
    </Panel>
  )
}

// =============================================================================================
// 3. One primary countermeasure
// =============================================================================================

function CmBody({ cm }: { cm: CmDef }) {
  return (
    <>
      <p>{cm.rationale}</p>
      <p className="lfc-badges">
        <Chip kind={cm.chip} />
      </p>
      <SourceBlock source={cm.source} compact />
    </>
  )
}

function CountermeasurePanel({ def, state, onSelect, sharedNote }: { def: CaseDefFull; state: CaseState; onSelect: (id: string) => void; sharedNote: number }) {
  const cm = def.countermeasure
  if (!cm) return null
  const chosen = state.countermeasure_id
  const canSelect = state.status === 'detected'
  const selectLog = state.log.find((e) => e.event === 'SELECT' && e.error === null)
  const alts = cm.alternatives ?? []
  return (
    <Panel title="3. Act: one countermeasure" eyebrow="Countermeasure" id="case-act">
      <div className="lfc-cm" data-chosen={chosen === cm.primary.id || undefined}>
        <p className="lfc-k">Primary countermeasure</p>
        <h3 className="lfc-cm-title">{cm.primary.title}</h3>
        <CmBody cm={cm.primary} />
        {canSelect ? (
          <Button onClick={() => onSelect(cm.primary.id)}>
            Start: {cm.primary.title}
            {sharedNote > 1 ? ` (all ${sharedNote} crewmembers)` : ''}
          </Button>
        ) : chosen ? (
          <p className="lfc-done">
            Selected{selectLog?.t !== null && selectLog?.t !== undefined ? <> at <MetTime t={selectLog.t} label /></> : null}:{' '}
            {chosen === cm.primary.id ? 'the primary countermeasure' : `alternative “${alts.find((a) => a.id === chosen)?.title ?? chosen}”`}.
          </p>
        ) : state.status === 'idle' ? (
          <p className="lfc-fine">Available once the case opens.</p>
        ) : null}
      </div>
      {alts.length ? (
        <Expander summary={`Other options (${alts.length}), only if the primary is not possible`}>
          <ul className="lfc-alts">
            {alts.map((a) => (
              <li key={a.id} data-chosen={chosen === a.id || undefined}>
                <h4>{a.title}</h4>
                <CmBody cm={a} />
                {canSelect ? (
                  <Button variant="secondary" onClick={() => onSelect(a.id)}>
                    Use this instead
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Expander>
      ) : null}
    </Panel>
  )
}

// =============================================================================================
// 4. Guided procedure (magenta = electronic procedure, Appendix F Table F.5-2)
// =============================================================================================

interface ProcedureProps {
  def: CaseDefFull
  state: CaseState
  crewId: CrewId
  shared: boolean
  allCrew: boolean
  setAllCrew: (v: boolean) => void
  latest: (variable: string) => Observation | null
  recent: (variable: string, n: number) => Observation[]
  onStep: (step: StepDef, input?: { variable: string; value: number; unit: string; t: number }) => void
  logObservation: (variable: string, value: number, unit: string, crewIds?: CrewId[], vehicle?: boolean) => number
}

function ProcedurePanel(p: ProcedureProps) {
  const steps = p.def.procedure ?? []
  const acting = p.state.status === 'acting'
  return (
    <Panel title="4. Guided procedure" eyebrow="Procedure" id="case-procedure" className="lfc-proc-panel">
      {!acting && p.state.status !== 'idle' && !p.state.countermeasure_id ? (
        <p className="lfc-fine">The steps unlock when you start the countermeasure above.</p>
      ) : null}
      {p.shared ? (
        <label className="lfc-check">
          <input type="checkbox" checked={p.allCrew} onChange={(e) => p.setAllCrew(e.target.checked)} />
          Apply shared steps to every crewmember with this case open (the shelter is crew-wide). Personal readings stay personal.
        </label>
      ) : null}
      <ol className="lfc-proc">
        {steps.map((st, i) => {
          const done = p.state.steps_done.find((d) => d.step_id === st.id) ?? null
          return (
            <li key={st.id} className="lfc-step" data-done={done ? 'true' : undefined}>
              <span className="lfc-step-n lf-num" aria-hidden="true">
                {i + 1}
              </span>
              <div className="lfc-step-body">
                <p className="lfc-step-text">
                  <span className="sr-only">Step {i + 1}{done ? ', done' : ''}: </span>
                  {st.text}
                </p>
                {done ? (
                  <p className="lfc-done">
                    ✓ Done <MetTime t={done.t} label />
                    {done.input && typeof done.input === 'object' && 'value' in (done.input as object) ? (
                      <>
                        {' '}
                        with <Num value={(done.input as { value: number }).value} unit={(done.input as { unit?: string }).unit} />
                      </>
                    ) : null}
                  </p>
                ) : acting ? (
                  <StepAction step={st} {...p} />
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </Panel>
  )
}

function NumberEntry({ label, unit, onSubmit, submitLabel }: { label: string; unit: string; onSubmit: (v: number) => void; submitLabel: string }) {
  const [raw, setRaw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const id = `lfc-in-${label.replace(/\W+/g, '-')}`
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(v) || v < 0) {
      setErr('Enter a number of zero or more.')
      return
    }
    setErr(null)
    setRaw('')
    onSubmit(v)
  }
  return (
    <form className="lfc-entry" onSubmit={submit}>
      <label htmlFor={id}>{label}</label>
      <span className="lfc-entry-field">
        <input id={id} inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} aria-invalid={err ? true : undefined} aria-describedby={err ? `${id}-err` : undefined} />
        <span className="lf-mono">{unit}</span>
      </span>
      <Button type="submit" variant="secondary">
        {submitLabel}
      </Button>
      {err ? (
        <span id={`${id}-err`} className="lfc-err" role="alert">
          {err}
        </span>
      ) : null}
    </form>
  )
}

function StepAction({ step, ...p }: ProcedureProps & { step: StepDef }) {
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(null)
  const inp = step.input
  if (!inp) {
    return (
      <Button variant="secondary" onClick={() => p.onStep(step)}>
        Mark step done
      </Button>
    )
  }
  const last = p.latest(inp.variable)
  const asInput = (o: Observation) => ({ variable: o.variable, value: o.value, unit: o.unit, t: o.t })
  const logAndStep = (v: number) => {
    const tt = p.logObservation(inp.variable, v, inp.unit)
    p.onStep(step, { variable: inp.variable, value: v, unit: inp.unit, t: tt })
  }
  if (inp.unit === 'yes/no') {
    return (
      <div className="lfc-entry">
        <fieldset className="lfc-yn">
          <legend>Answer</legend>
          <label>
            <input type="radio" name={`yn-${step.id}`} checked={answer === 'no'} onChange={() => setAnswer('no')} /> No
          </label>
          <label>
            <input type="radio" name={`yn-${step.id}`} checked={answer === 'yes'} onChange={() => setAnswer('yes')} /> Yes
          </label>
        </fieldset>
        <Button variant="secondary" disabled={!answer} onClick={() => answer && logAndStep(answer === 'yes' ? 1 : 0)}>
          Log answer
        </Button>
        {answer === 'yes' ? (
          <p className="lfc-fine">
            Then this needs a flight surgeon: <a href={`#/downlink?case=${p.def.id}&crew=${p.crewId}`}>open the ground packet</a>.
          </p>
        ) : null}
      </div>
    )
  }
  if (inp.unit === 'MET') {
    return (
      <Button variant="secondary" onClick={() => logAndStep(metClock.get().metNow)}>
        Log the time now (MET)
      </Button>
    )
  }
  const lastLine = last ? (
    <p className="lfc-fine">
      Latest {inp.variable}: <Num value={last.value} unit={last.unit} /> at <MetTime t={last.t} label /> ({last.crew_id === null ? 'vehicle sensor' : last.source})
    </p>
  ) : (
    <p className="lfc-missing">No {inp.variable} reading yet. Shown as missing, not as zero.</p>
  )
  if (inp.source === 'app' || inp.source === 'band' || inp.source === 'vehicle') {
    return (
      <div className="lfc-entry-wrap">
        {lastLine}
        <div className="lfc-entry-actions">
          {last ? (
            <Button variant="secondary" onClick={() => p.onStep(step, asInput(last))}>
              Use this reading
            </Button>
          ) : null}
          {inp.source === 'app' ? <ButtonLink variant="ghost" href="#/noon-sight">Take the test now in Noon Sight</ButtonLink> : null}
        </div>
        {inp.source === 'vehicle' && !last ? (
          <NumberEntry label={`Value the vehicle reports (${inp.variable})`} unit={inp.unit} submitLabel="Log value" onSubmit={logAndStep} />
        ) : null}
      </div>
    )
  }
  const lastThree = p.recent(inp.variable, 3)
  return (
    <div className="lfc-entry-wrap">
      {lastThree.length ? (
        <p className="lfc-fine">
          Last entries:{' '}
          {lastThree.map((o, i) => (
            <span key={o.t}>
              {i ? ' · ' : ''}
              <Num value={o.value} unit={o.unit} /> (<MetTime t={o.t} />)
            </span>
          ))}
        </p>
      ) : (
        lastLine
      )}
      <div className="lfc-entry-actions">
        {last ? (
          <Button variant="secondary" onClick={() => p.onStep(step, asInput(last))}>
            Confirm the latest
          </Button>
        ) : null}
      </div>
      <NumberEntry label={`Enter ${inp.variable}`} unit={inp.unit} submitLabel="Log value and mark done" onSubmit={logAndStep} />
    </div>
  )
}

// =============================================================================================
// 5. Outcome
// =============================================================================================

function OutcomePanel({ def, state, onOutcome, peersActing }: { def: CaseDefFull; state: CaseState; onOutcome: (text: string) => void; peersActing: number }) {
  const [text, setText] = useState('')
  const n = state.spec.step_ids.length
  const reassess = def.tripwire?.reassess_after_s ?? state.spec.tripwire.reassess_after_s
  return (
    <Panel title="5. Log the outcome" eyebrow="Outcome" id="case-outcome">
      {state.outcome ? (
        <p className="lfc-done">
          ✓ Logged <MetTime t={state.outcome.t} label />: “{state.outcome.text}”
        </p>
      ) : state.status === 'acting' ? (
        <form
          className="lfc-outcome"
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) onOutcome(text.trim())
            setText('')
          }}
        >
          <label htmlFor="lfc-outcome-text">What happened? Plain words are fine.</label>
          <textarea id="lfc-outcome-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="lfc-fine">
            <Num value={state.steps_done.length} /> of <Num value={n} /> steps done. Logging the outcome arms the tripwire: LANDFALL
            reassesses <span className="lf-num">{formatSpan(reassess)}</span> later.
          </p>
          <Button type="submit" disabled={!text.trim()}>
            Log outcome and arm the tripwire{peersActing > 1 ? ` (all ${peersActing} crewmembers)` : ''}
          </Button>
        </form>
      ) : (
        <p className="lfc-fine">Logged after the procedure. The tripwire arms when the outcome is logged.</p>
      )}
    </Panel>
  )
}

// =============================================================================================
// 6. Tripwire
// =============================================================================================

function TripwirePanel({
  def,
  view,
  t,
  latest,
  logObservation,
}: {
  def: CaseDefFull
  view: CaseView
  t: number
  latest: (variable: string) => Observation | null
  logObservation: (variable: string, value: number, unit: string, crewIds?: CrewId[], vehicle?: boolean) => number
}) {
  const clock = useMetClock()
  const s = view.state
  const tw = def.tripwire
  const cond = s.spec.tripwire.condition
  const stepFor = (def.procedure ?? []).find((x) => x.input?.variable === cond.variable)
  const src = stepFor?.input?.source ?? null
  const last = latest(cond.variable)
  const res = s.tripwire_result
  const due = s.status === 'watch' && s.reassess_at !== null && t >= s.reassess_at
  return (
    <Panel title="6. Tripwire" eyebrow="Watch" id="case-tripwire">
      <figure className="lfc-quote lfc-trip-text">
        <figcaption className="lfc-quote-label">
          The condition, as written in the case <Chip kind={tw?.chip} />
        </figcaption>
        <blockquote>{tw?.text}</blockquote>
      </figure>
      <p className="lfc-cond lf-mono">
        {cond.variable} {OP_TEXT[cond.op]} <Num value={cond.value} unit={cond.unit} /> on at least <Num value={cond.at_least} /> of the last{' '}
        <Num value={cond.of_last_n} /> readings, judged <Num value={s.spec.tripwire.reassess_after_s / 3600} unit="h" /> after the outcome
      </p>
      {tw?.source ? <SourceBlock source={tw.source} compact /> : null}
      {s.status === 'watch' && s.reassess_at !== null ? (
        <div className="lfc-armed">
          <p className="lfc-k">Armed</p>
          <p className="lfc-big">
            <TMinus target={s.reassess_at} />
          </p>
          <p>
            Reassess at <MetTime t={s.reassess_at} label /> on the mission clock{due ? ': due now, waiting for enough readings.' : '.'}
          </p>
          <div className="lfc-entry-actions">
            {!due ? (
              <Button variant="secondary" onClick={() => clock.set(s.reassess_at!)}>
                Move the mission clock to the reassessment (demo)
              </Button>
            ) : null}
          </div>
        </div>
      ) : res ? null : (
        <p className="lfc-fine">Not armed yet: it arms when the outcome is logged.</p>
      )}
      {s.tripwire_obs.length || s.status === 'watch' ? (
        <>
          <h3 className="lfc-h3">Readings collected since the outcome</h3>
          {s.tripwire_obs.length ? (
            <ul className="lfc-trip-obs">
              {s.tripwire_obs.map((o) => {
                const hit = cond.op === 'lt' ? o.value < cond.value : cond.op === 'le' ? o.value <= cond.value : cond.op === 'gt' ? o.value > cond.value : o.value >= cond.value
                return (
                  <li key={o.t} data-hit={hit || undefined}>
                    <MetTime t={o.t} /> <Num value={o.value} unit={cond.unit} /> {hit ? <SeverityBadge severity="caution" label="meets the condition" size="sm" /> : <span className="lfc-fine">does not meet it</span>}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="lfc-missing">No readings since the outcome yet.</p>
          )}
          {s.status === 'watch' ? (
            src === 'manual' ? (
              <NumberEntry label={`Log a new ${cond.variable}`} unit={cond.unit} submitLabel="Log reading" onSubmit={(v) => logObservation(cond.variable, v, cond.unit)} />
            ) : src === 'app' ? (
              <p className="lfc-fine">
                New results come from the test: <a href="#/noon-sight">take it in Noon Sight</a>.
              </p>
            ) : (
              <p className="lfc-fine">
                New readings arrive from the {last?.crew_id === null ? 'vehicle sensor' : src ?? 'band'} automatically as the mission clock runs.
              </p>
            )
          ) : null}
        </>
      ) : null}
      {res ? (
        <p className="lfc-done">
          Judged <MetTime t={s.closed_at ?? t} label />: <Num value={res.hits} /> of the last <Num value={res.considered} /> readings met the condition (escalate at{' '}
          <Num value={res.at_least} />) → <strong>{res.tripped ? 'tripped: escalated' : 'clear: resolved'}</strong>.
        </p>
      ) : null}
    </Panel>
  )
}

// =============================================================================================
// 7. Resolved | escalated, and the ground packet
// =============================================================================================

function ClosePanel({ def, view, t, onDismiss }: { def: CaseDefFull; view: CaseView; t: number; onDismiss: (reason: string) => void }) {
  const s = view.state
  const packet = useGroundPacket(view.caseId, view.crewId)
  const comms = useComms()
  const [reason, setReason] = useState('')
  const n = packet.bundle?.entry.length ?? null
  const escalated = s.status === 'escalated'
  const href = `#/downlink?case=${view.caseId}&crew=${view.crewId}`
  return (
    <Panel title="7. Resolve or escalate" eyebrow="Close" id="case-close">
      {s.status === 'resolved' ? (
        <p className="lfc-done">
          <SeverityBadge severity="nominal" label="Resolved" /> at <MetTime t={s.closed_at ?? t} label />. The tripwire stayed clear.
        </p>
      ) : s.status === 'dismissed' ? (
        <p className="lfc-done">
          Dismissed <MetTime t={s.closed_at ?? t} label />: {s.dismiss_reason}
        </p>
      ) : escalated ? (
        <div className="lfc-escalated">
          <SeverityBadge severity={openingSeverity(view)} label="Escalated: queued for flight-surgeon review" size="lg" />
          <p>
            The tripwire tripped at <MetTime t={s.closed_at ?? t} label />. The ground packet is queued and sends itself when a link exists. You do not need to wait for
            an answer to keep following the procedure.
          </p>
        </div>
      ) : (
        <p className="lfc-fine">Not closed. The tripwire decides: clear → resolved; tripped → escalated to the flight surgeon with the ground packet.</p>
      )}
      {s.status !== 'idle' ? (
        <div className="lfc-packet" data-queued={escalated || undefined}>
          <p className="lfc-k">Ground packet (FHIR R4, delay-tolerant)</p>
          <p>
            {escalated ? 'Queued: ' : 'Prepared, not queued: '}
            {n !== null ? (
              <>
                <Num value={n} /> observations of {view.crewId}
              </>
            ) : (
              <span className="lfc-missing">packet unavailable ({packet.error ?? packet.status})</span>
            )}
            {def.escalation?.observations?.length ? <span className="lfc-fine"> ({def.escalation.observations.join(', ')})</span> : null}.
            {packet.withheld.length ? <span className="lfc-fine"> Withheld by consent: {packet.withheld.join(', ')}.</span> : null}
          </p>
          <p className="lfc-fine">
            Houston: {comms.blocked ? (
              <>
                no link (solar conjunction); link back in <span className="lf-num">{comms.resumes_at !== null ? formatCountdown(comms.resumes_at - t) : '—'}</span>, earliest
                reply <span className="lf-num">{formatEarliestReply(comms)}</span>.
              </>
            ) : (
              <>
                link up; earliest reply <span className="lf-num">{formatEarliestReply(comms)}</span>.
              </>
            )}
          </p>
          <ButtonLink href={href} variant={escalated ? 'primary' : 'secondary'}>
            Open the ground packet
          </ButtonLink>
        </div>
      ) : null}
      {isOpen(s.status) ? (
        <Expander summary="Dismiss this case (with a reason)">
          <form
            className="lfc-outcome"
            onSubmit={(e) => {
              e.preventDefault()
              if (reason.trim()) onDismiss(reason.trim())
              setReason('')
            }}
          >
            <label htmlFor="lfc-dismiss">Why is this case not needed?</label>
            <input id="lfc-dismiss" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button type="submit" variant="secondary" disabled={!reason.trim()}>
              Dismiss for {view.crewId}
            </Button>
          </form>
        </Expander>
      ) : null}
    </Panel>
  )
}

// =============================================================================================
// Boundary + refusals
// =============================================================================================

function BoundaryPanel({ def }: { def: CaseDefFull }) {
  const vol1 = useSnapshot<StdData>('std_vol1_requirements')
  const vol2 = useSnapshot<StdData>('std_vol2_requirements')
  return (
    <Panel title="What LANDFALL cannot see here, and will not do" eyebrow="Boundary" id="case-boundary">
      <div className="lfc-grid2">
        <section aria-labelledby="lfc-nm-h">
          <h3 id="lfc-nm-h" className="lfc-h3">
            Not measurable here: hand-offs
          </h3>
          <ul className="lfc-nm">
            {(def.not_measurable_here ?? []).map((x) => {
              const req = findRequirement(x.requirement_id, vol1.data, vol2.data)
              return (
                <li key={x.what}>
                  <strong>{x.what}</strong> → {x.via}
                  {x.requirement_id ? (
                    <>
                      {' '}
                      <ReqId id={x.requirement_id} />
                    </>
                  ) : null}
                  {req?.text ? (
                    <Expander summary="Requirement text (verbatim)">
                      <p>{req.text}</p>
                    </Expander>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
        <section aria-labelledby="lfc-ref-h">
          <h3 id="lfc-ref-h" className="lfc-h3">
            Refusals
          </h3>
          <ul className="lfc-refusals">
            {(def.refusals ?? []).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      </div>
    </Panel>
  )
}
