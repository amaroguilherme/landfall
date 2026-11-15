// The closest NASA comes. Beside a claim of absence (a searched negative on #/band, the alert-number gap on
// #/method?s=gap), the five NASA-STD-3001 requirements that a small open model ranked closest in meaning to
// one sentence we wrote. The ranking ran once, at build time (tools/nearest/rank.py), and is frozen in
// nearest.json: no model runs here, no score is stored or shown, only the rank. The statements are NASA's
// words, verbatim. The keyword count or reading beside the list stays the claim; the list only adds passages
// to read. A note (notes.json) is LANDFALL's own sentence, shown only where the review found a passage that
// weakens or contradicts the claim.
import { Link } from '../../app/location'
import { Expander, ReqId } from '../../ui'
import { CheckGlyph, ExtLink, RichText, Verbatim } from '../method/shared'
import rawCoverage from './coverage.json'
import raw from './nearest.json'
import rawNotes from './notes.json'
import './nearest.css'

export interface NearestItem {
  rank: number
  id: string
  doc: string
  section: string
  title: string
  statement: string
  pdf_page: number
  pdf_url: string
  /** One of the 57 requirements the NASA snapshots freeze and verify. */
  frozen: boolean
  /** LANDFALL already names this requirement beside the claim (sensor-map.json, or the gap section). */
  also_named_by_us: boolean
}

export interface NearestClaim {
  claim_id: string
  query: string
  model: string
  revision: string
  sha256: string
  corpus_size: number
  items: NearestItem[]
  skipped: { id: string; position: number; reason: string }[]
}

interface LabelledItem {
  claim_id: string
  id: string
  model_rank: number
  shown: boolean
}

export interface NearestFile {
  corpus: { doc: string; count: number }[]
  labelled_check: { in_top_five: number; of: number; items: LabelledItem[] }
  claims: NearestClaim[]
}

export interface NearestNote {
  claim_id: string
  /** The shown requirement the note is about; it renders under that card. */
  about: string
  text: string
  quotes: { id: string; in: 'statement' | 'rationale'; text: string }[]
}

/** How many requirements a volume defines, and those its ranking leaves out (coverage.json, recounted in the PDFs by test). */
export interface CoverageVolume {
  doc: string
  requirements: number
  /** Requirements the volume defines that LANDFALL's PDF parsers miss, so the model never ranked them. */
  not_ranked: string[]
}

export const NEAREST = raw as unknown as NearestFile
export const NEAREST_NOTES: readonly NearestNote[] = (rawNotes as unknown as { notes: NearestNote[] }).notes
export const COVERAGE: readonly CoverageVolume[] = (rawCoverage as unknown as { volumes: CoverageVolume[] }).volumes

/** The day the passages that are not frozen in a snapshot were read against their PDF pages (review.json). */
export const CHECKED_ON = '15 Nov 2026'
export const CHECKED_LABEL = `checked against the PDF page, ${CHECKED_ON}`
export const NAMED_LABEL = 'also named above'
/**
 * The requirements the two NASA-STD-3001 snapshots freeze, which Find it in NASA's words searches (not the 543
 * ranked here). nearest.test.ts recounts the distinct requirement IDs in the two snapshots; find.test.ts pins the
 * search's passages at the same 57.
 */
export const FROZEN_COUNT = 57
export const FIND_LINK = `Search the ${FROZEN_COUNT} requirements LANDFALL froze, in your own words →`
/** Who read the passages that are not frozen against their PDF pages (review.json "reviewer"). */
export const CHECKED_TITLE =
  'Cut from the PDF by the same parser as the snapshots and read against its PDF page by a Claude Code review agent (tools/nearest/review.json)'

const COUNT_WORD: Record<number, string> = { 3: 'three', 4: 'four', 5: 'five' }

export function nearestClaim(claim: string): NearestClaim | undefined {
  return NEAREST.claims.find((c) => c.claim_id === claim)
}

