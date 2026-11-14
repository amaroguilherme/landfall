# LANDFALL shell: what feature agents build on

Everything here is in `src/app/`, `src/ui/`, `src/styles/`. **Do not edit those folders**; replace only
your own `src/features/<feature>/` folder. Your folder's `index.tsx` must `export default` a component.

```tsx
import type { FeatureProps } from '../../app/router'      // { params, query }
export default function Body({ params, query }: FeatureProps) { ... }
```

| Route | Feature folder | Notes |
|---|---|---|
| `#/` | `now` | The hero. **Bundled eagerly** (not lazy): keep its top-level imports light; lazy-load heavy parts (uPlot) inside it. |
| `#/body` | `body` | |
| `#/case` and `#/case/:id` | `cases` | `params.id` is `undefined` on `#/case` (list the three cases). |
| `#/noon-sight` `#/trends` `#/downlink` `#/band` `#/provenance` `#/method` `#/data` | same names | React.lazy, prefetched on idle after the hero renders. |

Query strings work: `#/trends?crew=CM-3` gives `query.crew === 'CM-3'`. Route matching is in `routes.ts`.

## Imports at a glance

```ts
import { Link, navigate, useRoute } from '../../app/location'   // NOT from router.tsx (avoids a cycle with the hero)
import { useMission, useMetNow, useMetClock, alertFromFinding, isShared, selectObservations } from '../../app/mission'
import { useSnapshot, useManifest, freshnessOf, formatUtc } from '../../app/data'
import { useComms, formatCommsLightTime, formatCountdown, metToUtc } from '../../app/comms'
import { formatMet, sLevel, evaluateRule, rci, caseReduce, buildGroundPacket, commsEta, ENGINE_IS_SHIM } from '../../app/engine'
import type { Finding, Rule, CaseState, CaseEvent } from '../../app/engine'
import { CREW, CREW_IDS, crewMember, SEVERITY_RANK } from '../../app/vocab'
import type { Severity, Status, Category, ChipKind, CrewId, EnvId, Observation, Source } from '../../app/vocab'
import { ENVIRONMENTS, environment, MET_NOW_S, metDay } from '../../app/scenario'
import { Chip, CategoryBadge, SeverityBadge, FindingBadge, StatusBadge, Card, Panel, Num, MetTime,
         FreshnessChip, Expander, Tabs, SimulatedMarker, Citation, ReqId, EmptyState, Button, ButtonLink } from '../../ui'
```

## Engine: ONLY through `src/app/engine.ts`

`web/src/engine/` did not exist when the shell was built, so the facade re-exports `engine-shim.ts`:

- **Exact per SPEC 5:** `formatMet(s)` gives `"0412/14:20:00"`; `sLevel(pfu)` gives 0 to 5 (inclusive thresholds 10, 1e2, 1e3, 1e4, 1e5; throws on non-finite);
  `expectedFalseAlarms(k, days, alpha=0.001)` gives `{expected, one_every_days}`.
- **Fallback:** `commsEta(env, t, table?)` linearly interpolates the light time and finds blackout windows.
- **STUBS** (always `status: 'insufficient_data'`, `severity: 'advisory'`): `evaluateRule`, `evaluatePersonal`, `rci`,
  `caseReduce` (never transitions; appends an `error` log entry), `buildGroundPacket` (empty FHIR collection).
  `ENGINE_IS_SHIM === true` while this is the case; show nothing that pretends otherwise.
- Types follow SPEC field names (snake_case): `Finding {rule_id, tier, category, status, severity, value, unit, limit, margin, chip, source, why: string[]}`.
  Rules JSON lives in `../../../engine/rules/*.json` (import it with `import.meta.glob(..., {eager: true, import: 'default'})` if you need it before the engine lands).

## Data: `src/app/data.ts`

```ts
const s = useSnapshot<MyShape>('swpc_s_scale')   // { status: 'loading'|'ready'|'missing'|'error', snapshot, data, error }
const m = useManifest()                            // { status, manifest, entries: ManifestEntry[], error }
```

- Fetches same-origin `/data/<id>.json` once per session (in-memory cache shared by everyone; `loadSnapshot(id)` is the promise form, `peekSnapshot(id)` the sync peek).
- A file absent from the build gives `'missing'`, never a spinner forever. Render it with `<FreshnessChip status="missing" id="..."/>`
  or `<EmptyState kind="missing">` (both cite `[V2 10020]`).
- `Snapshot<T>` mirrors `ingest/common.py`: `{schema, id, adapter, title, source{publisher,name,url,access_urls,license,citation},
  retrieved_at, coverage{start,stop,cadence}, freshness{kind,stale_after}, provenance, caveats[], data}`.
- `freshnessOf(meta, status, now?)` gives `{state: 'frozen'|'stale'|'missing'|'unavailable'|'unknown'|'loading', label, detail, kind, retrievedAt, ageS}`.
  It is judged against the real wall clock, so live feeds show STALE weeks after the build. That is correct and honest.
