"""Schema, referential-integrity and source cross-checks for engine/rules/*.json.

The cross-checks read the frozen snapshots in web/public/data/. When a snapshot has not been
built yet the check is skipped with a reason, never silently passed.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from statistics import NormalDist

import pytest

ROOT = Path(__file__).resolve().parents[2]
RULES = ROOT / "engine" / "rules"
DATA = ROOT / "web" / "public" / "data"

SCHEMAS = {
    "environments": "landfall.environments/1",
    "thresholds": "landfall.thresholds/1",
    "personal": "landfall.personal/1",
    "cases": "landfall.cases/1",
    "meta": "landfall.meta/1",
}
CHIP_TO_KIND = {
    "NASA-published": "nasa_standard",
    "NASA brief": "nasa_brief",
    "NOAA-published": "noaa",
    "literature": "literature",
    "derived": "derived",
    "design choice": "design_choice",
}
REQUIRED_SOURCE_FIELDS = {
    "nasa_standard": ("doc", "url", "snapshot"),
    "nasa_brief": ("doc", "url"),
    "noaa": ("doc", "url"),
    "literature": ("citation",),
    "derived": ("from", "arithmetic"),
    "design_choice": ("rationale",),
}
OPS = {"lt", "le", "gt", "ge"}
WINDOW_KINDS = {"instant", "rolling_mean", "cumulative", "career", "ratio_to_baseline"}
REQUIRED_INDICATORS = {
    "pvt_lapses": "count", "pvt_median_rt": "ms", "sleep_duration": "h", "sleep_midpoint_shift": "h",
    "light_exposure_daytime": "lux", "resting_hr": "bpm", "hrv_sdnn": "ms", "skin_temp": "°C",
    "urine_volume_24h": "mL", "fluid_intake_24h": "mL", "mood": "score_1_5",
}


def load(name: str) -> dict:
    return json.loads((RULES / f"{name}.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def R() -> dict:
    return {name: load(name) for name in SCHEMAS}


def snapshot(sid: str) -> dict | None:
    p = DATA / f"{sid}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def need_snapshot(sid: str) -> dict:
    s = snapshot(sid)
    if s is None:
        pytest.skip(f"snapshot {sid!r} not built yet (web/public/data/{sid}.json missing)")
    return s


def walk(obj, path=()):
    """Yield (path, dict) for every dict in a JSON tree."""
    if isinstance(obj, dict):
        yield path, obj
        for k, v in obj.items():
            yield from walk(v, path + (k,))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, path + (i,))


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def all_sources(R):
    """Every source-like object anywhere: (file, path, source dict)."""
    for name, doc in R.items():
        for path, d in walk(doc):
            if path and path[-1] in ("source",) and isinstance(d, dict) and d:
                yield name, path, d
            elif path and len(path) >= 2 and path[-2] == "citations":
                yield name, path, d


def fmt_number(x: float) -> str:
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def number_in(text: str, x: float) -> bool:
    """x appears as a whole number token in text (so 3 does not match 30 or 0.3)."""
    for tok in (fmt_number(x), f"{x:,.0f}" if float(x).is_integer() else None):
        if tok and re.search(rf"(?<![\d.,]){re.escape(tok)}(?![\d]|[.,]\d)", text):
            return True
    return False


def requirement(snap: dict, rid: str) -> dict | None:
    """Find a requirement by id in a std_* snapshot, tolerating 'V2 6004' / '[V2 6004]' and list/dict shapes."""
    reqs = snap.get("data", {}).get("requirements")
    want = {rid, f"[{rid}]"}
    if isinstance(reqs, dict):
        for k, v in reqs.items():
            if k in want:
                return v
        reqs = list(reqs.values())
    for r in reqs or []:
        if isinstance(r, dict) and (r.get("id") in want or r.get("label") in want):
            return r
    return None


def req_text(r: dict) -> str:
    parts = [r.get("text") or r.get("statement") or "", r.get("note") or "", r.get("rationale") or ""]
    parts += [str(v) for v in (r.get("items") or {}).values()] if isinstance(r.get("items"), dict) else []
    return " ".join(p for p in parts if isinstance(p, str))


# ------------------------------------------------------------------ schema


def test_every_file_has_its_schema(R):
    for name, want in SCHEMAS.items():
        assert R[name].get("schema") == want, name


def test_ids_are_unique_across_files(R):
    ids = [r["id"] for r in R["thresholds"]["rules"]]
    ids += [c["id"] for c in R["thresholds"].get("constants", [])]
    ids += [c["id"] for c in R["environments"].get("constants", [])]
    ids += [i["id"] for i in R["personal"]["indicators"]]
    ids += [c["id"] for c in R["cases"]["cases"]]
    ids += [e["id"] for e in R["environments"]["environments"]]
    dupes = {i for i in ids if ids.count(i) > 1}
    assert not dupes, dupes
    for c in R["cases"]["cases"]:
        local = [s["id"] for s in c["procedure"]]
        local += [c["countermeasure"]["primary"]["id"]] + [a["id"] for a in c["countermeasure"]["alternatives"]]
        assert len(local) == len(set(local)), c["id"]


def test_every_number_has_chip_and_source(R):
    """SPEC 3: every object with a number in it carries chip and source (itself or an enclosing object)."""
    vocab = {c["id"] for c in R["meta"]["chips"]}
    for name, doc in R.items():
        for path, d in walk(doc):
            nums = [k for k, v in d.items() if is_num(v)]
            if not nums or "source" in path or "citations" in path:
                continue  # numbers inside a source or citation (page numbers) are citation metadata
            # nearest enclosing dict (self included) with both chip and source
            node, ok = doc, False
            chain = [doc]
            for key in path:
                node = node[key]
                if isinstance(node, dict):
                    chain.append(node)
            for anc in reversed(chain):
                if "chip" in anc and "source" in anc:
                    ok = True
                    break
                prov = anc.get("provenance") if isinstance(anc, dict) else None
                if isinstance(prov, dict) and all(k in prov for k in nums):
                    ok = all("chip" in prov[k] and "source" in prov[k] for k in nums)
                    break
            assert ok, f"{name}:{'/'.join(map(str, path))} has numbers {nums} without chip+source"
        for path, d in walk(doc):
            if "chip" in d and isinstance(d["chip"], str) and path[-1:] != ("chips",):
                assert d["chip"] in vocab, f"{name}:{path} chip {d['chip']!r} not in meta.chips"


def test_chip_matches_source_kind_and_required_fields(R):
    for name, doc in R.items():
        for path, d in walk(doc):
            if isinstance(d.get("chip"), str) and isinstance(d.get("source"), dict):
                kind = d["source"].get("kind")
                assert kind == CHIP_TO_KIND[d["chip"]], f"{name}:{path} chip {d['chip']} vs kind {kind}"
    for name, path, src in all_sources(R):
        kind = src.get("kind")
        assert kind in REQUIRED_SOURCE_FIELDS, f"{name}:{path} bad source kind {kind!r}"
        for f in REQUIRED_SOURCE_FIELDS[kind]:
            assert src.get(f), f"{name}:{path} source.{f} missing"
        if kind == "nasa_standard":
            assert src.get("requirement_id") or src.get("table") or src.get("term") or src.get("context_quote"), \
                f"{name}:{path} nasa_standard source needs requirement_id, table, term or context_quote"


def test_rules_shape(R):
    envs = {e["id"] for e in R["environments"]["environments"]}
    for r in R["thresholds"]["rules"]:
        for k in ("id", "label", "variable", "unit", "op", "limit", "category", "tier", "role", "applies_to",
                  "window", "chip", "source"):
            assert k in r, (r.get("id"), k)
        assert r["op"] in OPS, r["id"]
        assert is_num(r["limit"]), r["id"]
        assert r["role"] in {"alert", "context"}, r["id"]
        assert r["window"]["kind"] in WINDOW_KINDS, r["id"]
        assert r["applies_to"] == ["*"] or set(r["applies_to"]) <= envs, r["id"]
        if "approach_at" in r:
            a = r["approach_at"]["value"]
            if r["op"] in ("lt", "le"):
                assert a < r["limit"], r["id"]
            else:
                assert a > r["limit"], r["id"]
            if r["approach_at"]["chip"] == "design choice":
                assert r["approach_at"]["source"]["kind"] == "design_choice"


def test_nasa_published_tier_a_rules_use_only_ffd_pel_pol(R):
    for r in R["thresholds"]["rules"]:
        if r["tier"] == "A" and r["chip"] == "NASA-published":
            assert r["category"] in {"FFD", "PEL", "POL"}, r["id"]
        if r["category"] in {"FFD", "PEL", "POL"}:
            assert r["chip"] == "NASA-published", f"{r['id']}: NASA category on a non-NASA number"


def test_table_4_8_1_units_are_never_msv(R):
    t481 = [r for r in R["thresholds"]["rules"] if r["source"].get("table") == "Table 4.8-1"]
    assert len(t481) == 16  # 6 organs x 3 windows, minus BFO career and CNS(Z>=10) 30-day
    for r in t481:
        assert r["unit"] in {"mGy-Eq", "mGy"} and "Sv" not in r["unit"], r["id"]
        cns = r["source"]["row"].startswith("Central Nervous System")
        assert r["unit"] == ("mGy" if cns else "mGy-Eq"), r["id"]
    assert not any(r["source"]["row"] == "Blood-forming Organs" and r["window"]["kind"] == "career" for r in t481)


def test_required_spec_content_is_present(R):
    by_id = {r["id"]: r for r in R["thresholds"]["rules"]}
    req = {r["source"].get("requirement_id") for r in by_id.values()}
    for rid in ("V1 4001", "V1 4002", "V1 4027", "V1 4030", "V2 6004", "V2 11040", "V1 4031", "V1 4032",
                "V1 4033"):
        assert rid in req, rid
    for rid in ("V1 4031", "V1 4032", "V1 4033"):
        assert all(r["role"] == "context" for r in by_id.values() if r["source"].get("requirement_id") == rid)
    ops = sorted((r for r in by_id.values() if r["chip"] == "NOAA-published"), key=lambda r: r["s_level"])
    assert [r["limit"] for r in ops] == [10, 100, 1000, 10000, 100000]
    assert all(r["category"] == "OPS" and r["variable"] == "proton_flux_10mev" and r["unit"] == "pfu" for r in ops)


def test_eva_dependence_matches_environments(R):
    eva = {e["id"]: e["eva_type"] for e in R["environments"]["environments"]}
    by_id = {r["id"]: r for r in R["thresholds"]["rules"]}
    assert {eva[e] for e in by_id["ffd_vo2max_microgravity_eva"]["applies_to"]} == {"microgravity"}
    assert {eva[e] for e in by_id["ffd_vo2max_surface_eva"]["applies_to"]} == {"surface"}
    assert set(by_id["ffd_vo2max_microgravity_eva"]["applies_to"]) == {e for e, t in eva.items() if t == "microgravity"}
    assert set(by_id["ffd_vo2max_surface_eva"]["applies_to"]) == {e for e, t in eva.items() if t == "surface"}


def test_noaa_rules_follow_environment_availability(R):
    avail = {e["id"]: e["noaa_scale_available"] for e in R["environments"]["environments"]}
    for r in R["thresholds"]["rules"]:
        if r["chip"] == "NOAA-published":
            assert set(r["applies_to"]) == {e for e, a in avail.items() if a}, r["id"]
    assert avail["mars_surface"] is False


# ------------------------------------------------------------------ environments


def test_environments_shape_and_moon_arithmetic(R):
    envs = {e["id"]: e for e in R["environments"]["environments"]}
    assert set(envs) == {"iss", "cislunar", "lunar_surface", "mars_surface"}
    consts = {c["id"]: c["value"] for c in R["environments"]["constants"]}
    lt = envs["lunar_surface"]["comms"]["one_way_light_time_s"]
    c = consts["c_speed_of_light"]
    assert math.isclose(lt["min"], consts["moon_perigee_km"] / c, abs_tol=5e-4)
    assert math.isclose(lt["mean"], consts["moon_semimajor_axis_km"] / c, abs_tol=5e-4)
    assert math.isclose(lt["max"], consts["moon_apogee_km"] / c, abs_tol=5e-4)
    mars = envs["mars_surface"]["comms"]
    assert mars["one_way_light_time_s"] == {"from_snapshot": "horizons_mars_comms"} and mars["conjunction"] is True


# ------------------------------------------------------------------ personal


def test_personal_indicators(R):
    p = R["personal"]
    alpha = p["rci"]["alpha_two_tailed"]
    assert math.isclose(p["rci"]["critical_z"], NormalDist().inv_cdf(1 - alpha / 2), abs_tol=1e-3)
    inds = {i["id"]: i for i in p["indicators"]}
    assert set(REQUIRED_INDICATORS) <= set(inds)
    for iid, unit in REQUIRED_INDICATORS.items():
        i = inds[iid]
        assert i["unit"] == unit and i["variable"] == iid, iid
        assert i["worse"] in {"increase", "decrease"}, iid
        r = i["reliability_r"]
        assert 0 < r["value"] < 1 and r["chip"] in CHIP_TO_KIND and r["source"]["kind"] == CHIP_TO_KIND[r["chip"]]
    assert inds["mood"]["private"] is True and inds["mood"]["alerting"] is False


# ------------------------------------------------------------------ cases


def test_cases_referential_integrity(R):
    rules = {r["id"]: r for r in R["thresholds"]["rules"]}
    inds = {i["id"]: i for i in R["personal"]["indicators"]}
    hazards = {h["id"] for h in R["meta"]["hazards"]}
    regions = set(R["meta"]["body_regions"])
    variables = {r["variable"] for r in rules.values()} | {i["variable"] for i in inds.values()}
    cases = {c["id"]: c for c in R["cases"]["cases"]}
    assert set(cases) == {"renal_stone", "sleep_circadian", "spe_shelter"}
    for c in cases.values():
        for k in ("title", "one_line", "hrp_risk", "interpretation", "countermeasure", "procedure", "tripwire",
                  "escalation", "not_measurable_here", "refusals"):
            assert c.get(k), (c["id"], k)
        assert set(c["hazards"]) <= hazards and set(c["body_regions"]) <= regions, c["id"]
        assert isinstance(c["countermeasure"]["primary"], dict)  # exactly one primary
        for t in c["triggers"]:
            if t["kind"] == "rule":
                assert t["rule_id"] in rules, t
            elif t["kind"] == "ops":
                assert rules[t["rule_id"]]["category"] == "OPS", t
            elif t["kind"] == "personal":
                assert t["indicator_id"] in inds, t
            else:
                raise AssertionError(t)
        cond = c["tripwire"]["condition"]
        assert cond.get("rule_id") in rules or cond.get("indicator_id") in inds, c["id"]
        assert cond["op"] in OPS and cond["at_least"] <= cond["of_last_n"]
        step_vars = {s["input"]["variable"] for s in c["procedure"] if "input" in s}
        for s in c["procedure"]:
            if "input" in s:
                assert s["input"]["source"] in {"manual", "band", "vehicle", "app"}, s
        unknown = set(c["escalation"]["observations"]) - variables - step_vars
        assert not unknown, (c["id"], unknown)
    for i in inds.values():
        assert i["case_id"] in (None, *cases), i["id"]
    for r in rules.values():
        assert r.get("case_id") in (None, *cases), r["id"]


def test_derived_inputs_resolve(R):
    known = {r["id"] for r in R["thresholds"]["rules"]} | {c["id"] for c in R["thresholds"]["constants"]}
    known |= {c["id"] for c in R["environments"]["constants"]} | {i["id"] for i in R["personal"]["indicators"]}
    known |= {f"rci.{k}" for k in R["personal"]["rci"]}
    for name, path, src in all_sources(R):
        if src.get("kind") == "derived":
            missing = set(src["from"]) - known
            assert not missing, (name, path, missing)


def test_hrp_risk_titles_match_snapshot(R):
    snap = need_snapshot("hrp_risks")
    blob = json.dumps(snap, ensure_ascii=False).lower()
    for c in R["cases"]["cases"]:
        assert c["hrp_risk"]["title"].lower() in blob, c["hrp_risk"]["title"]
        assert c["hrp_risk"]["url"].rstrip("/").lower() in blob, c["hrp_risk"]["url"]


# ------------------------------------------------------------------ meta


def test_meta_vocabularies(R):
    m = R["meta"]
    assert {c["id"] for c in m["chips"]} == set(CHIP_TO_KIND)
    assert {c["id"] for c in m["categories"]} >= {"FFD", "PEL", "POL", "OPS", "PERSONAL"}
    assert m["refusals"] and all(r["id"] and r["text"] for r in m["refusals"])
    rows = m["severity_mapping"]["rows"]
    sev = {s["id"] for s in m["severities"]}
    for row in rows:
        assert row.get("severity", row.get("severity_max")) in sev - {"emergency"}, row["id"]
    used = {r["category"] for r in R["thresholds"]["rules"]}
    assert used <= {c["id"] for c in m["categories"]}


# ------------------------------------------------------------------ cross-checks against snapshots


def _nasa_sources_for(R, snap_id):
    for name, path, src in all_sources(R):
        if src.get("kind") == "nasa_standard" and src.get("snapshot") == snap_id:
            yield name, path, src


@pytest.mark.parametrize("snap_id", ["std_vol1_requirements", "std_vol2_requirements"])
def test_nasa_limits_appear_verbatim_in_snapshot(R, snap_id):
    """Every Tier A limit must appear verbatim in its requirement's text in the frozen snapshot."""
    snap = need_snapshot(snap_id)
    checked = 0
    for r in R["thresholds"]["rules"]:
        src = r["source"]
        if src.get("kind") != "nasa_standard" or src.get("snapshot") != snap_id:
            continue
        if src.get("requirement_id"):
            req = requirement(snap, src["requirement_id"])
            assert req is not None, f"{r['id']}: {src['requirement_id']} not in {snap_id}"
            text = req_text(req)
            assert src["verbatim"] in text, f"{r['id']}: verbatim {src['verbatim']!r} not in requirement text"
            assert number_in(src["verbatim"], r["limit"]), f"{r['id']}: limit {r['limit']} not in verbatim"
            assert number_in(text, r["limit"]), r["id"]
        else:
            assert src.get("table") == "Table 4.8-1", r["id"]
            table = next(t for t in snap["data"]["tables"] if t["id"] == "Table 4.8-1")
            row = next(x for x in table["rows"] if x["organ"] == src["row"])
            cell = row[src["column"]]
            assert cell["value"] == r["limit"] and cell["unit"] == r["unit"], (r["id"], cell)
            assert cell["text"] == src["verbatim"] and number_in(cell["text"], r["limit"]), (r["id"], cell)
        checked += 1
    assert checked, f"no rule cites {snap_id}"


