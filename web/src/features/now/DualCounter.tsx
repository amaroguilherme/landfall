// THE DUAL COUNTER: "ASK HOUSTON" (the real round trip from useComms, then QUEUED while the
// real conjunction window blocks the link) next to "LANDFALL" (the app's own measured latency
// and the one primary countermeasure). Every number comes from useComms(), the engine's
// formatMet, or the measurement made in this browser (useHeroTiming); none is typed here.
import type { CSSProperties } from 'react'
import { formatCommsLightTime, formatCountdown, formatEarliestReply } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import { formatUtc } from '../../app/data'
import { formatMet } from '../../app/engine'
import { useMetNow } from '../../app/mission'
import type { Severity } from '../../app/vocab'
import { AntennaIcon, Button, FreshnessChip, MetTime, Num, PlayIcon, ResetIcon, SeverityBadge, SunIcon } from '../../ui'
import { SEQUENCE, phaseAt, rollValue } from './model'
import { useHeroSequence } from './useHeroSequence'

export type AnswerState =
  | { kind: 'measured'; answerMs: number; pageMs: number | null; firstLoad: boolean }
  | { kind: 'pending' }
  | { kind: 'not_measured'; reason: string }
  | { kind: 'unavailable'; reason: string }

export interface LandfallAnswer {
  /** Primary countermeasure title (cases.json), shown once the case is open. */
  action: string | null
  severity: Severity | null
  /** "S3 · Caution" style badge text. */
  badge: string | null
  answer: AnswerState
}

function ResumeCountdown({ resumesAt }: { resumesAt: number }) {
  const t = useMetNow()
  return <>{formatMet(Math.max(0, resumesAt - t))}</>
}

function ResumeWords({ resumesAt }: { resumesAt: number }) {
  const t = useMetNow()
  return <>{formatCountdown(resumesAt - t)}</>
}

/** Where the light time comes from. */
function lightTimeSource(c: CommsStatus): string {
  if (c.basis === 'snapshot') return 'JPL Horizons ephemeris'
  if (c.basis === 'static') return 'environment envelope'
  return 'ephemeris not in this build'
}

/** Unit conversion only (milliseconds per second), not a threshold. */
const MS_PER_SECOND = 1e3
const seconds = (ms: number) => ms / MS_PER_SECOND

/** Inline style of a cross-fading layer at opacity `o` (slides `dy` px while fading). */
function layer(o: number, dy: number): CSSProperties {
  return { opacity: o, transform: o < 1 ? `translateY(${((1 - o) * dy).toFixed(2)}px)` : undefined, visibility: o <= 0 ? 'hidden' : undefined }
}

