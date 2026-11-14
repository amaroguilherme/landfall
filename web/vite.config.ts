/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The browser engine imports the canonical rules from ../engine/rules and the
// conformance tests read ../engine/tests/vectors, so the repo root must be readable.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: [repoRoot] } },
  test: { include: ['src/**/*.test.ts'] },
})
