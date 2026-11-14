// A native <details> styled like the shell's <Expander>, but controlled and with its body mounted
// only while open: whatever the body fetches is fetched when a reader asks for it, not on page load.
import type { ReactNode } from 'react'
import { ChevronIcon } from '../../ui'

export function LazyDetails({
  summary,
  open,
  onToggle,
  children,
  className,
}: {
  summary: ReactNode
  open: boolean
  onToggle: (open: boolean) => void
  children: ReactNode
  className?: string
}) {
  return (
    <details
      className={['lf-expander', 'lfd-details', className].filter(Boolean).join(' ')}
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open
        if (next !== open) onToggle(next)
      }}
    >
      <summary>
        <ChevronIcon size={14} />
        <span>{summary}</span>
      </summary>
      {open ? <div className="lf-expander-body">{children}</div> : null}
    </details>
  )
}
