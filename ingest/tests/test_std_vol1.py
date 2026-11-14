"""Known-answer tests for the NASA-STD-3001 Vol 1 Rev C adapter (std_vol1).

Three layers:
  1. Pure unit tests of the parsing helpers (no network, no PDF).
  2. Known-answer tests on the frozen snapshot that ships to the judged site.
  3. A full offline re-parse of the cached PDF (skipped when .cache/ingest has no copy).
"""

import json
from types import SimpleNamespace

import pytest

from ingest import std_vol1 as sv
from ingest._std_vol1_pdf import _assemble_lines, join_lines
from ingest.common import DEFAULT_OUT_DIR, RunContext, validate_snapshot

SNAP_PATH = DEFAULT_OUT_DIR / "std_vol1_requirements.json"


# ----------------------------------------------------------------------------- 1. helpers
def _ch(t, x0, y0, size=12.0, w=5.0):
    return SimpleNamespace(get_text=lambda: t, x0=x0, x1=x0 + w, y0=y0, size=size)


def test_fraction_slash_is_reordered_by_x_position():
    # Real geometry of [V1 4001] (page index 30): '⁄' is raised 0.4 pt and pdfminer's
    # extract_text emits it on its own line; glyph assembly must put it between 'l' and 'm'.
    # x0 values are the real ones; widths make adjacent glyphs touch, as they do in the PDF.
    xs = [("3", 435.0, 289.7), ("2", 441.0, 289.7), (".", 444.0, 289.7), ("9", 447.0, 289.7),
          ("m", 456.1, 289.7), ("l", 466.1, 289.7), ("⁄", 469.3, 290.1), ("m", 475.9, 289.7),
          ("i", 485.9, 289.7), ("n", 489.2, 289.7), ("/", 496.1, 289.7), ("k", 502.0, 289.7),
          ("g", 508.2, 289.7)]
    chars = []
    for i, (t, x0, y0) in enumerate(xs):
        nxt = xs[i + 1][1] if i + 1 < len(xs) else x0 + 6.0
        width = nxt - x0 if (t, xs[i + 1][0] if i + 1 < len(xs) else "") != ("9", "m") else 6.0
        chars.append(_ch(t, x0, y0, w=width))
    lines = _assemble_lines(chars)
    assert len(lines) == 1
    assert lines[0].text == "32.9 ml⁄min/kg"


def test_superscript_footnote_marks_join_their_row():
    # Table 4.8-1: '#' superscript at 6.5 pt sits 4.3 pt above the 9.9 pt row baseline.
    chars = [_ch(c, 87 + 5 * i, 448.3, size=9.9) for i, c in enumerate("Lens*")] + [_ch("#", 112.0, 452.6, size=6.5)]
    lines = _assemble_lines(chars)
    assert [ln.text for ln in lines] == ["Lens*#"]


def test_wide_gap_splits_segments_for_table_columns():
    chars = [_ch("A", 87, 400, size=9.9), _ch("1", 283, 400, size=9.9)]
    (line,) = _assemble_lines(chars)
    assert [s.text for s in line.segments] == ["A", "1"]


def test_join_lines_keeps_real_hyphens():
    assert join_lines(["returning bone mineral density to pre-", "mission baseline values."]) == \
        "returning bone mineral density to pre-mission baseline values."
    assert join_lines(["less than", "600 mSv."]) == "less than 600 mSv."


def test_balanced_prefix_handles_nested_cross_references():
    txt = "[Rationale: see [V1 4029] As Low as Reasonably Achievable.] Table 4.8-1 follows"
    assert sv.balanced_prefix(txt) == "[Rationale: see [V1 4029] As Low as Reasonably Achievable.]"


def test_parse_cell_units_and_not_applicable():
    assert sv.parse_cell("1,000 mGy-Eq") == {"text": "1,000 mGy-Eq", "value": 1000.0, "unit": "mGy-Eq"}
    assert sv.parse_cell("1000 mGy-Eq")["value"] == 1000.0      # circulatory career cell has no comma
    assert sv.parse_cell("500 mGy")["unit"] == "mGy"
    assert sv.parse_cell("Not applicable")["value"] is None
    assert sv.parse_cell("-")["value"] is None


