# engine/rules: the knowledge layer

These five JSON files are everything LANDFALL knows. The Python engine, the TypeScript runtime and
the `/provenance` page all read the same files. The contract is `engine/SPEC.md` section 3.

| File | What it holds |
|---|---|
| `environments.json` | ISS, cislunar, lunar surface and Mars surface: gravity, EVA type, dose snapshot, whether the NOAA scale reaches the crew, and comms light time. |
| `thresholds.json` | Tier A rules: NASA-published FFD / PEL / POL limits with requirement IDs, Table 4.8-1 organ limits (mGy-Eq / mGy, never mSv), vehicle design requirements as `role: "context"`, NOAA S1-S5 as `OPS`, the onboard S3 rule for Mars, and the renal `TARGET` rule (a countermeasure target from a NASA report). Also `constants` that derived numbers point to. |
| `personal.json` | Tier B: the settings of the single-case t-test (Crawford & Howell 1998; two-tailed alpha 0.001, minimum and full baseline length; see `rci.method`, `rci.detectable_change`, `rci.caveat` and `rci.change_note`) and the fourteen personal indicators, including the manual cuff blood pressure and fingerstick glucose readings. No test-retest reliability is used. |
| `cases.json` | The three deep cases (`renal_stone`, `sleep_circadian`, `spe_shelter`): triggers, interpretation, one primary countermeasure, guided procedure (with required, red-flag and packet-release steps), tripwire (environment-aware through `by_env`), ground packet, hand-offs and refusals. |
| `meta.json` | The vocabulary: chips, categories (with NASA glossary text), severity mapping (quoting NASA-STD-3001 Vol 2 Table 10.3-1), escalation tiers, packet states, hazards, body regions, principles and refusals. |

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
  crew health (its alert requirements leave the number to the program), so every "approaching" level and tripwire
  is ours, and it says so.

## Things that look odd and are deliberate

- The renal rule is category `TARGET`, not FFD/PEL/POL. Its numbers (risk rises below 1.5 L/day; the hydration
  target is 2.5-3 L/day of urine) come from the NASA HRP renal stone evidence report, not from a standard, so its
  chip is `NASA report` and it has no requirement ID. It is capped at `caution`.
- `noaa_scale_available` is `false` at Mars. There the SPE case runs on `ops_onboard_proton_s3`, which reuses
  NOAA's S3 threshold on the reading of an external space-weather monitor above the atmosphere, in Mars orbit,
  relayed to the habitat with no Earth link ([V2 6165]), and is labeled a design choice. The demo values are the
  GOES-7 October 1989 replay with no distance or atmosphere correction. The rule id keeps its old name. The SPE
  tripwire follows: its condition watches `ops_noaa_s3` near Earth and, through `by_env.mars_surface`,
  `ops_onboard_proton_s3` at Mars. LANDFALL is not the radiation alarm: the vehicle's radiation monitoring system
  raises it ([V2 6164]); the case is what follows.
- Severity follows NASA-STD-3001 Vol 2 Table 10.3-1 (`meta.json` `severity_mapping` quotes each class). The only
  Warning is a solar particle event at S3 or above, whose rules carry the shelter action. FFD, PEL, POL and TARGET
  findings and Tier B changes are Caution at most; the VO2max floors carry `max_severity: "caution"` and the
  crew-facing label "EVA assignment not cleared". LANDFALL never emits Emergency.
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
