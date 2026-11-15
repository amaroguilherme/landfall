// DOWNLINK (#/downlink): the privacy gate and the delay-tolerant ground packet.
//   - Held on board: everything held on this device for the selected crewmember, with a
//     per-variable sharing switch (store consent). Mood is private by default and only a
//     separate, explicit "share mood" action with a plain warning can change that.
//   - In the ground packet: the FHIR R4 Bundle the ENGINE builds for the selected case
//     (useGroundPacket -> buildGroundPacket), shown as counts, codes, bytes and pretty JSON, plus a
//     case's note for the flight surgeon (D12: the only place a medication is named).
//   - Packet state: ONE state for every view (app/packet.ts, meta.json packet_states): "Prepared (held
//     on board)" until the crew releases it or the case escalates, then "Queued"; a queued packet is sent
//     when a link exists (engine commsEta: at Mars during the modelled conjunction window, when the link
//     resumes). The escalation tiers (D4) say who has the case now and when the ground gets it.
// Nothing is transmitted: there is no backend, and "Copy packet" only uses the local clipboard.
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { FeatureProps } from '../../app/router'
import { useMission, selectLogbook } from '../../app/mission'
import { useCases, useGroundPacket, useScenario } from '../../app/model'
import type { CaseView } from '../../app/caseTimeline'
import { CASE_DEFS, CASE_IDS, tierOneQuotes } from '../../app/caseTimeline'
import { visibleObservations } from '../../app/scenarioData'
import { formatUtc, useSnapshot } from '../../app/data'
import type { Snapshot, SnapshotState } from '../../app/data'
import { useComms, formatCommsLightTime, formatCountdown, formatEarliestReply, windowModelNote } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import { RULES, consentAllows, thresholdRules } from '../../app/engine'
import type { CaseStatus, FhirBundle } from '../../app/engine'
import { autonomyText, escalationTiers, packetDelivery, packetState, ESCALATION_BASIS } from '../../app/packet'
import type { PacketState } from '../../app/packet'
import { CREW, crewMember, isCrewId } from '../../app/vocab'
import type { CrewId, Observation } from '../../app/vocab'
import {
  AntennaIcon,
  Button,
  ChevronIcon,
  Chip,
  Citation,
  EmptyState,
  FreshnessChip,
  MetTime,
  Num,
  ReqId,
  SimulatedMarker,
  SunIcon,
  UnknownIcon,
} from '../../ui'
import { CopyIcon, InPacketIcon, LockIcon, OnboardIcon, PacketIcon, QueuedIcon, UnlockIcon } from './icons'
import {
  casesRequesting,
  findRequirement,
  houstonRows,
  knownRows,
  previewBundle,
  prettyPacket,
  sentenceContaining,
  summarizePacket,
  surgeonNoteOf,
  variableLabel,
} from './model'
import type { HoustonRow, KnownRow, PacketSummary, SurgeonNote, Vol2Requirement } from './model'
import './downlink.css'

/** Entries shown in the on-screen JSON preview before "Show all" (a display choice only). */
const PREVIEW_ENTRIES = 3

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

const STATUS_TEXT: Record<CaseStatus, string> = {
  idle: 'not open',
  detected: 'detected',
  acting: 'acting',
  watch: 'watching',
  resolved: 'resolved',
  escalated: 'escalated',
  dismissed: 'dismissed',
}

interface Vol2Data {
  document?: { revision?: string; approved?: string; title?: string; pdf_url?: string }
  requirements?: unknown[]
}

type QueueState = 'queued' | 'prepared' | 'not_open' | 'no_packet' | 'unavailable'

type LabelMeta = Record<string, { label?: string; cadence?: string; definition?: string } | undefined>

/** Table 4.8-1 organ doses by variable, named by their rules' own Table 4.8-1 row ("Central Nervous System"). */
const TABLE_481_ROW: ReadonlyMap<string, string> = new Map(
  thresholdRules(RULES).flatMap((r) => {
    const src = r.source as { table?: unknown; row?: unknown }
    return src.table === 'Table 4.8-1' && typeof src.row === 'string' ? [[r.variable, src.row] as const] : []
  }),
)

/**
 * Labels for the packet variables nothing else names: an organ dose a case asks for that the scenario never records
 * (the shelter case's central nervous system and circulatory system doses) would otherwise read as its bare id. It
 * takes its Table 4.8-1 row: "Central Nervous System" -> "Central nervous system dose". Named variables keep theirs.
 */
function withOrganDoseLabels(meta: LabelMeta, scope: readonly string[]): LabelMeta {
  let out: LabelMeta | null = null
  for (const v of scope) {
    const row = TABLE_481_ROW.get(v)
    if (!row || variableLabel(v, meta) !== v) continue
    out = out ?? { ...meta }
    out[v] = { ...meta[v], label: `${row.charAt(0)}${row.slice(1).toLowerCase()} dose` }
  }
  return out ?? meta
}

// ---------------------------------------------------------------------------------------------

export default function Downlink({ query }: FeatureProps) {
  const { state, setCrew } = useMission()
  const crewId = state.crewId

  // Deep links: #/downlink?crew=CM-3&case=renal_stone
  useEffect(() => {
    if (isCrewId(query.crew)) setCrew(query.crew)
  }, [query.crew, setCrew])
  const queryCase = query.case && CASE_IDS.includes(query.case) ? query.case : null
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() => setChosen(null), [query.case])

  const cases = useCases()
  const mine = useMemo(() => cases.cases.filter((v) => v.crewId === crewId), [cases.cases, crewId])
  // Default: the crewmember's most recently opened case (at scenario "now": the SPE shelter).
  const autoCase = useMemo(() => {
    const open = mine.filter((v) => v.state.status !== 'idle' && v.state.opened_at !== null)
    open.sort((a, b) => (b.state.opened_at ?? 0) - (a.state.opened_at ?? 0))
    return open[0]?.caseId ?? null
  }, [mine])
  const caseId = chosen ?? queryCase ?? autoCase ?? CASE_IDS[0]

  const scenario = useScenario()

  if (scenario.status === 'loading' || cases.status === 'loading') {
    return (
      <EmptyState kind="loading" title="Ground packet" headingLevel={1}>
        <p>Loading the scenario and the frozen standards from this site.</p>
      </EmptyState>
    )
  }
  if (!scenario.index) {
    return (
      <EmptyState kind={scenario.status === 'missing' ? 'missing' : 'error'} title="Ground packet" headingLevel={1}>
        <p>
          The simulated crew scenario (<code>sim_crew.json</code>) is {scenario.status === 'missing' ? 'not in this build' : 'unreadable'}, so
          there is nothing to put in a packet. {scenario.error ? <code>{scenario.error}</code> : null}
        </p>
      </EmptyState>
    )
  }
  const casesError = cases.status === 'error' ? (cases.error ?? 'unknown error') : null
  return <DownlinkView crewId={crewId} caseId={caseId} cases={mine} scripted={cases.scripted} casesError={casesError} onPickCase={setChosen} />
}

