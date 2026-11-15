// Mars surface only: the MSL RAD team's published nowcast rule (Loewe et al. 2025), replayed on Curiosity's whole
// public dose record (snapshot hapi_msl_rad_sep_events) and compared row by row with the paper's Table 1, plus
// the measured context line under the habitat dose panel. A replay of a measured record: nothing here feeds the
// engine, the rules, the hero or the scenario. Absorbed dose in plastic only; never converted, never compared
// with a crew limit.
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useSnapshot } from '../../app/data'
import type { LoadStatus, Snapshot } from '../../app/data'
import { CHIP_DEFS } from '../../app/vocab'
import { Button, Chip, Expander, FreshnessChip, Num, StaleIcon, formatNumber } from '../../ui'
import { TimeChart } from '../trends/chart'
import type { HLineSpec, LineSpec, MarkSpec, VLineSpec } from '../trends/chart'
import { EVM_ID } from './EarthVsMars'
import { unitText } from './model'
import {
  SEP_SNAPSHOT_ID,
  STATUS_TEXT,
  donkiGap,
  firstAuthorFamily,
  fmtDhm,
  hmsUtc,
  isoMinute,
  mayTimeline,
  oneDecimal,
  peakRatioRange,
  quoteById,
  rowsWithStatus,
  ruleQuotes,
  tableRows,
  tableSummary,
  triggersWith,
  unconfirmedOf,
  unconfirmedText,
} from './marsSep'
import type { SepEventsData, Table1Row, TriggerFlag } from './marsSep'

const chipFor = (kind: string, fallback: string) => CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? fallback
const LIT = chipFor('literature', 'literature')
const DERIVED = chipFor('derived', 'derived')
const DESIGN = chipFor('design_choice', 'design choice')
const UNIT = 'µGy/day'
const VISIBLE_ROWS = 3
/**
 * The jump to the Earth-list table, labelled with where it sits: the proton panel's title and its "who raises the
 * alarm" heading (index.tsx), in words.
 */
export const EVM_POINTER = 'Earth’s proton lists against the storms measured at Gale: in the first panel, “Proton flux and the NOAA S-scale”, under “Who watches the Sun here, and who raises the alarm”'

/**
 * Scroll the Earth-list block into view and move focus to its heading, as the "On this page" buttons do (index.tsx
 * jumpToPanel, not imported: ./index imports this file). Never an href="#id": the router owns the hash.
 */
function jumpToEarthVsMars() {
  const el = document.getElementById(EVM_ID)
  if (!el) return
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
  const target = (el.querySelector('h4') as HTMLElement | null) ?? el
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1
  target.focus({ preventScroll: true })
}

function Measured({ children }: { children: ReactNode }) {
  return (
    <span className="lf-tr-kind" data-kind="historical">
      {children}
    </span>
  )
}

const signedPct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatNumber(Math.abs(v), 1)} %`
const xLabel = (v: number) => (Math.abs(v) < 1e-9 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(Math.round(v))}`)
const yLabel = (v: number) => (Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9 ? formatNumber(v) : '')

// ---- the 20 May 2024 timeline ---------------------------------------------------------------------------------

/** Below this plot width the two Earth ticks get short canvas labels (the list under the chart has the full text). */
const NARROW_PLOT_PX = 480

