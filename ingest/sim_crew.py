"""Simulated crew scenario (engine/SPEC.md section 7): build-time, seeded, labelled.

    uv run python -m ingest sim

Writes web/public/data/sim_crew.json (provenance "simulated"). Four fictional
crewmembers CM-1..CM-4, MET days 368-412, baseline days 368-381, "now" = MET 412/14:20:00.
No public time series of real crew wearable data exists, so continuous crew vitals are
simulated; the real inputs are the SPE shape (NOAA GOES-7, October 1989), the Mars-surface
dose baseline (MSL RAD) and the conjunction calendar (modelled from JPL Horizons geometry),
read from their own snapshots when present. Generator: ingest/_sim_model.py (crew),
ingest/_sim_env.py (environment).

Day-to-day noise follows published within-person values where they exist (each one cited
below, PubMed pages); everything else is labelled design choice. data.self_check reports
what Tier B's single-case test does and does not detect in this exact data.
"""

from __future__ import annotations

import json
import math
from datetime import timedelta
from pathlib import Path

from ingest import _sim_env as env
from ingest import _sim_model as model
from ingest.common import REPO_ROOT, RunContext, make_snapshot, to_iso_z

ADAPTER_ID = "sim"
DEPENDS_ON = ["swpc", "hapi", "horizons", "osdr"]
SNAPSHOT_ID = "sim_crew"
REPO_URL = "https://github.com/amaroguilherme/landfall"
GENERATOR_URL = f"{REPO_URL}/blob/main/ingest/sim_crew.py"
RULES_DIR = REPO_ROOT / "engine" / "rules"


def _lit(citation: str, pmid: str, note: str | None = None) -> dict:
    src = {"kind": "literature", "citation": citation, "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"}
    if note:
        src["note"] = note
    return src


BARGER_2014 = _lit("Barger LK, Flynn-Evans EE, Kubey A, Walsh L, Ronda JM, Wang W, Wright KP Jr, Czeisler CA. "
                   "Prevalence of sleep deficiency and use of hypnotic drugs in astronauts before, during, and after "
                   "spaceflight: an observational study. Lancet Neurol 2014;13(9):904-912. "
                   "doi:10.1016/S1474-4422(14)70122-X. PMID 25127232", "25127232")
BASNER_2011 = _lit("Basner M, Mollicone D, Dinges DF. Validity and sensitivity of a brief psychomotor vigilance test "
                   "(PVT-B) to total and partial sleep deprivation. Acta Astronaut 2011;69(11-12):949-959. "
                   "doi:10.1016/j.actaastro.2011.07.015. PMID 22025811", "22025811")
BASNER_2018 = _lit("Basner M, Hermosillo E, Nasrini J, McGuire S, Saxena S, Moore TM, Gur RC, Dinges DF. Repeated "
                   "administration effects on psychomotor vigilance test performance. Sleep 2018;41(1):zsx187. "
                   "doi:10.1093/sleep/zsx187. PMID 29126328", "29126328")
FLYNN_EVANS_2016 = _lit("Flynn-Evans EE, Barger LK, Kubey AA, Sullivan JP, Czeisler CA. Circadian misalignment affects "
                        "sleep and medication use before and during spaceflight. NPJ Microgravity 2016;2:15019. "
                        "doi:10.1038/npjmgrav.2015.19. PMID 28725719", "28725719")
KNUTSON_2007 = _lit("Knutson KL, Rathouz PJ, Yan LL, Liu K, Lauderdale DS. Intra-individual daily and yearly "
                    "variability in actigraphically recorded sleep measures: the CARDIA study. Sleep "
                    "2007;30(6):793-796. doi:10.1093/sleep/30.6.793. PMID 17580601", "17580601")
HUANG_REDLINE_2019 = _lit("Huang T, Redline S. Cross-sectional and prospective associations of actigraphy-assessed "
                          "sleep regularity with metabolic abnormalities: the Multi-Ethnic Study of Atherosclerosis. "
                          "Diabetes Care 2019;42(8):1422-1429. doi:10.2337/dc19-0596. PMID 31167888", "31167888")
QUER_2020 = _lit("Quer G, Gouda P, Galarnyk M, Topol EJ, Steinhubl SR. Inter- and intraindividual variability in daily "
                 "resting heart rate and its associations with age, sex, sleep, BMI, and time of year: retrospective, "
                 "longitudinal cohort study of 92,457 adults. PLoS One 2020;15(2):e0227709. "
                 "doi:10.1371/journal.pone.0227709. PMID 32023264", "32023264")
BELLENGER_2022 = _lit("Bellenger CR, Miller D, Halson SL, Roach GD, Maclennan M, Sargent C. Evaluating the typical "
                      "day-to-day variability of WHOOP-derived heart rate variability in Olympic water polo athletes. "
                      "Sensors (Basel) 2022;22(18):6723. doi:10.3390/s22186723. PMID 36146073", "36146073")
NAYAN_2012 = _lit("Nayan M, Elkoushy MA, Andonian S. Variations between two 24-hour urine collections in patients "
                  "presenting to a tertiary stone clinic. Can Urol Assoc J 2012;6(1):30-33. doi:10.5489/cuaj.11131. "
                  "PMID 22396364", "22396364")
NORSK_2015 = _lit("Norsk P, Asmar A, Damgaard M, Christensen NJ. Fluid shifts, vasodilatation and ambulatory blood "
                  "pressure reduction during long duration spaceflight. J Physiol 2015;593(3):573-584. "
                  "doi:10.1113/jphysiol.2014.284869. PMID 25774397", "25774397")
SELVIN_2007 = _lit("Selvin E, Crainiceanu CM, Brancati FL, Coresh J. Short-term variability in measures of glycemia "
                   "and implications for the classification of diabetes. Arch Intern Med 2007;167(14):1545-1551. "
                   "doi:10.1001/archinte.167.14.1545. PMID 17646610", "17646610")
MATSUI_2012 = _lit("Matsui Y, O'Rourke MF, Hoshide S, Ishikawa J, Shimada K, Kario K. Combined effect of angiotensin II "
                   "receptor blocker and either a calcium channel blocker or diuretic on day-by-day variability of home "
                   "blood pressure: the Japan Combined Treatment With Olmesartan and a Calcium-Channel Blocker Versus "
                   "Olmesartan and Diuretics Randomized Efficacy Study. Hypertension 2012;59(6):1132-1138. "
                   "doi:10.1161/HYPERTENSIONAHA.111.189217. PMID 22547439", "22547439")
JUHANOJA_2017 = _lit("Juhanoja EP, Niiranen TJ, Johansson JK, Puukka PJ, Thijs L, Asayama K, Langén VL, Hozawa A, "
                     "Aparicio LS, Ohkubo T, Tsuji I, Imai Y, Stergiou GS, Jula AM, Staessen JA; IDHOCO Investigators. "
                     "Outcome-driven thresholds for increased home blood pressure variability. Hypertension "
                     "2017;69(4):599-607. doi:10.1161/HYPERTENSIONAHA.116.08603. PMID 28193705", "28193705")
V2_6165_TEXT = ("The program shall monitor the in-situ extravehicular space weather environment including the "
                "external exposure rates, electron flux spectra, and proton flux spectra.")
V2_6165 = {"kind": "nasa_standard", "doc": "NASA-STD-3001 Vol. 2 Rev. F", "requirement_id": "V2 6165",
           "section": "6.8.1.7", "page": 112, "url": "https://www.nasa.gov/reference/nasa-std-3001v2/",
           "snapshot": "std_vol2_requirements", "verbatim": V2_6165_TEXT}
NO_NASA_LIMIT = ("NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert "
                 "requirements leave the number to the program. LANDFALL compares this reading only with the "
                 "crewmember's own baseline (Tier B, caution at most), never with a population cut-off.")


