// The guided procedure (magenta = electronic procedure, Appendix F Table F.5-2), its step controls and
// the outcome form. Required steps (D5) must be done or declined with a reason before the engine accepts
// an outcome; a red-flag question answered "yes" escalates the case at once, the Crew Medical Officer
// first and the flight surgeon through the ground packet (D4). This file only dispatches STEP, DECLINE and
// OUTCOME events: the engine's caseReduce decides, and a rejected event stays in the log with its reason.
// Two rules are the UI's own. A red-flag question offers no decline, it is answered yes or no (canDecline): the
// engine still accepts DECLINE on any step (engine/cases.py), the UI never sends one for a red flag. A step that
// releases the ground packet asks first, inline, whose packets go (ReleaseControl).
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { tierOneFor } from '../../app/caseTimeline'
import type { TierOne } from '../../app/caseTimeline'
import { formatCountdown } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import type { CaseState } from '../../app/engine'
import { metClock } from '../../app/mission'
import { useCases } from '../../app/model'
import { crewList } from '../../app/procedureAlerts'
import { ENVIRONMENTS } from '../../app/scenario'
import type { CrewId, Observation } from '../../app/vocab'
import { Button, ButtonLink, Chip, Expander, MetTime, Num, Panel } from '../../ui'
import { NumberEntry } from './entry'
import { answerOf, formatSpan, nextOpenStep, packetLabel, pendingRequired, stepList, stepNumber, stepState, tierOneLine, variableLabel } from './model'
import { jumpTo, stepAnchor } from './helpers'
import { SourceBlock } from './parts'
import type { CaseDefFull, StepDef } from './types'

export interface StepInput {
  variable: string
  value: number | boolean
  unit: string
  /** MET of the observation behind the value (set when the value is logged as an observation). */
  t?: number
}

/** Everything a step control needs; built once per case view. */
export interface ActCtx {
  def: CaseDefFull
  state: CaseState
  crewId: CrewId
  /** The case is crew-wide (SPE) and shared steps go to every crewmember with it open. */
  sharedAll: boolean
  /** How many crewmembers a shared step goes to (1 when not shared). */
  sharedCount: number
  comms: CommsStatus
  /** Fold MET. */
  t: number
  latest: (variable: string) => Observation | null
  recent: (variable: string, n: number) => Observation[]
  /**
   * STEP for this crewmember (and, for a crew-wide step, every peer with the case open). `record` is the
   * number to log as an observation first (a typed value, a yes/no as 1/0, a MET time stamp).
   */
  onStep: (step: StepDef, input?: StepInput, record?: number) => void
  onDecline: (step: StepDef, reason: string) => void
}

// ---- who reports a shared reading --------------------------------------------------------------------

/**
 * The source of a reading no crewmember owns (crew_id null), in the words every view prints: the ≥10 MeV proton
 * flux is the Mars-orbit monitor, relayed, where NOAA's scale does not reach the crew (environments.json
 * noaa_scale_available false: Mars), and the NOAA GOES October 1989 replay elsewhere; the habitat dose rate is the
 * simulated habitat dosimeter; any other shared series (cabin ppCO2) is a vehicle sensor.
 */
export function sharedReadingSource(variable: string, envId: string | null | undefined): string {
  if (variable === 'proton_flux_10mev') {
    return ENVIRONMENTS.find((e) => e.id === envId)?.noaa_scale_available === false ? 'Mars-orbit monitor, relayed' : 'NOAA GOES (replay)'
  }
  if (variable === 'onboard_dose_rate') return 'habitat dosimeter (simulated)'
  return 'vehicle sensor'
}

// ---- procedure safety: red flags, the hold after a red-flag escalation, dose entries (pure) -------------

/** A red-flag question: the case definition or the engine's spec says so (both are read from cases.json). */
export function isRedFlagStep(step: Pick<StepDef, 'id' | 'red_flag'>, state: Pick<CaseState, 'spec'>): boolean {
  return step.red_flag === true || state.spec.red_flag_step_ids.includes(step.id)
}

/**
 * Does a step offer "Decline it with a reason"? Only a required step that is still open and is not a red-flag
 * question: a red flag is a yes/no the crewmember can always answer, and its "yes" is what escalates the case (D4),
 * so a decline would let the outcome be logged with the question never asked.
 */
