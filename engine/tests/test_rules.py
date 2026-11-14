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
    "NASA report": "nasa_brief",   # OCHMO technical briefs and HRP evidence reports; the kind keeps its old name
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
    # D8: manual readings with the vehicle medical kit (cuff, fingerstick glucometer)
    "bp_systolic": "mmHg", "bp_diastolic": "mmHg", "glucose": "mg/dL",
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
    """The requirement's own words: text, note, rationale and items (never LANDFALL's landfall_note)."""
    parts = [r.get("text") or r.get("statement") or "", r.get("note") or "", r.get("rationale") or ""]
    parts += [str(v) for v in (r.get("items") or {}).values()] if isinstance(r.get("items"), dict) else []
    return " ".join(p for p in parts if isinstance(p, str))


def table_cells(snap: dict, table: str) -> list[str]:
    """Every printed cell of a table ("Table 6.3-1") in a std_* snapshot: caption, header, rows, notes.

    Vol 1 keeps tables as a list with "id"; Vol 2 as a dict whose caption starts with the table name.
    LANDFALL's own fields (landfall_note, verified, checks) are not cells.
    """
    tables = snap["data"].get("tables") or []
    items = tables.values() if isinstance(tables, dict) else tables
    for t in items:
        if t.get("id") == table or str(t.get("caption", "")).startswith(table + "\u2014") or t.get("caption") == table:
            cells = [t.get("caption") or "", t.get("footnote") or ""]
            cells += [str(c) for c in t.get("columns") or []]
            cells += [str(n) for n in t.get("notes_verbatim") or []]
            for row in t.get("rows") or []:
                values = row.values() if isinstance(row, dict) else row
                for v in values:
                    cells += [str(v.get("text")) if isinstance(v, dict) else str(v)]
            return cells
    raise AssertionError(f"{table} not in snapshot {snap.get('id')}")


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
    rci = p["rci"]
    # the engine computes the critical value from alpha and the baseline length; none is stored
    assert "critical_z" not in rci and 0 < rci["alpha_two_tailed"] < 1
    assert rci["source"]["citation"].startswith("Crawford JR, Howell DC.") and "10.1076/clin.12.4.482.7241" in \
        rci["source"]["citation"]
    assert rci["lineage"]["source"]["citation"].startswith("Jacobson NS, Truax P.")
    inds = {i["id"]: i for i in p["indicators"]}
    assert set(REQUIRED_INDICATORS) <= set(inds)
    for iid, unit in REQUIRED_INDICATORS.items():
        i = inds[iid]
        assert i["unit"] == unit and i["variable"] == iid, iid
        assert i["worse"] in ({"increase", "decrease", "either"} if iid == "glucose" else {"increase", "decrease"}), iid
        # reliability_r is not used by the computation: if present it holds no value and says so
        r = i.get("reliability_r")
        if r is not None:
            assert r["value"] is None and r["used_by_engine"] is False, iid
            assert r["source"]["rationale"].startswith("Not used by any computation."), iid
    assert inds["mood"]["private"] is True and inds["mood"]["alerting"] is False


