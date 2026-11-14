import { useEffect, useRef } from 'react'
import { useRoute } from './location'
import { ROUTES } from './routes'

/** Compact primary navigation to every route; scrolls horizontally on narrow screens. */
export function Nav() {
  const { route } = useRoute()
  const listRef = useRef<HTMLUListElement>(null)
  // On a phone the strip is wider than the screen: keep the current section's tab in view
  // (horizontal scroll of the strip only, instant, never moves the page vertically).
  useEffect(() => {
    const ul = listRef.current
    const a = ul?.querySelector<HTMLElement>('a[aria-current="page"]')
    if (!ul || !a) return
    const u = ul.getBoundingClientRect()
    const r = a.getBoundingClientRect()
    if (r.left < u.left || r.right > u.right) ul.scrollLeft += r.left - u.left - (u.width - r.width) / 2
  }, [route?.id])
  return (
    <nav className="lf-nav" aria-label="Sections">
      <ul ref={listRef}>
        {ROUTES.map((r) => (
          <li key={r.id}>
            <a href={r.navHref} aria-current={route?.id === r.id ? 'page' : undefined}>
              {r.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
