// Building blocks of the case views: the "Why this fired" expander (rule and personal findings),
// a source block that quotes the frozen standards / NOAA / HRP text verbatim, a small SVG series
// chart (single series, reserved severity colours only on the engine's own flagged points), the
// mission-clock countdown, and the event log.
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { RULES, expectedFalseAlarms, formatMet } from '../../app/engine'
import type { CaseLogEntry, Finding, Indicator, PersonalFinding, Rule, Source } from '../../app/engine'
import type { CaseOrigin } from '../../app/caseTimeline'
import type { SnapshotState } from '../../app/data'
import type { Aggregate } from '../../app/evaluate'
import { useMetNow } from '../../app/mission'
import { CategoryBadge, Chip, Citation, Expander, FindingBadge, MetTime, Num, ReqId, SeverityIcon } from '../../ui'
import type { Severity } from '../../app/vocab'
import { OP_TEXT, OP_WORDS, chipForKind, findRequirement, findTableCell, formatTMinus, metDayOf, prettyDetail } from './model'
import type { StdData } from './model'

// ---- snapshot context ------------------------------------------------------------------------------

export interface SScaleLevel {
  level: string
  descriptor?: string
  threshold_pfu?: number
  effects?: Record<string, string>
}

export interface CaseRefs {
  vol1: SnapshotState<StdData>
  vol2: SnapshotState<StdData>
  sScale: SnapshotState<{ levels?: SScaleLevel[] }>
}

const RefsCtx = createContext<CaseRefs | null>(null)
export const RefsProvider = RefsCtx.Provider
const useRefs = () => useContext(RefsCtx)

// ---- source block: the verbatim text behind a number -------------------------------------------------

function Quote({ children, label }: { children: ReactNode; label: ReactNode }) {
  return (
    <figure className="lfc-quote">
      <figcaption className="lfc-quote-label">{label}</figcaption>
      <blockquote>{children}</blockquote>
    </figure>
  )
}

/** Renders a SPEC source with its verbatim text: requirement text from the std snapshots, NOAA level text, literature quote, design rationale. */
export function SourceBlock({ source, compact = false }: { source: Source | null | undefined; compact?: boolean }) {
  const refs = useRefs()
  if (!source || typeof source !== 'object') return null
  const s = source as Record<string, unknown> & Source
  const kind = s.kind
  const verbatim = typeof s.verbatim === 'string' ? s.verbatim : null
  if (kind === 'nasa_standard') {
    const reqId = typeof s.requirement_id === 'string' ? s.requirement_id : null
    const req = reqId ? findRequirement(reqId, refs?.vol1.data, refs?.vol2.data) : null
    const cell = !reqId ? findTableCell(s, refs?.vol1.data) : null
    return (
      <div className="lfc-source">
        {req?.text ? (
          <Quote label={<>Requirement text, verbatim <ReqId id={req.id} /></>}>{req.text}</Quote>
        ) : null}
        {cell ? (
          <Quote label={<>{cell.caption}: {String(s.row)}, {String(s.column).replace('_', '-')}</>}>{cell.text}</Quote>
        ) : null}
        {verbatim && !compact ? (
          <p className="lfc-fine">
            The words that carry the number: <q>{verbatim}</q>
          </p>
        ) : null}
        {req?.rationale && !compact ? (
          <Expander summary="NASA rationale (verbatim)">
            <p>{req.rationale.replace(/^\[Rationale:\s*|\]$/g, '')}</p>
          </Expander>
        ) : null}
        {reqId && !req && refs?.vol1.status === 'ready' ? (
          <p className="lfc-fine">The requirement text is not in the frozen snapshot; see the document.</p>
        ) : null}
        <Citation source={s} />
      </div>
    )
  }
  if (kind === 'noaa') {
    const lvl = refs?.sScale.data?.levels?.find((l) => l.level === s.level)
    const bio = lvl?.effects?.Biological ?? verbatim
    return (
      <div className="lfc-source">
        {bio ? (
          <Quote label={<>NOAA {String(s.level ?? '')} {lvl?.descriptor ? `(${lvl.descriptor})` : ''}, Biological effect, verbatim</>}>{bio}</Quote>
        ) : null}
        <Citation source={s} />
      </div>
    )
  }
  if (kind === 'literature') {
    return (
      <div className="lfc-source">
        {verbatim ? (
          <Quote label={<>Quoted from the source{typeof s.page === 'number' ? <>, p. <Num value={s.page} /></> : null}</>}>{verbatim}</Quote>
        ) : null}
        <Citation source={s} />
        {typeof s.note === 'string' && !compact ? <p className="lfc-fine">{s.note}</p> : null}
      </div>
    )
  }
  return (
    <div className="lfc-source">
      <Citation source={s} />
    </div>
  )
}

