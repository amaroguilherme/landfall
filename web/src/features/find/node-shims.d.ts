// Minimal ambient types for the binary node:fs and node:crypto calls of this folder's tests (vitest runs them in
// Node). The app tsconfig loads only vite/client types (see src/engine/node-fs.d.ts for why @types/node stays out),
// so these declare exactly the overloads the tests use; they merge with src/engine/node-fs.d.ts and
// src/features/cuecard/node-crypto.d.ts.
declare module 'node:fs' {
  export function readFileSync(path: URL | string): Uint8Array
}
declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array): Hash
  }
}
