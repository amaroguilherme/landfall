// 6. Tripwire and 7. Resolve or escalate, with the ground packet in ONE state wording everywhere:
// "Prepared (held on board)" until the crew releases it or the case escalates, then "Queued"
// (meta.json packet_states; state.packet_queued_at). The demo jump lands on the first whole minute at
// or after the reassessment (cases fold on the minute clock), and the page then scrolls to the verdict.
import { useState } from 'react'
import { useEvaluation, useGroundPacket } from '../../app/model'
import type { CaseView } from '../../app/caseTimeline'
import type { CaseState, Finding, PersonalFinding } from '../../app/engine'
import type { MissionEvaluation } from '../../app/evaluate'
import type { CrewId } from '../../app/vocab'
import { Button, ButtonLink, Chip, Expander, MetTime, Num, Panel, SeverityBadge } from '../../ui'
import { NumberEntry } from './entry'
import { OP_WORDS, formatSpan, isOpen, meetsCondition, nextOpenStep, packetLabel, packetStateOf, refLabel, stepList, tripwireProgress, variableLabel } from './model'
import { BandRange, SourceBlock, TMinus } from './parts'
import { heldByRedFlag, openRedFlagSteps, sharedReadingSource, tierOneWho } from './procedure'
import type { ActCtx } from './procedure'
import { entryVariable } from '../downlink/model'
import { deliveryText } from './helpers'
import { EscalationTiers, OverdueNote, readingsSinceOpened } from './status'
import type { CaseDefFull } from './types'

const qty = (unit: string) => (unit === 'count' ? undefined : unit)

/** A variable's label inside a sentence: "Resting heart rate" -> "resting heart rate" (acronyms such as PVT-B kept). */
const midSentence = (variable: string) => {
  const l = variableLabel(variable)
  return /^[A-Z][a-z]/.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l
}

/** A rule or indicator label inside a sentence ("Sleep midpoint shift" -> "sleep midpoint shift"). */
const lcLabel = (l: string) => (/^[A-Z][a-z]/.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l)

/**
 * This crewmember's finding of a rule or indicator id at the evaluation minute (Tier B, Tier A, context or OPS),
 * with the MET of the reading behind it; null when the evaluation has none.
 */
function currentFindingOf(evaluation: MissionEvaluation | null, crewId: CrewId, ref: string): { finding: Finding; t: number | null } | null {
  if (!evaluation) return null
  const crew = evaluation.crew[crewId]
  const b = crew?.tierB.find((e) => e.indicator.id === ref)
  if (b) return { finding: b.finding, t: b.current?.t ?? null }
  const a = [...(crew?.tierA ?? []), ...(crew?.context ?? []), ...evaluation.ops.findings].find((e) => e.rule.id === ref)
  return a ? { finding: a.finding, t: a.input.t } : null
}

/**
 * When the tripwire watches another indicator or rule than the finding that opened this instance (the sleep case
 * watches PVT-B lapses whichever indicator opened it), say so: the watched condition, the opening reading against its
 * edge, and that reading's latest value, all from the case state and the engine's current finding.
 */