@pytest.mark.parametrize("snap_id", ["std_vol1_requirements", "std_vol2_requirements"])
def test_other_nasa_citations_appear_verbatim(R, snap_id):
    """Countermeasure / constant / glossary citations: the quoted fragment must be in the snapshot."""
    snap = need_snapshot(snap_id)
    data = snap["data"]
    missing = []
    for name, path, src in _nasa_sources_for(R, snap_id):
        if src.get("requirement_id"):
            req = requirement(snap, src["requirement_id"])
            if req is None:
                # The adapter ships only a curated subset. Not a Tier A rule limit (those hard-fail in
                # test_nasa_limits_appear_verbatim_in_snapshot), so report the gap instead of failing.
                missing.append(f"{src['requirement_id']} ({name}:{'/'.join(map(str, path))})")
                continue
            if src.get("table"):
                blob = json.dumps(data, ensure_ascii=False)
                assert src["verbatim"] in blob or src["verbatim"] in req_text(req), (name, path)
            else:
                assert src["verbatim"] in req_text(req), (name, path, src["verbatim"])
        elif src.get("context_quote"):
            quotes = " ".join(q["text"] for q in data.get("context_quotes", []))
            assert src["verbatim"] in quotes, (name, path)
        elif src.get("term"):
            g = next((x for x in data.get("glossary", []) if x["term"] == src["term"]), None)
            assert g is not None, src["term"]
    m = R["meta"]
    if snap_id == "std_vol1_requirements":
        for cat in m["categories"]:
            if cat["source"]:
                g = next(x for x in data["glossary"] if x["term"] == cat["source"]["term"])
                assert g["definition"] == cat["glossary"], cat["id"]
    if missing:
        pytest.skip(f"all other citations verified; not in {snap_id} yet: " + "; ".join(missing))


