# LANDFALL engine specification

This file is the contract between the rules data (`engine/rules/*.json`), the Python reference
engine (`engine/*.py`), the TypeScript runtime that runs in the browser (`web/src/engine/*.ts`), and
the simulated scenario (`ingest/sim_crew.py`). If code and this file disagree, this file wins until
it is changed on purpose.

## 1. Principles

1. **NASA publishes no numeric in-flight alert thresholds for crew health.** Every alert requirement
   in NASA-STD-3001 delegates the number to the program (`[V2 6022]`, `[V2 6164]`, `[V2 11036]`,
   `[V1 4006]`, `[V1 4008]`). LANDFALL never presents its own number as NASA's.
2. NASA *does* publish three structurally different kinds of limit. They are never merged into one
   "threshold exceeded" state:

   | Category | Shape | Glossary (NASA-STD-3001 Vol 1 Rev C) |
   |---|---|---|
   | `FFD` Fitness for Duty | a **floor** on the crewmember's capability | "Minimum measurable capability … that allows successful performance of all required duties." |
   | `PEL` (Space) Permissible Exposure Limit | a **ceiling** on cumulative exposure over a time window | "Quantifiable limit of exposure to a spaceflight factor over a given length of time." |
   | `POL` Permissible Outcome Limit | a **maximum change** against the crewmember's own baseline | "Acceptable maximum decrement or change in a physiological or behavioral parameter … as the result of exposure to the space environment." |

   The other categories: `OPS` covers an operational scale published by another agency (the NOAA
   S-scale). `PERSONAL` covers Tier B reliable change against one's own baseline.
3. **Tier A** rules carry a number NASA (or NOAA) actually publishes, with its requirement ID.
   **Tier B** uses the Reliable Change Index (Jacobson & Truax 1991) against the crewmember's own
   baseline, with critical value 3.29 (two-tailed p < .001). The expected false-alarm rate is
   printed next to it.
4. Every constant carries a **chip** naming its basis:
   `NASA-published` · `NASA brief` (OCHMO technical brief, no requirement ID) · `NOAA-published` ·
   `literature` · `derived` (arithmetic on published values, shown) · `design choice` (no published
   basis: ours, and labeled as such).
5. **Refusals are features.** There is no diagnosis, no medication dosing, no psychiatric alert, no
   personal cancer-risk (REID) model, and no claim that CO₂ causes cognitive deficit (the defensible
   claim is headache risk). LANDFALL **never raises an Emergency-class alarm**: that belongs to the
   vehicle caution & warning system.
6. Pure functions only. Same inputs → same outputs in Python and TypeScript, proven by the shared
   vectors in `engine/tests/vectors/`.

## 2. Vocabulary

- **status** of a finding: `within` · `approaching` · `outside` · `reliable_change` ·
  `insufficient_data` · `stale` · `not_applicable`
- **severity** (NASA-STD-3001 Vol 2 Appendix F colour semantics; red is reserved for
  Emergency/Warning): `nominal` · `advisory` · `caution` · `warning`. `emergency` exists in the
  type but the engine never emits it. Default mapping (a `design choice`, stored in
  `rules/meta.json`):
  - Tier A alert rule `outside` → `warning`; `approaching` → `caution`; `within` → `nominal`
  - Tier B `reliable_change` in the worse direction → `caution` (personal change is not a limit, so
    never `warning`)
  - `OPS` NOAA S1–S2 → `advisory`; S3 or above → `warning` when an EVA is planned or in progress,
    else `caution`
  - `role: "context"` rules → `advisory` at most; `insufficient_data` / `stale` → `advisory`
- **MET**: mission elapsed time in integer seconds. It is displayed as `dddd/hh:mm:ss`
  (e.g. `0412/14:20:07`).
- **crew ids**: `CM-1` Commander, `CM-2` Flight Engineer, `CM-3` Mission Specialist, `CM-4` Crew
  Medical Officer (a non-physician with ~40 h of medical training). They are fictional. There are no
  names and no real PII.

## 3. Rules files (`engine/rules/`)

All files are JSON with a `"schema"` key. Every object with a number in it carries `chip` and
`source`. `source` is one of:

