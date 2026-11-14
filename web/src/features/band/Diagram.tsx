// Data-driven SVG block diagram of the LANDFALL BAND. Every block, bus, label and hand-off comes
// from hardware/sensor-map.json; only the geometry lives here. Two layouts: "wide" (desktop and
// the demo video) and "narrow" (phones). Colour carries meaning only (Appendix F F.5.10 a):
// neutral blocks, gray dashed + hatched NOT MEASURABLE HERE zone (Table F.5-1 gray = unavailable),
// bright-green keyboard cursor (Table F.5-2), white outline for the selected block.
import type { KeyboardEvent, ReactNode } from 'react'
import { reqLabel } from './render'
import type { Block, HandOff, SensorMap } from './types'

export type Selection = { kind: 'block'; id: string } | { kind: 'handoff'; id: string }

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type Mode = 'wide' | 'narrow'

const SENSOR_H = { wide: 84, narrow: 78 }

function blockLines(b: Block) {
  const part = b.qty > 1 ? `${b.part} ×${b.qty}` : b.part
  const a = b.produces.filter((p) => !p.not_in_spec).map((p) => p.variable)
  const extra = b.produces.filter((p) => p.not_in_spec).map((p) => p.variable)
  const produces = [...a, ...extra].join(' · ')
  const reqs = b.justified_by.map((r) => diagramReqLabel(r)).join(' · ')
  return { part, produces, reqs }
}

/** Short label for a block line: requirement ids as they are; NASA pages without their qualifier
 * ("ARCHeR (Artemis II)" -> "ARCHeR", "Standard Measures" -> "Std Measures"). Details keep full names. */
export function diagramReqLabel(r: Parameters<typeof reqLabel>[0]): string {
  if (/^V[12] \d/.test(r.id)) return reqLabel(r)
  return reqLabel({ ...r, id: r.id.replace(/\s*\(.*\)$/, '').replace(/^Standard Measures$/, 'Std Measures') })
}

/** Numbers inside SVG labels render in DM Mono too (digit runs not glued to letters). */
const SVG_NUM_RE = /(?<![A-Za-z0-9])(\d(?:[\d,.]*\d)?)(?![A-Za-z])/g
function nums(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(SVG_NUM_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    out.push(
      <tspan key={i} className="bd-n">
        {m[0]}
      </tspan>,
    )
    last = i + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Block_({
  b,
  r,
  selected,
  onSelect,
  compact = false,
  bus,
}: {
  b: Block
  r: Rect
  selected: boolean
  onSelect: (s: Selection) => void
  compact?: boolean
  bus?: string
}) {
  const { part, produces, reqs } = blockLines(b)
  const label = `${part}, ${b.name}. Produces: ${produces || 'no indicator'}. Justified by: ${reqs}. Show details.`
  return (
    <Hit sel={{ kind: 'block', id: b.id }} label={label} selected={selected} onSelect={onSelect} r={r}>
      <text x={r.x + 12} y={r.y + 20} className="bd-part">
        {part}
      </text>
      {bus ? (
        <text x={r.x + r.w - 10} y={r.y + 19} className="bd-bus-tag" textAnchor="end">
          {bus}
        </text>
      ) : null}
      <text x={r.x + 12} y={r.y + 38} className="bd-name">
        {nums(b.name)}
      </text>
      {!compact && produces ? (
        <text x={r.x + 12} y={r.y + 57} className="bd-meta">
          <tspan className="bd-key">a→ </tspan>
          {produces}
        </text>
      ) : null}
      <text x={r.x + 12} y={r.y + (compact ? 55 : 74)} className="bd-meta">
        <tspan className="bd-key">c← </tspan>
        {reqs}
      </text>
    </Hit>
  )
}

/** A selectable region: keyboard focusable, Enter/Space selects, pressed state announced. */
function Hit({
  sel,
  label,
  selected,
  onSelect,
  r,
  children,
  frameClass = 'bd-frame',
}: {
  sel: Selection
  label: string
  selected: boolean
  onSelect: (s: Selection) => void
  r: Rect
  children: ReactNode
  frameClass?: string
}) {
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(sel)
    }
  }
  return (
    <g
      className="bd-hit"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={label}
      data-selected={selected || undefined}
      data-id={sel.id}
      onClick={() => onSelect(sel)}
      onKeyDown={onKey}
    >
      <rect className="bd-focus" x={r.x - 4} y={r.y - 4} width={r.w + 8} height={r.h + 8} rx={4} />
      <rect className={frameClass} x={r.x} y={r.y} width={r.w} height={r.h} rx={2} />
      {children}
    </g>
  )
}

