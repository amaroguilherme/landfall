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


def test_expect_rationale_is_checked_against_the_rationale_only():
    spec = {"expect": ["shall train"], "expect_rationale": ["a backup is available"]}
    good = {"text": "The program shall train two.", "items": {}, "rationale": "[Rationale: so that a backup is available.]"}
    assert sv.verify_requirement("9998", good, spec)["verified"] is True
    # the phrase in the statement but not in the rationale does not count; no rationale at all fails too
    wrong_place = {"text": "The program shall train two: a backup is available.", "items": {}, "rationale": "[Rationale: none.]"}
    out = sv.verify_requirement("9998", wrong_place, spec)
    assert out["verified"] is False and {"check": "rationale contains 'a backup is available'", "ok": False} in out["checks"]
    assert sv.verify_requirement("9998", {**good, "rationale": None}, spec)["verified"] is False


def test_offline_run_keeps_the_shipped_retrieval_time(tmp_path):
    ctx = RunContext(out_dir=tmp_path, offline=True)
    assert sv.shipped_retrieved_at(ctx, "abc") is None                       # nothing shipped yet
    (tmp_path / "std_vol1_requirements.json").write_text(json.dumps(
        {"retrieved_at": "2026-11-14T19:05:55Z", "data": {"document": {"sha256": "abc"}}}))
    assert sv.shipped_retrieved_at(ctx, "abc") == "2026-11-14T19:05:55Z"     # same bytes: same retrieval
    assert sv.shipped_retrieved_at(ctx, "def") is None                       # other bytes: a new retrieval
    (tmp_path / "std_vol1_requirements.json").write_text("{not json")
    assert sv.shipped_retrieved_at(ctx, "abc") is None


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


def test_cognitive_status_and_planned_sleep_requirements_verbatim(snap):
    # Cited by the sleep case (engine/rules/cases.json steps s5 and s4) instead of the sensorimotor [V1 4006].
    r11 = _req(snap, "4011")
    assert r11["text"] == ("Pre-mission, in-mission, and post-mission crew behavioral health and crewmember cognitive "
                           "status shall be within clinically accepted values as determined by behavioral health "
                           "evaluations.")
    assert (r11["section"], r11["section_title"], r11["pdf_page_number"]) == ("4.3.1", "Mission Cognitive Status", 34)
    assert r11["verified"] is True and r11["values"] == []
    # the compliance matrix words it differently ("as judged by behavioral health evaluation"); the body is normative
    assert r11["appendix_d"]["same_as_body"] is False and "as judged by behavioral health evaluation" in r11["appendix_d"]["text"]
    r14 = _req(snap, "4014")
    assert r14["text"] == ("The planned number of hours for in-mission completion of critical tasks and events, "
                           "workday, physical activity/exercise, and planned sleep period shall have established "
                           "limits to assure continued crew health and safety.")
    assert (r14["section"], r14["section_title"], r14["pdf_page_number"]) == (
        "4.3.4", "In-Mission Completion of Critical Tasks", 35)
    assert r14["verified"] is True and r14["values"] == [] and r14["appendix_d"]["same_as_body"] is True


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


# Appendix E and [V1 3006] / [V1 6006] were added on 2026-11-14 by an --offline re-run. Everything that shipped
# before must be unchanged: the first 16 hex digits of the SHA-256 of each entry's compact JSON (the snapshot
# is written with the same separators, so this is its bytes), taken from the file as it shipped before.
PRE_APPENDIX_E_SHA256 = {
    "V1 3003": "feeafce09a530a3f", "V1 3004": "d7ae2ac09120d78e", "V1 4001": "c06aa312182295cd",
    "V1 4002": "5bada61dfd2081c4", "V1 4003": "db42b98a9295b69f", "V1 4006": "a60540083b0cbfbb",
    "V1 4008": "3ed427152ee4e360", "V1 4011": "c468f4caa0603eca", "V1 4014": "1aad690e76ea2260",
    "V1 4024": "21203b8114887772", "V1 4026": "60b65eca97f1a98f", "V1 4027": "e9b0965ade66b135",
    "V1 4028": "fdca8388078bde45", "V1 4029": "7996f77c5649a382", "V1 4030": "f6b9846cd6f36957",
    "V1 4031": "d2285102a2be8b34", "V1 4032": "226c8ec66020a9ea", "V1 4033": "7d486ab666b61b88",
    "Table 4.8-1": "16ce077fc0660c8e", "glossary": "4f15909aec6023a5", "acronyms": "c7705c6f0ab4a538",
    "context_quotes": "53467ddf40e39158", "change_history": "7ad9532d98f14b26",
}
# Table 4.8-3 was appended on 2026-11-15 by another --offline re-run (retrieval time kept: the PDF was not
# re-fetched). What the 2026-11-14 re-run added must be unchanged too: digests of the file as it shipped before.
PRE_TABLE_483_SHA256 = {
    "V1 3006": "664fadd1e0e6c8d6", "V1 6006": "8fa060e69672b2ea", "Table E.2-1": "b0890cbc9c632373",
    "appendix_e": "541da26777977752", "document": "734d40e13b3fe57d", "self_test": "1434b13567c61e56",
    # top-level fields: the snapshot's title, source, caveats and retrieval time did not move either
    "title": "018cc69abffdf543", "source": "f8b414bac0f9f981", "caveats": "95c9ce07925f54ab",
    "retrieved_at": "c412da2b9930d762",
}


