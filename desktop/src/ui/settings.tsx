import {
  type ProviderSettingSpec,
  type ProviderSettingsMap,
  SEARCH_ENGINE_SPECS,
  type SearchEngineSpec,
  type SearchSettingSpec,
  type SkillGroup,
  groupSkills,
  isSkillCollection,
  mcpServerLabel,
  messageOf,
  modelDisplayLabel,
  modelWireName,
  providerDefaultEndpoint,
  providerSpec,
  providerString,
  resolveFeedbackCueAudio,
  searchSharedCredential,
} from "@reasonix/core-utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Settings as SettingsType } from "../App";
import { feedbackSounds, preloadSoundPack } from "../feedback-sounds";
import { formatBytes } from "../format";
import { type TKey, t } from "../i18n";
import { I } from "../icons";
import {
  HAS_DECLARED_PROVIDERS,
  MODEL_CATALOG_GROUP_LABELS,
  type ModelCatalogGroupKey,
  deriveModelCatalog,
  modelProviderHints,
  providerForModelGroup,
} from "../model-catalog";
import { providerModelCost } from "../model-cost";
import type {
  FeedbackCueAudioSetting,
  FeedbackCueId,
  MailAuthPhase,
  MailAuthState,
  McpAuthState,
  McpAuthStatus,
  McpExtensionCheck,
  McpExtensionStatus,
  McpSpecInfo,
  PlaywrightBrowserInstall,
  PlaywrightExtensionBrowser,
  PlaywrightManagedBrowser,
  PlaywrightManagedBrowserInstallState,
  PlaywrightMcpConnectionMode,
  PluginInfo,
  PluginSkillInfo,
  SettingsPatch,
  SkillInfo,
} from "../protocol";
import {
  type BunInstall,
  type FreeTierStatus,
  MailProvider,
  PLAYWRIGHT_MANAGED_BROWSERS,
  QUICK_SEND_SHORTHAND_MAX_LENGTH,
  createQuickSendId,
  enforceQuickSendShorthand,
} from "../protocol";
import { useRateClock } from "../rate-clock";
import { NOTHING_SOUND_PACK_ID, type SoundPackSpec, resolveSoundPackId } from "../sound-packs";
import {
  FONT_FAMILY,
  FONT_FAMILY_STACK,
  type FontFamily,
  THEME,
  THEME_STYLES,
  type ThemeStyle,
  themeForStyle,
} from "../theme";
import { TEXT_SIZE_RANGE, clampTextSizePx } from "../typography";
import { mergeSoundPacks } from "../user-sound-packs";
import { AudioRecorder } from "../voice/audio-recorder";
import {
  type BarkRuntimePhase,
  type BarkRuntimeStatus,
  barkRuntimeStatus,
  removeBarkRuntime,
} from "../voice/bark-engine";
import {
  type AudioInputDevice,
  getCachedAudioInputDevices,
  getSelectedAudioInputDeviceId,
  listAudioInputDevices,
  requestMicrophoneAccess,
  resolveSelectedDeviceId,
  setCachedAudioInputDevices,
  setSelectedAudioInputDeviceId,
} from "../voice/device";
import {
  deleteVoiceModelCache,
  getActiveVoiceModelId,
  isVoiceModelDownloaded,
} from "../voice/model-cache";
import { VOICE_ENGINES, VOICE_MODELS, type VoiceModelId } from "../voice/model-registry";
import { speechTranscriber } from "../voice/transcriber";
import { AboutPanel } from "./about";
import { type ChangelogState, PageChangelog } from "./changelog";
import { CostBadge } from "./cost-badge";
import { FEEDBACK_CUES } from "./feedback-cue-copy";
import { FitText } from "./fit-text";
import { useInventoryRequest } from "./inventory-request";
import { activationHandler, escapeHandler } from "./keyboard";
import { PackWizard, type SoundPackDraft } from "./pack-wizard";
import { pluginQualifier } from "./plugin-labels";
import { useFullBleed } from "./settings-frame";
import { Shortcut, type ShortcutKey, localizeShortcutText } from "./shortcut";
import { scrollToSection, useActiveSection } from "./use-active-section";

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

export type PageId = "composer" | "models" | "integrations" | "customization" | "about";

/** One section of a page, listed in that page's index while it is open. `id` is the anchor
 *  the row scrolls to and the marker the reader's position is read from. */
export interface PageSection {
  id: string;
  labelKey: TKey;
}

/** One nav entry. `sections` are the parts of this page, not separate pages: the index they
 *  form only exists while the page is open, and it doubles as a position indicator. */
export interface PageEntry {
  id: PageId;
  icon: keyof typeof I;
  sections?: PageSection[];
}

export const PAGE_META: ReadonlyArray<PageEntry> = [
  // Composer owns what the box under the thread does: the microphone and its models, and the
  // quick-send list the Ctrl+Q dropdown and Ctrl+1-9 read.
  {
    id: "composer",
    icon: "send",
    sections: [
      { id: "voice", labelKey: "settings.composerVoice" },
      { id: "quickSend", labelKey: "settings.composerQuickSend" },
    ],
  },
  // Models owns every model the app can call: the enabled ones and their providers, the backup
  // list tried when one runs out of quota, and the web-search engines.
  {
    id: "models",
    icon: "brain",
    sections: [
      { id: "models", labelKey: "settings.modelsSection" },
      { id: "fallbacks", labelKey: "settings.fallbacksSection" },
      { id: "search", labelKey: "settings.searchSection" },
    ],
  },
  // Integrations owns everything the agent can reach outside the chat: the MCP tool servers,
  // the plugins that ship skills and servers together, and the standalone skills.
  {
    id: "integrations",
    icon: "plug",
    sections: [
      { id: "mcp", labelKey: "settings.integrationsMcp" },
      { id: "plugins", labelKey: "settings.integrationsPlugins" },
      { id: "skills", labelKey: "settings.integrationsSkills" },
    ],
  },
  // Customization owns the look of the app: the appearance controls, the theme cards and the
  // sound packs. Its sections are parts of one page, listed in the page's own index.
  {
    id: "customization",
    icon: "layers",
    sections: [
      { id: "appearance", labelKey: "settings.appearanceSection" },
      { id: "themes", labelKey: "settings.customizationThemes" },
      { id: "soundCues", labelKey: "settings.customizationSoundCues" },
    ],
  },
  {
    id: "about",
    icon: "help",
    sections: [
      { id: "version", labelKey: "settings.aboutVersion" },
      { id: "shortcuts", labelKey: "settings.aboutShortcuts" },
      { id: "changelog", labelKey: "settings.aboutChangelog" },
    ],
  },
];

/** Label and description keys are built from the id, so a page cannot have one and not the other. */
function pageLabelKey(id: PageId): TKey {
  return `settings.page${id[0]!.toUpperCase()}${id.slice(1)}Label` as TKey;
}

function pageDescKey(id: PageId): TKey {
  return `settings.page${id[0]!.toUpperCase()}${id.slice(1)}Desc` as TKey;
}

/** The heading id a section's `aria-labelledby` and the page index both read. */
function sectionHeadingId(id: string): string {
  return `settings-section-${id}`;
}

/** One page section: wrapper, heading and anchor id travel together, so a section cannot
 *  render a heading whose id its index row does not scroll to. */
function SettingsSection({
  id,
  labelKey,
  children,
}: {
  id: string;
  labelKey: TKey;
  children: ReactNode;
}) {
  const headingId = sectionHeadingId(id);
  return (
    <section className="section settings-section" data-section={id} aria-labelledby={headingId}>
      <h3 className="stitle" id={headingId}>
        {t(labelKey)}
      </h3>
      {children}
    </section>
  );
}