```json
{"kind": "nasa_standard", "doc": "NASA-STD-3001 Vol. 1 Rev. C", "requirement_id": "V1 4030",
 "section": "4.8.2", "url": "https://…", "snapshot": "std_vol1_requirements"}
{"kind": "nasa_brief", "doc": "OCHMO-MTB-013 Rev D", "url": "https://…"}
{"kind": "noaa", "doc": "NOAA Space Weather Scales", "url": "https://…", "snapshot": "swpc_s_scale"}
{"kind": "literature", "citation": "Basner M, Mollicone D, Dinges DF. Acta Astronaut 2011;69(11-12):949-959. PMID 22025811", "url": "https://…"}
{"kind": "derived", "from": ["<rule or constant ids>"], "arithmetic": "human-readable formula"}
{"kind": "design_choice", "rationale": "why we picked this"}
```

`snapshot` names a frozen file in `web/public/data/` whose verbatim text backs the value. A test
asserts that every Tier A limit appears verbatim in that snapshot's requirement text.

### 3.1 `environments.json`

```json
{"schema": "landfall.environments/1", "environments": [
  {"id": "iss", "label": "ISS · low Earth orbit", "kind": "station",
   "gravity": "microgravity", "eva_type": "microgravity", "gcr_regime": "leo",
   "dose_snapshot": "hapi_iss_tepc", "noaa_scale_available": true,
   "comms": {"one_way_light_time_s": {"min": 0.0, "max": 1.0}, "conjunction": false,
             "chip": "design choice", "source": {"kind": "design_choice", "rationale": "TDRS relay; sub-second"}}},
  {"id": "cislunar", "kind": "spacecraft", "gravity": "microgravity", "eva_type": "microgravity",
   "gcr_regime": "free_space", "dose_snapshot": "hapi_crater_dose", "noaa_scale_available": true, "...": "..."},
  {"id": "lunar_surface", "kind": "surface", "gravity": "lunar", "eva_type": "surface",
   "gcr_regime": "planetary_surface", "...": "..."},
  {"id": "mars_surface", "kind": "surface", "gravity": "martian", "eva_type": "surface",
   "gcr_regime": "planetary_surface", "dose_snapshot": "hapi_msl_rad_dose",
   "noaa_scale_available": false,
   "comms": {"one_way_light_time_s": {"from_snapshot": "horizons_mars_comms"}, "conjunction": true}}
]}
```

`noaa_scale_available: false` at Mars is intentional. GOES measures at Earth, and during conjunction
no NOAA alert reaches the crew anyway. At Mars the solar particle event case runs on the onboard
radiation monitor (`[V2 6164]`).

### 3.2 `thresholds.json` (Tier A and context)

```json
{"schema": "landfall.thresholds/1", "rules": [
  {"id": "pel_career_effective_dose", "label": "Career effective dose",
   "variable": "career_effective_dose", "unit": "mSv",
   "op": "lt", "limit": 600,
   "category": "PEL", "tier": "A", "role": "alert",
   "applies_to": ["*"],
   "window": {"kind": "career"},
   "approach_at": {"value": 480, "chip": "design choice", "source": {"kind": "design_choice", "rationale": "80% of limit"}},
   "chip": "NASA-published",
   "source": {"kind": "nasa_standard", "doc": "NASA-STD-3001 Vol. 1 Rev. C", "requirement_id": "V1 4030", "section": "4.8.2", "url": "…", "snapshot": "std_vol1_requirements"},
   "action_id": "radiation_dose_review", "case_id": "spe_shelter",
   "notes": ["Universal for all ages and sexes."]}
]}
```

- `op` describes the **compliant** condition: `lt`, `le`, `gt` or `ge`. A rule is `outside` when the
  compliant condition is false.
- `approach_at` is optional. For ceilings (`lt`/`le`) the rule is `approaching` when
  `value >= approach_at.value`. For floors (`gt`/`ge`) it is `approaching` when
  `value <= approach_at.value`.
- `applies_to` lists environment ids or `["*"]`. When the current environment is not listed, the
  status is `not_applicable`.
- `role: "context"` rules are shown and never fire. Vehicle *design* requirements belong here, e.g.
  `[V1 4031]` reference SPE < 250 mSv and `[V1 4033]` GCR design limits.
