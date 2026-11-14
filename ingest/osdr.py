"""NASA OSDR adapter: SpaceX Inspiration4 crew clinical labs, frozen at build time.

Studies (file listings + metadata discovered through the public OSDR API):
  OSD-575  serum: Quest comprehensive metabolic panel (CMP) + Eve Technologies cytokine panels
           (HD71 immune, 71 analytes; HDCVD9 cardiovascular, 9 analytes)
  OSD-569  whole blood: Quest complete blood count (CBC)
  OSD-656  urine: Alamar NULISA-seq 200plex v1 Inflammation Panel (NPQ units).
           It contains NO urine chemistry (no urinary calcium, volume, pH, oxalate, citrate).

Snapshots: osdr_cmp, osdr_cbc, osdr_cytokines, osdr_urine.

Pitfalls handled here (each has a test in ingest/tests/test_osdr.py):
  * Reference ranges are per SAMPLE (subject x timepoint), not per analyte and not even
    constant per subject: C003 carries different ranges before and after flight for
    creatinine, calcium, ALP, AST, ALT (CMP) and RBC, hemoglobin, hematocrit (CBC).
  * The ALSDA TRANSFORMED CMP file names the ALT/AST upper limits `alt_max_units_per_liter`
    / `ast_max_units_per_liter` (no `range_`), and the two ratio columns carry no unit
    suffix. Every TRANSFORMED column must classify or the run fails: nothing is dropped
    silently.
  * The TRANSFORMED CBC file labels hemoglobin `percent`; the lab-submitted file says g/dL.
  * The lab-submitted CBC reports C003 R+1 RBC/hemoglobin/hematocrit under
    "... (FEMALE)" analyte names; they are merged into the base analyte.
  * The OSD-656 TRANSFORMED header has two blank cells and labels the IL1RL1 NPQ column as
    a percent column. Urine values are therefore read from the OSDR 'Original Submitted'
    xlsx (stdlib reader in _osdr_xlsx.py) and every value is cross-checked against the
    TRANSFORMED CSV; the mislabel is confirmed value-by-value and reported, never guessed.
  * Research assays carry no censoring flag: exact-zero NPQ (assay floor) and multi-digit
    values repeated across samples (cytokines) are counted and reported, never altered.
"""

from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from ._osdr_xlsx import read_sheet
from .common import RunContext, make_snapshot, sha256_hex

ADAPTER_ID = "osdr"

OSDR = "https://osdr.nasa.gov"
FILES_API = OSDR + "/osdr/data/osd/files/{n}"
META_API = OSDR + "/osdr/data/osd/meta/{n}"
LANDING = OSDR + "/bio/repo/data/studies/OSD-{n}"

SUBJECT_RE = re.compile(r"^C\d{3}$")
TIMEPOINT_RE = re.compile(r"^(?P<anchor>[LR])(?P<sign>[+-])(?P<days>\d+)$")
# "C001_serum_L-3", "C001_whole-blood_L-3_cbc", "C001_urine_L-92"
SAMPLE_RE = re.compile(r"^(?P<subject>C\d{3})_[a-z-]+_(?P<tp>[LR][+-]\d+)(?:_[a-z]+)?$")
MISSING_TOKENS = {"", "NA", "N/A"}
NON_FINITE_TOKENS = {"Inf", "-Inf", "NaN"}

# Lab-submitted analyte name -> (key, label). Keys equal the ALSDA TRANSFORMED column keys,
# which is what makes the cross-check possible. An analyte missing from these tables makes
# the run FAIL (never silently dropped).
CMP_ANALYTES: dict[str, tuple[str, str]] = {
    "GLUCOSE": ("glucose", "Glucose"),
    "UREA NITROGEN (BUN)": ("urea_nitrogen_bun", "Urea nitrogen (BUN)"),
    "CREATININE": ("creatinine", "Creatinine"),
    "eGFR NON-AFR. AMERICAN": ("egfr_non_african_american", "eGFR, non-African American (as reported)"),
    "eGFR AFRICAN AMERICAN": ("egfr_african_american", "eGFR, African American (as reported)"),
    "BUN/CREATININE RATIO": ("bun_to_creatinine_ratio", "BUN/creatinine ratio"),
    "SODIUM": ("sodium", "Sodium"),
    "POTASSIUM": ("potassium", "Potassium"),
    "CHLORIDE": ("chloride", "Chloride"),
    "CARBON DIOXIDE": ("carbon_dioxide", "Carbon dioxide (bicarbonate)"),
    "CALCIUM": ("calcium", "Calcium (serum)"),
    "PROTEIN; TOTAL": ("total_protein", "Total protein"),
    "ALBUMIN": ("albumin", "Albumin"),
    "GLOBULIN": ("globulin", "Globulin"),
    "ALBUMIN/GLOBULIN RATIO": ("albumin_to_globulin_ratio", "Albumin/globulin ratio"),
    "BILIRUBIN; TOTAL": ("total_bilirubin", "Total bilirubin"),
    "ALKALINE PHOSPHATASE": ("alkaline_phosphatase", "Alkaline phosphatase (ALP)"),
    "AST": ("ast", "AST"),
    "ALT": ("alt", "ALT"),
}
CBC_ANALYTES: dict[str, tuple[str, str]] = {
    "WHITE BLOOD CELL COUNT": ("white_blood_cell_count", "White blood cell count"),
    "RED BLOOD CELL COUNT": ("red_blood_cell_count", "Red blood cell count"),
    "HEMOGLOBIN": ("hemoglobin", "Hemoglobin"),
    "HEMATOCRIT": ("hematocrit", "Hematocrit"),
    "MCV": ("mcv", "MCV"),
    "MCH": ("mch", "MCH"),
    "MCHC": ("mchc", "MCHC"),
    "RDW": ("rdw", "RDW"),
    "PLATELET COUNT": ("platelet_count", "Platelet count"),
    "MPV": ("mpv", "MPV"),
    "ABSOLUTE NEUTROPHILS": ("absolute_neutrophils", "Neutrophils, absolute"),
    "ABSOLUTE LYMPHOCYTES": ("absolute_lymphocytes", "Lymphocytes, absolute"),
    "ABSOLUTE MONOCYTES": ("absolute_monocytes", "Monocytes, absolute"),
    "ABSOLUTE EOSINOPHILS": ("absolute_eosinophils", "Eosinophils, absolute"),
    "ABSOLUTE BASOPHILS": ("absolute_basophils", "Basophils, absolute"),
    "NEUTROPHILS": ("neutrophils", "Neutrophils, %"),
    "LYMPHOCYTES": ("lymphocytes", "Lymphocytes, %"),
    "MONOCYTES": ("monocytes", "Monocytes, %"),
    "EOSINOPHILS": ("eosinophils", "Eosinophils, %"),
    "BASOPHILS": ("basophils", "Basophils, %"),
}
FEMALE_SUFFIX = " (FEMALE)"

