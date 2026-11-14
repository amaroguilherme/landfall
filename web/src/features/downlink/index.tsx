// PLACEHOLDER written by the shell. The downlink feature agent replaces this whole folder.
import type { FeatureProps } from '../../app/router'
import { EmptyState } from '../../ui'

export default function DownlinkPlaceholder(_props: FeatureProps) {
  return (
    <EmptyState kind="placeholder" title="Ground packet" headingLevel={1}>
      <p>The delay-tolerant packet for the flight surgeon: FHIR R4 Observations queued for the next AOS, behind the crewmember’s privacy gate: What LANDFALL knows versus What Houston sees.</p>
      <p>This view is being built during the hackathon.</p>
    </EmptyState>
  )
}
