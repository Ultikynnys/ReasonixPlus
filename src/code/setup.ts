import type { DeepSeekClient } from "../client.js";
import {
  DEFAULT_MODEL,
  type EditMode,
  type ReasoningEffort,
  isNeverAskMode,
  loadAllShellAllowed,
  loadEditMode,
  loadElevationEnabled,
  loadFilesystemOutlineThresholdBytes,
  loadProjectShellAllowed,
  loadSubagentModels,
  loadToolRateLimit,
  readConfig,
  regexRulePatterns,
  ruleModeInForce,
  rulePatterns,
  searchEnabled,
} from "../config.js";
import type { McpServerSpec } from "../mcp/spec.js";
import { createModelClient } from "../model-client.js";
import { hasOpenAIOAuthSession } from "../oauth.js";
import { ToolRegistry } from "../tools.js";
import { registerChoiceTool } from "../tools/choice.js";
import { registerCodeQueryTools } from "../tools/code-query.js";
import { registerComputerUseTool } from "../tools/computer-use.js";
import { registerFilesystemTools } from "../tools/filesystem.js";
import { registerImageGenTool } from "../tools/image-gen.js";
import { JobRegistry } from "../tools/jobs.js";
import { registerMemoryTools } from "../tools/memory.js";
import { registerPlanTool } from "../tools/plan.js";
import { registerRulesTools } from "../tools/rules.js";
import { registerScaffoldTools } from "../tools/scaffold.js";
import { registerScreenCaptureTool } from "../tools/screen-capture.js";
import { registerSeeImageTool } from "../tools/see-image.js";
import { registerShellTools } from "../tools/shell.js";
import {
  SHARED_SUBAGENT_SINK,
  type SubagentLoopOptions,
  type SubagentSink,
  registerSubagentTool,
} from "../tools/subagent.js";
import { registerTodoTool } from "../tools/todo.js";
import { registerWaitTool } from "../tools/wait.js";
import { registerWebTools } from "../tools/web.js";

export interface CodeToolsetOpts {
  rootDir: string;
  /** Override the default `~/.reasonix/config.json` lookup — primarily for tests that pin a tmp config. */
  configPath?: string;
  /** Fired after `run_background` / `stop_job` mutate the JobRegistry — desktop pushes a fresh `$jobs` event so the popover updates without waiting for poll. */
  onJobsChanged?: () => void;
  /** Fired after `remember_rule` / `forget_rule` mutate permission rules — desktop pushes a fresh `$settings` so the Rules tab updates in every tab. */
  onRulesChanged?: () => void;
  /** Fired with `run_command`'s incremental stdout+stderr while it runs — desktop
   *  forwards it as a transient `tool.output` kernel event so the shell card can
   *  render live output rows. */
  onShellOutput?: (ev: import("../tools/shell.js").ShellOutputEvent) => void;
  /** Shared `{current: callback}` sink the TUI populates after mount. Setup forwards it into every `spawnSubagent` so live progress events reach the rich subagent row even though setup runs before the UI does. */
  subagentSink?: SubagentSink;
  /** Per-tab subagent model, resolved lazily at spawn time via a getter so a
   *  change applies to the next spawn without rebuilding the toolset. */
  subagentModel?: () => string;
  /** The session's thinking budget, read at spawn time so a child reasons at the
   *  same effort as the chat that spawned it. */
  subagentEffort?: () => ReasoningEffort;
  /** Live inherited-loop options (window cap, compaction trigger, iteration/output
   *  caps, tool hooks), read at spawn time for the same reason: a mid-session change
   *  applies to the next child without a rebuild. */
  subagentLoopOptions?: () => SubagentLoopOptions | undefined;
  /** Live effective MCP specs (config + session overlay) for list_mcp_bridges, so
   *  the tool reports the session's toggle state rather than the config default. */
  getMcpSpecs?: () => McpServerSpec[];
  /** Tools a bridge refused or deferred, so list_mcp_bridges can name them. */
  getMcpToolSkips?: () => Array<{ server: string; name: string; reason: string }>;
  /** Whether this SESSION was minted with `spawn_subagent`. The host reads it from the
   *  session's frozen meta; omitted means no spawn tool is registered. */
  subagentsEnabled?: boolean;
  onPhase?: (phase: string) => void;
}

export interface CodeToolset {
  tools: ToolRegistry;
  jobs: JobRegistry;
  registerRooted: (root: string) => void;
  /** Session-boundary resync of the spawn tool. Call this only when the tab binds a
   *  DIFFERENT session (whose frozen flag differs), never for a live settings flip:
   *  changing the tool set mid-conversation invalidates the cached prompt prefix. */
  syncSubagentTools: (enabled: boolean) => void;
}

/** Mirror `editMode === "read-only"` into the registry's dispatch gate - keeps a single source of truth (the persisted EditMode) for the read-only mode. */
export function applyPlanMode(tools: ToolRegistry, editMode: EditMode): void {
  tools.setPlanMode(editMode === "read-only");
}

