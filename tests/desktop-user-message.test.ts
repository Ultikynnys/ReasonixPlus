import { beforeAll, describe, expect, it, vi } from "vitest";
import type { IncomingEvent } from "../desktop/src/protocol";
import { baseAppState } from "./support/app-state.js";

// Tauri APIs/plugins resolve to tests/mocks/*.ts via vitest.config.ts aliases.
const componentMocks = await import("./support/desktop-component-mocks.js");
vi.mock("../desktop/src/Markdown", () => componentMocks.markdown);
vi.mock("../desktop/src/ui/thread", () => componentMocks.thread);

type ChatMessage = Awaited<typeof import("../desktop/src/App")>["ChatMessage"];
type AppState = Parameters<Awaited<typeof import("../desktop/src/App")>["applyIncoming"]>[0];
type ApplyIncoming = Awaited<typeof import("../desktop/src/App")>["applyIncoming"];

let applyIncoming: ApplyIncoming;

beforeAll(async () => {
  ({ applyIncoming } = await import("../desktop/src/App"));
});

const makeState = (messages: ChatMessage[] = []): AppState =>
  baseAppState({ ready: true, messages });

describe("desktop incoming remote message rendering", () => {
  it("appends remote user.message into the desktop transcript and marks the tab busy", () => {
    const state = makeState([{ kind: "assistant", turn: 1, segments: [], pending: false }]);
    const next = applyIncoming(state, {
      type: "user.message",
      id: 42,
      ts: "2026-05-19T12:00:00Z",
      turn: 0,
      text: "hello from remote",
    } as IncomingEvent);

    expect(next.busy).toBe(true);
    expect(next.messages.at(-1)).toEqual({
      kind: "user",
      text: "hello from remote",
      clientId: "remote-42",
      turn: 2,
    });
  });
});
