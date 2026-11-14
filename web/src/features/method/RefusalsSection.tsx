// Section 4: what LANDFALL refuses to do (engine/rules/meta.json refusals, verbatim).
import { Panel, UnavailableIcon } from '../../ui'
import type { MetaFile } from './rules'
import { RichText, SectionTitle } from './shared'

/** "No diagnosis. LANDFALL reports ..." -> ["No diagnosis.", "LANDFALL reports ..."] */
function splitHeadline(text: string): [string, string] {
  const m = /^(.+?[.;])\s+(.*)$/s.exec(text)
  return m ? [m[1], m[2]] : [text, '']
}

export function RefusalsSection({ meta }: { meta: MetaFile }) {
  return (
    <Panel
      id="m-refusals"
      eyebrow="Refusals"
      title={<SectionTitle n={4}>What LANDFALL refuses to do</SectionTitle>}
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
    </Panel>
  )
}
