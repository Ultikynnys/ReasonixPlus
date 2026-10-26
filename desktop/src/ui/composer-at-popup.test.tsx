// @vitest-environment jsdom

import {
  OPENAI_MODELS,
  OPENCODE_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
} from "@reasonix/core-utils";
import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";
import { menuPopLeft } from "./menu-pop";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
});

function renderComposer(props?: Partial<React.ComponentProps<typeof Composer>>) {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const utils = render(
    <Composer
      {...makeComposerBaseProps({
        modelLabel: "deepseek-v4-flash",
        textareaRef,
        workspaceDir: "/repo",
        subagentsEnabled: true,
        ...props,
      })}
    />,
  );

  return { ...utils, textareaRef };
}

describe("desktop Composer model catalog", () => {
  it("scores each Ollama row by the provider's declared multipliers", () => {
    const { container } = renderComposer({
      ollamaModels: ["deepseek-v4.1-flash:1017", "deepseek-v4-pro", "gemma4", "clef"],
      enabledModels: [
        "ollama/deepseek-v4.1-flash:1017",
        "ollama/deepseek-v4-pro",
        "ollama/gemma4",
        "ollama/clef",
      ],
    });
    fireEvent.click(container.querySelector(".model-pill")!);

    /** The cost badge on the row whose label names `id`. */
    const badgeOf = (id: string): HTMLElement | null => {
      const rows = Array.from(container.querySelectorAll(".popup-item"));
      const match = rows.find((el) => el.querySelector(".cmd")?.textContent?.includes(id));
      return (match?.querySelector(".badge.cost") as HTMLElement | null) ?? null;
    };

    // Flash reads 0.5x off-peak and 1.1x inside the peak window; nothing divides it by
    // another model, so the badge states the row's own weighted cost over the divisor.
    expect(badgeOf("deepseek-v4.1-flash")).not.toBeNull();
    expect(badgeOf("deepseek-v4.1-flash")?.textContent).toMatch(/^(0\.5|1\.1)x$/);
    // Pro reprices with the same calendar, so its multiple follows the clock too.
    expect(badgeOf("deepseek-v4-pro")?.textContent).toMatch(/^(2\.6|5\.2)x$/);
    // A column a row leaves out charges nothing, so clef still reads a multiple.
    expect(badgeOf("clef")?.textContent).toBe("0.5x");
    expect(badgeOf("gemma4")?.textContent).toBe("2.4x");
    // The tooltip states the multiple and names what charged it, without repeating the declared numbers.
    expect(badgeOf("deepseek-v4-pro")?.getAttribute("title")).toMatch(
      /(2\.6|5\.2)x, charging input, cached input and output by the declared multipliers/,
    );
    // The multiple rides in the same badge box the vision flag uses, and carries its ramp
    // position so the stylesheet can tint it green to red.
    const pro = badgeOf("deepseek-v4-pro")!;
    expect(pro.className).toBe("badge cost");
    expect(Number(pro.style.getPropertyValue("--cost-t"))).toBeGreaterThan(0.5);
    // Green below 1x, half-way at 2x: flash's 0.5x sits at the green end, pro's 2.6x at 0.8.
    expect(Number(badgeOf("deepseek-v4.1-flash")!.style.getPropertyValue("--cost-t"))).toBe(0);
    expect(Number(badgeOf("gemma4")!.style.getPropertyValue("--cost-t"))).toBeCloseTo(0.68, 2);
  });
  it("puts the score in the same badge box the vision flag uses", () => {
    const { container } = renderComposer({
      ollamaModels: ["deepseek-v4-pro"],
      ollamaVisionModels: new Set(["ollama/deepseek-v4-pro"]),
      enabledModels: ["ollama/deepseek-v4-pro"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const row = Array.from(container.querySelectorAll(".popup-item")).find((el) =>
      el.querySelector(".cmd")?.textContent?.includes("deepseek-v4-pro"),
    )!;
    const badges = Array.from(row.querySelectorAll(".badge"));
    // Two flags, one shape: the vision marker and the cost multiple.
    expect(badges).toHaveLength(2);
    expect(badges.filter((badge) => badge.classList.contains("cost"))).toHaveLength(1);
  });

  it("shows the active model's own score on both agent pills", () => {
    const { container } = renderComposer({
      modelLabel: "ollama/deepseek-v4-pro",
      subagentModelLabel: "ollama/gemma4",
    });
    expect(container.querySelector(".model-pill .badge.cost")?.textContent).toMatch(
      /^(2\.6|5\.2)x$/,
    );
    // A flat id costs the same all day, so its multiple never moves.
    expect(container.querySelector(".subagent-pill .badge.cost")?.textContent).toBe("2.4x");
  });

  it("re-prices a peak-priced row when the window flips, without a reload", async () => {
    vi.useFakeTimers();
    try {
      // 11:59 UTC on a weekday: Ollama's peak window opens one minute later.
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 11, 59)));
      const { container } = renderComposer({
        modelLabel: "ollama/deepseek-v4.1-flash:1017",
        ollamaModels: ["deepseek-v4.1-flash:1017"],
        enabledModels: ["ollama/deepseek-v4.1-flash:1017"],
      });
      fireEvent.click(container.querySelector(".model-pill")!);
      const rowCost = () => container.querySelector(".popup-item .badge.cost")?.textContent;
      const pillCost = () => container.querySelector(".model-pill .badge.cost")?.textContent;
      // Off-peak: the row's own multiple, on the row and on its pill.
      expect(rowCost()).toBe("0.5x");
      expect(pillCost()).toBe("0.5x");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Peak: both surfaces re-read the period they are now in, with no reload.
      expect(rowCost()).toBe("1.1x");
      expect(pillCost()).toBe("1.1x");
    } finally {
      vi.useRealTimers();
    }
  });
  it("shows only the signed-in account's discovered Antigravity models and filters unusable ones", () => {
    const { container } = renderComposer({
      antigravityModels: [
        "gemini-account-model",
        "claude-account-model",
        "chat_20706",
        "gemini-2.5-pro",
      ],
      enabledModels: ["gemini-account-model", "claude-account-model"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const text = container.querySelector(".model-menu-list")?.textContent ?? "";
    expect(text).toContain("Google Antigravity");
    expect(text).toContain("gemini-account-model");
    expect(text).toContain("claude-account-model");
    expect(text).not.toContain("chat_20706");
    expect(text).not.toContain("gemini-2.5-pro");
  });

  it("refreshes Antigravity models and surfaces refresh errors", () => {
    const onRefreshAntigravityModels = vi.fn();
    const { container } = renderComposer({
      antigravityModels: ["gemini-account-model"],
      antigravityModelsError: "quota unavailable",
      onRefreshAntigravityModels,
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    expect(container.querySelector(".model-menu-list")?.textContent).toContain("quota unavailable");
    const refresh = container.querySelector('button[title="Refresh"]') as HTMLButtonElement | null;
    expect(refresh).not.toBeNull();
    fireEvent.click(refresh!);
    expect(onRefreshAntigravityModels).toHaveBeenCalledOnce();
  });

  it("re-queries the queried catalogs when the picker opens, with no button for it", () => {
    const onRefreshOllamaModels = vi.fn();
    const onRefreshOpencodeModels = vi.fn();
    const onRefreshProviderCatalogs = vi.fn();
    const { container } = renderComposer({
      ollamaModels: ["llama3.1:latest"],
      enabledModels: ["ollama/llama3.1:latest", "deepseek-v4-flash"],
      onRefreshOllamaModels,
      onRefreshOpencodeModels,
      onRefreshProviderCatalogs,
    });
    // Nothing is fetched for a picker nobody opened; opening it is the refresh trigger.
    expect(onRefreshProviderCatalogs).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".model-pill")!);
    expect(onRefreshOllamaModels).toHaveBeenCalledTimes(1);
    expect(onRefreshOpencodeModels).toHaveBeenCalledTimes(1);
    expect(onRefreshProviderCatalogs).toHaveBeenCalledTimes(1);

    // A queried catalog carries no manual refresh control: the list is always current.
    const groups = Array.from(container.querySelectorAll(".model-menu-group"));
    const ollamaGroup = groups.find((group) => group.textContent?.includes("Ollama"));
    expect(ollamaGroup).toBeTruthy();
    expect(ollamaGroup?.querySelector('button[title="Refresh"]')).toBeNull();
  });

  it("renders a subagent model menu that shares the main-agent catalog (DRY)", () => {
    const onModelChange = vi.fn();
    const onSubagentModelChange = vi.fn();
    const { container } = renderComposer({
      subagentModelLabel: "deepseek-v4-flash",
      enabledModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
      onModelChange,
      onSubagentModelChange,
    });

    // Main-agent menu exposes the catalog.
    fireEvent.click(container.querySelector(".model-pill")!);
    const mainList = container.querySelector(".model-menu-list");
    expect(mainList?.textContent).toContain("deepseek-v4-flash");
    expect(mainList?.textContent).toContain("deepseek-v4-pro");

    // The subagent menu is its own button with the same catalog (DRY).
    fireEvent.click(container.querySelector(".subagent-pill")!);
    const subList = container.querySelector(".model-menu-list");
    expect(subList?.textContent).toContain("deepseek-v4-flash");
    expect(subList?.textContent).toContain("deepseek-v4-pro");

    // Clicking a model in the subagent menu routes to onSubagentModelChange.
    const flash = Array.from(subList!.querySelectorAll(".popup-item")).find((el) =>
      el.textContent?.includes("deepseek-v4-flash"),
    );
    fireEvent.click(flash!);
    expect(onSubagentModelChange).toHaveBeenCalledWith("deepseek-v4-flash");
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("routes each pill's pick to its own model, never the other", () => {
    const onModelChange = vi.fn();
    const onSubagentModelChange = vi.fn();
    const { container } = renderComposer({
      modelLabel: "deepseek-v4-flash",
      subagentModelLabel: "deepseek-v4-flash",
      enabledModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
      onModelChange,
      onSubagentModelChange,
    });

    const pick = (trigger: string) => {
      fireEvent.click(container.querySelector(trigger)!);
      const row = Array.from(container.querySelectorAll(".model-menu-list .popup-item")).find(
        (el) => el.textContent?.includes("deepseek-v4-pro"),
      );
      fireEvent.click(row!);
    };

    // The main pill switches the chat's own model and leaves the subagent pin alone.
    pick(".model-pill:not(.subagent-pill)");
    expect(onModelChange).toHaveBeenCalledWith("deepseek-v4-pro");
    expect(onSubagentModelChange).not.toHaveBeenCalled();

    // The subagent pill switches only the child model.
    pick(".subagent-pill");
    expect(onSubagentModelChange).toHaveBeenCalledWith("deepseek-v4-pro");
    expect(onModelChange).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing uncatalogued active model without a Custom entry control", () => {
    const { container } = renderComposer({ modelLabel: "legacy-gateway-model" });
    fireEvent.click(container.querySelector(".model-pill")!);
    expect(container.querySelector('.popup-item[data-active="true"]')?.textContent).toContain(
      "legacy-gateway-model",
    );
    expect(container.querySelector(".model-menu-list input")).toBeNull();
  });

  it("renders provider category headers without a Custom provider", () => {
    const { container } = renderComposer({
      antigravityModels: ["gemini-3.7-flash-tiered"],
      ollamaModels: ["llama3.1:latest"],
      enabledModels: [
        "gemini-3.7-flash-tiered",
        "ollama/llama3.1:latest",
        ...SUPPORTED_OFFICIAL_MODELS,
        ...OPENAI_MODELS,
        ...ZAI_MODELS,
        ...OPENCODE_MODELS,
      ],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const groups = Array.from(container.querySelectorAll(".model-menu-group")).map(
      (el) => el.querySelector(".grow")?.textContent,
    );
    expect(groups).toEqual([
      "DeepSeek",
      "ChatGPT",
      "Z.AI",
      "OpenCode",
      "Google Antigravity",
      "Ollama",
    ]);
  });

  it("shows dynamically discovered OpenCode vision capability", () => {
    const { container } = renderComposer({
      opencodeModels: ["dynamic-vision-free"],
      opencodeVisionModels: new Set(["dynamic-vision-free"]),
      enabledModels: ["dynamic-vision-free"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const item = Array.from(container.querySelectorAll(".popup-item")).find((el) =>
      el.textContent?.includes("dynamic-vision-free"),
    );
    expect(item?.textContent).toContain("vision");
  });

  it("shows only enabledModels but keeps the active model visible", () => {
    const { container } = renderComposer({
      modelLabel: "glm-4.5",
      enabledModels: ["glm-4.5", "ollama/qwen3:32b"],
      ollamaModels: ["llama3.1:latest", "qwen3:32b"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const mainText = container.querySelector(".model-menu-list")?.textContent ?? "";
    // Allow-list: only enabled ids appear...
    expect(mainText).toContain("glm-4.5");
    expect(mainText).toContain("qwen3:32b");
    expect(mainText).not.toContain("ollama/llama3.1:latest");
    expect(mainText).not.toContain("deepseek-v4-pro");

    fireEvent.click(container.querySelector(".subagent-pill")!);
    const subText = container.querySelector(".model-menu-list")?.textContent ?? "";
    expect(subText).not.toContain("deepseek-v4-pro");
  });

  it("keeps the active model visible and shows the enable hint when nothing is enabled", () => {
    const { container } = renderComposer({
      modelLabel: "glm-4.5",
      enabledModels: [],
      ollamaModels: ["llama3.1:latest", "qwen3:32b"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);
    const mainText = container.querySelector(".model-menu-list")?.textContent ?? "";
    // Active model escapes the filter so a hidden-but-selected tab never strands.
    expect(mainText).toContain("glm-4.5");
    expect(mainText).not.toContain("qwen3:32b");
    expect(mainText).toContain("No models enabled. Enable them in Settings");
  });

  it("subagent menu shares the backend-generated Ollama and Gemini models with the main agent", () => {
    const ollamaModels = ["llama3.1:latest", "qwen3:32b", "llava"];
    const antigravityModels = ["gemini-3.6-flash", "gemini-3.7-flash", "claude-3-5-sonnet"];
    const { container } = renderComposer({
      subagentModelLabel: "deepseek-v4-flash",
      ollamaModels,
      antigravityModels,
      enabledModels: [...ollamaModels.map((id) => `ollama/${id}`), ...antigravityModels],
    });

    fireEvent.click(container.querySelector(".model-pill")!);
    const mainText = container.querySelector(".model-menu-list")?.textContent ?? "";

    fireEvent.click(container.querySelector(".subagent-pill")!);
    const subText = container.querySelector(".model-menu-list")?.textContent ?? "";

    // The subagent menu carries the SAME backend-fetched models as the main
    // agent — Ollama catalog ids and the signed-in Antigravity/Gemini ids.
    for (const id of [...ollamaModels, ...antigravityModels]) {
      expect(mainText).toContain(id);
      expect(subText).toContain(id);
    }
    expect(subText).toContain("Google Antigravity");
    expect(subText).toContain("Ollama");
  });

  it("keeps discovered Antigravity models in their provider group", () => {
    const { container } = renderComposer({
      antigravityModels: [
        "claude-opus-4-6-thinking",
        "claude-sonnet-4-6",
        "gemini-3.7-flash-tiered",
      ],
      enabledModels: ["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gemini-3.7-flash-tiered"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);

    const getItemsForGroup = (groupTitle: string) => {
      const groupEl = Array.from(container.querySelectorAll(".model-menu-group")).find(
        (el) => el.querySelector(".grow")?.textContent === groupTitle,
      );
      if (!groupEl) return [];
      const items: string[] = [];
      let next = groupEl.nextElementSibling;
      while (next && !next.classList.contains("model-menu-group")) {
        if (next.classList.contains("popup-item")) {
          items.push(next.textContent ?? "");
        }
        next = next.nextElementSibling;
      }
      return items;
    };

    expect(getItemsForGroup("Custom")).toEqual([]);

    const antigravityItems = getItemsForGroup("Google Antigravity");
    expect(antigravityItems.some((t) => t.includes("claude-opus-4-6-thinking"))).toBe(true);
    expect(antigravityItems.some((t) => t.includes("claude-sonnet-4-6"))).toBe(true);
    expect(antigravityItems.some((t) => t.includes("gemini-3.7-flash-tiered"))).toBe(true);
  });
});

describe("desktop Composer picker anchor", () => {
  it("right-aligns the popup with its trigger", () => {
    expect(menuPopLeft({ triggerRight: 600, width: 420, viewportWidth: 1200, pad: 8 })).toBe(180);
  });

  it("slides the popup left instead of letting it leave the viewport", () => {
    expect(menuPopLeft({ triggerRight: 1198, width: 420, viewportWidth: 1200, pad: 8 })).toBe(772);
  });

  it("holds the popup at the viewport gutter when the trigger is near its left edge", () => {
    expect(menuPopLeft({ triggerRight: 100, width: 420, viewportWidth: 1200, pad: 8 })).toBe(8);
  });
});

describe("desktop Composer provider tags", () => {
  it("names the provider on the main and subagent model pills", () => {
    const { container } = renderComposer({
      modelLabel: "deepseek-v4-flash",
      subagentModelLabel: "glm-5.3-flash",
    });

    expect(container.querySelector(".model-pill")?.textContent).toBe("DS · deepseek-v4-flash");
    expect(container.querySelector(".subagent-pill")?.textContent).toBe("ZAI · glm-5.3-flash");
  });

  it("tags an id only the live catalog lists", () => {
    const { container } = renderComposer({
      modelLabel: "brand-new-model",
      opencodeModels: ["brand-new-model"],
    });

    expect(container.querySelector(".model-pill")?.textContent).toBe("OC · brand-new-model");
  });

  it("tags each picker row, so a resold id keeps its own provider", () => {
    const { container } = renderComposer({
      modelLabel: "deepseek-v4-flash",
      // The live OpenCode catalog resells an id DeepSeek owns natively.
      opencodeModels: ["deepseek-v4-flash"],
      enabledModels: ["deepseek-v4-flash", "opencode/deepseek-v4-flash"],
    });
    fireEvent.click(container.querySelector(".model-pill")!);

    const rows = Array.from(container.querySelectorAll(".model-menu-list .popup-item .cmd")).map(
      (row) => row.textContent,
    );
    expect(rows).toContain("DS · deepseek-v4-flash");
    expect(rows).toContain("OC · deepseek-v4-flash");
  });
});
