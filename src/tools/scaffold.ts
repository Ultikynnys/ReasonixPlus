/** Agent-facing tools for scaffolding MCP servers from chat. Persists via the same paths the wizard uses. */

import { defaultConfigPath, loadEffectiveMcpConfig, readConfig, writeConfig } from "../config.js";
import { MCP_CATALOG, catalogStdioCommand } from "../mcp/catalog.js";
import { DOT_MCP_JSON, loadDotMcpJson } from "../mcp/dot-mcp-json.js";
import { isManagedMcpSpec } from "../mcp/managed.js";
import { preflightStdioSpec } from "../mcp/preflight.js";
import { type McpSpec, parseMcpSpec, specToRaw } from "../mcp/spec.js";
import type { ToolRegistry } from "../tools.js";
import {
  type CapabilityChange,
  type CapabilityKind,
  type ServerRowOptions,
  freezeNote,
  notifyHost,
  serverRows,
} from "./capability-rows.js";

export interface ScaffoldToolsOptions extends ServerRowOptions {
  /** Fired after a config write so a host refreshes its MCP projections. A host must not
   *  bridge an install into the writing chat: the user alone decides a chat's set. */
  onCapabilitiesChanged?: (kind: CapabilityKind, change: CapabilityChange) => void;
}

const VALID_SERVER_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

