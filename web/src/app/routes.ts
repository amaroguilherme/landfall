// Route table (no dependency). Pure data + matching, so it can be unit-tested without React.

export type RouteId =
  | 'now'
  | 'body'
  | 'case'
  | 'radiation'
  | 'noon-sight'
  | 'trends'
  | 'downlink'
  | 'band'
  | 'provenance'
  | 'method'
  | 'data'
  | 'card'

export type FeatureName =
  | 'now'
  | 'body'
  | 'cases'
  | 'radiation'
  | 'noon-sight'
  | 'trends'
  | 'downlink'
  | 'band'
  | 'provenance'
  | 'method'
  | 'data'
  | 'cuecard'

export interface RouteDef {
  id: RouteId
  /** Path pattern after "#", e.g. "/case/:id". */
  pattern: string
  /** Folder under src/features/. */
  feature: FeatureName
  /** Short nav label. */
  label: string
  /** document.title prefix. */
  title: string
  /** Href used by the nav. */
  navHref: string
  /** false: a route reached from another view (e.g. the printable cue cards), never a nav item. */
  nav?: boolean
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'now', pattern: '/', feature: 'now', label: 'Now', title: 'Now', navHref: '#/' },
  { id: 'body', pattern: '/body', feature: 'body', label: 'Body', title: 'Body map', navHref: '#/body' },
  { id: 'case', pattern: '/case/:id?', feature: 'cases', label: 'Cases', title: 'Case', navHref: '#/case' },
  { id: 'radiation', pattern: '/radiation', feature: 'radiation', label: 'Radiation', title: 'Radiation', navHref: '#/radiation' },
  { id: 'noon-sight', pattern: '/noon-sight', feature: 'noon-sight', label: 'Noon Sight', title: 'Noon Sight', navHref: '#/noon-sight' },
  { id: 'trends', pattern: '/trends', feature: 'trends', label: 'Trends', title: 'Trends', navHref: '#/trends' },
  { id: 'downlink', pattern: '/downlink', feature: 'downlink', label: 'Downlink', title: 'Ground packet', navHref: '#/downlink' },
  { id: 'band', pattern: '/band', feature: 'band', label: 'Band', title: 'LANDFALL BAND', navHref: '#/band' },
  { id: 'provenance', pattern: '/provenance', feature: 'provenance', label: 'Provenance', title: 'Provenance', navHref: '#/provenance' },
  { id: 'method', pattern: '/method', feature: 'method', label: 'Method', title: 'Method', navHref: '#/method' },
  { id: 'data', pattern: '/data', feature: 'data', label: 'Data', title: 'Data sources', navHref: '#/data' },
  // Printable paper cue cards ([V2 10130]): #/card/<case_id>, or #/card and #/cards for all of them. Opened from
  // the case pages' Print links, so not a nav item.
  { id: 'card', pattern: '/card/:id?', feature: 'cuecard', label: 'Cue cards', title: 'Cue cards', navHref: '#/card', nav: false },
]

/** The routes the nav lists (every route not marked nav: false). */
export const NAV_ROUTES: readonly RouteDef[] = ROUTES.filter((r) => r.nav !== false)

/**
 * Path aliases (first segment): a natural URL that is not a nav entry resolves to its route, e.g.
 * "#/cases" and "#/cases/renal_stone" show the case views (the nav uses "#/case"); "#/cards" is every cue card.
 */
export const ROUTE_ALIASES: Readonly<Record<string, string>> = { cases: 'case', cards: 'card' }

export interface RouteMatch {
  route: RouteDef | null
  /** Path params, e.g. { id: "spe_shelter" } for #/case/spe_shelter. */
  params: Record<string, string>
  /** Query params after "?", e.g. #/trends?crew=CM-3. */
  query: Record<string, string>
  /** Normalised path, e.g. "/case/spe_shelter". */
  path: string
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  const params: Record<string, string> = {}
  const required = p.filter((seg) => !seg.endsWith('?')).length
  if (s.length < required || s.length > p.length) return null
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]
    const val = s[i]
    if (seg.startsWith(':')) {
      const name = seg.replace(/^:/, '').replace(/\?$/, '')
      if (val === undefined) {
        if (!seg.endsWith('?')) return null
        continue
      }
      params[name] = decodeURIComponent(val)
    } else if (seg !== val) {
      return null
    }
  }
  return params
}

/** Parse a location hash ("#/case/spe_shelter?x=1") into a route match. */
export function matchRoute(hash: string): RouteMatch {
  const raw = hash.replace(/^#/, '') || '/'
  const [pathPart, queryPart = ''] = raw.split('?')
  const segs = pathPart.split('/').filter(Boolean)
  if (segs.length && Object.prototype.hasOwnProperty.call(ROUTE_ALIASES, segs[0])) segs[0] = ROUTE_ALIASES[segs[0]]
  const path = '/' + segs.join('/')
  const query: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v
  for (const route of ROUTES) {
    const params = matchPattern(route.pattern, path)
    if (params) return { route, params, query, path }
  }
  return { route: null, params: {}, query, path }
}

/** Build an href for the hash router: hrefFor('/case/spe_shelter') -> "#/case/spe_shelter". */
export function hrefFor(path: string): string {
  return '#' + (path.startsWith('/') ? path : '/' + path)
}
