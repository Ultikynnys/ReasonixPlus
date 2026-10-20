import { sanitizeTerminalText } from "@reasonix/core-utils";
import {
  type CSSProperties,
  type ReactNode,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown, WorkspaceContext, resolveAgainstWorkspace, revealInExplorer } from "../Markdown";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { CardHead } from "./card-head";
import { FileMenu } from "./file-menu";
import { formatDuration, tokenLabel } from "./format";
import { useJumpOpen } from "./jump-expand";
import { Shortcut } from "./shortcut";
import { StopButton, usePendingStop } from "./stop-button";
import { useStickyBottom } from "./useStickyBottom";

type Tone = "default" | "success" | "warning" | "danger" | "accent" | "violet";

/** Pull a file ref (path + optional line) out of a tool's JSON args, mirroring the TUI ToolCard ↗ link. */
function extractToolFileRef(args?: string): { path: string; line?: number } | null {
  if (!args) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.path === "string") {
    let line: number | undefined;
    // read_file supports `range` like "50-100" — open at the first line.
    if (typeof rec.range === "string") {
      const first = rec.range.split("-")[0];
      const n = Number.parseInt(first ?? "", 10);
      if (Number.isFinite(n) && n > 0) line = n;
    }
    if (line === undefined && typeof rec.line === "number" && rec.line > 0) line = rec.line;
    return { path: rec.path, line };
  }
  // multi_edit: use the first edit's path
  if (Array.isArray(rec.edits) && rec.edits.length > 0) {
    const first = rec.edits[0] as Record<string, unknown> | undefined;
    if (first && typeof first.path === "string") return { path: first.path };
  }
  // move_file / copy_file: open the source
  if (typeof rec.source === "string" && rec.source) return { path: rec.source };
  return null;
}