def test_personal_method_text_quotes_the_engine_critical_values(R):
    """rci.method prints the critical values for the full window and the minimum baseline: they must be the
    engine's (t_critical(alpha, n - 1)), so the text cannot drift from the arithmetic."""
    from engine import fmt_num, t_critical

    rci = R["personal"]["rci"]
    alpha = rci["alpha_two_tailed"]
    full = fmt_num(t_critical(alpha, rci["baseline_window_days"] - 1), 3)
    minimum = fmt_num(t_critical(alpha, rci["min_baseline_n"] - 1), 3)
    assert f"{full} for a full {rci['baseline_window_days']}-day baseline" in rci["method"], full
    assert f"{minimum} at the {rci['min_baseline_n']}-day minimum" in rci["method"], minimum
    assert fmt_num(alpha, 6) in rci["method"]
    meta_b = next(t for t in R["meta"]["tiers"] if t["id"] == "B")["definition"]
    assert f"({full} for a {rci['baseline_window_days']}-day baseline)" in meta_b


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
        envs = {e["id"] for e in R["environments"]["environments"]}
        for env, override in (cond.get("by_env") or {}).items():
            assert env in envs, (c["id"], env)
            assert override.get("rule_id") in rules or override.get("indicator_id") in inds, (c["id"], env)
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
    """Matched against the snapshot's own risk entries (name and url), not the snapshot as a whole."""
    snap = need_snapshot("hrp_risks")
    risks = {r["name"]: r["url"].rstrip("/") for r in snap["data"]["risks"]}
    for c in R["cases"]["cases"]:
        assert c["hrp_risk"]["title"] in risks, c["hrp_risk"]["title"]
        assert risks[c["hrp_risk"]["title"]] == c["hrp_risk"]["url"].rstrip("/"), c["hrp_risk"]["url"]


# ------------------------------------------------------------------ meta


def test_meta_vocabularies(R):
    m = R["meta"]
    assert {c["id"] for c in m["chips"]} == set(CHIP_TO_KIND)
    assert {c["id"]: c["source_kind"] for c in m["chips"]} == CHIP_TO_KIND
    assert {c["id"] for c in m["categories"]} >= {"FFD", "PEL", "POL", "OPS", "PERSONAL", "TARGET"}
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
            # the requirement's own words, or the cells of the table it cites; never the snapshot as a whole,
            # which also holds LANDFALL's commentary (landfall_note, lookups)
            own = [req_text(req)] + (table_cells(snap, src["table"]) if src.get("table") else [])
            assert any(src["verbatim"] in text for text in own), (name, path, src["verbatim"])
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
    assert not missing, f"requirement IDs cited but not in {snap_id}: " + "; ".join(missing)


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
    for c in R["cases"]["cases"]:  # case texts are for a non-physician: no p-values (rci.caveat has the fine print)
        for s in snapshot_strings(c):
            assert not re.search(r"p\s*<\s*0?\.001", s), (c["id"], s)
            assert not re.search(r"\bRCI\b|3\.29", s), (c["id"], s)  # the old Jacobson & Truax criterion


def test_hrp_and_noaa_quotes_appear_in_snapshots(R):
    checked = 0
    for name, path, src in all_sources(R):
        sid = src.get("snapshot")
        if sid not in ("hrp_risks", "hrp_hazards", "hrp_roadmap", "swpc_s_scale") or not src.get("verbatim"):
            continue
        snap = need_snapshot(sid)
        assert any(src["verbatim"] in s for s in snapshot_strings(snap)), (name, path, src["verbatim"])
        checked += 1
    assert checked


def test_renal_target_is_the_evidence_report_sentence(R):
    """1,500 and 2,500 mL come from one HRP evidence-report sentence (identical in the 2017 and 2024
    editions); the Vol 2 adapter froze the 2017 text, so the rule's quote must be inside it. An HRP
    evidence report is a NASA report without a requirement ID: chip "NASA report"."""
    snap = need_snapshot("std_vol2_requirements")
    rule = next(r for r in R["thresholds"]["rules"] if r["id"] == "target_urine_output_24h")
    src = rule["source"]
    assert rule["category"] == "TARGET" and rule["chip"] == "NASA report" and "requirement_id" not in src
    assert src["kind"] == "nasa_brief" and "Evidence Report: Risk of Renal Stone Formation" in src["doc"]
    assert rule["approach_at"]["chip"] == "NASA report" and rule["approach_at"]["source"]["kind"] == "nasa_brief"
    renal = next(c for c in R["cases"]["cases"] if c["id"] == "renal_stone")
    for cm in [renal["countermeasure"]["primary"]] + renal["countermeasure"]["alternatives"]:
        if "Evidence Report" in json.dumps(cm["source"]):
            assert cm["chip"] == "NASA report", cm["id"]   # the same document family, the same chip
    quotes = [q["quote"] for q in snap["data"].get("lookups", []) if "quote" in q]
    assert any(src["verbatim"] in q for q in quotes), "renal quote not in the frozen evidence-report text"
    assert rule["op"] == "ge" and rule["limit"] == 1500 and "drops below 1.5 liters/day" in src["verbatim"]
    assert rule["approach_at"]["value"] == 2500 and "2.5-3 liters/day" in src["verbatim"]
    assert rule.get("max_severity") == "caution"