export function canDecline(step: Pick<StepDef, 'id' | 'required' | 'red_flag'>, state: CaseState): boolean {
  return step.required === true && !isRedFlagStep(step, state) && stepState(state, step.id) === 'open'
}

/** The red-flag questions of a case that are neither answered nor declined, in procedure order. */
export function openRedFlagSteps(def: CaseDefFull, state: CaseState): string[] {
  return (def.procedure ?? []).filter((st) => isRedFlagStep(st, state) && stepState(state, st.id) === 'open').map((st) => st.id)
}

/** The case escalated on a red-flag "yes" (D4): the rest of its procedure waits for tier 1. */
export function heldByRedFlag(state: Pick<CaseState, 'status' | 'escalation'>): boolean {
  return state.status === 'escalated' && state.escalation?.reason === 'red_flag'
}

/**
 * Tier 1 inside a sentence: "the Crew Medical Officer (CM-4)"; on the Crew Medical Officer's own cases "the crew's
 * second Crew Medical Officer, the Commander (CM-1)" (meta.json escalation tier 1 and its backup, via tierOneFor).
 */
export function tierOneWho(t1: Pick<TierOne, 'name' | 'roleText' | 'crewId' | 'backup'>): string {
  const who = `${t1.name}${t1.crewId ? ` (${t1.crewId})` : ''}`
  return t1.backup ? `${t1.roleText}, ${who}` : who
}

/**
 * The label of a vehicle reading typed by hand. A dose report is this crewmember's own, and the app adds each one to
 * the dose record (app/evaluate.ts: a cumulative window sums the reports, each the dose since the previous one), so
 * the label names the crewmember and says so. Any other vehicle reading (the proton flux) keeps the plain label.
 */
export function vehicleEntryLabel(variable: string, crewId: string): string {
  const label = variableLabel(variable)
  return variable.startsWith('dose_')
    ? `Type ${crewId}’s ${label} since the previous entry, as the vehicle reports it (each entry is added to the dose record)`
    : `Type the value the vehicle reports (${label})`
}

/**
 * The question a packet-release step asks before it is done: whose packets go, and the change of state they make
 * (meta.json packet_states: Prepared (held on board) -> Queued, sent when a link exists).
 */
export function releaseQuestion(crews: readonly CrewId[]): string {
  const change = `changes from ${packetLabel('prepared')} to ${packetLabel('queued')} and is sent when a link exists.`
  return crews.length > 1 ? `Release the ground packet of ${crewList(crews)}? Each ${change}` : `Release ${crews[0] ?? 'this crewmember'}’s ground packet? It ${change}`
}

// ---- step tags, done / declined lines ---------------------------------------------------------------

export function StepTags({ step }: { step: StepDef }) {
  if (!step.required && !step.red_flag && !step.releases_packet) return null
  return (
    <span className="lfc-step-tags">
      {step.red_flag ? <span className="lfc-tag" data-kind="red-flag">Red-flag question</span> : step.required ? <span className="lfc-tag" data-kind="required">Required</span> : null}
      {step.red_flag ? <span className="lfc-tag" data-kind="required">Required</span> : null}
      {step.releases_packet ? <span className="lfc-tag" data-kind="packet">Releases the ground packet</span> : null}
    </span>
  )
}

function DoneLine({ state, step }: { state: CaseState; step: StepDef }) {
  const done = state.steps_done.find((d) => d.step_id === step.id)
  if (!done) return null
  const inp = (done.input && typeof done.input === 'object' ? done.input : null) as { value?: unknown; unit?: string } | null
  const yes = answerOf(inp)
  let what: ReactNode = null
  if (inp?.unit === 'yes/no' && yes !== null) what = <> answered <strong>{yes ? 'yes' : 'no'}</strong></>
  else if (inp?.unit === 'MET' && typeof inp.value === 'number') what = <>: logged <MetTime t={inp.value} label /></>
  else if (inp && typeof inp.value === 'number') what = <> with <Num value={inp.value} unit={inp.unit} /></>
  return (
    <p className="lfc-done">
      ✓ Done <MetTime t={done.t} label />
      {what}
      {step.releases_packet && state.packet_queued_at !== null ? <>; ground packet {packetLabel('queued')}</> : null}.
    </p>
  )
}

