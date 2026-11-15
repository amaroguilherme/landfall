// #/data: every frozen snapshot this build ships, grouped by publisher. The audit trail behind
// every number: who published it, when it was frozen, what it covers, how it ages, its caveats,
// the exact URLs fetched, and the raw file with its sha256.
// Deep links: #/data?id=<snapshot id> opens that card; #/data?group=<publisher slug> jumps to a group.
import { useCallback, useEffect, useMemo } from 'react'
import type { MouseEvent } from 'react'
import type { FeatureProps } from '../../app/router'
import { navigate } from '../../app/location'
import { formatUtc, useManifest } from '../../app/data'
import type { ManifestEntry } from '../../app/data'
import { EmptyState, FreshnessChip, Num } from '../../ui'
import { FreshnessNote } from './FreshnessNote'
import { OfficialResources } from './OfficialResources'
import { ProvenanceBadge } from './ProvenanceBadge'
import { SnapshotCard } from './SnapshotCard'
import { PROVENANCE_ORDER, PROVENANCE_WHAT, cardDomId, computeStats, dataHref, groupByPublisher, isSimulated, joinAnd } from './model'
import { RULE_CITATIONS, RULE_FILE_NAMES } from './rulesIndex'
import './data.css'

function scrollToEl(id: string) {
  // Next task: after any route-level scroll-to-top in the same commit.
  window.setTimeout(() => {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    el.focus({ preventScroll: true })
  }, 0)
}

function FrozenWindow({ first, last }: { first: string | null; last: string | null }) {
  const a = formatUtc(first)
  const b = formatUtc(last)
  const sameDay = a.slice(0, 10) === b.slice(0, 10)
  return (
    <>
      <time dateTime={first ?? undefined}>{a}</time>
      <span aria-hidden="true"> → </span>
      <span className="sr-only"> to </span>
      <time dateTime={last ?? undefined}>{sameDay ? b.slice(11) : b}</time>
    </>
  )
}

function RulesIntegrity({ entries, onJump }: { entries: readonly ManifestEntry[]; onJump: (id: string) => void }) {
  if (!RULE_FILE_NAMES.length) {
    return <p className="lfd-note">The rules files were not bundled in this build, so no rule-to-snapshot check is shown.</p>
  }
  const ids = new Set(entries.map((e) => e.id))
  const cited = [...RULE_CITATIONS.keys()].sort()
  const missing = cited.filter((id) => !ids.has(id))
  return (
    <p className="lfd-p">
      The rules (<code>engine/rules/</code>, <Num value={RULE_FILE_NAMES.length} /> files) cite <Num value={cited.length} />{' '}
      snapshots by id.{' '}
      {missing.length === 0 ? (
        <>
          All <Num value={cited.length} /> are in this build:{' '}
          {cited.map((id, i) => (
            <span key={id}>
              {i ? ', ' : null}
              <a
                href={dataHref(id)}
                onClick={(ev: MouseEvent<HTMLAnchorElement>) => {
                  ev.preventDefault()
                  onJump(id)
                }}
              >
                <code>{id}</code>
              </a>
            </span>
          ))}
          .
        </>
      ) : (
        <>
          <Num value={missing.length} /> {missing.length === 1 ? 'is' : 'are'} not in this build:{' '}
          {missing.map((id) => (
            <FreshnessChip key={id} status="missing" id={id} />
          ))}
        </>
      )}
    </p>
  )
}

