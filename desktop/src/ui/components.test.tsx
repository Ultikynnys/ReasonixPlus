// @vitest-environment jsdom
// Consolidated from 8 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { type ChangelogRelease, groupReleases } from "@reasonix/core-utils";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, UsageStats } from "../App";
import type {
  AntigravityQuota,
  CodexQuota,
  ModelEndpointInfo,
  OllamaQuota,
  OpencodeQuota,
  SessionEventRecord,
  ZaiQuota,
} from "../protocol";
import { THEME, THEME_STYLES } from "../theme";
import { CardHead } from "./card-head";
import { type ChangelogState, PageChangelog } from "./changelog";
import { Composer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";
import { EventsPanel, sessionEvents, turnEvents } from "./events";
import { FitText, fitFontSize } from "./fit-text";
import { StatusBar } from "./statusbar";
import { StopButton, usePendingStop } from "./stop-button";

describe("statusbar", () => {
  /** Mirrors the daemon's `modelEndpointFor` for the ids used in these tests —
   *  the statusbar consumes the daemon-resolved provider and billing kind, never the
   *  model name. Unmapped ids intentionally resolve to the default family: that is
   *  the "name doesn't imply provider" contract under test. */
  function endpointFor(model: string): ModelEndpointInfo {
    if (model.startsWith("ollama/"))
      return {
        provider: "ollama",
        baseUrl: "https://ollama.com/v1",
        billingKind: "quota",
        deployment: "cloud",
      };
    if (model === "gpt-5.6-sol" || model === "gpt-5.6-terra")
      return { provider: "openai", baseUrl: "https://api.openai.com/v1", billingKind: "quota" };
    // gpt-4o-custom here stands in for a custom id the user mapped to the
    // OpenAI provider via the `models` config (the daemon resolved it).
    if (model === "gpt-4o-custom")
      return { provider: "openai", baseUrl: "https://api.openai.com/v1", billingKind: "quota" };
    if (
      model === "gpt-oss-120b-medium" ||
      model === "gemini-3.6-flash" ||
      model === "gemini-3.7-flash"
    )
      return {
        provider: "gemini",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        billingKind: "quota",
      };
    if (model.startsWith("glm-"))
      return { provider: "zai", baseUrl: "https://api.z.ai/api/v1", billingKind: "quota" };
    if (model === "opencode/big-pickle")
      return {
        provider: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
        billingKind: "none",
        opencodeAuth: "oauth",
        opencodePlan: "free",
      };
    if (model.startsWith("opencode/"))
      return {
        provider: "opencode",
        baseUrl: "https://opencode.ai/zen/go/v1",
        billingKind: "quota",
        opencodeAuth: "oauth",
        opencodePlan: "go",
      };
    if (model.startsWith("mimo-"))
      return { provider: "mimo", baseUrl: "https://api.mimo.ai/v1", billingKind: "quota" };
    return { provider: "deepseek", baseUrl: "https://api.deepseek.com", billingKind: "usd" };
  }

  function renderBar(overrides: Partial<Parameters<typeof StatusBar>[0]> = {}) {
    const settings = {
      model: "deepseek-v4-flash",
      ...(overrides.settings as Partial<Settings> | undefined),
    } as Settings;
    // Tests that don't stub modelEndpoint get the daemon-plausible resolution
    // for their model, exactly as a live $settings event would carry it.
    if (!settings.modelEndpoint) settings.modelEndpoint = endpointFor(settings.model);
    const props: Parameters<typeof StatusBar>[0] = {
      balance: null,
      codexQuota: null,
      ollamaQuota: null,
      antigravityQuota: null,
      zaiQuota: null,
      opencodeQuota: null,
      usage: {} as UsageStats,
      busy: false,
      ready: true,
      theme: THEME.DARK,
      themeStyle: THEME_STYLES[0]!,
      jobs: [],
      jobsOpen: false,
      onToggleJobs: () => undefined,
      onSetThemeStyle: () => undefined,
      ...overrides,
      // The merged settings (with the resolved endpoint) win over the raw
      // override copy so the endpoint injection is never clobbered.
      settings,
    };
    return render(<StatusBar {...props} />);
  }

  const GPT_QUOTA: CodexQuota = {
    plan: "plus",
    fiveHour: { windowMinutes: 300, usedPercent: 50, remainingPercent: 50, resetsAt: null },
    weekly: { windowMinutes: 10080, usedPercent: 42, remainingPercent: 58, resetsAt: null },
    fetchedAt: 0,
  };

  const OLLAMA_QUOTA: OllamaQuota = {
    session: { usagePct: 25, remainingPct: 75 },
    weekly: { usagePct: 12.5, remainingPct: 87.5 },
    fetchedAt: 0,
  };

  const ANTIGRAVITY_QUOTA: AntigravityQuota = {
    plan: { tierId: "free-tier", name: "Antigravity" },
    windows: [
      { modelId: "gemini-3.6-flash", usedFraction: 0.1, resetTime: "2026-09-01T13:37:06Z" },
    ],
    fetchedAt: 0,
  };

  describe("StatusBar quota display", () => {
    afterEach(() => {
      cleanup();
    });

    it("leaves model and effort to the composer, not the bottom ribbon", () => {
      renderBar({ settings: { model: "deepseek-v4-flash", reasoningEffort: "high" } as Settings });
      // Both are set in the composer's own pills, so repeating them beside the
      // quota chip was noise.
      expect(screen.queryByText("deepseek-v4-flash")).toBeNull();
      expect(screen.queryByText("high")).toBeNull();
      // The chips the ribbon does own still render.
      expect(screen.getByText("balance")).toBeTruthy();
    });

    it("drops the wallet chip on a provider that publishes no balance endpoint", () => {
      renderBar({
        settings: {
          model: "syn:large:text",
          modelEndpoint: {
            provider: "synthetic",
            baseUrl: "https://api.synthetic.new/v1",
            billingKind: "usd",
          },
        } as Settings,
        usage: {} as UsageStats,
      });
      // Nothing declared to read and no rate table: the ribbon claims neither a
      // wallet nor a dollar figure instead of showing a dash or an invented $0.0000.
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText("this turn")).toBeNull();
      expect(screen.queryByText(/This session cost/)).toBeNull();
    });

    it("shows the credits-based wallet on an Experiential Labs tab", () => {
      renderBar({
        settings: {
          model: "qwen3.8-27b",
          modelEndpoint: {
            provider: "experiential",
            baseUrl: "https://api.experientiallabs.ai/v1",
            billingKind: "usd",
          },
        } as Settings,
        // The daemon reads the declared /api/v1/credits ledger and reports the
        // difference as one USD wallet, so the chip has a real figure.
        balance: {
          currency: "USD",
          total: 20.5,
          isAvailable: true,
          infos: [{ currency: "USD", total: 20.5 }],
        },
      });
      expect(screen.getByText("balance")).toBeTruthy();
      expect(screen.getByText("$ 20.50")).toBeTruthy();
    });

    it("shows the shell-output savings chip with the reduction percentage", () => {
      renderBar({
        usage: {
          // 19,000 of 50,000 tokens filtered out = 38%.
          shellOutputRawTokens: 50_000,
          shellOutputShownTokens: 31_000,
        } as unknown as UsageStats,
      });
      expect(screen.getByText("saved")).toBeTruthy();
      expect(screen.getByText("38%")).toBeTruthy();
    });

    it("hides the shell-output savings chip when there is no telemetry yet", () => {
      renderBar({
        usage: {} as UsageStats,
      });
      expect(screen.queryByText("saved")).toBeNull();
    });

    it("shows the cache-hit chip with a decimal, never a rounded-up 100%", () => {
      // 999,838 / (999,838 + 162) = 99.984% real. A whole-percent round renders
      // the mathematically impossible "100%" (some miss always remains).
      renderBar({
        usage: {
          cacheHitTokens: 999_838,
          cacheMissTokens: 162,
        } as unknown as UsageStats,
      });
      expect(screen.getByText("cache")).toBeTruthy();
      expect(screen.getByText("99.9%")).toBeTruthy();
      expect(screen.queryByText("100%")).toBeNull();
    });

    it("scales the tokens chip unit with magnitude (k below a million, m above)", () => {
      // Regression: the label used to pin to kilo, so 66,851,100 tokens rendered
      // as the unreadable "66851.1k".
      renderBar({
        usage: {
          totalPromptTokens: 66_851_100,
          reservedTokens: 0,
          liveLogTokens: 0,
        } as unknown as UsageStats,
      });
      expect(screen.getByText("66.9m")).toBeTruthy();
    });

    it("keeps the kilo unit for sub-million token counts", () => {
      renderBar({
        usage: {
          totalPromptTokens: 12_345,
          reservedTokens: 0,
          liveLogTokens: 0,
        } as unknown as UsageStats,
      });
      expect(screen.getByText("12.3k")).toBeTruthy();
    });

    it("shows the current rate period (off-peak or peak) and nothing else", () => {
      renderBar();
      // Wall-clock dependent — either label may be current.
      expect(screen.getByText(/off-peak|peak/)).toBeTruthy();
      // No price multiplier: a per-provider factor read inconsistently (DeepSeek
      // surcharges peak, Z.AI discounts off-peak), so the chip states the period.
      expect(screen.queryByText(/^\d+(\.\d+)?x$/)).toBeNull();
    });

    it("hides the peak/off-peak chip on OpenAI (gpt-*) tabs — it only applies to DeepSeek", () => {
      renderBar({ settings: { model: "gpt-5.6-sol" } as Settings });
      expect(screen.queryByText(/off-peak|peak/)).toBeNull();
    });

    it("shows Ollama Cloud's rate chip only for token-priced Flash/Pro models", () => {
      renderBar({
        settings: {
          model: "ollama/deepseek-v4-flash",
          modelEndpoint: {
            provider: "ollama",
            baseUrl: "https://ollama.com/v1",
            billingKind: "usd",
            deployment: "cloud",
          },
        } as Settings,
      });
      expect(screen.getByText(/off-peak|peak/)).toBeTruthy();
    });

    it("shows the Z.AI rate chip", () => {
      renderBar({ settings: { model: "glm-5.3-flash" } as Settings });
      expect(screen.getByText(/off-peak|peak/)).toBeTruthy();
    });

    it("shows GLM plan % left + plan for Z.AI tabs with both 5-hour and weekly limits", () => {
      renderBar({
        settings: { model: "glm-5.3-flash" } as Settings,
        zaiQuota: {
          plan: "pro",
          fiveHour: { usagePct: 30, remainingPct: 70, resetsAt: null },
          weekly: { usagePct: 12, remainingPct: 88, resetsAt: null },
          fetchedAt: 0,
        } as ZaiQuota,
      });
      expect(screen.getByText(/5h\s*70%\s*·\s*wk\s*88%\s*left/)).toBeTruthy();
      expect(screen.getByText("pro")).toBeTruthy();
      // The balance and $ amounts are replaced by the GLM usage percentages.
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
    });

    it("shows single window % left when Z.AI reports only one limit window", () => {
      renderBar({
        settings: { model: "glm-5.3-flash" } as Settings,
        zaiQuota: {
          plan: "pro",
          fiveHour: { usagePct: 30, remainingPct: 70, resetsAt: null },
          weekly: null,
          fetchedAt: 0,
        } as ZaiQuota,
      });
      expect(screen.getByText(/70%\s*left/)).toBeTruthy();
    });

    it("keeps the GLM usage chip (em dash + retry) without data — never the DeepSeek balance", () => {
      renderBar({ settings: { model: "glm-5.3-flash" } as Settings, zaiQuota: null });
      expect(screen.getByText("GLM usage")).toBeTruthy();
      expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.getByTitle(/set a Z\.AI API key/)).toBeTruthy();
    });

    it("renders a static MiMo plan chip for a mimo tab", () => {
      renderBar({ settings: { model: "mimo-v2.6-pro" } as Settings });
      expect(screen.getByText("MiMo plan")).toBeTruthy();
      expect(screen.getByText("Token Plan")).toBeTruthy();
      // Subscription-billed: no per-token dollar figure replaces the plan chip.
      expect(screen.queryByText("balance")).toBeNull();
    });

    it("surfaces the Z.AI usage fetch failure reason in the chip tooltip", () => {
      renderBar({
        settings: { model: "glm-5.3-flash" } as Settings,
        zaiQuota: null,
        zaiQuotaReason: "usage-unavailable",
      });
      expect(screen.getByTitle(/usage-unavailable/)).toBeTruthy();
    });
    it("hides the rate chip for local Ollama and other Ollama models", () => {
      renderBar({ settings: { model: "ollama/llama3.1:latest" } as Settings });
      expect(screen.queryByText(/off-peak|peak/)).toBeNull();

      cleanup();
      renderBar({
        settings: {
          model: "ollama/deepseek-v4-pro",
          modelEndpoint: {
            provider: "ollama",
            baseUrl: "http://localhost:11434",
            billingKind: "none",
            deployment: "local",
          },
        } as Settings,
      });
      expect(screen.queryByText(/off-peak|peak/)).toBeNull();
    });

    it("hides the peak/off-peak chip on Antigravity (Gemini) tabs", () => {
      renderBar({ settings: { model: "gemini-3.6-flash" } as Settings });
      expect(screen.queryByText(/off-peak|peak/)).toBeNull();
    });

    it("shows the 5h + weekly quota ribbon and plan for gpt-5.6 tabs", () => {
      renderBar({
        settings: { model: "gpt-5.6-sol" } as Settings,
        codexQuota: GPT_QUOTA,
      });
      expect(screen.getByText(/5h 50% · wk 58% left/)).toBeTruthy();
      expect(screen.getByText(/58%\s*left/)).toBeTruthy();
      expect(screen.getByText("plus")).toBeTruthy();
      // Balance and $ amounts are replaced by the pure quota numbers.
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
    });

    it("keeps the quota chips (em dash + retry) for gpt tabs when quota data is missing — never the DeepSeek balance", () => {
      renderBar({
        settings: { model: "gpt-5.6-sol" } as Settings,
        codexQuota: null,
      });
      // The codex chip renders a dash when there is no data.
      expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("codex")).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
      // No data → the chip hints at the in-app ChatGPT sign-in (no codex CLI).
      expect(screen.getByTitle(/sign in with ChatGPT/)).toBeTruthy();
    });

    it("shows the no-data hint regardless of auth state — the reason string carries the diagnosis", () => {
      renderBar({
        settings: {
          model: "gpt-5.6-sol",
          modelEndpoint: {
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            openaiAuth: "oauth",
          },
        } as Settings,
        codexQuota: null,
      });
      expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTitle(/sign in with ChatGPT/)).toBeTruthy();
    });

    it("renders quota chips (not balance) when the daemon resolves a custom id to OpenAI", () => {
      // gpt-4o-custom is not in any catalog — the daemon only reports it as
      // OpenAI because the user mapped it via the `models` config.
      renderBar({
        settings: { model: "gpt-4o-custom" } as Settings,
        codexQuota: GPT_QUOTA,
      });
      expect(screen.getByText(/58%\s*left/)).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
    });

    it("renders the DeepSeek balance for a gpt-* shaped id the daemon did NOT resolve to OpenAI", () => {
      // The name alone proves nothing: an unmapped custom id resolves to the
      // default family, so the bar shows the DeepSeek chips, never codex.
      renderBar({
        settings: {
          model: "gpt-4o-custom",
          modelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
        } as Settings,
        codexQuota: GPT_QUOTA,
      });
      expect(screen.getByText("balance")).toBeTruthy();
      expect(screen.queryByText(/58%\s*left/)).toBeNull();
      expect(screen.queryByText("codex")).toBeNull();
    });

    it("treats gpt-oss-* (Antigravity-served) models as Antigravity tabs, never OpenAI", () => {
      renderBar({
        settings: { model: "gpt-oss-120b-medium" } as Settings,
        codexQuota: GPT_QUOTA,
        antigravityQuota: {
          ...ANTIGRAVITY_QUOTA,
          windows: [
            {
              modelId: "gpt-oss-120b-medium",
              usedFraction: 0.1,
              resetTime: "2026-09-01T13:37:06Z",
            },
          ],
        },
      });
      // The Antigravity quota chips render — plan name + window %.
      expect(screen.getByText(/90%\s*left/)).toBeTruthy();
      expect(screen.getByText("Antigravity")).toBeTruthy();
      // The OpenAI codex quota never leaks onto the tab despite the gpt- prefix.
      expect(screen.queryByText(/58%\s*left/)).toBeNull();
      expect(screen.queryByText("codex")).toBeNull();
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\./)).toBeNull();
    });

    it("falls back to the ChatGPT label when the plan is unknown", () => {
      renderBar({
        settings: { model: "gpt-5.6-sol" } as Settings,
        codexQuota: {
          plan: null,
          fiveHour: null,
          weekly: { windowMinutes: 10080, usedPercent: 75, remainingPercent: 25, resetsAt: null },
          fetchedAt: 0,
        },
      });
      expect(screen.getByText(/25%\s*left/)).toBeTruthy();
      expect(screen.getByText("ChatGPT")).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
    });

    it("shows a refresh indicator while a retry is in flight", () => {
      renderBar({
        settings: { model: "gpt-5.6-sol" } as Settings,
        codexQuota: null,
        codexQuotaRefreshing: true,
      });
      expect(screen.getByText("…")).toBeTruthy();
      expect(screen.getByText("codex")).toBeTruthy();
    });

    it("surfaces the fetch failure reason in the chip tooltip", () => {
      renderBar({
        settings: {
          model: "gpt-5.6-sol",
          modelEndpoint: {
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            openaiAuth: "oauth",
          },
        } as Settings,
        codexQuota: null,
        codexQuotaReason: "no OAuth token",
      });
      expect(screen.getByTitle(/sign in with ChatGPT/)).toBeTruthy();
      expect(screen.getByTitle(/no OAuth token/)).toBeTruthy();
    });

    it("shows only quota percentages for a keyed Ollama DeepSeek model", () => {
      renderBar({
        settings: {
          model: "ollama/deepseek-v4-flash:0731",
          modelEndpoint: {
            provider: "ollama",
            baseUrl: "https://ollama.com/v1",
            billingKind: "quota",
            deployment: "cloud",
          },
        } as Settings,
        usage: {} as unknown as UsageStats,
        ollamaQuota: OLLAMA_QUOTA,
        ollamaPlan: "medium",
      });
      expect(screen.getByText(/88%\s*left/)).toBeTruthy();
      expect(screen.getByText("medium")).toBeTruthy();
      expect(screen.queryByText(/\$/)).toBeNull();
      expect(screen.queryByText(/¥/)).toBeNull();
    });

    it("shows the 5h + weekly ribbon and plan for quota-billed Ollama tabs", () => {
      renderBar({
        settings: { model: "ollama/gpt-oss:20b" } as Settings,
        ollamaQuota: OLLAMA_QUOTA,
        ollamaPlan: "free",
      });
      expect(screen.getByText(/5h 75% · wk 88% left/)).toBeTruthy();
      expect(screen.getByText(/88%\s*left/)).toBeTruthy();
      expect(screen.getByText("free")).toBeTruthy();
      // Balance and $ amounts are replaced by the pure usage numbers.
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
    });

    it("shows the reset countdowns in the Ollama plan tooltip", () => {
      renderBar({
        settings: { model: "ollama/gpt-oss:20b" } as Settings,
        ollamaQuota: {
          ...OLLAMA_QUOTA,
          weekly: { ...OLLAMA_QUOTA.weekly!, resetsAt: Date.now() + 3 * 60 * 60 * 1000 },
        },
      });
      expect(screen.getByTitle(/resets in 3h/)).toBeTruthy();
    });

    it("keeps the quota chips for ollama tabs when usage data is missing — never the DeepSeek balance", () => {
      renderBar({
        settings: { model: "ollama/gpt-oss:20b" } as Settings,
        ollamaQuota: null,
      });
      expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("plan usage")).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\.0000/)).toBeNull();
      expect(screen.getByTitle(/set an API key/)).toBeTruthy();
    });

    it("surfaces the Ollama usage fetch failure reason in the chip tooltip", () => {
      renderBar({
        settings: { model: "ollama/gpt-oss:20b" } as Settings,
        ollamaQuota: null,
        ollamaQuotaReason: "usage-unavailable",
      });
      expect(screen.getByTitle(/usage-unavailable/)).toBeTruthy();
    });

    it("does not claim an API key is missing when one is set but the fetch failed", () => {
      renderBar({
        settings: { model: "ollama/gpt-oss:20b" } as Settings,
        ollamaQuota: null,
        ollamaQuotaReason: "usage-unavailable",
      });
      expect(screen.getByText("plan usage")).toBeTruthy();
      expect(screen.queryByTitle(/set an API key/)).toBeNull();
      expect(screen.getByTitle(/an API key is set/)).toBeTruthy();
      expect(screen.getByTitle(/usage-unavailable/)).toBeTruthy();
    });

    it("shows the set-an-API-key hint only when the daemon reports a missing key", () => {
      renderBar({
        settings: { model: "ollama/gpt-oss:20b" } as Settings,
        ollamaQuota: null,
        ollamaQuotaReason: "ollama-no-api-key",
      });
      expect(screen.getByTitle(/set an API key/)).toBeTruthy();
      expect(screen.queryByTitle(/an API key is set/)).toBeNull();
    });

    it("shows only quota percentages for an Antigravity tab", () => {
      renderBar({
        settings: { model: "gemini-3.6-flash" } as Settings,
        antigravityQuota: ANTIGRAVITY_QUOTA,
      });
      expect(screen.getByText(/90%\s*left/)).toBeTruthy();
      expect(screen.getByText("Antigravity")).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/This session cost/)).toBeNull();
      expect(screen.queryByText(/\$ 0\./)).toBeNull();
    });

    it("shows an em dash for the Antigravity chip when no quota data exists", () => {
      renderBar({
        settings: { model: "gemini-3.7-flash" } as Settings,
        antigravityQuota: null,
      });
      expect(screen.getByText("plan usage")).toBeTruthy();
      expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTitle(/sign in to Google Antigravity/)).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
    });

    it("shows the Go plan '% left' chip for an opencode tab", () => {
      const OPENCODE_QUOTA: OpencodeQuota = {
        rolling: { usagePct: 30, remainingPct: 70, resetsAt: null, limited: false },
        weekly: { usagePct: 12, remainingPct: 88, resetsAt: null, limited: false },
        monthly: { usagePct: 5, remainingPct: 95, resetsAt: null, limited: false },
        fetchedAt: 0,
      };
      renderBar({
        settings: { model: "opencode/qwen3.8-max" } as Settings,
        opencodeQuota: OPENCODE_QUOTA,
      });
      expect(screen.getByText("Go usage")).toBeTruthy();
      expect(screen.getByText(/5h 70% · wk 88% · mo 95% left/)).toBeTruthy();
      expect(screen.getByText("Go")).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
      expect(screen.queryByText(/\$ 0\./)).toBeNull();
    });

    it("shows a dash + reason for the opencode chip with no usage data", () => {
      renderBar({
        settings: { model: "opencode/qwen3.8-max" } as Settings,
        opencodeQuota: null,
        opencodeQuotaReason: "usage-unavailable",
      });
      expect(screen.getByText("Go usage")).toBeTruthy();
      expect(screen.getByTitle(/usage-unavailable/)).toBeTruthy();
      expect(screen.queryByText("balance")).toBeNull();
    });

    it("shows a free-tier chip (not Go usage) for a free OpenCode model", () => {
      renderBar({
        settings: { model: "opencode/big-pickle" } as Settings,
        usage: {} as UsageStats,
      });
      expect(screen.getByText("plan usage")).toBeTruthy();
      expect(screen.getByText("free")).toBeTruthy();
      expect(screen.queryByText("Go usage")).toBeNull();
      // The free tier publishes no rates, so no dollar figure is claimed either —
      // a $0.00 chip would be an invented number.
      expect(screen.queryByText("this turn")).toBeNull();
      expect(screen.queryByText("This session cost")).toBeNull();
      expect(screen.queryByText("balance")).toBeNull();
    });
  });
});

