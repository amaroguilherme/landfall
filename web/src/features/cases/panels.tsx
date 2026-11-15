// Case-specific panels: renal (urine trend vs the case floor, the bone limit that needs a scan),
// sleep (PVT-B lapses vs the personal band and its smallest flaggable change, the lighting
// countermeasure) and SPE (the flux and its S-level, the ground link and what the packet waits for,
// dose accounting against Table 4.8-1 with partial records shown as such; the S-level history and the
// design-reference requirement fold away under their own titles).
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { RULES, getIndicator, getRule, sLevel } from '../../app/engine'
import type { Rule } from '../../app/engine'
import { useComms } from '../../app/comms'
import { useSnapshot } from '../../app/data'
import type { SnapshotState } from '../../app/data'
import { evaluatePersonalAt, evaluateRuleAt, testScaleWords } from '../../app/evaluate'
import type { CrewEvaluation, MissionEvaluation, RuleEvaluation } from '../../app/evaluate'
import { useCases } from '../../app/model'
import { observationDay, observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex, SimCrewData } from '../../app/scenarioData'
import type { CrewId, EnvId, Observation, Severity } from '../../app/vocab'
import { Chip, Citation, FindingBadge, FreshnessChip, MetTime, Num, Panel, ReqId, SeverityBadge, SimulatedMarker, Expander } from '../../ui'
import {
  OP_TEXT,
  OP_WORDS,
  OUTSIDE_OP,
  doseCoverage,
  findNamedTable,
  findRequirement,
  packetStateOf,
  replayUtcOf,
  sLevelTransitions,
  windowSecondsOf,
} from './model'
import type { StdData } from './model'
import { ChanceLine, MdcText, PartialBadge, PersonalWhy, RuleWhy, SeriesChart, SourceBlock, TestScale } from './parts'
import type { ChartPoint, RefLine } from './parts'
import { deliveryText, rationaleSentence } from './helpers'
import type { CaseDefFull } from './types'

const DAY_S = 86_400

interface Ctx {
  def: CaseDefFull
  crewId: CrewId
  envId: EnvId
  t: number
  index: ScenarioIndex
  runtime: readonly Observation[]
  crew: CrewEvaluation
  evaluation: MissionEvaluation
}

const isRuntime = (o: Observation) => o.provenance === 'manual' || o.provenance === 'measured'

// ---- a rule row (value vs limit), with the partial-record rule of D15 for cumulative dose windows ----

export interface Partial {
  /** The record starts after the window opens: the logged sum is a lower bound. */
  partial: boolean
  firstT: number | null
}

