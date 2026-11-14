// #/body - the clickable body figure (the challenge statement's own UI example: "a human figure
// where each part of the body is clickable and displays information about its function and
// health status"). Region selection lives in the query string (#/body?region=kidneys, and
// ?crew=CM-2 picks the crewmember), so any view can deep-link to a region and the back button is
// not flooded (selection replaces).
//
// Status comes from the mission model (useEvaluation, useCases): the same engine findings and case
// states the annunciator, Trends and the case view use. meta.json body_region_rule decides what each
// one means here (D6): an organ is FILLED only by measured findings of the selected crewmember; an
// open case OUTLINES its hazard footprint (hatched, never a severity fill); VO2max is a whole-body
// fitness tag, not a heart, lung or muscle finding.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { hrefFor, navigate } from '../../app/location'
import { useMission } from '../../app/mission'
import { useCases, useEvaluation } from '../../app/model'
import type { FeatureProps } from '../../app/router'
import { environment } from '../../app/scenario'
import { crewMember, isCrewId } from '../../app/vocab'
import { SimulatedMarker } from '../../ui'
import './body.css'
import { BodyFigure } from './Figure'
import { FitnessTagCard, RegionPanel, RegionStateBadge } from './RegionPanel'
import { REGIONS, casesForRegion, isRegionId, regionDef } from './regions'
import type { RegionId } from './regions'
import { BODY_REGION_RULE, CASES, THRESHOLD_RULES } from './rules'
import type { CaseDef } from './rules'
import { STATE_LABEL, defaultRegion, fitnessTag, footprintFor, regionIndicatorRows, regionRuleRows, summarizeRegion, summaryInputs } from './status'
import type { FootprintCase, IndicatorRow, RegionState, RegionSummary, RuleRow } from './status'

const regionHref = (id: RegionId) => hrefFor(`/body?region=${id}`)
const Figure = memo(BodyFigure)
const Panel = memo(RegionPanel)
/** Fill states that can occur on an organ (LANDFALL's only Warning, the S3 storm, never fills one). */
const LEGEND: RegionState[] = ['caution', 'advisory', 'nominal', 'no_data', 'unmonitored']

interface RegionEval {
  ruleRows: RuleRow[]
  indicatorRows: IndicatorRow[]
  cases: CaseDef[]
  summary: RegionSummary
  footprint: FootprintCase[]
}

