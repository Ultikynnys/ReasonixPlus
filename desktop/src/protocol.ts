/** Wire protocol shared with the desktop daemon. The event/command type
 *  definitions live in @reasonix/core-utils (desktop-protocol.ts) so a field
 *  change can't silently drift between the two sides of the JSON-RPC bridge.
 *  The kernel-event shapes below (model.* / tool.* / warning / error) are a
 *  read-only projection of the daemon's src/core/events.ts union
 *  and stay declared here until the kernel Event union itself moves into
 *  core-utils. */
import type {
  BalanceEvent,
  BtwResultEvent,
  ChangelogEvent,
  CheckpointRequiredEvent,
  CheckpointVerdict,
  ChoiceOption,
  ChoiceRequiredEvent,
  ChoiceVerdict,
  ConfirmRequiredEvent,
  ConfirmationChoice,
  ConnectedEvent,
  CtxBreakdownEvent,
  DesktopDiagnosticEvent,
  DesktopDiagnosticLevel,
  DirectKernelWireEvent,
  EditMode,
  EditRequiredEvent,
  FeedbackCueId,
  FeedbackCueSetting,
  FeedbackCueSettings,
  JobInfo,
  JobsEvent,
  KernelModelDeltaEvent,
  KernelModelFinalEvent,
  KernelModelTurnStartedEvent,
  KernelStatusEvent,
  KernelSubagentProgressEvent,
  KernelToolIntentEvent,
  KernelToolOutputEvent,
  KernelToolPreparingEvent,
  KernelToolResultEvent,
  KernelUsage,
  KernelUserMessageEvent,
  KernelWarningEvent,
  KernelWireToolCall,
  LoadedMessage,
  LoadedSegment,
  MailAuthEvent,
  MailAuthPhase,
  MailAuthState,
  McpExtensionCheck,
  McpExtensionCheckEvent,
  McpExtensionServerState,
  McpExtensionStatus,
  McpExtensionStatusEvent,
  McpSetupEvent,
  McpSetupServer,
  McpSpecInfo,
  McpSpecStatus,
  McpSpecsEvent,
  MemoryDetailEvent,
  MemoryEntryDetail,
  MemoryEntryInfo,
  MemoryEntryKind,
  MemoryEvent,
  MemoryResultEvent,
  MentionPreviewEvent,
  MentionResultsEvent,
  ModelEndpointInfo,
  NeedsSetupEvent,
  OllamaGenerationPatch,
  OllamaGenerationSettings,
  OllamaModelsEvent,
  OpencodeModelsEvent,
  OutgoingCommand,
  PathAccessRequiredEvent,
  PersistedNotice,
  PlanClearedEvent,
  PlanRequiredEvent,
  PlanRestoredEvent,
  PlanStep,
  PlanVerdict,
  PlaywrightBrowserInstall,
  PlaywrightBrowserInstallEvent,
  PlaywrightExtensionBrowser,
  PlaywrightManagedBrowser,
  PlaywrightMcpConnectionMode,
  ProtocolErrorEvent,
  ProviderUsage,
  ProviderUsageEvent,
  QuickSend,
  ReadyEvent,
  ReasoningEffort,
  RetryResultEvent,
  RevisionRequiredEvent,
  RevisionVerdict,
  SessionBoundEvent,
  SessionEmptyEvent,
  SessionEventRecord,
  SessionEventType,
  SessionHistoryEvent,
  SessionLoadedEvent,
  SessionRetractedEvent,
  SessionsEvent,
  SettingsEvent,
  SettingsPatch,
  SettingsPayload,
  KernelErrorEvent as SharedKernelErrorEvent,
  StepCompletedEvent,
  TabClosedEvent,
  TabOpenedEvent,
  TabStatusEvent,
  TabsSnapshotEvent,
  TurnCompleteEvent,
  TurnOutcome,
  TurnStartedEvent,
  UserImageAttachment,
  WebSearchEngineName,
  WorkspaceInitializedEvent,
} from "@reasonix/core-utils";
import { invoke } from "@tauri-apps/api/core";

/** Re-export so UI components can identify Antigravity-routed model ids. */
export { isAntigravityModel } from "@reasonix/core-utils";
export {
  BUILTIN_QUICK_SENDS,
  PLAYWRIGHT_MANAGED_BROWSERS,
  QUICK_SEND_SHORTHAND_MAX_LENGTH,
  MailProvider,
  allQuickSends,
  createQuickSendId,
  enforceQuickSendShorthand,
  isQuickSend,
  resolveActiveQuickSend,
} from "@reasonix/core-utils";

