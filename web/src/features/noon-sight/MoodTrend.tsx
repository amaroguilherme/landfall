// Mood against the crewmember's OWN baseline. Deliberately neutral: grey marks, a solid (not
// dashed, which reads as a threshold) baseline reference, no severity colour, no alert. Mood is
// private and non-alerting (engine/SPEC.md sections 3.3 and 7).
import { useId, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Expander } from '../../ui'

export interface MoodPoint {
  day: number
  v: number
  origin: 'simulated' | 'session'
}

const W = 320
const H = 104
const PAD = { l: 22, r: 84, t: 10, b: 22 }

export function MoodTrend({
  points,
  baseline,
  baselineDays,
  today,
}: {
  points: MoodPoint[]
  baseline: { mean: number | null; n: number }
  baselineDays: [number, number]
  today: number
}) {
  const titleId = useId()
  const [hover, setHover] = useState<MoodPoint | null>(null)
  const first = today - 13
  const x = (day: number) => PAD.l + ((day - first) / 13) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + ((5 - v) / 4) * (H - PAD.t - PAD.b)
  const sorted = [...points].sort((a, b) => a.day - b.day)
  const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const mean = baseline.mean

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    let best: MoodPoint | null = null
    for (const p of sorted) if (!best || Math.abs(x(p.day) - px) < Math.abs(x(best.day) - px)) best = p
    setHover(best)
  }

  const summary =
    sorted.length === 0
      ? 'No mood entries in the last 14 MET days.'
      : `Mood, MET days ${first} to ${today}: ${sorted.map((p) => `day ${p.day} ${p.v}`).join(', ')}.` +
        (mean !== null ? ` Your baseline mean is ${mean.toFixed(1)}.` : '')

  return (
    <figure className="ns-trend">
      <figcaption id={titleId} className="ns-trend-cap">
        Your mood, last 14 MET days <span className="ns-muted">(1 very low to 5 very good)</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="ns-trend-svg"
        role="img"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-d`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[1, 3, 5].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="ns-trend-grid" />
            <text x={PAD.l - 8} y={y(v) + 3.5} className="ns-trend-tick" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {mean !== null ? (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(mean)} y2={y(mean)} className="ns-trend-base" />
            <text x={W - PAD.r + 6} y={y(mean) + 3.5} className="ns-trend-label">
              baseline {mean.toFixed(1)}
            </text>
          </g>
        ) : null}
        {hover ? <line x1={x(hover.day)} x2={x(hover.day)} y1={PAD.t} y2={H - PAD.b} className="ns-trend-cross" /> : null}
        {path ? <path d={path} className="ns-trend-line" /> : null}
        {sorted.map((p) => (
          <circle
            key={p.day}
            cx={x(p.day)}
            cy={y(p.v)}
            r={p.day === today ? 5.5 : 4}
            className="ns-trend-dot"
            data-today={p.day === today || undefined}
            data-session={p.origin === 'session' || undefined}
          />
        ))}
        <text x={PAD.l} y={H - 6} className="ns-trend-tick">
          {first}
        </text>
        <text x={W - PAD.r} y={H - 6} className="ns-trend-tick" textAnchor="end">
          {today} today
        </text>
      </svg>
      <p id={`${titleId}-d`} className="sr-only">
        {summary}
      </p>
      <p className="ns-trend-readout" aria-hidden="true">
        {hover ? (
          <>
            MET day <span className="lf-num">{hover.day}</span>: <span className="lf-num">{hover.v}</span>
            {hover.origin === 'session' ? ' (entered by you)' : ' (simulated)'}
          </>
        ) : (
          <>
            Baseline: MET days <span className="lf-num">{baselineDays[0]}</span>–<span className="lf-num">{baselineDays[1]}</span>,{' '}
            <span className="lf-num">n = {baseline.n}</span>. Point at the chart for a value.
          </>
        )}
      </p>
      <Expander summary="Show the values">
        <table className="ns-table">
          <thead>
            <tr>
              <th scope="col">MET day</th>
              <th scope="col" className="num">
                Mood
              </th>
              <th scope="col">Entered</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.day}>
                <td className="num">{p.day}</td>
                <td className="num">{p.v}</td>
                <td>{p.origin === 'session' ? 'by you, this session' : 'simulated record'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Expander>
    </figure>
  )
}
