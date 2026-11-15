// Which scenario episodes Tier B detects and which only Tier A catches, computed by the engine on the
// shipped scenario (no runtime entries): for every scripted signal of every sim_crew episode, the days
// the crewmember's own single-case test reports a reliable change for the worse, and the days any Tier A
// alert rule on the same variable reads outside. The solar particle event and the fitness test have no
// personal baseline, so only Tier A can catch them; they are listed as such.
import { RULES, thresholdRules } from '../../app/engine'
import type { Rule } from '../../app/engine'
import { evaluateOps, evaluatePersonalAt, evaluateRuleAt, personalIndicators } from '../../app/evaluate'
import { observationDay, observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex } from '../../app/scenarioData'
import type { CrewId, EnvId } from '../../app/vocab'

interface RawEpisode {
  id: string
  case_id?: string | null
  crew_id: string
  summary?: string
  scripted_values?: Record<string, Record<string, number>>
}

export interface SignalDetection {
  variable: string
  label: string
  /** Days the scenario scripts a changed value for this signal. */
  scriptedDays: number[]
  /** Tier B: null when no personal indicator watches this variable. */
  tierB: { indicatorId: string; alerting: boolean; private: boolean; days: number[] } | null
  /** Tier A alert rules on the same variable, with the days they read outside. */
  tierA: { ruleId: string; label: string; days: number[] }[]
}

export interface EpisodeDetection {
  id: string
  crewId: string
  caseId: string | null
  signals: SignalDetection[]
}

export interface OnlyTierA {
  id: 'spe' | 'ffd'
  crewId: string | null
  label: string
  /** Tier A rule that reads outside now, with its severity, or null. */
  rule: { ruleId: string; label: string; status: string; severity: string } | null
}

function alertRulesFor(variable: string): Rule[] {
  return thresholdRules(RULES).filter((r) => r.variable === variable && r.role !== 'context' && r.category !== 'OPS')
}

/** The scenario episodes, signal by signal. */
export function detectEpisodes(index: ScenarioIndex, sim: unknown, envId: EnvId): EpisodeDetection[] {
  const raw = ((sim as { episodes?: RawEpisode[] } | null)?.episodes ?? []).filter((e) => e && typeof e.id === 'string')
  const indicators = personalIndicators()
  const lastBaselineDay = index.baselineDays[1]
  return raw.map((ep) => {
    const crewId = ep.crew_id as CrewId
    const signals: SignalDetection[] = Object.entries(ep.scripted_values ?? {}).map(([variable, byDay]) => {
      const ind = indicators.find((i) => i.variable === variable) ?? null
      const obs = observationsFor(index, [], crewId, variable).filter(
        (o) => o.crew_id === crewId && o.t <= index.nowMet && observationDay(o.t) > lastBaselineDay,
      )
      const tierB = ind
        ? {
            indicatorId: ind.id,
            alerting: ind.alerting,
            private: !!ind.private,
            days: obs
              .filter((o) => {
                const f = evaluatePersonalAt(ind, index, [], crewId, o.t).finding
                return f.status === 'reliable_change' && f.severity !== 'nominal' && f.severity !== 'advisory'
              })
              .map((o) => observationDay(o.t)),
          }
        : null
      const tierA = alertRulesFor(variable).map((rule) => ({
        ruleId: rule.id,
        label: rule.label ?? rule.id,
        days: obs.filter((o) => evaluateRuleAt(rule, index, [], crewId, envId, o.t).finding.status === 'outside').map((o) => observationDay(o.t)),
      }))
      return {
        variable,
        label: ind?.label ?? index.variables[variable]?.label ?? variable,
        scriptedDays: Object.keys(byDay)
          .map(Number)
          .filter(Number.isFinite)
          .sort((a, b) => a - b),
        tierB,
        tierA,
      }
    })
    return { id: ep.id, crewId: ep.crew_id, caseId: ep.case_id ?? null, signals }
  })
}

/** The scenario events no personal baseline can see: the solar particle event and the fitness test. */
export function onlyTierA(index: ScenarioIndex, sim: unknown, envId: EnvId): OnlyTierA[] {
  const out: OnlyTierA[] = []
  const ops = evaluateOps(index, [], envId, index.nowMet)
  out.push({
    id: 'spe',
    crewId: null,
    label: 'Solar particle event (≥10 MeV proton flux, a vehicle reading)',
    rule: ops.active
      ? { ruleId: ops.active.rule.id, label: ops.active.rule.label ?? ops.active.rule.id, status: ops.active.finding.status, severity: ops.active.finding.severity }
      : null,
  })
  const ffd = (sim as { ffd_demo?: { crew_id: string; variable: string } } | null)?.ffd_demo
  if (ffd) {
    const rules = thresholdRules(RULES).filter((r) => r.variable === ffd.variable && r.category === 'FFD' && r.role !== 'context')
    const evs = rules.map((r) => evaluateRuleAt(r, index, [], ffd.crew_id as CrewId, envId, index.nowMet))
    const applicable = evs.find((e) => e.finding.status !== 'not_applicable') ?? null
    out.push({
      id: 'ffd',
      crewId: ffd.crew_id,
      label: `${index.variables[ffd.variable]?.label ?? ffd.variable} (a periodic fitness test, not a daily indicator)`,
      rule: applicable
        ? { ruleId: applicable.rule.id, label: applicable.rule.label ?? applicable.rule.id, status: applicable.finding.status, severity: applicable.finding.severity }
        : null,
    })
  }
  return out
}

/** [398, 399, 400, 401, 405] -> "398–401, 405". */
export function dayRanges(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return parts.join(', ')
}

/** One calibration entry of a simulated variable (sim_crew data.variables[v].calibration). */
export interface Calibration {
  item: string
  value: string
  chip: string
}

/**
 * The simulator's day-to-day noise entry for a variable, as sim_crew records it: the calibration item that names a
 * day-to-day, night-to-night or within-person SD or CV, else a value that gives one (or Poisson counts, for a count).
 * Comparison entries (a free-living value shown for context) are not the noise the simulator drew.
 */
export function noiseEntry(sim: { variables?: Record<string, { calibration?: Calibration[] }> } | null | undefined, variable: string): Calibration | null {
  const cal = (sim?.variables?.[variable]?.calibration ?? []).filter((c) => !/comparison/i.test(c.item))
  return (
    cal.find((c) => /(day-to-day|night-to-night|within-person)\b.*\b(SD|CV)\b/i.test(c.item)) ??
    cal.find((c) => /\b(SD|CV)\b/.test(c.item)) ??
    cal.find((c) => /\b(SD|CV)\b|Poisson/.test(c.value)) ??
    null
  )
}
