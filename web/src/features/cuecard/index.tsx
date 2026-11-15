// #/card/:id (one case) and #/card or #/cards (all of them, one per page): printable paper cue cards for when
// the LANDFALL display is lost ([V2 10130]). The card content is built only from the shipped rules by
// model.ts (cueCard); this view renders those atoms and nothing else on the paper. On screen it is a paper-style
// preview with a Print button; in print only the paper shows, black on white, one card per page.
// The route CSS stays in the document after the view unmounts (lazy chunks are prefetched into every page),
// so every print rule is scoped under html[data-print='cuecard'], which this view sets while it is mounted.
import { useEffect, useMemo } from 'react'
import { RULES, formatMet } from '../../app/engine'
import type { CaseDef } from '../../app/engine'
import { useSnapshot } from '../../app/data'
import type { FeatureProps } from '../../app/router'
import { MET_NOW_S } from '../../app/scenario'
import { Button, EmptyState, FreshnessChip, SeverityIcon } from '../../ui'
import { DigestText, useRulesDigest } from './PrintLink'
import { binderOrder, cueCard, notBuiltReason, srcKey } from './model'
import type { Atom, CueCard, CueCardOptions, StepInput, TriggerLine, Vol2Snapshot } from './model'
import './cuecard.css'

// =============================================================================================
// Paper: atoms only
// =============================================================================================

/** One atom: its text, tagged with its source (a DOM check finds any text that is not an atom). */
function A({ a }: { a: Atom }) {
  return <span data-src={srcKey(a.src)}>{a.text}</span>
}

function Atoms({ list }: { list: readonly Atom[] }) {
  return (
    <>
      {list.map((a, i) => (
        <A key={i} a={a} />
      ))}
    </>
  )
}

/** Space-separated atoms. */
function Words({ list }: { list: readonly Atom[] }) {
  return (
    <>
      {list.map((a, i) => (
        <span key={i}>
          {i ? ' ' : null}
          <A a={a} />
        </span>
      ))}
    </>
  )
}

/** An empty write-in box (paper only; screen readers hear the unit next to it). */
const Box = ({ kind }: { kind?: 'met' | 'tick' | 'cell' }) => <span className="lf-cue-box" data-kind={kind} aria-hidden="true" />

function RequiredIcon() {
  return (
    <svg className="lf-cue-icon" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="13" height="13" fill="currentColor" />
      <path d="M8 4v5" stroke="#fff" strokeWidth="2" strokeLinecap="square" />
      <rect x="7" y="10.6" width="2" height="2" fill="#fff" />
    </svg>
  )
}

function FlagIcon() {
  return (
    <svg className="lf-cue-icon" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">
      <path d="M3 1.5v13" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.8 2h9.7l-2.4 3.6 2.4 3.6H3.8z" fill="currentColor" />
    </svg>
  )
}

function WriteIn({ input, cell = false }: { input: StepInput; cell?: boolean }) {
  if (input.kind === 'yesno') {
    return (
      <span className="lf-cue-write" data-kind="yesno">
        <Box kind="tick" /> <A a={input.yes} /> <Box kind="tick" /> <A a={input.no} />
      </span>
    )
  }
  if (input.kind === 'met') {
    return (
      <span className="lf-cue-write" data-kind="met">
        <A a={input.unit} /> <Box kind="met" />
        {cell ? null : (
          <>
            {' '}
            <span className="lf-cue-cue">
              <A a={input.cue} />
            </span>
          </>
        )}
      </span>
    )
  }
  return (
    <span className="lf-cue-write" data-kind="value">
      <Box /> <A a={input.unit} />
    </span>
  )
}

function Trigger({ t, inlineBasis }: { t: TriggerLine; inlineBasis: boolean }) {
  return (
    <li className="lf-cue-trigger" data-severity={t.severity}>
      <span className="lf-cue-sev">
        <SeverityIcon severity={t.severity} size={13} /> <A a={t.sevWord} />
      </span>{' '}
      <Words list={t.parts} />
      {t.chip ? (
        <>
          {' '}
          <span className="lf-cue-chip">
            <A a={t.chip} />
          </span>
        </>
      ) : null}
      {t.note ? (
        <>
          {' '}
          <span className="lf-cue-noteref">
            <A a={t.note} />
          </span>
        </>
      ) : null}
      {/* The basis backs the limit on this line: printed right under it, before any LANDFALL watch level (a design choice). */}
      {inlineBasis && t.basis.length ? (
        <span className="lf-cue-basis">
          <Atoms list={t.basis} />
        </span>
      ) : null}
      {t.approach ? (
        <span className="lf-cue-approach">
          <span className="lf-cue-sev">
            <SeverityIcon severity={t.approach.severity} size={13} /> <A a={t.approach.sevWord} />
          </span>{' '}
          <Words list={t.approach.parts} />
          {t.approach.chip ? (
            <>
              {' '}
              <span className="lf-cue-chip">
                <A a={t.approach.chip} />
              </span>
            </>
          ) : null}
        </span>
      ) : null}
    </li>
  )
}

