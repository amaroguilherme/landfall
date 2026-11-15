import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { MissionBar } from './app/MissionBar'
import { MissionProvider } from './app/mission'
import { MissionEngine } from './app/model'
import { Nav } from './app/Nav'
import { RouteOutlet, prefetchRoutes } from './app/router'
import { prefetchAllSnapshots } from './app/data'
import { useOfflineReady } from './app/offline'
import { CopyViewLink, UrlState, envFromHash } from './app/UrlState'

function skipToMain(e: MouseEvent<HTMLAnchorElement>) {
  // The hash belongs to the router: focus <main> instead of navigating to "#main".
  e.preventDefault()
  const main = document.getElementById('main')
  main?.focus()
  main?.scrollIntoView()
}

/** After the hero has rendered, warm every route chunk and snapshot so the app works offline. */
function useOfflineWarmup() {
  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (cancelled) return
      void prefetchRoutes().then(() => (cancelled ? undefined : prefetchAllSnapshots()))
    }
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    const t = window.setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 4000 }) : run()), 1500)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [])
}

/**
 * Shown only once the service worker holds a complete copy of this build (app/offline.ts): from then on a
 * reload with the network off works. Never claimed before it is true.
 */
function OfflineIndicator() {
  const ready = useOfflineReady()
  if (!ready) return null
  return (
    <span className="lf-offline" role="status">
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="lf-icon">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Works offline after first load
    </span>
  )
}

export default function App() {
  useOfflineWarmup()
  // A deep link's ?env= (app/UrlState.tsx) is the store's starting environment, so the first render, the
  // first evaluation and the annunciator are already in it. Without ?env this is undefined: the default.
  const [linkedEnv] = useState(() => envFromHash(window.location.hash))
  return (
    <MissionProvider initial={linkedEnv ? { envId: linkedEnv } : undefined}>
      <UrlState />
      <MissionEngine />
      <a className="lf-skip" href="#main" onClick={skipToMain}>
        Skip to content
      </a>
      <MissionBar />
      <Nav />
      <main id="main" className="lf-main" tabIndex={-1}>
        <RouteOutlet mainId="main" />
      </main>
      <footer className="lf-footer">
        <div className="lf-footer-inner">
          <p>
            <strong>LANDFALL</strong> · NASA Space Apps Challenge 2026. Not endorsed by NASA. Not a medical device: no
            diagnosis, no dosing.
          </p>
          <p>
            Crew data is simulated. NASA and NOAA data are real, frozen at build. No backend: everything runs in this browser.{' '}
            <OfflineIndicator />
          </p>
          <CopyViewLink />
        </div>
      </footer>
    </MissionProvider>
  )
}