- `window.kind` takes one of these shapes:
  - `instant`
  - `rolling_mean` with `"duration": "PT1H"`
  - `cumulative` with `"duration": "P30D"`
  - `career`
  - `ratio_to_baseline`, used by POL rules, where the value is current/preflight.
- The required content, at minimum (verify every number against the standards snapshots):
  - FFD: `[V1 4001]` VO₂max ≥ 32.9 ml/min/kg, applies to `eva_type = microgravity`.
  - FFD: `[V1 4002]` VO₂max ≥ 36.5 ml/min/kg, applies to `eva_type = surface`.
  - POL: `[V1 4027]` hip and spine BMD ≥ 95% of preflight, femoral neck ≥ 90%.
  - PEL: `[V1 4030]` career 600 mSv.
  - PEL: Table 4.8-1 organ limits for 30-day, 1-year and career windows, in **mGy-Eq / mGy, not mSv**.
  - PEL: `[V2 6004]` cabin ppCO₂ 1-hour mean ≤ 3 mmHg.
  - PEL: `[V2 11040]` suit PiCO₂ ≤ 20 mmHg, 1 h contingency.
  - Context: `[V1 4031]`, `[V1 4032]`, `[V1 4033]`.
  - OPS: the NOAA S-scale levels as rules on `proton_flux_10mev` in pfu, with `"category": "OPS"`,
    chip `NOAA-published` and verbatim biological text.

### 3.3 `personal.json` (Tier B)

```json
{"schema": "landfall.personal/1",
 "rci": {"critical_z": 3.29, "alpha_two_tailed": 0.001, "min_baseline_n": 7,
         "baseline_window_days": 14,
         "chip": "literature", "source": {"kind": "literature", "citation": "Jacobson NS, Truax P. J Consult Clin Psychol 1991;59(1):12-19."}},
 "indicators": [
  {"id": "pvt_lapses", "label": "PVT-B lapses", "variable": "pvt_lapses", "unit": "count",
   "worse": "increase", "alerting": true, "private": false,
   "reliability_r": {"value": 0.0, "chip": "literature|design choice", "source": {}},
   "definition": {"text": "lapse = reaction time ≥ 355 ms on the 3-min PVT-B", "chip": "literature",
                  "source": {"kind": "literature", "citation": "Basner M, Mollicone D, Dinges DF. … 2011 …"}},
   "case_id": "sleep_circadian"},
  {"id": "mood", "variable": "mood", "unit": "score_1_5", "worse": "decrease",
   "alerting": false, "private": true, "case_id": null}
 ]}
```

The required indicators are:

- `pvt_lapses`, `pvt_median_rt` (ms)
- `sleep_duration` (h, from actigraphy)
- `sleep_midpoint_shift` (h)
- `light_exposure_daytime` (lux)
- `resting_hr` (bpm)
- `hrv_sdnn` (ms)
- `skin_temp` (°C)
- `urine_volume_24h` (mL)
- `fluid_intake_24h` (mL)
- `mood` (1–5, **private, non-alerting**)

`reliability_r` is the test–retest reliability. Cite a published value where one exists. Otherwise
use chip `design choice` with a rationale.

### 3.4 `cases.json`

There are three deep cases: `renal_stone`, `sleep_circadian` and `spe_shelter`. Each one has the
following fields:

- `id`, `title`, `one_line`
- `hrp_risk`: the official NASA HRP risk title and url. `renal_stone` sits under **"Risk of
  Spaceflight-Induced Bone Changes"**, because bone resorption raises urinary calcium. Renal stone
  is no longer a separately listed risk on the official HRP risks page.
- `hazards`: ids out of `space_radiation`, `isolation_confinement`, `distance_from_earth`,
  `gravity_fields`, `hostile_closed_environment`
- `body_regions`: ids out of `brain`, `eyes`, `skin`, `heart`, `lungs`, `blood_forming_organs`,
  `kidneys`, `skeleton`, `muscles`, `immune`
- `triggers[]`: `{"kind": "rule", "rule_id": …}`, `{"kind": "personal", "indicator_id": …}` or
  `{"kind": "ops", "rule_id": …}`. The case opens when any trigger reports a finding with
  severity ≥ `caution`.
