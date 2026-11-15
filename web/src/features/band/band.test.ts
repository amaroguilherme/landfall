// LANDFALL BAND integrity: hardware/sensor-map.json is the single source of truth, so this suite
// checks that (1) the committed BOM.csv and sensor-map.md equal a fresh render, (2) every indicator,
// rule and case id resolves in engine/rules, (3) every NASA quote is verbatim in its frozen snapshot,
// (4) every declared negative matches the snapshot's own search, and (5) every sum is re-computed.
import { describe, expect, it } from 'vitest'
import rawMap from '../../../../hardware/sensor-map.json'
import { renderBomCsv, renderMarkdown } from './render'
import type { ReqRef, SensorMap, Step } from './types'

const map = rawMap as unknown as SensorMap

const files = import.meta.glob<string>('../../../../hardware/{BOM.csv,sensor-map.md,README.md}', { query: '?raw', import: 'default', eager: true })
const views = import.meta.glob<string>('./{index,Diagram}.tsx', { query: '?raw', import: 'default', eager: true })
const rules = import.meta.glob<Record<string, unknown>>('../../../../engine/rules/{personal,thresholds,cases,meta}.json', { eager: true, import: 'default' })
const snaps = import.meta.glob<Record<string, unknown>>(
  '../../../public/data/{std_vol1_requirements,std_vol2_requirements,hrp_research,hrp_csa_radiation,hapi_iss_tepc,osdr_cmp,swpc_spe_replay,sim_crew,manifest}.json',
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
type Table = { caption: string; rows: string[][]; footnote?: string }
const vol2Snap = pick(snaps, 'std_vol2_requirements.json') as {
  data: { requirements: Req[]; negatives: { pattern: string; hit_count: number }[]; tables: Record<string, Table> }
}
const vol2 = vol2Snap.data.requirements
const manifest = pick(snaps, 'manifest.json') as { snapshots: { id: string }[] }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
// The six chips are owned by engine/rules/meta.json (a renamed chip must not break this test).
const CHIPS = ((pick(rules, 'meta.json') as { chips?: { id: string }[] }).chips ?? []).map((c) => c.id)

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
  for (const h of map.not_measurable_here) {
    if (h.requirement) out.push(h.requirement)
    out.push(...(h.also ?? []))
  }
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
    expect(step(s, 'ibi')).toBe(100 * 1440 * 2)
    expect(step(s, 'epochs')).toBe(1440 * 32)
    expect(step(s, 'daily')).toBe(step(s, 'ibi') + step(s, 'epochs'))
    expect(step(s, 'depth')).toBeCloseTo(Math.round((space / step(s, 'daily')) * 10) / 10, 9)
    // The log target is one whole Tier B baseline window (personal.json).
    expect(step(s, 'target')).toBe(personal.rci.baseline_window_days)
    expect(step(s, 'depth')).toBeGreaterThanOrEqual(step(s, 'target'))
    // Raw ECG is kept only for spot checks, at the block's own rate and length.
    const ecg = map.blocks.find((b) => b.id === 'ecg')
    const sps = ecg?.rates.find((r) => r.unit === 'sps')?.value ?? NaN
    const spot = ecg?.rates.find((r) => /spot-check length/i.test(r.what))?.value ?? NaN
    expect(step(s, 'ecg_rate')).toBe(sps * 3)
    const ringS = step(s, 'ecg_ring') / step(s, 'ecg_rate')
    expect(step(s, 'ecg_ring_min')).toBe(Math.round(ringS / 60))
    expect(step(s, 'spot_checks')).toBe(Math.floor(ringS / spot))
    // The continuous record is pulse intervals, because the raw optical waveform would fill the flash in a day.
    const hz = map.blocks.find((b) => b.id === 'ppg')?.rates[0]?.value ?? NaN
    expect(step(s, 'ppg_rate')).toBe(hz * 3)
    expect(step(s, 'ppg_all')).toBeCloseTo(Math.round((step(s, 'flash') / step(s, 'ppg_rate') / 3600) * 10) / 10, 9)
    expect(step(s, 'ppg_all')).toBeLessThan(step(s, 'target') * 24)
  })

  it('names what Vol 2 Rev F does not set for the log: storage capacity, retention or log duration', () => {
    // [V2 6020] does require cabin atmosphere data to be recorded, so an unqualified "no storage requirement" is wrong.
    const narrowed = 'sets no storage-capacity, retention or log-duration requirement for wearables'
    expect(map.log.summary).toBe(`NASA-STD-3001 Vol 2 Rev F ${narrowed}, so every target here is a design choice.`)
    expect(map.blocks.find((b) => b.id === 'flash')?.design).toContain(`NASA-STD-3001 Vol 2 Rev F ${narrowed}, so the 14-day target is a design choice.`)
    expect(pick(files, 'README.md')).toContain('**No battery-endurance, storage-capacity, retention or log-duration requirement** for wearables')
    const loose = /no storage or log-duration|no requirement for wearable storage|battery-endurance, storage or log-duration/i
    expect(JSON.stringify(map)).not.toMatch(loose)
    expect(pick(files, 'README.md')).not.toMatch(loose)
    expect(pick(files, 'sensor-map.md')).not.toMatch(loose)
  })

  it('re-computes the export-cap pitfall arithmetic', () => {
    const cap = map.pitfalls.find((p) => p.id === 'export_cap')?.arithmetic ?? []
    expect(cap.find((a) => a.label.startsWith('Pulse intervals'))?.value).toBeCloseTo(Math.round((65536 / 6000) * 10) / 10, 9)
    expect(cap.find((a) => a.label.startsWith('1-min'))?.value).toBeCloseTo(Math.round((65536 / 1440) * 10) / 10, 9)
  })

  it('reads the leakage limits from Table 9.3-11 (External body contact) and quotes its footnote verbatim', () => {
    const t = vol2Snap.data.tables.table_9_3_11
    expect(t.caption).toContain('Table 9.3-11')
    const cell = (cond: string) => t.rows.find((r) => r[0] === 'External*' && r[1] === 'DC to 1 kHz' && r[2] === cond)
    const ecg = map.blocks.find((b) => b.id === 'ecg')?.justified_by.find((r) => r.id === 'V2 9023')
    const limits = ecg?.limits ?? []
    expect(limits).toHaveLength(2)
    const normal = limits.find((l) => /normal/.test(l.what))
    const fault = limits.find((l) => /single fault/.test(l.what))
    expect(String(normal?.value)).toBe(cell('Normal')?.[3])
    expect(String(normal?.value)).toBe(cell('Normal')?.[4])
    expect(String(fault?.value)).toBe(cell('Single Fault')?.[3])
    expect(String(fault?.value)).toBe(cell('Single Fault')?.[4])
    for (const l of limits) expect(l.unit).toBe('mA')
    // The ECG design note quotes the table footnote, which matters for a band worn around the clock.
    const footnote = t.footnote ?? ''
    expect(footnote.length).toBeGreaterThan(0)
    expect(map.blocks.find((b) => b.id === 'ecg')?.design.some((d) => d.includes(footnote))).toBe(true)
    // Both skin-contact sensing blocks are held to [V2 9023].
    for (const id of ['ecg', 'ppg']) expect(map.blocks.find((b) => b.id === id)?.justified_by.some((r) => r.id === 'V2 9023'), id).toBe(true)
  })

  it('states the general body-current limits exactly as [V2 9019] to [V2 9021] give them', () => {
    const row = map.safety.find((s) => s.id === 'body_current')
    expect(row?.refs).toEqual(['V2 9019', 'V2 9020', 'V2 9021'])
    const text = (id: string) => vol2.find((r) => r.id === `[${id}]`)?.text ?? ''
    expect(text('V2 9019')).toMatch(/0\.4 mA for Direct Current \(DC\).*0\.2 mA peak for Alternating Current/)
    expect(text('V2 9020')).toMatch(/40mA for DC.*8 mA peak for AC/)
    expect(text('V2 9021')).toMatch(/2 mA for DC.*0\.5 mA for AC/)
    for (const n of ['0.4 mA DC', '0.2 mA peak AC', '2 mA DC', '0.5 mA AC', '40 mA DC', '8 mA peak AC']) expect(row?.text, n).toContain(n)
  })

  it('specifies a power switch and a status light that show the band state, never a health value', () => {
    const power = map.safety.find((s) => s.id === 'power_control')
    const light = map.safety.find((s) => s.id === 'status_light')
    const table = map.safety.find((s) => s.refs.includes('V2 10201'))
    expect(power?.text).toMatch(/see Status light/)
    expect(light?.chip).toBe('design choice')
    expect(light?.snapshot).toBe('std_vol2_requirements')
    const reqs = (light?.refs ?? []).filter((r) => /^V2 [0-9]+$/.test(r))
    expect(reqs.length).toBeGreaterThan(0)
    for (const id of reqs) expect(requirementText(id), id).not.toBe('')
    const text = light?.text ?? ''
    expect(text).toMatch(/nothing on the outside of the band shows a health value/)
    const words = new Set(text.toLowerCase().split(/[^a-z0-9_]+/))
    for (const i of personal.indicators) expect(words.has(i.variable), i.variable).toBe(false)
    expect(text).toMatch(/There is no red state/)
    expect(text).toMatch(/That deviation is declared/)
    expect(text).not.toMatch(/white|blue|cyan/i)
    expect(requirementText('V2 10201')).toBe('')
    expect(requirementText('V2 10022')).toBe('')
    expect(table?.snapshot).toBeNull()
    expect(table?.chip).toBe('NASA-published')
    expect(table?.links?.some((l) => l.url === 'https://www.nasa.gov/wp-content/uploads/2025/05/nasa-std-3001-vol-2.pdf')).toBe(true)
    expect(map.safety_basis).toMatch(/V2 10201/)
    expect(map.open_items.some((o) => /No power switch or status light/.test(o))).toBe(false)
    expect(map.open_items.some((o) => /status light/.test(o) && /no parts selected/.test(o))).toBe(true)
  })

  it('takes the status-light blink from F.5.11 b and declares the yellow fault against Table F.5-1 too', () => {
    // The rationale of [V2 10150] (PDF p. 200, not frozen) applies Appendix F to indicator lights, so Table F.5-1 covers the light.
    type AppendixF = { table_f_5_1: { rows: { meaning: string; color: string }[] }; clauses: { clause: string; text: string }[] }
    const f = (vol2Snap.data as unknown as { appendix_f_colors: AppendixF }).appendix_f_colors
    const meaning = (color: string) => f.table_f_5_1.rows.find((r) => r.color === color)?.meaning ?? ''
    expect(meaning('Red')).toMatch(/\bfailed\b/)
    expect(meaning('Yellow')).toMatch(/\boff-nominal\b/)
    expect(f.clauses.find((c) => c.clause === 'F.5.11 b')?.text).toMatch(/^Low flash rate .* 0\.8 Hz with duty cycle of 70% on\.$/)
    const text = map.safety.find((s) => s.id === 'status_light')?.text ?? ''
    expect(text).toContain('Yellow, blinking at 0.8 Hz with 70 % on')
    expect(text).toContain("the 0.8 Hz rate with 70 % on is F.5.11 b's low flash rate")
    expect(text).toContain('not the red that Table 10.4-3 and Table F.5-1 both give to Failed')
    expect(text).not.toMatch(/display clause/)
  })

  it('cites Table 8.7-2 (melanopic EDI and DER at the cornea) for the light sensor, with the snapshot cells', () => {
    const t = vol2Snap.data.tables.table_8_7_2
    const light = map.blocks.find((b) => b.id === 'light')
    expect(light?.justified_by[0]?.id).toBe('V2 8055')
    const lim = light?.justified_by[0]?.limits ?? []
    const ambient = t.rows.find((r) => r[0] === 'General Ambient Lighting')
    const presleep = t.rows.find((r) => r[0] === 'Crew Pre-Sleep')
    expect(ambient?.[1]).toBe(`≥ ${lim.find((l) => /General ambient, melanopic EDI/.test(l.what))?.value}`)
    expect(ambient?.[2]).toBe(`≥ ${lim.find((l) => /General ambient, melanopic DER/.test(l.what))?.value}`)
    expect(presleep?.[1]).toBe(`${lim.find((l) => /pre-sleep, melanopic EDI/.test(l.what))?.value} +/- 2`)
    expect(presleep?.[2]).toBe(`≤ ${lim.find((l) => /pre-sleep, melanopic DER/.test(l.what))?.value}`)
    // ARCHeR (Artemis II) is cited from the page's image caption, which the snapshot flags as such.
    const archer = light?.justified_by.find((r) => r.id.startsWith('ARCHeR'))
    expect(archer?.snapshot).toBe('hrp_research')
    expect(archer?.doc).toMatch(/caption/)
  })

  it('never cites the unfound Standard Measures colour quote or the suit-atmosphere triad as wearable requirements', () => {
    const all = JSON.stringify(map)
    expect(all).not.toMatch(/white, red, green/i)
    expect(all).not.toMatch(/red, green and blue/i)
    // The page text (data) never had it; the snapshot's caveats say so explicitly.
    const research = pick(snaps, 'hrp_research.json') as { data: unknown; caveats: string[] }
    expect(JSON.stringify(research.data)).not.toMatch(/white, red, green/i)
    expect(research.caveats.some((c) => c.includes("does not use the phrase 'white, red, green, and blue light in lux'"))).toBe(true)
    for (const r of allReqRefs()) expect(r.id, r.id).not.toMatch(/1103[456]/)
  })

  it('hands radiation off to [V2 6164] and [V2 6165] and keeps the no-minimum-sensor-set citation', () => {
    const rad = map.not_measurable_here.find((h) => h.id === 'radiation')
    expect(rad?.requirement?.id).toBe('V2 6164')
    const v6165 = rad?.also?.find((r) => r.id === 'V2 6165')
    expect(v6165?.relation).toBe('delegates')
    const rationale = vol2.find((r) => r.id === '[V2 6165]')?.rationale ?? ''
    const quoted = v6165?.note?.match(/"([^"]+)"/)?.[1] ?? ''
    expect(quoted.length).toBeGreaterThan(0)
    expect(rationale).toContain(quoted)
    expect(map.gap.ntrs).toBe('20200001715')
    expect(map.gap.quote).toBe('All crewmembers are wearing biosensors')
    expect(map.negatives.some((n) => n.id === 'sensor_set')).toBe(true)
  })

  it('names a datasheet for every selected part and claims manufacturer specs only where it was read', () => {
    for (const b of map.blocks) {
      if (b.id === 'battery') {
        expect(b.datasheet, b.id).toBeNull()
        expect(b.mfr_spec, b.id).toEqual([])
        continue
      }
      const d = b.datasheet
      expect(d, b.id).toBeTruthy()
      expect(d?.url, b.id).toMatch(/^https:\/\//)
      expect(d?.checked, b.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(['read', 'not_retrieved'], b.id).toContain(d?.status)
      if (d?.status === 'not_retrieved') expect(b.mfr_spec, `${b.id} claims nothing it could not read`).toEqual([])
      else expect(d?.verified?.length, `${b.id} quotes what it read`).toBeGreaterThan(0)
    }
    const bom = pick(files, 'BOM.csv')
    for (const b of map.blocks) if (b.datasheet) expect(bom.includes(b.datasheet.url), b.id).toBe(true)
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

  it('takes heart rate and HRV from the optical pulse, never from a wrist-only ECG', () => {
    const ppg = map.blocks.find((b) => b.id === 'ppg')
    const ecg = map.blocks.find((b) => b.id === 'ecg')
    // Two electrodes on one wrist form no lead across the heart: the ECG produces no indicator and feeds no rule.
    expect(ecg?.produces.every((p) => p.not_in_spec), 'the ECG produces no Tier B indicator').toBe(true)
    expect(ecg?.feeds.every((f) => f.kind === 'none'), 'no LANDFALL rule reads the ECG').toBe(true)
    expect(ecg?.function).toMatch(/other hand/)
    expect(ecg?.function).toMatch(/spot check/)
    expect(ecg?.justified_by.some((r) => r.id === 'V1 3004' && r.item === 'i' && /electrocardiography/.test(r.quote))).toBe(true)
    // The PPG is the heart-rate source, and says that its variability is pulse-rate variability.
    const ppgVars = ppg?.produces.map((p) => p.variable) ?? []
    for (const v of ['resting_hr', 'hrv_sdnn', 'heart_rate']) expect(ppgVars, v).toContain(v)
    const hrv = ppg?.produces.find((p) => p.variable === 'hrv_sdnn')
    expect(`${hrv?.label} ${hrv?.how}`).toMatch(/PRV/)
    expect(hrv?.how).toMatch(/approximation of HRV/)
    expect(ppg?.rates[0]?.what).toMatch(/continuous/)
    // Each heart indicator has exactly one source block.
    for (const v of ['resting_hr', 'hrv_sdnn', 'heart_rate']) expect(map.blocks.filter((b) => b.produces.some((p) => p.variable === v)).map((b) => b.id), v).toEqual(['ppg'])
    expect(map.heart.points.map((h) => h.block)).toEqual(['ppg', 'ecg'])
  })

  it('produces every scenario variable the simulation attributes to the band', () => {
    const sim = pick(snaps, 'sim_crew.json') as { data: { variables: Record<string, { source: string; unit: string }> } }
    const produced = new Map(map.blocks.flatMap((b) => b.produces.map((p) => [p.variable, p] as const)))
    const bandVars = Object.entries(sim.data.variables).filter(([, v]) => v.source === 'band')
    expect(bandVars.length).toBeGreaterThan(0)
    for (const [id, v] of bandVars) {
      expect(produced.has(id), `${id} (source band) is produced by a band block`).toBe(true)
      expect(produced.get(id)?.unit, `${id} unit`).toBe(v.unit)
    }
  })

  it('cites every published basis outside the standard in full, with a chip and the date it was read', () => {
    const all = [...map.blocks.flatMap((b) => b.evidence ?? []), ...map.not_measurable_here.flatMap((h) => h.evidence ?? [])]
    expect(all.length).toBeGreaterThanOrEqual(3)
    for (const e of all) {
      expect(CHIPS, e.claim).toContain(e.chip)
      expect(e.source.url, e.claim).toMatch(/^https:\/\//)
      expect(e.checked, e.claim).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.quote.length, e.claim).toBeGreaterThan(20)
      expect(e.source.kind === 'literature' ? e.source.citation : e.source.doc, e.claim).toMatch(/\d{4}/)
    }
    // Every quoted document that is not frozen here names its public copy and the date it was read.
    for (const r of allReqRefs().filter((x) => !x.snapshot)) {
      expect(r.url, r.id).toMatch(/^https:\/\//)
      expect(r.checked, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    for (const s of map.safety.filter((x) => !x.snapshot)) expect(s.links?.length, s.id).toBeGreaterThan(0)
    for (const s of map.flown_reference.sources) expect(s.url, s.label).toMatch(/^https:\/\//)
  })

  it('scopes its negative claims and keeps process notes out of the judge-facing text', () => {
    // "NASA publishes no ..." is never said unscoped: each negative names the document that was searched.
    for (const text of [map.gap.claim, ...map.negatives.map((n) => n.claim)]) expect(text, text).not.toMatch(/NASA publishes no/i)
    expect(map.gap.claim).toMatch(/assumes the crew wears biosensors and specifies none/)
    for (const n of map.negatives) expect(n.claim, n.id).toMatch(/Vol 2 Rev F/)
    // The private plan, the build machine and memory are never cited; process notes live in build_notes.
    const banned = /PLANO|build machine|from memory|project preparation/i
    const { build_notes: notes, ...facing } = map
    expect(JSON.stringify(facing)).not.toMatch(banned)
    expect(notes.join(' ')).not.toMatch(banned)
    expect(pick(files, 'README.md')).not.toMatch(banned)
    expect(pick(files, 'sensor-map.md')).not.toMatch(banned)
    for (const [name, src] of Object.entries(views)) expect(src, name).not.toMatch(banned)
    // Headings name the document they searched, too.
    const unscoped = /What NASA does not publish|NASA publishes no/
    expect(pick(files, 'sensor-map.md')).not.toMatch(unscoped)
    for (const [name, src] of Object.entries(views)) expect(src, name).not.toMatch(unscoped)
  })

  it('hands the radiation alarm to the vehicle and the proton flux to an external monitor (the band measures neither)', () => {
    const rad = map.not_measurable_here.find((h) => h.id === 'radiation')
    expect(rad?.via).toMatch(/alarm/)
    expect(rad?.via).toMatch(/external space-weather monitor/)
    expect(rad?.why).toMatch(/LANDFALL is not the radiation alarm/)
    expect(rad?.why).toMatch(/no distance or atmospheric correction/)
    const conops = rad?.evidence?.find((e) => e.source.url.includes('20200001715'))
    expect(conops?.quote).toMatch(/annunciates alarms to warn the crew and the medical system/)
    const goes = rad?.examples?.find((e) => e.snapshot === 'swpc_spe_replay')
    expect(goes?.name).toMatch(/GOES-7/)
  })

  it('hands blood pressure and glucose to the medical kit, entered by hand', () => {
    const bp = map.not_measurable_here.find((h) => h.id === 'bp')
    expect(bp?.source).toBe('manual')
    expect(bp?.what).toMatch(/Blood pressure/)
    expect(bp?.what).toMatch(/glucose/)
    expect(bp?.via).toMatch(/cuff/)
    expect(bp?.via).toMatch(/glucometer/)
    expect(bp?.why).toMatch(/NASA-STD-3001 sets no numeric limit for either/)
    for (const id of ['bp_systolic', 'bp_diastolic', 'glucose']) expect(bp?.feeds.some((f) => f.kind === 'personal' && f.id === id), id).toBe(true)
  })

  it("agrees with personal.json on which device measures each indicator", () => {
    const produced = new Set(map.blocks.flatMap((b) => b.produces.map((p) => p.variable)))
    const manual = new Set(map.not_measurable_here.filter((h) => h.source === 'manual').flatMap((h) => h.feeds.filter((f) => f.kind === 'personal').map((f) => f.id)))
    const inds = personal.indicators as { id: string; variable: string; device?: string }[]
    for (const i of inds) {
      if (i.device === 'band') expect(produced.has(i.variable), `${i.id}: device band, produced by a band block`).toBe(true)
      else expect(produced.has(i.variable), `${i.id}: device ${i.device}, not produced by the band`).toBe(false)
      if (i.device === 'manual') expect(manual.has(i.id), `${i.id}: device manual, fed by a manual hand-off`).toBe(true)
    }
  })
})