function DeclinedLine({ state, step }: { state: CaseState; step: StepDef }) {
  const d = state.steps_declined.find((x) => x.step_id === step.id)
  if (!d) return null
  return (
    <p className="lfc-declined">
      Declined <MetTime t={d.t} label />: “{d.reason}”
    </p>
  )
}

// ---- the control of one step ----------------------------------------------------------------------------

function sharedSuffix(c: ActCtx, personal = false) {
  return c.sharedAll && !personal && c.sharedCount > 1 ? ` (all ${c.sharedCount} crewmembers)` : ''
}

/** What a "yes" does, shown before it is logged (D4: the Crew Medical Officer first, the flight surgeon through the packet). */
function RedFlagPreview({ c }: { c: ActCtx }) {
  const link = c.comms.blocked
    ? `sent when the link resumes${c.comms.resumes_at !== null ? `, in ${formatCountdown(c.comms.resumes_at - c.t)}` : ''}`
    : 'sent now; the ground has it within the round-trip light time'
  return (
    <div className="lfc-redflag" role="note">
      <p>
        <strong>“Yes” escalates this case now.</strong> {tierOneLine(c.crewId)} The ground packet is queued for the flight surgeon ({link}).
      </p>
    </div>
  )
}

/** The release question for a crew-wide step: the crewmembers the STEP goes to, as CaseDetail's onStep picks them. */
function SharedReleaseQuestion({ c, step, id }: { c: ActCtx; step: StepDef; id: string }) {
  const { cases } = useCases()
  const crews = cases.filter((v) => v.caseId === c.def.id && v.state.status === 'acting' && stepState(v.state, step.id) !== 'done').map((v) => v.crewId)
  return (
    <p id={id} className="lfc-confirm-q">
      {releaseQuestion(crews.length ? crews : [c.crewId])}
    </p>
  )
}

