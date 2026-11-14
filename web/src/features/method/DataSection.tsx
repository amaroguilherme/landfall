// Section 5: data honesty. Real NASA data vs simulated crew data, and what "frozen at build"
// means. Facts are computed from the snapshots; caveats are quoted verbatim from them.
import type { ReactNode } from 'react'
import { useManifest, useSnapshot } from '../../app/data'
import type { ManifestEntry, SnapshotState } from '../../app/data'
import { Link } from '../../app/location'
import { CREW } from '../../app/vocab'
import { ClockIcon, Expander, FreshnessChip, Num, ReqId, SimulatedMarker } from '../../ui'
import { BuildNotes, splitBuildNotes } from '../data/buildNotes'
import { FoldPanel } from './fold'
import { normReqId } from './rules'
import type { OsdrCmpData, SimCrewData, Vol2Data } from './rules'
import { ExtLink, MissingNote, RichText, Verbatim } from './shared'

function Loading({ what }: { what: string }) {
  return (
    <p className="lf-m-small lf-m-loading" aria-busy="true">
      <ClockIcon size={14} /> Reading {what} from the frozen snapshot…
    </p>
  )
}

function Missing({ id, state }: { id: string; state: SnapshotState<unknown> }) {
  return (
    <MissingNote>
      Snapshot <code>{id}.json</code> is {state.status === 'missing' ? 'not in this build' : 'unreadable'}
      {state.error ? <> ({state.error})</> : null}.
    </MissingNote>
  )
}