- `interpretation`: plain English with citations, written for a non-physician.
- `countermeasure`: `{"primary": {id, title, rationale, chip, source}, "alternatives": […]}`. There
  is exactly one primary, and the alternatives render collapsed.
- `procedure[]`: guided steps `{id, text, input?: {variable, unit, source: "manual"|"band"|"vehicle"|"app"}}`
- `tripwire`: `{"reassess_after_s": 259200, "condition": {"indicator_id"|"rule_id": …, "op": …, "value": …, "of_last_n": 3, "at_least": 2}, "text": "Reassess at T+72 h; if …, reclassify and queue for flight-surgeon review.", "chip": …, "source": …}`
- `escalation`: `{"ground_packet": true, "observations": [variables to include]}`
- `not_measurable_here[]`: `{what, via, requirement_id?}`. This is the hand-off boundary, e.g.
  "urinary supersaturation, via ground lab" or "kidney ultrasound, via vehicle medical kit".
- `refusals[]`

## 4. Observations

```json
{"crew_id": "CM-3", "variable": "urine_volume_24h", "value": 1480, "unit": "mL",
 "t": 35553600, "source": "manual", "provenance": "simulated"}
```

`source` is one of `band`, `manual`, `vehicle`, `lab`, `app` or `replay`. If an observation's unit
differs from the rule's unit, the engine raises an error. Units are never converted silently.

## 5. Engine API (identical in Python and TypeScript)

Reference implementation: `engine/*.py` (stdlib only). Every function takes and returns plain JSON
values. Arguments are named exactly as below (the vectors use these names). A contract violation
throws an error carrying a stable `code`: `invalid_argument`, `invalid_rule`, `invalid_case`,
`unit_mismatch`, `variable_mismatch`, `unknown_unit` or `missing_comms_table`. Booleans are never
numbers.

