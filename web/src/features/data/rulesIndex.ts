// Reverse index: which entries of engine/rules/*.json cite which frozen snapshot.
// A citation is any string value under a key named `snapshot` or `*_snapshot` (SPEC section 3:
// `source.snapshot`, `dose_snapshot`, `from_snapshot`, `comms_snapshot`). The owner of a citation
// is the OUTERMOST object id around it (a rule, case, environment or category id), so a rule that
// cites the same file from its limit and from its approach level counts once.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

// Bundled at build time (vite allows the repo root); a missing file simply drops out of the glob.
const RULE_FILES = import.meta.glob<Json>('../../../../engine/rules/*.json', { eager: true, import: 'default' })

const SNAPSHOT_KEY = /(^|_)snapshot$/

export interface RuleCitation {
  /** Rules file name, e.g. "thresholds.json". */
  file: string
  /** Distinct outermost ids that cite the snapshot, sorted. */
  owners: string[]
}

type Acc = Map<string, Map<string, Set<string>>>

function add(acc: Acc, snapshot: string, file: string, owner: string): void {
  let byFile = acc.get(snapshot)
  if (!byFile) acc.set(snapshot, (byFile = new Map()))
  let owners = byFile.get(file)
  if (!owners) byFile.set(file, (owners = new Set()))
  owners.add(owner)
}

function walk(node: Json, file: string, owner: string | null, top: string, acc: Acc): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, file, owner, top, acc)
    return
  }
  if (node === null || typeof node !== 'object') return
  const own = owner ?? (typeof node.id === 'string' ? node.id : null)
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && SNAPSHOT_KEY.test(k)) add(acc, v, file, own ?? top)
    else if (v !== null && typeof v === 'object') walk(v, file, own, top, acc)
  }
}

function build(): Map<string, RuleCitation[]> {
  const acc: Acc = new Map()
  for (const [path, json] of Object.entries(RULE_FILES)) {
    const file = path.split('/').pop() ?? path
    if (json === null || typeof json !== 'object' || Array.isArray(json)) continue
    for (const [top, v] of Object.entries(json)) {
      if (typeof v === 'string' && SNAPSHOT_KEY.test(top)) add(acc, v, file, top)
      else walk(v, file, null, top, acc)
    }
  }
  const out = new Map<string, RuleCitation[]>()
  for (const [snapshot, byFile] of acc) {
    const list = [...byFile]
      .map(([file, owners]) => ({ file, owners: [...owners].sort() }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    out.set(snapshot, list)
  }
  return out
}

/** snapshot id -> rules files and the entries in them that cite it. */
export const RULE_CITATIONS: ReadonlyMap<string, RuleCitation[]> = build()

/** Names of the rules files that were bundled (empty if engine/rules/ was absent at build). */
export const RULE_FILE_NAMES: readonly string[] = Object.keys(RULE_FILES)
  .map((p) => p.split('/').pop() ?? p)
  .sort()

export function citationCount(list: readonly RuleCitation[] | undefined): number {
  let n = 0
  for (const c of list ?? []) n += c.owners.length
  return n
}