# Lab unit (submitted file) -> unit suffix(es) the ALSDA TRANSFORMED column should carry.
# None = the transformed column has no unit suffix. Used only for the cross-check.
UNIT_SUFFIX = {
    "mg/dL": {"milligram_per_deciliter"},
    "g/dL": {"gram_per_deciliter", "grams_per_deciliter"},
    "mmol/L": {"millimol_per_liter"},
    "U/L": {"units_per_liter"},
    "mL/min/1.73m2": {"milliliter_per_minute_per_1.73_meter_squared"},
    "(calc)": {None},
    "Thousand/uL": {"thousand_per_microliter"},
    "Million/uL": {"million_per_microliter"},
    "%": {"percent"},
    "fL": {"femtoliter"},
    "pg": {"picogram"},
    "cells/uL": {"cells_per_microliter"},
}

EVE_PANELS = {
    "HD71": "Eve Technologies HD71 (immune, 71-plex)",
    "HDCVD9": "Eve Technologies HDCVD9 (cardiovascular, 9-plex)",
}

NPQ_DECIMALS = 3


def round_npq(v: float | int | None) -> float | int | None:
    return None if v is None else round(v, NPQ_DECIMALS)


GREEK = {"α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta"}

COMMON_CAVEATS = [
    "Inspiration4 was a ~3-day civilian low-Earth-orbit flight (OSDR metadata: mission "
    "2021-09-16 to 2021-09-18) with n=4 crew. These files contain NO in-flight samples: only "
    "{timepoints} (the OSDR study description says 'The crew collected biospecimen samples "
    "before, during, and after flight', but no in-flight sample is in these files). These "
    "files provide {provides}; they are NOT a "
    "model of a long-duration exploration mission and must not be presented as one.",
    "within_own_range is an OBSERVATION (value inside the reference range the laboratory "
    "printed for that same sample, bounds inclusive; one-sided ranges compare one bound), "
    "not an alert, not a diagnosis and not a NASA threshold. NASA publishes no numeric "
    "in-flight alert threshold for these analytes.",
    "Timepoint dates are nominal and derived (label offset from the OSDR mission start for "
    "L-, from the mission end for R+); actual collection timestamps are not in these files.",
    "License: not stated in the OSDR API response; the files are publicly released "
    "(OSDR file records 'restricted': false). Check the OSDR study page before reuse.",
]


# --------------------------------------------------------------------------- parsing utils

def parse_number(raw: str) -> float | int | None:
    """Published string -> number, keeping integers as ints. NA/N/A/blank -> None.

    'Inf' and other non-finite tokens also -> None; callers that care report them."""
    s = (raw or "").strip()
    if s in MISSING_TOKENS or s in NON_FINITE_TOKENS:
        return None
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    v = float(s)  # raises on anything unexpected: fail loudly, never guess
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return v


def parse_timepoint(label: str) -> dict:
    m = TIMEPOINT_RE.match(label)
    if not m:
        raise ValueError(f"unrecognised timepoint label {label!r}")
    anchor, sign, days = m["anchor"], m["sign"], int(m["days"])
    if (anchor, sign) not in {("L", "-"), ("R", "+")}:
        raise ValueError(f"unexpected timepoint convention {label!r}")
    return {"label": label, "day_offset": -days if anchor == "L" else days,
            "anchor": "launch" if anchor == "L" else "return"}


def timepoints_payload(labels: set[str], mission_start: date, mission_end: date) -> list[dict]:
    tps = [parse_timepoint(lbl) for lbl in labels]
    tps.sort(key=lambda t: (t["anchor"] != "launch", t["day_offset"]))
    for t in tps:
        base = mission_start if t["anchor"] == "launch" else mission_end
        t["nominal_date"] = (base + timedelta(days=t["day_offset"])).isoformat()
    return tps


def within(v: float | int | None, rmin: float | int | None, rmax: float | int | None) -> bool | None:
    """Observation only: is v inside [rmin, rmax] (inclusive)? None when undecidable."""
    if v is None or (rmin is None and rmax is None):
        return None
    return (rmin is None or v >= rmin) and (rmax is None or v <= rmax)


def read_csv(text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(text.lstrip("﻿"))))


def slug(name: str) -> str:
    for g, word in GREEK.items():
        name = name.replace(g, word)
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def parse_mdy(s: str) -> date:
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            pass
    raise ValueError(f"unrecognised OSDR mission date {s!r}")


def parse_dmy(s: str) -> str:
    return datetime.strptime(s.strip(), "%d-%b-%Y").date().isoformat()


# ---------------------------------------------------- lab-submitted long format (CMP, CBC)

