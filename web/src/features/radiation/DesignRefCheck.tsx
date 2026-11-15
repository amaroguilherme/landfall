// NASA's design reference SPE, re-derived, under "The October 1989 events are NASA's design reference SPE": Vol 1
// Table 4.8-3 (100 energy/fluence pairs, frozen in std_vol1_requirements) integrated above 10 and 100 MeV, set
// against the fluence of the replayed GOES-7 record (swpc_spe_replay), and, in a closed expander, LANDFALL's S3
// trigger scored with the MSL RAD team's lead-time measure (hindsight, from the whole record). A log-log figure
// puts the replay's two channels on the table's integral curve; its table view is the 100 printed pairs. Every
// number is computed in designRef.ts and pinned by designRef.test.ts. Fluence only: no dose, and nothing here feeds
// the case, the rules, the annunciator or the hero.
import { useMemo, useState } from 'react'
import { useSnapshot } from '../../app/data'
import { CHIP_DEFS } from '../../app/vocab'
import { Chip, Expander, MetTime, Num, ReqId, formatNumber } from '../../ui'
import { TimeChart } from '../trends/chart'
import type { LineSpec, MarkSpec } from '../trends/chart'
import { replayMapping, utcToMet } from './model'
import { SEP_SNAPSHOT_ID, firstAuthorFamily, quoteById } from './marsSep'
import type { SepEventsData } from './marsSep'
import { CHANNELS, CURVE_E_MAX, CURVE_E_MIN, LEAD_FRACTION, TRIGGER_PFU, WINDOW_END_FROM, dayLabel, dayTime, decadeRange, designReference, sci } from './designRef'
import type { ChannelCheck, ChannelKey, DesignReference } from './designRef'
import type { ReplayWithEvent } from './witnesses'
import './designRef.css'

const chipFor = (kind: string, fallback: string) => CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? fallback
const NASA = chipFor('nasa_standard', 'NASA-published')
const DERIVED = chipFor('derived', 'derived')
const DESIGN = chipFor('design_choice', 'design choice')
const LIT = chipFor('literature', 'literature')
const NOAA = chipFor('noaa', 'NOAA-published')

/** "≥10 MeV", kept on one line. */
const above = (e0: number) => `≥${e0}\u00a0MeV`
const E0 = Object.fromEntries(CHANNELS.map((c) => [c.key, c.e0])) as Record<ChannelKey, number>

/** 1.930 × 10¹⁰ in the mono font; the exact value stays in the <data> element. */
function Sci({ value }: { value: number }) {
  const { mantissa, exponent } = sci(value)
  return (
    <span className="lf-num lf-dr-sci">
      <data value={String(value)}>
        <span aria-hidden="true">
          {mantissa} × 10<sup>{exponent}</sup>
        </span>
        <span className="sr-only">
          {mantissa} times 10 to the {exponent}
        </span>
      </data>
    </span>
  )
}

/** "1.930 × 10^10" for the chart's text alternative. */
const sciText = (v: number) => {
  const { mantissa, exponent } = sci(v)
  return `${mantissa} × 10^${exponent}`
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹'
/** The figure plots log10 values on linear axes (grid lines at whole decades only). Fluence axis: "10⁸" at 8. */
export function exponentLabel(v: number): string {
  const n = Math.round(v)
  if (!Number.isFinite(v) || Math.abs(v - n) > 1e-9) return ''
  return `10${String(n).replace('-', '⁻').replace(/\d/g, (d) => SUPERSCRIPT[Number(d)])}`
}
/** Energy axis: "1", "10", "100", "1000" MeV at 0, 1, 2, 3; nothing between. */
export const energyLabel = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? formatNumber(10 ** Math.round(v)) : '')
/** Below this plot width the two diamonds get short canvas labels (the caption names them in full). */
const NARROW_PLOT_PX = 480

/** A percentage rounded first, so a value that rounds to zero reads 0.0, never −0.0. */
const Pct = ({ value, digits }: { value: number; digits: number }) => <Num value={Number(value.toFixed(digits))} digits={digits} signed unit="%" />

export interface LeadQuote {
  text: string
  author: string
  journal: string
  year: string
  doi: string
  doiUrl: string
  /** The preprint the sentence was re-found in (the journal version was not compared). */
  arxivId: string
  arxivUrl: string
}

