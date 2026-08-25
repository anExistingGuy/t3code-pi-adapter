import {
  ApprovalRequestId,
  EventId,
  isProviderSendTurnSupportedImageMimeType,
  PI_DRIVER_KIND,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type PiSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  decodePiModelSlug,
  encodePiModelSlug,
  PI_THINKING_LEVEL_OPTION_ID,
  type PiModelIdentity,
} from "../pi/PiModelCatalog.ts";
import {
  PiThinkingLevel,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiImageContent,
  type PiRpcKnownEvent,
  type PiThinkingLevel as PiThinkingLevelValue,
} from "../pi/PiRpcProtocol.ts";
import {
  makePiRpcRuntime,
  type PiRpcError,
  type PiRpcEvent,
  type PiRpcExit,
  type PiRpcRuntime,
} from "../pi/PiRpcRuntime.ts";
import { makePiNativeLoggerFactory } from "../pi/PiRpcNativeLogging.ts";

const PI_RESUME_VERSION = 1 as const;
const isPiThinkingLevel = Schema.is(PiThinkingLevel);
const isProviderAdapterError = Schema.is(
  Schema.Union([
    ProviderAdapterValidationError,
    ProviderAdapterSessionNotFoundError,
    ProviderAdapterSessionClosedError,
    ProviderAdapterRequestError,
    ProviderAdapterProcessError,
  ]),
);

const PiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(PI_RESUME_VERSION),
  sessionFile: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  leafId: Schema.NullOr(Schema.NonEmptyString),
});
type PiResumeCursor = typeof PiResumeCursor.Type;
const isPiResumeCursor = Schema.is(PiResumeCursor);

interface PiPendingDialog {
  readonly request: PiExtensionUiRequest;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcRuntime;
  readonly ready: Deferred.Deferred<void, ProviderAdapterError>;
  handshakeFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingDialogs: Map<ApprovalRequestId, PiPendingDialog>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  generation: number;
  activeGeneration: number | undefined;
  generationSawAgent: boolean;
  queuedContinuation: boolean;
  ignoredSettlements: number;
  interruptedTurnIds: Set<TurnId>;
  currentModel: PiModelIdentity | undefined;
  currentThinkingLevel: PiThinkingLevelValue | undefined;
  sessionFile: string | undefined;
  sessionId: string | undefined;
  leafId: string | null;
  extensionCommands: Set<string>;
  stopped: boolean;
  exitEmitted: boolean;
}

export interface PiAdapterLiveOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Internal executable prefix used only by subprocess fixtures. */
  readonly binaryArgs?: ReadonlyArray<string>;
}

function parsePiResumeCursor(raw: unknown): PiResumeCursor | undefined {
  return isPiResumeCursor(raw) ? raw : undefined;
}

function rewriteLeadingSkill(input: string): string {
  return input.replace(/^\$([\p{L}\p{N}_.-]+)(?=\s|$)/u, "/skill:$1");
}

function commandName(input: string): string | undefined {
  const match = input.match(/^\/([^\s]+)/u);
  return match?.[1];
}