def parse_lab_long(text: str, table: dict[str, tuple[str, str]], panel: str,
                   timepoint_col: str) -> dict:
    """Quest long format: ANALYTE, VALUE, RANGE_MIN, RANGE_MAX, UNITS, ..., SUBJECT_ID, SEX, <tp>.

    Returns {"analytes": {key: {...}}, "sex": {subject: sex}, "timepoints": set, "notes": [...]}.
    Ranges are stored PER SAMPLE: ranges[subject][timepoint] = {min, max}."""
    rows = read_csv(text)
    header = rows[0]
    need = {"ANALYTE", "VALUE", "RANGE_MIN", "RANGE_MAX", "UNITS", "SUBJECT_ID", "SEX", timepoint_col}
    missing = need - set(header)
    if missing:
        raise ValueError(f"{panel}: submitted file lacks columns {sorted(missing)}")
    out: dict[str, dict] = {}
    sex: dict[str, str] = {}
    tps: set[str] = set()
    notes: list[str] = []
    seen: set[tuple[str, str, str]] = set()
    for r in rows[1:]:
        if not any(c.strip() for c in r):
            continue
        rec = dict(zip(header, r))
        name = rec["ANALYTE"].strip()
        reported_as = name
        if name.endswith(FEMALE_SUFFIX):
            name = name[: -len(FEMALE_SUFFIX)]
        if name not in table:
            raise ValueError(f"{panel}: unmapped analyte {reported_as!r} - add it to the table")
        key, label = table[name]
        subj, tp = rec["SUBJECT_ID"].strip(), rec[timepoint_col].strip()
        if not SUBJECT_RE.match(subj):
            raise ValueError(f"{panel}: unexpected subject id {subj!r}")
        parse_timepoint(tp)
        if (key, subj, tp) in seen:
            raise ValueError(f"{panel}: duplicate row for {key} {subj} {tp}")
        seen.add((key, subj, tp))
        tps.add(tp)
        sex.setdefault(subj, rec["SEX"].strip())
        a = out.setdefault(key, {"key": key, "label": label, "unit": rec["UNITS"].strip(),
                                 "panel": panel, "reported_as": name,
                                 "values": {}, "ranges": {}, "notes": []})
        if rec["UNITS"].strip() != a["unit"]:
            raise ValueError(f"{panel}: {key} reported in two units ({a['unit']!r}, {rec['UNITS']!r})")
        if reported_as != name:
            a["notes"].append(f"{subj} {tp}: reported by the lab as {reported_as!r}; merged here.")
        a["values"].setdefault(subj, {})[tp] = parse_number(rec["VALUE"])
        a["ranges"].setdefault(subj, {})[tp] = {"min": parse_number(rec["RANGE_MIN"]),
                                                 "max": parse_number(rec["RANGE_MAX"])}
    unseen = sorted({k for k, _ in table.values()} - set(out))
    if unseen:
        notes.append(f"{panel}: analytes in the mapping table but absent from the file: {unseen}")
    return {"analytes": out, "sex": sex, "timepoints": tps, "notes": notes}


def finalize_lab(parsed: dict, subjects: list[str], timepoints: list[str]) -> list[dict]:
    """Fill every subject x timepoint (null when absent) and compute within_own_range."""
    out = []
    for a in parsed["analytes"].values():
        values, ranges, inside, vary, absent = {}, {}, {}, [], []
        for s in subjects:
            values[s], ranges[s], inside[s] = {}, {}, {}
            distinct = set()
            for t in timepoints:
                v = a["values"].get(s, {}).get(t)
                rg = a["ranges"].get(s, {}).get(t)
                if t not in a["values"].get(s, {}):
                    absent.append(f"{s} {t}")
                values[s][t] = v
                ranges[s][t] = rg
                inside[s][t] = within(v, rg["min"], rg["max"]) if rg else None
                if rg:
                    distinct.add((rg["min"], rg["max"]))
            if len(distinct) > 1:
                vary.append(s)
        notes = list(a["notes"])
        if absent:
            notes.append("No row in the lab-submitted file for: " + ", ".join(absent) + ".")
        n_null = sum(v is None for s in subjects for v in values[s].values())
        out.append({"key": a["key"], "label": a["label"], "unit": a["unit"], "panel": a["panel"],
                    "reported_as": a["reported_as"], "values": values, "ranges": ranges,
                    "ranges_vary_within_subject": vary, "within_own_range": inside,
                    "n_null_values": n_null, "notes": notes})
    return out


# ------------------------------------------------- ALSDA TRANSFORMED wide format (cross-check)

_COL_RE = re.compile(r"^(?P<key>[a-z0-9]+(?:_[a-z0-9]+)*?)_(?P<kind>value|range_min|range_max)"
                     r"(?:_(?P<unit>.+))?$")
# The CMP file writes the ALT/AST upper limit as `<key>_max_<unit>` (no `range_`).
_ALIAS_RE = re.compile(r"^(?P<key>[a-z0-9]+(?:_[a-z0-9]+)*?)_(?P<kind>min|max)_(?P<unit>.+)$")


def classify_transformed_columns(header: list[str]) -> dict[str, dict[str, tuple[int, str | None]]]:
    """Column name -> {key: {"value"|"range_min"|"range_max": (index, unit_suffix)}}.

    Raises ValueError for any column that cannot be classified, so an upper limit can
    never disappear silently (the failure mode of a naive `_range_max_` regex)."""
    cols: dict[str, dict[str, tuple[int, str | None]]] = {}
    aliases: list[tuple[int, str, str, str]] = []
    unknown: list[str] = []
    for i, name in enumerate(header[1:], start=1):
        m = _COL_RE.match(name)
        if m:
            slot = cols.setdefault(m["key"], {})
            if m["kind"] in slot:
                raise ValueError(f"duplicate {m['kind']} column for {m['key']!r}")
            slot[m["kind"]] = (i, m["unit"])
            continue
        m = _ALIAS_RE.match(name)
        if m:
            aliases.append((i, m["key"], "range_" + m["kind"], m["unit"]))
            continue
        unknown.append(name)
    for i, key, kind, unit in aliases:
        slot = cols.get(key)
        if slot is None or "value" not in slot or kind in slot:
            unknown.append(header[i])
            continue
        slot[kind] = (i, unit)
    if unknown:
        raise ValueError(f"unclassifiable TRANSFORMED columns (refusing to drop them): {unknown}")
    return cols


def parse_transformed(text: str) -> dict:
    """-> {"columns": classification, "samples": {(subject, tp): {key: {kind: number}}}}."""
    rows = read_csv(text)
    header = rows[0]
    cols = classify_transformed_columns(header)
    samples: dict[tuple[str, str], dict] = {}
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        m = SAMPLE_RE.match(r[0].strip())
        if not m:
            raise ValueError(f"unrecognised sample name {r[0]!r}")
        rec = {}
        for key, slot in cols.items():
            rec[key] = {kind: parse_number(r[idx]) if idx < len(r) else None
                        for kind, (idx, _unit) in slot.items()}
        samples[(m["subject"], m["tp"])] = rec
    return {"columns": cols, "samples": samples}