def test_t_score_cutoff_detector():
    assert sv.T_SCORE_NUMERIC_RE.search("pre-flight T-score ≥ −1.0")
    assert sv.T_SCORE_NUMERIC_RE.search("osteoporosis (T <= -2.5)")
    real_4026 = ("Crewmembers’ pre-mission bone mineral density (BMD) T-scores for total hip and lumbar spine "
                 "(L1-L4), as measured by mass dual energy X-ray absorptiometry (DXA) shall be consistent with an "
                 "age, sex, gender, and ethnic-matched population.")
    assert sv.T_SCORE_NUMERIC_RE.search(real_4026) is None


def test_discover_pdf_url_strips_cache_buster():
    html = ('<a href="https://www.nasa.gov/wp-content/uploads/2023/11/'
            'nasa-std-3001-vol-1-rev-c-with-signature.pdf?emrc=6af80e6034fce">x</a>'
            '<a href="https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf?emrc=1">y</a>')
    assert sv.discover_pdf_url(html) == sv.PINNED_PDF_URL


def test_category_comes_from_section_title():
    assert sv._category_from_title("Fitness-for-Duty Aerobic Capacity") == "FFD"
    assert sv._category_from_title("Space Permissible Exposure Limit for Spaceflight Radiation Exposure") == "PEL"
    assert sv._category_from_title("Permissible Outcome Limit for Microgravity-Induced Bone Mineral Density "
                                   "(BMD) Loss") == "POL"
    assert sv._category_from_title("In-Mission Preventive Health Care") is None


def test_garbled_text_is_never_verified():
    # The failure mode the plan warns about: CID glyphs without /ToUnicode ("ooo u^A" for "600 mSv").
    garbled = {"text": "An individual crewmember’s total career dose shall be less than ooo u^A.", "items": {}}
    out = sv.verify_requirement("4030", garbled, sv.TARGETS["4030"])
    assert out["verified"] is False
    assert out["values"] == []          # an unverified number is dropped, never shipped


def test_no_expectation_is_never_vacuously_verified():
    # Verifier finding: [V1 4028] once shipped verified=True with an empty checks list.
    out = sv.verify_requirement("9999", {"text": "Anything at all.", "items": {}}, {})
    assert out["checks"] == [] and out["verified"] is None
    assert sv.TARGETS["4028"].get("expect"), "every shipped requirement needs a known-answer check"


# ----------------------------------------------------------------------------- 2. frozen snapshot
@pytest.fixture(scope="module")
def snap():
    if not SNAP_PATH.exists():
        pytest.skip("std_vol1 snapshot not generated yet (run: python -m ingest std_vol1)")
    s = json.loads(SNAP_PATH.read_text())
    validate_snapshot(s)
    return s


def _req(snap, rid):
    return next(r for r in snap["data"]["requirements"] if r["id"] == f"V1 {rid}")


def test_document_identity(snap):
    d = snap["data"]["document"]
    assert d["revision"] == "C"
    assert d["cover_number_verbatim"] == "NASA-STD-3001, Volume 1, Revision C"
    assert d["date"] == "2023-09-15"
    assert d["history_log_rev_c_date"] == "2023-09-13"       # the PDF disagrees with its own cover
    assert d["supersedes"] == "NASA-STD-3001, Volume 1, Revision B"
    assert d["pages"] == 86
    assert len(d["sha256"]) == 64
    assert d["url"].endswith("nasa-std-3001-vol-1-rev-c-with-signature.pdf")
    assert snap["provenance"] == "reference" and snap["freshness"]["kind"] == "reference"
    assert snap["id"].startswith("std_vol1_")


def test_self_test_600_msv(snap):
    r = _req(snap, "4030")
    assert "600 mSv" in r["text"]
    assert snap["data"]["self_test"]["ok"] is True
    assert r["section"] == "4.8.2"
    assert r["section_title"] == "Career Space Permissible Exposure Limit for Spaceflight Radiation"
    assert r["category_from_section_title"] == "PEL"
    assert r["printed_page"] == 39 and r["pdf_page_index"] == 38
    assert "This limit is universal for all ages and sexes." in r["text"]
    assert "35-year-old female model parameters" in r["note"]
    assert "remains below 3% mean risk of cancer mortality" in r["rationale"]


@pytest.mark.parametrize("rid,section,value,unit", [
    ("4030", "4.8.2", 600, "mSv"),
    ("4031", "4.8.3", 250, "mSv"),
    ("4032", "4.8.4", 20, "mSv per mission year"),
    ("4001", "4.1.1", 32.9, "ml/min/kg"),
    ("4002", "4.1.2", 36.5, "ml/min/kg"),
])
def test_single_value_requirements(snap, rid, section, value, unit):
    r = _req(snap, rid)
    assert r["verified"] is True and r["section"] == section
    (v,) = r["values"]
    assert v["value"] == value and v["unit"] == unit and v["verified"] is True
    assert v["verbatim"] in r["text"]