- After first render, every route chunk and every manifest snapshot is prefetched (skipped when Save-Data is on), so the app keeps working offline.
- `index.html` has a CSP (`connect-src 'self'`, `img-src 'self' data: blob:`, `font-src 'self'`): any request to another origin is blocked by the browser. External `<a href>` links still work.

## Mission store: `src/app/mission.tsx`

```ts
const { state, setEnv, setCrew, setConsent, addObservations, addLog, addNoonSight,
        publishAlerts, acknowledge, setCase, reset } = useMission()
const t = useMetNow()                          // MET seconds; re-renders once per second (separate store, no global re-render)
const { metNow, running, pause, resume, set, reset } = useMetClock()
```

- `state.envId` (default `'mars_surface'`), `state.crewId` (default `'CM-1'`), `state.consent[crewId][variable]` (all `true` except `mood: false`;
  use `isShared(consent, variable)`, where unknown variables are shared and mood never is), `state.observations` (runtime-added, SPEC 4 shape),
  `state.logbook: LogEntry[] {id, t, crew_id|'ALL', kind, text, case_id?}`, `state.noonSights: NoonSightResult[] {id, crew_id, t, observations, details?}`
  (`addNoonSight` also appends its observations), `state.cases: Record<key, CaseState>` (`setCase(key, caseState)`; use key `${crew_id}:${case_id}`),
  `state.alerts`, `state.acknowledged`.
- **Annunciator:** the mission bar counts what features publish. Publish your full current list under your own source key and it
  replaces your previous list: `publishAlerts('now', [alertFromFinding(f, {title, crew_id: 'ALL', href: '#/case/spe_shelter', t})])`.
  Ids should be stable (`${crew_id}:${rule_id}`). Duplicates across sources merge (highest severity wins). Until any source publishes,
  the bar shows `W – C – A –` (not evaluated). E is always 0 (LANDFALL never raises Emergency-class alarms).
  Severities: `nominal` is not counted; `advisory` / `caution` / `warning` light A / C / W.
- Selectors (pure): `selectEnv`, `selectCrew`, `selectConsent`, `selectObservations(state, {crewId?, variable?})`, `selectLogbook(state, crewId?)`,
  `selectAlerts`, `selectAnnunciator` gives `{emergency, warning, caution, advisory, unacknowledged, evaluated}`.

## Scenario and comms

- `MET_NOW_S = 35_648_400` (MET 0412/14:20:00); `SIM_FIRST_DAY 368`, `SIM_LAST_DAY 412`, baseline days 368 to 381; `metDay(t)`.
- `ENVIRONMENTS` come from `engine/rules/environments.json` at build time (SPEC 3.1 fallback if absent); `environment(id)`.
- `useComms(envId, t)` gives `{link: 'AOS'|'LOS', one_way_s, round_trip_s, blocked, reason, resumes_at, window, basis, snapshot, snapshotStatus, metEpochUtc, range}`.
  Mars uses `horizons_mars_comms` (rows by column name, conjunction windows) mapped to MET via `sim_crew.data.calendar.met_epoch_utc`.
  At scenario now: LOS, solar conjunction 2028-03-12 12:00Z to 2028-03-29 23:00Z, OWLT about 19 min 51 s, link back in 11 d 06 h.
  `formatCommsLightTime(c, roundTrip?)`, `formatCountdown(seconds)` give `"11 d 06 h"`, and `metToUtc(t, epochMs)`.

## UI primitives: `src/ui`

