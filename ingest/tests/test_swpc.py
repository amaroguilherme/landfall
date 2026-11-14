"""Known-answer tests for the SWPC adapter (S-scale, live GOES, Oct-1989 replay, SPE list).

Fixtures are trimmed copies of the real fetched markup/text (structure kept exactly),
so the parsers are tested against what NOAA actually serves, offline.
"""

import json
import math
import re
from datetime import datetime

import pytest

from ingest.common import DEFAULT_OUT_DIR, validate_snapshot
from ingest.swpc import (NOAA_S_THRESHOLDS_PFU, hourly_max, parse_donki_sep, parse_ncei_goes_csv,
                         parse_s_scale_html, parse_s_scale_pdf_text, parse_spe_list_html,
                         parse_spe_list_notes, parse_time_z, s_level, select_channel, sesc_event,
                         spe_list_quirks, to_grid)


# ------------------------------------------------------------ flux -> S level, every boundary
@pytest.mark.parametrize("flux,level", [
    (0.0, 0), (0.2287, 0), (9.999, 0),
    (10.0, 1), (10.0001, 1), (99.99, 1),
    (100.0, 2), (999.9, 2),
    (1000.0, 3), (9999.9, 3),
    (10000.0, 4), (99999.0, 4),
    (100000.0, 5), (1e7, 5),
])
def test_s_level_boundaries(flux, level):
    # NOAA counts events "when flux level was met" and SESC uses ">= 10 pfu": thresholds are inclusive.
    assert s_level(flux) == level


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), -1.0, -99999.0, "abc", True])
def test_missing_or_invalid_flux_is_unknown_not_s0(bad):
    # [V2 10020]: missing data must never render as "S0 - all clear".
    assert s_level(bad) is None


def test_thresholds_constant_matches_noaa_page_values():
    assert dict(NOAA_S_THRESHOLDS_PFU) == {1: 10.0, 2: 100.0, 3: 1000.0, 4: 10000.0, 5: 100000.0}


def test_real_world_anchor_values():
    assert s_level(40000.0) == 4   # NOAA list, 1989 Oct 19 event peak
    assert s_level(42200.0) == 4   # GOES-7 corrected peak, 1989-10-20 16:00
    assert s_level(10000.0) == 4   # NOAA list, 1994 Feb 20 event: exactly on the S4 boundary
    assert s_level(1490.0) == 3    # NOAA list, 2017 Sep 10 event


# ------------------------------------------------------------ UTC timestamps
def test_parse_time_z_variants_are_utc():
    assert parse_time_z("2026-11-14T07:05:00Z") == datetime(2026, 11, 14, 7, 5)
    assert parse_time_z("2024-01-03T21:00Z") == datetime(2024, 1, 3, 21, 0)          # DONKI style
    assert parse_time_z("1989-10-20 16:00:00.000") == datetime(1989, 10, 20, 16, 0)  # NCEI CSV
    assert parse_time_z("2026-11-14T04:05:00-03:00") == datetime(2026, 11, 14, 7, 5)  # offset -> UTC


# ------------------------------------------------------------ multi-channel file + satellite switching
def _rec(t, sat, flux, energy):
    return {"time_tag": t, "satellite": sat, "flux": flux, "energy": energy}


def test_select_channel_exact_match_never_mixes_100mev():
    recs = [_rec("2026-11-14T07:05:00Z", 18, 0.21, ">=10 MeV"),
            _rec("2026-11-14T07:05:00Z", 18, 0.19, ">=100 MeV"),
            _rec("2026-11-14T07:05:00Z", 18, 2.19, ">=1 MeV")]
    pts, _ = select_channel(recs, ">=10 MeV")
    assert [p[1] for p in pts] == [0.21]
    pts100, _ = select_channel(recs, ">=100 MeV")
    assert [p[1] for p in pts100] == [0.19]


def test_select_channel_reports_switch_and_prefers_declared_primary():
    recs = [_rec("2026-11-14T07:00:00Z", 18, 0.2, ">=10 MeV"),
            _rec("2026-11-14T07:05:00Z", 18, 0.3, ">=10 MeV"),
            _rec("2026-11-14T07:05:00Z", 19, 0.9, ">=10 MeV"),   # duplicate time, other satellite
            _rec("2026-11-14T07:10:00Z", 19, 0.4, ">=10 MeV")]
    pts, switches = select_channel(recs, ">=10 MeV", primary_satellite=18)
    assert [(p[1], p[2]) for p in pts] == [(0.2, 18), (0.3, 18), (0.4, 19)]
    assert switches == [{"time_tag": "2026-11-14T07:10:00Z", "from_satellite": 18, "to_satellite": 19}]


