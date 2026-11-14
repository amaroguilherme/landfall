// The region panel: answers the challenge statement's own questions for one body region, in
// plain language for a non-physician CMO ([V2 7045]):
//   what it does and how spaceflight affects it (NASA HRP, verbatim) ·
//   which measurements can be performed in space, and how · which NASA limits apply ·
//   real reference data (Inspiration4) · when it escalates (case tripwire, two tiers).
// The header separates three things that must never be confused (meta.json body_region_rule):
// the organ's state (its own measured findings), the hazard footprint of open cases (not a
// measurement) and the whole-body fitness tag (VO2max, not an organ finding).
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import type { CaseView } from '../../app/caseTimeline'
import { useSnapshot } from '../../app/data'
import type { SnapshotState } from '../../app/data'
import type { Finding, PersonalFinding } from '../../app/engine'
import { partialRecord } from '../../app/evaluate'
import { Link } from '../../app/location'
import { BASELINE_FIRST_DAY, BASELINE_LAST_DAY, environment } from '../../app/scenario'
import { CATEGORIES, SEVERITY_RANK } from '../../app/vocab'
import type { Category, EnvId, Severity } from '../../app/vocab'
import {
  ButtonLink,
  CategoryBadge,
  Chip,
  Citation,
  EmptyState,
  Expander,
  FindingBadge,
  FreshnessChip,
  MetTime,
  Num,
  ReqId,
  SeverityBadge,
  SimulatedMarker,
  StatusBadge,
  UnavailableIcon,
} from '../../ui'
import { SmallMultiples, SmallMultiplesLegend, bandKindOf } from './RefChart'
import type { OsdrData } from './RefChart'
import { HAZARD_SNAPSHOT_ID, HOW_LABEL, MEASURED_HERE, opWords, sentencesMatching, windowWords } from './regions'
import type { HazardId, Measure, RegionDef } from './regions'
import { ESCALATION_META, HAZARDS_META, indicatorById, packetStateLabel, ruleById } from './rules'
import type { CaseDef } from './rules'
import { FOOTPRINT_STATUSES, STATE_LABEL, actionSentence } from './status'
import type { FitnessTag, FootprintCase, IndicatorRow, RegionState, RegionSummary, RuleRow } from './status'

// ---- HRP snapshot shapes (web/public/data/hrp_*.json) -------------------------------------------

interface HrpRisk {
  name: string
  summary: string
  url: string
  slug: string
  detail?: {
    page_title?: string
    canonical_url?: string
    top_risks_sentences?: string[]
    what_can_be_done_sentences?: string[]
  }
}
interface HrpHazard {
  id: string
  name: string
  url: string
  page?: { title?: string; lede?: string; key_sentences?: Array<{ anchor: string; sentence: string }> }
}

// ---- small helpers -------------------------------------------------------------------------------

