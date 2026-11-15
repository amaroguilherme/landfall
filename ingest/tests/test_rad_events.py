"""Tests for the `rad_events` adapter: the RAD team's SEP nowcast rule replayed on MSL RAD.

Three layers, all without network:
  1. Known-answer tests of the rule arithmetic on synthetic series.
  2. The shipped snapshot (web/public/data/hapi_msl_rad_sep_events.json) against the numbers the
     paper prints and the lane brief's verified values.
  3. When the gitignored cache is present (.cache/ingest/rad_events/), an offline rebuild must
     reproduce the shipped data exactly, and every quote must be in the cached arXiv HTML.
"""

import json
import re
from datetime import date, datetime, timedelta, timezone

import pytest

from ingest import rad_events as R
from ingest.common import DEFAULT_CACHE_DIR, DEFAULT_OUT_DIR, RunContext, validate_snapshot

UTC = timezone.utc
SNAP_PATH = DEFAULT_OUT_DIR / f"{R.SNAPSHOT_ID}.json"
SUB_CACHE = DEFAULT_CACHE_DIR / R.CACHE_SUBDIR


def _snap() -> dict:
    if not SNAP_PATH.exists():
        pytest.skip(f"{SNAP_PATH.name} not built yet (uv run python -m ingest rad_events)")
    return json.loads(SNAP_PATH.read_text())


def _row(snap: dict, day: str) -> dict:
    return next(r for r in snap["data"]["table1"] if r["paper_date"] == day)


def _cached_arxiv() -> str | None:
    p = RunContext(offline=True, cache_dir=SUB_CACHE)._cache_path(R.ARXIV_HTML, None)
    return p.read_text(encoding="utf-8") if p.exists() else None


# ================================================================ 1. rule arithmetic
def _series(start: datetime, step_s: int, values: list[float]) -> tuple[list[int], list[float]]:
    t0 = int(start.timestamp())
    return [t0 + k * step_s for k in range(len(values))], list(values)


def test_paper_row_parsing_known_answers():
    r = R.parse_paper_row("2024-05-20 01d 17h:55m 00d 00h:53m 00d 00h:57m 1730.55")
    assert r == {"date": "2024-05-20", "triggered": True, "shelter_min": 2515, "time_to_peak_min": 53,
                 "lead_time_min": 57, "total_uGy": 1730.55}
    assert R.parse_paper_row("2014-01-05") == {"date": "2014-01-05", "triggered": False}
    with pytest.raises(ValueError):
        R.parse_paper_row("2024-05-20 01d 17h:55m")


def test_every_frozen_row_parses_and_is_in_date_order():
    rows = [R.parse_paper_row(r) for r in R.PAPER_TABLE1_SURFACE]
    assert len(rows) == 16
    assert [r["date"] for r in rows] == sorted(r["date"] for r in rows)
    assert [r["date"] for r in rows if not r["triggered"]] == ["2014-01-05", "2022-03-14", "2024-07-26", "2024-08-04"]


def test_duration_format_is_the_papers():
    assert R.fmt_dhm(2515) == "01d 17h:55m"
    assert R.fmt_dhm(53) == "00d 00h:53m"
    assert R.fmt_dhm(2903.4) == "02d 00h:23m"
    assert R.fmt_dhm(59.5) == "00d 01h:00m"


def test_request_windows_cover_the_span_within_the_server_cap():
    w = R.windows(R.RECORD_START, R.RECORD_STOP)
    assert w[0][0] == R.RECORD_START and w[-1][1] == R.RECORD_STOP
    assert all(a < b <= a + R.ISWA_MAX_SPAN for a, b in w)
    assert all(w[k][1] == w[k + 1][0] for k in range(len(w) - 1))
    assert R.ISWA_MAX_SPAN <= timedelta(days=31)   # iSWA refuses more than 31 days per request
    assert 170 <= len(w) <= 176


def test_record_window_is_pinned_not_derived_from_the_clock():
    assert R.RECORD_START == datetime(2012, 8, 17, tzinfo=UTC)
    assert R.RECORD_STOP == datetime(2026, 11, 13, tzinfo=UTC)
    assert R.PROBE_START <= datetime(2011, 11, 20, 18, 29, 59, tzinfo=UTC)


