// Section: known limitations, short and honest. Numbers come from the rules and snapshots.
import { useSnapshot } from '../../app/data'
import { CASE_DEFS } from '../../app/caseTimeline'
import { ENGINE_IS_SHIM } from '../../app/engine'
import { Link } from '../../app/location'
import { Num } from '../../ui'
import { FoldPanel } from './fold'
import type { OsdrCmpData, PersonalFile, ThresholdsFile, Vol1Data, Vol2Data } from './rules'
import { secNum } from './sections'
import { noiseEntry } from './episodes'

interface SimCalibration {
  variables?: Record<string, { calibration?: Array<{ item: string; value: string; chip: string }> }>
}

/** Rules with an action block (thresholds.json `action`: {label, text, chip, source}). */
type ActionRule = ThresholdsFile['rules'][number] & { case_id?: string | null; action?: { label?: string; text?: string } }

export function LimitationsSection({ personal, thresholds }: { personal: PersonalFile; thresholds: ThresholdsFile }) {
  const v1 = useSnapshot<Vol1Data>('std_vol1_requirements')
  const v2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const osdr = useSnapshot<OsdrCmpData>('osdr_cmp')
  const sim = useSnapshot<SimCalibration>('sim_crew')
  const alertingInd = personal.indicators.filter((i) => i.alerting)
  const alerting = alertingInd.length
  const transformed = personal.indicators.filter((i) => i.transform)
  const noInflightDxa = thresholds.rules.some((r) => r.category === 'POL' && (r.notes ?? []).some((n) => /no in-flight DXA/i.test(n)))
  const tailoring = v1.snapshot?.caveats.find((c) => /tailor/i.test(c))
  // The simulator's day-to-day noise basis per alerting indicator, as sim_crew records it.
  const noise = alertingInd.map((i) => noiseEntry(sim.data, i.variable))
  const noiseDesign = noise.filter((c) => c?.chip === 'design choice').length
  const noiseLit = noise.filter((c) => c?.chip === 'literature').length
  // Tier A alert findings that open no guided case: exactly the rules that carry a one-line `action` (SPEC 3.2:
  // every alerting rule no case lists as a trigger has one, OPS excepted). Not `!case_id`: such a rule may name a
  // related case for context (the organ-dose and bone-density rules do) without opening it.
  const noCase = (thresholds.rules as ActionRule[]).filter((r) => r.tier === 'A' && r.role === 'alert' && r.action)
  const noCaseLabels = [...new Set(noCase.map((r) => r.action?.label ?? r.label))]
  return (
    <FoldPanel
      s="limitations"
      eyebrow="Limits of this work"
      title="Known limitations"
      abstract="Simulated crew, lower-bound chance rates and real chance flags, a replayed solar event, frozen standards, and what is not a medical device."
    >
      <ul className="lf-m-limits">
        <li>
          <strong>The crew is simulated.</strong>{' '}
          {sim.data ? (
            <>
              The simulator’s day-to-day scatter is a design choice for <Num value={noiseDesign} /> of the <Num value={alerting} /> alerting
              indicators
              {noiseLit ? (
                <>
                  {' '}
                  and follows cited literature for <Num value={noiseLit} />
                </>
              ) : null}
              . Real within-person scatter may be larger: that would not change the chance rate, but it would raise the smallest change Tier B
              can flag and could hide episodes the demo shows cleanly (section <Num value={secNum('tiers')} /> prints that smallest change and
              what each tier catches).
            </>
          ) : (
            <>
              Real within-person scatter may be larger than the simulator’s, which would raise the smallest change Tier B can flag (section{' '}
              <Num value={secNum('tiers')} />
              ).
            </>
          )}
        </li>
        <li>
          <strong>Tier B’s printed chance rates are a lower bound for real data.</strong> The single-case test gives exactly α per
          indicator-day only if day-to-day noise is normal and independent.{' '}
          {transformed.length ? <>{transformed.map((i) => i.label).join(', ')}, skewed counts, {transformed.length === 1 ? 'is' : 'are'} tested on the Anscombe scale, </> : null}
          and the rate of every indicator is measured under the scenario’s own noise model, which has no autocorrelation; real days are
          correlated, which pushes the real rate up. <Num value={alerting} /> of <Num value={personal.indicators.length} /> indicators can alert,
          and α itself is our design choice (section <Num value={secNum('tiers')} />
          ).
        </li>
        <li>
          <strong>Chance flags are real at the project seed.</strong> The seed was fixed before the noise model and is never re-drawn to hide
          them: a case opened by a single personal flag is labelled “possibly chance” with that indicator’s own rate, and the crew re-measures.
        </li>
        <li>
          <strong>The only real crew chemistry is small and short:</strong> Inspiration4,{' '}
          {osdr.data ? (
            <>
              n = <Num value={osdr.data.subjects.length} />,
            </>
          ) : null}{' '}
          no in-flight samples. It shows real lab ranges and a real recovery shape, not a long-duration mission.
        </li>
        <li>
          <strong>The Mars solar particle event is a replay.</strong> A real proton profile measured near Earth by GOES-7 in October 1989
          stands in for an external space-weather monitor in Mars orbit, with no correction for distance from the Sun or for the atmosphere.
          The habitat dose rate shown with it is a simulated confirmation under an assumed scaling, not a radiation-transport calculation.
        </li>
        {noCaseLabels.length ? (
          <li>
            <strong>Not every finding opens a guided case.</strong> The guided cases are <Num value={CASE_DEFS.length} />:{' '}
            {CASE_DEFS.map((c) => c.title).join('; ')}.{' '}
            {noCase.length === 1 ? 'One Tier A alert rule opens' : <><Num value={noCase.length} /> Tier A alert rules open</>} no case and
            carry a one-line action instead: {noCaseLabels.join('; ')}.
          </li>
        ) : null}
        {noInflightDxa ? (
          <li>
            <strong>Some NASA limits cannot be checked in flight.</strong> Bone density is measured by DXA before and after flight, so the POL
            rules usually read “insufficient data” during a mission.
          </li>
        ) : null}
        <li>
          <strong>The standards are frozen copies:</strong> NASA-STD-3001 Vol 1 Rev {v1.data?.document.revision ?? '—'} (
          <span className="lf-mono">{v1.data?.document.date ?? '—'}</span>) and Vol 2 Rev {v2.data?.document.revision ?? '—'} (
          <span className="lf-mono">{v2.data?.document.approved ?? '—'}</span>).{' '}
          {tailoring ? 'Programs tailor them, so a requirement shown here is not automatically binding on a given mission.' : null}
        </li>
        {ENGINE_IS_SHIM ? (
          <li>
            <strong>The browser engine is not wired in this build;</strong> findings read “insufficient data” until the TypeScript port
            replaces the shell stub (section <Num value={secNum('architecture')} />
            ).
          </li>
        ) : null}
        <li>
          <strong>Not a medical device.</strong> No clinical validation, no diagnosis, no medication advice, and not endorsed by NASA. Every
          number’s basis is on <Link to="/provenance">Provenance</Link>.
        </li>
      </ul>
    </FoldPanel>
  )
}
