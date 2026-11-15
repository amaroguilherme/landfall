"""Tests for the `sep_conjunction` adapter: sol 242 (April 2013), rebuilt from MSL RAD and STEREO-B HET.

Three layers, all without network:
  1. Known-answer tests of the pure helpers on synthetic input.
  2. The shipped snapshot (web/public/data/sep_conjunction_2013.json) against the lane brief's verified
     values and the snapshots it reads (swpc_spe_list, horizons_mars_comms, hapi_msl_rad_sep_events).
  3. When the gitignored caches are present (.cache/ingest/sep_conjunction/ and rad_events/), an offline
     rebuild must reproduce the shipped snapshot, and every fragment must be in the cached PDF.
"""

import json
from datetime import datetime, timezone

import pytest

from ingest import rad_events
from ingest import sep_conjunction as S
from ingest.common import DEFAULT_CACHE_DIR, DEFAULT_OUT_DIR, RunContext, sha256_hex, validate_snapshot

UTC = timezone.utc
SNAP_PATH = DEFAULT_OUT_DIR / f"{S.SNAPSHOT_ID}.json"
SUB_CACHE = DEFAULT_CACHE_DIR / S.CACHE_SUBDIR
RAD_CACHE = DEFAULT_CACHE_DIR / rad_events.CACHE_SUBDIR


def _snap() -> dict:
    if not SNAP_PATH.exists():
        pytest.skip(f"{SNAP_PATH.name} not built yet (uv run python -m ingest sep_conjunction)")
    return json.loads(SNAP_PATH.read_text())


def _shipped(sid: str) -> dict:
    p = DEFAULT_OUT_DIR / f"{sid}.json"
    if not p.exists():
        pytest.skip(f"{p.name} not in this build")
    return json.loads(p.read_text())


def _channel(snap: dict, mev: float) -> dict:
    return next(c for c in snap["data"]["stereo_b"]["channels"] if c["centre_MeV"] == mev)


def _cached_pdf() -> bytes | None:
    p = RunContext(offline=True, cache_dir=SUB_CACHE)._cache_path(S.PDF_URL, None)
    return p.read_bytes() if p.exists() else None


def _caches_present() -> bool:
    sub = RunContext(offline=True, cache_dir=SUB_CACHE)
    return (RAD_CACHE.exists() and _cached_pdf() is not None
            and sub._cache_path(f"{S.CDAWEB_HAPI}/data", S.het_query()).exists())


def close(a: float, b: float, rel: float) -> bool:
    return abs(a - b) <= rel * abs(b)


# ================================================================ 1. pure helpers
def test_pdf_text_normalisation_joins_letter_hyphens_only():
    assert S.normalise_pdf_text("GOES-13 was near-  ly 180°\n away") == "GOES-13 was nearly 180° away"
    # A digit before the hyphen is not a line-break hyphen: "40- to 100-MeV" stays as printed.
    assert S.normalise_pdf_text("The 40- to 100-MeV\nproton flux") == "The 40- to 100-MeV proton flux"
    assert S.fragments_missing("x (A) Dose rate", [{"id": "a", "text": "(A) Dose  rate"}]) == []
    assert S.fragments_missing("x (A) Dose rate", [{"id": "b", "text": "(B) Dose rate"}]) == ["b"]


def test_het_csv_parsing_drops_the_declared_fill():
    text = ("2013-04-11T09:00:35.000Z,1.0e+00,-1.0E31,2.0e-01\n"
            "2013-04-11T09:01:35.000Z,3.0e+00,5.0e-01,-1e+31\n")
    T, rows = S.parse_het_csv(text, 3, "-1.0E31")
    assert T == [int(datetime(2013, 4, 11, 9, 0, 35, tzinfo=UTC).timestamp()), T[0] + 60]
    assert rows == [[1.0, None, 0.2], [3.0, 0.5, None]]
    with pytest.raises(ValueError):
        S.parse_het_csv("2013-04-11T09:00:35.000Z,1.0\n", 3, None)


def test_hourly_means_skip_fill_and_leave_empty_hours_null():
    t0 = 1_000_000 * 3600
    T = [t0 + 10, t0 + 70, t0 + 3600 * 2 + 5]
    means, counts = S.hourly_means(T, [1.0, 3.0, None], t0, 3)
    assert means == [2.0, None, None]
    assert counts == [2, 0, 0]


