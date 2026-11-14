// LANDFALL runtime engine: the TypeScript port of the Python reference engine (engine/*.py).
// The contract is engine/SPEC.md; conformance is proven by conformance.test.ts, which replays every
// vector in engine/tests/vectors/. Zero dependencies; pure functions on plain JSON values.

export { ERROR_CODES, EngineError, isEngineError } from './errors'
export type { ErrorCode } from './errors'
export { FMT_MAX_ABS, FMT_MAX_SCALED, fmtNum, formatMet, isNumber, metToIso, parseEpoch, requireNumber, sumLR } from './fmt'
export {
  CEILING_OPS,
  FLOOR_OPS,
  NOAA_S_THRESHOLDS_PFU,
  OP_SYMBOL,
  SEVERITIES,
  STATUSES,
  basisText,
  capSeverity,
  coerceValue,
  compare,
  evaluateRule,
  isCeiling,
  isOp,
  isSeverity,
  sLevel,
  severityRank,
} from './thresholds'
export { FALSE_ALARM_ASSUMES, RCI_METHOD, WORSE_VALUES, evaluatePersonal, expectedFalseAlarms, rci } from './rci'
export { DF_MAX as T_DF_MAX, DF_MIN as T_DF_MIN, tCdf, tCritical, tQuantile } from './tdist'
export { EVENTS, OPENING_SEVERITIES, OPEN_STATES, STATES, TERMINAL_STATES, caseReduce, newCase } from './cases'
export {
  BOOLEAN_UNITS,
  LOCAL_CS,
  LOCAL_DISPLAY,
  MET_UNITS,
  PRIVATE_VARIABLES,
  UCUM_CODES,
  VITAL_SIGNS,
  buildGroundPacket,
  consentAllows,
} from './packet'
export { commsEta } from './comms'
export { RULES, getCase, getEnvironment, getIndicator, getRule, thresholdRules, triggerLookup } from './rules'
export type { CasesFile, EnvironmentsFile, MetaFile, PersonalFile, Rules, ThresholdsFile } from './rules'
export type * from './types'

/** For src/app/engine.ts: the facade can re-export this instead of the shim's `true`. */
export const ENGINE_IS_SHIM = false as const
/** Alias of NOAA_S_THRESHOLDS_PFU under the shim's name, so the facade switch is a re-export. */
export { NOAA_S_THRESHOLDS_PFU as S_THRESHOLDS_PFU } from './thresholds'

// Shim-compatible type names (src/app/engine-shim.ts). The shapes follow SPEC section 5, which
// differs from the shim in places (Finding.why is a string, CaseState has `status`, CommsTable has
// `conjunction_windows` with `end`); see README.md.
export type { CaseStatus as CasePhase, Indicator as PersonalIndicator } from './types'
