# LANDFALL BAND: sensor map

> Generated from `sensor-map.json` by `node hardware/generate.mjs`. Do not edit by hand: edit the JSON and
> regenerate. `web/src/features/band/band.test.ts` fails when this file and the JSON disagree.

**Wearable sensing concept: annotated block diagram and reference bill of materials.** Block-level concept. No schematic capture, no PCB, never built, never bench-tested. Every current, rate and size here is a design estimate unless its chip says otherwise. KiCad was not available during the hackathon, so the deliverable is an annotated block diagram and a reference bill of materials.

**Manufacturer specs.** Manufacturer specs are quoted only where the manufacturer's own page or datasheet was read for this build (2026-11-14); each block names its source and says whether it was read. The datasheets of five parts (MAX30003, MAX86141, MAX30208, MAX17048, LSM6DSOX) could not be retrieved, so no manufacturer claim is quoted for them: what the design assumes of each part is an open item, and their datasheet URLs are listed for a reviewer.

The band measures what a wearable can measure. Everything else reaches LANDFALL through a documented interface, drawn as NOT MEASURABLE HERE. It is the same discipline as the software: no number without a source, no measurement without a sensor.

**The gap.** No operational wearable sensor specification: the ExMC Mars medical concept of operations assumes the crew wears biosensors and specifies none. Its emergency-care scenario assumes "All crewmembers are wearing biosensors", and its narratives warn that "Specific technologies are only representative and are not intended to indicate requirements": no sensor, sampling rate or performance is given. NASA-STD-3001 Vol 2 Rev F has no wearable or biosensor requirement (declared below). NASA's Spaceflight Standard Measures is a research study that collects "a standardized set of measurements", including activity and light from a wrist sensor; it is not an operational sensor specification. The band is one concrete, cited proposal for that gap. Quote: "All crewmembers are wearing biosensors" (Urbina M, McGuire K, Lehnhardt K, Fleming N. Medical System Concept of Operations for Mars Exploration Mission-11. NASA HRP Exploration Medical Capability (ExMC) Element, HRP-48021, Baseline April 2019, NTRS 20200001715, https://ntrs.nasa.gov/citations/20200001715; the NTRS full text, read 2026-11-14; not frozen in this build).

## Heart signals: one continuous, one on demand

- **Continuous: optical pulse (PPG)** (`ppg`). The optical sensor under the band reads the pulse around the clock. Its pulse inter-beat intervals give heart rate and, in sleep, the resting heart rate and the variability indicator. Variability computed from pulse intervals is pulse-rate variability (PRV), an approximation of heart-rate variability (HRV): close at rest, poor in motion, so the band computes it only in low-motion sleep.
- **On demand: single-lead ECG** (`ecg`). An ECG needs a lead across the heart, and two electrodes on one wrist cannot form one. The band's ECG records only while a finger of the other hand touches its outer electrode, which closes an arm-to-arm lead like limb lead I, for a 30-s strip. It cannot run while the band is simply worn, so no indicator comes from it.

## Blocks and their three labels

Every block carries three labels: (a) the indicator it produces, (b) the LANDFALL rule, baseline or case it feeds, and (c) the NASA requirement that justifies or constrains it.

| Block | Part | (a) Indicator produced | (b) LANDFALL rule / baseline / case fed | (c) NASA requirement |
|---|---|---|---|---|
| `ppg` Optical pulse (PPG): HR, PRV, SpO2 | MAX86141 | `resting_hr`, `hrv_sdnn`, `heart_rate`, `spo2` | indicator resting_hr (reliable change vs own baseline); indicator hrv_sdnn (reliable change vs own baseline: PRV against a PRV baseline); case sleep_circadian (ground packet (resting HR, PRV)); case renal_stone (ground packet (resting HR)); no rule: NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert requirements leave the number to the program. LANDFALL invents none for SpO2 | `[V1 3004](h)` requires; `[V2 9023]` constrains; `[V2 9103]` constrains |
| `ecg` Spot ECG: finger of other hand | MAX30003 | `ecg_spot_check` | no rule: LANDFALL reads no ECG: no rule uses the strip and nothing classifies its rhythm | `[V1 3004](i)` requires; `[V2 9023]` constrains; `[V2 11023]` pattern borrowed |
| `light` Spectral light sensor | AS7341 | `light_exposure_daytime` | indicator light_exposure_daytime (context only, never alerts); case sleep_circadian (ground packet; closes the loop from sensor to the lighting countermeasure) | `[V2 8055]` pattern borrowed; `ARCHeR (Artemis II)` NASA names it; `Standard Measures` NASA names it |
| `temp` Skin temperature, 2 sites | MAX30208 x2 | `skin_temp` | indicator skin_temp (context only, never alerts); case renal_stone (ground packet) | `[V1 3004](h)` requires; `[V2 9102]` constrains |
| `imu` IMU (actigraphy) | LSM6DSOX | `sleep_duration`, `sleep_midpoint_shift` | indicator sleep_duration (reliable change vs own baseline); indicator sleep_midpoint_shift (reliable change vs own baseline); case sleep_circadian (trigger (2 of its 4 triggers)) | `ARCHeR (Artemis II)` NASA names it; `Standard Measures` NASA names it; `[V1 3004](h)` requires |
| `mcu` MCU + BLE radio | nRF52840 | (none: see notes) | app landfall_app (every band observation (source: band)) | `[V2 10125]` requires; `[V2 10130]` requires |
| `flash` Local log, 16 MiB | W25Q128JV | (none: see notes) | indicator all personal indicators (keeps one whole 14-day Tier B baseline window on the band) | `[V2 10129]` requires; `[V2 6001]` pattern borrowed |
| `battery` LiPo cell 200 mAh | LiPo cell, 1S, 200 mAh | (none: see notes) | (none) | `JSC-20793 Rev D` constrains |
| `charger` Charger | MCP73831 | (none: see notes) | (none) | `JSC-20793 Rev D` constrains |
| `gauge` Fuel gauge | MAX17048 | `band_battery_soc` | (none) | `JSC-20793 Rev D` constrains |

Relations: **requires** = requires this function; **constrains** = limits how this block may be built; **pattern borrowed** = written for another system; the band borrows the pattern and does not claim compliance; **assigns elsewhere** = assigns this measurement or alert to another system; **NASA names it** = NASA page that names the measurement (not a requirement).

## Block details

### `ppg` Optical pulse (PPG): HR, PRV, SpO2: MAX86141 (Analog Devices (Maxim Integrated))

Optical front end and the band's heart-rate source: red and infrared LEDs and a photodiode under a window on the inner face. The infrared pulse channel runs around the clock, and its pulse inter-beat intervals give heart rate and, in sleep, pulse-rate variability. Red and infrared together give SpO2 in spot windows.

