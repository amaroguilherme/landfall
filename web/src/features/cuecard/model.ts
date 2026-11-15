// Paper cue cards ([V2 10130], NASA-STD-3001 Vol 2 Rev F section 10.2.13): one printable page per case,
// for when the LANDFALL display itself is lost. A card is rendered ONLY from:
//   - the shipped rules (engine/rules/cases.json, thresholds.json, personal.json, meta.json, environments.json);
//   - the crew vocabulary (app/vocab CREW);
//   - the frozen std_vol2 snapshot (the [V2 10130] requirement text, never typed here);
//   - the TEMPLATE strings below (every sentence on a card that is not a rules string).
// Pure: no React, no fetch, no clock. The view passes the snapshot, the rules digest and the date in.
//
// Every string on a card is an Atom that names where it came from, so a test resolves each one back to
// its source (rules path, TEMPLATE key, CREW entry, snapshot path) and the view renders nothing else.
// A never-print list keeps flight-surgeon-only text (the potassium citrate note), private variables (mood)
// and drug names or doses off the card: a card that would print one is refused, never silently trimmed.
import { evaluateRule, fmtNum } from '../../app/engine'
import type { CaseDef, CaseStep, Indicator, Op, Rule, Rules } from '../../app/engine'
import { CREW, SEVERITY_RANK } from '../../app/vocab'
import type { CrewId, Severity } from '../../app/vocab'

// =============================================================================================
// TEMPLATE: every sentence on a card that is not a rules string
// =============================================================================================

export const TEMPLATE = {
  header: '[V2 10130] Use this card when the LANDFALL display is unavailable.',
  footer:
    'LANDFALL demo cue card, not a NASA procedure. No diagnosis. No medication or dose. Does not replace the vehicle caution and warning system or its radiation alarm ([V2 6164]).',
  digest: 'rules {digest} · built {date} · if the app shows a different rules digest, this card is out of date',
  digestNone: 'not computed in this browser',
  opensWhen: 'Opens when',
  personalTrigger: 'compared with your own baseline (Tier B)',
  or: 'or',
  watchLevel: 'LANDFALL watch level',
  appliesIn: 'applies in',
  space: ' ',
  doNow: 'Primary countermeasure',
  // A procedure that opens with its red-flag question (renal r4): the countermeasure comes after that answer.
  doNowAfterRedFlag: 'Primary countermeasure, after the red-flag question in step 1',
  steps: 'Steps',
  required: 'REQUIRED',
  // True for every role (SPEC 2): the rules' own escalation words, so the CMO is never told to tell the CMO. The hold
  // after them is the app's (cases RedFlagHold, a design choice): with the display lost, the card must stop there too.
  redFlag: 'RED FLAG: yes = tell the Crew Medical Officer now (if that is you, the Commander), then hold the remaining steps until they have seen you',
  yes: 'yes',
  no: 'no',
  metCue: 'd/hh:mm:ss, e.g. {example}',
  perCrew: 'Write it for each crewmember in the crew table.',
  crewmember: 'Crewmember',
  step: 'Step',
  tripwire: 'Tripwire',
  escalate: 'Escalate',
  refusals: 'Refusals',
  basis: 'Trigger basis',
  sep: ' · ',
  basisSep: '; ',
  listSep: ', ',
  severity: { nominal: 'NOMINAL', advisory: 'ADVISORY', caution: 'CAUTION', warning: 'WARNING', emergency: 'EMERGENCY' },
  op: { lt: '<', le: '≤', gt: '>', ge: '≥' },
  fmt: { req: '[{v}]', section: '§{v}', page: 'p. {v}' },
  printOne: 'Print cue card',
  printAll: 'Print all {n} cue cards',
  linkDigest: 'rules {digest}',
} as const

/** A dotted TEMPLATE key: "header", "severity.warning", "op.ge", ... */
export type TemplateKey = string
type Fmt = keyof typeof TEMPLATE.fmt | 'num'

/** The TEMPLATE string at a dotted key (throws on an unknown key: a typo must never print). */
export function templateText(key: TemplateKey): string {
  let node: unknown = TEMPLATE
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) throw new Error(`cue card: no TEMPLATE string "${key}"`)
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node !== 'string') throw new Error(`cue card: TEMPLATE "${key}" is not a string`)
  return node
}

