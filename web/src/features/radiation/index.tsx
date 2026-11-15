// #/radiation, environment-aware. Real NASA / NOAA measurements of the radiation environment where the
// crew is (ISS TEPC + predicted SAA passes, LRO CRaTER in lunar orbit, MSL RAD on Mars), the NOAA
// S-scale (the frozen live GOES feed, stale, and the REAL October 1989 event replayed into the
// scenario), and cumulative dose against the NASA limits only where the quantity matches the limit's
// unit. No Gy -> Sv step is taken anywhere: absorbed dose is never compared with an effective-dose limit.
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { FeatureProps } from '../../app/router'
import { RULES, getRule, sLevel, thresholdRules } from '../../app/engine'
import type { Finding, Rule } from '../../app/engine'
import { useSnapshot } from '../../app/data'
import type { LoadStatus, Snapshot } from '../../app/data'
import { TO_DATE_VARIABLES, evaluateOps, evaluateRuleAt } from '../../app/evaluate'
import type { OpsFeed } from '../../app/evaluate'
import { useMetMinute, useMission } from '../../app/mission'
import { useScenario } from '../../app/model'
import { observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex } from '../../app/scenarioData'
import { ENVIRONMENTS, environment } from '../../app/scenario'
import { CHIP_DEFS, CREW } from '../../app/vocab'
import type { CrewId, EnvId, Observation } from '../../app/vocab'
import {
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
  StaleIcon,
  UnknownIcon,
  formatNumber,
} from '../../ui'
import { TimeChart, envelope } from '../trends/chart'
import type { HLineSpec, LineSpec, MarkSpec, VLineSpec } from '../trends/chart'
import {
  DOSE_INSTRUMENT,
  dailySeries,
  dateRuns,
  detectorDays,
  donkiCrossCheck,
  findRequirement,
  firstReach,
  hhmmUtc,
  lcFirst,
  monthYear,
  nextPasses,
  organVerdict,
  recordCoverage,
  regularSeries,
  replayMapping,
  speRank,
  tepcNative,
  transitions,
  unitText,
  utcLabel,
  utcToMet,
  windowSeconds,
} from './model'
import type { DonkiData, HapiDoseData, IssTrackData, ProtonsLiveData, ReplayData, RequirementRec, SScaleData, SpeListData, TepcData } from './model'
import MarsSepRecord, { MarsSepContext } from './MarsSepRecord'
import StormWitnesses from './StormWitnesses'
import '../trends/trends.css'
import './radiation.css'

const DAY_MS = 86_400_000
/** Chip labels by SPEC source kind, read from meta.json (a rename there reaches this page). */
const chipFor = (kind: string, fallback: string) => CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? fallback
const DESIGN_CHIP = chipFor('design_choice', 'design choice')
const NOAA_CHIP = chipFor('noaa', 'NOAA-published')
const fmt = (v: number, d?: number) => formatNumber(v, d)
/** MET day on a chart axis: Appendix F F.6.1 f, leading zeros suppressed in the day field. */
const dayLabel = (v: number) => String(Math.floor(v))
const logLabel = (v: number) => (Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9 ? fmt(v) : '')
/** NASA's description of the CRaTER instrument (NSSDCA experiment page, checked 2026-11-14). */
const CRATER_NSSDCA_URL = 'https://nssdc.gsfc.nasa.gov/nmc/experiment/display.action?id=2009-031A-06'

function Kind({ kind, children }: { kind: 'live' | 'historical' | 'replay' | 'prediction' | 'stale' | 'simulated'; children: ReactNode }) {
  return (
    <span className="lf-tr-kind" data-kind={kind}>
      {children}
    </span>
  )
}

/** Cyan data-quality tag ([V2 10020]: missing or incomplete data is cyan, Table F.5-1). */
function PartialTag() {
  return (
    <span className="lf-dq" data-tone="stale">
      <UnknownIcon size={13} /> PARTIAL RECORD
    </span>
  )
}

function Quote({ req, doc }: { req: RequirementRec | null; doc: string }) {
  if (!req) return null
  const id = req.id.replace(/^\[|\]$/g, '')
  return (
    <blockquote className="lf-rad-quote">
      <p>“{req.text}”</p>
      <footer>
        <ReqId id={id} /> {req.title ? <span>{req.title}</span> : null} · {doc}
      </footer>
    </blockquote>
  )
}

function useMeta<T>(id: string | null) {
  // null skips the fetch (useSnapshot contract): never request a snapshot that does not exist
  const s = useSnapshot<T>(id)
  return { ...s, snap: s.snapshot as Snapshot<T> | null }
}

// ---- environment picker ---------------------------------------------------------------------------------

function EnvPicker({ envId, onPick }: { envId: EnvId; onPick: (e: EnvId) => void }) {
  return (
    <div className="lf-tr-crew" role="group" aria-label="Environment">
      {ENVIRONMENTS.map((e) => (
        <button key={e.id} type="button" className="lf-tr-crew-btn" aria-pressed={e.id === envId} onClick={() => onPick(e.id as EnvId)}>
          <span className="lf-tr-crew-role">{e.label}</span>
          <span className="lf-tr-crew-none">
            {e.dose_snapshot ? `measured dose: ${DOSE_INSTRUMENT[e.dose_snapshot] ?? 'NASA dosimeter'}` : 'no dosimetry shipped'}
          </span>
        </button>
      ))}
    </div>
  )
}

// ---- proton flux: scenario feed + the real October 1989 replay ----------------------------------------------

