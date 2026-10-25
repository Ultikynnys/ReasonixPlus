/**
 * Pinned engine runtimes: what an engine needs installed on the host before its
 * models can run, kept out of the app bundle and out of the update path.
 */

import barkRuntime from "./bark.json";

/** A host runtime an engine depends on: an interpreter plus exact wheels. */
export interface VoiceRuntimeSpec {
  /** Stable runtime identity, used in directory names and user-facing sizes. */
  id: string;
  /** Python series the installer provisions. */
  python: string;
  /** Device the pinned wheels are built for. */
  device: "cpu" | "cuda";
  installer: { id: "uv"; version: string };
  /** Exact pip requirement specifiers, installed as one set. */
  requirements: readonly string[];
  /** Download size reported before an install is committed. */
  estimatedBytes: number;
}

function fail(where: string, message: string): never {
  throw new Error(`voice-runtimes: ${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) fail(where, "expected a non-empty string");
  return value.trim();
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(where, "expected a positive number");
  }
  return value;
}

/** Validate one runtime document. Exported so tests can parse a synthetic runtime. */
export function parseVoiceRuntimeSpec(value: unknown, source: string): VoiceRuntimeSpec {
  const raw = record(value, source);
  const id = text(raw.id, `${source}: id`);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`${source}: id`, `invalid runtime id "${id}"`);
  const scope = `${source}: runtime "${id}"`;

  const device = text(raw.device, `${scope}: device`);
  if (device !== "cpu" && device !== "cuda") {
    fail(`${scope}: device`, `unsupported device "${device}"`);
  }

  const installer = record(raw.installer, `${scope}: installer`);
  const installerId = text(installer.id, `${scope}: installer.id`);
  if (installerId !== "uv") fail(`${scope}: installer.id`, `unsupported installer "${installerId}"`);

  if (!Array.isArray(raw.requirements) || raw.requirements.length === 0) {
    fail(`${scope}: requirements`, "expected a non-empty array");
  }
  const requirements = raw.requirements.map((entry, index) =>
    text(entry, `${scope}: requirements[${index}]`),
  );

  return {
    id,
    python: text(raw.python, `${scope}: python`),
    device,
    installer: { id: installerId, version: text(installer.version, `${scope}: installer.version`) },
    requirements,
    estimatedBytes: count(raw.estimatedBytes, `${scope}: estimatedBytes`),
  };
}

/** 64-bit FNV-1a: a directory discriminator, never a security boundary. */
function runtimeHash(canonical: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Identity of what an install produces. Only fields that change the installed
 * bytes take part, so an unrelated release reuses the same directory.
 */
export function voiceRuntimeSpecId(spec: VoiceRuntimeSpec): string {
  return runtimeHash(
    JSON.stringify({
      id: spec.id,
      python: spec.python,
      device: spec.device,
      installer: spec.installer,
      requirements: [...spec.requirements].sort(),
    }),
  );
}

/** Directory an installed runtime lives in, under the host's voice root. */
export function voiceRuntimeDirName(spec: VoiceRuntimeSpec): string {
  return `${spec.id}-${voiceRuntimeSpecId(spec)}`;
}

export const BARK_RUNTIME: VoiceRuntimeSpec = parseVoiceRuntimeSpec(
  barkRuntime,
  "runtimes/bark.json",
);

export const VOICE_RUNTIMES: readonly VoiceRuntimeSpec[] = [BARK_RUNTIME];

export function voiceRuntimeSpec(id: string): VoiceRuntimeSpec | undefined {
  return VOICE_RUNTIMES.find((spec) => spec.id === id);
}
