// #/trends: every personal indicator of one crewmember over the simulated mission days, against the
// personal band the engine reports (baseline mean +/- critical x scale), with the engine's per-day
// Tier B verdicts as flagged points and the Tier A limits that apply on the same variable. Mood is
// private and never charted. Today's 1-min heart rate is drawn as a per-pixel-column min/max
// envelope. Historical (daily, recorded) and live (today's stream) are labelled apart (F.5.8 b).
// Each band prints its minimum detectable change (D10): the smallest one-day change Tier B can flag,
// from the engine (rci.mdc), and the same at the simulator's noise SD (minDetectableChange), so a
// reader sees which scripted episodes Tier B can catch and which only Tier A does.
import { useEffect, useMemo, useState } from 'react'
import type { FeatureProps } from '../../app/router'
import { RULES, expectedFalseAlarms, minDetectableChange } from '../../app/engine'
import type { PersonalFinding, Rule } from '../../app/engine'
import type { PersonalEvaluation } from '../../app/evaluate'
import { useMission } from '../../app/mission'
import { useCrewEvaluation, useEvaluation, useScenario } from '../../app/model'
import { observationDay, observationsFor } from '../../app/scenarioData'
import type { ScenarioIndex } from '../../app/scenarioData'
import { environment } from '../../app/scenario'
import { CREW, CREW_IDS, SEVERITY_RANK, isCrewId } from '../../app/vocab'
import type { CrewId, EnvId, Observation, Severity } from '../../app/vocab'
import {
  CategoryBadge,
  Chip,
  Citation,
  EmptyState,
  Expander,
  FindingBadge,
  MetTime,
  Num,
  Panel,
  ReqId,
  SeverityBadge,
  SeverityIcon,
  SimulatedMarker,
  StaleIcon,
  formatNumber,
} from '../../ui'
import { TimeChart, envelope, severityToken, shapeFor } from './chart'
import type { HLineSpec, LineSpec, MarkSpec, RegionSpec, VLineSpec } from './chart'
import {
  alertingEitherCount,
  alertingIndicatorCount,
  buildIndicatorTrend,
  buildRuleSeries,
  cadenceOf,
  chartedIndicators,
  dayRangeText,
  displayBand,
  runsOf,
  scenarioNote,
  toDay,
} from './model'
import type { DisplayBand, IndicatorTrend, PersonalBand, ScenarioNote, SeriesTrend, TrendPoint } from './model'
import './trends.css'

const OP_SYMBOL: Record<string, string> = { lt: '<', le: '≤', gt: '>', ge: '≥' }

const STATUS_WORDS: Record<string, string> = {
  within: 'within',
  approaching: 'approaching',
  outside: 'outside',
  reliable_change: 'reliable change',
  insufficient_data: 'insufficient data',
  stale: 'stale',
  not_applicable: 'not applicable',
}

const fmt = (v: number, digits?: number) => formatNumber(v, digits)

/** An action's text without its own label in front ("EVA assignment not cleared: this ..." -> "This ..."). */
function actionSentence(action: { label: string; text: string }): string {
  const rest = action.text.startsWith(`${action.label}: `) ? action.text.slice(action.label.length + 2) : action.text
  return rest ? rest[0].toUpperCase() + rest.slice(1) : action.text
}
/** MET day number, no leading zeros (Appendix F F.5: numbers >= 1 have none; F.6.1 f for the day field). */
const dayLabel = (v: number) => String(Math.floor(v))

function digitsFor(unit: string, values: number[]): number {
  if (unit === 'count') return 0
  if (values.length && values.every((v) => Number.isInteger(v))) return 0
  const span = values.length ? Math.max(...values) - Math.min(...values) : 0
  return span >= 50 ? 0 : span >= 5 ? 1 : 2
}

/** Digits for a change of this size (a minimum detectable change). */
function changeDigits(x: number, unit: string): number {
  if (unit === 'count') return 1
  const a = Math.abs(x)
  return a >= 100 ? 0 : a >= 10 ? 1 : 2
}

/** The rule's NASA requirement id ("V1 4002"), when its source has one. */
function reqIdOf(rule: Rule): string | null {
  const s = rule.source as unknown as Record<string, unknown> | undefined
  return s && typeof s.requirement_id === 'string' && s.requirement_id ? s.requirement_id : null
}

function ruleLabel(rule: Rule): string {
  const rid = reqIdOf(rule)
  const id = rid ? `[${rid}] ` : ''
  return `${id}${rule.category} ${OP_SYMBOL[rule.op] ?? rule.op} ${fmt(rule.limit)} ${rule.unit}`
}

/**
 * Badge of a Tier B (personal) finding. A personal band is not a limit, so "within" reads
 * "No reliable change", never "Within limit"; data-quality states stay cyan.
 */
function PersonalBadge({ finding }: { finding: Pick<PersonalFinding, 'status' | 'severity' | 'category'> }) {
  if (finding.status === 'reliable_change') return <SeverityBadge severity={finding.severity} label="Reliable change" />
  if (finding.status === 'within') return <SeverityBadge severity="nominal" label="No reliable change" />
  return <FindingBadge finding={finding} />
}

// ---- crew picker -------------------------------------------------------------------------------