describe("events", () => {
  afterEach(cleanup);

  const userTurn = (turn: number, text: string, ts?: number) => ({
    kind: "user",
    text,
    turn,
    ...(ts === undefined ? {} : { ts }),
  });

  /** Turn 1 written at 1000, answered at 1500, turn 2 at 2000. */
  const messages = [
    userTurn(1, "first question", 1_000),
    { kind: "assistant", turn: 1, ts: 1_500 },
    userTurn(2, "second question", 2_000),
  ];

  const planEvent = (over: Partial<SessionEventRecord> = {}): SessionEventRecord => ({
    id: "plan-1",
    type: "plan",
    ts: 1_200,
    turn: 1,
    outcome: "approve",
    label: "Ship the parser",
    ...over,
  });

  describe("turnEvents", () => {
    it("keeps one row per user turn, stamped with when it was written", () => {
      const rows = turnEvents(messages);
      expect(rows.map((row) => row.turn)).toEqual([1, 2]);
      expect(rows.map((row) => row.ts)).toEqual([1_000, 2_000]);
      expect(rows[0]?.label).toBe("first question");
    });

    it("drops a replayed turn so one question cannot show twice", () => {
      const rows = turnEvents([userTurn(1, "first", 10), userTurn(1, "replayed", 20)]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.label).toBe("first");
    });

    it("gives a pre-stamp record the stamp before it instead of no time", () => {
      const rows = turnEvents([userTurn(1, "one", 1_000), userTurn(2, "two")]);
      expect(rows.map((row) => row.ts)).toEqual([1_000, 1_000]);
    });

    it("collapses a headline to one line", () => {
      const rows = turnEvents([userTurn(1, `line one\n\n   line two${"x".repeat(400)}`, 5)]);
      expect(rows[0]?.label).not.toContain("\n");
      expect(rows[0]?.label.length).toBeLessThanOrEqual(160);
    });

    it("skips a machine-written record so tool feedback is not a prompt row", () => {
      const rows = turnEvents([
        userTurn(1, "real question", 1_000),
        {
          ...userTurn(2, "Screen capture (monitor 0 [0, 0] to [1920, 1080])", 2_000),
          injected: true,
        },
        userTurn(3, "next question", 3_000),
      ]);

      expect(rows.map((row) => row.turn)).toEqual([1, 3]);
      expect(rows.map((row) => row.label)).toEqual(["real question", "next question"]);
    });
  });

  describe("sessionEvents", () => {
    it("orders turns and recorded verdicts by when they happened", () => {
      const rows = sessionEvents(messages, [
        planEvent(),
        {
          id: "compaction-7",
          type: "compaction",
          ts: 1_600,
          turn: 1,
          outcome: "auto",
          label: "folded 12",
        },
      ]);
      expect(rows.map((row) => `${row.kind}:${row.ts}`)).toEqual([
        "turn:1000",
        "plan:1200",
        "compaction:1600",
        "turn:2000",
      ]);
    });

    it("keeps the verdict and the wording the record carried", () => {
      const [plan] = sessionEvents([], [planEvent({ detail: "because" })]);
      expect(plan).toMatchObject({ kind: "plan", outcome: "approve", label: "Ship the parser" });
      expect(plan?.detail).toBe("because");
    });

    it("carries the options a choice was picked from", () => {
      const [choice] = sessionEvents(
        [],
        [
          {
            id: "choice-1",
            type: "choice",
            ts: 10,
            turn: 1,
            outcome: "pick",
            label: "B",
            options: ["A", "B"],
          },
        ],
      );
      expect(choice?.options).toEqual(["A", "B"]);
    });

    it("carries a plan's body and checklist", () => {
      const [plan] = sessionEvents(
        [],
        [planEvent({ body: "## Plan\n\nDo the thing.", steps: ["First", "Second"] })],
      );
      expect(plan?.body).toBe("## Plan\n\nDo the thing.");
      expect(plan?.steps).toEqual(["First", "Second"]);
    });

    it("skips a record with no usable stamp", () => {
      expect(sessionEvents([], [planEvent({ ts: Number.NaN })])).toEqual([]);
    });

    it("carries a subagent spawn with the instruction it was given", () => {
      const [spawn] = sessionEvents(
        [],
        [
          {
            id: "subagent-tc-7",
            type: "subagent",
            ts: 10,
            turn: 1,
            outcome: "started",
            label: "explore",
            detail: "Survey the Events tab consumers.",
            anchor: "call:tc-7",
          },
        ],
      );
      expect(spawn).toMatchObject({
        kind: "subagent",
        outcome: "started",
        label: "explore",
        detail: "Survey the Events tab consumers.",
        anchor: "call:tc-7",
      });
    });
  });

  describe("EventsPanel", () => {
    const recorded: SessionEventRecord[] = [
      planEvent(),
      { id: "choice-2", type: "choice", ts: 1_800, turn: 2, outcome: "pick", label: "Option B" },
    ];

    const renderPanel = (onJump = vi.fn()) => {
      render(<EventsPanel messages={messages} events={recorded} onJump={onJump} />);
      return onJump;
    };

    it("shows every type in one timeline", () => {
      renderPanel();
      const rows = Array.from(document.querySelectorAll(".ctx-evt"));
      expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
        "turn",
        "plan",
        "choice",
        "turn",
      ]);
    });

    it("jumps to the row's turn when its body is clicked", () => {
      const onJump = renderPanel();
      const turnRow = document.querySelector('.ctx-evt[data-kind="turn"]');
      fireEvent.click(
        within(turnRow as HTMLElement).getByRole("button", { name: "Jump to turn 1" }),
      );
      expect(onJump).toHaveBeenCalledWith({ turn: 1 });
      expect(turnRow?.getAttribute("data-active")).toBe("true");
    });

    it("jumps to the event's own card when the record carries an anchor", () => {
      // A plan/choice/fold row must land on its card, not on the prompt bubble of
      // the turn that happened to be open when it fired.
      const onJump = vi.fn();
      render(
        <EventsPanel
          messages={messages}
          events={[planEvent({ anchor: "call:p1" })]}
          onJump={onJump}
        />,
      );
      const planRow = document.querySelector('.ctx-evt[data-kind="plan"]');
      fireEvent.click(
        within(planRow as HTMLElement).getByRole("button", { name: "Jump to this event" }),
      );
      expect(onJump).toHaveBeenCalledWith({ turn: 1, anchor: "call:p1" });
    });

    it("carries both ids a card answers to, so a live chat can still land on it", () => {
      const onJump = vi.fn();
      render(
        <EventsPanel
          messages={messages}
          events={[planEvent({ anchor: "call:call-loop-7", anchorAlias: "call:tc-7" })]}
          onJump={onJump}
        />,
      );
      const planRow = document.querySelector('.ctx-evt[data-kind="plan"]');
      fireEvent.click(
        within(planRow as HTMLElement).getByRole("button", { name: "Jump to this event" }),
      );
      expect(onJump).toHaveBeenCalledWith({
        turn: 1,
        anchor: "call:call-loop-7",
        anchorAlias: "call:tc-7",
      });
    });

    it("keeps an anchored row clickable when it has no turn", () => {
      const onJump = vi.fn();
      render(
        <EventsPanel
          messages={[]}
          events={[planEvent({ turn: 0, anchor: "call:p1" })]}
          onJump={onJump}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Jump to this event" }));
      expect(onJump).toHaveBeenCalledWith({ turn: 0, anchor: "call:p1" });
    });

    it("leaves the row unmarked when the chat could not go there", () => {
      // A rewound session still lists its verdicts; a turn that is gone must not
      // leave a row claiming to be the reader's place.
      render(<EventsPanel messages={messages} events={[]} onJump={() => false} />);
      const turnRow = document.querySelector('.ctx-evt[data-kind="turn"]');
      fireEvent.click(
        within(turnRow as HTMLElement).getByRole("button", { name: "Jump to turn 1" }),
      );
      expect(turnRow?.getAttribute("data-active")).toBe("false");
    });

    it("expands a row's details from its chevron, not from the row", () => {
      const onJump = renderPanel();
      const [chevron] = screen.getAllByRole("button", { name: "Show event details" });
      expect(chevron?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector(".ctx-evt-body")).toBeNull();
      fireEvent.click(chevron!);
      expect(chevron?.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector(".ctx-evt-body")).not.toBeNull();
      // Expanding is not a jump: the chevron never scrolls the chat.
      expect(onJump).not.toHaveBeenCalled();
      fireEvent.click(chevron!);
      expect(document.querySelector(".ctx-evt-body")).toBeNull();
    });

    it("lists the options a choice was picked from, marking the winner", () => {
      render(
        <EventsPanel
          messages={[]}
          events={[
            {
              id: "choice-9",
              type: "choice",
              ts: 1_000,
              turn: 1,
              outcome: "pick",
              label: "Verify the Events tab myself",
              detail: "What should I do next?",
              options: ["Stop here", "Verify the Events tab myself"],
            },
          ]}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
      const rows = Array.from(document.querySelectorAll(".ctx-evt-options li"));
      expect(rows.map((row) => row.textContent)).toEqual([
        "Stop here",
        "Verify the Events tab myself",
      ]);
      expect(rows.map((row) => row.getAttribute("data-picked"))).toEqual(["false", "true"]);
      // The pick is marked in the list; repeating it below would duplicate it.
      const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
        (el) => el.textContent,
      );
      expect(details).toEqual(["What should I do next?"]);
    });

    it("still shows a typed answer, which no offered option covers", () => {
      render(
        <EventsPanel
          messages={[]}
          events={[
            {
              id: "choice-10",
              type: "choice",
              ts: 1_000,
              turn: 1,
              outcome: "text",
              label: "Neither, do Z instead",
              options: ["Do X", "Do Y"],
            },
          ]}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
      expect(document.querySelectorAll(".ctx-evt-options li[data-picked]")).toHaveLength(2);
      const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
        (el) => el.textContent,
      );
      expect(details).toContain("Neither, do Z instead");
    });

    it("shows a plan's body and checklist when expanded", () => {
      render(
        <EventsPanel
          messages={[]}
          events={[
            {
              id: "plan-9",
              type: "plan",
              ts: 1_000,
              turn: 1,
              outcome: "approve",
              label: "QuickSend polish",
              body: "## QuickSend polish\n\nCloses four gaps.",
              steps: ["Route strings through i18n", "Collision-proof ids"],
            },
          ]}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
      const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
        (el) => el.textContent,
      );
      expect(details).toContain("## QuickSend polish\n\nCloses four gaps.");
      expect(details).toContain("QuickSend polish");
      const steps = Array.from(document.querySelectorAll(".ctx-evt-steps li")).map(
        (el) => el.textContent,
      );
      expect(steps).toEqual(["Route strings through i18n", "Collision-proof ids"]);
    });

    it("does not repeat a label that a body already carries", () => {
      // A row written by another build can hold both; the panel must not print the
      // plan twice just because the record does.
      render(
        <EventsPanel
          messages={[]}
          events={[
            {
              id: "plan-11",
              type: "plan",
              ts: 1_000,
              turn: 1,
              outcome: "approve",
              label: "Only the body",
              body: "Only the body",
            },
          ]}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show event details" }));
      const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
        (el) => el.textContent,
      );
      expect(details).toEqual(["Only the body"]);
    });

    it("leaves a row without a turn unclickable", () => {
      render(<EventsPanel messages={[]} events={[planEvent({ turn: 0 })]} onJump={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /Jump to/ })).toBeNull();
      expect(document.querySelector(".ctx-evt-body")).toBeNull();
      expect(document.querySelector(".ctx-evt-main")).toBeTruthy();
    });

    it("labels every row with its own event type", () => {
      renderPanel();
      const labels = Array.from(document.querySelectorAll(".ctx-evt")).map(
        (row) => row.querySelector(".ctx-evt-kind")?.textContent,
      );
      // No count/filter bar: the type is each row's own tag.
      expect(labels).toEqual(["User", "Plan", "Choice", "User"]);
      expect(document.querySelector(".ctx-evt-types")).toBeNull();
    });

    it("shows a subagent spawn as its own row, tagged and jumpable", () => {
      const onJump = vi.fn();
      render(
        <EventsPanel
          messages={[]}
          events={[
            {
              id: "subagent-tc-7",
              type: "subagent",
              ts: 1_000,
              turn: 1,
              outcome: "started",
              label: "explore",
              detail: "Survey the Events tab consumers.",
              anchor: "call:tc-7",
            },
          ]}
          onJump={onJump}
        />,
      );
      const row = document.querySelector('.ctx-evt[data-kind="subagent"]') as HTMLElement;
      expect(row.querySelector(".ctx-evt-kind")?.textContent).toBe("Subagent");
      expect(row.querySelector(".ctx-evt-label")?.textContent).toBe("started · explore");
      fireEvent.click(within(row).getByRole("button", { name: "Jump to this event" }));
      expect(onJump).toHaveBeenCalledWith({ turn: 1, anchor: "call:tc-7" });
      // The instruction is the row's body: a spawn's task is the point of the row.
      fireEvent.click(within(row).getByRole("button", { name: "Show event details" }));
      const details = Array.from(document.querySelectorAll(".ctx-evt-detail")).map(
        (el) => el.textContent,
      );
      expect(details).toContain("Survey the Events tab consumers.");
    });

    it("shows what a settled subagent came back with, not just that it finished", () => {
      render(
        <EventsPanel
          messages={[]}
          events={[
            {
              id: "subagent-tc-8",
              type: "subagent",
              ts: 1_000,
              turn: 1,
              outcome: "done",
              label: "explore",
              detail: "Survey the Events tab consumers.",
              result: "Three consumers, all of them eagers.\n\nbudget exhausted",
              anchor: "call:tc-8",
            },
          ]}
          onJump={vi.fn()}
        />,
      );
      const row = document.querySelector('.ctx-evt[data-kind="subagent"]') as HTMLElement;
      // Collapsed, the row stays one line: the answer is in the details.
      expect(document.querySelector(".ctx-evt-result")).toBeNull();
      fireEvent.click(within(row).getByRole("button", { name: "Show event details" }));
      const result = row.querySelector(".ctx-evt-result");
      expect(result?.querySelector(".ctx-evt-key")?.textContent).toBe("Result");
      // Whole, line breaks and all: a partial run's note is part of what it reported.
      expect(result?.querySelector(".ctx-evt-detail")?.textContent).toBe(
        "Three consumers, all of them eagers.\n\nbudget exhausted",
      );
    });

    it("says so when a session has nothing recorded yet", () => {
      render(<EventsPanel messages={[]} events={[]} />);
      expect(document.querySelectorAll(".ctx-evt")).toHaveLength(0);
      expect(document.querySelector(".ctx-empty")?.textContent).toBe(
        "No events in this session yet.",
      );
    });
  });
});

