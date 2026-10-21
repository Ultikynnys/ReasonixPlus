# Model providers

One JSON file per model provider. The file name must equal the provider's `id`
(`deepseek.json` declares `"id": "deepseek"`); a mismatch fails the registry load
and the test suite.

Nothing about a provider is hardcoded elsewhere: catalogs, endpoints, credential
names, setup gating, routing precedence, discovery, client transport and the copy
that names the provider all come from these files.

## Adding a provider

1. Create `providers/<id>.json`. Copy the closest existing provider and edit it.
2. Run `npm run providers:sync`.
3. Run `npm test`.

That is the whole flow, with one rule: copy that names the provider goes in the
declaration's `strings` map, never into `en.json` (see Provider copy below).
`providers:sync` rewrites
`../providers.generated.ts`, which imports every file in this directory and
derives the `ProviderID` union from each document's `providerId`. A provider with
`"providerId": null` is catalog-only (it appears in pickers but never routes a
model id), so it needs no union membership at all.

If you skip step 2, `tests/provider-files.test.ts` fails and tells you to run it.

## Removing a provider

1. Delete `providers/<id>.json`.
2. Run `npm run providers:sync`.
3. Run `npm test`.

The file is the whole provider: catalog, endpoint, credentials, settings fields and
copy leave with it, and its card, sign-in panel and status-bar chips disappear
because each renders from a declaration it can no longer find. Nothing needs
pruning from `en.json`, because provider copy never lived there.

Its id also leaves the `ProviderID` union, so daemon code that still compares
against the removed id fails to compile. Treat that failure as the instruction:
ask the declaration (auth strategy, wire format, declared endpoint) instead of
comparing ids, and the code stops caring which providers exist.

## Declarations are optional

Nothing at module load requires a file to exist: `providerSpec` returns
`undefined` for an unknown id, `providerDefaultEndpoint` returns `undefined`, and
the generated barrels fall back to `string` when a directory is empty (the
`extends [never]` aliases). Parking every JSON file and re-running
`providers:sync` therefore still typechecks core, the daemon and the desktop:
every provider card, sign-in panel and status-bar chip is gated on a resolved
spec rather than on a hardcoded list.

## Provider copy

Every user-visible sentence that names a provider lives in that provider's
`strings` map. The test is mechanical: if the sentence would have to change when a
different provider is active, it belongs in the declaration; if it reads the same
for everyone ("Cancel", "Couldn't fetch models: {error}"), it stays in `en.json`
as the generic fallback.

```json
"strings": {
  "notConfigured": "Not configured yet — add a Z.AI API key in Settings → General to use GLM models.",
  "noCredential": "No Z.AI credential for {model} — add a Z.AI key in Settings → Models.",
  "quotaLabel": "GLM usage",
  "quotaTitle": "GLM Coding Plan {plan} · {left}% left · click to refresh"
}
```

Values are plain strings with optional `{placeholder}` slots, filled at the call
site: `{model}`, `{error}`, `{baseUrl}`, `{account}`, `{org}`, `{message}`,
`{when}`, `{left}`, `{resets}`, `{weeklyResets}`, `{session}`, `{sessionResets}`,
`{plan}`, `{fiveHour}`, `{weekly}`, `{rolling}`, `{monthly}`, `{credit}` and `{pct}`.
An unmatched placeholder stays literal. Every key is optional: an undeclared key
returns `undefined`, so the call site keeps its generic wording and a new provider
can adopt one sentence at a time.

| Key family | Where it renders |
| --- | --- |
| `notConfigured`, `noCredential` | Setup gate and turn-start rejection |
| `apiOauth`, `apiKey`, `apiNone`, `apiBare`, `oauthFailed` | Status-bar API chip |
| `quotaLabel`, `quotaTitle`, `quotaDualTitle`, `quotaFiveHourTitle`, `quotaWeeklyTitle`, `quotaMonthlyTitle`, `quotaDailyTitle`, `quotaNoData`, `quotaNoDataUnavailable`, `quotaTurnTitle`, `quotaPlanName`, `quotaPlanFallback` | Status-bar quota chip |
| `offPeakTitle`, `peakTitle` | Rate-period chip tooltip |
| `freeLabel`, `freeTier`, `freeTitle` | OpenCode free-tier chip |
| `panelSignInTitle`, `panelSignIn`, `panelSignInHint`, `panelWaiting`, `panelSignedIn`, `panelAccount`, `panelAccountOrg`, `panelTokenSet`, `panelKeyStored`, `panelSignOut`, `panelCancel`, `panelFlowFailed` | OAuth sign-in panel |
| `modelsLabel`, `modelsHint`, `modelsError` | Model-refresh row and its error line |