function MayChart({ data }: { data: SepEventsData }) {
  const tl = useMemo(() => mayTimeline(data), [data])
  const [plotW, setPlotW] = useState(800)
  const narrow = plotW < NARROW_PLOT_PX
  const lines = useMemo<LineSpec[]>(
    () =>
      tl
        ? [
            { label: 'dose rate E', values: tl.e, color: '--lf-text', width: 1.5, points: 3 },
            { label: '5-day background', values: tl.x.map(() => tl.background), color: '--lf-text-muted', width: 1, dash: [3, 3] },
          ]
        : [],
    [tl],
  )
  const hlines = useMemo<HLineSpec[]>(
    () => (tl ? [{ y: tl.threshold, label: `1.25 × background = ${formatNumber(tl.threshold, 1)} ${UNIT}`, short: '1.25 × background', color: '--lf-text-2', dash: [6, 3], width: 1.25 }] : []),
    [tl],
  )
  const vlines = useMemo<VLineSpec[]>(() => {
    if (!tl || tl.earthSeesMin === null || tl.earliestReplyMin === null) return []
    const a = oneDecimal(tl.earthSeesMin)
    const b = oneDecimal(tl.earliestReplyMin)
    return [
      { x: tl.earthSeesMin, label: narrow ? `Earth ≥ +${a}` : `Earth sees onset ≥ +${a} min`, color: '--lf-text-muted', dash: [2, 3], labelAt: 'top' },
      { x: tl.earliestReplyMin, label: narrow ? `reply ≥ +${b}` : `earliest reply ≥ +${b} min`, color: '--lf-text-muted', dash: [2, 3], labelAt: 'bottom' },
    ]
  }, [tl, narrow])
  const marks = useMemo<MarkSpec[]>(() => {
    if (!tl) return []
    const at = (m: number) => tl.e[tl.x.findIndex((x) => Math.abs(x - m) < 0.01)] ?? tl.threshold
    return [
      { x: 0, y: at(0), shape: 'diamond', hollow: true, color: '--lf-text', size: 4.5, label: 'onset' },
      { x: tl.confirmationMin, y: at(tl.confirmationMin), shape: 'diamond', hollow: true, color: '--lf-text', size: 4.5, label: `+${Math.round(tl.confirmationMin)} min confirmed` },
      { x: tl.peakMin, y: tl.peakValue, shape: 'diamond', hollow: false, color: '--lf-text', size: 5, label: `peak +${Math.round(tl.peakMin)} min` },
    ]
  }, [tl])
  if (!tl) return null
  const rp = tl.replay
  const alert = quoteById(data, 'official_alert')
  return (
    <>
      <TimeChart
        x={tl.x}
        lines={lines}
        hlines={hlines}
        vlines={vlines}
        marks={marks}
        yLog
        yMin={50}
        yMax={20000}
        xMin={tl.xMin}
        xMax={tl.xMax}
        xFormat={xLabel}
        yFormat={yLabel}
        height={210}
        onPlotWidth={(w) => setPlotW((c) => (Math.abs(c - w) >= 2 ? w : c))}
        ariaLabel={`MSL RAD detector-E dose rate on 20 May 2024, ${tl.x.length} native samples from ${tl.xMin} to +${tl.xMax} minutes around the onset, log scale in ${UNIT}: background ${formatNumber(tl.background, 1)}, threshold ${formatNumber(tl.threshold, 1)}, onset at 0, confirmation at +${Math.round(tl.confirmationMin)} min, peak ${formatNumber(tl.peakValue, 0)} at +${Math.round(tl.peakMin)} min.`}
      />
      <p className="lf-tr-muted lf-rad-sep-axis">
        Minutes from the onset sample ({hmsUtc(rp.onset)} UTC); {UNIT}, log scale. Dots: native iSWA samples. Lower dashed line: the 5-day background; the
        labelled dashed line above it: 1.25 × background.
      </p>
      <ul className="lf-rad-sep-moments">
        <li>
          <span className="lf-num lf-rad-sep-t">{hmsUtc(rp.onset)}</span> onset: the first sample above 1.25 × the 5-day background of{' '}
          <Num value={tl.background} unit={UNIT} digits={1} />.
        </li>
        <li>
          <span className="lf-num lf-rad-sep-t">+{oneDecimal(tl.confirmationMin)} min</span> ({hmsUtc(rp.confirmation.t)}): the next sample is above too, so the rule confirms
          (the paper’s second case){alert ? <>: in the paper’s words, “{alert}”</> : null}.
        </li>
        <li>
          <span className="lf-num lf-rad-sep-t">+{oneDecimal(tl.peakMin)} min</span> ({hmsUtc(rp.peak.t)}): peak <Num value={tl.peakValue} unit={UNIT} digits={0} />,{' '}
          <Num value={tl.peakRatio} digits={1} unit="×" /> its background.
        </li>
        {tl.earthSeesMin !== null && tl.earliestReplyMin !== null ? (
          <li>
            Earth sees the onset at <span className="lf-num">≥ +{oneDecimal(tl.earthSeesMin)} min</span> and its earliest reply arrives at{' '}
            <span className="lf-num">≥ +{oneDecimal(tl.earliestReplyMin)} min</span> ({data.light_time.label}; JPL Horizons one-way light time{' '}
            <Num value={tl.oneWayMin} digits={2} unit="min" />) <Chip kind={DERIVED} />
          </li>
        ) : null}
      </ul>
    </>
  )
}

