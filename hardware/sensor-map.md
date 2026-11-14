# LANDFALL BAND: sensor map

> Generated from `sensor-map.json` by `node hardware/generate.mjs`. Do not edit by hand: edit the JSON and
> regenerate. `web/src/features/band/band.test.ts` fails when this file and the JSON disagree.

**Wearable sensing concept: annotated block diagram and reference bill of materials.** Block-level concept. No schematic capture, no PCB, never built, never bench-tested. Every current, rate and size here is a design estimate unless its chip says otherwise. KiCad was not available during the hackathon, so the plan's pre-agreed fallback (annotated block diagram plus BOM) is the deliverable.

The band measures what a wearable can measure. Everything else reaches LANDFALL through a documented interface, drawn as NOT MEASURABLE HERE. It is the same discipline as the software: no number without a source, no measurement without a sensor.

**The gap.** NASA publishes no minimum sensor set for exploration missions. The ExMC medical system concept of operations for Mars assumes the crew wears biosensors and defines a Crew Health and Performance Data System, but gives no sensor list, no sampling rates and no specifications. Seven distinct NTRS API queries found nothing that does. The band is one concrete, citable answer to a question NASA has left open. Quote: "All crewmembers are wearing biosensors" (NASA Exploration Medical Capability. Medical System Concept of Operations for Mars Exploration Mission-11, NTRS 20200001715, https://ntrs.nasa.gov/citations/20200001715).

## Blocks and their three labels

Every block carries three labels: (a) the indicator it produces, (b) the LANDFALL rule, baseline or case it feeds, and (c) the NASA requirement that justifies or constrains it.

| Block | Part | (a) Indicator produced | (b) LANDFALL rule / baseline / case fed | (c) NASA requirement |
|---|---|---|---|---|
| `ecg` ECG AFE | MAX30003 | `resting_hr`, `hrv_sdnn` | indicator resting_hr (reliable change vs own baseline); indicator hrv_sdnn (reliable change vs own baseline); case sleep_circadian (ground packet); case renal_stone (ground packet (resting HR)) | `[V1 3004](h)` requires; `[V2 11023]` pattern borrowed; `[V2 9023]` constrains |
| `ppg` PPG / SpO2 AFE | MAX86141 | `spo2`, `resting_hr` | indicator resting_hr (backup source only); no rule: NASA publishes no in-flight SpO2 limit, and LANDFALL does not invent one | `[V1 3004](h)` requires; `[V2 9103]` constrains |
| `light` Spectral light sensor | AS7341 | `light_exposure_daytime` | indicator light_exposure_daytime (context only, never alerts); case sleep_circadian (ground packet; closes the loop from sensor to the lighting countermeasure) | `Standard Measures` NASA names it; `[V2 8055]` pattern borrowed |
| `temp` Skin temperature, 2 sites | MAX30208 x2 | `skin_temp` | indicator skin_temp (context only, never alerts); case renal_stone (ground packet) | `[V1 3004](h)` requires; `[V2 9102]` constrains |
| `imu` IMU (actigraphy) | LSM6DSOX | `sleep_duration`, `sleep_midpoint_shift` | indicator sleep_duration (reliable change vs own baseline); indicator sleep_midpoint_shift (reliable change vs own baseline); case sleep_circadian (trigger (2 of its 4 triggers)) | `Standard Measures` NASA names it; `[V1 3004](h)` requires |
| `mcu` MCU + BLE radio | nRF52840 | (none: see notes) | app landfall_app (every band observation (source: band)) | `[V2 10125]` requires; `[V2 10130]` requires |
| `flash` Local log, 16 MiB | W25Q128JV | (none: see notes) | indicator all personal indicators (keeps one whole 14-day RCI baseline window on the band) | `[V2 10129]` requires; `[V2 6001]` pattern borrowed |
| `battery` LiPo cell 200 mAh | LiPo cell, 1S, 200 mAh | (none: see notes) | (none) | `JSC-20793 Rev D` constrains |
| `charger` Charger | MCP73831 | (none: see notes) | (none) | `JSC-20793 Rev D` constrains |
| `gauge` Fuel gauge | MAX17048 | `band_battery_soc` | (none) | `JSC-20793 Rev D` constrains |

Relations: **requires** = requires this function; **constrains** = limits how this block may be built; **pattern borrowed** = written for another system; the band borrows the pattern and does not claim compliance; **assigns elsewhere** = assigns this measurement or alert to another system; **NASA names it** = NASA page that names the measurement (not a requirement).

## Block details

### `ecg` ECG AFE: MAX30003 (Analog Devices (Maxim Integrated))

Single-lead ECG biopotential front end with an on-chip R-to-R interval detector, read over two dry electrodes on the inner face of the band.

- Interface: SPI
- Manufacturer spec (not a LANDFALL constant): Single-lead biopotential AFE; Built-in R-to-R detection; 18-bit ECG samples
- Rate, ECG: `256 sps` (chip: derived, flown hardware). Bio-Monitor ECG 256 Hz, kept at 256 sps
- Rate, HRV window: `300 s` (chip: derived, flown hardware). Bio-Monitor HRV over 300 s, kept at 300 s (5-min windows)

(a) Produces:
- `resting_hr` Resting heart rate [bpm]: lowest stable 5-min heart rate in the main sleep period, from R-R intervals
- `hrv_sdnn` Heart rate variability (SDNN) [ms]: SDNN of normal-to-normal intervals over 5-min windows in sleep

(b) Feeds:
- indicator resting_hr (reliable change vs own baseline)
- indicator hrv_sdnn (reliable change vs own baseline)
- case sleep_circadian (ground packet)
- case renal_stone (ground packet (resting HR))

(c) Justified or constrained by:
- `[V1 3004](h)` (requires; frozen in `std_vol1_requirements`): "Assessing, recording, monitoring, and trending vital signs and additional physiological and behavioral health signs."
- `[V2 11023]` (pattern borrowed; frozen in `std_vol2_requirements`): "Derived body core temperature and heart rhythm (real-time) are desired for microgravity operations" From the rationale; written for suits.
- `[V2 9023]` (constrains; frozen in `std_vol2_requirements`): "For equipment such as bioinstrumentation and medical devices, that are specifically designed to contact the human body, electrical leakage currents caused by contact with exposed surfaces (including in worst-case fault scenarios) shall be kept below the levels specified in Table 9.3-11"
  - Leakage, external contact, DC to 1 kHz, normal: `0.1 mA` (chip: NASA-published, Table 9.3-11)
  - Leakage, external contact, DC to 1 kHz, single fault: `0.5 mA` (chip: NASA-published, Table 9.3-11)

Design notes:
- R-R intervals, not waveforms, are logged: the whole flash would hold only about 6 h of raw ECG (see the log arithmetic).
- The band does not estimate blood pressure from ECG-to-PPG transit time (see the Bio-Monitor pitfalls).

### `ppg` PPG / SpO2 AFE: MAX86141 (Analog Devices (Maxim Integrated))

Optical front end: drives red and infrared LEDs and reads the photodiode for pulse and SpO2 spot windows.

- Interface: SPI
- Manufacturer spec (not a LANDFALL constant): Optical pulse-oximetry and heart-rate AFE; LED drivers and photodiode readout on chip
- Rate, PPG while active: `64 Hz` (chip: derived, flown hardware). Bio-Monitor PPG 64 Hz, kept at 64 Hz
- Rate, SpO2 output: `1 Hz` (chip: derived, flown hardware). Bio-Monitor SpO2 1 Hz, kept at 1 Hz
- Rate, Spot window: `60 s every 10 min` (chip: design choice). LED current dominates the power budget; ECG already gives heart rate, so the optical channel runs in windows (10 % duty).

(a) Produces:
- `spo2` SpO2 (spot windows) [%]: recorded and shown as context; no LANDFALL rule uses it (not a SPEC 3.3 indicator)
- `resting_hr` Pulse rate (backup) [bpm]: backup source for resting heart rate when ECG electrode contact is lost

(b) Feeds:
- indicator resting_hr (backup source only)
- no rule: NASA publishes no in-flight SpO2 limit, and LANDFALL does not invent one

(c) Justified or constrained by:
- `[V1 3004](h)` (requires; frozen in `std_vol1_requirements`): "Assessing, recording, monitoring, and trending vital signs and additional physiological and behavioral health signs."
- `[V2 9103]` (constrains; frozen in `std_vol2_requirements`): "Any surface to which the bare skin of the crew is exposed shall not cause skin temperature to enter the range for pain/injury in Table 9.3-5"
  - Pain range starts at: `43 °C` (chip: NASA-published, Table 9.3-5)
  - LED cut-off at skin-side sensor: `41 °C` (chip: design choice) 2 °C below the start of the Table 9.3-5 pain range; read from the skin temperature sensors.

Design notes:
- Each sample is timestamped at acquisition on the MCU clock and the AFE's fixed pipeline delay is written in the log header, never assumed to be zero (see the Nonin 172 ms pitfall).

### `light` Spectral light sensor: AS7341 (ams OSRAM)

11-channel spectral sensor on the outer face: synthesises photopic lux plus red, green and blue bands for daytime light exposure.

- Interface: I2C-A
- Manufacturer spec (not a LANDFALL constant): 11 channels: 8 visible bands, clear, near-IR, flicker
- Rate, Reading: `60 s epoch` (chip: design choice). One reading per 1-min epoch, the epoch length of research wrist actigraphs (Actiwatch Spectrum, per the project plan).

(a) Produces:
- `light_exposure_daytime` Daytime light exposure (wrist) [lux]: mean photopic illuminance at the wrist during the scheduled wake period

(b) Feeds:
- indicator light_exposure_daytime (context only, never alerts)
- case sleep_circadian (ground packet; closes the loop from sensor to the lighting countermeasure)

(c) Justified or constrained by:
- `Standard Measures` (NASA names it; frozen in `hrp_research`): "measurements of activity and light exposure (gathered through a wrist sensor)"
- `[V2 8055]` (pattern borrowed; frozen in `std_vol2_requirements`): "The system shall provide the levels of light to support the physiological effects of light in accordance with Table 8.7-2" Table 8.7-2 is specified as melanopic EDI at the cornea, for the lighting system. A wrist reading is not that quantity, so it is context and never a compliance check.
  - General ambient, melanopic EDI at cornea: `250 lux (min)` (chip: NASA-published, Table 8.7-2)
  - Crew pre-sleep, melanopic EDI at cornea: `8 ± 2 lux` (chip: NASA-published, Table 8.7-2)

Design notes:
- Nobody else puts a spectral sensor on a crew wearable; it is the band's most defensible part, because the circadian countermeasure is a lighting prescription.

### `temp` Skin temperature, 2 sites: MAX30208 x2 (Analog Devices (Maxim Integrated))

Two digital skin-temperature sensors on the inner face. They also act as the skin-side safety monitor for the LEDs and the cell.

- Interface: I2C-A + I2C-B
- Manufacturer spec (not a LANDFALL constant): ±0.1 °C accuracy from +30 to +50 °C
- Rate, Each sensor: `1 Hz` (chip: derived, flown hardware). Bio-Monitor skin temperature, 2 channels at 1 Hz, kept at 2 × 1 Hz

(a) Produces:
- `skin_temp` Skin temperature [°C]: median skin temperature in the main sleep period

(b) Feeds:
- indicator skin_temp (context only, never alerts)
- case renal_stone (ground packet)

(c) Justified or constrained by:
- `[V1 3004](h)` (requires; frozen in `std_vol1_requirements`): "Assessing, recording, monitoring, and trending vital signs and additional physiological and behavioral health signs."
- `[V2 9102]` (constrains; frozen in `std_vol2_requirements`): "Any surface to which the bare skin of the crew is exposed shall not cause skin temperature to exceed the injury limits in Table 9.3-4"
  - Tissue damage, high: `49 °C` (chip: NASA-published, Table 9.3-4)
  - Tissue damage, low: `0 °C` (chip: NASA-published, Table 9.3-4)

Design notes:
- Skin temperature is not core temperature. The band does not derive core temperature: that needs a validated model, which is an open item.
- Skin temperature follows cabin temperature and clothing, so LANDFALL shows it as context and never alerts on it.

### `imu` IMU (actigraphy): LSM6DSOX (STMicroelectronics)

6-axis IMU. Only the accelerometer runs, for actigraphy (sleep and wake scoring) and off-wrist detection.

- Interface: I2C-A
- Manufacturer spec (not a LANDFALL constant): 3-axis accelerometer + 3-axis gyroscope; Hardware FIFO
- Rate, Accelerometer: `52 Hz` (chip: design choice). Between the 32 Hz of research wrist actigraphs (per the project plan) and the 64 Hz of the flown Bio-Monitor accelerometer; 52 Hz is a native output rate of the part.
- Rate, Activity epoch: `60 s` (chip: design choice). 1-min epochs, as in research actigraphy; the same epoch as the light sensor.

(a) Produces:
- `sleep_duration` Sleep duration (actigraphy) [h]: total sleep time in the main sleep period, scored from 1-min activity epochs
- `sleep_midpoint_shift` Sleep midpoint shift [h]: shift of the night's sleep midpoint from the baseline median

(b) Feeds:
- indicator sleep_duration (reliable change vs own baseline)
- indicator sleep_midpoint_shift (reliable change vs own baseline)
- case sleep_circadian (trigger (2 of its 4 triggers))

(c) Justified or constrained by:
- `Standard Measures` (NASA names it; frozen in `hrp_research`): "measurements of activity and light exposure (gathered through a wrist sensor)"
- `[V1 3004](h)` (requires; frozen in `std_vol1_requirements`): "Assessing, recording, monitoring, and trending vital signs and additional physiological and behavioral health signs."

Design notes:
- Actigraphy is how Barger et al. (Lancet Neurol 2014) measured astronaut sleep in flight: 6.09 h per night on the ISS.
- Off-wrist time (no motion and skin temperature near cabin temperature) is logged as MISSING, never as zero activity or as sleep.

### `mcu` MCU + BLE radio: nRF52840 (Nordic Semiconductor)

Reads every sensor, timestamps every sample on one clock, writes the local log and syncs it to the LANDFALL app over an encrypted BLE link when the tablet is in range.

- Interface: host of SPI, I2C-A, I2C-B, QSPI; BLE 5 to the LANDFALL app
- Manufacturer spec (not a LANDFALL constant): Arm Cortex-M4F, 64 MHz; Bluetooth 5 LE radio; QSPI, SPI and two I2C controllers

(a) Produces:
- No indicator of its own. It turns raw samples into timestamped epoch records; the LANDFALL app computes the nightly indicators, so one engine evaluates every source the same way.

(b) Feeds:
- app landfall_app (every band observation (source: band))

(c) Justified or constrained by:
- `[V2 10125]` (requires; frozen in `std_vol2_requirements`): "The system shall have features for the protection of sensitive and private data, transmission, secure viewing, and sender verification." Encrypted, bonded BLE link; the band stores no names, only a crew id.
- `[V2 10130]` (requires; frozen in `std_vol2_requirements`): "The system shall provide alternative information sources for use in the event of the loss of the information management system." If the tablet fails, the band keeps recording on its own.

Design notes:
- One real-time clock stamps every channel in mission elapsed time (MET), so channels align without guessing delays.

### `flash` Local log, 16 MiB: W25Q128JV (Winbond)

128 Mbit serial NOR flash: the band's own log. The no-comms thesis applied to the device itself: nothing is lost when the tablet is out of range or down.

- Interface: QSPI
- Manufacturer spec (not a LANDFALL constant): 128 Mbit (16 MiB) serial NOR flash; Quad SPI

(a) Produces:
- Stores, does not measure. Depth arithmetic below.

(b) Feeds:
- indicator all personal indicators (keeps one whole 14-day RCI baseline window on the band)

(c) Justified or constrained by:
- `[V2 10129]` (requires; frozen in `std_vol2_requirements`): "The system shall provide for 1) automatic backup and crew restoration of information essential for system functionality, and 2) crew-initiated backup and restoration of information that can be generated or changed by crew during the mission."
- `[V2 6001]` (pattern borrowed; frozen in `std_vol2_requirements`): "The system shall provide environmental and suit monitoring data in formats compatible with performing temporal trend analyses." Written for environmental and suit data. The band's records are timestamped and trend-ready, and export as FHIR R4 Observations through LANDFALL.

Design notes:
- NASA publishes no requirement for wearable storage or log duration, so the 14-day target is a design choice.

### `battery` LiPo cell 200 mAh: LiPo cell, 1S, 200 mAh (Generic (part not selected))

Single lithium-polymer cell, 3.7 V nominal, sized to sit far inside the JSC-20793 Non-Critical battery class.

- Interface: power domain
- Manufacturer spec (not a LANDFALL constant): 3.7 V nominal, 3.0-4.2 V

(a) Produces:
- nothing directly

(b) Feeds:
- nothing directly (power domain)

(c) Justified or constrained by:
- `JSC-20793 Rev D` (constrains; not frozen in this build): "Non-Critical: less than 4 Wh per isolated pack; Li-ion COTS cells up to 1000 mAh." Class boundaries as read in project preparation (PLANO Appendix B); the document is not frozen in this build.
  - Non-Critical class, energy per isolated pack: `4 Wh (below)` (chip: NASA-published, JSC-20793 Rev D)
  - Non-Critical class, Li-ion COTS cell: `1000 mAh (max)` (chip: NASA-published, JSC-20793 Rev D)

### `charger` Charger: MCP73831 (Microchip Technology)

Single-cell linear Li-ion/LiPo charge controller, fed from the 5 V charging dock.

- Interface: power domain
- Manufacturer spec (not a LANDFALL constant): Single-cell linear charge management controller

(a) Produces:
- nothing directly

(b) Feeds:
- nothing directly (power domain)

(c) Justified or constrained by:
- `JSC-20793 Rev D` (constrains; not frozen in this build): "Section 4.4.3 asks for monitoring of battery voltage, current and temperature." This part has no thermistor input, so charging is not temperature-qualified: an open item.

### `gauge` Fuel gauge: MAX17048 (Analog Devices (Maxim Integrated))

Cell voltage and state of charge over I2C, so LANDFALL can show band battery and warn before the band stops recording.

- Interface: I2C-A
- Manufacturer spec (not a LANDFALL constant): ModelGauge state of charge from cell voltage, no sense resistor

(a) Produces:
- `band_battery_soc` Band state of charge [%]: device health, not crew health (not a SPEC 3.3 indicator)

(b) Feeds:
- nothing directly (power domain)

(c) Justified or constrained by:
- `JSC-20793 Rev D` (constrains; not frozen in this build): "Section 4.4.3 asks for monitoring of battery voltage, current and temperature." This gauge measures voltage only; it measures neither current nor temperature. Closing 4.4.3 needs a coulomb-counting gauge with a thermistor input: an open item.

## NOT MEASURABLE HERE: the hand-off boundary

What the band does not measure, and the documented path each value takes into LANDFALL instead.

| What | Why not on the band | Arrives via (observation source) | NASA requirement | Feeds |
|---|---|---|---|---|
| Urine output and fluid intake (24 h) | No wearable measures urine volume or what a crewmember drinks. | Manual entry in LANDFALL (`manual`) |  | indicator urine_volume_24h; indicator fluid_intake_24h; rule target_urine_output_24h; case renal_stone (trigger) |
| Radiation dose and dose rate | Alerting on exposure rates is assigned to the vehicle's radiation monitoring system, and organ dose in mGy-Eq needs that system's detectors and models. LANDFALL does not duplicate it with a wrist sensor. Examples: ISS TEPC (NASA SRAG, JSC) (`hapi_iss_tepc`); CSA CANS (`hrp_csa_radiation`). | Vehicle radiation monitoring system (`vehicle`) | `[V2 6164]` assigns elsewhere | rule ops_onboard_proton_s3; rule pel_t481_bfo_30d; rule pel_career_effective_dose; case spe_shelter (trigger) |
| Blood chemistry and urinary calcium | Needs a blood draw or a urine sample and an analyser. Examples: OSDR Inspiration4 panels (`osdr_cmp`). | Laboratory: ground analysis of returned samples (`lab`) |  | case renal_stone (interpretation and ground follow-up) |
| Blood pressure (cuff) | Wrist transit-time methods give systolic only and need per-subject calibration (see the Bio-Monitor pitfalls). Examples: Tempus Pro (NASA HRP) (`hrp_research`). | Vehicle medical kit (`vehicle`) |  | no rule: NASA publishes no in-flight blood pressure limit |
| VO2max | Needs a graded exercise test, with gas exchange or a validated indirect protocol. | Exercise and metabolic system (`vehicle`) | `[V1 4002]` assigns elsewhere | rule ffd_vo2max_microgravity_eva; rule ffd_vo2max_surface_eva |
| Bone mineral density | Needs dual-energy X-ray absorptiometry (DXA). | Ground DXA before and after flight (`lab`) | `[V1 4027]` assigns elsewhere | rule pol_bmd_hip; rule pol_bmd_spine; rule pol_bmd_femoral_neck |
| Cabin ppCO2 | An atmosphere measurement, not a body one. | Vehicle atmosphere monitoring (`vehicle`) | `[V2 6022]` assigns elsewhere | rule pel_cabin_ppco2_1h |
| Circadian phase and light at the eye | Phase needs melatonin or core temperature; Table 8.7-2 specifies light at the cornea, not at the wrist. | Research protocol; vehicle lighting system or a corneal light meter (`vehicle`) | `[V2 8055]` assigns elsewhere | case sleep_circadian (context) |

## Power and autonomy

Average-current budget and autonomy. Every current is an estimate from typical datasheet figures, never measured on a bench, so the budget carries a 2× margin.

| Block | Estimated average current |
|---|---|
| nRF52840: CPU duty, BLE sync, clock | `250 uA` |
| MAX30003: ECG and R-R detection | `100 uA` |
| MAX86141 and LEDs at 10 % duty | `60 uA` |
| LSM6DSOX: accelerometer only | `25 uA` |
| MAX17048: active | `25 uA` |
| MAX30208 ×2 at 1 Hz | `20 uA` |
| W25Q128JV: page writes, standby | `10 uA` |
| AS7341: one reading per minute | `5 uA` |
| Regulators and leakage | `20 uA` |

Budget chip: design choice. Typical datasheet figures for these duty cycles; to be replaced by bench measurement.

| Step | Value | Chip | Arithmetic or rationale |
|---|---|---|---|
| Sum of block currents | `515 µA` | derived | 250 + 100 + 60 + 25 + 25 + 20 + 10 + 5 + 20 = 515 µA |
| Margin for unmeasured currents | `2 ×` | design choice | Nothing here has been measured; doubling is our hedge. |
| Planning current | `1.03 mA` | derived | 515 µA × 2 = 1030 µA = 1.03 mA |
| Cell capacity | `200 mAh` | design choice | Small enough for a band, five times under the 1000 mAh Non-Critical cell limit. |
| Cell energy | `0.74 Wh` | derived | 3.7 V × 0.200 Ah = 0.74 Wh, 5.4 times below the 4 Wh Non-Critical limit |
| Usable fraction | `80 %` | design choice | Low-voltage cut-off and cell ageing. |
| Estimated autonomy | `155 h` | derived | 200 mAh × 0.80 / 1.03 mA = 155 h, about 6.5 days |
| Autonomy target | `72 h (min)` | design choice | One whole case tripwire window on one charge: cases.json reassess_after_s = 259,200 s (72 h) for renal_stone and sleep_circadian. |
| Headroom over target | `2.2 ×` | derived | 155 h / 72 h = 2.2 |

The flown Bio-Monitor runs 48 h on 2 AA cells, but it records 3-lead ECG at 256 Hz, respiration at 128 Hz and continuous PPG. The band records fewer, slower channels on purpose.

NASA publishes no battery-endurance requirement for wearables: all three mentions of battery in Vol 2 Rev F are about other things. The 72 h target is ours.

## Log depth

What 16 MiB holds. NASA publishes no storage or log-duration requirement for wearables, so every target here is a design choice.

| Step | Value | Chip | Arithmetic or rationale |
|---|---|---|---|
| Flash size | `16777216 B` | derived | 128 Mbit / 8 = 16 MiB = 16,777,216 B |
| Reserved: raw ECG event ring | `4194304 B` | design choice | 4 MiB of raw ECG around flagged events, for the flight surgeon. |
| Reserved: metadata and wear levelling | `1048576 B` | design choice | 1 MiB. |
| Indicator log space | `11534336 B` | derived | 16,777,216 - 4,194,304 - 1,048,576 = 11,534,336 B |
| R-R intervals at 100 bpm, 2 B each | `288000 B/day` | derived | 100 beats/min × 1,440 min × 2 B = 288,000 B/day (100 bpm is a deliberately high planning rate: design choice) |
| 1-min epoch records, 32 B each | `46080 B/day` | derived | 1,440 epochs × 32 B = 46,080 B/day (activity, light bands, 2 skin temperatures, SpO2 window, flags, MET: design choice) |
| Indicator log per day | `334080 B/day` | derived | 288,000 + 46,080 = 334,080 B/day |
| Log depth without a sync | `34.5 days` | derived | 11,534,336 / 334,080 = 34.5 days |
| Log depth target | `14 days (min)` | design choice | One whole RCI baseline window: personal.json rci.baseline_window_days = 14. A lost tablet does not cost anyone their baseline. |
| Raw ECG rate | `768 B/s` | derived | 256 samples/s × 3 B (18-bit sample in 3 bytes) = 768 B/s |
| Raw ECG in the event ring | `91 min` | derived | 4,194,304 B / 768 B/s = 5,461 s = 91 min |
| Raw ECG if the whole flash held it | `6.1 h` | derived | 16,777,216 B / 768 B/s = 21,845 s = 6.1 h. This is why the band logs R-R intervals, not waveforms. |

## What NASA does not publish (declared on the drawing)

- **No EMI/EMC requirement exists in NASA-STD-3001 Vol 2 Rev F.** The only electromagnetic requirement is human RF exposure, [V2 6102]. Citing a [V2] number for EMC would be fabrication; EMC qualification comes from the program. Evidence: `\bEMI\b|\bEMC\b|electromagnetic (interference|compatibility)` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **No skin-contact biocompatibility requirement exists.** Nearest: [V2 7076] clothing comfort and composition, and [V2 7081] microbiologically safe surfaces; material assessment is deferred to NASA-STD-6016. Evidence: `biocompat|cytotox|ISO 10993` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **NASA publishes no minimum sensor set for exploration missions.** No wearable, biosensor or body-worn device requirement in Vol 2 Rev F; the ExMC Mars medical ConOps (NTRS 20200001715) assumes "All crewmembers are wearing biosensors" with no sensor list, rates or specifications. Evidence: `wearable|biosensor|bio-sensor|body[- ]worn` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **No battery-endurance requirement for wearables.** Vol 2 Rev F mentions batteries 3 times, about traverse power projection and maintenance, never endurance. The autonomy target is a design choice. Evidence: `batter(y|ies)` gives 3 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **No data storage or log-duration requirement.** Zero hits for storage capacity, retention or log duration. The log-depth target is a design choice. Evidence: `data storage|storage capacity|data retention|retention period|log duration|logging duration` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).