describe("changelog", () => {
  afterEach(cleanup);

  const RELEASES: ChangelogRelease[] = groupReleases([
    { sha: "aaa1111", subject: "fix(desktop): center image zoom", date: "2026-01-05T00:00:00Z" },
    { sha: "bbb2222", subject: "chore(release): v1.0.27", date: "2026-01-04T00:00:00Z" },
    { sha: "ccc3333", subject: "feat(chat): add inline audio", date: "2026-01-03T00:00:00Z" },
    { sha: "ddd4444", subject: "chore: bump a dependency", date: "2026-01-02T00:00:00Z" },
  ]);

  function state(over: Partial<ChangelogState> = {}): ChangelogState {
    return { releases: RELEASES, version: "1.0.27", error: null, loaded: true, ...over };
  }

  describe("PageChangelog", () => {
    it("fetches once on mount and not again on re-render", () => {
      const onRefresh = vi.fn();
      const { rerender } = render(<PageChangelog changelog={state()} onRefresh={onRefresh} />);
      expect(onRefresh).not.toHaveBeenCalled();

      rerender(<PageChangelog changelog={state()} onRefresh={onRefresh} />);
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it("fetches when nothing has loaded yet", () => {
      const onRefresh = vi.fn();
      render(<PageChangelog changelog={state({ loaded: false })} onRefresh={onRefresh} />);
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Loading changelog…")).toBeTruthy();
    });

    it("groups commits under their release version, newest first", () => {
      render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);

      expect(screen.getByText("Unreleased")).toBeTruthy();
      expect(screen.getByText("v1.0.27")).toBeTruthy();
      expect(screen.getByText("center image zoom")).toBeTruthy();
      expect(screen.getByText("add inline audio")).toBeTruthy();
    });

    it("marks the installed version", () => {
      render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);
      expect(screen.getAllByText("installed")).toHaveLength(1);
    });

    it("renders maintenance commits without a toggle", () => {
      render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);

      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.getByText("bump a dependency")).toBeTruthy();
      expect(screen.getByText("Maintenance")).toBeTruthy();
    });

    it("never renders a release marker as a change", () => {
      const { container } = render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);
      expect(container.textContent).not.toContain("chore(release)");
    });

    it("collapses and expands a release on click", () => {
      render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);
      expect(screen.getByText("add inline audio")).toBeTruthy();

      fireEvent.click(screen.getByText("v1.0.27"));
      expect(screen.queryByText("add inline audio")).toBeNull();

      fireEvent.click(screen.getByText("v1.0.27"));
      expect(screen.getByText("add inline audio")).toBeTruthy();
    });

    it("forces a refetch from the refresh button", () => {
      const onRefresh = vi.fn();
      render(<PageChangelog changelog={state()} onRefresh={onRefresh} />);
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(onRefresh).toHaveBeenCalledWith(true);
    });

    it("shows the failure and a retry when nothing could be loaded", () => {
      const onRefresh = vi.fn();
      render(
        <PageChangelog
          changelog={state({ releases: [], error: "Network unreachable", loaded: true })}
          onRefresh={onRefresh}
        />,
      );
      expect(screen.getByText(/Couldn't load the changelog: Network unreachable/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRefresh).toHaveBeenCalledWith(true);
    });

    it("flags a stale cached copy while still showing its releases", () => {
      render(<PageChangelog changelog={state({ error: "offline" })} onRefresh={vi.fn()} />);
      expect(screen.getByText("Showing a cached copy")).toBeTruthy();
      expect(screen.getByText("center image zoom")).toBeTruthy();
    });
  });
});

