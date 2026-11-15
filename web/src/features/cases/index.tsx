// #/case and #/case/:id - the ACT loop:
//   detect -> interpret -> ONE primary countermeasure (alternatives collapsed) -> guided procedure
//   (magenta; required steps must be done or declined with a reason; a red-flag "yes" escalates at once)
//   -> outcome -> tripwire armed (countdown on the mission clock) -> resolved | escalated (tier 1, the
//   onboard Crew Medical Officer, now; tier 2, the flight surgeon, through the ground packet: #/downlink).
// Every state is the engine's caseReduce fold (useCases); this view only reads it and dispatches
// SELECT / STEP / DECLINE / OUTCOME / DISMISS. Every number is from the rules JSON, a snapshot or the engine.
// LANDFALL runs three deep cases; other findings show their limit and one action (D11), listed on #/case.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RULES, getIndicator, getRule } from '../../app/engine'
import type { CaseState, Finding, FindingAction, Indicator, Op } from '../../app/engine'
import { CASE_DEFS } from '../../app/caseTimeline'
import type { CaseView } from '../../app/caseTimeline'
import { useComms } from '../../app/comms'
import { useSnapshot } from '../../app/data'
import { chanceDiffers, chanceRateOf } from '../../app/evaluate'
import type { CrewEvaluation, MissionEvaluation, PersonalEvaluation, RuleEvaluation } from '../../app/evaluate'
import { navigate } from '../../app/location'
import { metClock, useMetClock, useMission } from '../../app/mission'
import { useCases, useEvaluation, useScenario } from '../../app/model'
import type { CaseEventInput } from '../../app/model'
import { overdueOf } from '../../app/procedureAlerts'
import type { FeatureProps } from '../../app/router'
import { environment } from '../../app/scenario'
import { observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex, SimCrewData } from '../../app/scenarioData'
import { CREW_IDS, SEVERITY_RANK, crewMember, isCrewId } from '../../app/vocab'
import type { CrewId, EnvId, Observation, Severity } from '../../app/vocab'
import { Button, CategoryBadge, Chip, EmptyState, Expander, FindingBadge, FreshnessChip, MetTime, Num, Panel, ReqId, SeverityBadge, SimulatedMarker } from '../../ui'
import { opsLevelOf } from '../../ui/badges'
import { PrintCardLink } from '../cuecard/PrintLink'
import './cases.css'
import { ClosePanel, TripwirePanel } from './closing'
import { PendingEntries } from './entry'
import {
  HRR_MISSION_TYPE,
  OP_TEXT,
  OP_WORDS,
  OUTSIDE_OP,
  STATUS_WORD,
  chanceOpening,
  findRequirement,
  hrrIdsOf,
  hrrRows,
  humanize,
  isOpen,
  lastN,
  latestAtOrBefore,
  basisSummary,
  meetsCondition,
  nextOpenStep,
  pendingRequired,
  pickCrew,
  refLabel,
  sortByUrgency,
  stagesOf,
  stepState,
  tripwireJumpTarget,
} from './model'
import type { Stage, StdData } from './model'
import { RenalPanel, RuleRow, SleepPanel, SpePanel } from './panels'
import { detectedCopy, jumpTo, openingNote, rejectionWords } from './helpers'
import { BandRange, ChanceLine, ChanceNoteBlock, EventLog, KindChip, MdcText, PersonalBadge, PersonalWhy, RefsProvider, RuleWhy, SourceBlock, TargetReached, arrowFor } from './parts'
import type { CaseRefs } from './parts'
import { OutcomePanel, ProcedurePanel } from './procedure'
import type { ActCtx, OutcomeDraft, StepInput } from './procedure'
import { CaseStatusBadge, NowCard } from './status'
import type { CaseDefFull, CmDef, HrpHazard, HrpRisk, HrrRisk, MetaHazard, SimSelfCheck, StepDef } from './types'

const defOf = (v: CaseView) => v.def as unknown as CaseDefFull

type SimWithCheck = SimCrewData & { self_check?: SimSelfCheck; variables?: Record<string, { label?: string } | undefined> }

// =============================================================================================
// Route
// =============================================================================================

