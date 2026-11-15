// Section: LANDFALL's coverage of NASA's sample IMM output (NASA-STD-3001 Vol 1 Rev C, Appendix E, Table E.2-1).
// Every likelihood, their sum and the shares come from the frozen snapshot std_vol1_requirements (data.tables
// "Table E.2-1", data.appendix_e), and NASA's words are quoted from it verbatim. Which category each condition
// falls in is LANDFALL's design choice (immCoverage.ts). What Tier B actually flags in the scenario comes from
// the engine, through the same computation as section 3 (TierBEvidence.tsx). Nothing here is fetched from another site.
import { useMemo, useState } from 'react'
import { CASE_DEFS } from '../../app/caseTimeline'
import { useSnapshot } from '../../app/data'
import type { LoadStatus } from '../../app/data'
import { fmtNum } from '../../app/engine'
import type { MissionEvaluation } from '../../app/evaluate'
import { Link } from '../../app/location'
import { useEvaluation } from '../../app/model'
import { CREW } from '../../app/vocab'
import { Chip, EmptyState, Expander, FreshnessChip, Num, ReqId, SimulatedMarker } from '../../ui'
import type { EpisodeDetection, SignalDetection } from './episodes'
import { FoldPanel } from './fold'
import {
  CASE_SHORT,
  CATEGORY_DEFS,
  CATEGORY_ORDER,
  E22_TO_IMM,
  VIA_DEFS,
  abstractOf,
  appendixE,
  casesWithoutRows,
  coverageRows,
  coverageSummary,
  fmtShare,
  headline,
  hrrOfRenalRedFlags,
  immTable,
  isRenalRedFlag,
  symptomLabels,
} from './immCoverage'
import type { AppendixE, CategoryTotal, CoverageCategory, CoverageEntry, CoverageRow, CoverageSummary, ImmTable } from './immCoverage'
import { sentencesContaining } from './rules'
import type { MetaFile, PersonalFile, ThresholdsFile, Vol1Data } from './rules'
import { secNum } from './sections'
import { MissingNote, RichText, Verbatim } from './shared'
import { tierBCatch, useEpisodeDetection } from './TierBEvidence'
import './coverage.css'

type Vol1WithAppendixE = Vol1Data & { tables?: unknown; appendix_e?: unknown }

const SNAP = 'std_vol1_requirements'
const DOC = 'NASA-STD-3001 Vol 1 Rev C'

/** The part of [V1 3003] this section answers to, quoted only if the frozen statement holds it verbatim. */
const V1_3003_CLAUSE =
  'to monitor physiological and psychosocial well-being and enable delivery of in-mission preventive health care, based on epidemiological evidence-based probabilistic risk assessment (PRA)'

/** personal.json indicator ids of the sleep case's shortened sleep and of its signed midpoint shift. */
const SLEEP_DURATION = 'sleep_duration'
const SLEEP_MIDPOINT = 'sleep_midpoint_shift'

/** What "watched" amounts to on the shipped scenario, from the engine (section 3's computation and bands). */
export interface WatchedEvidence {
  /** Tier B flags `caught` of the `signals` alerting signals the scenario scripts (TierBEvidence's tierBCatch). */
  caught: number
  signals: number
  /** The sleep case's scripted episode: the signal Tier B flags first (it opens the case), and the alerting signals it never flags. */
  sleep: { crewId: string; opener: SignalDetection | null; missed: SignalDetection[] } | null
  /** Each crewmember's lower sleep-duration band edge (the band section 3 prints), or null without an evaluation. */
  sleepFloors: { crewId: string; low: number | null }[] | null
}

export function watchedEvidence(episodes: readonly EpisodeDetection[], evaluation: MissionEvaluation | null): WatchedEvidence {
  const { caught, signals } = tierBCatch(episodes)
  const ep = episodes.find((e) => e.caseId === 'sleep_circadian') ?? null
  const alerting = ep ? ep.signals.filter((s) => s.tierB?.alerting) : []
  const flagged = alerting.filter((s) => (s.tierB?.days.length ?? 0) > 0)
  const first = (s: SignalDetection) => Math.min(...(s.tierB?.days ?? []))
  const opener = flagged.length ? flagged.reduce((a, b) => (first(b) < first(a) ? b : a)) : null
  return {
    caught,
    signals: signals.length,
    sleep: ep ? { crewId: ep.crewId, opener, missed: alerting.filter((s) => !(s.tierB?.days.length ?? 0)) } : null,
    sleepFloors: evaluation
      ? CREW.map((c) => ({
          crewId: c.id,
          low: evaluation.crew[c.id]?.tierB.find((p) => p.indicator.id === SLEEP_DURATION)?.finding.band?.low ?? null,
        }))
      : null,
  }
}

