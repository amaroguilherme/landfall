// Section: NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert
// requirements leave the number to the program. The requirement IDs come from meta.json (principle
// no_nasa_alert_thresholds); the text, the rationale and the "verified" flags come from the frozen
// std_vol1/std_vol2 snapshots.
import { useSnapshot } from '../../app/data'
import type { SnapshotState } from '../../app/data'
import { EmptyState, Expander, FreshnessChip, ReqId } from '../../ui'
import { isBuildNote } from '../data/buildNotes'
import { NearestList } from '../nearest/NearestList'
import { FoldPanel } from './fold'
import { normReqId, quotedPhrase, sentencesContaining } from './rules'
import type { MetaFile, Vol1Data, Vol2Data } from './rules'
import { ExtLink, MissingNote, RichText, Verbatim, Verified } from './shared'

interface ReqQuote {
  id: string
  docLabel: string
  section: string
  title: string
  page: number
  href: string
  text: string
  /** Phrases the snapshot builder re-checked on the PDF page. */
  checked: string[]
  rationaleSentences: string[]
  rationaleChecked: string[]
  rationale: string | null
  verified: boolean
}

function fromVol1(id: string, v1: Vol1Data): ReqQuote | null {
  const r = v1.requirements.find((x) => normReqId(x.id) === id)
  if (!r) return null
  return {
    id,
    docLabel: `NASA-STD-3001 Vol 1 Rev ${v1.document.revision}`,
    section: r.section,
    title: r.section_title,
    page: r.printed_page,
    href: `${v1.document.url}#page=${r.pdf_page_number}`,
    text: r.text,
    checked: r.checks.filter((c) => c.ok).map((c) => quotedPhrase(c.check)).filter((p): p is string => !!p && r.text.includes(p)),
    rationaleSentences: [],
    rationaleChecked: [],
    rationale: r.rationale,
    verified: r.verified,
  }
}

function fromVol2(id: string, v2: Vol2Data): ReqQuote | null {
  const r = v2.requirements.find((x) => normReqId(x.id) === id)
  if (!r) return null
  const rationaleChecked = r.checks.filter((c) => c.ok && c.in === 'rationale').map((c) => c.expect)
  return {
    id,
    docLabel: `NASA-STD-3001 Vol 2 Rev ${v2.document.revision}`,
    section: r.section,
    title: r.title,
    page: r.printed_page,
    href: `${v2.document.pdf_url}#page=${r.pdf_page}`,
    text: r.text,
    checked: r.checks.filter((c) => c.ok && c.in === 'text').map((c) => c.expect),
    rationaleSentences: sentencesContaining(r.rationale, rationaleChecked),
    rationaleChecked,
    rationale: r.rationale,
    verified: r.verified,
  }
}

function QuoteItem({ q }: { q: ReqQuote }) {
  return (
    <li className="lf-m-req">
      <p className="lf-m-req-head">
        <ReqId id={q.id} />
        <span className="lf-m-req-title">
          <span className="lf-mono">§{q.section}</span> {q.title}
        </span>
      </p>
      <Verbatim
        text={q.text}
        emphasize={q.checked}
        cite={
          <>
            {q.docLabel},{' '}
            <ExtLink href={q.href}>
              page <span className="lf-mono">{q.page}</span>
            </ExtLink>{' '}
            · <Verified ok={q.verified} />
          </>
        }
      />
      {q.rationaleSentences.map((s) => (
        <Verbatim key={s} lead="Rationale:" text={s} emphasize={q.rationaleChecked} />
      ))}
      {q.rationale && q.rationaleSentences.length > 0 ? (
        <Expander summary="Full rationale, verbatim">
          <p>
            <RichText text={q.rationale} />
          </p>
        </Expander>
      ) : null}
    </li>
  )
}

