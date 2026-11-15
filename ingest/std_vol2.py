"""NASA-STD-3001 Volume 2 (Human Factors, Habitability, and Environmental Health).

Fetches the official nasa.gov PDF at build time (never committed: *.pdf is gitignored;
it is referenced by URL + sha256), extracts text with pdfminer.six (/ToUnicode-aware)
and emits ONE snapshot, `std_vol2_requirements`, with:

  document          revision, approval date, sha256, page count
  requirements      verbatim requirement text + verbatim rationale, section, page,
                    and a `verified` flag that is True only if the requirement was found
                    in the body AND every known-answer substring is present
  tables            verbatim cells of the tables the requirements point to; every cell
                    string is re-checked against the extracted page text at build time
  appendix_f_colors Table F.5-1 / F.5-2 colour conventions + selected Appendix F clauses
  negatives         grep results over all pages for claims of absence (EMI/EMC, ...)
  lookups           two open plan questions answered from NASA NTRS documents, verbatim

Known-answer self-test FIRST: [V2 6004] must contain "3 mmHg" or the run fails loudly.
"""

from __future__ import annotations

import re

from bs4 import BeautifulSoup

from ingest._std_vol2_pdf import Body, clean_page, find_requirement, norm, pdf_to_pages
from ingest.common import RunContext, make_snapshot, sha256_hex

ADAPTER_ID = "std_vol2"

STANDARDS_PAGE = "https://www.nasa.gov/ochmo/human-spaceflight-and-aviation-standards/"
LANDING = "https://www.nasa.gov/reference/nasa-std-3001v2/"
# Known location (2026-11-14). The standards page links it with an "?emrc=..." cache-buster
# (WordPress "Enable Media Replace"), i.e. the file at this path is replaced in place.
PDF_FALLBACK = "https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf"
BODY_FIRST, BODY_LAST = 22, 258          # PDF pages of sections 1-12 (Appendix A starts p259)

RENAL_NTRS = "20170004709"
RENAL_PDF = "https://ntrs.nasa.gov/api/citations/20170004709/downloads/20170004709.pdf"
RENAL_2024_NTRS = "20240012429"
SSLA_NTRS = "20160005080"
SSLA_PDF = "https://ntrs.nasa.gov/api/citations/20160005080/downloads/20160005080.pdf"

# (number, group, known-answer substrings in text, known-answer substrings in rationale, note)
REQS: list[tuple[int, str, list[str], list[str], str]] = [
    (6004, "co2", ["one-hour", "3 mmHg"], ["Off-nominal CO2 values are not included"],
     "Tier A number. Rationale states off-nominal CO2 values are delegated to the program."),
    (11040, "co2", ["20 mmHg", "1-hour"], ["contingency scenarios where crew life is in jeopardy"],
     "Added in Revision E (2025-05-01) per the Document History Log."),
    (6022, "alert_delegation", ["outside safe limits", "locally and remotely"], [],
     "Non-numeric: the limit is not given in the standard."),
    (6153, "alert_delegation", ["celestial dust", "approaching defined limits"], [],
     "Celestial (lunar/Martian) dust monitoring; wording is 'approaching defined limits', not 'outside safe limits'."),
    (11036, "alert_delegation", ["outside safe limits", "suit pressure, ppO2, and ppCO2"],
     ["The recipients of the data are defined by the program or project."],
     "Suited ATMOSPHERE (suit pressure, ppO2, ppCO2), not biomedical data."),
    (6164, "alert_delegation", ["exceed predefined thresholds"],
     ["The crew must be alerted even if ground communication is disrupted or is unviable.",
      "requiring the monitoring systems to autonomously alert the crew"],
     "Rationale is the citable basis for autonomous (Earth-independent) alerting."),
    (6109, "hydration", ["minimum water quantity", "Table 6.3-1"],
     ["maintain crewmember hydration status", "adequate urine output"],
     "Provision requirement (water the system must supply), not a crew health limit; Table 6.3-1 sets the potable "
     "water for hydration minimum. The renal case's urine targets come from the HRP evidence report, not from here."),
    (6165, "radiation_monitoring",
     ["in-situ extravehicular space weather environment", "proton flux spectra"],
     ["before crew have adequate time to shelter", "October 1989 events"],
     "External space-weather monitoring; the rationale names the October 1989 events that LANDFALL replays."),
    (6001, "data", ["temporal trend analyses"], ["Table 6.1-1", "suited biomedical data"],
     "Materially changed in Revision F; rationale now points to the new Table 6.1-1."),
    (6102, "electromagnetic", ["RF electromagnetic fields", "Table 6.8-2"], ["C95.1-2005"],
     "The only electromagnetic requirement found: human RF exposure, not EMI/EMC."),
    (7045, "medical_usability", ["usable by non-physician crewmembers"],
     ["simple and easy to use and require minimal training"], ""),
    (7076, "materials", ["comfortable in fit and composition"], ["NASA-STD-6016"],
     "Clothing comfort; material assessment deferred to NASA-STD-6016. Not a biocompatibility requirement."),
    (7081, "materials", ["microbiologically safe for human contact"], [],
     "Microbial surface safety. Not a skin-contact biocompatibility requirement."),
    (9017, "electrical", ["control the power to an electrical circuit"], [], "Power interruption, not leakage current."),
    (9018, "electrical", ["de-energized status"], [], "Energized-status display, not leakage current."),
    (9019, "electrical", ["0.4 mA", "0.2 mA peak"], [], "General nominal body-current limits (any equipment)."),
    (9020, "electrical", ["40mA", "8 mA peak"], ["850 \u2126 (Ohms)"],  # PDF uses U+2126 OHM SIGN
     "General catastrophic body-current limits."),
    (9021, "electrical", ["2 mA", "0.5 mA"], ["startle reaction"], "General startle-reaction body-current limits."),
    (9022, "electrical", ["5th percentile", "IEC 60479-1"], [], "Body impedance method, not a current limit."),
    (9023, "electrical", ["bioinstrumentation and medical devices", "Table 9.3-11"], ["IEC 60601-1", "type CF"],
     "The ONLY medical/bioinstrumentation leakage-current requirement; values are in Table 9.3-11."),
    (9102, "touch_temperature", ["Table 9.3-4"], [], ""),
    (9103, "touch_temperature", ["Table 9.3-5"], [], ""),
    (10020, "display", ["stale, missing, unavailable, or unknown"], ["standard color and/or symbology"], ""),
    (10113, "display", ["mental transposition"], [], ""),
    (10114, "alerts", ["distinct visual and audio annunciations", "Table 10.3-1"], [], ""),
    (10115, "alerts", ["outside of tolerance"], [], ""),
    (10175, "alerts", ["prioritize alerts", "Table 10.3-1"], [], ""),
    (10125, "data", ["sensitive and private data"], [], ""),
    (10129, "data", ["automatic backup", "restoration"], [], ""),
    (10130, "data", ["alternative information sources"], [], ""),
    (11023, "suit_biomedical", ["biomedical data"],
     ["Derived body core temperature and heart rhythm (real-time) are desired for microgravity operations"], ""),
    (11034, "suit_atmosphere", ["automatically record suit pressure, ppO2, and ppCO2"], [],
     "Suited ATMOSPHERE recording, not biomedical data."),
    (11035, "suit_atmosphere", ["display suit pressure, ppO2, and ppCO2"], [],
     "Suited ATMOSPHERE display, not biomedical data."),
    (11037, "suit_biomedical", ["metabolic rates of suited EVA crewmembers"],
     ["Real-time monitoring during EVA is a current medical requirement"], ""),
    (11038, "suit_biomedical", ["display metabolic data"], [], ""),
    (8055, "circadian", ["Table 8.7-2"], ["24-hour and 40-minute cycle for Mars missions"],
     "Not in the plan: the standard's own numeric circadian lighting specification (Table 8.7-2)."),
    (7035, "renal_context", ["Vu = 3 + 2.5t"], [],
     "Waste-system collection CAPACITY, not a health target for urine output."),
    (6109, "renal_context", ["minimum water quantity", "Table 6.3-1"],
     ["Proper hydration contributes to adequate urine output", "urinary calculi"],
     "Water the SYSTEM must provide (Table 6.3-1: potable water for hydration, minimum 2.5 L per crewmember per "
     "day). A provision requirement, not a urine-output target and not an in-flight alert threshold; its "
     "rationale links continued under-hydration to urinary calculi."),
]