export function registerScaffoldTools(
  registry: ToolRegistry,
  opts: ScaffoldToolsOptions = {},
): ToolRegistry {
  const configPath = opts.configPath ?? defaultConfigPath();

  registry.register({
    name: "add_mcp_server",
    description:
      'Register a new MCP server in the user\'s config (`mcp` array). A chat freezes its server set when it starts, so the server is usable in chats created after this one, where the user turns it on. Use stdio for local commands, sse/streamable-http for remote. Pass `from_catalog` (e.g. "filesystem", "github") to auto-fill command+args from the bundled catalog. Refuses name collisions.',
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Namespace prefix on every tool. Letters/digits/`_`/`-`, must start with letter or `_`.",
        },
        transport: {
          type: "string",
          enum: ["stdio", "sse", "streamable-http"],
          description:
            "stdio = local command via stdin/stdout; sse / streamable-http = remote. Required unless `from_catalog` is set.",
        },
        command: {
          type: "string",
          description: "Argv[0] for stdio: typically `npx` or a binary path.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            'Remaining argv for stdio: e.g. `["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]`.',
        },
        url: {
          type: "string",
          description: "Endpoint URL for sse / streamable-http: must be http(s)://.",
        },
        from_catalog: {
          type: "string",
          description:
            "Bundled catalog shortcut: filesystem / memory / github / puppeteer / everything. Fills command+args; user supplies user-args via `args`.",
        },
      },
      required: ["name"],
    },
    fn: async (args: {
      name?: unknown;
      transport?: unknown;
      command?: unknown;
      args?: unknown;
      url?: unknown;
      from_catalog?: unknown;
    }) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!VALID_SERVER_NAME.test(name)) {
        return JSON.stringify({
          error: `invalid server name: ${JSON.stringify(name)} : must match [a-zA-Z_][a-zA-Z0-9_-]*`,
        });
      }

      const specStr = buildSpecString({
        name,
        transport: typeof args.transport === "string" ? args.transport : undefined,
        command: typeof args.command === "string" ? args.command : undefined,
        argv: Array.isArray(args.args)
          ? (args.args.filter((a) => typeof a === "string") as string[])
          : undefined,
        url: typeof args.url === "string" ? args.url : undefined,
        fromCatalog: typeof args.from_catalog === "string" ? args.from_catalog : undefined,
      });
      if ("error" in specStr) {
        return JSON.stringify({ error: specStr.error });
      }

      let parsed: McpSpec;
      try {
        parsed = parseMcpSpec(specStr.spec);
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
      if (parsed.transport === "stdio") {
        try {
          preflightStdioSpec(parsed);
        } catch (err) {
          return JSON.stringify({ error: (err as Error).message });
        }
      }

      const existingSpecs = loadEffectiveMcpConfig(opts.projectRoot, configPath);
      const collision = existingSpecs.find((s) => s.name === name);
      if (collision) {
        return JSON.stringify({
          error: `MCP server ${JSON.stringify(name)} already registered: ${specToRaw(collision)}`,
        });
      }
      const cfg = readConfig(configPath);
      const existing = cfg.mcp ?? [];
      cfg.mcp = [...existing, specStr.spec];
      writeConfig(cfg, configPath);
      notifyHost(opts.onCapabilitiesChanged, "mcp", "installed");
      return JSON.stringify({
        success: true,
        name,
        transport: parsed.transport,
        spec: specStr.spec,
        ...(specStr.note ? { install_note: specStr.note } : {}),
        config_path: configPath,
        enabled_in_this_chat: false,
        note: freezeNote("mcp"),
      });
    },
  });

  registry.register({
    name: "list_mcp_bridges",
    description:
      "List all configured MCP servers and bridges, their transport type, status, and tools currently bridged into the session.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional: filter by exact server/bridge name.",
        },
      },
    },
    fn: async (args: { name?: unknown }) => {
      const filterName = typeof args.name === "string" ? args.name.trim() : undefined;
      const bridges = serverRows(registry, opts).filter(
        (row) => !filterName || row.name === filterName,
      );
      return JSON.stringify({
        count: bridges.length,
        bridges,
      });
    },
  });

  registry.register({
    name: "remove_mcp_server",
    description:
      "Remove one MCP server from the user's config, with its env overlay, disabled flag and stored sign-in. Refuses an app-managed integration (playwright, the mail servers), a server a plugin declares, and one that lives in the project `.mcp.json`.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name exactly as list_mcp_bridges reports it.",
        },
      },
      required: ["name"],
    },
    fn: async (args: { name?: unknown }) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return JSON.stringify({ error: "remove_mcp_server requires 'name'" });

      const cfg = readConfig(configPath);
      // Parsed once: the name a spec string declares decides both whether this call targets
      // it and which strings a removal drops.
      const legacy = (cfg.mcp ?? []).map((raw) => ({ raw, name: specName(raw) }));
      const servers = cfg.mcpServers ?? {};
      const env = cfg.mcpEnv ?? {};
      const oauth = cfg.mcpOAuth ?? {};
      // An inherited key (`__proto__`, `constructor`) is not a configured server, so every
      // lookup is an own-key test rather than a truthiness test.
      const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
      if (!legacy.some((spec) => spec.name === name) && !entry) {
        const project = opts.projectRoot ? loadDotMcpJson(opts.projectRoot) : undefined;
        if (project && Object.hasOwn(project, name)) {
          return JSON.stringify({
            error: `${name} is declared in the project's ${DOT_MCP_JSON}, not in the user's config. Edit that file to remove it.`,
          });
        }
        const configured = loadEffectiveMcpConfig(opts.projectRoot, configPath);
        const names = configured
          .map((candidate) => candidate.name)
          .filter((value): value is string => Boolean(value));
        // An anonymous spec declares no prefix, so no name can target it: say that rather
        // than listing "anon" as a server the caller could remove.
        const anonymous = configured.length > names.length;
        return JSON.stringify({
          error: `no MCP server named ${JSON.stringify(name)}.${
            names.length > 0 ? ` Configured: ${names.join(", ")}.` : " None are configured."
          }${anonymous ? " A spec with no name prefix cannot be removed by name; edit the config." : ""}`,
        });
      }

      const spec = loadEffectiveMcpConfig(opts.projectRoot, configPath).find(
        (candidate) => candidate.name === name,
      );
      if (spec && isManagedMcpSpec(spec)) {
        return JSON.stringify({
          error: `${name} is an integration the app manages. Turn it off in Settings instead of removing it.`,
        });
      }
      if (entry?.plugin) {
        return JSON.stringify({
          error: `${name} is declared by the ${entry.plugin} plugin. Use uninstall_plugin to remove it.`,
        });
      }

      const removed: string[] = [];
      if (legacy.some((spec) => spec.name === name)) {
        const rest = legacy.filter((spec) => spec.name !== name).map((spec) => spec.raw);
        cfg.mcp = rest.length > 0 ? rest : undefined;
        removed.push("mcp spec");
      }
      if (entry) {
        delete servers[name];
        cfg.mcpServers = Object.keys(servers).length > 0 ? servers : undefined;
        removed.push("mcpServers entry");
      }
      if (Object.hasOwn(env, name)) {
        delete env[name];
        cfg.mcpEnv = Object.keys(env).length > 0 ? env : undefined;
        removed.push("env overlay");
      }
      if (Object.hasOwn(oauth, name)) {
        delete oauth[name];
        cfg.mcpOAuth = Object.keys(oauth).length > 0 ? oauth : undefined;
        removed.push("sign-in");
      }
      const stillDisabled = (cfg.mcpDisabled ?? []).filter((raw) => raw !== name);
      if (stillDisabled.length !== (cfg.mcpDisabled ?? []).length) {
        cfg.mcpDisabled = stillDisabled.length > 0 ? stillDisabled : undefined;
        removed.push("disabled flag");
      }
      writeConfig(cfg, configPath);
      notifyHost(opts.onCapabilitiesChanged, "mcp", "removed");
      return JSON.stringify({ success: true, name, removed, config_path: configPath });
    },
  });

  return registry;
}

/** Name a `mcp` spec string declares, or null for one that cannot be parsed. */
function specName(raw: string): string | null {
  try {
    return parseMcpSpec(raw).name;
  } catch {
    return null;
  }
}

interface BuildSpecInput {
  name: string;
  transport?: string;
  command?: string;
  argv?: string[];
  url?: string;
  fromCatalog?: string;
}

function buildSpecString(
  input: BuildSpecInput,
): { spec: string; note?: string } | { error: string } {
  if (input.fromCatalog) {
    const entry = MCP_CATALOG.find((e) => e.name === input.fromCatalog);
    if (!entry) {
      const known = MCP_CATALOG.map((e) => e.name).join(", ");
      return {
        error: `unknown catalog entry: ${JSON.stringify(input.fromCatalog)} (known: ${known})`,
      };
    }
    const userArgs = input.argv ?? [];
    if (entry.userArgs && userArgs.length === 0) {
      return {
        error: `catalog entry "${entry.name}" needs ${entry.userArgs} : pass it via the 'args' parameter`,
      };
    }
    const { command, args } = catalogStdioCommand(entry);
    const tail = userArgs.map(quoteIfNeeded).join(" ");
    const body = `${command} ${args.join(" ")}${tail ? ` ${tail}` : ""}`;
    return { spec: `${input.name}=${body}`, note: entry.note };
  }

  const transport = input.transport;
  if (!transport) {
    return { error: "add_mcp_server requires 'transport' (or 'from_catalog')" };
  }
  if (transport === "stdio") {
    if (!input.command || !input.command.trim()) {
      return { error: "stdio transport requires 'command'" };
    }
    const tail = (input.argv ?? []).map(quoteIfNeeded).join(" ");
    const body = `${quoteIfNeeded(input.command.trim())}${tail ? ` ${tail}` : ""}`;
    return { spec: `${input.name}=${body}` };
  }
  if (transport === "sse" || transport === "streamable-http") {
    if (!input.url || !/^https?:\/\//i.test(input.url)) {
      return { error: `${transport} transport requires an http(s):// 'url'` };
    }
    const prefix = transport === "streamable-http" ? "streamable+" : "";
    return { spec: `${input.name}=${prefix}${input.url.trim()}` };
  }
  return { error: `unknown transport: ${JSON.stringify(transport)}` };
}

function quoteIfNeeded(s: string): string {
  return /\s|"/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
}
