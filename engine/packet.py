"""Delay-tolerant ground packet: a FHIR R4 Bundle (type "collection") of Observations.

Vital signs use the LOINC "magic values" and UCUM codes of the FHIR R4 vital-signs profile,
verified on 2026-11-14 against https://hl7.org/fhir/R4/observation-vitalsigns.html (profile
table) and the R4 examples observation-example-heart-rate.json, -respiratory-rate.json,
-satO2.json and -body-temperature.json. Everything else uses the local CodeSystem
https://landfall.dev/fhir/CodeSystem/landfall with our variable id as the code. No LOINC code is
assigned to anything outside that table.

Skin temperature is deliberately NOT coded as LOINC 8310-5 "Body temperature": a skin probe is
not a body (core) temperature.
"""

from __future__ import annotations

from .errors import EngineError
from .fmt import is_number, met_to_iso, parse_epoch, require_number

LOCAL_CS = "https://landfall.dev/fhir/CodeSystem/landfall"
CREW_ID_SYSTEM = "https://landfall.dev/fhir/NamingSystem/crew-id"
LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"
OBS_CATEGORY_CS = "http://terminology.hl7.org/CodeSystem/observation-category"
VITALSIGNS_PROFILE = "http://hl7.org/fhir/StructureDefinition/vitalsigns"

# variable -> (LOINC code, LOINC display, required unit, UCUM code, display unit)
VITAL_SIGNS = {
    "resting_hr": ("8867-4", "Heart rate", "bpm", "/min", "beats/minute"),
    "heart_rate": ("8867-4", "Heart rate", "bpm", "/min", "beats/minute"),
    "respiratory_rate": ("9279-1", "Respiratory rate", "breaths/min", "/min", "breaths/minute"),
    "spo2": ("2708-6", "Oxygen saturation in Arterial blood", "%", "%", "%"),
    "body_temperature": ("8310-5", "Body temperature", "°C", "Cel", "°C"),
    "body_weight": ("29463-7", "Body weight", "kg", "kg", "kg"),
}

# LANDFALL unit string -> UCUM code. Annotations ({...}) are valid UCUM for unitless counts/scores.
UCUM_CODES = {
    "count": "{count}",
    "ms": "ms",
    "h": "h",
    "min": "min",
    "s": "s",
    "lux": "lx",
    "bpm": "/min",
    "°C": "Cel",
    "mL": "mL",
    "L": "L",
    "mL/day": "mL/d",
    "score_1_5": "{score}",
    "mSv": "mSv",
    "mGy": "mGy",
    # UCUM has no "Gy-Eq": the {Eq} annotation keeps the unit valid UCUM (= mGy) while the
    # display unit keeps NASA's mGy-Eq (Table 4.8-1). This is our representation, not NASA's.
    "mGy-Eq": "mGy{Eq}",
    "mSv/day": "mSv/d",
    "mGy/day": "mGy/d",
    "µGy/day": "uGy/d",
    "mmHg": "mm[Hg]",
    "mg/dL": "mg/dL",
    "ml/min/kg": "mL/min/kg",
    "%": "%",
    "% of pre-mission": "%",
    "kg": "kg",
    "ratio": "1",
    "pfu": "cm-2.s-1.sr-1",
}

# Display text for local codes (fallback: the variable id itself).
LOCAL_DISPLAY = {
    "pvt_lapses": "PVT-B lapses",
    "pvt_median_rt": "PVT-B median reaction time",
    "sleep_duration": "Sleep duration (actigraphy)",
    "sleep_midpoint_shift": "Sleep midpoint shift",
    "light_exposure_daytime": "Daytime light exposure",
    "hrv_sdnn": "Heart rate variability, SDNN",
    "skin_temp": "Skin temperature",
    "urine_volume_24h": "Urine volume, 24 h",
    "fluid_intake_24h": "Fluid intake, 24 h",
    "mood": "Mood self-rating (1-5)",
    "proton_flux_10mev": "Proton flux ≥10 MeV",
    "career_effective_dose": "Career effective dose",
    "vo2max": "VO2max",
    "cabin_ppco2": "Cabin ppCO2",
    "renal_symptoms": "Renal symptoms reported (yes/no)",
    "shelter_entry": "Storm shelter entry time",
    "dose_bfo": "Blood-forming organs dose",
    "dose_skin": "Skin dose",
    "dose_lens": "Lens dose",
    # cuff and glucometer readings are local codes: the FHIR R4 blood-pressure vital sign is a panel
    # (systolic and diastolic as components), not two single-value Observations
    "bp_systolic": "Systolic blood pressure (cuff, manual entry)",
    "bp_diastolic": "Diastolic blood pressure (cuff, manual entry)",
    "glucose": "Blood glucose (fingerstick, manual entry)",
}

