/** Codex plugin manifest (`.codex-plugin/plugin.json`), with the Agent Plugins root
 *  `plugin.json` accepted as a fallback for host-agnostic repositories. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "@reasonix/core-utils";
import { z } from "zod";
import { storeSlug } from "../install/source.js";
import { DEFAULT_SKILLS_DIR } from "../skills/skill.js";

export const CODEX_MANIFEST_DIR = ".codex-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";
/** Agent Plugins 1.0 host key whose `interface` block carries display metadata. */
export const OPENAI_EXTENSION_KEY = "com.openai";

const authorSchema = z.union([
  z.string(),
  z.object({ name: z.string().optional(), url: z.string().optional() }),
]);

const interfaceSchema = z.object({
  displayName: z.string().optional(),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  developerName: z.string().optional(),
  category: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  defaultPrompt: z.array(z.string()).optional(),
  brandColor: z.string().optional(),
  logo: z.string().optional(),
  websiteURL: z.string().optional(),
  privacyPolicyURL: z.string().optional(),
  termsOfServiceURL: z.string().optional(),
  supportURL: z.string().optional(),
});

const manifestSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  mcpServers: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  interface: interfaceSchema.optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export interface PluginInterface {
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  developerName?: string;
  /** Marketplace category ("Productivity", "Developer Tools", ...). */
  category?: string;
  capabilities?: string[];
  defaultPrompt?: string[];
  brandColor?: string;
  logo?: string;
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  supportURL?: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  authorName?: string;
  authorUrl?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords: string[];
  /** Declared skill paths relative to the plugin directory, forward-slashed. Each is read as
   *  a collection of skill directories or as one skill directory; see `indexPluginSkills`. */
  skillsDirs: string[];
  /** Manifest-declared MCP file (relative to the plugin directory), when it names one. */
  mcpServersFile?: string;
  /** MCP servers declared inline in the manifest instead of in a file. */
  inlineMcpServers?: Record<string, unknown>;
  ui: PluginInterface;
  /** Manifest file this metadata came from. */
  manifestPath: string;
}

/** Directory name and config key for a plugin: lowercase, dash-separated. */
export function pluginSlug(name: string): string {
  return storeSlug(name) || "plugin";
}

/** Name to show for a plugin: its declared display name, else the manifest name. */
export function pluginDisplayName(manifest: Pick<PluginManifest, "name" | "ui">): string {
  const declared = manifest.ui.displayName?.trim();
  return declared ? declared : manifest.name;
}

/** Placeholder for a plugin whose manifest cannot be read: enough identity to list and
 *  remove it, nothing that could be mistaken for declared metadata. */
export function unreadablePluginManifest(slug: string): PluginManifest {
  return { name: slug, keywords: [], skillsDirs: [], ui: {}, manifestPath: "" };
}

/** Normalize a manifest-relative path and refuse one that escapes the plugin directory. */
export function resolvePluginRelativePath(value: string, what: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`${what} must be a relative path inside the plugin: ${value}`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`${what} must not leave the plugin directory: ${value}`);
  }
  return normalized;
}

function mergeDefined<T extends object>(base: T, override: T): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function extensionInterface(extensions: Record<string, unknown> | undefined): PluginInterface {
  const block = extensions?.[OPENAI_EXTENSION_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const parsed = interfaceSchema.safeParse((block as Record<string, unknown>).interface);
  return parsed.success ? parsed.data : {};
}

function skillsDirsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [DEFAULT_SKILLS_DIR];
  const declared = (Array.isArray(value) ? value : [value])
    .map((entry) => resolvePluginRelativePath(entry, "skills"))
    .filter((entry) => entry.length > 0);
  return declared.length > 0 ? [...new Set(declared)] : [DEFAULT_SKILLS_DIR];
}

/** Validate one manifest document. `manifestPath` names it in error messages. */
export function parsePluginManifest(
  raw: unknown,
  manifestPath = PLUGIN_MANIFEST_FILE,
): PluginManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "manifest";
    throw new Error(`${manifestPath}: ${where} - ${issue?.message ?? "invalid plugin manifest"}`);
  }
  const data = parsed.data;
  const author = data.author;
  const mcpServers = data.mcpServers;
  return {
    name: data.name,
    version: data.version,
    description: data.description,
    authorName: typeof author === "string" ? author : author?.name,
    authorUrl: typeof author === "string" ? undefined : author?.url,
    homepage: data.homepage,
    repository: data.repository,
    license: data.license,
    keywords: data.keywords ?? [],
    skillsDirs: skillsDirsOf(data.skills),
    mcpServersFile:
      typeof mcpServers === "string"
        ? resolvePluginRelativePath(mcpServers, "mcpServers")
        : undefined,
    inlineMcpServers:
      mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)
        ? mcpServers
        : undefined,
    ui: mergeDefined(extensionInterface(data.extensions), data.interface ?? {}),
    manifestPath,
  };
}

/** First manifest file present in `rootDir`, Codex layout first. */
export function pluginManifestPath(rootDir: string): string | null {
  for (const relative of [join(CODEX_MANIFEST_DIR, PLUGIN_MANIFEST_FILE), PLUGIN_MANIFEST_FILE]) {
    const candidate = join(rootDir, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function readPluginManifest(rootDir: string): PluginManifest {
  const path = pluginManifestPath(rootDir);
  if (!path) {
    throw new Error(
      `no ${join(CODEX_MANIFEST_DIR, PLUGIN_MANIFEST_FILE)} or ${PLUGIN_MANIFEST_FILE} in ${rootDir}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(`${path}: ${messageOf(err)}`);
  }
  return parsePluginManifest(raw, path);
}