export default function Cases({ params, query }: FeatureProps) {
  const cases = useCases()
  const { state, setCrew } = useMission()
  const vol1 = useSnapshot<StdData>('std_vol1_requirements')
  const vol2 = useSnapshot<StdData>('std_vol2_requirements')
  const sScale = useSnapshot<{ levels?: [] }>('swpc_s_scale')
  const refs = useMemo<CaseRefs>(() => ({ vol1, vol2, sScale }), [vol1, vol2, sScale])

  // A case page that names its crewmember (#/case/spe_shelter?crew=CM-3: the crew tabs, the case list, the alert bar)
  // selects that crewmember in the mission bar too, as #/body?crew= does, so the bar, the page and Noon Sight name the
  // same person. Without ?crew= the page follows the bar (pickCrew), as before.
  const caseId = params.id
  const qCrew = caseId ? query.crew : undefined
  useEffect(() => {
    if (isCrewId(qCrew) && qCrew !== state.crewId) setCrew(qCrew)
    // only when the route's crewmember changes: the bar stays free to pick another one (below)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, qCrew])
  // ...and the other way: a crewmember picked in the mission bar moves a page that names one in ?crew= to that
  // crewmember (the address is replaced, not pushed). Only a change of the bar's value counts, so the sync above
  // (route -> bar) never bounces back.
  const barCrew = useRef(state.crewId)
  useEffect(() => {
    const was = barCrew.current
    barCrew.current = state.crewId
    if (was === state.crewId || !caseId || !isCrewId(qCrew) || qCrew === state.crewId) return
    const q = new URLSearchParams(query)
    q.set('crew', state.crewId)
    navigate(`/case/${caseId}?${q.toString()}`, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.crewId])

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
  if (!params.id) {
    return (
      <RefsProvider value={refs}>
        <CaseList views={cases.cases} storeCrew={state.crewId} t={cases.t} />
      </RefsProvider>
    )
  }
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
      <PendingEntries key={view.key}>
        <CaseDetail view={view} all={cases.cases} t={cases.t} dispatch={cases.dispatch} />
      </PendingEntries>
    </RefsProvider>
  )
}

// =============================================================================================
// #/case: the three deep cases x four crewmembers, most urgent first; then the findings without a case
// =============================================================================================

function CaseList({ views, storeCrew, t }: { views: CaseView[]; storeCrew: CrewId; t: number }) {
  const { evaluation } = useEvaluation()
  const defs = sortByUrgency(CASE_DEFS as unknown as CaseDefFull[], views)
  return (
    <div className="lfc">
      <header className="lfc-head">
        <p className="lf-eyebrow">Act</p>
        <h1>Cases</h1>
        <p className="lfc-lede">
          LANDFALL runs three deep cases. Each opens when one of its triggers reaches caution: detect, interpret in plain words, one primary countermeasure,
          a guided procedure whose required steps must be done or declined with a reason, an outcome, then a tripwire that resolves the case or escalates
          it: first to the onboard Crew Medical Officer (the Commander when the Crew Medical Officer is the patient), then to the flight surgeon through
          the ground packet. Other findings show their limit and one
          action (listed below the cases). No diagnosis, no medication advice.
        </p>
        {/* Paper cue cards ([V2 10130]) for when the display is lost, with the rules digest that marks a stale card. */}
        <PrintCardLink />
        <SimulatedMarker variant="banner">Crew values and crew actions are simulated. The rules, limits and NASA/NOAA text are real.</SimulatedMarker>
      </header>
      <p className="lfc-fine">
        Most urgent first: a warning before a caution, then a case still waiting for its start, then crew-wide cases. A case opened by a single
        personal flag (one indicator, one day) says <span className="lfc-possibly-tag">possibly chance</span>, with how often that indicator flags
        with no real change; a re-measure checks it. A case that closed opens again as a new instance when a new episode starts.
      </p>
      <ul className="lfc-list">
        {defs.map((def) => {
          const mine = CREW_IDS.map((c) => views.find((v) => v.caseId === def.id && v.crewId === c)!).filter(Boolean)
          const lead = mine.find((v) => v.crewId === pickCrew(def.id, views, undefined, storeCrew)) ?? mine[0]
          const wide = (def.triggers ?? []).some((x) => x.kind === 'ops')
          return (
            <li key={def.id} className="lfc-list-item">
              <article className="lf-card" data-severity={lead && (isOpen(lead.state.status) || lead.state.status === 'escalated') ? severityOf(lead) : undefined}>
                <header className="lfc-list-head">
                  <h2 className="lfc-list-title">
                    <a href={`#/case/${def.id}?crew=${lead?.crewId ?? storeCrew}`}>{def.title}</a>
                  </h2>
                  {lead ? <CaseStatusBadge view={lead} /> : null}
                </header>
                <p>{def.one_line}</p>
                <p className="lfc-fine">
                  {wide ? 'Crew-wide: one reading opens it for every crewmember. ' : null}NASA HRP risk:{' '}
                  <a href={def.hrp_risk?.url} target="_blank" rel="noopener noreferrer">
                    {def.hrp_risk?.title}
                  </a>
                </p>
                <ul className="lfc-crew-row" aria-label={`${def.title}: status per crewmember`}>
                  {mine.map((v) => {
                    // the alert bar's own rule and words (app/procedureAlerts overdueOf), at the case fold MET
                    const overdue = overdueOf(v, t)
                    return (
                      <li key={v.key} className="lfc-crew-item">
                        <a href={`#/case/${def.id}?crew=${v.crewId}`} className="lfc-crew-link">
                          <span className="lf-mono">{v.crewId}</span>
                          <CaseStatusBadge view={v} size="sm" />
                          {v.state.opened_at !== null ? (
                            <span className="lfc-fine">
                              {v.state.instance > 1 ? 'opened again' : 'opened'} <MetTime t={v.state.opened_at} label />
                              {v.state.instance > 1 ? <> (instance <Num value={v.state.instance} />)</> : null}
                            </span>
                          ) : null}
                          {overdue ? (
                            <span className="lfc-fine lfc-crew-overdue" data-overdue="">
                              <SeverityBadge severity="caution" label="Reassessment overdue" size="sm" />{' '}
                              <span className="lfc-nowrap">
                                since <MetTime t={overdue.since} label />
                              </span>
                            </span>
                          ) : null}
                          {v.chance ? <span className="lfc-possibly-tag">possibly chance</span> : null}
                        </a>
                        {v.chance ? <p className="lfc-crew-chance">{v.chance.text}.</p> : null}
                      </li>
                    )
                  })}
                </ul>
              </article>
            </li>
          )
        })}
      </ul>
      <FindingsWithoutCase evaluation={evaluation} />
    </div>
  )
}

const severityOf = (v: CaseView): Severity => ((v.state.finding?.severity ?? v.opening?.finding.severity ?? 'caution') as Severity) || 'caution'

interface ActionItem {
  key: string
  crewId: CrewId
  label: string
  action: FindingAction
  finding: Finding
  unit: string
  op: string | null
  limit: number | null
  sourceId: string
  rule?: RuleEvaluation
  personal?: PersonalEvaluation
}

/** The action text without a leading repeat of its own label ("EVA fitness floor not met: ..."). */
const actionBody = (a: FindingAction) => {
  const head = `${a.label}:`
  const rest = a.text.startsWith(head) ? a.text.slice(head.length).trim() : a.text
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

const atCaution = (f: Finding) => SEVERITY_RANK[f.severity as Severity] >= SEVERITY_RANK.caution

function actionItems(evaluation: MissionEvaluation | null): ActionItem[] {
  if (!evaluation) return []
  const out: ActionItem[] = []
  for (const crewId of CREW_IDS) {
    const ce: CrewEvaluation = evaluation.crew[crewId]
    for (const r of ce.tierA) {
      if (!r.rule.action || !atCaution(r.finding)) continue
      out.push({ key: `${crewId}:${r.rule.id}`, crewId, label: r.rule.label ?? r.rule.id, action: r.rule.action, finding: r.finding, unit: r.rule.unit, op: r.rule.op, limit: r.rule.limit, sourceId: r.rule.id, rule: r })
    }
    for (const p of ce.tierB) {
      if (!p.indicator.action || !atCaution(p.finding)) continue
      out.push({ key: `${crewId}:${p.indicator.id}`, crewId, label: p.indicator.label ?? p.indicator.id, action: p.indicator.action, finding: p.finding, unit: p.indicator.unit, op: null, limit: p.finding.limit, sourceId: p.indicator.id, personal: p })
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[b.finding.severity as Severity] - SEVERITY_RANK[a.finding.severity as Severity] || a.crewId.localeCompare(b.crewId))
}

/** Every alerting rule and indicator that ends in one action rather than a deep case (D11). */
function allActionSources(): Array<{ id: string; label: string; action: string; kind: 'rule' | 'indicator' }> {
  const rules = (RULES.thresholds?.rules ?? []).filter((r) => r.action).map((r) => ({ id: r.id, label: r.label ?? r.id, action: r.action!.label, kind: 'rule' as const }))
  const inds = (RULES.personal?.indicators ?? []).filter((i) => i.action).map((i) => ({ id: i.id, label: i.label ?? i.id, action: i.action!.label, kind: 'indicator' as const }))
  return [...rules, ...inds]
}

function FindingsWithoutCase({ evaluation }: { evaluation: MissionEvaluation | null }) {
  const items = useMemo(() => actionItems(evaluation), [evaluation])
  const all = useMemo(() => allActionSources(), [])
  return (
    <Panel title="Findings without a deep case" eyebrow="Limit and one action" id="cases-other">
      <p>
        These findings have no guided case. Each shows its limit, one action and who decides; none is a diagnosis. Listed at caution or above, for every
        crewmember, at the mission clock.
      </p>
      {items.length ? (
        <ul className="lfc-rows">
          {items.map((x) => (
            <li key={x.key} className="lfc-row lfc-action-row">
              <div className="lfc-row-head">
                <span className="lfc-row-label">
                  <span className="lf-mono">{x.crewId}</span> {x.action.label}
                </span>
                <span className="lfc-row-val">
                  {x.label}: <Num value={x.finding.value} unit={x.unit} /> <span className="lfc-vs">{x.personal ? 'band edge' : 'vs'}</span>{' '}
                  {x.op ? <span className="lf-num">{OP_TEXT[x.op as keyof typeof OP_TEXT]}</span> : null} <Num value={x.limit} unit={x.unit} />
                </span>
                <FindingBadge finding={x.finding} />
              </div>
              <p className="lfc-action-text">
                {actionBody(x.action)} <Chip kind={x.action.chip} />
              </p>
              <p className="lfc-fine">
                <CategoryBadge category={x.finding.category} /> <Chip kind={x.finding.chip} />{' '}
                {x.personal && typeof x.personal.finding.rci?.mdc === 'number' ? (
                  <>
                    Smallest change this band can flag: <MdcText finding={x.personal.finding} />.{' '}
                  </>
                ) : null}
                {x.personal && chanceDiffersFor(x.personal.indicator) ? (
                  <>
                    <ChanceLine indicator={x.personal.indicator} />{' '}
                  </>
                ) : null}
                <a href={`#/provenance?id=${encodeURIComponent(x.sourceId)}`}>Limit, source and provenance</a> ·{' '}
                <a href={`#/trends?crew=${x.crewId}`}>Trends for {x.crewId}</a>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="lfc-fine">{evaluation ? 'None at caution or above for any crewmember at the mission clock.' : 'Evaluating…'}</p>
      )}
      <Expander summary={`Every rule and indicator that ends in one action (${all.length})`}>
        <ul className="lfc-action-all">
          {all.map((a) => (
            <li key={a.id}>
              {a.label} → <strong>{a.action}</strong>
            </li>
          ))}
        </ul>
      </Expander>
    </Panel>
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

const PLAIN_ERROR_LEAD: Record<string, string> = {
  required_steps_pending: 'Outcome not logged: required steps are still open.',
}

function CaseDetail({ view, all, t, dispatch }: DetailProps) {
  const def = defOf(view)
  const { state: mission, addObservations } = useMission()
  const scenario = useScenario()
  const { evaluation } = useEvaluation()
  const comms = useComms()
  const clock = useMetClock()
  const envId = mission.envId
  const env = environment(envId)
  const crew = crewMember(view.crewId)
  const s = view.state
  const crewEval = evaluation?.crew[view.crewId] ?? null
  const index = scenario.index
  const runtime = mission.observations
  const shared = (def.triggers ?? []).some((x) => x.kind === 'ops')
  const [allCrew, setAllCrew] = useState(true)
  // where the tripwire demo jump was clicked (the status card or the tripwire panel); read once the fold catches up
  const jump = useRef<null | 'banner' | 'panel'>(null)
  const [outcomeText, setOutcomeText] = useState('')
  const sim = useSnapshot<SimWithCheck>('sim_crew')
  const replay = useSnapshot('swpc_spe_replay')
  const vol2 = useSnapshot<StdData>('std_vol2_requirements')

  const peers = all.filter((v) => v.caseId === view.caseId)
  const sharedAll = shared && allCrew
  const crews = (status: CaseState['status'], extra?: (v: CaseView) => boolean): CrewId[] =>
    sharedAll ? peers.filter((v) => v.state.status === status && (!extra || extra(v))).map((v) => v.crewId) : [view.crewId]

  const send = (event: CaseEventInput, targets: CrewId[]) => {
    const tt = metClock.get().metNow
    for (const c of targets) dispatch(view.caseId, { ...event, t: tt } as CaseEventInput, c)
  }

  const latest = (variable: string): Observation | null => (index ? latestAtOrBefore(observationsFor(index, runtime, view.crewId, variable), t, view.crewId) : null)
  const recent = (variable: string, n: number): Observation[] => (index ? lastN(observationsFor(index, runtime, view.crewId, variable), t, n, view.crewId) : [])

  /** A value typed or confirmed by the crew: stamped at the clock minute so evaluation and tripwire see it at once. */
  const logObservation = (variable: string, value: number, unit: string, crewIds: CrewId[] = [view.crewId]): number => {
    const tt = Math.floor(metClock.get().metNow / 60) * 60
    addObservations(crewIds.map((c) => ({ crew_id: c, variable, value, unit, t: tt, source: 'manual', provenance: 'manual' })))
    return tt
  }

  const c: ActCtx = {
    def,
    state: s,
    crewId: view.crewId,
    sharedAll,
    sharedCount: sharedAll ? peers.filter((v) => v.state.status === 'acting').length : 1,
    comms,
    t,
    latest,
    recent,
    onStep: (step: StepDef, input?: StepInput, record?: number) => {
      // crew-wide: a step with no input, a vehicle-sensor reading, a shelter-entry time; a personal value stays personal
      const fromVehicle = !!input && record === undefined && latest(input.variable)?.crew_id === null
      const crewWide = !input || fromVehicle || input.unit === 'MET'
      const targets = crewWide ? crews('acting', (v) => stepState(v.state, step.id) !== 'done') : [view.crewId]
      let inp = input
      if (input && record !== undefined) inp = { ...input, t: logObservation(input.variable, record, input.unit, crewWide ? targets : [view.crewId]) }
      send({ type: 'STEP', step_id: step.id, ...(inp ? { input: inp } : {}) }, targets)
    },
    onDecline: (step: StepDef, reason: string) => {
      send({ type: 'DECLINE', step_id: step.id, reason }, crews('acting', (v) => stepState(v.state, step.id) === 'open'))
    },
  }

  // shared case: an outcome goes to every acting crewmember whose required steps are settled
  const actingPeers = sharedAll ? peers.filter((v) => v.state.status === 'acting') : peers.filter((v) => v.crewId === view.crewId && v.state.status === 'acting')
  const readyPeers = actingPeers.filter((v) => pendingRequired(v.state).length === 0).map((v) => v.crewId)
  const blockedPeers = actingPeers.filter((v) => v.crewId !== view.crewId && pendingRequired(v.state).length > 0).map((v) => v.crewId)
  const outcome: OutcomeDraft = { text: outcomeText, setText: setOutcomeText, submit: (text) => send({ type: 'OUTCOME', text }, readyPeers), readyPeers, blockedPeers }

  const doJump = (origin: 'banner' | 'panel') => {
    if (s.reassess_at === null) return
    jump.current = origin
    clock.set(tripwireJumpTarget(s.reassess_at))
  }
  // After the demo jump: once the fold has reached the reassessment, scroll to the verdict (or to "due").
  useEffect(() => {
    const origin = jump.current
    if (!origin) return
    const judged = s.status !== 'watch'
    const due = s.reassess_at !== null && t >= s.reassess_at
    if (!judged && !due) return
    jump.current = null
    const id = judged ? `lfc-verdict-${origin}` : `lfc-due-${origin}`
    requestAnimationFrame(() => {
      const el = document.getElementById(id)
      if (!el) return
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
      el.focus({ preventScroll: true })
    })
  }, [s.status, s.reassess_at, t])

  const stages = stagesOf(s)
  const ctxProps = index && crewEval && evaluation ? { def, crewId: view.crewId, envId, t, index, runtime, crew: crewEval, evaluation } : null
  const chance = chanceOpening(sim.data?.self_check, view.crewId, view.caseId, s.opened_at)
  const lastLog = s.log.length ? s.log[s.log.length - 1] : null
  const sharedNote = shared ? (
    <p className="lfc-fine">
      {sharedAll
        ? `Shared steps go to every crewmember with this case open (set at the top of the page); personal readings stay personal.`
        : `Steps go to ${view.crewId} only (set at the top of the page).`}
    </p>
  ) : null

  return (
    <article className="lfc" aria-labelledby="lfc-title">
      {/* On a phone (cases.css, max-width 640px) the crew tabs and the status card come right under the title, before
          the lede, the print link, the simulated banner and the stepper; the order of the markup, and the desktop
          layout, stay as they are. */}
      <header className="lfc-head lfc-head-case">
        <p className="lf-eyebrow lfc-head-eyebrow">
          Case · {crew.id} {crew.role} · {env.label}
        </p>
        <h1 id="lfc-title">{def.title}</h1>
        <p className="lfc-lede">{def.one_line}</p>
        <PrintCardLink caseId={def.id} />
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
        <NowCard
          view={view}
          def={def}
          c={c}
          onSelect={(id) => send({ type: 'SELECT', countermeasure_id: id }, crews('detected'))}
          startCount={sharedAll ? peers.filter((v) => v.state.status === 'detected').length : 1}
          shared={shared}
          allCrew={allCrew}
          setAllCrew={setAllCrew}
          onJump={() => doJump('banner')}
          chance={chance}
          outcome={outcome}
        />
        <p className="sr-only" aria-live="polite">
          {`${crew.id} ${def.title}: ${STATUS_WORD[s.status]}.`}
          {lastLog?.error ? ` ${PLAIN_ERROR_LEAD[lastLog.error] ?? `Last action rejected: ${rejectionWords(lastLog.error)}.`}` : ''}
        </p>
        <LoopStepper stages={stages} />
      </header>

      <DetectPanel view={view} crewEval={crewEval} evaluation={evaluation} index={index} chance={chance} />
      <InterpretPanel def={def} envId={envId} actFirst={s.status === 'detected'} />
      <CountermeasurePanel
        def={def}
        state={s}
        onSelect={(id) => send({ type: 'SELECT', countermeasure_id: id }, crews('detected'))}
        sharedNote={sharedAll ? peers.filter((v) => v.state.status === 'detected').length : 0}
      />
      <ProcedurePanel c={c} sharedNote={sharedNote} current={s.status === 'acting' ? nextOpenStep(s) : null} />
      <OutcomePanel c={c} draft={outcome} />
      <TripwirePanel
        c={c}
        def={def}
        view={view}
        onJump={() => doJump('panel')}
        logReading={(v) => {
          const cond = s.spec.tripwire.condition
          logObservation(cond.variable, v, cond.unit)
        }}
      />
      <ClosePanel c={c} def={def} view={view} onDismiss={(reason) => send({ type: 'DISMISS', reason }, [view.crewId])} />

      {ctxProps && def.id === 'renal_stone' ? <RenalPanel {...ctxProps} /> : null}
      {ctxProps && def.id === 'sleep_circadian' ? <SleepPanel {...ctxProps} vol2={vol2} /> : null}
      {ctxProps && def.id === 'spe_shelter' ? <SpePanel {...ctxProps} sim={sim} replay={replay} /> : null}

      <BoundaryPanel def={def} />
      <CaseLogPanel view={view} footer={<FreshnessChip meta={sim.snapshot} status={sim.status} id="sim_crew" />} />
    </article>
  )
}

/** How many of the latest log entries show at once; the earlier ones wait in an expander (a display choice). */
const LOG_LATEST = 5

/**
 * The event log: the latest entries in the table, the earlier ones in a closed "Earlier entries (N)" expander above
 * it (still in the page, in order). The log and its origins are sliced together, so every row keeps its "By".
 */
export function CaseLogPanel({ view, footer }: { view: CaseView; footer?: ReactNode }) {
  const def = defOf(view)
  const log = view.state.log
  const cut = Math.max(0, log.length - LOG_LATEST)
  return (
    <Panel title="Event log" eyebrow="Engine record" id="case-log" footer={footer}>
      <p className="lfc-fine">
        Every line is an engine transition, with MET. Rule, step and countermeasure names replace their IDs (a rule’s or indicator’s ID is on
        Provenance, linked under “Why this fired”). Rejected actions stay in the record with the reason.
      </p>
      {cut > 0 ? (
        <Expander summary={`Earlier entries (${cut})`}>
          <EventLog log={log.slice(0, cut)} origins={view.logOrigins.slice(0, cut)} def={def} caption="Case event log, earlier entries" />
        </Expander>
      ) : null}
      <EventLog
        log={log.slice(cut)}
        origins={view.logOrigins.slice(cut)}
        def={def}
        caption={cut > 0 ? 'Case event log, latest entries' : 'Case event log'}
      />
    </Panel>
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

function LoopStepper({ stages }: { stages: Stage[] }) {
  return (
    <ol className="lfc-stepper" aria-label="Case loop">
      {stages.map((st, i) => (
        <li key={st.id} data-state={st.state}>
          <button type="button" onClick={() => jumpTo(STAGE_TARGET[st.id])} aria-current={st.state === 'current' ? 'step' : undefined}>
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

/** True when the engine's chance rate of this indicator is measured and differs from the nominal one (S3). */
const chanceDiffersFor = (ind: Indicator): boolean => {
  const r = chanceRateOf(ind)
  return !!r && chanceDiffers(r)
}

/**
 * The end of the opening sentence for an OPS rule: the reading against a NOAA S-scale threshold (at Mars, NOAA's
 * number reused: a design choice, as its chip says), never "the limit". The level is the rule's (opsLevelOf), the
 * words follow the rule's op: "read 1050 pfu: at or above NOAA’s S3 level (≥ 1000 pfu)."
 */
function OpsReached({ finding, op, unit }: { finding: Finding; op: Op; unit: string | undefined }) {
  const n = opsLevelOf(finding)
  const cond = finding.status === 'outside' ? OUTSIDE_OP[op] : op
  const level = n !== null ? `NOAA’s S${n} level` : 'the threshold'
  return (
    <>
      : {OP_WORDS[cond]} {level} (<span className="lf-num">{OP_TEXT[cond]}</span> <Num value={finding.limit} unit={unit} />).
    </>
  )
}

const CLOSED_WORD: Record<string, string> = { resolved: 'resolved', escalated: 'escalated', dismissed: 'dismissed' }

/** The closed instances of this case for this crewmember, oldest first (engine previous_instances). */
function EarlierInstances({ view }: { view: CaseView }) {
  const s = view.state
  return (
    <>
      <h3 className="lfc-h3">Earlier instances of this case for {view.crewId}</h3>
      <p className="lfc-fine">
        A case that closed opens again as a new instance when a new episode starts (a trigger reaches caution after the close). The event log below
        runs on across instances.
      </p>
      <ol className="lfc-instances">
        {s.previous_instances.map((p) => {
          const info = view.instances.find((i) => i.instance === p.instance)
          return (
            <li key={p.instance}>
              Instance <Num value={p.instance} />: opened {p.opened_at !== null ? <MetTime t={p.opened_at} label /> : '—'}
              {p.finding ? <> by {refLabel(p.finding.rule_id)}</> : null}, {CLOSED_WORD[p.status] ?? p.status}{' '}
              {p.closed_at !== null ? <MetTime t={p.closed_at} label /> : null}
              {p.outcome?.text ? <> · outcome: “{p.outcome.text}”</> : null}
              {p.dismiss_reason ? <> · reason: “{p.dismiss_reason}”</> : null}
              {info?.chance ? (
                <>
                  {' '}
                  · <span className="lfc-possibly-tag">possibly chance</span> a single flag
                </>
              ) : null}
            </li>
          )
        })}
      </ol>
    </>
  )
}

/**
 * "· at or past this case’s tripwire line (≥ 4)", after a trigger's latest value, when that value meets the case's
 * tripwire condition (state.spec.tripwire.condition, after by_env; the engine's own compare via meetsCondition), with
 * the tripwire's chip (a design choice). Only on the variable the tripwire watches. Context, not a verdict: the
 * tripwire judges only after the outcome, on its own last readings.
 */
function TripwireLine({ def, state, variable, value }: { def: CaseDefFull; state: CaseState; variable: string; value: number | null }) {
  const cond = state.spec.tripwire.condition
  if (value === null || cond.variable !== variable || !meetsCondition(value, cond.op, cond.value)) return null
  return (
    <span className="lfc-trip-line" data-tripwire-line="">
      {' '}
      · {cond.op === 'ge' || cond.op === 'le' ? 'at or past' : 'past'} this case’s tripwire line (<span className="lf-num">{OP_TEXT[cond.op]}</span>{' '}
      <Num value={cond.value} unit={cond.unit === 'count' ? undefined : cond.unit} />) <Chip kind={def.tripwire?.chip ?? 'design choice'} />
    </span>
  )
}

function DetectPanel({
  view,
  crewEval,
  evaluation,
  index,
  chance,
}: {
  view: CaseView
  crewEval: CrewEvaluation | null
  evaluation: MissionEvaluation | null
  index: ScenarioIndex | null
  chance: ReturnType<typeof chanceOpening>
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
  const unit = opening?.unit === 'count' ? undefined : opening?.unit
  return (
    <Panel title="1. Detect" eyebrow="Detect" id="case-detect">
      {opening ? (
        <div className="lfc-opening">
          <p>
            {s.instance > 1 ? 'Opened again' : 'Opened'} <MetTime t={s.opened_at ?? 0} label />
            {s.instance > 1 ? (
              <>
                {' '}
                (instance <Num value={s.instance} />)
              </>
            ) : null}
            : <strong>{openingRule?.label ?? openingInd?.label ?? refLabel(opening.rule_id)}</strong> read{' '}
            <Num value={opening.value} unit={unit} arrow={arrowFor(opening)} severity={opening.severity as Severity} />
            {opening.tier === 'B' ? (
              <>
                , past the edge of your personal band at <Num value={opening.limit} unit={unit} digits={2} />.
              </>
            ) : opening.category === 'OPS' && opening.op ? (
              <OpsReached finding={opening} op={opening.op} unit={unit} />
            ) : opening.category === 'TARGET' && openingRule ? (
              <TargetReached rule={openingRule} unit={unit} />
            ) : opening.op ? (
              <>
                ; the limit is met only {OP_WORDS[opening.op]} <Num value={opening.limit} unit={unit} />.
              </>
            ) : (
              '.'
            )}{' '}
            <CategoryBadge category={opening.category} /> <Chip kind={opening.chip} /> <FindingBadge finding={opening} />
          </p>
          {/* the chance rate stays in view; the test scale and the measured multipliers are under "Why this fired" */}
          {openingInd ? (
            <p className="lfc-fine lfc-chance-p">
              <ChanceLine indicator={openingInd} brief />
            </p>
          ) : null}
          {openingRule ? <RuleWhy rule={openingRule} finding={opening} /> : null}
          {openingInd && index ? <PersonalWhy indicator={openingInd} finding={opening as never} baselineDays={index.baselineDays} /> : null}
          {view.chance ? <ChanceNoteBlock note={view.chance} closed={!isOpen(s.status)} /> : null}
          {chance ? (
            <div className="lfc-chance" role="note">
              <p className="lfc-k">
                <span className="lfc-chance-tag">chance flag</span> Simulated data
              </p>
              <p>
                The simulator’s own check confirms it: this opening is a chance flag, not a scripted episode;{' '}
                {chance.scripted_opening_day !== null ? (
                  <>
                    the scripted change for {view.crewId} starts on MET day <Num value={chance.scripted_opening_day} />, and this reading on MET day{' '}
                    <Num value={chance.day} /> came first
                  </>
                ) : (
                  <>nothing is scripted for {view.crewId} in this case</>
                )}
                . The simulator’s day-to-day noise makes such flags. A mission has no such answer key, which is why LANDFALL itself labels a single flag
                as possibly chance and lets a re-measure check it.
              </p>
            </div>
          ) : null}
          {s.previous_instances.length ? <EarlierInstances view={view} /> : null}
        </div>
      ) : (
        <p>
          Not open for {view.crewId}.{' '}
          {view.opening ? (
            <>
              The data opens it at <MetTime t={view.opening.t} label />
              {openingNote(view.opening.t)}
            </>
          ) : (
            'No trigger has reached caution in the data.'
          )}
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
                  <Num value={personal.finding.value} unit={personal.indicator.unit === 'count' ? undefined : personal.indicator.unit} />{' '}
                  <span className="lfc-vs">band</span> <BandRange finding={personal.finding} />
                  {typeof personal.finding.rci?.mdc === 'number' ? (
                    <>
                      {' '}
                      <span className="lfc-vs">smallest flaggable change</span> <MdcText finding={personal.finding} />
                    </>
                  ) : null}
                  <TripwireLine def={def} state={s} variable={personal.indicator.variable} value={personal.finding.value} />
                </span>
                <PersonalBadge finding={personal.finding} />
              </div>
              {/* the chance rate stays in view; the test scale and the measured multipliers are under "How this is judged" */}
              {chanceDiffersFor(personal.indicator) ? (
                <p className="lfc-fine lfc-chance-p">
                  <ChanceLine indicator={personal.indicator} brief />
                </p>
              ) : null}
              <PersonalWhy indicator={personal.indicator} finding={personal.finding} baselineDays={index.baselineDays} />
            </li>
          ) : (
            <li key={tr.rule_id ?? tr.indicator_id} className="lfc-row">
              {refLabel(tr.rule_id ?? tr.indicator_id)} <span className="lfc-fine">not evaluated yet</span>
            </li>
          ),
        )}
      </ul>
    </Panel>
  )
}

// =============================================================================================
// 2. Interpret (closed for every status; while the case is only detected its summary says act first, read after)
// =============================================================================================

function useHrp() {
  const risks = useSnapshot<{ risks?: HrpRisk[] }>('hrp_risks')
  const roadmap = useSnapshot<{ risks?: HrrRisk[] }>('hrp_roadmap')
  const hazards = useSnapshot<{ hazards?: HrpHazard[] }>('hrp_hazards')
  return { risks, roadmap, hazards }
}

function Rating({ r }: { r?: { lxc: string; disposition: string } }) {
  if (!r) return <Num value={null} />
  return (
    <>
      <span className="lf-mono">{r.lxc}</span> {r.disposition}
    </>
  )
}

/**
 * Closed for every status (its content stays in the page): the summary names it, and while the case is only detected
 * it says to act first.
 */
export function InterpretPanel({ def, envId, actFirst }: { def: CaseDefFull; envId: EnvId; actFirst: boolean }) {
  const { risks, roadmap, hazards } = useHrp()
  const risk = risks.data?.risks?.find((r) => r.url === def.hrp_risk?.url || r.detail?.canonical_url === def.hrp_risk?.url || r.name === def.hrp_risk?.title) ?? null
  const ids = hrrIdsOf(def, risk?.detail?.hrr_risk_id)
  const hrr = ids.map((id) => (roadmap.data?.risks ?? []).find((r) => r.hrr_id === id)).filter((r): r is HrrRisk => !!r)
  const metaHazards = ((RULES.meta as { hazards?: MetaHazard[] } | null)?.hazards ?? []) as MetaHazard[]
  const missionType = HRR_MISSION_TYPE[envId]
  const content = (
    <>
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
            const rows = hrrRows(r, missionType)
            return (
              <div key={r.hrr_id} className="lfc-hrr">
                <p>
                  Human Research Roadmap:{' '}
                  <a href={r.url} target="_blank" rel="noopener noreferrer">
                    {r.title}
                  </a>{' '}
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
                  <div className="lfc-table-wrap" tabIndex={0} role="region" aria-label={`NASA’s rating of ${r.title} for ${missionType} missions, scrollable`}>
                    <table className="lfc-table lfc-hrr-table">
                      <caption>
                        NASA’s rating of this risk for {missionType} missions, both columns as published (LxC: likelihood × consequence).
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Mission duration</th>
                          <th scope="col">In-mission (operations)</th>
                          <th scope="col">Long-term health</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((x) => (
                          <tr key={x.duration}>
                            <th scope="row">{x.duration}</th>
                            <td>
                              <Rating r={x.operations} />
                            </td>
                            <td>
                              <Rating r={x.long_term_health} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {rows.length && r.detail?.ratings_note ? <p className="lfc-fine">{r.detail.ratings_note}</p> : null}
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
                  <strong>
                    {snap ? (
                      <a href={snap.url} target="_blank" rel="noopener noreferrer">
                        {m?.label ?? snap.name}
                      </a>
                    ) : (
                      (m?.label ?? humanize(h))
                    )}
                  </strong>
                  {snap?.summary ? <span className="lfc-fine"> “{snap.summary}”</span> : null}
                </li>
              )
            })}
          </ul>
          <p className="lfc-fine">
            Hazard footprint on the body map (where this hazard can act; drawn hatched, not a finding):{' '}
            {(def.body_regions ?? []).map((r, i) => (
              <span key={r}>
                {i ? ' · ' : ''}
                <a href={`#/body?region=${r}`}>{humanize(r)}</a>
              </span>
            ))}
          </p>
        </section>
      </div>
    </>
  )
  return (
    <Panel
      title="2. Interpret"
      eyebrow="Interpret"
      id="case-interpret"
      footer={
        <>
          {/* Each chip names its snapshot (the source's own name): three bare, identical date chips read as one glitch. */}
          {[
            { s: risks, id: 'hrp_risks' },
            { s: roadmap, id: 'hrp_roadmap' },
            { s: hazards, id: 'hrp_hazards' },
          ].map(({ s, id }) => (
            <span key={id} className="lfc-fresh-item">
              {s.snapshot?.source?.name ? <span className="lfc-fine">{s.snapshot.source.name}</span> : null}{' '}
              <FreshnessChip meta={s.snapshot} status={s.status} id={id} source={s.snapshot?.source} compact />{' '}
            </span>
          ))}
        </>
      }
    >
      <Expander summary={`What this means, in plain words${actFirst ? ' (act first: start the countermeasure above, read this after)' : ''}`}>{content}</Expander>
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
      {cm.citations?.length ? (
        <ul className="lfc-cites">
          {cm.citations.map((x, i) => (
            <li key={i}>
              <KindChip kind={x.kind} /> <SourceBlock source={x as never} compact />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/**
 * 3. The one primary countermeasure: its title and the Start button (or what was selected) in view; its rationale,
 * chip and verbatim sources in a closed "Why this countermeasure" expander, still in the page; the alternatives in
 * "Other options".
 */
export function CountermeasurePanel({ def, state, onSelect, sharedNote }: { def: CaseDefFull; state: CaseState; onSelect: (id: string) => void; sharedNote: number }) {
  const cm = def.countermeasure
  if (!cm) return null
  const chosen = state.countermeasure_id
  const canSelect = state.status === 'detected'
  const selectLog = state.log.find((e) => e.event === 'SELECT' && e.error === null)
  const alts = cm.alternatives ?? []
  // A procedure that opens with its red-flag question (renal r4) starts with that question, as the status card says:
  // the button never reads "Start: drink more" before retention, flank pain or fever is asked about.
  const copy = detectedCopy(def, sharedNote)
  return (
    <Panel title="3. Countermeasure" eyebrow="Act" id="case-act">
      <div className="lfc-cm" data-chosen={chosen === cm.primary.id || undefined}>
        <p className="lfc-k">Primary countermeasure</p>
        <h3 className="lfc-cm-title">{cm.primary.title}</h3>
        {canSelect ? (
          <Button onClick={() => onSelect(cm.primary.id)}>
            {copy.redFlagFirst ? (
              copy.button
            ) : (
              <>
                Start: {cm.primary.title}
                {sharedNote > 1 ? ` (all ${sharedNote} crewmembers)` : ''}
              </>
            )}
          </Button>
        ) : chosen ? (
          <p className="lfc-done">
            Selected
            {selectLog?.t !== null && selectLog?.t !== undefined ? (
              <>
                {' '}
                at <MetTime t={selectLog.t} label />
              </>
            ) : null}
            : {chosen === cm.primary.id ? 'the primary countermeasure' : `alternative “${alts.find((a) => a.id === chosen)?.title ?? chosen}”`}.
          </p>
        ) : state.status === 'idle' ? (
          <p className="lfc-fine">Available once the case opens.</p>
        ) : null}
        <Expander summary={basisSummary(cm.primary)}>
          <CmBody cm={cm.primary} />
        </Expander>
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
// Boundary + refusals
// =============================================================================================

/** The case's boundary: each list in a closed expander that carries its count (the lists stay in the page). */
export function BoundaryPanel({ def }: { def: CaseDefFull }) {
  const vol1 = useSnapshot<StdData>('std_vol1_requirements')
  const vol2 = useSnapshot<StdData>('std_vol2_requirements')
  const handOffs = def.not_measurable_here ?? []
  const refusals = def.refusals ?? []
  return (
    <Panel title="Boundary: not measurable here, and refusals" eyebrow="Boundary" id="case-boundary">
      <div className="lfc-grid2 lfc-boundary">
        <Expander summary={`Not measurable here: hand-offs (${handOffs.length})`}>
          <ul className="lfc-nm">
            {handOffs.map((x) => {
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
                  {x.note ? <span className="lfc-fine"> {x.note}</span> : null}
                  {req?.text ? (
                    <Expander summary="Requirement text (verbatim)">
                      <p>{req.text}</p>
                    </Expander>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </Expander>
        <Expander summary={`Refusals (${refusals.length})`}>
          <ul className="lfc-refusals">
            {refusals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Expander>
      </div>
    </Panel>
  )
}

