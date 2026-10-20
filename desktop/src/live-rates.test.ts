import { describe, expect, it } from "vitest";
import { ratesByWorkspace } from "./live-rates";
import { normalizeWorkspacePath } from "./workspace-path";

type Tab = { id: string; workspaceDir?: string; session?: string; busy?: boolean };

const A_DIR = "C:/work/alpha";
const B_DIR = "C:/work/beta";
// Slices are keyed by the normalized workspace, which is what the sidebar groups on.
const A = normalizeWorkspacePath(A_DIR);
const B = normalizeWorkspacePath(B_DIR);

function tab(id: string, workspaceDir: string, session?: string, busy = true): Tab {
  return { id, workspaceDir, session, busy };
}

describe("ratesByWorkspace", () => {
  it("splits the rate map by the workspace whose session is running", () => {
    const slices = ratesByWorkspace(
      [tab("t1", A_DIR, "alpha-1"), tab("t2", B_DIR, "beta-1")],
      new Map([
        ["alpha-1", 42],
        ["beta-1", 7],
      ]),
      new Map(),
    );
    expect([...(slices.get(A) ?? [])]).toEqual([["alpha-1", 42]]);
    expect([...(slices.get(B) ?? [])]).toEqual([["beta-1", 7]]);
  });

  it("hands a tab the very same slice when another workspace moved", () => {
    // The memo() on TabRuntime only holds if the prop keeps its identity, which is
    // the whole point of slicing: alpha's sidebar must not wake up for beta's numbers.
    const tabs = [tab("t1", A_DIR, "alpha-1"), tab("t2", B_DIR, "beta-1")];
    const first = ratesByWorkspace(
      tabs,
      new Map([
        ["alpha-1", 42],
        ["beta-1", 7],
      ]),
      new Map(),
    );
    const second = ratesByWorkspace(
      tabs,
      new Map([
        ["alpha-1", 42],
        ["beta-1", 19],
      ]),
      first,
    );
    expect(second.get(A)).toBe(first.get(A));
    expect(second.get(B)).not.toBe(first.get(B));
    expect(second.get(B)?.get("beta-1")).toBe(19);
  });

  it("gives every tab of one workspace the same slice", () => {
    const slices = ratesByWorkspace(
      [tab("t1", A_DIR, "alpha-1"), tab("t2", A_DIR, "alpha-2")],
      new Map([
        ["alpha-1", 5],
        ["alpha-2", 6],
      ]),
      new Map(),
    );
    expect(slices.size).toBe(1);
    expect([...(slices.get(A) ?? [])]).toEqual([
      ["alpha-1", 5],
      ["alpha-2", 6],
    ]);
  });

  it("ignores open-but-idle channels and sessions with no number yet", () => {
    const slices = ratesByWorkspace(
      [tab("t1", A_DIR, "alpha-1", false), tab("t2", A_DIR, "alpha-2"), tab("t3", B_DIR)],
      new Map([["alpha-2", 3]]),
      new Map(),
    );
    expect([...(slices.get(A) ?? [])]).toEqual([["alpha-2", 3]]);
    expect(slices.has(B)).toBe(false);
  });

  it("drops a workspace's slice when its run ends", () => {
    const tabs = [tab("t1", A_DIR, "alpha-1")];
    const running = ratesByWorkspace(tabs, new Map([["alpha-1", 42]]), new Map());
    const done = ratesByWorkspace([{ ...tabs[0], busy: false }], new Map(), running);
    expect(done.size).toBe(0);
  });
});