# Tables: verbatim cells; `page` is the PDF page; every string is checked on that page.
TABLES = {
    "table_6_1_1": {
        "caption": "Table 6.1-1—Example Sampling Rates for Trending Environmental Data", "page": 50,
        "columns": ["Environmental Parameter", "Sampling Rate"],
        "rows": [["Atmosphere Constituents (O2, CO2, etc.)", "Every 5 seconds"],
                 ["Combustion Products", "Every 1 second"], ["Dust", "Every 1 minute"],
                 ["Humidity", "Every 1 minute"], ["Pressure", "Every 1 second"],
                 ["Radiation", "Sampling rate depends on system architecture and mission scenario"],
                 ["Temperature", "Every 1 minute"],
                 ["VOCs (per [V2 6023] Trace Constituent Monitoring and Alerting)", "At least every 73 hours"],
                 ["Water Constituents/Contaminants",
                  "Sampling rate depends on system architecture and mission scenario"]],
        "note": "New in Revision F. Environmental parameters only: no biomedical/wearable rows. "
                "'Example' rates, cited by the [V2 6001] rationale.",
    },
    "table_9_3_4": {
        "caption": "Table 9.3-4—Skin Temperature Injury Limits", "page": 170,
        "columns": ["Tissue Damage", "Temperature Threshold Limit"],
        "rows": [["High Temperature Limit", "≥ 49ºC"], ["Low Temperature Limit", "≤ 0ºC"]],
        "note": "Referenced by [V2 9102].",
    },
    "table_9_3_5": {
        "caption": "Table 9.3-5—Range for Pain/Non-Disabling Injury/Possibly Resulting in Illness", "page": 171,
        "columns": ["Pain/Performance Decrements", "Temperature Threshold Limit"],
        "rows": [["High Temperature Range", "43°C ≤ Tskin < 49°C"], ["Low Temperature Range", "0°C < T skin ≤ 15°C"]],
        "note": "Referenced by [V2 9103]. Degree signs are verbatim (the PDF mixes U+00BA and U+00B0).",
    },
    "table_9_3_11": {
        "caption": "Table 9.3-11—Leakage Currents – Medical and Bioinstrumentation Equipment", "page": 179,
        "columns": ["Body Contact", "Frequency", "Operating Condition", "Isolated Equipment", "Non-Isolated Equipment"],
        "unit": "Maximum Current (mA)",
        "rows": [["External*", "DC to 1 kHz", "Normal", "0.1", "0.1"],
                 ["External*", "DC to 1 kHz", "Single Fault", "0.5", "0.5"],
                 ["External*", ">1 kHz", "Normal", "f (kHz) x 0.1 (must be ≤ 5)", "f (kHz) x 0.1 (must be ≤ 5)"],
                 ["External*", ">1 kHz", "Single Fault", "f (kHz) x 0.5 (must be ≤ 5)", "f (kHz) x 0.5 (must be ≤ 5)"],
                 ["Internal", "DC to 1 kHz", "Normal", "0.01", "Not Allowed"],
                 ["Internal", "DC to 1 kHz", "Single Fault", "0.05", "Not Allowed"],
                 ["Internal", ">1 kHz", "Normal", "f (kHz) x 0.01 (must be ≤ 1)", "Not Allowed"],
                 ["Internal", ">1 kHz", "Single Fault", "f (kHz) x 0.05 (must be ≤ 1)", "Not Allowed"]],
        "footnote": "*For DC, there is a small risk of heating and tissue necrosis for prolonged duration of contact.",
        "note": "Referenced by [V2 9023]. Merged cells read from text coordinates: each External value is printed "
                "once, horizontally centred across both equipment-type columns (merged cell), so it is repeated "
                "under both here; Internal values sit under Isolated Equipment only, and 'Not Allowed' is printed "
                "once, centred vertically across all four Internal rows of the Non-Isolated column.",
    },
    "table_10_3_1": {
        "caption": "Table 10.3-1—Alert Type and Annunciation Table", "page": [205, 206],
        "columns": ["Alert type (column has no printed header)", "Definition (column has no printed header)",
                    "Priority", "Visual Annunciation", "Auditory Annunciation (excerpt)"],
        "header_check": ["Priority", "Visual Annunciation", "Auditory Annunciation"],
        "rows": [["Emergency – Fire", "Specifically identified life threatening warning event that requires immediate action.",
                  "1", "Flashing Red", "Siren: square wave frequency modulated over a period of 5 s from 650 Hz – 1,500 Hz – 650 Hz"],
                 ["Emergency – Other than fire (e.g., pressure loss/toxic atmosphere)",
                  "Specifically identified life threatening warning event that requires immediate action.",
                  "2", "Flashing Red", "Klaxon: 2,560 Hz tone, 2.1 ms on, 1.6 ms off, mixed with 256 Hz tone."],
                 ["Warning", "Event that requires immediate action because it has the potential to become a life/mission threat.",
                  "3", "Red", "Alternating tone (square wave), 400 Hz and 1,024 Hz at a 2.5 Hz modulation rate"],
                 ["Caution", "Event that needs attention, but not immediate action.", "4", "Yellow",
                  "Continuous tone triangle wave (odd harmonics at amplitude reciprocal to harmonic number) 512 Hz of duration 1 s."],
                 ["Advisory", "Message describing a routine event, situation, or action, or an off-nominal event that does "
                  "not meet the criteria for a Caution.", "5", "Blue",
                  "The optional advisory tone consists of two iterations of a 900 Hz sine wave with an intervening silence."]],
        "note": "Referenced by [V2 10114] and [V2 10175] (their text calls it 'Table 10.3-1—Table Alert Type and "
                "Annunciation Table'). Auditory column is a verbatim excerpt (first clause) only.",
    },
    "table_8_7_2": {
        "caption": "Table 8.7-2—Physiological Lighting Specifications (Circadian Entrainment)", "page": 161,
        "columns": ["Lighting Levels at Cornea", "Melanopic EDI Lux", "Melanopic DER", "Peak Wavelength", "NOTE"],
        "rows": [["General Ambient Lighting", "≥ 250", "≥ 0.7", "480 ± 10nm (blue-enriched)", "1, 2"],
                 ["Crew Pre-Sleep", "8 +/- 2", "≤ 0.3", "≥ 550nm (blue-depleted)", "1, 3"]],
        "notes_verbatim": ["1. Melanopic EDI is measured at the cornea in the vertical plane. Both EDI and DER thresholds",
                           "2. During all waking hours, the white light must be ‘blue-enriched’ to maintain alertness",
                           "3. During scheduled pre-sleep, the white light must be ‘blue-depleted’ to reduce alertness"],
        "note": "Referenced by [V2 8055]. Notes are verbatim prefixes; see the PDF for the full note text.",
    },
    "table_6_3_1": {
        "caption": "Table 6.3-1—Water Quantities and Temperatures", "page": 71,
        "columns": ["Requirement", "Quantity (quantities are mutually independent)"],
        "header_check": ["Requirement", "Quantity (quantities are mutually independent)", "Temperature"],
        "rows": [["Potable Water for Hydration††",
                  "Minimum 2.5 L (84.5 fl oz) per crewmember per day (allocation to include 600 mL per meal per "
                  "crewmember to be available as Hot Water)"],
                 ["Potable Water Quantity for Personal Hygiene", "Minimum 400 mL (13.5 fl. oz.) per crewmember per day"],
                 ["Potable Water Quantity for Eye Irrigation", "Minimum 500 mL (16.9 fl oz) per crewmember"],
                 ["Potable Water for Medical Use and Medical Contingency", "Minimum of 5 L (169.1 fl oz) per event"],
                 ["Potable Water for EVA Operations", "Minimum 240 mL (8.1 fl oz) per crewmember per EVA hour"],
                 ["Potable Water for Fluid Loading for Reentry from Microgravity to Partial or Earth Gravity",
                  "Minimum of 1 L (33.8 fl oz) per crewmember*"],
                 ["Potable Water for Crew Recovery During Entire Recovery Period",
                  "Minimum of 1 L (33.8 fl oz) per crewmember for every 8-hour period"],
                 ["Sampling Water Quantity", "Mission dependent***"],
                 ["Agriculture Water Quantity", "Mission dependent***"]],
        "notes_verbatim": [
            "* Vehicles that may wave-off prior to reentry are to protect for this quantity of water for fluid "
            "loading for each of two deorbit attempts.",
            "** Critical for missions longer than three days.",
            "*** Mission dependent as sized by appropriate sampling or plant science personnel.",
            "†† The bulk supply of water should be accessible as nominal and/or cold, with the total of water "
            "provided for hydration is minimally 2.5L regardless of temperature."],
        "note": "Referenced by [V2 6109] (and [V2 6110] for temperatures). Quantity column only: the Hot/Nominal/Cold "
                "temperature cells are merged across rows and columns and are omitted rather than risk mis-pairing "
                "them. Row pairing was checked against the printed layout. Water PROVISION by the system, not a "
                "urine-output target.",
    },
}