def test_select_channel_drops_null_and_negative_flux():
    recs = [_rec("2026-11-14T07:00:00Z", 18, None, ">=10 MeV"),
            _rec("2026-11-14T07:05:00Z", 18, -1e5, ">=10 MeV"),
            _rec("2026-11-14T07:10:00Z", 18, 0.25, ">=10 MeV")]
    pts, _ = select_channel(recs, ">=10 MeV")
    assert [p[1] for p in pts] == [0.25]


# ------------------------------------------------------------ 5-minute cadence, gaps, downsampling
def test_grid_keeps_gaps_as_null():
    pts = [(datetime(2026, 11, 10, 18, 50), 0.2), (datetime(2026, 11, 10, 19, 0), 0.3)]  # 18:55 missing
    g = to_grid(pts, 300)
    assert g["values"] == [0.2, None, 0.3] and g["missing"] == 1 and g["n"] == 3


def test_hourly_max_preserves_a_single_5min_threshold_crossing():
    pts = [(datetime(2026, 11, 14, 7, m), 0.2) for m in range(0, 60, 5)]
    pts[6] = (datetime(2026, 11, 14, 7, 30), 12.0)   # one 5-minute sample at S1
    h = hourly_max(pts)
    assert h["values"] == [12.0] and h["samples_per_hour"] == [12]
    assert s_level(h["values"][0]) == 1  # a mean (~1.18 pfu) would have hidden it


# ------------------------------------------------------------ SESC event rule
def _series(vals, start=datetime(1989, 10, 19, 13, 0)):
    from datetime import timedelta
    return [(start + timedelta(minutes=5 * i), v) for i, v in enumerate(vals)]


def test_sesc_two_points_are_not_an_event():
    assert sesc_event(_series([1, 12, 15, 3, 2])) is None


def test_sesc_three_consecutive_points_start_an_event():
    ev = sesc_event(_series([1, 12, 15, 30, 9, 11, 2]))
    assert ev["start"] == "1989-10-19T13:05:00Z"
    assert ev["end_last_ge_10pfu"] == "1989-10-19T13:25:00Z"
    assert ev["max_pfu"] == 30 and ev["max_s_level"] == 1


def test_sesc_skips_missing_points():
    ev = sesc_event(_series([1, 12, None, 15, 30, 2]))
    assert ev["start"] == "1989-10-19T13:05:00Z"


def test_sesc_unbroken_run_vs_literal_end():
    # flux dips below 10 pfu, then touches 10 again: the literal SESC end is the later touch
    ev = sesc_event(_series([1, 12, 15, 30, 9, 11, 2]))
    assert ev["unbroken_ge_10pfu_until"] == "1989-10-19T13:15:00Z"
    assert ev["end_last_ge_10pfu"] == "1989-10-19T13:25:00Z"


