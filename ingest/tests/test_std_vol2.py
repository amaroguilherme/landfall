"""Known-answer tests for the std_vol2 adapter (NASA-STD-3001 Vol 2 Rev F).

Two layers:
  * helper tests on synthetic text (no network, no PDF), for the extractor pitfalls;
  * snapshot tests on web/public/data/std_vol2_requirements.json (skipped if the adapter
    has not been run), one known answer per pitfall named in the adapter brief.
"""

import io
import json
import re

import pytest

from ingest._std_vol2_pdf import Body, clean_page, find_requirement, match_bracket, norm
from ingest.common import DEFAULT_OUT_DIR, validate_snapshot

SNAP_PATH = DEFAULT_OUT_DIR / "std_vol2_requirements.json"


# ---------------------------------------------------------------- helpers (synthetic) ----

def test_norm_joins_hyphenated_line_breaks_without_space():
    assert norm("usable by non-\nphysician crewmembers") == "usable by non-physician crewmembers"
    assert norm("Tables 6.8-4 and 6.8-\n5") == "Tables 6.8-4 and 6.8-5"
    assert norm("a  \n  b c") == "a b c"


def test_clean_page_strips_running_header_and_footer():
    raw = " NASA-STD-3001, VOLUME 2, REVISION F \nBody text here. \n53 of 54 \n \n \n"
    text, printed = clean_page(raw)
    assert printed == 53
    assert "NASA-STD-3001" not in text and "53 of 54" not in text
    assert "Body text here." in text


def test_match_bracket_handles_nested_requirement_references():
    s = "[Rationale: see ([V2 6002] Inert Diluent Gas) and [V2 6004].] tail"
    end = match_bracket(s, 0)
    assert s[end] == "]" and s[end + 1:] == " tail"


def test_find_requirement_skips_appendix_matrix_and_keeps_nested_rationale():
    pages = [
        # A compliance-matrix style occurrence: no section heading above it.
        "[V2 6004] \n[V2 6006] \nThe system shall limit the average one-hour CO2 ... \n",
        # The body occurrence, split across a page break, with a nested reference.
        " NASA-STD-3001, VOLUME 2, REVISION F \n6.2.1.3 \nNominal Vehicle/Habitat Carbon Dioxide Levels \n"
        "[V2 6004] The system shall limit the average one-hour CO2 partial pressure (ppCO2) in the \n"
        "habitable volume to no more than 3 mmHg. \n[Rationale: Achieving this ([V2 6002] Inert \n"
        "53 of 54 \n",
        " NASA-STD-3001, VOLUME 2, REVISION F \nDiluent Gas) level is dependent on scrub-\nbing.] \n"
        "6.2.1.4 \nNext \n54 of 55 \n",
    ]
    body = Body.from_pages(pages)
    r = find_requirement(body, 6004)
    assert r is not None
    assert r.section == "6.2.1.3"
    assert r.title == "Nominal Vehicle/Habitat Carbon Dioxide Levels"
    assert r.pdf_page == 2 and r.printed_page == 53
    assert r.text.endswith("no more than 3 mmHg.")
    assert r.rationale == "Achieving this ([V2 6002] Inert Diluent Gas) level is dependent on scrub-bing."
    assert find_requirement(body, 9999) is None


# ---------------------------------------------------------------- snapshot (built) -------

@pytest.fixture(scope="module")
def snap():
    if not SNAP_PATH.exists():
        pytest.skip("run `python -m ingest std_vol2` first")
    return json.loads(SNAP_PATH.read_text())


@pytest.fixture(scope="module")
def reqs(snap):
    return {r["id"]: r for r in snap["data"]["requirements"]}


def test_contract_id_prefix_and_size(snap):
    validate_snapshot(snap)
    assert snap["id"].startswith("std_vol2_") and snap["adapter"] == "std_vol2"
    assert snap["provenance"] == "reference" and snap["freshness"]["kind"] == "reference"
    assert SNAP_PATH.stat().st_size < 150_000, "keep the judged bundle small"


