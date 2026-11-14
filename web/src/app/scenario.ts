// The demo scenario (engine/SPEC.md section 7) and the environment list (SPEC section 3.1).
// Environments come from engine/rules/environments.json when that file exists at build time;
// otherwise from the SPEC 3.1 fallback below. import.meta.glob tolerates a missing file, so
// the shell builds before and after the rules land.
import type { ChipKind, CrewId, EnvId, Source } from './vocab'
import { ENV_IDS } from './vocab'

const DAY_S = 86_400

/** "Now" in the scenario: MET 0412/14:20:00, in integer seconds. */
export const MET_NOW_S = 412 * DAY_S + 14 * 3600 + 20 * 60
/** Simulated data window: MET day 368 to day 412; baseline days 368 to 381. */
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
  /** Either a static range in seconds, or a pointer to an ephemeris snapshot. */
  one_way_light_time_s?: CommsRange | { from_snapshot: string }
  /** True when this environment can be cut off by solar conjunction. */
  conjunction: boolean
  chip?: ChipKind | string
  source?: Source
}

export interface Environment {
  id: EnvId
  label: string
  kind: 'station' | 'spacecraft' | 'surface' | string
  gravity: string
  eva_type: 'microgravity' | 'surface' | string
  gcr_regime: string
  dose_snapshot?: string
  noaa_scale_available: boolean
  comms?: EnvironmentComms
  [extra: string]: unknown
}

interface EnvironmentsFile {
  schema: string
  environments: Environment[]
}

const EARTH_MOON_LIGHT_S = 384_400 / 299_792.458 // 1.282 s

/** SPEC 3.1 fallback, used only when engine/rules/environments.json is absent. */
export const FALLBACK_ENVIRONMENTS: Environment[] = [
  {
    id: 'iss',
    label: 'ISS · low Earth orbit',
    kind: 'station',
    gravity: 'microgravity',
    eva_type: 'microgravity',
    gcr_regime: 'leo',
    dose_snapshot: 'hapi_iss_tepc',
    noaa_scale_available: true,
    comms: {
      one_way_light_time_s: { min: 0.0, max: 1.0 },
      conjunction: false,
      chip: 'design choice',
      source: { kind: 'design_choice', rationale: 'TDRS relay; sub-second' },
    },
  },
  {
    id: 'cislunar',
    label: 'Cislunar spacecraft',
    kind: 'spacecraft',
    gravity: 'microgravity',
    eva_type: 'microgravity',
    gcr_regime: 'free_space',
    dose_snapshot: 'hapi_crater_dose',
    noaa_scale_available: true,
    comms: {
      one_way_light_time_s: { min: EARTH_MOON_LIGHT_S, max: EARTH_MOON_LIGHT_S },
      conjunction: false,
      chip: 'derived',
      source: {
        kind: 'derived',
        from: ['earth_moon_mean_distance_km', 'speed_of_light_km_s'],
        arithmetic: '384,400 km / 299,792.458 km/s = 1.28 s (shell fallback until environments.json lands)',
      },
    },
  },
  {
    id: 'lunar_surface',
    label: 'Lunar surface',
    kind: 'surface',
    gravity: 'lunar',
    eva_type: 'surface',
    gcr_regime: 'planetary_surface',
    noaa_scale_available: true,
    comms: {
      one_way_light_time_s: { min: EARTH_MOON_LIGHT_S, max: EARTH_MOON_LIGHT_S },
      conjunction: false,
      chip: 'derived',
      source: {
        kind: 'derived',
        from: ['earth_moon_mean_distance_km', 'speed_of_light_km_s'],
        arithmetic: '384,400 km / 299,792.458 km/s = 1.28 s (shell fallback until environments.json lands)',
      },
    },
  },
  {
    id: 'mars_surface',
    label: 'Mars surface',
    kind: 'surface',
    gravity: 'martian',
    eva_type: 'surface',
    gcr_regime: 'planetary_surface',
    dose_snapshot: 'hapi_msl_rad_dose',
    noaa_scale_available: false,
    comms: { one_way_light_time_s: { from_snapshot: 'horizons_mars_comms' }, conjunction: true },
  },
]

const rulesGlob = import.meta.glob<EnvironmentsFile>('../../../engine/rules/environments.json', {
  eager: true,
  import: 'default',
})
const rulesFile: EnvironmentsFile | undefined = Object.values(rulesGlob)[0]

function isEnvironment(e: unknown): e is Environment {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as Environment).id === 'string' &&
    (ENV_IDS as readonly string[]).includes((e as Environment).id)
  )
}

function mergeEnvironments(file: EnvironmentsFile | undefined): Environment[] {
  const fromRules = Array.isArray(file?.environments) ? file.environments.filter(isEnvironment) : []
  return ENV_IDS.map((id) => {
    const fallback = FALLBACK_ENVIRONMENTS.find((e) => e.id === id)!
    const rule = fromRules.find((e) => e.id === id)
    // Rules win field by field; the fallback only fills what the rules file leaves out.
    return rule ? { ...fallback, ...rule, label: rule.label ?? fallback.label } : fallback
  })
}

/** Where the environment list came from, so the UI can say so. */
export const ENVIRONMENTS_SOURCE: 'rules' | 'spec_fallback' = rulesFile ? 'rules' : 'spec_fallback'
export const ENVIRONMENTS: readonly Environment[] = mergeEnvironments(rulesFile)

export function environment(id: EnvId): Environment {
  return ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[0]
}

/** MET day number (integer) for a MET in seconds. */
export function metDay(t: number): number {
  return Math.floor(t / DAY_S)
}