The single reader is `providerString` in `provider-registry.ts`: it takes a
provider id or an already-resolved spec, fills the placeholders, and returns
`undefined` when the provider, the key or the value is missing. The status bar
binds it to the spec it already resolved, the daemon calls it with an id, and
`panelText` in `settings.tsx` wraps it to gate the sign-in panel. Settings fields
carry their own `label`, `hint` and `placeholder` (see Settings); this map is for
everything that is not a form field.

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
    "configKey": "syntheticApiKey", "label": "Synthetic API key",
    "signupUrl": "https://synthetic.new/billing/" },
  { "key": "baseUrl", "kind": "url", "env": ["SYNTHETIC_BASE_URL"],
    "configKey": "syntheticBaseUrl", "label": "Synthetic base URL",
    "hint": "OpenAI-compatible endpoint override. Empty uses the declared default." }
]
```

| Field | Meaning |
| --- | --- |
| `key` | Setting key inside the provider's own store entry |
| `kind` | `secret` renders a key field; `url` is an environment-only override and is never a form field |
| `env` | Environment variables that override the value, highest priority first |
| `configKey` | Config field the value persists to; null means environment only |
| `label`, `hint` | Field label and hint text, inline in the declaration |
| `placeholder` | Placeholder text; omit to use the provider's default endpoint |
| `signupUrl` | Where to obtain a key, rendered as a link |

`settingsPanel` selects a bespoke behavior panel by name (`openai-auth`,
`antigravity-auth`, `mimo-auth`, `opencode-auth`, `ollama-generation`); a
provider id never selects it.

## Peak hours

A provider that bills a peak rate declares the calendar in its own file, so
moving peak hours is a JSON edit: no TypeScript, no rebuild, and `providers:sync`
leaves the data untouched.

```json
"billing": {
  "kind": "usd",
  "schedule": {
    "peakWindowsUtc": [
      { "startMinute": 60, "endMinute": 240 },
      { "startMinute": 360, "endMinute": 600 }
    ],
    "weekendOffsetMinutes": 480
  },
  "peakModels": []
}
```

| Field | Meaning |
| --- | --- |
| `peakWindowsUtc` | Half-open UTC windows `[startMinute, endMinute)`, minutes from midnight, `1440` = the day boundary. Validated on load: at least one window, whole minutes inside a day and `endMinute > startMinute` |
| `weekendOffsetMinutes` | Shift applied before asking "is this a weekend?": `480` puts the calendar on Beijing/SGT time, `0` keeps it on UTC. Weekends are always off-peak |
| `peakModels` | Ids whose token price actually moves with the schedule. Empty (the default) means every model of the provider; a list narrows it, matched ignoring a `<provider>/` scheme and any `:tag` suffix. `ollama` lists its two token-priced builds |

The schedule answers "which period is it, and when does it change": it carries no
price multiplier, because a per-provider factor reads inconsistently (DeepSeek
surcharges peak, Z.AI discounts off-peak) and the chip shows the period alone.
What discount or surcharge applies is stated once, in that file's `offPeakTitle` /
`peakTitle` copy.

`"schedule": null` (or no `schedule` key) means the provider has no price
calendar, and the status bar renders no rate chip at all. Only `deepseek.json`,
`ollama.json` and `zai.json` declare one. The `offPeakTitle` / `peakTitle` copy in
the same file spells the windows out in words: `tests/rate-periods.test.ts`
cross-checks those sentences against `peakWindowsUtc`, so copy naming a stale
hour fails the suite instead of drifting.

The status bar reads the schedule through `providerRateSchedule(id|spec)` and
resolves the whole period with one call (`ratePeriodForSchedule`), so the chip's
label and countdown can never disagree. There is no schedule constant
in code to drift out of sync.

## Usage

A provider that reports plan usage declares where that usage is published and how
often it may be read. The probe name picks the payload reader; everything about
the address is data, so a provider moving its usage API is a JSON edit.

```json
"usage": {
  "probe": "zai-monitor",
  "urls": ["/api/monitor/usage/quota/limit"],
  "primaryWindow": "5h",
  "resetsStyle": "absolute"
}
```

| Field | Meaning |
| --- | --- |
| `probe` | Payload reader: `codex-oauth`, `ollama-balance`, `antigravity-quota`, `zai-monitor`, `mimo-console`, `synthetic-quotas`, `opencode-usage`; `null` declares no plan window, so no chip renders |
| `urls` | Addresses the probe reads, tried in order: a `/path`, or an absolute https URL (OpenAI's Codex backend lists its current route, then the legacy one). Empty means the reader composes its own address from the declared endpoint, as the Antigravity `v1internal` RPC pair does |
| `urlBase` | What a `/path` rides: `origin` (the usual case, since a usage route rarely shares the chat path prefix) or `endpoint` (the configured base URL as-is) |
| `urlGate` | `any`, or `declared-hosts` to refuse the probe unless the endpoint host is one this provider lists in `errors.hosts`. OpenCode depends on it: a custom proxy must never receive the account's token just to be asked for usage |
| `minIntervalSeconds` | Floor between network reads, in seconds (default 60). Each API caps reads differently, so the cadence is the provider's own statement rather than a poller constant |
| `primaryWindow` | Window whose "% left" fills `{left}` in the chip copy; `null` (default) means the first window the payload reports |
| `resetsStyle` | How a reset time reads: `relative` ("resets in 2h 15m", the default) or `absolute` (the locale date-time the API reports) |
| `measures` | What the chip shows when the probe reports no percentages: `windows` (default, a dash) or `plan` (the plan's name, for a provider whose percentages need a second credential) |

Each reader normalizes its own payload into one shape, `ProviderUsage`: a plan
label plus ordered windows carrying a label, % left, reset time and an optional
rate-limited flag. The status bar therefore renders every provider's usage through
a single chip, and `primaryWindow` / `resetsStyle` are what keep each provider's
declared tooltip copy readable without a branch in the UI: `quotaTitle` fills from
the primary window, `quotaDualTitle` (when declared) names several windows in one
sentence, and a window the main sentence leaves out gets its own line from
`quotaFiveHourTitle` / `quotaWeeklyTitle` / `quotaMonthlyTitle` / `quotaDailyTitle` / `quotaPlanTitle`.
`creditTitle` appends the spendable credit a payload reported alongside usage.

A provider that publishes an account *wallet* instead of plan windows declares
`billing.balance` instead: a plan measures windows, a wallet holds money, and the
two chips differ.

## Fields

Top level:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Catalog id, must match the file name |
| `providerId` | string or null | Routable id (joins `ProviderID`), or null for catalog-only |
| `label` | string | Human name for logs and diagnostics |
| `shortLabel` | string | Tag that prefixes a model id in picker rows and model pills (`DS · deepseek-v4-flash`), ≤5 chars and unique per provider; omit to fall back to `label` |
| `groupLabelKey` | string | i18n key naming the provider's card or picker group |
| `pickerGroup` | string or null | Desktop picker group to render in; null means the provider's own id |
| `order` | number | Picker and catalog order, ascending |
| `precedence` | number or null | Bare-id ownership rank; null never takes a bare id |
| `defaultModel` | string or null | Model a picker preselects, when any |
| `knownCatalog` | boolean | Contributes to `KNOWN_MODELS` |
| `models` | string[] | Offline catalog |
| `goModels` | string[] | Ids served by the subscription tier endpoint |
| `speechModels` | string[] | Non-chat ids, never offered as chat |
| `modelId` | object | How ids read as a label: `stripPrefixes` (scheme markers such as `hf:`) and `stripOwner` (drops a hub `<owner>/` segment). Omit to show the id verbatim |
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
| `billing` | `kind`, `schedule`, `peakModels`, `balance` | Peak/off-peak calendar (see Peak hours) and the account-balance endpoint |
| `usage` | `probe`, `urls`, `urlBase`, `urlGate`, `minIntervalSeconds`, `primaryWindow`, `resetsStyle` | Where plan usage is published (see Usage) |
| `routing` | `staticCatalog`, `discoveredCatalog`, `checkedLast`, `foreignCatalog`, `modelScheme` | How a bare model id reaches this provider |
| `discovery` | `strategy`, `listField`, `idField`, `excludeSpeech` | Where the live catalog comes from and how to read it |
| `client` | `auth`, `transport`, `allowMissingKey` | Per-request credentials and wire format |
| `strings` | map of strings | Provider-named UI copy, keys listed under Provider copy |
| `vision` | `models`, `patterns`, `predicate`, `fromProvider`, `stripSchemeAndTag`, `refreshable` | Id list, regexes, inherited catalog, or a catalog a sync may replace |

Values are validated at load: an unknown strategy, a malformed URL table, a bad
regex, or a duplicate id throws with the offending file name in the message.
