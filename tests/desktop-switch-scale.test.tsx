// @vitest-environment jsdom
/** Workspace and session switching at 2 workspaces x 10 sessions x 2000 messages. */

// Three different paths, measured apart:
//   workspace switch = list the target workspace's sessions (index scan, then cache)
//   session switch   = read + parse one 4.7 MB transcript, project it to the wire
//   session landing  = mount the newest page's rows in the transcript

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "reasonix-switch-"));
vi.stubEnv("USERPROFILE", home);
vi.stubEnv("HOME", home);

const layout = await import("../src/memory/session-layout.js");
const store = await import("../src/memory/session.js");
const desktop = await import("../src/cli/commands/desktop.js");
const app = await import("../desktop/src/App");
const { AssistantMsg, UserMsg } = await import("../desktop/src/ui/thread");
const { wireSessionOfSize, writeScaleStore } = await import("./fixtures/scale-sessions.js");

/** 2 workspaces x 10 sessions x 2000 messages, the shape the report named. */
const SPEC = { workspaces: 2, sessionsPerWorkspace: 10, messagesPerSession: 2000 };
const WORKSPACE = "C:\\perf\\workspace-0";
const seeded = writeScaleStore(layout.sessionsRootDir(), SPEC);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  cleanup();
});

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const noop = () => {};
const noopRule = () => {};

type Ui = ReturnType<typeof app.mapLoadedMessages>[number];

/** The transcript rows App.tsx builds, minus the App shell around them. */
function rows(ui: readonly Ui[]) {
  return ui.map((m, i) => {
    if (m.kind === "user") {
      return (
        <div key={`u-${m.turn}`} className="thread-row">
          <UserMsg text={m.text} images={m.images} />
        </div>
      );
    }
    if (m.kind !== "assistant") return null;
    return (
      <div key={`a-${m.turn}-${i}`} className="thread-row">
        <AssistantMsg
          segments={m.segments}
          pending={m.pending}
          model="deepseek-v4-flash"
          // The App passes this for every loaded row (App.tsx): a restored card keeps
          // its sub-card bodies unmounted, so the landing cost depends on it.
          history={m.closed === true}
          onApproveConfirm={noop}
          onRejectConfirm={noop}
          onRuleConfirm={noopRule}
          onStopTool={noop}
          pendingConfirms={[]}
        />
      </div>
    );
  });
}

