import {
  isPeakPricedModel,
  providerRateSchedule,
  providerSpec,
  providerString,
  quotaWindowsSummary,
  ratePeriodForSchedule,
} from "@reasonix/core-utils";
import type { ProviderUsage, ProviderUsageView, ProviderUsageWindow } from "@reasonix/core-utils";
import { useEffect, useRef, useState } from "react";
import type { Balance, Settings, UsageStats } from "../App";
import { t } from "../i18n";
import { I } from "../icons";
import type { JobInfo } from "../protocol";
import { THEME, THEME_STYLES, type Theme, type ThemeStyle, themeForStyle } from "../theme";
import { resolveRibbonFunds } from "../usage-ribbon";
import { hitPercent, tokenLabel } from "./format";
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

/** Declared per-window tooltip line for a window the main sentence omits. */
const WINDOW_TITLE_KEYS: Record<ProviderUsageWindow["label"], string> = {
  "5h": "quotaFiveHourTitle",
  wk: "quotaWeeklyTitle",
  mo: "quotaMonthlyTitle",
  day: "quotaDailyTitle",
  plan: "quotaPlanTitle",
};

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
      ) : view?.plan ? (
        <span className="v acc">{view.plan}</span>
      ) : (
        <span className="v acc">-</span>
      )}
    </span>
  );
}