export default function BodyMap({ query }: FeatureProps) {
  const { state, setCrew } = useMission()
  const { envId, crewId } = state
  const evaluation = useEvaluation()
  const crewEval = evaluation.evaluation?.crew[crewId] ?? null
  const { cases: caseViews } = useCases()
  const [preview, setPreview] = useState<RegionId | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // #/body?crew=CM-2 selects the crewmember (deep links from other views, the video, the audit path).
  const qCrew = query.crew
  useEffect(() => {
    if (isCrewId(qCrew) && qCrew !== state.crewId) setCrew(qCrew)
    // only when the query changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qCrew])

  const evals = useMemo(() => {
    const out = {} as Record<RegionId, RegionEval>
    for (const region of REGIONS) {
      const ruleRows = regionRuleRows(region, crewEval, envId)
      const indicatorRows = regionIndicatorRows(region, crewEval)
      out[region.id] = {
        ruleRows,
        indicatorRows,
        cases: casesForRegion(region.id, CASES ?? []),
        summary: summarizeRegion(summaryInputs(ruleRows, indicatorRows)),
        footprint: footprintFor(region.id, caseViews, crewId),
      }
    }
    return out
  }, [crewEval, envId, caseViews, crewId])

  const states = useMemo(() => {
    const s = {} as Record<RegionId, RegionState>
    for (const r of REGIONS) s[r.id] = evals[r.id].summary.state
    return s
  }, [evals])
  const footprint = useMemo(() => {
    const f: Partial<Record<RegionId, boolean>> = {}
    for (const r of REGIONS) if (evals[r.id].footprint.length) f[r.id] = true
    return f
  }, [evals])
  const fitness = useMemo(() => fitnessTag(crewEval, envId), [crewEval, envId])

  const selected: RegionId = isRegionId(query.region) ? query.region : defaultRegion(states)
  const def = regionDef(selected)
  const ev = evals[selected]
  const crew = crewMember(crewId)
  const env = environment(envId)
  const shown = preview ?? selected
  const caseViewsOfCrew = useMemo(() => caseViews.filter((v) => v.crewId === crewId), [caseViews, crewId])

  const select = useCallback((id: RegionId, e: MouseEvent<Element>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
    e.preventDefault()
    navigate(`/body?region=${id}`, { replace: true })
    // On a single-column layout the panel is below the fold: bring it into view.
    if (window.matchMedia('(max-width: 1023px)').matches) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }))
    }
  }, [])

  const unavailable = evaluation.status === 'missing' || evaluation.status === 'error'

  return (
    <div className="lf-body">
      <header className="lf-body-head">
        <p className="lf-eyebrow">
          {crew.id} · {crew.role} · {env.label}
        </p>
        <h1>Body map</h1>
        <p className="lf-body-lede">
          Pick a part of the body to see what it does, how spaceflight affects it (in NASA’s words), what can be measured in
          space and how, which NASA limits apply, and when it needs the Crew Medical Officer or the flight surgeon.
        </p>
        <SimulatedMarker variant="banner">
          Region status uses the simulated crew. NASA HRP text, NASA limits and Inspiration4 lab data are real.
        </SimulatedMarker>
        {unavailable ? (
          <p className="lf-body-fine lf-region-shim" role="status">
            The mission evaluation is unavailable ({evaluation.error ?? 'sim_crew.json is not in this build'}), so every region shows as
            insufficient data instead of guessing.
          </p>
        ) : null}
      </header>

      <div className="lf-body-layout">
        <div className="lf-body-nav">
          <nav aria-label="Body regions" className="lf-body-list">
            <ul>
              {REGIONS.map((r) => (
                <li key={r.id}>
                  <a
                    href={regionHref(r.id)}
                    aria-current={r.id === selected ? 'true' : undefined}
                    data-state={states[r.id]}
                    onClick={(e) => select(r.id, e)}
                    onMouseEnter={() => setPreview(r.id)}
                    onMouseLeave={() => setPreview(null)}
                  >
                    <span className="lf-body-list-name">{r.short}</span>
                    <RegionStateBadge state={states[r.id]} size="sm" />
                    {footprint[r.id] ? (
                      <span className="lf-foot-tag" title="In the hazard footprint of an open case: not a measurement of this organ">
                        <span className="lf-foot-swatch" aria-hidden="true" />
                        Case footprint
                      </span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <figure className="lf-fig-wrap">
            <Figure states={states} footprint={footprint} selected={selected} hrefFor={regionHref} onSelect={select} onPreview={setPreview} />
            <figcaption className="lf-fig-readout" aria-hidden="true">
              <span className="lf-fig-readout-name">{regionDef(shown).label}</span>
              <span className="lf-fig-readout-state" data-state={states[shown]}>
                {STATE_LABEL[states[shown]]}
                {footprint[shown] ? ' · case footprint' : ''}
              </span>
            </figcaption>
          </figure>
          <div className="lf-fig-key">
            <ul className="lf-fig-legend" aria-label="Figure legend">
              {LEGEND.map((s) => (
                <li key={s} data-state={s}>
                  <span className="lf-fig-swatch" data-state={s} aria-hidden="true" />
                  {STATE_LABEL[s]}
                </li>
              ))}
              <li data-state="footprint">
                <span className="lf-foot-swatch lf-foot-swatch-lg" aria-hidden="true" />
                Hatched outline: in an open case’s hazard footprint
              </li>
            </ul>
            <p className="lf-body-fine lf-fig-rule">
              Fill = this crewmember’s own measured findings for that part of the body. A hatched outline marks the organs an open
              case’s hazard can reach; it is not a measurement of them.
              {BODY_REGION_RULE ? <span className="sr-only"> Rule: {BODY_REGION_RULE}</span> : null}
            </p>
            {fitness ? <FitnessTagCard tag={fitness} crewLabel={crew.id} envLabel={env.label} /> : null}
          </div>
        </div>

        <div className="lf-body-main" ref={panelRef}>
          <p className="sr-only" aria-live="polite">
            {def.label}: {STATE_LABEL[ev.summary.state]}
            {ev.footprint.length ? `, in the hazard footprint of ${ev.footprint.map((c) => c.title).join(', ')}` : ''}
          </p>
          <Panel
            key={selected}
            region={def}
            summary={ev.summary}
            ruleRows={ev.ruleRows}
            indicatorRows={ev.indicatorRows}
            cases={ev.cases}
            caseViews={caseViewsOfCrew}
            footprint={ev.footprint}
            fitness={fitness}
            rulesMissing={THRESHOLD_RULES === null}
            casesMissing={CASES === null}
            evaluationReady={evaluation.status === 'ready'}
            envId={envId}
            crewLabel={`${crew.id} ${crew.role}`}
          />
        </div>
      </div>
    </div>
  )
}