def test_event_metrics_trapezoid_peak_lead_and_shelter():
    # background 100; samples every 15 min: 100, 200, 300, 200, 100 (the last is below 125).
    T, E = _series(datetime(2024, 1, 1, tzinfo=UTC), 900, [100, 200, 300, 200, 100])
    m = R.event_metrics(T, E, 1, 4, 100.0)
    # (E - bg): 100, 200, 100, 0 -> trapezoids of 150, 150, 50 uGy/day x 1/96 day
    assert m["total_uGy"] == pytest.approx(round(350 / 96, 2))
    assert m["peak"]["after_onset_min"] == 15.0 and m["peak"]["ratio_to_background"] == 3.0
    assert m["shelter_min"] == 45.0 and m["time_to_peak_min"] == 15.0
    # 10% of the total is reached at the first sample after the onset
    assert m["lead_time_min"] == 15.0
    assert m["confirmation"]["above_threshold"] is True and m["confirmation"]["after_onset_min"] == 15.0
    assert m["n_samples"] == 4 and m["max_gap_min"] == 15.0


def test_replay_date_background_onset_and_not_triggered():
    day0 = datetime(2024, 3, 6, tzinfo=UTC)
    quiet = [200.0] * (5 * 96)          # 5 days at 15 min before the date
    T, E = _series(day0 - timedelta(days=5), 900, quiet + [210.0] * 30 + [260.0, 270.0, 240.0] + [200.0] * 300)
    r = R.replay_date(T, E, "2024-03-06")
    assert r["background_uGy_per_day"] == 200.0 and r["threshold_uGy_per_day"] == 250.0
    assert r["triggered"] and r["onset"] == R.iso(T[5 * 96 + 30])
    assert r["confirmation"]["above_threshold"] is True
    assert r["end"] == R.iso(T[5 * 96 + 32])     # 240 < 250: first sample below the threshold
    assert r["unconfirmed"] == []
    flat = quiet + [240.0] * 300
    T2, E2 = _series(day0 - timedelta(days=5), 900, flat)
    r2 = R.replay_date(T2, E2, "2024-03-06")
    assert r2["triggered"] is False and r2["max_ratio_to_background"] == 1.2 and r2["unconfirmed"] == []


def test_replay_date_needs_the_next_sample_to_confirm_the_onset():
    # The paper: "A consecutive measurement is then used as a cross-check to verify or falsify the SEP event."
    day0 = datetime(2024, 3, 6, tzinfo=UTC)
    quiet = [200.0] * (5 * 96)
    # one sample above 1.25 x (260 > 250), the next below: no onset, and the sample is listed as unconfirmed
    T, E = _series(day0 - timedelta(days=5), 900, quiet + [210.0] * 30 + [260.0, 249.0] + [200.0] * 300)
    r = R.replay_date(T, E, "2024-03-06")
    assert r["triggered"] is False and r["max_ratio_to_background"] == 1.3
    assert r["unconfirmed"] == [{"t": R.iso(T[5 * 96 + 30]), "ratio_to_background": 1.3,
                                 "next": {"t": R.iso(T[5 * 96 + 31]), "ratio_to_background": 1.245,
                                          "after_min": 15.0, "above_threshold": False}}]
    assert R.compare(R.parse_paper_row("2014-01-05"), r)["status"] == "agrees_not_triggered"
    # an unconfirmed sample, then a confirmed pair later in the 48-h search: the onset is the pair's first sample
    T, E = _series(day0 - timedelta(days=5), 900, quiet + [260.0, 200.0] + [200.0] * 20 + [270.0, 280.0, 200.0] + [200.0] * 300)
    r = R.replay_date(T, E, "2024-03-06")
    assert r["triggered"] and r["onset"] == R.iso(T[5 * 96 + 22]) and r["confirmation"]["above_threshold"] is True
    assert [u["t"] for u in r["unconfirmed"]] == [R.iso(T[5 * 96])]
    # two samples above, the second 3 h or more after the first: the scan's pair-gap limit, no onset
    T, E = _series(day0 - timedelta(days=5), 900, quiet + [300.0])
    T.append(T[-1] + R.SCAN_MAX_PAIR_GAP_S)
    E.append(310.0)
    T += [T[-1] + 900 * k for k in range(1, 300)]
    E += [200.0] * 299
    r = R.replay_date(T, E, "2024-03-06")
    assert r["triggered"] is False
    assert [(u["t"], u["next"]["above_threshold"], u["next"]["after_min"]) for u in r["unconfirmed"]] == [
        (R.iso(T[5 * 96]), True, 180.0), (R.iso(T[5 * 96 + 1]), False, 15.0)]
    assert R._unconfirmed_text(r["unconfirmed"][0]).endswith("3.0 h later, came after the 3 h confirmation limit")
    assert R._unconfirmed_text(r["unconfirmed"][1]).endswith("and the next did not confirm it")


