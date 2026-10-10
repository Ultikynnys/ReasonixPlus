import type { ApprovalAction, ApprovalPrompt } from "@reasonix/core-utils";
import { sanitizeTerminalText } from "@reasonix/core-utils";
import { formatBytes } from "@reasonix/core-utils";
import { isCompactionSummary, stripCompactionMarker } from "@reasonix/core-utils/compaction";
import { derivePrefix } from "@reasonix/core-utils/derive-prefix";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy } from "lucide-react";
import { Fragment, memo, useEffect, useState } from "react";
import type {
  ActivePlan,
  AssistantSegment,
  PendingCheckpoint,
  PendingConfirm,
  PendingRevision,
  SkillOrigin,
} from "../App";
import { InlineMarkdown, Markdown } from "../Markdown";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { JobInfo } from "../protocol";
import { useAutoApproveCountdown } from "./auto-countdown";
import {
  AssistantText,
  CompactionCard,
  DiffCard,
  PreText,
  ReasoningCard,
  ShellCard,
  SubagentCard,
  ToolCard,
  WarningCard,
  extractSubagentDetails,
  extractSubagentResultMeta,
  isSubagentTool,
  parseEditResult,
} from "./cards";
import { ApprovalCard, TaskCard, type TaskStepView } from "./extra-cards";

function downloadImage(dataUrl: string, mimeType: string): void {
  const ext = mimeType.split("/")[1] || "png";
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `generated.${ext}`;
  a.click();
}

type PresentedFile = { path: string; name: string; size: number };

function parsePresentedFile(result: string): PresentedFile | null {
  try {
    const value = JSON.parse(result) as Partial<PresentedFile>;
    return typeof value.path === "string" &&
      typeof value.name === "string" &&
      typeof value.size === "number"
      ? { path: value.path, name: value.name, size: value.size }
      : null;
  } catch {
    return null;
  }
}

const TEXT_PREVIEW_LIMIT = 64 * 1024;

function PresentedTextPreview({ src }: { src: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setFailed(false);
    setTruncated(false);
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("preview unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let content = "";
        let bytes = 0;
        let clipped = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = TEXT_PREVIEW_LIMIT - bytes;
            content += decoder.decode(value.subarray(0, remaining), { stream: true });
            bytes += value.byteLength;
            if (bytes > TEXT_PREVIEW_LIMIT) {
              clipped = true;
              break;
            }
          }
          content += decoder.decode();
        } finally {
          await reader.cancel();
        }
        if (!controller.signal.aborted) {
          setText(content);
          setTruncated(clipped);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [src]);
  if (failed) return <output className="presented-file-status" role="alert">{t("thread.previewFailed")}</output>;
  if (text === null) return <output className="presented-file-status">{t("thread.previewLoading")}</output>;
  return (
    <div className="presented-file-text">
      <pre>{text}</pre>
      {truncated ? <output className="presented-file-status">{t("thread.previewTruncated")}</output> : null}
    </div>
  );
}

