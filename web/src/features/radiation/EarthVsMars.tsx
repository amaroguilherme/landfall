// Mars surface only, inside "Who watches the Sun here, and who raises the alarm": the storms the RAD team lists at
// Gale (its Table 1) against the Earth proton list that covers their dates (NOAA's list, then DONKI's GOES-P ≥10 MeV
// entries). A cross-match of three shipped snapshots (earthVsMarsMatch.ts); dates are matched, never events, and no cause
// is stated. Nothing here feeds the engine, the rules, the hero or the scenario.
import { Fragment, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useSnapshot } from '../../app/data'
import { CHIP_DEFS } from '../../app/vocab'
import { Chip, Expander, Num } from '../../ui'
import { GOES_P_10MEV, RAD_GAP_DAYS, crossMatch, longestRadGap } from './earthVsMarsMatch'
import type { Catalogue, CrossMatch, DonkiLike, SensitivityRow, SpanResult, Totals } from './earthVsMarsMatch'
import { SEP_SNAPSHOT_ID, donkiGap, firstAuthorFamily, isoMinute } from './marsSep'
import type { SepEventsData, SpeListLike } from './marsSep'
import { monthYear } from './model'
import type { DonkiData } from './model'

const chipFor = (kind: string, fallback: string) => CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? fallback
const LIT = chipFor('literature', 'literature')
const DERIVED = chipFor('derived', 'derived')
const DESIGN = chipFor('design_choice', 'design choice')
const UGY = 'µGy'

const LIST_NAME: Record<Catalogue, ReactNode> = {
  noaa: 'NOAA’s list of solar proton events',
  donki: (
    <>
      DONKI, <span className="lf-rad-evm-keep">GOES-P</span> ≥10 MeV entries
    </>
  ),
}
const EVENT_WORD: Record<Catalogue, string> = { noaa: 'events', donki: 'entries' }

/** The block's DOM id: the habitat dose panel's pointer (MarsSepRecord.tsx EVM_POINTER) jumps here. */
export const EVM_ID = 'rad-earth-vs-mars'

const day = (iso: string) => iso.slice(0, 10)
const days = (n: number) => (n === 1 ? 'day' : 'days')
/** "20 May 2024" from "2024-05-20" (UTC, the app's own month names). */
const longDate = (d: string) => `${Number(d.slice(8, 10))} ${monthYear(`${d}T00:00:00Z`)}`
/** A row's date (whole UTC day) lies strictly inside a DONKI gap. */
const within = (d: string, g: { start: string; stop: string }) => Date.parse(g.start) < Date.parse(`${d}T00:00:00Z`) && Date.parse(`${d}T23:59:59Z`) < Date.parse(g.stop)