function firstAnswer(answers: ProviderUserInputAnswers): string | undefined {
  for (const value of Object.values(answers)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (options: PiAdapterLiveOptions) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const ownerScope = yield* Scope.Scope;
  const makeNativeLoggers = yield* makePiNativeLoggerFactory();
  const sessions = new Map<ThreadId, PiSessionContext>();
  const threadLocks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const stamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
  const offer = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.ignore);

  const adapterError = (
    threadId: ThreadId,
    method: string,
    error: PiRpcError,
  ): ProviderAdapterError =>
    error._tag === "PiRpcProcessError"
      ? new ProviderAdapterProcessError({
          provider: PI_DRIVER_KIND,
          threadId,
          detail: error.detail,
          cause: error,
        })
      : new ProviderAdapterRequestError({
          provider: PI_DRIVER_KIND,
          method,
          detail: "detail" in error ? error.detail : String(error),
          cause: error,
        });
  const normalizeAdapterError = (
    threadId: ThreadId,
    method: string,
    cause: unknown,
  ): ProviderAdapterError => {
    if (isProviderAdapterError(cause)) return cause;
    return new ProviderAdapterRequestError({
      provider: PI_DRIVER_KIND,
      method,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  };

  const getThreadLock = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });
  const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PI_DRIVER_KIND, threadId }),
        );
  };

  const resumeCursor = (context: PiSessionContext): PiResumeCursor | undefined =>
    context.sessionFile && context.sessionId
      ? {
          schemaVersion: PI_RESUME_VERSION,
          sessionFile: context.sessionFile,
          sessionId: context.sessionId,
          leafId: context.leafId,
        }
      : undefined;

  const updateReadySession = Effect.fn("PiAdapter.updateReadySession")(function* (
    context: PiSessionContext,
  ) {
    const { activeTurnId: _activeTurnId, ...session } = context.session;
    context.activeTurnId = undefined;
    context.activeGeneration = undefined;
    context.generationSawAgent = false;
    context.queuedContinuation = false;
    context.session = {
      ...session,
      status: "ready",
      updatedAt: yield* nowIso,
      ...(resumeCursor(context) ? { resumeCursor: resumeCursor(context) } : {}),
    };
  });

  const settleActiveTurn = Effect.fn("PiAdapter.settleActiveTurn")(function* (
    context: PiSessionContext,
    state: "completed" | "failed" | "cancelled",
    errorMessage?: string,
  ) {
    const turnId = context.activeTurnId;
    if (!turnId || context.interruptedTurnIds.has(turnId)) return;
    yield* updateReadySession(context);
    yield* offer({
      type: "turn.completed",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      threadId: context.threadId,
      turnId,
      payload: {
        state,
        stopReason: state === "cancelled" ? "aborted" : null,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });
  });

  const emitUnexpectedExit = Effect.fn("PiAdapter.emitUnexpectedExit")(function* (
    context: PiSessionContext,
    metadata: PiRpcExit,
  ) {
    if (context.stopped || context.exitEmitted || metadata.expected) return;
    context.exitEmitted = true;
    const detail = `Pi RPC process exited unexpectedly${metadata.exitCode === undefined ? "" : ` with code ${metadata.exitCode}`}.`;
    if (context.activeTurnId) yield* settleActiveTurn(context, "failed", detail);
    sessions.delete(context.threadId);
    context.session = {
      ...context.session,
      status: "error",
      updatedAt: yield* nowIso,
      lastError: detail,
    };
    yield* offer({
      type: "runtime.error",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      threadId: context.threadId,
      payload: { message: detail, class: "provider_error" },
    });
    yield* offer({
      type: "session.exited",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      threadId: context.threadId,
      payload: { exitKind: "error", reason: detail, recoverable: true },
    });
    yield* scheduleSessionScopeClose(context);
  });

  const handleEvent = Effect.fn("PiAdapter.handleEvent")(function* (
    context: PiSessionContext,
    event: PiRpcKnownEvent,
  ) {
    if (context.stopped) return;
    switch (event.type) {
      case "agent_start":
        context.generationSawAgent = true;
        return;
      case "queue_update":
        context.queuedContinuation = event.steering.length > 0 || event.followUp.length > 0;
        return;
      case "entry_appended":
        context.leafId = event.entry.id;
        return;
      case "thinking_level_changed":
        context.currentThinkingLevel = event.level;
        return;
      case "session_info_changed":
        return;
      case "extension_error":
        yield* offer({
          type: "runtime.warning",
          ...(yield* stamp()),
          provider: PI_DRIVER_KIND,
          threadId: context.threadId,
          turnId: context.activeTurnId,
          payload: { message: event.error, detail: { extensionPath: event.extensionPath } },
          raw: { source: "pi.rpc", method: event.type, payload: event },
        });
        return;
      case "agent_settled":
        if (context.ignoredSettlements > 0) {
          context.ignoredSettlements -= 1;
          return;
        }
        yield* settleActiveTurn(context, "completed");
        return;
      default:
        return;
    }
  });

  const scheduleSessionScopeClose = (context: PiSessionContext) =>
    Scope.close(context.scope, Exit.void).pipe(
      Effect.ignore,
      Effect.forkIn(ownerScope),
      Effect.asVoid,
    );

  const stopContext = Effect.fn("PiAdapter.stopContext")(function* (
    context: PiSessionContext,
    emitExit = true,
  ) {
    if (context.stopped) return;
    context.stopped = true;
    for (const { request } of context.pendingDialogs.values()) {
      yield* context.rpc
        .sendExtensionUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true })
        .pipe(Effect.ignore);
    }
    context.pendingDialogs.clear();
    yield* context.rpc.close.pipe(Effect.ignore);
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    sessions.delete(context.threadId);
    if (emitExit && !context.exitEmitted) {
      context.exitEmitted = true;
      yield* offer({
        type: "session.exited",
        ...(yield* stamp()),
        provider: PI_DRIVER_KIND,
        threadId: context.threadId,
        payload: { exitKind: "graceful" },
      });
    }
  });

  const applySelection = Effect.fn("PiAdapter.applySelection")(function* (
    context: PiSessionContext,
    modelSelection: Parameters<PiAdapterShape["sendTurn"]>[0]["modelSelection"],
  ) {
    if (!modelSelection) return;
    if (modelSelection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PI_DRIVER_KIND,
        operation: "sendTurn",
        issue: `Model selection belongs to provider instance '${modelSelection.instanceId}'.`,
      });
    }
    const decoded = decodePiModelSlug(modelSelection.model);
    if (Result.isFailure(decoded)) {
      return yield* new ProviderAdapterValidationError({
        provider: PI_DRIVER_KIND,
        operation: "sendTurn",
        issue: decoded.failure.detail,
        cause: decoded.failure,
      });
    }
    const requested = decoded.success;
    if (
      context.currentModel?.provider !== requested.provider ||
      context.currentModel.modelId !== requested.modelId
    ) {
      const selected = yield* context.rpc
        .setModel(requested.provider, requested.modelId)
        .pipe(Effect.mapError((error) => adapterError(context.threadId, "set_model", error)));
      context.currentModel = { provider: selected.provider, modelId: selected.id };
    }

    const rawThinking = getModelSelectionStringOptionValue(
      modelSelection,
      PI_THINKING_LEVEL_OPTION_ID,
    );
    if (rawThinking !== undefined && !isPiThinkingLevel(rawThinking)) {
      return yield* new ProviderAdapterValidationError({
        provider: PI_DRIVER_KIND,
        operation: "sendTurn",
        issue: `Unknown Pi thinking level '${rawThinking}'.`,
      });
    }
    if (rawThinking !== undefined && rawThinking !== context.currentThinkingLevel) {
      const levels = yield* context.rpc.getAvailableThinkingLevels.pipe(
        Effect.mapError((error) =>
          adapterError(context.threadId, "get_available_thinking_levels", error),
        ),
      );
      if (!levels.includes(rawThinking)) {
        return yield* new ProviderAdapterValidationError({
          provider: PI_DRIVER_KIND,
          operation: "sendTurn",
          issue: `Thinking level '${rawThinking}' is not supported by the selected Pi model.`,
        });
      }
      yield* context.rpc
        .setThinkingLevel(rawThinking)
        .pipe(
          Effect.mapError((error) => adapterError(context.threadId, "set_thinking_level", error)),
        );
      const refreshed = yield* context.rpc.getState.pipe(
        Effect.mapError((error) => adapterError(context.threadId, "get_state", error)),
      );
      context.currentThinkingLevel = refreshed.thinkingLevel;
    }
    context.session = {
      ...context.session,
      model: encodePiModelSlug(context.currentModel ?? requested),
      updatedAt: yield* nowIso,
    };
  });

  const startSession: PiAdapterShape["startSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PI_DRIVER_KIND) {
          return yield* new ProviderAdapterValidationError({
            provider: PI_DRIVER_KIND,
            operation: "startSession",
            issue: `Expected provider '${PI_DRIVER_KIND}' but received '${input.provider}'.`,
          });
        }
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== options.instanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PI_DRIVER_KIND,
            operation: "startSession",
            issue: `Expected provider instance '${options.instanceId}' but received '${input.providerInstanceId}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PI_DRIVER_KIND,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PI_DRIVER_KIND,
            operation: "startSession",
            issue: `Model selection belongs to provider instance '${input.modelSelection.instanceId}'.`,
          });
        }

        const cwd = path.resolve(input.cwd.trim());
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopContext(existing);

        const selectedModel = input.modelSelection
          ? decodePiModelSlug(input.modelSelection.model)
          : undefined;
        if (selectedModel && Result.isFailure(selectedModel)) {
          return yield* new ProviderAdapterValidationError({
            provider: PI_DRIVER_KIND,
            operation: "startSession",
            issue: selectedModel.failure.detail,
            cause: selectedModel.failure,
          });
        }
        const requestedModel =
          selectedModel && Result.isSuccess(selectedModel) ? selectedModel.success : undefined;
        const requestedThinking = input.modelSelection
          ? getModelSelectionStringOptionValue(input.modelSelection, PI_THINKING_LEVEL_OPTION_ID)
          : undefined;
        if (requestedThinking !== undefined && !isPiThinkingLevel(requestedThinking)) {
          return yield* new ProviderAdapterValidationError({
            provider: PI_DRIVER_KIND,
            operation: "startSession",
            issue: `Unknown Pi thinking level '${requestedThinking}'.`,
          });
        }
        const cursor = parsePiResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && cursor === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PI_DRIVER_KIND,
            operation: "startSession",
            issue: "The Pi resume cursor is invalid or uses an unsupported version.",
          });
        }

        const pendingDialogs = new Map<ApprovalRequestId, PiPendingDialog>();
        const startupEvents: PiRpcKnownEvent[] = [];
        let registeredContext: PiSessionContext | undefined;
        const sessionScope = yield* Scope.make("sequential");
        const ready = yield* Deferred.make<void, ProviderAdapterError>();
        const contextRegistered = yield* Deferred.make<void>();
        const rpc = yield* makePiRpcRuntime({
          ...makeNativeLoggers({
            nativeEventLogger: options.nativeEventLogger,
            provider: PI_DRIVER_KIND,
            threadId: input.threadId,
          }),
          eventHandler: (record: PiRpcEvent) =>
            (record._tag !== "Known"
              ? Effect.void
              : registeredContext
                ? handleEvent(registeredContext, record.event)
                : Effect.sync(() => {
                    startupEvents.push(record.event);
                  })
            ).pipe(Effect.catchCause(() => Effect.void)),
          extensionUiRequestHandler: (request) =>
            Effect.gen(function* () {
              if (
                request.method !== "select" &&
                request.method !== "confirm" &&
                request.method !== "input" &&
                request.method !== "editor"
              ) {
                return undefined;
              }
              const requestId = ApprovalRequestId.make(request.id);
              pendingDialogs.set(requestId, { request });
              // Acquisition-time handlers can run before makePiRpcRuntime
              // returns. Do not expose the dialog until hasSession can route
              // its response to the registered context.
              yield* Deferred.await(contextRegistered);
              if (request.method === "confirm") {
                yield* offer({
                  type: "request.opened",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  threadId: input.threadId,
                  requestId: RuntimeRequestId.make(request.id),
                  payload: {
                    requestType: "unknown",
                    detail: `${request.title}: ${request.message}`,
                  },
                  raw: { source: "pi.rpc", method: request.type, payload: request },
                });
              } else {
                const options =
                  request.method === "select"
                    ? request.options.map((label) => ({ label, description: label }))
                    : [];
                yield* offer({
                  type: "user-input.requested",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  threadId: input.threadId,
                  requestId: RuntimeRequestId.make(request.id),
                  payload: {
                    questions: [
                      {
                        id: request.id,
                        header: request.title,
                        question:
                          request.method === "input"
                            ? (request.placeholder ?? request.title)
                            : request.method === "editor"
                              ? (request.prefill ?? request.title)
                              : request.title,
                        options,
                      },
                    ],
                  },
                  raw: { source: "pi.rpc", method: request.type, payload: request },
                });
              }
              return undefined;
            }).pipe(
              Effect.catchCause(() =>
                Effect.void.pipe(Effect.as<PiExtensionUiResponse | undefined>(undefined)),
              ),
            ),
          launch: {
            binaryPath: options.settings.binaryPath || "pi",
            ...(options.binaryArgs ? { binaryArgs: options.binaryArgs } : {}),
            launchArgs: options.settings.launchArgs,
            cwd,
            env: options.environment,
            session: cursor
              ? { mode: "resume", sessionFile: cursor.sessionFile }
              : { mode: "persistent" },
            ...(!cursor && requestedModel
              ? { model: { provider: requestedModel.provider, id: requestedModel.modelId } }
              : {}),
            ...(!cursor && requestedThinking ? { thinkingLevel: requestedThinking } : {}),
            ...(!cursor && input.title ? { sessionName: input.title } : {}),
          },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (error) =>
              new ProviderAdapterProcessError({
                provider: PI_DRIVER_KIND,
                threadId: input.threadId,
                detail: error.detail,
                cause: error,
              }),
          ),
        );

        const createdAt = yield* nowIso;
        const initialSession: ProviderSession = {
          provider: PI_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          ...(cursor ? { resumeCursor: cursor } : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const context: PiSessionContext = {
          threadId: input.threadId,
          instanceId: options.instanceId,
          session: initialSession,
          scope: sessionScope,
          rpc,
          ready,
          handshakeFiber: undefined,
          pendingDialogs,
          turns: [],
          activeTurnId: undefined,
          generation: 0,
          activeGeneration: undefined,
          generationSawAgent: false,
          queuedContinuation: false,
          ignoredSettlements: 0,
          interruptedTurnIds: new Set(),
          currentModel: cursor ? undefined : requestedModel,
          currentThinkingLevel: cursor ? undefined : requestedThinking,
          sessionFile: cursor?.sessionFile,
          sessionId: cursor?.sessionId,
          leafId: cursor?.leafId ?? null,
          extensionCommands: new Set(),
          stopped: false,
          exitEmitted: false,
        };
        registeredContext = context;
        sessions.set(input.threadId, context);
        yield* Deferred.succeed(contextRegistered, undefined);
        yield* Effect.forEach(startupEvents, (event) => handleEvent(context, event), {
          discard: true,
        });

        context.handshakeFiber = yield* Effect.gen(function* () {
          const state = yield* rpc.getState.pipe(
            Effect.mapError((error) => adapterError(input.threadId, "get_state", error)),
          );
          context.sessionFile = state.sessionFile;
          context.sessionId = state.sessionId;
          context.currentModel = state.model
            ? { provider: state.model.provider, modelId: state.model.id }
            : context.currentModel;
          context.currentThinkingLevel = state.thinkingLevel;
          yield* rpc
            .setSteeringMode("one-at-a-time")
            .pipe(
              Effect.mapError((error) => adapterError(input.threadId, "set_steering_mode", error)),
            );
          yield* rpc
            .setFollowUpMode("one-at-a-time")
            .pipe(
              Effect.mapError((error) => adapterError(input.threadId, "set_follow_up_mode", error)),
            );
          const commands = yield* rpc.getCommands.pipe(
            Effect.mapError((error) => adapterError(input.threadId, "get_commands", error)),
          );
          context.extensionCommands = new Set(
            commands
              .filter((command) => command.source === "extension")
              .map((command) => command.name),
          );
          if (input.modelSelection) yield* applySelection(context, input.modelSelection);
          const entries = yield* rpc
            .getEntries()
            .pipe(Effect.mapError((error) => adapterError(input.threadId, "get_entries", error)));
          context.leafId = entries.leafId;
          context.session = {
            ...context.session,
            status: "ready",
            ...(context.currentModel ? { model: encodePiModelSlug(context.currentModel) } : {}),
            resumeCursor: resumeCursor(context),
            updatedAt: yield* nowIso,
          };
          yield* offer({
            type: "session.started",
            ...(yield* stamp()),
            provider: PI_DRIVER_KIND,
            threadId: input.threadId,
            payload: { resume: cursor },
          });
          yield* offer({
            type: "session.configured",
            ...(yield* stamp()),
            provider: PI_DRIVER_KIND,
            threadId: input.threadId,
            payload: {
              config: {
                sessionId: state.sessionId,
                sessionFile: state.sessionFile ?? null,
                model: context.session.model ?? null,
                thinkingLevel: context.currentThinkingLevel ?? state.thinkingLevel,
              },
            },
          });
          yield* offer({
            type: "session.state.changed",
            ...(yield* stamp()),
            provider: PI_DRIVER_KIND,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Pi RPC session ready" },
          });
          yield* offer({
            type: "thread.started",
            ...(yield* stamp()),
            provider: PI_DRIVER_KIND,
            threadId: input.threadId,
            payload: { providerThreadId: state.sessionId },
          });
          yield* Deferred.succeed(ready, undefined);
        }).pipe(
          Effect.mapError((error) => normalizeAdapterError(input.threadId, "startup", error)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Deferred.fail(ready, error);
              context.session = {
                ...context.session,
                status: "error",
                updatedAt: yield* nowIso,
                lastError: error.message,
              };
              yield* offer({
                type: "runtime.error",
                ...(yield* stamp()),
                provider: PI_DRIVER_KIND,
                threadId: input.threadId,
                payload: { message: error.message, class: "provider_error" },
              });
              context.stopped = true;
              context.pendingDialogs.clear();
              yield* context.rpc.close.pipe(Effect.ignore);
              sessions.delete(context.threadId);
              if (!context.exitEmitted) {
                context.exitEmitted = true;
                yield* offer({
                  type: "session.exited",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  threadId: input.threadId,
                  payload: { exitKind: "error", reason: error.message, recoverable: true },
                });
              }
              yield* scheduleSessionScopeClose(context);
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Pi RPC startup failure cleanup failed.", { cause }),
          ),
          Effect.forkIn(sessionScope),
        );

        yield* rpc.exit.pipe(
          Effect.flatMap((metadata) => emitUnexpectedExit(context, metadata)),
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(sessionScope),
        );
        return { ...initialSession };
      }),
    ).pipe(
      Effect.mapError((error) => normalizeAdapterError(input.threadId, "startSession", error)),
    );

  const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const observed = yield* requireSession(input.threadId);
      yield* Deferred.await(observed.ready);
      const prepared = yield* withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(input.threadId);
          yield* applySelection(context, input.modelSelection);
          const text = rewriteLeadingSkill(input.input?.trim() ?? "");
          const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.gen(function* () {
              if (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType)) {
                return yield* new ProviderAdapterValidationError({
                  provider: PI_DRIVER_KIND,
                  operation: "sendTurn",
                  issue: `Unsupported image MIME type '${attachment.mimeType}'.`,
                });
              }
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PI_DRIVER_KIND,
                  method: "prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PI_DRIVER_KIND,
                      method: "prompt",
                      detail: `Failed to read image attachment '${attachment.id}'.`,
                      cause,
                    }),
                ),
              );
              if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
                return yield* new ProviderAdapterValidationError({
                  provider: PI_DRIVER_KIND,
                  operation: "sendTurn",
                  issue: `Image attachment '${attachment.id}' exceeds the size limit.`,
                });
              }
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType.toLowerCase(),
              } satisfies PiImageContent;
            }),
          );
          if (!text && images.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PI_DRIVER_KIND,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const continuing = context.activeTurnId !== undefined;
          const turnId = context.activeTurnId ?? TurnId.make(yield* crypto.randomUUIDv4);
          context.generation += 1;
          context.activeGeneration = context.generation;
          context.generationSawAgent = false;
          context.queuedContinuation = continuing;
          context.activeTurnId = turnId;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          if (!continuing) {
            context.turns = [...context.turns, { id: turnId, items: [{ role: "user", text }] }];
            yield* offer({
              type: "turn.started",
              ...(yield* stamp()),
              provider: PI_DRIVER_KIND,
              threadId: input.threadId,
              turnId,
              payload: context.session.model ? { model: context.session.model } : {},
            });
          } else {
            const turn = context.turns.find((candidate) => candidate.id === turnId);
            if (turn) turn.items.push({ role: "user", text, continuation: true });
          }
          const name = commandName(text);
          return {
            context,
            turnId,
            generation: context.generation,
            text,
            images,
            continuing,
            extensionCommand: name !== undefined && context.extensionCommands.has(name),
          };
        }),
      );

      const command = prepared.extensionCommand
        ? prepared.context.rpc.prompt({ message: prepared.text, images: prepared.images })
        : prepared.continuing
          ? input.interactionMode === "plan"
            ? prepared.context.rpc.followUp(prepared.text, prepared.images)
            : prepared.context.rpc.steer(prepared.text, prepared.images)
          : prepared.context.rpc.prompt({ message: prepared.text, images: prepared.images });
      yield* command.pipe(
        Effect.mapError((error) => adapterError(input.threadId, "prompt", error)),
        Effect.tapError((error) => settleActiveTurn(prepared.context, "failed", error.message)),
      );

      const state = yield* prepared.context.rpc.getState.pipe(
        Effect.mapError((error) => adapterError(input.threadId, "get_state", error)),
      );
      if (
        prepared.context.activeGeneration === prepared.generation &&
        !prepared.context.generationSawAgent &&
        !state.isStreaming &&
        state.pendingMessageCount === 0 &&
        !prepared.context.queuedContinuation
      ) {
        yield* settleActiveTurn(prepared.context, "completed");
      }
      const entries = yield* prepared.context.rpc
        .getEntries(prepared.context.leafId ?? undefined)
        .pipe(Effect.mapError((error) => adapterError(input.threadId, "get_entries", error)));
      prepared.context.leafId = entries.leafId;
      prepared.context.sessionFile = state.sessionFile;
      prepared.context.sessionId = state.sessionId;
      prepared.context.session = {
        ...prepared.context.session,
        resumeCursor: resumeCursor(prepared.context),
      };
      return {
        threadId: input.threadId,
        turnId: prepared.turnId,
        ...(resumeCursor(prepared.context) ? { resumeCursor: resumeCursor(prepared.context) } : {}),
      };
    }).pipe(Effect.mapError((error) => normalizeAdapterError(input.threadId, "sendTurn", error)));

  const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const activeTurnId = context.activeTurnId;
        if (!activeTurnId) return;
        if (turnId !== undefined && turnId !== activeTurnId) return;
        const interruptedTurnId = activeTurnId;
        if (context.interruptedTurnIds.has(interruptedTurnId)) return;
        context.interruptedTurnIds.add(interruptedTurnId);
        context.ignoredSettlements += 1;
        yield* context.rpc.abort.pipe(Effect.ignore);
        yield* context.rpc.abortRetry.pipe(Effect.ignore);
        for (const { request } of context.pendingDialogs.values()) {
          yield* context.rpc
            .sendExtensionUiResponse({
              type: "extension_ui_response",
              id: request.id,
              cancelled: true,
            })
            .pipe(Effect.ignore);
        }
        context.pendingDialogs.clear();
        yield* updateReadySession(context);
        yield* offer({
          type: "turn.aborted",
          ...(yield* stamp()),
          provider: PI_DRIVER_KIND,
          threadId,
          turnId: interruptedTurnId,
          payload: { reason: "Interrupted by user" },
        });
      }),
    ).pipe(Effect.mapError((error) => normalizeAdapterError(threadId, "interruptTurn", error)));

  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingDialogs.get(requestId);
      if (!pending || pending.request.method !== "confirm") {
        return yield* new ProviderAdapterRequestError({
          provider: PI_DRIVER_KIND,
          method: "extension_ui_response",
          detail: `Unknown Pi confirmation request '${requestId}'.`,
        });
      }
      const confirmed = decision === "accept" || decision === "acceptForSession";
      yield* context.rpc
        .sendExtensionUiResponse({
          type: "extension_ui_response",
          id: pending.request.id,
          ...(decision === "cancel" ? { cancelled: true } : { confirmed }),
        })
        .pipe(Effect.mapError((error) => adapterError(threadId, "extension_ui_response", error)));
      context.pendingDialogs.delete(requestId);
    });

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingDialogs.get(requestId);
      if (!pending || !["select", "input", "editor"].includes(pending.request.method)) {
        return yield* new ProviderAdapterRequestError({
          provider: PI_DRIVER_KIND,
          method: "extension_ui_response",
          detail: `Unknown Pi user-input request '${requestId}'.`,
        });
      }
      const value = firstAnswer(answers);
      yield* context.rpc
        .sendExtensionUiResponse(
          value === undefined
            ? { type: "extension_ui_response", id: pending.request.id, cancelled: true }
            : { type: "extension_ui_response", id: pending.request.id, value },
        )
        .pipe(Effect.mapError((error) => adapterError(threadId, "extension_ui_response", error)));
      context.pendingDialogs.delete(requestId);
    });

  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    Effect.map(requireSession(threadId), (context) => ({
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    }));

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PI_DRIVER_KIND,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PI_DRIVER_KIND,
        method: "rollbackThread",
        detail: "Pi native rollback is implemented in phase 7.",
      });
    });

  const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (context) yield* stopContext(context);
      }),
    ).pipe(Effect.mapError((error) => normalizeAdapterError(threadId, "stopSession", error)));
  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      Array.from(sessions.values(), (context) => ({
        ...context.session,
        ...(resumeCursor(context) ? { resumeCursor: resumeCursor(context) } : {}),
      })),
    );
  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });
  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), (context) => stopContext(context), {
      discard: true,
    }).pipe(
      Effect.mapError((error) =>
        normalizeAdapterError(contextThreadIdForStopAll(), "stopAll", error),
      ),
    );

  const contextThreadIdForStopAll = (): ThreadId =>
    sessions.keys().next().value ?? ThreadId.make("pi-stop-all");

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.ignore,
      Effect.andThen(PubSub.shutdown(runtimeEvents).pipe(Effect.ignore)),
    ),
  );

  return {
    provider: PI_DRIVER_KIND,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies PiAdapterShape;
});
