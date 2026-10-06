/** Hardcoded tooling contract for @playwright/mcp servers:
 *  bootstrap + upgrade a durable driver + AGENTS.md pair, and surface the duty to agents. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordDiagnostic } from "../diagnostics.js";
import { reasonixHome } from "../reasonix-home.js";
import type { McpServerSpec } from "./spec.js";

export const PLAYWRIGHT_TOOLING_VERSION = 3;
const STAMP_RE = /playwright-tooling-version:\s*(\d+)/g;
const PLATFORM_BEGIN = "<!-- platform:begin";
const PLATFORM_END = "<!-- platform:end -->";

const DRIVER_FILE = "driver.mjs";
const AGENTS_FILE = "AGENTS.md";

export function isPlaywrightSpec(spec: McpServerSpec): boolean {
  if (spec.transport !== "stdio") return false;
  return spec.args.some((arg) => /(?:^|[\\/])@playwright[\\/]mcp(?:@|$)/.test(arg));
}

export interface PlaywrightToolingPaths {
  dir: string;
  driverPath: string;
  agentsPath: string;
}

export type PlaywrightToolingStatus = PlaywrightToolingPaths & {
  ok: true;
  created: string[];
  upgraded: string[];
};

export type PlaywrightToolingResult = (
  | PlaywrightToolingStatus
  | (PlaywrightToolingPaths & { ok: false; error: string })
) & {
  /** The dir always has a concrete path — the agent-facing notice uses it even on failure. */
};

/** Template lookup mirrors the tokenizer-data pattern: ESM candidates for
 *  dist root / dist/cli / src layouts + package-root fallback. Bundled in `data/`. */
export function resolvePlaywrightTemplatePath(file: string): string {
  const rel = join("tooling", "playwright", file);
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "data", rel));
    candidates.push(join(here, "..", "..", "data", rel));
    candidates.push(join(here, "..", "..", "..", "data", rel));
  } catch {
    /* import.meta.url unavailable — package resolution still applies. */
  }
  try {
    const req = createRequire(import.meta.url);
    candidates.push(join(dirname(req.resolve("reasonix/package.json")), "data", rel));
  } catch {
    /* Not installed as `reasonix/` — earlier candidates still may hit. */
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Nothing exists — return the first candidate so readFileSync surfaces a
  // concrete path in the ENOENT message instead of a silent miss.
  return candidates[0] ?? rel;
}

/** Exposed for tests — clears the default-path memo. */
export function _resetForTests(): void {
  memoizedDefault = null;
}

function readBundledTemplate(file: string): string {
  return readFileSync(resolvePlaywrightTemplatePath(file), "utf8");
}

function stampOf(content: string): number | null {
  // LAST match wins: after a section refresh the superseded pre-marker stamp
  // may linger above the platform block — the in-section stamp is current.
  const matches = [...content.slice(0, 1024).matchAll(STAMP_RE)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1]![1]);
}

/** Create-or-upgrade the global tooling pair, never clobbering agent content:
 *  driver.mjs is machine-managed (overwritten on version diff); AGENTS.md only
 *  refreshes its platform section — unmarked files are staged alongside. */
export function ensurePlaywrightTooling(
  opts: { homeDir?: string; templateDir?: string } = {},
): PlaywrightToolingResult {
  // Memoize the default-path call — the desktop daemon bridges the playwright
  // server repeatedly (connect, reconnect, hot-add) and the bootstrap must not
  // pay fs work (or re-log upgrades) every time. Explicit overrides (tests)
  // bypass the memo so isolated tmp homes stay isolated.
  if (!opts.homeDir && !opts.templateDir) {
    if (memoizedDefault) return memoizedDefault;
    memoizedDefault = ensurePlaywrightToolingUncached(opts);
    return memoizedDefault;
  }
  return ensurePlaywrightToolingUncached(opts);
}

let memoizedDefault: PlaywrightToolingResult | null = null;

function ensurePlaywrightToolingUncached(
  opts: { homeDir?: string; templateDir?: string } = {},
): PlaywrightToolingResult {
  const dir = join(reasonixHome(opts.homeDir), "tools", "playwright");
  const driverPath = join(dir, DRIVER_FILE);
  const agentsPath = join(dir, AGENTS_FILE);
  const paths = { dir, driverPath, agentsPath };
  const created: string[] = [];
  const upgraded: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });

    const bundledDriver = readBundledTemplate(DRIVER_FILE);
    const bundledAgents = readBundledTemplate(AGENTS_FILE);
    const bundledStamp = stampOf(bundledDriver) ?? PLAYWRIGHT_TOOLING_VERSION;

    if (!existsSync(driverPath)) {
      writeFileSync(driverPath, bundledDriver, "utf8");
      created.push(DRIVER_FILE);
    } else {
      const onDisk = stampOf(readFileSync(driverPath, "utf8"));
      if (onDisk === null || onDisk < bundledStamp) {
        writeFileSync(driverPath, bundledDriver, "utf8");
        upgraded.push(DRIVER_FILE);
      }
    }

    if (!existsSync(agentsPath)) {
      writeFileSync(agentsPath, bundledAgents, "utf8");
      created.push(AGENTS_FILE);
    } else {
      const onDisk = readFileSync(agentsPath, "utf8");
      const onDiskStamp = stampOf(onDisk);
      if (onDiskStamp === null) {
        // Agent-owned file without platform markers — never clobber; stage
        // the newest platform section alongside so the agent can merge.
        const latest = join(dir, "AGENTS.md.platform-latest.md");
        writeFileSync(latest, bundledAgents, "utf8");
        upgraded.push("AGENTS.md.platform-latest.md");
      } else if (onDiskStamp < bundledStamp) {
        const begin = onDisk.indexOf(PLATFORM_BEGIN);
        const end = onDisk.indexOf(PLATFORM_END);
        if (begin !== -1 && end !== -1 && end > begin) {
          // Drop superseded stamps that sit above the platform section so the
          // refreshed in-section stamp is the only one (keeps upgrades one-shot).
          const head = onDisk
            .slice(0, begin)
            .replace(/<!-- playwright-tooling-version: \d+ -->\n?/g, "");
          const merged = `${head}${bundledAgents.slice(bundledAgents.indexOf(PLATFORM_BEGIN), bundledAgents.indexOf(PLATFORM_END) + PLATFORM_END.length)}${onDisk.slice(end)}`;
          writeFileSync(agentsPath, merged, "utf8");
        } else {
          writeFileSync(agentsPath, bundledAgents, "utf8");
        }
        upgraded.push(AGENTS_FILE);
      }
    }
    return { ok: true, dir, driverPath, agentsPath, created, upgraded };
  } catch (err) {
    const error = (err as Error).message;
    recordDiagnostic("playwright.tooling.bootstrap_failed", { level: "error", message: error });
    return { ok: false, error, ...paths };
  }
}

