import { PI_DRIVER_KIND, type PiSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { mapPiCommands } from "../pi/PiCommands.ts";
import { mapPiModels } from "../pi/PiModelCatalog.ts";
import { makePiRpcRuntime } from "../pi/PiRpcRuntime.ts";
import type { PiExtensionUiRequest, PiExtensionUiResponse } from "../pi/PiRpcProtocol.ts";

export const PI_MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: PI_DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

export const PI_VERSION_PROBE_TIMEOUT_MS = 4_000;
export const PI_RPC_DISCOVERY_TIMEOUT_MS = 20_000;

export interface PiProbeOptions {
  /** Internal executable prefix for real-child test fixtures. */
  readonly binaryArgs?: ReadonlyArray<string>;
  readonly versionTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
}

function buildDisabledPiSnapshot(checkedAt: string): ServerProviderDraft {
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: false,
    checkedAt,
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Pi is disabled in T3 Code settings.",
    },
  });
}

export const buildInitialPiProviderSnapshot = Effect.fn("buildInitialPiProviderSnapshot")(
  function* (settings: PiSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) return buildDisabledPiSnapshot(checkedAt);
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  },
);

const runPiVersionCommand = Effect.fn("runPiVersionCommand")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  options: PiProbeOptions,
) {
  const binaryPath = settings.binaryPath || "pi";
  const args = [...(options.binaryArgs ?? []), "--version"];
  const resolved = yield* resolveSpawnCommand(binaryPath, args, {
    env: environment,
    extendEnv: true,
  });
  return yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      extendEnv: true,
      shell: resolved.shell,
    }),
  );
});

function handleProbeUiRequest(
  request: PiExtensionUiRequest,
): Effect.Effect<PiExtensionUiResponse | undefined> {
  if (["select", "confirm", "input", "editor"].includes(request.method)) {
    return Effect.succeed({
      type: "extension_ui_response",
      id: request.id,
      cancelled: true,
    });
  }
  return Effect.logDebug("Ignored Pi probe UI chrome request.", {
    method: request.method,
    requestId: request.id.slice(0, 128),
  }).pipe(Effect.as(undefined));
}

const discoverPiInventory = Effect.fn("discoverPiInventory")(function* (input: {
  readonly settings: PiSettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly options: PiProbeOptions;
}) {
  const runtime = yield* makePiRpcRuntime({
    extensionUiRequestHandler: handleProbeUiRequest,
    launch: {
      binaryPath: input.settings.binaryPath || "pi",
      ...(input.options.binaryArgs ? { binaryArgs: input.options.binaryArgs } : {}),
      launchArgs: input.settings.launchArgs,
      cwd: input.cwd,
      env: input.environment,
      session: { mode: "ephemeral" },
    },
  });
  yield* runtime.events.pipe(Stream.runDrain, Effect.forkScoped);
  // Let the event stream acquire its PubSub subscription before extensions can emit startup UI.
  yield* Effect.yieldNow;

  const state = yield* runtime.getState;
  const models = yield* runtime.getAvailableModels;
  const commands = yield* runtime.getCommands;
  const activeThinkingLevels = state.model ? yield* runtime.getAvailableThinkingLevels : undefined;
  yield* runtime.close;
  return { state, models, commands, activeThinkingLevels };
});

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: PiProbeOptions = {},
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return buildDisabledPiSnapshot(checkedAt);

  const versionExit = yield* runPiVersionCommand(settings, environment, options).pipe(
    Effect.timeoutOption(options.versionTimeoutMs ?? PI_VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionExit)) {
    const missing = isCommandMissingCause(versionExit.failure);
    yield* Effect.logWarning("Pi CLI version probe failed.", {
      errorTag: versionExit.failure._tag,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute the Pi CLI health check.",
      },
    });
  }
  if (Option.isNone(versionExit.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionResult = versionExit.success.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    yield* Effect.logWarning("Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionResult.code,
      stdoutLength: versionResult.stdout.length,
      stderrLength: versionResult.stderr.length,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run `pi --version`.",
      },
    });
  }

  const discoveryExit = yield* discoverPiInventory({ settings, cwd, environment, options }).pipe(
    Effect.scoped,
    Effect.timeoutOption(options.rpcTimeoutMs ?? PI_RPC_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Pi RPC discovery failed. Pi must support `--mode rpc`.", {
      reasonCount: discoveryExit.cause.reasons.length,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Pi RPC discovery failed. Install a Pi version that supports `--mode rpc`, `get_state`, `get_available_models`, and `get_commands`.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi RPC discovery timed out after ${options.rpcTimeoutMs ?? PI_RPC_DISCOVERY_TIMEOUT_MS}ms while loading extensions and resources.`,
      },
    });
  }

  const inventory = discoveryExit.value.value;
  const models = mapPiModels({
    models: inventory.models,
    ...(inventory.state.model ? { currentModel: inventory.state.model } : {}),
    currentThinkingLevel: inventory.state.thinkingLevel,
    ...(inventory.activeThinkingLevels
      ? { activeThinkingLevels: inventory.activeThinkingLevels }
      : {}),
  });
  const resources = mapPiCommands(inventory.commands);
  const hasModels = models.length > 0;

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: resources.slashCommands,
    skills: resources.skills,
    probe: {
      installed: true,
      version,
      status: hasModels ? "ready" : "warning",
      auth: hasModels ? { status: "authenticated", type: "pi" } : { status: "unknown" },
      ...(!hasModels
        ? {
            message:
              "Pi is available but reported no usable models. Authenticate or configure a provider in Pi, then refresh provider status.",
          }
        : {}),
    },
  });
});