/** Fill {placeholders}; every placeholder must be given and every given var used. */
export function fill(template: string, vars: Record<string, string> = {}): string {
  const used = new Set<string>()
  const out = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`cue card: no value for {${name}} in "${template}"`)
    used.add(name)
    return vars[name]
  })
  for (const k of Object.keys(vars)) if (!used.has(k)) throw new Error(`cue card: {${k}} is not in "${template}"`)
  return out
}

// =============================================================================================
// Atoms
// =============================================================================================

export type Path = ReadonlyArray<string | number>

export type AtomSrc =
  /** RULES[path]: a string as is, or a number/id printed through `fmt`. */
  | { kind: 'rules'; path: Path; fmt?: Fmt }
  | { kind: 'template'; key: TemplateKey; vars?: Record<string, string> }
  /** vocab CREW (SPEC section 2: fictional crew ids and roles). */
  | { kind: 'crew'; id: CrewId; field: 'id' | 'role' }
  /** A field of a frozen snapshot, from the snapshot root (e.g. ["data", "requirements", 29, "text"]). */
  | { kind: 'snapshot'; id: string; path: Path; fmt?: Fmt }
  /** A 1-based list position: a procedure step's number, or the tier number of an added caregiver line. */
  | { kind: 'computed'; what: 'step_number' | 'tier_number' | 'note_number'; value: number }

export interface Atom {
  text: string
  src: AtomSrc
}

/** Read a value at a path (undefined when any segment is missing). */
export function resolvePath(root: unknown, path: Path): unknown {
  let node: unknown = root
  for (const seg of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[seg]
  }
  return node
}

/** Print a rules/snapshot value the way an atom with this `fmt` prints it. */
export function formatValue(value: unknown, fmt?: Fmt): string {
  if (fmt === undefined) {
    if (typeof value !== 'string') throw new Error('cue card: a plain atom must be a string')
    return value
  }
  if (fmt === 'num') {
    if (typeof value !== 'number') throw new Error('cue card: fmt num needs a number')
    return fmtNum(value, 3)
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`cue card: fmt ${fmt} needs a string or number`)
  return fill(TEMPLATE.fmt[fmt], { v: typeof value === 'number' ? fmtNum(value, 3) : value })
}

const T = (key: TemplateKey, vars?: Record<string, string>): Atom => ({
  text: vars ? fill(templateText(key), vars) : templateText(key),
  src: vars ? { kind: 'template', key, vars } : { kind: 'template', key },
})

function R(rules: Rules, path: Path, fmt?: Fmt): Atom {
  const value = resolvePath(rules, path)
  return { text: formatValue(value, fmt), src: fmt ? { kind: 'rules', path, fmt } : { kind: 'rules', path } }
}

function S(snapshot: unknown, id: string, path: Path, fmt?: Fmt): Atom | null {
  const value = resolvePath(snapshot, path)
  if (value === undefined || value === null || value === '') return null
  return { text: formatValue(value, fmt), src: fmt ? { kind: 'snapshot', id, path, fmt } : { kind: 'snapshot', id, path } }
}

