/** Wire protocol shared by the desktop daemon (src/cli/commands/desktop.ts)
 *  and the Tauri React shell (desktop/src/protocol.ts). Both bundles import
 *  these shapes from here so a field change can't silently drift between the
 *  two sides of the JSON-RPC bridge. */

import type { ApprovalPrompt } from "./approval-prompt.js";
import type { ChangelogRelease } from "./changelog.js";
import type { ChoiceOption, PlanStep, ReasoningEffort } from "./permission-types.js";
import type { PlaywrightManagedBrowser } from "./playwright-browsers.js";
import type {
  ProviderID,
  ProviderProbeStrategy,
  ProviderUsageWindowLabel,
} from "./provider-registry.js";
import type { SearchEngineID } from "./search-engines.generated.js";

/** Trust dial: 3 settings, not 4.
 *  - `read-only`  : no writes, no shell (registry plan-mode blocks mutating tools).
 *  - `follow`     : reads + allowlisted shell auto; every write and every
 *                   non-allowlisted command asks the user first.
 *  - `never-ask`  : shell, paths and checkpoints run with no prompt; plan and
 *                   choice cards still appear but auto-advance on their timer,
 *                   and Outlook sends alone always wait for the user.
 *  Legacy persisted values migrate in loadEditMode: plan->read-only,
 *  review/auto->follow, yolo/ignore->never-ask. */
export type EditMode = "read-only" | "follow" | "never-ask";

/** A composer "quick send" — a one-click action that sends a message to the
 *  model. `message` is the full text sent via user_input; `shorthand` is the
 *  short form shown in the chat when the message is long. */
export interface QuickSend {
  id: string;
  label?: string;
  message: string;
  shorthand: string;
}

/** Maximum character length allowed for a quick send button shorthand. */
export const QUICK_SEND_SHORTHAND_MAX_LENGTH = 20;

/** Clamp and normalize shorthand text to ensure it fits comfortably in the composer button. */
export function enforceQuickSendShorthand(raw: string): string {
  return raw.trim().slice(0, QUICK_SEND_SHORTHAND_MAX_LENGTH);
}

/** Built-in quick sends — always available; the active one is selected in
 *  Settings → General and defaults to Proceed. */
export const BUILTIN_QUICK_SENDS: readonly QuickSend[] = [
  { id: "proceed", message: "proceed", shorthand: "proceed" },
  {
    id: "commit-and-push",
    message: "commit and push all changes",
    shorthand: "commit and push",
  },
];

export function isQuickSend(v: unknown): v is QuickSend {
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  return (
    typeof q.id === "string" &&
    typeof q.message === "string" &&
    (typeof q.shorthand === "string" || typeof q.label === "string")
  );
}

/** Built-ins plus user-defined customs — the full set of selectable quick sends.
 *  De-duplicated by id (first wins) so a hand-edited config can't produce two
 *  rows that collide as render keys or fire the same action twice. */
export function allQuickSends(customs: readonly QuickSend[]): QuickSend[] {
  const seen = new Set<string>();
  const out: QuickSend[] = [];
  for (const q of [...BUILTIN_QUICK_SENDS, ...customs]) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    out.push({
      id: q.id,
      shorthand: enforceQuickSendShorthand(q.shorthand || q.label || ""),
      message: q.message,
    });
  }
  return out;
}

/** A new custom quick-send id, unique against the sends already configured:
 *  `allQuickSends` de-dupes by id, so a second add inside one millisecond would
 *  otherwise be dropped silently and the new row would never appear. */
