import { describe, expect, it, vi } from "vitest";
import {
  type EmittableEvent,
  buildLoadedMessages,
  compactTabContext,
  manualCompactNotice,
  runManualCompact,
} from "../src/cli/commands/desktop.js";
import { Eventizer } from "../src/core/eventize.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { estimateConversationTokens } from "../src/tokenizer.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

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