- Interface: SPI
- Datasheet (not retrieved, 2026-11-14): https://www.analog.com/media/en/technical-documentation/data-sheets/max86140-max86141.pdf; product page https://www.analog.com/en/products/max86141.html. Not retrieved for this build. The number of optical channels and LED drivers is unverified, so none is claimed here.
- Rate, Pulse channel (infrared), continuous: `64 Hz` (chip: derived, flown hardware). Bio-Monitor PPG 64 Hz, kept at 64 Hz
- Rate, PRV window, in sleep: `300 s` (chip: derived, flown hardware). Bio-Monitor HRV over 300 s, kept at 300 s (5-min windows)
- Rate, SpO2 output: `1 Hz` (chip: derived, flown hardware). Bio-Monitor SpO2 1 Hz, kept at 1 Hz
- Rate, SpO2 window: `60 s every 10 min` (chip: design choice). LED current dominates the power budget, so only the infrared pulse channel runs continuously; the red LED joins it for SpO2 in windows (10 % duty).

(a) Produces:
- `resting_hr` Resting heart rate [bpm]: lowest stable 5-min heart rate in the main sleep period, from pulse inter-beat intervals
- `hrv_sdnn` Heart rate variability (SDNN), measured as PRV [ms]: SDNN of pulse inter-beat intervals in 5-min windows of low-motion sleep, averaged over the night: pulse-rate variability (PRV), an approximation of HRV, not ECG-derived HRV
- `heart_rate` Heart rate, 1-min means [bpm]: mean pulse rate in each 1-min epoch, around the clock; shown on Trends as context, and no rule reads it (not a SPEC 3.3 indicator)
- `spo2` SpO2 (spot windows) [%]: recorded and shown as context; no LANDFALL rule uses it (not a SPEC 3.3 indicator)

(b) Feeds:
- indicator resting_hr (reliable change vs own baseline)
- indicator hrv_sdnn (reliable change vs own baseline: PRV against a PRV baseline)
- case sleep_circadian (ground packet (resting HR, PRV))
- case renal_stone (ground packet (resting HR))
- no rule: NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert requirements leave the number to the program. LANDFALL invents none for SpO2

(c) Justified or constrained by:
- `[V1 3004](h)` (requires; frozen in `std_vol1_requirements`): "Assessing, recording, monitoring, and trending vital signs and additional physiological and behavioral health signs."
- `[V2 9023]` (constrains; frozen in `std_vol2_requirements`): "For equipment such as bioinstrumentation and medical devices, that are specifically designed to contact the human body, electrical leakage currents caused by contact with exposed surfaces (including in worst-case fault scenarios) shall be kept below the levels specified in Table 9.3-11" The optical window is not an electrode, but the band as a whole is bioinstrumentation on intact skin, so its total leakage is held to the External rows of Table 9.3-11 (see the ECG block).
- `[V2 9103]` (constrains; frozen in `std_vol2_requirements`): "Any surface to which the bare skin of the crew is exposed shall not cause skin temperature to enter the range for pain/injury in Table 9.3-5" The pulse LED runs around the clock against the skin, so this limit applies all day, not only in spot windows.
  - Pain range starts at: `43 °C` (chip: NASA-published, Table 9.3-5)
  - LED cut-off at skin-side sensor: `41 °C` (chip: design choice) 2 °C below the start of the Table 9.3-5 pain range; read from the skin temperature sensors.

Design notes:
- Pulse-rate variability is not heart-rate variability: pulse intervals also carry the beat-to-beat variation of the pulse's travel time from heart to wrist. So the band computes hrv_sdnn only in low-motion sleep, labels it PRV, and Tier B compares it only with the crewmember's own PRV baseline, never with ECG-derived norms (see the published basis).
- Pulse intervals are kept only from epochs the accelerometer scores as low-motion. Daytime heart rate in motion is a trend for Trends, not an indicator.
- Timing resolution: at 64 Hz one sample is 15.6 ms, so peak-time quantization adds an interval error of 15.625 / √6 = 6.4 ms (SD). On an illustrative SDNN of 50 ms that gives √(50² + 6.4²) = 50.4 ms, a 0.4 ms bias that is the same in the crewmember's own baseline; peak interpolation shrinks it further.
- Each sample is timestamped at acquisition on the MCU clock and the AFE's fixed pipeline delay is written in the log header, never assumed to be zero (see the Nonin 172 ms pitfall).

Published basis (not a NASA requirement):
- PRV is an acceptable estimate of HRV at rest, but not in motion. "Results speak in favor of sufficient accuracy when subjects are at rest, although many studies suggest that short-term variability is somewhat overestimated by PRV, which reflects coupling effects between respiration and the cardiovascular system. Physical activity and some mental stressors seem to impair the agreement of PRV and HRV, often to an inacceptable extent." (chip: literature) Schäfer A, Vagedes J. How accurate is pulse rate variability as an estimate of heart rate variability? A review on studies comparing photoplethysmographic technology with an electrocardiogram. Int J Cardiol 2013;166(1):15-29. doi:10.1016/j.ijcard.2012.03.119. PMID 22809539, https://pubmed.ncbi.nlm.nih.gov/22809539/ (read 2026-11-14; not frozen in this build).

### `ecg` Spot ECG: finger of other hand: MAX30003 (Analog Devices (Maxim Integrated))

Single-lead ECG front end for an on-demand spot check. One dry electrode on the inner face rests on the wrist; a second on the outer face is touched by a finger of the other hand, which closes a lead from one arm to the other, across the chest, like limb lead I. Two electrodes on one wrist have no lead across the heart, so the ECG records only during a spot check, never while the band is simply worn.

- Interface: SPI
- Datasheet (not retrieved, 2026-11-14): https://www.analog.com/media/en/technical-documentation/data-sheets/max30003.pdf; product page https://www.analog.com/en/products/max30003.html. Not retrieved for this build. Sample width, on-chip R-R detection and the 256 sps setting are unverified, so none is claimed here.
- Rate, ECG, during a spot check: `256 sps` (chip: derived, flown hardware). Bio-Monitor ECG 256 Hz, kept at 256 sps
- Rate, Spot-check length: `30 s` (chip: design choice). Long enough for a rhythm strip the crewmember can hold still for. It is also the session length of the FDA-authorized watch ECG in the published basis (DEN180044).

(a) Produces:
- `ecg_spot_check` ECG spot check: 30-s single-lead strip [waveform]: recorded only on demand, while the other hand touches the outer electrode; stored raw on the band for the Crew Medical Officer and the flight surgeon (no viewer yet: open item) (not a SPEC 3.3 indicator)

(b) Feeds:
- no rule: LANDFALL reads no ECG: no rule uses the strip and nothing classifies its rhythm

