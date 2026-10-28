import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { writeSkillDir } from "./skill-fixture.js";

/** A Codex-layout plugin tree on disk: `.codex-plugin/plugin.json`, an `mcpServers` file
 *  and one `skills/<id>/SKILL.md` per id. Shared by the store, manifest and prompt tests
 *  so every fixture stays one shape. */
export interface PluginTreeOptions {
  name?: string;
  version?: string;
  /** Put the manifest at the repo root (Agent Plugins layout) instead of `.codex-plugin`. */
  rootManifest?: boolean;
  skills?: string[];
  /** Skip the MCP declaration entirely. */
  servers?: boolean;
}

export const FIXTURE_SKILLS = ["meta-ads", "seo-analysis", "wordpress"];

export function writePluginTree(dir: string, opts: PluginTreeOptions = {}): void {
  const manifest = {
    name: opts.name ?? "notfair",
    version: opts.version ?? "0.27.17",
    description: "Ads, analytics, SEO and GEO skills.",
    author: { name: "NotFair", url: "https://notfair.co" },
    skills: "./skills/",
    ...(opts.servers === false ? {} : { mcpServers: "./.mcp.json" }),
    interface: { displayName: "NotFair", category: "Productivity" },
  };
  const manifestDir = opts.rootManifest ? dir : join(dir, ".codex-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest), "utf8");
  if (opts.servers !== false) {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { NotFair: { type: "http", url: "https://notfair.co/api/mcp/notfair" } },
      }),
      "utf8",
    );
  }
  for (const skill of opts.skills ?? FIXTURE_SKILLS) {
    writeSkillDir(join(dir, "skills", skill), {
      name: skill,
      description: `Runs the ${skill} workflow.`,
    });
  }
}

/** A `copy` hook for `installPlugin` that clones a fixture tree into the store. The path
 *  is read lazily, so one hook covers every case in a file. */
export function copyTree(from: () => string): (source: { kind: string }, target: string) => void {
  return (source, target) => {
    if (source.kind !== "local") throw new Error("tests only install local fixtures");
    cpSync(from(), target, { recursive: true });
  };
}

/** Point every store at a temp home and config for the duration of a test. The daemon
 *  resolves its roots per call, so the stub must be in force before the first write. */
export function stubPluginHome(home: string, configPath: string): void {
  vi.stubEnv("REASONIX_CONFIG", configPath);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // CJS interop: an ESM namespace export cannot be spied on.
  vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
}
