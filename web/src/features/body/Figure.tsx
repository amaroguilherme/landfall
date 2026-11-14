// Original stylised front-view figure (inline SVG, drawn for LANDFALL from simple geometry:
// capsules, ellipses and rounded rectangles; not traced from any anatomical source).
// Each region is an SVG <a> (Tab + Enter), with an accessible name that carries its status. Its FILL
// is the worst MEASURED finding of the selected crewmember on that region (meta.json
// body_region_rule); a region in the hazard footprint of an open case gets a hatched outline in the
// procedure colour instead, drawn only outside the shape (a mask hides the inner half), so it never
// reads as a severity fill. Colour is never the only cue: the no-data state is hatched and dashed,
// the footprint is hatched, the selected region gets a heavy outline, and the region list next to the
// figure repeats every state and footprint as icon + text.
import type { MouseEvent, ReactNode } from 'react'
import type { RegionId } from './regions'
import { REGIONS } from './regions'
import type { RegionState } from './status'
import { STATE_LABEL } from './status'

/** Path for a capsule (stadium) of radius r between two centre points. */
export function capsule(x1: number, y1: number, x2: number, y2: number, r: number): string {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * r
  const ny = (dx / len) * r
  const f = (n: number) => Math.round(n * 100) / 100
  return [
    `M${f(x1 + nx)} ${f(y1 + ny)}`,
    `L${f(x2 + nx)} ${f(y2 + ny)}`,
    `A${r} ${r} 0 0 0 ${f(x2 - nx)} ${f(y2 - ny)}`,
    `L${f(x1 - nx)} ${f(y1 - ny)}`,
    `A${r} ${r} 0 0 0 ${f(x1 + nx)} ${f(y1 + ny)}`,
    'Z',
  ].join(' ')
}

/** Mirror an x coordinate across the figure's vertical axis (x = 150). */
const mx = (x: number) => 300 - x

// ---- silhouette (the skin region) --------------------------------------------------------------

const TORSO =
  'M104 126 H196 Q214 126 214 146 L201 296 Q200 308 188 308 H112 Q100 308 99 296 L86 146 Q86 126 104 126 Z'
const PELVIS = 'M110 314 H190 Q199 314 200 323 L205 350 Q206 362 195 362 H105 Q94 362 95 350 L100 323 Q101 314 110 314 Z'

const SILHOUETTE: ReactNode = (
  <>
    <ellipse cx="150" cy="62" rx="35" ry="43" />
    <rect x="136" y="100" width="28" height="26" rx="9" />
    <path d={TORSO} />
    <path d={PELVIS} />
    <path d={capsule(79, 142, 66, 262, 13)} />
    <path d={capsule(mx(79), 142, mx(66), 262, 13)} />
    <path d={capsule(65, 274, 56, 384, 11)} />
    <path d={capsule(mx(65), 274, mx(56), 384, 11)} />
    <ellipse cx="54" cy="408" rx="11" ry="15" />
    <ellipse cx={mx(54)} cy="408" rx="11" ry="15" />
    <path d={capsule(127, 372, 121, 476, 19)} />
    <path d={capsule(mx(127), 372, mx(121), 476, 19)} />
    <path d={capsule(120, 490, 117, 572, 14)} />
    <path d={capsule(mx(120), 490, mx(117), 572, 14)} />
    <ellipse cx="111" cy="592" rx="19" ry="7.5" />
    <ellipse cx={mx(111)} cy="592" rx="19" ry="7.5" />
  </>
)

// ---- organ shapes --------------------------------------------------------------------------------

const LUNG_L =
  'M140 147 Q131 140 120 145 Q103 154 101 192 L99 228 Q99 238 109 237 L134 232 Q143 230 143 220 L143 153 Q143 149 140 147 Z'
const LUNG_R =
  'M160 147 Q169 140 180 145 Q197 154 199 192 L201 228 Q201 238 191 237 L166 232 Q157 230 157 220 L157 153 Q157 149 160 147 Z'
const HEART =
  'M166 186 C176 178 192 184 190 199 C189 211 179 220 167 229 C163 230 161 229 158 226 C152 218 150 209 151 201 C152 190 158 184 166 186 Z'
const ILIUM_L = 'M106 320 Q120 316 138 322 Q141 324 140 328 L136 344 Q133 349 128 346 Q116 340 106 342 Q101 342 101 337 L102 325 Q102 321 106 320 Z'
const ILIUM_R = 'M194 320 Q180 316 162 322 Q159 324 160 328 L164 344 Q167 349 172 346 Q184 340 194 342 Q199 342 199 337 L198 325 Q198 321 194 320 Z'

interface Shape {
  /** Visible geometry. */
  paint: ReactNode
  /** Enlarged transparent hit area for small targets (also gives the focus ring room). */
  hit?: ReactNode
}

