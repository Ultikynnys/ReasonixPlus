/** Agent-facing tools that install, remove and inventory plugins, skills and MCP servers.
 *  Every write lands in the store Settings edits; a chat's own set stays frozen. */

import { join } from "node:path";
import { messageOf } from "@reasonix/core-utils";
import { defaultConfigPath } from "../config.js";
import type { InstallCopy } from "../install/source.js";
import { pluginDisplayName } from "../plugins/manifest.js";
import { installPlugin, listPlugins, uninstallPlugin } from "../plugins/store.js";
import { SKILL_ENTRY_FILE } from "../skills/skill.js";
import { installSkills, listSkills, skillsRoot, uninstallSkill } from "../skills/store.js";
import type { ToolRegistry } from "../tools.js";
import {
  type CapabilityChange,
  type CapabilityKind,
  type ServerRowOptions,
  freezeNote,
  notifyHost,
  pluginServerOwners,
  serverRows,
} from "./capability-rows.js";

export interface CapabilityToolsOptions extends ServerRowOptions {
  /** Override `~` so tests never read or write the real plugin and skill stores. */
  homeDir?: string;
  /** Injectable transfer step so tests never shell out to git. */
  copy?: InstallCopy;
  /** Plugin slugs this chat froze at its session start. Absent: the host reports no session state. */
  getSessionPlugins?: () => readonly string[];
  /** Standalone skill ids this chat froze at its session start. */
  getSessionSkills?: () => readonly string[];
  /** Fired after a store write so a host can refresh the projections that read it. */
  onCapabilitiesChanged?: (kind: CapabilityKind, change: CapabilityChange) => void;
}

/** One trimmed string argument: every tool here takes a single name or source. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A refusal in the shape the harness uses for tool errors, so a caller reads one field. */
function failure(message: string): string {
  return JSON.stringify({ error: message });
}

/** Everything a tool may report alongside a completed write. */
function success<T extends Record<string, unknown>>(payload: T): string {
  return JSON.stringify({ success: true, ...payload });
}

/** A frozen id list as a membership set, or undefined when the host reports none. */
function setOf(ids: readonly string[] | undefined): Set<string> | undefined {
  return ids ? new Set(ids) : undefined;
}

