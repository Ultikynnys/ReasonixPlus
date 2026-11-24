/** Canonical path to the Reasonix+ state directory: `~/.reasonix`. */

import * as os from "node:os";
import { join, parse, resolve } from "node:path";
import { relativeDisplayPath, toPosixPath } from "@reasonix/core-utils/path-utils";

/** The user's home directory, read from the environment first so tests and portable
 *  installs can re-home the store without fighting `os.homedir()`'s per-process cache. */
function currentHomeDir(): string {
  const env =
    process.platform === "win32"
      ? process.env.USERPROFILE?.trim() || process.env.HOME?.trim()
      : process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return env || os.homedir();
}

/** Canonical `~/.reasonix` state dir. `REASONIX_HOME` overrides the state directory
 *  itself; an explicit `homeDirOverride` stays a home directory. */
export function reasonixHome(homeDirOverride?: string): string {
  if (homeDirOverride) return join(homeDirOverride, ".reasonix");
  const configured = process.env.REASONIX_HOME?.trim();
  if (configured) return resolve(configured);
  return join(currentHomeDir(), ".reasonix");
}

/** True when `rootDir` can't anchor project state (empty, or a filesystem/drive
 *  root like `/` or `C:\`), so callers must fall back to the home state dir. */
export function isUnusableRootDir(rootDir: string): boolean {
  if (!rootDir) return true;
  const abs = resolve(rootDir);
  return abs === parse(abs).root;
}

/** The `.reasonix` state dir for a project root, or `~/.reasonix` when the root
 *  is unusable. Pass `name` to select a subdir (e.g. `"output-recovery"`). */
export function reasonixStateDir(rootDir: string, name?: string): string {
  const base = isUnusableRootDir(rootDir) ? reasonixHome() : join(resolve(rootDir), ".reasonix");
  return name ? join(base, name) : base;
}

/** Model-readable path for `absolute`: project-relative with forward slashes when
 *  `rootDir` is usable, otherwise the absolute path with forward slashes. */
export function projectRelativeDisplayPath(rootDir: string, absolute: string): string {
  if (isUnusableRootDir(rootDir)) return toPosixPath(absolute);
  return relativeDisplayPath(rootDir, absolute);
}
