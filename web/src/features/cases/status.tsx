// The case status card at the top of #/case/:id: the ONE next action, where the eye lands.
//   detected -> Start the primary countermeasure, and step 1 shown before it is unlocked;
//   acting   -> the next open step with its control (and the decline control when it is required);
//   watch    -> the tripwire countdown and the demo jump to the reassessment;
//   escalated-> the two tiers (D4): the onboard Crew Medical Officer now, the flight surgeon through the
//               ground packet, queued until the link resumes (LOS) or sent at once (AOS).
// No native <details> here: the page's first expander stays the Detect panel's "Why this fired".
import type { ReactNode } from 'react'
import type { CaseView } from '../../app/caseTimeline'
import { useMetNow } from '../../app/mission'
import { Button, ButtonLink, Chip, MetTime, Num, SeverityBadge } from '../../ui'
import {
  STATUS_WORD,
  escalationMeta,
  isOpen,
  nextOpenStep,
  openingSeverity,
  packetLabel,
  pendingRequired,
  refLabel,
  stepDef,
  stepList,
  stepNumber,
  tierOneLine,
  cmoCrewId,
} from './model'
import { autonomyText, deliveryText, jumpTo, openingNote, stepAnchor } from './helpers'
import type { ActCtx, OutcomeDraft } from './procedure'
import { OutcomeForm, StepControls, StepTags } from './procedure'
import { TMinus } from './parts'
import type { CaseDefFull, UnscriptedOpening } from './types'

/** The live mission clock (a leaf: only it re-renders each second). */
function ClockNow() {
  return <MetTime t={useMetNow()} label />
}

export function CaseStatusBadge({ view, size = 'md' }: { view: CaseView; size?: 'sm' | 'md' | 'lg' }) {
  const s = view.state.status
  if (s === 'idle' || s === 'resolved' || s === 'dismissed') return <SeverityBadge severity="nominal" label={STATUS_WORD[s]} size={size} />
  return <SeverityBadge severity={openingSeverity(view)} label={STATUS_WORD[s]} size={size} solid={s !== 'escalated'} />
}

/** The two escalation tiers, true for the crewmember's role and the link state (D4). */
export function EscalationTiers({ c, view, idSuffix, packetLink = true }: { c: ActCtx; view: CaseView; idSuffix: string; packetLink?: boolean }) {
  const s = view.state
  const meta = escalationMeta()
  const t1 = meta?.tiers.find((x) => x.id === 'crew_medical_officer')
  const t2 = meta?.tiers.find((x) => x.id === 'flight_surgeon')
  const queuedAt = s.packet_queued_at
  return (
    <div className="lfc-tiers-wrap">
      <ol className="lfc-tiers" aria-label="Escalation">
        <li data-tier="1">
          <span className="lfc-tier-n lf-num" aria-hidden="true">
            1
          </span>
          <div>
            <p className="lfc-k">Tier 1 · {t1?.label ?? 'Crew Medical Officer (onboard)'} · {t1?.when ?? 'now'}</p>
            <p className="lfc-tier-act">{tierOneLine(view.crewId)}</p>
          </div>
        </li>
        <li data-tier="2">
          <span className="lfc-tier-n lf-num" aria-hidden="true">
            2
          </span>
          <div>
            <p className="lfc-k">Tier 2 · {t2?.label ?? 'Flight surgeon (ground)'} · through the ground packet</p>
            <p>
              Ground packet <strong>{packetLabel('queued')}</strong>
              {queuedAt !== null ? (
                <>
                  {' '}
                  since <MetTime t={queuedAt} label />
                </>
              ) : null}
              . {deliveryText(c.comms, c.t, 'it')}
            </p>
          </div>
        </li>
      </ol>
      {autonomyText(c.comms) ? <p className="lfc-fine">{autonomyText(c.comms)}</p> : null}
      {packetLink ? (
        <p className="lfc-entry-actions">
          <ButtonLink href={`#/downlink?case=${view.caseId}&crew=${view.crewId}`} variant="secondary" id={`lfc-packet-${idSuffix}`}>
            Open the ground packet
          </ButtonLink>
        </p>
      ) : null}
      {meta?.chip ? (
        <p className="lfc-fine">
          The two tiers are a design choice <Chip kind={meta.chip} />: the Crew Medical Officer first, the flight surgeon through the packet; how much is
          decided onboard scales with the link.
        </p>
      ) : null}
    </div>
  )
}