# ------------------------------------------------------------ NOAA scales page (real markup, trimmed)
SCALES_HTML = """
<table class="scales_table"><colgroup><col width="5%"/></colgroup>
<tr><th><strong>Scale</strong></th><th><strong>Description</strong></th><th><strong>Effect</strong></th>
<th><strong>Physical measure</strong><br/>(Flux level of &gt;= 10 MeV particles)</th>
<th><strong>Average Frequency</strong><br/>(1 cycle = 11 years)</th></tr>
<tr><td class="noaa_scale_bg_5 numeric_scale">S 5</td><td class="scale_description">Extreme</td>
<td><p><b>Biological:</b> Unavoidable high radiation hazard to astronauts on EVA (extra-vehicular activity); passengers and crew in high-flying aircraft at high latitudes may be exposed to radiation risk.</p></td>
<td>10<sup>5</sup></td><td>Fewer than 1 per cycle</td></tr>
<tr><td class="noaa_scale_bg_4 numeric_scale">S 4</td><td class="scale_description">Severe</td>
<td><p><b>Biological:</b> Unavoidable radiation hazard to astronauts on EVA; passengers and crew in high-flying aircraft at high latitudes may be exposed to radiation risk.</p></td>
<td>10<sup>4</sup></td><td>3 per cycle</td></tr>
<tr><td class="noaa_scale_bg_3 numeric_scale">S 3</td><td class="scale_description">Strong</td>
<td><p><b>Biological:</b> Radiation hazard avoidance recommended for astronauts on EVA; passengers and crew in high-flying aircraft at high latitudes may be exposed to radiation risk.</p>
<p><b>Satellite operations:</b> Single-event upsets, noise in imaging systems, and slight reduction of efficiency in solar panel are likely.</p></td>
<td>10<sup>3</sup></td><td>10 per cycle</td></tr>
<tr><td class="noaa_scale_bg_2 numeric_scale">S 2</td><td class="scale_description">Moderate</td>
<td><p><b>Biological:</b> Passengers and crew in high-flying aircraft at high latitudes may be exposed to elevated radiation risk.</p></td>
<td>10<sup>2</sup></td><td>25 per cycle</td></tr>
<tr><td class="noaa_scale_bg_1 numeric_scale">S 1</td><td class="scale_description">Minor</td>
<td><p><b>Biological:</b> None.</p></td><td>10</td><td>50 per cycle</td></tr>
</table>"""


def test_parse_s_scale_html_thresholds_and_verbatim_text():
    lv = {x["level"]: x for x in parse_s_scale_html(SCALES_HTML)}
    assert [lv[k]["threshold_pfu"] for k in ("S1", "S2", "S3", "S4", "S5")] == [10, 100, 1000, 10000, 100000]
    assert lv["S1"]["threshold_as_printed"] == "10"       # no <sup>: must not become 10**1 by accident
    assert lv["S3"]["threshold_as_printed"] == "10^3"     # <sup>3</sup> must not be read as "103"
    assert lv["S3"]["effects"]["Biological"].startswith("Radiation hazard avoidance recommended for astronauts on EVA")
    assert lv["S1"]["effects"]["Biological"] == "None."
    assert lv["S3"]["descriptor"] == "Strong" and lv["S3"]["average_frequency"] == "10 per cycle"


PDF_TEXT = """NOAA Space Weather Scales
Solar Radiation Storms
S 5
Biological: unavoidable high radiation hazard to astronauts on EVA (extra-vehicular activity); passengers and
crew in high-flying aircraft at high latitudes may be exposed to radiation risk. ***
Satellite operations:  satellites may be rendered useless
Biological: unavoidable radiation hazard to astronauts on EVA; passengers and crew in high-flying aircraft at
high latitudes may be exposed to radiation risk.***
Satellite operations: may experience memory device problems
Biological: radiation hazard avoidance recommended for astronauts on EVA; passengers and crew in high-flying
aircraft at high latitudes may be exposed to radiation risk.***
Satellite operations: single-event upsets
Biological: passengers and crew in high-flying aircraft at high latitudes may be exposed to elevated radiation
risk.***
Satellite operations: infrequent single-event upsets possible.
Biological: none.
Satellite operations: none.
Flux levels are 5 minute averages. Flux in particles·s-1·ster-1·cm-2 Based on this measure, but other physical measures are also considered.
**      These events can last more than one day.
***    High energy particle (>100 MeV) are a better indicator of radiation risk to passenger and crews.  Pregnant women are particularly susceptible.
Radio Blackouts
Kp=5

1700 per cycle
(900 days per cycle)

Flux level of >
10 MeV
particles (ions)*
105

M1
(10-5)

December 11, 2023
"""


def test_parse_s_scale_pdf_text_orders_levels_and_keeps_footnotes():
    out = parse_s_scale_pdf_text(PDF_TEXT)
    assert out["biological_by_level"]["S3"].startswith("radiation hazard avoidance recommended for astronauts on EVA")
    assert out["biological_by_level"]["S1"] == "none."
    assert out["footnotes"][0].startswith("Flux levels are 5 minute averages.")
    assert "particles·s-1·ster-1·cm-2" in out["footnotes"][0]
    assert out["footnotes"][2].startswith("High energy particle (>100 MeV)")
    # The PDF header says '>' where the HTML says '>=': it must be captured, not normalised away.
    assert out["column_header"] == "Flux level of > 10 MeV particles (ions)"
    assert out["printed_date"] == "December 11, 2023"


