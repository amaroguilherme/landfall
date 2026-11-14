// Tier B honesty, computed on the shipped scenario by the engine:
// 1. the smallest one-day change each personal band can flag (critical x SD x sqrt(1 + 1/n)), per
//    indicator and crewmember, next to the basis of the simulator's day-to-day noise;
// 2. which scenario events Tier B detects and which only Tier A catches.
import { useMemo } from 'react'
import { useSnapshot } from '../../app/data'
import { useMission } from '../../app/mission'
import { useEvaluation, useScenario } from '../../app/model'
import { CREW } from '../../app/vocab'
import type { EnvId } from '../../app/vocab'
import { Chip, Num, SeverityIcon, SimulatedMarker } from '../../ui'
import type { Severity } from '../../app/vocab'
import { dayRanges, detectEpisodes, onlyTierA } from './episodes'
import type { PersonalFile } from './rules'

interface Calibration {
  item: string
  value: string
  chip: string
}
interface SimVariables {
  variables?: Record<string, { calibration?: Calibration[] }>
}

/** The simulator's day-to-day noise entry for a variable (an SD), as sim_crew records it. */
function noiseEntry(sim: SimVariables | null, variable: string): Calibration | null {
  const cal = sim?.variables?.[variable]?.calibration ?? []
  return cal.find((c) => /\bSD\b/.test(c.item)) ?? cal.find((c) => /\bSD\b/.test(c.value)) ?? null
}

/** Display digits by magnitude: whole numbers from 100 up, one decimal from 1, two below. */
function digitsFor(x: number): number {
  const a = Math.abs(x)
  return a >= 100 ? 0 : a >= 1 ? 1 : 2
}

/** Minimum detectable change of a personal finding: the engine's own field when it reports one, else critical x S_diff. */
function mdcOf(f: unknown): number | null {
  const x = f as { min_detectable_change?: unknown; mdc?: unknown; rci?: { min_detectable_change?: unknown; mdc?: unknown; critical?: unknown; s_diff?: unknown } }
  for (const v of [x.min_detectable_change, x.mdc, x.rci?.min_detectable_change, x.rci?.mdc]) if (typeof v === 'number' && Number.isFinite(v)) return v
  const c = x.rci?.critical
  const s = x.rci?.s_diff
  return typeof c === 'number' && typeof s === 'number' ? c * s : null
}

