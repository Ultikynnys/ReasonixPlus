import {
  DEFAULT_MODEL,
  clampReasoningEffort,
  messageOf,
  modelDisplayName,
} from "@reasonix/core-utils";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  type ChangeEvent,
  Fragment,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type React from "react";
import type { QueuedSend } from "../App";
import { recordFrontendFailure } from "../diagnostics";
import { type TKey, t } from "../i18n";
import { I } from "../icons";
import { isAudioVideoPath, isImagePath, resolveImagePath } from "../image-attach";
import {
  MODEL_CATALOG_GROUP_LABELS,
  type ProviderCatalogKey,
  type ProviderCatalogView,
  deriveModelCatalog,
} from "../model-catalog";
import {
  BUILTIN_QUICK_SENDS,
  type EditMode,
  type QuickSend,
  type ReasoningEffort,
  type UserImageAttachment,
} from "../protocol";
import { AudioRecorder } from "../voice/audio-recorder";
import { getSelectedAudioInputDeviceId } from "../voice/device";
import { speechTranscriber } from "../voice/transcriber";
import { toWorkspaceRelative } from "../workspace-path";
import type { ComposerDraft } from "./composer-draft";
import { DEFAULT_COMPOSER_ROWS } from "./composer-sizing";
import { activationHandler } from "./keyboard";
import { StuckLabel, TimerSpan } from "./live";
import { Shortcut } from "./shortcut";
import { StopButton, usePendingStop } from "./stop-button";
export type { EditMode, ReasoningEffort };

export type QueuedSendItem = string | QueuedSend;

type ModeEntry = { k: EditMode; label: TKey; icon: React.ReactNode; hint: TKey };

/** The composer's mutually-exclusive dropdowns — at most one is open at a time. */
type MenuId = "model" | "subagent" | "effort" | "quick";

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Clamp a video fps input to MiMo's documented 0.1–10 range (default 2). */
function clampVideoFps(raw: string): number {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(10, Math.max(0.1, n));
}

