// Section 3: Tier A (a number someone publishes) vs Tier B (Reliable Change Index against the
// crewmember's own baseline). All parameters come from engine/rules/personal.json; the nominal
// false-alarm rate comes from the engine's expectedFalseAlarms (via the facade).
import { useId, useState } from 'react'
import { BASELINE_FIRST_DAY, BASELINE_LAST_DAY, SIM_LAST_DAY } from '../../app/scenario'
import { CREW } from '../../app/vocab'
import { Chip, Citation, Expander, Num, Panel, SeverityBadge } from '../../ui'
import type { MetaFile, PersonalFile, ThresholdsFile } from './rules'
import { SD_INTERVAL_LEVEL, falseAlarms, flagAtSd, round1, sdInterval95, twoTailP } from './stats'
import { RichText, SectionTitle, Verbatim } from './shared'

const PARAM_LABEL: Record<string, string> = {
  critical_z: 'Critical value for |RC|',
  alpha_two_tailed: 'α, two-tailed',
  min_baseline_n: 'Fewest baseline days accepted',
  baseline_window_days: 'Baseline window, days',
}

function clampInt(raw: string, lo: number, hi: number): number | null {
  const v = Math.floor(Number(raw))
  if (!Number.isFinite(v) || raw.trim() === '') return null
  return Math.min(hi, Math.max(lo, v))
}

function FalseAlarmCalc({ personal }: { personal: PersonalFile }) {
  const { rci, indicators } = personal
  const alerting = indicators.filter((i) => i.alerting)
  const quiet = indicators.filter((i) => !i.alerting)
  const k = alerting.length
  const alpha = rci.alpha_two_tailed
  const defaultDays = SIM_LAST_DAY - BASELINE_LAST_DAY
  const [daysRaw, setDaysRaw] = useState(String(defaultDays))
  const [crewRaw, setCrewRaw] = useState(String(CREW.length))
  const days = clampInt(daysRaw, 1, 100_000)
  const crew = clampInt(crewRaw, 1, 50)
  const per = days !== null ? falseAlarms(k, days, alpha) : null
  const all = days !== null && crew !== null ? falseAlarms(k * crew, days, alpha) : null
  const idDays = useId()
  const idCrew = useId()
  return (
    <div className="lf-m-calc">
      <h3 className="lf-m-h4">Expected false alarms (nominal)</h3>
      <p>
        If nothing about a crewmember changes, each alerting indicator still crosses the line on a fraction α of days by
        chance. <Num value={k} /> of the <Num value={indicators.length} /> indicators can alert;{' '}
        {quiet.map((i) => i.label).join(', ')} never do.
      </p>
      <div className="lf-m-calc-inputs">
        <label htmlFor={idDays}>
          Days evaluated
          <input
            id={idDays}
            type="number"
            inputMode="numeric"
            min={1}
            max={100_000}
            value={daysRaw}
            onChange={(e) => setDaysRaw(e.target.value)}
          />
        </label>
        <label htmlFor={idCrew}>
          Crewmembers
          <input
            id={idCrew}
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            value={crewRaw}
            onChange={(e) => setCrewRaw(e.target.value)}
          />
        </label>
        <p className="lf-m-small">
          Default: the scenario’s days after its baseline (MET days <Num value={BASELINE_LAST_DAY + 1} />–
          <Num value={SIM_LAST_DAY} />; baseline <Num value={BASELINE_FIRST_DAY} />–<Num value={BASELINE_LAST_DAY} />) and its{' '}
          <Num value={CREW.length} /> crewmembers.
        </p>
      </div>
      <div className="lf-m-calc-out" aria-live="polite">
        <p className="lf-mono lf-m-eqline">
          k × days × α = <Num value={k} /> × <Num value={days} /> × <Num value={alpha} /> ={' '}
          <Num value={per?.expected ?? null} digits={3} />
          <span className="lf-m-eqnote"> per crewmember</span>
        </p>
        <p>
          About one false alarm every <Num value={per?.everyNDays != null ? round1(per.everyNDays) : null} unit="days" /> per
          crewmember; for <Num value={crew} /> crewmembers, <Num value={all?.expected ?? null} digits={3} /> expected, about
          one every <Num value={all?.everyNDays != null ? round1(all.everyNDays) : null} unit="days" />.
        </p>
      </div>
    </div>
  )
}