// ---- the replay-vs-paper table ------------------------------------------------------------------------------------

function resultText(r: Table1Row): string {
  const base = STATUS_TEXT[r.comparison.status]
  const rp = r.replay
  if (!rp.triggered) {
    const ratio = rp.max_ratio_to_background
    const counts = Object.values(rp.samples_per_day ?? {})
    const sorted = [...counts].sort((a, b) => a - b)
    const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    const gap = typical > 0 && counts.some((n) => n < 0.5 * typical) ? ', iSWA gap' : ''
    // A crossing the next sample did not confirm is not an onset (the paper's cross-check): say so, never "max 1.25 ×".
    const un = unconfirmedOf(r)
    if (un.length === 1) return `${base} (one sample at ${formatNumber(un[0].ratio_to_background, 3)} ×, not confirmed by the next${gap})`
    if (un.length > 1) return `${base} (${un.length} samples above the threshold, none confirmed by the next${gap})`
    return `${base}${ratio !== null ? ` (max ${formatNumber(ratio, 2)} × within 48 h${gap})` : ''}`
  }
  if (r.comparison.status === 'replay_triggered_paper_not') {
    return `${base} (peak ${formatNumber(rp.peak.ratio_to_background, 2)} ×, confirmed by the next sample)`
  }
  return base
}

function Pair({ paper, replay }: { paper: ReactNode; replay: ReactNode }) {
  return (
    <>
      <td className="num">{paper}</td>
      <td className="num">{replay}</td>
    </>
  )
}

function Rows({ rows }: { rows: Table1Row[] }) {
  return (
    <tbody>
      {rows.map((r) => {
        const p = r.paper
        const rp = r.replay
        const dur = (v: number | null | undefined) => (typeof v === 'number' ? fmtDhm(v) : '—')
        return (
          <tr key={r.paper_date} data-status={r.comparison.status}>
            <th scope="row" className="num">
              {r.paper_date}
              {rp.triggered ? <span className="lf-rad-sep-on">onset {isoMinute(rp.onset).slice(5).replace('T', ' ')}</span> : null}
            </th>
            <Pair
              paper={p.triggered ? <Num value={p.total_uGy} digits={2} /> : <span className="lf-tr-muted">not triggered</span>}
              replay={rp.triggered ? <Num value={rp.total_uGy} digits={2} /> : '—'}
            />
            <td className="num">{typeof r.comparison.total_pct === 'number' ? signedPct(r.comparison.total_pct) : '—'}</td>
            <Pair paper={dur(p.time_to_peak_min)} replay={rp.triggered ? dur(rp.time_to_peak_min) : '—'} />
            <Pair paper={dur(p.shelter_min)} replay={rp.triggered ? dur(rp.shelter_min) : '—'} />
            <Pair paper={dur(p.lead_time_min)} replay={rp.triggered ? dur(rp.lead_time_min) : '—'} />
            <td>{resultText(r)}</td>
          </tr>
        )
      })}
    </tbody>
  )
}

