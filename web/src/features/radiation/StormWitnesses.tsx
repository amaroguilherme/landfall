// "This storm had witnesses": the October 1989 event this page replays began and peaked while STS-34 was in
// orbit. Four lines, every fact read from a frozen snapshot: the flight (NASA mission page, history_sts34),
// the replay's onset / first S3 / peak computed from swpc_spe_replay, NASA-STD-3001 Vol 1's glossary and a
// Shuttle radiation team's abstract on why low orbit is a different place, and [V1 4031] verbatim. It computes
// no ratio and attributes no dose to STS-34 (the abstract's maximum covers STS-28 and STS-34 together).
import { useSnapshot } from '../../app/data'
import type { LoadStatus, Snapshot } from '../../app/data'
import { CHIP_DEFS } from '../../app/vocab'
import { Chip, FreshnessChip, Num, Panel, ReqId, StaleIcon } from '../../ui'
import type { ReplayData, RequirementRec } from './model'
import { HISTORY_SNAPSHOT_ID, dayTimeUtc, inWindow, quoteText, replayMoments, speGlossarySentence, v1_4031 } from './witnesses'
import type { GlossaryRec, HistoryData, ReplayWithEvent } from './witnesses'

const chipFor = (kind: string, fallback: string) => CHIP_DEFS.find((c) => c.source_kind === kind)?.id ?? fallback
const LIT = chipFor('literature', 'literature')
const DERIVED = chipFor('derived', 'derived')
const NASA = chipFor('nasa_standard', 'NASA-published')

export interface StormWitnessesProps {
  history: HistoryData | null
  historySnap: Snapshot<HistoryData> | null
  historyStatus: LoadStatus
  replay: ReplayWithEvent | null
  reqs: readonly RequirementRec[]
  glossary: readonly GlossaryRec[]
  vol1Doc: string
}

