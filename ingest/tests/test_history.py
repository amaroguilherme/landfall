"""Tests for the `history` adapter (STS-34 and the October 1989 replay). No network needed.

The quoted strings are the contract: the shipped snapshot must carry exactly the adapter's quotes,
every one must be in its cached source, and an offline rebuild must reproduce the snapshot, so a
quote altered in the code, in the snapshot or at the source fails here.
"""

import json
import re
from datetime import datetime, timedelta, timezone

import pytest

from ingest import history as H
from ingest.common import DEFAULT_CACHE_DIR, DEFAULT_OUT_DIR, RunContext, validate_snapshot

UTC = timezone.utc
SNAP_PATH = DEFAULT_OUT_DIR / f"{H.SNAPSHOT_ID}.json"


def _snap() -> dict:
    if not SNAP_PATH.exists():
        pytest.skip(f"{SNAP_PATH.name} not built yet (uv run python -m ingest history)")
    return json.loads(SNAP_PATH.read_text())


def _cached(url: str, params: dict | None = None) -> str | None:
    p = RunContext(offline=True, cache_dir=DEFAULT_CACHE_DIR)._cache_path(url, params)
    return p.read_text(encoding="utf-8") if p.exists() else None


# ---------------------------------------------------------------- pure helpers
def test_utc_conversions_known_answers():
    assert H.local_to_utc("October 18, 1989, 12:53:40 p.m. EDT") == datetime(1989, 10, 18, 16, 53, 40, tzinfo=UTC)
    assert H.local_to_utc("October 23, 1989, 9:33:01 a.m. PDT") == datetime(1989, 10, 23, 16, 33, 1, tzinfo=UTC)
    assert H.local_to_utc("October 23, 1989, 12:05:00 a.m. PDT") == datetime(1989, 10, 23, 7, 5, 0, tzinfo=UTC)


@pytest.mark.parametrize("bad", ["October 18, 1989, 12:53:40 p.m. EST",     # a zone the page does not use
                                 "October 18, 1989, 13:53:40 p.m. EDT",     # not a 12-hour clock
                                 "Oct 18, 1989, 12:53:40 p.m. EDT", "1989-10-18T16:53:40Z"])
def test_utc_conversion_rejects_anything_else(bad):
    with pytest.raises(ValueError):
        H.local_to_utc(bad)


def test_duration_parse_matches_the_converted_window():
    d = H.parse_duration("4 days, 23 hours, 39 minutes, 21 seconds")
    assert d == timedelta(days=4, hours=23, minutes=39, seconds=21)
    assert H.local_to_utc("October 23, 1989, 9:33:01 a.m. PDT") - H.local_to_utc(
        "October 18, 1989, 12:53:40 p.m. EDT") == d


def test_check_quotes_fails_when_a_quote_is_altered():
    page = "<html><body><dl><dt>Launched:</dt> <dd>October 18, 1989, 12:53:40 p.m. EDT</dd></dl></body></html>"
    H.check_quotes([{"id": "launch", "text": "Launched: October 18, 1989, 12:53:40 p.m. EDT"}], page, "fixture")
    with pytest.raises(RuntimeError, match="launch"):
        H.check_quotes([{"id": "launch", "text": "Launched: October 18, 1989, 12:53:41 p.m. EDT"}], page, "fixture")


def test_pubmed_parser_on_a_fixture():
    xml = ("<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>11537026</PMID><Article><Journal>"
           "<JournalIssue><Volume>12</Volume><Issue>2-3</Issue><PubDate><Year>1992</Year></PubDate></JournalIssue>"
           "<ISOAbbreviation>Adv Space Res</ISOAbbreviation></Journal><ArticleTitle>T.</ArticleTitle>"
           "<Pagination><MedlinePgn>335-8</MedlinePgn></Pagination><Abstract><AbstractText>A  b.\n c.</AbstractText>"
           "</Abstract><AuthorList><Author><LastName>Golightly</LastName><Initials>MJ</Initials></Author>"
           "<Author><CollectiveName>X</CollectiveName></Author></AuthorList></Article></MedlineCitation>"
           "<PubmedData><ArticleIdList><ArticleId IdType=\"doi\">10.1/x</ArticleId></ArticleIdList></PubmedData>"
           "</PubmedArticle></PubmedArticleSet>")
    pm = H.parse_pubmed(xml)
    assert pm["abstract"] == "A b. c." and pm["authors"] == ["Golightly MJ"] and pm["doi"] == "10.1/x"
    with pytest.raises(RuntimeError):
        H.parse_pubmed(xml.replace("11537026", "1"))


