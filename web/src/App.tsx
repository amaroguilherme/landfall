import { useEffect } from 'react'
import type { MouseEvent } from 'react'
import { MissionBar } from './app/MissionBar'
import { MissionProvider } from './app/mission'
import { MissionEngine } from './app/model'
import { Nav } from './app/Nav'
import { RouteOutlet, prefetchRoutes } from './app/router'
import { prefetchAllSnapshots } from './app/data'

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

export default function App() {
  useOfflineWarmup()
  return (
    <MissionProvider>
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
          <p>Crew data is simulated. NASA and NOAA data are real, frozen at build. Runs offline; no backend.</p>
        </div>
      </footer>
    </MissionProvider>
  )
}
