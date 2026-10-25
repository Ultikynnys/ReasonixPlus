/**
 * Bark engine: the host-side runtime that decodes `.bark` archives.
 * Neither the runtime nor the weights ship with the app; both install on use.
 */

import { invoke } from "@tauri-apps/api/core";
import type { VoiceModelOption } from "./model-registry";
import { BARK_RUNTIME, voiceRuntimeDirName } from "./runtimes";

/** The recorder resamples to 16 kHz mono before any engine sees the audio. */
export const BARK_SAMPLE_RATE = 16000;

/** Stable directory of the shared runtime, derived from the pinned spec. */
const RUNTIME_DIR = voiceRuntimeDirName(BARK_RUNTIME);

export interface BarkRuntimeStatus {
  installed: boolean;
  dir: string;
  bytes: number;
}

export interface BarkModelInstall {
  engine: string;
  repoId: string;
  revision: string;
  files: readonly { name: string; bytes: number }[];
  bytes: number;
}

/** The command returns null when the browser shim stands in for the host. */
function requireHost<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} needs the desktop app; this browser build has no host runtime.`);
  }
  return value;
}

/** The archive and loader a Bark declaration must name, or a clear refusal. */
function barkFiles(option: VoiceModelOption): { weightsFile: string; loaderFile: string } {
  if (!option.weightsFile || !option.loaderFile) {
    throw new Error(`${option.name} declares no weights or loader file.`);
  }
  return { weightsFile: option.weightsFile, loaderFile: option.loaderFile };
}

export async function barkRuntimeStatus(): Promise<BarkRuntimeStatus> {
  const status = await invoke<BarkRuntimeStatus | null>("voice_runtime_status", {
    dirName: RUNTIME_DIR,
  });
  return requireHost(status, "Bark");
}

export async function installBarkRuntime(): Promise<BarkRuntimeStatus> {
  const status = await invoke<BarkRuntimeStatus | null>("voice_runtime_install", {
    dirName: RUNTIME_DIR,
    python: BARK_RUNTIME.python,
    requirements: [...BARK_RUNTIME.requirements],
    installerVersion: BARK_RUNTIME.installer.version,
  });
  return requireHost(status, "Bark");
}

export async function removeBarkRuntime(): Promise<void> {
  await invoke("voice_runtime_remove", { dirName: RUNTIME_DIR });
}

/** Every Bark model already on disk, across the whole family. */
export async function installedBarkModels(): Promise<readonly BarkModelInstall[]> {
  const models = await invoke<BarkModelInstall[] | null>("voice_model_status");
  return requireHost(models, "Bark");
}

export async function fetchBarkModel(option: VoiceModelOption): Promise<BarkModelInstall> {
  const installed = await invoke<BarkModelInstall | null>("voice_model_fetch", {
    engine: option.engine,
    repoId: option.repoId,
    ...barkFiles(option),
  });
  return requireHost(installed, "Bark");
}

export async function removeBarkModel(option: VoiceModelOption): Promise<void> {
  await invoke("voice_model_remove", { engine: option.engine, repoId: option.repoId });
}

export async function transcribeWithBark(
  option: VoiceModelOption,
  audioData: Float32Array,
): Promise<string> {
  const text = await invoke<string | null>("voice_bark_transcribe", {
    runtimeDirName: RUNTIME_DIR,
    engine: option.engine,
    repoId: option.repoId,
    ...barkFiles(option),
    paddingSeconds: option.paddingSeconds ?? 0,
    samples: Array.from(audioData),
    sampleRate: BARK_SAMPLE_RATE,
    device: BARK_RUNTIME.device,
  });
  return requireHost(text, "Bark");
}