# ------------------------------------------------------------ NCEI GOES-7 CSV
NCEI_CSV = """File name: g07_eps_5m_19891001_19891031
float p3_flux_ic(record);
p3_flux_ic:description = "P3 Proton ingegral > 10 MeV corrected.";
p3_flux_ic:units = "p/(cm^2 s sr)";
p3_flux_ic:missing_value = "-99999";
:satellite_id = "GOES-07"
:sample-time = "5"
data:
time_tag,p3_flux_ic
1989-10-20 15:55:00.000,4.1000E+04
1989-10-20 16:00:00.000,4.2200E+04
1989-10-20 16:05:00.000,-99999
"""


def test_parse_ncei_csv_units_and_missing_value():
    meta, rows = parse_ncei_goes_csv(NCEI_CSV, ["p3_flux_ic"])
    assert meta["satellite_id"] == "GOES-07" and meta["sample-time"] == "5"
    assert meta["columns"]["p3_flux_ic"]["units"] == "p/(cm^2 s sr)"   # = pfu
    assert [r["p3_flux_ic"] for r in rows] == [41000.0, 42200.0, None]
    assert rows[1]["t"] == datetime(1989, 10, 20, 16, 0)


# ------------------------------------------------------------ NOAA SPE list (unclosed tags, real layout)
SPE_HTML = """<table>
<tr><td><td><td><td><strong>1989</strong><td><td><td><td><td>
<tr><td>Oct 19/1305<td>Oct 20/1600<td align = right>    40,000<td><td>
    <td>Oct 19/1258  <td>X13/4B<td>S27E10<td align = right>5747
<tr><td>Dec 30/2200<td>Jan 01/0300<td align = right>        15<td><td><td><td><td><td>
<tr><td><td><td><td><strong>2003</strong><td><td><td><td><td>
<tr><td>Jun 18/2050<td>June 19/0450<td align = right>   24<td>
    <td>Halo /17 2230<td>Jun 17/2255<td>M6<td>S08E61<td align = right>10386</tr>
</table>
<p>For more information on SEP events, contact A. Person of NOAA. Web curator: B. Person</p>"""


def test_parse_spe_list_known_rows():
    ev = parse_spe_list_html(SPE_HTML)
    oct89 = ev[0]
    assert (oct89["start"], oct89["max"], oct89["peak_pfu"], oct89["s_level"]) == \
        ("1989-10-19T13:05:00Z", "1989-10-20T16:00:00Z", 40000.0, 4)
    assert ev[1]["max"] == "1990-01-01T03:00:00Z"          # max rolls into the next year
    assert ev[2]["max"] == "2003-06-19T04:50:00Z"          # full month name "June"
    assert all("Person" not in (e["associated"] or "") for e in ev)  # page footer never leaks into a row


SPE_NOTES_HTML = """<tr><td>Sep 10/1645<td>Sep&nbsp;11/1145<td align = right>   1490<td></tr>
</table></center><p><hr>
<a name = "NOTE_1"></a>
<sup>[1]</sup> &nbsp; The >100 MeV protons peaked at 652 pfu at
20/0710 UTC, which was the highest >100 MeV proton flux level observed since 1989 October
(680 pfu). The >10 MeV proton event finally ended at 22/1755 UTC.
<hr>
<strong>Please Note:</strong>
  Proton fluxes are integral 5-minute averages for energies
>10 MeV, given in Particle Flux Units (pfu), measured by GOES spacecraft
at Geosynchronous orbit:
1 pfu = 1 p cm<sup>-2</sup> sr<sup>-1</sup> s<sup>-1</sup>.  SESC defines the start
<hr><address>Web curator: A. Person, contact B. Person</address></body>"""


def test_parse_spe_list_notes_verbatim_and_bounded():
    n = parse_spe_list_notes(SPE_NOTES_HTML)
    assert n["oct1989_ge100mev_peak_pfu_per_note"] == 680.0
    assert n["footnotes_verbatim"]["[1]"].startswith("The >100 MeV protons peaked at 652 pfu")
    assert n["units_note_verbatim"].endswith("1 pfu = 1 p cm^-2 sr^-1 s^-1.")
    assert "Person" not in json.dumps(n)   # the contact block after the last <hr> never leaks