export function RuleRow({
  ev,
  open = false,
  partial: given = null,
  label = null,
  why = true,
  note = null,
}: {
  ev: RuleEvaluation
  open?: boolean
  partial?: Partial | null
  /** The row's name when this view words it more precisely than the rule label ("Career effective dose, to date"). */
  label?: ReactNode
  /**
   * false: the value, limit, badge and any partial-record note only, without the row's own "How this is judged"
   * expander, for a list that gathers those in one expander of its own (the SPE dose record).
   */
  why?: boolean
  /** A fine line under the value, inside the row's own box: what the row's verdict covers (the career dose, to date). */
  note?: ReactNode
}) {
  const f = ev.finding
  // Without an explicit coverage (e.g. the "Every trigger of this case" list), use the window coverage the app's
  // aggregate already computed (input.partial, D15), so a partial dose record never reads "within limit".
  const partial: Partial | null = given ?? (ev.input?.partial ? { partial: true, firstT: ev.input.record_start ?? null } : null)
  const logged = f.value !== null && f.status !== 'insufficient_data' && f.status !== 'not_applicable' && f.status !== 'stale'
  // On a partial record "outside" or "approaching" is conclusive (the full sum can only be higher); "within" is not.
  const conclusive = f.status === 'outside' || f.status === 'approaching'
  const showPartial = !!partial?.partial && logged
  // An OPS level is an S-scale threshold, reached at or above its number (as "Why this fired" shows it), not a
  // compliant condition: "1100 pfu vs ≥ 1000 pfu" beside "At or above S3", never "vs < 1000 pfu".
  const shownOp = ev.rule.category === 'OPS' ? OUTSIDE_OP[ev.rule.op] : ev.rule.op
  // A TARGET row names both lines its badge is judged against, the case floor (the rule's limit) and the
  // countermeasure target (its approach_at): "2110 mL vs case floor 1500 mL · target ≥ 2500 mL" beside "Below
  // target". The floor alone ("2110 mL vs ≥ 1500 mL" beside "Below target") read as a contradiction.
  const target = ev.rule.category === 'TARGET' ? (ev.rule.approach_at?.value ?? null) : null
  return (
    <li className="lfc-row">
      <div className="lfc-row-head">
        <span className="lfc-row-label">{label ?? ev.rule.label ?? ev.rule.id}</span>
        <span className="lfc-row-val">
          {showPartial ? <><span className="lfc-vs">logged</span>{' '}</> : null}
          <Num value={f.value} unit={ev.rule.unit} /> <span className="lfc-vs">{showPartial ? 'of' : 'vs'}</span>{' '}
          {target !== null ? (
            <>
              {/* Each line keeps its words together on a phone ("target ≥" never ends a line before "2500 mL"). */}
              <span style={{ whiteSpace: 'nowrap' }}>
                <span className="lfc-vs">case floor</span> <Num value={ev.rule.limit} unit={ev.rule.unit} />
              </span>{' '}
              <span style={{ whiteSpace: 'nowrap' }}>
                <span className="lfc-vs">· target</span> <span className="lf-num">{OP_TEXT[ev.rule.op]}</span> <Num value={target} unit={ev.rule.unit} />
              </span>
            </>
          ) : (
            <>
              <span className="lf-num">{OP_TEXT[shownOp]}</span> <Num value={ev.rule.limit} unit={ev.rule.unit} />
            </>
          )}
        </span>
        {showPartial && !conclusive ? <PartialBadge /> : <FindingBadge finding={f} />}
        {showPartial && conclusive ? <PartialBadge /> : null}
      </div>
      {showPartial ? (
        <p className="lfc-fine" style={why || note ? undefined : { marginBottom: 0 }}>
          Partial record: the first dose report is from <MetTime t={partial!.firstT ?? 0} label />, after this window opens, so the logged sum is a lower
          bound. Unlogged time is not zero dose{conclusive ? '; the limit is reached even on what is logged' : ', so "within limit" cannot be said'}.
        </p>
      ) : null}
      {note ? (
        <p className="lfc-fine" style={why ? undefined : { marginBottom: 0 }}>
          {note}
        </p>
      ) : null}
      {why ? <RuleWhy rule={ev.rule} finding={f} input={ev.input} open={open} /> : null}
    </li>
  )
}

// ---- renal ----------------------------------------------------------------------------------------

function ruleTrend(rule: Rule, c: Ctx): ChartPoint[] {
  const obs = observationsFor(c.index, c.runtime, c.crewId, rule.variable).filter((o) => o.crew_id === c.crewId && o.t <= c.t && o.unit === rule.unit)
  return obs.map((o) => {
    const f = evaluateRuleAt(rule, c.index, c.runtime, c.crewId, c.envId, o.t).finding
    const sev = f.severity as Severity
    const verdict = f.status === 'outside' ? `below the case floor (${sev})` : f.status === 'approaching' ? `short of the countermeasure target (${sev})` : 'at or above the target'
    return { t: o.t, value: o.value, severity: sev, verdict, runtime: isRuntime(o) }
  })
}