function TripwireMismatch({ view, chip }: { view: CaseView; chip: string | undefined }) {
  const { evaluation } = useEvaluation()
  const s = view.state
  const cond = s.spec.tripwire.condition
  const opening = s.finding
  if (!opening || !cond.ref_id || opening.rule_id === cond.ref_id) return null
  const latest = currentFindingOf(evaluation, view.crewId, opening.rule_id)
  const personal = opening.tier === 'B'
  const edge = personal ? 'your band edge' : opening.category === 'TARGET' ? 'the target' : 'the limit'
  const unit = qty(opening.unit)
  const edgeNum = (v: number | null) => <Num value={v} unit={unit} digits={personal ? 2 : undefined} />
  const lf = latest?.finding ?? null
  const lv = lf?.value
  // The latest reading's place, from the engine's own verdict: past the band edge on the side it moved, or inside.
  const band = personal && lf ? (lf as PersonalFinding).band : null
  const past = lf?.status === 'reliable_change'
  const pastEdge = band && typeof lv === 'number' ? (lv > band.high ? band.high : band.low) : null
  return (
    <p className="lfc-fine lfc-trip-other" data-tripwire-other="">
      This tripwire watches {midSentence(cond.variable)} ({OP_WORDS[cond.op]} <Num value={cond.value} unit={qty(cond.unit)} /> on at least{' '}
      <Num value={cond.at_least} /> of the last <Num value={cond.of_last_n} /> readings, <Chip kind={chip} />) for every crewmember, whichever
      indicator opened the case. This instance opened on the {lcLabel(refLabel(opening.rule_id))}:{' '}
      <Num value={opening.value} unit={unit} />
      {s.opened_at !== null ? (
        <>
          {' '}
          at <MetTime t={s.opened_at} label />
        </>
      ) : null}{' '}
      against {edge} {edgeNum(opening.limit)}
      {typeof lv === 'number' ? (
        <>
          ; its latest reading is <Num value={lv} unit={unit} />
          {latest?.t !== null && latest?.t !== undefined ? (
            <>
              {' '}
              (<MetTime t={latest.t} label />)
            </>
          ) : null}
          {personal && band ? (
            past ? (
              pastEdge === opening.limit ? (
                <>, still past that edge</>
              ) : (
                <>, past your band edge {edgeNum(pastEdge)}</>
              )
            ) : (
              <>
                , inside your band (<BandRange finding={lf as PersonalFinding} />)
              </>
            )
          ) : (
            <>
              , against {edge} {edgeNum(lf?.limit ?? null)}
            </>
          )}
        </>
      ) : null}
      .
    </p>
  )
}

// ---- 6. Tripwire ----------------------------------------------------------------------------------------

