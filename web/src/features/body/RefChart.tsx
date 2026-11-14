// Inspiration4 (OSDR) small multiples: one panel per crew subject, seven timepoints
// (L-92, L-44, L-3 | flight | R+1 ... R+194), each value drawn against the reference range the
// laboratory printed for THAT sample (ranges change within a subject, so they are drawn per
// timepoint, never collapsed). A value outside its own range is an observation, not an alert:
// it gets a different shape and text, never an alert colour. Research assays with no published
// range show the subject's own pre-flight span instead, labelled as derived.
import { formatNumber } from '../../ui'

export interface OsdrTimepoint {
  label: string
  day_offset: number
  anchor: 'launch' | 'return' | string
}

export interface OsdrRange {
  min: number | null
  max: number | null
}

export interface OsdrAnalyte {
  key: string
  label: string
  unit: string
  panel?: string
  values: Record<string, Record<string, number | null>>
  ranges: Record<string, Record<string, OsdrRange | null>> | null
}

export interface OsdrData {
  subjects: string[]
  subject_sex_as_recorded?: Record<string, string>
  timepoints: OsdrTimepoint[]
  analytes: OsdrAnalyte[]
}

/** Per-sample band: the lab's printed range, or (no range published) the own pre-flight span. */
export function bandFor(
  analyte: OsdrAnalyte,
  subject: string,
  timepoints: readonly OsdrTimepoint[],
): { kind: 'lab' | 'preflight' | 'none'; ranges: Array<OsdrRange | null> } {
  if (analyte.ranges && analyte.ranges[subject]) {
    return { kind: 'lab', ranges: timepoints.map((tp) => analyte.ranges?.[subject]?.[tp.label] ?? null) }
  }
  const pre = timepoints
    .filter((tp) => tp.anchor === 'launch')
    .map((tp) => analyte.values[subject]?.[tp.label])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (pre.length < 2) return { kind: 'none', ranges: timepoints.map(() => null) }
  const span = { min: Math.min(...pre), max: Math.max(...pre) }
  return { kind: 'preflight', ranges: timepoints.map(() => span) }
}

/** Inclusive; one-sided ranges compare one bound (same rule as the snapshot's within_own_range). */
export function outsideRange(value: number, range: OsdrRange | null): boolean {
  if (!range) return false
  if (range.min !== null && value < range.min) return true
  if (range.max !== null && value > range.max) return true
  return false
}

function niceDomain(analyte: OsdrAnalyte, subjects: readonly string[], timepoints: readonly OsdrTimepoint[]): [number, number] {
  const xs: number[] = []
  for (const s of subjects) {
    for (const tp of timepoints) {
      const v = analyte.values[s]?.[tp.label]
      if (typeof v === 'number' && Number.isFinite(v)) xs.push(v)
      const r = analyte.ranges?.[s]?.[tp.label]
      if (r?.min != null) xs.push(r.min)
      if (r?.max != null) xs.push(r.max)
    }
  }
  if (!xs.length) return [0, 1]
  let lo = Math.min(...xs)
  let hi = Math.max(...xs)
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.08
  // Counts and concentrations cannot be negative: never draw an axis below zero for them.
  return [lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad]
}

function digitsFor(lo: number, hi: number): number {
  const span = Math.abs(hi - lo)
  if (span >= 100) return 0
  if (span >= 10) return 0
  if (span >= 1) return 1
  return 2
}

const W = 168
const H = 104
const PAD_L = 34
const PAD_R = 6
const PAD_T = 8
const PAD_B = 18

/** Legend shared by every small multiple of one snapshot (shown once per panel). */
export function SmallMultiplesLegend({ kind }: { kind: 'lab' | 'preflight' | 'none' }) {
  return (
    <p className="lf-sm-legend">
      {kind === 'lab' ? (
        <>
          <span className="lf-sm-key lf-sm-key-band" aria-hidden="true" /> range the lab printed for that sample ·{' '}
          <span className="lf-sm-key lf-sm-key-pt" aria-hidden="true" /> within ·{' '}
          <span className="lf-sm-key lf-sm-key-out" aria-hidden="true" /> outside its own range (an observation, not an alert) ·{' '}
          <span className="lf-sm-key-x" aria-hidden="true">×</span> no sample
        </>
      ) : (
        <>
          <span className="lf-sm-key lf-sm-key-band" data-kind="preflight" aria-hidden="true" /> no reference range is published
          for this research assay: the dashed band is the subject’s own pre-flight span (derived: min–max of the three L- samples) ·{' '}
          <span className="lf-sm-key-x" aria-hidden="true">×</span> no sample
        </>
      )}
    </p>
  )
}

export function bandKindOf(analyte: OsdrAnalyte, data: OsdrData): 'lab' | 'preflight' | 'none' {
  return bandFor(analyte, data.subjects[0], data.timepoints).kind
}

