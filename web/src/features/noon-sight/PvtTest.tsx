// The PVT-B run itself. Timing never goes through React state:
//   - stimulus onset = performance.now() inside the requestAnimationFrame callback that draws it;
//   - response time  = the input event's timeStamp (same clock as performance.now());
//   - the counter and the box state are written straight to the DOM through refs.
// Protocol (Basner, Mollicone & Dinges 2011, see pvt.ts): random 1-4 s between stimuli including
// the 1 s RT feedback; a press with no stimulus, or RT < 100 ms, is a false start; 30 s without
// a response is a lapse with a 30 s RT. Stimuli start only inside the test duration; one still
// showing when the time is up is answered (or times out) before the run ends (design choice).
// The PC version of the PVT used a yellow counter in a red box; LANDFALL draws a white counter
// because red and yellow are reserved for Warning and Caution (NASA-STD-3001 Vol 2 Appendix F).
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { Button } from '../../ui'
import { PVT_B, drawIsiMs } from './pvt'
import type { PvtEvent } from './pvt'

type Phase = 'ready' | 'wait' | 'stimulus' | 'feedback' | 'done'

export interface PvtRun {
  events: PvtEvent[]
  durationMs: number
  /** Wall-clock length of the run, ms (>= durationMs when the last stimulus ran over). */
  elapsedMs: number
}

const isSpace = (e: KeyboardEvent | ReactKeyboardEvent) => e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar'

/** Event timestamps share performance.now()'s clock in current browsers; fall back if one looks off. */
function eventTime(ts: number | undefined): number {
  const now = performance.now()
  return typeof ts === 'number' && ts > 0 && ts <= now + 1 && now - ts < 1000 ? ts : now
}

