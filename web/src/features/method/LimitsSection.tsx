// Section 2: the three kinds of limit NASA does publish (FFD floor, PEL ceiling, POL change).
// Glossary text: std_vol1_requirements (Appendix C.2), verbatim. Worked examples: thresholds.json.
import type { ReactNode } from 'react'
import { useSnapshot } from '../../app/data'
import type { SnapshotState } from '../../app/data'
import { ENVIRONMENTS } from '../../app/scenario'
import type { Category } from '../../app/vocab'
import { CategoryBadge, Chip, Expander, FreshnessChip, Num, ReqId, SimulatedMarker } from '../../ui'
import { FoldPanel } from './fold'
import { OP_SYMBOL, compliant, normReqId, windowLabel } from './rules'
import type { MetaFile, SimCrewData, ThresholdRule, ThresholdsFile, Vol1Data } from './rules'
import { ExtLink, MissingNote, RichText, Verbatim, Verified } from './shared'

const LIMIT_KINDS = ['FFD', 'PEL', 'POL'] as const
type LimitKind = (typeof LIMIT_KINDS)[number]

function envLabels(ids: string[]): string {
  if (ids.includes('*')) return 'every environment'
  return ids.map((id) => ENVIRONMENTS.find((e) => e.id === id)?.label ?? id).join('; ')
}

function reqIdOf(rule: ThresholdRule): string | null {
  return rule.source.requirement_id ? normReqId(rule.source.requirement_id) : null
}

function Limit({ rule }: { rule: ThresholdRule }) {
  return (
    <span className="lf-m-limit">
      <span className="lf-mono">{OP_SYMBOL[rule.op]}</span> <Num value={rule.limit} unit={rule.unit} />
    </span>
  )
}

function RuleNotes({ rules }: { rules: ThresholdRule[] }) {
  const notes = [...new Set(rules.flatMap((r) => r.notes ?? []))]
  if (notes.length === 0) return null
  return (
    <ul className="lf-m-notes" aria-label="Rule notes from thresholds.json">
      {notes.map((n) => (
        <li key={n}>
          <RichText text={n} />
        </li>
      ))}
    </ul>
  )
}

function RequirementText({ ids, v1 }: { ids: string[]; v1: SnapshotState<Vol1Data> }) {
  if (ids.length === 0) return null
  return (
    <Expander summary="Requirement text, verbatim">
      {ids.map((id) => {
        const r = v1.data?.requirements.find((x) => normReqId(x.id) === id)
        if (!r) {
          return (
            <MissingNote key={id}>
              <ReqId id={id} /> is not in snapshot <code>std_vol1_requirements.json</code>
              {v1.status !== 'ready' ? <> (snapshot {v1.status})</> : null}.
            </MissingNote>
          )
        }
        return (
          <Verbatim
            key={id}
            lead={<ReqId id={id} />}
            text={r.text}
            cite={
              <>
                NASA-STD-3001 Vol 1 Rev {v1.data?.document.revision} §<span className="lf-mono">{r.section}</span>,{' '}
                <ExtLink href={`${v1.data?.document.url}#page=${r.pdf_page_number}`}>
                  page <span className="lf-mono">{r.printed_page}</span>
                </ExtLink>
              </>
            }
          />
        )
      })}
    </Expander>
  )
}