def test_every_requirement_id_mentioned_exists(R):
    """No fabricated IDs: every 'V1 nnnn' / 'V2 nnnn' anywhere in the rules is in a std snapshot.

    [V2 6165] used to be hand-verified outside the snapshot; both it and [V2 6109] are in
    std_vol2_requirements now, so nothing is exempt and nothing is skipped."""
    v1, v2 = need_snapshot("std_vol1_requirements"), need_snapshot("std_vol2_requirements")
    mentioned = {f"{m.group(1)} {m.group(2)}" for _, s in rules_texts(R)
                 for m in re.finditer(r"\b(V[12]) (\d{4,5})\b", s)}
    absent = sorted(i for i in mentioned if requirement(v1 if i.startswith("V1") else v2, i) is None)
    assert not absent, f"requirement IDs in no snapshot: {absent}"
    assert {"V2 6109", "V2 6165"} <= mentioned


def test_v2_6109_and_v2_6165_against_their_own_text(R):
    v2 = need_snapshot("std_vol2_requirements")
    # [V2 6109]: the constant's quote is the hydration row of Table 6.3-1, and the requirement cites that table
    req = requirement(v2, "V2 6109")
    const = next(c for c in R["thresholds"]["constants"] if c["id"] == "v2_6109_potable_water_hydration")
    assert "Table 6.3-1" in req["text"] and const["source"]["table"] == "Table 6.3-1"
    hydration = [c for c in table_cells(v2, "Table 6.3-1") if c.startswith("Minimum 2.5 L (84.5 fl oz)")]
    assert len(hydration) == 1 and const["source"]["verbatim"] in hydration[0]
    assert number_in(hydration[0], const["value"]) and const["unit"] == "L per crewmember per day"
    assert "urinary calculi" in req["rationale"]          # why the renal case cites it as context
    # [V2 6165]: the hand-off "proton energy spectrum outside the vehicle" is what the requirement monitors
    req = requirement(v2, "V2 6165")
    assert req["text"] == ("The program shall monitor the in-situ extravehicular space weather environment including "
                           "the external exposure rates, electron flux spectra, and proton flux spectra.")
    spe = next(c for c in R["cases"]["cases"] if c["id"] == "spe_shelter")
    hand_off = next(h for h in spe["not_measurable_here"] if h.get("requirement_id") == "V2 6165")
    assert "Proton energy spectrum" in hand_off["what"] and "proton flux spectra" in req["text"]
    onboard = next(r for r in R["thresholds"]["rules"] if r["id"] == "ops_onboard_proton_s3")
    assert "[V2 6165]" in onboard["source"]["rationale"]


def test_hand_off_requirement_ids_are_quoted_from_the_requirement(R):
    """not_measurable_here: every requirement ID carries a quote found verbatim in that requirement's own
    words, so an ID is never cited for something it does not say ([V1 3004] names no kidney imaging)."""
    v1, v2 = need_snapshot("std_vol1_requirements"), need_snapshot("std_vol2_requirements")
    for c in R["cases"]["cases"]:
        for h in c["not_measurable_here"]:
            rid = h.get("requirement_id")
            if rid is None:
                continue
            req = requirement(v1 if rid.startswith("V1") else v2, rid)
            assert req is not None, (c["id"], rid)
            assert h.get("requirement_quote") and h["requirement_quote"] in req_text(req), (c["id"], rid)
    renal = next(c for c in R["cases"]["cases"] if c["id"] == "renal_stone")
    imaging = next(h for h in renal["not_measurable_here"] if h.get("requirement_id") == "V1 3004")
    assert "(e.g., cardiac, vascular, ocular)" in imaging["requirement_quote"]
    assert "medical kit ultrasound" not in imaging["via"] and "names neither the kidney nor ultrasound" in imaging["note"]


