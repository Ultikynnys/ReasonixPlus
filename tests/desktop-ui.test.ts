// Consolidated from 17 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { derivePrefix as fromCoreUtils, parseProviderRegistry } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextAbortDraftCandidate, restoreAbortedDraft } from "../desktop/src/abort-draft";
import {
  DEFAULT_COMPOSER_ROWS,
  getComposerTextareaSizing,
} from "../desktop/src/ui/composer-sizing";
import {
  type EmittableEvent,
  buildDesktopDiagnostic,
  buildLoadedMessages,
  compactTabContext,
  detectOllamaVision,
  fetchOllamaBalance,
  fetchOllamaPlan,
  fetchZaiQuota,
  installDesktopCrashGuards,
  isSubscriptionGatedResponse,
  manualCompactNotice,
  ollamaBalanceSnapshot,
  pickJobOwner,
  probeOllamaModel,
  probeOllamaVision,
  projectSubagentEvent,
  redactDesktopDiagnosticMessage,
  refreshOllamaModels,
  resetOllamaBalanceCacheForTest,
  resetOllamaCatalogCacheForTest,
  runManualCompact,
  showPayloadIsVision,
  showPayloadVisionCapability,
  writeAllSync,
} from "../src/cli/commands/desktop.js";
import type { CodexQuotaResult } from "../src/codex-backend.js";
import { deriveNativeOllamaOrigin } from "../src/config.js";
import { Eventizer } from "../src/core/eventize.js";
import { AccountQuotaCoordinator } from "../src/desktop/account-quota.js";
import {
  augmentProcessPath,
  resetLoginShellPathCache,
  resolveLoginShellPath,
} from "../src/desktop/login-shell-path.js";
import {
  QuotaCoordinator,
  fetchQuotaJson,
  quotaCacheKey,
  quotaCoordinator,
  resetQuotaCoordinators,
  usageUrls,
} from "../src/desktop/quota.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import {
  DEFAULT_OLLAMA_GENERATION_VALUES,
  emptyOllamaVerdicts,
  resolveOllamaModelDefaults,
  setVerdict,
  showPayloadParameters,
} from "../src/ollama-model-map.js";
import { estimateConversationTokens } from "../src/tokenizer.js";
import { derivePrefix as fromCliPath } from "../src/tools/shell/parse.js";
import type { SubagentEvent } from "../src/tools/subagent.js";
import { cssRule, cssRules, sourceFile, stylesCss } from "./support/css.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

describe("desktop-abort-draft", () => {
  describe("desktop abort draft restore", () => {
    it("restores interrupted text when the composer draft is empty", () => {
      expect(restoreAbortedDraft("", "rewrite the whole file")).toBe("rewrite the whole file");
    });

    it("does not overwrite a non-empty composer draft", () => {
      expect(restoreAbortedDraft("new idea", "old interrupted prompt")).toBeNull();
    });

    it("does not restore blank or missing interrupted text", () => {
      expect(restoreAbortedDraft("", "")).toBeNull();
      expect(restoreAbortedDraft("", "   ")).toBeNull();
      expect(restoreAbortedDraft("", null)).toBeNull();
    });

    it("records normal user input as the abort draft candidate", () => {
      expect(
        nextAbortDraftCandidate(null, {
          type: "record",
          source: "user_input",
          text: "  rewrite everything  ",
        }),
      ).toBe("rewrite everything");
    });

    it("records the typed text for skill runs", () => {
      expect(
        nextAbortDraftCandidate(null, {
          type: "record",
          source: "skill_run",
          text: "review src/App.tsx",
        }),
      ).toBe("review src/App.tsx");
    });

    it("does not record btw side questions as abort draft candidates", () => {
      expect(
        nextAbortDraftCandidate("stale", {
          type: "record",
          source: "btw",
          text: "what is the status?",
        }),
      ).toBeNull();
    });

    it("clears stale abort draft candidates", () => {
      const recorded = nextAbortDraftCandidate(null, {
        type: "record",
        source: "user_input",
        text: "keep me only while running",
      });

      expect(nextAbortDraftCandidate(recorded, { type: "clear" })).toBeNull();
    });
  });
});