export function TripwirePanel({
  c,
  def,
  view,
  onJump,
  logReading,
}: {
  c: ActCtx
  def: CaseDefFull
  view: CaseView
  onJump: () => void
  /** A crew-typed tripwire reading (manual variables only), stamped at the clock minute. */
  logReading: (value: number) => void
}) {
  const s = view.state
  const tw = def.tripwire
  const cond = s.spec.tripwire.condition
  const label = variableLabel(cond.variable)
  const ref = refLabel(cond.ref_id)
  const stepFor = (def.procedure ?? []).find((x) => x.input?.variable === cond.variable)
  const src = stepFor?.input?.source ?? null
  const last = c.latest(cond.variable)
  const res = s.tripwire_result
  const watch = s.status === 'watch' && s.reassess_at !== null
  const due = watch && c.t >= s.reassess_at!
  const prog = tripwireProgress(s)
  const obs = s.tripwire_obs
  const shown = obs.slice(-cond.of_last_n)
  const earlier = obs.slice(0, Math.max(0, obs.length - cond.of_last_n))
  // A reading that meets the condition carries the class of the finding that opened the case (D1): the SPE
  // tripwire watches the S3 level, a Warning; the renal and sleep conditions are Caution-level.
  const hitSeverity = s.finding?.severity === 'warning' ? 'warning' : 'caution'
  const row = (o: { t: number; value: number }) => {
    const hit = meetsCondition(o.value, cond.op, cond.value)
    return (
      <li key={o.t} data-hit={hit || undefined}>
        <MetTime t={o.t} /> <Num value={o.value} unit={qty(cond.unit)} />{' '}
        {hit ? <SeverityBadge severity={hitSeverity} label="meets the condition" size="sm" /> : <span className="lfc-fine">does not meet it</span>}
      </li>
    )
  }
  return (
    <Panel title="6. Tripwire" eyebrow="Watch" id="case-tripwire">
      <figure className="lfc-quote lfc-trip-text">
        <figcaption className="lfc-quote-label">
          The condition, as written in the case <Chip kind={tw?.chip} />
        </figcaption>
        <blockquote>{tw?.text}</blockquote>
      </figure>
      <p className="lfc-cond">
        Escalates when at least <Num value={cond.at_least} /> of the last <Num value={cond.of_last_n} /> readings of {midSentence(cond.variable)} are{' '}
        {OP_WORDS[cond.op]} <Num value={cond.value} unit={qty(cond.unit)} />, judged <span className="lf-num">{formatSpan(s.spec.tripwire.reassess_after_s)}</span> after the outcome
        {ref ? <span className="lfc-fine"> (watched here: {ref})</span> : null}.
      </p>
      <TripwireMismatch view={view} chip={tw?.chip} />
      {view.chance && (isOpen(s.status) || s.status === 'resolved') ? (
        <p className="lfc-trip-chance lfc-fine">
          <span className="lfc-possibly-tag">possibly chance</span> A single flag: a re-measure resolves it.{' '}
          {s.status === 'resolved'
            ? 'The readings after the outcome kept this tripwire clear, so the case resolved'
            : s.status === 'watch'
              ? 'The outcome is logged; this tripwire now judges the readings after it and resolves the case when they stay clear'
              : 'Re-measure, then log the outcome; this tripwire then judges the readings after it and resolves the case when they stay clear'}{' '}
          (it escalates only if at least <Num value={cond.at_least} /> of the last <Num value={cond.of_last_n} /> readings of {midSentence(cond.variable)} are{' '}
          {OP_WORDS[cond.op]} <Num value={cond.value} unit={qty(cond.unit)} />
          ). A later episode opens a new instance of the case.
        </p>
      ) : null}
      {tw?.source ? (
        <Expander summary="Basis of these numbers">
          <SourceBlock source={tw.source} compact />
        </Expander>
      ) : null}
      {watch ? (
        <div className="lfc-armed">
          <p className="lfc-k">Armed</p>
          <p className="lfc-big">
            <TMinus target={s.reassess_at!} />
          </p>
          <p>
            Reassess at <MetTime t={s.reassess_at!} label /> on the mission clock.
          </p>
          {due ? (
            <p className="lfc-missing" id="lfc-due-panel" tabIndex={-1}>
              Due now, and more readings are needed to decide: <Num value={prog.considered} /> of the last <Num value={cond.of_last_n} /> are in hand.
              {src === 'manual' ? ' Log new readings below.' : src === 'app' ? ' New results come from the test in Noon Sight.' : ' They arrive as the mission clock runs.'}
            </p>
          ) : (
            <>
              <p className="lfc-entry-actions">
                <Button variant="secondary" onClick={onJump}>
                  Move the mission clock to the reassessment (demo)
                </Button>
              </p>
              <p className="lfc-fine">
                The demo jump moves the mission clock to the first whole minute at or after the reassessment, where the readings in hand are judged.
              </p>
            </>
          )}
        </div>
      ) : res ? null : s.escalation?.reason === 'red_flag' ? (
        <p className="lfc-fine">Not needed: a red-flag answer escalated the case at once.</p>
      ) : (
        <>
          <p className="lfc-fine">Not armed yet: it arms when the outcome is logged.</p>
          <OverdueNote view={view} t={c.t} readings={readingsSinceOpened(c.recent, s)} />
        </>
      )}
      {obs.length || watch ? (
        <>
          <h3 className="lfc-h3">Readings since the outcome</h3>
          {obs.length ? (
            <>
              <p className="lfc-fine">
                The last <Num value={Math.min(cond.of_last_n, obs.length)} /> of <Num value={obs.length} /> reading(s), the ones the tripwire judges:
              </p>
              <ul className="lfc-trip-obs">{shown.map(row)}</ul>
              {earlier.length ? (
                <Expander summary={`${earlier.length} earlier reading(s) since the outcome`}>
                  <ul className="lfc-trip-obs">{earlier.map(row)}</ul>
                </Expander>
              ) : null}
            </>
          ) : (
            <p className="lfc-missing">No readings since the outcome yet.</p>
          )}
          {watch ? (
            src === 'manual' ? (
              <NumberEntry
                label={`Log a new ${label}`}
                variable={cond.variable}
                unit={cond.unit}
                submitLabel="Log reading"
                pendingKey={`tripwire:${cond.variable}`}
                idPrefix="tripwire"
                onCommit={logReading}
              />
            ) : src === 'app' ? (
              <p className="lfc-fine">
                New results come from the test: <a href="#/noon-sight">take it in Noon Sight</a>.
              </p>
            ) : (
              <p className="lfc-fine">
                {last?.crew_id === null
                  ? `New readings arrive as the mission clock runs. Source: ${sharedReadingSource(cond.variable, c.comms.env.id)}.`
                  : `New readings arrive from the ${src ?? 'band'} as the mission clock runs.`}
              </p>
            )
          ) : null}
        </>
      ) : null}
      {res ? (
        <p className="lfc-done lfc-verdict" id="lfc-verdict-panel" tabIndex={-1}>
          Judged <MetTime t={s.closed_at ?? c.t} label />: <Num value={res.hits} /> of the last <Num value={res.considered} /> readings met the condition
          (escalates at <Num value={res.at_least} />) → <strong>{res.tripped ? 'tripped: escalated' : 'clear: resolved'}</strong>.
        </p>
      ) : null}
    </Panel>
  )
}

