// Layout contracts that jsdom cannot check are pinned by asserting on the real
// stylesheet: read `desktop/src/styles.css` and match one rule's declarations.
// Shared by the MCP / models / composer / card-head layout tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Source text of a repo file, resolved from this module rather than the cwd. */
export function sourceFile(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relPath}`, import.meta.url)), "utf8");
}

export const stylesCss = sourceFile("desktop/src/styles.css");

/** Declarations of the first rule whose selector is exactly `selector`. It must
 *  start its own line, so `.name[data-wrap]` or a longer descendant selector is
 *  never mistaken for `.name`. */
export function cssRule(selector: string, css: string = stylesCss): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{(?<body>[^}]*)\\}`, "m").exec(css);
  return match?.groups?.body ?? "";
}