describe("desktop-account-quota", () => {
  const result: CodexQuotaResult = {
    quota: { plan: "pro", fiveHour: null, weekly: null },
    reason: null,
  };

  describe("AccountQuotaCoordinator", () => {
    it("coalesces concurrent requests with delivery provenance and caches success", async () => {
      let resolve!: (value: CodexQuotaResult) => void;
      const fetcher = vi.fn(
        () =>
          new Promise<CodexQuotaResult>((done) => {
            resolve = done;
          }),
      );
      const started = vi.fn();
      const succeeded = vi.fn();
      const coordinator = new AccountQuotaCoordinator(fetcher, 15_000, Date.now, {
        started,
        succeeded,
      });
      const first = coordinator.fetch();
      const second = coordinator.fetch();
      expect(fetcher).toHaveBeenCalledTimes(1);
      resolve(result);
      await expect(first).resolves.toMatchObject({
        value: result,
        delivery: "underlying",
        requestId: 1,
      });
      await expect(second).resolves.toMatchObject({
        value: result,
        delivery: "shared",
        requestId: 1,
      });
      await expect(coordinator.fetch()).resolves.toMatchObject({ delivery: "cache", requestId: 1 });
      expect(started).toHaveBeenCalledOnce();
      expect(succeeded).toHaveBeenCalledOnce();
    });

    it("reports one underlying failure and leaves it retryable", async () => {
      const failure: CodexQuotaResult = { quota: null, reason: "offline" };
      const fetcher = vi.fn().mockResolvedValueOnce(failure).mockResolvedValue(result);
      const failed = vi.fn();
      const coordinator = new AccountQuotaCoordinator(fetcher, 15_000, Date.now, { failed });
      const [first, second] = await Promise.all([coordinator.fetch(), coordinator.fetch()]);
      expect(first.delivery).toBe("underlying");
      expect(second.delivery).toBe("shared");
      expect(failed).toHaveBeenCalledOnce();
      await expect(coordinator.fetch()).resolves.toMatchObject({ value: result });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("expires cached snapshots and coalesces forced requests", async () => {
      let now = 0;
      const fetcher = vi.fn().mockResolvedValue(result);
      const coordinator = new AccountQuotaCoordinator(fetcher, 100, () => now);
      await coordinator.fetch();
      now = 99;
      await coordinator.fetch();
      now = 101;
      await coordinator.fetch();
      await Promise.all([coordinator.fetch({ force: true }), coordinator.fetch({ force: true })]);
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
  });
});

describe("desktop-quota-transport", () => {
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 });

  const specOf = (overrides: Record<string, unknown>) => {
    const [spec] = parseProviderRegistry({
      providers: [
        {
          id: "future",
          providerId: "zai",
          label: "Future",
          shortLabel: "FUT",
          groupLabelKey: "composer.modelZaiGroup",
          order: 99,
          setupGate: ["apiKey"],
          precedence: null,
          defaultModel: null,
          knownCatalog: false,
          models: ["future-1"],
          endpoint: { strategy: "standard", default: "https://future.test/v1", tiers: {} },
          settings: [],
          usable: { apiKey: true, keylessLocal: false, always: false },
          discovery: {
            strategy: "models-endpoint",
            listField: "data",
            idField: "id",
            excludeSpeech: false,
          },
          client: { auth: "api-key", transport: null, allowMissingKey: false },
          ...overrides,
        },
      ],
    });
    if (!spec) throw new Error("fixture provider did not parse");
    return spec;
  };

  describe("fetchQuotaJson", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns the JSON body and stamps the Accept header", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ usage: 1 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        fetchQuotaJson({
          urls: ["https://api.future.test/usage"],
          headers: { Authorization: "Bearer k" },
        }),
      ).resolves.toEqual({ ok: true, body: { usage: 1 } });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.future.test/usage",
        expect.objectContaining({
          method: "GET",
          headers: { Accept: "application/json", Authorization: "Bearer k" },
        }),
      );
    });

    it("names the status, the body shape, the timeout and the network as one vocabulary", async () => {
      const cases: Array<[() => Promise<Response>, string]> = [
        [async () => new Response("nope", { status: 404 }), "http-404"],
        [
          async () =>
            new Response("not json", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          "malformed-json",
        ],
        [
          async () => {
            const error = new Error("aborted");
            error.name = "TimeoutError";
            throw error;
          },
          "timeout",
        ],
        [
          async () => {
            throw new Error("ECONNREFUSED");
          },
          "network",
        ],
      ];
      for (const [impl, reason] of cases) {
        vi.stubGlobal("fetch", vi.fn(impl));
        await expect(
          fetchQuotaJson({ urls: ["https://api.future.test/usage"] }),
        ).resolves.toMatchObject({ ok: false, reason });
      }
    });

    it("keeps the status and a capped body snippet for the probes that key on them", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("x".repeat(500), { status: 401 })),
      );
      const reply = await fetchQuotaJson({ urls: ["https://api.future.test/usage"] });
      expect(reply).toMatchObject({ ok: false, reason: "http-401", status: 401 });
      expect(reply).toHaveProperty("detail", "x".repeat(200));
    });

    it("walks the declared addresses in order and reports each one that refused", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("gone", { status: 410 }))
        .mockResolvedValueOnce(jsonResponse({ usage: 2 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        fetchQuotaJson({
          urls: ["https://one.test/a", "https://two.test/b"],
        }),
      ).resolves.toEqual({ ok: true, body: { usage: 2 } });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const bothFail = vi.fn(async () => new Response("gone", { status: 410 }));
      vi.stubGlobal("fetch", bothFail);
      await expect(
        fetchQuotaJson({ urls: ["https://one.test/a", "https://two.test/b"] }),
      ).resolves.toMatchObject({ ok: false, reason: "one.test/a http-410; two.test/b http-410" });
    });

    it("reports no-usage-url rather than throwing when a provider declares none", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchQuotaJson({ urls: [] })).resolves.toEqual({
        ok: false,
        reason: "no-usage-url",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("usageUrls", () => {
    it("rides the endpoint's origin so a chat path prefix never leaks into the usage route", () => {
      const spec = specOf({ usage: { probe: "zai-monitor", urls: ["/api/usage"] } });
      expect(usageUrls(spec, "https://api.future.test/api/paas/v4")).toEqual([
        "https://api.future.test/api/usage",
      ]);
    });

    it("keeps the configured base when the provider declares urlBase endpoint", () => {
      const spec = specOf({
        usage: { probe: "zai-monitor", urls: ["/user/balance"], urlBase: "endpoint" },
      });
      expect(usageUrls(spec, "https://api.future.test/v1")).toEqual([
        "https://api.future.test/v1/user/balance",
      ]);
    });

    it("passes an absolute address through untouched", () => {
      const spec = specOf({
        usage: { probe: "codex-oauth", urls: ["https://chatgpt.com/backend-api/wham/usage"] },
      });
      expect(usageUrls(spec, "https://api.future.test/v1")).toEqual([
        "https://chatgpt.com/backend-api/wham/usage",
      ]);
    });

    it("yields nothing for a host the provider does not declare when the gate asks it to", () => {
      const spec = specOf({
        usage: { probe: "opencode-usage", urls: ["/zen/go/v1/usage"], urlGate: "declared-hosts" },
        errors: { hosts: ["future.test"] },
      });
      expect(usageUrls(spec, "https://future.test/zen/go/v1")).toEqual([
        "https://future.test/zen/go/v1/usage",
      ]);
      // A custom proxy must never be handed the account's token for a usage read, so
      // it gets no address to fetch at all — not a bare path a caller might still try.
      expect(usageUrls(spec, "https://proxy.example/v1")).toEqual([]);
      // A look-alike suffix is not the declared host.
      expect(usageUrls(spec, "https://notfuture.test/v1")).toEqual([]);
    });

    it("answers nothing for a provider with no declared address or an unparseable base", () => {
      const spec = specOf({ usage: { probe: "antigravity-quota" } });
      expect(usageUrls(spec, "https://api.future.test/v1")).toEqual([]);
      const declared = specOf({ usage: { probe: "zai-monitor", urls: ["/api/usage"] } });
      expect(usageUrls(declared, "not a url")).toEqual([]);
      expect(usageUrls(undefined, "https://api.future.test/v1")).toEqual([]);
    });
  });

  describe("quotaCoordinator", () => {
    afterEach(() => {
      resetQuotaCoordinators();
    });

    it("reuses one coordinator per probe, endpoint and credential fingerprint", () => {
      const fetcher = vi.fn(async () => "value");
      const outcome = { hasData: () => true };
      const first = quotaCoordinator("probe|https://a.test|k1", 60_000, fetcher, outcome);
      const again = quotaCoordinator("probe|https://a.test|k1", 60_000, fetcher, outcome);
      expect(again).toBe(first);
      const other = quotaCoordinator("probe|https://a.test|k2", 60_000, fetcher, outcome);
      expect(other).not.toBe(first);
    });

    it("keys on a hash so a raw credential never reaches the cache key", () => {
      const key = quotaCacheKey("zai-monitor", "https://api.z.ai", "sk-secret-key");
      expect(key).toContain("zai-monitor|https://api.z.ai|");
      expect(key).not.toContain("sk-secret-key");
      expect(quotaCacheKey("zai-monitor", "https://api.z.ai", "other-key")).not.toBe(key);
      expect(quotaCacheKey("zai-monitor", "https://api.z.ai", "")).toContain("|anonymous");
    });

    it("rebinds the fetcher so a rotated credential is used, not the closure it was born with", async () => {
      const stale = vi.fn(async () => "expired-token");
      const fresh = vi.fn(async () => "rotated-token");
      // The key omits the credential (a token rotates hourly and the cache should
      // survive it), so only the rebind can keep the read on the live token.
      const first = quotaCoordinator("probe|project|", 0, stale, { hasData: () => true });
      expect((await first.fetch()).value).toBe("expired-token");
      const again = quotaCoordinator("probe|project|", 0, fresh, { hasData: () => true });
      expect(again).toBe(first);
      expect((await again.fetch()).value).toBe("rotated-token");
      expect(stale).toHaveBeenCalledTimes(1);
    });

    it("stays bounded when credentials keep rotating", async () => {
      const outcome = { hasData: () => true };
      const made: ReturnType<typeof quotaCoordinator<string>>[] = [];
      for (let i = 0; i < 40; i += 1) {
        made.push(quotaCoordinator(`probe|x|k${i}`, 60_000, async () => String(i), outcome));
      }
      // Old entries are evicted (they only lose a warm cache, never correctness)...
      const oldest = quotaCoordinator("probe|x|k0", 60_000, async () => "k0", outcome);
      expect(made).not.toContain(oldest);
      // ... and a fresh entry still works.
      expect((await oldest.fetch()).value).toBe("k0");
    });

    it("reports a no-data reply to the observer while still caching it for the floor", async () => {
      const failed = vi.fn();
      const fetcher = vi.fn(async () => undefined);
      const coordinator = new QuotaCoordinator<undefined>(
        fetcher,
        60_000,
        {
          hasData: (value) => value !== undefined,
          reason: () => "http-429",
        },
        Date.now,
        { failed },
      );
      await coordinator.fetch();
      expect(failed).toHaveBeenCalledWith(1, "http-429");
      // A rate-limited endpoint must not be re-asked by every tab in the burst.
      const second = await coordinator.fetch();
      expect(second.delivery).toBe("cache");
      expect(fetcher).toHaveBeenCalledTimes(1);
      // ... but a click (force) goes back out.
      await coordinator.fetch({ force: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("leaves a reply out of the cache when the probe says it is not cacheable", async () => {
      const fetcher = vi.fn(async () => null);
      const coordinator = new QuotaCoordinator<null>(fetcher, 60_000, {
        hasData: () => false,
        cacheable: () => false,
      });
      await coordinator.fetch();
      await coordinator.fetch();
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});

describe("desktop-approval-card-title-wrap", () => {
  // The ask_choice card puts the agent's whole question in the shared `.card-head`
  // name slot, where it used to ellipsis-truncate to a single line and hide the
  // question. Wrapping is opt-in per heading (`data-wrap`), so the compact tool and
  // thinking rows keep their one-line name.
  describe("desktop card heading name slot", () => {
    it("wraps a heading that opts in instead of truncating it", () => {
      const name = cssRules('.card-head[data-wrap="true"] .name').join("\n");
      expect(name).toContain("white-space: normal");
      expect(name).toContain("overflow-wrap: anywhere");
    });

    it("top-aligns a wrapped heading so the icon stays beside the first line", () => {
      expect(cssRule('.card-head[data-wrap="true"] .card-head-top')).toContain(
        "align-items: flex-start",
      );
    });

    it("leaves every other heading on a single ellipsised line", () => {
      const name = cssRule(".card-head .name");
      expect(name).toContain("white-space: nowrap");
      expect(name).toContain("text-overflow: ellipsis");
    });
  });

  // A plan-confirmation summary used to ride the title row as a nowrap chip: it
  // clipped at the card edge and squeezed the title to nothing. Prose now owns a
  // wrapping row of its own, and only a short chip stays on the title row.
  describe("desktop card heading prose row", () => {
    it("wraps prose on its own row instead of clipping it", () => {
      const sub = cssRules(".card-head .sub").join("\n");
      expect(sub).toContain("white-space: normal");
      expect(sub).toContain("overflow-wrap: anywhere");
      expect(sub).toContain("min-width: 0");
    });

    it("indents the prose row from the head's icon tokens, not a copy of their width", () => {
      expect(cssRules(".card-head .sub").join("\n")).toContain(
        "padding-left: calc(var(--head-icon) + var(--head-gap))",
      );
      expect(cssRule(".card-head .ico")).toContain("width: var(--head-icon)");
      expect(cssRule(".card-head-top")).toContain("gap: var(--head-gap)");
    });

    it("keeps a long chip from pushing the title and chevron off the card", () => {
      const meta = cssRule(".card-head .meta");
      expect(meta).toContain("min-width: 0");
      expect(meta).not.toContain("flex-shrink: 0");
    });
  });
});

describe("desktop-card-row-window", () => {
  /** Every rule in the sheet that sets an element's row height, with its body: the
   *  ones that participate in the shared `--scroll-rows` math. */
  function rowHeightRules(): { selector: string; body: string }[] {
    const bare = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
    return [...bare.matchAll(/^([^{}]+)\{([^}]*)\}/gm)].flatMap(([, selector, body]) =>
      (body ?? "").includes("--scroll-line")
        ? [{ selector: (selector ?? "").trim(), body: body ?? "" }]
        : [],
    );
  }

  // Every long card body (thinking, shell output, plan confirmation, subagent) is
  // windowed to the same number of rows and scrolls itself. jsdom has no layout
  // engine, so the contract is pinned on the real stylesheet: one shared rule owns
  // the cap, and no card redeclares its own.
  describe("desktop shared card row window", () => {
    it("caps the shared window at --scroll-rows rows of the box's line-height", () => {
      const rule = cssRule(".row-scroll");
      expect(rule).toContain("--scroll-rows: 6");
      expect(rule).toContain("max-height: calc(var(--scroll-rows) * var(--scroll-line) * 1em)");
    });

    it("derives the line-height from the same variable as the cap, so they cannot drift", () => {
      const rule = cssRule(".row-scroll");
      expect(rule).toContain("--scroll-line: 1.6");
      expect(rule).toContain("line-height: var(--scroll-line)");
    });

    it("scrolls the overflow instead of truncating it, with a pinned-tail friendly box", () => {
      const rule = cssRule(".row-scroll");
      expect(rule).toContain("overflow-y: auto");
      expect(rule).toContain("overscroll-behavior: contain");
      expect(rule).toContain("overflow-anchor: none");
      // Content-box keeps a card's padding outside the row cap.
      expect(rule).toContain("box-sizing: content-box");
    });

    it("leaves the thinking stream on the shared cap instead of its own pixel height", () => {
      const rule = cssRules(".reason .stream").join("\n");
      expect(rule).not.toContain("max-height");
      expect(rule).toContain("--scroll-line: 1.7");
    });

    it("leaves the shell stream on the shared cap instead of its own pixel height", () => {
      const rule = cssRules(".shell .stream").join("\n");
      expect(rule).not.toContain("max-height");
      expect(rule).not.toContain("line-height:");
    });

    it("gives an approval body the row cap and its line-height from one variable", () => {
      const rule = cssRule(".approval .ap-body");
      expect(rule).toContain("--scroll-line: 1.6");
      expect(rule).toContain("line-height: var(--scroll-line)");
    });

    it("keeps the auto-approve countdown on screen while a windowed body scrolls", () => {
      const rule = cssRule(".row-scroll .ap-timer");
      expect(rule).toContain("position: sticky");
      expect(rule).toContain("top: 0");
    });

    // The guard that keeps the cap honest, and keeps itself current: whichever rule
    // sets a card's row height must take its line-height from the same variable the
    // cap multiplies. A literal line-height would silently show a different number
    // of rows than the rule claims.
    it("lets no card declare a line-height the cap does not follow", () => {
      const participants = rowHeightRules();
      expect(participants.map((p) => p.selector)).toEqual(
        expect.arrayContaining([".row-scroll", ".reason .stream", ".approval .ap-body"]),
      );
      for (const { selector, body } of participants) {
        for (const declaration of body.split(";")) {
          const trimmed = declaration.trim();
          if (!trimmed.startsWith("line-height:")) continue;
          expect(`${selector} ${trimmed}`).toBe(`${selector} line-height: var(--scroll-line)`);
        }
      }
    });
  });
});

describe("desktop-composer-autosize", () => {
  // The composer must hold a fixed height and never resize (#1594 regression):
  // it previously expanded past a five-row threshold, so the box jumped as the
  // user typed across that boundary.
  describe("desktop composer textarea never resizes", () => {
    const height = DEFAULT_COMPOSER_ROWS * 20 + 18;

    it("uses CSS sizing and native overflow without per-render layout measurement", () => {
      const composer = sourceFile("desktop/src/ui/composer.tsx");
      const textareaRule = cssRule(".composer textarea");
      expect(textareaRule).toContain("height: calc(2 * 1.55em + 18px)");
      expect(textareaRule).toContain("overflow-y: auto");
      expect(composer).not.toContain("applyComposerTextareaSize");
    });

    it("holds the fixed height for a single line", () => {
      const sizing = getComposerTextareaSizing({
        contentRows: 1,
        lineHeightPx: 20,
        verticalPaddingPx: 18,
      });

      expect(sizing.heightPx).toBe(height);
      expect(sizing.overflowY).toBe("hidden");
    });

    it("keeps the same height regardless of how much content is typed", () => {
      for (const contentRows of [1, 2, 3, 5, 10, 20]) {
        const sizing = getComposerTextareaSizing({
          contentRows,
          lineHeightPx: 20,
          verticalPaddingPx: 18,
        });

        expect(sizing.heightPx).toBe(height);
      }
    });

    it("scrolls inside the box instead of growing once content overflows", () => {
      const fits = getComposerTextareaSizing({
        contentRows: DEFAULT_COMPOSER_ROWS,
        lineHeightPx: 20,
        verticalPaddingPx: 18,
      });
      const overflows = getComposerTextareaSizing({
        contentRows: DEFAULT_COMPOSER_ROWS + 1,
        lineHeightPx: 20,
        verticalPaddingPx: 18,
      });

      expect(fits.overflowY).toBe("hidden");
      expect(overflows.overflowY).toBe("auto");
      expect(overflows.heightPx).toBe(height);
    });
  });
});

// #1074 — the desktop sidecar must survive an unhandled rejection / uncaught exception rather than exit(1) (which Tauri surfaces as "reasonix exited (code 1)" and forces a full reconnect).
describe("desktop-crash-guards", () => {
  function snapshotListeners() {
    return {
      unhandled: process.listeners("unhandledRejection").slice(),
      uncaught: process.listeners("uncaughtException").slice(),
    };
  }

  function restoreListeners(snap: ReturnType<typeof snapshotListeners>) {
    for (const l of process.listeners("unhandledRejection")) {
      if (!snap.unhandled.includes(l)) process.off("unhandledRejection", l);
    }
    for (const l of process.listeners("uncaughtException")) {
      if (!snap.uncaught.includes(l)) process.off("uncaughtException", l);
    }
  }

  describe("desktop diagnostics", () => {
    it("redacts credentials and data URLs while keeping actionable errors", () => {
      const message = redactDesktopDiagnosticMessage(
        "Bearer secret access_token=oauth-secret data:image/png;base64,abc sk-proj-key",
      );
      expect(message).not.toContain("secret");
      expect(message).not.toContain("oauth-secret");
      expect(message).not.toContain("abc");
      expect(message).toContain("redacted");
    });

    it("builds a timestamped structured event without message content in details", () => {
      const event = buildDesktopDiagnostic(
        "turn.started",
        { session: "desktop-session", textChars: 12 },
        { tabId: "t1", level: "info", message: "ready" },
      );
      expect(event).toMatchObject({
        type: "$diagnostic",
        source: "daemon",
        event: "turn.started",
        level: "info",
        message: "ready",
        details: { session: "desktop-session", textChars: 12 },
      });
      expect(event.ts).toMatch(/T/);
    });
  });

  describe("installDesktopCrashGuards", () => {
    let snap: ReturnType<typeof snapshotListeners>;

    beforeEach(() => {
      snap = snapshotListeners();
    });
    afterEach(() => {
      restoreListeners(snap);
    });

    it("registers one unhandledRejection + one uncaughtException listener", () => {
      installDesktopCrashGuards();
      expect(process.listeners("unhandledRejection").length).toBe(snap.unhandled.length + 1);
      expect(process.listeners("uncaughtException").length).toBe(snap.uncaught.length + 1);
    });

    it("forwards rejection reasons to the injected stderr sink", () => {
      const writes: string[] = [];
      const fakeStderr = { write: (s: string) => writes.push(s) };
      installDesktopCrashGuards(fakeStderr);

      // Find the freshly-installed listener and call it directly — actually
      // emitting the event would race with vitest's own watchers.
      const installed = process.listeners("unhandledRejection").at(-1) as (reason: unknown) => void;
      installed(new Error("synthetic boom"));

      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("[desktop] unhandledRejection");
      expect(writes[0]).toContain("synthetic boom");
    });

    it("coerces non-Error rejection reasons", () => {
      const writes: string[] = [];
      installDesktopCrashGuards({ write: (s: string) => writes.push(s) });
      const installed = process.listeners("unhandledRejection").at(-1) as (reason: unknown) => void;
      installed("plain string");
      expect(writes[0]).toContain("plain string");
    });

    it("forwards uncaughtException to the same sink", () => {
      const writes: string[] = [];
      installDesktopCrashGuards({ write: (s: string) => writes.push(s) });
      const installed = process.listeners("uncaughtException").at(-1) as (err: Error) => void;
      installed(new Error("synthetic crash"));
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain("[desktop] uncaughtException");
      expect(writes[0]).toContain("synthetic crash");
    });
  });
});

// Regression net for issue #1180 — `derivePrefix` must not drift between the CLI
// *  re-export path and the direct core-utils import path (used by Desktop).
describe("desktop-edge", () => {
  describe("derivePrefix parity — CLI path vs core-utils path", () => {
    const cases = [
      "ls",
      "npm test",
      "npm install lodash",
      "git status",
      "git commit -m hi",
      "cargo add serde",
      "docker run --rm foo",
      "python3 -m pytest tests/",
      "node script.js",
      "./build.sh --release",
      "",
      "   ",
    ];

    it("re-export path and core-utils path return identical results for all cases", () => {
      for (const cmd of cases) {
        expect(fromCliPath(cmd)).toBe(fromCoreUtils(cmd));
      }
    });
  });
});

// // jsdom has no layout engine, so the one-line backup row is pinned against the real
// // stylesheet: index, picker and buttons must share a single non-wrapping line.
describe("desktop-fallbacks-layout", () => {
  describe("desktop backup-model rows", () => {
    const row = ".rule.fallback-row";

    it("lays the index, picker and buttons out on one line", () => {
      const css = cssRule(row);
      expect(css).toContain("display: flex");
      expect(css).toContain("align-items: center");
      // Wrapping is what pushed the index and the buttons above the picker.
      expect(css).toContain("flex-wrap: nowrap");
    });

    it("lets the picker take the free width instead of the shared field width", () => {
      const css = cssRule(".fallback-row .fallback-select");
      expect(css).toContain("flex: 1 1 auto");
      expect(css).toContain("width: auto");
      // Without this a long model id would push the buttons out of the row.
      expect(css).toContain("min-width: 0");
    });

    it("keeps the index and the buttons at their own size", () => {
      expect(cssRule(".fallback-row .fallback-index")).toContain("flex: 0 0 auto");
      const actions = cssRule(".fallback-row .fallback-actions");
      expect(actions).toContain("flex: 0 0 auto");
      expect(actions).toContain("display: flex");
      expect(actions).toContain("align-items: center");
    });
  });
});

// // Background-job Close/Stop routing: pickJobOwner must target the owning tab.
// // Job ids restart at 1 in every per-tab registry, so a global first-match can
// // land on another tab's (often already-exited) job and the stop silently no-ops.
describe("desktop-jobs", () => {
  function owner(tabId: string, ids: number[]) {
    return { tabId, jobIds: new Set(ids), owner: { tabId } };
  }

  describe("pickJobOwner (jobs_stop targets the owning tab)", () => {
    it("prefers the named tab when the job id collides across tabs", () => {
      const a = owner("A", [7]);
      const b = owner("B", [7]);
      expect(pickJobOwner([a, b], 7, "B")).toBe(b.owner);
      expect(pickJobOwner([a, b], 7, "A")).toBe(a.owner);
    });

    it("keeps first-match when no tab is supplied (legacy callers)", () => {
      const a = owner("A", [7]);
      const b = owner("B", [7]);
      expect(pickJobOwner([a, b], 7, undefined)).toBe(a.owner);
    });

    it("returns nothing for an unknown tab or a missing job id", () => {
      const owners = [owner("A", [1, 2]), owner("B", [3])];
      expect(pickJobOwner(owners, 3, "A")).toBeUndefined();
      expect(pickJobOwner(owners, 9, undefined)).toBeUndefined();
    });
  });
});

// #1252 — GUI launches don't run shell init; verify the login-shell PATH augment behaves.
describe("desktop-login-shell-path", () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  describe("desktop login-shell PATH (#1252)", () => {
    beforeEach(() => {
      resetLoginShellPathCache();
    });

    afterEach(() => {
      resetLoginShellPathCache();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      process.env.PATH = originalPath;
      process.env.SHELL = originalShell;
    });

    it("resolveLoginShellPath returns null on Windows (no-op there)", () => {
      setPlatform("win32");
      expect(resolveLoginShellPath()).toBeNull();
    });

    it("augmentProcessPath is a no-op on Windows", () => {
      setPlatform("win32");
      process.env.PATH = "C:\\bar";
      const result = augmentProcessPath();
      expect(result.added).toEqual([]);
      expect(process.env.PATH).toBe("C:\\bar");
    });

    it("resolveLoginShellPath returns null when the shell probe times out", () => {
      if (process.platform === "win32") {
        // Behaviour exercised in test above; the actual probe path doesn't run on win32.
        return;
      }
      process.env.SHELL = "/bin/sh";
      const out = resolveLoginShellPath({ timeoutMs: 1 });
      expect(out === null || out === "" || typeof out === "string").toBe(true);
    });

    it("augmentProcessPath is idempotent — re-running adds nothing", () => {
      setPlatform("linux");
      process.env.PATH = "/already:/seen";
      resetLoginShellPathCache();
      augmentProcessPath();
      const after1 = process.env.PATH;
      augmentProcessPath();
      expect(process.env.PATH).toBe(after1);
    });
  });
});

describe("desktop-manual-compact", () => {
  type TabArg = Parameters<typeof compactTabContext>[0];

  describe("manualCompactNotice", () => {
    it("uses the compaction warning text for the success card", () => {
      const events = [
        {
          type: "warning",
          turn: 1,
          severity: "high",
          text: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
        },
      ] as unknown as Parameters<typeof manualCompactNotice>[0];
      expect(manualCompactNotice(events)).toEqual({
        text: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
        severity: "success",
      });
    });

    it("appends the compacted summary carried on the warning event", () => {
      const events = [
        {
          type: "warning",
          turn: 2,
          severity: "high",
          text: "Context compacted (summary): 1,000 tokens -> 400 tokens.",
          compactionSummary: "Goal: ship X.\nNext: run tests.",
        },
      ] as unknown as Parameters<typeof manualCompactNotice>[0];
      expect(manualCompactNotice(events).text).toBe(
        "Context compacted (summary): 1,000 tokens -> 400 tokens.\n\nGoal: ship X.\nNext: run tests.",
      );
    });

    it("returns a no-op info card when nothing was foldable", () => {
      const notice = manualCompactNotice([]);
      expect(notice.severity).toBe("info");
      expect(notice.text.toLowerCase()).toContain("nothing to compact");
    });
  });

  describe("compactTabContext", () => {
    function makeCompactTab(responses: FakeResponseShape[]) {
      const loop = new CacheFirstLoop({
        client: makeFakeClient(responses, { echoMessages: true }).client,
        prefix: new ImmutablePrefix({ system: "SYS" }),
        model: "deepseek-chat",
        stream: false,
      });
      const tab = {
        id: "tab-1",
        aborter: null,
        runtime: {
          loop,
          eventizer: new Eventizer(),
          ctx: { model: "deepseek-chat", prefixHash: "pfx", reasoningEffort: "high" },
        },
      } as unknown as TabArg;
      return { tab, loop };
    }

    it("runs compactNow and surfaces the compaction warning + retraction in chat", async () => {
      const { tab, loop } = makeCompactTab([
        { content: "rolling summary" },
        { content: "rolling summary verified" },
      ]);
      // Seed past the fold budget so compaction has older work to fold.
      for (let n = 0; n < 60 && estimateConversationTokens(loop.log.entries) < 30_000; n++) {
        const id = `seed-${n}`;
        loop.log.append({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "run_command", arguments: `{"command":"echo ${n}"}` },
            },
          ],
        });
        loop.log.append({
          role: "tool",
          tool_call_id: id,
          content: `output line for seed ${n}\n`.repeat(120),
        });
      }
      loop.log.append({ role: "user", content: "latest ask" });

      const events = await compactTabContext(tab);

      const warning = events.find((e) => e.type === "warning");
      expect(warning).toBeTruthy();
      expect((warning as unknown as { text: string }).text).toContain("Context compacted");
      expect(events.some((e) => e.type === "session.retracted")).toBe(true);
      // The newest prompt survives compaction.
      expect(loop.log.entries.some((m) => m.role === "user" && m.content === "latest ask")).toBe(
        true,
      );
    });

    it("returns no events when the tab has no runtime", async () => {
      const events = await compactTabContext({
        id: "x",
        aborter: null,
        runtime: null,
      } as unknown as TabArg);
      expect(events).toEqual([]);
    });
  });

  describe("runManualCompact", () => {
    function makeCompactTab(responses: FakeResponseShape[]) {
      const loop = new CacheFirstLoop({
        client: makeFakeClient(responses, { echoMessages: true }).client,
        prefix: new ImmutablePrefix({ system: "SYS" }),
        model: "deepseek-chat",
        stream: false,
      });
      const tab = {
        id: "tab-1",
        aborter: null,
        compactingManual: false,
        runtime: {
          loop,
          eventizer: new Eventizer(),
          ctx: { model: "deepseek-chat", prefixHash: "pfx", reasoningEffort: "high" },
        },
      } as unknown as TabArg;
      return { tab, loop };
    }

    function seedBigLog(loop: CacheFirstLoop) {
      for (let n = 0; n < 60 && estimateConversationTokens(loop.log.entries) < 30_000; n++) {
        const id = `seed-${n}`;
        loop.log.append({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "run_command", arguments: `{"command":"echo ${n}"}` },
            },
          ],
        });
        loop.log.append({
          role: "tool",
          tool_call_id: id,
          content: `output line for seed ${n}\n`.repeat(120),
        });
      }
      loop.log.append({ role: "user", content: "latest ask" });
    }

    it("aborts a live turn and waits for cleanup before starting compaction", async () => {
      const { tab, loop } = makeCompactTab([
        { content: "rolling summary" },
        { content: "rolling summary verified" },
      ]);
      seedBigLog(loop);
      const aborter = new AbortController();
      tab.aborter = aborter;
      let finish!: () => void;
      tab.turnCleanup = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const abort = vi.spyOn(loop, "abort");
      const compact = vi.spyOn(loop, "compactNow");
      const events: EmittableEvent[] = [];
      const work = runManualCompact(tab, (ev) => {
        events.push(ev);
      });
      await Promise.resolve();
      expect(aborter.signal.aborted).toBe(true);
      expect(abort).toHaveBeenCalledOnce();
      expect(compact).not.toHaveBeenCalled();
      // Only the fold-state sync lands before the running work unwinds — no chat
      // events until the fold actually starts.
      expect(events.every((e) => e.type === "$tab_status")).toBe(true);
      finish();
      await work;

      expect(events.find((e) => e.type === "compaction.started")).toMatchObject({
        type: "compaction.started",
        trigger: "manual",
      });
      expect(events.some((e) => e.type === "session.retracted")).toBe(true);
      expect(events.some((e) => e.type === "$notice")).toBe(true);
    });

    it("emits the retraction payload as the post-compaction live log", async () => {
      const { tab, loop } = makeCompactTab([
        { content: "rolling summary" },
        { content: "rolling summary verified" },
      ]);
      seedBigLog(loop);
      // Simulate a streaming turn appending after the fold applied but before
      // the events are converted: the payload must reflect the live log, not
      // the summarizer's snapshot.
      const origCompact = loop.compactNow.bind(loop);
      vi.spyOn(loop, "compactNow").mockImplementation(async (opts) => {
        const outcome = await origCompact(opts);
        loop.log.append({ role: "user", content: "appended after fold" });
        return outcome;
      });

      const events: EmittableEvent[] = [];
      await runManualCompact(tab, (ev) => {
        events.push(ev);
      });

      const retracted = events.find(
        (e): e is Extract<EmittableEvent, { type: "session.retracted" }> =>
          e.type === "session.retracted",
      );
      // Wire projection of the live log (tool pairs merged, synthetic records
      // skipped) — not the fold snapshot.
      expect(retracted?.replacementMessages).toEqual(buildLoadedMessages([...loop.log.entries]));
      expect(
        retracted?.replacementMessages?.some((m) =>
          JSON.stringify(m).includes("appended after fold"),
        ),
      ).toBe(true);
    });

    it("waits for active work and releases the barrier after a failed fold", async () => {
      const { tab, loop } = makeCompactTab([]);
      let finish!: () => void;
      tab.activeTurn = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const compact = vi.spyOn(loop, "compactNow").mockRejectedValue(new Error("fold failed"));
      const events: EmittableEvent[] = [];
      const work = runManualCompact(tab, (ev) => {
        events.push(ev);
      });
      const barrier = tab.manualCompactDone;
      expect(tab.compactingManual).toBe(true);
      await Promise.resolve();
      expect(compact).not.toHaveBeenCalled();
      finish();
      await work;
      await barrier;
      expect(events.find((e) => e.type === "$error")).toMatchObject({
        type: "$error",
        message: "compact failed: fold failed",
      });
      expect(tab.compactingManual).toBe(false);
      expect(tab.manualCompactDone).toBeUndefined();
    });

    it("no-ops on a second click while compaction is running", async () => {
      const { tab, loop } = makeCompactTab([
        { content: "rolling summary" },
        { content: "rolling summary verified" },
      ]);
      seedBigLog(loop);

      const first: EmittableEvent[] = [];
      const second: EmittableEvent[] = [];
      const p1 = runManualCompact(tab, (ev) => {
        first.push(ev);
      });
      const p2 = runManualCompact(tab, (ev) => {
        second.push(ev);
      });
      await Promise.all([p1, p2]);

      expect(second).toEqual([]);
      expect(first.some((e) => e.type === "compaction.started")).toBe(true);
      expect(first.some((e) => e.type === "$notice")).toBe(true);
    });
  });
});

