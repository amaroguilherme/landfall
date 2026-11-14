// #/body - the clickable body figure (the challenge statement's own UI example: "a human figure
// where each part of the body is clickable and displays information about its function and
// health status"). Region selection lives in the query string (#/body?region=kidneys), so any
// view can deep-link to a region and the back button is not flooded (selection replaces).
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useSnapshot } from '../../app/data'
import { ENGINE_IS_SHIM, evaluatePersonal, evaluateRule } from '../../app/engine'
import { hrefFor, navigate } from '../../app/location'
import { selectAlerts, useMission, useMetNow } from '../../app/mission'
import type { FeatureProps } from '../../app/router'
import { BASELINE_FIRST_DAY, BASELINE_LAST_DAY, environment } from '../../app/scenario'
import { crewMember } from '../../app/vocab'
import { SimulatedMarker } from '../../ui'
import './body.css'
import { BodyFigure } from './Figure'
import { RegionPanel, RegionStateBadge } from './RegionPanel'
import { REGIONS, casesForRegion, isRegionId, regionDef, rulesForRegion } from './regions'
import type { RegionId } from './regions'
import { CASES, PERSONAL_INDICATORS, RCI_CONFIG, THRESHOLD_RULES, indicatorById, ruleById } from './rules'
import type { CaseDef } from './rules'
import { STATE_LABEL, alertSignals, caseStatus, defaultRegion, evaluateIndicatorRow, evaluateRuleRow, summarizeRegion } from './status'
import type { CaseStatus, EvalContext, IndicatorRow, RegionState, RegionSummary, RuleRow, SimCrewData } from './status'

const EVALUATOR = { evaluateRule, evaluatePersonal }
const regionHref = (id: RegionId) => hrefFor(`/body?region=${id}`)
const Figure = memo(BodyFigure)
const Panel = memo(RegionPanel)
const LEGEND: RegionState[] = ['warning', 'caution', 'advisory', 'nominal', 'no_data', 'unmonitored']

interface RegionEval {
  ruleRows: RuleRow[]
  indicatorRows: IndicatorRow[]
  cases: CaseDef[]
  summary: RegionSummary
}

export default function BodyMap({ query }: FeatureProps) {
  const { state } = useMission()
  const { envId, crewId } = state
  const metNow = useMetNow()
  // Re-evaluate every 5 minutes of MET (the cadence of the onboard monitor), not every second.
  const tBucket = Math.floor(metNow / 300) * 300
  const sim = useSnapshot<SimCrewData>('sim_crew')
  const alerts = useMemo(() => selectAlerts(state), [state])
  const [preview, setPreview] = useState<RegionId | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const evals = useMemo(() => {
    const ctx: EvalContext = {
      sim: sim.data,
      crewId,
      envId,
      t: tBucket,
      extra: state.observations,
      evaluator: EVALUATOR,
      rci: RCI_CONFIG,
      baselineDays: [BASELINE_FIRST_DAY, BASELINE_LAST_DAY],
    }
    const caseStatuses: Record<string, CaseStatus> = {}
    for (const c of CASES ?? []) {
      caseStatuses[c.id] = caseStatus(c, ctx, { rule: ruleById, indicator: indicatorById }, state.cases[`${crewId}:${c.id}`] ?? state.cases[c.id])
    }
    const out = {} as Record<RegionId, RegionEval>
    for (const region of REGIONS) {
      const ruleRows = rulesForRegion(region, THRESHOLD_RULES ?? []).map((r) => evaluateRuleRow(r, ctx))
      const indicatorRows = region.indicators
        .map((id) => PERSONAL_INDICATORS?.find((i) => i.id === id))
        .filter((i): i is NonNullable<typeof i> => Boolean(i))
        .map((i) => evaluateIndicatorRow(i, ctx))
      const cases = casesForRegion(region.id, CASES ?? [])
      const signals = [
        ...cases
          .map((c) => caseStatuses[c.id])
          .filter((s) => s?.open && s.severity)
          .map((s) => ({ severity: s.severity!, reason: `Case open: ${CASES?.find((c) => c.id === s.caseId)?.title ?? s.caseId}` })),
        ...alertSignals(alerts, crewId, new Set(cases.map((c) => c.id)), new Set(ruleRows.map((r) => r.rule.id))),
      ]
      const summary = summarizeRegion([...ruleRows.map((r) => r.finding), ...indicatorRows.map((r) => r.finding)], signals)
      out[region.id] = { ruleRows, indicatorRows, cases, summary }
    }
    return { regions: out, caseStatuses }
  }, [sim.data, crewId, envId, tBucket, state.observations, state.cases, alerts])

  const states = useMemo(() => {
    const s = {} as Record<RegionId, RegionState>
    for (const r of REGIONS) s[r.id] = evals.regions[r.id].summary.state
    return s
  }, [evals])

  const selected: RegionId = isRegionId(query.region) ? query.region : defaultRegion(states)
  const def = regionDef(selected)
  const ev = evals.regions[selected]
  const crew = crewMember(crewId)
  const env = environment(envId)
  const shown = preview ?? selected

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

  return (
    <div className="lf-body">
      <header className="lf-body-head">
        <p className="lf-eyebrow">
          {crew.id} · {crew.role} · {env.label}
        </p>
        <h1>Body map</h1>
        <p className="lf-body-lede">
          Pick a part of the body to see what it does, how spaceflight affects it (in NASA’s words), what can be measured in
          space and how, which NASA limits apply, and when it needs the flight surgeon.
        </p>
        <SimulatedMarker variant="banner">
          Region status uses the simulated crew. NASA HRP text, NASA limits and Inspiration4 lab data are real.
        </SimulatedMarker>
        {sim.status === 'missing' || sim.status === 'error' ? (
          <p className="lf-body-fine lf-region-shim">sim_crew.json is not in this build: every reading shows as missing.</p>
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
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <figure className="lf-fig-wrap">
            <Figure states={states} selected={selected} hrefFor={regionHref} onSelect={select} onPreview={setPreview} />
            <figcaption className="lf-fig-readout" aria-hidden="true">
              <span className="lf-fig-readout-name">{regionDef(shown).label}</span>
              <span className="lf-fig-readout-state" data-state={states[shown]}>
                {STATE_LABEL[states[shown]]}
              </span>
            </figcaption>
          </figure>
          <ul className="lf-fig-legend" aria-label="Figure legend">
            {LEGEND.map((s) => (
              <li key={s} data-state={s}>
                <span className="lf-fig-swatch" data-state={s} aria-hidden="true" />
                {STATE_LABEL[s]}
              </li>
            ))}
          </ul>
        </div>

        <div className="lf-body-main" ref={panelRef}>
          <p className="sr-only" aria-live="polite">
            {def.label}: {STATE_LABEL[ev.summary.state]}
          </p>
          <Panel
            key={selected}
            region={def}
            summary={ev.summary}
            ruleRows={ev.ruleRows}
            indicatorRows={ev.indicatorRows}
            cases={ev.cases}
            caseStatuses={evals.caseStatuses}
            rulesMissing={THRESHOLD_RULES === null}
            casesMissing={CASES === null}
            envId={envId}
            crewLabel={`${crew.id} ${crew.role}`}
            rciZ={RCI_CONFIG?.critical_z ?? null}
            engineIsShim={ENGINE_IS_SHIM}
          />
        </div>
      </div>
    </div>
  )
}
