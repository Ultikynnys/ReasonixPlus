/** Agent plugin store: install, list and remove Codex-layout plugins under
 *  `~/.reasonix/plugins`, keeping their MCP entries and read access in step. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  type McpServerConfig,
  type PluginRecord,
  type ReasonixConfig,
  addGlobalPathAllowed,
  readConfig,
  removeGlobalPathAllowed,
  writeConfig,
} from "../config.js";
import {
  type InstallCopy,
  copyInstallSource,
  isSafeStoreId,
  normalizeInstallSource,
} from "../install/source.js";
import { reasonixHome } from "../reasonix-home.js";
import {
  type PluginManifest,
  pluginSlug,
  readPluginManifest,
  unreadablePluginManifest,
} from "./manifest.js";
import { pluginServerConfigs } from "./servers.js";
import { type PluginSkill, indexPluginSkills } from "./skills.js";

export function pluginsRoot(homeDir?: string): string {
  return join(reasonixHome(homeDir), "plugins");
}

/** One installed plugin as the store sees it: manifest, skills and MCP entries.
 *  Whether a chat may use it is frozen per session, so `disabled` here is only the
 *  Settings default a new chat's picker starts from. */
export interface PluginState {
  slug: string;
  dir: string;
  manifest: PluginManifest;
  skills: PluginSkill[];
  /** Config entries this plugin owns, keyed by namespaced server name. */
  servers: Record<string, McpServerConfig>;
  record: PluginRecord | undefined;
  /** Settings default: true while the plugin is switched off for chats created later. */
  disabled: boolean;
  /** Set when the manifest or its MCP file could not be read. */
  error?: string;
}

function stateOf(
  slug: string,
  dir: string,
  record: PluginRecord | undefined,
  disabled: boolean,
): PluginState | null {
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
      disabled,
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
    disabled,
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

/** Slugs Settings switched off: the enablement a new chat's picker starts from. */
function disabledSlugs(cfg: ReasonixConfig): Set<string> {
  return new Set(cfg.pluginsDisabled ?? []);
}

/** Names under the plugin root that could be slugs, sorted. */
function storeNames(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).filter(isSafeStoreId).sort();
  } catch {
    return [];
  }
}

/** A real plugin directory, not a stray file that happens to be named like one. */
function isPluginDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Slugs with an installed plugin directory: the ONE definition of "installed" the
 *  inventory, the Settings default and a session's skill index all decide by. */
function installedSlugs(root: string, only?: readonly string[]): string[] {
  const names = only ? [...new Set(only)].filter(isSafeStoreId).sort() : storeNames(root);
  return names.filter((name) => isPluginDir(join(root, name)));
}

/** Every plugin on disk, sorted by slug. Records the store no longer knows are ignored. */
export function listPlugins(opts: PluginLookupOptions = {}): PluginState[] {
  const cfg = configOf(opts);
  const disabled = disabledSlugs(cfg);
  const root = pluginsRoot(opts.homeDir);
  const states: PluginState[] = [];
  for (const name of installedSlugs(root, opts.only)) {
    const state = stateOf(name, join(root, name), cfg.plugins?.[name], disabled.has(name));
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
  copy?: InstallCopy;
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
  const normalized = normalizeInstallSource(source);
  const cfg = readConfig(opts.configPath);
  const root = pluginsRoot(opts.homeDir);
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, ".staging-"));
  let moved: string | undefined;
  try {
    await (opts.copy ?? copyInstallSource)(normalized, staging);
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

/** MCP entry names one plugin owns, read from the stamps it left in config. The manifest
 *  is deliberately not consulted: a plugin whose manifest broke still loses its entries,
 *  and with them its sign-ins. */
function ownedServerNames(cfg: ReasonixConfig, slug: string): string[] {
  return Object.entries(cfg.mcpServers ?? {})
    .filter(([, entry]) => entry.plugin === slug)
    .map(([name]) => name);
}

/** Remove a plugin: its files, its config record, its MCP entries, its sign-ins and its
 *  read grant. The read grant is always revoked, so a failed config write cannot leave a
 *  plugin readable after its files are gone. */
export function uninstallPlugin(slug: string, opts: PluginStoreOptions = {}): void {
  const cfg = readConfig(opts.configPath);
  const dir = join(pluginsRoot(opts.homeDir), slug);
  if (!existsSync(dir) && !cfg.plugins?.[slug]) {
    throw new Error(`${slug} is not installed`);
  }
  // A sign-in outlives the manifest rewrite that plugin sync performs, so it has to be
  // dropped here or a reinstall would inherit a token minted for the old workspace.
  const signedIn = ownedServerNames(cfg, slug);
  rmSync(dir, { recursive: true, force: true });
  try {
    if (cfg.plugins) {
      const remaining = Object.entries(cfg.plugins).filter(([key]) => key !== slug);
      cfg.plugins = remaining.length > 0 ? Object.fromEntries(remaining) : undefined;
    }
    if (cfg.mcpOAuth) {
      for (const name of signedIn) delete cfg.mcpOAuth[name];
      if (Object.keys(cfg.mcpOAuth).length === 0) cfg.mcpOAuth = undefined;
    }
    // A stale default would silently switch off a reinstall under the same slug.
    const off = cfg.pluginsDisabled?.filter((name) => name !== slug) ?? [];
    cfg.pluginsDisabled = off.length > 0 ? off : undefined;
    syncPluginServers(cfg, listPlugins({ homeDir: opts.homeDir, cfg }));
    writeConfig(cfg, opts.configPath);
  } finally {
    removeGlobalPathAllowed(dir, opts.configPath);
  }
}

/** Edit one installed plugin's Settings default. Returns false for a slug nothing is
 *  installed under, so a caller reports that instead of writing a stale entry. */
export function setPluginDisabled(
  slug: string,
  disabled: boolean,
  opts: PluginStoreOptions = {},
): boolean {
  const root = pluginsRoot(opts.homeDir);
  // The exact on-disk name: a differently-cased slug would key an entry nothing reads.
  if (!installedSlugs(root).includes(slug)) return false;
  const cfg = readConfig(opts.configPath);
  const off = disabledSlugs(cfg);
  // An unchanged default writes nothing: a rewrite invalidates every reader's config cache.
  if (off.has(slug) === disabled) return true;
  if (disabled) off.add(slug);
  else off.delete(slug);
  cfg.pluginsDisabled = off.size > 0 ? [...off].sort() : undefined;
  writeConfig(cfg, opts.configPath);
  return true;
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