(c) Justified or constrained by:
- `[V1 3004](i)` (requires; frozen in `std_vol1_requirements`): "Conducting ancillary tests as needed, including imaging (e.g., cardiac, vascular, ocular), laboratory analyses, and electrocardiography."
- `[V2 9023]` (constrains; frozen in `std_vol2_requirements`): "For equipment such as bioinstrumentation and medical devices, that are specifically designed to contact the human body, electrical leakage currents caused by contact with exposed surfaces (including in worst-case fault scenarios) shall be kept below the levels specified in Table 9.3-11" Table 9.3-11 splits body contact into External and Internal. The electrodes touch intact skin only, so LANDFALL reads the External rows (our reading: the table does not name wrist devices). During a spot check the current path runs from one arm to the other, across the chest. The rationale names electrocardiogram (ECG) monitors as isolated equipment; isolated and non-isolated equipment share the External values, and the rationale says the sum of all leakage currents is what counts. General body-current limits for any equipment are [V2 9019] to [V2 9021] (see Safety constraints).
  - Leakage, External body contact, DC to 1 kHz, normal condition: `0.1 mA` (chip: NASA-published, Table 9.3-11)
  - Leakage, External body contact, DC to 1 kHz, single fault: `0.5 mA` (chip: NASA-published, Table 9.3-11)
- `[V2 11023]` (pattern borrowed; frozen in `std_vol2_requirements`): "Derived body core temperature and heart rhythm (real-time) are desired for microgravity operations" From the rationale; written for suits. A 30-s spot check is not real-time rhythm monitoring: that needs electrodes across the chest, as in the flown Bio-Monitor's shirt.

Design notes:
- The inner electrode touches the wrist around the clock, so the Table 9.3-11 footnote applies: "*For DC, there is a small risk of heating and tissue necrosis for prolonged duration of contact." A current path through the body exists only while the other hand closes the circuit; the front end is powered down between spot checks, and every DC lead-bias and lead-off current must still be checked against the footnote (open item).
- Each spot check also logs the PPG pulse intervals of the same beats, so pulse timing can be compared with R-R intervals for this crewmember at rest: about 30 beats, a sanity check, not a validation of nightly PRV.
- Raw waveforms are kept only for spot checks: the 4 MiB ring holds 182 of them (see the log arithmetic).
- The band does not estimate blood pressure from ECG-to-PPG transit time (see the Bio-Monitor pitfalls).

Published basis (not a NASA requirement):
- The same electrode arrangement in an FDA-authorized wrist ECG: electrodes on the back touch the wrist, a finger touches the crown, 30 s, a single lead similar to lead I. "The watch also contains electrodes on the back of the device which are in continuous contact with the user’s wrist. The watch acquires the electrical potential between the electrodes and digital crown." (chip: literature) US Food and Drug Administration. De Novo classification request for ECG App (DEN180044), Apple Inc., De Novo date August 14, 2018: decision summary, https://www.accessdata.fda.gov/cdrh_docs/reviews/DEN180044.pdf (read 2026-11-14; not frozen in this build).

### `light` Spectral light sensor: AS7341 (ams OSRAM)

11-channel spectral sensor on the outer face: daytime light exposure at the wrist, as photopic lux computed from its visible channels.

- Interface: I2C-A
- Manufacturer spec (not a LANDFALL constant): 11 channels: 8 optical channels over the visible range, plus Clear, Flicker and NIR; Serial I2C interface
- Datasheet (read 2026-11-14): https://look.ams-osram.com/m/24266a3e584de4db/original/AS7341-DS000504.pdf; product page https://ams-osram.com/products/sensor-solutions/ambient-light-color-spectral-proximity-sensors/ams-as7341-11-channel-spectral-color-sensor. Read on the ams OSRAM product page, which links the DS000504 datasheet.
  - Verified text: "8 optical channels distributed over the visible range"; "3 extra channels: Clear, Flicker and NIR channel"; "Control and Spectral data access is implemented through a serial I²C interface."
- Rate, Reading: `60 s epoch` (chip: design choice). One reading per 1-min epoch, the same epoch as the activity record.

(a) Produces:
- `light_exposure_daytime` Daytime light exposure (wrist) [lux]: mean photopic illuminance at the wrist during the scheduled wake period

(b) Feeds:
- indicator light_exposure_daytime (context only, never alerts)
- case sleep_circadian (ground packet; closes the loop from sensor to the lighting countermeasure)

(c) Justified or constrained by:
- `[V2 8055]` (pattern borrowed; frozen in `std_vol2_requirements`): "The system shall provide the levels of light to support the physiological effects of light in accordance with Table 8.7-2" Written for the lighting system: Table 8.7-2 specifies melanopic EDI and melanopic DER at the cornea, in the vertical plane. A wrist reading is not that quantity, so it is context and never a compliance check.
  - General ambient, melanopic EDI at cornea: `250 lux (min)` (chip: NASA-published, Table 8.7-2)
  - General ambient, melanopic DER: `0.7 (min)` (chip: NASA-published, Table 8.7-2)
  - Crew pre-sleep, melanopic EDI at cornea: `8 ± 2 lux` (chip: NASA-published, Table 8.7-2)
  - Crew pre-sleep, melanopic DER: `0.3 (max)` (chip: NASA-published, Table 8.7-2)
- `ARCHeR (Artemis II)` (NASA names it; frozen in `hrp_research`): "The actigraphy device that select Artemis II astronauts will wear on their wrists during their mission around the Moon. The device will measure the crew members' motion, sleep patterns, and exposure to light." Flown precedent beyond low Earth orbit. The quote is the image caption (page metadata); the body text says only actigraphy.
- `Standard Measures` (NASA names it; frozen in `hrp_research`): "measurements of activity and light exposure (gathered through a wrist sensor)"

Design notes:
- Light at the wrist closes the loop from sensor to countermeasure: the circadian countermeasure is a lighting prescription, and NASA's own wrist devices record light exposure (ARCHeR on Artemis II, Standard Measures on the ISS).
- The visible channels also allow a melanopic-weighted estimate. Table 8.7-2 is specified at the cornea, so a wrist estimate stays context.

### `temp` Skin temperature, 2 sites: MAX30208 x2 (Analog Devices (Maxim Integrated))

Two digital skin-temperature sensors on the inner face, behind non-conductive windows. They also act as the skin-side safety monitor for the LEDs and the cell.

- Interface: I2C-A + I2C-B
- Datasheet (not retrieved, 2026-11-14): https://www.analog.com/media/en/technical-documentation/data-sheets/max30208.pdf; product page https://www.analog.com/en/products/max30208.html. Not retrieved for this build. Accuracy, range and I2C addressing are unverified, so none is claimed here.
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

IMU. Only its accelerometer is used, for actigraphy (sleep and wake scoring), the motion flag that gates the pulse intervals, and off-wrist detection.

