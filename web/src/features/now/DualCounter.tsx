// THE DUAL COUNTER: "LANDFALL" (the app's own measured latency and the one primary countermeasure,
// lit FIRST, within 0.3 s) next to "ASK HOUSTON" (the round trip from useComms, counted up after the
// onboard answer is already on screen, then the link-resume countdown while the modelled conjunction
// window blocks the link). Every number comes from useComms(), the engine's formatMet, or the
// measurement made in this browser on this visit; none is typed here.
import type { CSSProperties } from 'react'
import { formatCommsLightTime, formatCountdown, formatEarliestReply, windowModelNote } from '../../app/comms'
import type { CommsStatus } from '../../app/comms'
import { formatUtc } from '../../app/data'
import { formatMet } from '../../app/engine'
import { useMetNow } from '../../app/mission'
import type { Severity } from '../../app/vocab'
import { AntennaIcon, Button, FreshnessChip, MetTime, Num, PlayIcon, ResetIcon, SeverityBadge, SunIcon } from '../../ui'
import { SEQUENCE, phaseAt, rollValue } from './model'
import { useHeroSequence } from './useHeroSequence'

export type AnswerState =
  | { kind: 'measured'; answerMs: number; pageMs: number | null }
  | { kind: 'pending' }
  | { kind: 'unavailable'; reason: string }

export interface LandfallAnswer {
  /** Primary countermeasure title (cases.json) of the case the measured run opened. */
  action: string | null
  severity: Severity | null
  /** "S3 · Warning" style badge text. */
  badge: string | null
  answer: AnswerState
  /** Re-run the onboard path and measure again (null while nothing can be measured). */
  onRemeasure: (() => void) | null
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

export function DualCounter({
  comms,
  ready,
  landfall,
  packetLabel,
}: {
  comms: CommsStatus
  ready: boolean
  landfall: LandfallAnswer
  /** The SPE ground packet's state label (app/packet.ts), shown where the link is described. */
  packetLabel: string | null
}) {
  const seq = useHeroSequence(ready)
  const e = ready ? seq.elapsed : 0
  const phase = ready ? phaseAt(e) : 'loading'
  const rt = comms.round_trip_s
  const conj = comms.blocked && comms.reason === 'solar_conjunction'
  const resumesAt = comms.resumes_at
  const rolled = rt === null ? null : !ready ? 0 : seq.reduced || !seq.playing ? rt : rollValue(e, rt)

  // Fades (JS-driven, from the sequence clock). LANDFALL first, then Houston.
  const f = ready ? seq.fade : () => 0
  const litIn = f(SEQUENCE.landfallAt, 150)
  const standbyOut = f(SEQUENCE.landfallAt, 120)
  const actionIn = f(SEQUENCE.actionAt, 200)
  const linkIn = f(SEQUENCE.queuedAt + 250, 500)
  const etaOut = comms.blocked ? f(SEQUENCE.queuedAt, 450) : 0
  const lit = litIn > 0
  const a = landfall.answer
  const replay = () => {
    landfall.onRemeasure?.()
    seq.replay()
  }

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
            <Button variant="secondary" className="now-replay" onClick={replay} aria-label="Replay the sequence and measure the onboard answer again">
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
            <span className="now-link-tag" aria-hidden="true" style={layer(comms.blocked ? linkIn : 1, -4)}>
              {comms.blocked ? (
                <span className="now-queued">
                  <SunIcon size={13} />
                  {conj ? 'No link · solar conjunction' : 'No link'}
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
              <p className="now-counter-cap">{!comms.blocked ? 'Earliest reply, light time only' : 'Round trip at light speed'}</p>
              <p className="now-big lf-num" data-missing={rt === null || undefined}>
                {rolled === null ? '—' : formatMet(Math.round(rolled))}
              </p>
              <p className="now-counter-sub">
                <span className="lf-num">{formatCommsLightTime(comms)}</span> each way · {lightTimeSource(comms)}
                {!comms.blocked ? ', plus time on the ground' : null}
              </p>
            </div>

            {/* layer 2: the modelled conjunction window blocks the link */}
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
                      Earliest reply <span className="lf-num">{formatEarliestReply(comms)}</span> (the{' '}
                      <span className="lf-num">{formatCommsLightTime(comms, true)}</span> round trip added at link-up)
                      {packetLabel ? (
                        <>
                          {' '}
                          · ground packet: <span className="now-packet">{packetLabel}</span>
                        </>
                      ) : null}
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
              ? `${conj ? 'Solar conjunction blocks the link' : 'No link'}. ${
                  resumesAt !== null
                    ? `The link resumes at MET ${formatMet(resumesAt)}; earliest reply in ${formatEarliestReply(comms)}.`
                    : 'The end of the window is unknown.'
                }${packetLabel ? ` Ground packet: ${packetLabel}.` : ''}`
              : 'The link is up: the ground has the case within the round trip, and the crew follows Mission Control and flight-surgeon direction.'}
          </p>

          <footer className="now-counter-foot">
            <span>
              {comms.window ? (
                <>
                  Conjunction window <span className="lf-num">{formatUtc(comms.window.startUtc)}</span> to{' '}
                  <span className="lf-num">{formatUtc(comms.window.stopUtc)}</span>, {windowModelNote(comms.windowModel)}
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
                <>Link up: the ground has this case within the round trip. Every LANDFALL evaluation still runs onboard.</>
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
              <p className="now-counter-cap">Space-weather monitor → rules → case</p>
              <p className="now-standby">Reading the frozen scenario data.</p>
            </div>
            <div className="now-layer" style={layer(litIn, 8)}>
              <p className="now-counter-cap">Guidance on screen in</p>
              <p className="now-big lf-num" data-missing={a.kind === 'unavailable' || undefined}>
                {a.kind === 'measured' ? (
                  <Num value={seconds(a.answerMs)} digits={3} unit="s" />
                ) : a.kind === 'pending' ? (
                  <span className="now-measuring">measuring</span>
                ) : (
                  '—'
                )}
              </p>
              {landfall.action ? (
                <p className="now-action" data-hero-answer="" style={{ opacity: actionIn }}>
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
            {landfall.onRemeasure && a.kind === 'measured' ? (
              <button type="button" className="lf-linkbtn now-remeasure" onClick={landfall.onRemeasure}>
                Measure again
              </button>
            ) : null}
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
    case 'unavailable':
      return a.reason
  }
}

function footNote(a: AnswerState) {
  if (a.kind === 'measured') {
    return (
      <>
        Measured in this browser on this visit: the engine evaluates the latest monitor reading and opens the case, then the action is painted.
        Software time only; going to the shelter takes the crew minutes.
        {a.pageMs !== null ? (
          <>
            {' '}
            Page opened → action: <Num value={seconds(a.pageMs)} digits={2} unit="s" />.
          </>
        ) : null}
      </>
    )
  }
  if (a.kind === 'unavailable') return <span className="now-missing">{a.reason}</span>
  return <>Measuring in this browser…</>
}
