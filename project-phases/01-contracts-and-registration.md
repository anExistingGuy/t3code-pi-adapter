# Phase 1: Contracts and provider registration

## Outcome

The repository recognizes a disabled-by-default built-in driver kind `pi`. Settings can configure default and additional Pi instances without any adapter process being implemented yet. Existing providers remain unchanged.

## Contract changes

### `packages/contracts/src/settings.ts`

Add `PiSettings` through `makeProviderSettingsSchema` with this encoded/decoded shape:

- `enabled: boolean`, default `false`, hidden in the generic settings form;
- `binaryPath: string`, default `pi`, label **Binary path**;
- `homePath: string`, default empty, label **PI_CODING_AGENT_DIR path**. Empty means Pi's normal `~/.pi/agent` directory;
- `launchArgs: string`, default empty. This is appended to T3-owned launch arguments but must not be allowed to replace `--mode rpc`;
- `customModels: string[]`, default `[]`, hidden. These are fallback entries only when discovery cannot return the model; discovered models win and duplicates are removed.

Recommended form order: `binaryPath`, `homePath`, `launchArgs`.

Add `pi` to:

- `ServerSettings.providers` with a decoding default;
- `ServerSettingsPatch.providers` through a `PiSettingsPatch`;
- `DEFAULT_SERVER_SETTINGS` indirectly through the schema.

Why a legacy `providers.pi` field is still required: `ProviderInstanceRegistryHydration.deriveProviderInstanceConfigMap` synthesizes each default built-in instance from `settings.providers[driverKind]`. Without the field, the default `pi` instance will not be hydrated.

### `packages/contracts/src/model.ts`

Add:

```ts
const PI_DRIVER_KIND = ProviderDriverKind.make("pi");
```

Then add `Pi` to `PROVIDER_DISPLAY_NAMES`. Do **not** add a fixed `DEFAULT_MODEL_BY_PROVIDER.pi`: Pi has no harness-wide model. Client fallback already prefers a discovered default/first model before this map.

A Pi model is represented in T3 as:

```text
<pi-provider-id>/<pi-model-id>
```

Examples: `anthropic/claude-sonnet-4-6`, `openai/gpt-5.4`, `openrouter/qwen/qwen3-coder`. Split on the first slash only. The portion after the first slash may contain more slashes.

### `packages/contracts/src/providerRuntime.ts`

Add `Schema.Literal("pi.rpc.event")` to `RuntimeEventRawSource` if the adapter will attach native Pi records to canonical events. Prefer doing this now so native event logging and diagnostics do not discard provenance. Do not place command responses or secrets in user-visible payload fields.

## Driver shell

Create these naming anchors even if their full implementations land in phase 5:

- `apps/server/src/provider/Services/PiAdapter.ts` — `PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError>`.
- `apps/server/src/provider/Drivers/PiDriver.ts` — driver kind constant `ProviderDriverKind.make("pi")` and typed `PiDriverEnv`.

Register `PiDriver` in `apps/server/src/provider/builtInDrivers.ts` and include `PiDriverEnv` in `BuiltInDriversEnv`. Keep Pi last in the built-in order unless product design requests another location.

During this phase the driver may be a compile-safe shell only if it is not added to `BUILT_IN_DRIVERS` until phase 5. Do not register a driver whose `create` path defects or returns fake ready snapshots.

## Multi-instance semantics

Set `supportsMultipleInstances: true`.

Each Pi instance may point at a different `homePath`, environment-variable set, executable, or extension/provider configuration. The eventual continuation identity must be based on the effective Pi config directory, not merely the T3 instance ID:

- same effective Pi home: session continuation may switch between named T3 instances;
- different effective Pi homes: treat as different continuation groups.

Create a focused helper analogous to `Drivers/ClaudeHome.ts`, for example `Drivers/PiHome.ts`, rather than embedding path normalization in the driver.

`homePath` is applied as `PI_CODING_AGENT_DIR`. Merge it on top of `mergeProviderInstanceEnvironment(environment)` only when non-empty. Do not overwrite unrelated user variables.

## Tests

Update/add focused tests for:

- decoding default `PiSettings`;
- `ServerSettingsPatch` accepting Pi fields;
- disabled-by-default resolution through `defaultEnabledForDriver`;
- hydration synthesizing a default `pi` instance from `providers.pi`;
- an explicit `providerInstances.pi` entry winning over the synthesized legacy entry;
- `PROVIDER_DISPLAY_NAMES.pi === "Pi"`;
- Pi home continuation identity: equivalent paths match, distinct homes differ.

Likely test files:

- `packages/contracts/src/provider.test.ts` or a settings-specific sibling;
- `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts`;
- a new `apps/server/src/provider/Drivers/PiHome.test.ts`.

## Acceptance criteria

- Old settings decode with Pi disabled.
- New settings can configure multiple Pi instances.
- Unknown/fork driver compatibility remains open; no closed provider-kind union is introduced.
- No model identifier is hardcoded as Pi's default.
- No Pi process is started merely because settings contracts decode.