export default function DataSources({ query }: FeatureProps) {
  const m = useManifest()
  const entries = m.entries
  const groups = useMemo(() => groupByPublisher(entries), [entries])
  const stats = useMemo(() => computeStats(entries), [entries])
  const target = query.id ?? null
  const groupTarget = query.group ?? null

  const jump = useCallback((id: string) => {
    navigate(`/data?id=${encodeURIComponent(id)}`, { replace: true })
    scrollToEl(cardDomId(id))
  }, [])
  const jumpGroup = useCallback((slug: string) => {
    navigate(`/data?group=${encodeURIComponent(slug)}`, { replace: true })
    scrollToEl(slug)
  }, [])

  useEffect(() => {
    if (!groupTarget || m.status !== 'ready') return
    const t = window.setTimeout(() => document.getElementById(groupTarget)?.scrollIntoView({ block: 'start' }), 60)
    return () => window.clearTimeout(t)
  }, [groupTarget, m.status])

  const sims = entries.filter(isSimulated)
  const real = stats.count - sims.length
  // Of the non-simulated snapshots, the ones LANDFALL computed from published inputs (provenance "derived")
  // are not "frozen as retrieved": the split is read from the manifest, never typed.
  const derived = entries.filter((e) => !isSimulated(e) && e.provenance === 'derived')
  const asRetrieved = real - derived.length
  const snapLink = (e: ManifestEntry, i: number) => (
    <span key={e.id}>
      {i ? ', ' : null}
      <a
        href={dataHref(e.id)}
        onClick={(ev: MouseEvent<HTMLAnchorElement>) => {
          ev.preventDefault()
          jump(e.id)
        }}
      >
        <code>{e.id}</code>
      </a>
    </span>
  )

  const head = (
    <header className="lfd-head">
      <p className="lf-eyebrow">Audit trail</p>
      <h1>Data sources</h1>
      <p className="lfd-lede">
        Every dataset this build uses, frozen at build time. The app never calls these services at runtime — a spacecraft
        in solar conjunction has no cloud.
      </p>
      <p className="lfd-p lfd-muted">
        Each card gives the publisher, when the file was frozen, what it covers, how it ages, its caveats word for word, the
        exact URLs fetched, and the raw JSON with its sha256, so any number in LANDFALL can be traced back to its source.
      </p>
    </header>
  )

  if (m.status === 'loading') {
    return (
      <div className="lfd-page">
        {head}
        <EmptyState kind="loading" title="Reading manifest.json">
          <p>Loading the list of frozen snapshots from this build.</p>
        </EmptyState>
      </div>
    )
  }
  if (m.status !== 'ready') {
    return (
      <div className="lfd-page">
        {head}
        <EmptyState kind={m.status === 'missing' ? 'missing' : 'error'} title="The snapshot list could not be read">
          <p>
            <code>/data/manifest.json</code>: {m.error ?? 'unknown error'}
          </p>
        </EmptyState>
      </div>
    )
  }
  if (!entries.length) {
    return (
      <div className="lfd-page">
        {head}
        <EmptyState kind="missing" title="No snapshots in this build">
          <p>
            <code>/data/manifest.json</code> lists no snapshots.
          </p>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="lfd-page">
      {head}

      <section className="lfd-summary lf-panel" aria-labelledby="lfd-sum-h">
        <div className="lf-panel-head">
          <div>
            <p className="lf-eyebrow">From manifest.json</p>
            <h2 id="lfd-sum-h" className="lf-panel-title">
              What this build ships
            </h2>
          </div>
        </div>
        <div className="lf-panel-body lfd-sum-body">
          <dl className="lfd-totals">
            <div>
              <dt>Snapshots</dt>
              <dd>
                <Num value={stats.count} />
              </dd>
            </div>
            <div>
              <dt>Publishers</dt>
              <dd>
                <Num value={groups.length} />
              </dd>
            </div>
            <div>
              <dt>Total size</dt>
              <dd>
                <Num value={stats.bytes / 1e6} digits={2} unit="MB" />
              </dd>
            </div>
            <div>
              <dt>Frozen (UTC)</dt>
              <dd>
                <FrozenWindow first={stats.firstRetrieved} last={stats.lastRetrieved} />
              </dd>
            </div>
          </dl>

          <div className="lfd-sum-cols">
            <div>
              <h3 className="lfd-h3">By provenance</h3>
              <ul className="lfd-provlist">
                {PROVENANCE_ORDER.map((p) => (
                  <li key={p}>
                    <span className="lfd-provlist-badge">
                      <ProvenanceBadge kind={p} />
                    </span>
                    <Num className="lfd-count" value={stats.byProvenance[p].length} />
                    <span className="lfd-provlist-what">{PROVENANCE_WHAT[p]}</span>
                  </li>
                ))}
              </ul>
              <p className="lfd-simline">
                <Num value={sims.length} /> simulated {sims.length === 1 ? 'snapshot' : 'snapshots'}
                {sims.length ? (
                  <>
                    {' '}
                    (
                    {sims.map(snapLink)}
                    ), generated by LANDFALL for the demo crew.
                  </>
                ) : (
                  '.'
                )}{' '}
                The other <Num value={real} /> come from {joinAnd(stats.realAgencies)} publications
                {derived.length ? (
                  <>
                    : <Num value={asRetrieved} /> frozen as retrieved, and <Num value={derived.length} /> computed by LANDFALL from them (
                    {derived.map(snapLink)}
                    ); each card&apos;s caveats say what LANDFALL computed on top.
                  </>
                ) : (
                  <>, frozen as retrieved; each card&apos;s caveats say what LANDFALL computed on top.</>
                )}
              </p>
            </div>
            <div>
              <h3 className="lfd-h3">By publisher</h3>
              <ol className="lfd-publist">
                {groups.map((g) => (
                  <li key={g.slug}>
                    <a
                      href={`#/data?group=${encodeURIComponent(g.slug)}`}
                      onClick={(ev: MouseEvent<HTMLAnchorElement>) => {
                        ev.preventDefault()
                        jumpGroup(g.slug)
                      }}
                    >
                      {g.publisher}
                    </a>
                    <Num className="lfd-count" value={g.entries.length} />
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <FreshnessNote stale={stats.stale} total={stats.count} onJump={jump} />
          <RulesIntegrity entries={entries} onJump={jump} />
        </div>
      </section>

      <OfficialResources entries={entries} onJump={jump} />

      <div className="lfd-groups">
        {groups.map((g) => (
          <section key={g.slug} id={g.slug} className="lfd-group" aria-labelledby={`${g.slug}-h`} tabIndex={-1}>
            <header className="lfd-group-head">
              <p className="lf-eyebrow">Publisher</p>
              <h2 id={`${g.slug}-h`} className="lfd-group-title">
                {g.publisher}
              </h2>
              <span className="lfd-group-count">
                <Num value={g.entries.length} /> {g.entries.length === 1 ? 'snapshot' : 'snapshots'}
              </span>
            </header>
            <ul className="lfd-grid">
              {g.entries.map((e) => (
                <SnapshotCard
                  key={e.id}
                  entry={e}
                  citations={RULE_CITATIONS.get(e.id) ?? []}
                  targeted={e.id === target}
                  onJump={jump}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