# Variables that need an explicit consent[var] === true (mirrors private: true in personal.json).
PRIVATE_VARIABLES = ("mood",)

# Units that are not quantities: a yes/no answer becomes valueBoolean (value true/false or 1/0),
# a MET time stamp (e.g. shelter entry) becomes valueDateTime via the mission epoch.
BOOLEAN_UNITS = ("yes/no",)
MET_UNITS = ("MET",)


def _fhir_id(*parts: object, suffix: str = "") -> str:
    """FHIR id: [A-Za-z0-9-.]{1,64}. Underscores and other characters become '-'.

    The base is truncated so that `suffix` (used to keep ids unique) always survives.
    """
    raw = "-".join(str(p) for p in parts)
    out = "".join(c if (c.isascii() and (c.isalnum() or c in "-.")) else "-" for c in raw)
    return out[:64 - len(suffix)] + suffix


def consent_allows(variable: str, consent: dict) -> bool:
    """Private variables need consent[var] is True; others are shared unless consent[var] is False."""
    if variable in PRIVATE_VARIABLES:
        return consent.get(variable) is True
    return consent.get(variable) is not False


def _observation(o: dict, crew_id: str, mission_epoch: str, rid: str) -> dict:
    var, unit, value = o["variable"], o.get("unit"), o["value"]
    vs = VITAL_SIGNS.get(var)
    res: dict = {"resourceType": "Observation", "id": rid}
    tags = []
    if isinstance(o.get("provenance"), str):
        tags.append({"system": LOCAL_CS, "code": "provenance-" + o["provenance"]})
    if isinstance(o.get("source"), str):
        tags.append({"system": LOCAL_CS, "code": "source-" + o["source"]})
    if o.get("crew_id") is None:
        # vehicle / habitat sensor (crew_id null): placed in this crewmember's packet as exposure
        # context, but it is a reading of the shared environment, not of the crewmember
        tags.append({"system": LOCAL_CS, "code": "scope-vehicle"})
    meta: dict = {}
    if vs is not None:
        code, display, req_unit, ucum, unit_display = vs
        if unit != req_unit:
            raise EngineError("unit_mismatch", f"{var}: vital-sign unit must be {req_unit!r}, got {unit!r}")
        meta["profile"] = [VITALSIGNS_PROFILE]
        res["status"] = "final"
        res["category"] = [{"coding": [{"system": OBS_CATEGORY_CS, "code": "vital-signs",
                                        "display": "Vital Signs"}], "text": "Vital Signs"}]
        res["code"] = {"coding": [{"system": LOINC, "code": code, "display": display}], "text": display}
        qty = {"value": value, "unit": unit_display, "system": UCUM, "code": ucum}
    else:
        display = LOCAL_DISPLAY.get(var, var)
        res["status"] = "final"
        res["code"] = {"coding": [{"system": LOCAL_CS, "code": var, "display": display}], "text": display}
        if unit in BOOLEAN_UNITS:
            qty = None
        elif unit in MET_UNITS:
            qty = None
        elif unit in UCUM_CODES:
            qty = {"value": value, "unit": unit, "system": UCUM, "code": UCUM_CODES[unit]}
        else:
            raise EngineError("unknown_unit", f"{var}: no UCUM mapping for unit {unit!r}")
    if tags:
        meta["tag"] = tags
    if meta:
        res["meta"] = meta
    # logical reference (no Patient resource: the crew have no PII); the vital-signs profile
    # requires subject 1..1 Reference(Patient), so the target type is stated explicitly
    res["subject"] = {"type": "Patient", "identifier": {"system": CREW_ID_SYSTEM, "value": crew_id},
                      "display": crew_id}
    res["effectiveDateTime"] = met_to_iso(o["t"], mission_epoch)
    if qty is not None:
        res["valueQuantity"] = qty
    elif unit in BOOLEAN_UNITS:
        res["valueBoolean"] = value is True or value == 1
    else:
        res["valueDateTime"] = met_to_iso(value, mission_epoch)
    return res


