// The sensor map, bundled at build time from the repo's hardware/ folder (the single source of
// truth; the view never fetches it). A missing or renamed file fails the build on purpose.
import raw from '../../../../hardware/sensor-map.json'
import type { Block, HandOff, SensorMap } from './types'

export const SENSOR_MAP = raw as unknown as SensorMap

export const BLOCKS: readonly Block[] = SENSOR_MAP.blocks
export const HAND_OFFS: readonly HandOff[] = SENSOR_MAP.not_measurable_here

export function blockById(id: string): Block | undefined {
  return BLOCKS.find((b) => b.id === id)
}

export function handOffById(id: string): HandOff | undefined {
  return HAND_OFFS.find((h) => h.id === id)
}

/** Snapshot ids referenced anywhere in the map (for freshness chips in the footer). */
export function referencedSnapshots(map: SensorMap = SENSOR_MAP): string[] {
  const ids = new Set<string>()
  const add = (s?: string | null) => {
    if (s) ids.add(s)
  }
  for (const a of map.anchors) add(a.snapshot)
  for (const b of map.blocks) for (const r of b.justified_by) add(r.snapshot)
  for (const h of map.not_measurable_here) {
    add(h.requirement?.snapshot)
    for (const e of h.examples ?? []) add(e.snapshot)
  }
  for (const n of map.negatives) add(n.snapshot)
  for (const s of map.safety) add(s.snapshot)
  return [...ids].sort()
}
