// Provenance model: every constant in engine/rules/*.json, flattened into rows.
// Generated at build time from the SAME files the engine reads (single source of truth).
// Nothing here types a NASA number: every value below is read from the JSON.
import { ENVIRONMENTS } from '../../app/scenario'
import { ANSCOMBE_OFFSET, tCritical } from '../../app/engine'
import { chanceRateOf, testScaleWords, transformFormula } from '../../app/evaluate'

// ---------------------------------------------------------------------------------------------
// Raw rules files (shapes from engine/SPEC.md section 3; loose on purpose, fields are optional)
// ---------------------------------------------------------------------------------------------

export type Op = 'lt' | 'le' | 'gt' | 'ge'

export interface RuleSource {
  kind: string
  doc?: string
  requirement_id?: string | null
  section?: string
  page?: number
  url?: string
  snapshot?: string
  verbatim?: string
  table?: string
  row?: string
  column?: string
  level?: string
  citation?: string
  note?: string
  from?: string[]
  arithmetic?: string
  rationale?: string
  basis_citation?: string
  term?: string
}

interface Sourced {
  chip: string
  source: RuleSource
}

export interface ThresholdRule extends Sourced {
  id: string
  label: string
  variable: string
  unit: string
  op: Op
  limit: number
  category: string
  tier: string
  role: string
  applies_to: string[]
  applies_to_eva_type?: string
  window?: { kind: string; duration?: string | null; basis?: string; baseline?: string; value_definition?: string; max_duration?: string }
  approach_at?: Sourced & { value: number; rationale?: string }
  s_level?: number
  descriptor?: string
  threshold_as_printed?: string
  biological_text?: string
  derived_from_rule?: string
  max_severity?: string
  action_id?: string | null
  /** One-line action shown with the finding (thresholds.json `action`). */
  action?: Sourced & { label?: string; text: string }
  case_id?: string | null
  body_region?: string
  notes?: string[]
}

export interface NamedConstant extends Sourced {
  id: string
  label: string
  value: number | { min: number; max: number }
  unit: string
}

interface ThresholdsFile {
  schema: string
  rules: ThresholdRule[]
  constants?: NamedConstant[]
}

export interface Indicator {
  id: string
  label: string
  variable: string
  unit: string
  worse: string
  alerting: boolean
  private: boolean
  device?: string
  /** Kept for context only: the single-case test does not use a reliability (used_by_engine: false). */
  reliability_r?: Sourced & { value: number | null; used_by_engine?: boolean }
  definition?: Sourced & { text: string }
  context?: Sourced & { text: string }
  case_id: string | null
  /** The scale the test runs on (S2): "anscombe" for a count; absent or null: the raw value. */
  transform?: 'anscombe' | null
  transform_basis?: Sourced & { text: string }
  /** Measured chance-rate multipliers (S3), declared where the measured rate is outside 0.5-2 times nominal. */
  chance_rate?: Sourced & { caution_multiplier: number; flag_multiplier: number; text?: string }
}

export interface RciBlock extends Sourced {
  alpha_two_tailed: number
  min_baseline_n: number
  baseline_window_days: number
  method?: string
  caveat?: string
  provenance?: Record<string, Sourced>
}

interface PersonalFile {
  schema: string
  rci: RciBlock
  indicators: Indicator[]
}

interface Trigger {
  kind: string
  rule_id?: string
  indicator_id?: string
}

export interface Tripwire extends Sourced {
  reassess_after_s: number
  condition: { rule_id?: string; indicator_id?: string; op: Op; value: number; of_last_n: number; at_least: number }
  text: string
}

export interface Projection extends Sourced {
  id: string
  label: string
  value: number | { min: number; max: number }
  unit: string
  caveat?: Sourced & { text: string }
}

export interface CaseDef {
  id: string
  title: string
  one_line: string
  triggers: Trigger[]
  tripwire?: Tripwire
  projections?: Projection[]
  refusals?: string[]
}

interface CasesFile {
  schema: string
  cases: CaseDef[]
}

export interface EnvDef {
  id: string
  label: string
  comms?: Sourced & {
    one_way_light_time_s: { min?: number; max?: number; mean?: number; from_snapshot?: string }
    conjunction: boolean
  }
  notes?: string[]
}

interface EnvironmentsFile {
  schema: string
  constants?: NamedConstant[]
  environments: EnvDef[]
}

export interface MetaChip {
  id: string
  source_kind: string
  definition: string
}

export interface MetaCategory {
  id: string
  name: string
  shape: string
  glossary: string | null
  source: RuleSource | null
}

export interface SeverityRow {
  id: string
  when: Record<string, unknown>
  severity?: string
  severity_max?: string
  note?: string
  colour_note?: string
}

export interface MetaFile {
  schema: string
  chips: MetaChip[]
  categories: MetaCategory[]
  severity_mapping: Sourced & { rows: SeverityRow[] }
  principles: { id: string; text: string; requirement_ids: string[] }[]
  refusals: { id: string; text: string }[]
}

