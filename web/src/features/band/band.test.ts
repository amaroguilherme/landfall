// LANDFALL BAND integrity: hardware/sensor-map.json is the single source of truth, so this suite
// checks that (1) the committed BOM.csv and sensor-map.md equal a fresh render, (2) every indicator,
// rule and case id resolves in engine/rules, (3) every NASA quote is verbatim in its frozen snapshot,
// (4) every declared negative matches the snapshot's own search, and (5) every sum is re-computed.
import { describe, expect, it } from 'vitest'
import rawMap from '../../../../hardware/sensor-map.json'
import { renderBomCsv, renderMarkdown } from './render'
import type { ReqRef, SensorMap, Step } from './types'

const map = rawMap as unknown as SensorMap

const files = import.meta.glob<string>('../../../../hardware/{BOM.csv,sensor-map.md}', { query: '?raw', import: 'default', eager: true })
const rules = import.meta.glob<Record<string, unknown>>('../../../../engine/rules/{personal,thresholds,cases}.json', { eager: true, import: 'default' })
const snaps = import.meta.glob<Record<string, unknown>>(
  '../../../public/data/{std_vol1_requirements,std_vol2_requirements,hrp_research,hrp_csa_radiation,hapi_iss_tepc,osdr_cmp,manifest}.json',
  { eager: true, import: 'default' },
)

function pick<T>(glob: Record<string, T>, name: string): T {
  const key = Object.keys(glob).find((k) => k.endsWith('/' + name))
  if (!key) throw new Error(`not found: ${name}`)
  return glob[key]
}

type Req = { id: string; text: string; rationale?: string; items?: unknown }
const personal = pick(rules, 'personal.json') as { indicators: { id: string; unit: string; variable: string }[]; rci: { baseline_window_days: number } }
const thresholds = pick(rules, 'thresholds.json') as { rules: { id: string }[] }
const cases = pick(rules, 'cases.json') as { cases: { id: string; tripwire: { reassess_after_s: number } }[] }
const vol1 = (pick(snaps, 'std_vol1_requirements.json') as { data: { requirements: Req[] } }).data.requirements
const vol2Snap = pick(snaps, 'std_vol2_requirements.json') as { data: { requirements: Req[]; negatives: { pattern: string; hit_count: number }[] } }
const vol2 = vol2Snap.data.requirements
const manifest = pick(snaps, 'manifest.json') as { snapshots: { id: string }[] }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const CHIPS = ['NASA-published', 'NASA brief', 'NOAA-published', 'literature', 'derived', 'design choice']

function requirementText(id: string): string {
  const v1 = id.match(/^V1 (\d+)$/)
  if (v1) {
    const r = vol1.find((x) => x.id === `V1 ${v1[1]}`)
    return r ? norm(`${r.text} ${r.rationale ?? ''}`) : ''
  }
  const v2 = id.match(/^V2 (\d+)$/)
  if (v2) {
    const r = vol2.find((x) => x.id === `[V2 ${v2[1]}]`)
    return r ? norm(`${r.text} ${r.rationale ?? ''}`) : ''
  }
  return ''
}

function allReqRefs(): ReqRef[] {
  const out: ReqRef[] = [...map.anchors]
  for (const b of map.blocks) out.push(...b.justified_by)
  for (const h of map.not_measurable_here) if (h.requirement) out.push(h.requirement)
  return out
}

function step(steps: Step[], id: string): number {
  const s = steps.find((x) => x.id === id)
  if (!s) throw new Error(`no step ${id}`)
  return s.value
}