APPENDIX_F_REQUIRED = [("Highest alert level, emergency, warning, failed", "Red"),
                       ("Second highest level, caution, off-nominal, trip, manual override, or attention required", "Yellow"),
                       ("Advisory", "Blue"), ("Unavailable, unselectable", "Gray"), ("Missing or stale data", "Cyan")]
APPENDIX_F_RECOMMENDED = [("Electronic Procedures and system directed", "Magenta"),
                          ("Commandable element background", "Dark Green"),
                          ("Navigation and Cursor Outlines", "Bright Green")]
# (clause, verbatim prefix long enough to be unambiguous); full sentence is cut from the page text.
APPENDIX_F_CLAUSES = [
    ("F.2 conventions", '"Must" -- Used to indicate a requirement to be implemented and the associated implementation verified.'),
    ("F.2 conventions", '"Should" -- Used to indicate a goal that the designer is expected to follow, if possible, but that is not formally verified;'),
    ("F.4.2 f", "All displays must have a common dedicated area for the display of key information"),
    ("F.4.2 j", "Displays for different modes of operation (e.g., test/sim mode vs. flight/mission mode) must be visually distinct."),
    ("F.4.3.1 c", "There must be an indication when data are stale."),
    ("F.4.3.1 d", "A yellow or red up or down arrow following a telemetry value must be used"),
    ("F.5.1 d", "A fixed-width font must be used on numerical and tabular data."),
    ("F.5.8 b", "Graphed data that is historical must be distinguishable from live data via labeling."),
    ("F.5.10 a", "Color must be used to convey meaning, and not for decoration or aesthetic purposes."),
    ("F.5.10 e", "For critical information and critical tasks when color is used to convey meaning, the system must provide an additional cue."),
    ("F.5.10 f", "Contrast between characters and background must be 6:1 or greater (10:1 preferred)."),
    ("F.5.11 b", "Low flash rate must be reserved for lower priority notifications or text at a frequency of 0.8 Hz with duty cycle of 70% on."),
    ("F.5.11 c", "High flash rate must be reserved for higher priority notifications (non-text) at a frequency of 3 Hz with duty cycle of 50% on."),
    ("F.6.1 f", "Time must be displayed using a 24-hour clock in the following format"),
    ("F.6.2 e", "Information from the automated system must avoid anthropomorphic phrasing."),
    ("F.6.2 g", "Automated systems that provide decisions or recommendations must provide explanation with rationale for the decision or recommendation."),
    ("F.6.4 a", "Emergency (E) and Warning (W) alerts must be associated with red symbology/text."),
    ("F.6.4 b", "Caution (C) alerts must be associated with yellow symbology/text."),
    ("F.6.4 c", "Advisory (A) alerts must be associated with blue symbology/text."),
    ("F.6.4 d", "The Alerts display must display or make available on request the following parameters:"),
]

