// Noon Sight, medical-kit step (D8): one cuff blood pressure reading and one fasting fingerstick
// glucose, twice a week, typed in by the crewmember. They become Tier B observations (bp_systolic,
// bp_diastolic in mmHg, glucose in mg/dL; source manual), compared only with the crewmember's own
// baseline, caution at most. NASA-STD-3001 sets no number for either (personal.json limit_note).
// Plausibility: an entry range catches typing and unit errors (design choice, never a clinical
// limit), and a value outside the crewmember's own band (from the engine) asks for a re-measure and
// a confirmation that repeats the value and unit. Anything not taken today needs a reason.
import type { ReactNode } from 'react'
import { RULES, getIndicator } from '../../app/engine'
import type { Indicator } from '../../app/engine'
import { useCrewEvaluation } from '../../app/model'
import type { CrewId } from '../../app/vocab'
import { Chip, Expander, ExternalIcon, Num, UnavailableIcon } from '../../ui'
import { KIT_ENTRY_RANGE_RATIONALE, KIT_INTERVAL_DAYS, KIT_SKIP_REASONS, KIT_SPECS, checkKit } from './record'
import type { Band, KitDraft, KitSchedule, KitSkipId, KitVariable } from './record'

const KIT_VARIABLES: KitVariable[] = ['bp_systolic', 'bp_diastolic', 'glucose']

function indicator(id: KitVariable): Indicator | null {
  try {
    return getIndicator(RULES, id) as Indicator
  } catch {
    return null
  }
}

/**
 * The crewmember's own band for each kit indicator: the engine's finding.band, in the indicator's own unit (the
 * baseline mean -/+ its minimum detectable change on the test scale, mapped back; the kit readings have no transform).
 */
export function useKitBands(crewId: CrewId): Record<KitVariable, Band | null> {
  const crew = useCrewEvaluation(crewId)
  const out = { bp_systolic: null, bp_diastolic: null, glucose: null } as Record<KitVariable, Band | null>
  for (const v of KIT_VARIABLES) {
    const b = crew?.tierB.find((e) => e.indicator.id === v)?.finding.band
    if (b && Number.isFinite(b.low) && Number.isFinite(b.high)) out[v] = { lo: b.low, hi: b.high }
  }
  return out
}