def test_spe_list_quirks_flags_duplicates_and_ambiguous_times():
    ev = [{"start": "2014-01-06T09:15:00Z", "start_as_printed": "Jan 06/0915", "max_as_printed": "Jan 06/1600",
           "peak_pfu": 42.0, "associated": "(Farside)"},
          {"start": "2014-01-06T09:15:00Z", "start_as_printed": "Jan 06/0915", "max_as_printed": "Jan 09/0340",
           "peak_pfu": 1033.0, "associated": "X1"},
          {"start": "2013-06-23T20:14:00Z", "start_as_printed": "Jun 23 2014", "max_as_printed": "Jun 24/0520",
           "peak_pfu": 14.0, "associated": None},
          {"start": "2013-09-30T05:05:00Z", "start_as_printed": "Sep 30 0505", "max_as_printed": "Sep 30/2005",
           "peak_pfu": 182.0, "associated": None}]
    q = " ".join(spe_list_quirks(ev))
    assert "2014-01-06T09:15:00Z 2 times" in q and "1033 pfu" in q and "42 pfu" in q
    assert "'Jun 23 2014' has no '/'" in q            # 20:14 is off the 5-minute grid -> uncertain
    assert "'Sep 30 0505' has no '/'" not in q        # 05:05 is on the grid: listed, not flagged uncertain


def test_parse_donki_normalises_minute_precision_times():
    out = parse_donki_sep([{"sepID": "X-SEP-001", "eventTime": "2024-05-11T02:10Z",
                            "instruments": [{"displayName": "GOES-P: SGPS 10 MeV"}], "linkedEvents": None}])
    assert out[0]["event_time"] == "2024-05-11T02:10:00Z" and out[0]["linked_events"] == []


# ------------------------------------------------------------ the frozen files themselves
FILES = {p.stem: p for p in DEFAULT_OUT_DIR.glob("swpc_*.json")}


@pytest.mark.skipif(not FILES, reason="run `python -m ingest swpc` first")
def test_frozen_files_contract_and_size_budget():
    total = 0
    for stem, p in FILES.items():
        snap = json.loads(p.read_text())
        validate_snapshot(snap)
        assert snap["id"] == stem and stem.startswith("swpc_") and snap["adapter"] == "swpc"
        total += p.stat().st_size
    assert total < 600_000


@pytest.mark.skipif("swpc_s_scale" not in FILES, reason="no s_scale snapshot")
def test_frozen_s_scale_matches_constants():
    snap = json.loads(FILES["swpc_s_scale"].read_text())
    lv = snap["data"]["levels"]
    assert {x["n"]: x["threshold_pfu"] for x in lv} == dict(NOAA_S_THRESHOLDS_PFU)
    s3 = next(x for x in lv if x["level"] == "S3")
    assert "Radiation hazard avoidance recommended for astronauts on EVA" in s3["effects"]["Biological"]
    pv = snap["data"]["pdf_version"]
    if pv:  # values read from the PDF itself (sha256 verified by an independent curl on 2026-11-14)
        assert pv["printed_date"] in snap["source"]["citation"]
        if pv["sha256"] == "7dc3efc75a8bd26af490c70e38bcaf41a616748a60530c520a4bda81d93a4800":
            assert pv["printed_date"] == "December 11, 2023"
            assert pv["title_metadata"] == "NOAA Weather Scales 11 December 2023"
            assert any("Operator wording differs" in c for c in snap["caveats"])