function and(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "a", "a and b", "a, b and c" for rendered parts (dates in <time>, mono by the global rule). */
function AndList({ items }: { items: ReactNode[] }) {
  return (
    <>
      {items.map((x, i) => (
        <Fragment key={i}>
          {i === 0 ? null : i === items.length - 1 ? ' and ' : ', '}
          {x}
        </Fragment>
      ))}
    </>
  )
}

/** "36.7 % (158.25 of 431.35 µGy, n = 5)": a share never goes without its doses and its n. */
function Share({ t, of = true }: { t: Totals; of?: boolean }) {
  return (
    <>
      <Num value={t.share} digits={1} unit="%" /> (
      {of ? (
        <>
          <Num value={t.doseNoEarth_uGy} digits={2} /> of <Num value={t.dose_uGy} digits={2} unit={UGY} />
        </>
      ) : (
        <Num value={t.doseNoEarth_uGy} digits={2} unit={UGY} />
      )}
      , <span className="lf-rad-evm-keep">
        n = <Num value={t.n} />
      </span>
      )
    </>
  )
}

function spanTotals(s: SpanResult): Totals {
  return { n: s.table1Triggered, withEarth: s.withEarth.length, dose_uGy: s.dose_uGy, doseNoEarth_uGy: s.doseNoEarth_uGy, share: s.dose_uGy > 0 ? (100 * s.doseNoEarth_uGy) / s.dose_uGy : null }
}

function Row({ head, t }: { head: ReactNode; t: Totals }) {
  return (
    <tr>
      <th scope="row">{head}</th>
      <td className="num">
        <Num value={t.withEarth} /> of <Num value={t.n} />
      </td>
      <td className="num lf-rad-evm-share">
        <Share t={t} />
      </td>
    </tr>
  )
}

export function EarthVsMarsView({ match, sep }: { match: CrossMatch | null; sep: SepEventsData | null }) {
  if (!match || !sep || !match.spans.length) return null
  const w = match.windowDays
  const c = match.combined
  const gap = donkiGap(sep)
  const lead = longestRadGap(sep)
  const spot = match.spotlight
  const wl = match.withoutLargest
  const s3 = match.s3
  const excludedHere = match.spans.flatMap((s) => s.earthExcluded)
  // The paper's surface record, and so its Table 1, ends on this date: inside DONKI's span, the storms at Gale stop
  // there and the Earth list does not (the later triggers count only in the whole-record line, in the closed expander).
  const t1End = sep.paper_record_end
  const t1EndsInside = (s: SpanResult) => Boolean(t1End) && day(s.from) <= t1End && t1End < day(s.to)
  const caption = 'Storms in the RAD team’s Table 1 against the Earth list for their dates'
  return (
    <section id={EVM_ID} data-earth-vs-mars="" className="lf-rad-evm" aria-labelledby="rad-evm-h">
      <h4 id="rad-evm-h" className="lf-rad-h4">
        Earth’s proton lists and the storms measured at Gale
      </h4>
      <p data-evm-lead="">
        Of the <Num value={c.n} /> storms at Gale that triggered the RAD team’s warning rule within {match.spans.length > 1 ? 'these lists’ spans' : 'this list’s span'},{' '}
        <Num value={c.withEarth} /> had an Earth event within <Num value={w} /> {days(w)}; the other <Num value={c.n - c.withEarth} /> carried <Share t={c} /> of their
        total SEP dose.{' '}
        <Chip kind={DERIVED} />
      </p>
      <div className="lf-tr-table-wrap lf-rad-evm-wrap" tabIndex={0} role="region" aria-label={`${caption}, scrollable`}>
        <table className="lf-tr-table lf-rad-evm-table">
          <caption className="lf-rad-caption">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Earth list and span</th>
              <th scope="col" className="lf-rad-evm-wide">
                Storms at Gale with an Earth event within <Num value={w} /> {days(w)}
              </th>
              <th scope="col">Share of their SEP dose with none</th>
            </tr>
          </thead>
          <tbody>
            {match.spans.map((s) => (
              <Row
                key={s.catalogue}
                t={spanTotals(s)}
                head={
                  <>
                    {LIST_NAME[s.catalogue]}
                    <span className="lf-rad-evm-span">
                      <time className="lf-rad-sep-time" dateTime={day(s.from)}>
                        {day(s.from)}
                      </time>{' '}
                      to{' '}
                      <time className="lf-rad-sep-time" dateTime={day(s.to)}>
                        {day(s.to)}
                      </time> ·{' '}
                      <span className="lf-rad-evm-keep">
                        <Num value={s.earthCount} /> {EVENT_WORD[s.catalogue]}
                      </span>
                    </span>
                    {t1EndsInside(s) ? (
                      <span className="lf-rad-evm-span">
                        Table 1 runs to{' '}
                        <time className="lf-rad-sep-time" dateTime={t1End}>
                          {t1End}
                        </time>
                      </span>
                    ) : null}
                  </>
                }
              />
            ))}
            {match.spans.length > 1 ? (
              <Row
                t={c}
                head={
                  <>
                    Both lists, added
                    <span className="lf-rad-evm-span">each matched on its own</span>
                  </>
                }
              />
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="lf-tr-muted" data-evm-sources="">
        Storms, triggers and total SEP doses from the RAD team’s Table 1 ({firstAuthorFamily(sep)} et al., {sep.literature.journal.journal}{' '}
        {sep.literature.journal.published?.slice(0, 4)}; numbers from{' '}
        <a href={sep.literature.arxiv_html} target="_blank" rel="noopener noreferrer">
          arXiv:{sep.literature.arxiv_id}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        , the journal version was not compared) <Chip kind={LIT} />; matches and shares <Chip kind={DERIVED} />; the <Num value={w} />-day window is ours{' '}
        <Chip kind={DESIGN} />
      </p>
      <Expander summary="How this was matched">
        {spot ? (
          <p>
            {(spot.shareOfNoEarth ?? 0) > 50 ? 'Most of the dose with no Earth event is one storm,' : 'The largest storm with no Earth event is'} {longDate(spot.match.row.paper_date)} (
            <Num value={spot.match.dose_uGy} digits={2} unit={UGY} />
            {spot.largestAtGale ? ', the largest at Gale in the paper’s Table 1' : ''}). {spot.catalogue === 'donki' ? 'DONKI’s nearest GOES-P ≥10 MeV entries' : 'The nearest events on NOAA’s list'} are{' '}
            {spot.before ? (
              <>
                <Num value={spot.before.days} /> {days(spot.before.days)} before it
              </>
            ) : (
              'none before it'
            )}{' '}
            and{' '}
            {spot.after ? (
              <>
                <Num value={spot.after.days} /> {days(spot.after.days)} after
              </>
            ) : (
              'none after'
            )}
            {spot.catalogue === 'donki' && gap && within(spot.match.row.paper_date, gap) ? (
              <>
                , and DONKI has no SEP entry from any instrument between{' '}
                <time className="lf-rad-sep-time" dateTime={gap.start}>
                  {gap.start}
                </time>{' '}
                and{' '}
                <time className="lf-rad-sep-time" dateTime={gap.stop}>
                  {gap.stop}
                </time>
              </>
            ) : null}
            .
          </p>
        ) : null}
        <p className="lf-tr-muted">
          Run over the whole record, the rule triggers <Num value={match.replayTriggers} /> times in these spans, <Num value={match.replayWithEarth} /> of them within{' '}
          <Num value={w} /> {days(w)} of an Earth event. Of the <Num value={match.earthCounted} /> Earth events, <Num value={match.earthNearTrigger} /> fall within{' '}
          <Num value={w} /> {days(w)} of a trigger at Gale.
          {s3.listEnd ? (
            <>
              {' '}
              NOAA’s list has <Num value={s3.inRecord} /> storms at S3 or above during Curiosity’s record (this copy of the list ends on{' '}
              <time className="lf-rad-sep-time" dateTime={day(s3.listEnd)}>
                {day(s3.listEnd)}
              </time>
              );{' '}
              {s3.matches.length ? (
                <>
                  <Num value={s3.matches.length} /> {s3.matches.length === 1 ? 'has its' : 'have their'} maximum within <Num value={w} /> {days(w)} of a row of the table (
                  {and(s3.matches.map((m) => monthYear(m.max)))}).
                </>
              ) : (
                <>none has its maximum within <Num value={w} /> {days(w)} of a row of the table.</>
              )}
            </>
          ) : null}
        </p>
        <ul className="lf-rad-evm-method">
          <li>
            Storms at Gale: the rows of the paper’s Table 1 (Martian surface
            {t1End ? (
              <>
                , to{' '}
                <time className="lf-rad-sep-time" dateTime={t1End}>
                  {t1End}
                </time>
              </>
            ) : null}
            ) where its rule triggered, each with the paper’s total SEP dose.
          </li>
          <li>
            Earth lists: NOAA’s list of solar proton events at ≥10 MeV, each event placed at its maximum; DONKI’s SEP entries whose instrument is “{GOES_P_10MEV}”,
            placed at their event time. Other instruments and model entries are not used.
          </li>
          {match.spans.map((s) => (
            <li key={s.catalogue}>
              {s.catalogue === 'noaa' ? (
                <>
                  NOAA’s span runs from <span className="lf-num">{s.from}</span>
                  {lead && lead.to === s.from ? (
                    <>
                      , the end of RAD’s <Num value={lead.days} digits={1} />
                      -day gap at the start of its iSWA record,
                    </>
                  ) : null}{' '}
                  to the list’s last event start, <span className="lf-num">{s.to}</span>.
                </>
              ) : (
                <>
                  DONKI’s span runs from the start of this build’s copy, <span className="lf-num">{s.from}</span>, to{' '}
                  {s.to === sep.record.last_sample ? 'the last RAD sample' : 'the end of that copy'}, <span className="lf-num">{s.to}</span>.
                </>
              )}
            </li>
          ))}
          <li>
            A storm has an Earth event when the two UTC dates are at most <Num value={w} /> {days(w)} apart <Chip kind={DESIGN} />. Gaps are counted in whole UTC
            days.
          </li>
          <li>
            Triggers: the run of the RAD team’s rule over the whole record (further down this page), by onset date. An Earth event whose window touches a RAD gap
            longer than{' '}
            <Num value={RAD_GAP_DAYS} /> days is left out of the Earth side
            {excludedHere.length ? null : (
              <>
                {' '}
                (none at <Num value={w} /> {days(w)})
              </>
            )}
            .
          </li>
        </ul>
        <div className="lf-tr-table-wrap lf-rad-evm-wrap" tabIndex={0} role="region" aria-label="The same match at other windows, scrollable">
          <table className="lf-tr-table lf-rad-evm-table" data-evm-sensitivity="">
            <caption className="lf-rad-caption">The same match at other windows</caption>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Storms with an Earth event</th>
                <th scope="col">Their SEP dose with none</th>
                <th scope="col">Earth events near a trigger</th>
              </tr>
            </thead>
            <tbody>
              {match.sensitivity.map((s) => (
                <tr key={s.days} data-current={s.days === w || undefined}>
                  <th scope="row">
                    <Num value={s.days} /> {days(s.days)}
                    {s.days === w ? <span className="lf-rad-evm-span">used above</span> : null}
                  </th>
                  <td className="num">
                    <Num value={s.withEarth} /> of <Num value={s.n} />
                  </td>
                  <td className="num lf-rad-evm-share">
                    <Share t={s} of={false} />
                  </td>
                  <td className="num">
                    <Num value={s.earthNearTrigger} /> of <Num value={s.earthCounted} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {match.sensitivity
          .filter((s) => s.excluded.length)
          .map((s) => (
            <LeftOut key={s.days} row={s} />
          ))}
        {wl ? (
          <p>
            Without {longDate(wl.row.paper_date)}, the share with no Earth event is <Share t={wl} />.
          </p>
        ) : null}
        {match.outsideSpans.length ? (
          <p>
            Not counted:{' '}
            <AndList
              items={match.outsideSpans.map((r) => (
                <time key={r.paper_date} className="lf-rad-sep-time" dateTime={r.paper_date}>
                  {r.paper_date}
                </time>
              ))}
            />
            , rows where the rule triggered but this build ships no Earth proton list for the date.
          </p>
        ) : null}
        <p>This compares lists only: a storm absent from a list may still have been seen or forecast at Earth.</p>
        <p>
          Matching dates is not identity: this compares Earth’s ≥10 MeV lists with a surface dose rule at Gale and does not say why they differ. The hero borrows a
          real storm’s shape (GOES-7, October 1989) from an Earth record, not its occurrence at Mars.
        </p>
      </Expander>
    </section>
  )
}

/** The Earth events a window of the sensitivity table leaves out of the Earth side, named by list and time. */
function LeftOut({ row }: { row: SensitivityRow }) {
  const names = row.excluded.map((e) => (
    <Fragment key={`${e.catalogue}|${e.t}`}>
      {e.catalogue === 'noaa' ? 'NOAA’s maximum of' : 'DONKI’s entry of'} <time className="lf-rad-sep-time" dateTime={isoMinute(e.t)}>
        {isoMinute(e.t)}
      </time>
    </Fragment>
  ))
  const one = names.length === 1
  return (
    <p className="lf-tr-muted">
      At <Num value={row.days} /> {days(row.days)}, <AndList items={names} /> {one ? 'is' : 'are'} left out of the Earth side: {one ? 'its' : 'their'} window touches a RAD gap
      longer than <Num value={RAD_GAP_DAYS} /> days.
    </p>
  )
}

/** Mounted in ProtonPanel's onboard (Mars) branch; self-loading, nothing while the three snapshots load. */
export default function EarthVsMars() {
  const s = useSnapshot<SepEventsData>(SEP_SNAPSHOT_ID)
  const l = useSnapshot<SpeListLike>('swpc_spe_list')
  const d = useSnapshot<DonkiData>('swpc_sep_events')
  const sep = s.status === 'ready' ? (s.data ?? null) : null
  const list = l.status === 'ready' ? (l.data ?? null) : null
  const events = d.status === 'ready' ? (d.data?.events ?? null) : null
  const cov = d.status === 'ready' ? (d.snapshot?.coverage ?? null) : null
  const loading = s.status === 'loading' || l.status === 'loading' || d.status === 'loading'
  const match = useMemo(() => {
    if (!sep || loading) return null
    // A list that did not load is left out (its span is absent), never replaced by an empty one.
    const donki: DonkiLike | null = events && cov?.start && cov.stop ? { events, coverage: { start: cov.start, stop: cov.stop } } : null
    return crossMatch(sep, list, donki)
  }, [sep, list, events, cov, loading])
  return <EarthVsMarsView match={match} sep={sep} />
}
