// Build-process notes. Judge-facing pages never cite the project's internal plan, "the build machine" or
// "from memory" in their running text: a snapshot caveat or ingest note that does is kept verbatim, but
// inside a collapsed "Build notes" disclosure (used by #/data, #/method and #/provenance).
import { Expander } from '../../ui'

const BUILD_NOTE = /\bPLANO\b|\b(?:LANDFALL|project) plan\b|\bthe plan(?:'s|’s)?\b|\bbuild machine\b|\bfrom memory\b|\bproject preparation\b/i

/** True when a note refers to the internal plan or to the build process rather than to the data. */
export function isBuildNote(text: string): boolean {
  return BUILD_NOTE.test(text)
}

/** Split notes into those shown in running text and the build notes (order kept in each). */
export function splitBuildNotes(notes: readonly string[]): { shown: string[]; build: string[] } {
  const shown: string[] = []
  const build: string[] = []
  for (const n of notes) (isBuildNote(n) ? build : shown).push(n)
  return { shown, build }
}

/** Collapsed disclosure holding build notes verbatim; renders nothing when there are none. */
export function BuildNotes({ notes, what = 'snapshot' }: { notes: readonly string[]; what?: string }) {
  if (!notes.length) return null
  return (
    <Expander summary={`Build notes (${notes.length})`}>
      <p className="lf-build-lead">
        How this {what} was assembled, kept word for word. These notes refer to the project’s internal working documents, which are not
        part of the submission; nothing on this page depends on them.
      </p>
      <ul className="lf-build-notes">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </Expander>
  )
}