// ---- 7. Resolve or escalate, and the ground packet --------------------------------------------------------

/**
 * Before a dismiss, while a red-flag question is neither answered nor declined: ask it first, since its "yes" escalates
 * the case (D4) and a dismiss would close it unasked. A design choice; dismissing stays possible. Nothing otherwise.
 */
export function DismissRedFlagNote({ def, state }: { def: CaseDefFull; state: CaseState }) {
  const open = openRedFlagSteps(def, state)
  if (!open.length) return null
  const many = open.length > 1
  return (
    <div className="lfc-redflag" role="note" data-dismiss-red-flag="">
      <p>
        The red-flag question{many ? 's' : ''} ({stepList(def, open)}) {many ? 'are' : 'is'} not answered yet. Ask {many ? 'them' : 'it'} before you
        dismiss: a “yes” escalates this case instead. <Chip kind="design choice" />
      </p>
    </div>
  )
}

/**
 * The first line of an escalated case's close panel. Nothing needs an answer from the ground first; after a red-flag
 * "yes" with steps still open, the remaining steps wait for tier 1, as the status card and the procedure say (a design
 * choice), so the line does not tell the crew to keep following the procedure.
 */
export function EscalatedLine({ view, t }: { view: Pick<CaseView, 'state' | 'tier1'>; t: number }) {
  const s = view.state
  const held = heldByRedFlag(s) && nextOpenStep(s) !== null
  return (
    <p data-escalated-line="">
      Escalated <MetTime t={s.closed_at ?? t} label />
      {s.escalation?.reason === 'red_flag' ? ' by a red-flag answer' : ' by the tripwire'}. You do not need to wait for an answer from the ground
      {held ? (
        <>
          ; the remaining steps wait for {tierOneWho(view.tier1)}. <Chip kind="design choice" />
        </>
      ) : (
        ' to keep following the case’s instructions.'
      )}
    </p>
  )
}

