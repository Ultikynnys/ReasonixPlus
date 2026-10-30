// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "../protocol";
import { PageSkills } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "churn-analysis",
    name: "churn-analysis",
    description: "Predicts which accounts are about to leave.",
    path: "/home/.reasonix/skills/churn-analysis/SKILL.md",
    active: true,
    ...overrides,
  };
}

function renderPage(skills: SkillInfo[], overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const handlers = {
    onInstall: vi.fn(),
    onUninstall: vi.fn(),
    onRequest: vi.fn(),
    ...overrides,
  };
  const utils = render(<PageSkills skills={skills} {...handlers} />);
  return { ...utils, ...handlers };
}

describe("PageSkills", () => {
  it("asks the daemon for the inventory when it opens", () => {
    const { onRequest } = renderPage([]);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("explains the empty standalone list and still offers the install box", () => {
    renderPage([]);
    expect(screen.getByText("Standalone skills (0)")).toBeTruthy();
    expect(screen.getByText(/No standalone skill installed yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("renders an installed skill with its id, description, path and badge", () => {
    renderPage([skill()]);
    expect(screen.getByText("churn-analysis")).toBeTruthy();
    expect(screen.getByText(/Predicts which accounts are about to leave\./)).toBeTruthy();
    expect(screen.getByText("/home/.reasonix/skills/churn-analysis/SKILL.md")).toBeTruthy();
    expect(screen.getByText(/on in this chat/)).toBeTruthy();
  });

  it("leaves out the badge for a skill this chat did not enable", () => {
    renderPage([skill({ active: false })]);
    expect(screen.queryByText(/on in this chat/)).toBeNull();
  });

  it("says that enablement is chosen per chat", () => {
    renderPage([]);
    expect(screen.getByText(/chosen when that chat starts/)).toBeTruthy();
  });

  it("installs from the source field and clears it", () => {
    const { onInstall } = renderPage([]);
    const field = screen.getByLabelText("Source");
    fireEvent.change(field, { target: { value: "  anthropics/skills  " } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(onInstall).toHaveBeenCalledWith("anthropics/skills");
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("keeps the install button disabled until a source is typed", () => {
    renderPage([]);
    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("removes a skill by id", () => {
    const { onUninstall } = renderPage([skill()]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onUninstall).toHaveBeenCalledWith(["churn-analysis"]);
  });

  it("shows a read failure instead of hiding the card", () => {
    renderPage([skill({ error: "unreadable SKILL.md" })]);
    expect(screen.getByText(/SKILL\.md error: unreadable SKILL\.md/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });
});

/** One install that delivered several skills, as the daemon reports it. */
const SOURCE = "https://github.com/LLMQuant/skills";

function repositorySkills(): SkillInfo[] {
  return ["commodities", "credit", "crypto"].map((topic) => {
    const id = `llmquant-${topic}`;
    return skill({
      id,
      name: id,
      description: `Router skill for ${topic} workflows.`,
      path: `/home/.reasonix/skills/${id}/SKILL.md`,
      source: SOURCE,
    });
  });
}

describe("PageSkills groups", () => {
  /** The card's head, which is what opens the skills an install delivered. */
  function openGroup(label: string): void {
    fireEvent.click(screen.getByText(label));
  }

  it("reads one repository as one folded card instead of one card per skill", () => {
    renderPage(repositorySkills());
    expect(screen.getByText("LLMQuant/skills")).toBeTruthy();
    expect(screen.getByText(/3 skills/)).toBeTruthy();
    expect(screen.getByText("Standalone skills (3)")).toBeTruthy();
    // Folded, the card names the install and nothing else: no member rows, no source line.
    expect(screen.queryByText(`Installed from ${SOURCE}`)).toBeNull();
    expect(screen.queryByText("llmquant-credit")).toBeNull();
  });

  it("opens the card to the skills that install delivered", () => {
    renderPage(repositorySkills());
    openGroup("LLMQuant/skills");
    expect(screen.getByText(`Installed from ${SOURCE}`)).toBeTruthy();
    expect(screen.getByText("llmquant-commodities")).toBeTruthy();
    expect(screen.getByText("llmquant-credit")).toBeTruthy();
    expect(screen.getByText(/Router skill for credit workflows\./)).toBeTruthy();
  });

  it("says how many group members this chat runs", () => {
    renderPage(repositorySkills().map((s) => ({ ...s, active: s.id !== "llmquant-credit" })));
    expect(screen.getByText(/2 of 3 on in this chat/)).toBeTruthy();
  });

  it("removes the whole group in one click", () => {
    const { onUninstall } = renderPage(repositorySkills());
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(onUninstall).toHaveBeenCalledWith([
      "llmquant-commodities",
      "llmquant-credit",
      "llmquant-crypto",
    ]);
  });

  it("keeps every member removable on its own", () => {
    const { onUninstall } = renderPage(repositorySkills());
    openGroup("LLMQuant/skills");
    const removes = screen.getAllByRole("button", { name: "Remove" });
    expect(removes).toHaveLength(3);
    fireEvent.click(removes[1] as HTMLElement);
    expect(onUninstall).toHaveBeenCalledWith(["llmquant-credit"]);
  });

  it("names an inferred group by its shared prefix and says so", () => {
    renderPage(
      ["risk", "macro"].map((topic) =>
        skill({ id: `llmquant-${topic}`, name: `llmquant-${topic}` }),
      ),
    );
    expect(screen.getByText("llmquant-*")).toBeTruthy();
    openGroup("llmquant-*");
    expect(screen.getByText(/Grouped by their shared id prefix/)).toBeTruthy();
  });

  it("leaves a single install unfolded, since one skill is not a group", () => {
    renderPage([skill({ source: SOURCE })]);
    expect(screen.getByText("churn-analysis")).toBeTruthy();
    expect(screen.getByText(/Predicts which accounts are about to leave\./)).toBeTruthy();
  });
});
