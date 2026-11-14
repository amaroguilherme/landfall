"""Known-answer tests for the OSDR (Inspiration4 crew labs) adapter.

Two layers:
  * parser tests on inline fixtures (no network, always run);
  * tests on the frozen snapshots in web/public/data/osdr_*.json (skipped if not built yet).
Known answers were read from the raw OSDR CSVs (OSD-575, OSD-569, OSD-656) on 2026-11-14.
"""

import json
import re

import pytest

from ingest import osdr
from ingest.common import DEFAULT_OUT_DIR, validate_snapshot

# ----------------------------------------------------------------------------- fixtures

TRANSFORMED_CMP_FIXTURE = (
    "﻿Sample Name,alt_value_units_per_liter,alt_range_min_units_per_liter,alt_max_units_per_liter,"
    "ast_value_units_per_liter,ast_range_min_units_per_liter,ast_max_units_per_liter,"
    "albumin_to_globulin_ratio_value,albumin_to_globulin_ratio_range_min,albumin_to_globulin_ratio_range_max,"
    "calcium_value_milligram_per_deciliter,calcium_range_min_milligram_per_deciliter,"
    "calcium_range_max_milligram_per_deciliter\n"
    "C001_serum_L-3,13,9,46,15,10,40,2,1,2.5,9.6,8.6,10.3\n"
    "C002_serum_L-3,10,6,29,14,10,30,1.9,1,2.5,9.3,8.6,10.4\n"
)

SUBMITTED_CBC_FIXTURE = (
    "ANALYTE,VALUE,RANGE_MIN,RANGE_MAX,UNITS,TEST_TYPE,SUBJECT_ID,SEX,TEST_DATE\n"
    "HEMOGLOBIN,13.2,13.2,17.1,g/dL,CBC,C003,F,L-92\n"
    "HEMOGLOBIN (FEMALE),13.5,11.7,15.5,g/dL,CBC,C003,F,R+1\n"
)


def test_naive_regex_would_drop_alt_ast_upper_limits():
    """The pitfall itself: a `_range_max_` regex finds no ALT/AST upper limit."""
    header = TRANSFORMED_CMP_FIXTURE.lstrip("﻿").splitlines()[0].split(",")
    naive = [c for c in header if "_range_max_" in c]
    assert not any(c.startswith(("alt_", "ast_")) for c in naive)


def test_transformed_classifier_maps_alt_ast_max_alias():
    parsed = osdr.parse_transformed(TRANSFORMED_CMP_FIXTURE)
    cols = parsed["columns"]
    for key in ("alt", "ast"):
        assert set(cols[key]) == {"value", "range_min", "range_max"}
    assert parsed["samples"][("C001", "L-3")]["alt"] == {"value": 13, "range_min": 9, "range_max": 46}
    assert parsed["samples"][("C001", "L-3")]["ast"]["range_max"] == 40
    assert parsed["samples"][("C002", "L-3")]["alt"]["range_max"] == 29
    # unitless ratio columns (no unit suffix) still classify
    assert parsed["samples"][("C001", "L-3")]["albumin_to_globulin_ratio"] == {
        "value": 2, "range_min": 1, "range_max": 2.5}


def test_transformed_classifier_refuses_to_drop_unknown_columns():
    with pytest.raises(ValueError, match="refusing to drop"):
        osdr.classify_transformed_columns(["Sample Name", "alt_value_u", "mystery_column"])
    # a `_max_` alias without a matching value column is not accepted either
    with pytest.raises(ValueError):
        osdr.classify_transformed_columns(["Sample Name", "foo_max_units_per_liter"])


def test_female_suffix_rows_merge_with_their_own_ranges():
    p = osdr.parse_lab_long(SUBMITTED_CBC_FIXTURE, osdr.CBC_ANALYTES, "CBC", "TEST_DATE")
    hgb = p["analytes"]["hemoglobin"]
    assert hgb["values"]["C003"] == {"L-92": 13.2, "R+1": 13.5}
    assert hgb["ranges"]["C003"]["L-92"] == {"min": 13.2, "max": 17.1}
    assert hgb["ranges"]["C003"]["R+1"] == {"min": 11.7, "max": 15.5}