def _dc(rationale: str) -> dict:
    return {"kind": "design_choice", "rationale": rationale}


def _cal(item: str, value: str, chip: str, source: dict) -> dict:
    return {"item": item, "value": value, "chip": chip, "source": source}


def _derived(arithmetic: str, *inputs: dict) -> dict:
    return {"kind": "derived", "from": [s["citation"].rsplit(". ", 1)[-1] if s.get("kind") == "literature"
                                        else s.get("rationale", "design choice") for s in inputs],
            "arithmetic": arithmetic, "inputs": list(inputs)}


def _fmt(x: float, nd: int = 1) -> str:
    s = f"{x:,.{nd}f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


NOISE_NOTE = ("Day-to-day noise is a plain draw from the noise model on every baseline and ordinary day; nothing is "
              "trimmed or rejection-sampled. More noise lowers Tier B's sensitivity (its smallest flaggable change, "
              "critical x SD x sqrt(1 + 1/n), grows with the SD); it does not raise the chance false-alarm rate, "
              "which stays at alpha under normal, independent noise.")
URINE_SD = model.URINE_SD_ML
FLUID_SD = model.NOISE["fluid_intake_24h"]["sd"]
GLUCOSE_CV_PCT = 100 * model.GLUCOSE_CV
VITALS_DAYS = model.manual_vitals_days()
VITALS_CADENCE = ("daily on the 14 baseline days (MET 368-381), then twice a week (MET days "
                  + ", ".join(str(d) for d in VITALS_DAYS if d > model.BASELINE_LAST)
                  + "), 30 min after wake, seated, before breakfast")

