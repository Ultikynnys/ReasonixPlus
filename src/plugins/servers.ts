/** Plugin MCP declarations: the manifest's `mcpServers` file (or inline block) mapped into
 *  config entries owned by the plugin. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { messageOf } from "@reasonix/core-utils";
import type { McpServerConfig } from "../config.js";
import { type PluginManifest, pluginSlug } from "./manifest.js";

/** Config/tool-prefix name for one declared server. A server already named after its
 *  plugin keeps that name; every other one is namespaced so it cannot shadow a user
 *  server that happens to use the same short name. */
export function pluginServerName(plugin: string, declared: string): string {
  const serverSlug = pluginSlug(declared);
  const pluginKey = pluginSlug(plugin);
  return serverSlug === pluginKey ? serverSlug : `${pluginKey}-${serverSlug}`;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.length > 0) out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only the fields the MCP bridge understands; drop entries with no command and no URL. */
export function normalizePluginServer(entry: unknown): McpServerConfig | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;
  const config: McpServerConfig = {};
  if (typeof raw.command === "string" && raw.command.trim()) config.command = raw.command;
  if (Array.isArray(raw.args)) {
    config.args = raw.args.filter((arg): arg is string => typeof arg === "string");
  }
  if (typeof raw.url === "string" && raw.url.trim()) config.url = raw.url;
  const transport = raw.transport ?? raw.type;
  if (transport === "stdio" || transport === "sse" || transport === "streamable-http") {
    config.transport = transport;
  } else if (transport === "http") {
    config.type = "http";
  }
  const env = stringRecord(raw.env);
  if (env) config.env = env;
  const headers = stringRecord(raw.headers);
  if (headers) config.headers = headers;
  if (!config.command && !config.url) return null;
  return config;
}

/** The `mcpServers` block a plugin declares, from its file or inline in the manifest. */
export function readPluginServerDeclarations(
  rootDir: string,
  manifest: PluginManifest,
): Record<string, unknown> {
  if (!manifest.mcpServersFile) return manifest.inlineMcpServers ?? {};
  const path = join(rootDir, manifest.mcpServersFile);
  if (!existsSync(path)) {
    throw new Error(
      `${manifest.name}: declared mcpServers file is missing (${manifest.mcpServersFile})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(`${path}: ${messageOf(err)}`);
  }
  const block = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${path}: no mcpServers block`);
  }
  return block as Record<string, unknown>;
}

/** Config entries for one plugin, keyed by namespaced server name and stamped with the owner. */
export function pluginServerConfigs(
  rootDir: string,
  manifest: PluginManifest,
): Record<string, McpServerConfig> {
  const declared = readPluginServerDeclarations(rootDir, manifest);
  const out: Record<string, McpServerConfig> = {};
  for (const [declaredName, entry] of Object.entries(declared)) {
    const config = normalizePluginServer(entry);
    if (!config) continue;
    out[pluginServerName(manifest.name, declaredName)] = {
      ...config,
      plugin: pluginSlug(manifest.name),
    };
  }
  return out;
}
