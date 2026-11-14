// The [V2 6164] rationale sentence under the dual counter. The sentence comes from cases.json
// (bundled, so it paints at once) and is checked, character for character, against the frozen
// NASA-STD-3001 Vol 2 snapshot when that loads; the full requirement text sits in an expander.
import { useSnapshot } from '../../app/data'
import { Expander, FreshnessChip, ReqId } from '../../ui'
import { caseQuote, findRequirement, speDef, standardApproved, verbatimCheck } from './model'

export function RationaleQuote() {
  const q = caseQuote(speDef())
  const snap = useSnapshot(q?.snapshot ?? null)
  if (!q) return null
  const req = snap.status === 'ready' ? findRequirement(snap.data, q.requirementId) : null
  const check = snap.status === 'ready' ? verbatimCheck(req, q.text) : 'unchecked'
  const approved = snap.status === 'ready' ? standardApproved(snap.data) : null
  return (
    <figure className="now-quote">
      <blockquote cite={q.url ?? undefined} className="now-quote-text">
        <p>{q.text}</p>
      </blockquote>
      <figcaption className="now-quote-cite">
        <ReqId id={q.requirementId} />
        <span className="now-quote-src">
          {q.doc}
          {q.section ? <> §{q.section}, rationale</> : null}
          {q.page !== null ? (
            <>
              , p. <span className="lf-num">{q.page}</span>
            </>
          ) : null}
          {approved ? (
            <>
              {' '}
              (approved <span className="lf-num">{approved}</span>)
            </>
          ) : null}
        </span>
        <span className="now-quote-check" data-check={check}>
          {check === 'verified'
            ? 'Verbatim in the frozen standard text'
            : check === 'mismatch'
              ? 'Not found verbatim in the frozen standard text'
              : snap.status === 'loading'
                ? 'Checking against the frozen standard text'
                : 'Not checked: the standard snapshot is not in this build'}
        </span>
        {q.snapshot ? <FreshnessChip meta={snap.snapshot} status={snap.status} id={q.snapshot} compact /> : null}
      </figcaption>
      {req ? (
        <Expander summary="The requirement and its full rationale">
          <p>
            <ReqId id={q.requirementId} /> <strong>{req.title}</strong>
          </p>
          <p>{req.text}</p>
          <p className="now-quote-rationale">Rationale: {req.rationale}</p>
        </Expander>
      ) : null}
    </figure>
  )
}
