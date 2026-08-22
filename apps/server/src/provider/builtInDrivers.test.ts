import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, PI_DRIVER_KIND, ProviderInstanceId } from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";

describe("Pi built-in driver registration", () => {
  it("registers piAgent exactly once", () => {
    expect(BUILT_IN_DRIVERS.filter((driver) => driver.driverKind === PI_DRIVER_KIND)).toHaveLength(
      1,
    );
  });

  it("hydrates the default Pi instance from legacy settings", () => {
    const instances = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    expect(instances[ProviderInstanceId.make("piAgent")]).toEqual({
      driver: PI_DRIVER_KIND,
      config: DEFAULT_SERVER_SETTINGS.providers.piAgent,
    });
  });

  it("preserves an explicit default Pi instance over the legacy mirror", () => {
    const instanceId = ProviderInstanceId.make("piAgent");
    const explicit = {
      driver: PI_DRIVER_KIND,
      enabled: true,
      config: { binaryPath: "/opt/pi", agentDir: "/profiles/work" },
    } as const;
    const instances = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [instanceId]: explicit },
    });

    expect(instances[instanceId]).toEqual(explicit);
  });
});