// ---------------------------------------------------------------------------------------------

function DownlinkView({
  crewId,
  caseId,
  cases,
  scripted,
  casesError,
  onPickCase,
}: {
  crewId: CrewId
  caseId: string
  cases: CaseView[]
  /** The seeded crew's answers as observations (useCases().scripted), held on board like a logged answer. */
  scripted: readonly Observation[]
  /** The shared case model failed (engine error): no case state, so no packet can be built. */
  casesError: string | null
  onPickCase: (id: string) => void
}) {
  const { state, setCrew, setConsent } = useMission()
  const scenario = useScenario()
  const packet = useGroundPacket(caseId, crewId)
  const comms = useComms()
  const vol2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const replaySnap = useSnapshot('swpc_spe_replay')
  const simSnap = useSnapshot('sim_crew')
  const crew = crewMember(crewId)
  const index = scenario.index!
  const t = packet.t
  const view = cases.find((c) => c.caseId === caseId) ?? null
  const def = view?.def ?? CASE_DEFS.find((d) => d.id === caseId) ?? null
  const scope = useMemo(() => view?.state.spec.escalation?.observations ?? [], [view])

  const known = useMemo(
    () => knownRows(visibleObservations(index, scripted.length ? [...state.observations, ...scripted] : state.observations, t), crewId, index.variables),
    [index, state.observations, scripted, t, crewId],
  )
  const summary = useMemo(() => (packet.bundle ? summarizePacket(packet.bundle, scope, crewId) : null), [packet.bundle, scope, crewId])
  const houston = useMemo(
    () => houstonRows(scope, packet.consent, summary, known, withOrganDoseLabels(index.variables, scope)),
    [scope, packet.consent, summary, known, index.variables],
  )

  const req6164 = findRequirement(vol2.data, 'V2 6164')
  const req10125 = findRequirement(vol2.data, 'V2 10125')
  const clause6164 = sentenceContaining(req6164?.rationale, 'upon being restored')

  // One polite live region for this page: consent changes and copy results.
  const [announce, setAnnounce] = useState('')
  const say = (s: string) => setAnnounce((prev) => (prev === s ? `${s} ` : s))

  // The same packet state as the hero and the case page (app/packet.ts); the link only decides WHEN a queued packet is sent.
  const pstate = packetState(view?.state ?? null)
  const queue: QueueState = casesError
    ? 'unavailable'
    : pstate.id === 'no_packet'
      ? 'no_packet'
      : pstate.id === 'not_open'
        ? 'not_open'
        : pstate.id

  const toggle = (row: KnownRow, shared: boolean) => {
    setConsent(crewId, row.variable, shared)
    say(`${row.label}: ${shared ? 'shared with Houston' : 'kept on board, withheld from Houston'}.`)
  }

  return (
    <div className="dl">
      <header className="dl-head">
        <p className="lf-eyebrow">Downlink · delay-tolerant ground packet · FHIR R4</p>
        <h1>Ground packet</h1>
        <p className="dl-lede">
          The crew acts on board without waiting for Houston. When a case opens, a packet for the flight surgeon is prepared and held on board
          (Prepared). It becomes Queued when the crew releases it or the case escalates, and a queued packet is sent when a link exists. The
          crewmember decides what goes in it.
        </p>
        <SimulatedMarker variant="banner">
          Crew values on this page are simulated. Light time comes from the JPL Horizons ephemeris and the conjunction window is modelled from
          it; the proton event is a replay of real NOAA data. All frozen at build. Nothing leaves this browser.
        </SimulatedMarker>
      </header>

      <div className="dl-pickers">
        <Segmented
          legend="Whose data"
          name="dl-crew"
          value={crewId}
          onChange={(v) => isCrewId(v) && setCrew(v)}
          options={CREW.map((c) => ({ value: c.id, label: c.id, sub: c.role }))}
        />
        <Segmented
          legend="Packet for case"
          name="dl-case"
          value={caseId}
          onChange={onPickCase}
          options={CASE_IDS.map((id) => {
            const v = cases.find((c) => c.caseId === id)
            const d = v?.def ?? CASE_DEFS.find((x) => x.id === id)
            const status = v?.state.status ?? 'idle'
            return { value: id, label: d?.title ?? id, sub: casesError ? 'unavailable' : STATUS_TEXT[status], dim: status === 'idle' }
          })}
        />
      </div>

      <QueueCard
        queue={queue}
        packet={pstate}
        comms={comms}
        t={t}
        crewId={crewId}
        caseTitle={def?.title ?? caseId}
        view={view}
        summary={summary}
        req={req6164}
        clause={clause6164}
        vol2={vol2}
        onCopied={say}
      />

      {queue !== 'unavailable' && queue !== 'no_packet' ? <EscalationPanel view={view} comms={comms} t={t} /> : null}

      {casesError ? (
        <EmptyState kind="error" title="Cases are unavailable right now">
          <p>
            The engine stopped while evaluating the cases, so there is no case state to build a packet from. LANDFALL shows the error rather
            than an empty packet. The privacy gate and the link status still work. Detail: <code>{casesError}</code>
          </p>
        </EmptyState>
      ) : packet.status === 'error' ? (
        <EmptyState kind="error" title="The engine could not build this packet">
          <p>
            <code>{packet.error}</code>
          </p>
        </EmptyState>
      ) : null}

      <section className="dl-gate lf-panel" aria-labelledby="dl-gate-h">
        <header className="lf-panel-head">
          <div>
            <p className="lf-eyebrow">Privacy gate · {crew.id} {crew.role}</p>
            <h2 id="dl-gate-h" className="lf-panel-title">
              Held on board, and sent to the ground
            </h2>
          </div>
        </header>
        <div className="dl-cols">
          <KnowsColumn
            crewId={crewId}
            rows={known}
            scope={scope}
            consent={packet.consent}
            onToggle={toggle}
            onMood={(shared) => {
              setConsent(crewId, 'mood', shared)
              say(shared ? `Mood is now shared with Houston for ${crewId}.` : `Mood is private again for ${crewId}.`)
            }}
            replayTitle={(replaySnap.snapshot as Snapshot | null)?.title ?? null}
            logbook={selectLogbook(state, crewId).length}
            noonSights={state.noonSights.filter((n) => n.crew_id === crewId).length}
          />
          <SeesColumn
            crewId={crewId}
            caseTitle={def?.title ?? caseId}
            rows={houston}
            known={known}
            scope={scope}
            summary={summary}
            queue={queue}
            note={surgeonNoteOf(def)}
          />
        </div>
        <footer className="lf-panel-foot dl-gate-foot">
          <Requirement10125 req={req10125} vol2={vol2} />
        </footer>
      </section>

      {packet.bundle && summary ? (
        <PacketPanel bundle={packet.bundle} summary={summary} epoch={packet.missionEpoch} simSnap={simSnap} resetKey={`${crewId}:${caseId}`} onCopied={say} />
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}

// ---- pickers ---------------------------------------------------------------------------------

function Segmented({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string
  name: string
  value: string
  options: Array<{ value: string; label: string; sub?: string; dim?: boolean }>
  onChange: (v: string) => void
}) {
  return (
    <fieldset className="dl-seg">
      <legend>{legend}</legend>
      <div className="dl-seg-opts">
        {options.map((o) => (
          <label key={o.value} className="dl-opt" data-dim={o.dim || undefined}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span className="dl-opt-dot" aria-hidden="true" />
            <span className="dl-opt-text">
              <span className="dl-opt-label">{o.label}</span>
              {o.sub ? <span className="dl-opt-sub">{o.sub}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

// ---- queue status ------------------------------------------------------------------------------

function QueueCard({
  queue,
  packet,
  comms,
  t,
  crewId,
  caseTitle,
  view,
  summary,
  req,
  clause,
  vol2,
  onCopied,
}: {
  queue: QueueState
  packet: PacketState
  comms: CommsStatus
  t: number
  crewId: CrewId
  caseTitle: string
  view: CaseView | null
  summary: PacketSummary | null
  req: Vol2Requirement | null
  clause: string | null
  vol2: SnapshotState<Vol2Data>
  onCopied: (s: string) => void
}) {
  const resumes = comms.resumes_at
  // The packet state's own label (meta.json packet_states), identical on the hero and the case page.
  const tag: Record<QueueState, string> = {
    queued: packet.label,
    prepared: packet.label,
    not_open: 'Not open',
    no_packet: 'No packet',
    unavailable: 'Unavailable',
  }
  const owltUnknown = comms.one_way_s === null
  return (
    <section className="dl-queue" data-state={queue} aria-labelledby="dl-queue-h">
      <div className="dl-queue-main">
        <h2 id="dl-queue-h" className="sr-only">
          Packet status
        </h2>
        <p className="dl-queue-for">
          <PacketIcon size={14} /> Packet for <strong>{crewId}</strong> · {caseTitle}
          {view && view.state.status !== 'idle' ? (
            <>
              {' '}
              · case {STATUS_TEXT[view.state.status]} · opened <MetTime t={view.state.opened_at ?? t} label />
              {/* the opening and the escalation are two moments: "escalated since <opened>" named the wrong one */}
              {view.state.status === 'escalated' && view.state.escalation ? (
                <>
                  {' '}
                  · escalated <MetTime t={view.state.escalation.t} label />
                </>
              ) : null}
            </>
          ) : null}
        </p>
        <p className="dl-queue-status" aria-live="polite">
          <span className="dl-queue-tag">
            {queue === 'queued' ? <QueuedIcon size={18} /> : <OnboardIcon size={18} />}
            {tag[queue]}
          </span>
          <span className="dl-queue-line">
            {queue === 'queued' ? (
              <>
                Queued at <MetTime t={packet.queuedAt ?? t} label /> ({packet.reason === 'escalated' ? 'the case escalated' : 'released by the crew'}).{' '}
                {comms.blocked ? (
                  resumes !== null ? (
                    <>
                      Sent when the link resumes, in <span className="lf-num dl-big">{formatCountdown(resumes - t)}</span>
                    </>
                  ) : (
                    <>
                      Sent when the link resumes.{' '}
                      <span className="dl-missing">
                        <UnknownIcon size={13} /> Resume time unknown: the ephemeris is not in this build.
                      </span>
                    </>
                  )
                ) : (
                  <>
                    Sent at once: the link is up, and it reaches Houston in{' '}
                    <span className="lf-num dl-big" data-missing={owltUnknown || undefined}>
                      {formatCommsLightTime(comms)}
                    </span>{' '}
                    (one-way light time).
                  </>
                )}
              </>
            ) : queue === 'prepared' ? (
              <>
                {packetDelivery(packet, comms, t)}.
                {comms.blocked && resumes !== null ? (
                  <>
                    {' '}
                    The link is down in any case: it resumes in <span className="lf-num">{formatCountdown(resumes - t)}</span>.
                  </>
                ) : null}
              </>
            ) : queue === 'not_open' ? (
              <>This case is not open for {crewId}, so no packet is prepared. Below is what its packet would carry if it opened.</>
            ) : queue === 'unavailable' ? (
              <>The cases could not be evaluated, so no packet can be built. The link status below is still current.</>
            ) : (
              <>This case sends no ground packet.</>
            )}
          </span>
        </p>

        <dl className="dl-queue-dl">
          {comms.blocked && comms.reason === 'solar_conjunction' ? (
            <>
              <dt>Why</dt>
              <dd>
                <SunIcon size={13} /> Solar conjunction: the Sun is between Mars and Earth
                {comms.window ? (
                  <>
                    {' '}
                    from <time className="lf-num">{formatUtc(comms.window.startUtc)}</time> to{' '}
                    <time className="lf-num">{formatUtc(comms.window.stopUtc)}</time>, a window {windowModelNote(comms.windowModel)}
                  </>
                ) : null}
                .
              </dd>
            </>
          ) : null}
          {resumes !== null ? (
            <>
              <dt>Link resumes</dt>
              <dd>
                <MetTime t={resumes} label />
              </dd>
            </>
          ) : null}
          <dt>Light time</dt>
          <dd>
            <span className="lf-num" data-missing={owltUnknown || undefined}>
              {formatCommsLightTime(comms)}
            </span>{' '}
            one way ·{' '}
            <span className="lf-num" data-missing={owltUnknown || undefined}>
              {formatCommsLightTime(comms, true)}
            </span>{' '}
            round trip
          </dd>
          <dt>Earliest reply</dt>
          <dd>
            <span className="lf-num" data-missing={comms.earliest_reply_s === null || undefined}>
              {formatEarliestReply(comms)}
            </span>{' '}
            from now, if Houston answered instantly
          </dd>
          <dt>Source</dt>
          <dd className="dl-src">
            {comms.snapshotId ? (
              <FreshnessChip meta={comms.snapshot} status={comms.snapshotStatus ?? 'loading'} id={comms.snapshotId} source={comms.snapshot?.source} />
            ) : (
              <>
                {comms.env.label}: environment constant <Chip kind={comms.env.comms.chip} />
              </>
            )}
          </dd>
        </dl>
      </div>

      <div className="dl-queue-side">
        <figure className="dl-quote">
          {clause && req ? (
            <>
              <blockquote>
                <p>“{clause}”</p>
              </blockquote>
              <figcaption>
                <ReqId id={req.id} /> rationale, {req.title} · NASA-STD-3001 Vol. 2 Rev. {vol2.data?.document?.revision ?? '?'} §{req.section}. Verbatim
                from the frozen standard. On board the crew is already acting on the case; this packet is how the flight surgeon and the operations
                team get it.
              </figcaption>
            </>
          ) : (
            <figcaption className="dl-missing">
              <UnknownIcon size={13} /> The text of <ReqId id="V2 6164" /> is not available in this build.{' '}
              <FreshnessChip meta={vol2.snapshot} status={vol2.status} id="std_vol2_requirements" compact />
            </figcaption>
          )}
        </figure>
        {summary ? (
          <div className="dl-queue-copy">
            <p className="dl-queue-size">
              <Num value={summary.entries} /> {plural(summary.entries, 'observation', 'observations')} ·{' '}
              <Num value={summary.compactBytes} unit="bytes" /> compact JSON
            </p>
            <CopyButton text={summary.pretty} entries={summary.entries} bytes={summary.prettyBytes} onCopied={onCopied} />
          </div>
        ) : null}
      </div>
    </section>
  )
}

// ---- escalation tiers (D4) -----------------------------------------------------------------------

const REASON_TEXT: Record<string, string> = {
  tripwire: 'the tripwire tripped',
  red_flag: 'a red-flag question was answered yes',
}

function EscalationPanel({ view, comms, t }: { view: CaseView | null; comms: CommsStatus; t: number }) {
  const esc = view?.state.escalation ?? null
  const tiers = escalationTiers(comms, t, view?.tier1 ?? null)
  const autonomy = autonomyText(comms)
  // the crew's second Crew Medical Officer, on the first one's own cases: the same paragraph as the case page's TierOneBasis
  const backup = view?.tier1.backup ? view.tier1 : null
  const quotes = backup ? tierOneQuotes(backup) : null
  const stepNo = esc?.step_id ? (view?.state.spec.step_ids.indexOf(esc.step_id) ?? -1) + 1 : 0
  return (
    <section className="dl-esc lf-panel" aria-labelledby="dl-esc-h" data-escalated={esc ? true : undefined}>
      <header className="lf-panel-head">
        <div>
          <p className="lf-eyebrow">Escalation · two tiers</p>
          <h2 id="dl-esc-h" className="lf-panel-title">
            {esc ? 'Escalated' : 'If this case escalates'}
          </h2>
        </div>
        <div className="lf-panel-actions">
          <Chip kind={ESCALATION_BASIS.chip} />
        </div>
      </header>
      <div className="lf-panel-body">
        {esc ? (
          <p className="dl-col-note">
            Escalated at <MetTime t={esc.t} label />: {REASON_TEXT[esc.reason] ?? esc.reason}
            {stepNo > 0 ? (
              <>
                {' '}
                (step <span className="lf-num">{stepNo}</span>)
              </>
            ) : null}
            . The ground packet was queued then.
          </p>
        ) : (
          <p className="dl-col-note">A case escalates when its tripwire trips or a red-flag question is answered yes. Then:</p>
        )}
        <ol className="dl-tiers">
          {tiers.map((tier) => (
            <li key={tier.id}>
              <span className="dl-tier-n">
                Tier <span className="lf-num">{tier.tier}</span>
              </span>
              <span>
                <strong>
                  {tier.label}
                  {tier.crew ? `, ${tier.crew}` : ''}
                </strong>
                : {tier.when}.
              </span>
            </li>
          ))}
        </ol>
        {backup && quotes ? (
          <p className="dl-col-note">
            The Crew Medical Officer is the patient here, so tier 1 is {backup.roleText}, {backup.name} ({backup.crewId}).
            {quotes.secondCmo.length ? (
              <>
                {' '}
                NASA-STD-3001 requires at least two Crew Medical Officers: <ReqId id={quotes.secondCmo[0].requirementId} />{' '}
                {quotes.secondCmo.map((q, i) => (
                  <Fragment key={i}>
                    {i ? ' and ' : ''}“{q.verbatim}”
                  </Fragment>
                ))}
                .
              </>
            ) : null}{' '}
            Which crewmember holds the second assignment is a design choice <Chip kind={backup.chip} />.
            {quotes.usability ? (
              <>
                {' '}
                NASA-STD-3001 {quotes.secondCmo.length ? 'also ' : ''}plans for this with a physician crewmember:{' '}
                <ReqId id={quotes.usability.requirementId} /> asks for medical equipment usable by non-physician crewmembers “{quotes.usability.verbatim}”.
              </>
            ) : null}
          </p>
        ) : null}
        {autonomy ? <p className="dl-col-note">{autonomy}</p> : null}
        {ESCALATION_BASIS.source ? (
          <p className="dl-col-note dl-fine">
            <Citation source={ESCALATION_BASIS.source} />
          </p>
        ) : null}
      </div>
    </section>
  )
}

// ---- copy -----------------------------------------------------------------------------------------

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path (permission denied, non-secure context)
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

function CopyButton({
  text,
  entries,
  bytes,
  onCopied,
  label = 'Copy packet',
}: {
  text: string
  entries: number
  bytes: number
  onCopied: (s: string) => void
  label?: string
}) {
  const [done, setDone] = useState<'ok' | 'fail' | null>(null)
  useEffect(() => setDone(null), [text])
  return (
    <span className="dl-copy">
      <Button
        onClick={async () => {
          const ok = await copyText(text)
          setDone(ok ? 'ok' : 'fail')
          onCopied(
            ok
              ? `Copied the packet to the clipboard: ${entries} ${plural(entries, 'observation', 'observations')}, ${bytes} bytes of pretty-printed JSON. Nothing was sent.`
              : 'Copy failed. Open the packet JSON below and copy it by hand.',
          )
        }}
      >
        <CopyIcon size={15} />
        {label}
      </Button>
      {done ? (
        <span className="dl-copy-note" data-state={done}>
          {done === 'ok' ? 'Copied to the clipboard. Nothing was sent.' : 'Copy failed: open the JSON below.'}
        </span>
      ) : null}
    </span>
  )
}

// ---- Held on board ------------------------------------------------------------------------------------

// Display text only: the packet itself keeps the data unit (UCUM in FHIR). µ, not the ASCII "u" of the data files.
const UNIT_TEXT: Record<string, string> = { score_1_5: 'of 5', 'uGy/day': 'µGy/day', 'uGy/min': 'µGy/min', uGy: 'µGy', uSv: 'µSv' }

/** A record's latest value: a yes/no answer as "yes" / "no", a MET stamp as a MET time, else a number and unit. */
function LatestValue({ o }: { o: Observation }) {
  if (o.unit === 'yes/no') return <strong>{o.value === 1 ? 'yes' : o.value === 0 ? 'no' : '?'}</strong>
  if (o.unit === 'MET') return <MetTime t={o.value} label />
  return <Num value={o.value} unit={UNIT_TEXT[o.unit] ?? o.unit} />
}

function sourceText(r: KnownRow): string {
  return r.sources.join(', ')
}

function ProvTags({ r, replayTitle }: { r: KnownRow; replayTitle: string | null }) {
  const tags: ReactNode[] = []
  const isReplay = r.sources.includes('replay') || r.provenances.includes('replay')
  if (isReplay) {
    tags.push(
      <span key="replay" className="dl-prov" data-prov="replay" title={replayTitle ?? 'Replay of a real historical event'}>
        REPLAY · REAL EVENT
      </span>,
    )
  }
  if (r.provenances.includes('simulated') && !isReplay) {
    tags.push(
      <span key="sim" className="dl-prov" data-prov="simulated" title="Simulated crew data (seeded, labelled)">
        SIMULATED
      </span>,
    )
  }
  if (r.provenances.some((p) => p !== 'simulated' && p !== 'replay')) {
    tags.push(
      <span key="entered" className="dl-prov" data-prov="measured" title="Entered on this device in this session (Noon Sight or a case step)">
        ENTERED HERE
      </span>,
    )
  }
  return <>{tags}</>
}

function KnownItem({
  r,
  shared,
  requested,
  onToggle,
  replayTitle,
}: {
  r: KnownRow
  shared: boolean
  requested: boolean
  onToggle: (r: KnownRow, shared: boolean) => void
  replayTitle: string | null
}) {
  const id = useId()
  return (
    <li className="dl-row" data-shared={shared || undefined} data-requested={requested || undefined}>
      <div className="dl-row-main">
        <span className="dl-row-label" id={`${id}-l`}>
          {r.label}
        </span>{' '}
        <code className="dl-row-var">{r.variable}</code>
        {requested ? (
          <span className="dl-asked">
            <PacketIcon size={12} /> asked for by this case
          </span>
        ) : null}
      </div>
      <div className="dl-row-data" id={`${id}-d`}>
        <Num value={r.count} /> {r.count === 1 ? 'record' : 'records'} · latest <LatestValue o={r.last} /> at <MetTime t={r.last.t} /> · {sourceText(r)}{' '}
        <ProvTags r={r} replayTitle={replayTitle} />
      </div>
      <label className="dl-switch">
        <input
          type="checkbox"
          role="switch"
          checked={shared}
          onChange={(e) => onToggle(r, e.target.checked)}
          aria-label={`Share ${r.label} with Houston`}
          aria-describedby={`${id}-d`}
        />
        <span className="dl-switch-track" aria-hidden="true">
          <span className="dl-switch-thumb" />
        </span>
        <span className="dl-switch-text" aria-hidden="true">
          {shared ? <UnlockIcon size={13} /> : <LockIcon size={13} />}
          {shared ? 'Shared' : 'On board only'}
        </span>
      </label>
    </li>
  )
}

function KnowsColumn({
  crewId,
  rows,
  scope,
  consent,
  onToggle,
  onMood,
  replayTitle,
  logbook,
  noonSights,
}: {
  crewId: CrewId
  rows: KnownRow[]
  scope: readonly string[]
  consent: Record<string, boolean>
  onToggle: (r: KnownRow, shared: boolean) => void
  onMood: (shared: boolean) => void
  replayTitle: string | null
  logbook: number
  noonSights: number
}) {
  const own = rows.filter((r) => r.scope === 'crew' && !r.private)
  const privateRows = rows.filter((r) => r.scope === 'crew' && r.private)
  const vehicle = rows.filter((r) => r.scope === 'vehicle')
  const item = (r: KnownRow) => (
    <KnownItem key={`${r.scope}|${r.variable}`} r={r} shared={consentAllows(r.variable, consent)} requested={scope.includes(r.variable)} onToggle={onToggle} replayTitle={replayTitle} />
  )
  return (
    <section className="dl-col dl-knows" aria-labelledby="dl-knows-h">
      <p className="lf-eyebrow">
        <OnboardIcon size={12} /> On board, this device
      </p>
      <h3 id="dl-knows-h">Held on board</h3>
      <p className="dl-col-note">
        Everything held for {crewId} on this device. Each switch decides whether that variable may leave the vehicle in a ground packet.
      </p>
      <h4 className="dl-sub">{crewId}’s own records</h4>
      <ul className="dl-list">{own.map(item)}</ul>
      {privateRows.map((r) => (
        <MoodBlock key={`${crewId}-${r.variable}`} r={r} crewId={crewId} shared={consentAllows(r.variable, consent)} onMood={onMood} />
      ))}
      {vehicle.length ? (
        <>
          <h4 className="dl-sub">Habitat sensors (the same readings for every crewmember)</h4>
          <ul className="dl-list">{vehicle.map(item)}</ul>
        </>
      ) : null}
      <p className="dl-col-note dl-never">
        <LockIcon size={13} /> Also on board and never in a packet: <Num value={logbook} /> logbook {logbook === 1 ? 'entry' : 'entries'},{' '}
        <Num value={noonSights} /> Noon Sight {noonSights === 1 ? 'check' : 'checks'} from this session (raw reaction times), and the case notes.
        A packet carries the case status only.
      </p>
    </section>
  )
}

function MoodBlock({ r, crewId, shared, onMood }: { r: KnownRow; crewId: CrewId; shared: boolean; onMood: (shared: boolean) => void }) {
  const [confirming, setConfirming] = useState(false)
  const headRef = useRef<HTMLHeadingElement | null>(null)
  const openRef = useRef<HTMLButtonElement | null>(null)
  const askers = casesRequesting(r.variable, CASE_DEFS)
  useEffect(() => {
    if (confirming) headRef.current?.focus()
  }, [confirming])
  const cancel = () => {
    setConfirming(false)
    requestAnimationFrame(() => openRef.current?.focus())
  }
  return (
    <div className="dl-mood" data-shared={shared || undefined}>
      <h4 className="dl-sub">Private by default</h4>
      <div className="dl-mood-head">
        {shared ? <UnlockIcon size={15} /> : <LockIcon size={15} />}
        <strong>{r.label}</strong> <code className="dl-row-var">{r.variable}</code>
        <span className="dl-mood-tag">{shared ? `SHARED BY ${crewId}` : 'PRIVATE'}</span>
      </div>
      <p className="dl-row-data">
        <Num value={r.count} /> records · latest <Num value={r.last.value} unit={UNIT_TEXT[r.last.unit] ?? r.last.unit} /> at <MetTime t={r.last.t} />{' '}
        <ProvTags r={r} replayTitle={null} /> · Mood never raises an alert and never changes a colour.
      </p>
      {shared ? (
        <div className="dl-mood-actions">
          <p className="dl-col-note">
            {crewId} chose to share mood. Packets not yet transmitted follow the current choice; one already sent cannot be recalled.
          </p>
          <Button variant="secondary" onClick={() => onMood(false)}>
            <LockIcon size={14} />
            Make mood private again
          </Button>
        </div>
      ) : confirming ? (
        <div className="dl-confirm" role="group" aria-labelledby="dl-confirm-h">
          <h5 id="dl-confirm-h" ref={headRef} tabIndex={-1}>
            Share {crewId}’s mood ratings with Houston?
          </h5>
          <ul>
            <li>Flight surgeons, and anyone on the ground with access to this mission’s medical data, could read the daily ratings.</li>
            <li>Once a packet has been transmitted it cannot be recalled. You can make mood private again, but only for packets not yet sent.</li>
            <li>Sharing never makes LANDFALL alert on mood, and it changes nothing about care on board.</li>
            <li>
              {askers.length === 0
                ? 'No LANDFALL case packet asks for mood today, so sharing adds nothing to the queue now.'
                : `It would be added to: ${askers.map((d) => d.title ?? d.id).join(', ')}.`}
            </li>
          </ul>
          <div className="dl-confirm-actions">
            <Button
              onClick={() => {
                setConfirming(false)
                onMood(true)
              }}
            >
              <UnlockIcon size={14} />
              Yes, share my mood
            </Button>
            <Button variant="secondary" onClick={cancel}>
              <LockIcon size={14} />
              Keep mood private
            </Button>
          </div>
        </div>
      ) : (
        <div className="dl-mood-actions">
          <p className="dl-col-note">There is no switch for mood: sharing it is a separate, deliberate step.</p>
          <button type="button" className="lf-btn" data-variant="secondary" ref={openRef} onClick={() => setConfirming(true)}>
            <UnlockIcon size={14} />
            Share mood…
          </button>
        </div>
      )}
    </div>
  )
}

// ---- In the ground packet -------------------------------------------------------------------------------

const HSTATE: Record<HoustonRow['state'], { text: string }> = {
  in_packet: { text: 'In packet' },
  withheld: { text: 'Withheld' },
  no_record: { text: 'No record yet' },
}

function SeesColumn({
  crewId,
  caseTitle,
  rows,
  known,
  scope,
  summary,
  queue,
  note,
}: {
  crewId: CrewId
  caseTitle: string
  rows: HoustonRow[]
  known: KnownRow[]
  scope: readonly string[]
  summary: PacketSummary | null
  queue: QueueState
  /** The case's note for the flight surgeon (D12), shown only here, with the ground packet. */
  note: SurgeonNote | null
}) {
  const notAsked = known.filter((k) => !scope.includes(k.variable))
  const noRecord = rows.some((r) => r.state === 'no_record')
  const when: Record<QueueState, string> = {
    queued: 'queued, sent when a link exists',
    prepared: 'once the packet is released or the case escalates',
    not_open: 'if the case opens',
    no_packet: 'never, for this case',
    unavailable: 'unknown',
  }
  if (queue === 'unavailable') {
    return (
      <section className="dl-col dl-sees" aria-labelledby="dl-sees-h">
        <div className="dl-sees-inner">
          <p className="lf-eyebrow">
            <AntennaIcon size={12} /> To the ground
          </p>
          <h3 id="dl-sees-h">In the ground packet</h3>
          <p className="dl-col-note dl-missing">
            <UnknownIcon size={13} /> Unknown right now: the packet is built by the engine from a case state, and the cases could not be
            evaluated. Nothing is sent in the meantime.
          </p>
        </div>
      </section>
    )
  }
  return (
    <section className="dl-col dl-sees" aria-labelledby="dl-sees-h">
      <div className="dl-sees-inner">
      <p className="lf-eyebrow">
        <AntennaIcon size={12} /> To the ground, {when[queue]}
      </p>
      <h3 id="dl-sees-h">In the ground packet</h3>
      <p className="dl-col-note">
        Only the packet for <strong>{caseTitle}</strong>: the variables this case asks for, minus what {crewId} keeps on board.
      </p>
      <ul className="dl-list">
        {rows.map((r) => (
          <li key={r.variable} className="dl-hrow" data-state={r.state}>
            <span className="dl-hstate">
              {r.state === 'in_packet' ? <InPacketIcon size={13} /> : r.state === 'withheld' ? <LockIcon size={13} /> : <UnknownIcon size={13} />}
              {HSTATE[r.state].text}
            </span>
            <span className="dl-hlabel">
              {r.label} <code className="dl-row-var">{r.variable}</code>
            </span>
            <span className="dl-hcount">
              {r.state === 'in_packet' ? (
                <>
                  <Num value={r.count} /> {r.count === 1 ? 'entry' : 'entries'}
                </>
              ) : r.state === 'withheld' ? (
                <>
                  <Num value={r.count} /> on board only
                </>
              ) : (
                <>nothing to send</>
              )}
            </span>
          </li>
        ))}
      </ul>
      {noRecord ? (
        <p className="dl-col-note dl-missing">
          <UnknownIcon size={13} /> “No record yet” is shown on purpose (<ReqId id="V2 10020" />): the case asks for it, nobody has logged it,
          and LANDFALL does not fill the gap.
        </p>
      ) : null}
      {summary ? (
        <p className="dl-sees-total">
          <InPacketIcon size={14} /> Houston would receive <Num value={summary.entries} /> {plural(summary.entries, 'observation', 'observations')} about{' '}
          {crewId}
          {summary.vehicle ? (
            <>
              {' '}
              (<Num value={summary.vehicle} /> of them habitat-sensor readings, tagged as such)
            </>
          ) : null}
          , and nothing else.
        </p>
      ) : null}
      {note ? (
        <div className="dl-fsnote" role="note" aria-labelledby="dl-fsnote-h">
          <h4 className="dl-sub" id="dl-fsnote-h">
            Note for the flight surgeon
          </h4>
          <p className="dl-fsnote-text">{note.text}</p>
          <p className="dl-col-note dl-fine">
            {note.chip ? <Chip kind={note.chip} /> : null} {note.source ? <Citation source={note.source} /> : null}
          </p>
          <p className="dl-col-note dl-fine">
            Shown only here, with the ground packet, for the flight surgeon. No crew-facing view names a medication, and the note is not a FHIR
            resource in this build.
          </p>
        </div>
      ) : null}
      {notAsked.length ? (
        <div className="dl-notasked">
          <h4 className="dl-sub">
            <OnboardIcon size={13} /> Not asked for by this case: stays on board
          </h4>
          <p className="dl-col-note">{notAsked.map((k) => k.label).join(' · ')}</p>
        </div>
      ) : null}
      </div>
    </section>
  )
}

// ---- [V2 10125] -------------------------------------------------------------------------------------

function Requirement10125({ req, vol2 }: { req: Vol2Requirement | null; vol2: SnapshotState<Vol2Data> }) {
  return (
    <div className="dl-10125">
      {req ? (
        <figure className="dl-quote dl-quote-sm">
          <blockquote>
            <p>“{req.text}”</p>
          </blockquote>
          <figcaption>
            <ReqId id={req.id} /> {req.title}, NASA-STD-3001 Vol. 2 Rev. {vol2.data?.document?.revision ?? '?'} §{req.section} (verbatim).
          </figcaption>
        </figure>
      ) : (
        <p className="dl-missing">
          <UnknownIcon size={13} /> The text of <ReqId id="V2 10125" /> is not available in this build.
        </p>
      )}
      <p className="dl-honest">
        What LANDFALL covers: crew-controlled sharing, per variable, enforced by the engine that builds the packet. What it does not: encryption,
        secure viewing and sender verification. Those belong to the vehicle’s communication system and are not implemented in this demo.
      </p>
      <FreshnessChip meta={vol2.snapshot} status={vol2.status} id="std_vol2_requirements" source={vol2.snapshot?.source} />
    </div>
  )
}

// ---- the packet ---------------------------------------------------------------------------------------

function metOf(iso: string, epoch: string | null): number | null {
  if (!epoch) return null
  const a = Date.parse(iso)
  const b = Date.parse(epoch)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 1000) : null
}

function MetOrUtc({ iso, epoch }: { iso: string; epoch: string | null }) {
  const t = metOf(iso, epoch)
  return t === null ? <time className="lf-num">{formatUtc(iso)}</time> : <MetTime t={t} />
}

function PacketPanel({
  bundle,
  summary,
  epoch,
  simSnap,
  resetKey,
  onCopied,
}: {
  bundle: FhirBundle
  summary: PacketSummary
  epoch: string | null
  simSnap: SnapshotState
  resetKey: string
  onCopied: (s: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  useEffect(() => setAll(false), [resetKey])
  const shown = useMemo(() => (open ? (all ? summary.pretty : prettyPacket(previewBundle(bundle, PREVIEW_ENTRIES))) : ''), [open, all, summary.pretty, bundle])
  const tags = bundle.meta.tag.map((t) => t.code)
  return (
    <section className="lf-panel dl-packet" aria-labelledby="dl-packet-h">
      <header className="lf-panel-head">
        <div>
          <p className="lf-eyebrow">What would be transmitted</p>
          <h2 id="dl-packet-h" className="lf-panel-title">
            The packet: a FHIR R4 Bundle
          </h2>
        </div>
        <div className="lf-panel-actions">
          <SimulatedMarker />
        </div>
      </header>
      <div className="lf-panel-body">
        <p className="dl-col-note">
          Built in this browser by the LANDFALL engine (<code>buildGroundPacket</code>), the same code the Python reference is proven against.
          Vital signs carry the LOINC codes of the FHIR R4 vital-signs profile; everything else uses the local LANDFALL CodeSystem. No LOINC code
          is invented.
        </p>
        <dl className="dl-facts">
          <div>
            <dt>Observations</dt>
            <dd>
              <Num value={summary.entries} />
            </dd>
          </div>
          <div>
            <dt>LOINC vital signs</dt>
            <dd>
              <Num value={summary.loinc} />
            </dd>
          </div>
          <div>
            <dt>Local CodeSystem</dt>
            <dd>
              <Num value={summary.local} />
            </dd>
          </div>
          <div>
            <dt>Habitat-sensor entries</dt>
            <dd>
              <Num value={summary.vehicle} />
            </dd>
          </div>
          <div>
            <dt>Size, compact</dt>
            <dd>
              <Num value={summary.compactBytes} unit="bytes" />
            </dd>
          </div>
          <div>
            <dt>Size, pretty-printed</dt>
            <dd>
              <Num value={summary.prettyBytes} unit="bytes" />
            </dd>
          </div>
        </dl>
        <p className="dl-meta-line">
          <code>{bundle.id}</code> · type <code>{bundle.type}</code> · timestamp <time className="lf-num">{bundle.timestamp}</time> · tags{' '}
          {tags.map((c) => (
            <code key={c} className="dl-tagcode">
              {c}
            </code>
          ))}
        </p>
        {summary.provenance.length ? (
          <p className="dl-meta-line">
            Provenance tags:{' '}
            {summary.provenance.map(([p, n]) => (
              <span key={p} className="dl-provcount">
                <code>provenance-{p}</code> <Num value={n} />
              </span>
            ))}{' '}
            {simSnap.snapshot ? <FreshnessChip meta={simSnap.snapshot} status={simSnap.status} id="sim_crew" compact /> : null}
          </p>
        ) : null}

        {summary.byVariable.length ? (
          <div className="dl-table-wrap" role="region" aria-label="Packet entries by variable" tabIndex={0}>
            <table className="dl-table">
              <thead>
                <tr>
                  <th scope="col">Variable</th>
                  <th scope="col">FHIR code</th>
                  <th scope="col">Unit (UCUM)</th>
                  <th scope="col" className="num">
                    Entries
                  </th>
                  <th scope="col">First to last (MET)</th>
                </tr>
              </thead>
              <tbody>
                {summary.byVariable.map((r) => (
                  <tr key={r.variable}>
                    <th scope="row">
                      {r.display} <code className="dl-row-var">{r.variable}</code>
                    </th>
                    <td>
                      <span className="dl-sys" data-sys={r.system}>
                        {r.system === 'LOINC' ? 'LOINC' : r.system === 'local' ? 'local' : r.systemUrl}
                      </span>{' '}
                      <code>{r.code}</code>
                      {r.vitalSign ? <span className="dl-vs">vital-signs profile</span> : null}
                    </td>
                    <td>
                      <code>{r.valueKind}</code>
                    </td>
                    <td className="num">
                      <Num value={r.count} />
                    </td>
                    <td>
                      <MetOrUtc iso={r.firstIso} epoch={epoch} /> → <MetOrUtc iso={r.lastIso} epoch={epoch} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dl-col-note dl-missing">
            <UnknownIcon size={13} /> This packet is empty: nothing the case asks for is both recorded and shared.
          </p>
        )}

        <details className="dl-json" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            <ChevronIcon size={14} />
            <span>
              Packet JSON (<Num value={summary.entries} /> {plural(summary.entries, 'entry', 'entries')})
            </span>
          </summary>
          {open ? (
            <div className="dl-json-body">
              <div className="dl-json-bar">
                <p className="dl-col-note">
                  {all || summary.entries <= PREVIEW_ENTRIES ? (
                    <>
                      {summary.entries === 1 ? 'The only entry' : <>All <Num value={summary.entries} /> entries</>}, in full.
                    </>
                  ) : (
                    <>
                      Preview: the first <Num value={PREVIEW_ENTRIES} /> of <Num value={summary.entries} /> entries (still a valid Bundle). Copy gets all of
                      them.
                    </>
                  )}
                </p>
                {summary.entries > PREVIEW_ENTRIES ? (
                  <Button variant="secondary" onClick={() => setAll((a) => !a)} aria-pressed={all}>
                    {all ? (
                      'Show the preview only'
                    ) : (
                      <>
                        Show all <Num value={summary.entries} /> entries
                      </>
                    )}
                  </Button>
                ) : null}
                <CopyButton text={summary.pretty} entries={summary.entries} bytes={summary.prettyBytes} onCopied={onCopied} label="Copy packet JSON" />
              </div>
              <pre className="dl-pre" tabIndex={0} aria-label="Packet JSON">
                {shown}
              </pre>
            </div>
          ) : null}
        </details>
      </div>
    </section>
  )
}