/** A section heading run into its first line ("TRIPWIRE Reassess at ..."): saves a line per section on paper. */
function H({ a }: { a: Atom }) {
  return (
    <span className="lf-cue-h">
      <A a={a} />
    </span>
  )
}

/** One cue card, as paper. Pure: renders the atoms of `card` and nothing else. */
export function CueCardView({ card }: { card: CueCard }) {
  const titleId = `lf-cue-title-${card.caseId}`
  const footnotes = card.basisPlacement === 'footnote' ? card.triggers.filter((t) => t.note && t.basis.length) : []
  return (
    <article className="lf-cue-paper" aria-labelledby={titleId} data-case={card.caseId} data-crew-wide={card.crewWide || undefined}>
      <p className="lf-cue-band">
        <strong className="lf-cue-header">
          <A a={card.header} />
        </strong>
        {card.quote ? (
          <>
            {' '}
            <q>
              <A a={card.quote.text} />
            </q>{' '}
            <span className="lf-cue-cite">
              <Atoms list={card.quote.source} />
            </span>
          </>
        ) : null}
      </p>
      <h2 id={titleId} className="lf-cue-title">
        <A a={card.title} />
      </h2>
      <p className="lf-cue-oneline">
        <A a={card.oneLine} />
      </p>

      <section className="lf-cue-sec">
        <h3 className="lf-cue-h3">
          <A a={card.headings.opensWhen} />
        </h3>
        <ul className="lf-cue-triggers">
          {card.triggers.map((t) => (
            <Trigger key={t.ref} t={t} inlineBasis={card.basisPlacement === 'inline'} />
          ))}
        </ul>
      </section>

      <p className="lf-cue-primary">
        <H a={card.headings.doNow} /> <A a={card.primary} />
      </p>

      <section className="lf-cue-sec">
        <h3 className="lf-cue-h3">
          <A a={card.headings.steps} />
        </h3>
        <ol className="lf-cue-steplist">
          {card.steps.map((s) => (
            <li key={s.id} className="lf-cue-step" data-required={s.tags.some((x) => x.kind === 'required') || undefined}>
              <span className="lf-cue-n">
                <A a={s.n} />
              </span>
              <div className="lf-cue-stepbody">
                <p className="lf-cue-steptext">
                  <A a={s.text} />
                  {s.tags.map((tag) => (
                    <span key={tag.kind}>
                      {' '}
                      <span className="lf-cue-tag" data-kind={tag.kind}>
                        {tag.kind === 'required' ? <RequiredIcon /> : <FlagIcon />} <A a={tag.text} />
                      </span>
                    </span>
                  ))}
                  {s.input && !s.input.perCrew ? (
                    <>
                      {' '}
                      <WriteIn input={s.input} />
                    </>
                  ) : null}
                  {s.perCrewHint ? (
                    <>
                      {' '}
                      <span className="lf-cue-hint">
                        <A a={s.perCrewHint} />
                      </span>
                    </>
                  ) : null}
                </p>
                {s.redFlags.length ? (
                  <ul className="lf-cue-redflags">
                    {s.redFlags.map((r, i) => (
                      <li key={i}>
                        <Box kind="tick" /> <A a={r} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {card.crewTable ? (
          <div className="lf-cue-tablewrap">
            <table className="lf-cue-crew">
              <thead>
                <tr>
                  <th scope="col">
                    <A a={card.crewTable.head} />
                  </th>
                  {card.crewTable.columns.map((c) => (
                    <th key={c.stepId} scope="col">
                      <A a={c.step} /> <A a={c.n} /> <A a={c.input.unit} />
                      {c.input.kind === 'met' ? (
                        <>
                          {' '}
                          <span className="lf-cue-cue">
                            <A a={c.input.cue} />
                          </span>
                        </>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card.crewTable.rows.map((r) => (
                  <tr key={r.id.text}>
                    <th scope="row">
                      <A a={r.id} /> <A a={r.role} />
                    </th>
                    {card.crewTable!.columns.map((c) => (
                      <td key={c.stepId}>{c.input.kind === 'yesno' ? <WriteIn input={c.input} cell /> : <Box kind="cell" />}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="lf-cue-cols">
        <section className="lf-cue-sec">
          <p>
            <H a={card.headings.tripwire} /> <A a={card.tripwire} />
          </p>
        </section>
        <section className="lf-cue-sec">
          <h3 className="lf-cue-h3">
            <A a={card.headings.escalate} />
          </h3>
          <ol className="lf-cue-tiers">
            {card.tiers.map((t, i) => (
              <li key={i}>
                <span className="lf-cue-tiern">
                  <A a={t.tier} />
                </span>{' '}
                <span className="lf-cue-tierlabel">
                  <A a={t.label} />
                </span>
                {t.when ? (
                  <>
                    {' '}
                    <A a={t.when} />
                  </>
                ) : null}
                {t.backups.map((b, j) => (
                  <span key={j} className="lf-cue-backup">
                    <span className="lf-cue-tierlabel">
                      <A a={b.label} />
                    </span>
                    {b.when ? (
                      <>
                        {' '}
                        <A a={b.when} />
                      </>
                    ) : null}
                    {b.applies ? (
                      <>
                        {' '}
                        <span className="lf-cue-applies">
                          <A a={b.applies} />
                        </span>
                      </>
                    ) : null}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="lf-cue-sec">
        <h3 className="lf-cue-h3">
          <A a={card.headings.refusals} />
        </h3>
        <ul className="lf-cue-refusals">
          {card.refusals.map((r, i) => (
            <li key={i}>
              <A a={r} />
            </li>
          ))}
        </ul>
      </section>

      {footnotes.length ? (
        <p className="lf-cue-sec lf-cue-notes">
          <H a={card.headings.basis} />
          {footnotes.map((t) => (
            <span key={t.ref} className="lf-cue-note">
              {' '}
              <span className="lf-cue-noteref">
                <A a={t.note!} />
              </span>{' '}
              <Atoms list={t.basis} />
            </span>
          ))}
        </p>
      ) : null}

      <footer className="lf-cue-foot">
        <p>
          <A a={card.digest} />
        </p>
        <p className="lf-cue-footer">
          <A a={card.footer} />
        </p>
      </footer>
    </article>
  )
}

// =============================================================================================
// Route
// =============================================================================================

interface Vol2Req {
  id?: string
  text?: string
  rationale?: string
  section?: string
  pdf_page?: number
}

/** The UTC day the card is built (shown on the card as "built <date>"). */
const today = () => new Date().toISOString().slice(0, 10)

export default function CueCards({ params, query }: FeatureProps) {
  // Print rules apply only while this view is mounted (see the file header).
  useEffect(() => {
    const html = document.documentElement
    html.dataset.print = 'cuecard'
    return () => {
      if (html.dataset.print === 'cuecard') delete html.dataset.print
    }
  }, [])
  const vol2 = useSnapshot<Vol2Snapshot['data']>('std_vol2_requirements')
  const digest = useRulesDigest()
  const date = useMemo(today, [])
  const defs = (RULES.cases?.cases ?? []) as CaseDef[]
  const single = params.id ?? null
  const def = single ? defs.find((c) => c.id === single) ?? null : null

  const built = useMemo(() => {
    const snapshots = { std_vol2_requirements: vol2.snapshot as Vol2Snapshot | null }
    // ?basis=inline|footnote overrides where trigger bases print (layout check: scripts/print-card.mjs).
    const asked = query.basis
    const basisPlacement: CueCardOptions['basisPlacement'] = asked === 'inline' ? 'inline' : asked === 'footnote' ? 'footnote' : undefined
    const opts = { digest: digest.hex, date, metExample: formatMet(MET_NOW_S), basisPlacement }
    const out: Array<{ id: string; card: CueCard | null; error: string | null }> = []
    for (const d of single ? (def ? [def] : []) : defs) {
      try {
        out.push({ id: d.id, card: cueCard(d, RULES, snapshots, opts), error: null })
      } catch (e) {
        // The "not built" block prints too: never with the text a never-print refusal quotes.
        out.push({ id: d.id, card: null, error: notBuiltReason((e as Error).message) })
      }
    }
    const ok = binderOrder(out.filter((x) => x.card).map((x) => x.card!))
    return { cards: ok, errors: out.filter((x) => x.error) }
  }, [vol2.snapshot, digest.hex, date, single, def, defs, query.basis])

  if (single && !def) {
    return (
      <EmptyState kind="unavailable" title="No such cue card" headingLevel={1}>
        <p>
          <code>{single}</code> is not one of LANDFALL’s cases. Cue cards:{' '}
          {defs.map((c, i) => (
            <span key={c.id}>
              {i ? ', ' : ''}
              <a href={`#/card/${c.id}`}>{c.title ?? c.id}</a>
            </span>
          ))}
          , or <a href="#/cards">all of them</a>.
        </p>
      </EmptyState>
    )
  }

  const req = vol2.data?.requirements?.find((r) => r.id === '[V2 10130]') as Vol2Req | undefined
  const ready = digest.status !== 'loading' && vol2.status !== 'loading'
  const title = def ? `Cue card: ${def.title ?? def.id}` : 'Cue cards'

  return (
    <div className="lf-cue" data-cuecard-ready={ready ? 'true' : undefined} data-cards={built.cards.length}>
      <header className="lf-cue-screen">
        <p className="lf-eyebrow">Paper backup · [V2 10130]</p>
        <h1>{title}</h1>
        {req?.text ? (
          <figure className="lf-cue-screenquote">
            <blockquote>
              <p>{req.text}</p>
              {req.rationale ? <p className="lf-cue-screenrat">Rationale: {req.rationale}</p> : null}
            </blockquote>
            <figcaption>
              {vol2.snapshot?.source?.name ?? 'NASA-STD-3001 Vol 2'}
              {req.section ? <> §{req.section}</> : null}
              {typeof req.pdf_page === 'number' ? <>, p. {req.pdf_page}</> : null}{' '}
              <FreshnessChip meta={vol2.snapshot} status={vol2.status} id="std_vol2_requirements" compact />
            </figcaption>
          </figure>
        ) : (
          <p>
            <FreshnessChip meta={vol2.snapshot} status={vol2.status} id="std_vol2_requirements" />
          </p>
        )}
        <p className="lf-cue-screenlede">
          {def ? 'This card takes' : 'Each card takes'} its triggers, steps, tripwire, escalation tiers and refusals only from the rules this build ships
          (cases, thresholds, personal indicators, environments and meta), the same files the engine evaluates, so it cannot drift from the app. Black on
          white, at 10 pt or more, severity in words as well as shape (Vol 2 Appendix F, F.5.10 e), one card per page at Letter or A4 (checked with
          Chrome’s print engine). The rules digest on the card marks a stale card: if this app shows a different digest next to its Print links, reprint.
        </p>
        <div className="lf-cue-actions">
          <Button onClick={() => window.print()}>{def ? 'Print this card' : `Print all ${built.cards.length} cards`}</Button>
          <DigestText digest={digest} />
        </div>
        <nav className="lf-cue-others" aria-label="Cue cards">
          {defs.map((c, i) => (
            <span key={c.id}>
              {i ? ' · ' : ''}
              {c.id === single ? <strong aria-current="page">{c.title ?? c.id}</strong> : <a href={`#/card/${c.id}`}>{c.title ?? c.id}</a>}
            </span>
          ))}
          {' · '}
          {single ? <a href="#/cards">All {defs.length}, one per page</a> : <strong aria-current="page">All {defs.length}, one per page</strong>}
          {def ? (
            <>
              {' · '}
              <a href={`#/case/${def.id}`}>Back to the case</a>
            </>
          ) : null}
        </nav>
      </header>
      <div className="lf-cue-stack">
        {built.cards.map((c) => (
          <CueCardView key={c.caseId} card={c} />
        ))}
        {built.errors.map((e) => (
          <article key={e.id} className="lf-cue-paper lf-cue-failed" role="alert">
            <h2>Cue card not built: {e.id}</h2>
            <p>{e.error}</p>
            <p>Use the LANDFALL display for this case, or the vehicle’s own procedures.</p>
          </article>
        ))}
      </div>
    </div>
  )
}
