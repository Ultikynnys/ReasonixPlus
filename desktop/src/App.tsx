import {
  type ChangelogRelease,
  DEFAULT_MODEL,
  type MemoryWriteOptions,
  type PickerWindow,
  type RuleRecord,
  clipText,
  compactionCardText,
  extractPathsFromArgs,
  flattenText,
  isFilePathTool,
  mediaKindForPath,
  messageOf,
  modelAcceptsAudioVideo,
  modelAcceptsImages,
  modelDisplayName,
  sanitizeFilename,
} from "@reasonix/core-utils";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted as isNotificationPermissionGranted,
  requestPermission as requestNotificationPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { type Update, check } from "@tauri-apps/plugin-updater";
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { WorkspaceProvider } from "./Markdown";
import { type AbortDraftSource, nextAbortDraftCandidate, restoreAbortedDraft } from "./abort-draft";
import { recordFrontendFailure } from "./diagnostics";
import { type FeedbackSoundPlayer, feedbackSounds, primeFeedbackSounds } from "./feedback-sounds";
import { formatBytes } from "./format";
import { t, useLang } from "./i18n";
import { I } from "./icons";
import { downscaleImage, fileToDataUrl, isImagePath, typedMentionImages } from "./image-attach";
import { ratesByWorkspace, runningTabSession } from "./live-rates";
import { MODEL_CATALOG_GROUP_LABELS, deriveModelCatalog } from "./model-catalog";
import {
  type ApprovalSnapshot,
  type PlanFeedbackState,
  deriveDesktopNotifications,
  deriveStateCueSounds,
  dispatchDesktopNotifications,
  playEnabledCue,
  shouldAppendCompletionNotice,
} from "./notifications";
import { planLabelsBySession } from "./plan-labels";
import {
  type AntigravityQuota,
  type CheckpointVerdict,
  type ChoiceVerdict,
  type CodexQuota,
  type ConfirmationChoice,
  type FeedbackCueId,
  type FeedbackCueSettings,
  type IncomingEvent,
  type JobInfo,
  type LoadedMessage,
  type MailAuthState,
  MailProvider,
  type McpExtensionCheck,
  type McpExtensionStatus,
  type McpSetupServer,
  type McpSpecInfo,
  type MemoryDetail,
  type MemoryEntryInfo,
  type OllamaQuota,
  type OpencodeQuota,
  type OutgoingCommand,
  type PersistedNotice,
  type PlanStep,
  type PlanVerdict,
  type PlaywrightBrowserInstall,
  type PlaywrightExtensionBrowser,
  type PlaywrightManagedBrowser,
  type PlaywrightMcpConnectionMode,
  type RevisionVerdict,
  type SessionEventRecord,
  type SessionProviderCost,
  type SettingsPatch,
  type SettingsPayload,
  type SkillInfo,
  type SubagentProgressEvent,
  type TurnOutcome,
  type UserImageAttachment,
  type ZaiQuota,
  allQuickSends,
  resolveActiveQuickSend,
  rpcSend,
} from "./protocol";
import {
  type SessionsStore,
  applySessionsSnapshot,
  beginIntent,
  emptySessionsStore,
  hasOpenSessionIntent,
  hiddenNames,
  mutationFor,
  openIntentId,
  patchSession,
  sessionsEntry,
  visibleSessions,
} from "./sessions-store";
import { keepStable, sameStringSet } from "./stable-identity";
import { StartupTimingTracker } from "./startup-timing";
import { StreamRateTracker, SubagentRateFolder } from "./stream-rate";
import {
  DEFAULT_TAB_THEME,
  type TabTheme,
  clearTabTheme,
  readTabTheme,
  writeTabTheme,
} from "./tab-theme";
import {
  FONT_FAMILY,
  FONT_FAMILY_STACK,
  FONT_SCALE,
  FONT_SCALE_ZOOM,
  type FontFamily,
  type FontScale,
  type Theme,
  type ThemeStyle,
  isFontFamily,
  isFontScale,
  themeForStyle,
} from "./theme";
import { AboutModal } from "./ui/about";
import {
  type StatusWait,
  type TurnStatus,
  busyStatusLabel,
  statusPhase,
  statusWait,
  stuckStatusLabel,
} from "./ui/busy-status";
import {
  NoticeCard,
  type NoticeSeverity,
  fullerSubagentTask,
  isSubagentTool,
  noticeName,
  parseEditResult,
  subagentCallDetails,
  subagentStartLabel,
} from "./ui/cards";
import type { ChangelogState } from "./ui/changelog";
import { StoredComposer as Composer } from "./ui/composer";
import { createComposerDraft } from "./ui/composer-draft";
import { ContextPanel } from "./ui/context-panel";
import { JobsPop } from "./ui/jobs-pop";
import { activationHandler } from "./ui/keyboard";
import { McpSetupDialog } from "./ui/mcp-setup";
import { SettingsModal, type PageId as SettingsPageId } from "./ui/settings";
import { localizeShortcutText } from "./ui/shortcut";
import { Sidebar } from "./ui/sidebar";
import { Splash, shouldShowSplash } from "./ui/splash";
import {
  StartupFailure,
  type StartupFailureState,
  coerceStartupFailure,
} from "./ui/startup-failure";
import { StartupLoadingOverlay } from "./ui/startup-loading";
import { StatusBar } from "./ui/statusbar";
import { type ClearTabsScope, TabMenu, getTabsToClear } from "./ui/tab-menu";
import {
  AssistantMsg,
  CheckpointApprovalCard,
  ChoiceApprovalCard,
  ConfirmApprovalCard,
  PathAccessApprovalCard,
  PlanApprovalCard,
  RevisionApprovalCard,
  TurnDivider,
  UserMsg,
} from "./ui/thread";
import { getThreadMaxWidth } from "./ui/thread-layout";
import {
  type JumpTarget,
  callAnchor,
  endJumpAlignment,
  jumpToAnchor,
  noticeAnchor,
} from "./ui/transcript-jump";
import { useAutoCollapse } from "./ui/useAutoCollapse";
import { useAutoScroll } from "./ui/useAutoScroll";
import { useDisableTextAssist } from "./ui/useDisableTextAssist";
import { useIsScrollable } from "./ui/useIsScrollable";
import { useResizable } from "./ui/useResizable";
import { useTurnWatchdog } from "./ui/useTurnWatchdog";
import { WorkdirPop } from "./ui/workdir-pop";
import { anyVoiceModelDownloaded } from "./voice/models";
import { areWorkspacesLoaded, isWorkspaceRevealReady } from "./workspace-loading";
import { normalizeWorkspacePath, toWorkspaceRelative } from "./workspace-path";

/** Thumbnail icons for queued audio/video attachments — real data-URL images so
 *  the existing pending/queue <img> renders need no per-kind branches. */
const AUDIO_ATTACH_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="6" fill="#2b2b30"/><text x="20" y="27" font-family="sans-serif" font-size="20" font-weight="600" text-anchor="middle" fill="#d0d0d6">A</text></svg>',
  );
const VIDEO_ATTACH_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="6" fill="#2b2b30"/><text x="20" y="27" font-family="sans-serif" font-size="20" font-weight="600" text-anchor="middle" fill="#d0d0d6">V</text></svg>',
  );

const RIGHT_SIDEBAR_COLLAPSE_WIDTH = 1120;

/** Settings saves coalesce over this window: a burst of clicks becomes one
 *  `settings_save`, so the UI never queues a round-trip per keystroke/click. */
const SETTINGS_SAVE_DEBOUNCE_MS = 200;

/** How long an unconfirmed session mutation may stay silent before the channel asks
 *  for the authoritative list. It only REQUESTS a snapshot; it never reveals a row,
 *  so unlike the old wall-clock release it cannot resurrect a real delete. */
const INTENT_RECONCILE_TIMEOUT_MS = 10_000;

/** How long a locally-written settings field stays authoritative against the
 *  daemon's `$settings` echo. Long enough to outlast any in-flight echo, short
 *  enough that a value the daemon normalizes (a clamped number) still settles. */
const SETTINGS_OVERRIDE_TTL_MS = 2000;

/** Structural equality for settings values (primitives, arrays, plain objects).
 *  Used to tell an echo that already reflects a local write from a stale one. */
export function settingsValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => settingsValueEqual(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => settingsValueEqual(left[key], right[key]));
}
const LEFT_SIDEBAR_COLLAPSE_WIDTH = 760;

const RESPONSIVE_STAGE = {
  WIDE: "wide",
  COMPACT: "compact",
  NARROW: "narrow",
} as const;

type ResponsiveStage = (typeof RESPONSIVE_STAGE)[keyof typeof RESPONSIVE_STAGE];

function responsiveStage(width: number): ResponsiveStage {
  if (width < LEFT_SIDEBAR_COLLAPSE_WIDTH) return RESPONSIVE_STAGE.NARROW;
  if (width < RIGHT_SIDEBAR_COLLAPSE_WIDTH) return RESPONSIVE_STAGE.COMPACT;
  return RESPONSIVE_STAGE.WIDE;
}

export type SubagentToolActivity = {
  callId: string;
  name: string;
  args?: string;
  status: "running" | "done" | "failed";
};

export type SubagentActivityRow = {
  id: string;
  kind: "thinking" | "process";
  text: string;
  status?: "running" | "done" | "failed";
};

export type SubagentRunProgress = {
  runId: string;
  task: string;
  skillName?: string;
  model?: string;
  phase?: "exploring" | "summarising";
  status: "running" | "done" | "failed";
  iter?: number;
  elapsedMs?: number;
  contextTokens?: number;
  /** Child loop's enforced context cap — denominator for the ctx x/y meter. */
  contextMax?: number;
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
  turns?: number;
  costUsd?: number;
  billingKind?: "usd" | "quota" | "none";
  quotaUsedPct?: number;
  maxToolIters?: number;
  maxElapsedMs?: number;
  budgetExhausted?: "tool-iters" | "elapsed";
  error?: string;
  thought?: string;
  recentRows?: SubagentActivityRow[];
  tools: SubagentToolActivity[];
};

export type AssistantSegment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; startedAt?: number; durationMs?: number }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      startedAt: number;
      result?: string;
      ok?: boolean;
      durationMs?: number;
      /** Transient mid-run stdout/stderr for blocking shell tools — streamed via
       *  `tool.output` events and rendered in the card's output stream until
       *  tool.result lands (never persisted; a reload shows only the result). */
      liveOutput?: string;
      subagentRuns?: SubagentRunProgress[];
    }
  | { kind: "warning"; id: string; text: string; severity?: "low" | "high" }
  | { kind: "image"; dataUrl: string; mimeType: string };

export type SkillOrigin = {
  name: string;
};

export type ChatMessage =
  | {
      kind: "user";
      text: string;
      clientId: string;
      turn: number;
      skill?: SkillOrigin;
      images?: string[];
      /** Machine-written record (image tool feedback): not a prompt, so no Events row. */
      injected?: true;
      /** When the record was written (epoch ms): the Events timeline's coordinate. */
      ts?: number;
    }
  | {
      kind: "assistant";
      turn: number;
      segments: AssistantSegment[];
      pending: boolean;
      /** Set when a boundary card (compaction, …) was inserted right after this
       *  card: later streaming output opens a NEW card below the boundary rather
       *  than re-opening this one. */
      closed?: boolean;
      ts?: number;
    }
  | {
      kind: "notice";
      id: string;
      text: string;
      severity: NoticeSeverity;
      turn?: number;
      ts?: number;
      /** Compaction card state: true = in progress (throbber), false = done. */
      running?: boolean;
      /** Which compaction path owns the card — completion signals are keyed to it. */
      trigger?: "manual" | "auto" | "overflow";
    };

export type PendingConfirm = {
  id: number;
  kind: "run_command" | "run_background" | "outlook_send";
  command: string;
  prompt: import("@reasonix/core-utils").ApprovalPrompt;
};

export type PendingPathAccess = {
  id: number;
  path: string;
  intent: "read" | "write";
  toolName: string;
  sandboxRoot: string;
  allowPrefix: string;
  prompt: import("@reasonix/core-utils").ApprovalPrompt;
};

export type PendingChoice = PickerWindow & {
  id: number;
  question: string;
  options: { id: string; title: string; summary?: string }[];
  allowCustom: boolean;
};

export type PendingPlan = PickerWindow & {
  id: number;
  plan: string;
  summary?: string;
  steps?: PlanStep[];
  /** Stable submit_plan tool call that anchors live progress in the chat timeline. */
  callId?: string;
};

export type ActivePlan = {
  plan: string;
  summary?: string;
  steps: PlanStep[];
  completedStepIds: string[];
  stepResults: Record<string, string>;
  status?: "active" | "finished" | "cancelled";
  /** Stable submit_plan tool call that anchors live progress in the chat timeline. */
  callId?: string;
};

export type PendingCheckpoint = {
  id: number;
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
  completed: number;
  total: number;
};

export type PendingRevision = PickerWindow & {
  id: number;
  reason: string;
  remainingSteps: PlanStep[];
  /** The plan's current remaining steps at proposal time, for the rewrite diff. */
  previousSteps?: PlanStep[];
  summary?: string;
};

export type UsageStats = {
  totalCostUsd: number;
  /** Cost of the most recent model call — the statusbar "this turn" figure for
   *  pay-per-token providers (DeepSeek). Distinct from the cumulative session total. */
  lastCallCostUsd: number;
  /** Per-provider cumulative costs in each provider's native unit (USD for
   *  token-priced APIs, plan-window % for quota APIs). Never converted between
   *  providers. Keyed by provider id ("deepseek" | "openai" | "ollama" | "gemini"). */
  costByProvider?: Record<string, SessionProviderCost>;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  lastCallCacheHit: number | null;
  lastCallCacheMiss: number | null;
  /** System prompt + tool specs — constant for the session, sent on tab open. */
  reservedTokens: number;
  /** Current conversation log tokens, refreshed by the desktop sidecar. */
  liveLogTokens: number;
  /** Model context cap — meter denominator. */
  ctxMax?: number;
  /** Current-session shell-output filtering totals — the statusbar "saved"
   *  chip's numerator source. Undefined = this session has no shell telemetry
   *  yet, chip hidden. Resets on session switch. */
  shellOutputRawTokens?: number;
  shellOutputShownTokens?: number;
};

export type SessionInfo = {
  name: string;
  messageCount: number;
  mtime: string;
  /** Explicit last-activity epoch-ms from the session's meta — drives the
   *  sidebar's relative-time label and wins over a stale filesystem mtime. */
  updatedAt?: number;
  /** Creation epoch-ms — the sidebar's primary sort key (newest-created
   *  first). Falls back to the name-embedded timestamp, then mtime. */
  createdAt?: number;
  summary?: string;
  workspaceStatus?: "matched" | "legacy_missing_meta";
};

/** A session-list mutation in flight for a channel. One field carries the whole
 *  fact, so the indicator cannot be told one thing and the "what are we waiting
 *  for" another. `awaitingName` is present only for "create": the indicator
 *  clears when that session is listed, and is omitted when the target is
 *  unknown (then the first snapshot settles it). */
export type SessionMutation =
  | { kind: "delete" }
  | { kind: "clear" }
  | { kind: "create"; awaitingName?: string };

/** THE wording for an in-flight session mutation, and the only place it is
 *  defined. Rendered by exactly one surface: the main-area pill. */
export function sessionMutationLabel(mutation: SessionMutation, count: number): string {
  switch (mutation.kind) {
    case "create":
      return t("app.creatingSession");
    case "clear":
      return t("app.deletingSessions.bulk", { count });
    default:
      return t("app.deletingSessions.one");
  }
}

export {
  parseSessionTimestamp,
  sessionCreationTime,
  sessionRecency,
  sortSessionsByCreationDescending,
  sortSessionsDescending,
} from "@reasonix/core-utils";

export type Settings = SettingsPayload;

export type BalanceInfoItem = {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
};

export type Balance = {
  currency: string;
  total: number;
  isAvailable: boolean;
  infos: BalanceInfoItem[];
};

type MentionResults = { nonce: number; query: string; results: string[] };
type MentionPreviewState = {
  nonce: number;
  path: string;
  head: string;
  totalLines: number;
};

export type QueuedSend = {
  text: string;
  images?: { id: string; thumbnail: string; wire?: UserImageAttachment }[];
};

type State = {
  ready: boolean;
  needsSetup: boolean;
  busy: boolean;
  /** True between an optimistic send and the daemon's $turn_started ack (or
   *  its $turn_complete rejection). Visual pending spin only — turn state
   *  itself is daemon-owned; busy never flips on a local guess. */
  awaitingAck: boolean;
  /** True while the daemon folds the context. A fold is a busy stretch with no
   *  turn of its own, so the composer queues against it and the drain waits:
   *  a message typed mid-fold lands as a normal next turn once it settles. */
  compacting: boolean;
  model?: string;
  currentSession?: string;
  messages: ChatMessage[];
  /** Bumped whenever a card, segment, flag or tool result changes — never by text
   *  streaming into a segment that already exists. A memoized row list can key on
   *  this instead of the array identity, which changes on every delta frame. */
  messagesVersion: number;
  pendingConfirms: PendingConfirm[];
  pendingPathAccess: PendingPathAccess[];
  pendingChoices: PendingChoice[];
  pendingPlans: PendingPlan[];
  pendingCheckpoints: PendingCheckpoint[];
  pendingRevisions: PendingRevision[];
  activePlan: ActivePlan | null;
  planHistory?: import("@reasonix/core-utils").PlanHistoryItem[];
  planDetails?: Record<string, import("@reasonix/core-utils").PlanDetail>;
  usage: UsageStats;
  /** True while the loaded transcript is only the newest page: the transcript then
   *  offers a load-older control instead of silently hiding the rest. */
  historyHasOlder: boolean;
  /** Wire records the loaded transcript was built from, counted from the session's
   *  end — the cursor the load-older command asks the page above. */
  historyLoaded: number;
  workspaceInitializationRevision: number;
  settings: Settings | null;
  balance: Balance | null;
  codexQuota: CodexQuota | null;
  /** True between a statusbar chip click and the $codex_quota reply — the chip shows a refresh indicator. */
  codexQuotaRefreshing: boolean;
  /** Why the last quota fetch produced no data — shown in the chip tooltip. */
  codexQuotaReason: string | null;
  /** Cloud Ollama usage (session + weekly windows) for Ollama-provider tabs. */
  ollamaQuota: OllamaQuota | null;
  /** True between a statusbar chip click and the $ollama_quota reply. */
  ollamaQuotaRefreshing: boolean;
  /** Why the last Ollama usage fetch produced no data — shown in the chip tooltip. */
  ollamaQuotaReason: string | null;
  /** Google Antigravity (Gemini Code Assist) plan + per-model usage. */
  antigravityQuota: AntigravityQuota | null;
  /** True between a statusbar chip click and the $antigravity_quota reply. */
  antigravityQuotaRefreshing: boolean;
  /** Why the last Antigravity quota fetch produced no data — shown in the chip tooltip. */
  antigravityQuotaReason: string | null;
  /** Z.AI GLM Coding Plan usage (5-hour + weekly) for zai-provider tabs. */
  zaiQuota: ZaiQuota | null;
  /** True between a statusbar chip click and the $zai_quota reply. */
  zaiQuotaRefreshing: boolean;
  /** Why the last Z.AI usage fetch produced no data — shown in the chip tooltip. */
  zaiQuotaReason: string | null;
  /** OpenCode Go plan usage (5-hour + weekly + monthly) for opencode-provider tabs. */
  opencodeQuota: OpencodeQuota | null;
  /** True between a statusbar chip click and the $opencode_quota reply. */
  opencodeQuotaRefreshing: boolean;
  /** Why the last OpenCode usage fetch produced no data — shown in the chip tooltip. */
  opencodeQuotaReason: string | null;
  mentionResults: MentionResults | null;
  mentionPreview: MentionPreviewState | null;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  /** The session-start picker ($mcp_setup): the configured servers plus the subagent
   *  pre-fill; null when this chat is not gating. */
  mcpSetup: { servers: McpSetupServer[]; subagents: boolean } | null;
  /** Bumped per `$mcp_setup` so the picker remounts on a re-issued gate (a failed
   *  confirm re-arms it) instead of sitting on its own "starting" state. */
  mcpSetupRevision: number;
  mcpExtensionStatus: McpExtensionStatus | null;
  mcpExtensionCheck: McpExtensionCheck | null;
  mailAuth: MailAuthState | null;
  playwrightBrowserInstall: PlaywrightBrowserInstall | null;
  skills: SkillInfo[];
  /** Files the agent has read or modified this session — paths as the tool args provided them. */
  sessionFiles: SessionFile[];
  /** Plan/choice/fold verdicts recorded for the Events tab. Turns are not here:
   *  they are read from the transcript, which a rewind already prunes. */
  sessionEvents: SessionEventRecord[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  /** Outcome of the last memory write/delete/import RPC — shown as a transient banner in the memory panel. */
  memoryResult: { ok: boolean; message: string } | null;
  jobs: JobInfo[];
  /** Live "skill running" indicator — set when a `skill_run` RPC dispatches, cleared on `$turn_complete`. */
  activeSkill: SkillOrigin | null;
  /** Terminal outcome of the most recent turn — gates success feedback and stop cards. */
  lastTurnOutcome: TurnOutcome | null;
  /** Messages typed while busy=true — auto-sent FIFO once the current turn completes. Cleared on `clear`, `rpc_exit`, `session_loaded`. */
  queuedSends: QueuedSend[];
  /** Populated by $retry_result — component useEffect reads and sets composer draft. */
  retryText?: string;
  retryNonce: number;
  /** True between oauth_begin_result and the flow's terminal state — settings card spinner. */
  oauthWaiting: boolean;
  /** True between gemini_oauth_begin_result and the flow's terminal state — settings card spinner. */
  antigravityOAuthWaiting: boolean;
  /** True between opencode_oauth_begin_result and the flow's terminal state — settings card spinner. */
  opencodeOAuthWaiting: boolean;
  /** True between mimo_oauth_begin_result and the flow's terminal state — settings card spinner. */
  mimoOAuthWaiting: boolean;
  /** Current turn's activity status — shown as a live indicator below the streaming assistant message. */
  turnStatus: TurnStatus | null;
  /** Tool name currently being prepared/called — displayed in the turn status line. */
  turnStatusTool: string | null;
  /** Pre-first-byte wait reported by a `status` event. Read only while turnStatus is
   *  "waiting_model", so a stale note can never relabel another phase. */
  turnStatusWait: StatusWait | null;
  /** Timestamp (ms) of the last model/tool event — used to detect "stuck" state. */
  turnLastEventMs: number;
  /** Elapsed ms since the turn started (computed from turnLastEventMs in the component). */
  turnElapsedMs: number;
};

export type SessionFile = {
  path: string;
  /** "c": pulled into context (read_file). "m": modified by the agent (edit_file / write_file / multi_edit). */
  status: "c" | "m";
};

type DeltaBatchItem = {
  turn: number;
  channel: "content" | "reasoning";
  text: string;
};

type Action =
  | { t: "send_user"; text: string; clientId: string; images?: string[] }
  | { t: "start_skill"; skill: SkillOrigin; args?: string; clientId: string }
  | { t: "incoming"; event: IncomingEvent }
  | { t: "batch_delta"; items: DeltaBatchItem[] }
  | { t: "rpc_exit"; code: number | null }
  | { t: "clear" }
  | { t: "resolve_confirm"; id: number }
  | { t: "resolve_path_access"; id: number }
  | { t: "resolve_choice"; id: number; verdict: ChoiceVerdict }
  | { t: "resolve_plan"; id: number; verdict: PlanVerdict }
  | { t: "resolve_checkpoint"; id: number; verdict: CheckpointVerdict }
  | { t: "resolve_revision"; id: number; verdict: RevisionVerdict }
  | { t: "dismiss_memory_result" }
  | { t: "mention_results"; results: MentionResults }
  | { t: "mention_preview"; preview: MentionPreviewState }
  | { t: "enqueue_send"; send?: QueuedSend | string; text?: string }
  | { t: "dequeue_send"; index: number }
  | { t: "shift_queued_send" }
  | { t: "settings_patch"; patch: SettingsPatch }
  | { t: "workspace_recent_removed"; path: string }
  | { t: "oauth_waiting"; waiting: boolean }
  | { t: "antigravity_oauth_waiting"; waiting: boolean }
  | { t: "opencode_oauth_waiting"; waiting: boolean }
  | { t: "mimo_oauth_waiting"; waiting: boolean }
  | { t: "codex_quota_refreshing" }
  | { t: "ollama_quota_refreshing" }
  | { t: "antigravity_quota_refreshing" }
  | { t: "zai_quota_refreshing" }
  | { t: "opencode_quota_refreshing" }
  | { t: "release_stale_send" }
  | { t: "push_notice"; text: string; severity?: NoticeSeverity };

export function sanitizeSettingsPatch(patch: SettingsPatch): Partial<Settings> {
  const {
    metasoApiKey: _metaso,
    baiduApiKey: _baidu,
    tavilyApiKey: _tavily,
    perplexityApiKey: _perplexity,
    exaApiKey: _exa,
    braveApiKey: _brave,
    ollamaApiKey: _ollama,
    zaiApiKey: _zai,
    opencodeApiKey: _opencode,
    typesafeApiKey: _typesafe,
    mimoApiKey: _mimo,
    experientialApiKey: _experientialApiKey,
    ollamaBaseUrl: _ollamaBaseUrl,
    ollamaGeneration: _ollamaGeneration,
    webSearchEndpoint,
    opencodeBaseUrl,
    mimoBaseUrl,
    experientialBaseUrl,
    ...rest
  } = patch;
  const sanitized: Partial<Settings> = { ...rest };
  if (webSearchEndpoint !== undefined) {
    sanitized.webSearchEndpoint = webSearchEndpoint ?? undefined;
  }
  if (_ollamaBaseUrl !== undefined) {
    sanitized.ollamaBaseUrl = _ollamaBaseUrl ?? undefined;
  }
  if (opencodeBaseUrl !== undefined) {
    sanitized.opencodeBaseUrl = opencodeBaseUrl ?? undefined;
  }
  if (mimoBaseUrl !== undefined) {
    sanitized.mimoBaseUrl = mimoBaseUrl ?? undefined;
  }
  if (experientialBaseUrl !== undefined) {
    sanitized.experientialBaseUrl = experientialBaseUrl ?? undefined;
  }
  return sanitized;
}

function nextMessageTurn(messages: ChatMessage[]): number {
  const lastTurn = messages.reduce((max, m) => {
    if (m.kind === "user" || m.kind === "assistant") return Math.max(max, m.turn);
    return max;
  }, 0);
  return lastTurn + 1;
}

/** Events that render into a turn's assistant card. Ensured centrally so a
 *  dropped `model.turn.started` cannot silently swallow them. */
const ASSISTANT_CARD_EVENTS: ReadonlySet<IncomingEvent["type"]> = new Set([
  "model.delta",
  "model.final",
  "tool.preparing",
  "tool.intent",
]);

/** Index of the turn's LAST assistant card — the card a boundary/annotation
 *  segment (e.g. a late warning) belongs to. -1 when the turn has no card yet. */
function lastAssistantIndex(messages: ChatMessage[], turn: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === "assistant" && m.turn === turn) return i;
  }
  return -1;
}

/** Index of the turn's last card when nothing has sealed it — where the turn's
 *  ANNOTATIONS belong (a late warning still attaches to the turn it describes,
 *  even after later turns exist). Streamed CONTENT must not use this: that card
 *  may sit above a boundary or a newer card, so content uses
 *  {@link openAssistantIndex} instead. */
function unclosedTurnCardIndex(messages: ChatMessage[], turn: number): number {
  const idx = lastAssistantIndex(messages, turn);
  const card = idx >= 0 ? messages[idx] : undefined;
  return card?.kind === "assistant" && !card.closed ? idx : -1;
}

/** Index of the turn's streaming target — the transcript TAIL, when that tail is
 *  an unclosed card of this turn — or -1 when output must open a fresh card.
 *  Everything above the tail is already on screen (a boundary notice, a newer
 *  user bubble, an older card), so growing an earlier card would place the
 *  turn's output ABOVE that card instead of beside it: invisible, and that is
 *  exactly what made every card produced after a compaction disappear.
 *
 *  A settled (mid-turn `model.final`) card is still open, so the next delta
 *  re-opens it; only a seal forces a new card. */
function openAssistantIndex(messages: ChatMessage[], turn: number): number {
  const idx = messages.length - 1;
  const card = messages[idx];
  if (card?.kind !== "assistant" || card.closed || card.turn !== turn) return -1;
  return idx;
}

/** Index of the single in-flight assistant card (the last one still pending),
 *  or -1 when no turn is actively streaming. */
function pendingAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind === "assistant" && m.pending) return i;
  }
  return -1;
}

/** Index of the card a streamed token lands in — the transcript tail, when that
 *  tail is an assistant card nothing has sealed — or -1 when a delta would open a
 *  fresh card. This is the only row a delta can change, so the transcript renders
 *  it outside the memoized history. */
export function streamingTailIndex(messages: readonly ChatMessage[]): number {
  const idx = messages.length - 1;
  const card = messages[idx];
  if (card?.kind !== "assistant" || card.closed) return -1;
  return idx;
}

/** When a record is written. Monotone within the process, so two records created in
 *  the same millisecond still order by write order: a tie would collapse the
 *  conversation's timeline and list them out of order. */
let lastWriteStamp = 0;
export function writeStamp(): number {
  lastWriteStamp = Math.max(Date.now(), lastWriteStamp + 1);
  return lastWriteStamp;
}

/** Append one Events-tab entry, or refine the entry that id already wrote: a
 *  fold is recorded when it starts and settled when its card resolves, and the
 *  pair must stay ONE row. */
function recordSessionEvent(
  events: readonly SessionEventRecord[],
  event: SessionEventRecord,
): SessionEventRecord[] {
  const index = events.findIndex((existing) => existing.id === event.id);
  if (index < 0) return [...events, event];
  const next = [...events];
  next[index] = { ...events[index], ...event };
  return next;
}

/** A fold's event id, derived from its transcript card so the start and the
 *  settle of one fold address the same row. */
function compactionEventId(noticeId: string): string {
  return `compaction-${noticeId}`;
}

/** A subagent spawn's event id, derived from its tool call, so the row written
 *  when the call is created and the verdict that settles it are ONE row. */
function subagentEventId(callId: string): string {
  return `subagent-${callId}`;
}

/** Record a subagent spawn: what it was asked to do, and the card it became.
 *  A spawn outlives the turn that commissioned it (the child keeps working
 *  after the parent's card scrolls away), so the timeline keeps it. */
function recordSubagentSpawn(
  state: Pick<State, "messages" | "sessionEvents">,
  turn: number,
  callId: string,
  name: string,
  args: string,
): SessionEventRecord[] {
  const { instruction, skillName } = subagentCallDetails(name, args);
  // A re-announced spawn keeps the stamp and turn of the row it already wrote, so
  // the timeline does not shuffle under the reader.
  const existing = state.sessionEvents.find((event) => event.id === subagentEventId(callId));
  return recordEvent(
    state,
    {
      id: subagentEventId(callId),
      type: "subagent",
      outcome: "started",
      label: skillName,
      // Only a real instruction is worth keeping: an argless call must not record
      // its skill name as if it were the task.
      ...(instruction ? { detail: instruction } : {}),
      // The subagent card itself, not the prompt that started the turn.
      ...callAnchor(callId),
    },
    { ts: existing?.ts ?? writeStamp(), turn: existing?.turn ?? turn },
  );
}

/** Settle a subagent's Events row with the verdict its card carries: same row,
 *  same stamp, because the spawn did not happen twice. */
function settleSubagentEvent(
  state: Pick<State, "messages" | "sessionEvents">,
  callId: string,
  ok: boolean,
): SessionEventRecord[] {
  const event = state.sessionEvents.find((existing) => existing.id === subagentEventId(callId));
  if (!event) return state.sessionEvents;
  return recordSessionEvent(state.sessionEvents, { ...event, outcome: ok ? "done" : "failed" });
}

/** The tool call of the gate currently asking, read from the transcript: the
 *  resolved gate's card IS that segment, and only a plan carries its call id on
 *  the wire, so a choice has to be looked up where its card is rendered. */
function pendingGateCallId(messages: readonly ChatMessage[], tool: string): string | undefined {
  return toolCallId(messages, tool, { unsettled: true });
}

/** A tool call's id in the transcript, newest first. `turn` scopes the search to
 *  one turn; `unsettled` keeps it to a call still waiting for its result, which is
 *  the gate that is asking right now. */
function toolCallId(
  messages: readonly ChatMessage[],
  tool: string,
  options: { turn?: number; unsettled?: boolean } = {},
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.kind !== "assistant") continue;
    if (options.turn !== undefined && message.turn !== options.turn) continue;
    for (let k = message.segments.length - 1; k >= 0; k -= 1) {
      const segment = message.segments[k];
      if (segment?.kind !== "tool" || segment.name !== tool || !segment.callId) continue;
      if (options.unsettled && segment.result !== undefined) continue;
      return segment.callId;
    }
  }
  return undefined;
}

/** Both ids a plan row has to carry to land on its card: the gate's (what a
 *  reloaded transcript calls the card) and the transcript's live one. */
