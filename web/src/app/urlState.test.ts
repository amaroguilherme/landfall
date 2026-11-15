// ?env= deep links (app/UrlState.tsx): a valid env applies, an invalid one is ignored, no param leaves the
// state unchanged, and the location is never rewritten. The store side uses the real missionReducer.
import { describe, expect, it, vi } from 'vitest'
import { applyEnvFromHash, envFromHash, linkToView, watchEnvParam } from './UrlState'
import type { UrlWindow } from './UrlState'
import { initialMissionState, missionReducer } from './mission'
import type { MissionState } from './mission'
import { DEFAULT_ENV, ENVIRONMENTS } from './scenario'
import type { EnvId } from './vocab'

/** The real reducer behind a setEnv spy, as MissionProvider wires it. */
function store(initial: MissionState = initialMissionState()) {
  let state = initial
  const setEnv = vi.fn((envId: EnvId) => {
    state = missionReducer(state, { type: 'setEnv', envId })
  })
  return { get state() { return state }, setEnv, getEnv: () => state.envId }
}

/**
 * A stand-in window whose location and history record every write. `navigate(hash)` is what the browser
 * does on a link click or a typed URL: the hash changes, then 'hashchange' fires.
 */
function fakeWindow(initialHash: string) {
  let hash = initialHash
  const writes: string[] = []
  const listeners = new Set<() => void>()
  const location = {
    get hash() { return hash },
    set hash(v: string) { writes.push(`location.hash=${v}`) },
    get href() { return `https://landfall.test/${hash}` },
    set href(v: string) { writes.push(`location.href=${v}`) },
    assign: (v: string) => writes.push(`location.assign(${v})`),
    replace: (v: string) => writes.push(`location.replace(${v})`),
  }
  const history = {
    pushState: (...a: unknown[]) => writes.push(`history.pushState(${a.join(',')})`),
    replaceState: (...a: unknown[]) => writes.push(`history.replaceState(${a.join(',')})`),
  }
  const win: UrlWindow & { history: typeof history } = {
    location,
    history,
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
  }
  return {
    win,
    writes,
    listeners,
    navigate(next: string) {
      hash = next
      for (const l of [...listeners]) l()
    },
  }
}

describe('envFromHash: ?env= is validated against ENVIRONMENTS (engine/rules/environments.json)', () => {
  it('reads every environment id', () => {
    expect(ENVIRONMENTS.map((e) => e.id)).toEqual(['iss', 'cislunar', 'lunar_surface', 'mars_surface'])
    for (const e of ENVIRONMENTS) expect(envFromHash(`#/body?env=${e.id}`)).toBe(e.id)
  })
  it('reads it next to the other params of the view', () => {
    expect(envFromHash('#/body?env=iss&crew=CM-2&region=muscles')).toBe('iss')
    expect(envFromHash('#/body?crew=CM-2&region=muscles&env=lunar_surface')).toBe('lunar_surface')
    expect(envFromHash('#/?env=cislunar')).toBe('cislunar')
  })
  it('ignores an unknown, misspelled, mis-cased or empty value, and a hash without one', () => {
    for (const h of ['#/body?env=mars', '#/body?env=ISS', '#/body?env=iss%20', '#/body?env=', '#/body?env', '#/body?region=muscles', '#/body', '#/', '', '#main'])
      expect(envFromHash(h)).toBeNull()
  })
})

describe('applyEnvFromHash: setEnv only for a valid env that differs', () => {
  it('a valid env applies', () => {
    const s = store()
    expect(s.state.envId).toBe(DEFAULT_ENV)
    expect(applyEnvFromHash('#/body?env=iss&crew=CM-2&region=muscles', s.getEnv(), s.setEnv)).toBe('iss')
    expect(s.setEnv).toHaveBeenCalledTimes(1)
    expect(s.setEnv).toHaveBeenCalledWith('iss')
    expect(s.state.envId).toBe('iss')
  })
  it('the same env as the current one calls nothing', () => {
    const s = store()
    expect(applyEnvFromHash(`#/body?env=${DEFAULT_ENV}`, s.getEnv(), s.setEnv)).toBeNull()
    expect(s.setEnv).not.toHaveBeenCalled()
  })
  it('an invalid env is ignored: the state is the same object', () => {
    const s = store()
    const before = s.state
    for (const h of ['#/body?env=mars', '#/body?env=Mars_Surface', '#/body?env=moon', '#/body?env=1'])
      expect(applyEnvFromHash(h, s.getEnv(), s.setEnv)).toBeNull()
    expect(s.setEnv).not.toHaveBeenCalled()
    expect(s.state).toBe(before)
  })
  it('no ?env leaves the state unchanged', () => {
    const s = store({ ...initialMissionState(), envId: 'lunar_surface' })
    const before = s.state
    for (const h of ['#/', '#/body?crew=CM-2&region=muscles', '#/case/spe_shelter', '', '#main'])
      expect(applyEnvFromHash(h, s.getEnv(), s.setEnv)).toBeNull()
    expect(s.setEnv).not.toHaveBeenCalled()
    expect(s.state).toBe(before)
    expect(s.state.envId).toBe('lunar_surface')
  })
})