def test_noaa_rules_match_s_scale_snapshot(R):
    snap = need_snapshot("swpc_s_scale")
    levels = {lv["n"]: lv for lv in snap["data"]["levels"]}
    assert snap["data"]["unit"] == "pfu" and snap["data"]["energy"] == ">=10 MeV"
    for r in R["thresholds"]["rules"]:
        if r["chip"] != "NOAA-published":
            continue
        lv = levels[r["s_level"]]
        assert r["limit"] == lv["threshold_pfu"], r["id"]
        assert r["biological_text"] == lv["effects"]["Biological"] == r["source"]["verbatim"], r["id"]
        assert r["descriptor"] == lv["descriptor"], r["id"]


# ------------------------------------------------------------------ audit cross-checks

SNAPSHOT_OP = {"<": "lt", "<=": "le", ">": "gt", ">=": "ge"}


def snapshot_strings(obj):
    """Every string anywhere in a snapshot (so a quote is matched against real text, not JSON escapes)."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from snapshot_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from snapshot_strings(v)


def rules_texts(R):
    """(file, string) for every string value in the rules files, plus the README."""
    for name, doc in R.items():
        for s in snapshot_strings(doc):
            yield name, s
    yield "README", (RULES / "README.md").read_text(encoding="utf-8")


def test_vol1_rules_match_snapshot_op_unit_category_page(R):
    """Op direction, unit, value, FFD/PEL/POL category and page: each must equal the Vol 1 snapshot."""
    snap = need_snapshot("std_vol1_requirements")
    table = next(t for t in snap["data"]["tables"] if t["id"] == "Table 4.8-1")
    for r in R["thresholds"]["rules"]:
        src = r["source"]
        if src.get("kind") != "nasa_standard" or src.get("snapshot") != "std_vol1_requirements":
            continue
        if src.get("requirement_id"):
            req = requirement(snap, src["requirement_id"])
            vals = [v for v in req.get("values") or [] if v.get("verbatim") == src["verbatim"]]
            assert len(vals) == 1, f"{r['id']}: no snapshot value whose verbatim is {src['verbatim']!r}"
            v = vals[0]
            assert SNAPSHOT_OP[v["op"]] == r["op"], (r["id"], v["op"], r["op"])
            assert v["value"] == r["limit"] and v["unit"] == r["unit"], (r["id"], v)
            assert req["category_from_section_title"] == r["category"], (r["id"], req["category_basis"])
            assert src["page"] == req["pdf_page_number"], (r["id"], src["page"], req["pdf_page_number"])
            assert src["section"] == req["section"], r["id"]
        else:
            assert r["category"] == "PEL" and src["page"] == table["pdf_page_number"], r["id"]


def test_vol2_rules_match_snapshot_op_and_page(R):
    snap = need_snapshot("std_vol2_requirements")
    phrase_op = {"no more than": "le", "not exceed": "le", "less than": "lt", "at or above": "ge"}
    for r in R["thresholds"]["rules"]:
        src = r["source"]
        if src.get("kind") != "nasa_standard" or src.get("snapshot") != "std_vol2_requirements":
            continue
        req = requirement(snap, src["requirement_id"])
        ops = {op for phrase, op in phrase_op.items() if phrase in src["verbatim"]}
        assert ops == {r["op"]}, (r["id"], src["verbatim"], r["op"])
        assert src["page"] == req["pdf_page"] and src["section"] == req["section"], r["id"]


NEVER_PRINT = [
    # PLANO.md Appendix A, "Nao imprimir" and "Ressalvas verificadas"
    (r"\b1\.(06|15|56|35)\s*%", "LeBlanc 2000 site-table rates are unverifiable; use Lang 2004"),
    (r"11\.3-1", "Table 11.3-1 graded rows are unreadable in the source"),
    (r"\b4\.2\.9(\.\d)?\b", "MTB-013 labels 4.2.9.x are not NASA-STD-3001 requirement IDs"),
    (r"(?i)\b[TZ]-?score\b[^.]{0,40}?[−-]\s?\d", "no T-score cutoff ([V1 4026] has none)"),
    (r"(?i)winscat", "'the method NASA uses in WinSCAT' is unverified"),
]


def test_plano_never_print_list(R):
    for name, text in rules_texts(R):
        for pat, why in NEVER_PRINT:
            m = re.search(pat, text)
            assert not m, f"{name}: {m.group(0)!r} ({why})"
        for m in re.finditer("LeBlanc", text):
            assert text[max(0, m.start() - 8):m.start()] == "Lang T, ", f"{name}: LeBlanc outside the Lang 2004 author list"
        for m in re.finditer(r"NASA(?:'s)?\s+(?:in-flight\s+)?alert\s+threshold", text):
            assert re.search(r"(not a|no)\s+$", text[max(0, m.start() - 8):m.start()]), \
                f"{name}: framed as a NASA alert threshold: {text[max(0, m.start() - 40):m.end()]!r}"
    for name, path, d in ((n, p, d) for n, doc in R.items() for p, d in walk(doc)):
        own = [v for v in d.values() if isinstance(v, str)]
        if any("355" in s for s in own):  # 355 ms belongs to Basner 2011, never to a [V1 ...] ID
            assert d.get("kind") != "nasa_standard" and (d.get("source") or {}).get("kind") != "nasa_standard", path
            assert not any(re.search(r"\bV1 \d{4}", s) for s in own), (name, path)
    for c in R["cases"]["cases"]:  # see personal.json rci.caveat: the realized rate is not p < .001
        for s in snapshot_strings(c):
            assert not re.search(r"p\s*<\s*0?\.001", s), (c["id"], s)


def test_hrp_and_noaa_quotes_appear_in_snapshots(R):
    checked = 0
    for name, path, src in all_sources(R):
        sid = src.get("snapshot")
        if sid not in ("hrp_risks", "hrp_hazards", "swpc_s_scale") or not src.get("verbatim"):
            continue
        snap = need_snapshot(sid)
        assert any(src["verbatim"] in s for s in snapshot_strings(snap)), (name, path, src["verbatim"])
        checked += 1
    assert checked


def test_renal_target_is_the_evidence_report_sentence(R):
    """1,500 and 2,500 mL come from one HRP evidence-report sentence (identical in the 2017 and 2024
    editions); the Vol 2 adapter froze the 2017 text, so the rule's quote must be inside it."""
    snap = need_snapshot("std_vol2_requirements")
    rule = next(r for r in R["thresholds"]["rules"] if r["id"] == "target_urine_output_24h")
    src = rule["source"]
    assert rule["category"] == "TARGET" and rule["chip"] == "literature" and "requirement_id" not in src
    quotes = [q["quote"] for q in snap["data"].get("lookups", []) if "quote" in q]
    assert any(src["verbatim"] in q for q in quotes), "renal quote not in the frozen evidence-report text"
    assert rule["op"] == "ge" and rule["limit"] == 1500 and "drops below 1.5 liters/day" in src["verbatim"]
    assert rule["approach_at"]["value"] == 2500 and "2.5-3 liters/day" in src["verbatim"]
    assert rule.get("max_severity") == "caution"


