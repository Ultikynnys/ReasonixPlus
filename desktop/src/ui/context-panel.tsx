import {
  type CtxMemoryTokens,
  type MemoryWriteOptions,
  type PlanDetail,
  type PlanHistoryItem,
  type RuleRecord,
  isWorkingPlanStatus,
  ruleRegexError,
} from "@reasonix/core-utils";
import { invoke } from "@tauri-apps/api/core";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ActivePlan, SessionFile, SessionInfo, Settings, UsageStats } from "../App";
import { t, useLang } from "../i18n";
import type { TKey } from "../i18n";
import { I } from "../icons";
import { planIdForSession } from "../plan-labels";
import type {
  McpSpecInfo,
  MemoryDetail,
  MemoryEntryInfo,
  PluginInfo,
  SessionEventRecord,
  SettingsPatch,
  SkillInfo,
} from "../protocol";
import { toWorkspaceAbsolute } from "../workspace-path";
import { PanelErrorBoundary } from "./error-boundary";
import type { TranscriptRecord } from "./events";
import { EventsPanel } from "./events";
import { FileMenu } from "./file-menu";
import { useInventoryRequest } from "./inventory-request";
import { activationHandler } from "./keyboard";
import { ListControl } from "./list-controls";
import { pluginQualifier } from "./plugin-labels";
import { sessionTitle } from "./session-title";
import type { JumpTarget } from "./transcript-jump";

/** Side-panel nav order and labels. Declared before `Tab` because the tab union derives from
 *  it: a tab cannot reach the state without a nav entry, and the bar maps over one list. */
const PANEL_TABS = [
  { id: "files", label: "contextPanel.filesTab" },
  { id: "parameters", label: "contextPanel.parametersTab" },
  { id: "mcp", label: "contextPanel.mcpTab" },
  { id: "skills", label: "contextPanel.skillsTab" },
  { id: "plugins", label: "contextPanel.pluginsTab" },
  { id: "memory", label: "contextPanel.memoryTab" },
  { id: "rules", label: "contextPanel.rulesTab" },
  { id: "plan", label: "contextPanel.planTab" },
  { id: "events", label: "contextPanel.eventsTab" },
] as const satisfies ReadonlyArray<{ id: string; label: TKey }>;

type Tab = (typeof PANEL_TABS)[number]["id"];

/** Rule effect and mode come straight off the wire type, so they cannot drift. */
type RuleEffect = RuleRecord["effect"];
type RuleMode = RuleRecord["mode"];

/** Fallback until the sidecar reports the real cap via $ctx_breakdown — the V4 context
 *  window is 300K (DEEPSEEK_CONTEXT_TOKENS); never show the old 1M API ceiling. */
const CONTEXT_MAX_TOKENS = 300_000;

/** 1_234_567 → "1.2M" or 500_000 → "500K" — used for the context-window slider display. */
function fmtCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n));
}

/** Each memory scope's row wording, keyed by the wire record so a scope added to
 *  `CtxMemoryTokens` cannot reach the legend unlabeled: `memoryTotal` counts it. */
const MEMORY_SCOPE_TEXT: Record<keyof CtxMemoryTokens, { label: TKey; title: TKey }> = {
  global: { label: "contextPanel.scopeGlobal", title: "contextPanel.memoryGlobalTooltip" },
  project: { label: "contextPanel.scopeProject", title: "contextPanel.memoryProjectTooltip" },
  priority: {
    label: "contextPanel.memoryPriorityKey",
    title: "contextPanel.memoryPriorityTooltip",
  },
};

/** One token-legend item: an optional colour swatch, the label, and its count. */
function LegendItem({
  label,
  value,
  title,
  swatch,
}: {
  label: string;
  value: number;
  /** Hover explanation, for a figure whose name is not enough on its own. */
  title?: string;
  /** Meter colour of the swatch; the reserved-bucket rows carry none. */
  swatch?: "r" | "c" | "u";
}) {
  return (
    <span className="l" title={title}>
      {swatch ? <span className={`sw ${swatch}`} /> : null}
      {label} <span className="v">{value.toLocaleString()}</span>
    </span>
  );
}

