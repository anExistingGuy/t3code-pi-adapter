import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodePiRpcKnownEvent,
  decodePiRpcResponseData,
  decodePiRpcResponseEnvelope,
} from "./PiRpcProtocol.ts";

describe("PiRpcProtocol", () => {
  it.effect("preserves unknown fields on known records", () =>
    Effect.gen(function* () {
      const event = yield* decodePiRpcKnownEvent({
        type: "agent_settled",
        futureField: { enabled: true },
      });
      expect(event).toMatchObject({
        type: "agent_settled",
        futureField: { enabled: true },
      });
    }),
  );

  it.effect("decodes command failures independently of command-specific data", () =>
    Effect.gen(function* () {
      const response = yield* decodePiRpcResponseEnvelope({
        id: "request-1",
        type: "response",
        command: "set_model",
        success: false,
        error: "model unavailable",
        futureField: true,
      });
      expect(response).toMatchObject({
        id: "request-1",
        command: "set_model",
        success: false,
        error: "model unavailable",
        futureField: true,
      });
    }),
  );

  it.effect("strictly validates command-specific success data", () =>
    Effect.gen(function* () {
      const valid = yield* decodePiRpcResponseData("new_session", { cancelled: false, future: 1 });
      expect(valid).toMatchObject({ cancelled: false, future: 1 });

      const invalid = yield* decodePiRpcResponseData("new_session", { cancelled: "no" }).pipe(
        Effect.result,
      );
      expect(invalid._tag).toBe("Failure");
    }),
  );

  it.effect("rejects malformed known events", () =>
    Effect.gen(function* () {
      const result = yield* decodePiRpcKnownEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        isError: "false",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );
});
