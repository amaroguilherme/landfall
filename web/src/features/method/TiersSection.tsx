// Section 3: Tier A (a number someone publishes) vs Tier B (reliable change against the
// crewmember's own baseline: the single-case t-test of Crawford & Howell 1998). Every parameter
// comes from engine/rules/personal.json, and every critical value and chance rate shown is computed
// by the engine (tCritical, expectedFalseAlarms, through the facade).
import { useId, useState } from 'react'
import { BASELINE_FIRST_DAY, BASELINE_LAST_DAY, SIM_LAST_DAY } from '../../app/scenario'
import { CREW } from '../../app/vocab'
import { Chip, Citation, Expander, Num, SeverityBadge } from '../../ui'
import { FoldPanel } from './fold'
import type { MetaFile, PersonalFile, ThresholdsFile } from './rules'
import type { CriticalRow } from './stats'
import { SD_INTERVAL_LEVEL, chanceRates, countsEither, criticalRow, round1, sdInterval95, unlimitedRow } from './stats'
import { RichText, Verbatim } from './shared'
import { EpisodeTable, MdcTable } from './TierBEvidence'

const PARAM_LABEL: Record<string, string> = {
  alpha_two_tailed: 'α, two-tailed',
  min_baseline_n: 'Fewest baseline days accepted',
  baseline_window_days: 'Baseline window, days',
}

const WORSE_LABEL: Record<string, string> = { increase: 'a rise', decrease: 'a fall', either: 'a change either way' }

function clampInt(raw: string, lo: number, hi: number): number | null {
  const v = Math.floor(Number(raw))
  if (!Number.isFinite(v) || raw.trim() === '') return null
  return Math.min(hi, Math.max(lo, v))
}

function Formula({ personal, full }: { personal: PersonalFile; full: CriticalRow }) {
  const { rci } = personal
  return (
    <figure className="lf-m-formula" aria-labelledby="m-rci-cap">
      <div className="lf-m-eqs" role="list">
        <div role="listitem">
          <span className="lf-m-eq-l">mean</span>
          <span className="lf-m-eq-o">=</span>
          <span className="lf-m-eq-r lf-m-eq-text">average of the crewmember’s own n baseline days</span>
        </div>
        <div role="listitem">
          <span className="lf-m-eq-l">SD</span>
          <span className="lf-m-eq-o">=</span>
          <span className="lf-m-eq-r lf-m-eq-text">their sample standard deviation {'(n\u00a0−\u00a01)'}</span>
        </div>
        <div role="listitem">
          <span className="lf-m-eq-l">
            S<sub>diff</sub>
          </span>
          <span className="lf-m-eq-o">=</span>
          <span className="lf-m-eq-r">
            SD × √(1 + 1/n)
            <span className="lf-m-eq-text"> (the spread of one new day minus the mean of n days)</span>
          </span>
        </div>
        <div role="listitem">
          <span className="lf-m-eq-l">t</span>
          <span className="lf-m-eq-o">=</span>
          <span className="lf-m-eq-r">
            (x − mean) / S<sub>diff</sub>
            <span className="lf-m-eq-text"> (the engine reports it as rc)</span>
          </span>
        </div>
        <div role="listitem">
          <span className="lf-m-eq-l">df</span>
          <span className="lf-m-eq-o">=</span>
          <span className="lf-m-eq-r">n − 1</span>
        </div>
        <div role="listitem">
          <span className="lf-m-eq-l">flag</span>
          <span className="lf-m-eq-o">if</span>
          <span className="lf-m-eq-r">
            |t| &gt; t<sub>crit</sub>(α, df) = <Num value={full.critical} digits={3} />
            <span className="lf-m-eq-text">
              {' '}
              for n = <Num value={full.n} />, df = <Num value={full.df} />, two-tailed α = <Num value={rci.alpha_two_tailed} />
            </span>
          </span>
        </div>
      </div>
      <figcaption id="m-rci-cap">
        The modified t-test of Crawford &amp; Howell for one person’s new value against the mean of n values, here the
        crewmember’s own <Num value={rci.baseline_window_days} /> baseline days (at least <Num value={rci.min_baseline_n} />;
        in the scenario a fixed window, MET days <Num value={BASELINE_FIRST_DAY} />–<Num value={BASELINE_LAST_DAY} />,
        against which every later day is tested). x is today’s value. t<sub>crit</sub> is Student’s t, two-tailed, computed
        by the engine; it is not stored.{' '}
        <Citation source={rci.source} /> No test–retest reliability enters the arithmetic: the crewmember’s own baseline SD
        already holds the day-to-day noise the test needs. Engine text: <span className="lf-mono">{rci.method}</span>
      </figcaption>
    </figure>
  )
}

