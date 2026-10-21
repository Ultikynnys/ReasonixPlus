import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stdin } from "node:process";
import { createInterface } from "node:readline";
import {
  ANTIGRAVITY_MODELS,
  MAX_IMAGE_BYTES,
  MAX_MEDIA_BYTES,
  MailProvider,
  PLAN_INTERACTIVE_TOOL_NAMES,
  type PersistedNotice,
  compactionCardText,
  flattenText,
  isUsableAntigravityModel,
  mediaKindForPath,
  mediaMimeForExtension,
  messageOf,
  redactDiagnosticText,
  redactDiagnosticValue,
  scanImageMentions,
  sleep,
  stripMentionTokens,
  tailLines,
  toApprovalPrompt,
} from "@reasonix/core-utils";
import type {
  AntigravityQuota,
  BalanceEvent,
  BtwResultEvent,
  ChangelogEvent,
  CheckpointRequiredEvent,
  ChoiceRequiredEvent,
  CodexQuota,
  ConfirmRequiredEvent,
  CtxBreakdownEvent,
  DesktopDiagnosticEvent,
  DirectKernelWireEvent,
  EditRequiredEvent,
  JobInfo,
  JobsEvent,
  LoadedMessage,
  LoadedSegment,
  MailAuthEvent,
  MailAuthState,
  McpExtensionCheckEvent,
  McpExtensionStatus,
  McpExtensionStatusEvent,
  McpSpecInfo,
  McpSpecStatus,
  McpSpecsEvent,
  MemoryDetailEvent,
  MemoryEvent,
  MemoryResultEvent,
  MentionPreviewEvent,
  MentionResultsEvent,
  MiMoQuota,
  ModelEndpointInfo,
  NeedsSetupEvent,
  OllamaModelsEvent,
  OpencodeModelsEvent,
  OpencodeQuota,
  PathAccessRequiredEvent,
  PlanClearedEvent,
  PlanHistoryItem,
  PlanRequiredEvent,
  PlanRestoredEvent,
  PlanStep,
  PlaywrightBrowserInstallEvent,
  RetryResultEvent,
  RevisionRequiredEvent,
  SessionBoundEvent,
  SessionEmptyEvent,
  SessionHistoryEvent,
  SessionLoadedEvent,
  SessionRetractedEvent,
  SessionsEvent,
  SettingsEvent,
  SkillsEvent,
  StepCompletedEvent,
  TabClosedEvent,
  TabOpenedEvent,
  TabStatusEvent,
  TabsSnapshotEvent,
  TurnCompleteEvent,
  TurnOutcome,
  TurnStartedEvent,
  UserImageAttachment,
  WorkspaceInitializedEvent,
  ZaiQuota,
  ZaiQuotaWindow,
} from "@reasonix/core-utils";
import {
  type FileWithStats,
  listDirectory,
  listFilesWithStatsAsync,
  parseAtQuery,
  rankPickerCandidates,
} from "../../at-mentions.js";
import { fetchChangelog } from "../../changelog.js";
import { pickPrimaryBalance } from "../../client.js";
import { claimingSession, setLiveSessionProbe } from "../../code/plan-claim.js";
import { type PlanRecord, planRepository } from "../../code/plans.js";
import { codeSystemPrompt } from "../../code/prompt.js";
import { type CodeToolset, applyPlanMode, buildCodeToolset } from "../../code/setup.js";
import { fetchCodexQuotaViaOAuth } from "../../codex-backend.js";
import {
  DEFAULT_GEMINI_CHAT_URL,
  DEFAULT_MIMO_CHAT_URL,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_CHAT_URL,
  DEFAULT_OPENCODE_CHAT_URL,
  DEFAULT_ZAI_CHAT_URL,
  type EditMode,
  type McpServerConfig,
  type ModelProvider,
  OPENCODE_MODELS,
  type ReasonixConfig,
  SUPPORTED_MODELS,
  addGlobalPathAllowed,
  addGlobalShellAllowed,
  addProjectPathAllowed,
  addProjectShellAllowed,
  addRule,
  anyProviderConfigured,
  bridgeEndpointEnv,
  clearMimoApiKey,
  copyWorkspaceRules,
  deriveNativeOllamaOrigin,
  hasOpencodeCredential,
  isOpenAIStandardEndpoint,
  isPlausibleKey,
  isReasoningEffort,
  listWorkspacesWithRules,
  loadAllPathAllowed,
  loadAllShellAllowed,
  loadApiKey,
  loadAutoCompact,
  loadBraveApiKey,
  loadCatalogEndpoint,
  loadContextTokens,
  loadCustomQuickSends,
  loadDesktopOpenTabs,
  loadDuplicateSessionAutoProceed,
  loadDuplicateSessionTokens,
  loadEditMode,
  loadEffectiveMcpConfig,
  loadElevationEnabled,
  loadEnabledModels,
  loadEndpoint,
  loadEndpointForModel,
  loadExaApiKey,
  loadFallbackModels,
  loadFeedbackCues,
  loadGlobalPathAllowed,
  loadGlobalShellAllowed,
  loadMaxIterPerTurn,
  loadMaxOutputTokens,
  loadMetasoApiKey,
  loadMimoKeyName,
  loadModel,
  loadOllamaEndpoint,
  loadOllamaGenerationOverrides,
  loadOllamaGenerationSettings,
  loadOpencodeApiKey,
  loadPerplexityApiKey,
  loadProjectPathAllowed,
  loadProjectShellAllowed,
  loadProviderApiKeys,
  loadQuestionTimerEnabled,
  loadQuickSendId,
  loadReasoningEffort,
  loadRecentWorkspaces,
  loadRepetitionGuardEnabled,
  loadResolvedModelEndpoint,
  loadResolvedSkillPaths,
  loadRules,
  loadSearchApiKeys,
  loadSearchSetting,
  loadSubagentModels,
  loadTavilyApiKey,
  loadWorkspaceDir,
  loadZaiApiKey,
  mergeMcpServerEntry,
  modelAcceptsImages,
  modelUsableFor,
  pickFallbackModel,
  providerForModel,
  providerSettingFromStore,
  pushRecentWorkspace,
  readConfig,
  webSearchEngine as readWebSearchEngine,
  removeGlobalPathAllowed,
  removeGlobalShellAllowed,
  removeProjectPathAllowed,
  removeProjectShellAllowed,
  removeRecentWorkspace,
  removeRule,
  saveAntigravityOAuth,
  saveApiKey,
  saveAutoCompact,
  saveAutoCompactTrigger,
  saveBaseUrl,
  saveContextTokens,
  saveCustomQuickSends,
  saveDesktopOpenTabs,
  saveDuplicateSessionAutoProceed,
  saveDuplicateSessionTokens,
  saveEditMode,
  saveElevationEnabled,
  saveEnabledModels,
  saveFallbackModels,
  saveFeedbackCues,
  saveGmailOAuth,
  saveMailProvider,
  saveMaxIterPerTurn,
  saveMimoCredential,
  saveModel,
  saveOllamaGenerationPatch,
  saveOpenAIApiKey,
  saveOpenAIOAuth,
  saveOpencodeOAuth,
  saveQuestionTimerEnabled,
  saveQuickSendId,
  saveReasoningEffort,
  saveRepetitionGuardEnabled,
  saveWorkspaceDir,
  searchSettingFromConfig,
  setMcpServerDisabled,
  setProviderSetting,
  setSearchSetting,
  supportedReasoningEfforts,
  updateRule,
  writeConfig,
} from "../../config.js";
import { ConcurrencyGate } from "../../core/concurrency-gate.js";
import { redactEventValue } from "../../core/event-redaction.js";
import { Eventizer } from "../../core/eventize.js";
import { EventType } from "../../core/events.js";
import type { Event as KernelEvent, SubagentProgressEvent } from "../../core/events.js";
import { pauseGate } from "../../core/pause-gate.js";
import { autoResolveVerdict } from "../../core/pause-policy.js";
import { AccountQuotaCoordinator } from "../../desktop/account-quota.js";
import { augmentProcessPath } from "../../desktop/login-shell-path.js";
import {
  collectMemoryEntriesForWorkspace,
  deleteMemoryEntry,
  readMemoryEntryDetail,
  writeMemoryEntry,
} from "../../desktop/memory-browser.js";
import { toPlanHistoryItems } from "../../desktop/plan-listing.js";
import {
  type QuotaCoordinator,
  type QuotaOutcome,
  fetchQuotaJson,
  quotaCacheKey,
  quotaCoordinator,
  resetQuotaCoordinators,
  scopedQuotaCoordinator,
  usageUrls,
} from "../../desktop/quota.js";
import { toSessionListItems } from "../../desktop/session-listing.js";
import { MAX_OPEN_TABS, pickTabToEvict } from "../../desktop/tab-cap.js";
import { recordDiagnostic } from "../../diagnostics.js";
import { buildDuplicateContext } from "../../duplicate-session.js";
import { normalizeImageToDataUrls } from "../../image-format.js";
import { supervisePlaywrightInstaller } from "../../mcp/browser-installer.js";
import {
  PLAYWRIGHT_DOWNLOAD_HOST_ENV,
  PLAYWRIGHT_EXTENSION_ARG,
  PLAYWRIGHT_EXTENSION_STORE_URL,
  PLAYWRIGHT_EXTENSION_TOKEN_ENV,
  configurePlaywrightArgs,
  createPlaywrightProgressParser,
  installFromPlaywrightDownloadSources,
  isPlaywrightBrowserInstalled,
  isPlaywrightDownloadableBrowser,
  isPlaywrightManagedBrowser,
  normalizeExtensionToken,
  parsePlaywrightConnection,
  playwrightBrowserInstallArgs,
  playwrightBrowserInstallEnv,
} from "../../mcp/extension.js";
import { ensureNpxAvailable } from "../../mcp/node-runtime.js";
import { quoteArg } from "../../mcp/stdio.js";
import { BUILTIN_ALLOWLIST } from "../../tools/shell/parse.js";
import { coveredRuleScopes } from "../../tools/shell/rule-scope.js";

import {
  PROVIDER_SPECS,
  type ProviderProbeStrategy,
  type ProviderSettingsMap,
  type ProviderUsage,
  type ProviderUsageEvent,
  type ProviderUsageView,
  SEARCH_ENGINE_SPECS,
  type SearchSettingsMap,
  antigravityUsageView,
  codexUsageView,
  mimoUsageView,
  ollamaUsageView,
  opencodeUsageView,
  parseProviderSettingsPatch,
  parseSearchSettingsPatch,
  providerDefaultEndpoint,
  providerSpec,
  providerString,
  searchEngineSpec,
  searchSettingSpec,
  searchSharedCredential,
  usageMinIntervalMs,
  zaiUsageView,
} from "@reasonix/core-utils";
import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  antigravityAccount,
  beginAntigravityOAuthFlow,
  fetchAntigravityModels,
  fetchAntigravityQuota,
  onboardAntigravity,
  resolveGeminiAuth,
  signOutAntigravity,
} from "../../antigravity-oauth.js";
import { type ResolvedHook, formatHookOutcomeMessage, loadHooks, runHooks } from "../../hooks.js";
import { t } from "../../i18n/index.js";
import {
  CacheFirstLoop,
  ImmutablePrefix,
  type LoopAbortOptions,
  type LoopEvent,
} from "../../index.js";
import { createLogger } from "../../logging.js";
import { isContextOverflowError } from "../../loop/errors.js";
import { MCP_CATALOG, catalogStdioCommand } from "../../mcp/catalog.js";
import {
  GMAIL_MAIL_SERVER_NAME,
  GMAIL_MCP_URL,
  GMAIL_OAUTH_REDIRECT_URI,
  beginGmailOAuthFlow,
  isGmailMailSpec,
  resolveGmailToken,
  signOutGmail,
} from "../../mcp/gmail-mail.js";
import {
  OUTLOOK_MAIL_ARGS,
  OUTLOOK_MAIL_SERVER_NAME,
  isOutlookMailSpec,
  parseOutlookDeviceCode,
  parseOutlookLoginStatus,
} from "../../mcp/outlook-mail.js";
import { isPlaywrightSpec } from "../../mcp/playwright-tooling.js";
import { SharedClientRegistry } from "../../mcp/shared-browser.js";
import { type McpServerSpec, parseMcpSpec, specToRaw } from "../../mcp/spec.js";
import {
  type ModelPrefs,
  type SessionInfo,
  type SessionMcpState,
  type SessionMeta,
  appendSessionMessage,
  deleteSession,
  deleteSessions,
  ensureSessionDir,
  firstFreeSessionName,
  listSessionNamesForWorkspaceAsync,
  listSessionsForWorkspaceAsync,
  loadSessionEvents,
  loadSessionMessages,
  loadSessionMessagesAsync,
  loadSessionMeta,
  loadSessionNotices,
  migrateLegacyFlatSessions,
  normalizeSessionMcpState,
  normalizeWorkspace,
  patchSessionMeta,
  patchSessionWorkspaceIfMissing,
  prunePendingMcpSessions,
  resolveSessionModelPrefs,
  sessionExists,
  sessionNoticesPath,
  sessionPath,
  sessionSubagentsEnabled,
  sessionUiEventsPath,
  stampSessionWorkspace,
  timestampSuffix,
  writeSessionEvents,
  writeSessionNotices,
} from "../../memory/session.js";
import { type MiMoLoginFlow, beginMiMoLoginFlow, mimoPlatform } from "../../mimo-auth.js";
import { fetchMiMoQuota, readMiMoConsoleSession } from "../../mimo-quota.js";
import { createModelClient } from "../../model-client.js";
import { type OAuthFlow, beginOAuthFlow, oauthAccount, signOutOpenAI } from "../../oauth.js";
import {
  contextTokensForModel,
  loadOllamaVerdicts,
  ollamaVerdictsPath,
  partitionByVerdicts,
  resolveOllamaModelDefaults,
  saveOllamaVerdicts,
  scopeKeyFor,
  setVerdict,
  showPayloadContextLength,
  showPayloadParameters,
  verdictFor,
  visionModelsFor,
} from "../../ollama-model-map.js";
import { loadOllamaModelsCache, saveOllamaModelsCache } from "../../ollama-models-cache.js";
import { fetchOpencodeModels, opencodeUsagePlan } from "../../opencode-models.js";
import {
  type OpencodeDeviceFlow,
  beginOpencodeDeviceFlow,
  resolveOpencodeToken,
  signOutOpencode,
} from "../../opencode-oauth.js";
import { fetchOpencodeQuota } from "../../opencode-quota.js";
import {
  type CatalogProvider,
  type ProviderCatalog,
  fetchProviderModels,
} from "../../provider-models.js";
import type { SubagentEvent } from "../../tools/subagent.js";

import { SkillStore } from "../../skills.js";
import {
  commandOutputTelemetryPath,
  summarizeCommandOutputMetrics,
} from "../../telemetry/command-output.js";
import { billingContextForModel, resolveContextTokens } from "../../telemetry/stats.js";
import { countTokensBounded } from "../../tokenizer.js";
import type { ChoiceOption } from "../../tools/choice.js";
import type { StepCompletion } from "../../tools/plan.js";
import type { ChatMessage, TurnImage } from "../../types.js";
import { VERSION, reasonixDefaultWorkspaceDir, reasonixInstallDir } from "../../version.js";
import { dumpStartupProfile, markPhase } from "../startup-profile.js";
import {
  type McpRuntime,
  type McpSpecOverrides,
  applyMcpSessionOverrides,
  createMcpRuntime,
} from "./mcp-runtime.js";

export interface DesktopOptions {
  model: string;
  /** Root directory the agent's filesystem tools operate inside. Defaults to cwd. */
  dir?: string;
}

export function desktopUserAbortLoopOptions(): LoopAbortOptions | undefined {
  // User-facing Abort stops generation; it must not erase a prompt that remains visible in chat.
  return undefined;
}

/** The one place that races a promise against an abort signal: resolves
 *  `{ aborted }` plus the settled `value` when it won. Frees a wait with no
 *  interrupt of its own (the fold, the MCP bridge) the moment Stop fires. */
function raceAbort<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal?.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve({ aborted: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Race the generator's next event against the aborter — resolves `null` on
 * abort even while the loop is suspended (the fold is non-interruptible).
 * Exported for tests. */
export function raceLoopStep(
  gen: AsyncGenerator<LoopEvent>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<LoopEvent> | null> {
  return raceAbort(gen.next(), signal).then((r) => (r.aborted ? null : r.value));
}

/** Await a promise but unblock the instant `signal` fires: `true` when the
 *  promise settled, `false` when aborted. Exported for tests. */
export function abortableWait(
  p: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return raceAbort(p, signal).then(
    (r) => !r.aborted,
    () => true,
  );
}

/** Route a desktop Stop to the exact tool card that supplied its callId
 *  (parallel chunks run several at once), else the most recent tool. Exported
 *  for tests. */
export function cancelToolFromDesktop(
  loop:
    | {
        cancelToolCall: (callId: string, reason: string) => void;
        cancelCurrentTool: (reason: string) => void;
      }
    | null
    | undefined,
  callId: string | undefined,
  reason: string,
): void {
  if (!loop) return;
  if (callId) loop.cancelToolCall(callId, reason);
  else loop.cancelCurrentTool(reason);
}

/** Resolve the registry that owns `jobId`. With a `tabId`, only that tab is
 *  consulted: per-tab ids restart at 1, so a global first-match can hit a
 *  different tab's job and no-op. Exported for tests. */
export function pickJobOwner<T>(
  owners: ReadonlyArray<{ tabId: string; jobIds: ReadonlySet<number>; owner: T }>,
  jobId: number,
  tabId: string | undefined,
): T | undefined {
  for (const o of owners) {
    if (tabId !== undefined && o.tabId !== tabId) continue;
    if (o.jobIds.has(jobId)) return o.owner;
  }
  return undefined;
}

type InMessage = import("@reasonix/core-utils").OutgoingCommand;

/** Direct fd write — bypasses Node's stream layer (and its piped-output
 *  block buffering) so every JSON line reaches Rust the moment it's
 *  produced, not whenever the next 8 KB flushes. */
type KernelWireBridgeEvent = DirectKernelWireEvent | SessionRetractedEvent;

export type EmittableEvent =
  | KernelWireBridgeEvent
  | { type: "$connected" }
  | { type: "$ready" }
  | { type: "$error"; message: string }
  | { type: "$notice"; text: string; severity: "info" | "success" | "warning" | "error" }
  | TurnCompleteEvent
  | TurnStartedEvent
  | TabStatusEvent
  | DesktopDiagnosticEvent
  | { type: "oauth_begin_result"; url: string }
  | { type: "gemini_oauth_begin_result"; url: string }
  | { type: "opencode_oauth_begin_result"; url: string; userCode: string }
  | { type: "mimo_oauth_begin_result"; url: string }
  | ConfirmRequiredEvent
  | PathAccessRequiredEvent
  | EditRequiredEvent
  | ChoiceRequiredEvent
  | PlanRequiredEvent
  | CheckpointRequiredEvent
  | RevisionRequiredEvent
  | StepCompletedEvent
  | PlanClearedEvent
  | import("@reasonix/core-utils").PlanHistoryEvent
  | import("@reasonix/core-utils").PlanDetailEvent
  | PlanRestoredEvent
  | SessionsEvent
  | SessionBoundEvent
  | SessionLoadedEvent
  | SessionHistoryEvent
  | SessionEmptyEvent
  | NeedsSetupEvent
  | SettingsEvent
  | BalanceEvent
  | ProviderUsageEvent
  | OllamaModelsEvent
  | OpencodeModelsEvent
  | ChangelogEvent
  | MentionResultsEvent
  | MentionPreviewEvent
  | RetryResultEvent
  | BtwResultEvent
  | TabOpenedEvent
  | TabClosedEvent
  | WorkspaceInitializedEvent
  | TabsSnapshotEvent
  | McpSpecsEvent
  | import("@reasonix/core-utils").McpSetupEvent
  | McpExtensionStatusEvent
  | McpExtensionCheckEvent
  | MailAuthEvent
  | PlaywrightBrowserInstallEvent
  | SkillsEvent
  | CtxBreakdownEvent
  | MemoryEvent
  | MemoryDetailEvent
  | MemoryResultEvent
  | JobsEvent;

const STDOUT_BACKPRESSURE_WAIT = new Int32Array(new SharedArrayBuffer(4));

type SyncWriter = (fd: number, buffer: Buffer, offset: number, length: number) => number;

const SESSION_TITLE_MAX_CHARS = 200;

/** Refusal for any session command a workspace-less (pending) tab can't honor.
 *  One wording so the two silent-`return` paths can't drift apart. */
export const NO_WORKSPACE_MESSAGE =
  "This tab has no workspace yet. Pick or open a workspace, then try again.";

/** A tab can only mint or clone a session once it has a workspace: a pending
 *  tab has no rootDir, and both commands would otherwise return in silence.
 *  Exported for tests. */
export function tabNeedsWorkspace(tab: { pending: boolean; rootDir: string }): boolean {
  return tab.pending || !tab.rootDir;
}

/** Trim + cap a user-provided session title; empty string means "clear summary". Exported for tests. */
export function normalizeSessionTitle(raw: string): string {
  return flattenText(raw).slice(0, SESSION_TITLE_MAX_CHARS);
}

/** A channel holding the deleted session must be detached before the refreshed list
 *  is emitted, so the UI never sits in a session that no longer exists. */
export function shouldDetachDeletedSession(
  currentSession: string,
  deletedSession: string,
  deleted: boolean,
): boolean {
  return deleted && currentSession === deletedSession;
}

/** Sessions whose channel has a turn in flight. Deleting one would abort work the
 *  user is waiting on, so every delete path refuses them. */
export function sessionsWithLiveTurn(
  channels: Iterable<{ currentSession: string; aborter: unknown }>,
): Set<string> {
  const running = new Set<string>();
  for (const channel of channels) {
    if (channel.aborter !== null && channel.currentSession) running.add(channel.currentSession);
  }
  return running;
}

/** The names a delete may touch: never one with a live turn. */
export function deletableSessionNames(
  names: Iterable<string>,
  running: ReadonlySet<string>,
): string[] {
  const deletable: string[] = [];
  for (const name of names) if (!running.has(name)) deletable.push(name);
  return deletable;
}

/** Why a delete was refused, in one wording every delete path shares. */
export function sessionRunningRefusal(name: string): string {
  return `Session "${name}" is running. Stop its agent first, then delete it.`;
}

/** Refusal for a second creation in a workspace that is already minting one. */
export const SESSION_CREATION_IN_FLIGHT_MESSAGE =
  "A session is already being created in this workspace. Wait for it to appear.";

/** One in-flight session creation per workspace. `tryEnter` refusing is the whole
 *  point: the second half of a double action must not mint a second session. */
export function newSessionCreationGate(): {
  tryEnter: (workspaceDir: string) => boolean;
  leave: (workspaceDir: string) => void;
  isBusy: (workspaceDir: string) => boolean;
} {
  const inFlight = new Set<string>();
  return {
    tryEnter(workspaceDir) {
      const key = workspaceKey(workspaceDir);
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    leave(workspaceDir) {
      inFlight.delete(workspaceKey(workspaceDir));
    },
    isBusy(workspaceDir) {
      return inFlight.has(workspaceKey(workspaceDir));
    },
  };
}

/** Session deletes/clears in flight per workspace. `begin` hands back the release for
 *  THAT booking, so a repeated release is a no-op and can never cancel another
 *  channel's live booking. */
export function newWorkspaceSessionWork(): {
  begin: (workspaceDir: string) => () => void;
  isBusy: (workspaceDir: string) => boolean;
} {
  const open = new Map<string, number>();
  return {
    begin(workspaceDir) {
      const key = workspaceKey(workspaceDir);
      open.set(key, (open.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = open.get(key) ?? 0;
        if (count <= 1) open.delete(key);
        else open.set(key, count - 1);
      };
    },
    isBusy(workspaceDir) {
      return (open.get(workspaceKey(workspaceDir)) ?? 0) > 0;
    },
  };
}

/** Refusal for a workspace switch while that directory is minting or removing a
 *  session: the tab waiting on the settle must not be re-targeted underneath it. */
export const WORKSPACE_SWITCH_BLOCKED_MESSAGE =
  "A session here is being created or deleted. Wait for it to finish, then switch workspaces.";

/** Refusal for forgetting a workspace mid-mutation: removing it closes every tab
 *  on that path, including the one waiting for the settle. */
export const WORKSPACE_REMOVE_BLOCKED_MESSAGE =
  "This workspace is creating or deleting a session. Wait for it to finish, then remove it.";

/** How a channel's skeleton gets its session: adopt a persisted one, mint a genuinely
 *  fresh one, or stay neutral because the session it held was deleted. Only the two
 *  session-holding outcomes ever put a name on the channel. */
export type SkeletonSession =
  | { kind: "adopt"; name: string }
  | { kind: "mint" }
  | { kind: "neutral" };

export function skeletonSessionFor(
  restore: { session?: string; detached?: boolean } | undefined,
  adoptable: string | undefined,
): SkeletonSession {
  if (restore?.detached === true) return { kind: "neutral" };
  if (adoptable) return { kind: "adopt", name: adoptable };
  // A persisted session that no longer exists must not be resurrected: naming a
  // channel after it would put the UI in a session that is absent from disk.
  if (restore?.session) return { kind: "neutral" };
  return { kind: "mint" };
}

/** Whether a restored channel waits for its first activation before building a toolset.
 *  Building every channel eagerly cost 96 toolsets (~11 s) at boot, so only the focused
 *  one, the last-active one, and one holding an MCP picker build now. */
export function shouldDeferRestoredBuild(restore: {
  restored: boolean;
  focused: boolean;
  active?: boolean;
  mcpSetupPending?: boolean;
}): boolean {
  if (!restore.restored || restore.focused) return false;
  if (restore.mcpSetupPending === true) return false;
  return restore.active !== true;
}

/** Drain `buffer` to `fd` across partial writes; retry EAGAIN after a 5 ms park. Exported for tests. */
export function writeAllSync(
  fd: number,
  buffer: Buffer,
  opts: {
    write?: SyncWriter;
    wait?: () => void;
  } = {},
): void {
  const write = opts.write ?? writeSync;
  const wait = opts.wait ?? (() => Atomics.wait(STDOUT_BACKPRESSURE_WAIT, 0, 0, 5));
  let offset = 0;
  while (offset < buffer.length) {
    let written: number;
    try {
      written = write(fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
        wait();
        continue;
      }
      throw err;
    }
    if (written <= 0) throw new Error("stdout write returned 0 bytes");
    offset += written;
  }
}

function writeEvent(ev: EmittableEvent, tabId?: string): void {
  const payload = tabId ? { ...ev, tabId } : ev;
  writeAllSync(1, Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
}

export function redactDesktopDiagnosticMessage(raw: string, max = 2000): string {
  return redactDiagnosticText(raw, max);
}

/** Redacted but uncut: for the few payloads whose whole point is the full text (a
 *  spawn's instruction), where the diagnostic default would silently shorten it. */
function redactWholeMessage(raw: string): string {
  return redactDiagnosticText(raw, Number.MAX_SAFE_INTEGER);
}

type SubagentProgressPayload = Omit<SubagentProgressEvent, "id" | "ts" | "turn" | "type">;

/** Allowlisted projection for the desktop wire. Assistant text, reasoning deltas, and tool results are omitted. */
export function projectSubagentEvent(ev: SubagentEvent): SubagentProgressPayload | null {
  const base = {
    runId: ev.runId,
    ...(ev.parentCallId ? { parentCallId: ev.parentCallId } : {}),
    ...(ev.waveSize !== undefined ? { waveSize: ev.waveSize } : {}),
    // A spawn's start carries the instruction whole: the card shows the child's
    // task in full, so redaction is the only thing that may rewrite it. Later
    // events repeat it, and those stay previews.
    task:
      ev.kind === "start"
        ? redactWholeMessage(ev.task)
        : redactDesktopDiagnosticMessage(ev.task, 120),
    ...(ev.skillName ? { skillName: redactDesktopDiagnosticMessage(ev.skillName, 80) } : {}),
    ...(ev.model ? { model: redactDesktopDiagnosticMessage(ev.model, 80) } : {}),
    ...(ev.iter !== undefined ? { iter: ev.iter } : {}),
    ...(ev.elapsedMs !== undefined ? { elapsedMs: ev.elapsedMs } : {}),
    ...(ev.contextTokens !== undefined ? { contextTokens: ev.contextTokens } : {}),
    ...(ev.contextMax !== undefined ? { contextMax: ev.contextMax } : {}),
    ...(ev.thought ? { thought: redactDesktopDiagnosticMessage(ev.thought, 500) } : {}),
    ...(ev.maxToolIters !== undefined ? { maxToolIters: ev.maxToolIters } : {}),
    ...(ev.maxElapsedMs !== undefined ? { maxElapsedMs: ev.maxElapsedMs } : {}),
    ...(ev.budgetExhausted ? { budgetExhausted: ev.budgetExhausted } : {}),
  };
  switch (ev.kind) {
    case "start":
      return { ...base, action: "start", phase: "exploring" };
    case "progress":
      return { ...base, action: "phase", phase: "exploring" };
    case "phase":
      return { ...base, action: "phase", ...(ev.phase ? { phase: ev.phase } : {}) };
    case "stream-progress":
      return {
        ...base,
        action: "stream",
        outputChars: ev.outputChars ?? 0,
        reasoningChars: ev.reasoningChars ?? 0,
        toolReadChars: ev.toolReadChars ?? 0,
      };
    case "end":
      return {
        ...base,
        action: "end",
        ...(ev.error ? { error: redactDesktopDiagnosticMessage(ev.error, 500) } : {}),
        ...(ev.turns !== undefined ? { turns: ev.turns } : {}),
      };
    case "inner": {
      const inner = ev.inner;
      if (!inner || (inner.role !== "tool_start" && inner.role !== "tool")) return null;
      return {
        ...base,
        action: inner.role === "tool_start" ? "tool-start" : "tool-end",
        ...(inner.callId ? { childCallId: inner.callId } : {}),
        ...(inner.toolName
          ? { toolName: redactDesktopDiagnosticMessage(inner.toolName, 100) }
          : {}),
        ...(inner.role === "tool_start" && inner.toolArgs
          ? { toolArgs: sanitizeSubagentToolArgs(inner.toolArgs) }
          : {}),
        ...(inner.role === "tool"
          ? { toolOk: !/^\s*(?:error\b|\{\s*"error")/i.test(inner.content) }
          : {}),
      };
    }
  }
}

function sanitizeSubagentToolArgs(raw: string): string {
  const clipped = redactDesktopDiagnosticMessage(raw, 2000);
  try {
    return JSON.stringify(redactEventValue(JSON.parse(clipped)));
  } catch {
    return clipped;
  }
}

function diagnosticErrorMessage(err: unknown): string {
  return redactDesktopDiagnosticMessage(messageOf(err));
}

export function buildDesktopDiagnostic(
  event: string,
  details?: Record<string, unknown>,
  opts: { tabId?: string; level?: DesktopDiagnosticEvent["level"]; message?: string } = {},
): DesktopDiagnosticEvent {
  return {
    type: "$diagnostic",
    ts: new Date().toISOString(),
    source: "daemon",
    level: opts.level ?? "debug",
    event,
    ...(opts.message ? { message: diagnosticErrorMessage(opts.message) } : {}),
    ...(details ? { details: redactDiagnosticValue(details) as Record<string, unknown> } : {}),
  };
}

function emitDiagnostic(
  event: string,
  details?: Record<string, unknown>,
  opts: { tabId?: string; level?: DesktopDiagnosticEvent["level"]; message?: string } = {},
): void {
  const diagnostic = buildDesktopDiagnostic(event, details, opts);
  recordDiagnostic(event, {
    level: diagnostic.level,
    message: diagnostic.message,
    details: { ...diagnostic.details, tabId: opts.tabId },
    source: "daemon",
  });
  writeEvent(diagnostic, opts.tabId);
}

function emitDiagnosticError(
  event: string,
  err: unknown,
  opts: { tabId?: string; details?: Record<string, unknown> } = {},
): void {
  emitDiagnostic(event, opts.details, {
    tabId: opts.tabId,
    level: "error",
    message: diagnosticErrorMessage(err),
  });
}

function wireEventDetails(ev: EmittableEvent): Record<string, unknown> {
  switch (ev.type) {
    case "$error":
      return { messageLength: ev.message.length };
    case "error":
      return { turn: ev.turn, recoverable: ev.recoverable, messageLength: ev.message.length };
    case "warning":
      return { turn: ev.turn, severity: ev.severity, textLength: ev.text.length };
    case "model.turn.started":
      return { turn: ev.turn, model: ev.model, reasoningEffort: ev.reasoningEffort };
    case "model.delta":
      return { turn: ev.turn, channel: ev.channel, chars: ev.text.length };
    case "model.final":
      return {
        turn: ev.turn,
        contentChars: ev.content.length,
        reasoningChars: ev.reasoningContent?.length ?? 0,
        toolCalls: ev.toolCalls.length,
        usage: ev.usage,
      };
    case "tool.preparing":
      return { turn: ev.turn, callId: ev.callId, name: ev.name };
    case "tool.intent":
      return { turn: ev.turn, callId: ev.callId, name: ev.name, argsChars: ev.args.length };
    case "tool.result":
      return { turn: ev.turn, callId: ev.callId, ok: ev.ok, outputChars: ev.output.length };
    case "subagent.progress":
      return {
        turn: ev.turn,
        runId: ev.runId,
        action: ev.action,
        toolName: ev.toolName ?? null,
        iter: ev.iter ?? null,
      };
    case "$session_loaded":
      return {
        name: ev.name,
        messages: ev.messages.length,
        carryover: ev.carryover,
        resync: ev.resync ?? false,
      };
    case "$sessions":
      return { sessions: ev.items.length, epoch: ev.epoch, revision: ev.revision };
    case "$ctx_breakdown":
      return {
        reservedTokens: ev.reservedTokens,
        logTokens: ev.logTokens ?? null,
        ctxMax: ev.ctxMax ?? null,
      };
    case "$usage":
      return {
        probe: ev.usage?.probe ?? null,
        hasUsage: ev.usage !== null,
        windows: ev.usage?.windows.length ?? 0,
        plan: ev.usage?.plan ?? null,
        reason: ev.reason ?? null,
        needsSetup: ev.needsSetup ?? false,
      };
    case "$balance":
      return {
        currency: ev.currency,
        isAvailable: ev.isAvailable,
        currencies: ev.balanceInfos.length,
      };
    case "$tab_opened":
      return { workspaceDirChars: ev.workspaceDir.length, active: ev.active ?? false };
    case "$tabs_snapshot":
      return { tabs: ev.tabs.length };
    case "$turn_complete":
      return {};
    default:
      return {};
  }
}
/** The plan repository (plans.ts) is the ONE workspace-scoped plan store; the daemon
 *  only projects its state into UI events and keeps no plan mirror of its own. */

function stepResultsOf(completions: Record<string, StepCompletion>): Record<string, string> {
  const results: Record<string, string> = {};
  for (const [id, completion] of Object.entries(completions)) results[id] = completion.result;
  return results;
}

/** Accepted step counts for the in-flight plan (0/0 when none is running). */
function planCounts(tab: { rootDir: string; currentSession?: string }): {
  completed: number;
  total: number;
} {
  const active = activePlanForTab(tab);
  return {
    completed: active ? Object.keys(active.completions).length : 0,
    total: active?.steps.length ?? 0,
  };
}

/** Cache the plan progress on the tab. The diagnostics projection reads this instead of
 *  the store: it is emitted many times per start, and a store read can scan sessions. */
function refreshPlanSummary(tab: Tab): void {
  tab.planSummary = planCounts(tab);
}

/** The plan THIS tab's session is working, never another session's plan in the same
 *  workspace. A corrupt or locked store degrades to "no plan here": every caller is a
 *  projection that must not fail the tab. */
function activePlanForTab(
  tab: { rootDir: string; currentSession?: string },
  opts: { adoptUnclaimed?: boolean } = {},
): PlanRecord | null {
  if (!tab.rootDir) return null;
  try {
    return planRepository(tab.rootDir).activeFor(claimingSession(tab.currentSession), opts);
  } catch (err) {
    process.stderr.write(`reasonix: active plan read failed — ${messageOf(err)}\n`);
    return null;
  }
}

/** Project an accepted mark_step_complete result into the rail's progress tick.
 *  Only JSON results carry a stepId; error/stop strings parse to nothing. */
function emitAcceptedStep(tab: Tab, result: string): void {
  let parsed: { stepId?: unknown; result?: unknown };
  try {
    parsed = JSON.parse(result);
  } catch {
    return;
  }
  if (typeof parsed.stepId !== "string") return;
  refreshPlanSummary(tab);
  emit(
    {
      type: "$step_completed",
      stepId: parsed.stepId,
      result: typeof parsed.result === "string" ? parsed.result : "",
    },
    tab.id,
  );
}

/** Build the $plan_restored hydrate event from the plan this session owns — null
 *  when no plan is in flight for it (a finished/cancelled plan remains history only,
 *  and another session's in-flight plan is never projected into this tab). */
export function restorePlanForTab(
  tab: { rootDir: string; currentSession?: string },
  hasPriorMessages: boolean,
): PlanRestoredEvent | null {
  if (!tab.rootDir || !hasPriorMessages) return null;
  // A live session asking for a plan adopts an unclaimed pre-ownership plan; one another
  // live session holds is refused and stays out of this tab. A failed read is "no plan".
  const active = activePlanForTab(tab, { adoptUnclaimed: true });
  if (!active || active.steps.length === 0) return null;
  return {
    type: "$plan_restored",
    plan: active.body,
    summary: active.summary,
    steps: active.steps,
    completedStepIds: Object.keys(active.completions),
    stepResults: stepResultsOf(active.completions),
    status: "active",
  };
}

/** Emit the plan history, then the active-plan hydrate — or a clear when the session
 *  has past plans but none is in flight. The repository is the single source. */
function emitRestoredPlan(tab: Tab, hasPriorMessages: boolean): void {
  emitPlanHistory(tab);
  refreshPlanSummary(tab);
  if (!hasPriorMessages || !tab.rootDir) return;
  const event = restorePlanForTab(tab, true);
  if (event) {
    emit(event, tab.id);
    return;
  }
  let hasHistory = false;
  try {
    hasHistory = planRepository(tab.rootDir).list().length > 0;
  } catch (err) {
    process.stderr.write(`reasonix: plan history read failed — ${messageOf(err)}\n`);
  }
  if (hasHistory) {
    emit({ type: "$plan_cleared" }, tab.id);
  }
}

/** Every tab serving one workspace, installed by the desktop command. Plan history is a
 *  WORKSPACE projection, so a plan another session starts must label its sidebar row
 *  whichever session this tab happens to be showing. */
let workspaceTabs: ((workspaceDir: string) => Tab[]) | null = null;

function emitPlanHistory(tab: Tab): void {
  if (!tab.rootDir) return;
  // A corrupt or unreadable history.json must not abort session load — degrade
  // to an empty projection rather than failing the whole tab restore.
  let items: PlanHistoryItem[];
  try {
    items = toPlanHistoryItems(planRepository(tab.rootDir).list());
  } catch (err) {
    process.stderr.write(`reasonix: plan history read failed — ${messageOf(err)}\n`);
    items = [];
  }
  // One read, one projection, every tab of the workspace: the store is workspace-scoped,
  // so the same items are each tab's truth about every session in it.
  for (const target of workspaceTabs?.(tab.rootDir) ?? [tab]) {
    emit({ type: "$plan_history", sessionName: target.currentSession, items }, target.id);
  }
}

function emit(ev: EmittableEvent, tabId?: string): void {
  writeEvent(ev, tabId);
  // Model deltas are streamed at token/chunk frequency. They are already
  // observable in the WebView transcript; duplicating every chunk as a
  // diagnostic doubles synchronous stdout writes and can starve the loop.
  if (ev.type === "$diagnostic" || ev.type === "model.delta" || ev.type === "tool.output") return;
  emitDiagnostic(
    "wire.emit",
    { eventType: ev.type, ...wireEventDetails(ev) },
    {
      tabId,
      level: ev.type === "$error" || ev.type === "error" ? "error" : "debug",
      ...(ev.type === "$error" || ev.type === "error" ? { message: ev.message } : {}),
    },
  );
}

/** Emit a kernel event to a tab; session.retracted's replacement payload is
 *  converted from the kernel ChatMessage shape into the LoadedMessage wire
 *  shape so the App reducer can swap in the truncated conversation. */
export function sessionCarryover(meta: SessionMeta): SessionLoadedEvent["carryover"] {
  return {
    cacheHitTokens: meta.cacheHitTokens ?? 0,
    cacheMissTokens: meta.cacheMissTokens ?? 0,
    totalCompletionTokens: meta.totalCompletionTokens ?? 0,
  };
}

export function emptySessionCarryover(): SessionLoadedEvent["carryover"] {
  return {
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalCompletionTokens: 0,
  };
}

export function projectKernelEvent(kev: KernelEvent): KernelWireBridgeEvent | null {
  switch (kev.type) {
    case "session.retracted":
      return {
        type: EventType.sessionRetracted,
        id: kev.id,
        ts: kev.ts,
        turn: kev.turn,
        kind: kev.kind,
        beforeMessages: kev.beforeMessages,
        afterMessages: kev.afterMessages,
        replacementMessages: buildLoadedMessages([...kev.replacementMessages]),
      };
    case "user.message":
    case "model.turn.started":
    case "model.delta":
    case "model.final":
    case "tool.preparing":
    case "tool.intent":
    case "tool.result":
    case "tool.output":
    case "subagent.progress":
    case "status":
    case "warning":
    case "error":
    case "compaction.started":
      return kev;
    case "slash.invoked":
    case "tool.dispatched":
    case "tool.denied":
    case "tool.call":
    case "tool.confirm.allow":
    case "tool.confirm.deny":
    case "tool.confirm.always_allow":
    case "effect.file.touched":
    case "effect.memory.written":
    case "plan.submitted":
    case "plan.step.completed":
    case "hook.fired":
    case "session.opened":
    case "capability.registered":
    case "capability.removed":
      return null;
    default: {
      const unhandled: never = kev;
      return unhandled;
    }
  }
}

function emitKernelEvent(kev: KernelEvent, tabId?: string): void {
  const wire = projectKernelEvent(kev);
  if (wire) emit(wire, tabId);
}

const LOADED_RECENT_MESSAGE_WINDOW = 200;
const LOADED_MIN_ELIDE_CHARS = 4096;
const LOADED_ELIDED_PREFIX = "[elided — older than the last ";

function elideLoadedField(value: string): string {
  if (value.length <= LOADED_MIN_ELIDE_CHARS) return value;
  if (value.startsWith(LOADED_ELIDED_PREFIX)) return value;
  return `${LOADED_ELIDED_PREFIX}${LOADED_RECENT_MESSAGE_WINDOW} messages; ${value.length.toLocaleString()} chars dropped to save memory. Full content is on disk in the session log.]`;
}

function elideLoadedMessages(messages: LoadedMessage[]): LoadedMessage[] {
  if (messages.length < LOADED_RECENT_MESSAGE_WINDOW) return messages;
  const cutoff = messages.length - LOADED_RECENT_MESSAGE_WINDOW;
  return messages.map((msg, i) => {
    if (i >= cutoff || msg.kind !== "assistant") return msg;
    return {
      ...msg,
      segments: msg.segments.map((segment) => {
        switch (segment.kind) {
          case "reasoning":
          case "text":
            return { ...segment, text: elideLoadedField(segment.text) };
          case "tool":
            return {
              ...segment,
              args: elideLoadedField(segment.args),
              ...(segment.result !== undefined ? { result: elideLoadedField(segment.result) } : {}),
            };
          default:
            return segment;
        }
      }),
    };
  });
}

/** Clipboard data URLs pass through; dropped files are read, sniffed and re-encoded. */
export async function resolveUserImages(
  attachments: ReadonlyArray<UserImageAttachment>,
  rootDir: string,
): Promise<TurnImage[]> {
  const out: TurnImage[] = [];
  for (const att of attachments) {
    if (att.source === "clipboard") {
      if (!att.dataUrl.startsWith("data:image/")) {
        throw new Error("clipboard payload is not a data:image URL");
      }
      // Normalize the same as dropped files: sniff the real bytes so an
      // animated WebP paste (or a mismatched MIME) is caught here with a clear
      // error instead of reaching the vision API and 400ing.
      const comma = att.dataUrl.indexOf(",");
      const b64 = comma >= 0 ? att.dataUrl.slice(comma + 1) : "";
      const normalized = await normalizeImageToDataUrls(Buffer.from(b64, "base64"));
      if (!normalized.ok) throw new Error(normalized.message);
      const attachmentDir = join(rootDir, ".reasonix", "attachments");
      mkdirSync(attachmentDir, { recursive: true });
      for (const url of normalized.dataUrls) {
        const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(url);
        if (!match) throw new Error("normalized clipboard image is not a base64 data URL");
        const extension = match[1]!.toLowerCase() === "jpeg" ? "jpg" : match[1]!.toLowerCase();
        const path = join(attachmentDir, `${randomUUID()}.${extension}`);
        writeFileSync(path, Buffer.from(match[2]!, "base64"));
        out.push({ url, path });
      }
      continue;
    }
    const kind =
      att.kind === "audio" || att.kind === "video" ? att.kind : mediaKindForPath(att.path);
    if (kind === "audio" || kind === "video") {
      const mediaStat = statSync(att.path);
      if (mediaStat.size > MAX_MEDIA_BYTES) {
        throw new Error(
          `${kind} too large (${(mediaStat.size / 1024 / 1024).toFixed(1)} MB > ${MAX_MEDIA_BYTES / 1024 / 1024} MB)`,
        );
      }
      const ext = att.path.slice(att.path.lastIndexOf(".") + 1);
      const mime = mediaMimeForExtension(ext) ?? (kind === "audio" ? "audio/mpeg" : "video/mp4");
      const dataUrl = `data:${mime};base64,${(await readFile(att.path)).toString("base64")}`;
      out.push({
        url: dataUrl,
        path: att.path,
        kind,
        fps: att.fps,
        mediaResolution: att.mediaResolution,
      });
      continue;
    }
    const stat = statSync(att.path);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `image too large (${(stat.size / 1024 / 1024).toFixed(1)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`,
      );
    }
    const normalized = await normalizeImageToDataUrls(await readFile(att.path));
    if (!normalized.ok) {
      throw new Error(normalized.message);
    }
    // Keep the source path so the agent can open/modify the actual file, not
    // just see the pixels. A tiled image carries the path on its first tile
    // only, so the user message lists it once.
    normalized.dataUrls.forEach((url, i) => {
      out.push(i === 0 ? { url, path: att.path } : { url });
    });
  }
  return out;
}

/** OpenAI-only: `@path` mentions that resolve to an existing supported image
 *  become vision attachments (the token is stripped from the text). Non-image
 *  or missing mentions stay in the text for the model to reach via tools. */
export async function extractImageMentions(
  text: string,
  rootDir: string,
): Promise<{ text: string; attachments: UserImageAttachment[] }> {
  const mentions = scanImageMentions(text, (p) => (isAbsolute(p) ? p : join(rootDir, p)));
  // Existence is a daemon-only check — the webview has no fs access. Mentions
  // whose files are missing keep their token so the model can investigate.
  const existing = mentions.filter((m) => existsSync(m.path) && statSync(m.path).isFile());
  return {
    text: stripMentionTokens(text, existing),
    attachments: existing.map((m) => ({ source: "file" as const, path: m.path })),
  };
}

/** User records carry plain text for text-only turns and OpenAI content parts
 *  when images are attached — extract the text and image data URLs for the
 *  LoadedMessage wire shape. */
function userLoadedMessage(
  content: ChatMessage["content"],
  ts?: number,
  injected?: boolean,
): {
  kind: "user";
  text: string;
  images?: string[];
  ts?: number;
  injected?: true;
} {
  const flag = injected ? ({ injected: true } as const) : {};
  if (typeof content === "string" || content === undefined || content === null) {
    return { kind: "user", text: content ?? "", ts, ...flag };
  }
  const textParts: string[] = [];
  const images: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text.length > 0) {
      textParts.push(part.text);
    } else if (part.type === "image_url") {
      images.push(part.image_url.url);
    }
  }
  return {
    kind: "user",
    text: textParts.join("\n"),
    images: images.length ? images : undefined,
    ts,
    ...flag,
  };
}

export function buildLoadedMessages(records: ChatMessage[]): LoadedMessage[] {
  const out: LoadedMessage[] = [];
  // ONE turn scheme stack-wide: turn N = the Nth real (non-synthetic) user record.
  // Assistant records inherit the turn they answer — a tool loop produces several
  // assistant records for ONE turn, all numbered alike (the live renderer keeps one
  // card per turn). Synthetic user records (mid-turn steer, premature-stop nudge)
  // never start a turn and never render as user bubbles. The kernel's turn counter
  // (resumeTurnBaseline) counts the same real user records, so error/notice anchors
  // and these numbers stay aligned across restarts.
  let turn = 0;
  let assistantRecord = 0;
  let pendingAssistantIdx = -1;
  for (const rec of records) {
    if (rec.role === "system") continue;
    if (rec.role === "user") {
      if (rec.synthetic === true) continue;
      turn += 1;
      pendingAssistantIdx = -1;
      out.push(userLoadedMessage(rec.content, rec.ts, rec.injected === true));
      continue;
    }
    if (rec.role === "assistant") {
      assistantRecord += 1;
      const segments: LoadedSegment[] = [];
      if (rec.reasoning_content) {
        segments.push({ kind: "reasoning", text: rec.reasoning_content, model: rec.model });
      }
      if (typeof rec.content === "string" && rec.content) {
        segments.push({ kind: "text", text: rec.content });
      } else if (Array.isArray(rec.content)) {
        for (const part of rec.content) {
          if (part.type === "text" && part.text) segments.push({ kind: "text", text: part.text });
          else if (part.type === "image") {
            segments.push({ kind: "image", dataUrl: part.data_url, mimeType: part.mime_type });
          }
        }
      }
      if (rec.tool_calls) {
        for (let i = 0; i < rec.tool_calls.length; i++) {
          const tc = rec.tool_calls[i];
          if (!tc) continue;
          segments.push({
            kind: "tool",
            callId: tc.id ?? `tc-r-${assistantRecord}-${i}`,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          });
        }
      }
      out.push({
        kind: "assistant",
        turn,
        segments,
        pending: false,
        ts: rec.ts,
      });
      pendingAssistantIdx = out.length - 1;
      continue;
    }
    if (rec.role === "tool") {
      if (pendingAssistantIdx < 0) continue;
      const host = out[pendingAssistantIdx];
      if (host?.kind !== "assistant") continue;
      const callId = rec.tool_call_id;
      if (!callId) continue;
      const seg = host.segments.find((s) => s.kind === "tool" && s.callId === callId);
      if (seg && seg.kind === "tool") {
        seg.result = typeof rec.content === "string" ? rec.content : "";
        seg.ok = !/error|failed/i.test(seg.result.slice(0, 200));
      }
    }
  }
  // Loaded history is a closed snapshot, not a live turn. If the process or
  // session ended after persisting an assistant tool call but before its tool
  // result, leaving `result` undefined would make the desktop render that old
  // call as running forever after restart. Settle only those unmatched calls;
  // completed calls already carry their persisted result from the loop above.
  for (const message of out) {
    if (message.kind !== "assistant") continue;
    for (const segment of message.segments) {
      if (segment.kind !== "tool" || segment.result !== undefined) continue;
      segment.result = "Tool call interrupted before a result was recorded.";
      segment.ok = false;
    }
  }
  return elideLoadedMessages(out);
}

/** How many transcript records one page carries. A session's whole history is a
 *  multi-megabyte payload and the transcript only ever shows its tail first, so
 *  the newest page ships and older pages are fetched on demand. */
const SESSION_PAGE_SIZE = 300;

/** The window ending `before` messages from the end of the transcript, or the whole
 *  list when it fits. `turnBase` counts user turns above it, so a page's rows keep
 *  the absolute turn numbers the live transcript and the Events tab address. */
function sessionWindow(
  messages: LoadedMessage[],
  before: number,
): { page: LoadedMessage[]; hasOlder: boolean; turnBase: number } {
  const end = Math.max(0, messages.length - Math.max(0, before));
  const start = Math.max(0, end - SESSION_PAGE_SIZE);
  if (start === 0 && end === messages.length) {
    return { page: messages, hasOlder: false, turnBase: 0 };
  }
  let turnBase = 0;
  for (let i = 0; i < start; i += 1) {
    if (messages[i]?.kind === "user") turnBase += 1;
  }
  return { page: messages.slice(start, end), hasOlder: start > 0, turnBase };
}

/** Re-insert persisted annotation cards into a loaded transcript so none is
 *  transient: a notice slots at the START of its turn's group (matching the
 *  live UI); a warning re-attaches to its turn's assistant card. */
export function mergeNoticesIntoLoaded(
  loaded: LoadedMessage[],
  notices: readonly PersistedNotice[],
  lastTurn?: number,
): LoadedMessage[] {
  if (notices.length === 0) return loaded;
  // Copy so appending warning segments never mutates the caller's arrays.
  const out: LoadedMessage[] = loaded.map((m) =>
    m.kind === "assistant" ? { ...m, segments: [...m.segments] } : m,
  );
  // A live card's turn is the kernel's ABSOLUTE ordinal, but buildLoadedMessages
  // renumbers the surviving user records from 1. After a truncation the two diverge by
  // the dropped turn count, so a persisted card whose turn exceeds the user
  // count would otherwise be dumped at the transcript tail on every reload.
  // Rebase those turns into the reconstructed scheme; a card for a turn that no
  // longer exists (mapped to <= 0) is dropped along with the turn it belonged to.
  const userCount = out.reduce((n, m) => (m.kind === "user" ? n + 1 : n), 0);
  const offset = lastTurn !== undefined ? Math.max(0, lastTurn - userCount) : 0;
  // null = the turn no longer exists (dropped) → drop the card. Turn 0
  // ("before the first user message") is legitimately kept.
  const rebase = (turn: number): number | null => {
    if (offset > 0 && turn > userCount) {
      const mapped = turn - offset;
      return mapped > 0 ? mapped : null;
    }
    return turn;
  };
  const seen = new Set<string>();
  for (const rec of notices) {
    if (rec.kind !== "warning") continue;
    const turn = rebase(rec.turn);
    if (turn === null) continue;
    const key = `warning\n${turn}\n${rec.severity}\n${rec.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const host = lastAssistantOfTurn(out, turn);
    if (!host || host.kind !== "assistant") continue;
    host.segments.push({
      kind: "warning",
      id: rec.id,
      text: rec.text,
      severity: rec.severity === "low" ? "low" : "high",
    });
  }
  for (const rec of notices) {
    if (rec.kind !== "notice") continue;
    const turn = rebase(rec.turn);
    if (turn === null) continue;
    const key = `notice\n${turn}\n${rec.severity}\n${rec.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const notice: LoadedMessage = {
      kind: "notice",
      id: rec.id,
      text: rec.text,
      severity: rec.severity === "low" || rec.severity === "high" ? "warning" : rec.severity,
      turn,
    };
    out.splice(noticeInsertIndex(out, turn), 0, notice);
  }
  return out;
}

function lastAssistantOfTurn(messages: LoadedMessage[], turn: number): LoadedMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === "assistant" && m.turn === turn) return m;
  }
  return undefined;
}

/** Where a turn's notices anchor: right after the turn's Nth user message (and
 *  any notice already slotted there). turn <= 0 → the very start; a turn with
 *  no user message → the tail. */
function noticeInsertIndex(messages: LoadedMessage[], turn: number): number {
  if (turn <= 0) return 0;
  let userSeen = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.kind !== "user") continue;
    userSeen += 1;
    if (userSeen !== turn) continue;
    let at = i + 1;
    while (at < messages.length && messages[at]?.kind === "notice") at += 1;
    return at;
  }
  return messages.length;
}

/** Persist one per-session JSON sidecar from a `*_sync` command: skipped when the
 *  session holds nothing and nothing is stored, so no untouched session mints an
 *  empty file. Both sidecars share the rule, and a failure is only diagnostics. */
function syncSessionSidecar(
  tab: { id: string; currentSession?: string },
  kind: "notices" | "events",
  rows: readonly unknown[],
  pathFor: (name: string) => string,
  write: (name: string) => void,
): void {
  const name = tab.currentSession;
  if (!name) return;
  try {
    if (rows.length > 0 || existsSync(pathFor(name))) write(name);
  } catch (err) {
    emitDiagnosticError(`session.${kind}.sync.failed`, err, { tabId: tab.id });
  }
}

function maskApiKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 7) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-3)}`;
}

/** Every declared engine setting: url values as stored, secret values as a masked
 *  preview. An engine that reuses a model provider's key is skipped, because the Models
 *  tab owns that field and the value must never appear in two places. */
function collectSearchSettings(cfg: ReasonixConfig): SearchSettingsMap {
  const apiKeys = loadSearchApiKeys();
  const out: SearchSettingsMap = {};
  for (const spec of SEARCH_ENGINE_SPECS) {
    if (searchSharedCredential(spec)) continue;
    for (const setting of spec.settings) {
      const value =
        setting.kind === "secret"
          ? maskApiKey(apiKeys[spec.id])
          : searchSettingFromConfig(cfg, spec.id, setting.key);
      if (!value) continue;
      const entry = out[spec.id] ?? {};
      entry[setting.key] = value;
      out[spec.id] = entry;
    }
  }
  return out;
}

/** Every declared provider setting: url values as stored, secret values as a masked
 *  preview of the effective key. The loop reads the declarations, so adding a
 *  provider or a field changes nothing here. */
function collectProviderSettings(cfg: ReasonixConfig): ProviderSettingsMap {
  const apiKeys = loadProviderApiKeys();
  const out: ProviderSettingsMap = {};
  for (const spec of PROVIDER_SPECS) {
    for (const setting of spec.settings) {
      if (setting.kind === "internal") continue;
      const value =
        setting.kind === "secret"
          ? maskApiKey(apiKeys[spec.id])
          : providerSettingFromStore(cfg, spec.id, setting.key);
      if (!value) continue;
      const entry = out[spec.id] ?? {};
      entry[setting.key] = value;
      out[spec.id] = entry;
    }
  }
  return out;
}

let oauthGen = 0;
let pendingOAuth: OAuthFlow | null = null;
/** Last OAuth flow failure message — surfaced in the status bar's OpenAI auth
 *  chip until the next successful sign-in clears it. */
let lastOAuthError: string | null = null;

let antigravityOAuthGen = 0;
let pendingAntigravityOAuth: OAuthFlow | null = null;
/** Last Antigravity OAuth flow failure — surfaced in the status bar's Gemini
 *  auth chip until the next successful sign-in clears it. */
let lastAntigravityOAuthError: string | null = null;

let opencodeOAuthGen = 0;
let pendingOpencodeOAuth: OpencodeDeviceFlow | null = null;
/** Last OpenCode OAuth flow failure — shown in the OpenCode settings card until
 *  the next successful sign-in clears it. */
let lastOpencodeOAuthError: string | null = null;

let mimoOAuthGen = 0;
let pendingMiMoOAuth: MiMoLoginFlow | null = null;
/** Last MiMo browser-flow failure — shown in the MiMo settings card until the
 *  next successful sign-in clears it. */
let lastMiMoOAuthError: string | null = null;

async function refreshAntigravityModels(tab: Tab): Promise<void> {
  try {
    const auth = await resolveGeminiAuth();
    if (!auth) throw new Error("Sign in to Google Antigravity before refreshing models");
    const creds = readConfig().antigravityOAuth;
    if (!creds) throw new Error("Antigravity credentials disappeared during model refresh");
    const models = (await fetchAntigravityModels(auth.accessToken, auth.projectId)).map(
      ({ id }) => id,
    );
    saveAntigravityOAuth({ ...creds, projectId: auth.projectId, models });
    lastAntigravityOAuthError = null;
    emitSettings(tab);
  } catch (err) {
    const message = `Antigravity model refresh failed: ${(err as Error).message}`;
    lastAntigravityOAuthError = message;
    emit({ type: "$error", message }, tab.id);
    emitSettings(tab);
  }
}

/** Host shown when neither the config nor providers.json names one; DeepSeek
 *  defers to the client's own last resort (src/client.ts). */
const UNCONFIGURED_BASE_URL: Partial<Record<ModelProvider, string>> = {
  deepseek: "https://api.deepseek.com",
};

/** Endpoint + auth state for a model id — drives the status bar's API chip.
 *  The provider comes from the resolver (config > discovery > catalogs), never
 *  from the id's name shape. Exported for tests. */
export function modelEndpointFor(model: string, path?: string): ModelEndpointInfo {
  const resolved = loadResolvedModelEndpoint(model, path);
  const provider = resolved.provider;
  const spec = providerSpec(provider);
  const reasoningEfforts = supportedReasoningEfforts(model, path);
  // One fallback rule for every provider: what it resolved, else the endpoint
  // its JSON declares, else the host the client itself would fall back to.
  const baseUrl =
    resolved.baseUrl ?? providerDefaultEndpoint(provider) ?? UNCONFIGURED_BASE_URL[provider] ?? "";
  // Resolved for every provider, not just the ones whose chip used to read it: the
  // ribbon picks its money chip from this kind plus the declaration, so a provider
  // never has to be reverse-engineered from its auth or wire shape.
  const base = {
    provider,
    baseUrl,
    reasoningEfforts,
    billingKind: billingContextForModel(model, path).kind,
    // Deployment classifies one provider's endpoint kind, so only the declaration
    // that defines it reports one.
    ...(spec?.wire.format === "ollama-native" && resolved.deployment
      ? { deployment: resolved.deployment }
      : {}),
  };
  // The credential panel a provider reports is the auth strategy its JSON declares,
  // so a new declaration picks up its own panel without an edit here.
  switch (spec?.client.auth) {
    case "gemini-oauth": {
      const oauth = readConfig(path).antigravityOAuth;
      return {
        ...base,
        antigravityAuth: oauth?.accessToken ? "oauth" : "none",
        antigravityAccount: oauth?.account,
      };
    }
    case "opencode": {
      const oauth = readConfig(path).opencodeOAuth;
      const key = loadOpencodeApiKey(path);
      // Go models bill the Go plan windows; free/anon Zen models have no usage API
      // and paid Zen has no price table here, so both measure nothing. Resolved on
      // the wire id, so a shared `opencode/<id>` still reads as Go.
      const opencodePlan = opencodeUsagePlan(model, path);
      return {
        ...base,
        billingKind: opencodePlan === "go" ? "quota" : "none",
        opencodeAuth: oauth?.accessToken ? "oauth" : key && key !== "public" ? "apiKey" : "none",
        opencodeAccount: oauth?.account,
        opencodePlan,
      };
    }
    case "openai-oauth": {
      const oauth = readConfig(path).openaiOAuth;
      return {
        ...base,
        openaiAuth: oauth?.accessToken ? "oauth" : resolved.apiKey ? "apiKey" : "none",
        oauthAccount: oauth?.account,
      };
    }
    default:
      return base;
  }
}

function emitSettings(tab: Tab): void {
  const config = readConfig();
  const oauth = config.openaiOAuth;
  const antigravityOAuth = config.antigravityOAuth;
  const opencodeOAuth = config.opencodeOAuth;
  const ep = loadEndpoint();
  const editMode = loadEditMode();
  if (tab.toolset) applyPlanMode(tab.toolset.tools, editMode);
  const recent = loadRecentWorkspaces().filter(
    (p) => !sameWorkspaceDir(p, tab.rootDir) && !sameWorkspaceDir(p, reasonixInstallDir()),
  );
  // Sourced from the registry the dispatch gate consults, so the mode-rules card
  // can't drift from what read-only actually refuses.
  const toolsetTools = tab.toolset?.tools;
  const readOnlyTools = toolsetTools
    ? toolsetTools
        .specs()
        .map((spec) => spec.function.name)
        .filter((name) => toolsetTools.get(name)?.readOnly === true)
    : [];
  emit(
    {
      type: "$settings",
      reasoningEffort: tab.currentReasoningEffort,
      editMode,
      quickSends: loadCustomQuickSends(),
      quickSendId: loadQuickSendId(),
      feedbackCues: loadFeedbackCues(),
      contextTokens: tab.ctxMaxOverride ?? null,
      maxIterPerTurn: tab.runtime?.loop.maxIterPerTurn ?? loadMaxIterPerTurn(),
      maxIterPerTurnOverride:
        typeof config.maxIterPerTurn === "number" ? config.maxIterPerTurn : null,
      // The session's frozen capability: it is what the composer's subagent model
      // picker hides behind.
      subagents: tab.subagents,
      elevationEnabled: loadElevationEnabled(),
      repetitionGuardEnabled:
        tab.runtime?.loop.repetitionGuardEnabled ?? loadRepetitionGuardEnabled(),
      autoCompact: tab.runtime?.loop.autoCompact ?? loadAutoCompact(),
      autoCompactTrigger: config.autoCompactTrigger ?? null,
      questionTimerEnabled: loadQuestionTimerEnabled(),
      duplicateSessionTokens: loadDuplicateSessionTokens(),
      duplicateSessionAutoProceed: loadDuplicateSessionAutoProceed(),
      enabledModels: loadEnabledModels(),
      fallbackModels: loadFallbackModels(),
      baseUrl: ep.baseUrl,
      apiKeyPrefix: ep.apiKey ? `${ep.apiKey.slice(0, 6)}…${ep.apiKey.slice(-3)}` : undefined,
      workspaceDir: tab.rootDir,
      recentWorkspaces: recent,
      reasonixLocalDir: reasonixDefaultWorkspaceDir(),
      model: tab.currentModel,
      providerCatalogs,
      providerSettings: collectProviderSettings(config),
      webSearchEngine: readWebSearchEngine(),
      searchSettings: collectSearchSettings(config),
      subagentModel: tab.currentSubagentModel,
      mailProvider: config.mailProvider ?? MailProvider.Outlook,
      ollamaGeneration: loadOllamaGenerationSettings(),
      ollamaGenerationOverrides: loadOllamaGenerationOverrides(),
      ollamaModelDefaults:
        modelEndpointFor(tab.currentModel).provider === "ollama" ||
        modelEndpointFor(tab.currentSubagentModel ?? tab.currentModel).provider === "ollama"
          ? resolveOllamaModelDefaults(tab.currentModel)
          : undefined,
      statusBar: config.statusBar,
      modelEndpoint: modelEndpointFor(tab.currentModel),
      subagentModelEndpoint: modelEndpointFor(tab.currentSubagentModel ?? tab.currentModel),
      openaiOAuth: {
        signedIn: !!oauth?.accessToken,
        account: oauth?.account,
        flowError: lastOAuthError ?? undefined,
      },
      antigravityOAuth: {
        signedIn:
          !!antigravityOAuth?.accessToken &&
          antigravityOAuth.clientId === ANTIGRAVITY_OAUTH_CLIENT_ID,
        account: antigravityOAuth?.account,
        models:
          antigravityOAuth?.models ||
          antigravityOAuth?.accessToken ||
          Object.keys(config.models ?? {}).some((id) => config.models?.[id]?.provider === "gemini")
            ? Array.from(
                new Set([
                  ...(antigravityOAuth?.models?.filter(isUsableAntigravityModel) ?? []),
                  ...ANTIGRAVITY_MODELS,
                  ...Object.keys(config.models ?? {}).filter(
                    (id) =>
                      config.models?.[id]?.provider === "gemini" && isUsableAntigravityModel(id),
                  ),
                ]),
              )
            : undefined,
        flowError:
          lastAntigravityOAuthError ??
          (antigravityOAuth?.accessToken &&
          antigravityOAuth.clientId !== ANTIGRAVITY_OAUTH_CLIENT_ID
            ? "Google authentication changed. Sign in again to enable Gemini free-tier quota."
            : undefined),
      },
      opencodeOAuth: {
        signedIn: !!opencodeOAuth?.accessToken,
        account: opencodeOAuth?.account,
        orgName: opencodeOAuth?.orgName,
        flowError: lastOpencodeOAuthError ?? undefined,
      },
      mimoOAuth: {
        signedIn: !!config.providerSettings?.mimo?.apiKey,
        flowError: lastMiMoOAuthError ?? undefined,
      },
      shellAllowedWorkspace: loadProjectShellAllowed(tab.rootDir),
      pathAllowedWorkspace: loadProjectPathAllowed(tab.rootDir),
      shellAllowedGlobal: loadGlobalShellAllowed(),
      pathAllowedGlobal: loadGlobalPathAllowed(),
      rules: loadRules(tab.rootDir),
      workspacesWithRules: listWorkspacesWithRules(),
      builtinShellAllowlist: [...BUILTIN_ALLOWLIST],
      readOnlyTools,
      version: VERSION,
    },
    tab.id,
  );
  emitTabDiagnostic(tab, "settings.emitted", {
    model: tab.currentModel,
    provider: providerForModel(tab.currentModel),
    modelEndpoint: modelEndpointFor(tab.currentModel),
    editMode,
    oauthSignedIn: !!oauth?.accessToken,
  });
}

/** Account plan for a cloud Ollama endpoint — `POST {origin}/api/me` with the
 *  same Bearer key. Undefined on any failure (proxy, local daemon, down):
 *  an unknown plan means "no filtering", never a hidden model list. */
export async function fetchOllamaPlan(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  try {
    const resp = await fetch(`${new URL(baseUrl).origin}/api/me`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { Plan?: unknown };
    return typeof data.Plan === "string" && data.Plan.length > 0 ? data.Plan : undefined;
  } catch {
    return undefined;
  }
}

export type OllamaProbeResult = "ok" | "gated" | "error";

/** Whether an upstream chat response marks the model as subscription-gated.
 *  Ollama's 403 variants: "requires a subscription" and "requires both a
 *  Pro, Max, or Team plan ..." — both share the "upgrade for access" tail. */
export function isSubscriptionGatedResponse(status: number, bodyText: string): boolean {
  return (
    status === 403 &&
    (bodyText.includes("requires a subscription") || bodyText.includes("upgrade for access"))
  );
}

/** Minimal chat probe — 1-token completion; 403 = gated, 429 gets one retry.
 *  Timeout is long: cold big models are slow to first token, and a timeout
 *  leaves the model unmapped (re-probed on every refresh). */
export async function probeOllamaModel(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 30_000,
): Promise<OllamaProbeResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return "error";
    }
    if (resp.ok) return "ok";
    if (resp.status === 429 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    const body = await resp.text().catch(() => "");
    return isSubscriptionGatedResponse(resp.status, body) ? "gated" : "error";
  }
  return "error";
}

/** Vision capability from a native `/api/show` payload: a non-empty
 *  `capabilities` array is authoritative ("vision" present), else a vision
 *  projector/metadata marker, else undefined so the caller probes the image. */
export function showPayloadVisionCapability(data: unknown): boolean | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const capabilities = rec.capabilities;
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    return capabilities.some((c) => c === "vision");
  }
  const projector = rec.projector_info;
  if (typeof projector === "object" && projector !== null && Object.keys(projector).length > 0) {
    return true;
  }
  const modelInfo = rec.model_info;
  if (typeof modelInfo === "object" && modelInfo !== null) {
    for (const key of Object.keys(modelInfo as Record<string, unknown>)) {
      if (/(^|\.)vision\./.test(key)) return true;
    }
  }
  return undefined;
}

/** Boolean form of {@link showPayloadVisionCapability}: true only on a positive
 *  marker. An inconclusive payload reports false here; callers needing the
 *  probe fallback use the tri-state function. */
export function showPayloadIsVision(data: unknown): boolean {
  return showPayloadVisionCapability(data) === true;
}

/** A 1×1 transparent PNG data URL — the smallest payload that exercises a
 *  model's vision tower through the OpenAI-compat `/v1/chat/completions`. */
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Probe whether `model` accepts image parts by POSTing one user message
 *  with a tiny data-URL image to the OpenAI-compat chat endpoint: 2xx ⇒
 *  vision-capable, 400 ⇒ text-only, else indeterminate (`undefined`). */
export async function probeOllamaVision(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 30_000,
): Promise<boolean | undefined> {
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
            ],
          },
        ],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.ok) return true;
    if (resp.status === 400) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/** `/api/show` fetch for vision + context window. Prefers the native payload's
 *  vision markers, else falls back to the image probe (inconclusive payload,
 *  or `/api/show` 404/405 on a cloud gateway). */
export async function fetchOllamaShowInfo(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<
  | {
      vision?: boolean;
      contextTokens?: number;
      parameters?: Partial<Record<string, number>>;
    }
  | undefined
> {
  const origin = deriveNativeOllamaOrigin(baseUrl);
  try {
    const show = await fetch(`${origin}/api/show?model=${encodeURIComponent(model)}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (show.ok) {
      const data = (await show.json().catch(() => undefined)) as unknown;
      const contextTokens = showPayloadContextLength(data);
      const parameters = showPayloadParameters(data);
      const vision = showPayloadVisionCapability(data);
      if (vision !== undefined) {
        return {
          vision,
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(parameters !== undefined ? { parameters } : {}),
        };
      }
      // Inconclusive native payload (cloud gateways omit the vision markers):
      // keep the window/params, but resolve vision with the image probe.
      const probed = await probeOllamaVision(baseUrl, model, apiKey, timeoutMs);
      return {
        ...(probed !== undefined ? { vision: probed } : {}),
        ...(contextTokens !== undefined ? { contextTokens } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
      };
    }
    // 404 / 405 on /api/show — cloud gateway likely; fall through to the probe.
    if (show.status !== 404 && show.status !== 405) return undefined;
  } catch {
    return undefined;
  }
  const vision = await probeOllamaVision(baseUrl, model, apiKey, timeoutMs);
  return vision === undefined ? undefined : { vision };
}

export async function detectOllamaVision(
  baseUrl: string,
  model: string,
  apiKey: string,
  timeoutMs = 15_000,
): Promise<boolean | undefined> {
  return (await fetchOllamaShowInfo(baseUrl, model, apiKey, timeoutMs))?.vision;
}

/** Batch size that stays under the cloud's parallel-burst rate limit (19
 *  concurrent probes 429'd ~half of them; 6 with a 429 retry stays clean). */
const OLLAMA_PROBE_BATCH = 6;

/** App-global snapshot of the fetched Ollama catalog — endpoint + key are
 *  global config, so the catalog is fetched once and shared across every tab
 *  (previously each tab fetched and cached its own copy). */
export interface OllamaCatalogSnapshot {
  models: string[];
  /** Subset of `models` confirmed vision-capable (raw ids, e.g. `llava`). */
  visionModels?: string[];
  plan?: string;
  hiddenCount?: number;
  error?: string;
  fetchedAt: number;
}

/** Reuse the cached catalog for this long on non-force refreshes — rapid
 *  model-menu opens / tab effects hit the cache instead of the network. */
const OLLAMA_CATALOG_TTL_MS = 60_000;

let ollamaCatalogCache: OllamaCatalogSnapshot | null = null;
let ollamaCatalogInflight: Promise<OllamaCatalogSnapshot> | null = null;

/** Prefixed vision set (`ollama/<id>`) built from the last fetched catalog.
 *  Empty set when the catalog is unavailable — image capability then falls
 *  back to the static allowlist (no Ollama model is treated as vision). */
export function ollamaVisionModelIds(): ReadonlySet<string> {
  const snap = ollamaCatalogCache;
  if (!snap?.visionModels) return new Set();
  return new Set(snap.visionModels.map((id) => `ollama/${id}`));
}

/** Test-only: reset the module-level catalog cache between tests. */
export function resetOllamaCatalogCacheForTest(): void {
  ollamaCatalogCache = null;
  ollamaCatalogInflight = null;
}

/** Broadcast the current catalog to every tab — emitted without a tabId so the
 *  frontend routes it into app-global state (all tabs share one list). */
function emitOllamaCatalog(snap: OllamaCatalogSnapshot): void {
  emit({
    type: "$ollama_models",
    models: snap.models,
    ...(snap.visionModels !== undefined ? { visionModels: snap.visionModels } : {}),
    ...(snap.error !== undefined ? { error: snap.error } : {}),
    ...(snap.plan !== undefined ? { plan: snap.plan } : {}),
    ...(snap.hiddenCount !== undefined ? { hiddenCount: snap.hiddenCount } : {}),
  });
}

function emitOpencodeCatalog(snap: {
  models: string[];
  visionModels?: string[];
  credentialed?: boolean;
  error?: string;
}): void {
  emit({
    type: "$opencode_models",
    models: snap.models,
    ...(snap.visionModels !== undefined ? { visionModels: snap.visionModels } : {}),
    ...(snap.credentialed !== undefined ? { credentialed: snap.credentialed } : {}),
    ...(snap.error !== undefined ? { error: snap.error } : {}),
  });
}

const providerCatalogs: Partial<Record<CatalogProvider, ProviderCatalog>> = {};
async function refreshProviderCatalogs(force = false, provider?: string): Promise<void> {
  // Every provider that publishes a discovery endpoint is declared in
  // providers.json; its fallback catalog and exclusions come from the same entry.
  const definitions = PROVIDER_SPECS.filter(
    (spec) => spec.discovery.strategy === "models-endpoint",
  );
  await Promise.all(
    definitions
      .filter((spec) => !provider || spec.id === provider)
      .map(async (spec) => {
        const catalogId = spec.id as CatalogProvider;
        const endpoint = loadCatalogEndpoint(spec.id);
        providerCatalogs[catalogId] = endpoint.baseUrl
          ? await fetchProviderModels({
              provider: catalogId,
              baseUrl: endpoint.baseUrl,
              apiKey: endpoint.apiKey,
              fallback: spec.models,
              force,
            })
          : {
              provider: catalogId,
              models: [...spec.models],
              source: "fallback" as const,
              error: "No endpoint configured",
            };
      }),
  );
  publishProviderCatalogs();
}
let publishProviderCatalogs = () => {};

/** Fetch the repo history for the Settings changelog page. Broadcast tabId-less
 *  (like $opencode_models): it depends on no tab state, so one fetch serves every
 *  tab. The backend cache absorbs repeat visits. */
export async function refreshChangelog(force = false, tab?: Tab): Promise<void> {
  const snap = await fetchChangelog({ force });
  emit({
    type: "$changelog",
    releases: snap.releases,
    version: VERSION,
    ...(snap.error !== undefined ? { error: snap.error } : {}),
  });
  if (tab && snap.error && snap.releases.length === 0) {
    emit({ type: "$error", message: `Changelog unavailable: ${snap.error}` }, tab.id);
  }
}

export async function refreshOpencodeModels(force = false, tab?: Tab): Promise<void> {
  const credentialed = hasOpencodeCredential();
  try {
    const snap = await fetchOpencodeModels({ force, credentialed });
    emitOpencodeCatalog({ ...snap, credentialed });
    if (tab && snap.error) {
      emit({ type: "$error", message: `OpenCode model sync warning: ${snap.error}` }, tab.id);
    }
  } catch (err) {
    const message = `OpenCode model sync failed: ${(err as Error).message}`;
    emitOpencodeCatalog({ models: [...OPENCODE_MODELS], credentialed, error: message });
    if (tab) emit({ type: "$error", message }, tab.id);
  }
}

function ollamaScopeKey(ep: { apiKey?: string }, base: string): string {
  return ep.apiKey ? scopeKeyFor(base, ep.apiKey) : base;
}

function ollamaFallbackSnapshot(endpointKey: string, error: string): OllamaCatalogSnapshot | null {
  const diskCache = loadOllamaModelsCache(endpointKey);
  const fallback = diskCache ?? (ollamaCatalogCache?.models.length ? ollamaCatalogCache : null);
  if (!fallback || fallback.models.length === 0) return null;
  return {
    models: fallback.models,
    visionModels: fallback.visionModels,
    plan: fallback.plan,
    hiddenCount: fallback.hiddenCount,
    error,
    fetchedAt: fallback.fetchedAt,
  };
}

/** Fetch the Ollama catalog — `GET {base}/models` on the resolved endpoint;
 *  cloud keys' plan (POST /api/me) gates probing; errors ship as `error`.
 *  The optional `tab` only feeds diagnostics — the result is tab-independent. */
async function fetchOllamaCatalog(tab?: Tab): Promise<OllamaCatalogSnapshot> {
  const ep = loadOllamaEndpoint();
  const base = ep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL;
  const endpointKey = ollamaScopeKey(ep, base);
  const diag = (
    event: string,
    details?: Record<string, unknown>,
    level: DesktopDiagnosticEvent["level"] = "debug",
  ): void => {
    emitDiagnostic(
      event,
      { ...(tab ? tabDiagnosticState(tab) : {}), ...details },
      { tabId: tab?.id, level },
    );
  };
  try {
    const resp = await fetch(`${base}/models`, {
      method: "GET",
      headers: ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const status = resp.status;
      diag("ollama.models_fetch.failed", { status });
      const error =
        status === 401 || status === 403
          ? "Ollama API key rejected"
          : `Ollama endpoint returned HTTP ${status}`;
      process.stderr.write(
        `reasonix: Ollama endpoint returned HTTP ${status}, checking cached models\n`,
      );
      if (status !== 401 && status !== 403) {
        const fallback = ollamaFallbackSnapshot(endpointKey, error);
        if (fallback) return fallback;
      }
      return {
        models: [],
        error,
        fetchedAt: Date.now(),
      };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: unknown }> };
    const models = (data?.data ?? [])
      .map((m) => (typeof m.id === "string" && m.id.length > 0 ? m.id : undefined))
      .filter((id): id is string => id !== undefined)
      .sort();
    diag("ollama.models_fetch.ok", { count: models.length });

    const gated = new Set<string>();
    const apiKey = ep.apiKey;
    // Plan is re-checked every refresh (one cheap request) so the verdict
    // scope matches the current plan; learned verdicts persist in
    // `~/.reasonix/ollama-model-map.json`, keyed by plan + endpoint + key hash.
    const plan = apiKey ? await fetchOllamaPlan(base, apiKey) : undefined;
    if (plan && apiKey) {
      const path = ollamaVerdictsPath();
      const store = loadOllamaVerdicts(path);
      const scope = scopeKeyFor(base, apiKey);
      const { known, unknown } = partitionByVerdicts(models, store, plan, scope, Date.now());
      for (const [model, verdict] of known) {
        if (verdict.result === "gated") gated.add(model);
      }
      if (unknown.length > 0) {
        for (let i = 0; i < unknown.length; i += OLLAMA_PROBE_BATCH) {
          const batch = unknown.slice(i, i + OLLAMA_PROBE_BATCH);
          const results = await Promise.allSettled(
            batch.map((m) => probeOllamaModel(base, m, apiKey)),
          );
          results.forEach((r, j) => {
            const model = batch[j]!;
            if (r.status === "fulfilled" && (r.value === "ok" || r.value === "gated")) {
              setVerdict(store, plan, scope, model, r.value, Date.now());
              if (r.value === "gated") gated.add(model);
            }
            // Probe errors stay unmapped — retried next refresh, so a
            // transient failure can never permanently hide a model.
          });
        }
        try {
          saveOllamaVerdicts(store, path);
        } catch (err) {
          diag("ollama.verdicts.save_failed", { message: messageOf(err) }, "warn");
        }
        diag("ollama.probe.done", {
          total: unknown.length,
          cached: known.size,
          gated: gated.size,
        });
      }
      diag("ollama.plan.resolved", { plan });
    }
    const visible = gated.size > 0 ? models.filter((m) => !gated.has(m)) : models;
    // Vision capability is independent of tier gating: probe every visible
    // model once (native /api/show with image-probe fallback) and persist the
    // result on the existing verdict entry when a plan/scope is available.
    // Keyless local daemons have no scope — the set still lives on the
    // snapshot so the UI can enable image upload for vision models.
    const vision = new Set<string>();
    if (visible.length > 0) {
      const visionPath = ollamaVerdictsPath();
      const visionStore = loadOllamaVerdicts(visionPath);
      const visionScope = plan && apiKey ? scopeKeyFor(base, apiKey) : undefined;
      const cached = visionScope
        ? visionModelsFor(visible, visionStore, plan!, visionScope, Date.now())
        : new Set<string>();
      const toProbe = visible.filter((m) => !cached.has(m));
      let visionPersisted = false;
      for (const m of toProbe) {
        const info = await fetchOllamaShowInfo(base, m, apiKey ?? "");
        if (info?.vision === true) vision.add(m);
        if (info !== undefined && visionScope && plan) {
          // Re-read the cached entry if present so we don't clobber a tier
          // verdict that a concurrent pass wrote; then stamp vision + window.
          const existing = verdictFor(visionStore, plan, visionScope, m, Date.now());
          setVerdict(
            visionStore,
            plan,
            visionScope,
            m,
            existing?.result ?? "ok",
            existing?.at ?? Date.now(),
            info.vision,
            info.contextTokens,
            info.parameters,
          );
          visionPersisted = true;
        }
      }
      for (const m of cached) vision.add(m);
      if (visionPersisted) {
        try {
          saveOllamaVerdicts(visionStore, visionPath);
        } catch (err) {
          diag("ollama.vision.save_failed", { message: messageOf(err) }, "warn");
        }
      }
      diag("ollama.vision.done", { total: visible.length, vision: vision.size });
    }
    const snapshot: OllamaCatalogSnapshot = {
      models: visible,
      visionModels: vision.size > 0 ? [...vision].sort() : undefined,
      plan,
      hiddenCount: gated.size > 0 ? gated.size : undefined,
      fetchedAt: Date.now(),
    };
    try {
      const endpointKey = ep.apiKey ? scopeKeyFor(base, ep.apiKey) : base;
      saveOllamaModelsCache(endpointKey, {
        models: snapshot.models,
        visionModels: snapshot.visionModels,
        plan: snapshot.plan,
        hiddenCount: snapshot.hiddenCount,
        fetchedAt: snapshot.fetchedAt,
      });
    } catch (err) {
      diag("ollama.cache.save_failed", { message: messageOf(err) }, "warn");
    }
    return snapshot;
  } catch (err) {
    const message = messageOf(err);
    diag("ollama.models_fetch.error", { message });
    process.stderr.write(
      `reasonix: failed to fetch Ollama models (${message}), falling back to cached models\n`,
    );
    const fallback = ollamaFallbackSnapshot(endpointKey, `Ollama unreachable: ${message}`);
    if (fallback) return fallback;
    return { models: [], error: `Ollama unreachable: ${message}`, fetchedAt: Date.now() };
  }
}

/** Refresh (or reuse) the app-global Ollama catalog and broadcast it to every
 *  tab. Concurrent calls collapse onto one in-flight fetch; non-force calls
 *  reuse a fresh cache (< TTL). Errors broadcast but are never cached. */
export async function refreshOllamaModels(
  force: boolean,
  tab?: Tab,
): Promise<OllamaCatalogSnapshot> {
  if (ollamaCatalogInflight) return ollamaCatalogInflight;
  const ep = loadOllamaEndpoint();
  const base = ep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL;
  const endpointKey = ollamaScopeKey(ep, base);
  if (!ollamaCatalogCache) {
    const diskCache = loadOllamaModelsCache(endpointKey);
    if (diskCache && diskCache.models.length > 0) {
      ollamaCatalogCache = {
        models: diskCache.models,
        visionModels: diskCache.visionModels,
        plan: diskCache.plan,
        hiddenCount: diskCache.hiddenCount,
        fetchedAt: diskCache.fetchedAt,
      };
    }
  }
  const cached = ollamaCatalogCache;
  if (!force && cached && !cached.error && Date.now() - cached.fetchedAt < OLLAMA_CATALOG_TTL_MS) {
    emitOllamaCatalog(cached);
    return cached;
  }
  const inflight = fetchOllamaCatalog(tab)
    .then((snap) => {
      if (!snap.error || snap.models.length > 0) {
        ollamaCatalogCache = snap;
      }
      emitOllamaCatalog(snap);
      return snap;
    })
    .finally(() => {
      ollamaCatalogInflight = null;
    });
  ollamaCatalogInflight = inflight;
  return inflight;
}

/** Floor between wallet reads. Unlike plan usage, no provider declares one, so the
 *  daemon owns it: a wallet moves only when someone spends or tops up. */
const WALLET_FLOOR_MS = 60_000;

async function emitBalance(tab: Tab, options: { force?: boolean } = {}): Promise<void> {
  if (!tab.runtime) {
    emitTabDiagnostic(tab, "balance.skipped", { reason: "runtime-not-ready" });
    return;
  }
  // Only a provider that declares a balance endpoint has one to read; every other
  // tab shows the measured $ cost instead of a chip that would sit empty.
  const balance = providerSpec(providerForModel(tab.currentModel))?.billing.balance ?? null;
  if (!balance) {
    emitTabDiagnostic(tab, "balance.skipped", { reason: "no-balance-endpoint" });
    return;
  }
  emitTabDiagnostic(tab, "balance.fetch.started");
  // Account-scoped, so a wallet read is shared by every tab on this client and
  // replayed inside the floor: a turn end with several open tabs must not fan out
  // into one wallet request per tab. No provider declares a wallet floor, so this
  // one is the daemon's own.
  const client = tab.runtime.loop.client;
  const wallet = scopedQuotaCoordinator(
    client,
    `balance|${balance.url}|${providerForModel(tab.currentModel)}`,
    WALLET_FLOOR_MS,
    () => client.getBalance({ url: balance.url, shape: balance.shape }),
    { hasData: (value) => value !== null, reason: () => "balance-unavailable" },
  );
  const delivery = await wallet.fetch({ force: options.force }).catch((err) => {
    emitDiagnosticError("balance.fetch.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    return null;
  });
  const bal = delivery?.value ?? null;
  if (!bal) return;
  const primary = pickPrimaryBalance(bal.balance_infos);
  if (!primary) {
    emitTabDiagnostic(tab, "balance.fetch.empty", { balances: bal.balance_infos.length }, "warn");
    return;
  }
  const balanceInfos = bal.balance_infos.map((info) => ({
    currency: info.currency,
    total: Number(info.total_balance),
    granted: info.granted_balance ? Number(info.granted_balance) : undefined,
    toppedUp: info.topped_up_balance ? Number(info.topped_up_balance) : undefined,
  }));
  emit(
    {
      type: "$balance",
      currency: primary.currency,
      total: Number(primary.total_balance),
      isAvailable: bal.is_available,
      balanceInfos,
    },
    tab.id,
  );
  emitTabDiagnostic(tab, "balance.fetch.succeeded", {
    currency: primary.currency,
    isAvailable: bal.is_available,
    balances: balanceInfos.length,
  });
}

/** ChatGPT-plan Codex quota fetch, coalesced across tabs. */
const codexQuotaCoordinator = new AccountQuotaCoordinator(
  async () => {
    return await fetchCodexQuotaViaOAuth(10_000);
  },
  15_000,
  Date.now,
  {
    started: (requestId) => emitDiagnostic("quota.snapshot.fetch.started", { requestId }),
    succeeded: (requestId, result) =>
      emitDiagnostic("quota.snapshot.fetch.succeeded", {
        requestId,
        plan: result.quota?.plan,
      }),
    failed: (requestId, reason) =>
      emitDiagnostic("quota.snapshot.fetch.failed", { requestId, reason }, { level: "error" }),
  },
);

/** What a reader hands back about the plan: the normalized windows plus any credit
 *  the same payload reported. The dispatcher stamps the probe, so a reader cannot
 *  mislabel its own reading. */
type UsageReadout = ProviderUsageView & { credit?: ProviderUsage["credit"] };

/** One probe's read: the normalized usage the tab's chip consumes, plus what to log. */
interface UsageProbe {
  /** Normalized plan usage, or null when the probe produced no reading. */
  usage: UsageReadout | null;
  status: "ok" | "skipped" | "failed";
  /** The read had no data (failed) or a decision kept it from running (skipped). */
  reason?: string;
  details?: Record<string, unknown>;
}

/** A probe reader: fetch + parse one provider's usage. Credentials, tier gates and
 *  the payload shape are the reader's business; emitting is the dispatcher's. */
type UsageReader = (tab: Tab, options: { force?: boolean }) => Promise<UsageProbe>;

/** The shared coordinator for one provider's usage source: endpoint + credential are
 *  the identity (a different account starts cold) and the declared floor is the TTL. */
function usageCoordinatorFor<T>(
  providerId: string,
  endpoint: string,
  credential: string,
  fetcher: () => Promise<T>,
  outcome: QuotaOutcome<T>,
): QuotaCoordinator<T> {
  const spec = providerSpec(providerId);
  return quotaCoordinator<T>(
    quotaCacheKey(providerId, endpoint, credential),
    usageMinIntervalMs(spec),
    fetcher,
    outcome,
  );
}

/** A read that produced nothing, in the shape the dispatcher reports as failed. */
function noUsage(reason: string, details?: Record<string, unknown>): UsageProbe {
  return { usage: null, status: "failed", reason, ...(details ? { details } : {}) };
}

/** ChatGPT-plan Codex quota — OAuth HTTP only (no codex CLI dependency). */
async function readCodexUsage(_tab: Tab, options: { force?: boolean }): Promise<UsageProbe> {
  const delivery = await codexQuotaCoordinator.fetch(options).catch((err) => ({
    value: { quota: null as CodexQuota | null, reason: messageOf(err) },
    delivery: "underlying" as const,
    requestId: -1,
    at: Date.now(),
  }));
  const quota = delivery.value.quota;
  const reason = delivery.value.reason;
  if (quota) {
    return {
      usage: codexUsageView(quota),
      status: "ok",
      details: {
        plan: quota.plan,
        fiveHour: quota.fiveHour,
        weekly: quota.weekly,
        delivery: delivery.delivery,
        requestId: delivery.requestId,
      },
    };
  }
  return noUsage(reason ?? "no-quota-data", {
    delivery: delivery.delivery,
    requestId: delivery.requestId,
  });
}

/** One window from `GET {origin}/api/balance` — the % still available and its
 *  reset time. */
export interface OllamaBalanceWindow {
  remainingPct: number;
  resetsAt: number | null;
}

/** Parse one `included.*` window, or null when the field is absent/malformed. */
function parseOllamaBalanceWindow(raw: unknown): OllamaBalanceWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.remaining_percent !== "number") return null;
  const reset = typeof r.resets_at === "string" ? Date.parse(r.resets_at) : Number.NaN;
  return { remainingPct: r.remaining_percent, resetsAt: Number.isFinite(reset) ? reset : null };
}

/** Ollama Cloud plan balance — the declared `/api/balance` route (Bearer key).
 *  Holds the limit the statusbar needs: `included.session/weekly.remaining_percent`
 *  plus `purchased.balance_usd`. Undefined on any failure. */
export async function fetchOllamaBalance(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<OllamaBalance | undefined> {
  const reply = await fetchQuotaJson({
    urls: usageUrls(providerSpec("ollama"), baseUrl),
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs,
  });
  if (!reply.ok) return undefined;
  const data = (reply.body ?? {}) as { included?: unknown; purchased?: unknown };
  const included = (data.included ?? {}) as Record<string, unknown>;
  const session = parseOllamaBalanceWindow(included.session);
  const weekly = parseOllamaBalanceWindow(included.weekly);
  if (!session && !weekly) return undefined;
  const purchased = (data.purchased ?? {}) as Record<string, unknown>;
  return {
    session,
    weekly,
    purchasedUsd: typeof purchased.balance_usd === "number" ? purchased.balance_usd : null,
  };
}

interface OllamaBalance {
  session: OllamaBalanceWindow | null;
  weekly: OllamaBalanceWindow | null;
  purchasedUsd: number | null;
}

/** Reset the shared balance cache + baseline (tests only). */
export function resetOllamaBalanceCacheForTest(): void {
  resetQuotaCoordinators();
}

/** One coalesced balance read shared across every tab, replayed inside the declared
 *  floor — a failure included, so a tab burst cannot hammer an endpoint that just
 *  rate-limited us. `fetched` marks the caller that hit the network. */
export async function ollamaBalanceSnapshot(
  baseUrl: string,
  apiKey: string,
  force: boolean,
): Promise<{
  balance: OllamaBalance | undefined;
  fetchedAt: number;
  fetched: boolean;
}> {
  const coordinator = usageCoordinatorFor<OllamaBalance | undefined>(
    "ollama",
    baseUrl,
    apiKey,
    () => fetchOllamaBalance(baseUrl, apiKey),
    { hasData: (balance) => balance !== undefined },
  );
  const delivery = await coordinator.fetch({ force });
  return {
    balance: delivery.value,
    fetchedAt: delivery.at,
    fetched: delivery.delivery === "underlying",
  };
}
/** Cloud Ollama plan usage for the signed-in account, shared across every tab. */
async function readOllamaUsage(_tab: Tab, options: { force?: boolean }): Promise<UsageProbe> {
  const ep = loadOllamaEndpoint();
  const apiKey = ep.apiKey;
  if (!apiKey) {
    // A keyless endpoint still shows the chip; the setup flag makes the statusbar
    // render its set-an-API-key hint and clear the refresh spinner.
    return { usage: null, status: "skipped", reason: "ollama-no-api-key" };
  }
  const snap = await ollamaBalanceSnapshot(
    ep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL,
    apiKey,
    !!options.force,
  );
  const balance = snap.balance;
  if (!balance) {
    return noUsage("usage-unavailable", { shared: !snap.fetched });
  }
  const toWindow = (w: OllamaBalanceWindow | null) =>
    w
      ? { usagePct: 100 - w.remainingPct, remainingPct: w.remainingPct, resetsAt: w.resetsAt }
      : null;
  // The account plan (free/pro) comes from the catalog's `/api/me` read, so the
  // chip can name a tier the balance payload itself never mentions.
  const view = ollamaUsageView(
    {
      session: toWindow(balance.session),
      weekly: toWindow(balance.weekly),
      purchasedUsd: balance.purchasedUsd,
      fetchedAt: snap.fetchedAt,
    },
    ollamaCatalogCache?.plan ?? null,
  );
  return {
    usage: {
      ...view,
      credit:
        typeof balance.purchasedUsd === "number"
          ? { currency: "USD", amount: balance.purchasedUsd }
          : null,
    },
    status: "ok",
    details: {
      sessionRemainingPct: balance.session?.remainingPct,
      weeklyRemainingPct: balance.weekly?.remainingPct,
      purchasedUsd: balance.purchasedUsd,
      shared: !snap.fetched,
    },
  };
}

/** Antigravity (Gemini Code Assist) plan + per-model windows, coalesced on the
 *  declared floor: `loadCodeAssist` for the plan, `retrieveUserQuota` for windows. */
async function readAntigravityUsage(_tab: Tab, options: { force?: boolean }): Promise<UsageProbe> {
  const auth = await resolveGeminiAuth();
  if (!auth) {
    return { usage: null, status: "failed", reason: "antigravity-not-signed-in" };
  }
  // The token rotates hourly: the fetcher closes over the current one and the key
  // deliberately omits it, so a rotation keeps the cache instead of a dead token.
  const coordinator = usageCoordinatorFor<AntigravityQuota>(
    "gemini",
    auth.projectId,
    "",
    () => fetchAntigravityQuota(auth.accessToken, auth.projectId),
    { hasData: () => true },
  );
  let quota: AntigravityQuota;
  try {
    quota = (await coordinator.fetch({ force: options.force })).value;
  } catch (err) {
    return noUsage(messageOf(err));
  }
  // The view picks the active model's bucket, else the most-consumed one.
  return {
    usage: antigravityUsageView(quota, _tab.currentModel),
    status: "ok",
    details: { plan: quota.plan?.tierId, windows: quota.windows.length },
  };
}

/** A raw `limits[]` row from Z.AI's monitor endpoint — only the fields we read. */
interface ZaiLimitRow {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
}

/** Z.AI GLM Coding Plan usage — the declared monitor route. The token/credit rows
 *  are matched by `unit` (3 = 5-hour, 6 = weekly); each carries a `percentage`
 *  (0-100) plus an epoch-ms `nextResetTime`. Undefined on any failure. */
export async function fetchZaiQuota(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<Omit<ZaiQuota, "fetchedAt"> | undefined> {
  const reply = await fetchQuotaJson({
    urls: usageUrls(providerSpec("zai"), baseUrl),
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs,
  });
  if (!reply.ok) return undefined;
  const data = (reply.body ?? {}) as {
    data?: { limits?: unknown; level?: unknown };
  };
  const limits = data?.data?.limits;
  if (!Array.isArray(limits)) return undefined;
  const toWindow = (unit: number): ZaiQuotaWindow | null => {
    const row = (limits as ZaiLimitRow[]).find(
      (r) => r && (r.type === "TOKENS_LIMIT" || r.type === "CREDIT_LIMIT") && r.unit === unit,
    );
    if (!row) return null;
    // The server usually reports `percentage` directly; fall back to the
    // currentValue/usage ratio for payloads that omit it.
    const pct =
      typeof row.percentage === "number"
        ? row.percentage
        : typeof row.currentValue === "number" && typeof row.usage === "number" && row.usage > 0
          ? (row.currentValue / row.usage) * 100
          : null;
    if (pct === null) return null;
    return {
      usagePct: pct,
      remainingPct: Math.max(0, 100 - pct),
      resetsAt: typeof row.nextResetTime === "number" ? row.nextResetTime : null,
    };
  };
  const fiveHour = toWindow(3);
  const weekly = toWindow(6);
  if (!fiveHour && !weekly) return undefined;
  const level = data?.data?.level;
  return { plan: typeof level === "string" ? level : null, fiveHour, weekly };
}

/** Z.AI GLM Coding Plan usage for a tab with a configured key, coalesced on the
 *  declared floor. */
async function readZaiUsage(_tab: Tab, options: { force?: boolean }): Promise<UsageProbe> {
  const apiKey = loadZaiApiKey();
  if (!apiKey) {
    return { usage: null, status: "skipped", reason: "zai-no-api-key" };
  }
  const baseUrl = loadEndpointForModel(_tab.currentModel).baseUrl ?? DEFAULT_ZAI_CHAT_URL;
  const coordinator = usageCoordinatorFor<Omit<ZaiQuota, "fetchedAt"> | undefined>(
    "zai",
    baseUrl,
    apiKey,
    () => fetchZaiQuota(baseUrl, apiKey),
    { hasData: (quota) => quota !== undefined },
  );
  const quota = (await coordinator.fetch({ force: options.force })).value;
  if (!quota) return noUsage("usage-unavailable");
  return {
    usage: zaiUsageView(quota),
    status: "ok",
    details: {
      plan: quota.plan,
      fiveHour: quota.fiveHour?.usagePct ?? null,
      weekly: quota.weekly?.usagePct ?? null,
    },
  };
}

/** MiMo subscription usage. The console API needs a web-session cookie (not the
 *  inference key), so without one the chip names the plan and no percentage — the
 *  declaration marks this provider's chip unit as `plan` for that case. */
async function readMiMoUsage(_tab: Tab, options: { force?: boolean }): Promise<UsageProbe> {
  const session = readMiMoConsoleSession();
  if (!session) {
    return { usage: null, status: "skipped", reason: "mimo-no-console-session" };
  }
  const coordinator = usageCoordinatorFor<MiMoQuota>(
    "mimo",
    mimoPlatform(),
    session.serviceToken,
    () => fetchMiMoQuota(session),
    { hasData: (quota) => quota.status === "available", reason: (quota) => quota.reason ?? null },
  );
  const quota = (await coordinator.fetch({ force: options.force })).value;
  return {
    usage: mimoUsageView(quota),
    status: quota.status === "available" ? "ok" : "failed",
    reason: quota.reason,
    details: { status: quota.status, remainingPercent: quota.remainingPercent },
  };
}

/** OpenCode Go plan usage for a tab with a credential, coalesced on the declared
 *  floor. Free/anon Zen models have no usage API, so they are skipped. */
async function readOpencodeUsage(_tab: Tab, options: { force?: boolean }): Promise<UsageProbe> {
  const plan = opencodeUsagePlan(_tab.currentModel);
  if (plan !== "go") {
    return {
      usage: null,
      status: "skipped",
      reason: plan === "free" ? "opencode-free-tier" : "opencode-not-go",
    };
  }
  const baseUrl = loadEndpointForModel(_tab.currentModel).baseUrl ?? DEFAULT_OPENCODE_CHAT_URL;
  // A Go subscription is required. The Go usage API accepts the workspace service
  // key, not a Console OAuth session token (that 401s), so prefer the key.
  const token = loadOpencodeApiKey() ?? (await resolveOpencodeToken());
  if (!token || token === "public") {
    return { usage: null, status: "skipped", reason: "opencode-no-credential" };
  }
  const coordinator = usageCoordinatorFor<Omit<OpencodeQuota, "fetchedAt"> | undefined>(
    "opencode",
    baseUrl,
    token,
    () => fetchOpencodeQuota(baseUrl, token),
    { hasData: (quota) => quota !== undefined },
  );
  const quota = (await coordinator.fetch({ force: options.force })).value;
  if (!quota) return noUsage("usage-unavailable");
  return {
    usage: opencodeUsageView(quota),
    status: "ok",
    details: {
      rolling: quota.rolling?.usagePct ?? null,
      weekly: quota.weekly?.usagePct,
      monthly: quota.monthly?.usagePct,
    },
  };
}

/** Reader per declared probe. Exhaustive by type: a new `usage.probe` in a provider
 *  file fails to compile until it has a reader here, and no caller names a provider. */
const USAGE_READERS: Record<ProviderProbeStrategy, UsageReader> = {
  "codex-oauth": readCodexUsage,
  "ollama-balance": readOllamaUsage,
  "antigravity-quota": readAntigravityUsage,
  "zai-monitor": readZaiUsage,
  "mimo-console": readMiMoUsage,
  "opencode-usage": readOpencodeUsage,
};

/** The probe a model's provider declares, or null when it publishes no plan window. */
function probeForModel(model: string): ProviderProbeStrategy | null {
  return providerSpec(providerForModel(model))?.usage.probe ?? null;
}

/** Refresh the tab's declared plan-usage chip: which probe runs, and how often it
 *  may hit the network, both come from the provider's declaration. */
async function refreshTabUsage(tab: Tab, options: { force?: boolean } = {}): Promise<void> {
  const probe = probeForModel(tab.currentModel);
  if (!probe) {
    emitTabDiagnostic(tab, "quota.skipped", { reason: "no-declared-probe" });
    return;
  }
  emitTabDiagnostic(tab, "quota.fetch.started", { probe, force: !!options.force });
  let result: UsageProbe;
  try {
    result = await USAGE_READERS[probe](tab, options);
  } catch (err) {
    result = { usage: null, status: "failed", reason: messageOf(err) };
  }
  if (result.status === "ok") {
    emitTabDiagnostic(tab, "quota.fetch.succeeded", { probe, ...result.details });
  } else if (result.reason) {
    emitTabDiagnostic(
      tab,
      result.status === "skipped" ? "quota.skipped" : "quota.fetch.failed",
      { probe, reason: result.reason, ...result.details },
      result.status === "skipped" ? "debug" : "error",
    );
  }
  emit(
    {
      type: "$usage",
      usage: result.usage ? { probe, ...result.usage } : null,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.status === "skipped" ? { needsSetup: true } : {}),
    },
    tab.id,
  );
}

/** Refresh everything the status bar reports about money: the declared usage window
 *  and the declared wallet. Both are coalesced and floored per declaration, so every
 *  caller (turn end, restore, activation, poll, chip click) can call this. */
async function refreshFunds(tab: Tab, options: { force?: boolean } = {}): Promise<void> {
  await Promise.allSettled([refreshTabUsage(tab, options), emitBalance(tab, options)]);
}

async function emitSessions(
  tab: Tab,
  settledDeletes?: SessionsEvent["settledDeletes"],
  options: { primeFromCache?: boolean } = {},
): Promise<void> {
  const startedAt = performance.now();
  // Stamped before the first await so a slow scan can never publish under a newer
  // revision than a fast one. A settle emit re-stamps at send (see below).
  const epoch = DESKTOP_SESSIONS_EPOCH;
  const requestRevision = nextSessionsRevision(tab.rootDir);
  const source = listSessionsForWorkspaceAsync(tab.rootDir);
  const request = {
    cache: source.cache,
    value: source.value.then(toSessionListItems),
  };
  emitTabDiagnostic(tab, "sessions.list.started", { cache: request.cache });
  try {
    // Paint the last-known list from the index cache while the store revalidates:
    // on a large store that scan is seconds, and the sidebar was blank until it
    // landed. A settle confirmation only ever rides the authoritative revision.
    let primed: SessionsEvent["items"] | null = null;
    if (options.primeFromCache && settledDeletes === undefined) {
      const cached = await source.cached;
      if (cached) {
        primed = toSessionListItems(cached);
        emit(
          {
            type: "$sessions",
            epoch,
            revision: requestRevision,
            primed: true,
            items: primed,
          },
          tab.id,
        );
        emitTabDiagnostic(tab, "sessions.list.primed", {
          count: primed.length,
          durationMs: Number((performance.now() - startedAt).toFixed(3)),
        });
      }
    }
    // Always follow a primed paint with the scan: the client only initialises from a
    // primed payload, so the authoritative one is what establishes its revision.
    const items = await request.value;
    // A settle confirmation re-stamps: its payload already reflects the delete, and
    // dropping it behind a concurrently started scan would strand an optimistic hide.
    const revision =
      settledDeletes === undefined ? requestRevision : nextSessionsRevision(tab.rootDir);
    emit(
      {
        type: "$sessions",
        epoch,
        revision,
        items,
        settledDeletes,
      },
      tab.id,
    );
    emitTabDiagnostic(tab, "sessions.list.completed", {
      count: items.length,
      cache: request.cache,
      primed: primed !== null,
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
    });
  } catch (err) {
    emitDiagnosticError("sessions.list.failed", err, {
      tabId: tab.id,
      details: { ...tabDiagnosticState(tab), cache: request.cache },
    });
    emit({ type: "$error", message: `session_list failed: ${(err as Error).message}` }, tab.id);
  }
}

function loadSessionIntoTab(
  tab: Tab,
  name: string,
  actions: {
    abortTurn: (tab: Tab) => void;
    cancelPendingGates: (tab: Tab) => void;
    persistOpenTabs: () => void;
  },
): void {
  emitTabDiagnostic(tab, "session.load.started", { name });
  const records = loadSessionMessages(name);
  const backfilledWorkspace =
    patchSessionWorkspaceIfMissing(name, tab.rootDir) || stampSessionWorkspace(name, tab.rootDir);
  const meta = loadSessionMeta(name);
  // Only set switching flag when there's a live turn to abort —
  // otherwise the flag stays true and suppresses the first turn's events (#1217).
  if (tab.aborter) tab.switching = true;
  actions.abortTurn(tab);
  actions.cancelPendingGates(tab);
  tab.currentSession = name;
  freezeLegacySessionMcp(tab, name);
  actions.persistOpenTabs();
  // Rebind model + effort to the conversation's stored pair before the
  // runtime rebuild, so the loop is constructed with the right model.
  restoreSessionModelPrefs(tab, meta);
  tab.runtime = tab.toolset && tabCurrentModelUsable(tab) ? buildRuntimeFor(tab) : null;
  const loadedMessages = mergeNoticesIntoLoaded(
    buildLoadedMessages(records),
    loadSessionNotices(name),
    meta.lastTurn,
  );
  if (loadedMessages.length === 0) {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(sessionPath(name)).size;
    } catch {
      void 0; /* file may not exist */
    }
    if (sizeBytes > 0) {
      emitTabDiagnostic(
        tab,
        "session.load.empty",
        { name, sizeBytes, records: records.length },
        "warn",
      );
      process.stderr.write(
        `session_load: "${name}" returned 0 messages (file size=${sizeBytes}B): empty or unreadable jsonl\n`,
      );
      emit({ type: "$session_empty", name, sizeBytes }, tab.id);
    }
  }
  const paged = sessionWindow(loadedMessages, 0);
  emit(
    {
      type: "$session_loaded",
      name,
      messages: paged.page,
      hasOlder: paged.hasOlder,
      turnBase: paged.turnBase,
      events: loadSessionEvents(name),
      carryover: sessionCarryover(meta),
    },
    tab.id,
  );
  emitRestoredPlan(tab, loadedMessages.length > 0);
  emitCtxBreakdown(tab);
  emitSettings(tab);
  if (backfilledWorkspace) {
    void emitSessions(tab);
  }
  emitTabDiagnostic(tab, "session.load.completed", {
    name,
    records: records.length,
    loadedMessages: loadedMessages.length,
    backfilledWorkspace,
    carryover: sessionCarryover(meta),
  });
}

function summarizeMcpSpec(raw: string): McpSpecInfo {
  try {
    const parsed = parseMcpSpec(raw);
    if (parsed.transport === "stdio") {
      const argv = [parsed.command, ...parsed.args].join(" ");
      return {
        raw,
        name: parsed.name,
        transport: "stdio",
        summary: `stdio · ${argv}`,
        status: "configured",
      };
    }
    return {
      raw,
      name: parsed.name,
      transport: parsed.transport,
      summary: `${parsed.transport} · ${parsed.url}`,
      status: "configured",
    };
  } catch (err) {
    return {
      raw,
      name: null,
      transport: "stdio",
      summary: raw,
      parseError: (err as Error).message,
      status: "failed",
      statusReason: (err as Error).message,
    };
  }
}

/** The named (non-anonymous) configured MCP servers for a workspace. */
function namedMcpSpecs(rootDir: string): Array<McpServerSpec & { name: string }> {
  return loadEffectiveMcpConfig(rootDir).filter((spec): spec is McpServerSpec & { name: string } =>
    Boolean(spec.name),
  );
}

/** Absolute session MCP state from the set of servers the chat may NOT use. */
function makeSessionMcpState(disabledServers: Iterable<string>): SessionMcpState {
  const sorted = [...new Set(disabledServers)].sort();
  return sorted.length ? { disabledServers: sorted } : {};
}

/** Snapshot the Settings → MCP default as a fresh session's absolute state. */
function sessionMcpFromConfig(rootDir: string): SessionMcpState {
  return makeSessionMcpState(
    namedMcpSpecs(rootDir)
      .filter((spec) => spec.disabled === true)
      .map((spec) => spec.name),
  );
}

/** The capability set a session-start confirm freezes: every configured server the
 *  user did not enable is recorded disabled, and the subagent flag is exactly what was
 *  picked. One writer, so a session's two capabilities cannot disagree. */
export function sessionSetupMeta(
  configuredServers: readonly string[],
  enabledServers: readonly string[],
  subagents: boolean,
): Pick<SessionMeta, "mcp" | "subagents"> {
  const enabled = new Set(enabledServers);
  return {
    mcp: makeSessionMcpState(configuredServers.filter((name) => !enabled.has(name))),
    subagents: subagents === true,
  };
}

/** The active session's stored MCP state. `undefined` = a session created before
 *  the field existed — callers fall back to the config default. */
function sessionMcpState(name: string): SessionMcpState | undefined {
  if (!name) return undefined;
  const meta = loadSessionMeta(name);
  if (meta.mcp === undefined) return undefined;
  return normalizeSessionMcpState(meta.mcp) ?? {};
}

/** Session overlay for the MCP runtime; `undefined` (legacy session) = use default. */
function sessionMcpOverrides(name: string): McpSpecOverrides | undefined {
  const state = sessionMcpState(name);
  if (state === undefined) return undefined;
  return {
    disabledServers: new Set(state.disabledServers ?? []),
  };
}

/** Legacy sessions predate the frozen-MCP model: snapshot the current Settings
 *  default once so the session's server set stops tracking later edits. */
function freezeLegacySessionMcp(tab: Tab, name: string): void {
  if (tab.mcpSetupPending) return;
  try {
    const meta = loadSessionMeta(name);
    // A session still awaiting its MCP confirmation is not legacy — the boot
    // sweep owns it; backfilling the default here would make it look configured.
    if (meta.mcpPending === true) return;
    if (meta.mcp !== undefined) return;
    patchSessionMeta(name, { mcp: sessionMcpFromConfig(tab.rootDir) });
  } catch (err) {
    /* best-effort — a failure leaves the session mirroring the default */
    process.stderr.write(`reasonix: legacy session MCP freeze failed — ${messageOf(err)}\n`);
  }
}

/** Config specs for a tab with the active session's MCP overlay applied. */
function effectiveMcpSpecs(tab: Tab): McpServerSpec[] {
  return applyMcpSessionOverrides(
    loadEffectiveMcpConfig(tab.rootDir),
    sessionMcpOverrides(tab.currentSession),
  );
}

/** Arm a session's setup gate: it withholds `$ready` until the picker is confirmed, and
 *  re-emits the pre-fill because a failed confirm re-arms instead of stranding the UI. */
function armSessionGate(tab: Tab): void {
  tab.mcpSetupPending = true;
  const servers = namedMcpSpecs(tab.rootDir).map((spec) => ({
    name: spec.name,
    enabled: spec.disabled !== true,
    builtin: isManagedMcpSpec(spec),
  }));
  emitTabDiagnostic(tab, "tab.setup.required", { reason: "mcp-setup" }, "info");
  emit({ type: "$mcp_setup", servers, subagents: tab.subagents }, tab.id);
}

/** Report a failed confirm and re-arm the gate. The frontend dismisses the picker only
 *  on `$ready` / `$needs_setup`, so a silent failure strands it forever; re-confirming is
 *  safe because the capability patch is a full snapshot. */
function failSessionSetup(tab: Tab, err: unknown): void {
  emitDiagnosticError("mcp.session.configure.failed", err, {
    tabId: tab.id,
    details: tabDiagnosticState(tab),
  });
  emit({ type: "$error", message: `mcp_session_configure: ${messageOf(err)}` }, tab.id);
  armSessionGate(tab);
}

function emitMcpSpecs(tab: Tab): void {
  const normalized = loadEffectiveMcpConfig(tab.rootDir);
  // Session-scoped view. A legacy session (undefined) mirrors the default.
  const session = sessionMcpState(tab.currentSession);
  const specs = normalized.map((spec) => {
    const raw = specToRaw(spec);
    const base = summarizeMcpSpec(raw);
    // Settings-default toggle state — visible even before the first bridge.
    base.disabled = spec.disabled === true;
    // Reasonix+ managed servers are built-in: disableable but not removable.
    base.builtin = isManagedMcpSpec(spec);
    // Session enablement — frozen at chat creation; a legacy session mirrors the default.
    const sessionDisabled = session
      ? Boolean(spec.name && session.disabledServers?.includes(spec.name))
      : spec.disabled === true;
    if (sessionDisabled) base.sessionDisabled = true;
    const live =
      tab.mcpStatuses.get(raw) ?? (spec.name ? tab.mcpStatuses.get(spec.name) : undefined);
    let merged: McpSpecInfo = live
      ? { ...base, status: live.kind, statusReason: live.reason, toolCount: live.toolCount }
      : base;
    // A session-disabled server never reports live "connected" — the reload path stops it.
    if (sessionDisabled) merged = { ...merged, status: "disabled" };
    return merged;
  });
  const bridged = specs.length > 0 && specs.every((s) => s.status === "connected");
  emit({ type: "$mcp_specs", specs, bridged }, tab.id);
  emitTabDiagnostic(tab, "mcp.specs.emitted", {
    configured: specs.length,
    connected: specs.filter((spec) => spec.status === "connected").length,
    bridged,
  });
}

/** Extension-integration state for the Settings card — pure so tests can pin it. */
export function computeMcpExtensionStatus(cfg: ReasonixConfig): McpExtensionStatus {
  const entry = cfg.mcpServers?.playwright;
  const args = entry?.args ?? [];
  const token = entry?.env?.[PLAYWRIGHT_EXTENSION_TOKEN_ENV];
  const connection = parsePlaywrightConnection(args);
  return {
    storeUrl: PLAYWRIGHT_EXTENSION_STORE_URL,
    server: {
      configured: Boolean(entry),
      ...connection,
      hasExtensionArg: args.includes(PLAYWRIGHT_EXTENSION_ARG),
      tokenPrefix: token ? `${token.slice(0, 6)}…${token.slice(-3)}` : undefined,
      args,
    },
  };
}

function emitMcpExtensionStatus(tab: Tab): void {
  const status = computeMcpExtensionStatus(readConfig());
  const ev: McpExtensionStatusEvent = { type: "$mcp_extension_status", status };
  emit(ev, tab.id);
}

const mailAuthGeneration = new Map<string, number>();
const mailAuthControllers = new Map<string, AbortController>();

function mailAuthKey(tab: Tab, provider: MailProvider): string {
  return `${tab.id}:${provider}`;
}

function nextMailAuthGeneration(tab: Tab, provider: MailProvider): number {
  const key = mailAuthKey(tab, provider);
  const generation = (mailAuthGeneration.get(key) ?? 0) + 1;
  mailAuthGeneration.set(key, generation);
  return generation;
}

/** Abort any in-flight flow for a provider and invalidate its pending callbacks. */
function cancelMailAuth(tab: Tab, provider: MailProvider): void {
  const key = mailAuthKey(tab, provider);
  nextMailAuthGeneration(tab, provider);
  mailAuthControllers.get(key)?.abort();
  mailAuthControllers.delete(key);
}

function emitMailAuth(
  tab: Tab,
  provider: MailProvider,
  state: Omit<MailAuthState, "provider">,
): void {
  emit({ type: "$mail_auth", state: { provider, ...state } }, tab.id);
}

interface MailAuthFlow {
  controller: AbortController;
  /** True once a newer flow started (or this one was cancelled) — bail out. */
  isStale: () => boolean;
  /** Release the controller slot when it's still ours. */
  finish: () => void;
}

/** Open a fresh auth flow for a provider: invalidate any prior generation, abort its
 *  controller, and install ours. Callers poll `isStale()` between awaits and call
 *  `finish()` in a `finally`. */
function beginMailAuthFlow(tab: Tab, provider: MailProvider): MailAuthFlow {
  const key = mailAuthKey(tab, provider);
  const generation = nextMailAuthGeneration(tab, provider);
  mailAuthControllers.get(key)?.abort();
  const controller = new AbortController();
  mailAuthControllers.set(key, controller);
  return {
    controller,
    isStale: () => mailAuthGeneration.get(key) !== generation,
    finish: () => {
      if (mailAuthControllers.get(key) === controller) mailAuthControllers.delete(key);
    },
  };
}

export function isManagedMcpSpec(spec: McpServerSpec): boolean {
  return isPlaywrightSpec(spec) || isOutlookMailSpec(spec) || isGmailMailSpec(spec);
}

function outlookMailConfigured(tab: Tab): boolean {
  return loadEffectiveMcpConfig(tab.rootDir).some(isOutlookMailSpec);
}

function configureOutlookMailServer(): void {
  const cfg = readConfig();
  const entry = MCP_CATALOG.find((candidate) => candidate.name === OUTLOOK_MAIL_SERVER_NAME);
  if (!entry) throw new Error("bundled catalog has no Outlook Mail entry");
  mergeMcpServerEntry(cfg, OUTLOOK_MAIL_SERVER_NAME, {
    transport: "stdio",
    command: "npx",
    args: [...OUTLOOK_MAIL_ARGS],
  });
  const stored = cfg.mcpServers?.[OUTLOOK_MAIL_SERVER_NAME];
  if (!stored) throw new Error("failed to create the Outlook Mail server entry");
  stored.transport = "stdio";
  stored.command = "npx";
  stored.args = [...OUTLOOK_MAIL_ARGS];
  // Managed auth owns the token cache. Drop legacy/custom auth env so no access token,
  // client secret, or alternate tenant silently survives migration into this integration.
  stored.env = { MS365_MCP_TENANT_ID: "consumers" };
  writeConfig(cfg);
}

function configureGmailMailServer(): void {
  const cfg = readConfig();
  mergeMcpServerEntry(cfg, GMAIL_MAIL_SERVER_NAME, {
    transport: "streamable-http",
    url: GMAIL_MCP_URL,
  });
  const stored = cfg.mcpServers?.[GMAIL_MAIL_SERVER_NAME];
  if (!stored) throw new Error("failed to create the Gmail Mail server entry");
  stored.transport = "streamable-http";
  stored.url = GMAIL_MCP_URL;
  writeConfig(cfg);
}

/** Drop the managed mail server for the provider that is NOT selected so exactly one
 *  mail integration bridges. Gmail OAuth credentials live separately and survive. */
function pruneUnselectedMailServer(provider: MailProvider): void {
  const other = provider === MailProvider.Gmail ? OUTLOOK_MAIL_SERVER_NAME : GMAIL_MAIL_SERVER_NAME;
  const cfg = readConfig();
  if (!cfg.mcpServers || !(other in cfg.mcpServers)) return;
  delete cfg.mcpServers[other];
  writeConfig(cfg);
}

async function waitForMailRuntime(tab: Tab, bridge: (tab: Tab) => Promise<void>): Promise<void> {
  await bridge(tab);
  await tab.mcpBridgePromise;
  if (!tab.mcpRuntime) throw new Error("Mail MCP runtime is unavailable");
}

async function refreshOutlookMailAuth(
  tab: Tab,
  bridge: (tab: Tab) => Promise<void>,
): Promise<void> {
  const configured = outlookMailConfigured(tab);
  if (!configured) {
    emitMailAuth(tab, MailProvider.Outlook, { configured: false, phase: "unconfigured" });
    return;
  }
  try {
    emitMailAuth(tab, MailProvider.Outlook, { configured: true, phase: "checking" });
    await waitForMailRuntime(tab, bridge);
    const raw = await tab.mcpRuntime!.callServerTool(
      OUTLOOK_MAIL_SERVER_NAME,
      "verify-login",
      {},
      AbortSignal.timeout(15_000),
    );
    const status = parseOutlookLoginStatus(raw);
    emitMailAuth(tab, MailProvider.Outlook, {
      configured: true,
      phase: status.success ? "connected" : "disconnected",
      ...(status.account ? { account: status.account } : {}),
      message: status.message,
    });
  } catch (error) {
    emitMailAuth(tab, MailProvider.Outlook, {
      configured: true,
      phase: "error",
      message: messageOf(error),
    });
  }
}

/** Gmail auth is self-contained: credentials + tokens live in config, so status
 *  needs no MCP round-trip. `resolveGmailToken` refreshes an expiring token. */
async function refreshGmailMailAuth(tab: Tab): Promise<void> {
  const creds = readConfig().gmailOAuth;
  const hasClientId = Boolean(creds?.clientId);
  const hasClientSecret = Boolean(creds?.clientSecret);
  const base = { hasClientId, hasClientSecret, callbackUrl: GMAIL_OAUTH_REDIRECT_URI };
  if (!hasClientId || !hasClientSecret) {
    emitMailAuth(tab, MailProvider.Gmail, {
      configured: false,
      phase: "unconfigured",
      ...base,
      message: "Add a Google OAuth client ID and secret to connect Gmail.",
    });
    return;
  }
  if (!creds?.accessToken) {
    emitMailAuth(tab, MailProvider.Gmail, {
      configured: true,
      phase: "disconnected",
      ...base,
      message: "Google OAuth credentials saved. Connect to sign in.",
    });
    return;
  }
  emitMailAuth(tab, MailProvider.Gmail, { configured: true, phase: "checking", ...base });
  try {
    await resolveGmailToken();
    emitMailAuth(tab, MailProvider.Gmail, {
      configured: true,
      phase: "connected",
      ...base,
      ...(creds.account ? { account: creds.account } : {}),
      message: "Signed in to Gmail.",
    });
  } catch (error) {
    emitMailAuth(tab, MailProvider.Gmail, {
      configured: true,
      phase: "error",
      ...base,
      message: messageOf(error),
    });
  }
}

async function connectOutlookMail(tab: Tab, bridge: (tab: Tab) => Promise<void>): Promise<void> {
  const provider = MailProvider.Outlook;
  const { controller, isStale, finish } = beginMailAuthFlow(tab, provider);
  try {
    configureOutlookMailServer();
    emitMcpSpecs(tab);
    emitMailAuth(tab, provider, { configured: true, phase: "starting" });
    await waitForMailRuntime(tab, bridge);
    if (isStale()) return;
    const raw = await tab.mcpRuntime!.callServerTool(
      OUTLOOK_MAIL_SERVER_NAME,
      "login",
      { force: true },
      AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    );
    if (isStale()) return;
    const immediate = parseOutlookLoginStatus(raw);
    if (immediate.success) {
      emitMailAuth(tab, provider, {
        configured: true,
        phase: "connected",
        ...(immediate.account ? { account: immediate.account } : {}),
        message: immediate.message,
      });
      return;
    }
    const deviceCode = parseOutlookDeviceCode(raw);
    if (!deviceCode) throw new Error(immediate.message);
    emitMailAuth(tab, provider, {
      configured: true,
      phase: "device-code",
      verificationUrl: deviceCode.verificationUrl,
      ...(deviceCode.userCode ? { userCode: deviceCode.userCode } : {}),
      message: deviceCode.message,
    });
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline && !isStale()) {
      await sleep(2_000);
      if (isStale()) return;
      const verifiedRaw = await tab.mcpRuntime!.callServerTool(
        OUTLOOK_MAIL_SERVER_NAME,
        "verify-login",
        {},
        AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      );
      const verified = parseOutlookLoginStatus(verifiedRaw);
      if (verified.success) {
        emitMailAuth(tab, provider, {
          configured: true,
          phase: "connected",
          ...(verified.account ? { account: verified.account } : {}),
          message: verified.message,
        });
        return;
      }
    }
    if (!isStale()) {
      emitMailAuth(tab, provider, {
        configured: true,
        phase: "error",
        message: "Microsoft sign-in timed out. Start the connection again for a new code.",
      });
    }
  } catch (error) {
    if (isStale()) return;
    emitMailAuth(tab, provider, {
      configured: outlookMailConfigured(tab),
      phase: "error",
      message: messageOf(error),
    });
  } finally {
    finish();
  }
}

async function connectGmailMail(tab: Tab, bridge: (tab: Tab) => Promise<void>): Promise<void> {
  const provider = MailProvider.Gmail;
  const { controller, isStale, finish } = beginMailAuthFlow(tab, provider);
  const gmailBase = {
    hasClientId: true,
    hasClientSecret: true,
    callbackUrl: GMAIL_OAUTH_REDIRECT_URI,
  };
  try {
    const configured = readConfig().gmailOAuth;
    if (!configured?.clientId || !configured.clientSecret) {
      throw new Error("Save a Gmail OAuth client ID and client secret before connecting");
    }
    configureGmailMailServer();
    emitMcpSpecs(tab);
    emitMailAuth(tab, provider, { configured: true, phase: "starting", ...gmailBase });
    await waitForMailRuntime(tab, bridge);
    if (isStale()) return;
    const oauthFlow = await beginGmailOAuthFlow();
    emitMailAuth(tab, provider, {
      configured: true,
      phase: "browser",
      verificationUrl: oauthFlow.url,
      ...gmailBase,
      message: "Complete Google sign-in in your browser.",
    });
    const onAbort = () => oauthFlow.cancel();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const finalCreds = await oauthFlow.done;
    controller.signal.removeEventListener("abort", onAbort);
    if (isStale()) return;
    saveGmailOAuth(finalCreds);
    emitMailAuth(tab, provider, {
      configured: true,
      phase: "connected",
      ...gmailBase,
      ...(finalCreds.account ? { account: finalCreds.account } : {}),
      message: "Signed in to Gmail.",
    });
  } catch (error) {
    if (isStale()) return;
    const creds = readConfig().gmailOAuth;
    emitMailAuth(tab, provider, {
      configured: Boolean(creds?.clientId && creds?.clientSecret),
      phase: "error",
      hasClientId: Boolean(creds?.clientId),
      hasClientSecret: Boolean(creds?.clientSecret),
      callbackUrl: GMAIL_OAUTH_REDIRECT_URI,
      message: messageOf(error),
    });
  } finally {
    finish();
  }
}

async function signOutOutlookMail(tab: Tab, bridge: (tab: Tab) => Promise<void>): Promise<void> {
  cancelMailAuth(tab, MailProvider.Outlook);
  try {
    await waitForMailRuntime(tab, bridge);
    await tab.mcpRuntime!.callServerTool(
      OUTLOOK_MAIL_SERVER_NAME,
      "logout",
      {},
      AbortSignal.timeout(30_000),
    );
    emitMailAuth(tab, MailProvider.Outlook, {
      configured: true,
      phase: "disconnected",
      message: "Signed out of Microsoft.",
    });
  } catch (error) {
    emitMailAuth(tab, MailProvider.Outlook, {
      configured: outlookMailConfigured(tab),
      phase: "error",
      message: messageOf(error),
    });
  }
}

/** Gmail sign-out drops tokens but keeps the OAuth client credentials for re-connect. */
function signOutGmailMail(tab: Tab): void {
  cancelMailAuth(tab, MailProvider.Gmail);
  try {
    signOutGmail();
    emitMailAuth(tab, MailProvider.Gmail, {
      configured: true,
      phase: "disconnected",
      hasClientId: true,
      hasClientSecret: true,
      callbackUrl: GMAIL_OAUTH_REDIRECT_URI,
      message: "Signed out of Google.",
    });
  } catch (error) {
    emitMailAuth(tab, MailProvider.Gmail, {
      configured: true,
      phase: "error",
      message: messageOf(error),
    });
  }
}

/** Route a provider-neutral auth action to the matching provider implementation. */
async function refreshMailAuth(
  tab: Tab,
  provider: MailProvider,
  bridge: (tab: Tab) => Promise<void>,
): Promise<void> {
  if (provider === MailProvider.Gmail) return refreshGmailMailAuth(tab);
  return refreshOutlookMailAuth(tab, bridge);
}

async function connectMail(
  tab: Tab,
  provider: MailProvider,
  bridge: (tab: Tab) => Promise<void>,
): Promise<void> {
  if (provider === MailProvider.Gmail) return connectGmailMail(tab, bridge);
  return connectOutlookMail(tab, bridge);
}

async function signOutMail(
  tab: Tab,
  provider: MailProvider,
  bridge: (tab: Tab) => Promise<void>,
): Promise<void> {
  if (provider === MailProvider.Gmail) return signOutGmailMail(tab);
  return signOutOutlookMail(tab, bridge);
}

const playwrightBrowserInstalls = new Map<string, AbortController>();

async function installPlaywrightBrowser(
  tab: Tab,
  browser: unknown,
  onInstalled: () => void,
): Promise<void> {
  if (!isPlaywrightManagedBrowser(browser)) {
    emit(
      { type: "$error", message: "playwright_browser_install: unsupported managed browser" },
      tab.id,
    );
    return;
  }
  if (playwrightBrowserInstalls.has(browser)) {
    emit(
      {
        type: "$playwright_browser_install",
        install: { phase: "done", browser, ok: false, reason: "installation already running" },
      } satisfies PlaywrightBrowserInstallEvent,
      tab.id,
    );
    return;
  }
  const installController = new AbortController();
  playwrightBrowserInstalls.set(browser, installController);
  tab.mcpStatuses.delete("playwright");
  for (const key of [...tab.mcpStatuses.keys()]) {
    if (key.startsWith("playwright=")) tab.mcpStatuses.delete(key);
  }
  emitMcpSpecs(tab);
  const configuredArgs = readConfig().mcpServers?.playwright?.args ?? [];
  const configuredPackage = configuredArgs.find((arg) => /^@playwright\/mcp(?:@|$)/.test(arg));
  const packageId = /^@playwright\/mcp(?:@[A-Za-z0-9._-]+)?$/.test(configuredPackage ?? "")
    ? configuredPackage
    : undefined;
  await ensureNpxAvailable().catch(() => undefined);
  const args = playwrightBrowserInstallArgs(browser, packageId);
  const configuredEnv = readConfig().mcpServers?.playwright?.env;
  const baseEnv = { ...process.env, ...(configuredEnv ?? {}) };
  try {
    const installResult = await installFromPlaywrightDownloadSources(
      browser,
      async ({ source, host }) => {
        emit(
          { type: "$playwright_browser_install", install: { phase: "running", browser, source } },
          tab.id,
        );
        const env = playwrightBrowserInstallEnv(baseEnv, host);
        let output = "";
        let previousProgress: { downloadedBytes: number; at: number } | undefined;
        let markDownloadComplete = () => {};
        const progressParser = createPlaywrightProgressParser((progress) => {
          if (progress.percent === 100) markDownloadComplete();
          const at = Date.now();
          const elapsedMs = previousProgress ? at - previousProgress.at : 0;
          const bytesPerSecond =
            previousProgress &&
            elapsedMs > 0 &&
            progress.downloadedBytes >= previousProgress.downloadedBytes
              ? Math.round(
                  ((progress.downloadedBytes - previousProgress.downloadedBytes) * 1000) /
                    elapsedMs,
                )
              : undefined;
          previousProgress = { downloadedBytes: progress.downloadedBytes, at };
          emit(
            {
              type: "$playwright_browser_install",
              install: { phase: "running", browser, source, ...progress, bytesPerSecond },
            } satisfies PlaywrightBrowserInstallEvent,
            tab.id,
          );
        });
        const result = await new Promise<{
          code: number | null;
          error?: string;
          cancelled?: boolean;
        }>((resolveResult) => {
          // Windows wraps `npx` as `npx.cmd`, which Node 22+ refuses to spawn
          // without a shell (throws EINVAL). Mirror the stdio transport: on
          // win32 build one quoted command line and run it through the shell;
          // elsewhere spawn the bare binary. Args are already allowlisted
          // (browser) and shape-checked (package pin), so no injection surface.
          const shell = process.platform === "win32";
          const child = shell
            ? spawn(["npx", ...args.map((arg) => quoteArg(arg, true))].join(" "), [], {
                windowsHide: true,
                shell: true,
                env,
              })
            : spawn("npx", args, { windowsHide: true, env });
          const append = (chunk: Buffer | string) => {
            output = `${output}${String(chunk)}`.slice(-8000);
            progressParser.push(chunk);
          };
          child.stdout?.on("data", append);
          child.stderr?.on("data", append);
          const supervisor = supervisePlaywrightInstaller(child, {
            signal: installController.signal,
          });
          markDownloadComplete = supervisor.markDownloadComplete;
          void supervisor.result.then((result) => {
            progressParser.flush();
            resolveResult(result);
          });
        });
        if (result.cancelled) throw new Error("installation cancelled");
        if (result.code === 0) return null;
        return (
          (result.error ?? output.trim().slice(-1000)) ||
          `installer exited with code ${result.code}`
        );
      },
    );
    const failureReason = installResult.failures.join("\n\n");
    emit(
      {
        type: "$playwright_browser_install",
        install: {
          phase: "done",
          browser,
          ok: installResult.ok,
          reason: installResult.ok
            ? null
            : isPlaywrightDownloadableBrowser(browser)
              ? failureReason
              : `${failureReason}\n\n${browser} is installed by its vendor and needs Administrator rights, so Reasonix+ cannot install it. Choose a Playwright-managed browser instead.`,
        },
      },
      tab.id,
    );
    if (installResult.ok) onInstalled();
  } catch (error) {
    emit(
      {
        type: "$playwright_browser_install",
        install: { phase: "done", browser, ok: false, reason: messageOf(error) },
      },
      tab.id,
    );
  } finally {
    installController.abort();
    playwrightBrowserInstalls.delete(browser);
  }
}

/** Classify a live relay probe's raw dispatch result. MCP bridge errors come back
 *  as JSON `{ error }` strings; tool-side failures surface as "### Error" text;
 *  anything else is a successful browser attach. Exported pure for tests. */
export function interpretExtensionCheck(
  raw: string | null,
  elapsedMs: number,
): { ok: boolean; reason: string | null; elapsedMs: number } {
  if (raw === null || raw.trim() === "") {
    return { ok: false, reason: "probe returned no result", elapsedMs };
  }
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  const timedOut = /timed?\s*out|aborted|cancelled/i.test(raw);
  let errorText: string | null = null;
  const trimmed = raw.trim();
  if (/^### Error|^Error:/i.test(trimmed)) {
    // Playwright prefixes tool-side failures with a bare "### Error" header and puts
    // the real reason on the next line(s). Surface that, not the useless header.
    const body = trimmed
      .replace(/^### Error[ \t]*\n?/i, "")
      .replace(/^Error:[ \t]*/i, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    errorText = (body || "probe failed").slice(0, 200);
  } else {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; cancelledByUser?: unknown };
      if (parsed && typeof parsed === "object" && (parsed.error || parsed.cancelledByUser)) {
        errorText = String(parsed.error ?? "cancelled");
      }
    } catch {
      // Not JSON — the tabs listing is plain text; fall through as success.
      errorText = null;
    }
  }
  if (errorText === null) return { ok: true, reason: null, elapsedMs };
  if (timedOut || /aborted|cancelled/i.test(errorText)) {
    return {
      ok: false,
      reason: `no browser responded within ${seconds}s — the stored token is likely wrong, or Chrome or Edge isn't running with the extension installed`,
      elapsedMs,
    };
  }
  if (/unknown tool/i.test(errorText)) {
    return {
      ok: false,
      reason: "playwright tools are not bridged — the server is not connected in this session",
      elapsedMs,
    };
  }
  return { ok: false, reason: errorText, elapsedMs };
}

/** End-to-end relay check: dispatch one cheap browser tool through the live
 *  bridge with a bounded timeout. Success proves the stored token actually works
 *  (the browser validates it, not us); a timeout means a wrong token or no supported browser. */
async function runMcpExtensionCheck(tab: Tab): Promise<void> {
  emit({ type: "$mcp_extension_check", check: { phase: "running" } }, tab.id);
  const t0 = Date.now();
  try {
    const tools = tab.toolset?.tools;
    if (!tools) throw new Error("toolset gone");
    const tabsTool = tools.specs().find((s) => s.function.name.endsWith("browser_tabs"));
    if (!tabsTool) {
      emit(
        {
          type: "$mcp_extension_check",
          check: {
            phase: "done",
            ok: false,
            reason:
              "playwright server is not bridged — no browser_tabs tool registered (starts with a session, or the server/tools are disabled)",
            elapsedMs: Date.now() - t0,
          },
        },
        tab.id,
      );
      return;
    }
    const raw = await tools.dispatch(
      tabsTool.function.name,
      { action: "list" },
      { signal: AbortSignal.timeout(25000) },
    );
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    emit(
      {
        type: "$mcp_extension_check",
        check: { phase: "done", ...interpretExtensionCheck(text, Date.now() - t0) },
      },
      tab.id,
    );
  } catch (err) {
    emit(
      {
        type: "$mcp_extension_check",
        check: {
          phase: "done",
          ok: false,
          reason: interpretExtensionCheck(`Error: ${(err as Error).message}`, Date.now() - t0)
            .reason,
          elapsedMs: Date.now() - t0,
        },
      },
      tab.id,
    );
  }
}

function emitMemory(tab: Tab): void {
  try {
    const entries = collectMemoryEntriesForWorkspace(tab.rootDir);
    emit({ type: "$memory", entries }, tab.id);
    emitTabDiagnostic(tab, "memory.list.completed", { count: entries.length });
  } catch (err) {
    emitDiagnosticError("memory.list.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    emit({ type: "$error", message: `memory_get failed: ${(err as Error).message}` }, tab.id);
  }
}

function countTokensForMeter(text: string): number {
  try {
    return countTokensBounded(text);
  } catch {
    return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length * 0.3));
  }
}

/** Reserved (system + tool specs) tokens per loop prefix. Keyed by prefix
 *  identity so emitCtxBreakdown stays O(1); length guards cover in-place
 *  addTool/removeTool (MCP hot-bridge). */
const reservedTokenCache = new WeakMap<
  object,
  { sys: number; sysLen: number; tools: number; toolsLen: number }
>();

// Shell-output filtering totals for the $ctx_breakdown payload — scoped to the
// tab's CURRENT session, not the all-time aggregate: the telemetry JSONL is
// shared across every session the backend has ever run, so an unscoped summary
// barely moves when a new session appends a few commands (the statusbar chip
// looked frozen at one percentage forever). emitCtxBreakdown fires after every
// tool event, so re-reading the telemetry JSONL each time would scale with
// session history — instead stat the file and re-summarize only when its
// mtime+size changed (one stat call in steady state). Caches are keyed by the
// session anchor because concurrent tabs sit in different sessions. A missing
// or unreadable file — or a session with no commands yet — legitimately means
// "no data": the fields are omitted and the UI shows no chip, rather than a
// fake zero.
const shellOutputSummaryCaches = new Map<
  number,
  { mtimeMs: number; size: number; rawTokens: number; shownTokens: number }
>();
// One entry per session that produced metrics; cap it so a long-lived backend
// hopping between many sessions can't accumulate entries forever.
const SHELL_OUTPUT_CACHE_CAP = 32;

function shellOutputFilteringTotals(sinceMs: number): {
  rawTokens: number;
  shownTokens: number;
} | null {
  const path = commandOutputTelemetryPath();
  let stat: { mtimeMs: number; size: number } | null = null;
  try {
    const s = statSync(path);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
  const cached = shellOutputSummaryCaches.get(sinceMs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { rawTokens: cached.rawTokens, shownTokens: cached.shownTokens };
  }
  try {
    const summary = summarizeCommandOutputMetrics(path, { since: sinceMs });
    if (summary.rawTokens <= 0) return null;
    if (shellOutputSummaryCaches.size >= SHELL_OUTPUT_CACHE_CAP) {
      shellOutputSummaryCaches.clear();
    }
    shellOutputSummaryCaches.set(sinceMs, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      rawTokens: summary.rawTokens,
      shownTokens: summary.shownTokens,
    });
    return { rawTokens: summary.rawTokens, shownTokens: summary.shownTokens };
  } catch {
    return null;
  }
}

// reserved = system prompt + tool specs, constant for the tab's lifetime once
// the loop is built. logTokens is refreshed during turns so Desktop doesn't
// show a fake zero while the streaming call is still waiting on usage metadata.
function emitCtxBreakdown(tab: Tab): void {
  // Re-anchor the per-session shell-output totals whenever the tab rebinds a
  // session (mint / switch / load / workspace change). Comparing against the
  // stored session name covers every `currentSession` assignment site without
  // duplicating reset logic in each, and runs before the runtime guard so a
  // rebind is never skipped: metrics appended before the anchor instant belong
  // to earlier sessions and must stay out of this session's totals.
  if (tab.currentSession !== tab.shellMetricsSession) {
    tab.shellMetricsSession = tab.currentSession;
    tab.shellMetricsSince = Date.now();
  }
  if (!tab.runtime) return;
  const prefix = tab.runtime.loop.prefix;
  const toolSpecs = prefix.toolSpecs;
  let cached = reservedTokenCache.get(prefix);
  if (!cached || cached.sysLen !== prefix.system.length || cached.toolsLen !== toolSpecs.length) {
    cached = {
      sys: countTokensForMeter(prefix.system),
      sysLen: prefix.system.length,
      tools: countTokensForMeter(JSON.stringify(toolSpecs)),
      toolsLen: toolSpecs.length,
    };
    reservedTokenCache.set(prefix, cached);
  }
  const sys = cached.sys;
  const tools = cached.tools;
  let logTokens = 0;
  try {
    logTokens = tab.runtime.loop.getCurrentLogTokens();
  } catch {
    for (const msg of tab.runtime.loop.log.toMessages()) {
      logTokens += countTokensForMeter(typeof msg.content === "string" ? msg.content : "");
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        logTokens += countTokensForMeter(JSON.stringify(msg.tool_calls));
      }
    }
  }
  // ctxMax drives the panel meter's denominator — keep it in sync with the
  // loop's context cap (resolveContextTokens + the verdict-aware override, so
  // Ollama tabs show the same cap the loop enforces).
  const ctxMax = resolveContextTokens(tab.currentModel, tabCtxMaxOverride(tab));
  emitTabDiagnostic(tab, "context.breakdown", {
    reservedTokens: sys + tools,
    logTokens,
    ctxMax,
  });
  const shellTotals = shellOutputFilteringTotals(tab.shellMetricsSince);
  emit(
    {
      type: "$ctx_breakdown",
      reservedTokens: sys + tools,
      logTokens,
      ctxMax,
      ...(shellTotals
        ? {
            shellOutputRawTokens: shellTotals.rawTokens,
            shellOutputShownTokens: shellTotals.shownTokens,
          }
        : {}),
    },
    tab.id,
  );
}

/** Ground-truth "a turn is in flight or parked" for one tab — the one busy
 *  source the $tab_status reply reports, so the desktop can reconcile against a
 *  single definition. */
export function tabBusy(tab: Pick<Tab, "aborter" | "activeTurn">): boolean {
  return tab.aborter !== null || tab.activeTurn !== undefined;
}

/** Live turn-state snapshot for one tab — the $tab_status reply the desktop
 *  polls to detect drift between its optimistic busy flag and reality. */
export function tabStatus(tab: Tab): TabStatusEvent {
  return {
    type: "$tab_status",
    busy: tabBusy(tab),
    ...(tab.runtime ? { turn: tab.runtime.loop.currentTurn } : {}),
    // The daemon holds no send queue — the desktop drains its own.
    queued: 0,
    compacting: tab.compactingManual,
    switching: tab.switching,
  };
}

/** Manual compaction for the desktop "Compact now" button: runs the loop's
 *  compaction and converts its loop events to kernel events for chat.
 *  Exported for tests. */
export async function compactTabContext(tab: Tab): Promise<KernelEvent[]> {
  const runtime = tab.runtime;
  if (!runtime) return [];
  const outcome = await runtime.loop.compactNow({ trigger: "manual" });
  const events: KernelEvent[] = [];
  for (const ev of outcome.events) {
    for (const kev of runtime.eventizer.consume(ev, runtime.ctx)) events.push(kev);
  }
  // The retraction payload must be the log as of emission: a live turn can
  // append between the fold and here, and a stale snapshot would wipe those
  // messages from the conversation view.
  const live = [...runtime.loop.log.entries];
  for (let i = 0; i < events.length; i++) {
    const kev = events[i]!;
    if (kev.type === "session.retracted" && kev.kind === "compact") {
      events[i] = { ...kev, replacementMessages: live };
    }
  }
  return events;
}

/** Chat card for a manual compaction: the header plus the rolled-up summary
 *  that replaced the folded context, or a "nothing to compact" note when the
 *  log was already below the budget. Exported for tests. */
export function manualCompactNotice(events: KernelEvent[]): {
  text: string;
  severity: "info" | "success";
} {
  const compacted = events.find(
    (e): e is Extract<KernelEvent, { type: "warning" }> => e.type === "warning",
  );
  if (!compacted) return { text: t("loop.compactNothing"), severity: "info" };
  return {
    text: compactionCardText(compacted.text, compacted.compactionSummary),
    severity: "success",
  };
}

export async function runManualCompact(
  tab: Tab,
  emitFn: (ev: EmittableEvent, tabId?: string) => void = emit,
  stopWork?: () => Promise<void>,
): Promise<void> {
  if (tab.compactingManual) return;
  const runtime = tab.runtime;
  if (!runtime) {
    emitFn({ type: "$error", message: "No active agent to compact context for." }, tab.id);
    return;
  }
  tab.compactingManual = true;
  let release!: () => void;
  tab.manualCompactDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Announce the fold before the running turn has even unwound: the UI treats a
  // compacting daemon as busy, so a message typed during the teardown queues
  // instead of being dispatched straight into the fold.
  emitFn(tabStatus(tab), tab.id);
  try {
    if (tab.aborter || tab.activeTurn) {
      tab.aborter?.abort();
      runtime.loop.abort();
    }
    await stopWork?.();
    await tab.activeTurn;
    // Cancellation acknowledgement precedes generator cleanup; wait for both.
    await tab.turnCleanup;

    const started = projectKernelEvent(
      runtime.eventizer.emitCompactionStarted(runtime.loop.currentTurn, "manual"),
    );
    if (started) emitFn(started, tab.id);
    const events = await compactTabContext(tab);
    const notice = manualCompactNotice(events);
    for (const kev of events) {
      // The compaction warning becomes the result card's text below instead.
      if (kev.type === "warning") continue;
      const wire = projectKernelEvent(kev);
      if (wire) emitFn(wire, tab.id);
    }
    emitFn({ type: "$notice", text: notice.text, severity: notice.severity }, tab.id);
    emitCtxBreakdown(tab);
  } catch (err) {
    emitFn({ type: "$error", message: `compact failed: ${(err as Error).message}` }, tab.id);
  } finally {
    tab.compactingManual = false;
    tab.manualCompactDone = undefined;
    release();
    // Fold over — clear the UI's busy so the queued sends drain as normal turns.
    emitFn(tabStatus(tab), tab.id);
  }
}

function emitSkills(tab: Tab): void {
  try {
    const store = new SkillStore({
      projectRoot: tab.rootDir,
      customSkillPaths: loadResolvedSkillPaths(tab.rootDir),
    });
    const items = store.list().map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope,
      path: s.path,
    }));
    emit({ type: "$skills", items }, tab.id);
    emitTabDiagnostic(tab, "skills.list.completed", { count: items.length });
  } catch (err) {
    emitDiagnosticError("skills.list.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    emit({ type: "$error", message: `skills_get failed: ${(err as Error).message}` }, tab.id);
  }
}

interface RuntimeState {
  loop: CacheFirstLoop;
  eventizer: Eventizer;
  ctx: {
    model: string;
    prefixHash: string;
    reasoningEffort: import("../../config.js").ReasoningEffort;
  };
}

/** The one rule for "this failure is the model's, not the user's and not the
 *  conversation's": both the loop's error event and a throwing generator feed it,
 *  so the two paths can never disagree about whether a backup may take over. */
function isModelFailure(
  err: { name?: string; message?: string } | undefined,
  aborted: boolean,
): boolean {
  if (aborted) return false;
  if (err?.name === "AbortError") return false;
  return !isContextOverflowError(err?.message);
}

/** Whether a finished attempt hands the turn to a backup model. Any terminal model
 *  failure qualifies; an answer, a user abort and a context overflow do not. */
export function shouldFailover(attempt: {
  aborted: boolean;
  producedAnswer: boolean;
  modelFailure: boolean;
}): boolean {
  return attempt.modelFailure && !attempt.aborted && !attempt.producedAnswer;
}

/** One turn-generator drive's outcome: what settlement reports, plus the
 *  model-failure signal the backup-model failover acts on. */
interface TurnAttempt {
  aborted: boolean;
  lastTurn: number;
  sawAssistantFinal: boolean;
  producedAnswer: boolean;
  sawError: boolean;
  lastStopReason: string;
  /** The attempt ended on a model failure another model may survive (rate limit,
   *  spent quota, provider outage, unreachable endpoint). A context overflow is
   *  excluded: it is a property of the conversation, and the loop already folded. */
  modelFailure: boolean;
}

type SymbolEntry = { name: string; path: string; line: number; kind: string };

interface Tab {
  readonly id: string;
  /** Workspace-tab identity. Each Tab object is one independently running
   *  session channel; every channel in the same visual workspace tab shares
   *  this group id. */
  groupId: string;
  rootDir: string;
  /** True until the user assigns a workspace. A pending tab has no rootDir,
   *  session or toolset — it exists only so the UI can prompt for a workspace
   *  without merging into an existing workspace tab. */
  pending: boolean;
  currentSession: string;
  /** Session name the shell-output totals are anchored to; null until the first
   *  emitCtxBreakdown binds it. See the re-anchor block there. */
  shellMetricsSession: string | null;
  /** Epoch ms captured when the current session was bound — summarizeCommandOutputMetrics
   *  counts only telemetry appended after this instant, keeping the statusbar
   *  chip per-session instead of an all-time aggregate. */
  shellMetricsSince: number;
  currentModel: string;
  /** Per-tab subagent model override, set only when the user picks one in the
   *  chat menu. `undefined` = subagents implicitly follow the main agent's
   *  model. Persisted in session meta like the main model. */
  currentSubagentModel?: string;
  /** Whether the session this tab is bound to was minted with `spawn_subagent`.
   *  Frozen per session: changing it rewrites the tool spec and a prompt section,
   *  so only a session boundary (mint, restore, switch) may move it. */
  subagents: boolean;
  /** Per-tab reasoning effort — restored from the session's meta on load so a config reset doesn't flip it back to the global default. */
  currentReasoningEffort: import("../../config.js").ReasoningEffort;
  /** User-configured context-window cap (tokens); undefined = per-model default (300K). */
  ctxMaxOverride: number | undefined;
  /** null while the tab is bootstrapping — see `initTabToolset`. UI gates input on `$ready`, which only fires once this is set. */
  toolset: Awaited<ReturnType<typeof buildCodeToolset>> | null;
  /** Empty while bootstrapping; populated together with `toolset`. */
  system: string;
  initialization: Promise<void> | null;
  initializationRevision: number;
  runtime: RuntimeState | null;
  aborter: AbortController | null;
  /** True while a manual compaction runs — repeat clicks no-op instead of
   *  racing a second fold. */
  compactingManual: boolean;
  manualCompactDone?: Promise<void>;
  activeTurn?: Promise<void>;
  turnCleanup?: Promise<void>;
  fileIndex: FileWithStats[] | null;
  fileIndexBuilding: Promise<FileWithStats[]> | null;
  fileIndexBuiltAt: number;
  symbolIndex: SymbolEntry[] | null;
  symbolBuilding: Promise<SymbolEntry[]> | null;
  recentMentions: string[];
  /** Pause-gate ids waiting on this tab — abort uses these to free stranded plan_checkpoint / plan_revision / shell-confirm callers. */
  pendingGateIds: Set<number>;
  mcpRuntime: McpRuntime | null;
  mcpStatuses: Map<string, { kind: McpSpecStatus; reason?: string; toolCount?: number }>;
  mcpBridgePromise: Promise<void> | null;
  /** Fresh chat: true until the user confirms this chat's capabilities — its enabled MCP
   *  servers and its subagent flag. Withholds `$ready` (composer disabled) and defers the
   *  runtime + bridge until `mcp_session_configure`. */
  mcpSetupPending: boolean;
  /** True while a session switch is in progress — prevents stale events from the old turn. */
  switching: boolean;
  /** Plan progress for the diagnostics projection. Refreshed wherever plan state is
   *  consulted or changed; `tabDiagnosticState` must never read the store itself. */
  planSummary: { completed: number; total: number };
  hooks: ResolvedHook[];
}

function tabDiagnosticState(tab: Tab): Record<string, unknown> {
  let credentialAvailable: boolean | null = null;
  try {
    credentialAvailable = tabHasCredential(tab);
  } catch {
    credentialAvailable = null;
  }
  const mcpStatusCounts: Record<string, number> = {};
  for (const status of tab.mcpStatuses.values()) {
    mcpStatusCounts[status.kind] = (mcpStatusCounts[status.kind] ?? 0) + 1;
  }
  const stats = tab.runtime?.loop.stats.summary() ?? null;
  let logEntries: number | null = null;
  if (tab.runtime) {
    try {
      logEntries = tab.runtime.loop.log.length;
    } catch {
      logEntries = null;
    }
  }
  return {
    tabId: tab.id,
    workspaceDirChars: tab.rootDir.length,
    session: tab.currentSession || null,
    model: tab.currentModel,
    provider: providerForModel(tab.currentModel),
    reasoningEffort: tab.currentReasoningEffort,
    credentialAvailable,
    toolsetReady: tab.toolset !== null,
    runtimeReady: tab.runtime !== null,
    busy: tab.aborter !== null,
    switching: tab.switching,
    pendingGateCount: tab.pendingGateIds.size,
    plan: { totalSteps: tab.planSummary.total, completedSteps: tab.planSummary.completed },
    mcp: { configured: mcpStatusCounts, runtimeReady: tab.mcpRuntime !== null },
    indexes: {
      fileReady: tab.fileIndex !== null,
      fileBuilding: tab.fileIndexBuilding !== null,
      symbolReady: tab.symbolIndex !== null,
      symbolBuilding: tab.symbolBuilding !== null,
    },
    hooks: tab.hooks.length,
    logEntries,
    turn: tab.runtime?.loop.currentTurn ?? null,
    stats,
  };
}

function emitTabDiagnostic(
  tab: Tab,
  event: string,
  details?: Record<string, unknown>,
  level: DesktopDiagnosticEvent["level"] = "debug",
): void {
  emitDiagnostic(
    event,
    { ...tabDiagnosticState(tab), ...details },
    {
      tabId: tab.id,
      level,
    },
  );
}

let tabCounter = 0;
function nextTabId(): string {
  tabCounter++;
  return `t${tabCounter}`;
}

let groupCounter = 0;
function nextGroupId(): string {
  groupCounter++;
  return `g${groupCounter}`;
}

/** Absolute, case-folded directory key: Windows paths are case-insensitive, so the
 *  same workspace can arrive with different casing. */
function workspaceKey(dir: string): string {
  const resolved = resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when two workspace dirs point at one directory. */
function sameWorkspaceDir(a: string, b: string): boolean {
  return workspaceKey(a) === workspaceKey(b);
}

/** One epoch per daemon lifetime. A per-tab epoch made a freshly opened channel
 *  look like a restarted daemon, which dropped the frontend's optimistic deletes. */
const DESKTOP_SESSIONS_EPOCH = randomUUID();

/** Revisions are per workspace: every channel serving one directory receives the
 *  same snapshots, so their revisions have to be comparable. */
const sessionsRevisions = new Map<string, number>();

/** Advances and returns the workspace's snapshot revision. `workspaceKey` is what
 *  makes two channels' snapshots on one directory comparable. */
function nextSessionsRevision(dir: string): number {
  const key = workspaceKey(dir);
  const next = (sessionsRevisions.get(key) ?? 0) + 1;
  sessionsRevisions.set(key, next);
  return next;
}

/** A workspace is usable only while it still exists as a directory — a deleted
 *  project must not become (or keep serving) a tab. */
function isExistingWorkspaceDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return statSync(dir).isDirectory();
  } catch (err) {
    // The path can vanish or lose permissions between the two calls.
    emitDiagnosticError("workspace.stat.failed", err, { details: { dirChars: dir.length } });
    return false;
  }
}

/** Collapse persisted session channels onto one visual group per canonical
 *  workspace. The first occurrence owns the group's identity and order; later
 *  channels keep their independent sessions but join that workspace tab. */
export function normalizeWorkspaceTabGroups<T extends { dir: string; groupId?: string }>(
  entries: readonly T[],
  mintGroupId: () => string = nextGroupId,
): T[] {
  const workspaces: Array<{ dir: string; groupId: string }> = [];
  const groupOwners = new Map<string, string>();

  return entries.map((entry) => {
    const existing = workspaces.find((workspace) => sameWorkspaceDir(workspace.dir, entry.dir));
    if (existing) return { ...entry, groupId: existing.groupId };

    let groupId = entry.groupId;
    const owner = groupId ? groupOwners.get(groupId) : undefined;
    if (!groupId || (owner !== undefined && !sameWorkspaceDir(owner, entry.dir))) {
      do {
        groupId = mintGroupId();
      } while (groupOwners.has(groupId));
    }
    workspaces.push({ dir: entry.dir, groupId });
    groupOwners.set(groupId, entry.dir);
    return { ...entry, groupId };
  });
}

/** Every independently running session owned by one visual workspace tab. */
export function channelsInWorkspaceTab<T extends { groupId: string }>(
  channels: readonly T[],
  selected: { groupId: string },
): T[] {
  return channels.filter((channel) => channel.groupId === selected.groupId);
}

/** The newest session to implicitly resume on a switch (newest-first list), or
 *  null when none. `skip` drops candidates another channel holds so one session
 *  can't bind to two channels. Pure so the rule is testable. */
export function pickResumeSession(
  sessions: readonly SessionInfo[],
  skip?: (session: SessionInfo) => boolean,
): SessionInfo | null {
  if (!skip) return sessions[0] ?? null;
  return sessions.find((s) => !skip(s)) ?? null;
}

/** The workspace a session belongs to: its own stamp, written once and never
 *  rewritten, or `fallback` for a session minted before stamps existed. */
function sessionWorkspaceOf(name: string, fallback: string): string {
  return stampedWorkspaceOf(name) ?? fallback;
}

/** The session's stamped workspace, or undefined when it predates stamps. */
function stampedWorkspaceOf(name: string): string | undefined {
  const stamped = loadSessionMeta(name).workspace;
  return typeof stamped === "string" && stamped.length > 0 ? stamped : undefined;
}

/** The channel serving `name` inside `dir`. A channel holding the same session
 *  from ANOTHER workspace is a stale binding, so focusing it would move the user
 *  to that tab. Pure so the rule is testable. */
export function channelServingSession<T extends { currentSession: string; rootDir: string }>(
  channels: readonly T[],
  name: string,
  dir: string,
  sameDir: (a: string, b: string) => boolean = sameWorkspaceDir,
): T | undefined {
  return channels.find(
    (channel) => channel.currentSession === name && sameDir(channel.rootDir, dir),
  );
}

/** A restored tab may only adopt a session its own workspace owns: adopting a
 *  foreign one re-persists the crossed binding on every boot. */
export function adoptableRestoredSession(
  requested: string | undefined,
  dir: string,
  deps: {
    exists: (name: string) => boolean;
    /** The session's stamped workspace, or undefined when it predates stamps. */
    workspaceOf: (name: string) => string | undefined;
  } = { exists: sessionExists, workspaceOf: stampedWorkspaceOf },
): string | undefined {
  if (!requested || !deps.exists(requested)) return undefined;
  const owner = deps.workspaceOf(requested);
  return owner === undefined || sameWorkspaceDir(owner, dir) ? requested : undefined;
}

function mintSessionFor(
  rootDir: string,
  prefs?: ModelPrefs,
  options: {
    mcp?: SessionMcpState;
    mcpSetup?: boolean;
    /** Session-creation flag, frozen into the meta: this chat either has the spawn
     *  tool or it does not, for its whole life. */
    subagents?: boolean;
  } = {},
): string {
  // Seconds precision repeats when `new_chat` fires twice within one second —
  // reuse the collision loop so the second mint takes `-1`, `-2`, … instead
  // of truncating a session that already exists.
  const name = firstFreeSessionName(`desktop-${timestampSuffix(14)}-${tabCounter}`, (candidate) =>
    sessionExists(candidate),
  );
  // EVERY mint is eager: the folder, its empty transcript and its meta land on
  // disk immediately. A name with no session behind it is exactly the state the
  // UI must never be in, so there is no lazy mint.
  try {
    ensureSessionDir(name);
    // Seed the session's MCP state from the Settings default so later default
    // edits don't retroactively change an existing conversation.
    patchSessionMeta(name, {
      workspace: rootDir,
      ...(prefs ?? {}),
      // A gated fresh chat defers its MCP snapshot until the user confirms the
      // server set (and is marked pending so a force-exit mid-picker is swept on
      // the next boot); every other mint freezes the set now.
      ...(options.mcpSetup
        ? { mcpPending: true }
        : { mcp: options.mcp ?? sessionMcpFromConfig(rootDir) }),
      subagents: options.subagents === true,
    });
  } catch (err) {
    // meta is for filtering only: failure shouldn't block chat, but LOG
    emitDiagnosticError("session.meta.patch.failed", err, {
      details: { session: name },
    });
    process.stderr.write(`reasonix: session mint failed: ${messageOf(err)}\n`);
  }
  return name;
}

/** The user changed the model/effort/subagent-model enums in the desktop UI —
 *  persist the new values into the open conversation's meta so a resume (even
 *  after a reinstall wiped the config) restores them. */
function persistSessionModelPrefs(tab: Tab): void {
  if (!tab.currentSession) return;
  try {
    patchSessionMeta(tab.currentSession, {
      model: tab.currentModel,
      reasoningEffort: tab.currentReasoningEffort,
      subagentModel: tab.currentSubagentModel,
    });
  } catch (err) {
    emitDiagnosticError("session.model-prefs.persist.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    /* meta is best-effort — failure shouldn't block the settings change, but LOG */
    process.stderr.write(`reasonix: session model prefs persist failed — ${messageOf(err)}\n`);
  }
}

/** Record the conversation's model/effort on its first turn — but never
 *  overwrite what's already stored: only an explicit UI change
 *  (settings_save) or a freshly minted session writes after that. */
function stampSessionModelPrefs(tab: Tab): void {
  if (!tab.currentSession) return;
  try {
    const meta = loadSessionMeta(tab.currentSession);
    if (meta.model !== undefined && meta.reasoningEffort !== undefined) return;
    patchSessionMeta(tab.currentSession, {
      model: meta.model ?? tab.currentModel,
      reasoningEffort: meta.reasoningEffort ?? tab.currentReasoningEffort,
      subagentModel: meta.subagentModel ?? tab.currentSubagentModel,
    });
  } catch (err) {
    emitDiagnosticError("session.model-prefs.stamp.failed", err, {
      tabId: tab.id,
      details: tabDiagnosticState(tab),
    });
    /* meta is best-effort — but LOG so the failure isn't silent */
    process.stderr.write(`reasonix: session model prefs stamp failed — ${messageOf(err)}\n`);
  }
}

/** Rebuild only the prompt from current tab state. Callers own runtime/prefix updates.
 *  `editMode` pins the trailing "Permissions (live)" block to a just-saved selection so
 *  the block cannot lag the user's flip behind a config re-read. */
export function refreshTabSystemPrompt(
  tab: Pick<Tab, "rootDir" | "currentModel" | "system" | "subagents"> & {
    currentSession?: string;
    /** Presence only: a tab whose toolset has not been built yet must not be rewritten. */
    toolset: object | null;
  },
  opts?: { editMode?: EditMode },
): void {
  if (!tab.toolset) return;
  tab.system = codeSystemPrompt(tab.rootDir, {
    modelId: tab.currentModel,
    editMode: opts?.editMode,
    // The session's frozen flag, never live config: a settings edit must not
    // rewrite the prefix of a conversation already in flight.
    subagentsEnabled: sessionSubagentsEnabled(tab),
  });
}

/** Knowledge-level refresh after an edit-gate flip: mirror the mode into the dispatch
 *  gate, rebuild the prompt's "Permissions (live)" block, and push the new system into
 *  the running loop's prefix so even a mid-turn request sees the new selection. */
export function refreshEditModeKnowledge(
  tab: Pick<Tab, "rootDir" | "currentModel" | "system"> & {
    toolset: { tools: CodeToolset["tools"] } | null;
    runtime: { loop: { prefix: { replaceSystem: (system: string) => boolean } } } | null;
    subagents: boolean;
  },
  editMode: EditMode,
): void {
  if (tab.toolset) applyPlanMode(tab.toolset.tools, editMode);
  refreshTabSystemPrompt(tab, { editMode });
  tab.runtime?.loop.prefix.replaceSystem(tab.system);
}

/** Rebind the tab's model/effort/subagent-model to the conversation's stored
 *  values — a reinstall can't flip an ongoing conversation's models. */
function restoreSessionModelPrefs(tab: Tab, meta: SessionMeta): void {
  const prefs = resolveSessionModelPrefs(meta, {
    model: tab.currentModel,
    reasoningEffort: tab.currentReasoningEffort,
    subagentModel: tab.currentSubagentModel,
  });
  if (prefs.model !== tab.currentModel) {
    tab.currentModel = prefs.model;
    // The system prompt embeds the model id — refresh it when the model
    // changes so tool guidance matches the restored model.
    refreshTabSystemPrompt(tab);
  }
  tab.currentReasoningEffort = prefs.reasoningEffort;
  tab.currentSubagentModel = prefs.subagentModel;
  bindSessionSubagents(tab, sessionSubagentsEnabled(meta));
}

/** Bind the tab's subagent capability to the session it now runs, so the registry and
 *  the prompt section can never disagree with the frozen meta value. Session boundary
 *  only: flipping the flag inside one conversation would rewrite the cached prefix. */
function bindSessionSubagents(tab: Tab, enabled: boolean): void {
  // Re-registering rebuilds the tool's closure (and its spawn counters), so a bind
  // that agrees with the tab's current value must not touch the registry.
  const changed = tab.subagents !== enabled;
  tab.subagents = enabled;
  if (!changed || !tab.toolset) return;
  tab.toolset.syncSubagentTools(enabled);
  refreshTabSystemPrompt(tab);
}

/** Provider-specific "not configured yet" message for a model id — keeps a
 *  gemini tab from being told to paste a DeepSeek key. The copy is the provider's
 *  own declaration; the fallback names whichever provider the model resolves to. */
function notConfiguredMessage(model: string): string {
  const provider = providerForModel(model);
  return (
    providerString(provider, "notConfigured") ??
    `Not configured yet — paste your ${providerSpec(provider)?.label ?? "provider"} API key first.`
  );
}

/** One pre-flight rejection of a turn start; `reason` is the terminal-card text,
 *  `outcome` the $turn_complete settlement. Pure over its inputs — env probes
 *  arrive as booleans so the table can be driven from tests. */
export type TurnStartRejection = {
  kind: "pending-tab" | "runtime-missing" | "credential-unavailable" | "images-need-vision";
  outcome: "aborted" | "stopped";
  reason?: string;
};

export function turnStartRejection(
  model: string,
  images: TurnImage[] | undefined,
  env: {
    pending: boolean;
    hasRootDir: boolean;
    runtimeReady: boolean;
    modelUsable: boolean;
  },
): TurnStartRejection | null {
  if (env.pending || !env.hasRootDir) return { kind: "pending-tab", outcome: "aborted" };
  if (!env.runtimeReady) {
    return { kind: "runtime-missing", outcome: "stopped", reason: notConfiguredMessage(model) };
  }
  if (!env.modelUsable) {
    const provider = providerForModel(model);
    // With no provider file there is no settings field to point at, so name the fix.
    if (!providerSpec(provider)) {
      return {
        kind: "credential-unavailable",
        outcome: "stopped",
        reason:
          "No model provider is declared — add a providers/<id>.json file in packages/core-utils/src/providers/ and run npm run providers:sync.",
      };
    }
    const reason =
      providerString(provider, "noCredential", { model }) ??
      `No API key configured — paste your ${providerSpec(provider)?.label ?? "provider"} API key first.`;
    return { kind: "credential-unavailable", outcome: "stopped", reason };
  }
  // Only vision-capable models accept image content parts — DeepSeek 400s
  // otherwise. The UI hides the affordance for non-vision models; this is
  // the hard gate so a stale or forged request can't reach the API.
  if (images && images.length > 0 && !modelAcceptsImages(model, ollamaVisionModelIds())) {
    return {
      kind: "images-need-vision",
      outcome: "stopped",
      reason:
        "Images require a vision-capable model (gpt-*, Gemini, or DeepSeek V4.1 Flash). Switch models to attach images.",
    };
  }
  return null;
}

/** Whether the tab's CURRENT model can be run now — see config's modelUsableFor,
 *  which the quota-failover paths also screen backups with. */
export function tabCurrentModelUsable(tab: Tab): boolean {
  return modelUsableFor(tab.currentModel);
}

/** Setup/readiness gate: usable if the current model's provider has a
 *  credential, OR if ANY alternative provider is configured. Keeps a
 *  ChatGPT/Ollama-only install from being soft-locked behind a DeepSeek key. */
export function tabHasCredential(tab: Tab): boolean {
  return tabCurrentModelUsable(tab) || anyProviderConfigured();
}

/** Re-emit the setup/ready gate for a tab after a credential or model change —
 *  `$ready` when the tab is now usable, `$needs_setup` when it regressed. */
function emitTabGate(tab: Tab): void {
  // An unanswered session-start picker owns the gate: `$ready` would close it and
  // leave the confirm unsent, so the chat could run without its frozen set.
  if (tab.mcpSetupPending) return;
  if (tabHasCredential(tab)) emit({ type: "$ready" }, tab.id);
  else emit({ type: "$needs_setup", reason: "no_api_key" }, tab.id);
}

/** Effective ctxMaxOverride for a tab: Ollama tabs use the server's learned /api/show
 *  window (verdict store) when fresh, else the user `contextTokens` setting — every ctxMax
 *  consumer (loop, meter, settings changes) must resolve the same value. */
function tabCtxMaxOverride(tab: Tab): number | undefined {
  // A provider that declares a model-id scheme reports its own window per model
  // (learned from the runtime probe); every other provider uses the user override.
  const spec = providerSpec(providerForModel(tab.currentModel));
  const scheme = spec?.routing.modelScheme ?? null;
  if (scheme === null) return tab.ctxMaxOverride;
  return (
    contextTokensForModel(
      loadOllamaVerdicts(ollamaVerdictsPath()),
      tab.currentModel.replace(`${scheme}/`, ""),
      Date.now(),
    ) ?? tab.ctxMaxOverride
  );
}

function buildRuntimeFor(tab: Tab): RuntimeState {
  if (!tab.toolset) throw new Error("buildRuntimeFor called before initTabToolset finished");
  const toolset = tab.toolset;
  applyPlanMode(toolset.tools, loadEditMode());
  const ep = loadEndpointForModel(tab.currentModel);
  const provider = providerForModel(tab.currentModel);
  const isOpenAI = isOpenAIStandardEndpoint(tab.currentModel);
  const log = createLogger("desktop");
  if (isOpenAI) {
    const keyStatus = ep.apiKey ? "static key present, " : "no static key, ";
    log.debug(
      `model ${tab.currentModel} → OpenAI; ${keyStatus}Codex backend transport enabled (plan quota)`,
    );
  } else if (provider === "ollama") {
    log.debug(
      `model ${tab.currentModel} → Ollama; endpoint ${ep.baseUrl ?? DEFAULT_OLLAMA_CHAT_URL}`,
    );
  } else if (provider === "gemini") {
    log.debug(
      `model ${tab.currentModel} → Gemini; endpoint ${ep.baseUrl ?? DEFAULT_GEMINI_CHAT_URL} (Antigravity quota)`,
    );
  } else if (provider === "zai") {
    log.debug(`model ${tab.currentModel} → Z.AI; endpoint ${ep.baseUrl ?? DEFAULT_ZAI_CHAT_URL}`);
  } else if (provider === "mimo") {
    log.debug(`model ${tab.currentModel} → MiMo; endpoint ${ep.baseUrl ?? DEFAULT_MIMO_CHAT_URL}`);
  } else if (provider === "opencode") {
    log.debug(
      `model ${tab.currentModel} → OpenCode; endpoint ${ep.baseUrl ?? DEFAULT_OPENCODE_CHAT_URL}`,
    );
  } else {
    log.debug(`model ${tab.currentModel} → DeepSeek; endpoint ${ep.baseUrl ?? "default"}`);
  }
  // Stable conversation identity for OpenCode's x-opencode-session routing
  // follows the tab's session name; subagents get independent generated ids.
  const client = createModelClient({
    model: tab.currentModel,
    sessionId: tab.currentSession ?? undefined,
  });
  const prefix = new ImmutablePrefix({ system: tab.system, toolSpecs: toolset.tools.specs() });
  const reasoningEffort = tab.currentReasoningEffort;
  // Ollama tabs calibrate the context window against the server's real value
  // when one has been learned from /api/show (verdict store); the user
  // `contextTokens` override (clamped ≥300K) is the fallback, then the default.
  const ctxMaxOverride = tabCtxMaxOverride(tab);
  const loop = new CacheFirstLoop({
    client,
    prefix,
    tools: toolset.tools,
    model: tab.currentModel,
    ctxMaxOverride,
    session: tab.currentSession,
    // Turn ordinals are session-wide identity: a model switch rebuilds the
    // runtime over a possibly-truncated log, and without this floor the new
    // loop's baseline can regress below turns the desktop already rendered.
    turnFloor: tab.runtime?.loop.currentTurn ?? 0,
    reasoningEffort,
    maxIterPerTurn: loadMaxIterPerTurn(),
    maxOutputTokens: loadMaxOutputTokens(),
    autoCompact: loadAutoCompact(),
    repetitionGuardEnabled: loadRepetitionGuardEnabled(),
    // Live thunk (not a snapshot) so a mid-session Shift+Tab mode flip
    // stops the iteration cap from pausing the turn in yolo.
    getEditMode: () => loadEditMode(),
    hooks: tab.hooks,
    hookCwd: tab.rootDir,
  });
  const eventizer = new Eventizer();
  const ctx = { model: tab.currentModel, prefixHash: prefix.fingerprint, reasoningEffort };
  return { loop, eventizer, ctx };
}

/** Switch a tab's model in place, rolling everything back if the rebuild throws; never
 *  aborts a turn. `persistDefault` writes the global default too, and `followSubagentPin`
 *  (failover only) moves the session's subagent pin with the chat. */
function applyTabModel(
  tab: Tab,
  next: string,
  opts: { persistDefault: boolean; followSubagentPin?: boolean },
): void {
  const prevModel = tab.currentModel;
  const prevSubagent = tab.currentSubagentModel;
  const prevSystem = tab.system;
  tab.currentModel = next;
  // Only a failover drags the subagent pin along, and only when that pin sits on the
  // provider being left: an unset pin already follows, and a healthier one must not be
  // rewritten. The rollback below restores it, so the two stay in step either way.
  if (opts.followSubagentPin && subagentPinFollowsFailover(prevSubagent, prevModel)) {
    tab.currentSubagentModel = next;
  }
  try {
    if (opts.persistDefault) saveModel(next);
    persistSessionModelPrefs(tab);
    if (tab.toolset) {
      refreshTabSystemPrompt(tab);
      // Build even when the tab had no runtime (e.g. a gated welcome tab that
      // just picked a model) — only if the new model is usable, else drop a
      // stale runtime.
      if (tabCurrentModelUsable(tab)) tab.runtime = buildRuntimeFor(tab);
      else tab.runtime = null;
    }
  } catch (err) {
    tab.currentModel = prevModel;
    tab.currentSubagentModel = prevSubagent;
    if (opts.persistDefault) {
      try {
        saveModel(prevModel);
      } catch (saveErr) {
        process.stderr.write(
          `reasonix: model prefs rollback save failed — ${messageOf(saveErr)}\n`,
        );
      }
    }
    persistSessionModelPrefs(tab);
    if (tab.toolset) {
      tab.system = prevSystem;
      try {
        if (tabCurrentModelUsable(tab)) tab.runtime = buildRuntimeFor(tab);
        else tab.runtime = null;
      } catch {
        tab.runtime = null;
      }
    }
    throw err;
  }
}

/** Whether the session's pinned subagent model must follow a failover: only when it
 *  resolves to the provider that just ran dry. An unset pin already follows the main
 *  model, and a pin on another provider is still healthy — neither may be rewritten. */
export function subagentPinFollowsFailover(
  pinned: string | undefined,
  failedModel: string,
): boolean {
  if (!pinned) return false;
  return providerForModel(pinned) === providerForModel(failedModel);
}

const TS_EXPORT_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+\*?\s*(\w+)/;

/** TTL on the in-memory file index — without this, files deleted / renamed since the last @ popup still show up as candidates. 10s balances "fresh enough for typical edit-then-mention flows" against "don't re-scan 5000 files on every keystroke". */
const FILE_INDEX_TTL_MS = 10_000;

async function getFileIndexFor(tab: Tab): Promise<FileWithStats[]> {
  const fresh = tab.fileIndex && Date.now() - tab.fileIndexBuiltAt < FILE_INDEX_TTL_MS;
  if (fresh) return tab.fileIndex as FileWithStats[];
  if (tab.fileIndexBuilding) return tab.fileIndexBuilding;
  tab.fileIndexBuilding = listFilesWithStatsAsync(tab.rootDir, { maxResults: 5000 })
    .then((res) => {
      tab.fileIndex = res;
      tab.fileIndexBuiltAt = Date.now();
      tab.fileIndexBuilding = null;
      return res;
    })
    .catch((err) => {
      tab.fileIndexBuilding = null;
      throw err;
    });
  return tab.fileIndexBuilding;
}

async function getSymbolIndexFor(tab: Tab): Promise<SymbolEntry[]> {
  if (tab.symbolIndex) return tab.symbolIndex;
  if (tab.symbolBuilding) return tab.symbolBuilding;
  tab.symbolBuilding = (async () => {
    const files = await getFileIndexFor(tab);
    const sourceExts = /\.(?:ts|tsx|js|jsx|mts|cts)$/;
    const candidates = files.filter((f) => sourceExts.test(f.path)).slice(0, 1500);
    const out: SymbolEntry[] = [];
    const PARALLEL = 16;
    for (let i = 0; i < candidates.length; i += PARALLEL) {
      const batch = candidates.slice(i, i + PARALLEL);
      await Promise.all(
        batch.map(async (entry) => {
          const abs = isAbsolute(entry.path) ? entry.path : join(tab.rootDir, entry.path);
          try {
            const text = await readFile(abs, "utf8");
            const lines = text.split(/\r?\n/);
            for (let li = 0; li < lines.length; li++) {
              const line = lines[li]!;
              if (!line.startsWith("export ")) continue;
              const m = TS_EXPORT_RE.exec(line);
              if (m) out.push({ kind: m[1]!, name: m[2]!, path: entry.path, line: li + 1 });
            }
          } catch (err) {
            emitDiagnosticError("symbol-index.file.failed", err, {
              tabId: tab.id,
              details: { pathChars: entry.path.length, ...tabDiagnosticState(tab) },
            });
            // unreadable / binary — skip, but LOG
            process.stderr.write(`reasonix: symbol index parse failed — ${messageOf(err)}\n`);
          }
        }),
      );
    }
    tab.symbolIndex = out;
    tab.symbolBuilding = null;
    return out;
  })().catch((err) => {
    tab.symbolBuilding = null;
    throw err;
  });
  return tab.symbolBuilding;
}

function rankSymbols(syms: readonly SymbolEntry[], q: string, limit: number): string[] {
  const needle = q.toLowerCase();
  const scored: { entry: SymbolEntry; score: number }[] = [];
  for (const s of syms) {
    const lower = s.name.toLowerCase();
    let score: number;
    if (lower === needle) score = 0;
    else if (lower.startsWith(needle)) score = 100;
    else if (lower.includes(needle)) score = 500 + lower.indexOf(needle);
    else continue;
    scored.push({ entry: s, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map((s) => `${s.entry.path}:${s.entry.line}`);
}

function pushMentionRecent(tab: Tab, path: string): void {
  const MAX = 20;
  const idx = tab.recentMentions.indexOf(path);
  if (idx >= 0) tab.recentMentions.splice(idx, 1);
  tab.recentMentions.unshift(path);
  if (tab.recentMentions.length > MAX) tab.recentMentions.length = MAX;
}

/** The desktop sidecar is a long-running daemon — Tauri spawns this Node process once per app launch and pipes JSON over stdin/stdout. Without these handlers, any orphaned promise rejection (e.g. from an aborted turn whose cleanup races a session-switch — #1074) crashes the process with exit code 1, which the Tauri host surfaces as "reasonix exited (code 1)" and a full reconnect cycle. Log loudly so we can find the underlying bug, but don't take the daemon down. */
let healthDiagnosticsStarted = false;

function startProcessHealthDiagnostics(): void {
  if (healthDiagnosticsStarted) return;
  healthDiagnosticsStarted = true;
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(previousCpu);
    const elapsedMs = now - previousAt;
    previousCpu = process.cpuUsage();
    previousAt = now;
    const memory = process.memoryUsage();
    recordDiagnostic("process.health", {
      level: "verbose",
      details: {
        elapsedMs: Number(elapsedMs.toFixed(3)),
        cpuUserMs: Number((cpu.user / 1000).toFixed(3)),
        cpuSystemMs: Number((cpu.system / 1000).toFixed(3)),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        activeResources: process.getActiveResourcesInfo(),
      },
    });
  }, 30_000);
  timer.unref();
}

export function installDesktopCrashGuards(
  stderr: { write: (s: string) => unknown } = process.stderr,
): void {
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const message = redactDesktopDiagnosticMessage(
      err.stack ?? err.message,
      Number.POSITIVE_INFINITY,
    );
    recordDiagnostic("process.unhandled_rejection", { level: "error", message });
    stderr.write(`[desktop] unhandledRejection: ${message}\n`);
  });
  process.on("uncaughtException", (err) => {
    const message = redactDesktopDiagnosticMessage(
      err.stack ?? err.message,
      Number.POSITIVE_INFINITY,
    );
    recordDiagnostic("process.uncaught_exception", { level: "error", message });
    stderr.write(`[desktop] uncaughtException: ${message}\n`);
  });
}

export async function desktopCommand(opts: DesktopOptions): Promise<void> {
  markPhase("desktop_command_entered");
  const log = createLogger("desktop");
  log.info(`Reasonix+ desktop daemon starting (${opts.model ?? "default model"})`);
  // Tauri spawns the bundled Node from the GUI process, which never runs the
  // user's shell init (`.bashrc` / `.zshrc` / profile). Probe the login shell
  // once so nvm / asdf / fnm / volta / mise PATH entries reach `run_command`
  // children too (#1252). No-op on Windows — system PATH already covers GUI apps.
  const augmented = augmentProcessPath();
  markPhase("process_path_ready");
  if (augmented.added.length > 0) {
    log.debug(`augmented PATH with ${augmented.added.length} login-shell entries`);
  }
  installDesktopCrashGuards();
  startProcessHealthDiagnostics();
  // One-time move of pre-folder flat sessions (<name>.jsonl + sidecars) into
  // their <name>/ folders. Idempotent — a partial migration finishes on the
  // next boot, and a migrated disk is a single cheap readdir.
  try {
    const { migrated, prunedEmpty } = migrateLegacyFlatSessions();
    if (migrated.length > 0 || prunedEmpty.length > 0) {
      log.info(
        `session layout migration: ${migrated.length} migrated, ${prunedEmpty.length} empty pruned`,
      );
    }
  } catch (err) {
    // Never block boot on migration — reads still fall back to legacy paths.
    process.stderr.write(`reasonix: session layout migration failed — ${messageOf(err)}\n`);
  }

  // Fresh chats that were never configured (force-exited with the MCP picker
  // open) are not real sessions — drop them before any list is served.
  try {
    const pruned = await prunePendingMcpSessions();
    if (pruned.length > 0) log.info(`pruned ${pruned.length} never-configured session(s)`);
  } catch (err) {
    process.stderr.write(`reasonix: pending-MCP session prune failed — ${messageOf(err)}\n`);
  }

  const tabs = new Map<string, Tab>();
  // Plan ownership needs to tell two sessions in THIS process apart (two tabs share one
  // pid), and the tab list is the only source of truth for that: a plan whose claiming
  // session is no longer bound here is takeover-able, one that is bound stays locked.
  setLiveSessionProbe((workspace, session) => {
    const want = normalizeWorkspace(workspace);
    for (const tab of tabs.values()) {
      if (tab.currentSession !== session) continue;
      if (tab.rootDir && normalizeWorkspace(tab.rootDir) === want) return true;
    }
    return false;
  });
  // Plan history is workspace-scoped, so its projection fans out to every tab bound to
  // that workspace rather than only the one that wrote the plan.
  workspaceTabs = (workspaceDir) => tabsInWorkspace(workspaceDir);
  publishProviderCatalogs = () => {
    for (const tab of tabs.values()) emitSettings(tab);
  };
  const tabContext = new AsyncLocalStorage<string>();
  // Daemon-scoped shared MCP clients for browser servers — one Playwright
  // client (one browser) is reused by every tab, so switching sessions attaches
  // to the existing browser instead of spawning a second one.
  const browserRegistry = new SharedClientRegistry();
  // Frontend-reported focused tab — persisted so a restart reopens on it (#1244).
  let lastActiveTabId = "";

  // MAX_OPEN_TABS and the eviction rule live in ../../desktop/tab-cap.js so the
  // policy can be unit-tested without standing up the daemon.
  /** Focus recency per tab. Creation order is not the same thing: the user's
   *  attention is what decides which tab is safe to drop. */
  const tabFocusedAt = new Map<string, number>();
  let focusStamp = 0;
  function markTabFocused(tabId: string): void {
    focusStamp += 1;
    tabFocusedAt.set(tabId, focusStamp);
  }
  /** The tab a new one may replace, by the shared policy: least recently focused,
   *  never the one the user is acting from, never one with a turn in flight. */
  function idleTabToEvict(): Tab | undefined {
    const picked = pickTabToEvict(
      [...tabs.values()].map((tab) => ({
        id: tab.id,
        focusedAt: tabFocusedAt.get(tab.id),
        running: Boolean(tab.aborter || tab.activeTurn),
      })),
      lastActiveTabId,
    );
    return picked ? tabs.get(picked.id) : undefined;
  }
  /** How a tab is named in the eviction notice: workspace folder plus session. */
  function tabLabel(tab: Tab): string {
    const folder = tab.rootDir ? tab.rootDir.split(/[\\/]/).filter(Boolean).pop() : undefined;
    const where = folder ?? "untitled tab";
    return tab.currentSession ? `${where} · ${tab.currentSession}` : where;
  }

  function activeRunningTab(): Tab | undefined {
    const id = tabContext.getStore();
    return id ? tabs.get(id) : undefined;
  }

  let first: Tab;
  let settleFirstBootstrap!: () => void;
  const firstBootstrapSettled = new Promise<void>((resolve) => {
    settleFirstBootstrap = resolve;
  });
  // Resolved once the boot announce burst has created the restored tabs. A
  // `desktop_resync` arriving mid-burst must not publish a tab snapshot yet: the
  // frontend prunes its tab set to exactly what the snapshot lists, so a partial
  // one would blank the tabs whose `$tab_opened` is still queued.
  let announceBurstDone = false;
  let settleAnnounceBurst!: () => void;
  const announceBurstSettled = new Promise<void>((resolve) => {
    settleAnnounceBurst = resolve;
  });

  function emitSessionsForWorkspace(
    workspaceDir: string,
    settledDeletes?: SessionsEvent["settledDeletes"],
    options: { exceptTabId?: string } = {},
  ): void {
    for (const t of tabsInWorkspace(workspaceDir)) {
      if (t.id === options.exceptTabId) continue;
      void emitSessions(t, settledDeletes);
    }
  }

  /** Synchronous tab construction — no I/O. All cheap, disk-only events (`$settings`, `$sessions`, `$memory`, `$skills`, `$mcp_specs`) can fire against this immediately. The heavy bits (`buildCodeToolset`, MCP probes, runtime construction) happen in `initTabToolset` so the UI shell paints without waiting for them. */
  function createTabSkeleton(
    initialDir?: string,
    restoreId?: string,
    restore?: {
      groupId?: string;
      session?: string;
      /** The channel was persisted with no session bound (the neutral state). */
      detached?: boolean;
      /** Fresh-channel (New chat) overrides — inherit the source session's prefs
       *  rather than the global config default. */
      model?: string;
      reasoningEffort?: import("../../config.js").ReasoningEffort;
      subagentModel?: string;
    },
    pending = false,
  ): Tab {
    const defaultDir = reasonixDefaultWorkspaceDir();
    const configuredDir = loadWorkspaceDir();
    const fallbackDir =
      configuredDir && !sameWorkspaceDir(configuredDir, reasonixInstallDir())
        ? configuredDir
        : defaultDir;
    const resolvedInitial =
      initialDir && sameWorkspaceDir(initialDir, reasonixInstallDir()) ? defaultDir : initialDir;
    const dir = pending ? "" : resolve(resolvedInitial ?? opts.dir ?? fallbackDir);
    if (!pending) pushRecentWorkspace(dir);
    const model = restore?.model || opts.model || loadModel() || DEFAULT_MODEL;
    // Restored tabs keep their persisted id so a backend restart doesn't
    // re-mint t1..tN over the frontend's still-open tabs. Bump the counter
    // past the restored id so freshly opened tabs never collide with it.
    const id = restoreId ?? nextTabId();
    const idMatch = /^t(\d+)$/.exec(id);
    if (idMatch) tabCounter = Math.max(tabCounter, Number(idMatch[1]));
    // Restored groups keep their id; bump the counter past it so a freshly
    // minted group never collides with a restored one (same rationale as id).
    const groupId = restore?.groupId ?? nextGroupId();
    const groupMatch = /^g(\d+)$/.exec(groupId);
    if (groupMatch) groupCounter = Math.max(groupCounter, Number(groupMatch[1]));
    // A channel mints its session eagerly at creation, and every mint is gated:
    // its capabilities are chosen at that session boundary and frozen by the
    // answer. A restored conversation keeps the set frozen in its own meta, and a
    // channel that comes back neutral mints nothing to gate. A PENDING channel has
    // no workspace to mint into, so it tops out at neutral.
    const skeleton = pending
      ? ({ kind: "neutral" } as const)
      : skeletonSessionFor(restore, adoptableRestoredSession(restore?.session, dir));
    const gateSession = skeleton.kind === "mint";
    const tab: Tab = {
      id,
      groupId,
      rootDir: dir,
      pending,
      currentSession: "",
      shellMetricsSession: null,
      shellMetricsSince: 0,
      currentModel: model,
      currentSubagentModel: restore?.subagentModel,
      currentReasoningEffort: restore?.reasoningEffort ?? loadReasoningEffort(),
      ctxMaxOverride: loadContextTokens(),
      // Every new session starts without the subagent tool; the session-start picker
      // is the only place to opt in, and a restored conversation re-reads its own meta.
      subagents: false,
      toolset: null,
      system: "",
      initialization: null,
      initializationRevision: 0,
      runtime: null,
      aborter: null,
      compactingManual: false,
      fileIndex: null,
      fileIndexBuilding: null,
      fileIndexBuiltAt: 0,
      symbolIndex: null,
      symbolBuilding: null,
      recentMentions: [],
      pendingGateIds: new Set<number>(),
      mcpRuntime: null,
      mcpStatuses: new Map(),
      mcpBridgePromise: null,
      mcpSetupPending: gateSession,
      switching: false,
      planSummary: { completed: 0, total: 0 },
      hooks: pending ? [] : loadHooks({ projectRoot: dir }),
    };
    // A restored session binds its real jsonl when it still exists AND this
    // workspace owns it; `skeletonSessionFor` decides that, so no channel is ever
    // named after a session that is absent from disk. A persisted pairing that
    // names another workspace's session is dropped by `adoptableRestoredSession`
    // so it can't outlive the fix.
    const restoredSession = skeleton.kind === "adopt" ? skeleton.name : undefined;
    // Seed the flag from the session we are about to bind, not from the creation
    // default: the skeleton is announced (and its settings emitted) before startTabInit
    // reads the meta, and a later meta failure must not leave a tab claiming a
    // capability its session never had.
    if (restoredSession) {
      try {
        tab.subagents = sessionSubagentsEnabled(loadSessionMeta(restoredSession));
      } catch {
        void 0; /* unreadable meta: keep the creation default; startTabInit logs the failure */
      }
    }
    tab.currentSession =
      skeleton.kind === "adopt"
        ? skeleton.name
        : skeleton.kind === "mint"
          ? mintSessionFor(
              dir,
              {
                model: tab.currentModel,
                reasoningEffort: tab.currentReasoningEffort,
                subagentModel: tab.currentSubagentModel,
              },
              { mcpSetup: gateSession, subagents: tab.subagents },
            )
          : "";
    tabs.set(tab.id, tab);
    emitTabDiagnostic(tab, "tab.created", { active: false }, "info");
    return tab;
  }

  /** Builds the toolset / system prompt / runtime / MCP bridge for a freshly-created skeleton. Reads `tab.currentModel` at call time so model changes during the wait are honored. */
  function subagentSinkFor(tab: Tab) {
    return {
      current: (ev: SubagentEvent): void => {
        const progress = projectSubagentEvent(ev);
        const runtime = tab.runtime;
        if (!progress || !runtime) return;
        emitKernelEvent(
          runtime.eventizer.emitSubagentProgress(
            ev.parentTurn ?? runtime.loop.currentTurn,
            progress,
          ),
          tab.id,
        );
      },
    };
  }

  /** Streams `run_command` stdout+stderr to the tab as transient `tool.output`
   *  events so the shell card renders live rows. Drops when the toolset runs
   *  outside a tab runtime or the call id can't be mapped. */
  function shellOutputFor(tab: Tab) {
    return (ev: import("../../tools/shell.js").ShellOutputEvent): void => {
      const runtime = tab.runtime;
      if (!runtime || ev.callId === undefined) return;
      emitKernelEvent(
        runtime.eventizer.emitToolOutput(ev.turn ?? runtime.loop.currentTurn, {
          callId: ev.callId,
          name: "run_command",
          text: ev.text,
        }),
        tab.id,
      );
    };
  }

  const bootstrapGate = new ConcurrencyGate(6);

  /** Builds a deferred restored tab's toolset the first time the user opens it, then
   *  releases the composer with `$ready` — the deferred twin of `startTabInit`'s tail. */
  const activationBuilds = new Map<string, Promise<void>>();
  function ensureActiveToolset(tab: Tab): void {
    if (tab.toolset || tab.pending || tab.mcpSetupPending || activationBuilds.has(tab.id)) return;
    if (!tabHasCredential(tab)) return;
    const build = initTabToolset(tab, 1)
      .then(() => {
        emitTabDiagnostic(tab, "tab.ready", undefined, "info");
        emit({ type: "$ready" }, tab.id);
        emitCtxBreakdown(tab);
        void bridgeTabMcp(tab);
      })
      .catch((err) => {
        emitDiagnosticError("tab.bootstrap.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        emit({ type: "$error", message: `init failed: ${(err as Error).message}` }, tab.id);
      })
      .finally(() => activationBuilds.delete(tab.id));
    activationBuilds.set(tab.id, build);
  }

  async function initTabToolset(tab: Tab, priority = 0): Promise<void> {
    const bootstrapStartedAt = performance.now();
    let previousPhaseAt = bootstrapStartedAt;
    emitTabDiagnostic(tab, "tab.bootstrap.started", undefined, "info");
    const { value: toolset, queueWaitMs } = await bootstrapGate.run(
      () =>
        buildCodeToolset({
          ...toolsetOptionsFor(tab, tab.rootDir),
          onPhase: (phase) => {
            const now = performance.now();
            emitTabDiagnostic(tab, "tab.bootstrap.phase", {
              phase,
              phaseDurationMs: Number((now - previousPhaseAt).toFixed(3)),
              bootstrapCumulativeMs: Number((now - bootstrapStartedAt).toFixed(3)),
            });
            previousPhaseAt = now;
          },
        }),
      priority,
    );
    tab.toolset = toolset;
    if (priority > 0) markPhase("first_toolset_ready");
    refreshTabSystemPrompt(tab);
    if (tab.mcpSetupPending) {
      // Fresh chat: hold the composer and the runtime until the user confirms the
      // server set. The toolset exists so the picker can list servers; the runtime
      // (and its tool-spec prefix) is built in the configure handler.
      emitTabDiagnostic(tab, "tab.runtime.waiting-for-mcp-setup", undefined, "info");
    } else if (tabCurrentModelUsable(tab)) {
      bridgeEndpointEnv();
      tab.runtime = buildRuntimeFor(tab);
      if (priority > 0) markPhase("first_runtime_ready");
      emitTabDiagnostic(tab, "tab.runtime.ready", undefined, "info");
      // Bridge AFTER the runtime exists and WITHOUT awaiting it. Every stdio MCP
      // server costs a process spawn plus a protocol handshake and
      // reloadFromConfig connects them one after another, so awaiting it here
      // put the whole MCP latency between the toolset build and `$ready` — on
      // the focused tab's boot critical path. A late bridge hot-adds its tools
      // through the same per-server addTool path a mid-session MCP config edit
      // already takes. Other restored tabs still bridge lazily on first
      // activation (see the tab_activate handler); bridging every tab at
      // startup re-registered the full tool set once per tab and dominated
      // startup.
      if (tab === first) void bridgeTabMcp(tab);
    } else {
      emitTabDiagnostic(tab, "tab.runtime.waiting-for-credential", undefined, "warn");
    }
    // The registry exists only now, so re-emit: the first settings event carried an
    // empty read-only tool list (the mode-rules card rendered that as "none").
    emitSettings(tab);
    emitTabDiagnostic(
      tab,
      "tab.bootstrap.completed",
      {
        toolCount: toolset.tools.specs().length,
        queueWaitMs: Number(queueWaitMs.toFixed(3)),
        durationMs: Number((performance.now() - bootstrapStartedAt).toFixed(3)),
      },
      "info",
    );
  }

  async function emitWorkspaceInitialized(
    tab: Tab,
    sessionsInitialized: Promise<void>,
  ): Promise<void> {
    // The sidebar session list is NOT a prerequisite for a usable workspace.
    // Awaiting the session-directory index here gated the "Loading workspaces"
    // splash on a full index refresh, which on a large store (thousands of
    // sessions, transcripts being revalidated while MCP servers warm up) takes
    // tens of seconds. Fire it in the background — `$sessions` streams in when
    // it resolves.
    void sessionsInitialized.catch(() => undefined);
    // Only the tab the splash reveals has to be fully ready before the splash
    // lifts. Waiting on every restored tab's toolset build and runtime
    // multiplied the splash by the number of open tabs; a
    // background tab clears as soon as its own settings and transcript are on
    // screen, and its build is queued behind the focused tab so it is done long
    // before the user can click it.
    if (tab === first) await tab.initialization;
    emit({ type: "$workspace_initialized", revision: ++tab.initializationRevision }, tab.id);
  }

  // Bridges every configured MCP server into the tab's registry, coalesced per
  // tab. The focused tab's boot bridge is fired without being awaited (see
  // initTabToolset) in the same window where tab activation, MCP config edits
  // and mail setup can also request one; without the latch each request built
  // its own runtime and registered the same tools twice.
  const bridgesInFlight = new WeakMap<Tab, Promise<void>>();
  const bridgeRequestedAgain = new WeakSet<Tab>();
  function bridgeTabMcp(tab: Tab): Promise<void> {
    const inFlight = bridgesInFlight.get(tab);
    if (inFlight) {
      // Coalesce, but never drop the request: an MCP config edit or a mail
      // sign-in that lands mid-handshake has to reload once this one settles,
      // or its server set stays unapplied until the next explicit bridge.
      bridgeRequestedAgain.add(tab);
      return inFlight;
    }
    const bridge = runBridgeTabMcp(tab)
      .catch(() => undefined)
      .finally(() => {
        bridgesInFlight.delete(tab);
        if (bridgeRequestedAgain.delete(tab)) void bridgeTabMcp(tab);
      });
    bridgesInFlight.set(tab, bridge);
    return bridge;
  }

  async function runBridgeTabMcp(tab: Tab): Promise<void> {
    if (!tab.toolset) {
      emitTabDiagnostic(tab, "mcp.bridge.skipped", { reason: "toolset-not-ready" });
      tab.mcpBridgePromise = null;
      return Promise.resolve();
    }
    const activeLoop = tab.runtime?.loop;
    const configured = effectiveMcpSpecs(tab);
    emitTabDiagnostic(tab, "mcp.bridge.started", {
      configured: configured.length,
    });
    const playwrightSpec = configured.find((s) => s.name === "playwright");
    if (playwrightSpec && playwrightSpec.transport === "stdio" && !playwrightSpec.disabled) {
      await ensureNpxAvailable().catch(() => undefined);
      const { mode } = parsePlaywrightConnection(playwrightSpec.args);
      if (
        isPlaywrightManagedBrowser(mode) &&
        !isPlaywrightBrowserInstalled(mode) &&
        !playwrightBrowserInstalls.has(mode)
      ) {
        tab.mcpStatuses.set("playwright", { kind: "handshake" });
        emitMcpSpecs(tab);
        void installPlaywrightBrowser(tab, mode, () => {
          void bridgeTabMcp(tab);
        });
        tab.mcpBridgePromise = null;
        return Promise.resolve();
      }
    }
    if (tab.mcpRuntime) {
      // Already constructed — reload so new/removed specs settle without restart.
      const p = tab.mcpRuntime
        .reloadFromConfig(activeLoop)
        .then(() => {
          emitTabDiagnostic(tab, "mcp.bridge.completed", { mode: "reload" });
          emitMcpSpecs(tab);
          // A late bridge changes the registry after the boot $settings snapshot.
          emitSettings(tab);
        })
        .catch((err) => {
          emitDiagnosticError("mcp.bridge.failed", err, {
            tabId: tab.id,
            details: { mode: "reload", ...tabDiagnosticState(tab) },
          });
          emit({ type: "$error", message: `mcp reload failed: ${(err as Error).message}` }, tab.id);
        });
      tab.mcpBridgePromise = p;
      return p;
    }
    const requested = configured.length;
    if (requested === 0) {
      emitTabDiagnostic(tab, "mcp.bridge.skipped", { reason: "no-configured-servers" });
      tab.mcpBridgePromise = null;
      return Promise.resolve();
    }
    const runtime = createMcpRuntime({
      getTools: () => {
        if (!tab.toolset) throw new Error("toolset gone");
        return tab.toolset.tools;
      },
      getMcpPrefix: () => undefined,
      getRequestedCount: () => requested,
      getWorkspaceDir: () => tab.rootDir,
      getSpecOverrides: () => sessionMcpOverrides(tab.currentSession),
      progressSink: { current: null },
      browserRegistry,
    });
    tab.mcpRuntime = runtime;
    runtime.setLifecycleSink((event) => {
      if (event.state === "slow") {
        emitTabDiagnostic(
          tab,
          "mcp.lifecycle",
          {
            notice: "slow",
            name: event.serverName,
            p95Ms: event.p95Ms,
            sampleSize: event.sampleSize,
          },
          "warn",
        );
        return;
      }
      const activeSpecs = loadEffectiveMcpConfig(tab.rootDir);
      const targetSpec = activeSpecs.find((s) => s.name === event.name);
      const target = targetSpec ? specToRaw(targetSpec) : event.name;
      if (!targetSpec) {
        emitTabDiagnostic(
          tab,
          "mcp.lifecycle.unmatched",
          {
            notice: event.state,
            name: event.name,
          },
          "warn",
        );
        return;
      }
      emitTabDiagnostic(
        tab,
        "mcp.lifecycle",
        {
          notice: event.state,
          name: event.name,
          ...(event.state === "connected"
            ? {
                tools: event.tools,
                resources: event.resources,
                prompts: event.prompts,
                ms: event.ms,
              }
            : {}),
          ...(event.state === "failed" || event.state === "warn" ? { reason: event.reason } : {}),
        },
        event.state === "failed" ? "error" : "debug",
      );
      if (event.state === "handshake") {
        tab.mcpStatuses.set(target, { kind: "handshake" });
        if (targetSpec.name) tab.mcpStatuses.set(targetSpec.name, { kind: "handshake" });
      } else if (event.state === "connected") {
        tab.mcpStatuses.set(target, { kind: "connected", toolCount: event.tools });
        if (targetSpec.name)
          tab.mcpStatuses.set(targetSpec.name, { kind: "connected", toolCount: event.tools });
      } else if (event.state === "tools-ready") {
        // Per-tool toggle applied on a live server — status stays "connected", count refreshes.
        tab.mcpStatuses.set(target, { kind: "connected", toolCount: event.tools });
        if (targetSpec.name)
          tab.mcpStatuses.set(targetSpec.name, { kind: "connected", toolCount: event.tools });
      } else if (event.state === "failed") {
        tab.mcpStatuses.set(target, { kind: "failed", reason: event.reason });
        if (targetSpec.name)
          tab.mcpStatuses.set(targetSpec.name, { kind: "failed", reason: event.reason });
      } else if (event.state === "disabled") {
        tab.mcpStatuses.set(target, { kind: "disabled" });
        if (targetSpec.name) tab.mcpStatuses.set(targetSpec.name, { kind: "disabled" });
      }
      emitMcpSpecs(tab);
    });
    const p = runtime
      .reloadFromConfig(activeLoop)
      .then((result) => {
        emitTabDiagnostic(tab, "mcp.bridge.completed", {
          mode: "initial",
          added: result.added.length,
          removed: result.removed.length,
          failed: result.failed.length,
          summaries: result.summaries.length,
        });
        // Same: refresh the tool list now that the registry has MCP tools.
        emitSettings(tab);
      })
      .catch((err) => {
        emitDiagnosticError("mcp.bridge.failed", err, {
          tabId: tab.id,
          details: { mode: "initial", ...tabDiagnosticState(tab) },
        });
        emit({ type: "$error", message: `mcp bridge failed: ${(err as Error).message}` }, tab.id);
      });
    tab.mcpBridgePromise = p;
    return p;
  }

  /** Snapshot of every open tab — workspace dir, loaded session and focus, in tab order. Persisted after open/close/switch so a restart restores the full tab set and each conversation (issues #933, #1244). */
  function persistOpenTabs(): void {
    try {
      saveDesktopOpenTabs(
        Array.from(tabs.values())
          // Pending (workspace-less) tabs aren't persisted — a restart never
          // reopens an unresolved tab.
          .filter((t) => !t.pending && t.rootDir)
          .map((t) => ({
            dir: t.rootDir,
            id: t.id,
            session: t.currentSession || undefined,
            // A channel holding no session persists AS neutral: minting on restore
            // would resurrect a chat the user never asked for.
            detached: t.currentSession ? undefined : true,
            groupId: t.groupId,
            active: t.id === lastActiveTabId,
          }))
          // The restore path reads this list, so the cap is enforced here too: a
          // restart can never reopen more tabs than the cap allows, and the tab
          // the user was on always survives the cut.
          .sort((a, b) => Number(b.active) - Number(a.active))
          .slice(0, MAX_OPEN_TABS),
      );
    } catch (err) {
      emitDiagnosticError("tabs.persist.failed", err, {
        details: { tabCount: tabs.size, activeTabId: lastActiveTabId },
      });
      // best-effort — disk / perms shouldn't break tab management, but LOG
      process.stderr.write(`reasonix: open tabs persist failed — ${messageOf(err)}\n`);
    }
  }

  /** Publishes the tab set, waiting out a boot announce burst still in flight so
   *  callers that can run mid-boot never publish a PARTIAL set. */
  function publishTabsSnapshot(): void {
    if (announceBurstDone) emitTabsSnapshot();
    else void announceBurstSettled.then(emitTabsSnapshot);
  }

  /** The `$tab_opened` projection, shared by a fresh announce and a resync replay
   *  so the two cannot disagree about a tab's shape. */
  function emitTabOpened(tab: Tab, active?: boolean, creating?: boolean): void {
    emit(
      {
        type: "$tab_opened",
        workspaceDir: tab.rootDir,
        active,
        groupId: tab.groupId,
        // A neutral channel owns no session, so it advertises an empty list rather
        // than one blank name.
        sessions: tab.currentSession ? [tab.currentSession] : [],
        activeSession: tab.currentSession,
        creating,
      },
      tab.id,
    );
  }

  /** The authoritative tab set, also emitted at boot so the frontend renders the
   *  whole ribbon before any tab finishes initializing. */
  function emitTabsSnapshot(): void {
    emit({
      type: "$tabs_snapshot",
      tabs: Array.from(tabs.values()).map((t) => ({
        id: t.id,
        workspaceDir: t.rootDir,
        active: t.id === lastActiveTabId,
        groupId: t.groupId,
        activeSession: t.currentSession,
      })),
    });
  }

  /** One catalog refresh per launch or WebView reload — the endpoints and keys
   *  are app-global, so a single fetch broadcasts to every tab. */
  function refreshLaunchCatalogs(): void {
    void refreshOllamaModels(true);
    void refreshOpencodeModels(false);
    void refreshProviderCatalogs();
  }

  /** The channel (tab) that owns `name` as its current session, if any. A
   *  session is a single running agent — at most one channel may hold it. */
  function channelForSession(name: string): Tab | undefined {
    for (const t of tabs.values()) {
      if (t.currentSession === name) return t;
    }
    return undefined;
  }

  /** Every channel serving workspace `dir`. A pending (workspace-less) tab never
   *  counts: its empty rootDir resolves to the process cwd, so it would otherwise
   *  impersonate whatever directory the daemon was launched from. */
  function tabsInWorkspace(dir: string): Tab[] {
    const out: Tab[] = [];
    for (const t of tabs.values()) {
      if (!t.pending && t.rootDir && sameWorkspaceDir(t.rootDir, dir)) out.push(t);
    }
    return out;
  }

  /** The first channel already serving workspace `dir`, if any — the tab that
   *  hosts a session belonging there. */
  function workspaceTabFor(dir: string): Tab | undefined {
    return tabsInWorkspace(dir)[0];
  }

  async function closeChannel(
    tab: Tab,
    options: { ensureFallback?: boolean; persist?: boolean } = {},
  ): Promise<void> {
    emitTabDiagnostic(tab, "tab.close.started", undefined, "info");
    cancelMailAuth(tab, MailProvider.Outlook);
    cancelMailAuth(tab, MailProvider.Gmail);
    abortTurn(tab);
    cancelPendingGates(tab);
    try {
      await tab.toolset?.jobs.shutdown();
    } catch (err) {
      emitDiagnosticError("tab.jobs.shutdown.failed", err, {
        tabId: tab.id,
        details: tabDiagnosticState(tab),
      });
      // shutdown errors aren't actionable here — but LOG
      process.stderr.write(`reasonix: tab job shutdown failed — ${messageOf(err)}\n`);
    }
    if (tab.mcpRuntime) {
      try {
        // closeAll's loop iterates every MCP client sequentially with no
        // per-client timeout — one hung streamable-http close can stall
        // the whole tab close.  Race the entire batch against 5 s so
        // $tab_closed still fires.
        const DEADLINE = 5000;
        await Promise.race([
          tab.mcpRuntime.closeAll(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out after 5 s")), DEADLINE),
          ),
        ]);
      } catch (err) {
        emitDiagnosticError("tab.mcp.shutdown.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        // MCP shutdown errors aren't actionable here either — but LOG
        process.stderr.write(`reasonix: tab MCP closeAll failed — ${messageOf(err)}\n`);
      }
    }
    // A gated fresh chat never became a real conversation; its never-confirmed
    // session dies with the tab on EVERY close path (X cancel, Ctrl+W, workspace
    // removal). The boot sweep is the force-exit equivalent.
    if (tab.mcpSetupPending && tab.currentSession) {
      tab.mcpSetupPending = false;
      if (deleteSession(tab.currentSession)) {
        emitSessionsForWorkspace(tab.rootDir);
      } else {
        process.stderr.write(`reasonix: pending session delete failed — ${tab.currentSession}\n`);
      }
    }
    tabs.delete(tab.id);
    if (first && first.id === tab.id) {
      const next = tabs.values().next().value;
      if (next) first = next;
    }
    if (lastActiveTabId === tab.id) {
      lastActiveTabId = tabs.values().next().value?.id ?? "";
    }
    if (options.ensureFallback !== false && tabs.size === 0) {
      const clean = bootstrapTab(undefined, { active: true, pending: true });
      first = clean;
      lastActiveTabId = clean.id;
    }
    if (options.persist !== false) persistOpenTabs();
    emitTabDiagnostic(tab, "tab.close.completed", undefined, "info");
    emit({ type: "$tab_closed" }, tab.id);
  }

  /** Remove a visual workspace tab and every independently running session it
   *  owns. This is the only user tab-close path: child agents are not exposed
   *  as separate ribbon tabs or implicitly replaced. */
  async function closeWorkspaceTab(
    tab: Tab,
    options: { ensureFallback?: boolean; persist?: boolean } = {},
  ): Promise<void> {
    const channels = channelsInWorkspaceTab(Array.from(tabs.values()), tab);
    for (const channel of channels) {
      await closeChannel(channel, { ensureFallback: false, persist: false });
    }
    if (options.ensureFallback !== false && tabs.size === 0) {
      const clean = bootstrapTab(undefined, { active: true, pending: true });
      first = clean;
      lastActiveTabId = clean.id;
    } else if (!tabs.has(first?.id)) {
      const next = tabs.values().next().value;
      if (next) first = next;
    }
    if (options.persist !== false) persistOpenTabs();
  }

  /** Exactly one terminal event per accepted or rejected user_input: every
   *  runTurnInner exit path ends here so the desktop's busy flag can never
   *  outlive the turn (the zombie-session class of bugs). */
  function emitTurnEnded(
    tab: Tab,
    outcome: TurnOutcome,
    opts: { turn?: number; reason?: string } = {},
  ): void {
    emit(
      {
        type: "$turn_complete",
        outcome,
        ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
      tab.id,
    );
  }

  async function runTurn(
    tab: Tab,
    text: string,
    images?: TurnImage[],
    clientId?: string,
  ): Promise<void> {
    while (tab.manualCompactDone || tab.activeTurn) {
      await (tab.manualCompactDone ?? tab.activeTurn);
    }
    const work = runTurnInner(tab, text, images, clientId);
    tab.activeTurn = work;
    try {
      await work;
    } finally {
      if (tab.activeTurn === work) tab.activeTurn = undefined;
    }
  }

  /** Terminal-event safety net: whatever escapes the turn body (a throw, a
   *  forgotten return) still settles the desktop exactly once. The body's own
   *  endTurn calls flip `settled`, so the net only fires on a missed path. */
  async function runTurnInner(
    tab: Tab,
    text: string,
    images?: TurnImage[],
    clientId?: string,
  ): Promise<void> {
    let settled = false;
    const endTurn = (outcome: TurnOutcome, opts: { turn?: number; reason?: string } = {}) => {
      settled = true;
      emitTurnEnded(tab, outcome, opts);
    };
    try {
      await runTurnInnerBody(tab, text, images, clientId, endTurn);
    } catch (err) {
      if (!settled && !tab.switching) {
        const reason = err instanceof Error ? err.message : String(err);
        emit({ type: "$notice", text: reason, severity: "error" }, tab.id);
        endTurn("failed", { reason });
      }
    } finally {
      // A session switch owns the tab's state via $session_loaded; the
      // stale-event suppression (#1217) wins over the release here.
      if (!settled && !tab.switching) endTurn("aborted");
    }
  }

  async function runTurnInnerBody(
    tab: Tab,
    text: string,
    images: TurnImage[] | undefined,
    clientId: string | undefined,
    endTurn: (outcome: TurnOutcome, opts?: { turn?: number; reason?: string }) => void,
  ): Promise<void> {
    // A pending tab has no workspace/session/runtime — there is nothing to run.
    if (tab.pending || !tab.rootDir) {
      endTurn("aborted");
      return;
    }
    // The MCP bridge (a slow server initialize) can park the turn before its
    // own fold-idle wait. Lend the turn aborter to that wait so a desktop Stop
    // releases it instead of hanging, then null it again before the turn's real
    // aborter is minted below — the early returns in between assume it is null.
    if (tab.mcpBridgePromise) {
      const bridgeAborter = new AbortController();
      tab.aborter = bridgeAborter;
      const bridged = await abortableWait(
        tab.mcpBridgePromise.catch(() => undefined),
        bridgeAborter.signal,
      );
      tab.aborter = null;
      if (!bridged) {
        tab.switching = false;
        endTurn("aborted");
        return;
      }
    }
    emitTabDiagnostic(
      tab,
      "turn.start.requested",
      {
        textChars: text.length,
        imageCount: images?.length ?? 0,
      },
      "info",
    );
    let modelUsable = false;
    try {
      modelUsable = tabCurrentModelUsable(tab);
    } catch {
      modelUsable = false;
    }
    const rejection = turnStartRejection(tab.currentModel, images, {
      pending: tab.pending,
      hasRootDir: !!tab.rootDir,
      runtimeReady: !!tab.runtime,
      modelUsable,
    });
    if (rejection) {
      if (rejection.kind === "runtime-missing") {
        emitTabDiagnostic(tab, "turn.start.rejected", { reason: "runtime-not-ready" }, "error");
      } else if (rejection.kind === "credential-unavailable") {
        emitTabDiagnostic(
          tab,
          "turn.start.rejected",
          { reason: "credential-unavailable" },
          "error",
        );
      } else if (rejection.kind === "images-need-vision") {
        emitTabDiagnostic(
          tab,
          "turn.start.rejected",
          { reason: "images-require-vision-model", imageCount: images?.length ?? 0 },
          "error",
        );
      }
      endTurn(rejection.outcome, rejection.reason ? { reason: rejection.reason } : {});
      return;
    }
    if (!tab.runtime) {
      endTurn("aborted");
      return;
    }
    let rt = tab.runtime;
    // First turn of a fresh conversation records the model/effort it runs
    // with; a later resume restores them even after a reinstall wiped the
    // config. Never overwrites an existing stored pair (see stampSessionModelPrefs).
    stampSessionModelPrefs(tab);
    if (tab.compactingManual) {
      endTurn("aborted");
      return;
    }
    await tab.turnCleanup;
    tab.turnCleanup = undefined;
    if (tab.compactingManual) {
      endTurn("aborted");
      return;
    }
    refreshPlanSummary(tab);
    tab.aborter = new AbortController();
    if (tab.aborter.signal.aborted) {
      // The turn never started: nothing to settle beyond the busy flag, same
      // completion signal as the hook-blocked path above. A session switch
      // may have set switching while aborting us — this turn has no stale
      // events to suppress, so clear it like a finished turn would.
      tab.switching = false;
      tab.aborter = null;
      endTurn("aborted");
      return;
    }
    emitTabDiagnostic(
      tab,
      "turn.started",
      {
        textChars: text.length,
        imageCount: images?.length ?? 0,
      },
      "info",
    );
    // Authoritative ON for the desktop's busy flag: the turn really runs from
    // here on, before any kernel delta events. An optimistic send spin waits
    // for this instead of assuming the turn started; a stale later release
    // is harmless ($turn_complete / $tab_status both settle to the truth).
    emit({ type: "$turn_started", ...(clientId ? { clientId } : {}) }, tab.id);
    let lastAssistantText = "";
    if (tab.currentSession) {
      const existing = loadSessionMeta(tab.currentSession).summary;
      if (!existing || !existing.trim()) {
        const summary = flattenText(text).slice(0, 60);
        if (summary) {
          try {
            patchSessionMeta(tab.currentSession, { summary });
          } catch (err) {
            // meta is for display only — failure shouldn't block the turn, but LOG
            process.stderr.write(
              `reasonix: session meta summary patch failed — ${messageOf(err)}\n`,
            );
          }
        }
      }
    }
    // A running channel's session must carry its workspace: the workspace's
    // session list is filtered by meta.workspace, so a session without one (a
    // restored archive, a session written by an older build) stays invisible in
    // the sidebar while its tab badge counts it as an active agent — a "ghost"
    // session. Stamp it, then re-emit so it appears immediately.
    if (tab.currentSession && stampSessionWorkspace(tab.currentSession, tab.rootDir)) {
      emitSessionsForWorkspace(tab.rootDir);
    }
    if (tab.hooks.some((h) => h.event === "UserPromptSubmit")) {
      const report = await runHooks({
        hooks: tab.hooks,
        payload: { event: "UserPromptSubmit", cwd: tab.rootDir, prompt: text },
      });
      for (const o of report.outcomes) {
        if (o.decision === "pass") continue;
        // Non-blocking hook failures must not touch turn state — the turn
        // (or its terminal event) is still coming, and $error clears the
        // desktop's busy flag mid-turn.
        emit({ type: "$notice", text: formatHookOutcomeMessage(o), severity: "warning" }, tab.id);
      }
      if (report.blocked || tab.aborter.signal.aborted) {
        tab.aborter = null;
        endTurn("failed");
        return;
      }
    }
    await tabContext.run(tab.id, async () => {
      // Drive the turn generator manually instead of `for await`: an abort
      // can land while the generator is suspended inside an await (a
      // long tool call can hold it). A plain for-await only notices the abort
      // when the next event arrives, so Send now / Stop mid-await never reached
      // $turn_complete and the queued-sends drain never ran. raceLoopStep
      // resolves `null` the moment the aborter fires instead.
      //
      // Factored out of the settlement below so a quota failover can drive ONE
      // more attempt on a backup model without opening a second turn lifecycle.
      const notify = (text: string, severity: "warning" | "error" = "warning"): void =>
        emit({ type: "$notice", text, severity }, tab.id);
      const driveAttempt = async (prompt: string): Promise<TurnAttempt> => {
        const gen = rt.loop.step(prompt, images);
        let aborted = false;
        let lastTurn = -1;
        let sawAssistantFinal = false;
        // Terminal-outcome tracking: `producedAnswer` distinguishes a real reply from
        // a model that stopped silently, so the UI never shows false success.
        let producedAnswer = false;
        let sawError = false;
        let lastStopReason = "";
        let modelFailure = false;
        /** Aborted means the user stopped it: never a model failure, however the
         *  signal reached us (the tab's aborter, or a Stop that raced this attempt). */
        const turnAborted = (): boolean => aborted || tab.aborter?.signal.aborted === true;
        try {
          let emittedTurnContext = false;
          while (true) {
            const next = await raceLoopStep(gen, tab.aborter?.signal);
            if (next === null) {
              aborted = true;
              break;
            }
            if (next.done) break;
            const ev = next.value;
            lastTurn = ev.turn;
            if (!emittedTurnContext) {
              emittedTurnContext = true;
              // Daemon-authoritative turn echo, before this turn's events so
              // the reconciled bubble sits above the turn's cards.
              if (clientId) {
                emitKernelEvent(
                  rt.eventizer.emitUserMessage(rt.loop.currentTurn, prompt, clientId),
                  tab.id,
                );
              }
              emitCtxBreakdown(tab);
            }
            if (ev.role === "assistant_final") {
              sawAssistantFinal = true;
              if (ev.content?.trim()) producedAnswer = true;
              if (ev.content) lastAssistantText = ev.content;
            }
            if (ev.role === "done" && ev.content?.trim()) producedAnswer = true;
            if (ev.role === "error") {
              sawError = true;
              if (ev.error) lastStopReason = ev.error;
              // The loop exhausted every in-loop recovery it has for this model,
              // so only a DIFFERENT model can still finish the turn.
              modelFailure = isModelFailure(ev.errorDetail, turnAborted());
            }
            if (ev.role === "warning" && ev.severity === "high" && ev.content) {
              lastStopReason = ev.content;
            }
            for (const kev of rt.eventizer.consume(ev, rt.ctx)) emitKernelEvent(kev, tab.id);
            if (ev.role === "assistant_final" || ev.role === "tool") {
              emitCtxBreakdown(tab);
            }
            // Memory tools mutate disk state behind the loop's back — the UI
            // panel won't know until we re-emit. Without this the right-hand
            // panel only updates on tab reopen.
            if (ev.role === "tool" && PLAN_INTERACTIVE_TOOL_NAMES.has(ev.toolName ?? "")) {
              // The plan tools just wrote the repository — project its accepted state.
              if (ev.toolName === "mark_step_complete") emitAcceptedStep(tab, ev.content);
              emitRestoredPlan(tab, true);
            }
            if (ev.role === "tool" && (ev.toolName === "remember" || ev.toolName === "forget")) {
              emitMemory(tab);
            }
          }
        } catch (err) {
          // A generator that THROWS instead of yielding an error event is still a
          // dead model — the failure just never reached the event stream, so without
          // this the turn would stop here with backups sitting unused.
          const message = err instanceof Error ? err.message : String(err);
          sawError = true;
          lastStopReason = message;
          modelFailure = isModelFailure(err instanceof Error ? err : { message }, turnAborted());
          emit({ type: "$error", message }, tab.id);
        } finally {
          if (aborted) {
            // Manual compaction must wait for the suspended dispatch to unwind.
            const cleanup = gen.return(undefined).then(() => undefined);
            tab.turnCleanup = cleanup;
            if (tab.compactingManual) await cleanup;
            else void cleanup.catch(() => undefined);
          }
          emitTabDiagnostic(
            tab,
            "turn.finished",
            {
              aborted,
              lastTurn,
              sawAssistantFinal,
              lastAssistantChars: lastAssistantText.length,
            },
            aborted ? "warn" : "info",
          );
        }
        return {
          aborted,
          lastTurn,
          sawAssistantFinal,
          producedAnswer,
          sawError,
          lastStopReason,
          modelFailure,
        };
      };

      let attempt = await driveAttempt(text);
      // Automatic backup-model failover: a provider that fails mid-conversation
      // (rate limit, spent quota, outage, unreachable endpoint) would otherwise
      // end the turn here, leaving an unattended (overnight) run idle until
      // someone wakes up to switch models.
      // Each backup is switched to, then the prompt is replayed exactly like the
      // desktop's Retry, until an attempt answers or the chain runs out.
      // The model that actually hit the wall: a chain moves tab.currentModel, so every
      // stop message has to name this one, not wherever the chain ended up.
      const primaryModel = tab.currentModel;
      const configuredFallbacks = loadFallbackModels();
      const triedModels = new Set([primaryModel]);
      let failedOverTo: string | null = null;
      let failoverBroken = false;
      while (shouldFailover(attempt)) {
        const next = pickFallbackModel(configuredFallbacks, triedModels, modelUsableFor);
        if (!next) break;
        triedModels.add(next);
        const failedModel = tab.currentModel;
        try {
          // Session-scoped: an automatic switch must never rewrite the user's
          // global default model behind their back. The subagent pin follows this
          // conversation's model too when it sits on the provider that ran dry.
          applyTabModel(tab, next, { persistDefault: false, followSubagentPin: true });
        } catch (err) {
          notify(`Backup model switch to ${next} failed: ${messageOf(err)}`, "error");
          failoverBroken = true;
          break;
        }
        if (!tab.runtime) {
          // The backup has no usable runtime here (its credential went away
          // between the screening check and the rebuild). Put the model the turn
          // was running on back, so the tab is never stranded without a runtime.
          try {
            applyTabModel(tab, failedModel, { persistDefault: false, followSubagentPin: true });
          } catch (rollbackErr) {
            process.stderr.write(
              `reasonix: backup-model rollback to ${failedModel} failed — ${messageOf(rollbackErr)}\n`,
            );
          }
          if (!tab.runtime) {
            notify(
              "No usable model runtime after the quota failover — pick a model in the composer to continue.",
              "error",
            );
          }
          failoverBroken = true;
          break;
        }
        rt = tab.runtime;
        failedOverTo = next;
        // Rewind on the NEW runtime, never before the switch: the truncation is
        // persisted to the session file, so doing it first would drop the prompt
        // from the log whenever the switch itself failed.
        const before = rt.loop.log.length;
        if (rt.loop.retryLastUser() !== text) {
          // The prompt is no longer the log's last real user turn (compaction folded
          // it away, or it carried attachments), so replaying would send a different
          // request. Keep the switch and hand the user an actionable stop message
          // instead of ending the turn on a bare provider error.
          notify(t("loop.failoverPromptUnavailable", { next }));
          failoverBroken = true;
          break;
        }
        emitKernelEvent(
          rt.eventizer.emitSessionRetracted(
            rt.loop.currentTurn,
            "retry",
            before,
            rt.loop.log.length,
            rt.loop.log.entries,
          ),
          tab.id,
        );
        // The turn's own aborter is still live here (nothing releases it until the
        // whole turn settles), so Stop keeps cancelling the retry too.
        notify(t("loop.failoverSwitching", { failed: failedModel, next }));
        attempt = await driveAttempt(text);
      }
      if (shouldFailover(attempt) && !failoverBroken) {
        // Nothing left to try. Name the situation the run ended in, so the stop is
        // explained instead of left to the provider's raw error card: no backups at
        // all, backups that cannot run here, or backups that were tried and failed.
        const triedBackups = [...triedModels].filter((model) => model !== primaryModel);
        notify(
          configuredFallbacks.length === 0
            ? t("loop.failoverNoBackup", { failed: primaryModel })
            : triedBackups.length === 0
              ? t("loop.failoverNoneUsable", { failed: primaryModel })
              : t("loop.failoverAllExhausted", {
                  failed: primaryModel,
                  models: triedBackups.join(", "),
                }),
        );
      }
      tab.aborter = null;
      // If a session switch happened while this turn was running,
      // suppress stale events to avoid UI state corruption (#1217).
      if (!tab.switching) {
        if (attempt.aborted && attempt.lastTurn >= 0 && !attempt.sawAssistantFinal) {
          // The loop's own abort path never ran (the generator was
          // closed mid-await), so settle the still-pending assistant
          // card here — $turn_complete alone leaves it spinning.
          emitKernelEvent(rt.eventizer.emitAbortedFinal(attempt.lastTurn), tab.id);
        }
        const outcome: TurnOutcome = attempt.aborted
          ? "aborted"
          : attempt.producedAnswer
            ? "success"
            : attempt.sawError
              ? "failed"
              : "stopped";
        const reason = attempt.producedAnswer
          ? undefined
          : attempt.lastStopReason || t("loop.stoppedNoAnswer");
        endTurn(outcome, {
          ...(attempt.lastTurn >= 0 ? { turn: attempt.lastTurn } : {}),
          ...(reason ? { reason } : {}),
        });
        // The model chip has to follow a failover. Emitted AFTER $turn_complete
        // so the desktop's model-change handler cannot release a busy turn.
        if (failedOverTo) emitSettings(tab);
        refreshPlanSummary(tab);
        emitTabDiagnostic(tab, "turn.complete.emitted", { planProgress: tab.planSummary }, "info");
        void emitSessions(tab);
        void refreshFunds(tab, { force: true });
        if (tab.hooks.some((h) => h.event === "Stop")) {
          const stopReport = await runHooks({
            hooks: tab.hooks,
            payload: {
              event: "Stop",
              cwd: tab.rootDir,
              lastAssistantText,
              turn: rt.loop.stats.summary().turns,
            },
          });
          for (const o of stopReport.outcomes) {
            if (o.decision === "pass") continue;
            notify(formatHookOutcomeMessage(o));
          }
        }
      }
      tab.switching = false;
    });
  }

  async function switchWorkspace(tab: Tab, nextDir: string): Promise<void> {
    const target = resolve(nextDir);
    emitTabDiagnostic(tab, "workspace.switch.started", { targetChars: target.length }, "info");
    // A pending tab has no workspace to leave, and its empty rootDir would resolve
    // to the daemon's own cwd — never treat that as a busy workspace.
    if (!tab.pending && workspaceSessionBusy(tab.rootDir)) {
      // Refused, not deferred: the channels here are mid-mint or mid-settle, and
      // moving rootDir now would re-target the snapshot they are waiting for.
      emitTabDiagnostic(tab, "workspace.switch.refused_busy", { reason: "session-work" }, "info");
      refuseSessionMutation(WORKSPACE_SWITCH_BLOCKED_MESSAGE, tab.id);
      emitSettings(tab);
      return;
    }
    if (!tab.pending && sameWorkspaceDir(target, tab.rootDir)) {
      // Re-opening the current workspace means "new session", never a second
      // workspace tab and never a destructive reload of this agent. It is a
      // creation, so it takes the same one-at-a-time gate as New chat.
      if (!sessionCreationGate.tryEnter(tab.rootDir)) {
        refuseSessionMutation(SESSION_CREATION_IN_FLIGHT_MESSAGE, tab.id);
        emitSettings(tab);
        return;
      }
      const opened = bootstrapTab(tab.rootDir, {
        active: true,
        groupId: tab.groupId,
      });
      armCreationRelease(opened);
      lastActiveTabId = opened.id;
      persistOpenTabs();
      emitTabDiagnostic(tab, "workspace.switch.redirected", { reason: "same-workspace" });
      return;
    }
    if (!isExistingWorkspaceDir(target)) {
      emitTabDiagnostic(
        tab,
        "workspace.switch.rejected",
        { targetChars: target.length, reason: "not-a-directory" },
        "error",
      );
      emit({ type: "$error", message: `Workspace not found: ${target}` }, tab.id);
      emitSettings(tab);
      return;
    }
    // A workspace tab owns all of its session agents. Changing that tab's
    // workspace stops/removes every child except this channel, which is reused
    // for the target workspace below.
    const siblings = channelsInWorkspaceTab(Array.from(tabs.values()), tab).filter(
      (candidate) => candidate.id !== tab.id,
    );
    for (const sibling of siblings) {
      await closeChannel(sibling, { ensureFallback: false, persist: false });
    }

    // The target may already have a workspace tab. In that case this source tab
    // is removed as a unit and the request becomes a new independent session in
    // the existing target tab—never a duplicate workspace ribbon entry.
    const targetTab = tabsInWorkspace(target).find((candidate) => candidate.id !== tab.id);
    if (targetTab) {
      await closeChannel(tab, { ensureFallback: false, persist: false });
      const opened = bootstrapTab(target, {
        active: true,
        groupId: targetTab.groupId,
      });
      lastActiveTabId = opened.id;
      persistOpenTabs();
      return;
    }

    abortTurn(tab);
    cancelPendingGates(tab);
    cancelMailAuth(tab, MailProvider.Outlook);
    cancelMailAuth(tab, MailProvider.Gmail);
    try {
      await tab.toolset?.jobs.shutdown();
    } catch (err) {
      emitDiagnosticError("workspace.jobs.shutdown.failed", err, {
        tabId: tab.id,
        details: { targetChars: target.length, ...tabDiagnosticState(tab) },
      });
      // shutdown errors aren't actionable here — but LOG
      process.stderr.write(`reasonix: tab job shutdown failed — ${messageOf(err)}\n`);
    }
    tab.rootDir = target;
    tab.pending = false;
    // The reused channel becomes the sole initial session in a new workspace
    // tab. Its former sibling agents were closed above.
    tab.groupId = nextGroupId();
    saveWorkspaceDir(target);
    pushRecentWorkspace(target);
    tab.fileIndex = null;
    tab.fileIndexBuilding = null;
    tab.fileIndexBuiltAt = 0;
    tab.symbolIndex = null;
    tab.symbolBuilding = null;
    tab.recentMentions.length = 0;
    tab.hooks = loadHooks({ projectRoot: target });
    if (tab.currentSession && !sessionExists(tab.currentSession)) {
      // A bound session that vanished (deleted from outside this app) has no index
      // entry worth keeping; the channel is re-bound below anyway.
      deleteSession(tab.currentSession);
    }
    // Drop the previous workspace's session binding before the awaits below: a
    // persist interleaved with the switch (the frontend echoes `tab_activate` on
    // every focus change) would otherwise record {dir: target, session: <old
    // workspace's>}, a crossed pair that outlives this run.
    tab.currentSession = "";
    // Switch the UI to the new workspace BEFORE loading its conversation: the
    // frontend clears transcript state on a workspaceDir change, so emitting
    // settings now keeps a later $session_loaded (with the resumed messages)
    // from being wiped by that clear.
    emitSettings(tab);
    const toolset = await buildCodeToolset(toolsetOptionsFor(tab, target));
    tab.toolset = toolset;
    refreshTabSystemPrompt(tab);
    emitSettings(tab);
    // Implicitly select the workspace's most recent session (newest-first) so a
    // workspace switch lands where you left off; mint a fresh conversation only
    // when the workspace has no sessions yet. loadSessionIntoTab restores the
    // stored model/effort and rebuilds the runtime + system prompt for it.
    const { value: workspaceSessions } = listSessionsForWorkspaceAsync(target);
    // Never resume a session another channel already holds — that would put two
    // agents on one session. Fall through to the next newest free session.
    const resume = pickResumeSession(await workspaceSessions, (s) => {
      const holder = channelForSession(s.name);
      return holder !== undefined && holder.id !== tab.id;
    });
    if (resume) {
      loadSessionIntoTab(tab, resume.name, { abortTurn, cancelPendingGates, persistOpenTabs });
    } else {
      // A workspace with no sessions yet: mint one and gate it like any other session
      // start. The confirm builds the runtime, so its prefix freezes the answered set,
      // and the pre-fill is always off: opting in is the picker's job.
      tab.currentSession = mintSessionFor(target, undefined, {
        mcpSetup: true,
        subagents: false,
      });
      bindSessionSubagents(tab, false);
      emit(
        {
          type: "$session_loaded",
          name: tab.currentSession,
          messages: [],
          events: [],
          carryover: emptySessionCarryover(),
        },
        tab.id,
      );
      emitRestoredPlan(tab, false);
      armSessionGate(tab);
    }
    if (tab.mcpRuntime) {
      await tab.mcpRuntime.closeAll().catch(() => undefined);
      tab.mcpRuntime = null;
    }
    if (tab.runtime) {
      void bridgeTabMcp(tab);
    }
    emitSessionsForWorkspace(target);
    emitSettings(tab);
    emitSkills(tab);
    persistOpenTabs();
    // Let the frontend regroup: the tab's workspace (and now groupId) changed.
    emit(
      {
        type: "$tab_opened",
        workspaceDir: tab.rootDir,
        active: tab.id === lastActiveTabId,
        groupId: tab.groupId,
        sessions: [tab.currentSession],
        activeSession: tab.currentSession,
      },
      tab.id,
    );
    emitTabDiagnostic(tab, "workspace.switch.completed", { targetChars: target.length }, "info");
    // Re-emit the setup/ready gate: a tab that was PENDING (no workspace) never
    // got `$ready`, so the composer would stay disabled after assigning one.
    emitTabGate(tab);
  }

  function forgetGate(id: number): Tab | undefined {
    for (const t of tabs.values()) {
      if (t.pendingGateIds.delete(id)) return t;
    }
    return undefined;
  }

  // Backend half of each YOLO auto-resolve countdown. One entry per pending gate
  // so the desktop can pause/resume it in lockstep with the card's own clock
  // (via the `gate_timer` command): without this, "disable timer" only stopped
  // the UI countdown while the backend still resolved the gate at expiry — a
  // silent desync where the card sat on screen after the gate was already gone.
  type GateCountdown = {
    handle: ReturnType<typeof setTimeout> | null;
    verdict: unknown;
    ms: number;
    /** Fired after the countdown resolves the gate — persists the auto-approved
     *  plan without a plan_response/revision_response RPC (YOLO countdowns). */
    onResolve?: () => void;
  };
  const gateCountdowns = new Map<number, GateCountdown>();

  function startGateCountdown(id: number, entry: GateCountdown): void {
    entry.handle = setTimeout(() => {
      gateCountdowns.delete(id);
      forgetGate(id);
      pauseGate.resolve(id, entry.verdict);
      entry.onResolve?.();
    }, entry.ms);
  }

  function armGateCountdown(
    id: number,
    verdict: unknown,
    ms: number,
    onResolve?: () => void,
  ): void {
    const existing = gateCountdowns.get(id);
    if (existing?.handle) clearTimeout(existing.handle);
    const entry: GateCountdown = { handle: null, verdict, ms };
    if (onResolve) entry.onResolve = onResolve;
    gateCountdowns.set(id, entry);
    startGateCountdown(id, entry);
  }

  /** Pause the backend timer but keep the verdict so it can be resumed. */
  function suspendGateCountdown(id: number): void {
    const entry = gateCountdowns.get(id);
    if (!entry?.handle) return;
    clearTimeout(entry.handle);
    entry.handle = null;
  }

  /** Re-arm a fresh full window — mirrors the card restarting its own clock. */
  function resumeGateCountdown(id: number): void {
    const entry = gateCountdowns.get(id);
    if (!entry || entry.handle) return;
    startGateCountdown(id, entry);
  }

  function clearGateCountdown(id: number): void {
    const entry = gateCountdowns.get(id);
    if (entry?.handle) clearTimeout(entry.handle);
    gateCountdowns.delete(id);
  }

  function abortTurn(tab: Tab, opts: LoopAbortOptions = {}): void {
    tab.aborter?.abort();
    tab.runtime?.loop.abort(opts);
  }

  function cancelConversation(tab: Tab, opts: LoopAbortOptions = {}): void {
    abortTurn(tab, opts);
    cancelPendingGates(tab);
    void tab.toolset?.jobs
      // Session-scoped teardown: Stop / New chat kill ephemeral jobs but spare
      // workspace-scoped persistent shells (those end on workspace/app close).
      .shutdown(1500, { keepPersistent: true })
      .catch((err) => {
        emitDiagnosticError("conversation.jobs.shutdown.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        process.stderr.write(`reasonix: conversation job shutdown failed — ${messageOf(err)}\n`);
      })
      .finally(() => emitJobs());
  }

  /** Build the tab's runtime, `fresh` meaning it now serves a DIFFERENT (or no) session.
   *  Turn ordinals are session-wide identity, so a fresh binding must not inherit the
   *  previous conversation's floor; the same session keeps it across a rebuild. */
  function rebuildTabRuntime(tab: Tab, options: { fresh?: boolean } = {}): void {
    if (options.fresh) tab.runtime = null;
    try {
      tab.runtime = tab.toolset && tabCurrentModelUsable(tab) ? buildRuntimeFor(tab) : null;
    } catch (err) {
      emitDiagnosticError("session.runtime.rebuild.failed", err, {
        tabId: tab.id,
        details: { fresh: options.fresh === true, ...tabDiagnosticState(tab) },
      });
      tab.runtime = null;
    }
  }

  /** Move a channel's session binding — the ONE place it moves outside a session load.
   *  `name` is the empty string for the neutral state (no session bound at all). */
  function rebindTabSession(tab: Tab, name: string): void {
    tab.currentSession = name;
    persistOpenTabs();
    rebuildTabRuntime(tab, { fresh: true });
    emit({ type: "$session_bound", name }, tab.id);
    emitRestoredPlan(tab, false);
    emitCtxBreakdown(tab);
  }

  /** Land a channel whose session was just deleted in the NEUTRAL state: nothing bound,
   *  empty transcript, and the next message creates the session it lands in. */
  function detachTabSession(tab: Tab): void {
    emitTabDiagnostic(tab, "session.detach.started", undefined, "info");
    rebindTabSession(tab, "");
    emitTabDiagnostic(tab, "session.detach.completed", undefined, "info");
  }

  /** The other half of the neutral state: the message sent into a channel that holds no
   *  session creates that session HERE, carrying the message. */
  function bindSessionForSend(tab: Tab): void {
    const name = mintSessionFor(
      tab.rootDir,
      {
        model: tab.currentModel,
        reasoningEffort: tab.currentReasoningEffort,
        subagentModel: tab.currentSubagentModel,
      },
      // The capability is frozen at this session boundary like any other mint; the
      // neutral channel cannot host a picker, so it takes the configured default.
      { subagents: tab.subagents },
    );
    rebindTabSession(tab, name);
    // List it now: the sidebar is where the user sees the chat they just started.
    emitSessionsForWorkspace(tab.rootDir);
    emitTabDiagnostic(tab, "session.bind.completed", { name }, "info");
  }

  /** Every user turn funnels through here, so a channel holding no session creates the
   *  session its message lands in first. False means it cannot run, and the refusal
   *  has been emitted. */
  function ensureTurnSession(tab: Tab): boolean {
    // A channel with no runtime cannot send at all, so it mints nothing: an empty
    // session would outlive the refusal below.
    if (!tab.currentSession && tab.runtime) bindSessionForSend(tab);
    if (!tab.runtime) {
      emitTurnEnded(tab, "stopped", { reason: notConfiguredMessage(tab.currentModel) });
      return false;
    }
    return true;
  }

  /** Abort every live writer bound to a doomed session BEFORE its folder is
   *  removed, so none can recreate it from an in-flight turn. Returns the tabs
   *  that were bound to a doomed session. */
  function detachDoomedSessionWriters(doomed: ReadonlySet<string>): Tab[] {
    const affected = Array.from(tabs.values()).filter((t) => doomed.has(t.currentSession));
    for (const t of affected) {
      // A gate cancel or a runtime abort must never abort the whole delete:
      // throwing here would skip the settled $sessions emit below and strand the
      // sidebar's optimistic hide forever.
      try {
        if (t.aborter) t.switching = true;
        cancelConversation(t);
        t.runtime?.loop.detachSessionPersistence();
      } catch (err) {
        emitDiagnosticError("session.detach.failed", err, {
          tabId: t.id,
          details: tabDiagnosticState(t),
        });
      }
    }
    return affected;
  }

  /** A failed delete leaves its tab's runtime torn down; rebuild it so the
   *  channel is usable again. Sessions that WERE removed are skipped — their
   *  tabs are re-armed by resyncAfterDeletes instead. */
  function restoreUntouchedRuntimes(affected: readonly Tab[], removed: ReadonlySet<string>): void {
    for (const t of affected) {
      if (removed.has(t.currentSession)) continue;
      // Same session as before, so its ordinal floor still applies.
      rebuildTabRuntime(t);
      t.switching = false;
    }
  }

  /** Post-delete resync: detach every tab still bound to a removed session instead of
   *  naming a session that is gone; every tab gets the refreshed sidebar list. */
  function resyncAfterDeletes(
    settledDeletes: SessionsEvent["settledDeletes"],
    shouldDetach: (tab: Tab) => boolean,
  ): void {
    const refreshed = new Set<string>();
    for (const openTab of tabs.values()) {
      if (shouldDetach(openTab)) detachTabSession(openTab);
      refreshed.add(openTab.rootDir);
    }
    // One snapshot per affected workspace, never one per channel: a clear-all
    // with many open channels otherwise re-listed the store once per replaced
    // channel and buried the frontend in hundreds of $sessions events.
    for (const dir of refreshed) {
      emitSessionsForWorkspace(dir, settledDeletes);
      // The removed sessions may have owned in-flight plans: re-project this
      // workspace's plan history so no tab keeps labelling one with a session that
      // no longer exists (its claim now reads as free, which is what takeover uses).
      const [viewer] = workspaceTabs?.(dir) ?? [];
      if (viewer) emitPlanHistory(viewer);
    }
  }

  /** Bring an already-open session's channel to the front and refresh its list. */
  function focusSessionChannel(channel: Tab): void {
    lastActiveTabId = channel.id;
    persistOpenTabs();
    emit(
      {
        type: "$tab_opened",
        workspaceDir: channel.rootDir,
        active: true,
        groupId: channel.groupId,
        sessions: [channel.currentSession],
        activeSession: channel.currentSession,
      },
      channel.id,
    );
    emitSessionsForWorkspace(channel.rootDir);
  }

  /** Open `name` in the workspace its meta stamps, or focus the channel already
   *  holding it there. A click never binds or focuses a foreign workspace's tab.
   *  `legacy` (session_load) never re-focuses a channel open in this same tab. */
  function openOrFocusSession(tab: Tab, name: string, legacy: boolean): void {
    const op = legacy ? "session_load" : "session_open";
    const home = sessionWorkspaceOf(name, tab.rootDir);
    const existing = channelServingSession(Array.from(tabs.values()), name, home);
    if (existing) {
      if (legacy && existing.id === tab.id) emitSessionsForWorkspace(existing.rootDir);
      else focusSessionChannel(existing);
      return;
    }
    // A channel in some OTHER workspace still claims this session: a stale
    // binding. Focusing it is what dragged the user to that workspace's tab, so
    // report it and bind the session where it actually lives instead.
    const stale = channelForSession(name);
    if (stale) {
      emitTabDiagnostic(
        tab,
        "session.open.stale-binding",
        {
          session: name,
          holderTab: stale.id,
          holderWorkspaceChars: stale.rootDir.length,
          homeWorkspaceChars: home.length,
        },
        "warn",
      );
    }
    const hostTab = sameWorkspaceDir(home, tab.rootDir) ? tab : workspaceTabFor(home);
    if (!hostTab && !isExistingWorkspaceDir(home)) {
      // The session's workspace is gone. Opening it in THIS tab's workspace is
      // the cross-workspace binding we forbid, so say why nothing happened.
      emitTabDiagnostic(
        tab,
        "session.open.home-missing",
        { session: name, homeWorkspaceChars: home.length },
        "warn",
      );
      emit(
        {
          type: "$error",
          message: `${op}: the workspace this session belongs to no longer exists (${home})`,
        },
        tab.id,
      );
      return;
    }
    try {
      const opened = bootstrapTab(hostTab ? hostTab.rootDir : home, {
        session: name,
        active: true,
        groupId: hostTab?.groupId,
      });
      lastActiveTabId = opened.id;
      persistOpenTabs();
    } catch (err) {
      emitDiagnosticError(legacy ? "session.load.failed" : "session.open.failed", err, {
        tabId: tab.id,
        details: { requestedSession: name, ...tabDiagnosticState(tab) },
      });
      if (legacy) {
        process.stderr.write(`session_load: "${name}" threw — ${(err as Error).message}\n`);
      }
      emit({ type: "$error", message: `${op} failed: ${(err as Error).message}` }, tab.id);
    }
  }

  /** Patch a session's meta and re-emit its workspace list; `buildPatch` runs
   *  inside the guard, so malformed input surfaces as a command error, not a
   *  crash. */
  function patchSessionMetaAndResync(
    tab: Tab,
    op: string,
    name: string,
    buildPatch: () => Partial<SessionMeta>,
  ): void {
    try {
      patchSessionMeta(name, buildPatch());
      emitSessionsForWorkspace(tab.rootDir);
    } catch (err) {
      emit({ type: "$error", message: `${op} failed: ${(err as Error).message}` }, tab.id);
    }
  }

  function tabSessionLabel(tab: Tab): string {
    if (tab.currentSession) {
      try {
        const summary = loadSessionMeta(tab.currentSession).summary?.trim();
        if (summary) return summary;
      } catch (err) {
        emitDiagnosticError("session.meta.load.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        // session file unreadable — fall through to workspace basename, but LOG
        process.stderr.write(`reasonix: session meta load failed — ${messageOf(err)}\n`);
      }
    }
    return tab.rootDir.split(/[\\/]/).filter(Boolean).pop() ?? tab.rootDir;
  }

  /** Rule writes land in the shared config, so a tab that did not perform the write keeps
   *  a stale workspace list until it hears about it. */
  function emitSettingsToAllTabs(): void {
    for (const t of tabs.values()) emitSettings(t);
  }

  /** Build (or rebuild) every now-credentialed tab so a fresh sign-in or saved
   *  key takes effect without a model flip. A tab that booted un-credentialed has
   *  a null runtime — it must be built here, not just rebuilt. */
  function rebuildCredentialedTabs(): void {
    for (const t of tabs.values()) {
      if (t.toolset) {
        t.runtime = tabCurrentModelUsable(t) ? buildRuntimeFor(t) : null;
        if (t.runtime) emit({ type: "$ready" }, t.id);
      }
    }
  }

  /** The buildCodeToolset options shared by tab bootstrap and workspace switch. */
  function toolsetOptionsFor(tab: Tab, rootDir: string): Parameters<typeof buildCodeToolset>[0] {
    return {
      rootDir,
      getMcpSpecs: () => effectiveMcpSpecs(tab),
      getMcpToolSkips: () => tab.mcpRuntime?.toolSkips() ?? [],
      subagentsEnabled: sessionSubagentsEnabled(tab),
      onJobsChanged: () => emitJobs(),
      onRulesChanged: () => emitSettingsToAllTabs(),
      onShellOutput: shellOutputFor(tab),
      subagentSink: subagentSinkFor(tab),
      subagentModel: () => tab.currentSubagentModel ?? tab.currentModel,
      // The session's effort, not a fixed subagent budget: a spawned child must
      // reason as hard as the chat that commissioned it.
      subagentEffort: () => tab.currentReasoningEffort,
      // Everything a child inherits from this tab's loop, read at spawn time: the
      // runtime is built after the toolset, and every value here can change
      // mid-session. Hooks matter most — a user's PreToolUse gate must not be
      // bypassed just because the tool call came from a subagent.
      subagentLoopOptions: () => ({
        ctxMaxOverride: tab.runtime?.loop.ctxMaxOverride,
        autoCompactTriggerRatio: tab.runtime?.loop.autoCompactTriggerRatio,
        maxIterPerTurn: tab.runtime?.loop.maxIterPerTurn,
        maxOutputTokens: tab.runtime?.loop.maxOutputTokens,
        hooks: tab.hooks,
        hookCwd: tab.rootDir,
      }),
    };
  }

  /** Ensure the bundled playwright MCP server exists in `cfg`, returning its
   *  mutable entry + the catalog default args (undefined when unavailable). */
  function ensurePlaywrightServerEntry(
    cfg: ReasonixConfig,
  ): { stored: McpServerConfig; args: string[] } | undefined {
    const entry = MCP_CATALOG.find((e) => e.name === "playwright");
    if (!entry) return undefined;
    const { command, args } = catalogStdioCommand(entry);
    mergeMcpServerEntry(cfg, entry.name, { transport: "stdio", command, args });
    const stored = cfg.mcpServers?.[entry.name];
    return stored ? { stored, args } : undefined;
  }

  /** Persist a mutated playwright MCP entry and refresh the desktop UI. */
  function commitPlaywrightMcpEntry(cfg: ReasonixConfig, tab: Tab): void {
    writeConfig(cfg);
    emitMcpSpecs(tab);
    emitMcpExtensionStatus(tab);
  }

  function emitJobs(): void {
    const items: JobInfo[] = [];
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      const label = tabSessionLabel(t);
      for (const j of reg.list()) {
        items.push({
          id: j.id,
          tabId: t.id,
          sessionLabel: label,
          command: j.command,
          pid: j.pid,
          running: j.running,
          exitCode: j.exitCode,
          startedAt: j.startedAt,
          outputTail: tailLines(j.output, 30),
          spawnError: j.spawnError,
          persistent: j.persistent,
        });
      }
    }
    items.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      return b.startedAt - a.startedAt;
    });
    emit({ type: "$jobs", items });
  }

  async function stopJob(jobId: number, tabId?: string): Promise<boolean> {
    const reg = pickJobOwner(
      [...tabs.values()].flatMap((t) => {
        const j = t.toolset?.jobs;
        return j ? [{ tabId: t.id, jobIds: new Set(j.list().map((r) => r.id)), owner: j }] : [];
      }),
      jobId,
      tabId,
    );
    if (!reg) return false;
    await reg.stop(jobId);
    return true;
  }

  async function stopAllJobs(): Promise<void> {
    const ops: Promise<unknown>[] = [];
    for (const t of tabs.values()) {
      const reg = t.toolset?.jobs;
      if (!reg) continue;
      for (const j of reg.list()) {
        if (j.running) ops.push(reg.stop(j.id));
      }
    }
    await Promise.allSettled(ops);
  }

  function cancelPendingGates(tab: Tab): void {
    const hadActivePlan = activePlanForTab(tab) !== null;
    const ids = [...tab.pendingGateIds];
    tab.pendingGateIds.clear();
    for (const id of ids) {
      clearGateCountdown(id);
      pauseGate.cancel(id);
    }
    if (hadActivePlan) {
      refreshPlanSummary(tab);
      emit({ type: "$plan_cleared" }, tab.id);
    }
  }

  // `first` is the fallback tab for legacy tabId-less RPC messages. We
  // assign it lazily below so saved-tabs restore (issue #933) can choose
  // the boot dir before construction, and rotate `first` to the next
  // surviving tab when its source closes.
  let shuttingDown = false;
  /** Periodic quota poll: assigned below after tab restore, cleared on shutdown. */
  let quotaTimer: ReturnType<typeof setInterval> | undefined = undefined;
  async function gracefulShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (quotaTimer) clearInterval(quotaTimer);
    await Promise.allSettled(
      [...tabs.values()].map((t) => t.toolset?.jobs.shutdown(1500) ?? Promise.resolve()),
    );
    await browserRegistry.closeAll().catch(() => undefined);
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    void gracefulShutdown();
  });
  process.on("SIGINT", () => {
    void gracefulShutdown();
  });

  pauseGate.on((req) => {
    const owner = (req.payload as { sessionName?: string }).sessionName;
    const originatingTab = activeRunningTab();
    const tab = owner
      ? originatingTab?.currentSession === owner
        ? originatingTab
        : undefined
      : originatingTab;
    const tabId = tab?.id;
    if (tab) tab.pendingGateIds.add(req.id);
    // Shared auto-resolve policy (e.g. plan_checkpoint in auto/yolo) — must
    // still run BEFORE we emit any UI event, otherwise the surface flickers
    // a card that we'd immediately tear down.
    const auto = autoResolveVerdict(req, loadEditMode(), {
      enableChoiceTimer: loadQuestionTimerEnabled(),
    });
    if (auto?.kind === "instant") {
      // Plan state is written by the tools themselves; the daemon only projects
      // it (see the tool-result handler) — no tab mirror to keep in sync here.
      if (tab) tab.pendingGateIds.delete(req.id);
      pauseGate.resolve(req.id, auto.verdict);
      return;
    }
    // YOLO interactive gates: surface the picker so a watching user can override
    // the default. Keep a backend timer as the source of eventual resolution;
    // the frontend mirrors it for visible countdown feedback and resolves first
    // when the user picks manually. The card's timer toggle drives this handle
    // via `gate_timer`, so pausing the UI clock also pauses auto-resolve.
    if (auto?.kind === "countdown") {
      armGateCountdown(req.id, auto.verdict, auto.ms);
    }
    // One spread for every picker: the card and the backend timer both read
    // `countdownMs`, so the field is attached in exactly one place.
    const countdown = auto?.kind === "countdown" ? { countdownMs: auto.ms } : {};
    if (
      req.kind === "run_command" ||
      req.kind === "run_background" ||
      req.kind === "outlook_send"
    ) {
      const payload = req.payload as {
        command?: string;
        cwd?: string;
        timeoutSec?: number;
        waitSec?: number;
      };
      emit(
        {
          type: "$confirm_required",
          id: req.id,
          kind: req.kind,
          command: payload.command ?? "",
          prompt: toApprovalPrompt({
            id: req.id,
            kind: req.kind,
            payload:
              tab && req.kind !== "outlook_send"
                ? {
                    ...payload,
                    coveredScopes: coveredRuleScopes("shell", payload.command ?? "", tab.rootDir),
                  }
                : payload,
          }),
        },
        tabId,
      );
      return;
    }
    if (req.kind === "path_access") {
      const payload = req.payload as {
        path: string;
        intent: "read" | "write";
        toolName: string;
        sandboxRoot: string;
        allowPrefix: string;
      };
      emit(
        {
          type: "$path_access_required",
          id: req.id,
          path: payload.path,
          intent: payload.intent,
          toolName: payload.toolName,
          sandboxRoot: payload.sandboxRoot,
          allowPrefix: payload.allowPrefix,
          prompt: toApprovalPrompt({
            id: req.id,
            kind: req.kind,
            payload: tab
              ? {
                  ...payload,
                  coveredScopes: coveredRuleScopes("path", payload.allowPrefix, tab.rootDir),
                }
              : payload,
          }),
        },
        tabId,
      );
      return;
    }
    if (req.kind === "edit") {
      const payload = req.payload as {
        path: string;
        toolName: string;
        sandboxRoot: string;
        allowPrefix: string;
        preview?: string;
      };
      emit(
        {
          type: "$edit_required",
          id: req.id,
          path: payload.path,
          toolName: payload.toolName,
          sandboxRoot: payload.sandboxRoot,
          allowPrefix: payload.allowPrefix,
          preview: payload.preview,
          prompt: toApprovalPrompt({
            id: req.id,
            kind: req.kind,
            payload: tab
              ? {
                  ...payload,
                  coveredScopes: coveredRuleScopes("path", payload.allowPrefix, tab.rootDir),
                }
              : payload,
          }),
        },
        tabId,
      );
      return;
    }
    if (req.kind === "choice") {
      const payload = req.payload as {
        question: string;
        options: ChoiceOption[];
        allowCustom: boolean;
      };
      emit(
        {
          type: "$choice_required",
          id: req.id,
          question: payload.question,
          options: payload.options,
          allowCustom: payload.allowCustom,
          ...countdown,
        },
        tabId,
      );
      return;
    }
    if (req.kind === "plan_proposed") {
      const payload = req.payload as {
        plan: string;
        steps?: PlanStep[];
        summary?: string;
        callId?: string;
      };
      emit(
        {
          type: "$plan_required",
          id: req.id,
          plan: payload.plan,
          steps: payload.steps,
          summary: payload.summary,
          callId: payload.callId,
          ...countdown,
        },
        tabId,
      );
      return;
    }
    if (req.kind === "plan_checkpoint") {
      const payload = req.payload as {
        stepId: string;
        title?: string;
        result: string;
        notes?: string;
      };
      if (tab) refreshPlanSummary(tab);
      emit(
        {
          type: "$checkpoint_required",
          id: req.id,
          stepId: payload.stepId,
          title: payload.title,
          result: payload.result,
          notes: payload.notes,
          completed: tab ? tab.planSummary.completed : 0,
          total: tab ? tab.planSummary.total : 0,
        },
        tabId,
      );
      return;
    }
    if (req.kind === "plan_revision") {
      const payload = req.payload as {
        reason: string;
        remainingSteps: PlanStep[];
        previousSteps?: PlanStep[];
        summary?: string;
      };
      emit(
        {
          type: "$revision_required",
          id: req.id,
          reason: payload.reason,
          remainingSteps: payload.remainingSteps,
          previousSteps: payload.previousSteps,
          summary: payload.summary,
          ...countdown,
        },
        tabId,
      );
      return;
    }
    // Unknown PauseKind — `never` makes a new kind without a handler a compile
    // error; the runtime cancel is the last-mile defense so the agent loop
    // doesn't hang waiting on a request no one will resolve.
    const exhaustive: never = req.kind;
    process.stderr.write(
      `[desktop] no handler for pause kind "${String(exhaustive)}" — auto-cancelling gate id=${req.id}\n`,
    );
    if (tab) tab.pendingGateIds.delete(req.id);
    pauseGate.cancel(req.id);
  });

  // Fast-path: emit disk-only events immediately so the UI shell renders
  // before the toolset finishes building. Heavy work (MCP probes, runtime
  // construction) runs in initTabToolset which fires
  // `$ready` when it completes — until then `state.ready` keeps the
  // composer disabled, so users can't send a message before the runtime
  // exists. emitBalance was already fire-and-forget.
  type TabRestore = {
    id?: string;
    session?: string;
    /** Persisted with no session bound: restore it neutral instead of minting. */
    detached?: boolean;
    active?: boolean;
    groupId?: string;
    pending?: boolean;
    /** Explicit model prefs for a fresh channel (New chat) so the new tab
     *  inherits the current session's models instead of the global default. */
    model?: string;
    reasoningEffort?: import("../../config.js").ReasoningEffort;
    subagentModel?: string;
    /** Marks this channel as a just-minted session so the frontend shows a
     *  "Creating session…" indicator until the first `$sessions` lands. */
    creating?: boolean;
  };

  /** Announcing is the cheap half of opening a tab: skeleton plus `$tab_opened`.
   *  Split out so a restored set is announced in one burst before any tab's
   *  disk work starts. */
  function announceTab(initialDir?: string, restore?: TabRestore): Tab {
    const tab = createTabSkeleton(initialDir, restore?.id, restore, restore?.pending ?? false);
    emitTabDiagnostic(
      tab,
      "tab.bootstrap.requested",
      {
        restoredId: restore?.id ?? null,
        restoredSession: restore?.session ?? null,
        active: restore?.active ?? false,
      },
      "info",
    );
    // Announce before anything else: the UI shell mounts on this event, and the
    // deferred work lives in startTabInit so a restored set is announced in one
    // burst instead of one tab per macrotask.
    emitTabOpened(tab, restore?.active, restore?.creating);
    // A pending (workspace-less) tab has no session, toolset, hooks or sidebar
    // to build — it exists only so the UI can prompt for a workspace. Assigning
    // one runs switchWorkspace, which does the full build. Do NOT emit $ready,
    // so the composer stays disabled until a workspace is chosen.
    if (tab.pending) {
      emitSettings(tab);
      void emitWorkspaceInitialized(tab, Promise.resolve());
      emitTabDiagnostic(tab, "tab.bootstrap.pending", undefined, "info");
    }
    return tab;
  }

  /** Starts an announced tab's deferred work: settings/MCP/skills projections,
   *  the session restore and the toolset build. It yields before touching disk so
   *  a caller's announce burst is never blocked by one tab's I/O. */
  function startTabInit(tab: Tab, restore?: TabRestore): void {
    // A pending tab has nothing to initialize: announceTab already surfaced its
    // settings and cleared the splash gate for it.
    if (tab.pending) return;
    void (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      emitSettings(tab);
      emitMcpSpecs(tab);
      emitSkills(tab);
      // Restore the conversation's stored model/effort FIRST — it's a cheap
      // meta.json read, but the runtime (built inside initTabToolset) reads
      // `tab.currentModel` / `tab.currentSession` at build time, so it must
      // see the restored pair before the toolset build starts.
      if (restore?.session) {
        try {
          if (sessionExists(restore.session)) {
            tab.currentSession = restore.session;
            freezeLegacySessionMcp(tab, tab.currentSession);
            restoreSessionModelPrefs(tab, loadSessionMeta(tab.currentSession));
          }
        } catch (err) {
          // unreadable meta — fall back to the freshly minted session, but LOG
          emitDiagnosticError("session.restore.failed", err, {
            tabId: tab.id,
            details: { requestedSession: restore.session, ...tabDiagnosticState(tab) },
          });
          process.stderr.write(`reasonix: session load for resync failed — ${messageOf(err)}\n`);
        }
      }

      // Emit the credential gate up front too — `$needs_setup` is the other
      // side of `$ready` and must not wait on the session read either.
      if (!tabHasCredential(tab)) {
        emitTabDiagnostic(tab, "tab.setup.required", { reason: "credential-unavailable" }, "warn");
        emit({ type: "$needs_setup", reason: "no_api_key" }, tab.id);
      }

      // Start the toolset/runtime build before the display work below: `$ready`
      // (the composer's enable gate) must not depend on the full current-session
      // jsonl read+parse or the session-index scan, which serve only the sidebar
      // and the conversation view. Because that display work is no longer gated
      // on this build, `$session_loaded` can now precede `$ready`; the reducer
      // treats the two events independently, so either order is valid.
      //
      // Background tabs queue their build behind the focused one: the gate runs
      // builds on the single JS thread, so letting every restored tab register
      // alongside it interleaved ~N synchronous registrations into the boot
      // critical path. Total work is unchanged; it just no longer competes with
      // the tab the splash is waiting for.
      //
      // A restored channel the user is not looking at defers its build to first
      // activation: 96 restored tabs registered 96 toolsets (~11 s of synchronous
      // work) before the app could be used, and the tail ran for a minute.
      const deferredBuild = shouldDeferRestoredBuild({
        restored: restore !== undefined,
        focused: tab === first,
        active: restore?.active,
        mcpSetupPending: tab.mcpSetupPending,
      });
      const startToolset = async (): Promise<void> => {
        if (tab !== first) await firstBootstrapSettled;
        if (deferredBuild) return;
        await initTabToolset(tab, 1);
      };
      tab.initialization = startToolset()
        .then(() => {
          if (tab.mcpSetupPending) {
            // Composer stays disabled until `mcp_session_configure`; surface the picker.
            armSessionGate(tab);
          } else if (deferredBuild) {
            // The activation path builds the toolset and answers with `$ready`.
            emitTabDiagnostic(tab, "tab.ready.deferred", undefined, "info");
          } else if (tabHasCredential(tab)) {
            emitTabDiagnostic(tab, "tab.ready", undefined, "info");
            emit({ type: "$ready" }, tab.id);
            if (tab === first) {
              markPhase("first_tab_ready_emitted");
              dumpStartupProfile();
            }
          } else {
            emitTabDiagnostic(
              tab,
              "tab.ready.skipped",
              { reason: "credential-unavailable" },
              "warn",
            );
          }
          emitCtxBreakdown(tab);
          if (tab === first) settleFirstBootstrap();
        })
        .catch((err) => {
          emitDiagnosticError("tab.bootstrap.failed", err, {
            tabId: tab.id,
            details: tabDiagnosticState(tab),
          });
          emit({ type: "$error", message: `init failed: ${(err as Error).message}` }, tab.id);
          if (tab === first) settleFirstBootstrap();
        });

      // Display work is NOT gated on the focused tab's toolset. The session
      // list and the transcript are what the user actually sees, and serializing
      // them behind one tab's build made every restored tab appear in turn; they
      // only have to interleave with the gate above, not wait for it.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Non-gating display work — runs in parallel with the toolset build above.
      // Reopen the conversation the tab had, if its jsonl is still readable.
      let restoredMessages: LoadedMessage[] | undefined;
      if (restore?.session) {
        try {
          if (sessionExists(restore.session)) {
            const msgs = mergeNoticesIntoLoaded(
              buildLoadedMessages(await loadSessionMessagesAsync(restore.session)),
              loadSessionNotices(restore.session),
              loadSessionMeta(restore.session).lastTurn,
            );
            if (msgs.length > 0) restoredMessages = msgs;
          }
        } catch (err) {
          // unreadable jsonl — fall back to the freshly minted session, but LOG
          emitDiagnosticError("session.restore.failed", err, {
            tabId: tab.id,
            details: { requestedSession: restore.session, ...tabDiagnosticState(tab) },
          });
          process.stderr.write(`reasonix: session load for resync failed — ${messageOf(err)}\n`);
        }
      }
      emitTabDiagnostic(tab, "tab.bootstrap.session-state", {
        restored: restoredMessages !== undefined,
        restoredMessages: restoredMessages?.length ?? 0,
      });
      if (tab.currentSession) {
        patchSessionWorkspaceIfMissing(tab.currentSession, tab.rootDir);
        // Repair a session that materialized without a workspace stamp (see
        // stampSessionWorkspace) so a restored ghost lists on the emitSessions below.
        stampSessionWorkspace(tab.currentSession, tab.rootDir);
      }
      const sessionsInitialized = emitSessions(tab, undefined, { primeFromCache: true });
      // A freshly minted session must reach every channel on the workspace at once,
      // the way a delete already does; a restored tab broadcasts nothing.
      if (!restore) emitSessionsForWorkspace(tab.rootDir, undefined, { exceptTabId: tab.id });
      if (restore?.creating) {
        // The minted session is on the wire now, so every channel can see it and
        // the workspace accepts another creation. Both outcomes release: a failed
        // listing must not keep the gate shut until the toolset build ends.
        const release = () => sessionCreationGate.leave(tab.rootDir);
        void sessionsInitialized.then(release, release);
      }
      emitMemory(tab);
      if (restoredMessages) {
        const meta = loadSessionMeta(tab.currentSession);
        const paged = sessionWindow(restoredMessages, 0);
        emit(
          {
            type: "$session_loaded",
            name: tab.currentSession,
            messages: paged.page,
            hasOlder: paged.hasOlder,
            turnBase: paged.turnBase,
            events: loadSessionEvents(tab.currentSession),
            carryover: sessionCarryover(meta),
          },
          tab.id,
        );
      } else if (tab.currentSession) {
        emit(
          {
            type: "$session_loaded",
            name: tab.currentSession,
            messages: [],
            events: [],
            carryover: emptySessionCarryover(),
          },
          tab.id,
        );
      }
      // Every $session_loaded is followed by its plan projection, so a cold-start
      // tab restores its plan history and active plan without waiting on resync
      // (and a late duplicate $session_loaded can no longer wipe it).
      emitRestoredPlan(tab, restoredMessages !== undefined);
      await emitWorkspaceInitialized(tab, sessionsInitialized);
      void refreshFunds(tab);
    })().catch((err) => {
      // This display work sits outside tab.initialization, so without a catch a
      // throw here would vanish as an unhandled rejection instead of a diagnostic.
      emitDiagnosticError("tab.bootstrap.display_failed", err, {
        tabId: tab.id,
        details: tabDiagnosticState(tab),
      });
    });
  }

  /** One session creation at a time per workspace: a second one started before the
   *  first is listed would stack a duplicate session on the same directory. */
  const sessionCreationGate = newSessionCreationGate();

  /** Session deletes/clears in flight, so a workspace switch or forget cannot
   *  re-target the tab that is waiting for their settled snapshot. */
  const sessionWork = newWorkspaceSessionWork();

  /** True while this workspace is minting or removing a session: the window in
   *  which switching away from it or forgetting it is undocumented behaviour. */
  function workspaceSessionBusy(workspaceDir: string): boolean {
    return sessionCreationGate.isBusy(workspaceDir) || sessionWork.isBusy(workspaceDir);
  }

  /** The one refusal shape for a locked session/workspace operator, so the wording
   *  and the channel it lands on cannot drift between them. */
  function refuseSessionMutation(message: string, tabId?: string): void {
    emit({ type: "$notice", text: message, severity: "warning" }, tabId);
  }

  /** Arms the open gate's release for a just-bootstrapped channel. The gate reopens
   *  when that channel publishes its session list (startTabInit), and unconditionally
   *  when its bootstrap settles — a failed create must never lock a workspace. */
  function armCreationRelease(tab: Tab): void {
    void tab.initialization?.finally(() => sessionCreationGate.leave(tab.rootDir));
  }

  /** Announce a tab and start its deferred work — every caller but the restored-
   *  set loop wants both halves at once. */
  function bootstrapTab(initialDir?: string, restore?: TabRestore): Tab {
    const tab = announceTab(initialDir, restore);
    startTabInit(tab, restore);
    return tab;
  }

  // Restore the full tab set from the previous session — workspace dir,
  // loaded session and focused tab (issues #933, #1244). Missing dirs
  // are silently skipped — a deleted workspace shouldn't break boot.
  const savedTabs = normalizeWorkspaceTabGroups(
    loadDesktopOpenTabs()
      .map((t) => {
        if (sameWorkspaceDir(t.dir, reasonixInstallDir())) {
          return { ...t, dir: reasonixDefaultWorkspaceDir() };
        }
        return t;
      })
      .filter((t) => {
        try {
          return existsSync(t.dir) && statSync(t.dir).isDirectory();
        } catch {
          return false;
        }
      }),
  );
  // Never restore the same session into two channels — a session is a single
  // agent. Keep the first occurrence's session; later duplicates open fresh.
  const seenRestoreSessions = new Set<string>();
  const dedupedTabs = savedTabs.map((t) => {
    if (!t.session) return t;
    if (seenRestoreSessions.has(t.session)) return { ...t, session: undefined };
    seenRestoreSessions.add(t.session);
    return t;
  });
  // When launched with --dir, find the matching saved tab so the user's
  // previous session is restored automatically.
  const startupDir = opts.dir;
  const startupTab = startupDir
    ? dedupedTabs.find((t) => sameWorkspaceDir(t.dir, startupDir))
    : dedupedTabs[0];
  const pendingRestores = dedupedTabs.filter((t) => t !== startupTab);
  try {
    first = bootstrapTab(opts.dir ?? dedupedTabs[0]?.dir, startupTab);
  } catch (err) {
    // A workspace can vanish between the stat above and the skeleton build (or the
    // session mint can fail): fall back to a fresh tab so boot still completes.
    emitDiagnosticError("tabs.restore.focused_failed", err, {
      details: { workspaceDir: startupTab?.dir ?? null },
    });
    first = bootstrapTab(undefined, { active: true });
  }
  lastActiveTabId = first.id;
  // Announce the whole restored set BEFORE initializing any of it. Announcing and
  // starting the deferred work in one loop let each tab's $settings/$sessions
  // emission and toolset build run between two `$tab_opened` events, so the
  // ribbon filled one tab at a time over seconds. The macrotask yield between
  // skeletons stays: building the whole set synchronously starved the event loop.
  void (async () => {
    const announced: Array<{ tab: Tab; restore: TabRestore }> = [];
    try {
      for (const saved of pendingRestores) {
        try {
          announced.push({ tab: announceTab(saved.dir, saved), restore: saved });
        } catch (err) {
          // One unreadable workspace must not strand the rest of the set: a deleted
          // dir, a malformed hook file and a failed session mint all land here.
          emitDiagnosticError("tabs.restore.announce_failed", err, {
            details: { workspaceDir: saved.dir },
          });
          process.stderr.write(
            `reasonix: tab restore failed for ${saved.dir} — ${messageOf(err)}\n`,
          );
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      emitTabsSnapshot();
      persistOpenTabs();
    } finally {
      // Released before the inits below: a resync waiting here needs only the tab
      // SET, and holding it for every toolset build would delay its snapshot.
      announceBurstDone = true;
      settleAnnounceBurst();
    }
    for (const { tab, restore } of announced) {
      startTabInit(tab, restore);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  // Account-wide quotas change underneath us (other devices, window resets) — poll
  // so the statusbar chips are never stale, and never mid-turn (the $turn_complete
  // fetch is the authoritative turn-cost measurement). The tick is the shortest
  // declared floor, so each provider is read exactly as often as its own file says:
  // the coordinators refuse a read that is not yet due. Pauses after 15 minutes of
  // idle to conserve bandwidth on metered connections.
  const QUOTA_POLL_INTERVAL_MS = 30 * 1000;
  const QUOTA_POLL_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
  let lastUserActivityAt = Date.now();
  let quotaPolling = false;
  quotaTimer = setInterval(() => {
    if (quotaPolling) return;
    if (Date.now() - lastUserActivityAt > QUOTA_POLL_IDLE_TIMEOUT_MS) {
      emitDiagnostic("quota.poll.skipped", {
        reason: "user-idle",
        idleMs: Date.now() - lastUserActivityAt,
      });
      return;
    }
    for (const t of tabs.values()) {
      if (t.aborter) {
        emitTabDiagnostic(t, "quota.poll.skipped", { reason: "turn-in-progress" });
        return;
      }
    }
    const tab = tabs.get(lastActiveTabId);
    if (!tab) {
      emitDiagnostic("quota.poll.skipped", {
        reason: "active-tab-not-found",
        activeTabId: lastActiveTabId,
      });
      return;
    }
    emitTabDiagnostic(tab, "quota.poll.started", { intervalMs: QUOTA_POLL_INTERVAL_MS });
    quotaPolling = true;
    void refreshFunds(tab).finally(() => {
      quotaPolling = false;
      emitTabDiagnostic(tab, "quota.poll.completed");
    });
  }, QUOTA_POLL_INTERVAL_MS);

  const rl = createInterface({ input: stdin });
  emit({ type: "$connected" });
  markPhase("rpc_stdin_listening");
  rl.on("line", (line) => {
    lastUserActivityAt = Date.now();
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: InMessage;
    try {
      msg = JSON.parse(trimmed) as InMessage;
    } catch (err) {
      emitDiagnosticError("rpc.stdin.invalid-json", err, {
        details: { inputChars: trimmed.length, previewChars: Math.min(trimmed.length, 80) },
      });
      emit({ type: "$error", message: `bad json on stdin: ${trimmed.slice(0, 80)}` });
      return;
    }
    emitDiagnostic("rpc.command.received", {
      command: msg.cmd,
      tabId: "tabId" in msg ? (msg.tabId ?? null) : null,
    });

    if (msg.cmd === "tab_open") {
      try {
        // A workspace may appear in the ribbon only once. Opening an already-
        // visible workspace adds a fresh independent session to that tab.
        //
        // No workspace → a PENDING tab. It must not default to the local
        // install dir: that merged every new tab into the existing "Reasonix+
        // Local" workspace group, so a second tab could never exist. The UI
        // instead prompts for a workspace (local / recent / browse) and
        // assigning one runs switchWorkspace.
        const target = msg.workspaceDir ? resolve(msg.workspaceDir) : undefined;
        const existing = target ? workspaceTabFor(target) : undefined;
        // Cap the tab set: the desktop keeps every tab's transcript and runtime
        // alive, so an unbounded set is the fastest way to exhaust the webview.
        let evictionNote = "";
        if (tabs.size >= MAX_OPEN_TABS) {
          const victim = idleTabToEvict();
          if (!victim) {
            emit(
              {
                type: "$notice",
                text: `Tab limit reached (${MAX_OPEN_TABS}); every other tab is running an agent.`,
                severity: "warning",
              },
              msg.tabId,
            );
            return;
          }
          evictionNote = `Closed ${tabLabel(victim)} to stay within ${MAX_OPEN_TABS} open tabs.`;
          void closeWorkspaceTab(victim, { persist: false });
        }
        const opened = target
          ? bootstrapTab(target, { active: true, groupId: existing?.groupId })
          : bootstrapTab(undefined, { active: true, pending: true });
        lastActiveTabId = opened.id;
        markTabFocused(opened.id);
        persistOpenTabs();
        if (evictionNote)
          emit({ type: "$notice", text: evictionNote, severity: "info" }, opened.id);
      } catch (err) {
        emitDiagnosticError("tab.open.failed", err);
        emit({ type: "$error", message: `tab_open failed: ${(err as Error).message}` });
      }
      return;
    }
    if (msg.cmd === "tab_activate") {
      const activated = tabs.get(msg.tabId);
      if (activated) {
        emitTabDiagnostic(
          activated,
          "tab.activated",
          { previousActiveTabId: lastActiveTabId },
          "info",
        );
        lastActiveTabId = msg.tabId;
        markTabFocused(msg.tabId);
        persistOpenTabs();
        // Refetch immediately — the tab may have sat idle for hours, and
        // the statusbar must show the current quota the moment it's shown.
        void refreshFunds(activated, { force: true });
        // Lazily bridge MCP on first activation: non-focused restored tabs skip
        // the per-tab MCP tool registration at startup and pay it only when the
        // user actually opens them.
        ensureActiveToolset(activated);
        if (activated.toolset && !activated.mcpRuntime) void bridgeTabMcp(activated);
        void emitSessions(activated);
      } else {
        emitDiagnostic(
          "tab.activate.failed",
          { tabId: msg.tabId },
          {
            level: "error",
            message: "tab activation requested for an unknown tab",
          },
        );
      }
      return;
    }
    if (msg.cmd === "confirm_response") {
      clearGateCountdown(msg.id);
      const tab = forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      // An always_allow persists a rule inside the tool that is still resuming, so
      // re-emit a macrotask later — after that synchronous config write — or the
      // panel keeps showing the rule lists it had before the click.
      if (tab && msg.response.type === "always_allow") {
        setTimeout(() => emitSettings(tab), 0);
      }
      return;
    }
    if (msg.cmd === "choice_response") {
      clearGateCountdown(msg.id);
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "plan_response") {
      clearGateCountdown(msg.id);
      const tab = forgetGate(msg.id);
      if (tab && msg.response.type === "cancel") {
        // submit_plan records the cancelled verdict itself; just clear the rail.
        refreshPlanSummary(tab);
        emit({ type: "$plan_cleared" }, tab.id);
      }
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "checkpoint_response") {
      clearGateCountdown(msg.id);
      forgetGate(msg.id);
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "revision_response") {
      clearGateCountdown(msg.id);
      const tab = forgetGate(msg.id);
      // revise_plan records the accepted revision itself; nothing to mirror here.
      pauseGate.resolve(msg.id, msg.response);
      return;
    }
    if (msg.cmd === "gate_timer") {
      // Card toggled its countdown: keep the backend timer from resolving the
      // gate out from under the UI (or re-arm it when the timer is switched on).
      if (msg.enabled) resumeGateCountdown(msg.id);
      else suspendGateCountdown(msg.id);
      return;
    }
    if (msg.cmd === "setup_save_key") {
      const key = msg.key.trim();
      if (key && !isPlausibleKey(key)) {
        emit({
          type: "$error",
          message: "Key looks too short — paste the full token (16+ chars, no spaces).",
        });
        return;
      }
      try {
        saveApiKey(key);
        bridgeEndpointEnv();
        void refreshProviderCatalogs(true);
        for (const tab of tabs.values()) {
          // Skeleton tabs still mid-bootstrap pick up the new key inside
          // initTabToolset's tail when buildCodeToolset settles — don't
          // try to construct a runtime against a null toolset here.
          if (!tab.toolset) {
            emitSettings(tab);
            void emitBalance(tab);
            continue;
          }
          tab.runtime = tabCurrentModelUsable(tab) ? buildRuntimeFor(tab) : null;
          if (tab.runtime) emit({ type: "$ready" }, tab.id);
          emitSettings(tab);
          void emitBalance(tab);
        }
      } catch (err) {
        emit({ type: "$error", message: `saveApiKey failed: ${(err as Error).message}` });
      }
      return;
    }

    if (msg.cmd === "desktop_resync") {
      // WebView reloads keep the daemon alive, so replay transport state and
      // cheap tab state first. Disk scans are deferred until startup settles.
      emit({ type: "$connected" });
      // Publish the authoritative tab set FIRST: the frontend needs it to know
      // which workspaces to expect, and the per-tab settings/MCP/skills
      // re-emission below is synchronous and non-trivial for large tab sets —
      // doing it before the snapshot delayed the frontend's startup bookkeeping.
      publishTabsSnapshot();
      if (msg.replay === false) {
        refreshLaunchCatalogs();
        return;
      }
      // Replay per-tab state in yielding batches. Emitting $settings + MCP +
      // skills for every tab in one synchronous loop froze the event loop long
      // enough to starve tab creation and the toolset gate — the bulk of the
      // "Loading workspaces" delay. Yielding every few tabs keeps the loop live.
      void (async () => {
        let n = 0;
        for (const t of tabs.values()) {
          emitTabOpened(t, t.id === lastActiveTabId);
          emitSettings(t);
          if (!t.pending) {
            emitMcpSpecs(t);
            emitSkills(t);
            if (!tabHasCredential(t)) emit({ type: "$needs_setup", reason: "no_api_key" }, t.id);
            else if (t.toolset) emit({ type: "$ready" }, t.id);
          }
          if ((n++ & 3) === 3) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })();
      void firstBootstrapSettled.then(() => {
        for (const t of tabs.values()) {
          if (t.pending) {
            void emitWorkspaceInitialized(t, Promise.resolve());
            continue;
          }
          const sessionsInitialized = emitSessions(t);
          emitMemory(t);
          void emitBalance(t);
          // Restoring the transcript is display work and must NOT gate
          // $workspace_initialized (and therefore the "Loading workspaces"
          // splash). Awaiting it here made the splash wait for every restored
          // tab's session file to be read and parsed, one after another.
          void (async () => {
            if (t.currentSession) {
              try {
                const meta = loadSessionMeta(t.currentSession);
                const msgs = mergeNoticesIntoLoaded(
                  buildLoadedMessages(await loadSessionMessagesAsync(t.currentSession)),
                  loadSessionNotices(t.currentSession),
                  meta.lastTurn,
                );
                const paged = sessionWindow(msgs, 0);
                emit(
                  {
                    type: "$session_loaded",
                    name: t.currentSession,
                    messages: paged.page,
                    hasOlder: paged.hasOlder,
                    turnBase: paged.turnBase,
                    events: loadSessionEvents(t.currentSession),
                    carryover: sessionCarryover(meta),
                    resync: true,
                  },
                  t.id,
                );
                emitRestoredPlan(t, msgs.length > 0);
              } catch (err) {
                emitDiagnosticError("session.resync.failed", err, {
                  tabId: t.id,
                  details: tabDiagnosticState(t),
                });
                process.stderr.write(
                  `reasonix: session load for resync failed — ${messageOf(err)}\n`,
                );
                emit(
                  {
                    type: "$session_loaded",
                    name: t.currentSession,
                    messages: [],
                    events: [],
                    carryover: emptySessionCarryover(),
                    resync: true,
                  },
                  t.id,
                );
                emit({ type: "$error", message: `session resync failed: ${messageOf(err)}` }, t.id);
              }
            }
            emitCtxBreakdown(t);
          })();
          void emitWorkspaceInitialized(t, sessionsInitialized);
        }
      });
      // Unconditional: even a tab on a DeepSeek/OpenAI model benefits when a local
      // Ollama daemon is up, and a failure only surfaces on the Models settings
      // page (the composer hides the error unless the tab's model is Ollama).
      refreshLaunchCatalogs();
      return;
    }
    if (msg.cmd === "jobs_list") {
      emitJobs();
      return;
    }
    if (msg.cmd === "jobs_stop") {
      void stopJob(msg.jobId, msg.tabId).finally(() => emitJobs());
      return;
    }
    if (msg.cmd === "jobs_stop_all") {
      void stopAllJobs().finally(() => emitJobs());
      return;
    }
    if (msg.cmd === "workspace_recent_remove") {
      if (workspaceSessionBusy(msg.path)) {
        // Forget closes every tab on the path, including the channel waiting for
        // a create/delete settle. Refuse before any teardown starts.
        refuseSessionMutation(WORKSPACE_REMOVE_BLOCKED_MESSAGE, msg.tabId);
        return;
      }
      try {
        removeRecentWorkspace(msg.path);
        const targetPath = resolve(msg.path.trim());
        const matchingTabs = Array.from(tabs.values()).filter(
          (t) => resolve(t.rootDir) === targetPath || t.rootDir === msg.path.trim(),
        );
        if (matchingTabs.length > 0) {
          if (tabs.size <= matchingTabs.length) {
            const clean = bootstrapTab(undefined, { active: true });
            first = clean;
            lastActiveTabId = clean.id;
          }
          const groups = new Set(matchingTabs.map((t) => t.groupId));
          for (const groupId of groups) {
            const workspaceTab = Array.from(tabs.values()).find((t) => t.groupId === groupId);
            if (workspaceTab) void closeWorkspaceTab(workspaceTab);
          }
        }
        persistOpenTabs();
        for (const openTab of tabs.values()) {
          emitSettings(openTab);
        }
      } catch (err) {
        emitDiagnosticError("workspace.recent.remove.failed", err);
        emit({
          type: "$error",
          message: `workspace_recent_remove failed: ${(err as Error).message}`,
        });
      }
      return;
    }

    const tab = msg.tabId ? tabs.get(msg.tabId) : first;
    if (!tab) {
      emitDiagnostic(
        "rpc.dispatch.unknown-tab",
        { tabId: msg.tabId ?? null, command: msg.cmd },
        { level: "error", message: "command dropped because the tab is unknown" },
      );
      if (msg.cmd === "tab_close" && msg.tabId) {
        // Ghost tab — id no longer known backend-side (re-minted after a
        // restart, or already closed). Ack the close so the frontend removes
        // it immediately instead of leaving a zombie until the next resync.
        emit({ type: "$tab_closed" }, msg.tabId);
        return;
      }
      // Unknown tabId — the renderer's per-tab router drops the event
      // silently. Surface to stderr instead so it's at least visible when
      // the desktop is launched from a terminal.
      process.stderr.write(
        `rpc dispatch: unknown tabId=${msg.tabId} for cmd=${msg.cmd} — dropping\n`,
      );
      return;
    }
    if (msg.cmd === "tab_status") {
      emit(tabStatus(tab));
      return;
    }

    if (msg.cmd === "abort") {
      emitTabDiagnostic(tab, "rpc.command.abort", undefined, "info");
      cancelConversation(tab, desktopUserAbortLoopOptions());
      return;
    }
    if (msg.cmd === "cancel_tool") {
      emitTabDiagnostic(tab, "rpc.command.cancel-tool", undefined, "info");
      cancelToolFromDesktop(
        tab.runtime?.loop,
        msg.callId,
        "User stopped the running command (desktop Stop button)",
      );
      return;
    }
    if (msg.cmd === "tab_close") {
      closeWorkspaceTab(tab).catch((err) => {
        emitDiagnosticError("tab.close.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        process.stderr.write(`reasonix: closeTab rejected — ${messageOf(err)}\n`);
      });
      return;
    }
    if (msg.cmd === "mcp_specs_get") {
      emitMcpSpecs(tab);
      return;
    }
    if (msg.cmd === "mcp_specs_add") {
      const spec = msg.spec.trim();
      if (!spec) {
        emit({ type: "$error", message: "mcp_specs_add: spec is empty" }, tab.id);
        return;
      }
      try {
        parseMcpSpec(spec);
      } catch (err) {
        emit({ type: "$error", message: `mcp_specs_add: ${(err as Error).message}` }, tab.id);
        return;
      }
      try {
        const cfg = readConfig();
        const list = cfg.mcp ?? [];
        if (!list.includes(spec)) {
          cfg.mcp = [...list, spec];
          writeConfig(cfg);
        }
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emitDiagnosticError("mcp.spec.add.failed", err, {
          tabId: tab.id,
          details: { specChars: spec.length, ...tabDiagnosticState(tab) },
        });
        emit({ type: "$error", message: `mcp_specs_add: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "mcp_specs_remove") {
      try {
        let parsedSpec: McpServerSpec | null = null;
        try {
          parsedSpec = parseMcpSpec(msg.spec);
        } catch (err) {
          emitDiagnosticError("mcp.spec.parse.ignored", err, {
            tabId: tab.id,
            details: { spec: msg.spec },
          });
        }
        if (parsedSpec && isManagedMcpSpec(parsedSpec)) {
          emit(
            {
              type: "$error",
              message: "mcp_specs_remove: Reasonix+ managed MCP servers can't be removed",
            },
            tab.id,
          );
          return;
        }
        const cfg = readConfig();
        let changed = false;
        const list = cfg.mcp ?? [];
        if (list.includes(msg.spec)) {
          cfg.mcp = list.filter((s) => s !== msg.spec);
          changed = true;
        }
        const parsedName = parsedSpec?.name ?? null;
        if (parsedName && cfg.mcpServers && parsedName in cfg.mcpServers) {
          delete cfg.mcpServers[parsedName];
          changed = true;
        }
        if (changed) writeConfig(cfg);
        tab.mcpStatuses.delete(msg.spec);
        if (parsedName) tab.mcpStatuses.delete(parsedName);
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emitDiagnosticError("mcp.spec.remove.failed", err, {
          tabId: tab.id,
          details: { specChars: msg.spec.length, ...tabDiagnosticState(tab) },
        });
        emit({ type: "$error", message: `mcp_specs_remove: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "mcp_specs_toggle") {
      // Edits the Settings DEFAULT (server-level). Takes effect for NEW chats only —
      // a live session's server set is frozen at chat creation, so this never
      // re-bridges the current session.
      try {
        const cfg = readConfig();
        const ok = setMcpServerDisabled(cfg, msg.name, msg.disabled);
        if (!ok) {
          emit(
            { type: "$error", message: `mcp_specs_toggle: unknown server "${msg.name}"` },
            tab.id,
          );
          return;
        }
        writeConfig(cfg);
        emitMcpSpecs(tab);
      } catch (err) {
        emitDiagnosticError("mcp.spec.toggle.failed", err, {
          tabId: tab.id,
          details: { name: msg.name, disabled: msg.disabled },
        });
        emit({ type: "$error", message: `mcp_specs_toggle: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "mcp_session_configure") {
      // Only a chat still awaiting setup may be configured; a repeat/duplicate
      // confirm is a no-op because the first call already cleared the flag.
      if (!tab.currentSession || !tab.mcpSetupPending) return;
      try {
        // Freeze this chat's capabilities — the MCP set and the subagent flag.
        // Immutable from here on.
        const subagents = msg.subagents === true;
        patchSessionMeta(tab.currentSession, {
          ...sessionSetupMeta(
            namedMcpSpecs(tab.rootDir).map((spec) => spec.name),
            msg.enabled,
            subagents,
          ),
          // An explicit `undefined` is dropped on write, clearing the pending marker.
          mcpPending: undefined,
        });
        tab.mcpSetupPending = false;
        // Bind before the runtime exists: the spawn tool and its prompt section have
        // to be in the prefix `unlock` builds.
        bindSessionSubagents(tab, subagents);
        // The answer is now frozen into the session, so the composer must learn it
        // before it renders (its subagent model picker keys off `$settings.subagents`).
        emitSettings(tab);
        emitMcpSpecs(tab);
        const unlock = (): void => {
          if (tabCurrentModelUsable(tab) && tab.toolset && !tab.runtime) {
            bridgeEndpointEnv();
            tab.runtime = buildRuntimeFor(tab);
            emitTabDiagnostic(tab, "tab.runtime.ready", undefined, "info");
          }
          if (tabHasCredential(tab)) {
            emitTabDiagnostic(tab, "tab.ready", undefined, "info");
            emit({ type: "$ready" }, tab.id);
          } else {
            // The picker is answered either way: without a credential the tab lands on
            // the setup screen, and only `$needs_setup` tells the frontend to stop
            // waiting for a `$ready` that is never coming.
            emit({ type: "$needs_setup", reason: "no_api_key" }, tab.id);
          }
          emitCtxBreakdown(tab);
        };
        if (!tab.toolset) {
          unlock();
          return;
        }
        // Bridge the confirmed servers BEFORE building the prefix so the frozen tool
        // set is present from the first turn (no addTool churn). A server that fails to
        // connect must not block the chat, so a bridge rejection still unlocks; only a
        // failure to unlock re-arms the gate.
        void bridgeTabMcp(tab)
          .catch((err) => {
            emitDiagnosticError("mcp.session.bridge.failed", err, {
              tabId: tab.id,
              details: tabDiagnosticState(tab),
            });
          })
          .then(unlock)
          .catch((err) => failSessionSetup(tab, err));
      } catch (err) {
        failSessionSetup(tab, err);
      }
      return;
    }
    if (msg.cmd === "mcp_session_cancel") {
      // Only a chat still awaiting setup can be cancelled. This closes just the
      // channel (its session), NOT the whole workspace tab. `closeChannel` also
      // discards the never-confirmed session.
      if (!tab.mcpSetupPending || !tab.currentSession) return;
      const sibling = channelsInWorkspaceTab(Array.from(tabs.values()), tab).find(
        (channel) => channel.id !== tab.id,
      );
      // Focus the sibling FIRST: otherwise $tab_closed bounces the active tab to
      // an arbitrary remaining one instead of keeping the user in place.
      if (sibling) focusSessionChannel(sibling);
      closeChannel(tab).catch((err) => {
        emitDiagnosticError("mcp.session.cancel.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
      });
      return;
    }
    if (msg.cmd === "mcp_extension_status") {
      emitMcpExtensionStatus(tab);
      return;
    }
    if (msg.cmd === "mail_provider_set") {
      try {
        saveMailProvider(msg.provider);
        pruneUnselectedMailServer(msg.provider);
        emitSettings(tab);
        emitMcpSpecs(tab);
        void bridgeTabMcp(tab).then(() => refreshMailAuth(tab, msg.provider, bridgeTabMcp));
      } catch (error) {
        emit({ type: "$error", message: `mail_provider_set: ${messageOf(error)}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "mail_status") {
      void refreshMailAuth(tab, msg.provider, bridgeTabMcp);
      return;
    }
    if (msg.cmd === "mail_configure") {
      try {
        if (msg.provider === MailProvider.Gmail) {
          const clientId = msg.clientId?.trim() ?? "";
          const clientSecret = msg.clientSecret?.trim() ?? "";
          if (!clientId || !clientSecret) {
            throw new Error("Enter both a Google OAuth client ID and client secret");
          }
          saveGmailOAuth({ clientId, clientSecret });
          configureGmailMailServer();
        } else {
          configureOutlookMailServer();
        }
        emitMcpSpecs(tab);
        emitMailAuth(tab, msg.provider, { configured: true, phase: "disconnected" });
        void bridgeTabMcp(tab).then(() => refreshMailAuth(tab, msg.provider, bridgeTabMcp));
      } catch (error) {
        emitMailAuth(tab, msg.provider, {
          configured: false,
          phase: "error",
          message: messageOf(error),
        });
      }
      return;
    }
    if (msg.cmd === "mail_connect") {
      void connectMail(tab, msg.provider, bridgeTabMcp);
      return;
    }
    if (msg.cmd === "mail_cancel") {
      cancelMailAuth(tab, msg.provider);
      emitMailAuth(tab, msg.provider, {
        configured:
          msg.provider === MailProvider.Gmail
            ? Boolean(readConfig().gmailOAuth?.clientId)
            : outlookMailConfigured(tab),
        phase: "disconnected",
        message:
          msg.provider === MailProvider.Gmail
            ? "Google sign-in cancelled."
            : "Microsoft sign-in cancelled.",
      });
      return;
    }
    if (msg.cmd === "mail_signout") {
      void signOutMail(tab, msg.provider, bridgeTabMcp);
      return;
    }
    if (msg.cmd === "playwright_browser_install_cancel") {
      const controller = playwrightBrowserInstalls.get(msg.browser);
      if (controller) controller.abort();
      return;
    }
    if (msg.cmd === "playwright_browser_install") {
      void installPlaywrightBrowser(tab, msg.browser, () => {
        const cfg = readConfig();
        const merged = ensurePlaywrightServerEntry(cfg);
        if (merged) {
          merged.stored.args = configurePlaywrightArgs(
            merged.stored.args ?? merged.args,
            msg.browser,
          );
          const env = { ...(merged.stored.env ?? {}) };
          delete env[PLAYWRIGHT_EXTENSION_TOKEN_ENV];
          delete env[PLAYWRIGHT_DOWNLOAD_HOST_ENV];
          merged.stored.env = Object.keys(env).length > 0 ? env : undefined;
          commitPlaywrightMcpEntry(cfg, tab);
        }
        void bridgeTabMcp(tab);
      });
      return;
    }
    if (msg.cmd === "mcp_extension_configure") {
      try {
        const token = typeof msg.token === "string" ? normalizeExtensionToken(msg.token) : "";
        const cfg = readConfig();
        const merged = ensurePlaywrightServerEntry(cfg);
        if (!merged) throw new Error("failed to create the playwright server entry");
        const { stored, args } = merged;
        stored.args = configurePlaywrightArgs(
          stored.args ?? args,
          msg.mode,
          msg.cdpEndpoint,
          msg.extensionBrowser,
        );
        const env = { ...(stored.env ?? {}) };
        if (msg.mode === "extension" && token) {
          // Explicit write: tokens rotate, so a newly entered one replaces any stored value.
          env[PLAYWRIGHT_EXTENSION_TOKEN_ENV] = token;
        } else if (msg.mode !== "extension") {
          delete env[PLAYWRIGHT_EXTENSION_TOKEN_ENV];
        }
        delete env[PLAYWRIGHT_DOWNLOAD_HOST_ENV];
        stored.env = Object.keys(env).length > 0 ? env : undefined;
        commitPlaywrightMcpEntry(cfg, tab);
        void bridgeTabMcp(tab);
      } catch (err) {
        emitDiagnosticError("mcp.extension.configure.failed", err, {
          tabId: tab.id,
        });
        emit(
          { type: "$error", message: `mcp_extension_configure: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "mcp_extension_check") {
      void runMcpExtensionCheck(tab);
      return;
    }
    if (msg.cmd === "rule_add") {
      if (!msg.rule.pattern.trim()) {
        emit({ type: "$error", message: "rule_add: pattern is empty" }, tab.id);
        return;
      }
      try {
        addRule(msg.rule, tab.rootDir);
        emitSettingsToAllTabs();
      } catch (err) {
        emit({ type: "$error", message: `rule_add: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "workspace_rules_copy") {
      try {
        copyWorkspaceRules(msg.from, tab.rootDir);
        emitSettingsToAllTabs();
      } catch (err) {
        emit(
          { type: "$error", message: `workspace_rules_copy: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "rule_update") {
      if (!msg.to.pattern.trim()) {
        emit({ type: "$error", message: "rule_update: pattern is empty" }, tab.id);
        return;
      }
      try {
        updateRule(msg.from, msg.to, tab.rootDir);
        emitSettingsToAllTabs();
      } catch (err) {
        emit({ type: "$error", message: `rule_update: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "rule_remove") {
      if (!msg.rule.pattern.trim()) {
        emit({ type: "$error", message: "rule_remove: pattern is empty" }, tab.id);
        return;
      }
      try {
        const removed = removeRule(msg.rule, tab.rootDir);
        // A row shown in the panel always maps to a stored rule, so a no-op here means the
        // UI held a stale row; record it rather than re-emitting an unchanged list.
        if (!removed) emitTabDiagnostic(tab, "rule.remove.noop", { rule: msg.rule });
        emitSettingsToAllTabs();
      } catch (err) {
        emit({ type: "$error", message: `rule_remove: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "skills_get") {
      emitSkills(tab);
      return;
    }
    if (msg.cmd === "skill_run") {
      try {
        const store = new SkillStore({
          projectRoot: tab.rootDir,
          customSkillPaths: loadResolvedSkillPaths(tab.rootDir),
        });
        const found = store.read(msg.name);
        if (!found) {
          emitTurnEnded(tab, "stopped", { reason: `skill not found: ${msg.name}` });
          return;
        }
        // A skill that resolved is a real turn: a neutral channel creates the session
        // it lands in. Resolving first keeps a stale skill from minting an empty one.
        if (!ensureTurnSession(tab)) return;
        const extra = msg.args?.trim() ?? "";
        const header = `# Skill: ${found.name}${found.description ? `\n> ${found.description}` : ""}`;
        const argsLine = extra ? `\n\nArguments: ${extra}` : "";
        const payload = `${header}\n\n${found.body}${argsLine}`;
        void runTurn(tab, payload);
      } catch (err) {
        emitTurnEnded(tab, "stopped", { reason: `skill_run: ${(err as Error).message}` });
      }
      return;
    }
    if (msg.cmd === "session_list") {
      void emitSessions(tab);
      return;
    }
    if (msg.cmd === "session_delete") {
      // The frontend hides the row optimistically and waits for a $sessions
      // snapshot carrying its name in settledDeletes. A throw anywhere in this
      // detach→delete→resync chain would skip that emit and strand the sidebar
      // mid-delete, so settle it no matter what.
      if (sessionsWithLiveTurn(tabs.values()).has(msg.name)) {
        // Refuse before detaching: a running session owns a turn the user did not
        // ask to stop. Settle it as not-removed so the row unhides.
        emitTabDiagnostic(tab, "session.delete.refused_running", { doomed: msg.name }, "info");
        emit({ type: "$error", message: sessionRunningRefusal(msg.name) }, tab.id);
        resyncAfterDeletes([{ name: msg.name, removed: false }], () => false);
        return;
      }
      let affectedTabs: Tab[] = [];
      let removed = false;
      try {
        // Detach live writers BEFORE removing the folder so none recreates it.
        affectedTabs = detachDoomedSessionWriters(new Set([msg.name]));
        const existed = sessionExists(msg.name);
        removed = deleteSession(msg.name) || !existed;
        if (!removed) {
          emit({ type: "$error", message: `session_delete failed: ${msg.name}` }, tab.id);
          restoreUntouchedRuntimes(affectedTabs, new Set());
        }
      } catch (err) {
        emitDiagnosticError("session.delete.failed", err, {
          tabId: tab.id,
          details: { session: msg.name },
        });
        emit({ type: "$error", message: `session_delete failed: ${msg.name}` }, tab.id);
        restoreUntouchedRuntimes(affectedTabs, new Set());
      }
      resyncAfterDeletes([{ name: msg.name, removed }], (t) =>
        shouldDetachDeletedSession(t.currentSession, msg.name, removed),
      );
      return;
    }
    if (msg.cmd === "session_clear") {
      // Settle EVERY name the frontend optimistically hid — its echoed request
      // list plus this workspace's on-disk sessions — so a delete that lands on a
      // name the listing missed can't leave a row hidden forever. Runs off the
      // reader thread so a large clear never freezes the RPC loop.
      const requested = Array.isArray(msg.names)
        ? msg.names.filter((n): n is string => typeof n === "string" && n.length > 0)
        : [];
      // Book the workspace for the whole chunked pass: a switch or forget now
      // would re-target or close the tab this settle belongs to.
      const releaseClearBooking = sessionWork.begin(tab.rootDir);
      void (async () => {
        const candidateNames = new Set(requested);
        try {
          // Names only, and off the reader thread: the sync twin walked and
          // parsed the whole store on one tick, freezing the daemon's RPC loop.
          for (const name of await listSessionNamesForWorkspaceAsync(tab.rootDir)) {
            candidateNames.add(name);
          }
        } catch (err) {
          emitDiagnosticError("session.clear.list.failed", err, { tabId: tab.id });
        }
        // A session with a turn in flight is never cleared: the user is waiting
        // on that work, so it stays on disk and keeps its row.
        const running = sessionsWithLiveTurn(tabs.values());
        const keptRunning = [...candidateNames].filter((name) => running.has(name));
        const doomed = deletableSessionNames(candidateNames, running);
        if (keptRunning.length > 0) {
          emitTabDiagnostic(
            tab,
            "session.clear.kept_running",
            { kept: keptRunning.length },
            "info",
          );
          emit(
            {
              type: "$error",
              message: `Kept ${keptRunning.length} running session(s): stop their agents, then delete them.`,
            },
            tab.id,
          );
        }
        let affectedTabs: Tab[] = [];
        let settledDeletes: { name: string; removed: boolean }[];
        try {
          affectedTabs = detachDoomedSessionWriters(new Set(doomed));
          // Chunked batch: each name settles independently, the directory index
          // persists once, and the event loop breathes between chunks.
          settledDeletes = await deleteSessions(doomed);
          // Settle the kept names too: their rows were never touched, and an
          // unsettled hide would strand them.
          settledDeletes.push(...keptRunning.map((name) => ({ name, removed: false })));
        } catch (err) {
          emitDiagnosticError("session.clear.failed", err, { tabId: tab.id });
          emit({ type: "$error", message: `session_clear failed: ${messageOf(err)}` }, tab.id);
          restoreUntouchedRuntimes(affectedTabs, new Set());
          // Still echo the requested names as settled so the frontend reconciles.
          settledDeletes = [...new Set([...requested, ...keptRunning])].map((name) => ({
            name,
            removed: false,
          }));
        }
        const removed = new Set(
          settledDeletes.filter((result) => result.removed).map((result) => result.name),
        );
        // A kept running session is a refusal, not a failure: reporting it as one
        // would restore a runtime that was never torn down.
        const failed = settledDeletes.filter(
          (result) => !result.removed && !running.has(result.name),
        );
        if (failed.length > 0) {
          emit(
            { type: "$error", message: `session_clear failed for ${failed.length} session(s)` },
            tab.id,
          );
          restoreUntouchedRuntimes(affectedTabs, removed);
        }
        resyncAfterDeletes(settledDeletes, (t) => removed.has(t.currentSession));
      })()
        .catch((err) => {
          // Belt and braces: an unhandled rejection here would take the whole
          // daemon down, which is the worst possible "no indication" outcome.
          emitDiagnosticError("session.clear.crashed", err, { tabId: tab.id });
          emit({ type: "$error", message: `session_clear failed: ${messageOf(err)}` }, tab.id);
          // Settle every name the frontend optimistically hid, so no row stays
          // hidden behind a clear that never finished.
          void emitSessions(
            tab,
            requested.map((name) => ({ name, removed: false })),
          );
        })
        .finally(releaseClearBooking);
      return;
    }
    if (msg.cmd === "session_rename") {
      patchSessionMetaAndResync(tab, "session_rename", msg.name, () => ({
        summary: normalizeSessionTitle(msg.title) || undefined,
      }));
      return;
    }
    if (msg.cmd === "session_reorder") {
      const now =
        typeof msg.createdAt === "number" && Number.isFinite(msg.createdAt) && msg.createdAt > 0
          ? msg.createdAt
          : Date.now();
      patchSessionMetaAndResync(tab, "session_reorder", msg.name, () => ({ createdAt: now }));
      return;
    }
    if (msg.cmd === "notices_sync") {
      syncSessionSidecar(tab, "notices", msg.notices, sessionNoticesPath, (name) =>
        writeSessionNotices(name, msg.notices),
      );
      return;
    }
    if (msg.cmd === "events_sync") {
      syncSessionSidecar(tab, "events", msg.events, sessionUiEventsPath, (name) =>
        writeSessionEvents(name, msg.events),
      );
      return;
    }
    if (msg.cmd === "session_load") {
      // Legacy alias for additive session_open — loading from the sidebar must
      // never replace or abort the channel the user is currently watching.
      openOrFocusSession(tab, msg.name, true);
      return;
    }
    if (msg.cmd === "session_open") {
      openOrFocusSession(tab, msg.name, false);
      return;
    }
    if (msg.cmd === "session_history_page") {
      const name = msg.name || tab.currentSession;
      if (!name) return;
      try {
        const meta = loadSessionMeta(name);
        const full = mergeNoticesIntoLoaded(
          buildLoadedMessages(loadSessionMessages(name)),
          loadSessionNotices(name),
          meta.lastTurn,
        );
        const window = sessionWindow(full, msg.before);
        emit(
          {
            type: "$session_history",
            name,
            messages: window.page,
            hasOlder: window.hasOlder,
            turnBase: window.turnBase,
          },
          tab.id,
        );
      } catch (err) {
        emit({ type: "$error", message: `session_history_page failed: ${messageOf(err)}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "memory_read") {
      try {
        const detail = readMemoryEntryDetail({ path: msg.path }, tab.rootDir);
        emit({ type: "$memory_detail", detail }, tab.id);
      } catch (err) {
        emit({ type: "$error", message: `memory_read failed: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "memory_write") {
      try {
        const written = writeMemoryEntry(
          {
            scope: msg.scope,
            name: msg.name,
            description: msg.description,
            body: msg.body,
            ...(msg.type ? { type: msg.type } : {}),
            ...(msg.priority ? { priority: msg.priority } : {}),
            ...(msg.expires ? { expires: msg.expires } : {}),
          },
          tab.rootDir,
        );
        // Remove the replaced file only after the new write succeeds, so a rejected
        // rename can't destroy the original. Skip when both resolve to one file: a
        // case-only rename lands in the same Windows file, so deleting erases the write.
        if (
          msg.originalPath &&
          resolve(msg.originalPath).toLowerCase() !== resolve(written.path).toLowerCase()
        ) {
          try {
            deleteMemoryEntry(msg.originalPath, tab.rootDir);
          } catch (err) {
            process.stderr.write(
              `reasonix: memory_write saved the edit but could not delete the replaced entry ${msg.originalPath}: ${(err as Error).message}\n`,
            );
          }
        }
        emitMemory(tab);
        emit(
          { type: "$memory_result", ok: true, message: `saved ${msg.scope}/${msg.name}` },
          tab.id,
        );
      } catch (err) {
        emit({ type: "$memory_result", ok: false, message: (err as Error).message }, tab.id);
      }
      return;
    }
    if (msg.cmd === "memory_delete") {
      try {
        const ok = deleteMemoryEntry(msg.path, tab.rootDir);
        emitMemory(tab);
        emit(
          {
            type: "$memory_result",
            ok,
            message: ok ? "memory deleted" : "memory not found",
          },
          tab.id,
        );
      } catch (err) {
        emit({ type: "$memory_result", ok: false, message: (err as Error).message }, tab.id);
      }
      return;
    }
    if (msg.cmd === "new_chat") {
      // New chat is additive: preserve every existing agent in this workspace
      // tab and mount a fresh independent session beside them.
      if (tabNeedsWorkspace(tab)) {
        // Never drop a click in silence: the UI offers New chat here, so it owes
        // the user a reason instead of a dead button.
        emit({ type: "$error", message: NO_WORKSPACE_MESSAGE }, tab.id);
        return;
      }
      if (!sessionCreationGate.tryEnter(tab.rootDir)) {
        refuseSessionMutation(SESSION_CREATION_IN_FLIGHT_MESSAGE, tab.id);
        return;
      }
      try {
        const opened = bootstrapTab(tab.rootDir, {
          active: true,
          groupId: tab.groupId,
          // Inherit the source session's models/effort — otherwise the fresh
          // channel falls back to the global config default and drops the
          // per-conversation subagent override entirely.
          model: tab.currentModel,
          reasoningEffort: tab.currentReasoningEffort,
          subagentModel: tab.currentSubagentModel,
          // Fresh session, so the new channel shows a create indicator until
          // its first $sessions snapshot lists the minted session.
          creating: true,
        });
        armCreationRelease(opened);
        lastActiveTabId = opened.id;
        persistOpenTabs();
      } catch (err) {
        // A bootstrap that never started must not leave the workspace locked.
        sessionCreationGate.leave(tab.rootDir);
        emitDiagnosticError("session.new-chat.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        emit({ type: "$error", message: `new-chat failed: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "duplicate_session") {
      // Clone this conversation into a NEW session, trimmed to the newest
      // `duplicateSessionTokens` tokens, opened on the user-picked models. The
      // frontend ships the export markdown (the export format lives there); we
      // trim it here where the accurate DeepSeek tokenizer lives.
      if (tabNeedsWorkspace(tab)) {
        emit({ type: "$error", message: NO_WORKSPACE_MESSAGE }, tab.id);
        return;
      }
      const markdown = typeof msg.markdown === "string" ? msg.markdown : "";
      if (!markdown.trim()) {
        emit({ type: "$error", message: "Duplicate session: nothing to duplicate." }, tab.id);
        return;
      }
      if (!sessionCreationGate.tryEnter(tab.rootDir)) {
        refuseSessionMutation(SESSION_CREATION_IN_FLIGHT_MESSAGE, tab.id);
        return;
      }
      const model = msg.model || tab.currentModel;
      const subagentModel = msg.subagentModel || tab.currentSubagentModel || model;
      const context = buildDuplicateContext(markdown, loadDuplicateSessionTokens());
      const autoProceed = loadDuplicateSessionAutoProceed();
      try {
        // Mint a real session for the duplicate, stamped with the chosen models
        // so bootstrapTab restores them (resolveSessionModelPrefs reads meta).
        const name = mintSessionFor(
          tab.rootDir,
          {
            model,
            reasoningEffort: tab.currentReasoningEffort,
            subagentModel,
          },
          // Duplicate is the exception: inherit the SOURCE session's live MCP
          // state, not the current Settings default.
          {
            mcp: sessionMcpState(tab.currentSession) ?? sessionMcpFromConfig(tab.rootDir),
            // Same rule for the subagent flag: the clone behaves like its source.
            subagents: tab.subagents,
          },
        );
        // Auto-proceed off (default): seed the blob as the opening user turn and
        // stop, so the user drives the next message. On: leave the log empty and
        // let the runTurn below append + run it.
        if (!autoProceed) appendSessionMessage(name, { role: "user", content: context });
        const opened = bootstrapTab(tab.rootDir, {
          session: name,
          active: true,
          groupId: tab.groupId,
          creating: true,
        });
        armCreationRelease(opened);
        lastActiveTabId = opened.id;
        persistOpenTabs();
        if (autoProceed) {
          void opened.initialization
            ?.then(() => {
              // Runtime is built at the tail of initTabToolset; a null runtime
              // means the chosen model isn't configured — leave it for setup.
              if (opened.runtime) void runTurn(opened, context);
            })
            .catch((err) => {
              emit(
                { type: "$error", message: `duplicate_session failed: ${(err as Error).message}` },
                opened.id,
              );
            });
        }
      } catch (err) {
        // A failed mint or bootstrap must not leave the workspace locked.
        sessionCreationGate.leave(tab.rootDir);
        emitDiagnosticError("session.duplicate.failed", err, {
          tabId: tab.id,
          details: tabDiagnosticState(tab),
        });
        emit(
          { type: "$error", message: `duplicate_session failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "oauth_begin") {
      oauthGen++;
      if (pendingOAuth) pendingOAuth.cancel();
      const gen = oauthGen;
      void beginOAuthFlow()
        .then((flow) => {
          pendingOAuth = flow;
          emit({ type: "oauth_begin_result", url: flow.url }, tab.id);
          void flow.done
            .then(async (creds) => {
              if (gen !== oauthGen) return; // superseded by a newer begin/signout
              pendingOAuth = null;
              const account = (await oauthAccount(creds.accessToken)) ?? creds.account;
              saveOpenAIOAuth({ ...creds, account });
              lastOAuthError = null;
              // The runtime snapshots the credential source at build time —
              // build (or rebuild) now-credentialed tabs so a fresh sign-in
              // takes effect (and clears the needs-setup screen) without a
              // model flip. A tab that booted un-credentialed has a null
              // runtime — it must be built here, not just rebuilt.
              rebuildCredentialedTabs();
              emitSettings(tab);
            })
            .catch((err: Error) => {
              if (gen !== oauthGen) return;
              pendingOAuth = null;
              lastOAuthError = err.message;
              emit({ type: "$error", message: err.message }, tab.id);
              emitSettings(tab);
            });
        })
        .catch((err: Error) => {
          lastOAuthError = err.message;
          emit({ type: "$error", message: `oauth_begin failed: ${err.message}` }, tab.id);
          emitSettings(tab);
        });
      return;
    }
    if (msg.cmd === "oauth_cancel") {
      oauthGen++;
      if (pendingOAuth) {
        pendingOAuth.cancel();
        pendingOAuth = null;
      }
      return;
    }
    if (msg.cmd === "oauth_signout") {
      oauthGen++;
      lastOAuthError = null;
      if (pendingOAuth) {
        pendingOAuth.cancel();
        pendingOAuth = null;
      }
      void signOutOpenAI()
        .then(() => emitSettings(tab))
        .catch((err: Error) => {
          emit({ type: "$error", message: `oauth_signout failed: ${err.message}` }, tab.id);
        });
      return;
    }
    if (msg.cmd === "gemini_oauth_begin") {
      antigravityOAuthGen++;
      if (pendingAntigravityOAuth) pendingAntigravityOAuth.cancel();
      const gen = antigravityOAuthGen;
      void beginAntigravityOAuthFlow()
        .then((flow) => {
          pendingAntigravityOAuth = flow;
          emit({ type: "gemini_oauth_begin_result", url: flow.url }, tab.id);
          void flow.done
            .then(async (creds) => {
              if (gen !== antigravityOAuthGen) return; // superseded by a newer begin/signout
              pendingAntigravityOAuth = null;
              const account = (await antigravityAccount(creds.accessToken)) ?? creds.account;
              const projectId = await onboardAntigravity(creds.accessToken);
              const onboarded = {
                ...creds,
                clientId: ANTIGRAVITY_OAUTH_CLIENT_ID,
                account,
                projectId,
              };
              saveAntigravityOAuth(onboarded);
              const models = (await fetchAntigravityModels(creds.accessToken, projectId)).map(
                ({ id }) => id,
              );
              saveAntigravityOAuth({ ...onboarded, models });
              lastAntigravityOAuthError = null;
              // Build (or rebuild) now-credentialed tabs so a fresh sign-in
              // takes effect (and clears the needs-setup screen) without a
              // model flip. A tab that booted un-credentialed has a null
              // runtime — it must be built here, not just rebuilt.
              rebuildCredentialedTabs();
              emitSettings(tab);
            })
            .catch((err: Error) => {
              if (gen !== antigravityOAuthGen) return;
              pendingAntigravityOAuth = null;
              lastAntigravityOAuthError = err.message;
              emit({ type: "$error", message: err.message }, tab.id);
              emitSettings(tab);
            });
        })
        .catch((err: Error) => {
          lastAntigravityOAuthError = err.message;
          emit({ type: "$error", message: `gemini_oauth_begin failed: ${err.message}` }, tab.id);
          emitSettings(tab);
        });
      return;
    }
    if (msg.cmd === "gemini_oauth_cancel") {
      antigravityOAuthGen++;
      if (pendingAntigravityOAuth) {
        pendingAntigravityOAuth.cancel();
        pendingAntigravityOAuth = null;
      }
      return;
    }
    if (msg.cmd === "gemini_oauth_signout") {
      antigravityOAuthGen++;
      lastAntigravityOAuthError = null;
      if (pendingAntigravityOAuth) {
        pendingAntigravityOAuth.cancel();
        pendingAntigravityOAuth = null;
      }
      void signOutAntigravity()
        .then(() => emitSettings(tab))
        .catch((err: Error) => {
          emit({ type: "$error", message: `gemini_oauth_signout failed: ${err.message}` }, tab.id);
        });
      return;
    }
    if (msg.cmd === "opencode_oauth_begin") {
      opencodeOAuthGen++;
      if (pendingOpencodeOAuth) pendingOpencodeOAuth.cancel();
      const gen = opencodeOAuthGen;
      void beginOpencodeDeviceFlow()
        .then((flow) => {
          pendingOpencodeOAuth = flow;
          emit(
            { type: "opencode_oauth_begin_result", url: flow.url, userCode: flow.userCode },
            tab.id,
          );
          void flow.done
            .then((creds) => {
              if (gen !== opencodeOAuthGen) return; // superseded by a newer begin/signout
              pendingOpencodeOAuth = null;
              saveOpencodeOAuth(creds);
              lastOpencodeOAuthError = null;
              // A fresh credential unlocks the paid + Go catalog and may make
              // previously unusable tabs usable — build (or rebuild) them, then
              // resync the model list so subscription ids appear.
              rebuildCredentialedTabs();
              void refreshOpencodeModels(true, tab);
              emitSettings(tab);
            })
            .catch((err: Error) => {
              if (gen !== opencodeOAuthGen) return;
              pendingOpencodeOAuth = null;
              lastOpencodeOAuthError = err.message;
              emit({ type: "$error", message: err.message }, tab.id);
              emitSettings(tab);
            });
        })
        .catch((err: Error) => {
          lastOpencodeOAuthError = err.message;
          emit({ type: "$error", message: `opencode_oauth_begin failed: ${err.message}` }, tab.id);
          emitSettings(tab);
        });
      return;
    }
    if (msg.cmd === "opencode_oauth_cancel") {
      opencodeOAuthGen++;
      if (pendingOpencodeOAuth) {
        pendingOpencodeOAuth.cancel();
        pendingOpencodeOAuth = null;
      }
      return;
    }
    if (msg.cmd === "opencode_oauth_signout") {
      opencodeOAuthGen++;
      lastOpencodeOAuthError = null;
      if (pendingOpencodeOAuth) {
        pendingOpencodeOAuth.cancel();
        pendingOpencodeOAuth = null;
      }
      void signOutOpencode()
        .then(() => {
          // The catalog shrinks back to the keyless tier — resync so paid/Go ids drop out.
          void refreshOpencodeModels(true, tab);
          emitSettings(tab);
        })
        .catch((err: Error) => {
          emit(
            { type: "$error", message: `opencode_oauth_signout failed: ${err.message}` },
            tab.id,
          );
        });
      return;
    }
    if (msg.cmd === "mimo_oauth_begin") {
      mimoOAuthGen++;
      if (pendingMiMoOAuth) pendingMiMoOAuth.cancel();
      const gen = mimoOAuthGen;
      void beginMiMoLoginFlow({ keyName: loadMimoKeyName() })
        .then((flow) => {
          pendingMiMoOAuth = flow;
          emit({ type: "mimo_oauth_begin_result", url: flow.url }, tab.id);
          void flow.done
            .then((cred) => {
              if (gen !== mimoOAuthGen) return; // superseded by a newer begin/signout
              pendingMiMoOAuth = null;
              saveMimoCredential({ apiKey: cred.apiKey, baseUrl: cred.baseUrl });
              lastMiMoOAuthError = null;
              // A fresh key makes previously unusable MiMo tabs usable — rebuild.
              rebuildCredentialedTabs();
              emitSettings(tab);
            })
            .catch((err: Error) => {
              if (gen !== mimoOAuthGen) return;
              pendingMiMoOAuth = null;
              lastMiMoOAuthError = err.message;
              emit({ type: "$error", message: err.message }, tab.id);
              emitSettings(tab);
            });
        })
        .catch((err: Error) => {
          lastMiMoOAuthError = err.message;
          emit({ type: "$error", message: `mimo_oauth_begin failed: ${err.message}` }, tab.id);
          emitSettings(tab);
        });
      return;
    }
    if (msg.cmd === "mimo_oauth_cancel") {
      mimoOAuthGen++;
      if (pendingMiMoOAuth) {
        pendingMiMoOAuth.cancel();
        pendingMiMoOAuth = null;
      }
      return;
    }
    if (msg.cmd === "mimo_oauth_signout") {
      mimoOAuthGen++;
      lastMiMoOAuthError = null;
      if (pendingMiMoOAuth) {
        pendingMiMoOAuth.cancel();
        pendingMiMoOAuth = null;
      }
      clearMimoApiKey();
      emitSettings(tab);
      return;
    }
    if (msg.cmd === "setup_save_openai_key") {
      const key = msg.key.trim();
      if (key && !isPlausibleKey(key)) {
        emit(
          {
            type: "$error",
            message: "Key looks too short — paste the full token (16+ chars, no spaces).",
          },
          tab.id,
        );
        return;
      }
      try {
        saveOpenAIApiKey(key);
        void refreshProviderCatalogs(true); // A fresh OpenAI key also unblocks ChatGPT-only installs whose tab still
        // defaults to a DeepSeek model — build (or rebuild) every now-credentialed
        // tab ready. A tab that booted un-credentialed has a null runtime — it
        // must be built here, not just rebuilt.
        rebuildCredentialedTabs();
        emitSettings(tab);
      } catch (err) {
        emit(
          { type: "$error", message: `saveOpenAIApiKey failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "provider_models_refresh") {
      void refreshProviderCatalogs(!!msg.force, msg.provider);
      return;
    }
    if (msg.cmd === "settings_get") {
      void refreshProviderCatalogs();
      emitSettings(tab);
      return;
    }
    if (msg.cmd === "funds_refresh") {
      void refreshFunds(tab, { force: true });
      return;
    }
    if (msg.cmd === "ollama_models_list") {
      // `force` (manual refresh button) refetches; plain calls reuse the
      // app-global cache within its TTL so tab effects don't hammer the
      // endpoint. The broadcast is tabId-less — every tab shares the result.
      void refreshOllamaModels(!!msg.force, tab);
      return;
    }
    if (msg.cmd === "antigravity_models_refresh") {
      void refreshAntigravityModels(tab);
      return;
    }
    if (msg.cmd === "opencode_models_refresh") {
      void refreshOpencodeModels(!!msg.force, tab);
      return;
    }
    if (msg.cmd === "changelog_get") {
      void refreshChangelog(!!msg.force, tab);
      return;
    }
    /** Panels whose persisted key flips other runtime state, keyed by the declared
     *  settingsPanel name — never by provider id. */
    const PANEL_AFTER_PERSIST: Record<string, () => void> = {
      "opencode-auth": () => {
        // The key flips the catalog between the keyless free tier and the paid
        // Zen + Go catalog.
        void refreshOpencodeModels(true);
      },
    };

    /** Apply a provider settings patch: echoed secret previews are ignored, and the
     *  store is written once before the runtime that a credential gates is refreshed. */
    function applyProviderSettingsPatch(patch: ProviderSettingsMap, tab: Tab): void {
      const { writes } = parseProviderSettingsPatch(patch);
      const previews = loadProviderApiKeys();
      const kindOf = (write: { providerId: string; key: string }) =>
        providerSpec(write.providerId)?.settings.find((setting) => setting.key === write.key)?.kind;
      const accepted = writes.filter(
        // The payload carries a masked preview; echoing it means "unchanged".
        (write) =>
          !(kindOf(write) === "secret" && write.value === maskApiKey(previews[write.providerId])),
      );
      if (accepted.length === 0) return;
      void (async () => {
        const cfg = readConfig();
        for (const write of accepted) {
          setProviderSetting(cfg, write.providerId, write.key, write.value);
        }
        writeConfig(cfg);
        // The endpoint + credential are snapshotted at build time, so a tab that
        // just became usable must be rebuilt or the saved value looks inert.
        if (accepted.some((write) => kindOf(write) === "secret")) rebuildCredentialedTabs();
        for (const providerId of new Set(accepted.map((write) => write.providerId))) {
          const spec = providerSpec(providerId);
          if (spec?.routing.discoveredCatalog) {
            void refreshProviderCatalogs(false, spec.id);
          }
          if (spec?.settingsPanel) PANEL_AFTER_PERSIST[spec.settingsPanel]?.();
        }
        emitSettings(tab);
      })();
    }

    if (msg.cmd === "settings_save") {
      try {
        // Provider credentials persist before the early-return branches below
        // (workspaceDir, model, …) can swallow the message.
        if (msg.providerSettings !== undefined) {
          void applyProviderSettingsPatch(msg.providerSettings, tab);
        }
        if (msg.reasoningEffort !== undefined && isReasoningEffort(msg.reasoningEffort)) {
          saveReasoningEffort(msg.reasoningEffort);
          tab.currentReasoningEffort = msg.reasoningEffort;
          tab.runtime?.loop.configure({ reasoningEffort: msg.reasoningEffort });
          persistSessionModelPrefs(tab);
        }
        if (msg.editMode !== undefined) {
          saveEditMode(msg.editMode);
          // The edit gate is global state: every tab's dispatch gate AND the live
          // "Permissions (live)" block must track the user's selection, not just
          // the tab that sent the settings message.
          for (const openTab of tabs.values()) {
            refreshEditModeKnowledge(openTab, msg.editMode);
            emitSettings(openTab);
          }
        }
        if (msg.quickSends !== undefined) {
          saveCustomQuickSends(msg.quickSends);
        }
        if (msg.quickSendId !== undefined) {
          saveQuickSendId(msg.quickSendId);
          // The marked row is app-global state: every open composer shows the
          // same default, not only the tab that picked it.
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.contextTokens !== undefined) {
          saveContextTokens(msg.contextTokens);
          const next = loadContextTokens();
          tab.ctxMaxOverride = next;
          // Re-resolve verdict-aware so an Ollama tab keeps its learned window
          // while the new user value stays the fallback (matches boot logic).
          tab.runtime?.loop.configure({ ctxMaxOverride: tabCtxMaxOverride(tab) ?? null });
          emitCtxBreakdown(tab);
          emitSettings(tab);
        }
        if (msg.maxIterPerTurn !== undefined) {
          saveMaxIterPerTurn(msg.maxIterPerTurn);
          const next = loadMaxIterPerTurn();
          for (const openTab of tabs.values()) {
            openTab.runtime?.loop.configure({ maxIterPerTurn: next });
            emitSettings(openTab);
          }
        }
        if (msg.autoCompact !== undefined) {
          saveAutoCompact(msg.autoCompact);
          for (const openTab of tabs.values()) {
            openTab.runtime?.loop.configure({ autoCompact: msg.autoCompact });
            emitSettings(openTab);
          }
        }
        if (msg.autoCompactTrigger !== undefined) {
          saveAutoCompactTrigger(msg.autoCompactTrigger);
          for (const openTab of tabs.values()) {
            openTab.runtime?.loop.configure({ autoCompactTriggerRatio: msg.autoCompactTrigger });
            emitSettings(openTab);
          }
        }
        if (msg.duplicateSessionTokens !== undefined) {
          saveDuplicateSessionTokens(msg.duplicateSessionTokens);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.duplicateSessionAutoProceed !== undefined) {
          saveDuplicateSessionAutoProceed(msg.duplicateSessionAutoProceed);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.elevationEnabled !== undefined) {
          // The shell tool reads this via a live getter, so no toolset rebuild
          // is needed — persisting + re-emitting settings is enough.
          saveElevationEnabled(msg.elevationEnabled);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.repetitionGuardEnabled !== undefined) {
          saveRepetitionGuardEnabled(msg.repetitionGuardEnabled);
          const next = loadRepetitionGuardEnabled();
          for (const openTab of tabs.values()) {
            openTab.runtime?.loop.configure({ repetitionGuardEnabled: next });
            emitSettings(openTab);
          }
        }
        if (msg.feedbackCues !== undefined) {
          saveFeedbackCues(msg.feedbackCues);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.questionTimerEnabled !== undefined) {
          saveQuestionTimerEnabled(msg.questionTimerEnabled);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.enabledModels !== undefined) {
          saveEnabledModels(Array.isArray(msg.enabledModels) ? msg.enabledModels : []);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.fallbackModels !== undefined) {
          // Read at failover time, not snapshotted onto the tab: the list applies
          // to every open conversation the moment it is saved.
          saveFallbackModels(Array.isArray(msg.fallbackModels) ? msg.fallbackModels : []);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.ollamaGeneration !== undefined) {
          saveOllamaGenerationPatch(msg.ollamaGeneration);
          for (const openTab of tabs.values()) emitSettings(openTab);
        }
        if (msg.baseUrl !== undefined) saveBaseUrl(msg.baseUrl);
        if (msg.workspaceDir !== undefined) {
          // A switch can fail after it has already moved the tab (the toolset
          // build is where a broken workspace surfaces): report it instead of
          // leaving an unhandled rejection and a half-switched channel.
          void switchWorkspace(tab, msg.workspaceDir).catch((err) => {
            emitDiagnosticError("workspace.switch.failed", err, {
              tabId: tab.id,
              details: tabDiagnosticState(tab),
            });
            emit(
              {
                type: "$error",
                message: `workspace switch failed: ${(err as Error).message}`,
              },
              tab.id,
            );
            emitSettings(tab);
          });
          return;
        }
        if (msg.webSearchEngine !== undefined) {
          const cfg = readConfig();
          cfg.webSearchEngine = msg.webSearchEngine;
          writeConfig(cfg);
        }
        if (msg.searchSettings !== undefined) {
          const { writes } = parseSearchSettingsPatch(msg.searchSettings);
          if (writes.length > 0) {
            const cfg = readConfig();
            const previews = loadSearchApiKeys();
            for (const write of writes) {
              const spec = searchEngineSpec(write.engineId);
              const kind = spec ? searchSettingSpec(spec, write.key)?.kind : undefined;
              // The payload masks secrets; an echoed preview means "unchanged".
              if (kind === "secret" && write.value === maskApiKey(previews[write.engineId])) {
                continue;
              }
              setSearchSetting(cfg, write.engineId, write.key, write.value);
            }
            writeConfig(cfg);
          }
        }
        if (msg.subagentModel !== undefined) {
          const next = msg.subagentModel.trim();
          if (next) {
            tab.currentSubagentModel = next;
            // Resolved lazily at spawn time (setup reads `() => tab.currentSubagentModel`),
            // so no toolset rebuild is needed — the next subagent spawn picks it up.
            persistSessionModelPrefs(tab);
          }
        }
        if (msg.model !== undefined) {
          const next = msg.model.trim();
          if (next && next !== tab.currentModel) {
            // Release a running turn before the rebuild. The in-flight runTurn
            // captured the previous runtime, so it keeps driving the old
            // loop/client and never adopts the new model; a wedged request then
            // holds the turn (and every queued send behind it) until the
            // client's 11-min timeout. Abort BEFORE the rebuild so the OLD loop
            // is the one stopped, and WITHOUT the `switching` flag so the
            // turn's $turn_complete still lands and the FE settles + drains.
            if (tab.aborter) abortTurn(tab, desktopUserAbortLoopOptions());
            // applyTabModel rolls the tab back to the previous model if the
            // rebuild throws, so the UI never shows a model the daemon never
            // built a runtime for.
            applyTabModel(tab, next, { persistDefault: true });
          }
        }
        emitSettings(tab);
        void refreshProviderCatalogs();
        emitTabGate(tab);
      } catch (err) {
        emit(
          { type: "$error", message: `settings_save failed: ${(err as Error).message}` },
          tab.id,
        );
        // Re-sync even on failure: the UI applied the patch optimistically,
        // so without this it permanently displays settings the daemon rejected.
        try {
          emitSettings(tab);
        } catch (emitErr) {
          process.stderr.write(`reasonix: settings re-emit failed — ${messageOf(emitErr)}\n`);
        }
        emitTabGate(tab);
      }
      return;
    }
    if (msg.cmd === "mention_query") {
      const nonce = msg.nonce;
      const query = msg.query;
      const parsed = parseAtQuery(query);
      // Empty query → list workspace root's top-level entries (tree
      // style). Without this, bare `@` floods with all 5000 files; the
      // TUI's @+Tab pattern already shows the tree top.
      const treeWalk = parsed.trailingSlash || query.length === 0;
      if (treeWalk) {
        void listDirectory(tab.rootDir, parsed.dir)
          .then((entries) => {
            const results = entries.map((e) => (e.isDir ? `${e.path}/` : e.path));
            emit({ type: "$mention_results", nonce, query, results }, tab.id);
          })
          .catch((err) => {
            emit(
              { type: "$error", message: `mention_query (dir) failed: ${(err as Error).message}` },
              tab.id,
            );
            emit({ type: "$mention_results", nonce, query, results: [] }, tab.id);
          });
        return;
      }
      const wantSymbols = query.length >= 2 && !query.includes("/");
      void (async () => {
        try {
          const files = await getFileIndexFor(tab);
          const fileResults = rankPickerCandidates(files, query, {
            limit: wantSymbols ? 19 : 25,
            recentlyUsed: tab.recentMentions,
          });
          let symResults: string[] = [];
          if (wantSymbols) {
            const syms = await getSymbolIndexFor(tab);
            symResults = rankSymbols(syms, query, 6);
          }
          emit(
            { type: "$mention_results", nonce, query, results: [...symResults, ...fileResults] },
            tab.id,
          );
        } catch (err) {
          emit(
            { type: "$error", message: `mention_query failed: ${(err as Error).message}` },
            tab.id,
          );
          emit({ type: "$mention_results", nonce, query, results: [] }, tab.id);
        }
      })();
      return;
    }
    if (msg.cmd === "mention_picked") {
      pushMentionRecent(tab, msg.path);
      return;
    }
    if (msg.cmd === "mention_preview") {
      const nonce = msg.nonce;
      const rel = msg.path;
      const abs = isAbsolute(rel) ? rel : join(tab.rootDir, rel);
      const safeAbs = resolve(abs);
      const safeRoot = resolve(tab.rootDir);
      if (!safeAbs.startsWith(safeRoot)) {
        emit({ type: "$mention_preview", nonce, path: rel, head: "", totalLines: 0 }, tab.id);
        return;
      }
      void readFile(safeAbs, "utf8")
        .then((text) => {
          const lines = text.split(/\r?\n/);
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          const head = lines.slice(0, 12).join("\n");
          emit(
            { type: "$mention_preview", nonce, path: rel, head, totalLines: lines.length },
            tab.id,
          );
        })
        .catch(() => {
          emit({ type: "$mention_preview", nonce, path: rel, head: "", totalLines: 0 }, tab.id);
        });
      return;
    }
    if (msg.cmd === "plan_history_get") {
      emitPlanHistory(tab);
      return;
    }
    if (msg.cmd === "plan_detail_get") {
      refreshPlanSummary(tab);
      try {
        emit(
          {
            type: "$plan_detail",
            sessionName: tab.currentSession,
            plan: planRepository(tab.rootDir).open(msg.planId),
          },
          tab.id,
        );
      } catch (err) {
        // A stale/unknown plan id or a missing session must not throw out of the
        // stdin line handler — surface it as an error event instead.
        emit(
          { type: "$error", message: `plan_detail_get failed: ${(err as Error).message}` },
          tab.id,
        );
      }
      return;
    }
    if (msg.cmd === "plan_remove") {
      try {
        const repository = planRepository(tab.rootDir);
        const wasActive = activePlanForTab(tab)?.id === msg.planId;
        repository.remove(msg.planId);
        refreshPlanSummary(tab);
        emitPlanHistory(tab);
        // A removed active plan must stop driving the rail and the loop's plan context.
        if (wasActive) emit({ type: "$plan_cleared" }, tab.id);
      } catch (err) {
        // A stale/unknown plan id or a missing workspace must not throw out of the
        // stdin line handler — surface it as an error event instead.
        emit({ type: "$error", message: `plan_remove failed: ${(err as Error).message}` }, tab.id);
      }
      return;
    }
    if (msg.cmd === "context_compact") {
      void runManualCompact(tab, emit, async () => {
        cancelPendingGates(tab);
        await tab.toolset?.jobs.shutdown(1500, { keepPersistent: true });
        emitJobs();
      });
      return;
    }
    if (msg.cmd === "retry") {
      if (!tab.runtime) return;
      // Retry truncates the log outside the turn stream — record the
      // replacement in the kernel event log (session.retracted) so replaying
      // the events sidecar yields the truncated conversation.
      const before = tab.runtime.loop.log.length;
      const prev = tab.runtime.loop.retryLastUser();
      if (prev) {
        emit({ type: "$retry_result", text: prev }, tab.id);
        emitKernelEvent(
          tab.runtime.eventizer.emitSessionRetracted(
            tab.runtime.loop.currentTurn,
            "retry",
            before,
            tab.runtime.loop.log.length,
            tab.runtime.loop.log.entries,
          ),
          tab.id,
        );
      }
      return;
    }

    if (msg.cmd === "btw") {
      if (!tab.runtime) return;
      const question = msg.text.trim();
      if (!question) return;
      void (async () => {
        try {
          const reply = await tab.runtime!.loop.client.chat({
            model: tab.currentModel,
            messages: [
              {
                role: "system",
                content:
                  "You are answering a side question that is unrelated to the current coding conversation. Answer concisely (1-3 sentences) in plain prose. Do not call tools, do not ask clarifying questions, and do not reference any prior turns.",
              },
              { role: "user", content: question },
            ],
          });
          const answer =
            (typeof reply.content === "string" ? reply.content.trim() : "") || "(no answer)";
          emit({ type: "$btw_result", question, answer }, tab.id);
        } catch (err) {
          emit(
            { type: "$error", message: `side question failed: ${(err as Error).message}` },
            tab.id,
          );
        }
      })();
      return;
    }
    if (msg.cmd === "user_input") {
      if (!ensureTurnSession(tab)) return;
      void (async () => {
        let text = msg.text;
        let attachments = msg.images ? [...msg.images] : [];
        // Vision-capable models accept image parts — auto-parse `@path`
        // mentions of local images into vision attachments so typing or
        // picking an image path just works. Other models never get image
        // parts (runTurn gates).
        if (modelAcceptsImages(tab.currentModel, ollamaVisionModelIds())) {
          const converted = await extractImageMentions(text, tab.rootDir);
          if (converted.attachments.length > 0) {
            text = converted.text;
            attachments = [...attachments, ...converted.attachments];
          }
        }
        let images: TurnImage[] | undefined;
        if (attachments.length > 0) {
          try {
            images = await resolveUserImages(attachments, tab.rootDir);
          } catch (err) {
            emitTurnEnded(tab, "stopped", {
              reason: `Image attach failed: ${(err as Error).message}`,
            });
            return;
          }
        }
        void runTurn(tab, text, images, msg.clientId);
      })();
    }
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      void gracefulShutdown();
      resolve();
    });
  });
}
