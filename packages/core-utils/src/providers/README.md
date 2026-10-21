# Model providers

One JSON file per model provider. The file name must equal the provider's `id`
(`deepseek.json` declares `"id": "deepseek"`); a mismatch fails the registry load
and the test suite.

Nothing about a provider is hardcoded elsewhere: catalogs, endpoints, credential
names, setup gating, routing precedence, discovery and client transport all come
from these files.

## Adding a provider

1. Create `providers/<id>.json`. Copy the closest existing provider and edit it.
2. Run `npm run providers:sync`.
3. Run `npm test`.

That is the whole flow. `providers:sync` rewrites
`../providers.generated.ts`, which imports every file in this directory and
derives the `ProviderID` union from each document's `providerId`. A provider with
`"providerId": null` is catalog-only (it appears in pickers but never routes a
model id), so it needs no union membership at all, exactly like `typesafe.json`.

If you skip step 2, `tests/provider-files.test.ts` fails and tells you to run it.

## Removing a provider

1. Delete `providers/<id>.json`.
2. Run `npm run providers:sync`.
3. Run `npm test` and fix whatever referenced the removed router.

Its id leaves the union with the file, so any code that still branches on the
removed provider fails to compile instead of silently going dead.

## Why a generated file at all

`providers/*.json` is the source of truth, but two constraints make a generated
TypeScript barrel necessary rather than optional:

- TypeScript widens JSON imports to `string`, so a literal `ProviderID` union
  cannot be inferred from the JSON. The generated union keeps the exhaustive
  `Record<ProviderID, ...>` checks and provider comparisons type-safe.
- The registry is bundled into the desktop webview, where reading a directory at
  runtime is impossible, and tsup/esbuild inline JSON at build time instead of
  shipping loose files. Static imports are the only portable option.

## Choosing a strategy

Adding a provider that behaves like an existing one (an OpenAI-compatible
endpoint with an API key) is JSON only. A provider with genuinely new behavior
needs one new strategy function, named from its JSON:

| Field | Values | Existing functions |
| --- | --- | --- |
| `endpoint.strategy` | `standard`, `fixed`, `tiered` | `resolveProviderEndpoint` |
| `discovery.strategy` | `models-endpoint`, `models.dev`, `oauth-quota`, `runtime` | `provider-models.ts`, `opencode-models.ts` |
| `client.auth` | `api-key`, `openai-oauth`, `opencode`, `gemini-oauth` | `AUTH_RESOLVERS` in `src/model-client.ts` |
| `client.transport` | `null`, `codex`, `zai-responses`, `mimo-responses`, `opencode-muse-responses` | `TRANSPORT_RESOLVERS` in `src/model-client.ts` |

## Settings

Each provider declares its own persisted fields. The config surface, the settings
card and the masked status payload are derived from this list, so adding a field
or a provider never means editing TypeScript.

```json
"settings": [
  { "key": "apiKey", "kind": "secret", "env": ["SYNTHETIC_API_KEY"],
    "configKey": "syntheticApiKey", "labelKey": "settings.webSearchApiKey.synthetic",
    "signupUrl": "https://synthetic.new/billing/" },
  { "key": "baseUrl", "kind": "url", "env": ["SYNTHETIC_BASE_URL"],
    "configKey": "syntheticBaseUrl", "labelKey": "settings.syntheticBaseUrl",
    "hintKey": "settings.syntheticBaseUrlHint" }
]
```

| Field | Meaning |
| --- | --- |
| `key` | Setting key inside the provider's own store entry |
| `kind` | `secret` (masked in the UI) or `url` |
| `env` | Environment variables that override the value, highest priority first |
| `configKey` | Config field the value persists to; null means environment only |
| `labelKey`, `hintKey` | i18n keys for the field label and hint |
| `placeholder` | Placeholder text; omit to use the provider's default endpoint |
| `signupUrl` | Where to obtain a key, rendered as a link |

`settingsPanel` selects a bespoke behavior panel by name (`openai-auth`,
`antigravity-auth`, `mimo-auth`, `opencode-auth`, `ollama-generation`,
`typesafe-validation`); a provider id never selects it.

## Fields

Top level:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Catalog id, must match the file name |
| `providerId` | string or null | Routable id (joins `ProviderID`), or null for catalog-only |
| `label` | string | Human name for logs and diagnostics |
| `groupLabelKey` | string | i18n key naming the provider's card or picker group |
| `pickerGroup` | string or null | Desktop picker group to render in; null means the provider's own id |
| `order` | number | Picker and catalog order, ascending |
| `precedence` | number or null | Bare-id ownership rank; null never takes a bare id |
| `defaultModel` | string or null | Model a picker preselects, when any |
| `knownCatalog` | boolean | Contributes to `KNOWN_MODELS` |
| `models` | string[] | Offline catalog |
| `goModels` | string[] | Ids served by the subscription tier endpoint |
| `speechModels` | string[] | Non-chat ids, never offered as chat |
| `vision` | object | Image-capability rules, see below |
| `modelFilter` | `antigravity` or null | Id filter applied to `models` |
| `reasoningEfforts` | string[] | Accepted effort ladder, `[]` = no effort field |
| `modelsDev` | string or null | models.dev key supplying per-model effort ladders |
| `setupGate` | string[] | Sources that count as "configured": `apiKey`, `baseUrl`, `oauth` |
| `pickerGate` | `catalog`, `signin` or null | What the picker waits for before showing the group |
| `picker` | boolean | Whether the desktop picker has a group at all (default true) |

Objects:

| Field | Shape | Meaning |
| --- | --- | --- |
| `endpoint` | `strategy`, `default`, `tiers`, `keyTuple` | `keyTuple` is `strict` (a base-URL override owns its key) or `resolve` |
| `credentials` | `publicKey`, `oauthConfig` | A key assumed when nothing is configured, and the OAuth credential field |
| `settings` | array | Persisted fields this provider declares, see Settings above |
| `settingsPanel` | panel name or null | Bespoke behavior panel the settings card renders above its fields |
| `usable` | `apiKey`, `keylessLocal`, `always` | Ways the model can run right now |
| `routing` | `staticCatalog`, `discoveredCatalog`, `checkedLast`, `foreignCatalog`, `modelScheme` | How a bare model id reaches this provider |
| `discovery` | `strategy`, `listField`, `idField`, `excludeSpeech` | Where the live catalog comes from and how to read it |
| `client` | `auth`, `transport`, `allowMissingKey` | Per-request credentials and wire format |
| `vision` | `models`, `patterns`, `predicate`, `fromProvider`, `stripSchemeAndTag`, `refreshable` | Id list, regexes, inherited catalog, or a catalog a sync may replace |

Values are validated at load: an unknown strategy, a malformed URL table, a bad
regex, or a duplicate id throws with the offending file name in the message.
