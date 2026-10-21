import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A per-test job workspace in the OS temp dir. */
export function makeJobDir(): string {
  return mkdtempSync(join(tmpdir(), "reasonix-job-"));
}

/** Windows sometimes holds the cwd handle for a few ms after the child exits.
 *  Retry briefly so a lost cause does not fail the suite. */
export async function disposeJobDir(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Poll until `cond` holds or `timeoutMs` elapses. */
export async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}
