// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makePiRpcRuntime,
  type PiRpcProtocolLogEvent,
  type PiRpcRuntimeOptions,
} from "./PiRpcRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockPath = NodePath.join(__dirname, "../../../scripts/pi-rpc-mock-agent.mjs");

function makeRuntime(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly maxStderrBytes?: number;
  readonly maxRecordBytes?: number;
  readonly logs?: PiRpcProtocolLogEvent[];
  readonly gracefulCloseTimeout?: Duration.Input;
  readonly extensionUiRequestHandler?: PiRpcRuntimeOptions["extensionUiRequestHandler"];
  readonly diagnosticHandler?: PiRpcRuntimeOptions["diagnosticHandler"];
}) {
  return makePiRpcRuntime({
    launch: {
      binaryPath: process.execPath,
      binaryArgs: [mockPath],
      launchArgs: "",
      cwd: process.cwd(),
      env: input?.env ?? {},
      session: { mode: "ephemeral" },
    },
    ...(input?.maxStderrBytes === undefined ? {} : { maxStderrBytes: input.maxStderrBytes }),
    ...(input?.maxRecordBytes === undefined ? {} : { maxRecordBytes: input.maxRecordBytes }),
    ...(input?.gracefulCloseTimeout === undefined
      ? {}
      : { gracefulCloseTimeout: input.gracefulCloseTimeout }),
    ...(input?.extensionUiRequestHandler
      ? { extensionUiRequestHandler: input.extensionUiRequestHandler }
      : {}),
    ...(input?.diagnosticHandler ? { diagnosticHandler: input.diagnosticHandler } : {}),
    ...(input?.logs
      ? {
          protocolLogger: (event: PiRpcProtocolLogEvent) =>
            Effect.sync(() => {
              input.logs!.push(event);
            }),
        }
      : {}),
  });
}

const nodeIt = it.layer(NodeServices.layer);