function ProtonPanel({
  ops,
  opsError,
  replay,
  replayStatus,
  replaySnap,
  sim,
  scale,
  speList,
  vol2,
  t,
  envId,
}: {
  ops: OpsFeed | null
  opsError: string | null
  replay: ReplayData | null
  replayStatus: LoadStatus
  replaySnap: Snapshot<ReplayData> | null
  sim: unknown
  scale: SScaleData | null
  speList: SpeListData | null
  vol2: { reqs: RequirementRec[]; doc: string }
  t: number
  envId: EnvId
}) {
  const [cols, setCols] = useState(700)
  const mapping = useMemo(() => replayMapping(sim), [sim])
  const series = useMemo(() => {
    if (!replay || !mapping) return null
    const r = regularSeries(replay.series_ge10mev)
    return { t: r.t.map((ms) => utcToMet(ms, mapping) / 86_400), v: r.v }
  }, [replay, mapping])
  // The same GOES-7 file's >=100 MeV channel, on the same columns (envelope x depends only on the span).
  const series100 = useMemo(() => {
    if (!replay?.series_ge100mev || !mapping) return null
    const r = regularSeries(replay.series_ge100mev)
    return { t: r.t.map((ms) => utcToMet(ms, mapping) / 86_400), v: r.v }
  }, [replay, mapping])
  const nowDay = t / 86_400
  const env = useMemo(() => {
    if (!series || !series.t.length) return null
    return envelope(series.t, series.v, series.t[0], series.t[series.t.length - 1], cols)
  }, [series, cols])
  const env100 = useMemo(() => {
    if (!series100 || !series || !series.t.length) return null
    return envelope(series100.t, series100.v, series.t[0], series.t[series.t.length - 1], cols)
  }, [series100, series, cols])
  const lines = useMemo<LineSpec[]>(() => {
    if (!env) return []
    const seen = (arr: Array<number | null>) => arr.map((v, i) => (env.x[i] <= nowDay ? v : null))
    const ahead = (arr: Array<number | null>) => arr.map((v, i) => (env.x[i] > nowDay ? v : null))
    const out: LineSpec[] = [
      { label: 'seen max', values: seen(env.max), color: '--lf-text', width: 1.25 },
      { label: 'seen min', values: seen(env.min), color: '--lf-text', width: 1.25 },
      { label: 'ahead max', values: ahead(env.max), color: '--lf-text-muted', width: 1, dash: [3, 3] },
      { label: 'ahead min', values: ahead(env.min), color: '--lf-text-muted', width: 1, dash: [3, 3] },
    ]
    if (env100) {
      out.push(
        { label: '≥100 MeV seen', values: seen(env100.max), color: '--lf-text-2', width: 1, dash: [1, 2] },
        { label: '≥100 MeV ahead', values: ahead(env100.max), color: '--lf-text-muted', width: 1, dash: [1, 3] },
      )
    }
    return out
  }, [env, env100, nowDay])
  const bands = useMemo(
    () => [
      { upper: 0, lower: 1, fill: 'rgba(255,255,255,0.40)' },
      { upper: 2, lower: 3, fill: 'rgba(185,185,187,0.14)' },
    ],
    [],
  )
  const caseRule = ops?.findings.find((f) => f.finding.status !== 'not_applicable' && typeof f.rule.s_level === 'number' && f.rule.case_id) ?? null
  const caseLevel = caseRule
    ? Math.min(
        ...(ops?.findings ?? [])
          .filter((f) => f.finding.status !== 'not_applicable' && f.rule.case_id)
          .map((f) => (typeof f.rule.s_level === 'number' ? f.rule.s_level : sLevel(f.rule.limit))),
      )
    : null
  const hlines = useMemo<HLineSpec[]>(
    () =>
      (scale?.levels ?? []).map((l) => ({
        y: l.threshold_pfu,
        label: `${l.level} ${l.descriptor} ≥ ${fmt(l.threshold_pfu)} pfu${caseLevel === l.n ? ' · opens the shelter case' : ''}`,
        short: `${l.level}${caseLevel === l.n ? ' · shelter case' : ''}`,
        color: caseLevel === l.n ? '--lf-text' : '--lf-text-muted',
        dash: caseLevel === l.n ? undefined : [2, 3],
        width: caseLevel === l.n ? 1.5 : 1,
      })),
    [scale, caseLevel],
  )
  const vlines = useMemo<VLineSpec[]>(() => [{ x: nowDay, label: 'NOW (scenario)', color: '--lf-text', labelAt: 'bottom' }], [nowDay])
  const trs = useMemo(() => (replay ? transitions(replay, mapping) : []), [replay, mapping])
  const reach = useMemo(() => firstReach(trs), [trs])
  const marks = useMemo<MarkSpec[]>(() => {
    const out: MarkSpec[] = reach
      .filter((r) => r.met !== null)
      .map((r) => ({ x: (r.met as number) / 86_400, y: scale?.levels.find((l) => l.n === r.level)?.threshold_pfu ?? 1, shape: 'diamond' as const, hollow: true, color: '--lf-text', size: 4.5, label: `S${r.level}` }))
    // Label the >=100 MeV channel on the canvas at its peak, so the dotted trace is named where it is drawn.
    const p = replay?.max_ge100mev
    const pMs = p ? Date.parse(p.time_tag) : Number.NaN
    if (p && mapping && env100 && Number.isFinite(pMs)) {
      out.push({ x: utcToMet(pMs, mapping) / 86_400, y: p.flux_pfu, shape: 'circle', hollow: true, color: '--lf-text-2', size: 3.5, label: '≥100 MeV peak' })
    }
    return out
  }, [reach, scale, replay, mapping, env100])
  const level = ops?.s_level ?? null
  const levelDef = scale?.levels.find((l) => l.n === level) ?? null
  // Where noaa_scale_available is false (Mars) the feed is the scenario's own space-weather monitor.
  const onboard = ops?.kind === 'onboard_monitor'
  const r6165 = findRequirement(vol2.reqs, 'V2 6165')
  const r6164 = findRequirement(vol2.reqs, 'V2 6164')
  const listed = replay?.noaa_spe_list_entry?.start && speList ? speRank(speList, replay.noaa_spe_list_entry.start) : null
  const peak100 = replay?.max_ge100mev?.flux_pfu ?? null
  const noaa100 = replay?.noaa_note_oct1989_ge100mev_pfu ?? null
  return (
    <Panel
      title="Proton flux and the NOAA S-scale"
      eyebrow={<Kind kind="replay">REPLAY OF A REAL EVENT · GOES-7, OCTOBER 1989</Kind>}
      footer={
        <>
          <FreshnessChip meta={replaySnap} status={replayStatus} id="swpc_spe_replay" source={replaySnap?.source} />
          <span>{replaySnap?.source.name}</span>
        </>
      }
    >
      <SimulatedMarker variant="banner">
        The scenario clock is simulated; the flux is the real 1989 record, only time-shifted
        {onboard ? ', and here it stands in for a space-weather monitor in Mars orbit (a scenario assumption)' : ''}.
      </SimulatedMarker>
      <div className="lf-rad-now">
        {ops ? (
          <>
            <p className="lf-rad-big">
              <span className="lf-rad-label">{onboard ? 'Space-weather monitor in Mars orbit · ≥10 MeV' : 'NOAA GOES ≥10 MeV'}</span>
              <Num value={ops.flux} unit="pfu" digits={0} />
              <span>
                S-level <Num value={ops.s_level} />
              </span>
              {ops.active ? <FindingBadge finding={ops.active.finding} /> : <SeverityBadge severity="nominal" label="Below S1" />}
            </p>
            <p className="lf-tr-muted">
              {ops.t !== null ? (
                <>
                  Sample at <MetTime t={ops.t} label />.{' '}
                </>
              ) : null}
              {ops.active ? (
                <>
                  Rule: {ops.active.rule.label} <CategoryBadge category="OPS" /> <Chip kind={ops.active.rule.chip} />
                </>
              ) : null}
            </p>
            {levelDef?.effects?.Biological ? (
              <p>
                NOAA, {levelDef.level} ({levelDef.descriptor}), biological: “{levelDef.effects.Biological}”
              </p>
            ) : null}
          </>
        ) : (
          <p className="lf-tr-nodata">
            <StaleIcon size={14} /> Scenario flux unavailable{opsError ? `: ${opsError}` : ''}.
          </p>
        )}
      </div>
      {series && env ? (
        <TimeChart
          x={env.x}
          lines={lines}
          bands={bands}
          hlines={hlines}
          vlines={vlines}
          marks={marks}
          yLog
          yMin={0.001}
          yMax={100000}
          xFormat={dayLabel}
          yFormat={logLabel}
          height={260}
          onPlotWidth={(w) => setCols((c) => (Math.abs(c - Math.round(w)) >= 2 ? Math.max(60, Math.round(w)) : c))}
          ariaLabel={`October 1989 GOES-7 proton flux replayed on the scenario clock, log scale: the ≥10 MeV channel with NOAA S1 to S5 thresholds (${reach.length} S-levels reached) and, dotted, the ≥100 MeV channel of the same file.`}
        />
      ) : (
        <EmptyState kind={replayStatus === 'loading' ? 'loading' : 'missing'} title="Replay not available" headingLevel={3}>
          <p>The October 1989 record (swpc_spe_replay.json) or the scenario mapping is not in this build.</p>
        </EmptyState>
      )}
      <p className="lf-tr-muted">
        Solid: the ≥10 MeV flux the {onboard ? 'monitor' : 'feed'} has reported up to the scenario clock. Dashed: the rest of the real 1989
        event, not yet reached by the clock. Envelope: min and max per pixel column of <Num value={replay?.series_ge10mev.n ?? null} />{' '}
        five-minute samples.{' '}
        {env100 ? (
          <>
            Dotted: the same file’s ≥100 MeV channel (maximum per column), which peaks at <Num value={peak100} unit="pfu" digits={0} /> here
            {noaa100 !== null ? (
              <>
                ; a footnote on NOAA’s list gives <Num value={noaa100} unit="pfu" digits={0} /> for this event, and neither source explains
                the difference
              </>
            ) : null}
            . NOAA defines its S-scale on ≥10 MeV only.{' '}
          </>
        ) : null}
        {mapping ? (
          <>
            Time shift: 1989 UTC {utcLabel(mapping.mapUtcMs)} = <MetTime t={mapping.mapMet} label />.
          </>
        ) : null}
      </p>
      {listed ? (
        <p className="lf-tr-muted">
          In NOAA’s list of <Num value={listed.of} /> solar proton events affecting the Earth environment (
          {monthYear(speList?.list_first_start)} to {monthYear(speList?.list_last_start)}), this event’s peak of{' '}
          <Num value={listed.event.peak_pfu} unit="pfu" digits={0} /> ranks{' '}
          <strong>
            <Num value={listed.rank} />
            {listed.rank === 1 ? 'st' : listed.rank === 2 ? 'nd' : listed.rank === 3 ? 'rd' : 'th'}
          </strong>
          {listed.above.length ? (
            <>
              , after{' '}
              {listed.above.map((e, i) => (
                <span key={e.start}>
                  {i ? ', ' : ''}
                  {monthYear(e.start)} (<Num value={e.peak_pfu} unit="pfu" digits={0} />)
                </span>
              ))}
            </>
          ) : null}
          . Ranked on this page from the frozen list, by NOAA’s printed peak at ≥10 MeV.
        </p>
      ) : null}
      {reach.length ? (
        <ul className="lf-rad-reach">
          {reach.map((r) => (
            <li key={r.level}>
              <span className="lf-rad-s">S{r.level}</span> first reached {utcLabel(Date.parse(r.utc))} (1989){r.met !== null ? <> → <MetTime t={r.met} label /></> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {trs.length ? (
        <Expander summary={`All ${trs.length} S-level transitions (from the snapshot)`}>
          <div className="lf-tr-table-wrap">
            <table className="lf-tr-table">
              <thead>
                <tr>
                  <th scope="col">1989 UTC</th>
                  <th scope="col">Scenario MET</th>
                  <th scope="col">S-level</th>
                </tr>
              </thead>
              <tbody>
                {trs.map((tr) => (
                  <tr key={tr.utc}>
                    <td className="num">{utcLabel(Date.parse(tr.utc))}</td>
                    <td className="num">{tr.met !== null ? <MetTime t={tr.met} /> : '—'}</td>
                    <td className="num">S{tr.level}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Expander>
      ) : null}
      <div className="lf-rad-role">
        <h3 className="lf-tr-card-title">Who watches the Sun here, and who raises the alarm</h3>
        {onboard ? (
          <>
            <p>
              At {environment(envId).label} no NOAA alert reaches the crew in time, and none at all during solar conjunction. In this
              scenario the proton reading comes from an external space-weather monitor above the atmosphere, in Mars orbit, relayed to the
              habitat locally with no Earth link needed: the kind of monitoring <ReqId id="V2 6165" /> requires. The habitat’s radiation
              monitoring system raises the radiation alarm, as <ReqId id="V2 6164" /> requires; LANDFALL is not that alarm. It opens the
              health case that follows and guides the crew through the shelter steps; an escalation goes to the Crew Medical Officer at
              once and is queued for the flight surgeon until the link returns.
            </p>
            <p className="lf-tr-muted">
              Scenario assumption: the monitor’s values are the GOES-7 October 1989 ≥10 MeV record, time-shifted, with no correction for
              distance from the Sun or for the atmosphere. The habitat dose rate further down is a separate, simulated confirmation.
            </p>
          </>
        ) : (
          <p>
            Near Earth, NOAA’s GOES satellites in geostationary orbit are the external space-weather monitor, and NOAA’s S-scale reaches the
            crew through the ground. With the link up, Mission Control and the flight surgeon have the same alert within the round-trip light
            time, and the crew follows their direction. The vehicle’s radiation monitoring system raises the radiation alarm (
            <ReqId id="V2 6164" />
            ); LANDFALL applies NOAA’s published levels to the feed as a decision aid: it opens the health case and prepares the packet.
          </p>
        )}
        <Quote req={r6165} doc={vol2.doc} />
        <Quote req={r6164} doc={vol2.doc} />
      </div>
    </Panel>
  )
}

// ---- measured dose here --------------------------------------------------------------------------------------

function SaaStrip({ track, snap, status }: { track: IssTrackData; snap: Snapshot<IssTrackData> | null; status: LoadStatus }) {
  // Wall clock read once per mount: "next" passes are judged against the real time the page opened.
  const [nowMs] = useState(() => Date.now())
  const plan = useMemo(() => nextPasses(track, snap?.retrieved_at ?? track.saa_rule.window.start, nowMs), [track, snap, nowMs])
  const expired = plan.refKind === 'retrieval'
  const pct = (ms: number) => Math.max(0, Math.min(100, ((ms - plan.refMs) / plan.spanMs) * 100))
  const ticks = Array.from({ length: 9 }, (_, k) => plan.refMs + (k * plan.spanMs) / 8)
  return (
    <div className="lf-rad-saa">
      <h3 className="lf-tr-card-title">
        Next South Atlantic Anomaly passes <Kind kind={expired ? 'stale' : 'prediction'}>{expired ? 'PREDICTION · EXPIRED' : 'PREDICTED'}</Kind>
      </h3>
      <p className="lf-tr-muted">
        {expired ? (
          <>
            <StaleIcon size={13} /> This prediction window ended {utcLabel(plan.windowStopMs)}; shown from the moment it was retrieved (
            {utcLabel(plan.refMs)}), not from now.
          </>
        ) : (
          <>Next 24 h from now ({utcLabel(plan.refMs)}), from the SSCWeb ISS ephemeris propagated forward.</>
        )}
      </p>
      <div className="lf-rad-strip" data-expired={expired || undefined} role="img" aria-label={`${plan.passes.length} predicted SAA passes in the 24 hours shown`}>
        {plan.passes.map((p) => (
          <span key={p.start} className="lf-rad-pass" style={{ left: `${pct(p.startMs)}%`, width: `${Math.max(0.6, pct(p.stopMs) - pct(p.startMs))}%` }} title={`${utcLabel(p.startMs)} for ${Math.round(p.duration_s / 60)} min`} />
        ))}
        {ticks.map((ms, k) => (
          <span key={ms} className="lf-rad-tick" data-pos={k === 0 ? 'first' : k === 8 ? 'last' : k % 2 ? 'odd' : 'even'} style={{ left: `${(k / 8) * 100}%` }}>
            {hhmmUtc(ms)}
          </span>
        ))}
      </div>
      <p className="lf-rad-rule">
        <strong>SAA pass</strong> = {track.saa_rule.definition.replace(/^An SAA pass is /, '')} (threshold <Num value={track.saa_rule.threshold_nT} unit="nT" />
        ). <Chip kind={DESIGN_CHIP} /> {track.saa_rule.basis}. Low field strength is a proxy for the anomaly, not a dose measurement.
      </p>
      <div className="lf-tr-table-wrap">
        <table className="lf-tr-table">
          <thead>
            <tr>
              <th scope="col">Start (UTC)</th>
              <th scope="col" className="num">
                Minutes
              </th>
              <th scope="col" className="num">
                Min B (nT)
              </th>
              <th scope="col">Where (lat, lon at min B)</th>
            </tr>
          </thead>
          <tbody>
            {plan.passes.slice(0, 8).map((p) => (
              <tr key={p.start}>
                <td className="num">{utcLabel(p.startMs)}</td>
                <td className="num">
                  {fmt(Math.round(p.duration_s / 60))}
                  {p.truncated ? ' +' : ''}
                </td>
                <td className="num">{fmt(p.min_B_nT, 0)}</td>
                <td className="num">
                  {p.lat_deg_at_min_B !== undefined ? fmt(p.lat_deg_at_min_B, 1) : '—'}, {p.lon_deg_at_min_B !== undefined ? fmt(p.lon_deg_at_min_B, 1) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="lf-tr-muted">
        <FreshnessChip meta={snap} status={status} id="hapi_iss_track" source={snap?.source} />
      </p>
    </div>
  )
}

/** The publisher's own description of a HAPI parameter (for use mid-sentence), else its id. */
function paramLabel(data: HapiDoseData, p: string): string {
  const d = data.parameters?.[p]?.description
  return d ? lcFirst(d) : p
}

const COMPARE_STYLE: Array<Pick<LineSpec, 'color' | 'width' | 'dash' | 'points'>> = [
  { color: '--lf-text-2', width: 1.5, points: 3 },
  { color: '--lf-text', width: 1.25, dash: [5, 3] },
  { color: '--lf-text-muted', width: 1, dash: [1, 2] },
]
const STYLE_WORD = ['solid', 'dashed', 'dotted']

function DailyDoseChart({ data, ariaWhat, parameters, yLog = false }: { data: HapiDoseData; ariaWhat: string; parameters?: string[]; yLog?: boolean }) {
  const paramKey = (parameters ?? [data.headline_parameter]).join('|')
  const params = useMemo(() => paramKey.split('|').filter((p) => data.series[p]), [paramKey, data])
  const s = useMemo(() => dailySeries(data, params[0] ?? data.headline_parameter), [data, params])
  const t0 = s.t[0] ?? 0
  const x = useMemo(() => s.t.map((ms) => (ms - t0) / DAY_MS), [s, t0])
  const lines = useMemo<LineSpec[]>(
    () =>
      params.map((p, k) => {
        // Align every series on the first one's days (a day absent from a series stays a gap, never zero).
        const own = dailySeries(data, p)
        const byDay = new Map(own.t.map((ms, i) => [ms, own.v[i]]))
        return { label: p, values: s.t.map((ms) => byDay.get(ms) ?? null), ...COMPARE_STYLE[Math.min(k, COMPARE_STYLE.length - 1)] }
      }),
    [params, data, s],
  )
  const marks = useMemo<MarkSpec[]>(() => {
    const out: MarkSpec[] = []
    let first = true
    for (const d of data.enhanced_days?.days ?? []) {
      const ms = Date.parse(`${d.date}T12:00:00Z`)
      out.push({ x: (ms - t0) / DAY_MS, y: d.mean, shape: 'diamond', hollow: true, color: '--lf-text', size: 5, label: first ? 'enhanced (design-choice rule)' : undefined })
      first = false
    }
    return out
  }, [data, t0])
  const xFormat = useMemo(() => (v: number) => new Date(t0 + v * DAY_MS).toISOString().slice(5, 10), [t0])
  const summary = data.series[params[0] ?? data.headline_parameter]?.summary
  const digits = (summary?.median ?? 1) < 1 ? 3 : 0
  const yFormat = useMemo(() => (yLog ? (v: number) => (Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9 ? fmt(v, digits) : '') : (v: number) => fmt(v, digits)), [digits, yLog])
  const units = unitText(s.units)
  // Log axis bounds: one decade around the observed daily means.
  const all = lines.flatMap((l) => l.values).filter((v): v is number => typeof v === 'number' && v > 0)
  const yMin = yLog && all.length ? 10 ** Math.floor(Math.log10(Math.min(...all))) : undefined
  const yMax = yLog && all.length ? 10 ** Math.ceil(Math.log10(Math.max(...all))) : undefined
  return (
    <>
      <TimeChart
        x={x}
        lines={lines}
        marks={marks}
        xFormat={xFormat}
        yFormat={yFormat}
        yLog={yLog}
        yMin={yMin}
        yMax={yMax}
        height={200}
        ariaLabel={`${ariaWhat}: ${s.v.filter((v) => v !== null).length} daily means in ${units}${yLog ? ', log scale' : ''}${params.length > 1 ? `, ${params.length} detector series` : ''}.`}
      />
      <p className="lf-tr-muted">
        {params.length > 1 ? (
          <>
            Daily means in {units}, as served{yLog ? ', on a log scale so that equal ratios look equal' : ''}:{' '}
            {params.map((p, k) => (
              <span key={p}>
                {k ? '; ' : ''}
                {STYLE_WORD[Math.min(k, STYLE_WORD.length - 1)]} = {paramLabel(data, p)} (<code>{p}</code>)
              </span>
            ))}
            .
          </>
        ) : (
          <>
            Daily mean of {paramLabel(data, params[0] ?? data.headline_parameter)} (<code>{params[0] ?? data.headline_parameter}</code>) in{' '}
            {units}, as served.
          </>
        )}
        {summary ? (
          <>
            {' '}
            Window median{params.length > 1 ? ' of the solid series' : ''} <Num value={summary.median ?? null} unit={units} digits={digits ? 5 : 1} />
            {typeof summary.median_uGy_per_day === 'number' && s.units !== 'uGy/day' ? (
              <>
                {' '}
                (= <Num value={summary.median_uGy_per_day} unit="µGy/day" digits={1} />, a unit conversion only)
              </>
            ) : null}
            .
          </>
        ) : null}{' '}
        {s.gaps.length ? (
          <span className="lf-tr-nodata">
            <StaleIcon size={13} /> No sample on {s.gaps.join(', ')} (drawn as a gap).
          </span>
        ) : null}
      </p>
      {data.enhanced_days ? (
        <p className="lf-tr-muted">
          Enhanced days: {unitText(data.enhanced_days.rule)}. <Chip kind={DESIGN_CHIP} /> It flags days for a human to look at; it does not identify a solar
          particle event and never alerts.
        </p>
      ) : null}
    </>
  )
}

function TepcChart({ data }: { data: TepcData }) {
  const [cols, setCols] = useState(700)
  const raw = useMemo(() => tepcNative(data), [data])
  const t0 = Date.parse(data.native_window.start)
  const t1 = Date.parse(data.native_window.stop)
  const env = useMemo(() => envelope(raw.t.map((ms) => (ms - t0) / 3_600_000), raw.v, 0, (t1 - t0) / 3_600_000, cols), [raw, t0, t1, cols])
  const lines = useMemo<LineSpec[]>(
    () => [
      { label: 'max', values: env.max, color: '--lf-text-2', width: 1 },
      { label: 'min', values: env.min, color: '--lf-text-2', width: 1 },
    ],
    [env],
  )
  const bands = useMemo(() => [{ upper: 0, lower: 1, fill: 'rgba(209,209,209,0.45)' }], [])
  const xFormat = useMemo(() => (v: number) => `${String(Math.floor(v)).padStart(2, '0')}:00`, [])
  const st = data.native_window.dose_rate_stats_uGy_per_min
  // Log axis: the orbital background (median ~0.07) and the SAA spikes (up to ~9) differ by two decades,
  // and a linear axis flattens the background the explainer describes. Bounds: the decades around the data.
  const finite = raw.v.filter((v): v is number => typeof v === 'number' && v > 0)
  const yMin = finite.length ? 10 ** Math.floor(Math.log10(Math.min(...finite))) : 0.01
  const yMax = finite.length ? 10 ** Math.ceil(Math.log10(Math.max(...finite))) : 10
  return (
    <>
      <TimeChart
        x={env.x}
        lines={lines}
        bands={bands}
        xFormat={xFormat}
        yFormat={logLabel}
        yLog
        yMin={yMin}
        yMax={yMax}
        height={210}
        onPlotWidth={(w) => setCols((c) => (Math.abs(c - Math.round(w)) >= 2 ? Math.max(60, Math.round(w)) : c))}
        ariaLabel={`ISS TEPC absorbed dose rate on ${data.native_window.start.slice(0, 10)}, one value per minute in µGy/min on a log scale: a background that varies along each orbit, with spikes on orbits through the South Atlantic Anomaly.`}
      />
      <p className="lf-tr-muted">
        Absorbed dose rate in the detector, µGy/min on a log scale, {data.native_window.start.slice(0, 10)} UTC (one ordinary day; the dataset
        ends in 2018).
        {st ? (
          <>
            {' '}
            Median <Num value={st.median ?? null} unit="µGy/min" digits={3} />
            {typeof st.p95 === 'number' ? (
              <>
                , 95th percentile <Num value={st.p95} unit="µGy/min" digits={3} />
              </>
            ) : null}
            , peak <Num value={st.max ?? null} unit="µGy/min" digits={3} />.
          </>
        ) : null}{' '}
        {data.native_window.dose_uGy !== undefined ? (
          <>
            Day total <Num value={data.native_window.dose_uGy} unit="µGy" digits={1} /> (absorbed, not effective dose).
          </>
        ) : null}{' '}
        {data.explainer}
      </p>
    </>
  )
}

interface SpeDayBlock {
  baseline?: { value?: number; unit?: string; parameter?: string; chip?: string; source?: Record<string, unknown> }
  scaling?: { dose_multiple_at_s3?: number; chip?: string; source?: Record<string, unknown> }
}

function OnboardDoseToday({ index, runtime, t, sim }: { index: ScenarioIndex; runtime: readonly Observation[]; t: number; sim: unknown }) {
  const day0 = Math.floor(t / 86_400) * 86_400
  const obs = useMemo(() => observationsFor(index, runtime, null, 'onboard_dose_rate').filter((o) => o.t >= day0 && o.t <= t), [index, runtime, day0, t])
  const base = (sim as { spe_day?: SpeDayBlock })?.spe_day
  const quiet = typeof base?.baseline?.value === 'number' ? base.baseline.value : null
  const multiple = typeof base?.scaling?.dose_multiple_at_s3 === 'number' ? base.scaling.dose_multiple_at_s3 : null
  const x = useMemo(() => obs.map((o) => o.t), [obs])
  const lines = useMemo<LineSpec[]>(() => [{ label: 'simulated habitat dose rate', values: obs.map((o) => o.value), color: '--lf-text-2', width: 1.5 }], [obs])
  const hlines = useMemo<HLineSpec[]>(
    () =>
      quiet !== null
        ? [{ y: quiet, label: `quiet Mars rate ${fmt(quiet, 1)} µGy/day (real: MSL RAD median)`, short: 'quiet Mars rate', color: '--lf-text-muted', dash: [3, 3] }]
        : [],
    [quiet],
  )
  const vlines = useMemo<VLineSpec[]>(() => [{ x: t, label: 'NOW', color: '--lf-text' }], [t])
  const xFormat = useMemo(() => (v: number) => {
    const s = Math.max(0, Math.floor(v - day0))
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
  }, [day0])
  const yFormat = useMemo(() => (v: number) => fmt(v, 0), [])
  if (!obs.length) return null
  const last = obs[obs.length - 1]
  const unit = unitText(last.unit)
  const rationale = typeof base?.scaling?.source?.rationale === 'string' ? (base.scaling.source.rationale as string) : null
  return (
    <div className="lf-rad-sub">
      <h3 className="lf-tr-card-title">
        Habitat dose rate today: a simulated confirmation{' '}
        <Kind kind="simulated">
          SIMULATED{multiple !== null ? <> · ASSUMED {fmt(multiple)}× SCALING</> : null} · DESIGN CHOICE
        </Kind>
      </h3>
      <SimulatedMarker variant="banner">
        Scenario values, not a measurement: the real Mars quiet rate plus the 1989 flux profile under an assumed scaling.
      </SimulatedMarker>
      <p className="lf-tr-meta">
        <span>
          Simulated value at <MetTime t={last.t} label />: <Num value={last.value} unit={unit} digits={0} />
          {quiet !== null && quiet > 0 ? (
            <>
              {' '}
              (<Num value={last.value / quiet} digits={1} unit="×" /> the quiet rate)
            </>
          ) : null}
        </span>
        <span>quiet rate:</span>
        <Chip kind={base?.baseline?.chip} />
        <span>scaling:</span>
        <Chip kind={base?.scaling?.chip} />
      </p>
      <TimeChart x={x} lines={lines} hlines={hlines} vlines={vlines} xMin={day0} xMax={Math.max(t, day0 + 600)} xFormat={xFormat} yFormat={yFormat} height={180} ariaLabel={`Simulated habitat dose rate today, ${obs.length} five-minute values in ${unit}, latest simulated value ${fmt(last.value, 0)}.`} />
      <p className="lf-tr-muted">
        {multiple !== null ? (
          <>
            The 1989 ≥10 MeV profile is mapped linearly so that NOAA’s S3 flux gives <Num value={multiple} unit="×" /> the measured Mars quiet
            rate.{' '}
          </>
        ) : null}
        {rationale ? (
          <>
            <Chip kind={base?.scaling?.chip} /> {rationale}{' '}
          </>
        ) : (
          <>Not a radiation-transport calculation, and no effective dose (mSv) is derived from it. </>
        )}
        The quiet rate is the real MSL RAD detector-E median, which may include the rover’s own power-source background (see the dosimetry
        above).
      </p>
      <MarsSepContext multiple={multiple} />
    </div>
  )
}

/**
 * MSL RAD: the headline detector-E total may include the rover's RTG background (snapshot caveat). The
 * numbers are this window's own medians of the publisher's raw and RTG-corrected detector-B series.
 */
function RtgNote({ data }: { data: HapiDoseData }) {
  const raw = data.series.dose_b_raw?.summary?.median
  const corrected = data.series.dose_b_rtg?.summary?.median
  if (typeof raw !== 'number' || typeof corrected !== 'number') return null
  const units = unitText(data.series.dose_b_raw?.units)
  return (
    <>
      {' '}
      This detector-E reading may also include the rover’s own power-source (RTG) background: the publisher does not say whether
      detector E is RTG-corrected, and on silicon detector B its RTG correction lowers this window’s median from{' '}
      <Num value={raw} unit={units} digits={1} /> to <Num value={corrected} unit={units} digits={1} />. So the natural rate a crew outdoors
      would face may be lower than this headline.
    </>
  )
}

/** CRaTER's detector pairs on the days its D1&2 dose was enhanced, and DONKI's observed SEP entries around them. */
function CraterPairs({ data }: { data: HapiDoseData }) {
  const donki = useMeta<DonkiData>('swpc_sep_events')
  const pairs = useMemo(() => ['d1_2_dose_rate', 'd3_4_dose_rate', 'd5_6_dose_rate'].filter((p) => data.series[p]), [data])
  const days = useMemo(() => (data.enhanced_days?.days ?? []).map((d) => d.date), [data])
  const rows = useMemo(() => detectorDays(data, days, pairs), [data, days, pairs])
  const runs = useMemo(() => dateRuns(days), [days])
  const checks = useMemo(() => (donki.status === 'ready' && donki.snap ? donkiCrossCheck(runs, donki.snap.data.events) : null), [donki.status, donki.snap, runs])
  if (pairs.length < 2 || !rows.length) return null
  const units = unitText(data.series[pairs[0]]?.units)
  const median = (p: string) => data.series[p]?.summary?.median ?? null
  const label = (p: string) => (data.parameters?.[p]?.description ?? p).replace(/^Combined (.+?) detector dose rate$/, '$1')
  const peak = (run: string[]) =>
    run.reduce<{ date: string; ratio: number } | null>((best, date) => {
      const r = rows.find((x) => x.date === date)?.pairs[0].ratio ?? null
      return r !== null && (!best || r > best.ratio) ? { date, ratio: r } : best
    }, null)
  const matched = checks ? checks.filter((c) => c.observed.length > 0).length : null
  return (
    <section className="lf-rad-sub" aria-labelledby="rad-crater-h">
      <h3 id="rad-crater-h" className="lf-tr-card-title">
        Three detector pairs, one telescope <Kind kind="historical">MEASURED · LUNAR ORBIT</Kind>
      </h3>
      <p>
        In quiet times the pairs agree: window medians <Num value={median(pairs[0])} unit={units} digits={4} /> ({label(pairs[0])}) and{' '}
        <Num value={median(pairs[1])} unit={units} digits={4} /> ({label(pairs[1])}). On the days the rule below flags, they part: each
        pair’s daily mean as a multiple of its own median.
      </p>
      <div className="lf-tr-table-wrap lf-rad-pairs-wrap">
        <table className="lf-tr-table lf-rad-pairs">
          <caption className="lf-rad-caption">CRaTER daily means on the flagged days, in {units} and as a multiple of each pair’s own median</caption>
          <thead>
            <tr>
              <th scope="col">Day (UTC)</th>
              {pairs.map((p) => (
                <th key={p} scope="col" className="num">
                  {label(p)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date}>
                <th scope="row" className="num">
                  {r.date}
                </th>
                {r.pairs.map((c) => (
                  <td key={c.parameter} className="num">
                    <Num value={c.mean} digits={4} /> <span className="lf-rad-x">(<Num value={c.ratio} digits={1} unit="×" />)</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="lf-tr-muted">
        What sits between the pairs, in NASA’s description of the instrument: “One pair is at each entrance aperture and one is between the two
        layers of TEP”, tissue-equivalent plastic that “is designed to be analogous to human muscle” (
        <a href={CRATER_NSSDCA_URL} target="_blank" rel="noopener noreferrer">
          NASA NSSDCA, CRaTER
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        ). The dataset names its pairs {pairs.map(label).join(', ')} without saying where each sits; read in stack order, {label(pairs[1])} is
        the pair between the two plastic layers. That reading is this page’s assumption. If it holds, the gap shows what several centimetres of
        tissue-like plastic did to these particular events. Neither pair is a crew dose, and LANDFALL does not pick one to stand for a
        crewmember.
      </p>
      <h4 className="lf-rad-h4">Independent cross-check: NASA’s DONKI event log</h4>
      {checks ? (
        <>
          <p className="lf-tr-muted">
            DONKI is NASA CCMC’s analyst-logged database of space-weather events. Below, for each run of flagged days, the solar energetic
            particle entries DONKI logged from the day before the run to its last day, observed by an instrument (entries whose instrument is
            a model forecast, “MODEL: …”, are left out: a forecast is not an observation). None of these instruments is CRaTER and the
            flagging rule does not read DONKI, so this checks timing only: <Num value={matched} /> of <Num value={checks.length} /> runs have
            an observed entry.
          </p>
          <ul className="lf-rad-xcheck">
            {checks.map((c) => {
              const p = peak(c.run)
              return (
                <li key={c.run[0]}>
                  <p className="lf-rad-xcheck-head">
                    <strong>
                      {c.run[0]}
                      {c.run.length > 1 ? <> to {c.run[c.run.length - 1]}</> : null}
                    </strong>
                    {p ? (
                      <>
                        {' '}
                        · peak {label(pairs[0])} day {p.date} (<Num value={p.ratio} digits={1} unit="×" />)
                      </>
                    ) : null}
                    {c.observed.length === 0 ? (
                      <span className="lf-dq" data-tone="stale">
                        <UnknownIcon size={13} /> no observed DONKI entry
                      </span>
                    ) : null}
                  </p>
                  {c.observed.length ? (
                    <ul className="lf-rad-donki">
                      {c.observed.map((e) => (
                        <li key={e.sep_id}>
                          <span className="lf-num">{utcLabel(Date.parse(e.event_time))}</span> {e.instruments.join('; ')}
                          {e.link ? (
                            <>
                              {' '}
                              <a href={e.link} target="_blank" rel="noopener noreferrer">
                                DONKI entry
                                <span className="sr-only"> {e.sep_id} (opens in a new tab)</span>
                              </a>
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="lf-tr-muted">Not every enhanced day has a logged event: the rule flags days for a person to look at.</p>
                  )}
                  {c.modelled ? (
                    <p className="lf-tr-muted">
                      <Num value={c.modelled} /> model-forecast {c.modelled === 1 ? 'entry' : 'entries'} in the same span, not counted.
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
          <p className="lf-tr-muted">
            <FreshnessChip meta={donki.snap} status={donki.status} id="swpc_sep_events" source={donki.snap?.source} />
          </p>
        </>
      ) : (
        <p className="lf-tr-nodata">
          <StaleIcon size={13} /> DONKI SEP log (swpc_sep_events) {donki.status === 'loading' ? 'loading' : 'not in this build'}.
        </p>
      )}
    </section>
  )
}

function MeasuredPanel({ envId, index, runtime, t, sim }: { envId: EnvId; index: ScenarioIndex | null; runtime: readonly Observation[]; t: number; sim: unknown }) {
  const env = environment(envId)
  const id = env.dose_snapshot
  const dose = useMeta<unknown>(id ?? null)
  const track = useMeta<IssTrackData>(envId === 'iss' ? 'hapi_iss_track' : null)
  // Only the environment notes about radiation (environments.json also carries comms notes).
  const notes = (env.notes ?? []).filter((n) => /dose|dosimetr|flux|radiation|SPE|GOES|CRaTER/i.test(n))
  const title = 'Dose rate measured in this environment'
  if (!id) {
    return (
      <Panel title={title} eyebrow={env.label}>
        <EmptyState kind="unavailable" title="No dosimetry for this environment" headingLevel={3}>
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </EmptyState>
      </Panel>
    )
  }
  const snap = dose.snap
  const footer = (
    <>
      <FreshnessChip meta={snap} status={dose.status} id={id} source={snap?.source} />
      {snap ? <span>{snap.source.name}</span> : null}
    </>
  )
  return (
    <Panel title={title} eyebrow={<Kind kind="historical">HISTORICAL · MEASURED · {snap?.title ?? id}</Kind>} footer={footer}>
      {dose.status !== 'ready' || !snap ? (
        <EmptyState kind={dose.status === 'loading' ? 'loading' : 'missing'} title={dose.status === 'loading' ? 'Reading the snapshot' : 'Snapshot not in this build'} headingLevel={3}>
          <p>
            <code>{id}.json</code>
          </p>
        </EmptyState>
      ) : envId === 'iss' ? (
        <>
          <TepcChart data={snap.data as TepcData} />
          {track.status === 'ready' && track.snap ? (
            <SaaStrip track={track.snap.data} snap={track.snap} status={track.status} />
          ) : (
            <p className="lf-tr-nodata">
              <StaleIcon size={13} /> SAA prediction (hapi_iss_track) {track.status === 'loading' ? 'loading' : 'not in this build'}.
            </p>
          )}
        </>
      ) : id === 'hapi_crater_dose' ? (
        <DailyDoseChart data={snap.data as HapiDoseData} ariaWhat={snap.title} parameters={['d1_2_dose_rate', 'd3_4_dose_rate']} yLog />
      ) : (
        <DailyDoseChart data={snap.data as HapiDoseData} ariaWhat={snap.title} />
      )}
      {snap && dose.status === 'ready' ? (
        <>
          {(snap.data as { explainer?: string }).explainer && envId !== 'iss' ? (
            <p>
              {(snap.data as { explainer?: string }).explainer}
              {id === 'hapi_msl_rad_dose' ? <RtgNote data={snap.data as HapiDoseData} /> : null}
            </p>
          ) : null}
          {id === 'hapi_crater_dose' ? <CraterPairs data={snap.data as HapiDoseData} /> : null}
          {notes.length ? (
            <Expander summary={`Environment notes (engine/rules/environments.json, ${notes.length})`}>
              {notes.map((n) => (
                <p key={n} className="lf-tr-muted">
                  {n}
                </p>
              ))}
            </Expander>
          ) : null}
          <Expander summary="Caveats from the snapshot">
            <ul>
              {snap.caveats.map((c) => (
                <li key={c}>{unitText(c)}</li>
              ))}
            </ul>
          </Expander>
        </>
      ) : null}
      {envId === 'mars_surface' ? <MarsSepRecord /> : null}
      {envId === 'mars_surface' && index ? <OnboardDoseToday index={index} runtime={runtime} t={t} sim={sim} /> : null}
    </Panel>
  )
}

// ---- cumulative dose against the limits -------------------------------------------------------------------------

const WINDOW_COLS: Array<{ key: string; label: string; match: (r: Rule) => boolean }> = [
  { key: '30_day', label: '30-day', match: (r) => r.window?.kind === 'cumulative' && r.window?.duration === 'P30D' },
  { key: '1_year', label: '1-year', match: (r) => r.window?.kind === 'cumulative' && r.window?.duration === 'P1Y' },
  { key: 'career', label: 'Career', match: (r) => r.window?.kind === 'career' },
]

function evalSafe(
  rule: Rule,
  index: ScenarioIndex,
  runtime: readonly Observation[],
  crewId: CrewId,
  envId: EnvId,
  t: number,
): { finding: Finding | null; error: string | null; value: number | null; partial: boolean; reports: number } {
  try {
    const ev = evaluateRuleAt(rule, index, runtime, crewId, envId, t)
    // A summed window whose record starts after the window opens is a partial record (D15). Prefer the
    // app's own flag if the aggregation reports one; otherwise judge it from the reports themselves.
    const own = (ev.input as { partial?: unknown }).partial
    const kind = rule.window?.kind
    let partial = false
    let reports = ev.input.n
    if (typeof own === 'boolean') partial = own
    else if (kind === 'cumulative' || (kind === 'career' && !TO_DATE_VARIABLES.has(rule.variable))) {
      const seconds = kind === 'career' ? null : windowSeconds(rule.window?.duration)
      const cov = recordCoverage(observationsFor(index, runtime, crewId, rule.variable), rule.unit, t, seconds)
      partial = cov.partial
      reports = cov.n
    }
    return { finding: ev.finding, error: null, value: ev.input.value, partial, reports }
  } catch (e) {
    return { finding: null, error: (e as Error).message, value: null, partial: false, reports: 0 }
  }
}

/**
 * One Table 4.8-1 cell. A partial record's logged sum is a lower bound of the window's dose: it can show
 * that a limit is reached or approached (conclusive), but never that the window is "within limit".
 */
function OrganCell({ rule, r }: { rule: Rule; r: ReturnType<typeof evalSafe> }) {
  if (!r.finding) return <span className="lf-tr-nodata">{r.error}</span>
  const v = organVerdict(r.finding.status, r.partial, r.value)
  return (
    <span className="lf-rad-cell">
      <span>
        {OPS_SYMBOL[rule.op] ?? rule.op} <Num value={rule.limit} unit={rule.unit} />
      </span>
      {v.logged ? (
        <span className="lf-rad-logged">
          logged <Num value={r.value} unit={rule.unit} /> of <Num value={rule.limit} unit={rule.unit} />
        </span>
      ) : null}
      {v.badge ? <FindingBadge finding={r.finding} /> : null}
      {v.partialTag ? <PartialTag /> : null}
    </span>
  )
}

function LimitsPanel({ index, runtime, envId, t, crewId, vol1 }: { index: ScenarioIndex; runtime: readonly Observation[]; envId: EnvId; t: number; crewId: CrewId; vol1: { reqs: RequirementRec[]; doc: string } }) {
  const rules = useMemo(() => thresholdRules(RULES), [])
  const career = rules.find((r) => r.role !== 'context' && r.window?.kind === 'career' && r.unit === 'mSv') ?? null
  const organ = rules.filter((r) => r.role !== 'context' && r.category === 'PEL' && (r.unit === 'mGy-Eq' || r.unit === 'mGy'))
  const organVars = Array.from(new Set(organ.map((r) => r.variable)))
  // Organ-dose reports in this crewmember's record (scenario + entered on this device), in a limit's own unit.
  const organReports = organVars.reduce((n, variable) => {
    const units = new Set(organ.filter((r) => r.variable === variable).map((r) => r.unit))
    return n + observationsFor(index, runtime, crewId, variable).filter((o) => o.t <= t && units.has(o.unit) && Number.isFinite(o.value)).length
  }, 0)
  let spe: Rule | null = null
  try {
    spe = getRule(RULES, 'ctx_spe_design_reference')
  } catch {
    spe = null
  }
  const req4031 = findRequirement(vol1.reqs, 'V1 4031')
  const req4030 = findRequirement(vol1.reqs, 'V1 4030')
  return (
    <Panel title="Cumulative dose against the NASA limits" eyebrow="Tier A · PEL ceilings">
      {career ? (
        <section className="lf-rad-sub" aria-labelledby="rad-career-h">
          <h3 id="rad-career-h" className="lf-tr-card-title">
            {career.label} <CategoryBadge category={career.category} long /> <Chip kind={career.chip} />{' '}
            {(career.source as { requirement_id?: string }).requirement_id ? <ReqId id={(career.source as { requirement_id: string }).requirement_id} /> : null}
          </h3>
          <SimulatedMarker>Dose records are simulated priors (sim_crew), not a calculation.</SimulatedMarker>
          <ul className="lf-rad-bars">
            {CREW.map((c) => {
              const r = evalSafe(career, index, runtime, c.id, envId, t)
              const v = r.value
              const approach = typeof career.approach_at?.value === 'number' ? career.approach_at.value : null
              return (
                <li key={c.id}>
                  <span className="lf-num lf-rad-crew">{c.id}</span>
                  <span className="lf-rad-bar" aria-hidden="true">
                    <span className="lf-rad-fill" style={{ width: `${v !== null ? Math.min(100, (v / career.limit) * 100) : 0}%` }} />
                    {approach !== null ? <span className="lf-rad-mark" style={{ left: `${(approach / career.limit) * 100}%` }} /> : null}
                  </span>
                  <span>
                    <Num value={v} unit={career.unit} digits={0} /> of {OPS_SYMBOL[career.op] ?? career.op} <Num value={career.limit} unit={career.unit} />
                  </span>
                  {r.finding ? <FindingBadge finding={r.finding} /> : <span className="lf-tr-nodata">{r.error}</span>}
                </li>
              )
            })}
          </ul>
          <p className="lf-tr-muted">
            Tick: approach level <Num value={career.approach_at?.value ?? null} unit={career.unit} /> (<Chip kind={career.approach_at?.chip} />
            ). Effective dose is the quantity of this limit, so it is compared directly. The SPE day’s absorbed dose (µGy) is not added to it:
            LANDFALL makes no personal dose projection and runs no REID model.
          </p>
          {req4030 ? <Quote req={req4030} doc={vol1.doc} /> : null}
        </section>
      ) : null}
      <section className="lf-rad-sub" aria-labelledby="rad-organ-h">
        <h3 id="rad-organ-h" className="lf-tr-card-title">
          Organ dose limits, Table 4.8-1 (mGy-Eq and mGy, never mSv) for {crewId}
        </h3>
        <div className="lf-tr-table-wrap lf-rad-organ">
          <table className="lf-tr-table">
            <thead>
              <tr>
                <th scope="col">Organ</th>
                {WINDOW_COLS.map((w) => (
                  <th key={w.key} scope="col">
                    {w.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {organVars.map((variable) => {
                const row = organ.filter((r) => r.variable === variable)
                const name = (row[0]?.source as { row?: string } | undefined)?.row ?? row[0]?.label ?? variable
                return (
                  <tr key={variable}>
                    <th scope="row">{name}</th>
                    {WINDOW_COLS.map((w) => {
                      const rule = row.find(w.match)
                      if (!rule) return <td key={w.key}>not in Table 4.8-1</td>
                      return (
                        <td key={w.key}>
                          <OrganCell rule={rule} r={evalSafe(rule, index, runtime, crewId, envId, t)} />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {organReports === 0 ? (
          <p className="lf-tr-muted">
            No organ dose in mGy-Eq or mGy is in {crewId}’s record, so every cell reads insufficient data (cyan) instead of a guess.
          </p>
        ) : (
          <p className="lf-tr-muted">
            {crewId}’s record holds <Num value={organReports} /> organ-dose {organReports === 1 ? 'report' : 'reports'}. A window the record does
            not cover from its start reads <PartialTag /> (cyan, as missing data): the logged sum is a lower bound, because unlogged time is not
            zero dose. It can show a limit reached or approached, never “within limit”.
          </p>
        )}
        <p className="lf-tr-muted">
          Organ dose needs an organ-dose model; LANDFALL compares only values reported in the limit’s own unit and takes no Gy to Gy-Eq or Sv
          step. Limits read from <code>engine/rules/thresholds.json</code> (<Chip kind={organ[0]?.chip} />, Table 4.8-1).
        </p>
      </section>
      {spe ? (
        <section className="lf-rad-sub" aria-labelledby="rad-spe-h">
          <h3 id="rad-spe-h" className="lf-tr-card-title">
            The 1989 event is NASA’s design reference SPE <CategoryBadge category={spe.category} /> <Chip kind={spe.chip} />
          </h3>
          <p>
            The flux replayed above is the event NASA-STD-3001 names as its design reference: a requirement on the vehicle’s shielding, shown as
            context and never as an alert.
          </p>
          <Quote req={req4031} doc={vol1.doc} />
        </section>
      ) : null}
    </Panel>
  )
}

const OPS_SYMBOL: Record<string, string> = { lt: '<', le: '≤', gt: '>', ge: '≥' }

// ---- live GOES (frozen at build) + the S-scale reference -------------------------------------------------------------

function LiveGoesPanel({ live, status, snap, scale, scaleSnap, scaleStatus, scenarioLevel }: { live: ProtonsLiveData | null; status: LoadStatus; snap: Snapshot<ProtonsLiveData> | null; scale: SScaleData | null; scaleSnap: Snapshot<SScaleData> | null; scaleStatus: LoadStatus; scenarioLevel: number | null }) {
  const s7 = live?.series_7d
  const x = useMemo(() => {
    if (!s7) return []
    const r = regularSeries(s7)
    const t0 = r.t[0]
    return r.t.map((ms) => (ms - t0) / DAY_MS)
  }, [s7])
  const t0 = s7 ? Date.parse(s7.start) : 0
  const lines = useMemo<LineSpec[]>(() => (s7 ? [{ label: 'GOES 7-day', values: s7.values, color: '--lf-data-stale', width: 1.25 }] : []), [s7])
  const hlines = useMemo<HLineSpec[]>(() => (scale?.levels.slice(0, 1) ?? []).map((l) => ({ y: l.threshold_pfu, label: `${l.level} ≥ ${fmt(l.threshold_pfu)} pfu`, color: '--lf-text-muted', dash: [2, 3], width: 1 })), [scale])
  const xFormat = useMemo(() => (v: number) => new Date(t0 + v * DAY_MS).toISOString().slice(5, 10), [t0])
  return (
    <Panel
      title="Real conditions when this site was built"
      eyebrow={<Kind kind="stale">LIVE FEED, FROZEN AT BUILD</Kind>}
      footer={
        <>
          <FreshnessChip meta={snap} status={status} id="swpc_protons_live" source={snap?.source} />
          <FreshnessChip meta={scaleSnap} status={scaleStatus} id="swpc_s_scale" source={scaleSnap?.source} />
        </>
      }
    >
      {live ? (
        <>
          <p className="lf-rad-big lf-rad-stale">
            <span className="lf-rad-label">GOES ≥10 MeV at {utcLabel(Date.parse(live.current.time_tag))}</span>
            <Num value={live.current.flux_pfu} unit="pfu" digits={3} />
            <span>
              S-level <Num value={live.current.s_level} />
            </span>
            <span className="lf-dq" data-tone="stale">
              <StaleIcon size={13} /> STALE
            </span>
          </p>
          <p className="lf-tr-muted">
            This is the real NOAA feed frozen at build, not the scenario: the site has no backend, so it cannot be current. The scenario above runs
            on the 1989 replay instead.
          </p>
          {s7 ? (
            <TimeChart x={x} lines={lines} hlines={hlines} yLog yMin={0.01} yMax={100000} xFormat={xFormat} yFormat={logLabel} height={150} ariaLabel={`GOES proton flux for the 7 days before the build, hourly maxima, stale.`} />
          ) : null}
          {s7?.method ? <p className="lf-tr-muted">Seven days before the build, {s7.method}. Cyan = stale data ([V2 10020]).</p> : null}
        </>
      ) : (
        <EmptyState kind={status === 'loading' ? 'loading' : 'missing'} title="Live feed not in this build" headingLevel={3}>
          <p>
            <code>swpc_protons_live.json</code>
          </p>
        </EmptyState>
      )}
      {scale ? (
        <div className="lf-tr-table-wrap lf-rad-scale">
          <table className="lf-tr-table">
            <caption className="lf-rad-caption">NOAA Space Weather Scale, solar radiation storms (verbatim biological text)</caption>
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col" className="num">
                  ≥10 MeV flux
                </th>
                <th scope="col">Biological</th>
              </tr>
            </thead>
            <tbody>
              {scale.levels.map((l) => (
                <tr key={l.level} data-current={scenarioLevel === l.n || undefined}>
                  <th scope="row">
                    {l.level} {l.descriptor}
                    {scenarioLevel === l.n ? <span className="lf-rad-here"> ← scenario now</span> : null}
                  </th>
                  <td className="num">≥ {fmt(l.threshold_pfu)} pfu</td>
                  <td>{l.effects?.Biological ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="lf-tr-muted">
        <CategoryBadge category="OPS" long /> NOAA’s operational scale, not a NASA crew-health limit. <Chip kind={NOAA_CHIP} />
      </p>
    </Panel>
  )
}

// ---- page ------------------------------------------------------------------------------------------------------------

export default function Radiation(_props: FeatureProps) {
  const { state, setEnv } = useMission()
  const envId = state.envId as EnvId
  const t = useMetMinute()
  const scenario = useScenario()
  const index = scenario.index
  const runtime = state.observations
  const replay = useMeta<ReplayData>('swpc_spe_replay')
  const scale = useMeta<SScaleData>('swpc_s_scale')
  const speList = useMeta<SpeListData>('swpc_spe_list')
  const live = useMeta<ProtonsLiveData>('swpc_protons_live')
  const v1 = useMeta<{ requirements: RequirementRec[] }>('std_vol1_requirements')
  const v2 = useMeta<{ requirements: RequirementRec[] }>('std_vol2_requirements')
  const { ops, opsError } = useMemo(() => {
    if (!index) return { ops: null, opsError: scenario.error }
    try {
      return { ops: evaluateOps(index, runtime, envId, t), opsError: null }
    } catch (e) {
      return { ops: null, opsError: (e as Error).message }
    }
  }, [index, runtime, envId, t, scenario.error])
  const env = environment(envId)
  const vol1 = { reqs: v1.snap?.data.requirements ?? [], doc: v1.snap?.source.name ?? 'NASA-STD-3001 Vol 1' }
  const vol2 = { reqs: v2.snap?.data.requirements ?? [], doc: v2.snap?.source.name ?? 'NASA-STD-3001 Vol 2' }
  return (
    <div className="lf-tr lf-rad">
      <h1>Radiation</h1>
      <p className="lf-tr-lead">
        The radiation environment at <strong>{env.label}</strong>, from real NASA and NOAA measurements, and the scenario’s proton reading (a
        replay of a real 1989 event; simulated values are labelled where they appear). Absorbed dose (Gy) is never converted into effective
        dose (Sv): each quantity is compared only with a limit in its own unit.
      </p>
      <EnvPicker envId={envId} onPick={setEnv} />
      <ProtonPanel
        ops={ops}
        opsError={opsError}
        replay={replay.status === 'ready' ? replay.snap?.data ?? null : null}
        replayStatus={replay.status}
        replaySnap={replay.snap}
        sim={scenario.sim.data}
        scale={scale.status === 'ready' ? scale.snap?.data ?? null : null}
        speList={speList.status === 'ready' ? speList.snap?.data ?? null : null}
        vol2={vol2}
        t={t}
        envId={envId}
      />
      <StormWitnesses />
      <MeasuredPanel envId={envId} index={index} runtime={runtime} t={t} sim={scenario.sim.data} />
      {index ? <LimitsPanel index={index} runtime={runtime} envId={envId} t={t} crewId={state.crewId} vol1={vol1} /> : null}
      <LiveGoesPanel
        live={live.status === 'ready' ? live.snap?.data ?? null : null}
        status={live.status}
        snap={live.snap}
        scale={scale.status === 'ready' ? scale.snap?.data ?? null : null}
        scaleSnap={scale.snap}
        scaleStatus={scale.status}
        scenarioLevel={ops?.s_level ?? null}
      />
      <p className="lf-tr-muted">
        The shelter case itself is on <a href="#/case/spe_shelter">Cases → Solar particle event</a>. Sources and freshness of every snapshot:{' '}
        <a href="#/data">Data</a>.
      </p>
    </div>
  )
}
