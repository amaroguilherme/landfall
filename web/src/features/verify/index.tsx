// #/verify: the judge's browser re-runs LANDFALL's checks. One Run button, and nothing is fetched before it is pressed.
//   1 Engine     every conformance vector the Python reference engine produced, through the TypeScript engine that
//                draws every view, judged as the vitest suite judges it (src/engine/conformance.ts)
//   2 Snapshots  the SHA-256 of every /data snapshot against manifest.json, and manifest.json's own SHA-256
//   3 Rules      the digest the cue cards print, recomputed with their own rulesDigest()
//   4 Origins    requests to other origins since this page loaded (resource timing), next to the page's CSP
// Then: the same checks on deliberately altered copies (they must fail), a drop zone that hashes NASA's PDF locally, a
// copyable report and the scope note. Every figure on the page is measured during the Run, never typed.
// Runs on the main thread in slices (checks.ts runVectors) with a progress line.
import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { RULES } from '../../app/engine'
import { loadSnapshot } from '../../app/data'
import type { FeatureProps } from '../../app/router'
import { API, REL_TOL } from '../../engine/conformance'
import { Button, Card, Expander, Num, SeverityIcon, StaleIcon, UnavailableIcon } from '../../ui'
import { useRulesDigest } from '../cuecard/PrintLink'
import { RULE_FILE_ORDER, rulesDigest, shortDigest } from '../cuecard/model'
import {
  checkSnapshot,
  checkSnapshots,
  flipOneByte,
  otherOrigins,
  parseManifest,
  recordedDocument,
  reportText,
  runVectors,
  scaledApi,
  sha256Hex,
} from './checks'
import type { Bytes, RecordedDocument, SnapshotReport, SnapshotResult, VectorFile, VectorReport } from './checks'
import { VECTOR_SOURCES, fetchVectorFiles } from './vectors'
import './verify.css'

const BASE = import.meta.env.BASE_URL ?? '/'
/** The demo's altered engine function and its factor (a demo value, not a LANDFALL number). */
const DEMO_FN = 't_critical'
const DEMO_FACTOR = 1e-6
const DEMO_FILE = `engine/tests/vectors/${DEMO_FN}.json`
/** The suite's tolerance and the demo factor as printed, e.g. "1e-9" (from the constants, never retyped). */
const TOL = REL_TOL.toExponential()
const FACTOR = DEMO_FACTOR.toExponential()
/** Standards snapshots that record the SHA-256 of NASA's PDF (data.document). */
const PDF_SNAPSHOTS = ['std_vol1_requirements', 'std_vol2_requirements']

type Verdict = 'idle' | 'running' | 'pass' | 'fail' | 'missing' | 'unavailable'

/** Text and shape first, colour second: neutral for a pass, red for a failed check, cyan for missing data, gray for unavailable. */
function VerdictBadge({ verdict, pass = 'Pass', fail = 'Failed' }: { verdict: Verdict; pass?: string; fail?: string }) {
  switch (verdict) {
    case 'pass':
      return (
        <span className="lf-sev" data-severity="nominal">
          <SeverityIcon severity="nominal" size={14} />
          <span className="lf-sev-text">{pass}</span>
        </span>
      )
    case 'fail':
      return (
        <span className="lf-sev" data-severity="warning">
          <SeverityIcon severity="warning" size={14} />
          <span className="lf-sev-text">{fail}</span>
        </span>
      )
    case 'missing':
      return (
        <span className="lf-dq" data-tone="stale">
          <StaleIcon size={14} />
          <span>Missing data</span>
        </span>
      )
    case 'unavailable':
      return (
        <span className="lf-dq" data-tone="unavailable">
          <UnavailableIcon size={14} />
          <span>Unavailable</span>
        </span>
      )
    case 'running':
      return <span className="lf-status">Running…</span>
    default:
      return <span className="lf-status">Not run yet</span>
  }
}

const cardSeverity = (v: Verdict) => (v === 'fail' ? ('warning' as const) : v === 'pass' ? ('nominal' as const) : undefined)

