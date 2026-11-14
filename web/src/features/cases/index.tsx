// PLACEHOLDER written by the shell. The cases feature agent replaces this whole folder.
import type { FeatureProps } from '../../app/router'
import { EmptyState } from '../../ui'

export default function CasesPlaceholder({ params }: FeatureProps) {
  return (
    <EmptyState kind="placeholder" title="Cases" headingLevel={1}>
      <p>The three deep cases: renal stone / hydration, sleep / circadian and SPE shelter. Each one: detect, interpret in plain language, one primary countermeasure (alternatives collapsed), guided procedure, outcome log, tripwire and escalation to the ground packet.</p>
      {params.id ? (
        <p>
          Requested case: <code>{params.id}</code>
        </p>
      ) : null}
      <p>This view is being built during the hackathon.</p>
    </EmptyState>
  )
}
