// Mars surface only: sol 242, 11 April 2013. Curiosity's RAD measured a solar particle event at Gale crater while
// Mars was in solar conjunction and JPL had planned to suspend commanding to Curiosity. Rebuilt from NASA's public
// records (snapshot sep_conjunction_2013: MSL RAD on CCMC iSWA, STEREO-B HET on CDAWeb) on one UTC axis, beside
// NOAA's list (swpc_spe_list) and short, attributed fragments of Hassler et al. 2014. The paper's figure is never
// embedded or traced. Nothing here feeds the engine, the rules, the scenario or the hero, and no Gy -> Sv step
// is taken.
import { useMemo, useState } from 'react'
import { useSnapshot } from '../../app/data'
import type { LoadStatus, Snapshot } from '../../app/data'
import { useComms } from '../../app/comms'
import { MET_NOW_S } from '../../app/scenario'
import { CHIP_DEFS } from '../../app/vocab'
import { Chip, Expander, FreshnessChip, Num, Panel, formatNumber } from '../../ui'
import { TimeChart } from '../trends/chart'
import type { HLineSpec, LineSpec, MarkSpec } from '../trends/chart'
import {
  SOL242_SNAPSHOT_ID,
  SPE_LIST_SNAPSHOT_ID,
  axisInside,
  axisSpan,
  axisText,
  axisTick,
  dayHmUtc,
  dayLong,
  dayMonth,
  decadeLabel,
  fragment,
  hetPeaks,
  hetSeries,
  heroYear,
  hourUtc,
  jplWindow,
  monthYearLong,
  moratoriumRange,
  noaaEntry,
  quietText,
  radMoments,
  radSeries,
  readByHandOn,
  sci3,
  solNumber,
  windowDays,
} from './conjunction2013'
import type { Sol242Data, SpeListLike } from './conjunction2013'
import './sol242.css'

export const SOL242_ID = 'rad-sol242'
export const SOL242_TITLE = 'It has happened: a solar storm at Gale crater in solar conjunction (April 2013)'

const chipFor = (kind: string, fallback: string) => CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? fallback
const LIT = chipFor('literature', 'literature')
const DERIVED = chipFor('derived', 'derived')
const DESIGN = chipFor('design_choice', 'design choice')
const NOAA = chipFor('noaa', 'NOAA-published')
const UNIT = 'µGy/day'
const FLUX_UNIT = '#/(cm²·sr·s·MeV/n)'
/** The two HET bins drawn, highest energy first. */
const HET_MEV = [80, 50] as const
/** Below this plot width the axis keeps day labels only. */
const NARROW_PLOT_PX = 480
/** Below this plot width the dose chart's 1.25 × line keeps its short label: the full one would reach the peak and
 *  cover the data there, or leave the peak no room for its own label. */
const SHORT_LIMIT_PLOT_PX = 720

const Mono = ({ children }: { children: string }) => <span className="lf-num">{children}</span>