function Row({ title, eyebrow, verdict, children, pass, fail, id }: { title: ReactNode; eyebrow: string; verdict: Verdict; children: ReactNode; pass?: string; fail?: string; id: string }) {
  return (
    <Card as="li" className="lfv-row" severity={cardSeverity(verdict)} title={title} eyebrow={eyebrow} actions={<VerdictBadge verdict={verdict} pass={pass} fail={fail} />}>
      <div className="lfv-row-body" data-check={id} data-verdict={verdict}>
        {children}
      </div>
    </Card>
  )
}

/** Bytes of a same-origin file (JSON: Accept keeps an SPA fallback from answering with index.html). */
async function readBytes(url: string): Promise<Bytes> {
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (e) {
    throw new Error(`${url} could not be read (${(e as Error).message})`)
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  if (/text\/html/i.test(res.headers.get('content-type') ?? '')) throw new Error(`${url} is not in this build (the host answered with HTML)`)
  return new Uint8Array(await res.arrayBuffer())
}

function cspOfPage(): string | null {
  return document.querySelector('meta[http-equiv="Content-Security-Policy" i]')?.getAttribute('content') ?? null
}

async function cacheNames(): Promise<string[]> {
  try {
    return (await caches.keys()).filter((k) => k.startsWith('landfall-'))
  } catch {
    return []
  }
}

const hasSubtle = () => !!(globalThis as { crypto?: Crypto }).crypto?.subtle

interface RunState {
  phase: 'idle' | 'running' | 'done'
  vectors: VectorReport | null
  vectorError: string | null
  /** The replay itself stopped (not a download problem): a failed check. */
  vectorFailure: string | null
  snapshots: SnapshotReport | null
  snapshotError: string | null
  digest: string | null
  digestDone: boolean
  origins: { other: string[]; recorded: number } | null
  caches: string[]
  /** Whether LANDFALL's service worker served this page when the Run started (it stores the vector files). */
  worker: boolean | null
  when: string | null
}

const IDLE: RunState = {
  phase: 'idle',
  vectors: null,
  vectorError: null,
  vectorFailure: null,
  snapshots: null,
  snapshotError: null,
  digest: null,
  digestDone: false,
  origins: null,
  caches: [],
  worker: null,
  when: null,
}

interface DemoState {
  phase: 'idle' | 'running' | 'done'
  engine: VectorReport | null
  engineError: string | null
  snapshot: { result: SnapshotResult; offset: number; before: number; after: number } | null
  snapshotError: string | null
}

const DEMO_IDLE: DemoState = { phase: 'idle', engine: null, engineError: null, snapshot: null, snapshotError: null }

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`

function Disagreements({ report, limit }: { report: VectorReport; limit?: number }) {
  const list = limit ? report.disagreements.slice(0, limit) : report.disagreements
  if (!list.length) return null
  return (
    <ol className="lfv-diffs" aria-label="Vectors that disagree">
      {list.map((d) => (
        <li key={`${d.path}#${d.index}`}>
          <code>
            {d.path} #{d.index}
          </code>{' '}
          <span className="lfv-muted">{d.name}</span>
          {d.lines.map((l, i) => (
            <div key={i} className="lfv-diff-line">
              <code>{l}</code>
            </div>
          ))}
        </li>
      ))}
    </ol>
  )
}

