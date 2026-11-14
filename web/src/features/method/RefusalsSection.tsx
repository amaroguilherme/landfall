// Section: refusals (engine/rules/meta.json refusals, verbatim).
import { UnavailableIcon } from '../../ui'
import { FoldPanel } from './fold'
import type { MetaFile } from './rules'
import { RichText } from './shared'

/** "No diagnosis. LANDFALL reports ..." -> ["No diagnosis.", "LANDFALL reports ..."] */
function splitHeadline(text: string): [string, string] {
  const m = /^(.+?[.;])\s+(.*)$/s.exec(text)
  return m ? [m[1], m[2]] : [text, '']
}

export function RefusalsSection({ meta }: { meta: MetaFile }) {
  return (
    <FoldPanel
      s="refusals"
      eyebrow="Refusals"
      title="Refusals written into the rules"
      abstract={`${meta.refusals.length} things the system will not do, read from the rules data.`}
      footer={<span>Source: engine/rules/meta.json (refusals). Each case in cases.json also lists its own.</span>}
    >
      <p>
        Refusals are features. Each line below is written into the rules data, so the interface cannot quietly cross it.
      </p>
      <ul className="lf-m-refusals">
        {meta.refusals.map((r) => {
          const [head, rest] = splitHeadline(r.text)
          return (
            <li key={r.id}>
              <UnavailableIcon size={18} />
              <p>
                <strong>
                  <RichText text={head} />
                </strong>
                {rest ? (
                  <>
                    {' '}
                    <RichText text={rest} />
                  </>
                ) : null}
              </p>
            </li>
          )
        })}
      </ul>
    </FoldPanel>
  )
}
