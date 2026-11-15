// The split of a snapshot whose entries are not all of its snapshot-level provenance (DONKI SEP: the
// entries with an instrument written "MODEL: …" are model forecasts). Counted from the file's own
// entries and shown on the card itself, so the Measured badge is never read as covering the forecasts.
import type { ManifestEntry, SnapshotState } from '../../app/data'
import { Num } from '../../ui'
import { PROVENANCE_LABEL, entrySplit, isProvenance } from './model'

export function EntrySplitNote({ entry, state }: { entry: Pick<ManifestEntry, 'id' | 'provenance'>; state: SnapshotState }) {
  if (state.status === 'loading') {
    return (
      <p className="lfd-split lfd-muted" role="status">
        Counting the entries of <code>{entry.id}.json</code>…
      </p>
    )
  }
  const split = state.status === 'ready' && state.snapshot ? entrySplit(state.snapshot.data) : null
  if (!split) {
    return (
      <p className="lfd-split lfd-muted">
        Observed and model-forecast entries not counted: {state.error ?? `${entry.id}.json has no list of entries`}.
      </p>
    )
  }
  const kind = isProvenance(entry.provenance) ? PROVENANCE_LABEL[entry.provenance] : entry.provenance || 'not stated'
  return (
    <div className="lfd-split" data-split="entries">
      <p className="lfd-split-counts">
        <strong>
          <Num value={split.observed} /> observed by instruments, <Num value={split.model} /> model forecasts
        </strong>
        {split.unlisted ? (
          <>
            , <Num value={split.unlisted} /> with no instrument listed
          </>
        ) : null}{' '}
        <span className="lfd-muted">
          (<Num value={split.total} /> entries, counted from the file)
        </span>
      </p>
      <p className="lfd-note">
        The snapshot-level provenance ({kind}) applies to the <Num value={split.observed} /> observed entries; a model forecast
        (instrument written “MODEL: …”) is a prediction, not a measurement.
      </p>
    </div>
  )
}
