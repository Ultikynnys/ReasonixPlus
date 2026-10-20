import { LruCache } from "./cache";

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\");
}

/** Grouping re-normalizes the same handful of workspace dirs many times per
 *  render, so the regex work is cached (and bounded, in case dirs churn). */
const normalizedPaths = new LruCache<string, string>(2000);

/** Compare workspace dirs across separator flavor and trailing slashes.
 *  Windows drive/UNC paths are case-insensitive; POSIX paths are not. */
export function normalizeWorkspacePath(path?: string): string {
  const raw = path ?? "";
  const cached = normalizedPaths.get(raw);
  if (cached !== undefined) return cached;
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  const windowsPath =
    raw.includes("\\") || /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  const value = windowsPath ? normalized.toLowerCase() : normalized;
  normalizedPaths.set(raw, value);
  return value;
}

function normalizeForComparison(path: string): string {
  return normalizeWorkspacePath(path);
}

/** Resolve a workspace-relative path while preserving the workspace platform's separator. */
export function toWorkspaceAbsolute(path: string, workspaceDir?: string): string {
  if (
    !workspaceDir ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith("/") ||
    path.startsWith("\\")
  ) {
    return path;
  }
  const windows = isWindowsPath(workspaceDir);
  const separator = windows ? "\\" : "/";
  const base = workspaceDir.replace(/[\\/]+$/, "");
  const relative = path.replace(/^[\\/]+/, "").replace(/[\\/]/g, separator);
  return `${base}${separator}${relative}`;
}

/** Return a workspace-relative path only when the target is at or below the workspace boundary. */
export function toWorkspaceRelative(path: string, workspaceDir?: string): string {
  if (!workspaceDir) return path.replace(/\\/g, "/");
  const target = path.replace(/\\/g, "/");
  const workspace = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const targetComparable = normalizeForComparison(path);
  const workspaceComparable = normalizeForComparison(workspaceDir);
  if (targetComparable === workspaceComparable) return ".";
  if (!targetComparable.startsWith(`${workspaceComparable}/`)) return target;
  return target.slice(workspace.length).replace(/^\/+/, "") || ".";
}
