import {
  PI_DRIVER_KIND,
  PiSettings,
  type ServerProvider,
  type ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import {
  buildInitialPiProviderSnapshot,
  makeStaticPiProvider,
  PI_MAINTENANCE_CAPABILITIES,
} from "../Layers/PiProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const RESERVED_FLAGS = [
  "--mode",
  "--no-session",
  "--session",
  "--session-dir",
  "--provider",
  "--model",
  "--thinking",
  "--print",
  "-p",
] as const;

const BOOLEAN_FLAGS = new Set([
  "--verbose",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--no-builtin-tools",
  "-nbt",
  "--no-tools",
  "-nt",
]);

export function validatePiLaunchArgs(launchArgs: string): string | undefined {
  const argv = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const reserved = RESERVED_FLAGS.find(
      (flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`)),
    );
    if (reserved !== undefined) {
      return `Launch arguments cannot set adapter-owned argument '${reserved}'.`;
    }
    if (arg === "--") {
      return "Launch arguments cannot include an initial prompt.";
    }
    if (!arg.startsWith("-")) {
      return "Launch arguments cannot include an initial prompt.";
    }
    if (!BOOLEAN_FLAGS.has(arg) && !arg.includes("=")) {
      index += 1;
    }
  }
  return undefined;
}

export function resolvePiInstanceEnvironment(
  environment: ProviderInstanceEnvironment,
  agentDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = mergeProviderInstanceEnvironment(environment, baseEnv);
  return agentDir.trim() ? { ...merged, PI_CODING_AGENT_DIR: agentDir.trim() } : merged;
}

export type PiDriverEnv = never;

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
      const launchArgsIssue = validatePiLaunchArgs(config.launchArgs);
      if (launchArgsIssue !== undefined) {
        return yield* new ProviderDriverError({
          driver: PI_DRIVER_KIND,
          instanceId,
          detail: launchArgsIssue,
        });
      }

      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      // Resolve this at instance creation so the precedence is fixed before
      // phase two starts spawning per-session RPC processes.
      const processEnv = resolvePiInstanceEnvironment(environment, effectiveConfig.agentDir);

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: PI_DRIVER_KIND,
        instanceId,
      });
      const draft = yield* buildInitialPiProviderSnapshot(effectiveConfig);
      const providerSnapshot = stampInstanceIdentity({
        draft,
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      return {
        instanceId,
        driverKind: PI_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: makeStaticPiProvider(providerSnapshot, PI_MAINTENANCE_CAPABILITIES),
        adapter: makePiAdapter({ environment: processEnv }),
        textGeneration: makePiTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