def test_known_answer_v2_6004_is_one_hour_3_mmhg(reqs, snap):
    r = reqs["[V2 6004]"]
    assert r["section"] == "6.2.1.3" and r["pdf_page"] == 53
    assert r["text"] == ("The system shall limit the average one-hour CO2 partial pressure (ppCO2) in the "
                         "habitable volume to no more than 3 mmHg.")
    assert "will be derived as a lower-level program/project requirement" in r["rationale"]
    assert snap["data"]["document"]["known_answer_self_test"]["passed"] is True


def test_v2_11040_suit_contingency_20_mmhg(reqs):
    r = reqs["[V2 11040]"]
    assert r["section"] == "11.3.6"
    assert "shall not exceed 20 mmHg during contingency scenarios up to a duration of 1-hour" in r["text"]


def test_document_is_rev_f_approved_2026_not_may_2025(snap):
    doc = snap["data"]["document"]
    assert doc["revision"] == "F"
    assert doc["approved"] == "2026-07-14"           # plan said "Rev F (mai/2025)"
    assert doc["history_rev_e_date"] == "2025-05-01"  # May 2025 was Revision E
    assert len(doc["sha256"]) == 64 and doc["pdf_pages"] == 398


def test_every_requested_requirement_found_and_verified(reqs):
    wanted = [6004, 11040, 6022, 6153, 11036, 6164, 6001, 6102, 7045, 7076, 7081,
              9017, 9018, 9019, 9020, 9021, 9022, 9023, 9102, 9103, 10020, 10113, 10114,
              10115, 10175, 10125, 10129, 10130, 11023, 11034, 11035, 11037, 11038]
    for n in wanted:
        r = reqs[f"[V2 {n}]"]
        assert r["found"] and r["verified"], r["id"]
        assert r["text"] and "shall" in r["text"].lower()


def test_alert_requirements_are_non_numeric_delegations(reqs):
    assert "are outside safe limits" in reqs["[V2 6022]"]["text"]
    assert "outside safe limits" in reqs["[V2 11036]"]["text"]
    # 6153 is celestial dust, and its wording differs from the plan's 'idem'.
    assert "approaching defined limits" in reqs["[V2 6153]"]["text"]
    assert "outside safe limits" not in reqs["[V2 6153]"]["text"]
    assert "exceed predefined thresholds" in reqs["[V2 6164]"]["text"]


def test_v2_6164_rationale_autonomous_alerting_verbatim(reqs):
    rat = reqs["[V2 6164]"]["rationale"]
    assert "The crew must be alerted even if ground communication is disrupted or is unviable." in rat
    assert "requiring the monitoring systems to autonomously alert the crew" in rat


def test_v2_7045_rationale_minimal_training(reqs):
    r = reqs["[V2 7045]"]
    assert r["text"].startswith("Medical equipment shall be usable by non-physician crewmembers")
    assert "simple and easy to use and require minimal training" in r["rationale"]


def test_9017_to_9022_are_not_medical_leakage_only_9023_is(reqs):
    titles = {n: reqs[f"[V2 {n}]"]["title"] for n in range(9017, 9024)}
    assert titles[9017] == "Power Interruption"
    assert titles[9018] == "Energized Status"
    assert titles[9019] == "Nominal Physiological Electrical Current Limits"
    assert titles[9022].startswith("Body Impedance")
    assert titles[9023] == "Leakage Currents – Medical and Bioinstrumentation Equipment"
    assert all("Leakage" not in titles[n] for n in range(9017, 9023))
    assert "0.4 mA for Direct Current (DC)" in reqs["[V2 9019]"]["text"]
    assert "40mA for DC" in reqs["[V2 9020]"]["text"]
    assert "2 mA for DC" in reqs["[V2 9021]"]["text"]


def test_table_9_3_11_merged_cells(snap):
    t = snap["data"]["tables"]["table_9_3_11"]
    assert t["verified"]
    rows = {(r[0], r[1], r[2]): (r[3], r[4]) for r in t["rows"]}
    assert rows[("External*", "DC to 1 kHz", "Normal")] == ("0.1", "0.1")
    assert rows[("External*", "DC to 1 kHz", "Single Fault")] == ("0.5", "0.5")
    assert rows[("Internal", "DC to 1 kHz", "Normal")] == ("0.01", "Not Allowed")
    assert rows[("Internal", "DC to 1 kHz", "Single Fault")] == ("0.05", "Not Allowed")


