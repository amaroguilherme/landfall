# LANDFALL BAND (hardware concept)

A wrist-worn sensor band for exploration crews, designed at block level. It answers the challenge's "gathers health
indicators" verb, and one question the statement asks directly: *which measurements can be performed in space?*

**Status: concept.** No schematic capture, no PCB, never built, never bench-tested. KiCad was not available during
the hackathon, so the deliverable is an annotated block diagram and a reference bill of materials. Every current, rate
and size is a design estimate unless its chip says otherwise.

## Files

| File | What it is |
|---|---|
| `sensor-map.json` | **The single source of truth.** Blocks, buses, the three labels of every block, each part's datasheet and whether it was read, the published basis behind each design decision, the NOT MEASURABLE HERE boundary, power and log arithmetic, declared negatives, safety constraints, open items and build notes. |
| `sensor-map.md` | Human-readable version, **generated** from the JSON. Do not edit by hand. |
| `BOM.csv` | Bill of materials (part, qty, manufacturer, function, interface, block id, case served, datasheet URL, datasheet read or not), **generated** from the JSON. |
| `generate.mjs` | Regenerates the two files above: `node hardware/generate.mjs` from the repo root (Node 23.6 or later, which strips TypeScript types). |

The web app renders the same JSON at `#/band` (`web/src/features/band/`): an SVG block diagram with SPI, I2C,
QSPI and BLE buses, the power domain, and the NOT MEASURABLE HERE zone drawn outside the device boundary.
Select any block for its three labels, with chips and citations. The JSON is bundled at build time, so the
view makes no request at runtime.

## Heart signals: one continuous, one on demand

An ECG needs a lead across the heart. Two electrodes on the inner face of one wrist band have none, so the band
cannot take heart rate or heart-rate variability from an ECG while it is simply worn. The design splits the job:

- **Continuous: the optical pulse (PPG, MAX86141).** The infrared pulse channel runs around the clock at 64 Hz. Its
  pulse inter-beat intervals give 1-min heart rate and, in sleep, `resting_hr` and `hrv_sdnn`. Variability computed
  from pulse intervals is **pulse-rate variability (PRV), an approximation of HRV**: a review of PPG-against-ECG
  studies found it accurate enough at rest, with short-term variability "somewhat overestimated", and agreement
  impaired by physical activity and some mental stressors (Schäfer & Vagedes, Int J Cardiol 2013, PMID 22809539).
  So the band computes it only in low-motion sleep, and Tier B compares it only with the crewmember's own PRV
  baseline.
- **On demand: a single-lead ECG spot check (MAX30003).** One electrode on the inner face rests on the wrist; a
  second on the outer face is touched by a finger of the other hand, which closes an arm-to-arm lead across the
  chest, like limb lead I, for a 30-s strip. An FDA-authorized watch ECG uses the same arrangement (De Novo DEN180044:
  electrodes on the back touch the wrist, a finger touches the crown, 30 s, "similar to a Lead I ECG").
  `[V1 3004](i)` asks for electrocardiography "as needed". No LANDFALL rule reads the strip and nothing classifies
  its rhythm; showing it to the Crew Medical Officer is an open item.

The flown reference, the CSA Bio-Monitor (Hexoskin Astroskin), is a shirt with a 3-lead ECG built in. The band
borrows its sample rates (ECG 256 Hz, PPG 64 Hz, SpO2 1 Hz, skin temperature 1 Hz, HRV windows of 300 s), not its
electrode layout.

## The rule every block follows

Each block carries three labels:

- **(a)** the indicator it produces, using the SPEC 3.3 variable ids (`resting_hr`, `hrv_sdnn`, `skin_temp`,
  `sleep_duration`, `sleep_midpoint_shift`, `light_exposure_daytime`), or a variable no rule reads (`heart_rate`
  1-min means, `spo2`, the ECG strip, band battery);
