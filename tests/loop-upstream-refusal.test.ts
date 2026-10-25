import { describe, expect, it } from "vitest";
import { isUpstreamBareRefusal } from "../src/loop/errors.js";

/** Verbatim body captured from OpenCode's Go gateway (diagnostics
 *  `model.error.body`): the upstream rejection is relayed with `param: null`,
 *  so it names no offending field. */
const REFUSAL_BODY =
  '{"error":{"param":null,"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] request could not be processed"}}';

function openCodeRefusal(): Error {
  return new Error(`OpenCode 400: ${REFUSAL_BODY}`);
}

describe("isUpstreamBareRefusal", () => {
  it("matches the relayed field-less rejection under any provider brand", () => {
    expect(isUpstreamBareRefusal(openCodeRefusal())).toBe(true);
    expect(isUpstreamBareRefusal(new Error(`Upstream 400: ${REFUSAL_BODY}`))).toBe(true);
  });

  it("does not match a 4xx that names the offending field", () => {
    const fieldSpecific = new Error(
      'OpenCode 400: {"error":{"param":"messages","type":"invalid_request_error","message":"messages.3: unknown role"}}',
    );
    expect(isUpstreamBareRefusal(fieldSpecific)).toBe(false);
  });

  it("does not match other recoverable families", () => {
    expect(
      isUpstreamBareRefusal(new Error("OpenCode 400: maximum context length is 128000 tokens")),
    ).toBe(false);
    expect(
      isUpstreamBareRefusal(
        new Error(
          "OpenCode 400: Upstream request failed: [invalid_request_error] Too many images in request: 67 > 64",
        ),
      ),
    ).toBe(false);
  });

  it("matches any 4xx status, and leaves 5xx on its own retry path", () => {
    // A 429 is a 4xx, so it stays classified here; the client's fetch layer
    // already retries it first, and a shrink costs three bounded attempts.
    expect(isUpstreamBareRefusal(new Error(`OpenCode 429: ${REFUSAL_BODY}`))).toBe(true);
    expect(isUpstreamBareRefusal(new Error(`OpenCode 503: ${REFUSAL_BODY}`))).toBe(false);
  });

  it("ignores non-errors and unrelated messages", () => {
    expect(isUpstreamBareRefusal(undefined)).toBe(false);
    expect(isUpstreamBareRefusal("Upstream request failed")).toBe(false);
    expect(isUpstreamBareRefusal(new Error("OpenCode 400: bad request"))).toBe(false);
  });
});

describe("CacheFirstLoop — field-less gateway refusal recovery", () => {
  /** Client whose stream fails with the captured refusal for the first
   *  `failures` calls, then answers normally. */
  function refusingClient(failures: number) {
    let calls = 0;
    const client = {
      baseUrl: "https://api.test/v1",
      model: "deepseek-chat",
      calls: () => calls,
      stream: async function* () {
        calls++;
        if (calls <= failures) throw openCodeRefusal();
        yield { contentDelta: "recovered answer" };
        yield { finishReason: "stop" };
      },
    };
    return client;
  }

  async function runTurn(
    loop: {
      step: (input: string) => AsyncGenerator<Record<string, unknown>>;
    },
    input = "do the thing",
  ) {
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of loop.step(input)) events.push(ev as Record<string, unknown>);
    return events;
  }

  async function makeLoop(client: unknown) {
    const { CacheFirstLoop } = await import("../src/loop.js");
    const { ImmutablePrefix } = await import("../src/memory/runtime.js");
    return new CacheFirstLoop({
      client: client as never,
      prefix: new ImmutablePrefix({ system: "test prompt" }),
      model: "deepseek-chat",
      stream: true,
    });
  }

  it("replays the refused request and finishes the turn", async () => {
    const client = refusingClient(1);
    const loop = await makeLoop(client);
    const events = await runTurn(loop);

    expect(client.calls()).toBe(2);
    const warnings = events.filter((e) => e.role === "warning").map((e) => String(e.content));
    expect(warnings.some((w) => w.includes("Replaying it automatically"))).toBe(true);
    expect(events.some((e) => e.role === "error")).toBe(false);
    expect(
      events.some((e) => e.role === "assistant_delta" && e.content === "recovered answer"),
    ).toBe(true);
  });

  it("shrinks the outgoing request, then folds the log", async () => {
    // Seed a history big enough that size is a plausible cause. Each oversized
    // tool result is healed to the send-time char cap, so several are needed to
    // cross the fold floor the ladder keys off.
    const client = refusingClient(3);
    const loop = (await makeLoop(client)) as unknown as {
      log: { append: (m: Record<string, unknown>) => void };
      step: (input: string) => AsyncGenerator<Record<string, unknown>>;
    };
    for (let i = 0; i < 8; i++) {
      loop.log.append({ role: "user", content: `request ${i}` });
      loop.log.append({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `call_seed_${i}`,
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      });
      loop.log.append({
        role: "tool",
        tool_call_id: `call_seed_${i}`,
        name: "read_file",
        content: "x".repeat(120_000),
      });
    }

    const events = await runTurn(loop);
    const warnings = events.filter((e) => e.role === "warning").map((e) => String(e.content));

    expect(warnings.some((w) => w.includes("Replaying it automatically"))).toBe(true);
    expect(warnings.some((w) => w.includes("older tool results trimmed"))).toBe(true);
    expect(warnings.some((w) => w.includes("Compacting the conversation"))).toBe(true);
    expect(events.some((e) => e.role === "compaction_start")).toBe(true);
    expect(client.calls()).toBe(4);
    expect(events.some((e) => e.role === "error")).toBe(false);
  });

  it("keeps recovering past every stage until the gateway accepts the request", async () => {
    const client = refusingClient(5);
    const loop = await makeLoop(client);
    const events = await runTurn(loop);

    // Five refusals in a row, past the three stages the ladder used to allow:
    // it keeps replaying the request until the gateway takes it.
    expect(client.calls()).toBe(6);
    const warnings = events.filter((e) => e.role === "warning").map((e) => String(e.content));
    expect(warnings.filter((w) => w.includes("Replaying it automatically")).length).toBeGreaterThan(
      1,
    );
    expect(events.some((e) => e.role === "error")).toBe(false);
    expect(
      events.some((e) => e.role === "assistant_delta" && e.content === "recovered answer"),
    ).toBe(true);
  });
});
