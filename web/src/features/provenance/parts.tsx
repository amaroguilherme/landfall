// Building blocks for the provenance page: cells, verbatim blocks, checks.
import { createContext, Fragment, useContext } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotState } from '../../app/data'
import { CATEGORIES } from '../../app/vocab'
import type { Category, Severity } from '../../app/vocab'
import { CategoryBadge, Chip, Citation, FreshnessChip, Num, ReqId, SeverityIcon, UnknownIcon, ExternalIcon } from '../../ui'
import { CASES, META, OP_SYMBOL, ROWS, envShort } from './model'
import type { Condition, ProvRow, Ref, RowValue, RuleSource } from './model'
import { matchVerbatim, normReqId, pdfAt, volOf } from './snapshots'
import type { MatchResult, NoaaIndex, VolIndex } from './snapshots'

// ---- snapshot context ------------------------------------------------------------------------

export interface Snaps {
  v1: SnapshotState
  v2: SnapshotState
  noaa: SnapshotState
  idx1: VolIndex | null
  idx2: VolIndex | null
  noaaIdx: NoaaIndex | null
}

export const SnapsContext = createContext<Snaps | null>(null)

export function useSnaps(): Snaps {
  const s = useContext(SnapsContext)
  if (!s) throw new Error('SnapsContext missing')
  return s
}

// ---- small text helpers -----------------------------------------------------------------------

/** Wrap every number in running text in the fixed-width font (F.5.1 d). */
export function Prose({ text, mark }: { text: string; mark?: string | null }) {
  const segments: { s: string; marked: boolean }[] = []
  const i = mark ? text.indexOf(mark) : -1
  if (mark && i >= 0) {
    segments.push({ s: text.slice(0, i), marked: false }, { s: mark, marked: true }, { s: text.slice(i + mark.length), marked: false })
  } else {
    segments.push({ s: text, marked: false })
  }
  const mono = (s: string, key: string) =>
    // Standalone numbers only: the "2" in ppCO2 or the "4" in L1-L4 stays in the text face.
    s.split(/((?<![A-Za-z\d])\d[\d,]*(?:\.\d+)?)/g).map((part, j) =>
      j % 2 === 1 ? (
        <span key={`${key}-${j}`} className="lf-mono">
          {part}
        </span>
      ) : (
        <Fragment key={`${key}-${j}`}>{part}</Fragment>
      ),
    )
  return (
    <>
      {segments.map((seg, k) =>
        seg.marked ? (
          <mark key={k} className="prov-mark">
            {mono(seg.s, `m${k}`)}
          </mark>
        ) : (
          <Fragment key={k}>{mono(seg.s, `t${k}`)}</Fragment>
        ),
      )}
    </>
  )
}

/** "Lang T et al. 2004" from a full citation string. */
export function shortCitation(citation: string): string {
  const authors = citation.split('. ')[0]
  const first = authors.split(',')[0].trim()
  const year = /\b(19|20)\d{2}\b/.exec(citation)?.[0]
  const etAl = authors.includes(',') ? ' et al.' : ''
  return `${first}${etAl}${year ? ` ${year}` : ''}`
}