VARIABLE_META: dict[str, dict] = {
    "sleep_duration": {
        "label": "Sleep duration (actigraphy)", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "Total sleep time of the main sleep episode ending on that MET day, from band actigraphy.",
        "calibration": [
            _cal("crew mean nightly sleep", "5.95-6.30 h", "literature",
                 {**BARGER_2014, "note": "ISS crew obtained 6.09 h (SD 0.67) of actigraphic sleep per night in flight."}),
            _cal("night-to-night SD", "1.2 h", "literature",
                 {**FLYNN_EVANS_2016, "note": "Table 3: in-flight ISS actigraphic sleep 6.4 h (s.d. 1.2) on circadian-"
                                             "aligned and 5.4 h (s.d. 1.4) on misaligned sleep episodes (21 astronauts, "
                                             "3,248 in-flight days). Those episodes come from all crewmembers together, "
                                             "so the SD also holds differences between crewmembers: an upper-side "
                                             "estimate of one person's night-to-night SD."}),
            _cal("free-living comparison", "1.26 h within-subject night-to-night SD", "literature",
                 {**KNUTSON_2007, "note": "Within-subject daily SD of actigraphic sleep duration, 669 adults aged "
                                          "38-50 (CARDIA)."}),
            _cal("bounds", "draws clipped to 2.5-9.0 h", "design choice",
                 _dc("Keeps rare tail draws physically plausible for a fixed sleep period.")),
            _cal("CM-1 after the day-403 schedule shift", "4.30-4.55 h", "design choice",
                 _dc("Scripted short sleep opportunity (about 5 h in bed); same order as the 4-h time-in-bed partial "
                     "sleep deprivation protocol used to validate the PVT-B (Basner 2011). Not tuned for Tier B."))]},
    "sleep_midpoint_shift": {
        "label": "Sleep midpoint shift (absolute)", "cadence": "daily (stamped at wake)",
        "definition": "Absolute difference, in hours, between the night's sleep midpoint and the median midpoint of "
                      "the crewmember's baseline nights (MET days 368-381), with clock arithmetic across midnight. "
                      "Always >= 0: an earlier and a later shift both count as an increase (engine/rules/personal.json).",
        "calibration": [
            _cal("night-to-night SD of the midpoint", "0.6 h (36 min)", "design choice",
                 _dc("No published within-crewmember value was found. Free-living older adults averaged a 58-min "
                     "weekday sleep-onset SD in MESA (next entry); a fixed mission sleep period should be more "
                     "regular. At the MESA value Tier B would rarely flag CM-1's shift (data.self_check, "
                     "tier_b_detection_probability_at_alt_sd).")),
            _cal("free-living comparison", "58 min weekday sleep-onset SD (64 min over 7 days)", "literature",
                 {**HUANG_REDLINE_2019, "note": "Mean 7-day SD in 2,003 MESA participants; the paper reports that "
                                                "sleep-onset and sleep-midpoint SDs correlate at r = 0.97."}),
            _cal("reference schedule", "sleep period 22:00-06:00 MET (midpoint 02:00)", "design choice",
                 _dc("Places the sleep episodes (data.crew[*].sleep_episodes) on the MET clock; the emitted shift is "
                     "measured from the baseline median, not from 02:00.")),
            _cal("CM-1 after the 3-h schedule shift", "midpoint 2.30-2.55 h after 02:00 MET", "design choice",
                 _dc("Partial adaptation to a 3-h later schedule. Not tuned for Tier B."))]},
    "pvt_lapses": {
        "label": "PVT-B lapses", "cadence": "daily, 1 h after wake (3-min PVT-B)",
        "definition": "Number of responses with reaction time >= 355 ms on the 3-min PVT-B (a count).",
        "calibration": [
            _cal("lapse definition", "RT >= 355 ms on the 3-min PVT-B", "literature",
                 {**BASNER_2011, "note": "The paper lowers the PVT-B lapse threshold from 500 ms to 355 ms. No NASA "
                                         "standard adopts 355 ms; it is attributed to the paper only."}),
            _cal("rested baseline", "Poisson counts, mean 0.9-1.2 lapses per test", "design choice",
                 _dc("A count, not a normal variable: one Poisson draw per test, the model engine/rules/personal.json "
                     "uses for its chance-rate study. No published rested PVT-B lapse rate at 355 ms was used.")),
            _cal("CM-1 episode", "2-6 lapses on days 404-412", "design choice",
                 _dc("A moderate rise, in line with the medium effect size Basner et al. 2011 report for 5 nights of "
                     "4 h in bed (0.76 for PVT-B lapses at the 355-ms threshold); the exact values are ours. Not "
                     "tuned for Tier B."))]},
    "pvt_median_rt": {
        "label": "PVT-B median reaction time", "cadence": "daily, with the PVT-B",
        "definition": "Median reaction time of the 3-min PVT-B, in ms.",
        "calibration": [
            _cal("rested baseline", "246-259 ms", "design choice", _dc("Plausible values; not fitted.")),
            _cal("day-to-day SD", "14 ms", "design choice",
                 _dc("No published within-person day-to-day SD of the 3-min PVT-B median was found; 14 ms is ours.")),
            _cal("no practice trend", "stationary baseline", "literature",
                 {**BASNER_2018, "note": "Mean and median RT, response speed and lapses did not change systematically "
                                         "over 16 PVT-B administrations, so no learning trend is added."}),
            _cal("CM-1 episode", "259-284 ms on days 404-412", "design choice",
                 _dc("Moderate slowing that accompanies the lapse rise. Not tuned for Tier B."))]},
    "light_exposure_daytime": {
        "label": "Daytime light exposure", "cadence": "daily (wake period, stamped at the next sleep onset)",
        "definition": "Mean photopic illuminance over the wake period, from the band light sensor.",
        "calibration": [_cal("habitat daytime mean", "229-251 lux, day-to-day SD 20% of the mean", "design choice",
                             _dc("No verified habitat illuminance value was used; unchanged through the episodes. "
                                 "A non-alerting context indicator."))]},
    "resting_hr": {
        "label": "Resting heart rate", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "Lowest stable 5-min heart rate during the main sleep episode, from band PPG inter-beat "
                      "intervals (engine/rules/personal.json).",
        "calibration": [
            _cal("crew values", "52-58 bpm", "design choice", _dc("Plausible values; not fitted.")),
            _cal("day-to-day SD", "3.0 bpm", "literature",
                 {**QUER_2020, "note": "Average within-individual SD of daily resting HR over time: 3.03 bpm (3.10 "
                                       "women, 2.90 men), wrist-worn trackers, median 320 days per person. It spans "
                                       "seasons, so a 2-week SD may be slightly smaller."})]},
    "hrv_sdnn": {
        "label": "HRV (SDNN)", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "SDNN of normal-to-normal intervals in 5-min (300-s) windows during the main sleep episode, "
                      "averaged; from band PPG inter-beat intervals.",
        "calibration": [
            _cal("window length", "300 s", "design choice",
                 _dc("Short windows in sleep keep recording conditions comparable from night to night.")),
            _cal("crew values", "54-67 ms", "design choice", _dc("Plausible values; not fitted.")),
            _cal("day-to-day SD", "15% of the mean", "design choice",
                 _dc("No published night-to-night SD of sleep SDNN was found. For context, Bellenger et al. 2022 "
                     "report a mean 7-day CV of 5.4% for overnight ln RMSSD (a log-scale index) and 7.6% for "
                     "overnight HR in elite athletes (next entry).")),
            _cal("wearable comparison", "7-day CV: ln RMSSD 5.4%, HR 7.6%", "literature",
                 {**BELLENGER_2022, "note": "WHOOP-derived overnight values, 11 elite water polo players, 16 weeks."})]},
    "skin_temp": {
        "label": "Skin temperature", "cadence": "daily (main sleep episode, stamped at wake)",
        "definition": "Median skin temperature during the main sleep episode, from the band.",
        "calibration": [_cal("crew values", "34.1-34.4 °C, day-to-day SD 0.3 °C", "design choice",
                             _dc("Plausible values; not fitted. Skin temperature follows cabin temperature and "
                                 "clothing, so it is a non-alerting context indicator."))]},
    "urine_volume_24h": {
        "label": "24-h urine output", "cadence": "daily (MET-midnight to MET-midnight collection, stamped at its end)",
        "definition": "Volume of the 24-h urine collection for that MET day, entered manually.",
        "calibration": [
            _cal("case levels", "outside below 1,500 mL/day; approaching below 2,500 mL/day", "design choice",
                 _dc("The levels are owned and sourced by rule target_urine_output_24h in engine/rules/thresholds.json "
                     "(NASA HRP Evidence Report, Risk of Renal Stone Formation); the generator never tunes values "
                     "to them, except that it refuses to ship an unscripted day below 1,500 mL, which would open a "
                     "case nobody scripted.")),
            _cal("crew means", "2,900-3,000 mL/day", "design choice",
                 _dc("A crew following the hydration countermeasure, whose target is 2.5-3 L/day of urine (quoted by "
                     "rule target_urine_output_24h).")),
            _cal("spaceflight comparison", "1,832 mL per 24 h in flight", "literature",
                 {**NORSK_2015, "note": "Table 1: 24-h urine volume of eight ISS astronauts in flight (1,978 mL "
                                        "preflight)."}),
            _cal("day-to-day SD", f"{_fmt(URINE_SD)} mL", "derived",
                 _derived(f"sd = mean |difference| x sqrt(pi) / 2 = {model.URINE_MEAN_ABS_DIFF_ML} x 0.8862 = "
                          f"{_fmt(URINE_SD)} mL (two independent normal days: E|X1 - X2| = 2 sd / sqrt(pi))",
                          {**NAYAN_2012, "note": "Table 1: mean absolute difference between two consecutive-day 24-h "
                                                 "urine volumes, 385.4 mL (95% CI 334.3-436.5), 188 stone-clinic "
                                                 "patients."})),
            _cal("CM-3 episode, days 398-401", "1,340-1,450 mL", "design choice",
                 _dc("Below the 1,500 mL/day level on every episode day (the scripted Tier A crossing). Not tuned for "
                     "Tier B: whether it is also a reliable change against CM-3's own noisy baseline is tested in "
                     "data.self_check."))]},
    "fluid_intake_24h": {
        "label": "24-h fluid intake", "cadence": "daily (same window as the urine collection)",
        "definition": "Logged fluid intake for that MET day.",
        "calibration": [
            _cal("baseline", f"urine mean + {_fmt(model.FLUID_MINUS_URINE_ML, 0)} mL", "design choice",
                 _dc("Intake exceeds output by food water, sweat and insensible losses; plausible, not fitted.")),
            _cal("day-to-day SD", f"{_fmt(FLUID_SD)} mL", "derived",
                 _derived(f"the day's urine noise ({_fmt(URINE_SD)} mL, shared: drinking drives output) plus an "
                          f"independent {_fmt(model.FLUID_EXTRA_SD_ML, 0)}-mL spread of intake minus output: "
                          f"sqrt({_fmt(URINE_SD)}^2 + {_fmt(model.FLUID_EXTRA_SD_ML, 0)}^2) = {_fmt(FLUID_SD)} mL",
                          NAYAN_2012, _dc("150-mL spread of the intake-output difference"))),
            _cal("CM-3 episode, days 398-401", "1,840-2,010 mL", "design choice",
                 _dc("Intake falls with output, as SPEC section 7 describes."))]},
    "mood": {
        "label": "Mood (self-report)", "cadence": "daily at the 12:00 MET check-in (Noon Sight)",
        "definition": "Self-rated mood, integer 1-5. PRIVATE by default and NON-ALERTING (SPEC 3.3, 7).",
        "private": True, "alerting": False,
        "calibration": [_cal("all crew", "mostly 3-4; CM-1 dips to 2-3 during the sleep episode", "design choice",
                             _dc("Never alerts; excluded from the ground packet unless the crewmember consents."))]},
    "bp_systolic": {
        "label": "Blood pressure, systolic (cuff)", "cadence": VITALS_CADENCE,
        "device": "vehicle medical kit cuff",
        "definition": "Systolic pressure of a seated cuff reading from the vehicle medical kit, taken by the "
                      "crewmember and entered manually.",
        "nasa_limit": NO_NASA_LIMIT,
        "calibration": [
            _cal("crew values", "109-118 mmHg", "design choice", _dc("Healthy-adult values; not fitted.")),
            _cal("spaceflight comparison", "24-h systolic 8 ± 2 mmHg below preflight on ISS", "literature",
                 {**NORSK_2015, "note": "Ambulatory 24-h averages of eight ISS astronauts (mean ± SE); systolic "
                                        "8 ± 2, diastolic 9 ± 2 mmHg lower in space."}),
            _cal("day-to-day SD", "6 mmHg (diastolic 5 mmHg, correlation 0.6)", "design choice",
                 _dc("No day-to-day home-BP SD of healthy crew-age adults was found to use directly. Context: the "
                     "within-individual SD of 5-day home systolic BP was 6.3-7.1 mmHg in treated hypertensive "
                     "patients (Matsui et al. 2012), and a day-to-day CV above 11.0% systolic / 12.8% diastolic marks "
                     "the top decile of 6,238 adults (Juhanoja et al. 2017).")),
            _cal("treated-hypertensive comparison", "5-day home systolic SD 6.3-7.1 mmHg", "literature", MATSUI_2012),
            _cal("population comparison", "top decile: day-to-day CV > 11.0% systolic, > 12.8% diastolic",
                 "literature", JUHANOJA_2017),
            _cal("protocol", "daily for the 14 baseline days, then twice a week", "design choice",
                 _dc("A 14-value baseline gives this indicator the same single-case test as the daily ones (n = 14, "
                     "df 13); twice a week afterwards keeps the measurement burden low."))]},
    "bp_diastolic": {
        "label": "Blood pressure, diastolic (cuff)", "cadence": VITALS_CADENCE,
        "device": "vehicle medical kit cuff",
        "definition": "Diastolic pressure of the same seated cuff reading, entered manually.",
        "nasa_limit": NO_NASA_LIMIT,
        "calibration": [
            _cal("crew values", "68-75 mmHg", "design choice", _dc("Healthy-adult values; not fitted.")),
            _cal("day-to-day SD", "5 mmHg, correlated 0.6 with systolic", "design choice",
                 _dc("See bp_systolic; the correlation keeps the two pressures of one reading moving together.")),
            _cal("population comparison", "top decile: day-to-day CV > 12.8% diastolic", "literature", JUHANOJA_2017)]},
    "glucose": {
        "label": "Fasting glucose (fingerstick)", "cadence": VITALS_CADENCE,
        "device": "glucometer (vehicle medical kit)",
        "definition": "Capillary glucose from a fingerstick glucometer, fasting, taken by the crewmember and entered "
                      "manually.",
        "nasa_limit": NO_NASA_LIMIT,
        "calibration": [
            _cal("crew values", "86-94 mg/dL", "design choice", _dc("Healthy fasting values; not fitted.")),
            _cal("within-person CV of fasting glucose", "5.7%", "literature",
                 {**SELVIN_2007, "note": "Within-person CV 5.7% (95% CI 5.3-6.1) for repeat fasting tests about 2 "
                                         "weeks apart, 685 adults without diagnosed diabetes (NHANES III)."}),
            _cal("meter imprecision", "3% CV", "design choice",
                 _dc("Fingerstick meters add their own error; 3% is ours.")),
            _cal("day-to-day CV used", f"{GLUCOSE_CV_PCT:.1f}%", "derived",
                 _derived(f"sqrt(5.7^2 + 3.0^2) = {GLUCOSE_CV_PCT:.2f}% of the crewmember's mean", SELVIN_2007,
                          _dc("3% meter imprecision")))]},
    "vo2max": {
        "label": "VO2max (periodic fitness test)", "cadence": f"MET days {', '.join(map(str, model.FITNESS_TEST_DAYS))} at 10:00",
        "definition": "Aerobic capacity from the periodic in-flight fitness test.",
        "calibration": [
            _cal("CM-2 latest test (day 411)", "35.1 ml/min/kg", "design choice",
                 _dc("Set by SPEC section 7 for the FFD demo: within the [V1 4001] microgravity-EVA floor (32.9) and "
                     "outside the [V1 4002] surface-EVA floor (36.5). The floors themselves live in thresholds.json.")),
            _cal("CM-1, CM-3, CM-4", "41.1-45.6 ml/min/kg, slowly declining", "design choice",
                 _dc("Comfortably above both floors so only CM-2 flips with the environment selector."))]},
    "career_effective_dose": {
        "label": "Career effective dose to date (prior)", "cadence": "one value per crewmember, at MET 412/00:00",
        "definition": "Career effective dose to date before the SPE day, as it would come from the dosimetry record.",
        "calibration": [_cal("CM-1..CM-4", "356-412 mSv", "design choice",
                             _dc("Not computed from any transport model. Chosen below 480 mSv (80% of the "
                                 "[V1 4030] 600 mSv limit) so the SPE case is driven by the event, not by the career "
                                 "limit. The SPE day's absorbed dose is NOT added: LANDFALL does not convert µGy to "
                                 "mSv."))]},
    "heart_rate": {
        "label": "Heart rate (1-min)", "cadence": "PT1M, MET day 412 only, 00:00 to now",
        "definition": "1-min mean heart rate from band PPG inter-beat intervals.",
        "calibration": [_cal("sleep / wake / exercise levels", "resting value + 2.5 / ~70 bpm / ~136-144 bpm",
                             "design choice",
                             _dc("Plausible values; the sleep segment sits just above that night's resting_hr (the "
                                 "lowest stable 5-min rate)."))]},
    "cabin_ppco2": {
        "label": "Cabin ppCO2 (1-h mean)", "cadence": "PT1H from the vehicle ECLSS",
        "definition": "1-hour mean cabin CO2 partial pressure; value k covers [start + k h, start + (k+1) h).",
        "calibration": [_cal("habitat level", f"about 1.8-2.2 mmHg, never above {model.PPCO2_CAP_MMHG}", "design choice",
                             _dc("Kept below the 2.4 mmHg approach level of rule pel_cabin_ppco2_1h in engine/rules/"
                                 "thresholds.json (and the [V2 6004] 1-h mean limit of 3 mmHg) so it never competes "
                                 "with the scripted cases."))]},
    "onboard_dose_rate": {
        "label": "Habitat dose rate (simulated confirmation)", "cadence": "PT5M, MET day 412 only",
        "definition": "Absorbed dose rate inside the habitat, SIMULATED as a confirmation signal separate from the "
                      "external proton reading: the measured MSL RAD quiet-time surface rate plus the replayed flux "
                      "profile under an assumed scaling (S3-level flux = 10x the quiet rate; design choice, not a "
                      "radiation-transport calculation). Absorbed dose (Gy) is not effective dose (Sv). The vehicle "
                      "radiation monitoring system raises the radiation alarm ([V2 6164]); LANDFALL opens the health "
                      "case that follows.",
        "provenance": "simulated",
        "calibration": []},  # filled from the SPE build (real vs fallback)
    "proton_flux_10mev": {
        "label": "External space-weather monitor: >=10 MeV proton flux (above the atmosphere, relayed)",
        "cadence": "PT5M, MET day 412 (the replay continues after 'now' in after_now)",
        "definition": "Integral proton flux above 10 MeV in pfu (particles cm^-2 s^-1 sr^-1), the quantity the NOAA "
                      "S-scale is defined on, as reported by the scenario's external space-weather monitor above the "
                      "Martian atmosphere (in Mars orbit) and relayed to the habitat locally, with no Earth link: the "
                      "in-situ monitoring [V2 6165] requires ('" + V2_6165_TEXT + "'). Scenario values are the GOES-7 "
                      "October 1989 >=10 MeV replay, time-shifted only, with NO radial-distance or atmospheric "
                      "correction (a labelled scenario assumption). The rules apply NOAA's S3 level to it at Mars as "
                      "a design choice (engine/rules/thresholds.json).",
        "provenance": "replay",
        "calibration": []},  # filled from the SPE build (real vs fallback)
}

