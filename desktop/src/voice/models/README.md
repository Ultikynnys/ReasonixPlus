# Voice models

One JSON file per speech-to-text model. The file name must equal the
declaration's `id` (`whisper-base.json` declares `"id": "whisper-base"`).

Nothing about a voice model is hardcoded elsewhere: the settings card, the
transcriber's model lookup, the download URL, the cache identity and every
sentence naming the model come from these files. What an `engine` can do is not
per-model, so it lives in one table instead: see Engine runtimes.

## Adding a model

1. Create `models/<id>.json`. Copy the closest existing file and edit it.
2. Run `npm run providers:sync`.
3. Run `npm test`.

`providers:sync` rewrites `../models.generated.ts`, which imports every file in
this directory and derives the `VoiceModelId` union from each document's
`modelId`. Skipping step 2 fails `tests/voice-model-files.test.ts`.

## Removing a model

1. Delete `models/<id>.json`.
2. Run `npm run providers:sync`.
3. Run `npm test`.

The card disappears because it renders from a declaration that no longer exists,
and the id leaves the `VoiceModelId` union, so a stale reference fails to
compile instead of silently resolving to another model.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Declaration id and file name: lowercase letters, digits and `-` |
| `modelId` | string | Persisted selection id (also stored under `reasonix.voiceModel`) and the key the transcriber resolves a model by. Hugging Face ids such as `Xenova/whisper-base.en` live here, because a `/` cannot appear in a file name |
| `engine` | `transformers`, `cactus` or `bark` | Runtime that loads and runs the model: the Transformers.js ASR pipeline, the Cactus `needle` engine, or the Bark Python sidecar |
| `order` | number | Settings card order, ascending |
| `default` | boolean | The model a fresh install uses. Exactly one declaration sets it, and its engine must be one this build loads |
| `name` | string | Card title |
| `shortName` | string | Compact label |
| `badge` | string or absent | Badge on the card; absent falls back to `Balanced` |
| `size` | string | Download size shown on the card |
| `parameters` | string or absent | Parameter count shown on the card; absent renders no count |
| `description` | string | One-line description under the title |
| `repoId` | string | Hugging Face repo the weights are fetched from: an ONNX repo for `transformers`, the weights archive's repo for `cactus` and `bark` |
| `weightsFile` | string or absent | `cactus` and `bark` only, required there and rejected elsewhere: the weights archive within `repoId` (`.cact`, `.bark`) |
| `loaderFile` | string or absent | `bark` only, required there and rejected elsewhere: the official loader in `repoId` that decodes the weights archive |
| `paddingSeconds` | number or absent | `bark` only, required there and rejected elsewhere: silence injected before the audio, in seconds (`0` for Clean, `0.25` otherwise) |

A model that needs a genuinely new runtime needs one new `engine` value plus the
branch that loads it in `../transcriber.ts`; a model that behaves like an
existing one is a JSON file plus a sync.

## Engine runtimes

`../model-registry.ts` keeps one `VOICE_ENGINES` entry per engine: the label the
card shows beside the size, how the engine packages its weights, and the host
runtime it needs. `transformers` and `cactus` run inside the app bundle. `bark`
cannot: its weights are an entropy-coded `.bark` archive that only the model's
own Python loader decodes, so that engine names `BARK_RUNTIME` from
`../runtimes/bark.json` and its cards state the one-time install.

Nothing about that runtime ships in the installer. The first Bark download
provisions it through the host commands in `desktop/src-tauri/src/`:

| Host command | Effect |
| --- | --- |
| `voice_runtime_status` | Reports whether the runtime exists and how many bytes it occupies |
| `voice_runtime_install` | Fetches `uv` once, then creates the pinned interpreter and wheels |
| `voice_runtime_remove` | Deletes the runtime and leaves every downloaded model alone |
| `voice_model_fetch` | Resolves the repo revision, then streams the weights and loader to disk |
| `voice_model_remove` | Deletes one model and leaves the shared runtime alone |
| `voice_bark_transcribe` | Writes the recording as a WAV and drives the official loader |

Each command reports rather than retries: a matching manifest is reused instead
of refetching, a half-provisioned runtime directory is cleared before a retry,
network requests fail on a stalled socket instead of hanging, and the loader is
stopped at a deadline rather than blocking the app forever.

Both caches live under a single version-independent root, `<local data>/voice`,
and no path in it carries the app version. A release therefore reuses the
runtime and every model instead of refetching them; only an edit to the pinned
runtime spec allocates a new directory. `tests/voice-runtime-isolation.test.ts`
enforces that the runtime never enters the bundle, the dependency list, or a
bundle script.

## Copy

Everything that names a model (`name`, `shortName`, `badge`, `size`,
`parameters`, `description`) lives in the declaration, so a model is added and
removed as one file. Wording that reads the same for every model ("Download",
"Active", "Select") stays in `../../../src/i18n/en.json`.

## Why a generated file at all

TypeScript widens JSON imports to `string`, so a literal `VoiceModelId` union
cannot be inferred from the declarations, and the desktop bundle cannot read a
directory at runtime. `models.generated.ts` is a static barrel over the files,
the same arrangement `packages/core-utils/src/providers/` uses.

Unlike the provider registry, this one rejects an empty directory: voice input
cannot run without a model, and every consumer expects a resolved spec.
