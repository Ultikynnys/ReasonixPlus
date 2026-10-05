/** Canonical path to the Reasonix+ state directory: `~/.reasonix`. */

import { homedir } from "node:os";
import { join, parse, relative, resolve } from "node:path";

/** Returns `~/.reasonix` — the single source of truth for the Reasonix+ state directory. */
export function reasonixHome(homeDirOverride?: string): string {
  return join(homeDirOverride ?? homedir(), ".reasonix");
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
  if (isUnusableRootDir(rootDir)) return absolute.replaceAll("\\", "/");
  return relative(resolve(rootDir), absolute).replaceAll("\\", "/");
}
