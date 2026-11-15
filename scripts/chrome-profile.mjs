// A throwaway headless-Chrome profile that is deleted on every exit path (no dependencies).
// shot.mjs, qa-mobile.mjs, qa-offline.mjs and print-card.mjs each made a fresh --user-data-dir in $TMPDIR and
// never removed it; about 1,500 of them (40-220 MB each) filled the disk on 15 Nov. Most of a profile's size
// was component-updater downloads (models, revocation lists, Safe Browsing), which QUIET_FLAGS switch off.
// The pages under test, their service worker and their caches are unaffected.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const QUIET_FLAGS = ['--disable-component-update', '--disable-background-networking', '--no-first-run', '--no-default-browser-check']

/**
 * Make a profile dir. `flags` holds --user-data-dir plus QUIET_FLAGS; pass the spawned Chrome to `own()` so the
 * exit hook kills it before deleting the dir (also on Ctrl-C and on an uncaught error).
 */
export function tempProfile(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  let proc = null
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) // 'exit' handlers are sync
  process.once('exit', () => {
    try { proc?.kill('SIGKILL') } catch { /* already gone */ }
    for (let i = 0; i < 20; i++) {
      try { rmSync(dir, { recursive: true, force: true }); return } catch { pause(150) } // helpers may still be flushing
    }
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(130))
  return { dir, flags: [`--user-data-dir=${dir}`, ...QUIET_FLAGS], own: (p) => (proc = p) }
}
