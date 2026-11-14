// The region panel: answers the challenge statement's own questions for one body region, in
// plain language for a non-physician CMO ([V2 7045]):
//   what it does and how spaceflight affects it (NASA HRP, verbatim) ·
//   which measurements can be performed in space, and how · which NASA limits apply ·
//   real reference data (Inspiration4) · when it needs the ground (case tripwire).
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { useSnapshot } from '../../app/data'
import type { SnapshotState } from '../../app/data'
import { Link } from '../../app/location'
import { CATEGORIES } from '../../app/vocab'
import type { Category } from '../../app/vocab'
import { BASELINE_FIRST_DAY, BASELINE_LAST_DAY, environment } from '../../app/scenario'
import type { EnvId } from '../../app/vocab'
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
import { HAZARDS_META } from './rules'
import type { CaseDef } from './rules'
import type { CaseStatus, IndicatorRow, RegionState, RegionSummary, RuleRow } from './status'
import { STATE_LABEL } from './status'

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
    <tr data-here={here || undefined}>
      <th scope="row">
        <span className="lf-ms-label">{m.label}</span>
        {m.variable ? <code className="lf-ms-var">{m.variable}</code> : null}
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
        <span className="lf-mono">{here}</span> of <span className="lf-mono">{region.measures.length}</span> measured by LANDFALL itself (band
        or app). The rest is the hand-off boundary: it reaches LANDFALL by manual entry, from a vehicle system, a laboratory or
        the ground, and is labelled <strong>NOT MEASURABLE HERE</strong>.
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
  const { rule, finding, point } = row
  const note = region.ruleNotes?.[rule.variable]
  const approach = rule.approach_at
  const src = rule.source as unknown as Record<string, unknown>
  return (
    <li className="lf-limit" data-applicable={row.applicable || undefined}>
      <div className="lf-limit-head">
        <CategoryTag category={rule.category} />
        <span className="lf-limit-label">{rule.label}</span>
        <span className="lf-limit-status">{finding ? <FindingBadge finding={finding} /> : <StatusBadge status="not_applicable" />}</span>
      </div>
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
          {point && !row.unitMismatch ? (
            <>
              Latest <Num value={point.value} unit={point.unit} /> at <MetTime t={point.t} label /> · {point.source}
            </>
          ) : row.unitMismatch ? (
            <span className="lf-nodata">Unit mismatch: not compared (units are never converted silently).</span>
          ) : (
            <span className="lf-nodata">
              No reading in this scenario{viaFor(region, rule.variable) ? `: comes from the ${viaFor(region, rule.variable)}` : ''}.
            </span>
          )}
        </p>
      ) : (
        <p className="lf-limit-now lf-limit-na">
          Applies to {rule.applies_to.map((e) => environment(e as EnvId)?.label ?? e).join(', ')}.
        </p>
      )}
      {row.error ? <p className="lf-limit-now lf-nodata">The engine did not evaluate it ({row.error}), so it shows as no data.</p> : null}
      {note ? <p className="lf-limit-note">{note}</p> : null}
      {finding?.why?.length ? (
        <Expander summary="How the engine read it">
          <ul className="lf-why">
            {[finding.why].map((w) => (
              <li key={w}>
                <MonoDigits text={w} />
              </li>
            ))}
          </ul>
          <p className="lf-body-fine">
            <a href={`#/provenance?id=${encodeURIComponent(rule.id)}`}>Provenance of {rule.id}</a>
          </p>
        </Expander>
      ) : null}
    </li>
  )
}