NEGATIVES = [
    ("No EMI/EMC requirement in Vol 2", r"\bEMI\b|\bEMC\b|electromagnetic (interference|compatibility)"),
    ("No wearable / biosensor / body-worn device requirement", r"wearable|biosensor|bio-sensor|body[- ]worn"),
    ("No skin-contact biocompatibility requirement", r"biocompat|cytotox|ISO 10993"),
    ("'skin contact' appears only in touch-temperature context", r"skin contact"),
    ("No battery endurance requirement (all 'battery' mentions)", r"batter(y|ies)"),
    ("No storage capacity / log duration / retention requirement",
     r"data storage|storage capacity|data retention|retention period|log duration|logging duration"),
    # 'calculi' matters: the [V2 6109] water-quantity rationale names "urinary calculi" (urinary stones), so a
    # bare 'renal|kidney stone' grep (0 hits) would wrongly suggest Vol 2 never mentions stones at all.
    ("No renal/kidney-stone requirement in Vol 2 (stones appear only as 'urinary calculi' in the [V2 6109] "
     "water-quantity rationale)", r"renal|kidney stone|calculi|urolith|nephrolith"),
]

SSLA_QUOTES = [
    "the light is design to operate in 3 modes with 3 distinct spectrum.",
    "General mode is a 4500K “neutral” light spectrum intended to the be the default mode of operation for day to day operations.",
    "Pre-sleep mode is a 2700K “warm” light spectrum intended to be used by the crew at the end of the work day.",
    "Phase-shift mode is a 6500K “cool” light spectrum intended to be used for altering the crew’s sleep patterns.",
]
RENAL_QUOTE = ("Finally, the risk for renal stone development increases when urinary volume drops below 1.5 "
               "liters/day; therefore, an effective hydration countermeasure should be sufficient to produce "
               "2.5-3 liters/day of urine volume (Kassemi and Thompson 2016b).")