export function CoverageSection({ meta, personal, thresholds }: { meta: MetaFile; personal: PersonalFile; thresholds: ThresholdsFile }) {
  const v1 = useSnapshot<Vol1WithAppendixE>(SNAP)
  const table = immTable(v1.data)
  const rows = table ? coverageRows(table) : null
  const summary = rows ? coverageSummary(rows) : null
  const detection = useEpisodeDetection()
  const { evaluation } = useEvaluation()
  const watched = useMemo(
    () => (detection.data && !detection.data.error ? watchedEvidence(detection.data.episodes, evaluation) : null),
    [detection.data, evaluation],
  )
  return (
    <FoldPanel
      s="coverage"
      eyebrow="Scope, scored against NASA’s own list"
      title="Coverage of NASA’s sample IMM output"
      abstract={abstractOf(summary)}
      footer={
        <>
          <span>
            Source: {DOC}, Appendix E (Table E.2-1{table ? <>, PDF pages {table.pages.map((p) => p.pdf_page_number).join('–')}</> : null}; sections
            E.2.2 and E.2.3; Table E.2-2), quoted verbatim.
          </span>
          <FreshnessChip meta={v1.snapshot} status={v1.status} id={SNAP} />
          <span>
            Category of each condition: <Chip kind="design choice" /> (<code className="lf-m-path">features/method/immCoverage.ts</code>)
          </span>
        </>
      }
    >
      {v1.status === 'loading' ? (
        <EmptyState kind="loading" title="Reading the frozen standard" headingLevel={3}>
          <p>Loading Table E.2-1 from this build.</p>
        </EmptyState>
      ) : !table || !rows || !summary ? (
        <MissingNote>
          Table E.2-1 is not in snapshot <code>{SNAP}.json</code>
          {v1.status !== 'ready' ? <> (snapshot {v1.status})</> : null}, so this build cannot score its coverage. Shown on purpose:{' '}
          <ReqId id="V2 10020" /> requires an indication when data is missing.
        </MissingNote>
      ) : (
        <CoverageBody
          table={table}
          rows={rows}
          summary={summary}
          v1={v1.data}
          ctx={{ meta, personal, thresholds }}
          watched={watched}
          watchedStatus={detection.data?.error ? 'error' : detection.status}
        />
      )}
    </FoldPanel>
  )
}

export interface Ctx {
  meta: MetaFile
  personal: PersonalFile
  thresholds: ThresholdsFile
}