# ------------------------------------------------------------------ lead decisions D1-D14 in the data


def _case(R, cid):
    return next(c for c in R["cases"]["cases"] if c["id"] == cid)


def _crew_texts(c):
    """The crew-facing strings of a case: one-liner, interpretation, procedure, tripwire, countermeasures."""
    out = [c["one_line"], c["interpretation"]["text"], c["tripwire"]["text"]]
    out += [st["text"] for st in c["procedure"]]
    cm = c["countermeasure"]
    out += [x.get("title", "") for x in [cm["primary"]] + cm["alternatives"]]
    out += [x.get("rationale", "") for x in [cm["primary"]] + cm["alternatives"]]
    return out


def test_severity_mapping_follows_table_10_3_1(R):
    """D1: the class of each row is quoted verbatim from the frozen Table 10.3-1; the only Warning is S3+."""
    snap = need_snapshot("std_vol2_requirements")
    table = snap["data"]["tables"]["table_10_3_1"]
    definitions = {row[0]: row[1] for row in table["rows"]}
    sm = R["meta"]["severity_mapping"]
    assert sm["table_10_3_1"]["table"] == "table_10_3_1" and sm["table_10_3_1"]["caption"] == table["caption"]
    rows = {r["id"]: r for r in sm["rows"]}
    assert "ops_s3_plus_eva" not in rows
    for row in sm["rows"]:
        if "class_definition" in row:
            sev = row.get("severity", row.get("severity_max"))
            assert row["class_definition"] == definitions[sev.capitalize()], row["id"]
    assert rows["ops_s3_plus"]["severity"] == "warning"
    assert rows["tier_a_outside"]["severity"] == rows["tier_a_approaching"]["severity"] == "caution"
    assert rows["ops_s1_s2"]["severity"] == "advisory"
    warn = [r["id"] for r in sm["rows"] if r.get("severity") == "warning"]
    assert warn == ["ops_s3_plus"]
    # every OPS rule at S3 or above carries the shelter action that makes it a Warning
    for r in R["thresholds"]["rules"]:
        if r["category"] == "OPS" and r.get("s_level", 0) >= 3:
            assert r["action_id"] == "spe_shelter" and r["case_id"] == "spe_shelter", r["id"]


def test_vo2max_is_an_eva_assignment_caution(R):
    """D1/D6/D11: the FFD floor is capped at caution, labelled 'EVA assignment not cleared', with a one-line action."""
    by = {r["id"]: r for r in R["thresholds"]["rules"]}
    for rid in ("ffd_vo2max_microgravity_eva", "ffd_vo2max_surface_eva"):
        r = by[rid]
        assert r["max_severity"] == "caution" and r["case_id"] is None, rid
        assert r["action"]["label"] == "EVA assignment not cleared", rid
        assert r["action"]["text"].startswith("EVA assignment not cleared") and "Crew Medical Officer" in r["action"]["text"]
        assert "heart or the lungs" in r["action"]["source"]["rationale"], rid


