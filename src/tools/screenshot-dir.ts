/** Shared scratch location for tool-generated PNGs: the workspace when there is one,
 *  the OS temp directory otherwise. */

import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SCREENSHOTS_DIRNAME = ".reasonix/screenshots";

/** The directory screenshots go in, created if missing. Falls back to temp when the
 *  workspace directory cannot be made (read-only checkout, permissions). */
export function screenshotDir(rootDir: string | undefined): string {
  if (rootDir) {
    const workspace = join(rootDir, ".reasonix", "screenshots");
    try {
      mkdirSync(workspace, { recursive: true });
      return workspace;
    } catch {
      // Fall through to temp.
    }
  }
  const fallback = join(tmpdir(), "reasonix-screenshots");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** Delete `prefix*.png` beyond `maxFiles` or older than `maxAgeMs`, newest kept first. */
export function pruneScreenshots(
  dir: string,
  prefix: string,
  maxFiles = 30,
  maxAgeMs = 3 * 86400 * 1000,
): void {
  try {
    const now = Date.now();
    const files: Array<{ path: string; mtime: number }> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".png")) {
        continue;
      }
      const fullPath = join(dir, entry.name);
      try {
        files.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
      } catch {
        // Ignore transient stat errors
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      if (i < maxFiles && now - file.mtime <= maxAgeMs) continue;
      try {
        unlinkSync(file.path);
      } catch {
        // Ignore deletion error
      }
    }
  } catch {
    // Non-fatal if directory cannot be read
  }
}