/** A short link to the context's source (the full study citation lives on Provenance). */
function ContextLink({ source }: { source: unknown }) {
  const url = (source as { url?: unknown } | null | undefined)?.url
  if (typeof url !== 'string') return null
  const study = url.split('/').filter(Boolean).pop() ?? 'study'
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="lf-ext">
      NASA OSDR, {study}
      <ExternalIcon />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function KitField({
  id,
  variable,
  raw,
  onChange,
  error,
}: {
  id: string
  variable: KitVariable
  raw: string
  onChange: (s: string) => void
  error: string | null
}) {
  const spec = KIT_SPECS[variable]
  return (
    <div className="ns-field">
      <label htmlFor={id} className="ns-field-label">
        {spec.label}
      </label>
      <div className="ns-field-row">
        <input
          id={id}
          className="ns-input lf-mono"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={variable === 'glucose' ? 'e.g. 92' : variable === 'bp_systolic' ? 'e.g. 118' : 'e.g. 76'}
          value={raw}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <span className="ns-field-unit">{spec.unit}</span>
      </div>
      {error ? (
        <p id={`${id}-err`} className="ns-field-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function BandLine({ band, unit, digits = 0 }: { band: Band | null; unit: string; digits?: number }) {
  if (!band) return <span className="ns-muted">no band yet (fewer baseline readings than the test needs)</span>
  return (
    <>
      <Num value={Math.max(0, band.lo)} digits={digits} />–<Num value={band.hi} unit={unit} digits={digits} />
    </>
  )
}

export function KitStep({
  crewId,
  draft,
  onDraft,
  schedule,
  onBack,
  onNext,
  stepNav,
}: {
  crewId: CrewId
  draft: KitDraft
  onDraft: (d: KitDraft) => void
  schedule: KitSchedule
  onBack: () => void
  onNext: (kit: { systolic: number | null; diastolic: number | null; glucose: number | null; skip: string | null }) => void
  /** The step's navigation row (rendered by the parent so every step looks the same). */
  stepNav: (p: { onBack: () => void; onNext: () => void; nextLabel: string; nextDisabled: boolean; skipHint?: string }) => ReactNode
}) {
  const bands = useKitBands(crewId)
  const set = (patch: Partial<KitDraft>) => onDraft({ ...draft, ...patch })
  const sysInd = indicator('bp_systolic')
  const gluInd = indicator('glucose')
  const range = gluInd?.context?.range ?? null
  // When the kit is not due, "not due today" is preselected, so skipping costs one click.
  const skipId: KitSkipId | null = draft.skipId ?? (!schedule.due ? 'not_due' : null)
  const c = checkKit({ ...draft, skipId }, bands)

  return (
    <>
      <p className="ns-kit-due" data-due={schedule.due || undefined}>
        <strong>{schedule.due ? 'Due today.' : 'Not due today.'}</strong> Twice a week, about every {KIT_INTERVAL_DAYS} to{' '}
        <span className="lf-num">{KIT_INTERVAL_DAYS + 1}</span> days <Chip kind="design choice" />.{' '}
        {schedule.lastDay !== null ? (
          <>
            Last reading: MET day <span className="lf-num">{schedule.lastDay}</span>
            {schedule.daysSince !== null ? (
              <>
                {' '}
                (<Num value={schedule.daysSince} /> {schedule.daysSince === 1 ? 'day' : 'days'} ago)
              </>
            ) : null}
            {schedule.nextDay !== null && !schedule.due ? (
              <>
                ; due again from MET day <span className="lf-num">{schedule.nextDay}</span>. You can still take one now.
              </>
            ) : (
              '.'
            )}
          </>
        ) : (
          'No reading on record yet.'
        )}
      </p>
      <p className="ns-nmh">
        <UnavailableIcon size={14} /> <strong>NOT MEASURABLE HERE.</strong> The band has no blood-pressure or glucose sensor. Use the
        cuff and the glucometer of the vehicle medical kit and type the numbers in. An empty box is logged as not taken, never as zero.
      </p>

      <fieldset className="ns-kit-group">
        <legend>Blood pressure, cuff</legend>
        <ol className="ns-how">
          <li>At the same time as your baseline readings: 30 minutes after waking, before breakfast.</li>
          <li>Sit still for 5 minutes first (restrained, in weightlessness), back supported, arm resting at heart level.</li>
          <li>Cuff on the bare upper arm, the same arm every time. Stay quiet while it measures.</li>
          <li>Type the two numbers it shows: the top one (systolic) and the bottom one (diastolic).</li>
        </ol>
        <div className="ns-fields ns-fields-pair">
          <KitField id="ns-sys" variable="bp_systolic" raw={draft.sysRaw} onChange={(v) => set({ sysRaw: v, confirmBp: false })} error={c.errors.systolic} />
          <KitField id="ns-dia" variable="bp_diastolic" raw={draft.diaRaw} onChange={(v) => set({ diaRaw: v, confirmBp: false })} error={c.errors.diastolic} />
        </div>
        {c.errors.pair ? (
          <p className="ns-field-err" role="alert">
            {c.errors.pair}
          </p>
        ) : null}
        <p className="ns-small ns-muted">
          Your own band, from your baseline: systolic <BandLine band={bands.bp_systolic} unit="mmHg" />, diastolic{' '}
          <BandLine band={bands.bp_diastolic} unit="mmHg" />.
        </p>
        {c.bpOutside ? (
          <label className="ns-check ns-confirm">
            <input type="checkbox" checked={draft.confirmBp} onChange={(e) => set({ confirmBp: e.target.checked })} />
            <span>
              Outside your own band: rest, measure again, and confirm.{' '}
              <strong>
                I re-measured: <span className="lf-num">{c.systolic}</span>/<span className="lf-num">{c.diastolic}</span> mmHg is what the cuff shows.
              </strong>
            </span>
          </label>
        ) : null}
      </fieldset>

      <fieldset className="ns-kit-group">
        <legend>Blood glucose, fingerstick</legend>
        <ol className="ns-how">
          <li>Fasting: before breakfast, at the same time as your baseline readings.</li>
          <li>Wash and dry your hands, then prick the side of a fingertip with the kit’s lancet.</li>
          <li>
            Put the drop on the strip as the meter shows, then type the number in mg/dL. If the meter shows LO or HI instead of a number,
            LANDFALL cannot record it: tell your Crew Medical Officer now.
          </li>
        </ol>
        <div className="ns-fields">
          <KitField id="ns-glu" variable="glucose" raw={draft.gluRaw} onChange={(v) => set({ gluRaw: v, confirmGlu: false })} error={c.errors.glucose} />
        </div>
        <p className="ns-small ns-muted">
          Your own band, from your baseline: <BandLine band={bands.glucose} unit="mg/dL" />. Glucose can move either way, so a reliable
          change in either direction raises a caution.
        </p>
        {c.glucoseOutside ? (
          <label className="ns-check ns-confirm">
            <input type="checkbox" checked={draft.confirmGlu} onChange={(e) => set({ confirmGlu: e.target.checked })} />
            <span>
              Outside your own band: wash your hands, test again, and confirm.{' '}
              <strong>
                I re-tested: <span className="lf-num">{c.glucose}</span> mg/dL is what the meter shows.
              </strong>
            </span>
          </label>
        ) : null}
        {range ? (
          <p className="ns-small ns-context-line">
            <strong>Context only, not a limit:</strong> the Inspiration4 crew’s laboratory serum glucose was reported against a reference
            range of <Num value={range.min} />–<Num value={range.max} unit={range.unit} />. A fingerstick reading is not a laboratory serum
            value, and LANDFALL never alerts on this range. <Chip kind={gluInd?.context?.chip} /> <ContextLink source={gluInd?.context?.source} />
          </p>
        ) : null}
      </fieldset>

      <div className="ns-context">
        <p className="ns-context-title">For context, not an alarm</p>
        <ul>
          <li>
            NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health; its alert requirements leave the number to
            the program, and it prints none for blood pressure or blood glucose. LANDFALL compares each reading only with your own
            baseline (a caution at most), never with a population cut-off, and does not diagnose.
          </li>
          <li>
            A reading above your band (for glucose, above or below it) is a reliable change in the worse direction: it raises a caution
            that asks you to repeat the reading and tell your Crew Medical Officer today.
          </li>
        </ul>
        <Expander summary="Why there is no NASA number, and the entry checks">
          {sysInd?.limit_note?.text ? (
            <p className="ns-small">
              Blood pressure: {sysInd.limit_note.text} <Chip kind={sysInd.limit_note.chip} />
            </p>
          ) : null}
          {gluInd?.limit_note?.text ? (
            <p className="ns-small">
              Glucose: {gluInd.limit_note.text} <Chip kind={gluInd.limit_note.chip} />
            </p>
          ) : null}
          <p className="ns-small">
            Entry ranges: systolic <Num value={KIT_SPECS.bp_systolic.min} />–<Num value={KIT_SPECS.bp_systolic.max} unit="mmHg" />, diastolic{' '}
            <Num value={KIT_SPECS.bp_diastolic.min} />–<Num value={KIT_SPECS.bp_diastolic.max} unit="mmHg" />, glucose{' '}
            <Num value={KIT_SPECS.glucose.min} />–<Num value={KIT_SPECS.glucose.max} unit="mg/dL" />. {KIT_ENTRY_RANGE_RATIONALE}{' '}
            <Chip kind="design choice" />
          </p>
          <p className="ns-small">
            The routine (time of day, rest, same arm, fasting) is ours, so that each reading compares fairly with your own baseline; for
            the devices themselves, follow the medical kit’s instructions. <Chip kind="design choice" />
          </p>
        </Expander>
      </div>

      {c.missing ? (
        <fieldset className="ns-rating ns-kit-skip">
          <legend>{c.bpTaken || c.glucoseTaken ? 'Not taking the rest today? Pick a reason' : 'Not taking them today? Pick a reason'}</legend>
          <p className="ns-small ns-muted">It goes in the logbook, so a gap in the record has an explanation.</p>
          <div className="ns-skip-opts">
            {KIT_SKIP_REASONS.map((r) => (
              <label key={r.id} className="ns-check">
                <input type="radio" name="ns-kit-skip" value={r.id} checked={skipId === r.id} onChange={() => set({ skipId: r.id })} />
                <span>{r.label}</span>
              </label>
            ))}
          </div>
          {skipId === 'other' ? (
            <div className="ns-field">
              <label htmlFor="ns-kit-other" className="ns-field-label">
                The reason
              </label>
              <input
                id="ns-kit-other"
                className="ns-input ns-input-text"
                type="text"
                autoComplete="off"
                value={draft.skipOther}
                onChange={(e) => set({ skipOther: e.target.value })}
              />
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {stepNav({
        onBack,
        onNext: () => onNext({ systolic: c.systolic, diastolic: c.diastolic, glucose: c.glucose, skip: c.missing ? c.skipText : null }),
        nextLabel: 'Next: symptoms',
        nextDisabled: !c.ok,
        skipHint: !c.ok
          ? c.needsConfirm
            ? 'Re-measure and confirm the value outside your band to continue.'
            : c.missing && !c.skipText
              ? 'Enter the readings, or pick a reason for not taking them.'
              : 'Check the highlighted entry.'
          : undefined,
      })}
    </>
  )
}
