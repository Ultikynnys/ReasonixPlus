/** Wires the ribbon's rate-chip rule to the daemon's own endpoint resolution: a
 *  stubbed billing kind in a desktop test cannot hide a real mismatch. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRatePrices, rateCost } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateChips } from "../desktop/src/rate-chips.js";
import { modelEndpointFor } from "../src/cli/commands/desktop.js";

const ENV_NAMES = ["OLLAMA_API_KEY", "OLLAMA_BASE_URL", "DEEPSEEK_API_KEY"] as const;

describe("rate chip eligibility, fed by the daemon's resolution", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-rate-chip-"));
    path = join(dir, "config.json");
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("HOME", dir);
    for (const name of ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The `$settings` payload's endpoint fields for one session's models. */
  const session = (model: string, subagentModel?: string) => ({
    model,
    modelEndpoint: modelEndpointFor(model, path),
    subagentModel,
    subagentModelEndpoint: subagentModel ? modelEndpointFor(subagentModel, path) : undefined,
    subagents: true,
  });

  it("shows the period chip for a keyed Ollama Cloud session on a peak-priced id", () => {
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";
    const chips = rateChips(session("ollama/deepseek-v4.1-flash:1017"));
    expect(chips).toHaveLength(1);
    expect(chips[0]?.spec.id).toBe("ollama");
    // The daemon's kind is `quota` here; an eligibility rule that demanded `usd`
    // would drop the chip and this assertion would be unreachable.
    const endpoint = modelEndpointFor("ollama/deepseek-v4.1-flash:1017", path);
    expect(endpoint.deployment).toBe("cloud");
    expect(endpoint.billingKind).not.toBe("none");
  });

  it("shows the subagent model's period chip when only the subagent is an Ollama DeepSeek model", () => {
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";
    const chips = rateChips(session("deepseek-v4-flash", "ollama/deepseek-v4-pro"));
    const ollama = chips.find((chip) => chip.spec.id === "ollama");
    expect(ollama, "the subagent's calendar must reach the ribbon").toBeDefined();
    // The tab's own DeepSeek calendar is still its own chip.
    expect(chips.filter((chip) => chip.spec.id === "deepseek")).toHaveLength(1);
  });

  it("prices the session's own model, not just its calendar", () => {
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";
    const table = providerRatePrices("ollama");
    // The ribbon decides eligibility per model; the picker's badge scores from the same
    // table, so both read one declaration: the peak row costs twice the off-peak one.
    expect(rateCost("ollama/deepseek-v4.1-flash:1017", table, false)).toBeCloseTo(0.54, 6);
    expect(rateCost("ollama/deepseek-v4.1-flash:1017", table, true)).toBeCloseTo(1.08, 6);
  });

  it("shows nothing on a keyless Ollama Cloud endpoint, which cannot spend money", () => {
    expect(rateChips(session("ollama/deepseek-v4.1-flash:1017"))).toEqual([]);
  });

  it("shows nothing for an Ollama model the provider does not price", () => {
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";
    expect(rateChips(session("ollama/gemma4"))).toEqual([]);
  });

  it("shows nothing for a local Ollama deployment", () => {
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    expect(rateChips(session("ollama/deepseek-v4-pro"))).toEqual([]);
  });
});
