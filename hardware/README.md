# LANDFALL BAND (hardware concept)

A wrist-worn sensor band for exploration crews, designed at block level from hardware that has flown.
It answers the challenge's "gathers health indicators" verb, and one question the statement asks directly:
*which measurements can be performed in space?*

**Status: concept.** No schematic capture, no PCB, never built, never bench-tested. KiCad was not available
during the hackathon, so the plan's pre-agreed fallback is the deliverable: an annotated block diagram and a
reference bill of materials. Every current, rate and size is a design estimate unless its chip says otherwise.

## Files

| File | What it is |
|---|---|
| `sensor-map.json` | **The single source of truth.** Blocks, buses, the three labels of every block, the NOT MEASURABLE HERE boundary, power and log arithmetic, declared negatives, safety constraints, open items. |
| `sensor-map.md` | Human-readable version, **generated** from the JSON. Do not edit by hand. |
| `BOM.csv` | Bill of materials (part, qty, manufacturer, function, interface, block id, case served), **generated** from the JSON. |
| `generate.mjs` | Regenerates the two files above: `node hardware/generate.mjs` from the repo root (Node 23.6 or later, which strips TypeScript types). |

The web app renders the same JSON at `#/band` (`web/src/features/band/`): an SVG block diagram with SPI, I2C,
QSPI and BLE buses, the power domain, and the NOT MEASURABLE HERE zone drawn outside the device boundary.
Select any block for its three labels, with chips and citations. The JSON is bundled at build time, so the
view makes no request at runtime.

## The rule every block follows

Each block carries three labels:

- **(a)** the indicator it produces, using the SPEC 3.3 variable ids (`resting_hr`, `hrv_sdnn`, `skin_temp`,
  `sleep_duration`, `sleep_midpoint_shift`, `light_exposure_daytime`);
- **(b)** the LANDFALL rule, personal baseline or case it feeds (ids from `engine/rules/`);
- **(c)** the NASA requirement that justifies or constrains it, with its relation spelled out:
  *requires*, *constrains*, *pattern borrowed* (written for another system, usually the suit),
  *assigns elsewhere*, or *NASA names it* (a NASA page, not a requirement).

The fourth kind of block is the point of the drawing: **NOT MEASURABLE HERE**, the hand-off boundary. Urine
output goes to manual entry. Radiation dose goes to the vehicle radiation monitoring system (`[V2 6164]`; the ISS
TEPC and the CSA CANS neutron spectrometer are real examples). Blood chemistry and urinary calcium go to the lab,
cuff blood pressure to the vehicle medical kit, VO2max to the exercise system, bone density to ground DXA, cabin
ppCO2 to the atmosphere monitor, and circadian phase and corneal light to research protocols and the lighting
system. It is the same discipline as the software: the band measures what a wearable can measure, and
everything else arrives through a documented interface.

## Parts

| Block | Part | Role |
|---|---|---|
| ECG AFE | MAX30003 (Analog Devices) | single-lead ECG, on-chip R-R detection, 256 sps |
| PPG / SpO2 AFE | MAX86141 (Analog Devices) | pulse and SpO2 spot windows, 64 Hz while active |
| Spectral light | AS7341 (ams OSRAM) | 11-channel sensor: daytime light exposure |
| Skin temperature | MAX30208 x2 (Analog Devices) | two skin sites at 1 Hz; also the skin-side safety monitor |
| IMU | LSM6DSOX (STMicroelectronics) | accelerometer at 52 Hz for actigraphy and off-wrist detection |
| MCU + radio | nRF52840 (Nordic) | one clock for every channel, epoch records, encrypted BLE |
| Log | W25Q128JV (Winbond) | 16 MiB NOR flash, 34.5 days of indicators without a sync |
| Power | 200 mAh LiPo, MCP73831 charger, MAX17048 gauge | 0.74 Wh, inside the JSC-20793 Rev D Non-Critical class (< 4 Wh, <= 1000 mAh) |

Sample rates marked *derived · flown hardware* reuse the channel rates of the CSA Bio-Monitor (Hexoskin
Astroskin), on the ISS since 2018. That channel table was transcribed in project preparation from the product's
datatype registry and is not frozen in this build.

## What NASA does not publish (declared, not hidden)

- **No minimum sensor set** for exploration missions. The ExMC Mars medical ConOps (NTRS 20200001715) assumes
  "All crewmembers are wearing biosensors" and gives no sensor list, rate or specification. This is the gap the
  band fills.
- **No EMI/EMC requirement** in NASA-STD-3001 Vol 2 Rev F; the only electromagnetic requirement is RF exposure,
  `[V2 6102]`.
- **No skin-contact biocompatibility requirement**; the nearest are `[V2 7076]` and `[V2 7081]`.
- **No battery-endurance, storage or log-duration requirement** for wearables. The 72 h autonomy target (one
  whole case tripwire window) and the 14-day log target (one whole RCI baseline window) are design choices.

Every Vol 1 and Vol 2 quote, and every negative, is checked against the frozen snapshots in
`web/public/data/` by `web/src/features/band/band.test.ts`. JSC-20793 and NASA-STD-6001B were read in project
preparation and are not frozen in this build; the JSON says so wherever they are cited.

## Checking

```bash
node hardware/generate.mjs                                  # regenerate sensor-map.md and BOM.csv
cd web && npx vitest run src/features/band                  # sync, ids, verbatim quotes, arithmetic
```

The test fails if the generated files drift from the JSON, if an indicator, rule or case id does not exist in
`engine/rules/`, if a quote is not verbatim in its snapshot, or if any sum in the power and log arithmetic is off.

## Open items

Listed in `sensor-map.json` (`open_items`) and on the page. The ones a reviewer will find first: battery
monitoring does not yet meet JSC-20793 section 4.4.3 (the MCP73831 has no thermistor input, and the MAX17048
measures neither current nor temperature); there is no power switch or status light for `[V2 9017]` / `[V2 9018]`;
the power tree is not designed; and every current in the budget is a datasheet-typical estimate.
