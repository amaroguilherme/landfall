// Pure text renderers for the LANDFALL BAND: hardware/BOM.csv and hardware/sensor-map.md are
// generated from hardware/sensor-map.json with these functions (hardware/generate.mjs), and
// band.test.ts asserts the committed files equal a fresh render. No imports with runtime
// effects: Node runs this file directly with type stripping.
import type { Block, FeedRef, ReqRef, SensorMap, Step } from './types.ts'

/** "[V1 3004](h)", "[V2 9023]", "JSC-20793 Rev D", "Standard Measures". */
export function reqLabel(ref: Pick<ReqRef, 'id' | 'item'>): string {
  const isStd = /^V[12] \d/.test(ref.id)
  const base = isStd ? `[${ref.id}]` : ref.id
  return ref.item ? `${base}(${ref.item})` : base
}

export const RELATION_SHORT: Record<string, string> = {
  direct: 'requires',
  constraint: 'constrains',
  analogy: 'pattern borrowed',
  delegates: 'assigns elsewhere',
  reference: 'NASA names it',
}

/** Interface text for one block, from the bus table. */
export function interfaceLabel(map: SensorMap, block: Block): string {
  if (block.interface === 'power') return 'power domain'
  if (block.group === 'core') {
    const hosted = map.buses.filter((b) => b.id !== 'ble').map((b) => b.label)
    const ble = map.buses.find((b) => b.id === 'ble')?.label ?? 'BLE'
    return `host of ${hosted.join(', ')}; ${ble} to the LANDFALL app`
  }
  const ids = [block.interface, block.interface_extra].filter(Boolean) as string[]
  return ids.map((id) => map.buses.find((b) => b.id === id)?.label ?? id).join(' + ')
}

/** The LANDFALL cases a block serves (case feeds), or what it is when it serves none directly. */
export function casesServed(block: Block): string {
  const cases = [...new Set(block.feeds.filter((f) => f.kind === 'case').map((f) => f.id))]
  if (cases.length) return cases.join('; ')
  if (block.group === 'sensor') return 'none directly (context and backup)'
  return 'all (infrastructure)'
}

export function feedLabel(f: FeedRef): string {
  const kind = f.kind === 'personal' ? 'indicator' : f.kind === 'none' ? 'no rule' : f.kind
  const id = f.id === '*' ? 'all personal indicators' : f.id
  return f.kind === 'none' ? `${kind}: ${f.as ?? id}` : `${kind} ${id}${f.as ? ` (${f.as})` : ''}`
}

// ---- CSV ------------------------------------------------------------------------------------------

