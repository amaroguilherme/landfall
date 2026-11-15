// Section 3: Tier A (a number someone publishes) vs Tier B (reliable change against the
// crewmember's own baseline: the single-case t-test of Crawford & Howell 1998). Every parameter
// comes from engine/rules/personal.json, and every critical value and chance rate shown is computed
// by the engine (tCritical, chanceRate per indicator, expectedFalseAlarms for the nominal comparison,
// through the facade). S1-S3: counts on the Anscombe scale, the signed midpoint shift, measured rates.
import { useId, useState } from 'react'
import { BASELINE_FIRST_DAY, BASELINE_LAST_DAY, SIM_LAST_DAY } from '../../app/scenario'
import { CREW } from '../../app/vocab'
import { Chip, Citation, Expander, Num, SeverityBadge } from '../../ui'
import { FoldPanel } from './fold'
import type { MetaFile, PersonalFile, ThresholdsFile } from './rules'
import type { CriticalRow } from './stats'
import { SD_INTERVAL_LEVEL, chanceRates, criticalRow, round1, sdInterval95, unlimitedRow } from './stats'
import { RichText, Verbatim } from './shared'
import { ChanceRateTable, EpisodeTable, MdcTable } from './TierBEvidence'
import { chanceTotals, personalIndicators, testScaleWords } from '../../app/evaluate'

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

/**
 * Expected chance findings: the SUM of each alerting indicator's own rate (the engine's chanceRate: nominal, or measured
 * where personal.json declares it), times the days. The engine's expected_false_alarms, every indicator at exactly its
 * nominal rate, is printed beside it for comparison, never instead of it.
 */
