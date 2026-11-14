# engine/rules: the knowledge layer

These five JSON files are everything LANDFALL knows. The Python engine, the TypeScript runtime and
the `/provenance` page all read the same files. The contract is `engine/SPEC.md` section 3.

| File | What it holds |
|---|---|
| `environments.json` | ISS, cislunar, lunar surface and Mars surface: gravity, EVA type, dose snapshot, whether the NOAA scale reaches the crew, and comms light time. |
| `thresholds.json` | Tier A rules: NASA-published FFD / PEL / POL limits with requirement IDs, Table 4.8-1 organ limits (mGy-Eq / mGy, never mSv), vehicle design requirements as `role: "context"`, NOAA S1-S5 as `OPS`, the onboard S3 rule for Mars, and the renal `TARGET` rule. Also `constants` that derived numbers point to. |
| `personal.json` | Tier B: Reliable Change Index settings (critical z 3.29, nominally two-tailed p < .001; see `rci.caveat`) and the eleven personal indicators, each with its test-retest reliability `r`. |
| `cases.json` | The three deep cases (`renal_stone`, `sleep_circadian`, `spe_shelter`): triggers, interpretation, one primary countermeasure, guided procedure, tripwire, ground packet, hand-offs and refusals. |
| `meta.json` | The vocabulary: chips, categories (with NASA glossary text), severity mapping, hazards, body regions, principles and refusals. |

## Reading a number

Every number has a `chip` and a `source` (on the object itself or the object that encloses it):

- `NASA-published`: printed in NASA-STD-3001; the `source` gives the requirement ID or table, the page, and a
  `verbatim` fragment. The test checks that fragment against the frozen snapshot in `web/public/data/`.
- `NOAA-published`: NOAA Space Weather Scales; checked against `swpc_s_scale`.
- `literature`: a paper or NASA report (for example an HRP evidence report), cited in full.
- `derived`: arithmetic on published values; `from` lists the inputs and `arithmetic` shows the sum.
- `design choice`: our number, with `rationale`. NASA publishes no in-flight alert thresholds, so every
  "approaching" level, tripwire and reliability default is ours, and it says so.

## Things that look odd and are deliberate

- The renal rule is category `TARGET`, not FFD/PEL/POL. Its numbers (risk rises below 1.5 L/day; the hydration
  target is 2.5-3 L/day of urine) come from the NASA HRP renal stone evidence report, not from a standard. It is
  capped at `caution`.
- `noaa_scale_available` is `false` at Mars. There the SPE case runs on `ops_onboard_proton_s3`, which reuses
  NOAA's S3 threshold on the onboard monitor and is labeled a design choice.
- `[V2 11040]` applies only to the surface environments: its section title says "for Partial Gravity Scenarios".
- POL values are percent of pre-mission (`100 x current / pre-mission`), matching the requirement text.
- The PVT-B reliability `r = 0.8` is a `design choice`. Basner et al. 2011 report test-retest reliability
  above 0.8 for the standard 10-min PVT, not for the 3-min PVT-B, so borrowing the number is ours.
- Case texts (`one_line`, `interpretation`) are written to be true for every trigger of the case, because a case
  opens when any one trigger reaches `caution`.

## Checking

```bash
uv run pytest engine/tests/test_rules.py -q -rs
```

The cross-checks skip, with a reason, when a snapshot has not been built yet.