function PresentedFileCard({ file }: { file: PresentedFile }) {
  useLang();
  const [message, setMessage] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [volume, setVolume] = useState(1);
  const src = convertFileSrc(file.path);
  const isImage = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|ico)$/i.test(file.name);
  const isAudio = /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|weba)$/i.test(file.name);
  const isVideo = /\.(?:mp4|m4v|webm|ogv|mov)$/i.test(file.name);
  const isPdf = /\.pdf$/i.test(file.name);
  const isText = /\.(?:txt|md|mdx|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|hpp|sh|ps1|sql|log|ini|cfg)$/i.test(file.name);
  useEffect(() => setPreviewFailed(false), [src]);
  const copyImage = async () => {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error("image could not be loaded");
      const blob = await response.blob();
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("image clipboard is unavailable");
      }
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      setMessage(t("thread.imageCopied"));
    } catch {
      setMessage(t("thread.imageCopyFailed"));
    }
  };
  const copyFile = async () => {
    try {
      await invoke("copy_file_to_clipboard", { path: file.path });
      setMessage(t("thread.fileCopied"));
    } catch {
      setMessage(t("thread.fileCopyFailed"));
    }
  };
  const saveFile = async () => {
    try {
      const destination = await saveDialog({ defaultPath: file.name });
      if (!destination) return;
      await invoke("copy_file_to_path", { source: file.path, destination });
      setMessage(t("thread.fileSaved"));
    } catch {
      setMessage(t("thread.fileSaveFailed"));
    }
  };
  return (
    <div className="presented-file">
      {isAudio ? (
        <div className="presented-file-audio">
          {/* biome-ignore lint/a11y/useMediaCaption: Captions are not available for arbitrary user-presented audio files. */}
          <audio
            controls
            preload="metadata"
            src={src}
            onError={() => setPreviewFailed(true)}
            aria-label={file.name}
            ref={(element) => {
              if (element) element.volume = volume;
            }}
          />
          <label>
            <span>{t("thread.audioVolume")}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              aria-label={t("thread.audioVolume")}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                setVolume(value);
                const audio = event.currentTarget
                  .closest(".presented-file")
                  ?.querySelector("audio");
                if (audio) audio.volume = value;
              }}
            />
          </label>
        </div>
      ) : null}
      {isImage && !previewFailed ? (
        <img className="presented-file-preview" src={src} alt={file.name} onError={() => setPreviewFailed(true)} />
      ) : null}
      {isVideo ? (
        // biome-ignore lint/a11y/useMediaCaption: Agent-provided videos do not necessarily include caption tracks.
        <video className="presented-file-preview" controls preload="metadata" src={src} aria-label={file.name} onError={() => setPreviewFailed(true)} />
      ) : null}
      {isPdf ? (
        <iframe className="presented-file-document" src={src} title={file.name} sandbox="" onError={() => setPreviewFailed(true)} />
      ) : null}
      {isText ? <PresentedTextPreview src={src} /> : null}
      {previewFailed ? <output className="presented-file-status" role="alert">{t("thread.previewFailed")}</output> : null}
      {!isImage && !isAudio && !isVideo && !isPdf && !isText ? (
        <output className="presented-file-status">{t("thread.previewUnsupported")}</output>
      ) : null}
      <div className="presented-file-info">
        <span className="presented-file-name" title={file.path}>
          {file.name}
        </span>
        <span className="presented-file-size">{formatBytes(file.size)}</span>
      </div>
      <div className="presented-file-actions">
        <button type="button" className="mini-btn" onClick={() => {
          void invoke("open_with_dialog", { path: file.path }).catch(() => setMessage(t("thread.fileOpenFailed")));
        }}>
          {t("thread.openFile")}
        </button>
        {isImage ? (
          <button type="button" className="mini-btn" onClick={() => void copyImage()}>
            {t("thread.copyImage")}
          </button>
        ) : null}
        <button type="button" className="mini-btn" onClick={() => void copyFile()}>
          {t("thread.copyFile")}
        </button>
        <button type="button" className="mini-btn" onClick={() => void saveFile()}>
          {t("thread.saveFile")}
        </button>
      </div>
      {message ? <output className="presented-file-status">{message}</output> : null}
    </div>
  );
}

const AssistantImage = memo(function AssistantImage({
  dataUrl,
  mimeType,
}: {
  dataUrl: string;
  mimeType: string;
}) {
  useLang();
  return (
    <div className="msg-image-wrap">
      <img className="msg-image" src={dataUrl} alt="" loading="eager" />
      <button
        type="button"
        className="copy-btn"
        onClick={() => downloadImage(dataUrl, mimeType)}
        title={t("thread.downloadImage")}
      >
        <I.download size={12} />
      </button>
    </div>
  );
});

export function TurnDivider({ label }: { label: string }) {
  return (
    <div className="turn-divider">
      <span>{label}</span>
      <span className="line" />
    </div>
  );
}

export const UserMsg = memo(function UserMsg({
  text,
  images,
  time,
  skill,
}: {
  text: string;
  images?: string[];
  time?: string;
  skill?: SkillOrigin;
}) {
  useLang();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="msg user">
      <div className="avatar">YOU</div>
      <div className="body">
        <div className="who">
          <span className="name">{t("thread.you")}</span>
          {skill ? (
            <span className="skill-chip" title={`skill · ${skill.runAs}`}>
              <I.zap size={10} /> /{skill.name}
              {skill.runAs === "subagent" ? (
                <span className="sub">{t("thread.subagent")}</span>
              ) : null}
            </span>
          ) : null}
          {time ? <span className="time">{time}</span> : null}
        </div>
        {images && images.length > 0 ? (
          <div className="msg-images">
            {images.map((src, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: per-message image list is immutable
              <img key={i} className="msg-image" src={src} alt="" loading="eager" />
            ))}
          </div>
        ) : null}
        <PreText className="msg-text">{text}</PreText>
        <div className="msg-actions">
          <button
            type="button"
            className={`copy-btn ${copied ? "done" : ""}`}
            onClick={onCopy}
            title={t("thread.copyMessage")}
          >
            <Copy size={11} />
            {copied ? t("markdown.copied") : null}
          </button>
        </div>
      </div>
    </div>
  );
});

