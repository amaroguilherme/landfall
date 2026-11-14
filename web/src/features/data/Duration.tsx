// An exact duration with every number in DM Mono through <Num> (F.5.1 d): "23 h", "1 min 30 s".
import { Num } from '../../ui'
import { durationParts } from './model'

export function Duration({ seconds }: { seconds: number }) {
  return (
    <span className="lfd-dur">
      {durationParts(seconds).map((p, i) => (
        <span key={p.unit}>
          {i ? ' ' : null}
          <Num value={p.value} unit={p.unit} />
        </span>
      ))}
    </span>
  )
}