function CrewPicker({ crewId, onPick }: { crewId: CrewId; onPick: (c: CrewId) => void }) {
  const { evaluation } = useEvaluation()
  return (
    <div className="lf-tr-crew" role="group" aria-label="Crewmember">
      {CREW.map((c) => {
        const tb = evaluation?.crew[c.id]?.tierB ?? []
        const flagged = tb.filter((e) => !e.indicator.private && e.finding.status === 'reliable_change' && SEVERITY_RANK[e.finding.severity as Severity] >= SEVERITY_RANK.caution).length
        return (
          <button key={c.id} type="button" className="lf-tr-crew-btn" aria-pressed={c.id === crewId} onClick={() => onPick(c.id)}>
            <span className="lf-num">{c.id}</span>
            <span className="lf-tr-crew-role">{c.role}</span>
            {!evaluation ? (
              <span className="lf-tr-crew-none lf-tr-crew-na">verdict unavailable</span>
            ) : flagged > 0 ? (
              <SeverityBadge severity="caution" size="sm" label={`${flagged} changed now`} />
            ) : (
              <span className="lf-tr-crew-none">no reliable change now</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ---- false-alarm statement (the engine's expected_false_alarms, in plain words) -------------------

function FalseAlarms({ k, kEither, days, crewSize }: { k: number; kEither: number; days: number; crewSize: number }) {
  const cfg = (RULES.personal?.rci ?? {}) as Record<string, unknown>
  const alpha = typeof cfg.alpha_two_tailed === 'number' ? cfg.alpha_two_tailed : null
  const caveat = typeof cfg.caveat === 'string' ? cfg.caveat : null
  if (alpha === null || k <= 0 || days <= 0) {
    return (
      <p className="lf-tr-fa-text">
        <StaleIcon size={14} /> The expected false-alarm rate is not available: the personal rules give no alpha.
      </p>
    )
  }
  // Flags (either direction) and cautions (the worse direction; both for the k_either indicators that
  // alert both ways) come from the engine's expected_false_alarms: no rate is derived here.
  const one = expectedFalseAlarms(k, days, alpha, kEither)
  const crew = expectedFalseAlarms(k * crewSize, days, alpha, kEither * crewSize)
  return (
    <div className="lf-tr-fa-text">
      <p>
        <strong>What a flag costs in false alarms.</strong> Each of the <Num value={k} /> alerting personal indicators is tested once a
        day against this crewmember’s own band, at a two-tailed alpha of <Num value={alpha} />. By chance alone, for one crewmember
        that gives <strong>{one.text}</strong> (<Num value={one.expected} digits={2} /> expected over the <Num value={days} /> days since
        the baseline); for the crew of <Num value={crewSize} />, <strong>{crew.text}</strong>. Cautions are rarer, per crewmember:{' '}
        <strong>{one.caution_text}</strong>.
      </p>
      <Expander summary="Why the printed rate is a lower bound">
        <p className="lf-tr-muted">
          The rate assumes {one.assumes} (engine <code>expected_false_alarms</code>).
          {caveat ? ` ${caveat}` : ''}
        </p>
      </Expander>
    </div>
  )
}

// ---- legend glyphs (same shapes as the canvas marks) ------------------------------------------------

function Glyph({ shape, token, hollow }: { shape: 'diamond' | 'square' | 'band' | 'line' | 'dash'; token: string; hollow?: boolean }) {
  const c = `var(${token})`
  return (
    <svg className="lf-tr-glyph" width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
      {shape === 'diamond' ? <path d="M8 1 L13 6 L8 11 L3 6 Z" fill={hollow ? 'none' : c} stroke={c} strokeWidth="1.6" /> : null}
      {shape === 'square' ? <rect x="3" y="1.5" width="9" height="9" fill="none" stroke={c} strokeWidth="1.8" /> : null}
      {shape === 'band' ? <rect x="1" y="2" width="14" height="8" fill={c} opacity="0.35" stroke={c} strokeDasharray="2 2" /> : null}
      {shape === 'line' ? <line x1="1" y1="6" x2="15" y2="6" stroke={c} strokeWidth="2" /> : null}
      {shape === 'dash' ? <line x1="1" y1="6" x2="15" y2="6" stroke={c} strokeWidth="2" strokeDasharray="3 2" /> : null}
    </svg>
  )
}

// ---- chart assembly ----------------------------------------------------------------------------------

interface ChartParts {
  x: number[]
  lines: LineSpec[]
  bands: { upper: number; lower: number; fill: string }[]
  hlines: HLineSpec[]
  regions: RegionSpec[]
  vlines: VLineSpec[]
  marks: MarkSpec[]
  yMin: number
  yMax: number
  xMin: number
  xMax: number
}

function firstOfRun(points: readonly TrendPoint[], i: number, pick: (p: TrendPoint) => boolean): boolean {
  return pick(points[i]) && (i === 0 || !pick(points[i - 1]))
}

function dailyChart(
  trend: SeriesTrend,
  band: DisplayBand | null,
  index: ScenarioIndex,
  t: number,
  xOf: (p: TrendPoint) => number = (p) => p.day + 0.5,
): ChartParts {
  const pts = trend.points
  const x = pts.map(xOf)
  const lines: LineSpec[] = [{ label: trend.variable, values: pts.map((p) => p.value), color: '--lf-text-2', width: 1.5, points: 4 }]
  const bands: ChartParts['bands'] = []
  const ys: number[] = pts.map((p) => p.value)
  if (band) {
    lines.push({ label: 'band high', values: pts.map(() => band.hi), color: '--lf-text-muted', width: 1, dash: [3, 3] })
    lines.push({ label: 'band low', values: pts.map(() => band.lo), color: '--lf-text-muted', width: 1, dash: [3, 3] })
    bands.push({ upper: 1, lower: 2, fill: 'rgba(209,209,209,0.12)' })
    ys.push(band.lo, band.hi)
  }
  const hlines: HLineSpec[] = []
  for (const rule of trend.rules) {
    const f = trend.ruleNow.get(rule.id)
    const applies = f ? f.status !== 'not_applicable' : true
    hlines.push({
      y: rule.limit,
      label: applies ? ruleLabel(rule) : `${ruleLabel(rule)} · not applicable here`,
      short: applies ? `${rule.category} ${OP_SYMBOL[rule.op] ?? rule.op} ${fmt(rule.limit)}` : 'other environment',
      color: applies ? '--lf-border-strong' : '--lf-data-unavailable',
      dash: applies ? undefined : [6, 4],
      width: applies ? 1.5 : 1,
    })
    ys.push(rule.limit)
    if (applies && rule.approach_at && typeof rule.approach_at.value === 'number') {
      hlines.push({ y: rule.approach_at.value, label: `approach ${fmt(rule.approach_at.value)} (${rule.approach_at.chip})`, short: 'approach', color: '--lf-text-muted', dash: [2, 4], width: 1 })
      ys.push(rule.approach_at.value)
    }
  }
  const marks: MarkSpec[] = []
  const worse = (p: TrendPoint) => p.flag === 'worse'
  const better = (p: TrendPoint) => p.flag === 'better'
  const tierA = (p: TrendPoint) => p.tierA.length > 0
  // A Tier A status is labelled once on the canvas (its first point); the list under the chart has every day.
  const labelled = new Set<string>()
  pts.forEach((p, i) => {
    const xi = x[i]
    if (p.tierA.length) {
      const top = p.tierA.reduce((a, b) => (SEVERITY_RANK[b.finding.severity as Severity] > SEVERITY_RANK[a.finding.severity as Severity] ? b : a))
      const key = `${top.rule.id}:${top.finding.status}`
      // Only a limit or target that is not met gets a canvas label; "approaching" is in the list below.
      const label = labelled.has(key) || top.finding.status === 'approaching' ? undefined : `${top.rule.category} ${STATUS_WORDS[top.finding.status] ?? top.finding.status}`
      labelled.add(key)
      marks.push({ x: xi, y: p.value, shape: 'square', hollow: true, size: 8, color: severityToken(top.finding.severity as Severity), label })
    }
    if (p.flag && p.finding) {
      const sev = p.finding.severity as Severity
      marks.push(
        p.flag === 'worse'
          ? { x: xi, y: p.value, shape: shapeFor(sev), color: severityToken(sev), size: 5.5, label: firstOfRun(pts, i, worse) && !tierA(p) && !labelled.has('worse') ? 'reliable change' : undefined }
          : { x: xi, y: p.value, shape: 'diamond', hollow: true, color: '--lf-text', size: 5.5, label: firstOfRun(pts, i, better) && !labelled.has('better') ? 'change, other side' : undefined },
      )
      labelled.add(p.flag)
    }
  })
  const [b0, b1] = index.baselineDays
  const regions: RegionSpec[] = [{ x0: b0, x1: b1 + 1, label: `BASELINE ${b0}–${b1}`, fill: 'rgba(255,255,255,0.045)' }]
  const vlines: VLineSpec[] = [{ x: toDay(t), label: 'NOW', color: '--lf-text' }]
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  }
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12
  // A quantity that cannot be negative never gets an axis below zero.
  const yMin = lo >= 0 ? Math.max(0, lo - pad) : lo - pad
  return { x, lines, bands, hlines, regions, vlines, marks, yMin, yMax: hi + pad, xMin: index.firstDay, xMax: Math.max(toDay(t), index.lastDay + 1) }
}

function DataTable({ trend, digits }: { trend: SeriesTrend; digits: number }) {
  return (
    <div className="lf-tr-table-wrap">
      <table className="lf-tr-table">
        <thead>
          <tr>
            <th scope="col">MET day</th>
            <th scope="col" className="num">
              Value ({trend.unit})
            </th>
            <th scope="col">Personal (Tier B)</th>
            <th scope="col">Published limit (Tier A)</th>
          </tr>
        </thead>
        <tbody>
          {trend.points.map((p) => (
            <tr key={p.t}>
              <td className="num">{dayLabel(p.day)}</td>
              <td className="num">{fmt(p.value, digits)}</td>
              <td>{p.baseline ? 'baseline' : p.finding ? `${STATUS_WORDS[p.finding.status] ?? p.finding.status}${p.flag ? ` (${p.flag === 'worse' ? 'worse' : 'other'} side)` : ''}` : '—'}</td>
              <td>{p.tierA.length ? p.tierA.map((h) => `${h.rule.category} ${STATUS_WORDS[h.finding.status] ?? h.finding.status}`).join('; ') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** "days 370, 378 and 391" or "days 398–401" from a list of runs. */
function runsText(runs: Array<{ from: number; to: number }>): string {
  const parts = runs.map((r) => (r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`))
  const single = runs.length === 1 && runs[0].from === runs[0].to
  const list = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${single ? 'day' : 'days'} ${list}`
}

function FlagSummary({ trend, note, alerting }: { trend: SeriesTrend; note?: ScenarioNote | null; alerting?: boolean }) {
  const pts = trend.points
  const items: Array<{ key: string; severity: Severity; text: string }> = []
  const worsePick = (p: TrendPoint) => p.flag === 'worse'
  const sevWorse = (pts.find(worsePick)?.finding?.severity ?? 'caution') as Severity
  const scripted = note?.scriptedDays ?? null
  for (const r of runsOf(pts, worsePick, (p) => p.day)) {
    const run = pts.filter((p) => worsePick(p) && p.day >= r.from && p.day <= r.to)
    const entered = run.every((p) => p.provenance !== 'simulated')
    const chance = !entered && scripted !== null && run.every((p) => !scripted.has(p.day))
    const what = alerting === false ? 'Reliable change (a non-alerting indicator: shown, never an alert)' : 'Reliable change in the worse direction'
    const tail = entered
      ? ' Your own entry this session.'
      : chance
        ? ' No change was scripted then: a chance flag from realistic day-to-day noise (see the false-alarm rate above).'
        : ''
    items.push({ key: `w${r.from}`, severity: sevWorse, text: `${what} on ${dayRangeText(r)} (${r.n} value${r.n > 1 ? 's' : ''}).${tail}` })
  }
  const betterRuns = runsOf(pts, (p) => p.flag === 'better', (p) => p.day)
  for (const r of betterRuns) items.push({ key: `b${r.from}`, severity: 'nominal', text: `Reliable change in the other direction on ${dayRangeText(r)}: not an alert.` })
  // Tier A: one line per rule and status, every day listed.
  for (const rule of trend.rules) {
    const byStatus = new Map<string, TrendPoint[]>()
    for (const p of pts) {
      const h = p.tierA.find((x) => x.rule.id === rule.id)
      if (!h) continue
      const list = byStatus.get(h.finding.status) ?? []
      list.push(p)
      byStatus.set(h.finding.status, list)
    }
    for (const [status, list] of byStatus) {
      const first = list[0].tierA.find((h) => h.rule.id === rule.id)!
      const runs = runsOf(list, () => true, (p) => p.day)
      items.push({
        key: `${rule.id}:${status}`,
        severity: first.finding.severity as Severity,
        text: `${rule.label ?? rule.id}: ${STATUS_WORDS[status] ?? status} on ${runsText(runs)} (${list.length} value${list.length > 1 ? 's' : ''}).`,
      })
    }
  }
  if (!items.length) return <p className="lf-tr-flags-none">No flagged value in this series.</p>
  return (
    <ul className="lf-tr-flags">
      {items.map((it) => (
        <li key={it.key} data-severity={it.severity}>
          <SeverityIcon severity={it.severity} size={14} />
          <span>{it.text}</span>
        </li>
      ))}
    </ul>
  )
}

function RuleChips({ trend }: { trend: SeriesTrend }) {
  const { rules, ruleNow } = trend
  if (!rules.length) return null
  return (
    <ul className="lf-tr-rules">
      {trend.ruleError ? (
        <li className="lf-tr-nodata">
          <StaleIcon size={13} /> Limit check unavailable: {trend.ruleError}
        </li>
      ) : null}
      {rules.map((r) => {
        const f = ruleNow.get(r.id)
        return (
          <li key={r.id}>
            <CategoryBadge category={r.category} long />
            <span>
              {r.label ?? r.id}: {OP_SYMBOL[r.op] ?? r.op} <Num value={r.limit} unit={r.unit} />
            </span>
            {reqIdOf(r) ? <ReqId id={reqIdOf(r)!} /> : null}
            <Chip kind={r.chip} />
            {f ? <FindingBadge finding={f} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

/** The band and its minimum detectable change (D10), in words. */
function BandLine({ band, shown, unit, digits, note }: { band: PersonalBand; shown: DisplayBand; unit: string; digits: number; note: ScenarioNote }) {
  const mdc = band.mdc
  const n = band.n
  let atModel: number | null = null
  if (note.modelSd !== null && note.modelSd > 0 && n !== null && n >= 2) {
    try {
      atModel = minDetectableChange(note.modelSd, n).mdc
    } catch {
      atModel = null
    }
  }
  const md = mdc !== null ? changeDigits(mdc, unit) : digits
  return (
    <span className="lf-tr-band">
      <span>
        Band <Num value={shown.lo} digits={digits} />–<Num value={shown.hi} unit={unit} digits={digits} /> = mean <Num value={band.mean} digits={digits} /> ±{' '}
        {band.critical !== null && band.scale !== null ? (
          <>
            <Num value={band.critical} digits={2} /> × <Num value={band.scale} digits={digits + 1} />
          </>
        ) : (
          <Num value={band.hi - band.mean} digits={digits} />
        )}
        {shown.note ? <span className="lf-tr-muted"> ({shown.note})</span> : null}
      </span>
      {mdc !== null ? (
        <span className="lf-tr-mdc">
          Smallest change it can flag: <strong>±<Num value={mdc} unit={unit} digits={md} /></strong> from the mean <Chip kind="derived" />
          {atModel !== null ? (
            <>
              {' '}
              · <Num value={atModel} unit={unit} digits={md} /> at the simulator’s noise SD (<Num value={note.modelSd} unit={unit} digits={md} />)
              {note.modelSdChip ? (
                <>
                  {' '}
                  <Chip kind={note.modelSdChip} />
                </>
              ) : null}
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  )
}

function EpisodeNote({ note, trend, crewId }: { note: ScenarioNote; trend: IndicatorTrend; crewId: CrewId }) {
  if (!note.episodes.length) return null
  const t = trend.points
  return (
    <ul className="lf-tr-episodes">
      {note.episodes.map((e) => {
        const flagged = t.filter((p) => p.flag === 'worse' && p.day >= e.from && p.day <= e.to).map((p) => p.day)
        const total = e.to - e.from + 1
        const runs = runsOf(flagged.map((d) => ({ d })), () => true, (p) => p.d)
        const prob =
          e.pMin !== null && e.pMax !== null ? (
            <>
              {' '}
              The generator’s chance of flagging each scripted day under this noise was <Num value={e.pMin} digits={2} />–
              <Num value={e.pMax} digits={2} />.
            </>
          ) : null
        return (
          <li key={`${e.from}-${e.to}`}>
            <strong>Scripted episode for {crewId}, MET days {e.from}–{e.to}</strong> (simulated):{' '}
            {flagged.length ? (
              <>
                Tier B flags {runsText(runs)} ({flagged.length} of {total}).
              </>
            ) : (
              <>Tier B flags none of the {total} days: the change is smaller than the smallest change this band can flag.</>
            )}
            {prob}
            {e.tierAOutsideDays.length ? (
              <>
                {' '}
                Tier A catches it: the case target is not met on{' '}
                {runsText(runsOf(e.tierAOutsideDays.map((d) => ({ d })), () => true, (p) => p.d))}.
              </>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** "No NASA numeric limit: ..." in one line, with how we know it in a disclosure. */
function LimitNote({ text, chip }: { text: string; chip?: string }) {
  const i = text.indexOf('. ')
  const head = i < 0 ? text : text.slice(0, i + 1)
  const rest = i < 0 ? '' : text.slice(i + 2)
  return (
    <div className="lf-tr-note">
      <p>
        {head} <Chip kind={chip} />
      </p>
      {rest ? (
        <Expander summary="How we know">
          <p className="lf-tr-muted">{rest}</p>
        </Expander>
      ) : null}
    </div>
  )
}

/** A case's title from engine/rules/cases.json (its id when the rules are absent). */
function caseTitle(id: string): string {
  const c = (RULES.cases?.cases ?? []).find((x) => x.id === id)
  return typeof c?.title === 'string' ? c.title : id
}

// ---- cards -----------------------------------------------------------------------------------------

/** The Noon Sight step where a manual indicator is typed in. */
const ENTRY_STEP: Record<string, string> = { bp_systolic: 'kit', bp_diastolic: 'kit', glucose: 'kit', urine_volume_24h: 'fluids', fluid_intake_24h: 'fluids' }

function cadenceWords(trend: SeriesTrend): string {
  const c = cadenceOf(trend.points)
  return c === 'twice a week' ? 'TWICE A WEEK' : c === 'periodic' ? 'PERIODIC' : 'DAILY'
}

function IndicatorCard({
  trend,
  now,
  index,
  t,
  crewId,
  simData,
}: {
  trend: IndicatorTrend
  now: PersonalEvaluation | null
  index: ScenarioIndex
  t: number
  crewId: CrewId
  simData: unknown
}) {
  const ind = trend.indicator
  const band = trend.band
  const shown = useMemo(() => (band ? displayBand(band, ind.unit) : null), [band, ind.unit])
  const parts = useMemo(() => dailyChart(trend, shown, index, t), [trend, shown, index, t])
  const note = useMemo(() => scenarioNote(simData, crewId, ind.id, ind.variable), [simData, crewId, ind.id, ind.variable])
  const values = trend.points.map((p) => p.value)
  const digits = digitsFor(ind.unit, values)
  const f: PersonalFinding | null = now?.finding ?? trend.latest
  const lastPoint = trend.points[trend.points.length - 1]
  const cur = now?.current ?? (lastPoint ? { value: lastPoint.value, t: lastPoint.t } : null)
  const sev = (f?.severity ?? 'nominal') as Severity
  const arrow = f?.direction === 'increase' ? 'up' : f?.direction === 'decrease' ? 'down' : undefined
  const yFormat = useMemo(() => (v: number) => fmt(v, digits), [digits])
  const flaggedNow = f?.status === 'reliable_change' && SEVERITY_RANK[sev] >= SEVERITY_RANK.caution
  const cadence = cadenceWords(trend)
  const summary = `${ind.label ?? ind.id} for ${crewId}: ${trend.points.length} values up to MET day ${dayLabel(observationDay(t))}${shown ? `; personal band ${fmt(shown.lo, digits)} to ${fmt(shown.hi, digits)} ${ind.unit}` : ''}${band?.mdc != null ? `; smallest change it can flag ${fmt(band.mdc, changeDigits(band.mdc, ind.unit))} ${ind.unit}` : ''}; ${trend.points.filter((p) => p.flag === 'worse').length} values flagged in the worse direction.`
  return (
    <article className="lf-tr-card" data-severity={f && f.status === 'reliable_change' ? sev : undefined} aria-labelledby={`tr-${ind.id}`}>
      <header className="lf-tr-card-head">
        <div>
          <p className="lf-eyebrow">
            <span className="lf-tr-kind" data-kind="historical">
              HISTORICAL · {cadence}
            </span>{' '}
            MET days {index.firstDay}–{dayLabel(observationDay(t))}
          </p>
          <h3 id={`tr-${ind.id}`} className="lf-tr-card-title">
            {ind.label ?? ind.id}
          </h3>
        </div>
        {f ? <PersonalBadge finding={f} /> : null}
      </header>
      <p className="lf-tr-meta">
        <span>
          Latest <Num value={cur?.value ?? null} unit={ind.unit} digits={digits} arrow={f?.status === 'reliable_change' ? arrow : undefined} severity={sev} />
          {cur ? (
            <>
              {' '}
              at <MetTime t={cur.t} label />
            </>
          ) : null}
        </span>
        {band && shown ? (
          <BandLine band={band} shown={shown} unit={ind.unit} digits={digits} note={note} />
        ) : (
          <span className="lf-tr-nodata">
            <StaleIcon size={13} />{' '}
            {trend.error ? `No band: the engine rejected this test (${trend.error}).` : 'No band: the engine could not test this series (insufficient data).'}
          </span>
        )}
      </p>
      <p className="lf-tr-meta lf-tr-tags">
        <CategoryBadge category="PERSONAL" />
        <span className="lf-tr-muted">test:</span> <Chip kind={f?.chip} />
        {!ind.alerting ? <span className="lf-tr-muted">non-alerting (shown, never an alert)</span> : null}
        {cadence !== 'DAILY' ? <span className="lf-tr-muted">daily on the baseline days, then {cadence.toLowerCase()}</span> : null}
        {ENTRY_STEP[ind.variable] ? <a href={`#/noon-sight?step=${ENTRY_STEP[ind.variable]}`}>Enter a reading in Noon Sight</a> : null}
      </p>
      {ind.limit_note?.text ? <LimitNote text={ind.limit_note.text} chip={ind.limit_note.chip} /> : null}
      {ind.context?.text ? (
        <p className="lf-tr-note lf-tr-ctx">
          {ind.context.text} <Chip kind={ind.context.chip} />
        </p>
      ) : null}
      <RuleChips trend={trend} />
      {trend.points.length ? (
        <TimeChart
          x={parts.x}
          lines={parts.lines}
          bands={parts.bands}
          hlines={parts.hlines}
          regions={parts.regions}
          vlines={parts.vlines}
          marks={parts.marks}
          yMin={parts.yMin}
          yMax={parts.yMax}
          xMin={parts.xMin}
          xMax={parts.xMax}
          xFormat={dayLabel}
          yFormat={yFormat}
          height={200}
          ariaLabel={summary}
        />
      ) : (
        <EmptyState kind="missing" title="No values yet" headingLevel={3}>
          <p>This crewmember has no {ind.label ?? ind.id} value up to the scenario clock.</p>
        </EmptyState>
      )}
      {flaggedNow && ind.action ? (
        <p className="lf-tr-action">
          <strong>{ind.action.label}.</strong> {ind.action.text} <Chip kind={ind.action.chip} />
        </p>
      ) : flaggedNow && ind.case_id ? (
        <p className="lf-tr-action">
          A trigger of the case <a href={`#/case/${ind.case_id}`}>{caseTitle(ind.case_id)}</a>: a reliable change in the worse direction
          opens it.
        </p>
      ) : null}
      <FlagSummary trend={trend} note={note} alerting={ind.alerting} />
      <EpisodeNote note={note} trend={trend} crewId={crewId} />
      {f ? (
        <Expander summary="Why this verdict">
          <p>{f.why}</p>
          <p className="lf-tr-muted">
            <a href={`#/provenance?id=${encodeURIComponent(ind.id)}`}>Provenance of this indicator</a> ·{' '}
            <a href="#/method?s=tiers">How the personal band is computed (Method)</a>
          </p>
        </Expander>
      ) : null}
      <Expander summary="Data table">
        <DataTable trend={trend} digits={digits} />
      </Expander>
    </article>
  )
}

function RuleSeriesCard({
  title,
  trend,
  index,
  t,
  shared,
  hourly,
}: {
  title: string
  trend: SeriesTrend
  index: ScenarioIndex
  t: number
  shared?: boolean
  hourly?: boolean
}) {
  const parts = useMemo(() => {
    const p = dailyChart(trend, null, index, t, hourly ? (q) => toDay(q.t) : undefined)
    if (hourly) p.lines = [{ ...p.lines[0], points: 0, width: 1.25 }]
    return p
  }, [trend, index, t, hourly])
  const values = trend.points.map((p) => p.value)
  const digits = digitsFor(trend.unit, values)
  const yFormat = useMemo(() => (v: number) => fmt(v, digits), [digits])
  const last = trend.points[trend.points.length - 1]
  // Findings without a deep case carry a one-line action (D11): the VO2max floor reads "EVA assignment not cleared".
  const actions = trend.rules
    .map((r) => ({ rule: r, f: trend.ruleNow.get(r.id) }))
    .filter((x) => x.f && x.rule.action && (x.f.status === 'outside' || x.f.status === 'approaching'))
  return (
    <article className="lf-tr-card" aria-label={title} data-severity={actions.length ? 'caution' : undefined}>
      <header className="lf-tr-card-head">
        <div>
          <p className="lf-eyebrow">
            <span className="lf-tr-kind" data-kind="historical">
              HISTORICAL · {hourly ? '1-H MEANS' : 'PERIODIC TEST'}
            </span>{' '}
            {shared ? 'vehicle sensor, shared by the crew' : 'this crewmember'}
          </p>
          <h3 className="lf-tr-card-title">{title}</h3>
        </div>
      </header>
      <p className="lf-tr-meta">
        <span>
          Latest <Num value={last?.value ?? null} unit={trend.unit} digits={digits} />
          {last ? (
            <>
              {' '}
              at <MetTime t={last.t} label />
            </>
          ) : null}
        </span>
      </p>
      <RuleChips trend={trend} />
      {actions.map(({ rule, f }) => (
        <p key={rule.id} className="lf-tr-action">
          <SeverityBadge severity={f!.severity} label={rule.action!.label} /> {actionSentence(rule.action!)}{' '}
          <Chip kind={rule.action!.chip} />
        </p>
      ))}
      {trend.points.length ? (
        <TimeChart
          x={parts.x}
          lines={parts.lines}
          hlines={parts.hlines}
          regions={parts.regions}
          vlines={parts.vlines}
          marks={parts.marks}
          yMin={parts.yMin}
          yMax={parts.yMax}
          xMin={parts.xMin}
          xMax={parts.xMax}
          xFormat={dayLabel}
          yFormat={yFormat}
          height={180}
          ariaLabel={`${title}: ${trend.points.length} values; ${trend.points.filter((p) => p.tierA.length).length} marked against a published limit.`}
        />
      ) : (
        <EmptyState kind="missing" title="No values yet" headingLevel={3}>
          <p>No value up to the scenario clock.</p>
        </EmptyState>
      )}
      <FlagSummary trend={trend} />
      <Expander summary="Data table">
        <DataTable trend={trend} digits={digits} />
      </Expander>
    </article>
  )
}

// ---- today's heart rate: per-pixel-column min/max envelope --------------------------------------------

function HeartRate({ index, runtime, crewId, t }: { index: ScenarioIndex; runtime: readonly Observation[]; crewId: CrewId; t: number }) {
  const [cols, setCols] = useState(600)
  const day0 = Math.floor(t / 86_400) * 86_400
  const obs = useMemo(
    () => observationsFor(index, runtime, crewId, 'heart_rate').filter((o) => o.crew_id === crewId && o.t >= day0 && o.t <= t),
    [index, runtime, crewId, day0, t],
  )
  const env = useMemo(
    () =>
      envelope(
        obs.map((o) => o.t),
        obs.map((o) => o.value),
        day0,
        Math.max(t, day0 + 60),
        cols,
      ),
    [obs, day0, t, cols],
  )
  const lines = useMemo<LineSpec[]>(
    () => [
      { label: 'max per column', values: env.max, color: '--lf-text-2', width: 1 },
      { label: 'min per column', values: env.min, color: '--lf-text-2', width: 1 },
    ],
    [env],
  )
  const bands = useMemo(() => [{ upper: 0, lower: 1, fill: 'rgba(209,209,209,0.45)' }], [])
  const vlines = useMemo<VLineSpec[]>(() => [{ x: t, label: 'NOW', color: '--lf-text' }], [t])
  const hhmm = useMemo(
    () => (v: number) => {
      const s = Math.max(0, Math.floor(v - day0))
      return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
    },
    [day0],
  )
  const yFormat = useMemo(() => (v: number) => fmt(v, 0), [])
  const last = obs[obs.length - 1] ?? null
  const step = obs.length > 1 ? obs[obs.length - 1].t - obs[obs.length - 2].t : null
  const overdue = last !== null && step !== null && t - last.t > step
  const vals = obs.map((o) => o.value)
  const lo = vals.length ? Math.min(...vals) : null
  const hi = vals.length ? Math.max(...vals) : null
  const perCol = cols > 0 ? obs.length / cols : 0
  return (
    <Panel
      title="Heart rate today"
      eyebrow={
        <span className="lf-tr-kind" data-kind="live">
          LIVE · 1-MIN · SIMULATED STREAM
        </span>
      }
      footer={
        <span>
          Per-pixel-column min/max envelope: <Num value={obs.length} /> one-minute samples drawn in <Num value={cols} /> columns (
          <Num value={perCol} digits={1} /> per column), so a one-minute spike is never averaged away.
        </span>
      }
    >
      <SimulatedMarker variant="banner">
        Band optical pulse sensor (PPG), 1-min means, MET day {dayLabel(t / 86_400)} from 00:00 to the scenario clock.
      </SimulatedMarker>
      <p className="lf-tr-meta">
        <span>
          Latest <Num value={last?.value ?? null} unit="bpm" />
          {last ? (
            <>
              {' '}
              at <MetTime t={last.t} label />
            </>
          ) : null}
        </span>
        <span>
          Today’s range <Num value={lo} />–<Num value={hi} unit="bpm" />
        </span>
        {overdue && last ? (
          <span className="lf-tr-nodata">
            <StaleIcon size={13} /> No new sample since <MetTime t={last.t} label />: the simulated stream ends at the scenario’s “now”.
          </span>
        ) : null}
      </p>
      {obs.length ? (
        <TimeChart
          x={env.x}
          lines={lines}
          bands={bands}
          vlines={vlines}
          xMin={day0}
          xMax={Math.max(t, day0 + 60)}
          xFormat={hhmm}
          yFormat={yFormat}
          height={200}
          onPlotWidth={(w) => setCols((c) => (Math.abs(c - Math.round(w)) >= 2 ? Math.max(30, Math.round(w)) : c))}
          ariaLabel={`Heart rate today for ${crewId}: ${obs.length} one-minute values from 00:00 to now, range ${lo ?? '—'} to ${hi ?? '—'} bpm.`}
        />
      ) : (
        <EmptyState kind="missing" title="No heart-rate stream" headingLevel={3}>
          <p>No 1-min heart rate for this crewmember today, up to the scenario clock.</p>
        </EmptyState>
      )}
      <p className="lf-tr-muted">
        Heart rate is shown, not judged: NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert
        requirements leave the number to the program. The personal resting-HR indicator above uses the lowest stable 5-minute heart
        rate of the night instead.
      </p>
    </Panel>
  )
}

// ---- page ----------------------------------------------------------------------------------------------

export default function Trends({ query }: FeatureProps) {
  const { state, setCrew } = useMission()
  const scenario = useScenario()
  const { t, envId, error: evalError } = useEvaluation()
  const crewId = state.crewId
  const crewEval = useCrewEvaluation(crewId)
  const runtime = state.observations
  const index = scenario.index
  const simData = scenario.sim.data

  const qCrew = query.crew
  useEffect(() => {
    if (isCrewId(qCrew) && qCrew !== state.crewId) setCrew(qCrew)
    // only when the query changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qCrew])

  const { charted, privateOnes } = useMemo(() => chartedIndicators(), [])
  const trends = useMemo(() => {
    if (!index) return []
    return charted.map((ind) => buildIndicatorTrend(ind, index, runtime, crewId, envId as EnvId, t))
  }, [index, runtime, crewId, envId, t, charted])
  const vo2 = useMemo(() => (index ? buildRuleSeries('vo2max', 'ml/min/kg', index, runtime, crewId, envId as EnvId, t) : null), [index, runtime, crewId, envId, t])
  const co2 = useMemo(() => (index ? buildRuleSeries('cabin_ppco2', 'mmHg', index, runtime, null, envId as EnvId, t) : null), [index, runtime, envId, t])

  if (!index) {
    const st = scenario.status
    return (
      <>
        <h1>Trends</h1>
        <EmptyState kind={st === 'error' ? 'error' : st === 'missing' ? 'missing' : 'loading'} title={st === 'loading' ? 'Reading the frozen scenario' : 'The scenario could not be read'}>
          <p>{scenario.error ?? 'The simulated scenario (sim_crew.json) is loading from this build.'}</p>
        </EmptyState>
      </>
    )
  }

  const member = CREW.find((c) => c.id === crewId)
  const env = environment(envId as EnvId)
  const days = observationDay(t) - index.baselineDays[1]
  const tierBNow = new Map((crewEval?.tierB ?? []).map((e) => [e.indicator.id, e]))
  const rci = RULES.personal?.rci as { source?: Record<string, unknown>; detectable_change?: { text?: string; chip?: string } } | undefined
  return (
    <div className="lf-tr">
      <h1>Trends</h1>
      <p className="lf-tr-lead">
        Each indicator of <strong>{crewId}</strong> ({member?.role}) over MET days {index.firstDay}–{dayLabel(observationDay(t))}, against
        their own baseline (days {index.baselineDays[0]}–{index.baselineDays[1]}). Limits apply for <strong>{env.label}</strong>. A flag
        is the engine’s verdict for that day, not a diagnosis.
      </p>
      <SimulatedMarker variant="banner">Every crew value on this page is simulated (seeded generator, sim_crew.json); limits and statistics are real.</SimulatedMarker>
      <CrewPicker crewId={crewId} onPick={setCrew} />
      {evalError ? (
        <p className="lf-tr-nodata lf-tr-banner" role="status">
          <StaleIcon size={14} /> The mission evaluation is unavailable right now ({evalError}). Values are drawn; verdicts the engine could not
          give are marked in place.
        </p>
      ) : null}

      <Panel title="How to read a personal band" eyebrow="Tier B · own baseline" className="lf-tr-fa">
        <div className="lf-tr-legend-row">
          <span>
            <Glyph shape="band" token="--lf-text-2" /> personal band (baseline mean ± critical × scale, from the engine)
          </span>
          <span>
            <SeverityIcon severity="caution" size={14} /> reliable change, worse direction (caution)
          </span>
          <span>
            <Glyph shape="diamond" token="--lf-text-2" /> same, on a non-alerting indicator (shown, never an alert)
          </span>
          <span>
            <Glyph shape="diamond" token="--lf-text" hollow /> reliable change in the other direction (no alert)
          </span>
          <span>
            <Glyph shape="square" token="--lf-sev-caution" /> published limit or target not met (Tier A)
          </span>
          <span>
            <Glyph shape="line" token="--lf-border-strong" /> limit that applies here
          </span>
          <span>
            <Glyph shape="dash" token="--lf-data-unavailable" /> limit for another environment (gray)
          </span>
        </div>
        {rci?.detectable_change?.text ? (
          <p className="lf-tr-fa-text">
            <strong>What a band can see.</strong> {rci.detectable_change.text} <Chip kind={rci.detectable_change.chip} /> Each card prints
            that figure for this crewmember, and the same at the simulator’s noise SD (literature where a value was found, otherwise a design
            choice, as its chip says). A band edge below zero for a quantity that cannot be negative is drawn at 0.
          </p>
        ) : null}
        <FalseAlarms k={alertingIndicatorCount()} kEither={alertingEitherCount()} days={days} crewSize={CREW_IDS.length} />
        <p className="lf-tr-muted">
          Method and its basis: <Citation source={rci?.source} />. See <a href="#/method?s=tiers">Method</a> for the derivation.
        </p>
      </Panel>

      <section aria-labelledby="tr-personal-h">
        <h2 id="tr-personal-h" className="lf-tr-h2">
          Personal indicators
        </h2>
        <div className="lf-tr-grid">
          {trends.map((tr) => (
            <IndicatorCard key={tr.indicator.id} trend={tr} now={tierBNow.get(tr.indicator.id) ?? null} index={index} t={t} crewId={crewId} simData={simData} />
          ))}
          {privateOnes.map((ind) => (
            <article key={ind.id} className="lf-tr-card lf-tr-private" aria-labelledby={`tr-${ind.id}`}>
              <p className="lf-eyebrow">Private · never alerts</p>
              <h3 id={`tr-${ind.id}`} className="lf-tr-card-title">
                {ind.label ?? ind.id}
              </h3>
              <p>
                Not charted here. {ind.label ?? ind.id} is the crewmember’s own self-report: it is private by default, never raises an alert and
                leaves the vehicle only with their consent (<a href="#/downlink">Downlink</a>). LANDFALL makes no psychiatric judgement.
              </p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="tr-tiera-h">
        <h2 id="tr-tiera-h" className="lf-tr-h2">
          Published limits on the same timeline
        </h2>
        <div className="lf-tr-grid">
          {vo2 ? <RuleSeriesCard title="VO2max (periodic fitness test): the EVA fitness tag" trend={vo2} index={index} t={t} /> : null}
          {co2 ? <RuleSeriesCard title="Cabin ppCO2, 1-hour mean" trend={co2} index={index} t={t} shared hourly /> : null}
        </div>
      </section>

      <HeartRate index={index} runtime={runtime} crewId={crewId} t={t} />
    </div>
  )
}
