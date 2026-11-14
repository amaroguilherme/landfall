// Thin uPlot wrapper shared by #/trends and #/radiation (both lazy chunks; uPlot never reaches the hero).
// Every colour is a token from src/styles/tokens.css, resolved at draw time, so the Appendix F
// semantics stay in one place: severity colours only for out-of-limit marks, cyan for stale data,
// neutral greys for series. Overlays (limit lines, regions, markers) are drawn on the canvas with a
// text label each; the HTML around every chart repeats them in words (colour is never the only cue).
import { useEffect, useLayoutEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { Severity } from '../../app/vocab'

export type Shape = 'circle' | 'triangle' | 'octagon' | 'diamond' | 'square'

export interface LineSpec {
  label: string
  values: ReadonlyArray<number | null>
  /** A token ("--lf-text-2") or a CSS colour. */
  color: string
  width?: number
  dash?: number[]
  /** Point size in CSS px (0 or undefined = no points). */
  points?: number
  spanGaps?: boolean
}

/** Fill between two lines (indices into `lines`). */
export interface BandSpec {
  upper: number
  lower: number
  fill: string
}

export interface HLineSpec {
  y: number
  label: string
  /** Used instead of `label` when the plot is too narrow for it. */
  short?: string
  color: string
  dash?: number[]
  width?: number
}

export interface RegionSpec {
  x0: number
  x1: number
  label?: string
  fill: string
}

export interface VLineSpec {
  x: number
  label: string
  color: string
  dash?: number[]
  /** Where the label sits along the line (default top). */
  labelAt?: 'top' | 'bottom'
}

export interface MarkSpec {
  x: number
  y: number
  shape: Shape
  color: string
  size?: number
  hollow?: boolean
  /** Short canvas label (also repeated in the HTML list under the chart). */
  label?: string
}

export interface TimeChartProps {
  x: ReadonlyArray<number>
  lines: LineSpec[]
  bands?: BandSpec[]
  hlines?: HLineSpec[]
  regions?: RegionSpec[]
  vlines?: VLineSpec[]
  marks?: MarkSpec[]
  yLog?: boolean
  yMin?: number
  yMax?: number
  xMin?: number
  xMax?: number
  height?: number
  xFormat?: (v: number) => string
  yFormat?: (v: number) => string
  /** Text alternative (role="img"); a data table is offered next to every chart as well. */
  ariaLabel: string
  /** Width of the plotting area in CSS px (for per-pixel-column downsampling). */
  onPlotWidth?: (cssPx: number) => void
}

/** Appendix F shape per severity, matching <SeverityIcon>: circle advisory, triangle caution, octagon warning. */
export function shapeFor(severity: Severity): Shape {
  if (severity === 'warning' || severity === 'emergency') return 'octagon'
  if (severity === 'caution') return 'triangle'
  if (severity === 'advisory') return 'circle'
  return 'diamond'
}

/** Severity token: red only for warning, yellow caution, blue advisory, neutral otherwise. */
export function severityToken(severity: Severity): string {
  if (severity === 'warning' || severity === 'emergency') return '--lf-sev-warning'
  if (severity === 'caution') return '--lf-sev-caution'
  if (severity === 'advisory') return '--lf-sev-advisory'
  return '--lf-text-2'
}

const colourCache = new Map<string, string>()

/** Resolve "--token" to its computed value (cached); any other string is returned as is. */
export function colour(c: string): string {
  if (!c.startsWith('--')) return c
  const hit = colourCache.get(c)
  if (hit) return hit
  if (typeof document === 'undefined') return '#d1d1d1'
  const v = getComputedStyle(document.documentElement).getPropertyValue(c).trim()
  if (v) colourCache.set(c, v)
  return v || '#d1d1d1'
}

function pathShape(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, r: number): void {
  ctx.beginPath()
  switch (shape) {
    case 'circle':
      ctx.arc(x, y, r, 0, Math.PI * 2)
      break
    case 'triangle':
      ctx.moveTo(x, y - r * 1.15)
      ctx.lineTo(x + r * 1.1, y + r * 0.85)
      ctx.lineTo(x - r * 1.1, y + r * 0.85)
      ctx.closePath()
      break
    case 'octagon':
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + (i * Math.PI) / 4
        const px = x + r * Math.cos(a)
        const py = y + r * Math.sin(a)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.closePath()
      break
    case 'square':
      ctx.rect(x - r, y - r, 2 * r, 2 * r)
      break
    default:
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r, y)
      ctx.lineTo(x, y + r)
      ctx.lineTo(x - r, y)
      ctx.closePath()
  }
}