export function RenalPanel(c: Ctx) {
  const trig = c.def.triggers?.find((x) => x.kind === 'rule' && x.rule_id)
  const rule = trig?.rule_id ? getRule(RULES, trig.rule_id) : null
  const points = useMemo(() => (rule ? ruleTrend(rule, c) : []), [rule, c])
  const pol = c.crew.tierA.filter((r) => r.rule.case_id === c.def.id && r.rule.category === 'POL')
  const refs: RefLine[] = rule
    ? [
        { value: rule.limit, label: `${OP_TEXT[rule.op]} ${rule.limit} ${rule.unit} case floor`, style: 'limit' },
        ...(rule.approach_at ? [{ value: rule.approach_at.value, label: `${rule.approach_at.value} ${rule.unit} target`, style: 'band' as const }] : []),
      ]
    : []
  return (
    <Panel title="Urine output, and the bone limit behind it" eyebrow="Case detail" id="case-detail">
      {rule && points.length ? (
        <SeriesChart
          title={`${rule.label ?? rule.variable}, ${c.crewId}`}
          unit={rule.unit}
          points={points}
          refs={refs}
          now={c.t}
          caption={
            <>
              Recorded values, not live: the simulated 24-hour totals of {c.crewId} (each stamped at the end of its day). A triangle is a day the engine
              judged below the case floor; a filled dot is short of the countermeasure target. Both lines come from the case’s urine-output target{' '}
              <Chip kind={rule.chip} />, a NASA evidence-report target, not a NASA limit.
            </>
          }
        />
      ) : null}
      {pol.length ? (
        <>
          <h3 className="lfc-h3">The bone limit itself (POL) needs a scan this habitat does not have</h3>
          <p className="lfc-fine">
            Bone loss raises urinary calcium, which is why this case sits under NASA’s bone risk. The limit is measured by DXA against your pre-mission
            value; with no scan it is shown as missing data, never projected.
          </p>
          <ul className="lfc-rows">
            {pol.map((r) => (
              <RuleRow key={r.rule.id} ev={r} />
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  )
}

// ---- sleep ----------------------------------------------------------------------------------------

export function SleepPanel(c: Ctx & { vol2: SnapshotState<StdData> }) {
  const indId = c.def.tripwire?.condition.indicator_id
  const ind = indId ? getIndicator(RULES, indId) : null
  const current = ind ? c.crew.tierB.find((p) => p.indicator.id === ind.id) ?? null : null
  const points = useMemo<ChartPoint[]>(() => {
    if (!ind) return []
    const obs = observationsFor(c.index, c.runtime, c.crewId, ind.variable).filter((o) => o.crew_id === c.crewId && o.t <= c.t && o.unit === ind.unit)
    return obs.map((o) => {
      if (observationDay(o.t) <= c.index.baselineDays[1]) return { t: o.t, value: o.value, severity: 'nominal' as Severity, verdict: 'baseline period', runtime: isRuntime(o) }
      const f = evaluatePersonalAt(ind, c.index, c.runtime, c.crewId, o.t).finding
      const worse = f.status === 'reliable_change' && f.severity !== 'nominal'
      return { t: o.t, value: o.value, severity: f.severity as Severity, verdict: worse ? `reliable change, worse (${f.severity})` : 'within your personal band', runtime: isRuntime(o) }
    })
  }, [ind, c])
  const cond = c.def.tripwire?.condition
  const rci = current?.finding.rci
  // The band and the mean in the indicator's own unit (finding.band, finding.baseline_mean): for PVT-B lapses the
  // test runs on the Anscombe scale, and rci.mean / rci.mdc are on that scale, not in lapses.
  const mean = typeof current?.finding.baseline_mean === 'number' ? current.finding.baseline_mean : null
  const refs: RefLine[] = []
  if (current && typeof current.finding.limit === 'number') refs.push({ value: current.finding.limit, label: 'your band edge', style: 'band' })
  else if (current?.finding.band) refs.push({ value: ind?.worse === 'decrease' ? current.finding.band.low : current.finding.band.high, label: 'your band edge', style: 'band' })
  if (mean !== null) refs.push({ value: mean, label: 'baseline mean', style: 'mean' })
  if (cond) refs.push({ value: cond.value, label: `tripwire ${OP_TEXT[cond.op]} ${cond.value}`, style: 'tripwire' })
  const primary = c.def.countermeasure?.primary
  const table = findNamedTable(typeof primary?.source?.table === 'string' ? primary.source.table : null, c.vol2.data)
  const ntrs = [primary, ...(c.def.countermeasure?.alternatives ?? [])].filter((x) => typeof x?.source?.url === 'string' && (x!.source!.url as string).includes('ntrs.nasa.gov'))
  const [b0, b1] = c.index.baselineDays
  return (
    <Panel
      title="Alertness against your own baseline, and the lighting countermeasure"
      eyebrow="Case detail"
      id="case-detail"
      footer={<FreshnessChip meta={c.vol2.snapshot} status={c.vol2.status} id="std_vol2_requirements" source={c.vol2.snapshot?.source} />}
    >
      {ind && points.length ? (
        <SeriesChart
          title={`${ind.label ?? ind.id}, ${c.crewId}`}
          unit={ind.unit}
          points={points}
          refs={refs}
          shade={{ from: b0 * DAY_S, to: (b1 + 1) * DAY_S, label: `baseline, days ${b0}–${b1}` }}
          now={c.t}
          caption={
            <>
              Recorded values, not live: the simulated daily 3-minute PVT-B of {c.crewId}. Each triangle is a day the engine itself judged a reliable change
              in the worse direction against the shaded baseline. The band edge and mean are read from the engine’s current finding, in{' '}
              {ind.unit === 'count' ? 'counts' : ind.unit}
              {current && typeof rci?.mdc === 'number' ? (
                <>
                  ; the smallest one-day change this band can flag is <MdcText finding={current.finding} /> <Chip kind="derived" />
                </>
              ) : null}
              . {testScaleWords(ind) ? <><TestScale indicator={ind} />, the band mapped back to {ind.unit === 'count' ? 'counts' : ind.unit}. </> : null}
              <ChanceLine indicator={ind} /> The tripwire line is the case’s own condition (<Chip kind={c.def.tripwire?.chip} />).
            </>
          }
        />
      ) : null}
      {current ? (
        <PersonalWhy indicator={current.indicator} finding={current.finding} baselineDays={c.index.baselineDays} />
      ) : null}
      {primary ? (
        <>
          <h3 className="lfc-h3">Lighting: {primary.title}</h3>
          <p>{primary.rationale}</p>
          {table && Array.isArray(table.rows) && Array.isArray(table.columns) ? (
            <div className="lfc-table-wrap" tabIndex={0} role="region" aria-label={`${String(table.caption)}, scrollable`}>
              <table className="lfc-table">
                <caption>{String(table.caption)} (verbatim from the frozen standard)</caption>
                <thead>
                  <tr>
                    {(table.columns as string[]).slice(0, 4).map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(table.rows as string[][]).map((row) => (
                    <tr key={row[0]}>
                      {row.slice(0, 4).map((cell, i) => (
                        <td key={i} className={i ? 'lf-mono' : undefined}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {ntrs.length ? (
            <p className="lfc-fine">
              Lighting modes source:{' '}
              {ntrs.map((x) => (
                <Citation key={x!.id} source={x!.source} />
              ))}
            </p>
          ) : null}
        </>
      ) : null}
    </Panel>
  )
}

// ---- SPE ---------------------------------------------------------------------------------------------

interface SimVariables {
  variables?: Record<string, { label?: string; definition?: string } | undefined>
}

/** "MeV" keeps its own case inside an uppercased kicker (".lfc-k"): "≥10 MeV", never "≥10 MEV". */
function keepMeV(text: string): ReactNode {
  const parts = text.split(/(MeV)/)
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    p === 'MeV' ? (
      <span key={i} style={{ textTransform: 'none' }}>
        MeV
      </span>
    ) : (
      p
    ),
  )
}

/** The words after the [V1 4030] sentence: what "within limit" on the career row does and does not cover. */
const NO_PROJECTION = 'LANDFALL makes no projection, so “within limit” here covers the dose to date only.'

export function SpePanel(c: Ctx & { sim: SnapshotState<SimCrewData & SimVariables>; replay: SnapshotState<unknown> }) {
  const comms = useComms(c.envId, c.t)
  // The packet state of this crewmember's case (the same fold as the page): a Prepared packet is held on board.
  const view = useCases().get(c.def.id, c.crewId)
  const packet = view ? packetStateOf(view.state) : 'none'
  // [V1 4030]'s own rationale counts "the projected exposure for an upcoming mission" in the career dose (verbatim).
  const vol1 = useSnapshot<StdData>('std_vol1_requirements')
  const projected = rationaleSentence(findRequirement('V1 4030', vol1.data), 'projected exposure')
  const ops = c.evaluation.ops
  const series = useMemo(() => observationsFor(c.index, c.runtime, null, 'proton_flux_10mev'), [c.index, c.runtime])
  const spe = c.sim.data?.spe_day
  const mapIso = spe?.shape?.mapping?.replay_utc_at_met_0412_000000 ?? null
  const mapMet = typeof spe?.met_day === 'number' ? spe.met_day * DAY_S : null
  const transitions = useMemo(() => sLevelTransitions(series, c.t).filter((x) => mapMet === null || x.t >= mapMet), [series, c.t, mapMet])
  const doses = c.crew.tierA.filter((r) => r.rule.case_id === c.def.id && r.rule.category === 'PEL')
  const d30 = doses.filter((r) => r.rule.window?.kind === 'cumulative' && r.rule.window?.duration === 'P30D')
  const career = doses.filter((r) => r.rule.window?.kind === 'career' && r.rule.unit === 'mSv')
  const rest = doses.filter((r) => !d30.includes(r) && !career.includes(r))
  // The career row says what its "within limit" covers: the dose to date, with [V1 4030]'s own words on the projection.
  const careerNote = (
    <>
      {projected ? (
        <>
          <ReqId id="V1 4030" /> rationale, verbatim: <q>{projected}</q>{' '}
        </>
      ) : null}
      {NO_PROJECTION}
    </>
  )
  const shown: Array<{ r: RuleEvaluation; label?: string; note?: ReactNode }> = [
    ...d30.map((r) => ({ r })),
    ...career.map((r) => ({ r, label: 'Career effective dose, to date', note: careerNote })),
  ]
  const ctx = c.crew.context.filter((r) => r.rule.case_id === c.def.id)
  const lvl = ops.s_level
  const atMars = ops.kind === 'onboard_monitor'
  // The shelter level is the S-level of the case's OPS trigger that applies here (rules JSON, never a constant here).
  const shelterRule = (c.def.triggers ?? [])
    .filter((k) => k.kind === 'ops' && k.rule_id)
    .map((k) => getRule(RULES, k.rule_id!))
    .find((r) => r.applies_to.includes('*') || r.applies_to.includes(c.envId))
  const shelterLevel = shelterRule ? (typeof shelterRule.s_level === 'number' ? shelterRule.s_level : sLevel(shelterRule.limit)) : null
  const monitorLabel = atMars ? (c.sim.data?.variables?.proton_flux_10mev?.label ?? 'External space-weather monitor in Mars orbit (≥10 MeV)') : 'NOAA GOES proton flux (≥10 MeV)'
  /** D15: coverage of a cumulative dose window by this crewmember's reports. */
  const partialOf = (r: RuleEvaluation): Partial | null => {
    if (r.rule.window?.kind !== 'cumulative' && !(r.rule.window?.kind === 'career' && r.rule.unit !== 'mSv')) return null
    const obs = observationsFor(c.index, c.runtime, c.crewId, r.rule.variable).filter((o) => o.crew_id === c.crewId)
    const cov = doseCoverage(obs, r.rule.unit, c.t, windowSecondsOf(r.rule))
    return { partial: cov.partial, firstT: cov.firstT }
  }
  return (
    <Panel
      title="The proton event, the ground link, and the dose record"
      eyebrow="Case detail"
      id="case-detail"
      footer={<FreshnessChip meta={c.replay.snapshot} status={c.replay.status} id="swpc_spe_replay" source={c.replay.snapshot?.source} />}
    >
      <div className="lfc-spe-now">
        <div>
          <p className="lfc-k">{keepMeV(monitorLabel)}</p>
          <p className="lfc-big">
            <Num value={ops.flux} unit="pfu" /> {lvl !== null ? <span className="lf-num lfc-slevel">S{lvl}</span> : null}
          </p>
          <p className="lfc-fine">
            {ops.t !== null ? (
              <>
                Last sample <MetTime t={ops.t} label />.{' '}
              </>
            ) : null}
            {ops.active ? <FindingBadge finding={ops.active.finding} /> : <SeverityBadge severity="nominal" label="Below the shelter level" />} The vehicle’s
            radiation monitoring system raises the radiation alarm; this case is the health response that follows it.
          </p>
        </div>
        <div>
          <p className="lfc-k">Ground link</p>
          <p className="lfc-big lf-num">{comms.link === 'LOS' ? 'NO LINK' : 'LINK UP'}</p>
          <p className="lfc-fine">{deliveryText(comms, c.t, undefined, packet === 'none' ? undefined : packet)}</p>
        </div>
      </div>
      <SimulatedMarker>
        {atMars
          ? 'The flux is the real GOES-7 October 1989 event, time-shifted, read as the Mars-orbit monitor’s value with no radial-distance or atmospheric correction (a scenario assumption).'
          : 'The flux is a time-shifted replay of the real GOES-7 October 1989 event (not current conditions).'}
      </SimulatedMarker>
      <Expander summary={`S-level changes the monitor has seen (${transitions.length})`}>
        {transitions.length ? (
          <div className="lfc-table-wrap" tabIndex={0} role="region" aria-label="S-level changes up to the mission clock, scrollable">
            <table className="lfc-table">
              <caption className="sr-only">S-level changes up to the mission clock</caption>
              <thead>
                <tr>
                  <th scope="col">MET</th>
                  <th scope="col">Change</th>
                  <th scope="col" className="num">
                    Flux (pfu)
                  </th>
                  <th scope="col">Original 1989 sample (GOES-7)</th>
                </tr>
              </thead>
              <tbody>
                {transitions.map((x) => (
                  <tr key={x.t}>
                    <td>
                      <MetTime t={x.t} />
                    </td>
                    <td className="lf-mono">
                      {x.from === null ? `start at S${x.to}` : `S${x.from} → S${x.to}`}
                      {shelterLevel !== null && x.to >= shelterLevel && (x.from === null || x.from < shelterLevel) ? ' (shelter level reached)' : ''}
                    </td>
                    <td className="num">
                      <Num value={x.value} />
                    </td>
                    <td className="lf-mono">{replayUtcOf(x.t, mapIso, mapMet) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="lfc-fine">No proton samples up to the mission clock.</p>
        )}
        <p className="lfc-fine">
          S-levels use NOAA’s ≥10 MeV thresholds. Nothing is forecast: later changes appear as the mission clock reaches them.
          {shelterRule && shelterLevel !== null ? (
            <>
              {' '}
              Shelter level here: S{shelterLevel}, {OP_WORDS[OUTSIDE_OP[shelterRule.op]]} <Num value={shelterRule.limit} unit="pfu" /> (
              {shelterRule.label}) <Chip kind={shelterRule.chip} />.
            </>
          ) : null}
        </p>
        <p className="lfc-fine">
          Near Earth the reading is NOAA’s GOES flux; at Mars it comes from an external space-weather monitor above the atmosphere, in Mars orbit, relayed to
          the habitat with no Earth link.
        </p>
      </Expander>
      <h3 className="lfc-h3">Dose record against NASA’s 30-day organ limits (Table 4.8-1)</h3>
      <p className="lfc-fine">
        Organ doses come from the vehicle’s radiation monitoring system or ground analysts, in the table’s own unit (mGy-Eq or mGy). That the vehicle reports
        organ doses onboard, in Table 4.8-1’s own units, is a scenario assumption. The habitat monitor’s absorbed dose rate is never turned into an organ dose
        here, and no mSv is projected. An empty row is missing data, not zero; a record that starts after its window opens is a partial record.
      </p>
      {/* The 30-day and career rows stay in sight, one line each (a partial record keeps its note); how each row is
          judged, and the 1-year and career organ limits, are one expander below. */}
      <ul className="lfc-rows">
        {shown.map(({ r, label, note }) => (
          <RuleRow key={r.rule.id} ev={r} partial={partialOf(r)} label={label} note={note} why={false} />
        ))}
      </ul>
      {shown.length + rest.length ? (
        <Expander summary={`Every dose limit and how each is judged (${shown.length + rest.length})`}>
          <ul className="lfc-rows">
            {shown.map(({ r, label }) => (
              <RuleRow key={r.rule.id} ev={r} partial={partialOf(r)} label={label} />
            ))}
            {rest.map((r) => (
              <RuleRow key={r.rule.id} ev={r} partial={partialOf(r)} />
            ))}
          </ul>
        </Expander>
      ) : null}
      {ctx.map((r) => (
        <Expander key={r.rule.id} summary={`Why this event: ${r.rule.label}`}>
          <p className="lfc-fine">
            {r.rule.notes?.[0]}
            {/never fires/i.test(r.rule.notes?.[0] ?? '') ? null : ' Shown for context; it never fires.'}
          </p>
          <SourceBlock source={r.rule.source} compact />
        </Expander>
      ))}
    </Panel>
  )
}