function csvField(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const BOM_COLUMNS = ['part', 'qty', 'manufacturer', 'function', 'interface', 'block_id', 'case_served', 'datasheet_url', 'datasheet_read'] as const

/** "read 2026-11-14", "not retrieved (2026-11-14)" or "no part selected". */
export function datasheetStatus(block: Block): string {
  const d = block.datasheet
  if (!d) return 'no part selected'
  return d.status === 'read' ? `read ${d.checked}` : `not retrieved (${d.checked})`
}

export function renderBomCsv(map: SensorMap): string {
  const rows: (string | number)[][] = [[...BOM_COLUMNS]]
  for (const b of map.blocks) {
    rows.push([b.part, b.qty, b.manufacturer, b.function, interfaceLabel(map, b), b.id, casesServed(b), b.datasheet?.url ?? '', datasheetStatus(b)])
  }
  return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n'
}

// ---- Markdown -------------------------------------------------------------------------------------

function md(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function code(s: string): string {
  return '`' + s + '`'
}

function stepLine(s: Step): string {
  const basis = s.arithmetic ?? s.rationale ?? ''
  return `| ${md(s.label)} | ${code(`${s.value} ${s.unit}`)} | ${s.chip} | ${md(basis)} |`
}

function reqLine(r: ReqRef): string {
  const where = r.snapshot ? `frozen in ${code(r.snapshot)}` : 'not frozen in this build'
  const extra = [r.why, r.note].filter(Boolean).join(' ')
  return `- ${code(reqLabel(r))} (${RELATION_SHORT[r.relation] ?? r.relation}; ${where}): "${r.quote}"${extra ? ` ${extra}` : ''}`
}

export function renderMarkdown(map: SensorMap): string {
  const out: string[] = []
  const p = (...lines: string[]) => out.push(...lines)
  p(
    `# ${map.title}: sensor map`,
    '',
    '> Generated from `sensor-map.json` by `node hardware/generate.mjs`. Do not edit by hand: edit the JSON and',
    '> regenerate. `web/src/features/band/band.test.ts` fails when this file and the JSON disagree.',
    '',
    `**${map.subtitle}.** ${map.status.text} ${map.status.why_no_schematic}`,
    '',
    `**Manufacturer specs.** ${map.mfr_basis}`,
    '',
    map.principle,
    '',
    `**The gap.** ${map.gap.claim} ${map.gap.detail} Quote: "${map.gap.quote}" (${map.gap.doc}, NTRS ${map.gap.ntrs}, ${map.gap.url}).`,
    '',
    '## Blocks and their three labels',
    '',
    map.label_rule,
    '',
    '| Block | Part | (a) Indicator produced | (b) LANDFALL rule / baseline / case fed | (c) NASA requirement |',
    '|---|---|---|---|---|',
  )
  for (const b of map.blocks) {
    const a = b.produces.length ? b.produces.map((x) => code(x.variable)).join(', ') : '(none: see notes)'
    const fb = b.feeds.length ? b.feeds.map((f) => md(feedLabel(f))).join('; ') : '(none)'
    const c = b.justified_by.map((r) => `${code(reqLabel(r))} ${RELATION_SHORT[r.relation] ?? r.relation}`).join('; ')
    p(`| ${code(b.id)} ${md(b.name)} | ${b.qty > 1 ? `${b.part} x${b.qty}` : b.part} | ${a} | ${fb} | ${c} |`)
  }
  p('', 'Relations: ' + Object.entries(map.relations).map(([k, v]) => `**${RELATION_SHORT[k] ?? k}** = ${v}`).join('; ') + '.', '')

  p('## Block details', '')
  for (const b of map.blocks) {
    p(`### ${code(b.id)} ${b.name}: ${b.part}${b.qty > 1 ? ` x${b.qty}` : ''} (${b.manufacturer})`, '', b.function, '')
    p(`- Interface: ${interfaceLabel(map, b)}`)
    if (b.mfr_spec.length) p(`- Manufacturer spec (not a LANDFALL constant): ${b.mfr_spec.join('; ')}`)
    if (b.datasheet) {
      const d = b.datasheet
      const what = d.status === "read" ? `read ${d.checked}` : `not retrieved, ${d.checked}`
      p(`- Datasheet (${what}): ${d.url}${d.product_page ? `; product page ${d.product_page}` : ''}. ${d.note}`)
      if (d.verified?.length) p(`  - Verified text: ${d.verified.map((v) => `"${v}"`).join('; ')}`)
    } else p('- Datasheet: none (no part selected)')
    for (const r of b.rates) {
      const basis = r.source.kind === 'derived' ? r.source.arithmetic : r.source.rationale
      p(`- Rate, ${r.what}: ${code(`${r.value} ${r.unit}`)} (chip: ${r.chip}${r.basis ? `, ${r.basis}` : ''}). ${basis}`)
    }
    p('', '(a) Produces:')
    if (b.produces.length) for (const x of b.produces) p(`- ${code(x.variable)} ${x.label} [${x.unit}]: ${x.how}${x.not_in_spec ? ' (not a SPEC 3.3 indicator)' : ''}`)
    else p(`- ${b.produces_note ?? 'nothing directly'}`)
    p('', '(b) Feeds:')
    if (b.feeds.length) for (const f of b.feeds) p(`- ${feedLabel(f)}`)
    else p('- nothing directly (power domain)')
    p('', '(c) Justified or constrained by:')
    for (const r of b.justified_by) {
      p(reqLine(r))
      for (const l of r.limits ?? []) p(`  - ${l.what}: ${code(`${l.value} ${l.unit}`)} (chip: ${l.chip}${l.table ? `, ${l.table}` : ''})${l.rationale ? ` ${l.rationale}` : ''}`)
    }
    if (b.design.length) {
      p('', 'Design notes:')
      for (const d of b.design) p(`- ${d}`)
    }
    p('')
  }

  p('## NOT MEASURABLE HERE: the hand-off boundary', '', 'What the band does not measure, and the documented path each value takes into LANDFALL instead.', '')
  p('| What | Why not on the band | Arrives via (observation source) | NASA requirement | Feeds |', '|---|---|---|---|---|')
  for (const h of map.not_measurable_here) {
    const reqs = [h.requirement, ...(h.also ?? [])].filter((r): r is ReqRef => Boolean(r))
    const req = reqs.map((r) => `${code(reqLabel(r))} ${RELATION_SHORT[r.relation]}`).join('; ')
    const ex = h.examples?.length ? ` Examples: ${h.examples.map((e) => `${e.name} (${code(e.snapshot)})`).join('; ')}.` : ''
    p(`| ${md(h.what)} | ${md(h.why)}${md(ex)} | ${md(h.via)} (${code(h.source)}) | ${req} | ${md(h.feeds.map(feedLabel).join('; '))} |`)
  }
  p('')
  for (const h of map.not_measurable_here) {
    const reqs = [h.requirement, ...(h.also ?? [])].filter((r): r is ReqRef => Boolean(r))
    if (!reqs.length) continue
    p(`${h.what}:`)
    for (const r of reqs) p(reqLine(r))
    p('')
  }

  p('', '## Power and autonomy', '', map.power.summary, '')
  p('| Block | Estimated average current |', '|---|---|')
  for (const l of map.power.budget) p(`| ${md(l.label)} | ${code(`${l.ua} uA`)} |`)
  p('', `Budget chip: ${map.power.budget_chip}. ${map.power.budget_source.kind === 'design_choice' ? map.power.budget_source.rationale : ''}`, '')
  p('| Step | Value | Chip | Arithmetic or rationale |', '|---|---|---|---|')
  for (const s of map.power.steps) p(stepLine(s))
  p('', map.power.comparison, '', map.power.no_requirement, '')

  p('## Log depth', '', map.log.summary, '')
  p('| Step | Value | Chip | Arithmetic or rationale |', '|---|---|---|---|')
  for (const s of map.log.steps) p(stepLine(s))

  p('', '## What NASA does not publish (declared on the drawing)', '')
  for (const n of map.negatives) {
    p(`- **${n.claim}** ${n.detail} Evidence: ${code(n.pattern)} gives ${n.hits} hit${n.hits === 1 ? '' : 's'} across Vol 2 Rev F (${code(n.snapshot)}).`)
  }

  p('', `## Flown reference: ${map.flown_reference.name}`, '')
  for (const f of map.flown_reference.facts) p(`- ${f}`)
  p('', `Basis: ${map.flown_reference.basis}`, '', '| Channel | Rate | Resolution |', '|---|---|---|')
  for (const c of map.flown_reference.channels) p(`| ${md(c.channel)} | ${code(c.rate_text ?? `${c.rate_hz} Hz`)} | ${md(c.resolution || '-')} |`)

  p('', '## Bio-Monitor pitfalls (credibility notes)', '', `Basis: ${map.pitfalls_basis}`, '')
  for (const t of map.pitfalls) {
    p(`- **${t.title}.** ${t.text} Consequence for the band: ${t.consequence}`)
    for (const a of t.arithmetic ?? []) p(`  - ${a.label}: ${code(`${a.value} ${a.unit}`)} (chip: ${a.chip}) ${a.arithmetic}`)
  }

  p('', '## Safety constraints', '', `Basis: ${map.safety_basis}`, '', '| Topic | Reference | Constraint | Chip |', '|---|---|---|---|')
  for (const s of map.safety) p(`| ${md(s.topic)} | ${s.refs.map(code).join(', ')} | ${md(s.text)} | ${s.chip} |`)

  p('', '## Open items', '')
  for (const o of map.open_items) p(`- ${o}`)
  p('')
  return out.join('\n')
}