UNITS = {v: u for v, (u, _s, _n) in model.VARIABLES.items()}
UNITS.update({"vo2max": "ml/min/kg", "career_effective_dose": "mSv", "heart_rate": "bpm",
              "cabin_ppco2": "mmHg", "onboard_dose_rate": "uGy/day", "proton_flux_10mev": "pfu"})
SOURCES = {v: s for v, (_u, s, _n) in model.VARIABLES.items()}
SOURCES.update({"vo2max": "vehicle", "career_effective_dose": "app", "heart_rate": "band",
                "cabin_ppco2": "vehicle", "onboard_dose_rate": "vehicle",
                "proton_flux_10mev": "replay"})  # "vehicle" when the event shape is the synthetic fallback
# Tier B indicators the rules may not list yet (worse direction used by the self-check only).
DEFAULT_INDICATORS = {
    "bp_systolic": {"worse": "increase", "alerting": True},
    "bp_diastolic": {"worse": "increase", "alerting": True},
    "glucose": {"worse": "either", "alerting": True},
}


def _series(var: str, pts: list[tuple[int, float | int]]) -> dict:
    return {"unit": UNITS[var], "source": SOURCES[var], "t": [t for t, _ in pts], "v": [v for _, v in pts]}


def build_crew() -> tuple[list[dict], dict[str, dict]]:
    crew_out, timelines = [], {}
    for c in model.CREW:
        tl = model.crew_timeline(c)
        timelines[c["id"]] = tl
        series = {var: _series(var, tl["points"][var]) for var in model.PERSONAL_VARIABLES}
        series["vo2max"] = _series("vo2max", tl["vo2max"])
        series["career_effective_dose"] = _series("career_effective_dose",
                                                  [(model.met_s(412), c["career_effective_dose"])])
        hr = model.intraday_heart_rate(c, tl["episodes_by_day"][412], tl["daily"]["resting_hr"][412])
        crew_out.append({
            "crew_id": c["id"], "role": c["role"], "fictional": True,
            "series": series,
            "intraday": {"heart_rate": {"unit": "bpm", "source": "band", "start_t": model.met_s(412), "step_s": 60,
                                        "n": len(hr), "v": hr}},
            "sleep_episodes": {"note": "[onset_t, offset_t] MET seconds of the main sleep episode ending on each "
                                       f"MET day {model.FIRST_DAY}-{model.LAST_DAY}",
                               "days": [model.FIRST_DAY, model.LAST_DAY], "v": tl["sleep_episodes"]},
        })
    return crew_out, timelines


