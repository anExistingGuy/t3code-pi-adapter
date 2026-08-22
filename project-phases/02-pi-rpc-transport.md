# Phase 2: Pi RPC transport

## Outcome

A scoped, testable transport can spawn an installed Pi CLI, exchange correlated RPC commands over strict JSONL, publish asynchronous records, and terminate safely. It contains no T3 orchestration logic.

## Suggested files

Create a focused boundary under `apps/server/src/provider/pi/`:

- `PiRpcSchemas.ts` — Effect schemas and narrow decoded types;
- `PiRpcConnection.ts` — spawn, framing, command correlation, event stream, shutdown;
- `PiRpcConnection.test.ts`;
- `testFixtures/piRpcMockPeer.mjs` — deterministic child process for protocol tests.

Do not import Pi's npm package. The protocol is external JSON and must be schema-decoded as such.

## Connection API

The concrete shape may vary, but consumers need these operations:

```ts
interface PiRpcConnectionShape {
  request(command: PiRpcCommandWithoutId): Effect.Effect<unknown, ProviderAdapterError>;
  respondToExtensionUi(response: PiExtensionUiResponse): Effect.Effect<void, ProviderAdapterError>;
  events: Stream.Stream<PiRpcEvent>;
  stderr: Effect.Effect<string>;
  exitCode: Effect.Effect<number, ProviderAdapterError>;
  close: Effect.Effect<void>;
}
```

Prefer typed convenience methods over exposing `unknown` to the adapter: `prompt`, `abort`, `getState`, `setModel`, `setThinkingLevel`, `getAvailableModels`, `getCommands`, `getEntries`, and `fork`.

Each request receives a generated string ID. Keep a `Map<id, Deferred>` and complete it only for `type: "response"` with the same ID. A response with `success: false` becomes `ProviderAdapterRequestError` including command and Pi error text. Unknown or duplicate response IDs are logged and ignored, not treated as events.

## Spawn behavior

Use `ChildProcessSpawner`, `resolveSpawnCommand`, and a child `Scope`. Launch arguments are assembled in this order:

1. T3-required arguments: `--mode rpc`;
2. session choice: no flag for new persisted session, `--session <absolute path>`, `--fork <absolute path>`, or `--no-session` for probes/text generation;
3. explicit model selection: `--provider <provider>` and `--model <model-id>` when available;
4. explicit thinking level when selected;
5. T3 bridge: `-e <absolute materialized bridge path>` for normal interactive sessions;
6. decoded user `launchArgs`.

Validate launch arguments so user input cannot negate the transport contract. At minimum reject `--mode`, `--print`/`-p`, `--no-session`, `--session`, `--fork`, and another T3 bridge override. Reuse the repository's existing argument tokenizer used by Codex launch args if compatible; do not split naïvely on spaces.

Set child cwd to the thread cwd and merge the provider instance environment. Apply `PI_CODING_AGENT_DIR` when configured. Do not set `PI_OFFLINE`, disable telemetry, or alter provider credential variables on the user's behalf.

## Strict JSONL framing

Implement incremental UTF-8 decoding with a `StringDecoder`-equivalent or Effect's byte/text channels while preserving this rule:

- delimiter is exactly LF (`0x0a`);
- strip one trailing CR for CRLF compatibility;
- `U+2028` and `U+2029` inside JSON strings are ordinary characters;
- retain an incomplete final record until the next chunk/end;
- impose a bounded maximum buffered record size and fail the connection clearly if exceeded.

Do not use Node `readline`.

Serialize each command as `JSON.stringify(command) + "\n"`. Serialize writes through a semaphore/queue so bytes from concurrent requests cannot interleave. Verify that re-running the Effect child stdin sink writes without closing the stream; if the platform sink cannot support repeated writes, add a small Node-stream bridge at this boundary only and keep its acquisition/finalization scoped.

## Incoming schema strategy

Use `Schema` for the untrusted outer envelope. Decode enough to discriminate:

- successful/failed responses;
- documented agent/message/tool/session/retry/compaction events;
- `extension_ui_request`;
- unknown records.

Do not build one brittle exhaustive union that rejects a newer Pi event. Recommended approach:

1. decode `{ type: string }` plus optional known fields;
2. dispatch known `type` values through more specific schemas;
3. represent a valid unknown record as `{ type: "unknown", raw }` internally;
4. malformed JSON or malformed known records emit a protocol warning and continue if framing remains synchronized;
5. repeated malformed records or oversized input may fail the connection.

## Process lifecycle

- Spawn inside the provider session's child scope.
- Start stdout, stderr, and exit watchers immediately.
- Bound retained stderr (for example 64 KiB tail) while native logging may retain its normal rotated record.
- On unexpected process exit, fail all pending requests and publish one connection-exited signal.
- `close` should request graceful termination where practical, then kill the exact captured child after a short bounded grace period. Never discover or kill by process-name/path matching.
- Queue/event streams are shut down in finalizers.
- Closing twice is harmless.

## Native logging

Accept an optional `EventNdjsonLogger`, as other adapters do. Log inbound Pi events and outbound command metadata with thread correlation, but redact:

- base64 image content;
- environment values;
- extension UI free-text answers if marked sensitive;
- full prompts when existing provider logger policy does not retain them.

Follow `ProviderEventLoggers` conventions rather than creating an independent log directory.

## Tests

The mock peer must test:

- records split across arbitrary byte and UTF-8 boundaries;
- several records in one chunk;
- CRLF input;
- literal `U+2028`/`U+2029` in JSON strings;
- concurrent request correlation and out-of-order responses;
- `success: false` mapping;
- unknown event tolerance;
- malformed JSON tolerance/failure threshold;
- bounded record and stderr buffers;
- pending request failure on child exit;
- scoped cleanup and idempotent close;
- launch args and environment passed exactly once;
- Windows launcher resolution through `resolveSpawnCommand`.

## Acceptance criteria

- No Pi-specific orchestration state exists in the transport.
- A fake peer can complete multiple commands while concurrently emitting events.
- The transport never uses generic line readers.
- Scope closure leaves no captured child running.
- New unknown Pi event types do not crash a live session.
