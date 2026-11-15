// ?env= deep links: #/body?env=iss&crew=CM-2&region=muscles opens the body map at ISS for CM-2.
//
// On load and on every hashchange, a ?env= that names one of the four environments (ENVIRONMENTS, from
// engine/rules/environments.json) becomes the mission environment, and only when it differs from the
// current one. An unknown value, and a hash without ?env, change nothing. This module only READS the
// location: it never rewrites the URL or the history, so the back button and a copied URL stay the
// user's. Each view keeps reading its own params (?crew, ?region); this adds the one the store owns.
//
// The other direction is the footer's "Copy link to this view": the current address with
// env=<current environment> merged into the hash query (linkToView), so the link reopens the same
// environment.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui'
import { useMission } from './mission'
import { matchRoute } from './routes'
import { ENVIRONMENTS } from './scenario'
import type { EnvId } from './vocab'

/** The environment a location hash asks for: its ?env= when that is one of ENVIRONMENTS, else null. */
export function envFromHash(hash: string): EnvId | null {
  const raw = matchRoute(hash ?? '').query.env
  if (!raw) return null
  const env = ENVIRONMENTS.find((e) => e.id === raw)
  return env ? env.id : null
}

/**
 * Apply a hash's ?env= to the store: calls `setEnv` only for a valid environment that differs from
 * `current`. Returns the environment it applied, or null when it changed nothing.
 */
export function applyEnvFromHash(hash: string, current: EnvId, setEnv: (id: EnvId) => void): EnvId | null {
  const env = envFromHash(hash)
  if (env === null || env === current) return null
  setEnv(env)
  return env
}

/** What watchEnvParam needs from `window` (tests pass a stand-in). */
export interface UrlWindow {
  readonly location: { readonly hash: string }
  addEventListener(type: 'hashchange', listener: () => void): void
  removeEventListener(type: 'hashchange', listener: () => void): void
}

/**
 * Read ?env= now and on every hashchange of `win`; returns the function that stops listening. It reads
 * `win.location.hash` and nothing else: no write to the location or the history.
 */
export function watchEnvParam(win: UrlWindow, getEnv: () => EnvId, setEnv: (id: EnvId) => void): () => void {
  const sync = () => {
    applyEnvFromHash(win.location.hash, getEnv(), setEnv)
  }
  sync()
  win.addEventListener('hashchange', sync)
  return () => win.removeEventListener('hashchange', sync)
}

/**
 * `href` with env=<env> merged into its hash query: the route and its other params stay, an earlier
 * env is replaced. A page without a route hash (or with a non-route fragment such as "#main") links the
 * hero: "https://…/" -> "https://…/#/?env=iss".
 */
export function linkToView(href: string, env: EnvId): string {
  const cut = href.indexOf('#')
  const page = cut < 0 ? href : href.slice(0, cut)
  const fragment = cut < 0 ? '' : href.slice(cut + 1)
  const route = fragment.startsWith('/') ? fragment : '/'
  const q = route.indexOf('?')
  const path = q < 0 ? route : route.slice(0, q)
  const params = new URLSearchParams(q < 0 ? '' : route.slice(q + 1))
  params.set('env', env)
  return `${page}#${path}?${params.toString()}`
}

/**
 * Mounted once inside <MissionProvider> (App.tsx); renders nothing. The layout effect runs before the
 * first paint, so a deep link never shows the default environment first.
 */
export function UrlState(): null {
  const { state, setEnv } = useMission()
  const envRef = useRef(state.envId)
  useLayoutEffect(() => {
    envRef.current = state.envId
  }, [state.envId])
  useLayoutEffect(() => watchEnvParam(window, () => envRef.current, setEnv), [setEnv])
  return null
}

type CopyState = { kind: 'idle' } | { kind: 'copied'; link: string } | { kind: 'manual'; link: string }

/** How long "Link copied" stays (a UI timing, not a threshold). */
const COPIED_NOTE_MS = 4000

/**
 * The footer's "Copy link to this view": copies linkToView(location.href, current environment) with
 * navigator.clipboard. Where the clipboard is unavailable or refused, it shows the link in a read-only
 * field, selected, to copy by hand.
 */
export function CopyViewLink() {
  const { state } = useMission()
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' })
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (copy.kind === 'manual') {
      field.current?.focus()
      field.current?.select()
    }
    if (copy.kind !== 'copied') return
    const t = window.setTimeout(() => setCopy({ kind: 'idle' }), COPIED_NOTE_MS)
    return () => window.clearTimeout(t)
  }, [copy])

  const onCopy = async () => {
    const link = linkToView(window.location.href, state.envId)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(link)
      setCopy({ kind: 'copied', link })
    } catch {
      setCopy({ kind: 'manual', link })
    }
  }

  // minWidth 0 down the chain (footer item, label, field): without it the field's own width (size, up to 64
  // characters of mono) is the minimum of every flex box around it, and on a phone the page scrolls sideways.
  return (
    <div className="lf-footer-link" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.25em 1em', minWidth: 0 }}>
      {/* no side padding: the label lines up with the footer text above it */}
      <Button variant="ghost" onClick={onCopy} style={{ paddingInline: 0 }}>
        Copy link to this view
      </Button>
      <span role="status">
        {copy.kind === 'copied' ? 'Link copied, with this environment.' : null}
      </span>
      {copy.kind === 'manual' ? (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5em', flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
          <span>The clipboard is not available here; copy this link:</span>
          <input
            ref={field}
            readOnly
            value={copy.link}
            onFocus={(e) => e.currentTarget.select()}
            size={Math.min(64, copy.link.length)}
            style={{
              minWidth: 0,
              maxWidth: '100%',
              padding: '0.25em 0.5em',
              background: 'var(--lf-surface-2)',
              border: '1px solid var(--lf-border-strong)',
              borderRadius: 'var(--lf-radius)',
              fontFamily: 'var(--lf-font-mono)',
            }}
          />
        </label>
      ) : null}
    </div>
  )
}