/** The RAD team's lead-time definition, verbatim, only when the snapshot re-found it in the arXiv page at build. */
export function leadQuote(d: SepEventsData | null | undefined): LeadQuote | null {
  const lit = d?.literature
  const text = d && lit?.quotes_verified_this_build === true ? quoteById(d, 'lead_time') : null
  if (!d || !lit || !text || !lit.arxiv_id || !lit.arxiv_html) return null
  return {
    text,
    author: firstAuthorFamily(d),
    journal: lit.journal.journal,
    year: lit.journal.published?.slice(0, 4) ?? '',
    doi: lit.doi,
    doiUrl: lit.doi_url,
    arxivId: lit.arxiv_id,
    arxivUrl: lit.arxiv_html,
  }
}

function Hindsight({ r, lead, triggerMet }: { r: DesignReference; lead: LeadQuote | null; triggerMet: number | null }) {
  const [c10, c100] = r.channels as [ChannelCheck, ChannelCheck]
  const w10 = c10.windowEnd
  const w100 = c100.windowEnd
  return (
    <Expander summary="Scored the way the RAD team scores its rule (hindsight)">
      <p className="lf-dr-hindsight">
        <span className="lf-tr-kind" data-kind="hindsight">
          HINDSIGHT
        </span>{' '}
        computed from the whole {r.windowStart.slice(0, 4)} record; the case never sees the future.
      </p>
      {lead ? (
        <>
          <p>The MSL RAD team scores its Mars storm warning by lead time, in {lead.author} et al.’s words:</p>
          <blockquote className="lf-rad-quote">
            <p>“{lead.text}”</p>
            <footer>
              {lead.author} et al., {lead.journal} ({lead.year}),{' '}
              <a href={lead.doiUrl} target="_blank" rel="noopener noreferrer">
                doi:{lead.doi}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              . Sentence from{' '}
              <a href={lead.arxivUrl} target="_blank" rel="noopener noreferrer">
                arXiv:{lead.arxivId}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              , re-checked word for word at every build; the journal version was not compared. <Chip kind={LIT} />
            </footer>
          </blockquote>
        </>
      ) : null}
      <p>The same measure, on proton fluence instead of dose:</p>
      <ul className="lf-dr-facts">
        <li>
          LANDFALL’s S3 trigger is the first replay sample whose {above(CHANNELS[0].e0)} flux reaches <Num value={TRIGGER_PFU} unit="pfu" /> <Chip kind={NOAA} />,{' '}
          <time dateTime={r.trigger}>{dayTime(Date.parse(r.trigger))}</time>
          {triggerMet !== null ? (
            <>
              {' '}
              (<MetTime t={triggerMet} label /> in the scenario)
            </>
          ) : null}
          . Before it, <Num value={c10.beforePct} digits={2} unit="%" /> of the {above(c10.e0)} fluence and <Num value={c100.beforePct} digits={2} unit="%" /> of
          the {above(c100.e0)} fluence had arrived <Chip kind={DERIVED} />.
        </li>
        <li>
          <Num value={LEAD_FRACTION * 100} unit="%" /> had arrived at <time dateTime={new Date(c10.markMs).toISOString()}>{dayTime(c10.markMs)}</time> above{' '}
          {c10.e0}&nbsp;MeV, <Num value={c10.markHoursAfter} digits={1} unit="h" /> after the trigger, and at{' '}
          <time dateTime={new Date(c100.markMs).toISOString()}>{dayTime(c100.markMs)}</time> above {c100.e0}&nbsp;MeV,{' '}
          <Num value={c100.markHoursAfter} digits={1} unit="h" /> after it <Chip kind={DERIVED} />.
        </li>
        {w10 && w100 ? (
          <li>
            Ending the event window anywhere from <time dateTime={WINDOW_END_FROM}>{dayTime(w10.fromMs)}</time> <Chip kind={DESIGN} /> to the record’s last
            sample (<time dateTime={new Date(w10.toMs).toISOString()}>{dayTime(w10.toMs)}</time>) puts the replay between <Pct value={w10.minPct} digits={1} /> and{' '}
            <Pct value={w10.maxPct} digits={1} /> of {r.table.id} above {c10.e0}&nbsp;MeV, and between <Pct value={w100.minPct} digits={1} /> and{' '}
            <Pct value={w100.maxPct} digits={1} /> above {c100.e0}&nbsp;MeV <Chip kind={DERIVED} />.
          </li>
        ) : null}
      </ul>
    </Expander>
  )
}

