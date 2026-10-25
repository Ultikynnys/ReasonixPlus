// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (message: { payload: unknown }) => void>();
  const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
    if (command === "voice_model_fetch") {
      return { engine: "bark", repoId: "repo", revision: "rev", files: [], bytes: 1 };
    }
    if (command === "voice_bark_transcribe") return "transcribed";
    return { installed: true, dir: "/runtimes/bark", bytes: 1 };
  });
  const listen = vi.fn(
    async (event: string, handler: (message: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return () => {
        handlers.delete(event);
      };
    },
  );
  return { invoke, listen, handlers };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { fetchBarkModel, installBarkRuntime, transcribeWithBark } from "./bark-engine";
import { VOICE_MODELS } from "./model-registry";
import { BARK_RUNTIME, voiceRuntimeDirName } from "./runtimes";

const ARCHIVE = VOICE_MODELS.find((model) => model.format === "bark")!;
const CHECKPOINT = VOICE_MODELS.find((model) => model.format === "safetensors")!;
const RUNTIME_DIR = voiceRuntimeDirName(BARK_RUNTIME);

const argsOf = (command: string): Record<string, unknown> =>
  invoke.mock.calls.find(([name]) => name === command)?.[1] as Record<string, unknown>;

describe("Bark packaging", () => {
  beforeEach(() => {
    invoke.mockClear();
    listen.mockClear();
    handlers.clear();
  });

  it("asks for the archive and its official loader", async () => {
    await fetchBarkModel(ARCHIVE);

    expect(argsOf("voice_model_fetch").files).toEqual(["model.bark", "bark_loader.py"]);
  });

  it("asks for the whole checkpoint when the repo has no archive", async () => {
    await fetchBarkModel(CHECKPOINT);

    const files = argsOf("voice_model_fetch").files as string[];
    expect(files).toContain("model.safetensors");
    expect(files).toContain("config.json");
    expect(files).toContain("generation_config.json");
    expect(files).toContain("tokenizer.json");
    expect(files).not.toContain("bark_loader.py");
  });

  it("sends the declared format with a transcription", async () => {
    await expect(transcribeWithBark(CHECKPOINT, new Float32Array(4))).resolves.toBe("transcribed");

    const args = argsOf("voice_bark_transcribe");
    expect(args.format).toBe("safetensors");
    expect(args.weightsFile).toBe("model.safetensors");
    expect(args.loaderFile).toBe("");
    expect(args.paddingSeconds).toBe(CHECKPOINT.paddingSeconds);
  });

  it("forwards only its own runtime's provisioning phases", async () => {
    const phases: string[] = [];
    invoke.mockImplementationOnce(async () => {
      const emit = handlers.get("voice-runtime-progress");
      expect(emit).toBeTruthy();
      emit!({ payload: { dirName: "someone-else", phase: "installer" } });
      emit!({ payload: { dirName: RUNTIME_DIR, phase: "packages" } });
      return { installed: true, dir: "/runtimes/bark", bytes: 1 };
    });

    await installBarkRuntime((phase) => phases.push(phase));

    expect(phases).toEqual(["packages"]);
  });

  it("forwards only the progress of the model being fetched", async () => {
    const updates: number[] = [];
    invoke.mockImplementationOnce(async () => {
      const emit = handlers.get("voice-model-progress");
      expect(emit).toBeTruthy();
      emit!({ payload: { repoId: "another/repo", file: "model.bark", loaded: 1, total: 2 } });
      emit!({ payload: { repoId: ARCHIVE.repoId, file: "model.bark", loaded: 7, total: 9 } });
      return { engine: "bark", repoId: ARCHIVE.repoId, revision: "rev", files: [], bytes: 9 };
    });

    await fetchBarkModel(ARCHIVE, (progress) => updates.push(progress.loaded));

    expect(updates).toEqual([7]);
  });
});