describe("card-head", () => {
  afterEach(cleanup);

  // The name slot ellipsises by default; `wrapName` is how a card opts out of that
  // (approval cards put the whole ask_choice question there).
  describe("CardHead name wrapping", () => {
    const headFor = (props: { wrapName?: boolean } = {}) =>
      render(
        <CardHead
          icon={null}
          kind="tool"
          name="A very long card name"
          open
          onToggle={() => {}}
          {...props}
        />,
      ).container.querySelector(".card-head");

    it("keeps the name on one line by default", () => {
      expect(headFor()?.hasAttribute("data-wrap")).toBe(false);
    });

    it("marks the head as wrapping when asked", () => {
      expect(headFor({ wrapName: true })?.getAttribute("data-wrap")).toBe("true");
    });
  });

  // The title and its `sub` prose must never share one row: a long summary takes a
  // full-width row below (styled by `.card-head .sub`) instead of squeezing the
  // title slot to nothing. A short `meta` chip stays on the title line.
  describe("CardHead sub row", () => {
    const headFor = (sub?: string) =>
      render(
        <CardHead icon={null} kind="plan" name="Start plan" sub={sub} open onToggle={() => {}} />,
      ).container.querySelector(".card-head");

    it("renders no sub row when there is nothing to say", () => {
      expect(headFor()?.querySelector(".sub")).toBeNull();
    });

    it("keeps the sub outside the title line so it wraps on its own", () => {
      const sub = headFor("Bound the frontend at ten workspaces")?.querySelector(".sub");
      expect(sub?.textContent).toBe("Bound the frontend at ten workspaces");
      expect(sub?.closest(".card-head-top")).toBeNull();
    });

    it("keeps a chip on the title line while the prose drops below it", () => {
      const head = render(
        <CardHead
          icon={null}
          kind="plan"
          name="Start plan"
          meta="2 options"
          sub="A plan summary"
          open
          onToggle={() => {}}
        />,
      ).container.querySelector(".card-head");
      expect(head?.querySelector(".card-head-top .meta")?.textContent).toBe("2 options");
      expect(head?.querySelector(".card-head-top .sub")).toBeNull();
      expect(head?.querySelector(".sub")?.textContent).toBe("A plan summary");
    });
  });
});

