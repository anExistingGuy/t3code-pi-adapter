import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  TextGenerationError,
  type PiSettings,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { decodePiModelSlug, PI_THINKING_LEVEL_OPTION_ID } from "../provider/pi/PiModelCatalog.ts";
import {
  PiAssistantMessage,
  PiThinkingLevel,
  type PiExtensionUiRequest,
  type PiExtensionUiResponse,
  type PiImageContent,
} from "../provider/pi/PiRpcProtocol.ts";
import { makePiRpcRuntime, type PiRpcEvent } from "../provider/pi/PiRpcRuntime.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TEXT_GENERATION_TIMEOUT_MS = 180_000;
const MAX_STREAMED_DIAGNOSTIC_CHARS = 4_096;

const isPiThinkingLevel = Schema.is(PiThinkingLevel);
const isPiAssistantMessage = Schema.is(PiAssistantMessage);
const isTextGenerationError = Schema.is(TextGenerationError);

type PiTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export interface PiTextGenerationOptions {
  /** Internal executable prefix used by subprocess fixtures. */
  readonly binaryArgs?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  /** Internal test receipt emitted after the RPC process answers its first state request. */
  readonly onRuntimeReady?: () => Effect.Effect<void, never>;
}

function handleUtilityUiRequest(
  request: PiExtensionUiRequest,
): Effect.Effect<PiExtensionUiResponse | undefined> {
  return Effect.succeed(
    ["select", "confirm", "input", "editor"].includes(request.method)
      ? { type: "extension_ui_response", id: request.id, cancelled: true }
      : undefined,
  );
}