export function PacketBlock({ c, def, view, delivery = true }: { c: ActCtx; def: CaseDefFull; view: CaseView; delivery?: boolean }) {
  const s = view.state
  const packet = useGroundPacket(view.caseId, view.crewId)
  const n = packet.bundle?.entry.length ?? null
  const ps = packetStateOf(s)
  if (ps === 'none') return null
  const queued = ps === 'queued'
  const releaseSteps = s.spec.packet_step_ids
  // The variables the case asks for that have at least one entry in the bundle, mapped back as #/downlink maps them;
  // the rest is withheld by consent or has no record yet (nothing is sent for it), never listed as if it were in the packet.
  const asked = def.escalation?.observations ?? []
  const sent = new Set((packet.bundle?.entry ?? []).map((e) => entryVariable(e.resource, asked, view.crewId)))
  const inPacket = asked.filter((v) => sent.has(v))
  const noRecord = packet.bundle ? asked.filter((v) => !sent.has(v) && !packet.withheld.includes(v)) : []
  return (
    <div className="lfc-packet" data-queued={queued || undefined}>
      <p className="lfc-k">Ground packet (FHIR R4, delay-tolerant)</p>
      <p>
        <strong>{packetLabel(queued ? 'queued' : 'prepared')}</strong>
        {queued && s.packet_queued_at !== null ? (
          <>
            {' '}
            since <MetTime t={s.packet_queued_at} label />
          </>
        ) : null}
        :{' '}
        {n !== null ? (
          <>
            <Num value={n} /> {n === 1 ? 'observation' : 'observations'} about {view.crewId}
          </>
        ) : (
          <span className="lfc-missing">packet unavailable ({packet.error ?? packet.status})</span>
        )}
        {inPacket.length ? <span className="lfc-fine"> ({inPacket.map(midSentence).join(', ')})</span> : null}.
        {noRecord.length ? <span className="lfc-fine"> No record yet: {noRecord.map(midSentence).join(', ')}.</span> : null}
        {packet.withheld.length ? <span className="lfc-fine"> Withheld by consent: {packet.withheld.map(midSentence).join(', ')}.</span> : null}
      </p>
      {delivery || !queued ? (
        <p className="lfc-fine">
          {queued
            ? deliveryText(c.comms, c.t, 'it')
            : isOpen(s.status)
              ? `Held on board: nothing is sent until ${releaseSteps.length ? `the crew releases it (${stepList(def, releaseSteps)}) or ` : ''}the case escalates.`
              : 'Held on board: the case closed without escalation, so nothing is sent.'}
        </p>
      ) : null}
      <ButtonLink href={`#/downlink?case=${view.caseId}&crew=${view.crewId}`} variant={queued ? 'primary' : 'secondary'}>
        Open the ground packet
      </ButtonLink>
    </div>
  )
}

export function ClosePanel({ c, def, view, onDismiss }: { c: ActCtx; def: CaseDefFull; view: CaseView; onDismiss: (reason: string) => void }) {
  const s = view.state
  const [reason, setReason] = useState('')
  return (
    <Panel title="7. Resolve or escalate" eyebrow="Close" id="case-close">
      {s.status === 'resolved' ? (
        <p className="lfc-done">
          <SeverityBadge severity="nominal" label="Resolved" /> at <MetTime t={s.closed_at ?? c.t} label />. The tripwire stayed clear. If a trigger
          reaches caution again after this, the case opens again as a new instance.
        </p>
      ) : s.status === 'dismissed' ? (
        <p className="lfc-done">
          Dismissed <MetTime t={s.closed_at ?? c.t} label />: {s.dismiss_reason}
        </p>
      ) : s.status === 'escalated' ? (
        <div className="lfc-escalated">
          <EscalatedLine view={view} t={c.t} />
          <EscalationTiers c={c} view={view} idSuffix="close" packetLink={false} />
        </div>
      ) : (
        <p className="lfc-fine">
          Not closed. The tripwire decides: clear → resolved; tripped → escalated, first to {view.tier1.backup ? `${view.tier1.name} (${view.tier1.crewId}), ${view.tier1.roleText},` : 'the Crew Medical Officer'}{' '}
          onboard, then to the flight surgeon through the ground packet. A “yes” to a red-flag question escalates at once.
        </p>
      )}
      <PacketBlock c={c} def={def} view={view} delivery={s.status !== 'escalated'} />
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
            <DismissRedFlagNote def={def} state={s} />
            <label htmlFor="lfc-dismiss">Why is this case not needed?</label>
            <input id="lfc-dismiss" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
            <p className="lfc-fine">
              Dismissing closes this case for {view.crewId}: its guidance and tripwire stop
              {packetStateOf(s) === 'queued' ? ', and the ground packet already queued is still sent' : ', and its ground packet stays held on board'}; the
              reading that opened it stays in the alert bar while it is still flagged.
            </p>
            <Button type="submit" variant="secondary" disabled={!reason.trim()}>
              Dismiss for {view.crewId}
            </Button>
          </form>
        </Expander>
      ) : null}
    </Panel>
  )
}
