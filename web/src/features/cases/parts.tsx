// Building blocks of the case views: the "Why this fired" expander (rule and personal findings),
// a source block that quotes the frozen standards / NOAA / HRP text verbatim, a small SVG series
// chart (single series, reserved severity colours only on the engine's own flagged points), the
// mission-clock countdown, the partial-record badge (D15) and the event log in plain words.
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { FALSE_ALARM_ASSUMES, formatMet } from '../../app/engine'
import type { CaseLogEntry, Finding, Indicator, PersonalFinding, Rule, Source } from '../../app/engine'
import type { CaseOrigin, ChanceNote } from '../../app/caseTimeline'
import type { SnapshotState } from '../../app/data'
import { chanceDiffers, chanceRateOf, prettyOps, testScaleWords, transformFormula } from '../../app/evaluate'
import type { Aggregate } from '../../app/evaluate'
import { useMetNow } from '../../app/mission'
import { CategoryBadge, Chip, Citation, Expander, FindingBadge, MetTime, Num, ReqId, SeverityBadge, SeverityIcon, UnknownIcon } from '../../ui'
import type { Severity, Status } from '../../app/vocab'
import { OP_TEXT, OP_WORDS, chipForKind, findRequirement, findTableCell, formatTMinus, metDayOf, plainDetail } from './model'
import type { StdData } from './model'
import { rejectionWords } from './helpers'
import type { CaseDefFull } from './types'

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
        <span className="lfc-engine-tag">Engine</span> {prettyOps(finding.why)}
      </p>
      <p className="lfc-fine">
        <a href={`#/provenance?id=${encodeURIComponent(rule.id)}`}>Provenance of {rule.id}</a>
      </p>
    </Expander>
  )
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

const unitOf = (unit: string) => (unit === 'count' ? undefined : unit)

/**
 * The smallest change a personal band can flag (D10), read from the finding, never recomputed. Without a
 * transform it is the engine's rci.mdc = critical x SD x sqrt(1 + 1/n), the same either side of the mean. For
 * an indicator tested on another scale (PVT-B lapses, Anscombe) rci.mdc is on that scale, so this prints the
 * band mapped back to the unit instead: the rise from the raw baseline mean to the upper edge, and the fall to
 * the lower edge, or that no fall can be flagged when the lower edge is below zero (no count is). Null when
 * the baseline is too short or has no spread.
 */
export function MdcText({ finding }: { finding: PersonalFinding }) {
  const r = finding.rci
  const mdc = num(r?.mdc)
  if (mdc === null) return null
  const unit = unitOf(finding.unit)
  if (!r?.transform) {
    return (
      <>
        ±<Num value={mdc} unit={unit} digits={mdc < 10 ? 2 : 0} />
      </>
    )
  }
  const band = finding.band
  const mean = num(finding.baseline_mean)
  if (!band || mean === null) return null
  const up = band.high - mean
  const down = mean - band.low
  return (
    <>
      +<Num value={up} unit={unit} digits={2} /> {band.low < 0 ? '(no fall can be flagged)' : <>/ −<Num value={down} unit={unit} digits={2} /></>}
    </>
  )
}

/** Display digits for a band edge of this size: whole numbers from 100, one decimal from 10, two below. */
const bandDigits = (b: { low: number; high: number }) => {
  const a = Math.max(Math.abs(b.low), Math.abs(b.high))
  return a >= 100 ? 0 : a >= 10 ? 1 : 2
}

/**
 * The personal band in the indicator's own unit (the engine's finding.band, mapped back from the test scale). A
 * transformed count whose lower edge is below zero (no count can fall below it) reads "up to <high>".
 */
export function BandRange({ finding, digits }: { finding: PersonalFinding; digits?: number }) {
  const b = finding.band
  if (!b) return <Num value={null} />
  const unit = unitOf(finding.unit)
  const d = digits ?? bandDigits(b)
  if (finding.rci?.transform && b.low < 0) {
    return (
      <>
        up to <Num value={b.high} unit={unit} digits={d} />
      </>
    )
  }
  return (
    <>
      <Num value={b.low} digits={d} />–<Num value={b.high} unit={unit} digits={d} />
    </>
  )
}

/**
 * "counts, tested on the Anscombe scale 2√(x + 3/8)" with its literature citation (personal.json transform_basis),
 * for an indicator that declares a transform; nothing otherwise.
 */
export function TestScale({ indicator, compact = false }: { indicator: Indicator; compact?: boolean }) {
  const words = testScaleWords(indicator)
  if (!words) return null
  const basis = indicator.transform_basis
  return (
    <span className="lfc-scale">
      {words.charAt(0).toUpperCase() + words.slice(1)}
      {basis?.chip ? (
        <>
          {' '}
          <Chip kind={basis.chip} />
        </>
      ) : null}
      {!compact && basis?.source ? (
        <>
          {' '}
          <Citation source={basis.source} />
        </>
      ) : null}
    </span>
  )
}