def _discover_pdf_url(ctx: RunContext) -> tuple[str, str | None]:
    """Return (pdf_url_without_query, raw_href_seen_or_None)."""
    try:
        soup = BeautifulSoup(ctx.fetch_text(STANDARDS_PAGE), "html.parser")
    except Exception:  # noqa: BLE001 - fall back to the known path, recorded in caveats
        return PDF_FALLBACK, None
    for a in soup.find_all("a", href=True):
        if re.search(r"/nasa-std-3001-vol-2[^/]*\.pdf", a["href"]):
            return a["href"].split("?")[0], a["href"]
    return PDF_FALLBACK, None


def _flat_pages(pages: list[str]) -> list[str]:
    return [norm(clean_page(p)[0]) for p in pages]


def _document_meta(pages: list[str]) -> dict:
    cover = norm(pages[0])
    hist = norm(" ".join(pages[1:10]))
    rev = re.search(r"Volume 2, Revision ([A-Z])", cover)
    appr = re.search(r"Approved: (\d{4}-\d{2}-\d{2})", cover)
    rev_e = re.search(r"\bE Change Number Approval Date Description (\d{4}-\d{2}-\d{2})", hist)
    rev_f = re.search(r"Revision F (\d{4}-\d{2}-\d{2})", hist)
    return {
        "revision": rev.group(1) if rev else None,
        "approved": appr.group(1) if appr else None,
        "history_rev_e_date": rev_e.group(1) if rev_e else None,
        "history_rev_f_date": rev_f.group(1) if rev_f else None,
        "supersedes": "Revision E" if "Superseding NASA-STD-3001, Volume 2, Revision E" in cover else None,
        "title": "NASA Spaceflight Human-System Standard, Volume 2: Human Factors, Habitability, and Environmental Health"
        if "HUMAN FACTORS, HABITABILITY, AND ENVIRONMENTAL HEALTH" in cover else None,
    }


def _requirements(pages: list[str]) -> list[dict]:
    body = Body.from_pages(pages, BODY_FIRST, BODY_LAST)
    out = []
    for num, group, text_keys, rat_keys, note in REQS:
        r = find_requirement(body, num)
        # `landfall_note` is OUR commentary, never NASA text (Vol 1 uses `note` for the verbatim "Note:"
        # paragraph, and the engine's verbatim checks read `note`; keep the two apart).
        if r is None:
            out.append({"id": f"[V2 {num}]", "group": group, "verified": False, "found": False,
                        "landfall_note": note})
            continue
        checks = [{"in": "text", "expect": k, "ok": k in r.text} for k in text_keys]
        checks += [{"in": "rationale", "expect": k, "ok": bool(r.rationale) and k in r.rationale} for k in rat_keys]
        out.append({"id": r.id, "number": num, "group": group, "section": r.section, "title": r.title,
                    "pdf_page": r.pdf_page, "printed_page": r.printed_page, "text": r.text,
                    "rationale": r.rationale, "found": True,
                    "verified": bool(checks) and all(c["ok"] for c in checks), "checks": checks,
                    "landfall_note": note})
    return out


def _check_tables(flat: list[str]) -> dict:
    out = {}
    for key, t in TABLES.items():
        pgs = t["page"] if isinstance(t["page"], list) else [t["page"]]
        text = " ".join(flat[p - 1] for p in pgs)
        strings = [t["caption"], *t.get("header_check", t["columns"]), *[c for row in t["rows"] for c in row],
                   *t.get("notes_verbatim", []), *([t["footnote"]] if "footnote" in t else [])]
        missing = sorted({s for s in strings if s not in text and s.rstrip(".") not in text})
        # `note` in TABLES is our commentary: ship it as `landfall_note` (verbatim text lives in caption,
        # rows, notes_verbatim and footnote only).
        out[key] = {**{k: v for k, v in t.items() if k != "note"}, "landfall_note": t.get("note"),
                    "verified": not missing, "missing_strings": missing}
    return out


