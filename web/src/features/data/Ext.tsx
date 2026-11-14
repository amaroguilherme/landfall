// External link (new tab) with the shell's external-link glyph and an announced "opens in a new tab".
import type { ReactNode } from 'react'
import { ExternalIcon } from '../../ui'

export function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={['lf-ext', className].filter(Boolean).join(' ')}>
      {children}
      <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
