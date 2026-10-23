import { useState } from "react";
import { I } from "../icons";
import type { McpSetupServer } from "../protocol";
import { Throbber } from "./throbber";

/** The servers a capability dialog starts with switched on: the rows the daemon marked
 *  enabled, so a duplicate opens on the same set New chat would. */
function enabledServerNames(servers: readonly McpSetupServer[]): Set<string> {
  return new Set(servers.filter((s) => s.enabled).map((s) => s.name));
}

/** The capability question, asked in one dialog wherever it is asked: the session-start
 *  gate ("what may this chat run with?") and the Duplicate confirm ("what may the copy
 *  run with?"). A caller supplies the copy and the answer handler and nothing else, so
 *  the two questions cannot drift apart. */
export function CapabilityDialog({
  title,
  hint,
  servers,
  subagents,
  emptyHint,
  confirmLabel,
  busyLabel,
  dismissLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  hint: string;
  servers: McpSetupServer[];
  /** Which switches start on: the capability seed the caller opened with. */
  subagents: boolean;
  emptyHint?: string;
  confirmLabel: string;
  /** Copy the confirm shows while the answer is being applied. Absent means the caller
   *  dismisses on click, so there is no wait to report. */
  busyLabel?: string;
  dismissLabel: string;
  onConfirm: (enabled: string[], subagents: boolean) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => enabledServerNames(servers));
  const [spawn, setSpawn] = useState(subagents);
  const [busy, setBusy] = useState(false);
  // Bridging the confirmed servers takes seconds and the gate stays up until $ready, so
  // the confirm click must read as "working", not as a dead button.
  const confirming = busy && busyLabel !== undefined;
  const toggle = (name: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  return (
    <div
      className="mcp-setup-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        className="mcp-setup-card"
        style={{
          width: 420,
          maxWidth: "90vw",
          maxHeight: "80vh",
          overflow: "auto",
          padding: 20,
          borderRadius: 10,
          background: "var(--card)",
          color: "var(--fg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <h2 style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 600 }}>{title}</h2>
          <button
            type="button"
            className="mini-btn"
            aria-label={dismissLabel}
            title={dismissLabel}
            onClick={onCancel}
          >
            <I.x size={14} />
          </button>
        </div>
        <p className="mcp-setup-hint" style={{ margin: "0 0 12px", opacity: 0.75 }}>
          {hint}
        </p>
        <div className="mcp-setup-caps" style={{ maxHeight: "40vh", overflowY: "auto" }}>
          <CapabilityPicker
            servers={servers}
            selected={selected}
            subagents={spawn}
            onToggleServer={toggle}
            onToggleSubagents={() => setSpawn((on) => !on)}
            emptyHint={emptyHint}
          />
        </div>
        <div
          className="mcp-setup-actions"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            className="btn primary"
            disabled={confirming}
            aria-busy={confirming}
            onClick={() => {
              setBusy(true);
              onConfirm([...selected], spawn);
            }}
          >
            {confirming && busyLabel ? <Throbber label={busyLabel} /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The capability rows themselves: the subagent switch and one switch per configured
 *  MCP server. */
function CapabilityPicker({
  servers,
  selected,
  subagents,
  onToggleServer,
  onToggleSubagents,
  emptyHint = "None configured. Add servers in Settings, then open a new chat.",
}: {
  servers: McpSetupServer[];
  /** Names of the servers currently switched on. */
  selected: ReadonlySet<string>;
  subagents: boolean;
  onToggleServer: (name: string) => void;
  onToggleSubagents: () => void;
  emptyHint?: string;
}) {
  return (
    <>
      <ul className="mcp-setup-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        <SetupRow name="Subagents" on={subagents} onToggle={onToggleSubagents} />
      </ul>
      <p className="mcp-setup-hint" style={{ margin: "12px 0 6px", opacity: 0.6 }}>
        MCP servers
      </p>
      {servers.length > 0 ? (
        <ul className="mcp-setup-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {servers.map((s, i) => (
            <SetupRow
              key={s.name}
              name={s.name}
              badge={s.builtin ? "built-in" : undefined}
              on={selected.has(s.name)}
              onToggle={() => onToggleServer(s.name)}
              striped={i % 2 === 1}
            />
          ))}
        </ul>
      ) : (
        <p className="mcp-setup-hint" style={{ margin: 0, opacity: 0.6 }}>
          {emptyHint}
        </p>
      )}
    </>
  );
}

/** One switchable capability row. The subagent flag and each MCP server render through
 *  the same markup so the picker cannot drift between the two kinds. */
function SetupRow({
  name,
  badge,
  on,
  onToggle,
  striped,
}: {
  name: string;
  badge?: string;
  on: boolean;
  onToggle: () => void;
  striped?: boolean;
}) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "6px 10px",
        borderRadius: 6,
        background: striped ? "var(--bg)" : "transparent",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mcp-setup-name">{name}</span>
        {badge ? (
          <span className="mcp-setup-badge" style={{ opacity: 0.6, fontSize: "0.85em" }}>
            {badge}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className="toggle"
        role="switch"
        aria-checked={on}
        aria-label={name}
        data-on={on}
        onClick={onToggle}
      />
    </li>
  );
}
