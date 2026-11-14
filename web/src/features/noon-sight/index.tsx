// NOON SIGHT (#/noon-sight): the daily check. A navigator's noon sight is the daily fix that
// tells you where you are without help from anyone. Five short steps: PVT-B, sleep, mood,
// fluids, symptoms. Answers become SPEC section 4 observations in the mission store, labelled
// as entered by the crewmember (never "simulated"), plus one logbook line.
// Gamification is sober by design: a streak and weekly logbook completeness. No points, no
// confetti, no leaderboard, and mood never counts towards anything.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { FeatureProps } from '../../app/router'
import { useSnapshot } from '../../app/data'
import type { LoadStatus, Snapshot } from '../../app/data'
import { metClock, useMetNow, useMission } from '../../app/mission'
import { crewMember } from '../../app/vocab'
import type { ChipKind, CrewId, Observation } from '../../app/vocab'
import { BASELINE_FIRST_DAY, BASELINE_LAST_DAY } from '../../app/scenario'
import {
  Button,
  ButtonLink,
  Chip,
  Citation,
  EmptyState,
  Expander,
  FreshnessChip,
  MetTime,
  Num,
  ReqId,
  SimulatedMarker,
  UnavailableIcon,
} from '../../ui'
import { MoodTrend } from './MoodTrend'
import type { MoodPoint } from './MoodTrend'
import { PvtTest } from './PvtTest'
import type { PvtRun } from './PvtTest'
import { PVT_B, PVT_B_CITATION, PVT_B_FULLTEXT_URL, PVT_B_URL, PVT_CONSTANTS, PVT_DEMO_DURATION_MS, scorePvt } from './pvt'
import type { PvtScore } from './pvt'
import {
  DAILY_ENTRIES,
  EMPTY_ANSWERS,
  PROVENANCE_MEASURED,
  RENAL_SYMPTOMS,
  SYMPTOMS,
  baselineMean,
  buildObservations,
  collectFixes,
  computeStreak,
  lastNight,
  logbookText,
  metDayOf,
  parseMl,
  seriesPoints,
  simMember,
  simObservations,
  weekCompleteness,
} from './record'
import type { NoonAnswers, SimCrewData, SimCrewMember, SymptomId } from './record'
import './noon-sight.css'

type StepId = 'pvt' | 'sleep' | 'mood' | 'fluids' | 'symptoms' | 'done'
const STEPS: { id: Exclude<StepId, 'done'>; label: string; short: string; time: string }[] = [
  { id: 'pvt', label: 'Reaction time', short: 'PVT-B', time: '3 min' },
  { id: 'sleep', label: 'Sleep', short: 'Sleep', time: '10 s' },
  { id: 'mood', label: 'Mood', short: 'Mood', time: '5 s' },
  { id: 'fluids', label: 'Fluids', short: 'Fluids', time: '30 s' },
  { id: 'symptoms', label: 'Symptoms', short: 'Symptoms', time: '15 s' },
]
const STEP_IDS = STEPS.map((s) => s.id) as string[]

const NO_SYMPTOMS = Object.fromEntries(SYMPTOMS.map((s) => [s.id, false])) as Record<SymptomId, boolean>

const SLEEP_OPTIONS = [
  { value: 1, label: 'Very poorly' },
  { value: 2, label: 'Poorly' },
  { value: 3, label: 'OK' },
  { value: 4, label: 'Well' },
  { value: 5, label: 'Very well' },
]
const MOOD_OPTIONS = [
  { value: 1, label: 'Very low' },
  { value: 2, label: 'Low' },
  { value: 3, label: 'OK' },
  { value: 4, label: 'Good' },
  { value: 5, label: 'Very good' },
]

const RENAL_REPORT = {
  kind: 'literature' as const,
  citation:
    'Stratton E, Lumpkins S, Antonsen E. Evidence Report: Risk of Renal Stone Formation. NASA Human Research Program, 2024. NTRS 20240012429, p. 13',
  url: 'https://ntrs.nasa.gov/citations/20240012429',
}

// ---------------------------------------------------------------------------------------------

export default function NoonSight({ query }: FeatureProps) {
  const { state } = useMission()
  // #/noon-sight?step=fluids opens a step directly (e.g. from the renal case's "enter it now").
  const initialStep = (STEP_IDS.includes(query.step ?? '') ? query.step : 'pvt') as StepId
  // A new crewmember in the mission bar (or a new ?step=) starts a fresh check.
  return <NoonSightView key={`${state.crewId}:${query.step ?? ''}`} crewId={state.crewId} initialStep={initialStep} />
}

