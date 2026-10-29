/** Fetching an install source into a staging directory: one clone budget, one local-copy
 *  skip list and one source grammar, shared by the plugin store and the skill store. */

import { execFile } from "node:child_process";
import { cpSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Clone budget: an install source is small, but a cold clone on a slow link is not. */
const CLONE_TIMEOUT_MS = 180_000;
/** Directories an install never carries into a store: VCS history, build output, and the
 *  dependency trees a skill or plugin never needs. The one list both the local copy and a
 *  store's tree scan skip, so neither can inspect what the other dropped. */
export const INSTALL_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".turbo",
  "dist",
  "coverage",
]);

export type InstallSource =
  | { kind: "git"; url: string; label: string }
  | { kind: "local"; path: string; label: string };

export type InstallCopy = (source: InstallSource, target: string) => void | Promise<void>;

/** Accept `owner/repo`, any git URL, or an existing local directory. */
export function normalizeInstallSource(source: string): InstallSource {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("enter a git URL, owner/repo, or a local directory");
  const local = resolve(trimmed);
  if (existsSync(local)) {
    if (statSync(local).isDirectory()) return { kind: "local", path: local, label: local };
    throw new Error(`not a directory: ${local}`);
  }
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(trimmed)) {
    return { kind: "git", url: trimmed, label: trimmed.replace(/\.git$/i, "") };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return {
      kind: "git",
      url: `https://github.com/${trimmed}.git`,
      label: `https://github.com/${trimmed}`,
    };
  }
  throw new Error(`not a git URL, owner/repo, or an existing directory: ${trimmed}`);
}

/** Clone without blocking the daemon's event loop: a remote install can take a while. */
function gitClone(source: { url: string; label: string }, target: string): Promise<void> {
  return new Promise((resolveClone, rejectClone) => {
    execFile(
      "git",
      ["clone", "--depth", "1", "--quiet", source.url, target],
      { timeout: CLONE_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) {
          resolveClone();
          return;
        }
        const reason = stderr.trim() || err.message;
        rejectClone(new Error(`git clone failed for ${source.label}: ${reason}`));
      },
    );
  });
}

/** Lowercase, dash-separated store directory name. Empty when nothing usable remains, so
 *  each store can supply its own fallback key. */
export function storeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Whether a name may key a store directory: one path segment, no traversal, no dotfile. */
export function isSafeStoreId(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(name.toLowerCase());
}

export async function copyInstallSource(source: InstallSource, target: string): Promise<void> {
  if (source.kind === "local") {
    cpSync(source.path, target, {
      recursive: true,
      filter: (from) => !INSTALL_SKIP_DIRS.has(from.split(/[\\/]/).pop() ?? ""),
    });
    return;
  }
  await gitClone(source, target);
}
