// Number, time, freshness and citation primitives.
import type { ReactNode } from 'react'
import { formatMet } from '../app/engine'
import { formatUtc, freshnessOf } from '../app/data'
import type { LoadStatus, SnapshotMeta, SnapshotSource } from '../app/data'
import type { Severity, Source } from '../app/vocab'
import { ArrowIcon, ClockIcon, ExternalIcon, StaleIcon, UnavailableIcon, UnknownIcon } from './icons'

// ---- Num ------------------------------------------------------------------------------------

const MINUS = '−'

export function formatNumber(value: number, digits?: number, signed = false): string {
  const fmt = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits ?? 3,
    useGrouping: Math.abs(value) >= 10_000,
  })
  const body = fmt.format(Math.abs(value))
  const sign = value < 0 ? MINUS : signed && value > 0 ? '+' : ''
  return sign + body
}

/**
 * Every number in LANDFALL renders through <Num> (DM Mono, tabular figures, unit attached).
 * null / undefined / NaN render as an em dash flagged "no data" ([V2 10020]).
 * `arrow` + `severity` implement Appendix F F.4.3.1 d: a yellow or red up/down arrow after a
 * value outside a Caution or Warning threshold.
 */
export function Num({
  value,
  unit,
  digits,
  signed = false,
  arrow,
  severity,
  unitLabel,
  className,
}: {
  value: number | null | undefined
  unit?: string
  digits?: number
  signed?: boolean
  arrow?: 'up' | 'down'
  severity?: Severity
  /** Accessible expansion of the unit, e.g. "millisieverts". */
  unitLabel?: string
  className?: string
}) {
  const missing = value === null || value === undefined || !Number.isFinite(value)
  const showArrow = arrow && (severity === 'caution' || severity === 'warning' || severity === 'emergency')
  return (
    <span className={['lf-num', className].filter(Boolean).join(' ')} data-missing={missing || undefined} data-severity={showArrow ? severity : undefined}>
      {missing ? (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">no data</span>
        </>
      ) : (
        <data value={String(value)}>{formatNumber(value, digits, signed)}</data>
      )}
      {unit ? (
        <>
          {/* A real space for copied and extracted text ("2026 µGy/day"); zero width on screen, where the unit's margin spaces it. */}
          <span className="lf-num-sep"> </span>
          <span className="lf-num-unit" title={unitLabel}>
            {unit}
          </span>
        </>
      ) : null}
      {showArrow ? (
        <span className="lf-num-arrow">
          <ArrowIcon direction={arrow} size={11} />
          <span className="sr-only">{arrow === 'up' ? 'above' : 'below'} threshold</span>
        </span>
      ) : null}
    </span>
  )
}

/** MET as "d/hh:mm:ss" (no leading zeros in the day field, F.6.1 f) via the engine's formatMet; `label` prefixes "MET". */
export function MetTime({ t, label = false, className }: { t: number; label?: boolean; className?: string }) {
  const s = Math.max(0, Math.floor(t))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return (
    <time className={['lf-num', 'lf-met', className].filter(Boolean).join(' ')} dateTime={`P${d}DT${h}H${m}M${sec}S`}>
      {label ? <span className="lf-met-label">MET </span> : null}
      {formatMet(t)}
    </time>
  )
}

// ---- FreshnessChip ([V2 10020]) ---------------------------------------------------------------

/**
 * Freshness of a frozen snapshot: kind (live / historical / prediction / reference), "frozen at
 * build", retrieved_at, and a cyan STALE / MISSING / UNKNOWN or gray UNAVAILABLE state.
 * Pass the snapshot (or manifest entry) and the load status from useSnapshot().
 */
