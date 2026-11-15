# web/src/engine: the TypeScript runtime engine

This folder is the TypeScript port of the Python reference engine (`engine/*.py`). It runs in the judged
browser app with no backend and no network. It has zero dependencies (only the standard library: no
`Date`, no `Intl`, no `toFixed`). The contract is [`engine/SPEC.md`](../../../engine/SPEC.md). If the two
languages disagree, the Python engine plus SPEC win, and a vector proves it.

```ts
import { RULES, getCase, getRule, triggerLookup, newCase, caseReduce, evaluateRule } from '../engine'
const f = evaluateRule(getRule(RULES, 'ffd_vo2max_surface_eva'), 35.1, 'mars_surface', t)
let s = newCase(getCase(RULES, 'spe_shelter'), 'CM-1', triggerLookup(RULES), 'mars_surface')  // lookup required; env picks the tripwire rule
s = caseReduce(s, { type: 'OPEN', t, finding })
const c = tCritical(0.001, 13)  // 4.2208..., the Tier B critical value for a 14-day baseline
const m = minDetectableChange(0.171, 14).mdc  // 0.747: the smallest one-day change that band can flag
const p = evaluatePersonal(getIndicator(RULES, 'pvt_lapses'), base, 6, RULES.personal!.rci, t)  // tested as 2√(x + 3/8)
p.band  // {low, high} in lapses: draw this, not p.rci.mean ± p.rci.mdc (the Anscombe scale)
chanceRate(getIndicator(RULES, 'sleep_midpoint_shift'), RULES.personal!.rci).text
// "about 1 in 1000 days per crewmember would flag like this with no real change"
```

## Proof

- `conformance.test.ts` loads **every** file in `engine/tests/vectors/*.json` (`node:fs` + `import.meta.url`).
  Today that is 752 vectors in 17 files. Arguments written `{"$float": "NaN" | "Infinity" | "-Infinity"}` are
  decoded, at any depth, before the call (SPEC section 6). For each vector the test checks four things:
  - the TS result deep-equals `expect` (numbers within 1e-9, relative above magnitude 1, absolute below), or the
    error `code` equals `raises`;
  - no (decoded) input argument is mutated;
  - every number is **bit-for-bit** the Python double, which is stronger than the SPEC tolerance, for every
    function except `t_cdf` (see "Student's t" below);
  - a second run gives the same answer.

  The test also fails when a vector file has no TS mapping or a vector uses an argument name the mapping does not know.
- The same test also replays `engine/tests/vectors_random/random_<fn>.json`: 5,339 seeded random vectors (all 17
  functions: valid and invalid inputs, case_reduce event sequences, FHIR packets). They sit outside `vectors/`
  because `python -m engine.vectors --check` reports any extra file there. Their inputs are frozen, and their
  generator is committed: `uv run python -m engine.vectors --random` recomputes the expectations with the current
  engine (and `--check` covers them). The directory is optional.
- `tdist.test.ts` checks the t distribution against published tables, fetched on 2026-11-14: every row of the
  0.0005 upper-tail column of Purdue STAT 503's t table (two-tailed alpha 0.001: 4.221 at df 13, 3.291 at
  infinity) and every cell of the NIST/SEMATECH e-Handbook table 1.3.6.7.2. It also reproduces Crawford & Howell's
  (1998) worked example, and tests `fma` and `lgamma` (below).
- `scenario.test.ts` runs the TS engine on the shipped `web/public/data/sim_crew.json` the way `src/app/evaluate.ts`
  does (baseline MET days 368-381, n 14, df 13, critical 4.221) and requires it to agree exactly with the generator's
  own Tier B report (`data.self_check.tier_b`: baselines, minimum detectable changes, flagged episode days, chance
  flags, nothing else at caution). Every finding carries `rci.mdc` and a raw-scale `band` that agrees with the test,
  PVT-B lapses are tested on the Anscombe scale, caution only means a reliable change in the worse direction of an
  alerting indicator, mood never alerts, and `chanceRate` prints the measured rate where personal.json declares one.
