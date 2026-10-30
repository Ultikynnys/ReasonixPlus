import { groupSkills, isSkillCollection } from "@reasonix/core-utils";
import { type CSSProperties, useState } from "react";
import { I } from "../icons";
import type {
  CapabilityChoice,
  McpSetupServer,
  PluginSetupEntry,
  SkillSetupEntry,
} from "../protocol";
import { Throbber } from "./throbber";

/** The keys a capability dialog starts with switched on: the rows the daemon marked
 *  enabled, under the identity the confirm freezes for that kind. */
function switchedOn<T extends { enabled: boolean }>(
  rows: readonly T[],
  key: (row: T) => string,
): Set<string> {
  return new Set(rows.filter((row) => row.enabled).map(key));
}

/** Flip a set of names at once: one switch for everything an install delivered, so a
 *  collection of twenty skills cannot cost twenty clicks. */
function setMany(current: Set<string>, names: readonly string[], on: boolean): Set<string> {
  const next = new Set(current);
  for (const name of names) {
    if (on) next.add(name);
    else next.delete(name);
  }
  return next;
}

/** Flip one name in a switch-set, for the rows that stand for a single capability. Server,
 *  plugin and skill rows share this so the three kinds cannot answer a click differently. */
function flipped(current: Set<string>, name: string): Set<string> {
  return setMany(current, [name], !current.has(name));
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
  skills,
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
  /** Installed plugins, each switched on by the seed's frozen set. Their MCP servers and
   *  skills travel with them, so they get no rows of their own. */
  plugins: PluginSetupEntry[];
  /** Installed standalone skills, switched on by the seed's frozen set. */
  skills: SkillSetupEntry[];
  /** Which switches start on: the capability seed the caller opened with. */
  subagents: boolean;
  emptyHint?: string;
  confirmLabel: string;
  /** Copy the confirm shows while the answer is being applied. Absent means the caller
   *  dismisses on click, so there is no wait to report. */
  busyLabel?: string;
  dismissLabel: string;
  onConfirm: (answer: CapabilityChoice) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() =>
    switchedOn(servers, (server) => server.name),
  );
  const [chosenPlugins, setChosenPlugins] = useState<Set<string>>(() =>
    switchedOn(plugins, (plugin) => plugin.name),
  );
  const [chosenSkills, setChosenSkills] = useState<Set<string>>(() =>
    switchedOn(skills, (skill) => skill.id),
  );
  const [spawn, setSpawn] = useState(subagents);
  const [busy, setBusy] = useState(false);
  // Bridging the confirmed servers takes seconds and the gate stays up until $ready, so
  // the confirm click must read as "working", not as a dead button.
  const confirming = busy && busyLabel !== undefined;
  const toggleSkills = (names: readonly string[], on: boolean) =>
    setChosenSkills((prev) => setMany(prev, names, on));
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
            skills={skills}
            selected={selected}
            chosenPlugins={chosenPlugins}
            chosenSkills={chosenSkills}
            subagents={spawn}
            onToggleServer={(name) => setSelected((prev) => flipped(prev, name))}
            onTogglePlugin={(name) => setChosenPlugins((prev) => flipped(prev, name))}
            onToggleSkills={toggleSkills}
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
              onConfirm({
                servers: [...selected],
                plugins: [...chosenPlugins],
                skills: [...chosenSkills],
                subagents: spawn,
              });
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

/** The capability rows themselves: the subagent switch, one switch per installed plugin,
 *  one per standalone skill, and one per configured MCP server. */
function CapabilityPicker({
  servers,
  plugins,
  skills,
  selected,
  chosenPlugins,
  chosenSkills,
  subagents,
  onToggleServer,
  onTogglePlugin,
  onToggleSkills,
  onToggleSubagents,
  emptyHint = "None configured. Add servers in Settings, then open a new chat.",
}: {
  servers: McpSetupServer[];
  plugins: PluginSetupEntry[];
  skills: SkillSetupEntry[];
  /** Names of the servers currently switched on. */
  selected: ReadonlySet<string>;
  /** Slugs of the plugins currently switched on. */
  chosenPlugins: ReadonlySet<string>;
  /** Ids of the standalone skills currently switched on. */
  chosenSkills: ReadonlySet<string>;
  subagents: boolean;
  onToggleServer: (name: string) => void;
  onTogglePlugin: (name: string) => void;
  onToggleSkills: (ids: readonly string[], on: boolean) => void;
  onToggleSubagents: () => void;
  emptyHint?: string;
}) {
  return (
    <>
      <SetupList rows={[{ name: "Subagents", on: subagents, onToggle: onToggleSubagents }]} />
      <SectionLabel>Plugins</SectionLabel>
      <SetupList
        rows={plugins.map((plugin) => ({
          name: plugin.displayName,
          on: chosenPlugins.has(plugin.name),
          onToggle: () => onTogglePlugin(plugin.name),
        }))}
        empty="No plugin installed. Install one in Settings, under Plugins, then open a new chat."
      />
      <SectionLabel>Skills</SectionLabel>
      <SkillRows skills={skills} chosen={chosenSkills} onToggle={onToggleSkills} />
      <SectionLabel>MCP servers</SectionLabel>
      <SetupList
        rows={servers.map((server) => ({
          name: server.name,
          badge: server.builtin ? "built-in" : undefined,
          on: selected.has(server.name),
          onToggle: () => onToggleServer(server.name),
        }))}
        empty={emptyHint}
      />
    </>
  );
}