describe("composer-menu-headers", () => {
  /** Every composer dropdown: model, subagent model, reasoning effort, quick send. */
  const MENU_TRIGGERS = [".model-pill", ".subagent-pill", ".effort-pill", ".quick-proceed-btn"];

  describe("Composer dropdown headers", () => {
    it("shows the menu label alone, with no glyph chip beside it", () => {
      const { container } = render(
        <Composer
          {...makeComposerBaseProps({ supportedEfforts: ["low", "high"], subagentsEnabled: true })}
        />,
      );

      for (const selector of MENU_TRIGGERS) {
        const trigger = container.querySelector<HTMLButtonElement>(selector);
        expect(trigger, selector).not.toBeNull();
        fireEvent.click(trigger!);

        const header = container.querySelector(".popup .ph");
        expect(header, selector).not.toBeNull();
        // Trigger tooltip and header label come from one i18n key, so this pins
        // both to the plain label in any language. Any child would be a chip.
        expect(header?.textContent, selector).toBe(trigger?.getAttribute("title"));
        expect(header?.children.length, selector).toBe(0);

        fireEvent.click(trigger!);
        expect(container.querySelector(".popup .ph"), selector).toBeNull();
      }
    });

    it("hides the subagent picker on a session minted without the subagent tool", () => {
      // The capability is frozen at chat creation, so the pill is absent rather than
      // disabled: a disabled picker would imply a switch the session cannot have.
      const { container } = render(<Composer {...makeComposerBaseProps()} />);
      expect(container.querySelector(".subagent-pill")).toBeNull();
      expect(container.querySelector(".model-pill:not(.subagent-pill)")).not.toBeNull();
    });

    it("drops the open subagent menu when the session loses the capability", () => {
      // A session switch can take the pill away mid-interaction; the click that
      // reopened a chat with the tool must not find the old popup already showing.
      const props = makeComposerBaseProps({ subagentsEnabled: true });
      const { container, rerender } = render(<Composer {...props} />);
      fireEvent.click(container.querySelector(".subagent-pill")!);
      expect(container.querySelector(".popup")).not.toBeNull();

      rerender(<Composer {...makeComposerBaseProps()} />);
      expect(container.querySelector(".subagent-pill")).toBeNull();
      rerender(<Composer {...props} />);
      expect(container.querySelector(".popup")).toBeNull();
    });
  });
});