function EngineRow({ run }: { run: RunState }) {
  const v = run.vectors
  const verdict: Verdict =
    run.phase === 'running' && !v && !run.vectorError && !run.vectorFailure
      ? 'running'
      : v
        ? v.agree === v.total && v.total > 0
          ? 'pass'
          : 'fail'
        : run.vectorFailure
          ? 'fail'
          : run.vectorError
            ? 'missing'
            : 'idle'
  return (
    <Row id="engine" eyebrow="Check 1 · engine" title="TypeScript engine against the Python reference" verdict={verdict} pass="Agree" fail="Disagree">
      {v ? (
        <>
          <p className="lfv-big">
            <Num value={v.agree} /> of <Num value={v.total} /> vectors agree with the Python reference within{' '}
            <span className="lf-mono">{TOL}</span>
          </p>
          <ul className="lfv-facts">
            <li>
              <Num value={v.files} /> files from <code>engine/tests/</code>; the comparison is the test suite’s own (
              <code>web/src/engine/conformance.ts</code>).
            </li>
            <li>
              Expected errors: <Num value={v.errors.same} /> of <Num value={v.errors.total} /> raise the same error code.
            </li>
            <li>
              Bit-for-bit, shown as information (the pass criterion is <span className="lf-mono">{TOL}</span>):{' '}
              <Num value={v.bitExact.same} /> of{' '}
              <Num value={v.bitExact.total} /> results identical to the Python double; <code>t_cdf</code>, which the suite holds to
              the tolerance only, <Num value={v.bitExactToleranceOnly.same} /> of <Num value={v.bitExactToleranceOnly.total} />.
            </li>
            <li>
              Replay: <Num value={Math.round(v.ms)} unit="ms" /> in this browser (download not included).
            </li>
            <li>
              Browser: <code>{navigator.userAgent}</code>
            </li>
            {run.worker === false ? (
              <li>
                LANDFALL’s offline worker was not serving this page yet (it installs a few seconds after the first visit),
                so this Run’s vector files were not kept for offline use. Run again in a few seconds to keep them.
              </li>
            ) : null}
          </ul>
          {v.disagreements.length ? (
            <>
              <p className="lfv-p">
                Every vector that disagrees (<Num value={v.disagreements.length} />), with the expected and the computed value:
              </p>
              <Disagreements report={v} />
            </>
          ) : null}
        </>
      ) : run.vectorFailure ? (
        <p className="lfv-p">The replay stopped with an error: {run.vectorFailure}.</p>
      ) : run.vectorError ? (
        <p className="lfv-p">
          The vector files are not in this browser: {run.vectorError}. They download from this site on the first Run with a
          connection, and later Runs read them offline.
        </p>
      ) : (
        <p className="lfv-p">
          Replays the <Num value={VECTOR_SOURCES.length} /> vector files that the Python reference engine generated (
          <code>engine/tests/vectors</code> and <code>vectors_random</code>) through the TypeScript engine on this page.
        </p>
      )}
    </Row>
  )
}

