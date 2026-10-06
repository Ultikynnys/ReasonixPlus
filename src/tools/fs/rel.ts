import * as pathMod from "node:path";

/** Workspace-relative display path with forward slashes — stable across platforms for tool results and prefix hashing. A path outside the sandbox root (e.g. an approved outside-sandbox read, or a file a browser MCP wrote to its own cwd) renders as a misleading `../…` chain, so it is shown as an absolute path instead. */
export function displayRel(rootDir: string, full: string): string {
  const rel = pathMod.relative(rootDir, full);
  if (rel === ".." || rel.startsWith(`..${pathMod.sep}`)) return full.replaceAll("\\", "/");
  return rel.replaceAll("\\", "/");
}