- **(b)** the LANDFALL rule, personal baseline or case it feeds (ids from `engine/rules/`);
- **(c)** the NASA requirement that justifies or constrains it, with its relation spelled out:
  *requires*, *constrains*, *pattern borrowed* (written for another system, usually the suit),
  *assigns elsewhere*, or *NASA names it* (a NASA page, not a requirement).

A block can also list a **published basis** outside NASA-STD-3001 (a review, a regulatory summary, a NASA concept of
operations), with its chip, a verbatim quote and the date it was read.

The fourth kind of block is the point of the drawing: **NOT MEASURABLE HERE**, the hand-off boundary. Urine output
and fluid intake go to manual entry. Radiation goes to two systems outside the band: the vehicle radiation monitoring
system raises the alarm and reports dose rate (`[V2 6164]`), and the space weather outside the vehicle, proton flux
spectra included, takes an external space-weather monitor (`[V2 6165]`, whose rationale names the October 1989 storms
the SPE case replays). The scenario's monitor in Mars orbit reports one ≥10 MeV integral channel, not the spectra.
LANDFALL is not the radiation alarm; it opens the health case that follows. Blood pressure and blood glucose are measured with the
vehicle medical kit (a cuff and a fingerstick glucometer) and entered by hand. Blood chemistry and urinary calcium go
to the lab, VO2max to the exercise system, bone density to ground DXA, cabin ppCO2 to the atmosphere monitor, and
circadian phase and corneal light to research protocols and the lighting system. It is the same discipline as the
software: the band measures what a wearable can measure, and everything else arrives through a documented interface.

## Parts

| Block | Part | Role | Datasheet |
|---|---|---|---|
| PPG / SpO2 AFE | MAX86141 (Analog Devices) | the heart-rate source: continuous infrared pulse channel at 64 Hz (pulse intervals, PRV in sleep); SpO2 spot windows | not retrieved |
| ECG AFE | MAX30003 (Analog Devices) | single-lead ECG spot check at 256 sps, closed by a finger of the other hand on the outer electrode; powered down between checks | not retrieved |
| Spectral light | AS7341 (ams OSRAM) | 11-channel sensor (8 visible, Clear, Flicker, NIR): daytime light exposure | read |
| Skin temperature | MAX30208 x2 (Analog Devices) | two skin sites at 1 Hz; also the skin-side safety monitor | not retrieved |
| IMU | LSM6DSOX (STMicroelectronics) | accelerometer at 52 Hz (design target) for actigraphy, the motion flag that gates pulse intervals, and off-wrist detection | not retrieved |
| MCU + radio | nRF52840 (Nordic) | 64 MHz Cortex-M4 with FPU, Bluetooth LE: one clock for every channel, pulse peak detection, epoch records | read (product page) |
| Log | W25Q128JV (Winbond) | 128M-bit / 16M-byte flash: 34.5 days of indicators without a sync, plus 182 raw 30-s ECG strips | read |
| Power | 200 mAh LiPo, MCP73831 charger, MAX17048 gauge | 0.74 Wh, inside the JSC-20793 Rev D Non-Critical class (< 4 Wh, <= 1000 mAh); 116 h estimated autonomy against a 72 h target | MCP73831 read; MAX17048 not retrieved; no cell selected |

Manufacturer claims are stated only where the manufacturer's own page or datasheet was read for this build
(2026-11-14). The datasheets of five parts could not be retrieved, so no manufacturer claim is quoted for them; what
the design assumes of each part is an open item, and `sensor-map.json` lists their datasheet URLs
(`blocks[].datasheet`) for a reviewer.

Sample rates marked *derived · flown hardware* reuse the channel rates of the CSA Bio-Monitor (Hexoskin Astroskin),
flown on the ISS. Its channel table, pitfalls and recorder facts were read on 2026-11-14 in public sources: Hexoskin's
API documentation (datatype registry and data resource) and product page, NASA's ISS Daily Summary Report of
2019-02-28, and NTRS 20190001996 (HERA Campaign 3). None of them is frozen in this build.