nodeIt("PiRpcRuntime", (it) => {
  it.effect("correlates interleaved out-of-order responses", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ env: { PI_MOCK_OUT_OF_ORDER: "1" } });
      const first = yield* runtime.getState.pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* runtime.getState.pipe(Effect.forkChild({ startImmediately: true }));

      const [firstState, secondState] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
      expect(firstState.sessionId).toBe("mock-session");
      expect(secondState.sessionId).toBe("mock-session");
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("decodes chunked Unicode events and diagnoses malformed and future records", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const eventFiber = yield* Stream.runCollect(Stream.take(runtime.events, 2)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const diagnosticFiber = yield* Stream.runCollect(Stream.take(runtime.diagnostics, 4)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* runtime.prompt({ message: "events" });
      const events = Array.from(yield* Fiber.join(eventFiber));
      const diagnostics = Array.from(yield* Fiber.join(diagnosticFiber));

      expect(events.map((event) => event._tag)).toEqual(["Unknown", "Known"]);
      const known = events[1];
      expect(known?._tag).toBe("Known");
      if (known?._tag === "Known" && known.event.type === "message_update") {
        const delta = known.event.assistantMessageEvent;
        expect(delta.type).toBe("text_delta");
        if (delta.type === "text_delta") {
          expect(delta.delta).toBe("line\u2028paragraph\u2029🥧");
        }
      }
      expect(diagnostics.map((event) => event._tag)).toEqual([
        "EmptyRecord",
        "MalformedJson",
        "MalformedRecord",
        "UnknownEvent",
      ]);
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("delivers malformed records to the direct diagnostic sink", () =>
    Effect.gen(function* () {
      const observed: string[] = [];
      const runtime = yield* makeRuntime({
        diagnosticHandler: (diagnostic) =>
          Effect.sync(() => {
            observed.push(diagnostic._tag);
          }),
      });

      yield* runtime.prompt({ message: "events" });
      expect(observed).toEqual(["EmptyRecord", "MalformedJson", "MalformedRecord", "UnknownEvent"]);
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("returns typed command failures", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const error = yield* runtime.prompt({ message: "fail-command" }).pipe(Effect.flip);

      expect(error._tag).toBe("PiRpcRequestError");
      if (error._tag === "PiRpcRequestError") {
        expect(error.command).toBe("prompt");
        expect(error.detail).toBe("mock rejection");
      }

      const malformed = yield* runtime.prompt({ message: "malformed-response" }).pipe(Effect.flip);
      expect(malformed._tag).toBe("PiRpcProtocolError");
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("accepts a final response record without LF on process EOF", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      yield* runtime.prompt({ message: "final-no-lf" });
      const metadata = yield* runtime.exit;
      expect(metadata.exitCode).toBe(0);
      expect(metadata.expected).toBe(false);
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("rejects pending requests with bounded stderr on unexpected exit", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ maxStderrBytes: 128 });
      const error = yield* runtime.prompt({ message: "exit-pending" }).pipe(Effect.flip);

      expect(error._tag).toBe("PiRpcProcessError");
      if (error._tag === "PiRpcProcessError") {
        expect(error.exitCode).toBe(7);
        expect(error.stderr.length).toBeLessThanOrEqual(128);
        expect(error.stderr).toContain("xxx");
      }
      const exit = yield* runtime.exit;
      expect(exit.expected).toBe(false);
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("diagnoses responses that arrive after request cancellation", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const eventFiber = yield* Stream.runHead(runtime.events).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const promptFiber = yield* runtime
        .prompt({ message: "late-response" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.join(eventFiber);
      yield* Fiber.interrupt(promptFiber);

      const diagnosticFiber = yield* Stream.runHead(runtime.diagnostics).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runtime.bash("trigger-late-response");
      const diagnostic = yield* Fiber.join(diagnosticFiber);
      expect(diagnostic._tag).toBe("Some");
      if (diagnostic._tag === "Some") {
        expect(diagnostic.value._tag).toBe("UnknownResponseId");
      }
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("writes extension UI responses exactly once", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const requestFiber = yield* Stream.runHead(runtime.events).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runtime.prompt({ message: "dialog" });
      const request = yield* Fiber.join(requestFiber);
      expect(request._tag).toBe("Some");

      const response = {
        type: "extension_ui_response",
        id: "dialog-1",
        confirmed: true,
      } as const;
      yield* runtime.sendExtensionUiResponse(response);
      yield* runtime.sendExtensionUiResponse(response);
      const count = yield* runtime.bash("extension-count");
      expect(count.output).toBe("1");
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("forgets native timed dialogs without responding during close", () =>
    Effect.gen(function* () {
      const logs: PiRpcProtocolLogEvent[] = [];
      const runtime = yield* makeRuntime({ logs });
      const requestFiber = yield* Stream.runHead(runtime.events).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runtime.prompt({ message: "dialog" });
      yield* Fiber.join(requestFiber);
      yield* runtime.forgetExtensionUiRequest("dialog-1");
      yield* runtime.close;
      expect(
        logs.filter(
          (entry) =>
            entry.direction === "outgoing" &&
            typeof entry.payload === "object" &&
            entry.payload !== null &&
            "type" in entry.payload &&
            entry.payload.type === "extension_ui_response",
        ),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "lets an acquisition-time handler answer extension dialogs before subscribers run",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeRuntime({
          extensionUiRequestHandler: (request) =>
            Effect.succeed({
              type: "extension_ui_response",
              id: request.id,
              cancelled: true,
            }),
        });
        yield* runtime.prompt({ message: "dialog" });
        const count = yield* runtime.bash("extension-count");
        expect(count.output).toBe("1");

        yield* runtime.sendExtensionUiResponse({
          type: "extension_ui_response",
          id: "dialog-1",
          cancelled: true,
        });
        const afterDuplicate = yield* runtime.bash("extension-count");
        expect(afterDuplicate.output).toBe("1");
        yield* runtime.close;
      }).pipe(Effect.scoped),
  );

  it.effect("delivers events to an acquisition-time sink without a subscription gap", () =>
    Effect.gen(function* () {
      const observed: string[] = [];
      const runtime = yield* makePiRpcRuntime({
        eventHandler: (event) =>
          Effect.sync(() => {
            observed.push(event._tag === "Known" ? event.event.type : event.type);
          }),
        launch: {
          binaryPath: process.execPath,
          binaryArgs: [mockPath],
          launchArgs: "",
          cwd: process.cwd(),
          env: {},
          session: { mode: "ephemeral" },
        },
      });
      yield* runtime.prompt({ message: "events" });
      expect(observed).toEqual(["future_event", "message_update"]);
      yield* runtime.close;
    }).pipe(Effect.scoped),
  );

  it.effect("cancels outstanding extension dialogs before graceful close", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime();
      const requestFiber = yield* Stream.runHead(runtime.events).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runtime.prompt({ message: "dialog" });
      yield* Fiber.join(requestFiber);

      yield* runtime.close;
      const metadata = yield* runtime.exit;
      expect(metadata.stderr).toContain("cancelled:dialog-1");
    }).pipe(Effect.scoped),
  );

  it.effect("fails bounded framing and terminates a process with a compromised stream", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ maxRecordBytes: 128 });
      const error = yield* runtime.prompt({ message: "oversized-record" }).pipe(Effect.flip);

      expect(error._tag).toBe("PiRpcFramingError");
      const metadata = yield* runtime.exit;
      expect(metadata.expected).toBe(true);
      yield* runtime.close;
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("terminates only its owned process when graceful stdin closure is ignored", () =>
    Effect.gen(function* () {
      const runtime = yield* makeRuntime({ gracefulCloseTimeout: "20 millis" });
      yield* runtime.prompt({ message: "hang-on-eof" });

      yield* runtime.close;
      const metadata = yield* runtime.exit;
      expect(metadata.expected).toBe(true);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("closes the owned process when its scope is released", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const runtime = yield* makeRuntime().pipe(Effect.provideService(Scope.Scope, scope));
      yield* runtime.getState;

      yield* Scope.close(scope, Exit.void);
      const metadata = yield* runtime.exit;
      expect(metadata.expected).toBe(true);
      expect(metadata.exitCode).toBe(0);
    }),
  );

  it.effect("exposes and serializes every documented convenience command", () => {
    const logs: PiRpcProtocolLogEvent[] = [];
    return Effect.gen(function* () {
      const runtime = yield* makeRuntime({ logs });

      yield* runtime.prompt({ message: "hello", streamingBehavior: "steer" });
      yield* runtime.steer("steer");
      yield* runtime.followUp("follow");
      yield* runtime.abort;
      yield* runtime.newSession("/parent.jsonl");
      yield* runtime.getState;
      yield* runtime.getMessages;
      yield* runtime.setModel("mock-provider", "mock-model");
      yield* runtime.cycleModel;
      yield* runtime.getAvailableModels;
      yield* runtime.setThinkingLevel("high");
      yield* runtime.cycleThinkingLevel;
      yield* runtime.getAvailableThinkingLevels;
      yield* runtime.setSteeringMode("all");
      yield* runtime.setFollowUpMode("one-at-a-time");
      yield* runtime.compact("keep tests");
      yield* runtime.setAutoCompaction(true);
      yield* runtime.setAutoRetry(true);
      yield* runtime.abortRetry;
      yield* runtime.bash("echo hello", true);
      yield* runtime.abortBash;
      yield* runtime.getSessionStats;
      yield* runtime.exportHtml("/tmp/mock.html");
      yield* runtime.switchSession("/mock/other.jsonl");
      yield* runtime.fork("entry-1");
      yield* runtime.clone;
      yield* runtime.getForkMessages;
      yield* runtime.getEntries("entry-1");
      yield* runtime.getTree;
      yield* runtime.getLastAssistantText;
      yield* runtime.setSessionName("mock name");
      yield* runtime.getCommands;

      const outgoingTypes = logs
        .filter((event) => event.direction === "outgoing")
        .map((event) => (event.payload as { type: string }).type);
      expect(outgoingTypes).toEqual([
        "prompt",
        "steer",
        "follow_up",
        "abort",
        "new_session",
        "get_state",
        "get_messages",
        "set_model",
        "cycle_model",
        "get_available_models",
        "set_thinking_level",
        "cycle_thinking_level",
        "get_available_thinking_levels",
        "set_steering_mode",
        "set_follow_up_mode",
        "compact",
        "set_auto_compaction",
        "set_auto_retry",
        "abort_retry",
        "bash",
        "abort_bash",
        "get_session_stats",
        "export_html",
        "switch_session",
        "fork",
        "clone",
        "get_fork_messages",
        "get_entries",
        "get_tree",
        "get_last_assistant_text",
        "set_session_name",
        "get_commands",
      ]);
      yield* runtime.close;
      yield* runtime.close;
    }).pipe(Effect.scoped);
  });
});