def test_scan_needs_two_consecutive_samples_close_in_time():
    base = [200.0] * (6 * 96)
    t0 = datetime(2024, 3, 1, tzinfo=UTC)
    # one sample above 1.25 x: no trigger (the paper's case 2 needs a confirming sample)
    T, E = _series(t0, 900, base + [300.0] + [200.0] * 96)
    assert R.scan_record(T, E) == []
    # two consecutive samples above: one trigger, background frozen at the trigger day's value
    T, E = _series(t0, 900, base + [300.0, 310.0, 290.0, 200.0] + [200.0] * 96)
    ev = R.scan_record(T, E)
    assert len(ev) == 1 and ev[0][0] == 6 * 96 and ev[0][1] == 6 * 96 + 3 and ev[0][2] == 200.0
    # two samples above but more than 3 h apart: no trigger
    T, E = _series(t0, 900, base + [300.0])
    T.append(T[-1] + 4 * 3600)
    E.append(310.0)
    T += [T[-1] + 900 * k for k in range(1, 50)]
    E += [200.0] * 49
    assert R.scan_record(T, E) == []


def test_comparison_statuses():
    p = R.parse_paper_row("2024-05-20 01d 17h:55m 00d 00h:53m 00d 00h:57m 1730.55")
    near = {"triggered": True, "total_uGy": 1745.16, "time_to_peak_min": 53.48, "shelter_min": 2903.4, "lead_time_min": 62.6}
    assert R.compare(p, near)["status"] == "reproduced"
    assert R.compare(p, {**near, "total_uGy": 1000.0})["status"] == "deviates"
    assert R.compare(p, {"triggered": False})["status"] == "not_reproduced"
    q = R.parse_paper_row("2014-01-05")
    assert R.compare(q, {"triggered": False})["status"] == "agrees_not_triggered"
    assert R.compare(q, near)["status"] == "replay_triggered_paper_not"


def test_paper_record_end_from_the_quoted_caption():
    quote = next(q["text"] for q in R.PAPER_QUOTES if q["id"] == "record_end")
    assert R.paper_record_end(quote) == date(2024, 9, 9)


def test_table_block_and_quote_matching_on_a_fixture():
    html = ("<p>MARTIAN SURFACE</p><table><tr><td>2014-01-05</td></tr><tr><td>2014-09-02</td>"
            "<td>01d 14h:17m</td></tr></table><p>Four SEP events on the surface of Mars do not ...</p>")
    text = R.html_to_text(html)
    assert R.table_block(text) == "2014-01-05 2014-09-02 01d 14h:17m"
    authors = R.page_authors('<span class="ltx_personname">Jan Leo L&ouml;we\n</span>x'
                             '<span class="ltx_personname">Sven Löffner\n</span>')
    assert authors == ["Jan Leo Löwe", "Sven Löffner"]
    assert R.short_author("Jan Leo Löwe") == "Löwe JL"
    assert R.short_author("Robert F. Wimmer-Schweingruber") == "Wimmer-Schweingruber RF"


# ================================================================ 2. the shipped snapshot
def test_snapshot_contract_and_size():
    s = _snap()
    validate_snapshot(s)
    assert s["provenance"] == "derived" and s["adapter"] == "rad_events"
    assert SNAP_PATH.stat().st_size < 80_000


