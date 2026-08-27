import {
  ApprovalRequestId,
  EventId,
  isProviderSendTurnSupportedImageMimeType,
  PI_DRIVER_KIND,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type CanonicalRequestType,
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
import * as Duration from "effect/Duration";
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
  type PiRpcDiagnostic,
  type PiRpcError,
  type PiRpcEvent,
  type PiRpcExit,
  type PiRpcRuntime,
} from "../pi/PiRpcRuntime.ts";
import { makePiNativeLoggerFactory } from "../pi/PiRpcNativeLogging.ts";
import {
  materializePiPermissionExtension,
  PI_PERMISSION_CWD_ENV,
  PI_PERMISSION_MARKER_ENV,
  PI_PERMISSION_MODE_ENV,
  PI_PERMISSION_OPTIONS,
  PI_PERMISSION_PROTOCOL_ENV,
  PI_PERMISSION_PROTOCOL_VERSION,
  piPermissionGateRequired,
} from "../pi/PiPermissionExtension.ts";
import {
  boundPiRuntimeValue,
  makePiRuntimeTranslationState,
  piSessionStatsUsageSnapshot,
  translatePiRpcEvent,
  type PiRuntimeEventDraft,
  type PiRuntimeTranslationState,
  type PiTerminalOutcome,
} from "../pi/PiRuntimeEvents.ts";

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

interface PiPermissionRequestPayload {
  readonly version: typeof PI_PERMISSION_PROTOCOL_VERSION;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly input: unknown;
  readonly summary: string;
}

const PiPermissionRequestPayload = Schema.Struct({
  version: Schema.Literal(PI_PERMISSION_PROTOCOL_VERSION),
  toolName: Schema.String,
  toolCallId: Schema.String,
  cwd: Schema.String,
  input: Schema.Unknown,
  summary: Schema.String,
});

interface PiPendingDialog {
  readonly request: PiExtensionUiRequest;
  readonly turnId: TurnId | undefined;
  readonly generation: number | undefined;
  readonly permission: PiPermissionRequestPayload | undefined;
  readonly requestType: CanonicalRequestType | undefined;
  timer: Fiber.Fiber<void, never> | undefined;
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
  readonly extensionStatuses: Map<string, string>;
  readonly extensionWidgets: Map<string, string>;
  extensionTitle: string | undefined;
  editorSuggestion: string | undefined;
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
  readonly translation: PiRuntimeTranslationState;
  readonly warnedUnknownEventTypes: Set<string>;
  currentContextWindow: number | undefined;
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

function answerForQuestion(
  answers: ProviderUserInputAnswers,
  questionId: string,
): string | undefined {
  const answer = answers[questionId];
  if (typeof answer === "string") return answer;
  return Array.isArray(answer) && answer.length === 1 && typeof answer[0] === "string"
    ? answer[0]
    : undefined;
}

function permissionRequestType(toolName: string): CanonicalRequestType {
  if (["bash", "shell", "exec", "powershell"].includes(toolName)) {
    return "command_execution_approval";
  }
  if (["write", "edit", "patch", "apply_patch", "apply-patch"].includes(toolName)) {
    return toolName.includes("patch") ? "apply_patch_approval" : "file_change_approval";
  }
  return "dynamic_tool_call";
}

const decodePermissionRequest = Effect.fn("PiAdapter.decodePermissionRequest")(function* (
  request: PiExtensionUiRequest,
  marker: string | undefined,
) {
  if (!marker || request.method !== "select") return undefined;
  if (
    request.options.length !== PI_PERMISSION_OPTIONS.length ||
    !request.options.every((option, index) => option === PI_PERMISSION_OPTIONS[index]) ||
    !request.title.startsWith(`${marker}:`)
  ) {
    return undefined;
  }
  const encoded = request.title.slice(marker.length + 1);
  const jsonString = yield* Effect.try({
    try: () => Buffer.from(encoded, "base64url").toString("utf8"),
    catch: () => undefined,
  });
  if (jsonString === undefined) return undefined;
  const decoded = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(PiPermissionRequestPayload),
    { onExcessProperty: "preserve" },
  )(jsonString).pipe(Effect.result);
  return decoded._tag === "Success" ? decoded.success : undefined;
});

