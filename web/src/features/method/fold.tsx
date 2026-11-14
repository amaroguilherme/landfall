// Collapsible Method sections. Each section is a native <details> (closed by default, so the page
// opens on its two-minute version), with its heading and a one-line abstract in the <summary>.
// The open set lives in the page (FoldContext), so a deep link (#/method?s=<id>) and the table of
// contents can open a section before scrolling to it. Find-in-page opens a closed section too.
import { createContext, useContext } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'
import { ChevronIcon } from '../../ui'
import { SectionTitle } from './shared'
import { secNum } from './sections'
import type { SectionId } from './sections'

export interface Fold {
  open: ReadonlySet<string>
  set: (id: string, open: boolean) => void
}

export const FoldContext = createContext<Fold | null>(null)

export function FoldPanel({
  s,
  eyebrow,
  title,
  abstract,
  footer,
  children,
}: {
  s: SectionId
  eyebrow?: ReactNode
  title: ReactNode
  /** One line under the heading, visible while the section is closed. */
  abstract?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  const fold = useContext(FoldContext)
  const id = `m-${s}`
  const isOpen = fold ? fold.open.has(s) : true
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const now = e.currentTarget.open
    if (now !== isOpen) fold?.set(s, now)
  }
  return (
    <section className="lf-panel lf-m-fold" id={id} aria-labelledby={`${id}-h`}>
      <details open={isOpen} onToggle={onToggle}>
        <summary className="lf-panel-head lf-m-fold-head">
          <div className="lf-m-fold-text">
            {eyebrow ? <p className="lf-eyebrow">{eyebrow}</p> : null}
            <h2 id={`${id}-h`} className="lf-panel-title">
              <SectionTitle n={secNum(s)}>{title}</SectionTitle>
            </h2>
            {abstract ? <p className="lf-m-abstract">{abstract}</p> : null}
          </div>
          <span className="lf-m-fold-cue" aria-hidden="true">
            <ChevronIcon size={16} />
            <span className="lf-m-fold-word">{isOpen ? 'Hide' : 'Show'}</span>
          </span>
        </summary>
        <div className="lf-panel-body">{children}</div>
        {footer ? <footer className="lf-panel-foot">{footer}</footer> : null}
      </details>
    </section>
  )
}
