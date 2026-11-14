// Case-specific panels: renal (urine trend vs the case floor, the derived bone POL projection),
// sleep (PVT-B lapses vs the personal band, the lighting countermeasure) and SPE (S-level
// transitions of the replay, dose accounting against Table 4.8-1, Houston's reachability).
import { useMemo } from 'react'
import { RULES, getIndicator, getRule, sLevel } from '../../app/engine'
import type { Rule } from '../../app/engine'
import { formatCountdown, formatEarliestReply, useComms } from '../../app/comms'
import type { SnapshotState } from '../../app/data'
import { evaluatePersonalAt, evaluateRuleAt } from '../../app/evaluate'
import type { CrewEvaluation, MissionEvaluation, RuleEvaluation } from '../../app/evaluate'
import { observationDay, observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex, SimCrewData } from '../../app/scenarioData'
import type { CrewId, EnvId, Observation, Severity } from '../../app/vocab'
import { Chip, Citation, Expander, FindingBadge, FreshnessChip, MetTime, Num, Panel, SeverityBadge, SimulatedMarker } from '../../ui'
import { OP_TEXT, findNamedTable, replayUtcOf, sLevelTransitions } from './model'
import type { StdData } from './model'
import { PersonalWhy, RuleWhy, SeriesChart, SourceBlock } from './parts'
import type { ChartPoint, RefLine } from './parts'
import type { CaseDefFull, Projection } from './types'

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