- `engine.test.ts` runs the port on the **real** `engine/rules/*.json`:
  - every threshold rule and every indicator validates;
  - `PRIVATE_VARIABLES` equals the `private: true` indicators;
  - mood (non-alerting) shows a reliable change at severity `nominal`, and missing data stays `advisory`;
  - the critical values quoted in `rci.method` are the engine's, and an indicator's `reliability_r` changes nothing;
  - the CM-2 VO2max 35.1 verdict flips between `[V1 4001]` and `[V1 4002]` when the environment changes, and outside
    it is a caution labelled "EVA assignment not cleared";
  - all three cases open with `triggerLookup`, and in every environment each one watches a tripwire rule that
    applies there (`spe_shelter`: `ops_onboard_proton_s3` at Mars, `ops_noaa_s3` near Earth);
  - the SPE case opens as a warning, refuses an outcome until the shelter confirmations p2 and p3 are done, queues
    the packet at p6, rejects a TICK with a unit mismatch atomically, escalates at T+6 h on vehicle data
    (`crew_id: null`) to both tiers and yields a `scope-vehicle` packet;
  - the renal red-flag question r4 must be answered or declined, and a "yes" escalates at once;
  - every count indicator declares the Anscombe transform, and every indicator's `chanceRate` text is well formed;
  - a resolved sleep case opens again as instance 2 (case instances, S4).

  It also checks the tables the port copies (UCUM, LOINC vital signs, local displays, private/boolean/MET units, error codes and NOAA thresholds) against the Python source text, so a change on one side alone fails.
- Run: `cd web && npx vitest run src/engine` (or `npm test`), then `npx tsc -p tsconfig.app.json --noEmit`.

## Student's t (`tdist.ts`)

`tCdf`, `tQuantile` and `tCritical` follow `engine/tdist.py` step for step: the same continued fraction (modified
Lentz, `CF_EPS` 1e-15, `CF_TINY` 1e-300, at most 10,000 iterations), the same `t < 1e-17` and `t > 1e150` branches,
the same power-of-two bracket (limits 2^±1000, built from bit patterns) and exactly 32 bisection steps.

JavaScript has no `lgamma`, so `tdist.ts` ports the one Python's `math.lgamma` runs: CPython's `m_lgamma`
(`Modules/mathmodule.c`, a 13-term Lanczos approximation; coefficients written as their shortest round-trip
decimals). The reference build that generated the vectors (python-build-standalone 3.12, clang, macOS arm64)
compiles two multiply-adds in that C code into fused `fma` instructions (the Horner steps for x < 5 and the final
`r += (x - 0.5) * (...)`). `fma()` performs those two steps exactly, with BigInt arithmetic and one rounding (ties to
even). Measured during the port on 849 arguments, this lgamma returned Python's bits for 821; an unfused port
matched 493. The rest differ through `Math.log`, which, like `Math.exp`, is not guaranteed to match the C library in
the last bit. `tdist.test.ts` pins twelve of the values where only the fused steps tell the two apart.

So `t_cdf` agrees with Python within the 1e-9 tolerance only (on this machine 15 of its 311 vectors differ in the
last digits; the largest gap, at df 89,998, is 5e-11 absolute). `t_quantile`, `t_critical` and every Tier B value
built on the critical value are bit-identical in every vector and for every df the engine uses (n − 1 for an
n-day baseline): each of the 32 halvings is decided far above that noise. That is not a guarantee at very large
df. There `lgamma(df/2)` is about (df/2)·ln(df/2), so one ulp of it moves the CDF by up to ~1e-9 relative near
df 1e6, and a late halving can differ. A verifier's 2,500 random inputs per df range found every result identical
below df 1000, differences up to ~3e-10 relative below df 1e5, and up to ~3e-9 between 1e5 and 1e6 (SPEC section 6
allows 1e-8 there). The bit-for-bit check in `conformance.test.ts` therefore holds for the frozen vectors, and a
newly drawn input at df above ~1e3 could legitimately fail it while meeting the tolerance.

## Name mapping (Python -> TypeScript)

Arguments are positional, in the SPEC section 5 order. Inputs and outputs are the same plain JSON objects with
the same snake_case keys, so a value can pass between the two languages unchanged.

