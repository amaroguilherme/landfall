/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

// The browser engine imports the canonical rules from ../engine/rules and the
// conformance tests read ../engine/tests/vectors, so the repo root must be readable.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Offline reloads (public/sw.js): once the build is written, list what the service worker precaches and
// write that list, plus a content hash that names the cache, into <outDir>/sw.js. Precached: index.html
// (as "/"), every JS and CSS chunk, every data/*.json, the favicon, and only the font faces the app
// renders (src/index.css "font budget"; any other face is cached the first time it is used online).
// Not precached: the other HDS faces and the HDS .usa-hero image, which no LANDFALL view uses.
const SW_PLACEHOLDER = '/*__LANDFALL_PRECACHE__*/ null'
const SW_FONTS = /^assets\/(Inter-(Regular|SemiBold|Italic)|PublicSans-Bold|DMMono-(Regular|Medium))-[\w-]+\.woff2$/
const swPrecached = (f: string) =>
  f === 'index.html' ||
  f === 'favicon.svg' ||
  /^assets\/[^/]+\.(js|css)$/.test(f) ||
  /^data\/[^/]+\.json$/.test(f) ||
  SW_FONTS.test(f)

function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  )
}

function swPrecache(): Plugin {
  let base = '/'
  let outDir = 'dist'
  let log = (msg: string) => console.log(msg)
  return {
    name: 'landfall:sw-precache',
    apply: 'build',
    configResolved(config) {
      base = config.base
      outDir = resolve(config.root, config.build.outDir)
      log = (msg) => config.logger.info(msg)
    },
    writeBundle(options) {
      const dir = options.dir ?? outDir
      const swPath = join(dir, 'sw.js')
      const template = existsSync(swPath) ? readFileSync(swPath, 'utf8') : ''
      if (!template.includes(SW_PLACEHOLDER)) this.error(`${swPath} is missing or lost its ${SW_PLACEHOLDER} marker`)
      const hash = createHash('sha256').update(template)
      const files: string[] = []
      let bytes = 0
      for (const f of filesUnder(dir).filter(swPrecached).sort()) {
        const url = f === 'index.html' ? base : base + f
        const body = readFileSync(join(dir, f))
        hash.update(`\0${url}\0`).update(body)
        bytes += body.length
        files.push(url)
      }
      const version = hash.digest('hex').slice(0, 12)
      writeFileSync(swPath, template.replace(SW_PLACEHOLDER, JSON.stringify({ version, bytes, files })))
      log(`sw.js: precache ${files.length} files, ${(bytes / 1e6).toFixed(2)} MB, cache landfall-${version}`)
    },
  }
}

export default defineConfig({
  plugins: [react(), swPrecache()],
  server: { fs: { allow: [repoRoot] } },
  test: { include: ['src/**/*.test.ts'] },
})
