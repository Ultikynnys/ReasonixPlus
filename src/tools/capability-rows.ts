/** One configured MCP server, in the shape every capability inventory reports it: what the
 *  config declares, whether this chat enabled it, and the tools bridged behind it. */

import { loadEffectiveMcpConfig, readConfig } from "../config.js";
import { isManagedMcpSpec } from "../mcp/managed.js";
import type { McpServerSpec } from "../mcp/spec.js";
import type { ToolRegistry } from "../tools.js";

/** Which store changed, so a host refreshes only the projections that read it. */
export type CapabilityKind = "mcp" | "skill" | "plugin";

/** Whether the store gained or lost an entry. A host treats the two differently: a removal
 *  prunes what the chat already had, an install never adds anything to a live chat. */
export type CapabilityChange = "installed" | "removed";

/** Report a store write to the host. A host failure must never turn a completed write into
 *  an error result, so the callback is contained here rather than at every call site. */
export function notifyHost(
  callback: ((kind: CapabilityKind, change: CapabilityChange) => void) | undefined,
  kind: CapabilityKind,
  change: CapabilityChange,
): void {
  try {
    callback?.(kind, change);
  } catch {
    /* the store already changed; a failed projection refresh is the host's problem */
  }
}

/** What every install result must say. A chat's capability set is the user's choice at
 *  creation, so nothing these tools write can switch one on for the chat that wrote it. */
export function freezeNote(kind: CapabilityKind): string {
  const set = kind === "mcp" ? "MCP server" : kind;
  return `This chat froze its ${set} set when it started, so the change reaches chats created after this one, where the user chooses what each chat may use.`;
}

export interface ServerRowOptions {
  projectRoot?: string;
  configPath?: string;
  /** Live spec provider (config + this chat's overlay). Absent: read the config alone. */
  getMcpSpecs?: () => McpServerSpec[];
  /** Tools a bridge refused (name owned elsewhere) or deferred (spec budget). */
  getMcpToolSkips?: () => Array<{ server: string; name: string; reason: string }>;
}

export interface CapabilityServerRow {
  name: string;
  transport: McpServerSpec["transport"];
  /** `connected` when tools are bridged, `disabled` when the chat or the config turned it
   *  off, `configured` when it is on but no bridge has registered its tools yet. */
  status: "connected" | "configured" | "disabled";
  disabled: boolean;
  /** App-managed integration: setup and sign-in live in Settings, not in a config edit. */
  builtin: boolean;
  /** Plugin that declares this entry. Plugin-owned servers move with their plugin. */
  plugin?: string;
  command?: string;
  args?: string[];
  url?: string;
  tool_count: number;
  tools: Array<{ name: string; description: string }>;
  /** Present only when a bridge refused or deferred one of this server's tools. */
  skipped_tools?: Array<{ server: string; name: string; reason: string }>;
}

/** Every configured server, in config order. `tools` lists what is bridged right now, so a
 *  caller can tell "configured" from "usable in this chat". */
export function serverRows(
  registry: ToolRegistry,
  opts: ServerRowOptions = {},
): CapabilityServerRow[] {
  const configured =
    opts.getMcpSpecs?.() ?? loadEffectiveMcpConfig(opts.projectRoot, opts.configPath);
  const owners = pluginServerOwners(opts.configPath);
  const specs = registry.specs();
  const skipped = opts.getMcpToolSkips?.() ?? [];
  return configured.map((spec) => {
    const name = spec.name ?? "anon";
    const prefix = spec.name ? `${spec.name}_` : "";
    const tools = prefix
      ? specs
          .filter((entry) => entry.function.name.startsWith(prefix))
          .map((entry) => ({
            name: entry.function.name,
            description: entry.function.description ?? "",
          }))
      : [];
    const plugin = owners.get(name);
    const skippedForServer = skipped.filter((entry) => entry.server === name);
    return {
      name,
      transport: spec.transport,
      status: tools.length > 0 ? "connected" : spec.disabled ? "disabled" : "configured",
      disabled: spec.disabled === true,
      builtin: isManagedMcpSpec(spec),
      ...(plugin ? { plugin } : {}),
      ...(spec.transport === "stdio"
        ? { command: spec.command, args: spec.args ?? [] }
        : { url: spec.url }),
      tool_count: tools.length,
      tools,
      ...(skippedForServer.length > 0 ? { skipped_tools: skippedForServer } : {}),
    };
  });
}

/** Server name to the slug of the plugin that declares it — the one projection the MCP list,
 *  the session picker and the capability tools all read. */
export function pluginServerOwners(configPath?: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [name, entry] of Object.entries(readConfig(configPath).mcpServers ?? {})) {
    if (entry.plugin) owners.set(name, entry.plugin);
  }
  return owners;
}
