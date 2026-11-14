// Location store for the hash router. Features import navigation from HERE
// (import { Link, navigate, useRoute } from '../../app/location'), never from router.tsx,
// so the eagerly bundled hero does not form an import cycle with the route table.
import { useSyncExternalStore } from 'react'
import type { AnchorHTMLAttributes } from 'react'
import { hrefFor, matchRoute } from './routes'
import type { RouteMatch } from './routes'

export { hrefFor, matchRoute }
export type { RouteMatch }

let current: RouteMatch = matchRoute(typeof window === 'undefined' ? '' : window.location.hash)
const listeners = new Set<() => void>()

function onHashChange(): void {
  const h = window.location.hash
  // Only "#/..." hashes are routes; "#main" (skip link) and other fragments are ignored.
  if (h && !h.startsWith('#/')) return
  current = matchRoute(h)
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  if (listeners.size === 1) window.addEventListener('hashchange', onHashChange)
  return () => {
    listeners.delete(l)
    if (listeners.size === 0) window.removeEventListener('hashchange', onHashChange)
  }
}

/** Current route match ({ route, params, query, path }); re-renders on navigation. */
export function useRoute(): RouteMatch {
  return useSyncExternalStore(subscribe, () => current, () => current)
}

/** Programmatic navigation: navigate('/case/spe_shelter'). */
export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const href = hrefFor(path)
  if (opts.replace) {
    window.history.replaceState(null, '', href)
    onHashChange()
  } else {
    window.location.hash = href.slice(1)
  }
}

/** <Link to="/body">Body</Link> renders a plain anchor with a hash href. */
export function Link({ to, ...rest }: { to: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return <a href={hrefFor(to)} {...rest} />
}