function CriticalTable({ rows }: { rows: CriticalRow[] }) {
  return (
    <table className="lf-m-table lf-m-stack lf-m-stack-rate lf-m-stack-crit">
      <caption className="lf-m-caption">Where the line sits, by baseline length (computed by the engine)</caption>
      <thead>
        <tr>
          <th scope="col">Baseline</th>
          <th scope="col" className="num">
            df
          </th>
          <th scope="col" className="num">
            Critical |t|
          </th>
          <th scope="col" className="num">
            Smallest flaggable change (baseline SDs)
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.n ?? 'unlimited'}>
            <th scope="row">{r.n === null ? 'Unlimited (the normal value)' : <Num value={r.n} unit="days" />}</th>
            <td className="num" data-label="df">
              {r.n === null ? <span className="lf-mono">∞</span> : <Num value={r.df} />}
            </td>
            <td className="num" data-label="Critical |t|">
              <Num value={r.critical} digits={3} />
            </td>
            <td className="num" data-label="Smallest change (SDs)">
              <Num value={r.bandSd} digits={3} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ChanceCalc({ personal }: { personal: PersonalFile }) {
  const { rci, indicators } = personal
  const alerting = indicators.filter((i) => i.alerting)
  const quiet = indicators.filter((i) => !i.alerting)
  const either = alerting.filter((i) => i.worse === 'either')
  const k = alerting.length
  const alpha = rci.alpha_two_tailed
  const defaultDays = SIM_LAST_DAY - BASELINE_LAST_DAY
  const [daysRaw, setDaysRaw] = useState(String(defaultDays))
  const [crewRaw, setCrewRaw] = useState(String(CREW.length))
  const days = clampInt(daysRaw, 1, 100_000)
  const crew = clampInt(crewRaw, 1, 50)
  const one = days !== null ? chanceRates(k, days, alpha, either.length) : null
  const all = days !== null && crew !== null ? chanceRates(k * crew, days, alpha, either.length * crew) : null
  // Does the engine count the both-direction indicators in its caution figures?
  const eitherCounted = countsEither(one)
  const idDays = useId()
  const idCrew = useId()
  return (
    <div className="lf-m-calc">
      <h3 className="lf-m-h4">Expected chance findings</h3>
      <p>
        If nothing about a crewmember changes and the day-to-day noise is normal and independent, the test still flags
        each alerting indicator on a fraction α of days by chance, and half of those flags are in the worse direction, the
        only ones that raise a{' '}
        <SeverityBadge severity="caution" size="sm" />. <Num value={k} /> of the <Num value={indicators.length} /> indicators
        can alert; {quiet.map((i) => i.label).join(', ')} never do.
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
          flags: k × days × α = <Num value={k} /> × <Num value={days} /> × <Num value={alpha} /> ={' '}
          <Num value={one?.expected ?? null} digits={3} />
          <span className="lf-m-eqnote"> per crewmember, either direction</span>
        </p>
        {eitherCounted && either.length > 0 ? (
          <p className="lf-mono lf-m-eqline">
            cautions: (k − e) × days × α / 2 + e × days × α = <Num value={one?.expected_cautions ?? null} digits={3} />
            <span className="lf-m-eqnote">
              {' '}
              per crewmember; e = <Num value={either.length} /> {either.length === 1 ? 'indicator alerts' : 'indicators alert'} in both directions
            </span>
          </p>
        ) : (
          <p className="lf-mono lf-m-eqline">
            cautions: k × days × α / 2 = <Num value={one?.expected_cautions ?? null} digits={3} />
            <span className="lf-m-eqnote"> per crewmember, worse direction only</span>
          </p>
        )}
        {one ? (
          <ul className="lf-m-notes">
            <li>Per crewmember: {one.text}.</li>
            <li>Per crewmember: {one.caution_text}.</li>
          </ul>
        ) : null}
        <p>
          For <Num value={crew} /> crewmembers: <Num value={all?.expected ?? null} digits={3} /> chance flags and{' '}
          <Num value={all?.expected_cautions ?? null} digits={3} /> chance cautions expected, about one flag every{' '}
          <Num value={all?.every_n_days != null ? round1(all.every_n_days) : null} unit="days" /> and one caution every{' '}
          <Num value={all?.caution_every_n_days != null ? round1(all.caution_every_n_days) : null} unit="days" />.
        </p>
        <p className="lf-m-small">
          Computed by the engine (expected_false_alarms), which assumes {one?.assumes ?? 'independent, normal noise'}.
        </p>
        {either.length > 0 ? (
          <p className="lf-m-small">
            {either.map((i) => i.label).join(', ')} can raise a caution in either direction, so for{' '}
            {either.length === 1 ? 'it' : 'them'} every chance flag is a caution
            {eitherCounted
              ? ', and the caution figures above count that.'
              : '. The engine in this build counts every indicator as one-sided, so the caution figures above are too low.'}
          </p>
        ) : null}
      </div>
    </div>
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
  const quietRow = meta.severity_mapping.rows.find((r) => r.id === 'personal_non_alerting')
  const alpha = rci.alpha_two_tailed
  const full = criticalRow(alpha, rci.baseline_window_days)
  const fewest = criticalRow(alpha, rci.min_baseline_n)
  const unlimited = unlimitedRow(alpha)
  const nLo = sdInterval95(rci.min_baseline_n)
  const nHi = sdInterval95(rci.baseline_window_days)

  return (
    <FoldPanel
      s="tiers"
      eyebrow="Two tiers"
      title="Tier A: a published number. Tier B: your own baseline."
      abstract={
        <>
          The single-case test, its critical value (<Num value={full.critical} digits={3} />), the smallest change it can flag, and what each
          tier catches in the scenario.
        </>
      }
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
            {quietRow ? (
              <>
                {' '}
                On an indicator that never alerts it stays <SeverityBadge severity="nominal" size="sm" />.
                {quietRow.note ? <> {quietRow.note}</> : null}
              </>
            ) : null}
          </p>
        </div>
      </div>

      <p>
        In words: is today’s value further from this crewmember’s own recent normal than day-to-day noise can explain? That
        is Jacobson &amp; Truax’s “reliable change” question. LANDFALL answers it with the test built for one new value
        against a handful of values from the same person: Crawford &amp; Howell’s single-case t-test. t measures the
        distance in units of the noise, and Student’s t with n − 1 degrees of freedom allows for an SD estimated from only
        n days.
      </p>
      <Formula personal={personal} full={full} />

      <CriticalTable rows={[fewest, full, unlimited]} />
      <p className="lf-m-small">
        The engine computes the critical value from α and the baseline length with Student’s t distribution (the
        regularized incomplete beta function, inverted by bisection, identically in the Python reference and in this
        browser). Its tests check it against published t tables: the NIST/SEMATECH e-Handbook of Statistical Methods
        (section 1.3.6.7.2) and Purdue STAT 503’s table, whose 0.0005 upper-tail column is this two-tailed α. A shorter
        baseline puts the line further out, because its SD is less certain. <Chip kind="derived" />
      </p>

      <div className="lf-m-aside">
        <h3 className="lf-m-h4">The smallest change Tier B can see</h3>
        <p>
          A single day is flagged only when it sits beyond the band: its minimum detectable change is t<sub>crit</sub> × SD × √(1 + 1/n),
          here <Num value={full.bandSd} digits={3} /> times the crewmember’s own baseline SD for a{' '}
          <Num value={rci.baseline_window_days} />
          -day baseline. A smaller real change, however important, passes unflagged; a noisier person needs a bigger change. That is the
          price of a low chance rate, and it is why the band and this number are printed together. In each indicator’s own unit, from
          the scenario’s baselines:
        </p>
        <MdcTable personal={personal} />
        <p className="lf-m-small">
          The noise column is the simulator’s own record of how it drew day-to-day scatter, with its basis chip: where it says design
          choice, the scatter is LANDFALL’s, not a measured within-person value, and real scatter may be larger, which would raise the
          smallest flaggable change by the same factor. The chance rate does not depend on the scatter; the power to see a change does.
        </p>
        <h3 className="lf-m-h4">What Tier B detects in the scenario, and what only Tier A catches</h3>
        <EpisodeTable />
      </div>

      {rci.lineage ? (
        <div className="lf-m-aside">
          <h3 className="lf-m-h4">Where the idea comes from</h3>
          <Verbatim lead="From personal.json:" text={rci.lineage.text} cite={<Citation source={rci.lineage.source} />} />
        </div>
      ) : null}

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
            The <Num value={indicators.length} /> indicators: which direction is worse, and which can alert
          </>
        }
      >
        <table className="lf-m-table">
          <caption className="sr-only">Tier B indicators, their worse direction and whether they alert</caption>
          <thead>
            <tr>
              <th scope="col">Indicator</th>
              <th scope="col">Worse is</th>
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
                <td>{WORSE_LABEL[i.worse] ?? i.worse}</td>
                <td>{i.alerting ? 'yes' : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Expander>

      <ChanceCalc personal={personal} />

      <div className="lf-m-aside">
        <h3 className="lf-m-h4">The honest limitation</h3>
        <Verbatim lead="From personal.json:" text={rci.caveat} />
        {rci.caveat_basis ? (
          <p className="lf-m-small">
            <RichText text={rci.caveat_basis.text} /> <Citation source={rci.caveat_basis.source} />{' '}
            <Chip kind={rci.caveat_basis.chip} />
          </p>
        ) : null}
        <p>
          Small baselines also make the SD itself uncertain. From <Num value={rci.min_baseline_n} /> days (the fewest
          accepted) the true SD could be anywhere from about <Num value={nLo.lo} digits={2} unit="×" /> to{' '}
          <Num value={nLo.hi} digits={1} unit="×" /> the estimate; from <Num value={rci.baseline_window_days} /> days, about{' '}
          <Num value={nHi.lo} digits={2} unit="×" /> to <Num value={nHi.hi} digits={1} unit="×" /> (
          <Num value={SD_INTERVAL_LEVEL * 100} unit="%" /> confidence interval, chi-square with Wilson–Hilferty
          approximation). The single-case test already pays for that uncertainty: it is why the line sits at{' '}
          <Num value={fewest.critical} digits={3} /> after <Num value={rci.min_baseline_n} /> days and{' '}
          <Num value={full.critical} digits={3} /> after <Num value={rci.baseline_window_days} />, not at the normal{' '}
          <Num value={unlimited.critical} digits={3} />.
        </p>
      </div>

      {rci.change_note ? (
        <div className="lf-m-aside">
          <h3 className="lf-m-h4">What changed, and why</h3>
          <Verbatim lead="From personal.json:" text={rci.change_note} />
          <p className="lf-m-small">
            So the rate printed above is now the rate the arithmetic implies under its stated assumptions, and this page no
            longer needs a separate, higher “derived estimate” beside a nominal one. The engine’s tests replay the earlier
            arithmetic and reproduce the audit’s figure (<code>engine/tests/test_rci.py</code>).
          </p>
        </div>
      ) : null}
    </FoldPanel>
  )
}