const SHAPES: Record<Exclude<RegionId, 'skin'>, Shape> = {
  brain: {
    paint: (
      <>
        <ellipse cx="150" cy="50" rx="25" ry="22" />
        <path d="M150 30 V70" className="lf-fig-detail" />
      </>
    ),
  },
  eyes: {
    paint: (
      <>
        <ellipse cx="137" cy="82" rx="7" ry="4.5" />
        <ellipse cx="163" cy="82" rx="7" ry="4.5" />
      </>
    ),
    hit: <rect x="124" y="73" width="52" height="18" rx="6" />,
  },
  lungs: {
    paint: (
      <>
        <path d={LUNG_L} />
        <path d={LUNG_R} />
      </>
    ),
  },
  heart: { paint: <path d={HEART} /> },
  blood_forming_organs: {
    paint: (
      <>
        <rect x="145" y="142" width="10" height="80" rx="4" />
        <path d={ILIUM_L} />
        <path d={ILIUM_R} />
      </>
    ),
  },
  kidneys: {
    paint: (
      <>
        <ellipse cx="121" cy="268" rx="10" ry="16" transform="rotate(12 121 268)" />
        <ellipse cx="179" cy="268" rx="10" ry="16" transform="rotate(-12 179 268)" />
      </>
    ),
  },
  skeleton: {
    paint: (
      <>
        {[246, 259, 272, 285].map((y) => (
          <rect key={y} x="143" y={y} width="14" height="10" rx="2.5" />
        ))}
        <circle cx="134" cy="358" r="7" />
        <path d={capsule(131, 364, 121, 468, 5)} />
        <circle cx={mx(134)} cy="358" r="7" />
        <path d={capsule(mx(131), 364, mx(121), 468, 5)} />
      </>
    ),
  },
  muscles: {
    paint: (
      <>
        <path d={capsule(76, 168, 69, 236, 8)} />
        <path d={capsule(mx(76), 168, mx(69), 236, 8)} />
        <path d={capsule(119, 500, 117, 548, 9)} />
        <path d={capsule(mx(119), 500, mx(117), 548, 9)} />
      </>
    ),
  },
  immune: {
    paint: (
      <>
        <ellipse cx="195" cy="250" rx="8" ry="12" transform="rotate(24 195 250)" />
        {[
          [139, 113],
          [161, 113],
          [97, 150],
          [203, 150],
          [113, 374],
          [187, 374],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="4" />
        ))}
      </>
    ),
    hit: (
      <>
        <ellipse cx="195" cy="250" rx="12" ry="16" transform="rotate(24 195 250)" />
        {[
          [139, 113],
          [161, 113],
          [97, 150],
          [203, 150],
          [113, 374],
          [187, 374],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="8.5" />
        ))}
      </>
    ),
  },
}

/** Paint order: base silhouette first, then organs back to front, small targets last. */
const ORDER: RegionId[] = ['skin', 'brain', 'eyes', 'lungs', 'blood_forming_organs', 'heart', 'kidneys', 'skeleton', 'muscles', 'immune']

/** Geometry of a region (the silhouette for skin). */
function geometry(id: RegionId): ReactNode {
  return id === 'skin' ? SILHOUETTE : SHAPES[id].paint
}

export function BodyFigure({
  states,
  footprint,
  selected,
  hrefFor,
  onSelect,
  onPreview,
}: {
  states: Record<RegionId, RegionState>
  /** Regions in the hazard footprint of an open case of the selected crewmember (outline only). */
  footprint: Partial<Record<RegionId, boolean>>
  selected: RegionId
  hrefFor: (id: RegionId) => string
  onSelect: (id: RegionId, e: MouseEvent<Element>) => void
  /** Hover / focus preview for the readout line (null on leave). */
  onPreview?: (id: RegionId | null) => void
}) {
  const footIds = ORDER.filter((id) => footprint[id])
  return (
    <svg
      className="lf-fig"
      viewBox="0 0 300 604"
      role="group"
      aria-label="Body figure. Each part is a link; the list next to it gives the same regions, states and case footprints."
    >
      <defs>
        <pattern id="lf-fig-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="lf-fig-hatch-bg" />
          <line x1="0" y1="0" x2="0" y2="6" className="lf-fig-hatch-line" />
        </pattern>
        <pattern id="lf-fig-foot-hatch" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <line x1="0" y1="0" x2="0" y2="3.2" className="lf-fig-foot-line" />
        </pattern>
        {/* One mask per footprint region: white everywhere, black inside the shape, so the hatched
            outline shows only outside it and never tints the organ itself. */}
        {footIds.map((id) => (
          <mask key={id} id={`lf-fig-foot-mask-${id}`} maskUnits="userSpaceOnUse" x="-20" y="-20" width="340" height="644">
            <rect x="-20" y="-20" width="340" height="644" fill="#fff" />
            <g fill="#000" stroke="none">
              {geometry(id)}
            </g>
          </mask>
        ))}
      </defs>
      {ORDER.map((id) => {
        const def = REGIONS.find((r) => r.id === id)!
        const state = states[id]
        const isSel = id === selected
        const inFoot = Boolean(footprint[id])
        const name = `${def.label}${def.aka ? `, ${def.aka}` : ''}: ${STATE_LABEL[state]}${inFoot ? ', in the hazard footprint of an open case' : ''}${isSel ? ', selected' : ''}`
        return (
          <a
            key={id}
            href={hrefFor(id)}
            className="lf-fig-region"
            data-region={id}
            data-state={state}
            data-footprint={inFoot || undefined}
            data-selected={isSel || undefined}
            aria-label={name}
            aria-current={isSel ? 'true' : undefined}
            onClick={(e) => onSelect(id, e)}
            onMouseEnter={() => onPreview?.(id)}
            onMouseLeave={() => onPreview?.(null)}
            onFocus={() => onPreview?.(id)}
            onBlur={() => onPreview?.(null)}
          >
            <title>{name}</title>
            {inFoot ? (
              <g className="lf-fig-foot" mask={`url(#lf-fig-foot-mask-${id})`} aria-hidden="true">
                {geometry(id)}
              </g>
            ) : null}
            {id === 'skin' ? (
              <g className="lf-fig-paint lf-fig-skin">{SILHOUETTE}</g>
            ) : (
              <>
                {SHAPES[id].hit ? <g className="lf-fig-hit">{SHAPES[id].hit}</g> : null}
                <g className="lf-fig-paint">{SHAPES[id].paint}</g>
              </>
            )}
          </a>
        )
      })}
    </svg>
  )
}