def _digest(x) -> str:
    import hashlib
    return hashlib.sha256(json.dumps(x, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()[:16]


def test_pre_existing_entries_are_byte_identical(snap):
    reqs = snap["data"]["requirements"]
    old = [k for k in PRE_APPENDIX_E_SHA256 if k.startswith("V1 ")]
    assert [r["id"] for r in reqs[:len(old)]] == old            # same 18 entries, same order, first
    assert [r["id"] for r in reqs[len(old):]] == ["V1 3006", "V1 6006"]   # only appended after them
    for r in reqs[:len(old)]:
        assert _digest(r) == PRE_APPENDIX_E_SHA256[r["id"]], r["id"]
    t481 = next(t for t in snap["data"]["tables"] if t["id"] == "Table 4.8-1")
    assert snap["data"]["tables"][0] is t481 and _digest(t481) == PRE_APPENDIX_E_SHA256["Table 4.8-1"]
    for key in ("glossary", "acronyms", "context_quotes", "change_history"):
        assert _digest(snap["data"][key]) == PRE_APPENDIX_E_SHA256[key], key
    # the 2026-11-14 additions, and the tables only appended to: 4.8-1, E.2-1, then 4.8-3
    assert [t["id"] for t in snap["data"]["tables"]] == ["Table 4.8-1", "Table E.2-1", "Table 4.8-3"]
    for r in reqs[len(old):]:
        assert _digest(r) == PRE_TABLE_483_SHA256[r["id"]], r["id"]
    assert _digest(snap["data"]["tables"][1]) == PRE_TABLE_483_SHA256["Table E.2-1"]
    for key in ("appendix_e", "document", "self_test"):
        assert _digest(snap["data"][key]) == PRE_TABLE_483_SHA256[key], key
    for key in ("source", "retrieved_at"):
        assert _digest(snap[key]) == PRE_TABLE_483_SHA256[key], key
    # A third --offline re-run (15 Nov 2026) named Table 4.8-3 in the title and appended one caveat on how it was
    # read; the title before it and the 11 caveats before it are unchanged.
    assert snap["title"].endswith(", Table 4.8-1 and Table 4.8-3")
    assert _digest(snap["title"].removesuffix(" and Table 4.8-3")) == PRE_TABLE_483_SHA256["title"]
    assert len(snap["caveats"]) == 12 and _digest(snap["caveats"][:11]) == PRE_TABLE_483_SHA256["caveats"]
    assert snap["retrieved_at"] == "2026-11-14T19:05:55Z"


def _t483(snap):
    (t,) = [t for t in snap["data"]["tables"] if t["id"] == "Table 4.8-3"]
    return t


def test_table_483_caveat_says_how_it_was_read_from_its_checks(snap):
    t = _t483(snap)
    (c,) = [c for c in snap["caveats"] if c.startswith("Table 4.8-3 ")]
    assert c == snap["caveats"][-1]
    assert c.startswith(f"Table 4.8-3 (page {t['printed_page']}) is read from the glyph rows of its page: 10 numbers "
                        f"per printed row, 5 energy/fluence column pairs of 20 rows, {t['row_count']} pairs. ")
    assert t["printed_page"] == t["pdf_page_number"] == 42 and t["row_count"] == 100
    ok = sum(x["ok"] for x in t["checks"])
    assert f" {ok} of its {len(t['checks'])} checks pass " in c and (ok, len(t["checks"])) == (8, 8)
    first, last = t["rows"][0], t["rows"][-1]
    assert (f"the printed {first['energy']} / {first['fluence']['text']} and {last['energy']} / "
            f"{last['fluence']['text']}, ") in c
    assert "pdfminer's own text extraction of the page gives the same numbers in the same pairs" in c
    assert c.endswith("the energies strictly rise and the fluences strictly fall.")


def test_table_483_pairs_as_printed(snap):
    t = _t483(snap)
    assert t["caption"] == ("Table 4.8-3—Design Reference SPE Environment Proton Energy Spectrum (Sum of the "
                            "October 1989 Events)")
    assert t["header_verbatim"] == ["Energy (MeV)", "Proton Fluence (#/cm2-MeV)"]
    assert t["columns"] == ["energy", "fluence"] and t["units"] == {"energy": "MeV", "fluence": "#/cm2-MeV"}
    assert (t["pdf_page_index"], t["pdf_page_number"], t["printed_page"]) == (41, 42, 42)
    assert t["verified"] is True and len(t["checks"]) == 8 and all(c["ok"] for c in t["checks"])
    rows = t["rows"]
    assert len(rows) == t["row_count"] == 100
    assert (rows[0]["energy"], rows[0]["fluence"]["text"]) == ("1.000E-02", "7.761E+14")
    assert (rows[-1]["energy"], rows[-1]["fluence"]["text"]) == ("2.500E+03", "3.891E+01")
    assert (rows[0]["energy_mev"], rows[0]["fluence"]["value"]) == (0.01, 7.761e14)
    assert (rows[-1]["energy_mev"], rows[-1]["fluence"]["value"]) == (2500.0, 38.91)
    for r in rows:                     # the shape web/src/features/provenance/snapshots.ts indexes
        assert set(r) == {"energy", "energy_mev", "fluence"} and set(r["fluence"]) == {"text", "value", "unit"}
        assert float(r["energy"]) == r["energy_mev"] and float(r["fluence"]["text"]) == r["fluence"]["value"]
        assert r["fluence"]["unit"] == "#/cm2-MeV"
    e = [r["energy_mev"] for r in rows]
    f = [r["fluence"]["value"] for r in rows]
    assert all(a < b for a, b in zip(e, e[1:])) and all(a > b for a, b in zip(f, f[1:]))
    # the [V1 4031] rationale is the one shipped requirement that names the table
    assert t["cited_by"] == ["[V1 4031]"]
    assert "Table 4.8-3 contains the Design Reference SPE Environment Proton Energy Spectrum." in _req(snap, "4031")["rationale"]


def test_table_483_integrals_within_a_hundredth_of_a_percent(snap):
    from ingest.tests.test_design_reference import integral_above
    pairs = [(r["energy_mev"], r["fluence"]["value"]) for r in _t483(snap)["rows"]]
    for e0, want in ((10.0, 1.92034e10), (100.0, 4.47579e8)):
        assert abs(integral_above(pairs, e0) - want) <= 1e-4 * want, e0


def test_plain_runs_splits_number_runs_from_the_words_before_them():
    text = "Cap\n\nEnergy\n(MeV)\n1.000E-02\n2.000E-02\n\nProton Fluence\n(#/cm2-MeV)\n3.000E+01\n1.000E+01\n\n42 of 86"
    assert sv.plain_runs(text) == [("Cap Energy (MeV)", ["1.000E-02", "2.000E-02"]),
                                   ("Proton Fluence (#/cm2-MeV)", ["3.000E+01", "1.000E+01"])]
    assert sv.plain_runs("10 cm (or g/cm2) 42 of 86") == []


def test_cmo_and_eva_clearance_requirements(snap):
    r6 = _req(snap, "3006")
    assert r6["text"] == ("The program(s) shall train a minimum of two crewmembers per vehicle/platform as Crew Medical "
                          "Officers (CMOs).")
    assert (r6["section"], r6["section_title"], r6["pdf_page_number"]) == ("5.2.1.1", "Crew Medical Officers Quantity", 47)
    assert "It is critical to have two CMOs for each vehicle/platform to ensure that a backup is available for medical " \
           "treatment." in r6["rationale"]
    e6 = _req(snap, "6006")
    assert e6["text"] == ("All crewmembers shall be medically cleared to perform an EVA by ground medical support "
                          "personnel prior to each EVA.")
    assert (e6["section"], e6["section_title"], e6["pdf_page_number"]) == ("6.4", "Extravehicular Activities (EVAs)", 52)
    assert ("Flight Surgeon on ground evaluates available data from recent medical evaluations, fitness sessions, and "
            "other metrics of health and performance to determine readiness for EVA.") in e6["rationale"]
    for r, phrase in ((r6, "a backup is available for medical treatment"), (e6, "recent medical evaluations, fitness sessions")):
        assert r["verified"] is True and r["values"] == [] and r["in_plan_appendix"] is False
        assert {"check": f"rationale contains {phrase!r}", "ok": True} in r["checks"]
        assert all(c["ok"] for c in r["checks"]) and len(r["checks"]) == 2
        assert r["appendix_d"]["same_as_body"] is True


def _imm(snap):
    (t,) = [t for t in snap["data"]["tables"] if t["id"] == "Table E.2-1"]
    return t


def test_table_e21_rows_ranks_and_known_answers(snap):
    t = _imm(snap)
    assert t["caption"] == "Table E.2-1—Sample IMM Output" and t["verified"] is True and all(c["ok"] for c in t["checks"])
    assert t["header_verbatim"] == ["Medical Condition", "Likelihood"]
    rows = t["rows"]
    assert len(rows) == t["row_count"] == 48
    assert [r["rank"] for r in rows] == list(range(1, 49))
    assert (rows[0]["condition"], rows[0]["likelihood"]) == ("Late Insomnia", {"text": "13.85 per mission", "value": 13.85,
                                                                               "unit": "per mission"})
    assert (rows[47]["condition"], rows[47]["likelihood"]["text"], rows[47]["likelihood"]["value"]) == \
        ("Dental Abscess", "0.068 per mission", 0.068)
    total = 0.0
    for r in rows:                     # left to right, as the web app sums it
        assert r["likelihood"]["unit"] == "per mission"
        assert r["likelihood"]["text"] == f"{r['likelihood']['text'].split()[0]} per mission"
        assert float(r["likelihood"]["text"].split()[0]) == r["likelihood"]["value"]
        total = total + r["likelihood"]["value"]
    assert abs(total - 101.808) <= 0.001          # derived: the sum of the 48 printed likelihoods
    # the page break falls after row 36 (PDF pages 81 and 82)
    assert [(p["pdf_page_number"], p["first_rank"], p["last_rank"]) for p in t["pages"]] == [(81, 1, 36), (82, 37, 48)]
    assert {r["pdf_page_number"] for r in rows[:36]} == {81} and {r["pdf_page_number"] for r in rows[36:]} == {82}
    assert all(r["printed_page"] == r["pdf_page_number"] for r in rows)
    names = [r["condition"] for r in rows]
    assert len(set(names)) == 48
    for n in ("Insomnia (SAS)", "Back Pain (SAS)", "Urinary Tract Infection", "Urinary Retention", "CO2 Headache",
              "Spaceflight Associated Neuro-ocular Syndrome (SANS)", "Space Motion Sickness (SAS)"):
        assert n in names, n
    # [V1 3003] (whose rationale the plan follows) and [V1 3004] both point to this table by its caption
    assert t["cited_by"] == ["[V1 3003]", "[V1 3004]"]
    assert "Appendix E, Table E.2-1—Sample IMM Output." in _req(snap, "3003")["rationale"]


def test_appendix_e_context_verbatim(snap):
    e = snap["data"]["appendix_e"]
    assert e["verified"] is True and all(c["ok"] for c in e["checks"])
    assert e["e_2_3_limitation"]["text"] == (
        "One limitation is that IMM was developed for application to ISS missions, but it may be applied to other "
        "design reference missions if the appropriate limitations are considered during interpretation of results.")
    assert (e["e_2_3_limitation"]["section"], e["e_2_3_limitation"]["pdf_page_number"]) == ("E.2.3", 85)
    assert e["e_2_2_inputs"]["text"] == (
        "The IMM requires the user to provide the mission duration, location, number of EVAs and crew attributes (for "
        "example quantity or sex) and will generate the type and probability of occurrence (likelihood) of medical events.")
    assert e["e_2_2_inputs"]["pdf_page_number"] == 81
    t22 = e["table_e_2_2"]
    assert t22["caption"] == ("Table E.2-2—Medical Conditions Considered of High Likelihood or High Consequence for "
                              "Spaceflight Missions")
    assert t22["footnote"]["text"] == ("Conditions noted with an asterisk (*) should be addressed on every mission "
                                       "regardless of the DRM parameters.")
    assert t22["footnote"]["pdf_page_number"] == 85
    assert "summarizes the most common conditions that need to be assessed for missions up to 6 months." in \
        t22["intro_note"]["text"]
    rows = {r["condition"]: r for r in t22["rows"]}
    assert list(rows) == sv.E22_ROWS
    assert rows["Nephrolithiasis"]["text_verbatim"] == "Nephrolithiasis" and rows["Nephrolithiasis"]["asterisk"] is False
    for name in ("Insomnia/sleep disturbances/circadian misalignment", "Headache (CO2 related)",
                 "Urinary retention (space-adaptation related)"):
        assert rows[name]["text_verbatim"] == f"{name} *" and rows[name]["asterisk"] is True, name
    assert [rows[n]["pdf_page_number"] for n in sv.E22_ROWS] == [85, 82, 82, 84]
    assert any("Sample IMM Output" in c and "never as a forecast" in c for c in snap["caveats"])


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
    assert rebuilt["data"]["appendix_e"] == snap["data"]["appendix_e"]
    assert rebuilt["data"]["document"]["sha256"] == sv.PINNED_SHA256


@pytest.fixture(scope="module")
def pdf_pages():
    """(glyph-assembled pages, pdfminer's own plain text per page), from the cached PDF."""
    import io

    from pdfminer.high_level import extract_text

    from ingest._std_vol1_pdf import read_pages
    try:
        pdf = RunContext(offline=True).fetch_bytes(sv.PINNED_PDF_URL)
    except RuntimeError:
        pytest.skip("Vol 1 PDF not in .cache/ingest (run the adapter online once)")
    pages = read_pages(pdf)
    plain = {i: " ".join(extract_text(io.BytesIO(pdf), page_numbers=[i]).split()) for i in (41, 80, 81, 83, 84)}
    return pages, plain


def test_every_table_e21_row_occurs_in_its_pdf_page_text(snap, pdf_pages):
    pages, plain = pdf_pages
    rows = _imm(snap)["rows"]
    for r in rows:
        idx = r["pdf_page_index"]
        # 1. the glyph-assembled line of the page reads exactly "<rank> <condition> <likelihood>"
        assert f"{r['rank']} {r['condition']} {r['likelihood']['text']}" in [ln.text for ln in pages[idx].lines], r["rank"]
        # 2. pdfminer's own text extraction (independent of the glyph assembly) has both cells on that page
        assert r["condition"] in plain[idx] and r["likelihood"]["text"] in plain[idx], r["rank"]
    # 3. and as many 'per mission' cells per page as rows taken from it (no row missed, none invented)
    for idx in (80, 81):
        assert plain[idx].count(" per mission") == sum(1 for r in rows if r["pdf_page_index"] == idx), idx


def test_appendix_e_texts_occur_in_their_pdf_page_text(snap, pdf_pages):
    _, plain = pdf_pages
    e = snap["data"]["appendix_e"]
    t22 = e["table_e_2_2"]
    for item in (e["e_2_2_inputs"], e["e_2_3_limitation"], t22["footnote"], t22["intro_note"]):
        assert item["text"] in plain[item["pdf_page_index"]], item["text"][:60]
    for r in t22["rows"]:
        hit = plain[r["pdf_page_index"]]
        assert r["text_verbatim"] in hit, r["condition"]
    # "Nephrolithiasis" is followed by the next row's name, never by an asterisk
    assert "Nephrolithiasis *" not in plain[83] and "Nephrolithiasis Urinary tract infection *" in plain[83]


def test_table_483_pairs_occur_in_the_pdf_page_text_block_by_block(snap, pdf_pages):
    # Independent of the adapter's parser: every d.dddE±dd number of pdfminer's text of the page, sliced the way
    # the synthesizer read it (5 blocks of 20 energies followed by 20 fluences), gives the shipped pairs.
    import re
    _, plain = pdf_pages
    t = _t483(snap)
    toks = re.findall(r"\d\.\d{3}E[+-]\d{2}", plain[t["pdf_page_index"]])
    assert len(toks) == 200
    pairs = [p for b in range(5) for p in zip(toks[40 * b:40 * b + 20], toks[40 * b + 20:40 * b + 40])]
    assert pairs == [(r["energy"], r["fluence"]["text"]) for r in t["rows"]]
    assert t["caption"] in plain[t["pdf_page_index"]]
    assert plain[t["pdf_page_index"]].count("Energy (MeV)") == 5
    assert plain[t["pdf_page_index"]].count("Proton Fluence (#/cm2-MeV)") == 5