## Flown reference: CSA Bio-Monitor (Hexoskin Astroskin)

- On the ISS since December 2018; first 48-h session by CSA astronaut David Saint-Jacques (ISS Daily Summary, 2019-02-28).
- Validated in HERA Campaign 3, TRL 5 to 6 (NTRS 20190001996).
- 48 h autonomy on 2 rechargeable AA cells, 400+ h of raw local storage, Bluetooth 2.1, 62 × 78 × 23 mm, 75 g.
- Exports EDF, CSV, JSON and binary RIFF/WAV; time base 1/256 s.

Basis: Transcribed in the project plan (PLANO section 1.5) from the product's datatype registry. Not re-verified in this build.

| Channel | Rate | Resolution |
|---|---|---|
| ECG, 1 to 3 leads | `256 Hz` | 12 bit, LSB 6.4 µV, 26 mV range, band-pass 1.6-33.9 Hz |
| Respiration (RIP, thoracic + abdominal bands) | `128 Hz` | 16 bit, about 8 mL volumetric |
| Accelerometer, 3 axes | `64 Hz` | 13 bit, ±16 g, 3.90625 mG |
| PPG (Nonin) | `64 Hz` | - |
| SpO2 | `1 Hz` | 1 % |
| Skin temperature, 2 channels | `1 Hz` | - |
| HRV (LF, HF, SDNN) | `1/300 Hz` | Lomb periodogram over 300 s |
| Systolic blood pressure (PTT-derived) | `1 Hz` | 1 mmHg, 60-260 mmHg |

