// METHOD: the audit trail a NASA SME can verify in two minutes. Every NASA/NOAA number and every
// LANDFALL threshold on this page is read from engine/rules/*.json (bundled at build) or a frozen
// snapshot in /data (same origin). Nothing here is fetched from another site.
import { useCallback, useEffect } from 'react'
import type { MouseEvent } from 'react'
import type { FeatureProps } from '../../app/router'
import { useManifest, useSnapshot } from '../../app/data'
import { EmptyState } from '../../ui'
import { ArchitectureSection } from './ArchitectureSection'
import { DataSection } from './DataSection'
import { GapSection } from './GapSection'
import { LimitationsSection } from './LimitationsSection'
import { LimitsSection } from './LimitsSection'
import { RefusalsSection } from './RefusalsSection'
import { META, PERSONAL, THRESHOLDS } from './rules'
import { Path } from './shared'
import { TiersSection } from './TiersSection'
import './method.css'

const TOC: { s: string; label: string }[] = [
  { s: 'gap', label: 'No NASA alert numbers' },
  { s: 'limits', label: 'FFD, PEL, POL' },
  { s: 'tiers', label: 'Tier A and Tier B' },
  { s: 'refusals', label: 'Refusals' },
  { s: 'data', label: 'Data honesty' },
  { s: 'architecture', label: 'Architecture' },
  { s: 'limitations', label: 'Limitations' },
]

function jumpTo(s: string): void {
  const section = document.getElementById(`m-${s}`)
  if (!section) return
  // The sticky mission bar wraps to several rows on a phone, so measure it rather than rely on
  // the global scroll-padding (which assumes the one-row desktop bar).
  const bar = document.querySelector<HTMLElement>('.lf-missionbar')
  const offset = (bar ? bar.getBoundingClientRect().height : 0) + 8
  window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - offset })
  const heading = document.getElementById(`m-${s}-h`)
  if (heading) {
    heading.setAttribute('tabindex', '-1')
    heading.focus({ preventScroll: true })
  }
}

export default function Method({ query }: FeatureProps) {
  // Deep links (#/method?s=tiers) scroll once the snapshots have settled, so the target does not
  // move as the sections above it fill in.
  const v1 = useSnapshot('std_vol1_requirements')
  const v2 = useSnapshot('std_vol2_requirements')
  const sim = useSnapshot('sim_crew')
  const osdr = useSnapshot('osdr_cmp')
  const manifest = useManifest()
  const settled = [v1.status, v2.status, sim.status, osdr.status, manifest.status].every((s) => s !== 'loading')
  useEffect(() => {
    if (query.s && settled) jumpTo(query.s)
  }, [query.s, settled])
  const onToc = useCallback((e: MouseEvent<HTMLAnchorElement>, s: string) => {
    // Same link twice leaves the hash unchanged: scroll directly as well.
    if (query.s === s) {
      e.preventDefault()
      jumpTo(s)
    }
  }, [query.s])

  const rulesMissing = [
    !META ? 'meta.json' : null,
    !PERSONAL ? 'personal.json' : null,
    !THRESHOLDS ? 'thresholds.json' : null,
  ].filter((x): x is string => !!x)

  return (
    <article className="lf-method">
      <header className="lf-m-head">
        <p className="lf-eyebrow">Method · the audit trail</p>
        <h1>How LANDFALL decides, and what it will not decide</h1>
        <p className="lf-m-intro">
          Written for a two-minute review. Every NASA and NOAA number, and every LANDFALL threshold, on this page is read
          from the rules files (<Path>engine/rules/*.json</Path>) or a frozen snapshot (<Path>/data/*.json</Path>) as the
          page renders. None is typed into the page, and nothing is fetched from another site.
        </p>
        <nav aria-label="On this page" className="lf-m-toc">
          <ol>
            {TOC.map((t, i) => (
              <li key={t.s}>
                <a href={`#/method?s=${t.s}`} onClick={(e) => onToc(e, t.s)}>
                  <span className="lf-m-secnum">{i + 1}</span>
                  {t.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </header>

      {rulesMissing.length > 0 ? (
        <EmptyState kind="missing" title="Rules files missing from this build">
          <p>
            Not bundled: {rulesMissing.map((f) => `engine/rules/${f}`).join(', ')}. The sections that depend on them are
            hidden rather than guessed.
          </p>
        </EmptyState>
      ) : null}

      {META ? <GapSection meta={META} /> : null}
      {META && THRESHOLDS ? <LimitsSection meta={META} thresholds={THRESHOLDS} /> : null}
      {META && PERSONAL && THRESHOLDS ? <TiersSection meta={META} personal={PERSONAL} thresholds={THRESHOLDS} /> : null}
      {META ? <RefusalsSection meta={META} /> : null}
      <DataSection />
      {META ? <ArchitectureSection meta={META} /> : null}
      {PERSONAL && THRESHOLDS ? <LimitationsSection personal={PERSONAL} thresholds={THRESHOLDS} /> : null}
    </article>
  )
}
