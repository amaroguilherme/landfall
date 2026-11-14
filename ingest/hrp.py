"""NASA Human Research Program + CSA official challenge resources -> reference snapshots.

Official resource list of the 2026 challenge (see CITATIONS.md):
  1 https://www.nasa.gov/hrp/hazards/              -> hrp_hazards
  2 https://www.nasa.gov/hrp/risks/                -> hrp_risks (+ each nasa.gov/reference/risk-... page)
  3 https://www.nasa.gov/hrp/ongoing-hrp-research/ -> hrp_research (+ 5 investigation pages)
  4 CSA "Monitoring radiation for astronaut health" -> hrp_csa_radiation
  5 CSA "Why do we conduct science experiments in space?" -> hrp_csa_science
  6 Human Research Roadmap /Explore/ (linked from page 3) -> hrp_roadmap

Rules this module follows:
  * Every text field named *verbatim*/`sentence`/`summary` is copied from the fetched HTML, only
    whitespace-normalised (runs of whitespace -> one space; <br> -> space). Nothing is paraphrased.
  * Curated fields (which sentence to keep, which phrase names a measurement) are selected by
    anchors that MUST occur verbatim in the fetched page; a missing anchor is dropped and reported
    in caveats, never filled in.
  * Risk -> hazard links are only term matches inside NASA's own sentences (method and terms are
    shipped in the snapshot); NASA publishes no formal risk->hazard table on these pages.
"""

from __future__ import annotations

import re
import time
from typing import Any

from bs4 import BeautifulSoup

from ingest.common import RunContext, make_snapshot

ADAPTER_ID = "hrp"

HAZARDS_URL = "https://www.nasa.gov/hrp/hazards/"
RISKS_URL = "https://www.nasa.gov/hrp/risks/"
RESEARCH_URL = "https://www.nasa.gov/hrp/ongoing-hrp-research/"
CSA_RAD_URL = ("https://www.asc-csa.gc.ca/eng/news/articles/2026/"
               "2026-02-26-monitoring-radiation-astronaut-health.asp")
CSA_SCI_URL = "https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp"
CSA_TERMS_URL = "https://www.canada.ca/en/transparency/terms.html"
HRR_EXPLORE_URL = "https://humanresearchroadmap.nasa.gov/Explore/"
HRR_RISK_URL = "https://humanresearchroadmap.nasa.gov/risks/?i={i}"

NASA_LICENSE = ("U.S. Government work (NASA): not subject to copyright in the United States "
                "(17 U.S.C. 105) unless otherwise noted. Quoted verbatim with attribution; "
                "NASA does not endorse LANDFALL.")
CSA_LICENSE = ("Government of Canada / Canadian Space Agency web content, Terms and conditions: "
               f"{CSA_TERMS_URL}. LANDFALL stores only short factual extracts with attribution and "
               "a link to the original page, not the full text.")

# Polite pacing between page fetches (only matters on a cold cache).
_PAUSE_S = 0.5

# ---- curated anchors (each MUST be found verbatim in the live page, else dropped + caveat) ----
HAZARD_KEY_ANCHORS: dict[str, list[str]] = {
    "space_radiation": ["Radiation exposure increases cancer risk"],
    "isolation_and_confinement": ["Sleep loss, circadian desynchronization, and work overload",
                                  "light therapy for circadian alignment"],
    "distance_from_earth": ["communication delay of up to 20 minutes one way"],
    "gravity_fields": ["lose on average 1% to 1.5% of mineral density per month",
                       "increased risk of developing kidney stones"],
    "hostile_closed_environments": ["Stress hormone levels can elevate"],
}

# Hazard ids keyed by the hazard page URL slug (stable) rather than by display name
# (the cards say "Isolation and Confinement", the nav says "Isolation & Confinement").
HAZARD_SLUGS = {
    "hazard-space-radiation": "space_radiation",
    "hazard-isolation-and-confinement": "isolation_and_confinement",
    "hazard-distance-from-earth": "distance_from_earth",
    "hazard-gravity-fields": "gravity_fields",
    "hazard-hostile-closed-environments": "hostile_closed_environments",
}

# Terms used for risk -> hazard *mentions* (shipped in the snapshot so the rule is auditable).
HAZARD_TERMS: dict[str, str] = {
    "space_radiation": r"\bradiation\b",
    "isolation_and_confinement": r"\bisolat\w*|\bconfine\w*",
    "distance_from_earth": r"distance from earth|communication delays?",
    "gravity_fields": r"\b(?:micro|low[- ])?gravity\b|weightless\w*",
    "hostile_closed_environments": r"closed (?:environment|habitat)s?|hostile",
}

# Risks LANDFALL builds cases on / observes (brief item 7). Keyed by risk-page URL slug.
KEY_RISK_SLUGS = {
    "risk-of-spaceflight-induced-bone-changes",
    "risk-from-inadequate-sleep-and-irregular-schedules",
    "risk-of-radiation-induced-cancers",
    "risk-of-altered-immune-system-responses",
    "risk-of-cardiovascular-adaptations",
    "risk-of-behavioral-conditions-and-psychiatric-disorders",
}

CATEGORY_BY_ANCHOR = {
    "Human-Physiology": "physiology",
    "Behavioral-Performance-and-Human-Factors": "behavioral",
    "Space-Radiation": "radiation",
}

# Investigations whose detail page we follow (brief item 3), keyed by their reference-page slug.
DEEP_INVESTIGATIONS = {"archer", "artemis-ii-standard-measures", "immune-biomarkers",
                       "standard-measures", "tempus-pro"}