function Table({ rows, caption }: { rows: Table1Row[]; caption: string }) {
  return (
    <div className="lf-tr-table-wrap lf-rad-sep-wrap" tabIndex={0} role="region" aria-label={`${caption}, scrollable`}>
      <table className="lf-tr-table lf-rad-sep-table">
        <caption className="lf-rad-caption">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              Event (paper’s date)
            </th>
            <th scope="colgroup" colSpan={3}>
              Total SEP dose, µGy
            </th>
            <th scope="colgroup" colSpan={2}>
              Time to peak
            </th>
            <th scope="colgroup" colSpan={2}>
              Shelter duration
            </th>
            <th scope="colgroup" colSpan={2}>
              Lead time
            </th>
            <th scope="col" rowSpan={2}>
              Result
            </th>
          </tr>
          <tr>
            <th scope="col">paper</th>
            <th scope="col">replay</th>
            <th scope="col">Δ</th>
            <th scope="col">paper</th>
            <th scope="col">replay</th>
            <th scope="col">paper</th>
            <th scope="col">replay</th>
            <th scope="col">paper</th>
            <th scope="col">replay</th>
          </tr>
        </thead>
        <Rows rows={rows} />
      </table>
    </div>
  )
}

const dates = (rows: Table1Row[]) => rows.map((r) => r.paper_date).join(', ')

/** "a", "a and b", "a, b and c": the summary's clauses, whatever the counts. */
function joinClauses(parts: ReactNode[]): ReactNode {
  return parts.map((p, i) => (
    <Fragment key={i}>
      {i === 0 ? null : i === parts.length - 1 ? ' and ' : ', '}
      {p}
    </Fragment>
  ))
}

function Comparison({ data }: { data: SepEventsData }) {
  const rows = useMemo(() => tableRows(data), [data])
  const sum = useMemo(() => tableSummary(data), [data])
  const dev = rowsWithStatus(data, 'deviates')
  const miss = rowsWithStatus(data, 'not_reproduced')
  const agree = rowsWithStatus(data, 'agrees_not_triggered')
  const only = rowsWithStatus(data, 'replay_triggered_paper_not')
  const tol = data.rule.reproduce
  const gapS = data.rule.scan.max_pair_gap_s
  // Rows the paper lists as not triggered where one sample crossed 1.25 × and the next did not confirm it.
  const agreeUnconfirmed = agree.filter((r) => unconfirmedOf(r).length > 0)
  const one = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural)
  const clauses: ReactNode[] = [
    <>
      <Num value={sum.counts.reproduced} /> {one(sum.counts.reproduced, 'reproduces', 'reproduce')} (total SEP dose within ±
      <Num value={tol.dose_tol_pct} /> % and time to peak within ±<Num value={tol.time_to_peak_tol_min} /> min, a tolerance that is ours{' '}
      <Chip kind={DESIGN} />)
    </>,
  ]
  if (dev.length) {
    clauses.push(
      <>
        <Num value={dev.length} /> {one(dev.length, 'deviates', 'deviate')} ({dev.map((r) => `${r.paper_date}, ${signedPct(r.comparison.total_pct ?? 0)}`).join('; ')})
      </>,
    )
  }
  if (miss.length) {
    clauses.push(
      <>
        <Num value={miss.length} /> {one(miss.length, 'does', 'do')} not trigger in this replay ({dates(miss)})
      </>,
    )
  }
  if (agree.length) {
    clauses.push(
      <>
        <Num value={agree.length} /> {one(agree.length, 'is', 'are')} not triggered in either
        {agreeUnconfirmed.length ? (
          <>
            {' '}
            (
            {agreeUnconfirmed
              .map((r) => `for ${r.paper_date}, ${unconfirmedOf(r).map((u) => unconfirmedText(u, gapS)).join('; ')}`)
              .join('; ')}
            )
          </>
        ) : null}
      </>,
    )
  }
  if (only.length) {
    clauses.push(
      <>
        <Num value={only.length} /> {one(only.length, 'triggers', 'trigger')} here only ({dates(only)})
      </>,
    )
  }
  return (
    <>
      <h4 className="lf-rad-h4">Replay against the paper’s Table 1 (Martian surface)</h4>
      <p className="lf-tr-muted">
        Of the paper’s <Num value={sum.rows} /> rows, {joinClauses(clauses)}. An onset counts only when the next sample, less than{' '}
        <Num value={gapS / 3600} unit="h" /> later, is above the threshold too (the paper’s cross-check; the limit is ours <Chip kind={DESIGN} />
        ). Largest events first; durations in the paper’s own format. Paper values <Chip kind={LIT} />, replay values <Chip kind={DERIVED} />
      </p>
      <Table rows={rows.slice(0, VISIBLE_ROWS)} caption={`The ${VISIBLE_ROWS} largest events in the paper’s table`} />
      <Expander summary={`The other ${rows.length - VISIBLE_ROWS} rows, deviations and misses included`}>
        <Table rows={rows.slice(VISIBLE_ROWS)} caption={`The other ${rows.length - VISIBLE_ROWS} rows of the paper’s table`} />
      </Expander>
    </>
  )
}