def test_spe_reference_event_is_october_1989(snap):
    assert "(sum of the October 1989 events)" in _req(snap, "4031")["text"]


def test_gcr_rates_and_applicability(snap):
    r = _req(snap, "4033")
    assert r["section"] == "4.8.5" and r["verified"]
    assert [(v["value"], v["unit"]) for v in r["values"]] == [(1.3, "mSv/day"), (0.9, "mSv/day")]
    assert "designed to support crew for > 60 days" in r["text"]


def test_vo2max_categories_are_ffd(snap):
    for rid in ("4001", "4002"):
        r = _req(snap, rid)
        assert r["category_from_section_title"] == "FFD"
        assert r["category_basis"] == "4.1 Fitness-for-Duty Aerobic Capacity"


def test_bone_pol(snap):
    r = _req(snap, "4027")
    assert r["section"] == "4.7.2" and r["category_from_section_title"] == "POL"
    assert r["category_basis"].startswith("4.7 Permissible Outcome Limit for Microgravity-Induced Bone Mineral Density")
    assert [(v["value"], v["unit"]) for v in r["values"]] == [(95, "% of pre-mission"), (90, "% of pre-mission")]
    assert r["text"] == ("Countermeasures shall maintain bone mineral density of the hip and spine at or above 95% "
                         "of pre-mission values and at or above 90% for the femoral neck.")


def test_4026_has_no_numeric_t_score(snap):
    r = _req(snap, "4026")
    assert r["verified"] is True and r["section"] == "4.7.1"
    assert sv.T_SCORE_NUMERIC_RE.search(r["text"]) is None
    assert "T-scores" in r["text"] and r["values"] == []


def test_delegation_requirements_verbatim(snap):
    r6 = _req(snap, "4006")
    assert r6["text"] == ("In-mission Fitness-for-Duty technical requirements shall be guided by the nature of "
                          "mission-associated critical operations (such as, but not limited to, vehicle control, "
                          "robotic operations, and EVAs).")
    assert r6["section"] == "4.2.2"              # it lives under 4.2 Fitness-for-Duty Sensorimotor
    r8 = _req(snap, "4008")
    assert r8["text"] == "Sensorimotor performance limits for each metric shall be operationally defined."
    assert r8["section"] == "4.2.4"


def test_monitoring_root_requirements(snap):
    assert _req(snap, "3003")["items"]["a"] == "Periodic monitoring of general health status."
    assert _req(snap, "3003")["section"] == "3.4"
    assert _req(snap, "3004")["items"]["h"] == ("Assessing, recording, monitoring, and trending vital signs and "
                                                "additional physiological and behavioral health signs.")
    assert _req(snap, "3004")["section"] == "3.5"
    assert "sleep/circadian rhythm" in _req(snap, "3003")["items"]["f"]


def test_every_verified_requirement_has_at_least_one_passing_check(snap):
    for r in snap["data"]["requirements"]:
        if r["verified"] is True:
            assert r["checks"] and all(c["ok"] for c in r["checks"]), r["label"]
    r28 = _req(snap, "4028")
    assert r28["text"] == "Post-mission reconditioning shall be aimed at returning bone mineral density to pre-mission baseline values."
    assert r28["verified"] is True and len(r28["checks"]) == 1


def test_every_shipped_value_is_verified_and_verbatim(snap):
    for r in snap["data"]["requirements"]:
        for v in r["values"]:
            assert v["verified"] is True
            assert v["verbatim"] in r["text"]
            assert sv.number_in(v["verbatim"]) == float(v["value"])


EXPECTED_481 = {
    "Lens": (1000, 2000, 4000, "mGy-Eq"),
    "Skin": (1500, 3000, 6000, "mGy-Eq"),
    "Blood-forming Organs": (250, 500, None, "mGy-Eq"),
    "Circulatory System": (250, 500, 1000, "mGy-Eq"),
    "Central Nervous System": (500, 1000, 1500, "mGy"),
    "Central Nervous System (Z≥10)": (None, 100, 250, "mGy"),
}


