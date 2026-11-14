"""Known-answer tests for the hrp adapter: parser pitfalls (inline HTML, no network) and the
frozen snapshots in web/public/data/hrp_*.json (skipped if the adapter has not been run)."""

import json

import pytest

from ingest import hrp
from ingest.common import DEFAULT_OUT_DIR, validate_snapshot

# ---------------------------------------------------------------- parser pitfalls (offline)


def test_br_becomes_space_and_abbr_gets_no_stray_space():
    s = hrp.soupify("<p>harm the body and spacecraft.<br>When astronauts travel</p>"
                    "<p>development of the <abbr title='x'>CANS</abbr>, a compact</p>")
    ps = [hrp.clean(p) for p in s.find_all("p")]
    assert ps[0] == "harm the body and spacecraft. When astronauts travel"
    assert ps[1] == "development of the CANS, a compact"          # not "CANS , a compact"


def test_risk_name_aliases_resolve_page_typos():
    assert hrp.norm_risk_name("Risk of Cardiovascular Adaptions") == "risk of cardiovascular adaptations"
    assert (hrp.norm_risk_name("Risk of Behavioral Conditions and Psychiatric Disorders")
            == "risk of behavioral changes and psychiatric disorders")
    assert (hrp.norm_risk_name("Risk from Inadequate Sleep and Irregular Schedules")
            == "risk of inadequate sleep and irregular schedules")


HRR_TITLES = {
    179: "Risk of Cardiovascular Adaptations Contributing to Adverse Mission Performance and Health Outcomes",
    168: "Risk of Mission Impacts and Long-Term Health Issues due to Decompression Sickness",
    85: "Risk of In Mission Impacts, Adverse Health Events or Long-Term Health Impacts due to Altered Immune Response",
    173: "Risk of Reduced Crew Health and Performance Due to Hypoxia",
}


def test_wrong_nasa_hrr_link_is_caught_and_resolved_by_title():
    chk = hrp.check_hrr_link("Risk of mission impacts and long-term health issues due to decompression sickness",
                             179, HRR_TITLES)
    assert chk["hrr_risk_id"] == 168 and chk["check"].startswith("MISMATCH")
    chk = hrp.check_hrr_link("Risk of reduced crew health and performance due to hypoxia", 85, HRR_TITLES)
    assert chk["hrr_risk_id"] == 173


def test_correct_link_survives_wording_drift():
    # nasa.gov says "..., or ... altered immune system response"; HRR says "... or ... Altered Immune Response"
    chk = hrp.check_hrr_link("Risk of in mission impacts, adverse health events, or long-term health impacts "
                             "due to altered immune system response", 85, HRR_TITLES)
    assert chk["hrr_risk_id"] == 85 and not chk["check"].startswith("MISMATCH")


def test_measurement_anchor_missing_is_dropped_not_invented():
    out, missing = hrp.extract_measurements(
        "Data will be collected using actigraphy and behavioral performance surveys before and after the mission.",
        [("actigraphy", "wrist sensor", None), ("behavioral performance surveys", None, "before and after the mission")])
    assert [m["what"] for m in out] == ["behavioral performance surveys"]
    assert missing == ["wrist sensor"]            # ARCHeR never says "wrist"


RESEARCH_HTML = """<main>
<h2>Human Investigations on NASA's Artemis II Mission</h2>
<h3>ARCHeR</h3><p>A study.</p><a href="https://www.nasa.gov/reference/archer/">Read</a>
<h2>Past Human Investigations</h2>
<h3>Tempus Pro</h3><p>Test-driving.</p><a href="https://www.nasa.gov/reference/tempus-pro/">Read</a>
<h2>HRP Overview</h2>
<h3>Who We Are</h3><p>HRP uses research.</p><a href="https://www.nasa.gov/hrp/">Learn</a>
</main>"""


def test_research_sections_and_overview_block_excluded():
    rs = hrp.parse_research_overview(RESEARCH_HTML)
    assert [i["name"] for i in rs["investigations"]] == ["ARCHeR", "Tempus Pro"]
    assert [i["setting"] for i in rs["investigations"]] == ["artemis_ii", "past"]


