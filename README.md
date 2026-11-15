# LANDFALL

**Earth-independent health navigation for exploration crews.** NASA Space Apps Challenge 2026, *Create Health Monitoring Software for Astronauts on Space Missions*.

![LANDFALL's Now view at a Mars surface base during a solar conjunction: with no link, Houston's earliest reply is days away, while LANDFALL's onboard guidance is already on screen. Simulated crew data.](web/public/og.png)

LANDFALL is offline-first health-monitoring software for crews who cannot wait for Houston. It checks each crewmember against NASA's limits and NOAA's storm-scale thresholds (Tier A: NASA-STD-3001 requirements frozen verbatim, an HRP evidence report's urine target and the NOAA S-scale) and against their own baseline (Tier B: a single-case test whose chance rate is measured and printed). A trigger reaching Caution or Warning opens one of three guided cases (radiation shelter, renal stone risk, sleep): one countermeasure, required steps, a reassessment tripwire, and escalation to the onboard Crew Medical Officer now (the Commander, the crew's second Crew Medical Officer, when the CMO is the patient) and to the flight surgeon through a consent-filtered FHIR packet that waits for the link. Escalations and overdue reassessments also raise annunciator alerts. NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew physiology (vital signs) and leaves the alert point to the program, so every number LANDFALL chose is labelled "design choice", and every case also prints as a paper cue card for when the screen is lost. The demo is a simulated Mars crew inside a solar conjunction modelled from JPL Horizons, during a replay of the real October 1989 proton event.

- **Live app:** https://landfall.landfall-web.workers.dev (static files, no backend; it reloads offline after one visit)
- **Demo video (30 s):** [VIDEO-TBC]
- **Printed cue cards:** [docs/landfall-cue-card.pdf](docs/landfall-cue-card.pdf)

## A two-minute audit path

Each link opens one view. `?env=` sets the environment (`iss`, `cislunar`, `lunar_surface` or `mars_surface`), and the footer's "Copy link to this view" makes a link to any view.

1. https://landfall.landfall-web.workers.dev/#/verify : press Run, with nothing to install. Your browser replays the 6,460 shared conformance vectors through the TypeScript engine against the Python reference, re-hashes the 27 data snapshots against `manifest.json`, recomputes the rules digest the cue cards print and counts requests to other origins; "See the checks fail" turns the checks red on altered copies. Expected results are under "Check our arithmetic".
2. https://landfall.landfall-web.workers.dev/ : the scenario plays unprompted. Houston's earliest reply is 11 d 06 h away; LANDFALL's guidance is on screen in a fraction of a second (the app prints the time it measured on your device). Then https://landfall.landfall-web.workers.dev/#/case/spe_shelter?env=mars_surface : open "Why this fired" for the reading, the NOAA S3 threshold it reached, how far above it, and the requirement behind the rule.
3. https://landfall.landfall-web.workers.dev/#/method?s=gap : NASA-STD-3001's alert requirements leave the alert point to the program, even where Vol 2 sets the limit itself, verbatim. Below them, the five requirements closest in meaning to that claim, ranked by a small model at build time (a ranking, not proof; see Use of AI). The link under that list opens #/method?s=find, a search of the 57 requirements LANDFALL froze (not the whole standard) by keyword and, with the same model, by meaning: a disclosed helper, outside the decision path.
4. https://landfall.landfall-web.workers.dev/#/provenance?chip=design+choice : the 54 of 107 rule entries that are ours.
5. https://landfall.landfall-web.workers.dev/#/radiation?env=mars_surface : the MSL RAD team's published storm rule (Löwe et al. 2025) replayed on the whole Curiosity RAD record that NASA's iSWA serves and checked row by row against the paper (7 of its 16 Table 1 surface rows reproduce; every difference is printed); "Earth's proton lists and the storms measured at Gale", under "Who watches the Sun here, and who raises the alarm" (open "How this was matched" for the method, the window sensitivity and the rows not counted); the April 2013 conjunction storm (sol 242) that Curiosity's RAD measured at Gale crater while JPL planned to suspend commanding, rebuilt from RAD (iSWA) and STEREO-B HET (CDAWeb) beside NOAA's list; NASA's design-reference storm (Vol 1 Table 4.8-3) against the replayed GOES-7 record; STS-34 in orbit during the 1989 storm.
6. https://landfall.landfall-web.workers.dev/#/eva?crew=CM-2&env=mars_surface : EVA in a blackout. NASA's EVA clearance rule [V1 6006] verbatim; the ground link (loss of signal MET 406/09:20:00, link back MET 423/20:20:00, earliest review MET 423/20:59, light time only); CM-2's evidence under the rationale's three phrases, each item dated before or after loss of signal; three options for the program, none picked. LANDFALL never clears anyone. Add `&env=iss` for the same board with the ground reachable within the round trip (≤2.00 s). The body map's VO₂max card links here ("EVA in a blackout: what NASA requires →").
7. https://landfall.landfall-web.workers.dev/#/card/spe_shelter : the paper cue card ([V2 10130]); https://landfall.landfall-web.workers.dev/#/cards prints all three.
8. https://landfall.landfall-web.workers.dev/#/body?env=iss&crew=CM-2&region=muscles and https://landfall.landfall-web.workers.dev/#/body?env=mars_surface&crew=CM-2&region=muscles : one VO₂max reading (35.1 ml/min/kg) meets NASA's microgravity-EVA floor [V1 4001] and misses the surface-EVA floor [V1 4002], so at Mars it reads "EVA fitness floor not met"; EVA clearance itself is ground medical support's [V1 6006].
9. https://landfall.landfall-web.workers.dev/#/method?s=coverage : LANDFALL's scope scored against NASA's sample Integrated Medical Model output (Vol 1 Table E.2-1): 13.6 % watched by a case, 23.2 % asked daily, 6.3 % asked by a symptom only, 56.9 % not measurable here. Watched or asked does not mean detected.
10. https://landfall.landfall-web.workers.dev/#/band and https://landfall.landfall-web.workers.dev/#/data : the NOT MEASURABLE HERE boundary of the wearable concept, with the model-ranked closest requirements under each searched negative; all 27 data snapshots and their caveats.

## Real or simulated

| What | Status | From |
|---|---|---|
| NASA-STD-3001 Vol 1 Rev C and Vol 2 Rev F: 20 + 37 requirements, 10 tables, Appendix E and F extracts | Real, frozen verbatim from PDFs identified by SHA-256 | NASA OCHMO |
| Earth–Mars and Earth–Moon light time | Real ephemeris (range ÷ c), labelled a prediction | JPL Horizons |
| Conjunction window, 2028-03-12 to 2028-03-29 | Modelled: Sun–Earth–Mars elongation below 2.04°, a threshold fitted to 6 published NASA/JPL command moratoria (RMS 0.79 d) | JPL Horizons; NASA/JPL |
| Proton flux in the scenario | Real record, time-shifted: GOES-7, October 1989, read as a Mars-orbit monitor with no distance or atmosphere correction (a labelled assumption). Its fluence agrees with NASA's design-reference SPE (Vol 1 Table 4.8-3) within 0.5 % above 10 MeV and 2.6 % above 100 MeV | NOAA NCEI; NASA OCHMO |
| Mars-surface dose rate, and the storm-rule replay run on it | Real record: MSL RAD detector E, 390,270 samples, 2012-08-17 to 2026-11-12; the replay's numbers are derived from it | NASA CCMC iSWA; rule from Löwe et al. 2025 |
| April 2013 conjunction storm (sol 242) | Real records: MSL RAD detector E (63 samples, 10–12 April 2013) and STEREO-B HET proton flux (10,035 one-minute rows, as hourly means); NOAA's list entry (114 pfu, S2); JPL's planned Curiosity moratorium (quote read by hand) | NASA CCMC iSWA; NASA SPDF CDAWeb; NOAA SWPC list; NASA/JPL; Hassler et al. 2014 |
| Habitat dose rate during the event | Simulated: the measured Mars quiet rate, scaled so that NOAA's S3 flux gives 10 × (design choice) | LANDFALL |
| ISS dose (TEPC, one 2015 day), lunar-orbit dose (CRaTER), predicted ISS track | Real, labelled historical or predicted | NASA SRAG, CCMC, SPDF |
| Lab values and reference ranges | Real: SpaceX Inspiration4, n = 4, about 3 days in LEO, no in-flight samples in these files; reference ranges for the metabolic panel and blood count only | NASA OSDR (OSD-575, OSD-569, OSD-656) |
| Hazard, risk and research text; renal urine target; gap EIHSO-301 | Real, quoted verbatim | NASA HRP; Human Research Roadmap; HRP renal evidence report |
| STS-34 flight facts | Real, quoted verbatim | NASA mission page; Golightly et al. 1992 |
| The requirements listed as closest in meaning to each searched negative | NASA's text, verbatim; the ranking is LANDFALL's, made once at build time by a small model (a ranking, not proof of absence) | NASA OCHMO; potion-base-8M (MinishLab) |
| Crew CM-1 to CM-4: vitals, sleep, PVT-B, urine, mood, VO₂max, scripted episodes and crew actions | Simulated from a fixed seed and labelled "SIMULATED CREW DATA" on every view; day-to-day noise from published within-person SDs where they exist, a design choice elsewhere | `ingest/sim_crew.py` |
| Mission calendar (MET 412/14:20:00 = 18 March 2028) | Fictional | LANDFALL |
| LANDFALL BAND wearable | Concept only: block diagram and BOM, never built | `hardware/` |

## Check our arithmetic

No install needed: open https://landfall.landfall-web.workers.dev/#/verify and press Run. Your browser replays all 6,460 shared conformance vectors through the TypeScript engine and compares each with the Python reference, re-hashes the frozen snapshots against `manifest.json`, recomputes the rules digest the cue cards print and counts requests to other origins. "See the checks fail" turns the engine and snapshot checks red on a deliberately altered engine function and on a snapshot copy with one changed byte, and "Have NASA's PDF? Drop it here" hashes a standard you download yourself against the SHA-256 the snapshots record. Expected: 6460 of 6460 vectors agree within 1e-9 (the replay takes about 140 ms in Chrome), 27 of 27 snapshots match, the digest equals the one the cards print, and 0 requests go to other origins. <!-- COUNT -->

From source:

```bash
git clone https://github.com/amaroguilherme/landfall && cd landfall
uv sync --all-extras
uv run pytest -q
uv run python -m engine.vectors --check   # prints "vectors up to date"
cd web && npm ci && npx vitest run
npx tsc -p tsconfig.app.json --noEmit && npx vite build
```

On a fresh clone, pytest reports 1,436 passed and 20 skipped; the vectors are 801 fixed + 5,659 seeded random = 6,460; vitest reports 7,371 passed and 1 skipped (44 files). Measured on 15 November 2026: pytest on a cache-free copy of commit 354d0f6 (its Python is unchanged in 62b9302), vitest at 62b9302. <!-- COUNT -->

Of the 20 Python skips, 3 are tests superseded by the scenario generator's own Tier B report, and 17 re-parse cached sources that live in the gitignored `.cache/` (the Vol 1 PDF, the arXiv preprint and the iSWA RAD record, the STS-34 sources, the Hassler et al. 2014 PDF and the STEREO-B HET record, and the corpus `tools/nearest/corpus.py` cuts from both standards' PDFs); with that cache present, pytest reports 1,453 passed (1,030 engine, 423 ingest) and 3 skipped. The TypeScript suite replays every shared vector in the browser engine (`web/src/engine/conformance.test.ts`), and the two engines agree to 1e-9. <!-- COUNT -->

