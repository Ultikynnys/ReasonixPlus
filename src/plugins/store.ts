/** Agent plugin store: install, list and remove Codex-layout plugins under
 *  `~/.reasonix/plugins`, keeping their MCP entries and read access in step. */

import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type McpServerConfig,
  type PluginRecord,
  type ReasonixConfig,
  addGlobalPathAllowed,
  readConfig,
  removeGlobalPathAllowed,
  writeConfig,
} from "../config.js";
import { reasonixHome } from "../reasonix-home.js";
import {
  type PluginManifest,
  pluginSlug,
  readPluginManifest,
  unreadablePluginManifest,
} from "./manifest.js";
import { pluginServerConfigs } from "./servers.js";
import { type PluginSkill, indexPluginSkills } from "./skills.js";

/** Clone budget: a plugin repository is small, but a cold clone on a slow link is not. */
const CLONE_TIMEOUT_MS = 180_000;
/** Local installs never carry build output or VCS history into the plugin store. */
const LOCAL_COPY_SKIP = new Set([".git", "node_modules", ".turbo", "dist", "coverage"]);

export type NormalizedPluginSource =
  | { kind: "git"; url: string; label: string }
  | { kind: "local"; path: string; label: string };

/** Accept `owner/repo`, any git URL, or an existing local directory. */
export function normalizePluginSource(source: string): NormalizedPluginSource {
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

export type PluginCopy = (source: NormalizedPluginSource, target: string) => void | Promise<void>;

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

async function defaultCopy(source: NormalizedPluginSource, target: string): Promise<void> {
  if (source.kind === "local") {
    cpSync(source.path, target, {
      recursive: true,
      filter: (from) => !LOCAL_COPY_SKIP.has(from.split(/[\\/]/).pop() ?? ""),
    });
    return;
  }
  await gitClone(source, target);
}

export function pluginsRoot(homeDir?: string): string {
  return join(reasonixHome(homeDir), "plugins");
}

/** One installed plugin as the store sees it: manifest, skills and MCP entries.
 *  Enablement is a session capability, so it is deliberately absent here. */
export interface PluginState {
  slug: string;
  dir: string;
  manifest: PluginManifest;
  skills: PluginSkill[];
  /** Config entries this plugin owns, keyed by namespaced server name. */
  servers: Record<string, McpServerConfig>;
  record: PluginRecord | undefined;
  /** Set when the manifest or its MCP file could not be read. */
  error?: string;
}

function stateOf(slug: string, dir: string, record: PluginRecord | undefined): PluginState | null {
  let manifest: PluginManifest;
  try {
    manifest = readPluginManifest(dir);
  } catch (err) {
    return {
      slug,
      dir,
      manifest: unreadablePluginManifest(slug),
      skills: [],
      servers: {},
      record,
      error: (err as Error).message,
    };
  }
  let servers: Record<string, McpServerConfig> = {};
  let error: string | undefined;
  try {
    servers = pluginServerConfigs(dir, manifest);
  } catch (err) {
    error = (err as Error).message;
  }
  return {
    slug,
    dir,
    manifest,
    skills: indexPluginSkills(dir, manifest),
    servers,
    record,
    ...(error ? { error } : {}),
  };
}

export interface PluginLookupOptions {
  homeDir?: string;
  /** Config already loaded by a caller that is mid-write (install/uninstall). */
  cfg?: ReasonixConfig;
  /** Config file to read when no `cfg` is supplied. */
  configPath?: string;
  /** Restrict the scan to these slugs, so a lookup never reads unrelated manifests. */
  only?: readonly string[];
}

function configOf(opts: PluginLookupOptions): ReasonixConfig {
  return opts.cfg ?? readConfig(opts.configPath);
}

/** Slugs with an installed directory, sorted. Unreadable entries are skipped. */
function installedSlugs(root: string, only?: readonly string[]): string[] {
  if (only) return [...new Set(only)].filter((slug) => slug && !slug.startsWith(".")).sort();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

/** Every plugin on disk, sorted by slug. Records the store no longer knows are ignored. */
export function listPlugins(opts: PluginLookupOptions = {}): PluginState[] {
  const cfg = configOf(opts);
  const root = pluginsRoot(opts.homeDir);
  const states: PluginState[] = [];
  for (const name of installedSlugs(root, opts.only)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const state = stateOf(name, dir, cfg.plugins?.[name]);
    if (state) states.push(state);
  }
  return states;
}

function stableServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.keys(servers)
      .sort()
      .map((key) => [key, servers[key]!]),
  );
}