/** Abort a transcription that has not settled within this window. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

const MODE_INFO: ModeEntry[] = [
  {
    k: "read-only",
    label: "editMode.readOnly",
    icon: <I.list size={11} />,
    hint: "editMode.readOnlyHint",
  },
  {
    k: "follow",
    label: "editMode.follow",
    icon: <I.shield size={11} />,
    hint: "editMode.followHint",
  },
  {
    k: "never-ask",
    label: "editMode.neverAsk",
    icon: <I.warn size={11} />,
    hint: "editMode.neverAskHint",
  },
];

export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: EditMode;
  onChange: (m: EditMode) => void;
}) {
  return (
    <div className="mode-switch" data-mode={mode}>
      {MODE_INFO.map((m) => (
        <button
          key={m.k}
          type="button"
          className="ms-seg"
          data-on={mode === m.k}
          data-k={m.k}
          onClick={() => onChange(m.k)}
          title={t(m.hint)}
        >
          {m.icon}
          <span>{t(m.label)}</span>
        </button>
      ))}
    </div>
  );
}

export function StoredComposer({
  draftStore,
  ...props
}: Omit<React.ComponentProps<typeof Composer>, "draft" | "setDraft"> & {
  draftStore: ComposerDraft;
}) {
  const draft = useSyncExternalStore(draftStore.subscribe, draftStore.getSnapshot);
  return <Composer {...props} draft={draft} setDraft={draftStore.setDraft} />;
}

export function Composer({
  draft,
  setDraft,
  onSend,
  quickSends,
  activeQuickSendId,
  onPickQuickSend,
  onAbort,
  disabled,
  busy,
  busyLabel,
  stuckLabel,
  modelLabel,
  subagentModelLabel = DEFAULT_MODEL,
  subagentsEnabled = false,
  reasoningEffort,
  supportedEfforts,
  onModelChange,
  onSubagentModelChange = () => {},
  onEffortChange,
  editMode,
  onEditModeChange,
  /** Dynamically fetched Ollama models (`GET {base}/models`) — rendered as a scrollable
   *  group under the known models so the hundreds Ollama offers stay browsable. */
  ollamaModels,
  ollamaModelsError,
  ollamaHiddenCount,
  ollamaVisionModels,
  onRefreshOllamaModels,
  antigravityModels,
  antigravityModelsError,
  onRefreshAntigravityModels,
  opencodeModels,
  opencodeModelsError,
  opencodeVisionModels,
  onRefreshOpencodeModels,
  enabledModels,
  providerCatalogs,
  textareaRef,
  workspaceDir,
  queuedSends,
  onQueueWhileBusy,
  onDequeueSend,
  onEditQueuedSend,
  onSendNow,
  pendingImages,
  onRemoveImage,
  imageCapable,
  mediaCapable,
  onPasteImage,
  onImageRejected,
  onPickImage,
  onPickMedia,
  onUpdateMedia,
  onVoiceError,
  voiceAvailable = true,
}: {
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  onSend: (text?: string | QueuedSend) => void;
  /** Every selectable quick send (built-ins + customs) — drives the quick-send dropdown,
   *  the only surface that renders `shorthand`; sends and chat carry `message`. */
  quickSends?: QuickSend[];
  /** The row the dropdown marks as the composer's default. */
  activeQuickSendId?: string;
  /** Persist a newly picked default, called alongside the send itself. */
  onPickQuickSend?: (id: string) => void;
  onAbort: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Drives the status row above the hint row while the agent is running — typically "Reasoning" or "Skill · <name>". */
  busyLabel?: string;
  /** Renders the "stuck Ns" hint once the turn has been silent this long. The 1s
   *  poll lives inside StuckLabel so the conversation never re-renders per second. */
  stuckLabel?: { sinceMs: number; render: (sec: number) => React.ReactNode };
  modelLabel: string;
  /** Per-tab subagent model shown in the menu's subagent column. Defaults to the shared model default. */
  subagentModelLabel?: string;
  /** Whether this session was minted with the subagent tool. Without the tool the
   *  subagent model has nothing to spawn, so its picker is hidden rather than
   *  disabled — the capability is frozen at chat creation, never toggled here. */
  subagentsEnabled?: boolean;
  reasoningEffort: ReasoningEffort;
  /** Effort levels the active model accepts. The menu offers only these and
   *  the pill shows the clamped value. Undefined = all levels apply; empty =
   *  the model has no effort control (pill disabled). */
  supportedEfforts?: readonly ReasoningEffort[];
  onModelChange: (model: string) => void;
  /** Called when the user picks a model in the subagent column. */
  onSubagentModelChange?: (model: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  editMode: EditMode;
  onEditModeChange: (mode: EditMode) => void;
  /** Dynamically fetched Ollama models (raw ids, e.g. `llama3.1:latest`). */
  ollamaModels?: string[];
  /** Why the fetch failed — replaces the list so the failure isn't silent. */
  ollamaModelsError?: string;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount?: number;
  /** Re-fetch the Ollama model list (`force` bypasses the backend's cache). */
  onRefreshOllamaModels?: (force?: boolean) => void;
  /** Prefixed vision-capable Ollama ids (`ollama/llava`) — shown as a badge. */
  ollamaVisionModels?: ReadonlySet<string>;
  /** Exact model ids returned by the signed-in Antigravity account. */
  antigravityModels?: string[];
  /** Why the latest Antigravity auth or model refresh failed. */
  antigravityModelsError?: string;
  /** Re-fetch the signed-in account's Antigravity model ids. */
  onRefreshAntigravityModels?: () => void;
  opencodeModels?: string[];
  opencodeModelsError?: string;
  opencodeVisionModels?: ReadonlySet<string>;
  onRefreshOpencodeModels?: (force?: boolean) => void;
  providerCatalogs?: Partial<Record<ProviderCatalogKey, ProviderCatalogView>>;
  /** Model ids offered by every picker (opt-in allow-list — unlisted models
   *  are hidden). Global persistent setting (`enabledModels` in config.json),
   *  edited from Settings → Models. */
  enabledModels?: string[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  workspaceDir?: string;
  /** Messages typed while busy=true; rendered as removable chips above the textarea and auto-drained FIFO on turn-complete. */
  queuedSends?: QueuedSendItem[];
  /** Called when the user presses Enter or quick send while busy with a non-empty draft, payload, or pending images. Owns clearing the draft and images. */
  onQueueWhileBusy?: (
    send: string | QueuedSend,
    images?: { id: string; thumbnail: string; wire?: UserImageAttachment }[],
  ) => void;
  onDequeueSend?: (index: number) => void;
  /** Brings a queued message back into the composer to edit — removes it from the queue and restores its text + images. */
  onEditQueuedSend?: (index: number) => void;
  /** Sends the whole queue immediately — the app aborts the running turn so the drain fires on turn-complete. */
  onSendNow?: () => void;
  /** Vision attachments queued for the next send (ChatGPT models only). */
  pendingImages?: { id: string; thumbnail: string; wire?: UserImageAttachment }[];
  onRemoveImage?: (id: string) => void;
  /** True when the active model accepts image content (gpt-*). */
  imageCapable?: boolean;
  /** Vision path for clipboard images — bytes downscaled and attached. */
  onPasteImage?: (file: File) => Promise<void>;
  /** Fired when a paste is dropped because the active model can't accept
   *  image attachments. Lets the app explain and point at vision models. */
  onImageRejected?: () => void;
  /** Vision path for picked/dropped image paths — daemon reads the bytes. */
  onPickImage?: (path: string) => void;
  /** True when the active model accepts MiMo audio/video attachments. */
  mediaCapable?: boolean;
  /** MiMo path for picked/dropped audio/video paths — daemon reads the bytes. */
  onPickMedia?: (path: string) => void;
  /** Updates per-attachment video settings (MiMo fps / resolution). */
  onUpdateMedia?: (
    id: string,
    patch: { fps?: number; mediaResolution?: "default" | "max" },
  ) => void;
  /** Surfaces every voice-input failure as a durable in-chat error notice. */
  onVoiceError: (message: string) => void;
  /** True when at least one voice model is downloaded — the voice button is
   *  disabled (grayed out) when none are installed. */
  voiceAvailable?: boolean;
}) {
  const effortControlDisabled = supportedEfforts !== undefined && supportedEfforts.length === 0;
  const efforts = supportedEfforts && supportedEfforts.length > 0 ? supportedEfforts : EFFORTS;
  const displayEffort =
    supportedEfforts && supportedEfforts.length > 0
      ? (clampReasoningEffort(supportedEfforts, reasoningEffort) ?? reasoningEffort)
      : reasoningEffort;
  // The interrupt button throbs while an abort is in flight, clearing once the
  // turn actually stops.
  const [interrupting, startInterrupt] = usePendingStop(!busy);
  // One popup at a time from a single source of truth: `openMenu` names the only
  // menu that can be open, so opening one closes the others by itself.
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const menuWraps = useRef<Partial<Record<MenuId, HTMLDivElement | null>>>({});
  const toggleMenu = (id: MenuId) => setOpenMenu((cur) => (cur === id ? null : id));
  const closeMenu = () => setOpenMenu(null);
  // macOS Chinese IME fires compositionend BEFORE the confirm keydown.
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const [browseIdx, setBrowseIdx] = useState(-1);
  const savedDraftRef = useRef("");

  useEffect(() => {
    if (openMenu === null) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      for (const wrap of Object.values(menuWraps.current)) {
        if (wrap?.contains(target)) return;
      }
      setOpenMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [openMenu]);

  // The subagent pill unmounts when the session loses the tool, so a menu left open
  // across that switch would survive the state and pop open, unclicked, on the next
  // chat that has it.
  useEffect(() => {
    if (!subagentsEnabled) setOpenMenu((cur) => (cur === "subagent" ? null : cur));
  }, [subagentsEnabled]);

  const attachFile = async () => {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        defaultPath: workspaceDir,
      });
      if (typeof picked !== "string" || !picked) return;
      if (imageCapable && onPickImage && isImagePath(picked)) {
        onPickImage(resolveImagePath(picked, workspaceDir));
        return;
      }
      if (mediaCapable && onPickMedia && isAudioVideoPath(picked)) {
        onPickMedia(resolveImagePath(picked, workspaceDir));
        return;
      }
      const rel = toWorkspaceRelative(picked, workspaceDir);
      setDraft((current) => (current ? `${current.replace(/\s+$/, "")} ${rel} ` : `${rel} `));
      textareaRef.current?.focus();
    } catch (err) {
      recordFrontendFailure("frontend.attach_failed", err);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    if (imageCapable && onPasteImage) {
      try {
        await onPasteImage(file);
      } catch (err) {
        recordFrontendFailure("frontend.image_attach_failed", err);
      }
      return;
    }
    onImageRejected?.();
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
  };

  /** Recall history shared by typed sends and quick sends: trimmed, last 100 kept. */
  const rememberInHistory = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    historyRef.current.push(trimmed);
    if (historyRef.current.length > 100) historyRef.current.shift();
    setBrowseIdx(-1);
  };

  // Only the dropdown renders a quick send's shorthand; everything that leaves
  // the composer (chat bubble, queued chip, recall history) carries `message`,
  // because that is the text the model actually receives.
  const runQuickSend = (action: { message: string }) => {
    if (disabled) return;
    // The draft stays recallable; the send is remembered as the message (never
    // the shorthand), so ↑ can't resurrect a truncated command.
    rememberInHistory(draft);
    rememberInHistory(action.message);
    setDraft("");
    const send: QueuedSend = { text: action.message };
    if (busy) {
      if (onQueueWhileBusy) {
        onQueueWhileBusy(send);
      }
    } else {
      onSend(send);
    }
  };

  // The daemon always sends the built-ins with the customs, so the fallback only
  // covers a daemon that predates the quick-sends list.
  const quickSendOptions: QuickSend[] =
    quickSends && quickSends.length > 0 ? quickSends : [...BUILTIN_QUICK_SENDS];

  const navigateHistory = (dir: -1 | 1) => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (dir === -1) {
      const nextIdx = browseIdx + 1;
      if (nextIdx < hist.length) {
        if (browseIdx === -1) savedDraftRef.current = draft;
        setBrowseIdx(nextIdx);
        setDraft(hist[hist.length - 1 - nextIdx]);
      }
    } else {
      if (browseIdx > 0) {
        const nextIdx = browseIdx - 1;
        setBrowseIdx(nextIdx);
        setDraft(hist[hist.length - 1 - nextIdx]);
      } else if (browseIdx === 0) {
        setBrowseIdx(-1);
        setDraft(savedDraftRef.current);
      }
    }
  };

  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const transcribeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelReasonRef = useRef<"user" | "timeout" | null>(null);

  const clearTranscribeWatchdog = () => {
    if (transcribeTimerRef.current) {
      clearTimeout(transcribeTimerRef.current);
      transcribeTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      transcribeAbortRef.current?.abort();
      if (transcribeTimerRef.current) clearTimeout(transcribeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!voiceError) return;
    const timer = setTimeout(() => setVoiceError(null), 4000);
    return () => clearTimeout(timer);
  }, [voiceError]);

  const reportVoiceError = (stage: string, err: unknown) => {
    const reason = messageOf(err);
    const message = `Voice input failed during ${stage}: ${reason || "Unknown error."}`;
    setVoiceError(message);
    onVoiceError(message);
  };

  const handleToggleVoice = async () => {
    if (disabled) return;
    setVoiceError(null);

    if (voiceState === "transcribing") {
      // A click while transcribing cancels the in-flight recognition.
      cancelReasonRef.current = "user";
      transcribeAbortRef.current?.abort();
      return;
    }

    if (voiceState === "recording") {
      const recorder = recorderRef.current;
      if (!recorder) {
        reportVoiceError(
          "recording stop",
          new Error("The active microphone recorder was unavailable."),
        );
        setVoiceState("idle");
        return;
      }
      setVoiceState("transcribing");
      const controller = new AbortController();
      transcribeAbortRef.current = controller;
      cancelReasonRef.current = null;
      transcribeTimerRef.current = setTimeout(() => {
        cancelReasonRef.current = "timeout";
        transcribeAbortRef.current?.abort();
      }, TRANSCRIBE_TIMEOUT_MS);
      try {
        const { audioData } = await recorder.stop();
        recorderRef.current = null;
        const { text } = await speechTranscriber.transcribe(audioData, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!text.trim()) {
          throw new Error("The speech recognizer returned no transcript.");
        }
        setDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
        textareaRef.current?.focus();
      } catch (err) {
        if (cancelReasonRef.current === "timeout") {
          speechTranscriber.reset();
          reportVoiceError(
            "transcription",
            new Error("Transcription timed out. The speech model may be stuck; it will reload."),
          );
        } else if (cancelReasonRef.current === null) {
          reportVoiceError("recording or transcription", err);
        }
        // A user-initiated cancel is silent.
      } finally {
        clearTranscribeWatchdog();
        transcribeAbortRef.current = null;
        cancelReasonRef.current = null;
        recorder.cancel();
        recorderRef.current = null;
        setVoiceState("idle");
      }
      return;
    }

    if (voiceState === "idle") {
      const recorder = new AudioRecorder({
        onError: (err) => reportVoiceError("audio cleanup", err),
        deviceId: getSelectedAudioInputDeviceId(),
      });
      recorderRef.current = recorder;
      try {
        await recorder.start();
        setVoiceState("recording");
      } catch (err) {
        recorder.cancel();
        recorderRef.current = null;
        reportVoiceError("microphone startup", err);
        setVoiceState("idle");
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = textareaRef.current;
    if (e.key === "ArrowUp" && ta && ta.selectionStart === 0) {
      e.preventDefault();
      navigateHistory(-1);
      return;
    }
    if (e.key === "ArrowDown" && ta && ta.selectionStart === draft.length) {
      e.preventDefault();
      navigateHistory(1);
      return;
    }
    if (e.key === "Escape" && openMenu !== null) {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (composingRef.current || Date.now() - compositionEndedAtRef.current < 50) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (busy) {
        const text = draft.trim();
        const hasPendingImages = pendingImages && pendingImages.length > 0;
        if ((text || hasPendingImages) && onQueueWhileBusy) {
          onQueueWhileBusy(text, hasPendingImages ? [...pendingImages] : undefined);
        }
      } else if (!disabled && (draft.trim() || (pendingImages && pendingImages.length > 0))) {
        rememberInHistory(draft);
        onSend();
      }
    }
  };

  // Single source for "a turn is engaged": the status row, its timers and the
  // queue/interrupt hints must never disagree about it.
  const turnActive = busy ?? false;
  const statusText = turnActive && busyLabel ? busyLabel : null;

  const modelListProps = {
    ollamaModels,
    ollamaModelsError,
    ollamaHiddenCount,
    ollamaVisionModels,
    antigravityModels,
    antigravityModelsError,
    opencodeModels,
    opencodeModelsError,
    opencodeVisionModels,
    enabledModels,
    providerCatalogs,
    onRefreshOllamaModels,
    onRefreshAntigravityModels,
    onRefreshOpencodeModels,
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {queuedSends && queuedSends.length > 0 ? (
          <div className="composer-queued">
            <span className="composer-queued-label">
              {t("composer.queueCount", { n: queuedSends.length })}
            </span>
            {queuedSends.map((raw, i) => {
              const item = typeof raw === "string" ? { text: raw } : raw;
              const images = item.images;
              const hasImages = Boolean(images && images.length > 0);
              const tooltip = [
                item.text,
                hasImages && images
                  ? `(${images.length} image${images.length > 1 ? "s" : ""})`
                  : null,
              ]
                .filter(Boolean)
                .join(" ");
              // Hoisted so the chip's text and its pencil share one handler.
              const editQueued = onEditQueuedSend ? () => onEditQueuedSend(i) : undefined;

              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: queue is dequeue-by-index; chips are text-only leaves
                <span key={i} className="composer-queue-chip" title={tooltip}>
                  {hasImages && images ? (
                    <span className="composer-queue-chip-images">
                      {images.map((im) => (
                        <img
                          key={im.id}
                          src={im.thumbnail}
                          alt=""
                          className="composer-queue-chip-img"
                        />
                      ))}
                    </span>
                  ) : null}
                  {item.text ? (
                    <span
                      className={editQueued ? "text editable" : "text"}
                      onClick={editQueued}
                      onKeyDown={editQueued ? activationHandler(editQueued) : undefined}
                    >
                      {item.text}
                    </span>
                  ) : null}
                  {editQueued ? (
                    <span
                      className="edit"
                      title={t("composer.editQueued")}
                      onClick={editQueued}
                      onKeyDown={activationHandler(editQueued)}
                    >
                      <I.pencil size={10} />
                    </span>
                  ) : null}
                  {onDequeueSend ? (
                    <span
                      className="x"
                      onClick={() => onDequeueSend(i)}
                      onKeyDown={activationHandler(() => onDequeueSend(i))}
                    >
                      <I.x size={10} />
                    </span>
                  ) : null}
                </span>
              );
            })}
            {onSendNow ? (
              <button type="button" className="composer-queued-send" onClick={onSendNow}>
                <I.send size={11} />
                {t("composer.sendNow")}
              </button>
            ) : null}
          </div>
        ) : null}

        {statusText ? (
          <div className="composer-busy-row">
            <span className="composer-busy-pip" />
            <span className="composer-busy-label">{statusText}</span>
            <TimerSpan active={turnActive} className="composer-busy-time" />
            {stuckLabel ? (
              <StuckLabel
                active={turnActive}
                sinceMs={stuckLabel.sinceMs}
                render={(sec) => (
                  <span className="composer-busy-stuck">{stuckLabel.render(sec)}</span>
                )}
              />
            ) : null}
          </div>
        ) : null}

        <div className="hint-row">
          <span className="grow" />
          <ModeSwitch mode={editMode} onChange={onEditModeChange} />
          <span className="hint-sep" />
          <span>
            {statusText ? (
              <>
                <Shortcut keys={["enter"]} /> {t("composer.queue")} &nbsp;·&nbsp;{" "}
                <Shortcut keys={["esc"]} /> {t("composer.interrupt")}
              </>
            ) : (
              <>
                <Shortcut keys={["enter"]} /> {t("composer.send")} &nbsp;{" "}
                <Shortcut keys={["shift", "enter"]} /> {t("composer.newline")}
              </>
            )}
          </span>
        </div>

        <div className="composer">
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder={t("composer.placeholder")}
            onChange={handleChange}
            onPaste={(e) => void handlePaste(e)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              compositionEndedAtRef.current = Date.now();
            }}
            rows={DEFAULT_COMPOSER_ROWS}
            disabled={disabled}
          />

          {pendingImages && pendingImages.length > 0 ? (
            <div className="composer-images">
              {pendingImages.map((im) => {
                const wire = im.wire;
                const video = wire?.source === "file" && wire.kind === "video" ? wire : null;
                return (
                  <div key={im.id} className="composer-image">
                    <img src={im.thumbnail} alt="" />
                    {onRemoveImage ? (
                      <button
                        type="button"
                        className="composer-image-remove"
                        title={t("composer.removeImage")}
                        onClick={() => onRemoveImage(im.id)}
                      >
                        <I.x size={11} />
                      </button>
                    ) : null}
                    {video && onUpdateMedia ? (
                      <div className="composer-video-opts">
                        <input
                          type="number"
                          min={0.1}
                          max={10}
                          step={0.1}
                          value={video.fps ?? 2}
                          title={t("composer.videoFps")}
                          onChange={(e) =>
                            onUpdateMedia(im.id, { fps: clampVideoFps(e.target.value) })
                          }
                        />
                        <select
                          value={video.mediaResolution ?? "default"}
                          title={t("composer.videoResolution")}
                          onChange={(e) =>
                            onUpdateMedia(im.id, {
                              mediaResolution: e.target.value === "max" ? "max" : "default",
                            })
                          }
                        >
                          <option value="default">{t("composer.videoResolutionDefault")}</option>
                          <option value="max">{t("composer.videoResolutionMax")}</option>
                        </select>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="composer-foot">
            <button
              type="button"
              className="cf-btn"
              title={t("composer.insertFile")}
              onClick={() => void attachFile()}
            >
              <span className="ico">
                <I.paperclip size={14} />
              </span>
            </button>

            <span className="grow" />

            <div
              ref={(el) => {
                menuWraps.current.model = el;
              }}
              className="model-pill-wrap"
            >
              <button
                type="button"
                className="model-pill"
                onClick={() => toggleMenu("model")}
                title={t("composer.switchModel")}
              >
                <I.brain size={12} />
                <span>{modelDisplayName(modelLabel)}</span>
                <I.chev size={10} />
              </button>
              {openMenu === "model" ? (
                <MenuPop width={420}>
                  <MenuHeader label={t("composer.switchModel")} />
                  <ModelList
                    activeModel={modelLabel}
                    onPick={(m) => {
                      onModelChange(m);
                      closeMenu();
                    }}
                    {...modelListProps}
                  />
                </MenuPop>
              ) : null}
            </div>
            {subagentsEnabled ? (
              <div
                ref={(el) => {
                  menuWraps.current.subagent = el;
                }}
                className="model-pill-wrap"
              >
                <button
                  type="button"
                  className="model-pill subagent-pill"
                  onClick={() => toggleMenu("subagent")}
                  title={t("composer.switchSubagentModel")}
                >
                  <I.bot size={12} />
                  <span>{modelDisplayName(subagentModelLabel)}</span>
                  <I.chev size={10} />
                </button>
                {openMenu === "subagent" ? (
                  <MenuPop width={420}>
                    <MenuHeader label={t("composer.switchSubagentModel")} />
                    <ModelList
                      activeModel={subagentModelLabel}
                      onPick={(m) => {
                        onSubagentModelChange(m);
                        closeMenu();
                      }}
                      {...modelListProps}
                    />
                  </MenuPop>
                ) : null}
              </div>
            ) : null}
            <div
              ref={(el) => {
                menuWraps.current.effort = el;
              }}
              className="model-pill-wrap"
            >
              <button
                type="button"
                className="model-pill effort-pill"
                disabled={effortControlDisabled}
                onClick={() => {
                  if (!effortControlDisabled) toggleMenu("effort");
                }}
                title={t("composer.switchEffort")}
              >
                <I.cpu size={12} />
                <span>{displayEffort}</span>
                <I.chev size={10} />
              </button>
              {openMenu === "effort" && !effortControlDisabled ? (
                <MenuPop width={320}>
                  <MenuHeader label={t("composer.switchEffort")} />
                  <div className="popup-list effort-menu-list">
                    {efforts.map((e) => (
                      <MenuRow
                        key={e}
                        icon={<I.cpu size={12} />}
                        label={e}
                        desc={t(`effort.${e}Desc` as TKey)}
                        active={e === displayEffort}
                        onPick={() => {
                          onEffortChange(e);
                          closeMenu();
                        }}
                      />
                    ))}
                  </div>
                </MenuPop>
              ) : null}
            </div>
            <div
              ref={(el) => {
                menuWraps.current.quick = el;
              }}
              className="quick-send-wrap"
            >
              <button
                type="button"
                className="quick-proceed-btn"
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={openMenu === "quick"}
                onClick={() => toggleMenu("quick")}
                title={t("composer.quickSendTitle")}
              >
                <I.play size={11} />
                <span>{t("composer.quickSendTitle")}</span>
                <I.chev size={10} />
              </button>
              {openMenu === "quick" ? (
                <MenuPop width={320}>
                  <MenuHeader label={t("composer.quickSendTitle")} />
                  <div className="popup-list">
                    {quickSendOptions.map((q) => (
                      <MenuRow
                        key={q.id}
                        icon={<I.play size={12} />}
                        label={q.shorthand}
                        desc={q.message}
                        active={q.id === activeQuickSendId}
                        onPick={() => {
                          runQuickSend(q);
                          onPickQuickSend?.(q.id);
                          closeMenu();
                        }}
                      />
                    ))}
                  </div>
                </MenuPop>
              ) : null}
            </div>
            <button
              type="button"
              className={`voice-btn ${voiceState === "recording" ? "recording" : ""} ${voiceState === "transcribing" ? "transcribing" : ""}`}
              disabled={disabled || !voiceAvailable}
              aria-busy={voiceState === "transcribing"}
              onClick={handleToggleVoice}
              title={
                !voiceAvailable
                  ? t("composer.voiceUnavailable")
                  : voiceError
                    ? t("composer.voiceError", { error: voiceError })
                    : voiceState === "recording"
                      ? t("composer.voiceRecording")
                      : voiceState === "transcribing"
                        ? t("composer.voiceTranscribingCancel")
                        : t("composer.voiceInput")
              }
            >
              {voiceState === "recording" ? (
                <I.stop size={13} />
              ) : voiceState === "transcribing" ? (
                <span
                  className="spin voice-throbber processing-indicator"
                  role="status"
                  aria-label={t("composer.voiceTranscribing")}
                  aria-live="polite"
                />
              ) : (
                <I.mic size={13} />
              )}
              {voiceError ? <div className="voice-error-tooltip">{voiceError}</div> : null}
            </button>
            {busy ? (
              <StopButton
                className="send-btn stop"
                iconSize={14}
                title={t("composer.interrupt")}
                busy={interrupting}
                onClick={() => {
                  startInterrupt();
                  onAbort();
                }}
              />
            ) : (
              <button
                type="button"
                className="send-btn"
                disabled={disabled || !draft.trim()}
                onClick={() => {
                  if (!disabled && draft.trim()) {
                    rememberInHistory(draft);
                    onSend();
                  }
                }}
              >
                <I.send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared model picker column. Rendered once per selector (main agent and
 *  subagent) so both expose the exact same model options — KNOWN_MODELS, the
 *  signed-in Antigravity group, the Ollama catalog, and a custom-model input. */
function ModelList({
  activeModel,
  onPick,
  ollamaModels,
  ollamaModelsError,
  ollamaHiddenCount,
  ollamaVisionModels,
  antigravityModels,
  antigravityModelsError,
  opencodeModels,
  opencodeModelsError,
  opencodeVisionModels,
  enabledModels,
  providerCatalogs,
  onRefreshOllamaModels,
  onRefreshAntigravityModels,
  onRefreshOpencodeModels,
}: {
  activeModel: string;
  onPick: (model: string) => void;
  ollamaModels?: string[];
  ollamaModelsError?: string;
  ollamaHiddenCount?: number;
  ollamaVisionModels?: ReadonlySet<string>;
  antigravityModels?: string[];
  antigravityModelsError?: string;
  opencodeModels?: string[];
  opencodeModelsError?: string;
  opencodeVisionModels?: ReadonlySet<string>;
  providerCatalogs?: Partial<Record<ProviderCatalogKey, ProviderCatalogView>>;
  /** Model ids offered by the picker (opt-in allow-list). The active model
   *  always stays visible so a running tab can never strand itself. */
  enabledModels?: string[];
  onRefreshOllamaModels?: (force?: boolean) => void;
  onRefreshAntigravityModels?: () => void;
  onRefreshOpencodeModels?: (force?: boolean) => void;
}) {
  const catalog = deriveModelCatalog({
    providerCatalogs,
    discoveredAntigravityModels: antigravityModels,
    opencodeModels,
    includeAntigravity: Boolean(antigravityModels),
    ollamaVisionModels,
    opencodeVisionModels,
  });
  const ollamaGroup = Boolean(ollamaModels && ollamaModels.length > 0);

  // Global allow-list from Settings → Models: only enabled models are offered.
  // The active model always stays visible so a running tab can never strand
  // itself, even when it isn't on the allow-list (or the list is empty).
  const enabledSet = new Set(enabledModels ?? []);
  const visibleUnlessActive = (id: string): boolean => id === activeModel || enabledSet.has(id);

  type GroupDef = {
    key: string;
    title: string;
    models: readonly string[];
    icon?: (props: { size?: number }) => React.ReactNode;
    refresh?: () => void;
    refreshTitle?: string;
    error?: string;
    note?: string;
  };

  const groups: GroupDef[] = [
    ...catalog.groups.map(
      (group): GroupDef => ({
        ...group,
        title: t(MODEL_CATALOG_GROUP_LABELS[group.key]),
        ...(group.key === "opencode"
          ? {
              refresh: onRefreshOpencodeModels ? () => onRefreshOpencodeModels(true) : undefined,
              refreshTitle: t("settings.modelsRefresh"),
              error: opencodeModelsError
                ? t("composer.modelOpencodeError", { error: opencodeModelsError })
                : undefined,
            }
          : {}),
        ...(group.key === "antigravity"
          ? {
              refresh: onRefreshAntigravityModels,
              refreshTitle: t("settings.modelsRefresh"),
              error: antigravityModelsError
                ? t("composer.modelAntigravityError", { error: antigravityModelsError })
                : undefined,
            }
          : {}),
      }),
    ),
    ...(!catalog.groups.some((group) => group.key === "antigravity") && antigravityModelsError
      ? [
          {
            key: "antigravity",
            title: t("composer.modelAntigravityGroup"),
            models: [],
            refresh: onRefreshAntigravityModels,
            refreshTitle: t("settings.modelsRefresh"),
            error: t("composer.modelAntigravityError", { error: antigravityModelsError }),
          },
        ]
      : []),
    ...(ollamaGroup || ollamaModelsError
      ? [
          {
            key: "ollama",
            title: t("composer.modelOllamaGroup"),
            models: (ollamaModels ?? []).map((id) => `ollama/${id}`),
            icon: I.bot,
            refresh: () => onRefreshOllamaModels?.(true),
            refreshTitle: t("settings.modelsRefresh"),
            error:
              ollamaModelsError && !ollamaGroup && activeModel.startsWith("ollama/")
                ? t("composer.modelOllamaError", { error: ollamaModelsError })
                : undefined,
            note:
              ollamaHiddenCount && ollamaHiddenCount > 0
                ? t("composer.modelOllamaHidden", { count: ollamaHiddenCount })
                : undefined,
          },
        ]
      : []),
  ];

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      models: group.models.filter(visibleUnlessActive),
    }))
    .filter((group) => {
      // Keep group headers that carry an error/refresh affordance even when
      // every model in them is hidden; drop purely empty catalog groups.
      if (group.error) return true;
      if (group.key === "ollama" && ollamaModelsError) return true;
      if (group.key === "antigravity" && antigravityModelsError) return true;
      return group.models.length > 0;
    });

  return (
    <div className="popup-list model-menu-list">
      {enabledModels && enabledModels.length > 0 ? null : (
        <div className="model-menu-error">{t("composer.modelNoneEnabled")}</div>
      )}
      {visibleGroups.map((group) => {
        if (group.models.length === 0 && !group.error) return null;
        const Icon = group.icon ?? I.brain;
        return (
          <Fragment key={group.key}>
            <div className="model-menu-group">
              <span className="grow">{group.title}</span>
              {group.note ? <span className="model-menu-note">{group.note}</span> : null}
              {group.refresh ? (
                <button
                  type="button"
                  className="mini-btn"
                  title={group.refreshTitle}
                  onClick={group.refresh}
                >
                  <I.refresh size={10} />
                </button>
              ) : null}
            </div>
            {group.error ? <div className="model-menu-error">{group.error}</div> : null}
            {group.models.map((model) => (
              <div
                key={model}
                className="popup-item"
                data-active={model === activeModel}
                onClick={() => onPick(model)}
                onKeyDown={activationHandler(() => onPick(model))}
              >
                <span className="ico">
                  <Icon size={12} />
                </span>
                <div className="nm">
                  <span className="cmd">{modelDisplayName(model)}</span>
                </div>
                {catalog.acceptsImages(model) ? <span className="badge">vision</span> : null}
              </div>
            ))}
          </Fragment>
        );
      })}
      {!groups.some((group) => group.models.includes(activeModel)) && (
        <div
          className="popup-item"
          data-active="true"
          onClick={() => onPick(activeModel)}
          onKeyDown={activationHandler(() => onPick(activeModel))}
        >
          <span className="ico">
            <I.brain size={12} />
          </span>
          <div className="nm">
            <span className="cmd">{modelDisplayName(activeModel)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Dropdown title row: names the menu above its options. */
function MenuHeader({ label }: { label: string }) {
  return <div className="ph">{label}</div>;
}

/** Shared dropdown row — icon + label + optional description, activated by
 *  click or keyboard. Backs the quick-send and reasoning-effort menus. */
function MenuRow({
  icon,
  label,
  desc,
  active,
  onPick,
}: {
  icon: React.ReactNode;
  label: string;
  desc?: string;
  active?: boolean;
  onPick: () => void;
}) {
  return (
    <div
      className="popup-item"
      data-active={active}
      onClick={onPick}
      onKeyDown={activationHandler(onPick)}
    >
      <span className="ico">{icon}</span>
      <div className="nm">
        <span className="cmd">{label}</span>
        {desc !== undefined ? <div className="desc">{desc}</div> : null}
      </div>
    </div>
  );
}

/** Fixed-position popup anchored to its wrapper (the pill's `position:
 *  relative` container). The picker sits inside the `.main` column, which has
 *  `overflow: hidden` — an absolutely positioned popup would get clipped at
 *  the sidebar boundary and render behind it. Pinning to the viewport escapes
 *  the clip and stacks above the sidebar, anchored to the pill's box and
 *  clamped to the window. */
function MenuPop({ width, children }: { width: number; children: React.ReactNode }) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [visible, setVisible] = useState(false);
  useLayoutEffect(() => {
    const position = () => {
      const pop = popRef.current;
      const wrap = pop?.parentElement; // the pill wrapper
      if (!pop || !wrap) return;
      const wr = wrap.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;
      const w = Math.min(width, vw - 16);
      const left = Math.max(pad, Math.min(wr.right - w, vw - w - pad));
      let top = wr.top - pr.height - 6;
      if (top < pad) top = wr.bottom + 6; // no room above the pill — open below
      top = Math.max(pad, Math.min(top, vh - pr.height - pad));
      setPos({ left, top });
      setVisible(true);
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [width]);

  return (
    <div
      ref={popRef}
      className="popup"
      style={{
        position: "fixed",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        bottom: "auto",
        right: "auto",
        width: `min(${width}px, calc(100vw - 16px))`,
        visibility: visible ? undefined : "hidden",
      }}
    >
      {children}
    </div>
  );
}