function ProjectionCard({ p }: { p: Projection }) {
  const v = p.value
  return (
    <div className="lfc-proj">
      <p className="lfc-proj-tag">Projection, not a measurement</p>
      <p className="lfc-proj-label">{p.label}</p>
      <p className="lfc-proj-value">
        {typeof v === 'number' ? (
          <Num value={v} unit={p.unit} />
        ) : (
          <>
            <Num value={v.min} />–<Num value={v.max} unit={p.unit} />
          </>
        )}{' '}
        <Chip kind={p.chip} />
      </p>
      {p.source ? <Citation source={p.source} /> : null}
      {p.caveat ? (
        <div className="lfc-proj-caveat">
          <p>
            {p.caveat.text} <Chip kind={p.caveat.chip} />
          </p>
          <SourceBlock source={p.caveat.source} compact />
        </div>
      ) : null}
    </div>
  )
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
    <Panel title="Urine output and why bone matters" eyebrow="Case detail" id="case-detail">
      {rule && points.length ? (
        <SeriesChart
          title={`${rule.label ?? rule.variable}, ${c.crewId}`}
          unit={rule.unit}
          points={points}
          refs={refs}
          now={c.t}
          caption={
            <>
              Recorded values, not live: the simulated 24-hour totals of {c.crewId} (each stamped at the end of its day). A
              triangle is a day the engine judged below the case floor; a filled dot is short of the countermeasure target.
              Both lines come from rule <code>{rule.id}</code> <Chip kind={rule.chip} />.
            </>
          }
        />
      ) : null}
      {c.def.projections?.length ? (
        <>
          <h3 className="lfc-h3">Bone loss raises urinary calcium: how fast could the bone limit come?</h3>
          <div className="lfc-proj-grid">
            {c.def.projections.map((p) => (
              <ProjectionCard key={p.id} p={p} />
            ))}
          </div>
        </>
      ) : null}
      {pol.length ? (
        <>
          <h3 className="lfc-h3">The bone limit itself (POL) needs a scan this habitat does not have</h3>
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

export function RuleRow({ ev, open = false }: { ev: RuleEvaluation; open?: boolean }) {
  const f = ev.finding
  return (
    <li className="lfc-row">
      <div className="lfc-row-head">
        <span className="lfc-row-label">{ev.rule.label ?? ev.rule.id}</span>
        <span className="lfc-row-val">
          <Num value={f.value} unit={ev.rule.unit} /> <span className="lfc-vs">vs</span> <span className="lf-num">{OP_TEXT[ev.rule.op]}</span>{' '}
          <Num value={ev.rule.limit} unit={ev.rule.unit} />
        </span>
        <FindingBadge finding={f} />
      </div>
      <RuleWhy rule={ev.rule} finding={f} input={ev.input} open={open} />
    </li>
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
  const mean = current && typeof (current.finding.rci as { mean?: unknown })?.mean === 'number' ? ((current.finding.rci as { mean: number }).mean) : null
  const refs: RefLine[] = []
  if (current && typeof current.finding.limit === 'number') refs.push({ value: current.finding.limit, label: 'your band edge', style: 'band' })
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
              Recorded values, not live: the simulated daily 3-minute PVT-B of {c.crewId}. Each triangle is a day the engine
              itself judged a reliable change in the worse direction against the shaded baseline. The band edge and mean are
              read from the engine’s current finding; the tripwire line is the case’s own condition (
              <Chip kind={c.def.tripwire?.chip} />
              ).
            </>
          }
        />
      ) : null}
      {current ? (
        <PersonalWhy
          indicator={current.indicator}
          finding={current.finding}
          baselineDays={c.index.baselineDays}
          alertingIndicators={c.evaluation.tierBAlertingIndicators}
        />
      ) : null}
      {primary ? (
        <>
          <h3 className="lfc-h3">Lighting: {primary.title}</h3>
          <p>{primary.rationale}</p>
          {table && Array.isArray(table.rows) && Array.isArray(table.columns) ? (
            <div className="lfc-table-wrap">
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

export function SpePanel(c: Ctx & { sim: SnapshotState<SimCrewData>; replay: SnapshotState<unknown> }) {
  const comms = useComms(c.envId, c.t)
  const ops = c.evaluation.ops
  const series = useMemo(() => observationsFor(c.index, c.runtime, null, 'proton_flux_10mev'), [c.index, c.runtime])
  const spe = c.sim.data?.spe_day
  const mapIso = spe?.shape?.mapping?.replay_utc_at_met_0412_000000 ?? null
  const mapMet = typeof spe?.met_day === 'number' ? spe.met_day * DAY_S : null
  const transitions = useMemo(
    () => sLevelTransitions(series, c.t).filter((x) => mapMet === null || x.t >= mapMet),
    [series, c.t, mapMet],
  )
  const doses = c.crew.tierA.filter((r) => r.rule.case_id === c.def.id && r.rule.category === 'PEL')
  const d30 = doses.filter((r) => r.rule.window?.kind === 'cumulative' && r.rule.window?.duration === 'P30D')
  const career = doses.filter((r) => r.rule.window?.kind === 'career' && r.rule.unit === 'mSv')
  const rest = doses.filter((r) => !d30.includes(r) && !career.includes(r))
  const ctx = c.crew.context.filter((r) => r.rule.case_id === c.def.id)
  const lvl = ops.s_level
  // The shelter level is the S-level of the case's OPS trigger that applies here (rules JSON, never a constant here).
  const shelterRule = (c.def.triggers ?? [])
    .filter((k) => k.kind === 'ops' && k.rule_id)
    .map((k) => getRule(RULES, k.rule_id!))
    .find((r) => r.applies_to.includes('*') || r.applies_to.includes(c.envId))
  const shelterLevel = shelterRule ? (typeof shelterRule.s_level === 'number' ? shelterRule.s_level : sLevel(shelterRule.limit)) : null
  return (
    <Panel
      title="The proton event, Houston, and the dose record"
      eyebrow="Case detail"
      id="case-detail"
      footer={<FreshnessChip meta={c.replay.snapshot} status={c.replay.status} id="swpc_spe_replay" source={c.replay.snapshot?.source} />}
    >
      <div className="lfc-spe-now">
        <div>
          <p className="lfc-k">{ops.kind === 'onboard_monitor' ? 'Onboard proton monitor (≥10 MeV)' : 'NOAA GOES proton flux (≥10 MeV)'}</p>
          <p className="lfc-big">
            <Num value={ops.flux} unit="pfu" /> {lvl !== null ? <span className="lf-num lfc-slevel">S{lvl}</span> : null}
          </p>
          <p className="lfc-fine">
            {ops.t !== null ? (
              <>
                Last sample <MetTime t={ops.t} label />.{' '}
              </>
            ) : null}
            {ops.active ? <FindingBadge finding={ops.active.finding} /> : <SeverityBadge severity="nominal" label="Below the shelter level" />}
          </p>
        </div>
        <div>
          <p className="lfc-k">Houston</p>
          <p className="lfc-big lf-num">{comms.link === 'LOS' ? 'NO LINK' : 'LINK UP'}</p>
          <p className="lfc-fine">
            {comms.blocked ? (
              <>
                Solar conjunction. Link back in <span className="lf-num">{comms.resumes_at !== null ? formatCountdown(comms.resumes_at - c.t) : '—'}</span>; earliest
                possible reply <span className="lf-num">{formatEarliestReply(comms)}</span>. LANDFALL does not wait for it.
              </>
            ) : (
              <>
                Earliest possible reply <span className="lf-num">{formatEarliestReply(comms)}</span> (light time only, no ground time).
              </>
            )}
          </p>
        </div>
      </div>
      <SimulatedMarker>
        The flux is a time-shifted replay of the real GOES-7 October 1989 event (not current conditions)
      </SimulatedMarker>
      <h3 className="lfc-h3">S-level changes the monitor has seen</h3>
      {transitions.length ? (
        <div className="lfc-table-wrap">
          <table className="lfc-table">
            <caption className="sr-only">S-level transitions up to the mission clock</caption>
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
        S-levels by the engine’s <code>sLevel</code> on NOAA’s thresholds. LANDFALL does not forecast: later changes appear as the
        mission clock reaches them.
        {shelterRule && shelterLevel !== null ? (
          <>
            {' '}
            Shelter level here: S{shelterLevel}, rule <code>{shelterRule.id}</code> <Chip kind={shelterRule.chip} />.
          </>
        ) : null}
      </p>
      <h3 className="lfc-h3">Dose record against NASA’s 30-day organ limits (Table 4.8-1)</h3>
      <p className="lfc-fine">
        Organ doses come from the vehicle’s radiation monitoring system or ground analysts, in the table’s own unit (mGy-Eq or
        mGy). LANDFALL never turns the habitat monitor’s absorbed dose rate into an organ dose and never projects its own mSv.
        An empty row is shown as missing data, not as zero.
      </p>
      <ul className="lfc-rows">
        {[...d30, ...career].map((r) => (
          <RuleRow key={r.rule.id} ev={r} />
        ))}
      </ul>
      {rest.length ? (
        <Expander summary={`1-year and career organ limits (${rest.length})`}>
          <ul className="lfc-rows">
            {rest.map((r) => (
              <RuleRow key={r.rule.id} ev={r} />
            ))}
          </ul>
        </Expander>
      ) : null}
      {ctx.map((r) => (
        <div key={r.rule.id} className="lfc-context">
          <h3 className="lfc-h3">Why this event: {r.rule.label}</h3>
          <p className="lfc-fine">
            {r.rule.notes?.[0]}
            {/never fires/i.test(r.rule.notes?.[0] ?? '') ? null : ' Shown for context; it never fires.'}
          </p>
          <SourceBlock source={r.rule.source} compact />
        </div>
      ))}
    </Panel>
  )
}
