// Small presentational parts of the Now view.
import { CASE_STATUS_LABEL } from './model'

const S = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const

/** Case lifecycle glyph: shape-coded, neutral colour (a case status is not a severity). */
function CaseGlyph({ status }: { status: string }) {
  let body
  switch (status) {
    case 'detected':
      body = (
        <>
          <circle cx="8" cy="8" r="6" {...S} />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </>
      )
      break
    case 'acting':
      body = <path d="M5 3.5l7 4.5-7 4.5z" {...S} />
      break
    case 'watch':
      body = (
        <>
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" {...S} />
          <circle cx="8" cy="8" r="1.8" {...S} />
        </>
      )
      break
    case 'escalated':
      body = <path d="M8 13V3M4 7l4-4 4 4" {...S} />
      break
    case 'resolved':
      body = <path d="M3.5 8.5l3 3 6-7" {...S} />
      break
    default:
      body = <circle cx="8" cy="8" r="6" {...S} strokeDasharray="2 2" />
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="lf-icon">
      {body}
    </svg>
  )
}

/** "DETECTED" / "ACTING" / "WATCH" tag with its glyph (the engine's case lifecycle word). */
export function CaseStatusTag({ status }: { status: string }) {
  return (
    <span className="now-cs" data-status={status}>
      <CaseGlyph status={status} />
      <span>
        <span className="sr-only">Case status: </span>
        {CASE_STATUS_LABEL[status] ?? status}
      </span>
    </span>
  )
}