/** Table 4.8-3 integrated above E on log-log axes, with the replay's two channels as diamonds on the curve. */
function SpectrumFigure({ r }: { r: DesignReference }) {
  const [plotW, setPlotW] = useState(720)
  const narrow = plotW < NARROW_PLOT_PX
  const pts = useMemo(() => r.curve.filter((p) => p.e >= CURVE_E_MIN && p.e <= CURVE_E_MAX && p.above > 0), [r.curve])
  const x = useMemo(() => pts.map((p) => Math.log10(p.e)), [pts])
  const lines = useMemo<LineSpec[]>(
    () => [{ label: `${r.table.id} integrated above E`, values: pts.map((p) => Math.log10(p.above)), color: '--lf-text-2', width: 1.5 }],
    [pts, r.table.id],
  )
  const marks = useMemo<MarkSpec[]>(
    () =>
      r.channels.map((c) => ({
        x: Math.log10(c.e0),
        y: Math.log10(c.replay),
        shape: 'diamond',
        color: '--lf-text',
        size: 5,
        label: narrow ? above(c.e0) : `replay ${above(c.e0)}`,
      })),
    [r.channels, narrow],
  )
  const range = decadeRange([...pts.map((p) => p.above), ...r.channels.map((c) => c.replay)])
  if (pts.length < 2 || !range) return null
  const first = pts[0]
  const lastPt = pts[pts.length - 1]
  const aria =
    `${r.table.id} integrated above each printed energy from ${formatNumber(first.e)} to ${formatNumber(lastPt.e)} MeV, both axes logarithmic: ` +
    `${sciText(first.above)} protons/cm² above ${formatNumber(first.e)} MeV, falling to ${sciText(lastPt.above)} above ${formatNumber(lastPt.e)} MeV. ` +
    `The replay’s channels sit on the line: ` +
    r.channels.map((c) => `${sciText(c.replay)} above ${c.e0} MeV, against ${sciText(c.table)} from the table`).join('; ') +
    '.'
  return (
    <figure className="lf-dr-figure">
      <TimeChart
        x={x}
        lines={lines}
        marks={marks}
        yMin={Math.log10(range[0])}
        yMax={Math.log10(range[1])}
        xMin={Math.log10(CURVE_E_MIN)}
        xMax={Math.log10(CURVE_E_MAX)}
        xFormat={energyLabel}
        yFormat={exponentLabel}
        height={200}
        onPlotWidth={(w) => setPlotW((c) => (Math.abs(c - w) >= 2 ? w : c))}
        ariaLabel={aria}
      />
      <figcaption className="lf-tr-muted">
        Protons/cm² above each energy, <Num value={CURVE_E_MIN} /> to <Num value={CURVE_E_MAX} unit="MeV" />, both axes logarithmic. Line: {r.table.id} integrated
        above each printed energy <Chip kind={DERIVED} />. Diamonds: the replay’s {r.channels.map((c) => above(c.e0)).join(' and ')} fluences{' '}
        <Chip kind={DERIVED} />; at this scale they sit on the line, and the table above gives the differences.
      </figcaption>
    </figure>
  )
}

