# LANDFALL engine specification

This file is the contract between the rules data (`engine/rules/*.json`), the Python reference
engine (`engine/*.py`), the TypeScript runtime that runs in the browser (`web/src/engine/*.ts`), and
the simulated scenario (`ingest/sim_crew.py`). If code and this file disagree, this file wins until
it is changed on purpose.

## 1. Principles

1. **NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert
   requirements leave the number to the program** (`[V2 6022]`, `[V2 6164]`, `[V2 11036]`,
   `[V1 4006]`, `[V1 4008]`). LANDFALL never presents its own number as NASA's.
2. NASA *does* publish three structurally different kinds of limit. They are never merged into one
   "threshold exceeded" state:

   | Category | Shape | Glossary (NASA-STD-3001 Vol 1 Rev C) |
   |---|---|---|
   | `FFD` Fitness for Duty | a **floor** on the crewmember's capability | "Minimum measurable capability … that allows successful performance of all required duties." |
   | `PEL` (Space) Permissible Exposure Limit | a **ceiling** on cumulative exposure over a time window | "Quantifiable limit of exposure to a spaceflight factor over a given length of time." |
   | `POL` Permissible Outcome Limit | a **maximum change** against the crewmember's own baseline | "Acceptable maximum decrement or change in a physiological or behavioral parameter … as the result of exposure to the space environment." |

   The other categories: `OPS` covers an operational scale published by another agency (the NOAA
   S-scale). `TARGET` covers a countermeasure target that a NASA report publishes but that is not a
   limit (the renal case's 24-h urine output, from the HRP renal stone evidence report); it is
   capped at `caution`. `PERSONAL` covers Tier B reliable change against one's own baseline.
3. **Tier A** rules carry a number NASA or NOAA publishes, with its requirement ID when the number
   comes from a standard (a NASA report such as an HRP evidence report has none, and says so).
   **Tier B** asks Jacobson & Truax's (1991) "reliable change" question (is today's value further
   from this person's usual value than day-to-day noise explains?) and answers it with the
   single-case test for one new value against the mean of n baseline values from the same person,
   the modified t-test of Crawford & Howell (1998): `t = (x − mean) / (SD·√(1 + 1/n))`, `df = n − 1`,
   reliable when `|t|` exceeds the two-tailed Student t critical value at `alpha = 0.001`. Under
   normal, independent day-to-day noise its chance rate is exactly `alpha` per indicator-day
   (`alpha/2` for a change in the worse direction). That expected false-alarm rate is printed next
   to it, with the caveat that autocorrelated or skewed data raise it. Its sensitivity is stated too:
   the **minimum detectable change** `critical·SD·√(1 + 1/n)` (4.37 baseline SDs for a 14-day
   baseline) is the smallest one-day change it can flag, whatever the change means clinically.
4. Every constant carries a **chip** naming its basis:
   `NASA-published` · `NASA report` (a NASA technical report that is not a standard and has no
   requirement ID: an OCHMO technical brief or an HRP evidence report) · `NOAA-published` ·
   `literature` · `derived` (arithmetic on published values, shown) · `design choice` (no published
   basis: ours, and labeled as such).
5. **Refusals are features.** There is no diagnosis, no medication or dosing advice in crew-facing
   text (potassium citrate appears only in the renal ground packet's note for the flight surgeon), no
   psychiatric alert, no personal cancer-risk (REID) model, and no claim that CO₂ causes cognitive
   deficit (the defensible claim is headache risk). LANDFALL **never raises an Emergency-class
   alarm**: that belongs to the vehicle caution & warning system. It is **not the radiation alarm**
   either: the vehicle's radiation monitoring system raises it (`[V2 6164]`); LANDFALL opens the
   health case that follows and guides the crew.
6. Pure functions only. Same inputs → same outputs in Python and TypeScript, proven by the shared
   vectors in `engine/tests/vectors/`.

## 2. Vocabulary

- **status** of a finding: `within` · `approaching` · `outside` · `reliable_change` ·
  `insufficient_data` · `stale` · `not_applicable`
- **severity**: `nominal` · `advisory` · `caution` · `warning`. `emergency` exists in the type but the
  engine never emits it. The classes are those of NASA-STD-3001 Vol 2 Rev F **Table 10.3-1** (frozen in
  `std_vol2_requirements` → `data.tables.table_10_3_1`), whose rows define them:
  - Warning: "Event that requires immediate action because it has the potential to become a
    life/mission threat."
  - Caution: "Event that needs attention, but not immediate action."
  - Advisory: "Message describing a routine event, situation, or action, or an off-nominal event that
    does not meet the criteria for a Caution."

  Colours follow Appendix F Table F.5-1 (red is reserved for Emergency/Warning). Which LANDFALL
  finding falls in which class is a `design choice`, stored in `rules/meta.json` `severity_mapping`,
  whose rows quote the definition of their class (a test checks the quotes against the frozen table):
  - `OPS` S3 or above, `outside` → `warning`. Every such rule carries the shelter action
    (`action_id: "spe_shelter"`), which is immediate; an EVA in progress does not change it. In the same
    table the Warning row's auditory annunciation gives "Radiation" as an example warning message (Vol 2
    Rev F, PDF page 206; outside the frozen first-clause excerpt). This is the only Warning LANDFALL emits.
  - `OPS` S1–S2 `outside` → `advisory`; any OPS `approaching` → `advisory`.
  - Tier A `FFD` / `PEL` / `POL` `outside` or `approaching` → `caution`: a floor not met or an exposure
    or outcome limit reached needs attention, not immediate action. The VO₂max floors also carry
    `max_severity: "caution"` and the crew-facing label "EVA assignment not cleared".
  - `TARGET` `outside` → `caution`; `approaching` → `advisory` (a countermeasure target is not a limit).
  - Tier B `reliable_change` in the worse direction → `caution` (personal change is not a limit, so
    never `warning`). A reliable change in the other direction is shown at `nominal`; LANDFALL does not
    call it better. For a non-alerting indicator (`alerting: false`, e.g. mood) it stays `nominal`:
    shown, never an alert, because advisory blue would read as one.
  - `role: "context"` rules → `advisory` at most; `insufficient_data` / `stale` → `advisory`, drawn
    cyan (Table F.5-1 "Missing or stale data"); `not_applicable` → `nominal`.
- **MET**: mission elapsed time in integer seconds. It is displayed as `d/hh:mm:ss` per Vol 2
  Appendix F F.6.1 f, "leading zeros are suppressed in day field" (e.g. `412/14:20:07`; the standard's
  own examples are `MET 57/14:08:33` and `MET 1089/13:03:01`). Day-count durations use the same format
  (a countdown of 11 d 05 h 59 min 51 s is `11/05:59:51`).
- **crew ids**: `CM-1` Commander, `CM-2` Flight Engineer, `CM-3` Mission Specialist, `CM-4` Crew
  Medical Officer (a non-physician with ~40 h of medical training). They are fictional. There are no
  names and no real PII. Crew-facing texts are true for every role (the sleep case does not tell the
  Commander to tell the commander).
- **escalation tiers** (`rules/meta.json` `escalation`): tier 1, the onboard **Crew Medical Officer**,
  now; tier 2, the **flight surgeon** on the ground, through the ground packet, which is sent with the
  next link: at once when the link is up (AOS), when it resumes during loss of signal or solar
  conjunction. Autonomy scales with the link: at AOS (ISS, cislunar space, the lunar surface) the ground
  has the case within the round-trip light time and the crew follows Mission Control and flight-surgeon
  direction, with LANDFALL as the decision aid; without a link the crew acts onboard with the CMO.
- **packet states** (`rules/meta.json` `packet_states`): `Prepared (held on board)` while a case is open
  and its packet has been neither released by the crew nor escalated; `Queued` after crew release (a
  procedure step with `releases_packet`) or escalation (case state `packet_queued_at`). A queued packet is
  sent when a link exists. The same two labels are used everywhere.

## 3. Rules files (`engine/rules/`)

All files are JSON with a `"schema"` key. Every object with a number in it carries `chip` and
`source`. `source` is one of:

```json
{"kind": "nasa_standard", "doc": "NASA-STD-3001 Vol. 1 Rev. C", "requirement_id": "V1 4030",
 "section": "4.8.2", "url": "https://…", "snapshot": "std_vol1_requirements"}
{"kind": "nasa_brief", "doc": "NASA HRP Evidence Report: Risk of Renal Stone Formation (…; NTRS 20240012429)", "url": "https://…"}
{"kind": "noaa", "doc": "NOAA Space Weather Scales", "url": "https://…", "snapshot": "swpc_s_scale"}
{"kind": "literature", "citation": "Basner M, Mollicone D, Dinges DF. Acta Astronaut 2011;69(11-12):949-959. PMID 22025811", "url": "https://…"}
{"kind": "derived", "from": ["<rule or constant ids>"], "arithmetic": "human-readable formula"}
{"kind": "design_choice", "rationale": "why we picked this"}
```

The `nasa_brief` kind goes with the chip `NASA report` and covers every NASA technical report
without a requirement ID (OCHMO technical briefs and HRP evidence reports); the kind keeps its
original name. `doc` is the display name; a full `citation` may sit beside it.

`snapshot` names a frozen file in `web/public/data/` whose verbatim text backs the value. A test
asserts that every Tier A limit appears verbatim in that snapshot's requirement text. Quotes are
matched against the cited requirement's own text, rationale and items, or the cited table's own
cells, never against the snapshot as a whole (which also holds LANDFALL's commentary).

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
no NOAA alert reaches the crew anyway. At Mars the solar particle event case reads an **external
space-weather monitor above the atmosphere, in Mars orbit**, relayed to the habitat locally with no
Earth link: the in-situ extravehicular monitoring that `[V2 6165]` requires ("monitor the in-situ
extravehicular space weather environment including … proton flux spectra"). The demo values are the
GOES-7 October 1989 ≥10 MeV replay with **no radial-distance or atmospheric correction** (a labelled
scenario assumption). The habitat dose rate is a separate simulated confirmation (an assumption, not a
radiation-transport calculation). The vehicle's radiation monitoring system raises the alarm
(`[V2 6164]`); LANDFALL opens the health case. The Mars solar conjunction window is **modelled** from JPL
Horizons geometry, its edges fitted to NASA's published command moratoria (RMS 0.79 d); it is never
presented as an announced window.

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
   "action": {"label": "Career dose at or near the NASA limit", "text": "…", "chip": "design choice", "source": {"kind": "design_choice", "rationale": "…"}},
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
- `max_severity` (optional) caps the severity. Both VO₂max floors carry `"caution"`; the renal
  `TARGET` rule too.
- `action` (optional): `{label, text, chip, source}`, the one-line action of a **finding without a deep
  case** (D11). Every alerting rule that no case lists as a trigger carries one, OPS rules excepted (S1–S2
  never exceed advisory, and S4–S5 co-fire with the S3 trigger of the shelter case). `label` is the
  crew-facing alert label (the VO₂max floors: "EVA assignment not cleared"); `text` names the next step
  and who decides (the Crew Medical Officer, the vehicle or suit caution and warning system). A `case_id`
  on such a rule names a related case for context; it does not open it. A rule that is a case trigger
  has no `action`: its case is the action.
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
    chip `NOAA-published` and verbatim biological text, plus `ops_onboard_proton_s3`, NOAA's S3 number
    reused at Mars on the Mars-orbit monitor (chip `design choice`; the id keeps its old name).

### 3.3 `personal.json` (Tier B)

```json
{"schema": "landfall.personal/1",
 "rci": {"alpha_two_tailed": 0.001, "min_baseline_n": 7, "baseline_window_days": 14,
         "chip": "literature",
         "source": {"kind": "literature", "citation": "Crawford JR, Howell DC. Clin Neuropsychol 1998;12(4):482-486. doi:10.1076/clin.12.4.482.7241"},
         "method": "t = (today − baseline mean) / (baseline SD × √(1 + 1/n)), df = n − 1 …",
         "detectable_change": {"text": "… 4.37 baseline SDs; at the 7-day minimum, 6.37 …", "chip": "derived", "source": {}},
         "lineage": {"text": "… Jacobson & Truax's 'reliable change' …", "chip": "literature", "source": {}},
         "provenance": {"alpha_two_tailed": {"chip": "design choice", "source": {}}, "…": "…"},
         "caveat": "exactly alpha only under normal, independent noise …",
         "caveat_basis": {"text": "…", "chip": "literature", "source": {}},
         "change_note": "what changed from the earlier arithmetic, and why"},
 "indicators": [
  {"id": "pvt_lapses", "label": "PVT-B lapses", "variable": "pvt_lapses", "unit": "count",
   "worse": "increase", "alerting": true, "private": false,
   "definition": {"text": "lapse = reaction time ≥ 355 ms on the 3-min PVT-B", "chip": "literature",
                  "source": {"kind": "literature", "citation": "Basner M, Mollicone D, Dinges DF. … 2011 …"}},
   "case_id": "sleep_circadian"},
  {"id": "glucose", "variable": "glucose", "unit": "mg/dL", "worse": "either", "alerting": true,
   "device": "manual", "limit_note": {"text": "No NASA numeric limit: …", "chip": "design choice", "source": {}},
   "context": {"text": "Context only, not a limit: … 65-99 mg/dL …", "range": {"min": 65, "max": 99, "unit": "mg/dL"},
               "chip": "literature", "source": {"snapshot": "osdr_cmp", "…": "…"}},
   "action": {"label": "Fingerstick glucose changed", "text": "…", "chip": "design choice", "source": {}},
   "case_id": null},
  {"id": "mood", "variable": "mood", "unit": "score_1_5", "worse": "decrease",
   "alerting": false, "private": true, "case_id": null}
 ]}
```

The engine reads `alpha_two_tailed` and `min_baseline_n` from the `rci` block. The critical value
is not stored: it depends on the baseline length and the engine computes it
(`t_critical(alpha, n − 1)`: 4.221 for a 14-day baseline, 5.959 at the 7-day minimum). A test
checks that the critical values quoted in `rci.method`, and the minimum detectable changes quoted in
`rci.detectable_change`, equal the engine's.

There is **no test-retest reliability** in the computation. The single-case test needs only the
crewmember's own baseline mean and SD, whose day-to-day noise is exactly what it measures. An
indicator may still carry `reliability_r: {"value": null, "used_by_engine": false, chip, source}`
as non-computational context (the reason no value is claimed); the engine ignores it.

`worse` is `increase`, `decrease` or `either`. An `either` indicator (glucose: a reading can move too low
or too high) raises a caution on a reliable change in either direction, so it doubles its own
chance-caution rate; `expected_false_alarms` takes the count of such indicators as `k_either`.
An alerting indicator that no case lists as a trigger carries an `action` (section 3.2). `limit_note`
says why an indicator has no Tier A rule; `context` (with an optional `range`) is shown, never alerted on.

The required indicators are:

- `pvt_lapses`, `pvt_median_rt` (ms)
- `sleep_duration` (h, from actigraphy)
- `sleep_midpoint_shift` (h): the **absolute** shift of the night's sleep midpoint from the median
  midpoint of the crewmember's fixed baseline window, with clock arithmetic across midnight. It is never
  negative; worse = increase covers both earlier and later drift. Its baseline values are skewed, so the
  normal-theory chance rate is a lower bound (`rci.caveat`).
- `light_exposure_daytime` (lux)
- `resting_hr` (bpm)
- `hrv_sdnn` (ms)
- `skin_temp` (°C)
- `urine_volume_24h` (mL)
- `fluid_intake_24h` (mL)
- `bp_systolic`, `bp_diastolic` (mmHg): one cuff reading at rest with the vehicle medical kit, typed in
  by the crewmember; worse = increase.
- `glucose` (mg/dL): one fingerstick glucometer reading, typed in; worse = either. Context only: the
  SpaceX Inspiration4 lab reference range, 65–99 mg/dL (`osdr_cmp`; a test checks it).
- `mood` (1–5, **private, non-alerting**)

The manual readings (`bp_*`, `glucose`) are Tier B only, alerting at caution at most. NASA-STD-3001 sets
no numeric limit for them, and each says so in `limit_note`: a text search of Vol 1 Rev C and Vol 2 Rev F
at build found blood pressure only as the condition name "Hypertension" in a Vol 1 appendix list, in a
Vol 2 uprighting rationale and as "blood pressure cuffs" among Vol 2's examples of non-isolated medical
equipment, and glucose only once, in a Vol 2 lighting rationale. Like every indicator they need at least
`min_baseline_n` baseline readings.

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
  `kidneys`, `skeleton`, `muscles`, `immune`. They are the case's **hazard footprint** (`meta.json`
  `body_region_rule`): drawn as a hatched outline, never as a severity fill; only a measured finding of
  the selected crewmember fills an organ, and VO₂max is a fitness tag, not a heart or lung finding.
- `triggers[]`: `{"kind": "rule", "rule_id": …}`, `{"kind": "personal", "indicator_id": …}` or
  `{"kind": "ops", "rule_id": …}`. The case opens when any trigger reports a finding with
  severity ≥ `caution`.
- `interpretation`: plain English with citations, written for a non-physician.
- `countermeasure`: `{"primary": {id, title, rationale, chip, source, citations?}, "alternatives": […]}`.
  There is exactly one primary, and the alternatives render collapsed. No countermeasure names a drug.
- `procedure[]`: guided steps `{id, text, input?: {variable, unit, source: "manual"|"band"|"vehicle"|"app"},
  required?, red_flag?, releases_packet?, red_flags?, basis?}`:
  - `required: true`: OUTCOME is rejected until the step is done or declined with a reason (event
    `DECLINE`). A required step with an `input` needs its value (a number, or yes/no for unit `yes/no`).
    The SPE shelter confirmations `p2` and `p3` and the renal red-flag question `r4` are required.
  - `red_flag: true`: a required yes/no question; "yes" escalates the case at once (section 5). The
    renal `r4` lists, in plain language (`red_flags`), the symptoms of the HRR risk statement it quotes in
    `basis` (HRR 81: "renal colic (pain), nausea, vomiting, hematuria, infection, and/or
    hydronephrosis"): flank pain, blood in the urine, painful urination, fever or chills, nausea or
    vomiting, inability to pass urine.
  - `releases_packet: true`: doing the step queues the ground packet (crew release). SPE `p6`.
  - `basis`: the citation of a step, kept out of its text (no IDs in crew text). The sleep step on
    safety-critical tasks cites `[V1 4011]` (cognitive status "as determined by behavioral health
    evaluations") and the protected-sleep step `[V1 4014]` (planned sleep periods "shall have
    established limits").
- `tripwire`: `{"reassess_after_s": 259200, "condition": {"indicator_id"|"rule_id": …, "op": …, "value": …, "of_last_n": 3, "at_least": 2, "by_env"?: {env_id: {…}}}, "text": "Reassess at T+72 h; if …, escalate: tell the Crew Medical Officer now, and the ground packet is queued for the flight surgeon.", "chip": …, "source": …}`.
  `by_env` makes the condition environment-aware: `new_case(…, env_id)` applies `by_env[env_id]`
  to the base condition (an override that names a `rule_id` or `indicator_id` replaces the base
  reference, variable and unit). `spe_shelter` watches `ops_noaa_s3` near Earth and, through
  `by_env.mars_surface`, `ops_onboard_proton_s3` at Mars, where the NOAA rule is
  `not_applicable`. A test requires every case's effective tripwire rule to apply in every
  environment.
- `escalation`: `{"ground_packet": true, "observations": [variables to include], "flight_surgeon_note"?:
  {audience: "flight_surgeon", text, chip, source}}`. The renal note is the only place potassium citrate
  appears: "a NASA-studied countermeasure (Whitson et al. 2009); the decision rests with the flight
  surgeon".
- `not_measurable_here[]`: `{what, via, requirement_id?, requirement_quote?, note?}`. This is the
  hand-off boundary, e.g. "urinary supersaturation, via ground lab" or "kidney stone imaging, via
  the vehicle's in-mission imaging". A `requirement_id` comes with a `requirement_quote` that a
  test finds verbatim in that requirement's text, so the ID is cited for what it says
  (`[V1 3004](i)` asks for in-mission imaging in general, with cardiac, vascular and ocular
  examples; the `note` says it names neither the kidney nor ultrasound).
- `refusals[]`

Case texts (`one_line`, `interpretation`, `procedure[].text`, `tripwire.text`, countermeasure titles
and rationales) are true for every trigger, crewmember, environment and link state. They carry no rule
IDs, no anthropomorphic phrasing (Appendix F F.6.2 e) and no drug names, and they state both link
modes where it matters (with the link up, Mission Control directs; without it, the crew acts onboard
with the Crew Medical Officer). Tests check each of these.

## 4. Observations

```json
{"crew_id": "CM-3", "variable": "urine_volume_24h", "value": 1480, "unit": "mL",
 "t": 35553600, "source": "manual", "provenance": "simulated"}
```

`source` is one of `band`, `manual`, `vehicle`, `lab`, `app` or `replay`. If an observation's unit
differs from the rule's unit, the engine raises an error. Units are never converted silently. The
manual vitals are `bp_systolic` / `bp_diastolic` in `mmHg` and `glucose` in `mg/dL` (UCUM `mg/dL`;
local FHIR codes, because the R4 blood-pressure vital sign is a panel). Step answers use `yes/no`
(`renal_symptoms`) and `MET` (`shelter_entry`).

## 5. Engine API (identical in Python and TypeScript)

Reference implementation: `engine/*.py` (stdlib only). Every function takes and returns plain JSON
values. Arguments are named exactly as below (the vectors use these names). A contract violation
throws an error carrying a stable `code`: `invalid_argument`, `invalid_rule`, `invalid_case`,
`unit_mismatch`, `variable_mismatch`, `unknown_unit` or `missing_comms_table`. Booleans are never
numbers.

| Function | Returns |
|---|---|
| `evaluate_rule(rule, value, env_id, t, ctx?)` | `Finding {rule_id, tier, category, status, severity, value, unit, limit, margin, chip, source, why}` plus `role, op, approach_at, env_id, t, case_id, action_id`. `value` is a number, `null` (→ `insufficient_data`) or an observation `{value, unit, t?, variable?}`. An observation whose `unit` differs from `rule.unit`, or has no unit, raises `unit_mismatch`; a different `variable` raises `variable_mismatch`. Both raise even where the rule is `not_applicable`. Severity follows section 2. `ctx` must be an object or `null` (else `invalid_argument`) and is accepted for compatibility (`{eva}` in older callers); no field of it changes the result. `margin` is `limit − value` for ceilings and `value − limit` for floors, so a positive margin is on the compliant side; it is `null` when nothing was compared (`not_applicable`, `insufficient_data`, `stale`). There are two optional rule fields. `stale_after: {seconds, chip, source}` makes an observation `stale` when `t − obs.t > seconds`. `max_severity` caps the severity. A rule's `action` is data for the UI; the engine does not read it. |
| `rci(baseline: number[], current, alpha=0.001, min_baseline_n=7)` | The single-case test of Crawford & Howell (1998). Returns `{method, status, reason, n, df, mean, sd, s_diff, rc, critical, alpha, reliable, direction, mdc}` with `method: "crawford_howell_1998"`. `sd` is the sample SD (n−1), `s_diff = sd·√(1 + 1/n)` (the SD of the difference between one new value and the mean of n values), **`rc` is the t statistic of the single-case test**, `(current − mean) / s_diff`, `df = n − 1`, `critical = t_critical(alpha, df)`, and **`mdc = critical·s_diff`, the minimum detectable change**: the band's half-width, the smallest change from the mean that is a reliable change. `reliable` means \|rc\| > `critical`. `null` baseline entries are skipped. `status` is `"ok"` or `"insufficient_data"`, with `reason` checked in this order: `baseline_too_short` (n < `min_baseline_n`), then `no_current`, then `zero_sd` (no division by zero). `zero_sd` is an exact test: when every baseline value equals the first one, `sd` is reported as `0` without computing it, because float noise would otherwise give `[7.3]*7` an SD of ~1e-15 and any change an rc of ~1e14. Fields are reported when computable: `mean` needs n ≥ 1; `sd`, `df` and `s_diff` need n ≥ 2; `critical` needs n ≥ `min_baseline_n`; `mdc` needs `critical` and an SD above 0 (so it is reported even with `no_current`); `rc` needs `status: "ok"`; otherwise they are `null`. `direction` is `increase`, `decrease` or `none`, from the sign of `current − mean`. `alpha` must be in (0, 1) and `min_baseline_n` an integer ≥ 2. A baseline mean or SD, an `mdc` or an `rc` that is not finite (inputs near the float range) raises `invalid_argument`, in that order: the engine never returns NaN or infinity. No test-retest reliability is involved. |
| `evaluate_personal(indicator, baseline, current, cfg, t?)` | `Finding` with `tier: "B"`, `category: "PERSONAL"`, plus `direction, worse, private, rci{method, rc, df, critical, alpha, s_diff, mean, sd, n, reliable, reason, mdc}`. `cfg` is the `rci` block of `personal.json` (it needs `alpha_two_tailed`, `min_baseline_n`, `chip`, `source`). An indicator needs `id, variable, unit, worse, alerting`; any `reliability_r`, `action`, `limit_note` or `context` is ignored. `worse` is `increase`, `decrease` or `either`. `limit` is the personal band edge on the worse side, `mean ± critical·s_diff`; for `either` it is the edge on the side the value moved. A non-finite `limit` or `margin` raises `invalid_argument`. A reliable change in the worse direction (any direction for `either`) → `caution`. A reliable change in the other direction → `status: reliable_change` with `severity: nominal`. A non-alerting indicator keeps `status: reliable_change` but `severity: nominal` in either direction: it is shown and never alerts. `insufficient_data` → `advisory` (missing data) for every indicator. `why` reads `"<label>: <value> <unit> vs own baseline mean <mean> <unit> (n=<n>); t = <rc>, critical <critical> (df <df>, two-tailed alpha <alpha>); <verdict>."` with verdict `reliable change in the worse direction`, `reliable change in the other direction (no alert)` or `no reliable change`, numbers by `fmt_num` (alpha with dp 6), then `" Non-alerting indicator: never alerts."` when it applies, then `" Basis: <basis>."`. |
| `min_detectable_change(sd, n, alpha=0.001)` | `{mdc, critical, s_diff, sd, n, df, alpha}`: `s_diff = sd·√(1 + 1/n)`, `critical = t_critical(alpha, n − 1)`, `mdc = critical·s_diff` (computed in that order, so it equals `rci(...).mdc` bit for bit). Use it to state Tier B's sensitivity at the crewmember's own SD or at a literature SD. `sd` must be a finite number > 0 (the test is undefined at SD 0), `n` an integer ≥ 2 (df ≤ 1e6), `alpha` in (0, 1); otherwise, or when the result is not finite, `invalid_argument`. |
| `expected_false_alarms(k_indicators, days, alpha=0.001, k_either=0)` | Chance findings for `k` indicators tested once a day. `{expected: (k·days)·alpha, per_day: k·alpha, every_n_days: 1/per_day or null, text, expected_cautions, cautions_per_day, caution_every_n_days: 1/cautions_per_day or null, caution_text, assumes, k_indicators, days, alpha, k_either}`. Flags count a chance reliable change in either direction. Cautions count only the worse direction for an indicator with one worse direction (half its flags, the test being two-tailed) and both directions for the `k_either` of the k whose `worse` is `either`: `cautions_per_day = ((k − k_either)·alpha)/2 + k_either·alpha` and `expected_cautions = (((k − k_either)·days)·alpha)/2 + (k_either·days)·alpha`; with `k_either = 0` they are `per_day/2` and `expected/2`. `text` is `"one false flag every N days on average, counting chance changes in either direction"`. `caution_text` is `"one false caution every M days on average: only a chance change in the worse direction raises a caution"`, or with `k_either > 0` `"one false caution every M days on average: a chance change in the worse direction raises a caution, and in either direction for the <k_either> indicator(s) that alert both ways"` (`<k_either>` by `fmt_num`), with N and M from `fmt_num(·, 1)`; with no expected findings they are `"no false flags expected"` and `"no false cautions expected"`. Every argument must be a finite number ≥ 0, `alpha` ≤ 1 and `k_either` ≤ `k_indicators`. `assumes` is the fixed sentence `"one test per indicator per day, with normal day-to-day noise that is independent from one day to the next; autocorrelated or skewed data give more, while correlation between indicators leaves the average unchanged and only bunches chance flags together"`. |
| `t_cdf(t, df)` | `P(T ≤ t)` for Student's t, `1 ≤ df ≤ 1e6` (df need not be an integer; outside that range `invalid_argument`). For `t ≥ 0` it is `1 − Q(t)`, else `Q(−t)`, with the upper tail `Q(t) = 0.5·I_x(df/2, 1/2)`: `Q(t) = 0.5` exactly for `t < 1e-17` (it rounds there for every df); for `t > 1e150`, `ln x = log(df) − 2·log(t)`, `x = exp(ln x)` (it may underflow to 0), `y = 1`, `ln y = 0`; otherwise `s = df + t·t`, `x = df/s`, `y = (t·t)/s`, `ln x = log(x)`, `ln y = log(y)` (y stands for `1 − x` and is never formed as `1 − x`). `I_x(a, b)`: `front = exp(lgamma(a+b) − lgamma(a) − lgamma(b) + a·ln x + b·ln y)` (left to right), then `front·cf(a, b, x)/a` when `x < (a+1)/(a+b+2)`, else `1 − front·cf(b, a, y)/b`. `cf` is the continued fraction of Numerical Recipes (3rd ed., §6.4) by the modified Lentz method, written out in `engine/tdist.py`: tiny = 1e-300, stop when \|delta − 1\| < 1e-15, at most 10000 iterations. Python uses `math.lgamma`; the TS port needs its own lgamma (a Lanczos approximation is enough), so its last bits can differ: the tolerance applies, not bit equality. |
| `t_quantile(p, df)` | The `t` with `t_cdf(t, df) = p`, for `0 < p < 1`: `0.0` at `p = 0.5`, `+U(1 − p)` above, `−U(p)` below, where `U(q)` (for `0 < q < 0.5`) solves `Q(t) = q`. `U` brackets the root between consecutive powers of two (if `Q(1) > q`: `lo, hi = 1, 2`, doubling both while `Q(hi) > q`, raising `invalid_argument` once `hi > 2^1000`; else `lo, hi = 0.5, 1`, halving both while `Q(lo) ≤ q`), then runs **exactly 32** bisection steps (`mid = 0.5·(lo + hi)`; `lo = mid` if `Q(mid) > q`, else `hi = mid`) and returns `0.5·(lo + hi)`: relative error < 2^-33. For moderate df every halving is then decided far above the last-bit noise of lgamma, so both languages land on the same double (`engine/tests/test_tdist.py` swaps in an independent lgamma and finds identical critical values); a run to full precision would not. That holds for every df the engine uses (n − 1 for an n-day baseline) and in every vector, and a verifier's 10,000 random inputs below df 1000 were all identical. At large df the terms `lgamma(df/2) ≈ (df/2)·ln(df/2)` are large, so one ulp of them is no longer negligible: the CDFs of the two languages can differ by about 1e-9 relative near df 1e6, and a late halving can then go the other way. Measured differences reach about 3e-10 relative below df 1e5 and about 3e-9 between 1e5 and 1e6 (each language is itself about that far from the true quantile there), so the conformance tolerance for `t_quantile` and `t_critical` at df above 1e5 is 1e-8 (section 6). |
| `t_critical(alpha, df)` | The two-tailed critical value, `P(\|T\| > c) = alpha` for `0 < alpha < 1`: `U(alpha/2)`, equal to `−t_quantile(alpha/2, df)`. `t_critical(0.001, 13) = 4.2208…`. Implementations may memoize it by `(alpha, df)`. |
| `s_level(flux_pfu)` | `0..5` from NOAA thresholds (≥10, ≥100, ≥1e3, ≥1e4, ≥1e5 pfu at ≥10 MeV). An OPS rule's level is its integer `s_level` field, else `s_level(limit)`. |
| `new_case(case_def, crew_id, lookup?, env_id?)` | The pre-OPEN state, `status: "idle"`. `lookup` maps a rule or indicator id to `{variable, unit}` (`loader.trigger_lookup`). It resolves a tripwire condition that names a `rule_id`, and it fills in the tripwire unit. If the variable or the unit cannot be resolved it raises `invalid_case`: units are never assumed, so the real cases need the lookup. `env_id` (a non-empty string or null) selects the tripwire condition's `by_env[env_id]` override (section 3.4); a `by_env` that is not an object, or an override that is not an object or nests `by_env`, raises `invalid_case`. The state's `spec` records `env_id` and the effective reference as `spec.tripwire.condition.ref_id` (the rule or indicator id, or null), next to `variable, op, value, unit, of_last_n, at_least`. From the procedure it records `step_ids`, `required_step_ids`, `red_flag_step_ids` and `packet_step_ids` (procedure order) and `step_inputs: [{step_id, variable, unit}]` for the steps with an input. A step flag (`required`, `red_flag`, `releases_packet`) that is present and not a boolean, an `input` without a string `variable` and a non-empty string `unit`, or a `red_flag` step that is not `required` or whose input unit is not `yes/no`, raises `invalid_case`. The new state also has `steps_declined: []`, `escalation: null` and `packet_queued_at: null`. |
| `case_reduce(state, event)` | The new state. An event is `{type, t, …}`: `OPEN{finding}`, `SELECT{countermeasure_id}`, `STEP{step_id, input?}`, `DECLINE{step_id, reason}`, `OUTCOME{text}`, `TICK{observations}`, `DISMISS{reason}`. The states are `idle → detected → acting → watch → resolved \| escalated`, plus `dismissed` (reachable from detected, acting or watch); `acting → escalated` also happens at once on a red-flag "yes". OPEN needs severity ≥ `caution` and a finding whose `rule_id` is one of the case's triggers. An invalid event is **atomic**: it returns the input state unchanged plus exactly one `log` entry with `error` set: `invalid_transition`, `invalid_event`, `below_threshold`, `not_a_trigger`, `unknown_countermeasure`, `unknown_step`, `duplicate_step`, `required_steps_pending`, `time_reversed` or `unit_mismatch`. A TICK rejected for `unit_mismatch` therefore keeps none of the observations listed before the bad one. Every accepted transition appends `{t, event, from, to, detail, error: null}` to `log`. A TICK outside `watch`, or a TICK that adds no tripwire observation, returns the state unchanged with no log entry. A malformed `state` (not built by `new_case`/`case_reduce`, including a state without `steps_declined`, `escalation`, `packet_queued_at` or the four spec step lists) is a contract violation and raises `invalid_argument`. **STEP** (from `acting`; checks in order `unknown_step`, `duplicate_step` if already done): if the step declares an input and the event's `input` has a `unit` that differs, `unit_mismatch`; a red-flag step needs `input.value` true/false or 1/0 (else `invalid_event`); a required step with an input needs a number (yes/no for unit `yes/no`; else `invalid_event`). A red-flag "yes" → `escalated` at once. A packet step sets `packet_queued_at` (if still null). **DECLINE** (from `acting`): `unknown_step`, then `duplicate_step` if the step is already done or declined, then a non-empty `reason` (else `invalid_event`); it appends `{step_id, t, reason}` to `steps_declined` and stays `acting`. A declined step may still be done later. **OUTCOME** (from `acting`): `required_steps_pending` while any required step is neither done nor declined (the detail lists them), then a non-empty `text`; it arms the tripwire. **Escalation** (red-flag "yes" or a tripped tripwire) sets `escalation = {t, reason: "red_flag" \| "tripwire", step_id (the red-flag step or null), tiers: ["crew_medical_officer", "flight_surgeon"]}`, sets `packet_queued_at` to `t` if it is still null, and closes the case (`closed_at`). The reducer does not know the link: the UI reads `comms_eta` for when tier 2 receives the packet. Details are plain language: MET by `format_met` ("reassess at MET 415/14:25:00"), tripwire counts as "2 of the last 3 readings at or above 1000 pfu (escalates at 2 of 3)" (a count prints its bare number), and escalation as "escalated: tier 1, the Crew Medical Officer, now; tier 2, the flight surgeon, through the ground packet, queued and sent when a link exists". Tripwire: the reducer keeps the condition variable's observations with `watch_started_at < obs.t ≤ t`, deduplicated by `t` and sorted by `t`. These are observations of this crew, plus observations whose `crew_id` is null or absent, which are vehicle or habitat sensors such as the proton monitor and are shared by every crewmember. The tripwire is judged only at `t ≥ reassess_at` (OUTCOME `t` + `reassess_after_s`), matching the case texts "Reassess at T+72 h; if … still …". At or after that time the case is `escalated` if at least `at_least` of the last `of_last_n` meet the condition. It is `resolved` once even all-missing slots counted as hits could not reach `at_least`. Otherwise it stays in `watch` and is judged again at each later TICK. |
| `build_ground_packet(case_state, observations, consent, env_id, t, mission_epoch)` | A FHIR R4 `Bundle` (type `collection`) of `Observation`s. It holds this crew's observations, plus vehicle observations (`crew_id` null or absent, tagged `scope-vehicle` and placed in this crewmember's packet as exposure context), with `obs.t ≤ t` whose variable is in `case_state.spec.escalation.observations` (when that list exists), and only if consent allows it. `mood` (and any variable in `PRIVATE_VARIABLES`) needs `consent[var] === true`. Any other variable is shared unless `consent[var] === false`. Vital signs use the LOINC codes of the FHIR R4 vital-signs profile, with the vitalsigns profile and the `vital-signs` category. Anything else uses a local `CodeSystem` `https://landfall.dev/fhir/CodeSystem/landfall`. No invented LOINC codes. `mission_epoch` is the UTC `YYYY-MM-DDTHH:MM:SSZ` of MET 0, and turns MET into `effectiveDateTime`. Units go to UCUM codes, and an unmapped unit raises `unknown_unit`. Unit `yes/no` becomes `valueBoolean`, and unit `MET` becomes `valueDateTime`. Entries are sorted by `(t, variable)`. `subject` is a logical reference `{type: "Patient", identifier, display}`, with no Patient resource, because the vital-signs profile requires `Reference(Patient)`. Resource ids are `{crew}-{variable}-{floor(t)}` with `_` turned into `-`. On a collision the id gets the suffix `-2`, `-3`, …, and the base is truncated so the id stays at most 64 characters. The packet's state (Prepared or Queued) is the case state's `packet_queued_at`, not a bundle field. |
| `comms_eta(env, t, comms_table?)` | `{one_way_s, round_trip_s, blocked, reason, resumes_at, earliest_reply_s, light_time_source}`. `env` is an environment object. `round_trip_s = 2·one_way_s`. Without a table, `one_way_s` is the environment's `max`. With `from_snapshot`, the light time comes from `comms_table = {samples: [{t, one_way_s}], conjunction_windows: [{start, end, reason}]}` in MET seconds, linearly interpolated and clamped at the ends. `blocked` is true when `conjunction` is true and `start ≤ t < end`. Touching or overlapping windows chain, and `resumes_at` is the end of the chain. `earliest_reply_s = (resumes_at − t) + round trip at resumes_at`, assuming zero ground time. |
| `format_met(seconds)` | `"d/hh:mm:ss"` (F.6.1 f: no leading zeros in the day field; hours, minutes and seconds keep two digits). Day 0 starts at MET 0. Input is floored. The day field is never truncated (`10000/…`). Negative input prints as `-d/…` (`-0/00:00:05`). The same format serves durations (`11/05:59:51`). |
| `fmt_num(x, dp=3)` · `met_to_iso(t, mission_epoch)` | Formatting helpers used inside every `why`/`detail` string. |

**Determinism rules for the port.** The TS port must follow these so that results match:

- Sum left to right in a plain loop. Python 3.12's `sum()` is compensated, so the engine does not use it.
- Square as `d*d`, never `pow`.
- The only transcendental functions are `sqrt` (exact in both languages) and, in the t distribution
  only, `lgamma`, `log` and `exp`. Those three can differ in the last bit between Python's libm and
  a JS engine, so `t_cdf` results agree within the tolerance rather than bit for bit. Bisection
  results (`t_quantile`, `t_critical`) and everything built on them (`rci`, `evaluate_personal`,
  `min_detectable_change`) are identical for every df the engine uses and in every vector; at very
  large df they agree within the tolerance only (see `t_quantile`).
- Evaluate expressions in the order written in `engine/*.py`.
- Sort strings by code point. All ids are ASCII.
- `fmt_num` rounds half away from zero with integer arithmetic. Compute `k = floor(|x|·10^dp + 0.5)`, then print `k div 10^dp`, and `k mod 10^dp` with its trailing zeros stripped. Do not use `toFixed` or `String(x)`. It rejects |x| ≥ 1e15 and `|x|·10^dp + 0.5 ≥ 2^53`, so `k` stays an exact integer in a double. Without that guard, JS `(k − k mod 10^dp) / 10^dp` can lose digits that Python's integer arithmetic keeps.
- `format_met` floors to an exact integer (Python int, JS BigInt), so it prints every digit at any magnitude.
- `met_to_iso` uses POSIX seconds with no leap seconds, like JS `Date`. Print it without milliseconds. It rejects results outside the years 0001–9999 (`invalid_argument`). JS `Date` would print `+010000-…` instead, so the port must check the year.

## 6. Conformance vectors

`engine/tests/vectors/<fn>.json` (one file per function above, including `new_case`, `fmt_num`,
`met_to_iso`, `min_detectable_change`, `t_cdf`, `t_quantile` and `t_critical`: 16 files) hold arrays of
`{"name", "fn", "args", "expect"}`. A call that must fail is written `{"name", "fn", "args", "raises": "<error code>"}`
instead. `args` uses the argument names of section 5. A function that returns a scalar has that
scalar as `expect`. JSON has no NaN or infinity, so an argument that must be non-finite is written
`{"$float": "NaN"}`, `{"$float": "Infinity"}` or `{"$float": "-Infinity"}`; both harnesses decode
these objects (at any depth of `args`) before the call. Results never contain them, because the
engine never returns a non-finite number. Fixtures come from
`engine/tests/fixtures/engine_fixtures.json` and are labeled as fixtures; the gated procedure (required,
red-flag and packet steps) is built from the fixture case in `engine/vectors.py`. The Python suite
generates the vectors, replays every one, and asserts that the committed files equal a fresh
regeneration. The TypeScript suite (`web/src/engine/*.test.ts`) loads the same files and must
agree. Numbers match with float tolerance `1e-9` (`1e-8` for `t_quantile` and `t_critical` at df
above 1e5, section 5; every current vector meets `1e-9`), strings match exactly, and `raises`
matches the error code. Regenerate the vectors with `uv run python -m engine.vectors`, and verify them with
`uv run python -m engine.vectors --check`.

`engine/tests/vectors_random/random_<fn>.json` hold seeded randomized vectors (valid and invalid
inputs) for every function. Their inputs are frozen; `uv run python -m engine.vectors --random`
recomputes their expectations with the current engine (and draws the seeded inputs of a function
that has no file yet), and `--check` covers them too. Frozen case states predating the required-step,
escalation and packet fields are migrated with the values of a case that has none (empty step lists,
`steps_declined: []`, `escalation` and `packet_queued_at` null).

## 7. Demo scenario (simulated, seeded, labeled)

- Four crewmembers. The simulated data runs from MET day 368 to day 412, with baseline days
  368–381. "Now" is MET `412/14:20:00`.
- **Renal** (CM-3): 24-h urine output falls below the case target on MET days 398–401, while fluid
  intake falls as well. Tier A (`target_urine_output_24h`) catches it on each of those days.
- **Sleep** (CM-1): after a schedule shift on MET day 403, sleep shortens, the sleep midpoint
  shifts, and PVT-B lapses rise.
- **Manual vitals**: cuff blood pressure and fingerstick glucose for every crewmember, daily on the 14
  baseline days (so the personal baseline has n = 14), then twice a week. No episode is scripted on them.
- **Tier B and the noise.** The day-to-day noise is calibrated by the generator (`ingest/_sim_model.py`)
  to cited literature values where they exist, else labelled a design choice. What Tier B then detects
  is not decided by hand: the generator runs the same single-case test on the shipped points and
  publishes it in `sim_crew.json` → `data.self_check.tier_b` (baseline n, mean, SD and `mdc` per
  crewmember and indicator; the flagged days of each scripted episode, with the per-day detection
  probability under the noise model; and every chance flag). `engine/tests/test_scenario_tier_b.py` and
  `web/src/engine/scenario.test.ts` evaluate every indicator of every crewmember on every day after the
  baseline and require the engine to agree with that report exactly (same baselines, same minimum
  detectable changes, same flagged episode days, the same chance flags, no other caution). Episodes the
  noise hides from Tier B are caught only by Tier A: CM-3's urine output below 1,500 mL (`TARGET`),
  CM-2's VO₂max (`FFD`) and the solar particle event (`OPS`). Chance flags are real consequences of
  real-size noise and open cases like any other caution.
- **FFD demo** (CM-2): VO₂max 35.1 ml/min/kg. This is *within* the microgravity EVA floor (32.9)
  and *outside* the surface EVA floor (36.5). The environment selector flips the verdict; outside it is a
  Caution labelled "EVA assignment not cleared", never a Warning.
- **SPE (the hero)**: MET day 412, during a Mars solar conjunction window **modelled** from JPL
  Horizons geometry (`horizons_mars_comms`), its edges fitted to NASA's published command moratoria
  (RMS 0.79 d). A real historical proton event, GOES-7 October 1989, is replayed time-shifted as the
  reading of the Mars-orbit space-weather monitor (no radial-distance or atmospheric correction). Houston
  is unreachable. The vehicle's radiation monitoring system raises the alarm; LANDFALL opens
  `spe_shelter` for every crewmember as a Warning and guides the crew with the Crew Medical Officer, and
  the ground packet waits for the link. The shelter confirmations `p2` and `p3` must be done or declined
  before an outcome arms the T+6 h tripwire.
- Seeded crew actions must satisfy the reducer like any user: a scripted OUTCOME of the renal case needs
  `r4` answered first (the scripted crew answers "no": `STEP r4` with `input {variable: "renal_symptoms",
  value: false, unit: "yes/no"}`), or the engine rejects it with `required_steps_pending`.
- Mood is simulated for every crewmember, never alerts, and is private by default.