def test_findings_without_a_deep_case_carry_an_action(R):
    """D11: an alerting rule or indicator that no case lists as a trigger carries a one-line action; a trigger
    does not (its case is the action). OPS levels below S3 never exceed advisory and S4/S5 co-fire with the S3
    trigger, so OPS rules are covered by the shelter case."""
    triggers = {t.get("rule_id") or t.get("indicator_id") for c in R["cases"]["cases"] for t in c["triggers"]}
    for r in R["thresholds"]["rules"]:
        if r["role"] != "alert" or r["category"] == "OPS":
            continue
        if r["id"] in triggers:
            assert "action" not in r, r["id"]
        else:
            a = r.get("action")
            assert a and a["label"] and a["text"] and a["chip"] == "design choice", r["id"]
    for i in R["personal"]["indicators"]:
        if not i["alerting"] or i["id"] in triggers:
            assert "action" not in i, i["id"]
        else:
            assert i["case_id"] is None and i["action"]["text"] and i["action"]["chip"] == "design choice", i["id"]
            assert "Crew Medical Officer" in i["action"]["text"], i["id"]


def test_manual_bp_and_glucose_indicators(R):
    """D8: cuff and fingerstick readings, Tier B alerting at caution at most, no NASA limit (said so), and the
    Inspiration4 lab range as context only, matching the frozen OSDR snapshot."""
    inds = {i["id"]: i for i in R["personal"]["indicators"]}
    for iid in ("bp_systolic", "bp_diastolic", "glucose"):
        i = inds[iid]
        assert i["device"] == "manual" and i["alerting"] is True and i["private"] is False and i["case_id"] is None
        assert i["limit_note"]["text"].startswith("No NASA numeric limit") and i["limit_note"]["chip"] == "design choice"
        assert not any(r["variable"] == i["variable"] for r in R["thresholds"]["rules"]), iid  # no Tier A rule
    assert inds["glucose"]["worse"] == "either"
    ctx = inds["glucose"]["context"]
    snap = need_snapshot("osdr_cmp")
    glu = next(a for a in snap["data"]["analytes"] if a["key"] == "glucose")
    ranges = [rng for subj in glu["ranges"].values() for rng in subj.values()]
    assert {(x["min"], x["max"]) for x in ranges} == {(ctx["range"]["min"], ctx["range"]["max"])} == {(65, 99)}
    assert ctx["range"]["unit"] == glu["unit"] == inds["glucose"]["unit"]
    assert "65-99 mg/dL" in ctx["text"] and "never alerts" in ctx["text"]
    assert ctx["source"]["snapshot"] == "osdr_cmp" and ctx["source"]["citation"] == snap["source"]["citation"]


def test_sleep_midpoint_shift_is_an_absolute_shift(R):
    """D9: the absolute shift from the fixed baseline's median midpoint; worse = increase."""
    i = next(x for x in R["personal"]["indicators"] if x["id"] == "sleep_midpoint_shift")
    assert i["worse"] == "increase" and i["unit"] == "h"
    assert i["definition"]["text"].startswith("absolute shift, in hours")
    assert "fixed baseline window" in i["definition"]["text"] and "never negative" in i["definition"]["text"]


def test_detectable_change_text_quotes_the_engine(R):
    """D10: the band half-width in baseline SDs, quoted from min_detectable_change itself."""
    from engine import fmt_num, min_detectable_change

    rci = R["personal"]["rci"]
    dc = rci["detectable_change"]
    alpha = rci["alpha_two_tailed"]
    full = min_detectable_change(1.0, rci["baseline_window_days"], alpha)["mdc"]
    minimum = min_detectable_change(1.0, rci["min_baseline_n"], alpha)["mdc"]
    assert f"{fmt_num(full, 2)} baseline SDs" in dc["text"] and f"minimum, {fmt_num(minimum, 2)}" in dc["text"]
    assert dc["source"]["arithmetic"].endswith(f"= {fmt_num(minimum, 2)}") and f"= {fmt_num(full, 2)};" in dc["source"]["arithmetic"]