function SnapshotList({ results }: { results: readonly SnapshotResult[] }) {
  return (
    <ul className="lfv-snaps">
      {results.map((r) => (
        <li key={r.file}>
          <span className="lfv-snap-head">
            <code>{r.file}</code> <span>{r.match ? 'matches' : 'does not match'}</span>
          </span>
          {r.error ? (
            <span className="lfv-muted">{r.error}</span>
          ) : (
            <span className="lfv-muted">
              <Num value={r.bytes} unit="B" unitLabel="bytes" /> · SHA-256 <code className="lfv-hex">{r.sha256}</code>
              {r.match ? null : (
                <>
                  {' '}
                  (manifest: <Num value={r.expectedBytes} unit="B" unitLabel="bytes" />, <code className="lfv-hex">{r.expectedSha256}</code>)
                </>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function SnapshotRow({ run }: { run: RunState }) {
  const s = run.snapshots
  const verdict: Verdict =
    run.phase === 'running' && !s && !run.snapshotError
      ? 'running'
      : s
        ? s.match === s.total && s.total > 0
          ? 'pass'
          : 'fail'
        : run.snapshotError
          ? hasSubtle()
            ? 'missing'
            : 'unavailable'
          : 'idle'
  return (
    <Row id="snapshots" eyebrow="Check 2 · data" title="Frozen NASA and NOAA snapshots against manifest.json" verdict={verdict} pass="Match" fail="Mismatch">
      {s ? (
        <>
          <p className="lfv-big">
            <Num value={s.match} /> of <Num value={s.total} /> snapshots match the SHA-256 and size in manifest.json
          </p>
          <p className="lfv-p">
            manifest.json itself has SHA-256 <code className="lfv-hex">{s.manifestSha256}</code>. Compare it with{' '}
            <code>shasum -a 256 web/public/data/manifest.json</code> in the repo.
          </p>
          {s.match < s.total ? (
            <p className="lfv-p">
              If you opened LANDFALL before a redeploy, this browser may hold an older build’s file: reload the page and run
              again.
            </p>
          ) : null}
          <Expander summary={<>Every snapshot (<Num value={s.total} />)</>} defaultOpen={s.match < s.total}>
            <SnapshotList results={s.results} />
          </Expander>
        </>
      ) : run.snapshotError ? (
        <p className="lfv-p">The snapshots could not be checked: {run.snapshotError}.</p>
      ) : (
        <p className="lfv-p">
          Hashes every file in <code>/data</code> with SHA-256 in this browser and compares it with the hash and size that
          manifest.json records.
        </p>
      )}
    </Row>
  )
}

function DigestRow({ run }: { run: RunState }) {
  const cards = useRulesDigest()
  const fresh = run.digest
  const verdict: Verdict =
    run.phase === 'running' && !run.digestDone
      ? 'running'
      : run.digestDone
        ? fresh && cards.hex
          ? fresh === cards.hex
            ? 'pass'
            : 'fail'
          : 'unavailable'
        : 'idle'
  return (
    <Row id="digest" eyebrow="Check 3 · rules" title="Rules digest of the paper cue cards" verdict={verdict} pass="Same" fail="Different">
      {run.digestDone ? (
        fresh ? (
          <>
            <p className="lfv-big">
              Recomputed now: rules <span className="lf-mono">{shortDigest(fresh)}</span>
            </p>
            <ul className="lfv-facts">
              <li>
                The cue cards print: rules <span className="lf-mono">{cards.hex ? shortDigest(cards.hex) : 'not computed'}</span>
                {cards.hex ? (fresh === cards.hex ? ' (the same value)' : ' (a different value)') : null}. Compare it with a
                printed card or <a href="#/card/spe_shelter">#/card/spe_shelter</a>.
              </li>
              <li>
                Full SHA-256 of the canonical rules (<code>engine/rules/*.json</code>): <code className="lfv-hex">{fresh}</code>
              </li>
            </ul>
          </>
        ) : (
          <p className="lfv-p">This browser cannot compute SHA-256 here (Web Crypto needs https or localhost).</p>
        )
      ) : (
        <p className="lfv-p">
          Recomputes the SHA-256 of the <Num value={RULE_FILE_ORDER.length} /> rules files with the cue cards’ own function and
          compares it with the digest the cards print.
        </p>
      )}
    </Row>
  )
}

function OriginsRow({ run }: { run: RunState }) {
  const o = run.origins
  const csp = cspOfPage()
  const verdict: Verdict = run.phase === 'running' && !o ? 'running' : o ? (o.other.length === 0 ? 'pass' : 'fail') : 'idle'
  return (
    <Row id="origins" eyebrow="Check 4 · network" title="Requests to other origins" verdict={verdict} pass="None" fail="Found">
      {o ? (
        <p className="lfv-big">
          <Num value={o.other.length} /> requests to other origins since this page loaded (
          <Num value={o.recorded} /> requests recorded by the browser)
        </p>
      ) : (
        <p className="lfv-p">Counts the requests this page made to any origin other than {location.origin}, from the browser’s resource timing.</p>
      )}
      {o && o.other.length ? (
        <ul className="lfv-diffs" aria-label="Requests to other origins">
          {o.other.map((u, i) => (
            <li key={i}>
              <code>{u}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="lfv-p">The page’s Content-Security-Policy, quoted from its own meta tag:</p>
      <pre className="lfv-csp">
        <code>{csp ?? 'none found'}</code>
      </pre>
    </Row>
  )
}

function DemoSection() {
  const [demo, setDemo] = useState<DemoState>(DEMO_IDLE)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const source = VECTOR_SOURCES.find((s) => s.path === DEMO_FILE)
  const run = async () => {
    setDemo({ ...DEMO_IDLE, phase: 'running' })
    const next: DemoState = { ...DEMO_IDLE, phase: 'done' }
    try {
      if (!source) throw new Error(`${DEMO_FILE} is not in this build`)
      const files = await fetchVectorFiles([source], () => undefined)
      next.engine = await runVectors(files, { api: scaledApi(DEMO_FN, DEMO_FACTOR) })
    } catch (e) {
      next.engineError = (e as Error).message
    }
    try {
      const manifest = parseManifest(await readBytes(`${BASE}data/manifest.json`))
      const row = manifest[0]
      if (!row) throw new Error('manifest.json lists no snapshot')
      const bytes = await readBytes(`${BASE}data/${row.file}`)
      const { copy, offset } = flipOneByte(bytes)
      next.snapshot = { result: await checkSnapshot(row, copy), offset, before: bytes[offset], after: copy[offset] }
    } catch (e) {
      next.snapshotError = (e as Error).message
    }
    if (live.current) setDemo(next)
  }
  const e = demo.engine
  const s = demo.snapshot
  const engineVerdict: Verdict = demo.phase === 'running' ? 'running' : e ? (e.agree === e.total ? 'pass' : 'fail') : demo.engineError ? 'missing' : 'idle'
  const snapVerdict: Verdict = demo.phase === 'running' ? 'running' : s ? (s.result.match ? 'pass' : 'fail') : demo.snapshotError ? (hasSubtle() ? 'missing' : 'unavailable') : 'idle'
  return (
    <section className="lfv-section" aria-labelledby="lfv-demo-h" data-verify-demo-done={demo.phase === 'done' || undefined}>
      <h2 id="lfv-demo-h">See the checks fail</h2>
      <p className="lfv-p">
        The same checks on two deliberately broken copies, so you can see that they are not a constant pass. Both rows must
        turn red. The real engine, the data and the app’s state are not touched: the demo runs on copies.
      </p>
      <div className="lfv-run">
        <Button onClick={() => void run()} disabled={demo.phase === 'running'}>
          {demo.phase === 'done' ? 'Run the demo again' : 'Run the failing demo'}
        </Button>
      </div>
      <ol className="lfv-rows">
        <Row id="demo-engine" eyebrow="Demo · altered engine" title={
            <>
              A copy of {DEMO_FN} that answers <span className="lf-mono lfv-nowrap">× (1 + {FACTOR})</span>
            </>
          } verdict={engineVerdict} pass="Agree" fail="Disagree">
          {e ? (
            <>
              <p className="lfv-big">
                <Num value={e.total - e.agree} /> of <Num value={e.total} /> vectors disagree with the Python reference
              </p>
              <p className="lfv-p">
                <code>{DEMO_FILE}</code> through a copy of <code>tCritical</code> whose answer is multiplied by <span className="lf-mono lfv-nowrap">(1 + {FACTOR})</span>, a
                demo value. Vectors that expect an error still raise it, so they still agree. The first disagreement:
              </p>
              <Disagreements report={e} limit={1} />
            </>
          ) : demo.engineError ? (
            <p className="lfv-p">The demo could not read its vector file: {demo.engineError}.</p>
          ) : (
            <p className="lfv-p">
              Replays <code>{DEMO_FILE}</code> through a copy of <code>tCritical</code> whose answer is multiplied by{' '}
              <span className="lf-mono lfv-nowrap">(1 + {FACTOR})</span>, a demo value.
            </p>
          )}
        </Row>
        <Row id="demo-snapshot" eyebrow="Demo · altered snapshot" title="A copy of one snapshot with one byte changed" verdict={snapVerdict} pass="Match" fail="Mismatch">
          {s ? (
            <>
              <p className="lfv-big">
                <code>{s.result.file}</code> {s.result.match ? 'still matches manifest.json' : 'no longer matches manifest.json'}
              </p>
              <ul className="lfv-facts">
                <li>
                  Byte <Num value={s.offset} /> of <Num value={s.result.bytes} />, in a copy: <span className="lf-mono">{hex2(s.before)}</span> →{' '}
                  <span className="lf-mono">{hex2(s.after)}</span>.
                </li>
                <li>
                  SHA-256 of the copy: <code className="lfv-hex">{s.result.sha256}</code>
                </li>
                <li>
                  manifest.json records: <code className="lfv-hex">{s.result.expectedSha256}</code>
                </li>
              </ul>
            </>
          ) : demo.snapshotError ? (
            <p className="lfv-p">The demo could not read a snapshot: {demo.snapshotError}.</p>
          ) : (
            <p className="lfv-p">Changes one byte in a copy of the first snapshot manifest.json lists, then hashes the copy.</p>
          )}
        </Row>
      </ol>
    </section>
  )
}

type PdfState =
  | { phase: 'idle' }
  | { phase: 'hashing'; name: string }
  | { phase: 'done'; name: string; bytes: number; sha256: string; match: RecordedDocument | null; recorded: RecordedDocument[] }
  | { phase: 'error'; message: string }

function PdfSection() {
  const [pdf, setPdf] = useState<PdfState>({ phase: 'idle' })
  const [over, setOver] = useState(false)
  const take = async (file: File | undefined) => {
    if (!file) return
    setPdf({ phase: 'hashing', name: file.name })
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const sha256 = await sha256Hex(bytes)
      const recorded: RecordedDocument[] = []
      for (const id of PDF_SNAPSHOTS) {
        const st = await loadSnapshot(id)
        const doc = st.status === 'ready' ? recordedDocument(id, st.data) : null
        if (doc) recorded.push(doc)
      }
      if (!recorded.length) throw new Error(`The recorded hashes could not be read: ${PDF_SNAPSHOTS.join(' and ')} are not in this browser yet`)
      const match = recorded.find((d) => d.sha256 === sha256) ?? null
      setPdf({ phase: 'done', name: file.name, bytes: bytes.byteLength, sha256, match, recorded })
    } catch (e) {
      setPdf({ phase: 'error', message: (e as Error).message })
    }
  }
  const onDrop = (ev: DragEvent<HTMLLabelElement>) => {
    ev.preventDefault()
    setOver(false)
    void take(ev.dataTransfer.files[0])
  }
  return (
    <section className="lfv-section" aria-labelledby="lfv-pdf-h">
      <h2 id="lfv-pdf-h">Have NASA’s PDF? Drop it here</h2>
      <p className="lfv-p">
        Download NASA-STD-3001 Volume 1 or Volume 2 from nasa.gov, then drop the PDF here or choose it. This browser hashes it
        with SHA-256 and compares the hash with the one LANDFALL recorded when it froze the standard. The file never leaves
        this browser: nothing is uploaded.
      </p>
      <label
        className="lfv-drop"
        data-over={over || undefined}
        onDragOver={(ev) => {
          ev.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span>Drop a PDF here, or choose one:</span>
        <input type="file" accept="application/pdf,.pdf" onChange={(ev) => void take(ev.currentTarget.files?.[0])} />
      </label>
      <div aria-live="polite" className="lfv-pdf-result" data-pdf={pdf.phase}>
        {pdf.phase === 'hashing' ? <p className="lfv-p">Hashing {pdf.name}…</p> : null}
        {pdf.phase === 'error' ? <p className="lfv-p">{pdf.message}</p> : null}
        {pdf.phase === 'done' ? (
          <>
            <p className="lfv-big">
              <VerdictBadge verdict={pdf.match ? 'pass' : 'fail'} pass="Match" fail="No match" />{' '}
              {pdf.match
                ? `${pdf.name} is the document LANDFALL froze: ${pdf.match.title}${pdf.match.revision ? `, Revision ${pdf.match.revision}` : ''}`
                : `${pdf.name} matches neither recorded document`}
            </p>
            <ul className="lfv-facts">
              <li>
                Your file: <Num value={pdf.bytes} unit="B" unitLabel="bytes" />, SHA-256 <code className="lfv-hex">{pdf.sha256}</code>
              </li>
              {pdf.recorded.map((d) => (
                <li key={d.snapshot}>
                  Recorded in <code>{d.snapshot}</code>
                  {d.revision ? ` (Revision ${d.revision})` : ''}: <Num value={d.bytes} unit="B" unitLabel="bytes" />, SHA-256{' '}
                  <code className="lfv-hex">{d.sha256}</code>
                </li>
              ))}
            </ul>
            {pdf.match ? null : (
              <p className="lfv-p">
                A different file, or NASA may have revised the PDF in place: Revision F of Volume 2 replaced Revision E at the
                same URL. The hashes above are what LANDFALL used.
              </p>
            )}
          </>
        ) : null}
      </div>
    </section>
  )
}

function ReportSection({ run }: { run: RunState }) {
  const pre = useRef<HTMLPreElement>(null)
  const cards = useRulesDigest()
  const [copied, setCopied] = useState<'idle' | 'copied' | 'select'>('idle')
  const text = reportText({
    when: run.when ?? 'not run',
    page: `${location.origin}${location.pathname}#/verify`,
    userAgent: navigator.userAgent,
    caches: run.caches,
    worker: run.worker,
    vectors: run.vectors,
    snapshots: run.snapshots,
    digest: run.digestDone ? { hex: run.digest, cards: cards.hex } : null,
    origins: run.origins ? { other: run.origins.other.length, recorded: run.origins.recorded } : null,
  })
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('copied')
    } catch {
      // The clipboard refused (an unfocused page, no permission): select the report for Ctrl+C instead. A closed
      // <details> renders none of its text, so a selection inside it would be empty: open "Show the report" first.
      const el = pre.current
      const sel = window.getSelection()
      let selected = false
      if (el && sel) {
        const box = el.closest('details')
        if (box) box.open = true
        const range = document.createRange()
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range)
        selected = sel.toString().length > 0
      }
      // "Selected" only when the selection holds the report
      setCopied(selected ? 'select' : 'idle')
    }
  }
  return (
    <section className="lfv-section" aria-labelledby="lfv-report-h">
      <h2 id="lfv-report-h">Copy report</h2>
      <p className="lfv-p">The counts, the build’s service-worker cache name, the replay time and the browser, as plain text.</p>
      <div className="lfv-run">
        <Button variant="secondary" onClick={() => void copy()} disabled={run.phase !== 'done'} aria-describedby="lfv-copy-status">
          Copy report
        </Button>
        <span id="lfv-copy-status" className="lfv-muted" aria-live="polite">
          {run.phase !== 'done' ? 'Available after a Run.' : copied === 'copied' ? 'Copied to the clipboard.' : copied === 'select' ? 'Selected: press Ctrl+C (or ⌘C) to copy.' : ''}
        </span>
      </div>
      {run.phase === 'done' ? (
        <Expander summary="Show the report">
          <pre ref={pre} className="lfv-csp" tabIndex={0}>
            <code>{text}</code>
          </pre>
        </Expander>
      ) : null}
    </section>
  )
}

export default function VerifyFeature(_props: FeatureProps) {
  const [run, setRun] = useState<RunState>(IDLE)
  const [progress, setProgress] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    // Room for every request of many Runs: browsers keep only 250 resource-timing entries by default, and a Run adds
    // one per vector file and per snapshot, so check 4 would stop seeing new requests after a few Runs.
    performance.setResourceTimingBufferSize?.(5000)
    return () => {
      live.current = false
    }
  }, [])
  const update = (patch: Partial<RunState>) => {
    if (live.current) setRun((r) => ({ ...r, ...patch }))
  }
  const say = (s: string) => {
    if (live.current) setProgress(s)
  }

  const start = async () => {
    const t0 = performance.now()
    setRun({ ...IDLE, phase: 'running', worker: !!navigator.serviceWorker?.controller })
    say('Starting…')
    // 1. engine: a download problem is missing data; an error during the replay is a failed check
    let files: VectorFile[] | null = null
    try {
      files = await fetchVectorFiles(VECTOR_SOURCES, (d, n) => say(`Reading the vector files: ${d} of ${n}`))
    } catch (e) {
      update({ vectorError: (e as Error).message })
    }
    if (files) {
      try {
        const vectors = await runVectors(files, { onProgress: (d, n) => say(`Replaying the vectors: ${d} of ${n}`) })
        update({ vectors })
      } catch (e) {
        update({ vectorFailure: (e as Error).message })
      }
    }
    // 2. snapshots
    try {
      const manifest = await readBytes(`${BASE}data/manifest.json`)
      const snapshots = await checkSnapshots(manifest, (file) => readBytes(`${BASE}data/${file}`), (d, n) => say(`Hashing the snapshots: ${d} of ${n}`))
      update({ snapshots })
    } catch (e) {
      update({ snapshotError: (e as Error).message })
    }
    // 3. rules digest, with the cue cards' own function
    const digest = await rulesDigest(RULES).catch(() => null)
    update({ digest, digestDone: true })
    // 4. requests to other origins, after every request of this Run
    const entries = performance.getEntriesByType('resource')
    const origins = { other: otherOrigins(entries, location.origin), recorded: entries.length }
    const names = await cacheNames()
    update({ origins, caches: names, phase: 'done', when: new Date().toISOString() })
    say(`Done in ${Math.round(performance.now() - t0)} ms, downloads included.`)
  }

  const running = run.phase === 'running'
  return (
    <div className="lfv-page" data-verify-done={run.phase === 'done' || undefined}>
      <header className="lfv-head">
        <p className="lf-eyebrow">Audit</p>
        <h1>Re-run our checks in your browser</h1>
        <p className="lfv-lede">
          Don’t take our word for it. Press Run and this browser replays the Python reference engine’s answers through the
          engine that draws every LANDFALL view, hashes every frozen data file, and recomputes the cue cards’ rules digest.
        </p>
      </header>

      <section className="lfv-section" aria-labelledby="lfv-checks-h">
        <h2 id="lfv-checks-h" className="sr-only">
          The checks
        </h2>
        <div className="lfv-run">
          <Button onClick={() => void start()} disabled={running}>
            {run.phase === 'done' ? 'Run again' : 'Run'}
          </Button>
          <p className="lfv-progress" aria-live="polite">
            {progress ?? (
              <>
                Nothing has been fetched yet. The <Num value={VECTOR_SOURCES.length} /> vector files download from this site on
                the first Run and are kept for later Runs, offline included.
              </>
            )}
          </p>
        </div>
        <ol className="lfv-rows">
          <EngineRow run={run} />
          <SnapshotRow run={run} />
          <DigestRow run={run} />
          <OriginsRow run={run} />
        </ol>
      </section>

      <DemoSection />
      <PdfSection />
      {/* keyed by the Run, so a Copy status never outlives the report it copied or selected */}
      <ReportSection key={run.when ?? 'idle'} run={run} />

      <section className="lfv-section lfv-scope" aria-labelledby="lfv-scope-h">
        <h2 id="lfv-scope-h">What this page re-runs, and what it does not</h2>
        <p className="lfv-p">
          It re-runs the <Num value={Object.keys(API).length} /> engine functions of <code>engine/SPEC.md</code> section 5
          against the Python reference engine’s answers, the SHA-256 of every frozen data file, and the rules digest. It does
          not re-run the scenario timeline or the user interface: the repo’s TypeScript tests cover those. Agreement shows
          that the two engines give the same answers and that the data is the data we froze, not that a rule is clinically
          right: see <a href="#/method?s=limitations">Method: known limitations</a>.
        </p>
      </section>
    </div>
  )
}
