// Manual numeric entry for the case views: a number of zero or more, a typing check against a
// plausible range (design choice, never a clinical limit) with a confirmation that repeats the value
// and unit, and an undo window. The mission store has no "remove observation" action, so an entry is
// HELD for a few seconds before it is committed: Undo drops it. Leaving the page commits what is held
// (the crew pressed Log). The held entries live in one provider per case view, so the same step shown
// in the status card and in the procedure list shows one pending entry, never two.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Chip, Num } from '../../ui'
import { fmtValue } from './helpers'
import { checkPlausible } from './model'

/** How long a typed value is held before it is logged (Undo works until then). */
const HOLD_MS = 5000
const HOLD_S = HOLD_MS / 1000

interface Held {
  key: string
  value: number
  unit: string
  commit: () => void
}

interface PendingApi {
  held: Readonly<Record<string, Held>>
  stage: (h: Held) => void
  /** Drop a held entry; returns it (so the field can show the value again), or null. */
  undo: (key: string) => Held | null
}

const PendingCtx = createContext<PendingApi | null>(null)

/** One per case view. Unmounting it (another case or crewmember, another route) commits what is held. */
export function PendingEntries({ children }: { children: ReactNode }) {
  const [held, setHeld] = useState<Record<string, Held>>({})
  const ref = useRef<Record<string, Held>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const drop = useCallback((key: string): Held | null => {
    const h = ref.current[key] ?? null
    if (timers.current[key]) clearTimeout(timers.current[key])
    delete timers.current[key]
    if (h) {
      const next = { ...ref.current }
      delete next[key]
      ref.current = next
      setHeld(next)
    }
    return h
  }, [])
  const stage = useCallback(
    (h: Held) => {
      drop(h.key)
      ref.current = { ...ref.current, [h.key]: h }
      setHeld(ref.current)
      timers.current[h.key] = setTimeout(() => {
        const cur = drop(h.key)
        if (cur) cur.commit()
      }, HOLD_MS)
    },
    [drop],
  )
  useEffect(
    () => () => {
      // leaving the case view: commit what is still held, then forget it
      const all = Object.values(ref.current)
      for (const k of Object.keys(timers.current)) clearTimeout(timers.current[k])
      timers.current = {}
      ref.current = {}
      for (const h of all) h.commit()
    },
    [],
  )
  const api = useMemo<PendingApi>(() => ({ held, stage, undo: drop }), [held, stage, drop])
  return <PendingCtx.Provider value={api}>{children}</PendingCtx.Provider>
}

function usePending(): PendingApi {
  const ctx = useContext(PendingCtx)
  if (!ctx) throw new Error('NumberEntry must sit inside <PendingEntries>')
  return ctx
}

const focusById = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus())

export function NumberEntry({
  label,
  variable,
  unit,
  submitLabel,
  onCommit,
  pendingKey,
  idPrefix,
}: {
  label: ReactNode
  variable: string
  unit: string
  submitLabel: string
  /** Called once, when the held value is committed. */
  onCommit: (v: number) => void
  /** Shared by every place that logs the same thing (e.g. `step:r1`), so they show one held entry. */
  pendingKey: string
  /** Unique per rendered instance (DOM ids). */
  idPrefix: string
}) {
  const { held, stage, undo } = usePending()
  const [raw, setRaw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ value: number; side: 'low' | 'high' } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const commitRef = useRef(onCommit)
  useEffect(() => {
    commitRef.current = onCommit
  })
  const id = `lfc-in-${idPrefix}-${pendingKey.replace(/\W+/g, '-')}`
  const mine = held[pendingKey] ?? null
  const range = checkPlausible(variable, unit, 0).range

  const hold = (value: number) => {
    setConfirm(null)
    setRaw('')
    setNote(null)
    stage({ key: pendingKey, value, unit, commit: () => commitRef.current(value) })
    focusById(`${id}-undo`)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const v = Number(raw.trim().replace(/,/g, ''))
    if (raw.trim() === '' || !Number.isFinite(v) || v < 0) {
      setErr('Enter a number of zero or more.')
      return
    }
    setErr(null)
    const c = checkPlausible(variable, unit, v)
    if (!c.ok && c.side) {
      setConfirm({ value: v, side: c.side })
      focusById(`${id}-yes`)
      return
    }
    hold(v)
  }

  if (mine) {
    return (
      <div className="lfc-held" role="status">
        <p className="lfc-held-text">
          Logging <Num value={mine.value} unit={mine.unit} /> in {HOLD_S} s.
        </p>
        <span className="lfc-held-bar" aria-hidden="true" />
        <Button
          id={`${id}-undo`}
          variant="secondary"
          onClick={() => {
            const h = undo(pendingKey)
            if (h) {
              setRaw(String(h.value))
              setNote(`Undone: ${fmtValue(h.value, h.unit)} was not logged. Correct it and log again.`)
              focusById(id)
            }
          }}
        >
          Undo
        </Button>
      </div>
    )
  }

  if (confirm && range) {
    return (
      <div className="lfc-confirm" role="group" aria-labelledby={`${id}-q`}>
        <p id={`${id}-q`} className="lfc-confirm-q" role="alert">
          You typed <strong>{fmtValue(confirm.value, unit)}</strong>, {confirm.side === 'low' ? 'below' : 'above'} the expected{' '}
          <Num value={range.min} />–<Num value={range.max} unit={unit} />. Log <strong>{fmtValue(confirm.value, unit)}</strong> anyway?
        </p>
        <p className="lfc-fine">
          {range.why} A typing check, not a clinical limit. <Chip kind={range.chip} />
        </p>
        <div className="lfc-entry-actions">
          <Button id={`${id}-yes`} variant="secondary" onClick={() => hold(confirm.value)}>
            Yes, log {fmtValue(confirm.value, unit)}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRaw(String(confirm.value))
              setConfirm(null)
              focusById(id)
            }}
          >
            No, change it
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form className="lfc-entry" onSubmit={submit}>
      <label htmlFor={id}>{label}</label>
      <span className="lfc-entry-field">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-invalid={err ? true : undefined}
          aria-describedby={`${id}-note`}
        />
        <span className="lf-mono">{unit}</span>
      </span>
      <Button type="submit" variant="secondary">
        {submitLabel}
      </Button>
      {err ? (
        <span className="lfc-err" role="alert">
          {err}
        </span>
      ) : null}
      {note ? (
        <span className="lfc-fine lfc-entry-note" role="status">
          {note}
        </span>
      ) : null}
      <span id={`${id}-note`} className="lfc-fine lfc-entry-note">
        {range ? (
          <>
            Typing check: <Num value={range.min} />–<Num value={range.max} unit={unit} /> <Chip kind={range.chip} />; outside it you confirm.{' '}
          </>
        ) : null}
        Held {HOLD_S} s before it is logged, so you can undo.
      </span>
    </form>
  )
}