describe("desktop-mcp-settings-layout", () => {
  describe("desktop MCP settings layout", () => {
    it("keeps long MCP specs inside the card instead of widening the modal", () => {
      expect(cssRule(".scard .mcp-spec-body")).toContain("min-width: 0");
      expect(cssRule(".scard .mcp-spec-body")).toContain("flex: 1 1 auto");
      expect(cssRule(".scard .mcp-spec-summary")).toContain("overflow-wrap: anywhere");
      expect(cssRule(".scard .mcp-spec-summary")).toContain("word-break: break-word");
      expect(cssRule(".scard .mcp-remove")).toContain("flex: 0 0 auto");
    });
  });
});

describe("desktop-models-settings-layout", () => {
  // A provider card's settings column is only half a card wide, so a description
  // and a button sharing one row overflow it — the OpenCode "Sign in" button was
  // clipped at the card edge. Any row with a button in that column must stack:
  // description full width, controls on their own line below. jsdom has no layout
  // engine, so pin the CSS contract the way the MCP-settings and composer layout
  // tests do — deleting or un-stacking the rule fails here.
  describe("desktop models settings layout", () => {
    const row = ".provider-col .setting-row:has(button)";

    it("stacks a description and a button so a button row never overflows the column", () => {
      expect(cssRule(row)).toContain("flex-direction: column");
      expect(cssRule(row)).toContain("align-items: stretch");
    });

    it("gives the description full width and drops the controls to their own line", () => {
      expect(cssRule(`${row} > .l`)).toContain("width: 100%");
      expect(cssRule(`${row} > :not(.l)`)).toContain("align-self: flex-start");
    });
  });
});