# ---------------------------------------------------------------- the shipped snapshot
def test_snapshot_contract():
    s = _snap()
    validate_snapshot(s)
    assert s["adapter"] == "history" and s["provenance"] == "reference"
    assert SNAP_PATH.stat().st_size < 20_000


def test_utc_window_and_orbit_in_the_snapshot():
    f = _snap()["data"]["flight"]
    assert f["launch_utc"] == "1989-10-18T16:53:40Z"
    assert f["landing_utc"] == "1989-10-23T16:33:01Z"
    assert f["duration_s"] == 4 * 86400 + 23 * 3600 + 39 * 60 + 21
    assert f["orbit_altitude_nmi"] == 185.0 and f["orbit_inclination_deg"] == 34.3
    assert f["orbiter"] == "Atlantis" and f["crew_count"] == 5 == len(f["crew"])
    assert _snap()["coverage"] == {"start": "1989-10-18T16:53:40Z", "stop": "1989-10-23T16:33:01Z", "cadence": None}


def test_snapshot_quotes_are_exactly_the_adapters():
    d = _snap()["data"]
    page_quotes = [q["text"] for q in d["nasa_page"]["quotes"]]
    assert page_quotes == [q["text"] for q in H.NASA_QUOTES] + H.NASA_CREW
    assert [q["text"] for q in d["golightly_1992"]["quotes"]] == [q["text"] for q in H.ABSTRACT_QUOTES]
    assert all(q["verified_this_build"] for q in d["nasa_page"]["quotes"] + d["golightly_1992"]["quotes"])
    assert d["golightly_1992"]["doi"] == "10.1016/0273-1177(92)90125-H" and d["golightly_1992"]["pmid"] == "11537026"


def test_the_30_microgray_figure_is_never_attributed_to_sts34():
    s = _snap()
    blob = json.dumps(s, ensure_ascii=False)
    assert "STS-34 received" not in blob
    assert "not STS-34's dose" in s["data"]["use_note"]
    # the only Sv anywhere is inside the abstract's own verbatim sentence
    sv = [q["text"] for q in s["data"]["golightly_1992"]["quotes"] if "Sv" in q["text"]]
    assert sv == ["The maximum dose to a crew attributed to an SPE was estimated to be 30 microGy (70 microSv)."]
    assert len(re.findall(r"Sv\b", blob)) == 1


# ---------------------------------------------------------------- against the cached sources
def test_every_quote_is_in_the_cached_sources():
    page = _cached(H.NASA_URL)
    xml = _cached(H.EFETCH_URL, H.EFETCH_PARAMS)
    if page is None or xml is None:
        pytest.skip("history sources not cached (run `uv run python -m ingest history` online once)")
    H.check_quotes(H.NASA_QUOTES, page, H.NASA_URL)
    H.check_quotes([{"id": c, "text": c} for c in H.NASA_CREW], page, H.NASA_URL)
    abstract = H.parse_pubmed(xml)["abstract"]
    for q in H.ABSTRACT_QUOTES:
        assert H.normalise_text(q["text"]) in abstract, q["id"]
    for altered in ("Launched: October 18, 1989, 12:53:41 p.m. EDT", "Orbit Inclination: 28.5 degrees"):
        assert not H.quote_in_page(altered, page)
    assert "estimated to be 30 microGy (70 microSv)" in abstract
    assert "estimated to be 300 microGy" not in abstract


def test_offline_rebuild_reproduces_the_shipped_snapshot():
    if _cached(H.NASA_URL) is None or _cached(H.EFETCH_URL, H.EFETCH_PARAMS) is None:
        pytest.skip("history sources not cached")
    shipped = _snap()
    rebuilt = H.build(RunContext(offline=True, retrieved_at=shipped["retrieved_at"]))
    assert rebuilt == shipped
