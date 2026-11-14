// PROVENANCE: every constant LANDFALL uses, generated from engine/rules/*.json (the same files the
// engine reads), with the verbatim NASA text behind each NASA-published number, pulled from the
// frozen std_vol1 / std_vol2 snapshots. Deep link: #/provenance?id=<rule_or_constant_id>.
import { Fragment, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { FeatureProps } from '../../app/router'
import { useSnapshot } from '../../app/data'
import { CHIPS } from '../../app/vocab'
import { Button, Chip, EmptyState, Expander, FreshnessChip, Num, Panel, ReqId, UnknownIcon } from '../../ui'
import { CASES, FILE_STATUS, GROUPS, META, ROWS, citedRequirements, designChoiceFamilies, findRow, groupOf } from './model'
import type { DesignFamily, ProvRow } from './model'
import {
  AlertClassQuote,
  AppliesCell,
  Categories,
  CategoryTag,
  CheckLine,
  ConditionCell,
  DocLine,
  ExtLink,
  NotInSnapshot,
  Prose,
  RowLink,
  SnapsContext,
  SourceBlock,
  SourceCell,
  UsedByCell,
  ValueCell,
  ValueInline,
  useSnaps,
} from './parts'
import type { Snaps } from './parts'
import { noaaIndex, normReqId, pdfAt, volIndex } from './snapshots'
import './provenance.css'

const NONE = '__none__'
const ALL = '__all__'

const CHIP_ORDER: readonly string[] = META?.chips.map((c) => c.id) ?? CHIPS

const DETAIL_SUMMARY: Record<string, string> = {
  'NASA-published': 'Verbatim NASA text and checks',
  'NASA report': 'Source',
  'NOAA-published': 'Verbatim NOAA text and checks',
  literature: 'Citation and quote',
  derived: 'Arithmetic',
  'design choice': 'Why we chose it',
}

const domId = (id: string) => `prov-row-${id}`

// ---------------------------------------------------------------------------------------------

export default function Provenance({ query }: FeatureProps) {
  const v1 = useSnapshot('std_vol1_requirements')
  const v2 = useSnapshot('std_vol2_requirements')
  const noaa = useSnapshot('swpc_s_scale')
  // Index each big snapshot once per parsed object (volIndex/noaaIndex memoise by identity too).
  const idx1 = useMemo(() => (v1.status === 'ready' ? volIndex(1, v1.data, v1.snapshot?.source.url ?? null) : null), [v1.status, v1.data, v1.snapshot])
  const idx2 = useMemo(() => (v2.status === 'ready' ? volIndex(2, v2.data, v2.snapshot?.source.url ?? null) : null), [v2.status, v2.data, v2.snapshot])
  const noaaIdx = useMemo(() => (noaa.status === 'ready' ? noaaIndex(noaa.data) : null), [noaa.status, noaa.data])
  const snaps = useMemo<Snaps>(() => ({ v1, v2, noaa, idx1, idx2, noaaIdx }), [v1, v2, noaa, idx1, idx2, noaaIdx])

  const [chip, setChip] = useState<string>(() => (query.chip && CHIP_ORDER.includes(query.chip) ? query.chip : ALL))
  const categories = useMemo(() => {
    const s = new Set<string>()
    for (const r of ROWS) for (const c of r.categories) s.add(c)
    const order = META?.categories.map((c) => c.id) ?? []
    const rank = (x: string) => (order.includes(x) ? order.indexOf(x) : order.length)
    return [...s].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  }, [])
  const [cat, setCat] = useState<string>(() =>
    query.category && (query.category === NONE || categories.includes(query.category)) ? query.category : ALL,
  )
  const [q, setQ] = useState<string>(() => query.q ?? '')
  const dq = useDeferredValue(q)

  const targetId = query.id ?? null
  const target = useMemo(() => (targetId ? findRow(targetId) : null), [targetId])
  const targetIds = useMemo(() => new Set((target?.matches ?? []).map((r) => r.id)), [target])

  const visible = useMemo(() => {
    const needle = dq.trim().toLowerCase()
    return ROWS.filter((r) => {
      if (targetIds.has(r.id)) return true // a deep-linked row is never hidden by filters
      if (chip !== ALL && r.chip !== chip) return false
      if (cat === NONE && r.categories.length) return false
      if (cat !== ALL && cat !== NONE && !r.categories.includes(cat)) return false
      if (needle && !needle.split(/\s+/).every((w) => r.searchText.includes(w))) return false
      return true
    })
  }, [chip, cat, dq, targetIds])

  // Scroll to the deep-linked row once the snapshots have settled (they change the layout above it).
  const settled = v1.status !== 'loading' && v2.status !== 'loading' && noaa.status !== 'loading'
  useEffect(() => {
    if (!target || !settled) return
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(domId(target.row.id))
      if (!el) return
      // Clear the sticky mission bar (its real height, which can exceed the token when it wraps).
      const bar = document.querySelector('.lf-missionbar')?.getBoundingClientRect().height ?? 0
      window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - bar - 12) })
      el.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [target, settled])

  const filtered = chip !== ALL || cat !== ALL || q.trim() !== ''
  const clear = () => {
    setChip(ALL)
    setCat(ALL)
    setQ('')
  }
  const pickChip = (c: string) => {
    setChip((cur) => (cur === c ? ALL : c))
    document.getElementById('prov-constants')?.scrollIntoView({ block: 'start' })
  }

  if (!ROWS.length) {
    return (
      <EmptyState kind="missing" title="Provenance" headingLevel={1}>
        <p>No rules files were found in this build (engine/rules/*.json), so there is nothing to trace.</p>
      </EmptyState>
    )
  }

  return (
    <SnapsContext.Provider value={snaps}>
      <div className="prov">
        <header className="prov-head">
          <p className="lf-eyebrow">Audit trail</p>
          <h1>Provenance</h1>
          <p className="prov-lead">
            Every number LANDFALL uses, generated from the same rules files the engine reads. Each one carries a chip that names its basis.
            NASA-published numbers open to the verbatim requirement text, frozen from the PDF, with the checks run against it.
          </p>
          <ul className="prov-files" aria-label="Rules files read at build time">
            {FILE_STATUS.map((f) => (
              <li key={f.name} data-present={f.present}>
                <code>engine/rules/{f.name}.json</code>{' '}
                {f.present ? (
                  <span className="prov-sub">{f.schema}</span>
                ) : (
                  <span className="lf-dq" data-tone="stale">
                    <UnknownIcon size={12} /> missing from build
                  </span>
                )}
              </li>
            ))}
          </ul>
        </header>

        <Summary onPick={pickChip} active={chip} />

        {target === null && targetId ? (
          <div className="prov-linknote" data-found="false" role="status">
            <span className="lf-dq" data-tone="stale">
              <UnknownIcon size={14} /> Unknown id
            </span>
            <span>
              No constant with id <code>{targetId}</code> exists in engine/rules/*.json. <a href="#/provenance">Show all constants</a>
            </span>
          </div>
        ) : null}

        <DesignChoices />

        <Panel
          id="prov-constants"
          title="Every constant"
          eyebrow={`${ROWS.length} entries · engine/rules/*.json`}
          footer={
            <>
              <span>Verbatim text from:</span>
              <FreshnessChip meta={v1.snapshot} status={v1.status} id="std_vol1_requirements" />
              <FreshnessChip meta={v2.snapshot} status={v2.status} id="std_vol2_requirements" />
              <FreshnessChip meta={noaa.snapshot} status={noaa.status} id="swpc_s_scale" />
            </>
          }
        >
          <div className="prov-filters" role="search" aria-label="Filter constants">
            <label>
              <span>Basis</span>
              <select value={chip} onChange={(e) => setChip(e.target.value)}>
                <option value={ALL}>All chips</option>
                {CHIP_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Category</span>
              <select value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value={ALL}>All categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value={NONE}>None (not a limit)</option>
              </select>
            </label>
            <label className="prov-search">
              <span>Search</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="id, label, unit, requirement, citation…" />
            </label>
            <p className="prov-count" aria-live="polite">
              Showing <Num value={visible.length} /> of <Num value={ROWS.length} />
            </p>
            {filtered ? (
              <Button variant="secondary" onClick={clear}>
                Clear filters
              </Button>
            ) : null}
          </div>
          {target ? (
            <div className="prov-linknote" data-found="true" role="status">
              <span>
                Linked from another view: <code>{targetId}</code>
                {target.matches.length > 1 ? (
                  <>
                    {' '}
                    (<Num value={target.matches.length} /> rows)
                  </>
                ) : null}
                . It stays visible whatever the filters.
              </span>
              <a href="#/provenance">Clear link</a>
            </div>
          ) : null}
          <ConstantsTable rows={visible} targetIds={targetIds} />
        </Panel>

        <RequirementIndex />
        <Legend />
        <Refusals />
      </div>
    </SnapsContext.Provider>
  )
}

// ---- 1. summary strip -------------------------------------------------------------------------

function Summary({ onPick, active }: { onPick: (chip: string) => void; active: string }) {
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of ROWS) m.set(r.chip, (m.get(r.chip) ?? 0) + 1)
    return m
  }, [])
  const mappings = ROWS.filter((r) => r.kind === 'severity_map').length
  const extra = [...counts.keys()].filter((c) => !CHIP_ORDER.includes(c))
  return (
    <section className="prov-summary" aria-labelledby="prov-summary-h">
      <h2 id="prov-summary-h" className="sr-only">
        Summary
      </h2>
      <div className="prov-total">
        <Num value={ROWS.length} className="prov-total-n" />
        <span>
          entries in the rules
          <span className="prov-sub">
            <Num value={ROWS.length - mappings} /> numeric constants and <Num value={mappings} /> severity-mapping rows
          </span>
        </span>
      </div>
      <ul className="prov-chipcounts" aria-label="Entries per chip (select to filter)">
        {[...CHIP_ORDER, ...extra].map((c) => (
          <li key={c}>
            <button type="button" className="prov-chipbtn" aria-pressed={active === c} onClick={() => onPick(c)} data-chip={c}>
              <Num value={counts.get(c) ?? 0} className="prov-chipbtn-n" />
              <Chip kind={c} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---- 2/3. the table ---------------------------------------------------------------------------

function ConstantsTable({ rows, targetIds }: { rows: readonly ProvRow[]; targetIds: Set<string> }) {
  const byGroup = useMemo(() => {
    const m = new Map<string, ProvRow[]>()
    for (const r of rows) {
      const g = groupOf(r)
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(r)
    }
    return m
  }, [rows])
  if (!rows.length) {
    return (
      <EmptyState kind="placeholder" title="No constant matches these filters" headingLevel={3}>
        <p>Clear the filters to see all of them.</p>
      </EmptyState>
    )
  }
  return (
    <table className="prov-table">
      <caption className="sr-only">Every constant in engine/rules/*.json with its value, compliant condition, category, chip, source, environments and users</caption>
      <colgroup>
        <col className="prov-c-label" />
        <col className="prov-c-value" />
        <col className="prov-c-cond" />
        <col className="prov-c-cat" />
        <col className="prov-c-chip" />
        <col className="prov-c-src" />
        <col className="prov-c-env" />
        <col className="prov-c-used" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Constant</th>
          <th scope="col" className="num">
            Value
          </th>
          <th scope="col">Compliant when</th>
          <th scope="col">Category</th>
          <th scope="col">Basis</th>
          <th scope="col">Source</th>
          <th scope="col">Applies to</th>
          <th scope="col">Used by</th>
        </tr>
      </thead>
      {GROUPS.map((g) => {
        const list = byGroup.get(g.id)
        if (!list?.length) return null
        return (
          <tbody key={g.id}>
            <tr className="prov-grp">
              <th colSpan={8} scope="colgroup">
                <span className="prov-grp-title">{g.title}</span> <code>{g.file}.json</code> <Num value={list.length} unit={list.length === 1 ? 'entry' : 'entries'} />
              </th>
            </tr>
            {list.map((r) => (
              <ConstantRow key={r.id} row={r} target={targetIds.has(r.id)} />
            ))}
          </tbody>
        )
      })}
    </table>
  )
}

function ConstantRow({ row, target }: { row: ProvRow; target: boolean }) {
  return (
    <Fragment>
      <tr id={domId(row.id)} className="prov-row" data-kind={row.kind} data-target={target || undefined} tabIndex={target ? -1 : undefined}>
        <td data-label="Constant" className="prov-labelcell">
          {row.parentId ? (
            <span className="prov-child" aria-hidden="true">
              ↳{' '}
            </span>
          ) : null}
          <span className="prov-label">{row.label}</span>
          <a className="prov-id" href={`#/provenance?id=${encodeURIComponent(row.id)}`} title="Link to this constant">
            <code>{row.id}</code>
          </a>
        </td>
        <td data-label="Value" className="num">
          <ValueCell value={row.value} />
        </td>
        <td data-label="Compliant when">
          <ConditionCell condition={row.condition} />
        </td>
        <td data-label="Category">
          <Categories list={row.categories} />
        </td>
        <td data-label="Basis">
          <Chip kind={row.chip} />
        </td>
        <td data-label="Source">
          <SourceCell source={row.source} />
        </td>
        <td data-label="Applies to">
          <AppliesCell row={row} />
        </td>
        <td data-label="Used by">
          <UsedByCell refs={row.usedBy} row={row} />
        </td>
      </tr>
      <tr className="prov-detail" data-target={target || undefined}>
        <td colSpan={8}>
          <Expander summary={DETAIL_SUMMARY[row.chip] ?? 'Source'} defaultOpen={target}>
            <RowDetail row={row} />
          </Expander>
        </td>
      </tr>
    </Fragment>
  )
}

function RowDetail({ row }: { row: ProvRow }) {
  return (
    <div className="prov-rowdetail">
      <SourceBlock source={row.source} row={row} />
      {row.kind === 'severity_map' && row.value.kind === 'mapping' ? <AlertClassQuote severity={row.value.severity ?? row.value.severity_max} /> : null}
      {row.facts.length ? (
        <dl className="prov-facts">
          {row.facts.map((f) => (
            <Fragment key={f.label}>
              <dt>{f.label}</dt>
              <dd>
                {f.chip ? <Chip kind={f.chip} /> : null} <Prose text={f.text} />
                {f.source && f.source.kind !== 'design_choice' ? <SourceInline source={f.source} /> : null}
                {f.source && f.source.kind === 'design_choice' && f.source.rationale ? (
                  <span className="prov-sub">
                    Ours: <Prose text={f.source.rationale} />
                  </span>
                ) : null}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {row.notes.length ? (
        <div className="prov-notes">
          <p className="prov-ournote-tag">LANDFALL notes (ours, not NASA text)</p>
          <ul>
            {row.notes.map((n) => (
              <li key={n}>
                <Prose text={n} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="prov-path">
        <span>JSON</span> <code>{row.path}</code> <span>Link</span> <code>#/provenance?id={row.id}</code>
      </p>
    </div>
  )
}

function SourceInline({ source }: { source: NonNullable<ProvRow['source']> }) {
  if (source.kind === 'nasa_standard')
    return (
      <span className="prov-sub">
        {source.requirement_id ? <ReqId id={source.requirement_id} /> : null} {source.doc}
        {source.page ? (
          <>
            {' '}
            <ExtLink href={pdfAt(source.url, source.page)}>
              p. <span className="lf-mono">{source.page}</span>
            </ExtLink>
          </>
        ) : null}
        {source.verbatim ? (
          <>
            : “<Prose text={source.verbatim} />”
          </>
        ) : null}
      </span>
    )
  if (source.kind === 'literature')
    return (
      <span className="prov-sub">
        <ExtLink href={source.url}>{source.citation}</ExtLink>
      </span>
    )
  return null
}

// ---- 4. design choices --------------------------------------------------------------------------

function DesignChoices() {
  const { v1, v2 } = useSnaps()
  const families = useMemo(() => designChoiceFamilies(ROWS), [])
  const total = families.reduce((n, f) => n + f.count, 0)
  const principle = META?.principles.find((p) => p.id === 'no_nasa_alert_thresholds') ?? META?.principles[0]
  const reqIds = principle?.requirement_ids ?? []
  return (
    <Panel
      id="prov-design"
      className="prov-dc"
      eyebrow={`${total} of ${ROWS.length} entries`}
      title="Design choices — no published basis"
      footer={
        <>
          <span>Requirement text from:</span>
          <FreshnessChip meta={v1.snapshot} status={v1.status} id="std_vol1_requirements" />
          <FreshnessChip meta={v2.snapshot} status={v2.status} id="std_vol2_requirements" />
        </>
      }
    >
      <p className="prov-dc-lead">
        NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert requirements leave the number to the program.
        Where we needed a number NASA does not publish, it is listed here as ours.
      </p>
      {reqIds.length ? (
        <>
          <p className="prov-dc-why">
            The evidence for that first sentence, in NASA's own words: each alert requirement leaves the number to the program (highlighted: the
            phrase the ingest checked in the PDF text).
          </p>
          <ul className="prov-dc-quotes">
            {reqIds.map((id) => (
              <li key={id}>
                <DelegationQuote id={normReqId(id)} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="prov-dc-h">Listed here as ours</h3>
      <div className="prov-dc-families">
        {families.map((f) => (
          <DesignFamilyCard key={f.family} family={f} />
        ))}
      </div>
    </Panel>
  )
}

function DelegationQuote({ id }: { id: string }) {
  const { idx1, idx2, v1, v2 } = useSnaps()
  const vol = id.startsWith('V1') ? 1 : 2
  const idx = vol === 1 ? idx1 : idx2
  const state = vol === 1 ? v1 : v2
  if (state.status === 'loading')
    return (
      <p className="prov-loading">
        <ReqId id={id} /> reading snapshot…
      </p>
    )
  const rec = idx?.reqs.get(id)
  if (!idx || !rec) {
    return (
      <NotInSnapshot>
        <ReqId id={id} /> is not in the frozen {vol === 1 ? 'std_vol1_requirements' : 'std_vol2_requirements'} snapshot
        {state.status !== 'ready' ? ` (snapshot ${state.status})` : ''}.
      </NotInSnapshot>
    )
  }
  const phrase = rec.checkedPhrases.find((p) => rec.text.includes(p)) ?? null
  return (
    <figure className="prov-quote prov-dq">
      <blockquote>
        <Prose text={rec.text} mark={phrase} />
      </blockquote>
      <figcaption>
        <ReqId id={rec.id} /> {rec.title}
        <span className="prov-sub">
          NASA-STD-3001 Vol <span className="lf-mono">{vol}</span> Rev <span className="lf-mono">{idx.doc.revision}</span> §
          <span className="lf-mono">{rec.section}</span> ·{' '}
          <ExtLink href={pdfAt(idx.doc.pdfUrl, rec.page)}>
            p. <span className="lf-mono">{rec.page}</span>
          </ExtLink>
        </span>
      </figcaption>
    </figure>
  )
}

function DesignFamilyCard({ family }: { family: DesignFamily }) {
  const byId = useMemo(() => new Map(ROWS.map((r) => [r.id, r])), [])
  return (
    <section className="prov-dg" aria-label={`${family.family}: ${family.count}`}>
      <h4 className="prov-dg-h">
        <span>{family.family}</span> <Num value={family.count} unit={family.count === 1 ? 'entry' : 'entries'} />
      </h4>
      {family.groups.map((g) => (
        <div key={g.key} className="prov-dg-sub">
          <p className="prov-dg-why">
            <span className="prov-ournote-tag">Our reason</span> <Prose text={g.rationale} />
            {g.numbersDiffer ? <span className="prov-sub">Quoted from the first value; the others give the same reason with their own numbers.</span> : null}
          </p>
          <ul className="prov-pills">
            {g.members.map((m) => {
              const parent = m.parentId ? byId.get(m.parentId) : undefined
              return (
                <li key={m.id}>
                  <a href={`#/provenance?id=${encodeURIComponent(m.id)}`}>{m.shortLabel}</a> <ValueInline value={m.value} of={parent?.value ?? null} />
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}

// ---- requirement index ------------------------------------------------------------------------

function RequirementIndex() {
  const { idx1, idx2, v1, v2 } = useSnaps()
  const cited = useMemo(() => citedRequirements(), [])
  const missing = cited.filter((c) => {
    const idx = c.id.startsWith('V1') ? idx1 : idx2
    return idx && !idx.reqs.has(c.id)
  }).length
  return (
    <Panel
      id="prov-reqs"
      title="NASA requirements the rules cite"
      eyebrow={`${cited.length} requirement IDs`}
      footer={
        <>
          {idx1 ? <DocLine idx={idx1} page={null} state={v1} /> : <FreshnessChip meta={v1.snapshot} status={v1.status} id="std_vol1_requirements" />}
          {idx2 ? <DocLine idx={idx2} page={null} state={v2} /> : <FreshnessChip meta={v2.snapshot} status={v2.status} id="std_vol2_requirements" />}
        </>
      }
    >
      <p className="prov-sub">
        Every <span className="lf-mono">[V1 …]</span> / <span className="lf-mono">[V2 …]</span> ID found in a source field or in the text of the rules
        files, looked up in the frozen snapshots.
        {missing ? (
          <>
            {' '}
            <Num value={missing} /> {missing === 1 ? 'is' : 'are'} cited but not frozen, and {missing === 1 ? 'is' : 'are'} flagged below rather than
            hidden.
          </>
        ) : null}
      </p>
      <table className="prov-reqtable">
        <thead>
          <tr>
            <th scope="col">Requirement</th>
            <th scope="col">Title (from the snapshot)</th>
            <th scope="col" className="num">
              PDF page
            </th>
            <th scope="col">Cited by</th>
          </tr>
        </thead>
        <tbody>
          {cited.map((c) => {
            const vol = c.id.startsWith('V1') ? 1 : 2
            const idx = vol === 1 ? idx1 : idx2
            const state = vol === 1 ? v1 : v2
            const rec = idx?.reqs.get(c.id)
            return (
              <tr key={c.id}>
                <th scope="row">
                  <ReqId id={c.id} />
                </th>
                <td>
                  {rec ? (
                    <>
                      {rec.title} <span className="prov-sub">§{rec.section}</span>
                    </>
                  ) : state.status === 'loading' ? (
                    <span className="prov-loading">reading snapshot…</span>
                  ) : (
                    <span className="lf-dq" data-tone="stale">
                      <UnknownIcon size={12} /> Not in snapshot
                    </span>
                  )}
                </td>
                <td className="num">
                  {rec?.page ? (
                    <ExtLink href={pdfAt(idx?.doc.pdfUrl, rec.page)}>
                      <span className="lf-mono">{rec.page}</span>
                    </ExtLink>
                  ) : (
                    <span className="prov-none">—</span>
                  )}
                </td>
                <td>
                  {c.citedBy.map((w, i) => (
                    <Fragment key={w}>
                      {i ? ', ' : ''}
                      <RowLink id={w} />
                    </Fragment>
                  ))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

// ---- 5. legend and refusals ---------------------------------------------------------------------

function Legend() {
  const { idx1 } = useSnaps()
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of ROWS) m.set(r.chip, (m.get(r.chip) ?? 0) + 1)
    return m
  }, [])
  return (
    <Panel id="prov-legend" title="Chips and categories" eyebrow="meta.json">
      <div className="prov-legend">
        <section aria-labelledby="prov-chips-h">
          <h3 id="prov-chips-h" className="prov-legend-h">
            Chips: the basis of a number
          </h3>
          <dl className="prov-chipdefs">
            {(META?.chips ?? []).map((c) => (
              <Fragment key={c.id}>
                <dt>
                  <Chip kind={c.id} />
                </dt>
                <dd>
                  {c.definition}{' '}
                  <span className="prov-sub">
                    source kind <code>{c.source_kind}</code> · <Num value={counts.get(c.id) ?? 0} unit="entries" />
                  </span>
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
        <section aria-labelledby="prov-cats-h">
          <h3 id="prov-cats-h" className="prov-legend-h">
            Categories: the shape of a limit
          </h3>
          <dl className="prov-catdefs">
            {(META?.categories ?? []).map((c) => {
              const g = c.source?.term && idx1 ? idx1.glossary.find((x) => x.term === c.source?.term) : undefined
              return (
                <Fragment key={c.id}>
                  <dt>
                    <CategoryTag category={c.id} />
                  </dt>
                  <dd>
                    <strong>{c.name}</strong>: {c.shape}.
                    {c.glossary ? (
                      <>
                        <blockquote className="prov-gloss">
                          <Prose text={c.glossary} />
                        </blockquote>
                        <ul className="prov-checks">
                          {c.source?.term ? (
                            <CheckLine ok={idx1 ? (g ? g.definition === c.glossary : false) : null}>
                              {idx1
                                ? g
                                  ? g.definition === c.glossary
                                    ? `Matches the glossary entry “${g.term}” in the Vol 1 snapshot (${c.source.section ?? 'glossary'}, p. ${g.page ?? '?'})`
                                    : `Differs from the glossary entry “${g.term}” in the Vol 1 snapshot`
                                  : `Glossary term “${c.source.term}” is not in the Vol 1 snapshot`
                                : 'Vol 1 snapshot not loaded'}
                            </CheckLine>
                          ) : null}
                        </ul>
                      </>
                    ) : (
                      <span className="prov-sub"> No NASA glossary entry: this category is LANDFALL's.</span>
                    )}
                  </dd>
                </Fragment>
              )
            })}
          </dl>
        </section>
      </div>
    </Panel>
  )
}

function Refusals() {
  const caseRefusals = (CASES?.cases ?? []).filter((c) => c.refusals?.length)
  return (
    <Panel id="prov-refusals" title="Refusals" eyebrow="meta.json · refusals are features">
      <ul className="prov-refusals">
        {(META?.refusals ?? []).map((r) => (
          <li key={r.id}>
            <Prose text={r.text} />
            <code className="prov-refid">{r.id}</code>
          </li>
        ))}
      </ul>
      {caseRefusals.length ? (
        <Expander summary="Refusals inside each case (cases.json)">
          {caseRefusals.map((c) => (
            <div key={c.id} className="prov-caseref">
              <p>
                <a href={`#/case/${encodeURIComponent(c.id)}`}>{c.title}</a>
              </p>
              <ul>
                {c.refusals!.map((t) => (
                  <li key={t}>
                    <Prose text={t} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Expander>
      ) : null}
    </Panel>
  )
}
