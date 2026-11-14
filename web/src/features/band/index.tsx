// #/band: LANDFALL BAND, the wearable concept. Everything on this page is rendered from
// hardware/sensor-map.json (bundled at build time): the block diagram, each block's three labels,
// the NOT MEASURABLE HERE boundary, the power and log arithmetic, the declared negatives and the BOM.
import { useCallback, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { FeatureProps } from '../../app/router'
import { Link } from '../../app/location'
import { useManifest } from '../../app/data'
import type { ManifestEntry } from '../../app/data'
import { Chip, Citation, Expander, FreshnessChip, Num, ReqId, UnknownIcon } from '../../ui'
import { BandDiagram } from './Diagram'
import type { Selection } from './Diagram'
import { BLOCKS, HAND_OFFS, SENSOR_MAP, blockById, handOffById, referencedSnapshots } from './map'
import { RELATION_SHORT, casesServed, datasheetStatus, interfaceLabel } from './render'
import type { Block, Datasheet, Evidence, FeedRef, HandOff, Limit, Rate, ReqRef, Step } from './types'
import './band.css'

const MAP = SENSOR_MAP

// ---- responsive layout choice (wide SVG on desktop, stacked SVG on phones) -----------------------

const WIDE_QUERY = '(min-width: 760px)'
function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  )
}

// ---- small pieces --------------------------------------------------------------------------------

function useSnapshotMeta() {
  const m = useManifest()
  return (id: string | null | undefined): { entry: ManifestEntry | null; status: 'loading' | 'ready' | 'missing' | 'error' } => {
    if (!id) return { entry: null, status: 'missing' }
    if (m.status !== 'ready') return { entry: null, status: m.status }
    const entry = m.entries.find((e) => e.id === id) ?? null
    return { entry, status: entry ? 'ready' : 'missing' }
  }
}