def test_first_sample_and_nothing_precedes_it():
    s = _snap()
    rec = s["data"]["record"]
    assert rec["first_sample"] == "2012-08-17T10:20:37Z" == s["coverage"]["start"]
    probe = rec["pre_record_probe"]
    assert probe["all_empty"] is True and probe["hapi_code"] == 1406
    assert probe["start"] <= s["data"]["dataset"]["info_startDate"]
    assert probe["stop"] == rec["pinned_start"] == "2012-08-17T00:00:00Z"
    # the probe windows are contiguous from its start to the pinned start
    probe_windows = R.windows(R.PROBE_START, R.RECORD_START)
    assert probe["windows"] == [R.fmt_hapi_time(a) for a, _ in probe_windows]
    assert set(probe["windows"]) <= set(R.KNOWN_EMPTY)


def test_may_2024_known_answers():
    s = _snap()
    r = _row(s, "2024-05-20")
    rp = r["replay"]
    assert rp["background_uGy_per_day"] == pytest.approx(140.4, abs=1)
    assert rp["onset"] == "2024-05-20T05:21:50Z"
    assert rp["confirmation"]["t"] == "2024-05-20T05:38:56Z" and rp["confirmation"]["above_threshold"]
    assert rp["peak"]["t"] == "2024-05-20T06:15:19Z"
    assert rp["peak"]["uGy_per_day"] == pytest.approx(8378, abs=5)
    assert round(rp["peak"]["ratio_to_background"], 1) == 59.7
    assert rp["time_to_peak_min"] == pytest.approx(53, abs=2)
    assert rp["total_uGy"] == pytest.approx(1730.55, rel=0.02)
    assert R.fmt_dhm(rp["shelter_min"]) == "02d 00h:23m"
    assert R.fmt_dhm(r["paper"]["shelter_min"]) == "01d 17h:55m"
    assert r["paper_row"] == "2024-05-20 01d 17h:55m 00d 00h:53m 00d 00h:57m 1730.55"
    ow = rp["light_time"]["one_way_min"]
    assert round(ow, 2) == 15.84 and round(2 * ow, 1) == 31.7
    assert s["data"]["light_time"]["label"] == "lower bound: light time only, 00:00 UTC that day"


def test_may_2024_native_samples_cover_the_timeline_window():
    m = _snap()["data"]["may_2024"]
    assert m["window"] == {"start": "2024-05-19T00:00:00Z", "stop": "2024-05-22T12:00:00Z"}
    assert len(m["t_s"]) == len(m["uGy_per_day"]) > 200
    assert m["t_s"] == sorted(m["t_s"]) and 0 <= m["t_s"][0] and m["t_s"][-1] < 3.5 * 86400
    assert max(m["uGy_per_day"]) == pytest.approx(8378, abs=5)


@pytest.mark.parametrize("day", ["2017-09-10", "2021-10-28", "2022-02-15", "2024-07-22", "2024-09-02", "2024-09-05"])
def test_rows_that_reproduce(day):
    r = _row(_snap(), day)
    paper, rp = r["paper"], r["replay"]
    assert rp["triggered"]
    assert abs(rp["total_uGy"] - paper["total_uGy"]) <= 0.15 * paper["total_uGy"]
    assert abs(rp["time_to_peak_min"] - paper["time_to_peak_min"]) <= 40
    assert r["comparison"]["status"] == "reproduced"
    assert r["paper_row"] in R.PAPER_TABLE1_SURFACE


@pytest.mark.parametrize("day", ["2022-03-14", "2024-07-26", "2024-08-04"])
def test_paper_not_triggered_rows_never_exceed_the_threshold_within_48_h(day):
    r = _row(_snap(), day)
    assert r["paper"]["triggered"] is False and r["replay"]["triggered"] is False
    assert r["replay"]["max_ratio_to_background"] <= 1.25 and r["replay"]["unconfirmed"] == []
    assert r["comparison"]["status"] == "agrees_not_triggered"


def test_2014_01_05_one_unconfirmed_sample_so_the_replay_agrees_with_the_paper():
    r = _row(_snap(), "2014-01-05")
    assert r["paper"]["triggered"] is False and r["replay"]["triggered"] is False
    assert r["comparison"]["status"] == "agrees_not_triggered"
    (u,) = r["replay"]["unconfirmed"]
    assert u["t"] == "2014-01-06T12:45:21Z" and u["ratio_to_background"] == 1.251
    assert u["next"]["t"] == "2014-01-06T13:18:52Z" and u["next"]["above_threshold"] is False
    assert u["next"]["after_min"] < R.SCAN_MAX_PAIR_GAP_S / 60
    assert r["replay"]["max_at"] == u["t"] and r["replay"]["max_ratio_to_background"] == 1.251
    assert r["scan_trigger"] is None