## What NASA-STD-3001 does not publish (declared, not hidden)

- **No wearable or biosensor requirement** in NASA-STD-3001 Vol 2 Rev F (a search of all 398 pages finds none). The
  ExMC Mars medical ConOps (NTRS 20200001715, HRP-48021) assumes "All crewmembers are wearing biosensors" and
  specifies none: no sensor list, rate or performance. NASA's Spaceflight Standard Measures is a research study, not
  an operational sensor specification. This is the gap the band fills.
- **No EMI/EMC requirement** in Vol 2 Rev F; the only electromagnetic requirement is RF exposure, `[V2 6102]`.
- **No skin-contact biocompatibility requirement** in Vol 2 Rev F; the nearest are `[V2 7076]` and `[V2 7081]`.
- **No battery-endurance, storage-capacity, retention or log-duration requirement** for wearables in Vol 2 Rev F. The
  72 h autonomy target (one whole case tripwire window) and the 14-day log target (one whole Tier B baseline window)
  are design choices.
- **No numeric in-flight alert thresholds for crew physiology (vital signs):** NASA-STD-3001's alert requirements leave
  the alert point to the program, so LANDFALL has no SpO2, blood pressure or glucose limit. Blood pressure and glucose are compared only
  with the crewmember's own baseline (Tier B, caution at most).

Every Vol 1 and Vol 2 quote, and every negative, is checked against the frozen snapshots in `web/public/data/` by
`web/src/features/band/band.test.ts`. JSC-20793 Rev D (NTRS 20170009182) and NASA-STD-6001B w/Change 3 are public
NASA documents that are not frozen in this build; the JSON links them and gives the date their numbers were checked.
The indicator-light table (`[V2 10201]`, Table 10.4-3, p. 214) and `[V2 10022]` (p. 200) are not in the frozen
snapshot either: the JSON paraphrases them and links the PDF.

## Checking

```bash
node hardware/generate.mjs                                  # regenerate sensor-map.md and BOM.csv
cd web && npx vitest run src/features/band                  # sync, ids, verbatim quotes, arithmetic, physics
```

The test fails if the generated files drift from the JSON, if an indicator, rule or case id does not exist in
`engine/rules/`, if a scenario variable the simulation attributes to the band has no producing block, if a quote is
not verbatim in its snapshot, if any sum in the power and log arithmetic is off, if the ECG feeds an indicator, or if
judge-facing text cites process notes instead of sources.

## Open items

Listed in `sensor-map.json` (`open_items`) and on the page. The ones a reviewer will find first: battery
monitoring is treated as not meeting JSC-20793 section 4.4.3 (the MCP73831 has no thermistor input, verified on its
datasheet, and what the MAX17048 measures is not verified in this build); five datasheets still need reading; PRV has
not been compared with ECG SDNN on this hardware; LANDFALL has no viewer for the ECG strip; the power switch and
status light for `[V2 9017]` / `[V2 9018]` are specified but have no parts (the light shows the band's state, never a
health value); the power tree is not designed; and every current in the budget is an estimate, never measured.

Electrical safety: the band touches intact skin, read as **External** body contact in `[V2 9023]` Table 9.3-11
(DC to 1 kHz: 0.1 mA normal, 0.5 mA single fault, summed over all leakage paths). The two ECG electrodes are the only
conductive contacts, and a path across the chest exists only while the other hand closes the circuit during a spot
check; the table's footnote on prolonged DC contact still applies to the wrist electrode, which is worn around the
clock. `[V2 9019]`-`[V2 9021]` are the general body-current limits for any equipment. `[V2 11034]`-`[V2 11036]` are
suit-atmosphere requirements (suit pressure, ppO2, ppCO2), not biomedical ones, so the band does not cite them.

How this build checked its sources (which pages answered, what was re-read and corrected) is in `build_notes`,
shown collapsed at the end of `#/band`.