describe("switching at 2 workspaces x 10 sessions x 2000 messages", () => {
  it("lists a workspace's sessions on a workspace switch", async () => {
    expect(seeded.sessions).toBe(SPEC.workspaces * SPEC.sessionsPerWorkspace);

    // Cold: the index has never loaded, so the switch pays the directory scan.
    const coldStart = performance.now();
    const cold = await store.listSessionsForWorkspaceAsync(WORKSPACE).value;
    const coldMs = performance.now() - coldStart;

    const warmStart = performance.now();
    const warm = await store.listSessionsForWorkspaceAsync(WORKSPACE).value;
    const warmMs = performance.now() - warmStart;

    console.log(
      `workspace switch: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms, ` +
        `${cold.length} of ${seeded.sessions} sessions in this workspace`,
    );

    expect(cold).toHaveLength(SPEC.sessionsPerWorkspace);
    expect(warm).toHaveLength(SPEC.sessionsPerWorkspace);
    expect(warmMs).toBeLessThan(250);
  }, 120_000);

  it("switches between workspaces repeatedly, once the index is warm", async () => {
    const other = "C:\\perf\\workspace-1";
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const listed = await store.listSessionsForWorkspaceAsync(i % 2 === 0 ? WORKSPACE : other)
        .value;
      times.push(performance.now() - started);
      expect(listed).toHaveLength(SPEC.sessionsPerWorkspace);
    }
    console.log(
      `10 workspace switches, warm: median ${median(times).toFixed(2)} ms, ` +
        `max ${Math.max(...times).toFixed(2)} ms`,
    );
    expect(median(times)).toBeLessThan(100);
  }, 120_000);

  it("loads a session's transcript on a session switch", async () => {
    const sessions = await store.listSessionsForWorkspaceAsync(WORKSPACE).value;
    const times: number[] = [];
    let bytes = 0;
    for (const session of sessions) {
      const started = performance.now();
      const records = await store.loadSessionMessagesAsync(session.name);
      const loaded = desktop.buildLoadedMessages(records);
      times.push(performance.now() - started);
      bytes = Math.max(bytes, records.length);
      expect(loaded.length).toBeGreaterThan(0);
    }
    console.log(
      `session switch backend: median ${median(times).toFixed(1)} ms, ` +
        `max ${Math.max(...times).toFixed(1)} ms over ${times.length} sessions of ${bytes} records`,
    );
    expect(median(times)).toBeLessThan(1_500);
  }, 180_000);

  it("mounts the newest page when a session switch lands", () => {
    // A page of 300 RECORDS projects to about 200 wire messages (3 records per turn, 2
    // messages per turn), so 200 is the honest landing size.
    const started = performance.now();
    const ui = app.mapLoadedMessages(wireSessionOfSize(200, 1));
    const mappedMs = performance.now() - started;
    const view = render(<div>{rows(ui)}</div>);
    const mountMs = performance.now() - started;
    const nodes = view.container.querySelectorAll("*").length;
    view.unmount();
    console.log(
      `session landing: map ${mappedMs.toFixed(1)} ms, mount ${mountMs.toFixed(1)} ms, ` +
        `${ui.length} rows, ${nodes} nodes`,
    );
    expect(ui.length).toBeGreaterThan(100);
    // Node count is the deterministic signal; the clock varies with machine load
    // (688 to 1424 ms measured across runs on this machine).
    expect(nodes).toBeLessThan(9_000);
    expect(mountMs).toBeLessThan(2_000);
  }, 120_000);

  it("splits the landing cost by row type", () => {
    const ui = app.mapLoadedMessages(wireSessionOfSize(200, 1));
    const users = ui.filter((m) => m.kind === "user");
    const assistants = ui.filter((m) => m.kind === "assistant");

    const userStart = performance.now();
    const userView = render(<div>{rows(users)}</div>);
    const userMs = performance.now() - userStart;
    const userNodes = userView.container.querySelectorAll("*").length;
    userView.unmount();

    const assistantStart = performance.now();
    const assistantView = render(<div>{rows(assistants)}</div>);
    const assistantMs = performance.now() - assistantStart;
    const assistantNodes = assistantView.container.querySelectorAll("*").length;
    assistantView.unmount();

    console.log(
      `landing breakdown: ${users.length} user rows ${userMs.toFixed(0)} ms (${userNodes} nodes), ` +
        `${assistants.length} assistant rows ${assistantMs.toFixed(0)} ms (${assistantNodes} nodes)`,
    );
    expect(users.length + assistants.length).toBeGreaterThan(100);
  }, 120_000);

  it("splits an assistant row by segment kind", () => {
    const ui = app.mapLoadedMessages(wireSessionOfSize(200, 1));
    const base = ui.find((m) => m.kind === "assistant");
    expect(base && base.kind === "assistant").toBe(true);
    if (!base || base.kind !== "assistant") return;

    for (const kind of ["reasoning", "text", "tool"] as const) {
      const segments = base.segments.filter((s) => s.kind === kind);
      if (segments.length === 0) {
        console.log(`segment split: no ${kind} segment in the fixture`);
        continue;
      }
      const started = performance.now();
      const view = render(
        <div>
          {Array.from({ length: 100 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size synthetic row list
            <div key={i} className="thread-row">
              <AssistantMsg
                segments={segments}
                pending={false}
                model="deepseek-v4-flash"
                history={true}
                onApproveConfirm={noop}
                onRejectConfirm={noop}
                onRuleConfirm={noopRule}
                onStopTool={noop}
                pendingConfirms={[]}
              />
            </div>
          ))}
        </div>,
      );
      const ms = performance.now() - started;
      const nodes = view.container.querySelectorAll("*").length;
      const bodies = view.container.querySelectorAll(".card-body").length;
      view.unmount();
      console.log(
        `segment split: 100x ${kind}-only rows ${ms.toFixed(0)} ms, ${nodes} nodes, ` +
          `${bodies} mounted card bodies`,
      );
    }
  }, 120_000);

  it("swaps one session's transcript for another's", () => {
    const pageA = app.mapLoadedMessages(wireSessionOfSize(200, 1));
    const pageB = app.mapLoadedMessages(wireSessionOfSize(200, 2));
    const view = render(<div>{rows(pageA)}</div>);

    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      view.rerender(<div>{rows(i % 2 === 0 ? pageB : pageA)}</div>);
      times.push(performance.now() - started);
    }
    const switchMs = median(times);
    console.log(`swapping a mounted transcript: median ${switchMs.toFixed(1)} ms`);
    view.unmount();
    expect(switchMs).toBeLessThan(700);
  }, 120_000);
});