/** Tool calls that pause the loop on a user gate (choice, plan confirmation,
 *  plan revision, step acknowledgement). While such a gate is open the approval
 *  strip owns the card, so the transcript must not render one too. */
const GATED_TOOL_NAMES = new Set([
  "ask_choice",
  "submit_plan",
  "revise_plan",
  "mark_step_complete",
]);

export const AssistantMsg = memo(function AssistantMsg({
  segments,
  pending,
  model,
  time,
  onApproveConfirm,
  onRejectConfirm,
  onRuleConfirm,
  onStopTool,
  pendingConfirms,
  activePlan,
  jobs,
  tabId,
  onStopJob,
  isInterventionPending,
}: {
  segments: AssistantSegment[];
  pending: boolean;
  model?: string;
  time?: string;
  onApproveConfirm: (id: number) => void;
  onRejectConfirm: (id: number) => void;
  onRuleConfirm: (id: number, scope: "workspace" | "global", prefix: string) => void;
  onStopTool: () => void;
  pendingConfirms: PendingConfirm[];
  activePlan?: ActivePlan;
  /** Live background-job snapshots (all tabs). A `run_background` shell card
   *  renders from its own job's status here so it never reads as finished while
   *  the process is still alive. */
  jobs?: JobInfo[];
  /** Id of the tab this transcript belongs to — scopes the job lookup, since
   *  per-tab registries restart their job ids at 1 (collision-prone). */
  tabId?: string;
  onStopJob?: (jobId: number) => void;
  isInterventionPending?: boolean;
}) {
  // A gate that is waiting on the user is owned by the approval strip; the
  // transcript must not stack a second (record) card for the same call. The
  // paused call is the last tool segment still missing a result.
  let blockingToolIndex = -1;
  if (isInterventionPending) {
    for (let k = segments.length - 1; k >= 0; k--) {
      const seg = segments[k];
      if (seg && seg.kind === "tool" && seg.result === undefined) {
        blockingToolIndex = k;
        break;
      }
    }
  }
  return (
    <div className="msg assistant">
      <div className="avatar">DS</div>
      <div className="body">
        <div className="who">
          <span className="name">Reasonix+</span>
          {model ? <span className="model">{model}</span> : null}
          {time ? <span className="time">{time}</span> : null}
        </div>
        {segments.map((s, i) => {
          if (s.kind === "text") {
            if (!s.text.trim()) return null;
            if (isCompactionSummary(s.text)) {
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              return <CompactionCard key={i} summary={stripCompactionMarker(s.text)} />;
            }
            // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
            return <AssistantText key={i} text={s.text} />;
          }
          if (s.kind === "reasoning") {
            return (
              <ReasoningCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                text={s.text}
                durationMs={s.durationMs}
                streaming={pending && !isInterventionPending && i === segments.length - 1}
              />
            );
          }
          if (s.kind === "compaction") {
            return (
              <CompactionCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                state={s.state}
                reason={s.reason}
                compactionKind={s.compactionKind}
                aggressive={s.aggressive}
                beforeMessages={s.beforeMessages}
                afterMessages={s.afterMessages}
                summaryChars={s.summaryChars}
                prunedFiles={s.prunedFiles}
                prunedTokens={s.prunedTokens}
                droppedFiles={s.droppedFiles}
                summary={s.summary}
                error={s.error}
              />
            );
          }
          if (s.kind === "warning") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              <WarningCard key={i} text={s.text} severity={s.severity} />
            );
          }
          if (s.kind === "image") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              <AssistantImage key={i} dataUrl={s.dataUrl} mimeType={s.mimeType} />
            );
          }
          // tool segment
          const pendingConfirm =
            (s.name === "run_command" || s.name === "run_background") && s.result === undefined
              ? pendingConfirms.find((c) => c.command === extractCommand(s.args))
              : undefined;
          const isSubagent =
            (s.subagentRuns !== undefined && s.subagentRuns.length > 0) ||
            isSubagentTool(s.name, s.args);
          // A gate waiting on the user is owned by the approval strip; never
          // stack a second (record) card here for the same call. The gate pauses
          // the model on the last tool call with no result yet, so that call is
          // the one to suppress, leaving a running job or subagent visible.
          const isShell = s.name === "run_command" || s.name === "run_background";
          const awaitingGate =
            s.result === undefined &&
            (pendingConfirm !== undefined ||
              GATED_TOOL_NAMES.has(s.name) ||
              (i === blockingToolIndex && !isSubagent && !isShell));
          if (awaitingGate) return null;
          if (isSubagent) {
            const { task, skillName, model } = extractSubagentDetails(s.name, s.args);
            const status: "running" | "done" | "failed" =
              s.result !== undefined ? (s.ok === false ? "failed" : "done") : "running";
            const resultMeta = extractSubagentResultMeta(s.result);
            const runs =
              s.subagentRuns && s.subagentRuns.length > 0
                ? s.subagentRuns
                : [
                    {
                      runId: s.callId,
                      task,
                      skillName,
                      model: resultMeta.model ?? model,
                      status,
                      elapsedMs: resultMeta.elapsedMs,
                      turns: resultMeta.turns,
                      costUsd: resultMeta.costUsd,
                      billingKind: resultMeta.billingKind,
                      quotaUsedPct: resultMeta.quotaUsedPct,
                      tools: [],
                    },
                  ];
            const effectiveRuns =
              s.result !== undefined
                ? runs.map((r) =>
                    r.status === "running"
                      ? { ...r, status: (s.ok === false ? "failed" : "done") as "failed" | "done" }
                      : r,
                  )
                : runs;
            return (
              <SubagentCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                name={skillName}
                runs={effectiveRuns}
                args={s.args}
                result={s.result}
                ok={s.ok}
                durationMs={s.durationMs}
              />
            );
          }
          if (s.name === "run_command" || s.name === "run_background") {
            const cmd = extractCommand(s.args) ?? s.args;
            // A `run_background` call returns as soon as its startup wait
            // elapses — long before the process ends. Resolve the card from the
            // job's LIVE status so a still-downloading curl never reads "done".
            // Applies to a persistent `run_command` too (same `[job N …]` header).
            const job =
              s.result !== undefined
                ? findBackgroundJob(jobs, tabId, parseBackgroundJobId(s.result))
                : undefined;
            const state: "await" | "running" | "done" | "failed" =
              s.result === undefined
                ? pendingConfirm
                  ? "await"
                  : "running"
                : job !== undefined
                  ? job.running
                    ? "running"
                    : job.exitCode === 0
                      ? "done"
                      : "failed"
                  : s.ok === false
                    ? "failed"
                    : "done";
            const jobRunning = state === "running" && job !== undefined;
            return (
              <ShellCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                command={cmd}
                // While the job runs, the live tail is the source of truth — the
                // tool result only holds the (already stale) startup banner.
                output={jobRunning ? undefined : s.result}
                liveOutput={jobRunning ? job?.outputTail : s.liveOutput}
                state={state}
                background={jobRunning}
                persistent={job?.persistent}
                durationMs={jobRunning ? undefined : s.durationMs}
                onApprove={pendingConfirm ? () => onApproveConfirm(pendingConfirm.id) : undefined}
                onReject={pendingConfirm ? () => onRejectConfirm(pendingConfirm.id) : undefined}
                onAddWorkspaceRule={
                  pendingConfirm && ruleActionFor(pendingConfirm.prompt, "workspace")
                    ? () => onRuleConfirm(pendingConfirm.id, "workspace", derivePrefix(cmd))
                    : undefined
                }
                onAddGlobalRule={
                  pendingConfirm && ruleActionFor(pendingConfirm.prompt, "global")
                    ? () => onRuleConfirm(pendingConfirm.id, "global", derivePrefix(cmd))
                    : undefined
                }
                onStop={
                  jobRunning && job !== undefined && onStopJob
                    ? () => onStopJob(job.id)
                    : onStopTool
                }
              />
            );
          }
          if (s.name === "present_file" && s.result) {
            const file = parsePresentedFile(s.result);
            return file ? <PresentedFileCard key={s.callId ?? `file-${i}`} file={file} /> : null;
          }
          if (s.name === "submit_plan") {
            if (activePlan?.callId !== undefined && s.callId === activePlan.callId) {
              return <ActivePlanTaskCard key={s.callId} plan={activePlan} />;
            }
            const submittedPlan = parseSubmittedPlan(s.args);
            return submittedPlan ? (
              <PlanApprovalCard
                key={s.callId ?? `plan-${i}`}
                plan={submittedPlan.plan}
                summary={submittedPlan.summary}
                steps={submittedPlan.steps}
                result={s.result}
                ok={s.ok}
              />
            ) : null;
          }
          if (s.name === "ask_choice") {
            const choice = parseChoiceArgs(s.args);
            return choice ? (
              <ChoiceApprovalCard
                key={s.callId ?? `choice-${i}`}
                question={choice.question}
                options={choice.options}
                result={s.result}
                ok={s.ok}
              />
            ) : null;
          }
          if (s.result && (s.name === "edit_file" || s.name === "multi_edit")) {
            const files = parseEditResult(s.result);
            return files.length > 0 ? (
              <Fragment key={s.callId ?? `edit-${i}`}>
                {files.map((f, fi) => (
                  <DiffCard
                    // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                    key={`${i}-${fi}`}
                    filename={f.filename}
                    lines={f.lines}
                    applied={s.ok !== false}
                  />
                ))}
              </Fragment>
            ) : (
              <ToolCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                name={s.name}
                args={s.args}
                result={s.result}
                ok={s.ok}
                durationMs={s.durationMs}
              />
            );
          }
          return (
            <ToolCard
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              key={i}
              name={s.name}
              args={s.args}
              result={s.result}
              ok={s.ok}
              durationMs={s.durationMs}
              waiting={
                s.result === undefined &&
                Boolean(isInterventionPending || pendingConfirm || GATED_TOOL_NAMES.has(s.name))
              }
            />
          );
        })}
      </div>
    </div>
  );
});

