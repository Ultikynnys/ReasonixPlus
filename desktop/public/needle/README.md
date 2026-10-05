# Cactus `needle` browser engine (vendored)

These files are the Cactus **browser** build of the `needle` engine. The app uses
it to run the **Whistle** speech-to-text model (`.cact`), which the ONNX /
Transformers.js path (used by the bundled Whisper models) cannot load.

## Provenance

- Source: `https://huggingface.co/Cactus-Compute/needle3` (folder `wasm/`)
- Engine repo: `https://github.com/cactus-compute/needle` (Apache-2.0)
- Whistle weights (downloaded at runtime, not vendored here):
  `https://huggingface.co/Cactus-Compute/whistle` -> `whistle.cact` (~16.9 MB)
- Re-vendor with: `node desktop/scripts/fetch-needle-assets.mjs`

| File | Bytes | Role |
| --- | --- | --- |
| `needle.js` | 62823 | Emscripten module factory (UMD, global `createNeedle`) |
| `needle.wasm` | 903655 | Compiled engine |
| `needle.h` | 3322 | C header, for reference / API parity |

## Loading

`needle.js` is a classic (non-ESM) script. It defines a global factory
`createNeedle`:

```js
await createNeedle({ locateFile: () => "/needle/needle.wasm" });
```

The resolved module exposes the C API under `_`-prefixed names (confirmed from
the vendored build):

- `Module._needle_load(cactPtr, cactLen)` reads whichever model the `.cact` holds (text and/or speech)
- `Module._needle_models()` returns `NEEDLE_TEXT | NEEDLE_SPEECH`
- `Module._needle_last_error()` returns a process-global error string (`UTF8ToString`)
- `Module._needle_init(systemPrompt, toolsJson, toolIndexPath)` (text models)
- `Module._needle_set_audio(language, keywords, wordTimestamps)` controls transcription used by `needle_complete`
- `Module._needle_complete(input, pcm, samples, maxNewTokens, out, outCap)`
- `Module._needle_transcribe(pcm, samples, language, keywords, wordTimestamps, out, outCap)` returns generated token count
- `Module._needle_reset()`
- `Module._needle_embed(input, pcm, samples, out, outCap)`
- Helpers: `Module._malloc`, `Module._free`, `Module.UTF8ToString`, `Module.cwrap`, `Module.ccall`

## Notes

- One process-global, non-thread-safe model per kind. A `.cact` cannot be
  unloaded once bound, so only a single Whistle archive may be loaded per page.
- The build imports no pthreads / atomics, so it does not require
  cross-origin isolation (no COOP/COEP headers).
- The `.cact` container format is tied to the engine version: keep this folder
  and the `whistle.cact` revision in step.