def cross_check(analytes: list[dict], transformed: dict) -> dict:
    """Compare every lab-submitted value/range with the ALSDA TRANSFORMED file."""
    cols, samples = transformed["columns"], transformed["samples"]
    compared, mismatches, unit_flags = 0, [], []
    for a in analytes:
        key = a["key"]
        if key not in cols:
            mismatches.append(f"{key}: no column in the TRANSFORMED file")
            continue
        expected = UNIT_SUFFIX.get(a["unit"])
        got = cols[key]["value"][1]
        if expected is not None and got not in expected:
            unit_flags.append(f"{key}: TRANSFORMED column unit suffix {got!r} but the lab-submitted "
                              f"file reports {a['unit']!r}; LANDFALL uses {a['unit']!r}.")
        for s, per_tp in a["values"].items():
            for t, v in per_tp.items():
                tr = samples.get((s, t), {}).get(key)
                if tr is None:
                    if v is not None:
                        mismatches.append(f"{key} {s} {t}: sample absent from TRANSFORMED")
                    continue
                rg = a["ranges"][s][t] or {"min": None, "max": None}
                for kind, mine in (("value", v), ("range_min", rg["min"]), ("range_max", rg["max"])):
                    theirs = tr.get(kind)
                    compared += 1
                    if not _same(mine, theirs):
                        mismatches.append(f"{key} {s} {t} {kind}: submitted={mine!r} transformed={theirs!r}")
    return {"compared_fields": compared, "mismatches": mismatches, "unit_label_discrepancies": unit_flags}


def _same(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) < 1e-9


# ------------------------------------------------------------- Eve cytokines (long format)

def parse_eve(text: str, expected_type: str) -> dict:
    rows = read_csv(text)
    header = rows[0]
    need = {"Analyte", "Concentration", "Timepoint", "ID", "Unit", "Type"}
    if need - set(header):
        raise ValueError(f"Eve file lacks columns {sorted(need - set(header))}")
    out: dict[str, dict] = {}
    tps: set[str] = set()
    for r in rows[1:]:
        if not any(c.strip() for c in r):
            continue
        rec = dict(zip(header, r))
        if rec["Type"].strip() != expected_type:
            raise ValueError(f"Eve file: unexpected panel type {rec['Type']!r}")
        name, subj, tp = rec["Analyte"].strip(), rec["ID"].strip(), rec["Timepoint"].strip()
        if not SUBJECT_RE.match(subj):
            raise ValueError(f"Eve file: unexpected subject id {subj!r}")
        parse_timepoint(tp)
        tps.add(tp)
        key = "eve_" + expected_type.lower() + "_" + slug(name)
        a = out.setdefault(key, {"key": key, "label": name, "unit": rec["Unit"].strip().replace("ml", "mL"),
                                 "panel": EVE_PANELS[expected_type], "reported_as": name, "values": {}})
        if a["label"] != name:
            raise ValueError(f"Eve file: analyte key collision {key!r}")
        if subj in a["values"] and tp in a["values"][subj]:
            raise ValueError(f"Eve file: duplicate {name} {subj} {tp}")
        a["values"].setdefault(subj, {})[tp] = parse_number(rec["Concentration"])
    return {"analytes": out, "timepoints": tps}


# --------------------------------------------------------- Alamar NULISA-seq (urine, OSD-656)

def parse_target_info(text: str) -> dict[str, dict]:
    rows = read_csv(text)
    header = rows[0]
    info = {}
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        rec = dict(zip(header, r))
        target = rec["Target"].strip()
        name = re.sub(r",\s*Human$", "", target)
        k = slug(name)
        info[k] = {"target": target, "name": name, "protein": rec.get("ProteinName", "").strip(),
                   "gene": rec.get("GeneName", "").strip(), "uniprot": rec.get("UniProtID", "").strip()}
    return info


def parse_nulisa_submitted(rows: list[list[str | None]]) -> dict[str, dict[tuple[str, str], Any]]:
    """OSDR 'Original Submitted' NULISA sheet (long format: Analyte, Concentration, Timepoint, ID,
    Unit, ...) -> {analyte name as reported: {(subject, timepoint): NPQ}}, in file order."""
    header = [(h or "").strip() for h in rows[0]]
    need = {"Analyte", "Concentration", "Timepoint", "ID", "Unit"}
    if need - set(header):
        raise ValueError(f"NULISA submitted sheet lacks columns {sorted(need - set(header))}")
    out: dict[str, dict[tuple[str, str], Any]] = {}
    for r in rows[1:]:
        cells = [(c or "").strip() for c in r] + [""] * (len(header) - len(r))
        rec = dict(zip(header, cells))
        if not rec["Analyte"]:
            continue
        if rec["Unit"] != "NPQ":
            raise ValueError(f"NULISA submitted sheet: unexpected unit {rec['Unit']!r}")
        subj, tp = rec["ID"], rec["Timepoint"]
        if not SUBJECT_RE.match(subj):
            raise ValueError(f"NULISA submitted sheet: unexpected subject id {subj!r}")
        parse_timepoint(tp)
        vals = out.setdefault(rec["Analyte"], {})
        if (subj, tp) in vals:
            raise ValueError(f"NULISA submitted sheet: duplicate {rec['Analyte']} {subj} {tp}")
        vals[(subj, tp)] = parse_number(rec["Concentration"])
    return out


def _close(a: Any, b: Any) -> bool:
    """Same number up to the ~10 significant digits the TRANSFORMED CSV keeps."""
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) <= 1e-8 * max(1.0, abs(float(a)))


def cross_check_nulisa(submitted: dict[str, dict], transformed: dict) -> dict:
    """Compare every submitted NPQ with the ALSDA TRANSFORMED CSV (matched on slugged name)."""
    tr_samples = transformed["samples"]
    by_slug = {slug(k): k for k in transformed["keys"]}
    compared, mismatches, missing = 0, [], []
    for name, vals in submitted.items():
        k = by_slug.get(slug(name))
        if k is None:
            missing.append(name)
            continue
        for (s, t), v in vals.items():
            compared += 1
            tr = tr_samples.get((s, t), {}).get(k)
            if not _close(v, tr):
                mismatches.append(f"{name} {s} {t}: submitted={v!r} transformed={tr!r}")
    sub_samples = {st for vals in submitted.values() for st in vals}
    findings = []
    for k, vals in transformed["orphan_pct_values"].items():
        name = next((n for n in submitted if slug(n) == slug(k)), None)
        if name is None:
            continue
        same = sum(_close(submitted[name].get(st), v) for st, v in vals.items())
        findings.append(f"{k}: the TRANSFORMED column headed '{k}_percent_normalized_value' equals the "
                        f"submitted {name} NPQ in {same}/{len(vals)} samples, so that header is mislabelled; "
                        f"{name} values here come from the Original Submitted file.")
    return {"compared_values": compared, "mismatches": mismatches,
            "submitted_targets_missing_from_transformed": missing,
            "samples_only_in_one_file": sorted(f"{s} {t}" for s, t in set(tr_samples) ^ sub_samples),
            "header_findings": findings}