function SnapshotFooter({ v1, v2 }: { v1: SnapshotState<Vol1Data>; v2: SnapshotState<Vol2Data> }) {
  return (
    <>
      <span>Source:</span>
      {v1.data ? (
        <span>
          NASA-STD-3001 Vol 1 Rev {v1.data.document.revision}, approved <span className="lf-mono">{v1.data.document.date}</span>
        </span>
      ) : null}
      <FreshnessChip meta={v1.snapshot} status={v1.status} id="std_vol1_requirements" />
      {v2.data ? (
        <span>
          Vol 2 Rev {v2.data.document.revision}, approved <span className="lf-mono">{v2.data.document.approved}</span>
        </span>
      ) : null}
      <FreshnessChip meta={v2.snapshot} status={v2.status} id="std_vol2_requirements" />
    </>
  )
}

// Scoped to the standard (a program can still set numbers): the claim is about NASA-STD-3001.
const TITLE = 'NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health'

/** The principle text after its first clause (which the title already says), capitalised. */
function ledeOf(text: string): string {
  const m = /^[^.;]*publishes no numeric in-flight alert thresholds for crew health[.;]\s*/i.exec(text)
  const rest = m ? text.slice(m[0].length) : text
  return rest ? rest[0].toUpperCase() + rest.slice(1) : ''
}

export function GapSection({ meta }: { meta: MetaFile }) {
  const v1 = useSnapshot<Vol1Data>('std_vol1_requirements')
  const v2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const principle = meta.principles.find((p) => p.id === 'no_nasa_alert_thresholds')
  // The section title is the principle's first clause: show only what follows it.
  const lede = principle ? ledeOf(principle.text) : ''
  const ids = (principle?.requirement_ids ?? []).map(normReqId)
  const loading = v1.status === 'loading' || v2.status === 'loading'
  const volumeReadings = [v1.snapshot, v2.snapshot]
    .map((s) => s?.caveats.find((c) => /alert threshold/i.test(c) && !isBuildNote(c)))
    .filter((c): c is string => !!c)

  return (
    <FoldPanel
      s="gap"
      eyebrow="The gap"
      title={TITLE}
      abstract="Its alert requirements leave the number to the program. The requirements, verbatim, with the phrases checked on the PDF page."
      footer={<SnapshotFooter v1={v1} v2={v2} />}
    >
      {lede ? (
        <p className="lf-m-lede">
          <RichText text={lede} />
        </p>
      ) : null}
      <p>
        Every requirement below asks a system to alert the crew, and each one leaves the number to the program.
        Highlighted words are the phrases the snapshot builder re-checked on the PDF page.
      </p>
      {loading ? (
        <EmptyState kind="loading" title="Reading the frozen standards" headingLevel={3}>
          <p>Loading the verbatim requirement text from this build.</p>
        </EmptyState>
      ) : (
        <ol className="lf-m-reqs">
          {ids.map((id) => {
            const vol2 = id.startsWith('V2')
            const state = vol2 ? v2 : v1
            const snapId = vol2 ? 'std_vol2_requirements' : 'std_vol1_requirements'
            const q = state.data ? (vol2 ? fromVol2(id, state.data as Vol2Data) : fromVol1(id, state.data as Vol1Data)) : null
            if (!q) {
              return (
                <li key={id} className="lf-m-req">
                  <MissingNote>
                    <ReqId id={id} /> is not in snapshot <code>{snapId}.json</code>
                    {state.status !== 'ready' ? <> (snapshot {state.status})</> : null}, so this build cannot show its
                    text. Shown on purpose: <ReqId id="V2 10020" /> requires an indication when data is missing.
                  </MissingNote>
                </li>
              )
            }
            return <QuoteItem key={id} q={q} />
          })}
        </ol>
      )}
      {volumeReadings.length > 0 ? (
        <div className="lf-m-aside">
          <h3 className="lf-m-h4">The snapshot builder’s reading of each whole volume</h3>
          <p className="lf-m-small">LANDFALL’s words, from the snapshot caveats, not NASA text.</p>
          <ul className="lf-m-plain">
            {volumeReadings.map((c) => (
              <li key={c}>
                <RichText text={c} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <NearestList
        claim="alert_number"
        basis={volumeReadings.length > 0 ? 'the requirements and the volume reading above' : 'the requirements above'}
      />
    </FoldPanel>
  )
}
