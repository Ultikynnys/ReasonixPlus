import { DEFAULT_MODEL, modelDisplayName } from "@reasonix/core-utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Settings as SettingsType } from "../App";
import { formatBytes } from "../format";
import { t, type TKey } from "../i18n";
import { I } from "../icons";
import { MODEL_CATALOG_GROUP_LABELS, deriveModelCatalog, type ModelCatalogGroupKey } from "../model-catalog";
import type {
  McpExtensionCheck,
  McpExtensionStatus,
  McpSpecInfo,
  MailAuthPhase,
  MailAuthState,
  PlaywrightBrowserInstall,
  PlaywrightManagedBrowser,
  PlaywrightMcpConnectionMode,
  PlaywrightExtensionBrowser,
  MemoryDetail,
  MemoryEntryInfo,
  SettingsPatch,
} from "../protocol";
import {
  MailProvider,
  QUICK_SEND_SHORTHAND_MAX_LENGTH,
  allQuickSends,
  enforceQuickSendShorthand,
} from "../protocol";
import { FONT_FAMILY, FONT_SCALE, type FontFamily, type FontScale } from "../theme";
import { AudioRecorder } from "../voice/audio-recorder";
import {
  type AudioInputDevice,
  getSelectedAudioInputDeviceId,
  hasMicrophonePermission,
  listAudioInputDevices,
  requestMicrophoneAccess,
  resolveSelectedDeviceId,
  setSelectedAudioInputDeviceId,
} from "../voice/device";
import {
  VOICE_MODELS,
  type VoiceModelId,
  deleteVoiceModelCache,
  getActiveVoiceModelId,
  isVoiceModelDownloaded,
} from "../voice/models";
import { speechTranscriber } from "../voice/transcriber";
import { activationHandler, escapeHandler } from "./keyboard";
import { Shortcut, type ShortcutKey } from "./shortcut";

/** Render i18n hint strings that embed `<code>…</code>` tags as styled fragments
 *  (no dangerouslySetInnerHTML — the markup is translator-authored, but React nodes keep it static). */
function hintNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<code>([^<]+)<\/code>/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index!));
    out.push(<code key={n}>{m[1]}</code>);
    n += 1;
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Masked key-status line: "Set · ab…yz" when a key is present, "(not set)"
 *  otherwise. The single source shared by every provider-key row (DeepSeek, the
 *  provider API-key rows, and the mixed search-engine references). */
function keyStatusText(prefix: string | undefined): string {
  return prefix ? t("settings.apiKeySet", { prefix }) : t("settings.apiKeyNotSet");
}

export type PageId = "general" | "models" | "mcp" | "memory" | "rules" | "shortcuts";

const PAGE_META: ReadonlyArray<{ id: PageId; icon: keyof typeof I }> = [
  { id: "general", icon: "cog" },
  { id: "models", icon: "brain" },
  { id: "mcp", icon: "wrench" },
  { id: "memory", icon: "bookmark" },
  { id: "rules", icon: "shield" },
  { id: "shortcuts", icon: "cpu" },
];

export function SettingsModal({
  settings,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  initialPage,
  mcpSpecs,
  mcpBridged,
  memory,
  memoryDetail,
  memoryResult,
  onClose,
  onSave,
  onSaveApiKey,
  oauthWaiting,
  onOAuthBegin,
  onOAuthCancel,
  onOAuthSignOut,
  onSaveOpenAIApiKey,
  antigravityOAuthWaiting,
  onAntigravityOAuthBegin,
  onAntigravityOAuthCancel,
  onAntigravityOAuthSignOut,
  ollamaBaseUrl,
  ollamaModels,
  ollamaModelsError,
  ollamaPlan,
  ollamaHiddenCount,
  ollamaVisionModels,
  onRefreshOllamaModels,
  opencodeModels,
  opencodeModelsError,
  opencodeVisionModels,
  onRefreshOpencodeModels,
  onAddMcpSpec,
  onRemoveMcpSpec,
  onToggleMcpServer,
  onToggleMcpTool,
  mcpExtensionStatus,
  mcpExtensionCheck,
  playwrightBrowserInstall,
  onRequestMcpExtensionStatus,
  onConfigureMcpExtension,
  onCheckMcpExtension,
  onInstallPlaywrightBrowser,
  onCancelPlaywrightBrowserInstall,
  mailProvider,
  mailAuth,
  onSetMailProvider,
  onRequestMailStatus,
  onConfigureMail,
  onConnectMail,
  onCancelMail,
  onSignOutMail,
  onReadMemory,
  onWriteMemory,
  onDeleteMemory,
  onExportMemories,
  onImportMemories,
  onDismissMemoryResult,
  onAddRule,
  onRemoveRule,
}: {
  settings: SettingsType;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  initialPage?: PageId;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  memoryResult: { ok: boolean; message: string } | null;
  onAddRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onRemoveRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onClose: () => void;
  onSave: (patch: SettingsPatch) => void;
  onSaveApiKey: (key: string) => void;
  /** Ollama chat endpoint (OpenAI-compatible) shown on the Models page. */
  ollamaBaseUrl?: string;
  /** Dynamically fetched Ollama models (raw ids) — rendered as a scrollable grid. */
  ollamaModels?: string[];
  /** Why the last fetch failed — replaces the grid so the failure isn't silent. */
  ollamaModelsError?: string;
  /** The account's Ollama plan (e.g. `free`) when the cloud reported it. */
  ollamaPlan?: string;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount?: number;
  /** Re-fetch the Ollama model catalog (`force` bypasses the backend's cache). */
  onRefreshOllamaModels?: (force?: boolean) => void;
  /** Prefixed vision-capable Ollama ids (`ollama/llava`) — shown as a badge. */
  ollamaVisionModels?: ReadonlySet<string>;
  opencodeModels?: string[];
  opencodeModelsError?: string;
  opencodeVisionModels?: ReadonlySet<string>;
  onRefreshOpencodeModels?: (force?: boolean) => void;
  oauthWaiting: boolean;
  onOAuthBegin: () => void;
  onOAuthCancel: () => void;
  onOAuthSignOut: () => void;
  onSaveOpenAIApiKey: (key: string) => void;
  antigravityOAuthWaiting: boolean;
  onAntigravityOAuthBegin: () => void;
  onAntigravityOAuthCancel: () => void;
  onAntigravityOAuthSignOut: () => void;
  onAddMcpSpec: (spec: string) => void;
  onRemoveMcpSpec: (spec: string) => void;
  onToggleMcpServer: (name: string, disabled: boolean) => void;
  onToggleMcpTool: (name: string, tool: string, disabled: boolean) => void;
  mcpExtensionStatus: McpExtensionStatus | null;
  mcpExtensionCheck: McpExtensionCheck | null;
  playwrightBrowserInstall: PlaywrightBrowserInstall | null;
  onRequestMcpExtensionStatus: () => void;
  onConfigureMcpExtension: (
    mode: PlaywrightMcpConnectionMode,
    token?: string,
    cdpEndpoint?: string,
    extensionBrowser?: PlaywrightExtensionBrowser,
  ) => void;
  onCheckMcpExtension: () => void;
  onInstallPlaywrightBrowser: (browser: PlaywrightManagedBrowser) => void;
  onCancelPlaywrightBrowserInstall: (browser: PlaywrightManagedBrowser) => void;
  mailProvider: MailProvider;
  mailAuth: MailAuthState | null;
  onSetMailProvider: (provider: MailProvider) => void;
  onRequestMailStatus: (provider: MailProvider) => void;
  onConfigureMail: (provider: MailProvider, clientId?: string, clientSecret?: string) => void;
  onConnectMail: (provider: MailProvider) => void;
  onCancelMail: (provider: MailProvider) => void;
  onSignOutMail: (provider: MailProvider) => void;
  onReadMemory: (path: string) => void;
  onWriteMemory: (
    scope: "global" | "project",
    name: string,
    description: string,
    body: string,
  ) => void;
  onDeleteMemory: (path: string) => void;
  onExportMemories: () => void;
  onImportMemories: (json: string) => void;
  onDismissMemoryResult: () => void;
}) {
  const [page, setPage] = useState<PageId>(initialPage ?? "general");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const currentMeta = PAGE_META.find((p) => p.id === page) ?? PAGE_META[0]!;
  return (
    <div
      className="settings-mask"
      onClick={onClose}
      onKeyDown={escapeHandler(onClose)}
      tabIndex={-1}
    >
      <div
        className="settings"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-side">
          <div className="sg">{t("settings.title")}</div>
          {PAGE_META.map((p) => (
            <div
              key={p.id}
              className="row"
              data-active={page === p.id}
              onClick={() => setPage(p.id)}
              onKeyDown={activationHandler(() => setPage(p.id))}
            >
              <span className="ico">{I[p.icon]({ size: 13 })}</span>
              <span>{t(`settings.page${p.id[0]!.toUpperCase()}${p.id.slice(1)}Label` as any)}</span>
            </div>
          ))}
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <div>
              <h2>
                {t(
                  `settings.page${currentMeta.id[0]!.toUpperCase()}${currentMeta.id.slice(1)}Label` as any,
                )}
              </h2>
              <div className="desc">
                {t(
                  `settings.page${currentMeta.id[0]!.toUpperCase()}${currentMeta.id.slice(1)}Desc` as any,
                )}
              </div>
            </div>
            <span className="grow" />
            <button type="button" className="close-btn" onClick={onClose}>
              <I.x size={14} />
            </button>
          </div>
          <div className="settings-body">
            {page === "general" && (
              <PageGeneral
                settings={settings}
                fontScale={fontScale}
                onSetFontScale={onSetFontScale}
                fontFamily={fontFamily}
                onSetFontFamily={onSetFontFamily}
                customFontFamily={customFontFamily}
                onSetCustomFontFamily={onSetCustomFontFamily}
                onSave={onSave}
              />
            )}
            {page === "models" && (
              <PageModels
                settings={settings}
                onSave={onSave}
                baseUrl={settings.baseUrl}
                apiKeyPrefix={settings.apiKeyPrefix}
                onSaveApiKey={onSaveApiKey}
                ollamaBaseUrl={ollamaBaseUrl}
                ollamaModels={ollamaModels}
                ollamaModelsError={ollamaModelsError}
                ollamaPlan={ollamaPlan}
                ollamaHiddenCount={ollamaHiddenCount}
                ollamaVisionModels={ollamaVisionModels}
                onRefreshOllamaModels={onRefreshOllamaModels}
                opencodeModels={opencodeModels}
                opencodeModelsError={opencodeModelsError}
                opencodeVisionModels={opencodeVisionModels}
                onRefreshOpencodeModels={onRefreshOpencodeModels}
                oauthSignedIn={settings.openaiOAuth?.signedIn ?? false}
                oauthAccount={settings.openaiOAuth?.account}
                oauthFlowError={settings.openaiOAuth?.flowError}
                oauthWaiting={oauthWaiting}
                onOAuthBegin={onOAuthBegin}
                onOAuthCancel={onOAuthCancel}
                onOAuthSignOut={onOAuthSignOut}
                onSaveOpenAIApiKey={onSaveOpenAIApiKey}
                antigravitySignedIn={settings.antigravityOAuth?.signedIn ?? false}
                antigravityAccount={settings.antigravityOAuth?.account}
                antigravityFlowError={settings.antigravityOAuth?.flowError}
                antigravityWaiting={antigravityOAuthWaiting}
                onAntigravityBegin={onAntigravityOAuthBegin}
                onAntigravityCancel={onAntigravityOAuthCancel}
                onAntigravitySignOut={onAntigravityOAuthSignOut}
              />
            )}
            {page === "mcp" && (
              <PageMCP
                specs={mcpSpecs}
                bridged={mcpBridged}
                onAdd={onAddMcpSpec}
                onRemove={onRemoveMcpSpec}
                onToggleServer={onToggleMcpServer}
                onToggleTool={onToggleMcpTool}
                extensionStatus={mcpExtensionStatus}
                extensionCheck={mcpExtensionCheck}
                browserInstall={playwrightBrowserInstall}
                onRequestExtensionStatus={onRequestMcpExtensionStatus}
                onConfigureExtension={onConfigureMcpExtension}
                onCheckExtension={onCheckMcpExtension}
                onInstallBrowser={onInstallPlaywrightBrowser}
                onCancelBrowserInstall={onCancelPlaywrightBrowserInstall}
                mailProvider={mailProvider}
                mailAuth={mailAuth}
                onSetMailProvider={onSetMailProvider}
                onRequestMailStatus={onRequestMailStatus}
                onConfigureMail={onConfigureMail}
                onConnectMail={onConnectMail}
                onCancelMail={onCancelMail}
                onSignOutMail={onSignOutMail}
              />
            )}
            {page === "memory" && (
              <PageMemory
                entries={memory}
                detail={memoryDetail}
                result={memoryResult}
                onRead={onReadMemory}
                onWrite={onWriteMemory}
                onDelete={onDeleteMemory}
                onExport={onExportMemories}
                onImport={onImportMemories}
                onDismissResult={onDismissMemoryResult}
              />
            )}
            {page === "rules" && (
              <PageRules settings={settings} onAddRule={onAddRule} onRemoveRule={onRemoveRule} />
            )}
            {page === "shortcuts" && <PageShortcuts />}
          </div>
        </div>
      </div>
    </div>
  );
}