# Measurement table: (what, with_what or None, when_phrase or None). Every non-None phrase must be
# found verbatim in that investigation's text; `evidence` is the sentence containing `what`.
MEASUREMENT_ANCHORS: dict[str, list[tuple[str, str | None, str | None]]] = {
    "archer": [
        ("actigraphy", None, "Actigraphy data will also be collected during the mission."),
        ("behavioral performance surveys", None, "before and after the mission"),
    ],
    "immune-biomarkers": [
        ("Blood samples", None, "before and after the mission"),
        ("saliva", "special paper stored in pocket-sized booklets",
         "saliva will be collected during the mission as well"),
    ],
    "artemis-ii-standard-measures": [
        ("measurements from blood, saliva, and urine", None, None),
        ("MRIs", None, None),
        ("balance, motion sickness symptoms, vestibular health, muscle performance", None, None),
        ("egressing a capsule and conducting simulated moonwalk activities in a pressurized spacesuit",
         None, "immediately upon return to Earth"),
    ],
    "standard-measures": [
        ("activity and light exposure", "wrist sensor", None),
        ("sleep reports", None, None),
        ("fluid samples to examine diet and nutrition", None, None),
        ("saliva to measure the function of the immune system", None, None),
        ("cognition tests", None, None),
        ("sensorimotor tests", None, None),
        ("total body strength test", None, None),
        ("fecal samples", None, None),
    ],
}
# Measurements stated only in the page's featured-image caption (<meta property="og:image:alt">,
# the same text as the schema.org ImageObject caption of primaryImageOfPage). ARCHeR's body text
# says only "actigraphy"; its caption says where the device is worn and what it measures.
CAPTION_MEASUREMENT_ANCHORS: dict[str, list[tuple[str, str | None, str | None]]] = {
    "archer": [
        ("motion, sleep patterns, and exposure to light",
         "actigraphy device that select Artemis II astronauts will wear on their wrists",
         "during their mission around the Moon"),
    ],
}
# Tempus Pro: its own page does not list channels; the article it links as "participating
# missions" does (that sentence omits the device name - see caveats).
TEMPUS_ARTICLE_LINK_TEXT = "participating missions"
TEMPUS_ARTICLE_ANCHORS = [
    ("blood pressure, heart rate, respiration rate, and temperature", None, None),
    ("ultrasound imaging", None, None),
    ("larynx and throat-focused video camera", None, None),
]

# Risk-title aliases seen on the investigation pages vs. the risks overview page.
RISK_NAME_ALIASES = {
    "risk of cardiovascular adaptions": "risk of cardiovascular adaptations",          # typo on page
    "risk of behavioral conditions and psychiatric disorders":
        "risk of behavioral changes and psychiatric disorders",
    "risk from inadequate sleep and irregular schedules":
        "risk of inadequate sleep and irregular schedules",
}

# HRR risk ids LANDFALL needs status/ratings for (case + observed + brief item 6).
HRR_DETAIL_IDS = [81, 77, 100, 96, 85, 179, 99, 95, 175]
HRR_TASK_TITLE_IDS = {77, 81, 100, 96}   # deep-case risks: ship task titles too
HRR_BRIEF_TITLES = {85: "immune", 95: "in-mission medical conditions", 99: "behavioral",
                    100: "sleep/circadian", 175: "Earth-Independent Human-Systems Operations"}

CSA_RAD_ANCHORS = [
    "a compact and autonomous instrument designed to measure neutron radiation exposure in space",
    "Neutron radiation, which contributes to about 30% of total radiation on the ISS",
    "working continuously and autonomously",
    "Canada has significant expertise in radiation detection experiments on the ISS",
]
CSA_SCI_ANCHORS = [
    "Missions to the Moon and Mars mean longer trips and more risks for astronauts",
    "Studying the human body in space for six months gives us data that would take years",
    "Canadian scientists use space to study our bones, heart, blood vessels and brain",
    "On average, there are 200 international space experiments on board the ISS",
]


# ============================== text helpers ==============================

def soupify(html: str) -> BeautifulSoup:
    soup = BeautifulSoup(html, "html.parser")
    for br in soup.find_all("br"):
        br.replace_with(" ")          # "spacecraft.<br>When" must not become "spacecraft.When"
    return soup


def clean(el_or_text: Any) -> str:
    """Whitespace-normalised text. No separator is inserted between inline children, so
    '<abbr>CANS</abbr>, a' stays 'CANS, a' (a ' ' separator would give 'CANS , a')."""
    t = el_or_text if isinstance(el_or_text, str) else el_or_text.get_text()
    return " ".join(t.replace(" ", " ").split())


# Split after . ! ? and also after a closing quote that follows them ('... Mars.” The crew'),
# otherwise a quoted sentence is glued onto the next one.
_SENT_RE = re.compile(r"(?:(?<=[.!?])|(?<=[.!?][”\"’]))\s+(?=[A-Z0-9“\"(])")


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_RE.split(text) if s.strip()]


def sentence_with(text: str, anchor: str) -> str | None:
    for s in sentences(text):
        if anchor in s:
            return s
    return None


def slug_of(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1]


def meta(soup: BeautifulSoup, prop: str) -> str | None:
    m = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
    return m.get("content") if m and m.get("content") else None


def canonical(soup: BeautifulSoup) -> str | None:
    link = soup.find("link", rel="canonical")
    return link.get("href") if link else None


def norm_risk_name(name: str) -> str:
    n = clean(name).lower()
    return RISK_NAME_ALIASES.get(n, n)


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def title_similarity(a: str, b: str) -> float:
    """Jaccard overlap of word sets: tolerant of case/punctuation drift between nasa.gov and HRR."""
    wa, wb = _words(a), _words(b)
    return len(wa & wb) / len(wa | wb) if wa | wb else 0.0


def check_hrr_link(formal: str | None, linked_id: int | None, hrr_titles: dict[int, str],
                   min_sim: float = 0.6) -> dict:
    """NASA risk pages link their 'Formal risk description' to an HRR id; some links are wrong
    (Decompression Sickness -> 179 Cardiovascular, Hypoxia -> 85 Immune). Verify the link against
    the HRR tree titles and resolve by title when it disagrees."""
    if not formal or not hrr_titles:
        return {"hrr_risk_id": linked_id, "check": "unverified"}
    best_id, best = max(((i, title_similarity(formal, t)) for i, t in hrr_titles.items()), key=lambda x: x[1])
    if linked_id == best_id:
        return {"hrr_risk_id": linked_id, "check": "linked id matches HRR title",
                "similarity": round(best, 3)}
    return {"hrr_risk_id": best_id if best >= min_sim else None,
            "check": (f"MISMATCH: page links HRR {linked_id} "
                      f"({hrr_titles.get(linked_id, 'not in HRR tree')!r}) but its formal description "
                      f"matches HRR {best_id} ({hrr_titles[best_id]!r}), word-overlap {best:.2f}"),
            "similarity": round(best, 3)}


def html_title(html: str) -> str | None:
    t = BeautifulSoup(html, "html.parser").find("title")
    if t is None:
        return None
    return re.sub(r"\s+-\s+NASA$", "", clean(t)) or None


