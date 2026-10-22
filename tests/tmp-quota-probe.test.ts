import { codexUsageView } from "@reasonix/core-utils";
import { describe, it, vi } from "vitest";
import { fetchCodexQuotaViaOAuth } from "../src/codex-backend.js";

// Exact /wham/usage body captured live for an account whose 5-hour window is spent.
const LIVE_BODY = {
  plan_type: "plus",
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 18000,
      reset_after_seconds: 16562,
      reset_at: 1792655726,
    },
    secondary_window: {
      used_percent: 65,
      limit_window_seconds: 604800,
      reset_after_seconds: 446407,
      reset_at: 1793085571,
    },
  },
};

describe("probe: what the openai chip renders for a spent 5h window", () => {
  it("prints the parsed quota and view", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(LIVE_BODY), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await fetchCodexQuotaViaOAuth(5_000);
    console.log("QUOTA:", JSON.stringify(result, null, 1));
    console.log(
      "VIEW:",
      JSON.stringify(result.quota ? codexUsageView(result.quota) : null, null, 1),
    );
    vi.unstubAllGlobals();
  });
});