export async function buildCodeToolset(opts: CodeToolsetOpts): Promise<CodeToolset> {
  opts.onPhase?.("toolset_build_started");
  const tools = new ToolRegistry({ rateLimit: loadToolRateLimit() });
  applyPlanMode(tools, loadEditMode(opts.configPath));
  const jobs = new JobRegistry();

  const outlineThresholdBytes = loadFilesystemOutlineThresholdBytes();
  const registerRooted = (root: string): void => {
    registerFilesystemTools(tools, { rootDir: root, outlineThresholdBytes });
    const cfg = readConfig();
    registerShellTools(tools, {
      rootDir: root,
      extraAllowed: () => rulePatterns("follow", "shell", root).allow,
      regexAllowed: () => regexRulePatterns("follow", root).allow,
      regexAsk: () => regexRulePatterns(ruleModeInForce(), root).ask,
      regexDenied: () => (isNeverAskMode() ? regexRulePatterns("never-ask", root).deny : []),
      extraAsk: () => rulePatterns(ruleModeInForce(), "shell", root).ask,
      extraDenied: () => (isNeverAskMode() ? rulePatterns("never-ask", "shell", root).deny : []),
      allowAll: () => isNeverAskMode(),
      elevationEnabled: () => loadElevationEnabled(),
      jobs,
      onJobsChanged: opts.onJobsChanged,
      onShellOutput: opts.onShellOutput,
      sensitivePaths: cfg.sensitivePaths,
      outputFiltering: cfg.shellOutput?.filtering,
      outputTelemetry: cfg.shellOutput?.telemetry,
      outputRecovery: {
        maxEntryBytes: cfg.shellOutput?.maxRecoveryBytes,
        maxEntries: cfg.shellOutput?.maxRecoveryEntries,
        maxAgeMs:
          cfg.shellOutput?.recoveryDays === undefined
            ? undefined
            : cfg.shellOutput.recoveryDays * 24 * 60 * 60 * 1000,
      },
    });
    registerMemoryTools(tools, { projectRoot: root });
    registerRulesTools(tools, {
      rootDir: root,
      configPath: opts.configPath,
      onRulesChanged: opts.onRulesChanged,
    });
    registerCodeQueryTools(tools, { rootDir: root });
  };

  registerRooted(opts.rootDir);
  registerPlanTool(tools);
  registerChoiceTool(tools);
  registerTodoTool(tools);
  registerWaitTool(tools);
  // Keep the handler stable for the tab's lifetime. A model switch can happen
  // after a model has emitted a see_image call but before dispatch starts, so
  // capability changes must never unregister an in-flight call's target.
  registerSeeImageTool(tools, { rootDir: opts.rootDir });
  registerScreenCaptureTool(tools, { rootDir: opts.rootDir });
  registerComputerUseTool(tools);
  registerScaffoldTools(tools, {
    projectRoot: opts.rootDir,
    getMcpSpecs: opts.getMcpSpecs,
    getMcpToolSkips: opts.getMcpToolSkips,
  });
  // OAuth-only: image generation bills the user's ChatGPT/OpenAI plan, so it is
  // registered solely when an OpenAI OAuth session is present.
  if (hasOpenAIOAuthSession(opts.configPath)) {
    registerImageGenTool(tools, { rootDir: opts.rootDir, configPath: opts.configPath });
  }
  if (searchEnabled()) {
    registerWebTools(tools);
  }
  // Lazy per-model: constructing DeepSeekClient throws when the provider's API
  // key is unset, which would kill `reasonix code` before the setup wizard can
  // prompt for one. Defer to first spawn, keyed by resolved model id so a model
  // switch mid-session routes the next child to the right endpoint.
  const subagentClients = new Map<string, DeepSeekClient>();
  const subagentClientFor = (model: string): DeepSeekClient => {
    let client = subagentClients.get(model);
    if (!client) {
      client = createModelClient({ model, configPath: opts.configPath });
      subagentClients.set(model, client);
    }
    return client;
  };
  // The one subagent tool. Everything the child runs with comes from this tab: model
  // (live getter), billing unit, loop policy, hooks and cwd, resolved at spawn time.
  const registerSpawnTool = (enabled: boolean): void => {
    if (!enabled) {
      tools.unregister("spawn_subagent");
      return;
    }
    registerSubagentTool(tools, {
      client: subagentClientFor,
      configPath: opts.configPath,
      projectRoot: opts.rootDir,
      defaultModel: () => opts.subagentModel?.() ?? DEFAULT_MODEL,
      effort: opts.subagentEffort,
      inherited: opts.subagentLoopOptions,
      // Late-bound: the TUI's `useSubagent` writes the live callback into
      // SHARED_SUBAGENT_SINK after mount. Until then `.current` is null
      // and the events are silently dropped — that's fine for non-TUI callers.
      sink: opts.subagentSink ?? SHARED_SUBAGENT_SINK,
    });
  };
  registerSpawnTool(opts.subagentsEnabled === true);

  opts.onPhase?.("tool_registration_completed");
  return {
    tools,
    jobs,
    registerRooted,
    syncSubagentTools: registerSpawnTool,
  };
}