function planAnchors(
  gateCallId: string | undefined,
  wireCallId: string | undefined,
): Pick<SessionEventRecord, "anchor" | "anchorAlias"> {
  const gate = callAnchor(gateCallId).anchor;
  const wire = callAnchor(wireCallId).anchor;
  // The gate's id stays primary (it survives a reload); without one the live id is
  // all this row has, and it is better than a jump to the prompt bubble.
  const anchor = gate ?? wire;
  return {
    ...(anchor ? { anchor } : {}),
    ...(gate && wire && wire !== gate ? { anchorAlias: wire } : {}),
  };
}

/** Record one Events-tab entry. Every event needs a stamp and the turn it belonged
 *  to, and those are exactly the parts a new event type would forget to fill in —
 *  so one function supplies them. `at` overrides either, for a fold whose row must
 *  carry its transcript card's stamp, or a row that already knows its turn. */
function recordEvent(
  state: Pick<State, "messages" | "sessionEvents">,
  event: Omit<SessionEventRecord, "ts" | "turn">,
  at?: { ts?: number; turn?: number },
): SessionEventRecord[] {
  return recordSessionEvent(state.sessionEvents, {
    ...event,
    ts: at?.ts ?? writeStamp(),
    turn: at?.turn ?? currentTurnForNotice(state.messages),
  });
}

/** Settle a fold in place: its card carries the result, and its Events row learns
 *  what the fold did. Both always move together, so a fold cannot keep a stale
 *  row or a card that disagrees with the row's outcome. */
function settleCompactionCard(
  state: Pick<State, "messages" | "sessionEvents">,
  index: number,
  patch: { text: string; severity: NoticeSeverity },
): Pick<State, "messages" | "sessionEvents"> {
  const card = state.messages[index];
  // A notice that is not a fold settles without an Events row to refine; every
  // running compaction card carries its trigger from creation.
  if (card?.kind !== "notice" || !card.trigger) return state;
  return {
    messages: state.messages.map((message, i) =>
      i === index && message.kind === "notice" ? { ...message, ...patch, running: false } : message,
    ),
    sessionEvents: recordEvent(
      state,
      {
        id: compactionEventId(card.id),
        type: "compaction",
        outcome: card.trigger,
        label: patch.text,
        anchor: noticeAnchor(card.id),
      },
      { ts: card.ts ?? writeStamp(), turn: card.turn ?? 0 },
    ),
  };
}

/** Fire a `*_sync` command once per distinct (session, payload) pair. Both
 *  session sidecars are idempotent full-list overwrites, so re-sending is
 *  harmless but wasteful; nothing is sent before the session is known, or an
 *  empty payload would wipe what the daemon just loaded from disk. One hook for
 *  both sidecars keeps that guard from drifting between them. */
function useSidecarSync(
  session: string | undefined,
  command: OutgoingCommand,
  send: (command: OutgoingCommand) => void,
): void {
  const syncedRef = useRef("");
  useEffect(() => {
    if (!session) return;
    const sig = `${session}\n${JSON.stringify(command)}`;
    if (sig === syncedRef.current) return;
    syncedRef.current = sig;
    send(command);
  }, [session, command, send]);
}

/** A fresh, empty assistant card for a turn — pending until its turn settles. */
function newAssistantCard(turn: number): Extract<ChatMessage, { kind: "assistant" }> {
  return { kind: "assistant", turn, segments: [], pending: true, ts: writeStamp() };
}

/** Apply `fn` to the turn's OPEN assistant card, opening a fresh card when a
 *  boundary has closed the previous one; every other card is left untouched.
 *  This is the single streaming target — every delta/final/tool event routes
 *  through it, so a turn's output is never written into a boundary-closed card
 *  and never fanned out across cards. */
function mapActiveAssistant(
  messages: ChatMessage[],
  turn: number,
  fn: (m: Extract<ChatMessage, { kind: "assistant" }>) => ChatMessage,
): ChatMessage[] {
  const idx = openAssistantIndex(messages, turn);
  const card = idx >= 0 ? messages[idx] : undefined;
  if (card?.kind === "assistant") {
    const next = [...messages];
    next[idx] = fn(card);
    return next;
  }
  return appendAssistantCardBelow(messages, turn, fn);
}

/** Close the boundary-crossed card of `turn` — stop its spinner, stamp a trailing
 *  reasoning run, and mark it CLOSED so later streaming opens a NEW card below the
 *  boundary instead of re-opening this one. No-op when the turn has no card or it
 *  is already closed. */
function closeTurnCard(messages: ChatMessage[], turn: number): ChatMessage[] {
  const idx = lastAssistantIndex(messages, turn);
  const card = idx >= 0 ? messages[idx] : undefined;
  if (card?.kind !== "assistant" || card.closed) return messages;
  const next = [...messages];
  next[idx] = {
    ...card,
    closed: true,
    pending: false,
    segments: closeTrailingReasoning(card.segments),
  };
  return next;
}

/** Open the turn's next assistant card below whatever sealed the previous one.
 *  The single creator of a successor card: the sealed card is settled first
 *  (spinner off, trailing reasoning stamped) so two cards of one turn never
 *  render as live at once. */
function appendAssistantCardBelow(
  messages: ChatMessage[],
  turn: number,
  fn: (m: Extract<ChatMessage, { kind: "assistant" }>) => ChatMessage = (m) => m,
): ChatMessage[] {
  return [...closeTurnCard(messages, turn), fn(newAssistantCard(turn))];
}

/** Append the event's assistant card when the turn has no OPEN card; a no-op
 *  otherwise. After a boundary card closes the active card, the next streaming
 *  event opens a fresh card below the boundary. */
function ensureAssistantTurn(state: State, ev: IncomingEvent): State {
  if (!ASSISTANT_CARD_EVENTS.has(ev.type)) return state;
  const turn = (ev as { turn: number }).turn;
  if (openAssistantIndex(state.messages, turn) >= 0) return state;
  return { ...state, messages: appendAssistantCardBelow(state.messages, turn) };
}

/** The turn a card is anchored to. Only user/assistant cards and notice cards
 *  carry a turn; a notice without one is treated as belonging to turn 0. */
function cardTurn(m: ChatMessage): number {
  if (m.kind === "notice") return m.turn ?? 0;
  return m.turn;
}

/** Merge `extras` into a turn-ordered `base`: each extra lands at the END of its
 *  own turn's group (before the first base card with a greater turn), keeping the
 *  extras' order. Used to carry notice cards back into a rebuilt conversation so
 *  they sit beside the turn they annotate instead of being forced to the tail. */
function mergeByTurn(base: ChatMessage[], extras: ChatMessage[]): ChatMessage[] {
  if (extras.length === 0) return base;
  // One pass instead of one insertion per extra: a rebuilt conversation carrying
  // many notices used to re-scan and re-copy the whole list per notice. A stable
  // sort by turn keeps equal-turn extras in arrival order, which is exactly what
  // repeated end-of-group insertion produced.
  const ordered = [...extras].sort((a, b) => cardTurn(a) - cardTurn(b));
  const out: ChatMessage[] = [];
  let cursor = 0;
  for (const extra of ordered) {
    const turn = cardTurn(extra);
    while (cursor < base.length && cardTurn(base[cursor]!) <= turn) {
      out.push(base[cursor]!);
      cursor += 1;
    }
    out.push(extra);
  }
  while (cursor < base.length) {
    out.push(base[cursor]!);
    cursor += 1;
  }
  return out;
}

let noticeSequence = 0;
function nextNoticeId(): string {
  noticeSequence += 1;
  return `notice-${Date.now().toString(36)}-${noticeSequence}`;
}

export function hasPendingIntervention(state: {
  pendingConfirms?: readonly unknown[];
  pendingPathAccess?: readonly unknown[];
  pendingChoices?: readonly unknown[];
  pendingPlans?: readonly unknown[];
  pendingCheckpoints?: readonly unknown[];
  pendingRevisions?: readonly unknown[];
}): boolean {
  return Boolean(
    (state.pendingChoices && state.pendingChoices.length > 0) ||
      (state.pendingConfirms && state.pendingConfirms.length > 0) ||
      (state.pendingPathAccess && state.pendingPathAccess.length > 0) ||
      (state.pendingPlans && state.pendingPlans.length > 0) ||
      (state.pendingCheckpoints && state.pendingCheckpoints.length > 0) ||
      (state.pendingRevisions && state.pendingRevisions.length > 0),
  );
}

function turnStatusAfterResolve(
  nextState: Parameters<typeof hasPendingIntervention>[0],
  currentBusy: boolean,
): State["turnStatus"] {
  if (hasPendingIntervention(nextState)) return "waiting_user";
  return currentBusy ? "calling_tool" : null;
}

/** True when two $jobs snapshots are identical, so the reducer can keep the
 *  prior array reference and avoid re-rendering every assistant row on each
 *  poll tick. Background-job shell cards read this array, so a stable identity
 *  when nothing changed is load-bearing. */
function sameJobInfos(a: JobInfo[], b: JobInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.tabId !== y.tabId ||
      x.command !== y.command ||
      x.pid !== y.pid ||
      x.running !== y.running ||
      x.exitCode !== y.exitCode ||
      x.startedAt !== y.startedAt ||
      x.outputTail !== y.outputTail ||
      x.spawnError !== y.spawnError
    ) {
      return false;
    }
  }
  return true;
}

export function reduceAction(state: State, action: Action): State {
  switch (action.t) {
    case "send_user": {
      return {
        ...state,
        awaitingAck: true,
        messages: [
          ...state.messages,
          {
            kind: "user",
            text: action.text,
            clientId: action.clientId,
            turn: nextMessageTurn(state.messages),
            ts: writeStamp(),
            ...(action.images ? { images: action.images } : {}),
          },
        ],
      };
    }
    case "start_skill": {
      const argsLine = action.args ? ` ${action.args}` : "";
      return {
        ...state,
        awaitingAck: true,
        activeSkill: action.skill,
        messages: [
          ...state.messages,
          {
            kind: "user",
            text: `/${action.skill.name}${argsLine}`,
            clientId: action.clientId,
            turn: nextMessageTurn(state.messages),
            ts: writeStamp(),
            skill: action.skill,
          },
        ],
      };
    }
    case "rpc_exit":
      return {
        ...state,
        ready: false,
        busy: false,
        awaitingAck: false,
        compacting: false,
        activeSkill: null,
        queuedSends: [],
        messages: insertNotice(
          state.messages,
          `reasonix exited (code ${action.code ?? "?"})`,
          "error",
        ),
      };
    case "incoming":
      return applyIncoming(state, action.event);
    case "settings_patch": {
      const modelChanged =
        action.patch.model !== undefined &&
        state.settings?.model !== undefined &&
        action.patch.model !== state.settings.model;
      return state.settings
        ? {
            ...state,
            busy: modelChanged ? false : state.busy,
            awaitingAck: modelChanged ? false : state.awaitingAck,
            turnStatus: modelChanged ? null : state.turnStatus,
            turnStatusTool: modelChanged ? null : state.turnStatusTool,
            settings: { ...state.settings, ...sanitizeSettingsPatch(action.patch) },
          }
        : state;
    }
    case "workspace_recent_removed":
      return state.settings
        ? {
            ...state,
            settings: {
              ...state.settings,
              recentWorkspaces: state.settings.recentWorkspaces.filter((p) => p !== action.path),
            },
          }
        : state;
    case "oauth_waiting":
      return { ...state, oauthWaiting: action.waiting };
    case "antigravity_oauth_waiting":
      return { ...state, antigravityOAuthWaiting: action.waiting };
    case "opencode_oauth_waiting":
      return { ...state, opencodeOAuthWaiting: action.waiting };
    case "mimo_oauth_waiting":
      return { ...state, mimoOAuthWaiting: action.waiting };
    case "codex_quota_refreshing":
      return { ...state, codexQuotaRefreshing: true };
    case "ollama_quota_refreshing":
      return { ...state, ollamaQuotaRefreshing: true };
    case "antigravity_quota_refreshing":
      return { ...state, antigravityQuotaRefreshing: true };
    case "zai_quota_refreshing":
      return { ...state, zaiQuotaRefreshing: true };
    case "opencode_quota_refreshing":
      return { ...state, opencodeQuotaRefreshing: true };
    case "batch_delta": {
      const collapsed: DeltaBatchItem[] = [];
      for (const item of action.items) {
        const last = collapsed[collapsed.length - 1];
        if (last && last.turn === item.turn && last.channel === item.channel) {
          last.text += item.text;
        } else {
          collapsed.push({ ...item });
        }
      }
      if (collapsed.length === 0) return state;
      // Group by turn once — the per-message filter below was O(n·k) per
      // frame and ran for every message (even non-assistant) at transcript
      // scale; a turn-keyed lookup is O(1) per message.
      const byTurn = new Map<number, DeltaBatchItem[]>();
      for (const it of collapsed) {
        const bucket = byTurn.get(it.turn);
        if (bucket) bucket.push(it);
        else byTurn.set(it.turn, [it]);
      }
      // Route through the SAME open-card target every other streaming event
      // uses: a batched frame lands in the turn's open card (opening a fresh one
      // after a boundary closed the previous) instead of fanning out to every
      // card of the turn.
      const lastItem = collapsed[collapsed.length - 1];
      let messages = state.messages;
      for (const [turn, items] of byTurn) {
        messages = mapActiveAssistant(messages, turn, (m) => {
          let segments = m.segments;
          for (const it of items) {
            segments = appendTextSegment(
              segments,
              it.channel === "content" ? "text" : "reasoning",
              it.text,
            );
          }
          // A fresh stream re-opens the card: a mid-turn `model.final` settles the
          // message once per iteration, so a later iteration re-asserts pending.
          return { ...m, segments, pending: true };
        });
      }
      return {
        ...state,
        turnStatus: lastItem?.channel === "reasoning" ? "reasoning" : "responding",
        turnLastEventMs: Date.now(),
        messages,
      };
    }
    case "clear":
      return {
        ...state,
        busy: false,
        awaitingAck: false,
        compacting: false,
        currentSession: undefined,
        messages: [],
        historyHasOlder: false,
        historyLoaded: 0,
        pendingConfirms: [],
        pendingPathAccess: [],
        pendingChoices: [],
        pendingPlans: [],
        pendingCheckpoints: [],
        pendingRevisions: [],
        activePlan: null,
        usage: zeroUsage(),
        sessionFiles: [],
        sessionEvents: [],
        activeSkill: null,
        queuedSends: [],
        retryNonce: 0,
      };
    case "resolve_confirm": {
      const nextConfirms = state.pendingConfirms.filter((c) => c.id !== action.id);
      return {
        ...state,
        pendingConfirms: nextConfirms,
        turnStatus: turnStatusAfterResolve({ ...state, pendingConfirms: nextConfirms }, state.busy),
      };
    }
    case "resolve_path_access": {
      const nextPathAccess = state.pendingPathAccess.filter((p) => p.id !== action.id);
      return {
        ...state,
        pendingPathAccess: nextPathAccess,
        turnStatus: turnStatusAfterResolve(
          { ...state, pendingPathAccess: nextPathAccess },
          state.busy,
        ),
      };
    }
    case "resolve_choice": {
      const nextChoices = state.pendingChoices.filter((c) => c.id !== action.id);
      const pending = state.pendingChoices.find((c) => c.id === action.id);
      const chosen = action.verdict;
      // "What did the user pick" has to survive the card that asked: record the
      // option's wording, not just its id.
      let label = "";
      if (chosen.type === "pick") {
        label = pending?.options.find((o) => o.id === chosen.optionId)?.title ?? chosen.optionId;
      } else if (chosen.type === "text") {
        label = chosen.text;
      }
      const sessionEvents = recordEvent(state, {
        id: `choice-${action.id}`,
        type: "choice",
        outcome: chosen.type,
        ...(label ? { label } : {}),
        ...(pending?.question ? { detail: pending.question } : {}),
        // The options the gate offered, so the record shows what the pick was
        // chosen from — not only what won.
        ...(pending && pending.options.length > 0
          ? { options: pending.options.map((option) => option.title) }
          : {}),
        // The card that asked, so this row jumps to the question it answers.
        ...callAnchor(pendingGateCallId(state.messages, "ask_choice")),
      });
      return {
        ...state,
        pendingChoices: nextChoices,
        sessionEvents,
        turnStatus: turnStatusAfterResolve({ ...state, pendingChoices: nextChoices }, state.busy),
      };
    }
    case "resolve_plan": {
      const removed = state.pendingPlans.find((p) => p.id === action.id);
      // A plan's gate blocks the turn that submitted it, so the row and the card it
      // names share one turn — and scoping the lookup to it keeps an older plan's
      // card out of the alias.
      const turn = currentTurnForNotice(state.messages);
      const sessionEvents = recordEvent(
        state,
        {
          id: `plan-${action.id}`,
          type: "plan",
          outcome: action.verdict.type,
          ...(removed ? { label: removed.summary ?? removed.plan } : {}),
          ...(action.verdict.feedback ? { detail: action.verdict.feedback } : {}),
          // The plan itself and its checklist: a verdict that keeps only the
          // summary line cannot show what was actually agreed to. `body` is stored
          // only when `label` is just the summary, so it is never duplicated.
          ...(removed?.summary ? { body: removed.plan } : {}),
          ...(removed?.steps?.length ? { steps: removed.steps.map((step) => step.title) } : {}),
          // The card this verdict answers, so the row jumps to the plan, not to
          // the prompt that started the turn. Two ids, because the gate and the live
          // transcript name the same tool call differently.
          ...planAnchors(removed?.callId, toolCallId(state.messages, "submit_plan", { turn })),
        },
        { turn },
      );
      let activePlan = state.activePlan;
      if (removed && action.verdict.type === "approve") {
        const pendingSteps = (removed as PendingPlan & { steps?: PlanStep[] }).steps;
        activePlan = {
          plan: removed.plan,
          summary: removed.summary,
          steps: pendingSteps ?? [],
          completedStepIds: [],
          stepResults: {},
          status: "active",
          callId: removed.callId,
        };
      }
      const nextPlans = state.pendingPlans.filter((p) => p.id !== action.id);
      return {
        ...state,
        pendingPlans: nextPlans,
        activePlan,
        sessionEvents,
        turnStatus: turnStatusAfterResolve({ ...state, pendingPlans: nextPlans }, state.busy),
      };
    }
    case "resolve_checkpoint": {
      const nextCheckpoints = state.pendingCheckpoints.filter((c) => c.id !== action.id);
      return {
        ...state,
        pendingCheckpoints: nextCheckpoints,
        turnStatus: turnStatusAfterResolve(
          { ...state, pendingCheckpoints: nextCheckpoints },
          state.busy,
        ),
      };
    }
    case "resolve_revision": {
      const removed = state.pendingRevisions.find((r) => r.id === action.id);
      let activePlan = state.activePlan;
      if (removed && action.verdict.type === "accepted" && activePlan) {
        const doneIds = new Set(activePlan.completedStepIds);
        const keptDone = activePlan.steps.filter((s) => doneIds.has(s.id));
        activePlan = {
          ...activePlan,
          steps: [...keptDone, ...removed.remainingSteps],
        };
      }
      const nextRevisions = state.pendingRevisions.filter((r) => r.id !== action.id);
      return {
        ...state,
        pendingRevisions: nextRevisions,
        activePlan,
        turnStatus: turnStatusAfterResolve(
          { ...state, pendingRevisions: nextRevisions },
          state.busy,
        ),
      };
    }
    case "dismiss_memory_result":
      return { ...state, memoryResult: null };
    case "mention_results":
      return { ...state, mentionResults: action.results };
    case "mention_preview":
      return { ...state, mentionPreview: action.preview };
    case "enqueue_send": {
      const item: QueuedSend =
        action.send !== undefined
          ? typeof action.send === "string"
            ? { text: action.send }
            : action.send
          : { text: action.text ?? "" };
      return { ...state, queuedSends: [...state.queuedSends, item] };
    }
    case "dequeue_send":
      return {
        ...state,
        queuedSends: state.queuedSends.filter((_, i) => i !== action.index),
      };
    case "shift_queued_send":
      return { ...state, queuedSends: state.queuedSends.slice(1) };
    case "release_stale_send": {
      if (!state.awaitingAck) return state;
      return {
        ...state,
        awaitingAck: false,
        messages: insertNotice(
          state.messages,
          "The send was never acknowledged by the agent — released. Check the connection and resend.",
          "warning",
        ),
      };
    }
    case "push_notice": {
      return {
        ...state,
        messages: insertNotice(state.messages, action.text, action.severity ?? "info"),
      };
    }
  }
}

/** True when two card lists differ only in the text of a segment that already
 *  existed — the streaming case. Anything else (a new card, a new segment, a
 *  flag or result change) is structural: it changes what a row renders. */
function isTextOnlyGrowth(prev: readonly ChatMessage[], next: readonly ChatMessage[]): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    const before = prev[i];
    const after = next[i];
    if (before === after) continue;
    if (!before || !after) return false;
    if (before.kind !== "assistant" || after.kind !== "assistant") return false;
    if (
      before.turn !== after.turn ||
      before.pending !== after.pending ||
      before.closed !== after.closed ||
      before.ts !== after.ts ||
      before.segments.length !== after.segments.length
    ) {
      return false;
    }
    const last = after.segments.length - 1;
    for (let s = 0; s <= last; s += 1) {
      const from = before.segments[s];
      const to = after.segments[s];
      if (from === to) continue;
      // Only the trailing segment may differ, and only by appended text.
      if (s !== last || !from || !to) return false;
      if (from.kind !== "text" && from.kind !== "reasoning") return false;
      if (to.kind !== from.kind) return false;
      if (!sameSegmentExceptText(from, to)) return false;
      if (!to.text.startsWith(from.text)) return false;
    }
  }
  return true;
}

/** Everything about a segment except its text: a grown segment keeps its kind,
 *  timing and tool result, so any other difference means the card re-rendered. */
