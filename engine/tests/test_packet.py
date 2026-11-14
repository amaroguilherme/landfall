import json
import re
from pathlib import Path

import pytest

from engine import EngineError, build_ground_packet, case_reduce, new_case

FIX = json.loads((Path(__file__).parent / "fixtures" / "engine_fixtures.json").read_text(encoding="utf-8"))
EPOCH = FIX["mission_epoch"]
T0 = 412 * 86400 + 14 * 3600 + 20 * 60
LOCAL = "https://landfall.dev/fhir/CodeSystem/landfall"
UCUM = "http://unitsofmeasure.org"
# Verified 2026-11-14 against https://hl7.org/fhir/R4/observation-vitalsigns.html
VITAL_LOINC = {"8867-4", "9279-1", "2708-6", "8310-5", "8302-2", "9843-4", "29463-7", "39156-5",
               "85354-9", "85353-1"}
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
FHIR_ID_RE = re.compile(r"^[A-Za-z0-9\-.]{1,64}$")

STATE = case_reduce(new_case(FIX["case"], "CM-1"),
                    {"type": "OPEN", "finding": {"rule_id": "pvt_lapses", "severity": "caution"}, "t": T0})
OBS = [
    {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 6, "unit": "count", "t": T0 + 500, "provenance": "simulated"},
    {"crew_id": "CM-1", "variable": "resting_hr", "value": 58, "unit": "bpm", "t": T0 + 400, "source": "band"},
    {"crew_id": "CM-1", "variable": "mood", "value": 2, "unit": "score_1_5", "t": T0 + 400},
    {"crew_id": "CM-1", "variable": "skin_temp", "value": 33.2, "unit": "°C", "t": T0 + 400},
    {"crew_id": "CM-1", "variable": "sleep_duration", "value": 5.1, "unit": "h", "t": T0 + 300},
    {"crew_id": "CM-2", "variable": "resting_hr", "value": 61, "unit": "bpm", "t": T0 + 400},
    {"crew_id": "CM-1", "variable": "urine_volume_24h", "value": 1480, "unit": "mL", "t": T0 + 400},
    {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 7, "unit": "count", "t": T0 + 99999},
]


def packet(consent, observations=OBS, t=T0 + 1000):
    return build_ground_packet(STATE, observations, consent, "mars_surface", t, EPOCH)


def codes(bundle):
    return [e["resource"]["code"]["coding"][0]["code"] for e in bundle["entry"]]


def test_bundle_is_fhir_r4_collection_of_observations():
    b = packet({})
    assert b["resourceType"] == "Bundle" and b["type"] == "collection"
    assert DATETIME_RE.match(b["timestamp"]) and FHIR_ID_RE.match(b["id"])
    assert b["entry"], "packet should not be empty"
    ids = set()
    for e in b["entry"]:
        o = e["resource"]
        assert o["resourceType"] == "Observation"
        assert o["status"] in ("registered", "preliminary", "final", "amended")
        assert FHIR_ID_RE.match(o["id"]) and o["id"] not in ids
        ids.add(o["id"])
        coding = o["code"]["coding"]
        assert len(coding) >= 1 and all({"system", "code", "display"} <= set(c) for c in coding)
        q = o["valueQuantity"]
        assert isinstance(q["value"], (int, float)) and q["system"] == UCUM and q["code"] and q["unit"]
        assert DATETIME_RE.match(o["effectiveDateTime"])
        assert o["subject"]["identifier"]["value"] == "CM-1"
        if coding[0]["system"] == "http://loinc.org":
            assert coding[0]["code"] in VITAL_LOINC  # no invented LOINC codes
            assert o["category"][0]["coding"][0]["code"] == "vital-signs"
            assert o["meta"]["profile"] == ["http://hl7.org/fhir/StructureDefinition/vitalsigns"]
        else:
            assert coding[0]["system"] == LOCAL


def test_vital_signs_use_profile_loinc_and_everything_else_local():
    b = packet({})
    by_text = {e["resource"]["code"]["text"]: e["resource"] for e in b["entry"]}
    hr = by_text["Heart rate"]
    assert hr["code"]["coding"][0] == {"system": "http://loinc.org", "code": "8867-4", "display": "Heart rate"}
    assert hr["valueQuantity"] == {"value": 58, "unit": "beats/minute", "system": UCUM, "code": "/min"}
    skin = by_text["Skin temperature"]  # a skin probe is not LOINC 8310-5 body temperature
    assert skin["code"]["coding"][0]["system"] == LOCAL and skin["valueQuantity"]["code"] == "Cel"
    pvt = by_text["PVT-B lapses"]
    assert pvt["valueQuantity"]["code"] == "{count}"
    assert {"system": LOCAL, "code": "provenance-simulated"} in pvt["meta"]["tag"]