function normalizePiTextGenerationError(
  operation: PiTextGenerationOperation,
  cause: unknown,
): TextGenerationError {
  return isTextGenerationError(cause)
    ? cause
    : new TextGenerationError({
        operation,
        detail: "Pi RPC text generation request failed.",
        cause,
      });
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly options?: PiTextGenerationOptions;
}) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const materializeImageAttachments = Effect.fn("PiTextGeneration.materializeImageAttachments")(
    function* (
      operation: PiTextGenerationOperation,
      attachments: TextGeneration.BranchNameGenerationInput["attachments"],
    ) {
      const images: PiImageContent[] = [];
      for (const attachment of attachments ?? []) {
        if (attachment.type !== "image") continue;
        if (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType)) {
          return yield* new TextGenerationError({
            operation,
            detail: `Unsupported image MIME type '${attachment.mimeType}'.`,
          });
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath || !path.isAbsolute(attachmentPath)) {
          return yield* new TextGenerationError({
            operation,
            detail: `Image attachment '${attachment.id}' is unavailable.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to read image attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          return yield* new TextGenerationError({
            operation,
            detail: `Image attachment '${attachment.id}' exceeds the size limit.`,
          });
        }
        images.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType.toLowerCase(),
        });
      }
      return images;
    },
  );

  const runPiJson = Effect.fn("PiTextGeneration.runPiJson")(function* <S extends Schema.Top>(args: {
    readonly operation: PiTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: TextGeneration.BranchNameGenerationInput["modelSelection"];
    readonly attachments?: TextGeneration.BranchNameGenerationInput["attachments"];
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    if (args.modelSelection.instanceId !== input.instanceId) {
      return yield* new TextGenerationError({
        operation: args.operation,
        detail: `Model selection belongs to provider instance '${args.modelSelection.instanceId}', not '${input.instanceId}'.`,
      });
    }
    const decodedModel = decodePiModelSlug(args.modelSelection.model);
    if (Result.isFailure(decodedModel)) {
      return yield* new TextGenerationError({
        operation: args.operation,
        detail: decodedModel.failure.detail,
        cause: decodedModel.failure,
      });
    }
    const selectedModel = decodedModel.success;
    const selectedThinking = getModelSelectionStringOptionValue(
      args.modelSelection,
      PI_THINKING_LEVEL_OPTION_ID,
    );
    if (selectedThinking !== undefined && !isPiThinkingLevel(selectedThinking)) {
      return yield* new TextGenerationError({
        operation: args.operation,
        detail: `Unknown Pi thinking level '${selectedThinking}'.`,
      });
    }
    const images = yield* materializeImageAttachments(args.operation, args.attachments);

    const request = Effect.gen(function* () {
      const settled = yield* Deferred.make<void, TextGenerationError>();
      const assistantFailure = yield* Ref.make<"error" | "aborted" | undefined>(undefined);
      const streamedChars = yield* Ref.make(0);
      const eventHandler = (record: PiRpcEvent) => {
        if (record._tag !== "Known") return Effect.void;
        const event = record.event;
        if (event.type === "agent_settled")
          return Deferred.succeed(settled, undefined).pipe(Effect.asVoid);
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") {
            return Ref.update(streamedChars, (current) =>
              Math.min(MAX_STREAMED_DIAGNOSTIC_CHARS, current + update.delta.length),
            );
          }
          if (update.type === "error") return Ref.set(assistantFailure, update.reason);
        }
        if (
          event.type === "message_end" &&
          isPiAssistantMessage(event.message) &&
          (event.message.stopReason === "error" || event.message.stopReason === "aborted")
        ) {
          return Ref.set(assistantFailure, event.message.stopReason);
        }
        return Effect.void;
      };

      const runtimeScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
      const runtime = yield* makePiRpcRuntime({
        launch: {
          binaryPath: input.settings.binaryPath || "pi",
          ...(input.options?.binaryArgs ? { binaryArgs: input.options.binaryArgs } : {}),
          launchArgs: input.settings.launchArgs,
          cwd: args.cwd,
          env: input.environment,
          session: { mode: "ephemeral" },
          model: { provider: selectedModel.provider, id: selectedModel.modelId },
          ...(selectedThinking === undefined ? {} : { thinkingLevel: selectedThinking }),
          disableTools: true,
        },
        eventHandler,
        extensionUiRequestHandler: handleUtilityUiRequest,
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Scope.Scope, runtimeScope),
      );

      const requestTimeoutMs = input.options?.timeoutMs ?? PI_TEXT_GENERATION_TIMEOUT_MS;
      const withRequestTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.timeoutOption(requestTimeoutMs),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: args.operation,
                    detail: "Pi RPC text generation request timed out.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

      yield* runtime.exit.pipe(
        Effect.flatMap((metadata) =>
          Deferred.fail(
            settled,
            new TextGenerationError({
              operation: args.operation,
              detail: `Pi RPC process exited before generation settled${metadata.exitCode === undefined ? "" : ` (code ${metadata.exitCode})`}.`,
            }),
          ),
        ),
        Effect.forkScoped,
      );

      yield* withRequestTimeout(runtime.getState);
      if (input.options?.onRuntimeReady) yield* input.options.onRuntimeReady();
      const appliedModel = yield* withRequestTimeout(
        runtime.setModel(selectedModel.provider, selectedModel.modelId),
      );
      if (
        appliedModel.provider !== selectedModel.provider ||
        appliedModel.id !== selectedModel.modelId
      ) {
        return yield* new TextGenerationError({
          operation: args.operation,
          detail: "Pi did not apply the exact requested provider and model.",
        });
      }
      if (selectedThinking !== undefined) {
        const levels = yield* withRequestTimeout(runtime.getAvailableThinkingLevels);
        if (!levels.includes(selectedThinking)) {
          return yield* new TextGenerationError({
            operation: args.operation,
            detail: `Thinking level '${selectedThinking}' is not supported by the selected Pi model.`,
          });
        }
        yield* withRequestTimeout(runtime.setThinkingLevel(selectedThinking));
        const state = yield* withRequestTimeout(runtime.getState);
        if (state.thinkingLevel !== selectedThinking) {
          return yield* new TextGenerationError({
            operation: args.operation,
            detail: `Pi did not apply thinking level '${selectedThinking}'.`,
          });
        }
      }

      yield* withRequestTimeout(
        runtime.prompt({
          message: args.prompt,
          ...(images.length > 0 ? { images } : {}),
        }),
      );
      yield* Deferred.await(settled).pipe(
        Effect.timeoutOption(requestTimeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              runtime.close.pipe(
                Effect.andThen(
                  Effect.fail(
                    new TextGenerationError({
                      operation: args.operation,
                      detail: "Pi RPC text generation request timed out.",
                    }),
                  ),
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      const failure = yield* Ref.get(assistantFailure);
      if (failure !== undefined) {
        return yield* new TextGenerationError({
          operation: args.operation,
          detail:
            failure === "aborted"
              ? "Pi text generation was aborted."
              : "Pi assistant generation failed.",
        });
      }
      const rawOutput = (yield* withRequestTimeout(runtime.getLastAssistantText))?.trim() ?? "";
      if (!rawOutput) {
        const observedChars = yield* Ref.get(streamedChars);
        return yield* new TextGenerationError({
          operation: args.operation,
          detail: `Pi returned no assistant text (observed ${observedChars} streamed characters).`,
        });
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(args.outputSchema))(
        extractJsonObject(rawOutput),
      ).pipe(
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation: args.operation,
              detail: "Pi returned invalid structured output.",
            }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) => normalizePiTextGenerationError(args.operation, cause)),
    );
    return yield* request;
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (request) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: request.branch,
        stagedSummary: request.stagedSummary,
        stagedPatch: request.stagedPatch,
        includeBranch: request.includeBranch === true,
        policy: request.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (request) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: request.baseBranch,
        headBranch: request.headBranch,
        commitSummary: request.commitSummary,
        diffSummary: request.diffSummary,
        diffPatch: request.diffPatch,
        changeRequestTemplate: request.changeRequestTemplate,
        policy: request.policy,
      });
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (request) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: request.message,
        attachments: request.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
        attachments: request.attachments,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (request) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: request.message,
        previousTitle: request.previousTitle,
        attachments: request.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: request.cwd,
        prompt,
        outputSchema,
        modelSelection: request.modelSelection,
        attachments: request.attachments,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