function FfdExample({ rules, sim }: { rules: ThresholdRule[]; sim: SnapshotState<SimCrewData> }) {
  const demo = sim.data?.ffd_demo
  const demoRules = demo ? rules.filter((r) => r.variable === demo.variable && r.unit === demo.unit) : []
  return (
    <>
      <table className="lf-m-table">
        <caption className="sr-only">Fitness-for-duty floors by environment</caption>
        <thead>
          <tr>
            <th scope="col">Applies in</th>
            <th scope="col">Floor</th>
            <th scope="col">Basis</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>{envLabels(r.applies_to)}</td>
              <td>
                <Limit rule={r} />
              </td>
              <td>{reqIdOf(r) ? <ReqId id={reqIdOf(r)!} /> : <Chip kind={r.chip} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {demo && demoRules.length > 0 ? (
        <div className="lf-m-demo">
          <p className="lf-m-demo-head">
            <SimulatedMarker /> {demo.crew_id}: VO₂max <Num value={demo.value} unit={demo.unit} />
          </p>
          <ul className="lf-m-plain">
            {demoRules.map((r) => {
              const ok = compliant(r.op, demo.value, r.limit)
              return (
                <li key={r.id}>
                  {reqIdOf(r) ? <ReqId id={reqIdOf(r)!} /> : null}{' '}
                  <span className="lf-mono">
                    {demo.value} {OP_SYMBOL[r.op]} {r.limit}
                  </span>{' '}
                  is {ok ? 'true' : 'false'}: <strong>{ok ? 'within' : 'outside'}</strong> the floor
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      <RuleNotes rules={rules} />
    </>
  )
}

function PelExample({ rules }: { rules: ThresholdRule[] }) {
  const career = rules.find((r) => r.id === 'pel_career_effective_dose') ?? rules.find((r) => r.window.kind === 'career')
  const t481 = rules.filter((r) => r.source.table === 'Table 4.8-1')
  const organ = t481[0]?.label.split(' dose')[0]
  const organRules = organ ? t481.filter((r) => r.label.startsWith(`${organ} dose`)) : []
  const units = [...new Set(t481.map((r) => r.unit))]
  return (
    <>
      {career ? (
        <>
          <p>
            {career.label}: <Limit rule={career} /> over a <strong>{windowLabel(career.window)}</strong> window{' '}
            {reqIdOf(career) ? <ReqId id={reqIdOf(career)!} /> : null} <Chip kind={career.chip} />
          </p>
          {career.approach_at ? (
            <p className="lf-m-small">
              LANDFALL shows “approaching” from <Num value={career.approach_at.value} unit={career.unit} />{' '}
              <Chip kind={career.approach_at.chip} />{' '}
              {career.approach_at.source.rationale ? <RichText text={career.approach_at.source.rationale} /> : null}
            </p>
          ) : null}
          <RuleNotes rules={[career]} />
        </>
      ) : (
        <MissingNote>No career-window PEL rule in thresholds.json.</MissingNote>
      )}
      {organRules.length > 0 ? (
        <>
          <p className="lf-m-small">
            Table 4.8-1 adds <Num value={t481.length} /> organ limits, in {units.join(' or ')} (never mSv). One organ, by
            window:
          </p>
          <table className="lf-m-table">
            <caption className="sr-only">{organ} dose limits by window, Table 4.8-1</caption>
            <thead>
              <tr>
                <th scope="col">{organ}, window</th>
                <th scope="col">Ceiling</th>
              </tr>
            </thead>
            <tbody>
              {organRules.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{windowLabel(r.window)}</th>
                  <td>
                    <Limit rule={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </>
  )
}

function PolExample({ rules }: { rules: ThresholdRule[] }) {
  const definition = rules.find((r) => r.window.value_definition)?.window.value_definition
  return (
    <>
      <table className="lf-m-table">
        <caption className="sr-only">Bone mineral density outcome limits</caption>
        <thead>
          <tr>
            <th scope="col">Site</th>
            <th scope="col">Must stay</th>
            <th scope="col">Basis</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>{r.label.replace(/ bone mineral density vs pre-mission$/i, '')}</td>
              <td>
                <Limit rule={r} />
              </td>
              <td>{reqIdOf(r) ? <ReqId id={reqIdOf(r)!} /> : <Chip kind={r.chip} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {definition ? (
        <p className="lf-m-small">
          Value compared: <span className="lf-mono">{definition}</span>
        </p>
      ) : null}
      <RuleNotes rules={rules} />
    </>
  )
}

function LimitCard({
  kind,
  meta,
  v1,
  rules,
  example,
  exampleReqIds,
}: {
  kind: LimitKind
  meta: MetaFile
  v1: SnapshotState<Vol1Data>
  rules: ThresholdRule[]
  example: ReactNode
  exampleReqIds: string[]
}) {
  const cat = meta.categories.find((c) => c.id === kind)
  const g = v1.data?.glossary.find((x) => x.category === kind)
  const agrees = g && cat?.glossary ? g.definition === cat.glossary : null
  return (
    <article className="lf-m-kind" aria-labelledby={`m-kind-${kind}`}>
      <header className="lf-m-kind-head">
        <CategoryBadge category={kind as Category} long />
        <h3 id={`m-kind-${kind}`} className="lf-m-kind-title">
          {cat?.name ?? kind}
        </h3>
        {cat ? <p className="lf-m-kind-shape">A {cat.shape}.</p> : null}
      </header>
      {g ? (
        <Verbatim
          lead={<span className="lf-m-term">{g.term}:</span>}
          text={g.definition}
          cite={
            <>
              Vol 1 Rev {v1.data?.document.revision}, {g.appendix},{' '}
              <ExtLink href={`${v1.data?.document.url}#page=${g.pdf_page_number}`}>
                page <span className="lf-mono">{g.printed_page}</span>
              </ExtLink>{' '}
              · <Verified ok={g.verified} />
              {agrees === true ? <> · matches meta.json</> : null}
            </>
          }
        />
      ) : v1.status === 'loading' ? (
        <p className="lf-m-small">Reading the glossary…</p>
      ) : (
        <MissingNote>
          The Vol 1 glossary entry for {kind} is not in snapshot <code>std_vol1_requirements.json</code>.
        </MissingNote>
      )}
      {agrees === false ? (
        <MissingNote>The glossary text in meta.json differs from the snapshot; the snapshot text is shown.</MissingNote>
      ) : null}
      <h4 className="lf-m-h4">Worked example</h4>
      {rules.length > 0 ? example : <MissingNote>No {kind} rule in thresholds.json.</MissingNote>}
      <RequirementText ids={exampleReqIds} v1={v1} />
    </article>
  )
}

export function LimitsSection({ meta, thresholds }: { meta: MetaFile; thresholds: ThresholdsFile }) {
  const v1 = useSnapshot<Vol1Data>('std_vol1_requirements')
  const sim = useSnapshot<SimCrewData>('sim_crew')
  const alertRules = (k: LimitKind) => thresholds.rules.filter((r) => r.category === k && r.tier === 'A' && r.role === 'alert')
  const ffd = alertRules('FFD')
  const pel = alertRules('PEL')
  const pol = alertRules('POL')
  const careerPel = pel.find((r) => r.id === 'pel_career_effective_dose') ?? pel.find((r) => r.window.kind === 'career')
  const ids = (rules: ThresholdRule[]) => [...new Set(rules.map(reqIdOf).filter((x): x is string => !!x))]
  const principle = meta.principles.find((p) => p.id === 'three_kinds_of_limit')
  const others = meta.categories.filter((c) => !(LIMIT_KINDS as readonly string[]).includes(c.id))

  return (
    <FoldPanel
      s="limits"
      eyebrow="What NASA does publish"
      title="Three kinds of limit, three shapes"
      abstract="Fitness-for-duty floors, exposure ceilings and outcome limits: NASA’s definitions word for word, each with a worked example."
      footer={
        <>
          <span>Glossary: NASA-STD-3001 Vol 1 Appendix C.2 · rules: engine/rules/thresholds.json</span>
          <FreshnessChip meta={v1.snapshot} status={v1.status} id="std_vol1_requirements" />
        </>
      }
    >
      {principle ? (
        <p className="lf-m-lede">
          <RichText text={principle.text} />
        </p>
      ) : null}
      <p>
        Each kind keeps its own glyph wherever LANDFALL shows it: a hatched floor for FFD, a hatched ceiling for PEL, a
        delta for POL. The definitions are NASA’s, word for word.
      </p>
      <div className="lf-m-kinds">
        <LimitCard kind="FFD" meta={meta} v1={v1} rules={ffd} example={<FfdExample rules={ffd} sim={sim} />} exampleReqIds={ids(ffd)} />
        <LimitCard
          kind="PEL"
          meta={meta}
          v1={v1}
          rules={pel}
          example={<PelExample rules={pel} />}
          exampleReqIds={careerPel ? ids([careerPel]) : []}
        />
        <LimitCard kind="POL" meta={meta} v1={v1} rules={pol} example={<PolExample rules={pol} />} exampleReqIds={ids(pol)} />
      </div>
      {others.length > 0 ? (
        <div className="lf-m-aside">
          <h3 className="lf-m-h4">Also on screen, and not NASA limits</h3>
          <ul className="lf-m-others">
            {others.map((c) => (
              <li key={c.id}>
                {c.id === 'OPS' || c.id === 'PERSONAL' ? (
                  <CategoryBadge category={c.id} />
                ) : (
                  <span className="lf-cat" data-category={c.id}>
                    <span className="lf-cat-code">{c.id}</span>
                  </span>
                )}{' '}
                <strong>{c.name}</strong>: {c.shape}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </FoldPanel>
  )
}