## Bio-Monitor pitfalls (credibility notes)

Basis: Verified in project preparation against the product documentation (PLANO section 1.5). Not frozen in this build.

- **Its blood pressure is systolic-only and PTT-derived.** The Bio-Monitor's blood pressure is not a cuff reading and not continuous: it is systolic only, derived from pulse transit time between the ECG QRS and the PPG, and the useful form is adjusted to the user, so it needs per-subject calibration. Consequence for the band: The band does not estimate blood pressure. Blood pressure is a hand-off to the cuff in the medical kit.
- **The Nonin sensor adds a 172 ms delay.** The digital output of the Bio-Monitor's Nonin sensor lags by 172 ms, which must be subtracted when computing pulse transit time. Consequence for the band: Every band channel is timestamped at acquisition on one clock, and each front end's fixed delay is written in the log header.
- **CSV and JSON exports cap at 65,536 values per datatype.** About 18 h at 1 Hz, so high-rate channels require the binary path. Consequence for the band: R-R intervals at 100 bpm reach 65,536 values in 10.9 h, so they leave the band in binary records; 1-min epochs would take 45.5 days to reach the cap.
  - R-R at 100 bpm: `10.9 h` (chip: derived) 65,536 / 6,000 beats per hour = 10.9 h
  - 1-min epochs: `45.5 days` (chip: derived) 65,536 / 1,440 epochs per day = 45.5 days

