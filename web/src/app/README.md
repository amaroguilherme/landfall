# LANDFALL shell: what feature agents build on

Everything here is in `src/app/`, `src/ui/`, `src/styles/`. **Do not edit those folders**; replace only
your own `src/features/<feature>/` folder. The real engine is wired: see "Mission model" below before computing anything yourself. Your folder's `index.tsx` must `export default` a component.

```tsx
import type { FeatureProps } from '../../app/router'      // { params, query }
export default function Body({ params, query }: FeatureProps) { ... }
```

| Route | Feature folder | Notes |
|---|---|---|
| `#/` | `now` | The hero. **Bundled eagerly** (not lazy): keep its top-level imports light; lazy-load heavy parts (uPlot) inside it. |
| `#/body` | `body` | |
| `#/case` and `#/case/:id` | `cases` | `params.id` is `undefined` on `#/case` (list the three cases). `#/cases` and `#/cases/:id` are aliases (`ROUTE_ALIASES` in `routes.ts`): the natural URL is never a not-found view. |
| `#/radiation` | `radiation` | Lazy. Ships as a placeholder that already shows the OPS feed; replace the folder. |
| `#/noon-sight` `#/trends` `#/downlink` `#/band` `#/provenance` `#/method` `#/data` | same names | React.lazy, prefetched on idle after the hero renders. |

Query strings work: `#/trends?crew=CM-3` gives `query.crew === 'CM-3'`. Route matching is in `routes.ts`.

## Imports at a glance

```ts
import { Link, navigate, useRoute } from '../../app/location'   // NOT from router.tsx (avoids a cycle with the hero)
import { useMission, useMetNow, useMetMinute, useMetClock, alertFromFinding, isShared, selectObservations } from '../../app/mission'
import { useScenario, useEvaluation, useCrewEvaluation, useCases, useGroundPacket,
         markHeroReady, useMarkHeroReady, useHeroTiming } from '../../app/model'
import { aggregateForRule, evaluateRuleAt, evaluatePersonalAt, partialRecord, percentOfPreMission, TRIGGER_CASE } from '../../app/evaluate'
import { packetState, packetDelivery, escalationTiers, autonomyText, CMO_ID } from '../../app/packet'
import { useOfflineReady } from '../../app/offline'
import { observationsFor, visibleObservations } from '../../app/scenarioData'
import { CASE_DEFS, CASE_IDS, caseKey } from '../../app/caseTimeline'
import { useSnapshot, useManifest, freshnessOf, formatUtc } from '../../app/data'
import { useComms, formatCommsLightTime, formatCountdown, formatEarliestReply, metToUtc, windowModelNote } from '../../app/comms'
import { RULES, getRule, getCase, getIndicator, getEnvironment, formatMet, fmtNum, sLevel, expectedFalseAlarms } from '../../app/engine'
import type { Finding, PersonalFinding, Rule, Indicator, CaseState, CaseEvent, FhirBundle } from '../../app/engine'
import { CREW, CREW_IDS, crewMember, SEVERITY_RANK, CHIPS, CHIP_DEFS, CATEGORIES, CATEGORY_DEFS, chipDef, categoryDef } from '../../app/vocab'
import type { Severity, Status, Category, ChipKind, CrewId, EnvId, Observation, Source } from '../../app/vocab'
import { ENVIRONMENTS, environment, MET_NOW_S, metDay } from '../../app/scenario'
import { Chip, CategoryBadge, SeverityBadge, FindingBadge, PartialRecordBadge, StatusBadge, Card, Panel, Num, MetTime,
         FreshnessChip, Expander, Tabs, SimulatedMarker, Citation, ReqId, EmptyState, Button, ButtonLink } from '../../ui'
```

## Engine: ONLY through `src/app/engine.ts`

The facade re-exports the **real** TypeScript engine (`web/src/engine`, proven identical to the Python reference by the
shared vectors; see `src/engine/README.md`). The shim is deleted. `ENGINE_IS_SHIM === false`.