def pick_hsrb_link(links: list[dict], formal: str | None, titles: dict[str, str | None],
                   min_sim: float = 0.6) -> dict:
    """Choose the 'Explore more' (HSRB resources) target. One distinct href: take it. Several (the
    link text split across anchors): take the unique target whose page <title> matches the risk's
    formal description; otherwise null - never a silent guess."""
    hrefs = list(dict.fromkeys(lk["href"] for lk in links))
    if not hrefs:
        return {"url": None, "check": "no 'Explore more' link on the page"}
    if len(hrefs) == 1:
        return {"url": hrefs[0], "check": "single link"}
    scored = [(h, title_similarity(formal or "", titles.get(h) or "")) for h in hrefs]
    desc = "; ".join(f"{lk['text']!r} -> {lk['href']} (page title {titles.get(lk['href'])!r})" for lk in links)
    good = [(h, s) for h, s in scored if s >= min_sim]
    if len(good) == 1:
        return {"url": good[0][0],
                "check": (f"SPLIT LINK on NASA's page: the 'Explore more' text is split across {len(links)} "
                          f"anchors with different targets: {desc}. Chosen: the target whose page title "
                          f"matches this risk's formal description (word-overlap {good[0][1]:.2f}).")}
    return {"url": None, "check": f"AMBIGUOUS split 'Explore more' link: {desc}; no unique title match"}


def hazard_mentions(text: str, where: str) -> list[dict]:
    out = []
    for hz, pat in HAZARD_TERMS.items():
        for s in sentences(text):
            m = re.search(pat, s, re.I)
            if m:
                out.append({"hazard_id": hz, "term": m.group(0), "sentence": s, "where": where})
                break
    return out


# ============================== parsers (pure) ==============================

def parse_hazards_overview(html: str) -> dict:
    soup = soupify(html)
    lede = soup.find("p", class_="p-lg")
    hazards = []
    for row in soup.select("div.featured-link-list-row"):
        h2 = row.find("h2")
        p = row.find("p")
        a = row.find("a", href=True)
        if not (h2 and p and a):
            continue
        hz_id = HAZARD_SLUGS.get(slug_of(a["href"]))
        if hz_id is None:
            continue
        hazards.append({"id": hz_id, "name": clean(h2), "summary": clean(p), "url": a["href"]})
    return {"lede": clean(lede) if lede else None, "hazards": hazards,
            "modified": meta(soup, "og:updated_time")}


def parse_hazard_page(html: str, hz_id: str) -> tuple[dict, list[str]]:
    soup = soupify(html)
    main = soup.find("main") or soup.body
    h1 = main.find("h1")
    paras, anchors = [], []
    for p in main.find_all("p"):
        if p.find_parent("figure"):
            continue
        prev_h = p.find_previous(["h1", "h2"])
        if prev_h and clean(prev_h) in ("Related Articles", "Discover More Topics From NASA"):
            break
        t = clean(p)
        if t:
            paras.append(t)
            anchors += [(clean(a), a["href"]) for a in p.find_all("a", href=True)
                        if clean(a) and not a["href"].startswith("#")]
    body = " ".join(paras)
    key, missing = [], []
    for anchor in HAZARD_KEY_ANCHORS.get(hz_id, []):
        s = sentence_with(body, anchor)
        if not s:
            missing.append(anchor)
            continue
        # NASA hyperlinks inside the sentence (e.g. '1% to 1.5%' -> HRR evidence report Fracture.pdf).
        links = [{"text": tx, "href": h} for tx, h in dict.fromkeys(anchors) if tx in s]
        key.append({"anchor": anchor, "sentence": s, "links": links})
    return ({"title": clean(h1) if h1 else None, "lede": paras[0] if paras else None,
             "key_sentences": key, "modified": meta(soup, "og:updated_time")}, missing)


def parse_risks_overview(html: str) -> dict:
    soup = soupify(html)
    main = soup.find("main") or soup.body
    cat_headings = {}
    for a in main.find_all("a", href=True):
        if a["href"].startswith("#") and a["href"][1:] in CATEGORY_BY_ANCHOR:
            cat_headings[clean(a)] = CATEGORY_BY_ANCHOR[a["href"][1:]]
    categories, risks = [], []
    current = None
    for el in main.find_all(["h2", "h3"]):
        t = clean(el)
        if el.name == "h2":
            # "Risks Involving Human Physiology" etc.; anything else ends the risk list.
            match = next((c for h, c in cat_headings.items() if h.replace("Risks Involving ", "")
                          in t.replace("Risks Involving ", "")), None)
            if match:
                current = match
                categories.append({"id": match, "heading": t})
            elif risks:
                current = None
            continue
        if current is None or not t.lower().startswith("risk"):
            continue
        p = el.find_next("p")
        a = el.find_next("a", href=True)
        risks.append({"name": t, "category": current, "summary": clean(p) if p else None,
                      "url": a["href"] if a else None, "slug": slug_of(a["href"]) if a else None})
    intro = main.find("h1", string=re.compile("About Human Spaceflight Risks"))
    intro_p = intro.find_next("p") if intro else None
    return {"categories": categories, "risks": risks, "intro": clean(intro_p) if intro_p else None}


def _section_paragraph(main, heading: str) -> str | None:
    h = main.find(lambda tag: tag.name in ("h1", "h2") and clean(tag) == heading)
    if not h:
        return None
    parts = []
    for sib in h.find_all_next(["p", "h1", "h2"]):
        if sib.name != "p":
            break
        t = clean(sib)
        # "Type of study: Flight" is its own labelled paragraph right after "Impact", not impact text.
        if t.startswith(("Formal risk description", "Formal project title", "Type of study:")):
            break
        parts.append(t)
    return " ".join(parts) or None


def parse_risk_page(html: str) -> dict:
    soup = soupify(html)
    main = soup.find("main") or soup.body
    title = main.find("h2")
    formal = hrr_url = None
    hsrb_links: list[dict] = []
    for p in main.find_all("p"):
        t = clean(p)
        if t.startswith("Formal risk description:"):
            formal = t.split(":", 1)[1].strip()
            a = p.find("a", href=True)
            hrr_url = a["href"] if a else None
        elif t.startswith("Explore more:"):
            # Keep EVERY anchor: on some pages the text "Human System Risk Board resources" is split
            # across two <a> with different targets (DCS: "Human System" -> behavioral-health-risk,
            # " Risk Board resources" -> risk-of-decompression-sickness). run() resolves which is right.
            hsrb_links = [{"text": clean(a), "href": a["href"]} for a in p.find_all("a", href=True)]
    m = re.search(r"[?&]i=(\d+)", hrr_url or "")
    top = _section_paragraph(main, "What are the top risks?")
    todo = _section_paragraph(main, "What can be done about it?")
    return {
        "page_title": clean(title) if title else None,
        "canonical_url": canonical(soup),
        "modified": meta(soup, "og:updated_time"),
        "top_risks_sentences": sentences(top)[:3] if top else [],
        "what_can_be_done_sentences": sentences(todo)[:3] if todo else [],
        "formal_risk_description": formal,
        "hrr_risk_id": int(m.group(1)) if m else None,
        "hrr_url": hrr_url,
        "hsrb_resources_links": hsrb_links,
        "_top_text": top or "",
    }