/**
 * The indicator's own chance rate from the engine (chanceRate): "about 1 in N days per crewmember would flag like
 * this with no real change", with the measured multipliers where personal.json declares them (S3), so no single
 * global rate stands in for an indicator it is false for.
 */
export function ChanceLine({ indicator, detail = false }: { indicator: Indicator; detail?: boolean }) {
  const r = chanceRateOf(indicator)
  if (!r) return null
  const measured = chanceDiffers(r)
  return (
    <span className="lfc-chance-line">
      Chance alone: {r.text}
      {measured && r.alerting ? (
        <>
          {' '}
          (measured, not assumed: cautions <span className="lf-num">{r.caution_multiplier_text}</span>× the nominal {r.worse === 'either' ? 'α' : 'α/2'},
          reliable changes in either direction <span className="lf-num">{r.flag_multiplier_text}</span>× α) <Chip kind={r.chip} />
        </>
      ) : measured ? (
        <>
          {' '}
          (measured, not assumed: <span className="lf-num">{r.flag_multiplier_text}</span>× the nominal α) <Chip kind={r.chip} />
        </>
      ) : detail ? (
        <>
          {' '}
          (the test’s nominal rate: {!r.alerting ? 'α, either direction' : r.worse === 'either' ? 'α, both directions alert' : 'α/2, the worse direction only'}; it
          assumes {FALSE_ALARM_ASSUMES})
        </>
      ) : (
        <> (the test’s nominal rate)</>
      )}
      .
      {detail && r.note ? <span className="lfc-fine lfc-block"> {r.note}</span> : null}
    </span>
  )
}

/**
 * SPEC 7 "Possibly chance": an instance opened by a single Tier B flag (one indicator, one day, no other trigger at
 * caution since). The text and its N come from the engine (chanceRate of the opening indicator); a re-measure settles
 * it, and the tripwire resolves the case when the next readings stay clear.
 */
export function ChanceNoteBlock({ note, closed = false }: { note: ChanceNote; closed?: boolean }) {
  return (
    <div className="lfc-possibly" role="note">
      <p className="lfc-k">
        <span className="lfc-possibly-tag">possibly chance</span> a single flag
      </p>
      <p>
        <strong>{note.text}.</strong> {note.label} flagged on MET day <Num value={note.day} /> alone:{' '}
        {closed
          ? 'no other day and no other trigger of this case flagged before the case closed.'
          : 'no other day and no other trigger of this case has flagged since. A re-measure settles it: the case resolves when the readings after the outcome keep its tripwire clear.'}{' '}
        {note.rate.basis === 'measured' ? 'This rate is measured for this indicator, not assumed.' : 'This is the test’s own rate for this indicator.'}
      </p>
    </div>
  )
}

/**
 * Badge of a Tier B (personal) finding. A personal band is not a limit, so "within" reads "No reliable change",
 * never "Within limit" (the same words as Body and Trends); data-quality states stay cyan.
 */
export function PersonalBadge({ finding }: { finding: { status: Status; severity: Severity; category?: string | null } }) {
  if (finding.status === 'reliable_change') return <SeverityBadge severity={finding.severity} label="Reliable change" />
  if (finding.status === 'within') return <SeverityBadge severity="nominal" label="No reliable change" />
  return <FindingBadge finding={finding} />
}

/**
 * "Why this fired" for a Tier B personal finding. Everything is READ from the engine's PersonalFinding (value,
 * band and its edge, raw baseline mean, the test's own mean / SD / n on its scale, critical value, df, minimum
 * detectable change) and from chanceRate (the indicator's own chance rate); nothing is recomputed. An indicator
 * tested on another scale (PVT-B lapses: counts on the Anscombe scale) shows both scales and the citation.
 */