def _sig_digits(v: float | int) -> int:
    digits = repr(abs(v)).lower().split("e")[0].replace(".", "").lstrip("0")
    if isinstance(v, int) or float(v).is_integer():
        digits = digits.rstrip("0")
    return len(digits)


def exact_repeats(values: dict[str, dict[str, Any]], min_count: int = 3, min_sig: int = 4) -> list[dict]:
    """Values (>= min_sig significant digits) that recur in >= min_count different samples of one
    analyte. Such exact repeats are not plausible as independent measurements; the files carry no
    censoring flag, so they are reported, never altered."""
    where: dict[Any, list[str]] = {}
    for s, per in values.items():
        for t, v in per.items():
            if v is not None:
                where.setdefault(v, []).append(f"{s} {t}")
    return [{"value": v, "n": len(w), "samples": w} for v, w in where.items()
            if len(w) >= min_count and _sig_digits(v) >= min_sig]


def parse_nulisa(text: str) -> dict:
    """Keep only `<key>_concentration_npq` columns. Report header defects instead of guessing."""
    rows = read_csv(text)
    header = rows[0]
    npq_suffix, pct_suffix = "_concentration_npq", "_percent_normalized_value"
    npq = {c[: -len(npq_suffix)]: i for i, c in enumerate(header) if c.endswith(npq_suffix)}
    pct = {c[: -len(pct_suffix)]: i for i, c in enumerate(header) if c.endswith(pct_suffix)}
    defects = []
    blank = [i for i, c in enumerate(header) if i > 0 and not c.strip()]
    if blank:
        defects.append(f"{len(blank)} blank header cell(s) at column index {blank}; those columns are not used.")
    orphan_pct = sorted(set(pct) - set(npq))
    for k in orphan_pct:
        defects.append(f"{k!r}: the TRANSFORMED file has a '{k}{pct_suffix}' header but no '{k}{npq_suffix}' "
                       f"header (header misalignment next to a blank column); its NPQ is never read from "
                       f"the TRANSFORMED file.")
    other = [c for i, c in enumerate(header[1:], start=1)
             if c.strip() and not (c.endswith(npq_suffix) or c.endswith(pct_suffix))]
    if other:
        raise ValueError(f"unclassifiable NULISA columns: {other}")
    samples, non_finite = {}, []
    orphan_values: dict[str, dict[tuple[str, str], Any]] = {k: {} for k in orphan_pct}
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        m = SAMPLE_RE.match(r[0].strip())
        if not m:
            raise ValueError(f"unrecognised sample name {r[0]!r}")
        rec = {}
        for k, i in npq.items():
            raw = r[i].strip() if i < len(r) else ""
            if raw in NON_FINITE_TOKENS:
                non_finite.append(f"{k} {m['subject']} {m['tp']}={raw}")
            rec[k] = parse_number(raw)
        samples[(m["subject"], m["tp"])] = rec
        for k in orphan_pct:  # kept only to diagnose the mislabelled header against the submitted file
            i = pct[k]
            orphan_values[k][(m["subject"], m["tp"])] = parse_number(r[i]) if i < len(r) else None
    return {"keys": list(npq), "samples": samples, "defects": defects, "dropped": orphan_pct,
            "orphan_pct_values": orphan_values, "non_finite_npq": non_finite}


# ------------------------------------------------------------------------- study metadata

def study(ctx: RunContext, n: str) -> dict:
    files_url, meta_url = FILES_API.format(n=n), META_API.format(n=n)
    listing = ctx.fetch_json(files_url)
    meta = ctx.fetch_json(meta_url)
    osd = f"OSD-{n}"
    files = {f["file_name"]: f for f in listing["studies"][osd]["study_files"]}
    st = meta["study"][osd]
    s = st["studies"][0]
    comments = {}
    for c in s.get("comments", []):
        if c.get("value"):
            comments.setdefault(c["name"], c["value"])
    pubs = [{"title": p.get("title", "").strip(), "doi": p.get("doi", "").strip() or None,
             "pmid": p.get("pubMedID", "").strip() or None}
            for p in s.get("publications", [])]
    people = [(f"{p.get('firstName', '')} {p.get('lastName', '')}".strip(),
               [r.get("annotationValue") for r in p.get("roles", [])]) for p in s.get("people", [])]
    stated_dois = [c.get("value") for c in s.get("comments", []) if c.get("name") == "DOI" and c.get("value")]
    return {
        "n": n, "osd": osd, "title": s["title"].strip(), "description": s.get("description", ""),
        "release_date": parse_dmy(s["publicReleaseDate"]), "submission_date": parse_dmy(s["submissionDate"]),
        "version": st.get("version"), "files": files, "publications": pubs, "people": people,
        "dataset_doi": stated_dois[0] if stated_dois else None,
        "mission_name": comments.get("Mission Name", ""),
        "mission_start": parse_mdy(comments["Mission Start"]), "mission_end": parse_mdy(comments["Mission End"]),
        "landing": LANDING.format(n=n), "files_url": files_url, "meta_url": meta_url,
    }


def fetch_file(ctx: RunContext, st: dict, name: str, binary: bool = False) -> tuple[Any, dict]:
    """-> (text, or bytes when binary=True; file record with url, size and sha256)."""
    rec = st["files"].get(name)
    if rec is None:
        raise RuntimeError(f"{st['osd']}: file {name!r} not in the OSDR listing (renamed?)")
    url = OSDR + rec["remote_url"]
    b = ctx.fetch_bytes(url)
    if rec.get("file_size") is not None and len(b) != rec["file_size"]:
        raise RuntimeError(f"{name}: got {len(b)} bytes, OSDR lists {rec['file_size']}")
    updated = rec.get("date_updated") or rec.get("date_created")
    info = {"name": name, "url": url, "bytes": len(b), "sha256": sha256_hex(b),
            "osdr_category": rec.get("category"), "osdr_subdirectory": rec.get("subdirectory"),
            "osdr_date_updated": (datetime.fromtimestamp(updated, tz=timezone.utc).date().isoformat()
                                  if updated else None)}
    return (b if binary else b.decode("utf-8-sig")), info


