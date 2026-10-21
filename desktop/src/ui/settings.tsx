import { messageOf, modelDisplayName } from "@reasonix/core-utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Settings as SettingsType } from "../App";
import { feedbackSounds } from "../feedback-sounds";
import { formatBytes } from "../format";
import { type TKey, t } from "../i18n";
import { I } from "../icons";
import {
  MODEL_CATALOG_GROUP_LABELS,
  type ModelCatalogGroupKey,
  deriveModelCatalog,
} from "../model-catalog";
import type {
  FeedbackCueId,
  FeedbackCueSetting,
  MailAuthPhase,
  MailAuthState,
  McpExtensionCheck,
  McpExtensionStatus,
  McpSpecInfo,
  PlaywrightBrowserInstall,
  PlaywrightExtensionBrowser,
  PlaywrightManagedBrowser,
  PlaywrightMcpConnectionMode,
  SettingsPatch,
} from "../protocol";
import {
  MailProvider,
  PLAYWRIGHT_MANAGED_BROWSERS,
  QUICK_SEND_SHORTHAND_MAX_LENGTH,
  createQuickSendId,
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
import { type ChangelogState, PageChangelog } from "./changelog";
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

/** A provider-key hint: the shared status line, optionally followed by a signup
 *  link or description, so every provider key row reads the same way. */
function keyStatusHint(prefix: string | undefined, trailing?: ReactNode): ReactNode {
  return trailing ? (
    <>
      {keyStatusText(prefix)} {trailing}
    </>
  ) : (
    keyStatusText(prefix)
  );
}

/** Reorder an ordered settings list (quick sends, backup models); out-of-range
 *  moves are no-ops. Returns a new array — callers persist it through onSave. */
function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

export type PageId = "general" | "models" | "fallbacks" | "mcp" | "changelog" | "shortcuts";

const PAGE_META: ReadonlyArray<{ id: PageId; icon: keyof typeof I }> = [
  { id: "general", icon: "cog" },
  { id: "models", icon: "brain" },
  { id: "fallbacks", icon: "layers" },
  { id: "mcp", icon: "wrench" },
  { id: "changelog", icon: "history" },
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
  opencodeOAuthWaiting,
  onOpencodeOAuthBegin,
  onOpencodeOAuthCancel,
  onOpencodeOAuthSignOut,
  mimoOAuthWaiting,
  onMiMoOAuthBegin,
  onMiMoOAuthCancel,
  onMiMoOAuthSignOut,
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
  changelog,
  onRefreshChangelog,
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
  opencodeOAuthWaiting: boolean;
  onOpencodeOAuthBegin: () => void;
  onOpencodeOAuthCancel: () => void;
  onOpencodeOAuthSignOut: () => void;
  /** True between mimo_oauth_begin_result and the flow's terminal state. */
  mimoOAuthWaiting: boolean;
  onMiMoOAuthBegin: () => void;
  onMiMoOAuthCancel: () => void;
  onMiMoOAuthSignOut: () => void;
  onAddMcpSpec: (spec: string) => void;
  onRemoveMcpSpec: (spec: string) => void;
  onToggleMcpServer: (name: string, disabled: boolean) => void;
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
  /** Repo commit history grouped per release, plus a forced-refetch trigger. */
  changelog: ChangelogState;
  onRefreshChangelog: (force?: boolean) => void;
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
                opencodeSignedIn={settings.opencodeOAuth?.signedIn ?? false}
                opencodeAccount={settings.opencodeOAuth?.account}
                opencodeOrgName={settings.opencodeOAuth?.orgName}
                opencodeFlowError={settings.opencodeOAuth?.flowError}
                opencodeWaiting={opencodeOAuthWaiting}
                onOpencodeBegin={onOpencodeOAuthBegin}
                onOpencodeCancel={onOpencodeOAuthCancel}
                onOpencodeSignOut={onOpencodeOAuthSignOut}
                mimoOAuthWaiting={mimoOAuthWaiting}
                onMiMoOAuthBegin={onMiMoOAuthBegin}
                onMiMoOAuthCancel={onMiMoOAuthCancel}
                onMiMoOAuthSignOut={onMiMoOAuthSignOut}
              />
            )}
            {page === "fallbacks" && (
              <PageFallbacks
                settings={settings}
                onSave={onSave}
                ollamaModels={ollamaModels}
                opencodeModels={opencodeModels}
                ollamaVisionModels={ollamaVisionModels}
                opencodeVisionModels={opencodeVisionModels}
              />
            )}
            {page === "mcp" && (
              <PageMCP
                specs={mcpSpecs}
                bridged={mcpBridged}
                onAdd={onAddMcpSpec}
                onRemove={onRemoveMcpSpec}
                onToggleServer={onToggleMcpServer}
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
            {page === "changelog" && (
              <PageChangelog changelog={changelog} onRefresh={onRefreshChangelog} />
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
    <div className="page-general">
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
            <div className="n">{t("settings.rawTab")}</div>
            <div className="h">{t("settings.rawTabHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={settings.rawTabEnabled === true}
              onClick={() => onSave({ rawTabEnabled: true })}
            >
              {t("settings.rawTabShown")}
            </button>
            <button
              type="button"
              data-on={settings.rawTabEnabled !== true}
              onClick={() => onSave({ rawTabEnabled: false })}
            >
              {t("settings.rawTabHidden")}
            </button>
          </div>
        </div>
        <FeedbackCuesSection settings={settings} onSave={onSave} />
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
        <div className="h" style={{ marginBottom: 12 }}>
          {t("settings.quickSendHint")}
        </div>

        {(settings.quickSends ?? []).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {(settings.quickSends ?? []).map((q, i, list) => (
              <div className="rule" key={q.id}>
                <div className="top">
                  <span className="pat">{q.shorthand}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    {(
                      [
                        {
                          dir: -1,
                          kind: "up",
                          icon: <I.arrowUp size={12} />,
                          title: t("settings.quickSendMoveUp"),
                          aria: "settings.quickSendMoveUpAria",
                        },
                        {
                          dir: 1,
                          kind: "down",
                          icon: <I.arrowDown size={12} />,
                          title: t("settings.quickSendMoveDown"),
                          aria: "settings.quickSendMoveDownAria",
                        },
                      ] as const
                    ).map(({ dir, kind, icon, title, aria }) => (
                      <button
                        key={kind}
                        type="button"
                        className="mini-btn"
                        disabled={dir < 0 ? i === 0 : i === list.length - 1}
                        title={title}
                        aria-label={t(aria, { shorthand: q.shorthand })}
                        onClick={() => onSave({ quickSends: moveInList(list, i, i + dir) })}
                      >
                        {icon}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="mini-btn"
                      title={t("settings.quickSendRemove")}
                      aria-label={t("settings.quickSendRemoveAria", { shorthand: q.shorthand })}
                      onClick={() => onSave({ quickSends: list.filter((x) => x.id !== q.id) })}
                    >
                      <I.trash size={12} />
                    </button>
                  </div>
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
                { id: createQuickSendId(settings.quickSends ?? []), message, shorthand },
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

      <AudioInputDeviceSettings />
      <VoiceModelSettings />
    </div>
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
      setError(messageOf(err));
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
      setError(messageOf(err));
    } finally {
      setGranting(false);
    }
  };

  const handleChange = (deviceId: string) => {
    setSelected(deviceId);
    setSelectedAudioInputDeviceId(deviceId, devices.find((d) => d.deviceId === deviceId)?.label);
  };

  return (
    <ProviderCard
      title={t("settings.voiceInputDevice")}
      settings={
        <div className="voice-device-settings">
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
        </div>
      }
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
      setError(messageOf(err));
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
      setError(messageOf(err));
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
      const message = messageOf(err);
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
      const message = messageOf(err);
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
                        <div
                          className="voice-progress-bar"
                          style={{ width: `${downloadProgress}%` }}
                        />
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
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleSelect(model.id)}
                          >
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

function SettingsEntry({
  value,
  onChange,
  onSave,
  placeholder,
  secret = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  placeholder?: string;
  secret?: boolean;
}) {
  return (
    <div className="settings-entry">
      <input
        className="field mono"
        type={secret ? "password" : "text"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="btn primary" onClick={onSave}>
        {t("settings.apiKeySave")}
      </button>
    </div>
  );
}

function ApiKeyRow({
  label,
  hint,
  placeholder,
  prefix,
  onSave,
}: {
  label: string;
  hint?: ReactNode;
  placeholder?: string;
  /** Masked saved key: renders the shared status line and, when present, the
   *  input placeholder, so the box always reflects the stored key. */
  prefix?: string;
  onSave: (key: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="setting-row setting-row-entry">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">{keyStatusHint(prefix, hint)}</div>
      </div>
      <SettingsEntry
        secret
        value={draft}
        onChange={setDraft}
        placeholder={prefix ?? placeholder}
        onSave={() => {
          onSave(draft.trim());
          setDraft("");
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
    | "typesafe"
    | "experiential";
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
    | "typesafeApiKey"
    | "experientialApiKey";
  signupUrl: string;
  prefix?: string;
  onSave: (patch: SettingsPatch) => void;
}) {
  const label = t(`settings.webSearchApiKey.${engine}` as const);
  return (
    <ApiKeyRow
      label={label}
      prefix={prefix}
      onSave={(key) => onSave({ [patchKey]: key || null } as SettingsPatch)}
      hint={
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
      }
    />
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
  return (
    <>
      <ApiKeyRow
        label={t("settings.apiKey")}
        prefix={apiKeyPrefix}
        placeholder="sk-…"
        onSave={onSaveApiKey}
      />
      <ProviderBaseUrlRow
        label={t("settings.baseUrl")}
        hint={t("settings.baseUrlHint")}
        placeholder="https://api.deepseek.com"
        value={baseUrl}
        patchKey="baseUrl"
        onSave={onSave}
      />
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
  apiKeyPrefix,
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
  apiKeyPrefix?: string;
  onSaveApiKey: (key: string) => void;
}) {
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
      <ApiKeyRow
        label={t("settings.openaiApiKey")}
        prefix={apiKeyPrefix}
        hint={t("settings.openaiApiKeyHint")}
        placeholder="sk-…"
        onSave={onSaveApiKey}
      />
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

export function MiMoSection({
  signedIn,
  flowError,
  waiting,
  onBegin,
  onCancel,
  onSignOut,
}: {
  signedIn: boolean;
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
            <div className="n">{t("settings.mimoSignedIn")}</div>
            <div className="h">{t("settings.mimoKeyStored")}</div>
          </div>
          <button type="button" className="btn" onClick={onSignOut} disabled={waiting}>
            {t("settings.mimoSignOut")}
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.mimoSignInTitle")}</div>
            <div className="h">
              {waiting ? t("settings.mimoWaiting") : t("settings.mimoSignInHint")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {waiting && (
              <button type="button" className="btn" onClick={onCancel}>
                {t("settings.mimoCancel")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onBegin} disabled={waiting}>
              {t("settings.mimoSignIn")}
            </button>
          </div>
        </div>
      )}
      {flowError ? (
        <div className="setting-row" style={{ borderColor: "var(--danger)" }}>
          <div className="l">
            <div className="n">{t("settings.mimoFlowFailed")}</div>
            <div className="h" style={{ color: "var(--danger)" }}>
              {flowError}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function OpencodeSection({
  signedIn,
  account,
  orgName,
  flowError,
  waiting,
  onBegin,
  onCancel,
  onSignOut,
  apiKeyPrefix,
  onSave,
}: {
  signedIn: boolean;
  account?: string;
  /** Active Console organization name, when the account has one. */
  orgName?: string;
  /** Last OAuth flow failure — shown so a failed sign-in is visible instead of just "not signed in". */
  flowError?: string;
  waiting: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  apiKeyPrefix?: string;
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <>
      {signedIn ? (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.opencodeSignedIn")}</div>
            <div className="h">
              {account
                ? orgName
                  ? t("settings.opencodeAccountOrg", { account, org: orgName })
                  : t("settings.opencodeAccount", { account })
                : t("settings.opencodeTokenSet")}
            </div>
          </div>
          <button type="button" className="btn" onClick={onSignOut} disabled={waiting}>
            {t("settings.opencodeSignOut")}
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.opencodeSignInTitle")}</div>
            <div className="h">
              {waiting ? t("settings.opencodeWaiting") : t("settings.opencodeSignInHint")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {waiting && (
              <button type="button" className="btn" onClick={onCancel}>
                {t("settings.opencodeCancel")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onBegin} disabled={waiting}>
              {t("settings.opencodeSignIn")}
            </button>
          </div>
        </div>
      )}
      {flowError ? (
        <div className="setting-row" style={{ borderColor: "var(--danger)" }}>
          <div className="l">
            <div className="n">{t("settings.opencodeFlowFailed")}</div>
            <div className="h" style={{ color: "var(--danger)" }}>
              {flowError}
            </div>
          </div>
        </div>
      ) : null}
      <ProviderApiKeyRow
        engine="opencode"
        patchKey="opencodeApiKey"
        signupUrl="https://opencode.ai/auth"
        prefix={apiKeyPrefix}
        onSave={onSave}
      />
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
          <I.chevR size={14} style={{ transform: open ? "rotate(90deg)" : "none" }} />
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

/** Collapsible card for a single MCP server. Mirrors the Models page's provider
 *  card (same `.provider-card` chrome) so each server's settings sit under its
 *  own header, dropdown-style. `headActions` (Enable/Disable, Remove) renders
 *  in the header row as a sibling of the title button, so activating it never
 *  expands or collapses the card. */
function McpServerCard({
  title,
  headActions,
  defaultOpen = true,
  children,
}: {
  title: ReactNode;
  headActions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="provider-card">
      <div className="provider-head">
        <button
          type="button"
          className="provider-head-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="provider-caret" aria-hidden="true">
            <I.chevR size={14} style={{ transform: open ? "rotate(90deg)" : "none" }} />
          </span>
          <span className="provider-title">{title}</span>
        </button>
        {headActions ? <div className="provider-head-actions">{headActions}</div> : null}
      </div>
      {open ? (
        <div className="provider-body" data-has-models="false">
          <div className="provider-col">{children}</div>
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
  const [query, setQuery] = useState("");
  const enabledCount = models.filter((id) => enabledSet.has(id)).length;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? models.filter(
        (id) =>
          modelDisplayName(id).toLowerCase().includes(needle) || id.toLowerCase().includes(needle),
      )
    : models;
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
      {onToggle && models.length > 0 ? (
        <div className="provider-models-search">
          <I.search size={13} />
          <input
            type="search"
            aria-label={t("settings.modelSearchPlaceholder")}
            placeholder={t("settings.modelSearchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="provider-models-search-clear"
              aria-label={t("settings.modelSearchClear")}
              title={t("settings.modelSearchClear")}
              onClick={() => setQuery("")}
            >
              <I.x size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="provider-models-scroll">
        {shown.map((id) => {
          const enabled = enabledSet.has(id);
          const displayName = modelDisplayName(id);
          const nameFontSize = Math.max(10, Math.min(14, (14 * 18) / displayName.length));
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
                <span className="model-name" style={{ fontSize: `${nameFontSize}px` }}>
                  {displayName}
                </span>
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
        ) : shown.length === 0 ? (
          <div className="provider-models-empty">{t("settings.modelSearchEmpty")}</div>
        ) : null}
      </div>
    </>
  );
}

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
  patchKey: "baseUrl" | "opencodeBaseUrl" | "ollamaBaseUrl" | "mimoBaseUrl" | "experientialBaseUrl";
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  return (
    <div className="setting-row setting-row-entry setting-row-base-url">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">{hint}</div>
      </div>
      <SettingsEntry
        value={draft}
        onChange={setDraft}
        placeholder={placeholder}
        onSave={() => {
          const next = draft.trim();
          onSave({ [patchKey]: next || (patchKey === "baseUrl" ? "" : null) } as SettingsPatch);
        }}
      />
    </div>
  );
}

function ProviderRefreshRow({
  label,
  hint,
  onRefresh,
}: {
  label: string;
  hint: ReactNode;
  onRefresh?: (force?: boolean) => void;
}) {
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">{hint}</div>
      </div>
      <button type="button" className="btn" onClick={() => onRefresh?.(true)}>
        {t("settings.modelsRefresh")}
      </button>
    </div>
  );
}

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
  opencodeSignedIn,
  opencodeAccount,
  opencodeOrgName,
  opencodeFlowError,
  opencodeWaiting,
  onOpencodeBegin,
  onOpencodeCancel,
  onOpencodeSignOut,
  mimoOAuthWaiting,
  onMiMoOAuthBegin,
  onMiMoOAuthCancel,
  onMiMoOAuthSignOut,
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
  opencodeSignedIn: boolean;
  opencodeAccount?: string;
  opencodeOrgName?: string;
  opencodeFlowError?: string;
  opencodeWaiting: boolean;
  onOpencodeBegin: () => void;
  onOpencodeCancel: () => void;
  onOpencodeSignOut: () => void;
  /** True between mimo_oauth_begin_result and the flow's terminal state. */
  mimoOAuthWaiting: boolean;
  onMiMoOAuthBegin: () => void;
  onMiMoOAuthCancel: () => void;
  onMiMoOAuthSignOut: () => void;
}) {
  const catalog = deriveModelCatalog({
    providerCatalogs: settings.providerCatalogs,
    discoveredAntigravityModels: settings.antigravityOAuth?.models,
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
  const enabledSet = new Set(settings.enabledModels ?? []);
  // Options for the top "Default model" enum: the enabled allow-list, plus the
  // active model when it isn't enabled yet (mirrors the composer picker) so the
  // select never renders blank.
  const enabledChoices = settings.enabledModels ?? [];
  const defaultModelOptions =
    enabledChoices.length > 0 && !enabledChoices.includes(settings.model)
      ? [settings.model, ...enabledChoices]
      : enabledChoices;

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
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.defaultModel")}</div>
            <div className="h">{t("settings.defaultModelHint")}</div>
          </div>
          <select
            className="field"
            aria-label={t("settings.defaultModel")}
            disabled={enabledChoices.length === 0}
            value={enabledChoices.length === 0 ? "" : settings.model}
            onChange={(e) => onSave({ model: e.target.value, subagentModel: e.target.value })}
          >
            {enabledChoices.length === 0 ? (
              <option value="">{t("settings.defaultModelNone")}</option>
            ) : (
              defaultModelOptions.map((id) => (
                <option key={id} value={id}>
                  {modelDisplayName(id)}
                </option>
              ))
            )}
          </select>
        </div>
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
            apiKeyPrefix={settings.webSearchApiKeys?.openai}
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
        title={t(MODEL_CATALOG_GROUP_LABELS.mimo)}
        defaultOpen={false}
        models={modelColumn(groupModels("mimo"))}
        settings={
          <>
            <ApiKeyRow
              label={t("settings.mimoApiKey")}
              prefix={settings.webSearchApiKeys?.mimo}
              hint={t("settings.mimoApiKeyHint")}
              placeholder="MiMo API key"
              onSave={(key) => onSave({ mimoApiKey: key || null })}
            />
            <ProviderBaseUrlRow
              label={t("settings.mimoBaseUrl")}
              hint={t("settings.mimoBaseUrlHint")}
              placeholder="https://api.xiaomimimo.com/v1"
              value={settings.mimoBaseUrl}
              patchKey="mimoBaseUrl"
              onSave={onSave}
            />
            <MiMoSection
              signedIn={settings.mimoOAuth?.signedIn ?? false}
              flowError={settings.mimoOAuth?.flowError}
              waiting={mimoOAuthWaiting}
              onBegin={onMiMoOAuthBegin}
              onCancel={onMiMoOAuthCancel}
              onSignOut={onMiMoOAuthSignOut}
            />
          </>
        }
      />

      <ProviderCard
        title={t(MODEL_CATALOG_GROUP_LABELS.experiential)}
        defaultOpen={false}
        models={modelColumn(groupModels("experiential"))}
        settings={
          <>
            <ProviderApiKeyRow
              engine="experiential"
              patchKey="experientialApiKey"
              signupUrl="https://platform.experientiallabs.ai/settings/keys"
              prefix={settings.webSearchApiKeys?.experiential}
              onSave={onSave}
            />
            <ProviderBaseUrlRow
              label={t("settings.experientialBaseUrl")}
              hint={t("settings.experientialBaseUrlHint")}
              placeholder="https://api.experientiallabs.ai/v1"
              value={settings.experientialBaseUrl}
              patchKey="experientialBaseUrl"
              onSave={onSave}
            />
          </>
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
            <OpencodeSection
              signedIn={opencodeSignedIn}
              account={opencodeAccount}
              orgName={opencodeOrgName}
              flowError={opencodeFlowError}
              waiting={opencodeWaiting}
              onBegin={onOpencodeBegin}
              onCancel={onOpencodeCancel}
              onSignOut={onOpencodeSignOut}
              apiKeyPrefix={settings.webSearchApiKeys?.opencode}
              onSave={onSave}
            />
            <ProviderRefreshRow
              label={t("settings.opencodeModels")}
              hint={
                opencodeModelsError
                  ? t("composer.modelOpencodeError", { error: opencodeModelsError })
                  : t("settings.opencodeModelsHint")
              }
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
        title={t("settings.typesafeSection")}
        defaultOpen={false}
        models={modelColumn(groupModels("typesafe"))}
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
          : (mail?.message ?? t(ui.statusUnknown))}
    </div>
  );
}

/** Automatic quota failover: an ordered list of backup models, tried top-down
 *  when the active provider reports an exhausted quota. Order IS the priority, so
 *  each row carries move-up / move-down controls rather than a sort. */
function PageFallbacks({
  settings,
  onSave,
  ollamaModels,
  opencodeModels,
  ollamaVisionModels,
  opencodeVisionModels,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  ollamaModels?: string[];
  opencodeModels?: string[];
  ollamaVisionModels?: ReadonlySet<string>;
  opencodeVisionModels?: ReadonlySet<string>;
}) {
  const catalog = deriveModelCatalog({
    providerCatalogs: settings.providerCatalogs,
    discoveredAntigravityModels: settings.antigravityOAuth?.models,
    opencodeModels,
    includeAntigravity: Boolean(settings.antigravityOAuth?.signedIn),
    ollamaVisionModels,
    opencodeVisionModels,
  });
  const ollamaList = (ollamaModels ?? []).map((id) => `ollama/${id}`);
  // Backups are chosen from the ENABLED models — the same allow-list every picker
  // offers (Settings → Models). The whole catalog would offer models the user
  // deliberately turned off.
  const enabled = new Set(settings.enabledModels ?? []);
  const catalogGroups: ReadonlyArray<{ key: string; label: string; models: readonly string[] }> = [
    ...catalog.groups.map((group) => ({
      key: group.key as string,
      label: t(MODEL_CATALOG_GROUP_LABELS[group.key]),
      models: group.models,
    })),
    ...(ollamaList.length > 0
      ? [{ key: "ollama", label: t("settings.ollamaSection"), models: ollamaList }]
      : []),
  ];
  // Provider grouping survives the filter, so a backup list can still span providers.
  const groups = catalogGroups
    .map((group) => ({ ...group, models: group.models.filter((model) => enabled.has(model)) }))
    .filter((group) => group.models.length > 0);
  // An enabled id that no catalog places (a hand-edited config, a retired discovery
  // entry) must stay reachable, or it would be enabled yet unpickable.
  const grouped = new Set(catalogGroups.flatMap((group) => [...group.models]));
  const ungrouped = [...enabled].filter((id) => !grouped.has(id));
  const options =
    ungrouped.length > 0
      ? [...groups, { key: "other", label: t("settings.fallbacksOtherGroup"), models: ungrouped }]
      : groups;
  const known = new Set(options.flatMap((group) => [...group.models]));
  const list = settings.fallbackModels ?? [];
  const save = (next: string[]): void => onSave({ fallbackModels: next });
  const move = (from: number, to: number): void => save(moveInList(list, from, to));
  const firstUnused = options
    .flatMap((group) => [...group.models])
    .find((model) => !list.includes(model));

  return (
    <section className="section">
      <div className="stitle">{t("settings.fallbacksSection")}</div>
      <div className="h" style={{ marginBottom: 12 }}>
        {t("settings.fallbacksHint")}
      </div>

      {list.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
          {enabled.size === 0
            ? t("settings.fallbacksNeedsEnabledModels")
            : t("settings.fallbacksEmpty")}
        </div>
      )}

      {list.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {list.map((id, i) => (
            <div className="rule fallback-row" key={`${i}-${id}`}>
              <span className="pat fallback-index">{i + 1}</span>
              <select
                className="field fallback-select"
                aria-label={t("settings.fallbackRowLabel", { index: i + 1 })}
                value={id}
                onChange={(e) =>
                  save(list.map((value, idx) => (idx === i ? e.target.value : value)))
                }
              >
                {/* A saved id outside the enabled list still renders, so the row never
                    shows a blank select — labelled, because it is no longer offered. */}
                {known.has(id) ? null : (
                  <option value={id}>
                    {`${modelDisplayName(id)}${t("settings.fallbackNotEnabledSuffix")}`}
                  </option>
                )}
                {options.map((group) => (
                  <optgroup key={group.key} label={group.label}>
                    {group.models.map((model) => (
                      <option
                        key={model}
                        value={model}
                        disabled={model !== id && list.includes(model)}
                      >
                        {modelDisplayName(model)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div className="fallback-actions">
                <button
                  type="button"
                  className="mini-btn"
                  disabled={i === 0}
                  title={t("settings.fallbackMoveUp")}
                  aria-label={t("settings.fallbackMoveUpAria", { model: id })}
                  onClick={() => move(i, i - 1)}
                >
                  <I.arrowUp size={12} />
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={i === list.length - 1}
                  title={t("settings.fallbackMoveDown")}
                  aria-label={t("settings.fallbackMoveDownAria", { model: id })}
                  onClick={() => move(i, i + 1)}
                >
                  <I.arrowDown size={12} />
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  title={t("settings.fallbackRemove")}
                  aria-label={t("settings.fallbackRemoveAria", { model: id })}
                  onClick={() => save(list.filter((_, idx) => idx !== i))}
                >
                  <I.trash size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="mini-btn"
        disabled={firstUnused === undefined}
        title={t("settings.fallbackAdd")}
        aria-label={t("settings.fallbackAddAria")}
        onClick={() => {
          if (firstUnused === undefined) return;
          save([...list, firstUnused]);
        }}
      >
        <I.plus size={12} /> {t("settings.fallbackAdd")}
      </button>
    </section>
  );
}

export function PageMCP({
  specs,
  bridged,
  onAdd,
  onRemove,
  onToggleServer,
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
  const [mode, setMode] = useState<PlaywrightMcpConnectionMode>("chromium");
  const [extensionBrowser, setExtensionBrowser] = useState<PlaywrightExtensionBrowser>("chrome");
  const [cdpEndpoint, setCdpEndpoint] = useState("");
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
  const configuredMode = extensionStatus?.server.mode;
  const modeLabels: Record<PlaywrightMcpConnectionMode, string> = {
    chromium: t("settings.mcpModeChrome"),
    firefox: t("settings.mcpModeFirefox"),
    webkit: t("settings.mcpModeWebkit"),
    msedge: t("settings.mcpModeEdge"),
    extension: t("settings.mcpModeExtension"),
    cdp: t("settings.mcpModeCdp"),
  };
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
  const playwrightSettings = (
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
          {PLAYWRIGHT_MANAGED_BROWSERS.map((browser) => (
            <option key={browser} value={browser}>
              {modeLabels[browser]}
            </option>
          ))}
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
              placeholder={extensionStatus?.server.tokenPrefix ?? t("settings.mcpTokenPlaceholder")}
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
            <button type="button" className="btn primary" onClick={() => onInstallBrowser(mode)}>
              {t("settings.mcpBrowserInstall", { browser: modeLabels[mode] })}
            </button>
          )
        ) : null}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
        {extensionStatus
          ? extensionStatus.server.configured
            ? `✓ ${t("settings.mcpConfiguredMode", { mode: configuredMode ? modeLabels[configuredMode] : "…" })}${
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
            ? t("settings.mcpBrowserInstallOk", { browser: modeLabels[mode] })
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
  );
  const mailSettings = (
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
                placeholder={
                  mail?.hasClientId ? t("settings.gmailSaved") : "…apps.googleusercontent.com"
                }
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
  );
  return (
    <>
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
        ) : null}
        {specs.map((s) => {
          const canToggle = s.name !== null;
          const headActions =
            canToggle || !s.builtin ? (
              <>
                {canToggle ? (
                  <div className="seg-ctrl">
                    <button
                      type="button"
                      data-on={!s.disabled}
                      onClick={() => onToggleServer(s.name as string, false)}
                    >
                      {t("settings.mcpEnable")}
                    </button>
                    <button
                      type="button"
                      data-on={s.disabled}
                      onClick={() => onToggleServer(s.name as string, true)}
                    >
                      {t("settings.mcpDisable")}
                    </button>
                  </div>
                ) : null}
                {s.builtin ? null : (
                  <div className="seg-ctrl">
                    <button type="button" className="mcp-remove" onClick={() => onRemove(s.raw)}>
                      {t("settings.mcpRemove")}
                    </button>
                  </div>
                )}
              </>
            ) : null;
          return (
            <McpServerCard
              key={s.raw}
              headActions={headActions}
              title={
                <>
                  {s.name ?? "(anonymous)"}
                  {s.builtin ? (
                    <span style={{ color: "var(--muted)", marginLeft: 6, fontSize: 11 }}>
                      · {t("settings.mcpBuiltinBadge")}
                    </span>
                  ) : null}
                </>
              }
            >
              <div className="sub mcp-spec-summary" title={s.summary}>
                {s.summary}
              </div>
              {s.parseError ? (
                <div className="desc" style={{ color: "var(--danger)" }}>
                  {t("settings.parseError", { error: s.parseError })}
                </div>
              ) : null}
              {s.name === "playwright" ? playwrightSettings : null}
              {s.name !== null && /mail/i.test(s.name) ? (
                <div style={{ marginTop: 12 }}>{mailSettings}</div>
              ) : null}
            </McpServerCard>
          );
        })}
        {!specs.some((s) => s.name === "playwright") ? (
          <McpServerCard title={t("settings.mcpBrowserTitle")}>{playwrightSettings}</McpServerCard>
        ) : null}
        {!specs.some((s) => s.name !== null && /mail/i.test(s.name)) ? (
          <McpServerCard title={t("settings.mailTitle")}>{mailSettings}</McpServerCard>
        ) : null}
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

/** The cue rows, in stable display order — one table pairing each id with its
 *  label and hint keys so a new cue can't be added to two of three lists. */
const FEEDBACK_CUES: { id: FeedbackCueId; label: TKey; hint: TKey }[] = [
  {
    id: "inputRequired",
    label: "settings.feedbackCueInputRequired",
    hint: "settings.feedbackCueInputRequiredHint",
  },
  {
    id: "taskComplete",
    label: "settings.feedbackCueTaskComplete",
    hint: "settings.feedbackCueTaskCompleteHint",
  },
  {
    id: "planComplete",
    label: "settings.feedbackCuePlanComplete",
    hint: "settings.feedbackCuePlanCompleteHint",
  },
  {
    id: "guardTriggered",
    label: "settings.feedbackCueGuardTriggered",
    hint: "settings.feedbackCueGuardTriggeredHint",
  },
];

/** Range input with a local draft: dragging updates instantly and the value is
 *  committed once, on release. A fully controlled slider re-rendered from the
 *  daemon round-trip (settings_save → $settings) stutters and can snap back
 *  mid-drag, which is why it felt undraggable. Always draggable — the volume is
 *  set independently of whether the cue's sound is currently on. */
function CueVolumeSlider({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (volume: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = (el: HTMLInputElement) => onCommit(Number(el.value));
  return (
    <>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={(e) => commit(e.currentTarget)}
        onKeyUp={(e) => commit(e.currentTarget)}
        onBlur={(e) => commit(e.currentTarget)}
      />
      <span className="feedback-cue-volume-value">{Math.round(draft * 100)}%</span>
    </>
  );
}

/** The per-type cue matrix as a table — one row per cue, columns for the sound
 *  on/off switch, its volume, and the desktop-notification switch, so every cue
 *  is toggled and tuned the same way. Each control patches the whole
 *  feedbackCues object (the sidecar persists it atomically). */
function FeedbackCuesSection({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const stored: Partial<Record<FeedbackCueId, FeedbackCueSetting>> = settings.feedbackCues ?? {};
  const patchCue = (id: FeedbackCueId, entry: FeedbackCueSetting) => {
    onSave({ feedbackCues: { ...stored, [id]: entry } });
  };
  return (
    <section className="section">
      <div className="stitle">{t("settings.feedbackCuesSection")}</div>
      <div className="h" style={{ marginBottom: 12 }}>
        {t("settings.feedbackCuesSectionHint")}
      </div>
      <table className="feedback-cues-table">
        <thead>
          <tr>
            <th>{t("settings.feedbackCueColCue")}</th>
            <th>{t("settings.feedbackCueColSound")}</th>
            <th>{t("settings.feedbackCueColVolume")}</th>
            <th>{t("settings.feedbackCueColNotify")}</th>
            <th>{t("settings.feedbackCueColTest")}</th>
          </tr>
        </thead>
        <tbody>
          {FEEDBACK_CUES.map(({ id, label, hint }) => {
            const cue = stored[id];
            const enabled = cue?.enabled === true;
            const notify = cue?.notify === true;
            const volume = typeof cue?.volume === "number" ? cue.volume : 0.5;
            const cueName = t(label);
            return (
              <tr key={id}>
                <td className="feedback-cue-name">
                  <div className="n">{cueName}</div>
                  <div className="h">{t(hint)}</div>
                </td>
                <td>
                  <div className="seg-ctrl">
                    <button
                      type="button"
                      aria-pressed={!enabled}
                      aria-label={t("settings.feedbackCueSoundDisable", { cue: cueName })}
                      data-on={!enabled}
                      onClick={() => patchCue(id, { enabled: false, volume, notify })}
                    >
                      {t("settings.feedbackCueOff")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={enabled}
                      aria-label={t("settings.feedbackCueSoundEnable", { cue: cueName })}
                      data-on={enabled}
                      onClick={() => patchCue(id, { enabled: true, volume, notify })}
                    >
                      {t("settings.feedbackCueOn")}
                    </button>
                  </div>
                </td>
                <td className="feedback-cue-volume">
                  <CueVolumeSlider
                    label={t("settings.feedbackCueVolume", { cue: cueName })}
                    value={volume}
                    onCommit={(next) => patchCue(id, { enabled, volume: next, notify })}
                  />
                </td>
                <td>
                  <div className="seg-ctrl">
                    <button
                      type="button"
                      aria-pressed={!notify}
                      aria-label={t("settings.feedbackCueNotifyDisable", { cue: cueName })}
                      data-on={!notify}
                      onClick={() => patchCue(id, { enabled, volume, notify: false })}
                    >
                      {t("settings.feedbackCueOff")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={notify}
                      aria-label={t("settings.feedbackCueNotifyEnable", { cue: cueName })}
                      data-on={notify}
                      onClick={() => patchCue(id, { enabled, volume, notify: true })}
                    >
                      {t("settings.feedbackCueOn")}
                    </button>
                  </div>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn sm"
                    title={t("settings.feedbackCueTestSound", { cue: cueName })}
                    aria-label={t("settings.feedbackCueTestSound", { cue: cueName })}
                    onClick={() => feedbackSounds.play(id, volume)}
                  >
                    <I.play size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