/** The figure's table view: the pairs exactly as printed, with the integral the line draws. */
function PrintedPairs({ r }: { r: DesignReference }) {
  const t = r.table
  const checks = t.checks ?? []
  return (
    <Expander summary={`${t.id} as printed: ${t.rows.length} energy/fluence pairs`}>
      <p>
        As printed on page <Num value={t.pdf_page_number} /> of NASA-STD-3001 Vol 1 <Chip kind={NASA} />, with the integral the figure draws{' '}
        <Chip kind={DERIVED} />.
        {checks.length ? (
          <>
            {' '}
            The extraction passed <Num value={checks.filter((c) => c.ok).length} /> of its <Num value={checks.length} /> checks, among them a second reading of
            the page by a different method.
          </>
        ) : null}
      </p>
      <div className="lf-tr-table-wrap lf-dr-pairs-wrap" tabIndex={0} role="region" aria-label={`${t.id} as printed, scrollable`}>
        <table className="lf-tr-table lf-dr-table">
          <caption className="lf-rad-caption">{t.caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="num">
                {t.header_verbatim[0]}
              </th>
              <th scope="col" className="num">
                {t.header_verbatim[1]}
              </th>
              <th scope="col" className="num">
                Above this energy, protons/cm²
              </th>
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, i) => (
              <tr key={row.energy}>
                <td className="num">{row.energy}</td>
                <td className="num">{row.fluence.text}</td>
                <td className="num">{r.curve[i] && r.curve[i].above > 0 ? <Sci value={r.curve[i].above} /> : <Num value={0} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Expander>
  )
}

/** The section (rendered by designRef.test.ts): no fetches; only the figure memoises its series. */
export function DesignReferenceView({ r, lead, triggerMet }: { r: DesignReference; lead: LeadQuote | null; triggerMet: number | null }) {
  const t = r.table
  const last = t.rows[t.rows.length - 1]
  const citedBy = t.cited_by?.[0] ?? null
  return (
    <div className="lf-dr" data-design-ref="">
      <h4 className="lf-rad-h4">{t.id} against the replayed record</h4>
      <p>
        {citedBy ? (
          <>
            The rationale of <ReqId id={citedBy} /> refers to {t.id}
          </>
        ) : (
          t.id
        )}
        , which prints that spectrum as <Num value={t.rows.length} /> energy/fluence pairs (page <Num value={t.pdf_page_number} />){' '}
        <Chip kind={NASA} />. Integrated above {CHANNELS.map((c) => c.e0).join(' and ')}&nbsp;MeV, it can be set against the replayed GOES-7 record of the
        same storm.
      </p>
      <div className="lf-tr-table-wrap lf-dr-wrap" tabIndex={0} role="region" aria-label={`${t.id} against the replayed record, scrollable`}>
        <table className="lf-tr-table lf-dr-table">
          <caption className="lf-rad-caption">Proton fluence of the October 1989 events, protons/cm²</caption>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              <th scope="col" className="num">
                Replay
              </th>
              <th scope="col" className="num">
                {t.id}
              </th>
              <th scope="col" className="num">
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            {r.channels.map((c) => (
              <tr key={c.key}>
                <th scope="row">{above(E0[c.key])}</th>
                <td className="num">
                  <Sci value={c.replay} />
                </td>
                <td className="num">
                  <Sci value={c.table} />
                </td>
                <td className="num">
                  <Pct value={c.diffPct} digits={2} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        The replayed GOES-7 record agrees with NASA’s design-reference spectrum; NASA-STD-3001 does not say how its table was derived, so this is a
        consistency check, not an independent confirmation.
      </p>
      <SpectrumFigure r={r} />
      <p className="lf-tr-muted">
        Both columns are derived <Chip kind={DERIVED} />. Replay: 4π × (flux above background) × <Num value={r.stepS} unit="s" /> for each sample of the event as
        NOAA’s SESC rule bounds it in this record, <time dateTime={r.windowStart}>{dayTime(Date.parse(r.windowStart))}</time> to{' '}
        <time dateTime={r.windowEnd}>{dayTime(Date.parse(r.windowEnd))}</time>, missing samples filled linearly; {above(r.channels[r.channels.length - 1].e0)} is the
        replay’s highest-energy integral channel. {t.id}: its pairs joined by power-law segments up to its last energy, <Num value={last.energy_mev} unit="MeV" />. Fluence only:
        no dose is computed from either.
      </p>
      <ul className="lf-dr-choices" aria-label="Choices that are LANDFALL’s own">
        <li>
          background: median of {dayLabel(r.bgDay)} <Chip kind={DESIGN} />
        </li>
        <li>
          isotropic: ×4π sr <Chip kind={DESIGN} />
        </li>
        <li>
          power-law segments <Chip kind={DESIGN} />
        </li>
      </ul>
      <PrintedPairs r={r} />
      <Hindsight r={r} lead={lead} triggerMet={triggerMet} />
    </div>
  )
}

/** Mounted in #/radiation's design reference SPE section; renders nothing until Table 4.8-3 is in the snapshot. */
export default function DesignReferenceCheck() {
  const v1 = useSnapshot<{ tables?: unknown }>('std_vol1_requirements')
  const rp = useSnapshot<ReplayWithEvent>('swpc_spe_replay')
  const sep = useSnapshot<SepEventsData>(SEP_SNAPSHOT_ID)
  const sim = useSnapshot<unknown>('sim_crew')
  const vol1 = v1.status === 'ready' ? (v1.data ?? null) : null
  const replay = rp.status === 'ready' ? (rp.data ?? null) : null
  const r = useMemo(() => (vol1 && replay ? designReference(vol1, replay) : null), [vol1, replay])
  const lead = useMemo(() => (sep.status === 'ready' ? leadQuote(sep.data) : null), [sep.status, sep.data])
  const mapping = sim.status === 'ready' ? replayMapping(sim.data) : null
  if (!r) return null
  return <DesignReferenceView r={r} lead={lead} triggerMet={mapping ? utcToMet(Date.parse(r.trigger), mapping) : null} />
}