- Shapes follow `engine/SPEC.md` section 5 (snake_case). **`Finding.why` is one string.** `CaseState` has `status`
  (`idle | detected | acting | watch | resolved | escalated | dismissed`), not `phase`.
- `expectedFalseAlarms(k, days, alpha = 0.001, kEither = 0)` (positional) gives `{expected, per_day, every_n_days, text, expected_cautions,
  cautions_per_day, caution_every_n_days, caution_text, assumes, k_indicators, days, alpha, k_either}` (flags count either direction;
  cautions only the worse one, both for the `kEither` indicators whose `worse` is `either`: glucose). `MissionEvaluation.tierBAlertingIndicators` is k.
- Severity follows NASA-STD-3001 Vol 2 Table 10.3-1 (SPEC section 2, D1): the ONLY Warning is OPS S3 or above (the shelter action);
  FFD / PEL / POL are Caution at most (the VO2max floors read "EVA assignment not cleared"); TARGET and Tier B Caution at most; S1-S2
  Advisory. LANDFALL never emits Emergency. `evaluateRule`'s `ctx` (`{eva}`) no longer changes anything.
- MET prints `d/hh:mm:ss` with no leading zeros in the day field (F.6.1 f, D2): `412/14:20:00`; a day-count duration uses the same
  format (`11/05:59:51`). Never slice the string by position: split on `/`.
- Never call `commsEta` / `buildGroundPacket` / `caseReduce` yourself for the scenario: use `useComms`, `useGroundPacket`,
  `useCases` below (they pass the comms table, the mission epoch and the trigger lookup the engine needs).
- `RULES` holds the five rules files. Validate env ids with `getEnvironment(RULES, id)` (the engine is silent on typos;
  `environment(id)` in `scenario.ts` already does it and throws on an unknown id).
- Another workflow is switching the Tier B statistic inside `src/engine` (Crawford & Howell). Read Tier B results from the
  `PersonalFinding` the hooks give you (`status`, `severity`, `limit`, `margin`, `why`, `rci`); do not recompute the statistic.

## Mission model: `src/app/model.tsx` (+ pure `scenarioData.ts`, `evaluate.ts`, `caseTimeline.ts`)

Everything below runs in the browser on the frozen snapshots; nothing is precomputed at build.

### `useScenario()`

`{ status: 'loading'|'ready'|'missing'|'error', index: ScenarioIndex | null, sim, replay, error }`

- `index.series: Map<'CM-3|urine_volume_24h' | '|proton_flux_10mev', Observation[]>` (t-sorted; crew id empty = vehicle sensor).
  Use `observationsFor(index, state.observations, crewId, variable)` to get a crewmember's own + vehicle + runtime values.
- `index.epochIso` (`2027-01-31T02:40:00Z`), `index.nowMet` (`35648400`), `index.baselineDays` (`[368, 381]`), `index.variables`,
  `index.episodes`, `index.replay: {snapshot: 'swpc_spe_replay'|'sim_crew'|null, first_t, last_t, n}`.
- `t` = MET second the value became AVAILABLE (end of its window). `cabin_ppco2` hourly means are shifted to their window end.
- After scenario now, `proton_flux_10mev` continues with the **real GOES-7 October 1989** series from `swpc_spe_replay`, time-shifted
  with sim_crew's own mapping (identical to sim_crew's `after_now` copy; a test proves it), up to MET 0424/19:15. These samples
  only become visible when the clock passes them. Label them as a replay of a real event (`provenance: 'replay'`).

### `useEvaluation()` / `useCrewEvaluation(crewId?)`

`useEvaluation()` gives `{ status, evaluation: MissionEvaluation | null, envId, t, error }` for the store's env at the clock minute
(store observations from Noon Sight / manual entry included; switching env re-evaluates). `useCrewEvaluation()` gives
`evaluation.crew[crewId ?? state.crewId]` or null.