def test_unmapped_analyte_fails_loudly():
    bad = SUBMITTED_CBC_FIXTURE.replace("HEMOGLOBIN,13.2", "HEMOGLOBIN A1C,13.2")
    with pytest.raises(ValueError, match="unmapped analyte"):
        osdr.parse_lab_long(bad, osdr.CBC_ANALYTES, "CBC", "TEST_DATE")


def test_timepoints_and_numbers():
    assert osdr.parse_timepoint("L-92") == {"label": "L-92", "day_offset": -92, "anchor": "launch"}
    assert osdr.parse_timepoint("R+194")["day_offset"] == 194
    with pytest.raises(ValueError):
        osdr.parse_timepoint("L+3")
    assert osdr.parse_number("83") == 83 and isinstance(osdr.parse_number("83"), int)
    assert osdr.parse_number("1.24") == 1.24
    for tok in ("NA", "N/A", "", "Inf"):
        assert osdr.parse_number(tok) is None
    with pytest.raises(ValueError):
        osdr.parse_number("<0.5")  # never guess a censored value


def test_within_is_inclusive_and_handles_one_sided_ranges():
    assert osdr.within(10.3, 8.6, 10.3) is True
    assert osdr.within(1.37, 0.6, 1.35) is False
    assert osdr.within(75, 60, None) is True      # eGFR: one-sided range (RANGE_MAX 'N/A')
    assert osdr.within(None, 60, None) is None
    assert osdr.within(5, None, None) is None


def test_nulisa_header_defect_is_reported_not_guessed():
    text = ("Sample Name,a_concentration_npq,,b_percent_normalized_value,,c_concentration_npq,"
            "c_percent_normalized_value\nC001_urine_L-92,1.5,100,2.9,101,Inf,NA\n")
    p = osdr.parse_nulisa(text)
    assert p["keys"] == ["a", "c"]
    assert p["dropped"] == ["b"]
    assert p["samples"][("C001", "L-92")] == {"a": 1.5, "c": None}
    assert p["non_finite_npq"] == ["c C001 L-92=Inf"]
    # the orphan 'percent' column is kept aside only to diagnose the mislabel
    assert p["orphan_pct_values"] == {"b": {("C001", "L-92"): 2.9}}


def _xlsx(rows_xml: str, shared: list[str]) -> bytes:
    """Tiny in-memory .xlsx (one sheet) for the stdlib reader tests."""
    import io
    import zipfile
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook {ns} {rel}><sheets><sheet name="S" sheetId="1" r:id="rId1"/>'
                                      f"</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", f"<sst {ns}>" + "".join(f"<si><t>{s}</t></si>" for s in shared) + "</sst>")
        z.writestr("xl/worksheets/sheet1.xml", f"<worksheet {ns}><sheetData>{rows_xml}</sheetData></worksheet>")
    return buf.getvalue()


SUBMITTED_NULISA_XLSX_ROWS = (
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>'
    '<c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>'
    '<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2"><v>2.95286121531811</v></c><c r="C2" t="s"><v>6</v></c>'
    '<c r="D2" t="s"><v>7</v></c><c r="E2" t="s"><v>8</v></c></row>'
    '<row r="3"><c r="A3" t="inlineStr"><is><t>IFNA1; IFNA13</t></is></c><c r="B3"><v>0</v></c>'
    '<c r="C3" t="s"><v>6</v></c><c r="D3" t="s"><v>7</v></c><c r="E3" t="s"><v>8</v></c></row>'
)
SUBMITTED_NULISA_SHARED = ["Analyte", "Concentration", "Timepoint", "ID", "Unit", "IL1RL1", "L-92", "C001", "NPQ"]


