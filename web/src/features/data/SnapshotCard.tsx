// One card per frozen snapshot. Everything above the expanders comes from manifest.json (already
// loaded for the whole page), except the entry split of a snapshot whose entries are not all of its
// provenance (hasEntrySplit: DONKI SEP), whose file is read at once to count them. Otherwise the file
// is fetched only when a reader opens its caveats or its access URLs.
import { useEffect, useId, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { formatUtc, parseIsoDuration, snapshotUrl, useSnapshot } from '../../app/data'
import type { ManifestEntry, Snapshot, SnapshotCoverage, SnapshotState } from '../../app/data'
import { ClockIcon, FreshnessChip, Num, SimulatedMarker } from '../../ui'
import { BuildNotes, splitBuildNotes } from './buildNotes'
import { SnapshotDigest } from './digest'
import { Ext } from './Ext'
import { LazyDetails } from './LazyDetails'
import { ProvenanceBadge } from './ProvenanceBadge'
import { Duration } from './Duration'
import { EntrySplitNote } from './EntrySplit'
import { PROVENANCE_WHAT, cardDomId, classifyAccessUrl, dataHref, hasEntrySplit, isProvenance, isSimulated } from './model'
import { citationCount } from './rulesIndex'
import type { RuleCitation } from './rulesIndex'

function Coverage({ c, simulated }: { c: SnapshotCoverage | null | undefined; simulated: boolean }) {
  const range =
    !c?.start && !c?.stop ? (
      <span className="lfd-muted">Not a time series</span>
    ) : (
      <span className="lfd-range">
        <time dateTime={c?.start ?? undefined}>{formatUtc(c?.start)}</time>
        <span aria-hidden="true"> → </span>
        <span className="sr-only"> to </span>
        <time dateTime={c?.stop ?? undefined}>{formatUtc(c?.stop)}</time>
      </span>
    )
  const cad = c?.cadence ?? null
  const cadS = cad ? parseIsoDuration(cad) : Number.NaN
  return (
    <>
      {range}
      {simulated && (c?.start || c?.stop) ? <span className="lfd-sub">fictional mission calendar (see caveats)</span> : null}
      {cad ? (
        <span className="lfd-sub">
          cadence <code>{cad}</code>
          {Number.isFinite(cadS) ? (
            <>
              {' '}
              (one sample every <Duration seconds={cadS} />)
            </>
          ) : null}
        </span>
      ) : c?.start || c?.stop ? (
        <span className="lfd-sub">no fixed cadence</span>
      ) : null}
    </>
  )
}

function StaleRule({ e }: { e: ManifestEntry }) {
  const after = e.freshness?.stale_after ?? null
  const kind = e.freshness?.kind
  const predEnd = kind === 'prediction' && e.coverage?.stop ? e.coverage.stop : null
  if (!after && !predEnd) {
    return (
      <span className="lfd-muted">
        {kind === 'reference'
          ? 'Not on a clock (the source can still publish a new revision)'
          : kind === 'historical'
            ? 'Never: a fixed record does not age'
            : 'No freshness window recorded'}
      </span>
    )
  }
  const s = after ? parseIsoDuration(after) : Number.NaN
  return (
    <span>
      {after ? (
        <>
          <code>{after}</code> after retrieval
          {Number.isFinite(s) ? (
            <>
              {' '}
              (<Duration seconds={s} />)
            </>
          ) : null}
        </>
      ) : null}
      {after && predEnd ? ', or ' : null}
      {predEnd ? (
        <>
          {after ? 'when' : 'When'} the prediction window ends (<time dateTime={predEnd}>{formatUtc(predEnd)}</time>)
        </>
      ) : null}
    </span>
  )
}

function WithSnapshot({ id, snap, children }: { id: string; snap: SnapshotState; children: (s: Snapshot) => ReactNode }) {
  if (snap.status === 'loading') {
    return (
      <p className="lfd-loading" role="status">
        <ClockIcon size={13} /> Reading <code>{id}.json</code> from this build…
      </p>
    )
  }
  if (snap.status !== 'ready' || !snap.snapshot) {
    return (
      <div className="lfd-failed">
        <FreshnessChip status={snap.status} id={id} />
        {snap.error ? <p className="lfd-muted">{snap.error}</p> : null}
      </div>
    )
  }
  return <>{children(snap.snapshot)}</>
}

function AccessLink({ u, onJump }: { u: string; onJump: (id: string) => void }) {
  const a = classifyAccessUrl(u)
  if (a.kind === 'external') {
    return (
      <Ext href={a.href} className="lfd-urltext">
        {a.href}
      </Ext>
    )
  }
  if (a.kind === 'snapshot') {
    return (
      <>
        <a
          href={dataHref(a.id)}
          onClick={(ev: MouseEvent<HTMLAnchorElement>) => {
            ev.preventDefault()
            onJump(a.id)
          }}
          className="lfd-urltext"
        >
          {a.text}
        </a>{' '}
        <span className="lfd-muted">(a frozen snapshot in this build)</span>
      </>
    )
  }
  return <code className="lfd-urltext">{a.text}</code>
}

export function SnapshotCard({
  entry,
  citations,
  targeted,
  onJump,
}: {
  entry: ManifestEntry
  citations: readonly RuleCitation[]
  /** The page was opened with ?id=<this snapshot>: scroll here and open the caveats. */
  targeted: boolean
  onJump: (id: string) => void
}) {
  const titleId = useId()
  const ref = useRef<HTMLLIElement>(null)
  const [cavOpen, setCavOpen] = useState(targeted)
  const [srcOpen, setSrcOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [requested, setRequested] = useState(targeted)
  const [wasTargeted, setWasTargeted] = useState(targeted)
  if (targeted !== wasTargeted) {
    setWasTargeted(targeted)
    if (targeted) {
      setCavOpen(true)
      setRequested(true)
    }
  }

  // Lazy: nothing is fetched until a reader opens an expander (then the shared cache serves it), except
  // for a card that counts its entries (the app's idle prefetch has usually cached that file already).
  const split = hasEntrySplit(entry.id)
  const snap = useSnapshot(requested || split ? entry.id : null)
  const ready = requested && snap.status === 'ready' ? snap.snapshot : null

  useEffect(() => {
    if (!targeted) return
    // After the route's own scroll-to-top has run.
    const t = window.setTimeout(() => {
      ref.current?.scrollIntoView({ block: 'start' })
      ref.current?.focus({ preventScroll: true })
    }, 60)
    return () => window.clearTimeout(t)
  }, [targeted])

  const opener = (set: (o: boolean) => void) => (o: boolean) => {
    set(o)
    if (o) setRequested(true)
  }

  const sim = isSimulated(entry)
  const nCites = citationCount(citations)
  const shortSha = entry.sha256 ? entry.sha256.slice(0, 12) : null

  return (
    <li
      ref={ref}
      id={cardDomId(entry.id)}
      className="lfd-item"
      data-provenance={entry.provenance}
      data-sim={sim || undefined}
      data-targeted={targeted || undefined}
      tabIndex={-1}
    >
      <article className="lf-card lfd-card" aria-labelledby={titleId}>
        {sim ? (
          <SimulatedMarker variant="banner">
            Generated by LANDFALL from a fixed seed: no real person is behind any value. The caveats say which real inputs it
            replays.
          </SimulatedMarker>
        ) : null}
        <header className="lfd-card-head">
          <div className="lfd-badges">
            <ProvenanceBadge kind={entry.provenance} />
            <FreshnessChip meta={entry} status="ready" />
          </div>
          <h3 id={titleId} className="lfd-card-title">
            {entry.title}
          </h3>
          <p className="lfd-card-id">
            <code>{entry.id}</code>
            <span aria-hidden="true"> · </span>
            <span>
              adapter <code>{entry.adapter}</code>
            </span>
          </p>
        </header>

        <p className="lfd-what">{isProvenance(entry.provenance) ? PROVENANCE_WHAT[entry.provenance] : 'Provenance not stated.'}</p>
        {split ? <EntrySplitNote entry={entry} state={snap} /> : null}

        <dl className="lfd-meta">
          <div>
            <dt>Coverage (UTC)</dt>
            <dd>
              <Coverage c={entry.coverage} simulated={sim} />
            </dd>
          </div>
          <div>
            <dt>Goes stale</dt>
            <dd>
              <StaleRule e={entry} />
            </dd>
          </div>
          <div>
            <dt>File</dt>
            <dd>
              <Num value={entry.bytes / 1000} digits={1} unit="kB" />
              {shortSha ? (
                <>
                  <span aria-hidden="true"> · </span>
                  sha256{' '}
                  <code className="lfd-sha" title={entry.sha256}>
                    {shortSha}…
                  </code>
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Cited by rules</dt>
            <dd>
              {nCites ? (
                <>
                  <Num value={nCites} /> {nCites === 1 ? 'entry' : 'entries'} in{' '}
                  {citations.map((c, i) => (
                    <span key={c.file}>
                      {i ? ', ' : null}
                      <code>{c.file}</code>
                    </span>
                  ))}
                </>
              ) : (
                <span className="lfd-muted">none directly</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="lfd-links">
          {entry.url ? (
            <div className="lfd-link">
              <Ext href={entry.url}>{sim ? 'Generator source code' : 'Source landing page'}</Ext>
              <span className="lfd-urltext lfd-muted">{entry.url}</span>
            </div>
          ) : (
            <span className="lfd-muted">No landing page recorded</span>
          )}
          <div className="lfd-link">
            <a href={snapshotUrl(entry.id)} target="_blank" rel="noopener">
              Raw JSON
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <span className="lfd-urltext lfd-muted">/data/{entry.file || `${entry.id}.json`}</span>
          </div>
        </div>

        <LazyDetails
          open={cavOpen}
          onToggle={opener(setCavOpen)}
          summary={
            <>
              Caveats
              {ready ? (
                <>
                  {' '}
                  (<Num value={ready.caveats.length} />)
                </>
              ) : null}
            </>
          }
        >
          <WithSnapshot id={entry.id} snap={snap}>
            {(s) => {
              const { shown, build } = splitBuildNotes(s.caveats)
              return (
                <>
                  <SnapshotDigest snapshot={s} />
                  {s.caveats.length ? (
                    <>
                      <ol className="lfd-caveats">
                        {shown.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ol>
                      <p className="lfd-note">
                        Verbatim from the <code>caveats</code> field of <code>{entry.id}.json</code>
                        {build.length ? '; notes about how the file was built are in the disclosure below' : ''}.
                      </p>
                      <BuildNotes notes={build} />
                    </>
                  ) : (
                    <p className="lfd-muted">This snapshot records no caveats.</p>
                  )}
                </>
              )
            }}
          </WithSnapshot>
        </LazyDetails>

        <LazyDetails
          open={srcOpen}
          onToggle={opener(setSrcOpen)}
          summary={
            <>
              Exact access URLs
              {ready ? (
                <>
                  {' '}
                  (<Num value={ready.source.access_urls.length} />)
                </>
              ) : null}
              , licence, citation
            </>
          }
        >
          <WithSnapshot id={entry.id} snap={snap}>
            {(s) => (
              <div className="lfd-access">
                <h4 className="lfd-h4">Fetched at build, exactly these</h4>
                <ol className="lfd-urls">
                  {s.source.access_urls.map((u, i) => (
                    <li key={i}>
                      <AccessLink u={u} onJump={onJump} />
                    </li>
                  ))}
                </ol>
                <h4 className="lfd-h4">Dataset</h4>
                <p>{s.source.name}</p>
                <h4 className="lfd-h4">Licence or terms, as stated</h4>
                <p>{s.source.license}</p>
                <h4 className="lfd-h4">Citation</h4>
                <p>{s.source.citation}</p>
                <h4 className="lfd-h4">Integrity</h4>
                <p>
                  sha256 of <code>{entry.file}</code> (<Num value={entry.bytes} unit="bytes" />):{' '}
                  <code className="lfd-urltext">{entry.sha256}</code>
                </p>
                <p className="lfd-note">
                  Check it: <code>shasum -a 256 {entry.file}</code> on the raw JSON.
                </p>
              </div>
            )}
          </WithSnapshot>
        </LazyDetails>

        {nCites ? (
          <LazyDetails
            open={rulesOpen}
            onToggle={setRulesOpen}
            summary={
              <>
                Rule entries that cite this file (<Num value={nCites} />)
              </>
            }
          >
            {citations.map((c) => (
              <div key={c.file} className="lfd-cites">
                <h4 className="lfd-h4">
                  <code>engine/rules/{c.file}</code>
                </h4>
                <ul className="lfd-cites-list">
                  {c.owners.map((o) => (
                    <li key={o}>
                      <code>{o}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </LazyDetails>
        ) : null}
      </article>
    </li>
  )
}
