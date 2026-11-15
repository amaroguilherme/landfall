// Section: architecture in one paragraph, a small flow diagram (HTML + CSS, no image), and a
// copyable "check our arithmetic" command.
import { useRef, useState } from 'react'
import { useManifest } from '../../app/data'
import { ENGINE_IS_SHIM } from '../../app/engine'
import { Button, Num } from '../../ui'
import { FoldPanel } from './fold'
import type { MetaFile } from './rules'
import { ExtLink, Path, RichText, UnavailableNote } from './shared'

const REPO_URL = 'https://github.com/amaroguilherme/landfall'
const CHECK_CMD = `git clone ${REPO_URL} && cd landfall && uv run pytest engine`

function CopyBlock() {
  const pre = useRef<HTMLPreElement>(null)
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle')
  const selectText = () => {
    const el = pre.current
    const sel = window.getSelection()
    if (!el || !sel) return
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CHECK_CMD)
      setState('copied')
    } catch {
      // Clipboard API unavailable (insecure context or permission): select the text instead.
      selectText()
      setState('select')
    }
  }
  return (
    <div className="lf-m-code">
      <p className="lf-m-code-label">
        <span id="m-check-label">Check our arithmetic</span> · <a href="#/verify">Run it in your browser</a>
      </p>
      <div className="lf-m-code-row">
        <pre ref={pre} aria-labelledby="m-check-label" tabIndex={0}>
          <code>{CHECK_CMD}</code>
        </pre>
        <Button variant="secondary" onClick={() => void copy()} aria-describedby="m-check-status">
          Copy
        </Button>
      </div>
      <p id="m-check-status" className="lf-m-small" aria-live="polite">
        {state === 'copied'
          ? 'Copied to the clipboard.'
          : state === 'select'
            ? 'Selected: press Ctrl+C (or ⌘C) to copy.'
            : 'Runs the stdlib-only Python reference engine and its tests, including the shared conformance vectors.'}
      </p>
    </div>
  )
}

function Flow({ snapshots, adapters }: { snapshots: number | null; adapters: number | null }) {
  return (
    <figure className="lf-m-flow-fig" aria-labelledby="m-flow-cap">
      <ol className="lf-m-flow">
        <li className="lf-m-stage">
          <span className="lf-m-stage-when">build time</span>
          <strong>Ingest</strong>
          <span>
            <Path>ingest/</Path>: <Num value={adapters} /> Python adapters fetch each NASA or NOAA source once
          </span>
        </li>
        <li className="lf-m-stage">
          <span className="lf-m-stage-when">build time</span>
          <strong>Frozen JSON</strong>
          <span>
            <Path>web/public/data/</Path>: <Num value={snapshots} /> snapshots, each with citation, caveats and SHA-256
          </span>
        </li>
        <li className="lf-m-stage">
          <span className="lf-m-stage-when">in the browser</span>
          <strong>Engine (TypeScript)</strong>
          <span>
            reads the frozen JSON and <Path>engine/rules/*.json</Path>; pure functions
          </span>
          <span className="lf-m-twin">
            held identical to the stdlib-only Python reference (<Path>engine/</Path>) by shared conformance vectors (
            <Path>engine/tests/vectors/</Path>)
          </span>
        </li>
        <li className="lf-m-stage">
          <span className="lf-m-stage-when">in the browser</span>
          <strong>Browser app</strong>
          <span>no backend and no other origin; once loaded it keeps working with the network off</span>
        </li>
      </ol>
      <ul className="lf-m-flow-off" aria-label="Not in the decision path">
        <li>
          <strong>No server</strong> between the frozen data and the answer: nothing is computed at a backend
        </li>
        <li>
          <strong>No AI / LLM</strong> anywhere in the decision path
        </li>
      </ul>
      <figcaption id="m-flow-cap" className="sr-only">
        Build-time ingest produces frozen JSON; the browser engine evaluates it with no server; no language model is in
        the decision path.
      </figcaption>
    </figure>
  )
}

export function ArchitectureSection({ meta }: { meta: MetaFile }) {
  const m = useManifest()
  const ready = m.status === 'ready'
  const llm = meta.refusals.find((r) => r.id === 'no_llm_in_decision_path')
  return (
    <FoldPanel
      s="architecture"
      eyebrow="Architecture"
      title="Two engines, one set of answers"
      abstract="Build-time ingest, frozen JSON, a TypeScript engine in the browser held to a stdlib-only Python reference by shared vectors."
      footer={
        <>
          <span>Code:</span>
          <ExtLink href={REPO_URL}>{REPO_URL.replace('https://', '')}</ExtLink>
          <span>· contract: engine/SPEC.md</span>
        </>
      }
    >
      <p>
        LANDFALL works in two stages. At build time, one Python adapter per source fetches the NASA and NOAA data and
        freezes it as JSON, with its citation, caveats and checksum. At run time, the browser loads only those files and
        the rules, and a TypeScript engine evaluates them: pure functions, same inputs, same outputs. The same engine
        exists as a stdlib-only Python reference, and both replay one shared set of conformance vectors, so you can check
        the arithmetic without trusting this interface. No server and no language model sits anywhere in the decision
        path.
        {llm ? (
          <>
            {' '}
            From the rules: “<RichText text={llm.text} />”
          </>
        ) : null}
      </p>
      <Flow snapshots={ready ? m.entries.length : null} adapters={ready ? new Set(m.entries.map((e) => e.adapter)).size : null} />
      {ENGINE_IS_SHIM ? (
        <UnavailableNote>
          In this build the browser still runs the shell’s stand-in engine (<Path>web/src/app/engine-shim.ts</Path>), which
          answers “insufficient data” rather than guess. The conformance claim applies to the TypeScript port once it is
          wired in; the Python reference and its vectors run today with the command below.
        </UnavailableNote>
      ) : null}
      <CopyBlock />
    </FoldPanel>
  )
}
