// Minimal ambient types for the two node:fs calls in conformance.test.ts (which runs under vitest
// in Node). The app tsconfig loads only vite/client types; adding @types/node to the whole browser
// program would retype globals such as setTimeout for every other module, so the test declares
// exactly what it uses instead.
declare module 'node:fs' {
  export function readdirSync(path: URL | string): string[]
  export function readFileSync(path: URL | string, encoding: 'utf8'): string
}