interface NowProps {
  view: CaseView
  def: CaseDefFull
  c: ActCtx
  onSelect: (cmId: string) => void
  /** Crewmembers a Start goes to (shared case: every peer still detected). */
  startCount: number
  shared: boolean
  allCrew: boolean
  setAllCrew: (v: boolean) => void
  onJump: () => void
  chance: UnscriptedOpening | null
  outcome: OutcomeDraft
}

function openedLine(view: CaseView, def: CaseDefFull, sim: UnscriptedOpening | null) {
  const s = view.state
  if (s.opened_at === null) return null
  const trig = refLabel(s.finding?.rule_id)
  const prev = s.previous_instances.length ? s.previous_instances[s.previous_instances.length - 1] : null
  return (
    <p className="lfc-fine lfc-now-opened">
      {s.instance > 1 ? 'Opened again' : 'Opened'} <MetTime t={s.opened_at} label /> by {trig || 'a trigger of this case'}
      {s.instance > 1 && prev ? (
        <>
          , as instance <Num value={s.instance} />: instance <Num value={prev.instance} /> was {prev.status}
          {prev.closed_at !== null ? (
            <>
              {' '}
              at <MetTime t={prev.closed_at} label />
            </>
          ) : null}
        </>
      ) : null}
      .{def.triggers?.some((x) => x.kind === 'ops') ? ' Crew-wide: the same reading opens it for every crewmember.' : ''}
      {view.chance ? (
        <>
          {' '}
          <span className="lfc-possibly-tag">possibly chance</span> {view.chance.rate.text} (see Detect).
        </>
      ) : sim ? (
        <> The simulator records this opening as a chance flag of real-size day-to-day noise, not a scripted episode (see Detect).</>
      ) : null}
    </p>
  )
}

