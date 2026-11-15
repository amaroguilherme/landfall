import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRoute } from './location'
import { NAV_ROUTES } from './routes'

/** The strip's scroll box, as the DOM reports it (px). */
export interface NavScrollBox {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}

/** Sub-pixel slack: on a phone scrollLeft can be fractional while the widths are whole pixels. */
const SLACK_PX = 1

/**
 * Pure: does the strip overflow its box, and is it scrolled to its right end? A strip that fits is not
 * overflowing (no cue at all); while it overflows, `atEnd` is true once its last tab is fully in the box.
 */
export function navOverflow({ scrollLeft, clientWidth, scrollWidth }: NavScrollBox): { overflows: boolean; atEnd: boolean } {
  const left = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0
  const box = Number.isFinite(clientWidth) ? clientWidth : 0
  const content = Number.isFinite(scrollWidth) ? scrollWidth : 0
  const overflows = box > 0 && content - box > SLACK_PX
  return { overflows, atEnd: overflows && left + box >= content - SLACK_PX }
}

/** Share of the visible strip one press of "More ›" scrolls (a design choice: the last tab of the old view stays in sight). */
const PAGE = 0.8
/** A last page shorter than this share of the box goes straight to the end (a design choice: no press that moves a sliver). */
const END_SNAP = 0.25

/** Pure: where one press of "More ›" scrolls the strip to (px), from the DOM's own numbers. */
export function nextPageLeft({ scrollLeft, clientWidth, scrollWidth }: NavScrollBox): number {
  const max = Math.max(0, scrollWidth - clientWidth)
  const next = Math.max(0, scrollLeft) + clientWidth * PAGE
  return max - next < clientWidth * END_SNAP ? max : Math.round(next)
}

/**
 * Compact primary navigation to every nav route (routes marked nav: false are skipped); scrolls horizontally on
 * narrow screens. While the strip overflows (a phone), its trailing edge fades and a "More ›" button follows it, a
 * flex sibling that never covers a tab: it pages the strip right by 80% of its box (a short last page goes straight to
 * the end), and at the right end reads "‹ Start" and scrolls back. Where the strip fits (a laptop) there is no
 * attribute, no button and no fade.
 */
export function Nav() {
  const { route } = useRoute()
  const listRef = useRef<HTMLUListElement>(null)
  const [state, setState] = useState({ overflows: false, atEnd: false })
  const measure = useCallback(() => {
    const ul = listRef.current
    if (!ul) return
    // The strip's content ends at its last tab, not at its trailing padding: a tab brought into view (keyboard focus
    // scrolls it in) counts as the end, and a strip that overflows by no more than its padding needs no cue.
    const pad = parseFloat(getComputedStyle(ul).paddingRight) || 0
    const next = navOverflow({ scrollLeft: ul.scrollLeft, clientWidth: ul.clientWidth, scrollWidth: ul.scrollWidth - pad })
    setState((prev) => (prev.overflows === next.overflows && prev.atEnd === next.atEnd ? prev : next))
  }, [])
  // On a phone the strip is wider than the screen: keep the current section's tab in view
  // (horizontal scroll of the strip only, instant, never moves the page vertically).
  const centre = useCallback(() => {
    const ul = listRef.current
    const a = ul?.querySelector<HTMLElement>('a[aria-current="page"]')
    if (!ul || !a) return
    const u = ul.getBoundingClientRect()
    const r = a.getBoundingClientRect()
    if (r.left < u.left || r.right > u.right) ul.scrollLeft += r.left - u.left - (u.width - r.width) / 2
  }, [])
  // On mount, before the first paint (no flash of a strip without its cue): measure, then follow every scroll of
  // the strip and every change of its size or of its tabs' (a rotated phone, the web font arriving). The current tab
  // is centred again when the tabs themselves change size (the web font arriving widens them after the route effect
  // below has run) and, through that effect, when the "More ›" button appears and narrows the box: otherwise a deep
  // link (#/data on a phone) opens with its own tab out of sight. A resized box with unchanged tabs (a resized
  // window) is only re-measured, and scrolling or paging changes no size, so the reader's own scrolling is never undone.
  useLayoutEffect(() => {
    const ul = listRef.current
    if (!ul) return
    measure()
    ul.addEventListener('scroll', measure, { passive: true })
    const ro =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            if (entries.some((e) => e.target !== ul)) centre()
            measure()
          })
        : null
    if (ro) {
      ro.observe(ul)
      for (const li of ul.children) ro.observe(li)
    } else window.addEventListener('resize', measure)
    void document.fonts?.ready.then(() => {
      centre()
      measure()
    })
    return () => {
      ul.removeEventListener('scroll', measure)
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', measure)
    }
  }, [centre, measure])
  useEffect(() => {
    centre()
    measure()
  }, [route?.id, state.overflows, centre, measure])
  const page = () => {
    const ul = listRef.current
    if (!ul) return
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    ul.scrollTo({ left: state.atEnd ? 0 : nextPageLeft(ul), behavior })
  }
  return (
    <nav className="lf-nav" aria-label="Sections" data-overflow={state.overflows || undefined} data-at-end={(state.overflows && state.atEnd) || undefined}>
      <ul
        ref={listRef}
        id="lf-nav-list"
        // A tab reached with the keyboard comes fully into view (the browser may stop at "partly visible"), by the
        // strip's own horizontal scroll, never the page's; a tapped tab is left to the route effect above, which centres it.
        onFocus={(e) => {
          const ul = listRef.current
          const el = e.target as HTMLElement
          let keyboard = false
          try {
            keyboard = el.matches(':focus-visible')
          } catch {
            keyboard = false // a browser without :focus-visible
          }
          if (!ul || !keyboard) return
          const u = ul.getBoundingClientRect()
          const r = el.getBoundingClientRect()
          if (r.right > u.right) ul.scrollLeft += r.right - u.right
          else if (r.left < u.left) ul.scrollLeft -= u.left - r.left
        }}
      >
        {NAV_ROUTES.map((r) => (
          <li key={r.id}>
            <a href={r.navHref} aria-current={route?.id === r.id ? 'page' : undefined}>
              {r.label}
            </a>
          </li>
        ))}
      </ul>
      {state.overflows ? (
        <button type="button" className="lf-nav-more" aria-controls="lf-nav-list" aria-label={state.atEnd ? 'Back to the first sections' : 'More sections'} onClick={page}>
          {state.atEnd ? '‹ Start' : 'More ›'}
        </button>
      ) : null}
    </nav>
  )
}
