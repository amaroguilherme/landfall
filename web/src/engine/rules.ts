// The canonical rules, imported directly from engine/rules/*.json (never copied), plus the lookups
// of engine/loader.py. The JSON is bundled at build time, so the judged app needs no backend.

import casesJson from '../../../engine/rules/cases.json'
import environmentsJson from '../../../engine/rules/environments.json'
import metaJson from '../../../engine/rules/meta.json'
import personalJson from '../../../engine/rules/personal.json'
import thresholdsJson from '../../../engine/rules/thresholds.json'
import { EngineError } from './errors'
import { isObj, pyEq, pyGet, pyOr, pyStr, setOwn } from './py'
import type { CaseDef, Environment, Indicator, RciConfig, Rule, TriggerLookup } from './types'

export interface EnvironmentsFile {
  schema: string
  environments: Environment[]
  [key: string]: unknown
}

export interface ThresholdsFile {
  schema: string
  rules: Rule[]
  [key: string]: unknown
}

export interface PersonalFile {
  schema: string
  rci: RciConfig
  indicators: Indicator[]
  [key: string]: unknown
}

export interface CasesFile {
  schema: string
  cases: CaseDef[]
  [key: string]: unknown
}

export interface MetaFile {
  schema: string
  [key: string]: unknown
}

/** loader.load_rules() shape: one entry per rules file (null when a file is absent). */
export interface Rules {
  environments: EnvironmentsFile | null
  thresholds: ThresholdsFile | null
  personal: PersonalFile | null
  cases: CasesFile | null
  meta: MetaFile | null
}

/** engine/rules/*.json as shipped in this build. */
export const RULES: Rules = {
  environments: environmentsJson as unknown as EnvironmentsFile,
  thresholds: thresholdsJson as unknown as ThresholdsFile,
  personal: personalJson as unknown as PersonalFile,
  cases: casesJson as unknown as CasesFile,
  meta: metaJson as unknown as MetaFile,
}

function items(doc: unknown, key: string): unknown[] {
  if (!isObj(doc)) return []
  const v = pyOr(pyGet(doc, key), [])
  return Array.isArray(v) ? v : []
}

function byId<T>(list: unknown[], id: string, what: string): T {
  for (const it of list) if (isObj(it) && pyEq(pyGet(it, 'id'), id)) return it as T
  throw new EngineError('invalid_argument', `no ${what} with id '${pyStr(id)}'`)
}

export function thresholdRules(rules: Rules): Rule[] {
  return items(rules.thresholds, 'rules') as Rule[]
}

export function getRule(rules: Rules, ruleId: string): Rule {
  return byId<Rule>(thresholdRules(rules), ruleId, 'rule')
}

export function getIndicator(rules: Rules, indicatorId: string): Indicator {
  return byId<Indicator>(items(rules.personal, 'indicators'), indicatorId, 'indicator')
}

export function getEnvironment(rules: Rules, envId: string): Environment {
  return byId<Environment>(items(rules.environments, 'environments'), envId, 'environment')
}

export function getCase(rules: Rules, caseId: string): CaseDef {
  return byId<CaseDef>(items(rules.cases, 'cases'), caseId, 'case')
}

/** rule or indicator id -> {variable, unit}, for newCase() tripwire resolution (loader.trigger_lookup). */
export function triggerLookup(rules: Rules): TriggerLookup {
  const out: TriggerLookup = {}
  for (const it of [...thresholdRules(rules), ...items(rules.personal, 'indicators')]) {
    if (isObj(it) && typeof it.id === 'string') {
      setOwn(out, it.id, { variable: pyGet(it, 'variable'), unit: pyGet(it, 'unit') })
    }
  }
  return out
}