// Ollama account-plan lookup + subscription-gated model probing.
describe("desktop-ollama-models", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function textResponse(body: string, status = 200): Response {
    return new Response(body, { status });
  }

  describe("fetchOllamaPlan", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("posts {origin}/api/me with the Bearer key and returns the Plan", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ Plan: "free" }));
      await expect(fetchOllamaPlan("https://ollama.com/v1", "key-1")).resolves.toBe("free");
      const [, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.origin).toBe("https://ollama.com");
      expect(url.pathname).toBe("/api/me");
      expect(init).toMatchObject({
        method: "POST",
        headers: { Authorization: "Bearer key-1" },
        body: "{}",
      });
    });

    it("returns undefined when the payload has no Plan field", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ID: "x", Name: "y" }));
      await expect(fetchOllamaPlan("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined when the endpoint is not ollama.com (404 / 405)", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
      await expect(fetchOllamaPlan("https://gateway.example/v1", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined on network errors", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(fetchOllamaPlan("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined for a malformed base URL without calling fetch", async () => {
      await expect(fetchOllamaPlan("not a url", "key-1")).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("probeOllamaModel", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("sends a 1-token chat and returns ok on 200", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "x" } }] }));
      await expect(probeOllamaModel("https://ollama.com/v1", "gpt-oss:20b", "key-1")).resolves.toBe(
        "ok",
      );
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://ollama.com/v1/chat/completions");
      expect(init).toMatchObject({
        method: "POST",
        headers: { Authorization: "Bearer key-1" },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      });
    });

    it("returns gated for a 403 subscription response", async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            error: { message: "this model requires a subscription, upgrade for access" },
          }),
          403,
        ),
      );
      await expect(probeOllamaModel("https://ollama.com/v1", "minimax-m3", "key-1")).resolves.toBe(
        "gated",
      );
    });

    it("returns gated for the Pro/Max/Team plan 403 variant", async () => {
      fetchMock.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            error: {
              message:
                "this model requires both a Pro, Max, or Team plan and extra usage (it does not use included plan usage), upgrade for access: https://ollama.com/upgrade",
            },
          }),
          403,
        ),
      );
      await expect(probeOllamaModel("https://ollama.com/v1", "kimi-k3", "key-1")).resolves.toBe(
        "gated",
      );
    });

    it("returns error for a 403 that is not about subscriptions", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("forbidden", 403));
      await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
    });

    it("retries a rate-limited probe once and honors the retried response", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("rate limited", 429));
      fetchMock.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({ error: { message: "this model requires a subscription" } }),
          403,
        ),
      );
      await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("gated");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns error when the 429 retry also fails", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("rate limited", 429));
      fetchMock.mockResolvedValueOnce(textResponse("still rate limited", 429));
      await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns error for 5xx so transient failures never hide a model", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("boom", 503));
      await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
    });

    it("returns error on network failures", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(probeOllamaModel("https://ollama.com/v1", "m", "key-1")).resolves.toBe("error");
    });
  });

  describe("isSubscriptionGatedResponse", () => {
    it("is true only for a 403 carrying subscription language", () => {
      expect(isSubscriptionGatedResponse(403, "this model requires a subscription")).toBe(true);
      expect(
        isSubscriptionGatedResponse(
          403,
          "this model requires both a Pro, Max, or Team plan, upgrade for access",
        ),
      ).toBe(true);
      expect(isSubscriptionGatedResponse(403, "forbidden")).toBe(false);
      expect(isSubscriptionGatedResponse(429, "this model requires a subscription")).toBe(false);
    });
  });

  describe("deriveNativeOllamaOrigin", () => {
    it("strips a trailing /v1 from a local daemon base", () => {
      expect(deriveNativeOllamaOrigin("http://localhost:11434/v1")).toBe("http://localhost:11434");
    });

    it("strips a trailing /v1 from the cloud base", () => {
      expect(deriveNativeOllamaOrigin("https://ollama.com/v1")).toBe("https://ollama.com");
    });

    it("leaves a non-/v1 path untouched", () => {
      expect(deriveNativeOllamaOrigin("https://ollama.com")).toBe("https://ollama.com");
      expect(deriveNativeOllamaOrigin("http://gateway.example/proxy/v1")).toBe(
        "http://gateway.example/proxy",
      );
    });

    it("returns the input on a malformed URL", () => {
      expect(deriveNativeOllamaOrigin("not a url")).toBe("not a url");
    });
  });

  describe("showPayloadIsVision", () => {
    it("is true when projector_info is present and non-empty", () => {
      expect(showPayloadIsVision({ projector_info: { arch: "clip" } })).toBe(true);
    });

    it("is true when model_info carries a vision.* key", () => {
      expect(
        showPayloadIsVision({ model_info: { "vision.projector.embedding_length": 1024 } }),
      ).toBe(true);
    });

    it("is true when the capabilities array lists vision", () => {
      expect(showPayloadIsVision({ capabilities: ["completion", "vision"] })).toBe(true);
    });

    it("is false when the capabilities array omits vision", () => {
      expect(showPayloadIsVision({ capabilities: ["completion", "tools"] })).toBe(false);
    });

    it("is false for a text-only model", () => {
      expect(
        showPayloadIsVision({
          model_info: { "general.architecture": "llama" },
          projector_info: {},
        }),
      ).toBe(false);
    });

    it("is false for null / non-object / missing fields", () => {
      expect(showPayloadIsVision(null)).toBe(false);
      expect(showPayloadIsVision(undefined)).toBe(false);
      expect(showPayloadIsVision("x")).toBe(false);
      expect(showPayloadIsVision({})).toBe(false);
    });
  });

  describe("showPayloadVisionCapability", () => {
    it("trusts a non-empty capabilities array either way", () => {
      expect(showPayloadVisionCapability({ capabilities: ["completion", "vision"] })).toBe(true);
      expect(showPayloadVisionCapability({ capabilities: ["completion"] })).toBe(false);
    });

    it("is true for a vision projector or a family-scoped vision.* key", () => {
      expect(showPayloadVisionCapability({ projector_info: { arch: "clip" } })).toBe(true);
      expect(showPayloadVisionCapability({ model_info: { "gemma4.vision.block_count": 16 } })).toBe(
        true,
      );
    });

    it("is undefined when no authoritative marker is present", () => {
      expect(
        showPayloadVisionCapability({ model_info: { "general.architecture": "llama" } }),
      ).toBeUndefined();
      expect(showPayloadVisionCapability({})).toBeUndefined();
      expect(showPayloadVisionCapability(null)).toBeUndefined();
    });
  });

  describe("showPayloadParameters", () => {
    it("parses valid Modelfile parameter lines", () => {
      const raw = [
        "stop <|im_start|>",
        "temperature 0.65",
        "top_p 0.95",
        "top_k 50",
        "min_p 0.05",
        "seed 1234",
        "repeat_penalty 1.25",
        "repeat_last_n 128",
        "frequency_penalty 0.1",
        "presence_penalty 0.2",
      ].join("\n");
      expect(showPayloadParameters({ parameters: raw })).toEqual({
        temperature: 0.65,
        topP: 0.95,
        topK: 50,
        minP: 0.05,
        seed: 1234,
        repeatPenalty: 1.25,
        repeatLastN: 128,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
      });
    });

    it("returns undefined for empty, missing, or malformed parameters", () => {
      expect(showPayloadParameters(null)).toBeUndefined();
      expect(showPayloadParameters({})).toBeUndefined();
      expect(showPayloadParameters({ parameters: "" })).toBeUndefined();
      expect(showPayloadParameters({ parameters: "   \n# comment only" })).toBeUndefined();
    });
  });

  describe("resolveOllamaModelDefaults", () => {
    it("returns standard Ollama defaults when store is empty", () => {
      const store = emptyOllamaVerdicts();
      expect(resolveOllamaModelDefaults("llama3.2", store)).toEqual(
        DEFAULT_OLLAMA_GENERATION_VALUES,
      );
    });

    it("merges learned model parameters with base defaults", () => {
      const store = emptyOllamaVerdicts();
      setVerdict(
        store,
        "free",
        "http://localhost:11434|12345678",
        "custom-model",
        "ok",
        Date.now(),
        false,
        8192,
        { temperature: 0.3, topP: 0.8 },
      );
      const resolved = resolveOllamaModelDefaults("custom-model", store);
      expect(resolved.temperature).toBe(0.3);
      expect(resolved.topP).toBe(0.8);
      expect(resolved.topK).toBe(40);
      expect(resolved.repeatPenalty).toBe(1.1);
    });
  });

  describe("probeOllamaVision / detectOllamaVision", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("probeOllamaVision returns true on a 2xx", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
      await expect(probeOllamaVision("http://localhost:11434/v1", "llava", "")).resolves.toBe(true);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("http://localhost:11434/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContainEqual({
        type: "image_url",
        image_url: { url: expect.stringContaining("data:image/png;base64,") },
      });
    });

    it("probeOllamaVision returns false on a 400 (text-only model)", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("image not supported", 400));
      await expect(probeOllamaVision("http://localhost:11434/v1", "llama3.1", "")).resolves.toBe(
        false,
      );
    });

    it("probeOllamaVision returns undefined on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(
        probeOllamaVision("http://localhost:11434/v1", "m", ""),
      ).resolves.toBeUndefined();
    });

    it("detectOllamaVision trusts the native /api/show metadata first", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ projector_info: { arch: "clip" } }));
      await expect(detectOllamaVision("http://localhost:11434/v1", "llava", "")).resolves.toBe(
        true,
      );
      const url = String(fetchMock.mock.calls[0]![0]);
      expect(url).toBe("http://localhost:11434/api/show?model=llava");
      expect(fetchMock).toHaveBeenCalledTimes(1); // no probe fallback
    });

    it("detectOllamaVision falls back to the image probe when /api/show 404s", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] })); // probe → 2xx
      await expect(detectOllamaVision("https://ollama.com/v1", "llava", "key")).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("detectOllamaVision follows the probe to false when the model rejects the image", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
      fetchMock.mockResolvedValueOnce(textResponse("bad", 400)); // probe → text-only
      await expect(detectOllamaVision("https://ollama.com/v1", "llama3.1", "key")).resolves.toBe(
        false,
      );
    });

    it("detectOllamaVision reads the modern capabilities array without probing", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "vision"] }));
      await expect(
        detectOllamaVision("https://ollama.com/v1", "deepseek-v4.1-flash:cloud", "key"),
      ).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1); // capabilities trusted, no probe
    });

    it("detectOllamaVision probes when a 200 /api/show carries no vision marker", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ model_info: { "general.architecture": "deepseek4" } }),
      );
      fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] })); // probe → 2xx
      await expect(
        detectOllamaVision("https://ollama.com/v1", "deepseek-v4.1-flash:cloud", "key"),
      ).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2); // native payload inconclusive → probe
    });
  });

  describe("fetchOllamaBalance", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("GETs {origin}/api/balance with the Bearer key and maps both windows", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          included: {
            session: { remaining_percent: 71.9, resets_at: "2026-10-08T04:00:00Z" },
            weekly: { remaining_percent: 32.33, resets_at: "2026-10-12T00:00:00Z" },
          },
          purchased: { balance_usd: 0 },
        }),
      );
      await expect(fetchOllamaBalance("https://ollama.com/v1", "key-1")).resolves.toEqual({
        session: { remainingPct: 71.9, resetsAt: Date.parse("2026-10-08T04:00:00Z") },
        weekly: { remainingPct: 32.33, resetsAt: Date.parse("2026-10-12T00:00:00Z") },
        purchasedUsd: 0,
      });
      const [, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.origin).toBe("https://ollama.com");
      expect(url.pathname).toBe("/api/balance");
      expect(init).toMatchObject({
        method: "GET",
        headers: { Authorization: "Bearer key-1" },
      });
    });

    it("returns only the windows the payload carries (session-only)", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ included: { session: { remaining_percent: 50 } } }),
      );
      await expect(fetchOllamaBalance("https://ollama.com/v1", "key-1")).resolves.toEqual({
        session: { remainingPct: 50, resetsAt: null },
        weekly: null,
        purchasedUsd: null,
      });
    });

    it("ignores a non-numeric remaining_percent", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ included: { session: { remaining_percent: "50" }, weekly: {} } }),
      );
      await expect(fetchOllamaBalance("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined when neither window parses", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ purchased: { balance_usd: 5 } }));
      await expect(fetchOllamaBalance("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined on non-ok status", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("not found", 404));
      await expect(
        fetchOllamaBalance("https://gateway.example/v1", "key-1"),
      ).resolves.toBeUndefined();
    });

    it("returns undefined on network errors", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(fetchOllamaBalance("https://ollama.com/v1", "key-1")).resolves.toBeUndefined();
    });
  });

  describe("ollamaBalanceSnapshot — coalesced, TTL-cached account fetch", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      resetOllamaBalanceCacheForTest();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      resetOllamaBalanceCacheForTest();
    });
    const ok = () =>
      jsonResponse({
        included: { session: { remaining_percent: 40 } },
        purchased: { balance_usd: 0 },
      });

    it("coalesces concurrent callers onto a single request", async () => {
      fetchMock.mockResolvedValueOnce(ok());
      const [a, b] = await Promise.all([
        ollamaBalanceSnapshot("https://ollama.com/v1", "k", false),
        ollamaBalanceSnapshot("https://ollama.com/v1", "k", false),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(a.fetched).toBe(true);
      expect(b.fetched).toBe(false);
      expect(a.balance?.session?.remainingPct).toBe(40);
    });

    it("reuses the cached value within the TTL — no second request", async () => {
      fetchMock.mockResolvedValueOnce(ok());
      await ollamaBalanceSnapshot("https://ollama.com/v1", "k", false);
      const second = await ollamaBalanceSnapshot("https://ollama.com/v1", "k", false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second.fetched).toBe(false);
    });

    it("force bypasses the cache", async () => {
      fetchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
      await ollamaBalanceSnapshot("https://ollama.com/v1", "k", false);
      const forced = await ollamaBalanceSnapshot("https://ollama.com/v1", "k", true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(forced.fetched).toBe(true);
    });

    it("caches a failure so a tab burst retries at most once per TTL", async () => {
      fetchMock.mockResolvedValueOnce(textResponse("too many requests", 429));
      const first = await ollamaBalanceSnapshot("https://ollama.com/v1", "k", false);
      expect(first.balance).toBeUndefined();
      expect(first.fetched).toBe(true);
      const second = await ollamaBalanceSnapshot("https://ollama.com/v1", "k", false);
      expect(second.fetched).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockResolvedValueOnce(ok());
      await ollamaBalanceSnapshot("https://ollama.com/v1", "k", true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("refreshOllamaModels — app-global catalog cache", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    /** Catalog fetches only — the plan re-check (`POST {origin}/api/me`) is a
     *  legitimate extra request when a key is configured, so assertions count
     *  `GET {base}/models` calls, not every fetch. */
    const modelsFetchCount = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/models")).length;
    beforeEach(() => {
      resetOllamaCatalogCacheForTest();
      process.env.OLLAMA_API_KEY = undefined;
      process.env.ollamaApiKey = undefined;
      process.env.OLLAMA_BASE_URL = "https://ollama.test/v1";
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      process.env.OLLAMA_BASE_URL = undefined;
      vi.unstubAllGlobals();
      resetOllamaCatalogCacheForTest();
    });

    it("dedupes concurrent refreshes onto one fetch", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: [{ id: "qwen3:32b" }, { id: "llama3.1:latest" }] })),
      );
      const first = refreshOllamaModels(true);
      const second = refreshOllamaModels(true);
      // Both calls join the same in-flight fetch — no second request, and both
      // resolve to the same catalog.
      const [a, b] = await Promise.all([first, second]);
      expect(a).toEqual(b);
      await expect(first).resolves.toMatchObject({
        models: ["llama3.1:latest", "qwen3:32b"], // sorted
      });
      expect(modelsFetchCount()).toBe(1);
    });

    it("serves a fresh cache on non-force calls without hitting the network", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: [{ id: "llama3.1:latest" }] })),
      );
      await refreshOllamaModels(true);
      expect(modelsFetchCount()).toBe(1);

      await expect(refreshOllamaModels(false)).resolves.toMatchObject({
        models: ["llama3.1:latest"],
      });
      expect(modelsFetchCount()).toBe(1); // cache hit within the TTL
    });

    it("force bypasses the cache and refetches", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: [{ id: "llama3.1:latest" }] })),
      );
      await refreshOllamaModels(true);
      await refreshOllamaModels(false); // cached
      await refreshOllamaModels(true); // forced
      expect(modelsFetchCount()).toBe(2);
    });

    it("never caches an error snapshot — the next call retries", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      const snap = await refreshOllamaModels(true);
      expect(snap.error).toContain("Ollama unreachable");
      expect(modelsFetchCount()).toBe(1);

      // The error is broadcast but not cached, so a plain call refetches
      // instead of serving a stale failure.
      await refreshOllamaModels(false);
      expect(modelsFetchCount()).toBe(2);
    });

    it("carries visionModels probed from the native /api/show", async () => {
      // Keyless local daemon: catalog + one native /api/show per model.
      fetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.endsWith("/models")) {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "llava" }, { id: "llama3.1:latest" }] }),
          );
        }
        // Native /api/show — llava is vision, llama3.1 is text-only.
        if (u.includes("/api/show?model=llava")) {
          return Promise.resolve(jsonResponse({ projector_info: { arch: "clip" } }));
        }
        if (u.includes("/api/show?model=")) {
          return Promise.resolve(jsonResponse({ model_info: { "general.architecture": "llama" } }));
        }
        return Promise.resolve(textResponse("unexpected", 500));
      });
      const snap = await refreshOllamaModels(true);
      expect(snap.visionModels).toEqual(["llava"]);
      expect(snap.models).toEqual(["llama3.1:latest", "llava"]);
    });

    it("falls back to cached models on flaky internet failure", async () => {
      // First fetch succeeds and populates cache
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ data: [{ id: "deepseek-v4.1-flash" }, { id: "llama3.1:latest" }] }),
        ),
      );
      const initial = await refreshOllamaModels(true);
      expect(initial.models).toEqual(["deepseek-v4.1-flash", "llama3.1:latest"]);
      expect(initial.error).toBeUndefined();

      // Second fetch fails due to flaky internet / network disconnect
      fetchMock.mockRejectedValue(new Error("fetch failed"));
      const fallback = await refreshOllamaModels(true);

      // Fallback returns cached models AND reports the error
      expect(fallback.models).toEqual(["deepseek-v4.1-flash", "llama3.1:latest"]);
      expect(fallback.error).toContain("fetch failed");
    });
  });
});

