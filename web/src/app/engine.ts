// ENGINE FACADE - the ONE place the UI reaches the engine.
// Features import from here ('../../app/engine'), never from '../engine' or the shim directly,
// so switching from the shim to the real TypeScript engine port is a one-file change.
//
// Currently: web/src/engine/index.ts did not exist when the shell was built, so this re-exports
// the shim. To switch: replace the two export lines below with re-exports from '../engine'
// (adapting names if the port differs) and set ENGINE_IS_SHIM to false there.
export {
  ENGINE_IS_SHIM,
  S_THRESHOLDS_PFU,
  buildGroundPacket,
  caseReduce,
  commsEta,
  evaluatePersonal,
  evaluateRule,
  expectedFalseAlarms,
  formatMet,
  rci,
  sLevel,
} from './engine-shim'
export type {
  CaseEvent,
  CaseLogEntry,
  CasePhase,
  CaseState,
  CommsEta,
  CommsTable,
  Consent,
  FhirBundle,
  Finding,
  PersonalIndicator,
  RciConfig,
  RciResult,
  Rule,
} from './engine-shim'