export type {
  BalanceEvent,
  BtwResultEvent,
  ConnectedEvent,
  DesktopDiagnosticEvent,
  DesktopDiagnosticLevel,
  OllamaModelsEvent,
  OpencodeModelsEvent,
  ChangelogEvent,
  CheckpointRequiredEvent,
  CheckpointVerdict,
  ChoiceOption,
  ChoiceRequiredEvent,
  ChoiceVerdict,
  ConfirmRequiredEvent,
  ConfirmationChoice,
  CtxBreakdownEvent,
  EditMode,
  EditRequiredEvent,
  JobInfo,
  JobsEvent,
  LoadedMessage,
  LoadedSegment,
  McpExtensionCheck,
  McpExtensionCheckEvent,
  McpExtensionServerState,
  McpExtensionStatus,
  McpExtensionStatusEvent,
  MailAuthEvent,
  MailAuthPhase,
  MailAuthState,
  PlaywrightBrowserInstall,
  PlaywrightBrowserInstallEvent,
  PlaywrightManagedBrowser,
  PlaywrightMcpConnectionMode,
  PlaywrightExtensionBrowser,
  McpSpecInfo,
  McpSpecsEvent,
  McpSetupEvent,
  McpSetupServer,
  McpSpecStatus,
  MemoryDetailEvent,
  MemoryEntryDetail,
  MemoryEntryInfo,
  MemoryEntryKind,
  MemoryEvent,
  MemoryResultEvent,
  MentionPreviewEvent,
  MentionResultsEvent,
  ModelEndpointInfo,
  OllamaGenerationPatch,
  OllamaGenerationSettings,
  NeedsSetupEvent,
  OutgoingCommand,
  PathAccessRequiredEvent,
  PersistedNotice,
  PlanClearedEvent,
  PlanRestoredEvent,
  PlanRequiredEvent,
  PlanStep,
  PlanVerdict,
  ProtocolErrorEvent,
  ProviderUsage,
  ProviderUsageEvent,
  ReadyEvent,
  ReasoningEffort,
  RetryResultEvent,
  RevisionRequiredEvent,
  RevisionVerdict,
  SessionBoundEvent,
  SessionEmptyEvent,
  SessionEventRecord,
  SessionEventType,
  SessionHistoryEvent,
  SessionLoadedEvent,
  SessionRetractedEvent,
  SessionsEvent,
  SettingsEvent,
  SettingsPatch,
  SettingsPayload,
  StepCompletedEvent,
  TabClosedEvent,
  TabOpenedEvent,
  TabStatusEvent,
  TurnCompleteEvent,
  TurnOutcome,
  TurnStartedEvent,
  UserImageAttachment,
  QuickSend,
  WebSearchEngineName,
};

/** Legacy alias for the memory-browser name (context-panel imports it). */
export type MemoryDetail = MemoryEntryDetail;

export type { FeedbackCueId, FeedbackCueSetting, FeedbackCueSettings };

// ---- kernel events shared with the daemon ----

export type UserMessageEvent = KernelUserMessageEvent;
export type ModelTurnStartedEvent = KernelModelTurnStartedEvent;
export type ModelDeltaEvent = KernelModelDeltaEvent;
export type Usage = KernelUsage;
export type WireToolCall = KernelWireToolCall;
export type ModelFinalEvent = KernelModelFinalEvent;
export type ToolPreparingEvent = KernelToolPreparingEvent;
export type ToolIntentEvent = KernelToolIntentEvent;
export type ToolResultEvent = KernelToolResultEvent;
export type ToolOutputEvent = KernelToolOutputEvent;
export type SubagentProgressEvent = KernelSubagentProgressEvent;
export type StatusEvent = KernelStatusEvent;
export type WarningEvent = KernelWarningEvent;
export type KernelErrorEvent = SharedKernelErrorEvent;

export type IncomingEvent = { tabId?: string } & (
  | ConnectedEvent
  | ReadyEvent
  | ProtocolErrorEvent
  | { type: "$notice"; text: string; severity: "info" | "success" | "warning" | "error" }
  | TurnCompleteEvent
  | TurnStartedEvent
  | TabStatusEvent
  | DesktopDiagnosticEvent
  | ConfirmRequiredEvent
  | PathAccessRequiredEvent
  | EditRequiredEvent
  | ChoiceRequiredEvent
  | PlanRequiredEvent
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
  | CheckpointRequiredEvent
  | RevisionRequiredEvent
  | StepCompletedEvent
  | PlanClearedEvent
  | import("@reasonix/core-utils").PlanHistoryEvent
  | import("@reasonix/core-utils").PlanDetailEvent
  | PlanRestoredEvent
  | MentionResultsEvent
  | MentionPreviewEvent
  | TabOpenedEvent
  | TabClosedEvent
  | WorkspaceInitializedEvent
  | TabsSnapshotEvent
  | McpSpecsEvent
  | McpSetupEvent
  | McpExtensionStatusEvent
  | McpExtensionCheckEvent
  | MailAuthEvent
  | PlaywrightBrowserInstallEvent
  | CtxBreakdownEvent
  | MemoryEvent
  | MemoryDetailEvent
  | MemoryResultEvent
  | JobsEvent
  | DirectKernelWireEvent
  | SessionRetractedEvent
  | RetryResultEvent
  | BtwResultEvent
  | { type: "oauth_begin_result"; url: string }
  | { type: "gemini_oauth_begin_result"; url: string }
  | { type: "opencode_oauth_begin_result"; url: string; userCode: string }
  | { type: "mimo_oauth_begin_result"; url: string }
);

/** Send one command to the desktop backend over the Tauri JSON-RPC bridge. */
export function rpcSend(cmd: OutgoingCommand): Promise<void> {
  return invoke("rpc_send", { line: JSON.stringify(cmd) });
}