## Safety constraints

Basis: Vol 2 Rev F items are frozen in std_vol2_requirements. JSC-20793 and NASA-STD-6001B were read in project preparation (PLANO Appendix B) and are not frozen in this build.

| Topic | Reference | Constraint | Chip |
|---|---|---|---|
| Leakage current, body-contact bioinstrumentation | `V2 9023`, `Table 9.3-11` | External contact, DC to 1 kHz: 0.1 mA normal, 0.5 mA single fault. The electrodes are the band's only conductive skin contact. | NASA-published |
| Current through the crewmember, any equipment | `V2 9019`, `V2 9020`, `V2 9021` | Nominal: 0.4 mA DC, 0.2 mA peak AC. Startle: 2 mA DC, 0.5 mA AC. Catastrophic: 40 mA DC, 8 mA peak AC. | NASA-published |
| Crew control of power | `V2 9017`, `V2 9018` | The crew must be able to interrupt power and see the de-energized status. The band has no switch or status light in this BOM: an open item. | NASA-published |
| Touch temperature | `V2 9102`, `V2 9103` | Tissue damage at 49 °C or above (Table 9.3-4); pain range 43 to 49 °C (Table 9.3-5). The LEDs stop at 41 °C at the skin-side sensor (design choice). | NASA-published |
| RF exposure | `V2 6102` | The BLE radio must keep crew RF exposure within Table 6.8-2. This is the only electromagnetic requirement in Vol 2. | NASA-published |
| Battery safety class | `JSC-20793 Rev D` | Non-Critical: under 4 Wh per isolated pack, Li-ion COTS up to 1000 mAh. Critical: 1-fault tolerant, under 20 V and 60 Wh. Catastrophic: 2-fault tolerant. Section 4.4.3: monitor voltage, current and temperature. | NASA-published |
| Materials in the habitable volume | `NASA-STD-6001B w/Chg 3`, `NASA-STD-6016C` | Test 1 flammability (5 specimens of 30 × 6.5 cm, none burns more than 15 cm), Test 4 wire insulation, Test 7 offgassing (72 ± 1 h at 50 ± 3 °C, total T value under 0.5), Test 18 arc tracking. An untested material needs a Material Usage Agreement under NASA-STD-6016C. | NASA-published |

## Open items

- No schematic capture or PCB: block level only (KiCad not available).
- Every current in the power budget is a datasheet-typical estimate; bench measurement replaces it.
- Battery monitoring: the MCP73831 has no thermistor input and the MAX17048 measures neither current nor temperature, so JSC-20793 section 4.4.3 is not met yet. Fix: a coulomb-counting gauge with a thermistor input.
- No power switch or status light for [V2 9017] / [V2 9018].
- Power tree (1.8 V AFE rail, LED supply) not designed.
- Electrode material, strap and housing materials not selected: NASA-STD-6001B testing or a Material Usage Agreement is needed.
- Core body temperature is not derived: that needs a validated model.
- Check the MAX30208 addressing on the datasheet before layout; the two-bus split avoids the question for now.
