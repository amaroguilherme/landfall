"""Tests for the frozen model ranking in web/src/features/nearest/nearest.json (tools/nearest).

These run in the project environment, without model2vec or numpy: they test the frozen JSON and the
deterministic gates, not the model. The re-ranking itself is checked by `rank.py --check` in its own
isolated environment (tools/nearest/README.md).

  1. Always: shape, model identity, queries byte-equal to the frozen queries.json, no score anywhere,
     the clean-text gate, frozen and 'also named by us' flags, NASA text equal to the snapshots for the
     57 frozen requirements, an 'ok' review verdict for every other shown passage, the authored notes
     (notes.json), and the keyword counts the ranking sits beside, byte for byte.
  2. With .cache present (skipped without it, like the other PDF tests): every shown statement and every
     phrase a note quotes occurs in its PDF page text read independently by pdfminer, and a corpus
     rebuild from the cached PDFs is byte-identical to the corpus the ranking used.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools" / "nearest"
NEAREST = ROOT / "web" / "src" / "features" / "nearest" / "nearest.json"
NOTES = ROOT / "web" / "src" / "features" / "nearest" / "notes.json"
COVERAGE = ROOT / "web" / "src" / "features" / "nearest" / "coverage.json"
CORPUS = ROOT / ".cache" / "nearest" / "corpus.json"
SNAPSHOTS = ROOT / "web" / "public" / "data"

MODEL_ID = "minishlab/potion-base-8M"
REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"
MODEL_SHA256 = "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2"
CLAIMS = ["emc", "biocompat", "sensor_set", "battery", "storage", "alert_number"]
ITEM_KEYS = {"rank", "id", "doc", "section", "title", "statement", "pdf_page", "pdf_url", "frozen", "also_named_by_us"}

# As measured on 15 Nov 2026 with the queries frozen in tools/nearest/queries.json.
SHOWN = {
    "emc": ["V2 6102", "V2 9022", "V1 4032", "V2 9128", "V2 9018"],
    "biocompat": ["V2 11125", "V1 3002", "V1 5003", "V2 7045", "V2 11024"],
    "sensor_set": ["V2 7038", "V2 6088", "V1 3003", "V2 7040", "V1 4005"],
    "battery": ["V2 10123", "V2 9043", "V2 9017", "V2 9039", "V2 9018"],
    "storage": ["V2 9120", "V2 7071", "V2 6014", "V2 7060", "V2 6020"],
    "alert_number": ["V2 6088", "V2 6153", "V2 6023", "V1 3006", "V1 4005"],
}
HAND_NAMED_RANKS = {("emc", "V2 6102"): 1, ("biocompat", "V2 7076"): 151, ("biocompat", "V2 7081"): 14,
                    ("alert_number", "V2 6164"): 7, ("alert_number", "V2 6022"): 165,
                    ("alert_number", "V2 11036"): 18}


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rank = _load("nearest_rank", TOOLS / "rank.py")  # stdlib-only at import time


def _json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def nearest():
    return _json(NEAREST)


@pytest.fixture(scope="module")
def items(nearest):
    return [(c["claim_id"], it) for c in nearest["claims"] for it in c["items"]]


@pytest.fixture(scope="module")
def snapshot_reqs():
    out = {}
    for name in ("std_vol1_requirements", "std_vol2_requirements"):
        snap = _json(SNAPSHOTS / f"{name}.json")
        for r in snap["data"]["requirements"]:
            if r.get("found", True):
                out[r["id"].strip("[]")] = (snap["data"]["document"], r)
    return out


# ------------------------------------------------------------------------------ 1. always
def test_six_claims_by_five_passages_in_query_order(nearest):
    assert [c["claim_id"] for c in nearest["claims"]] == CLAIMS
    for c in nearest["claims"]:
        assert set(c) == {"claim_id", "query", "model", "revision", "sha256", "corpus_size", "items", "skipped"}
        assert [it["rank"] for it in c["items"]] == [1, 2, 3, 4, 5], c["claim_id"]
        assert len({it["id"] for it in c["items"]}) == 5, c["claim_id"]
        assert c["corpus_size"] == 543
        for it in c["items"]:
            assert set(it) == ITEM_KEYS, it["id"]
            assert re.fullmatch(r"V[12] \d{4,5}", it["id"])
            assert it["section"] and it["title"] and it["statement"] and isinstance(it["pdf_page"], int)
    assert sum(s["count"] for s in nearest["corpus"]) == 543


def test_ranking_is_the_one_measured(nearest):
    assert {c["claim_id"]: [it["id"] for it in c["items"]] for c in nearest["claims"]} == SHOWN


def test_every_claim_carries_model_revision_and_hash(nearest):
    for c in nearest["claims"]:
        assert c["model"] == MODEL_ID and c["revision"] == REVISION and c["revision"].startswith("bf8b0566")
        assert c["sha256"] == MODEL_SHA256 and c["sha256"].startswith("f65d0f32")
    assert (rank.MODEL_ID, rank.REVISION, rank.MODEL_SHA256) == (MODEL_ID, REVISION, MODEL_SHA256)


def _readme_sha(name: str) -> str:
    text = (TOOLS / "README.md").read_text(encoding="utf-8")
    m = re.search(rf"^\| `{re.escape(name)}` \| `([0-9a-f]{{64}})` \|", text, re.M)
    assert m, f"{name} SHA-256 row missing from tools/nearest/README.md"
    return m.group(1)


def test_queries_are_byte_equal_to_the_frozen_queries_json(nearest):
    raw = (TOOLS / "queries.json").read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    assert sha == _readme_sha("queries.json") == rank.QUERIES_SHA256 == nearest["queries_sha256"]
    frozen = {q["claim_id"]: q["query"] for q in json.loads(raw)["queries"]}
    assert list(frozen) == CLAIMS
    for c in nearest["claims"]:
        assert c["query"] == frozen[c["claim_id"]]
        assert c["query"].encode("utf-8") in raw  # byte-equal, not merely equal after decoding


def test_labels_are_the_frozen_labels_json(nearest):
    sha = hashlib.sha256((TOOLS / "labels.json").read_bytes()).hexdigest()
    assert sha == _readme_sha("labels.json") == rank.LABELS_SHA256 == nearest["labels_sha256"]


def _walk(node, path="$"):
    if isinstance(node, dict):
        for k, v in node.items():
            yield f"{path}.{k}", k, v
            yield from _walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield f"{path}[{i}]", None, v
            yield from _walk(v, f"{path}[{i}]")


def test_no_score_cosine_or_float_anywhere(nearest):
    for path, key, value in _walk(nearest):
        if key is not None:
            assert not re.search(r"score|cosine|similar|distance|prob|confidence", key, re.I), path
        assert not isinstance(value, float), f"{path} is a float"


def test_gate_rules_hold_for_every_shown_statement(items):
    # Independent of rank.gate(): the four clean-text rules, written out again.
    for claim, it in items:
        t = it["statement"]
        assert re.search(r"[.!?][\"'”’)\]]*$", t.strip()), (claim, it["id"])
        assert "NASA-STD-3001, VOLUME" not in t, (claim, it["id"])
        assert not re.search(r"(?:^|[.;:\]]\s+)\d{1,2}(?:\.\d{1,2}){1,4}\s+[A-Z][A-Za-z]", t), (claim, it["id"])
        assert not any(0xE000 <= ord(ch) <= 0xF8FF or ord(ch) == 0xFFFD for ch in t), (claim, it["id"])
        assert rank.gate({**it, "page_check": {"ok": True}}) == [], (claim, it["id"])


def test_gate_rejects_the_known_failures():
    ok = {"page_check": {"ok": True}}
    assert rank.gate({"statement": "The system shall limit noise.", **ok}) == []
    # A citation of another volume in mixed case is not the running header.
    assert rank.gate({"statement": "as defined in NASA-STD-3001, Volume 1.", **ok}) == []
    assert rank.gate({"statement": "The limit (see Table 6.8-2).", **ok}) == []
    assert rank.gate({"statement": "the crew shall be told “now.”", **ok}) == []
    # [V2 6073] today: an equation the extractor cuts off, so no terminal punctuation.
    assert rank.gate({"statement": "calculated using the following equation: 480 𝐿𝐿𝑛𝑛−85 ) 3 ( 𝑇𝑇𝑛𝑛 =", **ok}) == [
        "does not end in terminal punctuation"]
    assert "contains the running header 'NASA-STD-3001, VOLUME'" in rank.gate(
        {"statement": "Charged Particles* NASA-STD-3001, VOLUME 2, REVISION F shall be monitored.", **ok})
    assert rank.gate({"statement": "food for flight at NASA.] 7.1.2.3 Food and Production Area levels.", **ok}) == [
        "contains the numbered heading 7.1.2.3"]
    assert rank.gate({"statement": "The display shall show � values.", **ok}) == ["contains the glyph U+FFFD"]
    assert rank.gate({"statement": "The display shall show  values.", **ok}) == ["contains the glyph U+E000"]
    assert rank.gate({"statement": "Fine text.", "page_check": {"ok": False}}) == ["not found on its PDF page"]


def test_walk_skips_gate_failures_and_non_ok_review_verdicts():
    def req(n, statement="The system shall do it."):
        return {"id": f"V2 {n}", "doc": "d", "section": "1.1", "title": "t", "statement": statement,
                "pdf_page": 1, "pdf_url": "u#page=1", "page_check": {"ok": True}}
    reqs = [req(1001), req(1002, "cut off mid-list"), req(1003), req(1004), req(1005)]
    verdicts = [{"id": "V2 1001", "verdict": "cut", "note": "ends mid-sentence"},
                {"id": "V2 1003", "claim_id": "emc", "verdict": "garbled"},
                {"id": "V2 1004", "verdict": "ok"}]
    items, skipped = rank.walk([0, 1, 2, 3, 4], reqs, "storage", 2, verdicts, {"V2 1004"}, {"V2 1003"})
    assert [(i["rank"], i["id"], i["frozen"], i["also_named_by_us"]) for i in items] == [
        (1, "V2 1003", False, True), (2, "V2 1004", True, False)]
    assert skipped == [{"id": "V2 1001", "position": 1, "reason": "review verdict 'cut': ends mid-sentence"},
                       {"id": "V2 1002", "position": 2, "reason": "does not end in terminal punctuation"}]
    items, _ = rank.walk([0, 1, 2, 3, 4], reqs, "emc", 2, verdicts, set(), set())
    assert [i["id"] for i in items] == ["V2 1004", "V2 1005"]  # the emc-only verdict applies to emc


def test_frozen_flag_marks_exactly_the_57_snapshot_requirements(items, snapshot_reqs):
    assert len(snapshot_reqs) == 57
    for _claim, it in items:
        assert it["frozen"] == (it["id"] in snapshot_reqs), it["id"]


def test_frozen_passages_are_byte_equal_to_their_snapshot(items, snapshot_reqs):
    checked = 0
    for _claim, it in items:
        if not it["frozen"]:
            continue
        doc, r = snapshot_reqs[it["id"]]
        assert it["statement"] == r["text"], it["id"]
        assert it["section"] == r["section"], it["id"]
        assert it["title"] == (r.get("title") or r.get("section_title")), it["id"]
        assert it["pdf_page"] == (r.get("pdf_page") or r.get("pdf_page_number")), it["id"]
        checked += 1
    assert checked == 10


def test_doc_and_pdf_link_follow_the_snapshot_document(items):
    d1 = _json(SNAPSHOTS / "std_vol1_requirements.json")["data"]["document"]
    d2 = _json(SNAPSHOTS / "std_vol2_requirements.json")["data"]["document"]
    for _claim, it in items:
        doc, url = (("NASA-STD-3001 Vol 1 Rev C", d1["url"]) if it["id"].startswith("V1")
                    else ("NASA-STD-3001 Vol 2 Rev F", d2["pdf_url"]))
        assert it["doc"] == doc and it["pdf_url"] == f"{url}#page={it['pdf_page']}", it["id"]


def test_also_named_by_us_follows_the_ids_the_app_already_names(nearest):
    named = rank.named_by_us()
    sensor_map = {n["id"]: n["nearest"] for n in _json(ROOT / "hardware" / "sensor-map.json")["negatives"]}
    for claim in CLAIMS[:5]:
        assert named[claim] == set(sensor_map[claim]), claim
    meta = next(p for p in _json(ROOT / "engine" / "rules" / "meta.json")["principles"]
                if p["id"] == "no_nasa_alert_thresholds")
    assert set(meta["requirement_ids"]) <= named["alert_number"]
    # The std_vol2 volume reading also names the limits Vol 2 sets itself (V2 6004, 11040, 6053, 6253): none is ranked
    # in the top five for alert_number, so no flag changes.
    assert named["alert_number"] == {"V2 6022", "V2 6164", "V2 11036", "V1 4006", "V1 4008", "V2 6153",
                                     "V2 6004", "V2 11040", "V2 6053", "V2 6253"}
    flagged = {(c["claim_id"], it["id"]) for c in nearest["claims"] for it in c["items"] if it["also_named_by_us"]}
    assert flagged == {("emc", "V2 6102"), ("alert_number", "V2 6153")}
    for c in nearest["claims"]:
        for it in c["items"]:
            assert it["also_named_by_us"] == (it["id"] in named[c["claim_id"]])


def test_labelled_check_is_recorded_as_measured(nearest):
    lc = nearest["labelled_check"]
    assert {(h["claim_id"], h["id"]): h["model_rank"] for h in lc["items"]} == HAND_NAMED_RANKS
    assert (lc["in_top_five"], lc["of"]) == (1, 6)
    assert {(h["claim_id"], h["id"]): h["model_rank"] for h in lc["context_not_counted"]} == {
        ("alert_number", "V1 4006"): 38, ("alert_number", "V1 4008"): 92}
    aw = nearest["agent_written_check"]
    assert (aw["questions"], aw["top_five"], aw["top_three"], aw["top_one"]) == (31, 23, 20, 13)
    readme = (TOOLS / "README.md").read_text(encoding="utf-8")
    assert "1 of 6 in the model's top five" in readme
    assert "23 of 31" in readme and "20 of 31" in readme


def test_skipped_entries_name_a_reason(nearest):
    for c in nearest["claims"]:
        shown = {it["id"] for it in c["items"]}
        for s in c["skipped"]:
            assert set(s) == {"id", "position", "reason"} and s["reason"] and s["id"] not in shown


def test_review_verdicts_cover_every_shown_passage_that_is_not_frozen(nearest):
    data = _json(TOOLS / "review.json")  # required: the review stage wrote it on 15 Nov 2026
    verdicts = data["passages"] if isinstance(data, dict) else data
    shown_not_frozen = 0
    for c in nearest["claims"]:
        for it in c["items"]:
            if it["frozen"]:
                continue
            v = [x for x in verdicts if x["id"] == it["id"] and x.get("claim_id") in (None, c["claim_id"])]
            assert v and all(x["verdict"] == "ok" for x in v), (c["claim_id"], it["id"])
            assert all(x["date"] == "2026-11-15" for x in v), (c["claim_id"], it["id"])  # the UI's '15 Nov 2026'
            shown_not_frozen += 1
    assert shown_not_frozen == 20


def test_review_rejected_nothing_so_rank_py_skipped_nothing(nearest):
    """All 48 verdicts are 'ok': rank.py, which drops a non-ok passage and takes the next clean one, dropped none.
    The cut rule (more than 2 of 5 rejected: show the top 3 or drop the claim) therefore never applied."""
    verdicts = _json(TOOLS / "review.json")["passages"]
    assert len(verdicts) == 48 and {v["verdict"] for v in verdicts} == {"ok"}
    assert {v["claim_id"] for v in verdicts} == set(CLAIMS)
    for c in nearest["claims"]:
        assert c["skipped"] == [] and len(c["items"]) == 5, c["claim_id"]
        assert all(rank.review_reason(verdicts, c["claim_id"], it["id"]) is None for it in c["items"])


# ------------------------------------------------------------------------------ the authored notes
# The alert_number note under [V2 6153] was withdrawn while the std_vol2 volume reading said the alert requirements
# "delegate limits to the program"; it is back, worded to agree with the reading as reworded for round 5: they leave
# the alert point to the program, even where Vol 2 sets the limit itself (dust: [V2 6053]).
NOTED = [("sensor_set", "V2 6088"), ("storage", "V2 6020"), ("alert_number", "V2 6153")]


@pytest.fixture(scope="module")
def notes():
    return _json(NOTES)["notes"]


def test_notes_sit_under_a_shown_passage_the_review_flagged(nearest, notes):
    assert [(n["claim_id"], n["about"]) for n in notes] == NOTED
    shown = {c["claim_id"]: {it["id"] for it in c["items"]} for c in nearest["claims"]}
    for n in notes:
        assert set(n) == {"claim_id", "about", "text", "quotes"}
        assert n["about"] in shown[n["claim_id"]], n
        assert n["text"].startswith(f"[{n['about']}] "), n["about"]
        assert n["text"].count(". ") <= 1 and n["text"].endswith("."), n["about"]  # one sentence (storage: two, by decision)
    flagged = {(v["claim_id"], v["id"]) for v in _json(TOOLS / "review.json")["passages"]
               if re.search(r"(?:SME|Reviewer): (contradicts|weakens)", v["note"])}
    assert set(NOTED) <= flagged


def test_every_phrase_a_note_quotes_is_listed_and_nasa_verbatim(nearest, notes):
    by_id = {it["id"]: it for c in nearest["claims"] for it in c["items"]}
    for n in notes:
        quoted = re.findall(r"“([^”]+)”", n["text"])
        assert sorted(quoted) == sorted(q["text"] for q in n["quotes"]), n["about"]
        assert '"' not in n["text"], n["about"]  # straight quotes would escape the check above
        for q in n["quotes"]:
            assert set(q) == {"id", "in", "text"} and q["in"] in {"statement", "rationale"}
            if q["in"] == "statement" and q["id"] in by_id:
                assert q["text"] in by_id[q["id"]]["statement"], q


def test_the_storage_note_has_the_form_the_lead_set():
    n = next(x for x in _json(NOTES)["notes"] if x["claim_id"] == "storage")
    assert re.fullmatch(r"\[V2 6020\] requires “[^”]+” to be recorded automatically for “[^”]+”; it sets no capacity, "
                        r"retention or duration\. The ranking surfaced it, and we narrowed this claim\.", n["text"])


def test_the_dust_note_agrees_with_the_volume_reading_and_its_number_is_on_the_pdf_page():
    """Vol 2 sets the lunar dust limit itself ([V2 6053]); what it leaves open, and the note says so, is the alert point."""
    n = next(x for x in _json(NOTES)["notes"] if x["claim_id"] == "alert_number")
    assert n["about"] == "V2 6153"
    assert n["text"].endswith("never says how close counts as “approaching”: that alert point is left to the program.")
    assert "delegate" not in n["text"] and "no numeric" not in n["text"]
    by_q = {q["text"]: q["id"] for q in n["quotes"]}
    assert by_q["below a time-weighted average of 0.3 mg/m3"] == "V2 6053"


def test_bundle_stays_small():
    assert NEAREST.stat().st_size < 40_000


# ------------------------------------------------------------------------------ what the ranking covers
# Each volume's own count (recounted in the PDFs below) and the requirements LANDFALL's parsers miss.
COVERED = [("NASA-STD-3001 Vol 1 Rev C", 77, ["V1 5002"]), ("NASA-STD-3001 Vol 2 Rev F", 468, ["V2 10157"])]


def test_coverage_says_543_of_545_and_names_the_two_not_ranked(nearest):
    cov = _json(COVERAGE)
    assert [(v["doc"], v["requirements"], v["not_ranked"]) for v in cov["volumes"]] == COVERED
    assert all(set(v) == {"doc", "requirements", "not_ranked", "counted"} for v in cov["volumes"])
    assert [s["doc"] for s in nearest["corpus"]] == [v["doc"] for v in cov["volumes"]]
    for s, v in zip(nearest["corpus"], cov["volumes"]):
        assert s["count"] == v["requirements"] - len(v["not_ranked"]), s["doc"]
    assert sum(v["requirements"] for v in cov["volumes"]) == 545
    missing = {i for v in cov["volumes"] for i in v["not_ranked"]}
    ranked = {it["id"] for c in nearest["claims"] for it in c["items"]}
    ranked |= {h["id"] for h in nearest["labelled_check"]["items"] + nearest["labelled_check"]["context_not_counted"]}
    assert not missing & ranked


# The deterministic keyword counts stay the claim: the ranking never changes them.
STD_VOL2_NEGATIVES = [
    ("No EMI/EMC requirement in Vol 2", r"\bEMI\b|\bEMC\b|electromagnetic (interference|compatibility)", 0),
    ("No wearable / biosensor / body-worn device requirement", "wearable|biosensor|bio-sensor|body[- ]worn", 0),
    ("No skin-contact biocompatibility requirement", "biocompat|cytotox|ISO 10993", 0),
    ("'skin contact' appears only in touch-temperature context", "skin contact", 4),
    ("No battery endurance requirement (all 'battery' mentions)", "batter(y|ies)", 3),
    ("No storage capacity / log duration / retention requirement",
     "data storage|storage capacity|data retention|retention period|log duration|logging duration", 0),
    ("No renal/kidney-stone requirement in Vol 2 (stones appear only as 'urinary calculi' in the [V2 6109] "
     "water-quantity rationale)", "renal|kidney stone|calculi|urolith|nephrolith", 1),
]
SENSOR_MAP_NEGATIVES = [
    ("emc", "No EMI/EMC requirement exists in NASA-STD-3001 Vol 2 Rev F.",
     r"\bEMI\b|\bEMC\b|electromagnetic (interference|compatibility)", 0),
    ("biocompat", "No skin-contact biocompatibility requirement exists in Vol 2 Rev F.", "biocompat|cytotox|ISO 10993", 0),
    ("sensor_set", "No wearable or biosensor requirement in Vol 2 Rev F.", "wearable|biosensor|bio-sensor|body[- ]worn", 0),
    ("battery", "No battery-endurance requirement for wearables in Vol 2 Rev F.", "batter(y|ies)", 3),
    ("storage", "No storage-capacity, retention or log-duration requirement in Vol 2 Rev F.",
     "data storage|storage capacity|data retention|retention period|log duration|logging duration", 0),
]


def test_std_vol2_keyword_counts_are_unchanged():
    negs = _json(SNAPSHOTS / "std_vol2_requirements.json")["data"]["negatives"]
    assert [(n["claim"], n["pattern"], n["hit_count"]) for n in negs] == STD_VOL2_NEGATIVES
    assert {n["scope"] for n in negs} == {"all 398 PDF pages, case-insensitive"}


def test_sensor_map_keyword_counts_are_unchanged():
    negs = _json(ROOT / "hardware" / "sensor-map.json")["negatives"]
    assert [(n["id"], n["claim"], n["pattern"], n["hits"]) for n in negs] == SENSOR_MAP_NEGATIVES


# ------------------------------------------------------------------------------ 2. with .cache
@pytest.fixture(scope="module")
def corpus():
    if not CORPUS.exists():
        pytest.skip("no .cache/nearest/corpus.json (run `uv run python tools/nearest/corpus.py`)")
    raw = CORPUS.read_bytes()
    return raw, {r["id"]: r for r in json.loads(raw)["requirements"]}


def test_ranking_used_this_corpus_and_every_passage_is_in_it(nearest, items, corpus):
    raw, by_id = corpus
    assert hashlib.sha256(raw).hexdigest() == nearest["corpus_sha256"]
    assert len(by_id) == 543
    for _claim, it in items:
        e = by_id[it["id"]]
        for k in ("doc", "section", "title", "statement", "pdf_page", "pdf_url"):
            assert it[k] == e[k], (it["id"], k)
        assert rank.gate(e) == [], it["id"]
    for c in nearest["claims"]:
        for s in c["skipped"]:
            assert s["reason"].startswith("; ".join(rank.gate(by_id[s["id"]]))), s["id"]


def _squeeze(s: str) -> str:
    return re.sub(r"\s+", "", s)


def test_every_shown_statement_occurs_on_its_pdf_page(items, corpus):
    """pdfminer's own text of the cited page (or that page and the next), whitespace removed, with the
    running header and the 'N of M' footer taken out, contains the statement, whitespace removed."""
    pytest.importorskip("pdfminer")
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LAParams, LTTextContainer

    from ingest.common import RunContext

    headers = [_squeeze("NASA-STD-3001, VOLUME 1, REVISION C"), _squeeze("NASA-STD-3001, VOLUME 2, REVISION F")]
    ctx = RunContext(offline=True)
    for snap, key in (("std_vol1_requirements", "url"), ("std_vol2_requirements", "pdf_url")):
        doc = _json(SNAPSHOTS / f"{snap}.json")["data"]["document"]
        mine = [it for _c, it in items if it["pdf_url"].startswith(doc[key] + "#")]
        try:
            pdf = ctx.fetch_bytes(doc[key])
        except RuntimeError:
            pytest.skip(f"{doc[key]} is not in .cache/ingest")
        assert hashlib.sha256(pdf).hexdigest() == doc["sha256"]
        need = sorted({p for it in mine for p in (it["pdf_page"], it["pdf_page"] + 1)})
        texts = {}
        for pno, layout in zip(need, extract_pages(io.BytesIO(pdf), page_numbers=[p - 1 for p in need],
                                                   laparams=LAParams())):
            t = _squeeze("".join(el.get_text() for el in layout if isinstance(el, LTTextContainer)))
            for h in headers:
                t = t.replace(h, "")
            texts[pno] = re.sub(rf"{pno}of\d{{1,3}}$", "", t)
        for it in mine:
            s, p = _squeeze(it["statement"]), it["pdf_page"]
            assert s in texts[p] or s in texts[p] + texts.get(p + 1, ""), it["id"]


def test_every_phrase_a_note_quotes_is_in_its_requirement_and_on_its_pdf_page(corpus):
    """Each quoted phrase occurs in the declared part (statement or rationale) of the requirement it names, as
    the corpus holds it, and in pdfminer's own text of that requirement's page or the next."""
    pytest.importorskip("pdfminer")
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LAParams, LTTextContainer

    from ingest.common import RunContext

    _raw, by_id = corpus
    doc = _json(SNAPSHOTS / "std_vol2_requirements.json")["data"]["document"]
    try:
        pdf = RunContext(offline=True).fetch_bytes(doc["pdf_url"])
    except RuntimeError:
        pytest.skip(f"{doc['pdf_url']} is not in .cache/ingest")
    assert hashlib.sha256(pdf).hexdigest() == doc["sha256"]
    quotes = [q for n in _json(NOTES)["notes"] for q in n["quotes"]]
    assert {q["id"][:2] for q in quotes} == {"V2"}
    need = sorted({p for q in quotes for p in (by_id[q["id"]]["pdf_page"], by_id[q["id"]]["pdf_page"] + 1)})
    texts = {pno: _squeeze("".join(el.get_text() for el in layout if isinstance(el, LTTextContainer)))
             for pno, layout in zip(need, extract_pages(io.BytesIO(pdf), page_numbers=[p - 1 for p in need],
                                                        laparams=LAParams()))}
    for q in quotes:
        e = by_id[q["id"]]
        assert q["text"] in (e[q["in"]] or ""), q
        p = e["pdf_page"]
        assert _squeeze(q["text"]) in texts[p] + texts[p + 1], q


def _pdf_texts(pdf: bytes, pages: list[int]) -> dict[int, str]:
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LAParams, LTTextContainer

    return {pno: "".join(el.get_text() for el in layout if isinstance(el, LTTextContainer))
            for pno, layout in zip(pages, extract_pages(io.BytesIO(pdf), page_numbers=[p - 1 for p in pages],
                                                        laparams=LAParams()))}


def _defined(text: str, prefix: str) -> set[str]:
    """Tags whose own text, up to the next tag, has 'shall'. A deletion note or a change-log entry has none."""
    tags = list(re.finditer(rf"\[{prefix} (\d{{4,5}})\]", text))
    return {f"{prefix} {m.group(1)}" for i, m in enumerate(tags)
            if re.search(r"\bshall\b", text[m.end():tags[i + 1].start() if i + 1 < len(tags) else len(text)])}


def test_each_volume_defines_the_requirements_coverage_counts(corpus):
    """pdfminer's own text, independent of the ingest parsers: Vol 1 Rev C defines 77 requirements and Vol 2 Rev F
    468, and the corpus the ranking used holds every one of them but [V1 5002] and [V2 10157]."""
    pytest.importorskip("pdfminer")
    from ingest.common import RunContext

    _raw, by_id = corpus
    cov = {v["doc"]: v for v in _json(COVERAGE)["volumes"]}
    ctx = RunContext(offline=True)

    def pdf_of(snap: str, key: str) -> bytes:
        doc = _json(SNAPSHOTS / f"{snap}.json")["data"]["document"]
        try:
            pdf = ctx.fetch_bytes(doc[key])
        except RuntimeError:
            pytest.skip(f"{doc[key]} is not in .cache/ingest")
        assert hashlib.sha256(pdf).hexdigest() == doc["sha256"]
        return pdf

    def one_line(texts: dict[int, str], pages) -> str:
        return re.sub(r"\s+", " ", " ".join(texts[p] for p in pages))

    # Vol 1 Rev C: the body (PDF pp. 1-65), then Appendix D, the compliance matrix (pp. 66-86).
    t1 = _pdf_texts(pdf_of("std_vol1_requirements", "url"), list(range(1, 87)))
    body1 = one_line(t1, range(1, 66))
    tags1 = {f"V1 {n}" for n in re.findall(r"\[V1 (\d{4,5})\]", body1)}
    defined1 = _defined(body1, "V1")
    assert (len(tags1), len(defined1)) == (82, 77)
    # Deleted, merged or updated into others: only a note or a change-log entry carries these tags.
    assert tags1 - defined1 == {"V1 3005", "V1 3011", "V1 4021", "V1 6005", "V1 6007"}
    matrix1 = {f"V1 {n}" for n in re.findall(r"V1 (\d{4,5})\]", one_line(t1, range(66, 87)))}
    assert matrix1 <= defined1 and defined1 - matrix1 == {"V1 7003"}  # NASA's matrix lists 76: it omits [V1 7003]
    corpus1 = {i for i in by_id if i.startswith("V1 ")}
    v1 = cov["NASA-STD-3001 Vol 1 Rev C"]
    assert corpus1 <= defined1 and defined1 - corpus1 == set(v1["not_ranked"])
    assert len(defined1) == v1["requirements"]

    # Vol 2 Rev F: Table D.2-1, Requirement Compliance Matrix (PDF pp. 296-338); [V2 10157] itself on p. 216.
    t2 = _pdf_texts(pdf_of("std_vol2_requirements", "pdf_url"), [216, 217, *range(296, 339)])
    matrix2 = {f"V2 {n}" for n in re.findall(r"V2 (\d{4,5})\]", one_line(t2, range(296, 339)))}
    corpus2 = {i for i in by_id if i.startswith("V2 ")}
    v2 = cov["NASA-STD-3001 Vol 2 Rev F"]
    assert len(matrix2) == v2["requirements"] == 468
    assert corpus2 <= matrix2 and matrix2 - corpus2 == set(v2["not_ranked"])
    assert "V2 10157" in _defined(one_line(t2, (216, 217)), "V2")


def test_corpus_rebuild_from_the_cached_pdfs_is_byte_identical(corpus):
    pytest.importorskip("pdfminer")
    raw, _ = corpus
    builder = _load("nearest_corpus", TOOLS / "corpus.py")
    try:
        rebuilt = builder.dumps(builder.build())
    except RuntimeError as exc:
        pytest.skip(f"cached PDFs unavailable: {exc}")
    assert rebuilt == raw  # same IDs, same order, same text: the ranking input is reproducible
