# Provider effort contracts

Researched 2026-10-22. Persisted application levels remain low, medium, high,
xhigh and max. They are not universal vendor levels. First-match
`reasoningRules` supply model-specific ladders, aliases, wire controls and forced
thinking. Discovered explicit empty ladders disable effort; absent metadata uses
the declared fallback. Toggle-only models must not advertise graded effort.

| Provider | Contract | Source |
| --- | --- | --- |
| DeepSeek | low/high/max; medium and xhigh map to high; thinking is top-level JSON | https://api-docs.deepseek.com/guides/thinking_mode/ |
| OpenAI | Chat reasoning_effort; Responses reasoning.effort; levels depend on model | https://developers.openai.com/api/docs/guides/reasoning.md |
| Z.AI | GLM-5.2 high/max; GLM-5.3 low/high/max and mandatory thinking | https://docs.z.ai/api-reference/llm/chat-completion.md |
| Ollama | Native think strings/booleans from /api/show thinking.values | https://docs.ollama.com/capabilities/thinking.md |
| Gemini | New models thinkingLevel; 2.5 models thinkingBudget | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking |
| MiMo | Toggle only; Responses none disables, other levels are equivalent | https://mimo.mi.com/docs/en-US/api/chat/responses |
| Synthetic | Chat reasoning_effort; per-model metadata refines the fallback | https://dev.synthetic.new/docs/openai/chat-completions |
| Experiential | Effort pass-through; gateway may coerce down, never up, by policy | https://platform.experientiallabs.ai/llms.txt |
| OpenCode | Model-specific gateway contracts, Zen owns overlapping Go ids | https://opencode.ai/docs/zen/ |
| OpenRouter | No app-level ladder: effort is per upstream model, so requests send no effort field | https://openrouter.ai/api/v1/models |

## OpenRouter variants and modality

OpenRouter resells many vendors, so no single ladder applies: the declared
fallback is empty and every request omits the effort field. Its catalogue is
text-only by default, and `output_modalities=all` would add decisions, image,
speech, video, embedding and rerank entries that fail on chat. A `:free` suffix
is its own catalogue entry with its own limits, not a variant of the base id.

## Discovery and compatibility

https://models.dev/api.json supplies model reasoning_options. An empty options
array or reasoning:false means no effort, not unknown. MiMo and Synthetic use
their own catalog keys. OpenCode cannot inherit one ladder for all resold models.
The Experiential gateway owns route admission and downward coercion; requests
retain the selected level rather than guessing the hidden upstream route.

The Google sign-in transport is Cloud Code, not the native Anthropic API.
Non-Gemini models never receive Gemini thinkingLevel. Cloud Code Claude thinking
models use the budget shape demonstrated by the upstream adapter:
https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/main/src/plugin/transform/claude.ts
There is no public authoritative Cloud Code effort specification. Budget support
is compatibility evidence, not a claim of native Anthropic effort support.

## Application budget presets

Budget labels are application presets, not vendor-defined effort enums:

| Family | low | medium | high |
| --- | --- | --- | --- |
| Gemini 2.5 Pro | 1024 | 8192 | 32768 |
| Gemini 2.5 Flash | 1024 | 8192 | 24576 |
| Cloud Code Claude thinking | 8192 | 16384 | 32768 |

Budgets must leave output-token headroom. An explicit output cap is never raised
silently. includeThoughts controls returned summaries, not reasoning depth.
Explicit thinking disabled wins over effort where the model permits disabling;
forced-thinking models retain a valid enabled control. MiMo's tool-thinking
preference applies on both Chat and Responses.

Ollama metadata is authoritative when present, including boolean-only controls
and values:[false]. Unknown Ollama models have no guessed graded ladder. The
small known-family fallback is only for older servers without thinking metadata.
