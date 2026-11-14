// Inline SVG icons (no icon font, no network). 16x16 grid, currentColor, decorative by default.
// Severity icons are SHAPE-coded (circle / triangle / octagon) so status never relies on colour.
import type { ReactNode, SVGProps } from 'react'
import type { Category, ChipKind, Severity } from '../app/vocab'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { title?: string; size?: number }

function Svg({ title, size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      className="lf-icon"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

const S = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

// ---- severity -----------------------------------------------------------------------------

export function SeverityIcon({ severity, ...p }: IconProps & { severity: Severity }) {
  switch (severity) {
    case 'nominal':
      return (
        <Svg {...p}>
          <circle cx="8" cy="8" r="6.4" {...S} />
          <path d="M5 8.2l2 2 4-4.4" {...S} />
        </Svg>
      )
    case 'advisory':
      return (
        <Svg {...p}>
          <circle cx="8" cy="8" r="6.4" {...S} />
          <path d="M8 7.2v4" {...S} />
          <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        </Svg>
      )
    case 'caution':
      return (
        <Svg {...p}>
          <path d="M8 1.8l6.6 11.7H1.4L8 1.8z" {...S} />
          <path d="M8 6.2v3.6" {...S} />
          <circle cx="8" cy="11.6" r="0.95" fill="currentColor" />
        </Svg>
      )
    case 'warning':
      return (
        <Svg {...p}>
          <path d="M5.4 1.5h5.2l3.9 3.9v5.2l-3.9 3.9H5.4l-3.9-3.9V5.4z" {...S} />
          <path d="M8 4.6v4.2" {...S} />
          <circle cx="8" cy="11.2" r="0.95" fill="currentColor" />
        </Svg>
      )
    case 'emergency':
      return (
        <Svg {...p}>
          <path d="M5.4 1.5h5.2l3.9 3.9v5.2l-3.9 3.9H5.4l-3.9-3.9V5.4z" fill="currentColor" stroke="currentColor" />
          <path d="M8 4.6v4.2" stroke="var(--lf-bg)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="8" cy="11.2" r="1" fill="var(--lf-bg)" />
        </Svg>
      )
  }
}

// ---- data quality ([V2 10020]) ---------------------------------------------------------------

export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.4" {...S} />
      <path d="M8 4.5V8l2.4 1.6" {...S} />
    </Svg>
  )
}

export function StaleIcon(p: IconProps) {
  // hourglass: data aged out
  return (
    <Svg {...p}>
      <path d="M4 1.8h8M4 14.2h8M5 1.8c0 3.4 6 3.6 6 6.2s-6 2.8-6 6.2M11 1.8c0 3.4-6 3.6-6 6.2s6 2.8 6 6.2" {...S} />
    </Svg>
  )
}

export function UnknownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.4" {...S} strokeDasharray="2.2 1.8" />
      <path d="M6.1 6.2a1.95 1.95 0 113 1.6c-.7.45-1.1.8-1.1 1.6" {...S} />
      <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
    </Svg>
  )
}

export function UnavailableIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.4" {...S} />
      <path d="M3.6 12.4l8.8-8.8" {...S} />
    </Svg>
  )
}

// ---- category glyphs (shape, not colour: floor / ceiling / delta / scale / own baseline) ------