export function PvtTest({
  durationMs,
  demo,
  onComplete,
  onAbort,
}: {
  durationMs: number
  demo: boolean
  onComplete: (run: PvtRun) => void
  onAbort: (reason: string) => void
}) {
  const [running, setRunning] = useState(false)
  const boxRef = useRef<HTMLButtonElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const unitRef = useRef<HTMLSpanElement | null>(null)
  const barRef = useRef<HTMLSpanElement | null>(null)
  const engine = useRef<{ press: (ts?: number) => void; abort: (reason: string) => void } | null>(null)
  const callbacks = useRef({ onComplete, onAbort })
  useEffect(() => {
    callbacks.current = { onComplete, onAbort }
  })

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let phase: Phase = 'ready'
    let startT = 0
    let endT = 0
    let nextOnset: number | null = null
    let onsetT = 0
    let feedbackUntil = 0
    let raf = 0
    const events: PvtEvent[] = []

    const show = (state: string, text: string, unit = '') => {
      const box = boxRef.current
      if (box) box.dataset.state = state
      if (textRef.current) textRef.current.textContent = text
      if (unitRef.current) unitRef.current.textContent = unit
    }

    /** Start a new inter-stimulus interval at `from` (it includes the 1 s feedback). */
    const schedule = (from: number) => {
      const onset = from + drawIsiMs()
      nextOnset = onset < endT ? onset : null
    }

    const feedback = (now: number, state: string, text: string, unit = '') => {
      phase = 'feedback'
      feedbackUntil = now + PVT_B.feedbackMs
      show(state, text, unit)
    }

    const finish = () => {
      phase = 'done'
      cancelAnimationFrame(raf)
      show('done', 'Done')
      setRunning(false)
      callbacks.current.onComplete({ events: events.slice(), durationMs, elapsedMs: performance.now() - startT })
    }

    const frame = () => {
      const now = performance.now()
      if (phase === 'stimulus') {
        const elapsed = now - onsetT
        if (elapsed >= PVT_B.timeoutMs) {
          events.push({ kind: 'timeout', t_ms: now - startT })
          feedback(now, 'timeout', 'No response')
          schedule(now)
        } else if (!reduceMotion && textRef.current) {
          textRef.current.textContent = String(Math.floor(elapsed)).padStart(3, '0')
        }
      } else if (phase === 'feedback' || phase === 'wait') {
        if (phase === 'feedback' && now >= feedbackUntil) {
          phase = 'wait'
          show('wait', '')
        }
        if (nextOnset !== null && now >= nextOnset) {
          nextOnset = null
          phase = 'stimulus'
          show('stimulus', reduceMotion ? 'NOW' : '000', reduceMotion ? '' : 'ms')
          onsetT = performance.now() // drawn in this frame; error is about one display frame
        } else if (nextOnset === null && now >= endT && now >= feedbackUntil) {
          finish()
          return
        }
      }
      if (barRef.current) {
        const f = Math.min(1, (now - startT) / durationMs)
        barRef.current.style.transform = `scaleX(${f})`
      }
      raf = requestAnimationFrame(frame)
    }

    const start = (t: number) => {
      phase = 'wait'
      startT = t
      endT = t + durationMs
      feedbackUntil = t
      schedule(t)
      show('wait', '')
      setRunning(true)
      raf = requestAnimationFrame(frame)
    }

    const press = (ts?: number) => {
      const t = eventTime(ts)
      if (phase === 'ready') {
        start(t)
        return
      }
      if (phase === 'done') return
      if (phase === 'stimulus' && t >= onsetT) {
        const rt = t - onsetT
        events.push({ kind: 'response', rt_ms: rt, t_ms: t - startT })
        if (rt < PVT_B.minValidRtMs) feedback(t, 'false-start', 'Too soon')
        else feedback(t, 'rt', String(Math.round(rt)), 'ms')
        schedule(t)
        return
      }
      // A press with no stimulus on screen: a false start. The wait restarts (design choice).
      events.push({ kind: 'no_stimulus', t_ms: t - startT })
      if (phase === 'stimulus') phase = 'wait' // pressed before the stimulus was drawn
      feedback(t, 'false-start', 'Too soon')
      schedule(t)
    }

    const abort = (reason: string) => {
      if (phase === 'done') return
      const wasRunning = phase !== 'ready'
      phase = 'done'
      cancelAnimationFrame(raf)
      setRunning(false)
      if (wasRunning) callbacks.current.onAbort(reason)
    }

    const onKey = (e: KeyboardEvent) => {
      if (phase === 'ready' || phase === 'done') return
      if (isSpace(e)) {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) press(e.timeStamp)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        abort('You stopped the test. Nothing was recorded.')
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        abort('The test stopped because the page was hidden (another tab, or the screen locked). Nothing was recorded.')
      }
    }

    engine.current = { press, abort }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('visibilitychange', onVisibility)
    show('ready', demo ? 'Press SPACE or tap here to start the demo run' : 'Press SPACE or tap here to start')
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('visibilitychange', onVisibility)
      cancelAnimationFrame(raf)
      phase = 'done'
      engine.current = null
    }
  }, [durationMs, demo])

  useEffect(() => {
    // Bring the whole box into view (on a phone it starts below the fold), then focus it so
    // SPACE starts the test.
    boxRef.current?.scrollIntoView({ block: 'center' })
    boxRef.current?.focus({ preventScroll: true })
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    boxRef.current?.focus({ preventScroll: true })
    engine.current?.press(e.timeStamp)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Before the run starts, only the focused box starts it (SPACE or ENTER). During the run the
    // window-level listener above owns SPACE, so this handler must not double count.
    if (running) return
    if (isSpace(e) || e.key === 'Enter') {
      e.preventDefault()
      if (!e.repeat) engine.current?.press(e.timeStamp)
    }
  }

  const seconds = Math.round(durationMs / 1000)
  return (
    <div className="ns-pvt" data-demo={demo || undefined}>
      <div className="ns-pvt-head">
        <p className="ns-pvt-mode">
          {demo ? (
            <>
              <strong>Demo run, {seconds} s.</strong> Not the validated 3-minute protocol: the result is shown, never recorded.
            </>
          ) : (
            <>
              <strong>PVT-B, 3 minutes.</strong> Keep your eyes on the box until it ends.
            </>
          )}
        </p>
        <Button variant="secondary" onClick={() => engine.current?.abort('You stopped the test. Nothing was recorded.')}>
          Stop <kbd className="ns-kbd">Esc</kbd>
        </Button>
      </div>
      <button
        ref={boxRef}
        type="button"
        className="ns-pvt-box"
        data-state="ready"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        aria-describedby="ns-pvt-help"
      >
        <span className="ns-pvt-readout" aria-hidden="true">
          <span ref={textRef} className="ns-pvt-text" />
          <span ref={unitRef} className="ns-pvt-unit" />
        </span>
        <span className="sr-only">
          {running ? 'PVT-B running. Press space when the counter appears.' : 'Reaction-time test box. Press space or enter to start.'}
        </span>
      </button>
      <span className="ns-pvt-progress" aria-hidden="true">
        <span ref={barRef} className="ns-pvt-progress-bar" />
      </span>
      <p id="ns-pvt-help" className="ns-pvt-help">
        A white counter appears at random, every 1 to 4 seconds. Press <kbd className="ns-kbd">Space</kbd> or tap the box
        the moment you see it. Pressing early counts as a false start. This is a visual test.
      </p>
      <p className="sr-only" aria-live="polite">
        {running ? 'Test started.' : ''}
      </p>
    </div>
  )
}