export function FreshnessChip({
  meta,
  status = 'ready',
  id,
  source,
  unavailable,
  compact = false,
}: {
  meta?: SnapshotMeta | null
  status?: LoadStatus
  /** Snapshot id, shown when the file is missing. */
  id?: string
  /** Publisher line, e.g. snapshot.source. */
  source?: Pick<SnapshotSource, 'publisher' | 'url'> | null
  /** Mark as not applicable / unavailable here (gray), with a reason. */
  unavailable?: string
  compact?: boolean
}) {
  if (unavailable) {
    return (
      <span className="lf-fresh" data-state="unavailable">
        <UnavailableIcon size={13} />
        <span className="lf-fresh-label">UNAVAILABLE</span>
        {!compact ? <span className="lf-fresh-detail">{unavailable}</span> : null}
      </span>
    )
  }
  const f = freshnessOf(meta ?? null, status)
  // A generated scenario (sim_crew) is not "historical" data: say what it is, never imply it was measured.
  const simulated = f.state === 'frozen' && meta?.provenance === 'simulated'
  const Icon = f.state === 'stale' ? StaleIcon : f.state === 'frozen' ? ClockIcon : f.state === 'loading' ? ClockIcon : UnknownIcon
  const missingId = id ?? meta?.id
  return (
    <span className="lf-fresh" data-state={f.state} data-provenance={simulated ? 'simulated' : undefined} title={simulated ? 'Simulated scenario, generated at build' : f.detail}>
      <Icon size={13} />
      <span className="lf-fresh-label">{simulated ? 'SIMULATED' : f.label}</span>
      {!compact && f.state === 'frozen' ? <span className="lf-fresh-detail">{simulated ? 'generated at build' : 'frozen at build'}</span> : null}
      {!compact && f.state === 'stale' ? <span className="lf-fresh-detail">{f.detail}</span> : null}
      {!compact && f.state === 'missing' ? (
        <span className="lf-fresh-detail">
          <code>{missingId ? `${missingId}.json` : 'snapshot'}</code> not in this build
        </span>
      ) : null}
      {f.retrievedAt ? (
        <span className="lf-fresh-time">
          <span className="sr-only">retrieved </span>
          <time dateTime={f.retrievedAt}>{formatUtc(f.retrievedAt)}</time>
        </span>
      ) : null}
      {!compact && source ? <span className="lf-fresh-src">{source.publisher}</span> : null}
    </span>
  )
}

// ---- Citation -----------------------------------------------------------------------------------

function ExtLink({ href, children }: { href?: string; children: ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="lf-ext">
      {children}
      <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** "[V1 4030]" formatting for a requirement id ("V1 4030"). */
export function ReqId({ id }: { id: string }) {
  return <span className="lf-req">[{id.replace(/^\[|\]$/g, '')}]</span>
}

/**
 * Citation: doc + requirement id + link. Either pass explicit props, or a SPEC `source` object
 * (nasa_standard / nasa_brief / noaa / literature / derived / design_choice).
 */
export function Citation({
  source,
  doc,
  requirementId,
  section,
  url,
  children,
}: {
  source?: Source | Record<string, unknown>
  doc?: string
  requirementId?: string
  section?: string
  url?: string
  children?: ReactNode
}) {
  const s = source as Source | undefined
  if (s && typeof s === 'object' && 'kind' in s) {
    switch (s.kind) {
      case 'nasa_standard':
        return (
          <cite className="lf-cite">
            {s.requirement_id ? <ReqId id={s.requirement_id} /> : null}{' '}
            <ExtLink href={s.url}>{s.doc}</ExtLink>
            {s.section ? <span className="lf-cite-sec"> §{s.section}</span> : null}
            {children}
          </cite>
        )
      case 'nasa_brief':
      case 'noaa':
        return (
          <cite className="lf-cite">
            <ExtLink href={s.url}>{s.doc}</ExtLink>
            {children}
          </cite>
        )
      case 'literature':
        return (
          <cite className="lf-cite">
            <ExtLink href={s.url}>{s.citation}</ExtLink>
            {children}
          </cite>
        )
      case 'derived':
        return (
          <cite className="lf-cite">
            Derived: <span className="lf-mono">{s.arithmetic}</span>
            {s.from?.length ? <span className="lf-cite-sec"> (from {s.from.join(', ')})</span> : null}
            {children}
          </cite>
        )
      case 'design_choice':
        return (
          <cite className="lf-cite">
            Design choice: {s.rationale}
            {children}
          </cite>
        )
    }
  }
  return (
    <cite className="lf-cite">
      {requirementId ? <ReqId id={requirementId} /> : null} <ExtLink href={url}>{doc ?? 'Source'}</ExtLink>
      {section ? <span className="lf-cite-sec"> §{section}</span> : null}
      {children}
    </cite>
  )
}