export function createQuickSendId(existing: readonly QuickSend[]): string {
  const taken = new Set(existing.map((q) => q.id));
  const base = `custom-${Date.now()}`;
  if (!taken.has(base)) return base;
  let suffix = 1;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** The active quick send by id, falling back to Proceed when unknown/absent. */
export function resolveActiveQuickSend(
  id: string | undefined,
  customs: readonly QuickSend[],
): QuickSend {
  const found = allQuickSends(customs).find((q) => q.id === id) ?? BUILTIN_QUICK_SENDS[0]!;
  return {
    ...found,
    shorthand: enforceQuickSendShorthand(found.shorthand),
  };
}

/** Every supported web-search backend, generated from search-engines/*.json, so the
 *  runtime list and the union type can never drift. Re-exported under the protocol's
 *  historical name. */
export { SEARCH_ENGINE_NAMES as WEB_SEARCH_ENGINE_NAMES } from "./search-engines.generated.js";

export type WebSearchEngineName = SearchEngineID;

export interface OllamaGenerationSettings {
  temperature?: number;
  topP?: number;
  minP?: number;
  seed?: number;
  keepAlive: string;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  topK?: number;
  repeatLastN?: number;
}

export type OllamaGenerationPatch = {
  [K in keyof OllamaGenerationSettings]?: OllamaGenerationSettings[K] | null;
};

/** Per-field visibility toggles for the bottom status row — shared by the wire
 *  settings payload and the persisted config so the field lists cannot drift. */
export interface StatusBarToggles {
  showBalance?: boolean;
  showCacheHit?: boolean;
  showCtxUsage?: boolean;
  showVersion?: boolean;
  showFeedbackHint?: boolean;
}

// ---- events ----

export type ConnectedEvent = { type: "$connected" };
export type ReadyEvent = { type: "$ready" };
export type ProtocolErrorEvent = { type: "$error"; message: string };
/** Outcome of a Settings-owned action (install, uninstall, MCP spec edit). Shown as a
 *  transient popover over the shell: the Settings page asked, so the chat transcript
 *  must not receive the answer. */
export type ToastEvent = { type: "$toast"; text: string; severity: NoticeSeverity };
/** Terminal outcome of a turn. Drives whether the desktop shows success feedback
 *  or an explanatory stop card. */
export type TurnOutcome = "success" | "stopped" | "failed" | "aborted";
export type TurnCompleteEvent = {
  type: "$turn_complete";
  /** Absent on older sidecars — the desktop treats an absent outcome as success. */
  outcome?: TurnOutcome;
  /** Turn the outcome describes, when the daemon knows it. */
  turn?: number;
  /** Human-readable reason a non-success turn ended without an answer. */
  reason?: string;
};

/** Daemon-authoritative ON signal for the UI busy flag: emitted when a turn
 *  actually begins (after the aborter is minted), including queued second
 *  turns. The desktop's optimistic send spin waits for this instead of
 *  assuming the turn started. */
export type TurnStartedEvent = {
  type: "$turn_started";
  /** Turn the daemon assigned to the acknowledged input, when known. */
  turn?: number;
  /** Echo of the sender's optimistic-message id for bubble reconciliation. */
  clientId?: string;
};

/** Daemon-authoritative snapshot of one tab's live turn state — the reply to
 *  the `tab_status` pull command. Lets the desktop detect drift between its
 *  optimistic busy flag and reality instead of guessing from event timing. */
export type TabStatusEvent = {
  type: "$tab_status";
  /** True while a turn holds the tab (aborter minted or turn promise pending). */
  busy: boolean;
  /** Turn number the running (or most recent) turn is on, when known. */
  turn?: number;
  /** Number of sends the daemon is holding behind the active turn. Above zero is
   *  also the ack for a send that arrived mid-turn: the desktop clears its
   *  optimistic ack gate instead of timing the send out as lost. */
  queued: number;
  /** Manual compaction in progress. */
  compacting: boolean;
  /** Session switch in progress (stale-event suppression active). */
  switching: boolean;
};

/** Common envelope for kernel events forwarded directly to desktop clients. */
export interface KernelWireEventBase {
  id: number;
  ts: string;
  turn: number;
}

export interface KernelUserMessageEvent extends KernelWireEventBase {
  type: "user.message";
  text: string;
  /** Echo of the sender's optimistic-message id — lets the desktop reconcile
   *  its bubble with the daemon-assigned turn instead of appending a duplicate. */
  clientId?: string;
}

export interface KernelModelTurnStartedEvent extends KernelWireEventBase {
  type: "model.turn.started";
  model: string;
  reasoningEffort: ReasoningEffort;
  prefixHash: string;
}

export interface KernelModelDeltaEvent extends KernelWireEventBase {
  type: "model.delta";
  channel: "content" | "reasoning" | "tool_args";
  text: string;
}

export interface KernelUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface KernelWireToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface KernelModelFinalEvent extends KernelWireEventBase {
  type: "model.final";
  content: string;
  reasoningContent?: string;
  replaceStreamedOutput?: boolean;
  toolCalls: ReadonlyArray<KernelWireToolCall>;
  usage: KernelUsage;
  forcedSummary?: boolean;
  image?: { dataUrl: string; mimeType: string };
}

export interface KernelToolPreparingEvent extends KernelWireEventBase {
  type: "tool.preparing";
  callId: string;
  name: string;
}

export interface KernelToolIntentEvent extends KernelWireEventBase {
  type: "tool.intent";
  callId: string;
  name: string;
  args: string;
}

export interface KernelToolResultEvent extends KernelWireEventBase {
  type: "tool.result";
  callId: string;
  ok: boolean;
  output: string;
}

export interface KernelToolOutputEvent extends KernelWireEventBase {
  type: "tool.output";
  callId: string;
  name: string;
  text: string;
}

export interface KernelSubagentProgressEvent extends KernelWireEventBase {
  type: "subagent.progress";
  runId: string;
  parentCallId?: string;
  /** Size of the dispatch wave the spawn ran in: >1 means it shared the wave with other
   *  calls (parallel), 1 means nothing overlapped it (sequential). Absent when unknown. */
  waveSize?: number;
  action: "start" | "phase" | "stream" | "tool-start" | "tool-end" | "end";
  task: string;
  skillName?: string;
  model?: string;
  phase?: "exploring" | "summarising";
  iter?: number;
  elapsedMs?: number;
  contextTokens?: number;
  /** Context cap the child loop enforces (resolveContextTokens of the child model). Meter denominator. */
  contextMax?: number;
  outputChars?: number;
  reasoningChars?: number;
  toolReadChars?: number;
  thought?: string;
  childCallId?: string;
  toolName?: string;
  toolArgs?: string;
  toolOk?: boolean;
  error?: string;
  turns?: number;
}

/** Machine-readable phase tag on a `status` event (mirror of src/loop StatusCode).
 *  Clients render their own copy for a tag they know and fall back to `text`
 *  otherwise, so a daemon wording change never leaks into a localized client. */
export type KernelStatusCode = "tool-upload" | "model-retry" | "rate-limit";

export interface KernelStatusEvent extends KernelWireEventBase {
  type: "status";
  text: string;
  /** Absent on untagged statuses — treat those as "something moved", nothing more. */
  code?: KernelStatusCode;
  /** 1-based attempt the next request will be, for `model-retry`. */
  attempt?: number;
  /** How long the daemon waits before that attempt, for `model-retry` / `rate-limit`. */
  waitMs?: number;
}

export interface KernelWarningEvent extends KernelWireEventBase {
  type: "warning";
  text: string;
  severity: "low" | "high";
  /** Machine-readable trigger tag (mirror of src/loop WarningCause) so clients
   *  can key feedback cues off the trigger instead of matching message text. */
  cause?: "repetition-guard" | "iteration-budget" | "empty-response" | "thinking-only";
  /** Compaction completion warning: the prefix-stripped summary body the fold
   *  installed, so the card can show the actual compacted context alongside the
   *  terse `text` header. Absent for non-compaction warnings. */
  compactionSummary?: string;
}

export interface KernelErrorEvent extends KernelWireEventBase {
  type: "error";
  message: string;
  recoverable: boolean;
}

/** Compaction is running (pre-turn auto, mid-turn overflow recovery, or a manual
 *  "Compact now") — the UI shows the compaction card's throbber until the run's
 *  completion signal flips the card to its done state. */
export interface KernelCompactionStartedEvent extends KernelWireEventBase {
  type: "compaction.started";
  trigger: "manual" | "auto" | "overflow";
}

export type DirectKernelWireEvent =
  | KernelUserMessageEvent
  | KernelModelTurnStartedEvent
  | KernelModelDeltaEvent
  | KernelModelFinalEvent
  | KernelToolPreparingEvent
  | KernelToolIntentEvent
  | KernelToolResultEvent
  | KernelToolOutputEvent
  | KernelSubagentProgressEvent
  | KernelStatusEvent
  | KernelWarningEvent
  | KernelErrorEvent
  | KernelCompactionStartedEvent;

export type DesktopDiagnosticLevel = "debug" | "info" | "warn" | "error";

/** Structured daemon diagnostics delivered to the Tauri WebView console.
 *  Details must be redacted and must never contain credentials or message bodies. */
export interface DesktopDiagnosticEvent {
  type: "$diagnostic";
  ts: string;
  source: "daemon";
  level: DesktopDiagnosticLevel;
  event: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ConfirmRequiredEvent {
  type: "$confirm_required";
  id: number;
  kind: "run_command" | "run_background" | "outlook_send";
  command: string;
  prompt?: ApprovalPrompt;
}

export interface PathAccessRequiredEvent {
  type: "$path_access_required";
  id: number;
  path: string;
  intent: "read" | "write";
  toolName: string;
  sandboxRoot: string;
  allowPrefix: string;
  prompt?: ApprovalPrompt;
}

/** Follow Rules mode opened a write confirmation for an in-sandbox edit. */
export interface EditRequiredEvent {
  type: "$edit_required";
  id: number;
  path: string;
  toolName: string;
  sandboxRoot: string;
  allowPrefix: string;
  preview?: string;
  prompt?: ApprovalPrompt;
}

/** Never Ask override window shared by every picker gate: the card shows a
 *  countdown and its first option wins at expiry. One type so the three pickers
 *  cannot drift apart again. */
export interface PickerWindow {
  countdownMs?: number;
}

export interface ChoiceRequiredEvent extends PickerWindow {
  type: "$choice_required";
  id: number;
  question: string;
  options: ChoiceOption[];
  allowCustom: boolean;
}

export interface PlanRequiredEvent extends PickerWindow {
  type: "$plan_required";
  id: number;
  plan: string;
  steps?: unknown[];
  summary?: string;
  /** Stable submit_plan tool call that anchors live progress in the chat timeline. */
  callId?: string;
}

export interface CheckpointRequiredEvent {
  type: "$checkpoint_required";
  id: number;
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
  completed: number;
  total: number;
}

export interface RevisionRequiredEvent extends PickerWindow {
  type: "$revision_required";
  id: number;
  reason: string;
  remainingSteps: PlanStep[];
  /** The plan's current remaining steps, so the card can diff the rewrite against it. */
  previousSteps?: PlanStep[];
  summary?: string;
}

export interface StepCompletedEvent {
  type: "$step_completed";
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
}

export interface PlanHistoryItem {
  id: string;
  status: string;
  createdAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  summary?: string;
  totalSteps: number;
  completedSteps: number;
  dispositionReason?: string;
  /** The session that owns this plan. Absent for a plan no session has claimed,
   *  so a surface can say "no owning session" instead of guessing one. */
  ownerSession?: string;
}
export interface PlanDetail {
  id: string;
  status: string;
  createdAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  body: string;
  summary?: string;
  steps: PlanStep[];
  completions: Record<
    string,
    {
      stepId: string;
      result: string;
      notes?: string;
      evidence?: Array<{ kind: string; summary: string; command?: string; paths?: string[] }>;
    }
  >;
  revisions: Array<{ at: string; reason: string; steps: PlanStep[] }>;
  dispositionReason?: string;
}
export type PlanHistoryEvent = {
  type: "$plan_history";
  sessionName: string;
  items: PlanHistoryItem[];
};
export type PlanDetailEvent = { type: "$plan_detail"; sessionName: string; plan: PlanDetail };
export type PlanClearedEvent = { type: "$plan_cleared" };

/** Hydrate the client's active plan from persisted disk state on session load /
 *  WebView reload — mirrors the $plan_required/step_completed shape so the
 *  ContextPanel and rail can rebuild the plan without a live turn. */
export interface PlanRestoredEvent {
  type: "$plan_restored";
  /** Markdown body; empty string for a pure-structured plan. */
  plan: string;
  summary?: string;
  steps: PlanStep[];
  completedStepIds: string[];
  /** Per-step results keyed by step id, from persisted step completions. */
  stepResults?: Record<string, string>;
  /** A finished plan is archived instead of restored, so this is always "active". */
  status?: "active" | "finished";
}

/** One mutation request's outcome, published on the snapshot the daemon emitted because
 *  of it. The client settles its optimistic state ONLY on the answer to its own id. */
export interface SessionMutationAnswer {
  requestId: string;
  /** Create only, and only on success: the session this request minted. */
  created?: string;
}

export interface SessionsEvent {
  type: "$sessions";
  workspaceDir?: string;
  /** Identifies the daemon lifetime that produced this snapshot. Shared by every
   *  channel of every workspace, so an epoch change means the daemon restarted. */
  epoch: string;
  /** Monotonic per-workspace snapshot revision, stamped when the scan is requested.
   *  Older async results must be ignored. */
  revision: number;
  /** A paint from the persisted index cache rather than a scan. It may only
   *  initialise a workspace the client has never listed, and never advances
   *  `revision`, so a cache read can never outrank a settled snapshot. */
  primed?: boolean;
  /** The scan failed and these rows are the last list the daemon knows. They settle
   *  answers like any snapshot, but nothing in them was re-verified against the store. */
  stale?: boolean;
  /** The requests whose outcome this snapshot publishes. This is the ONLY thing that
   *  settles a delete, clear or create the client asked for: a listing that merely
   *  omits or still holds a hidden name is some other request's truth, never this one's. */
  answers?: SessionMutationAnswer[];
  items: {
    name: string;
    messageCount: number;
    mtime: string;
    /** Explicit last-activity epoch-ms from the session's meta — drives the
     *  sidebar's relative-time label so it survives file copies/restores that
     *  reset filesystem timestamps. */
    updatedAt?: number;
    /** Creation epoch-ms (meta.createdAt, else the name-embedded timestamp) —
     *  the sidebar sorts on this (falling back to mtime). */
    createdAt?: number;
    summary?: string;
    workspaceStatus?: "matched" | "legacy_missing_meta";
  }[];
}

export interface MentionResultsEvent {
  type: "$mention_results";
  nonce: number;
  query: string;
  results: string[];
}

export interface MentionPreviewEvent {
  type: "$mention_preview";
  nonce: number;
  path: string;
  head: string;
  totalLines: number;
}

export interface TabOpenedEvent {
  type: "$tab_opened";
  workspaceDir: string;
  /** True when the frontend should focus this session channel. */
  active?: boolean;
  /** Compatibility snapshot for this channel; currently contains its one session. */
  sessions?: string[];
  /** Visual workspace-tab identity shared by all of its session channels. */
  groupId?: string;
  /** Session owned by this channel. */
  activeSession?: string;
}

/** One backend session channel closed. A tab_close command emits this once for
 *  every channel in the addressed visual workspace tab. */
export type TabClosedEvent = { type: "$tab_closed" };

export interface WorkspaceInitializedEvent {
  type: "$workspace_initialized";
  revision: number;
}

/** Authoritative tab list, emitted at the END of a `desktop_resync`. The
 *  frontend replaces its tab set with this snapshot — stale tabs left over
 *  from an older backend generation (id reuse across restarts) get pruned
 *  instead of living on as ghosts that route events to the wrong tab. */
export interface TabsSnapshotEvent {
  type: "$tabs_snapshot";
  tabs: {
    id: string;
    workspaceDir: string;
    active: boolean;
    /** Compatibility snapshot for this channel; currently contains one session. */
    sessions?: string[];
    /** Visual workspace-tab identity shared by sibling channels. */
    groupId?: string;
    /** Session owned by this channel. */
    activeSession?: string;
  }[];
}

export type McpSpecStatus = "configured" | "handshake" | "connected" | "failed" | "disabled";

/** Browser sign-in state of one HTTP/SSE MCP server, read from the token store. */
export type McpAuthState = "none" | "connected" | "expired";

export interface McpSpecInfo {
  raw: string;
  name: string | null;
  transport: "stdio" | "sse" | "streamable-http";
  summary: string;
  parseError?: string;
  status: McpSpecStatus;
  statusReason?: string;
  toolCount?: number;
  /** Server-level DEFAULT from config (Settings) — true while disabled, even before first bridge. */
  disabled?: boolean;
  /** THIS session's server-level disable, frozen at chat creation. Absent = follow the default. */
  sessionDisabled?: boolean;
  /** Reasonix+-managed server (currently Playwright) — disableable and
   *  reconfigureable through its card, but never removable from the list. */
  builtin?: boolean;
  /** Slug of the plugin that bundles this server. Absent = standalone entry, so the
   *  list can tell the two apart and point the user at the plugin that owns it. */
  plugin?: string;
  /** Sign-in state of an HTTP/SSE server, read from the token store. Absent for stdio. */
  auth?: McpAuthState;
}

export interface McpSpecsEvent {
  type: "$mcp_specs";
  specs: McpSpecInfo[];
  bridged: boolean;
}

/** One workflow file a plugin ships — the prompt index the agent reads on demand. */
export interface PluginSkillInfo {
  name: string;
  /** First sentence of the SKILL.md description. */
  description: string;
  /** SKILL.md path relative to the plugin directory. */
  path: string;
  /** Directory holding this skill, relative to the plugin directory and forward-slashed;
   *  empty for a skill sitting at the plugin root. Settings groups skills by it. */
  root: string;
}

/** One MCP server a plugin declared, with its live bridge state. */
export interface PluginServerInfo {
  name: string;
  transport: McpSpecInfo["transport"];
  status: McpSpecStatus;
  statusReason?: string;
  toolCount?: number;
  /** True while this chat did not enable the plugin, or the server entry itself is off. */
  disabled?: boolean;
  /** Sign-in state of an HTTP/SSE server, read from the token store. Absent for stdio. */
  auth?: McpAuthState;
}

/** One installed agent plugin (Codex `.codex-plugin` layout). */
export interface PluginInfo {
  /** Directory key and config record key. */
  slug: string;
  name: string;
  /** Manifest display name, falling back to `name`. */
  displayName: string;
  /** Manifest category, falling back to "Plugins". */
  category: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  capabilities: string[];
  defaultPrompt: string[];
  /** Install source as recorded (git URL or local path). */
  source?: string;
  /** True when THIS chat froze the plugin at its session-start confirm. Read-only here:
   *  the card's Enable/Disable edits the default for later chats instead. */
  active: boolean;
  /** Settings default, edited by the card's Enable/Disable control: true switches the
   *  plugin off for chats created from now on. A chat's frozen set still decides. */
  disabled?: boolean;
  /** Manifest read failure; the card still renders so the plugin can be removed. */
  error?: string;
  skills: PluginSkillInfo[];
  servers: PluginServerInfo[];
}

export interface PluginsEvent {
  type: "$plugins";
  plugins: PluginInfo[];
}

/** One installed standalone skill (`~/.reasonix/skills/<id>/SKILL.md`). Skills a plugin
 *  ships are listed inside `PluginInfo.skills` instead: they cannot be switched on
 *  without their plugin. */
export interface SkillInfo {
  /** Directory key under the skills root — the value a session freezes. */
  id: string;
  /** Declared name, falling back to the id. */
  name: string;
  description: string;
  /** Absolute path to its SKILL.md. */
  path: string;
  /** True when THIS chat froze the skill at its session-start confirm. Read-only:
   *  enablement is chosen there, never from the settings page. */
  active: boolean;
  /** Read failure; the card still renders so the skill can be removed. */
  error?: string;
}

export interface SkillsEvent {
  type: "$skills";
  skills: SkillInfo[];
}

/** One configured MCP server offered in the fresh-chat setup picker — `enabled`
 *  is the pre-filled state: the Settings default for a new chat, or the source
 *  session's frozen set for a duplicate. */
export interface McpSetupServer {
  name: string;
  enabled: boolean;
  builtin: boolean;
}

/** One installed plugin offered in the same picker. Plugin enablement is a session
 *  capability like the MCP set: chosen once at chat start and frozen in the session
 *  meta, because flipping it mid-chat would rewrite the cached prompt prefix. */
export interface PluginSetupEntry {
  /** Plugin slug — the value the confirm freezes. */
  name: string;
  displayName: string;
  /** Pre-filled state: the Settings default for a new chat, or the source session's
   *  frozen set for a duplicate. */
  enabled: boolean;
}

/** One installed standalone skill offered in the same picker. Plugin skills are never
 *  offered here: enabling the plugin is what brings them, so the picker cannot grow one
 *  row per skill a plugin ships. */
export interface SkillSetupEntry {
  /** Skill id — the value the confirm freezes. */
  name: string;
  /** One-line summary, so the row can say what the skill is for. */
  description?: string;
  /** Pre-filled state: on for a new chat, the source session's set for a duplicate. */
  enabled: boolean;
}

/** Session-start setup prompt: the capabilities a fresh chat must confirm before it
 *  can run. The MCP set, the plugin set, the standalone skill set and the subagent flag
 *  are all frozen by that one answer. A new chat and a duplicated session both get this
 *  prompt. */
export interface McpSetupEvent {
  type: "$mcp_setup";
  servers: McpSetupServer[];
  /** Installed plugins, pre-filled for this chat. Their skills and MCP servers arrive
   *  with them, so they get no rows of their own. */
  plugins: PluginSetupEntry[];
  /** Installed standalone skills, pre-filled for this chat. */
  skills: SkillSetupEntry[];
  /** Pre-filled subagent flag: off for a new chat, inherited from the source session
   *  when the chat was opened by duplicating one. */
  subagents: boolean;
}

/** What the capability dialog answers: exactly the four sections it shows. One shape for
 *  both askers (the session-start gate and Duplicate), so a new capability cannot be
 *  wired into one and forgotten in the other. Plugin skills and plugin servers are never
 *  listed: they arrive with the plugin slug. */
export interface CapabilityChoice {
  /** Names of the MCP servers this chat may use. */
  servers: string[];
  plugins: string[];
  skills: string[];
  subagents: boolean;
}

/** Managed Playwright browser modes live in their own leaf module so the search
 *  registry can read them without depending on this protocol. */
export {
  PLAYWRIGHT_MANAGED_BROWSERS,
  type PlaywrightManagedBrowser,
} from "./playwright-browsers.js";

/** Extension relay targets: the Playwright Extension is Chromium-only, so the
 *  card chooses between Chrome (the default) and Edge. */
export type PlaywrightExtensionBrowser = "chrome" | "msedge";

export type PlaywrightMcpConnectionMode = PlaywrightManagedBrowser | "extension" | "cdp";

export interface McpExtensionServerState {
  configured: boolean;
  mode: PlaywrightMcpConnectionMode;
  hasExtensionArg: boolean;
  cdpEndpoint?: string;
  /** Browser the extension relay targets when mode is "extension" (defaults to chrome). */
  extensionBrowser?: PlaywrightExtensionBrowser;
  /** Redacted relay-token identifier for saved-state UI; never contains the full token. */
  tokenPrefix?: string;
  args: string[];
}

/** Install state of one managed browser mode: a completed Playwright download, an
 *  absent one, or a vendor-installed channel that is never downloaded by us. */
export interface PlaywrightManagedBrowserInstallState {
  browser: PlaywrightManagedBrowser;
  state: "installed" | "missing" | "system";
}

export interface McpExtensionStatus {
  storeUrl: string;
  server: McpExtensionServerState;
  /** Every managed mode with its install state, so a picker can gate unselectable modes. */
  installs: PlaywrightManagedBrowserInstallState[];
}

export interface McpExtensionStatusEvent {
  type: "$mcp_extension_status";
  status: McpExtensionStatus;
}

/** Live relay probe — "running" fires when the probe starts, "done" carries the
 *  verdict: whether a browser actually attached through the stored token. */
export type McpExtensionCheck =
  | { phase: "running" }
  | { phase: "done"; ok: boolean; reason: string | null; elapsedMs: number };

export interface McpExtensionCheckEvent {
  type: "$mcp_extension_check";
  check: McpExtensionCheck;
}

export enum MailProvider {
  Outlook = "outlook",
  Gmail = "gmail",
}

export type MailAuthPhase =
  | "unconfigured"
  | "disconnected"
  | "checking"
  | "starting"
  | "device-code"
  | "browser"
  | "verifying"
  | "connected"
  | "error";

/** Sanitized mail auth state. OAuth credentials never cross the desktop wire protocol. */
export interface MailAuthState {
  provider: MailProvider;
  configured: boolean;
  phase: MailAuthPhase;
  account?: string;
  verificationUrl?: string;
  userCode?: string;
  callbackUrl?: string;
  hasClientId?: boolean;
  hasClientSecret?: boolean;
  message?: string;
}

export interface MailAuthEvent {
  type: "$mail_auth";
  state: MailAuthState;
}

export type McpAuthPhase = "starting" | "browser" | "connected" | "disconnected" | "error";

/** Sanitized MCP sign-in state. Tokens never cross the desktop wire protocol. */
export interface McpAuthStatus {
  /** Server name the sign-in belongs to (the config entry key). */
  name: string;
  phase: McpAuthPhase;
  /** Set while the browser is open: the authorize URL the UI offers. */
  verificationUrl?: string;
  message?: string;
}

export interface McpAuthEvent {
  type: "$mcp_auth";
  auth: McpAuthStatus;
}

export type PlaywrightBrowserInstall =
  | {
      phase: "running";
      browser: PlaywrightManagedBrowser;
      source: "official" | "backup";
      downloadedBytes?: number;
      totalBytes?: number;
      percent?: number;
      bytesPerSecond?: number;
    }
  | {
      phase: "done";
      browser: PlaywrightManagedBrowser;
      ok: boolean;
      reason: string | null;
    };

export interface PlaywrightBrowserInstallEvent {
  type: "$playwright_browser_install";
  install: PlaywrightBrowserInstall;
}

/** What the prompt spends on memory, per layer scope. The high-priority block is its own
 *  scope because one entry's constraint can override the rest of the stack. */
export interface CtxMemoryTokens {
  global: number;
  project: number;
  priority: number;
}

export interface CtxBreakdownEvent {
  type: "$ctx_breakdown";
  reservedTokens: number;
  /** Part of `reservedTokens` the `# Skills` index occupies. */
  skillTokens?: number;
  /** Part of `reservedTokens` the tool specs occupy. */
  toolTokens?: number;
  /** Part of `reservedTokens` the memory blocks occupy, split by the scope that owns each. */
  memoryTokens?: CtxMemoryTokens;
  /** Current log token count (real-time). */
  logTokens?: number;
  /** Model context cap — denominator for the meter. */
  ctxMax?: number;
  /** Cumulative cross-session shell-output filtering totals (summarizeCommandOutputMetrics):
   *  tokens the filters removed from command output before it reached the model. Omitted
   *  when telemetry is absent or the summary is unavailable — the UI shows no chip. */
  shellOutputRawTokens?: number;
  shellOutputShownTokens?: number;
}

export type MemoryEntryKind = "project_file" | "global_file" | "structured";

/** Structured-memory fidelity fields: the single source of truth for the unions
 *  the read models, the write command, and the desktop edit form all share. */
export type MemoryPriority = "low" | "medium" | "high";
export type MemoryExpires = "project_end";

/** Optional `memory_write` fields; also the desktop edit form's extras. */
export interface MemoryWriteOptions {
  type?: string;
  priority?: MemoryPriority;
  expires?: MemoryExpires;
  /** Browser path of the entry being replaced - set on rename / scope move so the old file is removed after the new write. */
  originalPath?: string;
}

export interface MemoryEntryInfo {
  kind: MemoryEntryKind;
  scope: "project" | "global";
  name: string;
  path: string;
  description: string;
  type?: string;
  priority?: MemoryPriority;
  expires?: MemoryExpires;
}

export type MemoryEntryDetail = MemoryEntryInfo & {
  body: string;
  createdAt?: string;
};

export interface MemoryEvent {
  type: "$memory";
  entries: MemoryEntryInfo[];
}

export interface MemoryDetailEvent {
  type: "$memory_detail";
  detail: MemoryEntryDetail;
}

export interface MemoryResultEvent {
  type: "$memory_result";
  ok: boolean;
  message: string;
}

export type RetryResultEvent = { type: "$retry_result"; text: string };

export type BtwResultEvent = { type: "$btw_result"; question: string; answer: string };

export interface JobInfo {
  id: number;
  tabId: string;
  sessionLabel: string;
  command: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  outputTail: string;
  spawnError?: string;
  /** True for workspace-scoped jobs (the shell `persistent` flag) — they survive
   *  Stop / New chat and end only on workspace/app close or an explicit close. */
  persistent?: boolean;
}

export interface JobsEvent {
  type: "$jobs";
  items: JobInfo[];
}

export type LoadedSegment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; model?: string }
  | { kind: "image"; dataUrl: string; mimeType: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: string;
      result?: string;
      ok?: boolean;
    }
  | { kind: "warning"; id?: string; text: string; severity?: "low" | "high" };

/** Severity of a transcript notice card — shared by the live UI and the
 *  persisted session notices so a restored card keeps its tone. */
export type NoticeSeverity = "info" | "success" | "warning" | "error";

/** A UI annotation card (standalone notice or assistant warning segment) kept
 *  with the session in its notices sidecar — never a model-replay record — and
 *  merged back into the transcript on load so no card is transient. */
export interface PersistedNotice {
  id: string;
  kind: "notice" | "warning";
  text: string;
  /** Notice card tone, or a warning segment's "low" | "high". */
  severity: NoticeSeverity | "low" | "high";
  /** Owning turn (1-based real-user count); 0 = before the first user message. */
  turn: number;
}

/** What kind of thing happened in a session, as the Events tab groups it.
 *  User turns are NOT here: they are read from the transcript records, which
 *  are already stamped and already pruned by a rewind. Everything else is a
 *  gate verdict, a fold, or a subagent spawn, which the transcript has no
 *  durable record of. */
export const SESSION_EVENT_TYPES = ["plan", "choice", "compaction", "subagent"] as const;

/** One of {@link SESSION_EVENT_TYPES}: the runtime list is the single source, so a
 *  new kind cannot be typed without also being accepted by the sidecar guard. */
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/** One recorded session event (a plan verdict, a choice verdict, a fold, a
 *  subagent spawn) kept in the session's UI-events sidecar. Every event carries
 *  the stamp of the moment it happened, so the tab can merge them with the turns
 *  into one timeline. */
export interface SessionEventRecord {
  /** Stable id: the upsert key, so a settle can refine an event it already wrote. */
  id: string;
  type: SessionEventType;
  /** When it happened (epoch ms) — never absent. */
  ts: number;
  /** Owning turn (1-based real-user count); 0 = before the first user message. */
  turn: number;
  /** The verdict or trigger: "approve" | "refine" | "cancel" | "pick" | "text"
   *  for gates, "manual" | "auto" | "overflow" for a fold. */
  outcome: string;
  /** What it was about: the plan title, the chosen option, the fold's summary. */
  label?: string;
  /** Supporting line: the question asked, the feedback left, … */
  detail?: string;
  /** What was on the table when a choice was answered. Without it a verdict
   *  records only the pick, never what the pick was chosen from. */
  options?: readonly string[];
  /** The plan's own text, stored when `label` is only its summary — otherwise the
   *  label already carries it. */
  body?: string;
  /** What came back: a subagent's own answer (or the reason it gave none), read from
   *  the same result envelope its card parses. `detail` says what the child was
   *  asked; without this a row never said what it found. */
  result?: string;
  /** The plan's checklist titles, in order: a verdict that keeps only the title
   *  of the plan loses what was actually agreed to. */
  steps?: readonly string[];
  /** The card this event belongs to in the transcript (`call:<id>` for a
   *  plan/choice gate, `notice:<id>` for a fold), so a jump lands on that card
   *  rather than on the turn's prompt bubble. */
  anchor?: string;
  /** The same card's other address. One tool call carries two ids — the loop's own
   *  (which the persisted log, and so a reloaded transcript, keeps) and the wire's
   *  `tc-…` (which a live transcript renders) — and a row is written while only one
   *  of them is in reach. The jump tries this when `anchor` finds no card. */
  anchorAlias?: string;
}

/** A loaded transcript entry. `ts` is when the record was written (epoch ms),
 *  carried so the UI can place a turn in the conversation's own timeline.
 *  `injected` marks machine-written user records (image tool feedback). */
export type LoadedMessage =
  | { kind: "user"; text: string; images?: string[]; ts?: number; injected?: true }
  | {
      kind: "assistant";
      turn: number;
      segments: LoadedSegment[];
      pending: false;
      ts?: number;
    }
  | {
      kind: "notice";
      id: string;
      text: string;
      severity: NoticeSeverity;
      turn?: number;
      ts?: number;
    };

export interface SessionLoadedEvent {
  type: "$session_loaded";
  name: string;
  messages: LoadedMessage[];
  /** Older history exists beyond this page: the newest window ships first and the
   *  rest is fetched with `session_history_page`. */
  hasOlder?: boolean;
  /** User turns dropped from the front of this page, so turn numbers stay absolute. */
  turnBase?: number;
  carryover: {
    cacheHitTokens: number;
    cacheMissTokens: number;
    totalCompletionTokens: number;
  };
  /** The session's recorded gate/fold events, loaded from its UI-events sidecar
   *  so the Events tab survives a reload. Absent on older sessions. */
  events?: SessionEventRecord[];
  /** Set on `desktop_resync` re-emits — the frontend must not let a resync
   *  echo clobber a live streaming transcript (same session, busy). */
  resync?: boolean;
}

/** The channel's session binding changed WITHOUT a transcript swap. An empty
 *  name is the neutral state: the session it held was deleted, so the channel
 *  holds nothing and the next message creates the session it lands in. */
export interface SessionBoundEvent {
  type: "$session_bound";
  name: string;
}

/** One older page of a session's transcript, requested by `session_history_page`.
 *  `turnBase` is how many user turns precede it, so the frontend numbers the
 *  prepended rows exactly as the live transcript would. */
export interface SessionHistoryEvent {
  type: "$session_history";
  name: string;
  messages: LoadedMessage[];
  hasOlder: boolean;
  turnBase: number;
}

/** A retry, rewind, abort-discard, context edit, or context compaction
 *  replaced the live conversation. The replacement uses the same LoadedMessage
 *  wire shape as session loading, while retaining the edit reason. */
export interface SessionRetractedEvent {
  type: "session.retracted";
  id: number;
  ts: string;
  turn: number;
  kind: "retry" | "rewind" | "abort-discard" | "context-edit" | "compact";
  beforeMessages: number;
  afterMessages: number;
  replacementMessages: LoadedMessage[];
}

export interface SessionEmptyEvent {
  type: "$session_empty";
  name: string;
  sizeBytes: number;
}

export type NeedsSetupEvent = {
  type: "$needs_setup";
  reason: "no_api_key";
  /** Provider-specific copy naming what the picked model is missing. The setup screen
   *  replaces the chat, so without it an unconfigured model is a dead end that never
   *  says which credential to add. */
  message?: string;
};

/** One approval rule, resolved: which mode owns it, what it does, and where it applies. */
export interface RuleRecord {
  mode: "follow" | "never-ask";
  effect: "allow" | "ask" | "deny" | "ignore";
  kind: "shell" | "path";
  scope: "workspace" | "global";
  pattern: string;
  match?: "pattern" | "regex";
}

/** One user-facing trigger the desktop can acknowledge with a sound cue and/or
 *  a system notification. Values persist in config as `feedbackCues` and ride
 *  the wire inside $settings / settings_save. All off by default. */
export type FeedbackCueId = "planComplete" | "guardTriggered" | "inputRequired" | "taskComplete";

/** One toggle + volume entry of the per-type sound/notification matrix. */
export interface FeedbackCueSetting {
  enabled: boolean;
  /** 0..1 playback gain, applied by the WebAudio player. */
  volume: number;
  /** Desktop system notification alongside the cue (input-required types). */
  notify: boolean;
}

export type FeedbackCueSettings = Partial<Record<FeedbackCueId, FeedbackCueSetting>>;

/** Defaults used whenever a cue is missing from persisted config: everything off. */
export const DEFAULT_FEEDBACK_CUES: FeedbackCueSettings = {
  planComplete: { enabled: false, volume: 0.5, notify: false },
  guardTriggered: { enabled: false, volume: 0.5, notify: false },
  inputRequired: { enabled: false, volume: 0.5, notify: false },
  taskComplete: { enabled: false, volume: 0.5, notify: false },
};

export interface SettingsEvent {
  type: "$settings";
  reasoningEffort: ReasoningEffort;
  editMode: EditMode;
  /** Per-type sound/notification cue matrix (Settings → Behavior). Absent = all off. */
  feedbackCues?: FeedbackCueSettings;
  /** Id of the quick send the composer dropdown marks as the default. Optional:
   *  a daemon that predates the persisted default omits it. */
  quickSendId?: string;
  /** User-defined quick sends (built-ins are code-defined). */
  quickSends: QuickSend[];
  /** User-configured context-window cap (tokens); null = per-model default (300K). */
  contextTokens?: number | null;
  /** Range the context slider may state for this tab's model; absent = [128K, 1M]. A
   *  provider that serves its own window (`--ctx-size`) allows smaller values. */
  contextTokensBounds?: { min: number; max: number };
  /** Whether THIS session was minted with the subagent tool — the frozen per-chat
   *  capability. Drives whether the composer offers the subagent model picker at
   *  all: without the tool the choice has no effect. */
  subagents?: boolean;
  /** Whether `run_command` may run commands elevated via Windows UAC. Defaults to false. */
  elevationEnabled?: boolean;
  /** Whether the stream repetition / "stuck re-thinking" guard may abort a
   *  degenerating stream. Defaults to false (opt-in). */
  repetitionGuardEnabled?: boolean;
  /** Whether the conversation auto-compacts before a turn. Defaults to true. */
  autoCompact?: boolean;
  /** Auto-compaction trigger fraction; null = default (0.8). */
  autoCompactTrigger?: number | null;
  questionTimerEnabled?: boolean;
  /** Duplicate-session context budget in tokens (default 50 000); null = default. */
  duplicateSessionTokens?: number | null;
  /** When true, a duplicated session runs one continuation turn; default on (the clone
   *  continues by itself), opt-out for anyone who wants the blob parked. */
  duplicateSessionAutoProceed?: boolean;
  /** The capability rows a clone of THIS chat would start with: its own frozen MCP set
   *  and subagent flag, or the Settings default when the chat has none yet. One
   *  projection (`capabilityPrefill`), so the Duplicate popover cannot drift from what
   *  the clone's session meta freezes. */
  capabilityPrefill?: McpSetupServer[];
  /** Plugin rows for that same popover, from the chat's frozen plugin set. */
  pluginPrefill?: PluginSetupEntry[];
  /** Standalone skill rows for that same popover, from the chat's frozen skill set. */
  skillPrefill?: SkillSetupEntry[];
  baseUrl?: string;
  apiKeyPrefix?: string;
  workspaceDir: string;
  recentWorkspaces: string[];
  /** Local Reasonix+ workspace directory — always offered as a pinned
   *  workspace choice when a new (workspace-less) tab asks for one. */
  reasonixLocalDir?: string;
  model: string;
  /** Set only on the echo that follows a model switch which aborted the running
   *  turn. A failover also repaints `model` mid-turn without ending that turn, so
   *  the desktop may treat a bare model change as a cosmetic update only. */
  turnReleased?: boolean;
  providerCatalogs?: Partial<
    Record<
      ProviderID,
      {
        models: string[];
        source: "live" | "cache" | "fallback";
        error?: string;
      }
    >
  >;
  /** Model ids offered by every model picker (opt-in allow-list — unlisted
   *  models are hidden). Global persistent setting (`enabledModels` in
   *  config.json), edited from Settings → Models. */
  enabledModels?: string[];
  /** Ordered backup models (`fallbackModels` in config.json), edited from
   *  Settings → Backup models. When the active provider reports an exhausted
   *  quota the chat falls over to the first usable entry and continues. */
  fallbackModels?: string[];
  /** Persisted settings for every provider, keyed by the catalog id and then by the
   *  setting keys that provider declares in packages/core-utils/src/providers/*.json.
   *  A secret value is a masked preview, never the stored key. */
  providerSettings?: ProviderSettingsMap;
  webSearchEngine?: WebSearchEngineName;
  /** Every declared engine setting, keyed by engine id and then by the keys that engine
   *  declares in packages/core-utils/src/search-engines/*.json. A secret value is a
   *  masked preview, and an engine that reuses a model provider's key is absent here
   *  because the Models tab owns that field. */
  searchSettings?: SearchSettingsMap;
  /** Per-tab subagent model. Absent = the tab's own model, screened through the configured backup list. */
  subagentModel?: string;
  /** Per-field visibility toggles for the bottom status row. Absent = all default to true. */
  statusBar?: StatusBarToggles;
  /** Effective native Ollama generation values after environment/config/default resolution. */
  ollamaGeneration?: OllamaGenerationSettings;
  /** Explicit persisted values, used to expose per-field reset actions. */
  ollamaGenerationOverrides?: OllamaGenerationPatch;
  /** Effective model default sampling values (Modelfile /api/show or Ollama defaults). */
  ollamaModelDefaults?: Record<string, number>;
  /** Endpoint + auth state for the tab's current model — per tab, follows model switches. */
  modelEndpoint?: ModelEndpointInfo;
  /** Resolved endpoint for the tab's effective subagent model. */
  subagentModelEndpoint?: ModelEndpointInfo;
  /** OpenAI website-account OAuth state — never ships tokens, only the masked account. */
  openaiOAuth?: {
    signedIn: boolean;
    account?: string;
    /** Last OAuth flow failure (e.g. upstream invalid_client / timeout) — drives the status-bar auth chip until the next successful sign-in. */
    flowError?: string;
  };
  /** Selected managed mail integration. */
  mailProvider?: MailProvider;
  /** Google Antigravity OAuth state — powers gemini-* models on the Antigravity quota. */
  antigravityOAuth?: {
    signedIn: boolean;
    account?: string;
    /** Exact model ids returned by Antigravity for this account. */
    models?: string[];
    /** Last OAuth flow failure — drives the status-bar Gemini auth chip until the next successful sign-in. */
    flowError?: string;
  };
  /** OpenCode Console device-flow OAuth state — unlocks the paid + Go
   *  subscription catalog. Never ships tokens, only the masked account. */
  opencodeOAuth?: {
    signedIn: boolean;
    account?: string;
    /** Active Console organization name, when the account has one. */
    orgName?: string;
    /** Last OAuth flow failure — shown in the OpenCode settings card until the next successful sign-in. */
    flowError?: string;
  };
  /** Xiaomi MiMo browser-auth state — the issued inference key is stored as the
   *  MiMo API key; never ships the key, only whether one is present. */
  mimoOAuth?: {
    signedIn: boolean;
    /** Last browser-flow failure — shown in the MiMo settings card. */
    flowError?: string;
  };
  /** Xiaomi MiMo subscription usage rides `$usage` like every other plan window. */
  /** Rule lists scoped to the current workspace (project config). */
  shellAllowedWorkspace?: string[];
  pathAllowedWorkspace?: string[];
  /** Rule lists applied to every workspace (user config). */
  shellAllowedGlobal?: string[];
  pathAllowedGlobal?: string[];
  /** Every rule in force for the tab's workspace, with mode, effect and scope resolved.
   *  Follow uses allow/ask, Never Ask uses deny/ask, read-only honours none of them. */
  rules?: RuleRecord[];
  /** Workspaces that carry their own rules, so the panel can offer one as a copy source. */
  workspacesWithRules?: Array<{ rootDir: string; ruleCount: number }>;
  /** Builtin read-only shell allowlist the daemon actually enforces. Shipped so the
   *  mode-rules card renders the real patterns rather than a hand-copied list. */
  builtinShellAllowlist?: string[];
  /** Tool names the registry flags `readOnly` for the current mode. */
  readOnlyTools?: string[];
  version: string;
}

/** Settings state consumed by the desktop UI, derived from the wire event contract.
 *  Quick-send fields remain optional for compatibility with older daemons. */
export type SettingsPayload = Omit<SettingsEvent, "type" | "quickSends"> &
  Partial<Pick<SettingsEvent, "quickSends">>;

/** Endpoint + auth state for the tab's CURRENT model — the status bar's API
 *  chip is per tab and flips between DeepSeek, OpenAI, Ollama and Gemini with the model. */
export interface ModelEndpointInfo {
  provider: ProviderID;
  baseUrl: string;
  /** Reasoning-effort levels this model accepts, resolved by the daemon (native
   *  providers from a static set; OpenCode from the model's models.dev
   *  `reasoning_options`). Empty = the model has no effort control. */
  reasoningEfforts?: readonly ReasoningEffort[];
  /** Native billing unit resolved by the daemon for this endpoint. */
  billingKind?: "usd" | "quota" | "none";
  /** Ollama endpoint deployment classification; absent for other providers. */
  deployment?: "cloud" | "local" | "custom";
  /** Auth source for OpenAI endpoints — absent for the DeepSeek provider. */
  openaiAuth?: "oauth" | "apiKey" | "none";
  /** Masked account email when signed in via OAuth. */
  oauthAccount?: string;
  /** Auth source for gemini endpoints (Antigravity quota). */
  antigravityAuth?: "oauth" | "none";
  /** Masked Google account email when signed in via Antigravity OAuth. */
  antigravityAccount?: string;
  /** Auth source for OpenCode endpoints (Zen/Go). */
  opencodeAuth?: "oauth" | "apiKey" | "none";
  /** Masked OpenCode account email when signed in via Console OAuth. */
  opencodeAccount?: string;
  /** Quota type of the tab's CURRENT OpenCode model: `go` bills the Go
   *  subscription's usage windows, `free` is the anonymous per-IP tier with no
   *  usage API. Absent for non-opencode providers and for paid Zen models. */
  opencodePlan?: "go" | "free";
}

export interface BalanceInfoItem {
  currency: string;
  total: number;
  granted?: number;
  toppedUp?: number;
}

export interface BalanceEvent {
  type: "$balance";
  currency: string;
  total: number;
  isAvailable: boolean;
  balanceInfos: BalanceInfoItem[];
}

/** One usage window, normalized daemon-side so every provider's plan usage reaches
 *  the ribbon in the same shape. */
export interface ProviderUsageWindow {
  /** Ribbon label: "5h" (rolling/session), "wk", "mo", or "plan" (per-model). */
  label: ProviderUsageWindowLabel;
  /** % of the window's limit still available (the ribbon's "% left"). */
  remainingPct: number;
  /** Epoch-ms reset time, or null when the provider reported none. */
  resetsAt: number | null;
  /** True when the provider flagged the window rate-limited (OpenCode Go). */
  limited?: boolean;
}

/** A provider's plan usage, already normalized: one plan label plus ordered
 *  windows. The daemon builds it from whichever payload the provider speaks, so
 *  the status bar renders every provider through one code path. */
export interface ProviderUsage {
  /** Probe that produced this reading (echoed for diagnostics). */
  probe: ProviderProbeStrategy;
  /** Plan/tier badge text, or null when the provider reports none. */
  plan: string | null;
  /** Ordered windows, primary first; empty when the provider reported no numbers. */
  windows: ProviderUsageWindow[];
  /** The provider's own verdict that the plan is blocked right now (Codex
   *  `rate_limit.limit_reached`). A spent 5-hour window leaves the weekly reading
   *  high, so no percentage alone says whether a request will be accepted. */
  limited?: boolean;
  /** Spendable credit the same payload reported, when it reports one. */
  credit?: { currency: string; amount: number } | null;
}

/** Plan usage for the active tab. A `null` payload means "no data" — nothing
 *  configured, a tier that measures nothing, or a failed read — and the chip
 *  degrades to a dash plus this reason, never a guessed number. */
export interface ProviderUsageEvent {
  type: "$usage";
  usage: ProviderUsage | null;
  /** Why usage is null, in the transport's own vocabulary (`http-429`,
   *  `network`, `no-credential`, ...). */
  reason?: string;
  /** The reason means "not configured yet", so the tooltip asks for setup rather
   *  than reporting a failed read. */
  needsSetup?: boolean;
}

/** One quota window reported by the Codex app-server (account/rateLimits/read).
 *  Windows are identified by `windowMinutes`, never by position — OpenAI has
 *  changed which buckets appear for different plans (issue #32707). */
export interface CodexQuotaWindow {
  /** Window length in minutes — 300 = 5-hour, 10080 = weekly. */
  windowMinutes: number;
  /** Server-reported usage in this window (0-100+). */
  usedPercent: number;
  /** 100 - usedPercent — the statusbar's "% left". Computed once, daemon-side. */
  remainingPercent: number;
  /** ISO timestamp of the next reset, or null when the server didn't report one. */
  resetsAt: string | null;
}

/** ChatGPT-plan Codex quota (daemon source: src/codex-backend.ts, OAuth fetch
 *  of the official codex rate_limits endpoint — no codex CLI needed). `null`
 *  payload means "no data" — not signed in, rejected, or malformed — the UI
 *  degrades to no chip instead of a wrong number. */
export interface CodexQuota {
  /** Plan type from account/read (e.g. "plus", "pro"), or null. */
  plan: string | null;
  /** 5-hour window, when the plan reports one (some plans only report weekly). */
  fiveHour: CodexQuotaWindow | null;
  /** Weekly window — the primary ribbon value. */
  weekly: CodexQuotaWindow | null;
  /** The payload's own limit verdict (`allowed: false` / `limit_reached: true`),
   *  which the percentages do not imply: a spent 5-hour window leaves the weekly
   *  budget reading high, yet no request is accepted until that window resets. */
  limitReached: boolean;
  fetchedAt: number;
}

/** One Ollama Cloud plan window (`GET {origin}/api/balance`). The API reports
 *  the % of the window's limit still available; the daemon derives the consumed
 *  % to mirror how the Codex quota reports usedPercent. */
export interface OllamaQuotaWindow {
  /** % of the plan's limit consumed in this window (100 - remainingPct). */
  usagePct: number;
  /** % of the plan's limit still available (the statusbar's "% left"). */
  remainingPct: number;
  /** Epoch-ms reset time, or null when the API omits it. */
  resetsAt?: number | null;
}

/** Cloud Ollama plan/usage for the signed-in account (daemon source: `GET
 *  {origin}/api/balance` with the same Bearer key as chat). `null` payload means
 *  "no data" — no key, local daemon, or fetch failure — the UI shows a dash. */
export interface OllamaQuota {
  /** 5-hour session window (resets every 5 h). */
  session: OllamaQuotaWindow | null;
  /** 7-day weekly window (resets every 7 d). */
  weekly: OllamaQuotaWindow | null;
  /** Purchased (extra) credit balance in USD, when the account reports it. */
  purchasedUsd?: number | null;
  fetchedAt: number;
}

/** One Z.AI GLM Coding Plan usage window (`GET {origin}/api/monitor/usage/quota/limit`).
 *  Unlike Ollama/Codex, the API reports plan usage directly as a percentage
 *  (`percentage`) per window, plus an epoch-ms reset time. The 5-hour window
 *  (`unit: 3`) resets on a rolling basis; the weekly window (`unit: 6`) resets
 *  every 7 days. */
export interface ZaiQuotaWindow {
  /** API-reported plan-window usage, 0-100 (the server's `percentage` field). */
  usagePct: number;
  /** 100 - usagePct — the statusbar's "% left". */
  remainingPct: number;
  /** Epoch millis when the window resets, or null when the server didn't report one. */
  resetsAt: number | null;
}

/** Z.AI GLM Coding Plan usage (daemon source: the undocumented `GET
 *  {origin}/api/monitor/usage/quota/limit` monitor endpoint with the same Bearer
 *  key as chat). `null` payload means "no data" — no key, a Developer (pay-per-
 *  token) key, or a fetch failure — the UI degrades to a dash, never a wrong
 *  number. */
export interface ZaiQuota {
  /** Plan tier from the payload's `level` (e.g. "lite", "pro", "max"), or null. */
  plan: string | null;
  /** 5-hour rolling window (`unit: 3`), or null when the plan has none. */
  fiveHour: ZaiQuotaWindow | null;
  /** Weekly window (`unit: 6`), or null when the plan has none. */
  weekly: ZaiQuotaWindow | null;
  fetchedAt: number;
}

/** One OpenCode Go plan usage window (`GET {origin}/zen/go/v1/usage`). The API
 *  reports each window's consumed share directly as `percent` (0-100) plus an
 *  ISO reset timestamp; `limited` mirrors the server's `status:
 *  "rate-limited"` flag. */
export interface OpencodeQuotaWindow {
  /** % of the window's limit consumed (the server's `percent`). */
  usagePct: number;
  /** 100 - usagePct — the statusbar's "% left". */
  remainingPct: number;
  /** ISO timestamp when the window resets, or null when the server omitted it. */
  resetsAt: string | null;
  /** True when the server reported the window as `rate-limited`. */
  limited: boolean;
}

/** OpenCode Go subscription usage (daemon source: the Go endpoint's own
 *  `/zen/go/v1/usage` — 5-hour rolling, weekly and monthly windows). `null`
 *  payload means "no data" — no credential, no Go subscription (403), or a
 *  fetch failure — the UI degrades to a dash, never a wrong number. */
export interface OpencodeQuota {
  /** 5-hour rolling window — the primary ribbon value. */
  rolling: OpencodeQuotaWindow | null;
  /** Weekly window. */
  weekly: OpencodeQuotaWindow | null;
  /** Monthly window. */
  monthly: OpencodeQuotaWindow | null;
  fetchedAt: number;
}

/** Xiaomi MiMo subscription usage. The console usage API
 *  (`GET {platform}/api/v1/tokenPlan/usage`) authenticates with web-session
 *  cookies (`api-platform_serviceToken` + `userId`) — a DIFFERENT credential
 *  from the inference key — so this is normally `unsupported`. The daemon fills
 *  it in only when a console session is configured, and never fabricates a
 *  locally-counted percentage. */
export interface MiMoQuota {
  status: "available" | "authentication_required" | "unsupported" | "error";
  source: "console" | "local_estimate" | "none";
  /** % of the plan consumed (console-reported), when available. */
  usedPercent?: number;
  /** 100 - usedPercent, when available. */
  remainingPercent?: number;
  /** ISO reset timestamp, when the console reported one. */
  resetsAt?: string | null;
  /** Plan/tier label, when reported. */
  plan?: string | null;
  /** Why the status is non-available — surfaced in the statusbar tooltip. */
  reason?: string;
}

/** The account's Google Antigravity (Gemini Code Assist) plan, from
 *  loadCodeAssist.currentTier. */
export interface AntigravityPlan {
  tierId: string;
  name: string;
  upgradeText?: string;
  upgradeType?: string;
  upgradeUri?: string;
}

/** One per-model quota window from retrieveUserQuota.buckets. */
export interface AntigravityQuotaWindow {
  modelId: string;
  /** Fraction of the window already consumed, 0..1. */
  usedFraction: number;
  /** ISO timestamp when the window resets; absent when not a limited bucket. */
  resetTime?: string;
}

/** Google Antigravity usage for the signed-in account (daemon source: the
 *  undocumented Code Assist `v1internal` API — loadCodeAssist for the plan,
 *  retrieveUserQuota for per-model windows). `null` payload means "no data" —
 *  not signed in or fetch failure — the UI degrades to no chip. */
export interface AntigravityQuota {
  plan: AntigravityPlan | null;
  /** Per-model usage windows (already vertex-deduped, daemon-side). */
  windows: AntigravityQuotaWindow[];
  fetchedAt: number;
}

/** Dynamically fetched model list for the Ollama provider — driven by the
 *  picker's "Ollama" section so the hundreds of available models don't need
 *  hardcoding. `error` replaces the list when the endpoint is unreachable,
 *  auth was rejected, or the payload was malformed. */
export interface OllamaModelsEvent {
  type: "$ollama_models";
  /** Raw model ids the endpoint reported (e.g. `llama3.1:latest`). */
  models: string[];
  /** Subset of `models` confirmed vision-capable (multimodal) — the UI uses
   *  this to enable image upload for those models. Absent when none detected
   *  or the catalog couldn't be probed. */
  visionModels?: string[];
  /** The account's Ollama plan (`free`, `pro`, ...) when resolvable via the
   *  cloud `/api/me` endpoint — lets the picker explain filtering. */
  plan?: string;
  /** Models hidden because the account's plan doesn't cover them (only set
   *  when the endpoint is subscription-gated and the probe detected some). */
  hiddenCount?: number;
  error?: string;
}

/** Dynamically fetched model list for the OpenCode provider from models.dev.
 *  Free Zen models are always included; the paid Zen + Go subscription catalog
 *  is included when the daemon holds an OpenCode credential. */
export interface OpencodeModelsEvent {
  type: "$opencode_models";
  models: string[];
  visionModels?: string[];
  /** Whether a credential (API key / Console OAuth) gated the paid catalog. */
  credentialed?: boolean;
  error?: string;
}

/** Commit history from the public repo, grouped per release. Broadcast
 *  app-globally (like $opencode_models) because it depends on no tab state.
 *  `version` is the running build, so the page can mark which group is
 *  installed without a second round trip. */
export interface ChangelogEvent {
  type: "$changelog";
  releases: ChangelogRelease[];
  /** Running desktop version, for the "installed" marker. */
  version: string;
  /** Set when the fetch failed and this is a cached (possibly stale) copy. */
  error?: string;
}

// ---- commands ----

/** Per-provider persisted settings: catalog id → the setting keys that provider
 *  declares. Adding a provider or a field never changes this type. */
export type ProviderSettingsMap = Record<string, Record<string, string>>;

/** Per-engine persisted settings: engine id → the keys that engine declares for itself.
 *  Engines sharing a model provider's key are absent, so their value is never duplicated. */
export type SearchSettingsMap = Record<string, Record<string, string>>;

export interface SettingsPatch {
  reasoningEffort?: ReasoningEffort;
  editMode?: EditMode;
  /** Per-type sound/notification cue matrix (Settings → Behavior). */
  feedbackCues?: FeedbackCueSettings;
  quickSends?: QuickSend[];
  /** Id of the quick send the composer should mark as the default. */
  quickSendId?: string;
  /** Context-window cap in tokens, clamped to [128000, 1000000]; null/undefined = per-model default. */
  contextTokens?: number | null;
  /** Turn pre-turn auto-compaction on/off. */
  autoCompact?: boolean;
  /** Auto-compaction trigger fraction, clamped to [0.5, 0.95]; null/undefined = default (0.8). */
  autoCompactTrigger?: number | null;
  /** Allow `run_command` to run commands elevated via Windows UAC. */
  elevationEnabled?: boolean;
  /** Allow the stream repetition / "stuck re-thinking" guard to abort a degenerating stream. */
  repetitionGuardEnabled?: boolean;
  questionTimerEnabled?: boolean;
  /** Duplicate-session context budget in tokens, clamped to [1000, 1000000]; null/undefined = default (50 000). */
  duplicateSessionTokens?: number | null;
  /** Run one continuation turn in a freshly duplicated session. Default true; an
   *  explicit false parks the seeded context and waits for the user. */
  duplicateSessionAutoProceed?: boolean;
  baseUrl?: string;
  workspaceDir?: string;
  model?: string;
  /** Model ids offered by every model picker. Replaces the whole persisted
   *  `enabledModels` allow-list; empty array disables everything. */
  enabledModels?: string[];
  /** Ordered backup models for automatic quota failover. Replaces the whole
   *  persisted `fallbackModels` list; empty array turns failover off. */
  fallbackModels?: string[];
  /** Per-tab subagent model to persist. Absent leaves the existing value. */
  subagentModel?: string;
  /** Persisted provider settings to write, keyed like
   *  `SettingsPayload.providerSettings`. Only keys a provider declares are applied;
   *  an empty value clears the setting. */
  providerSettings?: ProviderSettingsMap;
  /** Native Ollama generation options. Null fields clear their persisted override. */
  ollamaGeneration?: OllamaGenerationPatch;
  webSearchEngine?: WebSearchEngineName;
  /** Persisted engine settings to write, keyed like `SettingsPayload.searchSettings`.
   *  Only keys an engine declares are applied; an empty value clears the setting. */
  searchSettings?: SearchSettingsMap;
}

/** An image to attach to a user message. Clipboard paste flows ship the
 *  bytes the UI already encoded; drag-and-drop ships a path the daemon reads
 *  (the webview has no fs access for arbitrary OS paths). */
export type UserImageAttachment =
  | { source: "clipboard"; dataUrl: string; kind?: "image" }
  | {
      source: "file";
      path: string;
      kind?: "image" | "audio" | "video";
      /** Video-only MiMo frame sampling rate (0.1–10 fps). Defaults to 2. */
      fps?: number;
      /** Video-only MiMo visual detail level. Defaults to "default". */
      mediaResolution?: "default" | "max";
    };

export type OutgoingCommand = { tabId?: string } & (
  | {
      cmd: "user_input";
      text: string;
      images?: UserImageAttachment[];
      /** Sender's optimistic-message id — echoed back on the `user.message`
       *  event so the desktop reconciles its bubble with the daemon turn. */
      clientId?: string;
    }
  | { cmd: "abort" }
  /** Stops one running tool call. `callId` targets exactly that card; when
   *  omitted the backend falls back to the most recently started tool. */
  | { cmd: "cancel_tool"; callId?: string }
  | {
      cmd: "confirm_response";
      id: number;
      response: import("./permission-types.js").ConfirmationChoice;
    }
  | { cmd: "choice_response"; id: number; response: import("./permission-types.js").ChoiceVerdict }
  | { cmd: "plan_response"; id: number; response: import("./permission-types.js").PlanVerdict }
  | {
      cmd: "checkpoint_response";
      id: number;
      response: import("./permission-types.js").CheckpointVerdict;
    }
  | {
      cmd: "revision_response";
      id: number;
      response: import("./permission-types.js").RevisionVerdict;
    }
  /** Pause/resume the backend auto-resolve countdown for one gate so it stays
   *  in lockstep with the card's own clock. `enabled: false` cancels the pending
   *  auto-resolve (the gate waits for a manual pick); `enabled: true` re-arms a
   *  fresh full window. Without this, "disable timer" only stopped the UI while
   *  the backend still resolved at expiry. */
  | { cmd: "gate_timer"; id: number; enabled: boolean }
  /** Fetch one page of older transcript: `before` is how many messages from the
   *  session's end the caller already holds, so the reply is the window just above
   *  them. */
  | { cmd: "session_history_page"; name: string; before: number }
  | { cmd: "session_list" }
  /** `replay: false` asks only for transport state, the tab snapshot and the
   *  catalog refreshes — no per-tab re-emission. A caller that just spawned this
   *  daemon already received the boot emissions; a reloaded WebView needs them. */
  | { cmd: "desktop_resync"; replay?: boolean }
  /** Pull one tab's live turn state ($tab_status reply) — the reconciliation
   *  probe the desktop polls while busy so a lost terminal event can't wedge it. */
  | { cmd: "tab_status" }
  /** `requestId` is the frontend's name for this mutation. The daemon answers it
   *  exactly once through the `answers` of one $sessions snapshot, and the client
   *  settles its optimistic hide on that answer alone. */
  | { cmd: "session_delete"; name: string; requestId: string }
  /** Delete every session the caller is optimistically hiding. `names` is the
   *  frontend's exact hide-list, echoed so the daemon can answer for every one even
   *  if its own workspace listing misses some. `keep` is the list the caller told
   *  the user would survive; the daemon never deletes a name from it, whatever its
   *  own live check reports. `requestId` answers this request, as for a delete. */
  | { cmd: "session_clear"; names?: string[]; keep?: string[]; requestId: string }
  /** Legacy alias for additive session_open; never replaces the active agent. */
  | { cmd: "session_load"; name: string }
  /** Focus an existing session agent or add it to the current workspace tab. */
  | { cmd: "session_open"; name: string }
  | { cmd: "session_rename"; name: string; title: string }
  | { cmd: "session_reorder"; name: string; createdAt?: number }
  | { cmd: "memory_read"; path: string }
  | ({
      cmd: "memory_write";
      scope: "global" | "project";
      name: string;
      description: string;
      body: string;
    } & MemoryWriteOptions)
  | { cmd: "memory_delete"; path: string }
  /** `requestId` is answered in the `answers` of the snapshot that lists the minted
   *  session, or of the snapshot that reports the creation did not happen. */
  | { cmd: "new_chat"; requestId: string }
  | { cmd: "setup_save_key"; key: string }
  | { cmd: "setup_save_openai_key"; key: string }
  | { cmd: "oauth_begin" }
  | { cmd: "oauth_cancel" }
  | { cmd: "oauth_signout" }
  | { cmd: "gemini_oauth_begin" }
  | { cmd: "gemini_oauth_cancel" }
  | { cmd: "gemini_oauth_signout" }
  | { cmd: "opencode_oauth_begin" }
  | { cmd: "opencode_oauth_cancel" }
  | { cmd: "opencode_oauth_signout" }
  | { cmd: "mimo_oauth_begin" }
  | { cmd: "mimo_oauth_cancel" }
  | { cmd: "mimo_oauth_signout" }
  | { cmd: "antigravity_models_refresh" }
  | { cmd: "opencode_models_refresh"; force?: boolean }
  | {
      cmd: "provider_models_refresh";
      provider?: ProviderID;
      force?: boolean;
    }
  | { cmd: "settings_get" }
  | ({ cmd: "settings_save" } & SettingsPatch)
  /** Refresh the tab's money chips: the declared plan-usage probe and its wallet. */
  | { cmd: "funds_refresh" }
  | { cmd: "ollama_models_list"; force?: boolean }
  /** Fetch the repo commit history for the Settings changelog page. */
  | { cmd: "changelog_get"; force?: boolean }
  | { cmd: "mention_query"; query: string; nonce: number }
  | { cmd: "mention_preview"; path: string; nonce: number }
  | { cmd: "mention_picked"; path: string }
  /** Open a workspace tab, or add a fresh session when that workspace is open. */
  | { cmd: "tab_open"; workspaceDir?: string }
  /** Close the addressed channel's entire visual workspace tab and all agents in it. */
  | { cmd: "tab_close" }
  | { cmd: "tab_activate"; tabId: string }
  | { cmd: "workspace_recent_remove"; path: string }
  | { cmd: "mcp_specs_get" }
  | { cmd: "mcp_specs_add"; spec: string }
  | { cmd: "mcp_specs_remove"; spec: string }
  | { cmd: "mcp_specs_toggle"; name: string; disabled: boolean }
  /** Browser sign-in for one HTTP/SSE MCP server, its cancellation, and sign-out. */
  | { cmd: "mcp_auth_connect"; name: string }
  | { cmd: "mcp_auth_cancel"; name: string }
  | { cmd: "mcp_auth_disconnect"; name: string }
  /** Plugin inventory for the Settings > Plugins page. */
  | { cmd: "plugins_get" }
  /** Install one plugin from `owner/repo`, a git URL, or a local directory path. */
  | { cmd: "plugins_install"; source: string }
  | { cmd: "plugins_uninstall"; name: string }
  /** Edit one plugin's Settings default: the enablement a NEW chat starts from. A live
   *  chat's frozen set is untouched, exactly like `mcp_specs_toggle`. */
  | { cmd: "plugins_toggle"; slug: string; disabled: boolean }
  /** Standalone skill inventory for the Settings > Skills page. */
  | { cmd: "skills_get" }
  /** Install one skill, or every skill of a repository's `skills/` tree. */
  | { cmd: "skills_install"; source: string }
  | { cmd: "skills_uninstall"; name: string }
  /** Confirm a fresh chat's capabilities — enabled MCP servers, plugins, standalone skills
   *  and the subagent flag — freezing them in its session meta and unlocking it. */
  | {
      cmd: "mcp_session_configure";
      enabled: string[];
      subagents: boolean;
      plugins: string[];
      skills: string[];
    }
  /** Abandon a fresh chat before its MCP set is confirmed — deletes that session; its workspace tab stays. */
  | { cmd: "mcp_session_cancel" }
  | { cmd: "mcp_extension_status" }
  | {
      cmd: "mcp_extension_configure";
      mode: PlaywrightMcpConnectionMode;
      token?: string;
      cdpEndpoint?: string;
      extensionBrowser?: PlaywrightExtensionBrowser;
    }
  | { cmd: "mcp_extension_check" }
  | { cmd: "mail_provider_set"; provider: MailProvider }
  | { cmd: "mail_status"; provider: MailProvider }
  | {
      cmd: "mail_configure";
      provider: MailProvider;
      clientId?: string;
      clientSecret?: string;
    }
  | { cmd: "mail_connect"; provider: MailProvider }
  | { cmd: "mail_cancel"; provider: MailProvider }
  | { cmd: "mail_signout"; provider: MailProvider }
  | { cmd: "playwright_browser_install"; browser: PlaywrightManagedBrowser }
  | { cmd: "playwright_browser_install_cancel"; browser: PlaywrightManagedBrowser }
  | { cmd: "rule_add"; rule: RuleRecord }
  | { cmd: "rule_update"; from: RuleRecord; to: RuleRecord }
  | { cmd: "workspace_rules_copy"; from: string }
  | { cmd: "rule_remove"; rule: RuleRecord }
  | { cmd: "jobs_list" }
  /** Stops one background job. `tabId` names the owning tab: per-tab registries
   *  restart job ids at 1, so `jobId` alone can match a different tab's job. */
  | { cmd: "jobs_stop"; jobId: number; tabId?: string }
  | { cmd: "jobs_stop_all" }
  | { cmd: "plan_history_get" }
  | { cmd: "plan_detail_get"; planId: string }
  /** Delete a plan for good, whatever its status. Replies with a fresh $plan_history
   *  (and $plan_cleared when the removed plan was the active one). */
  | { cmd: "plan_remove"; planId: string }
  /** Fold/summarize the conversation to reclaim context space (manual
   *  compaction). Refused while a turn is in flight. */
  | { cmd: "context_compact" }
  /** Duplicate the current conversation as a new truncated session on the SAME models.
   *  `markdown` is the current session's export body; the daemon trims it to the last
   *  `duplicateSessionTokens` tokens and runs it as the clone's first turn (unless
   *  `duplicateSessionAutoProceed` was turned off). `enabled` is the capability answer
   *  the Duplicate popover collected: the clone is minted with it already frozen, so it
   *  never re-asks. A caller that omits `enabled` falls back to the `$mcp_setup` picker,
   *  pre-filled with this session's frozen capabilities. */
  | {
      cmd: "duplicate_session";
      markdown: string;
      /** Names of the configured MCP servers the clone may use. */
      enabled?: string[];
      /** Slugs of the plugins the clone may use. */
      plugins?: string[];
      /** Ids of the standalone skills the clone may use. */
      skills?: string[];
      /** Whether the clone may spawn subagents. */
      subagents?: boolean;
      /** Answered like `new_chat`: the clone's mint, or the refusal that stopped it. */
      requestId: string;
    }
  | { cmd: "retry" }
  | { cmd: "btw"; text: string }
  /** Replace this session's persisted annotation cards (notice + warning) so
   *  they survive reload/resync. Idempotent full-list overwrite. */
  | { cmd: "notices_sync"; notices: PersistedNotice[] }
  /** Replace this session's recorded gate/fold events so the Events tab keeps
   *  its history across reload/resync. Idempotent full-list overwrite. */
  | { cmd: "events_sync"; events: SessionEventRecord[] }
);
