# Phase 5: Discovery, driver, and text generation

## Outcome

The registered Pi driver produces a truthful live provider snapshot, starts the completed adapter, supports provider maintenance, and supplies T3's auxiliary text-generation operations through Pi without constraining Pi to one upstream model vendor.

## Provider snapshot

Create `apps/server/src/provider/Layers/PiProvider.ts` with:

- `makePendingPiProvider(settings)`;
- `checkPiProviderStatus(settings, cwd, environment)`;
- pure model/command mapping helpers and tests.

Presentation:

```ts
{
  displayName: "Pi",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false
}
```

Pi supports in-session model switching. Do not add an Early Access badge unless maintainers explicitly request one.

### Disabled snapshot

When disabled:

- `enabled:false`, `installed:false`, `status:"disabled"` through `buildServerProvider`;
- auth `unknown`;
- fallback custom models only;
- message `Pi is disabled in T3 Code settings.`.

No process should be spawned for a disabled health check.

### Version probe

Run `<binaryPath> --version` with `resolveSpawnCommand`, a short timeout, and the provider instance environment. Parse semver through `parseGenericCliVersion`.

Distinguish:

- command missing -> `installed:false`, clear install guidance;
- timeout/non-zero -> installed when appropriate, `status:error`;
- successful version -> continue to RPC inventory.

Do not enforce a minimum version until the oldest supported RPC protocol has been established and tested. If a minimum is later introduced, put it in one constant with an actionable message.

### RPC inventory probe

Start one scoped ephemeral process in the target cwd:

```text
pi --mode rpc --no-session
```

Do not add the T3 permission extension. Keep normal Pi resources enabled so custom provider extensions can register models and `get_commands` can discover user/project commands. Respect Pi's project trust behavior; do not force `--approve`.

Request concurrently where protocol safety allows:

- `get_state`;
- `get_available_models`;
- `get_commands`.

Then close the exact process. Cache through the existing managed provider refresh cadence; do not create a new independent polling loop.

`get_available_models` returns models currently available with resolved authentication. Therefore:

- non-empty list -> auth `authenticated`, status `ready`;
- empty list -> auth `unauthenticated`, status `warning`, message directing the user to run `pi` and `/login` or configure an API key;
- RPC startup/error -> installed true, auth unknown, status error.

### Model mapping

For every Pi model object, produce `ServerProviderModel`:

- `slug`: `${model.provider}/${model.id}`;
- `name`: non-empty `model.name`, otherwise model ID;
- `subProvider`: model provider display label or provider ID so clients can group/qualify names;
- `isCustom:false` (Pi, not T3, owns whether a model came from built-in config or an extension);
- `isDefault:true` only for the current state model when it exists in the available list;
- capabilities described below.

Deduplicate by full slug. Sort by provider label then model name, but keep the current/default model stable at the top only if that matches existing picker conventions.

Merge `customModels` through `providerModelsFromSettings` as fallback entries. A custom model slug must already use `provider/model-id` format. Invalid entries are omitted with a bounded warning.

### Thinking-level capabilities

Pi's model metadata includes `reasoning` and optional `thinkingLevelMap`. Reproduce Pi's documented level derivation without querying `set_model` during health checks (setting models can mutate Pi settings):

- non-reasoning -> only `off`; no selector is also acceptable if the adapter defaults to off;
- reasoning base levels -> `off`, `minimal`, `low`, `medium`, `high` unless a map explicitly removes one;
- `xhigh` and `max` only when `thinkingLevelMap[level]` is present and non-null;
- any level mapped to `null` is unavailable.

Expose a select descriptor with ID `thinkingLevel`, label **Reasoning**, and one choice per supported level. Use Pi's current/effective state level as default only for the current model; otherwise choose `medium` when supported, then `off`.

Keep the derivation pure and covered with fixtures. Unknown future fields are ignored.

### Commands and skills

Map `get_commands` results:

- `source:"skill"` -> `ServerProviderSkill` using command name without `skill:` as display name, source path, enabled true, and available description;
- `source:"prompt"` or `source:"extension"` -> `ServerProviderSlashCommand` with command name and description.

Do not include Pi's interactive-only built-ins (`/settings`, `/model`, etc.); RPC intentionally does not expose them. Preserve command names with suffixes such as `review:1`.

## Pi driver

Complete `apps/server/src/provider/Drivers/PiDriver.ts` following `OpenCodeDriver.ts`/`ClaudeDriver.ts`:

1. Merge provider instance environment.
2. Resolve effective `PI_CODING_AGENT_DIR` and continuation identity.
3. Resolve maintenance capabilities.
4. Materialize the bridge extension path.
5. Build `makePiAdapter(effectiveConfig, options)` with instance ID, environment, bridge path, and native logger.
6. Build `makePiTextGeneration(effectiveConfig, environment)`.
7. Build a managed snapshot with `makeManagedServerProvider`, settings source, health check, and version advisory enrichment.
8. Stamp `instanceId`, driver `pi`, display name/accent, and continuation group.
9. Return a fully scoped `ProviderInstance`.

`PiDriverEnv` will likely require `BackgroundPolicy`, `ChildProcessSpawner`, `Crypto`, `FileSystem`, `Path`, `HttpClient`, `ProviderEventLoggers`, `ServerConfig`, and `ServerSettingsService`. Include only services actually used.

## Maintenance

Use `makePackageManagedProviderMaintenanceResolver`:

- provider: `pi`;
- npm package: `@earendil-works/pi-coding-agent`;
- no native updater unless Pi documents one that is safe and non-interactive;
- add Homebrew formula only if Pi publishes a stable formula.

This automatically feeds existing provider update UI. Do not special-case Pi in notification components.

## Text generation

Create `apps/server/src/textGeneration/PiTextGeneration.ts` and focused tests. It supplies:

- commit message;
- PR title/body;
- branch name;
- thread title.

For each operation:

1. Build the existing prompt/schema via `TextGenerationPrompts.ts`.
2. Parse the selected T3 Pi model slug into provider/model ID.
3. Start a scoped ephemeral process in the input cwd:

```text
pi --mode rpc --no-session --no-tools --provider <provider> --model <model-id>
```

4. Set requested thinking level through CLI/RPC.
5. Send the prompt and collect assistant `text_delta` until `agent_settled`.
6. Treat terminal error/abort/timeout/empty output as `TextGenerationError`.
7. Extract/decode the JSON object with existing `extractJsonObject` and Effect schema utilities.
8. Apply the same sanitizers used by other text-generation providers.
9. Close the process in all cases.

For title-generation image attachments, send resolved base64 RPC images if the existing prompt builder requests them. Keep `--no-tools` so auxiliary generation cannot mutate the repository or invoke arbitrary extension tools. Normal extensions/custom providers should remain enabled because they may be required to supply the selected model; with no tools and no UI expectation, any extension attempting a blocking dialog should cause a clear bounded failure rather than hang.

Use a timeout consistent with other providers (currently around 180 seconds), implemented with Effect timeout and scoped cleanup.

## Tests

- version/missing binary/timeout/non-zero cases;
- disabled check spawns nothing;
- available model mapping, nested slashes, deduplication, current default;
- no models -> unauthenticated warning;
- custom provider extension model survives mapping;
- thinking-level maps including null/xhigh/max;
- skills vs slash commands;
- driver stamps instance identity and isolates different homes/environments;
- provider scope closes adapter processes;
- all four text-generation operations with a fake RPC peer;
- invalid/empty/timeout/error structured output;
- text generation launches with `--no-session --no-tools` and selected upstream model.

## Acceptance criteria

- Enabling Pi produces a model inventory matching Pi's available authenticated models, including custom providers registered by extensions.
- Disabling Pi incurs no Pi process activity.
- Multiple Pi homes remain isolated.
- Selecting Pi for T3 auxiliary generation uses that exact upstream Pi provider/model.
- Updating Pi uses the repository's existing provider maintenance flow.