/** Every atom inside a card (or any structure), in document order. */
export function collectAtoms(node: unknown, out: Atom[] = []): Atom[] {
  if (Array.isArray(node)) {
    for (const v of node) collectAtoms(v, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const o = node as Record<string, unknown>
  if (typeof o.text === 'string' && o.src && typeof o.src === 'object') {
    out.push(o as unknown as Atom)
    return out
  }
  for (const v of Object.values(o)) collectAtoms(v, out)
  return out
}

/** A stable label for an atom's source (rendered as data-src, so a DOM check can find stray text). */
export function srcKey(src: AtomSrc): string {
  switch (src.kind) {
    case 'rules':
      return `rules:${src.path.join('.')}${src.fmt ? `|${src.fmt}` : ''}`
    case 'template':
      return `template:${src.key}`
    case 'crew':
      return `crew:${src.id}.${src.field}`
    case 'snapshot':
      return `snapshot:${src.id}:${src.path.join('.')}${src.fmt ? `|${src.fmt}` : ''}`
    case 'computed':
      return `computed:${src.what}`
  }
}

// =============================================================================================
// Card shape
// =============================================================================================

export interface TriggerLine {
  kind: 'rule' | 'personal'
  /** Rule or indicator id (not printed). */
  ref: string
  severity: Severity
  sevWord: Atom
  /** label, op, value, unit (rule) or label + TEMPLATE.personalTrigger (personal). */
  parts: Atom[]
  chip: Atom | null
  /** A second opening condition of the same rule: its watch level, when that level reaches caution. */
  approach: { severity: Severity; sevWord: Atom; parts: Atom[]; chip: Atom | null } | null
  /** Requirement ID, table or document, and where the rule applies. Inline, or as footnote number `note`. */
  basis: Atom[]
  note: Atom | null
}

export type StepInput =
  | { kind: 'met'; variable: string; unit: Atom; cue: Atom; perCrew: boolean }
  | { kind: 'yesno'; variable: string; unit: Atom; yes: Atom; no: Atom; perCrew: boolean }
  | { kind: 'value'; variable: string; unit: Atom; perCrew: boolean }

export interface StepItem {
  id: string
  n: Atom
  text: Atom
  tags: Array<{ kind: 'required' | 'red_flag'; text: Atom }>
  redFlags: Atom[]
  input: StepInput | null
  /** A per-crewmember input on the crew-wide card: written in the crew table (TEMPLATE.perCrew). */
  perCrewHint: Atom | null
}

export interface CrewTable {
  head: Atom
  columns: Array<{ stepId: string; step: Atom; n: Atom; input: StepInput }>
  rows: Array<{ id: Atom; role: Atom }>
}

/** One escalation tier of meta.json, with any backup it names (e.g. who is tier 1 when the CMO is the patient). */
export interface TierLine {
  tier: Atom
  label: Atom
  when: Atom | null
  backups: Array<{ label: Atom; when: Atom | null; applies: Atom | null }>
}

export interface CueCard {
  caseId: string
  crewWide: boolean
  /** Highest opening severity over the triggers (binder order: a Warning card first). */
  severity: Severity
  header: Atom
  quote: { text: Atom; source: Atom[] } | null
  title: Atom
  oneLine: Atom
  headings: { opensWhen: Atom; doNow: Atom; steps: Atom; tripwire: Atom; escalate: Atom; refusals: Atom; basis: Atom }
  triggers: TriggerLine[]
  basisPlacement: 'inline' | 'footnote'
  primary: Atom
  steps: StepItem[]
  crewTable: CrewTable | null
  tripwire: Atom
  tiers: TierLine[]
  refusals: Atom[]
  digest: Atom
  footer: Atom
}

export interface CueCardOptions {
  /** Full hex SHA-256 of the canonical rules (rulesDigest), or null when this browser cannot compute it. */
  digest: string | null
  /** The day the card is built, YYYY-MM-DD (UTC). */
  date: string
  /** The MET format example for MET boxes: the app's formatMet output (F.6.1 f), e.g. "412/14:20:00". */
  metExample: string
  /**
   * Where trigger bases print. Default inline: every card fits one page at Letter and A4 that way
   * (scripts/print-card.mjs measures the room left). 'footnote' is the fallback for a card that would overflow:
   * move the bases into numbered notes rather than shrink the type.
   */
  basisPlacement?: 'inline' | 'footnote'
}

/** The std_vol2 snapshot fields the card reads (a full Snapshot satisfies it). */
export interface Vol2Snapshot {
  source?: { name?: string }
  data?: { requirements?: Array<{ id?: string; text?: string; rationale?: string; section?: string; pdf_page?: number }> }
}

export interface CueSnapshots {
  std_vol2_requirements?: Vol2Snapshot | null
}

// =============================================================================================
// Never-print list
// =============================================================================================

/**
 * Drug names that must never reach a crew-facing card (SPEC 1.5: no medication or dosing advice in crew text).
 * Potassium citrate is the one drug the rules name (renal escalation.flight_surgeon_note, audience flight surgeon).
 * The rest are a guard list, not a claim about any case: a rules edit that put one in crew text would be refused.
 */
export const NEVER_PRINT_DRUGS: readonly string[] = [
  'potassium citrate',
  'citrate',
  'potassium iodide',
  'zolpidem',
  'zaleplon',
  'melatonin',
  'modafinil',
  'hypnotic',
  'sedative',
  'opioid',
  'ibuprofen',
  'acetaminophen',
  'paracetamol',
  'aspirin',
  'antiemetic',
  'promethazine',
  'tamsulosin',
]

/** A drug amount (e.g. "10 mg", "0.5 mcg", "3 tablets"); mg/dL readings and radiation units (mGy) do not match. */
export const NEVER_PRINT_DOSE: readonly RegExp[] = [
  /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|μg|meq|iu)\b(?!\s*\/\s*dl)/i,
  /\b(?:tablets?|capsules?|pills?)\b/i,
]

export interface NeverPrint {
  /** Text of every object addressed to the flight surgeon (audience "flight_surgeon"), never on a crew card. */
  audienceText: string[]
  /** Ids, variables and labels of private indicators (mood). */
  privateTerms: string[]
  privateVariables: string[]
  drugs: readonly string[]
  dose: readonly RegExp[]
}

function walkObjects(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) walkObjects(v, visit)
    return
  }
  if (node === null || typeof node !== 'object') return
  const o = node as Record<string, unknown>
  visit(o)
  for (const v of Object.values(o)) walkObjects(v, visit)
}