export function summaryFor(c: NearestClaim): string {
  const n = COUNT_WORD[c.items.length] ?? String(c.items.length)
  return `The ${n} requirements closest in meaning (ranked by a model: a ranking, not proof)`
}

/** Read by screen readers after the summary, so each list's disclosure has its own name: the sentence ranked against. */
export function summarySuffix(c: NearestClaim): string {
  return `, to our sentence “${c.query}”`
}

/** "NASA-STD-3001 Vol 2 Rev F" -> "Vol 2 Rev F" (the card already sits under a NASA-STD-3001 claim). */
function shortDoc(doc: string): string {
  return doc.replace(/^NASA-STD-3001\s+/, '')
}

/** 'verified' for the 57 frozen requirements; the review date for the others (a check mark either way). */
function CheckBadge({ frozen }: { frozen: boolean }) {
  return (
    <span
      className="lf-m-verified lf-near-check"
      title={frozen ? 'Frozen in a LANDFALL snapshot of the standard and re-checked on its PDF page at build' : CHECKED_TITLE}
    >
      <CheckGlyph />
      {frozen ? (
        <span>verified</span>
      ) : (
        <span>
          checked against the PDF page, <span className="lf-mono lf-near-date">{CHECKED_ON}</span>
        </span>
      )}
    </span>
  )
}

function Card({ it, note }: { it: NearestItem; note: NearestNote | undefined }) {
  return (
    <li className="lf-near-item" data-req={it.id}>
      <p className="lf-near-head">
        <ReqId id={it.id} />
        <span className="lf-near-title">
          <span className="lf-mono">§{it.section}</span> {it.title}
        </span>
      </p>
      <Verbatim
        text={it.statement}
        cite={
          <>
            {shortDoc(it.doc)},{' '}
            <ExtLink href={it.pdf_url}>
              PDF p. <span className="lf-mono">{it.pdf_page}</span>
            </ExtLink>
            {' · '}
            <CheckBadge frozen={it.frozen} />
            {it.also_named_by_us ? (
              <>
                {' · '}
                <span className="lf-near-tag" title="LANDFALL already names this requirement beside the claim, above, before any model ran">
                  {NAMED_LABEL}
                </span>
              </>
            ) : null}
          </>
        }
      />
      {note ? (
        <p className="lf-near-note">
          <span className="lf-near-note-lead">LANDFALL’s note:</span> <RichText text={note.text} />
        </p>
      ) : null}
    </li>
  )
}

/** Hand-named requirements for this claim that the model did not put in the shown list, with their rank. */
function missedHere(claim: string): LabelledItem[] {
  return NEAREST.labelled_check.items.filter((h) => h.claim_id === claim && !h.shown)
}

/**
 * Shown passages tagged 'also named above' that the labelled check does not count: the page names them, but only in
 * a volume reading (the snapshot's caveat), not by hand beside the claim. Today: [V2 6153] on #/method?s=gap.
 */
export function namedNotLabelled(c: NearestClaim): string[] {
  const labelled = new Set(NEAREST.labelled_check.items.filter((h) => h.claim_id === c.claim_id).map((h) => h.id))
  return c.items.filter((it) => it.also_named_by_us && !labelled.has(it.id)).map((it) => it.id)
}

/**
 * The frozen model ranking for one claim, as a closed Expander: NASA's statements, closest first, each with
 * its PDF page and how it was checked. Renders nothing for an unknown claim.
 */
