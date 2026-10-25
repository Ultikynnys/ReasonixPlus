/**
 * Bark engine: the host-side runtime that decodes `.bark` archives and loads
 * plain checkpoints. Neither the runtime nor the weights ship with the app.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { BarkFormat, VoiceModelOption } from "./model-registry";
import { BARK_RUNTIME, voiceRuntimeDirName } from "./runtimes";

/** The recorder resamples to 16 kHz mono before any engine sees the audio. */
export const BARK_SAMPLE_RATE = 16000;

/** Stable directory of the shared runtime, derived from the pinned spec. */
const RUNTIME_DIR = voiceRuntimeDirName(BARK_RUNTIME);

/** Provisioning phases the host reports while installing a runtime. */
export type BarkRuntimePhase = "installer" | "environment" | "packages" | "ready";

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

export interface BarkFileProgress {
  repoId: string;
  file: string;
  loaded: number;
  total: number;
}

/** The command returns null when the browser shim stands in for the host. */
function requireHost<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} needs the desktop app; this browser build has no host runtime.`);
  }
  return value;
}

interface BarkPackaging {
  format: BarkFormat;
  weightsFile: string;
  loaderFile: string;
  /** Everything the repo must deliver: the weights plus the files beside them. */
  files: string[];
}

/** One authority for which files a Bark declaration needs on disk. */
function packaging(option: VoiceModelOption): BarkPackaging {
  if (!option.format || !option.weightsFile) {
    throw new Error(`${option.name} declares no format or weights file.`);
  }
  const loaderFile = option.loaderFile ?? "";
  return {
    format: option.format,
    weightsFile: option.weightsFile,
    loaderFile,
    files: [option.weightsFile, ...option.supportingFiles, ...(loaderFile ? [loaderFile] : [])],
  };
}

/** Subscribe without failing the caller when there is no host to report events. */
async function subscribe<T>(event: string, accept: (payload: T) => void): Promise<() => void> {
  try {
    return await listen<T>(event, (message) => accept(message.payload));
  } catch {
    return () => {};
  }
}

export async function barkRuntimeStatus(): Promise<BarkRuntimeStatus> {
  const status = await invoke<BarkRuntimeStatus | null>("voice_runtime_status", {
    dirName: RUNTIME_DIR,
  });
  return requireHost(status, "Bark");
}

export async function installBarkRuntime(
  onPhase?: (phase: BarkRuntimePhase) => void,
): Promise<BarkRuntimeStatus> {
  const unlisten = onPhase
    ? await subscribe<{ dirName: string; phase: BarkRuntimePhase }>(
        "voice-runtime-progress",
        (payload) => {
          if (payload.dirName === RUNTIME_DIR) onPhase(payload.phase);
        },
      )
    : () => {};
  try {
    const status = await invoke<BarkRuntimeStatus | null>("voice_runtime_install", {
      dirName: RUNTIME_DIR,
      python: BARK_RUNTIME.python,
      requirements: [...BARK_RUNTIME.requirements],
      installerVersion: BARK_RUNTIME.installer.version,
    });
    return requireHost(status, "Bark");
  } finally {
    unlisten();
  }
}

export async function removeBarkRuntime(): Promise<void> {
  await invoke("voice_runtime_remove", { dirName: RUNTIME_DIR });
}

/** Every Bark model already on disk, across the whole family. */
export async function installedBarkModels(): Promise<readonly BarkModelInstall[]> {
  const models = await invoke<BarkModelInstall[] | null>("voice_model_status");
  return requireHost(models, "Bark");
}

export async function fetchBarkModel(
  option: VoiceModelOption,
  onProgress?: (progress: BarkFileProgress) => void,
): Promise<BarkModelInstall> {
  const { files } = packaging(option);
  const unlisten = onProgress
    ? await subscribe<BarkFileProgress>("voice-model-progress", (payload) => {
        if (payload.repoId === option.repoId) onProgress(payload);
      })
    : () => {};
  try {
    const installed = await invoke<BarkModelInstall | null>("voice_model_fetch", {
      engine: option.engine,
      repoId: option.repoId,
      files,
    });
    return requireHost(installed, "Bark");
  } finally {
    unlisten();
  }
}

export async function removeBarkModel(option: VoiceModelOption): Promise<void> {
  await invoke("voice_model_remove", { engine: option.engine, repoId: option.repoId });
}

export async function transcribeWithBark(
  option: VoiceModelOption,
  audioData: Float32Array,
): Promise<string> {
  const { format, weightsFile, loaderFile } = packaging(option);
  const text = await invoke<string | null>("voice_bark_transcribe", {
    runtimeDirName: RUNTIME_DIR,
    engine: option.engine,
    repoId: option.repoId,
    format,
    weightsFile,
    loaderFile,
    paddingSeconds: option.paddingSeconds ?? 0,
    samples: Array.from(audioData),
    sampleRate: BARK_SAMPLE_RATE,
    device: BARK_RUNTIME.device,
  });
  return requireHost(text, "Bark");
}