```ts
MissionEvaluation = { envId, t, eva: false, ops: OpsFeed, crew: Record<CrewId, CrewEvaluation>, alerts: AlertItem[], tierBAlertingIndicators }
CrewEvaluation    = { crewId, tierA: RuleEvaluation[] /* FFD, PEL, POL, TARGET alert rules */, context: RuleEvaluation[] /* role context: never fire */, tierB: PersonalEvaluation[] }
RuleEvaluation    = { rule: Rule, finding: Finding, input: Aggregate }
Aggregate         = { value: number|null, unit, t: number|null, n, basis: string /* plain English */, unit_mismatch: number,
                      partial: boolean, record_start: number|null, window_start: number|null /* summed dose windows, D15 */ }
PersonalEvaluation= { indicator: Indicator, finding: PersonalFinding, baseline: number[] /* fixed days 368-381 */, current: Observation|null }
OpsFeed           = { kind: 'onboard_monitor' /* Mars: noaa_scale_available false */ | 'noaa', label, flux, t, s_level /* engine sLevel */,
                      provenance: 'simulated'|'replay'|null, findings: RuleEvaluation[] /* every OPS rule */, active: RuleEvaluation|null /* highest S rule outside */ }
```

- Window helper `aggregateForRule(rule, observations, t)`: `instant` latest; `rolling_mean PT1H` mean of values available in
  (t - 1 h, t]; `cumulative` sum of dose reports in the window (a 24-h total is taken as is, never summed twice); `career`
  latest "to date" record for `career_effective_dose`, else the sum of reports; `ratio_to_baseline` value already in % of
  pre-mission (`percentOfPreMission(current, pre)` converts raw values). A year is 365 d (design choice).
- **Partial records (D15):** a summed dose window (cumulative, or a career sum) whose record starts after the window opens has
  `input.partial: true`: unlogged time is not zero dose, so the sum is a lower bound. `outside` / `approaching` on it are conclusive;
  `within` is not: `partialRecord(ev)` is true and the view shows the cyan "Partial record" tag (`<FindingBadge finding partial/>` or
  `<PartialRecordBadge/>`) with the logged sum against the limit, never "within limit".
- **Honest gaps:** the scenario has no organ dose (mGy-Eq / mGy) and no BMD, so those rules are `insufficient_data` (render cyan).
  A rule that does not apply in this env is `not_applicable` (gray). Units are never converted; a value in another unit is
  set aside and counted in `input.unit_mismatch`.
- `insufficient_data` / `stale` have severity `advisory` but must be drawn **cyan** (meta.json `no_data.colour_note`).
  `<FindingBadge finding/>` already does this.
- Values at scenario now (Mars): OPS S3 at 1,100 pfu (**warning**, the only one). CM-2 `ffd_vo2max_surface_eva` 35.1 outside
  (caution, "EVA assignment not cleared"); at ISS / cislunar `ffd_vo2max_microgravity_eva` within. Tier B: what the simulator's own
  report (`sim_crew` `data.self_check.tier_b`) flags today (at now: CM-1 sleep midpoint shift, caution); tests follow that report,
  never a hand-typed day. Cabin ppCO2 within. Career doses within.
- OPS feed labels (D3): at Mars the reading is the external space-weather monitor above the atmosphere, in Mars orbit, relayed
  locally ([V2 6165]); `ops.label` is sim_crew's own label of `proton_flux_10mev`. The vehicle's radiation monitoring system raises
  the alarm ([V2 6164]); LANDFALL opens the health case. (`ops.kind` keeps the value `'onboard_monitor'` for compatibility.)

### Annunciator (mission bar)

`<MissionEngine/>` (mounted once in `App.tsx`) publishes `evaluation.alerts` under source `'mission'`. **Features do not need to
publish findings.** Policy (`alertsFor` in `evaluate.ts`): one entry per crewmember x rule / indicator at advisory or above;
never context rules, private indicators (mood) or data-quality states; OPS is one crew-wide entry for the highest S rule
outside. Ids are `${crew_id}:${rule_id}` (`ALL:ops_onboard_proton_s3`), href `#/case/<case_id>` or `#/body`. If you publish your
own list, reuse these ids so entries merge.

