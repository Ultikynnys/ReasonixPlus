// Layout contracts that jsdom cannot check are pinned by asserting on the real
// stylesheet: read `desktop/src/styles.css` and match a rule's declarations.
// Shared by the MCP / models / composer / card-head layout tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Source text of a repo file, resolved from this module rather than the cwd. */
export function sourceFile(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relPath}`, import.meta.url)), "utf8");
}

export const stylesCss = sourceFile("desktop/src/styles.css");

/** Declarations of the first rule whose selector list holds exactly `selector`. */
export function cssRule(selector: string, css: string = stylesCss): string {
  return cssRules(selector, css)[0] ?? "";
}

/** Every rule whose selector list holds exactly `selector`, in source order: an
 *  element's declarations can be split over a shared block plus its own. */
export function cssRules(selector: string, css: string = stylesCss): string[] {
  // Comment text would otherwise be read as part of the next rule's selector.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  for (const rule of bare.matchAll(/^([^{}]+)\{([^}]*)\}/gm)) {
    const selectors = (rule[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) found.push(rule[2] ?? "");
  }
  return found;
}
