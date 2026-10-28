// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
import { MailProvider } from "../protocol";
import { AudioRecorder } from "../voice/audio-recorder";
import { setCachedAudioInputDevices } from "../voice/device";
import { markVoiceModelDownloaded, setActiveVoiceModelId } from "../voice/model-cache";
import { VOICE_MODELS, isVoiceModelAvailable } from "../voice/model-registry";
import { speechTranscriber } from "../voice/transcriber";
import { AudioInputDeviceTest, SettingsModal, VoiceInputSettings } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("VoiceInputSettings: models", () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveVoiceModelId("whisper-tiny.en");
    speechTranscriber.setModel("whisper-tiny.en");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mockSettings: Settings = {
    version: "1.0.0",
    reasoningEffort: "high",
    editMode: "follow",
    workspaceDir: "/test",
    recentWorkspaces: [],
    model: "deepseek-v4-flash",
  };

  const baseProps = {
    settings: mockSettings,
    fontScale: "medium" as const,
    onSetFontScale: vi.fn(),
    fontFamily: "sans" as const,
    onSetFontFamily: vi.fn(),
    customFontFamily: "",
    onSetCustomFontFamily: vi.fn(),
    mcpSpecs: [],
    mcpBridged: false,
    plugins: [],
    onInstallPlugin: vi.fn(),
    onUninstallPlugin: vi.fn(),
    onRequestPlugins: vi.fn(),
    skills: [],
    onInstallSkill: vi.fn(),
    onUninstallSkill: vi.fn(),
    onRequestSkills: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn(),
    onSaveApiKey: vi.fn(),
    oauthWaiting: false,
    onOAuthBegin: vi.fn(),
    onOAuthCancel: vi.fn(),
    onOAuthSignOut: vi.fn(),
    onSaveOpenAIApiKey: vi.fn(),
    antigravityOAuthWaiting: false,
    onAntigravityOAuthBegin: vi.fn(),
    onAntigravityOAuthCancel: vi.fn(),
    onAntigravityOAuthSignOut: vi.fn(),
    opencodeOAuthWaiting: false,
    onOpencodeOAuthBegin: vi.fn(),
    onOpencodeOAuthCancel: vi.fn(),
    onOpencodeOAuthSignOut: vi.fn(),
    mimoOAuthWaiting: false,
    onMiMoOAuthBegin: vi.fn(),
    onMiMoOAuthCancel: vi.fn(),
    onMiMoOAuthSignOut: vi.fn(),
    onAddMcpSpec: vi.fn(),
    onRemoveMcpSpec: vi.fn(),
    onToggleMcpServer: vi.fn(),
    mcpExtensionStatus: null,
    mcpExtensionCheck: null,
    playwrightBrowserInstall: null,
    onRequestMcpExtensionStatus: vi.fn(),
    onConfigureMcpExtension: vi.fn(),
    onCheckMcpExtension: vi.fn(),
    onInstallPlaywrightBrowser: vi.fn(),
    onCancelPlaywrightBrowserInstall: vi.fn(),
    mailProvider: MailProvider.Outlook,
    mailAuth: null,
    onSetMailProvider: vi.fn(),
    onRequestMailStatus: vi.fn(),
    onConfigureMail: vi.fn(),
    onConnectMail: vi.fn(),
    onCancelMail: vi.fn(),
    onSignOutMail: vi.fn(),
    mcpAuth: null,
    onConnectServer: vi.fn(),
    onCancelServerSignIn: vi.fn(),
    onDisconnectServer: vi.fn(),
    changelog: { releases: [], version: "", error: null, loaded: true },
    onRefreshChangelog: vi.fn(),
  };

  it("renders every declared model, downloading only the ones this build can run", () => {
    render(<VoiceInputSettings />);

    expect(screen.getByText("Voice processing model")).toBeTruthy();
    for (const model of VOICE_MODELS) {
      expect(screen.getByText(model.name)).toBeTruthy();
    }

    // No model is downloaded by default; all download on demand
    expect(screen.queryByText(/✓ Active/)).toBeNull();

    // Only a model whose engine this build loads offers a Download button.
    const runnable = VOICE_MODELS.filter((model) => isVoiceModelAvailable(model));
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(runnable.length);
  });

  it("renders a cactus card from its declaration", () => {
    const cactus = VOICE_MODELS.find((model) => model.engine === "cactus");
    expect(cactus).toBeTruthy();
    render(<VoiceInputSettings />);

    const card = screen.getByText(cactus!.name).closest(".voice-card") as HTMLElement;
    expect(within(card).getByText(cactus!.size)).toBeTruthy();
    if (cactus!.badge) expect(within(card).getByText(cactus!.badge)).toBeTruthy();
    expect(within(card).getByText("Cactus engine")).toBeTruthy();
    // A model that publishes no parameter count renders no params cell.
    if (!cactus!.parameters) expect(within(card).queryByText(/params/)).toBeNull();
  });

  it("offers a download for a bark model instead of a requirement", () => {
    const bark = VOICE_MODELS.find((model) => model.engine === "bark");
    expect(bark).toBeTruthy();
    expect(isVoiceModelAvailable(bark!)).toBe(true);
    render(<VoiceInputSettings />);

    const card = screen.getByText(bark!.name).closest(".voice-card") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Download" })).toBeTruthy();
    // The card states the one-time runtime cost before the user commits.
    expect(within(card).getByText("Python runtime")).toBeTruthy();
    expect(within(card).getByText(/installed once and reused/)).toBeTruthy();
    expect(within(card).queryByText(/MLX/)).toBeNull();
  });

  it("handles successful in-app download and activates model", async () => {
    vi.spyOn(speechTranscriber, "downloadModel").mockImplementation(async (_id, onProgress) => {
      onProgress?.({
        status: "progress",
        file: "onnx/encoder_model_quantized.onnx",
        progress: 50,
      });
      markVoiceModelDownloaded("Xenova/whisper-base.en", true);
    });

    render(<VoiceInputSettings />);

    const baseCard = screen
      .getByText("Whisper Base (English)")
      .closest(".voice-card") as HTMLElement;
    const baseDownloadBtn = within(baseCard).getByRole("button", { name: "Download" });

    await act(async () => {
      fireEvent.click(baseDownloadBtn);
    });

    expect(speechTranscriber.downloadModel).toHaveBeenCalledWith(
      "Xenova/whisper-base.en",
      expect.any(Function),
    );
    expect(speechTranscriber.activeModel).toBe("Xenova/whisper-base.en");
  });

  it("displays an error alert when download fails without silent failure", async () => {
    vi.spyOn(speechTranscriber, "downloadModel").mockRejectedValue(
      new Error("Network connection lost during download"),
    );

    render(<VoiceInputSettings />);

    const baseCard = screen
      .getByText("Whisper Base (English)")
      .closest(".voice-card") as HTMLElement;
    const baseDownloadBtn = within(baseCard).getByRole("button", { name: "Download" });

    await act(async () => {
      fireEvent.click(baseDownloadBtn);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain("Network connection lost during download");

    // Active model was NOT silently changed:
    expect(speechTranscriber.activeModel).toBe("whisper-tiny.en");
  });

  it("allows deleting a downloaded model to free space", async () => {
    markVoiceModelDownloaded("Xenova/whisper-small.en", true);

    render(<VoiceInputSettings />);

    const deleteBtn = await screen.findByTitle("Delete downloaded files to free space");
    expect(deleteBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    // Model is no longer downloaded, Download button returns
    const downloadBtns = screen.getAllByRole("button", { name: "Download" });
    expect(downloadBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("renders voice settings in the general tab and not in models", () => {
    const { unmount } = render(<SettingsModal {...baseProps} initialPage="general" />);
    expect(screen.getByText("Voice processing model")).toBeTruthy();
    expect(screen.getByText("Audio input device")).toBeTruthy();
    unmount();

    render(<SettingsModal {...baseProps} initialPage="models" />);
    expect(screen.queryByText("Voice processing model")).toBeNull();
    expect(screen.queryByText("Audio input device")).toBeNull();
  });

  it("reorders custom quick sends from the quick send settings page", () => {
    const onSave = vi.fn();
    const settings: Settings = {
      ...mockSettings,
      quickSends: [
        { id: "a", message: "alpha", shorthand: "alpha" },
        { id: "b", message: "beta", shorthand: "beta" },
      ],
    };
    render(
      <SettingsModal {...baseProps} settings={settings} onSave={onSave} initialPage="quickSend" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move quick send down: alpha" }));
    expect(onSave).toHaveBeenCalledWith({
      quickSends: [
        { id: "b", message: "beta", shorthand: "beta" },
        { id: "a", message: "alpha", shorthand: "alpha" },
      ],
    });
  });

  it("deletes a custom quick send from the quick send settings page", () => {
    const onSave = vi.fn();
    const settings: Settings = {
      ...mockSettings,
      quickSends: [
        { id: "a", message: "alpha", shorthand: "alpha" },
        { id: "b", message: "beta", shorthand: "beta" },
      ],
    };
    render(
      <SettingsModal {...baseProps} settings={settings} onSave={onSave} initialPage="quickSend" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove quick send: alpha" }));
    expect(onSave).toHaveBeenCalledWith({
      quickSends: [{ id: "b", message: "beta", shorthand: "beta" }],
    });
  });

  it("adds a custom quick send from the quick send settings form", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...baseProps} onSave={onSave} initialPage="quickSend" />);

    fireEvent.change(screen.getByPlaceholderText("Shorthand (dropdown label, max 20 chars)"), {
      target: { value: "Deploy" },
    });
    fireEvent.change(screen.getByPlaceholderText("Message sent to the model"), {
      target: { value: "deploy to production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add quick send" }));

    expect(onSave).toHaveBeenCalledWith({
      quickSends: [
        expect.objectContaining({
          id: expect.stringMatching(/^custom-/),
          message: "deploy to production",
          shorthand: "Deploy",
        }),
      ],
    });
  });

  it("enforces max length on explicit shorthand in custom quick send", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...baseProps} onSave={onSave} initialPage="quickSend" />);

    fireEvent.change(screen.getByPlaceholderText("Shorthand (dropdown label, max 20 chars)"), {
      target: { value: "Deploy to production immediately" },
    });
    fireEvent.change(screen.getByPlaceholderText("Message sent to the model"), {
      target: { value: "deploy to production" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add quick send" }));

    expect(onSave).toHaveBeenCalledWith({
      quickSends: [
        expect.objectContaining({
          id: expect.stringMatching(/^custom-/),
          message: "deploy to production",
          shorthand: "Deploy to production",
        }),
      ],
    });
  });
});

describe("VoiceInputSettings: microphone", () => {
  const grantConsent = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /allow microphone recording/i }));
    });
  };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "permissions", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "audioinput", deviceId: "mic-1", label: "Built-in Microphone" },
          { kind: "audioinput", deviceId: "mic-2", label: "USB Headset" },
        ]),
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("gates the device list behind an explicit consent button", () => {
    render(<VoiceInputSettings />);

    expect(screen.getByText("Audio input device")).toBeTruthy();
    expect(screen.getByRole("button", { name: /allow microphone recording/i })).toBeTruthy();
    // No enumeration, no picker, and no audio test until consent is granted.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Test microphone")).toBeNull();
  });

  it("merges models and microphone into one card, models left and mic right", () => {
    render(<VoiceInputSettings />);

    expect(screen.getByText("Voice input")).toBeTruthy();
    const cards = document.querySelectorAll(".provider-card");
    expect(cards).toHaveLength(1);
    const cols = Array.from(
      cards[0]!.querySelectorAll(".provider-body > .provider-col"),
    ) as HTMLElement[];
    expect(cols).toHaveLength(2);
    expect(within(cols[0]!).getByText("Voice processing model")).toBeTruthy();
    expect(within(cols[0]!).getByText("Whisper Tiny (English)")).toBeTruthy();
    expect(within(cols[1]!).getByText("Audio input device")).toBeTruthy();
    expect(
      within(cols[1]!).getByRole("button", { name: /allow microphone recording/i }),
    ).toBeTruthy();
  });

  it("reveals the real device list and audio test after granting access", async () => {
    render(<VoiceInputSettings />);
    await grantConsent();

    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => {
      const options = Array.from(select.options).map((o) => o.textContent);
      expect(options).toContain("Built-in Microphone");
      expect(options).toContain("USB Headset");
      expect(options).toContain("System default");
    });
    expect(screen.getByText("Test microphone")).toBeTruthy();
  });

  it("selects a device and persists the choice", async () => {
    render(<VoiceInputSettings />);
    await grantConsent();

    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.textContent)).toContain("USB Headset");
    });
    fireEvent.change(select, { target: { value: "mic-2" } });

    expect(localStorage.getItem("reasonix.voiceInputDevice")).toBe("mic-2");
    expect(select.value).toBe("mic-2");
  });

  it("persists microphone setup across an app relaunch without another WebView2 probe", async () => {
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: "audioinput", deviceId: "mic-1", label: "Built-in Microphone" },
      { kind: "audioinput", deviceId: "mic-2", label: "USB Headset" },
    ]);
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        enumerateDevices,
        getUserMedia,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });

    const firstLaunch = render(<VoiceInputSettings />);
    await grantConsent();
    expect(localStorage.getItem("reasonix.voiceInputDevices")).toContain("USB Headset");
    firstLaunch.unmount();
    enumerateDevices.mockClear();
    getUserMedia.mockClear();

    render(<VoiceInputSettings />);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain("USB Headset");
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("restores cached microphones when Settings reopens without probing WebView2", () => {
    const query = vi.fn().mockResolvedValue({ state: "granted" });
    const enumerateDevices = vi.fn().mockResolvedValue([]);
    const getUserMedia = vi.fn();
    setCachedAudioInputDevices([
      { deviceId: "mic-1", label: "Built-in Microphone" },
      { deviceId: "mic-2", label: "USB Headset" },
    ]);
    localStorage.setItem("reasonix.voiceInputDevice", "mic-2");
    Object.defineProperty(navigator, "permissions", {
      value: { query },
      configurable: true,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        enumerateDevices,
        getUserMedia,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });

    const firstVisit = render(<VoiceInputSettings />);
    firstVisit.unmount();
    render(<VoiceInputSettings />);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain("USB Headset");
    expect(select.value).toBe("mic-2");
    expect(query).not.toHaveBeenCalled();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("enumerates microphones only when the user requests a refresh", async () => {
    setCachedAudioInputDevices([{ deviceId: "old-mic", label: "Old Microphone" }]);
    const enumerateDevices = vi
      .fn()
      .mockResolvedValue([
        { kind: "audioinput", deviceId: "fresh-mic", label: "Fresh Microphone" },
      ]);
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        enumerateDevices,
        getUserMedia: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });

    render(<VoiceInputSettings />);
    expect(enumerateDevices).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh microphone list" }));

    await waitFor(() => expect(enumerateDevices).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("option", { name: "Fresh Microphone" })).toBeTruthy();
  });

  it("re-matches the selection by label when the device id rotates", async () => {
    // First visit: pick the USB headset while the browser hands out one set of ids.
    render(<VoiceInputSettings />);
    await grantConsent();
    let select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.textContent)).toContain("USB Headset");
    });
    fireEvent.change(select, { target: { value: "mic-2" } });
    expect(localStorage.getItem("reasonix.voiceInputDevice")).toBe("mic-2");
    cleanup();

    // Second visit: the same devices come back under fresh ids (WebView2 re-derives
    // them from the current media-permission state).
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      configurable: true,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "audioinput", deviceId: "rotated-1", label: "Built-in Microphone" },
          { kind: "audioinput", deviceId: "rotated-2", label: "USB Headset" },
        ]),
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
    render(<VoiceInputSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh microphone list" }));
    select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("rotated-2"));
    // The healed id is persisted so the composer records from the right device.
    expect(localStorage.getItem("reasonix.voiceInputDevice")).toBe("rotated-2");
  });

  it("surfaces a denial and keeps the picker gated when access is refused", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        getUserMedia: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("blocked"), { name: "NotAllowedError" })),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
    render(<VoiceInputSettings />);
    await grantConsent();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not allowed/i);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("AudioInputDeviceTest", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("records on start and stops on demand", async () => {
    const start = vi.spyOn(AudioRecorder.prototype, "start").mockResolvedValue(undefined);
    const stop = vi
      .spyOn(AudioRecorder.prototype, "stop")
      .mockResolvedValue({ audioData: new Float32Array(160), durationSeconds: 0.01 });

    render(<AudioInputDeviceTest deviceId="" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /test microphone/i }));
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toMatch(/recording/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("surfaces a recorder startup failure", async () => {
    vi.spyOn(AudioRecorder.prototype, "start").mockRejectedValue(new Error("no microphone"));

    render(<AudioInputDeviceTest deviceId="" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /test microphone/i }));
    });

    expect(screen.getByRole("alert").textContent).toContain("no microphone");
  });
});