/** Rewrite every plugin-owned MCP entry from `states`, dropping entries whose plugin is
 *  gone. Returns true when it wrote. */
export function syncPluginServers(cfg: ReasonixConfig, states: readonly PluginState[]): boolean {
  const current = cfg.mcpServers ?? {};
  const owned = new Set(states.map((state) => state.slug));
  const next: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(current)) {
    if (!entry.plugin) next[name] = entry;
    else if (!owned.has(entry.plugin)) continue;
  }
  for (const state of states) {
    for (const [name, entry] of Object.entries(stableServers(state.servers))) {
      next[name] = entry;
    }
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  cfg.mcpServers = Object.keys(next).length > 0 ? next : undefined;
  return true;
}

export interface PluginStoreOptions {
  homeDir?: string;
  configPath?: string;
  /** Injectable transfer step so tests never shell out to git. */
  copy?: PluginCopy;
}

export interface InstalledPlugin {
  slug: string;
  dir: string;
  manifest: PluginManifest;
}

/** One skill plus the plugin it came from — what a session's index is built of. */
export type OwnedPluginSkill = PluginSkill & { plugin: string };

/** Clone/copy a plugin into the store, validate its manifest, and record it. A failure
 *  after the move undoes the move, so an install either lands whole or not at all. */
export async function installPlugin(
  source: string,
  opts: PluginStoreOptions = {},
): Promise<InstalledPlugin> {
  const normalized = normalizePluginSource(source);
  const cfg = readConfig(opts.configPath);
  const root = pluginsRoot(opts.homeDir);
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, ".staging-"));
  let moved: string | undefined;
  try {
    await (opts.copy ?? defaultCopy)(normalized, staging);
    const manifest = readPluginManifest(staging);
    const slug = pluginSlug(manifest.name);
    const dir = join(root, slug);
    if (existsSync(dir)) {
      throw new Error(`${manifest.name} is already installed at ${dir}`);
    }
    renameSync(staging, dir);
    moved = dir;
    cfg.plugins = {
      ...(cfg.plugins ?? {}),
      [slug]: {
        source: normalized.label,
        ...(manifest.version ? { version: manifest.version } : {}),
        installedAt: Date.now(),
      },
    };
    syncPluginServers(cfg, listPlugins({ homeDir: opts.homeDir, cfg }));
    writeConfig(cfg, opts.configPath);
    addGlobalPathAllowed(dir, opts.configPath);
    return { slug, dir, manifest };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    if (moved) rmSync(moved, { recursive: true, force: true });
    throw err;
  }
}

/** Remove a plugin: its files, its config record, its MCP entries and its read grant.
 *  The read grant is always revoked, so a failed config write cannot leave a plugin
 *  readable after its files are gone. */
export function uninstallPlugin(slug: string, opts: PluginStoreOptions = {}): void {
  const cfg = readConfig(opts.configPath);
  const dir = join(pluginsRoot(opts.homeDir), slug);
  if (!existsSync(dir) && !cfg.plugins?.[slug]) {
    throw new Error(`${slug} is not installed`);
  }
  rmSync(dir, { recursive: true, force: true });
  try {
    if (cfg.plugins) {
      const remaining = Object.entries(cfg.plugins).filter(([key]) => key !== slug);
      cfg.plugins = remaining.length > 0 ? Object.fromEntries(remaining) : undefined;
    }
    syncPluginServers(cfg, listPlugins({ homeDir: opts.homeDir, cfg }));
    writeConfig(cfg, opts.configPath);
  } finally {
    removeGlobalPathAllowed(dir, opts.configPath);
  }
}

/** Skills a session's frozen plugin set contributes, in slug order. Only the chosen
 *  plugins' manifests are read, so an unrelated broken plugin cannot affect a prompt. */
export function pluginSkills(
  opts: PluginLookupOptions & { only: readonly string[] },
): OwnedPluginSkill[] {
  return listPlugins(opts).flatMap((state) =>
    state.skills.map((skill) => ({ ...skill, plugin: state.slug })),
  );
}