/** The name column: wide enough for a hyphenated capability name to break inside it, and
 *  capped at a share of the row so a narrow dialog shrinks it rather than squeezing the
 *  description down to one word a line. */
const NAME_COLUMN = "min(128px, 40%)";

/** Name, description and switch. Text wraps inside its own column, so every switch in the
 *  picker shares one vertical line however a row's text breaks. */
const ROW_COLUMNS = `minmax(0, ${NAME_COLUMN}) minmax(0, 1fr) auto`;

/** A text column of a capability row: it wraps instead of widening past its share. */
const ROW_TEXT: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };

/** The list of one capability kind. Every kind shares it, so none of them can indent its
 *  rows away from the switch column. */
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

/** A kind's heading, the same for every kind the picker lists. */
const SECTION_LABEL_STYLE: CSSProperties = { margin: "12px 0 6px", opacity: 0.6 };

/** How an empty note reads: the same quiet voice for every kind. */
const EMPTY_NOTE_STYLE: CSSProperties = { margin: 0, opacity: 0.6 };

/** The empty note the skills section shows: the only kind whose emptiness has two reasons. */
const NO_SKILLS_NOTE =
  "No standalone skill installed. Install one in Settings, under Skills, then open a new chat. Skills a plugin ships arrive with that plugin.";

/** One capability a row switches, in the shape a kind's list hands it to the row. */
type SetupEntry = {
  name: string;
  badge?: string;
  on: boolean;
  onToggle: () => void;
};

/** A kind's heading: the label every capability section of the picker opens with. */
function SectionLabel({ children }: { children: string }) {
  return (
    <p className="mcp-setup-hint" style={SECTION_LABEL_STYLE}>
      {children}
    </p>
  );
}

/** What a kind shows in place of the rows it has none of. */
function EmptyNote({ children }: { children: string }) {
  return (
    <p className="mcp-setup-hint" style={EMPTY_NOTE_STYLE}>
      {children}
    </p>
  );
}

/** One kind's rows: the same list, the same alternating stripe and the same row for every
 *  kind, so a plugin, a skill and an MCP server cannot lay their switches out differently. */
function SetupList({ rows, empty }: { rows: SetupEntry[]; empty?: string }) {
  if (rows.length === 0) return empty ? <EmptyNote>{empty}</EmptyNote> : null;
  return (
    <ul className="mcp-setup-list" style={LIST_STYLE}>
      {rows.map((row, i) => (
        <SetupRow key={row.name} {...row} striped={i % 2 === 1} />
      ))}
    </ul>
  );
}

/** The skills section: one switch per install. A repository switches as one capability, so
 *  its members never appear as switches of their own: the row's badge says how much of the
 *  group is on, and the settings page lists what it holds. */
function SkillRows({
  skills,
  chosen,
  onToggle,
}: {
  skills: SkillSetupEntry[];
  chosen: ReadonlySet<string>;
  onToggle: (ids: readonly string[], on: boolean) => void;
}) {
  if (skills.length === 0) return <EmptyNote>{NO_SKILLS_NOTE}</EmptyNote>;
  return (
    <ul className="mcp-setup-list" style={LIST_STYLE}>
      {groupSkills(skills).map((group, i) => {
        const ids = group.skills.map((skill) => skill.id);
        const on = ids.filter((id) => chosen.has(id)).length;
        const sole = group.skills[0] as SkillSetupEntry;
        return (
          <SetupRow
            key={group.key}
            name={group.label}
            // A lone skill keeps its own description; a group reports how much of it is on.
            badge={
              isSkillCollection(group) ? `${on}/${ids.length} on` : sole.description || undefined
            }
            on={on === ids.length}
            // One target state for the whole group: off only once every member is on.
            onToggle={() => onToggle(ids, on !== ids.length)}
            striped={i % 2 === 1}
          />
        );
      })}
    </ul>
  );
}

/** One switchable capability row. The subagent flag, each plugin, each skill collection and
 *  each MCP server render through the same markup so the picker cannot drift between the
 *  kinds. */
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
        display: "grid",
        gridTemplateColumns: ROW_COLUMNS,
        alignItems: "center",
        columnGap: 10,
        padding: "6px 10px",
        borderRadius: 6,
        background: striped ? "var(--bg)" : "transparent",
      }}
    >
      <span className="mcp-setup-name" style={ROW_TEXT}>
        {name}
      </span>
      <span className="mcp-setup-badge" style={{ ...ROW_TEXT, opacity: 0.6, fontSize: "0.85em" }}>
        {badge}
      </span>
      <button
        type="button"
        className="toggle"
        role="switch"
        aria-checked={on}
        aria-label={name}
        data-on={on}
        onClick={onToggle}
        style={{ justifySelf: "end" }}
      />
    </li>
  );
}
