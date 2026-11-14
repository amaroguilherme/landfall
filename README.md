# LANDFALL

*Earth-independent health navigation for exploration crews.*

NASA Space Apps Challenge 2026 — *Create Health Monitoring Software for Astronauts on Space Missions*.

**Live app:** https://landfall.landfall-web.workers.dev — static files, no backend; everything, including the rules
engine, runs in the browser.

LANDFALL checks a crew's health data onboard, against the limits NASA-STD-3001 publishes (Tier A) and against each
crewmember's own baseline (Tier B), and turns a finding into a guided case: detect, interpret, one countermeasure, a
procedure, an outcome and a tripwire that resolves the case or escalates it, first to the onboard Crew Medical Officer,
then to the flight surgeon through a delay-tolerant FHIR ground packet. The demo is a Mars surface base during solar
conjunction, when Houston cannot answer.

**Real and simulated.** The NASA-STD-3001 requirement text, the NASA and NOAA data (dosimetry, the GOES-7 October 1989
proton event, JPL Horizons light times) are real, frozen at build in `web/public/data/`. The crew, their vitals and their
actions are simulated from a fixed seed and labelled as simulated wherever they appear. Every number carries a chip that
names its basis; numbers with no published basis are marked "design choice".

| Path | What it is |
|---|---|
| `engine/` | Stdlib-only Python reference engine, with pytest. Tier A: NASA-published limits and NOAA's S-scale. Tier B: a single-case t-test against the crewmember's own baseline (Crawford & Howell 1998). `engine/SPEC.md` is the contract |
| `engine/rules/` | The rules as data (limits, personal indicators, cases, environments, severity mapping); the browser bundles the same files |
| `ingest/` | One adapter per NASA/NOAA source, plus the seeded crew simulator; `uv run python -m ingest --all` rebuilds `web/public/data/*.json` |
| `web/` | Vite + React + TypeScript app; its TypeScript engine (`web/src/engine/`) matches the Python one on the shared vectors in `engine/tests/vectors/` |
| `hardware/` | LANDFALL BAND, a wearable concept at block level (never built): sensor map and BOM |
| `api/` | Empty placeholder (`__init__.py` only; the `api` extra in `pyproject.toml` is unused). There is no API: the app needs no server |
| `docs/` | The project description |

Verify it yourself:

```bash
uv sync --all-extras
uv run pytest                                   # Python engine, rules and ingest tests
uv run python -m engine.vectors --check         # the shared conformance vectors are current
cd web && npm ci && npx vitest run              # TypeScript engine (same vectors) and app tests
npx tsc -p tsconfig.app.json --noEmit && npx vite build
```

Every source is cited in `CITATIONS.md`. Licensed under Apache-2.0 (see `LICENSE`); third-party notices in
`THIRD_PARTY.md`. Not endorsed by NASA. Not a medical device: no diagnosis, no dosing.