# ------------------------------------------------------------------ rules (read only, for the self-check)
def _read_rules(name: str) -> dict | None:
    p = RULES_DIR / name
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def report_indicators() -> list[dict]:
    """Tier B indicators to check: engine/rules/personal.json first, then any emitted variable it lacks."""
    personal = _read_rules("personal.json") or {}
    out, seen = [], set()
    for ind in personal.get("indicators", []):
        var = ind.get("variable")
        if var in model.VARIABLES and var != "mood" and ind.get("worse") in ("increase", "decrease", "either"):
            out.append({"id": ind["id"], "variable": var, "worse": ind["worse"],
                        "alerting": bool(ind.get("alerting")), "case_id": ind.get("case_id"), "in_rules": True})
            seen.add(var)
    for var, d in DEFAULT_INDICATORS.items():
        if var not in seen:
            out.append({"id": var, "variable": var, **d, "case_id": None, "in_rules": False})
    return out


def renal_rule() -> dict | None:
    t = _read_rules("thresholds.json") or {}
    r = next((x for x in t.get("rules", []) if x.get("id") == "target_urine_output_24h"), None)
    if not r:
        return None
    return {"rule_id": r["id"], "op": r["op"], "limit": r["limit"],
            "approach": (r.get("approach_at") or {}).get("value")}


def _days(ds: list[int]) -> str:
    if not ds:
        return "none"
    runs, start, prev = [], ds[0], ds[0]
    for d in ds[1:] + [None]:
        if d is not None and d == prev + 1:
            prev = d
            continue
        runs.append(str(start) if start == prev else f"{start}-{prev}")
        if d is not None:
            start = prev = d
    return ", ".join(runs)


def self_check(timelines: dict[str, dict]) -> dict:
    inds = report_indicators()
    renal = renal_rule()
    rep = model.tier_b_report(timelines, inds, renal)
    # Tier A side of the urine data: which ordinary days reach the rule's approach level.
    urine_a = None
    if renal:
        below_app, below_out = [], []
        for cid, tl in timelines.items():
            for t, v in tl["points"]["urine_volume_24h"]:
                d = model.measurement_day(t)
                if renal.get("approach") is not None and v < renal["approach"]:
                    below_app.append({"crew_id": cid, "day": d, "value": v})
                if v < renal["limit"]:
                    below_out.append({"crew_id": cid, "day": d, "value": v})
        n_days = sum(len(tl["points"]["urine_volume_24h"]) for tl in timelines.values())
        urine_a = {"rule_id": renal["rule_id"], "outside_below_ml": renal["limit"],
                   "approaching_below_ml": renal.get("approach"), "crew_days": n_days,
                   "below_outside": below_out, "below_approach": below_app,
                   "note": "Ordinary days below the approach level are real noise, not a scripted episode: the rule "
                           "reports them as 'approaching' (advisory). Only CM-3's scripted days fall below the outside "
                           "level."}
    summary = []
    for ep in model.EPISODES:
        rows = [r for r in rep["episodes"] if r["episode_id"] == ep["id"]]
        parts = []
        for r in rows:
            p = list(r["tier_b_detection_probability"].values())
            flagged = r["tier_b_flagged_days"]
            txt = (f"{r['variable']}: Tier B flags MET day(s) {_days(flagged)}" if flagged
                   else f"{r['variable']}: Tier B flags no scripted day")
            txt += f" (detection probability per scripted day under this noise model {min(p):.2f}-{max(p):.2f})"
            if "tier_a" in r:
                txt += f"; Tier A {r['tier_a']['rule_id']} is outside on day(s) {_days(r['tier_a']['outside_days'])}"
            parts.append(txt)
        summary.append(f"{ep['id']} ({ep['crew_id']}, case {ep['case_id']}): " + "; ".join(parts) + ".")
    ch = rep["chance_flags"]
    if ch:
        summary.append("Unscripted reliable changes (chance, from real-size noise): " + "; ".join(
            f"{c['crew_id']} {c['variable']} day {c['day']} (t = {c['t']}, {c['direction']}, "
            f"{c['severity']})" for c in ch) + ".")
    else:
        summary.append("No unscripted reliable change on any crewmember, indicator or day.")
    # A chance caution on a case trigger opens that case unless a scripted trigger opened it earlier.
    first_scripted = {}
    for r in rep["episodes"]:
        if r["tier_b_flagged_days"]:
            k = (r["crew_id"], r["case_id"])
            first_scripted[k] = min(first_scripted.get(k, 10 ** 9), r["tier_b_flagged_days"][0])
        if r.get("tier_a", {}).get("outside_days"):
            k = (r["crew_id"], r["case_id"])
            first_scripted[k] = min(first_scripted.get(k, 10 ** 9), r["tier_a"]["outside_days"][0])
    openings = {}
    for c in ch:
        if not c.get("case_id"):
            continue
        k = (c["crew_id"], c["case_id"])
        if c["day"] < first_scripted.get(k, 10 ** 9) and c["day"] < openings.get(k, {}).get("day", 10 ** 9):
            openings[k] = {"crew_id": c["crew_id"], "case_id": c["case_id"], "day": c["day"],
                           "indicator_id": c["indicator_id"], "t": c["t"],
                           "scripted_opening_day": first_scripted.get(k)}
    unscripted = sorted(openings.values(), key=lambda o: (o["crew_id"], o["case_id"]))
    if unscripted:
        summary.append("So the app, which opens a case at a trigger's first caution, opens these cases from chance "
                       "flags alone: " + "; ".join(
                           f"{o['crew_id']} {o['case_id']} on MET day {o['day']} ({o['indicator_id']}, t = {o['t']}"
                           + (f"; its scripted episode starts on day {o['scripted_opening_day']})"
                              if o["scripted_opening_day"] else "; no scripted episode)") for o in unscripted) + ".")
    rates = model.chance_rates(inds)
    inflated = [f"{k} {v['ratio_to_nominal']}x" for k, v in rates.items()
                if v["ratio_to_nominal"] is not None and v["ratio_to_nominal"] >= 2]
    if inflated:
        summary.append("Chance-caution rates with no real change (data.self_check.chance_rates): the skewed "
                       "indicators exceed the printed alpha/2 = 0.0005 per indicator-day (seeded Monte Carlo with "
                       "this noise model): " + ", ".join(inflated) + "; the normally distributed ones sit at it "
                       "exactly, because the test is exact for normal, independent noise.")
    return {
        "method": "SPEC section 5 single-case t (Crawford & Howell 1998): t = (x - mean) / (sd * sqrt(1 + 1/n)), "
                  "sd = sample SD (n-1), df = n - 1; reliable when |t| > the two-tailed critical value at alpha "
                  "0.001. Baseline = the crewmember's observations whose measurement day, floor((t - 1) / 86400), is "
                  "in MET days 368-381; every later observation is tested against it, as the engine and app do.",
        "critical_t": round(model.CRITICAL_T, 4), "df": model.N_BASELINE_DAYS - 1,
        "alpha_two_tailed": model.ALPHA_TWO_TAILED,
        "mdc_formula": "smallest one-day change a band can flag = critical x SD x sqrt(1 + 1/n) "
                       f"(= {model.CRITICAL_T * math.sqrt(1 + 1 / model.N_BASELINE_DAYS):.2f} baseline SDs at n = 14)",
        "detection_probability_method": f"seeded Monte Carlo, {model.MC_REPS} fresh 14-day baselines from the "
                                        "generator's own noise model per scripted day; share in which Tier B flags "
                                        "the scripted value in the worse direction",
        "indicators": inds,
        "summary": summary,
        "tier_b": rep,
        "unscripted_case_openings": unscripted,
        "chance_rates": {"method": "share of tests with no real change that raise a caution (reliable change "
                                   "in the worse direction), laid out like the scenario (fixed 14-day baseline, "
                                   "then 31 days each tested against it). Normally distributed indicators: alpha/2 "
                                   "exactly. Skewed ones (Poisson lapse counts, the absolute midpoint shift): seeded "
                                   "Monte Carlo, 500 simulated 45-day records per crewmember from the generator's "
                                   "own noise model.",
                         "per_indicator": rates},
        "tier_a_urine": urine_a,
    }