- Interface: I2C-A
- Datasheet (not retrieved, 2026-11-14): https://www.st.com/resource/en/datasheet/lsm6dsox.pdf; product page https://www.st.com/en/mems-and-sensors/lsm6dsox.html. Not retrieved for this build. Axis count, FIFO and output data rates are unverified, so none is claimed here.
- Rate, Accelerometer: `52 Hz` (chip: design choice). Near the 64 Hz of the flown Bio-Monitor accelerometer. That the part offers exactly 52 Hz is not verified in this build (open item).
- Rate, Activity epoch: `60 s` (chip: design choice). 1-min epochs, as in research actigraphy; the same epoch as the light sensor.

(a) Produces:
- `sleep_duration` Sleep duration (actigraphy) [h]: total sleep time in the main sleep period, scored from 1-min activity epochs
- `sleep_midpoint_shift` Sleep midpoint shift [h]: absolute shift, in hours, of the night's sleep midpoint from the median midpoint of the fixed baseline window (earlier or later both count as a larger shift)

(b) Feeds:
- indicator sleep_duration (reliable change vs own baseline)
- indicator sleep_midpoint_shift (reliable change vs own baseline)
- case sleep_circadian (trigger (2 of its 4 triggers))

(c) Justified or constrained by:
- `ARCHeR (Artemis II)` (NASA names it; frozen in `hrp_research`): "The actigraphy device that select Artemis II astronauts will wear on their wrists during their mission around the Moon. The device will measure the crew members' motion, sleep patterns, and exposure to light." Flown precedent beyond low Earth orbit. The quote is the image caption (page metadata); the body text says only actigraphy.
- `Standard Measures` (NASA names it; frozen in `hrp_research`): "measurements of activity and light exposure (gathered through a wrist sensor)"
- `[V1 3004](h)` (requires; frozen in `std_vol1_requirements`): "Assessing, recording, monitoring, and trending vital signs and additional physiological and behavioral health signs."

Design notes:
- Actigraphy is how Barger et al. (Lancet Neurol 2014) measured astronaut sleep in flight: 6.09 h per night on the ISS.
- Off-wrist time (no motion and skin temperature near cabin temperature) is logged as MISSING, never as zero activity or as sleep.

### `mcu` MCU + BLE radio: nRF52840 (Nordic Semiconductor)

Reads every sensor, timestamps every sample on one clock, detects pulse peaks, writes the local log and syncs it to the LANDFALL app over an encrypted BLE link when the tablet is in range.

- Interface: host of SPI, I2C-A, I2C-B, QSPI; BLE to the LANDFALL app
- Manufacturer spec (not a LANDFALL constant): 64 MHz Cortex-M4 with FPU; Bluetooth Low Energy radio; UART, SPI, TWI, PDM, I2S, QSPI
- Datasheet (read 2026-11-14): https://docs.nordicsemi.com/bundle/ps_nrf52840/page/keyfeatures_html5.html; product page https://www.nordicsemi.com/Products/nRF52840. Read on the Nordic product page. The product specification needs a browser with JavaScript and was not read, so the number of TWI (I2C) instances is unverified.
  - Verified text: "64 MHz Cortex-M4 with FPU"; "1 MB Flash, 256 KB RAM"; "Bluetooth Low Energy, Bluetooth mesh"; "UART, SPI, TWI, PDM, I2S, QSPI"

(a) Produces:
- No indicator of its own. It turns raw samples into pulse intervals and timestamped epoch records; the LANDFALL app computes the nightly indicators, so one engine evaluates every source the same way.

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
- Manufacturer spec (not a LANDFALL constant): 128M-bit / 16M-byte serial flash; Standard, Dual and Quad SPI
- Datasheet (read 2026-11-14): https://www.winbond.com/resource-files/W25Q128JV%20RevI%2008232021%20Plus.pdf; product page https://www.winbond.com/hq/product/code-storage-flash-memory/serial-nor-flash/?__locale=en&partNo=W25Q128JV. Read in the Winbond datasheet, Revision I (publication release date August 23, 2021).
  - Verified text: "W25Q128JV: 128M-bit / 16M-byte"; "3V 128M-BIT SERIAL FLASH MEMORY WITH DUAL/QUAD SPI"

(a) Produces:
- Stores, does not measure. Depth arithmetic below.

(b) Feeds:
- indicator all personal indicators (keeps one whole 14-day Tier B baseline window on the band)

(c) Justified or constrained by:
- `[V2 10129]` (requires; frozen in `std_vol2_requirements`): "The system shall provide for 1) automatic backup and crew restoration of information essential for system functionality, and 2) crew-initiated backup and restoration of information that can be generated or changed by crew during the mission."
- `[V2 6001]` (pattern borrowed; frozen in `std_vol2_requirements`): "The system shall provide environmental and suit monitoring data in formats compatible with performing temporal trend analyses." Written for environmental and suit data. The band's records are timestamped and trend-ready, and export as FHIR R4 Observations through LANDFALL.

Design notes:
- NASA-STD-3001 Vol 2 Rev F sets no requirement for wearable storage or log duration, so the 14-day target is a design choice.

### `battery` LiPo cell 200 mAh: LiPo cell, 1S, 200 mAh (Generic (part not selected))

Single lithium-polymer cell, 3.7 V nominal (design value: no cell is selected), sized to sit far inside the JSC-20793 Non-Critical battery class.

- Interface: power domain
- Datasheet: none (no part selected)

(a) Produces:
- nothing directly

(b) Feeds:
- nothing directly (power domain)

