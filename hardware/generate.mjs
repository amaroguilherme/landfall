// Regenerates hardware/sensor-map.md and hardware/BOM.csv from hardware/sensor-map.json.
// Usage (from the repo root): node hardware/generate.mjs        (Node >= 23.6: strips TS types)
// The renderers live in web/src/features/band/render.ts so the #/band view, these files and the
// sync test (web/src/features/band/band.test.ts) share one implementation.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBomCsv, renderMarkdown } from '../web/src/features/band/render.ts'

const here = dirname(fileURLToPath(import.meta.url))
const map = JSON.parse(readFileSync(join(here, 'sensor-map.json'), 'utf8'))

writeFileSync(join(here, 'BOM.csv'), renderBomCsv(map))
writeFileSync(join(here, 'sensor-map.md'), renderMarkdown(map))
console.log(`wrote BOM.csv (${map.blocks.length} parts) and sensor-map.md from sensor-map.json`)
