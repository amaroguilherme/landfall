// Hash router (no dependency). Routes: #/ (hero), #/body, #/case/:id, #/radiation, #/noon-sight, #/trends,
// #/downlink, #/band, #/provenance, #/method, #/data, #/card/:id (printable cue cards) and #/eva (the [V1 6006]
// EVA evidence board); the last two are not in the nav.
// The hero is bundled eagerly; every other
// feature is React.lazy and pre-fetched on idle so navigation keeps working offline.
// Features import navigation helpers from './location', not from this file.
import { Component, Suspense, lazy, useEffect, useRef } from 'react'
import type { ComponentType, ErrorInfo, LazyExoticComponent, ReactNode } from 'react'
import NowFeature from '../features/now'
import { EmptyState } from '../ui'
import { useRoute } from './location'
import type { FeatureName } from './routes'

export { NAV_ROUTES, ROUTES, hrefFor, matchRoute } from './routes'
export type { RouteDef, RouteId, RouteMatch, FeatureName } from './routes'
export { Link, navigate, useRoute } from './location'

/** Every feature's default export receives these props. */
export interface FeatureProps {
  params: Record<string, string>
  query: Record<string, string>
}

type FeatureComponent = ComponentType<FeatureProps>
type LazyName = Exclude<FeatureName, 'now'>

const loaders: Record<LazyName, () => Promise<{ default: FeatureComponent }>> = {
  body: () => import('../features/body'),
  cases: () => import('../features/cases'),
  radiation: () => import('../features/radiation'),
  'noon-sight': () => import('../features/noon-sight'),
  trends: () => import('../features/trends'),
  downlink: () => import('../features/downlink'),
  band: () => import('../features/band'),
  provenance: () => import('../features/provenance'),
  method: () => import('../features/method'),
  data: () => import('../features/data'),
  cuecard: () => import('../features/cuecard'),
  eva: () => import('../features/eva'),
  verify: () => import('../features/verify'),
}

const LAZY = Object.fromEntries(
  Object.entries(loaders).map(([name, load]) => [name, lazy(load)]),
) as Record<LazyName, LazyExoticComponent<FeatureComponent>>

/** Pull every lazy route chunk into memory (called on idle after the hero renders). */
export async function prefetchRoutes(): Promise<void> {
  for (const load of Object.values(loaders)) {
    try {
      await load()
    } catch {
      // Offline or chunk missing: the route's error boundary reports it if visited.
    }
  }
}

// Keyed by route path in RouteOutlet, so navigating away remounts it and clears the error.
class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('LANDFALL route error', error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <EmptyState kind="error" title="This view could not be shown">
          <p>
            The rest of LANDFALL keeps working. If you are offline, this part was not cached before the connection
            dropped. Detail: <code>{this.state.error.message}</code>
          </p>
        </EmptyState>
      )
    }
    return this.props.children
  }
}

function RouteLoading() {
  return (
    <EmptyState kind="loading" title="Opening view">
      <p>Loading this section from the local bundle.</p>
    </EmptyState>
  )
}

/** Renders the matched feature; moves focus to <main> and sets the title on navigation. */
export function RouteOutlet({ mainId = 'main' }: { mainId?: string }) {
  const match = useRoute()
  const first = useRef(true)
  const title = match.route ? match.route.title : 'Not found'
  useEffect(() => {
    document.title = `${title} · LANDFALL`
    if (first.current) {
      first.current = false
      return
    }
    window.scrollTo(0, 0)
    document.getElementById(mainId)?.focus({ preventScroll: true })
  }, [match.path, title, mainId])

  if (!match.route) {
    return (
      <EmptyState kind="unavailable" title="No such view">
        <p>
          <code>#{match.path}</code> is not a LANDFALL route. <a href="#/">Go to Now</a>.
        </p>
      </EmptyState>
    )
  }
  const name = match.route.feature
  const Feature: FeatureComponent = name === 'now' ? (NowFeature as FeatureComponent) : LAZY[name]
  return (
    <RouteErrorBoundary key={match.path}>
      <Suspense fallback={<RouteLoading />}>
        <Feature params={match.params} query={match.query} />
      </Suspense>
    </RouteErrorBoundary>
  )
}