/** Render digits in DM Mono inside running text (every number is DM Mono, even inside quotes). */
export function MonoDigits({ text }: { text: string }) {
  const parts = text.split(/(\d[\d.,]*(?:\s?%)?)/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="lf-mono">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

function CategoryTag({ category }: { category: string }) {
  if ((CATEGORIES as readonly string[]).includes(category)) return <CategoryBadge category={category as Category} long />
  // TARGET: a literature countermeasure target, not a NASA limit (meta.json categories).
  return (
    <span className="lf-cat" data-category={category} title="Case target from the literature: not a NASA limit">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="lf-icon">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="8" cy="8" r="2.4" fill="currentColor" />
      </svg>
      <span className="lf-cat-code">{category}</span>
      <span className="lf-cat-word">literature target</span>
      <span className="sr-only">, a countermeasure target from the literature, not a NASA limit</span>
    </span>
  )
}

export function RegionStateBadge({ state, size = 'md' }: { state: RegionState; size?: 'sm' | 'md' }) {
  if (state === 'no_data') return <StatusBadge status="insufficient_data" />
  if (state === 'unmonitored') {
    return (
      <span className="lf-dq" data-tone="unavailable" title="LANDFALL has no rule or indicator for this region: observed and cited only">
        <UnavailableIcon size={14} />
        <span>{STATE_LABEL.unmonitored}</span>
      </span>
    )
  }
  return <SeverityBadge severity={state} size={size} />
}

/**
 * Badge of a Tier B (personal) finding. A personal band is not a limit, so "within" reads
 * "No reliable change", never "Within limit"; data-quality states stay cyan.
 */
export function PersonalBadge({ finding }: { finding: Pick<PersonalFinding, 'status' | 'severity' | 'category'> }) {
  if (finding.status === 'reliable_change') return <SeverityBadge severity={finding.severity} label="Reliable change" />
  if (finding.status === 'within') return <SeverityBadge severity="nominal" label="No reliable change" />
  return <FindingBadge finding={finding} />
}

/** Digits for a change of this size (the minimum detectable change of a band). */
function changeDigits(x: number): number {
  const a = Math.abs(x)
  return a >= 100 ? 0 : a >= 10 ? 1 : 2
}

function SourceFoot({ state, id }: { state: SnapshotState<unknown>; id: string }) {
  return (
    <p className="lf-body-src">
      <FreshnessChip meta={state.snapshot} status={state.status} id={id} source={state.snapshot?.source} />
      {state.snapshot?.source.url ? (
        <a href={state.snapshot.source.url} target="_blank" rel="noopener noreferrer">
          {state.snapshot.source.name}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </p>
  )
}

function Section({ id, title, kicker, children }: { id: string; title: ReactNode; kicker: string; children: ReactNode }) {
  return (
    <section className="lf-body-sec" aria-labelledby={`${id}-h`}>
      <p className="lf-eyebrow">{kicker}</p>
      <h3 id={`${id}-h`}>{title}</h3>
      {children}
    </section>
  )
}

// ---- the fitness tag (whole body, never an organ) ----------------------------------------------------

/** The whole-body fitness tag next to the figure: VO2max against the EVA floor that applies here. */
export function FitnessTagCard({ tag, crewLabel, envLabel }: { tag: FitnessTag; crewLabel: string; envLabel: string }) {
  const req = (tag.rule.source as { requirement_id?: unknown } | undefined)?.requirement_id
  return (
    <section className="lf-fit" data-state={tag.state} aria-label={`Fitness tag for ${crewLabel}`}>
      <p className="lf-fit-k">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="lf-icon">
          <path d="M2 9h2.5l1.6-4 3 7 1.8-4.5H14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        Fitness tag · whole body, not an organ
      </p>
      <p className="lf-fit-v">
        {tag.state === 'not_cleared' ? (
          <SeverityBadge severity={tag.finding.severity} label={tag.label} />
        ) : tag.state === 'no_data' ? (
          <StatusBadge status="insufficient_data" />
        ) : (
          <SeverityBadge severity="nominal" label={tag.label} />
        )}
      </p>
      <p className="lf-fit-t">
        VO₂max {tag.input.value !== null ? <Num value={tag.input.value} unit={tag.input.unit} /> : 'not on record'}, floor for {envLabel}{' '}
        {OP_SHORT[tag.rule.op] ?? opWords(tag.rule.op)} <Num value={tag.rule.limit} unit={tag.rule.unit} />
        {typeof req === 'string' ? (
          <>
            {' '}
            <ReqId id={req} />
          </>
        ) : null}
        . On the heart, lungs and muscles panels; it never colours an organ.
      </p>
    </section>
  )
}

const OP_SHORT: Record<string, string> = { ge: '≥', gt: '>', le: '≤', lt: '<' }

// ---- 1. what it does / how hazards affect it -----------------------------------------------------

function HazardTags({ hazards, data }: { hazards: HazardId[]; data: HrpHazard[] | null }) {
  return (
    <ul className="lf-hz-tags" aria-label="HRP hazard tags">
      {hazards.map((h) => {
        const snap = data?.find((x) => x.id === HAZARD_SNAPSHOT_ID[h])
        const label = HAZARDS_META?.find((m) => m.id === h)?.label ?? snap?.name ?? h
        return (
          <li key={h}>
            {snap?.url ? (
              <a href={snap.url} target="_blank" rel="noopener noreferrer" className="lf-hz-tag" data-hazard={h}>
                {label}
                <span className="sr-only"> (NASA HRP hazard page, opens in a new tab)</span>
              </a>
            ) : (
              <span className="lf-hz-tag" data-hazard={h}>
                {label}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Quote({ text, href, source }: { text: string; href: string; source: string }) {
  return (
    <blockquote className="lf-quote" cite={href}>
      <p>
        “<MonoDigits text={text} />”
      </p>
      <footer>
        NASA HRP,{' '}
        <a href={href} target="_blank" rel="noopener noreferrer">
          {source}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </footer>
    </blockquote>
  )
}

function HowItIsAffected({ region }: { region: RegionDef }) {
  const risks = useSnapshot<{ risks: HrpRisk[] }>('hrp_risks')
  const hazards = useSnapshot<{ hazards: HrpHazard[] }>('hrp_hazards')
  const riskList = risks.data?.risks ?? null
  const hazardList = hazards.data?.hazards ?? null
  return (
    <Section id={`${region.id}-does`} kicker="1 · What it does, and how spaceflight affects it" title="What it does">
      <p className="lf-body-does">
        <MonoDigits text={region.does} />
      </p>
      <HazardTags hazards={region.hazards} data={hazardList} />
      <p className="lf-body-fine">
        Hazard tags are LANDFALL’s mapping <Chip kind="design choice" />: the HRP pages publish no organ-to-hazard table.
        The quotes below are NASA’s own words, verbatim.
      </p>
      {risks.status === 'loading' || hazards.status === 'loading' ? (
        <p className="lf-body-fine">Loading the NASA HRP pages from the local snapshot…</p>
      ) : null}
      {risks.status === 'missing' || risks.status === 'error' ? (
        <EmptyState kind="missing" title="NASA HRP risk pages not in this build" headingLevel={3}>
          <p>The verbatim quotes come from hrp_risks.json, which this build does not contain.</p>
        </EmptyState>
      ) : null}
      <div className="lf-quotes">
        {region.hazardQuotes.map((hq) => {
          const hz = hazardList?.find((x) => x.id === HAZARD_SNAPSHOT_ID[hq.hazard])
          if (!hz) return null
          const pool = [hz.page?.lede ?? '', ...(hz.page?.key_sentences ?? []).map((k) => k.sentence)].filter(Boolean)
          const hit = sentencesMatching(pool, [hq.anchor])[0]
          return hit ? <Quote key={`${hq.hazard}-${hq.anchor}`} text={hit} href={hz.url} source={hz.page?.title ?? hz.name} /> : null
        })}
        {region.risks.map((rp) => {
          const risk = riskList?.find((r) => r.slug === rp.slug)
          if (!risk) return null
          const href = risk.detail?.canonical_url ?? risk.url
          const pool = [risk.summary, ...(risk.detail?.top_risks_sentences ?? [])]
          const hits = sentencesMatching(pool, rp.anchors)
          const shown = hits.length ? hits : [risk.summary]
          const todo = risk.detail?.what_can_be_done_sentences ?? []
          return (
            <div key={rp.slug} className="lf-quote-group">
              {shown.map((s) => (
                <Quote key={s} text={s} href={href} source={risk.name} />
              ))}
              {todo.length ? (
                <Expander summary={`What NASA says can be done · ${risk.name}`}>
                  <ul className="lf-todo">
                    {todo.map((s) => (
                      <li key={s}>
                        “<MonoDigits text={s} />”
                      </li>
                    ))}
                  </ul>
                </Expander>
              ) : null}
            </div>
          )
        })}
      </div>
      <SourceFoot state={risks} id="hrp_risks" />
      <SourceFoot state={hazards} id="hrp_hazards" />
    </Section>
  )
}

// ---- 2. measurements ------------------------------------------------------------------------------

function MeasureRow({ m }: { m: Measure }) {
  const here = MEASURED_HERE.includes(m.how)
  return (
    <tr data-here={here || undefined} data-variable={m.variable ?? undefined}>
      <th scope="row">
        <span className="lf-ms-label">{m.label}</span>
      </th>
      <td>
        {here ? (
          <span className="lf-ms-badge" data-how={m.how}>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="lf-icon">
              <circle cx="8" cy="8" r="6" fill="currentColor" />
            </svg>
            {HOW_LABEL[m.how]}
          </span>
        ) : (
          <span className="lf-ms-badge" data-how="handoff">
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="lf-icon">
              <path d="M2 8h9M8 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            NOT MEASURABLE HERE
          </span>
        )}
      </td>
      <td>
        {!here ? <strong className="lf-ms-via">via {HOW_LABEL[m.how].toLowerCase()}: </strong> : null}
        <MonoDigits text={m.via} />
        {m.requirement_ids?.length ? (
          <span className="lf-ms-req">
            {' '}
            {m.requirement_ids.map((r) => (
              <ReqId key={r} id={r} />
            ))}
          </span>
        ) : null}
      </td>
    </tr>
  )
}

function Measurements({ region }: { region: RegionDef }) {
  const here = region.measures.filter((m) => MEASURED_HERE.includes(m.how)).length
  return (
    <Section id={`${region.id}-measure`} kicker="2 · Which measurements can be performed in space, and how" title="What can be measured here">
      <p className="lf-body-fine">
        <span className="lf-mono">{here}</span> of <span className="lf-mono">{region.measures.length}</span> measured or recorded by
        LANDFALL itself (band or app). The rest is the hand-off boundary: it reaches LANDFALL by manual entry, from a vehicle
        system, a laboratory or the ground, and is labelled <strong>NOT MEASURABLE HERE</strong>.
      </p>
      <div className="lf-table-wrap">
        <table className="lf-ms">
          <thead>
            <tr>
              <th scope="col">Indicator</th>
              <th scope="col">Measured by</th>
              <th scope="col">How it reaches LANDFALL</th>
            </tr>
          </thead>
          <tbody>
            {region.measures.map((m) => (
              <MeasureRow key={`${m.variable ?? m.label}`} m={m} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  )
}

// ---- 3. limits ----------------------------------------------------------------------------------

function tableRef(source: Record<string, unknown>): string {
  const table = typeof source.table === 'string' ? source.table : null
  if (!table) return ''
  const row = typeof source.row === 'string' ? source.row : ''
  const col = typeof source.column === 'string' ? source.column.replace('_', '-') : ''
  return `, ${table}${row ? ` (${row}${col ? `, ${col}` : ''})` : ''}`
}

function viaFor(region: RegionDef, variable: string): string | null {
  // Exact variable first; dose_cns_z10 falls back to the dose_cns hand-off (same monitoring route).
  const exact = region.measures.find((m) => m.variable === variable)
  const prefix = region.measures.find((m) => m.variable !== null && variable.startsWith(`${m.variable}_`))
  return (exact ?? prefix)?.via ?? null
}

function RuleItem({ row, region }: { row: RuleRow; region: RegionDef }) {
  const { rule, finding, input } = row
  const note = region.ruleNotes?.[rule.variable]
  const approach = rule.approach_at
  const src = rule.source as unknown as Record<string, unknown>
  const unitMismatch = input.value === null && input.unit_mismatch > 0
  const flagged = row.applicable && SEVERITY_RANK[finding.severity as Severity] >= SEVERITY_RANK.caution && !['insufficient_data', 'stale'].includes(finding.status)
  return (
    <li className="lf-limit" data-applicable={row.applicable || undefined} data-fitness={row.fitness || undefined}>
      <div className="lf-limit-head">
        <CategoryTag category={rule.category} />
        <span className="lf-limit-label">{rule.label}</span>
        <span className="lf-limit-status">{row.applicable ? <FindingBadge finding={finding} partial={partialRecord(row)} /> : <StatusBadge status="not_applicable" />}</span>
      </div>
      {row.fitness ? (
        <p className="lf-limit-fit">
          <strong>Fitness tag</strong>, whole body: this test sets the crewmember’s EVA assignment, not the state of this organ, so
          it never colours the figure.
        </p>
      ) : null}
      <p className="lf-limit-rule">
        Must stay {opWords(rule.op)} <Num value={rule.limit} unit={rule.unit} /> <span className="lf-limit-win">· {windowWords(rule.window)}</span>{' '}
        <Chip kind={rule.chip} />
      </p>
      {approach ? (
        <p className="lf-limit-sub">
          “Approaching” from <Num value={approach.value} unit={rule.unit} /> <Chip kind={approach.chip} />
        </p>
      ) : null}
      <p className="lf-limit-src">
        <Citation source={rule.source}>{tableRef(src)}</Citation>
      </p>
      {row.applicable ? (
        <p className="lf-limit-now">
          {input.value !== null ? (
            <>
              Latest <Num value={input.value} unit={input.unit} />
              {input.t !== null ? (
                <>
                  {' '}
                  at <MetTime t={input.t} label />
                </>
              ) : null}{' '}
              · {input.basis}
            </>
          ) : unitMismatch ? (
            <span className="lf-nodata">Unit mismatch: not compared (units are never converted silently).</span>
          ) : (
            <span className="lf-nodata">
              No reading in this scenario{viaFor(region, rule.variable) ? `: it comes from the ${viaFor(region, rule.variable)}` : ''}.
            </span>
          )}
        </p>
      ) : (
        <p className="lf-limit-now lf-limit-na">
          Applies to {rule.applies_to.map((e) => environment(e as EnvId)?.label ?? e).join(', ')}.
        </p>
      )}
      {flagged && rule.action ? (
        <p className="lf-limit-action">
          <strong>{rule.action.label}.</strong> <MonoDigits text={actionSentence(rule.action)} />{' '}
          <Chip kind={rule.action.chip} />
        </p>
      ) : null}
      {note ? <p className="lf-limit-note">{note}</p> : null}
      {finding.why ? (
        <Expander summary="How the engine read it">
          <p className="lf-body-fine">
            <MonoDigits text={finding.why} />
          </p>
          <p className="lf-body-fine">
            <a href={`#/provenance?id=${encodeURIComponent(rule.id)}`}>Provenance of this limit</a>
          </p>
        </Expander>
      ) : null}
    </li>
  )
}

/** The Noon Sight step where a manual indicator is typed in, or null. */
function entryStep(variable: string): string | null {
  if (variable === 'bp_systolic' || variable === 'bp_diastolic' || variable === 'glucose') return 'kit'
  if (variable === 'urine_volume_24h' || variable === 'fluid_intake_24h') return 'fluids'
  return null
}

function IndicatorItem({ row }: { row: IndicatorRow }) {
  const ind = row.indicator
  const f = row.finding
  const mdc = f.rci?.mdc ?? null
  const flagged = f.status === 'reliable_change' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.caution
  const direction = ind.worse === 'increase' ? 'upward' : ind.worse === 'decrease' ? 'downward' : 'in either direction'
  const cur = row.current
  return (
    <li className="lf-limit" data-applicable>
      <div className="lf-limit-head">
        <CategoryBadge category="PERSONAL" long />
        <span className="lf-limit-label">{ind.label}</span>
        <span className="lf-limit-status">
          <PersonalBadge finding={f} />
        </span>
      </div>
      <p className="lf-limit-rule">
        Flags a reliable change {direction} against your own baseline (MET days <span className="lf-mono">{BASELINE_FIRST_DAY}</span>–
        <span className="lf-mono">{BASELINE_LAST_DAY}</span>, <Num value={row.baselineN} /> readings): a change bigger than your own
        day-to-day noise. Not a limit. <Link to="/method?s=tiers">How the test works</Link>
      </p>
      {mdc !== null ? (
        <p className="lf-limit-sub">
          Smallest change it can flag: <Num value={mdc} unit={ind.unit} digits={changeDigits(mdc)} /> from your baseline mean{' '}
          <Chip kind="derived" />. A real change smaller than that is never flagged.
        </p>
      ) : null}
      <p className="lf-limit-now">
        {cur ? (
          <>
            Latest <Num value={cur.value} unit={cur.unit} /> at <MetTime t={cur.t} label /> ·{' '}
            {cur.provenance === 'simulated' ? `${cur.source}, simulated` : cur.source === 'manual' ? 'entered by the crewmember' : cur.source}
          </>
        ) : (
          <span className="lf-nodata">No reading after the baseline yet.</span>
        )}
        {ind.alerting === false ? <span className="lf-limit-win"> · context only: shown, never an alert</span> : null}
        {entryStep(ind.variable) ? (
          <>
            {' '}
            · <a href={`#/noon-sight?step=${entryStep(ind.variable)}`}>Enter a reading in Noon Sight</a>
          </>
        ) : null}
      </p>
      {flagged && ind.action ? (
        <p className="lf-limit-action">
          <strong>{ind.action.label}.</strong> <MonoDigits text={ind.action.text} /> <Chip kind={ind.action.chip} />
        </p>
      ) : null}
      {ind.limit_note?.text ? <LimitNote text={ind.limit_note.text} chip={ind.limit_note.chip} /> : null}
      {ind.context?.text ? (
        <p className="lf-limit-ctx">
          <MonoDigits text={ind.context.text} /> <Chip kind={ind.context.chip} />
          {ind.context.source ? (
            <span className="lf-block">
              <Citation source={ind.context.source} />
            </span>
          ) : null}
        </p>
      ) : null}
      {f.why ? (
        <Expander summary="How the engine read it">
          <p className="lf-body-fine">
            <MonoDigits text={f.why} />
          </p>
          <p className="lf-body-fine">
            <a href={`#/provenance?id=${encodeURIComponent(ind.id)}`}>Provenance of this indicator</a> · <a href="#/trends">See the trend</a>
          </p>
        </Expander>
      ) : null}
    </li>
  )
}

/** First sentence of a note (up to the first ". "), and the rest. */
function splitFirst(text: string): [string, string] {
  const i = text.indexOf('. ')
  return i < 0 ? [text, ''] : [text.slice(0, i + 1), text.slice(i + 2)]
}

/** "No NASA numeric limit: ..." in one line, with how we know it in a disclosure. */
function LimitNote({ text, chip }: { text: string; chip?: string }) {
  const [head, rest] = splitFirst(text)
  return (
    <div className="lf-limit-note">
      <p>
        <MonoDigits text={head} /> <Chip kind={chip} />
      </p>
      {rest ? (
        <Expander summary="How we know">
          <p className="lf-body-fine">
            <MonoDigits text={rest} />
          </p>
        </Expander>
      ) : null}
    </div>
  )
}

function Limits({
  region,
  ruleRows,
  indicatorRows,
  rulesMissing,
  envId,
}: {
  region: RegionDef
  ruleRows: RuleRow[]
  indicatorRows: IndicatorRow[]
  rulesMissing: boolean
  envId: EnvId
}) {
  const here = ruleRows.filter((r) => r.applicable)
  const elsewhere = ruleRows.filter((r) => !r.applicable)
  return (
    <Section id={`${region.id}-limits`} kicker="3 · When might a result need attention" title="Limits that apply">
      <p className="lf-body-fine">
        NASA publishes three different kinds of limit and LANDFALL never merges them: <CategoryBadge category="FFD" long />{' '}
        <CategoryBadge category="PEL" long /> <CategoryBadge category="POL" long />. Read from <code>engine/rules/thresholds.json</code>;
        status from the engine for <strong>{environment(envId).label}</strong>.
      </p>
      {rulesMissing ? (
        <EmptyState kind="loading" title="Rules loading from engine" headingLevel={3}>
          <p>engine/rules/thresholds.json is not in this build yet. No limit is shown rather than a number typed by hand.</p>
        </EmptyState>
      ) : here.length === 0 && elsewhere.length === 0 ? (
        <p className="lf-body-empty">
          None of the NASA-STD-3001 limits LANDFALL carries is about this part of the body. It is observed and cited here, not
          monitored against a NASA number.
        </p>
      ) : (
        <>
          {here.length ? (
            <ul className="lf-limits">
              {here.map((row) => (
                <RuleItem key={row.rule.id} row={row} region={region} />
              ))}
            </ul>
          ) : (
            <p className="lf-body-empty">None of this region’s limits applies in {environment(envId).label}.</p>
          )}
          {elsewhere.length ? (
            <Expander summary={`${elsewhere.length} more ${elsewhere.length === 1 ? 'limit applies' : 'limits apply'} in other environments`}>
              <ul className="lf-limits">
                {elsewhere.map((row) => (
                  <RuleItem key={row.rule.id} row={row} region={region} />
                ))}
              </ul>
            </Expander>
          ) : null}
        </>
      )}
      {indicatorRows.length ? (
        <>
          <h4 className="lf-body-h4">Change against your own baseline</h4>
          <ul className="lf-limits">
            {indicatorRows.map((row) => (
              <IndicatorItem key={row.indicator.id} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  )
}

// ---- 4. reference data -----------------------------------------------------------------------------

function OsdrBlock({ snapshotId, picks }: { snapshotId: 'osdr_cbc' | 'osdr_cmp' | 'osdr_cytokines'; picks: RegionDef['osdr'] }) {
  const snap = useSnapshot<OsdrData>(snapshotId)
  if (snap.status === 'loading') return <p className="lf-body-fine">Loading {snapshotId}…</p>
  if (snap.status !== 'ready' || !snap.data) {
    return (
      <EmptyState kind="missing" title={`${snapshotId}.json not in this build`} headingLevel={3}>
        <p>The Inspiration4 panel for this region could not be loaded.</p>
      </EmptyState>
    )
  }
  const data = snap.data
  return (
    <div className="lf-osdr">
      {picks.map((p) => {
        const a = data.analytes.find((x) => x.key === p.key)
        return a ? <SmallMultiples key={p.key} data={data} analyte={a} why={p.why} /> : null
      })}
      {(() => {
        const first = picks.map((p) => data.analytes.find((x) => x.key === p.key)).find(Boolean)
        return first ? <SmallMultiplesLegend kind={bandKindOf(first, data)} /> : null
      })()}
      <p className="lf-body-fine">
        <strong>{snap.snapshot?.title}</strong>
      </p>
      {snap.snapshot?.caveats?.length ? (
        <Expander summary={`Snapshot caveats (${snap.snapshot.caveats.length}, verbatim)`}>
          <ul className="lf-why">
            {snap.snapshot.caveats.map((c) => (
              <li key={c}>
                <MonoDigits text={c} />
              </li>
            ))}
          </ul>
        </Expander>
      ) : null}
      <SourceFoot state={snap as SnapshotState<unknown>} id={snapshotId} />
    </div>
  )
}

function ReferenceData({ region }: { region: RegionDef }) {
  const bySnap = new Map<OsdrBlockId, RegionDef['osdr']>()
  for (const p of region.osdr) bySnap.set(p.snapshot, [...(bySnap.get(p.snapshot) ?? []), p])
  return (
    <Section id={`${region.id}-ref`} kicker="4 · Real reference data from NASA" title="Inspiration4 crew blood panels">
      {region.osdr.length ? (
        <p className="lf-body-caveat">
          Real NASA Open Science Data Repository data from Inspiration4 (2021): <span className="lf-mono">n = 4</span> civilians,{' '}
          about <span className="lf-mono">3</span> days in low Earth orbit, and <strong>no in-flight samples</strong>. It shows
          real laboratory reference ranges and a real recovery shape. It is <strong>not</strong> a model of a long-duration
          mission, and these are not the simulated crew.
        </p>
      ) : null}
      {region.osdrNote ? (
        <p className="lf-body-empty">
          <MonoDigits text={region.osdrNote} />
        </p>
      ) : null}
      {[...bySnap.entries()].map(([id, picks]) => (
        <OsdrBlock key={id} snapshotId={id} picks={picks} />
      ))}
    </Section>
  )
}

type OsdrBlockId = 'osdr_cbc' | 'osdr_cmp' | 'osdr_cytokines'

// ---- 5. when it escalates ---------------------------------------------------------------------------

const CASE_STATUS_WORDS: Record<string, string> = {
  idle: 'Not open',
  detected: 'Open · detected',
  acting: 'Open · acting',
  watch: 'Open · watch (tripwire armed)',
  escalated: 'Escalated',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}

function EscalationTiers() {
  if (!ESCALATION_META) return null
  return (
    <ol className="lf-tiers">
      {ESCALATION_META.tiers.map((t) => (
        <li key={t.id}>
          <strong>
            Tier <span className="lf-mono">{t.tier}</span>, {t.label}
          </strong>
          : {t.when}.
        </li>
      ))}
    </ol>
  )
}

function CaseCard({ c, view }: { c: CaseDef; view: CaseView | null }) {
  const status = view?.state.status ?? 'idle'
  const open = FOOTPRINT_STATUSES.has(status)
  const opening = view?.opening ?? null
  const packet = open ? packetStateLabel(view?.state.packet_queued_at) : null
  return (
    <li className="lf-case" data-open={open || undefined}>
      <div className="lf-case-head">
        <p className="lf-eyebrow">LANDFALL case</p>
        <h4>
          <Link to={`/case/${c.id}`}>{c.title}</Link>
        </h4>
        <span className="lf-case-state" data-status={status}>
          {CASE_STATUS_WORDS[status] ?? status}
        </span>
      </div>
      <p>
        <MonoDigits text={c.one_line} />
      </p>
      {open && opening ? (
        <p className="lf-body-fine">
          Opened at <MetTime t={opening.t} label /> by {openingLabel(opening.trigger, opening.finding)} ({opening.finding.severity}).
        </p>
      ) : !open ? (
        <p className="lf-body-fine">Opens when any of its triggers reaches Caution. None has for this crewmember now.</p>
      ) : null}
      {packet ? (
        <p className="lf-body-fine">
          Ground packet: <strong>{packet}</strong>.
        </p>
      ) : null}
      {c.tripwire ? (
        <div className="lf-tripwire">
          <p className="lf-tripwire-k">
            Tripwire <Chip kind={c.tripwire.chip} />
          </p>
          <p className="lf-tripwire-t">
            <MonoDigits text={c.tripwire.text} />
          </p>
        </div>
      ) : null}
      <ButtonLink href={`#/case/${c.id}`} variant="secondary">
        Open the case
      </ButtonLink>
    </li>
  )
}

/** Plain-language label of the trigger that opened a case (the rule or indicator label, never its id). */
function openingLabel(trigger: { rule_id?: string; indicator_id?: string }, f: Finding): string {
  if (trigger.rule_id) return ruleById(trigger.rule_id)?.label ?? 'a published limit'
  if (trigger.indicator_id) {
    const label = indicatorById(trigger.indicator_id)?.label
    return label ? `${label}, a reliable change against the own baseline` : 'a reliable change against the own baseline'
  }
  return f.category === 'PERSONAL' ? 'a reliable change against the own baseline' : 'a published limit'
}

interface ActionItem {
  key: string
  label: string
  text: string
  chip: string | undefined
  severity: Severity
}

function GroundSection({
  region,
  cases,
  caseViews,
  ruleRows,
  indicatorRows,
  casesMissing,
}: {
  region: RegionDef
  cases: CaseDef[]
  caseViews: readonly CaseView[]
  ruleRows: RuleRow[]
  indicatorRows: IndicatorRow[]
  casesMissing: boolean
}) {
  // Findings without a deep case (D11): flagged rows that carry a one-line action. The fitness tag
  // has its own card next to the figure.
  const actions: ActionItem[] = []
  for (const r of ruleRows) {
    if (r.fitness || !r.applicable || !r.rule.action) continue
    if (SEVERITY_RANK[r.finding.severity as Severity] < SEVERITY_RANK.caution || ['insufficient_data', 'stale'].includes(r.finding.status)) continue
    actions.push({ key: r.rule.id, label: r.rule.action.label, text: r.rule.action.text, chip: r.rule.action.chip, severity: r.finding.severity as Severity })
  }
  for (const r of indicatorRows) {
    if (!r.indicator.action || r.finding.status !== 'reliable_change' || SEVERITY_RANK[r.finding.severity] < SEVERITY_RANK.caution) continue
    actions.push({ key: r.indicator.id, label: r.indicator.action.label, text: r.indicator.action.text, chip: r.indicator.action.chip, severity: r.finding.severity })
  }
  return (
    <Section id={`${region.id}-ground`} kicker="5 · When it needs the Crew Medical Officer or the flight surgeon" title="When it escalates">
      <p className="lf-body-fine">Escalation has two tiers, and how much the crew decides onboard scales with the link:</p>
      <EscalationTiers />
      {actions.length ? (
        <>
          <h4 className="lf-body-h4">Findings without a guided case</h4>
          <ul className="lf-actions">
            {actions.map((a) => (
              <li key={a.key}>
                <SeverityBadge severity={a.severity} label={a.label} />{' '}
                <span>
                  <MonoDigits text={a.text} /> <Chip kind={a.chip} />
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {casesMissing ? (
        <EmptyState kind="loading" title="Cases loading from engine" headingLevel={3}>
          <p>engine/rules/cases.json is not in this build yet.</p>
        </EmptyState>
      ) : cases.length === 0 ? (
        <p className="lf-body-empty">
          No LANDFALL case covers this part of the body, so there is no guided procedure or tripwire for it. A finding here carries
          a one-line action instead; for anything that worries you, tell the Crew Medical Officer, who uses the vehicle medical
          procedures, and the flight surgeon when the link allows.
        </p>
      ) : (
        <ul className="lf-cases">
          {cases.map((c) => (
            <CaseCard key={c.id} c={c} view={caseViews.find((v) => v.caseId === c.id) ?? null} />
          ))}
        </ul>
      )}
    </Section>
  )
}

// ---- the panel ----------------------------------------------------------------------------------------

export function RegionPanel({
  region,
  summary,
  ruleRows,
  indicatorRows,
  cases,
  caseViews,
  footprint,
  fitness,
  rulesMissing,
  casesMissing,
  evaluationReady,
  envId,
  crewLabel,
}: {
  region: RegionDef
  summary: RegionSummary
  ruleRows: RuleRow[]
  indicatorRows: IndicatorRow[]
  cases: CaseDef[]
  /** Case views of the selected crewmember. */
  caseViews: readonly CaseView[]
  footprint: FootprintCase[]
  fitness: FitnessTag | null
  rulesMissing: boolean
  casesMissing: boolean
  evaluationReady: boolean
  envId: EnvId
  crewLabel: string
}) {
  const hasFitnessRow = ruleRows.some((r) => r.fitness && r.applicable)
  return (
    <article className="lf-region" aria-labelledby="lf-region-h" data-state={summary.state}>
      <header className="lf-region-head">
        <p className="lf-eyebrow">Body region · {crewLabel}</p>
        <h2 id="lf-region-h" tabIndex={-1}>
          {region.label}
        </h2>
        {region.aka ? <p className="lf-region-aka">{region.aka}</p> : null}
        <div className="lf-region-status">
          <RegionStateBadge state={summary.state} />
          <span className="lf-region-count">
            {summary.total ? (
              <>
                <Num value={summary.evaluated} /> of <Num value={summary.total} /> measured findings evaluated
                {summary.missing ? (
                  <>
                    {' '}
                    · <Num value={summary.missing} /> with no data
                  </>
                ) : null}
              </>
            ) : (
              'No LANDFALL rule or indicator here'
            )}
          </span>
          <SimulatedMarker />
        </div>
        {summary.drivers.length ? (
          <ul className="lf-region-reasons" aria-label="Measured findings that set this state">
            {summary.drivers.map((d) => (
              <li key={d.label}>
                {d.label}: {d.status.replace(/_/g, ' ')} ({d.severity})
              </li>
            ))}
          </ul>
        ) : null}
        {footprint.length ? (
          <p className="lf-region-foot">
            <span className="lf-foot-swatch lf-foot-swatch-lg" aria-hidden="true" />
            <span>
              <strong>In the hazard footprint of {footprint.length === 1 ? 'an open case' : 'open cases'}:</strong>{' '}
              {footprint.map((c, i) => (
                <Fragment key={c.caseId}>
                  {i ? '; ' : ''}
                  <Link to={`/case/${c.caseId}`}>{c.title}</Link> ({(CASE_STATUS_WORDS[c.status] ?? c.status).toLowerCase()})
                </Fragment>
              ))}
              . The hazard can reach this part of the body; that is not a measurement of it, so it does not change the state above.
            </span>
          </p>
        ) : null}
        {hasFitnessRow && fitness ? (
          <p className="lf-region-fit">
            <strong>Fitness tag (whole body): {fitness.label}.</strong> {fitness.action ? <MonoDigits text={fitness.action} /> : null}{' '}
            The VO₂max test below sets EVA assignment; it does not colour this organ.
          </p>
        ) : null}
        {!evaluationReady ? (
          <p className="lf-body-fine lf-region-shim">The mission evaluation is not ready, so statuses read “insufficient data” instead of guessing.</p>
        ) : null}
      </header>
      <HowItIsAffected region={region} />
      <Measurements region={region} />
      <Limits region={region} ruleRows={ruleRows} indicatorRows={indicatorRows} rulesMissing={rulesMissing} envId={envId} />
      <ReferenceData region={region} />
      <GroundSection region={region} cases={cases} caseViews={caseViews} ruleRows={ruleRows} indicatorRows={indicatorRows} casesMissing={casesMissing} />
    </article>
  )
}
