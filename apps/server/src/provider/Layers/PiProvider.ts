import { PI_DRIVER_KIND, type PiSettings, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

export const PI_MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: PI_DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});

export const buildInitialPiProviderSnapshot = Effect.fn("buildInitialPiProviderSnapshot")(
  function* (settings: PiSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: {
        displayName: "Pi",
        showInteractionModeToggle: true,
        requiresNewThreadForModelChange: false,
      },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: settings.enabled
        ? {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi CLI availability has not been checked yet.",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    });
  },
);

/** A non-probing snapshot service used until RPC discovery lands. */
export function makeStaticPiProvider(
  snapshot: ServerProvider,
  maintenanceCapabilities: ProviderMaintenanceCapabilities = PI_MAINTENANCE_CAPABILITIES,
): ServerProviderShape {
  return {
    maintenanceCapabilities,
    getSnapshot: Effect.succeed(snapshot),
    refresh: Effect.succeed(snapshot),
    streamChanges: Stream.empty,
  };
}