describe("composer-pill-space", () => {
  afterEach(cleanup);

  /** The pill is label + chevron. A leading glyph costs the width the label needs,
   *  so the only icon a closed pill keeps is the one that says "this opens". */
  describe("Composer pill width", () => {
    it("gives the label the whole pill, keeping the chevron as the only glyph", () => {
      const { container } = render(<Composer {...makeComposerBaseProps()} />);

      for (const selector of [".model-pill", ".effort-pill"]) {
        const pill = container.querySelector(selector);
        expect(pill, selector).not.toBeNull();
        expect(pill?.querySelectorAll("svg").length, selector).toBe(1);
        expect(pill?.textContent?.trim(), selector).not.toBe("");
      }
    });

    it("keeps a long model id whole as the label and as its hover title", () => {
      // FitText shrinks this label to the pill; the title is what stays readable.
      const model = "my-private-gateway-model-id";
      const { container } = render(<Composer {...makeComposerBaseProps({ modelLabel: model })} />);

      const label = container.querySelector(".model-pill span");
      expect(label?.textContent).toBe(model);
      expect(label?.getAttribute("title")).toBe(model);
    });

    it("opens a picker as bare rows, with no glyph beside a model or an effort", () => {
      const model = render(<Composer {...makeComposerBaseProps()} />);
      fireEvent.click(model.container.querySelector(".model-pill")!);
      const modelRows = Array.from(
        model.container.querySelectorAll(".model-menu-list .popup-item"),
      );
      expect(modelRows.length).toBeGreaterThan(0);
      for (const row of modelRows) expect(row.querySelector("svg")).toBeNull();

      const effort = render(
        <Composer {...makeComposerBaseProps({ supportedEfforts: ["low", "high"] })} />,
      );
      fireEvent.click(effort.container.querySelector(".effort-pill")!);
      const effortRows = Array.from(
        effort.container.querySelectorAll(".effort-menu-list .popup-item"),
      );
      expect(effortRows.length).toBeGreaterThan(0);
      for (const row of effortRows) expect(row.querySelector("svg")).toBeNull();
    });
  });
});

