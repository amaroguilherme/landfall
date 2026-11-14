// PLACEHOLDER written by the shell. The trends feature agent replaces this whole folder.
import type { FeatureProps } from '../../app/router'
import { EmptyState } from '../../ui'

export default function TrendsPlaceholder(_props: FeatureProps) {
  return (
    <EmptyState kind="placeholder" title="Trends" headingLevel={1}>
      <p>Dynamic charts of each indicator over MET days 368 to 412 against the crewmember’s own baseline (days 368 to 381), with reliable-change markers and the expected false-alarm rate printed next to them.</p>
      <p>This view is being built during the hackathon.</p>
    </EmptyState>
  )
}