def noise_model() -> dict:
    out = {}
    for var, spec in model.NOISE.items():
        if var == "sleep_midpoint":
            continue
        entry = {"model": spec["model"]}
        for k in ("sd", "cv", "clip", "rho_with_systolic", "offset", "extra_sd"):
            if k in spec:
                entry[k] = [x for x in spec[k]] if isinstance(spec[k], tuple) else round(spec[k], 4)
        entry["unit"] = UNITS[var]
        out[var] = entry
    out["sleep_midpoint_shift"] = {
        "model": "absolute_shift", "midpoint_sd": model.NOISE["sleep_midpoint"]["sd"], "unit": "h",
        "emitted_sd": round(model.NOISE["sleep_midpoint"]["sd"] * math.sqrt(1 - 2 / math.pi), 4),
        "note": "signed midpoint ~ normal(own mean, 0.6 h); emitted value = |midpoint - median of the baseline "
                "nights|, a half-normal whose SD is 0.6 x sqrt(1 - 2/pi) h"}
    return {"note": NOISE_NOTE, "per_variable": out,
            "basis": "data.variables[*].calibration (literature where it exists, otherwise design choice)"}


def _spe_calibration(spe: dict) -> list[dict]:
    base, shape = spe["baseline"], spe["shape"]
    out = [_cal("quiet-time baseline", f"{base['value']} µGy/day (noise SD {base['noise_sd']})", base["chip"],
                base["source"])]
    if shape["mode"] == "real":
        out.append(_cal("event shape", "NOAA NCEI GOES-7 >10 MeV flux, 19-21 Oct 1989, native 5-min samples",
                        "derived", {"kind": "derived", "from": ["swpc_spe_replay"],
                                    "arithmetic": shape["mapping"]["rule"]}))
    else:
        out.append(_cal("event shape", "synthetic placeholder", "design choice", _dc(shape["mapping"]["rule"])))
    out.append(_cal("flux-to-dose scaling", "assumed 10x scaling: NOAA S3 flux (1,000 pfu) = 10x the quiet rate",
                    spe["scaling"]["chip"], spe["scaling"]["source"]))
    out.append(_cal("role", "simulated confirmation, not the alarm", "design choice",
                    _dc("The vehicle radiation monitoring system alerts the crew ([V2 6164]); this simulated habitat "
                        "dose rate only confirms the external reading inside the habitat. It is not a measurement and "
                        "not a transport calculation.")))
    return out


def _proton_calibration(spe: dict) -> list[dict]:
    shape = spe["shape"]
    if shape["mode"] == "real":
        out = [_cal("flux values", "NOAA NCEI GOES-7 >10 MeV integral flux, 19-21 Oct 1989, native 5-min samples, "
                                   "time-shifted only", "derived",
                    {"kind": "derived", "from": ["swpc_spe_replay"], "arithmetic": shape["mapping"]["rule"]})]
    else:
        out = [_cal("flux values", "synthetic placeholder", "design choice", _dc(shape["mapping"]["rule"]))]
    out.append(_cal("monitor", "external space-weather monitor above the atmosphere (Mars orbit), relayed locally",
                    "design choice",
                    _dc("A monitor on the surface would not read this flux: the Martian atmosphere absorbs most "
                        "lower-energy protons, so the >=10 MeV flux at the surface follows only the high-energy tail. "
                        "The scenario therefore takes the S3 reading from an external monitor above the atmosphere, "
                        "the in-situ space-weather monitoring [V2 6165] requires, relayed to the habitat without an "
                        "Earth link. The habitat dose rate is a separate simulated confirmation.")))
    out.append(_cal("external monitoring requirement", V2_6165_TEXT, "NASA-published", V2_6165))
    out.append(_cal("no radial-distance or atmospheric correction", "Earth-orbit (GOES) flux used as is",
                    "design choice",
                    _dc("Scenario assumption: Mars is farther from the Sun than Earth and no heliocentric-distance "
                        "scaling is applied; no atmospheric transport is applied either (the reading is above the "
                        "atmosphere). A real event at Mars would give a different flux.")))
    return out