| Python (`engine/`) | TypeScript (`web/src/engine/`) |
|---|---|
| `thresholds.evaluate_rule(rule, value, env_id, t, ctx=None)` | `evaluateRule(rule, value, envId, t, ctx = null)` |
| `thresholds.s_level(flux_pfu)` | `sLevel(fluxPfu)` |
| `thresholds.coerce_value`, `basis_text`, `cap_severity`, `severity_rank`, `compare` | `coerceValue`, `basisText`, `capSeverity`, `severityRank`, `compare` |
| `thresholds.SEVERITIES`, `STATUSES`, `CEILING_OPS`, `FLOOR_OPS`, `OP_SYMBOL`, `NOAA_S_THRESHOLDS_PFU` | same names (`S_THRESHOLDS_PFU` is an alias for the shell facade) |
| `rci.rci(baseline, current, alpha=0.001, min_baseline_n=7)` | `rci(baseline, current, alpha = 0.001, minBaselineN = 7)` |
| `rci.evaluate_personal(indicator, baseline, current, cfg, t=None)` | `evaluatePersonal(indicator, baseline, current, cfg, t = null)` |
| `rci.min_detectable_change(sd, n, alpha=0.001)` | `minDetectableChange(sd, n, alpha = 0.001)` |
| `rci.expected_false_alarms(k_indicators, days, alpha=0.001, k_either=0)` | `expectedFalseAlarms(kIndicators, days, alpha = 0.001, kEither = 0)` |
| `rci.chance_rate(indicator, cfg)` | `chanceRate(indicator, cfg)` |
| `rci.METHOD`, `FALSE_ALARM_ASSUMES`, `TRANSFORMS`, `ANSCOMBE_OFFSET` | `RCI_METHOD`, `FALSE_ALARM_ASSUMES`, `TRANSFORMS`, `ANSCOMBE_OFFSET` |
| `tdist.t_cdf(t, df)`, `t_quantile(p, df)`, `t_critical(alpha, df)` | `tCdf(t, df)`, `tQuantile(p, df)`, `tCritical(alpha, df)` |
| `math.lgamma` (C library) | `lgamma` in `tdist.ts` (CPython's `m_lgamma`, with `fma`) |
| `cases.new_case(case_def, crew_id, lookup=None, env_id=None)` | `newCase(caseDef, crewId, lookup = null, envId = null)` |
| `cases.case_reduce(state, event)` | `caseReduce(state, event)` |
| `cases.STATES`, `OPEN_STATES`, `TERMINAL_STATES`, `EVENTS`, `OPENING_SEVERITIES`, `ESCALATION_TIERS`, `STEP_FLAGS`, `OP_WORDS` | same names |
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
   `of_last_n`/`at_least`, `min_detectable_change`'s `n`, an OPS rule's `s_level` field) therefore accept a JSON
   `3.0` here. Python rejects it,
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
- `expectedFalseAlarms` returns `{expected, per_day, every_n_days, text, expected_cautions, cautions_per_day,
  caution_every_n_days, caution_text, assumes, k_indicators, days, alpha}`: chance flags in either direction, and
  the half of them that are cautions (only a change in the worse direction raises one).
- Tier B findings carry `rci: {method: "crawford_howell_1998", rc, df, critical, alpha, s_diff, mean, sd, n,
  reliable, reason, mdc}`. `rc` is the t statistic of the single-case test and `mdc = critical * s_diff` the
  minimum detectable change (print it next to the band). There is no `critical_z`, `r` or `sem` any more, and an
  indicator's `reliability_r` is optional, non-computational context.
- `minDetectableChange(sd, n, alpha)` gives the same figure at any SD (e.g. a literature SD).
- `expectedFalseAlarms(k, days, alpha, kEither)`: pass the number of alerting indicators whose `worse` is
  `either` (glucose) as `kEither`; both of their tails raise cautions. The result has `k_either`.
- Severity (SPEC section 2, NASA-STD-3001 Vol 2 Table 10.3-1): the only `warning` is an OPS level of S3 or above
  (the shelter action); FFD / PEL / POL are `caution` outside or approaching; `evaluateRule`'s `ctx` is accepted but
  no longer changes anything (`{eva}` has no effect).
