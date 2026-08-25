import * as Cause from "effect/Cause";
import type { Done } from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolvePiLaunch, type PiLaunchInput } from "./PiLaunch.ts";
import { PiRpcFramingError, PiRpcJsonlDecoder, serializePiRpcJsonl } from "./PiRpcJsonl.ts";
import {
  PI_RPC_KNOWN_EVENT_TYPES,
  decodePiExtensionUiResponse,
  decodePiRpcCommand,
  decodePiRpcJson,
  decodePiRpcKnownEvent,
  decodePiRpcResponseData,
  decodePiRpcResponseEnvelope,
  decodePiRpcResponseHint,
  decodePiRpcTypedRecord,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiRpcCommandType,
  type PiRpcCommandWithoutId,
  type PiRpcKnownEvent,
  type PiRpcResponseData,
  type PiRpcResponseEnvelope,
} from "./PiRpcProtocol.ts";

const DEFAULT_STDERR_BYTES = 64 * 1024;

export class PiRpcProtocolError extends Schema.TaggedErrorClass<PiRpcProtocolError>()(
  "PiRpcProtocolError",
  {
    detail: Schema.String,
    command: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PiRpcRequestError extends Schema.TaggedErrorClass<PiRpcRequestError>()(
  "PiRpcRequestError",
  {
    command: Schema.String,
    detail: Schema.String,
    id: Schema.String,
  },
) {}

export class PiRpcProcessError extends Schema.TaggedErrorClass<PiRpcProcessError>()(
  "PiRpcProcessError",
  {
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stderr: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class PiRpcClosedError extends Schema.TaggedErrorClass<PiRpcClosedError>()(
  "PiRpcClosedError",
  { detail: Schema.String },
) {}

export type PiRpcError =
  | PiRpcProtocolError
  | PiRpcRequestError
  | PiRpcProcessError
  | PiRpcClosedError
  | PiRpcFramingError;

export type PiRpcEvent =
  | { readonly _tag: "Known"; readonly event: PiRpcKnownEvent }
  | {
      readonly _tag: "Unknown";
      readonly type: string;
      readonly payload: Readonly<Record<string, unknown>>;
    };

export type PiRpcDiagnostic =
  | { readonly _tag: "EmptyRecord" }
  | { readonly _tag: "MalformedJson"; readonly detail: string }
  | { readonly _tag: "MalformedRecord"; readonly type?: string; readonly detail: string }
  | { readonly _tag: "UnknownEvent"; readonly type: string }
  | { readonly _tag: "UnknownResponseId"; readonly id?: string; readonly command: string }
  | {
      readonly _tag: "ResponseCommandMismatch";
      readonly id: string;
      readonly expected: string;
      readonly received: string;
    }
  | { readonly _tag: "DuplicateExtensionUiResponse"; readonly id: string };

export interface PiRpcExit {
  readonly exitCode: number | undefined;
  readonly expected: boolean;
  readonly stderr: string;
}

export interface PiRpcProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly payload: unknown;
}

export interface PiRpcRuntimeOptions {
  readonly launch: PiLaunchInput;
  readonly maxRecordBytes?: number;
  readonly maxBufferBytes?: number;
  readonly maxStderrBytes?: number;
  readonly gracefulCloseTimeout?: Duration.Input;
  readonly forceKillAfter?: Duration.Input;
  readonly protocolLogger?: (event: PiRpcProtocolLogEvent) => Effect.Effect<void, never>;
  readonly extensionUiRequestHandler?: (
    request: PiExtensionUiRequest,
  ) => Effect.Effect<PiExtensionUiResponse | undefined, never>;
  /** Acquisition-time event sink for owners that cannot tolerate a PubSub subscription gap. */
  readonly eventHandler?: (event: PiRpcEvent) => Effect.Effect<void, never>;
}

type Pending = {
  readonly command: PiRpcCommandType;
  readonly deferred: Deferred.Deferred<PiRpcResponseEnvelope, PiRpcError>;
};

type RuntimeState = "open" | "closing" | "failing" | "closed";

export interface PiRpcRuntime {
  readonly send: <Command extends PiRpcCommandWithoutId>(
    command: Command,
  ) => Effect.Effect<PiRpcResponseData<Command["type"]>, PiRpcError>;
  readonly sendExtensionUiResponse: (
    response: PiExtensionUiResponse,
  ) => Effect.Effect<void, PiRpcError>;
  readonly events: Stream.Stream<PiRpcEvent>;
  readonly diagnostics: Stream.Stream<PiRpcDiagnostic>;
  readonly stderr: Effect.Effect<string>;
  readonly exit: Effect.Effect<PiRpcExit>;
  readonly close: Effect.Effect<void>;
  readonly prompt: (input: {
    readonly message: string;
    readonly images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>;
    readonly streamingBehavior?: "steer" | "followUp";
  }) => Effect.Effect<void, PiRpcError>;
  readonly steer: (
    message: string,
    images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>,
  ) => Effect.Effect<void, PiRpcError>;
  readonly followUp: (
    message: string,
    images?: ReadonlyArray<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }>,
  ) => Effect.Effect<void, PiRpcError>;
  readonly abort: Effect.Effect<void, PiRpcError>;
  readonly newSession: (
    parentSession?: string,
  ) => Effect.Effect<PiRpcResponseData<"new_session">, PiRpcError>;
  readonly getState: Effect.Effect<PiRpcResponseData<"get_state">, PiRpcError>;
  readonly getMessages: Effect.Effect<PiRpcResponseData<"get_messages">["messages"], PiRpcError>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<PiRpcResponseData<"set_model">, PiRpcError>;
  readonly cycleModel: Effect.Effect<PiRpcResponseData<"cycle_model">, PiRpcError>;
  readonly getAvailableModels: Effect.Effect<
    PiRpcResponseData<"get_available_models">["models"],
    PiRpcError
  >;
  readonly setThinkingLevel: (
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  ) => Effect.Effect<void, PiRpcError>;
  readonly cycleThinkingLevel: Effect.Effect<PiRpcResponseData<"cycle_thinking_level">, PiRpcError>;
  readonly getAvailableThinkingLevels: Effect.Effect<
    PiRpcResponseData<"get_available_thinking_levels">["levels"],
    PiRpcError
  >;
  readonly setSteeringMode: (mode: "all" | "one-at-a-time") => Effect.Effect<void, PiRpcError>;
  readonly setFollowUpMode: (mode: "all" | "one-at-a-time") => Effect.Effect<void, PiRpcError>;
  readonly compact: (
    customInstructions?: string,
  ) => Effect.Effect<PiRpcResponseData<"compact">, PiRpcError>;
  readonly setAutoCompaction: (enabled: boolean) => Effect.Effect<void, PiRpcError>;
  readonly setAutoRetry: (enabled: boolean) => Effect.Effect<void, PiRpcError>;
  readonly abortRetry: Effect.Effect<void, PiRpcError>;
  readonly bash: (
    command: string,
    excludeFromContext?: boolean,
  ) => Effect.Effect<PiRpcResponseData<"bash">, PiRpcError>;
  readonly abortBash: Effect.Effect<void, PiRpcError>;
  readonly getSessionStats: Effect.Effect<PiRpcResponseData<"get_session_stats">, PiRpcError>;
  readonly exportHtml: (
    outputPath?: string,
  ) => Effect.Effect<PiRpcResponseData<"export_html">, PiRpcError>;
  readonly switchSession: (
    sessionPath: string,
  ) => Effect.Effect<PiRpcResponseData<"switch_session">, PiRpcError>;
  readonly fork: (entryId: string) => Effect.Effect<PiRpcResponseData<"fork">, PiRpcError>;
  readonly clone: Effect.Effect<PiRpcResponseData<"clone">, PiRpcError>;
  readonly getForkMessages: Effect.Effect<
    PiRpcResponseData<"get_fork_messages">["messages"],
    PiRpcError
  >;
  readonly getEntries: (
    since?: string,
  ) => Effect.Effect<PiRpcResponseData<"get_entries">, PiRpcError>;
  readonly getTree: Effect.Effect<PiRpcResponseData<"get_tree">, PiRpcError>;
  readonly getLastAssistantText: Effect.Effect<string | null, PiRpcError>;
  readonly setSessionName: (name: string) => Effect.Effect<void, PiRpcError>;
  readonly getCommands: Effect.Effect<PiRpcResponseData<"get_commands">["commands"], PiRpcError>;
}

const parseErrorDetail = (cause: unknown) => String(cause).slice(0, 2_048);

export const makePiRpcRuntime = Effect.fn("makePiRpcRuntime")(function* (
  options: PiRpcRuntimeOptions,
): Effect.fn.Return<
  PiRpcRuntime,
  PiRpcProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const launch = yield* resolvePiLaunch(options.launch).pipe(
    Effect.mapError(
      (cause) =>
        new PiRpcProcessError({
          detail: cause.detail,
          stderr: "",
          cause,
        }),
    ),
  );
  const input = yield* Queue.unbounded<Uint8Array, Done>();
  const events = yield* PubSub.unbounded<PiRpcEvent>();
  const diagnostics = yield* PubSub.unbounded<PiRpcDiagnostic>();
  const pending = yield* Ref.make(new Map<string, Pending>());
  const extensionDialogs = yield* Ref.make(new Set<string>());
  const answeredDialogs = yield* Ref.make(new Set<string>());
  const state = yield* Ref.make<RuntimeState>("open");
  const stderrBytes = yield* Ref.make(new Uint8Array());
  const exit = yield* Deferred.make<PiRpcExit>();
  const closeDone = yield* Deferred.make<void>();
  const writes = yield* Semaphore.make(1);
  const decoder = new PiRpcJsonlDecoder({
    ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
    ...(options.maxBufferBytes === undefined ? {} : { maxBufferBytes: options.maxBufferBytes }),
  });

  const child = yield* spawner
    .spawn(
      ChildProcess.make(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        extendEnv: true,
        shell: launch.shell,
        stdin: { stream: Stream.fromQueue(input), endOnDone: true },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new PiRpcProcessError({
            detail: `Failed to spawn '${options.launch.binaryPath}' in RPC mode.`,
            stderr: "",
            cause,
          }),
      ),
    );

  const logProtocol = (event: PiRpcProtocolLogEvent) =>
    options.protocolLogger
      ? options
          .protocolLogger(event)
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void,
            ),
          )
      : Effect.void;
  const publishDiagnostic = (diagnostic: PiRpcDiagnostic) =>
    PubSub.publish(diagnostics, diagnostic).pipe(Effect.asVoid);

  const currentStderr = Ref.get(stderrBytes).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );

  const rejectPending = (error: PiRpcError) =>
    Ref.getAndSet(pending, new Map()).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries.values(), ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const failFraming = (error: PiRpcFramingError) =>
    Ref.set(state, "failing").pipe(
      Effect.andThen(rejectPending(error)),
      Effect.andThen(Queue.end(input)),
      Effect.andThen(
        child.kill({ forceKillAfter: options.forceKillAfter ?? "1 second" }).pipe(Effect.ignore),
      ),
    );

  const handleResponse = Effect.fn("PiRpcRuntime.handleResponse")(function* (
    response: PiRpcResponseEnvelope,
  ) {
    if (!response.id) {
      yield* publishDiagnostic({
        _tag: "UnknownResponseId",
        command: response.command,
      });
      return;
    }
    const match = yield* Ref.modify(pending, (current) => {
      const found = current.get(response.id!);
      if (!found) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(response.id!);
      return [found, next] as const;
    });
    if (!match) {
      yield* publishDiagnostic({
        _tag: "UnknownResponseId",
        id: response.id,
        command: response.command,
      });
      return;
    }
    if (match.command !== response.command) {
      const error = new PiRpcProtocolError({
        detail: `Response command '${response.command}' did not match '${match.command}'.`,
        command: response.command,
        id: response.id,
      });
      yield* publishDiagnostic({
        _tag: "ResponseCommandMismatch",
        id: response.id,
        expected: match.command,
        received: response.command,
      });
      yield* Deferred.fail(match.deferred, error);
      return;
    }
    yield* Deferred.succeed(match.deferred, response);
  });

  const writeHandledExtensionUiResponse = Effect.fn("PiRpcRuntime.writeHandledExtensionUiResponse")(
    function* (response: PiExtensionUiResponse) {
      if ((yield* Ref.get(state)) !== "open") return;
      const shouldWrite = yield* Ref.modify(answeredDialogs, (current) => {
        if (current.has(response.id)) return [false, current] as const;
        const next = new Set(current);
        next.add(response.id);
        return [true, next] as const;
      });
      if (!shouldWrite) return;
      yield* Ref.update(extensionDialogs, (current) => {
        const next = new Set(current);
        next.delete(response.id);
        return next;
      });
      yield* logProtocol({ direction: "outgoing", payload: response });
      yield* Queue.offer(input, serializePiRpcJsonl(response)).pipe(Effect.asVoid);
    },
  );

  const rejectMalformedResponse = Effect.fn("PiRpcRuntime.rejectMalformedResponse")(function* (
    payload: unknown,
    cause: unknown,
  ) {
    const hint = yield* decodePiRpcResponseHint(payload).pipe(Effect.result);
    if (hint._tag === "Success" && hint.success.id) {
      const match = yield* Ref.modify(pending, (current) => {
        const found = current.get(hint.success.id!);
        if (!found) return [undefined, current] as const;
        const next = new Map(current);
        next.delete(hint.success.id!);
        return [found, next] as const;
      });
      if (match) {
        yield* Deferred.fail(
          match.deferred,
          new PiRpcProtocolError({
            detail: `Malformed response envelope for '${match.command}'.`,
            command: hint.success.command,
            id: hint.success.id,
            cause,
          }),
        );
      }
    }
  });

  const handleLine = Effect.fn("PiRpcRuntime.handleLine")(function* (line: string) {
    if (line.length === 0) {
      yield* publishDiagnostic({ _tag: "EmptyRecord" });
      return;
    }
    const json = yield* decodePiRpcJson(line).pipe(Effect.result);
    if (json._tag === "Failure") {
      yield* publishDiagnostic({
        _tag: "MalformedJson",
        detail: parseErrorDetail(json.failure),
      });
      return;
    }
    const typed = yield* decodePiRpcTypedRecord(json.success).pipe(Effect.result);
    if (typed._tag === "Failure") {
      yield* publishDiagnostic({
        _tag: "MalformedRecord",
        detail: parseErrorDetail(typed.failure),
      });
      return;
    }
    yield* logProtocol({ direction: "incoming", payload: json.success });

    if (typed.success.type === "response") {
      const decoded = yield* decodePiRpcResponseEnvelope(json.success).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        yield* rejectMalformedResponse(json.success, decoded.failure);
        yield* publishDiagnostic({
          _tag: "MalformedRecord",
          type: "response",
          detail: parseErrorDetail(decoded.failure),
        });
        return;
      }
      yield* handleResponse(decoded.success);
      return;
    }

    if (PI_RPC_KNOWN_EVENT_TYPES.has(typed.success.type)) {
      const decoded = yield* decodePiRpcKnownEvent(json.success).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        yield* publishDiagnostic({
          _tag: "MalformedRecord",
          type: typed.success.type,
          detail: parseErrorDetail(decoded.failure),
        });
        return;
      }
      if (decoded.success.type === "extension_ui_request") {
        const request = decoded.success as PiExtensionUiRequest;
        if (["select", "confirm", "input", "editor"].includes(request.method)) {
          yield* Ref.update(extensionDialogs, (current) => new Set(current).add(request.id));
        }
        if (options.extensionUiRequestHandler) {
          const response = yield* options.extensionUiRequestHandler(request);
          if (response) yield* writeHandledExtensionUiResponse(response);
        }
      }
      const event = { _tag: "Known", event: decoded.success } as const;
      if (options.eventHandler) yield* options.eventHandler(event);
      yield* PubSub.publish(events, event);
      return;
    }

    yield* publishDiagnostic({ _tag: "UnknownEvent", type: typed.success.type });
    const event = {
      _tag: "Unknown",
      type: typed.success.type,
      payload: json.success as Readonly<Record<string, unknown>>,
    } as const;
    if (options.eventHandler) yield* options.eventHandler(event);
    yield* PubSub.publish(events, event);
  });

  const consumeDecoderResult = (result: ReturnType<PiRpcJsonlDecoder["push"]>) =>
    result._tag === "Failure"
      ? failFraming(result.error)
      : Effect.forEach(result.records, handleLine, { discard: true });

  const stdoutFiber = yield* child.stdout.pipe(
    Stream.runForEach((chunk) => consumeDecoderResult(decoder.push(chunk))),
    Effect.flatMap(() => consumeDecoderResult(decoder.end())),
    Effect.catchCause((cause) =>
      failFraming(
        new PiRpcFramingError({
          reason: "invalid-utf8",
          limitBytes: options.maxBufferBytes ?? 8 * 1024 * 1024,
          observedBytes: 0,
          cause,
        }),
      ),
    ),
    Effect.forkIn(scope),
  );

  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_BYTES;
  const stderrFiber = yield* child.stderr.pipe(
    Stream.runForEach((chunk) =>
      Ref.update(stderrBytes, (current) => {
        const joined = new Uint8Array(current.byteLength + chunk.byteLength);
        joined.set(current);
        joined.set(chunk, current.byteLength);
        return joined.byteLength <= maxStderrBytes
          ? joined
          : joined.slice(joined.byteLength - maxStderrBytes);
      }),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.forkIn(scope),
  );

  yield* child.exitCode.pipe(
    Effect.flatMap((code) =>
      Effect.gen(function* () {
        yield* Fiber.join(stdoutFiber).pipe(Effect.ignore);
        yield* Fiber.join(stderrFiber).pipe(Effect.ignore);
        const runtimeState = yield* Ref.get(state);
        const stderr = yield* currentStderr;
        const metadata = {
          exitCode: Number(code),
          expected: runtimeState !== "open",
          stderr,
        } satisfies PiRpcExit;
        yield* Deferred.succeed(exit, metadata);
        if (runtimeState === "open") {
          yield* rejectPending(
            new PiRpcProcessError({
              detail: `Pi RPC process exited unexpectedly with code ${Number(code)}.`,
              exitCode: Number(code),
              stderr,
            }),
          );
        }
        if (runtimeState !== "closing") {
          yield* Ref.set(state, "closed");
        }
        yield* PubSub.shutdown(events);
        yield* PubSub.shutdown(diagnostics);
        if (runtimeState !== "closing") {
          yield* Deferred.succeed(closeDone, undefined);
        }
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const stderr = yield* currentStderr;
        yield* rejectPending(
          new PiRpcProcessError({
            detail: "Failed while waiting for the Pi RPC process to exit.",
            stderr,
            cause,
          }),
        );
      }),
    ),
    Effect.forkIn(scope),
  );

  const write = (payload: unknown) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const runtimeState = yield* Ref.get(state);
        if (runtimeState !== "open") {
          return yield* new PiRpcClosedError({ detail: "Pi RPC runtime is closed." });
        }
        yield* logProtocol({ direction: "outgoing", payload });
        const accepted = yield* Queue.offer(input, serializePiRpcJsonl(payload));
        if (!accepted) {
          return yield* new PiRpcClosedError({ detail: "Pi RPC stdin is closed." });
        }
      }),
    );

  const send: PiRpcRuntime["send"] = <Command extends PiRpcCommandWithoutId>(command: Command) =>
    Effect.gen(function* () {
      yield* decodePiRpcCommand(command).pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcProtocolError({
              detail: "Invalid Pi RPC command.",
              command: command.type,
              cause,
            }),
        ),
      );
      const id = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcProtocolError({
              detail: "Failed to generate a Pi RPC correlation id.",
              command: command.type,
              cause,
            }),
        ),
      );
      const deferred = yield* Deferred.make<PiRpcResponseEnvelope, PiRpcError>();
      yield* Ref.update(pending, (current) => {
        const next = new Map(current);
        next.set(id, { command: command.type, deferred });
        return next;
      });
      yield* write({ ...command, id }).pipe(
        Effect.onError(() =>
          Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      const response = yield* Deferred.await(deferred).pipe(
        Effect.onInterrupt(() =>
          Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      if (!response.success) {
        return yield* new PiRpcRequestError({
          command: command.type,
          detail: response.error,
          id,
        });
      }
      return yield* decodePiRpcResponseData(command.type, response.data).pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcProtocolError({
              detail: `Malformed success response data for '${command.type}'.`,
              command: command.type,
              id,
              cause,
            }),
        ),
      );
    });

  const sendExtensionUiResponse = (response: PiExtensionUiResponse) =>
    Effect.gen(function* () {
      yield* decodePiExtensionUiResponse(response).pipe(
        Effect.mapError(
          (cause) =>
            new PiRpcProtocolError({
              detail: "Invalid Pi extension UI response.",
              id: response.id,
              cause,
            }),
        ),
      );
      const shouldWrite = yield* Ref.modify(answeredDialogs, (current) => {
        if (current.has(response.id)) return [false, current] as const;
        const next = new Set(current);
        next.add(response.id);
        return [true, next] as const;
      });
      if (!shouldWrite) {
        yield* publishDiagnostic({ _tag: "DuplicateExtensionUiResponse", id: response.id });
        return;
      }
      yield* Ref.update(extensionDialogs, (current) => {
        const next = new Set(current);
        next.delete(response.id);
        return next;
      });
      yield* write(response);
    });

  const close = Effect.gen(function* () {
    const action = yield* Ref.modify(state, (current) => {
      if (current === "open") return ["start" as const, "closing" as const] as const;
      if (current === "closing" || current === "failing") {
        return ["wait" as const, current] as const;
      }
      return ["done" as const, current] as const;
    });
    if (action === "done") return;
    if (action === "wait") {
      yield* Deferred.await(closeDone);
      return;
    }
    const dialogs = yield* Ref.getAndSet(extensionDialogs, new Set());
    for (const id of dialogs) {
      const response = { type: "extension_ui_response", id, cancelled: true } as const;
      yield* logProtocol({ direction: "outgoing", payload: response });
      yield* Queue.offer(input, serializePiRpcJsonl(response)).pipe(Effect.ignore);
    }
    yield* Queue.end(input);
    const graceful = yield* Deferred.await(exit).pipe(
      Effect.timeoutOption(options.gracefulCloseTimeout ?? "2 seconds"),
    );
    if (Option.isNone(graceful)) {
      yield* child
        .kill({ forceKillAfter: options.forceKillAfter ?? "1 second" })
        .pipe(Effect.ignore);
      yield* Deferred.await(exit).pipe(Effect.ignore);
    }
    yield* rejectPending(new PiRpcClosedError({ detail: "Pi RPC runtime was closed." }));
    yield* Ref.set(state, "closed");
    yield* PubSub.shutdown(events);
    yield* PubSub.shutdown(diagnostics);
    yield* Deferred.succeed(closeDone, undefined);
  }).pipe(Effect.uninterruptible);

  yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));

  const runtime: PiRpcRuntime = {
    send,
    sendExtensionUiResponse,
    events: Stream.fromPubSub(events),
    diagnostics: Stream.fromPubSub(diagnostics),
    stderr: currentStderr,
    exit: Deferred.await(exit),
    close,
    prompt: (value) => send({ type: "prompt", ...value }),
    steer: (message, images) => send({ type: "steer", message, ...(images ? { images } : {}) }),
    followUp: (message, images) =>
      send({ type: "follow_up", message, ...(images ? { images } : {}) }),
    abort: send({ type: "abort" }),
    newSession: (parentSession) =>
      send({ type: "new_session", ...(parentSession ? { parentSession } : {}) }),
    getState: send({ type: "get_state" }),
    getMessages: send({ type: "get_messages" }).pipe(Effect.map((data) => data.messages)),
    setModel: (provider, modelId) => send({ type: "set_model", provider, modelId }),
    cycleModel: send({ type: "cycle_model" }),
    getAvailableModels: send({ type: "get_available_models" }).pipe(
      Effect.map((data) => data.models),
    ),
    setThinkingLevel: (level) => send({ type: "set_thinking_level", level }),
    cycleThinkingLevel: send({ type: "cycle_thinking_level" }),
    getAvailableThinkingLevels: send({ type: "get_available_thinking_levels" }).pipe(
      Effect.map((data) => data.levels),
    ),
    setSteeringMode: (mode) => send({ type: "set_steering_mode", mode }),
    setFollowUpMode: (mode) => send({ type: "set_follow_up_mode", mode }),
    compact: (customInstructions) =>
      send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) }),
    setAutoCompaction: (enabled) => send({ type: "set_auto_compaction", enabled }),
    setAutoRetry: (enabled) => send({ type: "set_auto_retry", enabled }),
    abortRetry: send({ type: "abort_retry" }),
    bash: (command, excludeFromContext) =>
      send({
        type: "bash",
        command,
        ...(excludeFromContext === undefined ? {} : { excludeFromContext }),
      }),
    abortBash: send({ type: "abort_bash" }),
    getSessionStats: send({ type: "get_session_stats" }),
    exportHtml: (outputPath) =>
      send({ type: "export_html", ...(outputPath ? { outputPath } : {}) }),
    switchSession: (sessionPath) => send({ type: "switch_session", sessionPath }),
    fork: (entryId) => send({ type: "fork", entryId }),
    clone: send({ type: "clone" }),
    getForkMessages: send({ type: "get_fork_messages" }).pipe(Effect.map((data) => data.messages)),
    getEntries: (since) => send({ type: "get_entries", ...(since ? { since } : {}) }),
    getTree: send({ type: "get_tree" }),
    getLastAssistantText: send({ type: "get_last_assistant_text" }).pipe(
      Effect.map((data) => data.text),
    ),
    setSessionName: (name) => send({ type: "set_session_name", name }),
    getCommands: send({ type: "get_commands" }).pipe(Effect.map((data) => data.commands)),
  };
  return runtime;
});
