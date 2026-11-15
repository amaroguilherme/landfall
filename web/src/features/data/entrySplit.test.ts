// #/data: manifest.json labels the whole DONKI SEP snapshot (swpc_sep_events) "measured", yet part of its
// entries are model forecasts (an instrument written "MODEL: …"). Its card counts both kinds from the
// file's own entries and says the snapshot-level provenance applies to the observed ones. Runs on the
// REAL frozen files in web/public/data (never regenerated here).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Manifest, ManifestEntry, Snapshot, SnapshotState } from '../../app/data'
import { isModelEntry } from '../radiation/model'
import type { DonkiData } from '../radiation/model'
import { EntrySplitNote } from './EntrySplit'
import { SnapshotCard } from './SnapshotCard'
import { ENTRY_SPLIT_IDS, entryKind, entrySplit, hasEntrySplit } from './model'

const files = import.meta.glob<unknown>('../../../public/data/{manifest,swpc_sep_events,swpc_spe_list}.json', {
  eager: true,
  import: 'default',
})
const manifest = files['../../../public/data/manifest.json'] as Manifest
const donki = files['../../../public/data/swpc_sep_events.json'] as Snapshot<DonkiData>
const byId = (id: string) => manifest.snapshots.find((e) => e.id === id) as ManifestEntry
const entry = byId('swpc_sep_events')
const events = donki.data.events

/** The file this build ships (manifest sha256), whose split was counted when the card was built. */
const FROZEN = { sha256: 'd17f2d0b6d7e5a56dd917c33f65a0eda14be1a06db93eda08bf2a8725b3a7448', total: 214, observed: 129, model: 85 }

/** Visible text of inline markup (tags removed without adding spaces; the split's tags are all inline). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

const ready = (s: Snapshot): SnapshotState => ({ status: 'ready', snapshot: s, data: s.data, error: null })
const note = (state: SnapshotState, e: Pick<ManifestEntry, 'id' | 'provenance'> = entry) =>
  text(renderToStaticMarkup(createElement(EntrySplitNote, { entry: e, state })))

describe('the DONKI SEP card splits observed entries from model forecasts', () => {
  it('the snapshot is labelled measured as a whole, and only it carries an entry split', () => {
    expect(entry.provenance).toBe('measured')
    expect(donki.provenance).toBe('measured')
    expect([...ENTRY_SPLIT_IDS]).toEqual(['swpc_sep_events'])
    expect(hasEntrySplit('swpc_sep_events')).toBe(true)
    expect(manifest.snapshots.filter((e) => hasEntrySplit(e.id)).map((e) => e.id)).toEqual(['swpc_sep_events'])
  })

  it('counts the file’s entries as an independent "MODEL:" prefix count does, and as Radiation does', () => {
    const split = entrySplit(donki.data)!
    const isModel = (i: string) => i.startsWith('MODEL:')
    expect(split).toEqual({
      total: events.length,
      observed: events.filter((e) => e.instruments.some((i) => !isModel(i))).length,
      model: events.filter((e) => e.instruments.length > 0 && e.instruments.every(isModel)).length,
      unlisted: events.filter((e) => e.instruments.length === 0).length,
    })
    expect(split.observed + split.model + split.unlisted).toBe(split.total)
    expect(split.total).toBe(donki.data.count)
    expect(split.model).toBe(events.filter(isModelEntry).length) // the Radiation page's own test
    expect(split.observed).toBeGreaterThan(0)
    expect(split.model).toBeGreaterThan(0)
  })

  it.runIf(entry.sha256 === FROZEN.sha256)('the shipped file: 129 observed by instruments, 85 model forecasts, of 214', () => {
    expect(entrySplit(donki.data)).toEqual({ total: FROZEN.total, observed: FROZEN.observed, model: FROZEN.model, unlisted: 0 })
  })

  it('classifies one entry: observed when any instrument observed, model when every one is a model, else unlisted', () => {
    expect(entryKind({ instruments: ['GOES-P: SEISS >10 MeV'] })).toBe('observed')
    expect(entryKind({ instruments: ['MODEL: REleASE:ACE/EPAM 15.8-39.8 MeV'] })).toBe('model')
    expect(entryKind({ instruments: ['MODEL: REleASE:SOHO/EPHIN 28.2-50.1 MeV', 'SOHO: COSTEP 28.2-50.1 MeV'] })).toBe('observed')
    for (const e of [{ instruments: [] }, {}, { instruments: [' ', 5, null] }, { instruments: 'MODEL: x' }, null, 'x']) {
      expect(entryKind(e), JSON.stringify(e)).toBe('unlisted')
    }
    expect(entrySplit({ events: [{ instruments: ['MODEL: x'] }, { instruments: ['STEREO A: IMPACT 13-100 MeV'] }, {}] })).toEqual({
      total: 3,
      observed: 1,
      model: 1,
      unlisted: 1,
    })
    for (const d of [null, {}, { events: 'x' }, []]) expect(entrySplit(d), JSON.stringify(d)).toBeNull()
  })

  it('shows "N observed by instruments, M model forecasts" and that the snapshot-level provenance applies to the observed', () => {
    const split = entrySplit(donki.data)!
    const t = note(ready(donki))
    expect(t).toContain(`${split.observed} observed by instruments, ${split.model} model forecasts (${split.total} entries, counted from the file)`)
    expect(t).toContain(`The snapshot-level provenance (Measured) applies to the ${split.observed} observed entries;`)
    expect(t).toContain('a model forecast (instrument written “MODEL: …”) is a prediction, not a measurement.')
    expect(t).not.toContain('no instrument listed')
    const odd = { ...donki, data: { events: [...events, { sep_id: 'x', event_time: '2026-01-01T00:00:00Z', instruments: [] }] } }
    expect(note(ready(odd))).toContain(`${split.model} model forecasts, 1 with no instrument listed (${split.total + 1} entries`)
  })

  it('while the file loads or when it cannot be read, says so and prints no count', () => {
    expect(note({ status: 'loading', snapshot: null, data: null, error: null })).toBe('Counting the entries of swpc_sep_events.json…')
    const missing = note({ status: 'missing', snapshot: null, data: null, error: '/data/swpc_sep_events.json is not in this build' })
    expect(missing).toBe('Observed and model-forecast entries not counted: /data/swpc_sep_events.json is not in this build.')
    expect(note(ready({ ...donki, data: {} }))).toContain('not counted: swpc_sep_events.json has no list of entries')
  })

  it('the card itself carries the split (read at once; it is loading on a server render), other cards do not', () => {
    const card = (e: ManifestEntry) =>
      renderToStaticMarkup(createElement(SnapshotCard, { entry: e, citations: [], targeted: false, onJump: () => {} }))
    const html = card(entry)
    expect(html).toContain('class="lfd-split lfd-muted"')
    expect(text(html)).toContain('Counting the entries of swpc_sep_events.json…')
    // the split sits on the card, right under the provenance sentence, above the metadata and the expanders
    expect(html.indexOf('lfd-what')).toBeLessThan(html.indexOf('lfd-split'))
    expect(html.indexOf('lfd-split')).toBeLessThan(html.indexOf('lfd-meta'))
    const other = card(byId('swpc_spe_list'))
    expect(other).not.toContain('lfd-split')
  })
})