export function NowCard({ view, def, c, onSelect, startCount, shared, allCrew, setAllCrew, onJump, chance, outcome }: NowProps) {
  const s = view.state
  const sev = isOpen(s.status) || s.status === 'escalated' ? openingSeverity(view) : undefined
  const cm = def.countermeasure
  const step1 = def.procedure?.[0] ?? null
  const next = stepDef(def, nextOpenStep(s))
  const pending = pendingRequired(s)
  const n = s.spec.step_ids.length
  const due = s.status === 'watch' && s.reassess_at !== null && c.t >= s.reassess_at
  const isCmo = cmoCrewId() === view.crewId

  let title: string
  let body: ReactNode = null
  switch (s.status) {
    case 'idle':
      title = `Nothing to do for ${view.crewId}`
      body = (
        <p>
          No trigger of this case has reached caution for {view.crewId}.
          {view.opening ? (
            <>
              {' '}
              The data opens it at <MetTime t={view.opening.t} label />
              {openingNote(view.opening.t)}
            </>
          ) : null}
        </p>
      )
      break
    case 'detected':
      title = cm?.primary.title ?? 'Start the countermeasure'
      body = (
        <>
          {step1 ? (
            <div className="lfc-now-step" data-preview="true">
              <p className="lfc-k">Then step 1 of {def.procedure!.length}</p>
              <p className="lfc-now-step-text">{step1.text}</p>
            </div>
          ) : null}
          <p className="lfc-entry-actions">
            {cm ? (
              <Button onClick={() => onSelect(cm.primary.id)}>
                Start the countermeasure{startCount > 1 ? ` (all ${startCount} crewmembers)` : ''}
              </Button>
            ) : null}
            {cm?.alternatives?.length ? (
              <Button variant="ghost" onClick={() => jumpTo('case-act')}>
                Other options ({cm.alternatives.length}), only if this is not possible
              </Button>
            ) : null}
          </p>
        </>
      )
      break
    case 'acting':
      if (next) {
        title = `Step ${stepNumber(def, next.id)} of ${n}${next.required ? ' (required)' : ''}`
        body = (
          <>
            <div className="lfc-now-step">
              <p className="lfc-now-step-text">{next.text}</p>
              <StepTags step={next} />
              <StepControls c={c} step={next} where="now" />
            </div>
            <p className="lfc-fine lfc-now-progress">
              Done <Num value={s.steps_done.length} /> of <Num value={n} />
              {s.steps_declined.length ? (
                <>
                  , declined <Num value={s.steps_declined.length} />
                </>
              ) : null}
              {pending.length
                ? <>; required still open: {stepList(def, pending)}</>
                : s.spec.required_step_ids.length
                  ? '; every required step is settled, so the outcome can be logged'
                  : '; no step is required before the outcome'}
              .
            </p>
            <p className="lfc-entry-actions lfc-now-links">
              <Button variant="ghost" onClick={() => jumpTo(stepAnchor(next.id))}>
                See it in the procedure
              </Button>
              {!pending.length ? (
                <Button variant="ghost" onClick={() => jumpTo('case-outcome')}>
                  Log the outcome now
                </Button>
              ) : null}
            </p>
          </>
        )
      } else {
        title = 'Every step is settled: log the outcome'
        body = <OutcomeForm c={c} draft={outcome} where="now" />
      }
      break
    case 'watch':
      title = 'Tripwire armed'
      body = (
        <>
          {s.reassess_at !== null ? (
            <p className="lfc-now-step-text">
              Reassess at <MetTime t={s.reassess_at} label /> (<TMinus target={s.reassess_at} />
              ).
            </p>
          ) : null}
          {due ? (
            <p className="lfc-missing" id="lfc-due-banner" tabIndex={-1}>
              Due now: more readings are needed to decide. See the tripwire below.
            </p>
          ) : (
            <p className="lfc-entry-actions">
              <Button variant="secondary" onClick={onJump}>
                Move the mission clock to the reassessment (demo)
              </Button>
            </p>
          )}
        </>
      )
      break
    case 'escalated': {
      const red = s.escalation?.reason === 'red_flag'
      title = isCmo ? 'Escalated: the case is yours now' : 'Escalated: tell the Crew Medical Officer now'
      body = (
        <>
          <p id="lfc-verdict-banner" tabIndex={-1} className="lfc-verdict">
            {red ? (
              <>
                “Yes” to the red-flag question at step {stepNumber(def, s.escalation!.step_id ?? '')}, <MetTime t={s.escalation!.t} label />.
              </>
            ) : s.tripwire_result ? (
              <>
                The tripwire tripped at <MetTime t={s.closed_at ?? c.t} label />: <Num value={s.tripwire_result.hits} /> of the last{' '}
                <Num value={s.tripwire_result.considered} /> readings met its condition (it escalates at <Num value={s.tripwire_result.at_least} />).
              </>
            ) : (
              <>Escalated at <MetTime t={s.closed_at ?? c.t} label />.</>
            )}
          </p>
          {!red && def.tripwire?.text ? <p className="lfc-fine">The case’s tripwire, as written: “{def.tripwire.text}”</p> : null}
          <EscalationTiers c={c} view={view} idSuffix="banner" />
        </>
      )
      break
    }
    case 'resolved':
      title = 'Resolved: the tripwire stayed clear'
      body = (
        <>
          <p id="lfc-verdict-banner" tabIndex={-1} className="lfc-verdict">
            Judged at <MetTime t={s.closed_at ?? c.t} label />
            {s.tripwire_result ? (
              <>
                : <Num value={s.tripwire_result.hits} /> of the last <Num value={s.tripwire_result.considered} /> readings met the condition (it escalates at{' '}
                <Num value={s.tripwire_result.at_least} />)
              </>
            ) : null}
            . Keep logging as usual.
          </p>
          <p className="lfc-fine">
            {view.chance
              ? `It opened on a single flag (${view.chance.text.charAt(0).toLowerCase()}${view.chance.text.slice(1)}); the re-measured readings settled it. `
              : null}
            If a trigger reaches caution again, the case opens again as a new instance.
          </p>
        </>
      )
      break
    case 'dismissed':
    default:
      title = 'Dismissed'
      body = <p>Dismissed: {s.dismiss_reason}</p>
  }

  const open = isOpen(s.status)
  return (
    <section className="lfc-now" data-status={s.status} data-severity={sev} aria-labelledby="lfc-now-h">
      <div className="lfc-now-top">
        <span className="lfc-now-badge">
          <CaseStatusBadge view={view} size="lg" />
          {s.status === 'detected' ? <span className="lfc-k">Start now: one primary countermeasure</span> : null}
        </span>
        <span className="lfc-fine">
          Mission clock <ClockNow />
        </span>
      </div>
      <h2 id="lfc-now-h" className="lfc-now-title">
        {title}
      </h2>
      {body}
      {shared && open && (s.status === 'detected' || s.status === 'acting') ? (
        <label className="lfc-check">
          <input type="checkbox" checked={allCrew} onChange={(e) => setAllCrew(e.target.checked)} />
          Apply shared steps to every crewmember with this case open (the shelter is crew-wide). Personal readings, such as a dose, stay personal.
        </label>
      ) : null}
      {open ? <p className="lfc-fine lfc-now-link">{autonomyText(c.comms)}</p> : null}
      {openedLine(view, def, chance)}
    </section>
  )
}
