// The two-minute version of the Method page: what a reviewer needs before opening any section.
// Every number is read from the rules files, the engine or a frozen snapshot as the page renders;
// the alert-class definitions are NASA's words from the frozen Vol 2 snapshot.
import type { MouseEvent, ReactNode } from 'react'
import { useManifest, useSnapshot } from '../../app/data'
import { formatMet } from '../../app/engine'
import { MET_NOW_S } from '../../app/scenario'
import { CREW } from '../../app/vocab'
import { Expander, Num, ReqId } from '../../ui'
import { alertClassFor, alertClasses, normReqId } from './rules'
import { RichText } from './shared'
import type { MetaFile, PersonalFile, ThresholdsFile, Vol2Data } from './rules'
import { secNum } from './sections'
import type { SectionId } from './sections'
import { criticalRow } from './stats'

/** First sentence of a refusal, without its full stop, lower-cased after "No" ("no diagnosis"). */
function headline(text: string): string {
  const h = (/^(.+?)[.;](\s|$)/.exec(text)?.[1] ?? text).trim()
  return /^No\b/.test(h) ? `n${h.slice(1)}` : h
}

/** A quoted definition without its own closing full stop (the sentence around it supplies one). */
function bare(text: string): string {
  return text.replace(/\.\s*$/, '')
}