def test_mood_excluded_unless_consent_mood_true():
    assert "mood" not in codes(packet({}))
    assert "mood" not in codes(packet({"mood": False}))
    assert "mood" not in codes(packet({"mood": "yes"}))  # only boolean true is consent
    assert "mood" not in codes(packet({"mood": 1}))
    assert "mood" in codes(packet({"mood": True}))


def test_scope_crew_time_and_withheld_variables():
    c = codes(packet({}))
    assert "urine_volume_24h" not in c          # not in this case's escalation.observations
    assert c.count("8867-4") == 1               # CM-2's heart rate is not in CM-1's packet
    assert c.count("pvt_lapses") == 1           # the observation after packet t is excluded
    assert "8867-4" not in codes(packet({"resting_hr": False}))
    # sorted by (t, variable): sleep (T0+300), then T0+400 group alphabetical, then pvt (T0+500)
    assert c == ["sleep_duration", "8867-4", "skin_temp", "pvt_lapses"]


def test_effective_datetime_from_mission_epoch():
    b = packet({}, observations=[OBS[1]])
    # T0 + 400 = 412 d 14:26:40 after 2035-01-01T00:00:00Z -> 2036-02-17T14:26:40Z
    assert b["entry"][0]["resource"]["effectiveDateTime"] == "2036-02-17T14:26:40Z"


def test_packet_errors():
    with pytest.raises(EngineError) as e:
        packet({}, observations=[dict(OBS[1], unit="beats")])
    assert e.value.code == "unit_mismatch"
    with pytest.raises(EngineError) as e:
        packet({}, observations=[dict(OBS[0], unit="lapses")])
    assert e.value.code == "unknown_unit"
    with pytest.raises(EngineError):
        build_ground_packet(STATE, OBS, {}, "mars_surface", T0, "2035-01-01")


def test_boolean_and_met_values_and_dose_units():
    state = dict(STATE, spec=dict(STATE["spec"], escalation={
        "ground_packet": True, "observations": ["renal_symptoms", "shelter_entry", "dose_bfo"]}))
    obs = [
        {"crew_id": "CM-1", "variable": "renal_symptoms", "value": True, "unit": "yes/no", "t": T0 + 100},
        {"crew_id": "CM-1", "variable": "shelter_entry", "value": T0 + 150, "unit": "MET", "t": T0 + 160},
        {"crew_id": "CM-1", "variable": "dose_bfo", "value": 12.5, "unit": "mGy-Eq", "t": T0 + 170},
    ]
    b = build_ground_packet(state, obs, {}, "mars_surface", T0 + 1000, EPOCH)
    r = [e["resource"] for e in b["entry"]]
    assert r[0]["valueBoolean"] is True and "valueQuantity" not in r[0]
    assert r[1]["valueDateTime"] == "2036-02-17T14:22:30Z"  # T0 + 150 s
    assert r[2]["valueQuantity"] == {"value": 12.5, "unit": "mGy-Eq", "system": UCUM, "code": "mGy{Eq}"}
    with pytest.raises(EngineError):
        build_ground_packet(state, [dict(obs[0], value=2)], {}, "mars_surface", T0 + 1000, EPOCH)


def test_vehicle_observations_are_included_tagged_and_ids_stay_unique():
    state = dict(STATE, spec=dict(STATE["spec"], escalation={"ground_packet": True,
                                                             "observations": ["proton_flux_10mev", "pvt_lapses"]}))
    obs = [{"crew_id": None, "variable": "proton_flux_10mev", "value": 1100.0, "unit": "pfu", "t": T0 + 10,
            "source": "replay", "provenance": "simulated"},
           {"crew_id": "CM-2", "variable": "pvt_lapses", "value": 9, "unit": "count", "t": T0 + 10},
           {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 6, "unit": "count", "t": T0 + 10},
           {"crew_id": "CM-1", "variable": "pvt_lapses", "value": 5, "unit": "count", "t": T0 + 10}]
    b = build_ground_packet(state, obs, {}, "mars_surface", T0 + 20, EPOCH)
    res = [e["resource"] for e in b["entry"]]
    assert [r["code"]["coding"][0]["code"] for r in res] == ["proton_flux_10mev", "pvt_lapses", "pvt_lapses"]
    assert {"system": LOCAL, "code": "scope-vehicle"} in res[0]["meta"]["tag"]
    assert all({"system": LOCAL, "code": "scope-vehicle"} not in r.get("meta", {}).get("tag", []) for r in res[1:])
    assert [r["valueQuantity"]["value"] for r in res[1:]] == [6, 5]       # CM-2's 9 excluded
    assert len({r["id"] for r in res}) == 3 and all(FHIR_ID_RE.match(r["id"]) for r in res)
    assert all(r["subject"]["type"] == "Patient" for r in res)           # vitalsigns: Reference(Patient)