## Architecture

LANDFALL works in two stages. At build time, one Python adapter per source fetches NASA, NOAA and CSA data and freezes it as JSON with its citation, caveats, retrieval time and SHA-256 (27 snapshots in `web/public/data/`, listed in `manifest.json`). At run time, the browser loads those files and the rules, and a TypeScript engine evaluates them: pure functions that match the Python reference engine on the shared vectors. Two pages fetch more, and only when asked: #/verify fetches the shared vectors when you press Run, and the search on #/method?s=find fetches a small word-vector model (7.9 MB) on its first use, outside the decision path. There is no server and no language model in the decision path; a service worker precaches the build, so every route reloads offline after one visit. The site is Cloudflare Workers static assets (no Worker code runs), deployed from the committed tree by `scripts/deploy.sh`.

| Path | What it is |
|---|---|
| `engine/` | Stdlib-only Python reference engine, with pytest. `engine/SPEC.md` is the contract between the rules, both engines and the scenario |
| `engine/rules/` | The rules as data: Tier A limits, Tier B indicators, the three cases, environments, the severity mapping, escalation tiers and refusals. The browser bundles the same files |
| `ingest/` | One adapter per source, plus the seeded crew simulator. `uv run python -m ingest --all` re-fetches every source and rebuilds `web/public/data/`; `--offline` replays the local cache |
| `web/` | Vite + React 19 + TypeScript app; `web/src/engine/` is the TypeScript engine |
| `hardware/` | LANDFALL BAND, a wearable concept at block level: `sensor-map.json`, `BOM.csv` |
| `tools/` | Build-time tools, not shipped and not project dependencies. `tools/nearest/` ranks NASA-STD-3001 requirements near each searched negative with potion-base-8M in a throwaway environment; its frozen output (rank only, no score) is `web/src/features/nearest/nearest.json`. `tools/find/` makes the 8-bit model copy in `web/public/assets/models/` and the frozen tokenizer and vector references behind #/method?s=find. Each folder has a README |
| `scripts/` | QA over the Chrome DevTools Protocol (`qa-mobile.mjs`, `qa-offline.mjs`), the cue-card printer (`print-card.mjs`), the deploy script, and `video/` (the demo video and project-page figures, each on-screen claim checked against the app) |
| `docs/` | The printed cue cards (`landfall-cue-card.pdf`, `.png`), the project-page text (`PROJECT_DESCRIPTION.md`) and the tester protocol (`USABILITY_TEST.md`, scored with NASA's NMSUS, Bedford and Table 5.1-1 measures) |

## Data sources

Every source, with its URL, retrieval date and SHA-256 where one applies, is in [CITATIONS.md](CITATIONS.md); its last section is generated from the shipped data and rules (`uv run python -m ingest.citations`). In the app, #/data shows each snapshot with its caveats word for word. Third-party software, fonts and the shipped model files: [THIRD_PARTY.md](THIRD_PARTY.md).

## Use of AI

Team Isaac Clarke: Guilherme Amaro (project lead: scope, design, decisions and review) and Ayra Castilho (tester). Guilherme built LANDFALL with Claude Code (Anthropic) as the coding assistant. It wrote most of the code and drafts of the documentation under his direction, and ran checks of our claims against primary sources; he set the scope and the design, made the decisions and reviewed the results.

No AI is in the decision path: every rule is data, evaluated by deterministic code. One small open model is used outside it, in two places: potion-base-8M (MinishLab, MIT; static word vectors; revision bf8b0566). It is a table of word-piece vectors: it generates no text, decides nothing and reads no crew data, and nothing else in LANDFALL reads its output.

- **At build time**, for each of our searched negatives (for example, no wearable or biosensor requirement in Vol 2 Rev F) and for the missing vital-sign alert threshold, it ranked 543 of NASA-STD-3001's 545 requirements (our PDF parsers miss [V1 5002] and [V2 10157]) by closeness in meaning to one sentence we wrote, to show where each claim comes closest to being wrong. #/band and #/method?s=gap list the five closest, in NASA's words and by rank only, under the keyword count, which stays the claim; a ranking is not proof of absence. A Claude Code review agent then read every listed statement against its PDF page. The ranking surfaced [V2 6020], which requires cabin atmosphere data to be recorded automatically, so we narrowed one claim to "No storage-capacity, retention or log-duration requirement in Vol 2 Rev F".
- **In the browser**, "Find it in NASA's words" (#/method?s=find) ranks the 57 NASA-STD-3001 requirements LANDFALL froze against your words, in a column beside a keyword search that is shown first, and shows only NASA's text. The 8-bit copy of the model (7.9 MB) is not precached; it is loaded from this site on the first search. A fixed word list, not the model, meets symptom words with "tell your Crew Medical Officer now (if that is you, the Commander)" and medication, diagnosis and cancer-risk words with the refusals written in the rules. On 24 questions written by an AI agent (Claude Code), blind to the search tool, before its first run, the expected requirement was in the model's top three for 20 (keywords alone: 16).

The model files and the build-time tools, with their licences, are listed in [THIRD_PARTY.md](THIRD_PARTY.md); `tools/nearest/README.md` and `tools/find/README.md` give the commands, hashes and measurements.

## License and disclaimers

Apache-2.0: see [LICENSE](LICENSE). LANDFALL is a hackathon demonstration and **not a medical device**: no diagnosis, no medication or dosing advice. **Not endorsed by NASA**; no NASA insignia is used. Dead Space is a video game series published by Electronic Arts; LANDFALL is not affiliated with or endorsed by Electronic Arts.