function dialogQuestion(request: PiExtensionUiRequest) {
  switch (request.method) {
    case "select": {
      const header = request.title.trim() || "Pi extension";
      if (request.options.some((label) => !label.trim() || label !== label.trim())) {
        return undefined;
      }
      return {
        id: request.id,
        header,
        question: header,
        options: request.options.map((label) => ({ label, description: label })),
      };
    }
    case "confirm": {
      const header = request.title.trim() || "Pi extension";
      return {
        id: request.id,
        header,
        question: request.message.trim() || header,
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
      };
    }
    case "input": {
      const header = request.title.trim() || "Pi extension";
      return {
        id: request.id,
        header,
        question: request.placeholder?.trim() || header,
        options: [],
      };
    }
    case "editor": {
      const header = request.title.trim() || "Pi extension";
      return {
        id: request.id,
        header,
        question: request.prefill?.trim() ? `${header}\n\n${request.prefill}` : header,
        options: [],
      };
    }
    default:
      return undefined;
  }
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
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
    stopReason?: string | null,
    usage?: unknown,
    raw?: ProviderRuntimeEvent["raw"],
  ) {
    const turnId = context.activeTurnId;
    if (!turnId || context.interruptedTurnIds.has(turnId)) return;
    yield* updateReadySession(context);
    yield* offer({
      type: "turn.completed",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      providerInstanceId: context.instanceId,
      threadId: context.threadId,
      turnId,
      payload: {
        state,
        stopReason: stopReason ?? (state === "cancelled" ? "aborted" : null),
        ...(usage === undefined ? {} : { usage }),
        ...(errorMessage ? { errorMessage } : {}),
      },
      ...(raw ? { raw } : {}),
    });
  });

  const emitUnexpectedExit = Effect.fn("PiAdapter.emitUnexpectedExit")(function* (
    context: PiSessionContext,
    metadata: PiRpcExit,
  ) {
    if (context.stopped || context.exitEmitted || metadata.expected) return;
    context.exitEmitted = true;
    yield* cancelPendingDialogs(context, false);
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
      providerInstanceId: context.instanceId,
      threadId: context.threadId,
      payload: { message: detail, class: "provider_error" },
    });
    yield* offer({
      type: "session.exited",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      providerInstanceId: context.instanceId,
      threadId: context.threadId,
      payload: { exitKind: "error", reason: detail, recoverable: true },
    });
    yield* scheduleSessionScopeClose(context);
  });

  const emitTranslatedEvent = Effect.fn("PiAdapter.emitTranslatedEvent")(function* (
    context: PiSessionContext,
    nativeEvent: PiRpcKnownEvent,
    draft: PiRuntimeEventDraft,
  ) {
    const event = {
      ...draft,
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      providerInstanceId: context.instanceId,
      threadId: context.threadId,
      ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
      raw: {
        source: "pi.rpc" as const,
        method: nativeEvent.type,
        payload: boundPiRuntimeValue(nativeEvent),
      },
    } as ProviderRuntimeEvent;
    yield* offer(event);
  });

  const reconcileSessionStats = (
    context: PiSessionContext,
    generation: number,
    turnId: TurnId | undefined,
  ) =>
    context.rpc.getSessionStats.pipe(
      Effect.flatMap((stats) => {
        if (context.stopped || context.generation !== generation) return Effect.void;
        const usage = piSessionStatsUsageSnapshot(stats);
        if (!usage) return Effect.void;
        return stamp().pipe(
          Effect.flatMap((eventStamp) =>
            offer({
              type: "thread.token-usage.updated",
              ...eventStamp,
              provider: PI_DRIVER_KIND,
              providerInstanceId: context.instanceId,
              threadId: context.threadId,
              ...(turnId ? { turnId } : {}),
              payload: { usage },
              raw: {
                source: "pi.rpc",
                method: "get_session_stats",
                payload: boundPiRuntimeValue(stats),
              },
            }),
          ),
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to reconcile Pi session statistics.", {
          threadId: context.threadId,
          cause,
        }),
      ),
      Effect.forkIn(context.scope),
      Effect.asVoid,
    );

  const settleTranslatedOutcome = Effect.fn("PiAdapter.settleTranslatedOutcome")(function* (
    context: PiSessionContext,
    outcome: PiTerminalOutcome,
  ) {
    if (outcome.warning) {
      yield* offer({
        type: "runtime.warning",
        ...(yield* stamp()),
        provider: PI_DRIVER_KIND,
        providerInstanceId: context.instanceId,
        threadId: context.threadId,
        turnId: context.activeTurnId,
        payload: { message: outcome.warning },
      });
    }
    yield* settleActiveTurn(
      context,
      outcome.state,
      outcome.errorMessage,
      outcome.stopReason,
      outcome.usage,
      { source: "pi.rpc", method: "agent_settled", payload: { type: "agent_settled" } },
    );
  });

  const handleEvent = Effect.fn("PiAdapter.handleEvent")(function* (
    context: PiSessionContext,
    event: PiRpcKnownEvent,
  ) {
    if (context.stopped) return;
    switch (event.type) {
      case "agent_start":
        context.generationSawAgent = true;
        break;
      case "queue_update":
        context.queuedContinuation = event.steering.length > 0 || event.followUp.length > 0;
        break;
      case "entry_appended":
        context.leafId = event.entry.id;
        break;
      case "thinking_level_changed":
        context.currentThinkingLevel = event.level;
        break;
    }

    if (
      event.type === "agent_settled" &&
      context.activeTurnId === undefined &&
      context.ignoredSettlements === 0
    ) {
      return;
    }

    if (
      context.activeTurnId === undefined &&
      context.ignoredSettlements > 0 &&
      event.type !== "agent_settled"
    ) {
      return;
    }

    if (
      context.activeTurnId === undefined &&
      event.type !== "agent_settled" &&
      (event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "turn_start" ||
        event.type === "turn_end" ||
        event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end" ||
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end")
    ) {
      return;
    }

    const generation = context.activeGeneration ?? context.generation;
    const turnId = context.activeTurnId;
    const translated = translatePiRpcEvent(context.translation, event, {
      generation,
      ...(context.currentContextWindow === undefined
        ? {}
        : { contextWindow: context.currentContextWindow }),
    });
    yield* Effect.forEach(
      translated.events,
      (draft) => emitTranslatedEvent(context, event, draft),
      { discard: true },
    );

    if (event.type === "agent_settled") {
      if (context.ignoredSettlements > 0) {
        context.ignoredSettlements -= 1;
        return;
      }
      if (translated.settlement) yield* settleTranslatedOutcome(context, translated.settlement);
    }
    if (translated.reconcileStats) {
      yield* reconcileSessionStats(context, generation, turnId);
    }
  });

  const handleRpcEvent = Effect.fn("PiAdapter.handleRpcEvent")(function* (
    context: PiSessionContext,
    record: PiRpcEvent,
  ) {
    if (record._tag === "Known") {
      yield* handleEvent(context, record.event);
      return;
    }
    if (context.warnedUnknownEventTypes.has(record.type)) return;
    context.warnedUnknownEventTypes.add(record.type);
    yield* offer({
      type: "runtime.warning",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      providerInstanceId: context.instanceId,
      threadId: context.threadId,
      turnId: context.activeTurnId,
      payload: {
        message: `Pi emitted an unsupported RPC event '${record.type}'.`,
        detail: { eventType: record.type },
      },
      raw: { source: "pi.rpc", method: record.type, payload: boundPiRuntimeValue(record.payload) },
    });
  });

  const handleDiagnostic = Effect.fn("PiAdapter.handleDiagnostic")(function* (
    context: PiSessionContext,
    diagnostic: PiRpcDiagnostic,
  ) {
    if (
      diagnostic._tag !== "MalformedJson" &&
      diagnostic._tag !== "MalformedRecord" &&
      diagnostic._tag !== "EmptyRecord"
    ) {
      return;
    }
    yield* offer({
      type: "runtime.warning",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      providerInstanceId: context.instanceId,
      threadId: context.threadId,
      turnId: context.activeTurnId,
      payload: {
        message: "Pi emitted a malformed RPC record.",
        detail: {
          diagnostic: diagnostic._tag,
          ...(diagnostic._tag === "MalformedRecord" && diagnostic.type
            ? { eventType: diagnostic.type }
            : {}),
        },
      },
    });
  });

  const emitDialogResolved = Effect.fn("PiAdapter.emitDialogResolved")(function* (
    context: PiSessionContext,
    requestId: ApprovalRequestId,
    pending: PiPendingDialog,
    resolution: { readonly decision?: string; readonly answers?: ProviderUserInputAnswers },
  ) {
    if (pending.permission && pending.requestType) {
      yield* offer({
        type: "request.resolved",
        ...(yield* stamp()),
        provider: PI_DRIVER_KIND,
        providerInstanceId: context.instanceId,
        threadId: context.threadId,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: {
          requestType: pending.requestType,
          decision: resolution.decision ?? "cancel",
        },
      });
      return;
    }
    yield* offer({
      type: "user-input.resolved",
      ...(yield* stamp()),
      provider: PI_DRIVER_KIND,
      providerInstanceId: context.instanceId,
      threadId: context.threadId,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      requestId: RuntimeRequestId.make(requestId),
      payload: { answers: resolution.answers ?? {} },
    });
  });

  const takePendingDialog = Effect.fn("PiAdapter.takePendingDialog")(function* (
    context: PiSessionContext,
    requestId: ApprovalRequestId,
  ) {
    const pending = context.pendingDialogs.get(requestId);
    if (!pending) return undefined;
    context.pendingDialogs.delete(requestId);
    if (pending.timer) {
      const timer = pending.timer;
      pending.timer = undefined;
      yield* Fiber.interrupt(timer).pipe(Effect.ignore);
    }
    return pending;
  });

  const cancelPendingDialogs = Effect.fn("PiAdapter.cancelPendingDialogs")(function* (
    context: PiSessionContext,
    sendNative: boolean,
  ) {
    for (const requestId of Array.from(context.pendingDialogs.keys())) {
      const pending = yield* takePendingDialog(context, requestId);
      if (!pending) continue;
      if (sendNative) {
        yield* context.rpc
          .sendExtensionUiResponse({
            type: "extension_ui_response",
            id: pending.request.id,
            cancelled: true,
          })
          .pipe(Effect.ignore);
      }
      yield* emitDialogResolved(context, requestId, pending, { decision: "cancel" });
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
    yield* cancelPendingDialogs(context, true);
    yield* context.rpc.close.pipe(Effect.ignore);
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    sessions.delete(context.threadId);
    if (emitExit && !context.exitEmitted) {
      context.exitEmitted = true;
      yield* offer({
        type: "session.exited",
        ...(yield* stamp()),
        provider: PI_DRIVER_KIND,
        providerInstanceId: context.instanceId,
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
      context.currentContextWindow = selected.contextWindow;
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
        const permissionMarker = piPermissionGateRequired(input.runtimeMode)
          ? yield* crypto.randomUUIDv4
          : undefined;
        const permissionExtensionPath = permissionMarker
          ? yield* materializePiPermissionExtension(serverConfig.stateDir).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PI_DRIVER_KIND,
                    threadId: input.threadId,
                    detail: "Failed to materialize the Pi permission extension.",
                    cause,
                  }),
              ),
            )
          : undefined;
        const startupEvents: PiRpcEvent[] = [];
        const startupDiagnostics: PiRpcDiagnostic[] = [];
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
            (registeredContext
              ? handleRpcEvent(registeredContext, record)
              : Effect.sync(() => {
                  startupEvents.push(record);
                })
            ).pipe(Effect.catchCause(() => Effect.void)),
          diagnosticHandler: (diagnostic) =>
            (registeredContext
              ? handleDiagnostic(registeredContext, diagnostic)
              : Effect.sync(() => {
                  startupDiagnostics.push(diagnostic);
                })
            ).pipe(Effect.catchCause(() => Effect.void)),
          extensionUiRequestHandler: (request) =>
            Effect.gen(function* () {
              // Acquisition-time requests can arrive before makePiRpcRuntime returns.
              yield* Deferred.await(contextRegistered);
              const context = registeredContext;
              if (!context || context.stopped) return undefined;

              if (request.method === "notify") {
                yield* offer({
                  type: "runtime.warning",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  providerInstanceId: options.instanceId,
                  threadId: input.threadId,
                  turnId: context.activeTurnId,
                  payload: {
                    message: request.message.slice(0, 4_096) || "Pi extension notification",
                    detail: { severity: request.notifyType ?? "info" },
                  },
                });
                return undefined;
              }
              if (request.method === "setStatus") {
                const key = request.statusKey.slice(0, 128);
                const value = request.statusText?.slice(0, 1_024);
                if (context.extensionStatuses.get(key) === value) return undefined;
                if (value === undefined) context.extensionStatuses.delete(key);
                else {
                  if (!context.extensionStatuses.has(key) && context.extensionStatuses.size >= 32) {
                    const oldest = context.extensionStatuses.keys().next().value;
                    if (oldest !== undefined) context.extensionStatuses.delete(oldest);
                  }
                  context.extensionStatuses.set(key, value);
                }
                return undefined;
              }
              if (request.method === "setWidget") {
                const key = request.widgetKey.slice(0, 128);
                const value = request.widgetLines
                  ?.slice(0, 32)
                  .map((line) => line.slice(0, 512))
                  .join("\n");
                if (context.extensionWidgets.get(key) === value) return undefined;
                if (value === undefined) context.extensionWidgets.delete(key);
                else {
                  if (!context.extensionWidgets.has(key) && context.extensionWidgets.size >= 16) {
                    const oldest = context.extensionWidgets.keys().next().value;
                    if (oldest !== undefined) context.extensionWidgets.delete(oldest);
                  }
                  context.extensionWidgets.set(key, value);
                }
                return undefined;
              }
              if (request.method === "setTitle") {
                context.extensionTitle = request.title.slice(0, 512);
                return undefined;
              }
              if (request.method === "set_editor_text") {
                const suggestion = request.text.slice(0, 4_096);
                if (context.editorSuggestion === suggestion) return undefined;
                context.editorSuggestion = suggestion;
                yield* offer({
                  type: "runtime.warning",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  providerInstanceId: options.instanceId,
                  threadId: input.threadId,
                  payload: {
                    message: "A Pi extension suggested editor text.",
                    detail: { suggestion },
                  },
                });
                return undefined;
              }

              const question = dialogQuestion(request);
              if (!question) {
                yield* offer({
                  type: "runtime.warning",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  providerInstanceId: options.instanceId,
                  threadId: input.threadId,
                  payload: { message: "Pi requested a dialog that T3 could not represent." },
                });
                return {
                  type: "extension_ui_response",
                  id: request.id,
                  cancelled: true,
                } satisfies PiExtensionUiResponse;
              }
              const permission = yield* decodePermissionRequest(request, permissionMarker);
              const requestType = permission
                ? permissionRequestType(permission.toolName)
                : undefined;
              const requestId = ApprovalRequestId.make(request.id);
              const pending: PiPendingDialog = {
                request,
                turnId: context.activeTurnId,
                generation: context.activeGeneration,
                permission,
                requestType,
                timer: undefined,
              };
              pendingDialogs.set(requestId, pending);

              if (permission && requestType) {
                yield* offer({
                  type: "request.opened",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  providerInstanceId: options.instanceId,
                  threadId: input.threadId,
                  ...(pending.turnId ? { turnId: pending.turnId } : {}),
                  requestId: RuntimeRequestId.make(request.id),
                  payload: {
                    requestType,
                    detail: permission.summary.trim() || permission.toolName,
                    args: {
                      toolName: permission.toolName,
                      toolCallId: permission.toolCallId,
                      cwd: permission.cwd,
                      input: permission.input,
                    },
                  },
                });
              } else {
                yield* offer({
                  type: "user-input.requested",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  providerInstanceId: options.instanceId,
                  threadId: input.threadId,
                  ...(pending.turnId ? { turnId: pending.turnId } : {}),
                  requestId: RuntimeRequestId.make(request.id),
                  payload: { questions: [question] },
                  raw: {
                    source: "pi.rpc",
                    method: request.type,
                    payload: boundPiRuntimeValue(request),
                  },
                });
              }

              if ("timeout" in request && request.timeout !== undefined && request.timeout >= 0) {
                pending.timer = yield* Effect.sleep(Duration.millis(request.timeout)).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      pending.timer = undefined;
                      yield* context.rpc.forgetExtensionUiRequest(request.id);
                      const timedOut = yield* takePendingDialog(context, requestId);
                      if (timedOut) {
                        yield* emitDialogResolved(context, requestId, timedOut, {
                          decision: "cancel",
                        });
                      }
                    }),
                  ),
                  Effect.catchCause(() => Effect.void),
                  Effect.forkIn(context.scope),
                );
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
            ...(permissionExtensionPath ? { extensionPaths: [permissionExtensionPath] } : {}),
            cwd,
            env: permissionMarker
              ? {
                  ...options.environment,
                  [PI_PERMISSION_MARKER_ENV]: permissionMarker,
                  [PI_PERMISSION_MODE_ENV]: input.runtimeMode,
                  [PI_PERMISSION_CWD_ENV]: cwd,
                  [PI_PERMISSION_PROTOCOL_ENV]: PI_PERMISSION_PROTOCOL_VERSION,
                }
              : options.environment,
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
          extensionStatuses: new Map(),
          extensionWidgets: new Map(),
          extensionTitle: undefined,
          editorSuggestion: undefined,
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
          translation: makePiRuntimeTranslationState(),
          warnedUnknownEventTypes: new Set(),
          currentContextWindow: undefined,
          stopped: false,
          exitEmitted: false,
        };
        registeredContext = context;
        sessions.set(input.threadId, context);
        yield* Deferred.succeed(contextRegistered, undefined);
        yield* Effect.forEach(startupEvents, (event) => handleRpcEvent(context, event), {
          discard: true,
        });
        yield* Effect.forEach(
          startupDiagnostics,
          (diagnostic) => handleDiagnostic(context, diagnostic),
          { discard: true },
        );

        context.handshakeFiber = yield* Effect.gen(function* () {
          const state = yield* rpc.getState.pipe(
            Effect.mapError((error) => adapterError(input.threadId, "get_state", error)),
          );
          context.sessionFile = state.sessionFile;
          context.sessionId = state.sessionId;
          context.currentModel = state.model
            ? { provider: state.model.provider, modelId: state.model.id }
            : context.currentModel;
          context.currentContextWindow = state.model?.contextWindow;
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
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            payload: { resume: cursor },
          });
          yield* offer({
            type: "session.configured",
            ...(yield* stamp()),
            provider: PI_DRIVER_KIND,
            providerInstanceId: options.instanceId,
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
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Pi RPC session ready" },
          });
          yield* offer({
            type: "thread.started",
            ...(yield* stamp()),
            provider: PI_DRIVER_KIND,
            providerInstanceId: options.instanceId,
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
                providerInstanceId: options.instanceId,
                threadId: input.threadId,
                payload: { message: error.message, class: "provider_error" },
              });
              context.stopped = true;
              yield* cancelPendingDialogs(context, true);
              yield* context.rpc.close.pipe(Effect.ignore);
              sessions.delete(context.threadId);
              if (!context.exitEmitted) {
                context.exitEmitted = true;
                yield* offer({
                  type: "session.exited",
                  ...(yield* stamp()),
                  provider: PI_DRIVER_KIND,
                  providerInstanceId: options.instanceId,
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
              providerInstanceId: context.instanceId,
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
        // The state response is an ordering barrier for abort-side settlement events.
        yield* context.rpc.getState.pipe(Effect.ignore);
        context.ignoredSettlements = 0;
        yield* cancelPendingDialogs(context, true);
        yield* updateReadySession(context);
        yield* offer({
          type: "turn.aborted",
          ...(yield* stamp()),
          provider: PI_DRIVER_KIND,
          providerInstanceId: context.instanceId,
          threadId,
          turnId: interruptedTurnId,
          payload: { reason: "Interrupted by user" },
        });
      }),
    ).pipe(Effect.mapError((error) => normalizeAdapterError(threadId, "interruptTurn", error)));

  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const observed = context.pendingDialogs.get(requestId);
      if (!observed?.permission || observed.request.method !== "select") {
        return yield* new ProviderAdapterRequestError({
          provider: PI_DRIVER_KIND,
          method: "extension_ui_response",
          detail: `Stale pending Pi approval request '${requestId}'.`,
        });
      }
      const pending = yield* takePendingDialog(context, requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PI_DRIVER_KIND,
          method: "extension_ui_response",
          detail: `Stale pending Pi approval request '${requestId}'.`,
        });
      }
      const value =
        decision === "accept"
          ? PI_PERMISSION_OPTIONS[0]
          : decision === "acceptForSession"
            ? PI_PERMISSION_OPTIONS[1]
            : decision === "decline"
              ? PI_PERMISSION_OPTIONS[2]
              : undefined;
      const response: PiExtensionUiResponse = value
        ? { type: "extension_ui_response", id: pending.request.id, value }
        : { type: "extension_ui_response", id: pending.request.id, cancelled: true };
      const sent = yield* context.rpc.sendExtensionUiResponse(response).pipe(Effect.result);
      yield* emitDialogResolved(context, requestId, pending, { decision });
      if (sent._tag === "Failure") {
        return yield* adapterError(threadId, "extension_ui_response", sent.failure);
      }
    }).pipe(Effect.mapError((error) => normalizeAdapterError(threadId, "respondToRequest", error)));

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const observed = context.pendingDialogs.get(requestId);
      if (!observed || observed.permission || !dialogQuestion(observed.request)) {
        return yield* new ProviderAdapterRequestError({
          provider: PI_DRIVER_KIND,
          method: "extension_ui_response",
          detail: `Stale pending Pi user-input request '${requestId}'.`,
        });
      }
      const value = answerForQuestion(answers, observed.request.id);
      if (value && observed.request.method === "confirm" && value !== "Yes" && value !== "No") {
        return yield* new ProviderAdapterValidationError({
          provider: PI_DRIVER_KIND,
          operation: "respondToUserInput",
          issue: `Pi confirmation answer must be 'Yes' or 'No'.`,
        });
      }
      if (
        value &&
        observed.request.method === "select" &&
        !observed.request.options.includes(value)
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PI_DRIVER_KIND,
          operation: "respondToUserInput",
          issue: `Pi selection answer is not one of the requested options.`,
        });
      }
      const pending = yield* takePendingDialog(context, requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PI_DRIVER_KIND,
          method: "extension_ui_response",
          detail: `Stale pending Pi user-input request '${requestId}'.`,
        });
      }
      const response: PiExtensionUiResponse =
        value === undefined || value.length === 0
          ? { type: "extension_ui_response", id: pending.request.id, cancelled: true }
          : pending.request.method === "confirm"
            ? {
                type: "extension_ui_response",
                id: pending.request.id,
                confirmed: value === "Yes",
              }
            : { type: "extension_ui_response", id: pending.request.id, value };
      const sent = yield* context.rpc.sendExtensionUiResponse(response).pipe(Effect.result);
      yield* emitDialogResolved(context, requestId, pending, {
        answers: value === undefined ? {} : { [pending.request.id]: value },
      });
      if (sent._tag === "Failure") {
        return yield* adapterError(threadId, "extension_ui_response", sent.failure);
      }
    }).pipe(
      Effect.mapError((error) => normalizeAdapterError(threadId, "respondToUserInput", error)),
    );

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