// ---- the rule, the whole record ----------------------------------------------------------------------------------------

function RuleQuotes({ data }: { data: SepEventsData }) {
  const lit = data.literature
  const j = lit.journal
  // The journal reference lists the publisher's authors (Crossref, read at build; CITATIONS.md does the same): the
  // arXiv v1 page prints the last author as "Löffner", Crossref as "Löffler". Neither list is typed here; only
  // Crossref's U+2010 hyphen is shown as "-", as the preprint and CITATIONS.md print it.
  const authors = (j.authors_crossref?.length ? j.authors_crossref : lit.authors).map((a) => a.replace(/\u2010/g, '-'))
  return (
    <Expander summary="The rule, in the paper’s words">
      {ruleQuotes(data).map((q) => (
        <blockquote key={q.id} className="lf-rad-quote">
          <p>“{q.text}”</p>
        </blockquote>
      ))}
      <p className="lf-tr-muted">
        {authors.join(', ')}. {lit.title}. {j.journal} {j.volume}, {j.article_number} ({j.published?.slice(0, 4)}).{' '}
        <a href={lit.doi_url} target="_blank" rel="noopener noreferrer">
          doi:{lit.doi}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        . Sentences and numbers from{' '}
        <a href={lit.arxiv_html} target="_blank" rel="noopener noreferrer">
          arXiv:{lit.arxiv_id}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        , re-checked word for word at every build; the journal version was not compared. <Chip kind={LIT} />
      </p>
      <h4 className="lf-rad-h4">Table 1, Martian surface, as the paper prints it</h4>
      <ul className="lf-rad-sep-verbatim">
        {lit.table1_surface_rows.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <p className="lf-tr-muted">
        How this replay applies it: {unitText(data.rule.method.join(' '))} <Chip kind={DESIGN} />
      </p>
    </Expander>
  )
}

const FLAG_TEXT: Record<TriggerFlag, string> = {
  in_paper_table: 'in the paper’s table',
  not_in_paper_table: 'trigger not in the paper’s table',
  after_paper_table: 'after the paper’s record',
}

function WholeRecord({ data }: { data: SepEventsData }) {
  const sc = data.scan
  const notIn = triggersWith(data, 'not_in_paper_table')
  const after = triggersWith(data, 'after_paper_table')
  const r = data.record
  return (
    <>
      <p className="lf-tr-muted">
        Run over the whole iSWA record (2012–2026) as an onboard system would (background refit daily, two consecutive samples less than{' '}
        <Num value={data.rule.scan.max_pair_gap_s / 3600} unit="h" /> apart <Chip kind={DESIGN} />, <Num value={r.n_samples} /> samples from{' '}
        {r.first_sample.slice(0, 10)} to {r.last_sample.slice(0, 10)}), the rule triggers <Num value={sc.n_triggers} /> times:{' '}
        <Num value={sc.flag_counts.in_paper_table} /> match rows of the paper’s table;{' '}
        {notIn.length ? (
          <>
            <Num value={notIn.length} /> are triggers not in the paper’s table ({notIn.map((t) => `${t.onset.slice(0, 10)}, ${formatNumber(t.total_uGy, 1)} µGy`).join('; ')});{' '}
          </>
        ) : null}
        {after.length ? (
          <>
            <Num value={after.length} /> come after the paper’s surface record ends on {data.paper_record_end} ({after.map((t) => t.onset.slice(0, 10)).join(', ')}).
          </>
        ) : null}
      </p>
      <Expander summary={`All ${sc.n_triggers} triggers of the whole-record run`}>
        <div className="lf-tr-table-wrap lf-rad-sep-wrap" tabIndex={0} role="region" aria-label="Every trigger of the whole-record run, scrollable">
          <table className="lf-tr-table lf-rad-sep-table">
            <caption className="lf-rad-caption">Every trigger, with any DONKI SEP entry observed within {data.rule.donki_neighbour_days} days (listed for context, never claimed as the same event)</caption>
            <thead>
              <tr>
                <th scope="col">Onset (UTC)</th>
                <th scope="col">Peak × background</th>
                <th scope="col">Total, µGy</th>
                <th scope="col">Shelter</th>
                <th scope="col">Flag</th>
                <th scope="col">DONKI entries near it</th>
              </tr>
            </thead>
            <tbody>
              {sc.triggers.map((t) => (
                <tr key={t.onset}>
                  <th scope="row" className="num">
                    {isoMinute(t.onset).replace('T', ' ')}
                  </th>
                  <td className="num">
                    <Num value={t.peak.ratio_to_background} digits={1} unit="×" />
                  </td>
                  <td className="num">
                    <Num value={t.total_uGy} digits={1} />
                  </td>
                  <td className="num">{fmtDhm(t.shelter_min)}</td>
                  <td>
                    {FLAG_TEXT[t.flag]}
                    {t.paper_date ? ` (${t.paper_date})` : ''}
                  </td>
                  <td>
                    {t.donki.in_window ? (
                      t.donki.observed?.length ? (
                        <>
                          <Num value={t.donki.observed.length} /> observed: {[...new Set(t.donki.observed.flatMap((e) => e.instruments.map((i) => i.split(':')[0])))].join(', ')}
                        </>
                      ) : (
                        'none observed'
                      )
                    ) : (
                      <span className="lf-tr-muted">{t.donki.note}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Expander>
    </>
  )
}

// ---- the section ----------------------------------------------------------------------------------------------------------

export function MarsSepRecordView({ data, snap, status }: { data: SepEventsData | null; snap: Snapshot<SepEventsData> | null; status: LoadStatus }) {
  if (!data) {
    return (
      <p className="lf-tr-nodata">
        <StaleIcon size={13} /> MSL RAD storm record ({SEP_SNAPSHOT_ID}) {status === 'loading' ? 'loading' : 'not in this build'}.
      </p>
    )
  }
  const gap = donkiGap(data)
  const lit = data.literature
  const may = mayTimeline(data)
  const beforeReply = may !== null && may.earliestReplyMin !== null && may.confirmationMin < may.earliestReplyMin
  return (
    <section className="lf-rad-sub lf-rad-sep" aria-labelledby="rad-sep-h">
      <h3 id="rad-sep-h" className="lf-tr-card-title">
        The RAD team’s storm warning, replayed on Curiosity’s RAD record at NASA iSWA (2012–2026) <Measured>MEASURED · MSL RAD, GALE CRATER</Measured>
      </h3>
      <p>
        The MSL RAD team published a nowcasting rule for solar particle events ({firstAuthorFamily(data)} et al., {lit.journal.journal}{' '}
        {lit.journal.published?.slice(0, 4)}): alert when detector E’s dose rate passes {data.rule.threshold_factor} × its own {data.rule.background_days}-day
        background, and confirm on the next sample <Chip kind={LIT} />. Here it runs on the MSL RAD series NASA’s iSWA serves (sparse before March 2013; the full archive is in NASA’s Planetary Data System), and every row of the paper’s own table is checked
        against the replay <Chip kind={DERIVED} />.
        {beforeReply ? ' On 20 May 2024, the largest storm in the record, the onboard rule confirms before any reply from Earth could arrive:' : ' 20 May 2024, the largest storm in the record:'}
      </p>
      <MayChart data={data} />
      {gap ? (
        <p className="lf-tr-muted">
          DONKI’s SEP list (near-Earth and STEREO-A instruments) has no entry between <time className="lf-rad-sep-time" dateTime={gap.start}>{gap.start}</time> and{' '}
          <time className="lf-rad-sep-time" dateTime={gap.stop}>{gap.stop}</time>.
        </p>
      ) : null}
      <Comparison data={data} />
      <RuleQuotes data={data} />
      <WholeRecord data={data} />
      <Expander summary={`Caveats from the snapshot (${snap?.caveats.length ?? 0})`}>
        <ul>
          {(snap?.caveats ?? []).map((c) => (
            <li key={c}>{unitText(c)}</li>
          ))}
        </ul>
      </Expander>
      <p className="lf-tr-muted">
        <FreshnessChip meta={snap} status={status} id={SEP_SNAPSHOT_ID} source={snap?.source} />
      </p>
    </section>
  )
}

/** Mounted inside the Mars "dose rate measured" panel. */
export default function MarsSepRecord() {
  const s = useSnapshot<SepEventsData>(SEP_SNAPSHOT_ID)
  return <MarsSepRecordView data={s.status === 'ready' ? (s.data ?? null) : null} snap={(s.snapshot as Snapshot<SepEventsData> | null) ?? null} status={s.status} />
}

/**
 * The measured context line under the habitat dose panel's assumed scaling (the scaling stays a design choice): the
 * range of the rule's peaks at Gale. Earth's proton lists against the storms at Gale have their own table in the proton
 * panel (EarthVsMars.tsx); this line only jumps there, as the "On this page" buttons do. No dose in µGy is printed here.
 */
export function MarsSepContextView({ data, multiple }: { data: SepEventsData; multiple: number | null }) {
  const range = peakRatioRange(data)
  if (!range) return null
  return (
    <>
      <p className="lf-tr-muted lf-rad-sep-context">
        For context, not a calibration: at Gale crater, the peak of each of the <Num value={range.n} /> triggers of the RAD team’s rule above in the MSL RAD record was{' '}
        <Num value={Number(oneDecimal(range.min))} digits={1} unit="×" /> to <Num value={Number(oneDecimal(range.max))} digits={1} unit="×" /> its own 5-day
        background (measured) <Chip kind={DERIVED} />.
        {multiple !== null ? (
          <>
            {' '}
            The {formatNumber(multiple)}× above stays a design choice <Chip kind={DESIGN} />.
          </>
        ) : null}
      </p>
      <p className="lf-tr-muted lf-rad-sep-context" data-evm-pointer="">
        <Button variant="ghost" data-jump={EVM_ID} onClick={jumpToEarthVsMars} style={{ paddingInline: 0, textAlign: 'left' }}>
          {EVM_POINTER}
        </Button>
      </p>
    </>
  )
}

/** Mounted under the Mars habitat dose panel. */
export function MarsSepContext({ multiple }: { multiple: number | null }) {
  const s = useSnapshot<SepEventsData>(SEP_SNAPSHOT_ID)
  const data = s.status === 'ready' ? (s.data ?? null) : null
  return data ? <MarsSepContextView data={data} multiple={multiple} /> : null
}