export function ContextPanel({
  settings,
  usage,
  mcpSpecs,
  mcpBridged,
  sessionFiles,
  memory,
  memoryDetail,
  memoryResult,
  skills = [],
  plugins = [],
  onRequestSkills,
  onRequestPlugins,
  onReadMemory,
  onWriteMemory,
  onDeleteMemory,
  onDismissMemoryResult,
  onAddRule,
  onUpdateRule,
  onCopyWorkspaceRules,
  onRemoveRule,
  onSaveSettings,
  onCompact,
  activePlan,
  planHistory,
  planDetails,
  planSession,
  sessions,
  onReadPlans,
  onReadPlan,
  onRemovePlan,
  onReorderPlan,
  onClearPlans,
  messages = [],
  sessionEvents = [],
  onJumpToEvent,
  active = true,
}: {
  settings: Settings | null;
  usage: UsageStats;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  sessionFiles: SessionFile[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  memoryResult: { ok: boolean; message: string } | null;
  /** Standalone skills installed for every workspace; a chat's enabled set is frozen at
   *  its session-start confirm, so this inventory is read-only. */
  skills?: SkillInfo[];
  /** Installed plugins with what each ships; enablement is chosen per chat, not here. */
  plugins?: PluginInfo[];
  /** Re-request the skill inventory when the Skills tab opens. */
  onRequestSkills?: () => void;
  /** Re-request the plugin inventory when the Plugins tab opens. */
  onRequestPlugins?: () => void;
  onReadMemory: (path: string) => void;
  onWriteMemory: (
    scope: "global" | "project",
    name: string,
    description: string,
    body: string,
    opts?: MemoryWriteOptions,
  ) => void;
  onDeleteMemory: (path: string) => void;
  onDismissMemoryResult: () => void;
  onAddRule?: (rule: RuleRecord) => void;
  onUpdateRule?: (from: RuleRecord, to: RuleRecord) => void;
  onCopyWorkspaceRules?: (from: string) => void;
  onRemoveRule?: (rule: RuleRecord) => void;
  onSaveSettings?: (patch: SettingsPatch) => void;
  /** Compact now button beside the context meter — runs manual compaction. */
  onCompact?: () => void;
  activePlan?: ActivePlan | null;
  planHistory?: PlanHistoryItem[];
  planDetails?: Record<string, PlanDetail>;
  planSession?: string;
  /** Workspace sessions, so an owner label reads exactly like its sidebar row
   *  (a session's own title beats its timestamp-derived name). */
  sessions?: readonly SessionInfo[];
  onReadPlans?: () => void;
  onReadPlan?: (id: string) => void;
  onRemovePlan?: (id: string) => void;
  /** Move a plan to the top of the workspace history. */
  onReorderPlan?: (id: string) => void;
  /** Delete every plan in the workspace. */
  onClearPlans?: () => void;
  /** The live transcript: the Events tab reads its user turns as event rows. */
  messages?: readonly TranscriptRecord[];
  /** Gate/fold verdicts recorded for this session, persisted with it. */
  sessionEvents?: readonly SessionEventRecord[];
  /** Scroll the chat to a recorded event's location — the Events tab's click
   *  target. */
  onJumpToEvent?: (target: JumpTarget) => boolean | void;
  /** True when this tab is the visible one. Background polling (git status)
   *  must only run for the tab the user can actually see. */
  active?: boolean;
}) {
  useLang();
  const [tab, setTab] = useState<Tab>("files");
  const enabledMcpServers = mcpSpecs.filter(
    (spec) => spec.status === "connected" && !spec.sessionDisabled,
  ).length;
  const memoryCounts = { global: 0, project: 0 };
  for (const entry of memory) {
    if (entry.scope === "global" || entry.scope === "project") memoryCounts[entry.scope]++;
  }
  const reserved = usage.reservedTokens;
  // What the reserved bucket is made of. Prompt is the remainder, so the parts always add
  // up to `reserved` no matter which sections the prompt carries.
  const skillTokens = usage.skillTokens;
  const toolTokens = usage.toolTokens;
  const memoryTokens = usage.memoryTokens;
  // Summed from the record, so a scope added to the wire reaches the total without a second edit.
  const memoryTotal = memoryTokens
    ? Object.values(memoryTokens).reduce((sum, part) => sum + part, 0)
    : 0;
  const reservedParts =
    skillTokens !== undefined && toolTokens !== undefined
      ? {
          skills: skillTokens,
          tools: toolTokens,
          prompt: Math.max(0, reserved - skillTokens - toolTokens - memoryTotal),
        }
      : undefined;
  const lastHit = usage.lastCallCacheHit ?? 0;
  const lastMiss = usage.lastCallCacheMiss ?? 0;
  const observedLog = Math.max(0, lastHit + lastMiss - reserved);
  const logTokens = Math.max(usage.liveLogTokens, observedLog);
  const cached = Math.min(logTokens, Math.max(0, lastHit - reserved));
  const used = Math.max(0, logTokens - cached);
  // Denominator must agree with the Context window slider: the sidecar's cap
  // first (it reflects what the loop enforces), then the user's setting, then
  // the 300K V4 default while the first snapshot is in flight.
  const ctxMax = usage.ctxMax ?? settings?.contextTokens ?? CONTEXT_MAX_TOKENS;
  const reservedPct = Math.min(100, (reserved / ctxMax) * 100);
  const usedPct = Math.min(100, (used / ctxMax) * 100);
  const cachedPct = Math.min(100, (cached / ctxMax) * 100);
  const free = Math.max(0, ctxMax - reserved - used - cached);
  // Where pre-turn auto-compaction fires, as a % of the window (null when off).
  const compactTriggerPct =
    settings?.autoCompact === false
      ? null
      : Math.min(95, Math.max(50, Math.round((settings?.autoCompactTrigger ?? 0.8) * 100)));
  return (
    <aside className="ctx">
      <div className="ctx-tabs">
        {PANEL_TABS.map((tb) => (
          <div
            key={tb.id}
            className="ctx-tab"
            data-active={tab === tb.id}
            onClick={() => setTab(tb.id)}
            onKeyDown={activationHandler(() => setTab(tb.id))}
          >
            {tb.id === "mcp" && enabledMcpServers > 0 && (
              <span
                className="tab-active"
                title={t("contextPanel.mcpEnabledServers", { count: enabledMcpServers })}
              >
                <span className="dot" data-state="running" aria-hidden="true" />
                <span className="ctx-tab-count">{enabledMcpServers}</span>
              </span>
            )}
            {t(tb.label)}
            {tb.id === "memory" && (
              <span className="ctx-memory-counts">
                {(["global", "project"] as const).map((scope) => {
                  const label = t(scope === "global" ? "contextPanel.scopeGlobal" : "contextPanel.scopeProject");
                  return (
                    <span key={scope} title={label} aria-label={`${label}: ${memoryCounts[scope]}`}>
                      {memoryCounts[scope]}
                    </span>
                  );
                })}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="ctx-body">
        <div className="ctx-block">
          <div className="h ctx-token-header">
            <span>{t("contextPanel.contextTokens")}</span>
            <span className="right" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {(reserved + used + cached).toLocaleString()} / {ctxMax.toLocaleString()}
              {onCompact && (
                <button
                  type="button"
                  className="mini-btn"
                  title={t("contextPanel.compactNowTooltip")}
                  onClick={() => onCompact()}
                >
                  {t("contextPanel.compactNow")}
                </button>
              )}
            </span>
          </div>
          <div className="meter">
            <span className="rsvd" style={{ width: `${reservedPct}%` }} />
            <span className="cached" style={{ width: `${cachedPct}%` }} />
            <span className="used" style={{ width: `${usedPct}%` }} />
            {compactTriggerPct !== null && (
              <span
                className="compact-zone"
                data-testid="compact-threshold"
                title={t("contextPanel.compactThresholdTooltip", { pct: compactTriggerPct })}
                style={{ left: `${compactTriggerPct}%`, width: `${100 - compactTriggerPct}%` }}
              />
            )}
          </div>
          <div className="legend">
            <LegendItem label={t("contextPanel.reservedKey")} value={reserved} swatch="r" />
            <LegendItem label={t("contextPanel.cacheKey")} value={cached} swatch="c" />
            <LegendItem label={t("contextPanel.usedKey")} value={used} swatch="u" />
            <LegendItem label={t("contextPanel.freeKey")} value={free} />
          </div>
          {reservedParts ? (
            <div className="legend legend-sub" data-testid="ctx-reserved-breakdown">
              <LegendItem
                label={t("contextPanel.skillsKey")}
                value={reservedParts.skills}
                title={t("contextPanel.skillsTooltip")}
              />
              <LegendItem label={t("contextPanel.toolsKey")} value={reservedParts.tools} />
              {/* Memory costs are listed by scope rather than as one aggregate: the scopes
                  already sum to the total. Both session scopes always show, so the row
                  still adds up to `reserved`; the high-priority block is a rare overlay,
                  so its empty row stays out. */}
              {memoryTokens && memoryTotal > 0
                ? (Object.entries(memoryTokens) as Array<[keyof CtxMemoryTokens, number]>).map(
                    ([scope, tokens]) =>
                      scope === "priority" && tokens === 0 ? null : (
                        <LegendItem
                          key={scope}
                          label={t(MEMORY_SCOPE_TEXT[scope].label)}
                          value={tokens}
                          title={t(MEMORY_SCOPE_TEXT[scope].title)}
                        />
                      ),
                  )
                : null}
              <LegendItem label={t("contextPanel.promptKey")} value={reservedParts.prompt} />
            </div>
          ) : null}
        </div>

        <PanelErrorBoundary key={tab} label={tab}>
          {tab === "files" && (
            <>
              <CtxFiles files={sessionFiles} settings={settings} />
              <CtxGit files={sessionFiles} settings={settings} active={active} />
            </>
          )}
          {tab === "parameters" && (
            <CtxParameters settings={settings} usage={usage} onSaveSettings={onSaveSettings} />
          )}
          {tab === "mcp" && <CtxMcp specs={mcpSpecs} bridged={mcpBridged} />}
          {tab === "skills" && (
            <CtxSkills
              skills={skills}
              plugins={plugins}
              onRequest={onRequestSkills}
              onRequestPlugins={onRequestPlugins}
            />
          )}
          {tab === "plugins" && <CtxPlugins plugins={plugins} onRequest={onRequestPlugins} />}
          {tab === "memory" && (
            <CtxMemory
              entries={memory}
              detail={memoryDetail}
              result={memoryResult}
              onRead={onReadMemory}
              onWrite={onWriteMemory}
              onDelete={onDeleteMemory}
              onDismissResult={onDismissMemoryResult}
            />
          )}
          {tab === "rules" && (
            <CtxRules
              settings={settings}
              onAddRule={onAddRule}
              onUpdateRule={onUpdateRule}
              onCopyWorkspaceRules={onCopyWorkspaceRules}
              onRemoveRule={onRemoveRule}
            />
          )}
          {tab === "plan" ? (
            <CtxPlanHistory
              currentSession={planSession}
              sessions={sessions}
              history={planHistory ?? []}
              details={planDetails ?? {}}
              onReadPlans={onReadPlans}
              onReadPlan={onReadPlan}
              onRemovePlan={onRemovePlan}
              onReorderPlan={onReorderPlan}
              onClearPlans={onClearPlans}
              fallback={activePlan}
            />
          ) : null}
          {tab === "events" ? (
            <EventsPanel messages={messages} events={sessionEvents} onJump={onJumpToEvent} />
          ) : null}
        </PanelErrorBoundary>
      </div>
    </aside>
  );
}

/** Ask, then run `action` only on a real yes: a denied or failed dialog must never read
 *  as approval. */
async function confirmThen(message: string, action: () => void): Promise<void> {
  let confirmed = false;
  try {
    confirmed = await confirmDialog(message);
  } catch {
    return;
  }
  if (confirmed) action();
}

function CtxPlanHistory({
  history,
  details,
  onReadPlans,
  onReadPlan,
  onRemovePlan,
  onReorderPlan,
  onClearPlans,
  fallback,
  currentSession,
  sessions,
}: {
  history: PlanHistoryItem[];
  details: Record<string, PlanDetail>;
  onReadPlans?: () => void;
  onReadPlan?: (id: string) => void;
  onRemovePlan?: (id: string) => void;
  onReorderPlan?: (id: string) => void;
  onClearPlans?: () => void;
  fallback?: ActivePlan | null;
  /** The session this panel belongs to. The plan list is workspace-wide, so this is what
   *  tells the session's own plan from another session's in the same workspace. */
  currentSession?: string;
  sessions?: readonly SessionInfo[];
}) {
  // The plan this session works is what the section opens on: the history is
  // workspace-wide, so the first active plan may belong to another session.
  const ownedId = planIdForSession(history, currentSession);
  const [selection, setSelection] = useState(ownedId ?? "");
  const selectedPlan =
    history.find((p) => p.id === selection) ??
    history.find((p) => p.id === ownedId) ??
    history.find((p) => p.status === "active") ??
    history[0];
  const selected = selectedPlan?.id;
  const detail = selected ? details[selected] : undefined;
  // One title per known session, so naming every option does not re-parse the
  // same session name. An unknown owner still gets its name-derived title.
  const sessionTitles = useMemo(
    () =>
      new Map((sessions ?? []).map((session) => [session.name, sessionTitle(session)] as const)),
    [sessions],
  );
  // How a plan is held right now: none for a finished plan, a name only for another
  // session, since this session's own plans need no line saying so.
  const ownershipOf = (
    plan?: PlanHistoryItem,
  ): { state: "this" | "other" | "none"; name?: string } | null => {
    if (!plan || !isWorkingPlanStatus(plan.status)) return null;
    const sessionName = plan.ownerSession;
    if (!sessionName) return { state: "none" };
    const name = sessionTitles.get(sessionName) ?? sessionTitle({ name: sessionName });
    return { state: sessionName === currentSession ? "this" : "other", name };
  };
  const readPlans = useRef(onReadPlans);
  const readPlan = useRef(onReadPlan);
  readPlans.current = onReadPlans;
  readPlan.current = onReadPlan;
  useEffect(() => {
    readPlans.current?.();
  }, []);
  // Follow the session's own plan across a switch. A session that owns no plan has
  // nothing to select, so the current choice stands.
  useEffect(() => {
    if (ownedId) setSelection(ownedId);
  }, [ownedId]);
  useEffect(() => {
    if (selected && !detail) readPlan.current?.(selected);
  }, [selected, detail]);
  // Two columns: the plan this session shows, then every plan in the workspace. The grid
  // drops to a single column by itself when the panel is narrow or the left is empty.
  const hasCurrent = Boolean(selectedPlan || fallback);
  return (
    <div className="ctx-plan-split">
      {hasCurrent ? (
        <section className="ctx-plan-col ctx-plan-current">
          {detail ? (
            <CtxPlan plan={activePlanFromDetail(detail)} />
          ) : selectedPlan ? (
            // Keep the summary + progress header from the history item, so a slow or
            // failed detail fetch never leaves the panel blank.
            <div className="ctx-plan">
              <PlanHead
                title={selectedPlan.summary ?? t("contextPanel.planUntitled")}
                done={selectedPlan.completedSteps}
                total={selectedPlan.totalSteps}
              />
              <div className="ctx-empty">{t("contextPanel.planDetailsLoading")}</div>
            </div>
          ) : fallback ? (
            <CtxPlan plan={fallback} />
          ) : null}
        </section>
      ) : null}
      <section className="ctx-plan-col ctx-plan-all">
        <div className="list-head">
          <span>{t("contextPanel.planListTitle")}</span>
          <span className="count">{history.length}</span>
          {onClearPlans && history.length > 0 ? (
            <ListControl
              kind="clear"
              label={t("contextPanel.planClearAll")}
              onAct={() => {
                void confirmThen(
                  t("contextPanel.planClearAllConfirm", { count: history.length }),
                  onClearPlans,
                );
              }}
            />
          ) : null}
        </div>
        {history.length === 0 ? (
          <div className="ctx-empty">{t("contextPanel.planListEmpty")}</div>
        ) : (
          <div className="ctx-plan-rows">
            {history.map((plan, index) => {
              const planOwner = ownershipOf(plan);
              const title = plan.summary ?? t("contextPanel.planUntitled");
              // The dot marks work a session holds right now. `state: "none"` is a
              // working plan nobody owns, so it gets no dot.
              const live = planOwner !== null && planOwner.state !== "none";
              return (
                <div
                  key={plan.id}
                  className="list-row ctx-plan-row"
                  data-active={plan.id === selected}
                  data-current={plan.id === ownedId}
                  role="button"
                  tabIndex={0}
                  title={title}
                  onClick={() => setSelection(plan.id)}
                  onKeyDown={activationHandler(() => setSelection(plan.id))}
                >
                  {live ? <span className="state" aria-hidden="true" /> : null}
                  <div className="body">
                    <span className="title">
                      {index + 1}. {title}
                    </span>
                    <span className="meta">
                      <span>
                        {plan.completedSteps}/{plan.totalSteps}
                      </span>
                      <span className="sep">·</span>
                      <span>{plan.status}</span>
                      {planOwner?.state === "other" && planOwner.name ? (
                        <>
                          <span className="sep">·</span>
                          <span>{planOwner.name}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  {onReorderPlan ? (
                    <ListControl
                      kind="reorder"
                      label={t("sidebarPanel.moveToTop")}
                      onAct={() => onReorderPlan(plan.id)}
                    />
                  ) : null}
                  {onRemovePlan ? (
                    <ListControl
                      kind="remove"
                      label={t("contextPanel.planRemove")}
                      onAct={() => {
                        const planId = plan.id;
                        void confirmThen(t("contextPanel.planRemoveConfirm"), () =>
                          onRemovePlan(planId),
                        );
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/** A stored plan's detail as the checklist shape `CtxPlan` renders. */
function activePlanFromDetail(detail: PlanDetail): ActivePlan {
  return {
    plan: detail.body,
    summary: detail.summary,
    steps: detail.steps,
    completedStepIds: Object.keys(detail.completions),
    stepResults: Object.fromEntries(
      Object.entries(detail.completions).map(([id, completion]) => [id, completion.result]),
    ),
    status:
      detail.status === "active"
        ? "active"
        : detail.status === "completed"
          ? "finished"
          : "cancelled",
  };
}

/** The title and progress of a plan, above its steps. Shared by the loaded plan and the
 *  placeholder shown while its detail is still in flight. */
function PlanHead({ title, done, total }: { title: string; done: number; total: number }) {
  return (
    <div className="ctx-section-head">
      <div className="ctx-section-title">{title}</div>
      <div className="ctx-plan-progress">
        {done}/{total}
      </div>
    </div>
  );
}

function CtxPlan({ plan }: { plan: ActivePlan }) {
  const done = new Set(plan.completedStepIds);
  const finished = plan.steps.filter((step) => done.has(step.id)).length;
  const runningId = plan.steps.find((step) => !done.has(step.id))?.id;
  return (
    <div className="ctx-plan">
      <PlanHead
        title={plan.summary ?? t("contextPanel.activePlanTitle")}
        done={finished}
        total={plan.steps.length}
      />
      {plan.steps.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.activePlanEmpty")}</div>
      ) : (
        <ol className="ctx-plan-list">
          {plan.steps.map((step) => {
            const isDone = done.has(step.id);
            const isRunning = step.id === runningId;
            return (
              <li
                key={step.id}
                className="ctx-plan-step"
                data-state={isDone ? "done" : isRunning ? "running" : "queued"}
              >
                <span className="ctx-plan-check" aria-hidden="true">
                  {isDone ? "✓" : isRunning ? "•" : ""}
                </span>
                <div>
                  <div className="ctx-plan-title">{step.title}</div>
                  <div className="ctx-plan-action">{step.action}</div>
                  {plan.stepResults[step.id] ? (
                    <div className="ctx-plan-result">{plan.stepResults[step.id]}</div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

type TreeNode =
  | { kind: "dir"; depth: number; name: string; key: string }
  | { kind: "file"; depth: number; name: string; path: string; key: string; status: "c" | "m" };

function resolveContextAbs(path: string, settings: Settings | null): string {
  return toWorkspaceAbsolute(path, settings?.workspaceDir);
}

async function openContextFile(path: string, settings: Settings | null): Promise<void> {
  const abs = resolveContextAbs(path, settings);
  // Reveal the file in the OS file explorer (parent folder with the item
  // selected); openPath is only the last resort. The workspace lets the
  // Rust side resolve bare references to their real location.
  try {
    await invoke("reveal_in_explorer", {
      path: abs,
      workspace: settings?.workspaceDir ?? null,
    });
  } catch {
    await openPath(abs);
  }
}

function buildSessionTree(files: SessionFile[]): TreeNode[] {
  const sorted = [...files].sort((a, b) =>
    a.path.replace(/\\/g, "/").localeCompare(b.path.replace(/\\/g, "/")),
  );
  const out: TreeNode[] = [];
  const seenDirs = new Set<string>();
  for (const f of sorted) {
    const displayPath = f.path.replace(/\\/g, "/");
    const parts = displayPath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? "";
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (!seenDirs.has(prefix)) {
        seenDirs.add(prefix);
        out.push({ kind: "dir", depth: i, name: seg, key: `d:${prefix}` });
      }
    }
    const leaf = parts[parts.length - 1] ?? "";
    out.push({
      kind: "file",
      depth: parts.length - 1,
      name: leaf,
      path: displayPath,
      key: `f:${f.path}`,
      status: f.status,
    });
  }
  return out;
}

/** A side-panel block whose header collapses its body. */
function CtxCollapsible({
  title,
  right,
  defaultCollapsed = false,
  children,
  onCollapsedChange,
}: {
  title: string;
  right?: ReactNode;
  defaultCollapsed?: boolean;
  children: ReactNode;
  /** Reports collapse state so a parent can pause background work (polling) while hidden. */
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const onCollapsedChangeRef = useRef(onCollapsedChange);
  onCollapsedChangeRef.current = onCollapsedChange;
  useEffect(() => {
    onCollapsedChangeRef.current?.(collapsed);
  }, [collapsed]);
  return (
    <div className="ctx-block">
      <div className="h">
        <button
          type="button"
          className="ctx-collapse"
          aria-expanded={!collapsed}
          aria-label={title}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="ctx-chev" aria-hidden="true">
            <I.chevR size={12} style={{ transform: collapsed ? "none" : "rotate(90deg)" }} />
          </span>
          <span>{title}</span>
        </button>
        <span className="right">{right}</span>
      </div>
      {collapsed ? null : children}
    </div>
  );
}

function CtxFiles({ files, settings }: { files: SessionFile[]; settings: Settings | null }) {
  const tree = useMemo(() => buildSessionTree(files), [files]);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  return (
    <CtxCollapsible
      title={t("contextPanel.filesTitle")}
      right={files.length === 0 ? "-" : t("contextPanel.filesCount", { count: files.length })}
    >
      <div className="tree">
        {files.length === 0 ? (
          <div className="ctx-empty">{t("contextPanel.noFilesMsg")}</div>
        ) : (
          tree.map((n) =>
            n.kind === "dir" ? (
              <div
                className="node"
                key={n.key}
                data-d={n.depth}
                data-kind="dir"
                style={{ paddingLeft: 4 + n.depth * 14 }}
              >
                <span className="ico">
                  <I.folder size={12} />
                </span>
                <span className="nm">{n.name}/</span>
              </div>
            ) : (
              <div
                className="node"
                key={n.key}
                data-d={n.depth}
                data-kind="file"
                title={n.path}
                style={{ paddingLeft: 4 + n.depth * 14 }}
                onClick={() => void openContextFile(n.path, settings)}
                onKeyDown={activationHandler(() => void openContextFile(n.path, settings))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, path: n.path });
                }}
              >
                <span className="ico">
                  <I.file size={12} />
                </span>
                <span className="node-text">
                  <span className="nm">{n.name}</span>
                  <span className="full-path">{n.path}</span>
                </span>
                <span
                  className="dot"
                  data-s={n.status}
                  title={
                    n.status === "m"
                      ? t("contextPanel.fileModified")
                      : t("contextPanel.fileInContext")
                  }
                />
                <button
                  type="button"
                  className="tree-action"
                  aria-label={t("contextPanel.openFile", { path: n.path })}
                  title={t("contextPanel.openFile", { path: n.path })}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openContextFile(n.path, settings);
                  }}
                >
                  <I.file size={12} />
                </button>
                <button
                  type="button"
                  className="tree-action"
                  aria-label={t("contextPanel.copyPath", { path: n.path })}
                  title={t("contextPanel.copyPath", { path: n.path })}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard?.writeText(n.path);
                  }}
                >
                  <I.copy size={12} />
                </button>
              </div>
            ),
          )
        )}
      </div>
      {menu ? (
        <FileMenu
          anchor={{ x: menu.x, y: menu.y }}
          abs={resolveContextAbs(menu.path, settings)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </CtxCollapsible>
  );
}

type GitEntryKind = "modified" | "added" | "deleted" | "renamed" | "untracked";

type GitStatusResult = {
  isRepo: boolean;
  branch?: string | null;
  entries: Array<{ path: string; kind: GitEntryKind }>;
};

const GIT_KIND_BADGE: Record<GitEntryKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

const GIT_KIND_LABEL: Record<GitEntryKind, TKey> = {
  modified: "contextPanel.gitKindModified",
  added: "contextPanel.gitKindAdded",
  deleted: "contextPanel.gitKindDeleted",
  renamed: "contextPanel.gitKindRenamed",
  untracked: "contextPanel.gitKindUntracked",
};

/** The Files tab's Git section: the workspace's git status. Always rendered — a
 *  workspace without a repo says so, so a later `git init` lights it up live.
 *  Workspace mutations aren't pushed to the UI, so it refetches on the agent's
 *  edits (sessionFiles) and workspace changes and polls while mounted, catching
 *  a repo created outside the app. */
const GIT_POLL_MS = 3000;

function CtxGit({
  settings,
  files,
  active,
}: {
  settings: Settings | null;
  files: SessionFile[];
  active: boolean;
}) {
  const workspaceDir = settings?.workspaceDir;
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [nonce, setNonce] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const signature = useMemo(() => files.map((f) => `${f.status}:${f.path}`).join("|"), [files]);

  useEffect(() => {
    // The 3s Tauri invoke only runs for the visible tab while the section is
    // expanded; hidden tabs (display:none) and the collapsed header skip it.
    if (!workspaceDir || collapsed || !active) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await invoke<GitStatusResult>("git_status", { root: workspaceDir });
        if (alive) setStatus(res ?? null);
      } catch {
        if (alive) setStatus(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), GIT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workspaceDir, signature, nonce, collapsed, active]);

  const repo = status?.isRepo === true;
  const branch = status?.branch;
  const entries = status?.entries ?? [];
  return (
    <CtxCollapsible
      title={t("contextPanel.gitTitle")}
      onCollapsedChange={setCollapsed}
      right={
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {repo && branch ? <span className="git-branch">{branch}</span> : null}
          {repo
            ? entries.length === 0
              ? t("contextPanel.gitClean")
              : t("contextPanel.gitCount", { count: entries.length })
            : null}
          <button
            type="button"
            className="mini-btn"
            title={t("contextPanel.gitRefresh")}
            aria-label={t("contextPanel.gitRefresh")}
            onClick={() => {
              setCollapsed(false);
              setNonce((n) => n + 1);
            }}
          >
            <I.refresh size={11} />
          </button>
        </span>
      }
    >
      {status === null ? null : !repo ? (
        <div className="ctx-empty">{t("contextPanel.gitNoRepo")}</div>
      ) : entries.length === 0 ? null : (
        <div className="tree">
          {entries.map((e) => (
            <div
              className="node"
              key={`${e.kind}:${e.path}`}
              data-kind="file"
              title={e.path}
              style={{ paddingLeft: 4 }}
              onClick={() => void openContextFile(e.path, settings)}
              onKeyDown={activationHandler(() => void openContextFile(e.path, settings))}
            >
              <span className="ico">
                <I.file size={12} />
              </span>
              <span className="node-text">
                <span className="nm">{e.path}</span>
              </span>
              <span className="git-kind" data-k={e.kind} title={t(GIT_KIND_LABEL[e.kind])}>
                {GIT_KIND_BADGE[e.kind]}
              </span>
            </div>
          ))}
        </div>
      )}
    </CtxCollapsible>
  );
}

type OllamaNumberKey = Exclude<keyof NonNullable<Settings["ollamaGeneration"]>, "keepAlive">;

const OLLAMA_NUMBER_FIELDS: Array<{
  key: OllamaNumberKey;
  labelKey: TKey;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  advanced?: boolean;
}> = [
  {
    key: "temperature",
    labelKey: "contextPanel.ollamaTemperature",
    min: 0,
    max: 2,
    step: 0.05,
    defaultValue: 0.8,
  },
  {
    key: "topP",
    labelKey: "contextPanel.ollamaTopP",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.9,
  },
  {
    key: "topK",
    labelKey: "contextPanel.ollamaTopK",
    min: 0,
    max: 1_000,
    step: 1,
    defaultValue: 40,
  },
  { key: "minP", labelKey: "contextPanel.ollamaMinP", min: 0, max: 1, step: 0.01, defaultValue: 0 },
  {
    key: "seed",
    labelKey: "contextPanel.ollamaSeed",
    min: 0,
    max: 2_147_483_647,
    step: 1,
    defaultValue: 0,
    advanced: true,
  },
  {
    key: "repeatPenalty",
    labelKey: "contextPanel.ollamaRepeatPenalty",
    min: 0,
    max: 2,
    step: 0.05,
    defaultValue: 1.1,
    advanced: true,
  },
  {
    key: "repeatLastN",
    labelKey: "contextPanel.ollamaRepeatLastN",
    min: -1,
    max: 1_000_000,
    step: 1,
    defaultValue: 64,
    advanced: true,
  },
  {
    key: "frequencyPenalty",
    labelKey: "contextPanel.ollamaFrequencyPenalty",
    min: -2,
    max: 2,
    step: 0.05,
    defaultValue: 0,
    advanced: true,
  },
  {
    key: "presencePenalty",
    labelKey: "contextPanel.ollamaPresencePenalty",
    min: -2,
    max: 2,
    step: 0.05,
    defaultValue: 0,
    advanced: true,
  },
];

interface OllamaPreset {
  id: string;
  labelKey: TKey;
  tooltipKey: TKey;
  patch: NonNullable<SettingsPatch["ollamaGeneration"]>;
}

const OLLAMA_SAMPLING_PRESETS: OllamaPreset[] = [
  {
    id: "default",
    labelKey: "contextPanel.ollamaPresetDefault",
    tooltipKey: "contextPanel.ollamaPresetDefaultTooltip",
    patch: {
      temperature: null,
      topP: null,
      topK: null,
      minP: null,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "coding",
    labelKey: "contextPanel.ollamaPresetCoding",
    tooltipKey: "contextPanel.ollamaPresetCodingTooltip",
    patch: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      minP: null,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "balanced",
    labelKey: "contextPanel.ollamaPresetBalanced",
    tooltipKey: "contextPanel.ollamaPresetBalancedTooltip",
    patch: {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "creative",
    labelKey: "contextPanel.ollamaPresetCreative",
    tooltipKey: "contextPanel.ollamaPresetCreativeTooltip",
    patch: {
      temperature: 1.0,
      topP: 0.95,
      topK: 50,
      minP: null,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "anti-loop",
    labelKey: "contextPanel.ollamaPresetAntiLoop",
    tooltipKey: "contextPanel.ollamaPresetAntiLoopTooltip",
    patch: {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: null,
      seed: null,
      repeatPenalty: 1.1,
      repeatLastN: 64,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
];

function isPresetActive(
  preset: OllamaPreset,
  overrides: Settings["ollamaGenerationOverrides"],
): boolean {
  for (const field of OLLAMA_NUMBER_FIELDS) {
    const expected = preset.patch[field.key];
    const actual = overrides?.[field.key];
    if (expected === null) {
      if (actual !== undefined) return false;
    } else if (expected !== undefined) {
      if (actual !== expected) return false;
    }
  }
  return true;
}

function OllamaNumberField({
  field,
  value,
  defaultValue,
  overridden,
  onSaveSettings,
}: {
  field: (typeof OLLAMA_NUMBER_FIELDS)[number];
  value: number | undefined;
  defaultValue: number;
  overridden: boolean;
  onSaveSettings?: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [editing, setEditing] = useState(false);

  // A live $settings round-trip updates `value`: only bleed it back into the
  // draft while the field is idle so an in-progress edit isn't clobbered.
  useEffect(() => {
    if (!editing) setDraft(value === undefined ? "" : String(value));
  }, [value, editing]);

  // Save `raw` as a number if it parses to a complete, in-range value. Returns
  // true on success so callers can tell a committed value from a mid-keystroke
  // draft (e.g. a trailing "." or lone "-") that must not be persisted.
  const commitValue = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!/^-?\d*\.?\d+$/.test(trimmed)) return false;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) return false;
    onSaveSettings?.({ ollamaGeneration: { [field.key]: parsed } });
    return true;
  };

  const finishEditing = () => {
    // Complete valid values were already persisted by onChange. On blur, only
    // discard an incomplete or invalid draft instead of sending a duplicate.
    const trimmed = draft.trim();
    if (trimmed && !/^-?\d*\.?\d+$/.test(trimmed)) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    const parsed = Number(trimmed);
    if (trimmed && (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max)) {
      setDraft(value === undefined ? "" : String(value));
    }
  };

  return (
    <label className="ollama-field">
      <span>{t(field.labelKey)}</span>
      <span className="ollama-field-control">
        <input
          type="number"
          value={draft}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={String(defaultValue)}
          aria-label={t(field.labelKey)}
          onChange={(event) => {
            setDraft(event.target.value);
            // Complete valid values reach the daemon in the same event so the
            // current agent's next request cannot race a deferred settings save.
            commitValue(event.target.value);
          }}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            finishEditing();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {overridden ? (
          <button
            type="button"
            className="mini-btn"
            title={t("contextPanel.ollamaResetTooltip")}
            onClick={() => onSaveSettings?.({ ollamaGeneration: { [field.key]: null } })}
          >
            {t("contextPanel.contextWindowReset")}
          </button>
        ) : null}
      </span>
    </label>
  );
}

function OllamaGenerationControls({
  settings,
  onSaveSettings,
}: {
  settings: Settings;
  onSaveSettings?: (patch: SettingsPatch) => void;
}) {
  const values = settings.ollamaGeneration;
  const overrides = settings.ollamaGenerationOverrides;
  const modelDefaults = settings.ollamaModelDefaults;
  const [keepAlive, setKeepAlive] = useState(values?.keepAlive ?? "30m");
  const [keepAliveEditing, setKeepAliveEditing] = useState(false);
  useEffect(() => {
    if (!keepAliveEditing) setKeepAlive(values?.keepAlive ?? "30m");
  }, [values?.keepAlive, keepAliveEditing]);

  const finishKeepAliveEditing = () => {
    if (!keepAlive.trim()) setKeepAlive(values?.keepAlive ?? "30m");
  };

  const fields = (advanced: boolean) =>
    OLLAMA_NUMBER_FIELDS.filter((field) => Boolean(field.advanced) === advanced).map((field) => (
      <OllamaNumberField
        key={field.key}
        field={field}
        value={values?.[field.key]}
        defaultValue={modelDefaults?.[field.key] ?? field.defaultValue}
        overridden={overrides?.[field.key] !== undefined}
        onSaveSettings={onSaveSettings}
      />
    ));

  return (
    <div className="ctx-block ollama-generation" data-testid="ollama-generation-settings">
      <div className="h">
        <span>{t("contextPanel.ollamaGeneration")}</span>
        <span className="right">{t("contextPanel.ollamaNativeApi")}</span>
      </div>
      <p className="ollama-help">{t("contextPanel.ollamaGenerationHelp")}</p>
      <div className="ollama-presets" role="group" aria-label={t("contextPanel.ollamaGeneration")}>
        {OLLAMA_SAMPLING_PRESETS.map((preset) => {
          const active = isPresetActive(preset, overrides);
          return (
            <button
              key={preset.id}
              type="button"
              className="ollama-preset-btn"
              data-active={active ? "true" : undefined}
              title={t(preset.tooltipKey)}
              onClick={() => onSaveSettings?.({ ollamaGeneration: preset.patch })}
            >
              {t(preset.labelKey)}
            </button>
          );
        })}
      </div>
      <div className="ollama-fields">{fields(false)}</div>
      <details className="ollama-advanced">
        <summary>{t("contextPanel.ollamaAdvanced")}</summary>
        <div className="ollama-fields">
          {fields(true)}
          <label className="ollama-field">
            <span>{t("contextPanel.ollamaKeepAlive")}</span>
            <span className="ollama-field-control">
              <input
                value={keepAlive}
                aria-label={t("contextPanel.ollamaKeepAlive")}
                list="ollama-keep-alive-options"
                onChange={(event) => {
                  setKeepAlive(event.target.value);
                  const value = event.target.value.trim();
                  if (value) onSaveSettings?.({ ollamaGeneration: { keepAlive: value } });
                }}
                onFocus={() => setKeepAliveEditing(true)}
                onBlur={() => {
                  setKeepAliveEditing(false);
                  finishKeepAliveEditing();
                }}
              />
              {overrides?.keepAlive !== undefined ? (
                <button
                  type="button"
                  className="mini-btn"
                  title={t("contextPanel.ollamaResetTooltip")}
                  onClick={() => onSaveSettings?.({ ollamaGeneration: { keepAlive: null } })}
                >
                  {t("contextPanel.contextWindowReset")}
                </button>
              ) : null}
            </span>
          </label>
          <datalist id="ollama-keep-alive-options">
            <option value="0" />
            <option value="5m" />
            <option value="30m" />
            <option value="1h" />
            <option value="-1" />
          </datalist>
        </div>
      </details>
    </div>
  );
}

/** One labelled range control in the Parameters tab. */
function CtxSliderRow({
  label,
  value,
  display,
  min,
  max,
  step,
  boundMin,
  boundMax,
  ariaLabel,
  onChange,
  onCommit,
  reset,
  desc,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  boundMin: string;
  boundMax: string;
  ariaLabel: string;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  reset?: ReactNode;
  desc?: ReactNode;
}) {
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{label}</span>
        <span className="right" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>{display}</span>
          {reset}
        </span>
      </div>
      <div className="ctx-slider-container">
        <input
          type="range"
          className="ctx-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={ariaLabel}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={(e) => onCommit(Number(e.currentTarget.value))}
          onKeyUp={(e) => onCommit(Number(e.currentTarget.value))}
        />
        <div className="ctx-slider-bounds">
          <span>{boundMin}</span>
          <span>{boundMax}</span>
        </div>
      </div>
      {desc}
    </div>
  );
}

/** One on/off pair with a description; omit the aria labels for an unlabelled pair. */
function CtxToggleRow({
  label,
  desc,
  onLabel,
  offLabel,
  enabled,
  onToggle,
  onAriaLabel,
  offAriaLabel,
}: {
  label: string;
  desc: ReactNode;
  onLabel: string;
  offLabel: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onAriaLabel?: string;
  offAriaLabel?: string;
}) {
  const labelled = onAriaLabel !== undefined;
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{label}</span>
        <span className="right">
          <div className="seg-ctrl" style={{ fontSize: "10.5px" }}>
            <button
              type="button"
              aria-label={onAriaLabel}
              aria-pressed={labelled ? enabled : undefined}
              data-on={enabled}
              onClick={() => onToggle(true)}
            >
              {onLabel}
            </button>
            <button
              type="button"
              aria-label={offAriaLabel}
              aria-pressed={labelled ? !enabled : undefined}
              data-on={!enabled}
              onClick={() => onToggle(false)}
            >
              {offLabel}
            </button>
          </div>
        </span>
      </div>
      <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: 6, lineHeight: 1.4 }}>
        {desc}
      </div>
    </div>
  );
}

function CtxParameters({
  settings,
  usage,
  onSaveSettings,
}: {
  settings: Settings | null;
  usage: UsageStats;
  onSaveSettings?: (patch: SettingsPatch) => void;
}) {
  const bounds = settings?.contextTokensBounds ?? { min: 128_000, max: 1_000_000 };
  const effectiveTokens = settings?.contextTokens ?? usage.ctxMax ?? 300_000;
  const clampedTokens = Math.min(bounds.max, Math.max(bounds.min, effectiveTokens));
  const [sliderValue, setSliderValue] = useState<number>(clampedTokens);

  useEffect(() => {
    setSliderValue(clampedTokens);
  }, [clampedTokens]);

  const commit = (val: number) => {
    onSaveSettings?.({ contextTokens: Math.min(bounds.max, Math.max(bounds.min, val)) });
  };

  const effectiveTriggerPct = Math.round((settings?.autoCompactTrigger ?? 0.8) * 100);
  const clampedTriggerPct = Math.min(95, Math.max(50, effectiveTriggerPct));
  const [triggerPct, setTriggerPct] = useState<number>(clampedTriggerPct);

  useEffect(() => {
    setTriggerPct(clampedTriggerPct);
  }, [clampedTriggerPct]);

  const commitTrigger = (pct: number) => {
    const next = Math.min(95, Math.max(50, pct));
    onSaveSettings?.({ autoCompactTrigger: next / 100 });
  };

  const effectiveDupTokens = settings?.duplicateSessionTokens ?? 50_000;
  const clampedDupTokens = Math.min(1_000_000, Math.max(1_000, effectiveDupTokens));
  const [dupTokensValue, setDupTokensValue] = useState<number>(clampedDupTokens);

  useEffect(() => {
    setDupTokensValue(clampedDupTokens);
  }, [clampedDupTokens]);

  const commitDupTokens = (val: number) => {
    const next = Math.min(1_000_000, Math.max(1_000, val));
    onSaveSettings?.({ duplicateSessionTokens: next });
  };

  return (
    <>
      <CtxSliderRow
        label={t("contextPanel.contextWindow")}
        value={sliderValue}
        display={`${fmtCompact(sliderValue)} (${sliderValue.toLocaleString()})`}
        min={bounds.min}
        max={bounds.max}
        step={bounds.min <= 1_024 ? 256 : 1_000}
        boundMin={fmtCompact(bounds.min)}
        boundMax={fmtCompact(bounds.max)}
        ariaLabel={t("contextPanel.contextWindow")}
        onChange={setSliderValue}
        onCommit={commit}
        reset={
          settings?.contextTokens !== undefined && settings?.contextTokens !== null ? (
            <button
              type="button"
              className="mini-btn"
              title={t("contextPanel.contextWindowResetTooltip")}
              onClick={() => onSaveSettings?.({ contextTokens: null })}
            >
              {t("contextPanel.contextWindowReset")}
            </button>
          ) : null
        }
      />

      <CtxToggleRow
        label={t("contextPanel.autoCompact")}
        desc={
          settings?.autoCompact === false
            ? t("contextPanel.autoCompactDisabledDesc")
            : t("contextPanel.autoCompactEnabledDesc")
        }
        onLabel={t("contextPanel.autoCompactEnabled")}
        offLabel={t("contextPanel.autoCompactDisabled")}
        enabled={settings?.autoCompact !== false}
        onToggle={(enabled) => onSaveSettings?.({ autoCompact: enabled })}
        onAriaLabel={t("contextPanel.enableAutoCompact")}
        offAriaLabel={t("contextPanel.disableAutoCompact")}
      />

      <CtxSliderRow
        label={t("contextPanel.autoCompactTrigger")}
        value={triggerPct}
        display={t("contextPanel.autoCompactTriggerValue", { pct: triggerPct })}
        min={50}
        max={95}
        step={5}
        boundMin="50%"
        boundMax="95%"
        ariaLabel={t("contextPanel.autoCompactTrigger")}
        onChange={setTriggerPct}
        onCommit={commitTrigger}
        reset={
          settings?.autoCompactTrigger !== undefined && settings?.autoCompactTrigger !== null ? (
            <button
              type="button"
              className="mini-btn"
              title={t("contextPanel.autoCompactTriggerResetTooltip")}
              onClick={() => onSaveSettings?.({ autoCompactTrigger: null })}
            >
              {t("contextPanel.contextWindowReset")}
            </button>
          ) : null
        }
      />

      <CtxToggleRow
        label={t("contextPanel.elevation")}
        desc={
          settings?.elevationEnabled === true
            ? t("contextPanel.elevationEnabledDesc")
            : t("contextPanel.elevationDisabledDesc")
        }
        onLabel={t("contextPanel.elevationEnabled")}
        offLabel={t("contextPanel.elevationDisabled")}
        enabled={settings?.elevationEnabled === true}
        onToggle={(enabled) => onSaveSettings?.({ elevationEnabled: enabled })}
        onAriaLabel={t("contextPanel.enableElevation")}
        offAriaLabel={t("contextPanel.disableElevation")}
      />

      <CtxToggleRow
        label={t("contextPanel.repetitionGuard")}
        desc={
          settings?.repetitionGuardEnabled === true
            ? t("contextPanel.repetitionGuardEnabledDesc")
            : t("contextPanel.repetitionGuardDisabledDesc")
        }
        onLabel={t("contextPanel.repetitionGuardEnabled")}
        offLabel={t("contextPanel.repetitionGuardDisabled")}
        enabled={settings?.repetitionGuardEnabled === true}
        onToggle={(enabled) => onSaveSettings?.({ repetitionGuardEnabled: enabled })}
        onAriaLabel={t("contextPanel.enableRepetitionGuard")}
        offAriaLabel={t("contextPanel.disableRepetitionGuard")}
      />

      <CtxToggleRow
        label={t("contextPanel.questionTimer")}
        desc={
          settings?.questionTimerEnabled === true
            ? t("contextPanel.questionTimerEnabledDesc")
            : t("contextPanel.questionTimerDisabledDesc")
        }
        onLabel={t("contextPanel.questionTimerEnabled")}
        offLabel={t("contextPanel.questionTimerDisabled")}
        enabled={settings?.questionTimerEnabled === true}
        onToggle={(enabled) => onSaveSettings?.({ questionTimerEnabled: enabled })}
        onAriaLabel={t("contextPanel.enableQuestionTimer")}
        offAriaLabel={t("contextPanel.disableQuestionTimer")}
      />

      <CtxSliderRow
        label={t("contextPanel.duplicateSessionLimit")}
        value={dupTokensValue}
        display={`${fmtCompact(dupTokensValue)} (${dupTokensValue.toLocaleString()})`}
        min={1_000}
        max={1_000_000}
        step={1_000}
        boundMin="1K"
        boundMax="1M"
        ariaLabel={t("contextPanel.duplicateSessionLimit")}
        onChange={setDupTokensValue}
        onCommit={commitDupTokens}
        reset={
          settings?.duplicateSessionTokens !== undefined &&
          settings?.duplicateSessionTokens !== null ? (
            <button
              type="button"
              className="mini-btn"
              title={t("contextPanel.duplicateSessionLimitResetTooltip")}
              onClick={() => onSaveSettings?.({ duplicateSessionTokens: null })}
            >
              {t("contextPanel.contextWindowReset")}
            </button>
          ) : null
        }
        desc={
          <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: 6, lineHeight: 1.4 }}>
            {t("contextPanel.duplicateSessionLimitDesc")}
          </div>
        }
      />

      <CtxToggleRow
        label={t("contextPanel.duplicateSessionAutoProceed")}
        desc={
          // On unless the user turned it off: the daemon's own default is on, so an
          // unset setting must not read here as "off".
          settings?.duplicateSessionAutoProceed !== false
            ? t("contextPanel.duplicateSessionAutoProceedOnDesc")
            : t("contextPanel.duplicateSessionAutoProceedOffDesc")
        }
        onLabel={t("contextPanel.duplicateSessionAutoProceedOn")}
        offLabel={t("contextPanel.duplicateSessionAutoProceedOff")}
        enabled={settings?.duplicateSessionAutoProceed !== false}
        onToggle={(enabled) => onSaveSettings?.({ duplicateSessionAutoProceed: enabled })}
        onAriaLabel={t("contextPanel.enableDuplicateSessionAutoProceed")}
        offAriaLabel={t("contextPanel.disableDuplicateSessionAutoProceed")}
      />

      {settings &&
      (settings.modelEndpoint?.provider === "ollama" ||
        settings.subagentModelEndpoint?.provider === "ollama") ? (
        <OllamaGenerationControls settings={settings} onSaveSettings={onSaveSettings} />
      ) : null}
    </>
  );
}

/** Where a capability came from: the user's own install, a Reasonix+ managed built-in, or a
 *  plugin's bundle. */
type Origin = "standalone" | "builtin" | "plugin";

/** Provenance of one capability row. A plugin's tag reads as its name alone: the violet
 *  treatment already says "plugin", so repeating the word only eats the narrow panel's width. */
function OriginTag({ origin, owner }: { origin: Origin; owner?: string }) {
  const full = t(
    origin === "plugin"
      ? "contextPanel.originPlugin"
      : origin === "builtin"
        ? "contextPanel.originBuiltin"
        : "contextPanel.originStandalone",
    { name: owner ?? "" },
  ).trim();
  const label = origin === "plugin" && owner ? owner : full;
  return (
    <span className="ctx-tag" data-k={origin} title={full}>
      {label}
    </span>
  );
}

/** One inventory row: an MCP server, a skill, or a plugin. */
type CapabilityItem = {
  key: string;
  icon: ReactNode;
  name: string;
  /** Muted line under the name: transport and status, counts, or a description. */
  meta: ReactNode;
  /** Second muted line, only where there is more to say (a manifest or SKILL.md error). */
  note?: ReactNode;
  /** Where the row came from. Omitted where the surface already says it (the inventory itself,
   *  or a list scoped to one source by the picker above it). */
  origin?: Origin;
  owner?: string;
  /** Live health of the row, drawn as a dot. Omitted where every listed row is by definition
   *  running, which is what the Skills and Plugins tabs show. */
  state?: "ok" | "off" | "pending";
  /** What the state dot means, for its hover title. */
  stateTitle?: string;
  /** Hover title for the whole row: a path, a plugin slug. */
  title?: string;
};

/** The body shared by the MCP, Skills and Plugins tabs: a header pair, an optional source
 *  picker, one line for an empty inventory, then one row per item. */
function CapabilityList({
  title,
  summary,
  empty,
  filter,
  items,
}: {
  title: string;
  summary: string;
  empty: string;
  /** Scopes the rows to one source; omitted by inventories that always fit. */
  filter?: ReactNode;
  items: CapabilityItem[];
}) {
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{title}</span>
        <span className="right">{items.length === 0 ? "-" : summary}</span>
      </div>
      {filter}
      {items.length === 0 ? (
        <div className="ctx-empty">{empty}</div>
      ) : (
        items.map((item) => (
          <div key={item.key} style={{ marginBottom: 6 }} title={item.title}>
            <div className="mcp-row" style={{ marginBottom: 6 }}>
              <span className="ico">{item.icon}</span>
              <div className="body">
                <div className="n">{item.name}</div>
                <div className="m">{item.meta}</div>
                {item.note ? <div className="m">{item.note}</div> : null}
              </div>
              {item.origin ? <OriginTag origin={item.origin} owner={item.owner} /> : null}
              {item.state ? (
                <span className="status" data-s={item.state} title={item.stateTitle} />
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** A server's words after its transport: why it failed, or how far it got. */
function mcpStatusSuffix(spec: McpSpecInfo): string {
  if (spec.statusReason) return spec.statusReason;
  if (spec.status === "connected") {
    return typeof spec.toolCount === "number"
      ? t("contextPanel.mcpTools", { count: spec.toolCount })
      : t("contextPanel.mcpReady");
  }
  if (spec.status === "handshake") return t("contextPanel.mcpConnecting");
  if (spec.status === "disabled") return t("contextPanel.mcpDisabled");
  if (spec.status === "failed") return t("contextPanel.mcpFailed");
  return t("contextPanel.mcpConfigured");
}

/** A server's dot state: live, refused, or still coming up. */
function mcpState(spec: McpSpecInfo): CapabilityItem["state"] {
  if (spec.status === "connected") return "ok";
  return spec.status === "failed" || spec.parseError ? "off" : "pending";
}

function CtxMcp({ specs, bridged }: { specs: McpSpecInfo[]; bridged: boolean }) {
  // The config may list servers this session never enabled; show only the session's set.
  const sessionSpecs = specs.filter((s) => !s.sessionDisabled);
  const readyCount = sessionSpecs.filter((s) => s.status === "connected").length;
  return (
    <CapabilityList
      title={t("contextPanel.mcpTitle")}
      summary={
        bridged
          ? t("contextPanel.mcpReadyAll", { count: sessionSpecs.length })
          : t("contextPanel.mcpReadySome", { ready: readyCount, count: sessionSpecs.length })
      }
      empty={t("contextPanel.mcpEmpty")}
      items={sessionSpecs.map((spec) => {
        const status = mcpStatusSuffix(spec);
        return {
          key: spec.raw,
          icon: <I.wrench size={12} />,
          name: spec.name ?? spec.summary,
          meta: `${spec.transport} · ${status}`,
          origin: spec.builtin ? "builtin" : spec.plugin ? "plugin" : "standalone",
          owner: spec.plugin,
          state: mcpState(spec),
          stateTitle: status,
        };
      })}
    />
  );
}

/** One skill this chat runs. A plugin's skill always names its plugin; a standalone one never
 *  does, so the source bucket can be read off the origin without a fallback. */
type SkillRow = {
  key: string;
  name: string;
  description: string;
  path: string;
  error?: string;
} & ({ origin: "standalone" } | { origin: "plugin"; owner: string });

/** The skills this chat runs: standalone ones frozen at session start, then each running
 *  plugin's bundle. A skill or plugin switched off in this chat stays out, exactly as a
 *  session-disabled MCP server does; Settings owns the full inventory. */
function skillRows(skills: SkillInfo[], plugins: PluginInfo[]): SkillRow[] {
  const rows: SkillRow[] = skills
    .filter((skill) => skill.active)
    .map((skill) => ({
      key: `skill:${skill.id}`,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      origin: "standalone",
      ...(skill.error ? { error: skill.error } : {}),
    }));
  for (const plugin of plugins) {
    if (!plugin.active) continue;
    for (const skill of plugin.skills) {
      rows.push({
        key: `plugin:${plugin.slug}:${skill.path}`,
        name: skill.name,
        description: skill.description,
        path: `${plugin.slug}/${skill.path}`,
        origin: "plugin",
        owner: plugin.slug,
      });
    }
  }
  const rank = (row: SkillRow): number => (row.origin === "standalone" ? 0 : 1);
  const owner = (row: SkillRow): string => (row.origin === "plugin" ? row.owner : "");
  return rows.sort(
    (a, b) => rank(a) - rank(b) || owner(a).localeCompare(owner(b)) || a.name.localeCompare(b.name),
  );
}

/** One source of skills: the user's own installs, or one plugin's bundle. */
type SkillSource = { id: string; rows: SkillRow[] };

/** Picker values for the two buckets that are not a plugin slug. Safe to keep in the same
 *  value space: `pluginSlug` strips every character outside [a-z0-9-], so no installed plugin
 *  can take one of these names. */
const SKILL_SOURCE_ALL = "__all";
const SKILL_SOURCE_STANDALONE = "__standalone";

/** Past this many rows a single mixed list stops being scannable: one plugin alone can ship
 *  hundreds of skills, so above the limit the tab opens scoped to one source. */
const SKILL_LIST_SCAN_LIMIT = 20;

/** Skill rows bucketed by the source that ships them, keeping the order they arrived in. */
function skillSources(rows: SkillRow[]): SkillSource[] {
  const groups = new Map<string, SkillSource>();
  for (const row of rows) {
    const id = row.origin === "plugin" ? row.owner : SKILL_SOURCE_STANDALONE;
    const group = groups.get(id);
    if (group) group.rows.push(row);
    else groups.set(id, { id, rows: [row] });
  }
  return [...groups.values()];
}

/** A source's name in the picker: a plugin's display name, or the standalone bucket. */
function skillSourceLabel(id: string, plugins: PluginInfo[]): string {
  if (id === SKILL_SOURCE_STANDALONE) return t("contextPanel.skillsSourceStandalone");
  return plugins.find((plugin) => plugin.slug === id)?.displayName || id;
}

/** The picker that scopes the Skills tab to one source. */
function SkillSourcePicker({
  sources,
  plugins,
  total,
  value,
  onChange,
}: {
  sources: SkillSource[];
  plugins: PluginInfo[];
  /** Rows across every source, for the "all sources" option. */
  total: number;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="ctx-filter">
      <select
        className="ctx-select"
        aria-label={t("contextPanel.skillsSourceLabel")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={SKILL_SOURCE_ALL}>
          {t("contextPanel.skillsSourceAll", { count: total })}
        </option>
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {t("contextPanel.skillsSourceOption", {
              name: skillSourceLabel(source.id, plugins),
              count: source.rows.length,
            })}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The Skills inventory: what this chat enabled, one source at a time so a plugin shipping
 *  hundreds of skills cannot bury the rest of the list. */
function CtxSkills({
  skills,
  plugins,
  onRequest,
  onRequestPlugins,
}: {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  onRequest?: () => void;
  onRequestPlugins?: () => void;
}) {
  // This list spans both snapshots: standalone skills, and the bundle each plugin ships.
  useInventoryRequest(onRequest);
  useInventoryRequest(onRequestPlugins);
  const rows = skillRows(skills, plugins);
  const sources = skillSources(rows);
  // One source needs no picker: there is nothing to scope, so the rows keep their origin tags.
  const pickable = sources.length > 1;
  const [picked, setPicked] = useState<string | null>(null);
  const largest = sources.reduce<SkillSource | undefined>(
    (best, source) => (!best || source.rows.length > best.rows.length ? source : best),
    undefined,
  );
  const opener = rows.length > SKILL_LIST_SCAN_LIMIT ? largest : undefined;
  // An explicit pick holds until that source disappears; otherwise a list too long to scan
  // opens on the source that fills most of it, and a short one opens whole.
  const scope = pickable
    ? (sources.find((source) => source.id === picked) ??
      (picked === SKILL_SOURCE_ALL ? undefined : opener))
    : undefined;
  const selected = scope?.id ?? SKILL_SOURCE_ALL;
  const visible = scope?.rows ?? rows;
  /** The provenance tag of a row, unless the picker above already names its source. */
  const originTag = (row: SkillRow): Pick<CapabilityItem, "origin" | "owner"> => {
    if (scope) return {};
    return row.origin === "plugin"
      ? { origin: "plugin", owner: row.owner }
      : { origin: "standalone" };
  };
  const filter = pickable ? (
    <SkillSourcePicker
      sources={sources}
      plugins={plugins}
      total={rows.length}
      value={selected}
      onChange={setPicked}
    />
  ) : undefined;
  return (
    <CapabilityList
      title={t("contextPanel.skillsTab")}
      summary={t("contextPanel.enabledTotal", { count: visible.length })}
      empty={t("contextPanel.skillsEmpty")}
      filter={filter}
      items={visible.map((row) => ({
        key: row.key,
        icon: <I.bookmark size={12} />,
        name: row.name,
        meta: row.description || t("settings.skillsNoDescription"),
        note: row.error ? (
          <span style={{ color: "var(--danger)" }}>
            {t("settings.skillsReadError", { error: row.error })}
          </span>
        ) : undefined,
        ...originTag(row),
        title: row.path,
      }))}
    />
  );
}

/** The plugins this chat runs and what each ships. Plugins left off stay out of the list, the
 *  same rule the MCP tab applies to session-disabled servers. */
function CtxPlugins({ plugins, onRequest }: { plugins: PluginInfo[]; onRequest?: () => void }) {
  useInventoryRequest(onRequest);
  const running = plugins.filter((plugin) => plugin.active);
  return (
    <CapabilityList
      title={t("contextPanel.pluginsTab")}
      summary={t("contextPanel.enabledTotal", { count: running.length })}
      empty={t("contextPanel.pluginsEmpty")}
      items={running.map((plugin) => ({
        key: plugin.slug,
        icon: <I.plug size={12} />,
        name: plugin.displayName,
        meta: [
          pluginQualifier(plugin),
          t("contextPanel.pluginShips", {
            skills: plugin.skills.length,
            servers: plugin.servers.length,
          }),
        ]
          .filter(Boolean)
          .join(" - "),
        note: plugin.error ? (
          <span style={{ color: "var(--danger)" }}>
            {t("settings.pluginsManifestError", { error: plugin.error })}
          </span>
        ) : (
          plugin.description || t("settings.pluginsNoDescription")
        ),
        title: plugin.slug,
      }))}
    />
  );
}

/** Structured memories open straight into the editor; project/global files stay read-only. */
function isEditableMemory(e: { kind: MemoryEntryInfo["kind"] }): boolean {
  return e.kind === "structured";
}

function CtxMemory({
  entries,
  detail,
  result,
  onRead,
  onWrite,
  onDelete,
  onDismissResult,
}: {
  entries: MemoryEntryInfo[];
  detail: MemoryDetail | null;
  result: { ok: boolean; message: string } | null;
  onRead: (path: string) => void;
  onWrite: (
    scope: "global" | "project",
    name: string,
    description: string,
    body: string,
    opts?: MemoryWriteOptions,
  ) => void;
  onDelete: (path: string) => void;
  onDismissResult: () => void;
}) {
  const [composing, setComposing] = useState(false);
  /** Non-null while the composer edits an existing entry (vs. creating one). */
  const [editTarget, setEditTarget] = useState<MemoryDetail | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [body, setBody] = useState("");
  /** Path whose detail must load before the composer can prefill for editing. */
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingEdit || detail?.path !== pendingEdit) return;
    setEditTarget(detail);
    setName(detail.name);
    setScope(detail.scope);
    setBody(detail.body);
    setComposing(true);
    setPendingEdit(null);
  }, [pendingEdit, detail]);

  const closeComposer = (): void => {
    setName("");
    setBody("");
    setEditTarget(null);
    setComposing(false);
  };

  const submit = (): void => {
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) return;
    if (editTarget) {
      const renamed = editTarget.name !== trimmedName || editTarget.scope !== scope;
      onWrite(
        scope,
        trimmedName,
        editTarget.description || trimmedBody.slice(0, 150),
        trimmedBody,
        {
          ...(editTarget.type ? { type: editTarget.type } : {}),
          ...(editTarget.priority ? { priority: editTarget.priority } : {}),
          ...(editTarget.expires ? { expires: editTarget.expires } : {}),
          ...(renamed ? { originalPath: editTarget.path } : {}),
        },
      );
    } else {
      onWrite(scope, trimmedName, trimmedBody.slice(0, 150), trimmedBody);
    }
    closeComposer();
  };

  /** Opening a card edits it in place: structured entries prefill the composer from
   *  their fetched body, while freeform files stay read-only. */
  const openEntry = (m: MemoryEntryInfo): void => {
    closeComposer();
    if (isEditableMemory(m)) setPendingEdit(m.path);
    onRead(m.path);
  };

  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.memoryTitle")}</span>
      </div>

      {result ? (
        <div className={`mem-result ${result.ok ? "" : "err"}`}>
          <span>{result.message}</span>
          <button type="button" className="mem-result-x" onClick={onDismissResult}>
            ✕
          </button>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.noMemoriesMsg")}</div>
      ) : (
        <div className="mem">
          {entries.map((m) => (
            <div
              className="mem-row"
              data-active={detail?.path === m.path}
              key={m.path}
              onClick={() => openEntry(m)}
              onKeyDown={activationHandler(() => openEntry(m))}
            >
              <span className="scope" data-s={m.scope}>
                {m.scope === "project"
                  ? t("contextPanel.scopeProject")
                  : t("contextPanel.scopeGlobal")}
              </span>
              <span className="txt">{m.description || m.name}</span>
              <button
                type="button"
                className="mem-del"
                title={t("contextPanel.deleteMemory")}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(m.path);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {detail && !composing && !isEditableMemory(detail) ? (
        <pre className="mem-detail">{detail.body}</pre>
      ) : null}

      {composing ? (
        <div className="mem-composer">
          <div className="mem-composer-row">
            <input
              className="mem-input"
              placeholder={t("contextPanel.newNamePh")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
            <select
              className="mem-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "global" | "project")}
            >
              <option value="project">{t("contextPanel.scopeProject")}</option>
              <option value="global">{t("contextPanel.scopeGlobal")}</option>
            </select>
          </div>
          <textarea
            className="mem-textarea"
            placeholder={t("contextPanel.newBodyPh")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="mem-composer-actions">
            <button
              type="button"
              className="btn small"
              disabled={!name.trim() || !body.trim()}
              onClick={submit}
            >
              {t("contextPanel.saveMemory")}
            </button>
            <button type="button" className="btn small ghost" onClick={closeComposer}>
              {t("contextPanel.cancelMemory")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="mem-new" onClick={() => setComposing(true)}>
          ＋ {t("contextPanel.newMemory")}
        </button>
      )}
    </div>
  );
}

function CtxRules({
  settings,
  onAddRule,
  onUpdateRule,
  onCopyWorkspaceRules,
  onRemoveRule,
}: {
  settings: Settings | null;
  onAddRule?: (rule: RuleRecord) => void;
  onUpdateRule?: (from: RuleRecord, to: RuleRecord) => void;
  onCopyWorkspaceRules?: (from: string) => void;
  onRemoveRule?: (rule: RuleRecord) => void;
}) {
  const [effect, setEffect] = useState<RuleEffect>("allow");
  const [pattern, setPattern] = useState("");
  const [match, setMatch] = useState<"pattern" | "regex">("pattern");
  const [editing, setEditing] = useState<RuleRecord | null>(null);
  const regexError = match === "regex" && pattern.trim() ? ruleRegexError(pattern.trim()) : null;
  const [addingTo, setAddingTo] = useState<"workspace" | "global" | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);

  useEffect(() => {
    if (!copyOpen) return;
    const close = () => setCopyOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [copyOpen]);

  const editMode = settings?.editMode ?? "follow";
  /** Read only honours no rules at all, so it shows the mode card alone. */
  const ruleMode: RuleMode | null = editMode === "read-only" ? null : editMode;
  const effects: RuleEffect[] =
    ruleMode === "never-ask" ? ["deny", "ask", "ignore"] : ["allow", "ask", "ignore"];
  const activeEffect = effects.includes(effect) ? effect : effects[0]!;
  type Verdict = RuleEffect;
  const list = (v: readonly string[] | undefined): string[] => (v ? [...v] : []);
  const join = (patterns: readonly string[]): string =>
    patterns.length > 0 ? patterns.join(" | ") : t("contextPanel.rulePatternNone");
  const outsidePaths = t("contextPanel.ruleRowOutsidePathsPattern");
  const outlook = t("contextPanel.ruleRowOutlookPattern");
  const EVERYTHING: TKey = "contextPanel.ruleRowEverything";
  /** The mode's own behaviour, never your rules: those are listed in the workspace and
   *  global sections, so repeating them here would say the same thing twice. A row whose
   *  list is empty is not rendered, so an empty set never shows as `none`. */
  const CARDS: Record<
    "read-only" | "follow" | "never-ask",
    Array<{ label: TKey; patterns: string[]; verdict: Verdict }>
  > = {
    "read-only": [
      {
        label: "contextPanel.ruleRowReadTools",
        patterns: list(settings?.readOnlyTools),
        verdict: "allow",
      },
      {
        label: "contextPanel.ruleRowAllowlistShell",
        patterns: list(settings?.builtinShellAllowlist),
        verdict: "allow",
      },
      { label: "contextPanel.ruleRowOutsidePaths", patterns: [outsidePaths], verdict: "ask" },
    ],
    follow: [
      { label: EVERYTHING, patterns: ["*"], verdict: "ask" },
      {
        label: "contextPanel.ruleRowReadTools",
        patterns: list(settings?.readOnlyTools),
        verdict: "allow",
      },
      {
        label: "contextPanel.ruleRowAllowlistShell",
        patterns: list(settings?.builtinShellAllowlist),
        verdict: "allow",
      },
      { label: "contextPanel.ruleRowOutlook", patterns: [outlook], verdict: "ask" },
    ],
    "never-ask": [
      { label: EVERYTHING, patterns: ["*"], verdict: "allow" },
      { label: "contextPanel.ruleRowOutlook", patterns: [outlook], verdict: "ask" },
    ],
  };
  const VERDICT: Record<Verdict, { label: TKey; tone: string }> = {
    allow: { label: "contextPanel.allow", tone: "" },
    ask: { label: "contextPanel.ask", tone: "warn" },
    deny: { label: "contextPanel.deny", tone: "deny" },
    ignore: { label: "contextPanel.ignore", tone: "ignore" },
  };
  const rulesForMode = (settings?.rules ?? []).filter(
    (r) => ruleMode !== null && r.mode === ruleMode,
  );
  /** Other workspaces that carry rules, as copy sources. Undefined means the daemon has
   *  not reported the list yet, which must not read as "nothing to copy from". */
  const otherWorkspaces = (settings?.workspacesWithRules ?? []).filter(
    (w) => w.rootDir !== settings?.workspaceDir,
  );
  const noCopySource = settings?.workspacesWithRules !== undefined && otherWorkspaces.length === 0;
  const sections = [
    {
      titleKey: "contextPanel.workspaceRulesTitle" as TKey,
      emptyKey: "contextPanel.noWorkspaceRules" as TKey,
      scope: "workspace" as const,
      rules: rulesForMode.filter((r) => r.scope === "workspace"),
    },
    {
      titleKey: "contextPanel.globalRulesTitle" as TKey,
      emptyKey: "contextPanel.noGlobalRules" as TKey,
      scope: "global" as const,
      rules: rulesForMode.filter((r) => r.scope === "global"),
    },
  ];

  const handleAdd = (e: React.FormEvent, scope: "workspace" | "global") => {
    e.preventDefault();
    const trimmed = pattern.trim();
    if (!trimmed || regexError || ruleMode === null) return;
    const next: RuleRecord = {
      mode: ruleMode,
      effect: activeEffect,
      kind: "shell",
      scope,
      pattern: trimmed,
      ...(match === "regex" ? { match } : {}),
    };
    if (editing) onUpdateRule?.(editing, next);
    else onAddRule?.(next);
    setPattern("");
    setEditing(null);
  };

  return (
    <>
      <div className="ctx-block mode-rules">
        <div className="h">
          <span>{t("contextPanel.modeRulesTitle")}</span>
        </div>
        {CARDS[editMode]
          .filter((row) => row.patterns.length > 0)
          .map((row) => {
            const v = VERDICT[row.verdict];
            return (
              <div className="rule" key={row.label}>
                <div className="top">
                  <span className="pat">{t(row.label)}</span>
                  <span className={`sw ${v.tone}`}>{t(v.label)}</span>
                </div>
                <div className="desc pattern">{join(row.patterns)}</div>
              </div>
            );
          })}
      </div>

      {ruleMode !== null &&
        sections.map((section) => {
          const adding = addingTo === section.scope;
          return (
            <div className="ctx-block" style={{ marginTop: 14 }} key={section.scope}>
              <div className="h">
                <span
                  style={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span>{t(section.titleKey)}</span>
                  {section.scope === "workspace" && onCopyWorkspaceRules && (
                    <button
                      type="button"
                      className="copy-rules-btn"
                      title={
                        noCopySource
                          ? t("contextPanel.copyRulesNoSource")
                          : t("contextPanel.copyRulesHint")
                      }
                      aria-label={t("contextPanel.copyWorkspaceRules")}
                      aria-expanded={copyOpen}
                      disabled={noCopySource}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCopyOpen((open) => !open);
                      }}
                    >
                      <I.folder size={12} />
                      {t("contextPanel.copyRulesButton")}
                    </button>
                  )}
                  {copyOpen && section.scope === "workspace" && onCopyWorkspaceRules && (
                    <div className="rules-copy-pop">
                      <div className="note">{t("contextPanel.copyRulesReplaceNote")}</div>
                      {otherWorkspaces.map((w) => (
                        <button
                          key={w.rootDir}
                          type="button"
                          className="item"
                          title={w.rootDir}
                          onClick={() => {
                            onCopyWorkspaceRules(w.rootDir);
                            setCopyOpen(false);
                          }}
                        >
                          {w.rootDir.split(/[\\/]/).filter(Boolean).pop() ?? w.rootDir}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
                <span
                  className="right"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  {section.rules.length}
                  {onAddRule && (
                    <button
                      type="button"
                      className="mini-btn"
                      title={`${t("contextPanel.addRuleBtn")}: ${t(section.titleKey)}`}
                      aria-label={`${t("contextPanel.addRuleBtn")}: ${t(section.titleKey)}`}
                      aria-expanded={adding}
                      onClick={() => {
                        setAddingTo(adding ? null : section.scope);
                        setEditing(null);
                        setPattern("");
                      }}
                    >
                      <I.plus size={12} />
                    </button>
                  )}
                </span>
              </div>
              {section.rules.map((r) => (
                <div
                  className="rule"
                  key={`${section.scope}-${r.kind}-${r.effect}-${r.match ?? "pattern"}-${r.pattern}`}
                >
                  <div className="top">
                    <span className="pat">
                      {r.match === "regex" ? `Regex: ${r.pattern}` : r.pattern}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {onUpdateRule ? (
                        <button
                          type="button"
                          className={`sw ${VERDICT[r.effect].tone} editable`}
                          title={t("contextPanel.changeEffectHint")}
                          aria-label={`${t("contextPanel.changeEffect")}: ${r.pattern} (${t(
                            VERDICT[r.effect].label,
                          )})`}
                          onClick={() =>
                            onUpdateRule(r, {
                              ...r,
                              effect: effects[(effects.indexOf(r.effect) + 1) % effects.length]!,
                            })
                          }
                        >
                          {t(VERDICT[r.effect].label)}
                        </button>
                      ) : (
                        <span className={`sw ${VERDICT[r.effect].tone}`}>
                          {t(VERDICT[r.effect].label)}
                        </span>
                      )}
                      {onUpdateRule && r.kind === "shell" && (
                        <button
                          type="button"
                          className="mini-btn"
                          aria-label={`${t("contextPanel.editRule")}: ${r.pattern}`}
                          onClick={() => {
                            setEditing(r);
                            setAddingTo(r.scope);
                            setPattern(r.pattern);
                            setMatch(r.match ?? "pattern");
                            setEffect(r.effect);
                          }}
                        >
                          <I.pencil size={12} />
                        </button>
                      )}
                      {onRemoveRule && (
                        <button
                          type="button"
                          className="mini-btn"
                          title={t("contextPanel.deleteRuleTooltip")}
                          aria-label={`Remove rule: ${r.pattern}`}
                          onClick={() => onRemoveRule(r)}
                        >
                          <I.trash size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {section.rules.length === 0 && !adding && (
                <div style={{ color: "var(--muted)", fontSize: 12, padding: "4px 0" }}>
                  {t(section.emptyKey)}
                </div>
              )}
              {adding && (onAddRule || editing) && (
                <form className="rule-composer" onSubmit={(e) => handleAdd(e, section.scope)}>
                  <select
                    className="rule-select"
                    aria-label={t("contextPanel.ruleMatchType")}
                    value={match}
                    onChange={(event) => setMatch(event.target.value as "pattern" | "regex")}
                  >
                    <option value="pattern">{t("contextPanel.ruleMatchPattern")}</option>
                    <option value="regex">{t("contextPanel.ruleMatchRegex")}</option>
                  </select>
                  {match === "regex" && (
                    <div className="note">{t("contextPanel.ruleRegexHint")}</div>
                  )}
                  {regexError && (
                    <div role="alert" style={{ color: "var(--danger)" }}>
                      {regexError}
                    </div>
                  )}
                  <div className="rule-composer-row">
                    <button
                      type="button"
                      className={`sw ${VERDICT[activeEffect].tone} editable`}
                      title={t("contextPanel.changeEffectHint")}
                      aria-label={`${t("contextPanel.changeEffect")}: ${t(VERDICT[activeEffect].label)}`}
                      onClick={() =>
                        setEffect(effects[(effects.indexOf(activeEffect) + 1) % effects.length]!)
                      }
                    >
                      {t(VERDICT[activeEffect].label)}
                    </button>
                    <input
                      type="text"
                      className="rule-input"
                      placeholder={
                        match === "regex"
                          ? String.raw`^(?=.*\bgit\b)(?=.*\bpush\b).*`
                          : t("contextPanel.rulePatternPlaceholder")
                      }
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                      aria-label="Rule pattern"
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="btn small"
                      disabled={
                        !pattern.trim() ||
                        Boolean(regexError) ||
                        (Boolean(editing) && !onUpdateRule)
                      }
                      title={editing ? t("contextPanel.saveRule") : t("contextPanel.addRuleBtn")}
                      aria-label={
                        editing ? t("contextPanel.saveRule") : t("contextPanel.addRuleBtn")
                      }
                    >
                      {editing ? t("contextPanel.saveRule") : <I.plus size={12} />}
                    </button>
                  </div>
                </form>
              )}
            </div>
          );
        })}
    </>
  );
}