export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="lf-ext">
      {children}
      <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function CheckGlyph() {
  return (
    <svg className="lf-icon" width={13} height={13} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CrossGlyph() {
  return (
    <svg className="lf-icon" width={13} height={13} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}

/** One audit check: icon + text, never colour alone. `ok: null` = could not be checked (cyan). */
export function CheckLine({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <li className="prov-check" data-ok={ok === null ? 'unknown' : String(ok)}>
      {ok === null ? <UnknownIcon size={13} /> : ok ? <CheckGlyph /> : <CrossGlyph />}
      <span className="prov-check-word">{ok === null ? 'Not checked' : ok ? 'Checked' : 'Mismatch'}</span>
      <span>{children}</span>
    </li>
  )
}

/** Honest "not found in snapshot" state (cyan, [V2 10020]). */
export function NotInSnapshot({ children }: { children: ReactNode }) {
  return (
    <div className="prov-notfound" role="note">
      <span className="lf-dq" data-tone="stale">
        <UnknownIcon size={14} />
        <span>Not found in snapshot</span>
      </span>
      <p>{children}</p>
    </div>
  )
}

// ---- category tag (the shell badge covers FFD/PEL/POL/OPS/PERSONAL; TARGET is drawn here) ----

function TargetGlyph() {
  return (
    <svg className="lf-icon" width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    </svg>
  )
}

export function CategoryTag({ category }: { category: string }) {
  if ((CATEGORIES as readonly string[]).includes(category)) return <CategoryBadge category={category as Category} />
  const meta = META?.categories.find((c) => c.id === category)
  const help = meta ? `${meta.name}: ${meta.shape}` : category
  return (
    <span className="lf-cat prov-cat-extra" data-category={category} title={help}>
      {category === 'TARGET' ? <TargetGlyph /> : null}
      <span className="lf-cat-code">{category}</span>
      <span className="sr-only">, {help}</span>
    </span>
  )
}

export function Categories({ list }: { list: string[] }) {
  if (!list.length)
    return (
      <span className="prov-none">
        —<span className="sr-only">no category (not a limit)</span>
      </span>
    )
  return (
    <span className="prov-cats">
      {list.map((c) => (
        <CategoryTag key={c} category={c} />
      ))}
    </span>
  )
}

// ---- cells ------------------------------------------------------------------------------------

function SevWord({ severity }: { severity: string }) {
  // Neutral on purpose: nothing is firing on this page, so the mapping target is shape + word only.
  return (
    <span className="prov-sevword">
      <SeverityIcon severity={severity as Severity} size={12} />
      {severity}
    </span>
  )
}

export function ValueCell({ value }: { value: RowValue }) {
  switch (value.kind) {
    case 'number':
      return <Num value={value.value} unit={value.unit ?? undefined} />
    case 'range':
      return (
        <span className="prov-range">
          <Num value={value.min} />
          <span aria-hidden="true">–</span>
          <span className="sr-only"> to </span>
          <Num value={value.max} unit={value.unit ?? undefined} />
          {value.mean !== undefined ? (
            <span className="prov-sub">
              mean <Num value={value.mean} unit={value.unit ?? undefined} />
            </span>
          ) : null}
        </span>
      )
    case 'snapshot':
      return (
        <span className="prov-snapval">
          per time step from <code>{value.snapshot}</code>
        </span>
      )
    case 'tripwire':
      return (
        <span className="prov-trip">
          <span className="lf-mono">{OP_SYMBOL[value.op]}</span> <Num value={value.value} unit={value.unit ?? undefined} />{' '}
          <span className="prov-sub">
            on <Num value={value.at_least} /> of the last <Num value={value.of_last_n} />
          </span>{' '}
          <span className="prov-sub">
            reassess after <Num value={value.reassess_after_s} unit="s" /> (<Num value={value.reassess_after_s / 3600} unit="h" digits={0} />)
          </span>
        </span>
      )
    case 'mapping':
      return value.severity ? (
        <span>
          <span aria-hidden="true">→ </span>
          <SevWord severity={value.severity} />
        </span>
      ) : value.severity_max ? (
        <span>
          at most <SevWord severity={value.severity_max} />
        </span>
      ) : (
        <span className="prov-none">—</span>
      )
  }
}

/** One-line value for compact lists (design-choice pills). */
export function ValueInline({ value, of }: { value: RowValue; of?: RowValue | null }) {
  if (value.kind === 'tripwire') {
    return (
      <span className="prov-inl">
        <span className="lf-mono">{OP_SYMBOL[value.op]}</span> <Num value={value.value} unit={value.unit ?? undefined} />
        <span className="prov-inl-sep">·</span>
        <Num value={value.at_least} /> of <Num value={value.of_last_n} />
        <span className="prov-inl-sep">·</span>
        <Num value={value.reassess_after_s / 3600} unit="h" digits={0} />
      </span>
    )
  }
  if (value.kind === 'number' && of?.kind === 'number') {
    return (
      <span className="prov-inl">
        <Num value={value.value} /> of <Num value={of.value} unit={of.unit ?? undefined} />
      </span>
    )
  }
  return <ValueCell value={value} />
}

export function ConditionCell({ condition }: { condition: Condition | null }) {
  if (!condition)
    return (
      <span className="prov-none">
        —<span className="sr-only">no comparison</span>
      </span>
    )
  if (condition.kind === 'text') return <span className="prov-condtext">{condition.text}</span>
  return (
    <span className="prov-cond">
      <span className="prov-cond-lead">{condition.lead}</span> <span className="lf-mono">{OP_SYMBOL[condition.op]}</span>{' '}
      <Num value={condition.value} unit={condition.unit ?? undefined} />
    </span>
  )
}

export function SourceCell({ source }: { source: RuleSource | null }) {
  if (!source) return <span className="prov-none">—</span>
  switch (source.kind) {
    case 'nasa_standard': {
      const where = source.requirement_id ? (
        <ReqId id={source.requirement_id} />
      ) : source.table ? (
        <span className="lf-req">
          {source.table}
          {source.row ? ` · ${source.row}` : ''}
          {source.column ? ` · ${source.column.replace(/_/g, '-')}` : ''}
        </span>
      ) : null
      return (
        <span className="prov-src">
          {where}
          <span className="prov-sub">
            {source.doc}
            {source.section ? <> · §<span className="lf-mono">{source.section}</span></> : null}
            {source.page ? (
              <>
                {' · '}
                <ExtLink href={pdfAt(source.url, source.page)}>
                  p. <span className="lf-mono">{source.page}</span>
                </ExtLink>
              </>
            ) : null}
          </span>
        </span>
      )
    }
    case 'noaa':
      return (
        <span className="prov-src">
          <span>
            {source.level ? <span className="lf-req">{source.level}</span> : null} <ExtLink href={source.url}>NOAA scales</ExtLink>
          </span>
          <span className="prov-sub">{source.doc}</span>
        </span>
      )
    case 'nasa_brief':
      return (
        <span className="prov-src">
          <ExtLink href={source.url}>{source.doc}</ExtLink>
        </span>
      )
    case 'literature':
      return (
        <span className="prov-src">
          <ExtLink href={source.url}>{shortCitation(source.citation ?? '')}</ExtLink>
          {source.page ? (
            <span className="prov-sub">
              p. <span className="lf-mono">{source.page}</span>
            </span>
          ) : null}
        </span>
      )
    case 'derived':
      return (
        <span className="prov-src">
          <span>Arithmetic on</span>
          <span className="prov-sub">
            {(source.from ?? []).map((f, i) => (
              <Fragment key={f}>
                {i ? ', ' : ''}
                <RowLink id={f} />
              </Fragment>
            ))}
            {source.snapshot ? (
              <>
                {source.from?.length ? ' + ' : ''}
                <code>{source.snapshot}</code>
              </>
            ) : null}
          </span>
        </span>
      )
    case 'design_choice':
      return (
        <span className="prov-src">
          <span>LANDFALL (ours)</span>
          <span className="prov-sub">no published basis</span>
        </span>
      )
    default:
      return <span className="prov-src">{source.kind}</span>
  }
}

/** In-page link to a row id (deep link); plain code if the id is not a row. */
export function RowLink({ id }: { id: string }) {
  const exists = ROWS.some((r) => r.id === id || r.aliases.includes(id))
  if (!exists && CASES?.cases.some((c) => c.id === id)) {
    return (
      <a href={`#/case/${encodeURIComponent(id)}`} className="prov-rowlink" title="Open this case">
        <code>{id}</code>
      </a>
    )
  }
  if (!exists) return <code>{id}</code>
  return (
    <a href={`#/provenance?id=${encodeURIComponent(id)}`} className="prov-rowlink">
      <code>{id}</code>
    </a>
  )
}

export function AppliesCell({ row }: { row: ProvRow }) {
  if (!row.appliesTo)
    return (
      <span className="prov-none">
        —<span className="sr-only">not environment-specific</span>
        {row.appliesNote ? <span className="prov-sub">{row.appliesNote}</span> : null}
      </span>
    )
  const all = row.appliesTo.includes('*')
  return (
    <span className="prov-applies">
      <span>{all ? 'all environments' : row.appliesTo.map(envShort).join(', ')}</span>
      {row.appliesNote ? <span className="prov-sub">{row.appliesNote}</span> : null}
    </span>
  )
}

/** "Used by": refs merged by target (one entry per case / rule, roles joined). */
export function UsedByCell({ refs, row }: { refs: Ref[]; row?: ProvRow }) {
  if (!refs.length) {
    // No back-reference does not mean "context": a Tier A alert rule with no case is still evaluated
    // directly against its variable. Only role "context" rules never fire (SPEC 3.2).
    const [main, sub] =
      row?.kind === 'limit' && row.role !== 'context'
        ? ['evaluated directly', 'alert rule; no case or other entry points to it']
        : row?.kind === 'limit'
          ? ['shown, never fires', 'context rule']
          : ['not referenced by another entry', 'reference value']
    return (
      <span className="prov-none">
        {main}
        <span className="prov-sub">{sub}</span>
      </span>
    )
  }
  const merged = new Map<string, { ref: Ref; roles: string[] }>()
  for (const r of refs) {
    const m = merged.get(r.id)
    if (m) {
      if (!m.roles.includes(r.role)) m.roles.push(r.role)
    } else merged.set(r.id, { ref: r, roles: [r.role] })
  }
  return (
    <ul className="prov-usedby">
      {[...merged.values()].map(({ ref, roles }) => (
        <li key={ref.id}>
          <span className="prov-role">{roles.join(', ')}</span> {ref.href ? <a href={ref.href}>{ref.label}</a> : <span>{ref.label}</span>}
        </li>
      ))}
    </ul>
  )
}

// ---- NASA verbatim block ----------------------------------------------------------------------

function snapLabel(vol: 1 | 2): string {
  return vol === 1 ? 'std_vol1_requirements' : 'std_vol2_requirements'
}

/** Doc line: revision, date, PDF page link, sha256 of the PDF, freshness of the snapshot. */
export function DocLine({ idx, page, state }: { idx: VolIndex; page: number | number[] | null; state: SnapshotState }) {
  return (
    <div className="prov-docline">
      <span>
        NASA-STD-3001 Vol <span className="lf-mono">{idx.doc.vol}</span> Revision <span className="lf-mono">{idx.doc.revision ?? '?'}</span>
        {idx.doc.date ? (
          <>
            , approved <time dateTime={idx.doc.date}>{idx.doc.date}</time>
          </>
        ) : null}
      </span>
      {idx.doc.pdfUrl ? (
        <ExtLink href={pdfAt(idx.doc.pdfUrl, page)}>
          PDF{page ? (
            <>
              {' '}
              page <span className="lf-mono">{Array.isArray(page) ? page.join('–') : page}</span>
            </>
          ) : null}
        </ExtLink>
      ) : null}
      {idx.doc.sha256 ? (
        <span className="prov-sha">
          PDF SHA-256 <code>{idx.doc.sha256}</code>
        </span>
      ) : null}
      <FreshnessChip meta={state.snapshot} status={state.status} id={snapLabel(idx.doc.vol)} compact />
    </div>
  )
}

function footnotesFor(notes: string[], marks: string[]): string[] {
  return notes.filter((n) => {
    const m = /^([*#†]+)/.exec(n)?.[1]
    return !!m && marks.includes(m.replace(/\s/g, ''))
  })
}

/** Verbatim requirement / table text for a nasa_standard source, with build-time checks. */
export function NasaVerbatim({ source, row }: { source: RuleSource; row: ProvRow | null }) {
  const snaps = useSnaps()
  const vol = volOf(source)
  if (!vol) return <NotInSnapshot>The rules name no NASA-STD-3001 volume for this source, so there is no snapshot to look in.</NotInSnapshot>
  const state = vol === 1 ? snaps.v1 : snaps.v2
  const idx = vol === 1 ? snaps.idx1 : snaps.idx2
  if (state.status === 'loading') return <p className="prov-loading">Reading the frozen {snapLabel(vol)} snapshot…</p>
  if (!idx) {
    return (
      <div className="prov-notfound" role="note">
        <FreshnessChip meta={null} status={state.status === 'ready' ? 'error' : state.status} id={snapLabel(vol)} />
        <p>The verbatim text cannot be shown because the snapshot is not readable in this build ({state.error ?? 'no detail'}).</p>
      </div>
    )
  }

  const reqId = source.requirement_id ? normReqId(source.requirement_id) : null
  const rec = reqId ? idx.reqs.get(reqId) ?? null : null
  const table = source.table ? idx.tables.get(source.table) ?? null : null
  // Table row: by label (Vol 1 rows are keyed by organ) or by the cell that holds the verbatim text.
  const tRow = table
    ? table.rows.find((r) => source.row && r.label === source.row) ??
      table.rows.find((r) => Object.values(r.cells).some((c) => source.verbatim && c.text.includes(source.verbatim))) ??
      null
    : null
  const cell = tRow && source.column ? tRow.cells[source.column] ?? null : null

  const haystacks = [rec?.text, rec?.rationale, rec?.note, ...(tRow ? Object.values(tRow.cells).map((c) => c.text) : []), ...(table?.notes ?? [])]
  const match: MatchResult | null = matchVerbatim(source.verbatim, haystacks)
  const limit = row && row.value.kind === 'number' ? row.value.value : null
  const parsed = [...(rec?.values ?? []).map((v) => ({ value: v.value, unit: v.unit })), ...(cell && cell.value !== null ? [{ value: cell.value, unit: cell.unit ?? '' }] : [])]
  const numberOk = limit !== null && parsed.length ? parsed.some((p) => p.value === limit) : null
  const snapPage = table ? table.page : rec?.page ?? null
  const pageOk = source.page && snapPage !== null ? (Array.isArray(snapPage) ? snapPage.includes(source.page) : snapPage === source.page) : null
  const revOk = idx.doc.revision && source.doc ? new RegExp(`Rev\\.? ?${idx.doc.revision}\\b`).test(source.doc) : null

  return (
    <div className="prov-verbatim">
      {reqId && !rec ? (
        <NotInSnapshot>
          <ReqId id={reqId} /> is cited by the rules but is not in the frozen <code>{snapLabel(vol)}</code> snapshot, so its verbatim text cannot be
          shown here. Check it in the PDF.
        </NotInSnapshot>
      ) : null}
      {rec ? (
        <figure className="prov-quote">
          <figcaption>
            <ReqId id={rec.id} /> {rec.section ? <>§<span className="lf-mono">{rec.section}</span> </> : null}
            {rec.title}
            <span className="prov-sub">Requirement text, verbatim from the PDF{rec.verified ? ' (the ingest re-checked it on its page)' : ''}</span>
          </figcaption>
          <blockquote>
            <Prose text={rec.text} mark={source.verbatim && rec.text.includes(source.verbatim) ? source.verbatim : null} />
          </blockquote>
          {rec.note ? (
            <blockquote className="prov-quote-note">
              <Prose text={rec.note} mark={source.verbatim && rec.note.includes(source.verbatim) ? source.verbatim : null} />
            </blockquote>
          ) : null}
          {rec.rationale ? (
            <details className="prov-rationale" open={!!(source.verbatim && rec.rationale.includes(source.verbatim) && !rec.text.includes(source.verbatim))}>
              <summary>Rationale (verbatim)</summary>
              <blockquote>
                <Prose text={rec.rationale} mark={source.verbatim && rec.rationale.includes(source.verbatim) ? source.verbatim : null} />
              </blockquote>
            </details>
          ) : null}
        </figure>
      ) : null}
      {source.table && !table ? (
        <NotInSnapshot>
          {source.table} is cited by the rules but is not in the frozen <code>{snapLabel(vol)}</code> snapshot.
        </NotInSnapshot>
      ) : null}
      {table ? (
        <figure className="prov-quote">
          <figcaption>
            {table.caption}
            <span className="prov-sub">Table cell, verbatim from the PDF</span>
          </figcaption>
          {tRow ? (
            <dl className="prov-cell">
              <dt>Row</dt>
              <dd>{tRow.label}</dd>
              {cell ? (
                <>
                  <dt>Column</dt>
                  <dd>{source.column?.replace(/_/g, '-')}</dd>
                  <dt>Cell</dt>
                  <dd>
                    <mark className="prov-mark lf-mono">{cell.text}</mark>
                  </dd>
                </>
              ) : (
                Object.entries(tRow.cells).map(([col, c]) => (
                  <Fragment key={col}>
                    <dt>{col}</dt>
                    <dd>
                      <Prose text={c.text} mark={source.verbatim && c.text.includes(source.verbatim) ? source.verbatim : null} />
                    </dd>
                  </Fragment>
                ))
              )}
            </dl>
          ) : (
            <NotInSnapshot>No row of {table.id} holds the cited text.</NotInSnapshot>
          )}
          {tRow && (tRow.marks.length ? footnotesFor(table.notes, tRow.marks) : table.notes).length ? (
            <ul className="prov-footnotes">
              {(tRow.marks.length ? footnotesFor(table.notes, tRow.marks) : table.notes).map((n) => (
                <li key={n}>
                  <Prose text={n} />
                </li>
              ))}
            </ul>
          ) : null}
        </figure>
      ) : null}
      <ul className="prov-checks" aria-label="Build-time checks against the snapshot">
        {source.verbatim ? (
          <CheckLine ok={match === 'absent' ? false : match === null ? null : true}>
            Cited fragment “<span className="prov-frag">{source.verbatim}</span>”{' '}
            {match === 'exact' ? 'appears verbatim in the snapshot text' : match === 'normalised' ? 'appears after whitespace and case normalisation' : 'does not appear in the snapshot text'}
          </CheckLine>
        ) : null}
        {numberOk !== null && limit !== null ? (
          <CheckLine ok={numberOk}>
            Rules value <Num value={limit} unit={row?.value.kind === 'number' ? row.value.unit ?? undefined : undefined} />{' '}
            {numberOk ? 'equals' : 'differs from'} the number parsed from the PDF (
            {parsed.map((p, i) => (
              <Fragment key={i}>
                {i ? ', ' : ''}
                <Num value={p.value} unit={p.unit} />
              </Fragment>
            ))}
            )
          </CheckLine>
        ) : null}
        {pageOk !== null ? (
          <CheckLine ok={pageOk}>
            Rules cite page <span className="lf-mono">{source.page}</span>; the snapshot places it on page{' '}
            <span className="lf-mono">{Array.isArray(snapPage) ? snapPage.join('–') : snapPage}</span>
          </CheckLine>
        ) : null}
        {revOk !== null ? (
          <CheckLine ok={revOk}>
            Rules cite “{source.doc}”; the snapshot is Revision <span className="lf-mono">{idx.doc.revision}</span>
          </CheckLine>
        ) : null}
      </ul>
      {rec?.landfallNote || table?.landfallNote ? (
        <p className="prov-ournote">
          <span className="prov-ournote-tag">Ingest note (ours, not NASA text)</span> {rec?.landfallNote || table?.landfallNote}
        </p>
      ) : null}
      <DocLine idx={idx} page={snapPage} state={state} />
    </div>
  )
}

// ---- NOAA verbatim block ----------------------------------------------------------------------

export function NoaaVerbatim({ source, row }: { source: RuleSource; row: ProvRow | null }) {
  const { noaa, noaaIdx } = useSnaps()
  if (noaa.status === 'loading') return <p className="prov-loading">Reading the frozen swpc_s_scale snapshot…</p>
  if (!noaaIdx) {
    return (
      <div className="prov-notfound" role="note">
        <FreshnessChip meta={null} status={noaa.status === 'ready' ? 'error' : noaa.status} id="swpc_s_scale" />
        <p>The NOAA scale text cannot be shown because the snapshot is not readable in this build.</p>
      </div>
    )
  }
  const lvl = source.level ? noaaIdx.levels.get(source.level) ?? null : null
  if (!lvl) return <NotInSnapshot>Level {source.level ?? '(none given)'} is not in the frozen swpc_s_scale snapshot.</NotInSnapshot>
  const limit = row && row.value.kind === 'number' ? row.value.value : null
  return (
    <div className="prov-verbatim">
      <figure className="prov-quote">
        <figcaption>
          <span className="lf-req">{lvl.level}</span> {lvl.descriptor} · threshold printed as <span className="lf-mono">{lvl.threshold_as_printed}</span>{' '}
          {noaaIdx.unit} at {noaaIdx.energy}
          <span className="prov-sub">NOAA Space Weather Scales, Biological effects, verbatim</span>
        </figcaption>
        <blockquote>
          <Prose text={lvl.biological} />
        </blockquote>
      </figure>
      <ul className="prov-checks" aria-label="Build-time checks against the snapshot">
        {source.verbatim ? (
          <CheckLine ok={source.verbatim === lvl.biological}>
            Cited text {source.verbatim === lvl.biological ? 'equals' : 'differs from'} the snapshot's Biological text
          </CheckLine>
        ) : null}
        {limit !== null ? (
          <CheckLine ok={limit === lvl.threshold_pfu}>
            Rules value <Num value={limit} unit={noaaIdx.unit ?? undefined} /> {limit === lvl.threshold_pfu ? 'equals' : 'differs from'} NOAA's threshold{' '}
            <Num value={lvl.threshold_pfu} unit={noaaIdx.unit ?? undefined} />
          </CheckLine>
        ) : null}
      </ul>
      {noaaIdx.unitDefinition ? (
        <p className="prov-sub">
          {noaaIdx.unit} = {noaaIdx.unitDefinition}. {noaaIdx.rule}
        </p>
      ) : null}
      <div className="prov-docline">
        <ExtLink href={source.url}>{source.doc}</ExtLink>
        <FreshnessChip meta={noaa.snapshot} status={noaa.status} id="swpc_s_scale" compact />
      </div>
    </div>
  )
}

// ---- generic source block (all six kinds) -------------------------------------------------------

export function SourceBlock({ source, row }: { source: RuleSource | null; row: ProvRow | null }) {
  if (!source) return null
  switch (source.kind) {
    case 'nasa_standard':
      return <NasaVerbatim source={source} row={row} />
    case 'noaa':
      return <NoaaVerbatim source={source} row={row} />
    case 'literature':
      return (
        <div className="prov-verbatim">
          <p>
            <Citation source={source as never} />
            {source.page ? (
              <>
                {' '}
                p. <span className="lf-mono">{source.page}</span>
              </>
            ) : null}
          </p>
          {source.verbatim ? (
            <figure className="prov-quote">
              <figcaption>
                Quoted in the rules
                <span className="prov-sub">Not in a frozen snapshot: check it at the link above.</span>
              </figcaption>
              <blockquote>
                <Prose text={source.verbatim} />
              </blockquote>
            </figure>
          ) : null}
          {source.note ? (
            <p className="prov-ournote">
              <span className="prov-ournote-tag">Note</span> <Prose text={source.note} />
            </p>
          ) : null}
        </div>
      )
    case 'derived':
      return (
        <div className="prov-verbatim">
          <p className="prov-arith">
            <Prose text={source.arithmetic ?? '(no arithmetic given)'} />
          </p>
          <p className="prov-sub">
            Inputs:{' '}
            {(source.from ?? []).map((f, i) => (
              <Fragment key={f}>
                {i ? ', ' : ''}
                <RowLink id={f} />
              </Fragment>
            ))}
            {source.snapshot ? (
              <>
                {' '}
                and snapshot <code>{source.snapshot}</code>
              </>
            ) : null}
          </p>
        </div>
      )
    case 'design_choice':
      return (
        <div className="prov-verbatim">
          <p className="prov-ours">
            <Chip kind="design choice" /> <Prose text={source.rationale ?? '(no rationale given)'} />
          </p>
          {source.basis_citation ? (
            <p className="prov-sub">
              Basis cited: <ExtLink href={source.url}>{source.basis_citation}</ExtLink>
            </p>
          ) : null}
        </div>
      )
    default:
      return (
        <p>
          <Citation source={source as never} />
        </p>
      )
  }
}