export function SettingsModal({
  settings,
  textSizePx,
  onSetTextSize,
  themeStyle,
  onSetThemeStyle,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  initialPage,
  mcpSpecs,
  mcpBridged,
  plugins,
  onInstallPlugin,
  onUninstallPlugin,
  onTogglePlugin,
  onRequestPlugins,
  onClose,
  onSave,
  /** Forgets the persisted window state and restores the configured geometry. */
  onResetWindowState,
  freeTierStatus,
  bunInstall,
  onInstallBun,
  oauthWaiting,
  onOAuthBegin,
  onOAuthCancel,
  onOAuthSignOut,
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
  onRefreshProviderCatalogs,
  onAddMcpSpec,
  onRemoveMcpSpec,
  onToggleMcpServer,
  mcpExtensionStatus,
  mcpExtensionCheck,
  playwrightBrowserInstall,
  skills,
  onInstallSkill,
  onUninstallSkill,
  onRequestSkills,
  onPickSound,
  onCreateSoundPack,
  onRemoveSoundPack,
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
  mcpAuth,
  onConnectServer,
  onCancelServerSignIn,
  onDisconnectServer,
  changelog,
  onRefreshChangelog,
}: {
  settings: SettingsType;
  textSizePx: number;
  onSetTextSize: (size: number) => void;
  themeStyle: ThemeStyle;
  onSetThemeStyle: (style: ThemeStyle) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  initialPage?: PageId;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  /** Installed agent plugins, mirrored from the daemon's `$plugins` snapshot. */
  plugins: PluginInfo[];
  /** Installed standalone skills, mirrored from the daemon's `$skills` snapshot. */
  skills: SkillInfo[];
  onClose: () => void;
  onSave: (patch: SettingsPatch) => void;
  onResetWindowState: () => void;
  /** Whether the free OpenCode tier can be served right now. */
  freeTierStatus?: FreeTierStatus | null;
  /** Latest Bun install phase, so the OpenCode card can show progress and failures. */
  bunInstall?: BunInstall | null;
  /** Download and install Bun, then relaunch: the OpenCode card's action. */
  onInstallBun?: () => void;
  /** Ollama chat endpoint (OpenAI-compatible) shown on the Models page. */
  /** Dynamically fetched Ollama models (raw ids) — rendered as a scrollable grid. */
  ollamaModels?: string[];
  /** Why the last fetch failed — replaces the grid so the failure isn't silent. */
  ollamaModelsError?: string;
  /** The account's Ollama plan (e.g. `free`) when the cloud reported it. */
  ollamaPlan?: string;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount?: number;
  /** Re-query the Ollama catalog. Opening the Models page calls this, so the list is
   *  current without a refresh button. */
  onRefreshOllamaModels?: () => void;
  /** Prefixed vision-capable Ollama ids (`ollama/llava`) — shown as a badge. */
  ollamaVisionModels?: ReadonlySet<string>;
  opencodeModels?: string[];
  opencodeModelsError?: string;
  opencodeVisionModels?: ReadonlySet<string>;
  onRefreshOpencodeModels?: () => void;
  /** Re-query every provider's discovery catalog (models-endpoint providers). */
  onRefreshProviderCatalogs?: () => void;
  oauthWaiting: boolean;
  onOAuthBegin: () => void;
  onOAuthCancel: () => void;
  onOAuthSignOut: () => void;
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
  onInstallPlugin: (source: string) => void;
  onUninstallPlugin: (name: string) => void;
  /** Edit one plugin's Settings default: what a new chat's picker starts from. */
  onTogglePlugin: (slug: string, disabled: boolean) => void;
  /** Re-request the plugin inventory (the section calls this when it opens). */
  onRequestPlugins: () => void;
  onInstallSkill: (source: string) => void;
  /** Remove these skills in one pass: a Settings group drops whole. */
  onUninstallSkill: (names: string[]) => void;
  /** Re-request the skill inventory (the Skills section calls this when it opens). */
  onRequestSkills: () => void;
  /** Opens the desktop file dialog for one cue's audio, for the pack wizard. */
  onPickSound: () => Promise<string | null>;
  onCreateSoundPack: (draft: SoundPackDraft) => void;
  onRemoveSoundPack: (id: string) => void;
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
  /** Latest MCP sign-in event, if any: drives the per-server sign-in control. */
  mcpAuth: McpAuthStatus | null;
  onConnectServer: (name: string) => void;
  onCancelServerSignIn: (name: string) => void;
  onDisconnectServer: (name: string) => void;
  /** Repo commit history grouped per release, plus a forced-refetch trigger. */
  changelog: ChangelogState;
  onRefreshChangelog: (force?: boolean) => void;
}) {
  const [page, setPage] = useState<PageId>(initialPage ?? "composer");
  // Both the MCP section and the Search section gate on managed-build state, so it is
  // requested for either entry point rather than only when the MCP section opens.
  useEffect(() => {
    onRequestMcpExtensionStatus();
  }, [onRequestMcpExtensionStatus]);
  // The Models page lists live catalogs, so opening it re-queries every source instead
  // of offering a refresh button. Each source keeps its own cache window in the backend,
  // so a revisit inside that window costs nothing.
  useEffect(() => {
    if (page !== "models") return;
    onRefreshOllamaModels?.();
    onRefreshOpencodeModels?.();
    onRefreshProviderCatalogs?.();
  }, [page, onRefreshOllamaModels, onRefreshOpencodeModels, onRefreshProviderCatalogs]);
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
  // The page body is the scroller the section index reads and moves. Held as state, not a
  // ref, so reopening the window rebinds the index to the body that is actually mounted.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const sectionIds = useMemo(
    () => (currentMeta.sections ?? []).map((section) => section.id),
    [currentMeta],
  );
  const activeSection = useActiveSection(bodyEl, sectionIds);
  // A window narrower than 70% of the screen gains nothing from the frame's margins.
  const fullBleed = useFullBleed();
  return (
    <div
      className="settings-mask"
      onClick={onClose}
      onKeyDown={escapeHandler(onClose)}
      tabIndex={-1}
    >
      <div
        className="settings"
        data-full={fullBleed || undefined}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-side">
          <div className="sg">{t("settings.title")}</div>
          {PAGE_META.map((entry) => {
            const label = t(pageLabelKey(entry.id));
            return (
              <div key={entry.id}>
                <div
                  className="row"
                  role="button"
                  tabIndex={0}
                  aria-current={page === entry.id ? "page" : undefined}
                  data-active={page === entry.id}
                  onClick={() => setPage(entry.id)}
                  onKeyDown={activationHandler(() => setPage(entry.id))}
                  title={label}
                >
                  <span className="ico">{I[entry.icon]({ size: 16 })}</span>
                  <span>{label}</span>
                </div>
                {page === entry.id && entry.sections ? (
                  <div className="kids">
                    {entry.sections.map((section) => (
                      <div
                        key={section.id}
                        className="row kid"
                        role="button"
                        tabIndex={0}
                        data-active={activeSection === section.id}
                        aria-current={activeSection === section.id ? "location" : undefined}
                        onClick={() => scrollToSection(bodyEl, section.id)}
                        onKeyDown={activationHandler(() => scrollToSection(bodyEl, section.id))}
                        title={t(section.labelKey)}
                      >
                        <span>{t(section.labelKey)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <div>
              <h2>{t(pageLabelKey(currentMeta.id))}</h2>
              <div className="desc">{t(pageDescKey(currentMeta.id))}</div>
            </div>
            <span className="grow" />
            <button type="button" className="close-btn" onClick={onClose}>
              <I.x size={14} />
            </button>
          </div>
          <div className="settings-body" ref={setBodyEl}>
            {page === "composer" && <PageComposer settings={settings} onSave={onSave} />}
            {page === "models" && (
              <div className="page-models">
                <SettingsSection id="models" labelKey="settings.modelsSection">
                  <PageModels
                    settings={settings}
                    onSave={onSave}
                    ollamaModels={ollamaModels}
                    ollamaModelsError={ollamaModelsError}
                    ollamaPlan={ollamaPlan}
                    ollamaHiddenCount={ollamaHiddenCount}
                    ollamaVisionModels={ollamaVisionModels}
                    opencodeModels={opencodeModels}
                    opencodeModelsError={opencodeModelsError}
                    opencodeVisionModels={opencodeVisionModels}
                    oauthSignedIn={settings.openaiOAuth?.signedIn ?? false}
                    oauthAccount={settings.openaiOAuth?.account}
                    oauthFlowError={settings.openaiOAuth?.flowError}
                    oauthWaiting={oauthWaiting}
                    onOAuthBegin={onOAuthBegin}
                    onOAuthCancel={onOAuthCancel}
                    onOAuthSignOut={onOAuthSignOut}
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
                    freeTierStatus={freeTierStatus}
                    bunInstall={bunInstall}
                    onInstallBun={onInstallBun}
                    mimoOAuthWaiting={mimoOAuthWaiting}
                    onMiMoOAuthBegin={onMiMoOAuthBegin}
                    onMiMoOAuthCancel={onMiMoOAuthCancel}
                    onMiMoOAuthSignOut={onMiMoOAuthSignOut}
                  />
                </SettingsSection>
                <SettingsSection id="fallbacks" labelKey="settings.fallbacksSection">
                  <PageFallbacks
                    settings={settings}
                    onSave={onSave}
                    ollamaModels={ollamaModels}
                    opencodeModels={opencodeModels}
                    ollamaVisionModels={ollamaVisionModels}
                    opencodeVisionModels={opencodeVisionModels}
                  />
                </SettingsSection>
                <SettingsSection id="search" labelKey="settings.searchSection">
                  <PageSearch
                    settings={settings}
                    onSave={onSave}
                    browserInstalls={mcpExtensionStatus?.installs ?? null}
                  />
                </SettingsSection>
              </div>
            )}
            {page === "integrations" && (
              <div className="page-integrations">
                <SettingsSection id="mcp" labelKey="settings.integrationsMcp">
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
                    mcpAuth={mcpAuth}
                    onConnectServer={onConnectServer}
                    onCancelServerSignIn={onCancelServerSignIn}
                    onDisconnectServer={onDisconnectServer}
                  />
                </SettingsSection>
                <SettingsSection id="plugins" labelKey="settings.integrationsPlugins">
                  <PagePlugins
                    plugins={plugins}
                    onInstall={onInstallPlugin}
                    onUninstall={onUninstallPlugin}
                    onToggle={onTogglePlugin}
                    onRequest={onRequestPlugins}
                    mcpAuth={mcpAuth}
                    onConnectServer={onConnectServer}
                    onCancelServerSignIn={onCancelServerSignIn}
                    onDisconnectServer={onDisconnectServer}
                  />
                </SettingsSection>
                <SettingsSection id="skills" labelKey="settings.integrationsSkills">
                  <PageSkills
                    skills={skills}
                    onInstall={onInstallSkill}
                    onUninstall={onUninstallSkill}
                    onRequest={onRequestSkills}
                  />
                </SettingsSection>
              </div>
            )}
            {page === "about" && (
              <PageAbout changelog={changelog} onRefreshChangelog={onRefreshChangelog} />
            )}
            {page === "customization" && (
              <PageCustomization
                textSizePx={textSizePx}
                onSetTextSize={onSetTextSize}
                themeStyle={themeStyle}
                onSetThemeStyle={onSetThemeStyle}
                fontFamily={fontFamily}
                onSetFontFamily={onSetFontFamily}
                customFontFamily={customFontFamily}
                onSetCustomFontFamily={onSetCustomFontFamily}
                onResetWindowState={onResetWindowState}
                settings={settings}
                onSave={onSave}
                onPickSound={onPickSound}
                onCreatePack={onCreateSoundPack}
                onRemovePack={onRemoveSoundPack}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Open a URL in the system browser; the browser reports its own failure. */
function openExternal(url: string, program?: string): void {
  void (program ? openUrl(url, program) : openUrl(url)).catch(() => undefined);
}

function signUpLink(url: string): ReactNode {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(url);
      }}
    >
      {t("settings.webSearchApiKeySignup")}
    </a>
  );
}

/** The declared fields the shared setting row renders; each surface adds its own owner. */
interface DeclaredSettingView {
  key: string;
  label: string | null;
  hint: string | null;
  kind: "secret" | "url" | "internal";
  placeholder: string | null;
  signupUrl?: string | null;
}

/** One declared setting, rendered the same way on the Search section and a provider card:
 *  a masked row for secrets, a labelled input row otherwise. */
function DeclaredSettingRow({
  setting,
  value,
  placeholder,
  rowClass,
  onSave,
}: {
  setting: DeclaredSettingView;
  value?: string;
  placeholder?: string;
  rowClass?: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const label = setting.label ?? setting.key;
  const resolvedPlaceholder = placeholder ?? setting.placeholder ?? undefined;
  const save = (next: string): void => onSave(next.trim());
  if (setting.kind === "secret") {
    return (
      <ApiKeyRow
        label={label}
        prefix={value}
        placeholder={resolvedPlaceholder}
        onSave={save}
        hint={setting.signupUrl ? signUpLink(setting.signupUrl) : (setting.hint ?? undefined)}
      />
    );
  }
  return (
    <div className={`setting-row setting-row-entry${rowClass ? ` ${rowClass}` : ""}`}>
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">{setting.hint}</div>
      </div>
      <SettingsEntry
        value={draft}
        onChange={setDraft}
        placeholder={resolvedPlaceholder}
        onSave={() => save(draft)}
      />
    </div>
  );
}

/** One declared engine setting, rendered from its declaration. Writes stay inside the
 *  engine's own entry, so a shared credential can never be copied through this surface. */
function SearchEngineSettingRow({
  engineId,
  setting,
  value,
  onSave,
}: {
  engineId: string;
  setting: SearchSettingSpec;
  value?: string;
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <DeclaredSettingRow
      setting={setting}
      value={value}
      rowClass="setting-row-base-url"
      onSave={(next) => onSave({ searchSettings: { [engineId]: { [setting.key]: next } } })}
    />
  );
}

/** Picker copy for every connection mode, shared by the MCP card and the Search section. */
const MODE_LABEL_KEYS: Record<PlaywrightMcpConnectionMode, TKey> = {
  chromium: "settings.mcpModeChrome",
  firefox: "settings.mcpModeFirefox",
  webkit: "settings.mcpModeWebkit",
  msedge: "settings.mcpModeEdge",
  extension: "settings.mcpModeExtension",
  cdp: "settings.mcpModeCdp",
};

function modeLabel(mode: PlaywrightMcpConnectionMode): string {
  return t(MODE_LABEL_KEYS[mode]);
}

/** Status copy for one bridged server, shared by the MCP card and the plugin cards. */
function serverStatusLabel(
  status: McpSpecInfo["status"],
  reason?: string,
  toolCount?: number,
): { text: string; color: string } {
  switch (status) {
    case "disabled":
      return { text: t("settings.mcpConnDisabled"), color: "var(--muted)" };
    case "connected":
      return {
        text: t("settings.mcpConnConnected", { count: toolCount ?? 0 }),
        color: "var(--accent)",
      };
    case "handshake":
      return { text: t("settings.mcpConnHandshake"), color: "var(--muted)" };
    case "failed":
      return {
        text: t("settings.mcpConnFailed", { reason: reason ?? "" }),
        color: "var(--danger)",
      };
    default:
      return { text: t("settings.mcpConnIdle"), color: "var(--muted)" };
  }
}

/** Every state a build row can show: the daemon probe's answer, a live install that
 *  outranks it, and the gap before the probe has answered. */
type ManagedBuildDisplayState =
  | PlaywrightManagedBrowserInstallState["state"]
  | "installing"
  | "unknown";

const BUILD_STATE_LABEL_KEYS: Record<ManagedBuildDisplayState, TKey> = {
  installed: "settings.mcpBuildInstalled",
  missing: "settings.mcpBuildMissing",
  system: "settings.mcpBuildSystem",
  installing: "settings.mcpBuildInstalling",
  unknown: "settings.mcpBuildUnknown",
};

/** The recorded install state of one managed build, or undefined while it is unknown. */
function buildStateOf(
  installs: readonly PlaywrightManagedBrowserInstallState[] | null | undefined,
  browser: PlaywrightManagedBrowser,
): PlaywrightManagedBrowserInstallState["state"] | undefined {
  return installs?.find((entry) => entry.browser === browser)?.state;
}

/** What one build row shows. A live install outranks the probe: Playwright writes its
 *  completion marker before the installer exits, so the probe can answer "installed"
 *  while the job is still running. */
function buildDisplayState(
  installs: readonly PlaywrightManagedBrowserInstallState[] | null | undefined,
  browser: PlaywrightManagedBrowser,
  installing: PlaywrightManagedBrowser | null,
): ManagedBuildDisplayState {
  if (installing === browser) return "installing";
  return buildStateOf(installs, browser) ?? "unknown";
}

/** A build is present unless the daemon reports it missing: an unknown state is not
 *  evidence of absence, so it never locks a picker. */
function buildPresent(state: PlaywrightManagedBrowserInstallState["state"] | undefined): boolean {
  return state === undefined || state === "installed" || state === "system";
}

/** True only when the daemon says this build is absent, so a picker can gray it out. */
function isBuildMissing(
  installs: readonly PlaywrightManagedBrowserInstallState[] | null | undefined,
  browser: PlaywrightManagedBrowser,
): boolean {
  return buildStateOf(installs, browser) === "missing";
}

/** One engine tile on the Search section: its own declared fields sit inside, and its
 *  action slot carries the Active marker or the button that makes it the engine
 *  `web_search` uses. A tile rather than a collapsible card, because expanding one revealed
 *  a single field; the grid fits three engines in the space two cards took. A shared engine
 *  names the Models field that owns the key instead of rendering a second input for it. */
function SearchEngineCard({
  spec,
  active,
  onSelect,
  settings,
  onSave,
  browserInstalls,
}: {
  spec: SearchEngineSpec;
  active: boolean;
  onSelect: () => void;
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  browserInstalls: readonly PlaywrightManagedBrowserInstallState[] | null;
}) {
  const shared = searchSharedCredential(spec);
  const buildState = spec.browser ? buildStateOf(browserInstalls, spec.browser) : undefined;
  const ready = engineReady(spec, settings) && buildPresent(buildState);
  const owner = shared ? (providerSpec(shared.provider)?.label ?? shared.provider) : null;
  return (
    <div className="tile" data-active={active}>
      <div className="tile-head">
        <div className="tile-title">{spec.label}</div>
      </div>
      {spec.description ? <div className="tile-desc">{spec.description}</div> : null}
      {shared ? (
        <div className="tile-desc">
          {t("settings.searchSharedKeyNote", { provider: owner ?? "" })}
        </div>
      ) : spec.settings.length === 0 ? (
        <div className="tile-desc">{t("settings.searchEngineNoSetup")}</div>
      ) : (
        spec.settings.map((setting) => (
          <SearchEngineSettingRow
            key={setting.key}
            engineId={spec.id}
            setting={setting}
            value={settings.searchSettings?.[spec.id]?.[setting.key]}
            onSave={onSave}
          />
        ))
      )}
      <div className="tile-actions">
        {active ? (
          <span className="tile-active">✓ {t("settings.activePill")}</span>
        ) : (
          <button
            type="button"
            className="btn small"
            disabled={!ready}
            title={
              ready
                ? undefined
                : buildPresent(buildState)
                  ? t("settings.searchEngineNeedsKey")
                  : t("settings.searchEngineNeedsBrowser", {
                      browser: spec.browser ? modeLabel(spec.browser) : "",
                    })
            }
            onClick={onSelect}
          >
            {t("settings.searchEngineUse")}
          </button>
        )}
      </div>
    </div>
  );
}

/** An engine can be chosen once its own key (or the provider key it shares) is set; an
 *  engine that declares no secret needs nothing, since endpoints carry a default. */
function engineReady(spec: SearchEngineSpec, settings: SettingsType): boolean {
  const shared = searchSharedCredential(spec);
  if (shared) return Boolean(settings.providerSettings?.[shared.provider]?.[shared.key]);
  return spec.settings.every(
    (setting) =>
      setting.kind !== "secret" || Boolean(settings.searchSettings?.[spec.id]?.[setting.key]),
  );
}

/** Search configuration, generated from search-engines/*.json: one tile per declared
 *  engine, in the same grid the voice models use. */
function PageSearch({
  settings,
  onSave,
  browserInstalls,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  browserInstalls: readonly PlaywrightManagedBrowserInstallState[] | null;
}) {
  const activeId = settings.webSearchEngine ?? "bing";
  return (
    <section className="section">
      {SEARCH_ENGINE_SPECS.length === 0 ? (
        <div className="section-hint">{t("settings.noSearchEnginesDeclared")}</div>
      ) : (
        <div className="section-hint">{t("settings.searchEnginesHint")}</div>
      )}
      <div className="tile-grid search-grid">
        {SEARCH_ENGINE_SPECS.map((spec) => (
          <SearchEngineCard
            key={spec.id}
            spec={spec}
            active={spec.id === activeId}
            onSelect={() =>
              onSave({ webSearchEngine: spec.id as NonNullable<SettingsPatch["webSearchEngine"]> })
            }
            settings={settings}
            onSave={onSave}
            browserInstalls={browserInstalls}
          />
        ))}
      </div>
    </section>
  );
}

/** The font-family picker, system first: it is the one that matches the OS. Each row in the
 *  menu previews its own face; custom has no known stack, so it previews the one in force.
 *  A menu of our own rather than a native select, because the platform draws its highlight
 *  in its own colour and no theme token reaches it. */
const FONT_FAMILY_CHOICES: ReadonlyArray<{ value: FontFamily; labelKey: TKey }> = [
  { value: FONT_FAMILY.SYSTEM, labelKey: "settings.fontFamilySystem" },
  { value: FONT_FAMILY.SANS, labelKey: "settings.fontFamilySans" },
  { value: FONT_FAMILY.SERIF, labelKey: "settings.fontFamilySerif" },
  { value: FONT_FAMILY.CUSTOM, labelKey: "settings.fontFamilyCustom" },
];

function FontFamilyPicker({
  value,
  onSelect,
}: {
  value: FontFamily;
  onSelect: (next: FontFamily) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = FONT_FAMILY_CHOICES.find((choice) => choice.value === value);
  const label = t(current?.labelKey ?? "settings.fontFamilySans");
  const faceOf = (family: FontFamily): string | undefined =>
    family === FONT_FAMILY.CUSTOM ? undefined : FONT_FAMILY_STACK[family];

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="font-family-picker" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="font-family-select"
        style={{ fontFamily: faceOf(value) }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("settings.fontFamily")}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{label}</span>
        <I.chev size={10} />
      </button>
      {open ? (
        <div className="font-family-menu" role="menu" aria-label={t("settings.fontFamily")}>
          {FONT_FAMILY_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice.value === value}
              data-on={choice.value === value}
              style={{ fontFamily: faceOf(choice.value) }}
              onClick={() => {
                onSelect(choice.value);
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              {t(choice.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Composer: what the box under the thread does. Voice carries the microphone and its models,
 *  Quick send the list the Ctrl+Q dropdown and the Ctrl+1-9 hotkeys read. */
function PageComposer({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <div className="page-composer">
      <SettingsSection id="voice" labelKey="settings.composerVoice">
        <VoiceInputSettings />
      </SettingsSection>
      <SettingsSection id="quickSend" labelKey="settings.composerQuickSend">
        <QuickSendSettings settings={settings} onSave={onSave} />
      </SettingsSection>
    </div>
  );
}

/** The ordered shorthand to message list behind the Ctrl+Q dropdown and the Ctrl+1-9
 *  hotkeys. */
function QuickSendSettings({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [quickSendShorthand, setQuickSendShorthand] = useState("");
  const [quickSendMessage, setQuickSendMessage] = useState("");
  return (
    <section className="section">
      <div className="section-hint" style={{ marginBottom: 12 }}>
        {localizeShortcutText(t("settings.quickSendHint"))}
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
        <div style={{ color: "var(--muted)", fontSize: "var(--fs-12)", marginBottom: 12 }}>
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
            className="rule-input rule-shorthand"
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
  );
}

const AUDIO_TEST_DURATION_MS = 4000;

/**
 * Voice input: the microphone first, then the speech-to-text models as cards. Nothing here is
 *  collapsible: the section heading is the only title, and the page scrolls.
 */
export function VoiceInputSettings() {
  return (
    <div className="voice-settings">
      <AudioInputDevicePicker />
      <VoiceModelList />
    </div>
  );
}

/**
 * Microphone picker for voice input. Persists the choice in localStorage.
 *
 * Microphone access is gated behind an explicit consent button: browsers only
 * reveal real device labels once permission is granted, and we never touch media
 * hardware (enumeration surfaces connected cameras to the OS media stack in
 * WebView2) until the user opts in. After consent the real device list and a live
 * record/playback test are shown.
 */
function AudioInputDevicePicker() {
  const [initialState] = useState(() => {
    const cachedDevices = getCachedAudioInputDevices();
    return {
      devices: cachedDevices ?? [],
      phase: cachedDevices ? "ready" : "consent",
    } as const;
  });
  const [devices, setDevices] = useState<AudioInputDevice[]>(initialState.devices);
  const [selected, setSelected] = useState<string>(() => getSelectedAudioInputDeviceId());
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"consent" | "ready">(initialState.phase);
  const [granting, setGranting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listAudioInputDevices();
      setDevices(list);
      setCachedAudioInputDevices(list);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

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
      await refresh();
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
    <div className="voice-device-settings">
      {error && (
        <div className="voice-error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.voiceInputDevice")}</div>
          <div className="h">{t("settings.voiceInputDeviceHint")}</div>
        </div>
        {phase === "consent" ? (
          <button type="button" className="btn small" onClick={handleAllow} disabled={granting}>
            <I.mic size={13} />
            <span>{t("settings.voiceInputDeviceAllow")}</span>
          </button>
        ) : (
          <div className="voice-device-controls">
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
            <button type="button" className="btn small" onClick={() => void refresh()}>
              {t("settings.voiceInputDeviceRefresh")}
            </button>
          </div>
        )}
      </div>

      {phase === "consent" ? (
        <div className="voice-section-hint">{t("settings.voiceInputDeviceAllowHint")}</div>
      ) : (
        <AudioInputDeviceTest deviceId={selected} />
      )}
    </div>
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

/** Provisioning phases named while a host runtime installs, in order. */
const RUNTIME_STAGE_KEY: Record<BarkRuntimePhase, TKey> = {
  installer: "settings.voiceRuntimeInstaller",
  environment: "settings.voiceRuntimeEnvironment",
  packages: "settings.voiceRuntimePackages",
  ready: "settings.voiceRuntimeReady",
};

/**
 * Speech-to-text model picker: each model downloads on demand into the local cache and is then
 *  selectable.
 */
function VoiceModelList() {
  const [activeModel, setActiveModel] = useState<VoiceModelId>(() => getActiveVoiceModelId());
  const [downloadedMap, setDownloadedMap] = useState<Record<string, boolean>>({});
  const [downloadingModel, setDownloadingModel] = useState<VoiceModelId | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadFile, setDownloadFile] = useState<string>("");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<BarkRuntimeStatus | null>(null);
  const [downloadStage, setDownloadStage] = useState<BarkRuntimePhase | null>(null);

  const refreshDownloaded = useCallback(async () => {
    const nextMap: Record<string, boolean> = {};
    for (const m of VOICE_MODELS) {
      nextMap[m.modelId] = await isVoiceModelDownloaded(m.modelId);
    }
    setDownloadedMap(nextMap);
    try {
      setRuntimeStatus(await barkRuntimeStatus());
    } catch {
      // A browser build has no host runtime to report.
      setRuntimeStatus(null);
    }
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
    setDownloadStage(null);
    setDownloadError(null);

    try {
      await speechTranscriber.downloadModel(id, (p) => {
        setDownloadStage(p.stage ?? null);
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
      setDownloadStage(null);
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

  const handleRemoveRuntime = async () => {
    try {
      await removeBarkRuntime();
      await refreshDownloaded();
    } catch (err) {
      setDownloadError(messageOf(err));
    }
  };

  return (
    <div className="voice-model-col">
      <div className="voice-col-title">{t("settings.voiceSection")}</div>
      <div className="voice-section-hint">{t("settings.voiceSectionHint")}</div>
      {downloadError && (
        <div className="voice-error-banner" role="alert">
          <span>{downloadError}</span>
          <button type="button" className="btn btn-subtle" onClick={() => setDownloadError(null)}>
            ✕
          </button>
        </div>
      )}
      {runtimeStatus?.installed && (
        <div className="voice-runtime-row">
          <span className="voice-section-hint">
            {t("settings.voiceRuntimeInstalled", { size: formatBytes(runtimeStatus.bytes) })}
          </span>
          <button type="button" className="btn btn-subtle" onClick={handleRemoveRuntime}>
            {t("settings.voiceRuntimeRemove")}
          </button>
        </div>
      )}
      <div className="tile-grid">
        {VOICE_MODELS.map((model) => {
          const isActive = activeModel === model.modelId;
          const isDownloaded = Boolean(downloadedMap[model.modelId]);
          const isDownloading = downloadingModel === model.modelId;
          const engine = VOICE_ENGINES[model.engine];

          return (
            <div
              key={model.modelId}
              className={`tile ${isActive ? "active" : ""}`}
              data-active={isActive}
            >
              <div className="tile-head">
                <div className="tile-title">{model.name}</div>
                <span className="tile-badge">{model.badge ?? "Balanced"}</span>
              </div>

              <div className="tile-meta">
                {model.parameters && (
                  <>
                    <span>{model.parameters} params</span>
                    <span>•</span>
                  </>
                )}
                <span>{model.size}</span>
                {engine.labelKey && (
                  <>
                    <span>•</span>
                    <span>{t(engine.labelKey)}</span>
                  </>
                )}
              </div>

              <div className="tile-desc">{model.description}</div>

              {engine.runtime && (
                <div className="tile-desc voice-runtime-note">
                  {t("settings.voiceRuntimeNote", {
                    size: formatBytes(engine.runtime.estimatedBytes),
                  })}
                </div>
              )}

              {isDownloading && (
                <div className="voice-download-box">
                  <div className="voice-progress-meta">
                    <span className="voice-file-name">
                      {downloadStage
                        ? t(RUNTIME_STAGE_KEY[downloadStage])
                        : downloadFile || t("settings.voiceDownloading")}
                    </span>
                    {!downloadStage && <span className="voice-pct">{downloadProgress}%</span>}
                  </div>
                  <div
                    className={`voice-progress-track${downloadStage ? " indeterminate" : ""}`}
                    role="progressbar"
                    aria-busy={Boolean(downloadStage)}
                  >
                    <div
                      className="voice-progress-bar"
                      style={downloadStage ? undefined : { width: `${downloadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="tile-actions">
                {engine.requirementKey ? (
                  <span className="voice-requirement">{t(engine.requirementKey)}</span>
                ) : isDownloading ? (
                  <button type="button" className="btn" disabled>
                    {t("settings.voiceDownloading")}
                  </button>
                ) : isDownloaded ? (
                  <>
                    {isActive ? (
                      <span className="tile-active">✓ {t("settings.voiceActive")}</span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => handleSelect(model.modelId)}
                      >
                        {t("settings.voiceSelect")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-subtle"
                      title="Delete downloaded files to free space"
                      onClick={() => handleDelete(model.modelId)}
                    >
                      {t("settings.voiceDelete")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-download"
                    disabled={downloadingModel !== null}
                    onClick={() => handleDownload(model.modelId)}
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
  );
}

function SettingsEntry({
  value,
  onChange,
  onSave,
  onClear,
  placeholder,
  secret = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Removes the stored value; undefined when there is nothing saved to remove. */
  onClear?: () => void;
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
      {onClear ? (
        <button type="button" className="btn" onClick={onClear}>
          {t("settings.apiKeyClear")}
        </button>
      ) : null}
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
  const commit = (next: string): void => {
    onSave(next.trim());
    setDraft("");
  };
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
        onSave={() => commit(draft)}
        onClear={prefix ? () => commit("") : undefined}
      />
    </div>
  );
}

/** One provider's declared OAuth panel copy. Undefined unless the provider is
 *  declared and declares a sign-in title, which is how deleting its JSON drops the
 *  panel instead of rendering empty buttons. */
function panelText(
  providerId: string,
): ((key: string, vars?: Record<string, string>) => string) | undefined {
  const spec = providerSpec(providerId);
  if (!providerString(spec, "panelSignInTitle")) return undefined;
  return (key, vars) => providerString(spec, key, vars) ?? "";
}

interface OAuthSectionProps {
  signedIn: boolean;
  /** Last OAuth flow failure — shown so a failed sign-in is visible instead of just "not signed in". */
  flowError?: string;
  waiting: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}

/** One provider's declared OAuth panel. The providers differ only in the line that
 *  replaces the sign-in hint once signed in, so that line is the slot. */
function OAuthPanel({
  providerId,
  signedIn,
  flowError,
  waiting,
  onBegin,
  onCancel,
  onSignOut,
  statusLine,
}: OAuthSectionProps & {
  providerId: string;
  statusLine: (copy: (key: string, vars?: Record<string, string>) => string) => ReactNode;
}) {
  const copy = panelText(providerId);
  if (!copy) return null;
  return (
    <>
      {signedIn ? (
        <div className="setting-row">
          <div className="l">
            <div className="n">{copy("panelSignedIn")}</div>
            <div className="h">{statusLine(copy)}</div>
          </div>
          <button type="button" className="btn" onClick={onSignOut} disabled={waiting}>
            {copy("panelSignOut")}
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="l">
            <div className="n">{copy("panelSignInTitle")}</div>
            <div className="h">{waiting ? copy("panelWaiting") : copy("panelSignInHint")}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {waiting && (
              <button type="button" className="btn" onClick={onCancel}>
                {copy("panelCancel")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onBegin} disabled={waiting}>
              {copy("panelSignIn")}
            </button>
          </div>
        </div>
      )}
      {flowError ? (
        <div className="setting-row" style={{ borderColor: "var(--danger)" }}>
          <div className="l">
            <div className="n">{copy("panelFlowFailed")}</div>
            <div className="h" style={{ color: "var(--danger)" }}>
              {flowError}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function OpenAISection(props: OAuthSectionProps & { account?: string }) {
  const { account, ...rest } = props;
  return (
    <OAuthPanel
      providerId="openai"
      {...rest}
      statusLine={(copy) => (account ? copy("panelAccount", { account }) : copy("panelTokenSet"))}
    />
  );
}

export function AntigravitySection(props: OAuthSectionProps & { account?: string }) {
  const { account, ...rest } = props;
  return (
    <OAuthPanel
      providerId="gemini"
      {...rest}
      statusLine={(copy) => (account ? copy("panelAccount", { account }) : copy("panelTokenSet"))}
    />
  );
}

export function MiMoSection(props: OAuthSectionProps) {
  return <OAuthPanel providerId="mimo" {...props} statusLine={(copy) => copy("panelKeyStored")} />;
}

export function OpencodeSection(props: OAuthSectionProps & { account?: string; orgName?: string }) {
  const { account, orgName, ...rest } = props;
  return (
    <OAuthPanel
      providerId="opencode"
      {...rest}
      statusLine={(copy) =>
        account
          ? orgName
            ? copy("panelAccountOrg", { account, org: orgName })
            : copy("panelAccount", { account })
          : copy("panelTokenSet")
      }
    />
  );
}

/** The Bun runtime and the account free-tier turns run as, inside the OpenCode card.
 *  The install button exists only while no runtime is detected; a finished install
 *  relaunches the app, so this card never claims a runtime this process cannot use. */
export function OpencodeFreeTierSection({
  status,
  install,
  onInstall,
}: {
  status: FreeTierStatus;
  install?: BunInstall | null;
  onInstall?: () => void;
}) {
  const installing = install?.phase === "downloading" || install?.phase === "extracting";
  const failure = install?.phase === "done" && !install.ok ? install.reason : null;
  return (
    <>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.freeTierRuntime")}</div>
          <div className="h" title={status.ready ? status.bun.command : undefined}>
            {status.ready
              ? t("settings.freeTierReady")
              : status.relayEnabled
                ? failure
                  ? t("settings.freeTierInstallFailed", { error: failure })
                  : t("settings.freeTierMissing")
                : t("settings.freeTierDisabled")}
          </div>
        </div>
        {!status.ready && status.relayEnabled ? (
          <button type="button" className="btn" onClick={onInstall} disabled={installing}>
            {installing ? t("settings.freeTierInstalling") : t("settings.freeTierInstall")}
          </button>
        ) : null}
      </div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.freeTierAccount")}</div>
          <div className="h">
            {status.credential === "harness"
              ? t("settings.freeTierSignedIn")
              : status.credential === "app"
                ? t("settings.freeTierAppAccount")
                : t("settings.freeTierAnonymous")}
          </div>
        </div>
      </div>
    </>
  );
}

/** One collapsible card on the Models page. The header toggles a body that reads top to
 *  bottom: the provider's own settings and sign-in first, its model list below, so the
 *  list gets the card's full width. Cards without a model list (the search engines)
 *  render the settings block alone. */
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
        <div className="provider-body">
          <div className="provider-col provider-settings-col">{settings}</div>
          {models ? <div className="provider-col provider-models-col">{models}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

/** A provider card gated on its declaration: deleting a provider file removes the card
 *  instead of rendering one with a blank title. Keyed on the declaration rather than the
 *  picker, so a `picker: false` provider (Ollama) still owns its card. */
function DeclaredProviderCard({
  group,
  ...card
}: { group: ModelCatalogGroupKey } & Omit<ComponentProps<typeof ProviderCard>, "title">) {
  const spec = providerForModelGroup(group);
  if (!spec) return null;
  return <ProviderCard title={t(spec.groupLabelKey as TKey)} {...card} />;
}

/** Collapsible card whose header carries its own actions: the MCP server cards and the
 *  search engine cards share it, so activating a header control never expands or
 *  collapses the card. */
function HeadActionCard({
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
  // A card that becomes the selected one opens itself, so switching engines reveals
  // that engine's own fields. Collapsing it afterwards sticks: `defaultOpen` only
  // changes when the selection does.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
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
        <div className="provider-body">
          <div className="provider-col">{children}</div>
        </div>
      ) : null}
    </section>
  );
}

/** A card-title qualifier: the short note a Settings card appends to its title, in the
 *  two tones the card titles use. */
function TitleNote({ tone, children }: { tone?: "accent"; children: ReactNode }) {
  return (
    <span
      style={{
        color: tone === "accent" ? "var(--accent)" : "var(--muted)",
        marginLeft: 6,
        fontSize: "var(--fs-11)",
      }}
    >
      {children}
    </span>
  );
}

/** The destructive segment a Settings card uses to drop a capability, shared by the MCP
 *  server, plugin and skill cards so all three remove the same way. */
function RemoveAction({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <div className="seg-ctrl">
      <button type="button" className="mcp-remove" onClick={onRemove}>
        {label}
      </button>
    </div>
  );
}

/** The Enable/Disable pair a Settings card uses to flip a capability's DEFAULT: an MCP
 *  server and a plugin answer the same click the same way, and a new chat's picker reads
 *  whichever one wrote it. */
function DefaultToggle({
  disabled,
  onChange,
}: {
  disabled: boolean;
  onChange: (disabled: boolean) => void;
}) {
  return (
    <div className="seg-ctrl">
      <button type="button" data-on={!disabled} onClick={() => onChange(false)}>
        {t("settings.mcpEnable")}
      </button>
      <button type="button" data-on={disabled} onClick={() => onChange(true)}>
        {t("settings.mcpDisable")}
      </button>
    </div>
  );
}

/** Rows a model list measures up front. Beyond it the labels are fitted as they scroll
 *  into view, which is what keeps a live catalog (OpenRouter ~470 ids, the Experiential
 *  gateway ~320) from laying every row out when its card opens. */
const LAZY_FIT_ROWS = 40;

/** Rows inside the scroll box's own height, plus a row of slack: they are on screen the
 *  moment the card opens, so they fit straight away instead of clipping for a frame. */
const EAGER_FIT_ROWS = 8;

/** The left column of a provider card: a scrollable list of that provider's
 *  models, each toggleable in/out of `enabledModels` via the corner button.
 *  `onSelect` (chat models only) makes a card clickable to set the default
 *  model; omit the handlers for a read-only list. */
function ModelList({
  provider,
  models,
  enabledSet,
  currentModel,
  acceptsImages,
  onToggle,
  onSetAll,
  onSelect,
}: {
  /** The provider whose card this is: its declaration decides each row's price, and
   *  a bare id in this list belongs to it even when another provider also serves it. */
  provider?: string;
  models: readonly string[];
  enabledSet: ReadonlySet<string>;
  currentModel: string;
  acceptsImages: (id: string) => boolean;
  onToggle?: (id: string) => void;
  onSetAll?: (enabled: boolean) => void;
  onSelect?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  // A card's rows re-price at the declared window flip, like the composer's pills.
  const rateNow = useRateClock();
  const enabledCount = models.filter((id) => enabledSet.has(id)).length;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? models.filter(
        (id) =>
          modelWireName(id).toLowerCase().includes(needle) || id.toLowerCase().includes(needle),
      )
    : models;
  // A live catalog can arrive with hundreds of ids. Past this many rows the list stops
  // pre-measuring labels and fits each row as it scrolls in, so the browser can keep
  // skipping off-screen rows; a short list fits immediately and never flashes.
  const deferFit = shown.length > LAZY_FIT_ROWS;
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
        {shown.map((id, index) => {
          const enabled = enabledSet.has(id);
          // The card header already names the provider, so the id drops its prefix.
          const displayName = modelWireName(id);
          const cost = providerModelCost(provider, id, rateNow);
          return (
            <div
              key={id}
              className="mcard"
              data-model={id}
              data-on={currentModel === id}
              data-disabled={onToggle ? !enabled : undefined}
              data-static={!onToggle ? "true" : undefined}
              onClick={onSelect ? () => onSelect(id) : undefined}
              onKeyDown={onSelect ? activationHandler(() => onSelect(id)) : undefined}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
            >
              <div className="nm">
                <FitText
                  text={displayName}
                  className="model-name"
                  title={id}
                  deferUntilVisible={deferFit && index >= EAGER_FIT_ROWS}
                />
                <CostBadge cost={cost} />
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

function ProviderSettingRow({
  providerId,
  setting,
  value,
  onSave,
}: {
  providerId: string;
  setting: ProviderSettingSpec;
  value?: string;
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <DeclaredSettingRow
      setting={setting}
      value={value}
      placeholder={setting.kind === "url" ? providerDefaultEndpoint(providerId) : undefined}
      onSave={(next) => onSave({ providerSettings: { [providerId]: { [setting.key]: next } } })}
    />
  );
}

export function ProviderSettingFields({
  providerId,
  settings,
  onSave,
}: {
  providerId: string;
  settings?: ProviderSettingsMap;
  onSave: (patch: SettingsPatch) => void;
}) {
  const spec = providerSpec(providerId);
  if (!spec) return null;
  return (
    <>
      {spec.settings
        .filter((setting) => setting.kind === "secret" || setting.editable)
        .map((setting) => (
          <ProviderSettingRow
            key={setting.key}
            providerId={providerId}
            setting={setting}
            value={settings?.[providerId]?.[setting.key]}
            onSave={onSave}
          />
        ))}
    </>
  );
}

/** A card's live model list: what it is, and why the last fetch failed. The list
 *  refreshes itself (opening this page re-queries every source), so there is no
 *  refresh control to remember. */
function ProviderCatalogRow({ label, hint }: { label: string; hint: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">{hint}</div>
      </div>
    </div>
  );
}

/** The live catalogs a settings page already holds, for `modelDisplayLabel`: both
 *  provider-spanning enums (default model, backup models) tag their options. */
function settingsProviderHints(
  settings: SettingsType,
  opencodeModels?: string[],
): Record<string, readonly string[]> {
  return modelProviderHints({
    providerCatalogs: settings.providerCatalogs,
    discoveredAntigravityModels: settings.antigravityOAuth?.models,
    opencodeModels,
  });
}

function PageModels({
  settings,
  onSave,
  ollamaModels,
  ollamaModelsError,
  ollamaPlan,
  ollamaHiddenCount,
  ollamaVisionModels,
  opencodeModels,
  opencodeModelsError,
  opencodeVisionModels,
  oauthSignedIn,
  oauthAccount,
  oauthFlowError,
  oauthWaiting,
  onOAuthBegin,
  onOAuthCancel,
  onOAuthSignOut,
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
  freeTierStatus,
  bunInstall,
  onInstallBun,
  mimoOAuthWaiting,
  onMiMoOAuthBegin,
  onMiMoOAuthCancel,
  onMiMoOAuthSignOut,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
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
  opencodeModels?: string[];
  opencodeModelsError?: string;
  opencodeVisionModels?: ReadonlySet<string>;
  oauthSignedIn: boolean;
  oauthAccount?: string;
  oauthFlowError?: string;
  oauthWaiting: boolean;
  onOAuthBegin: () => void;
  onOAuthCancel: () => void;
  onOAuthSignOut: () => void;
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
  /** Free-tier runtime readiness and the account its turns run as, shown in the OpenCode card. */
  freeTierStatus?: FreeTierStatus | null;
  /** Latest Bun install phase for the OpenCode card's own install action. */
  bunInstall?: BunInstall | null;
  onInstallBun?: () => void;
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
  // This enum spans every provider, so each option names its own.
  const providerHints = settingsProviderHints(settings, opencodeModels);

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
  /** A card's model column: the row's own provider prices its rows, so the card hands
   *  down the group it renders rather than letting the list guess from bare ids. */
  const modelColumn = (group: ModelCatalogGroupKey, ids: readonly string[], selectable = true) => (
    <ModelList
      provider={providerForModelGroup(group)?.id}
      models={ids}
      enabledSet={enabledSet}
      currentModel={settings.model}
      acceptsImages={catalog.acceptsImages}
      onToggle={toggleEnabled}
      onSetAll={(enabled) => setProviderEnabled(ids, enabled)}
      onSelect={selectable ? (id) => onSave({ model: id }) : undefined}
    />
  );
  /** A provider card with no auth section: its declared fields, nothing else. */
  const providerCard = (id: ModelCatalogGroupKey) => (
    <DeclaredProviderCard
      group={id}
      defaultOpen={false}
      models={modelColumn(id, groupModels(id))}
      settings={
        <ProviderSettingFields
          providerId={id}
          settings={settings.providerSettings}
          onSave={onSave}
        />
      }
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
                  {modelDisplayLabel(id, providerHints)}
                </option>
              ))
            )}
          </select>
        </div>
        <div className="h">{t("settings.modelVisibilityHint")}</div>
      </div>

      {HAS_DECLARED_PROVIDERS ? null : <div className="h">{t("settings.noProvidersDeclared")}</div>}

      {providerCard("deepseek")}

      <DeclaredProviderCard
        group="openai"
        defaultOpen={false}
        models={modelColumn("openai", groupModels("openai"))}
        settings={
          <>
            <ProviderSettingFields
              providerId="openai"
              settings={settings.providerSettings}
              onSave={onSave}
            />
            <OpenAISection
              signedIn={oauthSignedIn}
              account={oauthAccount}
              flowError={oauthFlowError}
              waiting={oauthWaiting}
              onBegin={onOAuthBegin}
              onCancel={onOAuthCancel}
              onSignOut={onOAuthSignOut}
            />
          </>
        }
      />

      {providerCard("zai")}

      <DeclaredProviderCard
        group="mimo"
        defaultOpen={false}
        models={modelColumn("mimo", groupModels("mimo"))}
        settings={
          <>
            <ProviderSettingFields
              providerId="mimo"
              settings={settings.providerSettings}
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

      {providerCard("experiential")}

      {providerCard("synthetic")}

      {providerCard("openrouter")}

      {providerCard("gemini-api")}

      <DeclaredProviderCard
        group="opencode"
        defaultOpen={false}
        models={modelColumn("opencode", groupModels("opencode"))}
        settings={
          <>
            <ProviderSettingFields
              providerId="opencode"
              settings={settings.providerSettings}
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
            />
            {freeTierStatus ? (
              <OpencodeFreeTierSection
                status={freeTierStatus}
                install={bunInstall}
                onInstall={onInstallBun}
              />
            ) : null}
            <ProviderCatalogRow
              label={providerString("opencode", "modelsLabel") ?? ""}
              hint={
                opencodeModelsError
                  ? (providerString("opencode", "modelsError", { error: opencodeModelsError }) ??
                    t("composer.modelError", { error: opencodeModelsError }))
                  : (providerString("opencode", "modelsHint") ?? "")
              }
            />
          </>
        }
      />

      <DeclaredProviderCard
        group="local"
        defaultOpen={false}
        models={modelColumn("local", groupModels("local"))}
        settings={
          <>
            <ProviderSettingFields
              providerId="local"
              settings={settings.providerSettings}
              onSave={onSave}
            />
            <ProviderCatalogRow
              label={providerString("local", "modelsLabel") ?? t("settings.ollamaModels")}
              hint={
                settings.providerCatalogs?.local?.error ??
                providerString("local", "modelsHint") ??
                ""
              }
            />
          </>
        }
      />

      <DeclaredProviderCard
        group="ollama"
        defaultOpen={false}
        models={modelColumn("ollama", ollamaList)}
        settings={
          <>
            <ProviderSettingFields
              providerId="ollama"
              settings={settings.providerSettings}
              onSave={onSave}
            />
            <ProviderCatalogRow
              label={t("settings.ollamaModels")}
              hint={
                ollamaModelsError
                  ? (providerString("ollama", "modelsError", { error: ollamaModelsError }) ??
                    t("composer.modelError", { error: ollamaModelsError }))
                  : t("settings.ollamaModelsHint")
              }
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

      <DeclaredProviderCard
        group="antigravity"
        defaultOpen={false}
        models={modelColumn("antigravity", groupModels("antigravity"))}
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

/** Open a sign-in URL in the system browser once per distinct value. Both browser flows
 *  hand their authorize URL to the UI, and landing the same one twice would open a second
 *  consent tab. */
function useAutoOpenUrl(url: string | undefined): void {
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!url || opened.current === url) return;
    opened.current = url;
    openExternal(url);
  }, [url]);
}

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
          onClick={() => openExternal(mail.verificationUrl!)}
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
        fontSize: "var(--fs-11)",
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
  // The row's closed select shows its option text, so each option names its provider.
  const providerHints = settingsProviderHints(settings, opencodeModels);
  const save = (next: string[]): void => onSave({ fallbackModels: next });
  const move = (from: number, to: number): void => save(moveInList(list, from, to));
  const firstUnused = options
    .flatMap((group) => [...group.models])
    .find((model) => !list.includes(model));

  return (
    <section className="section">
      <div className="h" style={{ marginBottom: 12 }}>
        {t("settings.fallbacksHint")}
      </div>

      {list.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: "var(--fs-12)", marginBottom: 12 }}>
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
                    {`${modelDisplayLabel(id, providerHints)}${t("settings.fallbackNotEnabledSuffix")}`}
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
                        {modelDisplayLabel(model, providerHints)}
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

/** Sign-in control for one HTTP/SSE server. Shared by the MCP list and every plugin card,
 *  so the two surfaces offer the same states and can never drift. */
function ServerAuthRow({
  name,
  transport,
  auth,
  live,
  onConnect,
  onCancel,
  onDisconnect,
}: {
  name: string;
  transport: McpSpecInfo["transport"];
  auth: McpAuthState | undefined;
  live: McpAuthStatus | null;
  onConnect: () => void;
  onCancel: () => void;
  onDisconnect: () => void;
}) {
  const event = live?.name === name ? live : null;
  const browserUrl = event?.phase === "browser" ? event.verificationUrl : undefined;
  useAutoOpenUrl(browserUrl);
  if (transport === "stdio") return null;
  const waiting = event?.phase === "starting" || event?.phase === "browser";
  const signedIn = auth === "connected";
  const label = waiting
    ? t("settings.mcpSignInWaiting")
    : signedIn
      ? t("settings.mcpSignedIn")
      : auth === "expired"
        ? t("settings.mcpSignInExpired")
        : null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontSize: "var(--fs-11)",
            color: signedIn ? "var(--accent)" : "var(--muted)",
          }}
        >
          {label}
        </span>
        <span className="grow" />
        {waiting ? (
          <button type="button" className="btn" onClick={onCancel}>
            {t("settings.mcpSignInCancel")}
          </button>
        ) : signedIn ? (
          <button type="button" className="btn ghost" onClick={onDisconnect}>
            {t("settings.mcpSignOut")}
          </button>
        ) : (
          <button type="button" className="btn" onClick={onConnect}>
            {t("settings.mcpSignIn")}
          </button>
        )}
      </div>
      {event?.phase === "error" && event.message ? (
        <div className="desc" style={{ color: "var(--danger)", marginTop: 4 }}>
          {event.message}
        </div>
      ) : null}
    </div>
  );
}

/** One server's tools, folded behind their count: a server can bridge dozens, and the
 *  card already answers whether it is connected. */
function McpToolList({ tools }: { tools: string[] }) {
  const [open, setOpen] = useState(false);
  const names = [...new Set(tools.map((tool) => tool.trim()).filter((tool) => tool !== ""))].sort();
  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        className="btn ghost"
        style={{ fontSize: "var(--fs-11)", paddingLeft: 0 }}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <I.chevR size={12} style={{ transform: open ? "rotate(90deg)" : "none" }} />
        {t("settings.mcpToolsLabel", { count: names.length })}
      </button>
      {open ? (
        names.length === 0 ? (
          <div style={{ marginTop: 4, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
            {t("settings.mcpToolsEmpty")}
          </div>
        ) : (
          <div
            style={{
              marginTop: 6,
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              minWidth: 0,
            }}
          >
            {names.map((tool) => (
              <code
                key={tool}
                style={{
                  maxWidth: "100%",
                  overflowWrap: "anywhere",
                  fontSize: "var(--fs-11)",
                  background: "var(--panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "1px 6px",
                  color: "var(--fg-2)",
                }}
              >
                {tool}
              </code>
            ))}
          </div>
        )
      ) : null}
    </div>
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
  mcpAuth,
  onConnectServer,
  onCancelServerSignIn,
  onDisconnectServer,
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
  mcpAuth: McpAuthStatus | null;
  onConnectServer: (name: string) => void;
  onCancelServerSignIn: (name: string) => void;
  onDisconnectServer: (name: string) => void;
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
  useAutoOpenUrl(gmailBrowserUrl);
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
  const builds = extensionStatus?.installs ?? null;
  const extensionMode = mode === "extension";
  const installRunning = browserInstall?.phase === "running";
  const installingBrowser = installRunning ? browserInstall.browser : null;
  // Servers a plugin ships are listed on that plugin's card in Settings > Plugins, so the
  // flat list stays the servers someone configured here.
  const ownSpecs = specs.filter((s) => !s.plugin);
  const playwrightSpec = ownSpecs.find((s) => s.name === "playwright");
  let connection: { text: string; color: string } | null = null;
  if (playwrightSpec) {
    connection = serverStatusLabel(
      playwrightSpec.disabled ? "disabled" : playwrightSpec.status,
      playwrightSpec.statusReason,
      playwrightSpec.toolCount,
    );
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
            <option key={browser} value={browser} disabled={isBuildMissing(builds, browser)}>
              {modeLabel(browser)}
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
                openExternal(extensionStatus.storeUrl, program);
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
      </div>
      <div style={{ marginTop: 8, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
        {extensionStatus
          ? extensionStatus.server.configured
            ? `✓ ${t("settings.mcpConfiguredMode", { mode: configuredMode ? modeLabel(configuredMode) : "…" })}${
                extensionMode && extensionStatus.server.tokenPrefix
                  ? ` · ${t("settings.mcpTokenSaved")}`
                  : ""
              }`
            : t("settings.mcpConfiguredNo")
          : "…"}
      </div>
      <div className="mcp-builds">
        <div className="mcp-builds-head">{t("settings.mcpBuildStateLabel")}</div>
        {PLAYWRIGHT_MANAGED_BROWSERS.map((browser) => {
          const state = buildDisplayState(builds, browser, installingBrowser);
          const missing = state === "missing";
          return (
            <div key={browser} className="mcp-build-row" data-missing={missing}>
              <span className="mcp-build-name">{modeLabel(browser)}</span>
              <span className="mcp-build-side">
                <span className="mcp-build-state">{t(BUILD_STATE_LABEL_KEYS[state])}</span>
                {state === "installing" ? (
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => onCancelBrowserInstall(browser)}
                  >
                    {t("settings.mcpBrowserInstallCancel")}
                  </button>
                ) : missing ? (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => onInstallBrowser(browser)}
                  >
                    {t("settings.mcpBrowserInstall", { browser: modeLabel(browser) })}
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {connection ? (
        <div style={{ marginTop: 4, fontSize: "var(--fs-11)", color: connection.color }}>
          {connection.text}
          {playwrightSpec?.status === "failed" &&
          /Node\.js is outdated/i.test(playwrightSpec.statusReason ?? "") ? (
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn secondary sm"
                onClick={() => openExternal("https://nodejs.org")}
              >
                {t("settings.mcpOutdatedNodeUpdateBtn")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {installRunning ? (
        <div className="playwright-download-box">
          <output style={{ marginBottom: 4, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
            {t("settings.mcpBrowserInstalling", { browser: modeLabel(browserInstall.browser) })} ·{" "}
            <span>
              {browserInstall.source === "backup"
                ? t("settings.mcpBrowserDownloadBackup")
                : t("settings.mcpBrowserDownloadOfficial")}
            </span>
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
      {browserInstall?.phase === "done" ? (
        <div
          style={{
            marginTop: 4,
            fontSize: "var(--fs-11)",
            color: browserInstall.ok ? "var(--accent)" : "var(--danger)",
          }}
        >
          {browserInstall.ok
            ? t("settings.mcpBrowserInstallOk", { browser: modeLabel(browserInstall.browser) })
            : `✗ ${browserInstall.reason ?? t("settings.mcpBrowserInstallFailed")}`}
        </div>
      ) : null}
      {extensionMode && extensionCheck?.phase === "running" ? (
        <div style={{ marginTop: 4, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
          {t("settings.mcpTestRunning")}
        </div>
      ) : extensionCheck?.phase === "done" ? (
        <div
          style={{
            marginTop: 4,
            fontSize: "var(--fs-11)",
            color: extensionCheck.ok ? "var(--accent)" : "var(--danger)",
          }}
        >
          {extensionCheck.ok
            ? t("settings.mcpTestOk", { ms: extensionCheck.elapsedMs })
            : `✗ ${extensionCheck.reason ?? t("settings.mcpTestFailed")}`}
        </div>
      ) : null}
      {extensionMode || mode === "cdp" ? (
        <div style={{ marginTop: 4, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
          {t(extensionMode ? "settings.mcpTokenHint" : "settings.mcpCdpHint")}
        </div>
      ) : null}
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
            <label style={{ fontSize: "var(--fs-11)", color: "var(--muted)" }}>
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
            <label style={{ fontSize: "var(--fs-11)", color: "var(--muted)" }}>
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
          <div style={{ marginTop: 4, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
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
              <div style={{ fontSize: "var(--fs-11)", color: "var(--muted)", marginBottom: 4 }}>
                {t("settings.outlookMailCodeLabel")}
              </div>
              <code style={{ fontSize: "var(--fs-18)", userSelect: "all" }}>{mail.userCode}</code>
            </div>
          ) : null}
          <MailStatusLine provider={MailProvider.Outlook} mail={mail} />
          <div style={{ marginTop: 4, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
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
          {t("settings.mcpConfigured", { count: ownSpecs.length })}
          {bridged ? (
            <span style={{ color: "var(--accent)", marginLeft: 8, fontSize: "var(--fs-11)" }}>
              {t("settings.mcpBridged")}
            </span>
          ) : (
            <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: "var(--fs-11)" }}>
              {t("settings.mcpNotBridged")}
            </span>
          )}
        </div>
        {ownSpecs.length === 0 ? (
          <div
            style={{
              padding: 16,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: "var(--fs-12)",
              color: "var(--muted)",
            }}
          >
            {t(specs.length > 0 ? "settings.mcpOnlyPluginServers" : "settings.mcpEmpty")}
          </div>
        ) : null}
        {ownSpecs.map((s) => {
          const removable = s.name !== null && !s.builtin;
          const canToggle = s.name !== null;
          const name = s.name;
          const setDisabled = (disabled: boolean) => {
            if (name !== null) onToggleServer(name, disabled);
          };
          const headActions =
            removable || canToggle ? (
              <>
                {removable ? (
                  <RemoveAction label={t("settings.mcpRemove")} onRemove={() => onRemove(s.raw)} />
                ) : null}
                {canToggle ? (
                  <DefaultToggle disabled={s.disabled === true} onChange={setDisabled} />
                ) : null}
              </>
            ) : null;
          return (
            <HeadActionCard
              key={s.raw}
              headActions={headActions}
              title={
                <>
                  {mcpServerLabel(s) || "(anonymous)"}
                  {s.builtin ? <TitleNote>· {t("settings.mcpBuiltinBadge")}</TitleNote> : null}
                </>
              }
            >
              <div className="sub mcp-spec-summary" title={s.summary}>
                {s.summary}
              </div>
              {name !== null ? (
                <ServerAuthRow
                  name={name}
                  transport={s.transport}
                  auth={s.auth}
                  live={mcpAuth}
                  onConnect={() => onConnectServer(name)}
                  onCancel={() => onCancelServerSignIn(name)}
                  onDisconnect={() => onDisconnectServer(name)}
                />
              ) : null}
              {s.parseError ? (
                <div className="desc" style={{ color: "var(--danger)" }}>
                  {t("settings.parseError", { error: s.parseError })}
                </div>
              ) : null}
              {s.tools ? (
                <McpToolList tools={s.tools} />
              ) : (
                <div style={{ marginTop: 8, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
                  {t("settings.mcpToolsUnavailable")}
                </div>
              )}
              {s.name === "playwright" ? playwrightSettings : null}
              {s.name !== null && /mail/i.test(s.name) ? (
                <div style={{ marginTop: 12 }}>{mailSettings}</div>
              ) : null}
            </HeadActionCard>
          );
        })}
        {!ownSpecs.some((s) => s.name === "playwright") ? (
          <HeadActionCard title={t("settings.mcpBrowserTitle")}>
            {playwrightSettings}
          </HeadActionCard>
        ) : null}
        {!ownSpecs.some((s) => s.name !== null && /mail/i.test(s.name)) ? (
          <HeadActionCard title={t("settings.mailTitle")}>{mailSettings}</HeadActionCard>
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

/** Settings > Plugins: install Codex-layout plugins and inspect what each one ships. */
export function PagePlugins({
  plugins,
  onInstall,
  onUninstall,
  onToggle,
  onRequest,
  mcpAuth,
  onConnectServer,
  onCancelServerSignIn,
  onDisconnectServer,
}: {
  plugins: PluginInfo[];
  onInstall: (source: string) => void;
  onUninstall: (name: string) => void;
  /** Edit one plugin's Settings default: what a new chat's picker starts from. */
  onToggle: (slug: string, disabled: boolean) => void;
  onRequest: () => void;
  mcpAuth: McpAuthStatus | null;
  onConnectServer: (name: string) => void;
  onCancelServerSignIn: (name: string) => void;
  onDisconnectServer: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");
  useInventoryRequest(onRequest);
  const submit = () => {
    const source = draft.trim();
    if (!source) return;
    onInstall(source);
    setDraft("");
  };
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.pluginsInstalled", { count: plugins.length })}</div>
        <div className="desc" style={{ marginBottom: 4 }}>
          {t("settings.pluginsPerSession")}
        </div>
        <div className="desc" style={{ marginBottom: 10, color: "var(--muted)" }}>
          {t("settings.capabilityRemovedNote")}
        </div>{" "}
        {plugins.length === 0 ? (
          <div
            style={{
              padding: 16,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: "var(--fs-12)",
              color: "var(--muted)",
            }}
          >
            {t("settings.pluginsEmpty")}
          </div>
        ) : null}
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.slug}
            plugin={plugin}
            onUninstall={onUninstall}
            onToggle={onToggle}
            mcpAuth={mcpAuth}
            onConnectServer={onConnectServer}
            onCancelServerSignIn={onCancelServerSignIn}
            onDisconnectServer={onDisconnectServer}
          />
        ))}
      </section>
      <section className="section">
        <div className="stitle">{t("settings.pluginsInstallSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.pluginsInstallLabel")}</div>
            <div className="h">{hintNodes(t("settings.pluginsInstallHint"))}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              aria-label={t("settings.pluginsInstallLabel")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("settings.pluginsInstallPlaceholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={submit}>
              {t("settings.pluginsInstallButton")}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

/** One installed plugin: its manifest facts, skills and MCP servers, plus its Settings
 *  default and removal. */
function PluginCard({
  plugin,
  onUninstall,
  onToggle,
  mcpAuth,
  onConnectServer,
  onCancelServerSignIn,
  onDisconnectServer,
}: {
  plugin: PluginInfo;
  onUninstall: (name: string) => void;
  onToggle: (slug: string, disabled: boolean) => void;
  mcpAuth: McpAuthStatus | null;
  onConnectServer: (name: string) => void;
  onCancelServerSignIn: (name: string) => void;
  onDisconnectServer: (name: string) => void;
}) {
  const byline = [plugin.author, plugin.license, plugin.source].filter(Boolean).join(" | ");
  const headActions = (
    <>
      <RemoveAction label={t("settings.pluginsRemove")} onRemove={() => onUninstall(plugin.slug)} />
      <DefaultToggle
        disabled={plugin.disabled === true}
        onChange={(disabled) => onToggle(plugin.slug, disabled)}
      />
    </>
  );
  return (
    <HeadActionCard
      title={
        <>
          {plugin.displayName}
          <TitleNote>- {pluginQualifier(plugin)}</TitleNote>
          {plugin.disabled ? <TitleNote>- {t("settings.pluginsOffByDefault")}</TitleNote> : null}
          {plugin.active ? (
            <TitleNote tone="accent">- {t("settings.pluginsActiveHere")}</TitleNote>
          ) : null}
        </>
      }
      headActions={headActions}
    >
      <div className="sub">{plugin.description ?? t("settings.pluginsNoDescription")}</div>
      {plugin.error ? (
        <div className="desc" style={{ color: "var(--danger)" }}>
          {t("settings.pluginsManifestError", { error: plugin.error })}
        </div>
      ) : null}
      {byline ? (
        <div style={{ marginTop: 4, fontSize: "var(--fs-11)", color: "var(--muted)" }}>
          {byline}
        </div>
      ) : null}
      {plugin.capabilities.length > 0 ? (
        <div className="tools-list">
          {plugin.capabilities.map((capability) => (
            <span key={capability}>{capability}</span>
          ))}
        </div>
      ) : null}
      <div className="stitle" style={{ marginTop: 14 }}>
        {t("settings.pluginsSkills", { count: plugin.skills.length })}
      </div>
      {plugin.skills.length === 0 ? (
        <div className="desc">{t("settings.pluginsNoSkills")}</div>
      ) : (
        <PluginSkillList skills={plugin.skills} />
      )}
      <div className="stitle" style={{ marginTop: 14 }}>
        {t("settings.pluginsServers", { count: plugin.servers.length })}
      </div>
      {plugin.servers.length === 0 ? (
        <div className="desc">{t("settings.pluginsNoServers")}</div>
      ) : (
        <div className="plugin-subpanel">
          {plugin.servers.map((server) => {
            const status = serverStatusLabel(server.status, server.statusReason, server.toolCount);
            return (
              <div key={server.name}>
                <div style={{ display: "flex", gap: 8 }}>
                  <code style={{ fontSize: "var(--fs-11)" }}>{mcpServerLabel(server)}</code>
                  <span style={{ fontSize: "var(--fs-11)", color: "var(--muted)" }}>
                    {server.transport}
                  </span>
                  <span className="grow" />
                  <span style={{ fontSize: "var(--fs-11)", color: status.color }}>
                    {status.text}
                  </span>
                </div>
                <ServerAuthRow
                  name={server.name}
                  transport={server.transport}
                  auth={server.auth}
                  live={mcpAuth}
                  onConnect={() => onConnectServer(server.name)}
                  onCancel={() => onCancelServerSignIn(server.name)}
                  onDisconnect={() => onDisconnectServer(server.name)}
                />
                {server.tools ? <McpToolList tools={server.tools} /> : null}
              </div>
            );
          })}
        </div>
      )}
      {plugin.homepage ? (
        <div className="actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              openExternal(plugin.homepage as string);
            }}
          >
            {t("settings.pluginsOpenHomepage")}
          </button>
        </div>
      ) : null}
    </HeadActionCard>
  );
}

/** One plugin's skills, grouped by the directory that holds them, so a plugin shipping
 *  a hundred of them reads as a few groups instead of a hundred rows. */
function PluginSkillList({ skills }: { skills: PluginSkillInfo[] }) {
  const groups = new Map<string, PluginSkillInfo[]>();
  for (const skill of skills) {
    const bucket = groups.get(skill.root);
    if (bucket) bucket.push(skill);
    else groups.set(skill.root, [skill]);
  }
  return (
    <div className="plugin-subpanel plugin-subpanel-scroll">
      {[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([root, group]) => (
          <div key={root || "."}>
            <div className="skill-root" title={root}>
              {root ? <code>{root}</code> : t("settings.pluginsSkillRoot")}
            </div>
            {group.map((skill) => (
              <div key={skill.name} style={{ marginBottom: 8 }}>
                <code style={{ fontSize: "var(--fs-11)" }} title={skill.path}>
                  {skill.name}
                </code>
                <div style={{ fontSize: "var(--fs-11)", color: "var(--muted)", lineHeight: 1.5 }}>
                  {skill.description}
                </div>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/** Settings > Skills: install standalone SKILL.md workflows. A plugin's skills travel with
 *  the plugin, so they appear on that plugin's card instead of here. */
export function PageSkills({
  skills,
  onInstall,
  onUninstall,
  onRequest,
}: {
  skills: SkillInfo[];
  onInstall: (source: string) => void;
  /** Remove these skills: one id for a card, every member for an install that brought several. */
  onUninstall: (names: string[]) => void;
  onRequest: () => void;
}) {
  const [draft, setDraft] = useState("");
  useInventoryRequest(onRequest);
  const submit = () => {
    const source = draft.trim();
    if (!source) return;
    onInstall(source);
    setDraft("");
  };
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.skillsInstalled", { count: skills.length })}</div>
        <div className="desc" style={{ marginBottom: 4 }}>
          {t("settings.skillsPerSession")}
        </div>
        <div className="desc" style={{ marginBottom: 10, color: "var(--muted)" }}>
          {t("settings.capabilityRemovedNote")}
        </div>
        {skills.length === 0 ? (
          <div
            style={{
              padding: 16,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: "var(--fs-12)",
              color: "var(--muted)",
            }}
          >
            {hintNodes(t("settings.skillsEmpty"))}
          </div>
        ) : null}
        {groupSkills(skills).map((group) =>
          isSkillCollection(group) ? (
            <SkillGroupCard key={group.key} group={group} onUninstall={onUninstall} />
          ) : (
            <SkillCard
              key={group.key}
              skill={group.skills[0] as SkillInfo}
              onUninstall={onUninstall}
            />
          ),
        )}
      </section>
      <section className="section">
        <div className="stitle">{t("settings.skillsInstallSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.skillsInstallLabel")}</div>
            <div className="h">{hintNodes(t("settings.skillsInstallHint"))}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              aria-label={t("settings.skillsInstallLabel")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("settings.skillsInstallPlaceholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={submit}>
              {t("settings.skillsInstallButton")}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

/** What a skill declares and where its SKILL.md sits: the lines every skill surface shows,
 *  whether the skill is a card of its own or a row inside the card of its install. */
function SkillFacts({ skill }: { skill: SkillInfo }) {
  return (
    <div className="skill-facts">
      <div className="sub">{skill.description || t("settings.skillsNoDescription")}</div>
      {skill.error ? (
        <div className="desc" style={{ color: "var(--danger)" }}>
          {t("settings.skillsReadError", { error: skill.error })}
        </div>
      ) : null}
      <div className="path" title={skill.path}>
        <code>{skill.path}</code>
      </div>
    </div>
  );
}

/** One install that delivered several skills: the source is the card, its skills are the rows
 *  inside it, so a collection of twenty workflows is one card instead of twenty. */
function SkillGroupCard({
  group,
  onUninstall,
}: {
  group: SkillGroup<SkillInfo>;
  onUninstall: (names: string[]) => void;
}) {
  const count = group.skills.length;
  const on = group.skills.filter((skill) => skill.active).length;
  // A card that IS a group opens folded: the page then reads as the installs a user made, and
  // one click opens the skills of the install they want to inspect.
  return (
    <HeadActionCard
      title={
        <>
          {group.label}
          <TitleNote>- {t("settings.skillsGroupCount", { count })}</TitleNote>
          {on > 0 ? (
            <TitleNote tone="accent">- {t("settings.skillsGroupActive", { on, count })}</TitleNote>
          ) : null}
        </>
      }
      headActions={
        <RemoveAction
          label={t("settings.skillsRemoveGroup", { count })}
          onRemove={() => onUninstall(group.skills.map((skill) => skill.id))}
        />
      }
      defaultOpen={false}
    >
      <div className="sub">
        {group.source
          ? t("settings.skillsGroupSource", { source: group.source })
          : t("settings.skillsGroupInferred")}
      </div>
      <div className="plugin-subpanel plugin-subpanel-scroll" style={{ marginTop: 8 }}>
        {group.skills.map((skill) => (
          <div key={skill.id} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ fontSize: "var(--fs-11)" }}>{skill.name}</code>
              {skill.active ? (
                <span style={{ fontSize: "var(--fs-11)", color: "var(--accent)" }}>
                  {t("settings.skillsActiveHere")}
                </span>
              ) : null}
              <span className="grow" />
              <RemoveAction
                label={t("settings.skillsRemove")}
                onRemove={() => onUninstall([skill.id])}
              />
            </div>
            <SkillFacts skill={skill} />
          </div>
        ))}
      </div>
    </HeadActionCard>
  );
}

/** One installed standalone skill: what it declares, where it lives, and removal. */
function SkillCard({
  skill,
  onUninstall,
}: {
  skill: SkillInfo;
  onUninstall: (names: string[]) => void;
}) {
  const headActions = (
    <RemoveAction label={t("settings.skillsRemove")} onRemove={() => onUninstall([skill.id])} />
  );
  return (
    <HeadActionCard
      title={
        <>
          {skill.name}
          <TitleNote>- {skill.id}</TitleNote>
          {skill.active ? (
            <TitleNote tone="accent">- {t("settings.skillsActiveHere")}</TitleNote>
          ) : null}
        </>
      }
      headActions={headActions}
    >
      <SkillFacts skill={skill} />
    </HeadActionCard>
  );
}

function PageShortcuts() {
  const rows: { nm: string; keys: ShortcutKey[] }[] = [
    { nm: t("settings.shortcutSend"), keys: ["enter"] },
    { nm: t("settings.shortcutNewline"), keys: ["shift", "enter"] },
    { nm: t("settings.shortcutNewChat"), keys: ["mod", "N"] },
    { nm: t("settings.shortcutNewTab"), keys: ["mod", "T"] },
    { nm: t("settings.shortcutCloseTab"), keys: ["mod", "W"] },
    { nm: t("settings.shortcutFocusComposer"), keys: ["mod", "L"] },
    { nm: t("settings.shortcutQuickSend"), keys: ["mod", "Q"] },
    { nm: t("settings.shortcutQuickSendQueue"), keys: ["mod", "1-9"] },
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

/** About: the version and update check, then the two reference lists that used to be pages of
 *  their own. */
function PageAbout({
  changelog,
  onRefreshChangelog,
}: {
  changelog: ChangelogState;
  onRefreshChangelog: (force?: boolean) => void;
}) {
  return (
    <div className="page-about">
      <SettingsSection id="version" labelKey="settings.aboutVersion">
        <AboutPanel />
      </SettingsSection>
      <SettingsSection id="shortcuts" labelKey="settings.aboutShortcuts">
        <PageShortcuts />
      </SettingsSection>
      <SettingsSection id="changelog" labelKey="settings.aboutChangelog">
        <PageChangelog changelog={changelog} onRefresh={onRefreshChangelog} />
      </SettingsSection>
    </div>
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

/** The picker's order: light styles first, then dark, each group keeping the palette's own
 *  order. Sorting is stable, so the palette decides within a group. */
const THEME_STYLE_ORDER: ReadonlyArray<ThemeStyle> = [...THEME_STYLES].sort(
  (a, b) => Number(themeForStyle(a) === THEME.DARK) - Number(themeForStyle(b) === THEME.DARK),
);

/** Customization: one page holding the app's look and its sound. Appearance carries the
 *  controls that used to sit on the General page, Themes the style picker that used to sit in
 *  the status bar, and Sound cues the pack cards that used to be a page of their own. */
function PageCustomization({
  textSizePx,
  onSetTextSize,
  themeStyle,
  onSetThemeStyle,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  onResetWindowState,
  settings,
  onSave,
  onPickSound,
  onCreatePack,
  onRemovePack,
}: {
  textSizePx: number;
  onSetTextSize: (size: number) => void;
  themeStyle: ThemeStyle;
  onSetThemeStyle: (style: ThemeStyle) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  onResetWindowState: () => void;
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  /** Opens the desktop file dialog for one cue's audio. */
  onPickSound: () => Promise<string | null>;
  onCreatePack: (draft: SoundPackDraft) => void;
  onRemovePack: (id: string) => void;
}) {
  const [customFontDraft, setCustomFontDraft] = useState(customFontFamily);
  useEffect(() => {
    setCustomFontDraft(customFontFamily);
  }, [customFontFamily]);
  const commitCustomFont = (value: string) => {
    const next = value.trim();
    setCustomFontDraft(next);
    onSetCustomFontFamily(next);
  };
  const packs = useMemo(() => mergeSoundPacks(settings.soundPacks), [settings.soundPacks]);
  const activeId = resolveSoundPackId(settings.soundPackId, packs);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Every card tests its own cues, so warm all packs on open: a test then plays on the
  // first click instead of only decoding the audio after it.
  useEffect(() => {
    for (const pack of packs) preloadSoundPack(pack.id);
  }, [packs]);
  return (
    <div className="page-customization">
      <SettingsSection id="appearance" labelKey="settings.appearanceSection">
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.textSize")}</div>
            <div className="h">{t("settings.textSizeHint")}</div>
          </div>
          <div
            className="text-size-control"
            // The readout rides above the knob, so it needs the knob's share of the track.
            style={
              {
                "--knob": `${((textSizePx - TEXT_SIZE_RANGE.min) / (TEXT_SIZE_RANGE.max - TEXT_SIZE_RANGE.min)) * 100}%`,
              } as CSSProperties
            }
          >
            <input
              type="range"
              min={TEXT_SIZE_RANGE.min}
              max={TEXT_SIZE_RANGE.max}
              step={TEXT_SIZE_RANGE.step}
              value={textSizePx}
              aria-label={t("settings.textSize")}
              onChange={(e) => onSetTextSize(clampTextSizePx(Number(e.target.value)))}
            />
            {/* After the input, so the readout can follow the slider's own state. */}
            <span className="text-size-value">{textSizePx} px</span>
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.fontFamily")}</div>
            <div className="h">{t("settings.fontFamilyHint")}</div>
          </div>
          <FontFamilyPicker value={fontFamily} onSelect={onSetFontFamily} />
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
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.windowState")}</div>
            <div className="h">{t("settings.windowStateHint")}</div>
          </div>
          <button type="button" className="btn small window-reset" onClick={onResetWindowState}>
            <I.refresh size={13} />
            <span>{t("settings.windowStateReset")}</span>
          </button>
        </div>
      </SettingsSection>

      <SettingsSection id="themes" labelKey="settings.customizationThemes">
        <div
          className="theme-grid"
          role="radiogroup"
          aria-labelledby={sectionHeadingId("themes")}
        >
          {THEME_STYLE_ORDER.map((style) => (
            <button
              key={style}
              type="button"
              role="radio"
              aria-checked={themeStyle === style}
              className="theme-pop-item"
              data-on={themeStyle === style}
              data-style={style}
              onClick={() => onSetThemeStyle(style)}
            >
              <span className="style-swatches" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="txt">
                <span className="nm">
                  {t(`settings.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}` as TKey)}
                </span>
                <span className="md">
                  {themeForStyle(style) === THEME.DARK
                    ? t("settings.themeDark")
                    : t("settings.themeLight")}
                </span>
              </span>
              {themeStyle === style ? <I.check size={13} /> : null}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection id="soundCues" labelKey="settings.customizationSoundCues">
        <div className="setting-row">
          <div className="l">
            <div className="h">{t("settings.soundSectionHint")}</div>
          </div>
          <button type="button" className="btn small" onClick={() => setWizardOpen(true)}>
            <I.plus size={12} /> {t("settings.soundPackNew")}
          </button>
        </div>
        {packs.map((pack) => (
          <SoundPackCard
            key={pack.id}
            pack={pack}
            active={pack.id === activeId}
            settings={settings}
            onSave={onSave}
            onSelect={() => onSave({ soundPackId: pack.id })}
            onRemove={() => {
              onRemovePack(pack.id);
              // The silent pack is the fallback the daemon resolves a dead selection to, so
              // make the UI show that immediately instead of on the next echo.
              if (pack.id === activeId) onSave({ soundPackId: NOTHING_SOUND_PACK_ID });
            }}
          />
        ))}
      </SettingsSection>
      <PackWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onPickSound={onPickSound}
        onCreate={onCreatePack}
      />
    </div>
  );
}

/** Range input with a local draft: dragging updates instantly and the value is
 *  committed once, on release. A fully controlled slider re-rendered from the
 *  daemon round-trip (settings_save → $settings) stutters and can snap back
 *  mid-drag, which is why it felt undraggable. Always draggable — the volume is
 *  set independently of whether the cue's sound is currently on. */
function CueVolumeSlider({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled?: boolean;
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
        disabled={disabled}
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

/** One card per sound pack: the pack's own copy sits inside, and the header carries the
 *  Active marker or the button that makes it the pack cues play through. Same shape as the
 *  search-engine cards. Only a pack the user created offers Remove; the shipped ones stay. */
function SoundPackCard({
  pack,
  active,
  onSelect,
  onRemove,
  settings,
  onSave,
}: {
  pack: SoundPackSpec;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  return (
    <HeadActionCard
      title={pack.label}
      defaultOpen={active}
      headActions={
        <>
          {active ? (
            <span className="card-active-pill">✓ {t("settings.activePill")}</span>
          ) : (
            <button type="button" className="btn small" onClick={onSelect}>
              {t("settings.soundPackUse")}
            </button>
          )}
          {pack.removable ? (
            <RemoveAction label={t("settings.soundPackRemove")} onRemove={onRemove} />
          ) : null}
        </>
      }
    >
      {pack.description ? <div className="card-hint">{pack.description}</div> : null}
      {pack.id === NOTHING_SOUND_PACK_ID ? null : (
        <PackCueTable pack={pack} settings={settings} onSave={onSave} />
      )}
    </HeadActionCard>
  );
}

/** One pack's own cue audio, edited in place: the pack keeps its sound switch and
 *  volume per cue, so switching packs restores that pack's tuning. A cue the pack does
 *  not ship stays listed but inert, so its coverage reads off the card. */
function PackCueTable({
  pack,
  settings,
  onSave,
}: {
  pack: SoundPackSpec;
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const byPack = settings.feedbackAudio ?? {};
  const stored = byPack[pack.id] ?? {};
  const patchCue = (id: FeedbackCueId, entry: FeedbackCueAudioSetting) => {
    onSave({ feedbackAudio: { ...byPack, [pack.id]: { ...stored, [id]: entry } } });
  };
  return (
    <table className="feedback-cues-table">
      <thead>
        <tr>
          <th>{t("settings.feedbackCueColCue")}</th>
          <th>{t("settings.feedbackCueColSound")}</th>
          <th>{t("settings.feedbackCueColVolume")}</th>
          <th>{t("settings.feedbackCueColTest")}</th>
        </tr>
      </thead>
      <tbody>
        {FEEDBACK_CUES.map(({ id, label }) => {
          const cueName = t(label);
          const shipped = pack.sounds[id] !== undefined;
          const { enabled, volume } = resolveFeedbackCueAudio(stored[id]);
          const test = t("settings.soundPackAudition", { cue: cueName, pack: pack.label });
          return (
            <tr key={id}>
              <td className="feedback-cue-name">
                <div className="n">{cueName}</div>
                {shipped ? null : <div className="h">{t("settings.soundPackCueMissing")}</div>}
              </td>
              <td>
                <div className="seg-ctrl">
                  <button
                    type="button"
                    disabled={!shipped}
                    aria-pressed={!enabled}
                    aria-label={t("settings.feedbackCueSoundDisable", { cue: cueName })}
                    data-on={!enabled}
                    onClick={() => patchCue(id, { enabled: false, volume })}
                  >
                    {t("settings.feedbackCueOff")}
                  </button>
                  <button
                    type="button"
                    disabled={!shipped}
                    aria-pressed={enabled}
                    aria-label={t("settings.feedbackCueSoundEnable", { cue: cueName })}
                    data-on={enabled}
                    onClick={() => patchCue(id, { enabled: true, volume })}
                  >
                    {t("settings.feedbackCueOn")}
                  </button>
                </div>
              </td>
              <td className="feedback-cue-volume">
                <CueVolumeSlider
                  label={t("settings.feedbackCueVolume", { cue: cueName })}
                  value={volume}
                  disabled={!shipped}
                  onCommit={(next) => patchCue(id, { enabled, volume: next })}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn sm"
                  disabled={!shipped}
                  title={test}
                  aria-label={test}
                  onClick={() => feedbackSounds.play(id, volume, pack.id)}
                >
                  <I.play size={13} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
