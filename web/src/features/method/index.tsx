// METHOD: the audit trail. It opens on a two-minute version; every section below it is collapsed
// and opens from the table of contents or a deep link (#/method?s=<section>). Every NASA/NOAA number
// and every LANDFALL threshold on this page is read from engine/rules/*.json (bundled at build) or a
// frozen snapshot in /data (same origin). Nothing here is fetched from another site.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import type { FeatureProps } from '../../app/router'
import { useManifest, useSnapshot } from '../../app/data'
import { Button, EmptyState } from '../../ui'
import { ArchitectureSection } from './ArchitectureSection'
import { DataSection } from './DataSection'
import { FoldContext } from './fold'
import type { Fold } from './fold'
import { GapSection } from './GapSection'
import { LimitationsSection } from './LimitationsSection'
import { LimitsSection } from './LimitsSection'
import { RefusalsSection } from './RefusalsSection'
import { META, PERSONAL, THRESHOLDS } from './rules'
import { SECTIONS, SECTION_IDS, isSectionId } from './sections'
import type { SectionId } from './sections'
import { SeveritySection } from './SeveritySection'
import { Path } from './shared'
import { TiersSection } from './TiersSection'
import { TwoMinute } from './TwoMinute'
import './method.css'

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
  // Deep links (#/method?s=tiers) open their section and scroll once the snapshots have settled, so the
  // target does not move as the sections above it fill in.
  const v1 = useSnapshot('std_vol1_requirements')
  const v2 = useSnapshot('std_vol2_requirements')
  const sim = useSnapshot('sim_crew')
  const osdr = useSnapshot('osdr_cmp')
  const manifest = useManifest()
  const settled = [v1.status, v2.status, sim.status, osdr.status, manifest.status].every((s) => s !== 'loading')
  const target = isSectionId(query.s) ? query.s : null

  const [open, setOpenSet] = useState<ReadonlySet<string>>(() => new Set(target ? [target] : []))
  const setOne = useCallback((id: string, isOpen: boolean) => {
    setOpenSet((cur) => {
      if (cur.has(id) === isOpen) return cur
      const next = new Set(cur)
      if (isOpen) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const fold = useMemo<Fold>(() => ({ open, set: setOne }), [open, setOne])

  // Open a section, then scroll to it after the browser has laid it out.
  const openAndJump = useCallback(
    (s: SectionId) => {
      setOne(s, true)
      requestAnimationFrame(() => requestAnimationFrame(() => jumpTo(s)))
    },
    [setOne],
  )
  useEffect(() => {
    if (target && settled) openAndJump(target)
  }, [target, settled, openAndJump])

  const onToc = useCallback(
    (e: MouseEvent<HTMLAnchorElement>, s: SectionId) => {
      // Same link twice leaves the hash unchanged: open and scroll directly as well.
      if (query.s === s) {
        e.preventDefault()
        openAndJump(s)
      }
    },
    [query.s, openAndJump],
  )
  // From the two-minute version: open the section in place (the hash is left alone, so Back still works).
  const onOpen = useCallback((s: SectionId) => openAndJump(s), [openAndJump])
  const allOpen = SECTION_IDS.every((s) => open.has(s))

  const rulesMissing = [!META ? 'meta.json' : null, !PERSONAL ? 'personal.json' : null, !THRESHOLDS ? 'thresholds.json' : null].filter(
    (x): x is string => !!x,
  )

  return (
    <FoldContext.Provider value={fold}>
      <article className="lf-method">
        <header className="lf-m-head">
          <p className="lf-eyebrow">Method · the audit trail</p>
          <h1>Method: limits, decision rules and refusals</h1>
          <p className="lf-m-intro">
            Every NASA and NOAA number, and every LANDFALL threshold, on this page is read from the rules files (
            <Path>engine/rules/*.json</Path>) or a frozen snapshot (<Path>/data/*.json</Path>) as the page renders. None is typed into the
            page, and nothing is fetched from another site.
          </p>
          <TwoMinute meta={META} personal={PERSONAL} thresholds={THRESHOLDS} onOpen={onOpen} />
          <nav aria-label="Sections of this page" className="lf-m-toc">
            <div className="lf-m-toc-head">
              <p className="lf-m-toc-title">The full method, by section (each opens in place)</p>
              <Button variant="secondary" onClick={() => SECTION_IDS.forEach((s) => setOne(s, !allOpen))}>
                {allOpen ? 'Close all sections' : 'Open all sections'}
              </Button>
            </div>
            <ol>
              {SECTIONS.map((t, i) => (
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
              Not bundled: {rulesMissing.map((f) => `engine/rules/${f}`).join(', ')}. The sections that depend on them are hidden rather than
              guessed.
            </p>
          </EmptyState>
        ) : null}

        {META ? <GapSection meta={META} /> : null}
        {META && THRESHOLDS ? <LimitsSection meta={META} thresholds={THRESHOLDS} /> : null}
        {META && PERSONAL && THRESHOLDS ? <TiersSection meta={META} personal={PERSONAL} thresholds={THRESHOLDS} /> : null}
        {META ? <SeveritySection meta={META} /> : null}
        {META ? <RefusalsSection meta={META} /> : null}
        <DataSection />
        {META ? <ArchitectureSection meta={META} /> : null}
        {PERSONAL && THRESHOLDS ? <LimitationsSection personal={PERSONAL} thresholds={THRESHOLDS} /> : null}
      </article>
    </FoldContext.Provider>
  )
}