function RealisticRate({ personal }: { personal: PersonalFile }) {
  const { rci, indicators } = personal
  const alerting = indicators.filter((i) => i.alerting)
  const groups = [...new Set(alerting.map((i) => i.reliability_r.value))]
    .sort((a, b) => b - a)
    .map((r) => {
      const members = alerting.filter((i) => i.reliability_r.value === r)
      const at = flagAtSd(rci.critical_z, r)
      return { r, members, at, p: twoTailP(at) }
    })
  const perDay = groups.reduce((s, g) => s + g.members.length * g.p, 0)
  const nominalPerDay = alerting.length * rci.alpha_two_tailed
  // Like for like: a Caution needs a reliable change in the worse direction, i.e. half of the
  // two-tailed tail for a one-direction indicator and all of it for worse = "either". The same
  // share applies to the nominal alpha, so both Caution rates below count the same thing.
  const cautionShare = (worse: string) => (worse === 'either' ? 1 : 0.5)
  const cautionPerDay = groups.reduce((s, g) => s + g.members.reduce((t, m) => t + cautionShare(m.worse) * g.p, 0), 0)
  const nominalCautionPerDay = alerting.reduce((s, m) => s + cautionShare(m.worse) * rci.alpha_two_tailed, 0)
  return (
    <Expander summary="How much higher could the real rate be? A rough, derived estimate">
      <p>
        Suppose a crewmember does not change at all and daily values scatter normally with the baseline SD. The flag fires
        when a day lands more than <span className="lf-mono">{rci.critical_z} × √(2(1 − r))</span> baseline SDs from the
        mean, which equals <Num value={rci.critical_z} /> only when r = <Num value={0.5} />:
      </p>
      <table className="lf-m-table lf-m-stack lf-m-stack-rate">
        <caption className="sr-only">Flag position and chance of a flag on an unchanged day, by reliability r</caption>
        <thead>
          <tr>
            <th scope="col">r</th>
            <th scope="col">Alerting indicators</th>
            <th scope="col" className="num">
              Flag at (baseline SDs)
            </th>
            <th scope="col" className="num">
              Chance per unchanged day
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.r}>
              {/* data-label: the stacked phone layout hides the header row, so each number names itself there */}
              <td data-label="r">
                <Num value={g.r} />
              </td>
              <td className="lf-m-stack-wide">{g.members.map((m) => m.label).join(', ')}</td>
              <td className="num" data-label="Flag at (baseline SDs)">
                <Num value={g.at} digits={2} />
              </td>
              <td className="num" data-label="Chance per unchanged day">
                <Num value={g.p * 100} digits={1} unit="%" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Summed over the <Num value={alerting.length} /> alerting indicators: about <Num value={perDay} digits={2} /> flags
        per crewmember-day in either direction, one every <Num value={round1(1 / perDay)} unit="days" />, against the
        nominal one every <Num value={round1(1 / nominalPerDay)} unit="days" /> printed above (which also counts both
        directions). Only a change for the worse raises a Caution, so about one Caution every{' '}
        <Num value={round1(1 / cautionPerDay)} unit="days" /> per crewmember, against a nominal one every{' '}
        <Num value={round1(1 / nominalCautionPerDay)} unit="days" />.
      </p>
      <p className="lf-m-small">
        Assumptions: normal, symmetric day-to-day scatter, no true change, baseline mean and SD taken as exact. Estimating
        them from a few days, and count data such as PVT-B lapses, push the real rate higher still. The engine source says
        the same (<code>engine/rci.py</code>): with a within-person SD the realised rate equals α only at r ={' '}
        <Num value={0.5} />. Derived on this page from personal.json; not a NASA number. <Chip kind="derived" />
      </p>
    </Expander>
  )
}