export function NearestList({ claim, basis = 'the keyword search above' }: { claim: string; basis?: string }) {
  const c = nearestClaim(claim)
  if (!c) return null
  const notes = NEAREST_NOTES.filter((n) => n.claim_id === claim)
  const shown = new Set(c.items.map((it) => it.id))
  const loose = notes.filter((n) => !shown.has(n.about))
  const lc = NEAREST.labelled_check
  const missed = missedHere(claim)
  const unlabelled = namedNotLabelled(c)
  const corpus = NEAREST.corpus
  const defined = COVERAGE.reduce((sum, v) => sum + v.requirements, 0)
  const notRanked = COVERAGE.flatMap((v) => v.not_ranked)
  return (
    <div className="lf-near" data-claim={claim}>
      <Expander
        summary={
          <>
            {summaryFor(c)}
            <span className="sr-only">{summarySuffix(c)}</span>
          </>
        }
      >
        <p className="lf-near-lede">
          NASA’s words, verbatim, closest in meaning first. A model ranked them at build time and wrote none of them.
          They are the passages to read before trusting the claim, which still rests on {basis}.
        </p>
        <ol className="lf-near-list">
          {c.items.map((it) => (
            <Card key={it.id} it={it} note={notes.find((n) => n.about === it.id)} />
          ))}
        </ol>
        {loose.map((n) => (
          <p key={n.about} className="lf-near-note">
            <span className="lf-near-note-lead">LANDFALL’s note:</span> <RichText text={n.text} />
          </p>
        ))}
        <p className="lf-near-foot">
          <Link to="/method?s=find">{FIND_LINK}</Link>
        </p>
        {c.skipped.length > 0 ? (
          <p className="lf-near-foot">
            Not shown, though ranked higher:{' '}
            {c.skipped.map((s, i) => (
              <span key={s.id}>
                {i > 0 ? '; ' : null}
                <ReqId id={s.id} /> ({s.reason})
              </span>
            ))}
            .
          </p>
        ) : null}
        <p className="lf-near-foot">
          Ranked at build time by {c.model.split('/').pop()} (MinishLab, revision{' '}
          <span className="lf-mono">{c.revision.slice(0, 8)}</span>) over{' '}
          <span className="lf-mono">{c.corpus_size}</span> of the <span className="lf-mono">{defined}</span> requirements
          of NASA-STD-3001 (
          {corpus.map((s, i) => (
            <span key={s.doc}>
              {i > 0 ? ', ' : null}
              <span className="lf-near-vol">
                <span className="lf-mono">{s.count}</span> of{' '}
                <span className="lf-mono">{COVERAGE.find((v) => v.doc === s.doc)?.requirements}</span> in {shortDoc(s.doc)}
              </span>
            </span>
          ))}
          ), by closeness in meaning to one sentence we wrote before the run: “{c.query}” Only the rank is kept.
          {notRanked.length > 0 ? (
            <>
              {' '}
              Not ranked:{' '}
              {notRanked.map((id, i) => (
                <span key={id}>
                  {i > 0 ? (i === notRanked.length - 1 ? ' and ' : ', ') : null}
                  <ReqId id={id} />
                </span>
              ))}
              , which LANDFALL’s PDF parsers miss.
            </>
          ) : null}
        </p>
        <p className="lf-near-foot">
          Labelled check: of the <span className="lf-mono">{lc.of}</span> requirements we had named by hand beside
          these claims, <span className="lf-mono">{lc.in_top_five}</span> {lc.in_top_five === 1 ? 'is' : 'are'} in the
          model’s top five.
          {unlabelled.length > 0 ? (
            <>
              {' '}
              {unlabelled.map((id, i) => (
                <span key={id}>
                  {i > 0 ? ', ' : null}
                  <ReqId id={id} />
                </span>
              ))}{' '}
              {unlabelled.length === 1 ? 'is' : 'are'} named above only in the volume reading, not by hand, so{' '}
              {unlabelled.length === 1 ? 'it is' : 'they are'} not one of the <span className="lf-mono">{lc.of}</span>.
            </>
          ) : null}
          {missed.length > 0 ? (
            <>
              {' '}
              Named by hand for this claim and ranked lower:{' '}
              {missed.map((h, i) => (
                <span key={h.id}>
                  {i > 0 ? ', ' : null}
                  <ReqId id={h.id} /> at rank <span className="lf-mono">{h.model_rank}</span>
                </span>
              ))}
              .
            </>
          ) : null}{' '}
          Method and rebuild: <span className="lf-mono lf-near-path">tools/nearest/README.md</span>.
        </p>
      </Expander>
    </div>
  )
}