function NoonSightView({ crewId, initialStep }: { crewId: CrewId; initialStep: StepId }) {
  const sim = useSnapshot<SimCrewData>('sim_crew')
  const { state, addNoonSight, addLog } = useMission()
  const crew = crewMember(crewId)
  const member = simMember(sim.data, crewId)
  const baselineDays: [number, number] = sim.data?.met?.baseline_days ?? [BASELINE_FIRST_DAY, BASELINE_LAST_DAY]

  // "Now" for the record views is read when the view opens and again when a fix is logged, so
  // the flow does not re-render every second while the PVT-B is timing.
  const [now, setNow] = useState(() => metClock.get().metNow)
  const today = metDayOf(now)

  const [step, setStep] = useState<StepId>(initialStep)
  const [answers, setAnswers] = useState<NoonAnswers>(EMPTY_ANSWERS)
  const [pvtStage, setPvtStage] = useState<'choose' | 'running' | 'result'>('choose')
  const [pvtMode, setPvtMode] = useState<'full' | 'demo'>('full')
  const [pvtNote, setPvtNote] = useState<string | null>(null)
  const [fluidRaw, setFluidRaw] = useState('')
  const [urineRaw, setUrineRaw] = useState('')
  const [symptoms, setSymptoms] = useState<Record<SymptomId, boolean>>(NO_SYMPTOMS)
  const [logged, setLogged] = useState<{ t: number; observations: Observation[]; text: string } | null>(null)

  const sessionObs = useMemo(() => state.observations.filter((o) => o.crew_id === crewId), [state.observations, crewId])

  const record = useMemo(() => {
    // The simulated record's 12:00 check-in times (never its mood values) plus this session's fixes.
    const checkins = seriesPoints(member?.series.mood)
    const sessionTimes = state.noonSights.filter((n) => n.crew_id === crewId).map((f) => f.t)
    const streak = computeStreak(collectFixes(checkins, sessionTimes, now), today)
    const obs = [...simObservations(member, DAILY_ENTRIES.map((e) => e.variable), now), ...sessionObs]
    const week = weekCompleteness(obs, crewId, today, now)
    return { streak, week }
  }, [member, now, today, crewId, state.noonSights, sessionObs])

  // Move focus to the new step's heading (keyboard and screen-reader users), not on first render.
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    // While the PVT-B runs, the test box owns focus (it focuses itself), so SPACE starts the test.
    if (step === 'pvt' && pvtStage === 'running') return
    headingRef.current?.focus({ preventScroll: false })
  }, [step, pvtStage])

  const fluid = parseMl(fluidRaw)
  const urine = parseMl(urineRaw)

  const go = (s: StepId) => setStep(s)

  /** Log the fix: observations into the store (SPEC section 4), one logbook line, then "Fix logged". */
  const logFix = (symptomAnswers: NoonAnswers['symptoms']) => {
    const t = metClock.get().metNow
    const final: NoonAnswers = { ...answers, fluidIntakeMl: fluid.value, urineOutputMl: urine.value, symptoms: symptomAnswers }
    const observations = buildObservations(final, crewId, t)
    const text = logbookText(final)
    addNoonSight({
      crew_id: crewId,
      t,
      observations,
      details: {
        entered_by: 'crewmember',
        pvt: final.pvt ? { mode: final.pvt.mode, score: final.pvt.score } : null,
        demo_not_recorded: final.pvt?.mode === 'demo',
      },
    })
    addLog({ t, crew_id: crewId, kind: 'measurement', text })
    setAnswers(final)
    setLogged({ t, observations, text })
    setNow(t)
    setStep('done')
  }

  const startOver = () => {
    setAnswers(EMPTY_ANSWERS)
    setPvtStage('choose')
    setPvtNote(null)
    setFluidRaw('')
    setUrineRaw('')
    setSymptoms(NO_SYMPTOMS)
    setLogged(null)
    setNow(metClock.get().metNow)
    setStep('pvt')
  }

  const lapsesBase = baselineMean(seriesPoints(member?.series.pvt_lapses), baselineDays[0], baselineDays[1])
  const medianBase = baselineMean(seriesPoints(member?.series.pvt_median_rt), baselineDays[0], baselineDays[1])

  const stepIndex = step === 'done' ? STEPS.length : STEPS.findIndex((s) => s.id === step)

  return (
    <div className="ns">
      <header className="ns-head">
        <p className="lf-eyebrow">Daily check · about 90 seconds, plus the 3-minute PVT-B</p>
        <h1>Noon Sight</h1>
        <p className="ns-lede">
          A navigator’s noon sight is the daily fix that tells you where you are without help from anyone. This is yours:
          a reaction-time test and four quick questions, compared only with your own baseline.
        </p>
        <p className="ns-who">
          Logging as <strong>{crewId}</strong> · {crew.role} · <MetNowLabel />{' '}
          <span className="ns-muted">(change crewmember in the mission bar)</span>
        </p>
        <p className="ns-streak-inline">
          Streak <Num value={sim.status === 'loading' ? null : record.streak.length} /> consecutive fixes · logbook{' '}
          <Num value={record.week.logged} />/<Num value={record.week.expected} /> this week
        </p>
      </header>

      <SimulatedMarker variant="banner">
        Band sleep, the mood history and the streak come from the seeded scenario. Everything you enter here is labelled
        as entered by the crewmember, never as simulated.
      </SimulatedMarker>

      <div className="ns-grid">
        <div className="ns-flow">
          <ol className="ns-steps" aria-label="Noon Sight steps">
            {STEPS.map((s, i) => {
              const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo'
              return (
                <li key={s.id} className="ns-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                  <span className="ns-step-n lf-num" aria-hidden="true">
                    {state === 'done' ? '✓' : i + 1}
                  </span>
                  <span className="ns-step-label">
                    <span className="ns-step-long">{s.label}</span>
                    <span className="ns-step-short" aria-hidden="true">
                      {s.short}
                    </span>
                  </span>
                  <span className="ns-step-time lf-num">{s.time}</span>
                  <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span>
                </li>
              )
            })}
          </ol>

          {step === 'pvt' ? (
            <StepPanel n={1} title={pvtStage === 'result' ? (answers.pvt?.mode === 'demo' ? 'Demo run result' : 'PVT-B result') : 'Reaction time: the PVT-B'} headingRef={headingRef}>
              {pvtStage === 'choose' ? (
                <PvtChoose
                  note={pvtNote}
                  onStart={(mode) => {
                    setPvtMode(mode)
                    setPvtNote(null)
                    setPvtStage('running')
                  }}
                  onSkip={() => {
                    setAnswers((a) => ({ ...a, pvt: null }))
                    go('sleep')
                  }}
                />
              ) : pvtStage === 'running' ? (
                <PvtTest
                  durationMs={pvtMode === 'demo' ? PVT_DEMO_DURATION_MS : PVT_B.durationMs}
                  demo={pvtMode === 'demo'}
                  onComplete={(run: PvtRun) => {
                    setAnswers((a) => ({ ...a, pvt: { mode: pvtMode, score: scorePvt(run.events) } }))
                    setPvtStage('result')
                  }}
                  onAbort={(reason) => {
                    setPvtNote(reason)
                    setPvtStage('choose')
                  }}
                />
              ) : answers.pvt ? (
                <PvtResult
                  score={answers.pvt.score}
                  mode={answers.pvt.mode}
                  crewId={crewId}
                  lapsesBase={lapsesBase}
                  medianBase={medianBase}
                  baselineDays={baselineDays}
                  onNext={() => go('sleep')}
                  onAgain={() => setPvtStage('choose')}
                />
              ) : null}
            </StepPanel>
          ) : null}

          {step === 'sleep' ? (
            <StepPanel n={2} title="Sleep" headingRef={headingRef}>
              <SleepFromBand member={member} now={now} status={sim.status} snapshot={sim.snapshot} baselineDays={baselineDays} />
              <Rating
                name="ns-sleep"
                legend="How well did you sleep?"
                options={SLEEP_OPTIONS}
                value={answers.sleepQuality}
                onChange={(v) => setAnswers((a) => ({ ...a, sleepQuality: v }))}
                note={
                  <>
                    <Chip kind="design choice" /> One self-rated item, not a validated sleep questionnaire.
                  </>
                }
              />
              <StepNav onBack={() => go('pvt')} onNext={() => go('mood')} nextLabel="Next: mood" skipHint={answers.sleepQuality === null ? 'Not rated yet: you can leave it.' : undefined} />
            </StepPanel>
          ) : null}

          {step === 'mood' ? (
            <StepPanel n={3} title="Mood" headingRef={headingRef}>
              <p className="ns-private">
                <LockIcon /> <strong>Private. Never leaves this device unless you choose to share it.</strong>
              </p>
              <Rating
                name="ns-mood"
                legend="How is your mood today?"
                options={MOOD_OPTIONS}
                value={answers.mood}
                onChange={(v) => setAnswers((a) => ({ ...a, mood: v }))}
                note={
                  <>
                    <Chip kind="design choice" /> One self-rated item. LANDFALL embeds no licensed questionnaire.
                  </>
                }
              />
              {member ? (
                <MoodTrend
                  points={moodPoints(member.series.mood ? seriesPoints(member.series.mood) : [], sessionObs, answers.mood, today, now)}
                  baseline={baselineMean(seriesPoints(member.series.mood), baselineDays[0], baselineDays[1])}
                  baselineDays={baselineDays}
                  today={today}
                />
              ) : (
                <EmptyState kind={sim.status === 'missing' ? 'missing' : 'unavailable'} title="No mood history to compare with" headingLevel={3}>
                  <p>The simulated record for {crewId} is not in this build, so there is no baseline to draw.</p>
                </EmptyState>
              )}
              <p className="ns-note">
                Compared only with your own baseline. Mood never raises an alert, never changes a colour, and never counts towards
                your streak or completeness.{' '}
                {state.consent[crewId]?.mood === true ? (
                  <>
                    <strong>Shared with flight surgeons: yes</strong>, because you chose it in <a href="#/downlink">Downlink</a>.
                  </>
                ) : (
                  <>
                    <strong>Shared with flight surgeons: no</strong> (the default). Only you can change that, in{' '}
                    <a href="#/downlink">Downlink, What Houston sees</a>.
                  </>
                )}
              </p>
              <StepNav
                onBack={() => go('sleep')}
                onNext={() => go('fluids')}
                nextLabel="Next: fluids"
                extra={
                  answers.mood !== null ? (
                    <Button variant="ghost" onClick={() => setAnswers((a) => ({ ...a, mood: null }))}>
                      Clear: prefer not to say
                    </Button>
                  ) : null
                }
                skipHint={answers.mood === null ? 'Prefer not to say? Leave it empty: nothing is logged.' : undefined}
              />
            </StepPanel>
          ) : null}

          {step === 'fluids' ? (
            <StepPanel n={4} title="Fluids in and out" headingRef={headingRef}>
              <p className="ns-nmh">
                <UnavailableIcon size={14} /> <strong>NOT MEASURABLE HERE.</strong> The band cannot measure what you drink or your
                urine output. Enter them by hand. An empty box is logged as not measured, never as zero.
              </p>
              <div className="ns-fields">
                <MlField
                  id="ns-fluid"
                  label="Fluid intake, last 24 hours"
                  raw={fluidRaw}
                  onChange={setFluidRaw}
                  error={fluid.error}
                  how="Add up every drink since this time yesterday: the water dispenser volumes plus each drink pouch (the volume is printed on the pouch). Do not count water in food."
                />
                <MlField
                  id="ns-urine"
                  label="Urine output, last 24 hours"
                  raw={urineRaw}
                  onChange={setUrineRaw}
                  error={urine.error}
                  how="Collect each void in a graduated urine collection bag from the medical kit, read the volume, and add the volumes up over 24 hours. If you did not collect, leave it empty."
                />
              </div>
              <div className="ns-context">
                <p className="ns-context-title">For context, not an alarm</p>
                <ul>
                  <li>
                    NASA’s renal-stone evidence report: stone risk rises when urine output drops below{' '}
                    <Num value={1.5} unit="L/day" digits={1} />; good hydration produces <Num value={2.5} digits={1} />–
                    <Num value={3} unit="L/day" digits={0} /> of urine. <Chip kind="literature" />{' '}
                    <Citation source={RENAL_REPORT} />
                  </li>
                  <li>
                    The vehicle must supply at least <Num value={2.5} unit="L" digits={1} /> of drinking water per crewmember
                    per day <ReqId id="V2 6109" /> (Table 6.3-1). That is a supply requirement, not a drinking target.{' '}
                    <Chip kind="NASA-published" />
                  </li>
                </ul>
              </div>
              <StepNav
                onBack={() => go('mood')}
                onNext={() => go('symptoms')}
                nextLabel="Next: symptoms"
                nextDisabled={Boolean(fluid.error || urine.error)}
              />
            </StepPanel>
          ) : null}

          {step === 'symptoms' ? (
            <StepPanel n={5} title="Symptoms" headingRef={headingRef}>
              <fieldset className="ns-checks">
                <legend>Anything bothering you today? Tick all that apply.</legend>
                {SYMPTOMS.map((s) => (
                  <label key={s.id} className="ns-check">
                    <input
                      type="checkbox"
                      checked={symptoms[s.id]}
                      onChange={(e) => setSymptoms((m) => ({ ...m, [s.id]: e.target.checked }))}
                    />
                    <span>{s.label}</span>
                  </label>
                ))}
              </fieldset>
              <p className="ns-note">
                LANDFALL records what you report. It does not diagnose and it does not suggest medicine.
              </p>
              {RENAL_SYMPTOMS.some((id) => symptoms[id]) ? (
                <div className="ns-procedure" role="note">
                  <p>
                    <strong>Tell your Crew Medical Officer now.</strong> In the renal-stone procedure, side or back pain, blood in
                    the urine, or pain when passing urine means a flight surgeon should look: the case queues the ground packet,
                    which sends itself when a link exists.
                  </p>
                  <a href="#/case/renal_stone">Open the renal-stone case</a>
                </div>
              ) : null}
              <StepNav
                onBack={() => go('fluids')}
                onNext={() => logFix(symptoms)}
                nextLabel="Log this fix"
                extra={
                  <Button variant="ghost" onClick={() => logFix(null)}>
                    Skip symptoms and log
                  </Button>
                }
              />
            </StepPanel>
          ) : null}

          {step === 'done' && logged ? (
            <StepPanel n={null} title="Fix logged" headingRef={headingRef}>
              <DoneView logged={logged} answers={answers} streakLength={record.streak.length} crewId={crewId} onAgain={startOver} />
            </StepPanel>
          ) : null}
        </div>

        <aside className="ns-aside" aria-label="Streak and logbook">
          <StreakCard streak={record.streak} simStatus={sim.status} />
          <WeekCard week={record.week} today={today} />
          <section className="ns-card">
            <h2 className="ns-card-title">Why a streak</h2>
            <p className="ns-small">
              One number, no points, no leaderboard. The value is an unbroken record: LANDFALL compares you with your own recent
              days (at least <Num value={7} /> baseline days <Chip kind="design choice" />), and every gap weakens that comparison. Mood is never counted, so
              keeping it private costs nothing.
            </p>
            <FreshnessChip meta={sim.snapshot} status={sim.status} id="sim_crew" compact />
          </section>
        </aside>
      </div>
    </div>
  )

}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