def citation(st: dict) -> str:
    people = "; ".join(f"{name} ({', '.join(r for r in roles if r)})" for name, roles in st["people"]) or "n/a"
    pubs = "; ".join(f"{p['title']} (doi:{p['doi']})" if p["doi"] else p["title"] for p in st["publications"])
    doi = f"doi:{st['dataset_doi']}" if st["dataset_doi"] else "no dataset DOI is stated in the OSDR metadata"
    return (f"NASA Open Science Data Repository (OSDR). {st['osd']}: {st['title']}. "
            f"Study version {st['version']}, submitted {st['submission_date']}, publicly released "
            f"{st['release_date']}. {st['landing']} ({doi}). Investigators listed by OSDR: {people}. "
            f"Publications listed by OSDR: {pubs}.")


def source(st: dict, files: list[dict]) -> dict:
    return {"publisher": "NASA Open Science Data Repository (OSDR)",
            "name": f"{st['osd']}: {st['title']}",
            "url": st["landing"],
            "access_urls": [st["files_url"], st["meta_url"]] + [f["url"] for f in files],
            "license": COMMON_CAVEATS[-1].split(": ", 1)[1],
            "citation": citation(st)}


def study_payload(st: dict, files: list[dict]) -> dict:
    return {"id": st["osd"], "title": st["title"], "version": st["version"],
            "submission_date": st["submission_date"], "public_release_date": st["release_date"],
            "landing_url": st["landing"], "dataset_doi": st["dataset_doi"],
            "publications": st["publications"], "files": files,
            "mission": {"name": st["mission_name"], "start": st["mission_start"].isoformat(),
                        "end": st["mission_end"].isoformat(), "source": "OSDR study comments"}}


def common_caveats(tps: list[dict], has_ranges: bool = True) -> list[str]:
    pre = "/".join(t["label"] for t in tps if t["anchor"] == "launch")
    post = "/".join(t["label"] for t in tps if t["anchor"] == "return")
    provides = ("real laboratory reference ranges and a real post-flight recovery shape" if has_ranges
                else "a real post-flight recovery shape only (no reference ranges exist in these files)")
    first = COMMON_CAVEATS[0].format(timepoints=f"pre-flight {pre} and post-flight {post}", provides=provides)
    return [first] + COMMON_CAVEATS[1:-1]


def coverage(tps: list[dict]) -> dict:
    ds = sorted(t["nominal_date"] for t in tps)
    return {"start": ds[0] + "T00:00:00Z", "stop": ds[-1] + "T00:00:00Z", "cadence": None}


def ordered(labels: set[str], st: dict) -> list[dict]:
    return timepoints_payload(labels, st["mission_start"], st["mission_end"])


def subjects_of(*maps: dict) -> list[str]:
    subs = set()
    for m in maps:
        subs |= set(m)
    return sorted(subs)


# ------------------------------------------------------------------------------- snapshots

def _range_change_caveat(analytes: list[dict], sex: dict[str, str], panel: str) -> str | None:
    lines = []
    for a in analytes:
        for s in a["ranges_vary_within_subject"]:
            by_range: dict[tuple, list[str]] = {}
            for t, rg in a["ranges"][s].items():
                if rg:
                    by_range.setdefault((rg["min"], rg["max"]), []).append(t)
            desc = "; ".join(f"{lo}-{hi} at {', '.join(ts)}" for (lo, hi), ts in by_range.items())
            lines.append(f"{a['label']} {s}: {desc}")
    if not lines:
        return None
    subs = sorted({s for a in analytes for s in a["ranges_vary_within_subject"]})
    sx = ", ".join(f"{s} recorded as {sex.get(s, '?')}" for s in subs)
    return (f"{panel}: reference ranges are per SAMPLE and change within a subject ({sx}). "
            "LANDFALL reproduces the range the lab printed for each sample and does not correct it; "
            "never collapse them to one range per analyte or per subject. " + " | ".join(lines))


def build_lab_snapshot(ctx: RunContext, *, sid: str, n: str, submitted: str, transformed: str,
                       table: dict, panel: str, timepoint_col: str, title: str,
                       extra_caveats: list[str]) -> dict:
    st = study(ctx, n)
    sub_text, sub_info = fetch_file(ctx, st, submitted)
    tr_text, tr_info = fetch_file(ctx, st, transformed)
    parsed = parse_lab_long(sub_text, table, panel, timepoint_col)
    tps = ordered(parsed["timepoints"], st)
    labels = [t["label"] for t in tps]
    subjects = subjects_of(parsed["sex"])
    analytes = finalize_lab(parsed, subjects, labels)
    xc = cross_check(analytes, parse_transformed(tr_text))
    caveats = common_caveats(tps)
    rc = _range_change_caveat(analytes, parsed["sex"], panel)
    if rc:
        caveats.append(rc)
    caveats += extra_caveats
    caveats += xc["unit_label_discrepancies"]
    if xc["mismatches"]:
        caveats.append(f"Cross-check found {len(xc['mismatches'])} disagreement(s) between the lab-submitted "
                       f"and the ALSDA TRANSFORMED file; values shown are the lab-submitted ones: "
                       + "; ".join(xc["mismatches"][:20]))
    caveats += parsed["notes"]
    data = {
        "study": study_payload(st, [sub_info, tr_info]),
        "subjects": subjects, "subject_sex_as_recorded": parsed["sex"],
        "timepoints": tps,
        "analytes": analytes,
        "method": {
            "values_from": submitted + " (OSDR 'Original Submitted', the laboratory report)",
            "cross_checked_against": transformed + " (OSDR 'ALSDA Transformed Files')",
            "ranges": "Reference range printed by the laboratory for that exact sample: "
                      "ranges[subject][timepoint] = {min, max}; max null = one-sided range.",
            "within_own_range": "min <= value <= max (inclusive); null if value or both bounds missing. "
                                "An observation, not an alert.",
            "null_values": "NA / N/A / blank in the source, or no row for that sample.",
        },
        "cross_check": xc,
    }
    return make_snapshot(id=sid, adapter=ADAPTER_ID, title=title, source=source(st, [sub_info, tr_info]),
                         retrieved_at=ctx.retrieved_at, coverage=coverage(tps),
                         freshness={"kind": "historical", "stale_after": None}, provenance="measured",
                         caveats=caveats, data=data)


