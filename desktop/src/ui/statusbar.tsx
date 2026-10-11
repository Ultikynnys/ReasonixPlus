import {
  DEEPSEEK_RATE_SCHEDULE,
  OLLAMA_RATE_SCHEDULE,
  ZAI_RATE_SCHEDULE,
  antigravityUsageView,
  codexUsageView,
  isOllamaPeakPricedModel,
  modelDisplayName,
  ollamaUsageView,
  opencodeUsageView,
  quotaWindowsSummary,
  zaiUsageView,
} from "@reasonix/core-utils";
import type { ProviderUsageView } from "@reasonix/core-utils";
import { useEffect, useRef, useState } from "react";
import type { Balance, Settings, UsageStats } from "../App";
import { t } from "../i18n";
import { I } from "../icons";
import { isOffPeak, minutesUntilRateChange, rateMultiplier } from "../peak-hours";
import type {
  AntigravityQuota,
  CodexQuota,
  JobInfo,
  OllamaQuota,
  OpencodeQuota,
  ZaiQuota,
} from "../protocol";
import { THEME, THEME_STYLES, type Theme, type ThemeStyle, themeForStyle } from "../theme";
import { hitPercent, tokenLabel } from "./format";
import { formatMoney } from "../money";
import { activationHandler } from "./keyboard";
import { localizeShortcutText } from "./shortcut";