describe('LANDFALL BAND sensor map', () => {
  it('has the expected schema and the generated files are in sync with the JSON', () => {
    expect(map.schema).toBe('landfall.sensor_map/1')
    expect(pick(files, 'BOM.csv')).toBe(renderBomCsv(map))
    expect(pick(files, 'sensor-map.md')).toBe(renderMarkdown(map))
  })

  it('names every indicator exactly as personal.json does, with the same unit', () => {
    for (const b of map.blocks) {
      for (const p of b.produces) {
        if (p.not_in_spec) continue
        const ind = personal.indicators.find((i) => i.variable === p.variable)
        expect(ind, `${b.id} produces ${p.variable}`).toBeTruthy()
        expect(ind?.unit, `${b.id} ${p.variable} unit`).toBe(p.unit)
      }
    }
  })

  it('feeds only rules, indicators and cases that exist', () => {
    const feeds = [...map.blocks.flatMap((b) => b.feeds), ...map.not_measurable_here.flatMap((h) => h.feeds)]
    for (const f of feeds) {
      if (f.kind === 'personal' && f.id !== '*') expect(personal.indicators.some((i) => i.id === f.id), f.id).toBe(true)
      if (f.kind === 'rule') expect(thresholds.rules.some((r) => r.id === f.id), f.id).toBe(true)
      if (f.kind === 'case') expect(cases.cases.some((c) => c.id === f.id), f.id).toBe(true)
    }
  })

  it('quotes every NASA-STD-3001 requirement verbatim from the frozen snapshots', () => {
    for (const r of allReqRefs()) {
      if (r.snapshot !== 'std_vol1_requirements' && r.snapshot !== 'std_vol2_requirements') continue
      const ids = r.id.includes(' / ') ? r.id.split(' / ').map((x, i) => (i === 0 ? x : `V2 ${x}`)) : [r.id]
      const quotes = ids.length > 1 ? r.quote.split(' / ') : [r.quote]
      expect(quotes.length, r.id).toBe(ids.length)
      ids.forEach((id, i) => {
        const text = requirementText(id)
        expect(text, `${id} is in ${r.snapshot}`).not.toBe('')
        expect(text.includes(norm(quotes[i])), `${id}: "${quotes[i]}"`).toBe(true)
      })
    }
  })

  it('quotes NASA and CSA pages verbatim from their snapshots', () => {
    const research = JSON.stringify(pick(snaps, 'hrp_research.json'))
    for (const r of allReqRefs().filter((x) => x.snapshot === 'hrp_research')) expect(research.includes(r.quote), r.quote).toBe(true)
    for (const h of map.not_measurable_here) {
      for (const e of h.examples ?? []) {
        const snap = JSON.stringify(pick(snaps, `${e.snapshot}.json`))
        for (const q of e.text.match(/"([^"]+)"/g) ?? []) expect(snap.includes(q.slice(1, -1)), `${e.name}: ${q}`).toBe(true)
      }
    }
  })

  it('references only snapshots that exist in the manifest', () => {
    const ids = new Set(manifest.snapshots.map((s) => s.id))
    const refs = [
      ...allReqRefs().map((r) => r.snapshot),
      ...map.not_measurable_here.flatMap((h) => (h.examples ?? []).map((e) => e.snapshot)),
      ...map.negatives.map((n) => n.snapshot),
      ...map.safety.map((s) => s.snapshot),
    ].filter((x): x is string => typeof x === 'string')
    for (const id of refs) expect(ids.has(id), id).toBe(true)
  })

  it('declares only negatives the Vol 2 snapshot itself found', () => {
    for (const n of map.negatives) {
      const neg = vol2Snap.data.negatives.find((x) => x.pattern === n.pattern)
      expect(neg, n.claim).toBeTruthy()
      expect(neg?.hit_count, n.claim).toBe(n.hits)
    }
  })

  it('labels every number with one of the six chips', () => {
    const chips = [
      ...map.blocks.flatMap((b) => b.rates.map((r) => r.chip)),
      ...allReqRefs().flatMap((r) => (r.limits ?? []).map((l) => l.chip)),
      ...map.power.steps.map((s) => s.chip),
      ...map.log.steps.map((s) => s.chip),
      ...map.pitfalls.flatMap((p) => (p.arithmetic ?? []).map((a) => a.chip)),
      ...map.safety.map((s) => s.chip),
      map.power.budget_chip,
    ]
    for (const c of chips) expect(CHIPS, c).toContain(c)
  })

  it('keeps the rates it says it derived from the flown Bio-Monitor', () => {
    for (const b of map.blocks) {
      for (const r of b.rates) {
        if (r.source.kind !== 'derived') continue
        for (const from of r.source.from) {
          const ch = map.flown_reference.channels.find((c) => `flown_reference.${c.id}` === from)
          expect(ch, from).toBeTruthy()
          const flown = r.unit === 's' ? 1 / (ch?.rate_hz ?? NaN) : (ch?.rate_hz ?? NaN)
          expect(Math.abs(flown - r.value), `${b.id} ${r.what}`).toBeLessThan(1e-6)
        }
      }
    }
  })

  it('re-computes the power budget and autonomy', () => {
    const steps = map.power.steps
    const sum = map.power.budget.reduce((a, l) => a + l.ua, 0)
    expect(step(steps, 'i_sum')).toBe(sum)
    const iPlan = (sum * step(steps, 'margin')) / 1000
    expect(step(steps, 'i_plan')).toBeCloseTo(iPlan, 9)
    const wh = (3.7 * step(steps, 'capacity')) / 1000
    expect(step(steps, 'energy')).toBeCloseTo(wh, 9)
    const hours = (step(steps, 'capacity') * step(steps, 'usable')) / 100 / iPlan
    expect(step(steps, 'autonomy')).toBe(Math.round(hours))
    expect(step(steps, 'headroom')).toBeCloseTo(Math.round((step(steps, 'autonomy') / step(steps, 'target')) * 10) / 10, 9)
    // JSC-20793 Rev D Non-Critical class: < 4 Wh per pack, <= 1000 mAh per Li-ion COTS cell.
    expect(wh).toBeLessThan(4)
    expect(step(steps, 'capacity')).toBeLessThanOrEqual(1000)
    // The autonomy target is one whole case tripwire window (cases.json).
    for (const id of ['renal_stone', 'sleep_circadian']) {
      expect(cases.cases.find((c) => c.id === id)?.tripwire.reassess_after_s).toBe(step(steps, 'target') * 3600)
    }
    expect(hours).toBeGreaterThanOrEqual(step(steps, 'target'))
  })

  it('re-computes the log depth', () => {
    const s = map.log.steps
    expect(step(s, 'flash')).toBe((128 * 1024 * 1024) / 8)
    const space = step(s, 'flash') - step(s, 'ecg_ring') - step(s, 'meta')
    expect(step(s, 'space')).toBe(space)
    expect(step(s, 'rr')).toBe(100 * 1440 * 2)
    expect(step(s, 'epochs')).toBe(1440 * 32)
    expect(step(s, 'daily')).toBe(step(s, 'rr') + step(s, 'epochs'))
    expect(step(s, 'depth')).toBeCloseTo(Math.round((space / step(s, 'daily')) * 10) / 10, 9)
    expect(step(s, 'raw_rate')).toBe(256 * 3)
    expect(step(s, 'raw_ring')).toBe(Math.round(step(s, 'ecg_ring') / step(s, 'raw_rate') / 60))
    expect(step(s, 'raw_all')).toBeCloseTo(Math.round((step(s, 'flash') / step(s, 'raw_rate') / 3600) * 10) / 10, 9)
    // The log target is one whole RCI baseline window (personal.json).
    expect(step(s, 'target')).toBe(personal.rci.baseline_window_days)
    expect(step(s, 'depth')).toBeGreaterThanOrEqual(step(s, 'target'))
  })

  it('re-computes the export-cap pitfall arithmetic', () => {
    const cap = map.pitfalls.find((p) => p.id === 'export_cap')?.arithmetic ?? []
    expect(cap.find((a) => a.label.startsWith('R-R'))?.value).toBeCloseTo(Math.round((65536 / 6000) * 10) / 10, 9)
    expect(cap.find((a) => a.label.startsWith('1-min'))?.value).toBeCloseTo(Math.round((65536 / 1440) * 10) / 10, 9)
  })

  it('puts every hand-off outside the band and names its path', () => {
    expect(map.not_measurable_here.length).toBeGreaterThanOrEqual(6)
    for (const h of map.not_measurable_here) {
      expect(['manual', 'vehicle', 'lab']).toContain(h.source)
      expect(h.via.length).toBeGreaterThan(0)
    }
    const produced = new Set(map.blocks.flatMap((b) => b.produces.map((p) => p.variable)))
    for (const v of ['urine_volume_24h', 'fluid_intake_24h', 'vo2max', 'career_effective_dose', 'cabin_ppco2']) expect(produced.has(v), v).toBe(false)
  })
})
