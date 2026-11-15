// Minimal ambient type for the one node:crypto call in cuecard.test.ts (vitest runs it in Node). The app
// tsconfig loads only vite/client types (see src/engine/node-fs.d.ts for why @types/node stays out), so the
// test declares exactly what it uses: an independent SHA-256 to check the card's crypto.subtle digest.
declare module 'node:crypto' {
  interface Hash {
    update(data: string, inputEncoding: 'utf8'): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
}