function stringsIn(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const v of node) stringsIn(v, out)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) stringsIn(v, out)
  return out
}

/** The never-print list for these rules. */
export function neverPrintList(rules: Rules): NeverPrint {
  const audienceText: string[] = []
  walkObjects(RULE_FILE_ORDER.map((k) => rules[k]), (o) => {
    if (o.audience !== 'flight_surgeon') return
    // Its sentences and citations; short tokens (a chip label such as "literature") are not distinctive.
    for (const s of stringsIn(o)) if (s.length >= 24) audienceText.push(s)
  })
  const priv = (rules.personal?.indicators ?? []).filter((i) => i.private === true)
  const privateVariables = [...new Set(priv.flatMap((i) => [i.id, i.variable]))]
  const privateTerms = [...new Set(priv.flatMap((i) => [i.id, i.variable, i.label ?? '']).filter((s) => s.length > 0))]
  return { audienceText, privateTerms, privateVariables, drugs: NEVER_PRINT_DRUGS, dose: NEVER_PRINT_DOSE }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (s: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(s)}($|[^\\p{L}\\p{N}_])`, 'iu')

/** True for an atom that is a verbatim refusal (a case's refusals[] or meta refusals[].text). */
export function isRefusalAtom(a: Atom): boolean {
  if (a.src.kind !== 'rules') return false
  const p = a.src.path
  return (p[0] === 'cases' && p[3] === 'refusals') || (p[0] === 'meta' && p[1] === 'refusals')
}

/** Every never-print hit on a card: [] when the card is printable. */
export function neverPrintViolations(card: CueCard, list: NeverPrint): string[] {
  const out: string[] = []
  for (const a of collectAtoms(card)) {
    for (const s of list.audienceText) if (a.text.includes(s) || (a.text.length >= 24 && s.includes(a.text))) out.push(`flight-surgeon text in "${a.text}"`)
    for (const d of list.drugs) if (wordRe(d).test(a.text)) out.push(`drug name "${d}" in "${a.text}"`)
    for (const re of list.dose) if (re.test(a.text)) out.push(`dose ${re} in "${a.text}"`)
    // A refusal may say that mood stays private; nothing else may name a private indicator.
    if (!isRefusalAtom(a)) for (const p of list.privateTerms) if (wordRe(p).test(a.text)) out.push(`private indicator "${p}" in "${a.text}"`)
  }
  for (const t of card.triggers) if (list.privateVariables.includes(t.ref)) out.push(`private indicator ${t.ref} as a trigger`)
  for (const s of card.steps) if (s.input && list.privateVariables.includes(s.input.variable)) out.push(`private variable ${s.input.variable} as an input`)
  return out
}

/** Marks a never-print refusal in cueCard's error message. */
const NEVER_PRINT_MARK = '(never-print)'

/**
 * The reason a "not built" block may show (on screen and on paper) for a card that failed. A never-print refusal
 * quotes the text it refused (a drug name, a dose, the flight surgeon's note), so the block names only the check;
 * the full message stays in the thrown error for maintainers (the tests build every card). Any other failure names
 * rules ids only and is shown as is.
 */
export function notBuiltReason(message: string): string {
  const i = message.indexOf(NEVER_PRINT_MARK)
  if (i < 0) return message
  return `${message.slice(0, i + NEVER_PRINT_MARK.length)}: it would print text that never goes on a crew card (text for the flight surgeon only, a private indicator, a drug name or a dose).`
}

// =============================================================================================
// Rules digest: SHA-256 of a canonical JSON of the five bundled rules files, in a fixed order
// =============================================================================================

/** The fixed file order of the digest (the order of the engine's RULES / loader.load_rules). */
export const RULE_FILE_ORDER = ['environments', 'thresholds', 'personal', 'cases', 'meta'] as const

/**
 * Canonical JSON: object keys sorted (UTF-16 code unit order; every rules key is ASCII), no whitespace,
 * arrays in order, scalars as JSON.stringify prints them.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('cue card: non-finite number in the rules')
    if (v === undefined) throw new Error('cue card: undefined in the rules')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/** The digest input: canonical JSON of [environments, thresholds, personal, cases, meta]. */
export function rulesCanonical(rules: Rules): string {
  return canonicalJson(RULE_FILE_ORDER.map((k) => rules[k]))
}

/** Hex SHA-256 of rulesCanonical (crypto.subtle); null where the browser has no Web Crypto (insecure context). */
export async function rulesDigest(rules: Rules): Promise<string | null> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle
  if (!subtle) return null
  const bytes = new TextEncoder().encode(rulesCanonical(rules))
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes))
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The first 12 hex characters, as printed on the card and next to each Print link. */
export const shortDigest = (hex: string): string => hex.slice(0, 12)

// =============================================================================================
// Building a card
// =============================================================================================

const OUTSIDE_OP: Record<Op, Op> = { lt: 'ge', le: 'gt', gt: 'le', ge: 'lt' }
const CEILINGS: readonly Op[] = ['lt', 'le']

function indexById(list: ReadonlyArray<{ id?: unknown }> | undefined, id: string, what: string): number {
  const i = (list ?? []).findIndex((x) => x.id === id)
  if (i < 0) throw new Error(`cue card: no ${what} "${id}" in the rules`)
  return i
}

/** An environment where the rule applies (the engine reports not_applicable elsewhere). */
function envFor(rule: Rule, rules: Rules): string {
  const envs = rules.environments?.environments ?? []
  if (rule.applies_to.includes('*')) {
    if (!envs.length) throw new Error('cue card: no environments in the rules')
    return envs[0].id
  }
  return rule.applies_to[0]
}

/**
 * The engine's severity for a value just past one opening condition of the rule. The probe value is never
 * printed: it only asks the engine which class (Table 10.3-1) that side of the limit falls in.
 */
function severityAt(rule: Rule, rules: Rules, which: 'outside' | 'approach'): Severity {
  let probe: number
  if (which === 'outside') {
    const step = Math.max(1, Math.abs(rule.limit))
    probe = rule.op === 'le' ? rule.limit + step : rule.op === 'ge' ? rule.limit - step : rule.limit
  } else {
    probe = rule.approach_at!.value
  }
  const f = evaluateRule(rule, probe, envFor(rule, rules), 0)
  return f.severity as Severity
}

const atLeastCaution = (s: Severity) => SEVERITY_RANK[s] >= SEVERITY_RANK.caution
const tierNumber = (n: number): Atom => ({ text: String(n), src: { kind: 'computed', what: 'tier_number', value: n } })

function basisOf(rule: Rule, ri: number, rules: Rules): Atom[] {
  const base: Path = ['thresholds', 'rules', ri, 'source']
  const src = rule.source as Record<string, unknown>
  const out: Atom[] = []
  const add = (a: Atom) => {
    if (out.length) out.push(T('basisSep'))
    out.push(a)
  }
  const kind = src.kind
  if (kind === 'nasa_standard' || kind === 'nasa_brief' || kind === 'noaa') {
    if (typeof src.doc === 'string') add(R(rules, [...base, 'doc']))
    if (typeof src.requirement_id === 'string' && src.requirement_id) add(R(rules, [...base, 'requirement_id'], 'req'))
    else if (typeof src.table === 'string') {
      add(R(rules, [...base, 'table']))
      if (typeof src.row === 'string') add(R(rules, [...base, 'row']))
    }
    if (kind === 'noaa' && typeof src.level === 'string') add(R(rules, [...base, 'level']))
  } else if (kind === 'literature' && typeof src.citation === 'string') {
    add(R(rules, [...base, 'citation']))
  }
  if (!rule.applies_to.includes('*')) {
    const envs = rules.environments?.environments ?? []
    const labels = rule.applies_to.map((id) => indexById(envs, id, 'environment'))
    if (out.length) out.push(T('basisSep'))
    out.push(T('appliesIn'), T('space'))
    labels.forEach((ei, k) => {
      if (k) out.push(T('listSep'))
      out.push(R(rules, ['environments', 'environments', ei, 'label']))
    })
  }
  return out
}

function ruleTrigger(ruleId: string, rules: Rules): TriggerLine {
  const list = rules.thresholds?.rules ?? []
  const ri = indexById(list, ruleId, 'rule')
  const rule = list[ri]
  const rp: Path = ['thresholds', 'rules', ri]
  const severity = severityAt(rule, rules, 'outside')
  const parts: Atom[] = [R(rules, [...rp, 'label']), T(`op.${OUTSIDE_OP[rule.op]}`), R(rules, [...rp, 'limit'], 'num'), R(rules, [...rp, 'unit'])]
  let approach: TriggerLine['approach'] = null
  if (rule.approach_at && typeof rule.approach_at.value === 'number') {
    const sev = severityAt(rule, rules, 'approach')
    // The watch level opens the case only where the engine rates it caution or above (a PEL watch level does;
    // the renal TARGET watch level is advisory and opens nothing).
    if (atLeastCaution(sev)) {
      const ap: Path = [...rp, 'approach_at']
      approach = {
        severity: sev,
        sevWord: T(`severity.${sev}`),
        parts: [T('or'), T(`op.${CEILINGS.includes(rule.op) ? 'ge' : 'le'}`), R(rules, [...ap, 'value'], 'num'), R(rules, [...rp, 'unit']), T('watchLevel')],
        chip: typeof rule.approach_at.chip === 'string' ? R(rules, [...ap, 'chip']) : null,
      }
    }
  }
  return {
    kind: 'rule',
    ref: rule.id,
    severity,
    sevWord: T(`severity.${severity}`),
    parts,
    chip: R(rules, [...rp, 'chip']),
    approach,
    basis: basisOf(rule, ri, rules),
    note: null,
  }
}

function personalTrigger(indicatorId: string, rules: Rules): TriggerLine {
  const list = (rules.personal?.indicators ?? []) as Indicator[]
  const ii = indexById(list, indicatorId, 'indicator')
  // Tier B opens at caution, the class of a reliable change in the worse direction (meta severity_mapping).
  const rows = ((rules.meta as { severity_mapping?: { rows?: Array<{ id?: string; severity?: string }> } } | null)?.severity_mapping?.rows ?? [])
  const wi = indexById(rows, 'personal_worse', 'severity_mapping row')
  const sevPath: Path = ['meta', 'severity_mapping', 'rows', wi, 'severity']
  const severity = resolvePath(rules, sevPath) as Severity
  if (!(severity in TEMPLATE.severity)) throw new Error(`cue card: unknown severity "${String(severity)}"`)
  return {
    kind: 'personal',
    ref: list[ii].id,
    severity,
    sevWord: T(`severity.${severity}`),
    parts: [R(rules, ['personal', 'indicators', ii, 'label']), T('personalTrigger')],
    chip: null,
    approach: null,
    basis: [],
    note: null,
  }
}

/** Variables of OPS rules (the proton flux): one environment reading, never a per-crewmember box. */
function environmentVariables(rules: Rules): Set<string> {
  return new Set((rules.thresholds?.rules ?? []).filter((r) => r.category === 'OPS').map((r) => r.variable))
}

function stepInput(step: CaseStep, path: Path, rules: Rules, perCrew: boolean, metExample: string): StepInput | null {
  if (!step.input) return null
  const unit = R(rules, [...path, 'input', 'unit'])
  const variable = step.input.variable
  if (step.input.unit === 'MET') return { kind: 'met', variable, unit, cue: T('metCue', { example: metExample }), perCrew }
  if (step.input.unit === 'yes/no') return { kind: 'yesno', variable, unit, yes: T('yes'), no: T('no'), perCrew }
  return { kind: 'value', variable, unit, perCrew }
}

/**
 * The printable cue card of one case. Throws when the case is not in `rules`, or when anything on the card
 * hits the never-print list (a card with a missing step would be worse than no card).
 */
export function cueCard(caseDef: CaseDef, rules: Rules, snapshots: CueSnapshots, opts: CueCardOptions): CueCard {
  const cases = rules.cases?.cases ?? []
  const ci = indexById(cases, caseDef.id, 'case')
  if (cases[ci] !== caseDef && JSON.stringify(cases[ci]) !== JSON.stringify(caseDef)) throw new Error(`cue card: case "${caseDef.id}" differs from the rules`)
  const def = cases[ci]
  const cp: Path = ['cases', 'cases', ci]
  const triggers = (def.triggers ?? []).map((tr) => {
    if ((tr.kind === 'rule' || tr.kind === 'ops') && tr.rule_id) return ruleTrigger(tr.rule_id, rules)
    if (tr.kind === 'personal' && tr.indicator_id) return personalTrigger(tr.indicator_id, rules)
    throw new Error(`cue card: unknown trigger in case "${def.id}"`)
  })
  const crewWide = (def.triggers ?? []).some((x) => x.kind === 'ops')
  const envVars = environmentVariables(rules)

  const steps: StepItem[] = (def.procedure ?? []).map((step, i) => {
    const sp: Path = [...cp, 'procedure', i]
    const perCrew = crewWide && !!step.input && !envVars.has(step.input.variable)
    const tags: StepItem['tags'] = []
    if (step.required === true) tags.push({ kind: 'required', text: T('required') })
    if (step.red_flag === true) tags.push({ kind: 'red_flag', text: T('redFlag') })
    return {
      id: step.id,
      n: { text: String(i + 1), src: { kind: 'computed', what: 'step_number', value: i + 1 } },
      text: R(rules, [...sp, 'text']),
      tags,
      redFlags: (step.red_flags ?? []).map((_, j) => R(rules, [...sp, 'red_flags', j])),
      input: stepInput(step, sp, rules, perCrew, opts.metExample),
      perCrewHint: perCrew ? T('perCrew') : null,
    }
  })

  const crewInputs = steps.filter((s) => s.input?.perCrew)
  const crewTable: CrewTable | null = crewWide && crewInputs.length
    ? {
        head: T('crewmember'),
        columns: crewInputs.map((s) => ({ stepId: s.id, step: T('step'), n: s.n, input: s.input! })),
        rows: CREW.map((c) => ({ id: { text: c.id, src: { kind: 'crew', id: c.id, field: 'id' } }, role: { text: c.role, src: { kind: 'crew', id: c.id, field: 'role' } } })),
      }
    : null

  const meta = (rules.meta ?? {}) as { escalation?: { tiers?: Array<{ when?: unknown; backup?: unknown }>; caregivers?: unknown }; refusals?: Array<{ id?: string }> }
  const optional = (path: Path): Atom | null => (typeof resolvePath(rules, path) === 'string' ? R(rules, path) : null)
  const tiers: TierLine[] = (meta.escalation?.tiers ?? []).map((tier, i) => {
    const tp: Path = ['meta', 'escalation', 'tiers', i]
    // A tier may name a backup (one object or a list): its label, when, and the case it applies to.
    const list = Array.isArray(tier.backup) ? tier.backup.map((_, j) => [...tp, 'backup', j]) : tier.backup && typeof tier.backup === 'object' ? [[...tp, 'backup']] : []
    const backups = list
      .filter((bp) => typeof resolvePath(rules, [...bp, 'label']) === 'string')
      .map((bp) => ({ label: R(rules, [...bp, 'label']), when: optional([...bp, 'when']), applies: optional([...bp, 'applies']) }))
    return { tier: R(rules, [...tp, 'tier'], 'num'), label: R(rules, [...tp, 'label']), when: optional([...tp, 'when']), backups }
  })
  // A later CMO change may add escalation.caregivers: print each as another tier line (label, optional when).
  const caregivers = meta.escalation?.caregivers
  if (Array.isArray(caregivers)) {
    caregivers.forEach((cg, i) => {
      const gp: Path = ['meta', 'escalation', 'caregivers', i]
      if (typeof cg === 'string') {
        tiers.push({ tier: tierNumber(tiers.length + 1), label: R(rules, gp), when: null, backups: [] })
      } else if (cg && typeof cg === 'object' && typeof (cg as { label?: unknown }).label === 'string') {
        const g = cg as { tier?: unknown }
        tiers.push({
          tier: typeof g.tier === 'number' ? R(rules, [...gp, 'tier'], 'num') : tierNumber(tiers.length + 1),
          label: R(rules, [...gp, 'label']),
          when: optional([...gp, 'when']),
          backups: [],
        })
      }
    })
  }

  const metaRefusals = meta.refusals ?? []
  const refusals: Atom[] = [
    ...((def.refusals as string[] | undefined) ?? []).map((_, i) => R(rules, [...cp, 'refusals', i])),
    ...['no_diagnosis', 'no_dosing'].map((id) => R(rules, ['meta', 'refusals', indexById(metaRefusals, id, 'meta refusal'), 'text'])),
  ]

  const vol2 = snapshots.std_vol2_requirements ?? null
  let quote: CueCard['quote'] = null
  const reqs = vol2?.data?.requirements ?? []
  const qi = reqs.findIndex((r) => r.id === '[V2 10130]')
  if (vol2 && qi >= 0) {
    const text = S(vol2, 'std_vol2_requirements', ['data', 'requirements', qi, 'text'])
    if (text) {
      const source: Atom[] = []
      for (const a of [
        S(vol2, 'std_vol2_requirements', ['source', 'name']),
        S(vol2, 'std_vol2_requirements', ['data', 'requirements', qi, 'section'], 'section'),
        S(vol2, 'std_vol2_requirements', ['data', 'requirements', qi, 'pdf_page'], 'page'),
      ]) {
        if (!a) continue
        if (source.length) source.push(T('sep'))
        source.push(a)
      }
      quote = { text, source }
    }
  }

  const severity = triggers.reduce<Severity>((m, t) => {
    const s = t.approach && SEVERITY_RANK[t.approach.severity] > SEVERITY_RANK[t.severity] ? t.approach.severity : t.severity
    return SEVERITY_RANK[s] > SEVERITY_RANK[m] ? s : m
  }, 'nominal')

  const basisPlacement = opts.basisPlacement ?? 'inline'
  if (basisPlacement === 'footnote') {
    let n = 0
    for (const t of triggers) {
      if (!t.basis.length) continue
      n += 1
      t.note = { text: String(n), src: { kind: 'computed', what: 'note_number', value: n } }
    }
  }

  const card: CueCard = {
    caseId: def.id,
    crewWide,
    severity,
    header: T('header'),
    quote,
    title: R(rules, [...cp, 'title']),
    oneLine: R(rules, [...cp, 'one_line']),
    headings: {
      opensWhen: T('opensWhen'),
      doNow: T(def.procedure?.[0]?.red_flag === true ? 'doNowAfterRedFlag' : 'doNow'),
      steps: T('steps'),
      tripwire: T('tripwire'),
      escalate: T('escalate'),
      refusals: T('refusals'),
      basis: T('basis'),
    },
    triggers,
    basisPlacement,
    primary: R(rules, [...cp, 'countermeasure', 'primary', 'title']),
    steps,
    crewTable,
    tripwire: R(rules, [...cp, 'tripwire', 'text']),
    tiers,
    refusals,
    digest: opts.digest ? T('digest', { digest: shortDigest(opts.digest), date: opts.date }) : T('digest', { digest: TEMPLATE.digestNone, date: opts.date }),
    footer: T('footer'),
  }
  const bad = neverPrintViolations(card, neverPrintList(rules))
  if (bad.length) throw new Error(`cue card "${def.id}" refused ${NEVER_PRINT_MARK}: ${bad.join('; ')}`)
  return card
}

/** Binder order: the highest opening severity first (the Warning card), then the rules' own order. */
export function binderOrder(cards: readonly CueCard[]): CueCard[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => SEVERITY_RANK[b.c.severity] - SEVERITY_RANK[a.c.severity] || a.i - b.i)
    .map((x) => x.c)
}