def test_window_counts_are_whole_utc_days():
    d = int(datetime(2013, 4, 4, tzinfo=UTC).timestamp())
    T = [d - 1, d, d + 86_400 * 2 - 1, d + 86_400 * 2]
    assert S.count_in_window(T, "2013-04-04", "2013-04-05") == 2


def test_rad_moments_on_a_synthetic_event():
    bg = 200.0
    E = [200, 205, 230, 250, 240, 199, 210]
    T = [k * 3600 for k in range(len(E))]
    m = S.rad_moments(T, [float(e) for e in E], bg, 0, len(E) * 3600)
    assert m["peak"]["t"] == S.iso(3 * 3600) and m["peak"]["ratio_to_background"] == 1.25
    assert m["first_rise"]["t"] == S.iso(2 * 3600)      # 230 > 1.10 x 200
    assert m["last_before_rise"]["t"] == S.iso(3600)
    assert m["back_below_background"]["t"] == S.iso(5 * 3600)
    assert m["highest_after_back"]["uGy_per_day"] == 210.0


def test_significant_figures():
    assert S.sig(0.578234) == 0.5782
    assert S.sig(0.000366512) == 0.0003665
    assert S.sig(0.0) == 0.0 and S.sig(None) is None


# ================================================================ 2. the shipped snapshot
def test_snapshot_contract_and_size():
    snap = _snap()
    validate_snapshot(snap)
    assert snap["id"] == S.SNAPSHOT_ID and snap["adapter"] == S.ADAPTER_ID
    assert snap["provenance"] == "derived" and snap["freshness"] == {"kind": "historical", "stale_after": None}
    assert SNAP_PATH.stat().st_size < 40_000


def test_rad_background_peak_rise_and_return():
    r = _snap()["data"]["rad"]
    assert abs(r["background"]["uGy_per_day"] - 210.0) <= 0.05
    assert r["background"]["n_samples"] == 112
    assert r["background"]["start"] == "2013-04-05T00:00:00Z" and r["background"]["stop"] == "2013-04-10T00:00:00Z"
    assert r["threshold_factor"] == 1.25 and r["threshold_uGy_per_day"] == 262.5
    assert r["peak"]["t"] == "2013-04-11T14:19:27Z"
    assert abs(r["peak"]["uGy_per_day"] - 260.99) <= 0.01
    assert abs(r["peak"]["ratio_to_background"] - 1.243) <= 0.001
    assert r["first_rise"]["t"] == "2013-04-11T10:14:17Z" and r["first_rise"]["ratio_to_background"] == 1.204
    assert abs(r["first_rise"]["uGy_per_day"] - 252.75) <= 0.01
    assert r["last_before_rise"]["t"] == "2013-04-11T08:11:42Z" and r["last_before_rise"]["ratio_to_background"] == 1.043
    assert r["back_below_background"]["t"] == "2013-04-12T08:46:30Z"
    assert r["back_below_background"]["ratio_to_background"] == 0.994 < 1.0
    assert r["highest_after_back"]["t"] == "2013-04-12T21:05:47Z"
    assert r["samples_above_threshold"] == 0
    assert r["median_spacing_min"] == 61.6
    assert r["n_samples"] == len(r["t_s"]) == len(r["uGy_per_day"]) == 63
    assert r["t0"] == "2013-04-10T00:00:00Z" and 0 <= min(r["t_s"]) and max(r["t_s"]) < 3 * 86_400
    assert r["background"]["max_excursion_pct"] == 3.7


def test_rad_agrees_with_the_shipped_table1_replay():
    snap = _snap()
    ev = _shipped("hapi_msl_rad_sep_events")
    row = next(r for r in ev["data"]["table1"] if r["paper_date"] == "2013-04-10")
    rp = snap["data"]["table1"]["replay"]
    assert rp == row["replay"]
    assert snap["data"]["rad"]["background"]["uGy_per_day"] == row["replay"]["background_uGy_per_day"]
    assert snap["data"]["rad"]["peak"]["t"] == row["replay"]["max_at"]
    t1 = snap["data"]["table1"]
    assert t1["paper_row"] == "2013-04-10 00d 05h:33m 00d 01h:28m 00d 01h:28m 9.22"
    assert t1["paper"] == {"triggered": True, "shelter_min": 333, "time_to_peak_min": 88, "lead_time_min": 88, "total_uGy": 9.22}
    assert t1["status"] == "not_reproduced"