describe("desktop-stdout-write", () => {
  describe("desktop stdout writes", () => {
    it("continues after partial writes and EAGAIN", () => {
      const input = Buffer.from('{"type":"$session_loaded","messages":["large"]}\n', "utf8");
      const chunks: Buffer[] = [];
      let calls = 0;
      let waits = 0;

      writeAllSync(1, input, {
        write: (_fd, buffer, offset, length) => {
          calls++;
          if (calls === 1) {
            const written = Math.min(4, length);
            chunks.push(Buffer.from(buffer.subarray(offset, offset + written)));
            return written;
          }
          if (calls === 2) {
            const err = new Error("try again") as NodeJS.ErrnoException;
            err.code = "EAGAIN";
            throw err;
          }
          chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
          return length;
        },
        wait: () => {
          waits++;
        },
      });

      expect(Buffer.concat(chunks).toString("utf8")).toBe(input.toString("utf8"));
      expect(calls).toBe(3);
      expect(waits).toBe(1);
    });
  });
});

describe("desktop-subagent-progress", () => {
  function innerEvent(inner: NonNullable<SubagentEvent["inner"]>): SubagentEvent {
    return {
      kind: "inner",
      runId: "sub-1",
      task: "review changes",
      skillName: "review",
      model: "deepseek-v4-flash",
      inner,
    };
  }

  describe("desktop subagent progress projection", () => {
    it("sends the instruction a spawn started with whole, and previews after it", () => {
      const instruction = `Diagnose a Unicorn emulation crash in this repo and prescribe the exact fix. ${"Detail ".repeat(40)}`;
      const start = projectSubagentEvent({
        kind: "start",
        runId: "sub-1",
        task: instruction,
        skillName: "explore",
      });
      // The card shows the child's task in full: the wire must not cut it.
      expect(start?.task).toBe(instruction);
      expect(start?.task.length).toBeGreaterThan(120);

      // Later events repeat the task at progress rate, so those stay previews.
      const later = projectSubagentEvent({
        kind: "stream-progress",
        runId: "sub-1",
        task: `${instruction.slice(0, 30)}…`,
        outputChars: 10,
      });
      expect(later?.task).toBe(`${instruction.slice(0, 30)}…`);
    });

    it("carries the dispatch wave size on the start event, so a card can call it parallel or sequential", () => {
      const start = projectSubagentEvent({
        kind: "start",
        runId: "sub-1",
        task: "review changes",
        waveSize: 3,
      });
      expect(start?.waveSize).toBe(3);
      // Only the start carries it: later ticks must not invent a mode for a run.
      const later = projectSubagentEvent({
        kind: "stream-progress",
        runId: "sub-1",
        task: "review changes",
        outputChars: 12,
      });
      expect(later?.waveSize).toBeUndefined();
    });

    it("still redacts credentials in the full task", () => {
      const start = projectSubagentEvent({
        kind: "start",
        runId: "sub-1",
        task: 'Fix it. curl -H "Authorization: Bearer sk-live-abc123" https://example.test',
      });
      expect(start?.task).toContain("Fix it.");
      expect(start?.task).not.toContain("sk-live-abc123");
    });

    it("projects lifecycle and monotonic counters", () => {
      expect(
        projectSubagentEvent({
          kind: "stream-progress",
          runId: "sub-1",
          task: "review changes",
          iter: 3,
          elapsedMs: 1200,
          contextTokens: 12_345,
          contextMax: 300_000,
          outputChars: 40,
          reasoningChars: 80,
          toolReadChars: 160,
        }),
      ).toMatchObject({
        action: "stream",
        runId: "sub-1",
        iter: 3,
        elapsedMs: 1200,
        contextTokens: 12_345,
        contextMax: 300_000,
        outputChars: 40,
        reasoningChars: 80,
        toolReadChars: 160,
      });
    });

    it("omits contextMax when the run does not report it (older tool versions)", () => {
      const projected = projectSubagentEvent({
        kind: "stream-progress",
        runId: "sub-legacy",
        task: "review changes",
        contextTokens: 4_000,
      });
      expect(projected).toMatchObject({ action: "stream", contextTokens: 4_000 });
      expect("contextMax" in projected).toBe(false);
    });

    it("retains parent identity on every live update", () => {
      expect(
        projectSubagentEvent({
          kind: "stream-progress",
          runId: "sub-associated",
          parentCallId: "parent-call",
          parentTurn: 7,
          task: "research docs",
          thought: "Checking the event bridge",
        }),
      ).toMatchObject({
        action: "stream",
        runId: "sub-associated",
        parentCallId: "parent-call",
        thought: "Checking the event bridge",
      });
    });

    it("projects configured budgets and exhaustion status", () => {
      expect(
        projectSubagentEvent({
          kind: "end",
          runId: "sub-1",
          task: "review changes",
          maxToolIters: 8,
          maxElapsedMs: 90_000,
          budgetExhausted: "tool-iters",
        }),
      ).toMatchObject({
        action: "end",
        maxToolIters: 8,
        maxElapsedMs: 90_000,
        budgetExhausted: "tool-iters",
      });
    });

    it("exposes redacted tool intent but never child reasoning or result bodies", () => {
      const start = projectSubagentEvent(
        innerEvent({
          turn: 1,
          role: "tool_start",
          content: "",
          reasoningDelta: "private chain of thought",
          callId: "call-1",
          toolName: "web_fetch",
          toolArgs: '{"authorization":"Bearer secret-token","url":"https://example.test"}',
        }),
      );
      expect(start).toMatchObject({
        action: "tool-start",
        childCallId: "call-1",
        toolName: "web_fetch",
      });
      expect(JSON.stringify(start)).not.toContain("private chain of thought");
      expect(JSON.stringify(start)).not.toContain("secret-token");

      const end = projectSubagentEvent(
        innerEvent({
          turn: 1,
          role: "tool",
          content: "sensitive tool result body",
          reasoningDelta: "more private reasoning",
          callId: "call-1",
          toolName: "web_fetch",
        }),
      );
      expect(end).toMatchObject({
        action: "tool-end",
        childCallId: "call-1",
        toolName: "web_fetch",
        toolOk: true,
      });
      expect(JSON.stringify(end)).not.toContain("sensitive tool result body");
      expect(JSON.stringify(end)).not.toContain("more private reasoning");
    });

    it("drops raw assistant events", () => {
      expect(
        projectSubagentEvent(
          innerEvent({
            turn: 1,
            role: "assistant_delta",
            content: "draft answer",
            reasoningDelta: "private reasoning",
          }),
        ),
      ).toBeNull();
    });
  });
});

