# LANDFALL

*Earth-independent health navigation for exploration crews.*

NASA Space Apps Challenge 2026 — *Create Health Monitoring Software for Astronauts on Space Missions*.

> Status: under construction during the hackathon (14–15 Nov 2026).

| Path | What it is |
|---|---|
| `engine/` | Stdlib-only Python rules engine (Tier A NASA-published limits, Tier B Reliable Change Index), with pytest |
| `ingest/` | One adapter per NASA/NOAA source; `python -m ingest --all` rebuilds `web/public/data/*.json` |
| `api/` | Optional FastAPI layer. **Never** on the demo path |
| `web/` | Vite + React + TypeScript front end; works with the network off |
| `hardware/` | LANDFALL BAND wearable concept |

```bash
uv sync --all-extras
uv run pytest
uv run python -m ingest --all
```

Licensed under Apache-2.0 (see `LICENSE`). Third-party notices in `THIRD_PARTY.md`; every source we use is cited in `CITATIONS.md`.
