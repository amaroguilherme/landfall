// The challenge's official resources and the snapshot that freezes each one (ingest/hrp.py).
import type { MouseEvent } from 'react'
import type { ManifestEntry } from '../../app/data'
import { FreshnessChip, Num, Panel } from '../../ui'
import { Ext } from './Ext'
import { CHALLENGE_URL, OFFICIAL_RESOURCES, dataHref, sameUrl } from './model'

export function OfficialResources({ entries, onJump }: { entries: readonly ManifestEntry[]; onJump: (id: string) => void }) {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const official = new Set(OFFICIAL_RESOURCES.map((r) => r.snapshot))
  const covered = OFFICIAL_RESOURCES.filter((r) => byId.has(r.snapshot)).length
  const extras = entries.filter((e) => e.adapter === 'hrp' && !official.has(e.id))
  const jump = (id: string) => (ev: MouseEvent<HTMLAnchorElement>) => {
    ev.preventDefault()
    onJump(id)
  }
  return (
    <Panel
      title="Official challenge resources"
      eyebrow="From the challenge brief"
      footer={
        <span>
          Challenge: <Ext href={CHALLENGE_URL}>Create Health Monitoring Software for Astronauts on Space Missions</Ext>. The
          same list is in <code>CITATIONS.md</code>.
        </span>
      }
    >
      <p className="lfd-p">
        The challenge names <Num value={OFFICIAL_RESOURCES.length} /> official resources. Each one is frozen as its own
        snapshot by the <code>hrp</code> adapter: <Num value={covered} /> of <Num value={OFFICIAL_RESOURCES.length} /> are in
        this build.
      </p>
      <ol className="lfd-official">
        {OFFICIAL_RESOURCES.map((r) => {
          const e = byId.get(r.snapshot)
          return (
            <li key={r.snapshot}>
              <div className="lfd-off-res">
                <Ext href={r.url}>{r.label}</Ext>
              </div>
              <div className="lfd-off-snap">
                {e ? (
                  <>
                    <a href={dataHref(e.id)} onClick={jump(e.id)} className="lfd-off-id">
                      <code>{e.id}</code>
                    </a>
                    <span className="lfd-off-title">{e.title}</span>
                    <span className="lfd-muted lfd-off-check">
                      {sameUrl(e.url, r.url) ? (
                        'Snapshot landing URL is the official link.'
                      ) : (
                        <>
                          Snapshot landing URL differs: <code className="lfd-urltext">{e.url}</code>
                        </>
                      )}
                    </span>
                  </>
                ) : (
                  <code>{r.snapshot}</code>
                )}
              </div>
              <div className="lfd-off-fresh">
                {e ? <FreshnessChip meta={e} status="ready" compact /> : <FreshnessChip status="missing" id={r.snapshot} />}
              </div>
            </li>
          )
        })}
      </ol>
      {extras.length ? (
        <p className="lfd-note">
          Also frozen by the same adapter, but not one of the official resources:{' '}
          {extras.map((e, i) => (
            <span key={e.id}>
              {i ? '; ' : null}
              <a href={dataHref(e.id)} onClick={jump(e.id)}>
                <code>{e.id}</code>
              </a>{' '}
              ({e.title})
            </span>
          ))}
          .
        </p>
      ) : null}
    </Panel>
  )
}
