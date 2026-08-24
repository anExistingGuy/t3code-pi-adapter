import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PI_DRIVER_KIND,
  type PiSettings,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeProviderInstanceRegistry } from "../Layers/ProviderInstanceRegistryLive.ts";
import { PiDriver, resolvePiInstanceEnvironment, validatePiLaunchArgs } from "./PiDriver.ts";

const defaultConfig: PiSettings = {
  enabled: false,
  binaryPath: "pi",
  agentDir: "",
  launchArgs: "",
};

describe("PiDriver launch policy", () => {
  it("lets a configured agent directory override the instance environment", () => {
    expect(
      resolvePiInstanceEnvironment(
        [{ name: "PI_CODING_AGENT_DIR", value: "/profiles/environment", sensitive: false }],
        " /profiles/settings ",
        { PATH: "/bin" },
      ),
    ).toEqual({ PATH: "/bin", PI_CODING_AGENT_DIR: "/profiles/settings" });
  });

  it("preserves an explicit instance environment when agentDir is empty", () => {
    expect(
      resolvePiInstanceEnvironment(
        [{ name: "PI_CODING_AGENT_DIR", value: "/profiles/environment", sensitive: false }],
        "",
        { PATH: "/bin" },
      ),
    ).toEqual({ PATH: "/bin", PI_CODING_AGENT_DIR: "/profiles/environment" });
  });

  it("rejects adapter-owned flags and initial prompts", () => {
    for (const args of [
      "--mode=json",
      "--no-session",
      "--session session.jsonl",
      "--session-dir sessions",
      "--provider anthropic",
      "--model sonnet",
      "--thinking high",
      "--print",
      "-p",
      "hello pi",
      "--verbose hello pi",
    ]) {
      expect(validatePiLaunchArgs(args), args).toBeDefined();
    }
  });

  it("accepts resource and trust arguments that remain user-owned", () => {
    expect(validatePiLaunchArgs("--approve -e ./extension.ts --skill ./skill")).toBeUndefined();
  });
});

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});
const driverIt = it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    BackgroundPolicyAlwaysRunLayer,
    ServerSettingsService.layerTest(),
  ),
);

driverIt("PiDriver managed registration", (it) => {
  it.effect("materializes a disabled instance without probing or spawning Pi", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi_test");
      const instance = yield* PiDriver.create({
        instanceId,
        displayName: "Pi Test",
        environment: [],
        enabled: false,
        config: defaultConfig,
      });
      const snapshot = yield* instance.snapshot.getSnapshot;

      expect(snapshot.instanceId).toBe(instanceId);
      expect(snapshot.driver).toBe(PI_DRIVER_KIND);
      expect(snapshot.displayName).toBe("Pi Test");
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.models).toEqual([]);
      expect(instance.continuationIdentity.continuationKey).toBe(
        `${PI_DRIVER_KIND}:instance:${instanceId}`,
      );
      expect(yield* instance.adapter.listSessions()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("turns invalid launch policy into an unavailable registry snapshot", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("pi_invalid");
      const configMap: ProviderInstanceConfigMap = {
        [instanceId]: {
          driver: PI_DRIVER_KIND,
          enabled: true,
          config: { ...defaultConfig, enabled: true, launchArgs: "--mode json" },
        },
      };
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [PiDriver],
        configMap,
      });

      expect(yield* registry.listInstances).toEqual([]);
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]?.instanceId).toBe(instanceId);
      expect(unavailable[0]?.unavailableReason).toContain("--mode");
    }).pipe(Effect.scoped),
  );
});