def test_every_triggered_row_has_its_onset_confirmed_by_the_next_sample():
    for r in _snap()["data"]["table1"]:
        rp = r["replay"]
        if rp["triggered"]:
            assert rp["confirmation"]["above_threshold"] is True, r["paper_date"]
            assert rp["confirmation"]["after_onset_min"] * 60 < R.SCAN_MAX_PAIR_GAP_S, r["paper_date"]
            assert rp["unconfirmed"] == [], r["paper_date"]


def test_row_counts_7_1_4_4_0():
    s = _snap()
    counts = s["data"]["table1_counts"]
    assert counts == {"agrees_not_triggered": 4, "deviates": 1, "not_reproduced": 4,
                      "replay_triggered_paper_not": 0, "reproduced": 7}
    assert set(counts) == set(R.ROW_STATUSES) and sum(counts.values()) == len(R.PAPER_TABLE1_SURFACE) == 16
    for status, n in counts.items():
        assert sum(1 for r in s["data"]["table1"] if r["comparison"]["status"] == status) == n


def test_known_differences_are_in_the_caveats_with_their_ratios():
    s = _snap()
    cav = " ".join(s["caveats"])
    for day, ratio in [("2013-04-10", "1.24"), ("2013-10-10", "1.02"), ("2014-09-10", "1.16"), ("2023-03-12", "1.10")]:
        r = _row(s, day)
        assert r["comparison"]["status"] == "not_reproduced"
        assert f"{r['replay']['max_ratio_to_background']:.2f}" == ratio
        assert f"{day} (max {ratio} x" in cav
    assert "iSWA gap" in cav and "2013-10-11" in cav
    dev = _row(s, "2014-09-02")
    assert dev["comparison"]["status"] == "deviates" and round(dev["comparison"]["total_pct"]) == -33
    assert "2014-09-02 reproduces at -33%" in cav
    assert _row(s, "2014-01-05")["comparison"]["status"] == "agrees_not_triggered"
    assert ("2014-01-05: the paper lists this event as not triggered, and the replay agrees: one sample at "
            "2014-01-06T12:45:21Z reached 1.251 x background and the next did not confirm it.") in s["caveats"]
    assert "triggers at" not in cav and "fires on one sample" not in cav
    late = next(c for c in s["caveats"] if "later UTC day" in c)
    assert late.startswith("For 2024-07-22, 2024-09-02 the replay's onset falls on a later UTC day (25.1 h, 33.5 h")
    assert "2014-01-05" not in late
    assert "02d 00h:23m in this replay against the paper's 01d 17h:55m" in cav
    assert R.ABSORBED_DOSE_CAVEAT in s["caveats"]
    assert "15-minute PDS product" in cav and "RTG" in cav


def test_whole_record_scan_flags():
    sc = _snap()["data"]["scan"]
    assert sc["n_triggers"] == 13 == len(sc["triggers"])
    by_flag: dict[str, list[str]] = {}
    for t in sc["triggers"]:
        by_flag.setdefault(t["flag"], []).append(t["onset"][:10])
    assert by_flag["not_in_paper_table"] == ["2015-06-11", "2016-11-13"]
    assert by_flag["after_paper_table"] == ["2024-11-21", "2025-05-31", "2025-11-11"]
    assert len(by_flag["in_paper_table"]) == 8
    for t in sc["triggers"]:
        if t["flag"] == "not_in_paper_table":
            assert t["total_uGy"] < 2.0 and t["paper_date"] is None
        if t["flag"] == "in_paper_table":
            assert t["paper_date"] in {R.parse_paper_row(r)["date"] for r in R.PAPER_TABLE1_SURFACE}
    assert sc["peak_ratio_range"]["max"] == max(t["peak"]["ratio_to_background"] for t in sc["triggers"])
    assert round(sc["peak_ratio_range"]["min"], 1) == 1.3 and round(sc["peak_ratio_range"]["max"], 1) == 59.7


