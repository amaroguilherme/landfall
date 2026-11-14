// The demo scenario (engine/SPEC.md section 7) and the environment list (SPEC section 3.1).
// Environments come from engine/rules/environments.json through the engine's RULES (bundled at
// build time) and every id is validated with getEnvironment(RULES, id): the engine is silent on
// typos, so an unknown id throws here instead of evaluating against the wrong environment.
import { RULES, getEnvironment } from './engine'
import type { Environment as EngineEnvironment, Source as EngineSource } from './engine'
import { ENV_IDS } from './vocab'
import type { ChipKind, CrewId, EnvId } from './vocab'

const DAY_S = 86_400

/** "Now" in the scenario: MET 412/14:20:00 (SPEC 7; sim_crew data.met.now_met_s, checked by a test). */
export const MET_NOW_S = 412 * DAY_S + 14 * 3600 + 20 * 60
/** Simulated data window: MET day 368 to day 412; baseline days 368 to 381 (SPEC 7, fixed). */
export const SIM_FIRST_DAY = 368
export const SIM_LAST_DAY = 412
export const BASELINE_FIRST_DAY = 368
export const BASELINE_LAST_DAY = 381

/** The hero (SPE during Mars solar conjunction) runs on the Mars surface. */
export const DEFAULT_ENV: EnvId = 'mars_surface'
/** CM-1 is the sleep / circadian case (a reliable change by MET day 407). */
export const DEFAULT_CREW: CrewId = 'CM-1'

export interface CommsRange {
  min: number
  max: number
  /** Representative value when the rules give one (e.g. lunar semimajor axis / c). */
  mean?: number
}

export interface EnvironmentComms {
  /** A static range in seconds ({min, mean?, max}) or a pointer to an ephemeris snapshot ({from_snapshot}). */
  one_way_light_time_s: { min?: number; mean?: number; max?: number; from_snapshot?: string }
  /** True when this environment can be cut off by solar conjunction. */
  conjunction: boolean
  chip?: ChipKind
  source?: EngineSource
  [key: string]: unknown
}

/** environments.json entry (SPEC 3.1), as the engine reads it. */
export interface Environment extends EngineEnvironment {
  id: EnvId
  label: string
  kind: 'station' | 'spacecraft' | 'surface' | string
  gravity: string
  eva_type: 'microgravity' | 'surface' | string
  gcr_regime: string
  dose_snapshot: string | null
  noaa_scale_available: boolean
  comms: EnvironmentComms
  /** Time-resolved light-time snapshot for an environment with a static range (lunar_surface). */
  comms_snapshot?: string
  notes?: string[]
}

/** Where the environment list came from (always the rules file now; kept for the mission bar). */
export const ENVIRONMENTS_SOURCE = 'rules' as const

/** The four SPEC environments, from the rules, in ENV_IDS order. Throws at load if one is missing. */
export const ENVIRONMENTS: readonly Environment[] = ENV_IDS.map((id) => getEnvironment(RULES, id) as Environment)

/** environments.json entry for an id; throws invalid_argument (EngineError) for an unknown id. */
export function environment(id: EnvId): Environment {
  return ENVIRONMENTS.find((e) => e.id === id) ?? (getEnvironment(RULES, id) as Environment)
}

/** MET day number (integer) for a MET in seconds. */
export function metDay(t: number): number {
  return Math.floor(t / DAY_S)
}
