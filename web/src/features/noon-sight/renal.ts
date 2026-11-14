// The hydration context the Fluids step shows, read from engine/rules (never typed in TSX):
// - the renal case target rule `target_urine_output_24h` (a NASA HRP evidence report: literature,
//   not a standard), with its verbatim sentence, limit and approach value;
// - the `v2_6109_potable_water_hydration` constant ([V2 6109], Table 6.3-1: a water-PROVISION
//   requirement on the vehicle, not a drinking or urine target);
// - the Tier B minimum baseline length (personal.json rci.min_baseline_n) used by the streak card.
import { RULES, thresholdRules } from '../../app/engine'
import type { Rule } from '../../app/engine'

export const URINE_TARGET_RULE_ID = 'target_urine_output_24h'
export const POTABLE_WATER_CONSTANT_ID = 'v2_6109_potable_water_hydration'

/** A thresholds.json `constants[]` entry (SPEC 3: every number carries chip and source). */
export interface RuleConstant {
  id: string
  label: string
  value: number | { min: number; max: number }
  unit: string
  chip: string
  source: { kind: string; requirement_id?: string; table?: string; verbatim?: string; [key: string]: unknown }
}

export interface UrineTarget {
  rule: Rule
  /** The source sentence, verbatim (rule.source.verbatim). */
  verbatim: string | null
  /** Outside below this (rule.limit, rule.unit). */
  limit: number
  /** Approaching below this (rule.approach_at.value), or null when the rule has none. */
  approach: number | null
  unit: string
}

export function urineTarget(rules = RULES): UrineTarget | null {
  const rule = thresholdRules(rules).find((r) => r.id === URINE_TARGET_RULE_ID)
  if (!rule || typeof rule.limit !== 'number') return null
  const src = rule.source as unknown as { verbatim?: unknown }
  const approach = (rule.approach_at as { value?: unknown } | null | undefined)?.value
  return {
    rule,
    verbatim: typeof src.verbatim === 'string' ? src.verbatim : null,
    limit: rule.limit,
    approach: typeof approach === 'number' ? approach : null,
    unit: rule.unit,
  }
}

export function ruleConstant(id: string, rules = RULES): RuleConstant | null {
  const list = (rules.thresholds as { constants?: unknown } | null)?.constants
  if (!Array.isArray(list)) return null
  const hit = list.find((c): c is RuleConstant => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === id)
  return hit ?? null
}

/** personal.json rci.min_baseline_n and its chip (null when the rules are not in this build). */
export function minBaseline(rules = RULES): { n: number; chip: string | null } | null {
  const rci = rules.personal?.rci as { min_baseline_n?: unknown; chip?: unknown; provenance?: Record<string, { chip?: unknown }> } | undefined
  if (!rci || typeof rci.min_baseline_n !== 'number') return null
  const chip = rci.provenance?.min_baseline_n?.chip ?? rci.chip
  return { n: rci.min_baseline_n, chip: typeof chip === 'string' ? chip : null }
}