- **Plain-language titles (D7, D11):** a finding without a deep case shows its rules `action.label` as `title` ("EVA assignment not
  cleared"), the rule label and status as `detail`, and `action_text` (its one-line action). No rule id appears in a title.
- **Grouping (D16):** `AlertItem.group` is `${crew_id}:case:${case_id}` for a finding that is a trigger of a case (`TRIGGER_CASE`, from
  cases.json); any other finding is its own group. `selectAlertGroups(state)` gives one line per group (`{id, severity, title, crew_id,
  case_id, alerts[], acknowledged}`); `selectAnnunciator` counts lines, and NEW counts lines with an unacknowledged finding (a new
  finding makes its line new again). The bulk button acknowledges cautions and advisories only: each Warning is acknowledged on its
  own line. `selectAlerts` stays flat (one entry per finding) for the body map.
- At now on Mars the bar reads **E 0 · W 1 · C 2 · A 1 · 4 NEW** (W = the crew-wide S3 shelter case; C = CM-2 "EVA assignment not
  cleared" and CM-1's sleep case; A = CM-2's urine output approaching the renal target). E and NEW stay visible on every viewport
  (F.4.2 f). The assertive live region names a new Warning and is cleared when that Warning goes (e.g. after an environment switch).

### `useCases()`

```ts
const { status, cases, get, dispatch, resetScenario, t, error } = useCases()
cases: CaseView[]            // 12 views: every crewmember x case, idle ones included, folded at t
get(caseId, crewId?)         // one view (default crewmember: the store's), or null
dispatch(caseId, event, crewId?)  // event = {type:'SELECT', countermeasure_id} | {type:'STEP', step_id, input?} |
                                  //         {type:'DECLINE', step_id, reason} | {type:'OUTCOME', text} | {type:'DISMISS', reason}
                                  //         (+ optional t; default the clock). OUTCOME is refused (required_steps_pending) until every
                                  //         required step is done or declined; a red-flag STEP answered yes escalates at once.
resetScenario()              // drop user events, runtime observations, Noon Sights, logbook, acks; clock back to now
CaseView = { key: 'CM-1:spe_shelter', crewId, caseId, def: CaseDef, state: CaseState, logOrigins: ('auto'|'scenario'|'user'|'tick')[], opening: {t, finding, trigger} | null }
scripted: Observation[]      // the seeded crew's answers as observations (renal red-flag "no" = 0, unit yes/no); the ground packet includes them
CaseState (engine) = { status, spec {step_ids, required_step_ids, red_flag_step_ids, packet_step_ids, step_inputs, tripwire, escalation},
             opened_at, finding, countermeasure_id, steps_done[], steps_declined[] {step_id, t, reason}, outcome, watch_started_at, reassess_at,
             tripwire_obs[], tripwire_result, escalation {t, reason: 'tripwire'|'red_flag', step_id, tiers} | null,
             packet_queued_at /* null = Prepared, set = Queued */, closed_at, dismiss_reason, updated_at, log[] }
```

- Each state is a fold of the engine's `caseReduce`: **auto OPEN** (a trigger's first finding at caution or above, found by the
  engine from the data), the **seeded simulated crew actions**, **user events**, and **synthesized tripwire TICKs** (tripwire
  observations of the crewmember + vehicle sensors; one TICK exactly at `reassess_at`). `logOrigins[i]` labels `state.log[i]`.
  A rejected event stays in `state.log` with `error` set (engine behaviour): show it.
- Scenario timeline (Mars, now): `CM-3:renal_stone` opened 399/00:00:00 by `target_urine_output_24h`, hydration selected,
  steps r1 r3, the required red-flag question r4 answered "no" (SPEC 7), r5, outcome 410/08:00 -> **watch**, tripwire armed,
  `reassess_at` 413/08:00 (resolves later: output recovered). `CM-1:sleep_circadian` opens by the sleep midpoint shift on the day
  the simulator's Tier B flags it (a chance flag on day 383 on the current data, before the scripted shift), light countermeasure
  selected, steps s1-s3 -> **acting**. `CM-3:sleep_circadian` opens by a chance flag (no episode scripted) -> **detected**. Both are
  listed in `sim_crew` `data.self_check.unscripted_case_openings`, and the hero labels them as chance flags.
  `*:spe_shelter` opened **412/14:15:00** for all four crewmembers by `ops_onboard_proton_s3` (Mars; `ops_noaa_s3`
  elsewhere) -> **detected** (Warning): the crew acts in the demo. An OUTCOME needs the shelter confirmations p2 and p3 done or
  declined; after it, the T+6 h tripwire is judged on the replay (still S3: `escalated` = stay sheltered, both tiers).
- Moving the clock back shows each case as it was then (events after the clock are not applied yet).
- `state.cases` / `setCase` in the store are DEPRECATED (nothing writes them); use `useCases()`.

### Ground packet state and escalation tiers: `src/app/packet.ts` (one wording for every view)

- `packetState(caseState)` gives `{id: 'not_open'|'no_packet'|'prepared'|'queued', label, when, queuedAt, reason: 'released'|'escalated'|null}`.
  Labels are meta.json `packet_states` ("Prepared (held on board)", "Queued"), decided by the engine's `packet_queued_at` (a crew
  release step, e.g. SPE p6, or escalation). **The hero, the case page and Downlink must all use it**, so one packet is never shown
  in two states. `packetDelivery(state, comms, t)` is the one sentence on when it reaches the ground ("Sent when the link resumes, in
  11 d 06 h" / "Sent at once: the link is up ..." / for Prepared, what queues it). Write `Ground packet: <label>. <delivery>.`
- `escalationTiers(comms, t)` gives the two tiers of meta.json `escalation` with their timing for this link: tier 1, the Crew Medical
  Officer (`crew: CMO_ID`, "CM-4"), now; tier 2, the flight surgeon, through the ground packet, at once at AOS or queued until the link
  resumes. `autonomyText(comms)` is meta.json `escalation.autonomy` for the link (AOS: the ground has the case within the round trip
  and the crew follows Mission Control; LOS: the crew acts onboard with the CMO).
- The renal case's `escalation.flight_surgeon_note` (D12, the only place a medication is named) is shown on Downlink only.

### Hero timing (the honest "LANDFALL answered in N ms")

- **Measured on every visit, and on demand:** the hero runs the onboard path on the engine (`runOnboard` in
  `features/now/model.ts`: evaluate the SPE trigger rule on the latest monitor reading, OPEN a fresh case), paints the primary action
  from that run, and reads the clock after the browser painted (double rAF): "Guidance on screen in 0.025 s". It re-runs when the
  environment or crewmember changes and on "Measure again" / "Replay", so a deep link never shows a dash. `<html data-onboard-answer-ms>`
  carries the latest value. The onboard card lights first (within 0.3 s); Houston's counter animates after it.
- Page-level timing (below) still exists for QA (`scripts/qa-offline.mjs` waits for `data-hero-ready-ms`).

- The first time the fold processes a `spe_shelter` OPEN, `performance.now()` is recorded. **The hero must read cases through
  `useCases()`** so that OPEN is processed when the hero mounts.
- When the Now route has PAINTED the primary countermeasure, call `useMarkHeroReady(true)` (double rAF after commit) or
  `markHeroReady()`. That sets `<html data-hero-ready-ms>` (rounded `performance.now()`), plus `data-spe-open-ms` and
  `data-hero-answer-ms`. First call wins.
- `useHeroTiming()` gives `{ speOpenProcessedAtMs, heroReadyAtMs, answerMs }` and re-renders when the measurement lands.
  Display `answerMs` as measured in this browser; never a constant.

### `useGroundPacket(caseId, crewId?)`

`{ status, bundle: FhirBundle | null, caseView, caseState, caseOpen, consent, withheld: string[], missionEpoch, t, error }`.
Built by the engine's `buildGroundPacket(caseState, scenario + runtime observations up to t, store consent, env, t,
sim_crew met_epoch_utc)`. `withheld` lists escalation variables the consent keeps off the ground (mood unless shared).

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
  `swpc_protons_live` is the real NOAA feed frozen at build (stale): it is NOT the scenario's flux; show it only as "conditions at build".
- After first render, every route chunk and every manifest snapshot is prefetched (skipped when Save-Data is on), so the app keeps working offline.
- `index.html` has a CSP (`connect-src 'self'`, `img-src 'self' data: blob:`, `font-src 'self'`): any request to another origin is blocked by the browser. External `<a href>` links still work.

## Mission store: `src/app/mission.tsx`

```ts
const { state, setEnv, setCrew, setConsent, addObservations, addLog, addNoonSight,
        publishAlerts, acknowledge, addCaseEvent, resetScenario, reset } = useMission()