| Function | Returns |
|---|---|
| `evaluate_rule(rule, value, env_id, t, ctx?)` | `Finding {rule_id, tier, category, status, severity, value, unit, limit, margin, chip, source, why}` plus `role, op, approach_at, env_id, t, case_id, action_id`. `value` is a number, `null` (→ `insufficient_data`) or an observation `{value, unit, t?, variable?}`. An observation whose `unit` differs from `rule.unit`, or has no unit, raises `unit_mismatch`; a different `variable` raises `variable_mismatch`. Both raise even where the rule is `not_applicable`. `ctx = {eva: true}` means an EVA is planned or in progress (OPS severity). `margin` is `limit − value` for ceilings and `value − limit` for floors, so a positive margin is on the compliant side; it is `null` when nothing was compared (`not_applicable`, `insufficient_data`, `stale`). There are two optional rule fields. `stale_after: {seconds, chip, source}` makes an observation `stale` when `t − obs.t > seconds`. `max_severity` caps the severity. |
| `rci(baseline: number[], current, r, critical_z=3.29, min_baseline_n=7)` | `{status, reason, rc, s_diff, sem, mean, sd, n, reliable, direction, critical_z, r}`. Here `sd` is the sample SD (n−1), `sem = sd·√(1−r)` and `s_diff = √2·sem`. `null` baseline entries are skipped. `status` is `"ok"` or `"insufficient_data"`, with `reason` checked in this order: `baseline_too_short` (n < `min_baseline_n`), then `no_current`, then `zero_sd` (no division by zero). `zero_sd` is an exact test: when every baseline value equals the first one, `sd` is reported as `0` without computing it, because float noise would otherwise give `[7.3]*7` an SD of ~1e-15 and any change an rc of ~1e14. `reliable` means \|rc\| ≥ `critical_z`. `direction` is `increase`, `decrease` or `none`, from the sign of `current − mean`. `r` must be in [0, 1). |
| `evaluate_personal(indicator, baseline, current, cfg, t?)` | `Finding` with `tier: "B"`, `category: "PERSONAL"`, plus `direction, worse, private, rci{…, r, r_chip, r_source}`. `cfg` is the `rci` block of `personal.json`. `worse` is `increase`, `decrease` or `either`. `limit` is the personal band edge on the worse side, `mean ± critical_z·s_diff`; for `either` it is the edge on the side the value moved. A reliable change in the worse direction → `caution`. A reliable change in the better direction → `status: reliable_change` with `severity: nominal`. Non-alerting indicators never exceed `advisory`, because the `caution` is capped. |
| `expected_false_alarms(k_indicators, days, alpha=0.001)` | `{expected: (k·days)·alpha, per_day: k·alpha, every_n_days: 1/per_day or null, text, k_indicators, days, alpha}`. `text` is `"one false alarm every N days"`, with N from `fmt_num(·, 1)`. |
| `s_level(flux_pfu)` | `0..5` from NOAA thresholds (≥10, ≥100, ≥1e3, ≥1e4, ≥1e5 pfu at ≥10 MeV). An OPS rule's level is its integer `s_level` field, else `s_level(limit)`. |
| `new_case(case_def, crew_id, lookup?)` | The pre-OPEN state, `status: "idle"`. `lookup` maps a rule or indicator id to `{variable, unit}` (`loader.trigger_lookup`). It resolves a tripwire condition that names a `rule_id`, and it fills in the tripwire unit. If the variable or the unit cannot be resolved it raises `invalid_case`: units are never assumed, so the real cases need the lookup. |
| `case_reduce(state, event)` | The new state. An event is `{type, t, …}`: `OPEN{finding}`, `SELECT{countermeasure_id}`, `STEP{step_id, input?}`, `OUTCOME{text}`, `TICK{observations}`, `DISMISS{reason}`. The states are `idle → detected → acting → watch → resolved \| escalated`, plus `dismissed` (reachable from detected, acting or watch). OPEN needs severity ≥ `caution` and a finding whose `rule_id` is one of the case's triggers. An invalid event returns the same state plus a `log` entry with `error` set: `invalid_transition`, `invalid_event`, `below_threshold`, `not_a_trigger`, `unknown_countermeasure`, `unknown_step`, `duplicate_step`, `time_reversed` or `unit_mismatch`. Every accepted transition appends `{t, event, from, to, detail, error: null}` to `log`. A TICK outside `watch`, or a TICK that adds no tripwire observation, returns the state unchanged with no log entry. A malformed `state` (not built by `new_case`/`case_reduce`) is a contract violation and raises `invalid_argument`. Tripwire: the reducer keeps the condition variable's observations with `watch_started_at < obs.t ≤ t`, deduplicated by `t` and sorted by `t`. These are observations of this crew, plus observations whose `crew_id` is null or absent, which are vehicle or habitat sensors such as the onboard proton monitor and are shared by every crewmember. The tripwire is judged only at `t ≥ reassess_at` (OUTCOME `t` + `reassess_after_s`), matching the case texts "Reassess at T+72 h; if … still …". At or after that time the case is `escalated` if at least `at_least` of the last `of_last_n` meet the condition. It is `resolved` once even all-missing slots counted as hits could not reach `at_least`. Otherwise it stays in `watch` and is judged again at each later TICK. |
| `build_ground_packet(case_state, observations, consent, env_id, t, mission_epoch)` | A FHIR R4 `Bundle` (type `collection`) of `Observation`s. It holds this crew's observations, plus vehicle observations (`crew_id` null or absent, tagged `scope-vehicle` and placed in this crewmember's packet as exposure context), with `obs.t ≤ t` whose variable is in `case_state.spec.escalation.observations` (when that list exists), and only if consent allows it. `mood` (and any variable in `PRIVATE_VARIABLES`) needs `consent[var] === true`. Any other variable is shared unless `consent[var] === false`. Vital signs use the LOINC codes of the FHIR R4 vital-signs profile, with the vitalsigns profile and the `vital-signs` category. Anything else uses a local `CodeSystem` `https://landfall.dev/fhir/CodeSystem/landfall`. No invented LOINC codes. `mission_epoch` is the UTC `YYYY-MM-DDTHH:MM:SSZ` of MET 0, and turns MET into `effectiveDateTime`. Units go to UCUM codes, and an unmapped unit raises `unknown_unit`. Unit `yes/no` becomes `valueBoolean`, and unit `MET` becomes `valueDateTime`. Entries are sorted by `(t, variable)`. `subject` is a logical reference `{type: "Patient", identifier, display}`, with no Patient resource, because the vital-signs profile requires `Reference(Patient)`. Resource ids are `{crew}-{variable}-{floor(t)}` with `_` turned into `-`. On a collision the id gets the suffix `-2`, `-3`, …, and the base is truncated so the id stays at most 64 characters. |
| `comms_eta(env, t, comms_table?)` | `{one_way_s, round_trip_s, blocked, reason, resumes_at, earliest_reply_s, light_time_source}`. `env` is an environment object. `round_trip_s = 2·one_way_s`. Without a table, `one_way_s` is the environment's `max`. With `from_snapshot`, the light time comes from `comms_table = {samples: [{t, one_way_s}], conjunction_windows: [{start, end, reason}]}` in MET seconds, linearly interpolated and clamped at the ends. `blocked` is true when `conjunction` is true and `start ≤ t < end`. Touching or overlapping windows chain, and `resumes_at` is the end of the chain. `earliest_reply_s = (resumes_at − t) + round trip at resumes_at`, assuming zero ground time. |
| `format_met(seconds)` | `"dddd/hh:mm:ss"`. Day 0 starts at MET 0. Input is floored. Days are never truncated (`10000/…`). Negative input prints as `-dddd/…`. |
| `fmt_num(x, dp=3)` · `met_to_iso(t, mission_epoch)` | Formatting helpers used inside every `why`/`detail` string. |