export function TwoMinute({
  meta,
  personal,
  thresholds,
  onOpen,
}: {
  meta: MetaFile | null
  personal: PersonalFile | null
  thresholds: ThresholdsFile | null
  onOpen: (s: SectionId) => void
}) {
  const m = useManifest()
  const v2 = useSnapshot<Vol2Data>('std_vol2_requirements')
  const scale = useSnapshot<{ energy?: string; unit_definition?: string }>('swpc_s_scale')
  const classes = alertClasses(v2.data)
  const warning = alertClassFor(classes, 'warning')
  const caution = alertClassFor(classes, 'caution')
  const principle = meta?.principles.find((p) => p.id === 'no_nasa_alert_thresholds')
  const ids = (principle?.requirement_ids ?? []).map(normReqId)
  const rci = personal?.rci
  const full = rci ? criticalRow(rci.alpha_two_tailed, rci.baseline_window_days) : null
  const transformed = (personal?.indicators ?? []).filter((i) => i.transform)
  const signed = (personal?.indicators ?? []).filter((i) => /^signed\b/i.test(i.definition?.text ?? ''))
  const aAlert = thresholds?.rules.filter((r) => r.tier === 'A' && r.role === 'alert').length ?? null
  const snapshots = m.status === 'ready' ? m.entries.length : null
  const refusals = (meta?.refusals ?? []).filter((r) => r.id !== 'no_llm_in_decision_path').map((r) => headline(r.text))
  const go = (s: SectionId) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    onOpen(s)
  }
  const See = ({ s, children }: { s: SectionId; children?: ReactNode }) => (
    <a href={`#/method?s=${s}`} onClick={go(s)} className="lf-m-see">
      {children ?? <>section {secNum(s)}</>}
    </a>
  )
  return (
    <section className="lf-m-two" aria-labelledby="m-two-h">
      <h2 id="m-two-h" className="lf-m-two-title">
        The two-minute version
      </h2>
      <ol className="lf-m-two-list">
        <li>
          <strong>There is no NASA alert number to borrow.</strong> NASA-STD-3001 publishes no numeric in-flight alert thresholds for crew health;
          its alert requirements leave the number to the program
          {ids.length ? (
            <>
              {' '}
              (
              {ids.map((id, i) => (
                <span key={id}>
                  {i ? ' ' : ''}
                  <ReqId id={id} />
                </span>
              ))}
              , quoted in <See s="gap" />)
            </>
          ) : null}
          . Every number LANDFALL uses carries a chip naming its basis, and none of its own is presented as NASA’s.
        </li>
        <li>
          <strong>What NASA does publish is used as published, in three shapes.</strong> FFD floors, PEL ceilings and POL changes are never
          merged into one “threshold exceeded” state (<See s="limits" />). With NOAA’s S-scale they make up Tier A:{' '}
          <Num value={aAlert} /> alert rules.
        </li>
        <li>
          <strong>Tier B compares each crewmember with their own baseline.</strong> Crawford &amp; Howell’s single-case t-test against the
          crewmember’s <Num value={rci?.baseline_window_days ?? null} />-day baseline, two-tailed α{' '}
          <Num value={rci?.alpha_two_tailed ?? null} />: a day is flagged beyond |t| <Num value={full?.critical ?? null} digits={3} />, that
          is beyond <Num value={full?.bandSd ?? null} digits={2} /> baseline SDs, the smallest one-day change it can see. A personal change is
          a caution at most.
          {transformed.length ? <> {transformed.map((i) => i.label).join(', ')}, a count, {transformed.length === 1 ? 'is' : 'are'} tested on the Anscombe scale.</> : null}
          {signed.length ? <> {signed.map((i) => i.label).join(', ')} is a signed shift: earlier or later both alert.</> : null} Each
          indicator’s chance rate is measured under the scenario’s noise model, not assumed, and printed next to its band; a case opened by a
          single flag says “possibly chance”. <See s="tiers" /> prints that smallest change for each indicator and crewmember, the measured
          rates, and which scenario events only Tier A catches.
        </li>
        <li>
          <strong>Severity uses NASA’s alert classes.</strong> NASA-STD-3001 Vol 2 Table 10.3-1
          {warning ? <> defines a Warning as “{bare(warning.definition)}”</> : null}
          {caution ? <> and a Caution as “{bare(caution.definition)}”</> : null}. Which finding lands in which class is LANDFALL’s mapping, listed
          in{' '}
          <See s="severity" />. LANDFALL never raises an Emergency.
        </li>
        <li>
          <strong>The environment is real; the crew is simulated.</strong> <Num value={snapshots} /> frozen snapshots of NASA and NOAA data
          (and the scenario) ship with the app; the crew’s vitals come from a seeded generator and are labelled wherever they appear (
          <See s="data" />
          ).
        </li>
        {refusals.length ? (
          <li>
            <strong>Some things it refuses to do,</strong> written into the rules: <RichText text={refusals.join('; ')} /> (
            <See s="refusals" />
            ).
          </li>
        ) : null}
        <li>
          <strong>You can check the arithmetic without trusting this page.</strong> A stdlib-only Python reference engine and the browser’s
          TypeScript engine replay one shared set of conformance vectors (<See s="architecture" />
          ). What this cannot show is in <See s="limitations" />.
        </li>
      </ol>
      <Expander summary="Terms used on this site">
        <dl className="lf-m-terms">
          {[
            {
              k: 'MET',
              v: (
                <>
                  Mission elapsed time: days and time since launch (MET 0), written day/hh:mm:ss. The scenario’s “now” is MET{' '}
                  <span className="lf-mono">{formatMet(MET_NOW_S)}</span>.
                </>
              ),
            },
            { k: 'OWLT', v: 'One-way light time: how long a radio signal takes between the crew and Earth; about a second near Earth, minutes at Mars.' },
            {
              k: 'AOS / LOS',
              v: 'Acquisition / loss of signal: whether a link to the ground exists now. Near solar conjunction Mars is close to the Sun as seen from Earth, and the link is lost for days.',
            },
            {
              k: 'S-scale, pfu',
              v: `NOAA’s scale for solar radiation storms, S1 (minor) to S5 (extreme), set by the ${(scale.data?.energy ?? '').replace('>=', '≥')} proton flux GOES measures near Earth, in particle flux units (${scale.data?.unit_definition ?? 'particles per cm², second and steradian'}).`,
            },
            ...(meta?.categories ?? [])
              .filter((c) => ['FFD', 'PEL', 'POL', 'TARGET'].includes(c.id))
              .map((c) => ({ k: c.id, v: `${c.name}: a ${c.shape}.` })),
            { k: 'Tier A, Tier B', v: 'Tier A: a number NASA or NOAA publishes. Tier B: a change against the crewmember’s own baseline.' },
            {
              k: 'CMO',
              v: `Crew Medical Officer: the crewmember trained to give medical care on board (${CREW.find((c) => /Medical/.test(c.role))?.id ?? 'CM-4'} in the scenario).`,
            },
          ].map((t) => (
            <div key={t.k}>
              <dt>{t.k}</dt>
              <dd>{t.v}</dd>
            </div>
          ))}
        </dl>
      </Expander>
    </section>
  )
}