def test_stereo_b_bins_and_rows():
    sb = _snap()["data"]["stereo_b"]
    for mev in (14.3, 50.0, 80.0):
        assert any(abs(c - mev) < 1e-6 for c in sb["bin_centres_MeV"])
    assert len(sb["bin_centres_MeV"]) == 11
    assert sb["units"] == "#/(cm2-sr-s-MeV/n)"
    assert sb["dataset"] == "STB_L1_HET" and sb["parameter"] == "Proton_Flux"
    assert sb["dataset_coverage"] == {"start": "2006-12-01T00:00:08Z", "stop": "2014-09-27T16:28:26Z"}
    assert sb["n_rows"] == 10_035 and sb["n_fill_values"] == 0
    assert sb["n_hours"] == 168 and all(len(c["mean"]) == 168 for c in sb["channels"])


def test_stereo_b_hourly_means_quiet_medians_and_multiples():
    snap = _snap()
    h80, h50, h14 = _channel(snap, 80.0), _channel(snap, 50.0), _channel(snap, 14.3)
    k = lambda h: (3 * 24) + h  # noqa: E731 - hour index on 11 April (the series starts 8 April 00Z)
    assert close(h80["mean"][k(6)], 3.55e-4, 0.02) and close(h80["mean"][k(7)], 4.27e-3, 0.02)
    assert close(h80["mean"][k(8)], 0.37, 0.02)
    assert h80["peak"]["t"] == "2013-04-11T09:00:00Z" and close(h80["peak"]["mean"], 0.578, 0.02)
    assert h50["peak"]["t"] == "2013-04-11T10:00:00Z" and close(h50["peak"]["mean"], 1.27, 0.02)
    assert close(h80["quiet_median"], 3.67e-4, 0.02) and close(h50["quiet_median"], 1.14e-4, 0.02)
    assert h80["quiet_n_hours"] == h50["quiet_n_hours"] == 48
    assert h80["peak"]["multiple_of_quiet"] == 1577 and h50["peak"]["multiple_of_quiet"] == 11148
    assert h80["first_hour_above_10x_quiet"] == "2013-04-11T07:00:00Z"
    assert h50["first_hour_above_10x_quiet"] == "2013-04-11T08:00:00Z"
    # The 14.3 MeV channel reads 0 when quiet: no multiple is stated for it.
    assert h14["quiet_median"] == 0.0 and h14["peak"]["multiple_of_quiet"] is None
    assert h14["first_hour_above_10x_quiet"] is None


def test_noaa_entries_are_the_shipped_list_rows():
    snap = _snap()
    lst = _shipped("swpc_spe_list")
    n = snap["data"]["noaa"]
    assert n["event"]["start"] == "2013-04-11T10:55:00Z" and n["event"]["peak_pfu"] == 114.0 and n["event"]["s_level"] == 2
    assert n["scenario_event"]["start"] == "1989-10-19T13:05:00Z" and n["scenario_event"]["peak_pfu"] == 40000.0
    assert n["scenario_event"]["s_level"] == 4
    for e in (n["event"], n["scenario_event"]):
        assert e in lst["data"]["events"]


def test_jpl_windows_and_quotes_from_the_shipped_horizons_snapshot():
    snap = _snap()
    pub = {w["id"]: w for w in _shipped("horizons_mars_comms")["data"]["calibration"]["published"]}
    w = {x["id"]: x for x in snap["data"]["jpl"]["windows"]}
    assert (w["2013_curiosity"]["start_date"], w["2013_curiosity"]["end_date"]) == ("2013-04-04", "2013-05-01")
    assert (w["2013_orbiters"]["start_date"], w["2013_orbiters"]["end_date"]) == ("2013-04-09", "2013-04-26")
    assert w["2013_curiosity"]["quote"] == "Curiosity's controllers plan to suspend commanding from April 4 to May 1."
    for k in ("2013_curiosity", "2013_orbiters"):
        assert w[k]["quote"] == pub[k]["quote"] and w[k]["quote_verified_this_build"] is False
    assert snap["data"]["axis"] == {"start": "2013-04-10T00:00:00Z", "stop": "2013-04-13T00:00:00Z",
                                    "inside_curiosity_window": True}
    assert any("read by hand" in c for c in snap["caveats"])