// ---- why this fired ------------------------------------------------------------------------------

const FIRING: readonly string[] = ['caution', 'warning', 'emergency']

function arrowFor(f: Finding): 'up' | 'down' | undefined {
  if (!FIRING.includes(f.severity) || f.value === null) return undefined
  if (f.limit !== null) return f.value > f.limit ? 'up' : 'down'
  return undefined
}

/** "Why this fired" for a Tier A / OPS / TARGET rule finding. */
export function RuleWhy({ rule, finding, input, open = false }: { rule: Rule; finding: Finding; input?: Aggregate | null; open?: boolean }) {
  const fired = FIRING.includes(finding.severity)
  const op = finding.op ?? rule.op
  const approach = rule.approach_at ?? null
  return (
    <Expander summary={fired ? 'Why this fired' : 'How this is judged'} defaultOpen={open}>
      <dl className="lfc-why-grid">
        <div>
          <dt>Value</dt>
          <dd>
            <Num value={finding.value} unit={finding.unit} arrow={arrowFor(finding)} severity={finding.severity as Severity} />
          </dd>
        </div>
        <div>
          <dt>Limit (compliant when {OP_WORDS[op]})</dt>
          <dd>
            <span className="lf-num">{OP_TEXT[op]}</span> <Num value={finding.limit ?? rule.limit} unit={rule.unit} />
          </dd>
        </div>
        <div>
          <dt>Margin</dt>
          <dd>
            <Num value={finding.margin} unit={rule.unit} signed />
          </dd>
        </div>
        {approach ? (
          <div>
            <dt>Approaching at</dt>
            <dd>
              <Num value={approach.value} unit={rule.unit} /> <Chip kind={approach.chip} />
            </dd>
          </div>
        ) : null}
        {input ? (
          <div>
            <dt>Window</dt>
            <dd>
              {input.basis}
              {input.t !== null ? (
                <>
                  {' '}
                  (<MetTime t={input.t} label />)
                </>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="lfc-badges">
        <CategoryBadge category={finding.category} long /> <Chip kind={finding.chip} /> <FindingBadge finding={finding} />
      </p>
      <SourceBlock source={finding.source} />
      {approach?.source && approach.source.kind !== finding.source.kind ? (
        <p className="lfc-fine">
          Approach level: <Citation source={approach.source} />
        </p>
      ) : null}
      <p className="lfc-engine">
        <span className="lfc-engine-tag">Engine</span> {finding.why}
      </p>
      <p className="lfc-fine">
        <a href={`#/provenance?id=${encodeURIComponent(rule.id)}`}>Provenance of {rule.id}</a>
      </p>
    </Expander>
  )
}

interface RciLike {
  method?: unknown
  n?: unknown
  df?: unknown
  mean?: unknown
  /** Crawford & Howell single-case t-test: the critical t at the configured alpha. */
  critical?: unknown
  /** Older Reliable Change Index output. */
  critical_z?: unknown
  r?: unknown
  r_chip?: unknown
  r_source?: unknown
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

/**
 * "Why this fired" for a Tier B personal finding. Everything is READ from the engine's
 * PersonalFinding (value, band edge, baseline mean / n, critical value, df when the method has one);
 * nothing is recomputed, so it follows the engine's statistic (Crawford & Howell or RCI) unchanged.
 */
export function PersonalWhy({
  indicator,
  finding,
  baselineDays,
  alertingIndicators,
  open = false,
}: {
  indicator: Indicator
  finding: PersonalFinding
  baselineDays: [number, number]
  alertingIndicators: number
  open?: boolean
}) {
  const fired = FIRING.includes(finding.severity)
  const r = (finding.rci ?? {}) as RciLike
  const cfg = (RULES.personal?.rci ?? null) as { alpha_two_tailed?: unknown } | null
  const alpha = num(cfg?.alpha_two_tailed)
  const fa = alertingIndicators > 0 ? (expectedFalseAlarms(alertingIndicators, 1, alpha ?? undefined) as { text: string; caution_text?: unknown }) : null
  const faText = fa ? (typeof fa.caution_text === 'string' ? fa.caution_text : fa.text) : null
  const critical = num(r.critical) ?? num(r.critical_z)
  const df = num(r.df)
  const rel = indicator.reliability_r as ({ value?: unknown; used_by_engine?: unknown; chip?: string; source?: Source } | undefined)
  const rValue = num(r.r) ?? (rel?.used_by_engine === false ? null : num(rel?.value))
  const rSource = (r.r_source ?? rel?.source ?? null) as Source | null
  const def = indicator.definition
  return (
    <Expander summary={fired ? 'Why this fired' : 'How this is judged'} defaultOpen={open}>
      <dl className="lfc-why-grid">
        <div>
          <dt>Value</dt>
          <dd>
            <Num
              value={finding.value}
              unit={finding.unit}
              arrow={fired ? (finding.direction === 'increase' ? 'up' : finding.direction === 'decrease' ? 'down' : undefined) : undefined}
              severity={finding.severity as Severity}
            />
          </dd>
        </div>
        <div>
          <dt>Edge of your personal band (worse side)</dt>
          <dd>
            <Num value={finding.limit} unit={finding.unit} />
          </dd>
        </div>
        <div>
          <dt>
            Your baseline (MET days <Num value={baselineDays[0]} />–<Num value={baselineDays[1]} />)
          </dt>
          <dd>
            mean <Num value={num(r.mean)} unit={finding.unit} digits={2} />, <Num value={num(r.n)} /> values
          </dd>
        </div>
        <div>
          <dt>Critical value of the test</dt>
          <dd>
            <Num value={critical} digits={3} />
            {df !== null ? (
              <>
                {' '}
                (df <Num value={df} />)
              </>
            ) : null}
            {typeof r.method === 'string' ? <span className="lfc-fine"> {r.method.replace(/_/g, ' ')}</span> : null}
          </dd>
        </div>
        {rValue !== null ? (
          <div>
            <dt>Test-retest reliability r</dt>
            <dd>
              <Num value={rValue} /> <Chip kind={typeof r.r_chip === 'string' ? r.r_chip : rel?.chip} />
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="lfc-badges">
        <CategoryBadge category="PERSONAL" long /> <FindingBadge finding={finding} />
        {faText ? (
          <span className="lfc-fa">
            Expected false alarms across the <Num value={alertingIndicators} /> alerting indicators: {faText}.
          </span>
        ) : null}
      </p>
      {def?.text ? (
        <p className="lfc-fine">
          Definition: {def.text} <Chip kind={def.chip} /> {def.source ? <Citation source={def.source} /> : null}
        </p>
      ) : null}
      {rValue !== null && rSource && (rSource as Record<string, unknown>).kind === 'design_choice' ? (
        <p className="lfc-fine">
          Why r = <Num value={rValue} />: {String((rSource as Record<string, unknown>).rationale ?? '')}
        </p>
      ) : null}
      <p className="lfc-fine">Method:</p>
      <SourceBlock source={finding.source} compact />
      <p className="lfc-engine">
        <span className="lfc-engine-tag">Engine</span> {finding.why}
      </p>
      <p className="lfc-fine">
        <a href={`#/provenance?id=${encodeURIComponent(indicator.id)}`}>Provenance of {indicator.id}</a>
      </p>
    </Expander>
  )
}

// ---- countdown on the mission clock ----------------------------------------------------------------

/** T-minus to a MET, ticking with the mission clock (leaf component: only it re-renders each second). */
export function TMinus({ target }: { target: number }) {
  const now = useMetNow()
  const left = target - now
  return (
    <span className="lfc-tminus lf-num" role="timer" aria-live="off">
      {left > 0 ? <>T−{formatTMinus(left)}</> : 'due now'}
    </span>
  )
}

// ---- small series chart ------------------------------------------------------------------------------

export interface ChartPoint {
  t: number
  value: number
  /** Engine verdict for the point: severity colour + shape only when the engine flagged it. */
  severity: Severity
  /** Hover / table text. */
  verdict: string
  /** True for an entry added in this session (manual / Noon Sight). */
  runtime?: boolean
}

export interface RefLine {
  value: number
  label: string
  style: 'limit' | 'band' | 'mean' | 'tripwire'
}

const W = 680
const H = 230
const PAD = { l: 48, r: 132, t: 16, b: 34 }

function ticks(min: number, max: number, n = 4): number[] {
  const span = max - min || 1
  const raw = span / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)))
  return out
}

function Marker({ x, y, severity }: { x: number; y: number; severity: Severity }) {
  if (severity === 'caution' || severity === 'warning' || severity === 'emergency') {
    // triangle: the caution shape of the severity icons (shape + colour, never colour alone)
    return <path d={`M${x} ${y - 6} L${x + 5.5} ${y + 4} L${x - 5.5} ${y + 4} Z`} className="lfc-pt" data-sev={severity} />
  }
  if (severity === 'advisory') return <circle cx={x} cy={y} r={4.5} className="lfc-pt" data-sev="advisory" />
  return <circle cx={x} cy={y} r={4} className="lfc-pt" data-sev="nominal" />
}

/** Single-series chart over MET days, with reference lines and an optional shaded baseline. */
export function SeriesChart({
  title,
  unit,
  points,
  refs,
  shade,
  now,
  caption,
}: {
  title: string
  unit: string
  points: ChartPoint[]
  refs: RefLine[]
  shade?: { from: number; to: number; label: string } | null
  now?: number | null
  caption: ReactNode
}) {
  if (!points.length) return null
  const t0 = Math.min(points[0].t, shade?.from ?? Infinity)
  const t1 = Math.max(points[points.length - 1].t, now ?? -Infinity)
  const vals = [...points.map((p) => p.value), ...refs.map((r) => r.value)]
  const yMin = Math.min(0, ...vals)
  const yMax = Math.max(...vals) * 1.08 || 1
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b)
  const yt = ticks(yMin, yMax)
  const d0 = metDayOf(t0)
  const d1 = metDayOf(t1)
  const dayStep = Math.max(1, Math.ceil((d1 - d0) / 8))
  const xt: number[] = []
  for (let d = Math.ceil(d0 / dayStep) * dayStep; d <= d1; d += dayStep) xt.push(d)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  return (
    <figure className="lfc-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${points.length} values; a table follows.`}>
        {shade ? (
          <g>
            <rect x={x(shade.from)} y={PAD.t} width={Math.max(0, x(shade.to) - x(shade.from))} height={H - PAD.t - PAD.b} className="lfc-shade" />
            <text x={x(shade.from) + 6} y={PAD.t + 14} className="lfc-axis-label">
              {shade.label}
            </text>
          </g>
        ) : null}
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="lfc-grid" />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="lfc-tick">
              {v}
            </text>
          </g>
        ))}
        {xt.map((d) => (
          <text key={`x${d}`} x={x(d * 86_400)} y={H - PAD.b + 18} textAnchor="middle" className="lfc-tick">
            {d}
          </text>
        ))}
        <text x={W - PAD.r} y={H - 4} textAnchor="end" className="lfc-axis-label">
          MET day
        </text>
        <text x={PAD.l} y={PAD.t - 4} className="lfc-axis-label">
          {unit}
        </text>
        {refs.map((r) => (
          <g key={`${r.style}${r.value}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(r.value)} y2={y(r.value)} className="lfc-ref" data-style={r.style} />
            <text x={W - PAD.r + 6} y={y(r.value) + 4} className="lfc-ref-label">
              {r.label}
            </text>
          </g>
        ))}
        {now !== null && now !== undefined ? (
          <g>
            <line x1={x(now)} x2={x(now)} y1={PAD.t} y2={H - PAD.b} className="lfc-now" />
            <text x={x(now) - 4} y={H - PAD.b - 6} textAnchor="end" className="lfc-axis-label">
              now
            </text>
          </g>
        ) : null}
        <path d={path} className="lfc-line" />
        {points.map((p) => (
          <g key={p.t}>
            <Marker x={x(p.t)} y={y(p.value)} severity={p.severity} />
            <circle cx={x(p.t)} cy={y(p.value)} r={9} className="lfc-hit">
              <title>{`MET ${formatMet(p.t)}: ${p.value} ${unit}. ${p.verdict}`}</title>
            </circle>
          </g>
        ))}
      </svg>
      <figcaption className="lfc-fine">{caption}</figcaption>
      <Expander summary="Show these values as a table">
        <table className="lfc-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">MET</th>
              <th scope="col" className="num">
                Value ({unit})
              </th>
              <th scope="col">Engine verdict</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.t}>
                <td>
                  <MetTime t={p.t} />
                  {p.runtime ? ' (entered here)' : ''}
                </td>
                <td className="num">
                  <Num value={p.value} />
                </td>
                <td>
                  {p.severity !== 'nominal' ? <SeverityIcon severity={p.severity} size={12} /> : null} {p.verdict}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Expander>
    </figure>
  )
}

// ---- event log ------------------------------------------------------------------------------------

const ORIGIN_LABEL: Record<CaseOrigin, string> = {
  auto: 'LANDFALL, from the data',
  scenario: 'Simulated crew action',
  user: 'You, in this session',
  tick: 'Tripwire check',
}

/** The case's engine log (state.log) with MET timestamps and who did what; rejected events are kept, with the reason. */
export function EventLog({ log, origins }: { log: readonly CaseLogEntry[]; origins: readonly CaseOrigin[] }) {
  if (!log.length) return <p className="lfc-fine">No events yet.</p>
  return (
    <div className="lfc-table-wrap">
      <table className="lfc-table lfc-log">
        <caption className="sr-only">Case event log</caption>
        <thead>
          <tr>
            <th scope="col">MET</th>
            <th scope="col">Event</th>
            <th scope="col">State</th>
            <th scope="col">What happened</th>
            <th scope="col">By</th>
          </tr>
        </thead>
        <tbody>
          {log.map((e, i) => (
            <tr key={i} data-rejected={e.error ? 'true' : undefined} data-origin={origins[i]}>
              <td>{typeof e.t === 'number' ? <MetTime t={e.t} /> : '—'}</td>
              <td className="lf-mono">{e.event ?? '—'}</td>
              <td className="lf-mono">{e.from === e.to ? e.to : `${e.from} → ${e.to}`}</td>
              <td>
                {e.error ? <span className="lfc-rejected">Rejected: {e.error}</span> : null} {prettyDetail(e.detail)}
              </td>
              <td>
                {origins[i] === 'scenario' ? <span className="lfc-sim-tag">SIMULATED</span> : null} {ORIGIN_LABEL[origins[i]] ?? origins[i]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Chip + kind label for a case citation (cases.json citations carry a kind, not a chip). */
export function KindChip({ kind }: { kind: unknown }) {
  const chip = chipForKind(kind)
  return chip ? <Chip kind={chip} /> : null
}