export function StatusBar({
  settings,
  balance,
  planUsage,
  onRefreshPlanUsage,
  planUsageRefreshing,
  planUsageReason,
  planUsageNeedsSetup,
  usage,
  busy,
  ready,
  theme,
  themeStyle,
  jobs,
  jobsOpen,
  onToggleJobs,
  onSetThemeStyle,
  onOpenWorkdir,
}: {
  settings: Settings | null;
  balance: Balance | null;
  /** Plan usage for this tab's provider, normalized by the daemon from whichever
   *  probe the declaration names. */
  planUsage: ProviderUsage | null;
  onRefreshPlanUsage?: () => void;
  /** True between a chip click and the $usage reply — renders a refresh indicator. */
  planUsageRefreshing?: boolean;
  /** Why the last usage read produced no data — appended to the chip tooltip. */
  planUsageReason?: string | null;
  /** The reason means "not configured yet", so the tooltip asks for setup instead
   *  of reporting a failed read. */
  planUsageNeedsSetup?: boolean;
  usage: UsageStats;
  busy: boolean;
  ready: boolean;
  theme: Theme;
  themeStyle: ThemeStyle;
  jobs: JobInfo[];
  jobsOpen: boolean;
  onToggleJobs: () => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
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
  // Per-field visibility toggles — each defaults to true when absent from config.
  const showBalance = settings?.statusBar?.showBalance ?? true;
  const showCacheHit = settings?.statusBar?.showCacheHit ?? true;
  const showCtxUsage = settings?.statusBar?.showCtxUsage ?? true;
  // The tab's provider comes from the daemon-resolved endpoint info
  // (`ModelEndpointInfo.provider`), NEVER from the model name — a name doesn't
  // imply its provider (gpt-oss-* ids are served by Antigravity; custom gateway
  // ids can carry any shape). Absent endpoint info (pre-protocol daemons)
  // falls back to the resolver's DeepSeek default family.
  const ep = settings?.modelEndpoint;
  // Chip selection reads the provider's declaration, never its id: every chip
  // encodes something the declaration already states.
  const spec = ep?.provider ? providerSpec(ep.provider) : undefined;
  const auth = spec?.client.auth ?? null;
  const openaiTab = auth === "openai-oauth";
  // These two classify the *rate-period* chip (a declared price calendar whose
  // applicability is per model), never the money chips below.
  const ollamaTab = spec?.wire.format === "ollama-native";
  // Which money chip this tab gets, and whether $ is its native unit — one resolver
  // for every provider, so a new one needs no ribbon edit (see usage-ribbon.ts).
  const funds = resolveRibbonFunds(spec, ep);
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
  const openaiAuth = openaiTab ? (ep?.openaiAuth ?? "none") : null;
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
  // Declared copy with {name} placeholders filled; the two chips below both read it.
  const specCopy = (key: string, vars?: Record<string, string>) => providerString(spec, key, vars);
  const apiVars = { baseUrl: ep?.baseUrl ?? "", account: ep?.oauthAccount ?? "" };
  let apiTitle =
    specCopy(
      openaiAuth === "oauth"
        ? "apiOauth"
        : openaiAuth === "apiKey"
          ? "apiKey"
          : openaiAuth === "none"
            ? "apiNone"
            : "apiBare",
      apiVars,
    ) ?? `API · ${settings?.baseUrl ?? "api.deepseek.com"}`;
  if (authFailed) {
    apiTitle += `\n${specCopy("oauthFailed", { message: oauthFlowError ?? "" }) ?? ""}`;
  }
  const dotDanger = connState === "off" || authFailed;
  const dotWarn = !dotDanger && openaiAuth === "none";
  // Peak pricing follows daemon-resolved provider/deployment metadata and applies
  // only to the ids the provider lists as priced (`billing.peakModels`), so a
  // cheaper hosted model never inherits the rate chip.
  const ollamaPeakPricing =
    ollamaTab &&
    ep?.deployment === "cloud" &&
    ep?.billingKind === "usd" &&
    isPeakPricedModel(settings?.model ?? "", spec?.billing.peakModels);
  // The calendar is whatever the provider declares (`billing.schedule`): editing
  // its JSON moves the peak hours, no code change needed.
  const rateSchedule = ollamaTab && !ollamaPeakPricing ? null : providerRateSchedule(spec);

  // ---- Money chip ---------------------------------------------------------
  // One `$usage` payload reaches this file, so the chip and its tooltip are
  // computed once: windows, plan, primary window and reset style all come from
  // the provider's declaration, and the copy is that provider's own words.
  const planFallback = specCopy("quotaPlanFallback") ?? "";
  const planName = planUsage?.plan ?? specCopy("quotaPlanName") ?? "";
  // A provider that bills a plan it cannot always measure still names the plan in
  // the chip (`usage.measures: "plan"`); every other provider shows a dash.
  const chipView: ProviderUsageView | null = planUsage
    ? { plan: planUsage.plan ?? (planFallback || null), windows: planUsage.windows }
    : spec?.usage.measures === "plan"
      ? { plan: planFallback || null, windows: [] }
      : null;
  const formatResetAt = (resetsAt: number | null): string =>
    resetsAt === null
      ? "-"
      : spec?.usage.resetsStyle === "absolute"
        ? new Date(resetsAt).toLocaleString()
        : formatReset(new Date(resetsAt));
  const pctOf = (w: ProviderUsageWindow | null): string =>
    w ? String(Math.round(w.remainingPct)) : "-";
  const windowBy = (label: ProviderUsageWindow["label"]): ProviderUsageWindow | null =>
    planUsage?.windows.find((w) => w.label === label) ?? null;
  const fiveHourWindow = windowBy("5h");
  const primaryWindow =
    (spec?.usage.primaryWindow ? windowBy(spec.usage.primaryWindow) : null) ??
    planUsage?.windows[0] ??
    null;
  // Every declared template names its placeholders from this one map: the shared
  // `{left}`/`{resets}` pair (the primary window) plus each window's aliases.
  const usageVars: Record<string, string> = {
    plan: planName,
    left: pctOf(primaryWindow),
    resets: formatResetAt(primaryWindow?.resetsAt ?? null),
    fiveHour: pctOf(fiveHourWindow),
    session: pctOf(fiveHourWindow),
    rolling: pctOf(fiveHourWindow),
    weekly: pctOf(windowBy("wk")),
    monthly: pctOf(windowBy("mo")),
    planLeft: pctOf(windowBy("plan")),
    weeklyResets: formatResetAt(windowBy("wk")?.resetsAt ?? null),
    sessionResets: formatResetAt(fiveHourWindow?.resetsAt ?? null),
    ...(planUsage?.credit ? { credit: planUsage.credit.amount.toFixed(2) } : {}),
  };
  // A "not configured yet" reason is already spelled out by the copy itself, so
  // only a real failure appends its slugs to the tooltip.
  const reasonLine =
    !planUsage && planUsageReason && !planUsageNeedsSetup
      ? `\n${t("statusbar.codexReason", { reason: planUsageReason })}`
      : "";
  const noDataCopy =
    planUsage || (planUsageReason && !planUsageNeedsSetup)
      ? (specCopy("quotaNoDataUnavailable") ??
        specCopy("quotaNoData") ??
        t("statusbar.quotaNoData"))
      : (specCopy("quotaNoData") ?? t("statusbar.quotaNoData"));
  const quotaChipTitle = !planUsage
    ? `${noDataCopy}${reasonLine}`
    : [
        // A provider naming both windows in one sentence declares a dual template;
        // the rest read the single-window one.
        (planUsage.windows.length > 1 ? specCopy("quotaDualTitle", usageVars) : undefined) ??
          specCopy("quotaTitle", usageVars) ??
          t("statusbar.quotaTitle"),
        // A window the main sentence left out gets its own declared line.
        ...planUsage.windows
          .filter((w) => w !== primaryWindow)
          .map((w) =>
            specCopy(WINDOW_TITLE_KEYS[w.label], {
              ...usageVars,
              left: pctOf(w),
              resets: formatResetAt(w.resetsAt),
            }),
          )
          .filter((line): line is string => !!line),
        ...(planUsage.credit
          ? [specCopy("creditTitle", { credit: planUsage.credit.amount.toFixed(2) })].filter(
              (line): line is string => !!line,
            )
          : []),
      ].join("\n");
  const quotaChip = {
    view: chipView,
    title: quotaChipTitle,
    refreshing: planUsageRefreshing,
    refresh: onRefreshPlanUsage,
    planFallback,
  };
  // One chip serves every quota-billed provider, so its label is keyed on the
  // declaration rather than on which tab is active.
  const quotaChipLabel = specCopy("quotaLabel") ?? t("statusbar.quotaLabel");

  // Rate-period timing uses the same shared schedule engine as telemetry billing.
  const [rateNow, setRateNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setRateNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const rate = rateSchedule ? ratePeriodForSchedule(rateNow, rateSchedule) : null;
  const offPeak = !rate?.peak;
  const rateMins = rate?.minutesUntilChange ?? 0;
  // Weekends push the next change past a full day — render "2d 9h" instead of
  // a raw "3420 min".
  const when =
    rateMins >= 1440
      ? `${Math.floor(rateMins / 1440)}d ${Math.floor((rateMins % 1440) / 60)}h`
      : rateMins >= 60
        ? `${Math.floor(rateMins / 60)}h ${rateMins % 60}m`
        : `${rateMins}m`;
  // Each rate-scheduled provider declares its own peak and off-peak wording;
  // the generic pair stays for a provider that declares neither.
  const rateTitle =
    (offPeak ? specCopy("offPeakTitle", { when }) : specCopy("peakTitle", { when })) ??
    (offPeak ? t("statusbar.offPeakTitle", { when }) : t("statusbar.peakTitle", { when }));
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
      {rateSchedule ? (
        <span className="seg" title={rateTitle}>
          <I.clock size={11} style={{ color: offPeak ? "var(--success)" : "var(--warning)" }} />
          <span className={`v ${offPeak ? "ok" : "warn"}`}>
            {offPeak ? t("statusbar.offPeak") : t("statusbar.peak")}
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
      {showBalance && funds.chip === "quota" ? (
        <QuotaChip
          label={quotaChipLabel}
          title={quotaChip.title}
          view={quotaChip.view}
          refreshing={quotaChip.refreshing}
          planFallback={quotaChip.planFallback}
          onRefresh={quotaChip.refresh}
        />
      ) : null}
      {showBalance && funds.chip === "tier" ? (
        <span
          className="seg"
          style={{ cursor: "default" }}
          title={specCopy("freeTitle") ?? t("statusbar.quotaTitle")}
        >
          <I.coin size={11} style={{ color: "var(--accent)" }} />
          <span>{specCopy("freeLabel") ?? t("statusbar.quotaLabel")}</span>
          <span className="v ok">{specCopy("freeTier") ?? ""}</span>
        </span>
      ) : null}
      {showBalance && funds.chip === "wallet" ? (
        <span className="seg">
          <I.coin size={11} />
          <span>{t("statusbar.balance")}</span>
          <span className="v ok">
            {balance && balance.infos.length > 0
              ? balance.infos
                  .map((info) => `${info.currency === "USD" ? "$" : "¥"} ${info.total.toFixed(2)}`)
                  .join(" / ")
              : balanceLabel}
          </span>
        </span>
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