def test_suit_record_display_alert_triad_is_atmospheric_not_biomedical(reqs):
    for rid in ("[V2 11034]", "[V2 11035]", "[V2 11036]"):
        assert "suit pressure, ppO2, and ppCO2" in reqs[rid]["text"]
        assert "biomedical" not in reqs[rid]["text"]
    assert "biomedical data" in reqs["[V2 11023]"]["text"]
    assert "Derived body core temperature and heart rhythm (real-time)" in reqs["[V2 11023]"]["rationale"]
    assert reqs["[V2 11037]"]["rationale"].startswith("Real-time monitoring during EVA is a current medical requirement")
    assert "display metabolic data of suited EVA crewmembers" in reqs["[V2 11038]"]["text"]


def test_display_and_data_requirements(reqs):
    assert "stale, missing, unavailable, or unknown" in reqs["[V2 10020]"]["text"]
    assert "does not require mental transposition" in reqs["[V2 10113]"]["text"]
    assert "Table 10.3-1" in reqs["[V2 10114]"]["text"] and "Table 10.3-1" in reqs["[V2 10175]"]["text"]
    assert "outside of tolerance" in reqs["[V2 10115]"]["text"]
    assert "sensitive and private data" in reqs["[V2 10125]"]["text"]
    assert "alternative information sources" in reqs["[V2 10130]"]["text"]
    assert "temporal trend analyses" in reqs["[V2 6001]"]["text"]


def test_table_10_3_1_priorities_and_colours(snap):
    t = snap["data"]["tables"]["table_10_3_1"]
    assert t["verified"]
    vis = {r[0]: (r[2], r[3]) for r in t["rows"]}
    assert vis["Emergency – Fire"] == ("1", "Flashing Red")
    assert vis["Warning"] == ("3", "Red")
    assert vis["Caution"] == ("4", "Yellow")
    assert vis["Advisory"] == ("5", "Blue")


def test_appendix_f_colour_table(snap):
    af = snap["data"]["appendix_f_colors"]
    assert af["table_f_5_1"]["verified"] and af["table_f_5_2"]["verified"]
    colours = {r["color"]: r["meaning"] for r in af["table_f_5_1"]["rows"]}
    assert colours["Red"] == "Highest alert level, emergency, warning, failed"
    assert colours["Blue"] == "Advisory"                  # blue is NOT free for CTAs
    assert colours["Cyan"] == "Missing or stale data"     # the [V2 10020] stale colour
    assert colours["Gray"] == "Unavailable, unselectable"
    clauses = {c["clause"]: c for c in af["clauses"]}
    assert all(c["verified"] for c in af["clauses"])
    assert "dddd/hh:mm:ss" in clauses["F.6.1 f"]["text"]
    assert "explanation with rationale" in clauses["F.6.2 g"]["text"]
    assert "Active Caution Count" in clauses["F.6.4 d"]["text"]


def test_negative_claims(snap):
    neg = {n["claim"]: n for n in snap["data"]["negatives"]}
    assert neg["No EMI/EMC requirement in Vol 2"]["hit_count"] == 0
    assert neg["No wearable / biosensor / body-worn device requirement"]["hit_count"] == 0
    assert neg["No skin-contact biocompatibility requirement"]["hit_count"] == 0
    assert neg["No storage capacity / log duration / retention requirement"]["hit_count"] == 0
    # Verifier finding: 'renal|kidney stone' has 0 hits, but the [V2 6109] rationale says "urinary calculi".
    (renal,) = [n for n in snap["data"]["negatives"] if n["claim"].startswith("No renal/kidney-stone requirement")]
    assert "calculi" in renal["pattern"]
    assert renal["hit_count"] == 1 and renal["pages"] == [69]
    assert "urinary calculi" in renal["contexts"][0]["context"]
    # 'battery' appears only as examples (automation display, maintenance), never as a device requirement.
    assert neg["No battery endurance requirement (all 'battery' mentions)"]["pages"] == [224, 248, 330]