SETTING_BY_HEADING = [
    ("Artemis II", "artemis_ii"),
    ("Low Earth Orbit", "leo"),
    ("Past Human Investigations", "past"),
]


def parse_research_overview(html: str) -> dict:
    soup = soupify(html)
    main = soup.find("main") or soup.body
    sections, items = [], []
    setting = heading = None
    for el in main.find_all(["h2", "h3"]):
        t = clean(el)
        if el.name == "h2":
            setting = next((s for k, s in SETTING_BY_HEADING if k in t), None)
            heading = t if setting else None
            if setting:
                sections.append({"heading": t, "setting": setting})
            continue
        if not setting:
            continue       # e.g. the "HRP Overview" block ("Who We Are", ...) is not an investigation
        p = el.find_next("p")
        a = el.find_next("a", href=True)
        items.append({"name": t, "blurb": clean(p) if p else None, "url": a["href"] if a else None,
                      "section_heading": heading, "setting": setting})
    return {"sections": sections, "investigations": items}


def parse_investigation_page(html: str) -> dict:
    soup = soupify(html)
    main = soup.find("main") or soup.body
    desc_h = main.find(lambda t: t.name == "h1" and clean(t) == "Description")
    desc = []
    if desc_h:
        for sib in desc_h.find_all_next(["p", "h1", "h2"]):
            if sib.name != "p":
                break
            desc.append(clean(sib))
    impact = _section_paragraph(main, "Impact")
    formal = study_type = None
    links = {}
    for p in main.find_all("p"):
        t = clean(p)
        if t.startswith("Formal project title:"):
            formal = t.split(":", 1)[1].strip()
        elif t.startswith("Type of study:"):
            study_type = t.split(":", 1)[1].strip()
        for a in p.find_all("a", href=True):
            links[clean(a)] = a["href"]
    top_h = main.find(lambda t: t.name == "h2" and clean(t) == "Top Risks Addressed")
    top_risks = []
    if top_h:
        for sib in top_h.find_all_next(["h2", "h3"]):
            if sib.name == "h2":
                break
            top_risks.append(clean(sib))
    return {"canonical_url": canonical(soup), "modified": meta(soup, "og:updated_time"),
            "description_paragraphs": desc, "impact": impact, "formal_project_title": formal,
            "type_of_study": study_type, "top_risks_addressed": top_risks,
            "featured_image_alt": meta(soup, "og:image:alt"), "_links": links}


def extract_measurements(text: str, anchors: list[tuple[str, str | None, str | None]],
                         source: str = "description") -> tuple[list[dict], list[str]]:
    """`evidence` = the verbatim sentence(s) that contain the `with` and `when` anchors, plus the
    first sentence naming `what` if none of those does, in page order - so the evidence always
    supports every non-null field (not just `what`). `from` says which page text was used."""
    sents = sentences(text)
    out, missing = [], []
    for what, with_what, when in anchors:
        miss = [x for x in (what, with_what, when) if x is not None and x not in text]
        if miss:
            missing.extend(miss)
            continue
        idx: list[int] = []
        for anc in (with_what, when):
            k = next((i for i, s in enumerate(sents) if anc and anc in s), None)
            if k is not None and k not in idx:
                idx.append(k)
        if not any(what in sents[i] for i in idx):
            k = next((i for i, s in enumerate(sents) if what in s), None)
            if k is not None:
                idx.append(k)
        out.append({"what": what, "with": with_what, "when": when, "from": source,
                    "evidence": " ".join(sents[i] for i in sorted(idx)) or None})
    return out, missing


def parse_article_paragraphs(html: str) -> tuple[list[str], dict]:
    soup = soupify(html)
    main = soup.find("main") or soup.body
    paras = [clean(p) for p in main.find_all("p") if clean(p)]
    return paras, {"canonical_url": canonical(soup), "title": clean(soup.find("h1")) if soup.find("h1") else None,
                   "published": meta(soup, "article:published_time"),
                   "modified": meta(soup, "article:modified_time")}