/** A packet-release step asks first, inline (no disclosure): Release does the step, Cancel goes back. */
function ReleaseControl({ c, step, where }: { c: ActCtx; step: StepDef; where: string }) {
  const [asking, setAsking] = useState(false)
  const moved = useRef(false)
  const qid = `lfc-release-${where}-${step.id}`
  // focus follows the question (and back on Cancel), never on the first render
  useEffect(() => {
    if (moved.current) document.getElementById(asking ? `${qid}-yes` : `${qid}-start`)?.focus()
  }, [asking, qid])
  const set = (v: boolean) => {
    moved.current = true
    setAsking(v)
  }
  if (!asking) {
    return (
      <Button id={`${qid}-start`} variant="secondary" onClick={() => set(true)}>
        Release the ground packet (step done){sharedSuffix(c)}
      </Button>
    )
  }
  return (
    <div className="lfc-confirm" role="group" aria-labelledby={qid} data-release-ask="">
      {c.sharedAll ? (
        <SharedReleaseQuestion c={c} step={step} id={qid} />
      ) : (
        <p id={qid} className="lfc-confirm-q">
          {releaseQuestion([c.crewId])}
        </p>
      )}
      <div className="lfc-entry-actions">
        <Button id={`${qid}-yes`} variant="secondary" onClick={() => c.onStep(step)}>
          Release
        </Button>
        <Button variant="ghost" onClick={() => set(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function StepAction({ c, step, where }: { c: ActCtx; step: StepDef; where: string }) {
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(null)
  const inp = step.input
  const label = inp ? variableLabel(inp.variable) : ''
  if (!inp && step.releases_packet) return <ReleaseControl c={c} step={step} where={where} />
  if (!inp) {
    return (
      <Button variant="secondary" onClick={() => c.onStep(step)}>
        Mark step done
        {sharedSuffix(c)}
      </Button>
    )
  }
  const logAndStep = (v: number, value: number | boolean = v) => c.onStep(step, { variable: inp.variable, value, unit: inp.unit }, v)
  if (inp.unit === 'yes/no') {
    const name = `yn-${where}-${step.id}`
    return (
      <div className="lfc-entry-wrap">
        <fieldset className="lfc-yn">
          <legend>Answer</legend>
          <label>
            <input type="radio" name={name} checked={answer === 'no'} onChange={() => setAnswer('no')} /> No
          </label>
          <label>
            <input type="radio" name={name} checked={answer === 'yes'} onChange={() => setAnswer('yes')} /> Yes
          </label>
        </fieldset>
        {answer === 'yes' && step.red_flag ? <RedFlagPreview c={c} /> : null}
        <div className="lfc-entry-actions">
          <Button variant="secondary" disabled={!answer} onClick={() => answer && logAndStep(answer === 'yes' ? 1 : 0, answer === 'yes')}>
            {answer === 'yes' && step.red_flag ? 'Log “yes” and escalate now' : 'Log answer'}
          </Button>
        </div>
      </div>
    )
  }
  if (inp.unit === 'MET') {
    return (
      <Button variant="secondary" onClick={() => logAndStep(metClock.get().metNow)}>
        Log the time now (MET){sharedSuffix(c)}
      </Button>
    )
  }
  const last = c.latest(inp.variable)
  const vehicle = last?.crew_id === null
  const asInput = (o: Observation): StepInput => ({ variable: o.variable, value: o.value, unit: o.unit, t: o.t })
  const lastLine = last ? (
    <p className="lfc-fine">
      Latest {label}: <Num value={last.value} unit={last.unit} /> at <MetTime t={last.t} label />
      {/* A shared reading names its source as the tripwire panel does ("NOAA GOES (replay)" must not nest in parentheses). */}
      {vehicle ? `. Source: ${sharedReadingSource(inp.variable, c.comms.env.id)}.` : ` (${last.source === 'manual' ? 'typed in' : last.source})`}
    </p>
  ) : (
    <p className="lfc-missing">No {label} reading yet. Shown as missing, not as zero.</p>
  )
  const entry = (lbl: string, submit: string) => (
    <NumberEntry
      label={lbl}
      variable={inp.variable}
      unit={inp.unit}
      submitLabel={submit}
      pendingKey={`step:${step.id}`}
      idPrefix={where}
      onCommit={(v) => logAndStep(v)}
    />
  )
  if (inp.source === 'app' || inp.source === 'band' || inp.source === 'vehicle') {
    return (
      <div className="lfc-entry-wrap">
        {lastLine}
        <div className="lfc-entry-actions">
          {last ? (
            <Button variant="secondary" onClick={() => c.onStep(step, asInput(last))}>
              Use this reading{vehicle ? sharedSuffix(c) : ''}
            </Button>
          ) : null}
          {inp.source === 'app' ? (
            <ButtonLink variant="ghost" href="#/noon-sight">
              Take the test now in Noon Sight
            </ButtonLink>
          ) : null}
        </div>
        {inp.source === 'vehicle' && !last ? entry(vehicleEntryLabel(inp.variable, c.crewId), 'Log value and mark done') : null}
      </div>
    )
  }
  const lastThree = c.recent(inp.variable, 3)
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
      {last ? (
        <div className="lfc-entry-actions">
          <Button variant="secondary" onClick={() => c.onStep(step, asInput(last))}>
            Use the latest: <Num value={last.value} unit={last.unit} />
          </Button>
        </div>
      ) : null}
      {entry(`Or type a new ${label}`, 'Log value and mark done')}
    </div>
  )
}

/** Decline a required step with a reason (DECLINE). Not a native disclosure, so the status card stays free of expanders. */
export function DeclineControl({ c, step, where }: { c: ActCtx; step: StepDef; where: string }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const id = `lfc-decline-${where}-${step.id}`
  if (!open) {
    return (
      <Button variant="ghost" className="lfc-decline-open" aria-expanded={false} onClick={() => setOpen(true)}>
        Cannot do this step? Decline it with a reason
      </Button>
    )
  }
  return (
    <form
      id={id}
      className="lfc-outcome lfc-decline"
      onSubmit={(e) => {
        e.preventDefault()
        if (!reason.trim()) return
        c.onDecline(step, reason.trim())
        setReason('')
        setOpen(false)
      }}
    >
      <label htmlFor={`${id}-r`}>Why can this step not be done? The reason is kept in the case record.</label>
      <input id={`${id}-r`} value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      <span className="lfc-entry-actions">
        <Button type="submit" variant="secondary" disabled={!reason.trim()}>
          Decline step {stepNumber(c.def, step.id)}
          {sharedSuffix(c)}
        </Button>
        <Button variant="ghost" aria-expanded={true} aria-controls={id} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </span>
    </form>
  )
}

/** A step's live controls: its action, plus the decline control when it is required and not a red-flag question. */
export function StepControls({ c, step, where }: { c: ActCtx; step: StepDef; where: string }) {
  const st = stepState(c.state, step.id)
  return (
    <>
      {st === 'declined' ? <p className="lfc-fine">You can still do it:</p> : null}
      <StepAction c={c} step={step} where={where} />
      {canDecline(step, c.state) ? <DeclineControl c={c} step={step} where={where} /> : null}
    </>
  )
}

// ---- 4. Guided procedure --------------------------------------------------------------------------------

export function ProcedurePanel({ c, sharedNote, current }: { c: ActCtx; sharedNote: ReactNode; current: string | null }) {
  const steps = c.def.procedure ?? []
  const s = c.state
  const acting = s.status === 'acting'
  const pending = pendingRequired(s)
  const hasRedFlag = steps.some((st) => isRedFlagStep(st, s))
  // after a red-flag "yes" the steps left wait for tier 1 (a design choice: cases.json says nothing about them)
  const held = heldByRedFlag(s) && nextOpenStep(s) !== null
  return (
    <Panel title="4. Guided procedure" eyebrow="Procedure" id="case-procedure" className="lfc-proc-panel">
      {held ? (
        <div className="lfc-redflag" role="note" data-held="">
          <p>
            <strong>
              Escalated by a red-flag answer at step {stepNumber(c.def, s.escalation!.step_id ?? '')}: the remaining steps wait for{' '}
              {tierOneWho(tierOneFor(c.crewId))}.
            </strong>{' '}
            <Chip kind="design choice" />
          </p>
        </div>
      ) : null}
      {!acting && s.status !== 'idle' && !s.countermeasure_id ? <p className="lfc-fine">The steps unlock when you start the countermeasure.</p> : null}
      {sharedNote}
      {s.spec.required_step_ids.length ? (
        <p className="lfc-fine">
          Steps marked <span className="lfc-tag" data-kind="required">Required</span> must be done, or declined with a reason, before the outcome
          can be logged{acting && pending.length ? <>: {stepList(c.def, pending)} still open</> : null}.
          {hasRedFlag ? ' A red-flag question cannot be declined: answer it yes or no.' : null}
        </p>
      ) : null}
      <ol className="lfc-proc">
        {steps.map((st, i) => {
          const state = stepState(s, st.id)
          return (
            <li key={st.id} id={stepAnchor(st.id)} className="lfc-step" data-done={state === 'done' || undefined} data-declined={state === 'declined' || undefined} data-current={current === st.id || undefined}>
              <span className="lfc-step-n lf-num" aria-hidden="true">
                {i + 1}
              </span>
              <div className="lfc-step-body">
                <p className="lfc-step-text">
                  <span className="sr-only">
                    Step {i + 1}
                    {st.required ? ', required' : ''}
                    {state === 'done' ? ', done' : state === 'declined' ? ', declined' : ''}:{' '}
                  </span>
                  {st.text}
                </p>
                <StepTags step={st} />
                {st.red_flags?.length ? (
                  <ul className="lfc-redflags" aria-label="Red flags to ask about">
                    {st.red_flags.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                ) : null}
                <DoneLine state={s} step={st} />
                <DeclinedLine state={s} step={st} />
                {acting && state !== 'done' ? <StepControls c={c} step={st} where="list" /> : null}
                {st.basis ? (
                  <Expander summary="Basis of this step">
                    {st.basis.note ? (
                      <p>
                        {st.basis.note} <Chip kind={st.basis.chip} />
                      </p>
                    ) : null}
                    <SourceBlock source={st.basis.source} compact />
                  </Expander>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    </Panel>
  )
}

// ---- 5. Outcome -------------------------------------------------------------------------------------------

/** The outcome text, shared by the status card and the outcome panel (one draft, two places to type it). */
export interface OutcomeDraft {
  text: string
  setText: (v: string) => void
  submit: (text: string) => void
  /** Crewmembers whose OUTCOME the engine would accept now (shared case). */
  readyPeers: CrewId[]
  /** Crewmembers acting with required steps still open (shared case). */
  blockedPeers: CrewId[]
}

export function OutcomeForm({ c, draft, where }: { c: ActCtx; draft: OutcomeDraft; where: string }) {
  const s = c.state
  const n = s.spec.step_ids.length
  const reassess = c.def.tripwire?.reassess_after_s ?? s.spec.tripwire.reassess_after_s
  const pending = pendingRequired(s)
  const blocked = pending.length > 0
  // a red-flag question still open is answered, never declined (canDecline)
  const red = pending.filter((pid) => isRedFlagStep({ id: pid, red_flag: (c.def.procedure ?? []).find((x) => x.id === pid)?.red_flag }, s))
  const id = where === 'panel' ? 'lfc-outcome-text' : `lfc-outcome-text-${where}`
  return (
    <form
      className="lfc-outcome"
      onSubmit={(e) => {
        e.preventDefault()
        if (blocked || !draft.text.trim()) return
        draft.submit(draft.text.trim())
        draft.setText('')
      }}
    >
      {blocked ? (
        <div className="lfc-blocked" role="note">
          <p>
            <strong>
              Not yet: {stepList(c.def, pending)} {pending.length > 1 ? 'are' : 'is'} required and still open.
            </strong>{' '}
            {red.length === 0 ? (
              <>Do {pending.length > 1 ? 'each' : 'it'}, or decline it with a reason: until then an outcome is not accepted.</>
            ) : red.length === pending.length ? (
              <>Answer {pending.length > 1 ? 'each' : 'it'} yes or no (a red-flag question cannot be declined): until then an outcome is not accepted.</>
            ) : (
              <>
                Do each, or decline it with a reason, except the red-flag question{red.length > 1 ? 's' : ''} ({stepList(c.def, red)}): answer{' '}
                {red.length > 1 ? 'each' : 'it'} yes or no. Until then an outcome is not accepted.
              </>
            )}
          </p>
          <p className="lfc-entry-actions">
            {pending.map((pid) => (
              <Button key={pid} variant="ghost" onClick={() => jumpTo(stepAnchor(pid))}>
                Go to step {stepNumber(c.def, pid)}
              </Button>
            ))}
          </p>
        </div>
      ) : null}
      <label htmlFor={id}>What happened? Plain words are fine.</label>
      <textarea id={id} rows={2} value={draft.text} onChange={(e) => draft.setText(e.target.value)} disabled={blocked} />
      <p className="lfc-fine">
        <Num value={s.steps_done.length} /> of <Num value={n} /> steps done
        {s.steps_declined.length ? (
          <>
            , <Num value={s.steps_declined.length} /> declined
          </>
        ) : null}
        . Logging the outcome arms the tripwire: the case is reassessed <span className="lf-num">{formatSpan(reassess)}</span> later.
      </p>
      {draft.blockedPeers.length ? (
        <p className="lfc-fine">Still open for {draft.blockedPeers.join(', ')}: their outcome waits until their required steps are settled.</p>
      ) : null}
      <Button type="submit" disabled={blocked || !draft.text.trim()}>
        Log the outcome and arm the tripwire{draft.readyPeers.length > 1 ? ` (${draft.readyPeers.join(', ')})` : ''}
      </Button>
    </form>
  )
}

export function OutcomePanel({ c, draft }: { c: ActCtx; draft: OutcomeDraft }) {
  const s = c.state
  return (
    <Panel title="5. Log the outcome" eyebrow="Outcome" id="case-outcome">
      {s.outcome ? (
        <p className="lfc-done">
          ✓ Logged <MetTime t={s.outcome.t} label />: “{s.outcome.text}”
        </p>
      ) : s.escalation?.reason === 'red_flag' ? (
        <p className="lfc-fine">Not needed: the case escalated at step {stepNumber(c.def, s.escalation.step_id ?? '')}, a red-flag answer.</p>
      ) : s.status === 'acting' ? (
        <OutcomeForm c={c} draft={draft} where="panel" />
      ) : (
        <p className="lfc-fine">Logged after the procedure. The tripwire arms when the outcome is logged.</p>
      )}
    </Panel>
  )
}
