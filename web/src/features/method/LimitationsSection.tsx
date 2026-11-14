// Section 7: known limitations, short and honest. Numbers come from the rules and snapshots.
import { useSnapshot } from '../../app/data'
import { ENGINE_IS_SHIM } from '../../app/engine'
import { Link } from '../../app/location'
import { Num, Panel } from '../../ui'
import type { OsdrCmpData, PersonalFile, ThresholdsFile, Vol1Data, Vol2Data } from './rules'
import { SectionTitle } from './shared'

export function LimitationsSection({ personal, thresholds }: { personal: PersonalFile; thresholds: ThresholdsFile }) {
  const v1 = useSnapshot<Vol1Data>('std_vol1_requirements')
  const v2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const osdr = useSnapshot<OsdrCmpData>('osdr_cmp')
  const alerting = personal.indicators.filter((i) => i.alerting).length
  const noInflightDxa = thresholds.rules.some((r) => r.category === 'POL' && (r.notes ?? []).some((n) => /no in-flight DXA/i.test(n)))
  const tailoring = v1.snapshot?.caveats.find((c) => /tailor/i.test(c))
  return (
    <Panel id="m-limitations" eyebrow="Limits of this work" title={<SectionTitle n={7}>Known limitations</SectionTitle>}>
      <ul className="lf-m-limits">
        <li>
          <strong>The crew is simulated.</strong> Their day-to-day scatter is deliberately smaller than real people’s, so the
          demo shows clean episodes that real data would blur (sim_crew caveats, section <Num value={5} />).
        </li>
        <li>
          <strong>Tier B’s printed chance rate is a lower bound.</strong> The single-case test gives exactly α per
          indicator-day only if day-to-day noise is normal and independent; real days are correlated, and counts such as
          PVT-B lapses are skewed, which push the rate up. <Num value={alerting} /> of{' '}
          <Num value={personal.indicators.length} /> indicators can alert, and α itself is our design choice (section{' '}
          <Num value={3} />).
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
          <strong>The Mars solar particle event is a replay.</strong> A real historical proton profile measured in Earth
          orbit stands in for a habitat monitor on Mars, with no distance, shielding or atmosphere correction.
        </li>
        {noInflightDxa ? (
          <li>
            <strong>Some NASA limits cannot be checked in flight.</strong> Bone density is measured by DXA before and after
            flight, so the POL rules usually read “insufficient data” during a mission.
          </li>
        ) : null}
        <li>
          <strong>The standards are frozen copies:</strong> NASA-STD-3001 Vol 1 Rev {v1.data?.document.revision ?? '—'}{' '}
          (<span className="lf-mono">{v1.data?.document.date ?? '—'}</span>) and Vol 2 Rev {v2.data?.document.revision ?? '—'}{' '}
          (<span className="lf-mono">{v2.data?.document.approved ?? '—'}</span>).{' '}
          {tailoring ? 'Programs tailor them, so a requirement shown here is not automatically binding on a given mission.' : null}
        </li>
        {ENGINE_IS_SHIM ? (
          <li>
            <strong>The browser engine is not wired in this build;</strong> findings read “insufficient data” until the
            TypeScript port replaces the shell stub (section <Num value={6} />).
          </li>
        ) : null}
        <li>
          <strong>Not a medical device.</strong> No clinical validation, no diagnosis, no dosing, and not endorsed by NASA.
          Every number’s basis is on <Link to="/provenance">Provenance</Link>.
        </li>
      </ul>
    </Panel>
  )
}