def test_rf_is_the_only_electromagnetic_requirement_and_no_biocompat(reqs):
    assert "RF electromagnetic fields" in reqs["[V2 6102]"]["text"]
    for rid in ("[V2 7076]", "[V2 7081]"):
        assert "biocompat" not in (reqs[rid]["text"] + reqs[rid]["rationale"]).lower()


def test_renal_lookup_says_1_5_and_2_5_to_3_l_per_day_not_2(snap):
    renal = snap["data"]["lookups"][0]
    assert renal["quote_verified"] and renal["pdf_page"] == 14
    assert "drops below 1.5 liters/day" in renal["quote"]
    assert "2.5-3 liters/day of urine volume" in renal["quote"]
    assert "> 2 L" not in renal["quote"] and "2 L/day" not in renal["quote"]
    assert "20170004709" in renal["citation"]


def test_v2_6109_water_quantity_and_table_6_3_1_hydration(reqs, snap):
    r = reqs["[V2 6109]"]
    assert r["found"] and r["verified"] and r["section"] == "6.3.2" and r["title"] == "Water Quantity"
    assert r["pdf_page"] == 69
    assert r["text"] == ("The system shall provide a minimum water quantity as specified in Table 6.3-1—Water "
                         "Quantities and Temperatures, for the expected needs of each mission, which are considered "
                         "mutually independent.")
    assert "Proper hydration contributes to adequate urine output to clear metabolic wastes" in r["rationale"]
    # The PDF breaks "under-" / "hydration" across a line with a plain U+002D (the document spells
    # "underhydration" elsewhere), so do not assert the hyphen either way.
    assert "to urinary tract infection or urinary calculi if the under" in r["rationale"]
    t = snap["data"]["tables"]["table_6_3_1"]
    assert t["verified"] and t["page"] == 71 and t["missing_strings"] == []
    rows = dict(t["rows"])
    assert rows["Potable Water for Hydration††"].startswith("Minimum 2.5 L (84.5 fl oz) per crewmember per day")
    assert rows["Potable Water for EVA Operations"] == "Minimum 240 mL (8.1 fl oz) per crewmember per EVA hour"
    assert any("minimally 2.5L regardless of temperature" in n for n in t["notes_verbatim"])


def test_renal_lookup_points_to_v2_6109_as_provision_not_urine_target(snap):
    renal = snap["data"]["lookups"][0]
    (rel,) = [x for x in renal["related"] if x["what"].startswith("Vol 2 [V2 6109]")]
    assert rel["verified"] is True
    assert rel["table_cell_verbatim"].startswith("Minimum 2.5 L (84.5 fl oz) per crewmember per day")
    assert "urinary calculi" in rel["rationale_sentence_verbatim"]
    assert "not a urine-output target" in renal["answer"]


def test_landfall_commentary_never_shares_the_verbatim_note_key(snap):
    # Vol 1 uses `note` for NASA's verbatim "Note:" text and the engine treats `note` as verbatim;
    # Vol 2 commentary must therefore live under `landfall_note` only.
    for r in snap["data"]["requirements"]:
        assert "note" not in r and "landfall_note" in r, r["id"]
    for key, t in snap["data"]["tables"].items():
        assert "note" not in t, key


def test_ssla_lookup_three_modes(snap):
    ssla = snap["data"]["lookups"][1]
    assert ssla["quote_verified"]
    assert {m["mode"]: m["cct_K"] for m in ssla["modes"]} == {"General": 4500, "Pre-sleep": 2700, "Phase-shift": 6500}
    cd = {m["mode"]: m["default"] for m in ssla["intensity_candela_verbatim"]}
    assert cd == {"General (neutral)": "210", "Pre-Sleep (warm)": "90", "Phase-Shift (cool)": "420"}


def test_table_8_7_2_circadian_lighting_spec(snap, reqs):
    t = snap["data"]["tables"]["table_8_7_2"]
    assert t["verified"]
    rows = {r[0]: r[1:4] for r in t["rows"]}
    assert rows["General Ambient Lighting"] == ["≥ 250", "≥ 0.7", "480 ± 10nm (blue-enriched)"]
    assert rows["Crew Pre-Sleep"] == ["8 +/- 2", "≤ 0.3", "≥ 550nm (blue-depleted)"]
    assert "Table 8.7-2" in reqs["[V2 8055]"]["text"]


