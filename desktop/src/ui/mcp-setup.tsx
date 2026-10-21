import { useState } from "react";
import { I } from "../icons";
import type { McpSetupServer } from "../protocol";
import { Throbber } from "./throbber";

/** Fresh-chat capability picker. The chat cannot run until the user confirms what it
 *  starts with — its MCP servers and whether it may spawn subagents — and both are
 *  frozen for the session, even after a restart. */
export function McpSetupDialog({
  servers,
  subagents,
  onConfirm,
  onCancel,
}: {
  servers: McpSetupServer[];
  /** Pre-fill for the subagent switch: the seed the session was minted with. */
  subagents: boolean;
  onConfirm: (enabled: string[], subagents: boolean) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(servers.filter((s) => s.enabled).map((s) => s.name)),
  );
  const [spawn, setSpawn] = useState(subagents);
  // Bridging the confirmed servers takes seconds and the dialog stays up until
  // $ready, so the confirm click must read as "working", not as a dead button.
  const [starting, setStarting] = useState(false);
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
      aria-label="Set up this chat"
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
          <h2 style={{ margin: "0 0 6px" }}>Set up this chat</h2>
          <button
            type="button"
            className="mini-btn"
            aria-label="Cancel"
            title="Cancel"
            onClick={onCancel}
          >
            <I.x size={14} />
          </button>
        </div>
        <p className="mcp-setup-hint" style={{ margin: "0 0 12px", opacity: 0.75 }}>
          Choose what this chat starts with. Both choices are locked for the session, even after a
          restart.
        </p>
        <ul className="mcp-setup-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          <SetupRow name="Subagents" on={spawn} onToggle={() => setSpawn((on) => !on)} />
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
                onToggle={() => toggle(s.name)}
                striped={i % 2 === 1}
              />
            ))}
          </ul>
        ) : (
          <p className="mcp-setup-hint" style={{ margin: 0, opacity: 0.6 }}>
            None configured. Add servers in Settings, then open a new chat.
          </p>
        )}
        <div
          className="mcp-setup-actions"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            className="btn primary"
            disabled={starting}
            aria-busy={starting}
            onClick={() => {
              setStarting(true);
              onConfirm([...selected], spawn);
            }}
          >
            {starting ? <Throbber label="Starting session" /> : null}
            Confirm and start
          </button>
        </div>
      </div>
    </div>
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