def test_stdlib_xlsx_reader_and_submitted_nulisa_parser():
    from ingest._osdr_xlsx import read_sheet
    rows = read_sheet(_xlsx(SUBMITTED_NULISA_XLSX_ROWS, SUBMITTED_NULISA_SHARED))
    assert rows[0] == ["Analyte", "Concentration", "Timepoint", "ID", "Unit"]
    assert rows[1][1] == "2.95286121531811"  # exact XML text, no float round-trip
    sub = osdr.parse_nulisa_submitted(rows)
    assert sub == {"IL1RL1": {("C001", "L-92"): 2.95286121531811}, "IFNA1; IFNA13": {("C001", "L-92"): 0}}
    with pytest.raises(ValueError, match="unexpected unit"):
        osdr.parse_nulisa_submitted([rows[0], ["IL1RL1", "1", "L-92", "C001", "pg/mL"]])
    with pytest.raises(ValueError, match="duplicate"):
        osdr.parse_nulisa_submitted([rows[0], rows[1], rows[1]])


def test_cross_check_confirms_mislabelled_header_value_by_value():
    tr = ("Sample Name,a_concentration_npq,,il1rl1_percent_normalized_value,\n"
          "C001_urine_L-92,1.5,100,2.952861215,115.2\n")
    p = osdr.parse_nulisa(tr)
    sub = {"A": {("C001", "L-92"): 1.5}, "IL1RL1": {("C001", "L-92"): 2.95286121531811}}
    xc = osdr.cross_check_nulisa(sub, p)
    assert xc["compared_values"] == 1 and xc["mismatches"] == []
    assert xc["submitted_targets_missing_from_transformed"] == ["IL1RL1"]
    assert "equals the submitted IL1RL1 NPQ in 1/1 samples" in xc["header_findings"][0]
    bad = osdr.cross_check_nulisa({"A": {("C001", "L-92"): 1.6}}, p)
    assert bad["mismatches"] == ["A C001 L-92: submitted=1.6 transformed=1.5"]


def test_exact_repeats_rule():
    assert osdr._sig_digits(17907000) == 5 and osdr._sig_digits(15.56) == 4
    assert osdr._sig_digits(1.1) == 2 and osdr._sig_digits(0) == 0 and osdr._sig_digits(0.0) == 0
    vals = {"C001": {"L-92": 15.56, "L-3": 1.1}, "C002": {"L-92": 15.56, "L-3": 1.1},
            "C003": {"L-92": 15.56, "L-3": 1.1}, "C004": {"L-92": None, "L-3": 0}}
    assert osdr.exact_repeats(vals) == [{"value": 15.56, "n": 3, "samples": ["C001 L-92", "C002 L-92", "C003 L-92"]}]


# ------------------------------------------------------------------ frozen snapshot tests

def _load(sid):
    path = DEFAULT_OUT_DIR / f"{sid}.json"
    if not path.exists():
        pytest.skip(f"{path.name} not built yet (run: uv run python -m ingest osdr)")
    snap = json.loads(path.read_text())
    validate_snapshot(snap)
    return snap


def _analyte(snap, key):
    return next(a for a in snap["data"]["analytes"] if a["key"] == key)


SUBJECTS = ["C001", "C002", "C003", "C004"]
SEVEN = ["L-92", "L-44", "L-3", "R+1", "R+45", "R+82", "R+194"]


@pytest.mark.parametrize("sid", ["osdr_cmp", "osdr_cbc", "osdr_cytokines", "osdr_urine"])
def test_snapshot_envelope(sid):
    s = _load(sid)
    assert s["id"].startswith("osdr_") and s["adapter"] == "osdr"
    assert s["provenance"] == "measured"
    assert s["freshness"] == {"kind": "historical", "stale_after": None}
    assert s["data"]["subjects"] == SUBJECTS
    assert "osdr.nasa.gov/bio/repo/data/studies/OSD-" in s["source"]["url"]
    assert "no dataset DOI is stated" in s["source"]["citation"]  # never invent one
    first = s["caveats"][0]
    assert "NO in-flight samples" in first and "NOT a" in first and "long-duration" in first
    assert "n=4" in first and "~3-day" in first
    # scoped to the files: OSDR's description says some biospecimens were collected during flight
    assert "These files contain NO in-flight samples" in first and "before, during, and after flight" in first
    keys = [a["key"] for a in s["data"]["analytes"]]
    assert len(keys) == len(set(keys)) and all(re.fullmatch(r"[a-z0-9_]+", k) for k in keys)


