// The Method page's last section, "Find it in NASA's words" (#/method?s=find): the fold, and the search inside it.
// It is part of the Method chunk, not a lazy one. The fold renders its body on every Method visit (so find-in-page
// works on a closed section), so a lazy chunk would defer nothing, and a dynamic import from the Method chunk makes
// Vite export its preload helper from the entry chunk, which renames every chunk the service worker precaches. The
// model files are the lazy part: they load only on the first search (embed.ts).
import { Component } from 'react'
import type { ReactNode } from 'react'
import { FoldPanel } from '../method/fold'
import { MissingNote } from '../method/shared'
import FindSection from './FindSection'

/** An error in the search keeps the rest of the Method page: only this section says so. */
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <MissingNote>The search could not open in this browser; the rest of this page is unaffected.</MissingNote> : this.props.children
  }
}

export function FindPanel() {
  return (
    <FoldPanel
      s="find"
      eyebrow="Search, not ask"
      title="Find it in NASA’s words"
      abstract="Type a question or paste a sentence, and read NASA’s closest frozen text: a keyword column first, then a small open model’s ranking. Symptom words raise a fixed banner from a word list."
    >
      <Contained>
        <FindSection />
      </Contained>
    </FoldPanel>
  )
}