def build_cmp(ctx: RunContext) -> dict:
    return build_lab_snapshot(
        ctx, sid="osdr_cmp", n="575",
        submitted="LSDS-8_Comprehensive_Metabolic_Panel_CMP.upload_SUBMITTED.csv",
        transformed="LSDS-8_Comprehensive_Metabolic_Panel_CMP_TRANSFORMED.csv",
        table=CMP_ANALYTES, panel="CMP", timepoint_col="timepoint",
        title="Inspiration4 crew comprehensive metabolic panel (OSD-575), with per-sample lab reference ranges",
        extra_caveats=[
            "OSD-575's study description lists serum timepoints L-92 to R+82 only, but the CMP files "
            "also contain R+194 for all four crew; it is included.",
            "Serum calcium is a blood concentration, not urinary calcium excretion. OSD-656 (the "
            "Inspiration4 urine study) contains no urine chemistry at all, so no OSDR Inspiration4 file "
            "can drive the bone -> renal-stone case as urine data.",
            "eGFR is reported by the lab in two race-based variants with a one-sided range "
            "(RANGE_MAX 'N/A'); both are reproduced exactly as published, not endorsed.",
            "BUN/creatinine ratio is 'NA' in most samples as published (and one row is absent); "
            "those are null here, never imputed.",
            "ALSDA TRANSFORMED CMP file: the ALT and AST upper limits are named "
            "'alt_max_units_per_liter' / 'ast_max_units_per_liter' (no 'range_'); this adapter "
            "classifies every column or fails, so those limits cannot be dropped silently.",
        ])


def build_cbc(ctx: RunContext) -> dict:
    return build_lab_snapshot(
        ctx, sid="osdr_cbc", n="569",
        submitted="LSDS-7_Complete_Blood_Count_CBC.upload_SUBMITTED.csv",
        transformed="LSDS-7_Complete_Blood_Count_CBC_TRANSFORMED.csv",
        table=CBC_ANALYTES, panel="CBC", timepoint_col="TEST_DATE",
        title="Inspiration4 crew complete blood count (OSD-569), with per-sample lab reference ranges",
        extra_caveats=[
            "The lab-submitted CBC reports C003 R+1 red cell count, hemoglobin and hematocrit under "
            "'(FEMALE)' analyte names; they are merged into the base analyte with their own ranges.",
            "Immune and cardiovascular status are OBSERVED here (cell counts with lab ranges), "
            "not modelled as a LANDFALL case.",
        ])


def build_cytokines(ctx: RunContext) -> dict:
    st = study(ctx, "575")
    files, analytes, tps_all = [], [], set()
    for name, ptype in (("LSDS-8_Multiplex_serum.immune.EvePanel_SUBMITTED.csv", "HD71"),
                        ("LSDS-8_Multiplex_serum.cardiovascular.EvePanel_SUBMITTED.csv", "HDCVD9")):
        text, info = fetch_file(ctx, st, name)
        files.append(info)
        p = parse_eve(text, ptype)
        tps_all |= p["timepoints"]
        analytes += list(p["analytes"].values())
    tps = ordered(tps_all, st)
    labels = [t["label"] for t in tps]
    subjects = subjects_of(*[a["values"] for a in analytes])
    out = []
    for a in analytes:
        vals = {s: {t: a["values"].get(s, {}).get(t) for t in labels} for s in subjects}
        out.append({"key": a["key"], "label": a["label"], "unit": a["unit"], "panel": a["panel"],
                    "reported_as": a["reported_as"], "values": vals, "ranges": None,
                    "within_own_range": None, "exact_repeats": exact_repeats(vals)})
    reps = [f"{a['label']} {r['value']} {a['unit']} x{r['n']} ({', '.join(r['samples'])})"
            for a in out for r in a["exact_repeats"]]
    caveats = common_caveats(tps, has_ranges=False) + [
        "Research multiplex immunoassays (Eve Technologies): the files carry NO clinical reference "
        "range, so ranges and within_own_range are null. Compare a crewmember only with their own "
        "pre-flight values; absolute cut-offs would be invented.",
        "Values are the 'Concentration' column of the lab-submitted files; the 'Percent' column is not "
        "included because its normalisation basis is not documented in the files fetched.",
        "Immune and cardiovascular status are OBSERVED and cited, not modelled as a LANDFALL case.",
        "OSD-575 also holds an Alamar NULISA-seq 200-plex serum panel; it is not ingested here "
        "(relative NPQ units, size budget).",
    ]
    if reps:
        caveats.append(
            "Exact repeats: the same multi-digit value recurs in several different crew/timepoint samples "
            "of one analyte (rule: >= 4 significant digits in >= 3 samples). The files carry no "
            "out-of-range or censoring flag, so these are reproduced as published, but they are not "
            "plausible as independent measurements (possibly values substituted at an assay limit) and "
            "should not be read as precise levels or used as a baseline. Listed per analyte in "
            "exact_repeats: " + "; ".join(reps))
    data = {"study": study_payload(st, files), "subjects": subjects, "timepoints": tps, "analytes": out,
            "method": {"values_from": [f["name"] for f in files],
                       "ranges": "none published for these research assays"}}
    return make_snapshot(id="osdr_cytokines", adapter=ADAPTER_ID,
                         title="Inspiration4 crew serum cytokines, Eve HD71 + HDCVD9 (OSD-575)",
                         source=source(st, files), retrieved_at=ctx.retrieved_at, coverage=coverage(tps),
                         freshness={"kind": "historical", "stale_after": None}, provenance="measured",
                         caveats=caveats, data=data)


URINE_SUBMITTED = "LSDS-64_Multiplex_urine.immune.AlamarPanel_SUBMITTED.xlsx"
URINE_TRANSFORMED = "LSDS-64_Multiplex_urine.immune.AlamarPanel_TRANSFORMED.csv"
URINE_TARGETS = "LSDS-64_Multiplex_200plex v1-Target Information.csv"