export function registerCapabilityTools(
  registry: ToolRegistry,
  opts: CapabilityToolsOptions = {},
): ToolRegistry {
  const configPath = opts.configPath ?? defaultConfigPath();
  const store = { homeDir: opts.homeDir, configPath };

  registry.register({
    name: "install_skill",
    description:
      "Install one skill (a directory or repository holding SKILL.md), or every skill a folder of them holds, into the global skill store. Accepts a git URL, owner/repo, or a local directory. All or nothing: a collision or an unreadable SKILL.md leaves the store untouched. A chat's skill set is the user's choice at creation, so nothing here turns a skill on for this chat.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Git URL, owner/repo, or a local directory holding SKILL.md.",
        },
      },
      required: ["source"],
    },
    fn: async (args: { source?: unknown }) => {
      const source = text(args.source);
      if (!source) return failure("install_skill requires 'source'");
      try {
        const installed = await installSkills(source, { ...store, copy: opts.copy });
        notifyHost(opts.onCapabilitiesChanged, "skill", "installed");
        const root = skillsRoot(opts.homeDir);
        return success({
          installed: installed.ids.map((id) => ({ id, path: join(root, id, SKILL_ENTRY_FILE) })),
          store: root,
          enabled_in_this_chat: false,
          note: `${freezeNote("skill")} Following its SKILL.md directly still works here.`,
        });
      } catch (err) {
        return failure(messageOf(err));
      }
    },
  });

  registry.register({
    name: "uninstall_skill",
    description:
      "Remove one standalone skill from the global skill store, with its files and its read grant. A skill a plugin ships is removed by uninstalling that plugin instead.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Skill id (or name) as list_capabilities reports it.",
        },
      },
      required: ["id"],
    },
    fn: async (args: { id?: unknown }) => {
      const id = text(args.id);
      if (!id) return failure("uninstall_skill requires 'id'");
      const installedSkills = listSkills(store);
      const installed = installedSkills.find((skill) => skill.id === id || skill.name === id);
      if (!installed) {
        const owner = listPlugins(store).find((state) =>
          state.skills.some((skill) => skill.name === id),
        )?.slug;
        if (owner)
          return failure(
            `${id} ships with the ${owner} plugin. Use uninstall_plugin to remove it.`,
          );
        const ids = installedSkills.map((skill) => skill.id);
        return failure(
          `no standalone skill named ${JSON.stringify(id)}.${
            ids.length > 0 ? ` Installed: ${ids.join(", ")}.` : " None are installed."
          }`,
        );
      }
      try {
        uninstallSkill(installed.id, store);
        notifyHost(opts.onCapabilitiesChanged, "skill", "removed");
        return success({ id: installed.id, name: installed.name });
      } catch (err) {
        return failure(messageOf(err));
      }
    },
  });

  registry.register({
    name: "install_plugin",
    description:
      "Install an agent plugin from a git URL, owner/repo, or a local directory. A plugin ships its own skills and MCP servers, which follow it into every chat the user enables it in. A failed install leaves neither files nor a config record.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Git URL, owner/repo, or a local directory of the plugin.",
        },
      },
      required: ["source"],
    },
    fn: async (args: { source?: unknown }) => {
      const source = text(args.source);
      if (!source) return failure("install_plugin requires 'source'");
      try {
        const installed = await installPlugin(source, { ...store, copy: opts.copy });
        const state = listPlugins({ ...store, only: [installed.slug] })[0];
        notifyHost(opts.onCapabilitiesChanged, "plugin", "installed");
        return success({
          slug: installed.slug,
          name: pluginDisplayName(installed.manifest),
          ...(installed.manifest.version ? { version: installed.manifest.version } : {}),
          dir: installed.dir,
          skills: state?.skills.map((skill) => skill.name) ?? [],
          servers: Object.keys(state?.servers ?? {}),
          enabled_in_this_chat: false,
          note: freezeNote("plugin"),
        });
      } catch (err) {
        return failure(messageOf(err));
      }
    },
  });

  registry.register({
    name: "uninstall_plugin",
    description:
      "Remove an installed plugin: its files, its config record, the MCP servers it declares, their sign-ins and its read grant.",
    parameters: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Plugin slug as list_capabilities reports it.",
        },
      },
      required: ["slug"],
    },
    fn: async (args: { slug?: unknown }) => {
      const slug = text(args.slug);
      if (!slug) return failure("uninstall_plugin requires 'slug'");
      const servers = [...pluginServerOwners(configPath)]
        .filter(([, owner]) => owner === slug)
        .map(([name]) => name);
      try {
        uninstallPlugin(slug, store);
        notifyHost(opts.onCapabilitiesChanged, "plugin", "removed");
        return success({ slug, removed_servers: servers });
      } catch (err) {
        return failure(messageOf(err));
      }
    },
  });

  registry.register({
    name: "list_capabilities",
    description:
      "Inventory every installed plugin, standalone skill and MCP server, and which of them this chat may use now. A plugin's version, skills and servers are listed inside its own entry. Use list_mcp_bridges for the tools bridged behind one server. Read only: it reports enablement and never changes it.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["plugins", "skills", "mcp"],
          description: "Restrict the report to one dimension. Omit to report all three.",
        },
      },
    },
    fn: async (args: { kind?: unknown }) => {
      const kind = args.kind;
      if (kind !== undefined && kind !== "plugins" && kind !== "skills" && kind !== "mcp") {
        return failure(`unknown kind ${JSON.stringify(kind)}. Use plugins, skills, or mcp.`);
      }
      const wants = (which: "plugins" | "skills" | "mcp"): boolean =>
        kind === undefined || kind === which;
      // Sets, not lists: a plugin or skill id is looked up once per row.
      const chosenPlugins = setOf(opts.getSessionPlugins?.());
      const chosenSkills = setOf(opts.getSessionSkills?.());
      const plugins = wants("plugins")
        ? listPlugins(store).map((state) => ({
            slug: state.slug,
            name: pluginDisplayName(state.manifest),
            ...(state.manifest.version ? { version: state.manifest.version } : {}),
            ...(state.record?.source ? { source: state.record.source } : {}),
            ...(chosenPlugins ? { enabled_here: chosenPlugins.has(state.slug) } : {}),
            disabled_by_default: state.disabled,
            dir: state.dir,
            skills: state.skills.map((skill) => skill.name),
            servers: Object.keys(state.servers),
            ...(state.error ? { error: state.error } : {}),
          }))
        : undefined;
      const skills = wants("skills")
        ? listSkills(store).map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            path: skill.path,
            ...(skill.source ? { source: skill.source } : {}),
            ...(chosenSkills ? { enabled_here: chosenSkills.has(skill.id) } : {}),
            ...(skill.error ? { error: skill.error } : {}),
          }))
        : undefined;
      const servers = wants("mcp")
        ? serverRows(registry, opts).map((row) => ({
            name: row.name,
            transport: row.transport,
            status: row.status,
            ...(opts.getMcpSpecs ? { enabled_here: !row.disabled } : {}),
            ...(row.builtin ? { builtin: true } : {}),
            ...(row.plugin ? { plugin: row.plugin } : {}),
            tool_count: row.tool_count,
          }))
        : undefined;
      // `enabled_here` is absent when the host reports no session state, so the flag below
      // keeps "this chat enabled nothing" distinct from "this host cannot say".
      const unreported = !chosenPlugins || !chosenSkills;
      return JSON.stringify({
        ...(plugins ? { plugins } : {}),
        ...(skills ? { skills } : {}),
        ...(servers ? { servers } : {}),
        counts: {
          ...(plugins ? { plugins: plugins.length } : {}),
          ...(skills ? { skills: skills.length } : {}),
          ...(servers ? { servers: servers.length } : {}),
        },
        ...(unreported ? { session_reported: false } : {}),
      });
    },
  });

  return registry;
}