type SubmittedPlan = {
  plan: string;
  summary?: string;
  steps: { id: string; title: string; action: string; risk?: string }[];
};

export function parseSubmittedPlan(args: string): SubmittedPlan | undefined {
  try {
    const value = JSON.parse(args) as { plan?: unknown; summary?: unknown; steps?: unknown };
    if (typeof value.plan !== "string" || !value.plan.trim()) return undefined;
    const steps = Array.isArray(value.steps)
      ? value.steps.flatMap((step) => {
          if (!step || typeof step !== "object") return [];
          const item = step as Record<string, unknown>;
          if (
            typeof item.id !== "string" ||
            typeof item.title !== "string" ||
            typeof item.action !== "string"
          ) {
            return [];
          }
          return [
            {
              id: item.id,
              title: item.title,
              action: item.action,
              ...(typeof item.risk === "string" ? { risk: item.risk } : {}),
            },
          ];
        })
      : [];
    return {
      plan: value.plan,
      ...(typeof value.summary === "string" && value.summary ? { summary: value.summary } : {}),
      steps,
    };
  } catch {
    return undefined;
  }
}

type ChoiceArgs = {
  question: string;
  options: { id: string; title: string; summary?: string }[];
};

export function parseChoiceArgs(args: string): ChoiceArgs | undefined {
  try {
    const value = JSON.parse(args) as { question?: unknown; options?: unknown };
    if (typeof value.question !== "string" || !Array.isArray(value.options)) return undefined;
    const options = value.options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const item = option as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.title !== "string") return [];
      return [
        {
          id: item.id,
          title: item.title,
          ...(typeof item.summary === "string" ? { summary: item.summary } : {}),
        },
      ];
    });
    return options.length > 0 ? { question: value.question, options } : undefined;
  } catch {
    return undefined;
  }
}