HRR_RISK_HTML = """<div id="ctl00_content_riskContent">
<div><span style="font-weight:bold;">Short Title:</span>&nbsp;Renal Stone
<span style="font-weight:bold;">Last Published:</span>&nbsp;<span id="ctl00_content_ltlLastPublished">05/13/25 12:40:12 PM (Central)</span></div>
<div><span style="font-weight:bold;">HRP Risk Status:</span>&nbsp;Active [current research ongoing]</div>
<table id="ctl00_content_tblRiskRatings">
<tr><td>DRM Categories</td></tr>
<tr id="ctl00_content_trLEO6mo"><td rowspan="2">Low Earth Orbit</td><td>Short (&lt;30 days)</td>
<td id="ctl00_content_tdLEO6moOpsLxC">1x4</td><td id="ctl00_content_tdLEO6moOpsDisposition">Accepted with Monitoring</td>
<td id="ctl00_content_tdLEO6moLTHLxC">1x3</td><td id="ctl00_content_tdLEO6moLTHDisposition">Accepted with Monitoring</td></tr>
<tr id="ctl00_content_trLEO1yr"><td>Long (30 days-1 year)</td>
<td id="ctl00_content_tdLEO1yrOpsLxC">3x4</td><td id="ctl00_content_tdLEO1yrOpsDisposition">Accepted with Monitoring</td>
<td id="ctl00_content_tdLEO1yrLTHLxC">2x3</td><td id="ctl00_content_tdLEO1yrLTHDisposition">Accepted with Monitoring</td></tr>
<tr><td>Note: LxC is the likelihood and consequence rating.</td></tr>
</table>
<div id="ctl00_content_divRiskStatement">Risk Statement</div><div>Given changes in urinary biochemistry.</div>
<p>B5: What is the state? Responsible Element: Exploration Medical Capability (ExMC) Status: Closed</p>
</div>"""


def test_hrr_risk_page_labels_rowspan_and_status():
    d = hrp.parse_hrr_risk_page(HRR_RISK_HTML, ["B5: What is the state?"])
    assert d["hrp_risk_status"] == "Active [current research ongoing]"
    assert d["last_published"] == "05/13/25 12:40:12 PM (Central)"     # not polluted by Short Title
    assert d["short_title"] == "Renal Stone"
    r0, r1 = d["ratings"]
    assert r0["duration"] == "Short (<30 days)"                          # label text, not the id "LEO6mo"
    assert r1["mission_type"] == "Low Earth Orbit"                       # rowspan carried forward
    assert r1["operations"] == {"lxc": "3x4", "disposition": "Accepted with Monitoring"}
    assert d["risk_statement"] == "Given changes in urinary biochemistry."
    assert d["gap_status"]["B5: What is the state?"]["status"] == "Closed"   # no "(closed)" suffix needed


def test_sentence_split_after_closing_quote():
    s = hrp.sentences("He said “we will go to Mars.” The crew will test drive, a device. Then “the bends” stay.")
    assert s == ["He said “we will go to Mars.”", "The crew will test drive, a device.",
                 "Then “the bends” stay."]


DCS_HTML = """<main><h2>Risk of Decompression Sickness</h2>
<p>Formal risk description: <a href="https://humanresearchroadmap.nasa.gov/Risks/risk.aspx?i=179">Risk of
mission impacts and long-term health issues due to decompression sickness</a></p>
<p><em>Explore more: <a href="https://www.nasa.gov/directorates/esdmd/hhp/behavioral-health-risk/">Human System</a><a
href="https://www.nasa.gov/directorates/esdmd/hhp/risk-of-decompression-sickness/"> Risk Board resources</a></em></p>
</main>"""