/** A text label on a dark plate (contrast stays above 6:1 whatever is drawn underneath). */
function plateText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fg: string, pr: number, align: 'left' | 'right' = 'left'): void {
  ctx.font = `${Math.round(11 * pr)}px "DM Mono", ui-monospace, monospace`
  const w = ctx.measureText(text).width
  const h = 14 * pr
  const pad = 3 * pr
  const x0 = align === 'right' ? x - w - 2 * pad : x
  ctx.fillStyle = colour('--lf-bg')
  ctx.globalAlpha = 0.88
  ctx.fillRect(x0, y - h + 2 * pr, w + 2 * pad, h)
  ctx.globalAlpha = 1
  ctx.fillStyle = fg
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillText(text, x0 + pad, y - 1 * pr)
}

function drawRegions(u: uPlot, p: TimeChartProps): void {
  if (!p.regions?.length) return
  const ctx = u.ctx
  const { left, top, width, height } = u.bbox
  const pr = uPlot.pxRatio
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, width, height)
  ctx.clip()
  for (const r of p.regions) {
    const x0 = Math.max(left, u.valToPos(r.x0, 'x', true))
    const x1 = Math.min(left + width, u.valToPos(r.x1, 'x', true))
    if (!(x1 > x0)) continue
    ctx.fillStyle = colour(r.fill)
    ctx.fillRect(x0, top, x1 - x0, height)
    if (r.label) plateText(ctx, r.label, x0 + 4 * pr, top + 16 * pr, colour('--lf-text-muted'), pr)
  }
  ctx.restore()
}

function drawOverlays(u: uPlot, p: TimeChartProps): void {
  const ctx = u.ctx
  const { left, top, width, height } = u.bbox
  const pr = uPlot.pxRatio
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, width, height)
  ctx.clip()
  // Limit labels end before a vertical marker (NOW) that sits in the right third of the plot.
  let labelRight = left + width - 4 * pr
  for (const v of p.vlines ?? []) {
    const vx = u.valToPos(v.x, 'x', true)
    if (Number.isFinite(vx) && vx > left + width * 0.66 && vx - 6 * pr < labelRight) labelRight = vx - 6 * pr
  }
  for (const h of p.hlines ?? []) {
    const y = u.valToPos(h.y, 'y', true)
    if (!Number.isFinite(y) || y < top - 1 || y > top + height + 1) continue
    const c = colour(h.color)
    ctx.strokeStyle = c
    ctx.lineWidth = (h.width ?? 1.5) * pr
    ctx.setLineDash((h.dash ?? []).map((d) => d * pr))
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(left + width, y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.font = `${Math.round(11 * pr)}px "DM Mono", ui-monospace, monospace`
    const fits = ctx.measureText(h.label).width < (labelRight - left) * 0.6
    plateText(ctx, fits || !h.short ? h.label : h.short, labelRight, y - 3 * pr, c, pr, 'right')
  }
  for (const v of p.vlines ?? []) {
    const x = u.valToPos(v.x, 'x', true)
    if (!Number.isFinite(x) || x < left - 1 || x > left + width + 1) continue
    const c = colour(v.color)
    ctx.strokeStyle = c
    ctx.lineWidth = 1.5 * pr
    ctx.setLineDash((v.dash ?? [4, 3]).map((d) => d * pr))
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + height)
    ctx.stroke()
    ctx.setLineDash([])
    const right = x > left + width * 0.7
    const ly = v.labelAt === 'bottom' ? top + height - 6 * pr : top + 16 * pr
    plateText(ctx, v.label, right ? x - 4 * pr : x + 4 * pr, ly, c, pr, right ? 'right' : 'left')
  }
  for (const m of p.marks ?? []) {
    const x = u.valToPos(m.x, 'x', true)
    const y = u.valToPos(m.y, 'y', true)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const c = colour(m.color)
    const r = (m.size ?? 5) * pr
    pathShape(ctx, m.shape, x, y, r)
    if (m.hollow) {
      ctx.strokeStyle = c
      ctx.lineWidth = 1.75 * pr
      ctx.stroke()
    } else {
      ctx.fillStyle = c
      ctx.fill()
      ctx.strokeStyle = colour('--lf-bg')
      ctx.lineWidth = 1 * pr
      ctx.stroke()
    }
    if (m.label) {
      const right = x > left + width * 0.65
      plateText(ctx, m.label, right ? x - r - 3 * pr : x + r + 3 * pr, y - r - 2 * pr, c, pr, right ? 'right' : 'left')
    }
  }
  ctx.restore()
}

const AXIS_FONT = '11px "DM Mono", ui-monospace, monospace'