function MetNowLabel() {
  const t = useMetNow()
  return <MetTime t={t} label />
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" className="lf-icon">
      <rect x="3" y="7" width="10" height="7.4" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.3 7V5a2.7 2.7 0 015.4 0v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function StepPanel({
  n,
  title,
  headingRef,
  children,
}: {
  n: number | null
  title: string
  headingRef: RefObject<HTMLHeadingElement | null>
  children: ReactNode
}) {
  return (
    <section className="lf-panel ns-panel" aria-labelledby="ns-step-h">
      <header className="lf-panel-head">
        <div>
          {n !== null ? <p className="lf-eyebrow">Step {n} of 5</p> : <p className="lf-eyebrow">Noon Sight complete</p>}
          <h2 id="ns-step-h" className="lf-panel-title" tabIndex={-1} ref={headingRef}>
            {title}
          </h2>
        </div>
      </header>
      <div className="lf-panel-body">{children}</div>
    </section>
  )
}

function StepNav({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  extra,
  skipHint,
}: {
  onBack?: () => void
  onNext: () => void
  nextLabel: string
  nextDisabled?: boolean
  extra?: ReactNode
  skipHint?: string
}) {
  return (
    <div className="ns-nav">
      <Button onClick={onNext} disabled={nextDisabled}>
        {nextLabel}
      </Button>
      {onBack ? (
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      ) : null}
      {extra}
      {skipHint ? <span className="ns-muted ns-small">{skipHint}</span> : null}
    </div>
  )
}

function Rating({
  name,
  legend,
  options,
  value,
  onChange,
  note,
}: {
  name: string
  legend: string
  options: { value: number; label: string }[]
  value: number | null
  onChange: (v: number) => void
  note?: ReactNode
}) {
  return (
    <fieldset className="ns-rating">
      <legend>{legend}</legend>
      <div className="ns-rating-opts">
        {options.map((o) => (
          <label key={o.value} className="ns-rating-opt">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span className="ns-rating-face">
              <span className="ns-rating-n lf-num">{o.value}</span>
              <span className="ns-rating-word">{o.label}</span>
            </span>
          </label>
        ))}
      </div>
      {note ? <p className="ns-small ns-muted">{note}</p> : null}
    </fieldset>
  )
}

function MlField({
  id,
  label,
  raw,
  onChange,
  error,
  how,
}: {
  id: string
  label: string
  raw: string
  onChange: (s: string) => void
  error: string | null
  how: string
}) {
  return (
    <div className="ns-field">
      <label htmlFor={id} className="ns-field-label">
        {label}
      </label>
      <div className="ns-field-row">
        <input
          id={id}
          className="ns-input lf-mono"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="e.g. 2400"
          value={raw}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-how${error ? ` ${id}-err` : ''}`}
        />
        <span className="ns-field-unit">mL</span>
      </div>
      {error ? (
        <p id={`${id}-err`} className="ns-field-err" role="alert">
          {error}
        </p>
      ) : null}
      <p id={`${id}-how`} className="ns-small ns-muted">
        <strong>How to measure:</strong> {how}
      </p>
    </div>
  )
}

function PvtChoose({ note, onStart, onSkip }: { note: string | null; onStart: (mode: 'full' | 'demo') => void; onSkip: () => void }) {
  return (
    <>
      <p>
        The PVT-B measures how quickly you react to something that appears at random moments. Tiredness shows up as slow
        responses, called <strong>lapses</strong>. It takes 3 minutes and needs your full attention.
      </p>
      <ol className="ns-how">
        <li>A white counter appears in the box every 1 to 4 seconds.</li>
        <li>
          Press <kbd className="ns-kbd">Space</kbd> or tap the box the moment you see it. The counter stops and shows your time.
        </li>
        <li>Do not press before it appears: that counts as a false start.</li>
        <li>Use the same device and hand every day, so your days compare fairly.</li>
      </ol>
      {note ? (
        <p className="ns-stopped" role="status">
          {note}
        </p>
      ) : null}
      <div className="ns-nav">
        <Button onClick={() => onStart('full')}>Start the 3-minute PVT-B</Button>
        <Button variant="secondary" onClick={() => onStart('demo')}>
          Demo run, 30 seconds
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip the PVT-B today
        </Button>
      </div>
      <p className="ns-small ns-muted">
        <strong>Demo run: not the validated 3-min protocol.</strong> It is there so you can try the test quickly. Its result is
        shown but never recorded as a PVT-B result.
      </p>
      <p className="ns-small">
        <strong>Lapse = reaction time of 355 ms or more.</strong> That definition comes from Basner, Mollicone &amp; Dinges
        (2011), not from a NASA requirement: no NASA standard adopts it. <Chip kind="literature" />
      </p>
      <Expander summary="Where these numbers come from">
        <table className="ns-table ns-consts">
          <thead>
            <tr>
              <th scope="col">Constant</th>
              <th scope="col">Value</th>
              <th scope="col">Basis</th>
            </tr>
          </thead>
          <tbody>
            {PVT_CONSTANTS.map((c) => (
              <tr key={c.label}>
                <th scope="row">{c.label}</th>
                <td className="lf-mono ns-nowrap">{c.value}</td>
                <td>
                  <Chip kind={c.chip} /> {c.basis}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ns-small">
          <Citation source={{ kind: 'literature', citation: PVT_B_CITATION, url: PVT_B_URL }} /> Full text:{' '}
          <a href={PVT_B_FULLTEXT_URL} target="_blank" rel="noopener noreferrer">
            PMC3197786
          </a>{' '}
          (methods §2.2–2.3, limitations §4.1).
        </p>
      </Expander>
    </>
  )
}

function Stat({ label, children, chip }: { label: string; children: ReactNode; chip?: ChipKind }) {
  return (
    <div className="ns-stat">
      <dt>{label}</dt>
      <dd>
        <span className="ns-stat-v">{children}</span>
        {chip ? <Chip kind={chip} /> : null}
      </dd>
    </div>
  )
}

function PvtResult({
  score,
  mode,
  crewId,
  lapsesBase,
  medianBase,
  baselineDays,
  onNext,
  onAgain,
}: {
  score: PvtScore
  mode: 'full' | 'demo'
  crewId: CrewId
  lapsesBase: { mean: number | null; n: number }
  medianBase: { mean: number | null; n: number }
  baselineDays: [number, number]
  onNext: () => void
  onAgain: () => void
}) {
  return (
    <>
      <p className="sr-only" role="status">
        Test complete. {score.lapses} lapses, median reaction time {score.medianRt === null ? 'not available' : `${Math.round(score.medianRt)} milliseconds`}.
      </p>
      {mode === 'demo' ? (
        <p className="ns-demo-flag">
          <UnavailableIcon size={14} /> <strong>Demo run, not recorded.</strong> 30 seconds is not the validated 3-minute protocol,
          so these numbers are not compared with anything and are not logged as a PVT-B result.
        </p>
      ) : null}
      <dl className="ns-stats">
        <Stat label="Lapses (≥ 355 ms)" chip="literature">
          <Num value={score.lapses} />
        </Stat>
        <Stat label="Median reaction time" chip="design choice">
          <Num value={score.medianRt === null ? null : Math.round(score.medianRt)} unit="ms" />
        </Stat>
        <Stat label="Response speed, mean 1/RT" chip="literature">
          <Num value={score.meanSpeed} digits={2} unit="/s" unitLabel="per second" />
        </Stat>
        <Stat label="False starts" chip="literature">
          <Num value={score.falseStarts} />
        </Stat>
      </dl>
      <p className="ns-small ns-muted">
        <Num value={score.stimuli} /> stimuli · <Num value={score.lapses500} /> {score.lapses500 === 1 ? 'lapse' : 'lapses'} at the standard 10-min PVT’s ≥ 500 ms ·
        performance score <Num value={score.performanceScore} digits={0} unit="%" /> · <Num value={score.timeouts} /> with no
        response (Basner 2011 §2.3). <Chip kind="literature" />
      </p>
      {mode === 'full' ? (
        <>
          <p className="ns-small">
            Recorded as <code>pvt_lapses</code> = <Num value={score.lapses} unit="count" /> and <code>pvt_median_rt</code> ={' '}
            <Num value={score.medianRt === null ? null : Math.round(score.medianRt)} unit="ms" />, {PROVENANCE_MEASURED} by the app.
          </p>
          <p className="ns-small ns-muted">
            {crewId}’s own baseline (MET days <span className="lf-num">{baselineDays[0]}</span>–
            <span className="lf-num">{baselineDays[1]}</span>, simulated): <Num value={lapsesBase.mean} digits={1} /> lapses,{' '}
            <Num value={medianBase.mean} digits={0} unit="ms" /> median. <a href="#/trends">Trends</a> and the{' '}
            <a href="#/case/sleep_circadian">sleep case</a> compare today with it.
          </p>
        </>
      ) : null}
      <div className="ns-nav">
        <Button onClick={onNext}>Next: sleep</Button>
        <Button variant="secondary" onClick={onAgain}>
          Run again
        </Button>
      </div>
    </>
  )
}

function fmtHm(h: number): string {
  const total = Math.round(h * 60)
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`
}

function SleepFromBand({
  member,
  now,
  status,
  snapshot,
  baselineDays,
}: {
  member: SimCrewMember | undefined
  now: number
  status: LoadStatus
  snapshot: Snapshot<SimCrewData> | null
  baselineDays: [number, number]
}) {
  if (status === 'loading') {
    return (
      <EmptyState kind="loading" title="Reading the band record" headingLevel={3}>
        <p>Loading last night from the local snapshot.</p>
      </EmptyState>
    )
  }
  const night = lastNight(member, now)
  if (!night) {
    return (
      <EmptyState kind={status === 'missing' ? 'missing' : 'unavailable'} title="No band sleep record for last night" headingLevel={3}>
        <p>
          LANDFALL estimates sleep from the band’s wrist movement. Wear the band to bed and last night will show here. You can
          still rate your sleep below.
        </p>
      </EmptyState>
    )
  }
  const base = baselineMean(seriesPoints(member?.series.sleep_duration), baselineDays[0], baselineDays[1])
  return (
    <div className="ns-card ns-band">
      <div className="ns-band-head">
        <p className="ns-card-title">Last night, from the band</p>
        <SimulatedMarker />
      </div>
      <dl className="ns-stats">
        <Stat label="Asleep">
          <Num value={night.durationH} digits={2} unit="h" /> <span className="ns-muted ns-small">({fmtHm(night.durationH)})</span>
        </Stat>
        {night.onset !== null && night.offset !== null ? (
          <Stat label="Main sleep, MET">
            <span className="ns-small">
              <MetTime t={night.onset} /> to <MetTime t={night.offset} />
            </span>
          </Stat>
        ) : null}
        <Stat label="Midpoint vs schedule">
          <Num value={night.midpointShiftH} digits={2} signed unit="h" />
        </Stat>
        <Stat label="Your baseline">
          <Num value={base.mean} digits={2} unit="h" />
        </Stat>
      </dl>
      <p className="ns-small ns-muted">
        Actigraphy estimates sleep from wrist movement; it does not measure sleep stages (that needs EEG research hardware).
        Midpoint is compared with 02:00 MET, the middle of the pre-shift sleep period. Baseline: MET days{' '}
        <span className="lf-num">{baselineDays[0]}</span>–<span className="lf-num">{baselineDays[1]}</span>.
      </p>
      <FreshnessChip meta={snapshot} status={status} id="sim_crew" />
    </div>
  )
}

function moodPoints(sim: { t: number; v: number }[], session: Observation[], current: number | null, today: number, now: number): MoodPoint[] {
  const byDay = new Map<number, MoodPoint & { t: number }>()
  const put = (t: number, v: number, origin: MoodPoint['origin']) => {
    const day = metDayOf(t)
    if (day < today - 13 || day > today || t > now) return
    const prev = byDay.get(day)
    if (!prev || t >= prev.t) byDay.set(day, { day, v, origin, t })
  }
  for (const p of sim) put(p.t, p.v, 'simulated')
  for (const o of session) if (o.variable === 'mood') put(o.t, o.value, 'session')
  if (current !== null) put(now, current, 'session')
  return [...byDay.values()].map(({ day, v, origin }) => ({ day, v, origin }))
}

function StreakCard({ streak, simStatus }: { streak: ReturnType<typeof computeStreak>; simStatus: string }) {
  const lastToday = streak.today[streak.today.length - 1]
  return (
    <section className="ns-card ns-streak" aria-labelledby="ns-streak-h">
      <h2 id="ns-streak-h" className="ns-card-title">
        Streak
      </h2>
      <p className="ns-streak-n">
        <Num value={simStatus === 'loading' ? null : streak.length} /> <span>consecutive {streak.length === 1 ? 'fix' : 'fixes'}</span>
      </p>
      {streak.firstDay !== null && streak.lastDay !== null ? (
        <p className="ns-small ns-muted">
          One per MET day, days <span className="lf-num">{streak.firstDay}</span>–<span className="lf-num">{streak.lastDay}</span>
          {streak.firstDay <= 368 ? ', counted from the start of the simulated record' : ''}.
        </p>
      ) : null}
      <p className="ns-small">
        {streak.todayDone && lastToday ? (
          <>
            Today: fixed at <MetTime t={lastToday.t} />{' '}
            {lastToday.origin === 'session' ? '(entered by you)' : '(simulated record)'}
            {streak.today.length > 1 ? (
              <>
                {' '}
                · <Num value={streak.today.length} /> fixes today; a day counts once
              </>
            ) : null}
          </>
        ) : (
          <>Today’s fix is still open.</>
        )}
      </p>
    </section>
  )
}

function WeekCard({ week, today }: { week: ReturnType<typeof weekCompleteness>; today: number }) {
  return (
    <section className="ns-card" aria-labelledby="ns-week-h">
      <h2 id="ns-week-h" className="ns-card-title">
        Logbook this week
      </h2>
      <p className="ns-small">
        <Num value={week.logged} /> of <Num value={week.expected} /> daily entries logged ({DAILY_ENTRIES.map((e) => e.label).join(', ')}).
      </p>
      <ol className="ns-week">
        {week.days.map((d) => (
          <li key={d.day} className="ns-week-day" data-today={d.day === today || undefined}>
            <span className="ns-week-label lf-num">{d.day}</span>
            <span className="ns-week-marks" aria-hidden="true">
              {DAILY_ENTRIES.map((e) => (
                <span key={e.id} className="ns-week-mark" data-on={d.entries[e.id] || undefined} title={e.label} />
              ))}
            </span>
            <span className="ns-week-count lf-num">
              {d.logged}/{DAILY_ENTRIES.length}
            </span>
            <span className="sr-only">
              MET day {d.day}: {DAILY_ENTRIES.filter((e) => d.entries[e.id]).map((e) => e.label).join(', ') || 'nothing'} logged
            </span>
          </li>
        ))}
      </ol>
      <p className="ns-small ns-muted">
        MET days; today (<span className="lf-num">{today}</span>) is outlined. Filled square = logged, open = missing. Mood is
        never counted.
      </p>
    </section>
  )
}

const VAR_LABEL: Record<string, string> = {
  pvt_lapses: 'PVT-B lapses',
  pvt_median_rt: 'PVT-B median reaction time',
  sleep_quality: 'Sleep quality (self-rated)',
  mood: 'Mood (self-rated)',
  fluid_intake_24h: 'Fluid intake, 24 h',
  urine_volume_24h: 'Urine output, 24 h',
  renal_symptoms: 'Renal symptoms (case r4)',
}
for (const s of SYMPTOMS) VAR_LABEL[`symptom_${s.id}`] = s.label

function DoneView({
  logged,
  answers,
  streakLength,
  crewId,
  onAgain,
}: {
  logged: { t: number; observations: Observation[]; text: string }
  answers: NoonAnswers
  streakLength: number
  crewId: CrewId
  onAgain: () => void
}) {
  return (
    <>
      <p className="ns-done-lede" role="status">
        Logged at <MetTime t={logged.t} label /> for {crewId}. Streak: <Num value={streakLength} /> consecutive{' '}
        {streakLength === 1 ? 'fix' : 'fixes'}.
      </p>
      {logged.observations.length ? (
        <table className="ns-table ns-obs">
          <caption className="ns-small ns-muted">
            Observations added to the mission store (engine/SPEC.md section 4 shape)
          </caption>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col" className="num">
                Value
              </th>
              <th scope="col">Source</th>
              <th scope="col">Recorded as</th>
            </tr>
          </thead>
          <tbody>
            {logged.observations.map((o) => (
              <tr key={o.variable}>
                <th scope="row">
                  {VAR_LABEL[o.variable] ?? o.variable}
                  <code className="ns-var">{o.variable}</code>
                </th>
                <td className="num">
                  {o.unit === 'yes/no' ? <span className="lf-mono">{o.value ? 'yes' : 'no'}</span> : <Num value={o.value} unit={o.unit === 'score_1_5' ? '/ 5' : o.unit} />}
                </td>
                <td>
                  <code>{o.source}</code>
                </td>
                <td>
                  {o.provenance === PROVENANCE_MEASURED ? 'measured by the app' : 'entered by the crewmember'}
                  {o.variable === 'mood' ? (
                    <span className="ns-private-tag">
                      <LockIcon /> private
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Nothing was measured or entered this time, so no observation was added. The fix still counts for today.</p>
      )}
      {answers.pvt?.mode === 'demo' ? (
        <p className="ns-small ns-muted">The 30-second demo run is in the logbook note only; it is not a PVT-B result.</p>
      ) : null}
      <p className="ns-small">
        <strong>Logbook:</strong> <span className="ns-logline">{logged.text}</span>
      </p>
      <p className="ns-small ns-muted">
        Time is MET <span className="lf-num">t = {logged.t}</span> s. Nothing here is simulated, and nothing left this device:
        sharing goes through <a href="#/downlink">Downlink</a>, behind your consent.
      </p>
      <div className="ns-nav">
        <ButtonLink href={`#/trends?crew=${crewId}`}>See your trends</ButtonLink>
        <ButtonLink href="#/" variant="secondary">
          Back to Now
        </ButtonLink>
        <Button variant="ghost" onClick={onAgain}>
          Take another check
        </Button>
      </div>
    </>
  )
}
