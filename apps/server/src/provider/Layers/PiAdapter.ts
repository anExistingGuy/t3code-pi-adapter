import { PI_DRIVER_KIND } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";

const unsupported = (method: string) =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PI_DRIVER_KIND,
      method,
      detail: "Pi RPC support is not implemented yet.",
    }),
  );

/**
 * Phase-one adapter placeholder. It deliberately owns no process or session;
 * later phases replace these typed failures with the scoped RPC transport.
 */
export function makePiAdapter(_options: {
  readonly environment: NodeJS.ProcessEnv;
}): PiAdapterShape {
  return {
    provider: PI_DRIVER_KIND,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: () => unsupported("startSession"),
    sendTurn: () => unsupported("sendTurn"),
    interruptTurn: () => unsupported("interruptTurn"),
    respondToRequest: () => unsupported("respondToRequest"),
    respondToUserInput: () => unsupported("respondToUserInput"),
    stopSession: () => unsupported("stopSession"),
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => unsupported("readThread"),
    rollbackThread: () => unsupported("rollbackThread"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}