def _appendix_f(flat: list[str]) -> dict:
    app = " ".join(flat[387:398])
    p396 = flat[395]
    req_ok = all(m in p396 and c in p396 for m, c in APPENDIX_F_REQUIRED)
    rec_ok = all(m in p396 and c in p396 for m, c in APPENDIX_F_RECOMMENDED)
    clauses = []
    for cid, prefix in APPENDIX_F_CLAUSES:
        i = app.find(prefix)
        if i < 0:
            clauses.append({"clause": cid, "text": prefix, "verified": False})
            continue
        if prefix.endswith((".", ";")):
            full = prefix
        else:
            # Extend to the end of the clause (next ' x. ' list marker or end of sentence).
            rest = app[i + len(prefix):]
            m = re.search(r"\s[a-z]\.\s{1,3}[A-Z]|\sF\.\d", rest)
            full = (prefix + rest[: m.start()] if m else prefix + rest[:300]).strip()
        clauses.append({"clause": cid, "text": full, "verified": True})
    return {
        "table_f_5_1": {"caption": "Table F.5-1—Required Color Usage and Its Meaning", "pdf_page": 396,
                        "binding": "must (F.5.10 b)",
                        "rows": [{"meaning": m, "color": c} for m, c in APPENDIX_F_REQUIRED], "verified": req_ok},
        "table_f_5_2": {"caption": "Table F.5-2—Recommended Color Usage and Its Meaning", "pdf_page": 396,
                        "binding": "should (F.5.10 c)",
                        "rows": [{"meaning": m, "color": c} for m, c in APPENDIX_F_RECOMMENDED], "verified": rec_ok},
        "row_pairing_method": "Meaning/colour pairs confirmed by matching text-line y-coordinates on PDF page 396.",
        "clauses": clauses,
    }


def _negatives(flat_all: list[str]) -> list[dict]:
    out = []
    for claim, pat in NEGATIVES:
        rx = re.compile(pat, re.I)
        hits = []
        for i, t in enumerate(flat_all):
            for m in rx.finditer(t):
                hits.append({"pdf_page": i + 1, "context": t[max(0, m.start() - 140): m.end() + 140]})
        out.append({"claim": claim, "pattern": pat, "scope": f"all {len(flat_all)} PDF pages, case-insensitive",
                    "hit_count": len(hits), "pages": sorted({h["pdf_page"] for h in hits}),
                    "contexts": hits[:6]})
    return out


def _pdf_flat_text(ctx: RunContext, url: str) -> tuple[list[str], str, int]:
    b = ctx.fetch_bytes(url)
    pages = pdf_to_pages(b)
    return [norm(p) for p in pages], sha256_hex(b), len(b)


