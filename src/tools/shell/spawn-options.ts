/** Shared spawn options for shell children. */

import type { SpawnOptions } from "node:child_process";

/** Base options every shell child shares: no shell, no console window, and POSIX
 *  process-group detach (`detached`) so killProcessTree's neg-pid kill reaps the
 *  whole subtree — Windows leaves it off and uses `taskkill /T` instead. */
export function baseSpawnOptions(cwd?: string): SpawnOptions {
  return {
    cwd,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  };
}