export function DualCounter({ comms, ready, landfall }: { comms: CommsStatus; ready: boolean; landfall: LandfallAnswer }) {
  const seq = useHeroSequence(ready)
  const e = ready ? seq.elapsed : 0
  const phase = ready ? phaseAt(e) : 'loading'
  const rt = comms.round_trip_s
  const conj = comms.blocked && comms.reason === 'solar_conjunction'
  const resumesAt = comms.resumes_at
  const rolled = rt === null ? null : !ready ? 0 : seq.reduced || !seq.playing ? rt : rollValue(e, rt)

  // Fades (JS-driven, from the sequence clock).
  const f = ready ? seq.fade : () => 0
  const linkIn = f(SEQUENCE.queuedAt + 250, 500)
  const etaOut = comms.blocked ? f(SEQUENCE.queuedAt, 450) : 0
  const standbyOut = f(SEQUENCE.landfallAt, 350)
  const litIn = f(SEQUENCE.landfallAt + 150, 500)
  const actionIn = f(SEQUENCE.landfallAt + 650, 550)
  const linked = linkIn > 0
  const lit = litIn > 0
  const a = landfall.answer

  return (
    <section className="now-dual" aria-labelledby="now-dual-h" data-phase={phase}>
      <div className="now-dual-head">
        <h2 id="now-dual-h" className="now-dual-title">
          Ask Houston, or act onboard
        </h2>
        {ready ? (
          seq.playing ? (
            <Button variant="ghost" className="now-replay" onClick={seq.skip} aria-label="Skip the sequence and show the final state">
              Skip
            </Button>
          ) : (
            <Button variant="secondary" className="now-replay" onClick={seq.replay} aria-label="Replay the dual-counter sequence">
              {seq.reduced ? <PlayIcon size={12} /> : <ResetIcon size={12} />}
              Replay
            </Button>
          )
        ) : null}
      </div>

      <div className="now-dual-grid">
        {/* ---------------- ASK HOUSTON ---------------- */}
        <article className="now-counter now-houston" data-queued={(comms.blocked && linkIn >= 1) || undefined}>
          <header className="now-counter-head">
            <p className="now-counter-label">Ask Houston</p>
            <span className="now-link-tag" aria-hidden="true" style={layer(linkIn, -4)}>
              {comms.blocked ? (
                <span className="now-queued">
                  <SunIcon size={13} />
                  {conj ? 'Queued · solar conjunction' : 'Queued · no link'}
                </span>
              ) : (
                <span className="now-aos">
                  <AntennaIcon size={13} />
                  {comms.link} · link up
                </span>
              )}
            </span>
          </header>

          <div className="now-layers" aria-hidden="true">
            {/* layer 1: the round trip, counting */}
            <div className="now-layer" style={layer(1 - etaOut, -8)}>
              <p className="now-counter-cap">{linked && !comms.blocked ? 'Earliest reply, light time only' : 'Round trip at light speed'}</p>
              <p className="now-big lf-num" data-missing={rt === null || undefined}>
                {rolled === null ? '—' : formatMet(Math.round(rolled))}
              </p>
              <p className="now-counter-sub">
                <span className="lf-num">{formatCommsLightTime(comms)}</span> each way · {lightTimeSource(comms)}
                {linked && !comms.blocked ? ', plus time on the ground' : null}
              </p>
            </div>

            {/* layer 2: the real conjunction window blocks the link */}
            {comms.blocked ? (
              <div className="now-layer" style={layer(linkIn, 8)}>
                <p className="now-counter-cap">
                  Link resumes in
                  {resumesAt !== null ? (
                    <>
                      {' '}
                      <span className="lf-num">
                        <ResumeWords resumesAt={resumesAt} />
                      </span>
                    </>
                  ) : null}
                </p>
                <p className="now-big lf-num" data-missing={resumesAt === null || undefined}>
                  {resumesAt === null ? '—' : <ResumeCountdown resumesAt={resumesAt} />}
                </p>
                <p className="now-counter-sub">
                  {resumesAt !== null ? (
                    <>
                      Earliest reply <span className="lf-num">{formatEarliestReply(comms)}</span> (round trip{' '}
                      <span className="lf-num">{formatCommsLightTime(comms, true)}</span> added at link-up) · messages queued
                    </>
                  ) : (
                    <>Window end unknown: the ephemeris is not in this build.</>
                  )}
                </p>
              </div>
            ) : null}
          </div>

          {/* Screen readers get the final state once, not the animation. */}
          <p className="sr-only">
            Ask Houston: round trip {formatCommsLightTime(comms, true)} at light speed ({lightTimeSource(comms)}).{' '}
            {comms.blocked
              ? `${conj ? 'Solar conjunction blocks the link' : 'No link'}; messages are queued. ${
                  resumesAt !== null
                    ? `The link resumes at MET ${formatMet(resumesAt)}; earliest reply in ${formatEarliestReply(comms)}.`
                    : 'The end of the window is unknown.'
                }`
              : 'The link is up.'}
          </p>

          <footer className="now-counter-foot">
            <span>
              {comms.window ? (
                <>
                  Real conjunction window <span className="lf-num">{formatUtc(comms.window.startUtc)}</span> to{' '}
                  <span className="lf-num">{formatUtc(comms.window.stopUtc)}</span>
                  {resumesAt !== null ? (
                    <>
                      {' '}
                      · link back at <MetTime t={resumesAt} label />
                    </>
                  ) : null}
                </>
              ) : comms.basis === 'fallback' ? (
                <span className="now-missing">Light time unknown: {comms.snapshotId ?? 'ephemeris'} not loaded</span>
              ) : (
                <>Ground link up; every LANDFALL evaluation still runs onboard.</>
              )}
            </span>
            {comms.snapshotId ? (
              <FreshnessChip meta={comms.snapshot} status={comms.snapshotStatus ?? 'loading'} id={comms.snapshotId} compact />
            ) : null}
          </footer>
        </article>

        {/* ---------------- LANDFALL ---------------- */}
        <article className="now-counter now-landfall" data-lit={litIn >= 1 || undefined}>
          <header className="now-counter-head">
            <p className="now-counter-label">LANDFALL · onboard</p>
            {landfall.severity && landfall.badge ? (
              <span aria-hidden={!lit || undefined} style={layer(litIn, -4)}>
                <SeverityBadge severity={landfall.severity} label={landfall.badge} size="sm" />
              </span>
            ) : null}
          </header>

          <div className="now-layers" aria-hidden="true">
            <div className="now-layer" style={layer(1 - standbyOut, -8)}>
              <p className="now-counter-cap">Onboard monitor → rules → case</p>
              <p className="now-standby">{ready ? 'Evaluating onboard data. No ground link needed.' : 'Reading the frozen scenario data.'}</p>
            </div>
            <div className="now-layer" style={layer(litIn, 8)}>
              <p className="now-counter-cap">Guidance on screen in</p>
              <p className="now-big lf-num" data-missing={a.kind !== 'measured' || undefined}>
                {a.kind === 'measured' ? <Num value={seconds(a.answerMs)} digits={3} unit="s" /> : '—'}
              </p>
              {landfall.action ? (
                <p className="now-action" style={{ opacity: actionIn }}>
                  {landfall.action}
                </p>
              ) : null}
            </div>
          </div>

          <p className="sr-only">
            LANDFALL, onboard:{' '}
            {a.kind === 'measured' ? `guidance on screen in ${seconds(a.answerMs).toFixed(3)} seconds, measured in this browser. ` : `${answerCaption(a)} `}
            {landfall.action ? `Primary action: ${landfall.action}.` : 'No case needs action.'}
          </p>

          <footer className="now-counter-foot" style={{ opacity: ready ? Math.max(litIn, 0) : 0 }}>
            <span>{footNote(a)}</span>
          </footer>
        </article>
      </div>
    </section>
  )
}

function answerCaption(a: AnswerState): string {
  switch (a.kind) {
    case 'measured':
      return 'Measured in this browser.'
    case 'pending':
      return 'Measuring in this browser.'
    case 'not_measured':
    case 'unavailable':
      return a.reason
  }
}

function footNote(a: AnswerState) {
  if (a.kind === 'measured') {
    return (
      <>
        Measured in this browser{a.firstLoad ? '' : ' on first load'}: engine opens the case → action painted.
        {a.pageMs !== null ? (
          <>
            {' '}
            Page opened → action: <Num value={seconds(a.pageMs)} digits={2} unit="s" />.
          </>
        ) : null}
      </>
    )
  }
  if (a.kind === 'unavailable' || a.kind === 'not_measured') return <span className="now-missing">{a.reason}</span>
  return <>Measuring in this browser…</>
}
