// Chips and badges. Every one carries text plus a shape (icon or border style): status and
// provenance are never conveyed by colour alone (Appendix F F.5.10 e).
import type { ReactNode } from 'react'
import { NOAA_S_THRESHOLDS_PFU, OP_WORDS, RULES, isCeiling, isOp, sLevel, thresholdRules } from '../app/engine'
import type { Op } from '../app/engine'
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

/** What a finding badge reads. An engine Finding fits; so does a bare {status, severity, category}. */
export interface BadgeFinding {
  status: Status
  severity: Severity
  category?: string | null
  rule_id?: string | null
  op?: string | null
  limit?: number | null
  /** An S level the finding itself carries. The engine's Finding has none: its rule's `s_level` is used. */
  s_level?: number | null
}

const isSLevel = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= NOAA_S_THRESHOLDS_PFU.length

const ruleOf = (id: string | null | undefined) => (id ? thresholdRules(RULES).find((r) => r.id === id) : undefined)

/** The op of a finding, else of its rule; null when neither is a known op. */
function opOf(finding: BadgeFinding): Op | null {
  if (isOp(finding.op)) return finding.op
  const op = ruleOf(finding.rule_id)?.op
  return isOp(op) ? op : null
}

/**
 * The NOAA S level an OPS finding names: the finding's own `s_level` when present, else its rule's integer
 * `s_level` (engine/rules/thresholds.json), else the engine's sLevel() of the limit for a ceiling, the order in
 * which the engine itself grades an OPS level (SPEC 5 `s_level`). Null when none is 1 to 5: the words then say
 * "the threshold". The level is never typed here.
 */
export function opsLevelOf(finding: BadgeFinding): number | null {
  if (isSLevel(finding.s_level)) return finding.s_level
  const rule = ruleOf(finding.rule_id)
  if (rule && isSLevel(rule.s_level)) return rule.s_level
  const limit = typeof finding.limit === 'number' && Number.isFinite(finding.limit) ? finding.limit : rule?.limit
  const op = opOf(finding)
  if (typeof limit !== 'number' || !Number.isFinite(limit) || op === null || !isCeiling(op)) return null
  const n = sLevel(limit)
  return isSLevel(n) ? n : null
}

/** The op that breaks a compliant condition: an OPS rule "compliant below 1000" is reached "at or above 1000". */
const BREAKS: Record<Op, Op> = { lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' }

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The words an OPS finding reads: an S-level threshold reached or not, never a limit. The OPS rules' own notes say
 * "NOAA operational scale, not a NASA crew-health limit"; at Mars the number is NOAA's reused (a design choice).
 * For the NOAA rules (op "lt"): "At or above S3", "Approaching S3", "Below S3"; without a level, "the threshold".
 * The words follow the rule's op, so they always agree with the engine's verdict. Undefined for other statuses.
 */
export function opsStatusLabel(finding: BadgeFinding): string | undefined {
  const n = opsLevelOf(finding)
  const what = n !== null ? `S${n}` : 'the threshold'
  const op = opOf(finding) ?? 'lt'
  if (finding.status === 'outside') return `${capital(OP_WORDS[BREAKS[op]])} ${what}`
  if (finding.status === 'approaching') return `Approaching ${what}`
  if (finding.status === 'within') return `${capital(OP_WORDS[op])} ${what}`
  return undefined
}

/**
 * The status words of a finding's badge. FFD, PEL and POL, the three kinds of NASA limit (SPEC 1.2), keep
 * "Outside limit" / "Within limit". A TARGET is a countermeasure target and an OPS level a NOAA S-scale threshold:
 * neither is labelled a limit. (Tier B views print their own words, "Reliable change" / "No reliable change".)
 */
export function findingStatusLabel(finding: BadgeFinding): string {
  if (finding.category === 'TARGET') return TARGET_LABEL[finding.status] ?? STATUS_LABEL[finding.status]
  if (finding.category === 'OPS') return opsStatusLabel(finding) ?? STATUS_LABEL[finding.status]
  return STATUS_LABEL[finding.status]
}

/**
 * The badge for an engine Finding: data-quality states (cyan / gray) take precedence over the
 * severity colour, so "no data" never looks like "nominal". `partial` (a summed dose window whose
 * record starts after the window opens, app/evaluate partialRecord) turns a "within" into the cyan
 * "Partial record" tag (D15): a lower bound never reads "within limit". The words come from
 * findingStatusLabel, so a TARGET or OPS finding is never labelled against a limit.
 */
export function FindingBadge({ finding, solid, partial = false }: { finding: BadgeFinding; solid?: boolean; partial?: boolean }) {
  if (DATA_STATUS[finding.status]) return <StatusBadge status={finding.status} />
  if (partial && finding.status === 'within') return <PartialRecordBadge />
  return <SeverityBadge severity={finding.severity} label={findingStatusLabel(finding)} solid={solid} />
}

/** Cyan "Partial record" tag (Table F.5-1 "Missing or stale data"): the logged sum is a lower bound (D15). */
export function PartialRecordBadge() {
  return (
    <span className="lf-dq" data-tone="stale" title="The dose record starts after the window opens: the logged sum is a lower bound, not a verdict.">
      <UnknownIcon size={14} />
      <span>Partial record</span>
    </span>
  )
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