/** "in 2h 15m" relative time until a quota window resets. */
function formatReset(d: Date): string {
  const diffMs = d.getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "-";
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** One chip for every quota-billed provider. Each provider normalizes to a
 *  ProviderUsageView, so the ribbon ("5h 70% · wk 88% left") renders through a
 *  single code path instead of one bespoke chip per provider. */
function QuotaChip({
  label,
  title,
  view,
  refreshing,
  planFallback,
  onRefresh,
}: {
  label: string;
  title: string;
  view: ProviderUsageView | null;
  refreshing?: boolean;
  planFallback: string;
  onRefresh?: () => void;
}) {
  return (
    <span
      className="seg"
      title={title}
      style={onRefresh ? { cursor: "pointer" } : undefined}
      onClick={onRefresh}
      onKeyDown={onRefresh ? activationHandler(onRefresh) : undefined}
    >
      <I.coin size={11} style={{ color: "var(--accent)" }} />
      <span>{label}</span>
      {view && view.windows.length > 0 ? (
        <>
          <span className="v acc">
            {quotaWindowsSummary(view.windows)} {t("statusbar.quotaLeft")}
          </span>
          <span className="conv">{view.plan ?? planFallback}</span>
        </>
      ) : refreshing ? (
        <span className="v acc">{t("statusbar.quotaRefreshing")}</span>
      ) : (
        <span className="v acc">-</span>
      )}
    </span>
  );
}

export function StatusBar({
  settings,
  balance,
  codexQuota,
  onRefreshCodexQuota,
  codexQuotaRefreshing,
  codexQuotaReason,
  ollamaQuota,
  onRefreshOllamaQuota,
  ollamaQuotaRefreshing,
  ollamaQuotaReason,
  ollamaPlan,
  antigravityQuota,
  onRefreshAntigravityQuota,
  antigravityQuotaRefreshing,
  antigravityQuotaReason,
  zaiQuota,
  onRefreshZaiQuota,
  zaiQuotaRefreshing,
  zaiQuotaReason,
  opencodeQuota,
  onRefreshOpencodeQuota,
  opencodeQuotaRefreshing,
  opencodeQuotaReason,
  usage,
  busy,
  ready,
  currency,
  theme,
  themeStyle,
  jobs,
  jobsOpen,
  onToggleJobs,
  onSetThemeStyle,
  onToggleCurrency,
  onOpenSettings,
  onOpenWorkdir,
}: {
  settings: Settings | null;
  balance: Balance | null;
  codexQuota: CodexQuota | null;
  onRefreshCodexQuota?: () => void;
  /** True between a chip click and the $codex_quota reply — renders a refresh indicator. */
  codexQuotaRefreshing?: boolean;
  /** Why the last quota fetch produced no data — appended to the chip tooltip. */
  codexQuotaReason?: string | null;
  /** Cloud Ollama usage — mirrors codexQuota for the Ollama provider. */
  ollamaQuota: OllamaQuota | null;
  onRefreshOllamaQuota?: () => void;
  ollamaQuotaRefreshing?: boolean;
  ollamaQuotaReason?: string | null;
  /** The account's Ollama plan (e.g. `free`) — labels the usage chip. */
  ollamaPlan?: string | null;
  /** Google Antigravity (Gemini Code Assist) plan + per-model usage. */
  antigravityQuota: AntigravityQuota | null;
  onRefreshAntigravityQuota?: () => void;
  antigravityQuotaRefreshing?: boolean;
  antigravityQuotaReason?: string | null;
  /** Z.AI GLM Coding Plan usage (5-hour + weekly) — mirrors the Ollama chip. */
  zaiQuota: ZaiQuota | null;
  onRefreshZaiQuota?: () => void;
  zaiQuotaRefreshing?: boolean;
  zaiQuotaReason?: string | null;
  /** OpenCode Go plan usage (5-hour + weekly + monthly) — mirrors the Z.AI chip. */
  opencodeQuota: OpencodeQuota | null;
  onRefreshOpencodeQuota?: () => void;
  opencodeQuotaRefreshing?: boolean;
  opencodeQuotaReason?: string | null;
  usage: UsageStats;
  busy: boolean;
  ready: boolean;
  currency: "CNY" | "USD";
  theme: Theme;
  themeStyle: ThemeStyle;
  jobs: JobInfo[];
  jobsOpen: boolean;
  onToggleJobs: () => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  onToggleCurrency: () => void;
  onOpenSettings: () => void;
  onOpenWorkdir?: (anchor: { bottom: number; left: number }) => void;
}) {
  const sessionPromptTokens =
    usage.totalPromptTokens || usage.cacheHitTokens + usage.cacheMissTokens;
  const liveContextTokens = usage.reservedTokens + usage.liveLogTokens;
  const totalTokens = Math.max(sessionPromptTokens, liveContextTokens);
  const cacheHitPct = hitPercent(usage.cacheHitTokens, usage.cacheMissTokens);
  // Shell-output filtering savings — current-session totals from the
  // $ctx_breakdown event. Undefined = this session has no shell telemetry yet,
  // so no chip at all (never a fake 0%).
  const outputSavedPct =
    usage.shellOutputRawTokens !== undefined && usage.shellOutputRawTokens > 0
      ? Math.round(
          ((usage.shellOutputRawTokens - (usage.shellOutputShownTokens ?? 0)) /
            usage.shellOutputRawTokens) *
            100,
        )
      : null;
  const runningJobs = jobs.filter((j) => j.running).length;
  // "This turn" for pay-per-token providers is the latest model call's cost,
  // NOT the cumulative session total (which feeds the settings session-cost card).
  const turnCost = formatMoney(usage.lastCallCostUsd ?? 0, currency);
  // Dual-currency: keep the primary display currency and show the conversion
  // to the other one right next to it (¥ primary → $ conversion by default).
  const turnCostOther = formatMoney(usage.lastCallCostUsd ?? 0, currency === "CNY" ? "USD" : "CNY");
  // Per-field visibility toggles — each defaults to true when absent from config.
  const showTurnCost = settings?.statusBar?.showTurnCost ?? true;
  const showSessionCost = settings?.statusBar?.showSessionCost ?? true;
  const showBalance = settings?.statusBar?.showBalance ?? true;
  const showCacheHit = settings?.statusBar?.showCacheHit ?? true;
  const showCtxUsage = settings?.statusBar?.showCtxUsage ?? true;
  // Session-total cost (the settings card's figure) — a distinct chip from the
  // per-turn "this turn" number, gated by showSessionCost. Quota-billed sessions
  // show their accumulated plan-window % (native unit) instead of a dollar
  // figure — never converted between providers.
  const sessionCostDisplay = formatMoney(usage.totalCostUsd, currency);
  const sessionCostOther = formatMoney(usage.totalCostUsd, currency === "CNY" ? "USD" : "CNY");
  // The tab's provider comes from the daemon-resolved endpoint info
  // (`ModelEndpointInfo.provider`), NEVER from the model name — a name doesn't
  // imply its provider (gpt-oss-* ids are served by Antigravity; custom gateway
  // ids can carry any shape). Absent endpoint info (pre-protocol daemons)
  // falls back to the resolver's DeepSeek default family.
  const ep = settings?.modelEndpoint;
  const provider = ep?.provider ?? "deepseek";
  const openaiTab = provider === "openai";
  const openaiTokenBilling = openaiTab && ep?.billingKind === "usd";
  const openaiQuotaBilling = openaiTab && !openaiTokenBilling;
  const ollamaTokenBilling = provider === "ollama" && ep?.billingKind === "usd";
  const ollamaQuotaBilling = provider === "ollama" && !ollamaTokenBilling;
  // Z.AI GLM Coding Plan tabs bill plan-window % (fetched from the monitor
  // endpoint), never dollars — the chip replaces the DeepSeek balance.
  const zaiQuotaBilling = provider === "zai";
  // Only Go-subscription OpenCode models bill plan-window % (fetched from the
  // Go usage endpoint); free/anon Zen has no usage API, so it gets a tier chip.
  const opencodeQuotaBilling = provider === "opencode" && ep?.opencodePlan === "go";
  const opencodeFreeBilling = provider === "opencode" && ep?.opencodePlan === "free";
  const sessionQuotaProvider =
    openaiQuotaBilling
      ? "openai"
      : provider === "gemini"
        ? provider
      : ollamaQuotaBilling
        ? "ollama"
        : zaiQuotaBilling
          ? "zai"
          : opencodeQuotaBilling
            ? "opencode"
            : null;
  const sessionQuotaCost =
    sessionQuotaProvider !== null ? usage.costByProvider?.[sessionQuotaProvider] : undefined;
  const sessionQuotaPct = sessionQuotaCost?.quotaUsedPct ?? null;
  const balanceLabel = balance
    ? `${balance.currency === "USD" ? "$" : "¥"} ${balance.total.toFixed(2)}`
    : "-";
  const connState = !ready ? "off" : busy ? "running" : "online";
  const apiHost =
    ep?.baseUrl?.replace(/^https?:\/\//, "") ??
    settings?.baseUrl?.replace(/^https?:\/\//, "") ??
    "api.deepseek.com";
  // Per-tab provider state: DeepSeek tabs show the DeepSeek endpoint, gpt-*
  // tabs show the OpenAI endpoint and its auth source (OAuth > static key > none).
  const openaiAuth = ep?.provider === "openai" ? (ep.openaiAuth ?? "none") : null;
  const oauthFlowError = openaiAuth !== null ? settings?.openaiOAuth?.flowError : undefined;
  const authFailed = openaiAuth !== null && !!oauthFlowError;
  const authLabel =
    openaiAuth === "oauth"
      ? t("statusbar.authOauth")
      : openaiAuth === "apiKey"
        ? t("statusbar.authKey")
        : openaiAuth === "none"
          ? t("statusbar.authNone")
          : null;
  let apiTitle =
    openaiAuth === "oauth"
      ? t("statusbar.apiOpenaiOauth", {
          baseUrl: ep?.baseUrl ?? "",
          account: ep?.oauthAccount ?? "",
        })
      : openaiAuth === "apiKey"
        ? t("statusbar.apiOpenaiKey", { baseUrl: ep?.baseUrl ?? "" })
        : openaiAuth === "none"
          ? t("statusbar.apiOpenaiNone", { baseUrl: ep?.baseUrl ?? "" })
          : ep?.provider === "ollama"
            ? t("statusbar.apiOllama", { baseUrl: ep.baseUrl })
            : ep?.provider === "opencode"
              ? `OpenCode · ${ep.baseUrl}`
              : `API · ${settings?.baseUrl ?? "api.deepseek.com"}`;
  if (authFailed) apiTitle += `\n${t("statusbar.oauthFailed", { message: oauthFlowError })}`;
  const dotDanger = connState === "off" || authFailed;
  const dotWarn = !dotDanger && openaiAuth === "none";
  // OpenAI tabs swap the balance / $ display for the API-reported weekly
  // Codex quota: % + credits left, and this turn's cost as % of the weekly
  // limit (delta between fetches — OpenAI reports no dollar amounts). The
  // swap follows the resolved provider, and even without quota data the
  // chips render an em dash + retry hint — the DeepSeek balance and $
  // amounts are meaningless on an OpenAI tab.
  const quota = codexQuota && openaiQuotaBilling ? codexQuota : null;
  const showQuota = !!quota;
  const quotaWeekly = quota?.weekly ?? null;
  const quotaFiveHour = quota?.fiveHour ?? null;
  // Official app-server format: windows carry remainingPercent (100 - usedPercent)
  // and an ISO resetsAt — the chip shows "% left" + plan, no credit amounts.
  const quotaLeftPct = quotaWeekly ? Math.round(quotaWeekly.remainingPercent) : 0;
  const quotaTurnPct = quota?.turnUsedPct ?? null;
  const ollamaQuotaData = ollamaQuota && ollamaQuotaBilling ? ollamaQuota : null;
  const ollamaWeekly = ollamaQuotaData?.weekly ?? null;
  const ollamaSession = ollamaQuotaData?.session ?? null;
  const ollamaTurnPct = ollamaQuotaData?.turnUsedPct ?? null;
  // The "set an API key" hint is correct ONLY when the key is genuinely absent
  // (the daemon flags that with the `ollama-no-api-key` reason). A keyed account
  // whose balance endpoint is unreachable, or a proxied/local endpoint with no
  // /api/balance, must never be told to set a key it already has.
  const ollamaKeyMissing = ollamaQuotaReason === "ollama-no-api-key";
  const ollamaQuotaTitle =
    ollamaQuotaData && ollamaWeekly
      ? t("statusbar.ollamaQuotaTitle", {
          left: Math.round(ollamaWeekly.remainingPct),
          weeklyResets: ollamaWeekly.resetsAt ? formatReset(new Date(ollamaWeekly.resetsAt)) : "-",
          session: ollamaSession ? Math.round(ollamaSession.remainingPct) : "-",
          sessionResets:
            ollamaSession?.resetsAt ? formatReset(new Date(ollamaSession.resetsAt)) : "-",
        })
      : ollamaQuotaData || (ollamaQuotaReason && !ollamaKeyMissing)
        ? t("statusbar.ollamaNoDataUnavailable")
        : t("statusbar.ollamaNoData");
  // Antigravity (Gemini Code Assist): plan + the active model's used fraction.
  const geminiTab = provider === "gemini";
  const deepseekTab = ep ? ep.provider === "deepseek" : provider === "deepseek";
  const zaiTab = ep?.provider === "zai";
  // Rate-period visibility follows daemon-resolved provider/deployment metadata.
  // Model matching only selects a price row after Ollama has already been resolved.
  const ollamaPeakPricing =
    ep?.provider === "ollama" &&
    ep.deployment === "cloud" &&
    ep.billingKind === "usd" &&
    isOllamaPeakPricedModel(settings?.model ?? "");
  const rateSchedule = ollamaPeakPricing
    ? OLLAMA_RATE_SCHEDULE
    : deepseekTab
      ? DEEPSEEK_RATE_SCHEDULE
      : zaiTab
        ? ZAI_RATE_SCHEDULE
        : null;
  const antigravityQuotaData = antigravityQuota && geminiTab ? antigravityQuota : null;
  const agActive =
    antigravityQuotaData?.windows.find((w) => w.modelId === settings?.model) ??
    antigravityQuotaData?.windows[0] ??
    null;
  const agRemainingPct =
    agActive && agActive.usedFraction < 1 ? Math.round((1 - agActive.usedFraction) * 100) : null;
  const antigravityQuotaTitle =
    antigravityQuotaData && agActive
      ? t("statusbar.antigravityQuotaTitle", {
          left: agRemainingPct ?? 0,
          plan:
            antigravityQuotaData.plan?.name ??
            antigravityQuotaData.plan?.tierId ??
            "Antigravity",
          resets: agActive.resetTime ? formatReset(new Date(agActive.resetTime)) : "-",
        })
      : t("statusbar.antigravityNoData");
  const antigravityQuotaTitleWithReason =
    !antigravityQuotaData && antigravityQuotaReason
      ? `${antigravityQuotaTitle}\n${t("statusbar.codexReason", { reason: antigravityQuotaReason })}`
      : antigravityQuotaTitle;
  // Z.AI GLM Coding Plan: the 5-hour window is the primary ribbon value (finer
  // resolution than weekly), falling back to weekly when the plan omits it.
  const zaiQuotaData = zaiQuota && zaiQuotaBilling ? zaiQuota : null;
  const zaiFiveHour = zaiQuotaData?.fiveHour ?? null;
  const zaiWeekly = zaiQuotaData?.weekly ?? null;
  const zaiWindow = zaiFiveHour ?? zaiWeekly ?? null;
  const zaiQuotaTitle =
    zaiQuotaData && (zaiFiveHour || zaiWeekly)
      ? zaiFiveHour && zaiWeekly
        ? t("statusbar.zaiQuotaDualTitle", {
            fiveHour: Math.round(zaiFiveHour.remainingPct),
            weekly: Math.round(zaiWeekly.remainingPct),
            resets: zaiWeekly.resetsAt ? new Date(zaiWeekly.resetsAt).toLocaleString() : "-",
            plan: zaiQuotaData.plan ?? "GLM Coding Plan",
          })
        : t("statusbar.zaiQuotaTitle", {
            left: Math.round(zaiWindow!.remainingPct),
            plan: zaiQuotaData.plan ?? "GLM Coding Plan",
          })
      : t("statusbar.zaiNoData");
  const zaiQuotaTitleWithReason =
    !zaiQuotaData && zaiQuotaReason
      ? `${zaiQuotaTitle}\n${t("statusbar.codexReason", { reason: zaiQuotaReason })}`
      : zaiQuotaTitle;
  // OpenCode Go plan usage: the 5-hour rolling window is the primary ribbon
  // value (finer resolution than weekly/monthly), falling back to weekly then
  // monthly for payloads that omit a window.
  const opencodeQuotaData = opencodeQuota && opencodeQuotaBilling ? opencodeQuota : null;
  const opencodeRolling = opencodeQuotaData?.rolling ?? null;
  const opencodeWeekly = opencodeQuotaData?.weekly ?? null;
  const opencodeMonthly = opencodeQuotaData?.monthly ?? null;
  const opencodePrimaryWindow = opencodeRolling ?? opencodeWeekly ?? opencodeMonthly ?? null;
  const opencodeQuotaTitle =
    opencodeQuotaData && opencodePrimaryWindow
      ? t("statusbar.opencodeQuotaTitle", {
          rolling: opencodeRolling ? Math.round(opencodeRolling.remainingPct) : "-",
          weekly: opencodeWeekly ? Math.round(opencodeWeekly.remainingPct) : "-",
          monthly: opencodeMonthly ? Math.round(opencodeMonthly.remainingPct) : "-",
        })
      : t("statusbar.opencodeNoData");
  const opencodeQuotaTitleWithReason =
    !opencodeQuotaData && opencodeQuotaReason
      ? `${opencodeQuotaTitle}\n${t("statusbar.codexReason", { reason: opencodeQuotaReason })}`
      : opencodeQuotaTitle;
  // A failed fetch stays diagnosable: append the reason to the tooltip, except
  // for the no-key slug the base hint already spells out.
  const ollamaQuotaTitleWithReason =
    !ollamaQuotaData && ollamaQuotaReason && !ollamaKeyMissing
      ? `${ollamaQuotaTitle}\n${t("statusbar.codexReason", { reason: ollamaQuotaReason })}`
      : ollamaQuotaTitle;
  const quotaTitle = quotaWeekly
    ? t("statusbar.codexQuotaTitle", {
        left: quotaLeftPct,
        resets: quotaWeekly.resetsAt ? new Date(quotaWeekly.resetsAt).toLocaleString() : "-",
        plan: quota?.plan ?? "ChatGPT",
      }) +
      (quotaFiveHour
        ? `\n${t("statusbar.codexFiveHourTitle", { left: Math.round(quotaFiveHour.remainingPercent) })}`
        : "")
    : t("statusbar.codexNoData");
  // A failed fetch stays diagnosable: append the app-server reason to the tooltip.
  const quotaTitleWithReason =
    !showQuota && codexQuotaReason
      ? `${quotaTitle}\n${t("statusbar.codexReason", { reason: codexQuotaReason })}`
      : quotaTitle;
  // Every quota-billed provider normalizes to one window model, so a single
  // QuotaChip renders them all: the active provider's view feeds the ribbon and
  // its label/title/refresh/plan fallback come from one place.
  const activeQuotaView: ProviderUsageView | null = openaiQuotaBilling
    ? quota
      ? codexUsageView(quota)
      : null
    : ollamaQuotaBilling
      ? ollamaQuotaData
        ? ollamaUsageView(ollamaQuotaData, ollamaPlan ?? null)
        : null
      : geminiTab
        ? antigravityQuotaData
          ? antigravityUsageView(antigravityQuotaData, settings?.model)
          : null
        : zaiQuotaBilling
          ? zaiQuotaData
            ? zaiUsageView(zaiQuotaData)
            : null
          : opencodeQuotaBilling
            ? opencodeQuotaData
              ? opencodeUsageView(opencodeQuotaData)
              : null
            : null;
  const quotaBilling =
    openaiQuotaBilling ||
    ollamaQuotaBilling ||
    geminiTab ||
    zaiQuotaBilling ||
    opencodeQuotaBilling;
  const quotaChipLabel = openaiQuotaBilling
    ? t("statusbar.codexQuota")
    : ollamaQuotaBilling
      ? t("statusbar.ollamaQuota")
      : geminiTab
        ? t("statusbar.antigravityQuota")
        : zaiQuotaBilling
          ? t("statusbar.zaiQuota")
          : t("statusbar.opencodeQuota");
  const quotaChipTitle = openaiQuotaBilling
    ? quotaTitleWithReason
    : ollamaQuotaBilling
      ? ollamaQuotaTitleWithReason
      : geminiTab
        ? antigravityQuotaTitleWithReason
        : zaiQuotaBilling
          ? zaiQuotaTitleWithReason
          : opencodeQuotaTitleWithReason;
  const quotaChipRefreshing = openaiQuotaBilling
    ? codexQuotaRefreshing
    : ollamaQuotaBilling
      ? ollamaQuotaRefreshing
      : geminiTab
        ? antigravityQuotaRefreshing
        : zaiQuotaBilling
          ? zaiQuotaRefreshing
          : opencodeQuotaRefreshing;
  const quotaChipRefresh = openaiQuotaBilling
    ? onRefreshCodexQuota
    : ollamaQuotaBilling
      ? onRefreshOllamaQuota
      : geminiTab
        ? onRefreshAntigravityQuota
        : zaiQuotaBilling
          ? onRefreshZaiQuota
          : onRefreshOpencodeQuota;
  const quotaChipPlanFallback = openaiQuotaBilling
    ? (quota?.plan ?? "ChatGPT")
    : ollamaQuotaBilling
      ? (ollamaPlan ?? "free")
      : geminiTab
        ? "Antigravity"
        : zaiQuotaBilling
          ? (zaiQuotaData?.plan ?? "GLM")
          : "Go";
  useEffect(() => {
    const renderState = {
      openaiTab,
      ollamaQuotaBilling,
      showQuota,
      hasWeeklyWindow: quotaWeekly !== null,
      hasFiveHourWindow: quotaFiveHour !== null,
      turnUsedPct: quotaTurnPct,
      ollamaTurnPct,
      weeklyRemainingPct: quotaWeekly?.remainingPercent ?? null,
      refreshing: codexQuotaRefreshing,
      reason: codexQuotaReason,
    };
    const level =
      (quotaTurnPct === null && openaiTab) || (ollamaTurnPct === null && ollamaQuotaBilling)
        ? "warn"
        : "debug";
    if (level === "warn") console.warn("[reasonix frontend] statusbar quota render", renderState);
    else console.debug("[reasonix frontend] statusbar quota render", renderState);
  }, [
    openaiTab,
    ollamaQuotaBilling,
    showQuota,
    quotaWeekly,
    quotaFiveHour,
    quotaTurnPct,
    ollamaTurnPct,
    codexQuotaRefreshing,
    codexQuotaReason,
  ]);
  // Rate-period timing uses the same shared schedule engine as telemetry billing.
  const [rateNow, setRateNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setRateNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const offPeak = rateSchedule ? isOffPeak(rateNow, rateSchedule) : true;
  const rateMins = rateSchedule ? minutesUntilRateChange(rateNow, rateSchedule) : 0;
  const rateMult = rateSchedule ? rateMultiplier(rateNow, rateSchedule) : 1;
  // Weekends push the next change past a full day — render "2d 9h" instead of
  // a raw "3420 min".
  const when =
    rateMins >= 1440
      ? `${Math.floor(rateMins / 1440)}d ${Math.floor((rateMins % 1440) / 60)}h`
      : rateMins >= 60
        ? `${Math.floor(rateMins / 60)}h ${rateMins % 60}m`
        : `${rateMins}m`;
  const rateTitle = ollamaPeakPricing
    ? offPeak
      ? t("statusbar.ollamaOffPeakTitle", { when })
      : t("statusbar.ollamaPeakTitle", { when })
    : zaiTab
      ? offPeak
        ? t("statusbar.zaiOffPeakTitle", { when })
        : t("statusbar.zaiPeakTitle", { when })
      : offPeak
        ? t("statusbar.offPeakTitle", { when })
        : t("statusbar.peakTitle", { when });
  const [themeOpen, setThemeOpen] = useState(false);
  const themePopRef = useRef<HTMLDivElement | null>(null);
  const themeButtonRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!themeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (themePopRef.current?.contains(target) || themeButtonRef.current?.contains(target)) return;
      setThemeOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [themeOpen]);

  return (
    <footer className="statusbar">
      <span className="seg" title={apiTitle}>
        <span
          className={dotDanger || dotWarn ? "sw warn" : "sw"}
          style={
            dotDanger
              ? { background: "var(--danger)" }
              : dotWarn
                ? { background: "var(--warn)" }
                : undefined
          }
        />
        <span>{apiHost}</span>
        {authLabel ? <span className="v">{authLabel}</span> : null}
        <span className="v">
          {!ready ? t("statusbar.offline") : busy ? t("statusbar.busy") : t("statusbar.online")}
        </span>
      </span>
      {showCacheHit ? (
        <span className="seg" title={t("statusbar.cacheHit")}>
          <I.zap size={11} style={{ color: "var(--accent)" }} />
          <span>{t("statusbar.cache")}</span>
          <span className="v acc">{cacheHitPct}%</span>
        </span>
      ) : null}
      {outputSavedPct !== null ? (
        <span
          className="seg"
          title={t("statusbar.outputSavedTip", {
            pct: outputSavedPct,
            saved: (
              (usage.shellOutputRawTokens ?? 0) - (usage.shellOutputShownTokens ?? 0)
            ).toLocaleString(),
            raw: (usage.shellOutputRawTokens ?? 0).toLocaleString(),
          })}
        >
          <I.terminal size={11} style={{ color: "var(--accent)" }} />
          <span>{t("statusbar.outputSaved")}</span>
          <span className="v acc">{outputSavedPct}%</span>
        </span>
      ) : null}
      {showCtxUsage ? (
        <span className="seg">
          <I.cpu size={11} />
          <span>{t("statusbar.tokens")}</span>
          <span className="v">{tokenLabel(totalTokens)}</span>
        </span>
      ) : null}
      {showTurnCost ? (
        <span
          className="seg"
          title={
            activeQuotaView?.turnUsedPct != null
              ? t(
                  openaiQuotaBilling
                    ? "statusbar.thisTurnQuotaTitle"
                    : ollamaQuotaBilling
                      ? "statusbar.ollamaTurnQuotaTitle"
                      : geminiTab
                        ? "statusbar.antigravityTurnQuotaTitle"
                        : zaiQuotaBilling
                          ? "statusbar.zaiTurnQuotaTitle"
                          : "statusbar.opencodeTurnQuotaTitle",
                  { pct: activeQuotaView.turnUsedPct.toFixed(1) },
                )
              : undefined
          }
        >
          <I.coin size={11} />
          <span>{t("statusbar.thisTurn")}</span>
          {quotaBilling ? (
            activeQuotaView?.turnUsedPct != null ? (
              <span className="v ok">{activeQuotaView.turnUsedPct.toFixed(1)}%</span>
            ) : (
              <span className="v ok">-</span>
            )
          ) : (
            <span className="v ok">
              {turnCost}
              <span className="conv">{`(${turnCostOther})`}</span>
            </span>
          )}
        </span>
      ) : null}

      {showSessionCost &&
      !openaiQuotaBilling &&
      !ollamaQuotaBilling &&
      !geminiTab &&
      !zaiQuotaBilling &&
      !opencodeQuotaBilling ? (
        <span className="seg" title={t("settings.sessionCost")}>
          <I.coin size={11} />
          <span>{t("settings.sessionCost")}</span>
          <span className="v ok">
            {sessionCostDisplay}
            <span className="conv">{`(${sessionCostOther})`}</span>
          </span>
        </span>
      ) : showSessionCost && sessionQuotaPct !== null ? (
        // Quota-billed session: accumulated plan-window % — the native unit, no
        // dollar figure is ever derived from quota usage.
        <span className="seg" title={t("settings.sessionCost")}>
          <I.coin size={11} />
          <span>{t("settings.sessionCost")}</span>
          <span className="v ok">{sessionQuotaPct.toFixed(2)}%</span>
        </span>
      ) : null}
      {rateSchedule ? (
        <span className="seg" title={rateTitle}>
          <I.clock size={11} style={{ color: offPeak ? "var(--success)" : "var(--warning)" }} />
          <span className={`v ${offPeak ? "ok" : "warn"}`}>
            {offPeak ? t("statusbar.offPeak") : t("statusbar.peak")}
            <span className="conv">{`${rateMult}x`}</span>
          </span>
        </span>
      ) : null}

      <span className="grow" />

      <span
        className={`seg jobs ${jobsOpen ? "active" : ""}`}
        onClick={onToggleJobs}
        onKeyDown={onToggleJobs ? activationHandler(onToggleJobs) : undefined}
        title={localizeShortcutText(t("statusbar.jobsTip"))}
      >
        <I.cpu size={11} />
        <span>{t("statusbar.jobs")}</span>
        <span className={runningJobs > 0 ? "v acc" : "v"}>{runningJobs}</span>
      </span>

      {settings?.workspaceDir ? (
        <span
          className="seg"
          title={t("statusbar.switchWorkspace", { workspace: settings.workspaceDir })}
          style={onOpenWorkdir ? { cursor: "pointer" } : undefined}
          onClick={(e) => {
            if (!onOpenWorkdir) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenWorkdir({ bottom: window.innerHeight - r.top + 6, left: r.left });
          }}
          onKeyDown={activationHandler((e) => {
            if (!onOpenWorkdir) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenWorkdir({ bottom: window.innerHeight - r.top + 6, left: r.left });
          })}
        >
          <I.folder size={11} />
          <span className="v">{settings.workspaceDir.split(/[\\/]/).pop() || "ws"}</span>
        </span>
      ) : null}
      <span
        className="seg"
        title={`model · effort ${settings?.reasoningEffort ?? "high"}`}
        onClick={onOpenSettings}
        onKeyDown={activationHandler(onOpenSettings)}
      >
        <I.brain size={11} style={{ color: "var(--violet)" }} />
        <span className="v vio">{settings?.model ? modelDisplayName(settings.model) : "-"}</span>
        <span className="v">{settings?.reasoningEffort ?? "high"}</span>
      </span>
      {showBalance ? (
        quotaBilling ? (
          <QuotaChip
            label={quotaChipLabel}
            title={quotaChipTitle}
            view={activeQuotaView}
            refreshing={quotaChipRefreshing}
            planFallback={quotaChipPlanFallback}
            onRefresh={quotaChipRefresh}
          />
        ) : opencodeFreeBilling ? (
          <span
            className="seg"
            style={{ cursor: "default" }}
            title={t("statusbar.opencodeFreeTitle")}
          >
            <I.coin size={11} style={{ color: "var(--accent)" }} />
            <span>{t("statusbar.opencodeFree")}</span>
            <span className="v ok">{t("statusbar.opencodeFreeTier")}</span>
          </span>
        ) : (
          <span
            className="seg"
            title={t("statusbar.switchCurrency")}
            onClick={onToggleCurrency}
            onKeyDown={activationHandler(onToggleCurrency)}
          >
            <I.coin size={11} />
            <span>{t("statusbar.balance")}</span>
            <span className="v ok">
              {balance && balance.infos.length > 0
                ? balance.infos
                    .map(
                      (info) => `${info.currency === "USD" ? "$" : "¥"} ${info.total.toFixed(2)}`,
                    )
                    .join(" / ")
                : balanceLabel}
            </span>
          </span>
        )
      ) : null}
      <span
        ref={themeButtonRef}
        className={`seg theme-trigger ${themeOpen ? "active" : ""}`}
        title={t("statusbar.switchTheme")}
        onClick={() => setThemeOpen((open) => !open)}
        onKeyDown={activationHandler(() => setThemeOpen((open) => !open))}
      >
        {theme === THEME.DARK ? <I.moon size={11} /> : <I.sun size={11} />}
        <span className="v">
          {t(`statusbar.themeStyle${themeStyle[0]!.toUpperCase()}${themeStyle.slice(1)}` as any)}
        </span>
      </span>
      {themeOpen ? (
        <div
          ref={themePopRef}
          className="theme-pop"
          role="menu"
          aria-label={t("settings.themeStyle")}
        >
          <div className="theme-pop-head">
            <div className="tt">{t("settings.themeStyle")}</div>
            <div className="ss">{t("statusbar.switchTheme")}</div>
          </div>
          <div className="theme-pop-list">
            {THEME_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className="theme-pop-item"
                data-on={themeStyle === style}
                data-style={style}
                onClick={() => {
                  onSetThemeStyle(style);
                  setThemeOpen(false);
                }}
              >
                <span className="style-swatches" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="txt">
                  <span className="nm">
                    {t(`statusbar.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}` as any)}
                  </span>
                  <span className="md">
                    {themeForStyle(style) === THEME.DARK
                      ? t("statusbar.themeDark")
                      : t("statusbar.themeLight")}
                  </span>
                </span>
                {themeStyle === style ? <I.check size={13} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </footer>
  );
}