describe('watchEnvParam: on load and on every hashchange, reading the location only', () => {
  it('applies a valid env on load', () => {
    const s = store()
    const w = fakeWindow('#/body?env=iss&crew=CM-2&region=muscles')
    const stop = watchEnvParam(w.win, s.getEnv, s.setEnv)
    expect(s.state.envId).toBe('iss')
    expect(s.setEnv).toHaveBeenCalledTimes(1)
    stop()
    expect(w.writes).toEqual([])
  })
  it('applies a valid env on hashchange, ignores an invalid one, and does nothing without ?env', () => {
    const s = store()
    const w = fakeWindow('#/')
    const stop = watchEnvParam(w.win, s.getEnv, s.setEnv)
    expect(s.setEnv).not.toHaveBeenCalled() // no ?env on load
    const untouched = s.state

    w.navigate('#/body?env=nowhere')
    expect(s.state).toBe(untouched)

    w.navigate('#/body?region=heart')
    expect(s.state).toBe(untouched)

    w.navigate('#/body?env=iss&crew=CM-2')
    expect(s.state.envId).toBe('iss')

    // the user switches environment in the mission bar; a later hash without ?env keeps that choice
    s.setEnv('lunar_surface')
    s.setEnv.mockClear()
    w.navigate('#/trends?crew=CM-3')
    expect(s.state.envId).toBe('lunar_surface')
    expect(s.setEnv).not.toHaveBeenCalled()

    // a hash that repeats the current env calls nothing
    w.navigate('#/body?env=lunar_surface')
    expect(s.setEnv).not.toHaveBeenCalled()

    w.navigate('#/case/spe_shelter?env=mars_surface')
    expect(s.state.envId).toBe('mars_surface')
    expect(s.setEnv).toHaveBeenCalledTimes(1)

    stop()
    expect(w.listeners.size).toBe(0)
    w.navigate('#/body?env=iss')
    expect(s.state.envId).toBe('mars_surface') // stopped: no longer listening
    expect(w.writes).toEqual([]) // never a write to location or history
  })
})

describe('linkToView: the footer link merges env=<current env> into the hash query', () => {
  const base = 'https://landfall.landfall-web.workers.dev/'
  it('keeps the route and its params, adds or replaces env', () => {
    expect(linkToView(`${base}#/body?region=muscles`, 'iss')).toBe(`${base}#/body?region=muscles&env=iss`)
    expect(linkToView(`${base}#/body?env=mars_surface&crew=CM-2&region=heart`, 'iss')).toBe(`${base}#/body?env=iss&crew=CM-2&region=heart`)
    expect(linkToView(`${base}#/case/spe_shelter`, 'mars_surface')).toBe(`${base}#/case/spe_shelter?env=mars_surface`)
    expect(linkToView(`${base}#/provenance?chip=design+choice`, 'cislunar')).toBe(`${base}#/provenance?chip=design+choice&env=cislunar`)
  })
  it('links the hero when the page has no route hash', () => {
    expect(linkToView(base, 'iss')).toBe(`${base}#/?env=iss`)
    expect(linkToView(`${base}#main`, 'lunar_surface')).toBe(`${base}#/?env=lunar_surface`)
    expect(linkToView(`${base}#`, 'iss')).toBe(`${base}#/?env=iss`)
  })
  it('round-trips through envFromHash for every environment', () => {
    for (const e of ENVIRONMENTS) {
      const link = linkToView(`${base}#/body?crew=CM-2`, e.id)
      expect(envFromHash(new URL(link).hash)).toBe(e.id)
    }
  })
})