/** Pure view (rendered by the never-print test): no hooks, no fetches. */
export function StormWitnessesView({ history, historySnap, historyStatus, replay, reqs, glossary, vol1Doc }: StormWitnessesProps) {
  const footer = <FreshnessChip meta={historySnap} status={historyStatus} id={HISTORY_SNAPSHOT_ID} source={historySnap?.source} />
  const eyebrow = (
    <span className="lf-tr-kind" data-kind="historical">
      HISTORY · STS-34, OCTOBER 1989
    </span>
  )
  if (!history) {
    return (
      <Panel title="This storm had witnesses" eyebrow={eyebrow} footer={footer}>
        <p className="lf-tr-nodata">
          <StaleIcon size={13} /> STS-34 record ({HISTORY_SNAPSHOT_ID}) {historyStatus === 'loading' ? 'loading' : 'not in this build'}.
        </p>
      </Panel>
    )
  }
  const f = history.flight
  const m = replayMoments(replay)
  const inside = m ? [m.onset, m.firstS3, m.peak].every((t) => inWindow(t, f.launch_utc, f.landing_utc)) : false
  const after = m?.unbrokenUntil && Date.parse(m.unbrokenUntil) > Date.parse(f.landing_utc) ? m.unbrokenUntil : null
  const gl = speGlossarySentence(glossary)
  const g = history.golightly_1992
  const maxDose = quoteText(g.quotes, 'max_dose')
  const factors = quoteText(g.quotes, 'factors')
  const r4031 = v1_4031(reqs)
  const crewQuote = quoteText(history.nasa_page.quotes, 'crew')
  return (
    <Panel title="This storm had witnesses" eyebrow={eyebrow} footer={footer} className="lf-rad-witness">
      <ol className="lf-rad-witness-lines">
        <li>
          <strong>STS-34</strong> (Space Shuttle {f.orbiter}, the {f.payload.split(';')[0]} deployment) had{' '}
          {crewQuote ? (
            <>
              <Num value={f.crew_count} /> astronauts
            </>
          ) : (
            'its crew'
          )}{' '}
          in orbit from <time dateTime={f.launch_utc}>{dayTimeUtc(f.launch_utc, true)}</time> to{' '}
          <time dateTime={f.landing_utc}>{dayTimeUtc(f.landing_utc)}</time>, at <Num value={f.orbit_altitude_nmi} unit="nautical miles" /> and{' '}
          <Num value={f.orbit_inclination_deg} unit="°" /> inclination.{' '}
          <span className="lf-tr-muted">
            NASA’s mission page, converted to UTC from {f.launch_local.split(', ').slice(-1)[0]} and {f.landing_local.split(', ').slice(-1)[0]}{' '}
            <Chip kind={DERIVED} /> <Chip kind={LIT} />{' '}
            <a href={history.nasa_page.url} target="_blank" rel="noopener noreferrer">
              NASA: STS-34
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </span>
        </li>
        <li>
          {m ? (
            <>
              The replay above {inside ? 'began, reached S3 and peaked inside that flight' : 'does not fall wholly inside that flight'}: onset{' '}
              <time dateTime={m.onset}>{dayTimeUtc(m.onset)}</time>
              {m.firstS3 ? (
                <>
                  , first S3 <time dateTime={m.firstS3}>{dayTimeUtc(m.firstS3)}</time>
                </>
              ) : null}
              , and its peak of <Num value={m.peakPfu} unit="pfu" digits={0} /> at <time dateTime={m.peak}>{dayTimeUtc(m.peak)}</time>.
              {after ? (
                <>
                  {' '}
                  The crew landed while it was still under way: the ≥10 MeV flux stayed at or above 10 pfu until{' '}
                  <time dateTime={after}>{dayTimeUtc(after)}</time>.
                </>
              ) : null}{' '}
              <span className="lf-tr-muted">
                Computed from the GOES-7 record on this page <Chip kind={DERIVED} />
              </span>
            </>
          ) : (
            <span className="lf-tr-nodata">
              <StaleIcon size={13} /> The October 1989 replay (swpc_spe_replay) is not available, so its moments cannot be placed.
            </span>
          )}
        </li>
        <li>
          Low Earth orbit is inside the magnetosphere.{' '}
          {gl ? (
            <>
              NASA-STD-3001 Vol 1{gl.appendix ? `, Appendix ${gl.appendix.split(' ')[0]}` : ''}, on solar particle events: “… {gl.sentence}”{' '}
              <Chip kind={NASA} />{' '}
            </>
          ) : null}
          {maxDose ? (
            <>
              On the solar particle events during STS-28 and STS-34: “{maxDose}”
              {factors ? <> And: “… {factors} …”</> : null}{' '}
              <span className="lf-tr-muted">
                {g.authors[0]?.split(' ')[0]} et al., {g.journal} {g.year};{g.volume}({g.issue}):{g.pages} <Chip kind={LIT} />{' '}
                <a href={g.pubmed_url} target="_blank" rel="noopener noreferrer">
                  PubMed {g.pmid}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </span>
            </>
          ) : null}
        </li>
        <li>
          Beyond the magnetosphere, this is the design-reference storm.{' '}
          {r4031 ? (
            <>
              <ReqId id="V1 4031" /> “{r4031.text}” <span className="lf-tr-muted">{vol1Doc}</span> <Chip kind={NASA} />
            </>
          ) : (
            <span className="lf-tr-nodata">
              <StaleIcon size={13} /> <ReqId id="V1 4031" /> text not in this build (std_vol1_requirements).
            </span>
          )}
        </li>
      </ol>
    </Panel>
  )
}

/** Mounted once, directly below the proton panel, in every environment. */
export default function StormWitnesses() {
  const h = useSnapshot<HistoryData>(HISTORY_SNAPSHOT_ID)
  const r = useSnapshot<ReplayData>('swpc_spe_replay')
  const v1 = useSnapshot<{ requirements: RequirementRec[]; glossary: GlossaryRec[]; document?: { cover_number_verbatim?: string } }>('std_vol1_requirements')
  return (
    <StormWitnessesView
      history={h.status === 'ready' ? (h.data ?? null) : null}
      historySnap={(h.snapshot as Snapshot<HistoryData> | null) ?? null}
      historyStatus={h.status}
      replay={r.status === 'ready' ? ((r.data as ReplayWithEvent | null) ?? null) : null}
      reqs={v1.data?.requirements ?? []}
      glossary={v1.data?.glossary ?? []}
      vol1Doc={v1.data?.document?.cover_number_verbatim ?? (v1.snapshot as Snapshot<unknown> | null)?.source.name ?? 'NASA-STD-3001 Vol 1'}
    />
  )
}
