/** Subagent quota failover — a child whose provider is out of quota re-spawns on
 *  the same configured backup models the main chat falls over to. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { registerSubagentTool } from "../src/tools/subagent.js";
import { makeFakeClient } from "./support/fake-client.js";

const PRIMARY = "deepseek-v4-flash";
const BACKUP = "deepseek-v4-pro";
/** Accepted official id whose provider needs an OpenAI credential we never set. */
const UNUSABLE_BACKUP = "gpt-5.6-sol";

const QUOTA_WALL = {
  status: 429,
  body: { error: { message: "You exceeded your current quota", code: "insufficient_quota" } },
};

describe("subagent quota failover", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-subagent-failover-"));
    configPath = join(dir, "config.json");
    // No OpenAI credential exists here — that is what makes UNUSABLE_BACKUP unusable.
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /** Spawn once with `fallbackModels` persisted, returning the parsed payload plus
   *  the models the provider was actually asked to run, in order. */
  async function spawn(opts: {
    fallbackModels: string[];
    wall?: { status: number; body: unknown };
    /** Default: the per-model resolver the daemon wires. "fixed": one client for every
     *  model. `{ throwsFor }`: a resolver that explodes for that model id. */
    clientMode?: "resolver" | "fixed" | { throwsFor: string };
  }): Promise<{ parsed: Record<string, unknown>; models: string[] }> {
    writeFileSync(
      configPath,
      JSON.stringify({ apiKey: "sk-test", fallbackModels: opts.fallbackModels }),
      "utf8",
    );
    const fake = makeFakeClient([{ content: "backup answer" }], {
      failModels: opts.wall ? { [PRIMARY]: opts.wall } : {},
      // The client retries a 429 on its own; these tests assert the SPAWN chain, so
      // one attempt per model keeps both the call log and the runtime deterministic.
      retry: { maxAttempts: 1 },
    });
    const parent = new ToolRegistry();
    const mode = opts.clientMode ?? "resolver";
    registerSubagentTool(parent, {
      // The daemon wires a per-model resolver (code/setup.ts); mirror it unless this
      // case is specifically exercising one of the guards.
      client:
        mode === "fixed"
          ? fake.client
          : mode === "resolver"
            ? () => fake.client
            : (model: string) => {
                if (model === mode.throwsFor) throw new Error("missing credential");
                return fake.client;
              },
      configPath,
      // Pinned: without it the tool falls back to DEFAULT_SUBAGENT_MODEL, whose id
      // the wall never matches.
      defaultModel: PRIMARY,
    });
    const out = await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "summarize the repo" }),
    );
    // The tool appends an optional budget hint on a second line; the payload is line one.
    const parsed = JSON.parse(out.split("\n")[0]!) as Record<string, unknown>;
    return { parsed, models: fake.captured.map((req) => req.model) };
  }

  it("re-spawns the task on the backup model and returns its answer", async () => {
    const { parsed, models } = await spawn({ fallbackModels: [BACKUP], wall: QUOTA_WALL });
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe("backup answer");
    expect(parsed.model).toBe(BACKUP);
    expect(models).toEqual([PRIMARY, BACKUP]);
  });

  it("keeps the failure when no backup is configured", async () => {
    const { parsed, models } = await spawn({ fallbackModels: [], wall: QUOTA_WALL });
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy();
    expect(models).toEqual([PRIMARY]);
  });

  it("skips a backup whose provider has no credential and uses the next one", async () => {
    const { parsed, models } = await spawn({
      fallbackModels: [UNUSABLE_BACKUP, BACKUP],
      wall: QUOTA_WALL,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.model).toBe(BACKUP);
    // The credential-less provider was never even attempted.
    expect(models).toEqual([PRIMARY, BACKUP]);
  });

  it("stops when every configured backup is unusable here", async () => {
    const { parsed, models } = await spawn({
      fallbackModels: [UNUSABLE_BACKUP],
      wall: QUOTA_WALL,
    });
    expect(parsed.success).toBe(false);
    expect(models).toEqual([PRIMARY]);
  });

  it("does not retry a failure that is not a quota wall", async () => {
    // A malformed request would be refused just as fast by any other model, so the
    // chain must not run — and must not burn a second spawn on a guess.
    const { parsed, models } = await spawn({
      fallbackModels: [BACKUP],
      wall: { status: 400, body: { error: { message: "invalid request" } } },
    });
    expect(parsed.success).toBe(false);
    expect(models).toEqual([PRIMARY]);
  });

  it("never re-routes through a single fixed client", async () => {
    // A fixed client is bound to the primary's endpoint and key: pushing another
    // provider's model id through it would hit the wrong host, so no failover.
    const { parsed, models } = await spawn({
      fallbackModels: [BACKUP],
      wall: QUOTA_WALL,
      clientMode: "fixed",
    });
    expect(parsed.success).toBe(false);
    expect(models).toEqual([PRIMARY]);
  });

  it("keeps the primary failure when the backup's client cannot be built", async () => {
    // A resolver that throws must not turn an honest quota failure into a bare
    // exception escaping the tool.
    const { parsed, models } = await spawn({
      fallbackModels: [BACKUP],
      wall: QUOTA_WALL,
      clientMode: { throwsFor: BACKUP },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy();
    expect(models).toEqual([PRIMARY]);
  });
});
