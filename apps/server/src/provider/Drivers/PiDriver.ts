import {
  PI_DRIVER_KIND,
  PiSettings,
  type ServerProvider,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  PI_MAINTENANCE_CAPABILITIES,
} from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { validatePiLaunchArgs } from "../pi/PiLaunch.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

export { validatePiLaunchArgs } from "../pi/PiLaunch.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

export function resolvePiInstanceEnvironment(
  environment: ProviderInstanceEnvironment,
  agentDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = mergeProviderInstanceEnvironment(environment, baseEnv);
  return agentDir.trim() ? { ...merged, PI_CODING_AGENT_DIR: agentDir.trim() } : merged;
}

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const stampInstanceIdentity = (input: {
  readonly draft: Omit<ServerProvider, "instanceId" | "driver">;
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationGroupKey: string;
}): ServerProvider => ({
  ...input.draft,
  instanceId: input.instanceId,
  driver: PI_DRIVER_KIND,
  ...(input.displayName ? { displayName: input.displayName } : {}),
  ...(input.accentColor ? { accentColor: input.accentColor } : {}),
  continuation: { groupKey: input.continuationGroupKey },
});

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const launchArgsIssue = validatePiLaunchArgs(config.launchArgs);
      if (launchArgsIssue !== undefined) {
        return yield* new ProviderDriverError({
          driver: PI_DRIVER_KIND,
          instanceId,
          detail: launchArgsIssue,
        });
      }

      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      // Resolve this at instance creation so probes and later session processes
      // use the same environment precedence.
      const processEnv = resolvePiInstanceEnvironment(environment, effectiveConfig.agentDir);

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: PI_DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (draft: Omit<ServerProvider, "instanceId" | "driver">) =>
        stampInstanceIdentity({
          draft,
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
      const checkProvider = checkPiProviderStatus(effectiveConfig, process.cwd(), processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities: PI_MAINTENANCE_CAPABILITIES,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: PI_DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: PI_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: yield* makePiAdapter({
          environment: processEnv,
          instanceId,
          settings: effectiveConfig,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        }),
        textGeneration: yield* makePiTextGeneration({
          instanceId,
          settings: effectiveConfig,
          environment: processEnv,
        }),
      } satisfies ProviderInstance;
    }),
};