def _lookups(ctx: RunContext, reqs: dict, tables: dict, negatives: list[dict]) -> tuple[list[dict], list[str]]:
    urls: list[str] = []
    out: list[dict] = []
    # (a) renal stone / urine output
    renal: dict = {"question": "Plan's renal-stone case uses 'urine output > 2 L/day' with no source. Is there a NASA source?",
                   "plan_value": "urine output > 2 L/day"}
    try:
        flat, sha, n = _pdf_flat_text(ctx, RENAL_PDF)
        urls.append(RENAL_PDF)
        page = next((i + 1 for i, t in enumerate(flat) if RENAL_QUOTE in t), None)
        r6109 = reqs.get(6109, {})
        calculi = next((s for s in re.split(r"(?<=\.)\s+", r6109.get("rationale") or "") if "urinary calculi" in s), None)
        t631 = tables.get("table_6_3_1", {})
        hyd = next((row[1] for row in t631.get("rows", []) if row[0].startswith("Potable Water for Hydration")), None)
        renal.update({
            "answer": "No NASA source says 'urine output > 2 L/day'. Two NASA sources bear on the number. (1) The 2017 "
                      "HRP evidence report says risk increases below 1.5 L/day of urine and that an effective hydration "
                      "countermeasure should produce 2.5-3 L/day of urine volume, attributed to a modelling paper "
                      "(Kassemi and Thompson 2016b): an evidence-report statement, print it with the article citation, "
                      "never with a [V… ] ID. (2) Vol 2 [V2 6109] with Table 6.3-1 requires the SYSTEM to provide a "
                      "minimum of 2.5 L (84.5 fl oz) of potable water for hydration per crewmember per day, and its "
                      "rationale names urinary calculi as a consequence of continued under-hydration: a "
                      "requirement-ID-backed water-PROVISION number, not a urine-output target and not an in-flight "
                      "alert threshold.",
            "quote": RENAL_QUOTE, "quote_verified": page is not None, "pdf_page": page,
            "url": f"https://ntrs.nasa.gov/citations/{RENAL_NTRS}", "pdf_url": RENAL_PDF, "sha256": sha, "bytes": n,
            "citation": "Sibonga, J. D.; Pietrzyk, R. Evidence Report: Risk of Renal Stone Formation. NASA Johnson "
                        "Space Center, 2017-05-15. NASA Technical Reports Server (NTRS) 20170004709. "
                        f"https://ntrs.nasa.gov/citations/{RENAL_NTRS}",
            "related": [
                {"what": "Vol 2 [V2 7035] urine collection capacity", "text": reqs.get(7035, {}).get("text"),
                 "note": "Design capacity of the waste system (3 L on flight day 0, then 2.5 L per crewmember per day), "
                         "not a health target."},
                {"what": "Vol 2 [V2 6109] Water Quantity (section 6.3.2) + Table 6.3-1 'Potable Water for Hydration'",
                 "text": r6109.get("text"), "table_cell_verbatim": hyd,
                 "rationale_sentence_verbatim": calculi,
                 "verified": bool(r6109.get("verified")) and bool(t631.get("verified")) and bool(hyd) and bool(calculi),
                 "note": "System water-provision requirement (>= 2.5 L potable water for hydration per crewmember per "
                         "day), not a urine-output target. Requirement-ID-backed, so it may carry the [V2 6109] label."},
                {"what": "Vol 2 grep 'renal|kidney stone|calculi|urolith|nephrolith'",
                 "hit_count": next(x["hit_count"] for x in negatives if x["claim"].startswith("No renal")),
                 "pages": next(x["pages"] for x in negatives if x["claim"].startswith("No renal"))},
                {"what": "Newer revision exists: Evidence Report: Risk of Renal Stone Formation (2024-10-03), "
                         f"NTRS {RENAL_2024_NTRS}, https://ntrs.nasa.gov/citations/{RENAL_2024_NTRS}",
                 "note": "Not verified: its text is drawn as vector outlines (no extractable text layer; 54 MB). "
                         "Whether the 1.5 and 2.5-3 L/day sentence survives in the 2024 revision is unknown."},
            ],
        })
    except Exception as exc:  # noqa: BLE001 - degrade, never invent
        renal.update({"answer": f"Lookup failed at build time ({exc}); no source verified.", "quote_verified": False})
    out.append(renal)

    # (b) ISS Solid State Lighting Assembly modes
    ssla: dict = {"question": "NASA source naming the ISS SSLA's 3 modes, with colour temperature / intensity if given.",
                  "plan_value": "SSLA tem 3 modos concretos"}
    try:
        flat, sha, n = _pdf_flat_text(ctx, SSLA_PDF)
        urls.append(SSLA_PDF)
        found = {q: next((i + 1 for i, t in enumerate(flat) if q in t), None) for q in SSLA_QUOTES}
        p10 = flat[9] if len(flat) >= 10 else ""
        cd = re.findall(r"(General \(neutral\)|Pre-Sleep \(warm\)|Phase-Shift \(cool\)) Default: (\d+) candela"
                        r"(?: Maximum: (\d+) candela)?(?: Minimum: (\d+) candela)?", p10)
        dim = re.search(r"All modes are dimmable to [^.]+\.", p10)
        ssla.update({
            "answer": "Yes. NASA JSC presentation (NTRS 20160005080) states 3 modes: General 4500K (default, day-to-day), "
                      "Pre-sleep 2700K (end of work day), Phase-shift 6500K (altering sleep patterns), with per-mode "
                      "candela settings. Separately, Vol 2 Rev F [V2 8055] Table 8.7-2 gives the STANDARD's numeric "
                      "circadian lighting spec (melanopic EDI/DER at the cornea), which is the citable requirement.",
            "modes": [{"mode": "General", "cct_K": 4500, "descriptor": "neutral"},
                      {"mode": "Pre-sleep", "cct_K": 2700, "descriptor": "warm"},
                      {"mode": "Phase-shift", "cct_K": 6500, "descriptor": "cool"}],
            "quotes": [{"quote": q, "pdf_page": p, "verified": p is not None} for q, p in found.items()],
            "intensity_candela_verbatim": [{"mode": m, "default": d, "maximum": mx or None, "minimum": mn or None}
                                           for m, d, mx, mn in cd],
            "dimming_verbatim": dim.group(0) if dim else None,
            "quote_verified": all(p is not None for p in found.values()),
            "url": f"https://ntrs.nasa.gov/citations/{SSLA_NTRS}", "pdf_url": SSLA_PDF, "sha256": sha, "bytes": n,
            "citation": "Maida, J. C. Introduction to the Solid State Based Interior Lighting System for ISS. "
                        "Presentation, Human Factors and Behavior Based Safety Class, NASA Johnson Space Center. "
                        "NTRS 20160005080 (NTRS publication date 2014-04-07; slide footers dated 4/14/2016). "
                        f"https://ntrs.nasa.gov/citations/{SSLA_NTRS}",
            "standard_counterpart": {"requirement": "[V2 8055]", "table": "table_8_7_2",
                                     "table_verified": tables.get("table_8_7_2", {}).get("verified")},
        })
    except Exception as exc:  # noqa: BLE001
        ssla.update({"answer": f"Lookup failed at build time ({exc}); no source verified.", "quote_verified": False})
    out.append(ssla)
    return out, urls