def test_explore_more_split_anchors_kept_and_resolved_by_title():
    d = hrp.parse_risk_page(DCS_HTML)
    links = d["hsrb_resources_links"]
    assert [lk["text"] for lk in links] == ["Human System", "Risk Board resources"]
    titles = {links[0]["href"]: "Risk of Adverse Cognitive or Behavioral Changes and Psychiatric Disorders "
                                "Leading to In-mission Health and Performance and Long-term Health Effects",
              links[1]["href"]: "Risk of Mission Impacts and Long-Term Health Issues due to Decompression Sickness"}
    pick = hrp.pick_hsrb_link(links, d["formal_risk_description"], titles)
    assert pick["url"].endswith("/hhp/risk-of-decompression-sickness/") and pick["check"].startswith("SPLIT LINK")
    # no title evidence -> null, never a silent first-anchor guess
    assert hrp.pick_hsrb_link(links, d["formal_risk_description"], {})["url"] is None
    assert hrp.pick_hsrb_link(links[:1], None, {})["check"] == "single link"


def test_impact_stops_at_type_of_study():
    html = """<main><h1>Impact</h1><p>Results will inform protocols.</p>
    <p><strong>Type of study:</strong> Flight</p><p><em>Formal project title: Tempus Pro</em></p></main>"""
    d = hrp.parse_investigation_page(html)
    assert d["impact"] == "Results will inform protocols." and d["type_of_study"] == "Flight"


def test_hrr_red_editorial_note_split_from_risk_statement():
    html = """<div id="ctl00_content_divRiskStatement">Risk Statement</div><div class="collapsibleSection">
    <strong><span style="color: #ff0000;"><strong><span style="font-family: x; color: red; background: white;">LxC
    is the likelihood and consequence rating. Approved under the previous 3x4 LxC matrix.</span></strong></span></strong><br />
    <br />Given crew is exposed to radiation, there is&nbsp;the possibility for increased cancer morbidity.<br /></div>"""
    d = hrp.parse_hrr_risk_page(html)
    assert d["risk_statement"] == "Given crew is exposed to radiation, there is the possibility for increased cancer morbidity."
    assert d["risk_statement_note"] == ("LxC is the likelihood and consequence rating. "
                                        "Approved under the previous 3x4 LxC matrix.")
    plain = hrp.parse_hrr_risk_page('<div id="ctl00_content_divRiskStatement">Risk Statement</div>'
                                    '<div><span style="background-color: red">Given X, Y.</span></div>')
    assert plain["risk_statement"] == "Given X, Y." and plain["risk_statement_note"] is None   # bg colour is not a note


def test_measurement_evidence_covers_with_and_when():
    text = ("By analyzing blood and saliva samples, researchers learn. Blood samples will be collected before and "
            "after the mission, while saliva will be collected during the mission as well. The dry sample "
            "collection process involves blotting saliva onto special paper stored in pocket-sized booklets.")
    out, missing = hrp.extract_measurements(text, [("saliva", "special paper stored in pocket-sized booklets",
                                                    "saliva will be collected during the mission as well")])
    assert not missing and out[0]["from"] == "description"
    assert out[0]["evidence"] == ("Blood samples will be collected before and after the mission, while saliva will be "
                                  "collected during the mission as well. The dry sample collection process involves "
                                  "blotting saliva onto special paper stored in pocket-sized booklets.")


# ---------------------------------------------------------------- frozen snapshots (known answers)


def _load(name):
    p = DEFAULT_OUT_DIR / f"{name}.json"
    if not p.exists():
        pytest.skip(f"{p.name} not built; run `python -m ingest hrp`")
    s = json.loads(p.read_text())
    validate_snapshot(s)
    assert s["id"].startswith("hrp_") and s["provenance"] == "reference"
    assert s["freshness"]["kind"] == "reference"
    return s


def test_hazards_known_answers():
    d = _load("hrp_hazards")["data"]
    assert [h["id"] for h in d["hazards"]] == list(hrp.HAZARD_SLUGS.values())
    grav = next(h for h in d["hazards"] if h["id"] == "gravity_fields")
    joined = " ".join(k["sentence"] for k in grav["page"]["key_sentences"])
    assert "1% to 1.5% of mineral density per month" in joined
    assert "kidney stones due to dehydration and increased excretion of calcium" in joined
    # the page hyperlinks the number to its primary source, the HRR evidence report
    k0 = grav["page"]["key_sentences"][0]
    assert {"text": "1% to 1.5%", "href": "https://humanresearchroadmap.nasa.gov/Evidence/reports/Fracture.pdf"} \
        in k0["links"]