function ChanceCalc({ personal }: { personal: PersonalFile }) {
  const { rci, indicators } = personal
  const alerting = indicators.filter((i) => i.alerting)
  const quiet = indicators.filter((i) => !i.alerting)
  const either = alerting.filter((i) => i.worse === 'either')
  const ids = new Set(alerting.map((i) => i.id))
  const totals = chanceTotals(personalIndicators().filter((i) => ids.has(i.id)))
  const measured = totals.measured.filter((r) => r.alerting)
  const k = alerting.length
  const alpha = rci.alpha_two_tailed
  const defaultDays = SIM_LAST_DAY - BASELINE_LAST_DAY
  const [daysRaw, setDaysRaw] = useState(String(defaultDays))
  const [crewRaw, setCrewRaw] = useState(String(CREW.length))
  const days = clampInt(daysRaw, 1, 100_000)
  const crew = clampInt(crewRaw, 1, 50)
  const cautions = days !== null ? totals.caution_per_day * days : null
  const flags = days !== null ? totals.flag_per_day * days : null
  const nominal = days !== null ? chanceRates(k, days, alpha, either.length) : null
  const label = (id: string) => indicators.find((i) => i.id === id)?.label ?? id
  const idDays = useId()
  const idCrew = useId()
  return (
    <div className="lf-m-calc">
      <h3 className="lf-m-h4">Expected chance findings</h3>
      <p>
        If nothing about a crewmember changes, each alerting indicator still flags on some days by chance, and only a change in its worse direction
        raises a <SeverityBadge severity="caution" size="sm" />. Each indicator has its own rate, from the engine: the test’s nominal one (α/2 for
        a change in the worse direction; α for an indicator that alerts both ways) or, where personal.json declares it, the rate measured under the
        scenario’s noise model. <Num value={k} /> of the <Num value={indicators.length} /> indicators can alert; {quiet.map((i) => i.label).join(', ')}{' '}
        never do.
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
          <Num value={CREW.length} /> crewmembers. The sums count every indicator as read once a day; in the scenario the cuff and fingerstick
          readings come twice a week after the baseline, so their share there is smaller.
        </p>
      </div>
      <div className="lf-m-calc-out" aria-live="polite">
        <p className="lf-mono lf-m-eqline">
          cautions: Σ (each indicator’s own chance-caution rate per day) × days = <Num value={totals.caution_per_day} digits={5} /> ×{' '}
          <Num value={days} /> = <Num value={cautions} digits={3} />
          <span className="lf-m-eqnote"> per crewmember</span>
        </p>
        <p className="lf-mono lf-m-eqline">
          flags, either direction: Σ (each indicator’s own rate) × days = <Num value={totals.flag_per_day} digits={5} /> × <Num value={days} /> ={' '}
          <Num value={flags} digits={3} />
          <span className="lf-m-eqnote"> per crewmember</span>
        </p>
        <p>
          Per crewmember: about one chance caution every <Num value={totals.caution_every_n_days} digits={0} unit="days" /> and one chance flag every{' '}
          <Num value={totals.flag_every_n_days} digits={0} unit="days" />. For <Num value={crew} /> crewmembers:{' '}
          <Num value={cautions !== null && crew !== null ? cautions * crew : null} digits={3} /> chance cautions and{' '}
          <Num value={flags !== null && crew !== null ? flags * crew : null} digits={3} /> chance flags expected, about one caution every{' '}
          <Num value={totals.caution_every_n_days !== null && crew !== null ? round1(totals.caution_every_n_days / crew) : null} unit="days" />.
        </p>
        {measured.length ? (
          <p className="lf-m-small">
            {measured.map((r) => label(r.indicator_id)).join(', ')} {measured.length === 1 ? 'counts' : 'count'} at {measured.length === 1 ? 'its' : 'their'}{' '}
            measured rate (
            {measured.map((r, i) => (
              <span key={r.indicator_id}>
                {i ? '; ' : ''}
                {measured.length > 1 ? `${label(r.indicator_id)} ` : ''}
                <span className="lf-num">{r.caution_multiplier_text}</span>× the nominal caution rate
              </span>
            ))}
            ), not the nominal one. If every indicator flagged at exactly its nominal rate (the engine’s nominal false-alarm arithmetic, which assumes{' '}
            {nominal?.assumes ?? 'independent, normal noise'}), the cautions would be <Num value={nominal?.expected_cautions ?? null} digits={3} />.
          </p>
        ) : (
          <p className="lf-m-small">
            Every alerting indicator counts at its nominal rate here (the engine’s nominal false-alarm arithmetic gives the same{' '}
            <Num value={nominal?.expected_cautions ?? null} digits={3} />), which assumes {nominal?.assumes ?? 'independent, normal noise'}.
          </p>
        )}
        {either.length > 0 ? (
          <p className="lf-m-small">
            {either.map((i) => i.label).join(' and ')} can raise a caution in either direction, so for {either.length === 1 ? 'it' : 'them'} every chance
            flag is a caution, and the sums above count that.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * S1-S3, read from personal.json and the engine: counts tested on a variance-stabilizing scale, a signed shift tested in
 * both directions, and every indicator's chance rate measured under the scenario's noise model, printed where it differs.
 */
function ScalesAndRates({ personal }: { personal: PersonalFile }) {
  const transformed = personal.indicators.filter((i) => i.transform)
  const signed = personal.indicators.filter((i) => /^signed\b/i.test(i.definition?.text ?? ''))
  const either = personal.indicators.filter((i) => i.alerting && i.worse === 'either')
  const declared = personal.indicators.filter((i) => i.chance_rate)
  return (
    <div className="lf-m-aside">
      <h3 className="lf-m-h4">Counts, a signed shift, and chance rates measured rather than assumed</h3>
      <p>
        The printed chance rate of the test is exact only for normal, independent day-to-day noise. Skewed data break it, so LANDFALL changes how
        it tests them, not the number it prints:
      </p>
      <ul className="lf-m-notes">
        {transformed.map((i) => (
          <li key={i.id}>
            <strong>
              {i.label}: {testScaleWords(i)}.
            </strong>{' '}
            {i.transform_basis?.text ? <RichText text={i.transform_basis.text} /> : null}{' '}
            {i.transform_basis?.source ? <Citation source={i.transform_basis.source} /> : null} {i.transform_basis?.chip ? <Chip kind={i.transform_basis.chip} /> : null}
          </li>
        ))}
        {signed.map((i) => (
          <li key={i.id}>
            <strong>{i.label}: a signed shift, and either direction alerts.</strong> {i.definition ? <RichText text={i.definition.text.replace(/^./, (c) => c.toUpperCase())} /> : null}.{' '}
            {i.definition?.source?.rationale ? <RichText text={i.definition.source.rationale} /> : null} {i.definition?.chip ? <Chip kind={i.definition.chip} /> : null}
          </li>
        ))}
      </ul>
      {either.length ? (
        <p className="lf-m-small">
          {either.map((i) => i.label).join(' and ')} alert in both directions, so each of their chance flags is a caution: their chance-caution rate is α,
          not α/2.
        </p>
      ) : null}
      <p>
        Then the realized rate of every indicator is measured, not assumed: a seeded Monte Carlo of the scenario’s own noise model, laid out like
        the scenario (a fixed baseline, then each later day tested against it), replayed through the engine itself by the reference engine’s tests.
        {declared.length ? (
          <>
            {' '}
            {declared.map((i) => i.label).join(' and ')} fall outside the band around the nominal rate, so personal.json declares {declared.length === 1 ? 'its' : 'their'}{' '}
            measured multipliers, and every view prints {declared.length === 1 ? 'that rate' : 'those rates'} next to the band, never a single global rate
            that would be false for {declared.length === 1 ? 'it' : 'them'}.
          </>
        ) : null}{' '}
        A case opened by a single flag of one indicator on one day says “possibly chance”, with that indicator’s own rate: a re-measure checks it,
        and the case’s tripwire then judges the readings that follow.
      </p>
      <ChanceRateTable personal={personal} />
      {declared.map((i) =>
        i.chance_rate?.text ? (
          <Verbatim key={i.id} lead={`From personal.json, ${i.label}:`} text={i.chance_rate.text} cite={<Chip kind={i.chance_rate.chip} />} />
        ) : null,
      )}
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

      <ScalesAndRates personal={personal} />

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
            So each rate printed is either the rate the arithmetic implies under its stated assumptions or, for an indicator whose
            realized rate under the scenario’s noise model is far from it, the measured one, next to that indicator’s band. The
            engine’s tests replay the earlier arithmetic and reproduce the audits’ figures (<code>engine/tests/test_rci.py</code>,{' '}
            <code>engine/tests/test_chance_rates.py</code>).
          </p>
        </div>
      ) : null}
    </FoldPanel>
  )
}
