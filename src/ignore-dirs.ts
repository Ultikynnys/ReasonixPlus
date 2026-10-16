/** Directory names never worth traversing in any walk (VCS metadata, deps,
 *  build output, caches). Picker + index both extend this shared base. */
export const COMMON_IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".cache",
  "target",
  ".venv",
  "venv",
  "__pycache__",
] as const;
