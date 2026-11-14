// Provenance of a whole snapshot (measured / predicted / reference / simulated / derived).
// Neutral colours only: every Appendix F colour already means something (red warning, yellow
// caution, blue advisory, cyan stale, gray unavailable, magenta procedure, green action/focus), so
// the kind is carried by a glyph + the word. Simulated borrows the hatched sim-mode pattern
// (F.4.2 j: sim mode visually distinct), never an alert colour.
import type { SnapshotProvenance } from '../../app/data'
import { PROVENANCE_LABEL, PROVENANCE_WHAT, isProvenance } from './model'

const S = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const

function Glyph({ kind }: { kind: SnapshotProvenance }) {
  let body
  switch (kind) {
    case 'measured': // an instrument trace
      body = <path d="M1 9h3l1.6-5 3 9 2-6.2L12 9h3" {...S} />
      break
    case 'predicted': // a dashed trajectory ahead
      body = (
        <>
          <path d="M1.5 13C4 6 8 3.5 12.5 4" {...S} strokeDasharray="2 2" />
          <path d="M10.4 1.8L13 4l-2.4 2.4" {...S} />
        </>
      )
      break
    case 'reference': // a page of text
      body = (
        <>
          <path d="M3.5 1.5h6l3 3v10h-9z" {...S} />
          <path d="M5.8 7.5h4.4M5.8 10h4.4M5.8 12.3h2.6" {...S} strokeWidth={1.3} />
        </>
      )
      break
    case 'simulated': // a die: seeded generator
      body = (
        <>
          <rect x="2" y="2" width="12" height="12" rx="2" {...S} />
          <circle cx="5.6" cy="5.6" r="1.2" fill="currentColor" />
          <circle cx="10.4" cy="10.4" r="1.2" fill="currentColor" />
          <circle cx="10.4" cy="5.6" r="1.2" fill="currentColor" />
          <circle cx="5.6" cy="10.4" r="1.2" fill="currentColor" />
        </>
      )
      break
    case 'derived': // sigma: arithmetic on other snapshots
      body = <path d="M12.5 2.5h-9l4.6 5.5-4.6 5.5h9" {...S} />
      break
  }
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="lf-icon">
      {body}
    </svg>
  )
}

export function ProvenanceBadge({ kind }: { kind: SnapshotProvenance | string }) {
  if (!isProvenance(kind)) {
    return (
      <span className="lfd-prov" data-prov="unknown" title="Provenance not one of the five snapshot kinds">
        <span className="lfd-prov-text">{kind || 'Provenance unknown'}</span>
      </span>
    )
  }
  return (
    <span className="lfd-prov" data-prov={kind} title={PROVENANCE_WHAT[kind]}>
      <Glyph kind={kind} />
      <span className="lfd-prov-text">{PROVENANCE_LABEL[kind]}</span>
    </span>
  )
}
