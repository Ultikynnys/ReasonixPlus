import { describe, expect, it } from "vitest";
import {
  antigravityUsageView,
  codexUsageView,
  ollamaUsageView,
  opencodeUsageView,
  quotaWindowsSummary,
  zaiUsageView,
} from "../src/provider-usage.js";
import type {
  AntigravityQuota,
  CodexQuota,
  OllamaQuota,
  OpencodeQuota,
  ZaiQuota,
} from "../src/desktop-protocol.js";

const CODEX: CodexQuota = {
  plan: "plus",
  fiveHour: {
    windowMinutes: 300,
    usedPercent: 50,
    remainingPercent: 50,
    resetsAt: "2026-09-01T13:37:06Z",
  },
  weekly: { windowMinutes: 10080, usedPercent: 42, remainingPercent: 58, resetsAt: null },
  turnUsedPct: 2.5,
  fetchedAt: 0,
};

describe("codexUsageView", () => {
  it("maps 5-hour then weekly and parses ISO resets to epoch ms", () => {
    const view = codexUsageView(CODEX);
    expect(view.plan).toBe("plus");
    expect(view.turnUsedPct).toBe(2.5);
    expect(view.windows.map((w) => w.label)).toEqual(["5h", "wk"]);
    expect(view.windows.map((w) => w.remainingPct)).toEqual([50, 58]);
    expect(view.windows[0]!.resetsAt).toBe(Date.parse("2026-09-01T13:37:06Z"));
    expect(view.windows[1]!.resetsAt).toBeNull();
  });

  it("drops windows the plan omits", () => {
    expect(codexUsageView({ ...CODEX, fiveHour: null }).windows.map((w) => w.label)).toEqual(["wk"]);
  });
});

describe("ollamaUsageView", () => {
  it("labels the session window 5h, keeps epoch-ms resets, and takes the plan", () => {
    const quota: OllamaQuota = {
      session: { usagePct: 25, remainingPct: 75, resetsAt: 1_800_000_000_000 },
      weekly: { usagePct: 12.5, remainingPct: 87.5 },
      fetchedAt: 0,
    };
    const view = ollamaUsageView(quota, "medium");
    expect(view.plan).toBe("medium");
    expect(view.windows.map((w) => w.label)).toEqual(["5h", "wk"]);
    expect(view.windows[0]!.resetsAt).toBe(1_800_000_000_000);
    expect(view.windows[1]!.resetsAt).toBeNull();
  });
});

describe("zaiUsageView", () => {
  it("maps fiveHour + weekly with their epoch-ms resets", () => {
    const quota: ZaiQuota = {
      plan: "pro",
      fiveHour: { usagePct: 30, remainingPct: 70, resetsAt: 42 },
      weekly: { usagePct: 12, remainingPct: 88, resetsAt: null },
      turnUsedPct: 1.5,
      fetchedAt: 0,
    };
    const view = zaiUsageView(quota);
    expect(view.plan).toBe("pro");
    expect(view.windows).toEqual([
      { label: "5h", remainingPct: 70, resetsAt: 42 },
      { label: "wk", remainingPct: 88, resetsAt: null },
    ]);
  });
});

describe("opencodeUsageView", () => {
  it("maps rolling/weekly/monthly and carries the limited flag", () => {
    const quota: OpencodeQuota = {
      rolling: { usagePct: 30, remainingPct: 70, resetsAt: null, limited: true },
      weekly: { usagePct: 12, remainingPct: 88, resetsAt: null, limited: false },
      monthly: { usagePct: 5, remainingPct: 95, resetsAt: null, limited: false },
      turnUsedPct: 1.2,
      fetchedAt: 0,
    };
    const view = opencodeUsageView(quota);
    expect(view.plan).toBeNull();
    expect(view.windows.map((w) => w.label)).toEqual(["5h", "wk", "mo"]);
    expect(view.windows[0]!.limited).toBe(true);
  });
});

describe("antigravityUsageView", () => {
  it("selects the active model window and converts usedFraction to % left", () => {
    const quota: AntigravityQuota = {
      plan: { tierId: "free-tier", name: "Antigravity" },
      windows: [
        { modelId: "gemini-3.6-flash", usedFraction: 0.1, resetTime: "2026-09-01T13:37:06Z" },
        { modelId: "gemini-3.7-flash", usedFraction: 0.5 },
      ],
      fetchedAt: 0,
    };
    const view = antigravityUsageView(quota, "gemini-3.7-flash");
    expect(view.plan).toBe("Antigravity");
    expect(view.windows).toHaveLength(1);
    expect(view.windows[0]!.remainingPct).toBe(50);
    expect(view.windows[0]!.resetsAt).toBeNull();
  });

  it("returns an empty window list when no bucket exists", () => {
    expect(antigravityUsageView({ plan: null, windows: [], fetchedAt: 0 }).windows).toEqual([]);
  });
});

describe("quotaWindowsSummary", () => {
  it("renders the Z.AI-style dual ribbon for multiple windows", () => {
    expect(
      quotaWindowsSummary([
        { label: "5h", remainingPct: 70, resetsAt: null },
        { label: "wk", remainingPct: 87.5, resetsAt: null },
      ]),
    ).toBe("5h 70% · wk 88%");
  });

  it("drops the label for a single window", () => {
    expect(quotaWindowsSummary([{ label: "5h", remainingPct: 70, resetsAt: null }])).toBe("70%");
  });

  it("renders nothing when there are no windows", () => {
    expect(quotaWindowsSummary([])).toBe("");
  });
});
