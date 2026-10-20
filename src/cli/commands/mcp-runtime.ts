import { loadEffectiveMcpConfig } from "../../config.js";
import { formatMcpLifecycleEvent } from "../../desktop/mcp-lifecycle.js";
import type { McpLifecycleEvent } from "../../desktop/mcp-lifecycle.js";
import { formatMcpSlowToast } from "../../desktop/mcp-toast.js";
import { t } from "../../i18n/index.js";
import type { CacheFirstLoop } from "../../loop.js";
import { McpClient } from "../../mcp/client.js";
import { withPlaywrightWorkspaceProfile } from "../../mcp/extension.js";
import { isGmailMailSpec, resolveGmailToken } from "../../mcp/gmail-mail.js";
import { type InspectionReport, inspectMcpServer } from "../../mcp/inspect.js";
import {
  OUTLOOK_ATTACHMENT_TOOLS,
  hydrateOutlookAttachments,
} from "../../mcp/outlook-attachments.js";
import {
  OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS,
  confirmOutlookSend,
  isOutlookConfirmedSendTool,
  isOutlookMailSpec,
  isOutlookReadOnlyTool,
  isOutlookSendCapableTool,
  managedMcpToolsHiddenFromModel,
  mcpTextResult,
  outlookAttachmentGuidance,
} from "../../mcp/outlook-mail.js";
import {
  ensurePlaywrightTooling,
  isPlaywrightSpec,
  playwrightDescriptionSuffix,
  playwrightToolingNotice,
  playwrightWriteLocationNote,
} from "../../mcp/playwright-tooling.js";
import { preflightStdioSpec } from "../../mcp/preflight.js";
import { type McpClientHost, bridgeMcpTools } from "../../mcp/registry.js";
import type { SharedClientRegistry } from "../../mcp/shared-browser.js";
import type { McpServerSpec } from "../../mcp/spec.js";
import {
  getMcpServerEnv,
  getMcpServerHeaders,
  overlayMatchedSpec,
  parseMcpSpec,
  specToRaw,
  stableRecord,
} from "../../mcp/spec.js";
import { buildMcpServerSummary } from "../../mcp/summary.js";
import type { McpServerSummary } from "../../mcp/summary.js";
import { buildTransportFromSpec } from "../../mcp/transport-from-spec.js";
import type { ToolRegistry } from "../../tools.js";
import type { ToolSpec } from "../../types.js";

export interface ProgressInfo {
  toolName: string;
  progress: number;
  total?: number;
  message?: string;
}

interface SpecRecord {
  spec: string;
  client: McpClient;
  summary: McpServerSummary;
  /** Names of bridged tools — used for hot-unbridge. */
  registeredNames: string[];
  /** ToolSpec snapshots captured AFTER bridge — handed to loop.prefix.addTool on hot-add. */
  registeredSpecs: ToolSpec[];
  /** Tools the server listed that the bridge refused or deferred (name collision or spec budget). */
  skipped: Array<{ name: string; reason: string }>;
  /** Fingerprint of the env/headers this bridge was spawned with. A change (e.g.
   *  a rotated extension token) must force a respawn — `specToRaw` omits these,
   *  so a raw-spec diff alone would silently keep a stale bridge. */
  runtimeKey: string;
  /** Set when `client` is a daemon-shared browser client — release instead of close. */
  sharedKey?: string;
}

export interface RuntimeContext {
  getTools: () => ToolRegistry | undefined;
  getMcpPrefix: () => string | undefined;
  getRequestedCount: () => number;
  getWorkspaceDir?: () => string | undefined;
  /** Per-session MCP enablement overlaid on the config default. Omitted (CLI /
   *  tests / sessions with no stored state) leaves the config default untouched. */
  getSpecOverrides?: () => McpSpecOverrides | undefined;
  progressSink: { current: ((info: ProgressInfo) => void) | null };
  /** Daemon-scoped shared clients for browser servers (Playwright) — one client is one browser across tabs. */
  browserRegistry?: SharedClientRegistry;
}

export type McpLifecycleSink = (event: McpLifecycleEvent) => void;

export const stderrLifecycleSink: McpLifecycleSink = (ev) => {
  if (ev.state === "slow") {
    process.stderr.write(
      `${formatMcpSlowToast({ name: ev.serverName, p95Ms: ev.p95Ms, sampleSize: ev.sampleSize })}\n`,
    );
    return;
  }
  if (ev.state === "failed") {
    process.stderr.write(
      `${formatMcpLifecycleEvent(ev)}\n  → ${t("mcpLifecycle.failedSetupHint")}\n`,
    );
    return;
  }
  process.stderr.write(`${formatMcpLifecycleEvent(ev)}\n`);
};