/** "sleep duration (actigraphy), PVT-B lapses or PVT-B median reaction time" */
function orWords(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** The honesty block next to "Asked is not detected": what Tier B flags of the scenario's scripted signals. */
function WatchedBlock({ watched, status }: { watched: WatchedEvidence | null | undefined; status: LoadStatus | undefined }) {
  const tiers = <Num value={secNum('tiers')} />
  const sleep = watched?.sleep ?? null
  const opener = sleep?.opener ?? null
  const shortMissed = !!sleep?.missed.some((s) => s.tierB?.indicatorId === SLEEP_DURATION)
  const floors = watched?.sleepFloors?.filter((f) => f.low !== null) ?? []
  return (
    <div className="lf-m-aside lf-cov-watched">
      <h3 className="lf-m-h4">
        Watched is not detected
        {watched ? (
          <>
            {' '}
            <SimulatedMarker variant="inline" />
          </>
        ) : null}
      </h3>
      {watched ? (
        <>
          <p>
            On this simulator’s noise Tier B flags <Num value={watched.caught} /> of the <Num value={watched.signals} /> alerting signals the scenario
            scripts (section {tiers})
            {sleep && opener ? (
              <>
                ; <span className="lf-mono">{sleep.crewId}</span>’s sleep case opened on{' '}
                {opener.tierB?.indicatorId === SLEEP_MIDPOINT ? <>the scripted schedule shift ({midSentence(opener.label)})</> : midSentence(opener.label)}
                {shortMissed ? ', not on the shortened sleep' : null}
              </>
            ) : null}
            .
            {sleep && sleep.missed.length ? <> Tier B flags none of the scripted days of {orWords(sleep.missed.map((s) => midSentence(s.label)))}.</> : null}
          </p>
          {floors.length ? (
            <p className="lf-m-small">
              The sleep-duration band flags a night only below about{' '}
              {floors.map((f, i) => (
                <span key={f.crewId}>
                  {i === 0 ? '' : i === floors.length - 1 ? ' and ' : ', '}
                  <Num value={f.low} digits={1} unit="h" />
                  {f.low! > 0 ? null : ' (no night can be that short)'} for <span className="lf-mono">{f.crewId}</span>
                </span>
              ))}
              : the lower edge of each crewmember’s own band (section {tiers}). A watched row counts what a case tests, not what it would catch.
            </p>
          ) : null}
        </>
      ) : (
        <p>
          {status === 'loading' ? (
            'Reading the scenario to count what Tier B flags…'
          ) : (
            <>The scenario is not available in this build, so what Tier B flags of its scripted signals cannot be counted here (section {tiers}).</>
          )}{' '}
          A guided case watching a condition does not mean it would detect it.
        </p>
      )}
    </div>
  )
}

export function CoverageBody({
  table,
  rows,
  summary,
  v1,
  ctx,
  watched,
  watchedStatus,
}: {
  table: ImmTable
  rows: CoverageRow[]
  summary: CoverageSummary
  v1: Vol1WithAppendixE | null
  ctx: Ctx
  /** What Tier B flags in the scenario (null while loading or when the scenario is missing). */
  watched?: WatchedEvidence | null
  watchedStatus?: LoadStatus
}) {
  const appx = appendixE(v1)
  const lead = headline(rows)
  const r3003 = v1?.requirements.find((r) => r.id === 'V1 3003')
  const clause = r3003 && r3003.text.includes(V1_3003_CLAUSE) ? V1_3003_CLAUSE : null
  const pointer = sentencesContaining(r3003?.rationale ?? null, ['Table E.2-1'])[0] ?? null
  const noDiagnosis = ctx.meta.refusals.find((r) => r.id === 'no_diagnosis')?.text ?? null
  const noRow = casesWithoutRows(
    rows,
    CASE_DEFS.map((c) => c.id),
  ).map((id) => CASE_DEFS.find((c) => c.id === id)?.title ?? id)
  return (
    <>
      {lead ? (
        <p className="lf-m-lede lf-cov-lead">
          <RichText text={lead} />
        </p>
      ) : null}
      <p>
        <ReqId id="V1 3003" /> asks every program for training, capabilities and resources{' '}
        {clause ? <>“{clause}”</> : 'based on probabilistic risk assessment'} and on the other bases it lists.
        {pointer ? ' Its rationale points to a sample of that assessment in the same volume:' : null}
      </p>
      {pointer ? (
        <Verbatim
          text={pointer}
          lead="Rationale"
          cite={
            <span>
              {DOC}, <ReqId id="V1 3003" />
              {r3003?.section ? <>, section {r3003.section}</> : null}
            </span>
          }
        />
      ) : null}
      <p>
        Table E.2-1 gives the Integrated Medical Model’s likelihood, per mission, of each of <Num value={rows.length} /> medical conditions
        {table.cited_by && table.cited_by.length > 1 ? (
          <>
            {' '}
            (the rationales of{' '}
            {table.cited_by.map((id, i) => (
              <span key={id}>
                {i ? ' and ' : ''}
                <ReqId id={id} />
              </span>
            ))}{' '}
            both point to it)
          </>
        ) : null}
        . LANDFALL puts each condition in one category, by what it does with it, and weights the categories by NASA’s likelihoods.
      </p>

      <CoverageFigure summary={summary} />

      {noRow.length ? (
        <p className="lf-m-small">
          <Num value={noRow.length} /> of the <Num value={CASE_DEFS.length} /> cases have no row in this sample:{' '}
          {noRow.map((t, i) => (
            <span key={t}>
              {i ? ' and ' : ''}“{t}”
            </span>
          ))}
          . They rest on other NASA and NOAA sources, listed on <Link to="/provenance">Provenance</Link>.
        </p>
      ) : null}

      <WatchedBlock watched={watched} status={watchedStatus} />

      <div className="lf-m-aside">
        <h3 className="lf-m-h4">Asked is not detected</h3>
        <p>
          An asked row means the daily Noon Sight check asks the crewmember about a symptom and records the answer. A yes to a renal red
          flag, or to an urgent symptom, tells the crewmember to call the Crew Medical Officer now. Nothing is detected or diagnosed: the
          asked shares count questions, not findings.
        </p>
        {noDiagnosis ? (
          <p>
            <RichText text={noDiagnosis} /> <span className="lf-m-small">(refusal written into meta.json)</span>
          </p>
        ) : null}
      </div>

      <div className="lf-m-aside">
        <h3 className="lf-m-h4">Sample, ISS-derived output: never read it as per-Mars-mission</h3>
        {appx?.e_2_3_limitation ? (
          <Verbatim
            text={appx.e_2_3_limitation.text}
            cite={
              <span>
                {DOC}, section {appx.e_2_3_limitation.section}, PDF page <span className="lf-mono">{appx.e_2_3_limitation.pdf_page_number}</span>
              </span>
            }
          />
        ) : (
          <MissingNote>The E.2.3 limitation is not in this snapshot.</MissingNote>
        )}
        {appx?.e_2_2_inputs ? (
          <Verbatim
            text={appx.e_2_2_inputs.text}
            cite={
              <span>
                {DOC}, section {appx.e_2_2_inputs.section}, PDF page <span className="lf-mono">{appx.e_2_2_inputs.pdf_page_number}</span>
              </span>
            }
          />
        ) : null}
        <p>
          Table E.2-1 prints a rank and the columns{' '}
          {table.header_verbatim.map((h, i) => (
            <span key={h}>
              {i ? ' and ' : ''}“{h}”
            </span>
          ))}
          , and none of those inputs for its sample. LANDFALL uses the likelihoods only as weights for this score: never as the expected
          events of its Mars scenario, and never as a rate for any crewmember.
        </p>
      </div>

      {appx ? <E22Block appx={appx} rows={rows} ctx={ctx} /> : null}

      <Expander summary={`All ${rows.length} conditions of Table E.2-1, with LANDFALL’s category`}>
        <ImmRowsTable rows={rows} ctx={ctx} />
      </Expander>
    </>
  )
}

// ---- the figure: a tall segmented bar (one whole, four ordered parts), its legend and its table ------------

function blockLabel(c: CategoryTotal, total: number): string {
  return `${CATEGORY_DEFS[c.category].label}: ${c.count} ${c.count === 1 ? 'condition' : 'conditions'}, likelihood ${fmtNum(c.sum, 3)} of ${fmtNum(total, 3)} per mission, ${fmtShare(c.share)}`
}

function CoverageFigure({ summary }: { summary: CoverageSummary }) {
  const [active, setActive] = useState<CoverageCategory | null>(null)
  const parts = summary.ordered.filter((c) => c.sum > 0)
  return (
    <figure className="lf-cov-figure">
      <figcaption className="lf-cov-cap">
        Each condition weighted by its likelihood per mission (the <Num value={summary.rows} /> likelihoods add up to{' '}
        <Num value={summary.total} />
        ), split by what LANDFALL does with it.{' '}
        <span className="lf-cov-chips">
          <span>
            Likelihoods <Chip kind="NASA-published" />
          </span>
          <span>
            categories <Chip kind="design choice" />
          </span>
          <span>
            shares <Chip kind="derived" />
          </span>
        </span>
      </figcaption>
      <div className="lf-cov-bar" role="group" aria-label="Shares of the summed likelihood, by what LANDFALL does">
        {parts.map((c) => (
          <span
            key={c.category}
            className="lf-cov-block"
            data-cat={c.category}
            data-active={active === c.category || undefined}
            style={{ flexGrow: c.sum }}
            role="img"
            tabIndex={0}
            aria-label={blockLabel(c, summary.total)}
            title={blockLabel(c, summary.total)}
            onMouseEnter={() => setActive(c.category)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(c.category)}
            onBlur={() => setActive(null)}
          >
            <span className="lf-cov-share" data-len={fmtShare(c.share).length} aria-hidden="true">
              {fmtShare(c.share)}
            </span>
          </span>
        ))}
      </div>
      <ul className="lf-cov-legend">
        {CATEGORY_ORDER.map((cat) => (
          <li key={cat} data-active={active === cat || undefined}>
            <span className="lf-cov-swatch" data-cat={cat} aria-hidden="true" />
            <span>
              <strong>{CATEGORY_DEFS[cat].label}.</strong> {CATEGORY_DEFS[cat].definition}
            </span>
          </li>
        ))}
      </ul>
      <div className="lf-m-tablewrap">
        <table className="lf-m-table lf-m-stack lf-m-stack-rate lf-m-stack-crit lf-cov-sum">
          <caption className="sr-only">The shares of the bar, as a table</caption>
          <thead>
            <tr>
              <th scope="col">What LANDFALL does</th>
              <th scope="col" className="num">
                Conditions
              </th>
              <th scope="col" className="num">
                Likelihood, summed
              </th>
              <th scope="col" className="num">
                Share
              </th>
              <th scope="col">Which</th>
            </tr>
          </thead>
          <tbody>
            {summary.ordered.map((c) => (
              <tr key={c.category} data-cat={c.category} data-active={active === c.category || undefined}>
                <th scope="row">
                  <span className="lf-cov-swatch" data-cat={c.category} aria-hidden="true" />
                  {CATEGORY_DEFS[c.category].label}
                </th>
                <td className="num" data-label="Conditions">
                  <Num value={c.count} />
                </td>
                <td className="num" data-label="Summed">
                  <Num value={c.sum} />
                </td>
                <td className="num" data-label="Share">
                  <span className="lf-mono" data-share={c.category}>
                    {fmtShare(c.share)}
                  </span>
                </td>
                <td className="lf-m-stack-wide lf-cov-which">
                  {c.category === 'not_measurable' ? <>The other {c.count}, each listed below with where it is known from instead.</> : c.conditions.join(', ')}
                </td>
              </tr>
            ))}
            <tr className="lf-cov-total">
              <th scope="row">All conditions of the sample</th>
              <td className="num" data-label="Conditions">
                <Num value={summary.rows} />
              </td>
              <td className="num" data-label="Summed">
                <Num value={summary.total} />
              </td>
              <td className="num" data-label="Share">
                <span className="lf-mono">{fmtShare(1)}</span>
              </td>
              <td className="lf-m-stack-wide" />
            </tr>
          </tbody>
        </table>
      </div>
    </figure>
  )
}

// ---- what LANDFALL does with one condition ---------------------------------------------------------------

/** "Sleep duration (actigraphy)" -> "sleep duration (actigraphy)"; "PVT-B lapses" keeps its capitals. */
function midSentence(label: string): string {
  return /^[A-Z0-9-]{2,}\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)
}