describe("fit-text", () => {
  afterEach(cleanup);

  describe("fitFontSize", () => {
    it("keeps the base size when the text already fits", () => {
      expect(fitFontSize({ available: 200, natural: 120, base: 14, min: 9 })).toBe(14);
      expect(fitFontSize({ available: 120, natural: 120, base: 14, min: 9 })).toBe(14);
    });

    it("scales down in proportion to the overflow", () => {
      expect(fitFontSize({ available: 300, natural: 420, base: 14, min: 9 })).toBe(10);
    });

    it("never goes below the floor, where the box's own ellipsis takes over", () => {
      expect(fitFontSize({ available: 60, natural: 600, base: 14, min: 9 })).toBe(9);
    });

    it("keeps the base size without layout metrics (jsdom, a hidden panel)", () => {
      expect(fitFontSize({ available: 0, natural: 0, base: 14, min: 9 })).toBe(14);
      expect(fitFontSize({ available: 0, natural: 400, base: 14, min: 9 })).toBe(14);
    });
  });

  describe("FitText", () => {
    it("renders the whole label and offers it as the hover title", () => {
      const { container } = render(<FitText text="DS · deepseek-v4-flash" />);
      const span = container.querySelector("span")!;

      expect(span.textContent).toBe("DS · deepseek-v4-flash");
      expect(span.title).toBe("DS · deepseek-v4-flash");
    });

    it("honours a caller's own title and class without layout", () => {
      const { container } = render(
        <FitText text="OC · big-pickle" title="OpenCode model" className="pill-label" />,
      );
      const span = container.querySelector("span")!;

      expect(span.title).toBe("OpenCode model");
      expect(span.className).toBe("pill-label");
      // No layout in jsdom: the text must still render at the fallback size.
      expect(span.textContent).toBe("OC · big-pickle");
    });
  });
});

