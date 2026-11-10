import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type SessionInfo, type SessionMutation, sortSessionsByCreationDescending } from "../App";
import { recordFrontendFailure } from "../diagnostics";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { SessionPlanLabel } from "../plan-labels";
import { SESSION_TITLE_MAX, sessionTitle } from "../session-title";
import { clearPartition } from "../sessions-store";
import { formatTokensPerSecond } from "../stream-rate";
import { workspaceName } from "../workspace-path";
import { ContextMenu, useClampedPopupPosition } from "./file-menu";
import { activationHandler } from "./keyboard";
import { ListControl } from "./list-controls";
import { Shortcut } from "./shortcut";

type PendingDelete = {
  name: string;
  pretty: string;
  x: number;
  y: number;
};

type PendingClear = {
  x: number;
  y: number;
};

/** The row whose 3-dot menu is open, anchored on the button that opened it. */
type RowMenu = {
  name: string;
  pretty: string;
  running: boolean;
  /** Whether this row is the session the tab has open, which duplicate and
   *  export act on. */
  active: boolean;
  /** No messages to copy or export. */
  empty: boolean;
  x: number;
  y: number;
};

function relative(ms: number): string {
  const min = ms / 60_000;
  if (min < 1) return t("sidebarPanel.justNow");
  if (min < 60) return t("sidebarPanel.minutesAgo", { n: Math.floor(min) });
  const hr = min / 60;
  if (hr < 24) return t("sidebarPanel.hoursAgo", { n: Math.floor(hr) });
  const d = hr / 24;
  if (d < 7) return t("sidebarPanel.daysAgo", { n: Math.floor(d) });
  return t("sidebarPanel.weeksAgo", { n: Math.floor(d / 7) });
}