export function PersonalWhy({
  indicator,
  finding,
  baselineDays,
  open = false,
}: {
  indicator: Indicator
  finding: PersonalFinding
  baselineDays: [number, number]
  open?: boolean
}) {
  const fired = FIRING.includes(finding.severity)
  const r = finding.rci
  const tf = r?.transform ?? null
  const formula = transformFormula(tf)
  const critical = num(r?.critical)
  const df = num(r?.df)
  const sd = num(r?.sd)
  const n = num(r?.n)
  const mdc = num(r?.mdc)
  const def = indicator.definition
  return (
    <Expander summary={fired ? 'Why this fired' : 'How this is judged'} defaultOpen={open}>
      <dl className="lfc-why-grid">
        <div>
          <dt>Value</dt>
          <dd>
            <Num
              value={finding.value}
              unit={unitOf(finding.unit)}
              arrow={fired ? (finding.direction === 'increase' ? 'up' : finding.direction === 'decrease' ? 'down' : undefined) : undefined}
              severity={finding.severity as Severity}
            />
          </dd>
        </div>
        <div>
          <dt>Edge of your personal band ({indicator.worse === 'either' ? 'the side the value moved' : 'worse side'})</dt>
          <dd>
            <Num value={finding.limit} unit={unitOf(finding.unit)} digits={2} />
            {finding.band ? (
              <span className="lfc-fine lfc-block">
                band <BandRange finding={finding} />
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>
            Your baseline (MET days <Num value={baselineDays[0]} />–<Num value={baselineDays[1]} />)
          </dt>
          <dd>
            mean <Num value={num(finding.baseline_mean)} unit={unitOf(finding.unit)} digits={2} />
            {tf ? null : (
              <>
                , SD <Num value={sd} digits={2} />
              </>
            )}
            , <Num value={n} /> values
          </dd>
        </div>
        {formula ? (
          <div>
            <dt>Tested on the Anscombe scale {formula}</dt>
            <dd>
              today <Num value={num(r?.current)} digits={3} /> vs mean <Num value={num(r?.mean)} digits={3} />, SD <Num value={sd} digits={3} />
            </dd>
          </div>
        ) : null}
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
          </dd>
        </div>
        <div>
          <dt>Smallest change this band can flag</dt>
          <dd>
            {mdc !== null ? (
              <>
                <MdcText finding={finding} /> <Chip kind="derived" />
              </>
            ) : (
              <Num value={null} />
            )}
          </dd>
        </div>
      </dl>
      {mdc !== null && critical !== null && sd !== null && n !== null ? (
        tf ? (
          <p className="lfc-fine">
            On the Anscombe scale the band is the baseline mean ± critical × SD × √(1 + 1/n) = <Num value={num(r?.mean)} digits={3} /> ±{' '}
            <Num value={critical} digits={3} /> × <Num value={sd} digits={3} /> × √(1 + 1/<Num value={n} />) = <Num value={num(r?.mean)} digits={3} /> ±{' '}
            <Num value={mdc} digits={3} />; each edge y maps back to {finding.unit === 'count' ? 'counts' : finding.unit} as (y/2)² − 3/8, so the band is{' '}
            <BandRange finding={finding} /> (an edge below zero means no value can cross it). The transform is monotone: a value is outside this band
            exactly when its transform is outside the test’s band.
          </p>
        ) : (
          <p className="lfc-fine">
            The smallest one-day change from your baseline mean that this test can flag is critical × SD × √(1 + 1/n) ={' '}
            <Num value={critical} digits={3} /> × <Num value={sd} digits={3} /> × √(1 + 1/<Num value={n} />) = <MdcText finding={finding} />, whatever
            that change means clinically. A real change smaller than that is not flagged.
          </p>
        )
      ) : null}
      {tf ? (
        <p className="lfc-fine">
          <TestScale indicator={indicator} />. {indicator.transform_basis?.text}
        </p>
      ) : null}
      <p className="lfc-badges">
        <CategoryBadge category="PERSONAL" long /> <PersonalBadge finding={finding} />
        <span className="lfc-fa">
          <ChanceLine indicator={indicator} detail />
        </span>
      </p>
      {def?.text ? (
        <p className="lfc-fine">
          Definition: {def.text} <Chip kind={def.chip} /> {def.source ? <Citation source={def.source} /> : null}
        </p>
      ) : null}
      <p className="lfc-fine">Method:</p>
      <SourceBlock source={finding.source} compact />
      <p className="lfc-engine">
        <span className="lfc-engine-tag">Engine</span> {prettyOps(finding.why)}
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

// ---- partial dose record (D15) ------------------------------------------------------------------------

/**
 * Cyan "partial record" tag (Appendix F Table F.5-1: missing or stale data): the dose reports start after
 * the window opens, so the logged sum is a lower bound and "within limit" cannot be said.
 */
export function PartialBadge() {
  return (
    <span className="lf-dq" data-tone="stale">
      <UnknownIcon size={14} />
      <span>Partial record</span>
    </span>
  )
}

// ---- event log ------------------------------------------------------------------------------------

const ORIGIN_LABEL: Record<CaseOrigin, string> = {
  auto: 'Automatic, from the data',
  scenario: 'Simulated crew action',
  user: 'You, in this session',
  tick: 'Tripwire check',
}

/** The case's engine log (state.log) with MET timestamps and who did what; rejected events are kept, with the reason. */
export function EventLog({ log, origins, def }: { log: readonly CaseLogEntry[]; origins: readonly CaseOrigin[]; def: CaseDefFull }) {
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
                {e.error ? (
                  <span className="lfc-rejected" title={`engine code: ${e.error}`}>
                    Rejected: {rejectionWords(e.error)}
                  </span>
                ) : null}{' '}
                {plainDetail(e.detail, def)}
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
