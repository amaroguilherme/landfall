// The hero's one-time autoplay: a clock of elapsed ms since the sequence started. It ticks with
// setTimeout (not requestAnimationFrame) so it also advances in throttled tabs and under headless
// virtual time; fades are computed from `elapsed` in JS, so every frame is deterministic.
// Played once per page load (module state: a route change or a StrictMode re-mount does not
// restart it). prefers-reduced-motion: the final state at once; "Replay" steps through it
// without motion (fades become steps).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { SEQUENCE } from './model'

const QUERY = '(prefers-reduced-motion: reduce)'
const TICK_MS = 16

function subscribeMotion(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

/** True when the user asked the system for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(QUERY).matches,
    () => false,
  )
}

/** performance.now() when the sequence (auto or replay) started; -Infinity = final state at once. */
let startedAt: number | null = null
const startListeners = new Set<() => void>()

function setStarted(v: number): void {
  startedAt = v
  for (const l of startListeners) l()
}

function subscribeStart(l: () => void): () => void {
  startListeners.add(l)
  return () => startListeners.delete(l)
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export interface HeroSequence {
  /** ms since the sequence started (Infinity once skipped or shown final at once). */
  elapsed: number
  playing: boolean
  reduced: boolean
  replay: () => void
  skip: () => void
  /** 0..1 progress of a fade that starts at `start` ms and lasts `dur` ms (a step under reduced motion). */
  fade: (start: number, dur: number) => number
}

/** Starts once `ready` is true (the first time in this page load). */
export function useHeroSequence(ready: boolean): HeroSequence {
  const reduced = useReducedMotion()
  const start = useSyncExternalStore(subscribeStart, () => startedAt, () => startedAt)
  const [now, setNow] = useState<number>(nowMs)

  // Start once per page load, the first time the hero is ready (an external store, not state).
  useEffect(() => {
    if (!ready || startedAt !== null) return
    setStarted(reduced ? Number.NEGATIVE_INFINITY : nowMs())
  }, [ready, reduced])

  const elapsed = start === null ? 0 : Math.max(0, now - start)
  const playing = start !== null && elapsed < SEQUENCE.doneAt

  useEffect(() => {
    if (!playing) return
    const id = window.setTimeout(() => setNow(nowMs()), TICK_MS)
    return () => window.clearTimeout(id)
  }, [playing, now])

  const replay = useCallback(() => {
    const t = nowMs()
    setStarted(t)
    setNow(t)
  }, [])

  const skip = useCallback(() => {
    setStarted(Number.NEGATIVE_INFINITY)
    setNow(nowMs())
  }, [])

  const fade = (s: number, dur: number): number => {
    if (reduced || dur <= 0) return elapsed >= s ? 1 : 0
    return Math.min(1, Math.max(0, (elapsed - s) / dur))
  }

  return { elapsed, playing, reduced, replay, skip, fade }
}
