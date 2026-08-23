import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { PiRpcProtocolLogEvent, PiRpcRuntimeOptions } from "./PiRpcRuntime.ts";

const MAX_STRING_CHARS = 4_096;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_FIELDS = 64;
const OMITTED_KEYS = new Set([
  "data",
  "content",
  "output",
  "partialResult",
  "result",
  "entries",
  "tree",
]);

function boundValue(value: unknown, key: string | undefined, depth: number): unknown {
  if (depth > 4) return "<depth-limit>";
  if (Predicate.isString(value)) {
    if (key === "data") return `<omitted ${value.length} chars>`;
    return value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS)}<truncated ${value.length - MAX_STRING_CHARS} chars>`;
  }
  if (Predicate.isNumber(value) || Predicate.isBoolean(value) || Predicate.isNull(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (key && OMITTED_KEYS.has(key) && value.length > MAX_ARRAY_ITEMS) {
      return { itemCount: value.length, omitted: true };
    }
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundValue(item, undefined, depth + 1));
  }
  if (!Predicate.isObject(value)) return { valueType: typeof value };

  const output: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value).slice(0, MAX_OBJECT_FIELDS)) {
    if (OMITTED_KEYS.has(field) && field === "data") {
      output[field] = Predicate.isString(fieldValue)
        ? `<omitted ${fieldValue.length} chars>`
        : "<omitted>";
      continue;
    }
    output[field] = boundValue(fieldValue, field, depth + 1);
  }
  return output;
}

export function formatPiRpcProtocolLog(event: PiRpcProtocolLogEvent) {
  return {
    direction: event.direction,
    payload: boundValue(event.payload, undefined, 0),
  };
}

export const makePiNativeLoggerFactory = Effect.fn("makePiNativeLoggerFactory")(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
  }): Pick<PiRpcRuntimeOptions, "protocolLogger"> => ({
    protocolLogger: (event) =>
      Effect.gen(function* () {
        if (!input.nativeEventLogger) return;
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* input.nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* crypto.randomUUIDv4,
              kind: "protocol",
              provider: input.provider,
              createdAt: observedAt,
              threadId: input.threadId,
              payload: formatPiRpcProtocolLog(event),
            },
          },
          input.threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Failed to write native Pi RPC event log.", {
                errorTag: causeErrorTag(cause),
                reasonCount: cause.reasons.length,
                provider: input.provider,
                threadId: input.threadId,
              }),
        ),
      ),
  });
});
