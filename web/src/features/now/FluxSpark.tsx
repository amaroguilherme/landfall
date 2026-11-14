// Onboard proton monitor sparkline (uPlot, lazy-loaded so the hero bundle stays light).
// Log axis; the series is neutral grey, only the samples at or above the case threshold are drawn
// in the finding's severity colour; NOAA S1-S5 levels (from the rules) are faint reference lines;
// a dashed marker shows when LANDFALL opened the case. Colours are read from the design tokens.
import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { formatMet } from '../../app/engine'
import type { Severity } from '../../app/vocab'
import { logRange } from './model'
import type { FluxSeries } from './model'

export interface FluxSparkProps {
  series: FluxSeries
  /** x range [from, to] in MET seconds (to = the clock). */
  from: number
  to: number
  /** The case threshold (the active OPS rule's limit), pfu. */
  threshold: number | null
  thresholdLabel: string | null
  /** NOAA S-levels drawn as faint reference lines. */
  levels: Array<{ level: number; limit: number }>
  /** MET when the case opened (marker), if inside the window. */
  openedAt: number | null
  severity: Severity
  height?: number
}

function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

/** Axis label: "0.01", "1", "100", "10K" (compact notation; no threshold is typed here). */
function fmtFlux(v: number): string {
  return COMPACT.format(v)
}

export default function FluxSpark(props: FluxSparkProps) {
  const wrap = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const live = useRef(props)
  live.current = props
  const height = props.height ?? 132

  // Build once; later renders only push data and redraw.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const mono = token('--lf-font-mono', 'monospace')
    const c = {
      series: token('--lf-text-2', '#d1d1d1'),
      over: token(props.severity === 'warning' || props.severity === 'emergency' ? '--lf-sev-warning' : '--lf-sev-caution', '#ffd23f'),
      grid: token('--lf-border-subtle', '#444447'),
      ref: token('--lf-border', '#58585b'),
      threshold: token('--lf-border-strong', '#b9b9bb'),
      muted: token('--lf-text-muted', '#b9b9bb'),
      text: token('--lf-text', '#ffffff'),
    }
    const font = `400 11px ${mono}`
    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height,
      legend: { show: false },
      cursor: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      padding: [10, 8, 0, 0],
      scales: {
        x: { time: false, range: () => [live.current.from, live.current.to] },
        y: {
          distr: 3,
          log: 10,
          range: () => logRange(live.current.series.ys, live.current.threshold),
        },
      },
      axes: [
        {
          stroke: c.muted,
          font,
          size: 22,
          gap: 4,
          ticks: { show: false },
          grid: { show: false },
          splits: (_u, _i, min, max) => {
            const step = 7200
            const out: number[] = []
            for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v)
            return out
          },
          values: (_u, splits) => splits.map((v) => formatMet(v).slice(5, 10)),
        },
        {
          stroke: c.muted,
          font,
          size: 40,
          gap: 4,
          ticks: { show: false },
          grid: { stroke: c.grid, width: 1 },
          splits: (u) => {
            const min = u.scales.y.min ?? 0.1
            const max = u.scales.y.max ?? 10
            const out: number[] = []
            for (let e = Math.round(Math.log10(min)); e <= Math.round(Math.log10(max)); e += 2) out.push(10 ** e)
            return out
          },
          // Keep every split (uPlot's default log filter blanks alternate decades).
          filter: (_u, splits) => splits,
          values: (_u, splits) => splits.map((v) => (v === null || v === undefined ? '' : fmtFlux(v))),
        },
      ],
      series: [
        {},
        { stroke: c.series, width: 1.5, points: { show: false }, spanGaps: false },
        { stroke: c.over, width: 3, points: { show: false }, spanGaps: false },
      ],
      hooks: {
        draw: [
          (u) => {
            const p = live.current
            const ctx = u.ctx
            const { left, top, width, height: h } = u.bbox
            const r = uPlot.pxRatio
            ctx.save()
            ctx.font = `400 ${10 * r}px ${mono}`
            ctx.textBaseline = 'bottom'
            // NOAA S-levels (faint), labelled at the right edge.
            for (const l of p.levels) {
              if (u.scales.y.min === undefined || u.scales.y.max === undefined) break
              if (l.limit < u.scales.y.min || l.limit > u.scales.y.max) continue
              const y = Math.round(u.valToPos(l.limit, 'y', true)) + 0.5
              const isThreshold = p.threshold !== null && l.limit === p.threshold
              ctx.strokeStyle = isThreshold ? c.threshold : c.ref
              ctx.lineWidth = r
              ctx.setLineDash(isThreshold ? [6 * r, 4 * r] : [2 * r, 4 * r])
              ctx.beginPath()
              ctx.moveTo(left, y)
              ctx.lineTo(left + width, y)
              ctx.stroke()
              ctx.fillStyle = isThreshold ? c.text : c.muted
              // Every level is labelled at the left edge: the "case opened" marker sits a few minutes
              // before the right edge, so right-aligned labels were crossed by it.
              ctx.textAlign = 'left'
              ctx.fillText(isThreshold ? (p.thresholdLabel ?? `S${l.level}`) : `S${l.level}`, left + 4 * r, y - 2 * r)
            }
            // A case threshold that is not a NOAA level line (none today) still gets its line.
            if (p.threshold !== null && !p.levels.some((l) => l.limit === p.threshold) && u.scales.y.min !== undefined) {
              const y = Math.round(u.valToPos(p.threshold, 'y', true)) + 0.5
              ctx.strokeStyle = c.threshold
              ctx.setLineDash([6 * r, 4 * r])
              ctx.beginPath()
              ctx.moveTo(left, y)
              ctx.lineTo(left + width, y)
              ctx.stroke()
              ctx.fillStyle = c.text
              ctx.textAlign = 'left'
              ctx.fillText(p.thresholdLabel ?? '', left + 4 * r, y - 2 * r)
            }
            // When LANDFALL opened the case.
            if (p.openedAt !== null && p.openedAt >= p.from && p.openedAt <= p.to) {
              const x = Math.round(u.valToPos(p.openedAt, 'x', true)) + 0.5
              ctx.strokeStyle = c.text
              ctx.lineWidth = r
              ctx.setLineDash([3 * r, 3 * r])
              ctx.beginPath()
              ctx.moveTo(x, top)
              ctx.lineTo(x, top + h)
              ctx.stroke()
              ctx.fillStyle = c.text
              ctx.textAlign = 'right'
              ctx.textBaseline = 'top'
              ctx.fillText('case opened', x - 4 * r, top + 2 * r)
            }
            ctx.restore()
          },
        ],
      },
    }
    const s = live.current.series
    const u = new uPlot(opts, [s.xs, s.ys, s.over] as uPlot.AlignedData, el)
    plot.current = u
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => u.setSize({ width: Math.max(200, el.clientWidth), height })) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      u.destroy()
      plot.current = null
    }
    // The plot is built once per severity/height; data changes go through setData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.severity, height])

  useEffect(() => {
    const s = props.series
    plot.current?.setData([s.xs, s.ys, s.over] as uPlot.AlignedData)
  }, [props.series, props.from, props.to, props.threshold, props.openedAt])

  return <div ref={wrap} className="now-spark-canvas" style={{ height }} />
}