function Facts({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="lf-m-facts">
      {rows.map(({ k, v }) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function labels(ts: { label: string }[]): ReactNode {
  if (ts.length === 0) return 'none'
  return <span className="lf-mono">{ts.map((t) => t.label).join(', ')}</span>
}

function OsdrCard() {
  const s = useSnapshot<OsdrCmpData>('osdr_cmp')
  let body: ReactNode
  if (s.status === 'loading') body = <Loading what="Inspiration4 chemistry" />
  else if (!s.data || !s.snapshot) body = <Missing id="osdr_cmp" state={s} />
  else {
    const d = s.data
    const pre = d.timepoints.filter((t) => t.anchor === 'launch' && t.day_offset < 0)
    const post = d.timepoints.filter((t) => t.anchor === 'return' && t.day_offset > 0)
    const inflight = d.timepoints.length - pre.length - post.length
    const start = Date.parse(d.study.mission.start)
    const end = Date.parse(d.study.mission.end)
    const flightDays = Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86_400_000) + 1 : null
    const caveat = s.snapshot.caveats.find((c) => /in-flight/i.test(c)) ?? s.snapshot.caveats[0]
    body = (
      <>
        <Facts
          rows={[
            { k: 'Study', v: <ExtLink href={d.study.landing_url}>{d.study.id}</ExtLink> },
            {
              k: 'Crew',
              v: (
                <>
                  n = <Num value={d.subjects.length} />
                </>
              ),
            },
            {
              k: 'Flight',
              v: (
                <>
                  <Num value={flightDays} unit="days" /> (<span className="lf-mono">{d.study.mission.start}</span> to{' '}
                  <span className="lf-mono">{d.study.mission.end}</span>)
                </>
              ),
            },
            { k: 'Samples before flight', v: labels(pre) },
            { k: 'Samples after flight', v: labels(post) },
            { k: 'Samples in flight', v: <Num value={inflight} /> },
          ]}
        />
        {caveat ? <Verbatim lead="Snapshot caveat:" text={caveat} /> : null}
      </>
    )
  }
  return (
    <article className="lf-m-src" aria-labelledby="m-src-osdr">
      <p className="lf-eyebrow">Real · measured</p>
      <h3 id="m-src-osdr" className="lf-m-kind-title">
        NASA OSDR: Inspiration4 blood chemistry
      </h3>
      {body}
      <p className="lf-m-src-foot">
        <FreshnessChip meta={s.snapshot} status={s.status} id="osdr_cmp" source={s.snapshot?.source} />
      </p>
    </article>
  )
}

function SimCard() {
  const s = useSnapshot<SimCrewData>('sim_crew')
  let body: ReactNode
  if (s.status === 'loading') body = <Loading what="the simulated scenario" />
  else if (!s.data || !s.snapshot) body = <Missing id="sim_crew" state={s} />
  else {
    const d = s.data
    // Caveats about how the file was built (they cite the internal plan) stay verbatim, in Build notes.
    const { shown: cav, build } = splitBuildNotes(s.snapshot.caveats)
    const shown = [cav.find((c) => /^SIMULATED/i.test(c)), cav.find((c) => /^Calibration/i.test(c)), cav.find((c) => /scripted/i.test(c))].filter(
      (c): c is string => !!c,
    )
    body = (
      <>
        <Facts
          rows={[
            {
              k: 'Crew',
              v: (
                <>
                  <Num value={CREW.length} /> fictional crewmembers, no names, no real data
                </>
              ),
            },
            {
              k: 'Days',
              v: (
                <>
                  MET <Num value={d.met.first_day} />–<Num value={d.met.last_day} />; baseline{' '}
                  <Num value={d.met.baseline_days[0]} />–<Num value={d.met.baseline_days[1]} />
                </>
              ),
            },
            {
              k: 'Generator',
              v: (
                <>
                  seeded (<span className="lf-mono">{d.generator.seed}</span>),{' '}
                  {d.generator.deterministic ? 'identical on every run' : 'not deterministic'}
                </>
              ),
            },
          ]}
        />
        {shown.map((c) => (
          <Verbatim key={c} lead="Snapshot caveat:" text={c} />
        ))}
        {cav.length > shown.length ? (
          <Expander summary={<>All <Num value={cav.length} /> caveats of the scenario</>}>
            <ol className="lf-m-plain">
              {cav.map((c) => (
                <li key={c}>
                  <RichText text={c} />
                </li>
              ))}
            </ol>
          </Expander>
        ) : null}
        <BuildNotes notes={build} what="scenario file" />
      </>
    )
  }
  return (
    <article className="lf-m-src" aria-labelledby="m-src-sim">
      <p className="lf-eyebrow">Simulated · labeled</p>
      <SimulatedMarker variant="banner">Every crew value in the app comes from this generator.</SimulatedMarker>
      <h3 id="m-src-sim" className="lf-m-kind-title">
        The crew’s vitals
      </h3>
      {body}
      <p className="lf-m-src-foot">
        <FreshnessChip meta={s.snapshot} status={s.status} id="sim_crew" source={s.snapshot?.source} />
      </p>
    </article>
  )
}

function countBy(entries: ManifestEntry[], key: (e: ManifestEntry) => string): [string, number][] {
  const m = new Map<string, number>()
  for (const e of entries) m.set(key(e), (m.get(key(e)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

function FrozenCard() {
  const m = useManifest()
  const v2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const staleReq = v2.data?.requirements.find((r) => normReqId(r.id) === 'V2 10020')
  let body: ReactNode
  if (m.status === 'loading') body = <Loading what="the manifest" />
  else if (m.status !== 'ready') body = <MissingNote>The manifest (<code>/data/manifest.json</code>) is {m.status}: {m.error}</MissingNote>
  else {
    const live = m.entries.filter((e) => e.freshness.kind === 'live')
    const adapters = new Set(m.entries.map((e) => e.adapter)).size
    body = (
      <>
        <p>
          <Num value={m.entries.length} /> snapshots from <Num value={adapters} /> ingest adapters, each one a same-origin
          file under <code>/data/</code> with its SHA-256 in <code>manifest.json</code>. Nothing is fetched from another site
          at run time: the page’s Content-Security-Policy (<code>connect-src 'self'</code>) would block it.
        </p>
        <ul className="lf-m-counts" aria-label="Snapshots by provenance">
          {countBy(m.entries, (e) => e.provenance).map(([k, n]) => (
            <li key={k}>
              <Num value={n} /> {k}
            </li>
          ))}
        </ul>
        {staleReq ? (
          <Verbatim
            lead={<ReqId id="V2 10020" />}
            text={staleReq.text}
            cite={<>NASA-STD-3001 Vol 2 Rev {v2.data?.document.revision}, §<span className="lf-mono">{staleReq.section}</span></>}
          />
        ) : v2.status !== 'loading' ? (
          <MissingNote>
            <ReqId id="V2 10020" /> is not in snapshot <code>std_vol2_requirements.json</code>.
          </MissingNote>
        ) : null}
        {live.length > 0 ? (
          <>
            <p>A live feed frozen at build goes stale, and LANDFALL says so. Right now:</p>
            <ul className="lf-m-plain lf-m-live">
              {live.map((e) => (
                <li key={e.id}>
                  <span className="lf-m-small">{e.title}</span>
                  <br />
                  <FreshnessChip meta={e} status="ready" />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="lf-m-small">
          Every source, with its licence and citation: <Link to="/data">Data sources</Link> · every number with its basis:{' '}
          <Link to="/provenance">Provenance</Link>.
        </p>
      </>
    )
  }
  return (
    <article className="lf-m-src" aria-labelledby="m-src-frozen">
      <p className="lf-eyebrow">Frozen at build</p>
      <h3 id="m-src-frozen" className="lf-m-kind-title">
        Everything else, including this page
      </h3>
      {body}
    </article>
  )
}

export function DataSection() {
  return (
    <FoldPanel
      s="data"
      eyebrow="Data honesty"
      title="Real NASA data, simulated crew data"
      abstract="What is measured, what is simulated, and what “frozen at build” means for a page judged weeks later."
      footer={<span>Sources: /data/osdr_cmp.json, /data/sim_crew.json, /data/manifest.json (contract: ingest/common.py)</span>}
    >
      <p>
        No public time series of real crew wearable data exists, so the crew is simulated and labeled everywhere it
        appears. The environment around them (radiation, space weather, light time to Earth, the standards) is real NASA
        and NOAA data.
      </p>
      <div className="lf-m-srcs">
        <OsdrCard />
        <SimCard />
        <FrozenCard />
      </div>
    </FoldPanel>
  )
}