def test_red_flags_and_required_steps(R):
    """D5: renal r4 is a required yes/no red-flag question listing the HRR risk-statement symptoms; the SPE shelter
    confirmations are required; the SPE packet step releases the ground packet."""
    renal = _case(R, "renal_stone")
    r4 = next(st for st in renal["procedure"] if st["id"] == "r4")
    assert r4["required"] is True and r4["red_flag"] is True and r4["input"]["unit"] == "yes/no"
    assert r4["red_flags"] == ["pain in the side or back (flank)", "blood in the urine",
                               "pain or burning when passing urine", "fever or chills", "nausea or vomiting",
                               "being unable to pass urine"]
    for symptom in ("flank", "blood in the urine", "passing urine", "fever or chills", "nausea or vomiting",
                    "unable to pass urine", "Crew Medical Officer"):
        assert symptom in r4["text"], symptom
    src = r4["basis"]["source"]
    assert src["snapshot"] == "hrp_roadmap" and "renal colic (pain), nausea, vomiting, hematuria, infection" in src["verbatim"]
    roadmap = need_snapshot("hrp_roadmap")
    hrr81 = next(r for r in roadmap["data"]["risks"] if r["hrr_id"] == 81)
    assert hrr81["detail"]["risk_statement"] == src["verbatim"]
    assert [st["id"] for st in renal["procedure"] if st.get("required")] == ["r4"]
    spe = _case(R, "spe_shelter")
    assert [st["id"] for st in spe["procedure"] if st.get("required")] == ["p2", "p3"]
    assert [st["id"] for st in spe["procedure"] if st.get("releases_packet")] == ["p6"]
    sleep = _case(R, "sleep_circadian")
    assert not any(st.get("required") or st.get("red_flag") for st in sleep["procedure"])


def test_escalation_reaches_the_crew_medical_officer_first(R):
    """D4: every tripwire escalates to the onboard CMO now and queues the packet for the flight surgeon."""
    tiers = R["meta"]["escalation"]["tiers"]
    assert [(t["tier"], t["id"]) for t in tiers] == [(1, "crew_medical_officer"), (2, "flight_surgeon")]
    assert set(R["meta"]["escalation"]["autonomy"]) == {"AOS", "LOS"}
    for c in R["cases"]["cases"]:
        text = c["tripwire"]["text"]
        assert "escalate: " in text and "Crew Medical Officer" in text and "flight surgeon" in text, c["id"]
        assert "reclassify" not in text and "flight-surgeon review" not in text, c["id"]


def test_packet_state_wording_is_one_vocabulary(R):
    """Packet states: 'Prepared (held on board)', then 'Queued' after crew release or escalation."""
    labels = [p["label"] for p in R["meta"]["packet_states"]]
    assert labels == ["Prepared (held on board)", "Queued"]
    p6 = next(st for st in _case(R, "spe_shelter")["procedure"] if st["id"] == "p6")
    assert "Prepared (held on board)" in p6["text"] and "Queued" in p6["text"]
    for c in R["cases"]["cases"]:
        for text in _crew_texts(c):
            assert "is queued now" not in text and "not queued" not in text, (c["id"], text)


def test_case_texts_are_role_environment_and_plain_language_aware(R):
    """D7 and the judges' findings: no rule IDs and no anthropomorphic phrasing in crew text; the sleep step
    does not tell the Commander to tell the commander; the renal text covers reduced gravity."""
    ids = {r["id"] for r in R["thresholds"]["rules"]} | {i["id"] for i in R["personal"]["indicators"]}
    ids |= {r["variable"] for r in R["thresholds"]["rules"]} | {i["variable"] for i in R["personal"]["indicators"]}
    ids -= {"glucose", "mood"}   # plain English words as well as ids
    for c in R["cases"]["cases"]:
        for text in _crew_texts(c):
            for rid in ids:
                assert not re.search(rf"\b{re.escape(rid)}\b", text), (c["id"], rid, text)
            assert not re.search(r"LANDFALL (sees|saw|knows|thinks|decides|acts)\b|it sees\b", text), (c["id"], text)
    s5 = next(st for st in _case(R, "sleep_circadian")["procedure"] if st["id"] == "s5")
    assert "tell the commander" not in s5["text"] and "Commander and the Crew Medical Officer" in s5["text"]
    assert "[V1" not in s5["text"] and s5["basis"]["source"]["requirement_id"] == "V1 4011"
    s4 = next(st for st in _case(R, "sleep_circadian")["procedure"] if st["id"] == "s4")
    assert s4["basis"]["source"]["requirement_id"] == "V1 4014"
    assert "weightlessness or reduced gravity" in _case(R, "renal_stone")["interpretation"]["text"]
    assert "projections" not in _case(R, "renal_stone")      # ISS-rate months-to-POL dropped (judges)