def test_table_481_values_units_and_rows(snap):
    (t,) = [t for t in snap["data"]["tables"] if t["id"] == "Table 4.8-1"]
    assert t["printed_page"] == 40 and t["verified"] is True
    got = {r["organ"]: r for r in t["rows"]}
    assert set(got) == set(EXPECTED_481)
    assert not any("heart" in o.lower() for o in got)                     # no "heart" row
    assert "mSv" not in t["units_found"] and set(t["units_found"]) == {"mGy-Eq", "mGy"}
    for organ, (d30, y1, car, unit) in EXPECTED_481.items():
        row = got[organ]
        assert (row["30_day"]["value"], row["1_year"]["value"], row["career"]["value"]) == (d30, y1, car), organ
        for col in ("30_day", "1_year", "career"):
            if row[col]["value"] is not None:
                assert row[col]["unit"] == unit, (organ, col)
    assert got["Blood-forming Organs"]["career"]["text"] == "Not applicable"
    assert any("hippocampus" in f for f in t["footnotes"])
    assert any("average over heart muscle and adjacent arteries" in f for f in t["footnotes"])


def test_glossary_fpp_verbatim(snap):
    g = {e["term"]: e for e in snap["data"]["glossary"]}
    assert g["Fitness for Duty (FFD)"]["definition"] == (
        "Minimum measurable capability or capacity for a given physiological or behavioral parameter that allows "
        "successful performance of all required duties.")
    assert g["Space Permissible Exposure Limits (SPEL)"]["definition"] == (
        "Quantifiable limit of exposure to a spaceflight factor over a given length of time, e.g., lifetime "
        "radiation exposure.")
    assert g["Permissible Outcome Limits (POL)"]["definition"].startswith(
        "Acceptable maximum decrement or change in a physiological or behavioral parameter, during or after a "
        "spaceflight mission, as the result of exposure to the space environment.")
    for term in ("Fitness for Duty (FFD)", "Space Permissible Exposure Limits (SPEL)", "Permissible Outcome Limits (POL)"):
        assert g[term]["verified"] is True
    assert snap["data"]["acronyms"]["PEL"] == "permissible exposure limit"


def test_change_history_rev_b(snap):
    h = snap["data"]["change_history"]
    assert h["rev_b_approval_date"] == "2022-01-05"
    # The plan says 600 mSv replaced "3% REID at 95% confidence" in Rev B; the log does not say so.
    assert h["rev_b_description_mentions_600_msv"] is False
    assert h["rev_b_description_mentions_reid"] is False


def test_appendix_d_cross_check(snap):
    r2 = _req(snap, "4002")
    assert r2["appendix_d"]["same_as_body"] is False
    assert "celestial extraterrestrial surface EVAs" in r2["appendix_d"]["text"]
    assert "mlÚ(min/kg)" in r2["appendix_d"]["text"]          # mis-mapped glyph in the matrix only
    assert _req(snap, "4033")["appendix_d"]["same_as_body"] is True   # inline [V1 4030] ref does not truncate
    assert _req(snap, "4030")["appendix_d"]["same_as_body"] is True
    for r in snap["data"]["requirements"]:
        if r.get("appendix_d"):
            assert r["appendix_d"]["expected_numbers_present"] is True, r["label"]


def test_hypercalciuria_context_quote(snap):
    (q,) = snap["data"]["context_quotes"]
    assert q["section"] == "4.7"
    assert "hypercalciuria associated with perturbed bone remodeling" in q["text"]


def test_snapshot_size_budget():
    if not SNAP_PATH.exists():
        pytest.skip("snapshot not generated")
    assert SNAP_PATH.stat().st_size < 150_000


# ----------------------------------------------------------------------------- 3. offline re-parse
def test_offline_reparse_matches_frozen_snapshot(snap):
    ctx = RunContext(offline=True)
    try:
        pdf = ctx.fetch_bytes(sv.PINNED_PDF_URL)
    except RuntimeError:
        pytest.skip("Vol 1 PDF not in .cache/ingest (run the adapter online once)")
    rebuilt = sv.build(pdf, pdf_url=sv.PINNED_PDF_URL, landing_url=sv.LANDING_URL,
                       retrieved_at=snap["retrieved_at"])
    assert rebuilt["data"]["requirements"] == snap["data"]["requirements"]
    assert rebuilt["data"]["tables"] == snap["data"]["tables"]
    assert rebuilt["data"]["document"]["sha256"] == sv.PINNED_SHA256