export function SmallMultiples({ data, analyte, why }: { data: OsdrData; analyte: OsdrAnalyte; why: string }) {
  const tps = data.timepoints
  const [lo, hi] = niceDomain(analyte, data.subjects, tps)
  const d = digitsFor(lo, hi)
  const plotW = W - PAD_L - PAD_R
  const plotH = H - PAD_T - PAD_B
  const n = tps.length
  const flightAt = tps.findIndex((tp) => tp.anchor === 'return')
  // Equal spacing per timepoint, with an extra slot for the flight gap.
  const slots = n + (flightAt > 0 ? 1 : 0)
  const step = plotW / slots
  const xOf = (i: number) => PAD_L + step * (i + 0.5 + (flightAt > 0 && i >= flightAt ? 1 : 0))
  const yOf = (v: number) => PAD_T + plotH - ((v - lo) / (hi - lo)) * plotH
  const clampY = (v: number) => Math.min(PAD_T + plotH, Math.max(PAD_T, yOf(v)))

  return (
    <figure className="lf-sm">
      <figcaption className="lf-sm-head">
        <span className="lf-sm-title">{analyte.label}</span>
        <span className="lf-num-unit lf-mono">{analyte.unit}</span>
        <span className="lf-sm-why">{why}</span>
      </figcaption>
      <div className="lf-sm-row">
        {data.subjects.map((s) => {
          const band = bandFor(analyte, s, tps)
          const vals = tps.map((tp) => analyte.values[s]?.[tp.label] ?? null)
          const outs = vals.map((v, i) => (v === null ? false : band.kind === 'lab' && outsideRange(v, band.ranges[i])))
          const nOut = outs.filter(Boolean).length
          const nMissing = vals.filter((v) => v === null).length
          const sex = data.subject_sex_as_recorded?.[s]
          const label =
            `${analyte.label}, subject ${s}: ` +
            vals.map((v, i) => `${tps[i].label} ${v === null ? 'no sample' : `${formatNumber(v)}${outs[i] ? ' (outside own range)' : ''}`}`).join(', ')
          const pre = vals.map((v, i) => ({ v, i })).filter((p) => p.v !== null && tps[p.i].anchor === 'launch')
          const post = vals.map((v, i) => ({ v, i })).filter((p) => p.v !== null && tps[p.i].anchor !== 'launch')
          const line = (pts: Array<{ v: number | null; i: number }>) =>
            pts.map((p, k) => `${k ? 'L' : 'M'}${xOf(p.i).toFixed(1)} ${yOf(p.v as number).toFixed(1)}`).join(' ')
          return (
            <div className="lf-sm-cell" key={s}>
              <p className="lf-sm-subject">
                <span className="lf-mono">{s}</span>
                {sex ? <span className="lf-sm-sex"> · {sex} as recorded</span> : null}
              </p>
              <svg viewBox={`0 0 ${W} ${H}`} className="lf-sm-svg" role="img" aria-label={label}>
                {/* plot frame + y labels */}
                <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + plotH} y2={PAD_T + plotH} className="lf-sm-axis" />
                <text x={PAD_L - 4} y={PAD_T + 4} className="lf-sm-tick" textAnchor="end">
                  {formatNumber(hi, d)}
                </text>
                <text x={PAD_L - 4} y={PAD_T + plotH} className="lf-sm-tick" textAnchor="end">
                  {formatNumber(lo, d)}
                </text>
                {/* reference band, one column per sample */}
                {band.ranges.map((r, i) => {
                  if (!r) return null
                  const top = r.max === null ? PAD_T : clampY(r.max)
                  const bot = r.min === null ? PAD_T + plotH : clampY(r.min)
                  return (
                    <rect
                      key={tps[i].label}
                      x={xOf(i) - step / 2}
                      width={step}
                      y={top}
                      height={Math.max(0, bot - top)}
                      className="lf-sm-band"
                      data-kind={band.kind}
                    />
                  )
                })}
                {/* flight gap */}
                {flightAt > 0 ? (
                  <g className="lf-sm-flight">
                    <line x1={PAD_L + step * (flightAt + 0.5)} x2={PAD_L + step * (flightAt + 0.5)} y1={PAD_T} y2={PAD_T + plotH} />
                    <text x={PAD_L + step * (flightAt + 0.5)} y={H - 5} textAnchor="middle">
                      flight
                    </text>
                  </g>
                ) : null}
                <text x={xOf(0)} y={H - 5} className="lf-sm-tick" textAnchor="start" dx={-step / 2}>
                  {tps[0]?.label}
                </text>
                <text x={xOf(n - 1)} y={H - 5} className="lf-sm-tick" textAnchor="end" dx={step / 2}>
                  {tps[n - 1]?.label}
                </text>
                {/* series */}
                {pre.length > 1 ? <path d={line(pre)} className="lf-sm-line" /> : null}
                {post.length > 1 ? <path d={line(post)} className="lf-sm-line" /> : null}
                {pre.length && post.length ? (
                  <path
                    d={`M${xOf(pre[pre.length - 1].i).toFixed(1)} ${yOf(pre[pre.length - 1].v as number).toFixed(1)} L${xOf(post[0].i).toFixed(1)} ${yOf(post[0].v as number).toFixed(1)}`}
                    className="lf-sm-line lf-sm-gapline"
                  />
                ) : null}
                {vals.map((v, i) =>
                  v === null ? (
                    <text key={i} x={xOf(i)} y={PAD_T + plotH - 3} textAnchor="middle" className="lf-sm-missing">
                      ×
                    </text>
                  ) : outs[i] ? (
                    <rect
                      key={i}
                      x={xOf(i) - 3.6}
                      y={yOf(v) - 3.6}
                      width="7.2"
                      height="7.2"
                      transform={`rotate(45 ${xOf(i)} ${yOf(v)})`}
                      className="lf-sm-pt lf-sm-pt-out"
                    />
                  ) : (
                    <circle key={i} cx={xOf(i)} cy={yOf(v)} r="3" className="lf-sm-pt" />
                  ),
                )}
              </svg>
              <p className="lf-sm-note">
                {band.kind !== 'lab' ? (
                  <span>no lab range published</span>
                ) : nOut ? (
                  <span className="lf-sm-out">
                    <span className="lf-mono">{nOut}</span> outside own range
                  </span>
                ) : (
                  <span>all within own range</span>
                )}
                {nMissing ? (
                  <span className="lf-sm-miss">
                    {' '}
                    · <span className="lf-mono">{nMissing}</span> missing
                  </span>
                ) : null}
              </p>
            </div>
          )
        })}
      </div>
    </figure>
  )
}