def test_pitfall1_ranges_are_per_subject_and_per_sample():
    cmp_ = _load("osdr_cmp")
    ca = _analyte(cmp_, "calcium")
    assert ca["unit"] == "mg/dL"
    assert all(ca["ranges"]["C001"][t] == {"min": 8.6, "max": 10.3} for t in SEVEN)
    assert all(ca["ranges"]["C002"][t] == {"min": 8.6, "max": 10.4} for t in SEVEN)
    # C003: the lab printed a different range before and after flight; keep both
    assert ca["ranges"]["C003"]["L-92"] == {"min": 8.6, "max": 10.3}
    assert ca["ranges"]["C003"]["R+1"] == {"min": 8.6, "max": 10.2}
    assert ca["ranges_vary_within_subject"] == ["C003"]
    assert ca["values"]["C001"]["L-92"] == 9.7
    assert ca["values"]["C003"]["L-44"] == 10.3 and ca["within_own_range"]["C003"]["L-44"] is True


def test_pitfall2_alt_ast_have_upper_limits_for_every_subject_and_sample():
    cmp_ = _load("osdr_cmp")
    for key, c001_max, c003_post_max in (("alt", 46, 29), ("ast", 40, 30)):
        a = _analyte(cmp_, key)
        assert a["unit"] == "U/L"
        for s in SUBJECTS:
            for t in SEVEN:
                rg = a["ranges"][s][t]
                assert rg is not None and rg["max"] is not None, (key, s, t)
        assert a["ranges"]["C001"]["L-92"]["max"] == c001_max
        assert a["ranges"]["C003"]["R+45"]["max"] == c003_post_max
    xc = cmp_["data"]["cross_check"]
    assert xc["mismatches"] == [] and xc["compared_fields"] == 1596


def test_pitfall3_caveat_names_the_limits():
    for sid in ("osdr_cmp", "osdr_cbc", "osdr_cytokines", "osdr_urine"):
        text = " ".join(_load(sid)["caveats"])
        assert "real" in text and "recovery shape" in text and "not an alert" in text


def test_cmp_glucose_known_answers():
    g = _analyte(_load("osdr_cmp"), "glucose")
    assert g["unit"] == "mg/dL"
    assert g["values"]["C001"]["L-92"] == 83
    assert g["ranges"]["C001"]["L-92"] == {"min": 65, "max": 99}
    assert g["values"]["C001"]["L-3"] == 69


def test_cmp_shape_and_out_of_range_observation():
    cmp_ = _load("osdr_cmp")
    assert len(cmp_["data"]["analytes"]) == 19
    assert [t["label"] for t in cmp_["data"]["timepoints"]] == SEVEN
    cr = _analyte(cmp_, "creatinine")
    assert cr["values"]["C001"]["L-3"] == 1.37 and cr["within_own_range"]["C001"]["L-3"] is False
    egfr = _analyte(cmp_, "egfr_non_african_american")
    assert egfr["ranges"]["C001"]["L-92"] == {"min": 60, "max": None}
    bun_cr = _analyte(cmp_, "bun_to_creatinine_ratio")
    assert bun_cr["values"]["C002"]["R+82"] is None  # row absent in the lab file, not imputed


def test_cbc_known_answers():
    cbc = _load("osdr_cbc")
    assert len(cbc["data"]["analytes"]) == 20
    hgb = _analyte(cbc, "hemoglobin")
    assert hgb["unit"] == "g/dL"  # the ALSDA TRANSFORMED header says 'percent'
    assert hgb["values"]["C003"]["R+1"] == 13.5  # reported as 'HEMOGLOBIN (FEMALE)'
    assert hgb["ranges"]["C003"]["L-92"] == {"min": 13.2, "max": 17.1}
    assert hgb["ranges"]["C003"]["R+1"] == {"min": 11.7, "max": 15.5}
    assert any("hemoglobin" in d and "percent" in d for d in cbc["data"]["cross_check"]["unit_label_discrepancies"])
    assert cbc["data"]["cross_check"]["mismatches"] == []
    assert _analyte(cbc, "white_blood_cell_count")["values"]["C001"]["L-92"] == 5.4