/** Greedy word wrap for SVG text (no native wrapping); at most `maxLines` lines. */
export function wrap(text: string, maxChars: number, maxLines = 2): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1)
    const tail = lines.slice(maxLines - 1).join(' ')
    return [...head, tail.length > maxChars ? tail.slice(0, maxChars - 1) + '…' : tail]
  }
  return lines
}

/** "[V2 6164]", or "[V2 6164–6165]" when the hand-off also cites the next requirement of the same volume. */
export function handOffReqLabel(h: Pick<HandOff, 'requirement' | 'also'>): string {
  const refs = [h.requirement, ...(h.also ?? [])].filter((r): r is NonNullable<typeof r> => Boolean(r))
  if (!refs.length) return ''
  const m = refs.map((r) => r.id.match(/^(V[12]) (\d+)$/))
  const consecutive =
    refs.length > 1 &&
    m.every((x, i) => x && x[1] === m[0]?.[1] && (i === 0 || Number(x[2]) === Number(m[i - 1]?.[2]) + 1))
  if (consecutive) return `[${m[0]?.[1]} ${m[0]?.[2]}–${m[m.length - 1]?.[2]}]`
  return refs.map((r) => reqLabel(r)).join(' ')
}

function HandOffItem({
  h,
  r,
  selected,
  onSelect,
}: {
  h: HandOff
  r: Rect
  selected: boolean
  onSelect: (s: Selection) => void
}) {
  const req = handOffReqLabel(h)
  const viaChars = Math.floor((r.w - 30) / 6.4)
  return (
    <Hit
      sel={{ kind: 'handoff', id: h.id }}
      label={`Not measurable here: ${h.what}. Arrives via ${h.via}${req ? `, ${req}` : ''}. Show details.`}
      selected={selected}
      onSelect={onSelect}
      r={r}
      frameClass="bd-nmh-frame"
    >
      <text x={r.x + 10} y={r.y + 21} className="bd-nmh-what">
        {nums(h.what)}
      </text>
      {req ? (
        <text x={r.x + r.w - 10} y={r.y + 21} className="bd-nmh-req" textAnchor="end">
          {req}
        </text>
      ) : null}
      {wrap(`→ ${h.via}`, viaChars).map((line, i) => (
        <text key={i} x={r.x + 10 + (i ? 12 : 0)} y={r.y + 39 + i * 15} className="bd-nmh-via">
          {nums(line)}
        </text>
      ))}
    </Hit>
  )
}

function Defs() {
  return (
    <defs>
      <pattern id="bd-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="9" height="9" className="bd-hatch-bg" />
        <line x1="0" y1="0" x2="0" y2="9" className="bd-hatch-line" />
      </pattern>
      <marker id="bd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" className="bd-arrowhead" />
      </marker>
      <marker id="bd-arrow-nmh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" className="bd-arrowhead-nmh" />
      </marker>
    </defs>
  )
}

/** Antenna glyph for the BLE link (radio is inside the nRF52840). */
function Antenna({ x, y }: { x: number; y: number }) {
  return (
    <g className="bd-antenna" aria-hidden="true">
      <line x1={x} y1={y} x2={x} y2={y + 26} />
      <path d={`M${x - 9},${y} L${x},${y + 10} L${x + 9},${y}`} />
      <path d={`M${x + 11},${y - 1} a 10 10 0 0 1 0 14`} />
      <path d={`M${x + 16},${y - 5} a 16 16 0 0 1 0 22`} />
    </g>
  )
}

export function BandDiagram({
  map,
  mode,
  selection,
  onSelect,
  titleId,
  descId,
}: {
  map: SensorMap
  mode: Mode
  selection: Selection | null
  onSelect: (s: Selection) => void
  titleId: string
  descId: string
}) {
  return mode === 'wide' ? (
    <Wide map={map} selection={selection} onSelect={onSelect} titleId={titleId} descId={descId} />
  ) : (
    <Narrow map={map} selection={selection} onSelect={onSelect} titleId={titleId} descId={descId} />
  )
}