def _caveats(spe: dict, cal: dict, sc: dict) -> list[str]:
    base, shape = spe["baseline"], spe["shape"]
    cav = [
        "SIMULATED SCENARIO - NOT CREW DATA. Continuous crew vitals are simulated because no public time series of "
        "real crew wearable data exists. Every crew value is produced by a seeded generator "
        f"(seed {model.SEED}; ingest/_sim_model.py) and is identical on every re-run.",
        "Day-to-day noise is realistic, not engineered: every baseline and ordinary day is a plain draw, with nothing "
        "trimmed or rejection-sampled. The SDs follow published within-person values where they exist: sleep "
        "duration 1.2 h (Flynn-Evans et al. 2016: ISS actigraphy, all crewmembers pooled, so an upper-side value), "
        "resting heart rate 3.0 bpm (Quer et al. 2020), "
        f"24-h urine output {_fmt(URINE_SD, 0)} mL (derived from Nayan et al. 2012) and fasting glucose 5.7% "
        "(Selvin et al. 2007). The midpoint, PVT-B, HRV, skin temperature, light, fluid and blood-pressure SDs are "
        "design choices, each listed with its context in data.variables[*].calibration. Mean sleep is calibrated "
        "against Barger et al. 2014 and the PVT-B lapse definition against Basner et al. 2011; episode values are "
        "ours.",
        "More day-to-day noise lowers Tier B's sensitivity: the smallest one-day change a personal band can flag is "
        "critical x SD x sqrt(1 + 1/n), 4.37 baseline SDs on a 14-day baseline, printed per crewmember and indicator "
        "in data.self_check.tier_b.per_crew (mdc). The chance false-alarm rate does not grow with the noise: it is "
        "about alpha = 0.001 per indicator-day only if day-to-day noise were normal and independent, and higher for "
        "skewed or autocorrelated data such as PVT-B lapse counts and the absolute midpoint shift "
        "(engine/rules/personal.json rci.caveat).",
        "What Tier B finds in this data (data.self_check, recomputed on every build): " + " ".join(sc["summary"]),
        "CM-1..CM-4 are fictional: no names, no real PII. Mood is simulated for everyone, private by default and "
        "never alerts.",
        "Daily values are stamped when their measurement window closes, so 'now' (MET 412/14:20:00) has no 24-h "
        "urine, fluid or daytime-light value for day 412 yet: that day is incomplete. Cuff blood pressure and "
        "fingerstick glucose are manual readings from the vehicle medical kit, " + VITALS_CADENCE + ".",
        "Blood pressure and glucose: " + NO_NASA_LIMIT + " The glucose calibration lists the Inspiration4 lab "
        "reference range as context only, never as an alert limit.",
        "career_effective_dose is a design-choice prior (mSv), not a calculation. The SPE day's absorbed dose rate "
        "(µGy/day) is never converted to effective dose: LANDFALL makes no personal dose projection.",
    ]
    if shape["mode"] == "real":
        cav.append("SPE day: the event TIME PROFILE is REAL (NOAA NCEI GOES-7 >10 MeV proton flux, October 1989, read "
                   "from swpc_spe_replay) and only time-shifted, so its first S3-level sample lands at MET "
                   "412/14:15:00. vehicle.series.proton_flux_10mev carries that replayed flux unchanged as the "
                   "reading of an EXTERNAL space-weather monitor above the Martian atmosphere (in Mars orbit, "
                   "relayed to the habitat locally, no Earth link needed; the monitoring [V2 6165] requires). "
                   "Scenario assumption: NO radial-distance and NO atmospheric correction is applied; GOES measured "
                   "in Earth orbit, and a real event at Mars would give a different flux. A monitor on the surface "
                   "would read far less, because the atmosphere absorbs most lower-energy protons. Every replayed "
                   "sample, before and after 'now', carries provenance 'replay'.")
    else:
        cav.append("SPE day FALLBACK: swpc_spe_replay was not usable (" + str(shape.get("error") or
                   "file absent") + "), so the event shape is SYNTHETIC. Re-run `python -m ingest --all` after the "
                   "swpc adapter to replay the real October 1989 event.")
    cav.append("vehicle.series.onboard_dose_rate is a SIMULATED habitat dose rate that confirms the external reading "
               "inside the habitat: the same flux profile under an assumed 10x scaling (design choice), not a "
               "radiation-transport calculation and not a measurement. LANDFALL is not the radiation alarm: the "
               "vehicle radiation monitoring system alerts the crew ([V2 6164]); LANDFALL opens the health case "
               "that follows and guides the crew.")
    if base["mode"] == "real":
        cav.append(f"SPE day: the quiet-time baseline is REAL: the median MSL RAD '{base['parameter']}' dose rate, "
                   f"{base['value']} µGy/day, read from hapi_msl_rad_dose. The flux-to-dose scaling (S3 flux = 10x "
                   "baseline) is an ASSUMPTION, not a radiation-transport calculation.")
    else:
        cav.append("SPE day FALLBACK: hapi_msl_rad_dose was not usable, so the baseline is a design-choice "
                   f"placeholder of {base['value']} µGy/day. The flux-to-dose scaling is an assumption in any case.")
    if cal["mode"] == "horizons":
        rms = (cal["window_utc"].get("record") or {}).get("edge_uncertainty_days_rms")
        cav.append("Calendar: MET day 412 is mapped into a Mars solar-conjunction window MODELLED from JPL Horizons "
                   f"geometry (horizons_mars_comms: {cal['window_utc']['start']} to {cal['window_utc']['stop']}; "
                   "window edges fitted to NASA's published command moratoria"
                   + (f", RMS {rms} d" if rms is not None else "") + "); the mission, its launch date (MET epoch) "
                   "and the pairing with the 1989 event are fictional.")
        if cal["blackout_remaining_at_now_s"] < env.MIN_REMAINING_S:
            cav.append("WARNING: the selected conjunction window is shorter than 10 days, so less than 10 days of "
                       "blackout remain at 'now'.")
    else:
        cav.append("Calendar PLACEHOLDER: horizons_mars_comms was not usable (" + str(cal.get("error") or
                   "file absent") + "). The conjunction blackout is a MET-only placeholder (3 days before to "
                   "11 d 06 h after 'now') and no calendar date is claimed. Re-run `python -m ingest --all` after "
                   "the horizons adapter.")
    return cav


def _episode_json(ep: dict, timelines: dict[str, dict]) -> dict:
    daily = timelines[ep["crew_id"]]["daily"]
    values = {}
    for var, by in ep["values"].items():
        if var == "sleep_midpoint":
            values["sleep_midpoint_shift"] = {str(d): daily["sleep_midpoint_shift"][d] for d in by}
        else:
            values[var] = {str(d): x for d, x in by.items()}
    out = {"id": ep["id"], "case_id": ep["case_id"], "crew_id": ep["crew_id"], "summary": ep["summary"],
           "scripted_values": values}
    if "sleep_midpoint" in ep["values"]:
        out["scripted_midpoint_h_after_0200"] = {str(d): x for d, x in ep["values"]["sleep_midpoint"].items()}
    return out


def _glucose_context(out_dir: Path) -> dict | None:
    snap, _err = env.load_snapshot(out_dir, "osdr_cmp")
    if snap is None:
        return None
    try:
        g = next(a for a in snap["data"]["analytes"] if a.get("key") == "glucose")
        ranges = {(r["min"], r["max"]) for by_t in g["ranges"].values() for r in by_t.values()}
    except (KeyError, StopIteration, TypeError):
        return None
    if len(ranges) != 1:
        return None
    lo, hi = ranges.pop()
    return {"item": "context: Inspiration4 lab reference range", "value": f"{lo}-{hi} {g.get('unit', 'mg/dL')}",
            "chip": "derived",
            "source": {"kind": "derived", "from": ["osdr_cmp"],
                       "arithmetic": "glucose reference range printed with every Inspiration4 comprehensive metabolic "
                                     "panel sample (OSD-575); the same on every sample. Context only, not an alert "
                                     "limit."}}


