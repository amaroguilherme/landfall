// "Find it in NASA's words" (#/method?s=find): a search over the 57 NASA-STD-3001 requirements LANDFALL froze.
// A search, not an ask: it shows NASA's own text, closest first, and nothing else (no reply, no summary, no score).
//   1. the symptom check (guard.ts), a fixed word list, on the raw words, before any search and with or without
//      the model;
//   2. "Your words appear in": BM25 over the same passages (bm25.ts), instant and offline from the first visit;
//   3. "Closest in meaning": potion-base-8M (embed.ts), fetched on the first search.
// It reads only the text in the box: no observation, no case, no event. Nothing else in LANDFALL reads its output.
import { useMemo, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { useSnapshot } from '../../app/data'
import { Button, Chip, Expander, Num, ReqId, UnavailableIcon } from '../../ui'
import type { Vol1Data, Vol2Data } from '../method/rules'
import { ExtLink, MissingNote, Path, RichText, Verbatim, Verified } from '../method/shared'
import accuracy from './accuracy.json'
import { STOPWORDS, buildIndex, hasUnreadable, keywordSearch, queryTerms } from './bm25'
import type { Bm25Index } from './bm25'
import { MODEL, MODEL_BYTES, embed, embedIds, ensureModel, modelState, rankByMeaning, strongestPieces, subscribeModel, tokenIds } from './embed'
import type { ModelState } from './embed'
import { GUARD_PHRASES, RED_FLAGS, TELL_CMO, URGENT_LABELS, guardBanners, refusalText } from './guard'
import type { GuardBanner } from './guard'
import { buildPassages, idJump, onlyIds } from './passages'
import type { Passage } from './passages'
import './find.css'

export const EXAMPLES = ['electric shock from a medical sensor', 'an outdated reading on a display', 'paper backup if the computers fail'] as const
const TOP = 3

const mb = (bytes: number): ReactNode => <Num value={Math.round(bytes / 1e5) / 10} digits={1} unit="MB" />

/** One requirement, verbatim: ID, section and title, statement, PDF page, snapshot; rationale collapsed. */
export function PassageCard({ p, note }: { p: Passage; note?: ReactNode }) {
  return (
    <li className="lf-m-req lf-find-card" data-req={p.id}>
      <p className="lf-m-req-head">
        <ReqId id={p.id} />
        <span className="lf-m-req-title">
          <span className="lf-mono">§{p.section}</span> {p.title}
        </span>
      </p>
      <Verbatim
        text={p.statement}
        cite={
          <>
            {p.docLabel},{' '}
            <ExtLink href={p.pdfHref}>
              page <span className="lf-mono">{p.printedPage}</span>
            </ExtLink>{' '}
            · <a href={`#/data?id=${p.snapshot}`}>snapshot</a> · <Verified ok={p.verified} />
          </>
        }
      />
      {p.rationale ? (
        <Expander summary="Rationale, verbatim">
          <p className="lf-find-rationale">
            <RichText text={p.rationale} />
          </p>
        </Expander>
      ) : null}
      {note ? <p className="lf-m-small lf-find-why">{note}</p> : null}
    </li>
  )
}

const quoted = (words: readonly string[]): string => words.map((w) => `“${w}”`).join(', ')

/** A banner's first sentence: the words that raised it. The search status reads it out too. */
export const bannerLead = (banner: GuardBanner): string => `Your words include ${quoted(banner.words)}.`

/**
 * What the status region, always in the page, announces after a search: the first sentence of each banner the
 * words raise (role="note" alone is not read out), then the query. Empty before the first search.
 */
export function searchStatus(query: string | null): string {
  if (!query) return ''
  return [...guardBanners(query).map(bannerLead), `Results for ${query}.`].join(' ')
}

/** The symptom check's banner: whom to tell (symptom words), or the rules' refusal, verbatim. */
export function GuardNote({ banner }: { banner: GuardBanner }) {
  if (banner.kind === 'symptom') {
    return (
      <div className="lf-find-guard" role="note" data-kind="symptom">
        <p>
          <strong>{bannerLead(banner)}</strong> This search reads NASA’s standard; it does not assess symptoms. If you
          have it now, {TELL_CMO ?? 'tell the Crew Medical Officer now'}.
        </p>
      </div>
    )
  }
  const text = refusalText(banner.kind)
  return (
    <div className="lf-find-guard" role="note" data-kind={banner.kind}>
      <UnavailableIcon size={16} />
      <p>
        <strong>{bannerLead(banner)}</strong> This search reads NASA’s standard.{' '}
        {text ? <RichText text={text} /> : null}
      </p>
    </div>
  )
}

/** What the meaning column has for this query. */
export interface Meaning {
  status: ModelState['status']
  error: string | null
  /** Closest first, with the query word pieces that pulled each one closest; null until the model is ready. */
  top: { passage: Passage; why: string[] }[] | null
}

function MeaningColumn({ meaning }: { meaning: Meaning }) {
  let body: ReactNode
  if (meaning.top) {
    body = meaning.top.length ? (
      <ol className="lf-m-reqs">
        {meaning.top.map(({ passage, why }) => (
          <PassageCard
            key={passage.id}
            p={passage}
            note={
              why.length ? (
                <>
                  Why it ranked here: your word pieces{' '}
                  {why.map((w, i) => (
                    <span key={w}>
                      {i ? ', ' : ''}
                      <code className="lf-m-path">{w}</code>
                    </span>
                  ))}{' '}
                  point most toward it.
                </>
              ) : null
            }
          />
        ))}
      </ol>
    ) : (
      <p className="lf-m-small">None of your word pieces is in the model’s vocabulary, so it cannot rank them.</p>
    )
  } else if (meaning.status === 'offline') {
    body = (
      <MissingNote>
        The meaning ranking is not on this device yet ({mb(MODEL_BYTES)}, downloaded once when online); the keyword column and the symptom
        check work without it.
      </MissingNote>
    )
  } else if (meaning.status === 'error') {
    body = (
      <MissingNote>
        The meaning ranking could not load ({meaning.error ?? 'unknown error'}); the keyword column and the symptom check work without it.
      </MissingNote>
    )
  } else {
    body = (
      <p className="lf-m-small" role="status">
        Loading the model ({mb(MODEL_BYTES)}, once; then it works offline)…
      </p>
    )
  }
  return (
    <section className="lf-find-col" aria-labelledby="lf-find-mm-h" data-col="meaning">
      <h3 id="lf-find-mm-h" className="lf-m-h4">
        Closest in meaning
      </h3>
      <p className="lf-m-small">
        Ranked by a small open model, {MODEL.name}: the closest text first. You read it and judge.
      </p>
      {body}
    </section>
  )
}

/** Everything below the search box for one query: banners, an ID match, then the two columns. */
export function Results({ query, passages, index, meaning }: { query: string; passages: readonly Passage[]; index: Bm25Index; meaning: Meaning }) {
  const banners = guardBanners(query)
  const jump = idJump(query, passages)
  const { terms, skipped } = queryTerms(query)
  const hits = keywordSearch(index, query).slice(0, TOP)
  // True only when every typed word is a skipped common word: none searched, none outside a-z 0-9 (Cyrillic, CJK, emoji).
  const onlyCommon = !terms.length && skipped.length > 0 && !hasUnreadable(query)
  return (
    <div className="lf-find-results">
      {banners.map((b) => (
        <GuardNote key={b.kind} banner={b} />
      ))}
      {jump.length ? (
        <section className="lf-find-jump" aria-labelledby="lf-find-id-h">
          <h3 id="lf-find-id-h" className="lf-m-h4">
            {jump.length > 1 ? 'The requirements you named' : 'The requirement you named'}
          </h3>
          <ol className="lf-m-reqs">
            {jump.map((p) => (
              <PassageCard key={p.id} p={p} />
            ))}
          </ol>
        </section>
      ) : null}
      {onlyIds(query, passages) ? (
        <p className="lf-m-small">Your words are only a requirement ID, so there is nothing to rank: add words to search.</p>
      ) : (
        <div className="lf-find-cols">
          <section className="lf-find-col" aria-labelledby="lf-find-kw-h" data-col="keywords">
            <h3 id="lf-find-kw-h" className="lf-m-h4">
              Your words appear in
            </h3>
            <p className="lf-m-small">
              Keyword search, no model: passages ranked by how often they use your words, rare words counting more.
              {skipped.length ? <> Skipped as common: {skipped.join(', ')}.</> : null}
            </p>
            {hits.length ? (
              <ol className="lf-m-reqs">
                {hits.map((h) => (
                  <PassageCard key={passages[h.index].id} p={passages[h.index]} note={<>Your words in it: {h.matched.join(', ')}.</>} />
                ))}
              </ol>
            ) : onlyCommon ? (
              <p className="lf-m-small">Only common words, which the keyword search skips.</p>
            ) : (
              <p className="lf-find-none">None of your words appear in them.</p>
            )}
          </section>
          <MeaningColumn meaning={meaning} />
        </div>
      )}
    </div>
  )
}

function WordList({ title, words }: { title: string; words: readonly string[] }) {
  return (
    <p className="lf-m-small lf-find-words">
      <strong>{title}:</strong> {words.join('; ')}.
    </p>
  )
}

/** The fixed lists the page runs on, printed: the symptom check's words and the stopwords. */
export function Lists() {
  return (
    <>
      <Expander summary="The symptom check’s words">
        <p>
          <Chip kind="design choice" /> A fixed list, matched on your words before any search, with or without the model. It ignores
          negation, so “no blood in my urine” still raises the banner. Symptom words ask you to tell your Crew Medical Officer; medication,
          diagnosis and cancer-risk words show the refusal written in the rules.
        </p>
        <WordList title="Renal-stone red flags, from the renal-stone case’s step r4 (engine/rules/cases.json)" words={RED_FLAGS} />
        <WordList title="Urgent symptoms, from the Noon Sight" words={URGENT_LABELS} />
        <WordList title="Other symptom words" words={GUARD_PHRASES.symptom.slice(RED_FLAGS.length + URGENT_LABELS.length)} />
        <WordList title="Medication words (no dosing advice)" words={GUARD_PHRASES.no_dosing} />
        <WordList title="Diagnosis words (no diagnosis)" words={GUARD_PHRASES.no_diagnosis} />
        <WordList title="Cancer-risk words (no personal REID model)" words={GUARD_PHRASES.no_reid} />
      </Expander>
      <Expander summary="Words the keyword search skips">
        <p>
          <Chip kind="design choice" /> Common words carry no topic, so the keyword column does not search for them. Words are not
          stemmed: “limits” does not match “limit”.
        </p>
        <WordList title="Skipped" words={STOPWORDS} />
      </Expander>
    </>
  )
}

/** How the columns are made and how well they did on questions written before the first run. */
export function Footnote() {
  const n = accuracy.queries
  const row = (label: string, r: { top1: number; top3: number }) => (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">
        <Num value={r.top1} /> of <Num value={n} />
      </td>
      <td className="num">
        <Num value={r.top3} /> of <Num value={n} />
      </td>
    </tr>
  )
  return (
    <div className="lf-m-aside lf-find-foot">
      <h3 className="lf-m-h4">How the columns rank</h3>
      <p className="lf-m-small">
        <strong>Closest in meaning</strong> uses {MODEL.name} by {MODEL.publisher} (<ExtLink href={MODEL.url}>{MODEL.repo}</ExtLink>,{' '}
        {MODEL.licence}, revision <span className="lf-mono">{MODEL.revision.slice(0, 8)}</span>). This is an 8-bit copy of{' '}
        {mb(MODEL_BYTES)}, a table of word-piece vectors that cannot write text. It comes from this site on your first search and then works
        offline. It ranks NASA’s sentences against your words. It writes nothing, decides nothing and reads no crew data, and nothing else
        in LANDFALL uses its output. Its tokenizer is written for this page and tested equal to the original (<Path>tools/find/README.md</Path>).{' '}
        <strong>Your words appear in</strong> is a keyword count (BM25), with no model. The symptom check is a fixed word list, not the model.
      </p>
      <p className="lf-m-small">
        Tested on <Num value={n} /> questions written by {accuracy.written_by} (<Path>gold.json</Path>, SHA-256{' '}
        <span className="lf-mono">{accuracy.gold_sha256.slice(0, 12)}</span>…): the column held one of the requirements the question was
        written for.
      </p>
      <div className="lf-m-tablewrap">
        <table className="lf-m-table lf-find-acc">
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col" className="num">
                First
              </th>
              <th scope="col" className="num">
                In the top three
              </th>
            </tr>
          </thead>
          <tbody>
            {row('Your words appear in (keywords)', accuracy.keywords)}
            {row('Closest in meaning (model)', accuracy.meaning)}
            {row('Either column', accuracy.either)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The search's live region: in the page from the start, so a screen reader announces what each search changes. */
export function SearchStatus({ query }: { query: string | null }) {
  return (
    <p className="sr-only" role="status" data-find-status="">
      {searchStatus(query)}
    </p>
  )
}

export default function FindSection() {
  const v1 = useSnapshot<Vol1Data>('std_vol1_requirements')
  const v2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const passages = useMemo(() => buildPassages(v1.data, v2.data), [v1.data, v2.data])
  const index = useMemo(() => buildIndex(passages.map((p) => p.text)), [passages])
  const [text, setText] = useState('')
  const [query, setQuery] = useState<string | null>(null)
  const ms = useSyncExternalStore(subscribeModel, modelState, modelState)
  // The passages' vectors, once per model (a few milliseconds).
  const vectors = useMemo(() => (ms.model && passages.length ? passages.map((p) => embed(p.text, ms.model!)) : null), [ms.model, passages])
  const meaning = useMemo<Meaning>(() => {
    if (!query || !ms.model || !vectors) return { status: ms.status, error: ms.error, top: null }
    const model = ms.model
    const ids = tokenIds(query, model)
    if (!ids.length) return { status: 'ready', error: null, top: [] }
    const order = rankByMeaning(embedIds(ids, model), vectors).slice(0, TOP)
    return { status: 'ready', error: null, top: order.map((i) => ({ passage: passages[i], why: strongestPieces(ids, vectors[i], model) })) }
  }, [query, ms, vectors, passages])

  const run = (q: string) => {
    const t = q.trim()
    if (!t) return
    setText(q)
    setQuery(t)
    // The first search with words fetches the model; a failed fetch is retried by the next one.
    if (!onlyIds(t, passages)) void ensureModel()
  }
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    run(text)
  }

  if (!v1.data || !v2.data) {
    return v1.status === 'loading' || v2.status === 'loading' ? (
      <p className="lf-m-small" role="status">
        Reading the frozen requirements…
      </p>
    ) : (
      <MissingNote>
        The frozen requirements did not load (<Path>std_vol1_requirements.json</Path>, <Path>std_vol2_requirements.json</Path>), so there is
        nothing to search.
      </MissingNote>
    )
  }
  return (
    <div className="lf-find">
      <p className="lf-m-lede">Paste any sentence, a chatbot’s included: you read NASA’s closest text and judge.</p>
      <form className="lf-find-form" role="search" onSubmit={onSubmit}>
        <label htmlFor="lf-find-q" className="lf-find-label">
          Find it in NASA’s words (search, not ask)
        </label>
        <div className="lf-find-row">
          <input
            id="lf-find-q"
            className="lf-find-input"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="A question, or a sentence to check"
            autoComplete="off"
            enterKeyHint="search"
          />
          <Button type="submit">Search</Button>
        </div>
      </form>
      <div className="lf-find-examples">
        <span className="lf-m-small">Try:</span>
        {EXAMPLES.map((x) => (
          <Button key={x} variant="secondary" onClick={() => run(x)}>
            {x}
          </Button>
        ))}
      </div>
      <p className="lf-m-small">
        These are the <Num value={passages.length} /> requirements LANDFALL froze, not the whole standard:{' '}
        <ExtLink href={v1.data.document.url}>NASA-STD-3001 Vol 1 Rev {v1.data.document.revision}</ExtLink> and{' '}
        <ExtLink href={v2.data.document.pdf_url}>Vol 2 Rev {v2.data.document.revision}</ExtLink> (PDF).
      </p>
      <SearchStatus query={query} />
      {query ? <Results query={query} passages={passages} index={index} meaning={meaning} /> : null}
      <Lists />
      <Footnote />
    </div>
  )
}
