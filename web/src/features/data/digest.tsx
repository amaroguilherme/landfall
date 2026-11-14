// Facts computed from a snapshot's own data and shown above its caveats on #/data, for the snapshots
// whose meaning depends on a distinction the caveats state only in words: DONKI's observed entries vs
// model forecasts, and the modelled (not "real") Mars conjunction windows.
import type { Snapshot } from '../../app/data'
import { Num } from '../../ui'
import { isModelEntry } from '../radiation/model'
import type { DonkiData } from '../radiation/model'

interface MarsCommsData {
  conjunctions?: Array<{ id: string; start_date?: string; end_date?: string; threshold_deg?: number }>
  calibration?: {
    threshold_deg?: { value?: number; chip?: string }
    residual_rms_days?: number
    residual_max_abs_days?: number
    n_edges?: number
    published?: Array<{ id: string; used_in_calibration?: boolean }>
  }
}

function DonkiDigest({ data }: { data: DonkiData }) {
  const events = data.events ?? []
  const model = events.filter(isModelEntry)
  const observed = events.filter((e) => !isModelEntry(e))
  const bySpacecraft = new Map<string, number>()
  for (const e of observed) {
    for (const i of e.instruments) {
      const craft = i.split(':')[0].trim() || i
      bySpacecraft.set(craft, (bySpacecraft.get(craft) ?? 0) + 1)
    }
  }
  const crafts = [...bySpacecraft.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  return (
    <p className="lfd-p lfd-digest">
      <strong>Observed or modelled:</strong> <Num value={events.length} /> entries. <Num value={observed.length} /> name an observing
      instrument (
      {crafts.map(([c, n], i) => (
        <span key={c}>
          {i ? ', ' : ''}
          {c} <Num value={n} />
        </span>
      ))}
      ); <Num value={model.length} /> are model forecasts, with an instrument written “MODEL: …”. A forecast is not an observation:
      LANDFALL never counts one as a confirmation. <a href="#/radiation">Radiation</a> uses the observed entries as a timing cross-check of
      the lunar-orbit dose record (choose Cislunar there).
    </p>
  )
}

function MarsCommsDigest({ data }: { data: MarsCommsData }) {
  const cal = data.calibration
  const threshold = cal?.threshold_deg?.value ?? null
  const used = cal?.published?.filter((p) => p.used_in_calibration).length ?? null
  return (
    <p className="lfd-p lfd-digest">
      <strong>The conjunction windows are modelled, not published dates:</strong> they are the days the Sun–Earth–Mars elongation computed
      from JPL Horizons geometry is below <Num value={threshold} unit="°" />, a threshold fitted to the edges of <Num value={used} /> NASA/JPL
      published command moratoria (<Num value={cal?.n_edges ?? null} /> edges; RMS residual <Num value={cal?.residual_rms_days ?? null} unit="d" />
      , worst <Num value={cal?.residual_max_abs_days ?? null} unit="d" />).
      {data.conjunctions?.length ? (
        <>
          {' '}
          Modelled windows in this file:{' '}
          {data.conjunctions.map((c, i) => (
            <span key={c.id}>
              {i ? '; ' : ''}
              <span className="lf-mono">
                {c.start_date} to {c.end_date}
              </span>
            </span>
          ))}
          .
        </>
      ) : null}
    </p>
  )
}

/** The digest for a snapshot id, or nothing. */
export function SnapshotDigest({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.id === 'swpc_sep_events') return <DonkiDigest data={snapshot.data as DonkiData} />
  if (snapshot.id === 'horizons_mars_comms') return <MarsCommsDigest data={snapshot.data as MarsCommsData} />
  return null
}
