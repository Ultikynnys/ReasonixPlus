import { describe, expect, it } from "vitest";
import { PROVIDER_SPECS } from "../src/provider-registry.js";

/** Mirrors the "Provider copy" table and placeholder list in providers/README.md.
 *  A key or placeholder added to a declaration without documenting it fails here:
 *  an undeclared key silently falls back and a typo'd placeholder renders literally. */
const KEYS = new Set([
  "notConfigured",
  "noCredential",
  "apiOauth",
  "apiKey",
  "apiNone",
  "apiBare",
  "oauthFailed",
  "quotaLabel",
  "quotaTitle",
  "quotaDualTitle",
  "quotaFiveHourTitle",
  "quotaWeeklyTitle",
  "quotaMonthlyTitle",
  "quotaDailyTitle",
  "quotaPlanTitle",
  "creditTitle",
  "quotaNoData",
  "quotaNoDataUnavailable",
  "quotaTurnTitle",
  "quotaPlanName",
  "quotaPlanFallback",
  "offPeakTitle",
  "peakTitle",
  "freeLabel",
  "freeTier",
  "freeTitle",
  "panelSignInTitle",
  "panelSignIn",
  "panelSignInHint",
  "panelWaiting",
  "panelSignedIn",
  "panelAccount",
  "panelAccountOrg",
  "panelTokenSet",
  "panelKeyStored",
  "panelSignOut",
  "panelCancel",
  "panelFlowFailed",
  "modelsLabel",
  "modelsHint",
  "modelsError",
]);

const PLACEHOLDERS = new Set([
  "model",
  "error",
  "baseUrl",
  "account",
  "org",
  "message",
  "when",
  "left",
  "resets",
  "weeklyResets",
  "session",
  "sessionResets",
  "plan",
  "fiveHour",
  "weekly",
  "rolling",
  "monthly",
  "credit",
  "pct",
]);

const declared = PROVIDER_SPECS.flatMap((spec) =>
  Object.entries(spec.strings).map(([key, raw]) => ({ provider: spec.id, key, raw })),
);

describe("declared provider copy", () => {
  it("overrides only documented keys", () => {
    const unknown = declared
      .filter((entry) => !KEYS.has(entry.key))
      .map((entry) => `${entry.provider}.${entry.key}`);
    expect(unknown, "add the key to the Provider copy table in the README first").toEqual([]);
  });

  it("fills only documented placeholders", () => {
    const unknown: string[] = [];
    for (const entry of declared) {
      for (const match of entry.raw.matchAll(/\{(\w+)\}/g)) {
        if (!PLACEHOLDERS.has(match[1]!))
          unknown.push(`${entry.provider}.${entry.key}: {${match[1]}}`);
      }
    }
    expect(unknown, "add the placeholder to the Provider copy section first").toEqual([]);
  });

  it("never declares empty copy, which would render a blank control", () => {
    const empty = declared
      .filter((entry) => entry.raw.trim() === "")
      .map((entry) => `${entry.provider}.${entry.key}`);
    expect(empty).toEqual([]);
  });

  it("declares a complete sign-in panel for every provider that selects one", () => {
    const required = [
      "panelSignInTitle",
      "panelSignIn",
      "panelSignInHint",
      "panelWaiting",
      "panelSignedIn",
      "panelSignOut",
      "panelCancel",
      "panelFlowFailed",
    ];
    const panels = PROVIDER_SPECS.filter((spec) => spec.settingsPanel?.endsWith("-auth"));
    const missing = panels.flatMap((spec) =>
      required.filter((key) => !spec.strings[key]).map((key) => `${spec.id}.${key}`),
    );
    expect(missing).toEqual([]);
    expect(panels.length, "no provider selects a sign-in panel").toBeGreaterThan(0);
  });
});
