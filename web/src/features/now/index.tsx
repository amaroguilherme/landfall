// PLACEHOLDER written by the shell. The now feature agent replaces this whole folder.
import type { FeatureProps } from '../../app/router'
import { EmptyState } from '../../ui'

export default function NowPlaceholder(_props: FeatureProps) {
  return (
    <EmptyState kind="placeholder" title="Now" headingLevel={1}>
      <p>The hero: MET 0412/14:20:00 on the Mars surface, inside a solar conjunction. A replayed historical solar proton event reaches NOAA S-scale levels on the onboard monitor, Houston is unreachable, and LANDFALL opens the spe_shelter case from onboard data alone. Includes the double counter: ASK HOUSTON (queued until the conjunction ends) next to LANDFALL (answered onboard).</p>
      <p>This view is being built during the hackathon.</p>
    </EmptyState>
  )
}