- `formatMet` prints `d/hh:mm:ss` with no leading zeros in the day field (F.6.1 f): `412/14:20:00`, a countdown
  `11/05:59:51`. Code that sliced fixed character positions of the old `0412/...` string must split on `/` instead.
- Case states have `steps_declined`, `escalation {t, reason, step_id, tiers}` and `packet_queued_at`; their
  `spec` has `required_step_ids`, `red_flag_step_ids`, `packet_step_ids` and `step_inputs`. New event
  `DECLINE {step_id, reason}`; new rejection `required_steps_pending` (OUTCOME before every required step is
  done or declined). A red-flag STEP answered yes (`input.value` true or 1) escalates at once. Log details print
  MET with `formatMet` ("reassess at MET 415/14:25:00") instead of raw seconds.
- `newCase` takes a 4th argument, `envId`: pass the current environment so the SPE case watches the Mars-orbit
  monitor rule at Mars (`spec.tripwire.condition.ref_id`). Without it the base condition (NOAA) is used; both
  rules watch the same variable and unit.

### Tier B statistics changes (lead decisions S1-S4, 2026-11-14)

- **Transforms (S2).** An indicator may declare `transform: "anscombe"` (PVT-B lapses, every `count`). The test runs
  on `2√(x + 3/8)`. Every top-level number of a `PersonalFinding` is on the raw scale of the indicator's unit:
  `value`, `limit`, `margin`, new `baseline_mean` (raw arithmetic mean of the baseline) and new
  `band: {low, high} | null` (the band of the test mapped back; reported whenever `rci.mdc` is, also without a
  current value). The `rci` block is the test's own scale, named by new `rci.transform` (`'anscombe'` or null), with
  new `rci.current` (the tested current value). **Draw and print `band`**, not `rci.mean ± rci.mdc`, which for lapses
  is on the Anscombe scale; for an untransformed indicator the two are identical. `why` prints both scales for lapses
  ("... tested on the Anscombe scale 2√(x + 3/8): 5.05 vs mean 2.155; t = ..."), and prints counts without the unit
  word.
- **Signed midpoint (S1).** `sleep_midpoint_shift` is a signed shift (h, `[-12, 12)`, positive = later) with
  `worse: "either"`: it cautions in both directions, so `kEither` for `expectedFalseAlarms` is now 2 (glucose and the
  midpoint) when counted from personal.json.
- **Chance rates (S3, S4).** `chanceRate(indicator, cfg)` returns `{indicator_id, worse, alerting, alpha, basis:
  'nominal' | 'measured', nominal_caution_per_day, nominal_flag_per_day, caution_multiplier, flag_multiplier,
  caution_per_day, flag_per_day, caution_every_n_days, flag_every_n_days, text, note, chip, source}`. `text` is the
  line to print after "Possibly chance: " ("about 1 in 1000 days per crewmember would flag like this with no real
  change"). PVT-B lapses and mood declare measured multipliers in personal.json (`indicator.chance_rate`); print
  `chanceRate(...).text` (and `note`, the measurement) next to an indicator's band instead of one global rate. A total
  over indicators is the sum of their `caution_per_day`; `expectedFalseAlarms` is the nominal arithmetic only.
- **Case instances (S4).** `CaseState` has new `instance` (1, 2, ...) and `previous_instances: PreviousInstance[]`
  (`{instance, status, opened_at, closed_at, finding, outcome, escalation, packet_queued_at, dismiss_reason}`, oldest
  first). `caseReduce` accepts OPEN from `resolved`, `escalated` or `dismissed`: it archives the closed instance,
  resets every per-instance field and opens the next instance (`detected`); OPEN while `detected`, `acting` or
  `watch` is still rejected (`invalid_transition`). The log runs on across instances. The timeline rule for WHEN to
  send that OPEN, and the "Possibly chance" rule, are in SPEC section 7.

`node-fs.d.ts` declares only the two `node:fs` functions that the tests use. It exists because the app
tsconfig loads only `vite/client` types, and adding `@types/node` to the browser program would retype globals
such as `setTimeout` for every module.