def run(ctx: RunContext) -> list[dict]:
    pdf_url, raw_href = _discover_pdf_url(ctx)
    pdf = ctx.fetch_bytes(pdf_url)
    if not pdf.startswith(b"%PDF"):
        raise RuntimeError(f"not a PDF: {pdf_url}")
    pages = pdf_to_pages(pdf)
    body = Body.from_pages(pages, BODY_FIRST, BODY_LAST)

    # ---- Known-answer self-test FIRST: fail loudly if the extractor is lying. ----
    ka = find_requirement(body, 6004)
    if ka is None or "3 mmHg" not in ka.text or ka.section != "6.2.1.3":
        raise RuntimeError(f"known-answer self-test failed: [V2 6004] = {ka!r}; expected '3 mmHg' in section 6.2.1.3")

    flat = _flat_pages(pages)
    doc = _document_meta(pages)
    reqs = _requirements(pages)
    by_num = {r["number"]: r for r in reqs if r.get("found")}
    tables = _check_tables(flat)
    appf = _appendix_f(flat)
    negatives = _negatives(flat)
    lookups, extra_urls = _lookups(ctx, by_num, tables, negatives)

    sha = sha256_hex(pdf)
    doc.update({"pdf_url": pdf_url, "linked_href_seen": raw_href, "sha256": sha, "bytes": len(pdf),
                "pdf_pages": len(pages), "extractor": "pdfminer.six (LAParams defaults), /ToUnicode-aware",
                "known_answer_self_test": {"id": "[V2 6004]", "expect": "3 mmHg", "passed": True}})
    unverified = [r["id"] for r in reqs if not r.get("verified")]
    bad_tables = [k for k, t in tables.items() if not t["verified"]]

    caveats = [
        f"Document served at the official URL is Revision {doc['revision']}, approved {doc['approved']} "
        f"(Document History Log: Revision E {doc['history_rev_e_date']}, Revision F {doc['history_rev_f_date']}). "
        "The '/2025/05/' in the URL is the upload slot of Revision E, replaced in place; the plan's 'Rev F (May 2025)' is wrong.",
        "The PDF is not redistributed (gitignored); it is identified by URL + sha256. A later in-place replacement "
        "at the same URL would change the sha256: re-run the adapter and re-check.",
        # Each quoted phrase is verbatim in the text of the requirements named after it; the limits named in the
        # last sentence are the PDF's own numbers (test_std_vol2.py checks both, the latter on the cached PDF).
        "No requirement in this volume publishes a numeric in-flight alert threshold for crew physiology. Its alert "
        "requirements leave the alert point to the program, in their own words: 'outside safe limits' ([V2 6022], "
        "[V2 11036]), 'approaching defined limits' ([V2 6153]), 'exceed predefined thresholds' ([V2 6164]). They do "
        "so even where Vol 2 sets the limit itself: ppCO2 [V2 6004], suit CO2 [V2 11040], lunar dust [V2 6053] and "
        "Martian dust [V2 6253].",
        "[V2 11034]/[V2 11035]/[V2 11036] cover suit pressure, ppO2 and ppCO2 (suited atmosphere), not biomedical data; "
        "the biomedical anchors are [V2 11023] (suit information management) and [V2 11037]/[V2 11038] (EVA metabolic rate).",
        "Only [V2 9023] is the medical/bioinstrumentation leakage-current requirement (Table 9.3-11). [V2 9017]-[V2 9022] are "
        "power interruption, energized status, general body-current limits and the body-impedance method.",
        "Table cells are transcribed from pdfminer text and every cell string is re-checked on its PDF page at build "
        "time (`verified`). Row/column pairing comes from text-line coordinates, not from a table parser.",
        "Section numbers and pages are PDF pages (1-based); in this PDF the printed page number equals the PDF page.",
        "Negative claims are grep results over the extracted text of all pages; a requirement phrased with words "
        "outside the listed patterns would not be caught. Image-only content (figures) is not searched.",
        "Lookups come from NTRS documents that are NOT part of NASA-STD-3001: cite them as articles/presentations, "
        "never with a requirement ID.",
        "Hydration: [V2 6109] with Table 6.3-1 is a water-PROVISION requirement on the system (potable water for "
        "hydration, minimum 2.5 L per crewmember per day), not a urine-output target or an in-flight alert threshold. "
        "The renal-stone urine-volume numbers (< 1.5 L/day raises risk; 2.5-3 L/day target) come from the HRP "
        "evidence report in lookups[0], not from this standard.",
        "`landfall_note` fields (requirements and tables) are LANDFALL's own commentary, not NASA text; verbatim NASA "
        "text is only in text, rationale, caption, rows, notes_verbatim and footnote.",
        "Wrapped lines are re-joined; a line ending in '-' is joined without a space, which keeps real compounds "
        "('non-physician', 'C95.1-2005'). The PDF uses a plain hyphen for line breaks too, so one word may carry a "
        "hyphen the authors did not type: [V2 6109] prints 'under-' at a line end, while page 68 spells "
        "'underhydration'.",
    ]
    if raw_href is None:
        caveats.append("PDF link could not be discovered on the OCHMO standards page this run; the known fallback URL was used.")
    if unverified:
        caveats.append(f"Requirements failing a known-answer check (verified=false): {', '.join(unverified)}.")
    if bad_tables:
        caveats.append(f"Tables with cell strings not found on the page (verified=false): {', '.join(bad_tables)}.")

    data = {
        "document": doc,
        "requirements": reqs,
        "tables": tables,
        "appendix_f_colors": appf,
        "negatives": negatives,
        "lookups": lookups,
    }
    snap = make_snapshot(
        id="std_vol2_requirements", adapter=ADAPTER_ID,
        title="NASA-STD-3001 Vol 2 Rev F: requirements, tables, Appendix F colours and verified negatives",
        source={
            "publisher": "NASA Office of the Chief Health and Medical Officer (OCHMO)",
            "name": f"NASA-STD-3001, Volume 2, Revision {doc['revision']} (approved {doc['approved']})",
            "url": LANDING,
            "access_urls": [STANDARDS_PAGE, pdf_url, *extra_urls],
            "license": "U.S. Government work published by NASA; the document states no license (U.S. Government works "
                       "are not subject to U.S. copyright, 17 U.S.C. 105). PDF referenced by URL + sha256, not redistributed.",
            "citation": "NASA Office of the Chief Health and Medical Officer. NASA-STD-3001, NASA Spaceflight Human-System "
                        "Standard, Volume 2: Human Factors, Habitability, and Environmental Health, Revision "
                        f"{doc['revision']}. Approved {doc['approved']} (supersedes Revision E, {doc['history_rev_e_date']}). "
                        f"{pdf_url} (landing page {LANDING}). sha256 {sha}.",
        },
        retrieved_at=ctx.retrieved_at,
        coverage={"start": None, "stop": None, "cadence": None},
        freshness={"kind": "reference", "stale_after": None},
        provenance="reference",
        caveats=caveats,
        data=data,
    )
    return [snap]