function listWords(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** The labels of a case's Tier B triggers, from cases.json and personal.json. */
function caseWatches(caseId: string, personal: PersonalFile): string[] {
  const def = CASE_DEFS.find((c) => c.id === caseId)
  const ids = (def?.triggers ?? []).filter((t) => t.kind === 'personal').map((t) => t.indicator_id)
  return ids.map((id) => midSentence(personal.indicators.find((i) => i.id === id)?.label ?? String(id)))
}

function RuleNote({ ruleId, thresholds }: { ruleId: string; thresholds: ThresholdsFile }) {
  const rule = thresholds.rules.find((r) => r.id === ruleId)
  if (!rule) return null
  return (
    <>
      {' '}
      The exposure behind it is a Tier A rule: {rule.label}
      {rule.source.requirement_id ? (
        <>
          {' '}
          (<ReqId id={rule.source.requirement_id} />)
        </>
      ) : null}
      .
    </>
  )
}

function Asked({ entry }: { entry: CoverageEntry }) {
  const labels = symptomLabels(entry.symptoms)
  return (
    <>
      {labels.map((l, i) => (
        <span key={l}>
          {i ? ', ' : ''}“{l}”
        </span>
      ))}
    </>
  )
}

function Detail({ entry, ctx }: { entry: CoverageEntry; ctx: Ctx }) {
  if (entry.category === 'case') {
    const def = CASE_DEFS.find((c) => c.id === entry.caseId)
    const watches = entry.caseId ? caseWatches(entry.caseId, ctx.personal) : []
    return (
      <>
        The {(entry.caseId && CASE_SHORT[entry.caseId]) ?? entry.caseId} case (“{def?.title ?? entry.caseId}”) tests {listWords(watches)}{' '}
        against the crewmember’s own band (watched is not detected).
        {entry.note ? (
          <>
            {' '}
            <RichText text={entry.note} />
          </>
        ) : null}
        {entry.symptoms?.length ? (
          <>
            {' '}
            Also asked daily: <Asked entry={entry} />.
          </>
        ) : null}
      </>
    )
  }
  if (entry.category === 'not_measurable') {
    return (
      <>
        Known from: <strong>{entry.via}</strong>
        {entry.via ? <> ({VIA_DEFS[entry.via]})</> : null}.
        {entry.note ? (
          <>
            {' '}
            <RichText text={entry.note} />
          </>
        ) : null}
      </>
    )
  }
  const asked = entry.symptoms ?? []
  const redFlags = asked.filter(isRenalRedFlag).length
  return (
    <>
      {asked.length > 1 ? 'Daily questions' : 'Daily question'}: <Asked entry={entry} />.
      {redFlags === 0
        ? null
        : asked.length === 1
          ? ' Also a red-flag question of the renal case.'
          : redFlags === asked.length
            ? ' Also red-flag questions of the renal case.'
            : redFlags === 1
              ? ' One of them is also a red-flag question of the renal case.'
              : ' Some of them are also red-flag questions of the renal case.'}
      {entry.ruleId ? <RuleNote ruleId={entry.ruleId} thresholds={ctx.thresholds} /> : null}
      {entry.note ? (
        <>
          {' '}
          <RichText text={entry.note} />
        </>
      ) : null}
    </>
  )
}

function CategoryTag({ category }: { category: CoverageCategory }) {
  return (
    <span className="lf-cov-tag">
      <span className="lf-cov-swatch" data-cat={category} aria-hidden="true" />
      {CATEGORY_DEFS[category].label}
      <span className="sr-only">.</span>
    </span>
  )
}

/** The likelihood as printed ("4.37 per mission"); on a phone the words go under the number. */
function LikelihoodText({ text }: { text: string }) {
  const at = text.indexOf(' ')
  if (at < 0) return <span className="lf-mono">{text}</span>
  return (
    <span className="lf-mono">
      {text.slice(0, at)}
      <span className="lf-cov-per">{text.slice(at)}</span>
    </span>
  )
}

function ImmRowsTable({ rows, ctx }: { rows: CoverageRow[]; ctx: Ctx }) {
  return (
    <div className="lf-m-tablewrap">
      <table className="lf-m-table lf-m-stack lf-cov-rows">
        <caption className="lf-m-small lf-cov-tcap">
          Table E.2-1 as printed: rank, condition and likelihood verbatim, with the PDF page. The category, and where a condition is known
          from instead (CMO exam, crew report, medical kit), are LANDFALL’s design choice, not NASA’s.
        </caption>
        <thead>
          <tr>
            <th scope="col">Medical Condition</th>
            <th scope="col" className="num">
              Likelihood
            </th>
            <th scope="col" className="num">
              PDF page
            </th>
            <th scope="col">LANDFALL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rank} data-cat={r.entry?.category}>
              <th scope="row">
                <span className="lf-mono lf-cov-rank">{r.rank}</span> {r.condition}
              </th>
              <td className="num">
                <LikelihoodText text={r.likelihood.text} />
              </td>
              <td className="num">
                <span className="lf-mono">p. {r.pdf_page_number}</span>
              </td>
              <td className="lf-m-stack-wide">
                {r.entry ? (
                  <>
                    <CategoryTag category={r.entry.category} /> <Detail entry={r.entry} ctx={ctx} />
                  </>
                ) : (
                  <span className="lf-m-note-inline" data-tone="missing">
                    not mapped
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- Table E.2-2: its asterisk footnote and the rows this build froze ---------------------------------------

function E22Block({ appx, rows, ctx }: { appx: AppendixE; rows: CoverageRow[]; ctx: Ctx }) {
  const t = appx.table_e_2_2
  const byName = new Map(rows.map((r) => [r.condition, r]))
  const starred = t.rows.filter((r) => r.asterisk)
  const nephro = t.rows.find((r) => r.condition === 'Nephrolithiasis' && !r.asterisk)
  const hrr = hrrOfRenalRedFlags()
  return (
    <div className="lf-m-aside">
      <h3 className="lf-m-h4">Table E.2-2: what every mission should address</h3>
      {t.footnote ? (
        <Verbatim
          text={t.footnote.text}
          cite={
            <span>
              {DOC}, Table E.2-2 footnote, PDF page <span className="lf-mono">{t.footnote.pdf_page_number}</span>
            </span>
          }
        />
      ) : (
        <MissingNote>The Table E.2-2 footnote is not in this snapshot.</MissingNote>
      )}
      {starred.length ? (
        <div className="lf-m-tablewrap">
          <table className="lf-m-table lf-m-stack lf-cov-e22">
            <caption className="lf-m-small lf-cov-tcap">
              <Num value={starred.length} /> asterisked rows of Table E.2-2, verbatim, with LANDFALL’s status: the category of the matching
              Table E.2-1 rows.
            </caption>
            <thead>
              <tr>
                <th scope="col">Table E.2-2 row</th>
                <th scope="col" className="num">
                  PDF page
                </th>
                <th scope="col">LANDFALL</th>
              </tr>
            </thead>
            <tbody>
              {starred.map((r) => {
                const imm = (E22_TO_IMM[r.condition] ?? []).map((n) => byName.get(n)).filter((x): x is CoverageRow => !!x)
                // One status per category: the matching Table E.2-1 rows may sit in different ones (Late Insomnia is watched by
                // the sleep case, Insomnia (SAS) only asked).
                const groups = CATEGORY_ORDER.map((cat) => imm.filter((x) => x.entry?.category === cat)).filter((g) => g.length > 0)
                return (
                  <tr key={r.condition}>
                    <th scope="row">{r.text_verbatim}</th>
                    <td className="num">
                      <span className="lf-mono">p. {r.pdf_page_number}</span>
                    </td>
                    <td className="lf-m-stack-wide">
                      {groups.length
                        ? groups.map((g) => (
                            <div key={g[0].condition} className="lf-cov-group">
                              <CategoryTag category={g[0].entry!.category} /> <Detail entry={g[0].entry!} ctx={ctx} />{' '}
                              <span className="lf-m-small">(Table E.2-1: {g.map((x) => x.condition).join(', ')})</span>
                            </div>
                          ))
                        : 'No Table E.2-1 row matches it.'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {nephro ? (
        <p className="lf-cov-nephro">
          ‘{nephro.text_verbatim}’ carries no asterisk; the renal case’s basis is{' '}
          {hrr ? (
            <a href={hrr.url} target="_blank" rel="noopener noreferrer" className="lf-ext">
              {hrr.id}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            'the Human Research Roadmap'
          )}
          , not the IMM table.
        </p>
      ) : null}
      <p className="lf-m-small">
        Scope: this build froze only these <Num value={t.rows.length} /> rows of the table
        {t.pdf_page_number && t.footnote ? (
          <>
            {' '}
            (PDF pages <span className="lf-mono">{t.pdf_page_number}–{t.footnote.pdf_page_number}</span>)
          </>
        ) : null}
        , with its note and its footnote, so this is not a count of every asterisked row LANDFALL touches.
        {t.intro_note ? (
          <>
            {' '}
            The table’s note (PDF page <span className="lf-mono">{t.intro_note.pdf_page_number}</span>): “{t.intro_note.text}”
          </>
        ) : null}
      </p>
    </div>
  )
}
