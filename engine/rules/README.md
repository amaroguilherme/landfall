# engine/rules: the knowledge layer

These five JSON files are everything LANDFALL knows. The Python engine, the TypeScript runtime and
the `/provenance` page all read the same files. The contract is `engine/SPEC.md` section 3.

| File | What it holds |
|---|---|
| `environments.json` | ISS, cislunar, lunar surface and Mars surface: gravity, EVA type, dose snapshot, whether the NOAA scale reaches the crew, and comms light time. |
| `thresholds.json` | Tier A rules: NASA-published FFD / PEL / POL limits with requirement IDs, Table 4.8-1 organ limits (mGy-Eq / mGy, never mSv), vehicle design requirements as `role: "context"`, NOAA S1-S5 as `OPS`, the onboard S3 rule for Mars, and the renal `TARGET` rule (a countermeasure target from a NASA report). Also `constants` that derived numbers point to. |
| `personal.json` | Tier B: the settings of the single-case t-test (Crawford & Howell 1998; two-tailed alpha 0.001, minimum and full baseline length; see `rci.method`, `rci.detectable_change`, `rci.caveat` and `rci.change_note`) and the fourteen personal indicators, including the manual cuff blood pressure and fingerstick glucose readings. A count (PVT-B lapses) declares `transform: "anscombe"`; an indicator whose measured chance rate is not within 0.5-2 times the printed one declares it in `chance_rate` (2 decimals, 3 for a borderline value: mood's 0.495). No test-retest reliability is used. Prose that views print names no code identifier; pointers for maintainers are in `rci.impl_notes` and `chance_rate.impl_note`, which no view displays. |
| `cases.json` | The three deep cases (`renal_stone`, `sleep_circadian`, `spe_shelter`): triggers, interpretation, one primary countermeasure, guided procedure (with required, red-flag and packet-release steps), tripwire (environment-aware through `by_env`), ground packet, hand-offs and refusals. |
| `meta.json` | The vocabulary: chips, categories (with NASA glossary text), severity mapping (quoting NASA-STD-3001 Vol 2 Table 10.3-1), escalation tiers (tier 1 the Crew Medical Officer, CM-4; on the CMO's own cases the crew's second Crew Medical Officer, the Commander, CM-1, since [V1 3006] requires at least two trained per vehicle; which crewmember holds the second assignment is a design choice, and its basis also quotes [V2 7045]; neither is assumed to be a physician), packet states, hazards, body regions, principles and refusals. |

## Reading a number

Every number has a `chip` and a `source` (on the object itself or the object that encloses it):

- `NASA-published`: printed in NASA-STD-3001; the `source` gives the requirement ID or table, the page, and a
  `verbatim` fragment. The test checks that fragment against the frozen snapshot in `web/public/data/`.
- `NASA report`: a NASA technical report that is not a standard and has no requirement ID (an OCHMO technical brief
  or an HRP evidence report), cited in full. Its source `kind` keeps the original name `nasa_brief`.
- `NOAA-published`: NOAA Space Weather Scales; checked against `swpc_s_scale`.
- `literature`: a paper or another public document (for example a NASA fact sheet or presentation), cited in full.
- `derived`: arithmetic on published values; `from` lists the inputs and `arithmetic` shows the sum.
- `design choice`: our number, with `rationale`. NASA-STD-3001 publishes no numeric in-flight alert thresholds for
  crew physiology (vital signs; its alert requirements leave the alert point to the program), so every "approaching" level and tripwire
  is ours, and it says so.

## Things that look odd and are deliberate

- The renal rule is category `TARGET`, not FFD/PEL/POL. Its numbers (risk rises below 1.5 L/day; the hydration
  target is 2.5-3 L/day of urine) come from the NASA HRP renal stone evidence report, not from a standard, so its
  chip is `NASA report` and it has no requirement ID. It is capped at `caution`.
- `noaa_scale_available` is `false` at Mars. There the SPE case runs on `ops_onboard_proton_s3`, which reuses
  NOAA's S3 threshold on the reading of an external space-weather monitor above the atmosphere, in Mars orbit,
  relayed to the habitat with no Earth link, and is labeled a design choice. The monitor is the kind [V2 6165]'s
  rationale describes (sensitive to radiation the habitat's shielding absorbs); it has one ≥10 MeV integral
  channel, not the proton and electron flux spectra [V2 6165] asks for, and continuous relay is a scenario
  assumption. The demo values are the GOES-7 October 1989 replay with no distance or atmosphere correction. The
  rule id keeps its old name. The SPE tripwire follows: its condition watches `ops_noaa_s3` near Earth and,
  through `by_env.mars_surface`, `ops_onboard_proton_s3` at Mars. LANDFALL is not the radiation alarm: the vehicle's radiation monitoring system
  raises it ([V2 6164]); the case is what follows.
- Severity follows NASA-STD-3001 Vol 2 Table 10.3-1 (`meta.json` `severity_mapping` quotes each class). The only
  Warning is a solar particle event at S3 or above, whose rules carry the shelter action. FFD, PEL, POL and TARGET
  findings and Tier B changes are Caution at most; the VO2max floors carry `max_severity: "caution"` and the
  crew-facing label "EVA fitness floor not met" (EVA medical clearance itself is ground medical support's
  decision before each EVA, [V1 6006]). LANDFALL never emits Emergency. One inversion is disclosed in
  the `tier_a_outside` note: a 30-day blood-forming-organ dose over its limit opens the shelter case, whose first
  steps are immediate, yet that finding stays a Caution (a Warning would need an engine change).
- A one-line action names "a Crew Medical Officer", not "the": the crew has two ([V1 3006]), so the text holds
  when the patient is the Crew Medical Officer (CM-4) as well.
- An alerting rule or indicator that no case lists as a trigger carries an `action` (label, one-line text, design
  choice): these are the findings without a deep case. A `case_id` on such a rule names a related case for context;
  it does not open it.
- Procedure steps may be `required` (OUTCOME waits until each is done or declined with a reason), `red_flag` (a
  required yes/no question; "yes" escalates the case at once to the Crew Medical Officer and queues the ground
  packet for the flight surgeon) or `releases_packet` (the crew releases the packet: Prepared (held on board), then
  Queued).
- `[V2 11040]` applies only to the surface environments: its section title says "for Partial Gravity Scenarios".
- POL values are percent of pre-mission (`100 x current / pre-mission`), matching the requirement text.
- Tier B uses no test-retest reliability. An earlier version applied Jacobson & Truax's RCI arithmetic, which
  needs one, to the crewmember's own baseline SD, and its false-alarm rate came out far above the printed one
  (`rci.change_note`). Each indicator keeps an empty `reliability_r` (`value: null, used_by_engine: false`) only
  so readers built for the old shape keep working; its rationale says why no value is claimed.
- A non-alerting indicator (mood, daytime light, skin temperature) shows a reliable change with severity
  `nominal`: it never alerts.
- PVT-B lapses are tested on the Anscombe scale, `2√(x + 3/8)` (`transform`, Anscombe 1948): as raw counts their
  chance cautions came about 10 times as often as printed. The band is mapped back to lapses for the crew.
- The sleep midpoint shift is **signed** (later is positive) and alerts in both directions (`worse: "either"`, like
  glucose). The earlier absolute shift folded the noise at zero and flagged about 12.7 times too often.
- `chance_rate` on PVT-B lapses and mood is a measurement, not a choice: a seeded Monte Carlo under the scenario's
  own noise model (`engine/tests/test_chance_rates.py` requires the declared multipliers, and requires every other
  indicator to be within 0.5-2 times its printed rate).
- `hrv_sdnn` is pulse-rate variability from the band's optical (PPG) pulse, not ECG normal-to-normal intervals.
- Crew-facing text prints comparisons as signs (≥, ≤, ±), never `>=`; a test checks every string.
- Every `not_measurable_here` requirement ID carries a `requirement_quote` that the test finds in that
  requirement's own text. `[V1 3004](i)` asks for in-mission imaging in general (cardiac, vascular, ocular
  examples), so the kidney-imaging hand-off says it names neither the kidney nor ultrasound.
- Case texts (`one_line`, `interpretation`) are written to be true for every trigger of the case, because a case
  opens when any one trigger reaches `caution`, and for every crewmember, environment and link state: no rule IDs,
  no anthropomorphic phrasing, and both link modes (with the link up, Mission Control directs; without it, the crew
  acts onboard with the Crew Medical Officer).
- Medication: no crew-facing text names a drug. Potassium citrate appears only in the renal ground packet's
  `flight_surgeon_note`, as a NASA-studied countermeasure whose decision rests with the flight surgeon.

## Checking

```bash
uv run pytest engine/tests/test_rules.py -q -rs
```

The cross-checks skip, with a reason, when a snapshot has not been built yet.