def parse_hrr_explore(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    tree = soup.select_one("#ctl00_content_rtvExplore")
    if tree is None:
        raise ValueError("HRR Explore: tree #ctl00_content_rtvExplore not found (page layout changed)")
    elements, risks = [], []
    for li in tree.find("ul", class_="rtUL").find_all("li", recursive=False):
        head = li.find("div", recursive=False)
        el_name = clean(head) if head else None
        ids = []
        sub = li.find("ul", recursive=False)
        for rli in (sub.find_all("li", recursive=False) if sub else []):
            a = rli.find("a", class_="risk")
            if not a:
                continue
            title = clean(a)
            rid = int(re.search(r"i=(\d+)", a["href"]).group(1))
            gaps, seen = [], set()
            for g in rli.select("a.gap"):
                gid = int(re.search(r"i=(\d+)", g["href"]).group(1))
                if gid in seen:
                    continue
                seen.add(gid)
                gaps.append({"gap_id": gid, "title": clean(g)})
            task_links = rli.select("a.task")
            tasks = {}
            for t in task_links:
                tid = int(re.search(r"i=(\d+)", t["href"]).group(1))
                tasks.setdefault(tid, clean(t))
            marker = re.search(r"\[(\w+)\]\s*$", title)
            risks.append({
                "hrr_id": rid, "title": title, "element": el_name,
                "kind": "concern" if title.lower().startswith("concern") else "risk",
                "explore_marker": marker.group(1) if marker else None,
                "gap_count": len(gaps), "unique_task_count": len(tasks),
                "url": HRR_RISK_URL.format(i=rid), "gaps": gaps,
                "_tasks": [{"task_id": k, "title": v} for k, v in sorted(tasks.items())],
            })
            ids.append(rid)
        elements.append({"name": el_name, "hrr_risk_ids": ids})
    return {"elements": elements, "risks": risks,
            "tree_gap_links": len(tree.select("a.gap")), "tree_task_links": len(tree.select("a.task"))}


def _labelled_value(soup: BeautifulSoup, label: str) -> str | None:
    """Text right after a bold '<span>Label:</span>', stopping at the next label span: several
    labels can share one parent div ('Short Title: ... Last Published: ...')."""
    for span in soup.find_all("span"):
        if clean(span) == label:
            parts = []
            for sib in span.next_siblings:
                if getattr(sib, "name", None) == "span" and clean(sib).endswith(":"):
                    break
                parts.append(sib if isinstance(sib, str) else sib.get_text())
            return clean("".join(parts)) or None
    return None


# Inline red text (color: #ff0000 / red), but not background-color.
_RED_STYLE = re.compile(r"(?<![-\w])color:\s*(?:#ff0000|#f00|red)\b", re.I)


def parse_hrr_risk_page(html: str, gap_titles: list[str] | None = None) -> dict:
    soup = soupify(html)
    ratings, mission = [], None
    table = soup.select_one("#ctl00_content_tblRiskRatings")
    note = None
    if table is not None:
        for tr in table.find_all("tr"):
            tid = tr.get("id") or ""
            cells = tr.find_all(["td", "th"])
            if not tid.startswith("ctl00_content_tr"):
                txt = clean(tr)
                if txt.startswith("Note:"):
                    note = txt
                continue
            labels = [clean(c) for c in cells if not c.get("id")]
            vals = {c.get("id").rsplit("_", 1)[-1]: clean(c) for c in cells if c.get("id")}
            if len(labels) >= 2:
                mission, duration = labels[0], labels[1]
            else:                      # mission-type cell spans two rows (rowspan)
                duration = labels[0] if labels else None
            key = tid.replace("ctl00_content_tr", "")

            def v(suffix: str) -> str | None:
                return vals.get(f"td{key}{suffix}")
            ratings.append({"mission_type": mission, "duration": duration,
                            "operations": {"lxc": v("OpsLxC"), "disposition": v("OpsDisposition")},
                            "long_term_health": {"lxc": v("LTHLxC"), "disposition": v("LTHDisposition")}})
    stmt = stmt_note = None
    hdr = soup.select_one("#ctl00_content_divRiskStatement")
    if hdr is not None:
        nxt = hdr.find_next_sibling("div")
        if nxt is not None:
            # Risk 96 opens its Risk Statement with a red editorial note (the old 3x4 LxC matrix
            # remark). Ship it separately so risk_statement is the "Given ..." statement alone.
            reds = [el for el in nxt.find_all(attrs={"style": _RED_STYLE})
                    if el.find_parent(attrs={"style": _RED_STYLE}) is None]
            stmt_note = " ".join(t for t in (clean(el) for el in reds) if t) or None
            for el in reds:
                el.extract()
            stmt = clean(nxt) or None
    flat = clean(soup.get_text(" "))
    gap_status = {}
    for gt in gap_titles or []:
        m = re.search(re.escape(gt) + r" Responsible Element: (.+?) Status: (Open|Closed)\b", flat)
        if m:
            gap_status[gt] = {"responsible_element": m.group(1), "status": m.group(2)}
    lp = soup.select_one("#ctl00_content_ltlLastPublished")
    return {"hrp_risk_status": _labelled_value(soup, "HRP Risk Status:"),
            "last_published": clean(lp) if lp else _labelled_value(soup, "Last Published:"),
            "element": _labelled_value(soup, "Element:"),
            "short_title": _labelled_value(soup, "Short Title:"),
            "risk_statement": stmt, "risk_statement_note": stmt_note,
            "ratings": ratings, "ratings_note": note, "gap_status": gap_status}


def parse_csa_page(html: str, anchors: list[str]) -> tuple[dict, list[str]]:
    soup = soupify(html)
    main = soup.find("main") or soup.body
    paras = [clean(p) for p in main.find_all(["p", "li"]) if clean(p)]
    extracts, missing = [], []
    for anc in anchors:
        # Match per paragraph: joining <p>/<li> first would glue list items and captions into
        # one pseudo-sentence.
        s = next((x for x in (sentence_with(p, anc) for p in paras) if x), None)
        (extracts.append(s) if s else missing.append(anc))
    links, link_titles = {}, {}
    for a in main.find_all("a", href=True):
        links[clean(a)] = a["href"]
        if a.get("title"):
            link_titles[clean(a)] = clean(a["title"])   # e.g. MOSFET's expansion, as the page states it
    info = {
        "title": clean(main.find("h1")) if main.find("h1") else None,
        "issued": meta(soup, "dcterms.issued"), "modified": meta(soup, "dcterms.modified"),
        "creator": meta(soup, "dcterms.creator"), "canonical_url": canonical(soup),
    }
    return {"info": info, "extracts": extracts, "links": links, "link_titles": link_titles,
            "paras": paras}, missing


# ============================== run ==============================

def _fetch(ctx: RunContext, url: str, used: list[str]) -> str:
    cached = ctx._cache_path(url, None).exists()
    html = ctx.fetch_text(url)
    used.append(url)
    if not cached and not ctx.offline:
        time.sleep(_PAUSE_S)
    return html


def _source(publisher: str, name: str, url: str, access: list[str], license_: str, citation: str) -> dict:
    return {"publisher": publisher, "name": name, "url": url,
            "access_urls": sorted(set(access)), "license": license_, "citation": citation}


def _day(iso_or_none: str | None) -> str:
    return (iso_or_none or "")[:10] or "n.d."


def _cov() -> dict:
    return {"start": None, "stop": None, "cadence": None}


_FRESH = {"kind": "reference", "stale_after": None}


def run(ctx: RunContext) -> list[dict]:
    snaps = []
    acc = ctx.retrieved_at[:10]
    risks_by_name: dict[str, dict] = {}
    # The HRR tree is parsed first: it is the cross-check for every risk page's HRR link.
    hrr_used: list[str] = []
    ex = parse_hrr_explore(_fetch(ctx, HRR_EXPLORE_URL, hrr_used))
    hrr_titles = {r["hrr_id"]: r["title"] for r in ex["risks"]}

    # ---------- 1. hazards ----------
    used: list[str] = []
    ov = parse_hazards_overview(_fetch(ctx, HAZARDS_URL, used))
    cav = []
    for hz in ov["hazards"]:
        try:
            page, missing = parse_hazard_page(_fetch(ctx, hz["url"], used), hz["id"])
            hz["page"] = page
            cav += [f"{hz['id']}: anchor not found on live page, sentence dropped: {m!r}" for m in missing]
        except Exception as exc:  # noqa: BLE001
            cav.append(f"{hz['id']}: hazard page fetch failed ({exc}); only the overview summary is shipped")
    if len(ov["hazards"]) != 5:
        cav.append(f"expected 5 hazards on the overview page, parsed {len(ov['hazards'])}")
    snaps.append(make_snapshot(
        id="hrp_hazards", adapter=ADAPTER_ID, title="NASA HRP - 5 Hazards of Human Spaceflight",
        source=_source("NASA Human Research Program", "5 Hazards of Human Spaceflight", HAZARDS_URL, used,
                       NASA_LICENSE,
                       f"NASA Human Research Program. \"5 Hazards of Human Spaceflight.\" NASA, page updated "
                       f"{_day(ov['modified'])}. {HAZARDS_URL} (accessed {acc}); plus the five linked hazard "
                       f"pages listed in access_urls."),
        retrieved_at=ctx.retrieved_at, coverage=_cov(), freshness=_FRESH, provenance="reference",
        caveats=cav + [
            "Summaries and sentences are verbatim (whitespace-normalised) NASA text; key_sentences were "
            "selected by LANDFALL using the shipped anchors, the wording is NASA's.",
            "Educational web pages, not standards: no thresholds or requirement IDs come from this snapshot.",
            "Distance hazard page says a Mars communication delay of 'up to 20 minutes one way' (HRP's rounded "
            "general-audience figure). This snapshot carries no other light-time number; computed Earth-Mars "
            "light times must come from their own source (e.g. JPL Horizons) - do not mix the two in one claim.",
        ],
        data={"page_url": HAZARDS_URL, "page_modified": ov["modified"], "lede": ov["lede"],
              "hazards": ov["hazards"]}))

    # ---------- 2. risks (+ every risk page) ----------
    used = []
    rv = parse_risks_overview(_fetch(ctx, RISKS_URL, used))
    used.append(HRR_EXPLORE_URL)      # used to verify each risk page's HRR link
    cav = []
    for r in rv["risks"]:
        r["key_risk"] = r["slug"] in KEY_RISK_SLUGS
        r["hazard_mentions"] = hazard_mentions(r["summary"] or "", "risks_overview_summary")
        try:
            d = parse_risk_page(_fetch(ctx, r["url"], used))
            top_text = d.pop("_top_text")
            seen = {m["hazard_id"] for m in r["hazard_mentions"]}
            r["hazard_mentions"] += [m for m in hazard_mentions(top_text, "risk_page_top_risks")
                                     if m["hazard_id"] not in seen]
            if d["canonical_url"] and d["canonical_url"].rstrip("/") != r["url"].rstrip("/"):
                cav.append(f"{r['name']}: listed URL {r['url']} redirects to canonical {d['canonical_url']}")
            if d["page_title"] and clean(d["page_title"]).lower() != r["name"].lower():
                cav.append(f"{r['name']}: risk page heading reads {d['page_title']!r}")
            d["hrr_risk_id_linked"] = d.pop("hrr_risk_id")
            chk = check_hrr_link(d["formal_risk_description"], d["hrr_risk_id_linked"], hrr_titles)
            d["hrr_risk_id"] = chk["hrr_risk_id"]
            d["hrr_link_check"] = chk["check"]
            if chk["check"].startswith("MISMATCH"):
                cav.append(f"{r['name']}: NASA page error - {chk['check']}; hrr_risk_id uses the title match")
            r["detail"] = d
        except Exception as exc:  # noqa: BLE001
            r["detail"] = None
            cav.append(f"{r['name']}: risk page fetch/parse failed ({exc})")
        risks_by_name[norm_risk_name(r["name"])] = r
    hsrb_users: dict[str, list[str]] = {}
    for r in rv["risks"]:
        d = r.get("detail")
        if not d:
            continue
        links = d["hsrb_resources_links"]
        titles: dict[str, str | None] = {}
        if len({lk["href"] for lk in links}) > 1:          # split link: fetch each target's <title>
            for h in dict.fromkeys(lk["href"] for lk in links):
                try:
                    titles[h] = html_title(_fetch(ctx, h, used))
                except Exception as exc:  # noqa: BLE001
                    titles[h] = None
                    cav.append(f"{r['name']}: HSRB link target {h} fetch failed ({exc})")
        pick = pick_hsrb_link(links, d["formal_risk_description"], titles)
        d["hsrb_resources_url"], d["hsrb_link_check"] = pick["url"], pick["check"]
        if pick["check"] != "single link":
            cav.append(f"{r['name']}: {pick['check']}")
        if pick["url"]:
            hsrb_users.setdefault(pick["url"], []).append(r["name"])
    for u, names in hsrb_users.items():
        if len(names) > 1:
            cav.append(f"'Explore more' (HSRB resources) link {u} is used by {names} even after resolving "
                       "split links; verify before citing it per risk")
    renal_listed = any("renal" in (r["name"] + (r["summary"] or "")).lower() or "kidney" in
                       (r["name"] + (r["summary"] or "")).lower() for r in rv["risks"])
    snaps.append(make_snapshot(
        id="hrp_risks", adapter=ADAPTER_ID, title="NASA HRP - Risks of Human Spaceflight",
        source=_source("NASA Human Research Program", "Risks of Human Spaceflight", RISKS_URL, used,
                       NASA_LICENSE,
                       f"NASA Human Research Program. \"Risks of Human Spaceflight.\" NASA. {RISKS_URL} "
                       f"(accessed {acc}); plus each linked nasa.gov/reference/risk-... page in access_urls."),
        retrieved_at=ctx.retrieved_at, coverage=_cov(), freshness=_FRESH, provenance="reference",
        caveats=cav + [
            "This official overview page lists NO renal stone / kidney stone risk. NASA's Human Research "
            "Roadmap still carries 'Risk of Renal Stone Formation' (HRR risk 81; its status as stated on its "
            "HRR page is in hrp_roadmap data.answers.renal_stone_risk_81) and the Gravity Fields hazard page "
            "names the kidney-stone mechanism (hrp_hazards).",
            "hazard_mentions are term matches (terms in data.hazard_terms) inside NASA's own sentences, "
            "not an official NASA risk-to-hazard mapping; these pages publish no such table. The only "
            "structural grouping NASA gives is the three category headings.",
            "Sentences are verbatim (whitespace-normalised); at most 3 per section are kept.",
        ],
        data={"page_url": RISKS_URL, "intro": rv["intro"], "categories": rv["categories"],
              "renal_stone_risk_listed": renal_listed, "hazard_terms": HAZARD_TERMS,
              "risks": rv["risks"]}))

    # ---------- 3. research (+ 5 investigation pages) ----------
    used = []
    rs = parse_research_overview(_fetch(ctx, RESEARCH_URL, used))
    cav = []
    for inv in rs["investigations"]:
        slug = slug_of(inv["url"] or "")
        if slug not in DEEP_INVESTIGATIONS:
            continue
        try:
            d = parse_investigation_page(_fetch(ctx, inv["url"], used))
        except Exception as exc:  # noqa: BLE001
            cav.append(f"{inv['name']}: investigation page fetch failed ({exc})")
            continue
        links = d.pop("_links")
        text = " ".join(d["description_paragraphs"])
        d["measurements"], missing = extract_measurements(text, MEASUREMENT_ANCHORS.get(slug, []))
        if slug in CAPTION_MEASUREMENT_ANCHORS:
            if d["featured_image_alt"]:
                m2, miss2 = extract_measurements(d["featured_image_alt"], CAPTION_MEASUREMENT_ANCHORS[slug],
                                                 source="featured_image_caption")
                d["measurements"] += m2
                missing += miss2
            else:
                cav.append(f"{inv['name']}: featured-image caption (og:image:alt) missing; caption "
                           "measurements dropped")
        d["measurement_source_url"] = inv["url"]
        if slug == "tempus-pro":
            art = links.get(TEMPUS_ARTICLE_LINK_TEXT)
            if art:
                try:
                    paras, ainfo = parse_article_paragraphs(_fetch(ctx, art, used))
                    d["measurements"], missing = extract_measurements(" ".join(paras), TEMPUS_ARTICLE_ANCHORS,
                                                                      source="linked_article")
                    d["measurement_source_url"] = art
                    d["measurement_source"] = ainfo
                    d["measurement_source_caveat"] = (
                        "The measurement sentence in this NASA article reads 'The crew will test drive, a "
                        "commercial device that can collect ...' - the device name is missing from the HTML. "
                        "It is attributed to Tempus Pro because the Tempus Pro reference page links this "
                        "article as its 'participating missions' (Polaris Dawn, 2024). The article does not "
                        "say how blood pressure is measured (cuff or otherwise) and names no SpO2 or ECG.")
                except Exception as exc:  # noqa: BLE001
                    cav.append(f"Tempus Pro: linked article fetch failed ({exc}); measurements unknown")
            else:
                cav.append("Tempus Pro: 'participating missions' link not found; measurements unknown")
        cav += [f"{inv['name']}: measurement anchor not found, dropped: {m!r}" for m in missing]
        resolved = []
        for name in d["top_risks_addressed"]:
            r = risks_by_name.get(norm_risk_name(name))
            resolved.append({"as_written": name, "risk_slug": r["slug"] if r else None})
        d["top_risks_resolved"] = resolved
        inv["detail"] = d
    snaps.append(make_snapshot(
        id="hrp_research", adapter=ADAPTER_ID, title="NASA HRP - Ongoing HRP Research in Space",
        source=_source("NASA Human Research Program", "Ongoing HRP Research in Space", RESEARCH_URL, used,
                       NASA_LICENSE,
                       f"NASA Human Research Program. \"Ongoing HRP Research in Space.\" NASA. {RESEARCH_URL} "
                       f"(accessed {acc}); investigation pages and the linked Polaris Dawn article (NASA, "
                       f"2024-09-10) in access_urls."),
        retrieved_at=ctx.retrieved_at, coverage=_cov(), freshness=_FRESH, provenance="reference",
        caveats=cav + [
            "The page has THREE sections, not two: Artemis II, Low Earth Orbit, and 'Past Human "
            "Investigations'. Tempus Pro is listed under Past Human Investigations (setting 'past').",
            "ARCHeR: the body text says only 'actigraphy' (no wear location). The page's featured-image "
            "caption (og:image:alt, identical to the schema.org ImageObject caption; photo credit NASA/Helen "
            "Arase Vargas) says the actigraphy device is worn 'on their wrists' and 'will measure the crew "
            "members' motion, sleep patterns, and exposure to light'. That row has from='featured_image_caption': "
            "it is image metadata, not visible body text. Standard Measures' body text says 'wrist sensor' "
            "(activity and light exposure).",
            "The Standard Measures page says 'activity and light exposure (gathered through a wrist sensor)'; "
            "it does not use the phrase 'white, red, green, and blue light in lux'.",
            "Immune Biomarkers (Artemis II): blood is collected only before and after the mission; in flight "
            "only dry saliva (blotted on paper) is collected - blood chemistry is NOT an in-flight measure there.",
            "measurements[] phrases are verbatim and anchor-checked; 'evidence' is the verbatim sentence(s) "
            "containing the what/with/when phrases; 'from' names the text used (description = body text, "
            "featured_image_caption, linked_article). 'when' is null where the page gives no per-measure "
            "timing (both Standard Measures pages only say 'before, during, and after').",
            "Investigation-to-risk links (top_risks_addressed) are NASA's own 'Top Risks Addressed' lists; "
            "names are matched to the risks page with a small alias table (e.g. the page typo "
            "'Cardiovascular Adaptions').",
        ],
        data={"page_url": RESEARCH_URL, "sections": rs["sections"], "investigations": rs["investigations"],
              "risk_name_aliases": RISK_NAME_ALIASES}))

    # ---------- 4. CSA radiation ----------
    used = []
    try:
        page, missing = parse_csa_page(_fetch(ctx, CSA_RAD_URL, used), CSA_RAD_ANCHORS)
        caption = next((p for p in page["paras"] if "Canadian Active Neutron Spectrometer" in p), "")
        instruments = [{"name": "CANS", "full_name": "Canadian Active Neutron Spectrometer"
                        if "Canadian Active Neutron Spectrometer (CANS)" in caption else None,
                        "described_as": "a compact and autonomous instrument designed to measure neutron "
                                        "radiation exposure in space", "url": CSA_RAD_URL}]
        for nm in ("MOSFET", "EVARM", "Radi-N and Radi-N2"):
            href = page["links"].get(nm)
            instruments.append({"name": nm, "full_name": page["link_titles"].get(nm), "described_as": None,
                                "url": ("https://www.asc-csa.gc.ca" + href) if href and href.startswith("/")
                                else href})
        numbers = []
        s30 = sentence_with(" ".join(page["paras"]), "about 30% of total radiation on the ISS")
        if s30:
            numbers.append({"value": 30, "unit": "%", "qualifier": "about",
                            "quantity": "neutron radiation share of total radiation on the ISS",
                            "sentence": s30})
        info = page["info"]
        snaps.append(make_snapshot(
            id="hrp_csa_radiation", adapter=ADAPTER_ID, title="CSA - Monitoring radiation for astronaut health",
            source=_source("Canadian Space Agency", info["title"] or "Monitoring radiation for astronaut health",
                           CSA_RAD_URL, used, CSA_LICENSE,
                           f"Canadian Space Agency. \"{info['title']}.\" News article, {info['issued']} "
                           f"(date modified {info['modified']}). {CSA_RAD_URL} (accessed {acc})."),
            retrieved_at=ctx.retrieved_at, coverage=_cov(), freshness=_FRESH, provenance="reference",
            caveats=[f"anchor not found, extract dropped: {m!r}" for m in missing] + [
                "Short factual extracts only (Government of Canada terms); read the full article at the URL.",
                "The article names MOSFET, EVARM and Radi-N/Radi-N2 but does not describe them; their linked "
                "CSA pages were not ingested, so described_as is null rather than guessed. full_name is only "
                "set where the article's own link carries a title attribute (MOSFET).",
                "The 30% neutron share is the CSA's rounded ('about') figure for the ISS, not a deep-space value.",
            ],
            data={"article": info, "extracts": page["extracts"], "instruments": instruments,
                  "numbers": numbers}))
    except Exception as exc:  # noqa: BLE001 - degrade: one dead CSA page must not drop the NASA snapshots
        print(f"[hrp] CSA radiation page failed: {exc}")

    # ---------- 5. CSA science ----------
    used = []
    try:
        page, missing = parse_csa_page(_fetch(ctx, CSA_SCI_URL, used), CSA_SCI_ANCHORS)
        lead = "Missions to the Moon and Mars mean longer trips and more risks for astronauts"
        risks_list = []
        if lead in " ".join(page["paras"]):
            i = next(k for k, p in enumerate(page["paras"]) if lead in p)
            risks_list = page["paras"][i + 1:i + 6]
        info = page["info"]
        snaps.append(make_snapshot(
            id="hrp_csa_science", adapter=ADAPTER_ID, title="CSA - Why do we conduct science experiments in space?",
            source=_source("Canadian Space Agency", info["title"] or "Why do we conduct science experiments in space?",
                           CSA_SCI_URL, used, CSA_LICENSE,
                           f"Canadian Space Agency. \"{info['title']}\" Web page, first issued {info['issued']}, "
                           f"date modified {info['modified']}. {CSA_SCI_URL} (accessed {acc})."),
            retrieved_at=ctx.retrieved_at, coverage=_cov(), freshness=_FRESH, provenance="reference",
            caveats=[f"anchor not found, extract dropped: {m!r}" for m in missing] + [
                "Short factual extracts only (Government of Canada terms); general-audience page, no thresholds.",
            ],
            data={"page": info, "extracts": page["extracts"],
                  "deep_space_risks_listed": risks_list}))
    except Exception as exc:  # noqa: BLE001
        print(f"[hrp] CSA science page failed: {exc}")

    # ---------- 6. Human Research Roadmap (tree parsed at the top of run) ----------
    used = hrr_used
    cav = []
    by_id = {r["hrr_id"]: r for r in ex["risks"]}
    for rid in HRR_DETAIL_IDS:
        r = by_id.get(rid)
        if r is None:
            cav.append(f"HRR risk {rid} is not in the Explore tree")
            continue
        try:
            d = parse_hrr_risk_page(_fetch(ctx, HRR_RISK_URL.format(i=rid), used),
                                    [g["title"] for g in r["gaps"]])
            for g in r["gaps"]:
                st = d["gap_status"].get(g["title"])
                g["status"] = st["status"] if st else None
            d.pop("gap_status")
            r["detail"] = d
        except Exception as exc:  # noqa: BLE001
            cav.append(f"HRR risk {rid} page failed ({exc}); Explore-tree data only")
    for r in ex["risks"]:
        tasks = r.pop("_tasks")
        if r["hrr_id"] in HRR_TASK_TITLE_IDS:
            r["tasks"] = tasks
    renal = by_id.get(81)
    answers = {
        "renal_stone_risk_81": {
            "in_explore_tree": renal is not None,
            "title": renal["title"] if renal else None,
            "element": renal["element"] if renal else None,
            "hrp_risk_status": (renal.get("detail") or {}).get("hrp_risk_status") if renal else None,
            "last_published": (renal.get("detail") or {}).get("last_published") if renal else None,
            "listed_on_nasa_gov_risks_page": renal_listed,
        },
        "confirmed_titles": {str(i): {"topic": t, "title": by_id[i]["title"] if i in by_id else None}
                             for i, t in HRR_BRIEF_TITLES.items()},
    }
    n_marked = sum(1 for r in ex["risks"] if r["explore_marker"])
    for r in ex["risks"]:
        note = (r.get("detail") or {}).get("risk_statement_note")
        if note:
            cav.append(f"HRR {r['hrr_id']}: its Risk Statement section opens with a red editorial note, shipped "
                       f"separately as detail.risk_statement_note: {note!r}"
                       + (" Its LxC ratings are on that previous 3x4 matrix: do not compare them with "
                          "ratings on the 5x5 matrix." if "3x4" in note else ""))
    snaps.append(make_snapshot(
        id="hrp_roadmap", adapter=ADAPTER_ID, title="NASA Human Research Roadmap - risks, gaps, status",
        source=_source("NASA Human Research Program", "Human Research Roadmap (HRR) - Explore", HRR_EXPLORE_URL,
                       used, NASA_LICENSE,
                       f"NASA Human Research Program. \"Human Research Roadmap: Explore\" (Element-Risk-Gap-Task "
                       f"tree). https://humanresearchroadmap.nasa.gov/Explore/ (accessed {acc}); per-risk pages "
                       f"https://humanresearchroadmap.nasa.gov/risks/?i=<id> for ids {HRR_DETAIL_IDS}."),
        retrieved_at=ctx.retrieved_at, coverage=_cov(), freshness=_FRESH, provenance="reference",
        caveats=cav + [
            f"The Explore tree has {len(ex['risks'])} risk nodes, of which {n_marked} carries an explicit "
            "'[inactive]' marker (a 'Concern', not a Risk); 'active' status is only asserted where the "
            "per-risk page states 'HRP Risk Status' (detail.hrp_risk_status).",
            "gap_count / unique_task_count are de-duplicated counts of the Explore tree under each risk; a "
            "task or gap can sit under several risks, so the per-risk numbers do not sum to a total.",
            "Gap titles sometimes end in '(closed)', but that suffix is NOT a reliable status (e.g. gap B5 "
            "has no suffix yet its risk page says Status: Closed). gaps[].status comes only from the "
            "per-risk page and is null where that page was not ingested.",
            "LxC ratings: likelihood x consequence as printed; the ratings_note gives the HSRB approval "
            "date. Row labels are taken from the table text, not the HTML ids (id 'LEO6mo' labels "
            "'Short (<30 days)').",
            "Task titles are shipped only for deep-case risks 77, 81, 100, 96 to keep the file small.",
        ],
        data={"explore_url": HRR_EXPLORE_URL, "elements": ex["elements"],
              "counts": {"risk_nodes": len(ex["risks"]), "marked_nodes": n_marked,
                         "tree_gap_links": ex["tree_gap_links"], "tree_task_links": ex["tree_task_links"]},
              "answers": answers, "risks": ex["risks"]}))
    return snaps