def test_no_medication_advice_in_crew_text(R):
    """D12: potassium citrate appears only in the flight-surgeon note of the renal ground packet."""
    for c in R["cases"]["cases"]:
        for text in _crew_texts(c) + c["refusals"]:
            assert "citrate" not in text.lower(), (c["id"], text)
        alt_ids = [a["id"] for a in c["countermeasure"]["alternatives"]]
        assert not any("citrate" in a for a in alt_ids), c["id"]
    note = _case(R, "renal_stone")["escalation"]["flight_surgeon_note"]
    assert note["audience"] == "flight_surgeon"
    assert "a NASA-studied countermeasure (Whitson et al. 2009); the decision rests with the flight surgeon" in note["text"]
    assert note["source"]["citation"].startswith("Whitson PA")


def test_spe_source_framing_and_shelter_chip(R):
    """D3: an above-atmosphere monitor in Mars orbit, relayed locally; LANDFALL is not the radiation alarm; sheltering
    crew who are not on EVA at S3 is a labelled design choice (writing open item 3)."""
    onboard = next(r for r in R["thresholds"]["rules"] if r["id"] == "ops_onboard_proton_s3")
    assert onboard["label"].startswith("Mars-orbit space-weather monitor") and onboard["chip"] == "design choice"
    for frag in ("above the atmosphere, in Mars orbit", "no Earth link", "[V2 6165]", "raises the alarm ([V2 6164])"):
        assert frag in onboard["source"]["rationale"], frag
    assert any("no radial-distance or atmospheric correction" in n for n in onboard["notes"])
    spe = _case(R, "spe_shelter")
    assert "in Mars orbit" in spe["interpretation"]["text"] and "raises the radiation alarm" in spe["interpretation"]["text"]
    cm = spe["countermeasure"]["primary"]
    assert cm["chip"] == "design choice" and "is LANDFALL's choice" in cm["source"]["rationale"]
    assert {c["kind"] for c in cm["citations"]} == {"nasa_standard", "noaa"}
    assert any(r["id"] == "no_radiation_alarm" for r in R["meta"]["refusals"])


def test_scoped_claims_and_modelled_window(R):
    """D13/D14: never the unscoped 'NASA publishes no ...', never a 'real' conjunction window; the plan's wrong
    '> 2 L/day' urine figure is never printed (writing open item 4)."""
    for name, text in rules_texts(R):
        assert not re.search(r"NASA publishes no", text), (name, text[:120])
        assert not re.search(r"(?i)real (Mars solar )?conjunction|window is real|real window", text), (name, text[:120])
        assert not re.search(r"2 L/day|> ?2 L\b", text), (name, text[:120])
    principle = next(p for p in R["meta"]["principles"] if p["id"] == "no_nasa_alert_thresholds")
    assert principle["text"].startswith("NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; "
                                        "its alert requirements leave the number to the program")
    mars = next(e for e in R["environments"]["environments"] if e["id"] == "mars_surface")
    assert any("modelled from JPL Horizons geometry" in n and "RMS 0.79 d" in n for n in mars["notes"])
    snap = need_snapshot("horizons_mars_comms")
    assert any("RMS edge residual 0.79 d" in c for c in snap["caveats"])