// import.meta.glob tolerates a missing file, so the page reports an absent rules file instead of
// failing the build. Same relative path as the engine (vite allows the repo root).
const RULE_FILES = import.meta.glob('../../../../engine/rules/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

export const RULE_FILE_NAMES = ['thresholds', 'personal', 'cases', 'environments', 'meta'] as const
export type RuleFileName = (typeof RULE_FILE_NAMES)[number]

function ruleFile<T>(name: RuleFileName): T | null {
  const key = Object.keys(RULE_FILES).find((k) => k.endsWith(`/${name}.json`))
  return key ? (RULE_FILES[key] as T) : null
}

export const THRESHOLDS = ruleFile<ThresholdsFile>('thresholds')
export const PERSONAL = ruleFile<PersonalFile>('personal')
export const CASES = ruleFile<CasesFile>('cases')
export const ENV_FILE = ruleFile<EnvironmentsFile>('environments')
export const META = ruleFile<MetaFile>('meta')

/** Which rules files were present at build time, with their schema strings. */
export const FILE_STATUS: { name: RuleFileName; present: boolean; schema: string | null }[] = [
  { name: 'thresholds', file: THRESHOLDS },
  { name: 'personal', file: PERSONAL },
  { name: 'cases', file: CASES },
  { name: 'environments', file: ENV_FILE },
  { name: 'meta', file: META },
].map(({ name, file }) => ({
  name: name as RuleFileName,
  present: !!file,
  schema: file && typeof (file as { schema?: unknown }).schema === 'string' ? (file as { schema: string }).schema : null,
}))

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

export type RowKind =
  | 'limit'
  | 'approach'
  | 'constant'
  | 'rci'
  | 'reliability'
  | 'tripwire'
  | 'projection'
  | 'comms'
  | 'severity_map'

export type RowValue =
  | { kind: 'number'; value: number; unit: string | null }
  | { kind: 'range'; min: number; max: number; mean?: number; unit: string | null }
  | { kind: 'snapshot'; snapshot: string; unit: string | null }
  /** A Tier B personal band: each crewmember's baseline mean ± critical × S_diff, in the indicator's unit. */
  | { kind: 'band'; unit: string | null }
  | { kind: 'tripwire'; op: Op; value: number; unit: string | null; of_last_n: number; at_least: number; reassess_after_s: number }
  | { kind: 'mapping'; severity: string | null; severity_max: string | null }

/** The compliant (or triggering) condition, rendered as "lead OP value unit". */
export type Condition =
  | { kind: 'compare'; lead: string; op: Op; value: number; unit: string | null }
  | { kind: 'text'; text: string }

export interface Ref {
  id: string
  label: string
  role: string
  /** In-app href (case page or a provenance deep link); null for plain text. */
  href: string | null
}

export interface ProvRow {
  /** Deep-link id: #/provenance?id=<id>. */
  id: string
  /** Other ids that should resolve to this row (e.g. an indicator id for its reliability row). */
  aliases: string[]
  kind: RowKind
  file: RuleFileName
  /** JSON path, shown to auditors. */
  path: string
  label: string
  /** Compact label for lists (parent rule, indicator, case or environment name). */
  shortLabel: string
  value: RowValue
  condition: Condition | null
  categories: string[]
  chip: string
  source: RuleSource | null
  /** Environment ids, ['*'] for all, or null when not environment-specific. */
  appliesTo: string[] | null
  appliesNote: string | null
  usedBy: Ref[]
  /** thresholds.json rule role ('alert' | 'context') for limit rows; absent for every other kind. */
  role?: string
  /** Parent row for approach levels. */
  parentId: string | null
  notes: string[]
  /** Extra source-adjacent facts (window, S level, definition, caveat...). */
  facts: { label: string; text: string; chip?: string; source?: RuleSource }[]
  searchText: string
}

const OP_SYMBOL: Record<Op, string> = { lt: '<', le: '≤', gt: '>', ge: '≥' }
const OP_WORDS: Record<Op, string> = { lt: 'below', le: 'at or below', gt: 'above', ge: 'at or above' }
export { OP_SYMBOL, OP_WORDS }

export function isCeiling(op: Op): boolean {
  return op === 'lt' || op === 'le'
}

const provHref = (id: string) => `#/provenance?id=${encodeURIComponent(id)}`
const caseHref = (id: string) => `#/case/${encodeURIComponent(id)}`

/** "ISS", "Cislunar space", ... from the environment labels (text before " · "). */
export function envShort(id: string): string {
  if (id === '*') return 'all environments'
  const fromRules = ENV_FILE?.environments.find((e) => e.id === id)?.label
  const label = fromRules ?? ENVIRONMENTS.find((e) => e.id === id)?.label ?? id
  return label.split(' · ')[0]
}

function caseTitle(id: string): string {
  return CASES?.cases.find((c) => c.id === id)?.title ?? id
}

function windowText(w: ThresholdRule['window']): string | null {
  if (!w) return null
  const parts: string[] = [w.kind.replace(/_/g, ' ')]
  if (w.duration) parts.push(w.duration)
  if (w.max_duration) parts.push(`max ${w.max_duration}`)
  let s = parts.join(' · ')
  if (w.basis) s += ` (${w.basis})`
  if (w.value_definition) s += ` (${w.value_definition})`
  return s
}

function valueOf(v: number | { min: number; max: number; mean?: number }, unit: string | null): RowValue {
  return typeof v === 'number' ? { kind: 'number', value: v, unit } : { kind: 'range', min: v.min, max: v.max, mean: v.mean, unit }
}

const RCI_FIELDS: { key: 'alpha_two_tailed' | 'min_baseline_n' | 'baseline_window_days'; label: string; unit: string | null }[] = [
  { key: 'alpha_two_tailed', label: 'Reliable-change significance level (two-tailed α)', unit: null },
  { key: 'min_baseline_n', label: 'Minimum baseline observations', unit: 'days of data' },
  { key: 'baseline_window_days', label: 'Baseline window', unit: 'days' },
]

function mappingWhenText(when: Record<string, unknown>): string {
  return Object.entries(when)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${Array.isArray(v) ? v.join('/') : String(v)}`)
    .join(' · ')
}

function mappingCategories(when: Record<string, unknown>): string[] {
  const out = new Set<string>()
  if (typeof when.category === 'string') out.add(when.category)
  if (Array.isArray(when.category_in)) for (const c of when.category_in) out.add(String(c))
  if (when.tier === 'B') out.add('PERSONAL')
  return [...out]
}

function sourceSearchText(s: RuleSource | null | undefined): string {
  if (!s) return ''
  return [s.kind, s.doc, s.requirement_id, s.section, s.table, s.row, s.column, s.level, s.citation, s.rationale, s.arithmetic, s.verbatim, s.note, ...(s.from ?? [])]
    .filter(Boolean)
    .join(' ')
}

function buildRows(): ProvRow[] {
  const rows: ProvRow[] = []
  const push = (r: Omit<ProvRow, 'searchText' | 'usedBy' | 'shortLabel'> & { usedBy?: Ref[]; shortLabel?: string }) => {
    rows.push({ ...r, shortLabel: r.shortLabel ?? r.label, usedBy: r.usedBy ?? [], searchText: '' })
  }

  // ---- thresholds.json: rules, their approach levels, and constants ----
  for (const [i, rule] of (THRESHOLDS?.rules ?? []).entries()) {
    const ceiling = isCeiling(rule.op)
    const facts: ProvRow['facts'] = []
    const w = windowText(rule.window)
    if (w) facts.push({ label: 'Window', text: w })
    facts.push({ label: 'Variable', text: `${rule.variable} (${rule.unit})` })
    facts.push({ label: 'Tier · role', text: `Tier ${rule.tier} · ${rule.role}${rule.role === 'context' ? ' (shown, never fires)' : ''}` })
    if (rule.s_level !== undefined) facts.push({ label: 'NOAA level', text: `S${rule.s_level}${rule.descriptor ? ` (${rule.descriptor})` : ''}${rule.threshold_as_printed ? `, threshold printed as ${rule.threshold_as_printed}` : ''}` })
    if (rule.biological_text) facts.push({ label: 'NOAA biological text', text: rule.biological_text })
    if (rule.max_severity) facts.push({ label: 'Severity cap', text: `never above ${rule.max_severity}` })
    if (rule.derived_from_rule) facts.push({ label: 'Reuses rule', text: rule.derived_from_rule })
    if (rule.action?.text) facts.push({ label: 'Action', text: rule.action.text, chip: rule.action.chip, source: rule.action.source })
    if (rule.action_id) facts.push({ label: 'Action id', text: rule.action_id })
    push({
      id: rule.id,
      aliases: [],
      kind: 'limit',
      file: 'thresholds',
      path: `thresholds.json rules[${i}].limit`,
      label: rule.label,
      value: { kind: 'number', value: rule.limit, unit: rule.unit },
      condition: {
        kind: 'compare',
        lead: rule.role === 'context' ? 'design target' : rule.category === 'OPS' ? 'no storm at this level while flux' : 'value',
        op: rule.op,
        value: rule.limit,
        unit: rule.unit,
      },
      categories: [rule.category],
      chip: rule.chip,
      source: rule.source,
      appliesTo: rule.applies_to,
      appliesNote: rule.applies_to_eva_type ? `EVA type: ${rule.applies_to_eva_type}` : null,
      role: rule.role,
      parentId: null,
      notes: rule.notes ?? [],
      facts,
    })
    if (rule.approach_at) {
      const a = rule.approach_at
      const aFacts: ProvRow['facts'] = []
      if (a.rationale) aFacts.push({ label: 'Rationale', text: a.rationale })
      push({
        id: `${rule.id}.approach_at`,
        aliases: [],
        kind: 'approach',
        file: 'thresholds',
        path: `thresholds.json rules[${i}].approach_at.value`,
        label: `${rule.label}: approaching level`,
        shortLabel: rule.label,
        value: { kind: 'number', value: a.value, unit: rule.unit },
        // SPEC 3.2: ceilings approach when value >= approach_at; floors when value <= approach_at.
        condition: { kind: 'compare', lead: 'approaching when value', op: ceiling ? 'ge' : 'le', value: a.value, unit: rule.unit },
        categories: [rule.category],
        chip: a.chip,
        source: a.source,
        appliesTo: rule.applies_to,
        appliesNote: null,
        parentId: rule.id,
        usedBy: [{ id: rule.id, label: rule.label, role: 'approach level of', href: provHref(rule.id) }],
        notes: [],
        facts: aFacts,
      })
    }
  }
  for (const [i, c] of (THRESHOLDS?.constants ?? []).entries()) {
    push({
      id: c.id,
      aliases: [],
      kind: 'constant',
      file: 'thresholds',
      path: `thresholds.json constants[${i}].value`,
      label: c.label,
      value: valueOf(c.value, c.unit),
      condition: null,
      categories: [],
      chip: c.chip,
      source: c.source,
      appliesTo: null,
      appliesNote: null,
      parentId: null,
      notes: [],
      facts: [],
    })
  }

  // ---- personal.json: RCI settings and per-indicator reliability ----
  const indicators = PERSONAL?.indicators ?? []
  if (PERSONAL?.rci) {
    const rci = PERSONAL.rci
    for (const f of RCI_FIELDS) {
      const prov = rci.provenance?.[f.key]
      const facts: ProvRow['facts'] = []
      if (rci.method) facts.push({ label: 'Method', text: rci.method, chip: rci.chip, source: rci.source })
      if (rci.caveat) facts.push({ label: 'Caveat', text: rci.caveat })
      push({
        id: `rci.${f.key}`,
        aliases: [],
        kind: 'rci',
        file: 'personal',
        path: `personal.json rci.${f.key}`,
        label: f.label,
        value: { kind: 'number', value: rci[f.key], unit: f.unit },
        condition:
          f.key === 'min_baseline_n'
            ? { kind: 'compare', lead: 'evaluated only when baseline n', op: 'ge', value: rci.min_baseline_n, unit: null }
            : null,
        categories: ['PERSONAL'],
        chip: prov?.chip ?? rci.chip,
        source: prov?.source ?? rci.source,
        appliesTo: ['*'],
        appliesNote: null,
        parentId: null,
        usedBy: [{ id: 'personal', label: `all ${indicators.length} personal indicators`, role: 'Tier B', href: null }],
        notes: [],
        facts,
      })
    }
    // The critical value is not a stored constant: the engine derives it from alpha and the
    // baseline length (Crawford & Howell 1998 single-case test, df = n - 1). Shown for the full
    // baseline window and for the fewest baseline days accepted.
    const r3 = (x: number) => Math.round(x * 1000) / 1000
    const criticalRow = (n: number, id: string, aliases: string[], lead: string, from: string) => {
      const df = n - 1
      const crit = r3(tCritical(rci.alpha_two_tailed, df))
      push({
        id,
        aliases,
        kind: 'rci',
        file: 'personal',
        path: `derived by the engine: tCritical(rci.alpha_two_tailed, rci.${from} - 1)`,
        label: `${lead} (|t|, ${n}-day baseline, df ${df})`,
        value: { kind: 'number', value: crit, unit: 't' },
        condition: { kind: 'compare', lead: 'reliable change when |t|', op: 'gt', value: crit, unit: null },
        categories: ['PERSONAL'],
        chip: 'derived',
        source: {
          kind: 'derived',
          from: ['rci.alpha_two_tailed', `rci.${from}`],
          arithmetic: `Student t quantile at two-tailed alpha ${rci.alpha_two_tailed} with df = ${n} - 1 = ${df}; t = (x - mean) / (SD * sqrt(1 + 1/n)) (Crawford & Howell 1998)`,
        },
        appliesTo: ['*'],
        appliesNote: null,
        parentId: null,
        usedBy: [{ id: 'personal', label: `all ${indicators.length} personal indicators`, role: 'Tier B', href: null }],
        notes: [],
        facts: rci.method ? [{ label: 'Method', text: rci.method, chip: rci.chip, source: rci.source }] : [],
      })
      return crit
    }
    const n = rci.baseline_window_days
    const crit = criticalRow(n, 'rci.critical', ['rci.critical_z'], 'Single-case test critical value', 'baseline_window_days')
    if (rci.min_baseline_n !== n) criticalRow(rci.min_baseline_n, 'rci.critical_min_baseline', [], 'Critical value at the fewest baseline days', 'min_baseline_n')
    // The smallest one-day change the test can flag, in baseline SDs: critical x sqrt(1 + 1/n).
    // Times each crewmember's own baseline SD it is that indicator's minimum detectable change.
    const mdcSd = r3(crit * Math.sqrt(1 + 1 / n))
    push({
      id: 'rci.min_detectable_change_sd',
      aliases: ['rci.mdc'],
      kind: 'rci',
      file: 'personal',
      path: 'derived: rci.critical x sqrt(1 + 1/rci.baseline_window_days)',
      label: `Smallest flaggable one-day change, in baseline SDs (${n}-day baseline)`,
      value: { kind: 'number', value: mdcSd, unit: 'SD' },
      condition: { kind: 'compare', lead: 'flagged when |today − mean| / SD', op: 'gt', value: mdcSd, unit: null },
      categories: ['PERSONAL'],
      chip: 'derived',
      source: {
        kind: 'derived',
        from: ['rci.critical', 'rci.baseline_window_days'],
        arithmetic: `minimum detectable change = critical x SD x sqrt(1 + 1/n) = ${crit} x sqrt(1 + 1/${n}) = ${mdcSd} baseline SDs; in an indicator's own unit it is this multiple of the crewmember's baseline SD, which the engine reports per finding (critical x S_diff)`,
      },
      appliesTo: ['*'],
      appliesNote: null,
      parentId: null,
      usedBy: [{ id: 'personal', label: `all ${indicators.length} personal indicators`, role: 'Tier B', href: null }],
      notes: [],
      facts: (() => {
        // personal.json's own statement of the detectable change, when the rules carry one.
        const dc = (rci as unknown as { detectable_change?: { text?: string; chip?: string; source?: RuleSource } }).detectable_change
        return dc?.text ? [{ label: 'From personal.json', text: dc.text, chip: dc.chip, source: dc.source }] : []
      })(),
    })
  }
  for (const [i, ind] of indicators.entries()) {
    const facts: ProvRow['facts'] = []
    facts.push({
      label: 'Indicator',
      text: `${ind.variable} (${ind.unit}) · worse = ${ind.worse} · ${ind.alerting ? 'alerting' : 'never alerts'}${ind.private ? ' · private by default' : ''}${ind.device ? ` · via ${ind.device}` : ''}`,
    })
    if (ind.definition) facts.push({ label: 'Definition', text: ind.definition.text, chip: ind.definition.chip, source: ind.definition.source })
    if (ind.context) facts.push({ label: 'Context', text: ind.context.text, chip: ind.context.chip, source: ind.context.source })
    // Any other sourced block on the indicator ({text, chip, source}, e.g. a reference range shown as
    // context) is listed too, so a field added to personal.json is never silently dropped here.
    // S2: the scale the test runs on, with its literature basis (Anscombe 1948).
    const scale = testScaleWords(ind)
    if (scale) {
      facts.push({
        label: 'Test scale',
        text: `${scale}: the engine applies it to every baseline value and to the current value before the test, and maps the band's edges back to ${ind.unit === 'count' ? 'counts' : ind.unit} with the algebraic inverse x = (y/2)² − 3/8. ${ind.transform_basis?.text ?? ''}`.trim(),
        chip: ind.transform_basis?.chip,
        source: ind.transform_basis?.source,
      })
    }
    // S3: how often this indicator flags with no real change, from the engine (measured where personal.json declares it).
    const chance = chanceRateOf(ind.id)
    if (chance) {
      facts.push({
        label: chance.basis === 'measured' ? 'Chance rate (engine, measured)' : 'Chance rate (engine, nominal)',
        text:
          chance.basis === 'measured'
            ? `${chance.text}. Measured, not assumed: cautions ${chance.caution_multiplier} times the nominal rate, reliable changes in either direction ${chance.flag_multiplier} times. ${chance.note ?? ''}`.trim()
            : `${chance.text}: the test's nominal rate (alpha/2 for a change in the worse direction; alpha when either direction alerts, or for a non-alerting indicator). The rate measured under the scenario's noise model is close enough to it that the nominal rate is printed (engine/tests/test_chance_rates.py).`,
        chip: chance.chip,
        source: chance.source as RuleSource,
      })
    }
    for (const [key, val] of Object.entries(ind as unknown as Record<string, unknown>)) {
      if (key === 'definition' || key === 'context' || key === 'reliability_r' || key === 'transform_basis' || key === 'chance_rate') continue
      const v = val as { text?: unknown; chip?: unknown; source?: unknown } | null
      if (v && typeof v === 'object' && typeof v.text === 'string' && typeof v.chip === 'string') {
        facts.push({ label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), text: v.text, chip: v.chip, source: (v.source as RuleSource) ?? undefined })
      }
    }
    // reliability_r is context only now (used_by_engine: false): never render it as a constant the
    // engine uses. Old deep links (#/provenance?id=<indicator>.reliability_r) still resolve (alias).
    const rel = ind.reliability_r
    const relUsed = !!rel && rel.used_by_engine !== false && typeof rel.value === 'number'
    if (rel?.source?.basis_citation) facts.push({ label: relUsed ? 'Basis cited' : 'Reliability (context only, not used by the test)', text: rel.source.basis_citation })
    push({
      id: ind.id,
      aliases: [`${ind.id}.reliability_r`],
      kind: 'reliability',
      file: 'personal',
      path: relUsed ? `personal.json indicators[${i}].reliability_r.value` : `personal.json indicators[${i}]`,
      label: relUsed ? `${ind.label}: test-retest reliability` : `${ind.label}: Tier B indicator`,
      shortLabel: ind.label,
      value: relUsed
        ? { kind: 'number', value: rel!.value as number, unit: 'r' }
        : { kind: 'band', unit: ind.unit },
      condition: relUsed
        ? null
        : { kind: 'text', text: `own baseline band; ${ind.alerting ? `a reliable change for the worse (${ind.worse}) is a caution at most` : 'shown, never alerts'}` },
      categories: ['PERSONAL'],
      chip: relUsed ? rel!.chip : (ind.definition?.chip ?? 'design choice'),
      source: relUsed ? rel!.source : (ind.definition?.source ?? { kind: 'design_choice', rationale: 'Indicator chosen by LANDFALL for the Tier B single-case test.' }),
      appliesTo: ['*'],
      appliesNote: ind.alerting ? null : 'context only, never alerts',
      parentId: null,
      usedBy: [{ id: 'trends', label: 'each crewmember’s band on Trends', role: 'tested daily for', href: '#/trends' }],
      notes: [],
      facts,
    })
    // S2: the test scale's own constant (Anscombe 1948: y = 2 * sqrt(x + 3/8)), from the engine.
    if (ind.transform === 'anscombe' && ind.transform_basis) {
      push({
        id: `${ind.id}.transform`,
        aliases: [],
        kind: 'rci',
        file: 'personal',
        path: `personal.json indicators[${i}].transform ("anscombe"); the offset is the engine's ANSCOMBE_OFFSET`,
        label: `${ind.label}: test scale, ${transformFormula('anscombe')} (offset)`,
        shortLabel: ind.label,
        value: { kind: 'number', value: ANSCOMBE_OFFSET, unit: null },
        condition: { kind: 'text', text: `${testScaleWords(ind)}; the band is mapped back with x = (y/2)² − 3/8` },
        categories: ['PERSONAL'],
        chip: ind.transform_basis.chip,
        source: ind.transform_basis.source,
        appliesTo: ['*'],
        appliesNote: null,
        parentId: ind.id,
        usedBy: [{ id: ind.id, label: ind.label, role: 'test scale of', href: provHref(ind.id) }],
        notes: [],
        facts: [{ label: 'Why', text: ind.transform_basis.text, chip: ind.transform_basis.chip, source: ind.transform_basis.source }],
      })
    }
    // S3: measured chance-rate multipliers, declared where the measured rate is far from the nominal one.
    const cr = ind.chance_rate
    if (cr && typeof cr.caution_multiplier === 'number' && typeof cr.flag_multiplier === 'number') {
      const rate = chanceRateOf(ind.id)
      for (const [key, value, what] of [
        ['caution_multiplier', cr.caution_multiplier, ind.alerting ? 'chance cautions (a reliable change in the worse direction)' : 'chance reliable changes in the worse direction (never an alert)'],
        ['flag_multiplier', cr.flag_multiplier, 'chance reliable changes in either direction'],
      ] as const) {
        push({
          id: `${ind.id}.chance_rate.${key}`,
          aliases: key === 'caution_multiplier' ? [`${ind.id}.chance_rate`] : [],
          kind: 'rci',
          file: 'personal',
          path: `personal.json indicators[${i}].chance_rate.${key}`,
          label: `${ind.label}: measured rate of ${what}, × nominal`,
          shortLabel: ind.label,
          value: { kind: 'number', value, unit: '× nominal' },
          condition: rate ? { kind: 'text', text: `printed: ${rate.text}` } : null,
          categories: ['PERSONAL'],
          chip: cr.chip,
          source: cr.source,
          appliesTo: ['*'],
          appliesNote: null,
          parentId: ind.id,
          usedBy: [{ id: ind.id, label: ind.label, role: 'chance rate of', href: provHref(ind.id) }],
          notes: [],
          facts: cr.text ? [{ label: 'From personal.json', text: cr.text, chip: cr.chip, source: cr.source }] : [],
        })
      }
    }
  }

  // ---- cases.json: tripwires and projections ----
  const ruleById = new Map((THRESHOLDS?.rules ?? []).map((r) => [r.id, r]))
  const indById = new Map(indicators.map((x) => [x.id, x]))
  for (const [ci, c] of (CASES?.cases ?? []).entries()) {
    const tw = c.tripwire
    if (tw) {
      const watched = tw.condition.rule_id ?? tw.condition.indicator_id ?? ''
      const wRule = tw.condition.rule_id ? ruleById.get(tw.condition.rule_id) : undefined
      const wInd = tw.condition.indicator_id ? indById.get(tw.condition.indicator_id) : undefined
      const unit = wRule?.unit ?? wInd?.unit ?? null
      // Where the case can open: the union of its triggers' environments (personal triggers run everywhere).
      const envs = new Set<string>()
      for (const t of c.triggers) {
        if (t.kind === 'personal') envs.add('*')
        else if (t.rule_id) for (const e of ruleById.get(t.rule_id)?.applies_to ?? []) envs.add(e)
      }
      const appliesTo = envs.has('*') || envs.size >= (ENV_FILE?.environments.length ?? 4) ? ['*'] : [...envs]
      push({
        id: `${c.id}.tripwire`,
        aliases: [],
        kind: 'tripwire',
        file: 'cases',
        path: `cases.json cases[${ci}].tripwire`,
        label: `${c.title}: tripwire`,
        shortLabel: c.title,
        value: {
          kind: 'tripwire',
          op: tw.condition.op,
          value: tw.condition.value,
          unit,
          of_last_n: tw.condition.of_last_n,
          at_least: tw.condition.at_least,
          reassess_after_s: tw.reassess_after_s,
        },
        condition: { kind: 'text', text: tw.text },
        categories: wRule ? [wRule.category] : wInd ? ['PERSONAL'] : [],
        chip: tw.chip,
        source: tw.source,
        appliesTo,
        appliesNote: null,
        parentId: null,
        usedBy: [
          { id: c.id, label: c.title, role: 'tripwire of case', href: caseHref(c.id) },
          ...(watched ? [{ id: watched, label: wRule?.label ?? wInd?.label ?? watched, role: 'watches', href: provHref(watched) }] : []),
        ],
        notes: [],
        facts: [],
      })
    }
    for (const [pi, p] of (c.projections ?? []).entries()) {
      const fromRule = (p.source.from ?? []).map((id) => ruleById.get(id)).find(Boolean)
      const facts: ProvRow['facts'] = []
      if (p.caveat) facts.push({ label: 'Caveat', text: p.caveat.text, chip: p.caveat.chip, source: p.caveat.source })
      push({
        id: p.id,
        aliases: [],
        kind: 'projection',
        file: 'cases',
        path: `cases.json cases[${ci}].projections[${pi}].value`,
        label: p.label,
        value: valueOf(p.value, p.unit),
        condition: null,
        categories: fromRule ? [fromRule.category] : [],
        chip: p.chip,
        source: p.source,
        appliesTo: null,
        appliesNote: 'illustration, not a forecast',
        parentId: null,
        usedBy: [{ id: c.id, label: c.title, role: 'shown in case', href: caseHref(c.id) }],
        notes: [],
        facts,
      })
    }
  }

  // ---- environments.json: physical constants and comms light time ----
  for (const [i, c] of (ENV_FILE?.constants ?? []).entries()) {
    push({
      id: c.id,
      aliases: [],
      kind: 'constant',
      file: 'environments',
      path: `environments.json constants[${i}].value`,
      label: c.label,
      value: valueOf(c.value, c.unit),
      condition: null,
      categories: [],
      chip: c.chip,
      source: c.source,
      appliesTo: null,
      appliesNote: null,
      parentId: null,
      notes: [],
      facts: [],
    })
  }
  for (const [i, e] of (ENV_FILE?.environments ?? []).entries()) {
    if (!e.comms) continue
    const owlt = e.comms.one_way_light_time_s
    const value: RowValue = owlt.from_snapshot
      ? { kind: 'snapshot', snapshot: owlt.from_snapshot, unit: 's' }
      : owlt.min !== undefined && owlt.max !== undefined
        ? { kind: 'range', min: owlt.min, max: owlt.max, mean: owlt.mean, unit: 's' }
        : { kind: 'number', value: owlt.max ?? owlt.min ?? Number.NaN, unit: 's' }
    push({
      id: `${e.id}.comms`,
      aliases: [],
      kind: 'comms',
      file: 'environments',
      path: `environments.json environments[${i}].comms.one_way_light_time_s`,
      label: `${e.label}: one-way light time`,
      shortLabel: e.label,
      value,
      condition: { kind: 'text', text: e.comms.conjunction ? 'can be blocked by solar conjunction' : 'no conjunction blackout modelled' },
      categories: [],
      chip: e.comms.chip,
      source: e.comms.source,
      appliesTo: [e.id],
      appliesNote: null,
      parentId: null,
      usedBy: [{ id: e.id, label: envShort(e.id), role: 'comms ETA in', href: null }],
      notes: e.notes ?? [],
      facts: [],
    })
  }

  // ---- meta.json: severity mapping ----
  const sm = META?.severity_mapping
  for (const [i, m] of (sm?.rows ?? []).entries()) {
    const facts: ProvRow['facts'] = []
    if (m.note) facts.push({ label: 'Note', text: m.note })
    if (m.colour_note) facts.push({ label: 'Colour', text: m.colour_note })
    push({
      id: `severity.${m.id}`,
      aliases: [],
      kind: 'severity_map',
      file: 'meta',
      path: `meta.json severity_mapping.rows[${i}]`,
      label: `Severity mapping: ${m.id.replace(/_/g, ' ')}`,
      shortLabel: m.id.replace(/_/g, ' '),
      value: { kind: 'mapping', severity: m.severity ?? null, severity_max: m.severity_max ?? null },
      condition: { kind: 'text', text: mappingWhenText(m.when) },
      categories: mappingCategories(m.when),
      chip: sm!.chip,
      source: sm!.source,
      appliesTo: ['*'],
      appliesNote: null,
      parentId: null,
      usedBy: [{ id: 'severity', label: 'every engine finding', role: 'severity of', href: null }],
      notes: [],
      facts,
    })
  }

  // ---- reverse index: "used by" ----
  const byId = new Map(rows.map((r) => [r.id, r]))
  const add = (targetId: string, ref: Ref) => {
    const t = byId.get(targetId) ?? rows.find((r) => r.aliases.includes(targetId))
    if (!t) return
    if (!t.usedBy.some((u) => u.id === ref.id && u.role === ref.role)) t.usedBy.push(ref)
  }
  for (const c of CASES?.cases ?? []) {
    for (const t of c.triggers) {
      const target = t.rule_id ?? t.indicator_id
      if (target) add(target, { id: c.id, label: c.title, role: 'opens case', href: caseHref(c.id) })
    }
    const w = c.tripwire?.condition
    const watched = w?.rule_id ?? w?.indicator_id
    if (watched) add(watched, { id: `${c.id}.tripwire`, label: `${c.title}: tripwire`, role: 'watched by', href: provHref(`${c.id}.tripwire`) })
  }
  for (const rule of THRESHOLDS?.rules ?? []) {
    if (rule.case_id) add(rule.id, { id: rule.case_id, label: caseTitle(rule.case_id), role: 'linked to case', href: caseHref(rule.case_id) })
    if (rule.derived_from_rule) add(rule.derived_from_rule, { id: rule.id, label: rule.label, role: 'reused by', href: provHref(rule.id) })
  }
  for (const ind of indicators) {
    if (ind.case_id) add(ind.id, { id: ind.case_id, label: caseTitle(ind.case_id), role: 'linked to case', href: caseHref(ind.case_id) })
  }
  for (const r of rows) {
    if (r.source?.kind === 'derived') for (const from of r.source.from ?? []) add(from, { id: r.id, label: r.label, role: 'input to', href: provHref(r.id) })
  }

  // ---- search text ----
  for (const r of rows) {
    r.searchText = [
      r.id,
      ...r.aliases,
      r.label,
      r.path,
      r.chip,
      ...r.categories,
      r.value.kind === 'number' || r.value.kind === 'range' || r.value.kind === 'tripwire' ? r.value.unit : '',
      r.value.kind === 'number' ? String(r.value.value) : '',
      r.value.kind === 'range' ? `${r.value.min} ${r.value.max}` : '',
      r.value.kind === 'tripwire' ? String(r.value.value) : '',
      r.value.kind === 'mapping' ? `${r.value.severity ?? ''} ${r.value.severity_max ?? ''}` : '',
      r.condition?.kind === 'text' ? r.condition.text : '',
      sourceSearchText(r.source),
      ...(r.appliesTo ?? []).map(envShort),
      ...r.usedBy.map((u) => `${u.id} ${u.label}`),
      ...r.notes,
      ...r.facts.map((f) => f.text),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
  }
  return rows
}