| Component | Use |
|---|---|
| `<Num value unit digits? signed? arrow? severity? unitLabel?/>` | **Every number.** DM Mono, tabular, U+2212 minus; `null` renders "—" flagged no-data (cyan). `arrow="up"` + `severity="caution"\|"warning"` = Appendix F F.4.3.1 d out-of-threshold arrow. |
| `<MetTime t label?/>` | MET `dddd/hh:mm:ss` via the engine's `formatMet`. |
| `<Chip kind="NASA-published"/>` | Provenance chip; 6 kinds, neutral colour, distinct glyph + border (dashed + hatched = design choice). |
| `<CategoryBadge category="FFD" long?/>` | FFD floor / PEL ceiling / POL delta / OPS scale / PERSONAL baseline glyphs. |
| `<SeverityBadge severity label? solid? size?/>` | Icon (circle / triangle / octagon) + text. `solid` = lit. |
| `<FindingBadge finding/>` | Use for engine Findings: stale / insufficient_data (cyan) and not_applicable (gray) override severity colour. |
| `<StatusBadge status/>` | Data-quality badge. |
| `<FreshnessChip meta status id? source? unavailable? compact?/>` | `[V2 10020]`: kind + "frozen at build" + retrieved_at; STALE / MISSING / UNKNOWN (cyan), UNAVAILABLE (gray). Pass `meta={snapshot}` and `status` from `useSnapshot`. |
| `<Citation source={rule.source}/>` or `<Citation doc requirementId section url/>` | Renders all six SPEC source kinds; `<ReqId id="V1 4030"/>` gives `[V1 4030]`. External links open in a new tab. |
| `<SimulatedMarker variant="inline"\|"banner"/>` | Required on any panel showing simulated crew data (the mission bar has a page-wide strip too). |
| `<Panel title eyebrow? actions? footer? headingLevel?/>` | Page section (h2 by default). Put source + FreshnessChip in `footer`. |
| `<Card title? eyebrow? actions? severity? as?/>` | `severity` adds a coloured left rule; always add a SeverityBadge too. |
| `<Expander summary="Why this fired">` | Native `<details>`. |
| `<Tabs label tabs=[{id,label,content}] value? onChange?/>` | ARIA tabs, arrow keys. |
| `<EmptyState kind="placeholder"\|"unavailable"\|"missing"\|"error"\|"loading" title headingLevel?/>` | |
| `<Button variant="primary"\|"secondary"\|"ghost">`, `<ButtonLink href>` | **Actions are dark green** (`--lf-action`, Appendix F Table F.5-2). Never make an action red or blue: red is Warning, blue is Advisory. |
| Icons | `SeverityIcon, CategoryGlyph, ChipGlyph, ClockIcon, StaleIcon, UnknownIcon, UnavailableIcon, AntennaIcon, SunIcon, ChevronIcon, ExternalIcon, PauseIcon, PlayIcon, ArrowIcon` |

Use one `<h1>` per view (your page title). The mission bar and nav have none.

## Tokens: `src/styles/tokens.css` (Appendix F colour semantics, from `std_vol2_requirements.appendix_f_colors`)

| Token | Value | Meaning |
|---|---|---|
| `--lf-sev-warning` / `--lf-sev-emergency` | `#ff7066` | **Red is reserved** for Warning/Emergency. Nothing else may be red. |
| `--lf-sev-caution` | `#ffd23f` | Caution (yellow) |
| `--lf-sev-advisory` | `#6cb4ff` | Advisory (blue) |
| `--lf-sev-nominal` | `#d1d1d1` | Nominal is neutral by design |
| `--lf-on-sev-*` | | text colour on a filled severity background |
| `--lf-data-stale` | `#3fd6e6` | Cyan: missing / stale / unknown data |
| `--lf-data-unavailable` | `#a3a3a8` | Gray: unavailable / not applicable |
| `--lf-procedure` | `#ea7dff` | Magenta: guided procedure steps (Table F.5-2) |
| `--lf-focus` | `#5cff7a` | Bright green focus outline (global, do not override) |
| `--lf-action`, `--lf-action-hover`, `--lf-action-edge`, `--lf-action-text` | `#146c43`, `#0f5a37`, `#3fae6f`, `#fff` | Buttons and actions: dark green per Appendix F Table F.5-2 (blue = Advisory, red = Warning; never use either for actions) |
| `--lf-bg`, `--lf-surface-1..3`, `--lf-border`, `--lf-border-subtle`, `--lf-border-strong` | carbon scale | |
| `--lf-text`, `--lf-text-2`, `--lf-text-muted` | `#fff`, `#d1d1d1`, `#b9b9bb` | all at least 9:1 on `--lf-bg` |
| `--lf-font-ui` (Inter), `--lf-font-heading` (Public Sans), `--lf-font-mono` (DM Mono) | | Weights loaded: Inter 400/600, Public Sans 700, DM Mono 400/500. Stay within them. |
| `--lf-space-0-5 … --lf-space-6`, `--lf-radius`, `--lf-text-xs … --lf-text-2xl`, `--lf-max-width` | | |

Charts: use the severity tokens only for out-of-limit marks, cyan for gaps/stale, and neutral greys for series.
Label historical vs live (F.5.8 b). Respect `prefers-reduced-motion` (the global CSS already zeroes transitions).

## Checking your work: mobile screenshots

Headless Chrome on macOS will not make a window narrower than about 500 px, so `--window-size=390,844` lays the page out wider
than 390 px and crops it. For a true 390 px viewport, put a same-origin iframe harness into **your** outDir and screenshot that:

```bash
cat > /tmp/landfall-dist-<NAME>/__mobile.html <<'EOF'
<!doctype html><html><body style="margin:0;background:#000"><iframe id="f" width="390" height="844" style="border:0"></iframe>
<script>document.getElementById('f').src='/'+(location.hash||'#/')</script></body></html>
EOF
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --virtual-time-budget=8000 --window-size=600,844 --screenshot=/tmp/landfall-<NAME>-mobile.png \
  "http://localhost:<PORT>/__mobile.html#/<route>"
```

The left 390 px of the PNG is the phone viewport.
