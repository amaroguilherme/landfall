// Chips and badges. Every one carries text plus a shape (icon or border style): status and
// provenance are never conveyed by colour alone (Appendix F F.5.10 e).
import type { ReactNode } from 'react'
import type { Category, ChipKind, Severity, Status } from '../app/vocab'
import { CategoryGlyph, ChipGlyph, SeverityIcon, StaleIcon, UnavailableIcon, UnknownIcon } from './icons'

// ---- provenance chip ------------------------------------------------------------------------

const CHIP_HELP: Record<ChipKind, string> = {
  'NASA-published': 'Number published by NASA with a requirement ID',
  'NASA brief': 'Number from a NASA OCHMO technical brief (no requirement ID)',
  'NOAA-published': 'Number published by NOAA',
  literature: 'Number from peer-reviewed literature, cited',
  derived: 'Arithmetic on published values, shown',
  'design choice': 'No published basis: chosen by LANDFALL and labeled as such',
}

/** Provenance chip for a constant: <Chip kind="NASA-published" />. Unknown strings render as-is. */
export function Chip({ kind, children }: { kind: ChipKind | string; children?: ReactNode }) {
  const help = CHIP_HELP[kind as ChipKind] ?? 'Basis of this value'
  return (
    <span className="lf-chip" data-chip={kind} title={help}>
      <ChipGlyph chip={kind} />
      <span>{children ?? kind}</span>
    </span>
  )
}

// ---- category badge -------------------------------------------------------------------------

const CATEGORY_HELP: Record<Category, string> = {
  FFD: 'Fitness for Duty: a floor on capability',
  PEL: 'Permissible Exposure Limit: a ceiling on cumulative exposure',
  POL: 'Permissible Outcome Limit: a maximum change from your own preflight baseline',
  OPS: 'Operational scale published by another agency (NOAA)',
  PERSONAL: 'Reliable change against your own recent baseline (not a limit)',
}

const CATEGORY_SHORT: Record<Category, string> = {
  FFD: 'floor',
  PEL: 'ceiling',
  POL: 'max change',
  OPS: 'NOAA scale',
  PERSONAL: 'own baseline',
}

/** FFD / PEL / POL / OPS / PERSONAL with a distinct glyph each. `long` adds the shape word. */
export function CategoryBadge({ category, long = false }: { category: Category; long?: boolean }) {
  return (
    <span className="lf-cat" data-category={category} title={CATEGORY_HELP[category]}>
      <CategoryGlyph category={category} size={14} />
      <span className="lf-cat-code">{category}</span>
      {long ? <span className="lf-cat-word">{CATEGORY_SHORT[category]}</span> : null}
      <span className="sr-only">, {CATEGORY_HELP[category]}</span>
    </span>
  )
}

// ---- severity / status ------------------------------------------------------------------------

const SEVERITY_LABEL: Record<Severity, string> = {
  nominal: 'Nominal',
  advisory: 'Advisory',
  caution: 'Caution',
  warning: 'Warning',
  emergency: 'Emergency',
}

/** Icon + text severity badge. `solid` fills it (lit annunciator style). */
export function SeverityBadge({
  severity,
  label,
  solid = false,
  size = 'md',
}: {
  severity: Severity
  /** Override the visible text (the severity word is still announced). */
  label?: ReactNode
  solid?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  return (
    <span className="lf-sev" data-severity={severity} data-solid={solid || undefined} data-size={size}>
      <SeverityIcon severity={severity} size={size === 'lg' ? 20 : size === 'sm' ? 12 : 14} />
      <span className="lf-sev-text">
        {label ?? SEVERITY_LABEL[severity]}
        {label ? <span className="sr-only"> ({SEVERITY_LABEL[severity]})</span> : null}
      </span>
    </span>
  )
}

const DATA_STATUS: Partial<Record<Status, { label: string; tone: 'stale' | 'unavailable'; icon: 'stale' | 'unknown' | 'na' }>> = {
  stale: { label: 'Stale data', tone: 'stale', icon: 'stale' },
  insufficient_data: { label: 'Insufficient data', tone: 'stale', icon: 'unknown' },
  not_applicable: { label: 'Not applicable here', tone: 'unavailable', icon: 'na' },
}

const STATUS_LABEL: Record<Status, string> = {
  within: 'Within limit',
  approaching: 'Approaching limit',
  outside: 'Outside limit',
  reliable_change: 'Reliable change',
  insufficient_data: 'Insufficient data',
  stale: 'Stale data',
  not_applicable: 'Not applicable here',
}

/** Data-quality badge for stale / insufficient_data / not_applicable ([V2 10020]); plain text otherwise. */
export function StatusBadge({ status }: { status: Status }) {
  const d = DATA_STATUS[status]
  if (!d) return <span className="lf-status">{STATUS_LABEL[status]}</span>
  const Icon = d.icon === 'stale' ? StaleIcon : d.icon === 'unknown' ? UnknownIcon : UnavailableIcon
  return (
    <span className="lf-dq" data-tone={d.tone}>
      <Icon size={14} />
      <span>{d.label}</span>
    </span>
  )
}

/**
 * The badge for an engine Finding: data-quality states (cyan / gray) take precedence over the
 * severity colour, so "no data" never looks like "nominal".
 */
export function FindingBadge({ finding, solid }: { finding: { status: Status; severity: Severity }; solid?: boolean }) {
  if (DATA_STATUS[finding.status]) return <StatusBadge status={finding.status} />
  return <SeverityBadge severity={finding.severity} label={STATUS_LABEL[finding.status]} solid={solid} />
}

export { STATUS_LABEL, SEVERITY_LABEL }

// ---- simulated-data marker (F.4.2 j: sim mode visually distinct) ----------------------------

/**
 * Persistent "SIMULATED CREW DATA" marker. Hatched, not coloured: it must not borrow an alert
 * colour. Use variant="banner" at the top of any panel that shows simulated crew data.
 */
export function SimulatedMarker({ variant = 'inline', children }: { variant?: 'inline' | 'bar' | 'banner'; children?: ReactNode }) {
  return (
    <span
      className="lf-sim"
      data-variant={variant}
      role="note"
      title="Crew physiology in this demo is simulated (seeded, labeled). NASA and NOAA environment data are real, frozen at build."
    >
      <span className="lf-sim-tag">SIMULATED CREW DATA</span>
      {children ? <span className="lf-sim-extra">{children}</span> : null}
    </span>
  )
}