/** Every constant row, computed once per page load. */
export const ROWS: readonly ProvRow[] = buildRows()

export function findRow(id: string): { row: ProvRow; matches: ProvRow[] } | null {
  const exact = ROWS.find((r) => r.id === id)
  if (exact) return { row: exact, matches: [exact] }
  const aliased = ROWS.filter((r) => r.aliases.includes(id))
  return aliased.length ? { row: aliased[0], matches: aliased } : null
}

// ---------------------------------------------------------------------------------------------
// Grouping for the table and the design-choice section
// ---------------------------------------------------------------------------------------------

export const GROUPS: { id: string; title: string; file: RuleFileName; kinds: RowKind[] }[] = [
  { id: 'rules', title: 'Tier A rules and their approaching levels', file: 'thresholds', kinds: ['limit', 'approach'] },
  { id: 'thresholds_constants', title: 'Constants that derived numbers point to', file: 'thresholds', kinds: ['constant'] },
  { id: 'personal', title: 'Tier B: reliable change against your own baseline', file: 'personal', kinds: ['rci', 'reliability'] },
  { id: 'cases', title: 'Case tripwires and projections', file: 'cases', kinds: ['tripwire', 'projection'] },
  { id: 'environments', title: 'Environments: physical constants and comms light time', file: 'environments', kinds: ['constant', 'comms'] },
  { id: 'meta', title: 'Severity mapping (which finding lights which annunciator class)', file: 'meta', kinds: ['severity_map'] },
]

