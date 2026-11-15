// The conformance vectors, as the build ships them: every engine/tests/vectors/*.json and
// engine/tests/vectors_random/*.json becomes a hashed JSON file under /assets ('?url&no-inline': a URL, never the JSON
// inlined into this chunk, and never a data: URL, which the page's CSP would refuse to fetch). They are not in the
// service worker's install precache (that takes only top-level assets/*.js and *.css); its /assets/* cache-first rule
// stores each file the first time Run fetches it, so a later Run works with the network off.
import type { Vector } from '../../engine/conformance'
import type { VectorFile } from './checks'

const GENERATED = import.meta.glob<string>('../../../../engine/tests/vectors/*.json', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
})
const RANDOM = import.meta.glob<string>('../../../../engine/tests/vectors_random/*.json', {
  query: '?url&no-inline',
  import: 'default',
  eager: true,
})

/** 'engine/tests/vectors/rci.json' from the glob key '../../../../engine/tests/vectors/rci.json'. */
const repoPath = (key: string): string => key.replace(/^(\.\.\/)+/, '')

export interface VectorSource {
  /** Repo path, e.g. engine/tests/vectors_random/random_rci.json. */
  path: string
  url: string
}

/** Every vector file in the suite's order: the generated files, then the randomized ones, each sorted by name. */
export const VECTOR_SOURCES: readonly VectorSource[] = [GENERATED, RANDOM].flatMap((glob) =>
  Object.keys(glob)
    .sort()
    .map((key) => ({ path: repoPath(key), url: glob[key] })),
)

/** Downloads (or, after the first Run, reads from the service worker's cache) and parses every vector file. */
export async function fetchVectorFiles(
  sources: readonly VectorSource[],
  onFile: (done: number, total: number) => void,
): Promise<VectorFile[]> {
  let done = 0
  const out: VectorFile[] = new Array(sources.length)
  const queue = sources.map((s, i) => [s, i] as const)
  async function worker() {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const [src, i] = item
      let res: Response
      try {
        res = await fetch(src.url)
      } catch (e) {
        throw new Error(`${src.path} could not be downloaded (${(e as Error).message})`)
      }
      if (!res.ok) throw new Error(`${src.path}: HTTP ${res.status}`)
      const vectors = (await res.json()) as Vector[]
      if (!Array.isArray(vectors)) throw new Error(`${src.path} is not a list of vectors`)
      out[i] = { path: src.path, vectors }
      onFile(++done, sources.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, sources.length) }, worker))
  return out
}
