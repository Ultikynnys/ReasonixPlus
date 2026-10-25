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
| `engine` | `transformers`, `cactus` or `bark` | Runtime that loads and runs the model: the Transformers.js ASR pipeline, the Cactus `needle` engine, or the Bark MLX runtime |
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
| `configFile` | string or absent | `bark` only, required there and rejected elsewhere: the config file within `repoId` that the runtime reads |

A model that needs a genuinely new runtime needs one new `engine` value plus the
branch that loads it in `../transcriber.ts`; a model that behaves like an
existing one is a JSON file plus a sync.

## Engine runtimes

`../model-registry.ts` keeps one `VOICE_ENGINES` entry per engine: the label the
card shows beside the size, how the engine packages its weights, and the
requirement it names when this build ships no loader for it. Bark's weights are
entropy-coded MLX for Apple silicon, while this build loads ONNX through
transformers.js and `.cact` archives through Cactus, so `bark` names
`settings.voiceEngineBarkRequirement`. Its cards show that sentence instead of a
Download button, the cache reports them as absent, and the transcriber refuses
them rather than handing an MLX repo to the ONNX pipeline. A build that ships an
MLX loader clears that key and adds the branch in `../transcriber.ts`; no
declaration changes.

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
