// "Print cue card" links for the case pages, each with the rules digest next to it, and the digest hook
// the cue card view shares. Small on purpose: the cases chunk imports this file, not the card view.
import { useEffect, useState } from 'react'
import { RULES } from '../../app/engine'
import { ButtonLink } from '../../ui'
import { TEMPLATE, fill, rulesDigest, shortDigest } from './model'

export interface DigestState {
  status: 'loading' | 'ready' | 'unavailable'
  /** Full hex SHA-256 of the canonical rules, or null. */
  hex: string | null
}

// One computation per session: the rules are bundled, so the digest cannot change while the app runs.
let resolved: DigestState | null = null
let pending: Promise<DigestState> | null = null

function computeDigest(): Promise<DigestState> {
  if (!pending) {
    pending = rulesDigest(RULES)
      .then((hex): DigestState => (hex ? { status: 'ready', hex } : { status: 'unavailable', hex: null }))
      .catch((): DigestState => ({ status: 'unavailable', hex: null }))
      .then((s) => (resolved = s))
  }
  return pending
}

/** The rules digest (SHA-256 via crypto.subtle), computed once and shared by every view. */
export function useRulesDigest(): DigestState {
  const [state, setState] = useState<DigestState>(() => resolved ?? { status: 'loading', hex: null })
  useEffect(() => {
    if (resolved) {
      setState(resolved)
      return
    }
    let live = true
    void computeDigest().then((s) => {
      if (live) setState(s)
    })
    return () => {
      live = false
    }
  }, [])
  return state
}

/** "rules 1a2b3c4d5e6f" (the first 12 hex), as printed on the card. */
export function DigestText({ digest }: { digest: DigestState }) {
  if (!digest.hex) {
    return <span className="lf-mono">{fill(TEMPLATE.linkDigest, { digest: digest.status === 'loading' ? '…' : TEMPLATE.digestNone })}</span>
  }
  return (
    <span className="lf-mono" title={`SHA-256 of the canonical rules: ${digest.hex}`}>
      {fill(TEMPLATE.linkDigest, { digest: shortDigest(digest.hex) })}
    </span>
  )
}

/** A Print link to one case's cue card (caseId) or to all of them (#/cards), with the rules digest. */
export function PrintCardLink({ caseId }: { caseId?: string }) {
  const digest = useRulesDigest()
  const n = RULES.cases?.cases.length ?? 0
  const href = caseId ? `#/card/${caseId}` : '#/cards'
  const label = caseId ? TEMPLATE.printOne : fill(TEMPLATE.printAll, { n: String(n) })
  return (
    <p className="lf-cue-printlink" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.25rem 0.75rem', margin: '0.5rem 0 0.75rem' }}>
      <ButtonLink href={href} variant="secondary">
        {label}
      </ButtonLink>
      <span style={{ fontSize: 'var(--lf-text-xs)', color: 'var(--lf-text-muted)' }}>
        <DigestText digest={digest} />
      </span>
    </p>
  )
}