def test_no_donki_entry_around_may_2024_and_none_claimed_as_the_same_event():
    s = _snap()
    gap = s["data"]["may_2024"]["donki_gap"]
    assert gap == {"start": "2024-05-13T18:07:00Z", "stop": "2024-06-08T02:25:00Z"}
    donki = json.loads((DEFAULT_OUT_DIR / "swpc_sep_events.json").read_text())["data"]["events"]
    assert not [e for e in donki if gap["start"] < e["event_time"] < gap["stop"]]
    may = s["data"]["scan"]["triggers"][_row(s, "2024-05-20")["scan_trigger"]]
    assert may["donki"]["observed"] == [] and may["donki"]["n_model_entries"] == 0
    for t in s["data"]["scan"]["triggers"]:
        if t["onset"] < "2024-01-01":
            assert t["donki"] == {"in_window": False, "note": "outside the shipped DONKI window"}
    blob = json.dumps(s["data"]).lower()
    assert "same event" not in blob.replace("does not claim they are the same event", "")


def test_no_field_contains_sv():
    s = _snap()

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                yield k
                yield from walk(v)
        elif isinstance(o, list):
            for v in o:
                yield from walk(v)
        elif isinstance(o, str):
            yield o

    unit = re.compile(r"Sv\b")          # the sievert unit (Sv, mSv, microSv), not a name such as "Sven"
    hits = [x for x in walk(s["data"]) if unit.search(x)]
    assert hits == []
    assert [c for c in s["caveats"] if unit.search(c)] == [R.ABSORBED_DOSE_CAVEAT]
    assert not unit.search(s["title"]) and not unit.search(json.dumps(s["source"], ensure_ascii=False))


def test_literature_block_records_the_checks():
    lit = _snap()["data"]["literature"]
    assert lit["doi"] == "10.1029/2025SW004372" and lit["arxiv_id"] == "2502.02469v1"
    assert lit["table1_surface_rows"] == R.PAPER_TABLE1_SURFACE and lit["table1_block_verified"] is True
    assert [q["text"] for q in lit["quotes"]] == [q["text"] for q in R.PAPER_QUOTES]
    assert lit["quotes_verified_this_build"] is True
    assert lit["authors"][0] == "Jan Leo Löwe" and len(lit["authors"]) == 11
    assert lit["journal"]["journal"] == "Space Weather" and lit["journal"]["article_number"] == "e2025SW004372"


# ================================================================ 3. against the cache
def test_every_quote_and_table_row_is_in_the_cached_arxiv_html():
    raw = _cached_arxiv()
    if raw is None:
        pytest.skip("arXiv HTML not cached (run `uv run python -m ingest rad_events` online once)")
    for q in R.PAPER_QUOTES:
        assert R.quote_in_page(q["text"], raw), q["id"]
    for row in R.PAPER_TABLE1_SURFACE:
        assert R.quote_in_page(row, raw), row
    assert R.table_block(R.html_to_text(raw)) == R.normalise_text(" ".join(R.PAPER_TABLE1_SURFACE))
    assert R.page_authors(raw) == _snap()["data"]["literature"]["authors"]


def test_an_altered_quote_is_not_found():
    raw = _cached_arxiv()
    if raw is None:
        pytest.skip("arXiv HTML not cached")
    assert not R.quote_in_page("a threshold of 1.20 times the background dose rate", raw)
    assert not R.quote_in_page("2024-05-20 01d 17h:55m 00d 00h:53m 00d 00h:57m 1730.56", raw)


def test_offline_rebuild_reproduces_the_shipped_snapshot(tmp_path):
    if not (SUB_CACHE.exists() and _cached_arxiv() is not None):
        pytest.skip("rad_events cache not present")
    shipped = _snap()
    ctx = RunContext(offline=True, out_dir=DEFAULT_OUT_DIR, retrieved_at=shipped["retrieved_at"])
    rebuilt = R.build(ctx)
    assert rebuilt["data"] == shipped["data"]
    assert rebuilt["coverage"] == shipped["coverage"]
    assert rebuilt["caveats"] == shipped["caveats"]
    assert rebuilt["source"] == shipped["source"]
