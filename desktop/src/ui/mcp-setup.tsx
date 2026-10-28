import { useState } from "react";
import { I } from "../icons";
import type { McpSetupServer, PluginSetupEntry } from "../protocol";
import { Throbber } from "./throbber";

/** The rows a capability dialog starts with switched on: the ones the daemon marked
 *  enabled, so a duplicate opens on the same set New chat would. */
function switchedOn(rows: readonly { name: string; enabled: boolean }[]): Set<string> {
  return new Set(rows.filter((row) => row.enabled).map((row) => row.name));
}

/** Flip one name in a switch-set. Servers and plugins share it so the two row kinds
 *  cannot answer a click differently. */
function flipped(current: Set<string>, name: string): Set<string> {
  const next = new Set(current);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** The capability question, asked in one dialog wherever it is asked: the session-start
 *  gate ("what may this chat run with?") and the Duplicate confirm ("what may the copy
 *  run with?"). A caller supplies the copy and the answer handler and nothing else, so
 *  the two questions cannot drift apart. */
export function CapabilityDialog({
  title,
  hint,
  servers,
  plugins,
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
  /** Installed plugins, each switched on by the seed's frozen set. */
  plugins: PluginSetupEntry[];
  /** Which switches start on: the capability seed the caller opened with. */
  subagents: boolean;
  emptyHint?: string;
  confirmLabel: string;
  /** Copy the confirm shows while the answer is being applied. Absent means the caller
   *  dismisses on click, so there is no wait to report. */
  busyLabel?: string;
  dismissLabel: string;
  onConfirm: (enabled: string[], plugins: string[], subagents: boolean) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => switchedOn(servers));
  const [chosenPlugins, setChosenPlugins] = useState<Set<string>>(() => switchedOn(plugins));
  const [spawn, setSpawn] = useState(subagents);
  const [busy, setBusy] = useState(false);
  // Bridging the confirmed servers takes seconds and the gate stays up until $ready, so
  // the confirm click must read as "working", not as a dead button.
  const confirming = busy && busyLabel !== undefined;
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
            plugins={plugins}
            selected={selected}
            chosenPlugins={chosenPlugins}
            subagents={spawn}
            onToggleServer={(name) => setSelected((prev) => flipped(prev, name))}
            onTogglePlugin={(name) => setChosenPlugins((prev) => flipped(prev, name))}
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
              onConfirm([...selected], [...chosenPlugins], spawn);
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

/** The capability rows themselves: the subagent switch, one switch per configured MCP
 *  server, and one per installed plugin. */
function CapabilityPicker({
  servers,
  plugins,
  selected,
  chosenPlugins,
  subagents,
  onToggleServer,
  onTogglePlugin,
  onToggleSubagents,
  emptyHint = "None configured. Add servers in Settings, then open a new chat.",
}: {
  servers: McpSetupServer[];
  plugins: PluginSetupEntry[];
  /** Names of the servers currently switched on. */
  selected: ReadonlySet<string>;
  /** Slugs of the plugins currently switched on. */
  chosenPlugins: ReadonlySet<string>;
  subagents: boolean;
  onToggleServer: (name: string) => void;
  onTogglePlugin: (name: string) => void;
  onToggleSubagents: () => void;
  emptyHint?: string;
}) {
  return (
    <>
      <ul className="mcp-setup-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        <SetupRow name="Subagents" on={subagents} onToggle={onToggleSubagents} />
      </ul>
      <p className="mcp-setup-hint" style={{ margin: "12px 0 6px", opacity: 0.6 }}>
        Plugins
      </p>
      {plugins.length > 0 ? (
        <ul className="mcp-setup-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {plugins.map((plugin, i) => (
            <SetupRow
              key={plugin.name}
              name={plugin.displayName}
              on={chosenPlugins.has(plugin.name)}
              onToggle={() => onTogglePlugin(plugin.name)}
              striped={i % 2 === 1}
            />
          ))}
        </ul>
      ) : (
        <p className="mcp-setup-hint" style={{ margin: 0, opacity: 0.6 }}>
          No plugin installed. Install one in Settings, under Plugins, then open a new chat.
        </p>
      )}
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