/** uPlot time-series chart with overlays. Recreated when a data/overlay prop identity changes (memoize them). */
export function TimeChart(props: TimeChartProps) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const { x, lines, bands, hlines, regions, vlines, marks, yLog, yMin, yMax, xMin, xMax, height = 220, xFormat, yFormat } = props
  useEffect(() => {
    const el = host.current
    if (!el) return
    const p = latest.current
    const w0 = Math.max(240, Math.floor(el.clientWidth))
    const axisStroke = colour('--lf-text-muted')
    const grid = { stroke: 'rgba(255,255,255,0.08)', width: 1 }
    const ticks = { stroke: 'rgba(255,255,255,0.18)', width: 1, size: 4 }
    const opts: uPlot.Options = {
      width: w0,
      height,
      legend: { show: false },
      cursor: { show: false },
      scales: {
        x: { time: false, range: (_u, min, max) => [xMin ?? min, xMax ?? max] },
        y: yLog
          ? { distr: 3, log: 10, range: (_u, min, max) => [yMin ?? min, yMax ?? max] }
          : {
              range: (_u, min, max) => {
                const lo = yMin ?? min
                const hi = yMax ?? max
                if (lo === hi) return [lo - 1, hi + 1]
                const pad = (hi - lo) * 0.08
                return [yMin ?? lo - pad, yMax ?? hi + pad]
              },
            },
      },
      axes: [
        {
          stroke: axisStroke,
          font: AXIS_FONT,
          grid,
          ticks,
          values: (_u, splits) => splits.map((v) => (xFormat ? xFormat(v) : String(v))),
        },
        {
          stroke: axisStroke,
          font: AXIS_FONT,
          grid,
          ticks,
          size: 56,
          values: (_u, splits) => splits.map((v) => (yFormat ? yFormat(v) : String(v))),
        },
      ],
      series: [
        {},
        ...lines.map((l) => {
          const c = colour(l.color)
          return {
            label: l.label,
            stroke: c,
            width: l.width ?? 1.5,
            dash: l.dash,
            spanGaps: l.spanGaps ?? false,
            points: { show: (l.points ?? 0) > 0, size: l.points ?? 0, stroke: c, fill: c, width: 1 },
          }
        }),
      ],
      bands: bands?.map((b) => ({ series: [b.upper + 1, b.lower + 1] as [number, number], fill: colour(b.fill) })),
      hooks: {
        drawAxes: [(u) => drawRegions(u, latest.current)],
        draw: [(u) => drawOverlays(u, latest.current)],
      },
    }
    const data = [Array.from(x), ...lines.map((l) => Array.from(l.values))] as unknown as uPlot.AlignedData
    const u = new uPlot(opts, data, el)
    p.onPlotWidth?.(u.bbox.width / uPlot.pxRatio)
    const ro = new ResizeObserver(() => {
      const w = Math.max(240, Math.floor(el.clientWidth))
      if (Math.abs(w - u.width) < 1) return
      u.setSize({ width: w, height })
      latest.current.onPlotWidth?.(u.bbox.width / uPlot.pxRatio)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      u.destroy()
    }
  }, [x, lines, bands, hlines, regions, vlines, marks, yLog, yMin, yMax, xMin, xMax, height, xFormat, yFormat])
  return <div ref={host} className="lf-chart" role="img" aria-label={props.ariaLabel} />
}

// ---- per-pixel-column min/max envelope (pure) ------------------------------------------------------

export interface Envelope {
  /** Column centres (same unit as the input t). */
  x: number[]
  min: Array<number | null>
  max: Array<number | null>
  /** Samples per column (0 = a gap, drawn as a break, never as zero). */
  n: number[]
}

/**
 * Downsample (t, v) into `columns` equal-width buckets over [x0, x1]: each bucket keeps its min and
 * max, so a one-sample spike survives at any zoom (no averaging away). Empty buckets are null gaps.
 */
export function envelope(t: ReadonlyArray<number>, v: ReadonlyArray<number | null>, x0: number, x1: number, columns: number): Envelope {
  const cols = Math.max(1, Math.floor(columns))
  const span = x1 - x0
  const out: Envelope = { x: [], min: [], max: [], n: [] }
  if (!(span > 0)) return out
  const w = span / cols
  for (let c = 0; c < cols; c++) {
    out.x.push(x0 + (c + 0.5) * w)
    out.min.push(null)
    out.max.push(null)
    out.n.push(0)
  }
  for (let i = 0; i < t.length; i++) {
    const ti = t[i]
    const vi = v[i]
    if (vi === null || vi === undefined || !Number.isFinite(vi) || ti < x0 || ti > x1) continue
    const c = Math.min(cols - 1, Math.floor((ti - x0) / w))
    const lo = out.min[c]
    const hi = out.max[c]
    out.min[c] = lo === null || vi < lo ? vi : lo
    out.max[c] = hi === null || vi > hi ? vi : hi
    out.n[c] += 1
  }
  return out
}