def test_risks_known_answers():
    s = _load("hrp_risks")
    d = s["data"]
    assert len(d["risks"]) == 17
    by_cat = {c: sum(r["category"] == c for r in d["risks"]) for c in ("physiology", "behavioral", "radiation")}
    assert by_cat == {"physiology": 11, "behavioral": 5, "radiation": 1}
    assert d["renal_stone_risk_listed"] is False
    by_slug = {r["slug"]: r for r in d["risks"]}
    assert {by_slug[k]["detail"]["hrr_risk_id"] for k in hrp.KEY_RISK_SLUGS} == {77, 100, 96, 85, 179, 99}
    dcs = by_slug["risk-of-decompression-sickness"]["detail"]
    assert (dcs["hrr_risk_id_linked"], dcs["hrr_risk_id"]) == (179, 168)
    hyp = by_slug["risk-of-hypoxia"]["detail"]
    assert (hyp["hrr_risk_id_linked"], hyp["hrr_risk_id"]) == (85, 173)
    beh = by_slug["risk-of-behavioral-conditions-and-psychiatric-disorders"]["detail"]
    assert beh["canonical_url"].endswith("/risk-of-behavioral-changes-and-psychiatric-disorders/")
    # Split "Explore more" anchors: the first fragment's target belongs to ANOTHER risk.
    assert dcs["hsrb_resources_url"].endswith("/hhp/risk-of-decompression-sickness/")
    assert len(dcs["hsrb_resources_links"]) == 2 and dcs["hsrb_link_check"].startswith("SPLIT LINK")
    sysops = by_slug["risk-of-inadequate-systems-operations-support"]["detail"]
    assert sysops["hsrb_resources_url"].endswith("/hhp/eihso-risk/")
    assert beh["hsrb_resources_url"].endswith("/hhp/behavioral-health-risk/")
    assert by_slug["risk-of-inadequate-teamwork"]["detail"]["hsrb_resources_url"].endswith("/hhp/team-risk/")
    used = [r["detail"]["hsrb_resources_url"] for r in d["risks"]]
    assert len(used) == len(set(used)) == 17                    # every risk has its own HSRB page
    for k in hrp.KEY_RISK_SLUGS:
        det = by_slug[k]["detail"]
        assert 1 <= len(det["top_risks_sentences"]) <= 3 and 1 <= len(det["what_can_be_done_sentences"]) <= 3


def test_research_known_answers():
    d = _load("hrp_research")["data"]
    assert [x["setting"] for x in d["sections"]] == ["artemis_ii", "leo", "past"]
    inv = {i["name"]: i for i in d["investigations"]}
    assert len(inv) == 21 and inv["Tempus Pro"]["setting"] == "past"
    archer = inv["ARCHeR"]["detail"]["measurements"]
    assert any(m["what"] == "actigraphy" for m in archer)
    # ARCHeR's BODY text never says wrist ...
    assert not any("wrist" in json.dumps(m) for m in archer if m["from"] == "description")
    # ... but its featured-image caption (og:image:alt) does, and says what the device measures.
    cap = [m for m in archer if m["from"] == "featured_image_caption"]
    assert len(cap) == 1 and "wear on their wrists" in cap[0]["with"]
    assert cap[0]["what"] == "motion, sleep patterns, and exposure to light"
    assert "wear on their wrists" in inv["ARCHeR"]["detail"]["featured_image_alt"]
    # "Type of study: Flight" is its own paragraph, not part of Impact.
    for name in ("Standard Measures", "Tempus Pro"):
        assert "Type of study" not in inv[name]["detail"]["impact"]
        assert inv[name]["detail"]["type_of_study"] == "Flight"
    sm = {m["what"]: m for m in inv["Standard Measures"]["detail"]["measurements"]}
    assert sm["activity and light exposure"]["with"] == "wrist sensor"
    ib = {m["what"]: m for m in inv["Immune Biomarkers"]["detail"]["measurements"]}
    assert ib["Blood samples"]["when"] == "before and after the mission"
    # evidence must support with/when, not just the first sentence that names "saliva"
    assert "special paper stored in pocket-sized booklets" in ib["saliva"]["evidence"]
    assert "saliva will be collected during the mission as well" in ib["saliva"]["evidence"]
    tp = inv["Tempus Pro"]["detail"]
    assert [m["what"] for m in tp["measurements"]][0] == "blood pressure, heart rate, respiration rate, and temperature"
    assert {m["from"] for m in tp["measurements"]} == {"linked_article"}
    assert tp["measurements"][0]["evidence"].startswith("The crew will test drive")   # quote not glued on
    blob = json.dumps(tp["measurements"]).lower()
    assert "spo2" not in blob and "ecg" not in blob and "oxygen saturation" not in blob
    res = {r["as_written"]: r["risk_slug"] for r in inv["Artemis II Standard Measures"]["detail"]["top_risks_resolved"]}
    assert res["Risk of Cardiovascular Adaptions"] == "risk-of-cardiovascular-adaptations"


