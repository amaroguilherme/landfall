# web/src/engine: the TypeScript runtime engine

This folder is the TypeScript port of the Python reference engine (`engine/*.py`). It runs in the judged
browser app with no backend and no network. It has zero dependencies (only the standard library: no
`Date`, no `Intl`, no `toFixed`). The contract is [`engine/SPEC.md`](../../../engine/SPEC.md). If the two
languages disagree, the Python engine plus SPEC win, and a vector proves it.

```ts
import { RULES, getCase, getRule, triggerLookup, newCase, caseReduce, evaluateRule } from '../engine'
const f = evaluateRule(getRule(RULES, 'ffd_vo2max_surface_eva'), 35.1, 'mars_surface', t)
let s = newCase(getCase(RULES, 'sleep_circadian'), 'CM-1', triggerLookup(RULES))  // the lookup is required
s = caseReduce(s, { type: 'OPEN', t, finding })
```

## Proof

- `conformance.test.ts` loads **every** file in `engine/tests/vectors/*.json` (`node:fs` + `import.meta.url`).
  Today that is 162 vectors in 12 files. For each vector the test checks four things:
  - the TS result deep-equals `expect`, or the error `code` equals `raises`;
  - no input argument is mutated;
  - every number is **bit-for-bit** the Python double, which is stronger than the SPEC tolerance of 1e-9 (relative above magnitude 1, absolute below);
  - a second run gives the same answer.

  The test also fails when a vector file has no TS mapping or a vector uses an argument name the mapping does not know.
- The same test also replays `engine/tests/vectors_random/random_<fn>.json`: 4,539 seeded random vectors (all 12
  functions: valid and invalid inputs, case_reduce event sequences, FHIR packets), produced by the Python reference
  engine during the adversarial verification of this port. They sit outside `vectors/` because
  `python -m engine.vectors --check` reports any extra file there. They are frozen, and their generator (seed
  20261114) is not in the repo: if the Python semantics change on purpose, delete them or regenerate them with a
  committed copy of that script. The directory is optional.
- `engine.test.ts` runs the port on the **real** `engine/rules/*.json`:
  - every threshold rule and every indicator validates;
  - `PRIVATE_VARIABLES` equals the `private: true` indicators;
  - mood stays at most advisory;
  - the CM-2 VO2max 35.1 verdict flips between `[V1 4001]` and `[V1 4002]` when the environment changes;
  - all three cases open with `triggerLookup`;
  - the SPE case escalates at T+6 h on vehicle data (`crew_id: null`) and yields a `scope-vehicle` packet.

  It also checks the tables the port copies (UCUM, LOINC vital signs, local displays, private/boolean/MET units, error codes and NOAA thresholds) against the Python source text, so a change on one side alone fails.
- Run: `cd web && npx vitest run src/engine` (or `npm test`), then `npx tsc -b --noEmit`.

## Name mapping (Python -> TypeScript)

Arguments are positional, in the SPEC section 5 order. Inputs and outputs are the same plain JSON objects with
the same snake_case keys, so a value can pass between the two languages unchanged.

| Python (`engine/`) | TypeScript (`web/src/engine/`) |
|---|---|
| `thresholds.evaluate_rule(rule, value, env_id, t, ctx=None)` | `evaluateRule(rule, value, envId, t, ctx = null)` |
| `thresholds.s_level(flux_pfu)` | `sLevel(fluxPfu)` |
| `thresholds.coerce_value`, `basis_text`, `cap_severity`, `severity_rank`, `compare` | `coerceValue`, `basisText`, `capSeverity`, `severityRank`, `compare` |
| `thresholds.SEVERITIES`, `STATUSES`, `CEILING_OPS`, `FLOOR_OPS`, `OP_SYMBOL`, `NOAA_S_THRESHOLDS_PFU` | same names (`S_THRESHOLDS_PFU` is an alias for the shell facade) |
| `rci.rci(baseline, current, r, critical_z=3.29, min_baseline_n=7)` | `rci(baseline, current, r, criticalZ = 3.29, minBaselineN = 7)` |
| `rci.evaluate_personal(indicator, baseline, current, cfg, t=None)` | `evaluatePersonal(indicator, baseline, current, cfg, t = null)` |
| `rci.expected_false_alarms(k_indicators, days, alpha=0.001)` | `expectedFalseAlarms(kIndicators, days, alpha = 0.001)` |
| `cases.new_case(case_def, crew_id, lookup=None)` | `newCase(caseDef, crewId, lookup = null)` |
| `cases.case_reduce(state, event)` | `caseReduce(state, event)` |
| `cases.STATES`, `OPEN_STATES`, `TERMINAL_STATES`, `EVENTS`, `OPENING_SEVERITIES` | same names |
| `packet.build_ground_packet(case_state, observations, consent, env_id, t, mission_epoch)` | `buildGroundPacket(caseState, observations, consent, envId, t, missionEpoch)` |
| `packet.consent_allows`, `PRIVATE_VARIABLES`, `VITAL_SIGNS`, `UCUM_CODES`, `LOCAL_DISPLAY`, `BOOLEAN_UNITS`, `MET_UNITS` | `consentAllows`, same constant names (the dicts become `ReadonlyMap`s) |
| `comms.comms_eta(env, t, comms_table=None)` | `commsEta(env, t, commsTable = null)` |
| `fmt.format_met`, `fmt_num(x, dp=3)`, `met_to_iso`, `parse_epoch`, `is_number`, `require_number`, `sum_lr` | `formatMet`, `fmtNum(x, dp = 3)`, `metToIso`, `parseEpoch` (returns POSIX seconds, not a `datetime`), `isNumber`, `requireNumber`, `sumLR` |
| `loader.load_rules()` | `RULES`: the five files are imported statically from `../../../engine/rules/*.json` and bundled. They are never copied. |
| `loader.get_rule`, `get_indicator`, `get_environment`, `get_case`, `threshold_rules`, `trigger_lookup` | `getRule`, `getIndicator`, `getEnvironment`, `getCase`, `thresholdRules`, `triggerLookup` |
| `loader.load_snapshot` | not ported: the app's `src/app/data.ts` fetches the snapshots |
| `errors.EngineError(code, message)`, `ERROR_CODES` | `EngineError` (extends `Error`; `.code`, `.reason`), `ERROR_CODES`, `isEngineError` |

