// Why some cards read STALE, with the NASA text behind it loaded verbatim on request.
import { useState } from 'react'
import type { MouseEvent } from 'react'
import { parseIsoDuration, useSnapshot } from '../../app/data'
import type { ManifestEntry } from '../../app/data'
import { ClockIcon, FreshnessChip, Num, ReqId } from '../../ui'
import { LazyDetails } from './LazyDetails'
import { Duration } from './Duration'
import { FRESHNESS_KIND_WORD, dataHref } from './model'

interface Vol2Requirement {
  id: string
  title?: string
  section?: string
  text?: string
  pdf_page?: number
}

interface Vol2Data {
  document?: { revision?: string; approved?: string }
  requirements?: Vol2Requirement[]
  appendix_f_colors?: {
    table_f_5_1?: { caption?: string; pdf_page?: number; rows?: { meaning: string; color: string }[] }
    clauses?: { clause: string; text: string }[]
  }
}

const VOL2 = 'std_vol2_requirements'

function Vol2Quotes() {
  const s = useSnapshot<Vol2Data>(VOL2)
  if (s.status === 'loading') {
    return (
      <p className="lfd-loading" role="status">
        <ClockIcon size={13} /> Reading <code>{VOL2}.json</code> from this build…
      </p>
    )
  }
  if (s.status !== 'ready' || !s.data) return <FreshnessChip status={s.status} id={VOL2} />
  const d = s.data
  const req = d.requirements?.find((r) => r.id === '[V2 10020]')
  const table = d.appendix_f_colors?.table_f_5_1
  const cyan = table?.rows?.find((r) => /cyan/i.test(r.color))
  const staleClause = d.appendix_f_colors?.clauses?.find((c) => c.clause === 'F.4.3.1 c')
  return (
    <div className="lfd-quotes">
      {req ? (
        <blockquote className="lfd-quote">
          <p>
            <ReqId id={req.id} /> <strong>{req.title}</strong>
          </p>
          <p>“{req.text}”</p>
          <footer>
            Section <span className="lf-num">{req.section}</span>
            {req.pdf_page ? (
              <>
                , PDF page <Num value={req.pdf_page} />
              </>
            ) : null}
          </footer>
        </blockquote>
      ) : (
        <p className="lfd-muted">[V2 10020] was not found in {VOL2}.json.</p>
      )}
      {table && cyan ? (
        <blockquote className="lfd-quote">
          <p>
            <strong>{table.caption}</strong>
          </p>
          <p>
            “{cyan.meaning}”: <strong>{cyan.color}</strong>
          </p>
          {table.pdf_page ? (
            <footer>
              Appendix F, PDF page <Num value={table.pdf_page} />
            </footer>
          ) : null}
        </blockquote>
      ) : null}
      {staleClause ? (
        <blockquote className="lfd-quote">
          <p>
            <strong>Appendix F, {staleClause.clause}</strong>
          </p>
          <p>“{staleClause.text}”</p>
        </blockquote>
      ) : null}
      <p className="lfd-note">
        Quoted from <code>{VOL2}.json</code>: NASA-STD-3001 Volume 2, Revision {d.document?.revision ?? '?'}
        {d.document?.approved ? (
          <>
            , approved <time dateTime={d.document.approved}>{d.document.approved}</time>
          </>
        ) : null}
        .
      </p>
    </div>
  )
}

export function FreshnessNote({ stale, total, onJump }: { stale: readonly ManifestEntry[]; total: number; onJump: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="lfd-freshnote">
      {stale.length ? (
        <p className="lfd-p">
          <strong>Past its freshness window now:</strong> <Num value={stale.length} /> of <Num value={total} />{' '}
          {total === 1 ? 'snapshot' : 'snapshots'} (
          {stale.map((e, i) => {
            const s = e.freshness?.stale_after ? parseIsoDuration(e.freshness.stale_after) : Number.NaN
            const kind = e.freshness?.kind
            return (
              <span key={e.id}>
                {i ? '; ' : null}
                <a
                  href={dataHref(e.id)}
                  onClick={(ev: MouseEvent<HTMLAnchorElement>) => {
                    ev.preventDefault()
                    onJump(e.id)
                  }}
                >
                  <code>{e.id}</code>
                </a>
                : {kind ? (FRESHNESS_KIND_WORD[kind] ?? kind) : 'kind not stated'}
                {Number.isFinite(s) ? (
                  <>
                    , stale after <Duration seconds={s} />
                  </>
                ) : null}
              </span>
            )
          })}
          ).
        </p>
      ) : (
        <p className="lfd-p">
          <strong>Past its freshness window now:</strong> none.
        </p>
      )}
      <p className="lfd-p">
        Live feeds and predictions are frozen at build like everything else. LANDFALL measures their age against your clock
        and never hides it, so weeks after the build they read{' '}
        {stale.length ? <FreshnessChip meta={stale[0]} status="ready" compact /> : <strong>STALE</strong>} in cyan instead
        of passing for current data.
      </p>
      <LazyDetails open={open} onToggle={setOpen} summary="The NASA-STD-3001 text behind the cyan STALE state (verbatim)">
        <Vol2Quotes />
      </LazyDetails>
    </div>
  )
}