function selectedChoiceId(result?: string): string | undefined {
  const match = /^user picked:\s*(.+)$/i.exec(result?.trim() ?? "");
  return match?.[1]?.trim();
}

function structuredCardTone(
  result: string | undefined,
  ok: boolean | undefined,
): "ok" | "danger" | "info" {
  return ok === false ? "danger" : result === undefined ? "info" : "ok";
}

function structuredCardMeta(
  result: string | undefined,
  ok: boolean | undefined,
  waitingLabel: string,
): string {
  return result === undefined ? waitingLabel : ok === false ? t("cards.error") : result;
}

function extractCommand(args: string): string | undefined {
  if (!args) return undefined;
  try {
    const v = JSON.parse(args);
    if (v && typeof v === "object" && typeof v.command === "string") return v.command;
  } catch {
    // ignore
  }
  return undefined;
}

/** Parse the job id out of a `run_background` tool result header, e.g.
 *  `[job 7 started · pid 12168 · running (no ready signal yet)]`. Mirrors the
 *  header emitted by `formatJobStart` (src/tools/shell.ts). */
export function parseBackgroundJobId(result: string): number | undefined {
  const m = /^\[job (\d+) (?:started|exited|failed)/.exec(result);
  return m ? Number(m[1]) : undefined;
}

/** Resolve the live job record a `run_background` card points at, scoped to the
 *  owning tab — per-tab registries restart job ids at 1, so id alone collides
 *  across tabs. */
export function findBackgroundJob(
  jobs: JobInfo[] | undefined,
  tabId: string | undefined,
  jobId: number | undefined,
): JobInfo | undefined {
  if (!jobs || jobId === undefined) return undefined;
  return jobs.find((j) => j.id === jobId && (tabId === undefined || j.tabId === tabId));
}

// ---- Approval bindings ----

export function PlanApprovalCard({
  id,
  plan,
  summary,
  steps,
  countdownMs,
  result,
  ok,
  onApprove,
  onRefine,
  onCancel,
  onTimerToggle,
}: {
  id?: number;
  plan: string;
  summary?: string;
  steps?: { id: string; title: string; action: string; risk?: string }[];
  countdownMs?: number;
  result?: string;
  ok?: boolean;
  onApprove?: () => void;
  onRefine?: () => void;
  onCancel?: () => void;
  onTimerToggle?: (enabled: boolean) => void;
}) {
  useLang();
  const interactive = Boolean(onApprove);
  const stepViews: TaskStepView[] = (steps ?? []).map((step, index) => ({
    n: String(index + 1),
    state: "queued",
    label: step.title,
    hint: step.action,
    durationLabel: undefined,
  }));
  const sub =
    summary ??
    (stepViews.length > 0 ? t("thread.planStepCount", { count: stepViews.length }) : undefined);
  return (
    <ApprovalCard
      kind={t("thread.planConfirmationKind")}
      tone={interactive ? "info" : structuredCardTone(result, ok)}
      title={t("thread.startPlan")}
      sub={sub}
      body={
        <>
          {interactive ? (
            <QuestionTimerRow
              countdownMs={countdownMs}
              onExpire={() => onApprove?.()}
              onToggleTimer={onTimerToggle}
            />
          ) : null}
          {stepViews.length > 0 ? <TaskCard title="" steps={stepViews} /> : null}
          <Markdown source={plan} />
        </>
      }
      meta={
        interactive
          ? id !== undefined
            ? `plan/#${id}`
            : undefined
          : structuredCardMeta(result, ok, "Waiting for plan approval…")
      }
      primaryLabel={interactive ? t("thread.approve") : undefined}
      onPrimary={onApprove}
      secondaryLabel={interactive ? t("thread.cancel") : undefined}
      onSecondary={onCancel}
      tertiaryLabel={interactive ? t("thread.refine") : undefined}
      onTertiary={onRefine}
    />
  );
}

export function CheckpointApprovalCard({
  c,
  onContinue,
  onRevise,
  onStop,
}: {
  c: PendingCheckpoint;
  onContinue: () => void;
  onRevise: () => void;
  onStop: () => void;
}) {
  useLang();
  return (
    <ApprovalCard
      kind={t("thread.checkpointKind")}
      tone="brand"
      title={c.title ?? t("thread.checkpointTitle", { completed: c.completed, total: c.total })}
      sub={t("thread.checkpointSub", { completed: c.completed, total: c.total })}
      body={
        <>
          <Markdown source={c.result} />
          {c.notes ? (
            <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>
              <Markdown source={c.notes} />
            </div>
          ) : null}
        </>
      }
      meta={`checkpoint · ${c.stepId}`}
      primaryLabel={t("thread.continue")}
      secondaryLabel={t("thread.stop")}
      tertiaryLabel={t("thread.revise")}
      onPrimary={onContinue}
      onSecondary={onStop}
      onTertiary={onRevise}
    />
  );
}

export function RevisionApprovalCard({
  r,
  onAccept,
  onReject,
  onTimerToggle,
}: {
  r: PendingRevision;
  onAccept: () => void;
  onReject: () => void;
  onTimerToggle?: (enabled: boolean) => void;
}) {
  useLang();
  return (
    <ApprovalCard
      kind={t("thread.planRevisionKind")}
      tone="warn"
      title={t("thread.rewritePlan")}
      sub={t("thread.keepSteps", { n: r.remainingSteps.length })}
      body={
        <>
          <QuestionTimerRow
            countdownMs={r.countdownMs}
            onExpire={onAccept}
            onToggleTimer={onTimerToggle}
          />
          <div style={{ marginBottom: 8 }}>
            <Markdown source={r.reason} />
          </div>
          {r.summary ? (
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8 }}>
              <Markdown source={r.summary} />
            </div>
          ) : null}
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.remainingSteps.map((s) => (
              <li key={s.id} style={{ fontSize: 12, marginBottom: 2 }}>
                {s.title}
                {s.risk ? (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color:
                        s.risk === "high"
                          ? "var(--tone-err)"
                          : s.risk === "med"
                            ? "var(--tone-warn)"
                            : "var(--muted)",
                    }}
                  >
                    [{s.risk}]
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      }
      meta={t("thread.revisionMeta")}
      primaryLabel={t("thread.approveRewrite")}
      secondaryLabel={t("thread.keepOriginal")}
      onPrimary={onAccept}
      onSecondary={onReject}
    />
  );
}

/** The prompt's "add to <scope> rules" action, or undefined when the daemon dropped it
 *  because that scope already carries a matching rule. Both the inline shell card and the
 *  confirm cards read this single source of truth. */
function ruleActionFor(
  prompt: ApprovalPrompt,
  scope: "workspace" | "global",
): ApprovalAction | undefined {
  return prompt.actions.find((a) => a.kind === "allow_always" && a.scope === scope);
}

function mapTone(tone: ApprovalPrompt["tone"]): import("./extra-cards").ApprovalTone {
  switch (tone) {
    case "error":
      return "danger";
    case "accent":
      return "brand";
    default:
      return tone;
  }
}

export function ConfirmApprovalCard({
  prompt,
  onAllow,
  onDeny,
  onAddWorkspaceRule,
  onAddGlobalRule,
}: {
  prompt: ApprovalPrompt;
  onAllow: () => void;
  onDeny: () => void;
  onAddWorkspaceRule?: () => void;
  onAddGlobalRule?: () => void;
}) {
  useLang();
  const allowAction = prompt.actions.find((a) => a.kind === "allow_once");
  const workspaceRule = ruleActionFor(prompt, "workspace");
  const globalRule = ruleActionFor(prompt, "global");
  const rejectAction = prompt.actions.find((a) => a.kind === "reject");
  return (
    <ApprovalCard
      kind={
        prompt.kind === "email"
          ? t("thread.emailConfirmationKind")
          : t("thread.shellConfirmationKind")
      }
      tone={mapTone(prompt.tone)}
      title={prompt.title}
      sub={prompt.subtitle}
      preview={
        prompt.kind === "email" ? (
          <>
            <PreText>
              {Object.entries(prompt.meta ?? {}).map(([key, value]) => (
                <div key={key}>
                  <strong>{key}:</strong> {value}
                </div>
              ))}
            </PreText>
            {prompt.preview ? (
              <div style={{ marginTop: 8 }}>
                <Markdown source={prompt.preview} />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <span style={{ color: "var(--accent)" }}>$</span>{" "}
            {sanitizeTerminalText(prompt.preview ?? prompt.subtitle ?? "")}
          </>
        )
      }
      meta={prompt.kind === "email" ? t("thread.emailConfirmationMeta") : undefined}
      primaryLabel={allowAction?.label ?? t("thread.execute")}
      secondaryLabel={rejectAction?.label ?? t("thread.reject")}
      tertiaryLabel={workspaceRule?.label}
      quaternaryLabel={globalRule?.label}
      onPrimary={onAllow}
      onSecondary={onDeny}
      onTertiary={workspaceRule ? onAddWorkspaceRule : undefined}
      onQuaternary={globalRule ? onAddGlobalRule : undefined}
    />
  );
}

export function PathAccessApprovalCard({
  prompt,
  onAllow,
  onDeny,
  onAddWorkspaceRule,
  onAddGlobalRule,
}: {
  prompt: ApprovalPrompt;
  onAllow: () => void;
  onDeny: () => void;
  onAddWorkspaceRule?: () => void;
  onAddGlobalRule?: () => void;
}) {
  useLang();
  const intent = String(prompt.data?.intent ?? "read");
  const isWrite = intent === "write";
  const allowAction = prompt.actions.find((a) => a.kind === "allow_once");
  const workspaceRule = ruleActionFor(prompt, "workspace");
  const globalRule = ruleActionFor(prompt, "global");
  const rejectAction = prompt.actions.find((a) => a.kind === "reject");
  return (
    <ApprovalCard
      kind={prompt.kind === "edit" ? t("thread.editConfirmationKind") : t("thread.pathAccessKind")}
      tone={mapTone(prompt.tone)}
      title={prompt.title}
      sub={prompt.subtitle}
      preview={
        <>
          <div>{sanitizeTerminalText(prompt.preview ?? prompt.subtitle ?? "")}</div>
          {prompt.meta?.sandboxRoot ? (
            <div style={{ color: "var(--muted)", marginTop: 4 }}>
              workspace: {prompt.meta.sandboxRoot}
            </div>
          ) : null}
        </>
      }
      primaryLabel={
        allowAction?.label ?? (isWrite ? t("thread.allowWrite") : t("thread.allowRead"))
      }
      secondaryLabel={rejectAction?.label ?? t("thread.reject")}
      tertiaryLabel={workspaceRule?.label}
      quaternaryLabel={globalRule?.label}
      onPrimary={onAllow}
      onSecondary={onDeny}
      onTertiary={workspaceRule ? onAddWorkspaceRule : undefined}
      onQuaternary={globalRule ? onAddGlobalRule : undefined}
    />
  );
}

/** Countdown + per-card enable/disable toggle shared by the question (ask_choice)
 *  card and the plan cards (plan confirmation + plan revision). Owns the toggle
 *  state so the timer logic lives in one place; disabling suppresses the countdown
 *  and the frontend auto-pick until the timer is switched back on. */
function QuestionTimerRow({
  countdownMs,
  onExpire,
  onToggleTimer,
}: {
  countdownMs?: number;
  onExpire: () => void;
  /** Notifies the backend to pause/resume its matching auto-resolve timer so
   *  the two clocks never desync. */
  onToggleTimer?: (enabled: boolean) => void;
}) {
  useLang();
  const [timerDisabled, setTimerDisabled] = useState(false);
  const remaining = useAutoApproveCountdown(timerDisabled ? undefined : countdownMs, onExpire);
  const active = Boolean(countdownMs) && !timerDisabled;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 2,
        fontSize: countdownMs ? 11.5 : 11,
        color: active ? "var(--tone-warn)" : "var(--muted)",
      }}
    >
      <span>
        {active
          ? t("thread.autoApproveIn", { n: remaining ?? 0 })
          : t("thread.questionTimerDisabled")}
      </span>
      {countdownMs ? (
        <button
          type="button"
          className="mini-btn"
          style={{ fontSize: 11, cursor: "pointer", padding: "1px 6px" }}
          onClick={() => {
            const next = !timerDisabled;
            setTimerDisabled(next);
            onToggleTimer?.(!next);
          }}
        >
          {timerDisabled ? t("thread.enableTimer") : t("thread.disableTimer")}
        </button>
      ) : null}
    </div>
  );
}