def test_table_6_1_1_has_no_biomedical_rows(snap):
    t = snap["data"]["tables"]["table_6_1_1"]
    assert t["verified"]
    params = [r[0] for r in t["rows"]]
    assert "Atmosphere Constituents (O2, CO2, etc.)" in params
    assert not any(k in p.lower() for p in params for k in ("heart", "biomedical", "ecg", "physiolog"))


# The volume reading the gap section shows (#/method?s=gap): the first caveat that names an alert threshold.
# Each quoted phrase -> the requirements it is tied to; the phrase is verbatim in each requirement's text.
READING_TIES = {
    "outside safe limits": ["[V2 6022]", "[V2 11036]"],
    "approaching defined limits": ["[V2 6153]"],
    "exceed predefined thresholds": ["[V2 6164]"],
}
# Limits Vol 2 sets itself, as the reading names them: id -> (PDF page, verbatim words of its requirement text).
READING_LIMITS = {
    "[V2 6004]": (53, "to no more than 3 mmHg"),
    "[V2 11040]": (240, "shall not exceed 20 mmHg during contingency scenarios"),
    "[V2 6053]": (65, "lunar dust particles less than 10 μm in size in the habitable atmosphere below a "
                      "time-weighted average of 0.3 mg/m3"),
    "[V2 6253]": (65, "Martian dust particles less than 10 μm in size in the habitable atmosphere below a "
                      "time-weighted average of 0.1 mg/m3"),
}


def _volume_reading(snap):
    return next(c for c in snap["caveats"] if "alert threshold" in c.lower())


def test_volume_reading_leaves_the_alert_point_not_the_limit_to_the_program(snap, reqs):
    c = _volume_reading(snap)
    assert c.startswith("No requirement in this volume publishes a numeric in-flight alert threshold for crew physiology.")
    assert "leave the alert point to the program" in c
    assert "delegate" not in c  # Vol 2 sets some of these limits in numbers; it leaves the alert point open
    for phrase, ids in READING_TIES.items():
        assert f"'{phrase}' ({', '.join(ids)})" in c, phrase
        for rid in ids:
            assert phrase in reqs[rid]["text"], (phrase, rid)
    assert c.endswith("They do so even where Vol 2 sets the limit itself: ppCO2 [V2 6004], suit CO2 [V2 11040], "
                      "lunar dust [V2 6053] and Martian dust [V2 6253].")
    for rid, (page, words) in READING_LIMITS.items():
        if rid in reqs:  # [V2 6053] and [V2 6253] are not frozen here: the cached-PDF test below checks them
            assert words in reqs[rid]["text"] and reqs[rid]["pdf_page"] == page, rid
    assert set(re.findall(r"\[V2 \d{4,5}\]", c)) == {i for ids in READING_TIES.values() for i in ids} | set(READING_LIMITS)


def test_limits_the_volume_reading_names_are_on_their_pdf_pages(snap):
    """With .cache present (skipped without it): each limit is in the requirement text pdfminer reads on its page."""
    pytest.importorskip("pdfminer")
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LAParams, LTTextContainer

    from ingest.common import RunContext, sha256_hex

    doc = snap["data"]["document"]
    try:
        pdf = RunContext(offline=True).fetch_bytes(doc["pdf_url"])
    except RuntimeError:
        pytest.skip(f"{doc['pdf_url']} is not in .cache/ingest")
    assert sha256_hex(pdf) == doc["sha256"]
    pages = sorted({p for p, _ in READING_LIMITS.values()})
    text = {p: norm(clean_page("".join(el.get_text() for el in layout if isinstance(el, LTTextContainer)))[0])
            for p, layout in zip(pages, extract_pages(io.BytesIO(pdf), page_numbers=[p - 1 for p in pages],
                                                      laparams=LAParams()))}
    for rid, (page, words) in READING_LIMITS.items():
        at = text[page].find(rid)
        assert at >= 0, rid
        statement = text[page][at:text[page].find("[Rationale:", at)]
        assert words in statement, rid