export function Sidebar({
  sessions,
  activeName,
  workspaceDir,
  runningSessions,
  sessionRates,
  planLabels,
  onNewChat,
  onLoadSession,
  onDeleteSession,
  onClearSessions,
  sessionMutation,
  onReorderSession,
  onRenameSession,
  onDuplicateSession,
  onExportSession,
  activeSessionHasMessages,
  onOpenWorkdir,
  onOpenSettings,
  onOpenAbout,
}: {
  sessions: SessionInfo[];
  activeName?: string;
  workspaceDir?: string;
  /** Session names whose agent is actively running (a turn in flight) anywhere
   *  in the workspace — the ONLY thing that dots a session item, matching the
   *  tab bar's running-agents-only rule. No dot for a merely open channel. */
  runningSessions?: Set<string>;
  /** Live provider output rate (tokens/second) keyed by session name. Only
   *  present while the session's stream is running; a paused/stalled stream
   *  reports 0. */
  sessionRates?: Map<string, number>;
  /** Plan each session owns, keyed by session name. Undefined until the plan
   *  history loads, in which case no chip renders at all; with a map in hand, a
   *  running session missing from it owns no plan. Only running sessions are
   *  chipped at all — a plan is in flight work, so an idle row claiming one would
   *  be a stale label, not information. */
  planLabels?: Map<string, SessionPlanLabel>;
  onNewChat: () => void;
  onLoadSession: (name: string) => void;
  onDeleteSession: (name: string) => void;
  onClearSessions: () => void;
  /** The session-list mutation in flight (delete / clear-all / create), or null.
   *  Locks every control that would send a second mutation, clear-all among them. */
  sessionMutation?: SessionMutation | null;
  onReorderSession?: (name: string) => void;
  onRenameSession?: (name: string, title: string) => void;
  /** Duplicate the session this tab has open: the copy is seeded from the loaded
   *  transcript, so only the active row can offer it. */
  onDuplicateSession?: () => void;
  /** Export the session this tab has open, for the same reason. */
  onExportSession?: () => void;
  /** Whether the session this tab has open holds messages, from its live transcript.
   *  The row's own messageCount only refreshes when a turn ends, so without this a
   *  first turn would look empty to duplicate and export. */
  activeSessionHasMessages?: boolean;
  onOpenWorkdir: (anchor: { top?: number; bottom?: number; left: number }) => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingClear, setPendingClear] = useState<PendingClear | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  // One minute-resolution clock for the whole list: the labels are relative, so they
  // must refresh on their own. Local state keeps the tick out of App's render path.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // Lock only: the in-flight indicator itself lives in the main-area pill, so
  // this surface never restates it as a second throbber.
  const busy = sessionMutation != null;
  const workspaceLabel = workspaceName(workspaceDir);
  const filtered = useMemo(() => {
    const sorted = [...sessions].sort(sortSessionsByCreationDescending);
    if (!query) return sorted;
    const needle = query.toLowerCase();
    return sorted.filter(
      (s) => s.title.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle),
    );
  }, [sessions, query]);

  // Sessions a delete may touch. A session with an agent running is protected —
  // the daemon refuses it — so it is never counted or hidden by a clear-all. The
  // split is the shared one, so the counts here and the request App sends agree.
  const clear = useMemo(
    () => clearPartition(sessions, runningSessions),
    [sessions, runningSessions],
  );
  const runningCount = clear.kept.length;
  const deletableCount = clear.doomed.length;

  useEffect(() => {
    if (!pendingDelete && !pendingClear) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".session-delete-popover")) {
        setPendingDelete(null);
        setPendingClear(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPendingDelete(null);
        setPendingClear(null);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pendingDelete, pendingClear]);

  return (
    <aside className="sidebar">
      <div className="side-head">
        <button type="button" className="new-btn" onClick={onNewChat} disabled={busy}>
          <I.plus size={14} />
          <span className="label">{t("sidebarPanel.newChat")}</span>
          <Shortcut keys={["mod", "N"]} />
        </button>
      </div>

      <div className="side-workspace">
        <button
          type="button"
          className="workspace-btn"
          title={
            workspaceDir
              ? t("sidebarPanel.switchWorkspace", { workspace: workspaceDir })
              : t("sidebarPanel.pickWorkspace")
          }
          // Switching mid-mutation would re-target the channel that is waiting
          // for its settled session list, so the picker cannot even open.
          disabled={busy}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onOpenWorkdir({ top: rect.bottom + 6, left: rect.left });
          }}
        >
          <span className="ico">
            <I.folder size={13} />
          </span>
          <span className="body">
            <span className="label">{t("sidebarPanel.workspace")}</span>
            <span className="name">{workspaceLabel}</span>
          </span>
          <I.chev size={12} />
        </button>
        {workspaceDir ? (
          <button
            type="button"
            className="open-workdir-btn"
            title={t("sidebarPanel.openWorkspace")}
            aria-label={t("sidebarPanel.openWorkspace")}
            onClick={() => {
              void openPath(workspaceDir).catch((err) =>
                recordFrontendFailure("frontend.open_workspace_failed", err),
              );
            }}
          >
            <I.external size={13} />
          </button>
        ) : null}
      </div>

      <div className="search-row">
        <div className="input">
          <I.search size={13} />
          <input
            placeholder={t("sidebarPanel.searchSessions")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Shortcut keys={["mod", "K"]} />
        </div>
      </div>

      <div className="session-list">
        <div className="side-section">
          <div className="list-head">
            <span>{t("sidebarPanel.recent")}</span>
            <span className="count">{filtered.length}</span>
            {sessions.length > 0 ? (
              <ListControl
                kind="clear"
                label={t("sidebarPanel.clearAllSessions")}
                disabled={busy || deletableCount === 0}
                onAct={(button) => {
                  const rect = button.getBoundingClientRect();
                  setPendingClear({ x: rect.right, y: rect.bottom });
                }}
              />
            ) : null}
          </div>
          {sessions.length === 0 ? (
            <div
              style={{
                padding: "12px 8px",
                fontSize: 11,
                color: "var(--muted-2)",
                fontFamily: "Geist Mono, monospace",
              }}
            >
              {t("sidebarPanel.noSessions")}
            </div>
          ) : filtered.length === 0 ? (
            <div
              style={{
                padding: "12px 8px",
                fontSize: 11,
                color: "var(--muted-2)",
                fontFamily: "Geist Mono, monospace",
              }}
            >
              {t("sidebarPanel.noMatches")}
            </div>
          ) : null}
          {filtered.map((s) => {
            const active = s.name === activeName;
            // meta.updatedAt is the real last-activity stamp: a copied or restored
            // session keeps a filesystem mtime that lies about when it was touched.
            const stamp = s.updatedAt ?? Date.parse(s.mtime);
            const updated = Number.isFinite(stamp) ? relative(now - stamp) : s.mtime;
            const running = runningSessions?.has(s.name) ?? false;
            const rate = running ? sessionRates?.get(s.name) : undefined;
            const plan = planLabels?.get(s.name);
            // A row's own count can lag the open tab mid-turn, so an active row
            // reads the tab's live transcript where it has one.
            const empty =
              active && activeSessionHasMessages !== undefined
                ? !activeSessionHasMessages
                : s.messageCount === 0;
            return (
              <div
                key={s.name}
                className="session-item list-row"
                data-active={active}
                onClick={() => {
                  // Skip the round-trip when clicking the already-loaded
                  // session — a reload would clear live in-turn state (#1653).
                  if (s.name === activeName) return;
                  onLoadSession(s.name);
                }}
                role="button"
                tabIndex={0}
                title={running ? t("sidebarPanel.runningSessionRow", { name: s.name }) : s.name}
                onKeyDown={activationHandler(() => {
                  if (s.name !== activeName) onLoadSession(s.name);
                })}
              >
                {running ? <span className="state" /> : null}
                <div className="body">
                  <span className="title-row">
                    <SessionTitle
                      title={s.title}
                      canRename={active && onRenameSession !== undefined}
                      hintRename={!running}
                      onRename={(title) => onRenameSession?.(s.name, title)}
                    />
                    {planLabels && running ? (
                      <span
                        className="plan-tag"
                        data-plan={plan ? "live" : "none"}
                        title={
                          plan
                            ? t("sidebarPanel.planTagTitle", {
                                index: plan.index,
                                status: plan.status,
                                summary: plan.summary ?? t("contextPanel.planUntitled"),
                              })
                            : t("sidebarPanel.noPlanTitle")
                        }
                      >
                        {plan
                          ? t("sidebarPanel.planTag", { index: plan.index })
                          : t("sidebarPanel.noPlan")}
                      </span>
                    ) : null}
                  </span>
                  <span className="meta">
                    <span>{t("sidebarPanel.messageCount", { count: s.messageCount })}</span>
                    <span className="sep">·</span>
                    <span>{updated}</span>
                    {rate !== undefined ? (
                      <>
                        <span className="sep">·</span>
                        <span className="rate" title={t("sidebarPanel.tokensPerSecondTitle")}>
                          {t("sidebarPanel.tokensPerSecond", {
                            rate: formatTokensPerSecond(rate),
                          })}
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>
                <button
                  type="button"
                  className="row-menu-btn"
                  title={t("sidebarPanel.sessionActions")}
                  aria-label={t("sidebarPanel.sessionActions")}
                  aria-haspopup="menu"
                  aria-expanded={rowMenu?.name === s.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (rowMenu?.name === s.name) {
                      setRowMenu(null);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    setRowMenu({
                      name: s.name,
                      pretty: s.title,
                      running,
                      active,
                      empty,
                      x: rect.right,
                      y: rect.bottom,
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                  }}
                >
                  <I.more size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="side-foot">
        <div className="row" onClick={onOpenAbout} onKeyDown={activationHandler(onOpenAbout)}>
          <span className="ico">
            <I.help size={13} />
          </span>
          <span>{t("about.sidebarLabel")}</span>
        </div>
        <div className="row" onClick={onOpenSettings} onKeyDown={activationHandler(onOpenSettings)}>
          <span className="ico">
            <I.cog size={13} />
          </span>
          <span>{t("sidebarPanel.settings")}</span>
          <span className="right">
            <Shortcut keys={["mod", ","]} />
          </span>
        </div>
      </div>

      {rowMenu ? (
        <ContextMenu
          anchor={rowMenu}
          rootClass="file-menu row-menu"
          itemClass="file-menu-item"
          dismissSelector=".row-menu"
          onClose={() => setRowMenu(null)}
          items={[
            {
              key: "reorder",
              label: t("sidebarPanel.moveToTop"),
              icon: <I.arrowUp size={12} />,
              onSelect: () => {
                onReorderSession?.(rowMenu.name);
                setRowMenu(null);
              },
            },
            {
              key: "duplicate",
              label: t("sidebarPanel.duplicate"),
              icon: <I.copy size={12} />,
              // Both act on the transcript this tab holds, so a row that is not
              // the open session has nothing to hand them.
              disabled: !rowMenu.active || rowMenu.empty,
              title: rowMenu.active ? undefined : t("sidebarPanel.openSessionFirst"),
              onSelect: () => {
                setRowMenu(null);
                onDuplicateSession?.();
              },
            },
            {
              key: "export",
              label: t("sidebarPanel.export"),
              icon: <I.download size={12} />,
              disabled: !rowMenu.active || rowMenu.empty,
              title: rowMenu.active ? undefined : t("sidebarPanel.openSessionFirst"),
              onSelect: () => {
                setRowMenu(null);
                onExportSession?.();
              },
            },
            {
              key: "delete",
              label: rowMenu.running
                ? t("sidebarPanel.deleteRunningBlocked")
                : t("sidebarPanel.deleteSession"),
              icon: <I.x size={12} />,
              // A running session is one the daemon refuses to delete, and a
              // delete already in flight must not be doubled.
              disabled: busy || rowMenu.running,
              onSelect: () => {
                setPendingDelete(rowMenu);
                setRowMenu(null);
              },
            },
          ]}
        />
      ) : null}
      {pendingDelete ? (
        <SessionConfirmPopover
          anchor={pendingDelete}
          message={t("sidebarPanel.deleteSession")}
          name={pendingDelete.pretty}
          confirmLabel={t("sidebarPanel.delete")}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            onDeleteSession(pendingDelete.name);
            setPendingDelete(null);
          }}
        />
      ) : null}
      {pendingClear ? (
        <SessionConfirmPopover
          anchor={pendingClear}
          message={t("sidebarPanel.clearAllSessions")}
          name={t("sidebarPanel.clearAllConfirm", { count: deletableCount })}
          detail={
            runningCount > 0
              ? t("sidebarPanel.clearAllKeepsRunning", { count: runningCount })
              : undefined
          }
          confirmLabel={t("sidebarPanel.deleteAll")}
          busy={busy}
          onCancel={() => setPendingClear(null)}
          onConfirm={() => {
            onClearSessions();
            setPendingClear(null);
          }}
        />
      ) : null}
    </aside>
  );
}

/** The row's title, which becomes an input on a double click or on Enter, Space or F2.
 *  Only the session the tab has open is renameable: the rename is a daemon patch on
 *  one name, and an idle row would otherwise offer a control the tab cannot honour. */
function SessionTitle({
  title,
  canRename,
  hintRename,
  onRename,
}: {
  title: string;
  canRename: boolean;
  /** False on a running row, whose own tooltip explains why delete is locked. */
  hintRename: boolean;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const doneRef = useRef(false);
  const restoreRef = useRef(false);
  const spanRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  useEffect(() => {
    // The input is unmounted once the edit ends, so focus would fall back to the
    // document; hand it to the title the keyboard user started from.
    if (editing || !restoreRef.current) return;
    restoreRef.current = false;
    spanRef.current?.focus();
  }, [editing]);

  const start = () => {
    doneRef.current = false;
    setDraft(title);
    setEditing(true);
  };

  if (!editing) {
    return (
      <span
        ref={spanRef}
        className="title"
        title={canRename && hintRename ? t("sidebarPanel.renameSession") : undefined}
        // The row is its own activation target, so this opens the editor on the
        // keys the row would otherwise consume to load the session again.
        role={canRename ? "button" : undefined}
        tabIndex={canRename ? 0 : undefined}
        onDoubleClick={(event) => {
          if (!canRename) return;
          event.stopPropagation();
          start();
        }}
        onKeyDown={(event) => {
          if (!canRename) return;
          if (event.key !== "Enter" && event.key !== " " && event.key !== "F2") return;
          event.preventDefault();
          event.stopPropagation();
          start();
        }}
      >
        {title}
      </span>
    );
  }

  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    restoreRef.current = true;
    setEditing(false);
    if (!save) return;
    const next = sessionTitle(draft);
    if (next && next !== title) onRename(next);
  };

  return (
    <input
      ref={inputRef}
      className="title-edit"
      value={draft}
      maxLength={SESSION_TITLE_MAX}
      spellCheck={false}
      aria-label={t("sidebarPanel.renameSession")}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        // The row is its own activation target: Enter here commits, never loads.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

function SessionConfirmPopover({
  anchor,
  message,
  name,
  detail,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  anchor: { x: number; y: number };
  message: string;
  name: string;
  /** Second line for what the action will NOT touch. */
  detail?: string;
  confirmLabel: string;
  /** A mutation already in flight: the confirm cannot fire a second one. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: anchor.x,
    top: anchor.y,
  });

  useClampedPopupPosition(ref, anchor, pos, setPos);
  useLayoutEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      className="session-delete-popover"
      // biome-ignore lint/a11y/useSemanticElements: row-anchored popover — <dialog> top-layer semantics would break the absolute anchor
      role="dialog"
      aria-modal="true"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="msg">
        {message}
        <span className="name">{name}</span>
        {detail ? <span className="note">{detail}</span> : null}
      </div>
      <div className="actions">
        <button ref={cancelRef} type="button" className="cancel" onClick={onCancel}>
          {t("sidebarPanel.cancel")}
        </button>
        <button type="button" className="confirm" disabled={busy} onClick={onConfirm}>
          <I.trash size={11} />
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