def test_roadmap_known_answers():
    s = _load("hrp_roadmap")
    d = s["data"]
    assert d["counts"]["risk_nodes"] == 22 and d["counts"]["marked_nodes"] == 1
    marked = [r for r in d["risks"] if r["explore_marker"]]
    assert [(r["hrr_id"], r["explore_marker"], r["kind"]) for r in marked] == [(78, "inactive", "concern")]
    a = d["answers"]["renal_stone_risk_81"]
    assert a["title"] == "Risk of Renal Stone Formation" and a["element"] == "Exploration Medical Capability"
    assert a["hrp_risk_status"] == "Active [current research ongoing]"
    assert a["last_published"].startswith("05/13/25")
    r81 = next(r for r in d["risks"] if r["hrr_id"] == 81)
    mars = [x for x in r81["detail"]["ratings"] if x["mission_type"] == "Mars"]
    assert mars[-1]["operations"] == {"lxc": "4x4", "disposition": "Requires Mitigation"}
    t = d["answers"]["confirmed_titles"]
    assert "Altered Immune Response" in t["85"]["title"]
    assert "Medical Conditions that occur in Mission" in t["95"]["title"]
    assert "Psychiatric Disorders" in t["99"]["title"]
    assert "Sleep Loss, Circadian Desynchronization" in t["100"]["title"]
    assert "Earth Independent Human-Systems Operations" in t["175"]["title"]
    # HRR 96 opens its Risk Statement with a red 3x4-matrix note; the statement itself starts "Given".
    r96 = next(r for r in d["risks"] if r["hrr_id"] == 96)["detail"]
    assert r96["risk_statement"].startswith("Given crew is exposed to radiation from the space environment")
    assert "previous 3x4 LxC matrix" in r96["risk_statement_note"]
    assert r81["detail"]["risk_statement"].startswith("Given changes in urinary biochemistry")
    assert r81["detail"]["risk_statement_note"] is None
    assert any("3x4" in c for c in s["caveats"])
    assert (DEFAULT_OUT_DIR / "hrp_roadmap.json").stat().st_size < 150_000


def test_csa_known_answers():
    rad = _load("hrp_csa_radiation")["data"]
    assert rad["numbers"][0]["value"] == 30 and rad["numbers"][0]["qualifier"] == "about"
    assert rad["instruments"][0]["full_name"] == "Canadian Active Neutron Spectrometer"
    assert {i["name"] for i in rad["instruments"]} == {"CANS", "MOSFET", "EVARM", "Radi-N and Radi-N2"}
    ins = {i["name"]: i for i in rad["instruments"]}
    assert ins["MOSFET"]["full_name"] == "Metal Oxide Semiconductor Field Effect Transistor"   # link title attr
    assert ins["EVARM"]["full_name"] is None                                                  # not stated
    sci = _load("hrp_csa_science")["data"]
    assert len(sci["deep_space_risks_listed"]) == 5
    assert all(len(x) < 300 for x in sci["extracts"])       # short extracts, no glued list items


def test_total_size_budget():
    files = list(DEFAULT_OUT_DIR.glob("hrp_*.json"))
    if not files:
        pytest.skip("not built")
    assert sum(p.stat().st_size for p in files) < 600_000
