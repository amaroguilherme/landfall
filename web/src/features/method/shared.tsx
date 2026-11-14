// Presentational helpers for the Method page. Verbatim text is never edited: it is only
// tokenised so requirement IDs render as <ReqId> and numbers in DM Mono (Appendix F F.5.1 d).
import type { ReactNode } from 'react'
import { ExternalIcon, ReqId, UnavailableIcon, UnknownIcon } from '../../ui'

// Order matters: dates and sample labels (L-92, R+194) before bare numbers.
const TOKEN =
  /(\[V[12] \d+\])|(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z)?)|(\b[LR][-+]\d+\b)|((?<![\w.])\d[\d,.]*\d|(?<![\w.])\d)/g

function tokens(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    const key = `${keyBase}-${i++}`
    if (m[1]) out.push(<ReqId key={key} id={m[1]} />)
    else
      out.push(
        <span key={key} className="lf-mono">
          {m[0]}
        </span>,
      )
    last = start + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Text with requirement IDs as <ReqId>, numbers in DM Mono, and the first occurrence of each
 * `emphasize` phrase in bold (no background colour: yellow means Caution).
 */
export function RichText({ text, emphasize = [] }: { text: string; emphasize?: string[] }) {
  const spans: { start: number; end: number }[] = []
  for (const p of emphasize) {
    const at = p ? text.indexOf(p) : -1
    if (at >= 0) spans.push({ start: at, end: at + p.length })
  }
  spans.sort((a, b) => a.start - b.start)
  const parts: ReactNode[] = []
  let cursor = 0
  spans.forEach((s, i) => {
    if (s.start < cursor) return // overlapping phrase: keep the first
    if (s.start > cursor) parts.push(...tokens(text.slice(cursor, s.start), `t${i}`))
    parts.push(
      <strong key={`e${i}`} className="lf-m-key">
        {tokens(text.slice(s.start, s.end), `e${i}`)}
      </strong>,
    )
    cursor = s.end
  })
  if (cursor < text.length) parts.push(...tokens(text.slice(cursor), 'tail'))
  return <>{parts}</>
}

/** A verbatim quotation with its citation underneath. */
export function Verbatim({
  text,
  emphasize,
  cite,
  lead,
}: {
  text: string
  emphasize?: string[]
  cite?: ReactNode
  /** Small label before the quote, e.g. "Rationale". */
  lead?: ReactNode
}) {
  return (
    <figure className="lf-m-quote">
      <blockquote>
        <p>
          {lead ? <span className="lf-m-quote-lead">{lead} </span> : null}“<RichText text={text} emphasize={emphasize} />”
        </p>
      </blockquote>
      {cite ? <figcaption>{cite}</figcaption> : null}
    </figure>
  )
}

/** Neutral check mark (not a severity icon: "verified" is not "nominal"). */
export function CheckGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="lf-icon">
      <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** "checked against the PDF at build" marker, or its honest absence. */
export function Verified({ ok, what = 'checked against the PDF at build' }: { ok: boolean | null | undefined; what?: string }) {
  if (ok) {
    return (
      <span className="lf-m-verified">
        <CheckGlyph />
        {what}
      </span>
    )
  }
  return (
    <span className="lf-m-note-inline" data-tone="missing">
      <UnknownIcon size={13} />
      not verified at build
    </span>
  )
}

/** Cyan "missing" note (Appendix F Table F.5-1: cyan = missing or stale data). */
export function MissingNote({ children }: { children: ReactNode }) {
  return (
    <p className="lf-m-note" data-tone="missing" role="note">
      <UnknownIcon size={15} />
      <span>{children}</span>
    </p>
  )
}

/** Gray "unavailable" note (Table F.5-1: gray = unavailable). */
export function UnavailableNote({ children }: { children: ReactNode }) {
  return (
    <p className="lf-m-note" data-tone="unavailable" role="note">
      <UnavailableIcon size={15} />
      <span>{children}</span>
    </p>
  )
}

/** External link that opens in a new tab and says so. */
export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="lf-ext">
      {children}
      <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** Section title with its number in DM Mono. */
export function SectionTitle({ n, children }: { n: number; children: ReactNode }) {
  return (
    <>
      <span className="lf-m-secnum">{n}</span>
      <span>{children}</span>
    </>
  )
}

/** Inline code / path. */
export function Path({ children }: { children: ReactNode }) {
  return <code className="lf-m-path">{children}</code>
}