interface ViewProps {
  map: SensorMap
  selection: Selection | null
  onSelect: (s: Selection) => void
  titleId: string
  descId: string
}

function isSel(selection: Selection | null, kind: Selection['kind'], id: string) {
  return selection?.kind === kind && selection.id === id
}

function busLabel(map: SensorMap, id?: string) {
  return id ? (map.buses.find((b) => b.id === id)?.label ?? id) : ''
}

function SvgFrame({ w, h, y0 = 0, titleId, descId, children, map }: { w: number; h: number; y0?: number; titleId: string; descId: string; children: ReactNode; map: SensorMap }) {
  return (
    <svg className="bd-svg" viewBox={`0 ${y0} ${w} ${h - y0}`} role="group" aria-labelledby={titleId} aria-describedby={descId}>
      <title id={titleId}>{map.title}: block diagram</title>
      <desc id={descId}>
        Sensors on the band connect over SPI and I2C to the nRF52840 microcontroller, which logs to flash and sends data
        over Bluetooth to the LANDFALL app. Outside the device, a dashed boundary lists what the band cannot measure and
        the path each of those values takes instead: {map.not_measurable_here.map((h) => `${h.what} via ${h.via}`).join('; ')}.
      </desc>
      <Defs />
      {children}
    </svg>
  )
}

// ---- wide layout (1200 wide: desktop and the demo video) ------------------------------------------

