"""`history` adapter: the Shuttle flight that was in orbit during the October 1989 replay.

    uv run python -m ingest history
    uv run python -m ingest history --offline

Snapshot history_sts34 (provenance "reference"). Modelled on ingest/_horizons_published.py: a
short list of verbatim quotes that is re-fetched at build time, and the run FAILS if any quote is
no longer in its source, so an unverified quote can never ship. Two sources:

  * NASA's STS-34 mission page (launch, landing, duration, orbit, orbiter, crew).
  * The PubMed record of Golightly MJ, Hardy AC, Atwell W, Hardy K, Adv Space Res 1992 (PMID
    11537026), fetched through NCBI E-utilities efetch: the abstract's sentences on the SPEs
    during STS-28 and STS-34. Title, journal, authors and DOI are read from the record.

Launch and landing are converted to UTC from the page's own zone labels (EDT = UTC-4,
PDT = UTC-7), and the conversion is checked against the page's printed mission duration.

What this snapshot must never be used for: the abstract's 30 microGy is the maximum crew dose
attributed to an SPE over STS-28 and STS-34 together; it is not STS-34's dose, and LANDFALL
compares it with nothing (no ratio, no conversion).
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

from ingest._horizons_core import normalise_text, quote_in_page
from ingest.common import RunContext, make_snapshot, sha256_hex, to_iso_z

ADAPTER_ID = "history"
SNAPSHOT_ID = "history_sts34"

NASA_URL = "https://www.nasa.gov/mission/sts-34/"
PMID = "11537026"
EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
EFETCH_PARAMS = {"db": "pubmed", "id": PMID, "retmode": "xml"}
PUBMED_URL = f"https://pubmed.ncbi.nlm.nih.gov/{PMID}/"
EXPECTED_DOI = "10.1016/0273-1177(92)90125-H"
_MIN_PAGE_CHARS = 20_000   # the NASA page is ~337 kB; a short body is a bot challenge or a stub

# Verbatim on https://www.nasa.gov/mission/sts-34/ (read in the raw page HTML on 2026-11-14).
NASA_QUOTES: list[dict] = [
    {"id": "launch", "text": "Launched: October 18, 1989, 12:53:40 p.m. EDT"},
    {"id": "landing", "text": "Landing: October 23, 1989, 9:33:01 a.m. PDT"},
    {"id": "duration", "text": "Mission Duration: 4 days, 23 hours, 39 minutes, 21 seconds"},
    {"id": "altitude", "text": "Orbit Altitude: 185 nautical miles"},
    {"id": "inclination", "text": "Orbit Inclination: 34.3 degrees"},
    {"id": "orbiter", "text": "Space Shuttle: Atlantis"},
    {"id": "payload", "text": "Mission: Galileo; Shuttle Solar Backscatter Ultraviolet Experiment"},
    {"id": "crew", "text": "These five astronauts were assigned to fly the Space Shuttle Atlantis for the "
                           "mission on which the Jupiter probe, Galileo was deployed."},
]
NASA_CREW: list[str] = [
    "Donald E. Williams, Commander",
    "Michael J. McCulley, Pilot",
    "Shannon W. Lucid, Ph.D., Mission Specialist",
    "Franklin Chang-Diaz, Ph.D., Mission Specialist",
    "Ellen S. Baker, M.D., Mission Specialist",
]
# Verbatim in the AbstractText of the PubMed record (efetch, retmode=xml), read on 2026-11-14.
ABSTRACT_QUOTES: list[dict] = [
    {"id": "events", "text": "Since STS-26, three large solar events have occurred during Shuttle missions; a "
                             "geomagnetic storm during STS-29 and solar particle events (SPEs) during STS-28 "
                             "and -34."},
    {"id": "max_dose", "text": "The maximum dose to a crew attributed to an SPE was estimated to be 30 microGy "
                               "(70 microSv)."},
    {"id": "factors", "text": "dose from an SPE is strongly dependent on numerous factors such as orbit "
                              "inclination, SPE start time, spectral parameters and geomagnetic field conditions"},
]

# The page's own zone labels. Only these two may appear: anything else fails the run.
ZONE_OFFSET_H = {"EDT": -4, "PDT": -7}
_MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August", "September",
     "October", "November", "December"], start=1)}
_LOCAL_RE = re.compile(r"(?P<mon>[A-Z][a-z]+) (?P<d>\d{1,2}), (?P<y>\d{4}), (?P<h>\d{1,2}):(?P<mi>\d{2}):(?P<s>\d{2}) "
                       r"(?P<ap>[ap])\.m\. (?P<z>[A-Z]{3})$")
_DURATION_RE = re.compile(r"(\d+) days, (\d+) hours, (\d+) minutes, (\d+) seconds$")


# ---------------------------------------------------------------- pure helpers (tested)
def local_to_utc(s: str) -> datetime:
    """'October 18, 1989, 12:53:40 p.m. EDT' -> 1989-10-18 16:53:40 UTC (12-hour clock)."""
    m = _LOCAL_RE.search(normalise_text(s))
    if not m or m["mon"] not in _MONTHS or m["z"] not in ZONE_OFFSET_H:
        raise ValueError(f"not a NASA local time with a known zone: {s!r}")
    h = int(m["h"])
    if not 1 <= h <= 12:
        raise ValueError(f"12-hour clock expected: {s!r}")
    h = h % 12 + (12 if m["ap"] == "p" else 0)
    local = datetime(int(m["y"]), _MONTHS[m["mon"]], int(m["d"]), h, int(m["mi"]), int(m["s"]))
    return (local - timedelta(hours=ZONE_OFFSET_H[m["z"]])).replace(tzinfo=timezone.utc)


def parse_duration(s: str) -> timedelta:
    m = _DURATION_RE.search(normalise_text(s))
    if not m:
        raise ValueError(f"not a mission duration: {s!r}")
    d, h, mi, sec = (int(x) for x in m.groups())
    return timedelta(days=d, hours=h, minutes=mi, seconds=sec)


def check_quotes(quotes: list[dict], page_html: str, where: str) -> None:
    """Raise unless every quote is in the page (whitespace and quote marks normalised)."""
    missing = [q["id"] for q in quotes if not quote_in_page(q["text"], page_html)]
    if missing:
        raise RuntimeError(f"quotes no longer found in {where}: {missing}; re-read the source")


def parse_pubmed(xml_text: str) -> dict:
    """Title, journal, authors, DOI and abstract from a PubMed efetch record."""
    root = ET.fromstring(xml_text)
    art = root.find(".//PubmedArticle/MedlineCitation/Article")
    if art is None or root.findtext(".//PubmedArticle/MedlineCitation/PMID") != PMID:
        raise RuntimeError(f"efetch did not return PMID {PMID}")
    abstract = " ".join(normalise_text("".join(a.itertext())) for a in art.findall("Abstract/AbstractText"))
    authors = [f"{a.findtext('LastName')} {a.findtext('Initials')}".strip()
               for a in art.findall("AuthorList/Author") if a.findtext("LastName")]
    doi = next((x.text for x in root.findall(".//PubmedData/ArticleIdList/ArticleId")
                if x.get("IdType") == "doi" and x.text), None)
    j = art.find("Journal")
    return {
        "pmid": PMID,
        "title": normalise_text(art.findtext("ArticleTitle") or ""),
        "journal": j.findtext("ISOAbbreviation") if j is not None else None,
        "volume": j.findtext("JournalIssue/Volume") if j is not None else None,
        "issue": j.findtext("JournalIssue/Issue") if j is not None else None,
        "year": j.findtext("JournalIssue/PubDate/Year") if j is not None else None,
        "pages": art.findtext("Pagination/MedlinePgn"),
        "authors": authors,
        "first_author_affiliation": art.findtext("AuthorList/Author/AffiliationInfo/Affiliation"),
        "doi": doi,
        "abstract": abstract,
    }


# ---------------------------------------------------------------- snapshot
def build(ctx: RunContext) -> dict:
    page = ctx.fetch_text(NASA_URL)     # a failed fetch raises: stop and report, never guess
    if len(page) < _MIN_PAGE_CHARS:
        raise RuntimeError(f"{NASA_URL}: body only {len(page)} chars (bot challenge or stub)")
    check_quotes(NASA_QUOTES, page, NASA_URL)
    check_quotes([{"id": c, "text": c} for c in NASA_CREW], page, NASA_URL)
    q = {x["id"]: x["text"] for x in NASA_QUOTES}
    launch = local_to_utc(q["launch"].split(": ", 1)[1])
    landing = local_to_utc(q["landing"].split(": ", 1)[1])
    duration = parse_duration(q["duration"])
    if landing - launch != duration:
        raise RuntimeError(f"UTC conversion check failed: landing - launch = {landing - launch}, "
                           f"page duration {duration}")
    alt = re.search(r"(\d+(?:\.\d+)?) nautical miles$", q["altitude"])
    inc = re.search(r"(\d+(?:\.\d+)?) degrees$", q["inclination"])

    xml_text = ctx.fetch_text(EFETCH_URL, EFETCH_PARAMS)
    pm = parse_pubmed(xml_text)
    missing = [a["id"] for a in ABSTRACT_QUOTES if normalise_text(a["text"]) not in pm["abstract"]]
    if missing:
        raise RuntimeError(f"abstract quotes no longer found in PMID {PMID}: {missing}; re-read the record")
    if (pm["doi"] or "").upper() != EXPECTED_DOI.upper():
        raise RuntimeError(f"PMID {PMID} DOI is {pm['doi']!r}, expected {EXPECTED_DOI}")
    if len(pm["authors"]) < 1 or not pm["title"]:
        raise RuntimeError(f"PMID {PMID}: title or authors missing")

    authors = ", ".join(pm["authors"])
    golightly_citation = (f"{authors}. {pm['title'].rstrip('.')}. {pm['journal']} {pm['year']};{pm['volume']}"
                          f"({pm['issue']}):{pm['pages']}. doi:{EXPECTED_DOI}. PMID {PMID}.")
    data = {
        "mission": "STS-34",
        "use_note": "The abstract's 30 microGy is the maximum crew dose attributed to an SPE over STS-28 and "
                    "STS-34 together, as the abstract states; it is not STS-34's dose. LANDFALL compares it "
                    "with nothing.",
        "flight": {
            "orbiter": q["orbiter"].split(": ", 1)[1],
            "payload": q["payload"].split(": ", 1)[1],
            "launch_local": q["launch"].split(": ", 1)[1],
            "landing_local": q["landing"].split(": ", 1)[1],
            "launch_utc": to_iso_z(launch),
            "landing_utc": to_iso_z(landing),
            "duration_s": int(duration.total_seconds()),
            "duration_printed": q["duration"].split(": ", 1)[1],
            "utc_conversion": {"offsets_h": dict(ZONE_OFFSET_H),
                               "basis": "the page's own zone labels (EDT = UTC-4, PDT = UTC-7)",
                               "check": "landing minus launch, in UTC, equals the page's Mission Duration"},
            "orbit_altitude_nmi": float(alt[1]) if alt else None,
            "orbit_inclination_deg": float(inc[1]) if inc else None,
            "crew": list(NASA_CREW),
            "crew_count": len(NASA_CREW),
        },
        "nasa_page": {"url": NASA_URL, "sha256": sha256_hex(page.encode("utf-8")),
                      "quotes": [{**x, "verified_this_build": True} for x in NASA_QUOTES]
                      + [{"id": f"crew_{i + 1}", "text": c, "verified_this_build": True} for i, c in enumerate(NASA_CREW)]},
        "golightly_1992": {
            **{k: pm[k] for k in ("pmid", "title", "journal", "volume", "issue", "year", "pages", "authors",
                                  "first_author_affiliation")},
            "doi": EXPECTED_DOI, "pubmed_url": PUBMED_URL,
            "efetch_url": f"{EFETCH_URL}?db=pubmed&id={PMID}&retmode=xml",
            "citation": golightly_citation,
            "quotes": [{**a, "verified_this_build": True} for a in ABSTRACT_QUOTES],
        },
        "quote_check": "every quote is re-found in its source on each build (whitespace and quote marks "
                       "normalised); the run fails if one is missing",
    }
    return make_snapshot(
        id=SNAPSHOT_ID, adapter=ADAPTER_ID,
        title="STS-34 (Atlantis, October 1989): in orbit during the replayed solar proton event",
        source={
            "publisher": "NASA (STS-34 mission page) and the U.S. National Library of Medicine (PubMed)",
            "name": "NASA STS-34 mission facts; abstract of Golightly et al. 1992, PMID 11537026",
            "url": NASA_URL,
            "access_urls": [NASA_URL, f"{EFETCH_URL}?db=pubmed&id={PMID}&retmode=xml"],
            "license": "NASA mission page: U.S. Government work (NASA). Abstract: three sentences quoted for "
                       "citation from the PubMed record (NCBI E-utilities). No license text was fetched by this "
                       "adapter.",
            "citation": f"NASA. STS-34 (mission page). {NASA_URL} (retrieved {ctx.retrieved_at}). "
                        f"{golightly_citation}",
        },
        retrieved_at=ctx.retrieved_at,
        coverage={"start": to_iso_z(launch), "stop": to_iso_z(landing), "cadence": None},
        freshness={"kind": "reference", "stale_after": None},
        provenance="reference",
        caveats=[
            "Launch and landing are converted to UTC from the page's own zone labels (EDT = UTC-4, PDT = UTC-7); "
            "the conversion reproduces the page's printed mission duration to the second.",
            "The abstract's maximum crew dose attributed to an SPE covers the SPEs during STS-28 and STS-34 "
            "together; it is not STS-34's own dose and is compared with nothing here.",
            "A low-inclination orbit inside Earth's magnetosphere is a different radiation environment from "
            "interplanetary space or the surface of Mars: this record is history and context, not a dose basis.",
        ],
        data=data)


def run(ctx: RunContext) -> list[dict]:
    return [build(ctx)]