def build_ground_packet(case_state: dict, observations: list, consent: dict, env_id: str,
                        t: float, mission_epoch: str) -> dict:
    """FHIR R4 Bundle of the crewmember's observations that consent allows.

    Included: observations of case_state.crew_id or with crew_id null (vehicle sensors, tagged
    scope-vehicle), with t <= packet t, whose variable is in
    case_state.spec.escalation.observations (when that list exists), and that consent allows.
    mission_epoch: UTC 'YYYY-MM-DDTHH:MM:SSZ' of MET 0, used to turn MET into effectiveDateTime.
    Entries are sorted by (t, variable) and then input order.
    """
    if not isinstance(case_state, dict) or not isinstance(case_state.get("crew_id"), str):
        raise EngineError("invalid_argument", "case_state with a crew_id is required")
    if not isinstance(observations, list):
        raise EngineError("invalid_argument", "observations must be a list")
    if not isinstance(consent, dict):
        raise EngineError("invalid_argument", "consent must be an object")
    if not isinstance(env_id, str):
        raise EngineError("invalid_argument", "env_id must be a string")
    require_number(t, "t")
    parse_epoch(mission_epoch)
    crew_id = case_state["crew_id"]
    case_id = case_state.get("case_id") or "none"
    esc = (case_state.get("spec") or {}).get("escalation") or {}
    scope = esc.get("observations") if isinstance(esc.get("observations"), list) else None

    picked = []
    for idx, o in enumerate(observations):
        if not isinstance(o, dict) or (o.get("crew_id") is not None and o.get("crew_id") != crew_id):
            continue  # another crewmember's data; crew_id null = vehicle sensor, shared by all
        var = o.get("variable")
        if not isinstance(var, str) or o.get("value") is None:
            continue
        if o.get("unit") in BOOLEAN_UNITS:
            if not (isinstance(o["value"], bool) or (is_number(o["value"]) and o["value"] in (0, 1))):
                raise EngineError("invalid_argument", f"observation {var}: yes/no value must be a boolean or 0/1")
        else:
            require_number(o["value"], f"observation {var} value")
        require_number(o.get("t"), f"observation {var} t")
        if o["t"] > t:
            continue
        if scope is not None and var not in scope:
            continue
        if not consent_allows(var, consent):
            continue
        picked.append((o["t"], var, idx, o))
    picked.sort(key=lambda p: (p[0], p[1], p[2]))

    entries = []
    used: set[str] = set()
    for ot, var, _idx, o in picked:
        rid = _fhir_id(crew_id, var, int(ot))
        n = 1
        while rid in used:  # e.g. two readings in the same second, or ids colliding after '_' -> '-'
            n += 1
            rid = _fhir_id(crew_id, var, int(ot), suffix=f"-{n}")
        used.add(rid)
        entries.append({"resource": _observation(o, crew_id, mission_epoch, rid)})

    status = case_state.get("status") or "none"
    return {
        "resourceType": "Bundle",
        "id": _fhir_id("landfall", case_id, crew_id, int(t)),
        "meta": {"tag": [
            {"system": LOCAL_CS, "code": "ground-packet"},
            {"system": LOCAL_CS, "code": "case-" + case_id},
            {"system": LOCAL_CS, "code": "case-status-" + status},
            {"system": LOCAL_CS, "code": "environment-" + env_id},
        ]},
        "type": "collection",
        "timestamp": met_to_iso(t, mission_epoch),
        "entry": entries,
    }