function Wide({ map, selection, onSelect, titleId, descId }: ViewProps) {
  const W = 1200
  const sensors = map.blocks.filter((b) => b.group === 'sensor')
  const sx = 24
  const sw = 296
  const sTop = 104
  const gap = 10
  const sH = SENSOR_H.wide
  const sRect = new Map<string, Rect>()
  sensors.forEach((b, i) => sRect.set(b.id, { x: sx, y: sTop + i * (sH + gap), w: sw, h: sH }))
  const sBottom = sTop + sensors.length * (sH + gap) - gap

  const mcu = map.blocks.find((b) => b.group === 'core')
  const mcuR: Rect = { x: 476, y: sTop, w: 168, h: sBottom - sTop }
  const flash = map.blocks.find((b) => b.group === 'storage')
  const flashR: Rect = { x: 680, y: sTop, w: 128, h: 140 }

  const power = map.blocks.filter((b) => b.group === 'power')
  const pDom: Rect = { x: 24, y: sBottom + 22, w: 620, h: 84 }
  const pOrder = ['charger', 'battery', 'gauge']
  const pW = 150
  const pRect = new Map<string, Rect>()
  pOrder.forEach((id, i) => pRect.set(id, { x: pDom.x + 16 + i * (pW + 14), y: pDom.y + 30, w: pW, h: 44 }))

  const dev: Rect = { x: 8, y: 40, w: 816, h: pDom.y + pDom.h + 16 - 40 }
  const nmh: Rect = { x: 852, y: dev.y, w: 340, h: dev.h }
  const app: Rect = { x: 8, y: dev.y + dev.h + 44, w: 1184, h: 60 }
  const H = app.y + app.h + 6

  // Bus trunks between the sensor column and the MCU, built from the bus member lists.
  const trunkX: Record<string, number> = { spi: 352, i2c_a: 396, i2c_b: 440 }
  const busMembers = (busId: string) => map.buses.find((b) => b.id === busId)?.members ?? []
  const memberPoint = (busId: string, id: string): { y: number; fromX: number | null } => {
    const p = pRect.get(id)
    if (p) return { y: p.y, fromX: null } // power-domain member: the trunk drops into its top edge
    const r = sRect.get(id)
    if (!r) return { y: 0, fromX: null }
    const b = map.blocks.find((x) => x.id === id)
    // A block on two buses offsets its two connections so they never overlap.
    const off = b?.interface_extra ? (b.interface === busId ? -10 : 10) : 0
    return { y: r.y + r.h / 2 + off, fromX: r.x + r.w }
  }
  const trunks = ['spi', 'i2c_a', 'i2c_b'].map((busId) => {
    const pts = busMembers(busId).map((id) => memberPoint(busId, id))
    const ys = pts.map((p) => p.y)
    const mean = ys.reduce((a, v) => a + v, 0) / Math.max(ys.length, 1)
    const portY = Math.min(Math.max(mean, mcuR.y + 30), mcuR.y + mcuR.h - 30)
    return { busId, x: trunkX[busId], pts, portY, y1: Math.min(...ys, portY), y2: Math.max(...ys, portY) }
  })

  const ant = { x: 792, y: flashR.y + flashR.h + 64 }
  const mcuSpecLines = (mcu?.mfr_spec ?? []).flatMap((s) => wrap(s, 24, 3))
  const sampY = Math.max(150, 68 + mcuSpecLines.length * 16 + 10)
  const nmhItemsTop = nmh.y + 84
  const itemH = 62
  const itemGap = 6
  const railX = mcuR.x + mcuR.w + 20
  const charger = pRect.get('charger')

  return (
    <SvgFrame w={W} h={H} y0={30} titleId={titleId} descId={descId} map={map}>
      {/* device boundary */}
      <rect className="bd-device" x={dev.x} y={dev.y} width={dev.w} height={dev.h} rx={6} />
      <text x={dev.x + 16} y={dev.y + 30} className="bd-zone-title">
        {map.title}
      </text>
      <text x={dev.x + 16 + 172} y={dev.y + 30} className="bd-zone-sub">
        device boundary · measured on the band · concept, never built
      </text>
      <text x={sx} y={sTop - 10} className="bd-col">
        SENSORS · ANALOG FRONT ENDS
      </text>
      <text x={mcuR.x} y={sTop - 10} className="bd-col">
        CORE
      </text>
      <text x={flashR.x} y={sTop - 10} className="bd-col">
        LOG · RF
      </text>

      {/* buses */}
      {trunks.map((t) => (
        <g key={t.busId} className="bd-bus" data-bus={t.busId}>
          <line x1={t.x} y1={t.y1} x2={t.x} y2={t.y2} />
          {t.pts.map((p, i) => (
            <g key={i}>
              {p.fromX !== null ? <line x1={p.fromX} y1={p.y} x2={t.x} y2={p.y} /> : null}
              <circle cx={t.x} cy={p.y} r={3} />
            </g>
          ))}
          <line x1={t.x} y1={t.portY} x2={mcuR.x} y2={t.portY} />
          <circle cx={t.x} cy={t.portY} r={3} />
          <text x={t.x} y={t.y1 - 9} className="bd-bus-label" textAnchor="middle">
            {busLabel(map, t.busId)}
          </text>
        </g>
      ))}
      {/* QSPI to flash */}
      <g className="bd-bus" data-bus="qspi">
        <line x1={mcuR.x + mcuR.w} y1={flashR.y + 62} x2={flashR.x} y2={flashR.y + 62} />
        <text x={(mcuR.x + mcuR.w + flashR.x) / 2} y={flashR.y + 54} className="bd-bus-label" textAnchor="middle">
          {busLabel(map, 'qspi')}
        </text>
      </g>
      {/* power rails into the core */}
      <g className="bd-rail">
        <line x1={pDom.x + pDom.w} y1={pDom.y + 52} x2={railX} y2={pDom.y + 52} />
        <line x1={railX} y1={pDom.y + 52} x2={railX} y2={mcuR.y + mcuR.h - 16} />
        <line x1={railX} y1={mcuR.y + mcuR.h - 16} x2={mcuR.x + mcuR.w + 2} y2={mcuR.y + mcuR.h - 16} markerEnd="url(#bd-arrow)" />
      </g>
      <text x={railX + 8} y={pDom.y + 30} className="bd-bus-label">
        VBAT → rails
      </text>
      <text x={railX + 8} y={pDom.y + 46} className="bd-spec">
        (not designed yet)
      </text>

      {sensors.map((b) => (
        <Block_
          key={b.id}
          b={b}
          r={sRect.get(b.id)!}
          selected={isSel(selection, 'block', b.id)}
          onSelect={onSelect}
          bus={[busLabel(map, b.interface), b.interface_extra ? busLabel(map, b.interface_extra) : ''].filter(Boolean).join(' + ')}
        />
      ))}

      {mcu ? (
        <Hit
          sel={{ kind: 'block', id: mcu.id }}
          label={`${mcu.part}, ${mcu.name}. ${mcu.function} Show details.`}
          selected={isSel(selection, 'block', mcu.id)}
          onSelect={onSelect}
          r={mcuR}
        >
          <text x={mcuR.x + 12} y={mcuR.y + 24} className="bd-part">
            {mcu.part}
          </text>
          <text x={mcuR.x + 12} y={mcuR.y + 44} className="bd-name">
            {mcu.name}
          </text>
          {mcuSpecLines.map((line, i) => (
            <text key={i} x={mcuR.x + 12} y={mcuR.y + 68 + i * 16} className="bd-spec">
              {nums(line)}
            </text>
          ))}
          <text x={mcuR.x + 12} y={mcuR.y + sampY} className="bd-col">
            SAMPLING
          </text>
          {sensors.map((b, i) => {
            const r = b.rates[0]
            return r ? (
              <text key={b.id} x={mcuR.x + 12} y={mcuR.y + sampY + 18 + i * 16} className="bd-meta">
                {b.part}: {r.value} {r.unit}
              </text>
            ) : null
          })}
          <text x={mcuR.x + 12} y={mcuR.y + sampY + 18 + sensors.length * 16 + 14} className="bd-spec">
            one clock → MET stamps
          </text>
          <text x={mcuR.x + 12} y={mcuR.y + sampY + 18 + sensors.length * 16 + 30} className="bd-spec">
            off-wrist → MISSING, not 0
          </text>
          {mcu.justified_by.map((r, i) => (
            <text key={r.id} x={mcuR.x + 12} y={mcuR.y + sampY + 18 + sensors.length * 16 + 62 + i * 16} className="bd-meta">
              {i === 0 ? <tspan className="bd-key">c← </tspan> : <tspan className="bd-key">{'   '}</tspan>}
              {reqLabel(r)}
            </text>
          ))}
        </Hit>
      ) : null}

      {flash ? (
        <Hit
          sel={{ kind: 'block', id: flash.id }}
          label={`${flash.part}, ${flash.name}. ${flash.function} Show details.`}
          selected={isSel(selection, 'block', flash.id)}
          onSelect={onSelect}
          r={flashR}
        >
          <text x={flashR.x + 10} y={flashR.y + 22} className="bd-part">
            {flash.part}
          </text>
          {flash.name.split(', ').map((line, i) => (
            <text key={i} x={flashR.x + 10} y={flashR.y + 40 + i * 16} className="bd-name">
              {nums(line)}
            </text>
          ))}
          <text x={flashR.x + 10} y={flashR.y + 82} className="bd-meta">
            {stepValue(map.log.steps, 'depth')} d est.
          </text>
          <text x={flashR.x + 10} y={flashR.y + 97} className="bd-meta">
            target ≥ {stepValue(map.log.steps, 'target')} d
          </text>
          {flash.justified_by.map((r, i) => (
            <text key={r.id} x={flashR.x + 10} y={flashR.y + 118 + i * 15} className="bd-meta">
              {i === 0 ? <tspan className="bd-key">c← </tspan> : <tspan className="bd-key">{'   '}</tspan>}
              {reqLabel(r)}
            </text>
          ))}
        </Hit>
      ) : null}

      {/* BLE: the radio is inside the nRF52840; the link leaves the device for the app */}
      <line className="bd-link" x1={mcuR.x + mcuR.w} y1={ant.y + 20} x2={ant.x} y2={ant.y + 20} />
      <Antenna x={ant.x} y={ant.y - 6} />
      <text x={ant.x - 16} y={ant.y - 2} className="bd-bus-label" textAnchor="end">
        {busLabel(map, 'ble')}
      </text>
      <text x={ant.x - 16} y={ant.y + 12} className="bd-spec" textAnchor="end">
        encrypted link
      </text>
      <line className="bd-link" x1={ant.x} y1={ant.y + 20} x2={ant.x} y2={app.y - 2} markerEnd="url(#bd-arrow)" />
      <text x={ant.x + 10} y={app.y - 12} className="bd-spec">
        source: band
      </text>

      {/* power domain */}
      <rect className="bd-power" x={pDom.x} y={pDom.y} width={pDom.w} height={pDom.h} rx={3} />
      <text x={pDom.x + 12} y={pDom.y + 19} className="bd-col">
        POWER DOMAIN · 1S LiPo
      </text>
      {power.map((b) => {
        const r = pRect.get(b.id)
        if (!r) return null
        return (
          <Hit
            key={b.id}
            sel={{ kind: 'block', id: b.id }}
            label={`${b.part}, ${b.name}. Show details.`}
            selected={isSel(selection, 'block', b.id)}
            onSelect={onSelect}
            r={r}
          >
            <text x={r.x + 10} y={r.y + 18} className="bd-part bd-part-sm">
              {b.id === 'battery' ? 'LiPo 1S' : b.part}
            </text>
            <text x={r.x + 10} y={r.y + 35} className="bd-name bd-name-sm">
              {b.id === 'battery' ? `${stepValue(map.power.steps, 'capacity')} mAh · ${stepValue(map.power.steps, 'energy')} Wh` : b.name}
            </text>
          </Hit>
        )
      })}
      {(['charger', 'battery'] as const).map((id, i) => {
        const a = pRect.get(id)
        const b = pRect.get(pOrder[i + 1])
        if (!a || !b) return null
        return <line key={id} className="bd-rail" x1={a.x + a.w} y1={a.y + 22} x2={b.x - 2} y2={b.y + 22} markerEnd="url(#bd-arrow)" />
      })}
      {charger ? (
        <>
          <line className="bd-rail" x1={charger.x + 40} y1={dev.y + dev.h + 28} x2={charger.x + 40} y2={charger.y + charger.h + 2} markerEnd="url(#bd-arrow)" />
          <text x={charger.x + 50} y={dev.y + dev.h + 26} className="bd-spec">
            <tspan className="bd-n">5</tspan> V charging dock (external)
          </text>
        </>
      ) : null}

      {/* NOT MEASURABLE HERE: the hand-off boundary, at the edge of the device */}
      <rect className="bd-nmh" x={nmh.x} y={nmh.y} width={nmh.w} height={nmh.h} rx={6} />
      <text x={nmh.x + 16} y={nmh.y + 34} className="bd-nmh-title">
        NOT MEASURABLE HERE
      </text>
      <text x={nmh.x + 16} y={nmh.y + 56} className="bd-zone-sub">
        hand-off boundary · arrives by another path
      </text>
      {map.not_measurable_here.map((h, i) => (
        <HandOffItem
          key={h.id}
          h={h}
          r={{ x: nmh.x + 12, y: nmhItemsTop + i * (itemH + itemGap), w: nmh.w - 24, h: itemH }}
          selected={isSel(selection, 'handoff', h.id)}
          onSelect={onSelect}
        />
      ))}
      <line className="bd-link-nmh" x1={nmh.x + nmh.w / 2} y1={nmh.y + nmh.h} x2={nmh.x + nmh.w / 2} y2={app.y - 2} markerEnd="url(#bd-arrow-nmh)" />
      <text x={nmh.x + nmh.w / 2 + 10} y={app.y - 12} className="bd-spec">
        source: manual · vehicle · lab
      </text>

      {/* the sink */}
      <rect className="bd-app" x={app.x} y={app.y} width={app.w} height={app.h} rx={4} />
      <text x={app.x + 16} y={app.y + 25} className="bd-app-title">
        LANDFALL app · crew tablet · onboard, no Earth link needed
      </text>
      <text x={app.x + 16} y={app.y + 45} className="bd-zone-sub">
        One engine evaluates band data and hand-off data the same way: Tier A limits, Tier B personal baselines, cases.
      </text>
    </SvgFrame>
  )
}

