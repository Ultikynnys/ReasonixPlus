import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import { registerComputerUseTool } from "../src/tools/computer-use.js";
import type { MonitorInfo } from "../src/tools/screen-capture.js";

describe("computer_use", () => {
  const monitors: MonitorInfo[] = [
    { id: "M0", name: "M0", index: 0, x: 0, y: 0, width: 100, height: 80, primary: true },
  ];

  it("performs click as one atomic action", async () => {
    const actions: unknown[] = [];
    const registry = new ToolRegistry();
    registerComputerUseTool(registry, {
      listMonitors: async () => monitors,
      actionRunner: async (action) => actions.push(action),
    });
    const result = await registry.dispatch(
      "computer_use",
      JSON.stringify({ action: "click", monitor: 0, x: 10, y: 20 }),
    );
    expect(result).toContain("clicked monitor 0");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "click", point: { x: 10, y: 20 } });
  });

  it("rejects missing monitors and out-of-bounds clicks", async () => {
    const registry = new ToolRegistry();
    registerComputerUseTool(registry, {
      listMonitors: async () => monitors,
      actionRunner: async () => {},
    });
    await expect(
      registry.dispatch("computer_use", JSON.stringify({ action: "click", x: 1, y: 1 })),
    ).resolves.toContain("missing required parameter");
    await expect(
      registry.dispatch(
        "computer_use",
        JSON.stringify({ action: "click", monitor: 0, x: 100, y: 1 }),
      ),
    ).resolves.toContain("outside monitor");
  });

  it("focuses through the same atomic action seam", async () => {
    const actions: unknown[] = [];
    const registry = new ToolRegistry();
    registerComputerUseTool(registry, {
      listMonitors: async () => monitors,
      actionRunner: async (action) => actions.push(action),
    });
    await registry.dispatch(
      "computer_use",
      JSON.stringify({ action: "focus", monitor: 0, app: "Calculator" }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "focus", app: "Calculator", monitor: { index: 0 } });
  });
});