export interface McpFailure {
  spec: string;
  name: string;
  reason: string;
  at: number;
}

export interface McpRuntime {
  size(): number;
  specs(): string[];
  summaries(): McpServerSummary[];
  /** Last bridge failure per spec — drives the "not bridged" reason shown in the dashboard. */
  failures(): McpFailure[];
  /** Tools a server listed that the bridge refused (name owned by another origin) or deferred (spec budget). */
  toolSkips(): Array<{ server: string; name: string; reason: string }>;
  /** Call a server tool directly without registering it in the model-facing tool registry. */
  callServerTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
  addSpec(
    raw: string,
    loop?: CacheFirstLoop,
    signal?: AbortSignal,
  ): Promise<{ ok: true; summary: McpServerSummary } | { ok: false; reason: string }>;
  removeSpec(raw: string, loop?: CacheFirstLoop): Promise<boolean>;
  reloadFromConfig(loop?: CacheFirstLoop): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ spec: string; reason: string }>;
    summaries: McpServerSummary[];
  }>;
  closeAll(): Promise<void>;
  /** Replace the sink that lifecycle events flow through — App.tsx swaps this in on mount so toasts land in the alt-screen UI instead of corrupting it via stderr. */
  setLifecycleSink(sink: McpLifecycleSink): void;
}

/** Identity of the env/headers a bridge was spawned with. The raw spec string
 *  (`specToRaw`) can't carry these, so `reloadFromConfig` must diff them
 *  explicitly to notice a rotated token or changed header and respawn. */
function runtimeFingerprint(spec: McpServerSpec): string {
  return JSON.stringify([
    stableRecord(getMcpServerEnv(spec)),
    stableRecord(getMcpServerHeaders(spec)),
  ]);
}

/** Per-session MCP enablement, absolute — a server is disabled iff named.
 *  Overlaid on the config default by `applyMcpSessionOverrides`. */
export interface McpSpecOverrides {
  disabledServers?: ReadonlySet<string>;
}

/** Overlay a session's absolute MCP state onto specs from config. `overrides`
 *  undefined passes specs through untouched (CLI / tests / legacy sessions); a
 *  present override REPLACES the default — the session owns its set outright. */
export function applyMcpSessionOverrides(
  specs: McpServerSpec[],
  overrides?: McpSpecOverrides,
): McpServerSpec[] {
  if (!overrides) return specs;
  const disabledServers = overrides.disabledServers ?? new Set<string>();
  return specs.map((spec): McpServerSpec => {
    const name = spec.name;
    return {
      ...spec,
      disabled: name ? disabledServers.has(name) : false,
    };
  });
}