`py.ts` holds the Python semantics the port needs:

- `dict.get` returns None for a missing key;
- truthiness, where `[]` and `{}` are falsy;
- `==` and `in`;
- `str()` and `repr()` inside `why` and `detail` strings;
- code-point string sorting;
- `str.strip()` whitespace;
- `deepcopy`.

## Known, deliberate differences (none is reachable with the real rules or any vector)

1. **JS cannot tell `3` from `3.0`.** Python's `isinstance(x, int)` checks (`fmt_num` dp, `min_baseline_n`,
   `of_last_n`/`at_least`, an OPS rule's `s_level` field) therefore accept a JSON `3.0` here. Python rejects it,
   or falls back to `s_level(limit)`. Likewise, `repr()` of an integral Python float prints `5.0` in Python and `5`
   here. That only matters in a rejected event's `detail`, such as `unknown event type 5.0`. All real ids and
   counts are JSON integers. Negative zero is the exception and does match: no Python int is `-0`, so `-0` prints
   as `-0.0`.
2. **Malformed input that crashes Python with a non-engine error** (`KeyError`, `TypeError`, `AttributeError`)
   raises an `EngineError` here (`invalid_case`, `invalid_argument` or `invalid_rule`). Examples are a case
   alternative without an `id`, a truthy non-list `triggers`, and a truthy non-object `lookup` when the tripwire
   condition names an id. As in Python, a falsy `lookup` (`false`, `0`, `""`, `[]`) acts as `{}` and is read only
   for a string condition id. `caseReduce` also
   validates the whole state up front: the spec lists, the tripwire condition, and the watch timestamps. SPEC
   says a malformed state raises `invalid_argument`, but Python checks only six top-level fields and fails later,
   or not at all.
3. **Integers beyond 2^53.** `formatMet` and the FHIR ids use `BigInt`, so they print every digit of the double
   they receive, as Python prints its ints. A JSON integer literal above 2^53 is already rounded by `JSON.parse`,
   though: `format_met(2**53 + 1)` ends `:33` in Python and `:32` here. `metToIso` rejects |MET| > 1e14 up front;
   that range is outside 0001-9999 from any epoch, so Python raises `invalid_argument` there too.
4. **Mission epoch digits.** Python's `\d` also matches non-ASCII Unicode digits. Here only `0-9` is accepted.
5. **Error messages** can differ in wording. Only the `code` is contract.
6. **Integer-like object keys.** `JSON.parse` puts keys such as `"1"` before the other keys, so `repr()` of an
   object like `{"b": 1, "1": 2}` inside a rejected event's `detail` lists the keys in a different order. The order
   is already lost when the JSON is parsed, and only junk input reaches that text.

## Wiring into the app (`src/app/engine.ts` is the only consumer)

`index.ts` exports `ENGINE_IS_SHIM = false`, `S_THRESHOLDS_PFU`, and the shim's type names (`CasePhase`,
`PersonalIndicator`, `Finding`, `CaseState`, ...). Those exports make the facade switch a re-export. The SPEC
shapes differ from the shim in six ways, and the compiler flags each one:

- `Finding.why` is one **string**, not `string[]`.
- `CaseState` has `status` (including `idle`), not `phase`.
- `CommsTable` is `{samples, conjunction_windows: [{start, end, reason}]}`, not `blackouts: [{start, stop}]`.
- `commsEta` **throws** `missing_comms_table` for Mars without a table. The shim returned nulls instead.
- `buildGroundPacket` takes a 6th argument, `mission_epoch`. The demo uses `sim_crew.json`
  `data.calendar.met_epoch_utc = "2027-01-31T02:40:00Z"`. The vectors use the fixture epoch 2035-01-01.
- `expectedFalseAlarms` returns `{expected, per_day, every_n_days, text, k_indicators, days, alpha}`.

`node-fs.d.ts` declares only the two `node:fs` functions that the tests use. It exists because the app
tsconfig loads only `vite/client` types, and adding `@types/node` to the browser program would retype globals
such as `setTimeout` for every module.
