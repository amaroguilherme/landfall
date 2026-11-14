import { useEffect } from 'react'
import type { RefObject } from 'react'

/** Close a <details> popover on outside click or Escape (focus returns to its summary). */
export function useDismissableDetails(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current
      if (el?.open && e.target instanceof Node && !el.contains(e.target)) el.open = false
    }
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (e.key === 'Escape' && el?.open) {
        el.open = false
        el.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref])
}