export function createMcpRuntime(ctx: RuntimeContext): McpRuntime {
  const records = new Map<string, SpecRecord>();
  const insertionOrder: string[] = [];
  const failureMap = new Map<string, McpFailure>();
  let sink: McpLifecycleSink = stderrLifecycleSink;

  /** Config specs for this workspace with the session's MCP overlay applied. */
  function effectiveConfig(): McpServerSpec[] {
    return applyMcpSessionOverrides(
      loadEffectiveMcpConfig(ctx.getWorkspaceDir?.()),
      ctx.getSpecOverrides?.(),
    );
  }

  async function addSpec(
    raw: string,
    loop?: CacheFirstLoop,
    signal?: AbortSignal,
  ): Promise<{ ok: true; summary: McpServerSummary } | { ok: false; reason: string }> {
    if (records.has(raw)) {
      return { ok: true, summary: records.get(raw)!.summary };
    }
    failureMap.delete(raw);
    const tools = ctx.getTools();
    if (!tools) return { ok: false, reason: "no tool registry available" };
    const normalized = effectiveConfig();
    let label = "anon";
    let mcp: McpClient | undefined;
    let sharedKey: string | undefined;
    // Per-server readiness gate — tool dispatches via the bridge await
    // this before calling into `live.callTool`. Resolved on `connected`,
    // rejected on `failed`, so a tool invoked mid-handshake waits
    // (capped by `bridgeMcpTools`'s `readyTimeoutMs`) instead of
    // surfacing a transport error.
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Avoid unhandledRejection if no consumer awaits `ready` yet.
    ready.catch(() => undefined);
    try {
      const parsed = parseMcpSpec(raw);
      label = parsed.name ?? "anon";
      const matched = parsed.name ? normalized.find((s) => s.name === parsed.name) : undefined;
      const configuredSpec = overlayMatchedSpec(parsed, matched);
      const workspaceDir = ctx.getWorkspaceDir?.();
      const spec = isPlaywrightSpec(configuredSpec)
        ? withPlaywrightWorkspaceProfile(configuredSpec, workspaceDir)
        : configuredSpec;
      if (spec.disabled) {
        sink({ state: "disabled", name: label });
        rejectReady(new Error(`MCP server "${label}" is disabled`));
        failureMap.set(raw, { spec: raw, name: label, reason: "disabled by user", at: Date.now() });
        return { ok: false, reason: "disabled by user" };
      }
      sink({ state: "handshake", name: label });
      const t0 = Date.now();
      const namePrefix = spec.name
        ? `${spec.name}_`
        : ctx.getRequestedCount() === 1 && ctx.getMcpPrefix()
          ? (ctx.getMcpPrefix() as string)
          : "";
      if (spec.transport === "stdio") preflightStdioSpec(spec);
      // Hardcoded playwright tooling contract: guarantee the durable driver +
      // AGENTS.md pair exists (create/upgrade as needed) before any agent
      // touches the browser, and surface the maintenance duty to the agent
      // via the bridge's first-call notice + description pointers.
      const playwrightTooling = isPlaywrightSpec(spec) ? ensurePlaywrightTooling() : undefined;
      // Gmail rotates its bearer token, so it needs a live per-request resolver;
      // every other spec carries its headers statically inside the spec.
      const dynamicHeaders = isGmailMailSpec(spec)
        ? {
            headersResolver: async () => ({
              authorization: `Bearer ${await resolveGmailToken()}`,
            }),
          }
        : {};
      // Every MCP server is daemon-global: one live client per configured spec,
      // shared by all tabs/workspaces (browser servers included), so a new tab
      // attaches to the running process instead of spawning a duplicate.
      let host: McpClientHost;
      let bridgeReady: Promise<void> = ready;
      // The cwd the server actually runs in: a shared client's cwd is fixed by its
      // first acquirer, so tools resolve the cwd-relative paths they report against
      // this value, not the current tab's workspace.
      let bridgeCwd = workspaceDir;
      if (ctx.browserRegistry) {
        const entry = await ctx.browserRegistry.acquire(spec, {
          workspaceDir,
          signal,
          ...dynamicHeaders,
        });
        sharedKey = entry.key;
        mcp = entry.client;
        host = entry.host;
        if (entry.cwd) bridgeCwd = entry.cwd;
        resolveReady();
        bridgeReady = Promise.resolve();
      } else {
        const transport = buildTransportFromSpec(spec, { cwd: workspaceDir, ...dynamicHeaders });
        mcp = new McpClient({ transport, workspaceDir });
        await mcp.initialize({ signal });
        host = { client: mcp };
      }
      const hiddenTools = new Set(managedMcpToolsHiddenFromModel(spec));
      if (isOutlookMailSpec(spec)) {
        const listed = await mcp.listTools();
        for (const tool of listed.tools) {
          if (!isOutlookConfirmedSendTool(tool.name) && isOutlookSendCapableTool(tool.name)) {
            hiddenTools.add(tool.name);
          }
        }
      }
      const disabledTools = new Set([
        ...(isOutlookMailSpec(spec) ? OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS : []),
        ...hiddenTools,
      ]);
      const bridge = await bridgeMcpTools(mcp, {
        registry: tools,
        namePrefix,
        serverName: label,
        host,
        ready: bridgeReady,
        disabledTools,
        ...(isOutlookMailSpec(spec)
          ? {
              beforeCall: (toolName, args, toolContext) =>
                confirmOutlookSend({
                  toolName,
                  args,
                  client: host.client,
                  gate: toolContext?.confirmationGate,
                }),
              transformArgs: (toolName, args) =>
                hydrateOutlookAttachments(toolName, args, { workspaceDir }),
              descriptionSuffix: (toolName) =>
                OUTLOOK_ATTACHMENT_TOOLS.has(toolName) ? outlookAttachmentGuidance : undefined,
              readOnlyTool: isOutlookReadOnlyTool,
            }
          : {}),
        ...(playwrightTooling
          ? {
              toolingNotice: playwrightToolingNotice(playwrightTooling),
              descriptionSuffix: playwrightDescriptionSuffix(playwrightTooling),
              // Playwright reports written files cwd-relative; always append their
              // absolute location so see_image (and the user) can read them back.
              transformResult: (_toolName: string, text: string, args: Record<string, unknown>) => {
                const note = playwrightWriteLocationNote(args, text, bridgeCwd);
                return note ? `${text}\n\n${note}` : text;
              },
            }
          : {}),
        onProgress: (info) => ctx.progressSink.current?.(info),
        onSlow: (info) =>
          sink({
            state: "slow",
            serverName: info.serverName,
            p95Ms: info.p95Ms,
            sampleSize: info.sampleSize,
          }),
      });
      // Tools are registered — record the bridge NOW so the UI shows
      // "bridged" even if later non-critical steps (inspect, hot-add) fail.
      const ms = Date.now() - t0;
      const allSpecs = tools.specs();
      const registeredSpecs = allSpecs.filter((s) =>
        bridge.registeredNames.includes(s.function.name),
      );
      // Create a provisional record immediately (tools already usable).
      records.set(raw, {
        spec: raw,
        client: mcp,
        summary: buildMcpServerSummary({
          label,
          spec: raw,
          toolCount: bridge.registeredNames.length,
          report: {
            protocolVersion: mcp.protocolVersion,
            serverInfo: mcp.serverInfo,
            capabilities: mcp.serverCapabilities ?? {},
            tools: { supported: true, items: [] },
            resources: { supported: false, reason: "still inspecting" },
            prompts: { supported: false, reason: "still inspecting" },
            elapsedMs: ms,
          },
          host,
          bridgeEnv: bridge.env,
        }),
        registeredNames: bridge.registeredNames,
        registeredSpecs,
        runtimeKey: runtimeFingerprint(spec),
        sharedKey,
        skipped: bridge.skipped,
      });
      insertionOrder.push(raw);
      resolveReady();
      sink({
        state: "tools-ready",
        name: label,
        tools: bridge.registeredNames.length,
        ms,
      });
      // Refusals and deferrals would otherwise be invisible: the dashboard shows "connected".
      if (bridge.skipped.length > 0) {
        const preview = bridge.skipped
          .slice(0, 3)
          .map((s) => `${s.name} (${s.reason})`)
          .join("; ");
        const extra = bridge.skipped.length > 3 ? ` and ${bridge.skipped.length - 3} more` : "";
        sink({
          state: "warn",
          name: label,
          reason: `${bridge.skipped.length} tool(s) not bridged: ${preview}${extra}`,
        });
      }

      // Non-critical: inspect + hot-add. Failures here don't un-bridge.
      let report: InspectionReport;
      try {
        report = await inspectMcpServer(mcp);
      } catch {
        report = {
          protocolVersion: mcp.protocolVersion,
          serverInfo: mcp.serverInfo,
          capabilities: mcp.serverCapabilities ?? {},
          tools: { supported: true, items: [] },
          resources: { supported: false, reason: "inspect failed" },
          prompts: { supported: false, reason: "inspect failed" },
          elapsedMs: 0,
        };
      }
      const resourceCount = report.resources.supported ? report.resources.items.length : 0;
      const promptCount = report.prompts.supported ? report.prompts.items.length : 0;
      // Re-emit with full inspection data (the provisional event reported 0).
      sink({
        state: "connected",
        name: label,
        tools: bridge.registeredNames.length,
        resources: resourceCount,
        prompts: promptCount,
        ms,
      });
      const summary = buildMcpServerSummary({
        label,
        spec: raw,
        toolCount: bridge.registeredNames.length,
        report,
        host,
        bridgeEnv: bridge.env,
      });
      // Replace the provisional record with the fully-inspected summary.
      records.set(raw, {
        spec: raw,
        client: mcp,
        summary,
        registeredNames: bridge.registeredNames,
        registeredSpecs,
        runtimeKey: runtimeFingerprint(spec),
        sharedKey,
        skipped: bridge.skipped,
      });
      // Hot-add: shift the prefix so the live loop sees the new tools
      // on the very next turn. Each addTool is one cache-miss turn.
      if (loop)
        for (const s of registeredSpecs)
          try {
            // false (not a throw) means the prefix already holds that name, so the model cannot see this tool.
            if (!loop.prefix.addTool(s)) {
              sink({
                state: "warn",
                name: label,
                reason: `prompt prefix already holds a tool named ${s.function.name}, so this bridged tool stays hidden from the model`,
              });
            }
          } catch (err) {
            sink({
              state: "warn",
              name: label,
              reason: `addTool failed for ${s.function.name}: ${(err as Error).message}`,
            });
          }
      return { ok: true, summary };
    } catch (err) {
      // If we got far enough to create a provisional record, keep it —
      // tools are already registered and usable even after a late failure.
      const reason = (err as Error).message;
      if (!records.has(raw)) {
        if (sharedKey && ctx.browserRegistry) await ctx.browserRegistry.release(sharedKey);
        else await mcp?.close().catch(() => undefined);
        rejectReady(new Error(`MCP server "${label}" failed to start: ${reason}`));
        sink({ state: "failed", name: label, reason });
        failureMap.set(raw, { spec: raw, name: label, reason, at: Date.now() });
        return { ok: false, reason };
      }
      sink({ state: "warn", name: label, reason });
      return { ok: true, summary: records.get(raw)!.summary };
    }
  }

  async function removeSpec(raw: string, loop?: CacheFirstLoop): Promise<boolean> {
    failureMap.delete(raw);
    const record = records.get(raw);
    if (!record) return false;
    if (record.sharedKey && ctx.browserRegistry) {
      await ctx.browserRegistry.release(record.sharedKey);
    } else {
      await record.client.close().catch(() => undefined);
    }
    const tools = ctx.getTools();
    for (const name of record.registeredNames) {
      tools?.unregister(name);
      loop?.prefix.removeTool(name);
    }
    records.delete(raw);
    const idx = insertionOrder.indexOf(raw);
    if (idx >= 0) insertionOrder.splice(idx, 1);
    return true;
  }

  async function reloadFromConfig(loop?: CacheFirstLoop): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ spec: string; reason: string }>;
    summaries: McpServerSummary[];
  }> {
    const normalized = effectiveConfig();
    const desiredMap = new Map<string, McpServerSpec>();
    const desired: string[] = [];
    for (const spec of normalized) {
      const raw = specToRaw(spec);
      desiredMap.set(raw, spec);
      desired.push(raw);
    }
    const desiredSet = new Set(desired);
    const currentSet = new Set(records.keys());
    const added: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ spec: string; reason: string }> = [];

    for (const spec of [...currentSet]) {
      const next = desiredMap.get(spec);
      if (!next) {
        // Removed from config entirely.
        await removeSpec(spec, loop);
        removed.push(spec);
        continue;
      }
      if (next.disabled) {
        // Config-disabled while live — stop it; still configured, so not "removed".
        const label = records.get(spec)?.summary.label ?? "?";
        await removeSpec(spec, loop);
        failureMap.set(spec, {
          spec,
          name: label,
          reason: "disabled by user",
          at: Date.now(),
        });
        continue;
      }
      // Env/header change while live (e.g. a rotated extension token) — the raw
      // spec string can't carry these, so respawn so the bridge picks them up.
      const record = records.get(spec)!;
      if (runtimeFingerprint(next) !== record.runtimeKey) {
        await removeSpec(spec, loop);
        const respawned = await addSpec(spec, loop);
        if (!respawned.ok) failed.push({ spec, reason: respawned.reason });
      }
    }
    for (const spec of desired) {
      if (currentSet.has(spec)) continue;
      const result = await addSpec(spec, loop);
      if (result.ok) added.push(spec);
      else failed.push({ spec, reason: result.reason });
    }
    return { added, removed, failed, summaries: summaries() };
  }

  function specs(): string[] {
    return [...insertionOrder];
  }
  function summaries(): McpServerSummary[] {
    return insertionOrder
      .map((s) => records.get(s)?.summary)
      .filter((s): s is McpServerSummary => Boolean(s));
  }
  async function closeAll(): Promise<void> {
    for (const r of records.values()) {
      if (r.sharedKey && ctx.browserRegistry) {
        await ctx.browserRegistry.release(r.sharedKey);
      } else {
        await r.client.close().catch(() => undefined);
      }
    }
    records.clear();
    insertionOrder.length = 0;
    failureMap.clear();
  }
  function failures(): McpFailure[] {
    return [...failureMap.values()];
  }
  function toolSkips(): Array<{ server: string; name: string; reason: string }> {
    const out: Array<{ server: string; name: string; reason: string }> = [];
    for (const record of records.values()) {
      for (const skip of record.skipped) {
        out.push({ server: record.summary.label, name: skip.name, reason: skip.reason });
      }
    }
    return out;
  }
  async function callServerTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const record = [...records.values()].find(
      (candidate) => candidate.summary.label === serverName,
    );
    if (!record) throw new Error(`MCP server "${serverName}" is not connected`);
    const result = await record.client.callTool(toolName, args, { signal });
    return mcpTextResult(result);
  }
  function setLifecycleSink(s: McpLifecycleSink): void {
    sink = s;
  }
  return {
    size: () => records.size,
    specs,
    summaries,
    failures,
    toolSkips,
    callServerTool,
    addSpec,
    removeSpec,
    reloadFromConfig,
    closeAll,
    setLifecycleSink,
  };
}
