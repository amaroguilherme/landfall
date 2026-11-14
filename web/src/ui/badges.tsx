// Chips and badges. Every one carries text plus a shape (icon or border style): status and
// provenance are never conveyed by colour alone (Appendix F F.5.10 e).
import type { ReactNode } from 'react'
import { categoryDef, chipDef } from '../app/vocab'
import type { Category, ChipKind, Severity, Status } from '../app/vocab'
import { CategoryGlyph, ChipGlyph, SeverityIcon, StaleIcon, UnavailableIcon, UnknownIcon } from './icons'

// ---- provenance chip ------------------------------------------------------------------------

/**
 * Provenance chip for a constant: <Chip kind="NASA-published" />. The label, its definition and
 * its glyph come from engine/rules/meta.json (chips[].id / definition / source_kind), so a chip
 * renamed in the rules renders correctly here. An unknown label renders as-is; no kind renders nothing.
 */
export function Chip({ kind, children }: { kind: ChipKind | null | undefined; children?: ReactNode }) {
  if (!kind) return null
  const def = chipDef(kind)
  return (
    <span className="lf-chip" data-chip={kind} data-source-kind={def?.source_kind} title={def?.definition ?? 'Basis of this value'}>
      <ChipGlyph chip={kind} />
      <span>{children ?? kind}</span>
    </span>
  )
}

// ---- category badge -------------------------------------------------------------------------

/** One short shape word per category id (presentation only; names and shapes come from meta.json). */
const CATEGORY_SHORT: Record<string, string> = {
  FFD: 'floor',
  PEL: 'ceiling',
  POL: 'max change',
  OPS: 'NOAA scale',
  PERSONAL: 'own baseline',
  TARGET: 'case target',
}

function categoryHelp(category: Category): string {
  const def = categoryDef(category)
  return def ? `${def.name}: ${def.shape}` : category
}

/**
 * FFD / PEL / POL / OPS / PERSONAL / TARGET, each with its own glyph. `long` adds the shape word.
 * Name and shape are read from engine/rules/meta.json categories[].
 */
export function CategoryBadge({ category, long = false }: { category: Category; long?: boolean }) {
  const help = categoryHelp(category)
  return (
    <span className="lf-cat" data-category={category} title={help}>
      <CategoryGlyph category={category} size={14} />
      <span className="lf-cat-code">{category}</span>
      {long ? <span className="lf-cat-word">{CATEGORY_SHORT[category] ?? categoryDef(category)?.name ?? ''}</span> : null}
      <span className="sr-only">, {help}</span>
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
export function FindingBadge({ finding, solid }: { finding: { status: Status; severity: Severity; category?: string | null }; solid?: boolean }) {
  if (DATA_STATUS[finding.status]) return <StatusBadge status={finding.status} />
  // A TARGET is a countermeasure target, not a limit (SPEC 1.2): never label it "limit".
  const label = (finding.category === 'TARGET' ? TARGET_LABEL[finding.status] : undefined) ?? STATUS_LABEL[finding.status]
  return <SeverityBadge severity={finding.severity} label={label} solid={solid} />
}

const TARGET_LABEL: Partial<Record<Status, string>> = {
  within: 'Meets target',
  approaching: 'Approaching target',
  outside: 'Outside target',
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
