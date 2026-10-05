/** Atomic monitor-bounded actions combine pointer positioning and clicking in one host operation. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolCallContext, ToolRegistry } from "../tools.js";
import type { MonitorInfo } from "./screen-capture.js";

const execFileAsync = promisify(execFile);

type Point = { x: number; y: number };

export interface ComputerUseOptions {
  listMonitors?: () => Promise<MonitorInfo[]>;
  /** Test seam for the complete native action. */
  actionRunner?: (action: {
    kind: "click" | "focus";
    monitor: MonitorInfo;
    point?: Point;
    app?: string;
  }) => Promise<void>;
}

const DESCRIPTION =
  "Perform one atomic computer-use action on an explicitly selected monitor. For click, the host positions the pointer and presses/releases the button in the same native operation, so do not call a separate mouse-move tool first. Coordinates are relative to the selected monitor and must be inside it. For focus, bring the named window to the foreground and maximize it on the selected monitor.";

function selectMonitor(monitors: MonitorInfo[], query: unknown): MonitorInfo {
  if (query === undefined || query === null || query === "") {
    throw new Error(
      "computer_use: monitor is required; actions cannot target an ambiguous desktop.",
    );
  }
  const index = Number(query);
  const byIndex = Number.isInteger(index) ? monitors.find((m) => m.index === index) : undefined;
  if (byIndex) return byIndex;
  if (typeof query === "string") {
    const normalized = query.trim().toLowerCase();
    const byName = monitors.find(
      (m) => m.id.toLowerCase() === normalized || m.name.toLowerCase() === normalized,
    );
    if (byName) return byName;
  }
  throw new Error(`computer_use: invalid monitor '${String(query)}'.`);
}

function point(args: Record<string, unknown>, monitor: MonitorInfo): Point {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(
      "computer_use: click x and y must be integer pixel coordinates relative to the monitor.",
    );
  }
  if (x < 0 || y < 0 || x >= monitor.width || y >= monitor.height) {
    throw new Error(
      `computer_use: click (${x}, ${y}) is outside monitor ${monitor.index} bounds ${monitor.width}x${monitor.height}.`,
    );
  }
  return { x, y };
}

async function nativeAction(action: {
  kind: "click" | "focus";
  monitor: MonitorInfo;
  point?: Point;
  app?: string;
}): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("computer_use: native atomic input is currently implemented on Windows only.");
  }
  const encoded = Buffer.from(JSON.stringify(action), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop';",
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class RxInput { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd); }\' -ErrorAction SilentlyContinue;',
    `$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json;`,
    "if ($a.kind -eq 'click') { [RxInput]::SetCursorPos([int]$a.monitor.x + [int]$a.point.x, [int]$a.monitor.y + [int]$a.point.y) | Out-Null; [RxInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [RxInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); }",
    "if ($a.kind -eq 'focus') { $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -ieq $a.app -or $_.MainWindowTitle -like ('*' + $a.app + '*')) } | Select-Object -First 1; if (-not $p) { throw \"No window matching $($a.app)\" }; [RxInput]::ShowWindow($p.MainWindowHandle, 3) | Out-Null; [RxInput]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; }",
  ].join("\n");
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
  });
}

export function registerComputerUseTool(
  registry: ToolRegistry,
  opts: ComputerUseOptions = {},
): ToolRegistry {
  registry.register({
    name: "computer_use",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      required: ["action", "monitor"],
      properties: {
        action: { type: "string", enum: ["click", "focus"] },
        monitor: { type: "integer", description: "Required monitor index." },
        x: { type: "integer", description: "Click X relative to the monitor." },
        y: { type: "integer", description: "Click Y relative to the monitor." },
        app: { type: "string", description: "Window title or process name for focus." },
      },
    },
    fn: async (args: Record<string, unknown>, _ctx?: ToolCallContext): Promise<string> => {
      const monitors = await (
        opts.listMonitors ??
        (async () => {
          const { defaultListMonitors } = await import("./screen-capture.js");
          return defaultListMonitors();
        })
      )();
      let monitor: MonitorInfo;
      try {
        monitor = selectMonitor(monitors, args.monitor);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const action =
        args.action === "click" ? "click" : args.action === "focus" ? "focus" : undefined;
      if (!action) return "computer_use: action must be 'click' or 'focus'.";
      const selected: {
        kind: "click" | "focus";
        monitor: MonitorInfo;
        point?: Point;
        app?: string;
      } =
        action === "click"
          ? { kind: action, monitor, point: point(args, monitor) }
          : { kind: action, monitor, app: String(args.app ?? "").trim() };
      if (action === "focus" && !selected.app) return "computer_use: app is required for focus.";
      try {
        await (opts.actionRunner ?? nativeAction)(selected);
      } catch (err) {
        return `computer_use: ${err instanceof Error ? err.message : String(err)}`;
      }
      return action === "click"
        ? `computer_use: clicked monitor ${monitor.index} at (${(selected as { point: Point }).point.x}, ${(selected as { point: Point }).point.y}) atomically.`
        : `computer_use: focused and maximized '${(selected as { app: string }).app}' on monitor ${monitor.index}.`;
    },
  });
  return registry;
}