**Determinism rules for the port.** The TS port must follow these so that results match:

- Sum left to right in a plain loop. Python 3.12's `sum()` is compensated, so the engine does not use it.
- Square as `d*d`, never `pow`.
- Evaluate expressions in the order written in `engine/*.py`.
- Sort strings by code point. All ids are ASCII.
- `fmt_num` rounds half away from zero with integer arithmetic. Compute `k = floor(|x|·10^dp + 0.5)`, then print `k div 10^dp`, and `k mod 10^dp` with its trailing zeros stripped. Do not use `toFixed` or `String(x)`. It rejects |x| ≥ 1e15 and `|x|·10^dp + 0.5 ≥ 2^53`, so `k` stays an exact integer in a double. Without that guard, JS `(k − k mod 10^dp) / 10^dp` can lose digits that Python's integer arithmetic keeps.
- `met_to_iso` uses POSIX seconds with no leap seconds, like JS `Date`. Print it without milliseconds. It rejects results outside the years 0001–9999 (`invalid_argument`). JS `Date` would print `+010000-…` instead, so the port must check the year.

## 6. Conformance vectors

`engine/tests/vectors/<fn>.json` (one file per function above, including `new_case`, `fmt_num`
and `met_to_iso`) hold arrays of `{"name", "fn", "args", "expect"}`. A call that must fail is
written `{"name", "fn", "args", "raises": "<error code>"}` instead. `args` uses the argument names
of section 5. A function that returns a scalar has that scalar as `expect`. Fixtures come from
`engine/tests/fixtures/engine_fixtures.json` and are labeled as fixtures. The Python suite
generates the vectors, replays every one, and asserts that the committed files equal a fresh
regeneration. The TypeScript suite (`web/src/engine/*.test.ts`) loads the same files and must
agree. Numbers match with float tolerance `1e-9`, strings match exactly, and `raises` matches the
error code. Regenerate the vectors with `uv run python -m engine.vectors`, and verify them with
`uv run python -m engine.vectors --check`.

## 7. Demo scenario (simulated, seeded, labeled)

- Four crewmembers. The simulated data runs from MET day 368 to day 412, with baseline days
  368–381. "Now" is MET `0412/14:20:00`.
- **Renal** (CM-3): 24-h urine output falls below the case target on MET days 398–401, while fluid
  intake falls as well.
- **Sleep** (CM-1): after a schedule shift on MET day 403, sleep shortens, the sleep midpoint
  shifts, and PVT-B lapses rise to a reliable change by MET day 407.
- **FFD demo** (CM-2): VO₂max 35.1 ml/min/kg. This is *within* the microgravity EVA floor (32.9)
  and *outside* the surface EVA floor (36.5). The environment selector flips the verdict.
- **SPE (the hero)**: MET day 412, during a real Mars solar conjunction window taken from
  `horizons_mars_comms`. A real historical proton event is replayed, time-shifted. Houston is
  unreachable, and LANDFALL opens `spe_shelter` from the onboard monitor alone.
- Mood is simulated for every crewmember, never alerts, and is private by default.