function Ext({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

// ---- the two charts on one axis -------------------------------------------------------------------------------

function HetChart({ data, daysOnly, onPlotWidth }: { data: Sol242Data; daysOnly: boolean; onPlotWidth: (w: number) => void }) {
  const s = useMemo(() => hetSeries(data, HET_MEV), [data])
  const peaks = useMemo(() => hetPeaks(data, HET_MEV), [data])
  const lines = useMemo<LineSpec[]>(
    () => [
      { label: '80 MeV bin', values: s.values[0], color: '--lf-text', width: 1.75 },
      { label: '50 MeV bin', values: s.values[1], color: '--lf-text-2', width: 1.5, dash: [6, 3] },
    ],
    [s],
  )
  // The first bin's peak hour is a filled diamond, the others hollow, with no canvas label: the 50 MeV peak sits an
  // hour right of the 80 MeV one and above it, so a label lands on the other bin's diamond or line. The legend line
  // under the chart names them.
  const marks = useMemo<MarkSpec[]>(
    () => peaks.map((p, i) => ({ x: p.x, y: p.mean, shape: 'diamond', hollow: i > 0, color: '--lf-text', size: 4.5 })),
    [peaks],
  )
  const xFormat = useMemo(() => (v: number) => axisTick(data, v, daysOnly), [data, daysOnly])
  const aria =
    `STEREO-B HET proton flux, hourly means of the 80 and 50 MeV bins, ${dayHmUtc(data.axis.start)} to ${dayHmUtc(data.axis.stop)}, log scale in ${FLUX_UNIT}: ` +
    peaks.map((p) => `${p.mev} MeV peaks at ${sci3(p.mean)} in the hour from ${hourUtc(p.hour)} UTC on ${dayMonth(p.hour)}, ${formatNumber(p.multiple)} times its ${quietText(data)} median of ${sci3(p.quiet)}`).join('; ') +
    '.'
  return (
    <TimeChart
      x={s.x}
      lines={lines}
      marks={marks}
      yLog
      yMin={1e-5}
      yMax={10}
      xMin={0}
      xMax={axisSpan(data)}
      xFormat={xFormat}
      yFormat={decadeLabel}
      height={190}
      onPlotWidth={onPlotWidth}
      ariaLabel={aria}
    />
  )
}

export function RadChart({ data, daysOnly, shortLimit }: { data: Sol242Data; daysOnly: boolean; shortLimit: boolean }) {
  const s = useMemo(() => radSeries(data), [data])
  const m = useMemo(() => radMoments(data), [data])
  const lines = useMemo<LineSpec[]>(
    () => [
      { label: 'dose rate E', values: s.e, color: '--lf-text', width: 1.5, points: 3 },
      { label: '5-day background', values: s.x.map(() => s.background), color: '--lf-text-muted', width: 1, dash: [3, 3] },
    ],
    [s],
  )
  const hlines = useMemo<HLineSpec[]>(
    () => {
      const short = `${formatNumber(data.rad.threshold_factor)} × background`
      return [{ y: s.threshold, label: shortLimit ? short : `${short} = ${formatNumber(s.threshold, 1)} ${UNIT}`, short, color: '--lf-text-2', dash: [6, 3], width: 1.25 }]
    },
    [s, data, shortLimit],
  )
  const marks = useMemo<MarkSpec[]>(() => {
    // Narrow plots get a short peak label and no rise label: there the rise label would sit under the peak diamond,
    // beside the falling line. The legend line names both diamonds and the peak line under the charts has the values.
    const out: MarkSpec[] = [{ x: dayX(data, m.peak.t), y: m.peak.uGy_per_day, shape: 'diamond', color: '--lf-text', size: 5, label: daysOnly ? 'peak' : `peak ×${formatNumber(m.peakRatio, 3)}` }]
    if (m.rise) out.push({ x: dayX(data, m.rise.t), y: m.rise.uGy_per_day, shape: 'diamond', hollow: true, color: '--lf-text', size: 4.5, ...(daysOnly ? {} : { label: 'first clear rise' }) })
    return out
  }, [data, m, daysOnly])
  const xFormat = useMemo(() => (v: number) => axisTick(data, v, daysOnly), [data, daysOnly])
  const aria =
    `MSL RAD dose rate E at Gale crater, ${s.x.length} native iSWA samples from ${dayHmUtc(data.axis.start)} to ${dayHmUtc(data.axis.stop)}, in ${UNIT}: ` +
    `5-day background ${formatNumber(s.background, 1)}, ${formatNumber(data.rad.threshold_factor)} × background ${formatNumber(s.threshold, 1)}, ` +
    (m.rise ? `first clear rise ${formatNumber(m.rise.uGy_per_day, 2)} at ${dayHmUtc(m.rise.t)}, ` : '') +
    `peak ${formatNumber(m.peak.uGy_per_day, 2)} at ${dayHmUtc(m.peak.t)} (${formatNumber(m.peakRatio, 3)} times the background)` +
    (m.back ? `, back below the background at ${dayHmUtc(m.back.t)}` : '') +
    '.'
  return (
    <TimeChart
      x={s.x}
      lines={lines}
      hlines={hlines}
      marks={marks}
      yMin={200}
      yMax={270}
      xMin={0}
      xMax={axisSpan(data)}
      xFormat={xFormat}
      height={200}
      ariaLabel={aria}
    />
  )
}

const dayX = (d: Sol242Data, iso: string) => (Date.parse(iso) - Date.parse(d.axis.start)) / 86_400_000

// ---- the panel --------------------------------------------------------------------------------------------------

export interface Sol242ViewProps {
  data: Sol242Data
  snap: Snapshot<Sol242Data> | null
  status: LoadStatus
  /** swpc_spe_list data when ready (the hero sentence and the Earth row read NOAA's list). */
  list: SpeListLike | null
  /** Start (UTC) of the modelled conjunction window that holds the scenario's "now", from useComms. */
  heroWindowStartUtc: string | null
}

/** Pure view (rendered by the test): no hooks besides chart state, no fetches. */
export function Sol242View({ data, snap, status, list, heroWindowStartUtc }: Sol242ViewProps) {
  const [plotW, setPlotW] = useState(800)
  const daysOnly = plotW < NARROW_PLOT_PX
  const shortLimit = plotW < SHORT_LIMIT_PLOT_PX
  const cur = jplWindow(data, '2013_curiosity')
  const inside = cur ? axisInside(data, cur) && data.axis.inside_curiosity_window : false
  const m = radMoments(data)
  const s = radSeries(data)
  const peaks = hetPeaks(data, HET_MEV)
  const caption = fragment(data, 'fig5_caption')
  const lit = data.literature
  const event = noaaEntry(list, data.noaa.event)
  const hero = noaaEntry(list, data.noaa.scenario_event)
  const year = heroYear(heroWindowStartUtc)
  const mor = moratoriumRange(data)
  const t1 = data.table1
  const enh = fragment(data, 'enhancement_30')
  const minE = fragment(data, 'min_energy')
  const leading = fragment(data, 'stereo_b_leading')
  const fourA = fragment(data, 'four_orders_subject')
  const fourB = fragment(data, 'four_orders')
  const topBin = Math.max(...data.stereo_b.bin_centres_MeV)
  const paperAuthors = lit.authors_short.replace(/ [A-Z]+ et al\.$/, ' et al.')
  const paperRef = `${paperAuthors} ${lit.year}`
  /** The Table 1 row is Löwe et al.'s; the paper quoted here has a Table 1 of its own, so the dates line names both. */
  const t1Authors = t1.paper_ref.split(',')[0].replace(/ \d{4}$/, '')
  const sol = solNumber(data)
  const eyebrow = (
    <span className="lf-tr-kind" data-kind="historical">
      HISTORICAL · MEASURED
    </span>
  )
  const footer = (
    <>
      <FreshnessChip meta={snap} status={status} id={SOL242_SNAPSHOT_ID} source={snap?.source} />
      {snap ? <span>{snap.source.name}</span> : null}
    </>
  )
  return (
    <Panel id={SOL242_ID} title={SOL242_TITLE} eyebrow={eyebrow} footer={footer} className="lf-s242">
      {cur ? (
        <figure className="lf-s242-jpl" data-sol242-jpl="">
          <blockquote>
            <p>“{cur.quote}”</p>
          </blockquote>
          <figcaption>
            {cur.publisher}, {dayLong(cur.published)}, “{cur.doc}” <Chip kind={LIT} /> <Ext href={cur.url}>JPL news release</Ext>
            {cur.quote_verified_this_build ? null : (
              <span className="lf-tr-muted">
                {' '}
                · quote read by hand in the page’s HTML{readByHandOn(cur) ? ` on ${readByHandOn(cur)}` : ''} (the page refused the build’s client)
              </span>
            )}
          </figcaption>
          <p className="lf-s242-jpl-span">
            {inside ? (
              <>
                The whole span shown, {axisText(data)}, lies inside JPL’s planned Curiosity moratorium ({windowDays(cur)}).
              </>
            ) : (
              <>JPL’s planned Curiosity moratorium: {windowDays(cur)} 2013.</>
            )}
          </p>
        </figure>
      ) : null}
      <p>
        On {sol ? `sol ${sol}` : `${dayMonth(m.peak.t)} ${m.peak.t.slice(0, 4)}`}, Curiosity’s RAD measured a solar particle event at Gale crater. Rebuilt here from NASA’s
        public records on one UTC axis: STEREO-B’s proton flux (CDAWeb), then RAD’s dose rate (iSWA).
      </p>
      <div className="lf-s242-row">
        <h3 className="lf-rad-h4">STEREO-B HET · proton flux, hourly means</h3>
        <HetChart data={data} daysOnly={daysOnly} onPlotWidth={(w) => setPlotW((c) => (Math.abs(c - w) >= 2 ? w : c))} />
        <p className="lf-tr-muted lf-rad-sep-axis">
          {FLUX_UNIT}, log scale. Solid: the 80 MeV bin; dashed: the 50 MeV bin.{' '}
          {peaks.length ? `${peaks.map((p, i) => `${i ? 'hollow' : 'Filled diamond'}: the ${p.mev} MeV peak hour`).join('; ')}. ` : null}
          {peaks.map((p, i) => (
            <span key={p.mev}>
              {i ? ' ' : ''}
              {p.mev} MeV peaks at <Mono>{sci3(p.mean)}</Mono> (hour from {hourUtc(p.hour)} UTC, {dayMonth(p.hour)}),{' '}
              <Num value={p.multiple} unit="×" /> its {quietText(data)} median of <Mono>{sci3(p.quiet)}</Mono>.
            </span>
          ))}{' '}
          <Chip kind={DERIVED} /> <Chip kind={DESIGN} />
        </p>
      </div>
      <div className="lf-s242-row">
        <h3 className="lf-rad-h4">Curiosity RAD · dose rate E at Gale crater</h3>
        <RadChart data={data} daysOnly={daysOnly} shortLimit={shortLimit} />
        <p className="lf-tr-muted lf-rad-sep-axis">
          {UNIT}. Dots: native iSWA samples, <Num value={Math.round(s.minSpacingMin)} /> to <Num value={Math.round(s.maxSpacingMin)} unit="min" /> apart. Lower dashed
          line: the 5-day background (<Num value={s.background} digits={1} unit={UNIT} />, <Num value={data.rad.background.n_samples} /> samples); the labelled line:{' '}
          <Num value={data.rad.threshold_factor} unit="×" /> background, the RAD team’s trigger. Filled diamond: the peak{m.rise ? '; hollow: the first clear rise' : ''}.
        </p>
      </div>
      <p className="lf-s242-peak" data-sol242-peak="">
        Peak at Gale crater: <Num value={m.peak.uGy_per_day} digits={2} unit={UNIT} /> at <time dateTime={m.peak.t}>{dayHmUtc(m.peak.t)}</time>,{' '}
        <Num value={m.peakRatio} digits={3} unit="×" /> the background
        {m.rise ? (
          <>
            ; first clear rise at <time dateTime={m.rise.t}>{dayHmUtc(m.rise.t)}</time> (<Num value={m.rise.ratio_to_background} digits={3} unit="×" />, above{' '}
            <Num value={data.rad.rise_factor} unit="×" /> <Chip kind={DESIGN} />)
          </>
        ) : null}
        {m.back ? (
          <>
            ; back below the background at <time dateTime={m.back.t}>{dayHmUtc(m.back.t)}</time>
          </>
        ) : null}
        . <Chip kind={DERIVED} />
      </p>
      {event ? (
        <p className="lf-s242-earth" data-sol242-earth="">
          <span className="lf-rad-label">At Earth</span> NOAA lists a solar proton event from <time dateTime={event.start}>{dayHmUtc(event.start)}</time>, maximum{' '}
          <time dateTime={event.max}>{dayHmUtc(event.max)}</time>, <Num value={event.peak_pfu} unit="pfu" digits={0} /> (S{event.s_level}) at{' '}
          {data.noaa.energy ?? '>10 MeV'}. <Chip kind={NOAA} />
        </p>
      ) : null}
      {caption ? (
        <figure className="lf-rad-quote lf-s242-caption" data-sol242-caption="">
          <blockquote>
            <p>“{caption}”</p>
          </blockquote>
          <figcaption>
            {paperRef}, {lit.journal} {lit.volume}:{lit.article_number}, Fig. 5 caption (A to C), verbatim <Chip kind={LIT} /> <Ext href={lit.doi_url}>{`doi:${lit.doi}`}</Ext>
          </figcaption>
        </figure>
      ) : null}
      {hero && event ? (
        <p data-sol242-hero="">
          <a href="#/">LANDFALL’s scenario</a> replays a storm NOAA lists at <Num value={hero.peak_pfu} unit="pfu" digits={0} /> (S{hero.s_level}) at Earth,{' '}
          {monthYearLong(hero.start)}, inside the modelled {year ? `${year} ` : ''}conjunction; this one is listed at <Num value={event.peak_pfu} unit="pfu" digits={0} /> (S
          {event.s_level}). <Chip kind={NOAA} />
        </p>
      ) : null}
      {mor ? (
        <p className="lf-tr-muted" data-sol242-moratoria="">
          RAD kept recording through every published window since {mor.since}: <Num value={mor.min} /> to <Num value={mor.max} /> samples each in iSWA’s record (
          <Num value={mor.n} /> windows). <Chip kind={DERIVED} />
        </p>
      ) : null}
      <Expander summary="What this does and does not show">
        <ul className="lf-s242-limits">
          <li>
            The storm was small at the surface: <Num value={m.peakRatio} digits={3} unit="×" /> the background in the public samples, below the RAD team’s{' '}
            <Num value={data.rad.threshold_factor} unit="×" /> rule at their <Num value={Math.round(s.minSpacingMin)} /> to <Num value={Math.round(s.maxSpacingMin)} unit="min" />{' '}
            spacing. {enh ? <>The paper’s text: “… {enh}”. </> : null}
            {t1.paper.triggered ? (
              <>
                {t1.paper_ref.split(',')[0]} list it in Table 1 as triggered, with a total SEP dose of <Num value={t1.paper.total_uGy} digits={2} unit="µGy" />{' '}
                <Chip kind={LIT} />.
              </>
            ) : null}
          </li>
          <li>
            Three dates: {t1Authors}’s Table 1 <span className="lf-s242-date">“{lit.dates.table1}”</span>, {paperAuthors}’s Fig. 5 “{lit.dates.fig5}” and Fig. 1 “{lit.dates.fig1}”. The data peak on{' '}
            <time dateTime={m.peak.t}>{dayHmUtc(m.peak.t)}</time>.
          </li>
          <li>
            Different instruments, places and quantities: dose rate in plastic at Gale crater ({UNIT}), proton flux per energy bin at STEREO-B ({FLUX_UNIT}) and NOAA’s{' '}
            {data.noaa.energy ?? '>10 MeV'} flux at Earth (pfu). No Gy-to-Sv step is taken, and no arrival times are compared.
            {minE ? (
              <>
                {' '}
                The paper: “{minE}” STEREO-B’s highest bin is centred at <Num value={topBin} unit="MeV" />.
              </>
            ) : null}
            {fourA && fourB ? (
              <>
                {' '}
                And: “{fourA} … {fourB}”.
              </>
            ) : null}
          </li>
          <li>
            Linking the three records is the paper’s claim (its Fig. 5 caption, quoted above), not LANDFALL’s.{leading ? <> In its words: “{leading}”</> : null}
          </li>
        </ul>
      </Expander>
    </Panel>
  )
}

/** Mounted on #/radiation for the Mars surface only; null while its snapshot is loading or missing. */
export default function Sol242Panel() {
  const s = useSnapshot<Sol242Data>(SOL242_SNAPSHOT_ID)
  const list = useSnapshot<SpeListLike>(SPE_LIST_SNAPSHOT_ID)
  const comms = useComms('mars_surface', MET_NOW_S)
  if (s.status !== 'ready' || !s.data) return null
  return (
    <Sol242View
      data={s.data}
      snap={(s.snapshot as Snapshot<Sol242Data> | null) ?? null}
      status={s.status}
      list={list.status === 'ready' ? (list.data ?? null) : null}
      heroWindowStartUtc={comms.window?.startUtc ?? null}
    />
  )
}