// Z.AI GLM Coding Plan usage parsing — `GET {origin}/api/monitor/usage/quota/limit`.
describe("desktop-zai-quota", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  describe("fetchZaiQuota", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("GETs {origin}/api/monitor/usage/quota/limit with the Bearer key and maps unit 3/6 to 5h/weekly", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          code: 200,
          success: true,
          data: {
            level: "max",
            limits: [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                usage: 800_000_000,
                currentValue: 127_694_464,
                remaining: 672_305_536,
                percentage: 15,
                nextResetTime: 1_770_648_402_389,
              },
              {
                type: "TOKENS_LIMIT",
                unit: 6,
                number: 1,
                percentage: 20,
                nextResetTime: 1_787_641_095_989,
              },
              { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 45 },
            ],
          },
        }),
      );
      await expect(fetchZaiQuota("https://api.z.ai/api/coding/paas/v4", "key-1")).resolves.toEqual({
        plan: "max",
        fiveHour: { usagePct: 15, remainingPct: 85, resetsAt: 1_770_648_402_389 },
        weekly: { usagePct: 20, remainingPct: 80, resetsAt: 1_787_641_095_989 },
      });
      const [rawUrl, init] = fetchMock.mock.calls[0]!;
      const url = new URL(String(rawUrl));
      expect(url.origin).toBe("https://api.z.ai");
      expect(url.pathname).toBe("/api/monitor/usage/quota/limit");
      expect(init).toMatchObject({
        method: "GET",
        headers: { Authorization: "Bearer key-1" },
      });
    });

    it("derives the monitor host from a custom Z.AI base URL's origin", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 1 }] } }),
      );
      await fetchZaiQuota("https://open.bigmodel.cn/api/paas/v4", "key-1");
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.origin).toBe("https://open.bigmodel.cn");
    });

    it("falls back to currentValue/usage when `percentage` is absent", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            level: "pro",
            limits: [
              { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12_000, currentValue: 3_000 },
              { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 0 },
            ],
          },
        }),
      );
      await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toEqual({
        plan: "pro",
        fiveHour: { usagePct: 25, remainingPct: 75, resetsAt: null },
        weekly: { usagePct: 0, remainingPct: 100, resetsAt: null },
      });
    });

    it("returns undefined when the payload carries no token/credit rows", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: { limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0 }] },
        }),
      );
      await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined when `limits` is absent", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { level: "lite" } }));
      await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined on non-ok status (e.g. a Developer key)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ code: 401 }, 401));
      await expect(fetchZaiQuota("https://api.z.ai/api/paas/v4", "key-1")).resolves.toBeUndefined();
    });

    it("returns undefined on network errors", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(fetchZaiQuota("https://api.z.ai/api/v1", "key-1")).resolves.toBeUndefined();
    });
  });
});