def build_urine(ctx: RunContext) -> dict:
    st = study(ctx, "656")
    sub_bytes, sub_info = fetch_file(ctx, st, URINE_SUBMITTED, binary=True)
    tr_text, tr_info = fetch_file(ctx, st, URINE_TRANSFORMED)
    tgt_text, tgt_info = fetch_file(ctx, st, URINE_TARGETS)
    submitted = parse_nulisa_submitted(read_sheet(sub_bytes))
    p = parse_nulisa(tr_text)
    info = parse_target_info(tgt_text)
    xc = cross_check_nulisa(submitted, p)
    present = {st_ for vals in submitted.values() for st_ in vals}
    tps = ordered({tp for _, tp in present}, st)
    labels = [t["label"] for t in tps]
    subjects = sorted({s for s, _ in present})
    absent = [f"{s} {t}" for s in subjects for t in labels if (s, t) not in present]
    out, zeros = [], []
    for name, raw in submitted.items():
        k = slug(name)
        ti = info.get(k, {})
        vals = {s: {t: round_npq(raw.get((s, t))) for t in labels} for s in subjects}
        raw_by_sample = {s: {t: raw.get((s, t)) for t in labels} for s in subjects}
        n_zero = sum(v == 0 for per in vals.values() for v in per.values())
        n_present = sum(v is not None for per in vals.values() for v in per.values())
        if n_zero:
            zeros.append(f"{name} {n_zero}/{n_present}")
        out.append({"key": "nulisa_urine_" + k, "label": ti.get("name") or name,
                    "protein": ti.get("protein") or None,
                    "gene": ti.get("gene") or None, "uniprot": ti.get("uniprot") or None,
                    "unit": "NPQ (log2)", "panel": "Alamar NULISA-seq 200plex v1 Inflammation Panel (urine)",
                    "reported_as": name, "values": vals, "ranges": None, "within_own_range": None,
                    "n_exact_zero": n_zero, "exact_repeats": exact_repeats(raw_by_sample)})
    unmatched = [a["reported_as"] for a in out if slug(a["reported_as"]) not in info]
    reps = [f"{a['label']} {r['value']} x{r['n']}" for a in out for r in a["exact_repeats"]]
    caveats = common_caveats(tps, has_ranges=False) + [
        "OSD-656 is a urine INFLAMMATION-PROTEIN panel (NULISA-seq), not a urinalysis: there is NO "
        "urinary calcium, volume, pH, oxalate, citrate or creatinine. It cannot feed the bone -> "
        "renal-stone / hydration case; that case needs crew-entered urine volume, not this file.",
        "Unit NPQ = NULISA Protein Quantification: log2 of IPC-normalised sequencing counts (definition "
        "quoted from the OSDR assay metadata). Relative units: compare a target only with itself "
        "(within a subject over time); not a concentration, no reference range.",
        "Urine was collected at 6 timepoints (no R+194). Samples absent from BOTH the submitted and the "
        "TRANSFORMED file: " + (", ".join(absent) if absent else "none") + ".",
        "Values come from the OSDR 'Original Submitted' laboratory sheet (" + URINE_SUBMITTED + "); every "
        f"value was cross-checked against the ALSDA TRANSFORMED CSV ({xc['compared_values']} values, "
        f"{len(xc['mismatches'])} disagreements).",
        "The 'Percent_normalized_value' / '<target>_percent_normalized_value' columns are not included "
        "(normalisation basis not documented in the files fetched).",
        f"Size budget: NPQ values are rounded half-to-even to {NPQ_DECIMALS} decimals (published with up "
        "to 15-17 significant digits); 0.001 log2 units is a ~0.07% relative change. The sha256 of each "
        "source file is in data.study.files for exact verification.",
    ]
    if zeros:
        caveats.append(
            f"Exact-zero NPQ values ({sum(a['n_exact_zero'] for a in out)} values in {len(zeros)} targets) are "
            "reproduced as published. The files fetched state no limit of detection, and no NPQ below 0 "
            "occurs, so 0 is the floor of this log2-count scale: show it as 'at assay floor / not "
            "detected', not as a level, and do not use it as a baseline for change scores. Per target "
            "(zeros/samples): " + ", ".join(zeros) + ".")
    if reps:
        caveats.append("Exact repeats of a multi-digit NPQ across samples (>= 4 significant digits in >= 3 "
                       "samples) are listed per analyte in exact_repeats: " + "; ".join(reps))
    caveats += ["ALSDA TRANSFORMED CSV header defects (the TRANSFORMED file is used only as a cross-check): "
                + " ".join(p["defects"] + xc["header_findings"])] if (p["defects"] or xc["header_findings"]) else []
    if xc["mismatches"]:
        caveats.append(f"Cross-check found {len(xc['mismatches'])} disagreement(s) between the submitted and "
                       "the TRANSFORMED file; values shown are the submitted ones: " + "; ".join(xc["mismatches"][:20]))
    if xc["samples_only_in_one_file"]:
        caveats.append("Samples present in only one of the two files: " + ", ".join(xc["samples_only_in_one_file"]))
    if p["non_finite_npq"]:
        caveats.append("Non-finite NPQ values in the TRANSFORMED file: " + ", ".join(p["non_finite_npq"]))
    if unmatched:
        caveats.append(f"No target-information match (label falls back to the reported name) for: {unmatched}")
    files = [sub_info, tr_info, tgt_info]
    data = {"study": study_payload(st, files), "subjects": subjects, "timepoints": tps, "analytes": out,
            "dropped_targets": [], "absent_samples": absent,
            "method": {"values_from": URINE_SUBMITTED + " (OSDR 'Original Submitted'; column 'Concentration', "
                                      f"unit NPQ; rounded to {NPQ_DECIMALS} decimals)",
                       "cross_checked_against": URINE_TRANSFORMED + " (OSDR 'ALSDA Transformed Files')",
                       "labels_from": URINE_TARGETS + " ('Target' without ', Human'; protein, gene, UniProt)",
                       "ranges": "none published",
                       "n_exact_zero": "count of values exactly 0 NPQ (assay floor) per target",
                       "exact_repeats": "multi-digit values recurring in >= 3 samples of one target"},
            "cross_check": xc}
    return make_snapshot(id="osdr_urine", adapter=ADAPTER_ID,
                         title="Inspiration4 crew urine inflammation proteins, NULISA-seq (OSD-656) - no urine chemistry",
                         source=source(st, files), retrieved_at=ctx.retrieved_at, coverage=coverage(tps),
                         freshness={"kind": "historical", "stale_after": None}, provenance="measured",
                         caveats=caveats, data=data)


def run(ctx: RunContext) -> list[dict]:
    return [build_cmp(ctx), build_cbc(ctx), build_cytokines(ctx), build_urine(ctx)]