// ---- narrow layout (400 wide, phones) --------------------------------------------------------------

function Narrow({ map, selection, onSelect, titleId, descId }: ViewProps) {
  const W = 400
  const x0 = 6
  const inner = 18
  const bw = W - 2 * inner
  const items: ReactNode[] = []

  // 1. The device, top to bottom: core, log, sensors, power.
  const devTop = 8
  let y = devTop + 46
  const blocks = map.blocks
  const order = [...blocks.filter((b) => b.group === 'sensor'), ...blocks.filter((b) => b.group === 'core'), ...blocks.filter((b) => b.group === 'storage')]
  for (const b of order) {
    const h = b.group === 'sensor' ? SENSOR_H.narrow + 6 : 62
    const r: Rect = { x: inner, y, w: bw, h }
    const bus = b.group === 'core' ? busLabel(map, 'ble') : [busLabel(map, b.interface), b.interface_extra ? busLabel(map, b.interface_extra) : ''].filter(Boolean).join(' + ')
    items.push(<Block_ key={b.id} b={b} r={r} selected={isSel(selection, 'block', b.id)} onSelect={onSelect} compact={b.group !== 'sensor'} bus={bus} />)
    y += h + 8
  }
  const pTop = y + 6
  const power = blocks.filter((b) => b.group === 'power')
  const pw = (bw - 24 - 2 * 8) / 3
  items.push(
    <g key="power">
      <rect className="bd-power" x={inner} y={pTop} width={bw} height={84} rx={3} />
      <text x={inner + 10} y={pTop + 18} className="bd-col">
        POWER · 1S LiPo · NON-CRITICAL CLASS
      </text>
    </g>,
  )
  power.forEach((b, i) => {
    const r: Rect = { x: inner + 12 + i * (pw + 8), y: pTop + 28, w: pw, h: 44 }
    items.push(
      <Hit key={b.id} sel={{ kind: 'block', id: b.id }} label={`${b.part}, ${b.name}. Show details.`} selected={isSel(selection, 'block', b.id)} onSelect={onSelect} r={r}>
        <text x={r.x + 8} y={r.y + 18} className="bd-part bd-part-sm">
          {b.id === 'battery' ? 'LiPo 1S' : b.part}
        </text>
        <text x={r.x + 8} y={r.y + 35} className="bd-name bd-name-sm">
          {b.id === 'battery' ? `${stepValue(map.power.steps, 'capacity')} mAh` : b.name}
        </text>
      </Hit>,
    )
  })
  const devBottom = pTop + 84 + 14

  // 2. BLE down into the app; 3. hand-offs up into the app from the zone below it.
  const app: Rect = { x: x0, y: devBottom + 44, w: W - 2 * x0, h: 56 }
  const nmhTop = app.y + app.h + 44
  const nmh: Rect = { x: x0, y: nmhTop, w: W - 2 * x0, h: 70 + map.not_measurable_here.length * 62 }
  const H = nmh.y + nmh.h + 8

  return (
    <SvgFrame w={W} h={H} titleId={titleId} descId={descId} map={map}>
      <rect className="bd-device" x={x0} y={devTop} width={W - 2 * x0} height={devBottom - devTop} rx={6} />
      <text x={x0 + 14} y={devTop + 28} className="bd-zone-title">
        {map.title}
      </text>
      <text x={x0 + 14 + 150} y={devTop + 28} className="bd-zone-sub">
        measured on the band
      </text>
      {items}
      <line className="bd-link" x1={W / 2} y1={devBottom} x2={W / 2} y2={app.y - 2} markerEnd="url(#bd-arrow)" />
      <text x={W / 2 + 8} y={devBottom + 26} className="bd-spec">
        BLE <tspan className="bd-n">5</tspan> · source: band
      </text>
      <rect className="bd-app" x={app.x} y={app.y} width={app.w} height={app.h} rx={4} />
      <text x={app.x + 14} y={app.y + 24} className="bd-app-title">
        LANDFALL app · crew tablet
      </text>
      <text x={app.x + 14} y={app.y + 43} className="bd-zone-sub">
        onboard; no Earth link needed
      </text>
      <line className="bd-link-nmh" x1={W / 2} y1={nmh.y} x2={W / 2} y2={app.y + app.h + 2} markerEnd="url(#bd-arrow-nmh)" />
      <text x={W / 2 + 8} y={app.y + app.h + 26} className="bd-spec">
        manual · vehicle · lab
      </text>
      <rect className="bd-nmh" x={nmh.x} y={nmh.y} width={nmh.w} height={nmh.h} rx={6} />
      <text x={nmh.x + 14} y={nmh.y + 30} className="bd-nmh-title">
        NOT MEASURABLE HERE
      </text>
      <text x={nmh.x + 14} y={nmh.y + 50} className="bd-zone-sub">
        hand-off boundary · arrives by another path
      </text>
      {map.not_measurable_here.map((h, i) => (
        <HandOffItem
          key={h.id}
          h={h}
          r={{ x: nmh.x + 10, y: nmh.y + 64 + i * 62, w: nmh.w - 20, h: 56 }}
          selected={isSel(selection, 'handoff', h.id)}
          onSelect={onSelect}
        />
      ))}
    </SvgFrame>
  )
}

function stepValue(steps: { id: string; value: number }[], id: string): number | string {
  return steps.find((s) => s.id === id)?.value ?? '—'
}