function IndicatorItem({ row }: { row: IndicatorRow }) {
  const ind = row.indicator
  return (
    <li className="lf-limit" data-applicable>
      <div className="lf-limit-head">
        <CategoryBadge category="PERSONAL" long />
        <span className="lf-limit-label">{ind.label}</span>
        <span className="lf-limit-status">{row.finding ? <FindingBadge finding={row.finding} /> : <StatusBadge status="insufficient_data" />}</span>
      </div>
      <p className="lf-limit-rule">
        Flags a reliable change {ind.worse === 'increase' ? 'upward' : ind.worse === 'decrease' ? 'downward' : 'either way'} against
        your own baseline (MET days <span className="lf-mono">{BASELINE_FIRST_DAY}</span>–<span className="lf-mono">{BASELINE_LAST_DAY}</span>,{' '}
        <Num value={row.baselineN} /> readings): a change bigger than your own day-to-day noise. Not a limit.{' '}
        <Link to="/method">How the test works</Link>
      </p>
      <p className="lf-limit-now">
        {row.point ? (
          <>
            Latest <Num value={row.point.value} unit={row.point.unit} /> at <MetTime t={row.point.t} label /> · {row.point.source}
          </>
        ) : (
          <span className="lf-nodata">No reading in this scenario.</span>
        )}
        {row.error ? <span className="lf-nodata lf-block"> The engine did not evaluate it ({row.error}), so it shows as no data.</span> : null}
        {ind.alerting === false ? <span className="lf-limit-win"> · context only: shown, never an alert</span> : null}
      </p>
      {row.finding?.why ? (
        <Expander summary="How the engine read it">
          <p className="lf-body-fine">
            <MonoDigits text={row.finding.why} />
          </p>
          <p className="lf-body-fine">
            <a href={`#/provenance?id=${encodeURIComponent(ind.id)}`}>Provenance of {ind.id}</a>
          </p>
        </Expander>
      ) : null}
    </li>
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
          NASA publishes no limit for this region in the rules LANDFALL carries. It is observed and cited here, not monitored.
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

// ---- 5. when it needs the ground -------------------------------------------------------------------

function GroundSection({ region, cases, statuses, casesMissing }: { region: RegionDef; cases: CaseDef[]; statuses: Record<string, CaseStatus>; casesMissing: boolean }) {
  return (
    <Section id={`${region.id}-ground`} kicker="5 · When it needs the flight surgeon" title="When it needs the ground">
      {casesMissing ? (
        <EmptyState kind="loading" title="Cases loading from engine" headingLevel={3}>
          <p>engine/rules/cases.json is not in this build yet.</p>
        </EmptyState>
      ) : cases.length === 0 ? (
        <p className="lf-body-empty">
          No LANDFALL case covers this region, so there is no guided procedure or tripwire for it. LANDFALL observes and cites it;
          use the vehicle medical procedures and talk to the flight surgeon when the link allows.
        </p>
      ) : (
        <ul className="lf-cases">
          {cases.map((c) => {
            const st = statuses[c.id]
            return (
              <li key={c.id} className="lf-case" data-open={st?.open || undefined}>
                <div className="lf-case-head">
                  <p className="lf-eyebrow">LANDFALL case</p>
                  <h4>
                    <Link to={`/case/${c.id}`}>{c.title}</Link>
                  </h4>
                  {st?.open && st.severity ? (
                    <SeverityBadge severity={st.severity} label="Case open" solid />
                  ) : (
                    <span className="lf-dq" data-tone="unavailable">
                      <UnavailableIcon size={14} />
                      <span>Not open</span>
                    </span>
                  )}
                </div>
                <p>
                  <MonoDigits text={c.one_line} />
                </p>
                {st?.open ? (
                  <p className="lf-body-fine">Opened by: {st.reasons.join('; ')}</p>
                ) : (
                  <p className="lf-body-fine">Opens when any of its triggers reaches Caution. None has.</p>
                )}
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
                {c.escalation?.ground_packet ? (
                  <p className="lf-body-fine">
                    If it escalates, a delay-tolerant ground packet (FHIR R4) is queued with{' '}
                    <span className="lf-mono">{c.escalation.observations?.length ?? 0}</span> measurements, sent only with consent.
                  </p>
                ) : null}
                <ButtonLink href={`#/case/${c.id}`} variant="secondary">
                  Open the case
                </ButtonLink>
              </li>
            )
          })}
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
  caseStatuses,
  rulesMissing,
  casesMissing,
  envId,
  crewLabel,
  engineIsShim,
}: {
  region: RegionDef
  summary: RegionSummary
  ruleRows: RuleRow[]
  indicatorRows: IndicatorRow[]
  cases: CaseDef[]
  caseStatuses: Record<string, CaseStatus>
  rulesMissing: boolean
  casesMissing: boolean
  envId: EnvId
  crewLabel: string
  engineIsShim: boolean
}) {
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
                <Num value={summary.evaluated} /> of <Num value={summary.total} /> evaluated
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
        {summary.reasons.length ? (
          <ul className="lf-region-reasons">
            {summary.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        {engineIsShim && summary.total ? (
          <p className="lf-body-fine lf-region-shim">
            The rule engine is not connected in this build, so statuses read “insufficient data” instead of guessing.
          </p>
        ) : null}
      </header>
      <HowItIsAffected region={region} />
      <Measurements region={region} />
      <Limits region={region} ruleRows={ruleRows} indicatorRows={indicatorRows} rulesMissing={rulesMissing} envId={envId} />
      <ReferenceData region={region} />
      <GroundSection region={region} cases={cases} statuses={caseStatuses} casesMissing={casesMissing} />
    </article>
  )
}