/** Agent-facing duty text injected into the first tool result of a bridged
 *  Playwright session: every agent driving a supported browser sees it. */
export function playwrightToolingNotice(status: PlaywrightToolingResult): string {
  const base = `[reasonix playwright tooling] The durable driver + docs for this tool family live at ${status.dir} (driver.mjs + AGENTS.md). Hard requirements: (1) read AGENTS.md before first use; (2) the server persists across invocations: drive batch flows through it (\`node <dir>/driver.mjs seq <steps.json>\`), never one-off spawns; (3) if tooling you need is missing, create it there; (4) if existing tooling needs changes, modify it in place; (5) after any change, keep AGENTS.md in that folder updated so future agents find the current state.`;
  if (status.ok) return base;
  return `${base} NOTE: bootstrap failed (${status.error}): create the folder per the bundled template before relying on it.`;
}

/** Compact per-tool description pointer — unmissable in any tool listing. */
export function playwrightDescriptionSuffix(status: PlaywrightToolingResult): string {
  return `Tooling: ${status.dir} (driver.mjs, AGENTS.md: read + keep updated).`;
}

/** Playwright's default output dir (relative to the server cwd) for auto-named
 *  artifacts; explicit `filename`s resolve straight against the server cwd. */
const PLAYWRIGHT_OUTPUT_SUBDIR = ".playwright-mcp";

/** File-ish tokens a Playwright result may reference: markdown-link targets and
 *  bare names with a known download/artifact extension (screenshots, PDFs, CSVs…).
 *  Unicode-aware so non-ASCII download names (e.g. `Käyttötili-….csv`) still match. */
const PLAYWRIGHT_FILE_RE =
  /(?:[A-Za-z]:[\\/]|\\\\|\.{0,2}[\\/]|[\p{L}\p{N}_])[\p{L}\p{N}_@.\-\\/]*\.(?:pdf|png|jpe?g|webp|gif|bmp|svg|ya?ml|json|txt|log|md|csv|tsv|xml|html?|xlsx?|docx?|pptx?|zip|gz|tar|har|mp3|mp4|mov|wav|webm)\b/giu;

/** Absolute locations under which Playwright may have written a reported path, in
 *  preference order. Empty for URLs / non-file tokens. A leading / or \ is POSIX-style
 *  in the report, so it is treated as cwd-relative, not drive-root-absolute. */
function playwrightPathCandidates(value: string, cwd: string | undefined): string[] {
  const cleaned = value.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!cleaned || cleaned.includes("://") || cleaned.startsWith("//")) return [];
  if (/^(?:data|mailto|blob):/i.test(cleaned)) return [];
  if (/^[A-Za-z]:[\\/]/.test(cleaned) || /^\\\\/.test(cleaned)) return [cleaned];
  if (!cwd) return isAbsolute(cleaned) ? [cleaned] : [];
  const rel = cleaned.replace(/^[\\/]+/, "");
  return [resolve(cwd, rel), resolve(cwd, PLAYWRIGHT_OUTPUT_SUBDIR, rel)];
}

/** Absolute on-disk location(s) of files a Playwright call wrote: the `filename`
 *  argument plus any file path in the result, resolved against the server cwd. An
 *  explicit filename's expected path is named even before the file exists. */
export function playwrightWriteLocationNote(
  args: Record<string, unknown> | undefined,
  resultText: string,
  cwd: string | undefined,
): string {
  const filename = args?.filename;
  const argValue = typeof filename === "string" ? filename.trim() : "";
  const candidates = new Set<string>();
  if (argValue) candidates.add(argValue);
  for (const match of resultText.matchAll(PLAYWRIGHT_FILE_RE)) candidates.add(match[0]);

  const found = new Set<string>();
  for (const candidate of candidates) {
    const hit = playwrightPathCandidates(candidate, cwd).find((p) => existsSync(p));
    if (hit) found.add(hit);
  }
  const base = cwd ? ` (Playwright writes relative to its server cwd ${cwd})` : "";
  if (found.size > 0) return `[wrote] ${[...found].slice(0, 10).join(", ")}${base}`;
  // Nothing on disk yet: for an explicit filename, still name the expected path.
  const expected = argValue ? playwrightPathCandidates(argValue, cwd)[0] : undefined;
  if (!expected) return "";
  return `[wrote] ${expected} (expected; not found on disk)${base}`;
}