function ChoiceOptionText({
  option,
  chosen,
}: {
  option: { id: string; title: string; summary?: string };
  chosen: boolean;
}) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>
        {option.title}
        {chosen ? " ✓" : ""}
      </div>
      {option.summary ? (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{option.summary}</div>
      ) : null}
    </div>
  );
}

export function ChoiceApprovalCard({
  question,
  options,
  countdownMs,
  result,
  ok,
  onPick,
  onCancel,
  onTimerToggle,
}: {
  question: string;
  options: { id: string; title: string; summary?: string }[];
  countdownMs?: number;
  result?: string;
  ok?: boolean;
  onPick?: (optionId: string) => void;
  onCancel?: () => void;
  onTimerToggle?: (enabled: boolean) => void;
}) {
  useLang();
  const interactive = Boolean(onPick);
  const selected = selectedChoiceId(result);
  const firstOptionId = options[0]?.id;
  return (
    <ApprovalCard
      kind={t("thread.userChoiceKind")}
      tone={interactive ? "info" : structuredCardTone(result, ok)}
      title={<InlineMarkdown source={question} />}
      sub={t("thread.optionCount", { count: options.length })}
      body={
        <>
          {interactive ? (
            <QuestionTimerRow
              countdownMs={countdownMs}
              onExpire={() => {
                if (firstOptionId) onPick?.(firstOptionId);
              }}
              onToggleTimer={onTimerToggle}
            />
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {options.map((option) =>
              interactive ? (
                <button
                  key={option.id}
                  type="button"
                  className="btn"
                  style={{ justifyContent: "flex-start", textAlign: "left" }}
                  onClick={() => onPick?.(option.id)}
                >
                  <ChoiceOptionText option={option} chosen={false} />
                </button>
              ) : (
                <div
                  key={option.id}
                  className="btn"
                  data-selected={option.id === selected}
                  style={{
                    justifyContent: "flex-start",
                    textAlign: "left",
                    opacity: selected && option.id !== selected ? 0.55 : 1,
                  }}
                >
                  <ChoiceOptionText option={option} chosen={option.id === selected} />
                </div>
              ),
            )}
          </div>
        </>
      }
      meta={interactive ? undefined : structuredCardMeta(result, ok, "Waiting for your choice…")}
      primaryLabel={interactive ? t("thread.cancel") : undefined}
      onPrimary={interactive ? onCancel : undefined}
    />
  );
}

export function activePlanToTaskSteps(plan: ActivePlan): TaskStepView[] {
  const done = new Set(plan.completedStepIds);
  return plan.steps.map((s, i) => ({
    n: String(i + 1),
    state: done.has(s.id) ? "done" : i === plan.completedStepIds.length ? "running" : "queued",
    label: s.title,
    hint: s.action,
    durationLabel: undefined,
  }));
}

export function ActivePlanTaskCard({ plan }: { plan: ActivePlan }) {
  useLang();
  return (
    <TaskCard
      title={t("thread.activePlan")}
      subtitle={plan.summary}
      steps={activePlanToTaskSteps(plan)}
    />
  );
}