(c) Justified or constrained by:
- `JSC-20793 Rev D` (constrains; not frozen in this build; public copy https://ntrs.nasa.gov/citations/20170009182, read 2026-11-14): "Low energy < 4 Wh per battery pack where each battery is thermally and electrically isolated" Section 4.1.3, Risk Classification: one condition of the Non-Critical class. For lithium-ion the same class admits "COTS (rechargeable) lithium-ion button, cylindrical, or pouch batteries of up to 1000 mAh capacity."
  - Non-Critical class, energy per isolated pack: `4 Wh (below)` (chip: NASA-published, JSC-20793 Rev D)
  - Non-Critical class, Li-ion COTS cell: `1000 mAh (max)` (chip: NASA-published, JSC-20793 Rev D)

### `charger` Charger: MCP73831 (Microchip Technology)

Single-cell linear Li-ion/LiPo charge controller, fed from the 5 V charging dock.

- Interface: power domain
- Manufacturer spec (not a LANDFALL constant): Linear charge management controller for single-cell Li-Ion and Li-Polymer; Pins: VDD, VBAT, STAT, VSS, PROG: no thermistor input; Thermal regulation acts on the die temperature
- Datasheet (read 2026-11-14): https://ww1.microchip.com/downloads/en/DeviceDoc/MCP73831-Family-Data-Sheet-DS20001984H.pdf; product page https://www.microchip.com/en-us/product/mcp73831. Read in the Microchip datasheet DS20001984H.
  - Verified text: "Miniature Single-Cell, Fully Integrated Li-Ion, Li-Polymer Charge Management Controllers"; "Linear Charge Management Controller"; "limit the charge current based on die temperature"; "pin table: VDD, VBAT, STAT, VSS, PROG (NC and exposed pad on the DFN); the word 'thermistor' does not occur in the datasheet"

(a) Produces:
- nothing directly

(b) Feeds:
- nothing directly (power domain)

(c) Justified or constrained by:
- `JSC-20793 Rev D` (constrains; not frozen in this build; public copy https://ntrs.nasa.gov/citations/20170009182, read 2026-11-14): "For lithium-ion batteries, monitoring of key parameters such as cell/battery voltages, cell temperature, and battery/string current is necessary to ascertain health and maintain safe operation of the battery." Section 4.4.3, Lithium-ion Battery and Cell Monitoring. Its shall-statements are written for batteries with catastrophic failure modes; the band applies the section anyway. Verified on the datasheet: the part has no thermistor input, and its thermal regulation follows the die, not the cell. Charging is not cell-temperature-qualified: an open item.

### `gauge` Fuel gauge: MAX17048 (Analog Devices (Maxim Integrated))

Fuel gauge for the cell, read over I2C, so LANDFALL can show band battery and warn before the band stops recording.

- Interface: I2C-A
- Datasheet (not retrieved, 2026-11-14): https://www.analog.com/media/en/technical-documentation/data-sheets/max17048-max17049.pdf; product page https://www.analog.com/en/products/max17048.html. Not retrieved for this build. What the gauge measures (voltage, current, temperature) is unverified, so none is claimed here.

(a) Produces:
- `band_battery_soc` Band state of charge [%]: device health, not crew health (not a SPEC 3.3 indicator)

(b) Feeds:
- nothing directly (power domain)

(c) Justified or constrained by:
- `JSC-20793 Rev D` (constrains; not frozen in this build; public copy https://ntrs.nasa.gov/citations/20170009182, read 2026-11-14): "For lithium-ion batteries, monitoring of key parameters such as cell/battery voltages, cell temperature, and battery/string current is necessary to ascertain health and maintain safe operation of the battery." Section 4.4.3. Whether this gauge measures current or cell temperature is not verified in this build, so the section is treated as not met. Closing it needs a gauge whose datasheet shows current and temperature measurement: an open item.

## NOT MEASURABLE HERE: the hand-off boundary

What the band does not measure, and the documented path each value takes into LANDFALL instead.

| What | Why not on the band | Arrives via (observation source) | NASA requirement | Feeds |
|---|---|---|---|---|
| Urine output and fluid intake (24 h) | No wearable measures urine volume or what a crewmember drinks. | Manual entry in LANDFALL (`manual`) |  | indicator urine_volume_24h; indicator fluid_intake_24h; rule target_urine_output_24h; case renal_stone (trigger) |
| Radiation: flux and dose | Two systems outside the band do this. The vehicle's radiation monitoring system raises the radiation alarm and reports dose rate ([V2 6164]); [V2 6165] asks the program to monitor the space weather outside the vehicle, proton flux spectra included, which takes an external space-weather monitor outside the shielding. Organ dose in mGy-Eq needs those detectors and the ground's models. The band measures none of these, and LANDFALL is not the radiation alarm: it opens the health case that follows and guides the crew. In the Mars scenario the flux comes from an external monitor in Mars orbit that reports one ≥10 MeV integral channel, not the spectra (the shelter case lists the proton spectrum as not measurable here), relayed locally with no Earth link (continuous relay is a scenario assumption); its values replay the real GOES-7 record of October 1989 with no distance or atmospheric correction (a scenario assumption). Examples: GOES-7 Energetic Particle Sensor (NOAA) (`swpc_spe_replay`); ISS TEPC (NASA SRAG, JSC) (`hapi_iss_tepc`); CSA CANS (`hrp_csa_radiation`). | Vehicle radiation monitor (alarm, dose); external space-weather monitor (proton flux) (`vehicle`) | `[V2 6164]` assigns elsewhere; `[V2 6165]` assigns elsewhere | rule ops_onboard_proton_s3; rule ops_noaa_s3; rule pel_t481_bfo_30d; rule pel_career_effective_dose; case spe_shelter (trigger: the health case that follows the alarm) |
| Blood chemistry and urinary calcium | Needs a blood draw or a urine sample and an analyser. Examples: OSDR Inspiration4 panels (`osdr_cmp`). | Laboratory: ground analysis of returned samples (`lab`) |  | case renal_stone (interpretation and ground follow-up) |
| Blood pressure and blood glucose | Neither is a wrist measurement here. Wrist transit-time methods give systolic only and need per-user adjustment (see the Bio-Monitor pitfalls), and glucose needs a drop of blood. Both are measured with the vehicle medical kit, a cuff and a fingerstick glucometer, and entered by hand. NASA-STD-3001 sets no numeric limit for either (Vol 1 Rev C and Vol 2 Rev F print no blood-pressure or glucose number), so LANDFALL compares each reading only with the crewmember's own baseline (Tier B, caution at most). Examples: Tempus Pro (NASA HRP) (`hrp_research`); OSDR Inspiration4 metabolic panel (`osdr_cmp`). | Vehicle medical kit: cuff and fingerstick glucometer, entered by hand (`manual`) |  | indicator bp_systolic (reliable change vs own baseline, caution at most); indicator bp_diastolic (reliable change vs own baseline, caution at most); indicator glucose (reliable change in either direction vs own baseline, caution at most) |
| VO2max | Needs a graded exercise test, with gas exchange or a validated indirect protocol. | Exercise and metabolic system (`vehicle`) | `[V1 4002]` assigns elsewhere | rule ffd_vo2max_microgravity_eva; rule ffd_vo2max_surface_eva |
| Bone mineral density | Needs dual-energy X-ray absorptiometry (DXA). | Ground DXA before and after flight (`lab`) | `[V1 4027]` assigns elsewhere | rule pol_bmd_hip; rule pol_bmd_spine; rule pol_bmd_femoral_neck |
| Cabin ppCO2 | An atmosphere measurement, not a body one. | Vehicle atmosphere monitoring (`vehicle`) | `[V2 6022]` assigns elsewhere | rule pel_cabin_ppco2_1h |
| Circadian phase and light at the eye | Phase needs melatonin or core temperature; Table 8.7-2 specifies light at the cornea, not at the wrist. | Research protocol; vehicle lighting system or a corneal light meter (`vehicle`) | `[V2 8055]` assigns elsewhere | case sleep_circadian (context) |

Radiation: flux and dose:
- `[V2 6164]` (assigns elsewhere; frozen in `std_vol2_requirements`): "The radiation monitoring system shall alert the crew and operations teams when radiation exposure rates exceed predefined thresholds." Its rationale: "The crew must be alerted even if ground communication is disrupted or is unviable."
- `[V2 6165]` (assigns elsewhere; frozen in `std_vol2_requirements`): "The program shall monitor the in-situ extravehicular space weather environment including the external exposure rates, electron flux spectra, and proton flux spectra." Its rationale names the storms LANDFALL's scenario draws on: "Historically significant space weather storming includes the August 1972 and October 1989 events." The SPE case replays the real GOES-7 record of October 1989.
- In NASA's own Mars medical concept of operations, the vehicle's sensors raise the radiation alarm and the medical system follows. "Radiation environment sensors embedded within the vehicle system detect a solar particle event and annunciates alarms to warn the crew and the medical system." (chip: NASA report) ExMC, Medical System Concept of Operations for Mars Exploration Mission-11 (HRP-48021, Baseline April 2019), NTRS 20200001715, https://ntrs.nasa.gov/citations/20200001715 (read 2026-11-14; not frozen in this build).

VO2max:
- `[V1 4002]` (assigns elsewhere; frozen in `std_vol1_requirements`): "Crewmembers shall maintain an in-mission VO2max at or above 36.5 ml⁄min/kg for missions with extraterrestrial surface EVAs as determined by either direct or indirect measures."

Bone mineral density:
- `[V1 4027]` (assigns elsewhere; frozen in `std_vol1_requirements`): "Countermeasures shall maintain bone mineral density of the hip and spine at or above 95% of pre-mission values and at or above 90% for the femoral neck."

Cabin ppCO2:
- `[V2 6022]` (assigns elsewhere; frozen in `std_vol2_requirements`): "The system shall alert the crew locally and remotely when atmospheric parameters, including atmospheric pressure, humidity, temperature, ppO2, and ppCO2 are outside safe limits."

Circadian phase and light at the eye:
- `[V2 8055]` (assigns elsewhere; frozen in `std_vol2_requirements`): "The system shall provide the levels of light to support the physiological effects of light in accordance with Table 8.7-2"


## Power and autonomy

Average-current budget and autonomy. Every current is the author's estimate for these duty cycles, not checked against the datasheets in this build and never measured on a bench, so the budget carries a 2× margin.

| Block | Estimated average current |
|---|---|
| MAX86141 and LEDs: infrared pulse channel continuous, red LED in SpO2 windows (10 %) | `330 uA` |
| nRF52840: CPU duty, pulse detection, BLE sync, clock | `250 uA` |
| LSM6DSOX: accelerometer only | `25 uA` |
| MAX17048: active | `25 uA` |
| MAX30208 ×2 at 1 Hz | `20 uA` |
| W25Q128JV: page writes, standby | `10 uA` |
| AS7341: one reading per minute | `5 uA` |
| MAX30003: powered down between 30-s spot checks | `2 uA` |
| Regulators and leakage | `20 uA` |

Budget chip: design choice. Estimates for these duty cycles, not checked against the datasheets in this build; to be replaced by bench measurement. The optical estimate is about 300 µA per LED running continuously: 300 µA for the infrared pulse channel plus 30 µA for the red LED at 10 % duty.

| Step | Value | Chip | Arithmetic or rationale |
|---|---|---|---|
| Sum of block currents | `687 µA` | derived | 330 + 250 + 25 + 25 + 20 + 10 + 5 + 2 + 20 = 687 µA |
| Margin for unmeasured currents | `2 ×` | design choice | Nothing here has been measured; doubling is our hedge. |
| Planning current | `1.374 mA` | derived | 687 µA × 2 = 1374 µA = 1.374 mA |
| Cell capacity | `200 mAh` | design choice | Small enough for a band, five times under the 1000 mAh Non-Critical cell limit. |
| Cell energy | `0.74 Wh` | derived | 3.7 V × 0.200 Ah = 0.74 Wh, 5.4 times below the 4 Wh Non-Critical limit |
| Usable fraction | `80 %` | design choice | Low-voltage cut-off and cell ageing. |
| Estimated autonomy | `116 h` | derived | 200 mAh × 0.80 / 1.374 mA = 116 h, about 4.8 days |
| Autonomy target | `72 h (min)` | design choice | One whole case tripwire window on one charge: cases.json reassess_after_s = 259,200 s (72 h) for renal_stone and sleep_circadian. |
| Headroom over target | `1.6 ×` | derived | 116 h / 72 h = 1.6 |

The flown Bio-Monitor runs 48 h on two AA batteries while it records 3-lead ECG at 256 Hz, respiration at 128 Hz and continuous PPG from a shirt and headband. The band records fewer channels on purpose, and its ECG only on demand.

NASA-STD-3001 Vol 2 Rev F sets no battery-endurance requirement for wearables: its three mentions of batteries are about other things. The 72 h target is ours.

## Log depth

What 16 MiB holds. NASA-STD-3001 Vol 2 Rev F sets no storage or log-duration requirement for wearables, so every target here is a design choice.

| Step | Value | Chip | Arithmetic or rationale |
|---|---|---|---|
| Flash size | `16777216 B` | derived | 128 Mbit / 8 = 16 MiB = 16,777,216 B |
| Reserved: ECG spot-check recordings | `4194304 B` | design choice | 4 MiB keeps the raw waveform of every spot check until it is synced, for the Crew Medical Officer and the flight surgeon. |
| Reserved: metadata and wear levelling | `1048576 B` | design choice | 1 MiB. |
| Indicator log space | `11534336 B` | derived | 16,777,216 - 4,194,304 - 1,048,576 = 11,534,336 B |
| Pulse inter-beat intervals at 100 bpm, 2 B each | `288000 B/day` | derived | 100 beats/min × 1,440 min × 2 B = 288,000 B/day (the pulse channel runs around the clock; 100 bpm is a deliberately high planning rate: design choice) |
| 1-min epoch records, 32 B each | `46080 B/day` | derived | 1,440 epochs × 32 B = 46,080 B/day (activity, motion flag, 1-min heart rate, light bands, 2 skin temperatures, SpO2 window, flags, MET: design choice) |
| Indicator log per day | `334080 B/day` | derived | 288,000 + 46,080 = 334,080 B/day |
| Log depth without a sync | `34.5 days` | derived | 11,534,336 / 334,080 = 34.5 days |
| Log depth target | `14 days (min)` | design choice | One whole Tier B baseline window: personal.json rci.baseline_window_days = 14. A lost tablet does not cost anyone their baseline. |
| Raw ECG rate during a spot check | `768 B/s` | derived | 256 samples/s × 3 B per stored sample = 768 B/s (3 B per sample is a design choice; the front end's sample width is not verified in this build) |
| Raw ECG the ring holds | `91 min` | derived | 4,194,304 B / 768 B/s = 5,461 s = 91 min |
| Spot checks the ring holds | `182 spot checks` | derived | 5,461 s / 30 s = 182 spot checks of 30 s |
| Raw PPG rate, pulse channel | `192 B/s` | derived | 64 samples/s × 3 B per stored sample = 192 B/s (3 B per sample is a design choice; the front end's sample width is not verified in this build) |
| Raw PPG if the whole flash held it | `24.3 h` | derived | 16,777,216 B / 192 B/s = 87,381 s = 24.3 h. This is why the band logs pulse inter-beat intervals, not the optical waveform. |

## What NASA-STD-3001 Vol 2 Rev F does not require (declared on the drawing)

- **No EMI/EMC requirement exists in NASA-STD-3001 Vol 2 Rev F.** The only electromagnetic requirement is human RF exposure, [V2 6102]. Citing a [V2] number for EMC would be fabrication; EMC qualification comes from the program. Evidence: `\bEMI\b|\bEMC\b|electromagnetic (interference|compatibility)` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **No skin-contact biocompatibility requirement exists in Vol 2 Rev F.** Nearest: [V2 7076] clothing comfort and composition, and [V2 7081] microbiologically safe surfaces; material assessment is deferred to NASA-STD-6016. Evidence: `biocompat|cytotox|ISO 10993` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **No wearable or biosensor requirement in Vol 2 Rev F.** The search finds no wearable, biosensor or body-worn device anywhere in the volume. The ExMC Mars medical concept of operations (NTRS 20200001715) assumes "All crewmembers are wearing biosensors" and specifies none: no sensor list, rate or performance. Evidence: `wearable|biosensor|bio-sensor|body[- ]worn` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **No battery-endurance requirement for wearables in Vol 2 Rev F.** Vol 2 Rev F mentions batteries 3 times, about traverse power projection and maintenance, never endurance. The autonomy target is a design choice. Evidence: `batter(y|ies)` gives 3 hits across Vol 2 Rev F (`std_vol2_requirements`).
- **No data storage or log-duration requirement in Vol 2 Rev F.** Zero hits for storage capacity, retention or log duration. The log-depth target is a design choice. Evidence: `data storage|storage capacity|data retention|retention period|log duration|logging duration` gives 0 hits across Vol 2 Rev F (`std_vol2_requirements`).

## Flown reference: CSA Bio-Monitor (Hexoskin Astroskin)

- A garment, not a wristband: NASA's ISS report calls the Bio-Monitor "a wearable garment capable of monitoring relevant physiological parameters for up to 48 hours"; CSA astronaut David Saint-Jacques' 48-hour recording session was debriefed on 2019-02-28.
- Astroskin "consists of a shirt-based garment and headband with embedded sensors", among them a 3-lead ECG in the shirt.
- Tested in NASA's HERA Campaign 3 (four 30-day missions, 16 crewmembers), a test that "will elevate the TRL from 5 to 6".
- Recorder: two replaceable AA batteries for 48 hours of autonomy, 400+ hours of local raw data storage, Bluetooth 2.1, 62 × 78 × 23 mm, 75 g without batteries.
- Exports JSON, CSV, EDF and binary (synchronous channels as RIFF/WAV); timestamps count 256ths of a second.

Basis: Read on 2026-11-14 in the public sources listed with it; not frozen in this build.

- NASA, ISS Daily Summary Report, 2019-02-28 (Bio-Monitor): https://blogs.nasa.gov/stationreport/2019/02/28/iss-daily-summary-report-2-28-2019/
- Toscano W, Cowings P, Sullivan P, et al. Wearable Biosensor Monitor to Support Autonomous Crew Health and Readiness to Perform. NASA HRP Investigators' Workshop, 2017. NTRS 20190001996: https://ntrs.nasa.gov/citations/20190001996
- Hexoskin, Astroskin Device (product page): https://hexoskin.com/products/astroskin-device
- Hexoskin API documentation, datatype registry (channel rates, PTT, Nonin delay): https://api.hexoskin.com/docs/resource/datatype/
- Hexoskin API documentation, data resource (export formats, 65,536-value cap): https://api.hexoskin.com/docs/resource/data/
- Hexoskin API documentation (timestamps in 256ths of a second): https://api.hexoskin.com/docs/

| Channel | Rate | Resolution |
|---|---|---|
| ECG, 1 to 3 leads | `256 Hz` | 12 bit, LSB 6.4 µV, 26 mV range, band-pass 1.6-33.9 Hz |
| Respiration (RIP, thoracic + abdominal bands) | `128 Hz` | 16 bit, about 8 mL volumetric |
| Accelerometer, 3 axes | `64 Hz` | 13 bit, ±16 g, 3.90625 mG |
| PPG (Nonin) | `64 Hz` | - |
| SpO2 | `1 Hz` | 1 % |
| Skin temperature, 2 channels | `1 Hz` | - |
| HRV (LF, HF, SDNN) | `1/300 Hz` | over the last 300 s (LF and HF by Lomb periodogram) |
| Systolic blood pressure (PTT-derived) | `1 Hz` | 1 mmHg, 60-260 mmHg |

## Bio-Monitor pitfalls (credibility notes)

Basis: Hexoskin's public API documentation (datatype registry and data resource), read 2026-11-14; not frozen in this build.

- **Its blood pressure is systolic-only and PTT-derived.** The Bio-Monitor's blood pressure is not a cuff reading. Its registry lists systolic pressure only, "derived from the PTT value" (the pulse transit time between the ECG QRS and the PPG), in a raw form and in a form "Adjusted for user specs". Consequence for the band: The band does not estimate blood pressure. Blood pressure is measured with the cuff in the vehicle medical kit and entered by hand: a hand-off.
- **The Nonin sensor adds a 172 ms delay.** The registry warns that "The Nonin PPG digital output is delayed by 172 ms", which must be subtracted when computing pulse transit time, and that the PPG channel "is not exactly aligned with the other channels (~0.05 s delay)". Consequence for the band: Every band channel is timestamped at acquisition on one clock, and each front end's fixed delay is written in the log header.
- **CSV and JSON exports cap at 65,536 values per datatype.** "For JSON and CSV formats, the result size is constrained to 65536 values per datatype": about 18 h at 1 Hz, so high-rate channels need the binary path. Consequence for the band: Pulse inter-beat intervals at 100 bpm reach 65,536 values in 10.9 h, so they leave the band in binary records; 1-min epochs would take 45.5 days to reach the cap.
  - Pulse intervals at 100 bpm: `10.9 h` (chip: derived) 65,536 / 6,000 beats per hour = 10.9 h
  - 1-min epochs: `45.5 days` (chip: derived) 65,536 / 1,440 epochs per day = 45.5 days

## Safety constraints

Basis: Vol 2 Rev F items are frozen in std_vol2_requirements. JSC-20793 Rev D (NTRS 20170009182) and NASA-STD-6001B w/Change 3 are public NASA documents, not frozen in this build; their numbers here were checked against them on 2026-11-14.

| Topic | Reference | Constraint | Chip |
|---|---|---|---|
| Leakage current, medical and bioinstrumentation equipment | `V2 9023`, `Table 9.3-11` | The band touches intact skin, read as External body contact: DC to 1 kHz, 0.1 mA normal and 0.5 mA single fault, the sum of all leakage currents. Footnote: prolonged DC contact carries a small risk of heating and tissue necrosis. The two ECG electrodes are the band's only conductive contacts: the inner one rests on the wrist, and a path across the chest exists only while the other hand touches the outer one during a spot check. | NASA-published |
| Current through the crewmember, general limits for any equipment | `V2 9019`, `V2 9020`, `V2 9021` | Nominal contact with conductive housing: 0.4 mA DC, 0.2 mA peak AC. Startle reaction, during critical operations: 2 mA DC, 0.5 mA AC. Catastrophic, all circumstances: 40 mA DC, 8 mA peak AC. For bioinstrumentation the stricter [V2 9023] applies. | NASA-published |
| Crew control of power | `V2 9017`, `V2 9018` | The crew must be able to interrupt power and see the de-energized status. The band has no switch or status light in this BOM: an open item. | NASA-published |
| Touch temperature | `V2 9102`, `V2 9103` | Tissue damage at 49 °C or above (Table 9.3-4); pain range 43 to 49 °C (Table 9.3-5). The LEDs stop at 41 °C at the skin-side sensor (design choice); the pulse LED runs around the clock, so the cut-off is always armed. | NASA-published |
| RF exposure | `V2 6102` | The BLE radio must keep crew RF exposure within Table 6.8-2. This is the only electromagnetic requirement in Vol 2. | NASA-published |
| Battery safety class | `JSC-20793 Rev D` | Non-Critical: under 4 Wh per isolated pack, Li-ion COTS up to 1000 mAh. Critical: single-fault tolerant, Li-ion COTS under 20 V and 60 Wh. Catastrophic: two-fault tolerant. Section 4.4.3: monitor cell voltage, cell temperature and current. | NASA-published |
| Materials in the habitable volume | `NASA-STD-6001B w/Change 3`, `NASA-STD-6016` | Test 1 upward flame propagation (five specimens of 30 × 6.5 cm; none may burn more than 15 cm), Test 4 electrical wire insulation flammability, Test 7 offgassed products (72 ± 1 h at 50 ± 3 °C; total T value below 0.5), Test 18 arc tracking. A material that is untested or fails these tests needs a Materials Usage Agreement (MUA) under NASA-STD-6016. | NASA-published |

Public copies of the documents not frozen in this build:
- JSC-20793 Rev D on NTRS (20170009182): https://ntrs.nasa.gov/citations/20170009182
- NASA-STD-6001B in the NASA Technical Standards System: https://standards.nasa.gov/standard/NASA/NASA-STD-6001

## Open items

- No schematic capture or PCB: block level only (KiCad not available).
- Every current in the power budget is an estimate; bench measurement replaces it.
- Battery monitoring: the MCP73831 has no thermistor input (verified on its datasheet) and the MAX17048's current and temperature measurement is not verified, so JSC-20793 section 4.4.3 is treated as not met. Fix: a gauge whose datasheet shows current and temperature measurement.
- Five datasheets were not read in this build (MAX30003, MAX86141, MAX30208, MAX17048, LSM6DSOX): confirm each part offers what the design assumes (256 sps ECG, a continuous low-power pulse channel plus an SpO2 mode, an accelerometer rate of 52 Hz, skin-range accuracy, I2C addressing) before selection.
- PRV against ECG: measure how far the band's pulse-interval SDNN departs from ECG SDNN in sleep; until then hrv_sdnn is compared only with the crewmember's own PRV baseline.
- Pulse wavelength: the design reuses the SpO2 infrared LED for the continuous pulse channel; choose the wavelength on the bench.
- No ECG viewer: LANDFALL does not show the spot-check strip to the Crew Medical Officer or put it in the ground packet yet.
- Confirm two TWI (I2C) instances on the nRF52840 beside SPI and QSPI in its product specification: the design uses two I2C buses.
- Prolonged DC contact: check every DC lead-bias and lead-off current of the ECG front end against Table 9.3-11 and its footnote, with the front end powered down between spot checks.
- No power switch or status light for [V2 9017] / [V2 9018].
- Power tree (front-end and LED supply rails) not designed.
- Electrode material, strap and housing materials not selected: NASA-STD-6001B testing or a Materials Usage Agreement is needed.
- Core body temperature is not derived: that needs a validated model.
- Check the MAX30208 addressing on the datasheet before layout; the two-bus split avoids the question for now.

## Build notes

How this build checked its sources (process notes, collapsed on the page).

- Five part datasheets (MAX30003, MAX86141, MAX30208, MAX17048, LSM6DSOX) are hosted on analog.com and st.com, which did not answer automated downloads during the build on 2026-11-14. Manufacturer claims drafted for those parts earlier were removed rather than kept unverified.
- The Bio-Monitor channel table, pitfalls and recorder facts were first transcribed before the hackathon from Hexoskin's documentation. On 2026-11-14 each was re-read on the public pages listed with the flown reference, and three were corrected: the recorder runs on replaceable AA batteries (its product page says it "is not rechargeable"); HERA Campaign 3 was a test meant to raise the TRL from 5 to 6, not a validation at that level; and the registry gives the systolic estimate at 1 Hz, so it is no longer called non-continuous.
- JSC-20793 Rev D and NASA-STD-6001B w/Change 3 were first read before the hackathon. On 2026-11-14 their numbers were re-checked in the public copies linked under Safety constraints, and the battery quotes were replaced by the documents' verbatim text.
- The ExMC Mars concept of operations (NTRS 20200001715), the PRV review (PMID 22809539) and the FDA De Novo summary DEN180044 were read in full text on 2026-11-14. None is frozen in this build, so the band test cannot re-check those quotes; each one links to its source.
- An earlier draft put two ECG electrodes on the inner face and took resting heart rate and HRV from their R-R intervals. Two electrodes on one wrist form no lead across the heart, so that could not work: heart rate and HRV now come from the optical pulse, and the ECG is an on-demand spot check closed by the other hand.