export function TiersSection({ meta, personal, thresholds }: { meta: MetaFile; personal: PersonalFile; thresholds: ThresholdsFile }) {
  const { rci, indicators } = personal
  const tierA = meta.tiers.find((t) => t.id === 'A')
  const tierB = meta.tiers.find((t) => t.id === 'B')
  const aAlert = thresholds.rules.filter((r) => r.tier === 'A' && r.role === 'alert').length
  const aContext = thresholds.rules.filter((r) => r.tier === 'A' && r.role === 'context').length
  const alerting = indicators.filter((i) => i.alerting).length
  const worse = meta.severity_mapping.rows.find((r) => r.id === 'personal_worse')
  const year = /\b\d{4}\b/.exec(rci.source.citation ?? '')?.[0]
  const nLo = sdInterval95(rci.min_baseline_n)
  const nHi = sdInterval95(rci.baseline_window_days)
  const ownR = indicators.filter((i) => i.reliability_r.chip === 'design choice').length

  return (
    <Panel
      id="m-tiers"
      eyebrow="Two tiers"
      title={<SectionTitle n={3}>Tier A: a published number. Tier B: your own baseline.</SectionTitle>}
      footer={
        <>
          <span>Rules: engine/rules/personal.json, thresholds.json, meta.json ·</span>
          <Citation source={rci.source} />
        </>
      }
    >
      <div className="lf-m-tiers">
        <div className="lf-m-tier">
          <h3 className="lf-m-h4">Tier A</h3>
          {tierA ? (
            <p>
              <RichText text={tierA.definition} />
            </p>
          ) : null}
          <p className="lf-m-small">
            In thresholds.json: <Num value={aAlert} /> alert rules, and <Num value={aContext} /> context rules that are shown
            and never fire.
          </p>
        </div>
        <div className="lf-m-tier">
          <h3 className="lf-m-h4">Tier B</h3>
          {tierB ? (
            <p>
              <RichText text={tierB.definition} />
            </p>
          ) : null}
          <p className="lf-m-small">
            In personal.json: <Num value={indicators.length} /> indicators, <Num value={alerting} /> of which can alert.
            {worse ? (
              <>
                {' '}
                A reliable change for the worse is at most <SeverityBadge severity="caution" size="sm" />
                {worse.note ? <> ({worse.note.replace(/\.$/, '')})</> : null}.
              </>
            ) : null}
          </p>
        </div>
      </div>

      <p>
        In words: is today’s value further from this crewmember’s own recent normal than day-to-day noise can explain? RC
        measures that distance in units of the noise.
      </p>
      <figure className="lf-m-formula" aria-labelledby="m-rci-cap">
        <div className="lf-m-eqs" role="list">
          <div role="listitem">
            <span className="lf-m-eq-l">SD</span>
            <span className="lf-m-eq-o">=</span>
            <span className="lf-m-eq-r lf-m-eq-text">sample SD (n − 1) of the crewmember’s own baseline days</span>
          </div>
          <div role="listitem">
            <span className="lf-m-eq-l">SEM</span>
            <span className="lf-m-eq-o">=</span>
            <span className="lf-m-eq-r">SD × √(1 − r)</span>
          </div>
          <div role="listitem">
            <span className="lf-m-eq-l">
              S<sub>diff</sub>
            </span>
            <span className="lf-m-eq-o">=</span>
            <span className="lf-m-eq-r">√2 × SEM</span>
          </div>
          <div role="listitem">
            <span className="lf-m-eq-l" />
            <span className="lf-m-eq-o">=</span>
            <span className="lf-m-eq-r">SD × √2 × √(1 − r)</span>
          </div>
          <div role="listitem">
            <span className="lf-m-eq-l">RC</span>
            <span className="lf-m-eq-o">=</span>
            <span className="lf-m-eq-r">
              (x − mean) / S<sub>diff</sub>
            </span>
          </div>
          <div role="listitem">
            <span className="lf-m-eq-l">flag</span>
            <span className="lf-m-eq-o">if</span>
            <span className="lf-m-eq-r">
              |RC| ≥ <Num value={rci.critical_z} />
              <span className="lf-m-eq-text">
                {' '}
                (two-tailed α = <Num value={rci.alpha_two_tailed} />)
              </span>
            </span>
          </div>
        </div>
        <figcaption id="m-rci-cap">
          Reliable Change Index, Jacobson &amp; Truax{year ? <> {year}</> : null}. x is today’s value; mean and SD come from
          the crewmember’s last <Num value={rci.baseline_window_days} /> baseline days (at least{' '}
          <Num value={rci.min_baseline_n} />
          ); r is the measurement’s test–retest reliability. Engine text: <span className="lf-mono">{rci.method}</span>
        </figcaption>
      </figure>

      <table className="lf-m-table lf-m-stack">
        <caption className="lf-m-caption">Tier B settings, and where each comes from</caption>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col" className="num">
              Value
            </th>
            <th scope="col">Basis</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(rci.provenance).map(([key, p]) => {
            const value = (rci as unknown as Record<string, unknown>)[key]
            return (
              <tr key={key}>
                <th scope="row">{PARAM_LABEL[key] ?? key}</th>
                <td className="num">
                  <Num value={typeof value === 'number' ? value : null} />
                </td>
                <td>
                  <Chip kind={p.chip} />
                </td>
                <td className="lf-m-why lf-m-stack-wide">
                  <RichText text={p.source.rationale ?? p.source.arithmetic ?? ''} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <Expander
        summary={
          <>
            Test–retest reliability r for each indicator (<Num value={ownR} /> of <Num value={indicators.length} /> are our
            choice)
          </>
        }
      >
        <table className="lf-m-table">
          <caption className="sr-only">Reliability r per indicator</caption>
          <thead>
            <tr>
              <th scope="col">Indicator</th>
              <th scope="col" className="num">
                r
              </th>
              <th scope="col">Basis</th>
              <th scope="col">Alerts</th>
            </tr>
          </thead>
          <tbody>
            {indicators.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.label}
                  {i.private ? <span className="lf-m-small"> · private</span> : null}
                </td>
                <td className="num">
                  <Num value={i.reliability_r.value} />
                </td>
                <td>
                  <Chip kind={i.reliability_r.chip} />
                </td>
                <td>{i.alerting ? 'yes' : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Expander>

      <FalseAlarmCalc personal={personal} />

      <div className="lf-m-aside">
        <h3 className="lf-m-h4">The honest limitation</h3>
        <Verbatim lead="From personal.json:" text={rci.caveat} />
        <p>
          Small baselines make the SD itself uncertain. From <Num value={rci.min_baseline_n} /> days (the fewest accepted) the
          true SD could be anywhere from about <Num value={nLo.lo} digits={2} unit="×" /> to{' '}
          <Num value={nLo.hi} digits={1} unit="×" /> the estimate; from <Num value={rci.baseline_window_days} /> days, about{' '}
          <Num value={nHi.lo} digits={2} unit="×" /> to <Num value={nHi.hi} digits={1} unit="×" /> (
          <Num value={SD_INTERVAL_LEVEL * 100} unit="%" /> confidence interval, chi-square with Wilson–Hilferty
          approximation). A baseline SD that is low by chance turns ordinary days
          into “reliable” change; one that is high by chance hides a real one.
        </p>
        <RealisticRate personal={personal} />
      </div>
    </Panel>
  )
}
