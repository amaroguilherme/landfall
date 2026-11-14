// ENGINE FACADE - the ONE place the UI reaches the engine.
// Features import from here ('../../app/engine'), never from '../engine' directly.
//
// This re-exports the real TypeScript engine (web/src/engine), the browser port of the Python
// reference engine, proven identical by the shared conformance vectors (engine/tests/vectors).
// The shell's stand-in (engine-shim.ts) is gone. Shapes follow engine/SPEC.md section 5:
//   - Finding.why is ONE string (not string[]).
//   - CaseState has `status` ('idle' | 'detected' | 'acting' | 'watch' | 'resolved' | 'escalated' | 'dismissed').
//   - expectedFalseAlarms(k, days, alpha = 0.001) keeps its positional call shape and returns
//     {expected, per_day, every_n_days, text, k_indicators, days, alpha}.
//   - buildGroundPacket takes a 6th argument, mission_epoch (sim_crew data.calendar.met_epoch_utc).
//   - commsEta throws missing_comms_table for Mars without a table (use app/comms useComms()).
// ENGINE_IS_SHIM is exported as `false` (the Method page reads it).
export * from '../engine'