describe("stop-button", () => {
  afterEach(cleanup);

  describe("StopButton", () => {
    it("shows the label and a stop icon when idle", () => {
      const { container } = render(
        <StopButton label="Close" title="Close it" iconSize={10} onClick={() => {}} />,
      );
      const btn = container.querySelector("button")!;
      expect(btn.textContent).toContain("Close");
      expect(btn.querySelector(".btn-throbber")).toBeNull();
      expect(btn.hasAttribute("disabled")).toBe(false);
    });

    it("swaps its content for a throbber and locks out clicks while busy", () => {
      const onClick = vi.fn();
      const { container } = render(
        <StopButton label="Close" title="Close it" iconSize={10} busy onClick={onClick} />,
      );
      const btn = container.querySelector("button")!;
      expect(btn.querySelector(".btn-throbber")).toBeTruthy();
      expect(btn.hasAttribute("disabled")).toBe(true);
      expect(btn.getAttribute("aria-busy")).toBe("true");
      fireEvent.click(btn);
      expect(onClick).not.toHaveBeenCalled();
    });

    it("invokes onClick once when idle", () => {
      const onClick = vi.fn();
      const { container } = render(<StopButton label="Stop" title="Stop it" onClick={onClick} />);
      fireEvent.click(container.querySelector("button")!);
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  function HookHarness({ done }: { done: boolean }) {
    const [pending, start] = usePendingStop(done);
    return (
      <button type="button" onClick={start} data-pending={pending}>
        go
      </button>
    );
  }

  describe("usePendingStop", () => {
    it("flips pending on start and clears the moment the stop completes", () => {
      const { container, rerender } = render(<HookHarness done={false} />);
      const btn = () => container.querySelector("button")!;
      expect(btn().dataset.pending).toBe("false");
      fireEvent.click(btn());
      expect(btn().dataset.pending).toBe("true");
      rerender(<HookHarness done={true} />);
      expect(btn().dataset.pending).toBe("false");
    });
  });
});