export function CategoryGlyph({ category, ...p }: IconProps & { category: Category }) {
  switch (category) {
    case 'FFD': // floor: a capability that must stay ABOVE a hatched floor
      return (
        <Svg {...p}>
          <path d="M8 1.8l3.6 4.4H9.5v3.6h-3V6.2H4.4z" fill="currentColor" />
          <path d="M1.2 11.6h13.6" {...S} strokeWidth={2} />
          <path d="M3 12.4l-1.6 2.2M6.2 12.4l-1.6 2.2M9.4 12.4l-1.6 2.2M12.6 12.4l-1.6 2.2" {...S} strokeWidth={1.2} />
        </Svg>
      )
    case 'PEL': // ceiling: cumulative exposure that must stay BELOW a hatched ceiling
      return (
        <Svg {...p}>
          <path d="M3 3.6L1.4 1.4M6.2 3.6L4.6 1.4M9.4 3.6L7.8 1.4M12.6 3.6L11 1.4" {...S} strokeWidth={1.2} />
          <path d="M1.2 4.4h13.6" {...S} strokeWidth={2} />
          <rect x="5.4" y="7.4" width="5.2" height="7.2" fill="currentColor" />
        </Svg>
      )
    case 'POL': // delta: maximum change against the crewmember's own preflight baseline
      return (
        <Svg {...p}>
          <path d="M8 1.9l6.4 12.2H1.6z" {...S} />
        </Svg>
      )
    case 'OPS': // operational scale (NOAA S1-S5)
      return (
        <Svg {...p}>
          <rect x="1.5" y="10.5" width="2.6" height="4" fill="currentColor" />
          <rect x="5.1" y="7.8" width="2.6" height="6.7" fill="currentColor" />
          <rect x="8.7" y="5" width="2.6" height="9.5" fill="currentColor" />
          <rect x="12.3" y="1.6" width="2.6" height="12.9" {...S} strokeWidth={1.2} />
        </Svg>
      )
    case 'PERSONAL': // reliable change: a point beyond the tail of one's own baseline distribution
      return (
        <Svg {...p}>
          <path d="M1 13.6c3.2 0 3.6-9.4 6-9.4s2.8 9.4 6 9.4" {...S} />
          <path d="M1 14.4h14" {...S} strokeWidth={1} strokeDasharray="1.6 1.4" />
          <circle cx="14" cy="9" r="1.5" fill="currentColor" />
        </Svg>
      )
  }
}

// ---- chip glyphs ------------------------------------------------------------------------------

export function ChipGlyph({ chip, ...p }: IconProps & { chip: ChipKind | string }) {
  const size = p.size ?? 10
  switch (chip) {
    case 'NASA-published':
      return (
        <Svg {...p} size={size}>
          <rect x="3" y="3" width="10" height="10" fill="currentColor" />
        </Svg>
      )
    case 'NASA brief':
      return (
        <Svg {...p} size={size}>
          <rect x="3" y="3" width="10" height="10" {...S} strokeWidth={1.8} />
          <rect x="3" y="3" width="5" height="10" fill="currentColor" />
        </Svg>
      )
    case 'NOAA-published':
      return (
        <Svg {...p} size={size}>
          <circle cx="8" cy="8" r="5.2" fill="currentColor" />
        </Svg>
      )
    case 'literature':
      return (
        <Svg {...p} size={size}>
          <circle cx="8" cy="8" r="4.8" {...S} strokeWidth={1.8} />
        </Svg>
      )
    case 'derived':
      return (
        <Svg {...p} size={size}>
          <path d="M3 5.8h10M3 10.2h10" {...S} strokeWidth={1.9} />
        </Svg>
      )
    case 'design choice':
      return (
        <Svg {...p} size={size}>
          <path d="M8 2.2L13.8 8 8 13.8 2.2 8z" {...S} strokeWidth={1.8} />
        </Svg>
      )
    default:
      return null
  }
}

// ---- misc ---------------------------------------------------------------------------------------

export function AntennaIcon({ blocked, ...p }: IconProps & { blocked?: boolean }) {
  return (
    <Svg {...p}>
      <path d="M8 8.5v6M5.5 14.5h5" {...S} />
      <circle cx="8" cy="7" r="1.4" fill="currentColor" />
      {blocked ? (
        <path d="M2 2l12 12" {...S} />
      ) : (
        <path d="M4.6 3.6a4.8 4.8 0 000 6.8M11.4 3.6a4.8 4.8 0 010 6.8M2.6 1.8a7.4 7.4 0 000 10.4M13.4 1.8a7.4 7.4 0 010 10.4" {...S} strokeWidth={1.3} />
      )}
    </Svg>
  )
}

export function SunIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" {...S} strokeWidth={1.3} />
    </Svg>
  )
}

export function ChevronIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 6l4 4 4-4" {...S} />
    </Svg>
  )
}

export function ExternalIcon(p: IconProps) {
  return (
    <Svg {...p} size={p.size ?? 12}>
      <path d="M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5v4h-9v-9h4" {...S} />
    </Svg>
  )
}

export function PauseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5.5 3v10M10.5 3v10" {...S} strokeWidth={2} />
    </Svg>
  )
}

export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 3l8 5-8 5z" fill="currentColor" />
    </Svg>
  )
}

export function ArrowIcon({ direction, ...p }: IconProps & { direction: 'up' | 'down' }) {
  return (
    <Svg {...p}>
      {direction === 'up' ? <path d="M8 2.5l5 7H3z" fill="currentColor" /> : <path d="M8 13.5l5-7H3z" fill="currentColor" />}
    </Svg>
  )
}
