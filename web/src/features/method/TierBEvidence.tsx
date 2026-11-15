// Tier B honesty, computed on the shipped scenario by the engine:
// 1. the smallest one-day change each personal band can flag (critical x SD x sqrt(1 + 1/n)), per
//    indicator and crewmember, next to the basis of the simulator's day-to-day noise;
// 2. which scenario events Tier B detects and which only Tier A catches.
import { useMemo } from 'react'
import { CASE_DEFS } from '../../app/caseTimeline'
import { useSnapshot } from '../../app/data'
import { chanceRateOf, testScaleWords, transformFormula } from '../../app/evaluate'
import { useMission } from '../../app/mission'
import { useEvaluation, useScenario } from '../../app/model'
import { CREW } from '../../app/vocab'
import type { EnvId } from '../../app/vocab'
import { Chip, Num, SeverityIcon, SimulatedMarker } from '../../ui'
import type { Severity } from '../../app/vocab'
import { dayRanges, detectEpisodes, noiseEntry, onlyTierA } from './episodes'
import { PERSONAL } from './rules'
import type { PersonalFile } from './rules'

interface Calibration {
  item: string
  value: string
  chip: string
}
interface SimVariables {
  variables?: Record<string, { calibration?: Calibration[] }>
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
                    {testScaleWords(ind) ? (
                      <span className="lf-m-small lf-block">
                        Anscombe scale {transformFormula(ind.transform)}: the band’s upper edge in {ind.unit === 'count' ? 'counts' : ind.unit}; ± and SD on that scale
                      </span>
                    ) : null}
                  </th>
                  {CREW.map((c) => {
                    const f = evaluation.crew[c.id]?.tierB.find((p) => p.indicator.id === ind.id)?.finding
                    const mdc = f ? mdcOf(f) : null
                    const sd = f?.rci?.sd ?? null
                    // A transformed indicator (PVT-B lapses on the Anscombe scale): rci.mdc and rci.sd are on that scale, so the
                    // cell prints the band mapped back to the unit (finding.band), and the test-scale figures beside it.
                    if (f?.rci?.transform && f.band) {
                      return (
                        <td key={c.id} className="num" data-label={c.id}>
                          ≤ <Num value={f.band.high} digits={2} />
                          <span className="lf-m-small lf-m-sd">
                            ±<Num value={mdc} digits={2} />, SD <Num value={sd} digits={2} />
                          </span>
                        </td>
                      )
                    }
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

interface McEntry {
  tests?: number
  worse_direction_flags?: number
  flags?: number
  caution_multiplier?: number
  flag_multiplier?: number
  within_band?: boolean
  zero_sd_baselines?: number
}
interface ChanceRatesCheck {
  method?: string
  band?: [number, number]
  per_indicator?: Record<string, McEntry>
}

/**
 * S3, measured not assumed: for every indicator, the seeded Monte Carlo of the scenario's own noise model (sim_crew
 * data.self_check.chance_rates, replayed through the engine by the Python suite), next to the rate LANDFALL prints
 * (the engine's chanceRate: nominal, or the measured multipliers personal.json declares where the measured rate is
 * outside the band).
 */
export function ChanceRateTable({ personal }: { personal: PersonalFile }) {
  const sim = useSnapshot<{ self_check?: { chance_rates?: ChanceRatesCheck } }>('sim_crew')
  const check = sim.data?.self_check?.chance_rates ?? null
  const band = check?.band ?? null
  return (
    <div className="lf-m-mdc">
      <div className="lf-m-tablewrap">
        <table className="lf-m-table lf-m-blocks lf-m-chance-table">
          <caption className="lf-m-caption">
            How often each indicator flags with no real change: measured under the scenario’s noise model, and the rate LANDFALL prints
          </caption>
          <thead>
            <tr>
              <th scope="col">Indicator</th>
              <th scope="col" className="num">
                Tests
              </th>
              <th scope="col" className="num">
                Cautions, × nominal
              </th>
              <th scope="col" className="num">
                Flags, × nominal
              </th>
              <th scope="col">Printed rate (engine)</th>
            </tr>
          </thead>
          <tbody>
            {personal.indicators.map((ind) => {
              const mc = check?.per_indicator?.[ind.id] ?? null
              const r = chanceRateOf(ind.id)
              const outside = mc?.within_band === false
              return (
                <tr key={ind.id} data-outside={outside || undefined}>
                  <th scope="row">
                    {ind.label}
                    <span className="lf-m-small lf-block">
                      {ind.alerting ? (ind.worse === 'either' ? 'alerts both ways' : `alerts on ${ind.worse === 'increase' ? 'a rise' : 'a fall'}`) : 'never alerts'}
                      {testScaleWords(ind) ? ` · ${testScaleWords(ind)}` : ''}
                    </span>
                  </th>
                  <td className="num" data-label="Tests">
                    <Num value={mc?.tests ?? null} />
                  </td>
                  <td className="num" data-label="Cautions, × nominal">
                    {ind.alerting ? <Num value={mc?.caution_multiplier ?? null} digits={2} /> : <span className="lf-m-small">never alerts</span>}
                  </td>
                  <td className="num" data-label="Flags, × nominal">
                    <Num value={mc?.flag_multiplier ?? null} digits={2} />
                  </td>
                  <td data-label="Printed rate (engine)">
                    {r ? (
                      <>
                        {r.text}{' '}
                        {r.basis === 'measured' ? (
                          <>
                            <strong>measured</strong> <Chip kind={r.chip} />
                          </>
                        ) : (
                          <span className="lf-m-small">nominal</span>
                        )}
                      </>
                    ) : (
                      <Num value={null} />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {check ? (
        <p className="lf-m-small">
          {(check.method ?? '').replace(/^./, (c) => c.toUpperCase())}
          {band ? (
            <>
              {' '}
              An indicator whose measured rate falls outside <Num value={band[0]} digits={1} />× to <Num value={band[1]} digits={1} />× the nominal one
              declares the measured multipliers in personal.json, and LANDFALL prints that rate next to its band instead of the nominal one.
            </>
          ) : null}{' '}
          <Chip kind="derived" />
        </p>
      ) : (
        <p className="lf-m-small">{sim.status === 'loading' ? 'Reading the simulator’s own check…' : 'The simulator’s chance-rate check is not in this build.'}</p>
      )}
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
      <ChanceFlags sim={sim} />
    </div>
  )
}

interface ChanceFlag {
  crew_id: string
  indicator_id: string
  day: number
  alerting: boolean
  case_id: string | null
}
interface CaseOpening {
  crew_id: string
  case_id: string
  day: number
  opened_by: string
  scripted: boolean
  single_flag: boolean
}

/**
 * The chance flags of the project seed, from the generator's own report (self_check.tier_b.chance_flags and
 * case_openings): the seed is never re-drawn to hide them (SPEC 7), so the page lists each one and what it does.
 */
function ChanceFlags({ sim }: { sim: unknown }) {
  const sc = (sim as { self_check?: { tier_b?: { chance_flags?: ChanceFlag[] }; case_openings?: CaseOpening[] } } | null)?.self_check
  const flags = sc?.tier_b?.chance_flags ?? []
  const openings = sc?.case_openings ?? []
  if (!flags.length) return <p className="lf-m-small">With no scripted change, Tier B flags nothing else at the project seed.</p>
  const label = (id: string) => PERSONAL_LABEL.get(id) ?? id
  return (
    <div className="lf-m-small">
      <p>
        With no scripted change, Tier B also flags {flags.length === 1 ? 'one day' : <><Num value={flags.length} /> days</>} at the project seed, a
        consequence of real-size noise (the seed is fixed and never re-drawn to hide them):
      </p>
      <ul className="lf-m-notes">
        {flags.map((f) => {
          const opened = openings.find((o) => o.crew_id === f.crew_id && o.day === f.day && o.opened_by === f.indicator_id && !o.scripted)
          return (
            <li key={`${f.crew_id}-${f.indicator_id}-${f.day}`}>
              {f.crew_id}, {label(f.indicator_id)}, MET day <Num value={f.day} />:{' '}
              {!f.alerting
                ? 'a non-alerting indicator: shown, never an alert, and it opens nothing.'
                : opened
                  ? `it opens ${f.crew_id}’s ${CASE_TITLE.get(opened.case_id) ?? opened.case_id} case${opened.single_flag ? ', which LANDFALL labels “possibly chance” (a single flag) with the indicator’s own chance rate; the crew re-measures and the tripwire settles it' : ''}.`
                  : 'a caution with no case of its own: it shows its one-line action.'}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const PERSONAL_LABEL: ReadonlyMap<string, string> = new Map((PERSONAL?.indicators ?? []).map((i) => [i.id, i.label]))
const CASE_TITLE: ReadonlyMap<string, string> = new Map(CASE_DEFS.map((c) => [c.id, String(c.title ?? c.id).replace(/^./, (x) => x.toLowerCase())]))