def test_cytokines_have_no_invented_ranges():
    cyt = _load("osdr_cytokines")
    an = cyt["data"]["analytes"]
    assert len(an) == 80
    assert sum(a["panel"].startswith("Eve Technologies HD71") for a in an) == 71
    assert all(a["ranges"] is None and a["within_own_range"] is None for a in an)
    scd40l = next(a for a in an if a["label"] == "sCD40L")
    assert scd40l["unit"] == "pg/mL" and scd40l["values"]["C001"]["L-92"] == 24407.95
    a2m = next(a for a in an if a["label"] == "a-2 Macroglobulin")
    assert a2m["unit"] == "ng/mL" and a2m["values"]["C002"]["L-92"] == 2036900


def test_cytokine_exact_repeats_are_flagged_not_altered():
    cyt = _load("osdr_cytokines")
    an = {a["label"]: a for a in cyt["data"]["analytes"]}
    hp = an["Haptoglobin"]
    assert hp["exact_repeats"][0]["value"] == 17907000 and hp["exact_repeats"][0]["n"] == 7
    assert hp["values"]["C004"]["L-92"] == 17907000  # reproduced as published
    assert an["IL-28A"]["exact_repeats"][0]["value"] == 15.56
    assert an["IL-3"]["exact_repeats"] == []  # 1.1 x3: two significant digits, not flagged
    assert any(c.startswith("Exact repeats") and "Haptoglobin 17907000 ng/mL x7" in c for c in cyt["caveats"])


def test_urine_is_not_urinalysis_and_says_so():
    u = _load("osdr_urine")
    d = u["data"]
    assert [t["label"] for t in d["timepoints"]] == SEVEN[:-1]  # no R+194 in urine
    assert d["absent_samples"] == ["C001 L-3", "C001 R+1"]  # absent from the submitted file too
    assert d["dropped_targets"] == []
    assert len(d["analytes"]) == 203  # kit metadata: 203 targets
    assert not any("calcium" in a["label"].lower() for a in d["analytes"])
    text = " ".join(u["caveats"])
    assert "NO urinary calcium" in text and "renal-stone" in text and "log2" in text
    act = _analyte(u, "nulisa_urine_activin_a")
    assert act["unit"] == "NPQ (log2)" and act["values"]["C001"]["L-92"] == 12.747  # 12.746733172631 rounded
    assert act["values"]["C001"]["L-3"] is None
    assert act["label"] == "Activin A" and act["protein"] == "Inhibin beta A chain|Inhibin beta A chain"
    assert not any("|" in a["label"] for a in d["analytes"])


def test_urine_il1rl1_recovered_from_submitted_and_cross_checked():
    u = _load("osdr_urine")
    d = u["data"]
    il = _analyte(u, "nulisa_urine_il1rl1")
    assert il["values"]["C001"]["L-92"] == 2.953  # submitted 2.95286121531811
    assert il["values"]["C002"]["L-3"] == 0 and il["values"]["C004"]["R+1"] == 0
    assert _analyte(u, "nulisa_urine_ifna1_ifna13")["reported_as"] == "IFNA1; IFNA13"
    xc = d["cross_check"]
    assert xc["compared_values"] == 4444 and xc["mismatches"] == []  # 202 targets x 22 samples
    assert xc["submitted_targets_missing_from_transformed"] == ["IL1RL1"]
    assert "in 22/22 samples" in xc["header_findings"][0]
    assert any(f["osdr_subdirectory"] == "Original Submitted" and f["name"].endswith(".xlsx")
               for f in d["study"]["files"])


def test_urine_exact_zero_is_assay_floor_not_a_level():
    u = _load("osdr_urine")
    assert _analyte(u, "nulisa_urine_c1qa")["n_exact_zero"] == 22  # C1QA is 0 NPQ in every sample
    assert sum(a["n_exact_zero"] for a in u["data"]["analytes"]) == 133
    assert any("Exact-zero NPQ values (133 values in 27 targets)" in c and "assay floor" in c for c in u["caveats"])


def test_size_budget():
    total = sum((DEFAULT_OUT_DIR / f"osdr_{n}.json").stat().st_size
                for n in ("cmp", "cbc", "cytokines", "urine")
                if (DEFAULT_OUT_DIR / f"osdr_{n}.json").exists())
    assert total < 400_000