# Requirement IDs verified by hand in the source PDF but not (yet) in a snapshot. Each entry is the
# evidence; the test still skips so the snapshot gap stays visible.
VERIFIED_OUTSIDE_SNAPSHOT = {
    "V2 6165": "NASA-STD-3001 Vol 2 Rev F PDF (sha256 2bf853a8...7155, same file as std_vol2_requirements), "
               "p. 112, sec. 6.8.1.7: 'The program shall monitor the in-situ extravehicular space weather "
               "environment including the external exposure rates, electron flux spectra, and proton flux spectra.'",
}


def test_every_requirement_id_mentioned_exists(R):
    """No fabricated IDs: every 'V1 nnnn' / 'V2 nnnn' anywhere in the rules is in a std snapshot."""
    v1, v2 = need_snapshot("std_vol1_requirements"), need_snapshot("std_vol2_requirements")
    mentioned = {f"{m.group(1)} {m.group(2)}" for _, s in rules_texts(R)
                 for m in re.finditer(r"\b(V[12]) (\d{4,5})\b", s)}
    absent = sorted(i for i in mentioned if requirement(v1 if i.startswith("V1") else v2, i) is None)
    unknown = [i for i in absent if i not in VERIFIED_OUTSIDE_SNAPSHOT]
    assert not unknown, f"requirement IDs in no snapshot and not hand-verified: {unknown}"
    if absent:
        pytest.skip("hand-verified, not yet in a snapshot: " + "; ".join(f"{i} ({VERIFIED_OUTSIDE_SNAPSHOT[i]})"
                                                                         for i in absent))