def build_snapshot(out_dir: Path, retrieved_at: str) -> dict:
    replay, replay_err = env.load_snapshot(out_dir, "swpc_spe_replay")
    rad, rad_err = env.load_snapshot(out_dir, "hapi_msl_rad_dose")
    hz, hz_err = env.load_snapshot(out_dir, "horizons_mars_comms")
    crew, timelines = build_crew()
    spe = env.build_spe_day(replay, rad)
    if spe["shape"]["mode"] == "fallback" and not spe["shape"].get("error"):
        spe["shape"]["error"] = replay_err
    if spe["baseline"]["mode"] == "fallback" and not spe["baseline"].get("error"):
        spe["baseline"]["error"] = rad_err
    cal = env.build_calendar(hz)
    if cal["mode"] == "placeholder" and not cal.get("error"):
        cal["error"] = hz_err
    ppco2 = model.cabin_ppco2()
    proton_source = "replay" if spe["shape"]["mode"] == "real" else "vehicle"
    proton_prov = "replay" if spe["shape"]["mode"] == "real" else "simulated"
    sc = self_check(timelines)

    variables = {}
    for var, meta in VARIABLE_META.items():
        m = {"unit": UNITS[var], "source": SOURCES[var], **meta}
        if var == "onboard_dose_rate":
            m["calibration"] = _spe_calibration(spe)
        if var == "proton_flux_10mev":
            m["calibration"] = _proton_calibration(spe)
            m["source"] = proton_source
            m["provenance"] = proton_prov
        if var == "glucose":
            ctx = _glucose_context(out_dir)
            if ctx:
                m["calibration"] = m["calibration"] + [ctx]
        variables[var] = m

    inputs = [x for x in (spe["baseline"].get("input"), spe["shape"].get("input"), cal.get("input")) if x]
    access = [GENERATOR_URL] + [f"web/public/data/{x['snapshot']}.json" for x in inputs] + [x["url"] for x in inputs]

    now = model.NOW_MET_S
    data = {
        "scenario": "LANDFALL demo scenario (engine/SPEC.md section 7)",
        "generator": {"module": "ingest/sim_crew.py (+ ingest/_sim_model.py, ingest/_sim_env.py)", "seed": model.SEED,
                      "rng": "random.Random(f'{seed}:{stream}') per crewmember x variable; random() and gauss() only",
                      "deterministic": True,
                      "seed_policy": "the project seed, fixed before this noise model was written; it was not "
                                     "re-drawn to improve detections or to remove chance flags"},
        "met": {"day_s": model.DAY_S, "first_day": model.FIRST_DAY, "last_day": model.LAST_DAY,
                "baseline_days": [model.BASELINE_FIRST, model.BASELINE_LAST],
                "now_met_s": now, "now": model.format_met(now),
                "format": "MET strings are ddd/hh:mm:ss with no leading zeros in the day field (NASA-STD-3001 Vol 2 "
                          "F.6.1 f)",
                "convention": "MET = integer seconds since MET epoch; day = floor(MET / 86400), so MET day 412 "
                              "starts at 35,596,800 s"},
        "calendar": cal,
        "observation_format": {
            "expand": "for each series: observation = {crew_id, variable, value: v[i], unit, t: t[i] (or "
                      "start_t + i*step_s), source, provenance: the series' own 'provenance' when it has one "
                      "(vehicle proton_flux_10mev: 'replay', before and after 'now'), else 'simulated'}; vehicle "
                      "series have crew_id null",
            "t_meaning": "MET seconds when the value became available (end of its measurement window)",
            "missing": "null = no sample (a gap to show as stale/missing per [V2 10020]); never zero"},
        "variables": variables,
        "noise_model": noise_model(),
        "crew": crew,
        "vehicle": {
            "series": {
                "cabin_ppco2": {"unit": "mmHg", "source": "vehicle", "provenance": "simulated", "crew_id": None,
                                "start_t": model.met_s(model.FIRST_DAY), "step_s": 3600, "n": len(ppco2),
                                "t_meaning": "value k is the mean over [start_t + k*3600, start_t + (k+1)*3600)",
                                "v": ppco2},
                "onboard_dose_rate": {"unit": "uGy/day", "source": "vehicle", "provenance": "simulated",
                                      "label": VARIABLE_META["onboard_dose_rate"]["label"], "crew_id": None,
                                      **spe["series"], "after_now": spe["after_now"]},
                "proton_flux_10mev": {
                    "unit": "pfu", "source": proton_source, "provenance": proton_prov,
                    "label": VARIABLE_META["proton_flux_10mev"]["label"], "crew_id": None,
                    "start_t": spe["series"]["start_t"], "step_s": spe["series"]["step_s"], "n": spe["series"]["n"],
                    "v": spe["series"]["source_flux_pfu"],
                    "after_now": {"start_t": spe["after_now"]["start_t"], "step_s": spe["after_now"]["step_s"],
                                  "n": spe["after_now"]["n"], "v": spe["after_now"]["source_flux_pfu"],
                                  "provenance": proton_prov, "note": spe["after_now"]["note"]}}}},
        "spe_day": {
            "met_day": 412, "environment": "mars_surface",
            "baseline": {k: v for k, v in spe["baseline"].items() if k != "input"},
            "shape": {k: v for k, v in spe["shape"].items() if k != "input"},
            "scaling": spe["scaling"], "crossings": spe["crossings"],
            "value_at_now": spe["value_at_now"], "multiple_of_baseline_at_now": spe["multiple_of_baseline_at_now"],
            "noaa_scale_available": False,
            "proton_source": "external space-weather monitor above the Martian atmosphere (Mars orbit), relayed to "
                             "the habitat locally ([V2 6165])",
            "dose_rate_role": "simulated habitat confirmation; the vehicle radiation monitoring system alarms "
                              "([V2 6164])",
            "assumptions": ["GOES-7 >=10 MeV replay used with NO radial-distance (heliocentric) correction",
                            "NO atmospheric correction: the reading is taken above the atmosphere",
                            "habitat dose rate = quiet MSL RAD rate + assumed 10x scaling at S3 (design choice)"],
            "note": "At Mars no NOAA alert reaches the crew (noaa_scale_available false). The proton reading "
                    "(vehicle.series.proton_flux_10mev) comes from an external space-weather monitor above the "
                    "atmosphere, relayed locally; its values are the time-shifted Earth-orbit replay with no "
                    "radial-distance or atmospheric correction (a scenario assumption), and applying NOAA's S3 level "
                    "to it is a design choice of engine/rules/thresholds.json. onboard_dose_rate is a simulated "
                    "habitat confirmation under the assumed flux-to-dose scaling; source_flux_pfu repeats the flux "
                    "beside each dose sample for auditing."},
        "episodes": [_episode_json(ep, timelines) for ep in model.EPISODES],
        "ffd_demo": {"crew_id": "CM-2", "variable": "vo2max", "value": model.CREW_BY_ID["CM-2"]["vo2max"][-1],
                     "unit": "ml/min/kg", "t": model.met_s(model.FITNESS_TEST_DAYS[-1], 10.0),
                     "expect": "within the microgravity-EVA floor (32.9, [V1 4001]); outside the surface-EVA floor "
                               "(36.5, [V1 4002])"},
        "self_check": sc,
        "inputs": inputs,
    }
    if cal["mode"] == "horizons":
        epoch = env.parse_iso(cal["met_epoch_utc"])
        coverage = {"start": to_iso_z(epoch + timedelta(seconds=model.met_s(model.FIRST_DAY))),
                    "stop": cal["now_utc"], "cadence": None}
    else:
        coverage = {"start": None, "stop": None, "cadence": None}
    return make_snapshot(
        id=SNAPSHOT_ID, adapter=ADAPTER_ID,
        title="Simulated crew scenario: 4 fictional crewmembers, MET days 368-412 (seeded, labelled)",
        source={"publisher": "LANDFALL project (simulated scenario generator)",
                "name": f"LANDFALL seeded crew scenario, seed {model.SEED} (ingest/sim_crew.py)",
                "url": GENERATOR_URL, "access_urls": access,
                "license": "Apache-2.0 (LANDFALL). Replayed inputs keep their publishers' terms; see their snapshots.",
                "citation": (f"LANDFALL simulated crew scenario (seed {model.SEED}), ingest/sim_crew.py, {REPO_URL}. "
                             "Means calibrated against Barger et al. 2014 (PMID 25127232) and Basner et al. 2011 "
                             "(PMID 22025811); day-to-day SDs from Flynn-Evans et al. 2016 (PMID 28725719), Quer et "
                             "al. 2020 (PMID 32023264), Nayan et al. 2012 (PMID 22396364) and Selvin et al. 2007 "
                             "(PMID 17646610) where published, design choices elsewhere (listed per variable), with "
                             "context from Knutson et al. 2007 (PMID 17580601), Huang & Redline 2019 (PMID 31167888), "
                             "Basner et al. 2018 (PMID 29126328), Bellenger et al. 2022 (PMID 36146073), Norsk et al. "
                             "2015 (PMID 25774397), Matsui et al. 2012 (PMID 22547439) and Juhanoja et al. 2017 (PMID "
                             "28193705); SPE "
                             "shape from NOAA NCEI GOES-07 EPS (October 1989); Mars-surface baseline from NASA CCMC "
                             "iSWA MSL RAD; conjunction window modelled from JPL Horizons geometry when present.")},
        retrieved_at=retrieved_at,
        coverage=coverage,
        freshness={"kind": "historical", "stale_after": None},
        provenance="simulated",
        caveats=_caveats(spe, cal, sc),
        data=data)


def run(ctx: RunContext) -> list[dict]:
    return [build_snapshot(ctx.out_dir, ctx.retrieved_at)]