/** Always-visible "show in file explorer" action rendered in the card header, next to the collapse toggle. */
function OpenFileButton({ path, label }: { path: string; label: string }) {
  useLang();
  const ws = useContext(WorkspaceContext);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const abs = resolveAgainstWorkspace(path, ws.dir);
  return (
    <>
      <button
        type="button"
        className="head-action"
        title={label}
        onClick={() => void revealInExplorer(abs, ws.dir)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <I.link size={12} />
        <span>{label}</span>
      </button>
      {menu ? <FileMenu anchor={menu} abs={abs} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

/** Hover-revealed copy affordance. On a card it sits outside the card in the
 *  right gutter (see `.card-wrap` in styles.css); on message text it pins to the
 *  bottom-right. Copies the card's own content (not a whole-turn response);
 *  flips to "copied" for ~1.2s. */
function CopyButton({ text }: { text: string }) {
  useLang();
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      className={`card-copy ${copied ? "done" : ""}`}
      title={t("thread.copyCard")}
      onClick={(e) => {
        // The pill can sit over a card header — don't let the click toggle it.
        e.stopPropagation();
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
    >
      <I.copy size={11} />
      {copied ? t("markdown.copied") : null}
    </button>
  );
}

export function Card({
  tone = "default",
  icon,
  kind,
  name,
  meta,
  defaultOpen = true,
  compact = false,
  children,
  headRight,
  copyText,
  anchor,
}: {
  tone?: Tone;
  icon: ReactNode;
  kind: string;
  name?: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  /** Slimmer header — used for thinking / tool-call process cards so they
   *  read as background detail rather than primary content. */
  compact?: boolean;
  children: ReactNode;
  headRight?: ReactNode;
  /** Text the hover copy button (right gutter) copies; empty/omitted renders none. */
  copyText?: string;
  /** Stable jump target for the Events tab (`call:<id>` / `notice:<id>`), so a
   *  recorded event lands on THIS card instead of its turn's prompt bubble. */
  anchor?: string;
}) {
  const { open, toggle } = useJumpOpen(anchor, defaultOpen);
  return (
    <div className="card-wrap" data-anchor={anchor}>
      <div className={compact ? "card is-compact" : "card"} data-tone={tone} data-open={open}>
        <div className="card-head-row">
          <CardHead icon={icon} kind={kind} name={name} meta={meta} open={open} onToggle={toggle} />
          {headRight}
        </div>
        {open ? <div className="card-body">{children}</div> : null}
      </div>
      {copyText ? <CopyButton text={copyText} /> : null}
    </div>
  );
}

// ---- Plan ----

export type PlanItem = {
  id: string | number;
  status: "todo" | "active" | "done" | "failed" | "blocked" | "skipped";
  text: string;
  tool?: string;
  note?: string;
};

function derivePlanBadge(items: PlanItem[]): {
  state: "running" | "done" | "failed" | "waiting" | "blocked";
  label: string;
} {
  if (items.some((x) => x.status === "failed"))
    return { state: "failed", label: t("planBadge.failed") };
  if (items.some((x) => x.status === "blocked"))
    return { state: "blocked", label: t("planBadge.blocked") };
  if (items.some((x) => x.status === "active"))
    return { state: "running", label: t("planBadge.running") };
  if (items.length > 0 && items.every((x) => x.status === "done"))
    return { state: "done", label: t("planBadge.done") };
  return { state: "waiting", label: t("planBadge.pending") };
}

function StatusIcon({
  state,
  label,
}: { state: "running" | "done" | "failed" | "waiting" | "blocked"; label: string }) {
  switch (state) {
    case "running":
      return <span className="spin-meta" role="img" aria-label={label} title={label} />;
    case "done":
      return <I.check size={10} style={{ color: "var(--success)" }} aria-label={label} />;
    case "failed":
      return <I.x size={10} style={{ color: "var(--danger)" }} aria-label={label} />;
    case "waiting":
      return <span className="status-dot warn" role="img" aria-label={label} title={label} />;
    case "blocked":
      return <I.slash size={10} style={{ color: "var(--warning)" }} aria-label={label} />;
  }
}

export function PlanCardView({ items, title }: { items: PlanItem[]; title?: string }) {
  useLang();
  const resolvedTitle = title ?? t("cards.planDefaultTitle");
  const done = items.filter((x) => x.status === "done").length;
  const badge = derivePlanBadge(items);
  const planText = items
    .map((it) => `${it.status === "done" ? "[x]" : "[ ]"} ${it.text}`)
    .join("\n");
  return (
    <Card
      tone="accent"
      icon={<I.list size={12} />}
      kind="plan"
      name={resolvedTitle}
      copyText={planText}
      meta={
        <>
          <span>
            {done}/{items.length}
          </span>
          <StatusIcon state={badge.state} label={badge.label} />
          <span className="meta-label">{badge.label}</span>
        </>
      }
    >
      <ul className="plan-list" style={{ listStyle: "none", margin: 0, padding: "8px 12px 12px" }}>
        {items.map((it) => (
          <li key={it.id} className="plan-item" data-status={it.status}>
            <span className="ck">{it.status === "done" ? <I.check size={12} /> : null}</span>
            <div>
              <div className="text">{sanitizeTerminalText(it.text)}</div>
              {it.tool || it.note ? (
                <div className="sub">
                  {it.tool ? <span className="tool">{sanitizeTerminalText(it.tool)}</span> : null}
                  {it.note ? <span>{sanitizeTerminalText(it.note)}</span> : null}
                </div>
              ) : null}
            </div>
            <span className="stat">
              {it.status === "active" ? <span className="spin" /> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---- Reasoning ----

/** Render `code` and **bold** fragments from model reasoning as React nodes
 *  (no dangerouslySetInnerHTML — the text is model output, not trusted HTML). */
function inlineReasoningNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index!));
    out.push(
      m[1] !== undefined ? (
        <span className="hl" key={n}>
          {m[1]}
        </span>
      ) : (
        <strong key={n}>{m[2]}</strong>
      ),
    );
    n += 1;
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One reasoning row. Memoized so a streaming append re-renders only the row that
 *  changed rather than the whole (potentially long) transcript. */
const ReasoningRow = memo(function ReasoningRow({ row }: { row: string }) {
  return <p>{inlineReasoningNodes(row)}</p>;
});

/** px from the bottom within which a follow stream still counts as "pinned". */
const FOLLOW_PIN_THRESHOLD = 8;

/**
 * The scroll body shared by the thinking and shell cards. It mounts only while
 * the card is expanded (Card gates its body on `open`), so a collapsed card
 * holding thousands of lines costs nothing; when open, its content stays inside
 * a bounded, self-scrolling box. Auto-follow keeps it pinned to the tail, an
 * up-scroll releases it, and returning to the bottom re-pins.
 */
function FollowStream({
  text,
  streaming,
  label,
  children,
}: {
  text: string;
  streaming: boolean;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sticky = useStickyBottom(ref, {
    threshold: FOLLOW_PIN_THRESHOLD,
    scrollToBottom: () => {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    },
  });

  // Pin on mount and whenever the content or the streaming flag changes, and keep
  // following resizes while pinned.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    sticky.follow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => sticky.follow());
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, streaming, sticky]);

  return (
    <div className="stream" ref={ref} role="log" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * Mounted only while expanded (Card gates its body on `open`), so it always
 * renders the WHOLE reasoning text: every earlier row stays reachable by
 * scrolling. A collapsed card mounts nothing, so long streams stay cheap until
 * the user opens them.
 */
function ReasoningStream({ text, streaming }: { text: string; streaming: boolean }) {
  // Streaming splits on single newlines so each line appears as it arrives;
  // completed reasoning groups into paragraphs. Neither path truncates.
  const rows = streaming ? text.split(/\r?\n/).filter((row) => row.trim()) : text.split(/\n\n+/);

  return (
    <FollowStream text={text} streaming={streaming} label={t("cards.reasoningStreamLabel")}>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream, no per-row state
        <ReasoningRow key={i} row={row} />
      ))}
    </FollowStream>
  );
}

export function ReasoningCard({
  text,
  streaming,
  tokens,
  durationMs,
  model,
}: {
  text: string;
  streaming: boolean;
  tokens?: number;
  durationMs?: number;
  model?: string;
}) {
  useLang();
  return (
    <Card
      tone="violet"
      icon={<I.brain size={12} />}
      kind="reasoning"
      name={t("cards.reasoningName")}
      meta={
        <>
          {durationMs !== undefined ? (
            <span className="meta-dur">{formatDuration(durationMs)}</span>
          ) : null}
          {tokens ? <span>{tokens.toLocaleString()} t</span> : null}
          {streaming ? (
            <StatusIcon state="running" label={t("cards.streaming")} />
          ) : (
            <StatusIcon state="done" label={t("cards.reasoningComplete")} />
          )}
        </>
      }
      copyText={text}
      defaultOpen={streaming}
      compact
    >
      <div className="reason">
        <ReasoningStream text={text} streaming={streaming} />
        {model || tokens !== undefined ? (
          <div className="meta">
            {model ? (
              <span>
                <span className="k">{t("settings.model")}</span> {model}
              </span>
            ) : null}
            {tokens !== undefined ? (
              <span>
                <span className="k">{t("statusbar.tokens")}</span> {tokens.toLocaleString()}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Shell ----

/** One output line. Memoized so a streaming append re-renders only the row that
 *  changed rather than the whole (potentially long) log. */
const ShellRow = memo(function ShellRow({ line }: { line: string }) {
  // Command output marks its own success/failure lines; color them the way the
  // settled snapshot did, so live and finished output read identically.
  if (line.startsWith(" ✓") || line.startsWith("✓"))
    return (
      <div>
        <span className="ok">{line}</span>
      </div>
    );
  if (line.startsWith(" ✗") || line.startsWith("✗") || /error/i.test(line))
    return (
      <div>
        <span className="err">{line}</span>
      </div>
    );
  return <div>{line}</div>;
});

/**
 * Full command-output stream: the WHOLE output stays reachable by scrolling, and
 * the tail is auto-followed. Nothing is truncated for the user; what the agent
 * receives is bounded separately, upstream. Rendering and containment are the
 * shared {@link FollowStream}'s job.
 */
function ShellOutput({ text, streaming }: { text: string; streaming: boolean }) {
  // Streaming splits on single newlines and drops blank rows (matching the
  // reasoning stream); the settled view keeps every line, blank separators and
  // all. Sanitize at this boundary: strip escape sequences (colors, cursor moves)
  // and collapse `\r`-only progress frames so a spinner line never stacks.
  const lines = useMemo(() => {
    const sanitized = sanitizeTerminalText(text);
    return streaming
      ? sanitized.split(/\r?\n/).filter((line) => line.trim())
      : sanitized.split("\n");
  }, [text, streaming]);

  return (
    <FollowStream
      text={text}
      streaming={streaming}
      label={streaming ? t("cards.shellLiveLabel") : t("cards.shellOutputLabel")}
    >
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream, no per-row state
        <ShellRow key={i} line={line} />
      ))}
    </FollowStream>
  );
}

export function ShellCard({
  command,
  output,
  liveOutput,
  state,
  background,
  persistent,
  durationMs,
  onApprove,
  onReject,
  onAddWorkspaceRule,
  onAddGlobalRule,
  onStop,
}: {
  command: string;
  output?: string;
  /** Incremental stdout+stderr streamed while the command runs — rendered as
   *  a rolling three-line tail (the subagent card's live activity rows). */
  liveOutput?: string;
  state: "await" | "running" | "done" | "failed";
  /** True when this is a detached `run_background` job still alive — the card
   *  labels it "Running in background" so it never reads as a finished command. */
  background?: boolean;
  /** True when the detached job is workspace-scoped (persistent) — the label
   *  notes it survives Stop / New chat. */
  persistent?: boolean;
  durationMs?: number;
  onApprove?: () => void;
  onReject?: () => void;
  onAddWorkspaceRule?: () => void;
  onAddGlobalRule?: () => void;
  onStop?: () => void;
}) {
  useLang();
  // The Stop button throbs until the command actually leaves `running`.
  const [stopping, startStop] = usePendingStop(state !== "running");
  const tone: Tone = state === "failed" ? "danger" : state === "done" ? "success" : "warning";
  const runningLabel = background
    ? persistent
      ? t("cards.shellPersistentRunning")
      : t("cards.shellBackgroundRunning")
    : t("cards.shellRunning");
  // The settled result is raw combined stdout/stderr — strip escape sequences
  // so the copy affordance matches what the stream renders.
  const copyText = output ? `$ ${command}\n\n${sanitizeTerminalText(output)}` : `$ ${command}`;
  // While running the live stream is what the user watches; once the command
  // settles the authoritative result replaces it. Both render through the same
  // full-output stream.
  const streamText = state === "running" ? liveOutput : output;
  return (
    <Card
      tone={tone}
      icon={<I.terminal size={12} />}
      kind="shell"
      name="shell"
      compact
      copyText={copyText}
      defaultOpen={state !== "done"}
      meta={
        <>
          {state === "await" ? (
            <StatusIcon state="waiting" label={t("cards.shellAwaiting")} />
          ) : state === "running" ? (
            <StatusIcon state="running" label={runningLabel} />
          ) : state === "failed" ? (
            <StatusIcon state="failed" label={t("cards.failed")} />
          ) : (
            <StatusIcon state="done" label={t("cards.done")} />
          )}
          {(state === "done" || state === "failed") && durationMs ? (
            <span className="meta-dur">{formatDuration(durationMs)}</span>
          ) : null}
        </>
      }
    >
      <div className="shell">
        <div className="cmd">
          <span className="prompt">$</span>
          <span className="text">{sanitizeTerminalText(command)}</span>
        </div>
        {streamText ? <ShellOutput text={streamText} streaming={state === "running"} /> : null}
        {state === "await" && onApprove ? (
          <div className="approve-row">
            <div className="why">
              <b>{t("cards.shellAwaiting")}</b>: {t("cards.shellExecuteHint")}
            </div>
            <div className="actions">
              {onAddWorkspaceRule ? (
                <button type="button" className="btn ghost" onClick={onAddWorkspaceRule}>
                  {t("cards.shellAddWorkspaceRule")}
                </button>
              ) : null}
              {onAddGlobalRule ? (
                <button type="button" className="btn ghost" onClick={onAddGlobalRule}>
                  {t("cards.shellAddGlobalRule")}
                </button>
              ) : null}
              {onReject ? (
                <button type="button" className="btn" onClick={onReject}>
                  {t("cards.shellReject")} <Shortcut keys={["mod", "."]} />
                </button>
              ) : null}
              <button type="button" className="btn primary" onClick={onApprove}>
                {t("cards.shellRun")} <Shortcut keys={["mod", "enter"]} />
              </button>
            </div>
          </div>
        ) : null}
        {state === "running" && onStop ? (
          <div className="approve-row">
            <div className="why">
              {runningLabel}: {t("cards.shellStopHint")}
            </div>
            <div className="actions">
              <StopButton
                label={t("cards.shellStop")}
                title={t("cards.shellStop")}
                busy={stopping}
                onClick={() => {
                  startStop();
                  onStop?.();
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Generic Tool ----

/** Shared pre-wrap text block for raw, non-markdown text: tool args/results,
 *  shell commands, and user messages. Agent-authored prose in the approval /
 *  gate cards renders through the Markdown component instead. */
export function PreText({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  // Raw process/captured text (tool results, file bodies, pasted terminal
  // output) can carry ANSI escapes and stray control bytes that render as
  // mojibake — sanitize the string-children case at this shared boundary.
  // Composed node children (markup) pass through untouched.
  const content = typeof children === "string" ? sanitizeTerminalText(children) : children;
  return (
    <div className={className ? `pre-text ${className}` : "pre-text"} style={style}>
      {content}
    </div>
  );
}

/** Shared single-line-cap helper — every card that shows raw tool text
 *  truncates through here so the caps live in one place. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Args/result truncation caps for expanded tool cards. Generous enough that
 *  a `read_file` result or pretty-printed args stay useful when expanded. */
const ARGS_TRUNC = 2000;
const RESULT_TRUNC = 4000;

/** Pretty-print JSON tool args so an expanded card reads as an indented block
 *  rather than a single-line blob; non-JSON text passes through untouched. */
function formatArgs(args: string): string {
  try {
    const v: unknown = JSON.parse(args);
    if (v && typeof v === "object") return JSON.stringify(v, null, 2);
  } catch {
    // not JSON — render verbatim
  }
  return args;
}

export function ToolCard({
  name,
  args,
  result,
  ok,
  durationMs,
  waiting,
}: {
  name: string;
  args?: string;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  waiting?: boolean;
}) {
  useLang();
  const fileRef = useMemo(() => extractToolFileRef(args), [args]);
  const formattedArgs = useMemo(() => (args ? formatArgs(args) : ""), [args]);
  const running = result === undefined;
  const tone: Tone = running
    ? waiting
      ? "warning"
      : "default"
    : ok === false
      ? "danger"
      : "success";
  // Web tool results (web_search, web_fetch, …) carry the engine that
  // served the call (resolved from config at call time) as an `engine:`
  // line — surface it in the header. No per-tool special-casing.
  const engine = useMemo(() => {
    if (!result) return undefined;
    const m = /^engine:\s*(\S+)/m.exec(result);
    return m?.[1];
  }, [result]);
  return (
    <Card
      tone={tone}
      icon={<I.wrench size={12} />}
      kind="tool"
      name={name}
      defaultOpen={false}
      compact
      meta={
        <>
          {running ? (
            waiting ? (
              <StatusIcon state="waiting" label={t("cards.awaitingUser") ?? "Waiting for user"} />
            ) : (
              <StatusIcon state="running" label={t("cards.running")} />
            )
          ) : ok === false ? (
            <StatusIcon state="failed" label={t("cards.error")} />
          ) : (
            <StatusIcon state="done" label={t("cards.done")} />
          )}
          {!running && durationMs !== undefined ? (
            <span className="meta-dur">{formatDuration(durationMs)}</span>
          ) : null}
          {engine ? <span className="pill-tag ok">{engine}</span> : null}
        </>
      }
      headRight={fileRef ? <OpenFileButton path={fileRef.path} label={fileRef.path} /> : undefined}
      copyText={[formattedArgs, result].filter(Boolean).join("\n\n")}
    >
      <div className="tool-call">
        {args ? (
          <div className="row">
            <span className="k">args</span>
            <span className="v">
              <PreText className="str">{truncate(formattedArgs, ARGS_TRUNC)}</PreText>
            </span>
          </div>
        ) : null}
        {result !== undefined ? (
          <div className="row">
            <span className="k">{ok === false ? t("cards.error") : t("cards.result")}</span>
            <span className="v">
              <PreText className={ok === false ? "num" : "str"}>
                {truncate(result, RESULT_TRUNC)}
              </PreText>
            </span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Diff ----

export type DiffLine =
  | { t: "hunk"; s: string }
  | { t: "ctx"; l?: number; r?: number; s: string }
  | { t: "add"; r: number; s: string }
  | { t: "rm"; l: number; s: string };

export function parseEditResult(text: string): { filename: string; lines: DiffLine[] }[] {
  const files: { filename: string; lines: DiffLine[] }[] = [];
  // Diff text is file content, and a file can wrap a captured terminal — strip
  // ANSI/control bytes at this boundary so no edit-card line renders as mojibake.
  const lines = sanitizeTerminalText(text).split("\n");

  let currentFilename = "";
  let currentLines: DiffLine[] = [];
  let hunkStartLeft = 0;
  let hunkStartRight = 0;
  let leftLine = 0;
  let rightLine = 0;

  const flush = () => {
    if (currentLines.length > 0) {
      files.push({ filename: currentFilename, lines: currentLines });
    }
    currentLines = [];
    hunkStartLeft = 0;
    hunkStartRight = 0;
    leftLine = 0;
    rightLine = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("edited ") || line.startsWith("multi_edit:")) {
      const m = line.match(/^edited\s+(.+?)\s+\(/);
      if (m) currentFilename = m[1]!;
      continue;
    }

    if (line.startsWith("# ")) {
      flush();
      currentFilename = line.slice(2);
      continue;
    }

    const hunkMatch = line.match(/^@@\s+-(\d+),(\d+)\s+\+(\d+),(\d+)\s+@@/);
    if (hunkMatch) {
      hunkStartLeft = Number(hunkMatch[1]!);
      hunkStartRight = Number(hunkMatch[3]!);
      leftLine = hunkStartLeft;
      rightLine = hunkStartRight;
      currentLines.push({ t: "hunk", s: line });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLines.push({ t: "add", r: rightLine, s: line.slice(1) });
      rightLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentLines.push({ t: "rm", l: leftLine, s: line.slice(1) });
      leftLine++;
    } else if (line.startsWith(" ")) {
      currentLines.push({ t: "ctx", l: leftLine, r: rightLine, s: line.slice(1) });
      leftLine++;
      rightLine++;
    }
  }

  flush();
  return files;
}

export function DiffCard({
  filename,
  lines,
  applied,
  onApply,
  onDiscard,
}: {
  filename: string;
  lines: DiffLine[];
  applied?: boolean;
  onApply?: () => void;
  onDiscard?: () => void;
}) {
  useLang();
  const adds = lines.filter((x) => x.t === "add").length;
  const rms = lines.filter((x) => x.t === "rm").length;
  const diffText = lines
    .map((ln) => {
      if (ln.t === "add") return `+${ln.s}`;
      if (ln.t === "rm") return `-${ln.s}`;
      if (ln.t === "hunk") return ln.s;
      return ` ${ln.s}`;
    })
    .join("\n");
  return (
    <Card
      tone={applied ? "success" : "accent"}
      icon={<I.diff size={12} />}
      kind="edit"
      name={filename}
      meta={
        <>
          <span style={{ color: "var(--success)" }}>+{adds}</span>
          <span style={{ color: "var(--danger)" }}>−{rms}</span>
          {applied ? (
            <StatusIcon state="done" label={t("cards.applied")} />
          ) : (
            <StatusIcon state="waiting" label={t("cards.diffAwaiting")} />
          )}
        </>
      }
      headRight={<OpenFileButton path={filename} label={t("cards.showInExplorer")} />}
      copyText={`${filename}\n\n${diffText}`}
    >
      <div className="diff">
        <div className="lines">
          {lines.map((ln, i) => {
            if (ln.t === "hunk")
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: static diff snapshot
                <div key={i} className="ln hunk">
                  <span className="code">{ln.s}</span>
                </div>
              );
            const cls = ln.t === "add" ? "add" : ln.t === "rm" ? "rm" : "";
            const l = ln.t === "ctx" ? ln.l : ln.t === "rm" ? ln.l : undefined;
            const r = ln.t === "ctx" ? ln.r : ln.t === "add" ? ln.r : undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: static diff snapshot
              <div key={i} className={`ln ${cls}`}>
                <span className="num">{l ?? ""}</span>
                <span className="num">{r ?? ""}</span>
                <span className="code">
                  {ln.t === "add" ? "+ " : ln.t === "rm" ? "− " : "  "}
                  {ln.s}
                </span>
              </div>
            );
          })}
        </div>
        {!applied && (onApply || onDiscard) ? (
          <div className="approve-row">
            <div className="why">
              <b>{t("cards.diffApplyChanges")}</b> · +{adds} / −{rms}
            </div>
            <div className="actions">
              {onDiscard ? (
                <button type="button" className="btn" onClick={onDiscard}>
                  {t("cards.diffDiscard")}
                </button>
              ) : null}
              {onApply ? (
                <button type="button" className="btn primary" onClick={onApply}>
                  {t("cards.diffApply")} <Shortcut keys={["mod", "enter"]} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Timeline notices ----

export type NoticeSeverity = "info" | "success" | "warning" | "error";

export function noticeName(severity: NoticeSeverity): string {
  switch (severity) {
    case "success":
      return t("cards.successName");
    case "warning":
      return t("cards.warningName");
    case "error":
      return t("cards.errorName");
    default:
      return t("cards.noticeName");
  }
}

export function NoticeCard({
  text,
  severity = "info",
  name,
  running,
  anchor,
}: {
  text: string;
  severity?: NoticeSeverity;
  name?: string;
  /** undefined = plain notice (no status icon). true/false = the compaction
   *  card in its running (throbber) / done (check) states, mirroring the
   *  thinking card's streaming status. */
  running?: boolean;
  anchor?: string;
}) {
  useLang();
  const tone: Tone =
    severity === "error"
      ? "danger"
      : severity === "warning"
        ? "warning"
        : severity === "success"
          ? "success"
          : "accent";
  const icon =
    severity === "success" ? (
      <I.check size={12} />
    ) : severity === "info" ? (
      <I.zap size={12} />
    ) : (
      <I.warning size={12} />
    );
  return (
    <Card
      tone={tone}
      icon={icon}
      kind={severity}
      name={name ?? (running !== undefined ? t("cards.compactionName") : noticeName(severity))}
      meta={
        running !== undefined ? (
          <StatusIcon
            state={running ? "running" : "done"}
            label={running ? t("cards.compacting") : t("cards.compactionDone")}
          />
        ) : undefined
      }
      defaultOpen
      compact
      copyText={text}
      anchor={anchor}
    >
      <div className="notice-body pre-text" data-severity={severity}>
        {sanitizeTerminalText(text)}
      </div>
    </Card>
  );
}

export function WarningCard({
  text,
  severity = "high",
}: {
  text: string;
  severity?: "low" | "high";
}) {
  const isDegeneration = /degenerat|repetiti/i.test(text);
  return (
    <NoticeCard
      text={text}
      severity={severity === "low" ? "info" : "warning"}
      name={isDegeneration ? t("cards.degenerationName") : undefined}
    />
  );
}

export const SUBAGENT_TOOLS = new Set(["spawn_subagent"]);

/** The one tool that spawns a child. Skills are playbooks now, so nothing else delegates. */
export function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name);
}

/** The instruction a subagent call was created with, verbatim. A progress event
 *  carries only a cut-down preview of it (30 chars from the child loop, 120 from
 *  the desktop projection), so the card reads the real text back from the call's
 *  own args: an instruction the model wrote is shown whole. */
export function subagentInstruction(args?: string): string {
  if (!args) return "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (typeof parsed.task === "string") return parsed.task;
    if (typeof parsed.arguments === "string") return parsed.arguments;
    if (typeof parsed.query === "string") return parsed.query;
  } catch {
    // Not JSON: the args ARE the instruction, kept as written.
  }
  return args;
}

/** What a subagent call itself carried: the instruction verbatim (no preview, no
 *  display fallback), the skill it named, and the model it pinned. Display code adds
 *  its own fallback; recording code must not, or an argless call would log its skill
 *  name as if it were the task. */
export function subagentCallDetails(
  name: string,
  args?: string,
): { instruction: string; skillName: string; model?: string } {
  let skillName = name;
  let model: string | undefined;
  if (args) {
    try {
      const parsed = JSON.parse(args);
      if (name === "run_skill" && typeof parsed.name === "string") {
        skillName = parsed.name;
      }
      if (typeof parsed.model === "string") {
        model = parsed.model;
      }
    } catch {
      // Not JSON: the args ARE the instruction, resolved below.
    }
  }
  return { instruction: subagentInstruction(args), skillName, model };
}

/** Whether `preview` is only the head of `full`. A spawn's start event carries the
 *  whole task and every later progress event carries a cut-down prefix of it, so this
 *  one predicate decides which of two candidate texts is the run's instruction: it
 *  keeps a late preview from replacing the whole thing, and keeps a foreign
 *  instruction (another call's args) from being shown as this run's task. */
export function isSubagentTaskPreview(preview: string, full: string): boolean {
  if (!preview || !full || preview.length >= full.length) return false;
  // Both cut paths drop the tail without a marker or with a single "…"; either way
  // the remainder is a literal prefix of the full text.
  return full.startsWith(preview.endsWith("…") ? preview.slice(0, -1) : preview);
}

/** The fullest known task text for a run: a later event may arrive with only a
 *  preview of what an earlier one already had whole. */
export function fullerSubagentTask(previous: string | undefined, next: string): string {
  if (previous === undefined) return next;
  return isSubagentTaskPreview(next, previous) ? previous : next;
}

/** What a run row shows as its instruction: the call's own text when the row's
 *  `task` is only the wire's cut-down head of it. */
function runInstruction(preview: string, instruction: string): string {
  if (!instruction) return preview;
  if (!preview) return instruction;
  return isSubagentTaskPreview(preview, instruction) ? instruction : preview;
}

export type SubagentResultMeta = {
  costUsd?: number;
  billingKind?: "usd" | "quota" | "none";
  quotaUsedPct?: number;
  model?: string;
  elapsedMs?: number;
  turns?: number;
};

/** Recover model / cost / billing from the subagent's persisted result envelope. The
 *  live `subagent.progress` stream carries these on `subagentRuns`, but after a session
 *  reload `subagentRuns` is not persisted — the result JSON is the reliable source. */
export function extractSubagentResultMeta(result?: string): SubagentResultMeta {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: SubagentResultMeta = {};
    if (typeof parsed.cost_usd === "number") out.costUsd = parsed.cost_usd;
    if (typeof parsed.model === "string") out.model = parsed.model;
    if (
      parsed.billing_kind === "usd" ||
      parsed.billing_kind === "quota" ||
      parsed.billing_kind === "none"
    ) {
      out.billingKind = parsed.billing_kind;
    }
    if (typeof parsed.quota_used_pct === "number") out.quotaUsedPct = parsed.quota_used_pct;
    if (typeof parsed.elapsed_ms === "number") out.elapsedMs = parsed.elapsed_ms;
    if (typeof parsed.turns === "number") out.turns = parsed.turns;
    return out;
  } catch {
    return {};
  }
}

function SubagentActivityRows({ run }: { run: import("../App").SubagentRunProgress }) {
  const rowsToShow =
    run.recentRows && run.recentRows.length > 0
      ? run.recentRows.slice(-3)
      : [
          {
            id: "init",
            kind: "process" as const,
            text: `Starting ${run.skillName ?? "subagent"}...`,
          },
        ];

  return (
    <div className="sub-activity" aria-label="Subagent activity">
      {rowsToShow.map((row) => (
        <div className="sub-activity-row" key={row.id}>
          <span className={`sub-activity-dot ${row.kind}${row.status ? ` ${row.status}` : ""}`} />
          <span className="sub-activity-tag">{row.kind}</span>
          <span className="sub-activity-text" title={sanitizeTerminalText(row.text)}>
            {sanitizeTerminalText(row.text)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SubagentCard({
  name,
  runs,
  args,
  result,
  ok,
  durationMs,
  anchor,
}: {
  name: string;
  runs: import("../App").SubagentRunProgress[];
  args?: string;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  /** `call:<id>` of the tool call that spawned this run, so the Events tab lands
   *  on this card rather than on its turn's prompt bubble. */
  anchor?: string;
}) {
  useLang();
  // The rows' own `task` is a wire-side preview; the instruction the child was
  // actually given is still on the call's args, so it is shown whole.
  const instruction = useMemo(() => subagentInstruction(args), [args]);
  const done = runs.filter((run) => run.status === "done").length;
  const models = [...new Set(runs.flatMap((run) => (run.model ? [run.model] : [])))];
  const contexts = runs.flatMap((run) =>
    run.contextTokens !== undefined ? [tokenLabel(run.contextTokens)] : [],
  );
  const status = runs.some((run) => run.status === "running")
    ? "running"
    : runs.some((run) => run.status === "failed") || ok === false
      ? "failed"
      : "done";
  const settled = status !== "running";
  // Token-priced runs: sum the real USD cost once every run has settled.
  const settledCostUsd =
    settled && runs.every((run) => run.costUsd !== undefined)
      ? runs.reduce((total, run) => total + (run.costUsd ?? 0), 0)
      : null;
  // Plan-based runs: sum the consumed provider-window % for runs that produced
  // a measurable quota delta. A `$` figure would be invented for these models.
  const quotaRuns = runs.filter(
    (run) => run.billingKind === "quota" && run.quotaUsedPct !== undefined,
  );
  const settledQuotaPct =
    settled && quotaRuns.length > 0
      ? quotaRuns.reduce((total, run) => total + (run.quotaUsedPct ?? 0), 0)
      : null;
  const billingMeta =
    settledQuotaPct !== null
      ? `${settledQuotaPct.toFixed(2)}%`
      : settledCostUsd !== null && settledCostUsd > 0
        ? `$${settledCostUsd.toFixed(4)}`
        : null;
  return (
    <Card
      tone={status === "failed" ? "danger" : "violet"}
      icon={<I.bot size={12} />}
      kind="subagent"
      name={name}
      copyText={result ?? ""}
      anchor={anchor}
      meta={
        <>
          {models.length > 0 ? <span className="meta-model">{models.join(" + ")}</span> : null}
          {contexts.length > 0 ? (
            <span className="meta-context">ctx {contexts.join(" / ")}</span>
          ) : null}
          {billingMeta ? <span className="meta-cost">{billingMeta}</span> : null}
          <span>
            {done} / {runs.length} {t("cards.subagentDoneProgress")}
          </span>
          {status === "done" ? (
            <StatusIcon state="done" label={t("cards.subagentDone")} />
          ) : status === "failed" ? (
            <StatusIcon state="failed" label={t("cards.subagentFailed")} />
          ) : (
            <StatusIcon state="running" label={t("cards.subagentRunning")} />
          )}
          {settled && durationMs !== undefined ? (
            <span className="meta-dur">{formatDuration(durationMs)}</span>
          ) : null}
        </>
      }
    >
      <div className="sub-card">
        {runs.map((run) => (
          <div className="sub-row" key={run.runId}>
            <span className="av">AI</span>
            <div className="what">
              <div>{sanitizeTerminalText(runInstruction(run.task, instruction))}</div>
              <div className="role">
                {run.skillName ?? "subagent"}
                {run.model ? ` · ${run.model}` : ""}
                {run.phase ? ` · ${run.phase}` : ""}
                {run.elapsedMs !== undefined ? ` · ${(run.elapsedMs / 1000).toFixed(1)}s` : ""}
                {run.iter !== undefined ? ` · ${run.iter} tools` : ""}
                {run.maxToolIters !== undefined ? ` / ${run.maxToolIters}` : ""}
                {run.maxElapsedMs !== undefined
                  ? ` · ${(run.maxElapsedMs / 1000).toFixed(0)}s limit`
                  : ""}
              </div>
              {run.status === "running" ? (
                <SubagentActivityRows run={run} />
              ) : (
                run.tools.map((tool) => (
                  <div className="role" key={tool.callId} title={tool.args}>
                    {tool.status === "running" ? "↳ …" : tool.status === "failed" ? "↳ ✕" : "↳ ✓"}{" "}
                    {tool.name}
                    {tool.args ? ` ${sanitizeTerminalText(tool.args)}` : ""}
                  </div>
                ))
              )}
              <div className="role">
                {run.contextTokens !== undefined && run.contextMax !== undefined
                  ? `ctx ${tokenLabel(run.contextTokens)} / ${tokenLabel(run.contextMax)}`
                  : ""}
                {run.outputChars !== undefined
                  ? ` · ${run.outputChars.toLocaleString()} output chars`
                  : ""}
                {run.reasoningChars !== undefined
                  ? ` · ${run.reasoningChars.toLocaleString()} reasoning chars`
                  : ""}
                {run.turns !== undefined ? ` · ${run.turns} turns` : ""}
                {run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : ""}
              </div>
              {run.budgetExhausted ? (
                <div className="role">
                  Stopped at {run.budgetExhausted === "elapsed" ? "time" : "tool-call"} budget
                </div>
              ) : null}
              {run.error ? <div className="role">{sanitizeTerminalText(run.error)}</div> : null}
            </div>
            <span className="prog">
              {run.status === "done" ? (
                <I.check size={12} style={{ color: "var(--success)" }} />
              ) : run.status === "failed" ? (
                <I.x size={12} style={{ color: "var(--danger)" }} />
              ) : (
                <span className="spin" />
              )}
            </span>
          </div>
        ))}
        {result ? (
          <div
            className="subagent-result"
            style={{
              marginTop: "8px",
              paddingTop: "8px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <Markdown source={result} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// Plain text block (assistant content via markdown)

export const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  return (
    <div className="msg-text">
      <Markdown source={text} />
      <CopyButton text={text} />
    </div>
  );
});