@pytest.mark.skipif("swpc_spe_replay" not in FILES, reason="no replay snapshot")
def test_frozen_replay_is_real_oct_1989_s4():
    snap = json.loads(FILES["swpc_spe_replay"].read_text())
    assert snap["provenance"] == "measured" and snap["freshness"]["kind"] == "historical"
    assert any("HISTORICAL REPLAY - NOT CURRENT CONDITIONS" in c for c in snap["caveats"])
    g = snap["data"]["series_ge10mev"]
    vals = g["values"]
    k = max(range(len(vals)), key=lambda i: vals[i] if vals[i] is not None else -1)
    from datetime import timedelta
    t_peak = parse_time_z(g["start"]) + timedelta(seconds=k * g["step_s"])  # naive UTC arithmetic only
    assert vals[k] == 42200.0 and t_peak == datetime(1989, 10, 20, 16, 0)
    assert snap["data"]["sesc_event_computed"]["max_s_level"] == 4
    assert g["step_s"] <= 3600
    # Independently re-derived from a fresh curl of the NCEI CSV on 2026-11-14:
    ev = snap["data"]["sesc_event_computed"]
    assert (ev["start"], ev["unbroken_ge_10pfu_until"], ev["end_last_ge_10pfu"]) == \
        ("1989-10-19T13:10:00Z", "1989-10-28T19:30:00Z", "1989-10-29T22:20:00Z")
    assert snap["data"]["max_ge100mev"] == {"time_tag": "1989-10-20T15:25:00Z", "flux_pfu": 531.0}
    assert g["missing"] == 17 and snap["data"]["series_ge100mev"]["missing"] == 16
    cav = " ".join(snap["caveats"])
    assert "'P3 Proton ingegral > 10 MeV corrected.'" in cav   # verbatim, source typo kept
    assert "680 pfu" in cav and "531 pfu" in cav               # NOAA's >100 MeV figure vs this file


@pytest.mark.skipif("swpc_protons_live" not in FILES, reason="no live snapshot")
def test_frozen_live_current_level_consistent():
    d = json.loads(FILES["swpc_protons_live"].read_text())["data"]
    assert d["energy"] == ">=10 MeV" and d["unit"] == "pfu"
    assert d["current"]["s_level"] == s_level(d["current"]["flux_pfu"])
    assert d["series_6h"]["step_s"] == 300


@pytest.mark.skipif("swpc_spe_list" not in FILES, reason="no SPE list snapshot")
def test_frozen_spe_list_has_no_contact_footer():
    raw = FILES["swpc_spe_list"].read_text()
    # Only the LAST row runs into the page footer (contact block): it must end exactly at its region number.
    ev = json.loads(raw)["data"]["events"]
    assert ev[-1]["start"] == "2017-09-10T16:45:00Z"
    assert ev[-1]["associated"] == "Asymmetric full halo/10 1600 | 10/1606 | X8 | S08W83 | 12673"
    low = raw.lower()
    assert all(w not in low for w in ("curator", "contact", "responsible official"))
    assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", raw)            # no e-mail address
    assert not re.search(r"\(?\b\d{3}\)?[ -]\d{3}-\d{4}\b", raw)     # no phone number
    oct89 = next(e for e in ev if e["start"] == "1989-10-19T13:05:00Z")
    assert oct89["peak_pfu"] == 40000.0 and oct89["max"] == "1989-10-20T16:00:00Z"
    assert not math.isnan(sum(e["peak_pfu"] for e in ev if e["peak_pfu"] is not None))
    assert len(ev) == 266  # cross-checked by 3 independent parses of the 2026-11-14 page


@pytest.mark.skipif("swpc_spe_list" not in FILES, reason="no SPE list snapshot")
def test_frozen_spe_list_discloses_source_quirks():
    snap = json.loads(FILES["swpc_spe_list"].read_text())
    cav = " ".join(snap["caveats"])
    assert "2014-01-06T09:15:00Z 2 times" in cav            # duplicated start row in the source
    assert "'Jun 23 2014'" in cav and "uncertain" in cav     # slash-less, off-grid start
    assert "rounded" not in cav                              # the page never says the peaks are rounded
    assert snap["data"]["units_note_verbatim"].startswith(
        "Proton fluxes are integral 5-minute averages for energies >10 MeV")
    assert "(680 pfu)" in snap["data"]["footnotes_verbatim"]["[1]"]


def test_donki_chunks_cover_span_within_gateway_limit():
    from datetime import date, timedelta

    from ingest.swpc import DONKI_API_MAX_DAYS, donki_chunks

    chunks = donki_chunks("2024-01-01", "2026-11-14")
    assert chunks[0][0] == "2024-01-01" and chunks[-1][1] == "2026-11-14"
    for (a, b), nxt in zip(chunks, chunks[1:] + [None]):
        span = (date.fromisoformat(b) - date.fromisoformat(a)).days + 1
        assert 1 <= span <= DONKI_API_MAX_DAYS
        if nxt:  # contiguous, no gap, no overlap
            assert date.fromisoformat(nxt[0]) == date.fromisoformat(b) + timedelta(days=1)
    assert donki_chunks("2026-11-14", "2026-11-14") == [("2026-11-14", "2026-11-14")]