export function groupOf(r: ProvRow): string {
  return GROUPS.find((g) => g.file === r.file && g.kinds.includes(r.kind))?.id ?? 'rules'
}

export const KIND_FAMILY: Record<RowKind, string> = {
  limit: 'Thresholds we reuse',
  approach: 'Approaching levels',
  constant: 'Constants',
  rci: 'Reliable-change settings',
  // Rows of kind 'reliability' are the Tier B indicators (the single-case test uses no test-retest reliability).
  reliability: 'Tier B indicators',
  tripwire: 'Case tripwires',
  projection: 'Projections',
  comms: 'Comms light-time envelopes',
  severity_map: 'Severity mapping',
}

function rationaleKey(r: ProvRow): string {
  const text = r.source?.rationale ?? ''
  return (
    r.kind +
    '|' +
    text
      .replace(/\([^)]*\)/g, '')
      .replace(/\d[\d.,]*/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  )
}

export interface DesignGroup {
  key: string
  family: string
  rationale: string
  /** True when members say the same thing with their own numbers. */
  numbersDiffer: boolean
  members: ProvRow[]
}

/** Design-choice rows grouped by rationale (same reasoning, different numbers = one group). */
export function designChoiceGroups(rows: readonly ProvRow[]): DesignGroup[] {
  const groups = new Map<string, DesignGroup>()
  for (const r of rows) {
    if (r.chip !== 'design choice') continue
    const key = rationaleKey(r)
    const g = groups.get(key)
    if (g) {
      g.members.push(r)
      if ((r.source?.rationale ?? '') !== g.rationale) g.numbersDiffer = true
    } else {
      groups.set(key, { key, family: KIND_FAMILY[r.kind], rationale: r.source?.rationale ?? '(no rationale given)', numbersDiffer: false, members: [r] })
    }
  }
  return [...groups.values()]
}

