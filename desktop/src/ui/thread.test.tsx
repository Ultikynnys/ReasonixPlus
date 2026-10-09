// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue("C:/downloads/output.bin"),
}));

vi.mock("./cards", () => ({
  AssistantText: () => null,
  PlanCardView: () => null,
  ShellCard: () => null,
  ToolCard: () => null,
  ReasoningCard: () => null,
  CompactionCard: () => null,
  DiffCard: () => null,
  SubagentCard: () => null,
  WarningCard: () => null,
  PreText: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  isSubagentTool: () => false,
  extractSubagentDetails: () => ({ task: "", skillName: "" }),
  extractSubagentResultMeta: () => ({}),
  parseEditResult: () => [],
}));

import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { AssistantSegment } from "../App";
import { ApprovalCard } from "./extra-cards";
import {
  AssistantMsg,
  CheckpointApprovalCard,
  ChoiceApprovalCard,
  ConfirmApprovalCard,
  PathAccessApprovalCard,
  PlanApprovalCard,
  findBackgroundJob,
  parseBackgroundJobId,
  parseSubmittedPlan,
} from "./thread";

function makeShellPrompt(command: string): import("@reasonix/core-utils").ApprovalPrompt {
  return {
    id: 1,
    kind: "shell",
    tone: "warn",
    title: "Run command",
    subtitle: command,
    preview: command,
    meta: {},
    actions: [
      { id: "run_once", label: "Run once", kind: "allow_once" },
      {
        id: "allow_workspace",
        label: "Add to workspace rules",
        kind: "allow_always",
        scope: "workspace",
      },
      { id: "allow_global", label: "Add to global rules", kind: "allow_always", scope: "global" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: command.split(" ")[0] ?? "" },
  };
}

function makePathPrompt(
  path: string,
  intent: "read" | "write",
): import("@reasonix/core-utils").ApprovalPrompt {
  return {
    id: 2,
    kind: "path",
    tone: "warn",
    title: `Access path — ${intent}`,
    subtitle: path,
    preview: `read_file → ${path}`,
    meta: { sandboxRoot: "/workspace" },
    actions: [
      {
        id: "run_once",
        label: intent === "write" ? "Allow write" : "Allow read",
        kind: "allow_once",
      },
      {
        id: "allow_workspace",
        label: "Add to workspace rules",
        kind: "allow_always",
        scope: "workspace",
      },
      { id: "allow_global", label: "Add to global rules", kind: "allow_always", scope: "global" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: "/workspace", intent },
  };
}

afterEach(cleanup);

describe("ConfirmApprovalCard — ApprovalPrompt rendering", () => {
  it("renders immutable Outlook send details without an always-allow action", () => {
    const prompt: import("@reasonix/core-utils").ApprovalPrompt = {
      id: 3,
      kind: "email",
      tone: "error",
      title: "Confirm Outlook email send",
      subtitle: "sender@outlook.com → recipient@example.com",
      preview: "Complete application body",
      meta: {
        From: "sender@outlook.com",
        To: "recipient@example.com",
        Cc: "copy@example.com",
        Bcc: "hidden@example.com",
        Subject: "Application",
        Attachments: "CV.pdf",
      },
      actions: [
        { id: "run_once", label: "Send this email", kind: "allow_once" },
        { id: "deny", label: "Cancel send", kind: "reject" },
      ],
    };
    const { container } = render(
      <ConfirmApprovalCard prompt={prompt} onAllow={() => {}} onDeny={() => {}} />,
    );
    expect(container.textContent).toContain("From: sender@outlook.com");
    expect(container.textContent).toContain("To: recipient@example.com");
    expect(container.textContent).toContain("Bcc: hidden@example.com");
    expect(container.textContent).toContain("Subject: Application");
    expect(container.textContent).toContain("Complete application body");
    expect(container.textContent).toContain("Attachments: CV.pdf");
    expect(screen.getByRole("button", { name: "Send this email" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel send" })).toBeTruthy();
    expect(screen.queryByText(/Always allow/)).toBeNull();
  });

  it("renders title, subtitle, and action buttons from prompt", () => {
    const { container } = render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("git status")}
        onAllow={() => {}}
        onAddWorkspaceRule={() => {}}
        onAddGlobalRule={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector(".card-head .name")?.textContent).toBe("Run command");
    expect(container.querySelector(".card-head .meta")?.textContent).toBe("git status");
    expect(screen.getByRole("button", { name: "Run once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to workspace rules" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to global rules" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("fires onAllow when primary button is clicked", () => {
    const onAllow = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("echo hi")}
        onAllow={onAllow}
        onAddWorkspaceRule={() => {}}
        onAddGlobalRule={() => {}}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it("fires the workspace-rule handler when the tertiary button is clicked", () => {
    const onAddWorkspaceRule = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("npm test")}
        onAllow={() => {}}
        onAddWorkspaceRule={onAddWorkspaceRule}
        onAddGlobalRule={() => {}}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to workspace rules" }));
    expect(onAddWorkspaceRule).toHaveBeenCalledTimes(1);
  });

  it("hides a scope's add-rule button when the prompt already covers it", () => {
    const base = makeShellPrompt("npm test");
    render(
      <ConfirmApprovalCard
        prompt={{ ...base, actions: base.actions.filter((a) => a.scope !== "workspace") }}
        onAllow={() => {}}
        onAddWorkspaceRule={() => {}}
        onAddGlobalRule={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add to workspace rules" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add to global rules" })).toBeTruthy();
  });

  it("fires onDeny when secondary button is clicked", () => {
    const onDeny = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("rm -rf /")}
        onAllow={() => {}}
        onAddWorkspaceRule={() => {}}
        onAddGlobalRule={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});

describe("PathAccessApprovalCard — ApprovalPrompt rendering", () => {
  it("renders title, subtitle, and action buttons from prompt", () => {
    const { container } = render(
      <PathAccessApprovalCard
        prompt={makePathPrompt("/etc/passwd", "read")}
        onAllow={() => {}}
        onAddWorkspaceRule={() => {}}
        onAddGlobalRule={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector(".card-head .name")?.textContent).toBe("Access path — read");
    expect(container.querySelector(".card-head .meta")?.textContent).toBe("/etc/passwd");
    expect(screen.getByRole("button", { name: "Allow read" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("fires the global-rule handler for path access", () => {
    const onAddGlobalRule = vi.fn();
    render(
      <PathAccessApprovalCard
        prompt={makePathPrompt("/tmp", "write")}
        onAllow={() => {}}
        onAddWorkspaceRule={() => {}}
        onAddGlobalRule={onAddGlobalRule}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to global rules" }));
    expect(onAddGlobalRule).toHaveBeenCalledTimes(1);
  });
});

describe("ApprovalCard collapse", () => {
  it("hides the fancy card body while preserving its header and metadata", () => {
    render(
      <ApprovalCard
        kind="plan"
        title="Start plan"
        meta="plan approved"
        body={<div>formatted plan steps</div>}
      />,
    );
    const header = screen.getByRole("button");
    expect(screen.getByText("formatted plan steps")).toBeTruthy();
    fireEvent.click(header);
    expect(screen.queryByText("formatted plan steps")).toBeNull();
    expect(screen.getByText("plan approved")).toBeTruthy();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(screen.getByText("formatted plan steps")).toBeTruthy();
  });
});

describe("structured result card parsing", () => {
  it("preserves submitted plan structure after approval", () => {
    const plan = parseSubmittedPlan(
      JSON.stringify({
        plan: "Implement the fix",
        summary: "UI hardening",
        steps: [{ id: "s1", title: "Update card", action: "Edit the renderer", risk: "low" }],
      }),
    );
    expect(plan).toEqual({
      plan: "Implement the fix",
      summary: "UI hardening",
      steps: [{ id: "s1", title: "Update card", action: "Edit the renderer", risk: "low" }],
    });
    expect(parseSubmittedPlan("plan approved")).toBeUndefined();
  });
});

describe("background job card correlation", () => {
  function job(over: Partial<import("../protocol").JobInfo>): import("../protocol").JobInfo {
    return {
      id: 1,
      tabId: "t1",
      sessionLabel: "session",
      command: "curl -o out.bin https://example.com/big.bin",
      pid: 100,
      running: true,
      exitCode: null,
      startedAt: 0,
      outputTail: "",
      ...over,
    };
  }

  it("parses the job id from a run_background result header", () => {
    expect(
      parseBackgroundJobId("[job 7 started · pid 12168 · running (no ready signal yet)]"),
    ).toBe(7);
    expect(parseBackgroundJobId("[job 12 exited during startup · exit 1]")).toBe(12);
    expect(parseBackgroundJobId("[job 3 failed to start]")).toBe(3);
    expect(parseBackgroundJobId("no header here")).toBeUndefined();
  });

  it("scopes the lookup to the owning tab so ids don't collide across tabs", () => {
    const running = job({ id: 7, tabId: "t1", running: true });
    const exited = job({ id: 7, tabId: "t2", running: false, exitCode: 0 });
    expect(findBackgroundJob([running, exited], "t1", 7)).toBe(running);
    expect(findBackgroundJob([running, exited], "t2", 7)).toBe(exited);
    expect(findBackgroundJob([running, exited], undefined, 7)).toBe(running);
    expect(findBackgroundJob([running], "t1", 99)).toBeUndefined();
    expect(findBackgroundJob(undefined, "t1", 7)).toBeUndefined();
    expect(findBackgroundJob([running], "t1", undefined)).toBeUndefined();
  });
});

describe("QuestionTimerRow — toggle stays in sync with the backend", () => {
  it("signals disable then enable for a choice card with a countdown", () => {
    const onTimerToggle = vi.fn();
    render(
      <ChoiceApprovalCard
        question="Pick one"
        options={[
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ]}
        countdownMs={30_000}
        onPick={() => {}}
        onCancel={() => {}}
        onTimerToggle={onTimerToggle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disable timer" }));
    expect(onTimerToggle).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Enable timer" }));
    expect(onTimerToggle).toHaveBeenLastCalledWith(true);
  });

  it("exposes the same toggle on a plan card, and hides it when there is no countdown", () => {
    const onTimerToggle = vi.fn();
    const props = {
      onApprove: () => {},
      onRefine: () => {},
      onCancel: () => {},
      onTimerToggle,
    };
    const { rerender } = render(
      <PlanApprovalCard
        id={2}
        plan="Do the thing"
        steps={[{ id: "s1", title: "one", action: "edit" }]}
        countdownMs={30_000}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Disable timer" }));
    expect(onTimerToggle).toHaveBeenLastCalledWith(false);

    rerender(<PlanApprovalCard id={2} plan="Do the thing" {...props} />);
    expect(screen.queryByRole("button", { name: "Disable timer" })).toBeNull();
    expect(screen.getByText("Question timer disabled")).toBeTruthy();
  });
});

describe("user-input cards render agent markdown", () => {
  const noop = () => {};

  it("formats the plan confirmation body as markdown", () => {
    const { container } = render(
      <PlanApprovalCard id={1} plan={"**Bold** step\n\n- first\n- second"} onApprove={noop} />,
    );
    expect(container.querySelector(".markdown strong")?.textContent).toBe("Bold");
    expect(container.querySelectorAll(".markdown li")).toHaveLength(2);
  });

  it("formats the choice question as inline markdown without a block wrapper", () => {
    const { container } = render(
      <ChoiceApprovalCard
        question={"Pick **one**"}
        options={[
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ]}
        onPick={noop}
      />,
    );
    const name = container.querySelector(".card-head .name");
    expect(name?.querySelector("strong")?.textContent).toBe("one");
    expect(name?.querySelector("p")).toBeNull();
  });

  it("formats a checkpoint result as markdown", () => {
    const { container } = render(
      <CheckpointApprovalCard
        c={{ id: 1, stepId: "s1", result: "**done**", completed: 1, total: 2 }}
        onContinue={noop}
        onRevise={noop}
        onStop={noop}
      />,
    );
    expect(container.querySelector(".markdown strong")?.textContent).toBe("done");
  });

  it("formats the email confirmation body as markdown while keeping header fields plain", () => {
    const prompt: import("@reasonix/core-utils").ApprovalPrompt = {
      id: 9,
      kind: "email",
      tone: "error",
      title: "Confirm Outlook email send",
      subtitle: "a@x.com -> b@y.com",
      preview: "**Dear** team",
      meta: { From: "a@x.com", Subject: "Hi" },
      actions: [
        { id: "run_once", label: "Send this email", kind: "allow_once" },
        { id: "deny", label: "Cancel send", kind: "reject" },
      ],
    };
    const { container } = render(
      <ConfirmApprovalCard prompt={prompt} onAllow={noop} onDeny={noop} />,
    );
    expect(container.querySelector(".markdown strong")?.textContent).toBe("Dear");
    expect(container.textContent).toContain("From: a@x.com");
  });
});

describe("AssistantMsg - presented files", () => {
  const noop = () => {};
  const segment: AssistantSegment = {
    kind: "tool",
    callId: "file-call",
    name: "present_file",
    args: JSON.stringify({ path: "assets/report.bin" }),
    result: JSON.stringify({ path: "C:/repo/assets/report.bin", name: "report.bin", size: 2048 }),
    startedAt: 0,
  };

  it("renders arbitrary files and invokes copy-file and save-as actions", async () => {
    const { container } = render(
      <AssistantMsg
        segments={[segment]}
        pending={false}
        pendingConfirms={[]}
        onApproveConfirm={noop}
        onRejectConfirm={noop}
        onRuleConfirm={noop}
        onStopTool={noop}
      />,
    );
    expect(container.querySelector(".presented-file-name")?.textContent).toBe("report.bin");
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy file" }));
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("copy_file_to_clipboard", {
        path: "C:/repo/assets/report.bin",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    await waitFor(() =>
      expect(vi.mocked(saveDialog)).toHaveBeenCalledWith({ defaultPath: "report.bin" }),
    );
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("copy_file_to_path", {
        source: "C:/repo/assets/report.bin",
        destination: "C:/downloads/output.bin",
      }),
    );
  });

  it("renders inline audio playback and an adjustable volume control", () => {
    const audio = {
      ...segment,
      result: JSON.stringify({
        path: "C:/repo/voice sample.mp3",
        name: "voice sample.mp3",
        size: 4096,
      }),
    };
    const { container } = render(
      <AssistantMsg
        segments={[audio]}
        pending={false}
        pendingConfirms={[]}
        onApproveConfirm={noop}
        onRejectConfirm={noop}
        onRuleConfirm={noop}
        onStopTool={noop}
      />,
    );
    const player = container.querySelector("audio");
    expect(player?.getAttribute("src")).toBe("asset://localhost/C:/repo/voice sample.mp3");
    expect(player?.getAttribute("controls")).not.toBeNull();
    const volume = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;
    fireEvent.change(volume, { target: { value: "0.35" } });
    expect(volume.value).toBe("0.35");
  });

  it("copies image pixels separately from copying the file", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public readonly items: Record<string, Blob>) {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      }),
    );
    const image = {
      ...segment,
      result: JSON.stringify({ path: "C:/repo/chart.png", name: "chart.png", size: 12 }),
    };
    render(
      <AssistantMsg
        segments={[image]}
        pending={false}
        pendingConfirms={[]}
        onApproveConfirm={noop}
        onRejectConfirm={noop}
        onRuleConfirm={noop}
        onStopTool={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(
      (write.mock.calls[0]![0] as Array<{ items: Record<string, Blob> }>)[0]!.items["image/png"],
    ).toBeInstanceOf(Blob);
    vi.unstubAllGlobals();
  });

  it("renders an inline image preview for presented images", () => {
    const image = {
      ...segment,
      result: JSON.stringify({ path: "C:/repo/chart.png", name: "chart.png", size: 12 }),
    };
    const { container } = render(
      <AssistantMsg
        segments={[image]}
        pending={false}
        pendingConfirms={[]}
        onApproveConfirm={noop}
        onRejectConfirm={noop}
        onRuleConfirm={noop}
        onStopTool={noop}
      />,
    );
    expect(container.querySelector(".presented-file-preview")?.getAttribute("src")).toBe(
      "asset://localhost/C:/repo/chart.png",
    );
    expect(screen.getByRole("button", { name: "Copy image" })).toBeTruthy();
  });
});

describe("AssistantMsg - an open gate never stacks a second card", () => {
  const noop = () => {};
  const choiceSegment: AssistantSegment = {
    kind: "tool",
    callId: "c1",
    name: "ask_choice",
    args: JSON.stringify({
      question: "Pick one",
      options: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    }),
    startedAt: 0,
  };
  const renderMsg = (segment: AssistantSegment, interventionPending: boolean) =>
    render(
      <AssistantMsg
        segments={[segment]}
        pending={false}
        pendingConfirms={[]}
        onApproveConfirm={noop}
        onRejectConfirm={noop}
        onRuleConfirm={noop}
        onStopTool={noop}
        isInterventionPending={interventionPending}
      />,
    );

  it("renders no transcript card while the choice gate is open", () => {
    const { container } = renderMsg(choiceSegment, true);
    expect(container.querySelector(".approval")).toBeNull();
  });

  it("renders exactly one record card once the choice is resolved", () => {
    const { container } = renderMsg({ ...choiceSegment, result: "user picked: a" }, false);
    expect(container.querySelectorAll(".approval")).toHaveLength(1);
  });
});
