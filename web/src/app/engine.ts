// ENGINE FACADE - the ONE place the UI reaches the engine.
// Features import from here ('../../app/engine'), never from '../engine' directly.
//
// This re-exports the real TypeScript engine (web/src/engine), the browser port of the Python
// reference engine, proven identical by the shared conformance vectors (engine/tests/vectors).
// The shell's stand-in (engine-shim.ts) is gone. Shapes follow engine/SPEC.md section 5:
//   - Finding.why is ONE string (not string[]).
//   - CaseState has `status` ('idle' | 'detected' | 'acting' | 'watch' | 'resolved' | 'escalated' | 'dismissed').
//   - expectedFalseAlarms(k, days, alpha = 0.001, kEither = 0) keeps its positional call shape and returns
//     {expected, per_day, every_n_days, text, expected_cautions, cautions_per_day, caution_every_n_days,
//     caution_text, assumes, k_indicators, days, alpha, k_either}.
//   - formatMet prints d/hh:mm:ss with no leading zeros in the day field (F.6.1 f): split on "/", never slice.
//   - Severity follows Vol 2 Table 10.3-1: the only warning is OPS S3+; FFD / PEL / POL / TARGET / Tier B caution at most.
//   - buildGroundPacket takes a 6th argument, mission_epoch (sim_crew data.calendar.met_epoch_utc).
//   - commsEta throws missing_comms_table for Mars without a table (use app/comms useComms()).
// ENGINE_IS_SHIM is exported as `false` (the Method page reads it).
export * from '../engine'