def test_moratorium_counts():
    m = {w["id"]: w for w in _snap()["data"]["moratoria"]["windows"]}
    assert {k: v["n_samples"] for k, v in m.items()} == {
        "2013_curiosity": 615, "2013_orbiters": 387, "2015_fleet": 1245, "2017_fleet": 907, "2019_fleet": 909,
        "2021_fleet": 1230, "2023_fleet": 1243, "2026_no_contact": 1569}
    cur = [v["n_samples"] for v in m.values() if v["applies_to_curiosity"]]
    assert (min(cur), max(cur)) == (615, 1569) and not m["2013_orbiters"]["applies_to_curiosity"]


def test_literature_block():
    lit = _snap()["data"]["literature"]
    assert lit["pdf_sha256"] == "1cd81ff354e883bff449fcffad39448baf8bed0a34799572a1639ec15631145d"
    assert lit["pdf_bytes"] == 1_444_324 and lit["doi"] == "10.1126/science.1244797"
    assert lit["fragments_verified_this_build"] is True
    ids = {f["id"] for f in lit["fragments"]}
    assert {"fig5_caption", "stereo_b_leading", "goes_180", "enhancement_30", "min_energy", "fig1_date"} <= ids
    assert lit["dates"] == {"table1": "2013-04-10", "fig5": "11 to 12 April 2013", "fig1": "12 to 13 April 2013"}
    cap = next(f["text"] for f in lit["fragments"] if f["id"] == "fig5_caption")
    assert cap.startswith("(A) Dose rate enhancement observed on the martian surface by RAD on sol 242 (11 to 12 April 2013)")
    assert lit["pdf_saved_by_hand_on"] is None  # fetched by the adapter itself on 2026-11-15


def test_caveats_carry_the_dates_and_the_limits():
    cav = " ".join(_snap()["caveats"])
    for s in ("'2013-04-10'", "'sol 242 (11 to 12 April 2013)'", "'sol 242 (12 to 13 April 2013)'", "1.243 x",
              "~30%", "9.22 uGy", "No absorbed dose is converted to Sv", "paper's claim", "11,148 x", "1,577 x"):
        assert s in cav, s


def test_no_field_claims_a_near_miss_or_sv():
    raw = SNAP_PATH.read_text() if SNAP_PATH.exists() else pytest.skip("not built")
    low = raw.lower()
    for banned in ("near miss", "near-miss", "big storm", "no one could warn", "msv", "µsv", "usv"):
        assert banned not in low, banned


# ================================================================ 3. the caches
def test_every_fragment_is_in_the_cached_pdf():
    raw = _cached_pdf()
    if raw is None:
        pytest.skip("PDF not cached (run `uv run python -m ingest sep_conjunction` online once)")
    assert sha256_hex(raw) == S.PDF_SHA256
    text = S.pdf_text(raw)
    assert S.fragments_missing(text) == []
    assert S.fragments_missing(text, [{"id": "altered", "text": "an enhancement of ~40% over the GCR dose rate"}]) == ["altered"]


def test_a_copy_saved_by_hand_is_checked_and_labelled(tmp_path):
    raw = _cached_pdf()
    if raw is None:
        pytest.skip("PDF not cached (run `uv run python -m ingest sep_conjunction` online once)")
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(raw[:-1])
    with pytest.raises(SystemExit):
        S.seed_pdf(bad, cache_dir=tmp_path / "cache")
    good = tmp_path / "good.pdf"
    good.write_bytes(raw)
    S.seed_pdf(good, cache_dir=tmp_path / "cache", saved_on="2026-11-15")
    sub = RunContext(offline=True, cache_dir=tmp_path / "cache" / S.CACHE_SUBDIR)
    got, by_hand = S.fetch_pdf(sub)
    assert got == raw and by_hand == {"url": S.PDF_URL, "sha256": S.PDF_SHA256, "bytes": S.PDF_BYTES, "saved_on": "2026-11-15"}
    # Without the marker the same offline context serves the fetched copy, with no by-hand label.
    S._by_hand_marker(sub).unlink()
    assert S.fetch_pdf(sub) == (raw, None)


def test_offline_rebuild_reproduces_the_shipped_snapshot():
    if not _caches_present():
        pytest.skip("sep_conjunction or rad_events cache not present (run the adapters online once)")
    shipped = _snap()
    ctx = RunContext(offline=True, out_dir=DEFAULT_OUT_DIR, retrieved_at=shipped["retrieved_at"])
    rebuilt = S.build(ctx)
    assert rebuilt["data"] == shipped["data"]
    assert rebuilt["coverage"] == shipped["coverage"]
    assert rebuilt["caveats"] == shipped["caveats"]
    assert rebuilt["source"] == shipped["source"]