function sameSegmentExceptText(from: AssistantSegment, to: AssistantSegment): boolean {
  const left = from as unknown as Record<string, unknown>;
  const right = to as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (key === "text") continue;
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** The one entry point to the reducer, so no individual case has to remember to
 *  bump `messagesVersion`: text growing inside an existing segment keeps the
 *  previous revision, every other transcript change bumps it once. */
export function reduce(state: State, action: Action): State {
  const next = reduceAction(state, action);
  if (next.messages === state.messages) return next;
  if (isTextOnlyGrowth(state.messages, next.messages)) return next;
  return { ...next, messagesVersion: state.messagesVersion + 1 };
}

type FileStat = { filename: string; added: number; removed: number };
type FileStats = { entries: FileStat[]; totalAdded: number; totalRemoved: number };

function countFileStats(segments: AssistantSegment[]): FileStats | null {
  const entries: FileStat[] = [];
  for (const s of segments) {
    if (s.kind !== "tool" || !s.result || s.ok === false) continue;
    if (s.name === "edit_file" || s.name === "multi_edit") {
      for (const f of parseEditResult(s.result)) {
        let added = 0;
        let removed = 0;
        for (const ln of f.lines) {
          if (ln.t === "add") added++;
          else if (ln.t === "rm") removed++;
        }
        entries.push({ filename: f.filename, added, removed });
      }
    } else if (s.name === "write_file") {
      let lines = 0;
      try {
        const parsed = JSON.parse(s.args);
        if (typeof parsed.content === "string") {
          lines = parsed.content.split("\n").length;
        }
      } catch {
        /* args unparseable */
      }
      let filename = "";
      try {
        filename = JSON.parse(s.args)?.path ?? "";
      } catch {
        /* ignore */
      }
      entries.push({ filename, added: lines, removed: 0 });
    }
  }
  if (entries.length === 0) return null;
  const totalAdded = entries.reduce((s, e) => s + e.added, 0);
  const totalRemoved = entries.reduce((s, e) => s + e.removed, 0);
  return { entries, totalAdded, totalRemoved };
}

function DiffStats({ stats }: { stats: FileStats }) {
  const [open, setOpen] = useState(false);
  const total = stats.entries.length;
  return (
    <div className="diff-stats">
      <button type="button" className="diff-stats-head" onClick={() => setOpen((v) => !v)}>
        <span className="ico">
          <I.diff size={11} />
        </span>
        <span>
          {total} {total === 1 ? "file" : "files"} changed · +{stats.totalAdded} / −
          {stats.totalRemoved} {stats.totalRemoved === 1 ? "line" : "lines"}
        </span>
        <span className="chev">{open ? <I.chev size={10} /> : <I.chevR size={10} />}</span>
      </button>
      {open ? (
        <div className="diff-stats-body">
          {stats.entries.map((e) => (
            <div key={e.filename} className="diff-stats-row">
              <span className="fn">{e.filename}</span>
              <span className="counts">
                <span className="add">+{e.added}</span>
                {e.removed > 0 ? <span className="rm"> / −{e.removed}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function activePlanForMessage(
  message: ChatMessage,
  activePlan: ActivePlan | null,
): ActivePlan | undefined {
  if (!activePlan?.callId || message.kind !== "assistant") return undefined;
  return message.segments.some(
    (segment) =>
      segment.kind === "tool" &&
      segment.name === "submit_plan" &&
      segment.callId === activePlan.callId,
  )
    ? activePlan
    : undefined;
}

/** Memoized assistant row — props are stable for unchanged messages, so a
 *  streaming frame re-renders only the changed row; countFileStats runs for
 *  that row alone, not the whole transcript. */
const AssistantRow = memo(function AssistantRow({
  m,
  model,
  pendingConfirms,
  activePlan,
  onApproveConfirm,
  onRejectConfirm,
  onRuleConfirm,
  onStopTool,
  jobs,
  tabId,
  onStopJob,
  isInterventionPending,
}: {
  m: Extract<ChatMessage, { kind: "assistant" }>;
  model?: string;
  pendingConfirms: PendingConfirm[];
  activePlan?: ActivePlan;
  onApproveConfirm: (id: number) => void;
  onRejectConfirm: (id: number) => void;
  onRuleConfirm: (id: number, scope: "workspace" | "global", prefix: string) => void;
  onStopTool: (callId: string) => void;
  /** Live background-job snapshots — background shell cards read their job's
   *  status from here so a running job never renders as finished. */
  jobs?: JobInfo[];
  tabId?: string;
  onStopJob?: (jobId: number, tabId: string) => void;
  isInterventionPending?: boolean;
}) {
  const stats = !m.pending ? countFileStats(m.segments) : null;
  return (
    <>
      <AssistantMsg
        segments={m.segments}
        pending={m.pending && !isInterventionPending}
        model={model}
        history={m.closed === true}
        onApproveConfirm={onApproveConfirm}
        onRejectConfirm={onRejectConfirm}
        onRuleConfirm={onRuleConfirm}
        onStopTool={onStopTool}
        pendingConfirms={pendingConfirms}
        activePlan={activePlan}
        jobs={jobs}
        tabId={tabId}
        onStopJob={onStopJob}
        isInterventionPending={isInterventionPending}
      />
      {stats ? <DiffStats stats={stats} /> : null}
    </>
  );
});

function extractToolFiles(name: string, args: string): SessionFile[] {
  if (!isFilePathTool(name)) return [];
  const paths = extractPathsFromArgs(args);
  if (paths.length === 0) return [];
  if (name !== "read_file") {
    // multi_edit edits[] can repeat a path — the panel lists each file once.
    return [...new Set(paths)].map((path) => ({ path, status: "m" }));
  }
  return paths.map((path) => ({ path, status: "c" }));
}

function mergeSessionFiles(existing: SessionFile[], adds: SessionFile[]): SessionFile[] {
  if (adds.length === 0) return existing;
  const next = [...existing];
  const indexByPath = new Map<string, number>();
  next.forEach((f, i) => indexByPath.set(f.path, i));
  let changed = false;
  for (const add of adds) {
    const idx = indexByPath.get(add.path);
    if (idx === undefined) {
      indexByPath.set(add.path, next.length);
      next.push(add);
      changed = true;
      continue;
    }
    const prev = next[idx];
    if (!prev || prev.status === "m") continue; // never downgrade m → c
    if (prev.status === add.status) continue;
    next[idx] = add;
    changed = true;
  }
  return changed ? next : existing;
}

/** Convert a server-sent conversation (LoadedMessage shape) into UI messages.
 *  Shared by $session_loaded and session.retracted — both carry the same wire
 *  shape, so a truncation replacement and a session reload render identically.
 *
 *  Every loaded assistant card is CLOSED: the wire snapshot is history, not a
 *  live turn, and its turn ordinals are renumbered from the log's user records.
 *  Left open, a later delta whose ordinal happens to match would be written into
 *  that history card — above whatever boundary (a compaction notice) sits after
 *  it — and vanish from the transcript. */
export function mapLoadedMessages(loaded: LoadedMessage[], turnBase = 0): ChatMessage[] {
  // User turns are counted by user-message position (1-based), matching live
  // numbering. List index i+1 would drift: the loaded list interleaves
  // assistant messages, so the 2nd user message would render as turn 3 and
  // rewind's index mapping (turn - 1) would point past the log's user entries.
  // `turnBase` is how many user turns the page sits BELOW, so a paged or
  // prepended window keeps the absolute numbers the Events tab and rewind use.
  let userTurn = turnBase;
  return loaded.map((m, i) => {
    if (m.kind === "user") {
      userTurn += 1;
      return {
        kind: "user",
        text: m.text,
        clientId: `c-loaded-${i}`,
        turn: userTurn,
        ...(m.images ? { images: m.images } : {}),
        ...(m.injected ? { injected: true as const } : {}),
        ts: m.ts,
      };
    }
    if (m.kind === "notice") {
      return {
        kind: "notice",
        id: m.id,
        text: m.text,
        severity: m.severity,
        turn: m.turn === undefined ? undefined : m.turn + turnBase,
        ts: m.ts,
      };
    }
    const segments: AssistantSegment[] = m.segments.map((s, segIdx) => {
      if (s.kind === "tool") {
        return {
          kind: "tool",
          callId: s.callId,
          name: s.name,
          args: s.args,
          startedAt: 0,
          result: s.result,
          ok: s.ok,
          durationMs: 0,
        };
      }
      if (s.kind === "warning") {
        return {
          kind: "warning",
          id: s.id ?? `w-loaded-${i}-${segIdx}`,
          text: s.text,
          severity: s.severity ?? "high",
        };
      }
      return s;
    });
    // closed: history can never be the streaming target (see openAssistantIndex).
    return {
      kind: "assistant",
      turn: m.turn + turnBase,
      segments,
      pending: false,
      closed: true,
      ts: m.ts,
    };
  });
}

/** A card's own annotation records. A card object is replaced whenever anything
 *  about it changes, so a cache hit means this card contributes exactly what it
 *  did last time. */
const noticesByCard = new WeakMap<ChatMessage, PersistedNotice[]>();

function noticesOfCard(card: ChatMessage): PersistedNotice[] {
  const cached = noticesByCard.get(card);
  if (cached) return cached;
  const own: PersistedNotice[] = [];
  if (card.kind === "notice") {
    own.push({
      id: card.id,
      kind: "notice",
      text: card.text,
      severity: card.severity,
      turn: card.turn ?? 0,
    });
  } else if (card.kind === "assistant") {
    for (const segment of card.segments) {
      if (segment.kind !== "warning") continue;
      own.push({
        id: segment.id,
        kind: "warning",
        text: segment.text,
        severity: segment.severity ?? "high",
        turn: card.turn,
      });
    }
  }
  noticesByCard.set(card, own);
  return own;
}

/** The last flattened list, reused while the annotations are unchanged. The
 *  sidecar sync keys on this identity, so a streamed token must not hand it a
 *  fresh array (and a fresh stringify) sixty times a second. */
let noticesCache: { key: readonly ChatMessage[]; value: PersistedNotice[] } | null = null;

function sameNoticeList(a: readonly PersistedNotice[], b: readonly PersistedNotice[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Flatten the live transcript's annotation cards (notice cards + assistant
 *  warning segments) into the persisted shape the daemon stores per session, so
 *  none is transient across reload / resync / restart. */
export function collectPersistedNotices(messages: readonly ChatMessage[]): PersistedNotice[] {
  if (noticesCache?.key === messages) return noticesCache.value;
  const out: PersistedNotice[] = [];
  for (const card of messages) {
    for (const notice of noticesOfCard(card)) out.push(notice);
  }
  const stable = noticesCache && sameNoticeList(noticesCache.value, out) ? noticesCache.value : out;
  noticesCache = { key: messages, value: stable };
  return stable;
}

/** Re-derive the "Files in context" list from a conversation: paths from tool
 *  segments. Used by $session_loaded and session.retracted. */
function deriveSessionFiles(loaded: ChatMessage[]): SessionFile[] {
  const files: SessionFile[] = [];
  const indexByPath = new Map<string, number>();
  for (const m of loaded) {
    if (m.kind !== "assistant") continue;
    for (const s of m.segments) {
      if (s.kind !== "tool") continue;
      // For replayed sessions we don't have tool.result ok-status here, but
      // segments only survive into history if the call completed. Trust it.
      for (const add of extractToolFiles(s.name, s.args)) {
        const at = indexByPath.get(add.path);
        if (at === undefined) {
          indexByPath.set(add.path, files.length);
          files.push(add);
          continue;
        }
        const prev = files[at];
        // Never downgrade a modified file back to merely-in-context.
        if (!prev || prev.status === "m" || prev.status === add.status) continue;
        files[at] = add;
      }
    }
  }
  return files;
}

function zeroUsage(): UsageStats {
  return {
    totalCostUsd: 0,
    lastCallCostUsd: 0,
    costByProvider: {},
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    lastCallCacheHit: null,
    lastCallCacheMiss: null,
    reservedTokens: 0,
    liveLogTokens: 0,
  };
}

/** Fold a measured plan-window delta (percentage points) into the session's
 *  per-provider quota usage. Native unit only — never converted to dollars. */
function applyQuotaDelta(usage: UsageStats, provider: string, usedPct: number | null): UsageStats {
  if (usedPct === null || usedPct <= 0) return usage;
  const prev = usage.costByProvider?.[provider];
  const prevPct = prev?.quotaUsedPct ?? 0;
  const kind = prev?.totalCostUsd !== undefined ? "mixed" : "quota";
  return {
    ...usage,
    costByProvider: {
      ...(usage.costByProvider ?? {}),
      [provider]: {
        ...prev,
        kind,
        quotaUsedPct: prevPct + usedPct,
      },
    },
  };
}

function appendTextSegment(
  segments: AssistantSegment[],
  kind: "text" | "reasoning",
  text: string,
): AssistantSegment[] {
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    return [...segments.slice(0, -1), { ...last, text: last.text + text }];
  }
  const base = closeTrailingReasoning(segments);
  return [...base, kind === "reasoning" ? { kind, text, startedAt: Date.now() } : { kind, text }];
}

// Stamp the wall-clock duration onto a trailing reasoning segment that's still
// open (no `durationMs`) — called when the model moves on to text, a tool, or
// the turn finalizes, so the reasoning card can show how long the thinking run
// took. Idempotent: a closed or non-reasoning tail is returned unchanged.
function closeTrailingReasoning(segments: AssistantSegment[]): AssistantSegment[] {
  const last = segments[segments.length - 1];
  if (last?.kind === "reasoning" && last.durationMs === undefined && last.startedAt !== undefined) {
    return [
      ...segments.slice(0, -1),
      { ...last, durationMs: Math.max(0, Date.now() - last.startedAt) },
    ];
  }
  return segments;
}

function appendNoticeMessage(messages: ChatMessage[], notice: ChatMessage): ChatMessage[] {
  return [...messages, notice];
}

/** Map a wire event to its cue id, when the event is one the cue matrix knows:
 *  pending approval/question/plan cards → inputRequired, repetition-guard
 *  warnings → guardTriggered. Sound (enabled) fires immediately; the desktop
 *  notification (notify) rides the normal approval-snapshot path. */
export function cueIdForEvent(ev: IncomingEvent): FeedbackCueId | null {
  switch (ev.type) {
    case "$confirm_required":
    case "$path_access_required":
    case "$edit_required":
    case "$choice_required":
    case "$plan_required":
    case "$checkpoint_required":
    case "$revision_required":
      return "inputRequired";
    case "warning":
      return ev.cause === "repetition-guard" ? "guardTriggered" : null;
    default:
      return null;
  }
}

/** Fire the sound half of a cue for a wire event (if that cue's sound is
 *  enabled). Guard warnings additionally land in `guardSink` so the
 *  notification pass can surface one OS notification per unfocused burst. */
function handleCueForEvent(
  ev: IncomingEvent,
  cues: FeedbackCueSettings | null | undefined,
  player: FeedbackSoundPlayer,
  guardSink?: { cause?: string }[],
): void {
  const id = cueIdForEvent(ev);
  if (!id) return;
  if (id === "guardTriggered") {
    guardSink?.push({ cause: ev.type === "warning" ? ev.cause : undefined });
  }
  playEnabledCue(cues, id, player);
}

// The turn a notice belongs to (the one in flight, else the last completed
// turn). Stored on the notice only for turnHasTerminalExplanation's dedupe —
// placement itself is creation-ordered (see appendNoticeMessage).
function currentTurnForNotice(messages: ChatMessage[]): number {
  // "Which turn is live" — the newest card nothing has sealed. A queued user
  // bubble can trail it, so this is deliberately NOT the streaming target (see
  // openAssistantIndex): the live card still gets settled when a notice arrives
  // for its turn, even though later content opens a card below the notice.
  for (let i = messages.length - 1; i >= 0; i--) {
    const card = messages[i];
    if (card?.kind === "assistant" && !card.closed) return card.turn;
  }
  let last = 0;
  for (const m of messages) {
    if (m.kind === "user" || m.kind === "assistant") last = Math.max(last, m.turn);
  }
  return last;
}

function insertNotice(
  messages: ChatMessage[],
  text: string,
  severity: NoticeSeverity = "info",
  turn?: number,
): ChatMessage[] {
  const inflight = currentTurnForNotice(messages);
  const noticeTurn = turn ?? inflight;
  // A notice is a boundary. Placing later output below it is guaranteed by
  // openAssistantIndex (content only ever lands at the transcript tail), not by
  // this closure — the closeTurnCard call here only settles the card's rendered
  // state (spinner off, trailing reasoning stamped). A notice for an earlier turn
  // (a late error) leaves the streaming card's rendered state alone. Everything is
  // appended in creation order.
  const base = noticeTurn === inflight ? closeTurnCard(messages, noticeTurn) : messages;
  return appendNoticeMessage(base, {
    kind: "notice",
    id: nextNoticeId(),
    text,
    severity,
    turn: noticeTurn,
    ts: writeStamp(),
  });
}

/** True when the given turn already carries a user-visible explanation (a warning
 *  segment or a notice). Prevents $turn_complete from adding a duplicate stop card
 *  when the loop already surfaced the reason. */
/** The message list a settled turn leaves behind: unresolved tool segments get
 *  a canned cancelled result. Shared by $turn_complete and the $tab_status
 *  idle resync so the two settle paths cannot drift apart again. */
export function settleTurnMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) =>
    message.kind === "assistant"
      ? {
          ...message,
          pending: false,
          closed: true,
          segments: message.segments.map((segment) =>
            segment.kind === "tool" && segment.result === undefined
              ? {
                  ...segment,
                  result:
                    "Tool call cancelled because the conversation stopped. No result was produced.",
                  ok: false,
                }
              : segment,
          ),
        }
      : message,
  );
}

function turnHasTerminalExplanation(messages: ChatMessage[], turn: number | undefined): boolean {
  return messages.some(
    (m) =>
      (m.kind === "notice" && (turn === undefined || m.turn === turn)) ||
      (m.kind === "assistant" &&
        (turn === undefined || m.turn === turn) &&
        m.segments.some((s) => s.kind === "warning")),
  );
}

function appendAssistantSegment(
  messages: ChatMessage[],
  segment: AssistantSegment,
  turn = 1,
): ChatMessage[] {
  const hostIndex = unclosedTurnCardIndex(messages, turn);
  const host = hostIndex >= 0 ? messages[hostIndex] : undefined;
  if (host?.kind === "assistant") {
    const next = [...messages];
    next[hostIndex] = { ...host, segments: [...host.segments, segment] };
    return next;
  }
  return [
    ...messages,
    { kind: "assistant", turn, segments: [segment], pending: false, ts: writeStamp() },
  ];
}

export function applySubagentProgress(
  runs: SubagentRunProgress[],
  ev: SubagentProgressEvent,
): SubagentRunProgress[] {
  const result = [...runs];
  const runIndex = result.findIndex((run) => run.runId === ev.runId);
  const previous = runIndex >= 0 ? result[runIndex] : undefined;
  const tools = [...(previous?.tools ?? [])];
  const recentRows = [...(previous?.recentRows ?? [])];

  if (ev.action === "start" && recentRows.length === 0) {
    recentRows.push({
      id: `${ev.runId}-start`,
      kind: "process",
      text: `Starting ${subagentStartLabel(ev.skillName)}...`,
      status: "running",
    });
  } else if (ev.action === "tool-start") {
    const callId = ev.childCallId ?? `${ev.runId}-tool-${tools.length}`;
    const existing = tools.findIndex((tool) => tool.callId === callId);
    const activity: SubagentToolActivity = {
      callId,
      name: ev.toolName ?? "tool",
      ...(ev.toolArgs ? { args: ev.toolArgs } : {}),
      status: "running",
    };
    if (existing >= 0) tools[existing] = activity;
    else tools.push(activity);
    const text = `↳ ${ev.toolName ?? "tool"}${ev.toolArgs ? ` ${ev.toolArgs}` : ""}`;
    recentRows.push({
      id: `${ev.runId}-tool-${Date.now()}-${recentRows.length}`,
      kind: "process",
      text,
      status: "running",
    });
  } else if (ev.action === "tool-end") {
    const existing = ev.childCallId
      ? tools.findIndex((tool) => tool.callId === ev.childCallId)
      : tools.findIndex((tool) => tool.status === "running");
    if (existing >= 0 && tools[existing]) {
      tools[existing] = {
        ...tools[existing],
        status: ev.toolOk === false ? "failed" : "done",
      };
    }
    const lastProcess = [...recentRows]
      .reverse()
      .find((r) => r.kind === "process" && r.status === "running");
    if (lastProcess) {
      lastProcess.status = ev.toolOk === false ? "failed" : "done";
    }
  } else if (ev.action === "phase" && ev.phase) {
    recentRows.push({
      id: `${ev.runId}-phase-${Date.now()}-${recentRows.length}`,
      kind: "process",
      text: ev.phase === "summarising" ? "Summarising findings..." : "Exploring codebase...",
      status: "running",
    });
  }

  if (ev.thought) {
    const lines = ev.thought
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3);
    if (lines.length > 0) {
      while (recentRows.at(-1)?.kind === "thinking") recentRows.pop();
      recentRows.push(
        ...lines.map((text, index) => ({
          id: `${ev.runId}-th-${ev.reasoningChars ?? ev.outputChars ?? Date.now()}-${index}`,
          kind: "thinking" as const,
          text,
        })),
      );
    }
  }
  if (recentRows.length > 20) {
    recentRows.splice(0, recentRows.length - 20);
  }

  const next: SubagentRunProgress = {
    runId: ev.runId,
    task: fullerSubagentTask(previous?.task, ev.task),
    skillName: ev.skillName ?? previous?.skillName,
    model: ev.model ?? previous?.model,
    phase: ev.phase ?? previous?.phase,
    status: ev.action === "end" ? (ev.error ? "failed" : "done") : (previous?.status ?? "running"),
    iter: ev.iter ?? previous?.iter,
    elapsedMs: ev.elapsedMs ?? previous?.elapsedMs,
    contextTokens: ev.contextTokens ?? previous?.contextTokens,
    contextMax: ev.contextMax ?? previous?.contextMax,
    outputChars: ev.outputChars ?? previous?.outputChars,
    reasoningChars: ev.reasoningChars ?? previous?.reasoningChars,
    toolReadChars: ev.toolReadChars ?? previous?.toolReadChars,
    turns: ev.turns ?? previous?.turns,
    costUsd: ev.costUsd ?? previous?.costUsd,
    billingKind: ev.billingKind ?? previous?.billingKind,
    quotaUsedPct: ev.quotaUsedPct ?? previous?.quotaUsedPct,
    maxToolIters: ev.maxToolIters ?? previous?.maxToolIters,
    maxElapsedMs: ev.maxElapsedMs ?? previous?.maxElapsedMs,
    budgetExhausted: ev.budgetExhausted ?? previous?.budgetExhausted,
    error: ev.error ?? previous?.error,
    thought: ev.thought ?? previous?.thought,
    recentRows,
    tools,
  };

  if (runIndex >= 0) result[runIndex] = next;
  else result.push(next);
  return result;
}

/** Primary model/tool activity means an auto/overflow compaction ended without
 *  its own completion signal (e.g. a no-op run) — never strand its throbber.
 *  Manual cards settle via $notice/$error and survive concurrent streaming. */
const COMPACT_STALE_ON: ReadonlySet<IncomingEvent["type"]> = new Set([
  "model.turn.started",
  "model.delta",
  "model.final",
  "tool.preparing",
  "tool.intent",
  "tool.result",
]);

function dropStaleCompaction(state: State, ev: IncomingEvent): State {
  if (!COMPACT_STALE_ON.has(ev.type)) return state;
  const stale = (m: ChatMessage) =>
    m.kind === "notice" && m.running === true && m.trigger !== "manual";
  if (!state.messages.some(stale)) return state;
  return {
    ...state,
    messages: state.messages.filter((m) => !stale(m)),
  };
}

export function applyIncoming(state: State, ev: IncomingEvent): State {
  return applyIncomingInner(dropStaleCompaction(ensureAssistantTurn(state, ev), ev), ev);
}

function applyIncomingInner(state: State, ev: IncomingEvent): State {
  switch (ev.type) {
    case "user.message": {
      // Daemon echo: renumber the optimistic bubble in place instead of
      // appending a duplicate. Monotonic ordinals guarantee the daemon turn
      // is unseen.
      const existingIdx =
        ev.clientId !== undefined
          ? state.messages.findIndex((m) => m.kind === "user" && m.clientId === ev.clientId)
          : -1;
      if (existingIdx >= 0) {
        const messages = [...state.messages];
        const existing = messages[existingIdx];
        if (existing?.kind === "user" && existing.turn === ev.turn) return state;
        messages[existingIdx] =
          existing?.kind === "user" ? { ...existing, turn: ev.turn } : existing;
        return { ...state, busy: true, awaitingAck: false, messages };
      }
      return {
        ...state,
        busy: true,
        awaitingAck: false,
        messages: [
          ...state.messages,
          {
            kind: "user",
            text: ev.text,
            clientId: ev.clientId ?? `remote-${ev.id}`,
            turn: ev.turn > 0 ? ev.turn : nextMessageTurn(state.messages),
            ts: writeStamp(),
          },
        ],
      };
    }
    case "$ready":
      return { ...state, ready: true, needsSetup: false, mcpSetup: null };
    case "$workspace_initialized":
      return {
        ...state,
        workspaceInitializationRevision: Math.max(
          state.workspaceInitializationRevision,
          ev.revision,
        ),
      };
    case "$needs_setup":
      // Either side of the `$ready` fork resolves the session-start picker: a chat
      // that still needs a credential must not keep the dialog waiting on `$ready`.
      return { ...state, needsSetup: true, ready: false, mcpSetup: null };
    case "$turn_complete": {
      // Clear pause-gate-tied modals too. By the time the loop emits
      // $turn_complete, anything still in these arrays is orphaned — the
      // tool call that opened it has either resolved (so it's gone already)
      // or the turn was aborted (so the model isn't coming back for it).
      // Without this, an Esc/abort during plan approval leaves the plan
      // card rendered AFTER state.messages forever; the queued user input
      // that drains next then appears above the zombie card (#1456).
      const settled = settleTurnMessages(state.messages);
      const outcome = ev.outcome ?? "success";
      // Never end a turn silently: when the model stopped without an answer and
      // the loop did not already surface an explanation, add a terminal card.
      const messages =
        outcome === "stopped" && ev.reason && !turnHasTerminalExplanation(settled, ev.turn)
          ? insertNotice(settled, ev.reason, "warning", ev.turn)
          : settled;
      return {
        ...state,
        busy: false,
        awaitingAck: false,
        lastTurnOutcome: outcome,
        messages,
        activeSkill: null,
        turnStatus: null,
        turnStatusTool: null,
        pendingConfirms: [],
        pendingPathAccess: [],
        pendingChoices: [],
        pendingPlans: [],
        pendingCheckpoints: [],
        pendingRevisions: [],
      };
    }
    case "$turn_started":
      // Daemon-authoritative ON: the turn really runs from here. Releases the
      // optimistic send spin; from this point busy is the daemon's truth.
      return { ...state, busy: true, awaitingAck: false };
    case "$tab_status": {
      // Reconciliation probe reply. Anything other than agreement resolves to
      // the daemon's answer — the UI never out-argues the backend.
      const compacting = ev.compacting === true;
      if (ev.busy === state.busy && compacting === state.compacting && !state.awaitingAck)
        return state;
      if (ev.busy) return { ...state, busy: true, awaitingAck: false, compacting };
      // A fold leaves turn-busy false while the daemon is still working — adopt
      // its compacting state and never mistake that for a lost terminal.
      if (compacting) return { ...state, compacting };
      // Not busy and not folding: only a real held-turn drift earns the notice.
      if (!state.busy && !state.awaitingAck) return { ...state, compacting: false };
      // Daemon idle while the UI held a turn: a terminal event was lost.
      // Release exactly like $turn_complete would, plus a warning notice so
      // the correction is visible.
      const settled = settleTurnMessages(state.messages);
      return {
        ...state,
        busy: false,
        awaitingAck: false,
        compacting: false,
        activeSkill: null,
        turnStatus: null,
        turnStatusTool: null,
        pendingConfirms: [],
        pendingPathAccess: [],
        pendingChoices: [],
        pendingPlans: [],
        pendingCheckpoints: [],
        pendingRevisions: [],
        messages: insertNotice(
          settled,
          "Resynced with the agent: it was idle, so stuck turn state was released.",
          "warning",
        ),
      };
    }
    case "$confirm_required":
      return {
        ...state,
        turnStatus: "waiting_user",
        turnStatusTool: null,
        pendingConfirms: [
          ...state.pendingConfirms,
          { id: ev.id, kind: ev.kind, command: ev.command, prompt: ev.prompt! },
        ],
      };
    case "$path_access_required":
      return {
        ...state,
        turnStatus: "waiting_user",
        turnStatusTool: null,
        pendingPathAccess: [
          ...state.pendingPathAccess,
          {
            id: ev.id,
            path: ev.path,
            intent: ev.intent,
            toolName: ev.toolName,
            sandboxRoot: ev.sandboxRoot,
            allowPrefix: ev.allowPrefix,
            prompt: ev.prompt!,
          },
        ],
      };
    case "$edit_required":
      return {
        ...state,
        turnStatus: "waiting_user",
        turnStatusTool: null,
        pendingPathAccess: [
          ...state.pendingPathAccess,
          {
            id: ev.id,
            path: ev.path,
            intent: "write",
            toolName: ev.toolName,
            sandboxRoot: ev.sandboxRoot,
            allowPrefix: ev.allowPrefix,
            prompt: ev.prompt!,
          },
        ],
      };
    case "$choice_required":
      return {
        ...state,
        turnStatus: "waiting_user",
        turnStatusTool: null,
        pendingChoices: [
          ...state.pendingChoices,
          {
            id: ev.id,
            question: ev.question,
            options: ev.options,
            allowCustom: ev.allowCustom,
            countdownMs: ev.countdownMs,
          },
        ],
      };
    case "$plan_required": {
      const steps = Array.isArray(ev.steps) ? (ev.steps as PlanStep[]) : undefined;
      return {
        ...state,
        turnStatus: "waiting_user",
        turnStatusTool: null,
        pendingPlans: [
          ...state.pendingPlans,
          {
            id: ev.id,
            plan: ev.plan,
            summary: ev.summary,
            countdownMs: ev.countdownMs,
            callId: ev.callId,
            ...(steps ? { steps } : {}),
          },
        ],
      };
    }
    case "$checkpoint_required":
      return {
        ...state,
        turnStatus: "waiting_user",
        turnStatusTool: null,
        pendingCheckpoints: [
          ...state.pendingCheckpoints,
          {
            id: ev.id,
            stepId: ev.stepId,
            title: ev.title,
            result: ev.result,
            notes: ev.notes,
            completed: ev.completed,
            total: ev.total,
          },
        ],
      };
    case "$revision_required":
      return {
        ...state,
        turnStatus: "waiting_user",
        turnStatusTool: null,
        pendingRevisions: [
          ...state.pendingRevisions,
          {
            id: ev.id,
            reason: ev.reason,
            remainingSteps: ev.remainingSteps,
            previousSteps: ev.previousSteps,
            summary: ev.summary,
            countdownMs: ev.countdownMs,
          },
        ],
      };
    case "$step_completed": {
      if (!state.activePlan) return state;
      const stepIds = new Set(state.activePlan.completedStepIds);
      stepIds.add(ev.stepId);
      return {
        ...state,
        activePlan: {
          ...state.activePlan,
          completedStepIds: [...stepIds],
          stepResults: { ...state.activePlan.stepResults, [ev.stepId]: ev.result },
        },
      };
    }
    case "$plan_cleared": {
      if (!state.activePlan) return state;
      const finished =
        state.activePlan.steps.length > 0 &&
        state.activePlan.completedStepIds.length >= state.activePlan.steps.length;
      return {
        ...state,
        activePlan: {
          ...state.activePlan,
          status: finished ? "finished" : "cancelled",
        },
        pendingCheckpoints: [],
        pendingRevisions: [],
      };
    }
    case "$plan_history": {
      // The plan store is workspace-scoped and the daemon fans this projection out to
      // every tab of that workspace, so the event describes SESSIONS, not the one on
      // screen. Applying it whatever session this tab happens to show is what keeps a
      // background session's badge current. Only a workspace switch invalidates the map.
      const items = Array.isArray(ev.items) ? ev.items : [];
      return {
        ...state,
        planHistory: items,
        planDetails: Object.fromEntries(
          Object.entries(state.planDetails ?? {}).filter(([id, detail]) =>
            items.some((item) => item.id === id && item.updatedAt === detail.updatedAt),
          ),
        ),
      };
    }
    case "$plan_detail":
      return { ...state, planDetails: { ...state.planDetails, [ev.plan.id]: ev.plan } };
    case "$plan_restored": {
      const steps = Array.isArray(ev.steps) ? (ev.steps as PlanStep[]) : [];
      return {
        ...state,
        activePlan: {
          plan: ev.plan,
          summary: ev.summary,
          steps,
          completedStepIds: Array.isArray(ev.completedStepIds) ? ev.completedStepIds : [],
          stepResults: ev.stepResults ?? {},
          status: ev.status ?? "active",
        },
      };
    }
    case "$mcp_setup":
      return {
        ...state,
        mcpSetup: {
          servers: Array.isArray(ev.servers) ? ev.servers : [],
          subagents: ev.subagents === true,
        },
        mcpSetupRevision: state.mcpSetupRevision + 1,
      };
    case "$mcp_specs":
      return {
        ...state,
        mcpSpecs: Array.isArray(ev.specs) ? ev.specs : [],
        mcpBridged: Boolean(ev.bridged),
      };
    case "$mcp_extension_status":
      return { ...state, mcpExtensionStatus: ev.status };
    case "$mcp_extension_check":
      return { ...state, mcpExtensionCheck: ev.check };
    case "$mail_auth":
      return { ...state, mailAuth: ev.state };
    case "$playwright_browser_install":
      return { ...state, playwrightBrowserInstall: ev.install };
    case "$skills":
      return { ...state, skills: ev.items };
    case "$ctx_breakdown": {
      const next: UsageStats = { ...state.usage, reservedTokens: ev.reservedTokens };
      if (typeof ev.logTokens === "number") {
        next.liveLogTokens = ev.logTokens;
      }
      if (typeof ev.ctxMax === "number") {
        next.ctxMax = ev.ctxMax;
      }
      // The shell-output totals arrive as a pair (or not at all — no telemetry).
      if (typeof ev.shellOutputRawTokens === "number") {
        next.shellOutputRawTokens = ev.shellOutputRawTokens;
        next.shellOutputShownTokens = ev.shellOutputShownTokens ?? 0;
      }
      return { ...state, usage: next };
    }
    case "$memory":
      return {
        ...state,
        memory: ev.entries,
        memoryDetail:
          state.memoryDetail && ev.entries.some((entry) => entry.path === state.memoryDetail?.path)
            ? state.memoryDetail
            : null,
      };
    case "$memory_detail":
      return { ...state, memoryDetail: ev.detail };
    case "$memory_result":
      return { ...state, memoryResult: { ok: ev.ok, message: ev.message } };
    case "$jobs": {
      // Keep the prior array when the snapshot is unchanged so memoized rows
      // (and their background-job shell cards) don't re-render on every poll.
      if (sameJobInfos(state.jobs, ev.items)) return state;
      return { ...state, jobs: ev.items };
    }
    case "$balance":
      return {
        ...state,
        balance: {
          currency: ev.currency,
          total: ev.total,
          isAvailable: ev.isAvailable,
          infos: ev.balanceInfos ?? [],
        },
      };
    case "$codex_quota":
      return {
        ...state,
        codexQuota: ev.quota,
        codexQuotaReason: ev.reason ?? null,
        codexQuotaRefreshing: false,
        // Native unit: the measured plan-window delta accumulates as quota % —
        // never converted to a dollar figure.
        usage: applyQuotaDelta(state.usage, "openai", ev.quota?.turnUsedPct ?? null),
      };
    case "$ollama_quota":
      return {
        ...state,
        ollamaQuota: ev.quota,
        ollamaQuotaReason: ev.reason ?? null,
        ollamaQuotaRefreshing: false,
        usage: applyQuotaDelta(state.usage, "ollama", ev.quota?.turnUsedPct ?? null),
      };
    case "$antigravity_quota":
      return {
        ...state,
        antigravityQuota: ev.quota,
        antigravityQuotaReason: ev.reason ?? null,
        antigravityQuotaRefreshing: false,
        usage: applyQuotaDelta(state.usage, "gemini", ev.quota?.turnUsedPct ?? null),
      };
    case "$zai_quota":
      return {
        ...state,
        zaiQuota: ev.quota,
        zaiQuotaReason: ev.reason ?? null,
        zaiQuotaRefreshing: false,
        usage: applyQuotaDelta(state.usage, "zai", ev.quota?.turnUsedPct ?? null),
      };
    case "$opencode_quota":
      return {
        ...state,
        opencodeQuota: ev.quota,
        opencodeQuotaReason: ev.reason ?? null,
        opencodeQuotaRefreshing: false,
        usage: applyQuotaDelta(state.usage, "opencode", ev.quota?.turnUsedPct ?? null),
      };
    case "$settings": {
      const prevWs = state.settings?.workspaceDir;
      // Compare normalized paths: the daemon re-emits settings freely, and a
      // separator/case-only difference would otherwise read as a workspace
      // switch and wipe the transcript (the daemon compares them the same way).
      const wsChanged =
        prevWs !== undefined &&
        normalizeWorkspacePath(prevWs) !== normalizeWorkspacePath(ev.workspaceDir);
      // A model switch aborts the running turn daemon-side (the in-flight turn
      // holds the previous loop/model) so it can't wedge the tab. Mirror that
      // release here: any model change clears a busy/stuck turn so the FE
      // unblocks and its queued sends drain, even if the abort's $turn_complete
      // lands late — otherwise those queued messages inherit the same freeze.
      const modelChanged = state.settings != null && state.settings.model !== ev.model;
      const releaseTurn = wsChanged || modelChanged;
      return {
        ...state,
        busy: releaseTurn ? false : state.busy,
        awaitingAck: releaseTurn ? false : state.awaitingAck,
        turnStatus: releaseTurn ? null : state.turnStatus,
        turnStatusTool: releaseTurn ? null : state.turnStatusTool,
        messages: wsChanged ? [] : state.messages,
        pendingConfirms: wsChanged ? [] : state.pendingConfirms,
        pendingPathAccess: wsChanged ? [] : state.pendingPathAccess,
        pendingChoices: wsChanged ? [] : state.pendingChoices,
        pendingPlans: wsChanged ? [] : state.pendingPlans,
        pendingCheckpoints: wsChanged ? [] : state.pendingCheckpoints,
        pendingRevisions: wsChanged ? [] : state.pendingRevisions,
        activePlan: wsChanged ? null : state.activePlan,
        // Plan history is workspace-scoped: keeping it across a switch would label
        // this workspace's sessions with another workspace's plans.
        planHistory: wsChanged ? [] : state.planHistory,
        planDetails: wsChanged ? {} : state.planDetails,
        usage: wsChanged ? zeroUsage() : state.usage,
        sessionFiles: wsChanged ? [] : state.sessionFiles,
        retryNonce: wsChanged ? 0 : state.retryNonce,
        settings: {
          reasoningEffort: ev.reasoningEffort,
          editMode: ev.editMode,
          quickSends: ev.quickSends,
          quickSendId: ev.quickSendId,
          contextTokens: ev.contextTokens ?? null,
          maxIterPerTurn: ev.maxIterPerTurn ?? null,
          maxIterPerTurnOverride: ev.maxIterPerTurnOverride ?? null,
          // Frozen per session, and absent reads as off: a daemon that predates the
          // field minted nothing with the tool, so there is no picker to keep.
          subagents: ev.subagents ?? false,
          elevationEnabled: ev.elevationEnabled ?? false,
          repetitionGuardEnabled: ev.repetitionGuardEnabled ?? false,
          autoCompact: ev.autoCompact ?? true,
          autoCompactTrigger: ev.autoCompactTrigger ?? null,
          questionTimerEnabled: ev.questionTimerEnabled ?? false,
          feedbackCues: ev.feedbackCues ?? {},
          baseUrl: ev.baseUrl,
          apiKeyPrefix: ev.apiKeyPrefix,
          workspaceDir: ev.workspaceDir,
          recentWorkspaces: ev.recentWorkspaces,
          reasonixLocalDir: ev.reasonixLocalDir,
          model: ev.model,
          providerCatalogs: ev.providerCatalogs,
          enabledModels: ev.enabledModels,
          fallbackModels: ev.fallbackModels,
          webSearchEngine: ev.webSearchEngine,
          webSearchEndpoint: ev.webSearchEndpoint,
          webSearchApiKeys: ev.webSearchApiKeys,
          opencodeBaseUrl: ev.opencodeBaseUrl,
          mimoBaseUrl: ev.mimoBaseUrl,
          experientialBaseUrl: ev.experientialBaseUrl,
          subagentModel: ev.subagentModel,
          ollamaGeneration: ev.ollamaGeneration,
          ollamaGenerationOverrides: ev.ollamaGenerationOverrides,
          ollamaModelDefaults: ev.ollamaModelDefaults,
          statusBar: ev.statusBar,
          modelEndpoint: ev.modelEndpoint,
          subagentModelEndpoint: ev.subagentModelEndpoint,
          openaiOAuth: ev.openaiOAuth,
          antigravityOAuth: ev.antigravityOAuth,
          opencodeOAuth: ev.opencodeOAuth,
          mimoOAuth: ev.mimoOAuth,
          mailProvider: ev.mailProvider ?? MailProvider.Outlook,
          shellAllowedWorkspace: ev.shellAllowedWorkspace,
          pathAllowedWorkspace: ev.pathAllowedWorkspace,
          shellAllowedGlobal: ev.shellAllowedGlobal,
          pathAllowedGlobal: ev.pathAllowedGlobal,
          rules: ev.rules,
          workspacesWithRules: ev.workspacesWithRules,
          builtinShellAllowlist: ev.builtinShellAllowlist,
          readOnlyTools: ev.readOnlyTools,
          version: ev.version,
        },
        oauthWaiting: ev.openaiOAuth?.signedIn ? false : state.oauthWaiting,
        antigravityOAuthWaiting: ev.antigravityOAuth?.signedIn
          ? false
          : state.antigravityOAuthWaiting,
        opencodeOAuthWaiting: ev.opencodeOAuth?.signedIn ? false : state.opencodeOAuthWaiting,
        mimoOAuthWaiting: ev.mimoOAuth?.signedIn ? false : state.mimoOAuthWaiting,
        // Quota is only meaningful while its provider's models are active —
        // drop stale numbers the moment the daemon-resolved provider changes.
        // The provider comes from the resolved endpoint, never the model name.
        codexQuota: ev.modelEndpoint?.provider === "openai" ? state.codexQuota : null,
        ollamaQuota: ev.modelEndpoint?.provider === "ollama" ? state.ollamaQuota : null,
        antigravityQuota: ev.modelEndpoint?.provider === "gemini" ? state.antigravityQuota : null,
        // Only a Go model has Go plan windows; drop stale numbers for free/paid Zen.
        opencodeQuota: ev.modelEndpoint?.opencodePlan === "go" ? state.opencodeQuota : null,
      };
    }
    case "$session_loaded": {
      // A resync echo of the session we've ALREADY loaded must not clobber
      // the live transcript — the on-disk snapshot is behind the deltas the
      // backend keeps sending, and busy flags can't be trusted mid-stream.
      // This also covers the common cold-start double-emit: bootstrapTab
      // sends $session_loaded once, then desktop_resync echoes it again for
      // the SAME session, which would otherwise re-render the whole
      // transcript. Genuine `session_load` RPCs are never marked `resync`,
      // so a real switch (different session) still applies.
      if (ev.resync && ev.name === state.currentSession) return state;
      const sessionName = ev.name;
      const loaded = mapLoadedMessages(ev.messages, ev.turnBase ?? 0);
      const sessionFiles = deriveSessionFiles(loaded);
      return {
        ...state,
        busy: false,
        awaitingAck: false,
        currentSession: sessionName,
        compacting: false,
        messages: loaded,
        historyHasOlder: ev.hasOlder === true,
        historyLoaded: ev.messages.length,
        pendingConfirms: [],
        pendingPathAccess: [],
        pendingChoices: [],
        pendingPlans: [],
        pendingCheckpoints: [],
        pendingRevisions: [],
        activePlan: null,
        usage: {
          ...zeroUsage(),
          totalCostUsd: ev.carryover.totalCostUsd,
          costByProvider: ev.carryover.costByProvider ?? {},
          totalPromptTokens: ev.carryover.cacheHitTokens + ev.carryover.cacheMissTokens,
          totalCompletionTokens: ev.carryover.totalCompletionTokens ?? 0,
          cacheHitTokens: ev.carryover.cacheHitTokens,
          cacheMissTokens: ev.carryover.cacheMissTokens,
          // Filtering totals are per-session: zeroUsage() leaves them undefined
          // so the old session's chip never bleeds into the new one. The chip
          // reappears once the new session's first $ctx_breakdown carries fresh
          // totals from the backend.
        },
        sessionFiles,
        sessionEvents: ev.events ?? [],
        activeSkill: null,
        queuedSends: [],
        retryNonce: 0,
      };
    }
    case "$session_history": {
      const older = mapLoadedMessages(ev.messages, ev.turnBase);
      const prepended = [...older, ...state.messages];
      return {
        ...state,
        messages: prepended,
        historyHasOlder: ev.hasOlder,
        historyLoaded: state.historyLoaded + ev.messages.length,
        sessionFiles: deriveSessionFiles(prepended),
      };
    }
    case "$session_empty": {
      // The sidecar successfully ran loadSessionMessages but the jsonl is
      // empty / all-malformed. Without this, the click looks like a no-op
      // because the chat just re-renders empty. Issue #1179.
      const sizeNote = ev.sizeBytes === 0 ? "0 bytes" : `${ev.sizeBytes} bytes, no valid entries`;
      return {
        ...state,
        messages: insertNotice(
          state.messages,
          `Session "${ev.name}" loaded with no messages (${sizeNote}). The file ~/.reasonix/sessions/${ev.name}/messages.jsonl exists but couldn't be parsed: start a new chat or restore from messages.jsonl.bak if you have one.`,
          "error",
        ),
      };
    }
    case "$error":
    case "error": {
      // Kernel-level errors carry a `recoverable` flag: true for
      // storm-repair / repeat-loop warnings the loop already worked
      // around, false for hard failures. The desktop keeps both in the
      // timeline but uses a softer tone for recoverable errors so a session
      // full of self-repaired loops does not look like everything failed.
      const recoverable = ev.type === "error" ? ev.recoverable : false;
      const turn = ev.type === "error" ? ev.turn : undefined;
      const severity: NoticeSeverity = recoverable ? "warning" : "error";
      // $error is NOT terminal: mid-turn hook failures arrive as $error while
      // the loop keeps running, and real turn ends always carry $turn_complete
      // (daemon invariant). Clearing busy here created the UI-idle/
      // daemon-working zombie.
      // A failed compaction's card IS the error display — overwrite it in place
      // (the compaction already closed the turn's card), and refine its Events
      // row with the failure. Without a card the error is a normal boundary.
      const failedCompactIdx = state.messages.findIndex(
        (m) => m.kind === "notice" && m.running === true,
      );
      const failedCompact =
        failedCompactIdx >= 0
          ? settleCompactionCard(state, failedCompactIdx, { text: ev.message, severity })
          : null;
      return {
        ...state,
        oauthWaiting: ev.message.includes("OAuth") ? false : state.oauthWaiting,
        opencodeOAuthWaiting:
          ev.message.includes("OpenCode") || ev.message.includes("opencode_oauth")
            ? false
            : state.opencodeOAuthWaiting,
        mimoOAuthWaiting:
          ev.message.includes("MiMo") || ev.message.includes("mimo_oauth")
            ? false
            : state.mimoOAuthWaiting,
        sessionEvents: failedCompact?.sessionEvents ?? state.sessionEvents,
        // A mid-turn error is a boundary: insertNotice closes the turn's card
        // so later output opens a NEW card below the error.
        messages:
          failedCompact?.messages ?? insertNotice(state.messages, ev.message, severity, turn),
      };
    }
    case "oauth_begin_result":
      return { ...state, oauthWaiting: true };
    case "gemini_oauth_begin_result":
      return { ...state, antigravityOAuthWaiting: true };
    case "opencode_oauth_begin_result":
      return { ...state, opencodeOAuthWaiting: true };
    case "mimo_oauth_begin_result":
      return { ...state, mimoOAuthWaiting: true };
    case "model.turn.started":
      // Repeat only when the turn already has an OPEN card; a colliding ordinal
      // (post-truncation) still opens a fresh card instead of being swallowed.
      if (openAssistantIndex(state.messages, ev.turn) >= 0) {
        return { ...state, model: ev.model, turnLastEventMs: Date.now() };
      }
      return {
        ...state,
        model: ev.model,
        turnStatus: "thinking",
        turnStatusTool: null,
        turnLastEventMs: Date.now(),
        messages: appendAssistantCardBelow(state.messages, ev.turn),
      };
    case "model.delta":
      return {
        ...state,
        turnStatus: ev.channel === "reasoning" ? "reasoning" : "responding",
        turnLastEventMs: Date.now(),
        messages: mapActiveAssistant(state.messages, ev.turn, (m) => {
          if (ev.channel === "content") {
            return {
              ...m,
              segments: appendTextSegment(m.segments, "text", ev.text),
              pending: true,
            };
          }
          if (ev.channel === "reasoning") {
            return {
              ...m,
              segments: appendTextSegment(m.segments, "reasoning", ev.text),
              pending: true,
            };
          }
          return m;
        }),
      };
    case "model.final": {
      const u = ev.usage;
      const promptTokens =
        u?.prompt_tokens ?? (u?.prompt_cache_hit_tokens ?? 0) + (u?.prompt_cache_miss_tokens ?? 0);
      const callHit = u?.prompt_cache_hit_tokens ?? 0;
      const callMiss = u?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - callHit);
      const hasCall = promptTokens > 0 || callHit > 0 || callMiss > 0;
      const usage: UsageStats = {
        totalCostUsd: state.usage.totalCostUsd + (ev.costUsd ?? 0),
        lastCallCostUsd: ev.costUsd ?? 0,
        totalPromptTokens: state.usage.totalPromptTokens + promptTokens,
        totalCompletionTokens: state.usage.totalCompletionTokens + (u?.completion_tokens ?? 0),
        cacheHitTokens: state.usage.cacheHitTokens + callHit,
        cacheMissTokens: state.usage.cacheMissTokens + callMiss,
        lastCallCacheHit: hasCall ? callHit : state.usage.lastCallCacheHit,
        lastCallCacheMiss: hasCall ? callMiss : state.usage.lastCallCacheMiss,
        reservedTokens: state.usage.reservedTokens,
        liveLogTokens: state.usage.liveLogTokens,
        // Dropping the cap here made the context meter fall back to the 300K
        // default after every model call.
        ctxMax: state.usage.ctxMax,
        // Per-session totals are not per-turn — carry them through the rebuild
        // (the rebuild happens within the same session).
        shellOutputRawTokens: state.usage.shellOutputRawTokens,
        shellOutputShownTokens: state.usage.shellOutputShownTokens,
      };
      return {
        ...state,
        usage,
        messages: mapActiveAssistant(state.messages, ev.turn, (m) => {
          // Abort-settled finals (emitAbortedFinal) carry the abort notice in
          // `content`, but the deltas never streamed it — append it so the card
          // isn't a silent empty bubble ("turn ended without any thinking").
          // Skip when text already streamed (would duplicate).
          const hasText = m.segments.some((s) => s.kind === "text");
          let segments = ev.replaceStreamedOutput
            ? [
                ...(ev.reasoningContent
                  ? [{ kind: "reasoning" as const, text: ev.reasoningContent }]
                  : []),
                ...(ev.content ? [{ kind: "text" as const, text: ev.content }] : []),
              ]
            : !ev.forcedSummary && !hasText && ev.content
              ? appendTextSegment(m.segments, "text", ev.content)
              : m.segments;
          if (ev.image) {
            segments = [
              ...segments,
              { kind: "image", dataUrl: ev.image.dataUrl, mimeType: ev.image.mimeType },
            ];
          }
          return { ...m, segments: closeTrailingReasoning(segments), pending: false };
        }),
      };
    }
    case "tool.preparing":
      return {
        ...state,
        turnStatus: "calling_tool",
        turnStatusTool: ev.name,
        turnLastEventMs: Date.now(),
        messages: mapActiveAssistant(state.messages, ev.turn, (m) => {
          if (m.segments.some((s) => s.kind === "tool" && s.callId === ev.callId)) return m;
          return {
            ...m,
            segments: [
              ...closeTrailingReasoning(m.segments),
              {
                kind: "tool",
                callId: ev.callId,
                name: ev.name,
                args: "",
                startedAt: Date.now(),
              },
            ],
          };
        }),
      };
    case "tool.intent": {
      const adds = extractToolFiles(ev.name, ev.args);
      // A subagent spawn is a session event of its own: it is recorded HERE,
      // where the instruction the child was given is on the wire, and settled
      // when its card resolves.
      const sessionEvents = isSubagentTool(ev.name)
        ? recordSubagentSpawn(state, ev.turn, ev.callId, ev.name, ev.args)
        : state.sessionEvents;
      return {
        ...state,
        turnStatus: "calling_tool",
        turnStatusTool: ev.name,
        turnLastEventMs: Date.now(),
        sessionFiles: mergeSessionFiles(state.sessionFiles, adds),
        sessionEvents,
        messages: mapActiveAssistant(state.messages, ev.turn, (m) => {
          const idx = m.segments.findIndex((s) => s.kind === "tool" && s.callId === ev.callId);
          if (idx >= 0) {
            const segs = [...m.segments];
            const seg = segs[idx];
            if (seg?.kind === "tool") {
              segs[idx] = { ...seg, args: ev.args };
            }
            return { ...m, segments: segs };
          }
          return {
            ...m,
            segments: [
              ...m.segments,
              {
                kind: "tool",
                callId: ev.callId,
                name: ev.name,
                args: ev.args,
                startedAt: Date.now(),
              },
            ],
          };
        }),
      };
    }
    case "subagent.progress": {
      // An event belongs to EXACTLY ONE card. Resolve the host across the whole
      // turn first: resolving per message let an event fall through to "this
      // message's only subagent segment" and attach run B to run A's card, so
      // every card in the turn rendered every run's counters.
      // One pass builds every fact the three rules need, so each rule is a predicate
      // over one record shape instead of its own walk of the message list.
      type HostSegment = {
        message: number;
        segment: number;
        callId: string;
        spawn: boolean;
        empty: boolean;
        owns: boolean;
      };
      const hosts: HostSegment[] = [];
      state.messages.forEach((m, mi) => {
        if (m.kind !== "assistant" || m.turn !== ev.turn) return;
        m.segments.forEach((segment, si) => {
          if (segment.kind !== "tool") return;
          hosts.push({
            message: mi,
            segment: si,
            callId: segment.callId,
            spawn: isSubagentTool(segment.name),
            empty: (segment.subagentRuns?.length ?? 0) === 0,
            owns: segment.subagentRuns?.some((run) => run.runId === ev.runId) ?? false,
          });
        });
      });
      // 1. A segment already holding this run wins: identity by runId is exact.
      // 2. Otherwise the spawn's own call id — never a neighbour's card.
      // 3. With no identity at all (older producers), only an unambiguous spawn
      //    segment that has not adopted a run yet may take it. Guessing among
      //    several IS the bug this replaced.
      const adoptable = hosts.filter((h) => h.spawn && h.empty);
      const host =
        hosts.find((h) => h.owns) ??
        (ev.parentCallId
          ? hosts.find((h) => h.spawn && h.callId === ev.parentCallId)
          : undefined) ??
        (adoptable.length === 1 ? adoptable[0] : undefined);
      if (!host) return state;
      const hostMessage = host.message;
      const hostSegment = host.segment;
      return {
        ...state,
        turnLastEventMs: Date.now(),
        messages: state.messages.map((m, mi) => {
          if (mi !== hostMessage || m.kind !== "assistant") return m;
          const segments = [...m.segments];
          const segment = segments[hostSegment];
          if (!segment || segment.kind !== "tool") return m;
          const runs = applySubagentProgress(segment.subagentRuns ?? [], ev);
          segments[hostSegment] = { ...segment, subagentRuns: runs };
          return { ...m, segments };
        }),
      };
    }
    case "tool.result": {
      return {
        ...state,
        // The result is IN: the next thing anyone waits on is the model, and a note
        // from an earlier wait would otherwise surface on the incoming request.
        turnStatus: "waiting_model",
        turnStatusWait: null,
        turnLastEventMs: Date.now(),
        // Settles the spawn's Events row when the call has one; a no-op for every
        // other tool, since the row id is derived from THIS call id.
        sessionEvents: settleSubagentEvent(state, ev.callId, ev.ok),
        messages: state.messages.map((m) => {
          if (m.kind !== "assistant") return m;
          let mutated = false;
          const segs = m.segments.map((s) => {
            if (s.kind === "tool" && s.callId === ev.callId && s.result === undefined) {
              mutated = true;
              return {
                ...s,
                result: ev.output,
                ok: ev.ok,
                durationMs: Date.now() - s.startedAt,
              };
            }
            return s;
          });
          return mutated ? { ...m, segments: segs } : m;
        }),
      };
    }
    case "tool.output": {
      // Transient live stdout/stderr feed for a blocking shell tool. Only the
      // running segment (no result yet) consumes it; once tool.result lands the
      // authoritative output replaces the live view. The WHOLE stream is kept so
      // the user can scroll back through it — the server-side emitter already
      // bounds how much is forwarded, so this is not unbounded.
      if (!ev.text) return state;
      return {
        ...state,
        turnLastEventMs: Date.now(),
        messages: state.messages.map((m) => {
          if (m.kind !== "assistant" || m.turn !== ev.turn) return m;
          let mutated = false;
          const segs = m.segments.map((s) => {
            if (s.kind !== "tool" || s.callId !== ev.callId || s.result !== undefined) return s;
            mutated = true;
            return { ...s, liveOutput: (s.liveOutput ?? "") + ev.text };
          });
          return mutated ? { ...m, segments: segs } : m;
        }),
      };
    }
    case "session.retracted": {
      // Chat state, not session log: the replacement log is the folded/truncated
      // conversation, and it NEVER carries notice cards (those are client-side
      // annotations the daemon stores out-of-band). So carry every notice whose
      // turn still exists forward and MERGE it back into the conversation by turn
      // — none is silently dropped, and each lands beside the turn it annotates
      // instead of being forced to the tail. Notices for turns the replacement
      // removed (a rewind / retry truncation) are the only ones dropped. The
      // in-flight turn's conversation cards are carried too (their live copies
      // hold the logged history plus its not-yet-logged tail).
      const runningTurns = state.messages.flatMap((m) =>
        m.kind === "notice" && m.running === true && m.turn !== undefined ? [m.turn] : [],
      );
      const pendingIdx = pendingAssistantIndex(state.messages);
      const pendingTurn =
        pendingIdx >= 0 && state.messages[pendingIdx]?.kind === "assistant"
          ? (state.messages[pendingIdx] as Extract<ChatMessage, { kind: "assistant" }>).turn
          : null;
      const inflightTurn =
        ev.kind !== "compact" || (pendingTurn === null && runningTurns.length === 0)
          ? null
          : Math.max(pendingTurn ?? -1, ...runningTurns);
      // Loaded user/assistant cards for the in-flight turn are superseded by the
      // live copies below — but a late notice for the in-flight turn must sit
      // after them, so keep the turn's number when computing the surviving range.
      const loaded = mapLoadedMessages(ev.replacementMessages).filter(
        (m) =>
          inflightTurn === null ||
          !((m.kind === "user" || m.kind === "assistant") && m.turn === inflightTurn),
      );
      const loadedMaxTurn = loaded.reduce(
        (max, m) => (m.kind === "user" || m.kind === "assistant" ? Math.max(max, m.turn) : max),
        0,
      );
      const survivingMaxTurn = Math.max(loadedMaxTurn, inflightTurn ?? 0);
      // Split the carried cards: the in-flight turn's cards and its notices form
      // the TAIL (the replacement log does not contain that turn), while a carried
      // notice for a surviving earlier turn is merged back beside its turn. A
      // notice for a turn the replacement dropped goes with the turn.
      const settledNotices: ChatMessage[] = [];
      const inflightCards: ChatMessage[] = [];
      for (const m of state.messages) {
        if (m.kind === "notice") {
          if (m.running === true || (inflightTurn !== null && m.turn === inflightTurn)) {
            inflightCards.push(m);
          } else if ((m.turn ?? 0) <= survivingMaxTurn) {
            settledNotices.push(m);
          }
          continue;
        }
        if (inflightTurn !== null && m.turn === inflightTurn) inflightCards.push(m);
      }
      return {
        ...state,
        messages: [...mergeByTurn(loaded, settledNotices), ...inflightCards],
        // A retraction replaces the transcript wholesale, so it is no longer a
        // windowed page and there is nothing older left to fetch.
        historyHasOlder: false,
        historyLoaded: ev.replacementMessages.length,
        sessionFiles: deriveSessionFiles(loaded),
        // The Events journal follows the same rule as the notice cards above: a
        // verdict for a turn the replacement dropped has nowhere to land, so it
        // goes with the turn instead of becoming a row that jumps to nothing.
        sessionEvents: state.sessionEvents.filter(
          (event) => event.turn <= 0 || event.turn <= survivingMaxTurn,
        ),
      };
    }
    case "$retry_result":
      return { ...state, retryText: ev.text, retryNonce: state.retryNonce + 1 };
    case "$btw_result":
      // A side question never starts or ends a turn — it must not touch busy.
      return {
        ...state,
        messages: insertNotice(state.messages, `≫ btw\n${ev.answer}`, "info"),
      };
    case "status": {
      // Always a liveness ping — the daemon is waiting on something and says so.
      const phase = statusPhase(ev.code);
      if (!phase) return { ...state, turnLastEventMs: Date.now() };
      return {
        ...state,
        turnStatus: phase,
        turnStatusWait: statusWait(ev),
        turnLastEventMs: Date.now(),
      };
    }
    case "compaction.started": {
      if (state.messages.some((m) => m.kind === "notice" && m.running === true)) return state;
      // Seal the in-flight card as the boundary is created: it must render as
      // finished (spinner off, trailing reasoning stamped). Where later output
      // lands is guaranteed by openAssistantIndex.
      const base = closeTurnCard(state.messages, ev.turn);
      const noticeId = nextNoticeId();
      const ts = writeStamp();
      const turn = currentTurnForNotice(base);
      const notice: ChatMessage = {
        kind: "notice",
        id: noticeId,
        text: t("cards.compactingBody"),
        severity: "info",
        turn,
        running: true,
        trigger: ev.trigger,
        ts,
      };
      // Recorded here, while the trigger is known: which path folded the context
      // is not recoverable from the settled card alone. The row carries the card's
      // own stamp so the start and the settle are the same row.
      const sessionEvents = recordEvent(
        state,
        {
          id: compactionEventId(noticeId),
          type: "compaction",
          outcome: ev.trigger,
          anchor: noticeAnchor(noticeId),
        },
        { ts, turn },
      );
      return { ...state, messages: appendNoticeMessage(base, notice), sessionEvents };
    }
    case "$notice": {
      // Manual compaction's completion signal — settles its card in place.
      const runningIdx = state.messages.findIndex(
        (m) => m.kind === "notice" && m.running === true && m.trigger === "manual",
      );
      if (runningIdx >= 0) {
        // Manual compaction's result lands on the running card in place.
        return {
          ...state,
          ...settleCompactionCard(state, runningIdx, { text: ev.text, severity: ev.severity }),
        };
      }
      // A completed action (manual compaction), not a turn status — appended in
      // creation order, after closing the streaming turn's card.
      return { ...state, messages: insertNotice(state.messages, ev.text, ev.severity) };
    }
    case "warning": {
      // High-severity only — eventize already drops "low".
      if (ev.severity !== "high") return state;
      const runningIdx = state.messages.findIndex(
        (m) => m.kind === "notice" && m.running === true && m.trigger !== "manual",
      );
      if (runningIdx >= 0) {
        // Auto/overflow compaction reports through this warning — it becomes
        // the running card's done text instead of an inline assistant segment.
        // Compose through the shared helper so the card shows the summary that
        // replaced the folded context, not just the token-count header.
        const doneText = compactionCardText(ev.text, ev.compactionSummary);
        return {
          ...state,
          ...settleCompactionCard(state, runningIdx, { text: doneText, severity: "success" }),
        };
      }
      const seg: AssistantSegment = {
        kind: "warning",
        id: `w-${ev.id}`,
        text: ev.text,
        severity: ev.severity,
      };
      return {
        ...state,
        messages: appendAssistantSegment(state.messages, seg, ev.turn ?? 1),
      };
    }
    default:
      return state;
  }
}

function truncateOutputLines(text: string, maxLines: number): string {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n");
}

function formatConversationMarkdown(
  messages: ChatMessage[],
  userLabel: string,
  options?: { maxToolOutputLines?: number },
): string {
  return messages
    .map((m) => {
      if (m.kind === "user") return `### ${userLabel}\n\n${m.text}`;
      if (m.kind === "assistant") {
        const body = m.segments
          .map((s) => {
            if (s.kind === "text") return s.text;
            if (s.kind === "reasoning")
              return `<details>\n<summary>${t("app.exportReasoningSummary")}</summary>\n\n${s.text}\n\n</details>`;
            if (s.kind === "tool") {
              const arg = s.args ? `\n\n\`\`\`json\n${s.args}\n\`\`\`` : "";
              let resText = s.result;
              if (resText && options?.maxToolOutputLines !== undefined) {
                resText = truncateOutputLines(resText, options.maxToolOutputLines);
              }
              const res = resText ? `\n\n\`\`\`\n${resText}\n\`\`\`` : "";
              return `> **${t("app.exportToolLabel")} · \`${s.name}\`**${arg}${res}`;
            }
            if (s.kind === "warning") {
              return `> **${t("cards.warningName")}** · ${s.text}`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n\n");
        return `### Reasonix+\n\n${body}`;
      }
      if (m.kind === "notice") return `### ${noticeName(m.severity)}\n\n${m.text}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function defaultExportFilename(session: string): string {
  const safe = sanitizeFilename(session, { max: 200, fallback: "session", allowCjk: true });
  return `${safe}.md`;
}

/** `<option>` / `<optgroup>` list shared by the two Duplicate-session selects.
 *  Keeps the current selection visible even when it's off the enabled allow-list. */
function duplicateModelOptions(
  groups: { key: string; label: string; ids: string[] }[],
  active: string,
): ReactNode {
  const listed = groups.some((g) => g.ids.includes(active));
  return (
    <>
      {active && !listed ? <option value={active}>{modelDisplayName(active)}</option> : null}
      {groups.map((g) => (
        <optgroup key={g.key} label={g.label}>
          {g.ids.map((id) => (
            <option key={id} value={id}>
              {modelDisplayName(id)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

type TabAction = Action;
type TabDispatcher = (action: TabAction) => void;

/** Asks the daemon for the authoritative session list — the one reconciliation entry
 *  point. Neither an escaped hide nor a stuck intent reveals a row by itself. */
function requestSessionList(tabId: string): void {
  void rpcSend({ tabId, cmd: "session_list" }).catch((err) =>
    recordFrontendFailure("frontend.session_list_resync_failed", err),
  );
}

interface TabRuntimeProps {
  tabId: string;
  active: boolean;
  /** True for the tab that was visible a moment ago: its transcript stays mounted
   *  (hidden) so returning to it does not remount and re-parse the conversation. */
  keepAlive?: boolean;
  backendConnected: boolean;
  currency: "CNY" | "USD";
  registerDispatch: (tabId: string, d: TabDispatcher | null) => void;
  onWorkspaceInitialized: (tabId: string) => void;
  onNewTab: () => void;
  /** This channel's workspace session list — owned by App and shared by every
   *  channel on the same directory, so no channel can disagree with another. */
  sessionView: SessionView;
  /** Records a delete/clear/create the user asked for on this channel's workspace.
   *  `keep` names a clear-all must leave visible (sessions that cannot be deleted). */
  onSessionIntent: (
    workspaceDir: string | undefined,
    kind: SessionMutation["kind"],
    name?: string,
    keep?: readonly string[],
  ) => void;
  /** Applies an optimistic row edit (rename/reorder) until a snapshot confirms it. */
  onSessionPatch: (
    workspaceDir: string | undefined,
    name: string,
    patch: Partial<SessionInfo>,
  ) => void;
  /** Reports this channel's running-agent state so the tab dot can count them. */
  onBusyChange: (tabId: string, busy: boolean) => void;
  /** Live provider output rate (tokens/second) keyed by session name, for the
   *  sidebar readout beside every running session. */
  sessionRates: Map<string, number>;
  theme: Theme;
  themeStyle: ThemeStyle;
  onSetThemeStyle: (style: ThemeStyle) => void;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  sideCollapsed: boolean;
  ctxCollapsed: boolean;
  sideWidth: number;
  ctxWidth: number;
  threadMaxWidth: number;
  onSideResizeDown: (e: React.MouseEvent) => void;
  onCtxResizeDown: (e: React.MouseEvent) => void;
  onToggleSide: () => void;
  onToggleCtx: () => void;
  onToggleCurrency: () => void;
  /** App-global Ollama model catalog (raw ids, e.g. `llama3.1:latest`) — shared
   *  across every tab; the catalog depends on global config, not on the tab. */
  ollamaModels: string[];
  /** Why the last Ollama model fetch failed — replaces the picker list. */
  ollamaModelsError: string | null;
  /** The account's Ollama plan (e.g. `free`) when the cloud reported it. */
  ollamaPlan: string | null;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount: number;
  /** Prefixed vision-capable Ollama model ids (`ollama/llava`) confirmed by the
   *  daemon — lets image-capable Ollama models accept attachments. */
  ollamaVisionModels: ReadonlySet<string>;
  /** Re-fetch the app-global Ollama catalog (`force` bypasses the cache). */
  onRefreshOllamaModels: (force?: boolean) => void;
  /** Re-fetch the signed-in account's Antigravity quota model ids. */
  onRefreshAntigravityModels: () => void;
  /** App-global OpenCode free model catalog. */
  opencodeModels: string[];
  opencodeModelsError: string | null;
  opencodeVisionModels: ReadonlySet<string>;
  onRefreshOpencodeModels: (force?: boolean) => void;
  /** Repo commit history grouped per release, plus a forced-refetch trigger. */
  changelog: ChangelogState;
  onRefreshChangelog: (force?: boolean) => void;
  tabsList: {
    id: string;
    workspaceDir?: string;
    session?: string;
    group?: string;
    busy?: boolean;
  }[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  onRemoveWorkspace: (path: string) => void;
}

/** Memoized at their single call site: TabRuntime re-renders on every streamed
 *  delta, and each shell child reads a small set of stable props. */
const MemoTitleBar = memo(TitleBar);
const MemoTabBar = memo(TabBar);
const MemoSidebar = memo(Sidebar);
const MemoContextPanel = memo(ContextPanel);
const MemoStatusBar = memo(StatusBar);

/** Memoized because App re-renders on every rate tick and tab-list change, and
 *  each mounted tab carries a whole shell: without this boundary every one of
 *  them reconciled its transcript and sidebar for a prop change it never saw. */
const TabRuntime = memo(function TabRuntime({
  tabId,
  active,
  keepAlive,
  backendConnected,
  currency,
  registerDispatch,
  onWorkspaceInitialized,
  onNewTab,
  sessionView: {
    items: sessions,
    mutation: sessionsMutation,
    pendingDeleteCount,
    confirmed: sessionsConfirmed,
    openIntentId: sessionIntentId,
  },
  onSessionIntent,
  onSessionPatch,
  onBusyChange,
  sessionRates,
  theme,
  themeStyle,
  onSetThemeStyle,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  sideCollapsed,
  ctxCollapsed,
  sideWidth,
  ctxWidth,
  threadMaxWidth,
  onSideResizeDown,
  onCtxResizeDown,
  onToggleSide,
  onToggleCtx,
  onToggleCurrency,
  ollamaModels,
  ollamaModelsError,
  ollamaPlan,
  ollamaHiddenCount,
  ollamaVisionModels,
  onRefreshOllamaModels,
  onRefreshAntigravityModels,
  opencodeModels,
  opencodeModelsError,
  opencodeVisionModels,
  onRefreshOpencodeModels,
  changelog,
  onRefreshChangelog,
  tabsList,
  activeTabId,
  setActiveTabId,
  onRemoveWorkspace,
}: TabRuntimeProps) {
  const [state, dispatch] = useReducer(reduce, {
    ready: false,
    needsSetup: false,
    busy: false,
    awaitingAck: false,
    compacting: false,
    messages: [],
    messagesVersion: 0,
    historyHasOlder: false,
    historyLoaded: 0,
    pendingConfirms: [],
    pendingPathAccess: [],
    pendingChoices: [],
    pendingPlans: [],
    pendingCheckpoints: [],
    pendingRevisions: [],
    activePlan: null,
    usage: zeroUsage(),
    workspaceInitializationRevision: 0,
    settings: null,
    balance: null,
    codexQuota: null,
    codexQuotaRefreshing: false,
    codexQuotaReason: null,
    ollamaQuota: null,
    ollamaQuotaRefreshing: false,
    ollamaQuotaReason: null,
    antigravityQuota: null,
    antigravityQuotaRefreshing: false,
    antigravityQuotaReason: null,
    zaiQuota: null,
    zaiQuotaRefreshing: false,
    zaiQuotaReason: null,
    opencodeQuota: null,
    opencodeQuotaRefreshing: false,
    opencodeQuotaReason: null,
    mentionResults: null,
    mentionPreview: null,
    mcpSpecs: [],
    mcpBridged: false,
    mcpSetup: null,
    mcpSetupRevision: 0,
    mcpExtensionStatus: null,
    mcpExtensionCheck: null,
    mailAuth: null,
    playwrightBrowserInstall: null,
    skills: [],
    sessionFiles: [],
    sessionEvents: [],
    memory: [],
    memoryDetail: null,
    memoryResult: null,
    jobs: [],
    activeSkill: null,
    lastTurnOutcome: null,
    queuedSends: [],
    retryNonce: 0,
    oauthWaiting: false,
    antigravityOAuthWaiting: false,
    opencodeOAuthWaiting: false,
    mimoOAuthWaiting: false,
    turnStatus: null,
    turnStatusTool: null,
    turnStatusWait: null,
    turnLastEventMs: 0,
    turnElapsedMs: 0,
  });
  // A tab that has rendered visible keeps its reducer live (busy reporting,
  // gates, rates) while hidden, but renders the last visible snapshot so the
  // memoized children bail out; a tab that never rendered visible stays live.
  const lastVisibleState = useRef(state);
  const seenVisible = useRef(active);
  useEffect(() => {
    if (!active) return;
    seenVisible.current = true;
    lastVisibleState.current = state;
  }, [active, state]);
  const view = active || !seenVisible.current ? state : lastVisibleState.current;
  useLang();
  useDisableTextAssist();
  const [draftStore] = useState(createComposerDraft);
  const { setDraft } = draftStore;
  // Vision attachments queued for the next send (ChatGPT models only).
  const [pendingImages, setPendingImages] = useState<
    Array<{ id: string; thumbnail: string; wire: UserImageAttachment }>
  >([]);
  const [splashOn, setSplashOn] = useState<boolean>(() => shouldShowSplash());
  const [wdOpen, setWdOpen] = useState(false);
  const [wdAnchor, setWdAnchor] = useState<
    { top?: number; bottom?: number; left: number } | undefined
  >(undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const threadInnerRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId>("general");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const previousApprovalSnapshotRef = useRef<ApprovalSnapshot>({
    confirms: [],
    pathAccess: [],
    choices: [],
    plans: [],
    checkpoints: [],
    revisions: [],
  });
  // Plan rail state on the previous render — drives the plan-complete cue's
  // active → finished transition detection.
  const previousPlanRef = useRef<PlanFeedbackState | null>(null);
  // High-severity repetition-guard warnings seen since the last notification
  // pass — consumed once, then cleared.
  const guardWarningsRef = useRef<{ cause?: string }[]>([]);
  const wasBusyRef = useRef(false);
  const busyStartedAtRef = useRef<number | null>(null);
  const abortDraftRef = useRef<string | null>(null);
  const clearAbortDraft = useCallback(() => {
    abortDraftRef.current = nextAbortDraftCandidate(abortDraftRef.current, { type: "clear" });
  }, []);
  const recordAbortDraft = useCallback((source: AbortDraftSource, text: string) => {
    abortDraftRef.current = nextAbortDraftCandidate(abortDraftRef.current, {
      type: "record",
      source,
      text,
    });
  }, []);
  const openSettingsAt = useCallback((page: SettingsPageId = "general") => {
    setSettingsPage(page);
    setSettingsOpen(true);
  }, []);

  // Feedback cue plumbing. Sounds and notifications fire from event delivery
  // (not the reducer): the reducer must stay pure, and the cue matrix lives in
  // settings state the reducer does not reduce. The wrapper sees every action
  // exactly once, in arrival order.
  const cuesRef = useRef<FeedbackCueSettings | null | undefined>(null);
  cuesRef.current = state.settings?.feedbackCues;
  // The daemon broadcasts `$settings` after every save — once per open tab, so
  // this tab also receives echoes triggered by OTHER tabs' saves. Each echo is a
  // full snapshot of the persisted state, so a snapshot older than the user's
  // latest click would replay that older state over the UI. Keep the fields the
  // user just changed authoritative: after each echo, re-assert any override the
  // echo does not already reflect (deep-equal), and drop an override the moment
  // its value comes back — that is the echo of our own write confirming it. A
  // TTL bounds divergence for the rare field the daemon normalizes.
  const settingsOverridesRef = useRef<SettingsPatch | null>(null);
  const settingsOverridesExpireAtRef = useRef(0);
  const cueDispatch = useCallback((action: TabAction) => {
    if (action.t === "incoming") {
      handleCueForEvent(action.event, cuesRef.current, feedbackSounds, guardWarningsRef.current);
      dispatch(action);
      if (action.event.type === "$settings") {
        const overrides = settingsOverridesRef.current;
        if (overrides && Date.now() > settingsOverridesExpireAtRef.current) {
          // TTL elapsed: accept the daemon's value even if it never matched.
          settingsOverridesRef.current = null;
        } else if (overrides) {
          const ev = action.event as unknown as Record<string, unknown>;
          const remaining: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(overrides)) {
            if (!settingsValueEqual(ev[key], value)) remaining[key] = value;
          }
          if (Object.keys(remaining).length === 0) {
            settingsOverridesRef.current = null;
          } else {
            settingsOverridesRef.current = remaining as SettingsPatch;
            dispatch({ t: "settings_patch", patch: remaining as SettingsPatch });
          }
        }
      }
      return;
    }
    dispatch(action);
  }, []);

  useEffect(() => {
    registerDispatch(tabId, cueDispatch);
    return () => registerDispatch(tabId, null);
  }, [tabId, registerDispatch, cueDispatch]);

  useEffect(() => {
    if (state.workspaceInitializationRevision === 0) return;
    onWorkspaceInitialized(tabId);
  }, [onWorkspaceInitialized, state.workspaceInitializationRevision, tabId]);

  // Voice input is only usable once at least one model is downloaded. Refresh
  // on mount and whenever the settings modal closes (downloads happen there).
  const prevSettingsOpenRef = useRef<boolean | null>(null);
  useEffect(() => {
    const prev = prevSettingsOpenRef.current;
    prevSettingsOpenRef.current = settingsOpen;
    // Refresh on mount (prev === null) and on the open→closed transition.
    if (prev === null || (prev && !settingsOpen)) {
      let cancelled = false;
      anyVoiceModelDownloaded().then((ok) => {
        if (!cancelled) setVoiceAvailable(ok);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [settingsOpen]);

  const rpcQueue = useRef(Promise.resolve());
  const sendRpc = useCallback(
    (cmd: OutgoingCommand) => {
      const queued = rpcQueue.current.then(() => rpcSend({ tabId, ...cmd }));
      rpcQueue.current = queued.catch((err) =>
        recordFrontendFailure("frontend.rpc_failed", err, { cmd: cmd.cmd }),
      );
    },
    [tabId],
  );

  // Optimistic by design: apply the patch to local state first, then persist.
  // Waiting for the daemon's `$settings` echo (which re-emits for every open
  // tab) made every control feel laggy — the whole point is the UI reacts now.
  // Bursts of clicks are coalesced into one save, and the latest patch is kept
  // in `optimisticSettingsRef` (re-asserted after each echo, see cueDispatch)
  // so an in-flight echo can't roll a control back under the user's fingers.
  const pendingSettingsRef = useRef<SettingsPatch>({});
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSettings = useCallback(() => {
    settingsTimerRef.current = null;
    const patch = pendingSettingsRef.current;
    pendingSettingsRef.current = {};
    if (Object.keys(patch).length > 0) sendRpc({ cmd: "settings_save", ...patch });
  }, [sendRpc]);
  const saveSettings = useCallback(
    (patch: SettingsPatch) => {
      dispatch({ t: "settings_patch", patch });
      settingsOverridesRef.current = { ...(settingsOverridesRef.current ?? {}), ...patch };
      settingsOverridesExpireAtRef.current = Date.now() + SETTINGS_OVERRIDE_TTL_MS;
      pendingSettingsRef.current = { ...pendingSettingsRef.current, ...patch };
      if (settingsTimerRef.current !== null) clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = setTimeout(flushSettings, SETTINGS_SAVE_DEBOUNCE_MS);
    },
    [dispatch, flushSettings],
  );
  const refreshCodexQuota = useCallback(() => {
    dispatch({ t: "codex_quota_refreshing" });
    sendRpc({ cmd: "codex_quota_get" });
  }, [sendRpc]);
  const refreshOllamaQuota = useCallback(() => {
    dispatch({ t: "ollama_quota_refreshing" });
    sendRpc({ cmd: "ollama_quota_get" });
  }, [sendRpc]);
  const refreshAntigravityQuota = useCallback(() => {
    dispatch({ t: "antigravity_quota_refreshing" });
    sendRpc({ cmd: "antigravity_quota_get" });
  }, [sendRpc]);
  const refreshZaiQuota = useCallback(() => {
    dispatch({ t: "zai_quota_refreshing" });
    sendRpc({ cmd: "zai_quota_get" });
  }, [sendRpc]);
  const refreshOpencodeQuota = useCallback(() => {
    dispatch({ t: "opencode_quota_refreshing" });
    sendRpc({ cmd: "opencode_quota_get" });
  }, [sendRpc]);
  // Fetch the Ollama catalog whenever the tab's model is an Ollama model — the
  // composer menu and the Models settings page render the fetched list. The
  // list itself is app-global (backend cache + App-level state), so this only
  // nudges a refresh; non-force calls reuse the backend's 60s cache.
  const activeModel = state.settings?.model;
  useEffect(() => {
    if (typeof activeModel === "string" && activeModel.startsWith("ollama/")) {
      onRefreshOllamaModels();
    }
  }, [activeModel, onRefreshOllamaModels]);
  const saveApiKey = useCallback(
    (key: string) => sendRpc({ cmd: "setup_save_key", key }),
    [sendRpc],
  );
  const addMcpSpec = useCallback(
    (spec: string) => sendRpc({ cmd: "mcp_specs_add", spec }),
    [sendRpc],
  );
  const removeMcpSpec = useCallback(
    (spec: string) => sendRpc({ cmd: "mcp_specs_remove", spec }),
    [sendRpc],
  );
  const toggleMcpServer = useCallback(
    (name: string, disabled: boolean) => sendRpc({ cmd: "mcp_specs_toggle", name, disabled }),
    [sendRpc],
  );
  const requestMcpExtensionStatus = useCallback(
    () => sendRpc({ cmd: "mcp_extension_status" }),
    [sendRpc],
  );
  const configureMcpExtension = useCallback(
    (
      mode: PlaywrightMcpConnectionMode,
      token?: string,
      cdpEndpoint?: string,
      extensionBrowser?: PlaywrightExtensionBrowser,
    ) => sendRpc({ cmd: "mcp_extension_configure", mode, token, cdpEndpoint, extensionBrowser }),
    [sendRpc],
  );
  const checkMcpExtension = useCallback(() => sendRpc({ cmd: "mcp_extension_check" }), [sendRpc]);
  const installPlaywrightBrowser = useCallback(
    (browser: PlaywrightManagedBrowser) => sendRpc({ cmd: "playwright_browser_install", browser }),
    [sendRpc],
  );
  const cancelPlaywrightBrowserInstall = useCallback(
    (browser: PlaywrightManagedBrowser) =>
      sendRpc({ cmd: "playwright_browser_install_cancel", browser }),
    [sendRpc],
  );
  const setMailProvider = useCallback(
    (provider: MailProvider) => sendRpc({ cmd: "mail_provider_set", provider }),
    [sendRpc],
  );
  const requestMailStatus = useCallback(
    (provider: MailProvider) => sendRpc({ cmd: "mail_status", provider }),
    [sendRpc],
  );
  const configureMail = useCallback(
    (provider: MailProvider, clientId?: string, clientSecret?: string) =>
      sendRpc({ cmd: "mail_configure", provider, clientId, clientSecret }),
    [sendRpc],
  );
  const connectMail = useCallback(
    (provider: MailProvider) => sendRpc({ cmd: "mail_connect", provider }),
    [sendRpc],
  );
  const cancelMail = useCallback(
    (provider: MailProvider) => sendRpc({ cmd: "mail_cancel", provider }),
    [sendRpc],
  );
  const signOutMail = useCallback(
    (provider: MailProvider) => sendRpc({ cmd: "mail_signout", provider }),
    [sendRpc],
  );
  const addRule = useCallback((rule: RuleRecord) => sendRpc({ cmd: "rule_add", rule }), [sendRpc]);
  const removeRule = useCallback(
    (rule: RuleRecord) => sendRpc({ cmd: "rule_remove", rule }),
    [sendRpc],
  );
  const updateRule = useCallback(
    (from: RuleRecord, to: RuleRecord) => sendRpc({ cmd: "rule_update", from, to }),
    [sendRpc],
  );
  const copyWorkspaceRules = useCallback(
    (from: string) => sendRpc({ cmd: "workspace_rules_copy", from }),
    [sendRpc],
  );
  const newChat = useCallback(() => {
    // One workspace mutation at a time: the shortcut must not stack creates behind a
    // delete that is still waiting for its settling snapshot.
    if (sessionsMutation !== null) return;
    clearAbortDraft();
    // Composer state belongs to the old conversation — drop it now so a
    // half-typed draft can't leak into the fresh session.
    setDraft("");
    setPendingImages([]);
    // Lock the workspace NOW, not when the daemon's `creating` echo arrives: that
    // round-trip leaves every New chat control reading idle, and a double click in
    // the gap mints a second session. A name-less intent hides no row.
    const workspaceDir = state.settings?.workspaceDir;
    if (workspaceDir) onSessionIntent(workspaceDir, "create");
    // The transcript clear comes from the daemon's $session_loaded reply —
    // clearing optimistically here orphans the UI on a blank screen when the
    // RPC fails while the backend still points at the old session.
    rpcSend({ tabId, cmd: "new_chat" }).catch((err) => {
      recordFrontendFailure("frontend.new_chat_failed", err);
      dispatch({
        t: "push_notice",
        text: `Couldn't start a new chat: ${messageOf(err)}. Your current conversation is untouched.`,
        severity: "error",
      });
    });
  }, [clearAbortDraft, onSessionIntent, sessionsMutation, state.settings?.workspaceDir, tabId]);

  const pickWorkspace = useCallback(async () => {
    // Browsing ends in a workspace switch, so it is locked like the picker.
    if (sessionsMutation !== null) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("workdir.title"),
        defaultPath: state.settings?.workspaceDir,
      });
      if (typeof picked === "string" && picked.length > 0) {
        clearAbortDraft();
        saveSettings({ workspaceDir: picked });
      }
    } catch (err) {
      recordFrontendFailure("frontend.pick_workspace_failed", err);
    }
  }, [clearAbortDraft, saveSettings, sessionsMutation, state.settings?.workspaceDir]);

  const openTabWorkspaces = useMemo(() => {
    return (tabsList ?? [])
      .map((t) => t.workspaceDir)
      .filter((ws): ws is string => typeof ws === "string" && ws.length > 0);
  }, [tabsList]);

  const mergedWorkspaces = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const ws of openTabWorkspaces) {
      const key = ws.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        list.push(ws);
      }
    }
    for (const ws of state.settings?.recentWorkspaces ?? []) {
      const key = ws.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        list.push(ws);
      }
    }
    return list;
  }, [openTabWorkspaces, state.settings?.recentWorkspaces]);

  const appendNotice = useCallback((text: string, severity: NoticeSeverity = "info") => {
    dispatch({ t: "push_notice", text, severity });
  }, []);

  // Persist the transcript's annotation cards (notices + assistant warning
  // segments) with the session so none is transient — the daemon stores them in
  // the session's notices sidecar and merges them back on load/resync.
  const notices = useMemo(() => collectPersistedNotices(state.messages), [state.messages]);
  const noticesSync = useMemo<OutgoingCommand>(() => ({ cmd: "notices_sync", notices }), [notices]);
  useSidecarSync(state.currentSession, noticesSync, sendRpc);

  // Persist the session's recorded events (plan/choice verdicts, folds) so the
  // Events tab survives a reload. Same sidecar contract as the notices above.
  const eventsSync = useMemo<OutgoingCommand>(
    () => ({ cmd: "events_sync", events: state.sessionEvents }),
    [state.sessionEvents],
  );
  useSidecarSync(state.currentSession, eventsSync, sendRpc);

  // Vision attachments (gpt-* + DeepSeek vision models): paste carries bytes
  // from the webview; picked/dropped files ship a path the daemon reads.
  // Pending images render as thumbnails above the composer until send.
  // Capability follows the SELECTED model (settings.model, mirrored from the
  // daemon's $settings): the top-level state.model only updates when a turn
  // starts, so right after a switch to a vision model it still reports the
  // previous model and would misroute pastes to the non-vision path.
  const imageCapable = modelAcceptsImages(
    state.settings?.model,
    ollamaVisionModels,
    opencodeVisionModels,
  );
  /** The quick send the composer marks: the persisted default, resolved so an
   *  unset or stale id still lands on Proceed. */
  const activeQuickSend = resolveActiveQuickSend(
    state.settings?.quickSendId,
    state.settings?.quickSends ?? [],
  );
  const mediaCapable = modelAcceptsAudioVideo(state.settings?.model);
  const attachPastedImage = useCallback(
    async (file: File) => {
      try {
        const raw = await fileToDataUrl(file);
        const dataUrl = await downscaleImage(raw);
        setPendingImages((prev) => [
          ...prev,
          {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            thumbnail: dataUrl,
            wire: { source: "clipboard", dataUrl },
          },
        ]);
      } catch (err) {
        recordFrontendFailure("frontend.image_attach_failed", err);
        appendNotice(t("composer.imageAttachFailed"), "error");
      }
    },
    [appendNotice],
  );
  const attachPickedImage = useCallback((path: string) => {
    setPendingImages((prev) => [
      ...prev,
      {
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        thumbnail: convertFileSrc(path),
        wire: { source: "file", path },
      },
    ]);
  }, []);
  const attachPickedMedia = useCallback((path: string) => {
    const kind = mediaKindForPath(path);
    if (!kind) return;
    setPendingImages((prev) => [
      ...prev,
      {
        id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        thumbnail: kind === "audio" ? AUDIO_ATTACH_ICON : VIDEO_ATTACH_ICON,
        wire:
          kind === "video"
            ? { source: "file", path, kind, fps: 2, mediaResolution: "default" }
            : { source: "file", path, kind },
      },
    ]);
  }, []);
  const updatePendingMedia = useCallback(
    (id: string, patch: { fps?: number; mediaResolution?: "default" | "max" }) => {
      setPendingImages((prev) =>
        prev.map((im) =>
          im.id === id && im.wire?.source === "file"
            ? { ...im, wire: { ...im.wire, ...patch } }
            : im,
        ),
      );
    },
    [],
  );
  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((im) => im.id !== id));
  }, []);

  const applyReasoningEffort = useCallback(
    (reasoningEffort: Settings["reasoningEffort"]) => {
      saveSettings({ reasoningEffort });
      appendNotice(t("app.toast.effortSwitched", { effort: reasoningEffort }));
    },
    [saveSettings, appendNotice],
  );

  const applyEditMode = useCallback(
    (mode: Settings["editMode"]) => {
      saveSettings({ editMode: mode });
      if (mode === "never-ask") {
        appendNotice(t("app.neverAskRules.toast"), "warning");
      } else {
        appendNotice(t("app.toast.modeSwitched", { mode: mode.toUpperCase() }));
      }
    },
    [saveSettings, appendNotice],
  );

  const dropActiveRef = useRef(active);
  useEffect(() => {
    dropActiveRef.current = active;
  }, [active]);
  useEffect(() => {
    const ws = state.settings?.workspaceDir;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/webview");
        const webview = mod.getCurrentWebview();
        const handle = await webview.onDragDropEvent((event) => {
          if (!dropActiveRef.current) return;
          if (event.payload.type === "enter") {
            document.body.style.setProperty("--drop-overlay-label", `"${t("dragDrop.overlay")}"`);
            document.body.dataset.dragOver = "1";
            return;
          }
          if (event.payload.type === "leave") {
            delete document.body.dataset.dragOver;
            return;
          }
          if (event.payload.type !== "drop") return;
          delete document.body.dataset.dragOver;
          const paths = event.payload.paths ?? [];
          if (paths.length === 0) return;
          const imageCapable = modelAcceptsImages(
            state.settings?.model,
            ollamaVisionModels,
            opencodeVisionModels,
          );
          const mediaCapable = modelAcceptsAudioVideo(state.settings?.model);
          const imagePaths = imageCapable ? paths.filter(isImagePath) : [];
          const mediaPaths = mediaCapable
            ? paths.filter((p) => !isImagePath(p) && mediaKindForPath(p) !== undefined)
            : [];
          for (const p of imagePaths) attachPickedImage(p);
          for (const p of mediaPaths) attachPickedMedia(p);
          const handled = new Set([...imagePaths, ...mediaPaths]);
          const mentionPaths = paths.filter((p) => !handled.has(p));
          if (mentionPaths.length > 0) {
            const mentions = mentionPaths.map((path) => toWorkspaceRelative(path, ws));
            setDraft((d) => {
              const prefix = d.trim() ? `${d.replace(/\s+$/, "")} ` : "";
              return `${prefix}${mentions.join(" ")} `;
            });
          }
          composerRef.current?.focus();
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch (err) {
        recordFrontendFailure("frontend.dragdrop_listen_failed", err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      delete document.body.dataset.dragOver;
    };
  }, [
    state.settings?.workspaceDir,
    state.settings?.model,
    attachPickedImage,
    attachPickedMedia,
    ollamaVisionModels,
    opencodeVisionModels,
  ]);

  // A fold is a busy stretch the daemon runs without a turn of its own. Its
  // pushed `compacting` flag is the single source of truth, so a stuck compaction
  // card can never wedge the queue. `engaged` is the one predicate the composer,
  // the drain and send() share: a turn OR a fold is in flight, so a send QUEUES.
  const engaged = state.busy || state.awaitingAck || state.compacting;

  const send = useCallback(
    (override?: string | QueuedSend) => {
      let text = draftStore.getSnapshot().trim();
      let sendImages: UserImageAttachment[] = pendingImages.map((im) => im.wire);
      let sendImageUrls: string[] = pendingImages.map((im) => im.thumbnail);

      if (override !== undefined) {
        if (typeof override === "string") {
          text = override.trim();
        } else {
          text = override.text.trim();
          if (override.images && override.images.length > 0) {
            sendImages = override.images
              .map((im) => im.wire)
              .filter((w): w is UserImageAttachment => Boolean(w));
            sendImageUrls = override.images.map((im) => im.thumbnail);
          } else {
            sendImages = [];
            sendImageUrls = [];
          }
        }
      }

      if ((!text && sendImages.length === 0) || !state.ready || engaged) return;

      const clientId = `c-${Date.now()}`;
      // ChatGPT models: typed `@path` image mentions get an optimistic echo —
      // stripped tokens + asset-protocol icons — while the daemon still
      // receives the original text and does the real conversion server-side.
      // Without this the live chat shows the raw @path until session reload.
      let echoText = text;
      let echoImages = sendImageUrls;
      if (imageCapable) {
        const typed = typedMentionImages(text, state.settings?.workspaceDir);
        echoText = typed.text;
        if (typed.images.length > 0) echoImages = [...sendImageUrls, ...typed.images];
      }
      recordAbortDraft("user_input", text);
      dispatch({
        t: "send_user",
        text: echoText,
        clientId,
        images: echoImages.length > 0 ? echoImages : undefined,
      });
      sendRpc({ cmd: "user_input", text, images: sendImages.length > 0 ? sendImages : undefined });
      if (override === undefined) {
        setPendingImages([]);
        setDraft("");
      }
    },
    [
      draftStore,
      setDraft,
      pendingImages,
      imageCapable,
      state.ready,
      engaged,
      state.settings?.workspaceDir,
      sendRpc,
      recordAbortDraft,
    ],
  );

  const abort = useCallback(() => {
    const restored = restoreAbortedDraft(draftStore.getSnapshot(), abortDraftRef.current);
    clearAbortDraft();
    if (restored !== null) {
      setDraft(restored);
      composerRef.current?.focus();
    }
    sendRpc({ cmd: "abort" });
  }, [clearAbortDraft, draftStore, setDraft, sendRpc]);

  useEffect(() => {
    if (!state.busy && !state.awaitingAck) clearAbortDraft();
  }, [clearAbortDraft, state.busy, state.awaitingAck]);

  // Turn-state parity watchdog: while a turn is engaged, poll the daemon's
  // authoritative tab_status (interval + focus + reconnect); release a send
  // the daemon never acknowledged.
  const releaseStaleSend = useCallback(() => dispatch({ t: "release_stale_send" }), []);
  const probeTabStatus = useCallback(() => sendRpc({ cmd: "tab_status" }), [sendRpc]);
  useTurnWatchdog({
    engaged,
    awaitingAckWithoutBusy: state.awaitingAck && !state.busy,
    connected: backendConnected,
    probe: probeTabStatus,
    onStaleAck: releaseStaleSend,
  });

  // When retry returns the last user text, set it as the composer draft.
  // Only fire when retryNonce changes — retryText alone would re-fire on re-renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryText deliberately left out (see above)
  useEffect(() => {
    if (state.retryNonce > 0 && state.retryText) {
      setDraft(state.retryText);
      composerRef.current?.focus();
    }
  }, [state.retryNonce]);

  useEffect(() => {
    // Hold the drain through a fold too: the queued message must land AFTER the
    // compaction settles, not race it.
    if (engaged || !state.ready || state.queuedSends.length === 0) return;
    const next = state.queuedSends[0];
    if (!next) return;
    dispatch({ t: "shift_queued_send" });
    send(next);
  }, [engaged, state.ready, state.queuedSends, send]);

  useEffect(() => {
    const currentSnapshot: ApprovalSnapshot = {
      confirms: state.pendingConfirms.map((c) => ({ id: c.id, command: c.command })),
      pathAccess: state.pendingPathAccess.map((p) => ({
        id: p.id,
        path: p.path,
        intent: p.intent,
      })),
      choices: state.pendingChoices.map((c) => ({ id: c.id, question: c.question })),
      plans: state.pendingPlans.map((p) => ({ id: p.id, summary: p.summary, plan: p.plan })),
      checkpoints: state.pendingCheckpoints.map((c) => ({
        id: c.id,
        title: c.title,
        result: c.result,
      })),
      revisions: state.pendingRevisions.map((r) => ({
        id: r.id,
        summary: r.summary,
        reason: r.reason,
      })),
    };
    const previousSnapshot = previousApprovalSnapshotRef.current;
    const wasBusy = wasBusyRef.current;
    const busyDurationMs =
      wasBusy && !state.busy && busyStartedAtRef.current
        ? Date.now() - busyStartedAtRef.current
        : 0;

    if (state.busy && busyStartedAtRef.current === null) {
      busyStartedAtRef.current = Date.now();
    } else if (!state.busy) {
      busyStartedAtRef.current = null;
    }

    // Guard warnings collected from the event stream since the last pass are
    // consumed here (focused or not): the sound already played on arrival; the
    // ref must drain so a later unfocus doesn't replay a stale warning.
    const guardWarnings = guardWarningsRef.current;
    guardWarningsRef.current = [];

    const currentPlan: PlanFeedbackState | null = state.activePlan
      ? {
          status: state.activePlan.status ?? "active",
          totalSteps: state.activePlan.steps.length,
          completedSteps: state.activePlan.completedStepIds.length,
        }
      : null;
    const previousPlan = previousPlanRef.current;
    previousPlanRef.current = currentPlan;
    previousApprovalSnapshotRef.current = currentSnapshot;
    wasBusyRef.current = state.busy;

    const cues = state.settings?.feedbackCues;

    // Sounds for state-driven cues fire regardless of window focus (a cue is
    // the user's opt-in acknowledgment); the focus-gated OS notification path
    // is separate below.
    for (const id of deriveStateCueSounds({
      wasBusy,
      isBusy: state.busy,
      busyDurationMs,
      outcome: state.lastTurnOutcome,
      previousPlan,
      currentPlan,
    })) {
      playEnabledCue(cues, id, feedbackSounds);
    }

    void getCurrentWindow()
      .isFocused()
      .catch(() => true)
      .then((focused) => {
        if (
          shouldAppendCompletionNotice({
            wasBusy,
            isBusy: state.busy,
            busyDurationMs,
            focused,
            outcome: state.lastTurnOutcome,
          })
        ) {
          appendNotice(t("app.toast.taskComplete"), "success");
        }
        const notifications = deriveDesktopNotifications({
          previous: previousSnapshot,
          current: currentSnapshot,
          wasBusy,
          isBusy: state.busy,
          busyDurationMs,
          focused,
          outcome: state.lastTurnOutcome,
          cues,
          previousPlan,
          currentPlan,
          guardWarnings,
        });
        void dispatchDesktopNotifications(notifications, cues, {
          isFocused: async () => focused,
          isPermissionGranted: isNotificationPermissionGranted,
          requestPermission: requestNotificationPermission,
          sendNotification,
        });
      });
  }, [
    appendNotice,
    state.activePlan,
    state.busy,
    state.lastTurnOutcome,
    state.pendingChoices,
    state.pendingCheckpoints,
    state.pendingConfirms,
    state.pendingPathAccess,
    state.pendingPlans,
    state.pendingRevisions,
    state.settings?.feedbackCues,
  ]);

  const resolveConfirm = useCallback(
    (id: number, response: ConfirmationChoice) => {
      sendRpc({ cmd: "confirm_response", id, response });
      dispatch({ t: "resolve_confirm", id });
    },
    [sendRpc],
  );
  const onApproveConfirm = useCallback(
    (id: number) => resolveConfirm(id, { type: "run_once" }),
    [resolveConfirm],
  );
  const onRejectConfirm = useCallback(
    (id: number) => resolveConfirm(id, { type: "deny" }),
    [resolveConfirm],
  );
  const onRuleConfirm = useCallback(
    (id: number, scope: "workspace" | "global", prefix: string) =>
      resolveConfirm(id, { type: "always_allow", prefix, scope }),
    [resolveConfirm],
  );
  /** Stable identity — passed to memoized AssistantMsg; an inline arrow would
   *  defeat the memo and re-render the whole transcript on every frame. The
   *  card's own callId rides along so parallel tools each stop independently. */
  const onStopTool = useCallback(
    (callId: string) => sendRpc({ cmd: "cancel_tool", callId }),
    [sendRpc],
  );
  /** Stop a background job from its transcript shell card — distinct from
   *  `cancel_tool` because the tool call has already returned; the process is
   *  still alive and must be killed via `jobs_stop`. Stable for memoization. */
  const onStopJob = useCallback(
    (jobId: number, tabId: string) => sendRpc({ cmd: "jobs_stop", jobId, tabId }),
    [sendRpc],
  );
  const resolvePathAccess = useCallback(
    (id: number, response: ConfirmationChoice) => {
      sendRpc({ cmd: "confirm_response", id, response });
      dispatch({ t: "resolve_path_access", id });
    },
    [sendRpc],
  );
  const resolveChoice = useCallback(
    (id: number, response: ChoiceVerdict) => {
      sendRpc({ cmd: "choice_response", id, response });
      dispatch({ t: "resolve_choice", id, verdict: response });
    },
    [sendRpc],
  );
  const resolvePlan = useCallback(
    (id: number, response: PlanVerdict) => {
      sendRpc({ cmd: "plan_response", id, response });
      dispatch({ t: "resolve_plan", id, verdict: response });
    },
    [sendRpc],
  );
  const resolveCheckpoint = useCallback(
    (id: number, response: CheckpointVerdict) => {
      sendRpc({ cmd: "checkpoint_response", id, response });
      dispatch({ t: "resolve_checkpoint", id, verdict: response });
    },
    [sendRpc],
  );
  const resolveRevision = useCallback(
    (id: number, response: RevisionVerdict) => {
      sendRpc({ cmd: "revision_response", id, response });
      dispatch({ t: "resolve_revision", id, verdict: response });
    },
    [sendRpc],
  );
  /** Pause/resume a gate's backend auto-resolve countdown so it matches the
   *  card's timer toggle — no front/back desync. */
  const setGateTimer = useCallback(
    (id: number, enabled: boolean) => sendRpc({ cmd: "gate_timer", id, enabled }),
    [sendRpc],
  );

  // Read the latest session inside the stable restore callback below.
  const currentSessionRef = useRef(state.currentSession);
  currentSessionRef.current = state.currentSession;
  const restoreScrollTop = useCallback(() => {
    const session = currentSessionRef.current;
    if (!session) return null;
    const raw = localStorage.getItem(`reasonix.scroll.${session}`);
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }, []);

  const { scrollToBottom, scrollToTop, unpinForJump } = useAutoScroll(
    threadRef,
    threadInnerRef,
    state.busy,
    restoreScrollTop,
    active,
  );
  const threadScrollable = useIsScrollable(threadRef, threadInnerRef);

  /** The Events tab's click target. Release the sticky-bottom follow FIRST, or
   *  a streamed answer snaps the viewport back to the bottom mid-jump. Lands on
   *  the event's own card (plan, choice, fold) when the record carries one, its
   *  turn's prompt only when it does not. Returns whether it actually landed. */
  const jumpToEvent = useCallback(
    (target: JumpTarget): boolean => {
      // A fresh jump supersedes the previous one, which may still be re-aligning
      // its own target against a settling transcript.
      endJumpAlignment();
      unpinForJump();
      return jumpToAnchor(threadRef.current, target);
    },
    [unpinForJump],
  );

  // Persist the transcript scroll offset per session so a restart reopens
  // the conversation where the user left it (#1244).
  useEffect(() => {
    const el = threadRef.current;
    const session = state.currentSession;
    if (!el || !session) return;
    const key = `reasonix.scroll.${session}`;
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
        if (atBottom) localStorage.removeItem(key);
        else localStorage.setItem(key, String(Math.round(el.scrollTop)));
      }, 250);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
    };
  }, [state.currentSession]);

  // A background job can exit on its own (a download finishing) with no push
  // notification, so the transcript's background-job shell cards would stay
  // stuck on "running". Poll while any job is alive — not only while the ⌘J
  // popover is open — so a natural exit reaches the UI and the card settles.
  const hasRunningJobs = useMemo(() => state.jobs.some((j) => j.running), [state.jobs]);
  useEffect(() => {
    if (!active) return;
    if (!jobsOpen && !hasRunningJobs) return;
    sendRpc({ cmd: "jobs_list" });
    const id = window.setInterval(() => sendRpc({ cmd: "jobs_list" }), 1500);
    return () => window.clearInterval(id);
  }, [active, jobsOpen, hasRunningJobs, sendRpc]);

  useEffect(() => {
    if (!active) return;
    if (state.busy) return;
    sendRpc({ cmd: "jobs_list" });
  }, [active, state.busy, sendRpc]);

  useEffect(() => {
    // Every TabRuntime stays mounted (display:none on inactive), so each registers its own keydown — without this gate Cmd+N would fire newChat() in every tab and wipe the inactive ones' sessions.
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "a" || e.key === "A")) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
        return;
      }
      if (mod && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        composerRef.current?.focus();
      } else if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        newChat();
      } else if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        // The picker is a workspace-switch operator; refuse while a session
        // mutation is waiting for its settle.
        if (sessionsMutation !== null) return;
        setWdAnchor(undefined);
        setWdOpen((v) => !v);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        if (settingsOpen) setSettingsOpen(false);
        else openSettingsAt("general");
      } else if (mod && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setJobsOpen((v) => !v);
      } else if (e.key === "Escape" && (state.busy || state.awaitingAck)) {
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        // A modal is open — let its own Esc handler close it (#1670).
        if (settingsOpen || aboutOpen || jobsOpen || wdOpen) return;
        e.preventDefault();
        abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    active,
    state.busy,
    state.awaitingAck,
    abort,
    newChat,
    settingsOpen,
    aboutOpen,
    jobsOpen,
    wdOpen,
    openSettingsAt,
  ]);
  // Stuck-label seconds are rendered by <StuckLabel> with a self-contained 1s
  // poll; keeping them out of App state avoids a whole-transcript re-render
  // every second while a turn runs, which stuttered typing in the composer.
  const workspaceLabel = state.settings?.workspaceDir
    ? state.settings.workspaceDir.split(/[\\/]/).pop() || "workspace"
    : "Reasonix+";
  const session = (() => {
    if (state.currentSession) {
      const s = sessions.find((x) => x.name === state.currentSession);
      if (s?.summary?.trim()) return s.summary.trim();
    }
    const firstUser = state.messages.find((m) => m.kind === "user");
    if (firstUser && firstUser.kind === "user") {
      const cleaned = flattenText(firstUser.text);
      if (cleaned) return clipText(cleaned, 60, "…");
    }
    if (state.currentSession) {
      const m = state.currentSession.match(/^desktop-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (m)
        return t("app.session.format", {
          month: m[2],
          day: m[3],
          hour: m[4],
          minute: m[5],
        });
    }
    return state.messages.length === 0
      ? t("app.session.new", { workspace: workspaceLabel })
      : workspaceLabel;
  })();

  const exportConversation = useCallback(async () => {
    const userLabel = t("app.exportUserLabel");
    const md = formatConversationMarkdown(state.messages, userLabel);
    if (!md) {
      appendNotice(t("app.toast.emptySession"));
      return;
    }
    try {
      const filename = defaultExportFilename(session);
      const path = await saveDialog({
        defaultPath: filename,
        filters: [{ name: "Markdown", extensions: ["md"] }],
        title: t("app.toast.exportDialogTitle"),
      });
      if (!path) return;
      await invoke("write_text_file", { path, content: md });
      appendNotice(t("app.toast.exportedMd"), "success");
    } catch (err) {
      recordFrontendFailure("frontend.export_failed", err);
      appendNotice(t("app.toast.exportFailed", { error: String(err) }), "error");
    }
  }, [state.messages, session, appendNotice]);

  // Enabled/visible models for the Duplicate-session picker, grouped the same
  // way the composer groups them.
  const dupModelGroups = useMemo(() => {
    const enabled = new Set(state.settings?.enabledModels ?? []);
    const visible = (id: string) => enabled.size === 0 || enabled.has(id);
    const catalog = deriveModelCatalog({
      providerCatalogs: state.settings?.providerCatalogs,
      discoveredAntigravityModels: state.settings?.antigravityOAuth?.models,
      opencodeModels,
      includeAntigravity: Boolean(state.settings?.antigravityOAuth?.models),
      ollamaVisionModels,
      opencodeVisionModels,
    });
    const groups: { key: string; label: string; ids: string[] }[] = catalog.groups.map((g) => ({
      key: g.key,
      label: t(MODEL_CATALOG_GROUP_LABELS[g.key]),
      ids: g.models.filter(visible),
    }));
    if (ollamaModels && ollamaModels.length > 0) {
      groups.unshift({
        key: "ollama",
        label: t("composer.modelOllamaGroup"),
        ids: ollamaModels.map((id) => `ollama/${id}`).filter(visible),
      });
    }
    return groups.filter((g) => g.ids.length > 0);
  }, [
    state.settings?.enabledModels,
    state.settings?.providerCatalogs,
    state.settings?.antigravityOAuth?.models,
    opencodeModels,
    ollamaModels,
    ollamaVisionModels,
    opencodeVisionModels,
  ]);

  // Duplicate this conversation into a new trimmed session on the picked models:
  // the daemon trims the export body to the configured token budget and opens
  // the new session (auto-continuing only when that setting is enabled).
  const duplicateSession = useCallback(
    (mainModel: string, subagentModel: string) => {
      // A create already in flight would stack a second session on the workspace.
      if (sessionsMutation !== null) return;
      const md = formatConversationMarkdown(state.messages, t("app.exportUserLabel"), {
        maxToolOutputLines: 3,
      });
      if (!md) {
        appendNotice(t("app.toast.emptySession"));
        return;
      }
      const workspaceDir = state.settings?.workspaceDir;
      if (workspaceDir) onSessionIntent(workspaceDir, "create");
      sendRpc({ cmd: "duplicate_session", markdown: md, model: mainModel, subagentModel });
      appendNotice(t("app.toast.duplicatedSession"), "success");
    },
    [
      appendNotice,
      onSessionIntent,
      sessionsMutation,
      state.messages,
      state.settings?.workspaceDir,
      sendRpc,
    ],
  );

  // Sessions whose agent is ACTIVELY RUNNING (a turn in flight) in any tab on
  // this tab's workspace — the sidebar dots one per running session. A merely
  // open channel must NOT dot: the tab bar reserves the dot for running agents
  // and the sidebar follows the same rule (issue: 3 dots for 1 working agent).
  const runningSessionsFresh = useMemo(
    () => runningSessionNames(tabsList, state.settings?.workspaceDir),
    [tabsList, state.settings?.workspaceDir],
  );
  // A busy flip in a sibling channel rebuilds this set with the same members for
  // every other workspace, and a fresh Set is a fresh sidebar prop — the one
  // thing that kept memo() from skipping an unrelated tab's row list.
  const runningSessionsRef = useRef(runningSessionsFresh);
  const runningSessions = keepStable(
    runningSessionsRef.current,
    runningSessionsFresh,
    sameStringSet,
  );
  runningSessionsRef.current = runningSessions;

  // Which plan each workspace session owns, so a sidebar row can label it. The
  // plan history is workspace-wide, so one map covers every listed session.
  // Undefined until the first $plan_history: an unloaded history must not claim
  // "No plan" for a session that may well own one.
  const sessionPlanLabels = useMemo(
    () => (state.planHistory ? planLabelsBySession(state.planHistory) : undefined),
    [state.planHistory],
  );

  // The ribbon only needs to know whether more than one workspace tab exists,
  // and a full grouping walk for that boolean ran on every render.
  const singleTab = useMemo(() => groupTabsByWorkspace(tabsList).length <= 1, [tabsList]);

  // Report this channel's running-agent state up so the tab dot can count the
  // agents active in the tab (this channel plus its siblings).
  useEffect(() => {
    onBusyChange(tabId, state.busy);
  }, [onBusyChange, tabId, state.busy]);

  // A mutation whose settling snapshot never arrives must not hide a row forever.
  // One bounded request per intent asks the daemon for the truth; the store's
  // content rule (and its escape) is what actually decides visibility.
  const reconciledIntentRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionIntentId === null || reconciledIntentRef.current === sessionIntentId) return;
    const timer = window.setTimeout(() => {
      reconciledIntentRef.current = sessionIntentId;
      requestSessionList(tabId);
    }, INTENT_RECONCILE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [sessionIntentId, tabId]);

  // The right panel reaches the transcript only through its Events tab, which reads
  // turns and stamps, never streamed text. A revision-keyed array keeps memo() able
  // to bail out while a turn streams.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the structural revision by design
  const panelMessages = useMemo(() => view.messages, [view.messagesVersion]);

  // Loading an older page prepends rows ABOVE the viewport, so the scroll offset
  // has to grow by exactly what the content grew or the reader's place jumps.
  const historyAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const loadOlder = useCallback(() => {
    const el = threadRef.current;
    if (el) historyAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    sendRpc({
      cmd: "session_history_page",
      name: view.currentSession ?? "",
      before: view.historyLoaded,
    });
  }, [sendRpc, view.currentSession, view.historyLoaded]);

  useEffect(() => {
    const anchor = historyAnchorRef.current;
    const el = threadRef.current;
    if (!anchor || !el) return;
    historyAnchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [view.messagesVersion]);

  // Rebuilding the transcript on every unrelated state change walked every
  // message; the rows are memoized, so reuse the same elements until something
  // a row actually reads changes.
  const interventionPending = hasPendingIntervention(view);
  const renderRow = (m: ChatMessage, i: number) => {
    if (m.kind === "user") {
      const dividerLabel = `turn ${m.turn}`;
      const prev = view.messages[i - 1];
      const needsDivider = !prev || prev.kind === "user";
      return (
        <div key={`u-${m.turn}`} data-turn={m.turn} className="thread-row">
          {needsDivider ? <TurnDivider label={dividerLabel} /> : null}
          <UserMsg text={m.text} images={m.images} skill={m.skill} />
        </div>
      );
    }
    if (m.kind === "assistant") {
      return (
        <div key={`a-${m.turn}-${i}`} className="thread-row">
          <AssistantRow
            m={m}
            model={view.model}
            pendingConfirms={view.pendingConfirms}
            activePlan={activePlanForMessage(m, view.activePlan)}
            onApproveConfirm={onApproveConfirm}
            onRejectConfirm={onRejectConfirm}
            onRuleConfirm={onRuleConfirm}
            onStopTool={onStopTool}
            jobs={view.jobs}
            tabId={tabId}
            onStopJob={onStopJob}
            isInterventionPending={interventionPending}
          />
        </div>
      );
    }
    if (m.kind === "notice") {
      return (
        <NoticeCard
          key={m.id}
          text={m.text}
          severity={m.severity}
          running={m.running}
          anchor={m.trigger ? noticeAnchor(m.id) : undefined}
        />
      );
    }
    return null;
  };

  // The streaming card is the only row a delta can change, so it lives outside the
  // memoized history: one frame reconciles a stable element list plus one fresh row
  // instead of every row in the transcript.
  const tailIndex = streamingTailIndex(view.messages);
  const historyEnd = tailIndex < 0 ? view.messages.length : tailIndex;
  // biome-ignore lint/correctness/useExhaustiveDependencies: renderRow closes over the props listed here, and the history is keyed on the structural revision by design
  const historyRows = useMemo(() => {
    const rows: ReactNode[] = [];
    for (let i = 0; i < historyEnd; i += 1) rows.push(renderRow(view.messages[i]!, i));
    return rows;
  }, [
    view.messagesVersion,
    historyEnd,
    view.model,
    view.pendingConfirms,
    view.activePlan,
    view.jobs,
    tabId,
    interventionPending,
    onApproveConfirm,
    onRejectConfirm,
    onRuleConfirm,
    onStopTool,
    onStopJob,
  ]);
  const tailRow = tailIndex >= 0 ? renderRow(view.messages[tailIndex]!, tailIndex) : null;

  // Props handed to memoized children must keep their identity across renders,
  // otherwise memo() can never bail out of their subtree.
  const closeTab = useCallback((id: string) => {
    rpcSend({ cmd: "tab_close", tabId: id }).catch((err) =>
      recordFrontendFailure("frontend.tab_close_failed", err),
    );
  }, []);

  const clearTabs = useCallback(
    (scope: ClearTabsScope) => {
      const workspaceTabs = workspaceTabRepresentatives(tabsList, activeTabId);
      const activeWorkspace = workspaceTabs.find((representative) => {
        const workspace = normalizeWorkspacePath(representative.workspaceDir);
        return tabsList.some(
          (tab) => tab.id === activeTabId && normalizeWorkspacePath(tab.workspaceDir) === workspace,
        );
      });
      const targets = getTabsToClear(workspaceTabs, activeWorkspace?.id ?? activeTabId, scope);
      for (const target of targets) closeTab(target.id);
    },
    [tabsList, activeTabId, closeTab],
  );

  const loadSession = useCallback(
    (name: string) => {
      clearAbortDraft();
      // Open the session as its own channel (a new tab in this group), or focus
      // it if already open — never replace/abort the current one.
      sendRpc({ cmd: "session_open", name });
    },
    [clearAbortDraft, sendRpc],
  );

  const deleteSession = useCallback(
    (name: string) => {
      // A running session owns a turn the daemon refuses to delete, so the click
      // stops here instead of starting a hide it would have to undo.
      if (sessionsMutation !== null) return;
      if (runningSessions.has(name)) {
        appendNotice(t("app.deleteRunningRefused"), "warning");
        return;
      }
      onSessionIntent(state.settings?.workspaceDir, "delete", name);
      sendRpc({ cmd: "session_delete", name });
    },
    [
      appendNotice,
      onSessionIntent,
      runningSessions,
      sessionsMutation,
      state.settings?.workspaceDir,
      sendRpc,
    ],
  );

  const clearSessions = useCallback(() => {
    if (sessionsMutation !== null) return;
    // Echo the exact names being hidden so the daemon can settle every one even
    // if its own workspace listing misses some — otherwise the rows stay hidden
    // forever and the app looks wedged.
    const names = sessions.map((session) => session.name);
    const kept = names.filter((name) => runningSessions.has(name));
    const doomed = names.filter((name) => !runningSessions.has(name));
    // Nothing deletable: say so rather than start a clear that can never settle.
    if (doomed.length === 0) {
      appendNotice(t("app.deleteRunningRefused"), "warning");
      return;
    }
    // `kept` stays visible through the whole clear: those rows are not deleted.
    onSessionIntent(state.settings?.workspaceDir, "clear", undefined, kept);
    sendRpc({ cmd: "session_clear", names: doomed });
  }, [
    appendNotice,
    onSessionIntent,
    runningSessions,
    sessions,
    sessionsMutation,
    state.settings?.workspaceDir,
    sendRpc,
  ]);

  const reorderSession = useCallback(
    (name: string) => {
      const now = Date.now();
      onSessionPatch(state.settings?.workspaceDir, name, { createdAt: now });
      sendRpc({ cmd: "session_reorder", name, createdAt: now });
    },
    [onSessionPatch, state.settings?.workspaceDir, sendRpc],
  );

  const openWorkdir = useCallback(
    (anchor: { top?: number; bottom?: number; left: number }) => {
      // One workspace operator at a time: switching mid-mutation re-targets the
      // channel waiting for the settled snapshot, so the picker stays shut.
      if (sessionsMutation !== null) return;
      setWdAnchor(anchor);
      setWdOpen(true);
    },
    [sessionsMutation],
  );

  const openSettings = useCallback(() => openSettingsAt("general"), [openSettingsAt]);
  const openAbout = useCallback(() => setAboutOpen(true), []);
  const toggleJobs = useCallback(() => setJobsOpen((v) => !v), []);

  const readMemory = useCallback(
    (path: string) => sendRpc({ cmd: "memory_read", path }),
    [sendRpc],
  );
  const writeMemory = useCallback(
    (
      scope: "global" | "project",
      name: string,
      description: string,
      body: string,
      opts?: MemoryWriteOptions,
    ) => sendRpc({ cmd: "memory_write", scope, name, description, body, ...opts }),
    [sendRpc],
  );
  const deleteMemory = useCallback(
    (path: string) => sendRpc({ cmd: "memory_delete", path }),
    [sendRpc],
  );
  const dismissMemoryResult = useCallback(() => dispatch({ t: "dismiss_memory_result" }), []);
  const compactContext = useCallback(() => sendRpc({ cmd: "context_compact" }), [sendRpc]);
  const readPlans = useCallback(() => {
    void rpcSend({ cmd: "plan_history_get", tabId });
  }, [tabId]);
  const readPlan = useCallback(
    (planId: string) => {
      void rpcSend({ cmd: "plan_detail_get", planId, tabId });
    },
    [tabId],
  );
  const removePlan = useCallback(
    (planId: string) => {
      void rpcSend({ cmd: "plan_remove", planId, tabId });
    },
    [tabId],
  );

  // The empty-list prompt may only replace an EMPTY transcript. Gating on the list
  // alone unmounted a live conversation whenever a snapshot momentarily listed
  // nothing, which read to the user as "my session vanished".
  const showNoSessions = sessionsConfirmed && sessions.length === 0 && state.messages.length === 0;

  return (
    <WorkspaceProvider value={{ dir: state.settings?.workspaceDir }}>
      <div
        className="app"
        data-theme={theme}
        data-theme-style={themeStyle}
        data-side-collapsed={sideCollapsed}
        data-ctx-collapsed={ctxCollapsed}
        style={{
          display: active ? undefined : "none",
          ["--side-width" as string]: sideCollapsed ? "0px" : `${sideWidth}px`,
          ["--ctx-width" as string]: ctxCollapsed ? "0px" : `${ctxWidth}px`,
          ["--thread-max-width" as string]: `${threadMaxWidth}px`,
        }}
      >
        <MemoTitleBar
          session={session}
          model={view.settings?.model}
          sideOn={!sideCollapsed}
          ctxOn={!ctxCollapsed}
          onToggleSide={onToggleSide}
          onToggleCtx={onToggleCtx}
        />

        <MemoTabBar
          tabs={tabsList}
          activeId={activeTabId}
          setActive={setActiveTabId}
          onClose={closeTab}
          onNew={onNewTab}
          onClearTabs={clearTabs}
          singleTab={singleTab}
        />

        <MemoSidebar
          sessions={sessions}
          activeName={view.currentSession}
          workspaceDir={view.settings?.workspaceDir}
          onNewChat={newChat}
          runningSessions={runningSessions}
          sessionRates={sessionRates}
          planLabels={sessionPlanLabels}
          sessionMutation={sessionsMutation}
          onLoadSession={loadSession}
          onDeleteSession={deleteSession}
          onClearSessions={clearSessions}
          onReorderSession={reorderSession}
          onOpenWorkdir={openWorkdir}
          onOpenSettings={openSettings}
          onOpenAbout={openAbout}
        />

        {!sideCollapsed ? (
          <div
            className="resize-handle"
            data-side="left"
            data-dragging={undefined}
            onMouseDown={onSideResizeDown}
          />
        ) : null}

        <main className="main" style={{ position: "relative" }}>
          {/* Workspace-scoped, but surfaced once: only the channel the user is
              looking at paints the pill, so a hidden tab adds no second copy. */}
          {active && sessionsMutation !== null ? (
            <div className="main-progress" role="status" aria-live="polite">
              <span className="spin" aria-hidden="true" />
              <span>{sessionMutationLabel(sessionsMutation, pendingDeleteCount)}</span>
            </div>
          ) : null}
          {state.settings != null && !state.settings.workspaceDir ? (
            <PendingWorkspaceView
              local={state.settings.reasonixLocalDir}
              recent={mergedWorkspaces}
              onPick={(path) => {
                clearAbortDraft();
                saveSettings({ workspaceDir: path });
              }}
              onBrowse={pickWorkspace}
            />
          ) : state.needsSetup ? (
            <NeedsSetupView
              workspaceDir={state.settings?.workspaceDir}
              onPickWorkspace={pickWorkspace}
              onOpenSettings={() => openSettingsAt("models")}
            />
          ) : showNoSessions ? (
            <NoSessionsView onNewChat={newChat} />
          ) : (
            <>
              <MainHead
                session={session}
                model={state.settings?.model}
                subagentModel={state.settings?.subagentModel}
                modelGroups={dupModelGroups}
                workspaceDir={state.settings?.workspaceDir}
                busy={state.busy}
                hasMessages={state.messages.length > 0}
                onExport={exportConversation}
                onDuplicate={duplicateSession}
                onOpenWorkdir={(anchor) => {
                  setWdAnchor(anchor);
                  setWdOpen(true);
                }}
                onRename={(title) => {
                  if (state.currentSession) {
                    onSessionPatch(state.settings?.workspaceDir, state.currentSession, {
                      summary: flattenText(title).slice(0, 200) || undefined,
                    });
                    sendRpc({ cmd: "session_rename", name: state.currentSession, title });
                  }
                }}
              />
              <div className="thread-wrap">
                {threadScrollable ? (
                  <div className="thread-rail">
                    <button
                      type="button"
                      className="thread-scroll-btn"
                      onClick={() => scrollToTop(true)}
                      title={t("app.jumpToTop") ?? "Jump to top"}
                      aria-label={t("app.jumpToTop") ?? "Jump to top"}
                    >
                      <I.chevU size={14} />
                    </button>
                  </div>
                ) : null}
                <div className="thread" ref={threadRef}>
                  <div className="thread-inner" ref={threadInnerRef}>
                    {active || keepAlive ? (
                      <>
                        {view.historyHasOlder && view.messages.length > 0 ? (
                          <div className="thread-history">
                            <button
                              type="button"
                              className="btn ghost"
                              onClick={loadOlder}
                              disabled={state.busy}
                            >
                              {t("thread.loadOlder")}
                            </button>
                          </div>
                        ) : null}
                        {view.messages.length === 0 ? (
                          <EmptyState
                            onPick={(text) => send(text)}
                            workspaceDir={state.settings?.workspaceDir}
                          />
                        ) : null}

                        {historyRows}
                        {tailRow}

                        {/* Pending approvals */}
                        {state.pendingPlans.map((p) => (
                          <PlanApprovalCard
                            key={`pp-${p.id}`}
                            id={p.id}
                            plan={p.plan}
                            summary={p.summary}
                            steps={p.steps}
                            countdownMs={p.countdownMs}
                            onApprove={() => resolvePlan(p.id, { type: "approve" })}
                            onRefine={() => resolvePlan(p.id, { type: "refine" })}
                            onCancel={() => resolvePlan(p.id, { type: "cancel" })}
                            onTimerToggle={(enabled) => setGateTimer(p.id, enabled)}
                          />
                        ))}
                        {state.pendingCheckpoints.map((c) => (
                          <CheckpointApprovalCard
                            key={`cp-${c.id}`}
                            c={c}
                            onContinue={() => resolveCheckpoint(c.id, { type: "continue" })}
                            onRevise={() => resolveCheckpoint(c.id, { type: "revise" })}
                            onStop={() => resolveCheckpoint(c.id, { type: "stop" })}
                          />
                        ))}
                        {state.pendingRevisions.map((r) => (
                          <RevisionApprovalCard
                            key={`rv-${r.id}`}
                            r={r}
                            onAccept={() => resolveRevision(r.id, { type: "accepted" })}
                            onReject={() => resolveRevision(r.id, { type: "rejected" })}
                            onTimerToggle={(enabled) => setGateTimer(r.id, enabled)}
                          />
                        ))}
                        {state.pendingConfirms.map((c) => (
                          <ConfirmApprovalCard
                            key={`cc-${c.id}`}
                            prompt={c.prompt}
                            onAllow={() => resolveConfirm(c.id, { type: "run_once" })}
                            onAddWorkspaceRule={() =>
                              resolveConfirm(c.id, {
                                type: "always_allow",
                                prefix: String(c.prompt.data?.prefix ?? ""),
                                scope: "workspace",
                              })
                            }
                            onAddGlobalRule={() =>
                              resolveConfirm(c.id, {
                                type: "always_allow",
                                prefix: String(c.prompt.data?.prefix ?? ""),
                                scope: "global",
                              })
                            }
                            onDeny={() => resolveConfirm(c.id, { type: "deny" })}
                          />
                        ))}
                        {state.pendingPathAccess.map((p) => (
                          <PathAccessApprovalCard
                            key={`pa-${p.id}`}
                            prompt={p.prompt}
                            onAllow={() => resolvePathAccess(p.id, { type: "run_once" })}
                            onAddWorkspaceRule={() =>
                              resolvePathAccess(p.id, {
                                type: "always_allow",
                                prefix: p.allowPrefix,
                                scope: "workspace",
                              })
                            }
                            onAddGlobalRule={() =>
                              resolvePathAccess(p.id, {
                                type: "always_allow",
                                prefix: p.allowPrefix,
                                scope: "global",
                              })
                            }
                            onDeny={() => resolvePathAccess(p.id, { type: "deny" })}
                          />
                        ))}
                        {state.pendingChoices.map((c) => (
                          <ChoiceApprovalCard
                            key={`ch-${c.id}`}
                            question={c.question}
                            options={c.options}
                            countdownMs={c.countdownMs}
                            onPick={(optionId) => resolveChoice(c.id, { type: "pick", optionId })}
                            onCancel={() => resolveChoice(c.id, { type: "cancel" })}
                            onTimerToggle={(enabled) => setGateTimer(c.id, enabled)}
                          />
                        ))}

                        {!backendConnected ? (
                          <div
                            style={{
                              padding: 12,
                              color: "var(--muted)",
                              fontFamily: "Geist Mono, monospace",
                              fontSize: 11,
                            }}
                          >
                            {t("app.connecting")}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
                {threadScrollable ? (
                  <div className="thread-rail">
                    <button
                      type="button"
                      className="thread-scroll-btn"
                      onClick={() => scrollToBottom(true)}
                      title={t("app.jumpToBottom") ?? "Jump to bottom"}
                      aria-label={t("app.jumpToBottom") ?? "Jump to bottom"}
                    >
                      <I.chev size={14} />
                    </button>
                  </div>
                ) : null}
              </div>

              <Composer
                draftStore={draftStore}
                onSend={(text) => send(text)}
                quickSends={allQuickSends(state.settings?.quickSends ?? [])}
                activeQuickSendId={activeQuickSend.id}
                onPickQuickSend={(id) => saveSettings({ quickSendId: id })}
                onAbort={abort}
                disabled={!state.ready}
                busy={engaged}
                busyLabel={
                  state.busy || state.awaitingAck
                    ? busyStatusLabel(state)
                    : state.compacting
                      ? t("app.status.compacting")
                      : undefined
                }
                stuckLabel={
                  state.busy && state.turnLastEventMs && !state.activeSkill
                    ? {
                        sinceMs: state.turnLastEventMs,
                        render: (sec: number) => stuckStatusLabel(state, sec),
                      }
                    : undefined
                }
                textareaRef={composerRef}
                modelLabel={state.settings?.model ?? DEFAULT_MODEL}
                subagentModelLabel={
                  state.settings?.subagentModel ?? state.settings?.model ?? DEFAULT_MODEL
                }
                subagentsEnabled={state.settings?.subagents ?? false}
                reasoningEffort={state.settings?.reasoningEffort ?? "high"}
                supportedEfforts={state.settings?.modelEndpoint?.reasoningEfforts}
                ollamaModels={ollamaModels}
                ollamaModelsError={ollamaModelsError ?? undefined}
                ollamaHiddenCount={ollamaHiddenCount}
                ollamaVisionModels={ollamaVisionModels}
                antigravityModels={state.settings?.antigravityOAuth?.models}
                antigravityModelsError={state.settings?.antigravityOAuth?.flowError}
                opencodeModels={opencodeModels}
                opencodeModelsError={opencodeModelsError ?? undefined}
                opencodeVisionModels={opencodeVisionModels}
                enabledModels={state.settings?.enabledModels}
                providerCatalogs={state.settings?.providerCatalogs}
                onRefreshOllamaModels={onRefreshOllamaModels}
                onRefreshAntigravityModels={onRefreshAntigravityModels}
                onRefreshOpencodeModels={onRefreshOpencodeModels}
                onModelChange={(model) => {
                  saveSettings({ model });
                  appendNotice(t("app.toast.modelSwitched", { model }));
                }}
                onSubagentModelChange={(model) => {
                  saveSettings({ subagentModel: model });
                  appendNotice(t("app.toast.subagentModelSwitched", { model }));
                }}
                onEffortChange={applyReasoningEffort}
                editMode={state.settings?.editMode ?? "follow"}
                onEditModeChange={applyEditMode}
                workspaceDir={state.settings?.workspaceDir}
                queuedSends={state.queuedSends}
                onQueueWhileBusy={(sendOrText, images) => {
                  const send: QueuedSend =
                    typeof sendOrText === "string"
                      ? { text: sendOrText, images }
                      : { ...sendOrText, ...(images ? { images } : {}) };
                  dispatch({ t: "enqueue_send", send });
                  setDraft("");
                  setPendingImages([]);
                }}
                onDequeueSend={(index) => dispatch({ t: "dequeue_send", index })}
                onEditQueuedSend={(index) => {
                  const item = state.queuedSends[index];
                  if (!item) return;
                  dispatch({ t: "dequeue_send", index });
                  // Bringing a message back to edit must not destroy an
                  // in-progress draft: re-queue whatever the composer already
                  // holds (text and/or attached images) before restoring.
                  const draft = draftStore.getSnapshot();
                  if (draft.trim() || pendingImages.length > 0) {
                    dispatch({
                      t: "enqueue_send",
                      send: {
                        text: draft,
                        ...(pendingImages.length > 0 ? { images: pendingImages } : {}),
                      },
                    });
                  }
                  setDraft(item.text);
                  setPendingImages(
                    (item.images ?? []).filter(
                      (im): im is { id: string; thumbnail: string; wire: UserImageAttachment } =>
                        Boolean(im.wire),
                    ),
                  );
                  composerRef.current?.focus();
                }}
                onSendNow={() => sendRpc({ cmd: "abort" })}
                pendingImages={pendingImages}
                onRemoveImage={removePendingImage}
                imageCapable={imageCapable}
                onPasteImage={attachPastedImage}
                onImageRejected={() => appendNotice(t("composer.imageRequiresVision"), "warning")}
                onPickImage={attachPickedImage}
                mediaCapable={mediaCapable}
                onPickMedia={attachPickedMedia}
                onUpdateMedia={updatePendingMedia}
                onVoiceError={(message) => appendNotice(message, "error")}
                voiceAvailable={voiceAvailable}
              />
            </>
          )}
        </main>

        {!ctxCollapsed ? (
          <div
            className="resize-handle"
            data-side="right"
            data-dragging={undefined}
            onMouseDown={onCtxResizeDown}
          />
        ) : null}
        <MemoContextPanel
          settings={view.settings}
          usage={view.usage}
          mcpSpecs={view.mcpSpecs}
          mcpBridged={view.mcpBridged}
          sessionFiles={view.sessionFiles}
          memory={view.memory}
          memoryDetail={view.memoryDetail}
          memoryResult={view.memoryResult}
          onReadMemory={readMemory}
          onWriteMemory={writeMemory}
          onDeleteMemory={deleteMemory}
          onDismissMemoryResult={dismissMemoryResult}
          onCompact={compactContext}
          onAddRule={addRule}
          onRemoveRule={removeRule}
          onUpdateRule={updateRule}
          onCopyWorkspaceRules={copyWorkspaceRules}
          onSaveSettings={saveSettings}
          activePlan={view.activePlan}
          planHistory={view.planHistory}
          planDetails={view.planDetails}
          planSession={view.currentSession}
          sessions={sessions}
          onReadPlans={readPlans}
          onReadPlan={readPlan}
          onRemovePlan={removePlan}
          messages={panelMessages}
          sessionEvents={view.sessionEvents}
          onJumpToEvent={jumpToEvent}
          active={active}
        />

        <MemoStatusBar
          settings={view.settings}
          balance={view.balance}
          codexQuota={view.codexQuota}
          codexQuotaRefreshing={view.codexQuotaRefreshing}
          codexQuotaReason={view.codexQuotaReason}
          onRefreshCodexQuota={refreshCodexQuota}
          ollamaQuota={view.ollamaQuota}
          ollamaQuotaRefreshing={view.ollamaQuotaRefreshing}
          ollamaQuotaReason={view.ollamaQuotaReason}
          onRefreshOllamaQuota={refreshOllamaQuota}
          ollamaPlan={ollamaPlan}
          antigravityQuota={view.antigravityQuota}
          antigravityQuotaRefreshing={view.antigravityQuotaRefreshing}
          antigravityQuotaReason={view.antigravityQuotaReason}
          onRefreshAntigravityQuota={refreshAntigravityQuota}
          zaiQuota={view.zaiQuota}
          zaiQuotaRefreshing={view.zaiQuotaRefreshing}
          zaiQuotaReason={view.zaiQuotaReason}
          onRefreshZaiQuota={refreshZaiQuota}
          opencodeQuota={view.opencodeQuota}
          opencodeQuotaRefreshing={view.opencodeQuotaRefreshing}
          opencodeQuotaReason={view.opencodeQuotaReason}
          onRefreshOpencodeQuota={refreshOpencodeQuota}
          usage={view.usage}
          busy={view.busy}
          ready={view.ready}
          currency={currency}
          theme={theme}
          themeStyle={themeStyle}
          jobs={view.jobs}
          jobsOpen={jobsOpen}
          onToggleJobs={toggleJobs}
          onSetThemeStyle={onSetThemeStyle}
          onToggleCurrency={onToggleCurrency}
          onOpenSettings={openSettings}
          onOpenWorkdir={openWorkdir}
        />

        <WorkdirPop
          open={wdOpen}
          onClose={() => setWdOpen(false)}
          recent={mergedWorkspaces}
          local={state.settings?.reasonixLocalDir}
          current={state.settings?.workspaceDir}
          anchor={wdAnchor}
          locked={sessionsMutation !== null}
          onPick={(path) => {
            clearAbortDraft();
            // Always apply the pick to THIS tab. A workspace is not unique
            // app-wide: several tabs may target the same directory so each can
            // drive the same project with its own agent. Redirecting focus to
            // another tab that happens to share the workspace made a second tab
            // on the same directory impossible — never switch tabs here.
            saveSettings({ workspaceDir: path });
          }}
          onRemove={onRemoveWorkspace}
          onBrowse={pickWorkspace}
        />

        {aboutOpen ? <AboutModal onClose={() => setAboutOpen(false)} /> : null}

        {state.mcpSetup ? (
          <McpSetupDialog
            key={state.mcpSetupRevision}
            servers={state.mcpSetup.servers}
            subagents={state.mcpSetup.subagents}
            onConfirm={(enabled, subagents) =>
              sendRpc({ cmd: "mcp_session_configure", enabled, subagents })
            }
            // Cancel discards the freshly minted session; its workspace tab stays.
            onCancel={() => sendRpc({ cmd: "mcp_session_cancel" })}
          />
        ) : null}

        {settingsOpen && state.settings ? (
          <SettingsModal
            settings={state.settings}
            fontScale={fontScale}
            onSetFontScale={onSetFontScale}
            fontFamily={fontFamily}
            onSetFontFamily={onSetFontFamily}
            customFontFamily={customFontFamily}
            onSetCustomFontFamily={onSetCustomFontFamily}
            initialPage={settingsPage}
            mcpSpecs={state.mcpSpecs}
            mcpBridged={state.mcpBridged}
            onClose={() => setSettingsOpen(false)}
            onSave={saveSettings}
            onSaveApiKey={saveApiKey}
            ollamaBaseUrl={state.settings?.ollamaBaseUrl}
            ollamaModels={ollamaModels}
            ollamaModelsError={ollamaModelsError ?? undefined}
            ollamaPlan={ollamaPlan ?? undefined}
            ollamaHiddenCount={ollamaHiddenCount}
            ollamaVisionModels={ollamaVisionModels}
            onRefreshOllamaModels={onRefreshOllamaModels}
            opencodeModels={opencodeModels}
            opencodeModelsError={opencodeModelsError ?? undefined}
            opencodeVisionModels={opencodeVisionModels}
            onRefreshOpencodeModels={onRefreshOpencodeModels}
            changelog={changelog}
            onRefreshChangelog={onRefreshChangelog}
            oauthWaiting={state.oauthWaiting}
            onOAuthBegin={() => sendRpc({ cmd: "oauth_begin" })}
            onOAuthCancel={() => {
              dispatch({ t: "oauth_waiting", waiting: false });
              sendRpc({ cmd: "oauth_cancel" });
            }}
            onOAuthSignOut={() => sendRpc({ cmd: "oauth_signout" })}
            onSaveOpenAIApiKey={(key) => sendRpc({ cmd: "setup_save_openai_key", key })}
            antigravityOAuthWaiting={state.antigravityOAuthWaiting}
            onAntigravityOAuthBegin={() => sendRpc({ cmd: "gemini_oauth_begin" })}
            onAntigravityOAuthCancel={() => {
              dispatch({ t: "antigravity_oauth_waiting", waiting: false });
              sendRpc({ cmd: "gemini_oauth_cancel" });
            }}
            onAntigravityOAuthSignOut={() => sendRpc({ cmd: "gemini_oauth_signout" })}
            opencodeOAuthWaiting={state.opencodeOAuthWaiting}
            onOpencodeOAuthBegin={() => sendRpc({ cmd: "opencode_oauth_begin" })}
            onOpencodeOAuthCancel={() => {
              dispatch({ t: "opencode_oauth_waiting", waiting: false });
              sendRpc({ cmd: "opencode_oauth_cancel" });
            }}
            onOpencodeOAuthSignOut={() => sendRpc({ cmd: "opencode_oauth_signout" })}
            mimoOAuthWaiting={state.mimoOAuthWaiting}
            onMiMoOAuthBegin={() => sendRpc({ cmd: "mimo_oauth_begin" })}
            onMiMoOAuthCancel={() => {
              dispatch({ t: "mimo_oauth_waiting", waiting: false });
              sendRpc({ cmd: "mimo_oauth_cancel" });
            }}
            onMiMoOAuthSignOut={() => sendRpc({ cmd: "mimo_oauth_signout" })}
            onAddMcpSpec={addMcpSpec}
            onRemoveMcpSpec={removeMcpSpec}
            onToggleMcpServer={toggleMcpServer}
            mcpExtensionStatus={state.mcpExtensionStatus}
            mcpExtensionCheck={state.mcpExtensionCheck}
            playwrightBrowserInstall={state.playwrightBrowserInstall}
            onRequestMcpExtensionStatus={requestMcpExtensionStatus}
            onConfigureMcpExtension={configureMcpExtension}
            onCheckMcpExtension={checkMcpExtension}
            onInstallPlaywrightBrowser={installPlaywrightBrowser}
            onCancelPlaywrightBrowserInstall={cancelPlaywrightBrowserInstall}
            mailProvider={state.settings?.mailProvider ?? MailProvider.Outlook}
            mailAuth={state.mailAuth}
            onSetMailProvider={setMailProvider}
            onRequestMailStatus={requestMailStatus}
            onConfigureMail={configureMail}
            onConnectMail={connectMail}
            onCancelMail={cancelMail}
            onSignOutMail={signOutMail}
          />
        ) : null}

        <JobsPop
          open={jobsOpen}
          onClose={() => setJobsOpen(false)}
          jobs={state.jobs}
          onStop={onStopJob}
          onStopAll={() => sendRpc({ cmd: "jobs_stop_all" })}
        />

        {splashOn ? <Splash onDone={() => setSplashOn(false)} /> : null}
      </div>
    </WorkspaceProvider>
  );
});

function WinMinimize() {
  return (
    <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true" focusable="false">
      <rect width="10" height="1" fill="currentColor" />
    </svg>
  );
}

function WinMaximize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}
function WinRestore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <rect
        x="2.5"
        y="0.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect
        x="0.5"
        y="2.5"
        width="7"
        height="7"
        fill="var(--bg-2, #eee)"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  );
}
function WinClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <line
        x1="0.5"
        y1="0.5"
        x2="9.5"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="9.5"
        y1="0.5"
        x2="0.5"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TitleBar({
  session,
  model,
  sideOn,
  ctxOn,
  onToggleSide,
  onToggleCtx,
}: {
  session: string;
  model?: string;
  sideOn: boolean;
  ctxOn: boolean;
  onToggleSide: () => void;
  onToggleCtx: () => void;
}) {
  useLang();
  const [isMaximized, setIsMaximized] = useState(false);
  const isMac = document.documentElement.dataset.platform === "macos";

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized);
    let unlisten: (() => void) | undefined;
    win
      .listen("tauri://resize", async () => {
        setIsMaximized(await win.isMaximized());
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  const win = getCurrentWindow();

  return (
    <header className="titlebar">
      {/* left: sidebar toggle + brand */}
      <div className="tb-left">
        {isMac ? (
          <div className="mac-controls" aria-label={t("app.titlebar.windowControls")}>
            <button
              type="button"
              className="mac-ctrl close"
              title={t("app.titlebar.close")}
              aria-label={t("app.titlebar.close")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.close();
              }}
            >
              <WinClose />
            </button>
            <button
              type="button"
              className="mac-ctrl minimize"
              title={t("app.titlebar.minimize")}
              aria-label={t("app.titlebar.minimize")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.minimize();
              }}
            >
              <WinMinimize />
            </button>
            <button
              type="button"
              className="mac-ctrl zoom"
              title={isMaximized ? t("app.titlebar.restore") : t("app.titlebar.maximize")}
              aria-label={isMaximized ? t("app.titlebar.restore") : t("app.titlebar.maximize")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.toggleMaximize();
              }}
            >
              {isMaximized ? <WinRestore /> : <WinMaximize />}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="iconbtn"
          data-on={sideOn}
          title={localizeShortcutText(t("app.titlebar.sidebar"))}
          onClick={onToggleSide}
        >
          <I.panel_l size={14} />
        </button>
        <div className="tb-meta" data-tauri-drag-region>
          <div className="brand" data-tauri-drag-region>
            <span className="mark" />
            <span className="brand-name">Reasonix+</span>
          </div>
          {session && (
            <div className="crumbs" data-tauri-drag-region>
              <span className="sep">/</span>
              <span className="cur">{model ?? "-"}</span>
            </div>
          )}
        </div>
      </div>

      {/* center: drag region */}
      <span className="grow" data-tauri-drag-region />

      {/* right: panel toggles + window controls */}
      <div className="tb-right">
        <button
          type="button"
          className="iconbtn"
          data-on={ctxOn}
          title={t("app.titlebar.contextPanel")}
          onClick={onToggleCtx}
        >
          <I.panel_r size={14} />
        </button>

        {/* window controls — use onMouseDown+stopPropagation so the drag region doesn't swallow the event */}
        {isMac ? null : (
          <div className="win-controls">
            <button
              type="button"
              className="win-ctrl"
              title={t("app.titlebar.minimize")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.minimize();
              }}
            >
              <WinMinimize />
            </button>
            <button
              type="button"
              className="win-ctrl"
              title={isMaximized ? t("app.titlebar.restore") : t("app.titlebar.maximize")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.toggleMaximize();
              }}
            >
              {isMaximized ? <WinRestore /> : <WinMaximize />}
            </button>
            <button
              type="button"
              className="win-ctrl close"
              title={t("app.titlebar.close")}
              onMouseDown={(e) => {
                e.stopPropagation();
                win.close();
              }}
            >
              <WinClose />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

/** Session names whose agent is ACTIVELY running (turn in flight) in any tab on
 *  `workspaceDir`. The ONLY input to the sidebar dot: a merely open channel
 *  must not dot — the tab bar reserves the dot for running agents and the
 *  sidebar follows the same rule (issue: 3 orange dots for 1 working agent). */
/** The session name of a tab whose agent is actively running, or undefined. */
const EMPTY_SESSION_RATES: Map<string, number> = new Map();

export function runningSessionNames<
  T extends { id: string; workspaceDir?: string; session?: string; busy?: boolean },
>(tabs: readonly T[], workspaceDir?: string): Set<string> {
  const target = normalizeWorkspacePath(workspaceDir);
  const out = new Set<string>();
  for (const t of tabs) {
    const session = runningTabSession(t);
    if (session && normalizeWorkspacePath(t.workspaceDir) === target) out.add(session);
  }
  return out;
}

/** Group independently running session channels into unique visual workspace
 *  tabs. Workspace identity, not a historical backend group id, is the final
 *  defensive boundary against duplicate ribbon entries. */
export function groupTabsByWorkspace<
  T extends { id: string; workspaceDir?: string; group?: string },
>(tabs: readonly T[]): { key: string; items: T[] }[] {
  const groups: { key: string; items: T[] }[] = [];
  const byKey = new Map<string, { key: string; items: T[] }>();
  for (const tab of tabs) {
    const workspace = normalizeWorkspacePath(tab.workspaceDir);
    const key = workspace ? `workspace:${workspace}` : `pending:${tab.group ?? tab.id}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(tab);
  }
  return groups;
}

/** One representative channel per visual workspace tab. The currently active
 *  channel represents its workspace so keyboard navigation preserves focus. */
export function workspaceTabRepresentatives<
  T extends { id: string; workspaceDir?: string; group?: string },
>(tabs: readonly T[], activeId: string): T[] {
  return groupTabsByWorkspace(tabs).flatMap((group) => {
    const representative = group.items.find((tab) => tab.id === activeId) ?? group.items[0];
    return representative ? [representative] : [];
  });
}

export function TabBar({
  tabs,
  activeId,
  setActive,
  onClose,
  onNew,
  onClearTabs,
  singleTab,
}: {
  tabs: { id: string; workspaceDir?: string; session?: string; group?: string; busy?: boolean }[];
  activeId: string;
  setActive: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onClearTabs?: (scope: ClearTabsScope) => void;
  singleTab?: boolean;
}) {
  useLang();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  const handleClear = (scope: ClearTabsScope) => {
    if (onClearTabs) {
      onClearTabs(scope);
    } else {
      const targets = getTabsToClear(tabs, activeId, scope);
      if (scope === "all") onNew();
      for (const t of targets) onClose(t.id);
    }
  };

  // The ribbon is workspace-only. Session channels stay mounted and running,
  // but are selected from the sidebar instead of duplicated as S1/S2 pills.
  const groups = useMemo(() => groupTabsByWorkspace(tabs), [tabs]);
  const lastActiveByWorkspace = useRef(new Map<string, string>());
  const activeGroup = groups.find((group) => group.items.some((tab) => tab.id === activeId));
  if (activeGroup) lastActiveByWorkspace.current.set(activeGroup.key, activeId);
  const visualTabs = groups.flatMap((group) => {
    const active = group.items.find((tab) => tab.id === activeId);
    const rememberedId = lastActiveByWorkspace.current.get(group.key);
    const remembered = group.items.find((tab) => tab.id === rememberedId);
    const representative = active ?? remembered ?? group.items[0];
    return representative ? [representative] : [];
  });
  const activeVisualId =
    visualTabs.find((tab) => activeGroup?.items.some((candidate) => candidate.id === tab.id))?.id ??
    activeId;

  return (
    <div
      className="tabbar"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAnchor({ x: e.clientX, y: e.clientY });
      }}
    >
      {groups.map((g) => {
        const activeInGroup = g.items.find((t) => t.id === activeId);
        const rememberedId = lastActiveByWorkspace.current.get(g.key);
        const head = activeInGroup ?? g.items.find((t) => t.id === rememberedId) ?? g.items[0];
        if (!head) return null;
        const ws = head.workspaceDir ?? "";
        const label = ws
          ? ws
              .replace(/[\\/]$/, "")
              .split(/[\\/]/)
              .pop() || "workspace"
          : t("sidebarPanel.noWorkspace");
        // Active agents = sessions in this tab with a running turn. No dot when
        // nothing is running.
        const activeAgents = g.items.filter((t) => t.busy).length;
        return (
          <div
            key={g.key}
            className="tab tab-group"
            data-active={activeInGroup ? "true" : undefined}
            onClick={() => setActive(head.id)}
            onKeyDown={activationHandler(() => setActive(head.id))}
            title={ws || label}
          >
            {activeAgents > 0 ? (
              <span
                className="tab-active"
                title={`${activeAgents} active agent${activeAgents === 1 ? "" : "s"}`}
              >
                <span className="dot" data-state="running" />
                <span className="tab-active-count">{activeAgents}</span>
              </span>
            ) : null}
            <span className="label">{label}</span>
            {!singleTab ? (
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(head.id);
                }}
                onKeyDown={activationHandler((e) => {
                  e.stopPropagation();
                  onClose(head.id);
                })}
              >
                <I.x size={11} />
              </span>
            ) : null}
          </div>
        );
      })}
      <div
        className="tab newtab"
        title={localizeShortcutText(t("app.tab.newTabTitle"))}
        onClick={onNew}
        onKeyDown={activationHandler(onNew)}
      >
        <I.plus size={12} />
        <span style={{ fontSize: 11, marginLeft: 4 }}>{t("app.tab.newTab")}</span>
      </div>
      {menuAnchor ? (
        <TabMenu
          anchor={menuAnchor}
          tabs={visualTabs}
          activeId={activeVisualId}
          onClear={handleClear}
          onClose={() => setMenuAnchor(null)}
        />
      ) : null}
    </div>
  );
}

function MainHead({
  session,
  model,
  subagentModel,
  modelGroups,
  workspaceDir,
  busy,
  hasMessages,
  onExport,
  onDuplicate,
  onOpenWorkdir,
  onRename,
}: {
  session: string;
  model?: string;
  subagentModel?: string;
  /** Enabled/visible models for the Duplicate-session picker, grouped as the composer groups them. */
  modelGroups: { key: string; label: string; ids: string[] }[];
  workspaceDir?: string;
  busy: boolean;
  hasMessages: boolean;
  onExport: () => void;
  onDuplicate: (mainModel: string, subagentModel: string) => void;
  onOpenWorkdir: (anchor: { top?: number; bottom?: number; left: number }) => void;
  onRename?: (title: string) => void;
}) {
  useLang();
  const [title, setTitle] = useState(session);
  const [isEditing, setIsEditing] = useState(false);
  const isEditingRef = useRef(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupMain, setDupMain] = useState(model ?? DEFAULT_MODEL);
  const [dupSub, setDupSub] = useState(subagentModel ?? model ?? DEFAULT_MODEL);
  const dupWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isEditingRef.current) {
      setTitle(session);
    }
  }, [session]);

  useEffect(() => {
    if (!dupOpen) return;
    const onDown = (e: MouseEvent) => {
      if (dupWrapRef.current && !dupWrapRef.current.contains(e.target as Node)) setDupOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDupOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [dupOpen]);

  const commit = useCallback(() => {
    if (!isEditingRef.current) return;
    isEditingRef.current = false;
    setIsEditing(false);
    const next = flattenText(title).slice(0, 200);
    if (next && next !== session) {
      onRename?.(next);
    } else {
      setTitle(session);
    }
  }, [title, session, onRename]);

  const wsLabel = workspaceDir
    ? workspaceDir.split(/[\\/]/).pop() || "workspace"
    : t("app.header.noWorkspace");
  return (
    <div className="main-head">
      <div className="title-wrap">
        <h1>
          <input
            className="editable"
            value={isEditing ? title : session}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => {
              isEditingRef.current = true;
              setIsEditing(true);
              setTitle(session);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                isEditingRef.current = false;
                setIsEditing(false);
                setTitle(session);
                e.currentTarget.blur();
              }
            }}
            size={Math.max(1, (isEditing ? title : session).length)}
            maxLength={200}
            title={t("sidebarPanel.renameSession")}
            aria-label={t("sidebarPanel.renameSession")}
            spellCheck={false}
          />
          {busy ? (
            <span className="pill" style={{ color: "var(--accent)" }}>
              <span className="dot" />
              <span className="shimmer">{t("app.header.running")}</span>
            </span>
          ) : null}
        </h1>
        <div className="sub">
          <span
            className="ws-crumb"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenWorkdir({ top: r.bottom + 6, left: r.left });
            }}
            onKeyDown={activationHandler((e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onOpenWorkdir({ top: r.bottom + 6, left: r.left });
            })}
            style={{ cursor: "pointer" }}
            title={workspaceDir ?? t("app.header.clickToSelect")}
          >
            <I.folder size={10} /> {wsLabel}
          </span>
          {model ? (
            <span className="pill">
              <I.brain size={10} /> {model}
            </span>
          ) : null}
        </div>
      </div>
      <span className="grow" />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div ref={dupWrapRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="h-btn"
            disabled={!hasMessages}
            title={t("app.titlebar.duplicateSession")}
            onClick={() => {
              if (dupOpen) {
                setDupOpen(false);
                return;
              }
              setDupMain(model ?? DEFAULT_MODEL);
              setDupSub(subagentModel ?? model ?? DEFAULT_MODEL);
              setDupOpen(true);
            }}
          >
            <I.copy size={12} /> {t("app.header.duplicate")}
          </button>
          {dupOpen ? (
            <div
              className="popup"
              style={{
                top: "calc(100% + 6px)",
                right: 0,
                left: "auto",
                bottom: "auto",
                width: 300,
              }}
            >
              <div className="dup-panel">
                <div className="dup-title">{t("app.titlebar.duplicateSession")}</div>
                <div className="dup-hint">{t("app.duplicate.hint")}</div>
                <label className="dup-label" htmlFor="duplicate-main-model">
                  {t("app.duplicate.mainModel")}
                </label>
                <select
                  id="duplicate-main-model"
                  className="field"
                  value={dupMain}
                  onChange={(e) => setDupMain(e.target.value)}
                >
                  {duplicateModelOptions(modelGroups, dupMain)}
                </select>
                <label className="dup-label" htmlFor="duplicate-subagent-model">
                  {t("app.duplicate.subagentModel")}
                </label>
                <select
                  id="duplicate-subagent-model"
                  className="field"
                  value={dupSub}
                  onChange={(e) => setDupSub(e.target.value)}
                >
                  {duplicateModelOptions(modelGroups, dupSub)}
                </select>
                <div className="dup-actions">
                  <button
                    type="button"
                    className="btn small"
                    disabled={!dupMain || !dupSub}
                    onClick={() => {
                      onDuplicate(dupMain, dupSub);
                      setDupOpen(false);
                    }}
                  >
                    {t("app.duplicate.confirm")}
                  </button>
                  <button type="button" className="mini-btn" onClick={() => setDupOpen(false)}>
                    {t("app.duplicate.back")}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="h-btn"
          onClick={onExport}
          disabled={!hasMessages}
          title={t("app.header.exportMd")}
        >
          <I.download size={12} /> {t("app.header.export")}
        </button>
      </div>
    </div>
  );
}

function PendingWorkspaceView({
  local,
  recent,
  onPick,
  onBrowse,
}: {
  local?: string;
  recent: string[];
  onPick: (path: string) => void;
  onBrowse: () => void;
}) {
  useLang();
  return (
    <div className="pending-workspace">
      <div className="pw-card">
        <div className="pw-head">
          <I.folder size={13} />
          <span>{t("workdir.newTabHeading")}</span>
        </div>
        <p className="pw-sub">{t("workdir.newTabBody")}</p>
        <div className="wd-list pw-list">
          {local ? (
            <div
              className="wd-row"
              onClick={() => onPick(local)}
              onKeyDown={activationHandler(() => onPick(local))}
              title={local}
            >
              <span className="ic">
                <I.terminal size={12} />
              </span>
              <div className="b">
                <div className="p">{t("workdir.reasonixLocal")}</div>
                <div className="br">{local}</div>
              </div>
            </div>
          ) : null}
          {recent
            .filter((p) => p !== local)
            .map((p) => {
              const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
              return (
                <div
                  key={p}
                  className="wd-row"
                  onClick={() => onPick(p)}
                  onKeyDown={activationHandler(() => onPick(p))}
                  title={p}
                >
                  <span className="ic">
                    <I.folder size={12} />
                  </span>
                  <div className="b">
                    <div className="p">{name}</div>
                    <div className="br">{p}</div>
                  </div>
                </div>
              );
            })}
        </div>
        <div className="pw-foot">
          <button type="button" className="btn" onClick={onBrowse}>
            <I.plus size={11} /> {t("workdir.newTabBrowse")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shared shell for the main-area empty panels (welcome, no-sessions): the
 *  empty-mark plus a centered title/hint block above the caller's actions. */
function EmptyPanel({
  title,
  hint,
  children,
}: {
  title: string;
  hint: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "48px 16px 24px",
        textAlign: "center",
        color: "var(--muted)",
        fontFamily: "var(--font-sans, 'Geist', sans-serif)",
      }}
    >
      <div className="empty-mark" />
      <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg)", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, marginBottom: 18 }}>{hint}</div>
      {children}
    </div>
  );
}

function EmptyState({
  onPick,
  workspaceDir,
}: {
  onPick: (text: string) => void;
  workspaceDir?: string;
}) {
  useLang();
  const suggestions = [
    t("app.empty.suggestion0"),
    t("app.empty.suggestion1"),
    t("app.empty.suggestion2"),
    t("app.empty.suggestion3"),
  ];
  const wsLabel = workspaceDir ? workspaceDir.split(/[\\/]/).pop() : null;
  return (
    <EmptyPanel
      title={t("app.empty.welcome")}
      hint={
        wsLabel ? (
          <>
            {t("app.empty.currentWorkspace")}
            <code style={{ fontFamily: "Geist Mono, monospace" }}>{wsLabel}</code>
          </>
        ) : (
          t("app.empty.selectWorkspace")
        )
      }
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
          maxWidth: 540,
          margin: "0 auto",
        }}
      >
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="btn"
            style={{ fontSize: 11.5 }}
            onClick={() => onPick(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </EmptyPanel>
  );
}

/** Empty-workspace panel. Deliberately mutation-agnostic: the one in-flight
 *  indicator is the main-area pill above it, so this surface never restates it
 *  (and the New chat button is never disabled into a dead, unexplained control). */
function NoSessionsView({ onNewChat }: { onNewChat: () => void }) {
  useLang();
  return (
    <EmptyPanel title={t("app.noSessions.title")} hint={t("app.noSessions.hint")}>
      <button type="button" className="btn" style={{ fontSize: 12 }} onClick={onNewChat}>
        {t("sidebarPanel.newChat")}
      </button>
    </EmptyPanel>
  );
}

function NeedsSetupView({
  workspaceDir,
  onPickWorkspace,
  onOpenSettings,
}: {
  workspaceDir?: string;
  onPickWorkspace: () => void;
  onOpenSettings: () => void;
}) {
  useLang();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 18,
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>{t("app.setup.welcome")}</div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", maxWidth: 460, textAlign: "center" }}>
        {t("app.setup.description")}
      </div>
      <div
        style={{
          width: "min(420px, 100%)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div className="setting-row" style={{ borderBottom: "none" }}>
          <div className="l">
            <div className="n">{t("app.setup.workspace")}</div>
            <div className="h">{workspaceDir || t("app.setup.notSelected")}</div>
          </div>
          <button type="button" className="btn" onClick={onPickWorkspace}>
            {t("app.setup.choose")}
          </button>
        </div>
        <button type="button" className="btn primary" onClick={onOpenSettings}>
          {t("app.setup.openSettings")}
        </button>
      </div>
    </div>
  );
}

function UpdateOverlay({
  version,
  currentVersion,
  status,
  progress,
  onInstall,
  onDismiss,
}: {
  version: string;
  currentVersion: string;
  status: "idle" | "installing" | "error";
  progress: { downloaded: number; total: number | null } | null;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  useLang();
  const ratio =
    progress?.total && progress.total > 0
      ? Math.min(1, progress.downloaded / progress.total)
      : null;
  const statusText =
    status === "error"
      ? t("app.update.failed")
      : status === "installing"
        ? progress
          ? ratio !== null
            ? t("app.update.downloading", {
                downloaded: formatBytes(progress.downloaded),
                total: formatBytes(progress.total ?? 0),
                pct: Math.round(ratio * 100),
              })
            : t("app.update.downloadingUnknown", {
                downloaded: formatBytes(progress.downloaded),
              })
          : t("app.update.installing")
        : t("app.update.clickToInstall");
  return (
    <div className="update-overlay" aria-live="polite">
      <div className="plan-banner update-overlay-card">
        <span className="ico">
          <I.download size={14} />
        </span>
        <div className="body">
          <div className="t">
            {t("app.update.available", { current: currentVersion, latest: version })}
          </div>
          <div className="s">{statusText}</div>
          {status === "installing" && ratio !== null ? (
            <div className="meter-mini" aria-label="download progress">
              <span style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
          ) : null}
        </div>
        <div className="prog">
          <button type="button" onClick={onInstall} disabled={status === "installing"}>
            {t("app.update.install")}
          </button>
          <button type="button" onClick={onDismiss} disabled={status === "installing"}>
            {t("app.update.later")}
          </button>
        </div>
      </div>
    </div>
  );
}

type TabMeta = {
  /** Backend channel id for one independently running session agent. */
  id: string;
  workspaceDir?: string;
  busy?: boolean;
  session?: string;
  /** Visual workspace-tab id shared by sibling session channels. */
  group?: string;
};

/** Everything one channel needs to render a workspace's shared session list. */
type SessionView = {
  items: SessionInfo[];
  mutation: SessionMutation | null;
  pendingDeleteCount: number;
  confirmed: boolean;
  /** Id of the mutation in flight, so a channel reconciles once per intent. */
  openIntentId: number | null;
};

const EMPTY_SESSION_VIEW: SessionView = {
  items: [],
  mutation: null,
  pendingDeleteCount: 0,
  confirmed: false,
  openIntentId: null,
};

export function App() {
  // Arm the WebAudio cue player on the first gesture — one process-wide
  // listener, so autoplay policies don't silence the first cue.
  useEffect(() => {
    primeFeedbackSounds();
  }, []);
  const [tabs, setTabsState] = useState<TabMeta[]>([]);
  const [backendConnected, setBackendConnected] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true);
  const timingTrackerRef = useRef<StartupTimingTracker>(new StartupTimingTracker());
  const expectedTabsRef = useRef<Set<string> | null>(null);
  const initializedTabsRef = useRef<Set<string>>(new Set());
  const [activeTabId, setActiveTabId] = useState<string>("");
  const [startupFailure, setStartupFailure] = useState<StartupFailureState | null>(null);
  // App-global Ollama catalog — the backend fetches it once at launch and
  // broadcasts it tabId-less, so every tab renders the same shared list
  // instead of per-tab copies.
  const [ollamaCatalog, setOllamaCatalog] = useState<{
    models: string[];
    /** Prefixed vision-capable ids (`ollama/llava`) confirmed by the daemon. */
    visionModels: Set<string>;
    error: string | null;
    plan: string | null;
    hiddenCount: number;
  }>({ models: [], visionModels: new Set(), error: null, plan: null, hiddenCount: 0 });
  const [opencodeCatalog, setOpencodeCatalog] = useState<{
    models: string[];
    visionModels: Set<string>;
    error: string | null;
  }>({ models: [], visionModels: new Set(), error: null });
  // Changelog from the repo's commit history, grouped per release by the
  // backend. `loaded` distinguishes "not fetched yet" from "fetched, empty".
  const [changelog, setChangelog] = useState<{
    releases: ChangelogRelease[];
    version: string;
    error: string | null;
    loaded: boolean;
  }>({ releases: [], version: "", error: null, loaded: false });
  const [startupRetryNonce, setStartupRetryNonce] = useState(0);
  const dispatchersRef = useRef<Map<string, TabDispatcher>>(new Map());
  const pendingEventsRef = useRef<Map<string, TabAction[]>>(new Map());
  const pendingDeltasRef = useRef<Map<string, DeltaBatchItem[]>>(new Map());
  // Per-tab sliding-window trackers for the sidebar's live tokens/second
  // readout. Raw `model.delta` events feed these; a throttled tick snapshots
  // them into `sessionRates` (keyed by session name) for the running rows.
  const streamRatesRef = useRef<Map<string, StreamRateTracker>>(new Map());
  // Subagent output is this session's output too, but a child reports a per-run
  // RUNNING total, so one folder per tab turns each run's growth into the same
  // window the tab's own stream feeds. Dropped with that tracker.
  const subagentRatesRef = useRef<Map<string, SubagentRateFolder>>(new Map());
  const [sessionRates, setSessionRates] = useState<Map<string, number>>(new Map());
  const rafScheduledRef = useRef(false);
  const startupStderrRef = useRef<string[]>([]);
  const tabsRef = useRef<TabMeta[]>([]);
  // Wire events can share a React batch; the next event must see every prior update.
  const setTabs = useCallback((update: TabMeta[] | ((prev: TabMeta[]) => TabMeta[])) => {
    const next = typeof update === "function" ? update(tabsRef.current) : update;
    tabsRef.current = next;
    setTabsState(next);
  }, []);

  // ONE session list per workspace, shared by every channel on it: a channel never
  // owns rows, so two channels can never disagree about the same directory.
  const [sessionsStore, setSessionsStore] = useState<SessionsStore>(emptySessionsStore);
  const sessionsStoreRef = useRef<SessionsStore>(sessionsStore);
  // The ref stays authoritative for synchronous reads (the event listener, the
  // handlers); the state copy is what re-renders, and only when rows changed.
  const commitSessionsStore = useCallback((next: SessionsStore, changed: boolean) => {
    sessionsStoreRef.current = next;
    if (changed) setSessionsStore(next);
  }, []);
  const beginSessionIntent = useCallback(
    (
      workspaceDir: string | undefined,
      kind: SessionMutation["kind"],
      name?: string,
      keep?: readonly string[],
    ) => {
      commitSessionsStore(
        beginIntent(sessionsStoreRef.current, workspaceDir, { kind, name, keep }),
        true,
      );
    },
    [commitSessionsStore],
  );
  const patchSessionRow = useCallback(
    (workspaceDir: string | undefined, name: string, patch: Partial<SessionInfo>) => {
      const current = sessionsStoreRef.current;
      const next = patchSession(current, workspaceDir, name, patch);
      commitSessionsStore(next, next !== current);
    },
    [commitSessionsStore],
  );
  // One derived view per workspace, rebuilt when the store or the tab set changes.
  // The row array keeps its identity in the store, so memoized rows still bail out.
  const sessionViews = useMemo(() => {
    const views = new Map<string, SessionView>();
    for (const tab of tabs) {
      const key = normalizeWorkspacePath(tab.workspaceDir);
      if (views.has(key)) continue;
      views.set(key, {
        items: visibleSessions(sessionsStore, tab.workspaceDir),
        mutation: mutationFor(sessionsStore, tab.workspaceDir),
        pendingDeleteCount: hiddenNames(sessionsStore, tab.workspaceDir).length,
        confirmed: sessionsEntry(sessionsStore, tab.workspaceDir).confirmed,
        openIntentId: openIntentId(sessionsStore, tab.workspaceDir),
      });
    }
    return views;
  }, [tabs, sessionsStore]);
  const sessionViewFor = useCallback(
    (workspaceDir?: string): SessionView =>
      sessionViews.get(normalizeWorkspacePath(workspaceDir)) ?? EMPTY_SESSION_VIEW,
    [sessionViews],
  );

  // Mirror of activeTabId for listener closures — the startup effect must
  // NOT re-run on every tab switch (it tears down and re-fires desktop_resync,
  // which echoes $session_loaded and clobbers a live conversation). Listeners
  // read the ref instead of the state value so they stay current without
  // re-running the effect.
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // The tab that was visible a moment ago keeps its transcript mounted (hidden), so
  // switching back does not remount and re-parse the conversation. Derived during
  // render, not in an effect: an effect lands a commit late, by which point the
  // transcript has already unmounted.
  const previousActiveRef = useRef("");
  const lastActiveRef = useRef("");
  if (activeTabId !== lastActiveRef.current) {
    previousActiveRef.current = lastActiveRef.current;
    lastActiveRef.current = activeTabId;
  }
  const previousActiveTabId = previousActiveRef.current;

  const requestOllamaModels = useCallback((force?: boolean) => {
    rpcSend({ tabId: activeTabIdRef.current, cmd: "ollama_models_list", force }).catch((err) =>
      recordFrontendFailure("frontend.ollama_models_failed", err),
    );
  }, []);

  const requestAntigravityModels = useCallback(() => {
    rpcSend({
      tabId: activeTabIdRef.current,
      cmd: "antigravity_models_refresh",
    }).catch((err) => recordFrontendFailure("frontend.antigravity_models_failed", err));
  }, []);

  const requestOpencodeModels = useCallback((force?: boolean) => {
    rpcSend({
      tabId: activeTabIdRef.current,
      cmd: "opencode_models_refresh",
      force,
    }).catch((err) => recordFrontendFailure("frontend.opencode_models_failed", err));
  }, []);

  const requestChangelog = useCallback((force?: boolean) => {
    rpcSend({ tabId: activeTabIdRef.current, cmd: "changelog_get", force }).catch((err) =>
      recordFrontendFailure("frontend.changelog_failed", err),
    );
  }, []);

  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "installing" | "error">("idle");
  const [updateProgress, setUpdateProgress] = useState<{
    downloaded: number;
    total: number | null;
  } | null>(null);
  const [currency, setCurrency] = useState<"CNY" | "USD">(() => {
    const v = localStorage.getItem("reasonix.currency");
    return v === "USD" ? "USD" : "CNY";
  });
  // Per-tab theme map — each tab keeps its own theme/style so switching tabs
  // never mixes them up. Entries are seeded on $tab_opened and dropped on
  // $tab_closed; the active tab's entry drives document.documentElement.
  const [tabThemes, setTabThemes] = useState<Record<string, TabTheme>>({});
  const [fontScale, setFontScale] = useState<FontScale>(() => {
    const v = localStorage.getItem("reasonix.fontScale");
    return isFontScale(v) ? v : FONT_SCALE.MEDIUM;
  });
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => {
    const v = localStorage.getItem("reasonix.fontFamily");
    return isFontFamily(v) ? v : FONT_FAMILY.SANS;
  });
  const [customFontFamily, setCustomFontFamily] = useState<string>(() => {
    return localStorage.getItem("reasonix.customFontFamily") ?? "";
  });
  const {
    collapsed: sideCollapsed,
    toggle: onToggleSide,
    requireCollapsed: requireSideCollapsed,
    releaseCollapsed: releaseSideCollapsed,
  } = useAutoCollapse("reasonix.sideCollapsed");
  const {
    collapsed: ctxCollapsed,
    toggle: onToggleCtx,
    requireCollapsed: requireCtxCollapsed,
    releaseCollapsed: releaseCtxCollapsed,
  } = useAutoCollapse("reasonix.ctxCollapsed");

  const { width: sideWidth, onMouseDown: onSideResizeDown } = useResizable("side", sideCollapsed);
  const { width: ctxWidth, onMouseDown: onCtxResizeDown } = useResizable("ctx", ctxCollapsed);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const visibleSide = sideCollapsed ? 0 : sideWidth;
  const visibleCtx = ctxCollapsed ? 0 : ctxWidth;
  const threadMaxWidth = getThreadMaxWidth({ viewportWidth, visibleSide, visibleCtx });

  const activeTabTheme = activeTabId ? tabThemes[activeTabId] : undefined;

  useEffect(() => {
    // Chrome outside the per-tab .app subtree (update overlay, startup
    // failure) follows the active tab's theme; each tab's own subtree is
    // themed by its own data-theme attributes.
    if (!activeTabTheme) return;
    document.documentElement.dataset.theme = activeTabTheme.theme;
    document.documentElement.dataset.themeStyle = activeTabTheme.themeStyle;
  }, [activeTabTheme]);

  // Sync --composer-max-width to .app (separate from inline style to avoid React override)
  const composerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!composerRef.current) composerRef.current = document.querySelector(".app");
    composerRef.current?.style.setProperty("--composer-max-width", `${threadMaxWidth}px`);
  }, [threadMaxWidth]);

  useEffect(() => {
    let raf = 0;
    let prevStage: ResponsiveStage | null = null;

    const sync = () => {
      raf = 0;
      const width = window.innerWidth;
      setViewportWidth(width);
      const next = responsiveStage(width);
      if (prevStage === next) return;
      const prev = prevStage;
      prevStage = next;

      if (next === RESPONSIVE_STAGE.WIDE) {
        releaseCtxCollapsed();
        releaseSideCollapsed();
      } else if (next === RESPONSIVE_STAGE.COMPACT) {
        // Only force ctx collapse when entering compact from wider — coming
        // from narrow, the user may have manually opened ctx and we keep that.
        if (prev === null || prev === RESPONSIVE_STAGE.WIDE) requireCtxCollapsed();
        releaseSideCollapsed();
      } else {
        requireCtxCollapsed();
        requireSideCollapsed();
      }
    };

    const onResize = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(sync);
    };

    sync();
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [requireCtxCollapsed, releaseCtxCollapsed, requireSideCollapsed, releaseSideCollapsed]);

  useEffect(() => {
    // Chromium webview supports `zoom`; scales every px-based size without touching CSS rules.
    document.documentElement.style.setProperty("zoom", String(FONT_SCALE_ZOOM[fontScale]));
    localStorage.setItem("reasonix.fontScale", fontScale);
  }, [fontScale]);

  useEffect(() => {
    const custom = customFontFamily.trim();
    const stack =
      fontFamily === FONT_FAMILY.CUSTOM && custom
        ? custom
        : (FONT_FAMILY_STACK[fontFamily] ?? FONT_FAMILY_STACK.sans);
    document.documentElement.style.setProperty("--font-sans", stack);
    localStorage.setItem("reasonix.fontFamily", fontFamily);
    localStorage.setItem("reasonix.customFontFamily", customFontFamily);
  }, [fontFamily, customFontFamily]);

  useEffect(() => {
    const onCur = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === "CNY" || detail === "USD") setCurrency(detail);
    };
    window.addEventListener("reasonix:currency", onCur);
    return () => window.removeEventListener("reasonix:currency", onCur);
  }, []);

  const deliverToTab = useCallback((tabId: string, action: TabAction) => {
    const dispatch = dispatchersRef.current.get(tabId);
    if (dispatch) {
      dispatch(action);
    } else {
      const buf = pendingEventsRef.current.get(tabId) ?? [];
      buf.push(action);
      pendingEventsRef.current.set(tabId, buf);
    }
  }, []);

  const registerDispatch = useCallback((tabId: string, d: TabDispatcher | null) => {
    if (d) {
      dispatchersRef.current.set(tabId, d);
      const buf = pendingEventsRef.current.get(tabId);
      if (buf && buf.length > 0) {
        for (const action of buf) d(action);
        pendingEventsRef.current.delete(tabId);
      }
    } else {
      dispatchersRef.current.delete(tabId);
    }
  }, []);

  // The splash exists to cover an unusable UI, not to police background tabs: it
  // The splash exists to cover an unusable UI, not to police background tabs: it
  // lifts once the tab the user is actually shown has acked, while every other
  // restored tab keeps initializing behind it. One helper so the ack, snapshot and
  // close paths cannot drift on what "loaded enough" means.
  const remainingTabIds = useCallback((): string[] => {
    const expected = expectedTabsRef.current;
    if (!expected) return [];
    return Array.from(expected).filter((id) => !initializedTabsRef.current.has(id));
  }, []);

  const revealWorkspacesIfReady = useCallback(
    (
      tracker: StartupTimingTracker,
      reason: string,
      activeTabId: string | null = activeTabIdRef.current,
    ) => {
      const expected = expectedTabsRef.current;
      const initialized = initializedTabsRef.current;
      if (!isWorkspaceRevealReady(expected, initialized, activeTabId)) return false;
      tracker.finish(
        areWorkspacesLoaded(expected, initialized) ? "all_workspaces_initialized" : reason,
        { tabs: Array.from(initialized), remainingTabs: remainingTabIds() },
      );
      setLoadingWorkspaces(false);
      return true;
    },
    [remainingTabIds],
  );

  const markWorkspaceInitialized = useCallback(
    (tabId: string) => {
      initializedTabsRef.current.add(tabId);
      timingTrackerRef.current.mark("workspace_initialized_ui_acknowledged", {
        tabId,
        details: {
          totalExpected: expectedTabsRef.current?.size ?? null,
          initializedCount: initializedTabsRef.current.size,
          remainingTabs: remainingTabIds(),
        },
      });
      revealWorkspacesIfReady(timingTrackerRef.current, "focused_workspace_initialized");
    },
    [remainingTabIds, revealWorkspacesIfReady],
  );

  const retryStartup = useCallback(() => {
    setStartupRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const update = await check();
        if (!cancelled && update) setPendingUpdate(update);
      } catch {
        // Updater check is optional (dev builds, offline) — nothing to report.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const installUpdate = useCallback(async () => {
    if (!pendingUpdate) return;
    setUpdateStatus("installing");
    setUpdateProgress(null);
    try {
      await pendingUpdate.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          setUpdateProgress({ downloaded: 0, total: evt.data.contentLength ?? null });
        } else if (evt.event === "Progress") {
          setUpdateProgress((p) =>
            p ? { ...p, downloaded: p.downloaded + evt.data.chunkLength } : p,
          );
        } else if (evt.event === "Finished") {
          setUpdateProgress((p) => (p ? { ...p, downloaded: p.total ?? p.downloaded } : p));
        }
      });
      await relaunch();
    } catch (err) {
      recordFrontendFailure("frontend.update_failed", err);
      setUpdateStatus("error");
    }
  }, [pendingUpdate]);

  // Startup setup: spawn the RPC daemon, wire tab/settings listeners, retry via nonce.
  // biome-ignore lint/correctness/useExhaustiveDependencies: startupRetryNonce is a nonce re-run trigger (retryStartup bumps it; never read in the body) — activeTabId is mirrored into activeTabIdRef so listeners stay current without re-running setup (and re-firing desktop_resync) on every tab switch
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const flushDeltas = () => {
      rafScheduledRef.current = false;
      for (const [tabId, items] of pendingDeltasRef.current) {
        if (items.length === 0) continue;
        deliverToTab(tabId, { t: "batch_delta", items });
        pendingDeltasRef.current.set(tabId, []);
      }
    };
    const scheduleFlush = () => {
      if (rafScheduledRef.current || cancelled) return;
      rafScheduledRef.current = true;
      requestAnimationFrame(flushDeltas);
    };
    const flushTabDeltas = (tabId: string) => {
      const bucket = pendingDeltasRef.current.get(tabId);
      if (bucket && bucket.length > 0) {
        deliverToTab(tabId, { t: "batch_delta", items: bucket });
        pendingDeltasRef.current.set(tabId, []);
      }
    };
    // Drop every per-tab ref for a tab that no longer exists — one place, so a
    // newly-added per-tab map can't be forgotten in one of the two close paths.
    const forgetTab = (tabId: string) => {
      dispatchersRef.current.delete(tabId);
      pendingEventsRef.current.delete(tabId);
      pendingDeltasRef.current.delete(tabId);
      streamRatesRef.current.delete(tabId);
      subagentRatesRef.current.delete(tabId);
    };

    /** One entry per tab, created on first use — the single rule for every per-tab
     *  live-rate map, so neither side can forget to create its entry. */
    function perTab<T>(map: Map<string, T>, tabId: string, create: () => T): T {
      const existing = map.get(tabId);
      if (existing) return existing;
      const created = create();
      map.set(tabId, created);
      return created;
    }
    /** The tab's live rate window, which `model.final` resets so every
     *  provider-output channel shares one window. */
    const rateTrackerFor = (tabId: string): StreamRateTracker =>
      perTab(streamRatesRef.current, tabId, () => new StreamRateTracker());
    const subagentRateFolderFor = (tabId: string): SubagentRateFolder =>
      perTab(subagentRatesRef.current, tabId, () => new SubagentRateFolder());

    const setup = async () => {
      const tracker = new StartupTimingTracker();
      timingTrackerRef.current = tracker;
      tracker.mark("setup_started");
      startupStderrRef.current = [];
      setStartupFailure(null);
      setLoadingWorkspaces(true);
      expectedTabsRef.current = null;
      initializedTabsRef.current.clear();
      const subs = await Promise.all([
        listen<{ data: string }>("rpc:event", (e) => {
          try {
            const ev = JSON.parse(e.payload.data) as IncomingEvent;
            const tabId = ev.tabId;

            if (ev.type === "$connected") {
              tracker.mark("backend_connected");
              setBackendConnected(true);
              return;
            }

            // The daemon already persists every diagnostic to its rotating log; mirroring
            // each one to the console doubled every wire event and starved the event loop.
            if (ev.type === "$diagnostic") return;

            if (ev.type === "$tab_opened" && tabId) {
              expectedTabsRef.current?.add(tabId);
              tracker.mark("tab_opened", {
                tabId,
                details: {
                  workspaceDir: ev.workspaceDir,
                  session: ev.activeSession ?? ev.sessions?.[0] ?? null,
                  active: ev.active ?? false,
                },
              });
              const openedSession = ev.activeSession ?? ev.sessions?.[0];
              // A fresh channel's session is not on disk yet, so record the create
              // here, where the workspace it belongs to is known.
              if (ev.creating === true && openedSession && ev.workspaceDir) {
                beginSessionIntent(ev.workspaceDir, "create", openedSession);
              }
              setTabs((prev) => {
                const idx = prev.findIndex((t) => t.id === tabId);
                if (idx === -1) {
                  return [
                    ...prev,
                    {
                      id: tabId,
                      workspaceDir: ev.workspaceDir,
                      session: openedSession,
                      group: ev.groupId,
                    },
                  ];
                }
                // Merge so a workspace switch / regroup updates the existing tab.
                const merged: TabMeta = {
                  ...prev[idx],
                  workspaceDir: ev.workspaceDir,
                  session: openedSession ?? prev[idx]!.session,
                  group: ev.groupId ?? prev[idx]!.group,
                };
                const copy = prev.slice();
                copy[idx] = merged;
                return copy;
              });
              // Seed the tab's own theme: its stored keys first, then the
              // legacy global keys (migration), then inherit whatever the
              // active tab was showing. Persist immediately so an inherited
              // theme survives restarts.
              setTabThemes((prev) => {
                if (prev[tabId]) return prev;
                const stored = readTabTheme(localStorage, tabId);
                const inherit = prev[activeTabIdRef.current] ?? DEFAULT_TAB_THEME;
                const next = stored ?? inherit;
                writeTabTheme(localStorage, tabId, next);
                return { ...prev, [tabId]: next };
              });
              // Focus the tab the backend marked active (user-opened, or the
              // restored focused tab); otherwise keep focus, but make sure
              // *some* tab is active during a multi-tab restore.
              setActiveTabId((prev) => (ev.active || !prev ? tabId : prev));
              return;
            }
            if (ev.type === "$tab_closed" && tabId) {
              tracker.mark("tab_closed", { tabId });
              const remaining = tabsRef.current.filter((t) => t.id !== tabId);
              setTabs(remaining);
              setActiveTabId((prev) => (prev === tabId ? (remaining[0]?.id ?? "") : prev));
              setTabThemes((prev) => {
                if (!prev[tabId]) return prev;
                const { [tabId]: _dropped, ...rest } = prev;
                clearTabTheme(localStorage, tabId);
                return rest;
              });
              forgetTab(tabId);
              expectedTabsRef.current?.delete(tabId);
              // Closing a tab can be what completes the boot gate, so re-check
              // instead of leaving the splash up on a set that can only shrink.
              revealWorkspacesIfReady(timingTrackerRef.current, "tabs_closed_during_boot");
              return;
            }

            if (ev.type === "$tabs_snapshot") {
              // Authoritative tab set (backend emitted it at the END of a
              // desktop_resync). Replace the tab list wholesale so tabs left
              // over from an older backend generation (whose ids were
              // re-minted after a restart) get pruned instead of living on
              // as ghosts that route events to the wrong tab.
              const ids = new Set(ev.tabs.map((t) => t.id));
              expectedTabsRef.current = ids;
              tracker.mark("tabs_snapshot_received", {
                details: {
                  tabCount: ids.size,
                  tabIds: Array.from(ids),
                  initializedCount: initializedTabsRef.current.size,
                },
              });
              revealWorkspacesIfReady(
                tracker,
                "tabs_snapshot_already_initialized",
                activeTabIdRef.current || (ev.tabs.find((t) => t.active)?.id ?? null),
              );
              setTabs((prev) => {
                const busyById = new Map(prev.map((t) => [t.id, t.busy]));
                return ev.tabs.map((t) => ({
                  id: t.id,
                  workspaceDir: t.workspaceDir,
                  busy: busyById.get(t.id),
                  session: t.activeSession,
                  group: t.groupId,
                }));
              });
              for (const id of Array.from(dispatchersRef.current.keys())) {
                if (!ids.has(id)) forgetTab(id);
              }
              setTabThemes((prev) => {
                let next = prev;
                for (const id of Object.keys(prev)) {
                  if (!ids.has(id)) {
                    const { [id]: _dropped, ...rest } = next;
                    next = rest;
                    clearTabTheme(localStorage, id);
                  }
                }
                return next;
              });
              setActiveTabId((prev) =>
                ids.has(prev) ? prev : (ev.tabs.find((t) => t.active)?.id ?? ""),
              );
              return;
            }

            if (ev.type === "model.delta" && tabId) {
              // Feed every provider-output channel into the live rate tracker
              // (content, reasoning, and tool-call arguments all consume tokens).
              rateTrackerFor(tabId).record(ev.text.length);
              if (ev.channel === "content" || ev.channel === "reasoning") {
                const bucket = pendingDeltasRef.current.get(tabId) ?? [];
                bucket.push({ turn: ev.turn, channel: ev.channel, text: ev.text });
                pendingDeltasRef.current.set(tabId, bucket);
                scheduleFlush();
                return;
              }
            }

            // A subagent's output IS this session's output: folding it into the
            // tab's window makes the sidebar read agent + subagents.
            if (ev.type === "subagent.progress" && tabId) {
              const folder = subagentRateFolderFor(tabId);
              if (ev.action === "start") folder.forget(ev.runId);
              else if (ev.action === "stream") {
                folder.record(
                  ev.runId,
                  (ev.outputChars ?? 0) + (ev.reasoningChars ?? 0),
                  rateTrackerFor(tabId),
                );
              }
            }

            // A completed model call closes its stream: drop the window so the
            // next call's rate ramps from zero instead of averaging this one's
            // tail across the tool-execution gap.
            if (ev.type === "model.final" && tabId) {
              streamRatesRef.current.get(tabId)?.reset();
            }

            if (ev.type === "$ready" && tabId) {
              tracker.mark("tab_runtime_ready", { tabId });
            }

            if (ev.type === "$needs_setup" && tabId) {
              tracker.mark("tab_needs_setup", { tabId, details: { reason: ev.reason } });
            }

            if (ev.type === "$settings" && tabId) {
              tracker.mark("tab_settings_loaded", {
                tabId,
                details: { workspaceDir: ev.workspaceDir, model: ev.model },
              });
              setTabs((prev) =>
                prev.map((t) => (t.id === tabId ? { ...t, workspaceDir: ev.workspaceDir } : t)),
              );
            }

            // Track each channel's session so the sidebar can dot every session
            // that has a live agent, across all tabs on a workspace.
            if (ev.type === "$session_loaded" && tabId) {
              tracker.mark("session_loaded", {
                tabId,
                details: {
                  name: ev.name,
                  messagesCount: ev.messages.length,
                  resync: Boolean(ev.resync),
                },
              });
              setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, session: ev.name } : t)));
            }

            // Side effect only — the reducer tracks oauthWaiting from the same
            // event (and clears it on $error with an OAuth message / signed-in
            // $settings), so the event still falls through to deliverToTab.
            if (ev.type === "oauth_begin_result") {
              void openUrl(ev.url).catch((err) =>
                recordFrontendFailure("frontend.open_url_failed", err),
              );
            }

            if (ev.type === "gemini_oauth_begin_result") {
              void openUrl(ev.url).catch((err) =>
                recordFrontendFailure("frontend.open_url_failed", err),
              );
            }

            if (ev.type === "opencode_oauth_begin_result") {
              void openUrl(ev.url).catch((err) =>
                recordFrontendFailure("frontend.open_url_failed", err),
              );
            }
            if (ev.type === "mimo_oauth_begin_result") {
              void openUrl(ev.url).catch((err) =>
                recordFrontendFailure("frontend.open_url_failed", err),
              );
            }

            if (ev.type === "$jobs") {
              for (const id of dispatchersRef.current.keys()) {
                deliverToTab(id, { t: "incoming", event: ev });
              }
              return;
            }

            // App-global Ollama catalog — the backend broadcasts it tabId-less
            // (it depends on global config, not on the tab), so it updates
            // shared state here instead of any single tab's reducer.
            if (ev.type === "$ollama_models") {
              setOllamaCatalog((prev) => {
                const keepPrevious = ev.models.length === 0 && Boolean(ev.error);
                return {
                  models: keepPrevious && prev.models.length > 0 ? prev.models : ev.models,
                  visionModels:
                    keepPrevious && prev.visionModels.size > 0
                      ? prev.visionModels
                      : new Set((ev.visionModels ?? []).map((id) => `ollama/${id}`)),
                  error: ev.error ?? null,
                  plan: keepPrevious ? (ev.plan ?? prev.plan) : (ev.plan ?? null),
                  hiddenCount: keepPrevious
                    ? (ev.hiddenCount ?? prev.hiddenCount)
                    : (ev.hiddenCount ?? 0),
                };
              });
              return;
            }

            if (ev.type === "$opencode_models") {
              setOpencodeCatalog({
                models: ev.models,
                visionModels: new Set(ev.visionModels ?? []),
                error: ev.error ?? null,
              });
              return;
            }

            // App-global like $opencode_models: the history belongs to the repo,
            // not to any tab.
            if (ev.type === "$changelog") {
              setChangelog({
                releases: ev.releases,
                version: ev.version,
                error: ev.error ?? null,
                loaded: true,
              });
              return;
            }

            if (ev.type === "$sessions" && tabId) {
              tracker.mark("sessions_list_received", {
                tabId,
                details: { count: ev.items.length, epoch: ev.epoch, revision: ev.revision },
              });
              // The store is the ONLY handler: no channel keeps its own copy, so one
              // snapshot updates every channel of the workspace at once.
              const ws = tabsRef.current.find((t) => t.id === tabId)?.workspaceDir;
              if (ws) {
                const result = applySessionsSnapshot(sessionsStoreRef.current, ws, ev);
                commitSessionsStore(result.store, result.changed);
                // A hide the daemon never settled: ask for the authoritative list
                // once rather than keep a row hidden forever.
                if (result.escaped.length > 0) requestSessionList(tabId);
              }
              return;
            }

            if (ev.type === "$workspace_initialized" && tabId) {
              tracker.mark("backend_workspace_initialized", {
                tabId,
                details: { revision: ev.revision },
              });
            }

            const target = tabId;
            if (target) {
              flushTabDeltas(target);
              if (ev.type === "$mention_results") {
                deliverToTab(target, {
                  t: "mention_results",
                  results: { nonce: ev.nonce, query: ev.query, results: ev.results },
                });
                return;
              }
              if (ev.type === "$mention_preview") {
                deliverToTab(target, {
                  t: "mention_preview",
                  preview: {
                    nonce: ev.nonce,
                    path: ev.path,
                    head: ev.head,
                    totalLines: ev.totalLines,
                  },
                });
                return;
              }
              deliverToTab(target, { t: "incoming", event: ev });
            }
          } catch (err) {
            recordFrontendFailure("frontend.bad_wire_event", err, {
              payloadChars: e.payload.data.length,
            });
          }
        }),
        listen<{ data: string }>("rpc:stderr", (e) => {
          startupStderrRef.current = [...startupStderrRef.current, e.payload.data].slice(-12);
          setStartupFailure((prev) =>
            prev
              ? coerceStartupFailure(
                  prev.details[0] ?? t("app.startupFailedUnknown"),
                  startupStderrRef.current,
                )
              : prev,
          );
        }),
        listen<{ code: number | null }>("rpc:exit", (e) => {
          tracker.fail("rpc_exit", { code: e.payload.code });
          setBackendConnected(false);
          setLoadingWorkspaces(false);
          for (const tabId of dispatchersRef.current.keys()) flushTabDeltas(tabId);
          if (dispatchersRef.current.size === 0) {
            const exitError = new Error(`reasonix exited (code ${e.payload.code ?? "?"})`);
            recordFrontendFailure("frontend.daemon_exited", exitError, {
              code: e.payload.code,
              stderrLines: startupStderrRef.current.length,
            });
            setStartupFailure(coerceStartupFailure(exitError, startupStderrRef.current));
          }
          for (const dispatch of dispatchersRef.current.values()) {
            dispatch({ t: "rpc_exit", code: e.payload.code });
          }
        }),
      ]);
      if (cancelled) {
        for (const u of subs) u();
        return;
      }
      cleanups.push(...subs);
      try {
        tracker.mark("rpc_spawn_invoked");
        const spawnedFresh = (await invoke<boolean>("rpc_spawn")) === true;
        tracker.mark("rpc_spawn_resolved", { details: { spawnedFresh } });
        // A daemon this call just spawned already wrote every boot event into the
        // listeners registered above, so replaying them would repeat the whole
        // cold start. Only a REUSED daemon (WebView reload, retry) missed them.
        if (!cancelled) {
          tracker.mark("desktop_resync_sent", { details: { replay: !spawnedFresh } });
          await rpcSend(
            spawnedFresh
              ? ({ cmd: "desktop_resync", replay: false } as const)
              : ({ cmd: "desktop_resync" } as const),
          );
          tracker.mark("desktop_resync_acknowledged");
        }
      } catch (err) {
        if (!cancelled) {
          tracker.fail("rpc_spawn_failed", { error: String(err) });
          setLoadingWorkspaces(false);
          setStartupFailure(coerceStartupFailure(err, startupStderrRef.current));
        }
      }
    };
    void setup();
    return () => {
      cancelled = true;
      for (const c of cleanups) c();
    };
  }, [deliverToTab, startupRetryNonce]);

  // Tell the backend which tab is focused so a restart can reopen on it (#1244).
  useEffect(() => {
    if (!activeTabId) return;
    rpcSend({ cmd: "tab_activate", tabId: activeTabId }).catch((err) => {
      recordFrontendFailure("frontend.tab_activate_failed", err, { tabId: activeTabId });
    });
  }, [activeTabId]);

  // Tracks each tab's running-agent flag so the tab dot can show how many
  // agents are active in it. Every mounted TabRuntime reports its own busy.
  const reportTabBusy = useCallback((tabId: string, busy: boolean) => {
    // A tab that stopped running has no live stream — drop its tracker so the
    // next turn can't read a stale window, and with it the per-run subagent
    // totals that fed that window.
    if (!busy) {
      streamRatesRef.current.delete(tabId);
      subagentRatesRef.current.delete(tabId);
    }
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.id !== tabId || t.busy === busy) return t;
        changed = true;
        return { ...t, busy };
      });
      return changed ? next : prev;
    });
  }, [setTabs]);

  // Snapshot the per-tab rate trackers into `sessionRates` (keyed by session
  // name) while any agent is running. Throttled to ~4Hz so the sidebar
  // re-renders at a readable cadence instead of once per delta. When nothing is
  // running the map clears, so the readout disappears along with the dot.
  const anyBusy = tabs.some((t) => t.busy);
  useEffect(() => {
    if (!anyBusy) {
      setSessionRates((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    const tick = () => {
      const now = Date.now();
      const next = new Map<string, number>();
      for (const t of tabsRef.current) {
        const session = runningTabSession(t);
        if (session) next.set(session, streamRatesRef.current.get(t.id)?.tokensPerSecond(now) ?? 0);
      }
      setSessionRates((prev) => {
        if (prev.size !== next.size) return next;
        for (const [k, v] of next) if (prev.get(k) !== v) return next;
        return prev;
      });
    };
    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, [anyBusy]);

  // A sidebar row reads a rate only for the running sessions of its own
  // workspace, so each tab is handed that slice instead of the whole map: a tick
  // that moved another workspace's numbers then leaves this tab's memo() alone.
  const tabRatesRef = useRef(new Map<string, Map<string, number>>());
  const tabRates = useMemo(() => {
    const next = ratesByWorkspace(tabs, sessionRates, tabRatesRef.current);
    tabRatesRef.current = next;
    return next;
  }, [tabs, sessionRates]);

  const openTab = useCallback(() => {
    // New tab — defaults to the local Reasonix+ installation (a fresh group).
    rpcSend({ tabId: activeTabIdRef.current, cmd: "tab_open" }).catch((err) => {
      const target = activeTabIdRef.current || tabsRef.current[0]?.id;
      if (target) {
        deliverToTab(target, {
          t: "push_notice",
          text: `Failed to open new tab: ${messageOf(err)}`,
          severity: "error",
        });
      }
    });
  }, [deliverToTab]);

  const closeTab = useCallback(
    (id: string) => {
      if (groupTabsByWorkspace(tabs).length <= 1) return;
      rpcSend({ cmd: "tab_close", tabId: id }).catch((err) => {
        deliverToTab(id, {
          t: "push_notice",
          text: `Failed to close tab: ${messageOf(err)}`,
          severity: "error",
        });
      });
    },
    [tabs, deliverToTab],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (loadingWorkspaces) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        openTab();
      } else if (mod && (e.key === "w" || e.key === "W") && activeTabId) {
        if (groupTabsByWorkspace(tabs).length <= 1) return;
        e.preventDefault();
        closeTab(activeTabId);
      } else if (mod && e.key === "Tab") {
        const workspaceTabs = workspaceTabRepresentatives(tabs, activeTabId);
        if (workspaceTabs.length <= 1) return;
        e.preventDefault();
        const idx = workspaceTabs.findIndex((tab) => tab.id === activeTabId);
        const next = e.shiftKey
          ? (idx - 1 + workspaceTabs.length) % workspaceTabs.length
          : (idx + 1) % workspaceTabs.length;
        const target = workspaceTabs[next];
        if (target) setActiveTabId(target.id);
      } else if (mod && (e.key === "b" || e.key === "B")) {
        if (e.altKey) {
          e.preventDefault();
          onToggleCtx();
        } else {
          e.preventDefault();
          onToggleSide();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openTab, closeTab, activeTabId, tabs, onToggleCtx, onToggleSide, loadingWorkspaces]);

  const onSetThemeStyle = useCallback(
    (nextStyle: ThemeStyle) => {
      setTabThemes((prev) => {
        const cur = prev[activeTabId];
        if (!cur) return prev;
        const next: TabTheme = { theme: themeForStyle(nextStyle), themeStyle: nextStyle };
        writeTabTheme(localStorage, activeTabId, next);
        return { ...prev, [activeTabId]: next };
      });
    },
    [activeTabId],
  );

  const onToggleCurrency = useCallback(() => {
    setCurrency((c) => {
      const next = c === "CNY" ? "USD" : "CNY";
      localStorage.setItem("reasonix.currency", next);
      window.dispatchEvent(new CustomEvent("reasonix:currency", { detail: next }));
      return next;
    });
  }, []);

  const onRemoveWorkspace = useCallback(
    (path: string) => {
      // Forgetting a workspace closes every tab on it, so it cannot run while any
      // channel is mid-mutation: read the shared store, not one channel's flag.
      if (hasOpenSessionIntent(sessionsStoreRef.current)) {
        const target = activeTabIdRef.current || tabsRef.current[0]?.id;
        if (target) {
          deliverToTab(target, {
            t: "push_notice",
            text: t("app.workspaceBusyNotice"),
            severity: "warning",
          });
        }
        return;
      }
      for (const d of dispatchersRef.current.values()) {
        d({ t: "workspace_recent_removed", path });
      }
      rpcSend({ cmd: "workspace_recent_remove", path }).catch((err) =>
        recordFrontendFailure("frontend.workspace_forget_failed", err),
      );
    },
    [deliverToTab],
  );

  if (startupFailure && tabs.length === 0) {
    return <StartupFailure details={startupFailure.details} onRetry={retryStartup} />;
  }

  return (
    <>
      {loadingWorkspaces ? <StartupLoadingOverlay /> : null}
      {tabs.map((t) => (
        <TabRuntime
          key={t.id}
          tabId={t.id}
          active={t.id === activeTabId}
          keepAlive={t.id === previousActiveTabId}
          backendConnected={backendConnected}
          currency={currency}
          registerDispatch={registerDispatch}
          sessionView={sessionViewFor(t.workspaceDir)}
          onSessionIntent={beginSessionIntent}
          onSessionPatch={patchSessionRow}
          onWorkspaceInitialized={markWorkspaceInitialized}
          onNewTab={openTab}
          onBusyChange={reportTabBusy}
          sessionRates={tabRates.get(normalizeWorkspacePath(t.workspaceDir)) ?? EMPTY_SESSION_RATES}
          theme={tabThemes[t.id]?.theme ?? DEFAULT_TAB_THEME.theme}
          themeStyle={tabThemes[t.id]?.themeStyle ?? DEFAULT_TAB_THEME.themeStyle}
          onSetThemeStyle={onSetThemeStyle}
          fontScale={fontScale}
          onSetFontScale={setFontScale}
          fontFamily={fontFamily}
          onSetFontFamily={setFontFamily}
          customFontFamily={customFontFamily}
          onSetCustomFontFamily={setCustomFontFamily}
          sideCollapsed={sideCollapsed}
          ctxCollapsed={ctxCollapsed}
          sideWidth={sideWidth}
          ctxWidth={ctxWidth}
          threadMaxWidth={threadMaxWidth}
          onSideResizeDown={onSideResizeDown}
          onCtxResizeDown={onCtxResizeDown}
          onToggleSide={onToggleSide}
          onToggleCtx={onToggleCtx}
          onToggleCurrency={onToggleCurrency}
          ollamaModels={ollamaCatalog.models}
          ollamaModelsError={ollamaCatalog.error}
          ollamaPlan={ollamaCatalog.plan}
          ollamaHiddenCount={ollamaCatalog.hiddenCount}
          ollamaVisionModels={ollamaCatalog.visionModels}
          onRefreshOllamaModels={requestOllamaModels}
          onRefreshAntigravityModels={requestAntigravityModels}
          opencodeModels={opencodeCatalog.models}
          opencodeModelsError={opencodeCatalog.error}
          opencodeVisionModels={opencodeCatalog.visionModels}
          onRefreshOpencodeModels={requestOpencodeModels}
          changelog={changelog}
          onRefreshChangelog={requestChangelog}
          tabsList={tabs}
          activeTabId={activeTabId}
          setActiveTabId={setActiveTabId}
          onRemoveWorkspace={onRemoveWorkspace}
        />
      ))}
      {pendingUpdate ? (
        <UpdateOverlay
          version={pendingUpdate.version}
          currentVersion={pendingUpdate.currentVersion}
          status={updateStatus}
          progress={updateProgress}
          onInstall={installUpdate}
          onDismiss={() => setPendingUpdate(null)}
        />
      ) : null}
    </>
  );
}