// Numbers inside running text: digit runs not glued to letters (so "I2C", "SpO2", "MAX30003" stay
// as they are) render in DM Mono, like every other number in LANDFALL.
const NUM_RE = /(?<![A-Za-z0-9])(\d(?:[\d,.]*\d)?)(?![A-Za-z])/g
export function Prose({ text }: { text?: string | null }) {
  if (!text) return null
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(NUM_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    out.push(
      <span key={i} className="band-n">
        {m[0]}
      </span>,
    )
    last = i + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

function ChipFor({ chip, basis }: { chip: string; basis?: string }) {
  return <Chip kind={chip}>{basis ? `${chip} · ${basis}` : chip}</Chip>
}

function RelationTag({ relation }: { relation: string }) {
  return (
    <span className="band-rel" data-relation={relation} title={MAP.relations[relation as keyof typeof MAP.relations]}>
      {RELATION_SHORT[relation] ?? relation}
    </span>
  )
}

function ReqName({ r }: { r: Pick<ReqRef, 'id' | 'item'> }) {
  if (/^V[12] \d/.test(r.id)) {
    return (
      <span className="band-reqname">
        <ReqId id={r.id} />
        {r.item ? <span className="lf-req">({r.item})</span> : null}
      </span>
    )
  }
  return <span className="band-reqname band-reqname-doc">{r.id}</span>
}

function LimitRow({ l }: { l: Limit }) {
  return (
    <li className="band-limit">
      <span><Prose text={l.what} /></span>
      <Num value={l.value} unit={l.unit} />
      <ChipFor chip={l.chip} />
      {l.table ? <span className="band-muted">{l.table}</span> : null}
      {l.rationale ? <span className="band-muted"><Prose text={l.rationale} /></span> : null}
    </li>
  )
}

function ReqCard({ r, meta }: { r: ReqRef; meta: ReturnType<typeof useSnapshotMeta> }) {
  const snap = r.snapshot ? meta(r.snapshot) : null
  return (
    <li className="band-req">
      <div className="band-req-head">
        <ReqName r={r} />
        <RelationTag relation={r.relation} />
      </div>
      {r.doc ? <p className="band-muted band-req-doc">{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.doc}</a> : r.doc}</p> : null}
      <blockquote className="band-quote">
        <p><Prose text={r.quote} /></p>
      </blockquote>
      {r.why ? <p className="band-small"><Prose text={r.why} /></p> : null}
      {r.note ? <p className="band-small"><Prose text={r.note} /></p> : null}
      {r.limits?.length ? <ul className="band-limits">{r.limits.map((l) => <LimitRow key={l.what} l={l} />)}</ul> : null}
      <p className="band-verbatim">
        {snap ? (
          <>
            Verbatim in <code>{r.snapshot}</code> <FreshnessChip meta={snap.entry} status={snap.status} id={r.snapshot ?? undefined} compact />
          </>
        ) : (
          <span className="band-muted">
            Public document, not frozen in this build
            {r.checked ? (
              <>
                {' '}
                · read <span className="band-n">{r.checked}</span>
              </>
            ) : null}
          </span>
        )}
      </p>
    </li>
  )
}

/** Published sources outside NASA-STD-3001 behind a design decision: quote, chip, citation, date read. */
function EvidenceList({ list }: { list?: Evidence[] }) {
  if (!list?.length) return null
  return (
    <section className="band-evidence" aria-label="Published basis, not a NASA requirement">
      <h3 className="band-label-h">
        Published basis <span className="band-evidence-sub">not a NASA requirement</span>
      </h3>
      <ul className="band-list">
        {list.map((e) => (
          <li key={e.source.url + e.claim} className="band-req">
            <p className="band-small band-evidence-claim">
              <Prose text={e.claim} />
            </p>
            <blockquote className="band-quote">
              <p>
                <Prose text={e.quote} />
              </p>
            </blockquote>
            <p className="band-verbatim">
              <ChipFor chip={e.chip} /> <Citation source={e.source} />
              <span>
                read <span className="band-n">{e.checked}</span>; not frozen in this build
              </span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FeedItem({ f }: { f: FeedRef }) {
  let body: ReactNode
  switch (f.kind) {
    case 'personal':
      body = (
        <>
          <span className="band-kind">Tier B indicator</span> <code>{f.id === '*' ? 'all personal indicators' : f.id}</code>
        </>
      )
      break
    case 'rule':
      body = (
        <>
          <span className="band-kind">Rule</span> <code>{f.id}</code>
        </>
      )
      break
    case 'case':
      body = (
        <>
          <span className="band-kind">Case</span> <Link to={`/case/${f.id}`}>{f.id}</Link>
        </>
      )
      break
    case 'app':
      body = (
        <>
          <span className="band-kind">App</span> <code>{f.id}</code>
        </>
      )
      break
    default:
      body = <span className="band-kind">No rule</span>
  }
  return (
    <li className="band-feed" data-kind={f.kind}>
      {body}
      {f.as ? <span className="band-muted"> · <Prose text={f.as} /></span> : null}
    </li>
  )
}

function RateRow({ r }: { r: Rate }) {
  const basis = r.source.kind === 'derived' ? r.source.arithmetic : r.source.rationale
  return (
    <tr>
      <th scope="row">{r.what}</th>
      <td>
        <Num value={r.value} unit={r.unit} />
      </td>
      <td>
        <ChipFor chip={r.chip} basis={r.basis} />
      </td>
      <td className="band-small"><Prose text={basis} /></td>
    </tr>
  )
}

/** Where the part's claims come from: read on the manufacturer's page, or not retrieved (cyan, [V2 10020]). */
function DatasheetNote({ d }: { d: Datasheet | null }) {
  if (!d) return <p className="band-small band-muted">No part selected, so there is no datasheet yet.</p>
  const read = d.status === 'read'
  return (
    <div className="band-ds" data-status={d.status}>
      <p className="band-small">
        <span className="band-kind">Datasheet</span>{' '}
        <span className="band-ds-status">
          {read ? null : <UnknownIcon size={13} />}
          {read ? 'read' : 'not retrieved'}
        </span> <span className="band-n">{d.checked}</span> ·{' '}
        <a href={d.url} target="_blank" rel="noopener noreferrer">
          manufacturer document<span className="sr-only"> (opens in a new tab)</span>
        </a>
        {d.product_page ? (
          <>
            {' '}
            ·{' '}
            <a href={d.product_page} target="_blank" rel="noopener noreferrer">
              product page<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        ) : null}
      </p>
      <p className="band-small band-muted"><Prose text={d.note} /></p>
      {d.verified?.length ? (
        <ul className="band-ds-quotes">
          {d.verified.map((v) => (
            <li key={v} className="band-small">
              <q><Prose text={v} /></q>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// ---- detail panels -------------------------------------------------------------------------------

function BlockDetail({ b, meta }: { b: Block; meta: ReturnType<typeof useSnapshotMeta> }) {
  return (
    <>
      <header className="band-detail-head">
        <p className="lf-eyebrow">
          {b.group === 'sensor' ? 'Sensor' : b.group === 'core' ? 'Core' : b.group === 'storage' ? 'Storage' : 'Power domain'} ·{' '}
          {interfaceLabel(MAP, b)}
        </p>
        <h2 className="band-detail-title">
          <span className="band-part">
            {b.part}
            {b.qty > 1 ? <> ×<Num value={b.qty} /></> : null}
          </span>{' '}
          {b.name}
        </h2>
        <p className="band-muted">{b.manufacturer}</p>
      </header>
      <p className="band-function"><Prose text={b.function} /></p>
      <div className="band-labels">
        <section aria-label="(a) Indicator it produces">
          <h3 className="band-label-h">
            <span className="band-label-key">a</span> Indicator it produces
          </h3>
          {b.produces.length ? (
            <ul className="band-list">
              {b.produces.map((p) => (
                <li key={p.variable + p.label}>
                  <code>{p.variable}</code> <span className="band-unit">[{p.unit}]</span> {p.label}
                  {p.not_in_spec ? <span className="band-flag"> no LANDFALL rule</span> : null}
                  <span className="band-small band-block"> <Prose text={p.how} /></span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="band-small">{b.produces_note ?? 'Nothing directly.'}</p>
          )}
        </section>
        <section aria-label="(b) LANDFALL rule, baseline or case it feeds">
          <h3 className="band-label-h">
            <span className="band-label-key">b</span> LANDFALL rule it feeds
          </h3>
          {b.feeds.length ? (
            <ul className="band-list">
              {b.feeds.map((f) => (
                <FeedItem key={f.kind + f.id + (f.as ?? '')} f={f} />
              ))}
            </ul>
          ) : (
            <p className="band-small">Nothing directly: it powers the band.</p>
          )}
          <p className="band-small band-muted">Case served: {casesServed(b)}</p>
        </section>
        <section aria-label="(c) NASA requirement that justifies it">
          <h3 className="band-label-h">
            <span className="band-label-key">c</span> NASA requirement
          </h3>
          <ul className="band-list">
            {b.justified_by.map((r) => (
              <ReqCard key={r.id + (r.item ?? '')} r={r} meta={meta} />
            ))}
          </ul>
        </section>
      </div>
      {b.rates.length ? (
        <div className="band-table-wrap">
          <table className="band-table">
            <caption>Sample rates and windows</caption>
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Value</th>
                <th scope="col">Basis</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {b.rates.map((r) => (
                <RateRow key={r.what} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="band-notes">
        {b.mfr_spec.length ? (
          <p className="band-small">
            <span className="band-kind">Manufacturer spec</span> (the part's own claim, read on its datasheet or product page; not a
            LANDFALL constant): <Prose text={b.mfr_spec.join('; ')} />.
          </p>
        ) : b.datasheet ? (
          <p className="band-small">
            <span className="band-kind">Manufacturer spec</span> none quoted: the datasheet could not be retrieved for this build,
            so this page quotes no claim about the part. What the design assumes of it is an open item.
          </p>
        ) : null}
        <DatasheetNote d={b.datasheet} />
      </div>
      {b.design.length ? (
        <div className="band-notes">
          {b.design.map((d) => (
            <p key={d} className="band-small">
              <span className="band-kind">Design note</span> <Prose text={d} />
            </p>
          ))}
        </div>
      ) : null}
      <EvidenceList list={b.evidence} />
    </>
  )
}

function HandOffDetail({ h, meta }: { h: HandOff; meta: ReturnType<typeof useSnapshotMeta> }) {
  return (
    <>
      <header className="band-detail-head">
        <p className="lf-eyebrow">Not measurable here · hand-off</p>
        <h2 className="band-detail-title">{h.what}</h2>
      </header>
      <div className="band-labels">
        <section aria-label="Why the band does not measure it">
          <h3 className="band-label-h">Why not on the band</h3>
          <p className="band-small"><Prose text={h.why} /></p>
        </section>
        <section aria-label="How it reaches LANDFALL">
          <h3 className="band-label-h">How it reaches LANDFALL</h3>
          <p>
            <Prose text={h.via} /> <span className="band-muted">(observation source</span> <code>{h.source}</code>
            <span className="band-muted">)</span>
          </p>
          <ul className="band-list">
            {h.feeds.map((f) => (
              <FeedItem key={f.kind + f.id} f={f} />
            ))}
          </ul>
        </section>
        <section aria-label="NASA requirement and real examples">
          <h3 className="band-label-h">NASA requirement and real examples</h3>
          <ul className="band-list">
            {h.requirement ? <ReqCard r={h.requirement} meta={meta} /> : null}
            {(h.also ?? []).map((r) => (
              <ReqCard key={r.id} r={r} meta={meta} />
            ))}
            {(h.examples ?? []).map((e) => {
              const s = meta(e.snapshot)
              return (
                <li key={e.name} className="band-req">
                  <div className="band-req-head">
                    <span className="band-reqname band-reqname-doc">{e.name}</span>
                    <span className="band-rel" data-relation="reference">real example</span>
                  </div>
                  <p className="band-small"><Prose text={e.text} /></p>
                  <p className="band-verbatim">
                    <code>{e.snapshot}</code> <FreshnessChip meta={s.entry} status={s.status} id={e.snapshot} compact />
                  </p>
                </li>
              )
            })}
            {!h.requirement && !h.examples?.length ? <li className="band-small band-muted">No NASA requirement names this hand-off.</li> : null}
          </ul>
        </section>
      </div>
      <EvidenceList list={h.evidence} />
    </>
  )
}

// ---- arithmetic ----------------------------------------------------------------------------------

function StepsTable({ steps, caption }: { steps: Step[]; caption: string }) {
  return (
    <div className="band-table-wrap">
      <table className="band-table band-steps">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Value</th>
            <th scope="col">Chip</th>
            <th scope="col">Arithmetic or reason</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.id} data-chip={s.chip}>
              <th scope="row"><Prose text={s.label} /></th>
              <td>
                <Num value={s.value} unit={s.unit} />
              </td>
              <td>
                <ChipFor chip={s.chip} />
              </td>
              <td className={s.arithmetic ? 'band-mono band-small' : 'band-small'}>{s.arithmetic ?? <Prose text={s.rationale} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- page ----------------------------------------------------------------------------------------

function initialSelection(query: Record<string, string>): Selection {
  const q = query.select
  if (q && blockById(q)) return { kind: 'block', id: q }
  if (q && handOffById(q)) return { kind: 'handoff', id: q }
  return { kind: 'block', id: BLOCKS[0]?.id ?? 'ecg' }
}

export default function Band({ query }: FeatureProps) {
  const wide = useWide()
  const [selection, setSelection] = useState<Selection>(() => initialSelection(query))
  const meta = useSnapshotMeta()
  const detailRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()

  const onSelect = useCallback((s: Selection) => {
    setSelection(s)
    const el = detailRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.top > window.innerHeight - 120 || r.bottom < 0) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    }
  }, [])

  const selBlock = selection.kind === 'block' ? blockById(selection.id) : undefined
  const selHand = selection.kind === 'handoff' ? handOffById(selection.id) : undefined
  const snapIds = referencedSnapshots(MAP)
  const powerTarget = MAP.power.steps.find((s) => s.id === 'target')
  const powerEst = MAP.power.steps.find((s) => s.id === 'autonomy')
  const logTarget = MAP.log.steps.find((s) => s.id === 'target')
  const logEst = MAP.log.steps.find((s) => s.id === 'depth')
  const energy = MAP.power.steps.find((s) => s.id === 'energy')
  const numbered = BLOCKS.filter((b) => b.datasheet).length

  return (
    <article className="band">
      <header className="band-head">
        <p className="lf-eyebrow">Hardware concept · block level · never built or bench-tested</p>
        <h1 className="band-h1">{MAP.title}</h1>
        <p className="band-lede">
          A wrist-worn sensor band. Heart rate comes from an optical pulse sensor, around the clock; the ECG is a spot check
          that the other hand closes. Each block names what it measures, the LANDFALL rule it feeds and the NASA
          requirement behind it. What a wearable cannot measure sits outside the device, behind the dashed line, with the
          path it takes instead.
        </p>
        <ul className="band-facts" aria-label="Key numbers">
          <li>
            <span className="band-fact-k">Parts</span> <Num value={BLOCKS.length} />{' '}
            <span className="band-muted">
              (<Num value={numbered} /> part numbers, <Num value={BLOCKS.length - numbered} /> cell not yet selected)
            </span>
          </li>
          <li>
            <span className="band-fact-k">Not measurable here</span> <Num value={HAND_OFFS.length} />
          </li>
          <li>
            <span className="band-fact-k">Cell</span> <Num value={energy?.value ?? null} unit="Wh" /> <ChipFor chip="derived" />
          </li>
          <li>
            <span className="band-fact-k">Autonomy</span> <Num value={powerEst?.value ?? null} unit="h est." />{' '}
            <span className="band-muted">target ≥</span> <Num value={powerTarget?.value ?? null} unit="h" /> <ChipFor chip="design choice" />
          </li>
          <li>
            <span className="band-fact-k">Log</span> <Num value={logEst?.value ?? null} unit="d est." /> <span className="band-muted">target ≥</span>{' '}
            <Num value={logTarget?.value ?? null} unit="d" /> <ChipFor chip="design choice" />
          </li>
        </ul>
      </header>


      <figure className="band-figure">
        <BandDiagram map={MAP} mode={wide ? 'wide' : 'narrow'} selection={selection} onSelect={onSelect} titleId={titleId} descId={descId} />
        <figcaption className="band-legend">
          <span className="band-lg band-lg-dev">Solid box: measured on the band</span>
          <span className="band-lg band-lg-nmh">Dashed, hatched: NOT MEASURABLE HERE (hand-off)</span>
          <span className="band-lg band-lg-sel">White outline: selected</span>
          <span className="band-lg">
            <span className="band-mono">a→</span> indicator produced · <span className="band-mono">c←</span> NASA requirement
          </span>
          <span className="band-lg">Select any block or hand-off for its three labels.</span>
        </figcaption>
      </figure>

      <div className="band-asides">
        <aside className="band-aside band-heart" aria-labelledby="band-heart-h">
          <h2 id="band-heart-h" className="band-aside-h">
            {MAP.heart.title}
          </h2>
          <ul className="band-heart-list">
            {MAP.heart.points.map((h) => {
              const b = blockById(h.block)
              return (
                <li key={h.block}>
                  <p className="band-heart-head">
                    <strong>{h.head}</strong>
                    {b ? (
                      <>
                        {' '}
                        ·{' '}
                        <button type="button" className="band-linkbtn" onClick={() => onSelect({ kind: 'block', id: b.id })} aria-label={`Show ${b.part} in the diagram details`}>
                          {b.part}
                        </button>
                      </>
                    ) : null}
                  </p>
                  <p className="band-small">
                    <Prose text={h.text} />
                  </p>
                </li>
              )
            })}
          </ul>
        </aside>
        <aside className="band-aside band-gap" aria-labelledby="band-gap-h">
          <h2 id="band-gap-h" className="band-aside-h">
            The gap this design fills
          </h2>
          <p className="band-gap-claim">
            <strong>
              <Prose text={MAP.gap.claim} />
            </strong>
          </p>
          <p className="band-small">
            <Prose text={MAP.gap.detail} />
          </p>
          <p className="band-small band-muted">
            <a href={MAP.gap.url} target="_blank" rel="noopener noreferrer">
              <Prose text={MAP.gap.doc} /> (NTRS <span className="band-n">{MAP.gap.ntrs}</span>)
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            ; <Prose text={MAP.gap.verified_in} />.
          </p>
        </aside>
      </div>

      <section ref={detailRef} className="band-detail" aria-live="polite" aria-atomic="false" tabIndex={-1}>
        {selBlock ? <BlockDetail b={selBlock} meta={meta} /> : null}
        {selHand ? <HandOffDetail h={selHand} meta={meta} /> : null}
      </section>

      <section className="band-section" aria-labelledby="band-why-h">
        <h2 id="band-why-h" className="band-h2">
          Why a wearable at all
        </h2>
        <ul className="band-list band-anchors">
          {MAP.anchors.map((r) => (
            <ReqCard key={r.id + (r.item ?? '')} r={r} meta={meta} />
          ))}
        </ul>
      </section>

      <div className="band-two">
        <section className="band-section" aria-labelledby="band-power-h">
          <h2 id="band-power-h" className="band-h2">
            Power and autonomy
          </h2>
          <p className="band-small"><Prose text={MAP.power.summary} /></p>
          <div className="band-table-wrap">
            <table className="band-table">
              <caption>
                Estimated average current per block <ChipFor chip={MAP.power.budget_chip} />
              </caption>
              <thead>
                <tr>
                  <th scope="col">Block</th>
                  <th scope="col">Current</th>
                </tr>
              </thead>
              <tbody>
                {MAP.power.budget.map((l) => (
                  <tr key={l.block}>
                    <th scope="row"><Prose text={l.label} /></th>
                    <td>
                      <Num value={l.ua} unit="µA" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <StepsTable steps={MAP.power.steps} caption="From current to autonomy" />
          <p className="band-small"><Prose text={MAP.power.comparison} /></p>
          <p className="band-small band-negative-inline"><Prose text={MAP.power.no_requirement} /></p>
        </section>
        <section className="band-section" aria-labelledby="band-log-h">
          <h2 id="band-log-h" className="band-h2">
            Log depth
          </h2>
          <p className="band-small"><Prose text={MAP.log.summary} /></p>
          <StepsTable steps={MAP.log.steps} caption="What 16 MiB holds" />
        </section>
      </div>

      <section className="band-section" aria-labelledby="band-neg-h">
        <h2 id="band-neg-h" className="band-h2">
          What NASA-STD-3001 Vol 2 Rev F does not require, declared on the drawing
        </h2>
        <ul className="band-neg">
          {MAP.negatives.map((n) => {
            const s = meta(n.snapshot)
            return (
              <li key={n.id}>
                <p className="band-neg-claim"><Prose text={n.claim} /></p>
                <p className="band-small"><Prose text={n.detail} /></p>
                <p className="band-small band-muted">
                  Search <code>{n.pattern}</code> over all 398 pages: <Num value={n.hits} unit={n.hits === 1 ? 'hit' : 'hits'} />{' '}
                  <FreshnessChip meta={s.entry} status={s.status} id={n.snapshot} compact />
                </p>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="band-section" aria-labelledby="band-pit-h">
        <h2 id="band-pit-h" className="band-h2">
          Three pitfalls of the flown Bio-Monitor, and what the band does about them
        </h2>
        <p className="band-small band-muted"><Prose text={MAP.pitfalls_basis} /></p>
        <ol className="band-pitfalls">
          {MAP.pitfalls.map((t) => (
            <li key={t.id}>
              <p className="band-neg-claim"><Prose text={t.title} /></p>
              <p className="band-small"><Prose text={t.text} /></p>
              <p className="band-small">
                <span className="band-kind">Band</span> <Prose text={t.consequence} />
              </p>
              {t.arithmetic?.length ? (
                <ul className="band-limits">
                  {t.arithmetic.map((a) => (
                    <li key={a.label} className="band-limit">
                      <span><Prose text={a.label} /></span>
                      <Num value={a.value} unit={a.unit} />
                      <ChipFor chip={a.chip} />
                      <span className="band-mono band-muted">{a.arithmetic}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
        <Expander summary={`Flown reference: ${MAP.flown_reference.name}, facts and channel table`}>
          <ul className="band-list">
            {MAP.flown_reference.facts.map((f) => (
              <li key={f} className="band-small">
                <Prose text={f} />
              </li>
            ))}
          </ul>
          <p className="band-small band-muted band-sources-lede">
            <Prose text={MAP.flown_reference.basis} />
          </p>
          <ul className="band-sources">
            {MAP.flown_reference.sources.map((src) => (
              <li key={src.url} className="band-small">
                <a href={src.url} target="_blank" rel="noopener noreferrer">
                  <Prose text={src.label} />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
          <div className="band-table-wrap">
            <table className="band-table">
              <caption>Bio-Monitor channels, as the Hexoskin datatype registry lists them</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Rate</th>
                  <th scope="col">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {MAP.flown_reference.channels.map((c) => (
                  <tr key={c.id}>
                    <th scope="row"><Prose text={c.channel} /></th>
                    <td>{c.rate_text ? <span className="lf-num">{c.rate_text}</span> : <Num value={c.rate_hz} unit="Hz" />}</td>
                    <td className="band-small">{c.resolution ? <Prose text={c.resolution} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Expander>
      </section>

      <section className="band-section" aria-labelledby="band-safety-h">
        <h2 id="band-safety-h" className="band-h2">
          Safety constraints
        </h2>
        <p className="band-small band-muted"><Prose text={MAP.safety_basis} /></p>
        <div className="band-table-wrap">
          <table className="band-table">
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">Reference</th>
                <th scope="col">Constraint</th>
                <th scope="col">Chip</th>
              </tr>
            </thead>
            <tbody>
              {MAP.safety.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.topic}</th>
                  <td>
                    {s.refs.map((r) => (
                      <span key={r} className="band-ref">
                        {/^V[12] \d/.test(r) ? <ReqId id={r} /> : r}
                      </span>
                    ))}
                    {(s.links ?? []).map((l) => (
                      <a key={l.url} className="band-small band-block band-ref-link" href={l.url} target="_blank" rel="noopener noreferrer">
                        {l.label}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ))}
                  </td>
                  <td className="band-small"><Prose text={s.text} /></td>
                  <td>
                    <ChipFor chip={s.chip} />
                    {!s.snapshot ? <span className="band-muted band-block band-small">not frozen in this build</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="band-section" aria-labelledby="band-bom-h">
        <h2 id="band-bom-h" className="band-h2">
          Bill of materials
        </h2>
        <p className="band-small band-muted">
          Also in <code>hardware/BOM.csv</code>, generated from the same JSON. <Prose text={MAP.mfr_basis} />
        </p>
        <div className="band-table-wrap" tabIndex={0} role="region" aria-label="Bill of materials, scrollable">
          <table className="band-table band-bom">
            <thead>
              <tr>
                <th scope="col">Part</th>
                <th scope="col">Qty</th>
                <th scope="col">Manufacturer</th>
                <th scope="col">Function</th>
                <th scope="col">Interface</th>
                <th scope="col">Case served</th>
                <th scope="col">Datasheet</th>
              </tr>
            </thead>
            <tbody>
              {BLOCKS.map((b) => (
                <tr key={b.id}>
                  <th scope="row">
                    <button type="button" className="band-linkbtn" onClick={() => onSelect({ kind: 'block', id: b.id })} aria-label={`Show ${b.part} in the diagram details`}>
                      {b.part}
                    </button>
                  </th>
                  <td>
                    <Num value={b.qty} />
                  </td>
                  <td>{b.manufacturer}</td>
                  <td className="band-small"><Prose text={b.function} /></td>
                  <td className="band-small">{interfaceLabel(MAP, b)}</td>
                  <td className="band-small">{casesServed(b)}</td>
                  <td className="band-small" data-ds={b.datasheet?.status ?? 'none'}>
                    {b.datasheet ? (
                      <a href={b.datasheet.url} target="_blank" rel="noopener noreferrer">
                        <Prose text={datasheetStatus(b)} />
                        <span className="sr-only"> (manufacturer document, opens in a new tab)</span>
                      </a>
                    ) : (
                      datasheetStatus(b)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="band-section" aria-labelledby="band-open-h">
        <h2 id="band-open-h" className="band-h2">
          Open items
        </h2>
        <p className="band-small"><Prose text={MAP.status.text} /></p>
        <ul className="band-open">
          {MAP.open_items.map((o) => (
            <li key={o}><Prose text={o} /></li>
          ))}
        </ul>
      </section>

      <section className="band-section band-build" aria-label="Build notes">
        <Expander summary="Build notes: how this build checked its sources">
          <ul className="band-open">
            {MAP.build_notes.map((n) => (
              <li key={n}>
                <Prose text={n} />
              </li>
            ))}
          </ul>
        </Expander>
      </section>

      <footer className="band-foot">
        <p className="band-small">
          Rendered from <code>hardware/sensor-map.json</code>, bundled at build time (no request at runtime). A unit test checks
          every quote taken from these frozen snapshots verbatim; a quote from a public document that is not frozen here links
          to its source and gives the date it was read.
        </p>
        <ul className="band-foot-snaps">
          {snapIds.map((id) => {
            const s = meta(id)
            return (
              <li key={id}>
                <code>{id}</code> <FreshnessChip meta={s.entry} status={s.status} id={id} source={s.entry ? { publisher: s.entry.publisher, url: s.entry.url } : null} />
              </li>
            )
          })}
        </ul>
      </footer>
    </article>
  )
}