const t = useMetNow()                          // MET seconds; re-renders once per second
const m = useMetMinute()                       // MET floored to the minute; re-renders once per minute
const { metNow, running, pause, resume, set, reset } = useMetClock()
```

- `state.envId` (default `'mars_surface'`), `state.crewId` (default `'CM-1'`), `state.consent[crewId][variable]` (all `true` except `mood: false`;
  use `isShared(consent, variable)`, where unknown variables are shared and mood never is), `state.observations` (runtime-added, SPEC 4 shape:
  `{crew_id: CrewId | null, variable, value: number, unit, t, source, provenance}`; **these feed every evaluation and case**: a manual
  low `urine_volume_24h` for CM-3 turns `target_urine_output_24h` outside and lands in the renal tripwire),
  `state.logbook: LogEntry[] {id, t, crew_id|'ALL', kind, text, case_id?}`, `state.noonSights: NoonSightResult[] {id, crew_id, t, observations, details?}`
  (`addNoonSight` also appends its observations), `state.caseEvents` (user case events; use `useCases().dispatch`),
  `state.alerts`, `state.acknowledged`.
- `resetScenario()` keeps env, crew and consent; `reset()` resets everything. The mission bar has a reset button (desktop) that asks
  for confirmation first (it drops the user's work).
- `useOfflineReady()` (`offline.ts`) is true once the service worker holds a complete copy of the build; the footer and the comms
  popover say "Works offline after first load" only then. Never claim offline before it is true.
- Selectors (pure): `selectEnv`, `selectCrew`, `selectConsent`, `selectObservations(state, {crewId?, variable?})`, `selectLogbook(state, crewId?)`,
  `selectAlerts` (flat), `selectAlertGroups` (D16 lines), `selectAnnunciator` gives `{emergency, warning, caution, advisory,
  unacknowledged, evaluated}` counted per line.

## Scenario and comms

- `MET_NOW_S = 35_648_400` (MET 412/14:20:00); `SIM_FIRST_DAY 368`, `SIM_LAST_DAY 412`, baseline days 368 to 381; `metDay(t)`.
- `ENVIRONMENTS` are `engine/rules/environments.json` via `getEnvironment(RULES, id)`; `environment(id)` throws on an unknown id.
- `useComms(envId?, t?)` (defaults: store env, scenario clock; recomputed per minute) gives
  `{link: 'AOS'|'LOS', one_way_s, round_trip_s, blocked, reason, resumes_at, earliest_reply_s, light_time_source: 'table'|'environment_max'|null,
  env, basis: 'snapshot'|'static'|'fallback', snapshotId, snapshotStatus, snapshot, range, window, metEpochUtc}`, all from the engine's `commsEta`.
  Mars: `horizons_mars_comms` light time and the conjunction windows mapped to MET via `sim_crew.data.calendar.met_epoch_utc`. The
  windows are MODELLED (D13): Horizons Sun-Earth-Mars elongation below a threshold fitted to NASA/JPL published command moratoria;
  `windowModel` carries the fit `{thresholdDeg, rmsDays, maxAbsDays, moratoria}` and `windowModelNote(windowModel)` the wording
  ("modelled from JPL Horizons geometry, edges fitted to 6 NASA/JPL published command moratoria (RMS 0.79 d)"). Never "real window".
  (at now: LOS, 2028-03-12 12:00Z to 2028-03-29 23:00Z, OWLT about 19 min 51 s, link back in 11 d 06 h, `earliest_reply_s` adds the
  round trip at `resumes_at`). Moon: `horizons_moon_comms` (environments.json `comms_snapshot`), about 1.2-1.36 s, never blocked.
  ISS / cislunar: the environments.json envelope (engine uses its max). A missing snapshot gives `basis: 'fallback'`, light time null (cyan).
  `formatCommsLightTime(c, roundTrip?)`, `formatEarliestReply(c)`, `formatCountdown(seconds)` give `"11 d 06 h"`, and `metToUtc(t, epochMs)`.

## Vocabulary: `src/app/vocab.ts`

- Chips and categories are **read from `engine/rules/meta.json`**: `CHIPS` / `CHIP_DEFS {id, source_kind, definition}`, `CATEGORIES` /
  `CATEGORY_DEFS {id, name, shape, glossary, source}`, `chipDef(label)`, `chipSourceKind(label)`, `categoryDef(id)`. Never hard-code a chip
  list: a chip renamed in meta.json (e.g. "NASA brief" -> "NASA report") renders correctly because `<Chip>` and its glyph key on `source_kind`.
- `TARGET` is a category (rule `target_urine_output_24h`: a literature countermeasure target, NOT a NASA limit, capped at caution);
  `<CategoryBadge category="TARGET"/>` has its own bullseye glyph and a dotted border.
- `ChipKind` is `string` (the rules own the list); `Category` is the engine's union (`FFD | PEL | POL | OPS | PERSONAL | TARGET | string`).

## UI primitives: `src/ui`

| Component | Use |
|---|---|
| `<Num value unit digits? signed? arrow? severity? unitLabel?/>` | **Every number.** DM Mono, tabular, U+2212 minus; `null` renders "—" flagged no-data (cyan). `arrow="up"` + `severity="caution"\|"warning"` = Appendix F F.4.3.1 d out-of-threshold arrow. A real (zero-width) space separates value and unit, so copied text reads "2026 µGy/day". |
| `<MetTime t label?/>` | MET `d/hh:mm:ss` (no leading zeros in the day field, F.6.1 f) via the engine's `formatMet`. |
| `<Chip kind={rule.chip}/>` | Provenance chip; label, definition and glyph from meta.json (keyed by `source_kind`); neutral colour, distinct glyph + border (dashed + hatched = design choice). `kind` null/undefined renders nothing. |
| `<CategoryBadge category="FFD" long?/>` | FFD floor / PEL ceiling / POL delta / OPS scale / PERSONAL baseline / TARGET bullseye glyphs; name and shape from meta.json. |
| `<SeverityBadge severity label? solid? size?/>` | Icon (circle / triangle / octagon) + text. `solid` = lit. |
| `<FindingBadge finding partial?/>` | Use for engine Findings: stale / insufficient_data (cyan) and not_applicable (gray) override severity colour; `partial` (D15) turns a "within" into the cyan "Partial record" tag (`<PartialRecordBadge/>`). |
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
| Icons | `SeverityIcon, CategoryGlyph, ChipGlyph, ClockIcon, StaleIcon, UnknownIcon, UnavailableIcon, AntennaIcon, SunIcon, ChevronIcon, ExternalIcon, PauseIcon, PlayIcon, ResetIcon, ArrowIcon` |

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
| `--lf-missionbar-offset` | measured | The mission bar's real height (ResizeObserver), set on `<html>`; `scroll-padding-top` uses it, so anchors clear the sticky bar on every viewport. Use it for any sticky element below the bar. |

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