export function MdcTable({ personal }: { personal: PersonalFile }) {
  const { evaluation, status } = useEvaluation()
  const sim = useSnapshot<SimVariables>('sim_crew')
  const indicators = personal.indicators.filter((i) => i.alerting)
  if (!evaluation) {
    return <p className="lf-m-small">{status === 'loading' ? 'Computing the bands from the scenario…' : 'The scenario is not available, so the bands cannot be computed here.'}</p>
  }
  return (
    <div className="lf-m-mdc">
      <SimulatedMarker variant="banner">Computed by the engine from each simulated crewmember’s baseline days.</SimulatedMarker>
      <div className="lf-m-tablewrap">
        <table className="lf-m-table lf-m-mdc-table lf-m-blocks">
          <caption className="lf-m-caption">
            Smallest one-day change each personal band can flag (± around the baseline mean), with the baseline SD it comes from
          </caption>
          <thead>
            <tr>
              <th scope="col">Indicator</th>
              {CREW.map((c) => (
                <th key={c.id} scope="col" className="num">
                  {c.id}
                </th>
              ))}
              <th scope="col">Simulator day-to-day noise</th>
            </tr>
          </thead>
          <tbody>
            {indicators.map((ind) => {
              const noise = noiseEntry(sim.data, ind.variable)
              return (
                <tr key={ind.id}>
                  <th scope="row">
                    {ind.label} <span className="lf-m-small">({ind.unit})</span>
                  </th>
                  {CREW.map((c) => {
                    const f = evaluation.crew[c.id]?.tierB.find((p) => p.indicator.id === ind.id)?.finding
                    const mdc = f ? mdcOf(f) : null
                    const sd = f?.rci?.sd ?? null
                    return (
                      <td key={c.id} className="num" data-label={c.id}>
                        <Num value={mdc} digits={mdc !== null ? digitsFor(mdc) : undefined} />
                        {typeof sd === 'number' ? (
                          <span className="lf-m-small lf-m-sd">
                            SD <Num value={sd} digits={digitsFor(sd)} />
                          </span>
                        ) : null}
                      </td>
                    )
                  })}
                  <td data-label="Simulator day-to-day noise">
                    {noise ? (
                      <>
                        {noise.value} <Chip kind={noise.chip} />
                      </>
                    ) : (
                      <span className="lf-m-small">not recorded</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ClassWord({ severity }: { severity: string }) {
  return (
    <span className="lf-m-class">
      <SeverityIcon severity={severity as Severity} size={13} />
      {severity}
    </span>
  )
}

export function EpisodeTable() {
  const scenario = useScenario()
  const { state } = useMission()
  const envId = state.envId as EnvId
  const index = scenario.index
  const sim = scenario.sim.data
  const data = useMemo(() => {
    if (!index || !sim) return null
    try {
      return { episodes: detectEpisodes(index, sim, envId), others: onlyTierA(index, sim, envId), error: null }
    } catch (e) {
      return { episodes: [], others: [], error: (e as Error).message }
    }
  }, [index, sim, envId])
  if (!data) return <p className="lf-m-small">{scenario.status === 'loading' ? 'Reading the scenario…' : 'The scenario is not available in this build.'}</p>
  if (data.error) return <p className="lf-m-small">The detection table could not be computed: {data.error}</p>
  const signals = data.episodes.flatMap((e) => e.signals.filter((s) => s.tierB?.alerting))
  const caughtB = signals.filter((s) => (s.tierB?.days.length ?? 0) > 0).length
  return (
    <div className="lf-m-detect">
      <div className="lf-m-tablewrap">
        <table className="lf-m-table lf-m-detect-table lf-m-blocks">
          <caption className="lf-m-caption">What each tier catches in the scenario (MET days), computed by the engine on the shipped data</caption>
          <thead>
            <tr>
              <th scope="col">Event · crewmember</th>
              <th scope="col">Signal (days the scenario changes it)</th>
              <th scope="col">Tier B: own baseline</th>
              <th scope="col">Tier A: published number</th>
            </tr>
          </thead>
          <tbody>
            {data.episodes.flatMap((ep) =>
              ep.signals.map((s, i) => (
                <tr key={`${ep.id}-${s.variable}`}>
                  <th scope="row">{i === 0 ? <>{ep.id.replace(/_/g, ' ')} · {ep.crewId}</> : <span className="sr-only">{ep.id.replace(/_/g, ' ')} · {ep.crewId}</span>}</th>
                  <td data-label="Signal (days the scenario changes it)">
                    {s.label} <span className="lf-m-small">({dayRanges(s.scriptedDays)})</span>
                  </td>
                  <td data-label="Tier B: own baseline">
                    {!s.tierB ? (
                      <span className="lf-m-small">no personal indicator</span>
                    ) : !s.tierB.alerting ? (
                      <span className="lf-m-small">{s.tierB.private ? 'private, never alerts' : 'shown, never alerts'}</span>
                    ) : s.tierB.days.length ? (
                      <>
                        <ClassWord severity="caution" /> days <span className="lf-mono">{dayRanges(s.tierB.days)}</span>
                      </>
                    ) : (
                      <strong>not detected</strong>
                    )}
                  </td>
                  <td data-label="Tier A: published number">
                    {s.tierA.length === 0 ? (
                      <span className="lf-m-small">no published number</span>
                    ) : (
                      s.tierA.map((a) => (
                        <span key={a.ruleId} className="lf-m-tiera">
                          {a.label}: {a.days.length ? <>outside on days <span className="lf-mono">{dayRanges(a.days)}</span></> : 'never outside'}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              )),
            )}
            {data.others.map((o) => (
              <tr key={o.id}>
                <th scope="row">{o.id === 'spe' ? 'solar particle event · all crew' : `fitness test · ${o.crewId}`}</th>
                <td data-label="Signal">{o.label}</td>
                <td data-label="Tier B: own baseline">
                  <span className="lf-m-small">no personal baseline: Tier B cannot see it</span>
                </td>
                <td data-label="Tier A: published number">
                  {o.rule ? (
                    <>
                      {o.rule.label}: {o.rule.status.replace(/_/g, ' ')} now{' '}
                      {o.rule.status === 'outside' ? <ClassWord severity={o.rule.severity} /> : null}
                    </>
                  ) : (
                    <span className="lf-m-small">no applicable rule reads outside in this environment</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="lf-m-small">
        Tier B flags <Num value={caughtB} /> of the <Num value={signals.length} /> alerting signals the scenario scripts; the solar particle
        event and the fitness shortfall reach only Tier A. Read it with the noise column above: the simulator’s day-to-day scatter decides
        how far an episode sits from the band, so a detection here is evidence about the method on this data, not about real crews.
      </p>
    </div>
  )
}
