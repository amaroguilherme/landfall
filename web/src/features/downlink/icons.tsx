// Downlink-only glyphs, drawn like src/ui/icons.tsx (16 x 16 grid, currentColor, decorative).
import type { ReactNode, SVGProps } from 'react'

type P = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" className="lf-icon" {...rest}>
      {children}
    </svg>
  )
}

const S = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** Private / withheld: a closed padlock. */
export function LockIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="3.2" y="7" width="9.6" height="7" rx="1.2" {...S} />
      <path d="M5.4 7V5a2.6 2.6 0 015.2 0v2" {...S} />
    </Svg>
  )
}

/** Shared: an open padlock. */
export function UnlockIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="3.2" y="7" width="9.6" height="7" rx="1.2" {...S} />
      <path d="M5.4 7V5a2.6 2.6 0 015-1" {...S} />
    </Svg>
  )
}

/** In the packet: a check in a square (never a severity shape). */
export function InPacketIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.4" {...S} />
      <path d="M5 8.2l2 2 4-4.4" {...S} />
    </Svg>
  )
}

/** The packet itself: an envelope. */
export function PacketIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.2" {...S} />
      <path d="M2.4 4.2L8 8.6l5.6-4.4" {...S} />
    </Svg>
  )
}

/** Queued: an hourglass. */
export function QueuedIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M4 1.8h8M4 14.2h8M4.8 1.8c0 3.4 6.4 3.4 6.4 6.2s-6.4 2.8-6.4 6.2M11.2 1.8c0 3.4-6.4 3.4-6.4 6.2s6.4 2.8 6.4 6.2" {...S} />
    </Svg>
  )
}

/** Copy to clipboard: two stacked sheets. */
export function CopyIcon(p: P) {
  return (
    <Svg {...p}>
      <rect x="5.2" y="5.2" width="8.6" height="8.6" rx="1.2" {...S} />
      <path d="M10.8 5.2V3.4a1.2 1.2 0 00-1.2-1.2H3.4a1.2 1.2 0 00-1.2 1.2v6.2a1.2 1.2 0 001.2 1.2h1.8" {...S} />
    </Svg>
  )
}

/** Stays on board: a house-like outline (the habitat). */
export function OnboardIcon(p: P) {
  return (
    <Svg {...p}>
      <path d="M2.4 7.6L8 2.6l5.6 5v6H2.4z" {...S} />
      <path d="M6.4 13.6V10h3.2v3.6" {...S} />
    </Svg>
  )
}