function PageGeneral({
  settings,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  onSave,
}: {
  settings: SettingsType;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [customFontDraft, setCustomFontDraft] = useState(customFontFamily);
  useEffect(() => {
    setCustomFontDraft(customFontFamily);
  }, [customFontFamily]);
  const [quickSendShorthand, setQuickSendShorthand] = useState("");
  const [quickSendMessage, setQuickSendMessage] = useState("");
  const commitCustomFont = (value: string) => {
    const next = value.trim();
    setCustomFontDraft(next);
    onSetCustomFontFamily(next);
  };
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.appearanceSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.fontScale")}</div>
            <div className="h">{t("settings.fontScaleHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.SMALL}
              onClick={() => onSetFontScale(FONT_SCALE.SMALL)}
            >
              {t("settings.fontScaleSmall")}
            </button>
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.MEDIUM}
              onClick={() => onSetFontScale(FONT_SCALE.MEDIUM)}
            >
              {t("settings.fontScaleMedium")}
            </button>
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.LARGE}
              onClick={() => onSetFontScale(FONT_SCALE.LARGE)}
            >
              {t("settings.fontScaleLarge")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.fontFamily")}</div>
            <div className="h">{t("settings.fontFamilyHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SANS}
              onClick={() => onSetFontFamily(FONT_FAMILY.SANS)}
            >
              {t("settings.fontFamilySans")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SYSTEM}
              onClick={() => onSetFontFamily(FONT_FAMILY.SYSTEM)}
            >
              {t("settings.fontFamilySystem")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SERIF}
              onClick={() => onSetFontFamily(FONT_FAMILY.SERIF)}
            >
              {t("settings.fontFamilySerif")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.CUSTOM}
              onClick={() => onSetFontFamily(FONT_FAMILY.CUSTOM)}
            >
              {t("settings.fontFamilyCustom")}
            </button>
          </div>
        </div>
        {fontFamily === FONT_FAMILY.CUSTOM && (
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.customFontFamily")}</div>
              <div className="h">{t("settings.customFontFamilyHint")}</div>
            </div>
            <input
              className="field font-family-field"
              value={customFontDraft}
              placeholder={`"Microsoft YaHei", "PingFang SC", sans-serif`}
              onChange={(e) => {
                setCustomFontDraft(e.target.value);
                onSetCustomFontFamily(e.target.value);
              }}
              onBlur={(e) => commitCustomFont(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}
      </section>

      <section className="section">
        <div className="stitle">{t("settings.behaviorSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.webSearchEngine")}</div>
            <div className="h">{t("settings.webSearchEngineNote")}</div>
          </div>
          <select
            className="field"
            value={settings.webSearchEngine ?? "bing"}
            onChange={(e) =>
              onSave({
                webSearchEngine: e.target.value as
                  | "bing"
                  | "bing-intl"
                  | "searxng"
                  | "metaso"
                  | "baidu"
                  | "tavily"
                  | "perplexity"
                  | "exa"
                  | "brave"
                  | "ollama"
                  | "zai",
              })
            }
          >
            <option value="bing">{t("settings.webSearchEngineBing")}</option>
            <option value="bing-intl">{t("settings.webSearchEngineBingIntl")}</option>
            <option value="searxng">{t("settings.webSearchEngineSearxng")}</option>
            <option value="metaso">{t("settings.webSearchEngineMetaso")}</option>
            <option value="baidu">{t("settings.webSearchEngineBaidu")}</option>
            <option value="tavily">{t("settings.webSearchEngineTavily")}</option>
            <option value="perplexity">{t("settings.webSearchEnginePerplexity")}</option>
            <option value="exa">{t("settings.webSearchEngineExa")}</option>
            <option value="brave">{t("settings.webSearchEngineBrave")}</option>
            <option value="ollama" disabled={!settings.webSearchApiKeys?.ollama}>
              {t("settings.webSearchEngineOllama")}
            </option>
            <option value="zai" disabled={!settings.webSearchApiKeys?.zai}>
              {t("settings.webSearchEngineZai")}
            </option>
          </select>
        </div>
        <WebSearchEngineCredentials settings={settings} onSave={onSave} />
      </section>

      <section className="section">
        <div className="stitle">{t("settings.quickSendSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.quickSend")}</div>
            <div className="h">{t("settings.quickSendHint")}</div>
          </div>
          <div className="seg-ctrl">
            {allQuickSends(settings.quickSends ?? []).map((q) => (
              <button
                type="button"
                key={q.id}
                data-on={settings.quickSendId === q.id}
                onClick={() => onSave({ quickSendId: q.id })}
              >
                {q.shorthand}
              </button>
            ))}
          </div>
        </div>

        {(settings.quickSends ?? []).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {(settings.quickSends ?? []).map((q) => (
              <div className="rule" key={q.id}>
                <div className="top">
                  <span className="pat">{q.shorthand}</span>
                  <button
                    type="button"
                    className="mini-btn"
                    title={t("settings.quickSendRemove")}
                    aria-label={`Remove quick send: ${q.shorthand}`}
                    onClick={() =>
                      onSave({
                        quickSends: (settings.quickSends ?? []).filter((x) => x.id !== q.id),
                      })
                    }
                  >
                    <I.trash size={12} />
                  </button>
                </div>
                <div className="desc">{q.message}</div>
              </div>
            ))}
          </div>
        )}

        {(settings.quickSends ?? []).length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
            {t("settings.quickSendNoCustom")}
          </div>
        )}

        <form
          className="rule-composer"
          onSubmit={(e) => {
            e.preventDefault();
            const shorthand = enforceQuickSendShorthand(quickSendShorthand.trim());
            const message = quickSendMessage.trim();
            if (!message || !shorthand) return;
            onSave({
              quickSends: [
                ...(settings.quickSends ?? []),
                { id: `custom-${Date.now()}`, message, shorthand },
              ],
            });
            setQuickSendShorthand("");
            setQuickSendMessage("");
          }}
        >
          <div className="rule-composer-row">
            <input
              type="text"
              className="rule-input"
              placeholder={t("settings.quickSendShorthandPlaceholder")}
              value={quickSendShorthand}
              maxLength={QUICK_SEND_SHORTHAND_MAX_LENGTH}
              onChange={(e) => setQuickSendShorthand(e.target.value)}
              aria-label={t("settings.quickSendShorthand")}
            />
            <input
              type="text"
              className="rule-input"
              placeholder={t("settings.quickSendMessagePlaceholder")}
              value={quickSendMessage}
              onChange={(e) => setQuickSendMessage(e.target.value)}
              aria-label={t("settings.quickSendMessage")}
            />
            <button
              type="submit"
              className="btn small"
              disabled={!quickSendShorthand.trim() || !quickSendMessage.trim()}
              title={t("settings.quickSendAdd")}
              aria-label={t("settings.quickSendAdd")}
            >
              <I.plus size={12} />
              <span style={{ marginLeft: 4 }}>{t("settings.quickSendAdd")}</span>
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

const AUDIO_TEST_DURATION_MS = 4000;

/**
 * Audio input device picker for voice input. Persists the choice in localStorage.
 *
 * Microphone access is gated behind an explicit consent button: browsers only
 * reveal real device labels once permission is granted, and we never touch media
 * hardware (enumeration surfaces connected cameras to the OS media stack in
 * WebView2) until the user opts in. After consent the real device list and a live
 * record/playback test are shown.
 */
export function AudioInputDeviceSettings() {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selected, setSelected] = useState<string>(() => getSelectedAudioInputDeviceId());
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"consent" | "ready">("consent");
  const [granting, setGranting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listAudioInputDevices();
      setDevices(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Promote to "ready" on mount only when permission was already granted. The
  // Permissions API touches no media hardware, so this is safe before a gesture;
  // the enumeration itself is deferred to the ready-phase effect below.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (await hasMicrophonePermission()) {
        if (!cancelled) setPhase("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Enumerate only once permission is granted (never on mount before consent,
  // which in WebView2 surfaces video/webcam devices to the OS media stack and is
  // flagged by Windows privacy tools). Re-enumerate on hotplug while ready.
  useEffect(() => {
    if (phase !== "ready") return;
    void refresh();
    if (typeof navigator !== "undefined" && navigator?.mediaDevices?.addEventListener) {
      const onChange = () => void refresh();
      navigator.mediaDevices.addEventListener("devicechange", onChange);
      return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
    }
  }, [phase, refresh]);

  // Reconcile the stored selection once the live list arrives: device ids can
  // change across settings reopen in WebView2, so re-match by label and
  // re-persist the resolved id, or fall back to default when the device is gone.
  useEffect(() => {
    if (phase !== "ready" || devices.length === 0) return;
    const resolved = resolveSelectedDeviceId(devices);
    setSelected(resolved);
    setSelectedAudioInputDeviceId(resolved, devices.find((d) => d.deviceId === resolved)?.label);
  }, [devices, phase]);

  const handleAllow = async () => {
    setGranting(true);
    setError(null);
    try {
      await requestMicrophoneAccess();
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGranting(false);
    }
  };

  const handleChange = (deviceId: string) => {
    setSelected(deviceId);
    setSelectedAudioInputDeviceId(deviceId, devices.find((d) => d.deviceId === deviceId)?.label);
  };

  return (
    <ProviderCard title={t("settings.voiceInputDevice")} settings={<div className="voice-device-settings">
      <div className="voice-section-hint">{t("settings.voiceInputDeviceHint")}</div>

      {error && (
        <div className="voice-error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}

      {phase === "consent" ? (
        <div className="voice-consent">
          <button type="button" className="btn" onClick={handleAllow} disabled={granting}>
            <I.mic size={13} />
            <span>{t("settings.voiceInputDeviceAllow")}</span>
          </button>
          <div className="voice-section-hint">{t("settings.voiceInputDeviceAllowHint")}</div>
        </div>
      ) : (
        <>
          <select
            className="voice-device-select"
            value={selected}
            onChange={(e) => handleChange(e.target.value)}
            aria-label={t("settings.voiceInputDevice")}
          >
            <option value="">{t("settings.voiceInputDeviceDefault")}</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <AudioInputDeviceTest deviceId={selected} />
        </>
      )}
    </div>}
    />
  );
}

/**
 * Records a few seconds from the chosen microphone and plays it back, with a
 * live input-level meter, so the user can confirm the device actually captures
 * audio before relying on it for voice input.
 */
export function AudioInputDeviceTest({ deviceId }: { deviceId: string }) {
  const [state, setState] = useState<"idle" | "recording" | "playing">("idle");
  const [level, setLevel] = useState(0);
  const [hasRecording, setHasRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<AudioRecorder | null>(null);
  const audioRef = useRef<Float32Array | null>(null);
  const playbackRef = useRef<{ ctx: AudioContext; source: AudioBufferSourceNode } | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPlayback = useCallback(() => {
    const playback = playbackRef.current;
    playbackRef.current = null;
    if (!playback) return;
    try {
      playback.source.stop();
    } catch {
      // Already ended.
    }
    void playback.ctx.close().catch(() => {});
  }, []);

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current !== null) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const playBack = useCallback(
    (audioData: Float32Array) => {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass || audioData.length === 0) {
        setState("idle");
        return;
      }
      stopPlayback();
      const ctx = new AudioContextClass();
      const buffer = ctx.createBuffer(1, audioData.length, 16000);
      buffer.getChannelData(0).set(audioData);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (playbackRef.current?.source === source) {
          playbackRef.current = null;
          void ctx.close().catch(() => {});
          setState("idle");
        }
      };
      playbackRef.current = { ctx, source };
      setState("playing");
      source.start();
    },
    [stopPlayback],
  );

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    clearStopTimer();
    recorderRef.current = null;
    setLevel(0);
    try {
      const { audioData } = await recorder.stop();
      audioRef.current = audioData;
      setHasRecording(audioData.length > 0);
      playBack(audioData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("idle");
    }
  }, [clearStopTimer, playBack]);

  const startTest = useCallback(async () => {
    setError(null);
    stopPlayback();
    const recorder = new AudioRecorder({
      deviceId,
      onVolumeChange: setLevel,
      onError: (err) => setError(err.message),
    });
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setState("recording");
      stopTimerRef.current = setTimeout(() => void stopRecording(), AUDIO_TEST_DURATION_MS);
    } catch (err) {
      recorder.cancel();
      recorderRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      setState("idle");
    }
  }, [deviceId, stopPlayback, stopRecording]);

  const replay = () => {
    const audioData = audioRef.current;
    if (audioData) playBack(audioData);
  };

  const stopPlaybackToIdle = () => {
    stopPlayback();
    setState("idle");
  };

  // Tear down any in-flight recording/playback when the test unmounts.
  useEffect(() => {
    return () => {
      clearStopTimer();
      recorderRef.current?.cancel();
      recorderRef.current = null;
      stopPlayback();
    };
  }, [clearStopTimer, stopPlayback]);

  const recording = state === "recording";
  const playing = state === "playing";

  return (
    <div className="voice-device-test">
      <div className="voice-device-test-hint">{t("settings.voiceInputDeviceTestHint")}</div>
      <div className="voice-device-test-controls">
        {recording ? (
          <button type="button" className="btn" onClick={() => void stopRecording()}>
            <I.stop size={12} />
            <span>{t("settings.voiceInputDeviceTestStop")}</span>
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => void startTest()}>
            <I.mic size={12} />
            <span>{t("settings.voiceInputDeviceTest")}</span>
          </button>
        )}
        {!recording && hasRecording && (
          <button
            type="button"
            className="btn btn-subtle"
            onClick={playing ? stopPlaybackToIdle : replay}
          >
            {playing
              ? t("settings.voiceInputDeviceTestStop")
              : t("settings.voiceInputDeviceTestAgain")}
          </button>
        )}
        {(recording || playing) && (
          <span className="voice-device-test-status" role="status" aria-live="polite">
            {recording
              ? t("settings.voiceInputDeviceTestRecording")
              : t("settings.voiceInputDeviceTestPlaying")}
          </span>
        )}
      </div>

      <div className="voice-test-meter" aria-hidden="true">
        <div
          className={`voice-test-meter-fill ${recording ? "active" : ""}`}
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>

      {error && (
        <div className="voice-error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

export function VoiceModelSettings() {
  const [activeModel, setActiveModel] = useState<VoiceModelId>(() => getActiveVoiceModelId());
  const [downloadedMap, setDownloadedMap] = useState<Record<string, boolean>>({});
  const [downloadingModel, setDownloadingModel] = useState<VoiceModelId | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadFile, setDownloadFile] = useState<string>("");
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const refreshDownloaded = useCallback(async () => {
    const nextMap: Record<string, boolean> = {};
    for (const m of VOICE_MODELS) {
      nextMap[m.id] = await isVoiceModelDownloaded(m.id);
    }
    setDownloadedMap(nextMap);
  }, []);

  useEffect(() => {
    refreshDownloaded();
  }, [refreshDownloaded]);

  const handleSelect = (id: VoiceModelId) => {
    speechTranscriber.setModel(id);
    setActiveModel(id);
  };

  const handleDownload = async (id: VoiceModelId) => {
    setDownloadingModel(id);
    setDownloadProgress(0);
    setDownloadFile("");
    setDownloadError(null);

    try {
      await speechTranscriber.downloadModel(id, (p) => {
        if (p.file) {
          const shortFileName = p.file.split("/").pop() || p.file;
          setDownloadFile(shortFileName);
        }
        if (typeof p.progress === "number") {
          setDownloadProgress(Math.round(p.progress));
        }
      });
      await refreshDownloaded();
      handleSelect(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadError(message);
    } finally {
      setDownloadingModel(null);
      setDownloadProgress(0);
      setDownloadFile("");
    }
  };

  const handleDelete = async (id: VoiceModelId) => {
    try {
      await deleteVoiceModelCache(id);
      await refreshDownloaded();
      setActiveModel(getActiveVoiceModelId());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDownloadError(message);
    }
  };

  return (
    <ProviderCard
      title={t("settings.voiceSection")}
      models={
        <div className="provider-models-scroll">
          <div className="voice-card-grid">
        {VOICE_MODELS.map((model) => {
          const isActive = activeModel === model.id;
          const isDownloaded = Boolean(downloadedMap[model.id]);
          const isDownloading = downloadingModel === model.id;

          return (
            <div
              key={model.id}
              className={`voice-card ${isActive ? "active" : ""}`}
              data-active={isActive}
            >
              <div className="voice-card-header">
                <div className="voice-card-title">{model.name}</div>
                <span className="voice-badge">{model.badge ?? "Balanced"}</span>
              </div>

              <div className="voice-card-meta">
                {model.parameters && (
                  <>
                    <span>{model.parameters} params</span>
                    <span>•</span>
                  </>
                )}
                <span>{model.size}</span>
                {model.engine === "cactus" && (
                  <>
                    <span>•</span>
                    <span>Cactus engine</span>
                  </>
                )}
              </div>

              <div className="voice-card-desc">{model.description}</div>

              {isDownloading && (
                <div className="voice-download-box">
                  <div className="voice-progress-meta">
                    <span className="voice-file-name">
                      {downloadFile || t("settings.voiceDownloading")}
                    </span>
                    <span className="voice-pct">{downloadProgress}%</span>
                  </div>
                  <div className="voice-progress-track">
                    <div className="voice-progress-bar" style={{ width: `${downloadProgress}%` }} />
                  </div>
                </div>
              )}

              <div className="voice-card-actions">
                {isDownloading ? (
                  <button type="button" className="btn" disabled>
                    {t("settings.voiceDownloading")}
                  </button>
                ) : isDownloaded ? (
                  <>
                    {isActive ? (
                      <span className="voice-active-label">✓ {t("settings.voiceActive")}</span>
                    ) : (
                      <button type="button" className="btn" onClick={() => handleSelect(model.id)}>
                        {t("settings.voiceSelect")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-subtle"
                      title="Delete downloaded files to free space"
                      onClick={() => handleDelete(model.id)}
                    >
                      {t("settings.voiceDelete")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-download"
                    disabled={downloadingModel !== null}
                    onClick={() => handleDownload(model.id)}
                  >
                    {t("settings.voiceDownload")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
          </div>
        </div>
      }
      settings={
        <div className="voice-settings">
          <div className="voice-section-hint">{t("settings.voiceSectionHint")}</div>
          {downloadError && (
            <div className="voice-error-banner" role="alert">
              <span>{downloadError}</span>
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => setDownloadError(null)}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      }
    />
  );
}

/** Search engines that are also model providers (mixed): their API key is owned
 *  by the Models tab and reused here, so General shows its status but no second
 *  input. Maps each to the i18n key naming its provider card on the Models tab;
 *  every other picker entry is search-only. */
const MIXED_SEARCH_ENGINE_PROVIDER = {
  ollama: "settings.ollamaSection",
  zai: "composer.modelZaiGroup",
} as const satisfies Record<string, TKey>;
type MixedSearchEngine = keyof typeof MIXED_SEARCH_ENGINE_PROVIDER;
const isMixedSearchEngine = (engine: string): engine is MixedSearchEngine =>
  engine in MIXED_SEARCH_ENGINE_PROVIDER;

const SEARCH_ENGINE_API_KEY_FIELDS: ReadonlyArray<{
  engine: "metaso" | "baidu" | "tavily" | "perplexity" | "exa" | "brave";
  patchKey:
    | "metasoApiKey"
    | "baiduApiKey"
    | "tavilyApiKey"
    | "perplexityApiKey"
    | "exaApiKey"
    | "braveApiKey";
  signupUrl: string;
}> = [
  { engine: "metaso", patchKey: "metasoApiKey", signupUrl: "https://metaso.cn/settings/api" },
  {
    engine: "baidu",
    patchKey: "baiduApiKey",
    signupUrl: "https://console.bce.baidu.com/qianfan/ais/console/onlineService",
  },
  { engine: "tavily", patchKey: "tavilyApiKey", signupUrl: "https://app.tavily.com" },
  {
    engine: "perplexity",
    patchKey: "perplexityApiKey",
    signupUrl: "https://www.perplexity.ai/settings/api",
  },
  { engine: "exa", patchKey: "exaApiKey", signupUrl: "https://dashboard.exa.ai/api-keys" },
  { engine: "brave", patchKey: "braveApiKey", signupUrl: "https://brave.com/search/api/" },
];

function WebSearchEngineCredentials({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const engine = settings.webSearchEngine ?? "bing";
  if (engine === "bing") return null;
  if (engine === "searxng") {
    return <SearxngEndpointRow settings={settings} onSave={onSave} />;
  }
  // Mixed search + model providers: the Models tab owns the key, so reuse it —
  // show its status here but no duplicate input.
  if (isMixedSearchEngine(engine)) {
    const prefix = settings.webSearchApiKeys?.[engine];
    const provider = t(MIXED_SEARCH_ENGINE_PROVIDER[engine]);
    return (
      <div className="setting-row">
        <div className="l">
          <div className="n">{t(`settings.webSearchApiKey.${engine}` as const)}</div>
          <div className="h">
            {keyStatusText(prefix)} {t("settings.webSearchApiKeyModelsHint", { provider })}
          </div>
        </div>
      </div>
    );
  }
  const field = SEARCH_ENGINE_API_KEY_FIELDS.find((f) => f.engine === engine);
  if (!field) return null;
  const prefix = settings.webSearchApiKeys?.[field.engine];
  return (
    <ProviderApiKeyRow
      engine={field.engine}
      patchKey={field.patchKey}
      signupUrl={field.signupUrl}
      prefix={prefix}
      onSave={onSave}
    />
  );
}

function SearxngEndpointRow({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState(settings.webSearchEndpoint ?? "");
  useEffect(() => {
    setDraft(settings.webSearchEndpoint ?? "");
  }, [settings.webSearchEndpoint]);
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{t("settings.webSearchEndpoint")}</div>
        <div className="h">{t("settings.webSearchEndpointHint")}</div>
      </div>
      <input
        className="field mono"
        value={draft}
        placeholder="http://localhost:8080"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next === (settings.webSearchEndpoint ?? "")) return;
          onSave({ webSearchEndpoint: next || null });
        }}
      />
    </div>
  );
}

export function ProviderApiKeyRow({
  engine,
  patchKey,
  signupUrl,
  prefix,
  onSave,
}: {
  engine:
    | "metaso"
    | "baidu"
    | "tavily"
    | "perplexity"
    | "exa"
    | "brave"
    | "ollama"
    | "zai"
    | "opencode"
    | "typesafe";
  patchKey:
    | "metasoApiKey"
    | "baiduApiKey"
    | "tavilyApiKey"
    | "perplexityApiKey"
    | "exaApiKey"
    | "braveApiKey"
    | "ollamaApiKey"
    | "zaiApiKey"
    | "opencodeApiKey"
    | "typesafeApiKey";
  signupUrl: string;
  prefix?: string;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState("");
  const label = t(`settings.webSearchApiKey.${engine}` as const);
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">
          {keyStatusText(prefix)}{" "}
          <a
            href={signupUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void openUrl(signupUrl).catch(() => undefined);
            }}
          >
            {t("settings.webSearchApiKeySignup")}
          </a>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="field mono"
          type="password"
          value={draft}
          placeholder={prefix ?? ""}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!draft.trim()}
          onClick={() => {
            const trimmed = draft.trim();
            if (!trimmed) return;
            onSave({ [patchKey]: trimmed } as SettingsPatch);
            setDraft("");
          }}
        >
          {t("settings.apiKeySave")}
        </button>
        {prefix ? (
          <button
            type="button"
            className="btn"
            onClick={() => onSave({ [patchKey]: null } as SettingsPatch)}
          >
            {t("settings.webSearchApiKeyClear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DeepSeekSettings({
  baseUrl,
  apiKeyPrefix,
  onSave,
  onSaveApiKey,
}: {
  baseUrl?: string;
  apiKeyPrefix?: string;
  onSave: (patch: SettingsPatch) => void;
  onSaveApiKey: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  const [urlDraft, setUrlDraft] = useState(baseUrl ?? "");
  return (
    <>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.apiKey")}</div>
          <div className="h">{keyStatusText(apiKeyPrefix)}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="field mono"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
          />
          <button
            type="button"
            className="btn primary"
            disabled={!key}
            onClick={() => {
              if (!key) return;
              onSaveApiKey(key);
              setKey("");
            }}
          >
            {t("settings.apiKeySave")}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.baseUrl")}</div>
          <div className="h">{t("settings.baseUrlHint")}</div>
        </div>
        <input
          className="field mono"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={() => onSave({ baseUrl: urlDraft.trim() })}
        />
      </div>
    </>
  );
}

export function OpenAISection({
  signedIn,
  account,
  flowError,
  waiting,
  onBegin,
  onCancel,
  onSignOut,
  onSaveApiKey,
}: {
  signedIn: boolean;
  account?: string;
  /** Last OAuth flow failure — shown so a failed sign-in (e.g. upstream invalid_client) is visible instead of just "not signed in". */
  flowError?: string;
  waiting: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  onSaveApiKey: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  return (
    <>
      {signedIn ? (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.openaiSignedIn")}</div>
            <div className="h">
              {account ? t("settings.openaiAccount", { account }) : t("settings.openaiTokenSet")}
            </div>
          </div>
          <button type="button" className="btn" onClick={onSignOut} disabled={waiting}>
            {t("settings.openaiSignOut")}
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.openaiSignInTitle")}</div>
            <div className="h">
              {waiting ? t("settings.openaiWaiting") : t("settings.openaiSignInHint")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {waiting && (
              <button type="button" className="btn" onClick={onCancel}>
                {t("settings.openaiCancel")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onBegin} disabled={waiting}>
              {t("settings.openaiSignIn")}
            </button>
          </div>
        </div>
      )}
      {flowError ? (
        <div className="setting-row" style={{ borderColor: "var(--danger)" }}>
          <div className="l">
            <div className="n">{t("settings.openaiFlowFailed")}</div>
            <div className="h" style={{ color: "var(--danger)" }}>
              {flowError}
            </div>
          </div>
        </div>
      ) : null}
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.openaiApiKey")}</div>
          <div className="h">{t("settings.openaiApiKeyHint")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="field mono"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
          />
          <button
            type="button"
            className="btn primary"
            disabled={!key}
            onClick={() => {
              if (!key) return;
              onSaveApiKey(key);
              setKey("");
            }}
          >
            {t("settings.apiKeySave")}
          </button>
        </div>
      </div>
    </>
  );
}

export function AntigravitySection({
  signedIn,
  account,
  flowError,
  waiting,
  onBegin,
  onCancel,
  onSignOut,
}: {
  signedIn: boolean;
  account?: string;
  /** Last OAuth flow failure — shown so a failed sign-in is visible instead of just "not signed in". */
  flowError?: string;
  waiting: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  return (
    <>
      {signedIn ? (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.antigravitySignedIn")}</div>
            <div className="h">
              {account
                ? t("settings.antigravityAccount", { account })
                : t("settings.antigravityTokenSet")}
            </div>
          </div>
          <button type="button" className="btn" onClick={onSignOut} disabled={waiting}>
            {t("settings.antigravitySignOut")}
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.antigravitySignInTitle")}</div>
            <div className="h">
              {waiting ? t("settings.antigravityWaiting") : t("settings.antigravitySignInHint")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {waiting && (
              <button type="button" className="btn" onClick={onCancel}>
                {t("settings.antigravityCancel")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onBegin} disabled={waiting}>
              {t("settings.antigravitySignIn")}
            </button>
          </div>
        </div>
      )}
      {flowError ? (
        <div className="setting-row" style={{ borderColor: "var(--danger)" }}>
          <div className="l">
            <div className="n">{t("settings.antigravityFlowFailed")}</div>
            <div className="h" style={{ color: "var(--danger)" }}>
              {flowError}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** One collapsible card on the Models page. The header toggles a two-column
 *  body: the left `models` column (a scrollable per-provider model list) and the
 *  right `settings` column (that provider's keys, base URLs and auth). Cards
 *  without a model list (audio input) render one full-width column. */
function ProviderCard({
  title,
  defaultOpen = true,
  models,
  settings,
}: {
  title: string;
  defaultOpen?: boolean;
  models?: ReactNode;
  settings: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="provider-card">
      <button
        type="button"
        className="provider-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="provider-caret" aria-hidden="true">
          {open ? "\u25be" : "\u25b8"}
        </span>
        <span className="provider-title">{title}</span>
      </button>
      {open ? (
        <div className="provider-body" data-has-models={models ? "true" : "false"}>
          {models ? <div className="provider-col">{models}</div> : null}
          <div className="provider-col">{settings}</div>
        </div>
      ) : null}
    </section>
  );
}

/** The left column of a provider card: a scrollable list of that provider's
 *  models, each toggleable in/out of `enabledModels` via the corner button.
 *  `onSelect` (chat models only) makes a card clickable to set the default
 *  model; omit the handlers for a read-only list (e.g. the JEV model). */
function ModelList({
  models,
  enabledSet,
  currentModel,
  acceptsImages,
  onToggle,
  onSetAll,
  onSelect,
}: {
  models: readonly string[];
  enabledSet: ReadonlySet<string>;
  currentModel: string;
  acceptsImages: (id: string) => boolean;
  onToggle?: (id: string) => void;
  onSetAll?: (enabled: boolean) => void;
  onSelect?: (id: string) => void;
}) {
  const enabledCount = models.filter((id) => enabledSet.has(id)).length;
  return (
    <>
      {onToggle ? (
        <div className="provider-models-head">
          <span className="provider-models-count">
            {t("settings.modelEnabledCount", { count: enabledCount, total: models.length })}
          </span>
          <button type="button" className="mini-btn" onClick={() => onSetAll?.(true)}>
            {t("settings.modelEnableAll")}
          </button>
          <button type="button" className="mini-btn" onClick={() => onSetAll?.(false)}>
            {t("settings.modelDisableAll")}
          </button>
        </div>
      ) : null}
      <div className="provider-models-scroll">
        {models.map((id) => {
          const enabled = enabledSet.has(id);
          return (
            <div
              key={id}
              className="mcard"
              data-on={currentModel === id}
              data-disabled={onToggle ? !enabled : undefined}
              data-static={!onToggle ? "true" : undefined}
              onClick={onSelect ? () => onSelect(id) : undefined}
              onKeyDown={onSelect ? activationHandler(() => onSelect(id)) : undefined}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
            >
              <div className="nm">
                {modelDisplayName(id)}
                {acceptsImages(id) ? <span className="badge">vision</span> : null}
              </div>
              {onToggle ? (
                <button
                  type="button"
                  className="mini-btn model-visibility-btn"
                  title={enabled ? t("settings.modelDisable") : t("settings.modelEnable")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(id);
                  }}
                >
                  {enabled ? t("settings.modelDisable") : t("settings.modelEnable")}
                </button>
              ) : null}
            </div>
          );
        })}
        {models.length === 0 ? (
          <div className="provider-models-empty">{t("settings.modelListEmpty")}</div>
        ) : null}
      </div>
    </>
  );
}


/** Base-URL override row shared by the OpenCode and Ollama provider cards. */
function ProviderBaseUrlRow({
  label,
  hint,
  placeholder,
  value,
  patchKey,
  onSave,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value?: string;
  patchKey: "opencodeBaseUrl" | "ollamaBaseUrl";
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">{hint}</div>
      </div>
      <input
        className="field mono"
        defaultValue={value ?? ""}
        placeholder={placeholder}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next === (value ?? "")) return;
          onSave({ [patchKey]: next || null } as SettingsPatch);
        }}
      />
    </div>
  );
}

/** "Refresh / sync models" action row shared by the OpenCode and Ollama cards. */
function ProviderRefreshRow({
  label,
  hint,
  action,
  onRefresh,
}: {
  label: string;
  hint: ReactNode;
  action: string;
  onRefresh?: (force?: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">{hint}</div>
      </div>
      <button type="button" className="btn" onClick={() => onRefresh?.(true)}>
        {action}
      </button>
    </div>
  );
}

/** TypeSafe's only model — rendered read-only in the TypeSafe card (JEV is a
 *  tool model, not a chat model, so it is neither selectable nor toggleable). */
const JEV_MODEL_ID = "jev-latest";

function PageModels({
  settings,
  onSave,
  baseUrl,
  apiKeyPrefix,
  onSaveApiKey,
  ollamaBaseUrl,
  ollamaModels,
  ollamaModelsError,
  ollamaPlan,
  ollamaHiddenCount,
  ollamaVisionModels,
  onRefreshOllamaModels,
  opencodeModels,
  opencodeModelsError,
  opencodeVisionModels,
  onRefreshOpencodeModels,
  oauthSignedIn,
  oauthAccount,
  oauthFlowError,
  oauthWaiting,
  onOAuthBegin,
  onOAuthCancel,
  onOAuthSignOut,
  onSaveOpenAIApiKey,
  antigravitySignedIn,
  antigravityAccount,
  antigravityFlowError,
  antigravityWaiting,
  onAntigravityBegin,
  onAntigravityCancel,
  onAntigravitySignOut,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  baseUrl?: string;
  apiKeyPrefix?: string;
  onSaveApiKey: (key: string) => void;
  /** Ollama chat endpoint (OpenAI-compatible) shown in the Ollama card. */
  ollamaBaseUrl?: string;
  /** Dynamically fetched Ollama models (raw ids) — rendered in the Ollama card. */
  ollamaModels?: string[];
  /** Why the last fetch failed — shown instead of the list so the failure isn't silent. */
  ollamaModelsError?: string;
  /** The account's Ollama plan (e.g. `free`) when the cloud reported it. */
  ollamaPlan?: string;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount?: number;
  /** Prefixed vision-capable Ollama ids (`ollama/llava`) — shown as a badge. */
  ollamaVisionModels?: ReadonlySet<string>;
  /** Re-fetch the Ollama model catalog (`force` bypasses the backend's cache). */
  onRefreshOllamaModels?: (force?: boolean) => void;
  opencodeModels?: string[];
  opencodeModelsError?: string;
  opencodeVisionModels?: ReadonlySet<string>;
  onRefreshOpencodeModels?: (force?: boolean) => void;
  oauthSignedIn: boolean;
  oauthAccount?: string;
  oauthFlowError?: string;
  oauthWaiting: boolean;
  onOAuthBegin: () => void;
  onOAuthCancel: () => void;
  onOAuthSignOut: () => void;
  onSaveOpenAIApiKey: (key: string) => void;
  antigravitySignedIn: boolean;
  antigravityAccount?: string;
  antigravityFlowError?: string;
  antigravityWaiting: boolean;
  onAntigravityBegin: () => void;
  onAntigravityCancel: () => void;
  onAntigravitySignOut: () => void;
}) {
  const [draft, setDraft] = useState(settings.model);
  useEffect(() => setDraft(settings.model), [settings.model]);

  const catalog = deriveModelCatalog({
    discoveredAntigravityModels: settings.antigravityOAuth?.models,
    customModels: settings.customModels,
    opencodeModels,
    includeAntigravity: Boolean(settings.antigravityOAuth?.signedIn),
    ollamaVisionModels,
    opencodeVisionModels,
  });
  const modelsByKey = new Map<ModelCatalogGroupKey, readonly string[]>(
    catalog.groups.map((group) => [group.key, group.models] as const),
  );
  const groupModels = (key: ModelCatalogGroupKey): readonly string[] => modelsByKey.get(key) ?? [];
  const ollamaList = (ollamaModels ?? []).map((id) => `ollama/${id}`);
  const isKnown = catalog.knownModelIds.has(settings.model);
  const enabledSet = new Set(settings.enabledModels ?? []);

  const toggleEnabled = (id: string): void => {
    const next = new Set(settings.enabledModels ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSave({ enabledModels: [...next] });
  };
  const setProviderEnabled = (ids: readonly string[], enabled: boolean): void => {
    const next = new Set(settings.enabledModels ?? []);
    for (const id of ids) {
      if (enabled) next.add(id);
      else next.delete(id);
    }
    onSave({ enabledModels: [...next] });
  };
  const modelColumn = (ids: readonly string[], selectable = true) => (
    <ModelList
      models={ids}
      enabledSet={enabledSet}
      currentModel={settings.model}
      acceptsImages={catalog.acceptsImages}
      onToggle={toggleEnabled}
      onSetAll={(enabled) => setProviderEnabled(ids, enabled)}
      onSelect={selectable ? (id) => onSave({ model: id }) : undefined}
    />
  );

  return (
    <>
      <div className="provider-default-line">
        <div className="h">{t("settings.defaultModelCurrent", { model: settings.model })}</div>
        <div className="h">{t("settings.modelVisibilityHint")}</div>
      </div>

      <ProviderCard
        title={t(MODEL_CATALOG_GROUP_LABELS.deepseek)}
        defaultOpen={false}
        models={modelColumn(groupModels("deepseek"))}
        settings={
          <DeepSeekSettings
            baseUrl={baseUrl}
            apiKeyPrefix={apiKeyPrefix}
            onSave={onSave}
            onSaveApiKey={onSaveApiKey}
          />
        }
      />

      <ProviderCard
        title={t("settings.openaiSection")}
        defaultOpen={false}
        models={modelColumn(groupModels("openai"))}
        settings={
          <OpenAISection
            signedIn={oauthSignedIn}
            account={oauthAccount}
            flowError={oauthFlowError}
            waiting={oauthWaiting}
            onBegin={onOAuthBegin}
            onCancel={onOAuthCancel}
            onSignOut={onOAuthSignOut}
            onSaveApiKey={onSaveOpenAIApiKey}
          />
        }
      />

      <ProviderCard
        title={t(MODEL_CATALOG_GROUP_LABELS.zai)}
        defaultOpen={false}
        models={modelColumn(groupModels("zai"))}
        settings={
          <ProviderApiKeyRow
            engine="zai"
            patchKey="zaiApiKey"
            signupUrl="https://z.ai/manage-apikey/apikey-list"
            prefix={settings.webSearchApiKeys?.zai}
            onSave={onSave}
          />
        }
      />

      <ProviderCard
        title={t("settings.opencodeSection")}
        defaultOpen={false}
        models={modelColumn(groupModels("opencode"))}
        settings={
          <>
            <ProviderBaseUrlRow
              label={t("settings.opencodeBaseUrl")}
              hint={t("settings.opencodeBaseUrlHint")}
              placeholder="https://opencode.ai/zen/v1"
              value={settings.opencodeBaseUrl}
              patchKey="opencodeBaseUrl"
              onSave={onSave}
            />
            <ProviderApiKeyRow
              engine="opencode"
              patchKey="opencodeApiKey"
              signupUrl="https://opencode.ai/auth"
              prefix={settings.webSearchApiKeys?.opencode}
              onSave={onSave}
            />
            <ProviderRefreshRow
              label={t("settings.opencodeModels")}
              hint={
                opencodeModelsError
                  ? t("composer.modelOpencodeError", { error: opencodeModelsError })
                  : t("settings.opencodeModelsHint")
              }
              action={t("settings.opencodeModelsRefresh")}
              onRefresh={onRefreshOpencodeModels}
            />
          </>
        }
      />

      <ProviderCard
        title={t("settings.ollamaSection")}
        defaultOpen={false}
        models={modelColumn(ollamaList)}
        settings={
          <>
            <ProviderBaseUrlRow
              label={t("settings.ollamaBaseUrl")}
              hint={t("settings.ollamaBaseUrlHint")}
              placeholder={t("settings.ollamaBaseUrlPlaceholder")}
              value={ollamaBaseUrl}
              patchKey="ollamaBaseUrl"
              onSave={onSave}
            />
            <ProviderApiKeyRow
              engine="ollama"
              patchKey="ollamaApiKey"
              signupUrl="https://ollama.com/settings/keys"
              prefix={settings.webSearchApiKeys?.ollama}
              onSave={onSave}
            />
            <ProviderRefreshRow
              label={t("settings.ollamaModels")}
              hint={
                ollamaModelsError
                  ? t("settings.ollamaModelsError", { error: ollamaModelsError })
                  : t("settings.ollamaModelsHint")
              }
              action={t("settings.ollamaModelsRefresh")}
              onRefresh={onRefreshOllamaModels}
            />
            {ollamaHiddenCount && ollamaHiddenCount > 0 ? (
              <div className="h" style={{ marginTop: 4 }}>
                {t("settings.ollamaSubscription", {
                  count: ollamaHiddenCount,
                  plan: ollamaPlan ?? "free",
                })}
              </div>
            ) : ollamaPlan ? (
              <div className="h" style={{ marginTop: 4 }}>
                {t("settings.ollamaPlan", { plan: ollamaPlan })}
              </div>
            ) : null}
          </>
        }
      />

      <ProviderCard
        title={t("settings.antigravitySection")}
        defaultOpen={false}
        models={modelColumn(groupModels("antigravity"))}
        settings={
          <AntigravitySection
            signedIn={antigravitySignedIn}
            account={antigravityAccount}
            flowError={antigravityFlowError}
            waiting={antigravityWaiting}
            onBegin={onAntigravityBegin}
            onCancel={onAntigravityCancel}
            onSignOut={onAntigravitySignOut}
          />
        }
      />

      <ProviderCard
        title={t(MODEL_CATALOG_GROUP_LABELS.custom)}
        defaultOpen={false}
        models={modelColumn(groupModels("custom"))}
        settings={
          <>
            <div className="setting-row">
              <div className="l">
                <div className="n">{t("settings.modelCustom")}</div>
                <div className="h">{t("settings.modelCustomHint")}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="field mono"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={DEFAULT_MODEL}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={!draft.trim() || draft.trim() === settings.model}
                  onClick={() => onSave({ model: draft.trim() })}
                >
                  {t("settings.apiKeySave")}
                </button>
              </div>
            </div>
            {!isKnown ? (
              <div className="h" style={{ marginTop: 6 }}>
                {t("settings.modelCustomActive", { model: settings.model })}
              </div>
            ) : null}
          </>
        }
      />

      <ProviderCard
        title={t("settings.typesafeSection")}
        defaultOpen={false}
        models={
          <ModelList
            models={[JEV_MODEL_ID]}
            enabledSet={enabledSet}
            currentModel={settings.model}
            acceptsImages={catalog.acceptsImages}
          />
        }
        settings={
          <>
            <div className="h" style={{ marginBottom: 8 }}>
              {t("settings.typesafeHint")}
            </div>
            <ProviderApiKeyRow
              engine="typesafe"
              patchKey="typesafeApiKey"
              signupUrl="https://console.typesafe.ai"
              prefix={settings.webSearchApiKeys?.typesafe}
              onSave={onSave}
            />
          </>
        }
      />

      <AudioInputDeviceSettings />
      <VoiceModelSettings />
    </>
  );
}


/** Per-provider mail-card knobs: the phases that swap the primary action for Cancel,
 *  whether the card owns an inline Configure step (Outlook) or a credentials form
 *  gates Connect (Gmail), and the i18n keys for each action/label. */
const MAIL_UI: Record<
  MailProvider,
  {
    inProgress: readonly MailAuthPhase[];
    inlineConfigure: boolean;
    requiresCreds: boolean;
    connect: TKey;
    retry: TKey;
    signOut: TKey;
    open: TKey;
    accountUnknown: TKey;
    statusUnknown: TKey;
  }
> = {
  [MailProvider.Outlook]: {
    inProgress: ["starting", "device-code", "verifying"],
    inlineConfigure: true,
    requiresCreds: false,
    connect: "settings.outlookMailConnect",
    retry: "settings.outlookMailRetry",
    signOut: "settings.outlookMailSignOut",
    open: "settings.outlookMailOpenMicrosoft",
    accountUnknown: "settings.outlookMailAccountUnknown",
    statusUnknown: "settings.outlookMailStatusUnknown",
  },
  [MailProvider.Gmail]: {
    inProgress: ["starting", "browser", "verifying"],
    inlineConfigure: false,
    requiresCreds: true,
    connect: "settings.gmailConnect",
    retry: "settings.outlookMailRetry",
    signOut: "settings.gmailSignOut",
    open: "settings.gmailOpenGoogle",
    accountUnknown: "settings.gmailAccountUnknown",
    statusUnknown: "settings.gmailStatusUnknown",
  },
};

/** Shared action row for a mail provider: primary (Configure/Sign out/Cancel/Connect),
 *  Test, and Open sign-in. `leading` renders provider-specific buttons first (Gmail's Save). */
function MailActions({
  provider,
  mail,
  leading,
  onConfigureMail,
  onConnectMail,
  onCancelMail,
  onSignOutMail,
  onRequestMailStatus,
}: {
  provider: MailProvider;
  mail: MailAuthState | null;
  leading?: ReactNode;
  onConfigureMail: (provider: MailProvider, clientId?: string, clientSecret?: string) => void;
  onConnectMail: (provider: MailProvider) => void;
  onCancelMail: (provider: MailProvider) => void;
  onSignOutMail: (provider: MailProvider) => void;
  onRequestMailStatus: (provider: MailProvider) => void;
}): ReactNode {
  const ui = MAIL_UI[provider];
  const inProgress = mail !== null && ui.inProgress.includes(mail.phase);
  const canConnect = ui.requiresCreds
    ? Boolean(mail?.hasClientId && mail.hasClientSecret)
    : Boolean(mail?.configured);
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {leading}
      {ui.inlineConfigure && !mail?.configured ? (
        <button type="button" className="btn primary" onClick={() => onConfigureMail(provider)}>
          {t("settings.outlookMailConfigure")}
        </button>
      ) : mail?.phase === "connected" ? (
        <button type="button" className="btn" onClick={() => onSignOutMail(provider)}>
          {t(ui.signOut)}
        </button>
      ) : mail?.phase === "checking" && !ui.requiresCreds ? null : inProgress ? (
        <button type="button" className="btn" onClick={() => onCancelMail(provider)}>
          {t("settings.outlookMailCancel")}
        </button>
      ) : canConnect ? (
        <button type="button" className="btn primary" onClick={() => onConnectMail(provider)}>
          {mail?.phase === "error" ? t(ui.retry) : t(ui.connect)}
        </button>
      ) : null}
      {mail?.configured && !inProgress ? (
        <button
          type="button"
          className="btn"
          disabled={mail.phase === "checking"}
          onClick={() => onRequestMailStatus(provider)}
        >
          {mail.phase === "checking"
            ? t("settings.outlookMailTesting")
            : t("settings.outlookMailTest")}
        </button>
      ) : null}
      {mail?.verificationUrl ? (
        <button
          type="button"
          className="btn primary"
          onClick={() => void openUrl(mail.verificationUrl!).catch(() => undefined)}
        >
          {t(ui.open)}
        </button>
      ) : null}
    </div>
  );
}

/** Status line under the action row: error / connected (with account) / message. */
function MailStatusLine({
  provider,
  mail,
}: {
  provider: MailProvider;
  mail: MailAuthState | null;
}): ReactNode {
  const ui = MAIL_UI[provider];
  return (
    <div
      style={{
        marginTop: 8,
        fontSize: 11,
        color:
          mail?.phase === "error"
            ? "var(--danger)"
            : mail?.phase === "connected"
              ? "var(--accent)"
              : "var(--muted)",
      }}
    >
      {mail?.phase === "checking"
        ? t("settings.outlookMailTesting")
        : mail?.phase === "connected"
          ? t("settings.outlookMailConnected", {
              account: mail.account ?? t(ui.accountUnknown),
            })
          : mail?.message ?? t(ui.statusUnknown)}
    </div>
  );
}

export function PageMCP({
  specs,
  bridged,
  onAdd,
  onRemove,
  onToggleServer,
  onToggleTool,
  extensionStatus,
  extensionCheck,
  browserInstall,
  onRequestExtensionStatus,
  onConfigureExtension,
  onCheckExtension,
  onInstallBrowser,
  onCancelBrowserInstall,
  mailProvider,
  mailAuth,
  onSetMailProvider,
  onRequestMailStatus,
  onConfigureMail,
  onConnectMail,
  onCancelMail,
  onSignOutMail,
}: {
  specs: McpSpecInfo[];
  bridged: boolean;
  onAdd: (spec: string) => void;
  onRemove: (spec: string) => void;
  onToggleServer: (name: string, disabled: boolean) => void;
  onToggleTool: (name: string, tool: string, disabled: boolean) => void;
  extensionStatus: McpExtensionStatus | null;
  extensionCheck: McpExtensionCheck | null;
  browserInstall: PlaywrightBrowserInstall | null;
  onRequestExtensionStatus: () => void;
  onConfigureExtension: (
    mode: PlaywrightMcpConnectionMode,
    token?: string,
    cdpEndpoint?: string,
    extensionBrowser?: PlaywrightExtensionBrowser,
  ) => void;
  onCheckExtension: () => void;
  onInstallBrowser: (browser: PlaywrightManagedBrowser) => void;
  onCancelBrowserInstall: (browser: PlaywrightManagedBrowser) => void;
  mailProvider: MailProvider;
  mailAuth: MailAuthState | null;
  onSetMailProvider: (provider: MailProvider) => void;
  onRequestMailStatus: (provider: MailProvider) => void;
  onConfigureMail: (provider: MailProvider, clientId?: string, clientSecret?: string) => void;
  onConnectMail: (provider: MailProvider) => void;
  onCancelMail: (provider: MailProvider) => void;
  onSignOutMail: (provider: MailProvider) => void;
}) {
  const [draft, setDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [mode, setMode] = useState<PlaywrightMcpConnectionMode>("chrome");
  const [extensionBrowser, setExtensionBrowser] = useState<PlaywrightExtensionBrowser>("chrome");
  const [cdpEndpoint, setCdpEndpoint] = useState("");
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [gmailClientId, setGmailClientId] = useState("");
  const [gmailClientSecret, setGmailClientSecret] = useState("");
  const mail = mailAuth?.provider === mailProvider ? mailAuth : null;
  const gmailBrowserUrl =
    mailProvider === MailProvider.Gmail && mail?.phase === "browser"
      ? mail.verificationUrl
      : undefined;
  const openedGmailUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!gmailBrowserUrl || openedGmailUrl.current === gmailBrowserUrl) return;
    openedGmailUrl.current = gmailBrowserUrl;
    void openUrl(gmailBrowserUrl).catch(() => undefined);
  }, [gmailBrowserUrl]);
  useEffect(() => {
    onRequestExtensionStatus();
    onRequestMailStatus(mailProvider);
  }, [onRequestExtensionStatus, onRequestMailStatus, mailProvider]);
  useEffect(() => {
    if (!extensionStatus) return;
    setMode(extensionStatus.server.mode);
    setExtensionBrowser(extensionStatus.server.extensionBrowser ?? "chrome");
    setCdpEndpoint(extensionStatus.server.cdpEndpoint ?? "");
  }, [extensionStatus]);
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  };
  const toggleToolsExpanded = (raw: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(raw)) next.delete(raw);
      else next.add(raw);
      return next;
    });
  };
  const configuredMode = extensionStatus?.server.mode;
  const extensionMode = mode === "extension";
  const managedMode = mode !== "extension" && mode !== "cdp";
  const installRunning =
    managedMode && browserInstall?.phase === "running" && browserInstall.browser === mode;
  const playwrightSpec = specs.find((s) => s.name === "playwright");
  let connection: { text: string; color: string } | null = null;
  if (playwrightSpec) {
    if (playwrightSpec.disabled || playwrightSpec.status === "disabled") {
      connection = { text: t("settings.mcpConnDisabled"), color: "var(--muted)" };
    } else if (playwrightSpec.status === "connected") {
      connection = {
        text: t("settings.mcpConnConnected", { count: playwrightSpec.toolCount ?? 0 }),
        color: "var(--accent)",
      };
    } else if (playwrightSpec.status === "handshake") {
      connection = { text: t("settings.mcpConnHandshake"), color: "var(--muted)" };
    } else if (playwrightSpec.status === "failed") {
      connection = {
        text: t("settings.mcpConnFailed", { reason: playwrightSpec.statusReason ?? "" }),
        color: "var(--danger)",
      };
    } else {
      connection = { text: t("settings.mcpConnIdle"), color: "var(--muted)" };
    }
  }
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.mcpBrowserTitle")}</div>
        <div className="scard">
          <div className="desc" style={{ marginBottom: 10 }}>
            {t("settings.mcpBrowserDesc")}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select
              className="field"
              aria-label={t("settings.mcpModeLabel")}
              value={mode}
              onChange={(event) => setMode(event.target.value as PlaywrightMcpConnectionMode)}
            >
              <option value="chrome">{t("settings.mcpModeChrome")}</option>
              <option value="firefox">{t("settings.mcpModeFirefox")}</option>
              <option value="webkit">{t("settings.mcpModeWebkit")}</option>
              <option value="msedge">{t("settings.mcpModeEdge")}</option>
              <option value="extension">{t("settings.mcpModeExtension")}</option>
              <option value="cdp">{t("settings.mcpModeCdp")}</option>
            </select>
            {mode === "cdp" ? (
              <input
                className="field"
                aria-label={t("settings.mcpCdpEndpoint")}
                value={cdpEndpoint}
                onChange={(event) => setCdpEndpoint(event.target.value)}
                placeholder="http://localhost:9222"
                style={{ minWidth: 240 }}
              />
            ) : null}
            {mode === "extension" ? (
              <select
                className="field"
                aria-label={t("settings.mcpExtensionBrowserLabel")}
                value={extensionBrowser}
                onChange={(event) =>
                  setExtensionBrowser(event.target.value as PlaywrightExtensionBrowser)
                }
              >
                <option value="chrome">{t("settings.mcpExtensionBrowserChrome")}</option>
                <option value="msedge">{t("settings.mcpExtensionBrowserEdge")}</option>
              </select>
            ) : null}
            {extensionMode ? (
              <>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    if (!extensionStatus) return;
                    // Open in the browser picked above, not the OS default, so the
                    // extension installs into the browser the relay will attach to.
                    const program = extensionBrowser === "msedge" ? "msedge.exe" : "chrome.exe";
                    void openUrl(extensionStatus.storeUrl, program).catch(() => undefined);
                  }}
                >
                  {t("settings.mcpOpenExtensionStore")}
                </button>
                <input
                  className="field"
                  type="password"
                  value={tokenDraft}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  placeholder={
                    extensionStatus?.server.tokenPrefix ?? t("settings.mcpTokenPlaceholder")
                  }
                  style={{ maxWidth: 240 }}
                />
              </>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => {
                onConfigureExtension(
                  mode,
                  extensionMode ? tokenDraft.trim() || undefined : undefined,
                  mode === "cdp" ? cdpEndpoint.trim() : undefined,
                  mode === "extension" ? extensionBrowser : undefined,
                );
                setTokenDraft("");
              }}
            >
              {configuredMode === mode ? t("settings.mcpReconfigure") : t("settings.mcpConfigure")}
            </button>
            {extensionMode ? (
              <button type="button" className="btn" onClick={onCheckExtension}>
                {t("settings.mcpTestConn")}
              </button>
            ) : null}
            {managedMode ? (
              installRunning ? (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => onCancelBrowserInstall(mode)}
                >
                  {t("settings.mcpBrowserInstallCancel")}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => onInstallBrowser(mode)}
                >
                  {t("settings.mcpBrowserInstall", { browser: mode })}
                </button>
              )
            ) : null}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
            {extensionStatus
              ? extensionStatus.server.configured
                ? `✓ ${t("settings.mcpConfiguredMode", { mode: configuredMode ?? "chrome" })}${
                    extensionMode && extensionStatus.server.tokenPrefix
                      ? ` · ${t("settings.mcpTokenSaved")}`
                      : ""
                  }`
                : t("settings.mcpConfiguredNo")
              : "…"}
          </div>
          {connection ? (
            <div style={{ marginTop: 4, fontSize: 11, color: connection.color }}>
              {connection.text}
              {playwrightSpec?.status === "failed" &&
              /Node\.js is outdated/i.test(playwrightSpec.statusReason ?? "") ? (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => void openUrl("https://nodejs.org").catch(() => undefined)}
                  >
                    {t("settings.mcpOutdatedNodeUpdateBtn")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {installRunning ? (
            <div className="playwright-download-box">
              <output style={{ marginBottom: 4, fontSize: 11, color: "var(--muted)" }}>
                {browserInstall.source === "backup"
                  ? t("settings.mcpBrowserDownloadBackup")
                  : t("settings.mcpBrowserDownloadOfficial")}
              </output>
              <div className="playwright-download-meta">
                <span>
                  {browserInstall.downloadedBytes !== undefined &&
                  browserInstall.totalBytes !== undefined
                    ? t("settings.mcpBrowserDownloadProgress", {
                        downloaded: formatBytes(browserInstall.downloadedBytes),
                        total: formatBytes(browserInstall.totalBytes),
                        percent: browserInstall.percent ?? 0,
                      })
                    : t("settings.mcpBrowserDownloadStarting")}
                </span>
                {browserInstall.bytesPerSecond !== undefined ? (
                  <span>
                    {t("settings.mcpBrowserDownloadSpeed", {
                      speed: formatBytes(browserInstall.bytesPerSecond),
                    })}
                  </span>
                ) : null}
              </div>
              <div
                className="playwright-download-track"
                role="progressbar"
                aria-label={t("settings.mcpBrowserDownloadAria")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={browserInstall.percent}
                tabIndex={0}
              >
                <div
                  className={`playwright-download-bar${
                    browserInstall.percent === undefined ? " indeterminate" : ""
                  }`}
                  style={
                    browserInstall.percent === undefined
                      ? undefined
                      : { width: `${browserInstall.percent}%` }
                  }
                />
              </div>
            </div>
          ) : null}
          {managedMode && browserInstall?.phase === "done" && browserInstall.browser === mode ? (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: browserInstall.ok ? "var(--accent)" : "var(--danger)",
              }}
            >
              {browserInstall.ok
                ? t("settings.mcpBrowserInstallOk", { browser: mode })
                : `✗ ${browserInstall.reason ?? t("settings.mcpBrowserInstallFailed")}`}
            </div>
          ) : null}
          {extensionMode && extensionCheck?.phase === "running" ? (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
              {t("settings.mcpTestRunning")}
            </div>
          ) : extensionCheck?.phase === "done" ? (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: extensionCheck.ok ? "var(--accent)" : "var(--danger)",
              }}
            >
              {extensionCheck.ok
                ? t("settings.mcpTestOk", { ms: extensionCheck.elapsedMs })
                : `✗ ${extensionCheck.reason ?? t("settings.mcpTestFailed")}`}
            </div>
          ) : null}
          <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
            {t(
              extensionMode
                ? "settings.mcpTokenHint"
                : mode === "cdp"
                  ? "settings.mcpCdpHint"
                  : "settings.mcpManagedHint",
            )}
          </div>
        </div>
      </section>
      <section className="section">
        <div className="stitle">{t("settings.mailTitle")}</div>
        <div className="scard">
          <div className="desc" style={{ marginBottom: 10 }}>
            {t("settings.mailDesc")}
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button
              type="button"
              className={mailProvider === MailProvider.Outlook ? "btn primary" : "btn"}
              onClick={() => onSetMailProvider(MailProvider.Outlook)}
            >
              {t("settings.mailProviderOutlook")}
            </button>
            <button
              type="button"
              className={mailProvider === MailProvider.Gmail ? "btn primary" : "btn"}
              onClick={() => onSetMailProvider(MailProvider.Gmail)}
            >
              {t("settings.mailProviderGmail")}
            </button>
          </div>
          {mailProvider === MailProvider.Gmail ? (
            <div>
              <div className="desc" style={{ marginBottom: 10 }}>
                {t("settings.gmailMailDesc")}
              </div>
              <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: "var(--muted)" }}>
                  {t("settings.gmailClientIdLabel")}
                  <input
                    type="text"
                    className="field mono"
                    style={{ marginTop: 4 }}
                    value={gmailClientId}
                    placeholder={mail?.hasClientId ? t("settings.gmailSaved") : "…apps.googleusercontent.com"}
                    onChange={(event) => setGmailClientId(event.target.value)}
                  />
                </label>
                <label style={{ fontSize: 11, color: "var(--muted)" }}>
                  {t("settings.gmailClientSecretLabel")}
                  <input
                    type="password"
                    className="field mono"
                    style={{ marginTop: 4 }}
                    value={gmailClientSecret}
                    placeholder={mail?.hasClientSecret ? t("settings.gmailSaved") : ""}
                    onChange={(event) => setGmailClientSecret(event.target.value)}
                  />
                </label>
              </div>
              <MailActions
                provider={MailProvider.Gmail}
                mail={mail}
                onConfigureMail={onConfigureMail}
                onConnectMail={onConnectMail}
                onCancelMail={onCancelMail}
                onSignOutMail={onSignOutMail}
                onRequestMailStatus={onRequestMailStatus}
                leading={
                  <button
                    type="button"
                    className="btn"
                    disabled={!gmailClientId.trim() || !gmailClientSecret.trim()}
                    onClick={() => {
                      onConfigureMail(MailProvider.Gmail, gmailClientId, gmailClientSecret);
                      setGmailClientSecret("");
                    }}
                  >
                    {t("settings.gmailSave")}
                  </button>
                }
              />
              <MailStatusLine provider={MailProvider.Gmail} mail={mail} />
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
                {t("settings.gmailCallbackHint", { url: mail?.callbackUrl ?? "" })}
              </div>
            </div>
          ) : (
            <div>
              <MailActions
                provider={MailProvider.Outlook}
                mail={mail}
                onConfigureMail={onConfigureMail}
                onConnectMail={onConnectMail}
                onCancelMail={onCancelMail}
                onSignOutMail={onSignOutMail}
                onRequestMailStatus={onRequestMailStatus}
              />
              {mail?.userCode ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
                    {t("settings.outlookMailCodeLabel")}
                  </div>
                  <code style={{ fontSize: 18, userSelect: "all" }}>{mail.userCode}</code>
                </div>
              ) : null}
              <MailStatusLine provider={MailProvider.Outlook} mail={mail} />
              <div style={{ marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
                {t("settings.outlookMailPrivacy")}
              </div>
            </div>
          )}
        </div>
      </section>
      <section className="section">
        <div className="stitle">
          {t("settings.mcpConfigured", { count: specs.length })}
          {bridged ? (
            <span style={{ color: "var(--accent)", marginLeft: 8, fontSize: 11 }}>
              {t("settings.mcpBridged")}
            </span>
          ) : (
            <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: 11 }}>
              {t("settings.mcpNotBridged")}
            </span>
          )}
        </div>
        {specs.length === 0 ? (
          <div
            style={{
              padding: 16,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 12,
              color: "var(--muted)",
            }}
          >
            {t("settings.mcpEmpty")}
          </div>
        ) : (
          specs.map((s) => {
            const canToggle = s.name !== null;
            const tools = s.tools ?? [];
            const isExpanded = expandedTools.has(s.raw);
            const disabledCount = s.disabledTools?.length ?? 0;
            return (
              <div className="scard" key={s.raw}>
                <div className="top">
                  <span className="ico">
                    <I.wrench size={14} />
                  </span>
                  <div className="mcp-spec-body">
                    <div className="nm">
                      {s.name ?? "(anonymous)"}
                      {s.builtin ? (
                        <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 11 }}>
                          · {t("settings.mcpBuiltinBadge")}
                        </span>
                      ) : null}
                      {s.disabled ? (
                        <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 11 }}>
                          · {t("settings.mcpDisabledBadge")}
                        </span>
                      ) : disabledCount > 0 ? (
                        <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 11 }}>
                          · {t("settings.mcpToolsDisabledNote", { count: disabledCount })}
                        </span>
                      ) : null}
                    </div>
                    <div className="sub mcp-spec-summary" title={s.summary}>
                      {s.summary}
                    </div>
                  </div>
                  {canToggle ? (
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ color: s.disabled ? "var(--accent)" : undefined }}
                      onClick={() => onToggleServer(s.name as string, !s.disabled)}
                    >
                      {s.disabled ? t("settings.mcpEnable") : t("settings.mcpDisable")}
                    </button>
                  ) : null}
                  {s.builtin ? null : (
                    <button
                      type="button"
                      className="btn ghost mcp-remove"
                      style={{ color: "var(--danger)" }}
                      onClick={() => onRemove(s.raw)}
                    >
                      {t("settings.mcpRemove")}
                    </button>
                  )}
                </div>
                {s.parseError ? (
                  <div className="desc" style={{ color: "var(--danger)" }}>
                    {t("settings.parseError", { error: s.parseError })}
                  </div>
                ) : null}
                {canToggle && tools.length > 0 ? (
                  <div
                    style={{
                      marginTop: 8,
                      borderTop: "1px solid var(--border)",
                      paddingTop: 8,
                    }}
                  >
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ fontSize: 11 }}
                      onClick={() => toggleToolsExpanded(s.raw)}
                    >
                      {isExpanded ? "▾" : "▸"} {t("settings.mcpToolsLabel", { count: tools.length })}
                    </button>
                    {isExpanded ? (
                      <div
                        style={{
                          marginTop: 6,
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        {tools.map((tool) => {
                          const off = s.disabledTools?.includes(tool) ?? false;
                          return (
                            <div
                              key={tool}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "3px 8px",
                                borderRadius: 6,
                                background: off ? "var(--card)" : undefined,
                              }}
                            >
                              <span
                                className="mono"
                                style={{
                                  fontSize: 11,
                                  color: off ? "var(--muted)" : undefined,
                                  textDecoration: off ? "line-through" : undefined,
                                }}
                              >
                                {tool}
                              </span>
                              <button
                                type="button"
                                className="btn ghost"
                                style={{ fontSize: 11, color: off ? "var(--accent)" : undefined }}
                                onClick={() => onToggleTool(s.name as string, tool, !off)}
                              >
                                {off ? t("settings.mcpEnable") : t("settings.mcpDisable")}
                              </button>
                            </div>
                          );
                        })}
                        <div style={{ fontSize: 10, color: "var(--muted)", padding: "2px 8px" }}>
                          {t("settings.mcpToolToggleHint")}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </section>
      <section className="section">
        <div className="stitle">{t("settings.mcpAddSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.mcpSpecLabel")}</div>
            <div className="h">{hintNodes(t("settings.mcpSpecFormat"))}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="github=npx -y @smithery/cli ..."
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={submit}>
              {t("settings.mcpAdd")}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

function PageMemory({
  entries,
  detail,
  result,
  onRead,
  onWrite,
  onDelete,
  onExport,
  onImport,
  onDismissResult,
}: {
  entries: MemoryEntryInfo[];
  detail: MemoryDetail | null;
  result: { ok: boolean; message: string } | null;
  onRead: (path: string) => void;
  onWrite: (scope: "global" | "project", name: string, description: string, body: string) => void;
  onDelete: (path: string) => void;
  onExport: () => void;
  onImport: (json: string) => void;
  onDismissResult: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [body, setBody] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = (): void => {
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) return;
    onWrite(scope, trimmedName, trimmedBody.slice(0, 150), trimmedBody);
    setName("");
    setBody("");
    setComposing(false);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onImport(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <section className="section">
      <div className="stitle">
        {t("settings.memorySection")}
        <span className="mem-actions">
          <button type="button" className="btn small" onClick={onExport}>
            ⇪ {t("contextPanel.saveLabel")}
          </button>
          <button type="button" className="btn small" onClick={() => fileRef.current?.click()}>
            ⇓ {t("contextPanel.loadLabel")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={onFile}
          />
        </span>
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
        <div className="muted-card">{t("settings.memoryDesc")}</div>
      ) : (
        <div className="memory-browser">
          <div className="memory-list">
            {entries.map((m) => (
              <div
                className="memory-item"
                data-active={detail?.path === m.path}
                key={m.path}
                onClick={() => onRead(m.path)}
                onKeyDown={activationHandler(() => onRead(m.path))}
              >
                <span className="memory-kind">{m.kind.replace("_", " ")}</span>
                <span className="memory-name">{m.description || m.name}</span>
                <span className="memory-path">{m.path}</span>
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
          <pre className="memory-detail">{detail ? detail.body : t("settings.memoryDesc")}</pre>
        </div>
      )}

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
            <button type="button" className="btn small ghost" onClick={() => setComposing(false)}>
              {t("contextPanel.cancelMemory")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn small" onClick={() => setComposing(true)}>
          ＋ {t("contextPanel.newMemory")}
        </button>
      )}
    </section>
  );
}

function PageRules({
  settings,
  onAddRule,
  onRemoveRule,
}: {
  settings: SettingsType;
  onAddRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onRemoveRule?: (ruleType: "shell" | "path", pattern: string) => void;
}) {
  const [ruleType, setRuleType] = useState<"shell" | "path">("shell");
  const [pattern, setPattern] = useState("");

  const shellRules = settings.shellAllowed ?? [];
  const pathRules = settings.pathAllowed ?? [];
  const totalCustom = shellRules.length + pathRules.length;

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pattern.trim();
    if (!trimmed || !onAddRule) return;
    onAddRule(ruleType, trimmed);
    setPattern("");
  };

  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.ruleAutoApprovalSection")}</div>
        <div
          style={{
            padding: 12,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--muted)",
            marginBottom: 12,
          }}
        >
          {t("settings.ruleAutoApprovalHint")}
        </div>

        {totalCustom > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {shellRules.map((r) => (
              <div className="rule" key={`shell-${r}`}>
                <div className="top">
                  <span className="pat">{r}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="sw">{t("contextPanel.allow")}</span>
                    {onRemoveRule && (
                      <button
                        type="button"
                        className="mini-btn"
                        title={t("settings.deleteRuleTooltip")}
                        aria-label={`Remove rule: ${r}`}
                        onClick={() => onRemoveRule("shell", r)}
                      >
                        <I.trash size={12} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="desc">{t("settings.ruleTypeShell")}</div>
              </div>
            ))}
            {pathRules.map((r) => (
              <div className="rule" key={`path-${r}`}>
                <div className="top">
                  <span className="pat">{r}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="sw">{t("contextPanel.allow")}</span>
                    {onRemoveRule && (
                      <button
                        type="button"
                        className="mini-btn"
                        title={t("settings.deleteRuleTooltip")}
                        aria-label={`Remove rule: ${r}`}
                        onClick={() => onRemoveRule("path", r)}
                      >
                        <I.trash size={12} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="desc">{t("settings.ruleTypePath")}</div>
              </div>
            ))}
          </div>
        )}

        {totalCustom === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
            {t("settings.noCustomRules")}
          </div>
        )}

        {onAddRule && (
          <form className="rule-composer" onSubmit={handleAdd}>
            <div className="rule-composer-row">
              <select
                className="rule-select"
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value as "shell" | "path")}
                aria-label="Rule type"
              >
                <option value="shell">{t("settings.ruleTypeShell")}</option>
                <option value="path">{t("settings.ruleTypePath")}</option>
              </select>
              <input
                type="text"
                className="rule-input"
                placeholder={t("settings.rulePatternPlaceholder")}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                aria-label="Rule pattern"
              />
              <button
                type="submit"
                className="btn small"
                disabled={!pattern.trim()}
                title={t("settings.addRule")}
                aria-label={t("settings.addRule")}
              >
                <I.plus size={12} />
                <span style={{ marginLeft: 4 }}>{t("settings.addRule")}</span>
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}


function PageShortcuts() {
  const rows: { nm: string; keys: ShortcutKey[] }[] = [
    { nm: t("settings.shortcutNewChat"), keys: ["mod", "N"] },
    { nm: t("settings.shortcutNewTab"), keys: ["mod", "T"] },
    { nm: t("settings.shortcutCloseTab"), keys: ["mod", "W"] },
    { nm: t("settings.shortcutFocusComposer"), keys: ["mod", "L"] },
    { nm: t("settings.shortcutSwitchTab"), keys: ["mod", "tab"] },
    { nm: t("settings.shortcutAbort"), keys: ["esc"] },
    { nm: t("settings.shortcutSettings"), keys: ["mod", ","] },
  ];
  return (
    <section className="section">
      <div className="kbd-grid">
        {rows.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static shortcut rows snapshot
          <SectionRow key={i} nm={s.nm} keys={s.keys} />
        ))}
      </div>
    </section>
  );
}

function SectionRow({ nm, keys }: { nm: string; keys: ShortcutKey[] }): ReactNode {
  return (
    <>
      <div className="nm">{nm}</div>
      <div className="keys">
        <Shortcut keys={keys} />
      </div>
    </>
  );
}