export interface DesignFamily {
  family: string
  count: number
  groups: DesignGroup[]
}

/** Rationale groups folded into one card per family, in first-seen order. */
export function designChoiceFamilies(rows: readonly ProvRow[]): DesignFamily[] {
  const out: DesignFamily[] = []
  for (const g of designChoiceGroups(rows)) {
    const f = out.find((x) => x.family === g.family)
    if (f) {
      f.groups.push(g)
      f.count += g.members.length
    } else out.push({ family: g.family, count: g.members.length, groups: [g] })
  }
  return out
}

/** Every requirement ID the rules cite, in a field or in text, with where it is cited. */
export function citedRequirements(): { id: string; citedBy: string[] }[] {
  const found = new Map<string, Set<string>>()
  const note = (raw: string, where: string) => {
    const id = raw.replace(/^\[|\]$/g, '').trim()
    if (!/^V[12] \d+$/.test(id)) return
    if (!found.has(id)) found.set(id, new Set())
    found.get(id)!.add(where)
  }
  const walk = (o: unknown, where: string) => {
    if (typeof o === 'string') {
      for (const m of o.matchAll(/\[(V[12] \d+)\]/g)) note(m[1], where)
    } else if (Array.isArray(o)) {
      for (const v of o) walk(v, where)
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if ((k === 'requirement_id' && typeof v === 'string') || (k === 'requirement_ids' && Array.isArray(v))) {
          for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') note(x, where)
        }
        walk(v, where)
      }
    }
  }
  for (const r of THRESHOLDS?.rules ?? []) walk(r, r.id)
  for (const c of THRESHOLDS?.constants ?? []) walk(c, c.id)
  if (PERSONAL) {
    walk(PERSONAL.rci, 'rci')
    for (const ind of PERSONAL.indicators) walk(ind, ind.id)
  }
  for (const c of CASES?.cases ?? []) walk(c, c.id)
  for (const c of ENV_FILE?.constants ?? []) walk(c, c.id)
  for (const e of ENV_FILE?.environments ?? []) walk(e, e.id)
  if (META) walk(META, 'meta.json')
  const vol = (id: string) => Number(id.slice(1, 2))
  const num = (id: string) => Number(id.split(' ')[1])
  return [...found.entries()]
    .map(([id, set]) => ({ id, citedBy: [...set].sort() }))
    .sort((a, b) => vol(a.id) - vol(b.id) || num(a.id) - num(b.id))
}
