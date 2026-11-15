// #/eva - EVA in a blackout: the [V1 6006] evidence board (not in the nav; linked from the body map's VO2max card).
//
// NASA-STD-3001 requires ground medical support to clear every crewmember before each EVA ([V1 6006]). Behind the
// Sun no answer can reach the crew until the link resumes. For the crewmember in ?crew= (default: the store's),
// this page shows the requirement verbatim, the ground link (loss of signal, resume, earliest review: light time
// only), the evidence its rationale names under its own three phrases, each item dated before or after loss of
// signal, the constraints in force, who can monitor a suited crewmember, and three options for the program with
// no pick. Every verdict is the engine's finding; LANDFALL never clears anyone for EVA.
import { useLayoutEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { formatCommsLightTime, formatCountdown, formatEarliestReply, formatLightTime, useComms, windowModelNote } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import { useSnapshot } from '../../app/data'
import type { LoadStatus, Snapshot } from '../../app/data'
import { useMission } from '../../app/mission'
import { useCases, useEvaluation, useScenario } from '../../app/model'
import type { FeatureProps } from '../../app/router'
import { environment } from '../../app/scenario'
import type { Environment } from '../../app/scenario'
import { observationsFor, seriesKey } from '../../app/scenarioData'
import { CREW, crewMember, isCrewId } from '../../app/vocab'
import type { CrewId } from '../../app/vocab'
import { Chip, Citation, EmptyState, FindingBadge, FreshnessChip, MetTime, Num, Panel, ReqId, SeverityBadge, SimulatedMarker, UnknownIcon } from '../../ui'
import './eva.css'
import { EARLIEST_REVIEW_LABEL, NEVER_CLEARS, REQ_ID, chipFor, evaBoard } from './model'
import type { EvaBoard, EvidenceGroup, EvidenceRow, EvaSources, ProgramOption, QuotedRequirement, SScaleData, SepEventsData, StdData } from './model'

const LIT = chipFor('literature', 'literature')
const NOAA = chipFor('noaa', 'NOAA-published')

/** Snapshot metadata the page cites in its footers (any may be absent from a build). */
export interface EvaSnapshots {
  vol1: { snapshot: Snapshot | null; status: LoadStatus }
  vol2: { snapshot: Snapshot | null; status: LoadStatus }
  sScale: { snapshot: Snapshot | null; status: LoadStatus }
  sep: { snapshot: Snapshot | null; status: LoadStatus }
}

// ---- small parts ------------------------------------------------------------------------------------------

function Age({ s }: { s: number | null }) {
  if (s === null) return <Num value={null} />
  return <span className="lf-num">{formatCountdown(s)}</span>
}

function Missing({ children = 'Missing' }: { children?: ReactNode }) {
  return (
    <span className="lf-dq" data-tone="stale" data-eva-missing="">
      <UnknownIcon size={14} />
      <span>{children}</span> <ReqId id="V2 10020" />
    </span>
  )
}

function Quote({ text }: { text: string }) {
  return <q className="lf-eva-q">{text}</q>
}

/** The rationale, verbatim, with its three phrases in bold (no colour: yellow means Caution). */
function Rationale({ text, phrases }: { text: string; phrases: readonly string[] }) {
  const parts: ReactNode[] = []
  let rest = text
  let i = 0
  for (const p of phrases) {
    const at = rest.indexOf(p)
    if (at < 0) continue
    parts.push(rest.slice(0, at), <strong key={i++}>{p}</strong>)
    rest = rest.slice(at + p.length)
  }
  parts.push(rest)
  return <>{parts}</>
}

const SIDE_WORDS = { before: 'Before loss of signal', after: 'After loss of signal' } as const

/**
 * The engine's verdict, in the words the rest of LANDFALL uses: a personal band is not a limit, so a Tier B
 * "within" reads "No reliable change" (as on Trends), never "Within limit"; data-quality states stay cyan.
 */
function Verdict({ r }: { r: EvidenceRow }) {
  const f = r.finding
  if (!f) {
    return (
      <span className="lf-eva-none">
        <span aria-hidden="true">—</span>
        <span className="sr-only">no engine verdict on this row</span>
      </span>
    )
  }
  if (f.category === 'PERSONAL' && f.status === 'reliable_change') return <SeverityBadge severity={f.severity} label="Reliable change" />
  if (f.category === 'PERSONAL' && f.status === 'within') return <SeverityBadge severity="nominal" label="No reliable change" />
  return <FindingBadge finding={f} />
}

function ValueCell({ r }: { r: EvidenceRow }) {
  if (r.missing) return <Missing />
  if (r.value !== null) {
    // One element per cell: on a phone the cell is a two-column grid (label, value).
    return (
      <span className="lf-eva-cell">
        <Num value={r.value} unit={r.unit ?? undefined} />
        {r.floor ? (
          <span className="lf-eva-floor">
            {' '}
            against the floor <Num value={r.floor.value} unit={r.floor.unit} /> {r.floor.requirementId ? <ReqId id={r.floor.requirementId} /> : null}{' '}
            <Chip kind={r.chip} />
          </span>
        ) : null}
      </span>
    )
  }
  return <span className="lf-eva-cell">{r.text ?? <Num value={null} />}</span>
}

function EvidenceTable({ group, board, index }: { group: EvidenceGroup; board: EvaBoard; index: number }) {
  const showSide = board.losT !== null
  const showReview = board.ground !== 'reachable'
  const headId = `eva-g-${group.id}`
  return (
    <section className="lf-eva-group" aria-labelledby={headId} data-eva-group={group.id}>
      <h3 id={headId} className="lf-eva-group-h">
        <span className="lf-num lf-eva-group-n">{index + 1}</span> <q>{group.phrase}</q>
        {!group.phraseFound ? (
          <span className="lf-dq" data-tone="stale">
            <UnknownIcon size={14} /> not checked against the frozen rationale
          </span>
        ) : null}
      </h3>
      <p className="lf-eva-holds">{HOLDS[group.id]}</p>
      <div className="lf-eva-table-wrap" tabIndex={0} role="region" aria-labelledby={headId}>
        <table className="lf-eva-table">
          <caption className="sr-only">
            {group.phrase}: what LANDFALL holds for {board.crewId}, dated against the earliest review
          </caption>
          <thead>
            <tr>
              <th scope="col">Evidence</th>
              <th scope="col">Value</th>
              <th scope="col">Engine verdict</th>
              <th scope="col">Available at</th>
              {showSide ? <th scope="col">Before / after loss of signal</th> : null}
              <th scope="col">Age now</th>
              {showReview ? <th scope="col">Age at earliest review</th> : null}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r) => (
              <tr key={r.key} data-eva-row={r.key} data-side={r.side ?? undefined} data-missing={r.missing || undefined}>
                <th scope="row" data-label="Evidence">
                  {r.href ? <a href={r.href}>{r.label}</a> : r.label}
                </th>
                <td data-label="Value">
                  <ValueCell r={r} />
                </td>
                <td data-label="Engine verdict">
                  <Verdict r={r} />
                </td>
                <td data-label="Available at">{r.met !== null ? <MetTime t={r.met} label /> : <Num value={null} />}</td>
                {showSide ? <td data-label="Loss of signal">{r.side ? SIDE_WORDS[r.side] : <Num value={null} />}</td> : null}
                <td data-label="Age now">
                  <Age s={r.ageNow} />
                </td>
                {showReview ? (
                  <td data-label="Age at earliest review">
                    <Age s={r.ageAtReview} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const HOLDS: Record<EvidenceGroup['id'], string> = {
  medical:
    'What LANDFALL holds here: the open cases in its log and the daily Noon Sight. These are records, not tests, and a physician’s examination is not in LANDFALL.',
  fitness: 'What LANDFALL holds here: the VO₂max tests. The engine’s verdict is on the latest test; earlier tests are listed as values. There is no exercise-session log.',
  metrics: 'What LANDFALL holds here: today’s personal-baseline verdicts (Tier B), as the engine gave them.',
}

function GroundLine({ board, comms, env }: { board: EvaBoard; comms: CommsStatus; env: Environment }) {
  if (comms.basis === 'fallback' && comms.snapshotStatus === 'loading') {
    return (
      <div className="lf-eva-ground" data-eva-ground="" data-ground="loading">
        <p className="lf-eva-ground-head">Reading the light time and the conjunction window from the frozen ephemeris.</p>
      </div>
    )
  }
  if (board.ground === 'unreachable') {
    return (
      <div className="lf-eva-ground" data-eva-ground="" data-ground="unreachable">
        <p className="lf-eva-ground-head">
          <strong>No ground link{comms.reason === 'solar_conjunction' ? ': solar conjunction' : ''}.</strong> No answer from Earth can reach the
          crew before the link resumes.
        </p>
        <dl className="lf-eva-ground-grid">
          <div>
            <dt>Loss of signal</dt>
            <dd>{board.losT !== null ? <MetTime t={board.losT} label /> : <Missing />}</dd>
          </div>
          <div>
            <dt>Link resumes</dt>
            <dd>{board.resumeT !== null ? <MetTime t={board.resumeT} label /> : <Missing />}</dd>
          </div>
          <div data-eva-earliest-review="">
            <dt>Earliest review</dt>
            <dd>
              {board.earliestReviewT !== null ? <MetTime t={board.earliestReviewT} label /> : <Missing />}
              <span className="lf-eva-fine"> ({EARLIEST_REVIEW_LABEL})</span>
            </dd>
          </div>
          <div data-eva-round-trip-los="">
            <dt>Round trip</dt>
            <dd>
              {comms.round_trip_s !== null ? (
                <>
                  <span className="lf-num">{formatCommsLightTime(comms, true)}</span> now;{' '}
                </>
              ) : null}
              {board.roundTripAtResumeS !== null ? <span className="lf-num">{formatLightTime(board.roundTripAtResumeS)}</span> : <Missing />} when the link
              resumes <Chip kind={env.comms.chip} />
            </dd>
          </div>
        </dl>
        <p className="lf-eva-fine">
          {comms.earliest_reply_s !== null ? (
            <>
              The earliest review is <span className="lf-num">{formatCountdown(comms.earliest_reply_s)}</span> from now: the same “Earliest
              reply” as the Now page.{' '}
            </>
          ) : null}
          The conjunction window is {windowModelNote(comms.windowModel)}; light time from JPL Horizons.
        </p>
      </div>
    )
  }
  const rt = formatCommsLightTime(comms, true)
  return (
    <div className="lf-eva-ground" data-eva-ground="" data-ground={board.ground}>
      <p className="lf-eva-ground-head">
        {board.ground === 'reachable' ? (
          <strong>
            Ground reachable within the round trip (<span className="lf-num" data-eva-round-trip="">{rt}</span>).
          </strong>
        ) : (
          <strong>
            Ground link up, delayed: every answer takes at least the round trip (<span className="lf-num" data-eva-round-trip="">{rt}</span>).
          </strong>
        )}{' '}
        <Chip kind={env.comms.chip} />
      </p>
      <dl className="lf-eva-ground-grid">
        <div data-eva-earliest-review="">
          <dt>Earliest review</dt>
          <dd>
            {board.earliestReviewT !== null ? <MetTime t={board.earliestReviewT} label /> : <Missing />}
            <span className="lf-eva-fine"> ({EARLIEST_REVIEW_LABEL})</span>
          </dd>
        </div>
      </dl>
      {board.ground === 'delayed' ? (
        <p className="lf-eva-fine">
          “Delayed” means a minute or more each way <Chip kind={chipFor('design_choice', 'design choice')} />.
        </p>
      ) : null}
    </div>
  )
}

function CrewTabs({ crewId, onPick }: { crewId: CrewId; onPick?: (c: CrewId) => void }) {
  return (
    <nav className="lf-eva-crew" aria-label="Crewmember">
      {CREW.map((c) => (
        <a
          key={c.id}
          href={`#/eva?crew=${c.id}`}
          className="lf-eva-crew-tab"
          aria-current={c.id === crewId ? 'true' : undefined}
          onClick={() => onPick?.(c.id)}
        >
          <span className="lf-num">{c.id}</span> <span className="lf-eva-crew-role">{c.role}</span>
        </a>
      ))}
    </nav>
  )
}

function Constraints({ board }: { board: EvaBoard }) {
  const { sLevel, shelter, rad } = board.constraints
  return (
    <ul className="lf-eva-list" data-eva-constraints="">
      <li data-eva-constraint="s-level">
        <p>
          <strong>Space weather now: </strong>
          {sLevel.level !== null ? (
            <>
              <span className="lf-num">{sLevel.level > 0 ? `S${sLevel.level}` : 'below S1'}</span>, ≥10 MeV proton flux <Num value={sLevel.flux} unit="pfu" />
              {sLevel.fluxT !== null ? (
                <>
                  {' '}
                  at <MetTime t={sLevel.fluxT} label />
                </>
              ) : null}{' '}
              ({sLevel.atMars ? 'Mars-orbit monitor, relayed' : 'NOAA GOES'}
              {sLevel.provenance === 'replay' ? ': a time-shifted replay of the real October 1989 event' : ''}).{' '}
              {sLevel.finding ? <FindingBadge finding={sLevel.finding} /> : null}
            </>
          ) : (
            <Missing>No proton flux reading</Missing>
          )}
        </p>
        {sLevel.quote ? (
          <p data-eva-s3="">
            NOAA’s {sLevel.quote.level}
            {sLevel.quote.descriptor ? ` (${sLevel.quote.descriptor})` : ''} text, verbatim: <Quote text={sLevel.quote.text} /> <Chip kind={NOAA} />
          </p>
        ) : null}
        {sLevel.atMars && sLevel.ruleChip ? (
          <p className="lf-eva-fine">
            NOAA does not define its scale away from Earth; applying it at Mars is LANDFALL’s choice <Chip kind={sLevel.ruleChip} />.
          </p>
        ) : null}
      </li>
      {shelter ? (
        <li data-eva-constraint="shelter">
          <p>
            <strong>
              Open case: <a href={shelter.href}>{shelter.title}</a>
            </strong>{' '}
            ({shelter.status === 'escalated' ? 'escalated' : 'open'}
            {shelter.openedAt !== null ? (
              <>
                {shelter.status === 'escalated' ? '; opened at ' : ' since '}
                <MetTime t={shelter.openedAt} label />
              </>
            ) : null}
            ).
          </p>
          {shelter.p1 ? (
            <p data-eva-p1="">
              Its first step, verbatim: <Quote text={shelter.p1} />
            </p>
          ) : null}
        </li>
      ) : null}
      {rad ? (
        <li data-eva-constraint="rad">
          <p data-eva-rad="">
            <strong>The RAD team’s figure for its own nowcast at Gale</strong>, verbatim: <Quote text={rad.text} />{' '}
            {rad.cite ? <Citation source={{ kind: 'literature', citation: rad.cite, url: rad.url ?? undefined }} /> : null}{' '}
            <Chip kind={LIT} />
          </p>
        </li>
      ) : null}
    </ul>
  )
}

function Requirement({ q }: { q: QuotedRequirement }) {
  return (
    <div className="lf-eva-mon-req" data-eva-req={q.id}>
      <p>
        <ReqId id={q.id} /> {q.title ? <strong>{q.title}</strong> : null}
        {q.page !== null ? (
          <span className="lf-eva-fine">
            {' '}
            · Vol 2 §{q.section}, p. <span className="lf-num">{q.page}</span>
          </span>
        ) : null}
      </p>
      <p>
        <Quote text={q.text} />
      </p>
      {q.rationale ? (
        <p className="lf-eva-fine">
          Rationale, verbatim: <Quote text={q.rationale} />
        </p>
      ) : null}
    </div>
  )
}

function Monitoring({ board, comms, env }: { board: EvaBoard; comms: CommsStatus; env: Environment }) {
  const m = board.monitoring
  return (
    <>
      {m.requirements.map((q) => (
        <Requirement key={q.id} q={q} />
      ))}
      <p className="lf-eva-computed" data-eva-light="">
        The ground sees each suit reading at least one-way light time late (
        {comms.one_way_s === null && !comms.range ? <Num value={null} /> : <span className="lf-num">{formatCommsLightTime(comms)}</span>} now)
        {m.blocked ? '; during the conjunction, not at all' : ''}. <Chip kind={env.comms.chip} />
      </p>
    </>
  )
}

/**
 * The wait for a ground answer, printed as the Now page prints its "Earliest reply" (formatEarliestReply): "11 d 06 h"
 * behind the Sun, the round trip while the link is up ("≤2.00 s" at the ISS), never a minute-rounded "0 min".
 */
function waitText(waitS: number, comms: CommsStatus): string {
  return formatEarliestReply({ earliest_reply_s: waitS, blocked: comms.blocked, range: comms.range, basis: comms.basis })
}

function OptionItem({ o, ground, comms }: { o: ProgramOption; ground: EvaBoard['ground']; comms: CommsStatus }) {
  if (o.id === 'postpone') {
    return (
      <li data-eva-option="postpone">
        <h3 className="lf-eva-opt-h">Postpone EVAs until a ground clearance can arrive</h3>
        <p>
          {o.earliestReviewT !== null ? (
            <>
              The earliest is <MetTime t={o.earliestReviewT} label />
              {o.waitS !== null ? (
                <>
                  , <span className="lf-num">{waitText(o.waitS, comms)}</span> from now
                </>
              ) : null}{' '}
              ({EARLIEST_REVIEW_LABEL}).
            </>
          ) : (
            <Missing>Light time unknown</Missing>
          )}
        </p>
      </li>
    )
  }
  if (o.id === 'before_los') {
    return (
      <li data-eva-option="before_los">
        <h3 className="lf-eva-opt-h">Clear before loss of signal, and accept older evidence</h3>
        {o.losT !== null && o.staleAtNextReviewS !== null ? (
          <p>
            A clearance given at loss of signal (<MetTime t={o.losT} label />) rests on evidence from before it. By the earliest next review that
            evidence is at least <span className="lf-num" data-eva-stale-days="">{formatCountdown(o.staleAtNextReviewS)}</span> old.
          </p>
        ) : ground === 'unreachable' ? (
          <p>
            <Missing>Loss of signal time unknown</Missing>
          </p>
        ) : (
          <p>No loss of signal now: the link is up.</p>
        )}
      </li>
    )
  }
  return (
    <li data-eva-option="delegate">
      <h3 className="lf-eva-opt-h">Delegate EVA medical clearance onboard</h3>
      <p>
        <ReqId id={REQ_ID} /> as written names ground medical support personnel; it does not provide for an onboard decision.
      </p>
    </li>
  )
}

// ---- the view (pure: renders a board) ------------------------------------------------------------------

export function EvaView({
  board,
  env,
  comms,
  snapshots,
  onPickCrew,
  evaluationStatus = 'ready',
}: {
  board: EvaBoard
  env: Environment
  comms: CommsStatus
  snapshots: EvaSnapshots
  onPickCrew?: (c: CrewId) => void
  evaluationStatus?: LoadStatus
}) {
  const crew = crewMember(board.crewId)
  const req = board.requirement
  const phrases = board.groups.map((g) => g.phrase)
  return (
    <div className="lf-eva">
      <header className="lf-eva-head">
        <p className="lf-eyebrow">
          {crew.id} · {crew.role} · {env.label}
        </p>
        <h1>EVA in a blackout</h1>
        <p className="lf-eva-lede">
          NASA requires ground medical support to clear every crewmember before each EVA. This page gathers the evidence that requirement’s
          rationale names and dates it against the earliest moment the ground could review it.
        </p>
        <p className="lf-eva-never" data-eva-never="">
          <strong>{NEVER_CLEARS}</strong> The decision belongs to the program and to ground medical support.
        </p>
        <SimulatedMarker variant="banner">Crew values are simulated. NASA and NOAA text, light time and the conjunction window come from frozen snapshots.</SimulatedMarker>
      </header>

      <Panel title="What NASA requires" eyebrow="NASA-STD-3001 Vol 1" className="lf-eva-panel" footer={<FreshnessChip meta={snapshots.vol1.snapshot} status={snapshots.vol1.status} id="std_vol1_requirements" />}>
        {req ? (
          <figure className="lf-eva-req" data-eva-v16006="">
            <blockquote>
              <p>“{req.text}”</p>
            </blockquote>
            <figcaption>
              <ReqId id={req.id} /> NASA-STD-3001 Vol 1 Rev C{req.section ? ` §${req.section}` : ''}
              {req.title ? ` ${req.title}` : ''}
              {req.page !== null ? (
                <>
                  , p. <span className="lf-num">{req.page}</span>
                </>
              ) : null}
              {req.verified ? ' · verbatim, checked against the PDF at build' : ''}
            </figcaption>
            {req.rationale ? (
              <p className="lf-eva-rationale">
                <span className="lf-eva-fine">Rationale, verbatim: </span>“<Rationale text={req.rationale} phrases={phrases} />”
              </p>
            ) : null}
          </figure>
        ) : (
          <EmptyState
            kind={snapshots.vol1.status === 'loading' ? 'loading' : 'missing'}
            title={snapshots.vol1.status === 'loading' ? `Reading the ${REQ_ID} text from the frozen standard` : `The ${REQ_ID} text is not in this build`}
            headingLevel={3}
          >
            <p>No text is typed in its place.</p>
          </EmptyState>
        )}
      </Panel>

      <Panel title="Ground link" eyebrow={env.label} className="lf-eva-panel">
        <GroundLine board={board} comms={comms} env={env} />
      </Panel>

      <Panel title="The evidence, dated" eyebrow="Under the rationale’s three phrases" className="lf-eva-panel">
        <CrewTabs crewId={board.crewId} onPick={onPickCrew} />
        <SimulatedMarker />
        {evaluationStatus === 'ready' ? (
          board.groups.map((g, i) => <EvidenceTable key={g.id} group={g} board={board} index={i} />)
        ) : (
          <EmptyState kind={evaluationStatus === 'loading' ? 'loading' : evaluationStatus === 'error' ? 'error' : 'missing'} title="The mission evaluation is not ready" headingLevel={3}>
            <p>No evidence is listed rather than a guess.</p>
          </EmptyState>
        )}
      </Panel>

      <Panel
        title="Constraints in force"
        className="lf-eva-panel"
        footer={
          <>
            <FreshnessChip meta={snapshots.sScale.snapshot} status={snapshots.sScale.status} id="swpc_s_scale" compact />
            {board.constraints.rad ? <FreshnessChip meta={snapshots.sep.snapshot} status={snapshots.sep.status} id="hapi_msl_rad_sep_events" compact /> : null}
          </>
        }
      >
        <Constraints board={board} />
      </Panel>

      <Panel
        title="Who can monitor a suited crewmember"
        eyebrow="NASA-STD-3001 Vol 2"
        className="lf-eva-panel"
        footer={<FreshnessChip meta={snapshots.vol2.snapshot} status={snapshots.vol2.status} id="std_vol2_requirements" compact />}
      >
        <Monitoring board={board} comms={comms} env={env} />
      </Panel>

      <Panel title="Options for the program" className="lf-eva-panel" actions={<span className="lf-eva-tag">For the program to decide</span>}>
        <p>LANDFALL lists three options and does not pick one.</p>
        <ol className="lf-eva-options">
          {board.options.map((o) => (
            <OptionItem key={o.id} o={o} ground={board.ground} comms={comms} />
          ))}
        </ol>
        <p className="lf-eva-never">
          <strong>{NEVER_CLEARS}</strong>
        </p>
      </Panel>
    </div>
  )
}

// ---- the route -------------------------------------------------------------------------------------------

export default function Eva({ query }: FeatureProps) {
  const { state, setCrew } = useMission()
  const qCrew = isCrewId(query.crew) ? query.crew : null
  // ?crew= picks the crewmember (as on the body map and Trends); before the first paint, so a deep link never
  // shows another crewmember first.
  useLayoutEffect(() => {
    if (qCrew && qCrew !== state.crewId) setCrew(qCrew)
    // only when the query changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qCrew])
  const crewId = state.crewId
  const envId = state.envId
  const env = environment(envId)
  const scenario = useScenario()
  const { evaluation, t, status } = useEvaluation()
  const { cases } = useCases()
  const comms = useComms(envId, t)
  const commsAtResume = useComms(envId, comms.resumes_at ?? t)
  const vol1 = useSnapshot<StdData>('std_vol1_requirements')
  const vol2 = useSnapshot<StdData>('std_vol2_requirements')
  const sScale = useSnapshot<SScaleData>('swpc_s_scale')
  const sep = useSnapshot<SepEventsData>('hapi_msl_rad_sep_events')
  const index = scenario.index
  const runtime = state.observations
  const noonSights = state.noonSights

  const board = useMemo(() => {
    const observations = index ? observationsFor(index, runtime, crewId, 'vo2max') : []
    // Noon Sight check-ins: the simulated record's daily check-in times (never its values) and this session's fixes.
    const checkins = [
      ...(index?.series.get(seriesKey(crewId, 'mood')) ?? []).map((o) => o.t),
      ...noonSights.filter((n) => n.crew_id === crewId).map((n) => n.t),
    ]
    const sources: EvaSources = {
      vol1: vol1.status === 'ready' ? vol1.data : null,
      vol2: vol2.status === 'ready' ? vol2.data : null,
      sScale: sScale.status === 'ready' ? sScale.data : null,
      sep: sep.status === 'ready' ? sep.data : null,
    }
    return evaBoard({ crewId, env, comms, commsAtResume: comms.resumes_at !== null ? commsAtResume : null, evaluation, caseViews: cases, observations, checkins, sources, t })
  }, [index, runtime, crewId, noonSights, vol1, vol2, sScale, sep, env, comms, commsAtResume, evaluation, cases, t])

  return (
    <EvaView
      board={board}
      env={env}
      comms={comms}
      snapshots={{ vol1, vol2, sScale, sep }}
      onPickCrew={setCrew}
      evaluationStatus={evaluation ? 'ready' : status}
    />
  )
}
