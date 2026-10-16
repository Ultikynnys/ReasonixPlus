import { useState } from "react";
import { I } from "../icons";
import type { McpSetupServer } from "../protocol";

/** Fresh-chat MCP server picker. The chat cannot run until the user confirms
 *  which servers this session may use; the chosen set is frozen for the session. */
export function McpSetupDialog({
  servers,
  onConfirm,
  onCancel,
}: {
  servers: McpSetupServer[];
  onConfirm: (enabled: string[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(servers.filter((s) => s.enabled).map((s) => s.name)),
  );
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
      aria-label="Choose MCP servers"
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
          <h2 style={{ margin: "0 0 6px" }}>Choose MCP servers for this chat</h2>
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
          Pick the MCP servers this session may use. The choice is locked for this session, even
          after a restart.
        </p>
        <ul className="mcp-setup-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {servers.map((s, i) => (
            <li
              key={s.name}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "6px 10px",
                borderRadius: 6,
                background: i % 2 === 1 ? "var(--bg)" : "transparent",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mcp-setup-name">{s.name}</span>
                {s.builtin ? (
                  <span className="mcp-setup-badge" style={{ opacity: 0.6, fontSize: "0.85em" }}>
                    built-in
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="toggle"
                role="switch"
                aria-checked={selected.has(s.name)}
                aria-label={s.name}
                data-on={selected.has(s.name)}
                onClick={() => toggle(s.name)}
              />
            </li>
          ))}
        </ul>
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
          <button type="button" className="btn primary" onClick={() => onConfirm([...selected])}>
            Confirm and start
          </button>
        </div>
      </div>
    </div>
  );
}
